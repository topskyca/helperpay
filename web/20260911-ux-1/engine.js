/* HelperPay — salary calculation engine.
 *
 * Pure functions, no DOM, no storage. Loaded as a classic <script> in the
 * browser (attaches to window.HSEngine) and require()-able in Node for tests.
 *
 * The monthly contract wage is the starting point for a complete month. The
 * monthly × 12 ÷ 365 rate remains visible only as a legacy reference rate for
 * projections; it is not described as a universal statutory formula. The
 * production compliance gate blocks any case that would rely on that rate
 * without an independently supported basis.
 *
 * Day model: every date has a type derived from config
 *   normal        — ordinary working day
 *   rest          — weekly rest day (pay terms are contractual)
 *   holiday       — statutory holiday
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
  const PayHistory = global.HSContractHistory || (typeof module !== 'undefined' ? require('./contract-history.js') : null);

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

  // Calendar months, clamped to the target month's last day (30 Nov + 3 → 28/29 Feb).
  function addMonths(s, n) {
    const p = parseYmd(s);
    const total = p.m - 1 + n;
    const y = p.y + Math.floor(total / 12);
    const m = (total % 12 + 12) % 12 + 1;
    return ymd(y, m, Math.min(p.d, daysInMonth(y, m)));
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
      // The weekly pattern applies from employment start. This is checked as
      // a rolling seven-day requirement by the production compliance gate.
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
    const end = [config.endDate, config.contractEndDate].filter(Boolean).sort()[0];
    if (end && dateStr > end) return false;
    return true;
  }

  // Statutory holiday PAY is only an entitlement after 3 months of continuous
  // employment (FDH Practical Guide Q4.5). The day off itself applies from
  // day one regardless.
  function inFirstThreeMonths(dateStr, config) {
    return !!config.startDate && dateStr < addMonths(config.startDate, 3);
  }

  // ---------- monthly statement ----------

  /**
   * logs: { 'YYYY-MM-DD': { work: 1|0.5|0, note?: string } }
   * Returns null if the helper was not employed at all during the month.
   */
  function computeMonth(year, month, config, logs) {
    logs = logs || {};
    const dim = daysInMonth(year, month);
    const monthStart = ymd(year, month, 1);
    const monthEnd = ymd(year, month, dim);

    if (config.startDate && config.startDate > monthEnd) return null;
    const employmentEnd = [config.endDate, config.contractEndDate].filter(Boolean).sort()[0];
    if (employmentEnd && employmentEnd < monthStart) return null;

    const start = config.startDate && config.startDate > monthStart ? config.startDate : monthStart;
    const end = employmentEnd && employmentEnd < monthEnd ? employmentEnd : monthEnd;
    const payTerms = PayHistory.resolve(config, start, end);
    const monthlyWage = Number(payTerms.monthlyWage);
    const dw = dailyWage(monthlyWage);
    const partial = start !== monthStart || end !== monthEnd;
    const periodDays = parseYmd(end).d - parseYmd(start).d + 1;

    // Partial month (started or ended mid-month): base pay is calendar days
    // in the employment period × exact daily wage. Full month: the monthly wage.
    const base = partial ? periodDays * dw : monthlyWage;

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
            date: ds, kind: 'deduction', days: missed, amount: missed * dw,
            label: missed === 1 ? 'Full-day leave' : 'Half-day leave',
            note: (entry && entry.note) || '',
            pending: pending, by: (entry && entry.by) || ''
          });
        }
      } else if (work > 0) {
        // Cash for rest-day work is never invented. It appears only when the
        // parties explicitly record an agreed per-day amount. Statutory-
        // holiday work always requires a compliant alternative holiday;
        // optional goodwill pay is also an explicit amount.
        const restPayment = cls.isRest && config.restDayWorkArrangement === 'agreed_payment'
          ? Number(config.restDayWorkPayment) || 0 : 0;
        const holidayPayment = cls.holiday ? Number(config.holidayWorkBonusAmount) || 0 : 0;
        const paymentPerDay = restPayment + holidayPayment;
        if (paymentPerDay <= 0) {
          lines.push({
            date: ds, kind: cls.holiday ? 'holiday-worked' : 'rest-day-worked', days: work, amount: 0,
            label: describeType(cls) + ' — worked (agreed time-off arrangement; no cash added)',
            note: (entry && entry.note) || '',
            pending: pending, by: (entry && entry.by) || ''
          });
        } else {
          allowanceDays += work;
          lines.push({
            date: ds, kind: 'allowance', days: work, amount: work * paymentPerDay,
            label: describeType(cls) + ' — worked' + (work === 0.5 ? ' half day' : ''),
            note: (entry && entry.note) || '',
            pending: pending, by: (entry && entry.by) || ''
          });
        }
      }
    }

    const deduction = deductionDays * dw;
    const allowance = lines.filter(line => line.kind === 'allowance')
      .reduce((sum, line) => sum + line.amount, 0);
    const foodMonthly = payTerms.foodMode === 'provided' ? 0 : (Number(payTerms.foodAllowance) || 0);
    const food = foodMonthly * (partial ? periodDays / dim : 1);
    const totalExact = base - deduction + allowance + food;
    const acceptedDeduction = lines.filter(line => line.kind === 'deduction' && !line.pending)
      .reduce((sum, line) => sum + line.amount, 0);
    const acceptedAllowance = lines.filter(line => line.kind === 'allowance' && !line.pending)
      .reduce((sum, line) => sum + line.amount, 0);
    const acceptedTotalExact = base - acceptedDeduction + acceptedAllowance + food;

    return {
      year, month, key: monthKey(year, month),
      periodStart: start, periodEnd: end, partial, periodDays,
      monthlyWage, payTerms, estimateUnavailable: payTerms.issue || null,
      dailyWage: payTerms.issue ? null : dw,
      base: payTerms.issue ? null : base, deductionDays, deduction, allowanceDays, allowance,
      food: payTerms.issue ? null : food, totalExact: payTerms.issue ? null : totalExact,
      acceptedTotalExact: payTerms.issue ? null : acceptedTotalExact,
      total: payTerms.issue ? null : round2(totalExact),
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
      if (!cls.holiday || !(cls.holiday.type === 'statutory_holiday' || cls.holiday.officialId)) return;
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
        arrangementType: scheduled ? scheduled.type || null : null,
        noticeAt: scheduled ? scheduled.noticeAt || null : null,
        workStartsAt: scheduled ? scheduled.workStartsAt || null : null,
        alternativeDate: scheduled ? scheduled.alternativeDate || null : null,
        mutualAgreement: scheduled ? scheduled.mutualAgreement === true : false,
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

  // A rest+holiday date is satisfied only by an explicit linked collision
  // holiday. A nearby unrelated holiday never fulfils the obligation.
  function needsRestDaySubstitute(config, dateStr) {
    const cls = classifyDay(dateStr, config);
    if (cls.type !== 'rest+holiday' ||
        !(cls.holiday.type === 'statutory_holiday' || cls.holiday.officialId)) return false;
    return !(config.holidays || []).some(h =>
      h.type === 'rest_day_collision_holiday' && h.collisionFor === dateStr);
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
    if (stmt.estimateUnavailable) return 'No salary estimate for ' + stmt.key + ': effective-dated wage / food terms need review. Use the official calculator; payments remain separate facts.';
    extras = extras || {};
    const L = [];
    const monthName = new Date(stmt.year, stmt.month - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    L.push('Salary statement — ' + monthName);
    if (config.helperName) L.push('Helper: ' + config.helperName);
    L.push('Period: ' + stmt.periodStart + ' to ' + stmt.periodEnd);
    L.push('Reference rate only (not universal): ' + fmtMoney(stmt.monthlyWage ?? config.monthlyWage) + ' × 12 ÷ 365 = HK$' + stmt.dailyWage.toFixed(4));
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
      ded.forEach(l => L.push('  ' + l.date + '  ' + l.label + '  −' + fmtMoney(l.amount) +
        (l.pending ? '  (pending approval)' : '')));
    }
    if (alw.length) {
      L.push('');
      L.push('Extra work on rest days / holidays (+' + stmt.allowanceDays + ' day' + (stmt.allowanceDays === 1 ? '' : 's') + '):');
      alw.forEach(l => L.push('  ' + l.date + '  ' + l.label + '  +' + fmtMoney(l.amount) +
        (l.pending ? '  (pending approval)' : '')));
    }
    const info = stmt.lines.filter(l => l.kind === 'holiday-worked' || l.kind === 'rest-day-worked');
    if (info.length) {
      L.push('');
      L.push('Rest/statutory holidays worked (agreed arrangement required; no automatic cash):');
      info.forEach(l => L.push('  ' + l.date + '  ' + l.label));
    }
    if (extras.adjustments && extras.adjustments.length) {
      L.push('');
      L.push('Voluntary payments:');
      extras.adjustments.forEach(a => L.push('  ' + a.label + ': ' + (a.amount >= 0 ? '+' : '') + fmtMoney(a.amount)));
    }
    L.push('');
    let due = stmt.totalExact;
    (extras.adjustments || []).forEach(a => { due += a.amount; });
    L.push('REFERENCE ESTIMATE: ' + fmtMoney(due));
    if (extras.paid) {
      L.push('Paid so far: ' + fmtMoney(extras.paid));
      L.push('Balance: ' + fmtMoney(due - extras.paid));
    }
    return L.join('\n');
  }

  const api = {
    ymd, parseYmd, weekdayOf, daysInMonth, addDays, addMonths, todayStr, monthKey,
    round2, dailyWage,
    classifyDay, defaultWork, describeType, isEmployedOn, inFirstThreeMonths,
    computeMonth, owedAlternativeHolidays, nextFreeDay, needsRestDaySubstitute,
    statementText, fmtMoney, fmtDays
  };

  global.HSEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
