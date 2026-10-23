import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import pg from "pg";
​const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
​const app = express();
app.use(express.json({ limit: "10mb" }));
​// Statik dosyaları sunma
app.use(express.static(path.join(__dirname, "public")));
​const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
​// Veritabanı Bağlantısı
const pool = new Pool({
connectionString: DATABASE_URL,
ssl: DATABASE_URL && !DATABASE_URL.includes("localhost") ? { rejectUnauthorized: false } : false,
max: 10,
idleTimeoutMillis: 30000,
});
​// Veritabanı Tablolarının İlklendirilmesi
async function initDb() {
const client = await pool.connect();
try {
await client.query(`
CREATE TABLE IF NOT EXISTS historical_matches (
id SERIAL PRIMARY KEY,
league VARCHAR(100),
home_team VARCHAR(100),
away_team VARCHAR(100),
match_date TIMESTAMP,
home_goals INT,
away_goals INT,
ht_home_goals INT,
ht_away_goals INT,
odd_1 NUMERIC,
odd_x NUMERIC,
odd_2 NUMERIC,
odd_over25 NUMERIC,
odd_under25 NUMERIC,
odd_btts_yes NUMERIC,
odd_btts_no NUMERIC
);
​CREATE TABLE IF NOT EXISTS match_stat_snapshots (
id SERIAL PRIMARY KEY,
fixture_id INT UNIQUE,
data JSONB,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
​CREATE TABLE IF NOT EXISTS tracked_matches (
fixture_id INT PRIMARY KEY,
added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
​CREATE TABLE IF NOT EXISTS odds_snapshots (
id SERIAL PRIMARY KEY,
fixture_id INT,
odds_data JSONB,
captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
​CREATE TABLE IF NOT EXISTS sent_match_alarms (
id SERIAL PRIMARY KEY,
fixture_id INT,
alarm_type VARCHAR(50),
sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
​CREATE TABLE IF NOT EXISTS approved_analyses (
id SERIAL PRIMARY KEY,
fixture_id INT UNIQUE,
analysis_data JSONB,
approved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
​CREATE TABLE IF NOT EXISTS approved_coupons (
id SERIAL PRIMARY KEY,
coupon_date DATE UNIQUE,
coupon_data JSONB,
approved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`);
console.log("[DB] Tablolar başarıyla ilklendirildi.");
} catch (err) {
console.error("[DB Init Error]", err);
} finally {
client.release();
}
}
​// CSV İçe Aktarım Fonksiyonu
async function importHistoricalCsvOnce() {
const csvPath = path.join(__dirname, "winscope_historical_odds.csv");
if (!fs.existsSync(csvPath)) return;
​const client = await pool.connect();
try {
const res = await client.query("SELECT COUNT(*) FROM historical_matches;");
if (parseInt(res.rows[0].count) > 0) return;
​console.log("[CSV] Tarihsel veriler veritabanına aktarılıyor...");
const fileContent = fs.readFileSync(csvPath, "utf-8");
const records = parse(fileContent, { columns: true, skip_empty_lines: true });
​for (const row of records) {
await client.query(
INSERT INTO historical_matches  (league, home_team, away_team, match_date, home_goals, away_goals, ht_home_goals, ht_away_goals, odd_1, odd_x, odd_2, odd_over25, odd_under25, odd_btts_yes, odd_btts_no) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15),
[
row.league || row.League,
row.home_team || row.Home,
row.away_team || row.Away,
row.match_date || row.Date,
parseInt(row.home_goals || row.HG) || 0,
parseInt(row.away_goals || row.AG) || 0,
parseInt(row.ht_home_goals || row.HTHG) || 0,
parseInt(row.ht_away_goals || row.HTAG) || 0,
parseFloat(row.odd_1 || row.B365H) || null,
parseFloat(row.odd_x || row.B365D) || null,
parseFloat(row.odd_2 || row.B365A) || null,
parseFloat(row.odd_over25 || row["B365>2.5"]) || null,
parseFloat(row.odd_under25 || row["B365<2.5"]) || null,
parseFloat(row.odd_btts_yes) || null,
parseFloat(row.odd_btts_no) || null,
]
);
}
console.log("[CSV] Aktarım tamamlandı.");
} catch (err) {
console.error("[CSV Import Error]", err);
} finally {
client.release();
}
}
​// API-Football Çağrıları İçin Önbellekleme Mekanizması
const cache = new Map();
async function cachedProviderRequest(endpoint, ttlSeconds = 300) {
const now = Date.now();
if (cache.has(endpoint)) {
const cached = cache.get(endpoint);
if (now - cached.timestamp < ttlSeconds * 1000) {
return cached.data;
}
}
​if (!API_FOOTBALL_KEY) {
console.warn("[API-Football] API_FOOTBALL_KEY tanımlanmamış.");
return null;
}
​try {
const response = await fetch(https://v3.football.api-sports.io/${endpoint}, {
headers: {
"x-apisports-key": API_FOOTBALL_KEY,
},
});
​if (response.status === 429) {
console.warn("[API-Football] Rate limit aşıldı.");
if (cache.has(endpoint)) return cache.get(endpoint).data;
return null;
}
​const data = await response.json();
cache.set(endpoint, { timestamp: now, data });
return data;
} catch (err) {
console.error([API Fetch Error] ${endpoint}:, err);
if (cache.has(endpoint)) return cache.get(endpoint).data;
return null;
}
}
​// Tarihsel Benzer Maçları Getirme
async function getHistoricalMatchesForOdds(odds) {
const client = await pool.connect();
try {
const res = await client.query("SELECT * FROM historical_matches");
const allMatches = res.rows;
​if (!odds || !odds.odd_1 || !odds.odd_over25) {
return { matches: allMatches.slice(0, 100), matchSpecificSample: false, sampleSize: allMatches.length };
}
​// Oran mesafesine (d <= 1.0) göre benzer maçları bul
const closeMatches = allMatches.filter((m) => {
if (!m.odd_1 || !m.odd_over25) return false;
const d = Math.sqrt(
Math.pow(parseFloat(m.odd_1) - odds.odd_1, 2) +
Math.pow(parseFloat(m.odd_x || 3.3) - (odds.odd_x || 3.3), 2) +
Math.pow(parseFloat(m.odd_2 || 2.5) - (odds.odd_2 || 2.5), 2) +
Math.pow(parseFloat(m.odd_over25) - odds.odd_over25, 2)
);
return d <= 1.0;
});
​if (closeMatches.length >= 20) {
return { matches: closeMatches, matchSpecificSample: true, sampleSize: closeMatches.length };
} else {
return { matches: allMatches.slice(0, 100), matchSpecificSample: false, sampleSize: closeMatches.length };
}
} catch (err) {
console.error("[Historical Odds Error]", err);
return { matches: [], matchSpecificSample: false, sampleSize: 0 };
} finally {
client.release();
}
}
​// --- API UÇ NOKTALARI (ENDPOINTS) ---
​// Günlük Kupon Oluşturma
app.get("/api/coupon/daily", async (req, res) => {
try {
const today = new Date().toISOString().split("T")[0];
const fixturesRes = await cachedProviderRequest(fixtures?date=${today}, 1800);
if (!fixturesRes || !fixturesRes.response) {
return res.status(500).json({ error: "Fikstür çekilemedi." });
}
​const fixtures = fixturesRes.response;
const candidates = [];
​for (const fix of fixtures) {
const oddsRes = await cachedProviderRequest(odds?fixture=${fix.fixture.id}, 3600);
let odds = null;
if (oddsRes && oddsRes.response && oddsRes.response.length > 0) {
const bookmaker = oddsRes.response[0].bookmakers.find((b) => b.name === "Bet365") || oddsRes.response[0].bookmakers[0];
if (bookmaker) {
odds = {};
bookmaker.bets.forEach((bet) => {
if (bet.name === "Match Winner") {
odds.odd_1 = parseFloat(bet.values.find((v) => v.value === "Home")?.odd);
odds.odd_x = parseFloat(bet.values.find((v) => v.value === "Draw")?.odd);
odds.odd_2 = parseFloat(bet.values.find((v) => v.value === "Away")?.odd);
}
if (bet.name === "Goals Over/Under") {
odds.odd_over25 = parseFloat(bet.values.find((v) => v.value === "Over 2.5")?.odd);
odds.odd_under25 = parseFloat(bet.values.find((v) => v.value === "Under 2.5")?.odd);
}
if (bet.name === "Both Teams To Score") {
odds.odd_btts_yes = parseFloat(bet.values.find((v) => v.value === "Yes")?.odd);
odds.odd_btts_no = parseFloat(bet.values.find((v) => v.value === "No")?.odd);
}
});
}
}
​if (!odds) continue;
​const history = await getHistoricalMatchesForOdds(odds);
​// CRITICAL FIX: Maça özel örneklem 20'den azsa, Analiz ile uyumluluk için bu maçı kupona SEÇME
if (!history.matchSpecificSample || history.sampleSize < 20) {
continue;
}
​const total = history.matches.length;
if (total === 0) continue;
​const over25Count = history.matches.filter((m) => m.home_goals + m.away_goals > 2.5).length;
const over25Pct = (over25Count / total) * 100;
​const under25Count = history.matches.filter((m) => m.home_goals + m.away_goals < 2.5).length;
const under25Pct = (under25Count / total) * 100;
​// 2.5 ÜST Kriteri
if (over25Pct >= 55 && odds.odd_over25) {
const implied = 100 / odds.odd_over25;
const edge = over25Pct - implied;
if (edge >= 2) {
candidates.push({
fixture_id: fix.fixture.id,
league: fix.league.name,
match: ${fix.teams.home.name} VS ${fix.teams.away.name},
date: fix.fixture.date,
pick: "MS 2.5 ÜST",
realization: %${over25Pct.toFixed(1)},
sampleSize: history.sampleSize,
odd: odds.odd_over25,
edge: edge.toFixed(1),
});
}
}
​// 2.5 ALT Kriteri
if (under25Pct >= 55 && odds.odd_under25) {
const implied = 100 / odds.odd_under25;
const edge = under25Pct - implied;
if (edge >= 2) {
candidates.push({
fixture_id: fix.fixture.id,
league: fix.league.name,
match: ${fix.teams.home.name} VS ${fix.teams.away.name},
date: fix.fixture.date,
pick: "MS 2.5 ALT",
realization: %${under25Pct.toFixed(1)},
sampleSize: history.sampleSize,
odd: odds.odd_under25,
edge: edge.toFixed(1),
});
}
}
}
​// Edge değerine göre sıralayıp en iyi 3 maçı kupon yap
candidates.sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge));
const finalCoupon = candidates.slice(0, 3);
​res.json({
date: today,
status: "ONAY BEKLİYOR",
matches: finalCoupon,
});
} catch (err) {
console.error("[Daily Coupon Error]", err);
res.status(500).json({ error: "Kupon oluşturulurken hata oluştu." });
}
});
​// Maç Analizi
app.get("/api/match/:id/analyze", async (req, res) => {
try {
const fixtureId = req.params.id;
const oddsRes = await cachedProviderRequest(odds?fixture=${fixtureId}, 3600);
​let odds = null;
if (oddsRes && oddsRes.response && oddsRes.response.length > 0) {
const bookmaker = oddsRes.response[0].bookmakers.find((b) => b.name === "Bet365") || oddsRes.response[0].bookmakers[0];
if (bookmaker) {
odds = {};
bookmaker.bets.forEach((bet) => {
if (bet.name === "Match Winner") {
odds.odd_1 = parseFloat(bet.values.find((v) => v.value === "Home")?.odd);
odds.odd_x = parseFloat(bet.values.find((v) => v.value === "Draw")?.odd);
odds.odd_2 = parseFloat(bet.values.find((v) => v.value === "Away")?.odd);
}
if (bet.name === "Goals Over/Under") {
odds.odd_over25 = parseFloat(bet.values.find((v) => v.value === "Over 2.5")?.odd);
odds.odd_under25 = parseFloat(bet.values.find((v) => v.value === "Under 2.5")?.odd);
}
});
}
}
​const history = await getHistoricalMatchesForOdds(odds);
​if (!history.matchSpecificSample || history.sampleSize < 20) {
return res.json({
mainPick: "MAÇA ÖZEL VERİ YETERSİZ · tercih yok",
alternative: "Maça özel değer avantajı doğrulanmadı",
htScore: "Yeterli tarihsel örneklemle skor senaryosu bulunamadı",
ftScore: "Yeterli tarihsel örneklemle skor senaryosu bulunamadı",
surprise: "Yeterli destek yok",
marketTrend: "Home: SABİT · Draw: SABİT · Away: SABİT · Over 2.5: SABİT · Under 2.5: SABİT",
similarMatchesStats: {
ms1: "0.0%",
msX: "0.0%",
ms2: "0.0%",
},
});
}
​const total = history.matches.length;
const ms1 = ((history.matches.filter((m) => m.home_goals > m.away_goals).length / total) * 100).toFixed(1);
const msX = ((history.matches.filter((m) => m.home_goals === m.away_goals).length / total) * 100).toFixed(1);
const ms2 = ((history.matches.filter((m) => m.home_goals < m.away_goals).length / total) * 100).toFixed(1);
​const over25Count = history.matches.filter((m) => m.home_goals + m.away_goals > 2.5).length;
const over25Pct = (over25Count / total) * 100;
​let mainPick = "MS 2.5 ÜST";
if (over25Pct < 50) mainPick = "MS 2.5 ALT";
​res.json({
mainPick: mainPick,
alternative: "KG VAR / YOK Değerlendirilebilir",
htScore: "1-0 / 0-0",
ftScore: "2-1 / 1-1",
surprise: "MS X",
marketTrend: "Home: SABİT · Draw: SABİT · Away: SABİT",
similarMatchesStats: {
ms1: ${ms1}%,
msX: ${msX}%,
ms2: ${ms2}%,
},
});
} catch (err) {
console.error("[Match Analyze Error]", err);
res.status(500).json({ error: "Analiz yapılırken hata oluştu." });
}
});
​// Sunucuyu Başlat
app.listen(PORT, async () => {
console.log([SERVER] WinScope Sunucusu ${PORT} portunda aktif.);
await initDb();
await importHistoricalCsvOnce();
});
