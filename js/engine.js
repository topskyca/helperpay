/* HelperPay — salary calculation engine.
 *
 * Pure functions, no DOM, no storage. Loaded as a classic <script> in the
 * browser (attaches to window.HSEngine) and require()-able in Node for tests.
 *
 * Money rule: keep the daily wage exact (monthly × 12 ÷ 365) through every
 * intermediate step and round only the final total to 2 decimals — this is
 * the Labour Department daily-rate convention for HK domestic helpers.
 *
 * Day model: every date has a type derived from config
 *   normal        — ordinary working day
 *   rest          — weekly rest day (paid; working it earns extra pay)
 *   holiday       — statutory holiday (paid; working it earns extra pay)
 *   rest+holiday  — both on the same date (counts once, never twice)
 * and a logged "work" amount: 1 (full day), 0.5 (half day), 0 (did not work).
 * Unlogged days use the default: normal → worked, rest/holiday → not worked,
 * so only exceptions ever need to be logged.
 *
 * Salary effect per day:
 *   normal day:            deduct (1 − work) days   (ordinary unpaid leave)
 *   rest / holiday day:    add work days            (extra-work allowance)
 * A rest day is never treated as unpaid leave, and a rest day never offsets
 * a statutory holiday — each date stands on its own.
 */
(function (global) {
  'use strict';

  // ---------- date helpers (dates are 'YYYY-MM-DD' strings everywhere) ----------

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

  function parseYmd(s) {
    const p = String(s).split('-');
    return { y: +p[0], m: +p[1], d: +p[2] };
  }

  // 0 = Sunday … 6 = Saturday
  function weekdayOf(s) {
    const p = parseYmd(s);
    return new Date(p.y, p.m - 1, p.d).getDay();
  }

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  function addDays(s, n) {
    const p = parseYmd(s);
    const dt = new Date(p.y, p.m - 1, p.d + n);
    return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }

  function todayStr() {
    const t = new Date();
    return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }

  function monthKey(y, m) { return y + '-' + pad2(m); }

  // ---------- money ----------

  function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

  function dailyWage(monthlyWage) { return monthlyWage * 12 / 365; }

  // ---------- day classification ----------

  /**
   * config: {
   *   monthlyWage, foodAllowance, startDate, endDate?,
   *   restDayWeekday (0=Sun), restDayOverrides { 'YYYY-MM-DD': true|false },
   *   holidays [{ date, name, substitute? }]
   * }
   */
  function classifyDay(dateStr, config) {
    let holiday = null;
    const hs = config.holidays || [];
    for (let i = 0; i < hs.length; i++) {
      if (hs[i].date === dateStr) { holiday = hs[i]; break; }
    }
    const ov = config.restDayOverrides ? config.restDayOverrides[dateStr] : undefined;
    const restWd = config.restDayWeekday == null ? 0 : config.restDayWeekday;
    let isRest;
    if (ov !== undefined) {
      isRest = !!ov;
    } else {
      isRest = weekdayOf(dateStr) === restWd;
      // One rest day per 7 days served: no weekly rest day until the helper
      // has completed her first 7 days (the agency convention — e.g. started
      // Fri 8 May 2026 → 10 May was a working Sunday; first rest day 17 May).
      // Default on; disable in Settings. A per-date override always wins.
      if (isRest && config.firstWeekNoRestDay !== false && config.startDate &&
          dateStr < addDays(config.startDate, 7)) {
        isRest = false;
      }
    }
    const type = holiday && isRest ? 'rest+holiday'
      : holiday ? 'holiday'
      : isRest ? 'rest'
      : 'normal';
    return { isRest, holiday, type };
  }

  // How much of the day the helper is assumed to work when nothing is logged.
  function defaultWork(type) { return type === 'normal' ? 1 : 0; }

  function describeType(cls) {
    if (cls.type === 'rest+holiday') return 'Rest day + ' + cls.holiday.name;
    if (cls.type === 'holiday') return cls.holiday.name;
    if (cls.type === 'rest') return 'Rest day';
    return 'Working day';
  }

  function isEmployedOn(dateStr, config) {
    if (config.startDate && dateStr < config.startDate) return false;
    if (config.endDate && dateStr > config.endDate) return false;
    return true;
  }

  // ---------- monthly statement ----------

  /**
   * logs: { 'YYYY-MM-DD': { work: 1|0.5|0, note?: string } }
   * Returns null if the helper was not employed at all during the month.
   */
  function computeMonth(year, month, config, logs) {
    logs = logs || {};
    const dw = dailyWage(config.monthlyWage);
    const dim = daysInMonth(year, month);
    const monthStart = ymd(year, month, 1);
    const monthEnd = ymd(year, month, dim);

    if (config.startDate && config.startDate > monthEnd) return null;
    if (config.endDate && config.endDate < monthStart) return null;

    const start = config.startDate && config.startDate > monthStart ? config.startDate : monthStart;
    const end = config.endDate && config.endDate < monthEnd ? config.endDate : monthEnd;
    const partial = start !== monthStart || end !== monthEnd;
    const periodDays = parseYmd(end).d - parseYmd(start).d + 1;

    // Partial month (started or ended mid-month): base pay is calendar days
    // in the employment period × exact daily wage. Full month: the monthly wage.
    const base = partial ? periodDays * dw : config.monthlyWage;

    let deductionDays = 0;
    let allowanceDays = 0;
    const lines = [];

    for (let d = parseYmd(start).d; d <= parseYmd(end).d; d++) {
      const ds = ymd(year, month, d);
      const cls = classifyDay(ds, config);
      const entry = logs[ds];
      const work = entry && typeof entry.work === 'number' ? entry.work : defaultWork(cls.type);

      // helper-logged entries stay "pending" until the employer approves them
      const pending = !!(entry && entry.status === 'pending');

      if (cls.type === 'normal') {
        const missed = 1 - work;
        if (missed > 0) {
          deductionDays += missed;
          lines.push({
            date: ds, kind: 'deduction', days: missed,
            label: missed === 1 ? 'Full-day leave' : 'Half-day leave',
            note: (entry && entry.note) || '',
            pending: pending, by: (entry && entry.by) || ''
          });
        }
      } else if (work > 0) {
        // rest, holiday, or rest+holiday — a worked day may earn extra pay, once.
        // The statutory-holiday work bonus is OPTIONAL (config.holidayWorkBonus):
        // by law a worked holiday is compensated with an alternative day off
        // (tracked by owedAlternativeHolidays), not cash — so the extra pay is
        // voluntary goodwill. New profiles default it OFF (legal minimum);
        // legacy configs created before the toggle have the field unset and
        // keep the bonus, so their past totals never change silently. Rest-day
        // work — including a rest day that is also a holiday — always earns the
        // bonus, since its lawful compensation is pay (or a substituted rest day).
        if (cls.type === 'holiday' && config.holidayWorkBonus === false) {
          lines.push({
            date: ds, kind: 'holiday-worked', days: 0,
            label: describeType(cls) + ' — worked (day off owed, no extra pay)',
            note: (entry && entry.note) || '',
            pending: pending, by: (entry && entry.by) || ''
          });
        } else {
          allowanceDays += work;
          lines.push({
            date: ds, kind: 'allowance', days: work,
            label: describeType(cls) + ' — worked' + (work === 0.5 ? ' half day' : ''),
            note: (entry && entry.note) || '',
            pending: pending, by: (entry && entry.by) || ''
          });
        }
      }
    }

    const deduction = deductionDays * dw;
    const allowance = allowanceDays * dw;
    const food = (config.foodAllowance || 0) * (partial ? periodDays / dim : 1);
    const totalExact = base - deduction + allowance + food;

    return {
      year, month, key: monthKey(year, month),
      periodStart: start, periodEnd: end, partial, periodDays,
      dailyWage: dw,
      base, deductionDays, deduction, allowanceDays, allowance,
      food, totalExact,
      total: round2(totalExact),
      lines,
      pendingCount: lines.filter(l => l.pending).length
    };
  }

  // ---------- alternative day off tracking (statutory holiday worked) ----------

  /**
   * Labour Department rules (FAQ on Statutory Holidays): an employee may work
   * a statutory holiday (48h notice), but the employer MUST grant an
   * alternative holiday within 60 days before or after — any payment in lieu
   * is prohibited (fine HK$50,000). Extra pay on top is voluntary and legal.
   *
   * A worked holiday counts as "scheduled" when the holidays list contains an
   * entry with altFor === that date (single source of truth — deleting the
   * entry in Settings re-flags the day as owed).
   */
  function owedAlternativeHolidays(config, logs, asOf) {
    asOf = asOf || todayStr();
    const out = [];
    const hs = config.holidays || [];
    Object.keys(logs || {}).sort().forEach(ds => {
      const entry = logs[ds];
      if (!entry || !(entry.work > 0)) return;
      if (!isEmployedOn(ds, config)) return;
      const cls = classifyDay(ds, config);
      if (!cls.holiday) return;
      let scheduled = null;
      for (let i = 0; i < hs.length; i++) {
        if (hs[i].altFor === ds) { scheduled = hs[i]; break; }
      }
      const deadline = addDays(ds, 60);
      out.push({
        date: ds,
        name: cls.holiday.name,
        workedDays: entry.work,
        deadline: deadline,
        scheduled: scheduled ? scheduled.date : null,
        overdue: !scheduled && asOf > deadline
      });
    });
    return out;
  }

  // ---------- rest-day / statutory-holiday collision (FDH guide Q4.8) ----------

  // "If the statutory holiday falls on a rest day, a holiday should be granted
  // on the next day which is not a statutory holiday or an alternative/
  // substituted holiday or a rest day."
  function nextFreeDay(config, dateStr) {
    let d = addDays(dateStr, 1);
    for (let i = 0; i < 30; i++) { // hard stop; a free day always exists well before this
      if (classifyDay(d, config).type === 'normal') return d;
      d = addDays(d, 1);
    }
    return d;
  }

  // A rest+holiday date needs a substitute unless some holiday entry already
  // sits within the following 7 days (the prefilled/gov-synced substitutes all
  // do). Heuristic: dense real-holiday clusters can mask it, but errs quiet.
  function needsRestDaySubstitute(config, dateStr) {
    const cls = classifyDay(dateStr, config);
    if (cls.type !== 'rest+holiday') return false;
    const limit = addDays(dateStr, 7);
    return !(config.holidays || []).some(h => h.date > dateStr && h.date <= limit);
  }

  // ---------- plain-text statement (for WhatsApp / records) ----------

  function fmtMoney(x) {
    const v = round2(x);
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    const s = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sign + 'HK$' + s;
  }

  function fmtDays(d) {
    if (d === 0.5) return 'half day';
    if (d === 1) return '1 day';
    return d + ' days';
  }

  function statementText(stmt, config, extras) {
    extras = extras || {};
    const L = [];
    const monthName = new Date(stmt.year, stmt.month - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    L.push('Salary statement — ' + monthName);
    if (config.helperName) L.push('Helper: ' + config.helperName);
    L.push('Period: ' + stmt.periodStart + ' to ' + stmt.periodEnd);
    L.push('Daily wage: ' + fmtMoney(config.monthlyWage) + ' × 12 ÷ 365 = HK$' + stmt.dailyWage.toFixed(4));
    L.push('');
    L.push(stmt.partial
      ? 'Base pay (' + stmt.periodDays + ' days × daily wage): ' + fmtMoney(stmt.base)
      : 'Base pay (monthly wage): ' + fmtMoney(stmt.base));
    if (stmt.food > 0) L.push('Food allowance: ' + fmtMoney(stmt.food));
    const ded = stmt.lines.filter(l => l.kind === 'deduction');
    const alw = stmt.lines.filter(l => l.kind === 'allowance');
    if (ded.length) {
      L.push('');
      L.push('Leave deductions (−' + stmt.deductionDays + ' day' + (stmt.deductionDays === 1 ? '' : 's') + '):');
      ded.forEach(l => L.push('  ' + l.date + '  ' + l.label + '  −' + fmtMoney(l.days * stmt.dailyWage) +
        (l.pending ? '  (pending approval)' : '')));
    }
    if (alw.length) {
      L.push('');
      L.push('Extra work on rest days / holidays (+' + stmt.allowanceDays + ' day' + (stmt.allowanceDays === 1 ? '' : 's') + '):');
      alw.forEach(l => L.push('  ' + l.date + '  ' + l.label + '  +' + fmtMoney(l.days * stmt.dailyWage) +
        (l.pending ? '  (pending approval)' : '')));
    }
    const info = stmt.lines.filter(l => l.kind === 'holiday-worked');
    if (info.length) {
      L.push('');
      L.push('Statutory holidays worked (day off owed, no extra pay):');
      info.forEach(l => L.push('  ' + l.date + '  ' + l.label));
    }
    if (extras.adjustments && extras.adjustments.length) {
      L.push('');
      L.push('Adjustments:');
      extras.adjustments.forEach(a => L.push('  ' + a.label + ': ' + (a.amount >= 0 ? '+' : '') + fmtMoney(a.amount)));
    }
    L.push('');
    let due = stmt.totalExact;
    (extras.adjustments || []).forEach(a => { due += a.amount; });
    L.push('TOTAL DUE: ' + fmtMoney(due));
    if (extras.paid) {
      L.push('Paid so far: ' + fmtMoney(extras.paid));
      L.push('Balance: ' + fmtMoney(due - extras.paid));
    }
    return L.join('\n');
  }

  const api = {
    ymd, parseYmd, weekdayOf, daysInMonth, addDays, todayStr, monthKey,
    round2, dailyWage,
    classifyDay, defaultWork, describeType, isEmployedOn,
    computeMonth, owedAlternativeHolidays, nextFreeDay, needsRestDaySubstitute,
    statementText, fmtMoney, fmtDays
  };

  global.HSEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
