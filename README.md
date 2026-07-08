# HelperPay — HK Domestic Helper Salary Tracker

A mobile-first web app for Hong Kong employers of domestic helpers. The helper
logs which days she worked or took off; the app calculates salary the
Employment Ordinance way, produces a monthly statement, records payments with
screenshots, and captures the helper's approval.

No server, no account, no build step. All data stays on the device, with
one-tap JSON backup. Households with more than one helper add extra profiles
in Settings → Helpers — each helper gets her own calendar, statements,
payments and PIN.

Because nothing is stored server-side, hosting the app publicly shares only
the code: every visitor starts with a completely fresh setup on their own
device. That makes it safe to share one URL with friends for beta testing.

## Salary rules implemented

These match the Labour Department conventions (and the household's verified
May/June 2026 payroll):

| Rule | Effect |
|---|---|
| Daily wage | monthly wage × 12 ÷ 365, kept exact, rounded only at the end |
| Weekly rest day (e.g. Sunday) | **Paid** — never deducted |
| Rest day worked | +1 day wage (half day → +½) |
| Statutory holiday taken | Paid — never deducted |
| Statutory holiday worked | +1 day wage (half day → +½) |
| Rest day + holiday on same date, worked | Counts **once**, not twice |
| Rest day never offsets a statutory holiday | Each date stands on its own |
| Ordinary leave on a working day | −1 day wage (half day → −½) |
| One rest day per 7 days served | No rest day in the first week of employment (default on; toggle in Settings; per-date override in Calendar wins) |
| First / last month | Pro-rated: calendar days employed × daily wage |
| Food allowance | Added monthly, pro-rated in partial months |

Only exceptions need logging — an unlogged working day counts as worked, an
unlogged rest day/holiday counts as taken. One-off rest-day date changes
(e.g. agency-confirmed) are set by tapping the day in the Calendar.

2026 statutory holidays (15 days, including the new Easter Monday) are
prefilled from the Labour Department list, including substitute entries for
holidays that fall on Sunday. The list is fully editable in Settings.

## Statutory holiday auto-sync

Future years' holidays sync automatically from the official HK Government
1823 calendar (published on data.gov.hk): about once a month when the app is
opened online, plus a manual *Sync from HK Gov* button in Settings. Details:

- The direct 1823 feed sends no CORS headers, so the app fetches the latest
  archived copy via the CORS-enabled `api.data.gov.hk/v1/historical-archive`
  API (`list-file-versions` → `get-file`).
- The feed lists **general** holidays; the app filters to Employment
  Ordinance **statutory** holidays by name, with year gates for the 2021
  Amendment phase-in (Easter Monday ≥2026, Good Friday ≥2028, day following
  Good Friday ≥2030). Bank holidays like Good Friday 2026 are excluded.
- The feed never lists a holiday on a Sunday — it lists the "day following"
  substitute instead, which is exactly the operative date for a Sunday-rest
  helper (the default). Non-Sunday rest days: adjust manually in Settings.
- Merging is add-only by date: user edits are never overwritten, and dates
  before the employment start are skipped.

## Running it

Local (development):

```bash
cd helper-salary
python3 -m http.server 4173
# open http://localhost:4173
```

On your phone (recommended): host the folder on any static host — GitHub Pages,
Netlify, or Cloudflare Pages. Then on the phone open the URL and
**Add to Home Screen** — it installs as an app and works offline.

### Sharing with beta testers

1. Host the folder (GitHub Pages: push the repo, Settings → Pages → deploy
   from `main`; or drag the folder onto https://app.netlify.com/drop).
2. Send friends the URL with two instructions:
   - iPhone: open in **Safari** → Share → **Add to Home Screen**.
     Android: open in Chrome → menu → **Add to Home screen / Install**.
   - Everything they enter stays on their phone; nobody else (including the
     host) can see it. Remind them to export a backup once they have real
     data, and to open the app at least weekly (iOS can evict browser
     storage for sites untouched for a while — installing to the home
     screen largely avoids this).
3. Each tester gets the onboarding screen fresh and configures their own
   helper(s), wage and rest day. Feedback goes to the *Send feedback* link
   in Settings.
4. To ship an update, just redeploy the folder — testers get it on next
   open (the service worker revalidates every file).

Run the calculation tests:

```bash
node tests/engine.test.js
```

The tests reproduce the household's independently verified May 2026
(HK$4,694.79) and June 2026 (HK$5,351.51) payroll to the cent.

## How the household uses it (one shared phone)

1. **Employer mode** (default): configure wage, start date, rest day,
   holidays in Settings; record payments; add adjustments.
2. Tap the mode chip (top right) to switch to **Helper mode** and hand the
   phone over: the helper logs her days with three big buttons and can
   approve payments. Settings and money-editing are hidden; leaving helper
   mode asks for the employer PIN (if set).
3. **Two-way approval keeps both parties synced.** Days the helper logs
   (leave, half-days, rest-day/holiday work) are marked **pending** until the
   employer approves them — a ⏳ inbox on the Today tab (with one-tap ✓ and
   *Approve all*), a dashed outline on the calendar, and a "pending" flag on
   the statement. Pending days already count in the projected total, and
   recording a payment warns if any are still unapproved. Employer-logged
   days are authoritative immediately; every entry keeps who logged it and
   when it was approved. In return, the helper approves payments (step 4) —
   each side signs off on what the other did.
4. **Payday**: Salary tab → check the statement → *Copy statement* (paste
   into WhatsApp if you like) → pay by FPS → *Record payment* with a
   screenshot → hand the phone to the helper → she taps
   *"I confirm I received this payment"* (optionally PIN-verified).
5. **Backups**: Settings → Export backup. Save the JSON to your cloud drive.
   The app reminds you every 3 weeks. The backup contains everything,
   including payment screenshots, and restores onto any device.

## Data & privacy

- `localStorage` — config, day logs, payments, adjustments
- `IndexedDB` — payment screenshots (auto-resized to ≤1400px JPEG)
- Nothing ever leaves the device. Backup/restore is a single JSON file.

## Roadmap

**Phase 1 — this app (single household, zero cost)**
Local-first PWA on one shared phone. Everything above, including multiple
helpers per household.

**Phase 1.5 — friends & family beta (current)**
Hosted on a public URL; each household's data stays on their own phone.
Collect feedback, fix the rough edges, validate that other employers'
agency arrangements fit the rule set (rest-day conventions vary).

**Phase 2 — two phones (helper's own device)**
Add a lightweight sync backend (Supabase/Firebase free tier): employer and
helper accounts, magic-link sign-in, realtime sync of logs and approvals,
screenshots in object storage. The engine and UI stay as-is; `store.js` is
the only layer that changes.

**Phase 3 — public product for HK employers (small fee)**
- Multi-tenant accounts + Stripe subscription (or one-off HK$ fee)
- Official statutory-holiday feed updated yearly server-side
- Bilingual/multilingual UI (English, Bahasa Indonesia, Tagalog, 中文)
- Contract features: annual leave accrual (7–14 days after 12 months),
  long-service/severance calculators, contract renewal reminders
- PDF salary receipts and Labour-Tribunal-ready payment history export
- Optional: employment-agency dashboard (many households per agency)

Phase 1 → 2 was designed for: the salary engine (`js/engine.js`) is pure and
fully unit-tested, storage is isolated behind `js/store.js`, and the UI never
touches persistence directly.

## Files

```
index.html            app shell
css/app.css           styles (light/dark, mobile-first)
js/engine.js          salary engine — pure functions, unit-tested
js/holidays.js        HK statutory holidays 2026+ (prefill data)
js/store.js           persistence: localStorage + IndexedDB + backup
js/app.js             UI: Today / Calendar / Salary / Settings
sw.js                 offline service worker
manifest.webmanifest  PWA manifest
tests/engine.test.js  engine tests (node tests/engine.test.js)
```
