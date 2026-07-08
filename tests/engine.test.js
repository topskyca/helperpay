/* Engine tests — run with:  node tests/engine.test.js
 *
 * The May/June 2026 cases reproduce the real payroll verification document
 * (helper started 8 May 2026, HK$5,100/month) and must match its numbers:
 *   May 2026  = HK$4,694.79
 *   June 2026 = HK$5,351.51
 */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');
const H = require('../js/holidays.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}
function approx(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) < (eps || 1e-6),
    'expected ' + expected + ', got ' + actual);
}

const baseConfig = {
  helperName: 'Helper',
  monthlyWage: 5100,
  foodAllowance: 0,
  startDate: '2026-05-08',
  restDayWeekday: 0, // Sunday
  restDayOverrides: {},
  holidays: H.defaultHolidays()
};

console.log('# daily wage');
test('daily wage = 5100 × 12 ÷ 365 = 167.6712328767…', () => {
  approx(E.dailyWage(5100), 167.6712328767, 1e-9);
});

console.log('# day classification');
test('24 May 2026 is rest day + statutory holiday (counted once)', () => {
  const cls = E.classifyDay('2026-05-24', baseConfig);
  assert.strictEqual(cls.type, 'rest+holiday');
});
test('25 May 2026 is the substitute holiday', () => {
  const cls = E.classifyDay('2026-05-25', baseConfig);
  assert.strictEqual(cls.type, 'holiday');
  assert.ok(cls.holiday.substitute);
});

console.log('# 7-day rule: one rest day per 7 days served — none in the first week');
test('10 May 2026 (2 days after start) is automatically a working day', () => {
  // started Fri 8 May → first 7 days are 8–14 May → Sunday 10 May not a rest day
  assert.strictEqual(E.classifyDay('2026-05-10', baseConfig).type, 'normal');
});
test('17 May 2026 (after first 7 days) is the first rest day', () => {
  assert.strictEqual(E.classifyDay('2026-05-17', baseConfig).type, 'rest');
});
test('boundary: Sunday exactly 7 days after a Monday start is still in the first week', () => {
  const cfg = Object.assign({}, baseConfig, { startDate: '2026-05-04' }); // Monday
  assert.strictEqual(E.classifyDay('2026-05-10', cfg).type, 'normal'); // day 7
  assert.strictEqual(E.classifyDay('2026-05-11', cfg).type, 'normal'); // ordinary Monday
  assert.strictEqual(E.classifyDay('2026-05-17', cfg).type, 'rest');
});
test('the rule can be disabled in settings (firstWeekNoRestDay: false)', () => {
  const cfg = Object.assign({}, baseConfig, { firstWeekNoRestDay: false });
  assert.strictEqual(E.classifyDay('2026-05-10', cfg).type, 'rest');
});
test('a per-date override always wins over the 7-day rule', () => {
  const cfg = Object.assign({}, baseConfig, { restDayOverrides: { '2026-05-10': true } });
  assert.strictEqual(E.classifyDay('2026-05-10', cfg).type, 'rest');
});
test('a per-date override can also remove a rest day (agency change)', () => {
  const cfg = Object.assign({}, baseConfig, { restDayOverrides: { '2026-08-02': false } });
  assert.strictEqual(E.classifyDay('2026-08-02', cfg).type, 'normal');
  assert.strictEqual(E.classifyDay('2026-08-02', baseConfig).type, 'rest');
});

console.log('# May 2026 — partial first month (started 8 May)');
test('May 2026 statement matches verified payroll: HK$4,694.79 (no manual override needed)', () => {
  // Agency-confirmed rest days 17/24/31 May; 10 May excluded by the 7-day rule.
  const cfg = baseConfig;
  const logs = {
    '2026-05-17': { work: 1 },  // rest day worked
    '2026-05-24': { work: 1 },  // rest day + Buddha's Birthday worked (counts once)
    '2026-05-25': { work: 1 },  // substitute holiday worked
    '2026-05-31': { work: 1 }   // rest day worked
  };
  const s = E.computeMonth(2026, 5, cfg, logs);
  assert.strictEqual(s.partial, true);
  assert.strictEqual(s.periodDays, 24);
  approx(s.base, 4024.1095890411, 1e-6);
  assert.strictEqual(s.allowanceDays, 4);
  assert.strictEqual(s.deductionDays, 0);
  assert.strictEqual(s.total, 4694.79);
});

console.log('# June 2026 — full month with leave and holiday work');
test('June 2026 statement matches verified payroll: HK$5,351.51', () => {
  const logs = {
    '2026-06-01': { work: 0.5 }, // Monday: half-day ordinary leave → −0.5
    '2026-06-07': { work: 0.5 }, // Sunday rest: worked half → +0.5 (NOT unpaid leave)
    '2026-06-14': { work: 0.5 }, // Sunday rest: worked half → +0.5
    '2026-06-19': { work: 1 },   // Tuen Ng statutory holiday worked → +1
    // 21 June: rest day taken — unlogged default; must NOT offset 19 June
    '2026-06-26': { work: 0 },   // Friday: full-day ordinary leave → −1
    '2026-06-28': { work: 1 }    // Sunday rest: worked → +1
  };
  const s = E.computeMonth(2026, 6, baseConfig, logs);
  assert.strictEqual(s.partial, false);
  assert.strictEqual(s.base, 5100);
  assert.strictEqual(s.deductionDays, 1.5);
  assert.strictEqual(s.allowanceDays, 3);
  assert.strictEqual(s.total, 5351.51);
});

console.log('# document cross-check');
test('net adjustment vs old spreadsheets = HK$430.33', () => {
  const may = 4694.79 - 4770.97;   // −76.18 (May was over-paid)
  const june = 5351.51 - 4845.00;  // +506.51 (June was under-paid)
  approx(E.round2(may + june), 430.33, 1e-9);
});

console.log('# general behaviour');
test('untouched full month = exactly the monthly wage', () => {
  const s = E.computeMonth(2026, 8, baseConfig, {});
  assert.strictEqual(s.total, 5100);
});
test('rest day taken is never a deduction', () => {
  const logs = { '2026-08-02': { work: 0 } }; // Sunday, explicitly logged off
  const s = E.computeMonth(2026, 8, baseConfig, logs);
  assert.strictEqual(s.deductionDays, 0);
  assert.strictEqual(s.total, 5100);
});
test('statutory holiday taken is never a deduction', () => {
  const logs = { '2026-07-01': { work: 0 } };
  const s = E.computeMonth(2026, 7, baseConfig, logs);
  assert.strictEqual(s.deductionDays, 0);
});
test('food allowance added in full months, pro-rated in partial months', () => {
  const cfg = Object.assign({}, baseConfig, { foodAllowance: 1236 });
  const full = E.computeMonth(2026, 8, cfg, {});
  approx(full.totalExact, 5100 + 1236);
  const partial = E.computeMonth(2026, 5, cfg, {});
  approx(partial.food, 1236 * 24 / 31, 1e-9);
});
test('month before employment start returns null', () => {
  assert.strictEqual(E.computeMonth(2026, 4, baseConfig, {}), null);
});
test('end date cuts the period (final partial month)', () => {
  const cfg = Object.assign({}, baseConfig, { endDate: '2026-08-15' });
  const s = E.computeMonth(2026, 8, cfg, {});
  assert.strictEqual(s.partial, true);
  assert.strictEqual(s.periodDays, 15);
  assert.strictEqual(E.computeMonth(2026, 9, cfg, {}), null);
});
test('leave on a 7-day-rule working Sunday is deducted like any working day', () => {
  // helper takes off the first-week Sunday (10 May) → ordinary unpaid leave
  const logs = { '2026-05-10': { work: 0 } };
  const s = E.computeMonth(2026, 5, baseConfig, logs);
  assert.strictEqual(s.deductionDays, 1);
});
test('February has the right number of days (2027 non-leap)', () => {
  assert.strictEqual(E.daysInMonth(2027, 2), 28);
  assert.strictEqual(E.daysInMonth(2028, 2), 29);
  const s = E.computeMonth(2027, 2, baseConfig, {});
  assert.strictEqual(s.periodDays, 28);
  assert.strictEqual(s.total, 5100);
});
test('working a rest day twice in a month accumulates correctly', () => {
  const logs = { '2026-08-02': { work: 1 }, '2026-08-09': { work: 0.5 } };
  const s = E.computeMonth(2026, 8, baseConfig, logs);
  assert.strictEqual(s.allowanceDays, 1.5);
  assert.strictEqual(s.total, E.round2(5100 + 1.5 * E.dailyWage(5100)));
});
test('statement text contains the total and never crashes', () => {
  const s = E.computeMonth(2026, 6, baseConfig, { '2026-06-19': { work: 1 } });
  const text = E.statementText(s, baseConfig, { adjustments: [{ label: 'test', amount: -10 }], paid: 100 });
  assert.ok(text.includes('TOTAL DUE'));
  assert.ok(text.includes('Tuen Ng'));
  assert.ok(text.includes('Balance'));
});
test('money formatting', () => {
  assert.strictEqual(E.fmtMoney(4694.7945), 'HK$4,694.79');
  assert.strictEqual(E.fmtMoney(-76.18), '-HK$76.18');
  assert.strictEqual(E.fmtMoney(0), 'HK$0.00');
});

console.log('# gov holiday feed — statutory filter (Employment (Amendment) Ordinance 2021 phase-in)');
test('Good Friday family excluded until phase-in years', () => {
  assert.strictEqual(H.isStatutorySummary('Good Friday', 2026), false);
  assert.strictEqual(H.isStatutorySummary('Good Friday', 2028), true);
  assert.strictEqual(H.isStatutorySummary('The day following Good Friday', 2028), false);
  assert.strictEqual(H.isStatutorySummary('The day following Good Friday', 2030), true);
  assert.strictEqual(H.isStatutorySummary('Easter Monday', 2025), false);
  assert.strictEqual(H.isStatutorySummary('Easter Monday', 2026), true);
  assert.strictEqual(H.isStatutorySummary('The day following Easter Monday', 2026), true);
});
test('statutory names match with either apostrophe style and "day following" variants', () => {
  assert.ok(H.isStatutorySummary('Lunar New Year’s Day', 2026));      // curly (2026 feed)
  assert.ok(H.isStatutorySummary("Lunar New Year's Day", 2027));           // straight (2027 feed)
  assert.ok(H.isStatutorySummary('The fourth day of Lunar New Year', 2027));
  assert.ok(H.isStatutorySummary('The day following the Birthday of the Buddha', 2026));
  assert.ok(H.isStatutorySummary('The day following Chung Yeung Festival', 2026));
  assert.ok(H.isStatutorySummary('The first weekday after Christmas Day', 2026));
  assert.ok(!H.isStatutorySummary('The second day of Some Made Up Festival', 2026));
});
test('parseGovFeed handles the real BOM-prefixed format and filters correctly', () => {
  const feed = '﻿' + JSON.stringify({
    vcalendar: [{
      vevent: [
        { dtstart: ['20260403', { value: 'DATE' }], summary: 'Good Friday' },
        { dtstart: ['20260404', { value: 'DATE' }], summary: 'The day following Good Friday' },
        { dtstart: ['20260619', { value: 'DATE' }], summary: 'Tuen Ng Festival' },
        { dtstart: ['20270513', { value: 'DATE' }], summary: 'The Birthday of the Buddha' },
        { dtstart: ['20280414', { value: 'DATE' }], summary: 'Good Friday' }
      ]
    }]
  });
  const out = H.parseGovFeed(feed);
  assert.deepStrictEqual(out.map(h => h.date), ['2026-06-19', '2027-05-13', '2028-04-14']);
  assert.strictEqual(out[0].name, 'Tuen Ng Festival');
});
test('mergeHolidays is add-only by date: user entries never overwritten, no duplicates', () => {
  const existing = [
    { date: '2026-06-19', name: 'Tuen Ng Festival' },
    { date: '2026-05-25', name: "Substitute — Buddha's Birthday (fell on Sunday)", substitute: true }
  ];
  const incoming = [
    { date: '2026-06-19', name: 'Tuen Ng Festival (gov name)' },     // duplicate date → skipped
    { date: '2026-05-25', name: 'The day following the Birthday of the Buddha' }, // duplicate → skipped
    { date: '2027-05-13', name: 'The Birthday of the Buddha' }       // new → added
  ];
  const res = H.mergeHolidays(existing, incoming);
  assert.strictEqual(res.added, 1);
  assert.strictEqual(res.holidays.length, 3);
  assert.strictEqual(res.holidays.find(h => h.date === '2026-06-19').name, 'Tuen Ng Festival');
  assert.strictEqual(res.holidays.find(h => h.date === '2027-05-13').source, 'gov');
  // sorted by date
  const dates = res.holidays.map(h => h.date);
  assert.deepStrictEqual(dates, dates.slice().sort());
});
test('mergeHolidays minDate drops holidays before employment start', () => {
  const incoming = [
    { date: '2025-12-25', name: 'Christmas Day' },       // before start → dropped
    { date: '2026-06-19', name: 'Tuen Ng Festival' }     // after start → added
  ];
  const res = H.mergeHolidays([], incoming, '2026-05-08');
  assert.strictEqual(res.added, 1);
  assert.strictEqual(res.holidays[0].date, '2026-06-19');
});
console.log('# two-way approval: helper-logged days pending until employer approves');
test('pending helper logs flow through to statement lines and pendingCount', () => {
  const logs = {
    '2026-06-19': { work: 1, by: 'helper', status: 'pending' },   // holiday worked, unapproved
    '2026-06-26': { work: 0, by: 'employer', status: 'approved' } // leave, approved
  };
  const s = E.computeMonth(2026, 6, baseConfig, logs);
  assert.strictEqual(s.pendingCount, 1);
  const holiday = s.lines.find(l => l.date === '2026-06-19');
  const leave = s.lines.find(l => l.date === '2026-06-26');
  assert.strictEqual(holiday.pending, true);
  assert.strictEqual(holiday.by, 'helper');
  assert.strictEqual(leave.pending, false);
});
test('pending logs still count in the total (flagged, not excluded)', () => {
  const logs = { '2026-06-19': { work: 1, by: 'helper', status: 'pending' } };
  const s = E.computeMonth(2026, 6, baseConfig, logs);
  assert.strictEqual(s.allowanceDays, 1);
  assert.strictEqual(s.total, E.round2(5100 + E.dailyWage(5100)));
});
test('legacy entries without status count as approved (no pending flag)', () => {
  const logs = { '2026-06-19': { work: 1 } };
  const s = E.computeMonth(2026, 6, baseConfig, logs);
  assert.strictEqual(s.pendingCount, 0);
  assert.strictEqual(s.lines[0].pending, false);
});
test('statement text marks pending lines', () => {
  const logs = {
    '2026-06-19': { work: 1, by: 'helper', status: 'pending' },
    '2026-06-26': { work: 0 }
  };
  const s = E.computeMonth(2026, 6, baseConfig, logs);
  const text = E.statementText(s, baseConfig, {});
  assert.ok(text.includes('Tuen Ng Festival — worked  +HK$167.67  (pending approval)'));
  assert.ok(!text.includes('Full-day leave  −HK$167.67  (pending'));
});

console.log('# alternative day off owed for statutory-holiday work (EO: no payment in lieu)');
test('a worked statutory holiday owes an alternative day off within 60 days', () => {
  const logs = { '2026-06-19': { work: 1 } }; // Tuen Ng worked
  const owed = E.owedAlternativeHolidays(baseConfig, logs, '2026-07-08');
  assert.strictEqual(owed.length, 1);
  assert.strictEqual(owed[0].date, '2026-06-19');
  assert.strictEqual(owed[0].deadline, '2026-08-18'); // +60 days
  assert.strictEqual(owed[0].scheduled, null);
  assert.strictEqual(owed[0].overdue, false);
});
test('overdue when 60 days pass without a scheduled alternative', () => {
  const logs = { '2026-06-19': { work: 1 } };
  const owed = E.owedAlternativeHolidays(baseConfig, logs, '2026-08-19');
  assert.strictEqual(owed[0].overdue, true);
});
test('an altFor entry in the holidays list satisfies the obligation', () => {
  const cfg = Object.assign({}, baseConfig, {
    holidays: baseConfig.holidays.concat({
      date: '2026-07-03', name: 'Day off in lieu — Tuen Ng Festival (19 Jun)', altFor: '2026-06-19'
    })
  });
  const logs = { '2026-06-19': { work: 1 } };
  const owed = E.owedAlternativeHolidays(cfg, logs, '2026-09-01');
  assert.strictEqual(owed[0].scheduled, '2026-07-03');
  assert.strictEqual(owed[0].overdue, false);
  // and the day off in lieu itself is a paid holiday: taking it costs nothing
  const july = E.computeMonth(2026, 7, cfg, {});
  assert.strictEqual(july.total, 5100);
});
test('a holiday taken (not worked) owes nothing', () => {
  const logs = { '2026-06-19': { work: 0 } };
  assert.strictEqual(E.owedAlternativeHolidays(baseConfig, logs).length, 0);
});
test('working the day off in lieu flags it as owed again', () => {
  const cfg = Object.assign({}, baseConfig, {
    holidays: baseConfig.holidays.concat({
      date: '2026-07-03', name: 'Day off in lieu — Tuen Ng Festival (19 Jun)', altFor: '2026-06-19'
    })
  });
  const logs = { '2026-06-19': { work: 1 }, '2026-07-03': { work: 1 } };
  const owed = E.owedAlternativeHolidays(cfg, logs, '2026-07-08');
  assert.strictEqual(owed.length, 2);
  const second = owed.find(o => o.date === '2026-07-03');
  assert.strictEqual(second.scheduled, null);
});

test('a synced substitute day is a plain holiday for the engine', () => {
  const cfg = Object.assign({}, baseConfig, {
    holidays: [{ date: '2026-05-25', name: 'The day following the Birthday of the Buddha', source: 'gov' }]
  });
  const cls = E.classifyDay('2026-05-25', cfg);
  assert.strictEqual(cls.type, 'holiday');
  const s = E.computeMonth(2026, 5, cfg, { '2026-05-25': { work: 1 } });
  assert.strictEqual(s.allowanceDays, 1);
});

console.log('\n' + passed + ' tests passed');
