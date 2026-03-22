/**
 * Seed the SI-CERT database with sample guidance and advisories.
 * Usage: npx tsx scripts/seed-sample.ts [--force]
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["SICERT_DB_PATH"] ?? "data/si-cert.db";
const force = process.argv.includes("--force");
const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted ${DB_PATH}`); }
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

// --- Frameworks ---
const frameworks = [
  { id: "nis2-si", name: "NIS2 implementacija v Sloveniji", name_en: "NIS2 Implementation in Slovenia", description: "Slovenia's implementation of EU NIS2 Directive via ZVKSES (Zakon o varnosti kibernetskega prostora). Covers essential and important entities, incident reporting, SOVA and SI-CERT supervisory roles.", document_count: 3 },
  { id: "national-cyber-strategy-si", name: "Nacionalna strategija kibernetske varnosti 2022-2027", name_en: "National Cybersecurity Strategy 2022-2027", description: "Slovenian five-year cybersecurity strategy defining objectives for critical infrastructure protection, e-government security, and cyber resilience.", document_count: 2 },
  { id: "si-cert-guidance", name: "SI-CERT Tehnicna priporocila", name_en: "SI-CERT Technical Recommendations", description: "SI-CERT (Slovenian CERT, operated by ARNES) technical guidance covering incident response, threat intelligence, and cybersecurity best practices.", document_count: 5 },
];
const insF = db.prepare("INSERT OR IGNORE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)");
for (const f of frameworks) insF.run(f.id, f.name, f.name_en, f.description, f.document_count);
console.log(`Inserted ${frameworks.length} frameworks`);

// --- Guidance ---
const guidance = [
  {
    reference: "SI-NIS2-2024", title: "Vodnik za implementacijo NIS2 v Sloveniji", title_en: "NIS2 Implementation Guide for Slovenia",
    date: "2024-01-15", type: "directive", series: "NIS2",
    summary: "Prakticni vodnik za implementacijo NIS2 direktive v slovenskem kontekstu: obveznosti bistvenih in pomembnih subjektov, prijavni roki incidentov in minimalni varnostni ukrepi.",
    full_text: "Slovenija je transponirala NIS2 direktivo (EU 2022/2555) z Zakonom o varnosti kibernetskega prostora (ZVKSES), ki je vstopil v veljavo oktobra 2024. Bistveni subjekti: energetika, promet, bancnistvo, infrastruktura financnih trgov, zdravje, digitalna infrastruktura, javna uprava. Kljucne obveznosti: (1) Upravljanje kibernetskih tveganj — primerni tehnicni in organizacijski ukrepi; (2) Prijavni roki — zgodnje opozorilo SI-CERT v 24 urah, podrobno obvestilo v 72 urah, zakljucno porocilo v enem mesecu; (3) Varnost dobavne verige — ocena tveganj IKT dobaviteljev; (4) Vecfaktorska avtentikacija — obvezna za administrativni dostop; (5) Odgovornost vodstva — vodstveni organi osebno odgovorni. Kazni: bistveni subjekti do 10 mio EUR ali 2% prometa; pomembni do 7 mio EUR ali 1,4%. SI-CERT je nacionalna tocka za prijavnanje incidentov.",
    topics: JSON.stringify(["NIS2", "kibernetska varnost", "incidentno porocanje", "ZVKSES"]), status: "current",
  },
  {
    reference: "SI-CERT-GD-2023-01", title: "Prirocnik za odzivanje na incidente v organizacijah", title_en: "Incident Response Handbook for Organisations",
    date: "2023-07-01", type: "guideline", series: "SI-CERT-guideline",
    summary: "SI-CERT prakticni prirocnik za odzivanje na kibernetske incidente: zaznavnanje, obvescanje, analiza, zajezitev in okrevanje.",
    full_text: "SI-CERT ponuja brezplacno pomoc pri odzivanju na incidente slovenskim organizacijam. Faze odzivanja: (1) Priprava — vzpostavitev ekipe, kontaktni seznam, tehnicna infrastruktura za detekcijo; (2) Zaznavanje in analiza — log monitoring, SIEM, integracija nevarnostnih obvestcil; (3) Zajezitev — kratkorocna zajezitev za omejevanje skode, dolgorocna priprava na okrevanje; (4) Odprava — odstranitev zlonamerne programske opreme, zaprtje ranljivosti; (5) Okrevanje — obnovitev sistemov, nadzor po okrevanju; (6) Poincidentne dejavnosti — dokumentiranje, analiza vzrokov, izboljsave. Obvestite SI-CERT: cert@cert.si ali +386 1 479 8228. Za NIS2 zavezance veljajo tudi zakonski prijavni roki.",
    topics: JSON.stringify(["odzivanje na incidente", "SI-CERT", "kibernetska varnost", "prijava"]), status: "current",
  },
  {
    reference: "SI-NCSS-2022", title: "Nacionalna strategija kibernetske varnosti 2022-2027", title_en: "National Cybersecurity Strategy 2022-2027",
    date: "2022-09-01", type: "standard", series: "national-strategy",
    summary: "Slovenska petletna strategija kibernetske varnosti s sest strateskimi stebri: odpornost, zaupanje, zmogljivosti, znanje, suverenost in mednarodno sodelovanje.",
    full_text: "Nacionalna strategija kibernetske varnosti 2022-2027 opredeljuje sest strateskih stebrov: (1) Odpornost — kibernetska odpornost kriticne infrastrukture in bistvenih storitev; (2) Zaupanje — vzpostavitev zaupanja v digitalne storitve z ustrezno regulacijo; (3) Zmogljivosti — okrepitev nacionalnih zmogljivosti za odzivanje in obrambno kibernetiko; (4) Znanje — razvoj kompetenc na vseh ravneh od osnovnih sol do podjetij; (5) Suverenost — krepitev digitalne suverenosti z nacrtom razvoja lastnih IKT zmogljivosti; (6) Mednarodno sodelovanje — aktivna vloga v EU, NATO in bilateralna partnerstva. Ukrepi vkljucujejo okrepitev SI-CERT kot nacionalnega CSIRT, vzpostavitev Centra za kibernetsko obrambo in povecanje naložb v kibernetsko izobraževanje.",
    topics: JSON.stringify(["nacionalna strategija", "kriticna infrastruktura", "upravljanje", "Slovenija"]), status: "current",
  },
  {
    reference: "SI-CERT-GD-2024-02", title: "Zascita pred izsiljevalsko programsko opremo", title_en: "Ransomware Protection and Response",
    date: "2024-02-20", type: "recommendation", series: "SI-CERT-guideline",
    summary: "SI-CERT priporocila za preprecevanje napadov z izsiljevalsko programsko opremo in odzivanje na incidente.",
    full_text: "Izsiljevalska programska oprema ostaja ena najvecjih kibernetskih grozenj za slovenske organizacije. SI-CERT je v letu 2023 obravnaval 38% vec izsiljevalskih napadov kot leto prej. Preventivni ukrepi: (1) Varnostne kopije — redne rezervne kopije po pravilu 3-2-1, testiranje obnove; (2) Segmentacija omrezja — locitev kriticnih sistemov, mikrosegmentacija; (3) Upravljanje dostopa — minimalne privilegije, vecfaktorska avtentikacija, privilegirani dostop; (4) Posodobitve — avtomatsko zakrpanje, prioritizacija sistemov na internetu; (5) Detekcija — EDR resitve, SIEM za kriticne sisteme. Ob napadu: ne placujte odkupnine, izolirajte okuzen sistem, obvestite SI-CERT, priklicite Policijo. SI-CERT ponuja brezplacno digitalnoforzicno pomoc.",
    topics: JSON.stringify(["izsiljevalska programska oprema", "varnostne kopije", "odzivanje"]), status: "current",
  },
  {
    reference: "SI-CERT-GD-2023-03", title: "Varnost oblacnih storitev za slovenske organizacije", title_en: "Cloud Security for Slovenian Organisations",
    date: "2023-04-10", type: "guideline", series: "SI-CERT-guideline",
    summary: "SI-CERT priporocila za varno uporabo oblacnih storitev v skladu z ENISA smernicami in zahtevami NIS2.",
    full_text: "Oblacne storitve prinasajo nove varnostne izzive. Priporocila SI-CERT: (1) Klasifikacija podatkov — pred prenosom v oblak klasificirajte podatke in ocenite tveganja; (2) Ocena ponudnikov — preverite varnostne certifikate (ISO 27001, SOC 2, CSA STAR); (3) Model deljene odgovornosti — razumite mejo odgovornosti med ponudnikom in stranko; (4) Upravljanje identitet — MFA za vse administratorje, privilegirani dostop, revizije pravic; (5) Nadzor in beleženje — aktivirajte oblacne dnevnike, integrirajte v SIEM; (6) Izhodni nacrt — zagotovite prenosljivost podatkov, izognite se zaklepanju pri dobavitelju. Organizacije, ki obdelujejo osebne podatke v oblaku, morajo upostevati GDPR in izvesti DPIA.",
    topics: JSON.stringify(["oblacna varnost", "GDPR", "ISO 27001", "slovenija"]), status: "current",
  },
];

const insG = db.prepare("INSERT OR IGNORE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insGAll = db.transaction(() => { for (const g of guidance) insG.run(g.reference, g.title, g.title_en, g.date, g.type, g.series, g.summary, g.full_text, g.topics, g.status); });
insGAll();
console.log(`Inserted ${guidance.length} guidance documents`);

// --- Advisories ---
const advisories = [
  {
    reference: "SI-CERT-2024-01", title: "Kriticna ranljivost v Ivanti Connect Secure VPN",
    date: "2024-01-11", severity: "critical",
    affected_products: JSON.stringify(["Ivanti Connect Secure", "Ivanti Policy Secure"]),
    summary: "SI-CERT opozarja na kriticno ranljivost v Ivanti Connect Secure VPN, ki omogoca nepooblasceno oddaljeno izvajanje kode.",
    full_text: "SI-CERT je izdal kriticno opozorilo za ranljivost v Ivanti Connect Secure (CVE-2024-21887 in CVE-2023-46805). Kombinacija ranljivosti za obvod avtentikacije in injiciranje ukazov omogoca nepooblascenim napadalcem izvajanje kode. Aktivno izkoriscape potrjeno pri slovenskim organizacijah. Ukrepi: (1) Takoj uveljavite Ivantijevo ublazitev XML; (2) Zazennite Ivanti Integrity Checker Tool; (3) Ob odkritju kompromitiranja izvedite ponastavitev na tovarniске nastavitve; (4) Preverite dnevnike za sumljive dejavnosti; (5) Obvestite SI-CERT: cert@cert.si.",
    cve_references: JSON.stringify(["CVE-2024-21887", "CVE-2023-46805"]),
  },
  {
    reference: "SI-CERT-2023-015", title: "Phishing napad na slovenske bancne stranke",
    date: "2023-10-15", severity: "high",
    affected_products: JSON.stringify(["Spletno bancnistvo", "Mobilne bancne aplikacije"]),
    summary: "SI-CERT opozarja na phishing kampanjo, usmerjeno na stranke slovenskih bank z namenom krade prijavnih podatkov.",
    full_text: "SI-CERT je zaznal koordinirano phishing kampanjo, ki cilja na stranke NLB, SKB, Sparkasse in Dezelne banke. Napadalci pošiljajo lazna e-poštna sporocila, ki posnemajo bancna obvestila, z referencami na ugasnitev racuna. Kampanja statistika: 340 prijav v 72 urah, 8 domen blokiranih. Napadi vkljucujejo: lazne prijavne strani, zbiranje poverilnic, obhod SMS 2FA s pomocjo sociotehnicnih metod. Zascitni ukrepi: vedno preverite URL banke; ne klikajte na povezave v e-sporocilih; aktivirajte obvestila o transakcijah; prijavite sum na cert@cert.si ali SI-CERT (01 479 8228).",
    cve_references: null,
  },
  {
    reference: "SI-CERT-2024-006", title: "Napad na dobavno verigo prek posodobitev programske opreme",
    date: "2024-03-10", severity: "high",
    affected_products: JSON.stringify(["Programska oprema s samodejnimi posodobitvami", "3CX Desktop App"]),
    summary: "SI-CERT opozorilo na napade na dobavno verigo prek trojaniziranih posodobitev programske opreme — potrjene žrtve med slovenskimi organizacijami.",
    full_text: "SI-CERT je identificiral slovenske organizacije, ki so bile izpostavljene napadom na dobavno verigo prek ogroženih posodobitev programske opreme. Vzorec napada sledi metodologiji XZ Utils in 3CX kompromitiranja. Kazalniki kompromitiranosti: nepricakovane odhodne povezave do neznane C2 infrastrukture, neobicajno izvajanje procesov, spremembe sistemskih knjiznic. Prizadete organizacije naj: (1) Popisejo vso programsko opremo z avtomatskimi posodobitvami; (2) Preverijo integriteto s pomocjo hash vrednosti proizvajalca; (3) Proucijo omrezne tokove za anomalije; (4) Prijavijo zaznano kompromitiranje SI-CERT-u.",
    cve_references: null,
  },
];

const insA = db.prepare("INSERT OR IGNORE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insAAll = db.transaction(() => { for (const a of advisories) insA.run(a.reference, a.title, a.date, a.severity, a.affected_products, a.summary, a.full_text, a.cve_references); });
insAAll();
console.log(`Inserted ${advisories.length} advisories`);

const gCnt = (db.prepare("SELECT count(*) as cnt FROM guidance").get() as { cnt: number }).cnt;
const aCnt = (db.prepare("SELECT count(*) as cnt FROM advisories").get() as { cnt: number }).cnt;
const fCnt = (db.prepare("SELECT count(*) as cnt FROM frameworks").get() as { cnt: number }).cnt;
console.log(`\nSummary: ${fCnt} frameworks, ${gCnt} guidance, ${aCnt} advisories`);
console.log(`Done. Database ready at ${DB_PATH}`);
db.close();
