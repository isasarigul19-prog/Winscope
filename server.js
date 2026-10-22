--- a/server.js
+++ b/server.js
@@
       if (!oddsResult || oddsResult.error) {
-        inspected.push({ fixtureId: fixture.id, reason: "Oran verisi alınamadı." });
+        const detail = oddsResult?.error?.message || "Bilinmeyen oran hatası";
+        console.error(`[COUPON_ODDS_ERROR] fixture=${fixture.id} error=${detail}`);
+        inspected.push({
+          fixtureId: fixture.id,
+          reason: `Oran verisi alınamadı: ${detail}`.slice(0, 220)
+        });
         continue;
       }
