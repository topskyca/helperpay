/* HelperPay — audited ID 407 calculation primitives.
 *
 * This module is loaded by the production app. It supplies versioned legal
 * boundaries, statutory calendars and validation. Case-specific or
 * professionally unresolved formulas are blocked instead of being guessed.
 */
(function (global) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MODEL_VERSION = 'fdh-id407-v2.2.0';
  const LEGAL_SOURCE_VERSION = 'hk-ld-2026-09-11';

  const EVENT_TYPES = Object.freeze([
    'ordinary_absence',
    'rest_day',
    'substituted_rest_day',
    'statutory_holiday',
    'alternative_holiday',
    'substituted_holiday',
    'rest_day_collision_holiday',
    'annual_leave',
    'sickness',
    'maternity',
    'paternity'
  ]);

  const MONEY_CLASSES = Object.freeze([
    'statutory_entitlement',
    'contractual_payment',
    'voluntary_benefit',
    'lawful_deduction'
  ]);

  const APPROVAL_STATES = Object.freeze(['draft', 'pending', 'accepted', 'rejected']);

  const DEDUCTION_TYPES = Object.freeze([
    'absence',
    'damage_or_loss',
    'advance_recovery',
    'overpayment_recovery',
    'other_authorized'
  ]);

  const SOURCE_URLS = Object.freeze({
    employmentGuide: 'https://www.labour.gov.hk/eng/public/wcp/ConciseGuide/EO_guide_full.pdf',
    restDays: 'https://www.labour.gov.hk/eng/faq/cap57e_whole.htm',
    statutoryHolidays: 'https://www.labour.gov.hk/eng/faq/cap57f_whole.htm',
    id407: 'https://www.immd.gov.hk/eng/forms/forms/fdhcontractterms.html',
    fdhFaq: 'https://www.fdh.labour.gov.hk/en/faq.html',
    holidays2026: 'https://www.labour.gov.hk/eng/news/latest_holidays2026.htm',
    holidays2027: 'https://www.labour.gov.hk/eng/news/latest_holidays2027.htm',
    maw2024: 'https://www.fdh.labour.gov.hk/en/news_detail.php?n_id=288&year=2024',
    maw2025: 'https://www.eaa.labour.gov.hk/en/news.html?news-id=267&news-year=2025'
  });

  const MINIMUM_RATES = Object.freeze([
    Object.freeze({
      effectiveFrom: '2024-09-28', effectiveTo: '2025-09-29',
      monthlyWage: 4990, foodAllowance: 1236, source: SOURCE_URLS.maw2024
    }),
    Object.freeze({
      effectiveFrom: '2025-09-30', effectiveTo: null,
      monthlyWage: 5100, foodAllowance: 1236, source: SOURCE_URLS.maw2025
    })
  ]);

  const HOLIDAY_DEFINITIONS = Object.freeze({
    2026: Object.freeze([
      { id: 'new_year', name: "The first day of January", date: '2026-01-01' },
      { id: 'lunar_new_year_1', name: "Lunar New Year's Day", date: '2026-02-17' },
      { id: 'lunar_new_year_2', name: 'The second day of Lunar New Year', date: '2026-02-18' },
      { id: 'lunar_new_year_3', name: 'The third day of Lunar New Year', date: '2026-02-19' },
      { id: 'ching_ming', name: 'Ching Ming Festival', date: '2026-04-05' },
      { id: 'easter_monday', name: 'Easter Monday', date: '2026-04-06' },
      { id: 'labour_day', name: 'Labour Day', date: '2026-05-01' },
      { id: 'buddha_birthday', name: 'The Birthday of the Buddha', date: '2026-05-24' },
      { id: 'tuen_ng', name: 'Tuen Ng Festival', date: '2026-06-19' },
      { id: 'hksar_day', name: 'HKSAR Establishment Day', date: '2026-07-01' },
      { id: 'mid_autumn_following', name: 'The day following the Chinese Mid-Autumn Festival', date: '2026-09-26' },
      { id: 'national_day', name: 'National Day', date: '2026-10-01' },
      { id: 'chung_yeung', name: 'Chung Yeung Festival', date: '2026-10-18' },
      {
        id: 'winter_holiday', name: 'Chinese Winter Solstice Festival or Christmas Day',
        choices: { winter_solstice: '2026-12-22', christmas: '2026-12-25' }
      },
      { id: 'post_christmas', name: 'The first weekday after Christmas Day', date: '2026-12-26' }
    ]),
    2027: Object.freeze([
      { id: 'new_year', name: "The first day of January", date: '2027-01-01' },
      { id: 'lunar_new_year_1', name: "Lunar New Year's Day", date: '2027-02-06' },
      { id: 'lunar_new_year_3', name: 'The third day of Lunar New Year', date: '2027-02-08' },
      { id: 'lunar_new_year_4_substitute', name: 'The fourth day of Lunar New Year', date: '2027-02-09' },
      { id: 'easter_monday', name: 'Easter Monday', date: '2027-03-29' },
      { id: 'ching_ming', name: 'Ching Ming Festival', date: '2027-04-05' },
      { id: 'labour_day', name: 'Labour Day', date: '2027-05-01' },
      { id: 'buddha_birthday', name: 'The Birthday of the Buddha', date: '2027-05-13' },
      { id: 'tuen_ng', name: 'Tuen Ng Festival', date: '2027-06-09' },
      { id: 'hksar_day', name: 'HKSAR Establishment Day', date: '2027-07-01' },
      { id: 'mid_autumn_following', name: 'The day following the Chinese Mid-Autumn Festival', date: '2027-09-16' },
      { id: 'national_day', name: 'National Day', date: '2027-10-01' },
      { id: 'chung_yeung', name: 'Chung Yeung Festival', date: '2027-10-08' },
      {
        id: 'winter_holiday', name: 'Chinese Winter Solstice Festival or Christmas Day',
        choices: { winter_solstice: '2027-12-22', christmas: '2027-12-25' }
      },
      { id: 'post_christmas', name: 'The first weekday after Christmas Day', date: '2027-12-27' }
    ])
  });

  function fail(message) { throw new Error(message); }

  function parseDate(value, field) {
    const s = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail((field || 'date') + ' must be YYYY-MM-DD');
    const d = new Date(s + 'T00:00:00.000Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      fail((field || 'date') + ' is not a valid calendar date');
    }
    return d;
  }

  function formatDate(d) { return d.toISOString().slice(0, 10); }

  function addDays(value, number) {
    const d = parseDate(value);
    d.setUTCDate(d.getUTCDate() + number);
    return formatDate(d);
  }

  function addMonths(value, number) {
    const d = parseDate(value);
    const originalDay = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + number);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, last));
    return formatDate(d);
  }

  function compareDates(a, b) { return parseDate(a).getTime() - parseDate(b).getTime(); }

  function daysInclusive(start, end) {
    const count = Math.round((parseDate(end, 'end').getTime() - parseDate(start, 'start').getTime()) / DAY_MS) + 1;
    if (count < 1) fail('end date must not be before start date');
    return count;
  }

  function round2(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }

  function minimumRatesForContract(contractSignedOn) {
    parseDate(contractSignedOn, 'contractSignedOn');
    for (let i = MINIMUM_RATES.length - 1; i >= 0; i--) {
      const rate = MINIMUM_RATES[i];
      if (contractSignedOn >= rate.effectiveFrom && (!rate.effectiveTo || contractSignedOn <= rate.effectiveTo)) {
        return Object.assign({}, rate);
      }
    }
    return null;
  }

  function statutoryCalendar(year, winterChoice) {
    const definitions = HOLIDAY_DEFINITIONS[year];
    if (!definitions) fail('No audited statutory-holiday calendar for ' + year);
    if (winterChoice !== 'winter_solstice' && winterChoice !== 'christmas') {
      fail('winterChoice must be winter_solstice or christmas');
    }
    const source = year === 2026 ? SOURCE_URLS.holidays2026 : SOURCE_URLS.holidays2027;
    return definitions.map(definition => Object.freeze({
      id: definition.id,
      name: definition.name,
      date: definition.choices ? definition.choices[winterChoice] : definition.date,
      type: 'statutory_holiday',
      source,
      legalSourceVersion: LEGAL_SOURCE_VERSION
    }));
  }

  function entitlementWindow(entitlementDate, employmentStart) {
    parseDate(entitlementDate, 'entitlementDate');
    parseDate(employmentStart, 'employmentStart');
    const periodEnd = addDays(entitlementDate, -1);
    const twelveMonthsBefore = addMonths(entitlementDate, -12);
    const periodStart = employmentStart > twelveMonthsBefore ? employmentStart : twelveMonthsBefore;
    if (periodStart > periodEnd) fail('No wage history precedes the entitlement date');
    return { periodStart, periodEnd };
  }

  function sortedCopy(items, field) {
    return (items || []).slice().sort((a, b) => String(a[field]).localeCompare(String(b[field])));
  }

  function validateContiguousRecords(periodStart, periodEnd, records) {
    if (!records.length) fail('At least one wage record is required');
    let cursor = periodStart;
    records.forEach((record, index) => {
      parseDate(record.startDate, 'wageRecords[' + index + '].startDate');
      parseDate(record.endDate, 'wageRecords[' + index + '].endDate');
      if (record.startDate !== cursor) fail('Wage records must cover the calculation period without gaps or overlaps');
      if (record.endDate < record.startDate || record.endDate > periodEnd) fail('Wage record is outside the calculation period');
      cursor = addDays(record.endDate, 1);
    });
    if (cursor !== addDays(periodEnd, 1)) fail('Wage records must cover the calculation period through its final day');
  }

  function validateDisregardedPeriods(record, periods, recordIndex) {
    const sorted = sortedCopy(periods, 'startDate');
    let previousEnd = null;
    sorted.forEach((period, index) => {
      const path = 'wageRecords[' + recordIndex + '].disregardedPeriods[' + index + ']';
      parseDate(period.startDate, path + '.startDate');
      parseDate(period.endDate, path + '.endDate');
      if (period.startDate < record.startDate || period.endDate > record.endDate || period.endDate < period.startDate) {
        fail(path + ' must be contained within its wage record');
      }
      if (previousEnd && period.startDate <= previousEnd) fail('Disregarded periods must not overlap');
      if (!(Number(period.wagesPaid) >= 0)) fail(path + '.wagesPaid must be zero or positive');
      if (!period.reason) fail(path + '.reason is required');
      previousEnd = period.endDate;
    });
    return sorted;
  }

  /*
   * Calculates the statutory average over an already attributable, complete
   * wage history. The caller supplies the entitlement date and records whose
   * wages are attributable exactly to the returned calculation window. This
   * function deliberately rejects gaps, overlaps and partial boundary records.
   */
  function calculateAverageDailyWages(input) {
    input = input || {};
    const window = entitlementWindow(input.entitlementDate, input.employmentStart);
    const records = sortedCopy(input.wageRecords, 'startDate');
    validateContiguousRecords(window.periodStart, window.periodEnd, records);

    let includedWages = 0;
    let includedDays = 0;
    let disregardedWages = 0;
    let disregardedDays = 0;

    records.forEach((record, recordIndex) => {
      const wagesEarned = Number(record.wagesEarned);
      if (!(wagesEarned >= 0)) fail('wageRecords[' + recordIndex + '].wagesEarned must be zero or positive');
      const recordDays = daysInclusive(record.startDate, record.endDate);
      const disregarded = validateDisregardedPeriods(record, record.disregardedPeriods || [], recordIndex);
      let recordDisregardedDays = 0;
      let recordDisregardedWages = 0;
      disregarded.forEach(period => {
        recordDisregardedDays += daysInclusive(period.startDate, period.endDate);
        recordDisregardedWages += Number(period.wagesPaid);
      });
      if (recordDisregardedDays > recordDays) fail('Disregarded days exceed wage-record days');
      if (recordDisregardedWages > wagesEarned) fail('Disregarded wages exceed wages earned');
      includedDays += recordDays - recordDisregardedDays;
      includedWages += wagesEarned - recordDisregardedWages;
      disregardedDays += recordDisregardedDays;
      disregardedWages += recordDisregardedWages;
    });

    if (includedDays <= 0) fail('Average daily wages cannot be calculated with no included days');
    const averageExact = includedWages / includedDays;
    return Object.freeze({
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      includedWages,
      includedDays,
      disregardedWages,
      disregardedDays,
      averageExact,
      average: round2(averageExact),
      legalSourceVersion: LEGAL_SOURCE_VERSION,
      source: SOURCE_URLS.statutoryHolidays
    });
  }

  function restDayViolations(employmentStart, employmentEnd, restDays) {
    parseDate(employmentStart, 'employmentStart');
    parseDate(employmentEnd, 'employmentEnd');
    if (employmentEnd < employmentStart) fail('employmentEnd must not be before employmentStart');
    const rest = new Set((restDays || []).map((date, index) => {
      parseDate(date, 'restDays[' + index + ']');
      return date;
    }));
    const violations = [];
    for (let start = employmentStart; addDays(start, 6) <= employmentEnd; start = addDays(start, 1)) {
      const end = addDays(start, 6);
      let hasRest = false;
      for (let date = start; date <= end; date = addDays(date, 1)) {
        if (rest.has(date)) { hasRest = true; break; }
      }
      if (!hasRest) violations.push(Object.freeze({ periodStart: start, periodEnd: end }));
    }
    return Object.freeze(violations);
  }

  function zonedTimestamp(value, field) {
    // Never interpret an unzoned time using the device's timezone. Reject
    // normalized invalid dates (e.g. February 30) as well as invalid clocks.
    const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(String(value || ''));
    if (!match || !Number.isFinite(Date.parse(value))) fail(field + ' must be a valid ISO date-time with a timezone');
    parseDate(match[1], field);
    if (/^[+-]14:(?!00)/.test(match[5])) fail(field + ' has an invalid timezone offset');
    return Date.parse(value);
  }

  function signedDayDistance(from, to) {
    return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);
  }

  function validateHolidayArrangement(arrangement) {
    arrangement = arrangement || {};
    const errors = [];
    try { parseDate(arrangement.statutoryDate, 'statutoryDate'); } catch (error) { return [error.message]; }

    if (arrangement.type === 'alternative_holiday') {
      try { parseDate(arrangement.date, 'date'); } catch (error) { return [error.message]; }
      const distance = signedDayDistance(arrangement.statutoryDate, arrangement.date);
      if (distance === 0 || distance < -60 || distance > 60) {
        errors.push('Alternative holiday must be on a different day within 60 days before or after the statutory holiday');
      }
    } else if (arrangement.type === 'substituted_holiday') {
      try { parseDate(arrangement.date, 'date'); } catch (error) { return [error.message]; }
      const referenceDate = arrangement.alternativeDate || arrangement.statutoryDate;
      try { parseDate(referenceDate, 'alternativeDate'); } catch (error) { return [error.message]; }
      const distance = Math.abs(signedDayDistance(referenceDate, arrangement.date));
      if (distance === 0 || arrangement.date === arrangement.statutoryDate || distance > 30) errors.push('Substituted holiday must be on a different day within 30 days before or after its reference holiday');
      if (arrangement.mutualAgreement !== true) errors.push('Substituted holiday requires mutual agreement');
    } else {
      errors.push('type must be alternative_holiday or substituted_holiday');
    }
    if (arrangement.type === 'alternative_holiday' || arrangement.type === 'substituted_holiday') {
      // LD FAQ Q4 requires notice before the WORK, not before UTC midnight.
      // Missing legacy start times stay unresolved; do not fabricate a time or
      // mutate an earlier frozen statement merely to pass this new version.
      let starts, notice;
      try { starts = zonedTimestamp(arrangement.workStartsAt, 'workStartsAt'); }
      catch (error) { errors.push(error.message); }
      try { notice = zonedTimestamp(arrangement.noticeAt, 'noticeAt'); }
      catch (error) { errors.push(error.message); }
      if (Number.isFinite(starts) && new Date(starts + 8 * 3600000).toISOString().slice(0, 10) !== arrangement.statutoryDate) {
        errors.push('workStartsAt must fall on the statutory holiday in Hong Kong time');
      }
      if (Number.isFinite(starts) && Number.isFinite(notice) && starts - notice < 48 * 3600000) {
        errors.push('At least 48 hours prior notice of statutory-holiday work is required');
      }
    }
    return errors;
  }

  function deriveCollisionHoliday(sourceHoliday, blockedDates) {
    if (!sourceHoliday || !sourceHoliday.id) fail('sourceHoliday.id is required');
    parseDate(sourceHoliday.date, 'sourceHoliday.date');
    const blocked = new Set(blockedDates || []);
    let date = addDays(sourceHoliday.date, 1);
    let guard = 0;
    while (blocked.has(date)) {
      date = addDays(date, 1);
      guard++;
      if (guard > 31) fail('No qualifying collision holiday found within 31 days');
    }
    return Object.freeze({
      id: 'collision:' + sourceHoliday.id,
      type: 'rest_day_collision_holiday',
      date,
      sourceEventId: sourceHoliday.id,
      legalSourceVersion: LEGAL_SOURCE_VERSION
    });
  }

  function validateEffectivePeriods(periods, contractStart, contractEnd, path) {
    const errors = [];
    const sorted = sortedCopy(periods, 'effectiveFrom');
    if (!sorted.length) return [{ path, code: 'required', message: 'At least one effective-dated period is required' }];
    let cursor = contractStart;
    sorted.forEach((period, index) => {
      const here = path + '[' + index + ']';
      try {
        parseDate(period.effectiveFrom, here + '.effectiveFrom');
        parseDate(period.effectiveTo, here + '.effectiveTo');
      } catch (error) {
        errors.push({ path: here, code: 'invalid_date', message: error.message });
        return;
      }
      if (period.effectiveFrom !== cursor) {
        errors.push({ path: here, code: 'gap_or_overlap', message: 'Periods must cover the contract without gaps or overlaps' });
      }
      if (period.effectiveTo < period.effectiveFrom || period.effectiveTo > contractEnd) {
        errors.push({ path: here, code: 'outside_contract', message: 'Period must be contained in the contract' });
      }
      cursor = addDays(period.effectiveTo, 1);
    });
    if (cursor !== addDays(contractEnd, 1)) {
      errors.push({ path, code: 'incomplete', message: 'Periods must cover the complete contract' });
    }
    return errors;
  }

  function validateContractTerms(contract) {
    contract = contract || {};
    const errors = [];
    if (contract.contractType !== 'ID407') {
      errors.push({ path: 'contractType', code: 'unsupported', message: 'Only ID407 is supported' });
    }
    ['contractSignedOn', 'startDate', 'endDate'].forEach(field => {
      try { parseDate(contract[field], field); } catch (error) {
        errors.push({ path: field, code: 'invalid_date', message: error.message });
      }
    });
    if (errors.some(error => error.code === 'invalid_date')) return errors;
    if (contract.endDate < contract.startDate) {
      errors.push({ path: 'endDate', code: 'before_start', message: 'endDate must not be before startDate' });
      return errors;
    }
    const expectedContractEnd = addDays(addMonths(contract.startDate, 24), -1);
    if (contract.endDate !== expectedContractEnd) {
      errors.push({
        path: 'endDate', code: 'not_two_year_contract',
        message: 'An ID407 contract period must cover two years; record early termination separately'
      });
    }

    errors.push.apply(errors, validateEffectivePeriods(contract.wagePeriods, contract.startDate, contract.endDate, 'wagePeriods'));
    errors.push.apply(errors, validateEffectivePeriods(contract.foodTerms, contract.startDate, contract.endDate, 'foodTerms'));

    const minimum = minimumRatesForContract(contract.contractSignedOn);
    if (!minimum) {
      errors.push({ path: 'contractSignedOn', code: 'rate_not_audited', message: 'No audited minimum-rate table covers this contract date' });
      return errors;
    }
    (contract.wagePeriods || []).forEach((period, index) => {
      if (!Number.isFinite(Number(period.monthlyWage)) || !(Number(period.monthlyWage) >= minimum.monthlyWage)) {
        errors.push({ path: 'wagePeriods[' + index + '].monthlyWage', code: 'below_maw', message: 'Monthly wage is below the contract-date MAW' });
      }
    });
    (contract.foodTerms || []).forEach((period, index) => {
      if (period.mode !== 'provided' && period.mode !== 'allowance') {
        errors.push({ path: 'foodTerms[' + index + '].mode', code: 'invalid_mode', message: 'Food mode must be provided or allowance' });
      } else if (period.mode === 'allowance' && (!Number.isFinite(Number(period.monthlyAmount)) || !(Number(period.monthlyAmount) >= minimum.foodAllowance))) {
        errors.push({ path: 'foodTerms[' + index + '].monthlyAmount', code: 'below_minimum', message: 'Food allowance is below the contract-date minimum' });
      }
    });
    return errors;
  }

  function validateDeductionBatch(deductions, wagesPayable, commissionerApproval) {
    const errors = [];
    const wage = Number(wagesPayable);
    if (!(wage >= 0)) return ['wagesPayable must be zero or positive'];
    let nonAbsenceTotal = 0;
    let damageTotal = 0;
    let recoveryTotal = 0;

    (deductions || []).forEach((deduction, index) => {
      const amount = Number(deduction.amount);
      const prefix = 'deductions[' + index + ']';
      if (DEDUCTION_TYPES.indexOf(deduction.type) === -1) errors.push(prefix + ' has an unsupported deduction type');
      if (!(amount > 0)) errors.push(prefix + '.amount must be positive');
      if (deduction.type === 'absence') {
        if (!(Number(deduction.proportionateMaximum) >= 0) || amount > Number(deduction.proportionateMaximum)) {
          errors.push(prefix + ' exceeds or omits the proportionate absence maximum');
        }
      } else {
        nonAbsenceTotal += amount || 0;
      }
      if (deduction.type === 'damage_or_loss') {
        damageTotal += amount || 0;
        if (amount > 300) errors.push(prefix + ' exceeds the HK$300 per-case damage/loss limit');
        if (!deduction.evidence) errors.push(prefix + ' requires evidence of the permitted damage/loss conditions');
      }
      if (deduction.type === 'advance_recovery' || deduction.type === 'overpayment_recovery') {
        recoveryTotal += amount || 0;
      }
      if (deduction.type === 'other_authorized' && !deduction.legalBasis) {
        errors.push(prefix + ' requires a legal basis');
      }
    });

    if (damageTotal > wage / 4) errors.push('Damage/loss deductions exceed one quarter of wages payable');
    if (recoveryTotal > wage / 4) errors.push('Advance/overpayment recovery exceeds one quarter of wages payable');
    if (!commissionerApproval && nonAbsenceTotal > wage / 2) {
      errors.push('Non-absence deductions exceed one half of wages payable without written Commissioner approval');
    }
    return errors;
  }

  function calculateStatementTotals(items) {
    const accepted = { statutory_entitlement: 0, contractual_payment: 0, voluntary_benefit: 0, lawful_deduction: 0 };
    const projected = { statutory_entitlement: 0, contractual_payment: 0, voluntary_benefit: 0, lawful_deduction: 0 };

    (items || []).forEach((item, index) => {
      if (MONEY_CLASSES.indexOf(item.class) === -1) fail('items[' + index + '] has an unsupported money class');
      if (APPROVAL_STATES.indexOf(item.status) === -1) fail('items[' + index + '] has an unsupported approval state');
      const amount = Number(item.amount);
      if (!(amount >= 0)) fail('items[' + index + '].amount must be zero or positive');
      if (item.status === 'accepted' || item.status === 'pending') projected[item.class] += amount;
      if (item.status === 'accepted') accepted[item.class] += amount;
    });

    function net(parts) {
      return parts.statutory_entitlement + parts.contractual_payment + parts.voluntary_benefit - parts.lawful_deduction;
    }
    return Object.freeze({
      projected: Object.freeze(Object.assign({}, projected, { total: round2(net(projected)) })),
      finalized: Object.freeze(Object.assign({}, accepted, { total: round2(net(accepted)) }))
    });
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }

  function checksum(value) {
    const text = stableStringify(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return 'fnv1a32:' + (hash >>> 0).toString(16).padStart(8, '0');
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(key => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  function createStatementSnapshot(input) {
    input = input || {};
    if (!input.statementId || !input.calculatedAt || !input.acceptedAt) fail('Final snapshot identifiers and timestamps are required');
    if (!input.inputs || !Array.isArray(input.items)) fail('Final snapshot inputs and items are required');
    if (input.items.some(item => item.status !== 'accepted' && item.status !== 'rejected')) {
      fail('A final snapshot cannot contain draft or pending money items');
    }
    const copiedInputs = JSON.parse(JSON.stringify(input.inputs));
    const copiedItems = JSON.parse(JSON.stringify(input.items));
    const snapshot = {
      statementId: input.statementId,
      calculatedAt: input.calculatedAt,
      acceptedAt: input.acceptedAt,
      modelVersion: MODEL_VERSION,
      legalSourceVersion: LEGAL_SOURCE_VERSION,
      holidayCalendarVersion: input.holidayCalendarVersion,
      inputs: copiedInputs,
      inputChecksum: checksum(copiedInputs),
      items: copiedItems,
      totals: calculateStatementTotals(copiedItems),
      supersedesStatementId: input.supersedesStatementId || null
    };
    if (!snapshot.holidayCalendarVersion) fail('holidayCalendarVersion is required');
    return deepFreeze(snapshot);
  }

  const api = {
    MODEL_VERSION,
    LEGAL_SOURCE_VERSION,
    EVENT_TYPES,
    MONEY_CLASSES,
    APPROVAL_STATES,
    DEDUCTION_TYPES,
    SOURCE_URLS,
    MINIMUM_RATES,
    HOLIDAY_DEFINITIONS,
    addDays,
    addMonths,
    daysInclusive,
    round2,
    minimumRatesForContract,
    statutoryCalendar,
    entitlementWindow,
    calculateAverageDailyWages,
    restDayViolations,
    validateHolidayArrangement,
    deriveCollisionHoliday,
    validateContractTerms,
    validateDeductionBatch,
    calculateStatementTotals,
    stableStringify,
    checksum,
    createStatementSnapshot
  };

  global.HSLegalModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
