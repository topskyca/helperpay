/* HelperPay — application UI.
 *
 * Vanilla JS, no build step. Views: Today (quick logging), Calendar,
 * Salary (statement + payments + approvals), Settings.
 *
 * Two usage modes on one shared phone:
 *   employer mode — everything
 *   helper mode   — log days, view salary, approve payments (Settings and
 *                   money-editing actions hidden; exit guarded by employer PIN)
 */
(function () {
  'use strict';

  const E = window.HSEngine;
  const Legal = window.HSLegalModel;
  const Compliance = window.HSCompliance;
  const Store = window.HSStore;
  const Holidays = window.HSHolidays;
  const I18n = window.HSI18n;

  const APP_VERSION = '1.1.0-web-free';
  const FEEDBACK_EMAIL = 'yonghe@affluentbyte.hk';
  const WHATSAPP_DISPLAY = '+852 5229 5286';

  // Native-only subscription check. Never replaces statutory calculation checks.
  function requireMembership() {
    return window.HSBilling.request('record', { helperMode: state.ui.helperMode });
  }

  function bindNativeRestore(button, input) {
    if (!button || !input) return;
    button.onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files[0];
      input.value = ''; // Allow retrying the same file after cancellation/error.
      if (!file || !(await confirmDialog(L('Restore backup?', '還原備份？'),
        L('Only a DEMO backup can replace these sample records. Real payroll backups are rejected.', '只可用示範備份取代樣本紀錄，真實薪酬備份將被拒絕。'), L('Restore', '還原'), true))) return;
      button.disabled = true;
      try {
        const backup = await window.HSNativeBackup.readFile(file);
        await window.HSReminders?.reset();
        await Store.importAll(backup);
        await window.HSReminders?.resume();
        state.addingProfile = false;
        state.pendingEmployerDefaults = null;
        state.onboardingStep = 1;
        loadActiveProfile();
        render();
        toast(L('Backup restored', '備份已還原'));
      } catch (error) {
        toast(window.HSNativeBackup.errorMessage(error, state.ui.language));
      } finally { button.disabled = false; await window.HSReminders?.resume(); }
    };
  }


  function refreshNativeReminders() {
    if (!window.HSReminders) return; // Demo never loads the OS bridge.
    window.HSReminders.afterRender({
      snapshot: () => ({
        language: state.ui.language, helperMode: state.ui.helperMode,
        view: state.ui.view, configured: !!state.config && !state.addingProfile,
        activeId: Store.profiles.active(),
        profiles: Store.profiles.list().map(id => ({ id,
          config: Store.profiles.loadFor(id, 'config', null),
          logs: Store.profiles.loadFor(id, 'logs', {}) }))
      }), openSheet, closeSheet, toast,
      navigate: event => {
        // Notification taps cannot bypass helper mode or its employer PIN.
        if (state.ui.helperMode && event.profileId !== Store.profiles.active()) return;
        if (!Store.profiles.list().includes(event.profileId)) return;
        Store.profiles.setActive(event.profileId); loadActiveProfile();
        if (!state.config) return;
        if (event.type === 'pay' || event.type === 'final') {
          state.ui.view = 'salary'; state.salY = +event.monthKey.slice(0, 4); state.salM = +event.monthKey.slice(5, 7);
          saveUi(); render(); return;
        }
        state.ui.view = 'calendar'; state.calY = +event.date.slice(0, 4); state.calM = +event.date.slice(5, 7);
        saveUi(); render();
        if (event.type === 'lieu' && !state.ui.helperMode) {
          const owed = E.owedAlternativeHolidays(state.config, state.logs).find(o => o.date === event.sourceDate);
          if (owed && state.logs[owed.date]?.status !== 'pending') { openScheduleAltSheet(owed); return; }
        }
        openDaySheet(event.sourceDate || event.date);
      }
    });
  }
  // ---------- state ----------

  Store.migrate(); // legacy single-helper data -> profile layout

  const state = {
    config: Store.loadConfig(),
    logs: Store.loadLogs(),
    payments: Store.loadPayments(),
    adjustments: Store.loadAdjustments(),
    statements: Store.loadStatements(),
    ui: Object.assign({
      view: 'today',
      helperMode: false,
      analyticsConsent: false,
      language: I18n.detectLanguage(navigator.languages && navigator.languages.length
        ? navigator.languages : [navigator.language])
    }, Store.loadUi()),
    addingProfile: false,          // true while the "add another helper" setup is open
    onboardingStep: 1,            // first-run guidance; profile setup is the final step
    pendingEmployerDefaults: null  // employer name/PIN carried into a new profile
  };
  if (window.HSAnalytics) window.HSAnalytics.setConsent(state.ui.analyticsConsent === true);

  function whatsappUrl() {
    return 'https://wa.me/85252295286?text=' + encodeURIComponent(L(
      'Hi! I’m using HelperPay — ',
      '你好！我正在使用 HelperPay — '
    ));
  }

  function loadActiveProfile() {
    state.config = Store.loadConfig();
    state.logs = Store.loadLogs();
    state.payments = Store.loadPayments();
    state.adjustments = Store.loadAdjustments();
    state.statements = Store.loadStatements();
  }
  const now = new Date('2026-06-30T12:00:00');
  state.calY = now.getFullYear(); state.calM = now.getMonth() + 1;
  state.salY = now.getFullYear(); state.salM = now.getMonth() + 1;

  const objectUrls = new Map(); // fileId -> objectURL cache

  // ---------- tiny helpers ----------

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function isZh() { return state.ui.language === I18n.ZH_HK; }
  function L(english, chinese) { return I18n.choose(state.ui.language, english, chinese); }
  function weekdays() { return I18n.weekdays(state.ui.language); }
  function weekdaysShort() { return I18n.weekdaysShort(state.ui.language); }
  function monthYear(year, month) { return I18n.monthYear(year, month, state.ui.language); }
  function holidayName(name) { return I18n.holidayName(name, state.ui.language); }

  function applyLanguageMetadata() {
    document.documentElement.lang = state.ui.language;
    document.title = L(
      'HelperPay — HK domestic helper salary tracker',
      'HelperPay — 香港外傭薪金記錄'
    );
    window.dispatchEvent(new CustomEvent('helperpay-language-change', {
      detail: { language: state.ui.language }
    }));
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function money(x) { return E.fmtMoney(x); }

  function fmtDate(ds) {
    return I18n.formatDate(ds, state.ui.language);
  }

  function fmtDateShort(ds) {
    return I18n.formatDateShort(ds, state.ui.language);
  }

  function daysLabel(d, signed) {
    const sign = signed || '';
    if (d === 0.5) return sign + L('½ day', '半日');
    return sign + d + L(' day' + (d === 1 ? '' : 's'), '日');
  }

  function saveUi() {
    Store.saveUi({
      view: state.ui.view,
      helperMode: state.ui.helperMode,
      language: state.ui.language,
      analyticsConsent: state.ui.analyticsConsent === true
    });
  }
  function saveConfig() { Store.saveConfig(state.config); }
  function saveLogs() { Store.saveLogs(state.logs); }
  function savePayments() { Store.savePayments(state.payments); }
  function saveAdjustments() { Store.saveAdjustments(state.adjustments); }
  function saveStatements() { Store.saveStatements(state.statements); }

  function dayTypeName(cls) {
    if (!isZh()) return E.describeType(cls);
    if (cls.type === 'rest+holiday') return '休息日及' + holidayName(cls.holiday.name);
    if (cls.type === 'holiday') return holidayName(cls.holiday.name);
    if (cls.type === 'rest') return '休息日';
    return '工作日';
  }

  function statementLineLabel(line) {
    if (!isZh()) return line.label;
    const cls = E.classifyDay(line.date, state.config);
    if (line.kind === 'deduction') {
      return line.days === 1 ? '全日無薪假' : '半日無薪假';
    }
    if (line.kind === 'allowance') {
      return dayTypeName(cls) + ' — 已上班' + (line.days === 0.5 ? '半日' : '');
    }
    if (line.kind === 'holiday-worked') {
      return holidayName(cls.holiday && cls.holiday.name) + ' — 已上班（須另定假日；沒有自動現金補償）';
    }
    if (line.kind === 'rest-day-worked') {
      return '休息日 — 已上班（補償按雙方協議；沒有自動現金補償）';
    }
    return line.label;
  }

  function statementText(stmt, extras) {
    return L('DEMO ONLY — not proof of payment', '只供示範 — 不可作付款證明') + '\n' + demoStatementText(stmt, extras);
  }
  function demoStatementText(stmt, extras) {
    if (!isZh()) return E.statementText(stmt, state.config, extras);
    extras = extras || {};
    const lines = [];
    lines.push('薪金結算單 — ' + monthYear(stmt.year, stmt.month));
    if (state.config.helperName) lines.push('外傭：' + state.config.helperName);
    lines.push('期間：' + stmt.periodStart + ' 至 ' + stmt.periodEnd);
    lines.push('參考日率（不適用於所有法定權益）：' + money(state.config.monthlyWage) + ' × 12 ÷ 365 = HK$' + stmt.dailyWage.toFixed(4));
    lines.push('');
    lines.push(stmt.partial
      ? '基本薪金（' + stmt.periodDays + '日 × 每日工資）：' + money(stmt.base)
      : '基本薪金（月薪）：' + money(stmt.base));
    if (stmt.food > 0) lines.push('膳食津貼：' + money(stmt.food));

    const deductions = stmt.lines.filter(line => line.kind === 'deduction');
    const allowances = stmt.lines.filter(line => line.kind === 'allowance');
    const information = stmt.lines.filter(line => line.kind === 'holiday-worked');
    if (deductions.length) {
      lines.push('', '無薪假扣款（−' + stmt.deductionDays + '日）：');
      deductions.forEach(line => lines.push('  ' + line.date + '  ' + statementLineLabel(line) + '  −' +
        money(line.amount) + (line.pending ? '（待僱主批准）' : '')));
    }
    if (allowances.length) {
      lines.push('', '休息日／法定假日額外工作（+' + stmt.allowanceDays + '日）：');
      allowances.forEach(line => lines.push('  ' + line.date + '  ' + statementLineLabel(line) + '  +' +
        money(line.amount) + (line.pending ? '（待僱主批准）' : '')));
    }
    if (information.length) {
      lines.push('', '曾於法定假日工作（須補假，沒有額外薪金）：');
      information.forEach(line => lines.push('  ' + line.date + '  ' + statementLineLabel(line)));
    }
    if (extras.adjustments && extras.adjustments.length) {
      lines.push('', '調整：');
      extras.adjustments.forEach(item => lines.push('  ' + item.label + '：' +
        (item.amount >= 0 ? '+' : '') + money(item.amount)));
    }
    lines.push('');
    let due = stmt.totalExact;
    (extras.adjustments || []).forEach(item => { due += item.amount; });
    lines.push('參考估算：' + money(due));
    if (extras.paid) {
      lines.push('已付：' + money(extras.paid));
      lines.push('尚欠：' + money(due - extras.paid));
    }
    return lines.join('\n');
  }

  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--tabbar-h) + 18px);' +
        'background:var(--text);color:var(--bg);padding:9px 18px;border-radius:999px;font-size:13.5px;' +
        'font-weight:700;z-index:80;opacity:0;transition:opacity .18s;pointer-events:none;max-width:88vw;text-align:center;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 1900);
  }

  // ---------- sheets / modals ----------

  function openSheet(html, opts) {
    html = '<p class="demo-tag">' + L('DEMO ONLY — not a real payroll record', '只供示範 — 並非真實薪酬紀錄') + '</p>' + html;
    opts = opts || {};
    const root = $('#sheet-root');
    const overlay = document.createElement('div');
    overlay.className = 'overlay' + (opts.center ? ' center' : '');
    overlay.innerHTML = '<div class="sheet">' + (opts.center ? '' : '<div class="grab"></div>') + html + '</div>';
    overlay.addEventListener('click', e => { if (e.target === overlay && !opts.sticky) closeSheet(overlay); });
    root.appendChild(overlay);
    return overlay;
  }

  function closeSheet(overlay) { overlay.remove(); }

  function confirmDialog(title, message, confirmLabel, danger) {
    return new Promise(resolve => {
      const ov = openSheet(
        '<h2>' + esc(title) + '</h2>' +
        '<p class="muted mt">' + esc(message) + '</p>' +
        '<div class="row mt">' +
        '<button class="btn ghost" data-act="no">' + L('Cancel', '取消') + '</button>' +
        '<button class="btn ' + (danger ? 'danger' : '') + '" data-act="yes">' + esc(confirmLabel || L('Confirm', '確認')) + '</button>' +
        '</div>', { center: true });
      ov.querySelector('[data-act="no"]').onclick = () => { closeSheet(ov); resolve(false); };
      ov.querySelector('[data-act="yes"]').onclick = () => { closeSheet(ov); resolve(true); };
    });
  }

  function pinDialog(title, message) {
    return new Promise(resolve => {
      const ov = openSheet(
        '<h2>' + esc(title) + '</h2>' +
        '<p class="muted mt">' + esc(message) + '</p>' +
        '<label>PIN</label><input id="pin-in" type="password" inputmode="numeric" autocomplete="off" maxlength="6">' +
        '<div class="row mt">' +
        '<button class="btn ghost" data-act="no">' + L('Cancel', '取消') + '</button>' +
        '<button class="btn" data-act="yes">' + L('OK', '確定') + '</button>' +
        '</div>', { center: true });
      const input = ov.querySelector('#pin-in');
      setTimeout(() => input.focus(), 60);
      ov.querySelector('[data-act="no"]').onclick = () => { closeSheet(ov); resolve(null); };
      ov.querySelector('[data-act="yes"]').onclick = () => { const v = input.value; closeSheet(ov); resolve(v); };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { const v = input.value; closeSheet(ov); resolve(v); }
      });
    });
  }

  // ---------- day logging ----------

  function workOptions(cls) {
    if (cls.type === 'normal') {
      return [
        { work: 1, label: L('Worked', '已上班'), sub: L('Normal working day', '正常工作日'), amt: L('paid', '已支薪'), cl: 'zero' },
        { work: 0.5, label: L('Half-day leave', '半日假'), sub: L('Ordinary unpaid leave', '普通無薪假'), amt: L('−½ day', '−半日'), cl: 'minus' },
        { work: 0, label: L('Full-day leave', '全日假'), sub: L('Ordinary unpaid leave', '普通無薪假'), amt: L('−1 day', '−1日'), cl: 'minus' }
      ];
    }
    const what = cls.type === 'rest' ? L('Rest day', '休息日') : L('Holiday', '法定假日');
    return [
      { work: 0, label: isZh() ? '已放' + what : what + ' taken', sub: L('Pay follows the recorded contract term', '薪酬按已記錄的合約條款處理'), amt: L('no work', '沒有上班'), cl: 'zero' },
      { work: 0.5, label: L('Worked half day', '上班半日'), sub: L('Record the agreed compensation separately', '須另行記錄雙方同意的補償'), amt: L('review', '待覆核'), cl: 'zero' },
      { work: 1, label: L('Worked full day', '上班全日'), sub: L('Record the agreed compensation separately', '須另行記錄雙方同意的補償'), amt: L('review', '待覆核'), cl: 'zero' }
    ];
  }

  function currentWork(ds, cls) {
    const entry = state.logs[ds];
    return entry && typeof entry.work === 'number' ? entry.work : E.defaultWork(cls.type);
  }

  // Who logged a day matters: helper entries stay "pending" until the
  // employer approves them; employer entries are authoritative immediately.
  // (Entries saved before this feature have no status and count as approved.)
  function setWork(ds, cls, work, note) {
    const def = E.defaultWork(cls.type);
    const noteVal = (note || '').trim();
    const existing = state.logs[ds];

    if (state.ui.helperMode) {
      // Nothing to record if she confirms the default and no entry exists.
      // But if an entry exists, her change back to default must stay visible
      // for the employer to approve — never silently delete someone's record.
      // Native: retain explicit pending confirmations.
      const entry = { work: work, by: 'helper', status: 'pending', at: new Date().toISOString() };
      if (noteVal) entry.note = noteVal;
      state.logs[ds] = entry;
    } else {
      { // Native: retain explicit employer confirmations.
        const entry = { work: work, by: 'employer', status: 'approved', at: new Date().toISOString() };
        if (noteVal) entry.note = noteVal;
        state.logs[ds] = entry;
      }
    }
    saveLogs();
    HSTrack('day-logged');
  }

  // Employer approval of a helper-logged day. Default-valued entries (she
  // reset a day back to normal) are simply cleaned away once acknowledged.
  function approveLog(ds) {
    const entry = state.logs[ds];
    if (!entry) return;
    const cls = E.classifyDay(ds, state.config);
    { // Native: keep the approved check-in.
      entry.status = 'approved';
      entry.approvedAt = new Date().toISOString();
    }
    saveLogs();
  }

  function pendingLogDates() {
    return Object.keys(state.logs).filter(ds => state.logs[ds].status === 'pending').sort();
  }

  function describeLogEffect(ds) {
    const cls = E.classifyDay(ds, state.config);
    const w = state.logs[ds].work;
    if (cls.type === 'normal') {
      if (w === 1) return L('Worked — normal day (no pay change)', '已上班 — 正常工作日（薪金不變）');
      return w === 0.5 ? L('Half-day leave (−½ day)', '半日假（−半日）') : L('Full-day leave (−1 day)', '全日假（−1日）');
    }
    const label = dayTypeName(cls);
    if (w === 0) return isZh() ? '已放' + label + '（薪酬按合約條款）' : label + ' taken (pay follows the contract term)';
    return isZh()
      ? label + ' — 已上班' + (w === 0.5 ? '半日（須覆核補償）' : '（須覆核補償）')
      : label + ' — worked' + (w === 0.5 ? ' half day (compensation needs review)' : ' (compensation needs review)');
  }

  function logStatusBadge(entry) {
    if (!entry || !entry.status) return '';
    if (entry.status === 'pending') return '<span class="badge pending">⏳ ' + L('Awaiting employer approval', '等待僱主批准') + '</span>';
    if (entry.by === 'helper') return '<span class="badge approved">✓ ' + L('Approved', '已批准') + '</span>';
    return '';
  }

  function dayBadges(cls) {
    let out = '';
    if (cls.isRest) out += '<span class="badge rest">' + L('Rest day', '休息日') + '</span> ';
    if (cls.holiday) out += '<span class="badge holiday">' + esc(holidayName(cls.holiday.name)) + '</span> ';
    if (!cls.isRest && !cls.holiday) out += '<span class="badge normal">' + L('Working day', '工作日') + '</span> ';
    return out;
  }

  function openDaySheet(ds) {
    if (!E.isEmployedOn(ds, state.config)) { toast(L('Outside employment period', '不在僱傭期內')); return; }
    const cls = E.classifyDay(ds, state.config);
    const entry = state.logs[ds] || {};
    let selected = currentWork(ds, cls);
    const opts = workOptions(cls);

    const choicesHtml = opts.map((o, i) =>
      '<button class="choice' + (o.work === selected ? ' selected' : '') + '" data-i="' + i + '">' +
      '<span>' + esc(o.label) + '<span class="sub">' + esc(o.sub) + '</span></span>' +
      '<span class="row"><span class="amt ' + o.cl + '">' + esc(o.amt) + '</span>' +
      '<span class="check">' + (o.work === selected ? '✓' : '') + '</span></span>' +
      '</button>').join('');

    const restToggle = !state.ui.helperMode
      ? '<button class="btn ghost compact mt" id="rest-toggle">' +
        (cls.isRest ? L('Not a rest day this week', '本周此日不是休息日') : L('Mark as rest day', '標記為休息日')) + '</button>' +
        '<p class="muted small" style="margin-top:6px">' + L(
          'Use this when the agency confirms a different rest-day date.',
          '如僱傭公司確認本周休息日有所更改，請使用此選項。'
        ) + '</p>'
      : '';

    const restSubstitute = (state.config.holidays || []).find(day =>
      day.type === 'substituted_rest_day' && day.restFor === ds);
    const restWorkHint = cls.isRest
      ? '<div class="legal-status mt"><label class="row" style="cursor:pointer;font-size:14px;color:var(--text);font-weight:600"><input id="rest-voluntary" type="checkbox" style="width:auto"' + (entry.restWorkVoluntary === true ? ' checked' : '') + '><span>' + L('Any work on this rest day was voluntary', '此休息日的任何工作均屬自願') + '</span></label>' +
        (restSubstitute
          ? '<p>' + L('Agreed substituted rest day: ', '雙方同意補回休息日：') + '<b>' + esc(fmtDate(restSubstitute.date)) + '</b></p>'
          : (entry.work > 0 && state.config.restDayWorkArrangement === 'substituted_rest_day' && !state.ui.helperMode
              ? '<button class="btn secondary compact mt" id="add-rest-sub">' + L('Record next agreed rest day', '記錄下一個雙方同意的休息日') + '</button>'
              : '')) + '</div>'
      : '';

    let holidayHint = cls.holiday
      ? '<p class="muted small mt">⚖️ ' + L(
        'If this statutory holiday is worked, the law requires 48 hours’ notice and an alternative holiday within 60 days. Cash cannot replace it; optional extra pay must be recorded separately.',
        '如在此法定假日工作，法例規定須提前48小時通知，並在前後60日內安排另定假日。不能以現金取代；任何額外薪金須另行記錄。'
      ) + '</p>'
      : '';
    if (E.needsRestDaySubstitute(state.config, ds)) {
      const sub = E.nextFreeDay(state.config, ds);
      holidayHint += '<p class="muted small mt">⚖️ ' + L(
        'This statutory holiday falls on a rest day — the law grants another holiday on the next free day.',
        '此法定假日適逢休息日——法律規定須在下一個非假日另放一天假。'
      ) + '</p>' +
        (!state.ui.helperMode
          ? '<button class="btn secondary compact mt" id="add-sub-day">' + L('+ Add substitute holiday — ', '+ 加入補假 — ') + esc(fmtDate(sub)) + '</button>'
          : '');
    }

    const approveBtn = !state.ui.helperMode && entry.status === 'pending'
      ? '<button class="btn mt" id="day-approve" style="background:var(--green)">✓ ' +
        (isZh() ? '批准' + esc(state.config.helperName || '外傭') + '的記錄' : 'Approve ' + esc(state.config.helperName || 'helper') + '’s log') + '</button>'
      : '';

    const ov = openSheet(
      '<h2>' + esc(fmtDate(ds)) + '</h2>' +
      '<div class="mt">' + dayBadges(cls) + ' ' + logStatusBadge(entry) + '</div>' +
      '<div class="choice-list">' + choicesHtml + '</div>' +
      '<label>' + L('Note (optional)', '備註（選填）') + '</label>' +
      '<input id="day-note" placeholder="' + L('e.g. agency confirmed, doctor visit…', '例如：僱傭公司已確認、覆診……') + '" value="' + esc(entry.note || '') + '">' +
      restWorkHint +
      holidayHint +
      restToggle +
      approveBtn +
      '<button class="btn' + (approveBtn ? ' secondary' : '') + ' mt" id="day-save">' + L('Save', '儲存') + '</button>'
    );

    const ap = ov.querySelector('#day-approve');
    if (ap) {
      ap.onclick = () => {
        approveLog(ds);
        closeSheet(ov);
        toast(L('Approved — ', '已批准 — ') + fmtDateShort(ds) + ' ✓');
        render();
      };
    }

    const subBtn = ov.querySelector('#add-sub-day');
    if (subBtn) {
      subBtn.onclick = () => {
      if (!requireMembership()) return;
        const sub = E.nextFreeDay(state.config, ds);
        state.config.holidays.push({
          date: sub,
          name: 'Substitute — ' + cls.holiday.name + ' (fell on rest day)',
          type: 'rest_day_collision_holiday',
          collisionFor: ds,
          sourceEventId: cls.holiday.officialId || cls.holiday.id || ds
        });
        state.config.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
        saveConfig();
        closeSheet(ov);
        toast(L('Substitute holiday added — ', '已加入補假 — ') + fmtDateShort(sub) + ' ✓');
        render();
      };
    }

    const restSubBtn = ov.querySelector('#add-rest-sub');
    if (restSubBtn) {
      restSubBtn.onclick = () => {
      if (!requireMembership()) return;
        const sub = E.nextFreeDay(state.config, ds);
        state.config.holidays.push({
          date: sub,
          name: 'Agreed substituted rest day — ' + fmtDateShort(ds),
          type: 'substituted_rest_day',
          restFor: ds,
          mutualAgreement: true
        });
        state.config.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
        saveConfig();
        closeSheet(ov);
        toast(L('Substituted rest day recorded — ', '已記錄補回休息日 — ') + fmtDateShort(sub));
        render();
      };
    }

    ov.querySelectorAll('.choice').forEach(btn => {
      btn.onclick = () => {
        selected = opts[+btn.dataset.i].work;
        ov.querySelectorAll('.choice').forEach((b, j) => {
          b.classList.toggle('selected', opts[j].work === selected);
          b.querySelector('.check').textContent = opts[j].work === selected ? '✓' : '';
        });
      };
    });

    const rt = ov.querySelector('#rest-toggle');
    if (rt) {
      rt.onclick = () => {
      if (!requireMembership()) return;
        const wdRule = E.weekdayOf(ds) === (state.config.restDayWeekday == null ? 0 : state.config.restDayWeekday);
        const newVal = !cls.isRest;
        if (newVal === wdRule) delete state.config.restDayOverrides[ds];
        else state.config.restDayOverrides[ds] = newVal;
        saveConfig();
        delete state.logs[ds]; // day type changed; stale log defaults no longer apply
        saveLogs();
        closeSheet(ov);
        toast(newVal ? L('Marked as rest day', '已標記為休息日') : L('Rest day removed', '已移除休息日標記'));
        render();
        openDaySheet(ds);
      };
    }

    ov.querySelector('#day-save').onclick = () => {
      if (!requireMembership()) return;
      setWork(ds, cls, selected, ov.querySelector('#day-note').value);
      if (selected > 0 && cls.isRest && state.logs[ds]) {
        const voluntary = ov.querySelector('#rest-voluntary');
        state.logs[ds].restWorkVoluntary = !!(voluntary && voluntary.checked);
        saveLogs();
      }
      closeSheet(ov);
      toast(state.ui.helperMode
        ? L('Sent to employer for approval — ', '已送交僱主批准 — ') + fmtDateShort(ds)
        : L('Saved — ', '已儲存 — ') + fmtDateShort(ds));
      render();
    };
  }

  // ---------- payments & adjustments ----------

  function monthAdjustments(key) { return state.adjustments[key] || []; }
  function monthPayments(key) { return state.payments.filter(p => p.monthKey === key); }
  function monthStatements(key) { return state.statements.filter(s => s.inputs && s.inputs.monthKey === key); }
  function latestStatement(key) {
    const all = monthStatements(key);
    return all.length ? all[all.length - 1] : null;
  }

  function monthDue(stmt) {
    let due = stmt.totalExact;
    monthAdjustments(stmt.key).forEach(a => { due += a.amount; });
    return due;
  }

  function statementInputs(stmt) {
    const logCopy = {};
    Object.keys(state.logs).filter(date => date >= stmt.periodStart && date <= stmt.periodEnd)
      .forEach(date => { logCopy[date] = state.logs[date]; });
    return {
      monthKey: stmt.key,
      contract: {
        contractType: state.config.contractType,
        contractSignedOn: state.config.contractSignedOn,
        startDate: state.config.startDate,
        contractEndDate: state.config.contractEndDate,
        employmentEndDate: state.config.endDate || null,
        monthlyWage: state.config.monthlyWage,
        foodMode: state.config.foodMode,
        foodAllowance: state.config.foodAllowance,
        restDayWeekday: state.config.restDayWeekday,
        restDayPayTerm: state.config.restDayPayTerm,
        restDayWorkArrangement: state.config.restDayWorkArrangement,
        restDayWorkPayment: state.config.restDayWorkPayment || 0,
        firstThreeMonthHolidayPayTerm: state.config.firstThreeMonthHolidayPayTerm,
        winterHolidayChoice: state.config.winterHolidayChoice,
        holidayWorkBonusAmount: state.config.holidayWorkBonusAmount || 0
      },
      holidays: (state.config.holidays || []).filter(day =>
        (day.date >= stmt.periodStart && day.date <= stmt.periodEnd) ||
        (day.altFor >= stmt.periodStart && day.altFor <= stmt.periodEnd) ||
        (day.collisionFor >= stmt.periodStart && day.collisionFor <= stmt.periodEnd) ||
        (day.restFor >= stmt.periodStart && day.restFor <= stmt.periodEnd)),
      logs: logCopy,
      adjustments: monthAdjustments(stmt.key)
    };
  }

  function freezeStatement(stmt) {
    const inputs = statementInputs(stmt);
    const previous = latestStatement(stmt.key);
    const now = new Date().toISOString();
    const snapshot = Legal.createStatementSnapshot({
      statementId: 'statement-' + stmt.key + '-' + uid(),
      calculatedAt: now,
      acceptedAt: now,
      holidayCalendarVersion: Compliance.HOLIDAY_CALENDAR_VERSION,
      inputs: inputs,
      items: Compliance.acceptedMoneyItems(stmt, state.config, monthAdjustments(stmt.key)),
      supersedesStatementId: previous ? previous.statementId : null
    });
    state.statements.push(snapshot);
    saveStatements();
    return snapshot;
  }

  function monthPaid(key) {
    return monthPayments(key).reduce((s, p) => s + p.amount, 0);
  }

  async function resizeImage(file, maxDim) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = rej;
        i.src = url;
      });
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 900 * 1024) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function attachFiles(payment, fileList) {
    for (const file of Array.from(fileList || [])) {
      if (!file.type.startsWith('image/')) continue;
      const blob = await resizeImage(file, 1400);
      const id = uid();
      await Store.files.put(id, blob, { paymentId: payment.id });
      payment.fileIds = payment.fileIds || [];
      payment.fileIds.push(id);
    }
    savePayments();
  }

  function openPaymentSheet(stmt, snapshot) {
    const frozenTotal = snapshot.totals.finalized.total;
    const balance = frozenTotal - monthPaid(stmt.key);
    const ov = openSheet(
      '<h2>' + L('Record payment — ', '記錄付款 — ') + monthYear(stmt.year, stmt.month) + '</h2>' +
      '<label>' + L('Amount (HK$)', '金額（港幣）') + '</label>' +
      '<input id="pay-amount" type="number" step="0.01" inputmode="decimal" value="' + E.round2(Math.max(balance, 0)) + '">' +
      '<label>' + L('Payment date', '付款日期') + '</label>' +
      '<input id="pay-date" type="date" value="' + E.todayStr() + '">' +
      '<label>' + L('Method', '付款方式') + '</label>' +
      '<select id="pay-method">' +
      ['FPS', 'Bank transfer', 'Cash', 'Cheque', 'Other'].map(method =>
        '<option value="' + method + '">' + esc(I18n.paymentMethod(method, state.ui.language)) + '</option>').join('') + '</select>' +
      '<label>' + L('Note (optional)', '備註（選填）') + '</label>' +
      '<input id="pay-note" placeholder="' + L('e.g. includes May correction −HK$76.18', '例如：包括5月更正 −HK$76.18') + '">' +
      '<label>' + L('Payment screenshot(s)', '付款截圖') + '</label>' +
      '<input id="pay-files" type="file" accept="image/*" multiple>' +
      '<button class="btn mt" id="pay-save">' + L('Save payment', '儲存付款') + '</button>'
    );
    ov.querySelector('#pay-save').onclick = async () => {
      if (!requireMembership()) return;
      const amount = parseFloat(ov.querySelector('#pay-amount').value);
      if (!(amount > 0)) { toast(L('Enter an amount', '請輸入金額')); return; }
      const payment = {
        id: uid(),
        monthKey: stmt.key,
        amount: E.round2(amount),
        date: ov.querySelector('#pay-date').value || E.todayStr(),
        method: ov.querySelector('#pay-method').value,
        note: ov.querySelector('#pay-note').value.trim(),
        fileIds: [],
        status: 'paid',
        approval: null,
        statementId: snapshot.statementId,
        statementChecksum: snapshot.inputChecksum,
        modelVersion: snapshot.modelVersion,
        createdAt: new Date().toISOString()
      };
      ov.querySelector('#pay-save').textContent = L('Saving…', '儲存中……');
      await attachFiles(payment, ov.querySelector('#pay-files').files);
      state.payments.push(payment);
      savePayments();
      HSTrack('payment-recorded');
      closeSheet(ov);
      toast(isZh()
        ? '已記錄付款 — 請' + (state.config.helperName || '外傭') + '確認'
        : 'Payment recorded — ask ' + (state.config.helperName || 'helper') + ' to approve');
      render();
    };
  }

  function openApprovalSheet(paymentId) {
    const payment = state.payments.find(p => p.id === paymentId);
    if (!payment) return;
    const needPin = !!state.config.helperPin;
    const ov = openSheet(
      '<h2>' + L('Payment approval', '確認收款') + '</h2>' +
      '<p class="muted">' + (isZh()
        ? '請' + esc(state.config.helperName || '外傭') + '確認已收到這筆薪金。'
        : esc(state.config.helperName || 'Helper') + ', please confirm you received this salary payment.') + '</p>' +
      '<div class="approve-amount">' + money(payment.amount) + '</div>' +
      '<p class="muted small">' + esc(monthLabel(payment.monthKey)) + L(' salary · paid ', '薪金 · 付款日期：') + esc(fmtDate(payment.date)) +
      ' · ' + esc(I18n.paymentMethod(payment.method, state.ui.language)) + (payment.note ? ' · ' + esc(payment.note) : '') + '</p>' +
      '<div class="thumbs" id="appr-thumbs"></div>' +
      '<label>' + L('Your name', '你的姓名') + '</label>' +
      '<input id="appr-name" value="' + esc(state.config.helperName || '') + '">' +
      (needPin ? '<label>' + L('Your PIN', '你的 PIN') + '</label><input id="appr-pin" type="password" inputmode="numeric" maxlength="6">' : '') +
      '<button class="btn mt" id="appr-ok">✓ ' + L('I confirm I received this payment', '我確認已收到這筆款項') + '</button>' +
      '<button class="btn ghost mt" id="appr-cancel">' + L('Not now', '稍後處理') + '</button>'
    );
    loadThumbs(ov.querySelector('#appr-thumbs'), payment);
    ov.querySelector('#appr-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#appr-ok').onclick = () => {
      const name = ov.querySelector('#appr-name').value.trim();
      if (!name) { toast(L('Please enter your name', '請輸入你的姓名')); return; }
      if (needPin && ov.querySelector('#appr-pin').value !== state.config.helperPin) {
        toast(L('Wrong PIN', 'PIN 不正確')); return;
      }
      payment.status = 'approved';
      payment.approval = { name: name, at: new Date().toISOString(), pinVerified: needPin };
      savePayments();
      HSTrack('payment-approved');
      closeSheet(ov);
      toast(L('Approved ✓ Thank you!', '已確認 ✓ 謝謝！'));
      render();
    };
  }

  function openAdjustmentSheet(stmt) {
    const ov = openSheet(
      '<h2>' + L('Add voluntary payment — ', '加入自願付款 — ') + monthYear(stmt.year, stmt.month) + '</h2>' +
      '<p class="muted small mt">' + L(
        'Only a positive, optional payment can be added here. Deductions need a lawful category, evidence and limits, so this release does not accept free-form deductions.',
        '這裡只可加入正數的自願付款。扣款必須具備合法類別、證明及限額，因此此版本不接受自由輸入的扣款。'
      ) + '</p>' +
      '<label>' + L('Description', '說明') + '</label>' +
      '<input id="adj-label" placeholder="' + L('e.g. Correction for May over-payment', '例如：5月多付薪金更正') + '">' +
      '<label>' + L('Amount (HK$, positive only)', '金額（港幣，只限正數）') + '</label>' +
      '<input id="adj-amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="100.00">' +
      '<button class="btn mt" id="adj-save">' + L('Add voluntary payment', '加入自願付款') + '</button>'
    );
    ov.querySelector('#adj-save').onclick = () => {
      if (!requireMembership()) return;
      const label = ov.querySelector('#adj-label').value.trim();
      const amount = parseFloat(ov.querySelector('#adj-amount').value);
      if (!label || !(amount > 0)) { toast(L('Enter a description and positive amount', '請輸入說明及正數金額')); return; }
      if (!state.adjustments[stmt.key]) state.adjustments[stmt.key] = [];
      state.adjustments[stmt.key].push({
        id: uid(), label: label, amount: E.round2(amount),
        class: 'voluntary_benefit', status: 'accepted', createdAt: new Date().toISOString()
      });
      saveAdjustments();
      closeSheet(ov);
      render();
    };
  }

  function openImageViewer(fileId) {
    Store.files.get(fileId).then(rec => {
      if (!rec) return;
      const url = URL.createObjectURL(rec.blob);
      const div = document.createElement('div');
      div.className = 'img-viewer';
      div.innerHTML = '<button class="close">×</button><img src="' + url + '">';
      div.onclick = () => { URL.revokeObjectURL(url); div.remove(); };
      document.body.appendChild(div);
    });
  }

  function loadThumbs(container, payment) {
    if (!container) return;
    (payment.fileIds || []).forEach(fid => {
      const img = document.createElement('img');
      img.alt = L('payment screenshot', '付款截圖');
      if (objectUrls.has(fid)) {
        img.src = objectUrls.get(fid);
      } else {
        Store.files.get(fid).then(rec => {
          if (!rec) return;
          const url = URL.createObjectURL(rec.blob);
          objectUrls.set(fid, url);
          img.src = url;
        });
      }
      img.onclick = () => openImageViewer(fid);
      container.appendChild(img);
    });
  }

  function monthLabel(key) {
    const p = key.split('-');
    return monthYear(+p[0], +p[1]);
  }

  // ---------- alternative day off for statutory-holiday work ----------

  // EO rule: working a statutory holiday requires an alternative day off
  // within 60 days — cash in lieu is prohibited (fine HK$50,000).
  // Handles both first-time scheduling and rescheduling/removal of an
  // already-scheduled day off in lieu (owedItem.scheduled holds its date).
  function openScheduleAltSheet(owedItem) {
    const existing = owedItem.scheduled || '';
    const ov = openSheet(
      '<h2>' + (existing ? L('Reschedule day off in lieu', '重新安排補假') : L('Schedule day off in lieu', '安排補假')) + '</h2>' +
      '<p class="muted mt">' + (isZh()
        ? esc(state.config.helperName || '外傭') + '在' + esc(fmtDate(owedItem.date)) + '的<b>' + esc(holidayName(owedItem.name)) + '</b>上班。' +
          '法律規定須在60日內（即' + esc(fmtDate(owedItem.deadline)) + '或之前）安排替代假日；額外薪金不能取代補假。'
        : esc(state.config.helperName || 'Helper') + ' worked <b>' + esc(owedItem.name) + '</b> on ' + esc(fmtDate(owedItem.date)) + '. ' +
          'The law requires an alternative day off within 60 days (by ' + esc(fmtDate(owedItem.deadline)) + ') — extra pay is welcome but cannot replace the day off.') + '</p>' +
      (existing ? '<p class="muted small mt">' + L('Currently scheduled: ', '目前安排：') + '<b>' + esc(fmtDate(existing)) + '</b></p>' : '') +
      '<label>' + L('Holiday record type', '假日記錄類型') + '</label><select id="alt-type"><option value="alternative_holiday"' + (owedItem.arrangementType !== 'substituted_holiday' ? ' selected' : '') + '>' + L('Alternative holiday (within 60 days)', '另定假日（前後60日內）') + '</option><option value="substituted_holiday"' + (owedItem.arrangementType === 'substituted_holiday' ? ' selected' : '') + '>' + L('Mutually agreed substituted holiday (within 30 days)', '雙方同意的代替假日（前後30日內）') + '</option></select>' +
      '<label>' + L('Day off in lieu', '補假日期') + '</label>' +
      '<input id="alt-date" type="date" value="' + esc(existing) + '"' +
      ' min="' + esc(E.addDays(owedItem.date, -60)) + '" max="' + esc(owedItem.deadline) + '">' +
      '<label>' + L('When was at least 48 hours’ notice given?', '何時已提前至少48小時作出通知？') + '</label>' +
      '<input id="alt-notice" type="datetime-local" value="' + esc((owedItem.noticeAt || '').slice(0, 16)) + '">' +
      '<label class="row" style="cursor:pointer;font-size:14px;color:var(--text);font-weight:600"><input id="alt-agreement" type="checkbox" style="width:auto"' + (owedItem.mutualAgreement ? ' checked' : '') + '><span>' + L('Employer and helper mutually agreed this substituted holiday', '僱主與外傭已共同同意此代替假日') + '</span></label>' +
      '<p class="muted small" style="margin-top:6px">' + L(
        'Pick a normal working day within 60 days of the holiday. She takes that day off with full pay.',
        '請選擇法定假日前後60日內的一個正常工作日，並以全薪安排放假。'
      ) + '</p>' +
      '<button class="btn mt" id="alt-save">' + (existing ? L('Save new date', '儲存新日期') : L('Schedule day off', '安排補假')) + '</button>' +
      (existing ? '<button class="btn ghost mt" id="alt-remove" style="color:var(--red);border-color:var(--red)">' + L('Remove — mark as not scheduled', '移除 — 標記為尚未安排') + '</button>' : '')
    );

    // the entry being replaced must not block its own date re-validation
    const holidaysSans = () => (state.config.holidays || []).filter(h => h.altFor !== owedItem.date);

    ov.querySelector('#alt-save').onclick = () => {
      if (!requireMembership()) return;
      const date = ov.querySelector('#alt-date').value;
      if (!date) { toast(L('Pick a date', '請選擇日期')); return; }
      const type = ov.querySelector('#alt-type').value;
      const noticeValue = ov.querySelector('#alt-notice').value;
      if (!noticeValue) { toast(L('Enter when notice was given', '請輸入通知時間')); return; }
      const noticeAt = noticeValue ? new Date(noticeValue).toISOString() : null;
      const arrangementErrors = Legal.validateHolidayArrangement({
        type: type, statutoryDate: owedItem.date, date: date, noticeAt: noticeAt,
        mutualAgreement: ov.querySelector('#alt-agreement').checked
      });
      if (arrangementErrors.length) { toast(L(arrangementErrors[0], '日期或通知時間不符合法定要求')); return; }
      const cls = E.classifyDay(date, Object.assign({}, state.config, { holidays: holidaysSans() }));
      if (cls.type !== 'normal') { toast(L(
        'Pick a normal working day (not a rest day or holiday)',
        '請選擇正常工作日（不可選休息日或假日）'
      )); return; }
      state.config.holidays = holidaysSans();
      state.config.holidays.push({
        date: date,
        name: 'Day off in lieu — ' + owedItem.name + ' (' + fmtDateShort(owedItem.date) + ')',
        type: type,
        altFor: owedItem.date,
        noticeAt: noticeAt,
        mutualAgreement: ov.querySelector('#alt-agreement').checked
      });
      state.config.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
      saveConfig();
      closeSheet(ov);
      toast(existing
        ? L('Day off moved to ', '補假已改至') + fmtDateShort(date) + ' ✓'
        : L('Day off scheduled — ', '已安排補假 — ') + fmtDateShort(date) + ' ✓');
      render();
    };

    const rm = ov.querySelector('#alt-remove');
    if (rm) rm.onclick = async () => {
      if (!(await confirmDialog(
        L('Remove scheduled day off?', '移除已安排的補假？'),
        isZh()
          ? '曾上班的假日（' + holidayName(owedItem.name) + '，' + fmtDateShort(owedItem.date) + '）將重新顯示為尚欠補假，讓你另選日期。'
          : 'The worked holiday (' + owedItem.name + ', ' + fmtDateShort(owedItem.date) + ') will show as owed again so you can pick another date.',
        L('Remove', '移除'), true))) return;
      state.config.holidays = holidaysSans();
      saveConfig();
      closeSheet(ov);
      toast(L('Unscheduled — day off owed again', '已取消安排 — 重新列為尚欠補假'));
      render();
    };
  }

  function owedCardHtml() {
    const all = E.owedAlternativeHolidays(state.config, state.logs);
    const today = E.todayStr();
    const unscheduled = all.filter(o => !o.scheduled);
    // scheduled ones stay visible (with a Change option) until the day off is taken
    const upcoming = all.filter(o => o.scheduled && o.scheduled >= today);
    if (!unscheduled.length && !upcoming.length) return '';
    const em = !state.ui.helperMode;

    let rows = unscheduled.map(o =>
      '<div class="pending-row" style="cursor:default">' +
      '<div class="grow"><b>' + esc(fmtDate(o.date)) + ' · ' + esc(holidayName(o.name)) + '</b>' +
      '<div class="' + (o.overdue ? '' : 'muted') + ' small"' + (o.overdue ? ' style="color:var(--red);font-weight:700"' : '') + '>' +
      (o.overdue ? L('OVERDUE — was due by ', '已逾期 — 原定限期：') : L('Day off due by ', '補假限期：')) + esc(fmtDate(o.deadline)) + '</div></div>' +
      (em ? '<button class="btn compact" data-schedule-alt="' + esc(o.date) + '">' + L('Schedule', '安排') + '</button>' : '') +
      '</div>').join('');

    rows += upcoming.map(o =>
      '<div class="pending-row" style="cursor:default">' +
      '<div class="grow"><b>' + esc(fmtDate(o.date)) + ' · ' + esc(holidayName(o.name)) + '</b>' +
      '<div class="small" style="color:var(--green);font-weight:600">' + L('Day off scheduled: ', '已安排補假：') + esc(fmtDate(o.scheduled)) + ' ✓</div></div>' +
      (em ? '<button class="btn ghost compact" data-schedule-alt="' + esc(o.date) + '">' + L('Change', '更改') + '</button>' : '') +
      '</div>').join('');

    const title = unscheduled.length
      ? '⚖️ ' + (state.ui.helperMode
          ? L('Days off owed to you (', '尚欠你的補假（') + unscheduled.length + L(')', '）')
          : L('Day off owed for holiday work (', '法定假日工作尚欠補假（') + unscheduled.length + L(')', '）'))
      : isZh() ? '⚖️ 已安排補假 ✓' : '⚖️ Day' + (upcoming.length === 1 ? '' : 's') + ' off in lieu — scheduled ✓';

    let footer;
    if (unscheduled.length) {
      footer = state.ui.helperMode
        ? L(
          'You worked these statutory holidays — the law says you get another day off within 60 days, on top of any extra pay.',
          '你曾在這些法定假日工作——法律規定除任何額外薪金外，亦須在60日內另放一天假。'
        )
        : L(
          'Working a statutory holiday needs 48-hour notice and an alternative day off within 60 days. Paying cash instead of the day off is prohibited (fine HK$50,000) — extra pay on top is fine and already in the statement.',
          '安排在法定假日工作須提前48小時通知，並在60日內安排替代假日。禁止以現金取代假日（可罰款港幣50,000元）；額外薪金可以另加，並已列入結算單。'
        );
    } else {
      footer = state.ui.helperMode
        ? L('Your replacement day(s) off for holiday work — full pay, no deduction.', '這是你因法定假日工作而獲得的補假——全薪，不會扣款。')
        : L('She takes the scheduled day off with full pay. Tap Change to move or remove it.', '外傭在已安排的日期以全薪放假。按「更改」可移動或移除日期。');
    }

    return '<div class="card"><h2>' + title + '</h2>' + rows +
      '<p class="muted small mt">' + footer + '</p></div>';
  }

  // ---------- statutory holiday sync (official HK Gov 1823 calendar) ----------

  // Fetches the latest archived copy of the 1823 general-holiday calendar via
  // the CORS-enabled data.gov.hk historical-archive API, filters it to
  // Employment Ordinance statutory holidays, and add-only-merges into config.
  async function syncHolidays(opts) {
    opts = opts || {};
    try {
      const enc = encodeURIComponent(Holidays.GOV_FEED_URL);
      const fmt = ds => ds.replace(/-/g, '');
      const yesterday = fmt(E.addDays(E.todayStr(), -1));
      const yearAgo = fmt(E.addDays(E.todayStr(), -370));
      const vres = await fetch(Holidays.GOV_ARCHIVE_API + '/list-file-versions?url=' + enc +
        '&start=' + yearAgo + '&end=' + yesterday);
      const vjson = await vres.json();
      const ts = vjson.timestamps && vjson.timestamps[vjson.timestamps.length - 1];
      if (!ts) throw new Error('no archived feed versions');
      const fres = await fetch(Holidays.GOV_ARCHIVE_API + '/get-file?url=' + enc + '&time=' + ts);
      if (!fres.ok) throw new Error('feed fetch failed: ' + fres.status);
      const incoming = Holidays.parseGovFeed(await fres.text());
      const result = Holidays.mergeHolidays(state.config.holidays || [], incoming, state.config.startDate);
      state.config.holidays = result.holidays;
      state.config.lastHolidaySync = new Date().toISOString();
      saveConfig();
      if (result.added > 0) {
        toast(isZh()
          ? '假日已同步 — 從香港政府新增' + result.added + '個日期'
          : 'Holidays synced — ' + result.added + ' new date' + (result.added === 1 ? '' : 's') + ' from HK Gov');
        render();
      } else if (!opts.silent) {
        toast(L('Holidays already up to date', '假日資料已是最新'));
        render();
      }
      return result.added;
    } catch (err) {
      if (!opts.silent) toast(L('Holiday sync failed — check your connection', '假日同步失敗 — 請檢查網絡連線'));
      return -1;
    }
  }

  function maybeAutoSyncHolidays() { return; // Demo uses the bundled calendar.
    if (!state.config || !navigator.onLine) return;
    const last = state.config.lastHolidaySync;
    if (last && Date.now() - new Date(last).getTime() < 30 * 86400000) return;
    syncHolidays({ silent: true });
  }

  // ---------- views ----------

  function languageSwitchHtml() {
    return '<div class="language-switch" role="group" aria-label="' + L('Language', '語言') + '">' +
      '<button type="button" data-language="zh-HK" class="' + (isZh() ? 'active' : '') + '" aria-pressed="' + isZh() + '">繁體中文</button>' +
      '<button type="button" data-language="en" class="' + (!isZh() ? 'active' : '') + '" aria-pressed="' + (!isZh()) + '">English</button>' +
      '</div>';
  }

  function bindLanguageControls() {
    $$('[data-language]').forEach(button => {
      button.onclick = () => {
        const language = I18n.normalizeLanguage(button.dataset.language);
        if (language === state.ui.language) return;
        state.ui.language = language;
        saveUi();
        render();
        toast(L('Language changed to English', '已切換至香港繁體中文'));
      };
    });
  }

  function render() {
    window.HSBilling.setContext({ language: state.ui.language, helperMode: state.ui.helperMode });
    applyLanguageMetadata();
    renderHeader();
    renderTabbar();
    const view = $('#view');
    if (!state.config || state.addingProfile) {
      view.innerHTML = setupHtml();
      bindSetup();
      bindLanguageControls();
      refreshNativeReminders();
      window.scrollTo(0, 0);
      return;
    }
    if (state.ui.helperMode && state.ui.view === 'settings') state.ui.view = 'today';
    switch (state.ui.view) {
      case 'today': view.innerHTML = todayHtml(); bindToday(); break;
      case 'calendar': view.innerHTML = calendarHtml(); bindCalendar(); break;
      case 'salary': view.innerHTML = salaryHtml(); bindSalary(); break;
      case 'settings': view.innerHTML = settingsHtml(); bindSettings(); break;
    }
    bindLanguageControls();
    view.insertAdjacentHTML('afterbegin', window.HSBilling.banner());
    refreshNativeReminders();
    window.scrollTo(0, 0);
  }

  function renderHeader() {
    const chip = $('#mode-chip');
    const brand = $('#topbar .brand');
    const multi = Store.profiles.list().length > 1;
    brand.innerHTML = 'Helper<span>Pay</span>' +
      (multi && state.config && !state.addingProfile
        ? ' <span style="font-size:12px;color:var(--muted);font-weight:600">· ' + esc(state.config.helperName || '?') + '</span>'
        : '');
    if (!state.config || state.addingProfile) { chip.style.display = 'none'; return; }
    chip.style.display = '';
    chip.className = 'mode-chip' + (state.ui.helperMode ? ' helper' : '');
    chip.textContent = state.ui.helperMode
      ? '👩 ' + (state.config.helperName || L('Helper', '外傭'))
      : '🔑 ' + L('Employer', '僱主');
  }

  function renderTabbar() {
    const bar = $('#tabbar');
    if (!state.config) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const tabs = [
      { id: 'today', ico: '📝', label: L('Today', '今日') },
      { id: 'calendar', ico: '📅', label: L('Calendar', '日曆') },
      { id: 'salary', ico: '💵', label: L('Salary', '薪金') }
    ];
    if (!state.ui.helperMode) tabs.push({ id: 'settings', ico: '⚙️', label: L('Settings', '設定') });
    bar.innerHTML = tabs.map(t =>
      '<button data-tab="' + t.id + '" class="' + (state.ui.view === t.id ? 'active' : '') + '">' +
      '<span class="ico">' + t.ico + '</span>' + t.label + '</button>').join('');
    bar.querySelectorAll('button').forEach(b => {
      b.onclick = () => { state.ui.view = b.dataset.tab; saveUi(); render(); };
    });
  }

  // ----- setup (first run) -----

  function onboardingProgressHtml(step) {
    return '<div class="onboarding-progress" aria-label="' + L('Onboarding progress', '迎新進度') + '">' +
      [1, 2, 3].map(number =>
        '<span class="' + (number === step ? 'active' : (number < step ? 'done' : '')) + '"' +
        (number === step ? ' aria-current="step"' : '') + '>' + number + '</span>'
      ).join('') +
      '</div>';
  }

  function onboardingLanguageHtml() {
    return '<div class="spread language-row onboarding-language"><b>' + L('Language', '語言') + '</b>' + languageSwitchHtml() + '</div>';
  }

  function setupFormHtml(today, adding) {
    return '<div class="card onboarding-card">' +
      (adding ? '' : onboardingProgressHtml(3)) +
      '<div class="onboarding-heading">' +
      '<p class="eyebrow">' + (adding ? L('New profile', '新增檔案') : L('Final step', '最後一步')) + '</p>' +
      '<h1>' + (adding ? L('Add another helper', '加入另一位外傭') : L('Set up your helper', '設定外傭資料')) + '</h1>' +
      '<p>' + L(
        adding
          ? 'This helper will have a separate calendar, salary statements and payment history.'
          : 'Enter the contract details below. HelperPay will then prepare the calendar for you.',
        adding
          ? '這位外傭會有獨立的日曆、薪金結算單及付款記錄。'
          : '輸入以下合約資料後，HelperPay 便會為你準備日曆。'
      ) + '</p></div>' +
      onboardingLanguageHtml() +
      '<label>' + L('Helper\'s name', '外傭姓名') + '</label><input id="su-helper" autocomplete="name" placeholder="' + L('e.g. Maria', '例如：Maria') + '">' +
      '<label>' + L('ID 407 contract signed on', 'ID 407 合約簽署日期') + '</label><input id="su-signed" type="date">' +
      '<label>' + L('Monthly wage (HK$)', '月薪（港幣）') + '</label><input id="su-wage" type="number" inputmode="decimal" value="5100">' +
      '<p class="muted small" style="margin-top:4px">' + L(
        'Minimum Allowable Wage for contracts signed from Sep 2025 is HK$5,100 — check the current rate when you sign.',
        '2025年9月起簽訂的合約，規定最低工資為港幣5,100元；簽約時請核對最新金額。'
      ) + '</p>' +
      '<label>' + L('Food arrangement', '膳食安排') + '</label><select id="su-food-mode"><option value="">' + L('Choose…', '請選擇……') + '</option>' +
      '<option value="provided">' + L('Food provided free', '免費提供膳食') + '</option><option value="allowance">' + L('Monthly food allowance', '每月膳食津貼') + '</option></select>' +
      '<label>' + L('Food allowance (HK$/month; only if selected above)', '膳食津貼（港幣／月；只在上方選擇津貼時填寫）') + '</label><input id="su-food" type="number" inputmode="decimal" value="1236">' +
      '<label>' + L('First day of work', '首個工作日') + '</label><input id="su-start" type="date" value="' + today + '">' +
      '<label>' + L('Weekly rest day', '每周休息日') + '</label><select id="su-rest">' +
      weekdays().map((w, i) => '<option value="' + i + '"' + (i === 0 ? ' selected' : '') + '>' + w + '</option>').join('') +
      '</select>' +
      '<label>' + L('Are weekly rest days paid?', '每周休息日是否有薪？') + '</label><select id="su-rest-pay"><option value="">' + L('Choose the agreed term…', '請選擇已協議條款……') + '</option><option value="paid">' + L('Paid', '有薪') + '</option><option value="unpaid">' + L('Unpaid', '無薪') + '</option></select>' +
      '<label>' + L('If a rest day is worked', '如在休息日工作') + '</label><select id="su-rest-work"><option value="">' + L('Choose the agreed arrangement…', '請選擇已協議安排……') + '</option><option value="substituted_rest_day">' + L('Agreed substituted rest day', '雙方同意補回休息日') + '</option><option value="agreed_payment">' + L('Agreed cash amount', '雙方同意現金金額') + '</option></select>' +
      '<label>' + L('Statutory-holiday pay during first 3 months', '首3個月法定假日薪酬') + '</label><select id="su-early-holiday"><option value="">' + L('Choose the contractual term…', '請選擇合約條款……') + '</option><option value="paid">' + L('Paid by agreement', '按協議有薪') + '</option><option value="unpaid">' + L('Unpaid', '無薪') + '</option></select>' +
      '<label>' + L('Contractual winter statutory holiday', '合約訂明的冬季法定假日') + '</label><select id="su-winter"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="winter_solstice">' + L('Winter Solstice', '冬節') + '</option><option value="christmas">' + L('Christmas Day', '聖誕節') + '</option></select>' +
      '<button class="btn mt" id="su-create">' + (adding ? L('Add helper', '加入外傭') : L('Finish setup', '完成設定')) + '</button>' +
      (adding
        ? '<button class="btn ghost mt" id="su-cancel">' + L('Cancel', '取消') + '</button>'
        : '<button class="btn ghost mt" id="ob-back">' + L('Back', '返回') + '</button>') +
      '<p class="muted small mt">' + L(
        'Hong Kong statutory holidays are prefilled automatically. You can change these details later in Settings.',
        '系統會自動預載香港法定假日；以上資料日後可在「設定」更改。'
      ) + '</p>' +
      (adding ? '' :
        '<p class="muted small mt">' + L('Questions?', '如有問題，請聯絡：') + ' <a href="' + whatsappUrl() + '" target="_blank" rel="noopener" style="color:var(--accent)">WhatsApp ' + WHATSAPP_DISPLAY + '</a></p>') +
      '</div>';
  }

  function setupHtml() {
    const today = E.todayStr();
    const adding = state.addingProfile;
    if (adding || state.onboardingStep === 3) return setupFormHtml(today, adding);

    if (state.onboardingStep === 2) {
      return '<div class="card onboarding-card">' +
        onboardingProgressHtml(2) +
        '<div class="onboarding-heading"><p class="eyebrow">' + L('Before you start', '開始前') + '</p>' +
        '<h1>' + L('Have these details ready', '請準備以下資料') + '</h1>' +
        '<p>' + L(
          'Keep the helper’s Standard Employment Contract (ID 407) nearby. Setup takes about one minute.',
          '請把外傭的標準僱傭合約（ID 407）放在手邊；設定大約需時一分鐘。'
        ) + '</p></div>' +
        onboardingLanguageHtml() +
        '<div class="onboarding-checklist">' +
        '<div><span>✓</span><p><b>' + L('Monthly wage', '每月工資') + '</b><small>' + L('The amount stated in the contract', '合約上列明的金額') + '</small></p></div>' +
        '<div><span>✓</span><p><b>' + L('Food arrangement', '膳食安排') + '</b><small>' + L('Food provided, or the monthly allowance', '提供膳食，或每月津貼金額') + '</small></p></div>' +
        '<div><span>✓</span><p><b>' + L('First day of work', '首個工作日') + '</b><small>' + L('The helper’s employment start date', '外傭開始受僱的日期') + '</small></p></div>' +
        '<div><span>✓</span><p><b>' + L('Usual weekly rest day', '固定每周休息日') + '</b><small>' + L('For example, Sunday', '例如星期日') + '</small></p></div>' +
        '</div>' +
        '<p class="onboarding-note">' + L(
          'You can change these details later in Settings.',
          '所有資料日後均可在「設定」更改。'
        ) + '</p>' +
        '<button class="btn" id="ob-next">' + L('Enter helper details', '填寫外傭資料') + '</button>' +
        '<button class="btn ghost mt" id="ob-back">' + L('Back', '返回') + '</button>' +
        '</div>';
    }

    return '<div class="card onboarding-card">' +
      onboardingProgressHtml(1) +
      '<div class="onboarding-heading"><p class="eyebrow">' + L('Welcome', '歡迎') + '</p>' +
      '<h1>' + L('Know what to do each day', '每天應該怎樣使用？') + '</h1>' +
      '<p>' + L(
        'Normal working days are already assumed. You only need to record days that are different.',
        '系統已預設一般工作日；你只需記錄與平常不同的日子。'
      ) + '</p></div>' +
      onboardingLanguageHtml() +
      '<div class="onboarding-actions">' +
      '<div><span class="onboarding-icon">📝</span><p><b>' + L('Today', '今日') + '</b><small>' + L('Record leave, or work on a rest day or holiday', '記錄請假，或在休息日／假日工作') + '</small></p></div>' +
      '<div><span class="onboarding-icon">📅</span><p><b>' + L('Calendar', '日曆') + '</b><small>' + L('Check rest days and Hong Kong statutory holidays', '查看休息日及香港法定假日') + '</small></p></div>' +
      '<div><span class="onboarding-icon">💵</span><p><b>' + L('Salary', '薪金') + '</b><small>' + L('Review monthly calculations and payment records', '檢查每月計算及付款記錄') + '</small></p></div>' +
      '</div>' +
      '<p class="onboarding-note"><b>' + L('Start here:', '由這裡開始：') + '</b> ' + L(
        'Set up the helper’s contract details first.',
        '先設定外傭的合約資料。'
      ) + '</p>' +
      '<button class="btn" id="ob-next">' + L('Continue', '繼續') + '</button>' +
      '<a class="btn ghost mt" href="demo.html?lang=' + state.ui.language + '">' + L('Try demo with sample records', '以樣本紀錄試用示範') + '</a>' +
      '<button class="btn secondary mt" id="ob-restore">' + L('Restore existing backup', '還原現有備份') + '</button>' +
      '<input type="file" id="ob-import-file" accept="application/json,.json" style="display:none">' +
      '<p class="muted small mt">' + L('Moving phones or browsers? Restore your payroll backup here. This web version remains free.',
        '更換手機或瀏覽器？可在此還原薪酬備份。此網頁版繼續免費。') + '</p>' +
      '</div>';
  }

  function bindSetup() {
    bindNativeRestore($('#ob-restore'), $('#ob-import-file'));
    const next = $('#ob-next');
    if (next) next.onclick = () => { state.onboardingStep = Math.min(3, state.onboardingStep + 1); render(); };

    const back = $('#ob-back');
    if (back && !state.addingProfile) back.onclick = () => { state.onboardingStep = Math.max(1, state.onboardingStep - 1); render(); };

    const cancel = $('#su-cancel');
    if (cancel) cancel.onclick = () => {
      state.addingProfile = false;
      state.pendingEmployerDefaults = null;
      loadActiveProfile();
      render();
    };

    if (!$('#su-create')) return;

    $('#su-create').onclick = () => {
      const wage = parseFloat($('#su-wage').value);
      const start = $('#su-start').value;
      const signed = $('#su-signed').value;
      const foodMode = $('#su-food-mode').value;
      const restPay = $('#su-rest-pay').value;
      const restWork = $('#su-rest-work').value;
      const earlyHoliday = $('#su-early-holiday').value;
      const winterChoice = $('#su-winter').value;
      if (!(wage > 0) || !start || !signed || !foodMode || !restPay || !restWork || !earlyHoliday || !winterChoice) {
        toast(L('Complete every contract term before continuing', '繼續前請完成所有合約條款')); return;
      }
      const minimum = Legal.minimumRatesForContract(signed);
      const enteredFood = parseFloat($('#su-food').value) || 0;
      if (!minimum || wage < minimum.monthlyWage || (foodMode === 'allowance' && enteredFood < minimum.foodAllowance)) {
        toast(L('Wage or food allowance is below the audited contract-date minimum', '工資或膳食津貼低於已審核的合約日期最低標準')); return;
      }
      const defaults = state.pendingEmployerDefaults || {};
      const contractEnd = Compliance.expectedContractEnd(start);
      const foodAllowance = foodMode === 'allowance' ? enteredFood : 0;

      const id = Store.profiles.create();
      Store.profiles.setActive(id);
      state.config = {
        helperName: $('#su-helper').value.trim(),
        employerName: defaults.employerName || '',
        contractType: 'ID407',
        contractSignedOn: signed,
        monthlyWage: wage,
        foodMode: foodMode,
        foodAllowance: foodAllowance,
        startDate: start,
        contractEndDate: contractEnd,
        wagePeriods: [{ effectiveFrom: start, effectiveTo: contractEnd, monthlyWage: wage }],
        foodTerms: [{ effectiveFrom: start, effectiveTo: contractEnd, mode: foodMode, monthlyAmount: foodAllowance }],
        endDate: '',
        restDayWeekday: +$('#su-rest').value,
        restDayPayTerm: restPay,
        restDayWorkArrangement: restWork,
        restDayWorkPayment: 0,
        firstThreeMonthHolidayPayTerm: earlyHoliday,
        winterHolidayChoice: winterChoice,
        restDayOverrides: {},
        holidays: Holidays.defaultHolidays(winterChoice),
        holidayCalendarVersion: Holidays.CALENDAR_VERSION,
        holidayWorkBonusAmount: 0,
        helperPin: '',
        employerPin: defaults.employerPin || '',
        lastBackupAt: null,
        createdAt: new Date().toISOString()
      };
      state.logs = {};
      state.payments = [];
      state.adjustments = {};
      state.statements = [];
      state.addingProfile = false;
      state.pendingEmployerDefaults = null;
      saveConfig();
      saveLogs();
      savePayments();
      saveAdjustments();
      saveStatements();
      HSTrack('setup-completed');
      toast(state.config.helperName
        ? (isZh() ? '歡迎，' + state.config.helperName + '！🎉' : 'Welcome, ' + state.config.helperName + '! 🎉')
        : L('Welcome! 🎉', '歡迎！🎉'));
      render();
    };
  }

  // ----- today -----

  function todayHtml() {
    const ds = E.todayStr();
    const employed = E.isEmployedOn(ds, state.config);
    const cls = employed ? E.classifyDay(ds, state.config) : null;
    const selected = employed ? currentWork(ds, cls) : null;
    const entry = state.logs[ds];

    let dayCard;
    if (!employed) {
      dayCard = '<div class="card"><div class="today-date">' + esc(fmtDate(ds)) + '</div>' +
        '<p class="muted mt">' + L('Outside the employment period.', '不在僱傭期內。') + '</p></div>';
    } else {
      const opts = workOptions(cls);
      dayCard = '<div class="card">' +
        '<div class="spread"><div class="today-date">' + esc(fmtDate(ds)) + '</div></div>' +
        '<div class="today-type">' + dayBadges(cls) + '</div>' +
        '<div class="choice-list">' +
        opts.map((o, i) =>
          '<button class="choice' + (o.work === selected ? ' selected' : '') + '" data-work="' + o.work + '">' +
          '<span>' + esc(o.label) + '<span class="sub">' + esc(o.sub) + '</span></span>' +
          '<span class="row"><span class="amt ' + o.cl + '">' + esc(o.amt) + '</span>' +
          '<span class="check">' + (o.work === selected ? '✓' : '') + '</span></span>' +
          '</button>').join('') +
        '</div>' +
        (entry && entry.note ? '<p class="muted small mt">' + L('Note: ', '備註：') + esc(entry.note) + '</p>' : '') +
        '<button class="btn ghost compact mt" id="today-more">' + L('Add a note / more options', '加入備註／更多選項') + '</button>' +
        '</div>';
    }

    // pending day-log approvals — employer approves, helper sees status
    let pendingCard = '';
    const pend = pendingLogDates();
    if (pend.length) {
      const rows = pend.map(d => {
        const e = state.logs[d];
        return '<div class="pending-row" data-open-day="' + d + '">' +
          '<div class="grow"><b>' + esc(fmtDate(d)) + '</b>' +
          '<div class="muted small">' + esc(describeLogEffect(d)) +
          (e.note ? ' · “' + esc(e.note) + '”' : '') + '</div></div>' +
          (!state.ui.helperMode
            ? '<button class="btn compact" data-approve-log="' + d + '" style="background:var(--green)">✓</button>'
            : '<span class="badge pending">⏳</span>') +
          '</div>';
      }).join('');
      pendingCard = '<div class="card">' +
        '<h2>' + (state.ui.helperMode
          ? L('Waiting for employer approval (', '等待僱主批准（') + pend.length + L(')', '）')
          : isZh()
            ? '⏳ 待批准的' + esc(state.config.helperName || '外傭') + '記錄（' + pend.length + '）'
            : '⏳ ' + esc(state.config.helperName || 'Helper') + '’s logs to approve (' + pend.length + ')') + '</h2>' +
        rows +
        (!state.ui.helperMode && pend.length > 1
          ? '<button class="btn secondary compact mt" id="approve-all-logs">' +
            (isZh() ? '全部批准（' + pend.length + '）' : 'Approve all ' + pend.length) + '</button>'
          : '') +
        '</div>';
    }

    // this-month summary (always the real current month, not the browsed one)
    const today = E.parseYmd(ds);
    const stmt = E.computeMonth(today.y, today.m, state.config, state.logs);
    let summary = '';
    if (stmt) {
      summary = '<div class="card">' +
        '<h2>' + (isZh() ? monthYear(stmt.year, stmt.month) + '截至目前' : monthYear(stmt.year, stmt.month).split(' ')[0] + ' so far') + '</h2>' +
        '<div class="stat-row">' +
        '<div class="stat"><div class="v plus">+' + (stmt.allowanceDays || 0) + L('d', '日') + '</div><div class="k">' + L('Extra work', '額外工作') + '</div></div>' +
        '<div class="stat"><div class="v minus">−' + (stmt.deductionDays || 0) + L('d', '日') + '</div><div class="k">' + L('Leave', '無薪假') + '</div></div>' +
        '<div class="stat"><div class="v">' + money(stmt.total) + '</div><div class="k">' + L('Projected salary', '預計薪金') + '</div></div>' +
        '</div>' +
        '<p class="muted small mt">' + L(
          'Only exceptions need logging — normal working days count automatically.',
          '只需記錄例外情況——正常工作日會自動計算。'
        ) + '</p>' +
        '</div>';
    }

    // upcoming rest days / holidays (next 14 days)
    let upcoming = '';
    const items = [];
    for (let i = 1; i <= 14; i++) {
      const d = E.addDays(ds, i);
      if (!E.isEmployedOn(d, state.config)) continue;
      const c = E.classifyDay(d, state.config);
      if (c.type !== 'normal') {
        items.push('<div class="stmt-line"><span class="lbl"><b>' + esc(fmtDate(d)) + '</b></span>' +
          '<span>' + dayBadges(c) + '</span></div>');
      }
      if (items.length >= 4) break;
    }
    if (items.length) {
      upcoming = '<div class="card"><h2>' + L('Coming up', '即將到來') + '</h2>' + items.join('') + '</div>';
    }

    return dayCard + pendingCard + owedCardHtml() + summary + upcoming;
  }

  function bindToday() {
    $$('#view [data-schedule-alt]').forEach(b => {
      b.onclick = () => {
        const item = E.owedAlternativeHolidays(state.config, state.logs)
          .find(o => o.date === b.dataset.scheduleAlt);
        if (item) openScheduleAltSheet(item);
      };
    });
    $$('#view [data-approve-log]').forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        approveLog(b.dataset.approveLog);
        toast(L('Approved ✓', '已批准 ✓'));
        render();
      };
    });
    const all = $('#approve-all-logs');
    if (all) all.onclick = () => {
      const n = pendingLogDates().length;
      pendingLogDates().forEach(approveLog);
      toast(isZh() ? '已批准' + n + '項記錄 ✓' : n + ' logs approved ✓');
      render();
    };
    $$('#view .pending-row').forEach(row => {
      row.onclick = () => openDaySheet(row.dataset.openDay);
    });

    const ds = E.todayStr();
    if (!E.isEmployedOn(ds, state.config)) return;
    const cls = E.classifyDay(ds, state.config);
    $$('#view .choice').forEach(btn => {
      btn.onclick = () => {
        if (!requireMembership()) return;
        const entry = state.logs[ds];
        setWork(ds, cls, parseFloat(btn.dataset.work), entry && entry.note);
        toast(state.ui.helperMode ? L('Sent for approval ✓', '已送交批准 ✓') : L('Saved ✓', '已儲存 ✓'));
        render();
      };
    });
    const more = $('#today-more');
    if (more) more.onclick = () => openDaySheet(ds);
  }

  // ----- calendar -----

  function calendarHtml() {
    const y = state.calY, m = state.calM;
    const dim = E.daysInMonth(y, m);
    const firstWd = E.weekdayOf(E.ymd(y, m, 1));

    let cells = '';
    for (let i = 0; i < firstWd; i++) cells += '<div class="cal-cell empty"></div>';
    for (let d = 1; d <= dim; d++) {
      const ds = E.ymd(y, m, d);
      const employed = E.isEmployedOn(ds, state.config);
      if (!employed) {
        cells += '<div class="cal-cell outside">' + d + '</div>';
        continue;
      }
      const cls = E.classifyDay(ds, state.config);
      const entry = state.logs[ds];
      const isToday = ds === E.todayStr();
      let dots = '';
      if (cls.isRest) dots += '<span class="dot rest"></span>';
      if (cls.holiday) dots += '<span class="dot holiday"></span>';
      const isPending = entry && entry.status === 'pending';
      let mark = '';
      if (entry && typeof entry.work === 'number' && entry.work !== E.defaultWork(cls.type)) {
        if (cls.type === 'normal') {
          mark = entry.work === 0 ? '<span class="mark minus">−1</span>' : '<span class="mark minus">−½</span>';
        } else {
          mark = entry.work === 1 ? '<span class="mark plus">+1</span>'
            : entry.work === 0.5 ? '<span class="mark plus">+½</span>' : '';
        }
      } else if (isPending) {
        mark = '<span class="mark pend">?</span>'; // helper reset a day to default — still needs a look
      }
      cells += '<button class="cal-cell' + (isToday ? ' today' : '') +
        (cls.isRest ? ' rest' : '') + (cls.holiday ? ' holiday' : '') +
        (isPending ? ' pending' : '') + '" data-date="' + ds + '">' +
        d + '<span class="dots">' + dots + '</span>' + mark + '</button>';
    }

    // named list of this month's statutory holidays — glanceable below the grid
    const monthStartStr = E.ymd(y, m, 1);
    const monthEndStr = E.ymd(y, m, dim);
    const monthHolidays = (state.config.holidays || [])
      .filter(h => h.date >= monthStartStr && h.date <= monthEndStr)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    let holList = '';
    if (monthHolidays.length) {
      holList = '<div class="hol-list">' + monthHolidays.map(h =>
        '<button class="hol-item" data-date="' + esc(h.date) + '">' +
        '<span class="dot holiday"></span><b>' + esc(fmtDateShort(h.date)) + '</b>' +
        '<span class="nm">' + esc(holidayName(h.name)) + '</span></button>').join('') + '</div>';
    }

    return '<div class="card">' +
      '<div class="cal-head">' +
      '<button class="nav-btn" id="cal-prev">‹</button>' +
      '<div class="title">' + monthYear(y, m) + '</div>' +
      '<button class="nav-btn" id="cal-next">›</button>' +
      '</div>' +
      '<div class="cal-grid">' +
      weekdaysShort().map((w, i) => '<div class="cal-dow' + (i === 0 ? ' sun' : '') + '">' + w + '</div>').join('') +
      cells +
      '</div>' +
      holList +
      '<div class="cal-legend">' +
      '<span class="item"><span class="dot rest"></span> ' + L('Rest day', '休息日') + '</span>' +
      '<span class="item"><span class="dot holiday"></span> ' + L('Statutory holiday', '法定假日') + '</span>' +
      '<span class="item"><span class="mark plus">+1</span> ' + L('Extra work', '額外工作') + '</span>' +
      '<span class="item"><span class="mark minus">−1</span> ' + L('Leave', '無薪假') + '</span>' +
      '</div>' +
      '<p class="muted small mt">' + L(
        'Tap any day to log work, leave, or rest-day changes.',
        '按任何日期即可記錄工作、請假或更改休息日。'
      ) + '</p>' +
      '</div>';
  }

  function bindCalendar() {
    $('#cal-prev').onclick = () => {
      state.calM--; if (state.calM === 0) { state.calM = 12; state.calY--; }
      render();
    };
    $('#cal-next').onclick = () => {
      state.calM++; if (state.calM === 13) { state.calM = 1; state.calY++; }
      render();
    };
    $$('#view .cal-cell[data-date]').forEach(c => {
      c.onclick = () => openDaySheet(c.dataset.date);
    });
    $$('#view .hol-item').forEach(b => {
      b.onclick = () => openDaySheet(b.dataset.date);
    });
  }

  // ----- salary -----

  function salaryHtml() {
    const y = state.salY, m = state.salM;
    const stmt = E.computeMonth(y, m, state.config, state.logs);

    const head = '<div class="card"><div class="cal-head">' +
      '<button class="nav-btn" id="sal-prev">‹</button>' +
      '<div class="title">' + monthYear(y, m) + '</div>' +
      '<button class="nav-btn" id="sal-next">›</button>' +
      '</div>';

    if (!stmt) {
      return head + '<p class="muted">' + L('No employment in this month.', '本月不在僱傭期內。') + '</p></div>';
    }

    const adjustments = monthAdjustments(stmt.key);
    const payments = monthPayments(stmt.key);
    const assessment = Compliance.assessMonth({
      statement: stmt, config: state.config, logs: state.logs,
      adjustments: adjustments, engine: E
    });
    const frozen = latestStatement(stmt.key);
    const projection = monthDue(stmt);
    const due = frozen ? frozen.totals.finalized.total : projection;
    const paid = monthPaid(stmt.key);
    const balance = E.round2(due - paid);
    const helperMode = state.ui.helperMode;

    const allowLines = stmt.lines.filter(l => l.kind === 'allowance');
    const dedLines = stmt.lines.filter(l => l.kind === 'deduction');
    const infoLines = stmt.lines.filter(l => l.kind === 'holiday-worked' || l.kind === 'rest-day-worked');

    let html = head;
    html += '<p class="muted small">' + esc(fmtDateShort(stmt.periodStart)) + ' – ' + esc(fmtDateShort(stmt.periodEnd)) +
      (stmt.partial ? (isZh() ? ' · 非完整月份（' + stmt.periodDays + '日）' : ' · partial month (' + stmt.periodDays + ' days)') : '') + '</p>';
    html += '<p class="muted small">' + L('Reference rate only: ', '只供參考的日率：') + money(state.config.monthlyWage) + ' × 12 ÷ 365 = HK$' +
      stmt.dailyWage.toFixed(4) + '</p>';

    if (frozen) {
      html += '<div class="legal-status ready mt"><b>✓ ' + L('Frozen statement', '已凍結結算單') + '</b><p>' +
        L('This payment total is preserved with calculation and legal-source versions. Later edits do not rewrite it.', '此付款總額已連同計算及法律來源版本保存；其後修改不會改寫此記錄。') +
        '</p><code>' + esc(frozen.inputChecksum) + '</code></div>';
    } else if (!assessment.ready) {
      html += '<div class="legal-status blocked mt"><b>⚠️ ' + L('Not ready to freeze', '尚未可凍結') + '</b><p>' +
        L('This is a reference estimate only. Resolve these items before recording payment:', '目前只屬參考估算。記錄付款前請先處理：') + '</p><ul>' +
        assessment.blockers.slice(0, 5).map(issue => '<li>' + esc(isZh() ? issue.zh : issue.en) + '</li>').join('') +
        (assessment.blockers.length > 5 ? '<li>' + L('And ', '另有') + (assessment.blockers.length - 5) + L(' more…', '項……') + '</li>' : '') +
        '</ul><button class="btn secondary compact mt" id="sal-review">' + L('Review legal setup', '覆核法律設定') + '</button></div>';
    } else {
      html += '<div class="legal-status ready mt"><b>✓ ' + L('Ready to freeze', '可凍結') + '</b><p>' +
        L('All supported checks pass. Finalising creates an immutable local statement.', '所有已支援檢查均已通過；完成結算會建立不可改動的本機記錄。') + '</p></div>';
    }

    html += '<div class="mt">';
    html += '<div class="stmt-line"><span class="lbl"><b>' + L('Base pay', '基本薪金') + '</b>' +
      (stmt.partial
        ? (isZh() ? '（' + stmt.periodDays + '日 × 每日工資）' : ' (' + stmt.periodDays + ' days × daily wage)')
        : L(' (monthly wage)', '（月薪）')) + '</span>' +
      '<span class="val">' + money(stmt.base) + '</span></div>';

    const pendTag = l => (l.pending ? ' <span class="badge pending">' + L('pending', '待批准') + '</span>' : '');
    allowLines.forEach(l => {
      html += '<div class="stmt-line sub"><span class="lbl">' + esc(fmtDateShort(l.date)) + ' · ' + esc(statementLineLabel(l)) + pendTag(l) + '</span>' +
        '<span class="val plus">+' + money(l.amount) + '</span></div>';
    });
    dedLines.forEach(l => {
      html += '<div class="stmt-line sub"><span class="lbl">' + esc(fmtDateShort(l.date)) + ' · ' + esc(statementLineLabel(l)) + pendTag(l) + '</span>' +
        '<span class="val minus">−' + money(l.amount) + '</span></div>';
    });
    infoLines.forEach(l => {
      html += '<div class="stmt-line sub"><span class="lbl">' + esc(fmtDateShort(l.date)) + ' · ' + esc(statementLineLabel(l)) + pendTag(l) + '</span>' +
        '<span class="val zero" style="color:var(--muted)">' + L('agreement required', '須按協議') + '</span></div>';
    });
    if (stmt.food > 0) {
      html += '<div class="stmt-line"><span class="lbl"><b>' + L('Food allowance', '膳食津貼') + '</b></span><span class="val">+' + money(stmt.food) + '</span></div>';
    }
    adjustments.forEach(a => {
      html += '<div class="stmt-line"><span class="lbl"><b>' + L('Voluntary payment', '自願付款') + '</b> · ' + esc(a.label) + '</span>' +
        '<span class="val ' + (a.amount >= 0 ? 'plus' : 'minus') + '">' + (a.amount >= 0 ? '+' : '−') + money(Math.abs(a.amount)) +
        (!helperMode ? ' <button class="del" data-del-adj="' + a.id + '" style="color:var(--red);font-weight:800">×</button>' : '') +
        '</span></div>';
    });
    html += '</div>';

    if (stmt.pendingCount > 0) {
      html += '<div class="banner mt">⏳ ' + (isZh()
        ? '本月仍有' + stmt.pendingCount + '項工作日記錄等待僱主批准——請前往「今日」頁。這些項目可能顯示在估算內，但絕不會進入已凍結總額。'
        : stmt.pendingCount + ' day log' + (stmt.pendingCount === 1 ? '' : 's') +
          ' in this month still need' + (stmt.pendingCount === 1 ? 's' : '') +
          ' employer approval — see the Today tab. They may appear in the estimate but can never enter a frozen total.') + '</div>';
    }

    html += '<div class="stmt-total"><span>' + (frozen ? L('Frozen total', '已凍結總額') : L('Reference estimate', '參考估算')) + '</span><span class="amt">' + money(due) + '</span></div>';
    if (paid > 0) {
      html += '<div class="stmt-line mt"><span class="lbl">' + L('Paid so far', '目前已付') + '</span><span class="val">' + money(paid) + '</span></div>';
      html += '<div class="stmt-line"><span class="lbl"><b>' + L('Balance', '尚欠') + '</b></span><span class="val ' +
        (Math.abs(balance) < 0.005 ? 'plus' : '') + '">' +
        (Math.abs(balance) < 0.005 ? L('Settled ✓', '已付清 ✓') : money(balance)) + '</span></div>';
    }

    html += '<div class="row mt">' +
      '<button class="btn secondary compact grow" id="sal-copy">' + L('Copy statement', '複製結算單') + '</button>' +
      (!helperMode && !frozen ? '<button class="btn ghost compact" id="sal-adj">' + L('+ Voluntary pay', '+ 自願付款') + '</button>' : '') +
      '</div>';
    if (!helperMode) {
      html += '<button class="btn mt" id="sal-pay">' + (frozen ? L('Record payment from frozen statement', '按已凍結結算單記錄付款') : L('Freeze statement & record payment', '凍結結算單並記錄付款')) + '</button>';
    }
    html += '</div>';

    // payments list
    if (payments.length) {
      html += '<div class="card"><h2>' + L('Payments', '付款記錄') + '</h2>';
      payments.forEach(p => {
        const badge = p.status === 'approved'
          ? '<span class="badge approved">' + L('Approved ✓', '已確認 ✓') + '</span>'
          : '<span class="badge pending">' + L('Awaiting approval', '等待確認') + '</span>';
        html += '<div class="payment-item" data-payment="' + p.id + '">' +
          '<div class="spread"><b>' + money(p.amount) + '</b>' + badge + '</div>' +
          '<p class="muted small">' + esc(fmtDate(p.date)) + ' · ' + esc(I18n.paymentMethod(p.method, state.ui.language)) +
          (p.note ? ' · ' + esc(p.note) : '') + '</p>' +
          (!p.statementId ? '<p class="muted small" style="color:var(--amber)">⚠️ ' + L('Legacy payment — no frozen calculation snapshot', '舊付款記錄 — 沒有已凍結的計算快照') + '</p>' : '') +
          (p.approval ? '<p class="muted small">' + (isZh()
            ? '由' + esc(p.approval.name) + '於' + esc(new Date(p.approval.at).toLocaleString('zh-HK')) + '確認' + (p.approval.pinVerified ? '（已驗證 PIN）' : '')
            : 'Approved by ' + esc(p.approval.name) + ' on ' + esc(new Date(p.approval.at).toLocaleString('en-HK')) + (p.approval.pinVerified ? ' (PIN verified)' : '')) + '</p>' : '') +
          '<div class="thumbs" data-thumbs="' + p.id + '"></div>' +
          '<div class="row mt">' +
          (p.status !== 'approved' ? '<button class="btn blue compact grow" data-approve="' + p.id + '">' + L('Helper approval', '外傭確認收款') + '</button>' : '') +
          (!helperMode ? '<button class="btn ghost compact" data-addphoto="' + p.id + '">' + L('+ Photo', '+ 相片') + '</button>' : '') +
          (!helperMode && p.status !== 'approved' ? '<button class="btn ghost compact" data-delpay="' + p.id + '" style="color:var(--red)">' + L('Delete', '刪除') + '</button>' : '') +
          '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    return html + '<input type="file" id="hidden-photo" accept="image/*" multiple style="display:none">';
  }

  function bindSalary() {
    $('#sal-prev').onclick = () => {
      state.salM--; if (state.salM === 0) { state.salM = 12; state.salY--; }
      render();
    };
    $('#sal-next').onclick = () => {
      state.salM++; if (state.salM === 13) { state.salM = 1; state.salY++; }
      render();
    };
    const stmt = E.computeMonth(state.salY, state.salM, state.config, state.logs);
    if (!stmt) return;
    const assessment = Compliance.assessMonth({
      statement: stmt, config: state.config, logs: state.logs,
      adjustments: monthAdjustments(stmt.key), engine: E
    });
    const frozen = latestStatement(stmt.key);

    const reviewBtn = $('#sal-review');
    if (reviewBtn) reviewBtn.onclick = () => {
      state.ui.view = 'settings';
      saveUi();
      render();
    };

    const copyBtn = $('#sal-copy');
    if (copyBtn) copyBtn.onclick = () => {
      const text = statementText(stmt, {
        adjustments: monthAdjustments(stmt.key),
        paid: monthPaid(stmt.key) || 0
      });
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => toast(L('Statement copied — paste into WhatsApp', '已複製結算單 — 可貼到 WhatsApp')))
        .catch(() => { window.prompt(L('Copy the statement:', '請複製結算單：'), text); });
    };

    const adjBtn = $('#sal-adj');
    if (adjBtn) adjBtn.onclick = () => openAdjustmentSheet(stmt);
    const payBtn = $('#sal-pay');
    if (payBtn) payBtn.onclick = async () => {
      if (!requireMembership()) return;
      if (!frozen && !assessment.ready) {
        const first = assessment.blockers[0];
        toast(isZh() ? first.zh : first.en);
        return;
      }
      const snapshot = frozen || freezeStatement(stmt);
      if (!frozen) toast(L('Statement frozen with versioned inputs', '結算單已連同版本化輸入資料凍結'));
      openPaymentSheet(stmt, snapshot);
    };

    $$('#view [data-del-adj]').forEach(b => {
      b.onclick = async () => {
        if (!(await confirmDialog(
          L('Delete adjustment?', '刪除調整？'),
          L('This removes the adjustment line.', '這會移除該項調整。'),
          L('Delete', '刪除'), true))) return;
        state.adjustments[stmt.key] = monthAdjustments(stmt.key).filter(a => a.id !== b.dataset.delAdj);
        saveAdjustments();
        render();
      };
    });

    $$('#view [data-thumbs]').forEach(div => {
      const p = state.payments.find(x => x.id === div.dataset.thumbs);
      if (p) loadThumbs(div, p);
    });

    $$('#view [data-approve]').forEach(b => {
      b.onclick = () => openApprovalSheet(b.dataset.approve);
    });

    $$('#view [data-delpay]').forEach(b => {
      b.onclick = async () => {
        if (!(await confirmDialog(
          L('Delete payment?', '刪除付款記錄？'),
          L('The payment record and its screenshots will be removed.', '付款記錄及其截圖將會被移除。'),
          L('Delete', '刪除'), true))) return;
        const p = state.payments.find(x => x.id === b.dataset.delpay);
        if (p) for (const fid of p.fileIds || []) await Store.files.remove(fid);
        state.payments = state.payments.filter(x => x.id !== b.dataset.delpay);
        savePayments();
        render();
      };
    });

    const hidden = $('#hidden-photo');
    $$('#view [data-addphoto]').forEach(b => {
      b.onclick = () => {
        hidden.dataset.paymentId = b.dataset.addphoto;
        hidden.click();
      };
    });
    if (hidden) hidden.onchange = async () => {
      if (!requireMembership()) return;
      const p = state.payments.find(x => x.id === hidden.dataset.paymentId);
      if (p && hidden.files.length) {
        await attachFiles(p, hidden.files);
        toast(L('Screenshot added', '已加入截圖'));
        render();
      }
    };
  }

  // ----- settings -----

  function backupOverdue() {
    const hasData = Object.keys(state.logs).length || state.payments.length;
    if (!hasData) return false;
    if (!state.config.lastBackupAt) return true;
    return Date.now() - new Date(state.config.lastBackupAt).getTime() > 21 * 86400000;
  }

  function settingsHtml() {
    const c = state.config;
    let html = '';

    if (backupOverdue()) {
      html += '<div class="banner">📥 ' + L(
        'DEMO: changes reset on exit or reload. Do not enter real payroll data.',
        '示範：離開或重新載入後會重設。請勿輸入真實薪酬資料。'
      ) + '</div>';
    }

    html += '<div class="card"><div class="spread language-row"><div><h2>' + L('Language', '語言') + '</h2>' +
      '<p class="muted small">' + L('Choose the app display language.', '選擇應用程式顯示語言。') + '</p></div>' +
      languageSwitchHtml() + '</div></div>';

    // helper profiles — a household can employ more than one helper
    const ids = Store.profiles.list();
    const activeId = Store.profiles.active();
    html += '<div class="card"><h2>' + L('Helpers', '外傭') + '</h2>';
    ids.forEach(id => {
      const cfg = id === activeId ? c : Store.profiles.loadFor(id, 'config', null);
      const name = (cfg && cfg.helperName) || L('Unnamed helper', '未命名外傭');
      html += '<div class="holiday-row">' +
        '<span class="date">' + esc(name) + '</span>' +
        '<span class="name">' + (cfg ? L('from ', '由') + esc(fmtDateShort(cfg.startDate)) + ' · ' + money(cfg.monthlyWage) + L('/mo', '／月') : '') + '</span>' +
        (id === activeId
          ? '<span class="badge approved">' + L('active', '使用中') + '</span>'
          : '<button class="btn ghost compact" data-switch-helper="' + id + '">' + L('Switch', '切換') + '</button>') +
        (ids.length > 1 ? '<button class="del" data-del-helper="' + id + '">×</button>' : '') +
        '</div>';
    });
    html += '<button class="btn secondary compact mt" id="add-helper">' + L('+ Add helper', '+ 加入外傭') + '</button>' +
      '<p class="muted small mt">' + L(
        'Each helper has her own calendar, statements, payments and PIN. Switch to the right helper before handing the phone over.',
        '每位外傭都有獨立的日曆、結算單、付款記錄及 PIN。將手機交給外傭前，請先切換至正確的外傭。'
      ) + '</p></div>';

    html += '<div class="card"><h2>' + L('People', '人員資料') + '</h2>' +
      '<label>' + L('Helper\'s name', '外傭姓名') + '</label><input id="st-helper" value="' + esc(c.helperName) + '">' +
      '<label>' + L('Employer\'s name (optional)', '僱主姓名（選填）') + '</label><input id="st-employer" value="' + esc(c.employerName || '') + '">' +
      '</div>';

    html += '<div class="card"><h2>' + L('ID 407 contract &amp; pay', 'ID 407 合約及薪酬') + '</h2>' +
      '<div class="banner">⚖️ ' + L(
        'Existing records are not changed automatically. Complete these legal terms before a monthly estimate can be frozen for payment.',
        '系統不會自動更改現有記錄。完成以下法律條款後，才可把每月估算凍結作付款記錄。'
      ) + '</div>' +
      '<label>' + L('Contract type', '合約類型') + '</label><select id="st-contract-type"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="ID407"' + (c.contractType === 'ID407' ? ' selected' : '') + '>ID 407</option></select>' +
      '<label>' + L('Contract signed on', '合約簽署日期') + '</label><input id="st-signed" type="date" value="' + esc(c.contractSignedOn || '') + '">' +
      '<label>' + L('Monthly wage (HK$)', '月薪（港幣）') + '</label><input id="st-wage" type="number" inputmode="decimal" value="' + c.monthlyWage + '">' +
      '<label>' + L('Food arrangement', '膳食安排') + '</label><select id="st-food-mode"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="provided"' + (c.foodMode === 'provided' ? ' selected' : '') + '>' + L('Food provided free', '免費提供膳食') + '</option><option value="allowance"' + (c.foodMode === 'allowance' ? ' selected' : '') + '>' + L('Monthly allowance', '每月膳食津貼') + '</option></select>' +
      '<label>' + L('Food allowance (HK$/month)', '膳食津貼（港幣／月）') + '</label><input id="st-food" type="number" inputmode="decimal" value="' + (c.foodAllowance || 0) + '">' +
      '<label>' + L('Contract start date', '合約開始日期') + '</label><input id="st-start" type="date" value="' + esc(c.startDate) + '">' +
      '<label>' + L('Two-year contract end date', '兩年合約完結日期') + '</label><input id="st-contract-end" type="date" value="' + esc(c.contractEndDate || '') + '">' +
      '<label>' + L('Actual last day (only if employment ended early)', '實際最後工作日（只在提早終止時填寫）') + '</label><input id="st-end" type="date" value="' + esc(c.endDate || '') + '">' +
      '<label>' + L('Weekly rest day', '每周休息日') + '</label><select id="st-rest">' +
      weekdays().map((w, i) => '<option value="' + i + '"' + (i === c.restDayWeekday ? ' selected' : '') + '>' + w + '</option>').join('') + '</select>' +
      '<p class="muted small">' + L('The pattern starts immediately and is checked across every rolling seven-day period.', '休息日安排由受僱首日開始，並會按每個連續七日期間檢查。') + '</p>' +
      '<label>' + L('Rest-day pay term', '休息日薪酬條款') + '</label><select id="st-rest-pay"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="paid"' + (c.restDayPayTerm === 'paid' ? ' selected' : '') + '>' + L('Paid', '有薪') + '</option><option value="unpaid"' + (c.restDayPayTerm === 'unpaid' ? ' selected' : '') + '>' + L('Unpaid', '無薪') + '</option></select>' +
      '<label>' + L('Agreed arrangement for rest-day work', '休息日工作之雙方協議安排') + '</label><select id="st-rest-work"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="substituted_rest_day"' + (c.restDayWorkArrangement === 'substituted_rest_day' ? ' selected' : '') + '>' + L('Substituted rest day', '補回休息日') + '</option><option value="agreed_payment"' + (c.restDayWorkArrangement === 'agreed_payment' ? ' selected' : '') + '>' + L('Agreed cash amount', '雙方同意現金金額') + '</option></select>' +
      '<label>' + L('Agreed amount per full rest day worked (HK$; if applicable)', '每個完整休息日工作的協議金額（港幣；如適用）') + '</label><input id="st-rest-payment" type="number" inputmode="decimal" value="' + (c.restDayWorkPayment || 0) + '">' +
      '<label>' + L('First-three-month statutory-holiday pay term', '首3個月法定假日薪酬條款') + '</label><select id="st-early-holiday"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="paid"' + (c.firstThreeMonthHolidayPayTerm === 'paid' ? ' selected' : '') + '>' + L('Paid by agreement', '按協議有薪') + '</option><option value="unpaid"' + (c.firstThreeMonthHolidayPayTerm === 'unpaid' ? ' selected' : '') + '>' + L('Unpaid', '無薪') + '</option></select>' +
      '<label>' + L('Optional extra amount per statutory holiday worked (HK$)', '每個法定假日工作的自願額外金額（港幣）') + '</label><input id="st-holiday-bonus" type="number" inputmode="decimal" value="' + (c.holidayWorkBonusAmount || 0) + '">' +
      '<p class="muted small mt">' + L(
        'The ×12÷365 figure is shown only as a reference estimate. Statutory average-wage entitlements use the required preceding wage history and excluded periods; unsupported cases are blocked.',
        '×12÷365 只會顯示為參考估算。法定平均工資權利須使用指定的過往工資記錄及剔除期間；未支援的情況會被阻止。'
      ) + '</p><button class="btn secondary compact mt" id="st-confirm-terms">' + L('Confirm displayed wage & food for full contract', '確認畫面工資及膳食條款適用於整份合約') + '</button></div>';

    // holidays grouped by year
    const byYear = {};
    (c.holidays || []).forEach(h => {
      const y = h.date.slice(0, 4);
      (byYear[y] = byYear[y] || []).push(h);
    });
    html += '<div class="card"><h2>' + L('Statutory holidays', '法定假日') + '</h2>' +
      '<label>' + L('Contractual choice: Winter Solstice or Christmas', '合約選擇：冬節或聖誕節') + '</label><select id="st-winter"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="winter_solstice"' + (c.winterHolidayChoice === 'winter_solstice' ? ' selected' : '') + '>' + L('Winter Solstice', '冬節') + '</option><option value="christmas"' + (c.winterHolidayChoice === 'christmas' ? ' selected' : '') + '>' + L('Christmas Day', '聖誕節') + '</option></select>';
    Object.keys(byYear).sort().forEach(y => {
      html += '<h3>' + y + '</h3>';
      byYear[y].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(h => {
        html += '<div class="holiday-row"><span class="date">' + esc(fmtDateShort(h.date)) + '</span>' +
          '<span class="name">' + esc(holidayName(h.name)) + '</span>' +
          '<button class="del" data-del-holiday="' + esc(h.date) + '">×</button></div>';
      });
    });
    html += '<label>' + L('Add holiday', '加入假日') + '</label>' +
      '<div class="row"><input id="st-hol-date" type="date"><input id="st-hol-name" placeholder="' + L('Name', '名稱') + '"></div>' +
      '<div class="row mt">' +
      '<button class="btn secondary compact grow" id="st-hol-add">' + L('Add', '加入') + '</button>' +
      '<button class="btn ghost compact" id="st-hol-restore">' + L('Restore official list', '還原官方清單') + '</button>' +
      '</div>' +
      '<p class="muted small" style="margin-top:6px">' +
      L(
        'The embedded 2026–2027 calendars come from the Labour Department notices. Custom dates are records only and never silently replace an official statutory holiday.',
        '內置的2026至2027年日曆來自勞工處公告。自訂日期只屬記錄，絕不會自動取代官方法定假日。'
      ) + '</p>' +
      '</div>';

    html += '<div class="card"><h2>' + L('Security', '安全設定') + '</h2>' +
      '<label>' + L('Helper\'s PIN (verifies payment approvals)', '外傭 PIN（驗證收款確認）') + '</label>' +
      '<input id="st-hpin" type="password" inputmode="numeric" maxlength="6" placeholder="' + L('not set', '未設定') + '" value="' + esc(c.helperPin || '') + '">' +
      '<label>' + L('Employer\'s PIN (locks helper mode)', '僱主 PIN（鎖定外傭模式）') + '</label>' +
      '<input id="st-epin" type="password" inputmode="numeric" maxlength="6" placeholder="' + L('not set', '未設定') + '" value="' + esc(c.employerPin || '') + '">' +
      '<p class="muted small mt">' + L(
        'Both optional. Set them if you hand the phone to your helper for logging and approvals.',
        '兩項均為選填。如會將手機交給外傭記錄工作日或確認收款，建議設定 PIN。'
      ) + '</p>' +
      '</div>';

    html += '<div class="card"><h2>' + L('Data &amp; backup', '資料及備份') + '</h2>' +
      '<p class="muted small">' + L(
        'These sample records exist in memory only. Exports are labelled DEMO and cannot be imported into real records. Exported copies remain at the destination you choose. ',
        '樣本紀錄只存於記憶體。匯出檔案標示為示範，不能匯入真實紀錄。匯出的副本會保留在你選擇的位置。'
      ) + L('Save the downloaded JSON file to a trusted location. On iPhone, save a Safari preview to Files. A preview alone is not a backup.',
      '請將下載的 JSON 檔案妥善儲存。iPhone 如顯示 Safari 預覽，請另存到「檔案」；預覽並不等於備份。') + '</p>' +
      '<div class="row mt">' +
      '<button class="btn secondary compact grow" id="st-export">' + L('Export backup', '匯出備份') + '</button>' +
      '<button class="btn ghost compact grow" id="st-import">' + L('Import backup', '匯入備份') + '</button>' +
      '</div>' +
      '<input type="file" id="st-import-file" accept="application/json,.json" style="display:none">' +
      '<button class="btn ghost compact mt" id="st-reset" style="color:var(--red);border-color:var(--red)">' + L('Reset demo records', '重設示範紀錄') + '</button>' +
      '</div>';

    html += '<div class="card"><h2>' + L('Privacy controls', '私隱控制') + '</h2>' +
      '<label class="row" style="cursor:pointer;font-size:14px;color:var(--text);font-weight:600">' +
      '<input type="checkbox" id="st-analytics" disabled style="width:auto"' + (state.ui.analyticsConsent === true ? ' checked' : '') + '>' +
      '<span>' + L('Share anonymous usage statistics', '分享匿名使用統計') + '</span></label>' +
      '<p class="muted small mt">' + L(
        'Usage statistics and subscription processing are disabled in this demo. Real payroll and membership are not accessed.',
        '此示範模式停用使用統計及訂閱處理，不會存取真實薪酬或會籍資料。'
      ) + '</p><a class="btn secondary compact mt" href="privacy.html" target="_blank" rel="noopener" style="text-decoration:none">' + L('Read privacy policy', '閱讀私隱政策') + '</a></div>';

    html += '<div class="card"><h2>' + L('Legal calculation boundaries', '法律計算界線') + '</h2>' +
      '<p class="muted small">' + L(
        '• A complete month starts with the monthly contract wage and recorded food term.<br>' +
        '• ×12÷365 is a reference projection only, not a universal Labour Department formula.<br>' +
        '• Statutory average-wage entitlements require preceding wage history with excluded periods removed.<br>' +
        '• Rest-day pay and compensation follow the parties’ agreement; no cash amount is invented.<br>' +
        '• Statutory-holiday work requires 48 hours’ notice and an alternative holiday within 60 days; cash cannot replace it.<br>' +
        '• Pending entries, unrestricted deductions, incomplete contract terms and unsupported first/final-month cases cannot be frozen.<br><br>' +
        'HelperPay is a transparent reference and record-keeping tool, not legal advice or an authoritative payroll product.',
        '• 完整月份以合約月薪及已記錄的膳食條款為起點。<br>' +
        '• ×12÷365 只屬參考估算，並非勞工處適用於所有情況的公式。<br>' +
        '• 法定平均工資權益須使用過往工資記錄，並剔除指定期間及款項。<br>' +
        '• 休息日是否有薪及其工作補償按雙方協議；系統不會自行加上現金。<br>' +
        '• 法定假日工作須提前48小時通知，並在前後60日內安排另定假日；不得以現金取代。<br>' +
        '• 待批准記錄、不受限制的扣款、不完整合約條款及未支援的首月／尾月情況均不能凍結。<br><br>' +
        'HelperPay 是透明的參考及記錄工具，並非法律意見或權威薪酬產品。'
      ) + '</p>' +
      '<a class="btn secondary compact mt" href="' + Compliance.OFFICIAL_CALCULATOR + '" target="_blank" rel="noopener" style="text-decoration:none">' + L('Open official entitlement calculator', '開啟官方僱傭權益計算機') + '</a>' +
      '<a class="btn secondary compact mt" style="text-decoration:none" href="guide.html" target="_blank" rel="noopener">' +
      '📖 ' + L('User guide · 使用指南', '使用指南 · User guide') + '</a>' +
      '<a class="btn secondary compact mt" style="text-decoration:none" href="' + whatsappUrl() + '" target="_blank" rel="noopener">' +
      '💬 ' + L('WhatsApp the developer — ', 'WhatsApp 聯絡開發者 — ') + WHATSAPP_DISPLAY + '</a>' +
      '<p class="muted small mt">HelperPay v' + APP_VERSION + ' · ' +
      '<a href="mailto:' + FEEDBACK_EMAIL + '?subject=HelperPay%20feedback" style="color:var(--accent)">' + L('Email feedback', '電郵意見') + '</a></p>' +
      '</div>';

    return html;
  }

  function bindSettings() {
    const c = state.config;
    const bindField = (id, key, transform) => {
      const el = $(id);
      if (!el) return;
      el.onchange = () => {
        c[key] = transform ? transform(el.value) : el.value;
        saveConfig();
        toast(L('Saved', '已儲存'));
      };
    };
    bindField('#st-helper', 'helperName', v => v.trim());
    bindField('#st-employer', 'employerName', v => v.trim());
    bindField('#st-contract-type', 'contractType');
    bindField('#st-signed', 'contractSignedOn');
    bindField('#st-wage', 'monthlyWage', v => parseFloat(v) || 0);
    bindField('#st-food-mode', 'foodMode');
    bindField('#st-food', 'foodAllowance', v => parseFloat(v) || 0);
    bindField('#st-start', 'startDate');
    bindField('#st-contract-end', 'contractEndDate');
    bindField('#st-end', 'endDate');
    bindField('#st-rest', 'restDayWeekday', v => +v);
    bindField('#st-rest-pay', 'restDayPayTerm');
    bindField('#st-rest-work', 'restDayWorkArrangement');
    bindField('#st-rest-payment', 'restDayWorkPayment', v => parseFloat(v) || 0);
    bindField('#st-early-holiday', 'firstThreeMonthHolidayPayTerm');
    bindField('#st-holiday-bonus', 'holidayWorkBonusAmount', v => parseFloat(v) || 0);
    bindField('#st-hpin', 'helperPin', v => v.trim());
    bindField('#st-epin', 'employerPin', v => v.trim());
    bindField('#st-winter', 'winterHolidayChoice');

    const analytics = $('#st-analytics');
    if (analytics) analytics.onchange = () => {
      state.ui.analyticsConsent = analytics.checked;
      saveUi();
      if (window.HSAnalytics) window.HSAnalytics.setConsent(analytics.checked);
      toast(analytics.checked
        ? L('Anonymous statistics enabled', '已啟用匿名統計')
        : L('Anonymous statistics disabled', '已停用匿名統計'));
    };

    const confirmTerms = $('#st-confirm-terms');
    if (confirmTerms) confirmTerms.onclick = async () => {
      if (!c.startDate || !c.contractEndDate || !(c.monthlyWage > 0) ||
          (c.foodMode !== 'provided' && c.foodMode !== 'allowance')) {
        toast(L('Complete the contract dates, wage and food arrangement first', '請先完成合約日期、工資及膳食安排'));
        return;
      }
      const agreed = await confirmDialog(
        L('Confirm full-contract terms?', '確認整份合約條款？'),
        L(
          'Use this only if the displayed monthly wage and food arrangement apply without change for the complete two-year contract. If either changed, do not confirm; keep the statement blocked and use the official calculator.',
          '只在畫面顯示的月薪及膳食安排於整份兩年合約內均沒有更改時使用。如其中一項曾更改，請勿確認；應保留結算限制並使用官方計算機。'
        ),
        L('Confirm terms', '確認條款'));
      if (!agreed) return;
      c.wagePeriods = [{ effectiveFrom: c.startDate, effectiveTo: c.contractEndDate, monthlyWage: Number(c.monthlyWage) }];
      c.foodTerms = [{
        effectiveFrom: c.startDate, effectiveTo: c.contractEndDate,
        mode: c.foodMode,
        monthlyAmount: c.foodMode === 'allowance' ? Number(c.foodAllowance) : 0
      }];
      saveConfig();
      toast(L('Full-contract terms confirmed', '已確認整份合約條款'));
      render();
    };

    $('#add-helper').onclick = () => {
      state.pendingEmployerDefaults = { employerName: c.employerName, employerPin: c.employerPin };
      state.addingProfile = true;
      render();
    };

    $$('#view [data-switch-helper]').forEach(b => {
      b.onclick = () => {
        Store.profiles.setActive(b.dataset.switchHelper);
        loadActiveProfile();
        toast(L('Switched to ', '已切換至') + (state.config && state.config.helperName || L('helper', '外傭')));
        render();
      };
    });

    $$('#view [data-del-helper]').forEach(b => {
      b.onclick = async () => {
        const id = b.dataset.delHelper;
        const cfg = Store.profiles.loadFor(id, 'config', null);
        const name = (cfg && cfg.helperName) || L('this helper', '這位外傭');
        if (!(await confirmDialog(
          isZh() ? '移除' + name + '？' : 'Remove ' + name + '?',
          isZh()
            ? name + '的所有工作日記錄、結算單、付款及截圖將從此裝置永久刪除。'
            : 'All of ' + name + '’s day logs, statements, payments and screenshots will be permanently deleted from this device.',
          L('Remove', '移除'), true))) return;
        if (!(await confirmDialog(
          L('Are you sure?', '確定嗎？'),
          L('This cannot be undone. Export a backup first if unsure.', '此操作無法復原。如不確定，請先匯出備份。'),
          L('Yes, remove', '確定移除'), true))) return;
        const pays = Store.profiles.loadFor(id, 'payments', []);
        for (const p of pays) for (const fid of p.fileIds || []) await Store.files.remove(fid);
        Store.profiles.remove(id);
        loadActiveProfile();
        toast(isZh() ? '已移除' + name : name + ' removed');
        render();
      };
    });

    $$('#view [data-del-holiday]').forEach(b => {
      b.onclick = () => {
        c.holidays = c.holidays.filter(h => h.date !== b.dataset.delHoliday);
        saveConfig();
        render();
      };
    });

    $('#st-hol-add').onclick = () => {
      const date = $('#st-hol-date').value;
      const name = $('#st-hol-name').value.trim();
      if (!date || !name) { toast(L('Enter date and name', '請輸入日期及名稱')); return; }
      c.holidays = c.holidays.filter(h => h.date !== date);
      c.holidays.push({ date: date, name: name, type: 'contractual_holiday' });
      c.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
      saveConfig();
      render();
    };

    $('#st-hol-restore').onclick = async () => {
      if (!(await confirmDialog(
        L('Restore official list?', '還原官方清單？'),
        L('Refreshes official dates and retains linked time-off arrangements. Other custom holidays will be replaced. Older arrangements still need their notice/agreement details checked.', '更新官方日期並保留已連結的補假安排；其他自訂假日會被取代。舊補假仍須核對通知及協議資料。'),
        L('Restore', '還原')))) return;
      if (c.winterHolidayChoice !== 'winter_solstice' && c.winterHolidayChoice !== 'christmas') {
        toast(L('Choose Winter Solstice or Christmas first', '請先選擇冬節或聖誕節')); return;
      }
      const arrangements = (c.holidays || []).filter(h =>
        h.type === 'alternative_holiday' || h.type === 'substituted_holiday' ||
        h.type === 'rest_day_collision_holiday' || h.type === 'substituted_rest_day' ||
        h.type === 'contractual_holiday' || h.altFor || h.collisionFor || h.restFor);
      c.holidays = Holidays.defaultHolidays(c.winterHolidayChoice).concat(arrangements)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      c.holidayCalendarVersion = Holidays.CALENDAR_VERSION;
      saveConfig();
      render();
    };

    $('#st-export').onclick = async () => {
      const button = $('#st-export');
      button.disabled = true;
      try {
        await window.HSNativeBackup.export(await Store.exportAll(), state.ui.language);
        toast(L('Download requested. Check Files / Downloads to confirm the backup was saved.',
          '已要求下載。請到「檔案」／下載位置確認備份已儲存。'));
      } catch (error) {
        toast(L('Backup was not confirmed saved. Please try again and choose a trusted destination.',
          '未能確認備份已儲存。請重試並選擇可信任的儲存位置。'));
      } finally { button.disabled = false; }
    };

    bindNativeRestore($('#st-import'), $('#st-import-file'));

    $('#st-reset').onclick = async () => {
      if (!(await confirmDialog(
        L('Erase all data?', '清除所有資料？'),
        L('Only this demo workspace and its temporary share copies are reset. Real payroll and membership are unchanged. Copies you exported elsewhere remain there.', '只會重設示範工作區及其暫存分享檔案，真實薪酬及會籍不受影響。已匯出至其他位置的副本仍會保留。'),
        L('Erase', '清除'), true))) return;
      if (!(await confirmDialog(
        L('Are you absolutely sure?', '最後確認：確定嗎？'),
        L('This cannot be undone. Export a backup first if unsure.', '此操作無法復原。如不確定，請先匯出備份。'),
        L('Yes, erase everything', '確定清除全部資料'), true))) return;
      try {
        await window.HSReminders?.reset();
        await window.HSNativeBackup.clearTemporaryFiles();
        await Store.resetAll();
        location.reload();
      } catch (error) {
        await window.HSReminders?.resume();
        toast(L('Erasure did not finish. Please try again.', '清除尚未完成，請重試。'));
      }
    };
  }

  // ---------- mode toggle ----------

  async function toggleMode() {
    if (!state.config) return;
    if (!state.ui.helperMode) {
      state.ui.helperMode = true;
      if (state.ui.view === 'settings') state.ui.view = 'today';
      saveUi();
      toast(L('Helper mode — hand the phone over 👋', '外傭模式 — 可以把手機交給外傭 👋'));
      render();
    } else {
      if (state.config.employerPin) {
        const pin = await pinDialog(L('Exit helper mode', '離開外傭模式'), L('Enter the employer PIN.', '請輸入僱主 PIN。'));
        if (pin === null) return;
        if (pin !== state.config.employerPin) { toast(L('Wrong PIN', 'PIN 不正確')); return; }
      }
      state.ui.helperMode = false;
      saveUi();
      render();
    }
  }

  // ---------- boot ----------

  document.addEventListener('DOMContentLoaded', () => {
    $('#mode-chip').onclick = toggleMode;
    render();
    if (false) { // Demo assets are only loaded from the current package; no service worker.
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  });
})();
