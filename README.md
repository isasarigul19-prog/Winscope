# WinScope

## Analiz kuralları
- API-Football gerçek fikstür, maç önü oranı, skor ve canlı istatistik kaynağıdır.
- Bet365 maç önü oranı varsa önceliklidir; yoksa API-Football'ın döndürdüğü diğer gerçek bookmaker verisi kullanılır.
- Maç önü analizinde maç önü oranları ana sinyaldir; son 5 tamamlanmış maç takım formu yalnızca destekleyici girdidir.
- Canlı analizde canlı oran kullanılmaz. Maç önü oranı; güncel dakika, skor ve mevcut canlı istatistiklerle birlikte değerlendirilir.
- KG Var ve MS 2.5 Üst seçimlerinde maç önü oranı 1.50–1.73 aralığında olmalıdır. 1.50 altı fiyatla tercih üretilmez.
- Kadın, U/yaş grubu, genç ve rezerv takımlar analiz havuzundan çıkarılır.
- Gerçek veri yoksa oran, istatistik veya skor uydurulmaz; yeterli veri yoksa tercih/kupon üretilmez.
- Oran değerleri kullanıcı arayüzünde ve Telegram bildirimlerinde gösterilmez; yalnızca iç analizde kullanılır.
- Hiçbir tahmin garanti değildir. Sistem, eşikleri geçen en güçlü adayları seçer; aday yoksa kuponu zorlamaz.

## Dağıtım
- Başlangıç komutu: `npm start`
- Sözdizimi kontrolü: `npm run check`
- Gerekli Render ortam değişkenleri: `API_FOOTBALL_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DATABASE_URL`.
- `/api/health` API anahtarı, Telegram ve veritabanı yapılandırmasını bildirir.
- GitHub Actions, `server.js` değişikliklerinde otomatik `node --check server.js` kontrolü çalıştırır.

## Not
Canlı veri ve oranların kapsamı API-Football aboneliğine ve maç bazında sağlanan bookmaker verisine bağlıdır. Maç önü oranı kaydı her zaman resmî kapanış oranı anlamına gelmez.
