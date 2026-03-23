/**
 * SI-CERT Ingestion Crawler
 *
 * Scrapes the SI-CERT website (cert.si) and populates the SQLite database
 * with real guidance documents, security advisories, and frameworks from
 * Slovenia's national CSIRT.
 *
 * Data sources:
 *   1. Varnostna obvestila (Security advisories) — paginated WordPress category
 *      https://www.cert.si/category/varnostna-obvestila/ (20 pages, ~8 per page)
 *      Detail pages: https://www.cert.si/si-cert-YYYY-NN/
 *      Sections: Povzetek, Opis, Ranljive verzije, Priporočeni ukrepi, CVE oznaka, Viri
 *
 *   2. Novice (News/guidance)    — paginated WordPress category
 *      https://www.cert.si/category/novice/ (29 pages, ~9 per page)
 *      Detail pages: https://www.cert.si/{post-slug}/
 *
 *   3. Letna poročila (Annual reports) — custom post type
 *      https://www.cert.si/letna_porocila/
 *
 * Content language: Slovenian (original)
 *
 * Usage:
 *   npx tsx scripts/ingest-si-cert.ts                   # full crawl
 *   npx tsx scripts/ingest-si-cert.ts --resume          # resume from last checkpoint
 *   npx tsx scripts/ingest-si-cert.ts --dry-run         # log what would be inserted
 *   npx tsx scripts/ingest-si-cert.ts --force           # drop and recreate DB first
 *   npx tsx scripts/ingest-si-cert.ts --advisories-only # only crawl advisories
 *   npx tsx scripts/ingest-si-cert.ts --guidance-only   # only crawl guidance/news
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["SICERT_DB_PATH"] ?? "data/si-cert.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const BASE_URL = "https://www.cert.si";

const ADVISORIES_LISTING = `${BASE_URL}/category/varnostna-obvestila/`;
const NEWS_LISTING = `${BASE_URL}/category/novice/`;

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "AnsvarSICERTCrawler/1.0 (+https://ansvar.eu; compliance research)";

// CLI flags
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const advisoriesOnly = args.includes("--advisories-only");
const guidanceOnly = args.includes("--guidance-only");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GuidanceRow {
  reference: string;
  title: string;
  title_en: string | null;
  date: string | null;
  type: string;
  series: string;
  summary: string;
  full_text: string;
  topics: string;
  status: string;
}

interface AdvisoryRow {
  reference: string;
  title: string;
  date: string | null;
  severity: string | null;
  affected_products: string | null;
  summary: string;
  full_text: string;
  cve_references: string | null;
}

interface FrameworkRow {
  id: string;
  name: string;
  name_en: string | null;
  description: string;
  document_count: number;
}

interface Progress {
  completed_advisory_urls: string[];
  completed_news_urls: string[];
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const counters = {
  advisories_inserted: 0,
  advisories_skipped: 0,
  guidance_inserted: 0,
  guidance_skipped: 0,
  pages_fetched: 0,
  errors: 0,
};

// ---------------------------------------------------------------------------
// Utility: rate-limited fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rateLimitedFetch(
  url: string,
  opts?: RequestInit,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "sl-SI,sl;q=0.9,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...opts,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }
      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `  [retry ${attempt}/${MAX_RETRIES}] ${url}: ${lastError.message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError!;
}

async function fetchText(url: string): Promise<string> {
  const resp = await rateLimitedFetch(url);
  counters.pages_fetched++;
  return resp.text();
}

// ---------------------------------------------------------------------------
// Slovenian date parsing
// ---------------------------------------------------------------------------

/**
 * Slovenian month names to numeric month (01-12).
 */
const SL_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  marec: "03",
  april: "04",
  maj: "05",
  junij: "06",
  julij: "07",
  avgust: "08",
  september: "09",
  oktober: "10",
  november: "11",
  december: "12",
  // Abbreviated
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  jun: "06",
  jul: "07",
  avg: "08",
  sep: "09",
  okt: "10",
  nov: "11",
  dec: "12",
};

/**
 * Parse a Slovenian date string into ISO format (YYYY-MM-DD).
 * Handles formats like:
 *   "25. februar 2026"
 *   "7. 3. 2025"
 *   "22. 9. 2024"
 *   "1. 10. 1998"
 */
function parseSlovenianDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const s = dateStr.trim();

  // "7. 3. 2025" or "22. 9. 2024" — numeric day. month. year
  const numericMatch = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (numericMatch) {
    const day = numericMatch[1]!.padStart(2, "0");
    const month = numericMatch[2]!.padStart(2, "0");
    const year = numericMatch[3]!;
    return `${year}-${month}-${day}`;
  }

  // "25. februar 2026" — day. monthName year
  const longMatch = s.match(/^(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
  if (longMatch) {
    const day = longMatch[1]!.padStart(2, "0");
    const monthName = longMatch[2]!.toLowerCase();
    const year = longMatch[3]!;
    const month = SL_MONTHS[monthName];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // Fallback: try JavaScript Date parsing (for RFC 2822 / ISO strings)
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch {
    // Ignore
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract CVE references from text. Returns JSON array string or null.
 */
function extractCves(text: string): string | null {
  const cves = new Set<string>();
  const re = /CVE-\d{4}-\d{4,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    cves.add(m[0]);
  }
  return cves.size > 0 ? JSON.stringify(Array.from(cves).sort()) : null;
}

/**
 * Infer severity from page text by looking for CVSS scores and Slovenian keywords.
 * Returns: "critical", "high", "medium", "low", or null.
 */
function inferSeverity(text: string): string | null {
  // Check for CVSS score — cert.si uses comma as decimal separator (9,8 not 9.8)
  const cvssMatch = text.match(
    /CVSS[:\s]+(\d+(?:[.,]\d+)?)/i,
  );
  if (cvssMatch) {
    const score = parseFloat(cvssMatch[1]!.replace(",", "."));
    if (score >= 9.0) return "critical";
    if (score >= 7.0) return "high";
    if (score >= 4.0) return "medium";
    return "low";
  }

  // Also look for "CVSS oceno X,Y" pattern used on cert.si
  const cvssAltMatch = text.match(
    /CVSS\s+ocen[oa]\s+(\d+(?:[.,]\d+)?)/i,
  );
  if (cvssAltMatch) {
    const score = parseFloat(cvssAltMatch[1]!.replace(",", "."));
    if (score >= 9.0) return "critical";
    if (score >= 7.0) return "high";
    if (score >= 4.0) return "medium";
    return "low";
  }

  // Check for Slovenian severity keywords
  const lower = text.toLowerCase();
  if (
    lower.includes("kritičn") ||
    lower.includes("kriticn") ||
    lower.includes("remote code execution") ||
    lower.includes("oddaljeno izvajanje kode")
  ) {
    return "critical";
  }
  if (
    lower.includes("visoka resnost") ||
    lower.includes("zelo resn") ||
    lower.includes("nujno") ||
    lower.includes("dringend")
  ) {
    return "high";
  }
  if (
    lower.includes("srednja resnost") ||
    lower.includes("zmerna") ||
    lower.includes("moderate")
  ) {
    return "medium";
  }

  return null;
}

/**
 * Extract affected products from advisory text and structured sections.
 * Returns JSON array string or null.
 */
function extractAffectedProducts(
  sections: Record<string, string>,
  fullText: string,
): string | null {
  // Look for "Ranljive verzije" or "Ranljivost vpliva na" sections
  const productsSection =
    sections["Ranljive verzije"] ??
    sections["Prizadeti produkti"] ??
    sections["Ranljivost vpliva na naslednje vrste namestitev"] ??
    null;

  if (productsSection) {
    // Split by newlines and filter meaningful lines
    const products = productsSection
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 2 && l.length < 200);
    if (products.length > 0) {
      return JSON.stringify(products.slice(0, 20));
    }
  }

  // Fallback: look for product names in the full text near keywords
  const productPatterns = [
    /(?:prizadeti produkti|ranljive verzije|vpliva na)[:\s]+([^\n.]+)/gi,
  ];
  const products: string[] = [];
  for (const pattern of productPatterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(fullText)) !== null) {
      const product = m[1]!.trim();
      if (product.length > 2 && product.length < 200) {
        products.push(product);
      }
    }
  }

  return products.length > 0 ? JSON.stringify(products) : null;
}

/**
 * Extract topics from a page as JSON array string.
 * Uses Slovenian keywords relevant to cybersecurity.
 */
function extractTopics(title: string, text: string): string {
  const topics: string[] = [];
  const lower = (title + " " + text).toLowerCase();

  const topicMap: Record<string, string> = {
    // Slovenian cybersecurity terms
    "izsiljevalsk": "izsiljevalska programska oprema",
    ransomware: "izsiljevalska programska oprema",
    phishing: "phishing",
    "lažna sporočila": "phishing",
    vpn: "VPN",
    "požarni zid": "požarni zid",
    firewall: "požarni zid",
    "oddaljeno izvajanje kode": "RCE",
    "remote code execution": "RCE",
    "zavrnitev storitve": "DoS",
    "denial of service": "DoS",
    "nis2": "NIS2",
    "nis-direktiv": "NIS2",
    "zvkses": "ZVKSES",
    "kritična infrastruktura": "kritična infrastruktura",
    "kriticna infrastruktura": "kritična infrastruktura",
    "dobavna veriga": "dobavna veriga",
    "supply chain": "dobavna veriga",
    "avtentikacija": "avtentikacija",
    "zero-day": "zero-day",
    "0-day": "zero-day",
    "ničelni dan": "zero-day",
    "zlonamern": "zlonamerna programska oprema",
    malware: "zlonamerna programska oprema",
    "ranljivost": "ranljivost",
    "varnostne kopije": "varnostne kopije",
    backup: "varnostne kopije",
    "odzivanje na incidente": "odzivanje na incidente",
    "incident response": "odzivanje na incidente",
    "gdpr": "GDPR",
    "osebni podatki": "GDPR",
    "oblačn": "oblačna varnost",
    cloud: "oblačna varnost",
    // Product names (keep English)
    cisco: "Cisco",
    microsoft: "Microsoft",
    fortinet: "Fortinet",
    ivanti: "Ivanti",
    oracle: "Oracle",
    apache: "Apache",
    linux: "Linux",
    windows: "Windows",
    android: "Android",
    apple: "Apple",
    vmware: "VMware",
    "palo alto": "Palo Alto",
    "check point": "Check Point",
    geoserver: "GeoServer",
    citrix: "Citrix",
    netscaler: "NetScaler",
  };

  for (const [keyword, topic] of Object.entries(topicMap)) {
    if (lower.includes(keyword) && !topics.includes(topic)) {
      topics.push(topic);
    }
  }

  // Cap at 8 topics
  return JSON.stringify(topics.slice(0, 8));
}

/**
 * Build a reference ID from a cert.si URL.
 *
 * Advisory pages follow a clear pattern: /si-cert-YYYY-NN/ -> SI-CERT-YYYY-NN
 * News/guidance pages use slugs: /some-slug/ -> SI-CERT-N-some-slug
 */
function buildReference(url: string, type: "A" | "N"): string {
  const path = url.replace(BASE_URL, "").replace(/^\/+/, "").replace(/\/+$/, "");

  if (type === "A") {
    // Advisory: try to extract SI-CERT-YYYY-NN pattern from URL
    const advisoryMatch = path.match(/si-cert-(\d{2,4})-(\d+)/i);
    if (advisoryMatch) {
      const year = advisoryMatch[1]!;
      const num = advisoryMatch[2]!.padStart(2, "0");
      // Handle 2-digit years (98, 99 -> 1998, 1999)
      const fullYear = year.length === 2
        ? (parseInt(year, 10) >= 90 ? `19${year}` : `20${year}`)
        : year;
      return `SI-CERT-${fullYear}-${num}`;
    }
    // Fallback for non-standard advisory URLs
    return `SI-CERT-A-${path.slice(0, 70)}`;
  }

  // News/guidance: use slug as reference
  const slug = path.slice(0, 70);
  return `SI-CERT-N-${slug}`;
}

// ---------------------------------------------------------------------------
// Detail page scraper
// ---------------------------------------------------------------------------

interface DetailPage {
  title: string;
  date: string | null;
  category: string | null;
  sections: Record<string, string>;
  fullText: string;
}

/**
 * Scrape a single cert.si detail page (advisory or news).
 *
 * cert.si is a WordPress site with a custom "cert" theme.
 * Advisory pages have structured sections: Povzetek, Opis, Ranljive verzije,
 * Priporočeni ukrepi, CVE oznaka, Viri.
 * News pages have less structured content with h2/h3 headings.
 */
async function scrapeDetailPage(url: string): Promise<DetailPage> {
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  // Title: first h1, or the <title> tag
  const title =
    $("article h1, .entry-title, main h1, h1").first().text().trim() ||
    $("title").text().replace(/\s*[-–|].*SI\s*CERT.*$/i, "").trim();

  // Date: cert.si shows dates as "25. februar 2026" or "7. 3. 2025"
  let dateStr: string | null = null;

  // Strategy 1: look for structured date elements
  $("time, .date, .entry-date, .posted-on, .published").each((_i, el) => {
    if (dateStr) return;
    const datetime = $(el).attr("datetime");
    if (datetime) {
      dateStr = parseSlovenianDate(datetime);
      return;
    }
    const text = $(el).text().trim();
    const parsed = parseSlovenianDate(text);
    if (parsed) {
      dateStr = parsed;
    }
  });

  // Strategy 2: look for Slovenian date patterns in breadcrumbs and metadata
  if (!dateStr) {
    const metaText = $("header, .breadcrumb, .post-meta, .entry-meta").text();
    const dateMatch = metaText.match(
      /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/,
    );
    if (dateMatch) {
      dateStr = parseSlovenianDate(dateMatch[0]);
    }
  }

  // Strategy 3: scan the first few elements for date patterns
  if (!dateStr) {
    const headerText = $("article, main, .entry-content").first().text().slice(0, 1000);
    // "25. februar 2026"
    const longDateMatch = headerText.match(
      /(\d{1,2})\.\s*(januar|februar|marec|april|maj|junij|julij|avgust|september|oktober|november|december)\s+(\d{4})/i,
    );
    if (longDateMatch) {
      dateStr = parseSlovenianDate(longDateMatch[0]);
    }
    // "7. 3. 2025"
    if (!dateStr) {
      const shortDateMatch = headerText.match(
        /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/,
      );
      if (shortDateMatch) {
        dateStr = parseSlovenianDate(shortDateMatch[0]);
      }
    }
  }

  // Category: extract from breadcrumbs or category labels
  let category: string | null = null;
  $("a[href*='/category/']").each((_i, el) => {
    if (category) return;
    const text = $(el).text().trim();
    if (text && text !== "Naslovnica") {
      category = text;
    }
  });

  // Extract sections by h2 headings
  const sections: Record<string, string> = {};
  const contentArea = $(
    "article .entry-content, .entry-content, article, main, .content",
  ).first();
  const h2Elements = contentArea.find("h2");

  if (h2Elements.length > 0) {
    h2Elements.each((_i, el) => {
      const heading = $(el).text().trim();
      if (!heading) return;
      // Collect all sibling content until next h2
      let sectionContent = "";
      let next = $(el).next();
      while (next.length > 0 && !next.is("h2")) {
        sectionContent += next.text().trim() + "\n";
        next = next.next();
      }
      sections[heading] = sectionContent.trim();
    });
  }

  // Full text: all text from the content area, cleaned
  const fullText = contentArea
    .text()
    .replace(/\s+/g, " ")
    .trim();

  return { title, date: dateStr, category, sections, fullText };
}

// ---------------------------------------------------------------------------
// Listing page scraper
// ---------------------------------------------------------------------------

interface ListingEntry {
  url: string;
  title: string;
  dateBrief: string;
}

/**
 * Scrape a cert.si WordPress category listing page.
 *
 * cert.si listing pages show articles with:
 *   - Category label (e.g. "Varnostna obvestila") and date above
 *   - Clickable h2 title linking to the detail page
 *   - Short excerpt text
 *   - "Več" (More) link
 *
 * Pagination: numbered links at the bottom, format /category/slug/page/N/
 */
async function scrapeListingPage(
  pageUrl: string,
): Promise<{ entries: ListingEntry[]; nextPageUrl: string | null }> {
  const html = await fetchText(pageUrl);
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];
  const seen = new Set<string>();

  // Find all links to detail pages within the main content area
  // Exclude navigation, footer, sidebar links
  const mainContent = $("main, .site-content, article, .content, body").first();

  // Strategy 1: find h2 > a links (primary article title links)
  mainContent.find("h2 a[href], a h2").each((_i, el) => {
    const $el = $(el);
    // If the structure is <a><h2>...</h2></a>, get the <a> parent
    const $link = $el.is("a") ? $el : $el.closest("a");
    const href = $link.attr("href");
    if (!href) return;

    const fullHref = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    // Skip category/tag/page links
    if (
      fullHref.includes("/category/") ||
      fullHref.includes("/tag/") ||
      fullHref.includes("/page/") ||
      seen.has(fullHref)
    ) {
      return;
    }

    seen.add(fullHref);

    // Get title from the h2 text
    const title = $el.is("a")
      ? $el.text().trim()
      : $el.find("h2").text().trim() || $el.text().trim();

    if (title.length < 3) return;

    // Look for a date near this entry
    const parent = $link.closest("div, article, section, li");
    const parentText = parent.text();
    const dateMatch = parentText.match(
      /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/,
    );
    const dateBrief = dateMatch ? dateMatch[0] : "";

    entries.push({ url: fullHref, title, dateBrief });
  });

  // Strategy 2: find "Več" (More) links that might lead to articles we missed
  mainContent.find("a").each((_i, el) => {
    const text = $(el).text().trim();
    if (text !== "Več" && text !== "Preberi več") return;

    const href = $(el).attr("href");
    if (!href) return;

    const fullHref = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    if (
      fullHref.includes("/category/") ||
      fullHref.includes("/tag/") ||
      fullHref.includes("/page/") ||
      seen.has(fullHref)
    ) {
      return;
    }

    seen.add(fullHref);
    entries.push({ url: fullHref, title: "", dateBrief: "" });
  });

  // Find next page URL from pagination
  let nextPageUrl: string | null = null;

  // cert.si pagination: numbered links + "Naslednja stran" (next page) arrow
  // Look for a "next" link: "›", "»", or "Naslednja stran"
  $("a").each((_i, el) => {
    if (nextPageUrl) return;
    const text = $(el).text().trim();
    if (
      text === "\u203A" ||
      text === "\u00BB" ||
      text === "›" ||
      text === "»" ||
      text.toLowerCase().includes("naslednja")
    ) {
      const href = $(el).attr("href");
      if (href && href.includes("/page/")) {
        nextPageUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    }
  });

  // Fallback: compute next page number from current URL
  if (!nextPageUrl) {
    const currentPageMatch = pageUrl.match(/\/page\/(\d+)/);
    const currentPage = currentPageMatch
      ? parseInt(currentPageMatch[1]!, 10)
      : 1;
    const nextPage = currentPage + 1;

    $("a[href]").each((_i, el) => {
      if (nextPageUrl) return;
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().trim();
      if (text === String(nextPage) && href.includes("/page/")) {
        nextPageUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    });
  }

  return { entries, nextPageUrl };
}

/**
 * Crawl all pages of a listing, collecting all entry URLs.
 */
async function crawlAllListingPages(
  startUrl: string,
  label: string,
): Promise<ListingEntry[]> {
  const allEntries: ListingEntry[] = [];
  let currentUrl: string | null = startUrl;
  let pageNum = 1;

  while (currentUrl) {
    console.log(`  [${label}] Fetching page ${pageNum}: ${currentUrl}`);
    try {
      const { entries, nextPageUrl } = await scrapeListingPage(currentUrl);
      allEntries.push(...entries);
      console.log(
        `  [${label}] Page ${pageNum}: ${entries.length} entries found`,
      );
      currentUrl = nextPageUrl;
      pageNum++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${label}] Error on page ${pageNum}: ${msg}`);
      counters.errors++;
      break;
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = allEntries.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  console.log(
    `  [${label}] Total: ${unique.length} unique entries across ${pageNum - 1} pages`,
  );
  return unique;
}

// ---------------------------------------------------------------------------
// Advisory processing (Varnostna obvestila -> advisories table)
// ---------------------------------------------------------------------------

async function processAdvisory(
  db: Database.Database,
  url: string,
  progress: Progress,
): Promise<void> {
  if (progress.completed_advisory_urls.includes(url)) {
    counters.advisories_skipped++;
    return;
  }

  const reference = buildReference(url, "A");

  // Check if already in DB
  const existing = db
    .prepare("SELECT 1 FROM advisories WHERE reference = ?")
    .get(reference);
  if (existing) {
    counters.advisories_skipped++;
    progress.completed_advisory_urls.push(url);
    return;
  }

  console.log(`    Scraping advisory: ${url}`);
  let detail: DetailPage;
  try {
    detail = await scrapeDetailPage(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    Error scraping ${url}: ${msg}`);
    counters.errors++;
    return;
  }

  if (!detail.fullText || detail.fullText.length < 50) {
    console.warn(`    Skipping ${url}: insufficient content`);
    counters.errors++;
    return;
  }

  const title = detail.title || reference;
  const date = detail.date;
  const severity = inferSeverity(detail.fullText);
  const cveRefs = extractCves(detail.fullText);
  const affectedProducts = extractAffectedProducts(
    detail.sections,
    detail.fullText,
  );

  // Build summary from "Povzetek" section or first 600 chars
  const summary =
    detail.sections["Povzetek"]?.slice(0, 600) ??
    detail.sections["Opis"]?.slice(0, 600) ??
    detail.fullText.slice(0, 600);

  const row: AdvisoryRow = {
    reference,
    title,
    date,
    severity,
    affected_products: affectedProducts,
    summary: summary.trim(),
    full_text: detail.fullText,
    cve_references: cveRefs,
  };

  if (dryRun) {
    console.log(
      `    [dry-run] Would insert advisory: ${reference} | ${title.slice(0, 70)} | severity=${severity} | CVEs=${cveRefs ?? "none"}`,
    );
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.reference,
      row.title,
      row.date,
      row.severity,
      row.affected_products,
      row.summary,
      row.full_text,
      row.cve_references,
    );
  }

  counters.advisories_inserted++;
  progress.completed_advisory_urls.push(url);
}

// ---------------------------------------------------------------------------
// Guidance/News processing (Novice -> guidance table)
// ---------------------------------------------------------------------------

/**
 * Infer the content type and series from the URL and detail content.
 */
function classifyGuidance(
  url: string,
  detail: DetailPage,
): { type: string; series: string } {
  const lower = (detail.title + " " + detail.fullText).toLowerCase();

  // Annual reports (letna poročila)
  if (url.includes("letna_porocila") || url.includes("porocilo-o-kibernetski")) {
    return { type: "annual_report", series: "SI-CERT-letna-porocila" };
  }

  // NIS2 / ZVKSES related
  if (lower.includes("nis2") || lower.includes("zvkses")) {
    return { type: "directive", series: "NIS2" };
  }

  // Technical recommendations
  if (
    lower.includes("priporočil") ||
    lower.includes("priporocil") ||
    lower.includes("smernic") ||
    lower.includes("navodil")
  ) {
    return { type: "recommendation", series: "SI-CERT-priporocila" };
  }

  // Awareness / education
  if (
    lower.includes("ozaveščanj") ||
    lower.includes("ozavescanj") ||
    lower.includes("izobraževanj") ||
    lower.includes("izobrazevanj") ||
    lower.includes("usposabljan")
  ) {
    return { type: "awareness", series: "SI-CERT-ozavescanje" };
  }

  // Statistics / reports
  if (
    lower.includes("v številkah") ||
    lower.includes("v stevilkah") ||
    lower.includes("statistik")
  ) {
    return { type: "report", series: "SI-CERT-porocila" };
  }

  // Default: news
  return { type: "security_news", series: "SI-CERT-novice" };
}

async function processNewsEntry(
  db: Database.Database,
  url: string,
  progress: Progress,
): Promise<void> {
  if (progress.completed_news_urls.includes(url)) {
    counters.guidance_skipped++;
    return;
  }

  const reference = buildReference(url, "N");

  // Check if already in DB
  const existing = db
    .prepare("SELECT 1 FROM guidance WHERE reference = ?")
    .get(reference);
  if (existing) {
    counters.guidance_skipped++;
    progress.completed_news_urls.push(url);
    return;
  }

  console.log(`    Scraping news/guidance: ${url}`);
  let detail: DetailPage;
  try {
    detail = await scrapeDetailPage(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    Error scraping ${url}: ${msg}`);
    counters.errors++;
    return;
  }

  if (!detail.fullText || detail.fullText.length < 50) {
    console.warn(`    Skipping ${url}: insufficient content`);
    counters.errors++;
    return;
  }

  const { type, series } = classifyGuidance(url, detail);
  const title = detail.title || reference;
  const topics = extractTopics(title, detail.fullText);

  // Summary: first meaningful section or first 600 chars
  const summary =
    detail.sections["Povzetek"]?.slice(0, 600) ??
    detail.fullText.slice(0, 600);

  const row: GuidanceRow = {
    reference,
    title,
    title_en: null,
    date: detail.date,
    type,
    series,
    summary: summary.trim(),
    full_text: detail.fullText,
    topics,
    status: "current",
  };

  if (dryRun) {
    console.log(
      `    [dry-run] Would insert guidance: ${reference} | ${title.slice(0, 70)} | type=${type}`,
    );
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.reference,
      row.title,
      row.title_en,
      row.date,
      row.type,
      row.series,
      row.summary,
      row.full_text,
      row.topics,
      row.status,
    );
  }

  counters.guidance_inserted++;
  progress.completed_news_urls.push(url);
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (resume && existsSync(PROGRESS_FILE)) {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      const p = JSON.parse(raw) as Progress;
      console.log(
        `Resuming from checkpoint (${p.last_updated}): ` +
          `${p.completed_advisory_urls.length} advisories, ` +
          `${p.completed_news_urls.length} news`,
      );
      return p;
    } catch {
      console.warn("Could not parse progress file, starting fresh");
    }
  }
  return {
    completed_advisory_urls: [],
    completed_news_urls: [],
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  console.log(`Database initialised at ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Framework definitions (static)
// ---------------------------------------------------------------------------

const FRAMEWORKS: FrameworkRow[] = [
  {
    id: "si-cert",
    name: "SI-CERT varnostna obvestila in priporočila",
    name_en: "SI-CERT Security Advisories and Recommendations",
    description:
      "SI-CERT (Nacionalni odzivni center za kibernetsko varnost) objavlja " +
      "varnostna obvestila o aktualnih kibernetskih grožnjah, tehnična priporočila " +
      "in usmeritve za odzivanje na incidente. SI-CERT deluje v okviru javnega " +
      "zavoda ARNES in je nacionalni CSIRT po NIS2 direktivi.",
    document_count: 0,
  },
  {
    id: "nis2-si",
    name: "NIS2 implementacija v Sloveniji (ZVKSES)",
    name_en: "NIS2 Implementation in Slovenia (ZVKSES)",
    description:
      "Slovenija je transponirala NIS2 direktivo z Zakonom o varnosti " +
      "kibernetskega prostora (ZVKSES). Zakon ureja obveznosti bistvenih in " +
      "pomembnih subjektov, prijavne roke incidentov, minimalne varnostne ukrepe " +
      "in nadzorno vlogo SOVA ter SI-CERT.",
    document_count: 0,
  },
  {
    id: "national-cyber-strategy-si",
    name: "Nacionalna strategija kibernetske varnosti 2022-2027",
    name_en: "National Cybersecurity Strategy 2022-2027",
    description:
      "Slovenska petletna strategija kibernetske varnosti s šest strateškimi " +
      "stebri: odpornost, zaupanje, zmogljivosti, znanje, suverenost in " +
      "mednarodno sodelovanje. Ukrepi vključujejo okrepitev SI-CERT, " +
      "vzpostavitev Centra za kibernetsko obrambo in povečanje naložb v " +
      "kibernetsko izobraževanje.",
    document_count: 0,
  },
  {
    id: "si-cert-novice",
    name: "SI-CERT novice in ozaveščanje",
    name_en: "SI-CERT News and Awareness",
    description:
      "SI-CERT novice pokrivajo aktualne kibernetske grožnje, kampanje " +
      "socialnega inženiringa, analize incidentov in ozaveščanje javnosti. " +
      "Objavljajo se na cert.si in prek glasila Odziv.",
    document_count: 0,
  },
];

function insertFrameworks(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)",
  );
  for (const f of FRAMEWORKS) {
    stmt.run(f.id, f.name, f.name_en, f.description, f.document_count);
  }
  console.log(`Inserted ${FRAMEWORKS.length} frameworks`);
}

function updateFrameworkCounts(db: Database.Database): void {
  const advisoryCount = (
    db.prepare("SELECT COUNT(*) as n FROM advisories").get() as { n: number }
  ).n;
  const guidanceCount = (
    db.prepare("SELECT COUNT(*) as n FROM guidance").get() as { n: number }
  ).n;

  // SI-CERT framework gets the advisory count
  db.prepare("UPDATE frameworks SET document_count = ? WHERE id = ?").run(
    advisoryCount,
    "si-cert",
  );
  // News framework gets the guidance count
  db.prepare("UPDATE frameworks SET document_count = ? WHERE id = ?").run(
    guidanceCount,
    "si-cert-novice",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== SI-CERT Ingestion Crawler ===");
  console.log(`Database: ${DB_PATH}`);
  console.log(
    `Flags: force=${force} dry-run=${dryRun} resume=${resume} ` +
      `advisories-only=${advisoriesOnly} guidance-only=${guidanceOnly}`,
  );
  console.log();

  const db = initDatabase();
  const progress = loadProgress();

  // Insert framework definitions
  if (!dryRun) {
    insertFrameworks(db);
  }

  // ------------------------------------------------------------------
  // Phase 1: Crawl Varnostna obvestila (Security advisories)
  // ------------------------------------------------------------------
  if (!guidanceOnly) {
    console.log("\n--- Phase 1: Varnostna obvestila -> advisories ---");

    const entries = await crawlAllListingPages(
      ADVISORIES_LISTING,
      "Varnostna-obvestila",
    );

    console.log(
      `\n  Total unique advisory URLs: ${entries.length}`,
    );

    let idx = 0;
    for (const entry of entries) {
      idx++;
      if (idx % 10 === 0 || idx === 1) {
        console.log(
          `  Progress: ${idx}/${entries.length} advisories (${counters.advisories_inserted} inserted, ${counters.advisories_skipped} skipped)`,
        );
      }
      await processAdvisory(db, entry.url, progress);

      // Save progress every 25 items
      if (idx % 25 === 0 && !dryRun) {
        saveProgress(progress);
      }
    }

    if (!dryRun) saveProgress(progress);
    console.log(
      `\n  Advisories complete: ${counters.advisories_inserted} inserted, ${counters.advisories_skipped} skipped`,
    );
  }

  // ------------------------------------------------------------------
  // Phase 2: Crawl Novice (News/guidance)
  // ------------------------------------------------------------------
  if (!advisoriesOnly) {
    console.log("\n--- Phase 2: Novice (News) -> guidance ---");

    const entries = await crawlAllListingPages(
      NEWS_LISTING,
      "Novice",
    );

    console.log(
      `\n  Total unique news URLs: ${entries.length}`,
    );

    let idx = 0;
    for (const entry of entries) {
      idx++;
      if (idx % 10 === 0 || idx === 1) {
        console.log(
          `  Progress: ${idx}/${entries.length} news (${counters.guidance_inserted} inserted, ${counters.guidance_skipped} skipped)`,
        );
      }
      await processNewsEntry(db, entry.url, progress);

      if (idx % 25 === 0 && !dryRun) {
        saveProgress(progress);
      }
    }

    if (!dryRun) saveProgress(progress);
    console.log(
      `\n  News/guidance complete: ${counters.guidance_inserted} inserted, ${counters.guidance_skipped} skipped`,
    );
  }

  // ------------------------------------------------------------------
  // Final: update framework document counts and report
  // ------------------------------------------------------------------
  if (!dryRun) {
    updateFrameworkCounts(db);
    saveProgress(progress);
  }

  db.close();

  console.log("\n=== Ingestion Complete ===");
  console.log(`  Pages fetched:       ${counters.pages_fetched}`);
  console.log(`  Advisories inserted: ${counters.advisories_inserted}`);
  console.log(`  Advisories skipped:  ${counters.advisories_skipped}`);
  console.log(`  Guidance inserted:   ${counters.guidance_inserted}`);
  console.log(`  Guidance skipped:    ${counters.guidance_skipped}`);
  console.log(`  Errors:              ${counters.errors}`);
  if (dryRun) {
    console.log("\n  (dry-run mode -- no data was written)");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
