# WinScore Live — first prototype

## What works now
- Responsive Android-friendly web UI
- Demo match cards
- Filters: all matches / goal signal / likely hold / avoid
- Clear separation between example/demo signals and real live data

## What is not connected yet
The HTML is a working UI prototype, not yet a verified live-data service. Real API integration requires an API-Football key and a backend. Do not put the key into `index.html`.

## Run the demo
Open `public/index.html` in a browser, or serve the `public` folder with any static web server.

## Start the backend starter
Requires Node.js 18+:
1. Copy `index.html` into `public/index.html`.
2. Save `server.js` in the project root.
3. Create `package.json` with:
   {
     "type": "module",
     "scripts": { "start": "node server.js" },
     "dependencies": { "express": "^4.21.2" }
   }
4. Run `npm install`
5. Set `API_FOOTBALL_KEY` as a server environment variable.
6. Run `npm start`

The current backend starter validates API connectivity and returns raw live fixture count/data; it deliberately does not pretend raw provider data is already mapped to the UI or that goal predictions are validated.

## Build plan
1. **Data plumbing:** connect live fixtures and store provider fixture IDs; map scores, minutes, status.
2. **Statistics:** fetch shots, shots on target, dangerous attacks where provided, possession, corners, and xG only when provider coverage supports it. Compute last-10-minute deltas by saving periodic snapshots.
3. **Odds history:** poll live odds when provider/league/market coverage supports it; store timestamps to detect actual falls/rises. Do not infer movement from a single odds snapshot.
4. **Signal engine:** separate two outputs:
   - `NEXT_GOAL_WATCH`: multiple independent recent attacking signals agree.
   - `MATCH_MAY_HOLD`: low recent attacking activity and no meaningful pressure.
   - `CONFLICT / AVOID`: missing data or conflicting indicators.
   Start with transparent rule-based scores; do not label them calibrated probabilities until back-tested.
5. **Alerts:** user-selectable thresholds, notification permissions, duplicate suppression and cooldown.
6. **Validation:** back-test against completed matches, record false alarms, precision, recall and lead time. No pick is forced when data is missing.
7. **Android + web:** ship as a responsive Progressive Web App first (installable on Android); later wrap with Capacitor or build native Android if required.

## Initial signal rules (not calibrated probabilities)
- Never trigger on score alone.
- Prefer recent changes (last 10 minutes), not only full-match totals.
- Missing xG or stats should reduce confidence, not be filled with invented values.
- `MATCH_MAY_HOLD` is a watch signal, not a guarantee that no more goals will occur.
- Odds direction is available only after storing at least two timestamped observations.
