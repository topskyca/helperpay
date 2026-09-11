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
    if (!(config.wagePeriods?.length || config.foodTerms?.length)) return { monthlyWage: config.monthlyWage,
      foodMode: config.foodMode, foodAllowance: config.foodAllowance, legacy: true, issue: null };
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

  const api = { rows, complete, prepare, resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.HSContractHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
