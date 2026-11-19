# WinScope New Odds Engine v0.1

WinScope için bağımsız maç önü oran analiz motoru.

## Kurallar
- Sadece maç başlamadan önce kaydedilmiş oranlar kullanılır.
- Bet365 önceliklidir.
- Bet365 yoksa mevcut diğer bahis şirketleri değerlendirilir.
- KG Var ve MS 2.5 Üst için kabul edilen oran aralığı 1.50–1.73'tür.
- Eksik veya doğrulanamayan veride UZAK DUR döner.
- Oranlar kullanıcı arayüzünde gösterilmez.

## Test

```bash
npm test
npm run check
