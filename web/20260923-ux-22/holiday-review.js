/* Explicit calendar reconciliation. No inferred agreement, work or payment.
 * Earlier calendar versions are retained in config.holidayRevisions. */
(function (global) {
  'use strict';
  const Legal = global.HSLegalModel || (typeof module !== 'undefined' ? require('./legal-model.js') : null);
  const Holidays = global.HSHolidays || (typeof module !== 'undefined' ? require('./holidays.js') : null);
  const TYPES = ['statutory_holiday', 'alternative_holiday', 'substituted_holiday', 'rest_day_collision_holiday', 'substituted_rest_day', 'contractual_holiday'];
  const links = ['altFor', 'collisionFor', 'restFor'];
  const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
  const linked = row => links.some(key => !!row[key]);
  const messages = {
    date:['Enter a valid date.','請輸入有效日期。'], legacy_type:['The old record has no confirmed holiday type.','舊記錄未確認假日類型。'],
    duplicate_date:['More than one record uses this date. Review each one; do not delete them together.','同日有多筆記錄，請逐筆核對，不要一次刪除。'],
    multiple_sources:['This record points to conflicting source days.','此記錄連結至多個不同類型的原日期。'],
    official_mismatch:['This does not match the selected official calendar. Use Review official calendar.','此記錄與所選官方日曆不符，請使用「核對官方日曆」。'],
    unexpected_source:['An additional contractual holiday must not replace a statutory entitlement.','額外合約假日不可當作補回法定權益。'],
    source:['Select the actual source day. A statutory source must first be confirmed in the official calendar.','請選擇實際原日期；如屬法定假日，須先在官方日曆確認。'],
    duplicate_source:['Several arrangements point to the same source day. Review the original agreements.','多筆安排連結至同一原日期，請核對實際協議。'],
    outside_contract:['The source and arranged day must be within employment.','原日期及安排日期須在僱傭期內。'],
    target_conflict:['The arranged day already falls on a rest day or another holiday.','安排日期已是休息日或其他假日。'],
    work_time:['Record the actual work start time on the source holiday, in Hong Kong time.','請記錄原假日實際開始工作的香港時間。'],
    notice:['Record when notice was actually given, at least 48 hours before work. Do not enter a future notice as already given.','請記錄實際發出通知的時間，須比開始工作最少早48小時；不可將未來通知當作已發出。'],
    agreement:['Confirm the actual mutual agreement, not an assumed agreement.','請確認雙方實際同意，不可假設已同意。'],
    arrangement:['Check the permitted date range: alternative holiday ±60 days; substituted holiday ±30 days from the original statutory holiday in this app.','請核對日期範圍：另定假日在原法定假日前後60日內；此版本的代替假日在原法定假日前後30日內。'],
    unsupported_reference:['A substituted holiday based on a separate alternative holiday needs independent review; this editor cannot validate it.','以另一另定假日為基準的代替假日須另行核對，此編輯器未能驗證。'],
    source_rest:['The source date is not a recorded rest day.','原日期並非已記錄的休息日。'],
    collision_date:['The collision holiday must be the next eligible day. Expected: ','假日與休息日重疊後須安排下一個合資格日，應為：'],
    rest_range:['This editor supports an agreed substituted rest day within 30 days after the worked rest day.','此編輯器支援在工作休息日後30日內雙方同意的補回休息日。'],
    worked_replacement:['Work is recorded on this arranged day off. A date on the calendar does not mean time off was taken; review the entitlement separately.','此補假日有工作記錄；日曆上有日期不代表已放假，須另行核對權益。'],
    reason:['Explain the correction or its supporting record.','請填寫更正原因或核對依據。'], name:['Enter a name.','請輸入名稱。'],
    confirmation:['Confirm that this is a checked record, not a new or assumed agreement.','請確認資料已核對，並非新增或假設的協議。'],
    protected_official:['The selected official statutory holiday cannot be removed. Review the official calendar instead.','不可刪除所選的官方法定假日，請改用官方日曆核對。'],
    type:['Choose the actual holiday type.','請選擇實際假日類型。']
  };
  function message(issue, language) {
    const pair=messages[issue.code] || ['Review this record before using it.','請先核對此記錄。'];
    return pair[language==='zh-HK'?1:0] + (issue.code==='collision_date' ? (issue.detail || '—') : '');
  }
  const official = choice => ['winter_solstice','christmas'].includes(choice) ? Holidays.defaultHolidays(choice) : [];
  const sameOfficial = (row, expected) => !!expected && row.type === 'statutory_holiday' && row.date === expected.date &&
    row.officialId === expected.officialId && row.calendarVersion === expected.calendarVersion && !linked(row);

  function hasAuditedCalendar(config, year) {
    const expected = official(config.winterHolidayChoice).filter(row => row.date.startsWith(year + '-'));
    const actual = (config.holidays || []).filter(row => (row.type === 'statutory_holiday' || row.officialId) &&
      (String(row.date).startsWith(year + '-') || String(row.officialId).startsWith(year + ':')));
    return expected.length === 15 && actual.length === 15 &&
      expected.every(row => actual.filter(item => sameOfficial(item, row)).length === 1);
  }

  function plan(config, choice) {
    if (!['winter_solstice','christmas'].includes(choice)) throw Error('winter_choice');
    const current = config.holidays || [], next = current.map(row => ({ ...row })), changes = [];
    for (const expected of official(choice)) {
      const candidates = current.map((row,index)=>({row,index})).filter(({row}) => !linked(row) &&
        (row.officialId === expected.officialId || ((!row.type || row.type === 'statutory_holiday') && row.date === expected.date)));
      // Dates alone cannot choose between duplicate records. Leave every one
      // visible for individual review; never drop the extra row automatically.
      if (candidates.length > 1) { changes.push({ kind:'conflict', expected, indices:candidates.map(item=>item.index) }); continue; }
      if (candidates.length === 1) {
        const { row, index } = candidates[0];
        next[index] = { ...row, ...expected };
        if (!sameOfficial(row, expected) || row.name !== expected.name || row.source !== expected.source) changes.push({ kind:'update', index, before:row, after:next[index] });
      } else {
        // Recognise only the old pre-audit winter-choice label; not arbitrary
        // custom dates near Christmas. Both the move and linked records appear
        // in the preview, and the original row is retained in the revision.
        const oldWinter = /:winter_holiday$/.test(expected.officialId) ? current.map((row,index)=>({row,index})).filter(({row}) =>
          !row.type && !linked(row) && row.date?.slice(0,4) === expected.date.slice(0,4) &&
          /-12-(22|25)$/.test(row.date) && /^(Chinese Winter Solstice Festival or Christmas Day|Christmas Day|Chinese Winter Solstice Festival|冬節|聖誕節)$/.test(row.name || '')) : [];
        if (oldWinter.length === 1) {
          const {row,index}=oldWinter[0]; next[index]={...row,...expected};changes.push({kind:'update',index,before:row,after:next[index]});
        } else { next.push({...expected}); changes.push({kind:'add',after:expected}); }
      }
    }
    const moved = changes.filter(change=>change.before && change.before.date !== change.after.date).map(change=>change.before.date);
    return { changes, linked: current.map((row,index)=>({row,index})).filter(({row})=>moved.some(date=>links.some(key=>row[key]===date))),
      next: {...config,winterHolidayChoice:choice,holidays:next,holidayCalendarVersion:Holidays.CALENDAR_VERSION} };
  }

  function problems(config, engine, logs = {}) {
    const rows = config.holidays || [], expected = official(config.winterHolidayChoice), out = [];
    const sourceFor = date => rows.find(row=>row.date===date && sameOfficial(row,expected.find(item=>item.date===date)));
    rows.forEach((row,index)=>{
      const add = (code, detail) => { if (!out.some(item=>item.index===index&&item.code===code)) out.push({index,date:row.date,sourceDate:row.altFor||row.collisionFor||row.restFor,code,detail}); };
      if (!validDate(row.date)) { add('date'); return; }
      if (!TYPES.includes(row.type)) add('legacy_type');
      if (rows.filter(other=>other.date===row.date).length>1) add('duplicate_date');
      const sourceKeys=links.filter(key=>row[key]);
      if (sourceKeys.length>1) add('multiple_sources');
      if (row.type==='statutory_holiday' || row.officialId) {
        if (!sameOfficial(row,expected.find(item=>item.officialId===row.officialId))) add('official_mismatch');
      }
      if (row.type==='contractual_holiday' && linked(row)) add('unexpected_source');
      if (['alternative_holiday','substituted_holiday','rest_day_collision_holiday','substituted_rest_day'].includes(row.type)) {
        const key = row.type==='rest_day_collision_holiday' ? 'collisionFor' : row.type==='substituted_rest_day' ? 'restFor' : 'altFor';
        const source=row[key];
        if (!validDate(source) || (key!=='restFor' && !sourceFor(source))) add('source');
        if (source && rows.filter(other=>other[key]===source).length>1) add('duplicate_source');
        if (engine && (!engine.isEmployedOn(row.date,config) || (validDate(source)&&!engine.isEmployedOn(source,config)))) add('outside_contract');
        if (engine && engine.classifyDay(row.date,{...config,holidays:rows.filter((_,i)=>i!==index)}).type!=='normal') add('target_conflict');
        if (key==='altFor') {
          for(const detail of Legal.validateHolidayArrangement({...row,statutoryDate:source})) {
            add(/workStartsAt/.test(detail)?'work_time':/noticeAt|48 hours/.test(detail)?'notice':/mutual/.test(detail)?'agreement':'arrangement',detail);
          }
          if (row.alternativeDate && row.alternativeDate!==source) add('unsupported_reference');
        } else if (key==='collisionFor' && engine && validDate(source)) {
          if (!engine.classifyDay(source,config).isRest) add('source_rest');
          const available=engine.nextFreeDay({...config,holidays:rows.filter((_,i)=>i!==index)},source);
          if (row.date!==available) add('collision_date',available);
        } else if (key==='restFor' && validDate(source)) {
          if (engine&&!engine.classifyDay(source,config).isRest) add('source_rest');
          if (row.date<=source || row.date>Legal.addDays(source,30)) add('rest_range');
          if (row.mutualAgreement!==true) add('agreement');
        }
        if (logs[row.date]?.work>0) add('worked_replacement');
      }
    });
    return out;
  }

  function revision(config, next, meta, kind) {
    if (!String(meta?.reason || '').trim()) throw Error('reason');
    if (!meta?.id || !meta?.recordedAt) throw Error('metadata');
    const copy=value=>JSON.parse(JSON.stringify(value));
    return {...next,holidayRevisions:[...(config.holidayRevisions||[]),{
      id:meta.id,recordedAt:meta.recordedAt,reason:meta.reason.trim(),kind,
      before:copy({winterHolidayChoice:config.winterHolidayChoice||null,holidays:config.holidays||[],holidayCalendarVersion:config.holidayCalendarVersion||null}),
      after:copy({winterHolidayChoice:next.winterHolidayChoice||null,holidays:next.holidays,holidayCalendarVersion:next.holidayCalendarVersion||null})
    }]};
  }
  function applyPlan(config, choice, meta) { return revision(config,plan(config,choice).next,meta,'official_calendar_review'); }

  function edit(config,index,draft,meta,engine,logs) {
    const rows=config.holidays||[],before=rows[index];
    if (!before || !Number.isInteger(index)) throw Error('missing_record');
    const expected=official(config.winterHolidayChoice),canonical=expected.find(row=>sameOfficial(before,row));
    if (canonical && (!draft.archive || rows.filter(row=>sameOfficial(row,canonical)).length<2)) throw Error('protected_official');
    if (draft.confirmed!==true) throw Error('confirmation');
    let holidays;
    if (draft.archive) holidays=rows.filter((_,i)=>i!==index);
    else {
      if (!TYPES.includes(draft.type) || draft.type==='statutory_holiday') throw Error('type');
      const updated={...before,date:draft.date,name:String(draft.name||'').trim(),type:draft.type};
      for(const key of [...links,'officialId','source','calendarVersion','noticeAt','workStartsAt','mutualAgreement','alternativeDate']) delete updated[key];
      if (!updated.name) throw Error('name');
      if (!validDate(updated.date)) throw Error('date');
      if (draft.type==='alternative_holiday'||draft.type==='substituted_holiday') Object.assign(updated,{altFor:draft.sourceDate,noticeAt:draft.noticeAt,workStartsAt:draft.workStartsAt,mutualAgreement:draft.mutualAgreement===true});
      if (before.alternativeDate && before.alternativeDate!==before.altFor && draft.type!=='contractual_holiday') throw Error('unsupported_reference');
      if (updated.noticeAt && (!Number.isFinite(Date.parse(meta?.recordedAt)) || Date.parse(updated.noticeAt)>Date.parse(meta.recordedAt))) throw Error('notice');
      if (draft.type==='rest_day_collision_holiday') updated.collisionFor=draft.sourceDate;
      if (draft.type==='substituted_rest_day') Object.assign(updated,{restFor:draft.sourceDate,mutualAgreement:draft.mutualAgreement===true});
      holidays=rows.map((row,i)=>i===index?updated:row);
      const issues=problems({...config,holidays},engine,logs).filter(issue=>issue.index===index && issue.code!=='worked_replacement');
      if (issues.length) throw Object.assign(Error(issues[0].code),{issues});
    }
    return revision(config,{...config,holidays},meta,draft.archive?'archive_incorrect_holiday':'holiday_record_review');
  }

  function add(config,draft,meta,engine) {
    if(draft.type!=='contractual_holiday') throw Error('type');
    const seeded={...config,holidays:[...(config.holidays||[]),{}]};
    const checked=edit(seeded,config.holidays?.length||0,draft,meta,engine,{});
    return revision(config,{...config,holidays:checked.holidays},meta,'additional_contractual_holiday');
  }
  const api={TYPES,validDate,hasAuditedCalendar,plan,problems,applyPlan,edit,add,message,revision};
  global.HSHolidayReview=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
