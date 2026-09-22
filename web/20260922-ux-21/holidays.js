/* HelperPay — official Hong Kong statutory-holiday reference data.
 *
 * Only calendars published by the Labour Department are eligible for a
 * finalised statement. Alternative, substituted and rest-day-collision
 * holidays are separate user records; they are never inferred from a nearby
 * public holiday.
 */
(function (global) {
  'use strict';

  const Legal = global.HSLegalModel ||
    (typeof module !== 'undefined' && module.exports ? require('./legal-model.js') : null);
  const CALENDAR_VERSION = 'hk-statutory-2026-2027-official-v1';

  function calendarFor(year, winterChoice) {
    if (!Legal) return [];
    return Legal.statutoryCalendar(year, winterChoice || 'christmas').map(day => ({
      date: day.date,
      name: day.name,
      type: 'statutory_holiday',
      officialId: year + ':' + day.id,
      source: day.source,
      calendarVersion: CALENDAR_VERSION
    }));
  }

  const HK_STATUTORY_HOLIDAYS = {
    2026: calendarFor(2026, 'christmas'),
    2027: calendarFor(2027, 'christmas')
  };

  function defaultHolidays(winterChoice) {
    const out = calendarFor(2026, winterChoice || 'christmas')
      .concat(calendarFor(2027, winterChoice || 'christmas'));
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
    CALENDAR_VERSION, HK_STATUTORY_HOLIDAYS, calendarFor, defaultHolidays,
    GOV_FEED_URL, GOV_ARCHIVE_API,
    isStatutorySummary, parseGovFeed, mergeHolidays
  };
  global.HSHolidays = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
