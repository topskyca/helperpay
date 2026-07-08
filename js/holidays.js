/* HelperPay — Hong Kong statutory holidays under the Employment Ordinance.
 *
 * 2026 has 15 statutory holidays (Easter Monday became statutory in 2026).
 * Source: Labour Department, "Statutory Holidays for 2026".
 *
 * Substitute entries: when a statutory holiday falls on the helper's weekly
 * rest day, the Employment Ordinance requires a substitute holiday on the
 * next day that is not itself a holiday or rest day. The entries below assume
 * a Sunday rest day (the default) — remove them in Settings if the helper's
 * rest day is a different weekday.
 *
 * Winter Solstice (22 Dec) vs Christmas Day (25 Dec) is the employer's option;
 * Christmas Day is prefilled. Swap it in Settings if you observe Winter Solstice.
 *
 * The whole list is editable in Settings — it is prefill data, not law.
 */
(function (global) {
  'use strict';

  const HK_STATUTORY_HOLIDAYS = {
    2026: [
      { date: '2026-01-01', name: "New Year's Day" },
      { date: '2026-02-17', name: 'Lunar New Year — Day 1' },
      { date: '2026-02-18', name: 'Lunar New Year — Day 2' },
      { date: '2026-02-19', name: 'Lunar New Year — Day 3' },
      { date: '2026-04-05', name: 'Ching Ming Festival' },
      { date: '2026-04-06', name: 'Easter Monday' },
      { date: '2026-04-07', name: 'Substitute — Ching Ming (fell on Sunday)', substitute: true },
      { date: '2026-05-01', name: 'Labour Day' },
      { date: '2026-05-24', name: "Buddha's Birthday" },
      { date: '2026-05-25', name: "Substitute — Buddha's Birthday (fell on Sunday)", substitute: true },
      { date: '2026-06-19', name: 'Tuen Ng Festival' },
      { date: '2026-07-01', name: 'HKSAR Establishment Day' },
      { date: '2026-09-26', name: 'Day after Mid-Autumn Festival' },
      { date: '2026-10-01', name: 'National Day' },
      { date: '2026-10-18', name: 'Chung Yeung Festival' },
      { date: '2026-10-19', name: 'Substitute — Chung Yeung (fell on Sunday)', substitute: true },
      { date: '2026-12-25', name: 'Christmas Day' },
      { date: '2026-12-26', name: 'First weekday after Christmas' }
    ],
    // 2027 lunar-calendar dates are published by the Labour Department each
    // year; add them in Settings when announced. Fixed dates prefilled:
    2027: [
      { date: '2027-01-01', name: "New Year's Day" },
      { date: '2027-05-01', name: 'Labour Day' },
      { date: '2027-07-01', name: 'HKSAR Establishment Day' },
      { date: '2027-10-01', name: 'National Day' },
      { date: '2027-12-25', name: 'Christmas Day' }
    ]
  };

  function defaultHolidays() {
    const out = [];
    Object.keys(HK_STATUTORY_HOLIDAYS).forEach(y => {
      HK_STATUTORY_HOLIDAYS[y].forEach(h => out.push(Object.assign({}, h)));
    });
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  }

  /* ---------- auto-sync from the HK Government 1823 calendar ----------
   *
   * The official machine-readable calendar (www.1823.gov.hk/common/ical/en.json,
   * published on data.gov.hk) lists GENERAL holidays. Statutory holidays under
   * the Employment Ordinance are a subset until 2030, so imported events are
   * filtered by name with year gates for the Employment (Amendment) Ordinance
   * 2021 phase-in: Easter Monday from 2026, Good Friday from 2028, the day
   * following Good Friday from 2030.
   *
   * The feed never lists a holiday on a Sunday — when one falls on Sunday it
   * lists the "day following" substitute instead. For a helper with Sunday
   * rest days (the default) these are exactly the operative paid-holiday
   * dates. For other rest-day weekdays, adjust manually in Settings.
   *
   * The direct 1823 URL sends no CORS headers, so the browser fetches the
   * latest archived copy through the CORS-enabled data.gov.hk historical
   * archive API instead.
   */

  const GOV_FEED_URL = 'https://www.1823.gov.hk/common/ical/en.json';
  const GOV_ARCHIVE_API = 'https://api.data.gov.hk/v1/historical-archive';

  // `summary` matching is deliberately loose ("Lunar New Year" also matches
  // "The fourth day of Lunar New Year", the substitute when a day falls on
  // Sunday; both curly and straight apostrophes appear in the feed).
  function isStatutorySummary(summary, year) {
    const s = String(summary);
    if (/day following Good Friday/i.test(s)) return year >= 2030;
    if (/Good Friday/i.test(s)) return year >= 2028;
    if (/Easter Monday/i.test(s)) return year >= 2026;
    return /first day of January|Lunar New Year|Ching Ming|Labour Day|Birthday of the Buddha|Tuen Ng|Special Administrative Region|Mid-Autumn|National Day|Chung Yeung|Christmas/i
      .test(s);
  }

  // Feed JSON (BOM-prefixed) -> [{date:'YYYY-MM-DD', name}] statutory only.
  function parseGovFeed(text) {
    const data = JSON.parse(String(text).replace(/^\uFEFF/, '')); // feed is BOM-prefixed
    const events = (data.vcalendar && data.vcalendar[0] && data.vcalendar[0].vevent) || [];
    const out = [];
    events.forEach(ev => {
      const raw = ev.dtstart && ev.dtstart[0];
      const name = ev.summary || '';
      if (!raw || String(raw).length < 8) return;
      const year = +String(raw).slice(0, 4);
      if (!isStatutorySummary(name, year)) return;
      out.push({
        date: String(raw).slice(0, 4) + '-' + String(raw).slice(4, 6) + '-' + String(raw).slice(6, 8),
        name: name
      });
    });
    return out;
  }

  // Add-only merge keyed by date: existing entries (including user edits and
  // deletions of specific names) are never overwritten. `minDate` (optional,
  // 'YYYY-MM-DD') drops incoming dates before it — holidays before the
  // employment start can never affect a statement.
  function mergeHolidays(existing, incoming, minDate) {
    const have = {};
    (existing || []).forEach(h => { have[h.date] = true; });
    const merged = (existing || []).slice();
    let added = 0;
    (incoming || []).forEach(h => {
      if (minDate && h.date < minDate) return;
      if (have[h.date]) return;
      have[h.date] = true;
      merged.push({ date: h.date, name: h.name, source: 'gov' });
      added++;
    });
    merged.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { holidays: merged, added };
  }

  const api = {
    HK_STATUTORY_HOLIDAYS, defaultHolidays,
    GOV_FEED_URL, GOV_ARCHIVE_API,
    isStatutorySummary, parseGovFeed, mergeHolidays
  };
  global.HSHolidays = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
