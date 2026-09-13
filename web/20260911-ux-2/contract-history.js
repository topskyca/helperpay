/* Effective-dated contractual terms. Pure data operations; no storage, payroll
 * approvals or statutory-average calculation is performed by this module. */
(function (global) {
  'use strict';
  const Legal = global.HSLegalModel || (typeof module !== 'undefined' ? require('./legal-model.js') : null);
  const copy = value => JSON.parse(JSON.stringify(value));
  const validDate = date => {
    try { return typeof date === 'string' && Legal.addDays(date, 0) === date; } catch { return false; }
  };
  const at = (periods, date) => (periods || []).filter(p => p.effectiveFrom <= date && p.effectiveTo >= date);
  const single = (periods, date) => { const found = at(periods, date); return found.length === 1 ? found[0] : null; };

  function rows(config) {
    if (!validDate(config.startDate) || !validDate(config.contractEndDate)) return [];
    const starts = new Set([config.startDate]);
    for (const period of [...(config.wagePeriods || []), ...(config.foodTerms || [])]) {
      if (validDate(period.effectiveFrom) && period.effectiveFrom >= config.startDate && period.effectiveFrom <= config.contractEndDate) starts.add(period.effectiveFrom);
      if (validDate(period.effectiveTo) && period.effectiveTo >= config.startDate && period.effectiveTo < config.contractEndDate) starts.add(Legal.addDays(period.effectiveTo, 1));
    }
    return [...starts].sort().map(effectiveFrom => {
      const wage = single(config.wagePeriods, effectiveFrom), food = single(config.foodTerms, effectiveFrom);
      return { effectiveFrom, monthlyWage: wage?.monthlyWage ?? '', mode: food?.mode || '', monthlyAmount: food?.monthlyAmount ?? '' };
    });
  }

  function contractInput(config) {
    return { ...config, endDate: config.contractEndDate };
  }

  function complete(config) {
    try { return Legal.validateContractTerms(contractInput(config)).length === 0; } catch { return false; }
  }

  // Initial entries are not evidence of the whole employment history. Only an
  // explicit "same" answer creates periods beginning on the first work day.
  function prepareInitial(config, choice, effectiveFrom, meta = {}) {
    const errors = [], add = (field, code) => errors.push({ field, code });
    if (!validDate(config.startDate) || !validDate(config.contractEndDate) || config.startDate > config.contractEndDate) add('start', 'date');
    if (config.contractSignedOn && !validDate(config.contractSignedOn)) add('signed', 'date');
    const wageKnown = config.monthlyWage !== '' && config.monthlyWage !== null;
    const wage = Number(config.monthlyWage), food = Number(config.foodAllowance);
    if (wageKnown && (!Number.isFinite(wage) || wage <= 0)) add('wage', 'wage');
    if (!['provided', 'allowance', 'unknown'].includes(config.foodMode)) add('food-mode', 'food');
    if (config.foodMode === 'allowance' && (config.foodAllowance === '' || !Number.isFinite(food) || food < 0)) add('food', 'amount');
    if (!['same', 'changed', 'unknown'].includes(choice)) add('pay-history', 'choice');
    if (choice !== 'unknown' && (!wageKnown || config.foodMode === 'unknown')) add('pay-history', 'unknown_terms');
    const minimum = config.contractSignedOn ? Legal.minimumRatesForContract(config.contractSignedOn) : null;
    if (minimum && wageKnown && wage < minimum.monthlyWage) add('wage', 'below_maw');
    if (minimum && config.foodMode === 'allowance' && food < minimum.foodAllowance) add('food', 'below_minimum');
    if (choice === 'changed' && (!validDate(effectiveFrom) || effectiveFrom <= config.startDate || effectiveFrom > config.contractEndDate ||
      (validDate(meta.asOf) && effectiveFrom > meta.asOf))) add('pay-from', 'effective_date');
    if (errors.length) return { errors };
    const from = choice === 'same' ? config.startDate : choice === 'changed' ? effectiveFrom : null;
    const amount = config.foodMode === 'allowance' ? food : 0;
    const dates = from ? { effectiveFrom: from, effectiveTo: config.contractEndDate } : null;
    return { errors: [], next: { ...config,
      monthlyWage: wageKnown ? wage : 0, foodAllowance: amount,
      wagePeriods: dates ? [{ ...dates, monthlyWage: wage }] : [],
      foodTerms: dates ? [{ ...dates, mode: config.foodMode, monthlyAmount: amount }] : [],
      initialPayTerms: { historyChoice: choice, knownFrom: from, enteredMonthlyWage: wageKnown ? wage : null,
        enteredFoodMode: config.foodMode, enteredFoodAllowance: config.foodMode === 'unknown' ? null : amount,
        recordedAt: meta.recordedAt || null }
    } };
  }

  function prepare(config, entered, meta) {
    const errors = [], add = (field, code) => errors.push({ field, code });
    if (!validDate(config.startDate) || !validDate(config.contractEndDate) || !validDate(config.contractSignedOn)) {
      return { errors: [{ field: 'contract', code: 'contract_dates' }] };
    }
    if (!['change', 'correction', 'confirm'].includes(meta.kind)) add('kind', 'intent');
    if (!String(meta.reason || '').trim()) add('reason', 'reason');
    let nextRows = copy(entered);
    if (meta.kind === 'change') {
      if (!complete(config)) add('contract', 'history_first');
      if (nextRows.length !== 1 || !validDate(nextRows[0]?.effectiveFrom)) add('date-0', 'date');
      else if (rows(config).some(row => row.effectiveFrom === nextRows[0].effectiveFrom)) add('date-0', 'existing_date');
      if (errors.length) return { errors };
      nextRows = rows(config).concat(nextRows).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    }
    if (!nextRows.length) add('date-0', 'date');
    nextRows.forEach((row, index) => {
      if (!validDate(row.effectiveFrom) || row.effectiveFrom < config.startDate || row.effectiveFrom > config.contractEndDate ||
          (index === 0 && row.effectiveFrom !== config.startDate) || (index > 0 && row.effectiveFrom <= nextRows[index - 1].effectiveFrom)) add('date-' + index, 'date');
      if (row.monthlyWage === '' || !Number.isFinite(Number(row.monthlyWage)) || Number(row.monthlyWage) <= 0) add('wage-' + index, 'wage');
      if (!['provided', 'allowance'].includes(row.mode)) add('food-' + index, 'food');
      if (row.mode === 'allowance' && (row.monthlyAmount === '' || !Number.isFinite(Number(row.monthlyAmount)) || Number(row.monthlyAmount) < 0)) add('amount-' + index, 'amount');
    });
    if (errors.length) return { errors };
    const wagePeriods = [], foodTerms = [];
    nextRows.forEach((row, index) => {
      const dates = { effectiveFrom: row.effectiveFrom, effectiveTo: index + 1 < nextRows.length ? Legal.addDays(nextRows[index + 1].effectiveFrom, -1) : config.contractEndDate };
      wagePeriods.push({ ...dates, monthlyWage: Number(row.monthlyWage) });
      foodTerms.push({ ...dates, mode: row.mode, monthlyAmount: row.mode === 'provided' ? 0 : Number(row.monthlyAmount) });
    });
    const next = { ...config, wagePeriods, foodTerms };
    for (const issue of Legal.validateContractTerms(contractInput(next))) {
      const index = Number(issue.path.match(/\[(\d+)\]/)?.[1] || 0);
      add(issue.path.startsWith('wagePeriods') ? 'wage-' + index : issue.path.startsWith('foodTerms') ? 'amount-' + index : 'contract', issue.code);
    }
    if (errors.length) return { errors };
    // Flat fields remain a compatibility display only. Historical calculations
    // must select by their own period, never apply today's wage to all months.
    const date = validDate(meta.asOf) ? meta.asOf : config.startDate;
    const selection = date < config.startDate ? config.startDate : date > config.contractEndDate ? config.contractEndDate : date;
    const wage = single(wagePeriods, selection), food = single(foodTerms, selection);
    Object.assign(next, { monthlyWage: wage.monthlyWage, foodMode: food.mode, foodAllowance: food.monthlyAmount });
    next.payTermRevisions = [...(config.payTermRevisions || []), {
      id: meta.id, recordedAt: meta.recordedAt, kind: meta.kind, reason: meta.reason.trim(),
      before: { wagePeriods: copy(config.wagePeriods || []), foodTerms: copy(config.foodTerms || []),
        monthlyWage: config.monthlyWage, foodMode: config.foodMode, foodAllowance: config.foodAllowance },
      after: { wagePeriods: copy(wagePeriods), foodTerms: copy(foodTerms) }
    }];
    return { errors: [], next };
  }

  function resolve(config, start, end) {
    if (!Object.prototype.hasOwnProperty.call(config, 'wagePeriods') && !Object.prototype.hasOwnProperty.call(config, 'foodTerms')) return { monthlyWage: config.monthlyWage,
      foodMode: config.foodMode, foodAllowance: config.foodAllowance, legacy: true, issue: null };
    if (!Array.isArray(config.wagePeriods) || !Array.isArray(config.foodTerms)) return { issue: 'pay_history_missing' };
    const wage = single(config.wagePeriods, start), food = single(config.foodTerms, start);
    let issue = null;
    if (!wage || !food || !Number.isFinite(Number(wage.monthlyWage)) || !['provided', 'allowance'].includes(food.mode) ||
        !Number.isFinite(Number(food.monthlyAmount))) issue = 'pay_history_missing';
    for (const periods of [config.wagePeriods, config.foodTerms]) {
      let cursor = start;
      for (const period of (periods || []).filter(p => p.effectiveFrom <= end && p.effectiveTo >= start).slice().sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) {
        if (!validDate(period.effectiveFrom) || !validDate(period.effectiveTo) || period.effectiveTo < period.effectiveFrom ||
            (period.effectiveFrom > start ? period.effectiveFrom : start) !== cursor) { issue = 'pay_history_missing'; break; }
        cursor = Legal.addDays(period.effectiveTo < end ? period.effectiveTo : end, 1);
      }
      if (cursor !== Legal.addDays(end, 1)) issue = 'pay_history_missing';
    }
    if (!issue && ((config.wagePeriods || []).some(p => p.effectiveFrom <= end && p.effectiveTo >= start && Number(p.monthlyWage) !== Number(wage.monthlyWage)) ||
        (config.foodTerms || []).some(p => p.effectiveFrom <= end && p.effectiveTo >= start && (p.mode !== food.mode || Number(p.monthlyAmount) !== Number(food.monthlyAmount))))) issue = 'intra_month_pay_change';
    return { monthlyWage: wage?.monthlyWage, foodMode: food?.mode, foodAllowance: food?.monthlyAmount, issue };
  }

  const restFields = ['restDayWeekday', 'restDayPayTerm', 'restDayWorkArrangement', 'restDayWorkPayment'];
  const restValues = source => Object.fromEntries(restFields.map(key => [key, source?.[key]]));
  const validRest = row => Number.isInteger(row.restDayWeekday) && row.restDayWeekday >= 0 && row.restDayWeekday <= 6 &&
    ['paid', 'unpaid'].includes(row.restDayPayTerm) && ['agreed_payment', 'substituted_rest_day'].includes(row.restDayWorkArrangement) &&
    Number.isFinite(row.restDayWorkPayment) && row.restDayWorkPayment >= 0 &&
    (row.restDayWorkArrangement !== 'agreed_payment' || row.restDayWorkPayment > 0);

  function restAt(config, date) {
    // Only absent history is legacy. Empty, overlapping or malformed stored
    // history must never fall back to the global amount and invent a result.
    if (!Object.prototype.hasOwnProperty.call(config, 'restTerms')) return {
      ...restValues(config), restDayWeekday: config.restDayWeekday ?? 0,
      restDayWorkPayment: config.restDayWorkPayment ?? 0, legacy: true,
      issue: config.initialSetupVersion === 1 && !validRest(config) ? 'rest_history_missing' : null
    };
    if (!Array.isArray(config.restTerms) || config.restTerms.some(p => !p || !validDate(p.effectiveFrom) ||
      !validDate(p.effectiveTo) || p.effectiveFrom > p.effectiveTo)) return { issue: 'rest_history_missing' };
    const term = single(config.restTerms, date);
    return term && validRest(term) ? { ...restValues(term), effectiveFrom: term.effectiveFrom, issue: null } : { issue: 'rest_history_missing' };
  }

  function restRows(config) {
    if (!Object.prototype.hasOwnProperty.call(config, 'restTerms')) return [{ effectiveFrom: config.startDate, ...restValues(restAt(config, config.startDate)) }];
    return (Array.isArray(config.restTerms) ? config.restTerms : []).filter(p => p && typeof p === 'object')
      .map(p => ({ effectiveFrom: p.effectiveFrom, ...restValues(p) }));
  }

  function restWindow(config, start, end) {
    const periods = [];
    for (let date = start; date <= end; date = Legal.addDays(date, 1)) {
      const term = restAt(config, date);
      if (term.issue) return { issue: term.issue, periods: [] };
      const values = restValues(term), previous = periods.at(-1);
      if (previous && restFields.every(key => previous[key] === values[key])) previous.effectiveTo = date;
      else periods.push({ effectiveFrom: date, effectiveTo: date, ...values });
    }
    return { issue: null, periods };
  }

  function prepareRest(config, entered, meta) {
    const errors = [], add = (field, code) => errors.push({ field, code });
    if (!validDate(config.startDate) || !validDate(config.contractEndDate) || config.startDate > config.contractEndDate) return { errors: [{ field: 'contract', code: 'contract_dates' }] };
    if (!['change', 'correction', 'confirm'].includes(meta.kind)) add('kind', 'intent');
    if (!String(meta.reason || '').trim()) add('reason', 'reason');
    let nextRows = Array.isArray(entered) ? copy(entered) : [];
    if (meta.kind === 'change') {
      const previous = restWindow(config, config.startDate, config.contractEndDate);
      if (previous.issue || previous.periods.some(p => !validRest(p))) add('contract', 'history_first');
      if (nextRows.length !== 1 || !validDate(nextRows[0]?.effectiveFrom)) add('date-0', 'date');
      else if (restRows(config).some(p => p.effectiveFrom === nextRows[0].effectiveFrom)) add('date-0', 'existing_date');
      if (errors.length) return { errors };
      nextRows = restRows(config).concat(nextRows).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    }
    if (!nextRows.length) add('date-0', 'date');
    nextRows.forEach((row, i) => {
      if (!validDate(row.effectiveFrom) || row.effectiveFrom < config.startDate || row.effectiveFrom > config.contractEndDate ||
        (i === 0 && row.effectiveFrom !== config.startDate) || (i > 0 && row.effectiveFrom <= nextRows[i - 1].effectiveFrom)) add('date-' + i, 'date');
      if (row.restDayWeekday === '' || !Number.isInteger(Number(row.restDayWeekday)) || Number(row.restDayWeekday) < 0 || Number(row.restDayWeekday) > 6) add('weekday-' + i, 'weekday');
      if (!['paid', 'unpaid'].includes(row.restDayPayTerm)) add('pay-' + i, 'pay');
      if (!['agreed_payment', 'substituted_rest_day'].includes(row.restDayWorkArrangement)) add('work-' + i, 'work');
      if (row.restDayWorkArrangement === 'agreed_payment' && (row.restDayWorkPayment === '' || !Number.isFinite(Number(row.restDayWorkPayment)) || Number(row.restDayWorkPayment) <= 0)) add('amount-' + i, 'amount');
    });
    if (errors.length) return { errors };
    const restTerms = nextRows.map((row, i) => ({ effectiveFrom: row.effectiveFrom,
      effectiveTo: i + 1 < nextRows.length ? Legal.addDays(nextRows[i + 1].effectiveFrom, -1) : config.contractEndDate,
      restDayWeekday: Number(row.restDayWeekday), restDayPayTerm: row.restDayPayTerm,
      restDayWorkArrangement: row.restDayWorkArrangement,
      restDayWorkPayment: row.restDayWorkArrangement === 'agreed_payment' ? Number(row.restDayWorkPayment) : 0 }));
    // Old apps do not understand periods. Leave explicit unsupported sentinels
    // in their flat fields so their existing legal gate cannot confirm a new
    // statement using a single stale cash amount after a software downgrade.
    // Actual earlier terms remain in restTerms and the detached revision below.
    const next = { ...config, restTerms, restDayPayTerm: 'effective_dated',
      restDayWorkArrangement: 'effective_dated', restDayWorkPayment: 0 };
    next.restTermRevisions = [...(config.restTermRevisions || []), { id: meta.id, recordedAt: meta.recordedAt,
      kind: meta.kind, reason: meta.reason.trim(),
      before: { ...copy(restValues(restAt(config, config.startDate))), legacyFields: copy(restValues(config)), restTerms: copy(config.restTerms ?? null) },
      after: { restTerms: copy(restTerms) } }];
    return { errors: [], next };
  }

  function pendingWinterDate(config, date) {
    if (config.winterHolidayChoice !== 'unknown') return false;
    try { return ['christmas', 'winter_solstice'].some(choice => Legal.statutoryCalendar(Number(date.slice(0, 4)), choice)
      .some(day => day.id === 'winter_holiday' && day.date === date)); } catch { return false; }
  }

  const api = { rows, complete, prepare, prepareInitial, resolve, restAt, restRows, restWindow, prepareRest, pendingWinterDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.HSContractHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
