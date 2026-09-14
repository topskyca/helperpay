/* HelperPay — production legal-readiness gate for ID 407 statements.
 *
 * The legacy projection remains visible so existing users do not lose their
 * records. This gate is the authority for whether that projection may be
 * frozen and used to record a payment. Unsupported or ambiguous cases fail
 * closed and point the user to the official Labour Department calculator.
 */
(function (global) {
  'use strict';

  const Legal = global.HSLegalModel ||
    (typeof module !== 'undefined' && module.exports ? require('./legal-model.js') : null);
  if (!Legal) throw new Error('HSLegalModel must be loaded before HSCompliance');
  const HolidayReview = global.HSHolidayReview ||
    (typeof module !== 'undefined' && module.exports ? require('./holiday-review.js') : null);
  if (!HolidayReview) throw new Error('HSHolidayReview must be loaded before HSCompliance');
  const PayHistory = global.HSContractHistory ||
    (typeof module !== 'undefined' && module.exports ? require('./contract-history.js') : null);

  const HOLIDAY_CALENDAR_VERSION = 'hk-statutory-2026-2027-official-v1';
  const OFFICIAL_CALCULATOR = 'https://www.lr.labour.gov.hk/web/en/calculator/index.html';

  function item(code, en, zh, section) {
    return Object.freeze({ code, en, zh, section: section || 'settings' });
  }

  function expectedContractEnd(startDate) {
    try { return Legal.addDays(Legal.addMonths(startDate, 24), -1); } catch (error) { return ''; }
  }

  function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }

  function officialDates(year, winterChoice) {
    try { return Legal.statutoryCalendar(year, winterChoice).map(day => day.date); } catch (error) { return []; }
  }

  function hasAuditedCalendar(config, year) {
    return HolidayReview.hasAuditedCalendar(config, year);
  }

  function restDatesForWindow(config, start, end, Engine) {
    const dates = [];
    for (let date = start; date <= end; date = Legal.addDays(date, 1)) {
      if (Engine.classifyDay(date, config).isRest) dates.push(date);
    }
    return dates;
  }

  function findHolidayArrangement(config, statutoryDate) {
    return (config.holidays || []).find(day => day.altFor === statutoryDate &&
      (day.type === 'alternative_holiday' || day.type === 'substituted_holiday')) || null;
  }

  function assessMonth(input) {
    input = input || {};
    const config = input.config || {};
    const statement = input.statement || null;
    const logs = input.logs || {};
    const adjustments = input.adjustments || [];
    const Engine = input.engine || global.HSEngine;
    const blockers = [];
    const warnings = [];

    if (!statement) {
      blockers.push(item('no_statement', 'There is no employment statement for this month.', '本月沒有僱傭結算單。', 'salary'));
      return Object.freeze({ ready: false, blockers: Object.freeze(blockers), warnings: Object.freeze(warnings) });
    }

    if (config.contractType !== 'ID407') {
      blockers.push(item('contract_type', 'Confirm that this is the standard two-year foreign domestic helper contract.', '請確認這是香港外傭使用的標準兩年僱傭合約。'));
    }
    if (!isDate(config.contractSignedOn)) {
      blockers.push(item('contract_signed_on', 'Enter the date you and the helper signed the employment contract.', '請輸入你與外傭簽署僱傭合約的日期。'));
    }
    if (config.employmentStartPending === true) {
      blockers.push(item('contract_start', 'Copy the exact first employment day from the signed contract before confirming salary. The approximate month is for reference only.', '確認薪金前，請從已簽合約抄錄準確首個工作日；大概月份只供參考。'));
    } else if (!isDate(config.startDate)) {
      blockers.push(item('contract_start', 'Enter the contract start date.', '請輸入合約開始日期。'));
    }
    const expectedEnd = expectedContractEnd(config.startDate);
    if (!isDate(config.contractEndDate) || config.contractEndDate !== expectedEnd) {
      blockers.push(item('contract_end', 'Confirm the complete two-year employment period. Record early termination separately.', '請確認完整的兩年僱傭期；提早終止須另行記錄。'));
    }

    if (isDate(config.contractSignedOn)) {
      const minimum = Legal.minimumRatesForContract(config.contractSignedOn);
      if (!minimum) {
        blockers.push(item('rate_not_audited', 'This contract date is outside the audited minimum-rate table.', '此合約日期不在已審核的最低工資資料範圍內。'));
      } else {
        if (!(Number(config.monthlyWage) >= minimum.monthlyWage)) {
          blockers.push(item('below_maw', 'The monthly wage is below the minimum for this contract date.', '月薪低於該合約日期適用的規定最低工資。'));
        }
        if (config.foodMode === 'allowance' && !(Number(config.foodAllowance) >= minimum.foodAllowance)) {
          blockers.push(item('below_food_allowance', 'The food allowance is below the minimum for this contract date.', '膳食津貼低於該合約日期適用的最低金額。'));
        }
      }
    }
    if (config.foodMode !== 'provided' && config.foodMode !== 'allowance') {
      blockers.push(item('food_term', 'Confirm whether food is provided or a monthly allowance is paid.', '請確認是提供膳食，還是支付每月膳食津貼。'));
    }
    const restStart = config.startDate > Legal.addDays(statement.periodStart, -6) ? config.startDate : Legal.addDays(statement.periodStart, -6);
    const restHistory = PayHistory.restWindow(config, restStart, statement.periodEnd);
    if (restHistory.issue) blockers.push(item('rest_history_missing',
      'Rest-day terms do not cover this period completely. Review the effective dates; no global amount will be substituted.',
      '休息日條款未完整覆蓋此期間，請核對生效日期；系統不會改用全局金額。'));
    if (restHistory.periods.some(p => p.restDayPayTerm !== 'paid' && p.restDayPayTerm !== 'unpaid')) {
      blockers.push(item('rest_day_pay', 'Record whether rest days are paid or unpaid under the employment agreement.', '請記錄僱傭協議訂明休息日有薪或無薪。'));
    } else if (restHistory.periods.some(p => p.restDayPayTerm === 'unpaid')) {
      blockers.push(item('unpaid_rest_day', 'Unpaid rest-day payroll arithmetic is not supported in this release. Use the official calculator.', '此版本不支援無薪休息日的薪酬計算；請使用官方計算機。', 'salary'));
    }
    if (restHistory.periods.some(p => p.restDayWorkArrangement !== 'agreed_payment' && p.restDayWorkArrangement !== 'substituted_rest_day')) {
      blockers.push(item('rest_day_work_term', 'Record the agreed arrangement if a rest day is worked.', '請記錄在休息日工作時雙方同意的安排。'));
    }
    if (config.firstThreeMonthHolidayPayTerm !== 'paid' && config.firstThreeMonthHolidayPayTerm !== 'unpaid') {
      blockers.push(item('first_three_months', 'Record the contractual pay treatment for statutory holidays in the first three months.', '請記錄受僱首三個月內法定假日的合約薪酬安排。'));
    }
    if (config.winterHolidayChoice !== 'winter_solstice' && config.winterHolidayChoice !== 'christmas') {
      blockers.push(item('winter_choice', 'Choose Winter Solstice or Christmas Day as the contractual statutory holiday.', '請選擇冬節或聖誕節作為合約法定假日。'));
    }

    if (isDate(config.contractSignedOn) && isDate(config.startDate) && isDate(config.contractEndDate)) {
      const termErrors = Legal.validateContractTerms({
        contractType: config.contractType,
        contractSignedOn: config.contractSignedOn,
        startDate: config.startDate,
        endDate: config.contractEndDate,
        wagePeriods: config.wagePeriods || [],
        foodTerms: config.foodTerms || []
      });
      if (termErrors.length) {
        blockers.push(item('effective_terms',
          'Confirm complete, effective-dated wage and food terms for the full contract. Wage changes need a complete history.',
          '請確認完整合約期內按生效日期記錄的工資及膳食條款；如工資曾更改，須提供完整歷史。'));
      }
      const activeWage = (config.wagePeriods || []).find(period =>
        statement.periodStart >= period.effectiveFrom && statement.periodStart <= period.effectiveTo);
      if (!activeWage || Number(activeWage.monthlyWage) !== Number(statement.monthlyWage ?? config.monthlyWage)) {
        blockers.push(item('active_wage_period', 'The displayed monthly wage does not match a confirmed effective-dated wage period.', '畫面顯示的月薪與已確認的生效工資期間不符。'));
      }
      // A correct contractual history is not an actual-wages/ADW ledger. Do
      // not unlock statutory totals merely because a raise has been recorded.
      const from = Legal.addMonths(statement.periodStart, -12);
      const wageValues = new Set((config.wagePeriods || []).filter(p => p.effectiveFrom <= statement.periodEnd && p.effectiveTo >= from)
        .map(p => Number(p.monthlyWage)));
      if (wageValues.size > 1) blockers.push(item('variable_wage_average',
        'The relevant wage history includes a wage change. This release records the history but does not verify the resulting statutory average-wage entitlements; use the official calculator.',
        '相關工資歷史包含加薪或調整。此版本可保存歷史，但未能核證由此產生的法定平均工資權益，請使用官方計算機另行核對。', 'salary'));
    }
    if (statement.estimateUnavailable && !['rest_history_missing','absence_calculation','schedule_unconfirmed','partial_month'].includes(statement.estimateUnavailable)) blockers.push(item(statement.estimateUnavailable,
      statement.estimateUnavailable === 'intra_month_pay_change' ? 'Wage or food terms change during this month. A single monthly estimate would be misleading; calculate this month separately.' : 'The effective-dated wage or food history does not cover this month completely. Review the history before calculating.',
      statement.estimateUnavailable === 'intra_month_pay_change' ? '本月內工資或膳食安排有變，不能用單一月薪估算；請另行核算此月份。' : '按生效日期記錄的工資或膳食歷史未完整覆蓋本月，請先核對歷史。', 'salary'));

    const years = [];
    for (let year = +statement.periodStart.slice(0, 4); year <= +statement.periodEnd.slice(0, 4); year++) years.push(year);
    years.forEach(year => {
      if (!hasAuditedCalendar(config, year)) {
        blockers.push(item('holiday_calendar_' + year,
          year + ' is not using the complete audited statutory-holiday calendar.',
          year + ' 年未使用完整的已審核法定假日日曆。'));
      }
    });
    HolidayReview.problems(config, Engine, logs).filter(problem => !HolidayReview.validDate(problem.date) ||
      [problem.date, problem.sourceDate].some(date => date >= statement.periodStart && date <= statement.periodEnd))
      .forEach(problem => blockers.push(item('holiday_record_' + problem.index + '_' + problem.code,
        (problem.date || 'Undated record') + ': ' + HolidayReview.message(problem, 'en'),
        (problem.date || '未有日期的記錄') + '：' + HolidayReview.message(problem, 'zh-HK'))));

    if (statement.partial) {
      blockers.push(item('partial_month', 'First and final partial-month pay is not calculated by this release. Use the official calculator.', '此版本不計算首月或最後一個非完整月份的薪酬；請使用官方計算機。', 'salary'));
    }

    const pendingCount = Object.keys(logs).filter(date => date >= statement.periodStart && date <= statement.periodEnd &&
      logs[date] && logs[date].status === 'pending').length;
    Object.keys(logs).filter(date => date >= statement.periodStart && date <= statement.periodEnd && logs[date]?.dayTypeUnconfirmed)
      .forEach(date => blockers.push(item('day_type_review_' + date,
        date + ': work / no-work was recorded while its day type was unknown. Review this date before calculating pay.',
        date + '：有否上班是在當日類型未知時記錄，請先核對此日期，再計算薪金。', 'calendar')));
    if (pendingCount) {
      blockers.push(item('pending_logs', 'Approve or reject every helper entry before finalising.', '凍結結算單前，請批准或拒絕所有外傭記錄。', 'today'));
    }

    const unapprovedLines = (statement.lines || []).filter(line => line.pending);
    if (unapprovedLines.length && !pendingCount) {
      blockers.push(item('pending_money', 'Pending entries are excluded from finalised totals.', '待批准項目不會計入已凍結總額。', 'today'));
    }

    const absenceDates = Object.keys(logs).filter(date => date >= statement.periodStart && date <= statement.periodEnd &&
      (Engine.isAbsence(logs[date]) || (!logs[date]?.dayTypeUnconfirmed && !Engine.classifyDay(date,config).scheduleUnconfirmed && Engine.classifyDay(date,config).type === 'normal' && typeof logs[date]?.work === 'number' && logs[date].work < 1)));
    if (absenceDates.length || (statement.lines || []).some(line => line.kind === 'deduction')) {
      blockers.push(item('absence_calculation', 'Leave or absence is recorded. This version does not calculate leave pay, balances or absence deductions. Review the actual entitlement and pay separately; recording leave never makes it unpaid.', '本月有請假／缺勤記錄。此版本不計算假期薪酬、餘額或缺勤扣款；請另行核對實際權益及薪酬，記錄請假不等於無薪。', 'salary'));
      absenceDates.forEach(date => {
        const entry=logs[date], confirmed=Engine.validAbsence(entry) && entry.absence.kind !== 'unknown' && entry.absence.duration !== 'unknown';
        if (!confirmed || Engine.classifyDay(date,config).type !== 'normal') blockers.push(item('absence_record_'+date,
          date+': check the leave category, actual duration and day type. Old half/full-day markers are not verified leave facts.',
          date+'：請核對請假類型、實際時間及當日類型。舊半日／全日標記不是已核對的請假資料。','calendar'));
      });
    }
    const averageFrom=Legal.addMonths(statement.periodStart,-12);
    if (Object.keys(logs).some(date=>date>=averageFrom && date<statement.periodStart && Engine.isEmployedOn(date,config) &&
      (Engine.isAbsence(logs[date]) || (Engine.classifyDay(date,config).type==='normal' && typeof logs[date]?.work==='number' && logs[date].work<1)))) {
      blockers.push(item('absence_average_history',
        'The preceding 12-month history includes leave, absence or unclassified no-work records. This version cannot verify the resulting statutory average wages or disregard periods; check these entitlements separately.',
        '之前12個月歷史有請假、缺勤或未分類的不上班記錄。此版本未能核證相關法定平均工資及須剔除的期間，請另行核對權益。','salary'));
    }

    const monthHolidays = (config.holidays || []).filter(day => day.date >= statement.periodStart && day.date <= statement.periodEnd &&
      (day.type === 'statutory_holiday' || day.officialId));
    if (config.firstThreeMonthHolidayPayTerm === 'unpaid' && monthHolidays.some(day =>
      config.startDate && day.date < Legal.addMonths(config.startDate, 3))) {
      blockers.push(item('unpaid_early_holiday', 'An unpaid statutory holiday occurs in the first three months. This release will not invent a deduction formula.', '首三個月內有無薪法定假日；此版本不會猜測扣款公式。', 'salary'));
    }

    if (Engine && isDate(config.startDate)) {
      const checkStart = config.startDate > Legal.addDays(statement.periodStart, -6) ? config.startDate : Legal.addDays(statement.periodStart, -6);
      const restDays = restDatesForWindow(config, checkStart, statement.periodEnd, Engine);
      const violations = Legal.restDayViolations(checkStart, statement.periodEnd, restDays);
      if (violations.length) {
        blockers.push(item('rest_day_window', 'At least one rolling seven-day period has no recorded rest day.', '至少有一個連續七日期間沒有記錄休息日。', 'calendar'));
      }

      Object.keys(logs).filter(date => date >= statement.periodStart && date <= statement.periodEnd).forEach(date => {
        const entry = logs[date];
        if (!entry || !(entry.work > 0)) return;
        const cls = Engine.classifyDay(date, config);
        if (cls.isRest) {
          if (entry.restWorkVoluntary !== true) {
            blockers.push(item('rest_work_voluntary_' + date,
              'Confirm that rest-day work on ' + date + ' was voluntary, or obtain professional advice for an emergency case.',
              '請確認 ' + date + ' 的休息日工作屬自願；如屬緊急情況，請先取得專業意見。', 'calendar'));
          }
          if (cls.restTerms.restDayWorkArrangement === 'agreed_payment' && !(Number(cls.restTerms.restDayWorkPayment) > 0)) {
            blockers.push(item('rest_work_amount_' + date, 'Enter the mutually agreed cash amount for rest-day work on ' + date + '.', '請輸入雙方就 ' + date + ' 休息日工作同意的現金金額。', 'settings'));
          }
          if (cls.restTerms.restDayWorkArrangement === 'substituted_rest_day') {
            const substitute = (config.holidays || []).find(day => day.restFor === date && day.type === 'substituted_rest_day');
            if (!substitute || substitute.date <= date || substitute.date > Legal.addDays(date, 30) || substitute.mutualAgreement !== true) {
              blockers.push(item('rest_work_substitute_' + date, 'Record the mutually agreed substituted rest day within 30 days after ' + date + '.', '請記錄在 ' + date + ' 後30日內雙方同意的補回休息日。', 'calendar'));
            }
          }
        }
        if (cls.holiday && (cls.holiday.type === 'statutory_holiday' || cls.holiday.officialId)) {
          const arrangement = findHolidayArrangement(config, date);
          if (!arrangement) {
            blockers.push(item('alternative_holiday_' + date, 'Record the alternative holiday and required notice for statutory-holiday work on ' + date + '.', '請記錄在 ' + date + ' 法定假日工作所需的另定假日及通知。', 'today'));
          } else {
            const errors = Legal.validateHolidayArrangement({
              type: arrangement.type,
              statutoryDate: date,
              alternativeDate: arrangement.alternativeDate,
              date: arrangement.date,
              noticeAt: arrangement.noticeAt,
              workStartsAt: arrangement.workStartsAt,
              mutualAgreement: arrangement.mutualAgreement
            });
            if (errors.length) blockers.push(item('holiday_arrangement_' + date, errors.join(' '),
              !arrangement.workStartsAt ? date + ' 的假日工作開始時間未記錄，請補核香港時間後檢查48小時通知。' : date + ' 的假日安排、實際工作開始時間或48小時通知須核對。', 'today'));
          }
        } else if (cls.holiday && (cls.holiday.type === 'alternative_holiday' ||
          cls.holiday.type === 'substituted_holiday' || cls.holiday.type === 'rest_day_collision_holiday')) {
          blockers.push(item('protected_holiday_work_' + date,
            'Work recorded on a replacement holiday is not supported for finalisation. Arrange and record a compliant day off.',
            '替補假日被記錄為工作日；此版本不支援把該情況凍結，請另行安排及記錄合規假日。', 'calendar'));
        }
      });

      for (let date = statement.periodStart; date <= statement.periodEnd; date = Legal.addDays(date, 1)) {
        const cls = Engine.classifyDay(date, config);
        if (cls.isRest && cls.holiday && (cls.holiday.type === 'statutory_holiday' || cls.holiday.officialId)) {
          if (!(config.holidays || []).some(day => day.collisionFor === date && day.type === 'rest_day_collision_holiday')) {
            blockers.push(item('collision_holiday_' + date, 'Record the exact additional holiday required because ' + date + ' is both a rest day and statutory holiday.', '請記錄因 ' + date + ' 同為休息日及法定假日而須另行安排的準確假日。', 'calendar'));
          }
        }
      }
    }

    adjustments.forEach((adjustment, index) => {
      if (adjustment.class !== 'voluntary_benefit' || adjustment.status !== 'accepted' || !(Number(adjustment.amount) > 0)) {
        blockers.push(item('adjustment_' + index, 'Legacy or unrestricted adjustments cannot enter a finalised total. Re-enter only a positive voluntary payment.', '舊有或不受限制的調整不能計入凍結總額；只可重新輸入正數的自願付款。', 'salary'));
      }
    });

    if (!blockers.length) {
      warnings.push(item('reference_only', 'Ready to freeze as a record, but HelperPay remains a reference tool and not legal advice.', '資料可凍結為記錄，但 HelperPay 仍只是參考工具，並非法律意見。', 'salary'));
    }
    return Object.freeze({
      ready: blockers.length === 0,
      blockers: Object.freeze(blockers),
      warnings: Object.freeze(warnings),
      modelVersion: Legal.MODEL_VERSION,
      legalSourceVersion: Legal.LEGAL_SOURCE_VERSION,
      holidayCalendarVersion: HOLIDAY_CALENDAR_VERSION,
      officialCalculator: OFFICIAL_CALCULATOR
    });
  }

  function acceptedMoneyItems(statement, config, adjustments) {
    if (statement.estimateUnavailable) throw new Error('An unresolved wage history cannot create accepted money items');
    const items = [
      { id: 'contract-wage', class: 'contractual_payment', amount: Legal.round2(statement.base), status: 'accepted', label: 'Contract wage' }
    ];
    if (statement.food > 0) items.push({
      id: 'food-allowance', class: 'contractual_payment', amount: Legal.round2(statement.food), status: 'accepted', label: 'Food allowance'
    });
    (statement.lines || []).forEach((line, index) => {
      if (line.kind !== 'allowance' || line.pending) return;
      items.push({
        id: 'line-' + index,
        class: 'voluntary_benefit',
        amount: Legal.round2(line.amount == null ? line.days * statement.dailyWage : line.amount),
        status: 'accepted',
        label: line.label,
        sourceDate: line.date
      });
    });
    (adjustments || []).forEach(adjustment => items.push({
      id: adjustment.id,
      class: 'voluntary_benefit',
      amount: Legal.round2(Number(adjustment.amount)),
      status: 'accepted',
      label: adjustment.label
    }));
    return items;
  }

  const api = {
    HOLIDAY_CALENDAR_VERSION,
    OFFICIAL_CALCULATOR,
    expectedContractEnd,
    officialDates,
    hasAuditedCalendar,
    assessMonth,
    acceptedMoneyItems
  };

  global.HSCompliance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
