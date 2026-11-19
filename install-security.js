import fs from "node:fs";
import path from "node:path";

const serverPath = path.resolve("server.js");
const packagePath = path.resolve("package.json");
if (!fs.existsSync(serverPath) || !fs.existsSync(packagePath)) {
  console.error("HATA: server.js ve package.json aynı klasörde bulunmalı.");
  process.exit(1);
}
let server = fs.readFileSync(serverPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

if (server.includes('from "./auth.js"') || server.includes("WINSCOPE_ADMIN_PASSWORD_HASH")) {
  console.error("Güvenlik kodu server.js içinde zaten görünüyor. Otomatik kurulum durduruldu; dosyayı elle kontrol et.");
  process.exit(1);
}
const importAnchor = 'import { fileURLToPath } from "node:url";';
const jsonAnchor = 'app.use(express.json({ limit: "500kb" }));';
const rootAnchor = 'app.get("/", async (_req, res) => {\n  try {';
if (!server.includes(importAnchor) || !server.includes(jsonAnchor) || !server.includes(rootAnchor)) {
  console.error("HATA: Bu server.js sürümünde beklenen kurulum noktaları bulunamadı. Dosya değiştirilmedi.");
  process.exit(1);
}
const healthRegex = /app\.get\("\/api\/health", \(_req, res\) => res\.json\(\{[\s\S]*?\n\}\)\);/;
if (!healthRegex.test(server)) {
  console.error("HATA: /api/health bloğu tanınmadı. Dosya değiştirilmedi.");
  process.exit(1);
}

const securityBlock = `
app.use(express.json({ limit: "500kb" }));

// Tek yönetici oturumu. Analiz ve maç değerlendirme fonksiyonlarına dokunmaz.
const ADMIN_PASSWORD_HASH = process.env.WINSCOPE_ADMIN_PASSWORD_HASH || "";
const SESSION_SECRET = process.env.WINSCOPE_SESSION_SECRET || "";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

function readCookie(req, name) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}
function hasValidAdminSession(req) {
  return Boolean(SESSION_SECRET && verifySessionToken(readCookie(req, "winscope_admin"), SESSION_SECRET));
}
function cookieFlags(req) {
  const secure = process.env.NODE_ENV === "production" || req.get("x-forwarded-proto") === "https";
  return "Path=/; HttpOnly; SameSite=Strict; Max-Age=" + SESSION_TTL_SECONDS + (secure ? "; Secure" : "");
}
function clearAdminCookie(req, res) {
  const secure = process.env.NODE_ENV === "production" || req.get("x-forwarded-proto") === "https";
  res.setHeader("Set-Cookie", "winscope_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + (secure ? "; Secure" : ""));
}
function sameOriginRequest(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === req.get("host"); } catch { return false; }
}
function loginBucket(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}
function loginBlocked(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { startedAt: now, count: 0 });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}
function recordLoginFailure(key) {
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.startedAt >= LOGIN_WINDOW_MS) entry = { startedAt: now, count: 0 };
  entry.count += 1;
  loginAttempts.set(key, entry);
}

const LOGIN_PAGE = \`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WinScope Yönetici Girişi</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#04191e;color:#f1fbfc;font:16px system-ui,sans-serif;padding:20px}
main{width:min(100%,390px);padding:26px;border:1px solid #15505a;border-radius:18px;background:#08272d;box-shadow:0 20px 60px #0005}
h1{margin:0 0 8px;font-size:25px}p{color:#9bb9bf;font-size:13px;line-height:1.5}
label{display:block;margin:22px 0 7px;font-size:13px}input{width:100%;padding:13px;border-radius:10px;border:1px solid #28616a;background:#04191e;color:#fff;font:inherit}
button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:10px;background:#ff2f63;color:#fff;font-weight:800;font-size:15px}
#error{color:#ff9baa;min-height:20px;font-size:13px}</style></head>
<body><main><h1>WINSCOPE <span style="color:#ff2f63">ADMIN</span></h1>
<p>Devam etmek için yönetici parolanı gir.</p><form id="login"><label for="password">Yönetici parolası</label>
<input id="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Güvenli giriş</button><div id="error" role="alert"></div></form></main>
<script>
document.getElementById('login').addEventListener('submit',async e=>{
 e.preventDefault();const b=e.target.querySelector('button'),err=document.getElementById('error');
 b.disabled=true;err.textContent='Kontrol ediliyor…';
 try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});
 const j=await r.json();if(!r.ok)throw new Error(j.error||'Giriş başarısız.');
 location.replace('/');}catch(x){err.textContent=x.message;b.disabled=false;}
});
</script></body></html>\`;

app.post("/api/auth/login", async (req, res) => {
  if (!sameOriginRequest(req)) return res.status(403).json({ error: "Geçersiz istek kaynağı." });
  if (!ADMIN_PASSWORD_HASH || !SESSION_SECRET) return res.status(503).json({ error: "Yönetici girişi yapılandırılmamış. Render ortam değişkenlerini kontrol et." });
  const key = loginBucket(req);
  if (loginBlocked(key)) return res.status(429).json({ error: "Çok fazla hatalı deneme. 15 dakika sonra tekrar dene." });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const valid = await verifyAdminPassword(password, ADMIN_PASSWORD_HASH).catch(() => false);
  if (!valid) {
    recordLoginFailure(key);
    return res.status(401).json({ error: "Parola hatalı." });
  }
  loginAttempts.delete(key);
  const token = createSessionToken(SESSION_SECRET, SESSION_TTL_SECONDS);
  res.setHeader("Set-Cookie", "winscope_admin=" + encodeURIComponent(token) + "; " + cookieFlags(req));
  return res.json({ success: true, expiresIn: SESSION_TTL_SECONDS });
});
app.post("/api/auth/logout", (req, res) => {
  clearAdminCookie(req, res);
  return res.json({ success: true });
});
app.get("/api/auth/me", (req, res) => res.json({ authenticated: hasValidAdminSession(req) }));
app.get("/logout", (req, res) => {
  clearAdminCookie(req, res);
  return res.redirect(303, "/");
});

// Tüm uygulama API uçları yönetici oturumu ister. Sağlık kontrolü yalnızca yapılandırma durumunu verir.
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path === "/auth/login" || req.path === "/auth/logout" || req.path === "/auth/me") return next();
  if (!hasValidAdminSession(req)) return res.status(401).json({ error: "Yönetici girişi gerekli.", code: "AUTH_REQUIRED" });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOriginRequest(req)) {
    return res.status(403).json({ error: "Geçersiz istek kaynağı." });
  }
  return next();
});
`;

let patched = server.replace(importAnchor, importAnchor + '\nimport { createSessionToken, verifySessionToken, verifyAdminPassword } from "./auth.js";');
patched = patched.replace(jsonAnchor, securityBlock);
patched = patched.replace(rootAnchor, 'app.get("/", async (req, res) => {\n  if (!hasValidAdminSession(req)) return res.status(200).type("html").send(LOGIN_PAGE);\n  try {');
patched = patched.replace(healthRegex, 'app.get("/api/health", (_req, res) => res.json({\n  ok: true, authConfigured: Boolean(ADMIN_PASSWORD_HASH && SESSION_SECRET)\n}));');

const backupPath = serverPath + ".before-single-admin.bak";
if (fs.existsSync(backupPath)) {
  console.error("HATA: Yedek dosyası zaten var (" + backupPath + "). Önce incele; hiçbir dosya değiştirilmedi.");
  process.exit(1);
}
fs.copyFileSync(serverPath, backupPath);
fs.writeFileSync(serverPath, patched, "utf8");
pkg.scripts ||= {};
pkg.scripts.check = "node --check server.js && node --check auth.js && node --check scripts/hash-admin-password.js && node --test auth.test.js";
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("Kurulum tamamlandı.");
console.log("Yedek: " + backupPath);
console.log("Şimdi: npm run check");
