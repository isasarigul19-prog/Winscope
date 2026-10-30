# WinScope Rebuilt

Bu paket WinScope arayüzünü korur ve analiz akışını yeniden düzenler.

## Kurallar
- API-Football verileri esas alınır.
- Maç önü analizinde maç önü oranı ve son 5 maç formu destekleyici girdilerdir.
- Canlı analizde son 5 maç formu seçim kapısı değildir; skor, dakika, mevcut canlı istatistik ve mevcutsa gerçek canlı oran kullanılır.
- Gerçek canlı oran yoksa maç önü oranı kullanıldığı açıkça belirtilir; canlı oran diye etiketlenmez.
- Oran/istatistik uydurulmaz. Veri eksikse senaryo tahmini ayrıca etiketlenir.
- Oran değerleri arayüzde/Telegram'da gösterilmez.
- Ana tercih ve alternatif aynı piyasa olarak tekrarlanmaz.
- API-Football anahtarı ve Telegram/DB ayarları Render ortam değişkenlerinde tutulur.

## Deploy
GitHub'daki mevcut projeyi yedekleyin. Bu paketteki `server.js`, `index.html`, `package.json` dosyalarını proje köküne koyun. Render'daki `API_FOOTBALL_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DATABASE_URL` değişkenlerini silmeyin.

## Kontrol
`/api/health` endpoint'i API anahtarı, Telegram ve veritabanı yapılandırmasını gösterir. Gerçek veri ve canlı odds erişimi API-Football aboneliğine bağlıdır; bu ortamda Render anahtarıyla uçtan uca test edilemez.
