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
  const PayHistory = window.HSContractHistory;
  const Compliance = window.HSCompliance;
  const Store = window.HSStore;
  const Holidays = window.HSHolidays;
  const HolidayReview = window.HSHolidayReview;
  const I18n = window.HSI18n;
  const Language = window.HSLanguage;

  const APP_VERSION = '1.1.1-web-free';
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


  function reminderProfiles() {
    return Store.profiles.list().map(id => {
      const profile = { id, config: Store.profiles.loadFor(id, 'config', null),
        logs: Store.profiles.loadFor(id, 'logs', {}), payments: Store.profiles.loadFor(id, 'payments', []),
        adjustments: Store.profiles.loadFor(id, 'adjustments', {}), statements: Store.profiles.loadFor(id, 'statements', []) };
      profile.payrollStatus = {};
      if (!profile.config || !validRecordDate(profile.config.startDate)) return profile;
      profile.holidayIssues = HolidayReview.problems(profile.config, E, profile.logs);
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      let month = profile.config.startDate.slice(0, 7) + '-01';
      for (let i = 0; i < 36 && month <= today; i++) {
        const stmt = E.computeMonth(+month.slice(0, 4), +month.slice(5, 7), profile.config, profile.logs);
        if (stmt) profile.payrollStatus[stmt.key] = payrollReviewStatus(stmt, profile, today);
        month = E.addDays(month, E.daysInMonth(+month.slice(0, 4), +month.slice(5, 7)));
      }
      return profile;
    });
  }
  function refreshNativeReminders() {
    if (!window.HSReminders) return; // Demo never loads the OS bridge.
    const profiles = reminderProfiles();
    window.HSReminders.afterRender({
      snapshot: () => ({
        language: state.ui.language, helperMode: state.ui.helperMode,
        view: state.ui.view, configured: !!state.config && !state.addingProfile,
        activeId: Store.profiles.active(),
        profiles
      }), openSheet, closeSheet, toast, render,
      navigate: event => {
        // Notification taps cannot bypass helper mode or its employer PIN.
        if (state.ui.helperMode && event.profileId !== Store.profiles.active()) return;
        if (!Store.profiles.list().includes(event.profileId)) return;
        Store.profiles.setActive(event.profileId); loadActiveProfile();
        if (!state.config) return;
        if (event.type === 'holiday_review') {
          if (state.ui.helperMode) return;
          state.ui.view='settings'; saveUi(); render(); openHolidayRecordReview(event.recordIndex); return;
        }
        if (event.type === 'history_range') { state.ui.view = state.ui.helperMode ? 'calendar' : 'settings'; saveUi(); render(); return; }
        if (event.type === 'pay' || event.type === 'final') {
          state.ui.view = 'salary'; state.salY = +event.monthKey.slice(0, 4); state.salM = +event.monthKey.slice(5, 7);
          saveUi(); render(); return;
        }
        const targetDate = event.sourceDate || event.date;
        state.ui.view = 'calendar'; state.calY = +targetDate.slice(0, 4); state.calM = +targetDate.slice(5, 7);
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
      language: window.HSInitialLanguage || I18n.detectLanguage(navigator.languages && navigator.languages.length
        ? navigator.languages : [navigator.language])
    }, Store.loadUi()),
    addingProfile: false,          // true while the "add another helper" setup is open
    onboardingStep: 1,            // first-run guidance; profile setup is the final step
    pendingEmployerDefaults: null, // employer name/PIN carried into a new profile
    setupDraft: {}                 // Preserve entered values across language/back navigation.
  };
  state.ui.language = Language.pick(location.search, window.HSInitialLanguage || state.ui.language);
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
  function pageLink(name) { return Language.href(name, state.ui.language, location.pathname.endsWith('/demo.html')); }

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
    if (extras && extras.snapshot) return confirmedStatementText(extras.snapshot, extras.paid || 0);
    if (stmt.estimateUnavailable) return L('No salary estimate for ', '此月份未有薪金估算：') + stmt.key + '\n' +
      L('Effective-dated wage / food terms need review. Use the official calculator; payments remain separate facts.', '工資／膳食生效歷史須核對，請使用官方計算機；已記錄付款仍屬獨立事實。');
    if (!isZh()) return E.statementText(stmt, state.config, extras);
    extras = extras || {};
    const lines = [];
    lines.push('薪金結算單 — ' + monthYear(stmt.year, stmt.month));
    if (state.config.helperName) lines.push('外傭：' + state.config.helperName);
    lines.push('期間：' + stmt.periodStart + ' 至 ' + stmt.periodEnd);
    lines.push('參考日率（不適用於所有法定權益）：' + money(stmt.monthlyWage ?? state.config.monthlyWage) + ' × 12 ÷ 365 = HK$' + stmt.dailyWage.toFixed(4));
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
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
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

  function enhanceFormLabels(root) {
    if (!root) return;
    root.querySelectorAll('label').forEach(label => {
      const field = label.nextElementSibling;
      if (!label.htmlFor && !label.querySelector('input,select,textarea') && field?.matches('input,select,textarea') && field.id) label.htmlFor = field.id;
    });
  }

  function requestSheetClose(overlay) {
    if (overlay._busy) { toast(L('Please wait until saving finishes.', '請等候儲存完成。')); return; }
    const finish = () => { closeSheet(overlay); overlay._onDismiss?.(); };
    if (!overlay._dirty || overlay._guardChanges === false) { finish(); return; }
    if (overlay.querySelector('[data-discard-warning]')) return;
    const warning = document.createElement('div');
    warning.className = 'banner'; warning.dataset.discardWarning = 'true'; warning.setAttribute('role', 'alert');
    warning.innerHTML = '<p>' + L('Leave without saving the changes in this form?', '離開而不儲存此表格的更改？') + '</p><div class="row mt">' +
      '<button type="button" class="btn secondary compact" data-keep-editing>' + L('Keep editing', '繼續填寫') + '</button>' +
      '<button type="button" class="btn ghost compact" data-discard>' + L('Discard these changes', '捨棄這些更改') + '</button></div>';
    overlay.querySelector('.sheet').prepend(warning);
    warning.querySelector('[data-keep-editing]').onclick = () => { warning.remove(); overlay.querySelector('.sheet').focus(); };
    warning.querySelector('[data-discard]').onclick = finish;
    warning.querySelector('[data-keep-editing]').focus();
  }

  function openSheet(html, opts) {
    html = '<p class="demo-tag">' + L('DEMO ONLY — not a real payroll record', '只供示範 — 並非真實薪酬紀錄') + '</p>' + html;
    opts = opts || {};
    const root = $('#sheet-root');
    const overlay = document.createElement('div');
    overlay.className = 'overlay' + (opts.center ? ' center' : '');
    overlay._returnFocus = document.activeElement;
    overlay._onDismiss = opts.onDismiss;
    overlay._guardChanges = opts.guardChanges !== false;
    overlay.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" tabindex="-1">' +
      (!opts.sticky ? '<div class="sheet-toolbar"><button type="button" class="btn ghost compact" data-sheet-close>' + L('Close', '關閉') + ' ×</button></div>' : '') + html + '</div>';
    const sheet = overlay.querySelector('.sheet');
    const heading = sheet.querySelector('h1,h2,h3');
    if (heading) { if (!heading.id) heading.id = 'sheet-heading-' + uid(); sheet.setAttribute('aria-labelledby', heading.id); }
    else sheet.setAttribute('aria-label', L('HelperPay form', 'HelperPay 表格'));
    enhanceFormLabels(sheet);
    overlay.querySelector('[data-sheet-close]')?.addEventListener('click', () => requestSheetClose(overlay));
    overlay.addEventListener('input', () => { overlay._dirty = true; });
    overlay.addEventListener('change', () => { overlay._dirty = true; });
    overlay.addEventListener('click', e => {
      if (e.target.closest('.choice') && !e.target.closest('.choice').classList.contains('selected')) overlay._dirty = true;
      if (overlay._dirty && e.target.closest('[id$="-cancel"],[id$="-close"],[data-close],[data-act="no"]')) {
        e.preventDefault(); e.stopImmediatePropagation(); requestSheetClose(overlay);
      }
    }, true);
    overlay.addEventListener('click', e => { if (e.target === overlay && !opts.sticky) requestSheetClose(overlay); });
    overlay._keydown = e => {
      if (root.lastElementChild !== overlay) return;
      if (e.key === 'Escape' && !opts.sticky) { e.preventDefault(); requestSheetClose(overlay); }
      if (e.key !== 'Tab') return;
      const controls = [...sheet.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex="0"]')]
        .filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); sheet.focus(); }
      else if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', overlay._keydown);
    [...root.children].forEach(child => { child.inert = true; });
    root.appendChild(overlay);
    sheet.focus();
    ['#view', '#topbar', '#tabbar'].forEach(selector => { const element = $(selector); if (element) element.inert = true; });
    return overlay;
  }

  function closeSheet(overlay) {
    document.removeEventListener('keydown', overlay._keydown);
    overlay.remove();
    const top = $('#sheet-root').lastElementChild;
    if (top) top.inert = false;
    if (!top) ['#view', '#topbar', '#tabbar'].forEach(selector => { const element = $(selector); if (element) element.inert = false; });
    if (overlay._returnFocus?.isConnected && (!top || top.contains(overlay._returnFocus))) overlay._returnFocus.focus();
    else top?.querySelector('.sheet')?.focus();
  }

  function confirmDialog(title, message, confirmLabel, danger) {
    return new Promise(resolve => {
      const ov = openSheet(
        '<h2>' + esc(title) + '</h2>' +
        '<p class="muted mt">' + esc(message) + '</p>' +
        '<div class="row mt">' +
        '<button class="btn ghost" data-act="no">' + L('Cancel', '取消') + '</button>' +
        '<button class="btn ' + (danger ? 'danger' : '') + '" data-act="yes">' + esc(confirmLabel || L('Confirm', '確認')) + '</button>' +
        '</div>', { center: true, onDismiss: () => resolve(false) });
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
        '</div>', { center: true, guardChanges: false, onDismiss: () => resolve(null) });
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
        { work: 1, label: L('Worked', '已上班'), sub: L('Normal working day', '正常工作日'), amt: L('normal pay', '正常計薪'), cl: 'zero' },
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
    if (!entry || typeof entry.work !== 'number') return '<span class="badge">' + L('Contract default — not yet recorded', '合約預設 — 尚未記錄') + '</span>';
    if (entry.status === 'pending') return '<span class="badge pending">⏳ ' + L('Awaiting employer approval', '等待僱主批准') + '</span>';
    if (entry.by === 'helper') return '<span class="badge approved">✓ ' + L('Approved', '已批准') + '</span>';
    return '<span class="badge approved">✓ ' + L('Day recorded — not a payment', '已記錄當日情況 — 並非付款') + '</span>';
  }

  function dayBadges(cls) {
    let out = '';
    if (cls.isRest) out += '<span class="badge rest">' + L('Rest day', '休息日') + '</span> ';
    if (cls.holiday) out += '<span class="badge holiday">' + esc(holidayName(cls.holiday.name)) + '</span> ';
    if (!cls.isRest && !cls.holiday) out += '<span class="badge normal">' + L('Working day', '工作日') + '</span> ';
    return out;
  }

  function openDaySheet(ds, initialWork) {
    if (!validRecordDate(ds)) {
      toast(L('This date could not be opened. Return to the calendar and choose a date.', '未能開啟此日期，請返回日曆選擇有效日期。'));
      return;
    }
    if (!E.isEmployedOn(ds, state.config)) { toast(L('Outside employment period', '不在僱傭期內')); return; }
    const cls = E.classifyDay(ds, state.config);
    const entry = state.logs[ds] || {};
    let selected = [0, 0.5, 1].includes(initialWork) ? initialWork : currentWork(ds, cls);
    const opts = workOptions(cls);

    const choicesHtml = opts.map((o, i) =>
      '<button class="choice' + (o.work === selected ? ' selected' : '') + '" data-i="' + i + '">' +
      '<span>' + esc(o.label) + '<span class="sub">' + esc(o.sub) + '</span></span>' +
      '<span class="row"><span class="amt ' + o.cl + '">' + esc(o.amt) + '</span>' +
      '<span class="check">' + (o.work === selected ? '✓' : '') + '</span></span>' +
      '</button>').join('');

    const restToggle = !state.ui.helperMode
      ? '<button class="btn ghost compact mt" id="rest-toggle">' +
        (cls.isRest ? L('Move this rest day', '更改此休息日的日期') : L('Add an agreed rest day', '加入已協議的休息日')) + '</button>' +
        '<p class="muted small" style="margin-top:6px">' + L(
          'Working on a rest day and changing its date are different. Only change the date to reflect the actual agreement; existing work and notes are kept.',
          '休息日上班與更改休息日期並不相同。只按實際協議更改日期；原有工作及備註會保留。'
        ) + '</p>'
      : '';

    const restSubstitute = (state.config.holidays || []).find(day =>
      day.type === 'substituted_rest_day' && day.restFor === ds);
    const holidayArrangement = E.owedAlternativeHolidays(state.config, state.logs)
      .find(item => item.date === ds || item.date === cls.holiday?.altFor);
    const restWorkHint = cls.isRest
      ? '<div class="legal-status mt"><label class="row" style="cursor:pointer;font-size:14px;color:var(--text);font-weight:600"><input id="rest-voluntary" type="checkbox" style="width:auto"' + (entry.restWorkVoluntary === true ? ' checked' : '') + '><span>' + L('Any work on this rest day was voluntary', '此休息日的任何工作均屬自願') + '</span></label>' +
        (restSubstitute ? '<p>' + L('Agreed substituted rest day: ', '雙方同意補回休息日：') + '<b>' + esc(fmtDate(restSubstitute.date)) + '</b></p>' : '') +
        (state.config.restDayWorkArrangement === 'substituted_rest_day' && !state.ui.helperMode
          ? '<button class="btn secondary compact mt" id="add-rest-sub"' + (entry.work > 0 ? '' : ' hidden') + '>' +
            L('Save work and choose the agreed day off', '儲存工作並選擇已協議補假日期') + '</button>' : '') + '</div>'
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
      '<p class="muted small mt">' + L('Choose what happened, then press Save. Nothing is recorded until you save.', '選擇當日情況後按「儲存」；儲存前不會改動記錄。') + '</p>' +
      '<div class="choice-list">' + choicesHtml + '</div>' +
      '<label>' + L('Note (optional)', '備註（選填）') + '</label>' +
      '<input id="day-note" placeholder="' + L('e.g. agency confirmed, doctor visit…', '例如：僱傭公司已確認、覆診……') + '" value="' + esc(entry.note || '') + '">' +
      restWorkHint +
      holidayHint +
      (holidayArrangement && !state.ui.helperMode ? '<button class="btn secondary compact mt" id="day-alt">' +
        L('View / change day-off arrangement', '查看／更改補假安排') + '</button>' : '') +
      restToggle +
      approveBtn +
      '<button class="btn' + (approveBtn ? ' secondary' : '') + ' mt" id="day-save">' + L('Save', '儲存') + '</button>'
    );
    if (initialWork !== undefined && initialWork !== currentWork(ds, cls)) ov._dirty = true;
    const dayAlt = ov.querySelector('#day-alt');
    if (dayAlt) dayAlt.onclick = async () => {
      if (ov._dirty && !(await confirmDialog(L('Leave this unsaved day form?', '離開未儲存的日期表格？'),
        L('The changes in this day form have not been saved. Discard them to view the separate day-off arrangement?', '日期表格的更改尚未儲存。是否捨棄這些更改，查看另一個補假安排表格？'), L('Discard and view arrangement', '捨棄並查看補假')))) return;
      closeSheet(ov); openScheduleAltSheet(holidayArrangement);
    };

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
        if (!(selected > 0)) return;
        if (!ov.querySelector('#rest-voluntary').checked) { toast(L('Confirm whether this rest-day work was voluntary first.', '請先確認此休息日工作是否屬自願。')); return; }
        setWork(ds, cls, selected, ov.querySelector('#day-note').value);
        state.logs[ds].restWorkVoluntary = true;
        saveLogs();
        closeSheet(ov);
        render();
        openRestSubstituteSheet(ds);
      };
    }

    ov.querySelectorAll('.choice').forEach(btn => {
      btn.onclick = () => {
        selected = opts[+btn.dataset.i].work;
        ov.querySelectorAll('.choice').forEach((b, j) => {
          b.classList.toggle('selected', opts[j].work === selected);
          b.querySelector('.check').textContent = opts[j].work === selected ? '✓' : '';
        });
        if (restSubBtn) restSubBtn.hidden = !(selected > 0);
      };
    });

    const rt = ov.querySelector('#rest-toggle');
    if (rt) {
      rt.onclick = () => {
      if (!requireMembership()) return;
        // Keep the day form underneath so an unfinished note/choice survives
        // cancellation of the separate rest-date agreement form.
        const note = ov.querySelector('#day-note').value;
        openRestDayChange(ds, () => {
          closeSheet(ov);
          const updated = openDaySheet(ds, selected);
          if (updated) { updated.querySelector('#day-note').value = note; updated._dirty = true; }
        });
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
    return ov;
  }

  function openRestSubstituteSheet(ds) {
    if (state.ui.helperMode || !validRecordDate(ds)) return;
    const existing = (state.config.holidays || []).find(day => day.type === 'substituted_rest_day' && day.restFor === ds);
    const ov = openSheet('<h2>' + L('Record the agreed day off', '記錄雙方同意的補假日期') + '</h2><p class="mt">' +
      L('Rest day worked: ', '曾上班的休息日：') + esc(fmtDate(ds)) + '</p><p class="muted small">' +
      L('Record the actual agreement, not a suggested date. Work already saved is kept if you cancel; the day off remains to be arranged.',
        '請記錄實際協議，不是系統建議日期。如取消，已儲存的工作記錄會保留，補假仍待安排。') + '</p>' +
      '<label for="rest-sub-date">' + L('Agreed day off', '已協議的補假日期') + '</label><input id="rest-sub-date" type="date" min="' +
      E.addDays(ds, 1) + '" max="' + E.addDays(ds, 30) + '" value="' + esc(existing?.date || '') + '">' +
      '<label class="row mt"><input type="checkbox" id="rest-sub-agreed" style="width:auto"><span>' +
      L('Employer and helper have agreed this date.', '僱主及外傭已同意這個日期。') + '</span></label>' +
      '<p id="rest-sub-error" class="form-error" role="alert" hidden></p><button class="btn mt" id="rest-sub-save">' +
      L('Save agreed day off', '儲存已協議補假') + '</button><button class="btn ghost mt" id="rest-sub-cancel">' + L('Cancel', '取消') + '</button>');
    ov.querySelector('#rest-sub-date').onchange = () => { ov.querySelector('#rest-sub-agreed').checked = false; };
    ov.querySelector('#rest-sub-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#rest-sub-save').onclick = () => {
      if (!requireMembership()) return;
      const date = ov.querySelector('#rest-sub-date').value;
      const fail = message => { const error = ov.querySelector('#rest-sub-error'); error.textContent = message; error.hidden = false; };
      if (!validRecordDate(date) || date <= ds || date > E.addDays(ds, 30)) {
        fail(L('Choose a date from ', '請選擇 ') + fmtDateShort(E.addDays(ds, 1)) + L(' to ', ' 至 ') + fmtDateShort(E.addDays(ds, 30))); return;
      }
      const holidays = (state.config.holidays || []).filter(day => !(day.type === 'substituted_rest_day' && day.restFor === ds));
      if (E.classifyDay(date, { ...state.config, holidays }).type !== 'normal' || !E.isEmployedOn(date, state.config)) {
        fail(L('Choose a normal working day within employment, not another rest day or holiday.', '請選擇僱傭期內的正常工作日，不可與其他休息日或假日重疊。')); return;
      }
      if (!ov.querySelector('#rest-sub-agreed').checked) { fail(L('Confirm the actual agreement before saving.', '請先確認雙方確已同意此日期。')); return; }
      const next = { ...state.config, holidays: holidays.concat({ date, name: 'Agreed substituted rest day — ' + ds,
        type: 'substituted_rest_day', restFor: ds, mutualAgreement: true }).sort((a,b) => a.date.localeCompare(b.date)) };
      try { Store.saveConfig(next); state.config = next; closeSheet(ov); render(); toast(L('Agreed day off saved', '已儲存雙方同意的補假')); }
      catch { fail(L('Could not save. Your existing arrangement is unchanged.', '未能儲存，原有安排未改動。')); }
    };
  }

  function openRestDayChange(ds, onSaved) {
    if (state.ui.helperMode || !validRecordDate(ds)) return;
    const moving = E.classifyDay(ds, state.config).isRest;
    const ov = openSheet('<h2>' + (moving ? L('Move the agreed rest day', '更改已協議休息日') : L('Add an agreed rest day', '加入已協議休息日')) +
      '</h2><p class="mt">' + esc(fmtDate(ds)) + '</p><p>' + (moving
        ? L('The original day becomes a working day. Existing work and notes are kept on their original dates; the pay classification may change.', '原日期會改為工作日。實際工作及備註會保留在原日期，計薪分類可能改變。')
        : L('This adds a rest day without cancelling another one. Existing work and notes are kept.', '這會增加一個休息日，不會取消其他休息日；現有工作及備註會保留。')) + '</p>' +
      (moving ? '<label for="rest-change-date">' + L('New agreed rest date', '新協議休息日期') + '</label><input id="rest-change-date" type="date">' : '') +
      '<label class="row mt"><input id="rest-change-agreed" type="checkbox" style="width:auto"><span>' + L('This reflects the actual agreed arrangement.', '這符合雙方實際協議的安排。') + '</span></label>' +
      '<p id="rest-change-error" class="form-error" role="alert" hidden></p><button class="btn mt" id="rest-change-save">' + L('Confirm change', '確認更改') + '</button>' +
      '<button class="btn ghost mt" id="rest-change-cancel">' + L('Cancel', '取消') + '</button>');
    ov.querySelector('#rest-change-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#rest-change-save').onclick = () => {
      if (!requireMembership()) return;
      const date = moving ? ov.querySelector('#rest-change-date').value : ds;
      const fail = message => { const error = ov.querySelector('#rest-change-error'); error.textContent = message; error.hidden = false; };
      if (!validRecordDate(date) || !E.isEmployedOn(date, state.config) || (moving && date === ds)) {
        fail(L('Choose a different valid date within this employment.', '請選擇僱傭期內另一個有效日期。')); return;
      }
      if (E.classifyDay(date, state.config).isRest) { fail(L('This is already a rest day. Choose another date.', '此日期已是休息日，請選擇另一日期。')); return; }
      if (!ov.querySelector('#rest-change-agreed').checked) { fail(L('Confirm the actual agreement.', '請確認雙方的實際協議。')); return; }
      const restDayOverrides = { ...(state.config.restDayOverrides || {}), [date]: true };
      if (moving) restDayOverrides[ds] = false;
      const next = { ...state.config, restDayOverrides };
      try { Store.saveConfig(next); state.config = next; closeSheet(ov); render(); onSaved?.(); toast(L('Rest dates changed; work and notes retained. Review the month’s checks.', '已更改休息日期並保留工作及備註，請核對本月檢查清單。')); }
      catch { fail(L('Could not save. Existing rest dates are unchanged.', '未能儲存，原有休息日期未改動。')); }
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

  function validRecordDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(date + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }

  // Confirmed statements are rendered from their accepted items, never by
  // rerunning today's engine/configuration against an older total.
  function confirmedItems(snapshot) {
    return (snapshot.items || []).filter(item => item.status === 'accepted').map(item => ({
      ...item, signedAmount: item.class === 'lawful_deduction' ? -Number(item.amount) : Number(item.amount)
    }));
  }

  function confirmedItemLabel(item) {
    if (item.id === 'contract-wage') return L('Contract wage', '合約基本薪金');
    if (item.id === 'food-allowance') return L('Food allowance', '膳食津貼');
    if (item.sourceDate) return fmtDateShort(item.sourceDate) + ' · ' + L('Agreed additional payment', '已協議額外款項');
    return item.label || L('Recorded item', '已記錄項目');
  }

  function confirmedMoneyHtml(snapshot) {
    return confirmedItems(snapshot).map(item => '<div class="stmt-line"><span class="lbl">' +
      esc(confirmedItemLabel(item)) + '</span><span class="val">' + money(item.signedAmount) + '</span></div>').join('');
  }

  function confirmedStatementText(snapshot, paid) {
    const lines = [L('Confirmed salary statement — ', '已確認薪金結算 — ') + snapshot.inputs.monthKey];
    if (snapshot.inputs.contract.helperName) lines.push(L('Helper: ', '外傭：') + snapshot.inputs.contract.helperName);
    lines.push(L('Statement reference: ', '結算編號：') + snapshot.statementId);
    lines.push(L('Confirmed at: ', '確認時間：') + snapshot.acceptedAt);
    confirmedItems(snapshot).forEach(item => lines.push(confirmedItemLabel(item) + ': ' + money(item.signedAmount)));
    lines.push(L('CONFIRMED TOTAL: ', '已確認總額：') + money(snapshot.totals.finalized.total));
    if (paid) lines.push(L('Recorded payments for this month: ', '本月已記錄付款：') + money(paid),
      L('Difference from this version: ', '與此版本總額的差額：') + money(snapshot.totals.finalized.total - paid));
    if (snapshot.supersedesStatementId) lines.push(L('Replaces statement: ', '修訂自結算：') + snapshot.supersedesStatementId);
    if (snapshot.inputs.revisionReason) lines.push(L('Reason: ', '修訂原因：') + snapshot.inputs.revisionReason);
    lines.push(L('A payment record does not transfer money. Receipt acknowledgement is separate.', '記錄付款不會轉帳；外傭確認收款另行記錄。'));
    return lines.join('\n');
  }

  function statementHasChanges(snapshot, stmt, profile = state) {
    const old = { ...snapshot.inputs };
    delete old.revisionReason;
    return Legal.checksum(old) !== Legal.checksum(statementInputs(stmt, profile)) ||
      snapshot.modelVersion !== Legal.MODEL_VERSION || snapshot.legalSourceVersion !== Legal.LEGAL_SOURCE_VERSION ||
      snapshot.holidayCalendarVersion !== Compliance.HOLIDAY_CALENDAR_VERSION;
  }

  function calculationIssueAction(issue) {
    const record = issue.code.match(/^holiday_record_(\d+)_/);
    if (record) return { type: 'holiday', index: +record[1] };
    const fields = { contract_type: '#st-contract-type', contract_signed_on: '#st-signed', contract_start: '#st-start',
      contract_end: '#st-contract-end', below_maw: '#st-confirm-terms', below_food_allowance: '#st-confirm-terms', food_term: '#st-confirm-terms',
      rest_day_pay: '#st-rest-pay', rest_day_work_term: '#st-rest-work', first_three_months: '#st-early-holiday',
      winter_choice: '#st-winter', effective_terms: '#st-confirm-terms', active_wage_period: '#st-confirm-terms', pay_history_missing: '#st-confirm-terms' };
    const external = ['partial_month', 'absence_calculation', 'unpaid_early_holiday', 'unpaid_rest_day', 'rate_not_audited', 'intra_month_pay_change', 'variable_wage_average'];
    if (external.includes(issue.code) || /^holiday_calendar_(?!2026$|2027$)/.test(issue.code)) return { type: 'external' };
    if (issue.code.startsWith('rest_work_amount_')) return { type: 'field', selector: '#st-rest-payment' };
    if (fields[issue.code]) return { type: 'field', selector: fields[issue.code] };
    if (issue.code.startsWith('holiday_calendar_')) return { type: 'field', selector: '#st-hol-review' };
    const date = issue.code.match(/\d{4}-\d{2}-\d{2}$/)?.[0];
    if (date) return { type: 'date', date };
    return { type: 'view', view: issue.section === 'salary' ? 'salary' : issue.section || 'settings' };
  }

  function calculationChecklistHtml(assessment) {
    return '<div class="legal-status blocked mt"><b>' + L('Before confirming: ', '確認結算前：') + assessment.blockers.length +
      L(' items to review', '項需要處理') + '</b><p>' + L('Missing details can be corrected here. Unsupported calculations need a separate check; changing unrelated settings will not unlock them.',
        '欠缺資料可在此補充；未支援的計算須另行核對，修改其他設定不會解除限制。') + '</p><ul class="issue-list">' +
      assessment.blockers.map((issue, index) => {
        const action = calculationIssueAction(issue);
        return '<li><p>' + esc(isZh() ? issue.zh : issue.en) + '</p>' +
          (action.type === 'external' ? '<a class="btn ghost compact" href="' + Compliance.OFFICIAL_CALCULATOR + '" target="_blank" rel="noopener">' +
            L('Open official calculator', '開啟官方計算機') + '</a>' : '<button class="btn ghost compact" data-resolve-issue="' + index + '">' +
            L('Go to this item', '前往處理此項') + '</button>') + '</li>';
      }).join('') + '</ul><p class="small mt">' + L('You may still record work and keep a factual record of a payment calculated elsewhere. It will not be labelled as a HelperPay-confirmed calculation.',
        '你仍可記錄工作，以及保存經其他方法核算後的實際付款；不會標示為 HelperPay 已確認計算。') + '</p></div>';
  }

  function bindCalculationChecklist(container, assessment, overlay) {
    container.querySelectorAll('[data-resolve-issue]').forEach(button => button.onclick = () => {
      const issue = assessment.blockers[Number(button.dataset.resolveIssue)];
      const action = calculationIssueAction(issue);
      if (overlay) closeSheet(overlay);
      if (action.type === 'holiday') { openHolidayRecordReview(action.index); }
      else if (action.type === 'field') {
        state.ui.view = 'settings'; saveUi(); render();
        const field = $(action.selector);
        if (field) {
          for (let ancestor = field.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === 'DETAILS') ancestor.open = true;
          field.scrollIntoView({ block: 'center' }); field.focus({ preventScroll: true });
        }
      } else if (action.type === 'date') {
        state.ui.view = 'calendar'; state.calY = +action.date.slice(0, 4); state.calM = +action.date.slice(5, 7);
        saveUi(); render();
        const owed = E.owedAlternativeHolidays(state.config, state.logs).find(item => item.date === action.date);
        if (owed && (issue.code.startsWith('alternative_holiday_') || issue.code.startsWith('holiday_arrangement_'))) openScheduleAltSheet(owed);
        else openDaySheet(action.date);
      } else {
        state.ui.view = action.view; saveUi(); render();
      }
    });
  }

  function openCalculationChecklist(assessment) {
    const ov = openSheet('<h2>' + L('Review calculation checks', '結算檢查清單') + '</h2>' + calculationChecklistHtml(assessment) +
      '<button class="btn ghost mt" id="checklist-close">' + L('Close', '關閉') + '</button>');
    bindCalculationChecklist(ov, assessment, ov);
    ov.querySelector('#checklist-close').onclick = () => closeSheet(ov);
  }

  function statementInputs(stmt, profile = state) {
    const { config, logs, adjustments } = profile;
    const logCopy = {};
    Object.keys(logs).filter(date => date >= E.addDays(stmt.periodStart, -6) && date <= stmt.periodEnd)
      .forEach(date => { logCopy[date] = logs[date]; });
    return {
      monthKey: stmt.key,
      recordSchemaVersion: 2,
      periodStart: stmt.periodStart,
      periodEnd: stmt.periodEnd,
      contract: {
        helperName: config.helperName || '',
        employerName: config.employerName || '',
        contractType: config.contractType,
        contractSignedOn: config.contractSignedOn,
        startDate: config.startDate,
        contractEndDate: config.contractEndDate,
        employmentEndDate: config.endDate || null,
        monthlyWage: stmt.monthlyWage ?? config.monthlyWage,
        foodMode: stmt.payTerms?.foodMode ?? config.foodMode,
        foodAllowance: stmt.payTerms?.foodAllowance ?? config.foodAllowance,
        restDayWeekday: config.restDayWeekday,
        restDayPayTerm: config.restDayPayTerm,
        restDayWorkArrangement: config.restDayWorkArrangement,
        restDayWorkPayment: config.restDayWorkPayment || 0,
        firstThreeMonthHolidayPayTerm: config.firstThreeMonthHolidayPayTerm,
        winterHolidayChoice: config.winterHolidayChoice,
        holidayWorkBonusAmount: config.holidayWorkBonusAmount || 0,
        restDayOverrides: config.restDayOverrides || {},
        wagePeriods: config.wagePeriods || [],
        foodTerms: config.foodTerms || []
      },
      holidays: (config.holidays || []).filter(day =>
        (day.date >= stmt.periodStart && day.date <= stmt.periodEnd) ||
        (day.altFor >= stmt.periodStart && day.altFor <= stmt.periodEnd) ||
        (day.collisionFor >= stmt.periodStart && day.collisionFor <= stmt.periodEnd) ||
        (day.restFor >= stmt.periodStart && day.restFor <= stmt.periodEnd)),
      logs: logCopy,
      adjustments: adjustments[stmt.key] || []
    };
  }

  function payrollReviewStatus(stmt, profile = state, asOf = E.todayStr()) {
    if (!stmt || !validRecordDate(asOf)) return { complete: false, state: 'unreviewed' };
    const payments = profile.payments.filter(p => p.monthKey === stmt.key);
    const validPayments = payments.every(p => Number.isFinite(p.amount) && p.amount > 0 &&
      validRecordDate(p.date) && ['paid', 'approved'].includes(p.status));
    const facts = payments.map(p => ({ id: p.id, amount: p.amount, date: p.date,
      recorded: ['paid', 'approved'].includes(p.status), method: p.method, statementId: p.statementId || null }));
    const paid = E.round2(payments.filter(p => validRecordDate(p.date) && p.date <= asOf && Number.isFinite(p.amount))
      .reduce((sum, p) => sum + p.amount, 0));
    const snapshots = profile.statements.filter(s => s.inputs?.monthKey === stmt.key);
    const latest = snapshots.at(-1);
    const inputChecksum = Legal.checksum({ inputs: statementInputs(stmt, profile), payments: facts,
      statementId: latest?.statementId || null, model: Legal.MODEL_VERSION, legalSource: Legal.LEGAL_SOURCE_VERSION,
      calendar: Compliance.HOLIDAY_CALENDAR_VERSION });
    const pending = Object.entries(profile.logs).some(([day, log]) => day >= stmt.periodStart && day <= stmt.periodEnd && log.status === 'pending');
    const base = { complete: false, state: 'unreviewed', paid, inputChecksum, validPayments, pending, periodEnd: stmt.periodEnd };
    if (stmt.periodEnd > asOf) return { ...base, state: 'period_open' };
    if (!validPayments || pending) return { ...base, state: pending ? 'pending' : 'payment_check' };
    const records = (profile.config.monthlyReviewRecords || []).filter(r => r.monthKey === stmt.key);
    const review = records.at(-1);
    if (review?.scope === 'wages_only' && review.inputChecksum === inputChecksum &&
        Number.isFinite(review.expectedAmount) && review.expectedAmount >= 0 &&
        review.basis?.trim() && review.confirmed === true &&
        validRecordDate(review.reviewedOn) && review.reviewedOn <= asOf && paid >= review.expectedAmount) {
      return { ...base, complete: true, state: 'external_review', review };
    }
    if (latest && !stmt.historicalOnly && !statementHasChanges(latest, stmt, profile)) {
      const total = latest.totals?.finalized?.total;
      let intact = false;
      try { intact = !!latest.acceptedAt && Array.isArray(latest.items) && latest.items.every(item => ['accepted', 'rejected'].includes(item.status)) &&
        latest.inputChecksum === Legal.checksum(latest.inputs) &&
        Legal.checksum(latest.totals) === Legal.checksum(Legal.calculateStatementTotals(latest.items)); } catch { /* Not a verified completed record. */ }
      if (intact && Number.isFinite(total) && total >= 0 && paid >= total) return { ...base, complete: true, state: 'confirmed_paid' };
      return { ...base, state: intact ? 'unpaid' : 'statement_check' };
    }
    return { ...base, state: latest || review ? 'changed' : 'unreviewed' };
  }

  function openMonthlyReviewSheet(stmt) {
    if (state.ui.helperMode) return;
    const profileAtOpen = Store.profiles.active();
    const before = payrollReviewStatus(stmt);
    const reviewsAtOpen = Legal.checksum(state.config.monthlyReviewRecords || []);
    const ov = openSheet('<h2>' + L('Record an external wage review', '記錄外部工資核對') + '</h2><p>' + esc(stmt.key) + '</p>' +
      '<p>' + L('Use this only after independently checking this month’s full wage amount and actual payments. It completes the wage reminder only, not a HelperPay calculation, helper receipt acknowledgement or review of final-contract entitlements.',
        '只可在另行核對本月完整工資及實際付款後使用。此記錄只完成工資待辦，不代表 HelperPay 驗證計算、外傭確認收款或終止僱傭權益已核對。') + '</p>' +
      '<p>' + L('Recorded payments dated on or before today: ', '截至今天已記錄的付款：') + money(before.paid) + '</p>' +
      '<label for="month-review-amount">' + L('Full wage amount checked externally (HK$)', '另行核對的本月完整應付工資（港元）') + '</label>' +
      '<input id="month-review-amount" type="number" min="0" step="0.01" inputmode="decimal">' +
      '<label for="month-review-basis">' + L('Calculation source / review reference (required)', '計算依據／核對參考（必填）') + '</label><textarea id="month-review-basis" maxlength="1000"></textarea>' +
      '<label class="row review-confirm"><input id="month-review-confirm" type="checkbox"><span>' + L('I checked the complete wage amount and confirm it has been paid. Any other entitlements require separate review.',
        '我已核對完整工資，並確認已付清；其他權益須另行核對。') + '</span></label>' +
      '<p id="month-review-error" role="alert" class="form-error" hidden></p>' +
      '<button class="btn mt" id="month-review-save">' + L('Save review record', '儲存核對記錄') + '</button>' +
      '<button class="btn ghost mt" id="month-review-cancel">' + L('Cancel', '取消') + '</button>');
    ov.querySelector('#month-review-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#month-review-save').onclick = () => {
      if (!requireMembership()) return;
      const fail = message => { const box = ov.querySelector('#month-review-error'); box.hidden = false; box.textContent = message; };
      const current = payrollReviewStatus(stmt);
      if (state.ui.helperMode || Store.profiles.active() !== profileAtOpen || current.inputChecksum !== before.inputChecksum ||
          Legal.checksum(state.config.monthlyReviewRecords || []) !== reviewsAtOpen) {
        fail(L('Records changed. Cancel and review the current month again.', '記錄已改變，請取消並重新核對目前月份。')); return;
      }
      const raw = ov.querySelector('#month-review-amount').value.trim(), expectedAmount = Number(raw);
      const basis = ov.querySelector('#month-review-basis').value.trim();
      if (current.state === 'period_open') { fail(L('Wait until this wage period ends before completing its review.', '請待此工資期完結後才完成核對。')); return; }
      if (!current.validPayments || current.pending) { fail(L('Review invalid payment details or pending work entries first.', '請先核對無效的付款資料或待批准工作記錄。')); return; }
      if (!raw || !Number.isFinite(expectedAmount) || expectedAmount < 0 || E.round2(expectedAmount) !== expectedAmount) {
        fail(L('Enter the complete wage amount with no more than two decimal places.', '請填寫完整工資金額，最多兩位小數。')); return;
      }
      if (current.paid < expectedAmount) { fail(L('Recorded payments do not yet cover this full wage amount. Record the remaining payment first.', '已記錄付款尚不足以支付此完整工資，請先記錄餘下實際付款。')); return; }
      if (!basis || !ov.querySelector('#month-review-confirm').checked) { fail(L('Provide the review reference and confirm the actual completed check.', '請提供核對依據，並確認已實際完成核對。')); return; }
      const record = { id: uid(), monthKey: stmt.key, scope: 'wages_only', expectedAmount, basis, confirmed: true,
        inputChecksum: current.inputChecksum, reviewedOn: E.todayStr(), recordedAt: new Date().toISOString() };
      const next = { ...state.config, monthlyReviewRecords: [...(state.config.monthlyReviewRecords || []), record] };
      try { Store.saveConfig(next); state.config = next; closeSheet(ov); render(); toast(L('External wage review saved; no calculation or payment was changed.', '已保存外部工資核對，未改動計算或付款。')); }
      catch { fail(L('Review was not saved. Keep this form open and retry.', '核對未能儲存，請保留表格重試。')); }
    };
  }

  function freezeStatement(stmt, revisionReason) {
    const inputs = statementInputs(stmt);
    const previous = latestStatement(stmt.key);
    if (previous && !String(revisionReason || '').trim()) throw new Error('A revision reason is required');
    if (previous) inputs.revisionReason = revisionReason.trim();
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
    // Persist first: a failed write must not leave a phantom confirmed version.
    const next = state.statements.concat(snapshot);
    Store.saveStatements(next);
    state.statements = next;
    return snapshot;
  }

  function openStatementReview(stmt) {
      if (!requireMembership()) return;
    const assessment = Compliance.assessMonth({ statement: stmt, config: state.config,
      logs: state.logs, adjustments: monthAdjustments(stmt.key), engine: E });
    if (!assessment.ready) { toast(L('Resolve the checklist before confirming this version.', '請先完成檢查清單，才可確認此版本。')); return; }
    const previous = latestStatement(stmt.key);
    const inputsAtOpen = Legal.checksum(statementInputs(stmt));
    const items = Compliance.acceptedMoneyItems(stmt, state.config, monthAdjustments(stmt.key));
    const preview = { items, totals: Legal.calculateStatementTotals(items) };
    const total = preview.totals.finalized.total;
    const ov = openSheet('<h2>' + L('Review this month’s statement', '預覽本月結算') + '</h2>' +
      '<p class="muted mt">' + esc(monthYear(stmt.year, stmt.month)) + '</p>' + confirmedMoneyHtml(preview) +
      '<div class="stmt-total"><span>' + L('Total to confirm', '待確認總額') + '</span><span>' + money(total) + '</span></div>' +
      (previous ? '<p class="mt">' + L('Previously confirmed: ', '上個已確認版本：') + money(previous.totals.finalized.total) +
        '<br>' + L('Revision difference: ', '本次修訂差額：') + money(total - previous.totals.finalized.total) +
        '</p><label for="statement-reason">' + L('Reason for revision (required)', '修訂原因（必填）') +
        '</label><input id="statement-reason" maxlength="500" required>' : '') +
      '<p class="mt">' + L('Confirming saves a permanent version. Later corrections create a revision; existing statements and payment records stay unchanged. No money is transferred.',
        '確認後會保存此結算版本。日後更正須建立修訂版，原結算及付款記錄會保留。此操作不會轉帳。') + '</p>' +
      '<p id="statement-error" role="alert" class="form-error" hidden></p>' +
      '<button class="btn mt" id="statement-confirm">' + L('Confirm statement and enter payment', '確認結算並填寫付款') + '</button>' +
      '<button class="btn ghost mt" id="statement-cancel">' + L('Cancel — keep as draft', '取消 — 保留草稿') + '</button>');
    ov.querySelector('#statement-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#statement-confirm').onclick = () => {
      if (!requireMembership()) return;
      const error = ov.querySelector('#statement-error');
      const fail = message => { error.textContent = message; error.hidden = false; };
      if (state.ui.helperMode) { fail(L('Only the employer can confirm a statement.', '只可由僱主確認結算。')); return; }
      const fresh = E.computeMonth(stmt.year, stmt.month, state.config, state.logs);
      const check = fresh && Compliance.assessMonth({ statement: fresh, config: state.config, logs: state.logs,
        adjustments: monthAdjustments(stmt.key), engine: E });
      if (!check || !check.ready || Legal.checksum(statementInputs(fresh)) !== inputsAtOpen ||
          (latestStatement(stmt.key)?.statementId || null) !== (previous?.statementId || null)) {
        fail(L('Records changed. Cancel and review the latest statement before confirming.', '記錄已改變，請取消並重新預覽最新結算。')); return;
      }
      const reason = ov.querySelector('#statement-reason')?.value.trim() || '';
      if (previous && !reason) { fail(L('Enter the reason for this revision.', '請填寫本次修訂原因。')); ov.querySelector('#statement-reason').focus(); return; }
      try {
        const snapshot = freezeStatement(fresh, reason);
        closeSheet(ov); render(); openPaymentSheet(fresh, snapshot);
      } catch { fail(L('The statement was not saved. Keep this form open and retry.', '結算未能儲存，請保留此表格並重試。')); }
    };
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
    const added = [];
    try {
      for (const file of Array.from(fileList || [])) {
        if (!file.type.startsWith('image/')) throw new Error('Unsupported attachment');
        const blob = await resizeImage(file, 1400);
        if (!blob) throw new Error('Image could not be prepared');
        const id = uid();
        await Store.files.put(id, blob, { paymentId: payment.id });
        added.push(id);
      }
      const next = { ...payment, fileIds: (payment.fileIds || []).concat(added) };
      if (state.payments.some(item => item.id === payment.id)) {
        const rows = state.payments.map(item => item.id === payment.id ? next : item);
        Store.savePayments(rows);
        state.payments = rows;
      }
      payment.fileIds = next.fileIds;
    } catch (error) {
      await Promise.allSettled(added.map(id => Store.files.remove(id)));
      throw error;
    }
  }

  function openPaymentSheet(stmt, snapshot) {
      if (!requireMembership()) return;
    if (state.ui.helperMode) return;
    const profileAtOpen = Store.profiles.active();
    const paymentId = uid();
    let saving = false;
    const frozenTotal = snapshot ? snapshot.totals.finalized.total : null;
    const balance = snapshot ? frozenTotal - monthPaid(stmt.key) : null;
    const ov = openSheet(
      '<h2>' + L('Record payment — ', '記錄付款 — ') + monthYear(stmt.year, stmt.month) + '</h2>' +
      '<label>' + L('Amount (HK$)', '金額（港幣）') + '</label>' +
      '<input id="pay-amount" type="number" step="0.01" inputmode="decimal" value="' + (snapshot ? E.round2(Math.max(balance, 0)) : '') + '">' +
      (!snapshot ? '<div class="banner mt">' + L('Externally calculated payment only. HelperPay has not verified the calculation or entitlements. Enter the actual amount paid, not the reference estimate.',
        '只記錄另行核算的付款。HelperPay 未驗證此計算或權益。請輸入實際已付金額，不要直接採用參考估算。') + '</div><label for="pay-basis">' +
        L('External calculation reference / note (required)', '外部核算依據／備註（必填）') + '</label><input id="pay-basis" required maxlength="500">' : '') +
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
      '<p class="muted small mt">' + L('Record a payment you have already made; this does not transfer money. Cancelling this form does not record a payment.', '請記錄你已完成的付款；這不會轉帳。取消此表格不會記錄付款。') +
      (snapshot ? ' ' + L('The explicitly confirmed statement remains available for revision.', '你已明確確認的結算仍會保留，並可建立修訂版。') : '') + '</p>' +
      '<p id="pay-error" class="form-error" role="alert" hidden></p>' +
      '<button class="btn mt" id="pay-save">' + L('Save payment', '儲存付款') + '</button>' +
      '<button class="btn ghost mt" id="pay-cancel">' + L('Cancel', '取消') + '</button>'
    );
    ov.querySelector('#pay-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#pay-save').onclick = async () => {
      if (!requireMembership()) return;
      if (saving || state.payments.some(item => item.id === paymentId)) return;
      const errorBox = ov.querySelector('#pay-error');
      const fail = message => { errorBox.textContent = message; errorBox.hidden = false; };
      const amount = parseFloat(ov.querySelector('#pay-amount').value);
      if (!(amount > 0) || !Number.isFinite(amount)) { fail(L('Enter a payment amount greater than zero.', '請輸入大於零的實際付款金額。')); return; }
      const paymentDate = ov.querySelector('#pay-date').value;
      if (!validRecordDate(paymentDate)) { fail(L('Enter a valid payment date.', '請輸入有效付款日期。')); return; }
      const externalBasis = ov.querySelector('#pay-basis')?.value.trim();
      if (!snapshot && !externalBasis) { fail(L('Describe how this amount was checked outside HelperPay.', '請填寫在 HelperPay 以外核對此金額的依據。')); return; }
      const payment = {
        id: paymentId,
        monthKey: stmt.key,
        amount: E.round2(amount),
        date: paymentDate,
        method: ov.querySelector('#pay-method').value,
        note: ov.querySelector('#pay-note').value.trim(),
        fileIds: [],
        status: 'paid',
        approval: null,
        ...(snapshot ? { statementId: snapshot.statementId, statementChecksum: snapshot.inputChecksum, modelVersion: snapshot.modelVersion }
          : { calculationBasis: 'external', externalCalculationNote: externalBasis }),
        createdAt: new Date().toISOString()
      };
      saving = true; ov._busy = true; errorBox.hidden = true;
      ov.querySelector('#pay-save').disabled = true;
      ov.querySelector('#pay-cancel').disabled = true;
      ov.querySelector('#pay-save').textContent = L('Saving…', '儲存中……');
      try {
        await attachFiles(payment, ov.querySelector('#pay-files').files);
        if (state.ui.helperMode || Store.profiles.active() !== profileAtOpen ||
            (window.HSBilling && !window.HSBilling.request('record', { helperMode: state.ui.helperMode }))) throw new Error('Recording access changed');
        const rows = state.payments.concat(payment);
        Store.savePayments(rows);
        state.payments = rows;
      } catch {
        await Promise.allSettled(payment.fileIds.map(id => Store.files.remove(id)));
        fail(L('Payment was not saved. Your entries are still here. Check the attachment or available storage, then retry; you may remove the attachment and add it later.',
          '付款尚未儲存，已填內容仍保留。請檢查附件或可用儲存空間後重試；亦可先移除附件，稍後再加入。'));
        return;
      } finally {
        saving = false; ov._busy = false;
        ov.querySelector('#pay-save').disabled = false;
        ov.querySelector('#pay-cancel').disabled = false;
        ov.querySelector('#pay-save').textContent = L('Save payment', '儲存付款');
      }
      HSTrack('payment-recorded'); closeSheet(ov);
      toast(isZh() ? '已記錄付款 — 請' + (state.config.helperName || '外傭') + '確認'
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
      '<input id="adj-label" placeholder="' + L('e.g. Agreed bonus', '例如：已協議花紅') + '">' +
      '<label>' + L('Amount (HK$, positive only)', '金額（港幣，只限正數）') + '</label>' +
      '<input id="adj-amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="100.00">' +
      '<button class="btn mt" id="adj-save">' + L('Add voluntary payment', '加入自願付款') + '</button>'
    );
    ov.querySelector('#adj-save').onclick = () => {
      if (!requireMembership()) return;
      const label = ov.querySelector('#adj-label').value.trim();
      const amount = parseFloat(ov.querySelector('#adj-amount').value);
      if (!label || !(amount > 0) || !Number.isFinite(amount)) { toast(L('Enter a description and positive amount', '請輸入說明及正數金額')); return; }
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
    if (!validRecordDate(owedItem?.date)) return;
    const linkedRows = (state.config.holidays || []).map((row,index)=>({row,index})).filter(item=>item.row.altFor===owedItem.date);
    if (linkedRows.length > 1 || linkedRows.some(item=>!['alternative_holiday','substituted_holiday'].includes(item.row.type))) {
      openHolidayRecordReview(linkedRows[0].index); return;
    }
    const original = Legal.checksum(state.config), profileId = Store.profiles.active();
    const existing = owedItem.scheduled || '';
    const savedNotice = owedItem.noticeAt && Number.isFinite(Date.parse(owedItem.noticeAt))
      ? new Date(Date.parse(owedItem.noticeAt) + 8 * 3600000).toISOString().slice(0, 16) : '';
    const savedStart = owedItem.workStartsAt && Number.isFinite(Date.parse(owedItem.workStartsAt))
      ? new Date(Date.parse(owedItem.workStartsAt) + 8 * 3600000).toISOString().slice(11, 16) : '';
    const ov = openSheet(
      '<h2>' + (existing ? L('Reschedule day off in lieu', '重新安排補假') : L('Schedule day off in lieu', '安排補假')) + '</h2>' +
      '<p class="muted mt">' + (isZh()
        ? esc(state.config.helperName || '外傭') + '在' + esc(fmtDate(owedItem.date)) + '的<b>' + esc(holidayName(owedItem.name)) + '</b>上班。' +
          '請記錄實際補假安排；額外薪金不能取代法定假日。'
        : esc(state.config.helperName || 'Helper') + ' worked <b>' + esc(owedItem.name) + '</b> on ' + esc(fmtDate(owedItem.date)) + '. ' +
          'Record the actual day-off arrangement; extra pay cannot replace a statutory holiday.') + '</p>' +
      (existing ? '<p class="muted small mt">' + L('Currently scheduled: ', '目前安排：') + '<b>' + esc(fmtDate(existing)) + '</b></p>' : '') +
      '<label>' + L('How was this day off arranged?', '這次補假如何安排？') + '</label><select id="alt-type"><option value="alternative_holiday"' + (owedItem.arrangementType !== 'substituted_holiday' ? ' selected' : '') + '>' + L('Employer arranged an alternative holiday (±60 days)', '僱主安排另定假日（前後60日）') + '</option><option value="substituted_holiday"' + (owedItem.arrangementType === 'substituted_holiday' ? ' selected' : '') + '>' + L('Both agreed a substituted holiday (±30 days)', '雙方同意代替假日（前後30日）') + '</option></select>' +
      '<label>' + L('Day off in lieu', '補假日期') + '</label>' +
      '<input id="alt-date" type="date" value="' + esc(existing) + '"' +
      ' min="' + esc(E.addDays(owedItem.date, -60)) + '" max="' + esc(owedItem.deadline) + '">' +
      '<p id="alt-range" class="muted small" aria-live="polite"></p>' +
      '<label>' + L('Holiday work starts at (Hong Kong time)', '假日工作開始時間（香港時間）') + '</label>' +
      '<input id="alt-work-start" type="time" required value="' + esc(savedStart) + '">' +
      '<p class="muted small">' + esc(fmtDate(owedItem.date)) + ' · ' + L('Use the actual agreed start time, not a guessed time. Old arrangements without this detail need checking; saved statements are unchanged.',
        '請記錄實際約定的開始時間，不應猜填。舊安排若缺少此資料，須補核；已保存的結算不會改寫。') + '</p>' +
      '<label>' + L('When was notice of holiday work actually given? (Hong Kong time)', '何時實際通知外傭在假日工作？（香港時間）') + '</label>' +
      '<input id="alt-notice" type="datetime-local" required value="' + esc(savedNotice) + '">' +
      '<p class="muted small">' + L('Both arrangements require at least 48 hours’ notice of holiday work. This records a notice already given; HelperPay does not send it. Do not invent a notice date to pass the check.', '兩種安排均須提前至少48小時通知假日工作。這裡記錄已實際作出的通知，HelperPay 不會代發通知；不可為通過檢查而補造日期。') + '</p>' +
      '<label class="row" id="alt-agreement-row" style="cursor:pointer;font-size:14px;color:var(--text);font-weight:600"><input id="alt-agreement" type="checkbox" style="width:auto"' + (owedItem.mutualAgreement ? ' checked' : '') + '><span>' + L('Employer and helper mutually agreed this substituted holiday', '僱主與外傭已共同同意此代替假日') + '</span></label>' +
      '<p id="alt-guidance" class="muted small mt"></p>' +
      '<p class="muted small mt"><a href="https://www.labour.gov.hk/eng/faq/cap57f_whole.htm" target="_blank" rel="noopener">' + L('Official holiday guidance', '官方假日指引') + '</a></p>' +
      '<p id="alt-error" class="form-error" role="alert" hidden></p>' +
      '<button class="btn mt" id="alt-save">' + (existing ? L('Save new date', '儲存新日期') : L('Schedule day off', '安排補假')) + '</button>' +
      '<button class="btn ghost mt" id="alt-cancel">' + L('Cancel', '取消') + '</button>' +
      (existing ? '<button class="btn ghost mt" id="alt-remove" style="color:var(--red);border-color:var(--red)">' + L('Remove — mark as not scheduled', '移除 — 標記為尚未安排') + '</button>' : '')
    );

    // the entry being replaced must not block its own date re-validation
    const holidaysSans = () => (state.config.holidays || []).filter((_,index) => index !== linkedRows[0]?.index);
    const updateType = () => {
      const substituted = ov.querySelector('#alt-type').value === 'substituted_holiday';
      const days = substituted ? 30 : 60;
      const field = ov.querySelector('#alt-date');
      field.min = E.addDays(owedItem.date, -days); field.max = E.addDays(owedItem.date, days);
      ov.querySelector('#alt-range').textContent = L('Available range: ', '可選範圍：') + fmtDate(field.min) + L(' to ', ' 至 ') + fmtDate(field.max);
      ov.querySelector('#alt-agreement-row').hidden = !substituted;
      ov.querySelector('#alt-agreement').required = substituted;
      ov.querySelector('#alt-guidance').textContent = substituted
        ? L('This form supports a substituted holiday within 30 days before or after the original statutory holiday. Substitution relative to a separate alternative holiday needs individual review; do not change the original holiday date. Choose a non-rest, non-holiday date within employment.',
          '此表格支援以原法定假日為基準、前後30日內的代替假日。如以另一另定假日為基準，須另行覆核，不應改動原法定假日日期。請選擇僱傭期內非休息日、非假日的日期。')
        : L('Choose a day within 60 days before or after the statutory holiday, within employment and not another rest day or holiday. Holiday pay depends on statutory eligibility and the recorded terms.',
          '請選擇法定假日前後60日內、僱傭期內，且不是其他休息日或假日的日期。假日薪酬按法定資格及已記錄條款處理。');
    };
    ov.querySelector('#alt-type').onchange = () => { ov.querySelector('#alt-agreement').checked = false; updateType(); };
    ov.querySelector('#alt-date').onchange = () => { ov.querySelector('#alt-agreement').checked = false; };
    ov.querySelector('#alt-cancel').onclick = () => closeSheet(ov);
    updateType();

    ov.querySelector('#alt-save').onclick = () => {
      if (!requireMembership()) return;
      const fail = (message, selector) => { const box = ov.querySelector('#alt-error'); box.textContent = message; box.hidden = false;
        const field = ov.querySelector(selector); if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } };
      if (state.ui.helperMode || Store.profiles.active() !== profileId || Legal.checksum(state.config) !== original) {
        fail(L('The helper or settings changed. Close and reopen this arrangement.', '外傭或設定已改變，請關閉後重新打開此安排。'), '#alt-save'); return;
      }
      if (owedItem.alternativeDate && owedItem.alternativeDate !== owedItem.date) {
        fail(L('This saved substitution is relative to another alternative holiday. Keep the original record and seek individual review; this form cannot replace its reference date.',
          '此代替假日以另一另定假日為基準。請保留原記錄並另行覆核；此表格不能更換其基準日期。'), '#alt-type'); return;
      }
      const date = ov.querySelector('#alt-date').value;
      if (!validRecordDate(date)) { fail(L('Choose a valid day off.', '請選擇有效補假日期。'), '#alt-date'); return; }
      const type = ov.querySelector('#alt-type').value;
      const dateField = ov.querySelector('#alt-date');
      if (date === owedItem.date || date < dateField.min || date > dateField.max) {
        fail(L('Choose a different day in the range: ', '請在以下範圍內選擇另一日期：') + fmtDate(dateField.min) + ' – ' + fmtDate(dateField.max), '#alt-date'); return;
      }
      const workStart = ov.querySelector('#alt-work-start').value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(workStart)) {
        fail(L('Enter the actual agreed work start time for this holiday (Hong Kong time).', '請輸入此假日實際約定的工作開始時間（香港時間）。'), '#alt-work-start'); return;
      }
      const workStartsAt = new Date(owedItem.date + 'T' + workStart + ':00+08:00').toISOString();
      const noticeValue = ov.querySelector('#alt-notice').value;
      const noticeTime = noticeValue ? Date.parse(noticeValue + '+08:00') : NaN;
      if (!Number.isFinite(noticeTime) || noticeTime > Date.now()) { fail(L('Enter the actual past notice time in Hong Kong time.', '請輸入已實際作出通知的時間（香港時間，不可填將來時間）。'), '#alt-notice'); return; }
      const noticeAt = new Date(noticeTime).toISOString();
      const agreement = type === 'substituted_holiday' && ov.querySelector('#alt-agreement').checked;
      if (type === 'substituted_holiday' && !agreement) { fail(L('Confirm that both parties actually agreed to this date.', '請確認雙方已實際同意這個日期。'), '#alt-agreement'); return; }
      const arrangementErrors = Legal.validateHolidayArrangement({
        type: type, statutoryDate: owedItem.date, date: date, noticeAt: noticeAt, workStartsAt: workStartsAt,
        mutualAgreement: agreement
      });
      if (arrangementErrors.length) { fail(L(arrangementErrors[0], '通知時間未通過提前48小時的檢查。請核對實際通知；如不足，須另行尋求意見，不可補造通知日期。'), '#alt-notice'); return; }
      const cls = E.classifyDay(date, Object.assign({}, state.config, { holidays: holidaysSans() }));
      if (!E.isEmployedOn(date, state.config) || cls.type !== 'normal') { fail(L(
        'Choose a normal working day within employment, not a rest day or another holiday.',
        '請選擇僱傭期內的正常工作日，不可選休息日或其他假日。'
      ), '#alt-date'); return; }
      const holidays = holidaysSans().concat({
        ...(linkedRows[0]?.row || {}),
        date: date,
        name: 'Day off in lieu — ' + owedItem.name + ' (' + fmtDateShort(owedItem.date) + ')',
        type: type,
        altFor: owedItem.date,
        noticeAt: noticeAt,
        workStartsAt: workStartsAt,
        mutualAgreement: agreement
      });
      holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
      const next = HolidayReview.revision(state.config, { ...state.config, holidays },
        {id:uid(),recordedAt:new Date().toISOString(),reason:L('Saved explicit day-off arrangement','保存明確補假安排')}, 'holiday_arrangement');
      try { Store.saveConfig(next); state.config = next; }
      catch { fail(L('Could not save. The existing arrangement is unchanged; retry when storage is available.', '未能儲存，原有安排未改動；請檢查儲存空間後重試。'), '#alt-save'); return; }
      closeSheet(ov);
      toast(existing
        ? L('Day off moved to ', '補假已改至') + fmtDateShort(date) + ' ✓'
        : L('Day off scheduled — ', '已安排補假 — ') + fmtDateShort(date) + ' ✓');
      render();
    };

    const rm = ov.querySelector('#alt-remove');
    if (rm) rm.onclick = async () => {
      if (state.ui.helperMode || Store.profiles.active() !== profileId || Legal.checksum(state.config) !== original) {
        toast(L('Settings changed; reopen this arrangement.', '設定已改變，請重新打開此安排。')); return;
      }
      if (ov._dirty && !(await confirmDialog(L('Review original arrangement?', '核對原安排？'),L('Discard unsaved changes and review the original record for correction or archiving?', '捨棄未保存更改，並核對原記錄以作更正或封存？'),L('Continue','繼續')))) return;
      closeSheet(ov); if (linkedRows[0]) openHolidayRecordReview(linkedRows[0].index);
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
        ? L('These days off are arranged, not yet confirmed as taken. Record what happened on the date. Holiday pay follows eligibility and the recorded terms.', '這些補假已安排，但尚未確認已放假。請在該日記錄實際情況；薪酬按資格及已記錄條款處理。')
        : L('An arranged day is not proof that it was taken. Record what happened on that date; use the calendar to review past arrangements.', '已安排不等於已放假。請在該日記錄實際情況；過往安排可從日曆查看及更改。');
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
    enhanceFormLabels($('#view'));
    $$('[data-language]').forEach(button => {
      button.onclick = () => {
        const language = I18n.normalizeLanguage(button.dataset.language);
        if (language === state.ui.language) return;
        state.ui.language = language;
        Language.updateUrl(language);
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
      '<p class="eyebrow">' + (adding ? L('New profile', '新增檔案') : L('Contract details', '合約資料')) + '</p>' +
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
      '<p id="setup-section-status" class="muted small" role="status"></p>' +
      '<fieldset class="setup-section" data-setup-section="1"><legend>' + L('1. Helper and contract dates', '1. 外傭及合約日期') + '</legend>' +
      '<p class="muted small">' + L('Fields are required unless marked optional.', '除註明選填外，所有欄位均須填寫。') + '</p>' +
      '<label>' + L('Helper\'s name (optional)', '外傭姓名（選填）') + '</label><input id="su-helper" autocomplete="name" placeholder="' + L('e.g. Maria', '例如：Maria') + '">' +
      '<label>' + L('ID 407 contract signed on', 'ID 407 合約簽署日期') + '</label><input id="su-signed" type="date" required>' +
      '<label>' + L('First day of work', '首個工作日') + '</label><input id="su-start" type="date" required value="' + today + '">' +
      '<p class="muted small mt">' + L('The first month may need a separate calculation if employment starts mid-month. Confirm the actual date; do not change it to bypass a calculation limit.', '如月中入職，首月須另行核算。請填寫真實日期，不應為跳過計算限制而改日期。') + '</p></fieldset>' +
      '<fieldset class="setup-section" data-setup-section="2" hidden><legend>' + L('2. Wage and food', '2. 工資及膳食') + '</legend>' +
      '<label>' + L('Monthly wage (HK$)', '月薪（港幣）') + '</label><input id="su-wage" type="number" inputmode="decimal" required min="0.01" step="0.01" value="5100">' +
      '<p class="muted small" style="margin-top:4px">' + L(
        'The minimum is linked to the contract signing date. Check the applicable official rate before confirming.',
        '最低金額按合約簽署日期而定，確認前請核對適用的官方金額。'
      ) + '</p>' +
      '<label>' + L('Food arrangement', '膳食安排') + '</label><select id="su-food-mode"><option value="">' + L('Choose…', '請選擇……') + '</option>' +
      '<option value="provided">' + L('Food provided free', '免費提供膳食') + '</option><option value="allowance">' + L('Monthly food allowance', '每月膳食津貼') + '</option></select>' +
      '<label>' + L('Food allowance (HK$/month; only if selected above)', '膳食津貼（港幣／月；只在上方選擇津貼時填寫）') + '</label><input id="su-food" type="number" inputmode="decimal" value="1236">' +
      '</fieldset><fieldset class="setup-section" data-setup-section="3" hidden><legend>' + L('3. Rest days and holidays', '3. 休息日及假日') + '</legend>' +
      '<p class="muted small">' + L('Use the actual agreed terms. These choices do not create an agreement or replace required time off.', '請按實際協議填寫。這些選項不會代訂協議，亦不會取代法定休假。') + '</p>' +
      '<label>' + L('Weekly rest day', '每周休息日') + '</label><select id="su-rest">' +
      weekdays().map((w, i) => '<option value="' + i + '"' + (i === 0 ? ' selected' : '') + '>' + w + '</option>').join('') +
      '</select>' +
      '<label>' + L('Are weekly rest days paid?', '每周休息日是否有薪？') + '</label><select id="su-rest-pay"><option value="">' + L('Choose the agreed term…', '請選擇已協議條款……') + '</option><option value="paid">' + L('Paid', '有薪') + '</option><option value="unpaid">' + L('Unpaid', '無薪') + '</option></select>' +
      '<label>' + L('If a rest day is worked', '如在休息日工作') + '</label><select id="su-rest-work"><option value="">' + L('Choose the agreed arrangement…', '請選擇已協議安排……') + '</option><option value="substituted_rest_day">' + L('Agreed substituted rest day', '雙方同意補回休息日') + '</option><option value="agreed_payment">' + L('Agreed cash amount', '雙方同意現金金額') + '</option></select>' +
      '<label for="su-rest-payment">' + L('Agreed amount per full rest day worked (HK$)', '每個完整休息日工作的協議金額（港幣）') + '</label><input id="su-rest-payment" type="number" inputmode="decimal" min="0.01" step="0.01">' +
      '<label>' + L('Statutory-holiday pay during first 3 months', '首3個月法定假日薪酬') + '</label><select id="su-early-holiday"><option value="">' + L('Choose the contractual term…', '請選擇合約條款……') + '</option><option value="paid">' + L('Paid by agreement', '按協議有薪') + '</option><option value="unpaid">' + L('Unpaid', '無薪') + '</option></select>' +
      '<label>' + L('Contractual winter statutory holiday', '合約訂明的冬季法定假日') + '</label><select id="su-winter"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="winter_solstice">' + L('Winter Solstice', '冬節') + '</option><option value="christmas">' + L('Christmas Day', '聖誕節') + '</option></select>' +
      '</fieldset><p id="setup-error" class="form-error" role="alert" hidden></p>' +
      '<p class="muted small mt">' + L('Mid-month starts, absence deductions and other unsupported entitlements need a separate calculation. You can still record work and externally calculated payments. The built-in audited holiday calendar covers 2026–2027.',
        '月中入職、缺勤扣款及其他未支援權益須另行核算；仍可記錄工作及另行核算後的付款。內置已審核假日日曆涵蓋2026–2027年。') + '</p>' +
      '<button class="btn mt" id="su-next">' + L('Continue', '繼續') + '</button>' +
      '<button class="btn mt" id="su-create" hidden>' + (adding ? L('Add helper', '加入外傭') : L('Finish setup', '完成設定')) + '</button>' +
      '<button class="btn ghost mt" id="su-back" hidden>' + L('Previous section', '上一部分') + '</button>' +
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
        'Keep the helper’s Standard Employment Contract (ID 407) nearby. Some agreed wage and holiday terms need checking; switching language or going back keeps your entries.',
        '請把外傭的標準僱傭合約（ID 407）放在手邊，並核對已協議的薪酬及假日安排。切換語言或返回上一步會保留已填內容。'
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
    if (cancel) cancel.onclick = async () => {
      if (Object.keys(state.setupDraft).length && !(await confirmDialog(L('Discard setup?', '捨棄設定？'),
        L('The details entered for this new helper have not been saved.', '這位新外傭的已填資料尚未儲存。'), L('Discard draft', '捨棄草稿')))) return;
      state.addingProfile = false;
      state.setupDraft = {};
      state.setupSection = 1;
      state.pendingEmployerDefaults = null;
      loadActiveProfile();
      render();
    };

    if (!$('#su-create')) return;
    state.setupSection = state.setupSection || 1;
    $$('#view input[id^="su-"], #view select[id^="su-"]').forEach(field => {
      if (Object.prototype.hasOwnProperty.call(state.setupDraft, field.id)) field.value = state.setupDraft[field.id];
      const label = field.previousElementSibling;
      if (label?.tagName === 'LABEL') label.htmlFor = field.id;
      field.addEventListener('input', () => { state.setupDraft[field.id] = field.value; field.removeAttribute('aria-invalid'); });
      field.addEventListener('change', () => { state.setupDraft[field.id] = field.value; updateSetupFields(); });
      if (!['su-helper'].includes(field.id)) field.required = true;
    });
    function updateSetupFields() {
      for (const [id, shown] of [['su-food', $('#su-food-mode').value === 'allowance'],
        ['su-rest-payment', $('#su-rest-work').value === 'agreed_payment']]) {
        const field = $('#' + id); field.hidden = !shown; field.disabled = !shown; field.required = shown;
        field.previousElementSibling.hidden = !shown;
      }
      $$('#view [data-setup-section]').forEach(section => { section.hidden = Number(section.dataset.setupSection) !== state.setupSection; });
      $('#su-create').hidden = state.setupSection !== 3;
      $('#su-next').hidden = state.setupSection === 3;
      $('#su-back').hidden = state.setupSection === 1;
      if ($('#ob-back')) $('#ob-back').hidden = state.setupSection !== 1;
      $('#setup-section-status').textContent = L('Contract details: ', '合約資料：') + state.setupSection + ' / 3';
    }
    updateSetupFields();
    const setupError = (message, selector) => {
      const box = $('#setup-error'); box.textContent = message; box.hidden = false;
      const field = $(selector); if (field) {
        state.setupSection = Number(field.closest('[data-setup-section]').dataset.setupSection);
        updateSetupFields(); field.setAttribute('aria-invalid', 'true'); field.focus();
      }
    };
    $('#su-back').onclick = () => { state.setupSection--; updateSetupFields(); window.scrollTo(0, 0); };
    $('#su-next').onclick = () => {
      const fields = [...$('#view [data-setup-section="' + state.setupSection + '"]').querySelectorAll('input,select')].filter(field => !field.disabled);
      const invalid = fields.find(field => !field.checkValidity());
      if (invalid) { setupError(L('Please check: ', '請核對：') + invalid.previousElementSibling.textContent, '#' + invalid.id); return; }
      if (state.setupSection === 2) {
        const minimum = Legal.minimumRatesForContract($('#su-signed').value);
        const wage = Number($('#su-wage').value), food = Number($('#su-food').value);
        if (!minimum || !Number.isFinite(wage) || wage < minimum.monthlyWage ||
            ($('#su-food-mode').value === 'allowance' && (!Number.isFinite(food) || food < minimum.foodAllowance))) {
          setupError(L('Check the signed date and the applicable minimum wage / food allowance.', '請核對簽署日期及其適用的最低工資／膳食津貼。'), !minimum ? '#su-signed' : wage < minimum.monthlyWage ? '#su-wage' : '#su-food'); return;
        }
      }
      $('#setup-error').hidden = true; state.setupSection++; updateSetupFields(); window.scrollTo(0, 0);
    };

    $('#su-create').onclick = () => {
      const wage = parseFloat($('#su-wage').value);
      const start = $('#su-start').value;
      const signed = $('#su-signed').value;
      const foodMode = $('#su-food-mode').value;
      const restPay = $('#su-rest-pay').value;
      const restWork = $('#su-rest-work').value;
      const earlyHoliday = $('#su-early-holiday').value;
      const winterChoice = $('#su-winter').value;
      const required = [['#su-wage', wage > 0 && Number.isFinite(wage)], ['#su-start', validRecordDate(start)], ['#su-signed', validRecordDate(signed)],
        ['#su-food-mode', foodMode], ['#su-rest-pay', restPay], ['#su-rest-work', restWork],
        ['#su-early-holiday', earlyHoliday], ['#su-winter', winterChoice]];
      const missing = required.filter(([, valid]) => !valid);
      if (missing.length) {
        const names = missing.map(([selector]) => $(selector).previousElementSibling.textContent);
        setupError(L('Please complete: ', '請完成：') + names.join(L(', ', '、')), missing[0][0]); return;
      }
      const restAmount = restWork === 'agreed_payment' ? Number($('#su-rest-payment').value) : 0;
      if (restWork === 'agreed_payment' && (!(restAmount > 0) || !Number.isFinite(restAmount))) {
        setupError(L('Enter the agreed cash amount for a full rest day worked.', '請填寫每個完整休息日工作的協議金額。'), '#su-rest-payment'); return;
      }
      const minimum = Legal.minimumRatesForContract(signed);
      const enteredFood = parseFloat($('#su-food').value) || 0;
      if (!minimum || wage < minimum.monthlyWage || (foodMode === 'allowance' && (!Number.isFinite(enteredFood) || enteredFood < minimum.foodAllowance))) {
        setupError(L('Check the signed date and the applicable minimum wage / food allowance.', '請核對簽署日期及其適用的最低工資／膳食津貼。'), !minimum ? '#su-signed' : wage < minimum.monthlyWage ? '#su-wage' : '#su-food'); return;
      }
      const defaults = state.pendingEmployerDefaults || {};
      const contractEnd = Compliance.expectedContractEnd(start);
      const foodAllowance = foodMode === 'allowance' ? enteredFood : 0;

      const id = Store.profiles.create();
      Store.profiles.setActive(id);
      state.config = {
        profileSchemaVersion: 2,
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
        restDayWorkPayment: restAmount,
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
      state.setupDraft = {};
      state.setupSection = 1;
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
        '<div class="today-type">' + dayBadges(cls) + ' ' + logStatusBadge(entry) + '</div>' +
        '<p class="muted small">' + L('Tap a choice to review the day, then Save.', '按選項查看當日記錄，再按「儲存」。') + '</p>' +
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
        '<h2>' + monthYear(stmt.year, stmt.month) + ' · ' + L('Whole-month projection', '整月預計金額') + '</h2>' +
        '<div class="stat-row">' +
        '<div class="stat"><div class="v plus">+' + (stmt.allowanceDays || 0) + L('d', '日') + '</div><div class="k">' + L('Extra work', '額外工作') + '</div></div>' +
        '<div class="stat"><div class="v minus">−' + (stmt.deductionDays || 0) + L('d', '日') + '</div><div class="k">' + L('Leave', '無薪假') + '</div></div>' +
        '<div class="stat"><div class="v">' + (stmt.estimateUnavailable ? '—' : money(stmt.total)) + '</div><div class="k">' +
        (stmt.estimateUnavailable ? L('Pay history needs review', '薪酬歷史須核對') : L('Projected salary', '預計薪金')) + '</div></div>' +
        '</div>' +
        '<p class="muted small mt">' + L(
          'Normal days use contract defaults. Confirm rest days and holidays, and record other exceptions.',
          '一般工作日按合約預設計算；請確認休息日及假日，並記錄其他例外情況。'
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
      b.onclick = e => {
        e.stopPropagation();
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
    $$('#view .pending-row[data-open-day]').forEach(row => {
      row.onclick = () => openDaySheet(row.dataset.openDay);
    });

    const ds = E.todayStr();
    if (!E.isEmployedOn(ds, state.config)) return;
    const cls = E.classifyDay(ds, state.config);
    $$('#view .choice').forEach(btn => {
      btn.onclick = () => {
if (!requireMembership()) return;
                openDaySheet(ds, parseFloat(btn.dataset.work));
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
      } else if (entry && typeof entry.work === 'number') {
        mark = '<span class="mark recorded">✓</span>';
      }
      cells += '<button class="cal-cell' + (isToday ? ' today' : '') +
        (cls.isRest ? ' rest' : '') + (cls.holiday ? ' holiday' : '') +
        (isPending ? ' pending' : '') + '" data-date="' + ds + '" aria-label="' + esc(fmtDate(ds) + ' · ' + dayTypeName(cls) + ' · ' +
          (isPending ? L('Awaiting approval', '待批准') : entry && typeof entry.work === 'number' ? L('Recorded', '已記錄') : L('Contract default, not recorded', '合約預設，未記錄'))) + '">' +
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
      '<span class="item"><span class="mark recorded">✓</span> ' + L('Default confirmed', '已確認與預設相同') + '</span>' +
      '</div>' +
      '<p class="muted small mt">' + L(
        'Tap a date, choose what happened, then Save. Unmarked days are contract defaults, not confirmations.',
        '按日期選擇當日情況，再按「儲存」。沒有記錄標記的日期只是合約預設，並非已確認。'
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

  function salaryRecord() {
    const current = E.computeMonth(state.salY, state.salM, state.config, state.logs);
    if (current) return current;
    const key = E.ymd(state.salY, state.salM, 1).slice(0, 7);
    const saved = latestStatement(key);
    if (!saved && !monthPayments(key).length) return null;
    // This is display metadata only, never a new calculation. Editing today's
    // contract dates must not hide immutable statements or actual payments.
    return { key, year: state.salY, month: state.salM, historicalOnly: true,
      periodStart: saved?.inputs?.periodStart || key + '-01',
      periodEnd: saved?.inputs?.periodEnd || E.ymd(state.salY, state.salM, E.daysInMonth(state.salY, state.salM)),
      partial: false, lines: [], total: 0, base: 0, pendingCount: 0 };
  }

  function salaryAssessment(stmt) {
    if (stmt.historicalOnly) return { ready: false, blockers: [{ code: 'history_contract_dates',
      en: 'Saved history is available, but this month is outside the current contract dates. No new estimate has been calculated.',
      zh: '過往記錄仍可查看，但此月份不在目前合約日期內，因此沒有重新估算。' }] };
    return Compliance.assessMonth({ statement: stmt, config: state.config, logs: state.logs,
      adjustments: monthAdjustments(stmt.key), engine: E });
  }

  function salaryHtml() {
    const y = state.salY, m = state.salM;
    const stmt = salaryRecord();

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
    const assessment = salaryAssessment(stmt);
    const frozen = latestStatement(stmt.key);
    const changed = frozen && !stmt.historicalOnly && statementHasChanges(frozen, stmt);
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
    if (stmt.historicalOnly) html += '<div class="banner mt">' + esc(isZh() ? assessment.blockers[0].zh : assessment.blockers[0].en) + '</div>';
    if (!frozen && !stmt.historicalOnly && !stmt.estimateUnavailable) html += '<details class="mt"><summary>' + L('View estimate basis', '查看估算依據') + '</summary><p class="muted small">' +
      L('Reference rate only: ', '只供參考的日率：') + money(stmt.monthlyWage ?? state.config.monthlyWage) + ' × 12 ÷ 365 = HK$' + stmt.dailyWage.toFixed(4) + '</p></details>';

    if (frozen) {
      html += '<div class="legal-status ready mt"><b>✓ ' + L('Confirmed statement', '已確認結算') + '</b><p>' +
        L('These line items and total belong to the same saved version. Later changes appear separately below.', '以下明細與總額來自同一個已保存版本；其後變更會另列於下方。') +
        '</p><details><summary>' + L('Calculation record', '計算記錄') + '</summary><code>' + esc(frozen.statementId) +
        '<br>' + esc(frozen.acceptedAt) + '<br>' + esc(frozen.modelVersion) + '<br>' + esc(frozen.legalSourceVersion) +
        '<br>' + esc(frozen.inputChecksum) + '</code></details></div>';
    } else if (!assessment.ready && !stmt.historicalOnly) {
      html += calculationChecklistHtml(assessment);
    } else if (!stmt.historicalOnly) {
      html += '<div class="legal-status ready mt"><b>✓ ' + L('Ready to review', '可以預覽結算') + '</b><p>' +
        L('Supported checks pass. Review the amounts before confirming a saved version.', '已通過受支援的檢查，請先預覽金額，再確認保存結算版本。') + '</p></div>';
    }

    html += '<div class="mt">';
    if (frozen) {
      html += confirmedMoneyHtml(frozen);
    } else if (!stmt.historicalOnly && !stmt.estimateUnavailable) {
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
    }
    html += '</div>';

    if (!frozen && stmt.pendingCount > 0) {
      html += '<div class="banner mt">⏳ ' + (isZh()
        ? '本月仍有' + stmt.pendingCount + '項工作日記錄等待僱主批准——請前往「今日」頁。這些項目可能顯示在估算內，但批准前不能納入已確認結算。'
        : stmt.pendingCount + ' day log' + (stmt.pendingCount === 1 ? '' : 's') +
          ' in this month still need' + (stmt.pendingCount === 1 ? 's' : '') +
          ' employer approval — see the Today tab. They may appear in the estimate, but cannot be included in a confirmed statement until approved.') + '</div>';
    }

    if (frozen || (!stmt.historicalOnly && !stmt.estimateUnavailable)) html += '<div class="stmt-total"><span>' + (frozen ? L('Confirmed total', '已確認總額') : L('Reference estimate', '參考估算')) + '</span><span class="amt">' + money(due) + '</span></div>';
    if (paid > 0) {
      html += '<div class="stmt-line mt"><span class="lbl">' + L('Paid so far', '目前已付') + '</span><span class="val">' + money(paid) + '</span></div>';
      if (frozen) html += '<div class="stmt-line"><span class="lbl"><b>' + L('Balance for confirmed version', '此已確認版本尚欠') + '</b></span><span class="val ' +
        (Math.abs(balance) < 0.005 ? 'plus' : '') + '">' +
        (Math.abs(balance) < 0.005 ? L('Settled ✓', '已付清 ✓') : money(balance)) + '</span></div>';
      else html += '<p class="muted small">' + L('Payments are recorded facts. No confirmed balance is available for this estimate.', '付款屬已記錄事實；此參考估算尚未有已確認的應付餘額。') + '</p>';
    }

    html += '<div class="row mt">' +
      (frozen || (!stmt.historicalOnly && !stmt.estimateUnavailable) ? '<button class="btn secondary compact grow" id="sal-copy">' + L('Copy statement', '複製結算單') + '</button>' : '') +
      (!helperMode && !frozen && !stmt.historicalOnly ? '<button class="btn ghost compact" id="sal-adj">' + L('+ Voluntary pay', '+ 自願付款') + '</button>' : '') +
      '</div>';
    if (!helperMode) {
      if (changed) html += '<p class="banner mt"><a href="#statement-changes">' + L('New changes are not included in this confirmed total. Review the difference before recording payment ↓', '此已確認總額未包括新增變更。記錄付款前，請先覆核下方差異 ↓') + '</a></p>';
      html += '<button class="btn mt" id="sal-pay"' + (!frozen && !assessment.ready ? ' disabled' : '') + '>' +
        (frozen ? L('Record payment for this confirmed version', '按此已確認版本記錄付款') : L('Preview and confirm statement', '預覽及確認結算')) + '</button>';
      if (!frozen && !assessment.ready) html += '<button class="btn secondary mt" id="sal-external">' +
        L('Record an externally calculated payment', '記錄另行核算後的實際付款') + '</button>';
    }
    if (changed) {
      html += '<section class="legal-status blocked mt" id="statement-changes"><b>' + L('Changes need a separate review', '另有變更需要覆核') + '</b><p>' +
        L('The current records or calculation inputs differ from this confirmed version (older versions may lack newer details). The confirmed statement above has not changed.',
          '目前記錄或計算資料與此版本不同（舊版本可能未保存新式資料）。上方已確認結算並未改動。') + '</p><p>' +
        (stmt.estimateUnavailable ? L('No new estimate or difference is available until the pay history is reviewed.', '薪酬歷史須另行核對，目前不會顯示新估算或差額。') :
        L('Current reference estimate: ', '目前參考估算：') + money(projection) + '<br>' +
        L('Difference from confirmed total: ', '與已確認總額差額：') + money(projection - due)) + '</p>' +
        (!assessment.ready ? '<p>' + L('The new version still has unresolved checks. Existing statements and payments remain unchanged.',
          '新版本仍有檢查項目未完成，原有結算及付款記錄不受影響。') + '</p>' : '') +
        (!helperMode ? '<button class="btn secondary mt" id="sal-revise">' + L('Review changes / create revision', '覆核變更／建立修訂版') + '</button>' : '') + '</section>';
    }
    const wageReview = payrollReviewStatus(stmt);
    html += '<section class="card mt"><h2>' + L('Monthly wage check-in', '每月工資待辦') + '</h2><p>' +
      (wageReview.complete ? (wageReview.state === 'external_review'
        ? L('Completed by employer’s external review — not a HelperPay-verified calculation.', '僱主已另行核對並完成待辦 — 並非 HelperPay 已驗證計算。')
        : L('Current confirmed version is covered by recorded payments.', '目前已確認版本的工資已有足夠付款記錄。'))
        : wageReview.state === 'period_open' ? L('This wage period is still open; its check-in cannot be completed yet.', '此工資期尚未完結，暫不能完成本月待辦。')
        : L('Still needs review. A payment on its own does not confirm the whole month is settled.', '仍須核對；單是一筆付款，並不代表整月已付清。')) + '</p>' +
      '<p class="small muted">' + L('Wages only. Receipt acknowledgement and other final-contract entitlements are separate. Changed records reopen the check-in.',
        '只限工資。確認收款及其他終止僱傭權益須另行處理；記錄有變更時，待辦會重新開啟。') + '</p>' +
      (wageReview.review ? '<p class="small">' + esc(wageReview.review.reviewedOn) + ' · ' + esc(wageReview.review.basis) + '</p>' : '') +
      (!helperMode && wageReview.state !== 'period_open' && wageReview.state !== 'confirmed_paid' ? '<button class="btn ghost mt" id="sal-month-review">' +
        L('Record / update external wage review', '記錄／更新外部工資核對') + '</button>' : '') + '</section>';
    const older = monthStatements(stmt.key).filter(record => record.statementId !== frozen?.statementId);
    if (older.length) {
      html += '<details class="mt"><summary>' + L('Previous confirmed versions', '過往已確認版本') + ' (' + older.length + ')</summary>' +
        older.map(record => '<section class="card"><p>' + esc(record.acceptedAt) + '</p>' + confirmedMoneyHtml(record) +
          '<p><b>' + L('Confirmed total: ', '已確認總額：') + money(record.totals.finalized.total) + '</b></p><code>' + esc(record.statementId) +
          '</code><button class="btn ghost mt" data-copy-statement="' + esc(record.statementId) + '">' + L('Copy this version', '複製此版本') + '</button></section>').join('') + '</details>';
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
          (!p.statementId ? '<p class="muted small">' + (p.calculationBasis === 'external'
            ? L('External calculation — not verified by HelperPay: ', '外部核算 — 未經 HelperPay 驗證：') + esc(p.externalCalculationNote)
            : L('Payment saved in an older version; original record retained without newer calculation details.', '舊版保存的付款記錄；原記錄保留，未附新版計算明細。')) + '</p>' : '') +
          (p.statementId && frozen && p.statementId !== frozen.statementId ? '<p class="muted small">' + L('Linked to a previous confirmed version: ', '此付款連結至先前的已確認版本：') + esc(p.statementId) + '</p>' : '') +
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
    const stmt = salaryRecord();
    if (!stmt) return;
    const assessment = salaryAssessment(stmt);
    const frozen = latestStatement(stmt.key);
    bindCalculationChecklist($('#view'), assessment);

    const reviewBtn = $('#sal-review');
    if (reviewBtn) reviewBtn.onclick = () => {
      state.ui.view = 'settings';
      saveUi();
      render();
    };

    const copyBtn = $('#sal-copy');
    if (copyBtn) copyBtn.onclick = () => {
      const text = statementText(stmt, {
        snapshot: frozen,
        adjustments: monthAdjustments(stmt.key),
        paid: monthPaid(stmt.key) || 0
      });
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => toast(L('Statement copied — paste into WhatsApp', '已複製結算單 — 可貼到 WhatsApp')))
        .catch(() => { window.prompt(L('Copy the statement:', '請複製結算單：'), text); });
    };
    $$('#view [data-copy-statement]').forEach(button => button.onclick = () => {
      const record = monthStatements(stmt.key).find(item => item.statementId === button.dataset.copyStatement);
      if (!record) return;
      const text = statementText(stmt, { snapshot: record });
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => toast(L('Confirmed version copied', '已複製此已確認版本')))
        .catch(() => window.prompt(L('Copy this version:', '請複製此版本：'), text));
    });

    const revisionBtn = $('#sal-revise');
    if (revisionBtn) revisionBtn.onclick = () => {
      if (!assessment.ready) { openCalculationChecklist(assessment); return; }
      openStatementReview(stmt);
    };

    const adjBtn = $('#sal-adj');
    if (adjBtn) adjBtn.onclick = () => openAdjustmentSheet(stmt);
    const externalBtn = $('#sal-external');
    if (externalBtn) externalBtn.onclick = () => openPaymentSheet(stmt, null);
    const reviewMonthBtn = $('#sal-month-review');
    if (reviewMonthBtn) reviewMonthBtn.onclick = () => openMonthlyReviewSheet(stmt);
    const payBtn = $('#sal-pay');
    if (payBtn) payBtn.onclick = async () => {
      if (!requireMembership()) return;
      if (!frozen && !assessment.ready) {
        const first = assessment.blockers[0];
        toast(isZh() ? first.zh : first.en);
        return;
      }
      if (frozen) openPaymentSheet(stmt, frozen);
      else openStatementReview(stmt);
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
      const files = Array.from(hidden.files || []);
      hidden.value = ''; // Selecting the same file again must allow a retry.
      if (p && files.length) {
        try {
          await attachFiles(p, files);
          toast(L('Screenshot added', '已加入截圖'));
          render();
        } catch {
          openSheet('<h2>' + L('Attachment not saved', '附件未能儲存') + '</h2><p class="form-error" role="alert">' +
            L('The payment and its existing photos are unchanged. Check available storage and choose a readable image, then use + Photo to retry.', '此付款及原有相片未改動。請檢查儲存空間並選用可讀取的圖片，再按「+ 相片」重試。') + '</p>');
        }
      }
    };
  }

  // ----- settings -----

  function backupOverdue() {
    const hasData = Object.keys(state.logs).length || state.payments.length;
    if (!hasData) return false;
    const confirmedAt = state.ui.lastBackupConfirmedAt || state.config.lastBackupAt;
    if (!confirmedAt) return true;
    return Date.now() - new Date(confirmedAt).getTime() > 21 * 86400000;
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
        'Review the actual contract terms below. Existing records are not changed automatically. Completing these terms does not resolve unsupported calculations; review any remaining items in Salary.',
        '請按實際合約核對以下條款，系統不會自動改寫現有記錄。補齊條款不代表所有計算均受支援；請到「薪金」查看尚需處理的項目。'
      ) + '</div>' +
      '<label>' + L('Contract type', '合約類型') + '</label><select id="st-contract-type"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="ID407"' + (c.contractType === 'ID407' ? ' selected' : '') + '>ID 407</option></select>' +
      '<label>' + L('Contract signed on', '合約簽署日期') + '</label><input id="st-signed" type="date" value="' + esc(c.contractSignedOn || '') + '">' +
      '<h3 class="mt">' + L('Wage & food history', '工資及膳食歷史') + '</h3>' + payHistoryHtml(c) +
      '<button class="btn secondary mt" id="st-confirm-terms">' + L('Review / update wage and food history', '核對／更新工資及膳食歷史') + '</button>' +
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
      ) + '</p></div>';

    // holidays grouped by year
    const byYear = {};
    const holidayIssues = HolidayReview.problems(c, E, state.logs);
    (c.holidays || []).forEach((h, index) => {
      const y = HolidayReview.validDate(h.date) ? h.date.slice(0, 4) : L('Date needs review', '日期待核對');
      (byYear[y] = byYear[y] || []).push({ ...h, index });
    });
    html += '<div class="card"><h2>' + L('Statutory holidays', '法定假日') + '</h2>' +
      '<label>' + L('Contractual choice: Winter Solstice or Christmas', '合約選擇：冬節或聖誕節') + '</label><select id="st-winter"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="winter_solstice"' + (c.winterHolidayChoice === 'winter_solstice' ? ' selected' : '') + '>' + L('Winter Solstice', '冬節') + '</option><option value="christmas"' + (c.winterHolidayChoice === 'christmas' ? ' selected' : '') + '>' + L('Christmas Day', '聖誕節') + '</option></select>';
    Object.keys(byYear).sort().forEach(y => {
      html += '<details class="holiday-year"><summary>' + y + ' · ' + byYear[y].length + L(' holiday records', '項假日記錄') + '</summary>';
      byYear[y].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(h => {
        const count = holidayIssues.filter(item => item.index === h.index).length;
        html += '<div class="holiday-row"><span class="date">' + esc(HolidayReview.validDate(h.date) ? fmtDateShort(h.date) : h.date || '—') + '</span>' +
          '<span class="name">' + esc(holidayName(h.name || '—')) + '<br><small>' + esc(holidayTypeLabel(h.type)) +
          (count ? ' · ' + count + L(' checks', '項待核對') : '') + '</small></span>' +
          '<button class="btn ghost compact" data-review-holiday="' + h.index + '">' + L('Review', '核對') + '</button></div>';
      });
      html += '</details>';
    });
    html += '<div class="row wrap mt">' +
      '<button class="btn secondary compact grow" id="st-hol-add">' + L('Add additional agreed holiday', '加入額外議定假日') + '</button>' +
      '<button class="btn ghost compact" id="st-hol-review">' + L('Review official calendar', '核對官方日曆') + '</button>' +
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
      '請將下載的 JSON 檔案妥善儲存。iPhone 如顯示 Safari 預覽，請另存到「檔案」；預覽並不等於備份。') +
      (state.ui.lastBackupConfirmedAt ? '<br>' + L('You confirmed a backup for all helpers on: ', '你確認已保存所有外傭備份的日期：') + new Date(state.ui.lastBackupConfirmedAt).toLocaleDateString(isZh() ? 'zh-HK' : 'en-HK') : '') + '</p>' +
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
      ) + '</p><a class="btn secondary compact mt" href="' + pageLink('privacy.html') + '" target="_blank" rel="noopener" style="text-decoration:none">' + L('Read privacy policy', '閱讀私隱政策') + '</a></div>';

    html += '<div class="card"><h2>' + L('Legal calculation boundaries', '法律計算界線') + '</h2>' +
      '<p class="muted small">' + L(
        '• A complete month starts with the monthly contract wage and recorded food term.<br>' +
        '• ×12÷365 is a reference projection only, not a universal Labour Department formula.<br>' +
        '• Statutory average-wage entitlements require preceding wage history with excluded periods removed.<br>' +
        '• Rest-day pay and compensation follow the parties’ agreement; no cash amount is invented.<br>' +
        '• Statutory-holiday work requires 48 hours’ notice and an alternative holiday within 60 days; cash cannot replace it.<br>' +
        '• Pending entries, unrestricted deductions, incomplete contract terms and unsupported first/final-month cases cannot produce a HelperPay-confirmed statement.<br><br>' +
        'HelperPay is a transparent reference and record-keeping tool, not legal advice or an authoritative payroll product.',
        '• 完整月份以合約月薪及已記錄的膳食條款為起點。<br>' +
        '• ×12÷365 只屬參考估算，並非勞工處適用於所有情況的公式。<br>' +
        '• 法定平均工資權益須使用過往工資記錄，並剔除指定期間及款項。<br>' +
        '• 休息日是否有薪及其工作補償按雙方協議；系統不會自行加上現金。<br>' +
        '• 法定假日工作須提前48小時通知，並在前後60日內安排另定假日；不得以現金取代。<br>' +
        '• 待批准記錄、不受限制的扣款、不完整合約條款及未支援的首月／尾月情況均不能建立 HelperPay 已確認結算。<br><br>' +
        'HelperPay 是透明的參考及記錄工具，並非法律意見或權威薪酬產品。'
      ) + '</p>' +
      '<a class="btn secondary compact mt" href="' + Compliance.OFFICIAL_CALCULATOR + '" target="_blank" rel="noopener" style="text-decoration:none">' + L('Open official entitlement calculator', '開啟官方僱傭權益計算機') + '</a>' +
      '<a class="btn secondary compact mt" style="text-decoration:none" href="' + pageLink('guide.html') + '" target="_blank" rel="noopener">' +
      '📖 ' + L('User guide · 使用指南', '使用指南 · User guide') + '</a>' +
      '<a class="btn secondary compact mt" style="text-decoration:none" href="' + whatsappUrl() + '" target="_blank" rel="noopener">' +
      '💬 ' + L('WhatsApp the developer — ', 'WhatsApp 聯絡開發者 — ') + WHATSAPP_DISPLAY + '</a>' +
      '<p class="muted small mt">HelperPay v' + APP_VERSION + ' · ' +
      '<a href="mailto:' + FEEDBACK_EMAIL + '?subject=HelperPay%20feedback" style="color:var(--accent)">' + L('Email feedback', '電郵意見') + '</a></p>' +
      '</div>';

    return html;
  }

  function organizeSettings() {
    const view = $('#view');
    const cards = [...view.children].filter(node => node.classList.contains('card'));
    const groups = [
      ['contract', L('Helper and contract', '外傭及合約'), '#add-helper,#st-helper,#st-contract-type'],
      ['holidays', L('Holiday calendar', '假日日曆'), '#st-winter'],
      ['privacy', L('Data, backup and privacy', '資料、備份及私隱'), '#st-hpin,#st-export,#st-analytics'],
      ['help', L('Help and calculation limits', '幫助及計算界線'), 'a[href="' + Compliance.OFFICIAL_CALCULATOR + '"]']
    ];
    state.settingsSections = state.settingsSections || {};
    groups.forEach(([id, title, selectors]) => {
      const selected = cards.filter(card => card.querySelector(selectors));
      if (!selected.length) return;
      const details = document.createElement('details');
      details.className = 'card settings-group'; details.dataset.settingsGroup = id;
      const summary = document.createElement('summary'); summary.textContent = title;
      details.appendChild(summary); selected[0].before(details);
      selected.forEach(card => details.appendChild(card));
      details.open = state.settingsSections[id] === true;
      details.ontoggle = () => { if (details.isConnected) state.settingsSections[id] = details.open; };
    });
    const quick = document.createElement('div'); quick.className = 'row settings-shortcuts';
    quick.innerHTML = '<button class="btn secondary compact" data-settings-shortcut="privacy">' + L('Back up records', '備份記錄') + '</button>' +
      '<button class="btn ghost compact" data-settings-shortcut="help">' + L('Help / official calculator', '幫助／官方計算機') + '</button>';
    view.prepend(quick);
    quick.querySelectorAll('[data-settings-shortcut]').forEach(button => button.onclick = () => {
      const group = view.querySelector('[data-settings-group="' + button.dataset.settingsShortcut + '"]');
      group.open = true; group.scrollIntoView({ block: 'start' }); group.querySelector('summary').focus();
    });
  }

  function holidayTypeLabel(type) {
    const labels = {
      statutory_holiday: ['Official statutory holiday', '官方法定假日'],
      alternative_holiday: ['Alternative holiday (±60 days)', '另定假日（前後60日）'],
      substituted_holiday: ['Agreed substituted holiday (±30 days)', '雙方同意的代替假日（前後30日）'],
      rest_day_collision_holiday: ['Holiday after a rest-day collision', '與休息日重疊後的假日'],
      substituted_rest_day: ['Agreed substituted rest day', '雙方同意的補回休息日'],
      contractual_holiday: ['Additional agreed holiday', '額外議定假日']
    };
    return labels[type] ? L(...labels[type]) : L('Type not confirmed', '類型未確認');
  }

  function holidayRecordHtml(row) {
    if (!row) return '<p>' + L('New record', '新記錄') + '</p>';
    return '<p><b>' + esc(row.date || '—') + '</b> · ' + esc(holidayName(row.name || '—')) + '<br>' + esc(holidayTypeLabel(row.type)) +
      (row.altFor || row.collisionFor || row.restFor ? '<br>' + L('Source: ', '原日期：') + esc(row.altFor || row.collisionFor || row.restFor) : '') +
      (row.workStartsAt ? '<br>' + L('Work start (HK): ', '開始工作（香港）：') + esc(holidayHKTime(row.workStartsAt).replace('T',' ')) : '') +
      (row.noticeAt ? '<br>' + L('Notice given (HK): ', '發出通知（香港）：') + esc(holidayHKTime(row.noticeAt).replace('T',' ')) : '') +
      (row.mutualAgreement === true ? '<br>' + L('Mutual agreement recorded', '已記錄雙方同意') : '') + '</p>';
  }

  function holidayHKTime(value) {
    return value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0,16) : '';
  }

  function holidayRevisionHtml(config) {
    return !(config.holidayRevisions || []).length ? '' : '<details class="mt"><summary>' + L('Saved calendar changes', '已保存的日曆更改') + '</summary>' +
      config.holidayRevisions.slice().reverse().map(r => '<section class="card"><b>' + esc(r.recordedAt) + '</b><p>' + esc(r.reason) + '</p>' +
        '<details><summary>' + L('Original records', '原有記錄') + '</summary>' + (r.before?.holidays || []).map(holidayRecordHtml).join('') + '</details>' +
        '<details><summary>' + L('Saved records', '更改後記錄') + '</summary>' + (r.after?.holidays || []).map(holidayRecordHtml).join('') + '</details></section>').join('') + '</details>';
  }

  function openCalendarReviewSheet(requestedChoice) {
    if (state.ui.helperMode) return;
    const original = Legal.checksum(state.config), profileId = Store.profiles.active();
    const ov = openSheet('<h2>' + L('Review official calendar', '核對官方日曆') + '</h2><p>' +
      L('Review the proposed 2026–2027 dates against your contract. Existing work, payments, statements and linked arrangements will not be rewritten. Duplicate records remain for individual review.',
        '請按合約核對建議的2026至2027年日期。原有工作、付款、結算及已連結安排不會被改寫；重複記錄會保留供逐項核對。') + '</p>' +
      '<label for="calendar-choice">' + L('Actual contractual winter holiday', '合約實際選擇的冬季假日') + '</label><select id="calendar-choice"><option value="">' + L('Choose…','請選擇……') + '</option><option value="winter_solstice">' + L('Winter Solstice','冬節') + '</option><option value="christmas">' + L('Christmas Day','聖誕節') + '</option></select>' +
      '<div id="calendar-preview"></div><label for="calendar-reason">' + L('Reason / checked record','原因／核對依據') + '</label><textarea id="calendar-reason"></textarea>' +
      '<label class="checkline"><input type="checkbox" id="calendar-confirm">' + L('I checked the contract choice and proposed changes. This does not create a new agreement.','我已核對合約選擇及建議更改；此操作不會訂立新協議。') + '</label>' +
      '<p id="calendar-error" class="form-error" role="alert" hidden></p><button class="btn mt" id="calendar-save">' + L('Save reviewed calendar','保存已核對日曆') + '</button>' +
      '<button class="btn ghost mt" id="calendar-cancel">' + L('Cancel','取消') + '</button>' + holidayRevisionHtml(state.config));
    let preview = null;
    const draw = () => {
      preview = null; ov.querySelector('#calendar-confirm').checked = false;
      try {
        preview = HolidayReview.plan(state.config, ov.querySelector('#calendar-choice').value);
        const remaining = HolidayReview.problems(preview.next, E, state.logs);
        ov.querySelector('#calendar-preview').innerHTML = '<h3>' + L('Before saving','保存前預覽') + '</h3>' +
          preview.changes.map(change => '<section class="card">' + (change.kind === 'conflict' ? '<p class="form-error">' + esc(change.expected.date) + ' · ' +
            L('Duplicate records: unchanged; review each one below.','重複記錄：不改動，請於下方逐筆核對。') + '</p>' :
            (change.before ? '<b>' + L('Before','更改前') + '</b>' + holidayRecordHtml(change.before) : '<b>' + L('Add missing official holiday','加入缺少的官方假日') + '</b>') +
            '<b>' + L('After','更改後') + '</b>' + holidayRecordHtml(change.after)) + '</section>').join('') +
          (!preview.changes.length ? '<p>' + L('Official dates already match. No date will move.','官方日期已相符，不會移動日期。') + '</p>' : '') +
          (preview.linked.length ? '<p class="form-error">' + L('These linked arrangements keep their original source and date. After saving, review them individually; the app cannot transfer an agreement to the new holiday.','以下安排會保留原日期及連結。保存後須逐項核對，系統不會把原協議轉移至新假日。') + '</p>' + preview.linked.map(item => holidayRecordHtml(item.row)).join('') : '') +
          (remaining.length ? '<p class="banner">' + remaining.length + L(' checks will still need review. Saving this calendar does not clear them.','項仍須核對，保存日曆不會將它們當作已解決。') + '</p>' +
            [...new Set(remaining.map(item => item.index))].filter(index => index < state.config.holidays.length).map(index => '<button class="btn ghost compact" data-calendar-record="' + index + '">' + L('Review record: ','核對記錄：') + esc(state.config.holidays[index].date || '—') + '</button>').join('') : '');
        ov.querySelectorAll('[data-calendar-record]').forEach(b => b.onclick = async () => {
          if (ov._dirty && !(await confirmDialog(L('Leave preview?','離開預覽？'),L('Discard the unsaved calendar review and open the original record?','捨棄未保存的日曆核對，並開啟原記錄？'),L('Continue','繼續')))) return;
          closeSheet(ov); openHolidayRecordReview(+b.dataset.calendarRecord);
        });
      } catch { ov.querySelector('#calendar-preview').textContent = L('Choose the actual contractual holiday first.','請先選擇合約實際假日。'); }
    };
    ov.querySelector('#calendar-choice').value = requestedChoice || state.config.winterHolidayChoice || '';
    ov.querySelector('#calendar-choice').onchange = draw; draw();
    ov.querySelector('#calendar-save').onclick = () => {
      if (!requireMembership()) return;
      const fail = message => { const box=ov.querySelector('#calendar-error'); box.textContent=message; box.hidden=false; };
      if (state.ui.helperMode || Store.profiles.active()!==profileId || Legal.checksum(state.config)!==original) {
        fail(L('The helper or settings changed. Close and reopen the review.','外傭或設定已改變，請關閉後重新核對。')); return;
      }
      if (!preview || !ov.querySelector('#calendar-confirm').checked) { fail(HolidayReview.message({code:'confirmation'},state.ui.language)); return; }
      let next;
      try { next=HolidayReview.applyPlan(state.config,preview.next.winterHolidayChoice,{id:uid(),recordedAt:new Date().toISOString(),reason:ov.querySelector('#calendar-reason').value}); }
      catch(error) { fail(HolidayReview.message({code:error.message},state.ui.language)); return; }
      try { Store.saveConfig(next); state.config=next; closeSheet(ov); render(); toast(L('Calendar saved. Review any remaining flagged records.','日曆已保存，請繼續核對仍有提示的記錄。')); }
      catch { fail(L('Could not save. Nothing changed; your input is kept for retry.','未能儲存，資料未改動；已保留輸入供重試。')); }
    };
    ov.querySelector('#calendar-cancel').onclick = () => requestSheetClose(ov);
  }

  function openHolidayRecordReview(index) {
    if (state.ui.helperMode) return;
    const adding=index===null, row=adding ? {} : state.config.holidays?.[index];
    if (!row) return;
    const original=Legal.checksum(state.config), profileId=Store.profiles.active();
    const issues=adding ? [] : HolidayReview.problems(state.config,E,state.logs).filter(item=>item.index===index);
    const official=row.type==='statutory_holiday' && row.officialId;
    const fields = '<label for="holiday-type">' + L('Actual type','實際類型') + '</label><select id="holiday-type"><option value="">' + L('Choose…','請選擇……') + '</option>' +
      HolidayReview.TYPES.filter(type=>type!=='statutory_holiday' && (!adding || type==='contractual_holiday')).map(type=>'<option value="'+type+'">'+esc(holidayTypeLabel(type))+'</option>').join('') + '</select>' +
      '<label for="holiday-date">'+L('Day off date','放假日期')+'</label><input id="holiday-date" type="date" value="'+esc(row.date||'')+'">' +
      '<label for="holiday-name">'+L('Name','名稱')+'</label><input id="holiday-name" value="'+esc(row.name||'')+'">' +
      '<div id="holiday-source-fields"><label for="holiday-source">'+L('Original statutory / rest day','原法定假日／休息日')+'</label><input id="holiday-source" type="date" value="'+esc(row.altFor||row.collisionFor||row.restFor||'')+'"></div>' +
      '<div id="holiday-notice-fields"><label for="holiday-work">'+L('Actual work start (Hong Kong time)','實際開始工作（香港時間）')+'</label><input id="holiday-work" type="datetime-local" value="'+esc(holidayHKTime(row.workStartsAt))+'">' +
      '<label for="holiday-notice">'+L('Notice actually given (Hong Kong time)','實際發出通知（香港時間）')+'</label><input id="holiday-notice" type="datetime-local" value="'+esc(holidayHKTime(row.noticeAt))+'"></div>' +
      '<label class="checkline" id="holiday-agreement-row"><input type="checkbox" id="holiday-agreement">'+L('Both parties actually agreed to this arrangement.','雙方已實際同意此安排。')+'</label>';
    const ov=openSheet('<h2>'+L(adding?'Add additional agreed holiday':'Review holiday record',adding?'加入額外議定假日':'核對假日記錄')+'</h2>'+holidayRecordHtml(adding?null:row)+
      '<ul class="issue-list">'+issues.map(issue=>'<li>'+esc(HolidayReview.message(issue,state.ui.language))+'</li>').join('')+'</ul>' +
      '<p>'+L('Only record checked facts. Do not invent notice or agreement. Work, payment and confirmed statement records stay unchanged. Removing an incorrect entry does not cancel an entitlement.','只記錄已核實事實，不可補造通知或協議。工作、付款及已確認結算不會改動；移除錯誤記錄不代表取消權益。')+'</p>' +
      '<button class="btn ghost compact" id="holiday-official">'+L('Review official calendar','核對官方日曆')+'</button>' +
      (official ? '<p>'+L('Official statutory dates are managed in the calendar review, not as custom holidays. Only a duplicate official record can be archived here.','官方法定日期須在日曆核對中處理，不可改作自訂假日；此處只可封存重複的官方記錄。')+'</p>' : '') +
      (!adding ? '<label class="checkline"><input id="holiday-archive" type="checkbox">'+L('Archive only this incorrect / duplicate entry; keep its original in change history.','只封存這一筆錯誤／重複項目，原記錄保留於更改歷史。')+'</label>' : '') +
      '<div id="holiday-edit-fields">'+fields+'</div><p id="holiday-guidance" class="muted small"></p>' +
      '<label for="holiday-reason">'+L('Correction reason / checked record','更正原因／核對依據')+'</label><textarea id="holiday-reason"></textarea>' +
      '<label class="checkline"><input id="holiday-confirm" type="checkbox">'+L('I checked this against the actual arrangement. Any entitlement still owed remains owed.','我已核對實際安排，任何仍未補回的權益不會因此取消。')+'</label>' +
      '<p id="holiday-error" class="form-error" role="alert" hidden></p><button class="btn secondary mt" id="holiday-preview-button">'+L('Preview correction','預覽更正')+'</button>' +
      '<div id="holiday-preview" hidden></div><button class="btn mt" id="holiday-review-save" disabled>'+L('Save reviewed record','保存已核對記錄')+'</button>' +
      '<button class="btn ghost mt" id="holiday-cancel">'+L('Cancel','取消')+'</button>'+holidayRevisionHtml(state.config));
    let preview=null, previewInput='';
    const fail=message=>{const box=ov.querySelector('#holiday-error');box.textContent=message;box.hidden=false;};
    const update=()=>{
      const type=ov.querySelector('#holiday-type').value, archive=!!ov.querySelector('#holiday-archive')?.checked;
      ov.querySelector('#holiday-edit-fields').hidden=archive||official;
      ov.querySelector('#holiday-source-fields').hidden=!type||type==='contractual_holiday';
      ov.querySelector('#holiday-notice-fields').hidden=!['alternative_holiday','substituted_holiday'].includes(type);
      ov.querySelector('#holiday-agreement-row').hidden=!['substituted_holiday','substituted_rest_day'].includes(type);
      ov.querySelector('#holiday-guidance').textContent=type==='contractual_holiday' ? L('An additional holiday does not settle statutory time off. Arrange any entitlement separately.','額外假日不會補回法定假日，仍須另行安排應有權益。') :
        ['alternative_holiday','substituted_holiday'].includes(type) ? HolidayReview.message({code:'arrangement'},state.ui.language) : '';
    };
    ov.querySelector('#holiday-type').value=adding?'contractual_holiday':row.type||'';
    ov.querySelector('#holiday-agreement').checked=row.mutualAgreement===true; update();
    const read=()=>({draft:{type:ov.querySelector('#holiday-type').value,date:ov.querySelector('#holiday-date').value,name:ov.querySelector('#holiday-name').value,
      sourceDate:ov.querySelector('#holiday-source').value,workStartsAt:ov.querySelector('#holiday-work').value ? ov.querySelector('#holiday-work').value+'+08:00' : '',
      noticeAt:ov.querySelector('#holiday-notice').value ? ov.querySelector('#holiday-notice').value+'+08:00' : '',mutualAgreement:ov.querySelector('#holiday-agreement').checked,
      confirmed:ov.querySelector('#holiday-confirm').checked,archive:!!ov.querySelector('#holiday-archive')?.checked},reason:ov.querySelector('#holiday-reason').value});
    const invalidate=event=>{
      preview=null;ov.querySelector('#holiday-preview').hidden=true;ov.querySelector('#holiday-review-save').disabled=true;
      if (event.target.id!=='holiday-confirm') ov.querySelector('#holiday-confirm').checked=false;
      if (['holiday-type','holiday-date','holiday-source'].includes(event.target.id)) ov.querySelector('#holiday-agreement').checked=false;
      update();
    };
    ov.querySelectorAll('input,select,textarea').forEach(input=>input.addEventListener('input',invalidate));
    ov.querySelector('#holiday-preview-button').onclick=()=>{
      preview=null;ov.querySelector('#holiday-review-save').disabled=true;ov.querySelector('#holiday-error').hidden=true;
      const entered=read(),meta={id:uid(),recordedAt:new Date().toISOString(),reason:entered.reason};
      try {
        preview=adding?HolidayReview.add(state.config,entered.draft,meta,E):HolidayReview.edit(state.config,index,entered.draft,meta,E,state.logs);
        previewInput=Legal.checksum(entered);
        const box=ov.querySelector('#holiday-preview');box.hidden=false;
        box.innerHTML='<h3>'+L('Before saving','保存前預覽')+'</h3><b>'+L('Before','更改前')+'</b>'+holidayRecordHtml(adding?null:row)+
          '<b>'+L('After','更改後')+'</b>'+(entered.draft.archive?'<p>'+L('Only this entry will be archived. Work and payment records stay unchanged.','只會封存此項目，工作及付款記錄不變。')+'</p>':holidayRecordHtml(preview.holidays[adding?preview.holidays.length-1:index]));
        ov.querySelector('#holiday-review-save').disabled=false;
      } catch(error) { fail((error.issues || [{code:error.message}]).map(issue=>HolidayReview.message(issue,state.ui.language)).join('\n')); }
    };
    ov.querySelector('#holiday-review-save').onclick = () => {
      if (!requireMembership()) return;
      if(!preview || previewInput!==Legal.checksum(read())){fail(L('Preview the current inputs first.','請先預覽目前輸入。'));return;}
      if(state.ui.helperMode || Store.profiles.active()!==profileId || Legal.checksum(state.config)!==original){fail(L('The helper or settings changed. Close and reopen the review.','外傭或設定已改變，請關閉後重新核對。'));return;}
      try {Store.saveConfig(preview);state.config=preview;preview=null;closeSheet(ov);render();toast(L('Reviewed record saved; original retained in change history.','核對記錄已保存，原記錄保留於更改歷史。'));}
      catch {fail(L('Could not save. Nothing changed; your input is kept for retry.','未能儲存，資料未改動；已保留輸入供重試。'));}
    };
    ov.querySelector('#holiday-cancel').onclick=()=>requestSheetClose(ov);
    ov.querySelector('#holiday-official').onclick=async()=>{
      if(ov._dirty && !(await confirmDialog(L('Leave correction?','離開更正？'),L('Discard this unsaved correction and review the official calendar?','捨棄此未保存更正，並核對官方日曆？'),L('Continue','繼續'))))return;
      closeSheet(ov);openCalendarReviewSheet();
    };
  }

  function winterCalendarPlan(config, choice) {
    if (!['winter_solstice', 'christmas'].includes(choice)) throw Error('Choose a winter holiday');
    const winter = Holidays.defaultHolidays(choice).filter(day => /:winter_holiday$/.test(day.officialId));
    const isWinter = day => /:winter_holiday$/.test(day.officialId || '') ||
      (!day.type && !day.altFor && !day.collisionFor && !day.restFor &&
        /^202[67]-12-(22|25)$/.test(day.date || '') &&
        /^(Chinese Winter Solstice Festival or Christmas Day|Christmas Day|Chinese Winter Solstice Festival|冬節|聖誕節)$/.test(day.name || ''));
    const removed = (config.holidays || []).filter(isWinter);
    const moved = removed.filter(day => !winter.some(next => next.date === day.date)).map(day => day.date);
    const linked = (config.holidays || []).filter(day => moved.includes(day.altFor) || moved.includes(day.collisionFor));
    return { removed, winter, linked, next: { ...config, winterHolidayChoice: choice,
      holidays: (config.holidays || []).filter(day => !isWinter(day)).concat(winter).sort((a,b) => a.date.localeCompare(b.date)) } };
  }

  function openWinterCalendarSheet(choice) {
    if (state.ui.helperMode) return;
    let plan;
    try { plan = winterCalendarPlan(state.config, choice); }
    catch { toast(L('Choose Winter Solstice or Christmas.', '請選擇冬節或聖誕節。')); return; }
    if (plan.removed.some((day,index)=>plan.removed.some((other,i)=>i!==index&&other.date.slice(0,4)===day.date.slice(0,4)))) { openCalendarReviewSheet(choice); return; }
    const original = Legal.checksum(state.config), profileId = Store.profiles.active();
    const ov = openSheet('<h2>' + L('Preview winter holiday dates', '預覽冬季假日日期') + '</h2><p>' +
      L('The choice and calendar will be saved together. Other holidays, work records, notes and confirmed statements are kept.', '合約選擇及日曆會一併儲存，其他假日、工作記錄、備註及已確認結算均會保留。') + '</p><ul>' +
      plan.winter.map(day => '<li>' + esc(day.date.slice(0,4)) + ': ' +
        esc(plan.removed.filter(old => old.date.slice(0,4) === day.date.slice(0,4)).map(old => fmtDateShort(old.date)).join(', ') || L('not recorded','未記錄')) +
        ' → ' + esc(fmtDateShort(day.date)) + '</li>').join('') + '</ul>' +
      (plan.linked.length ? '<p class="form-error" role="alert">' + L('A moved holiday already has a linked day-off agreement. Nothing will be changed here. Review the existing agreement first; the app cannot assume it applies to a different holiday.',
        '將移動的假日已有連結的補假協議。此處不會改動資料，請先覆核原協議；系統不能假設協議適用於另一個假日。') + '</p>' +
        plan.linked.map(day => '<p>' + esc(day.altFor || day.collisionFor) + ' → ' + esc(day.date) + '</p>').join('') +
        '<button class="btn secondary mt" id="winter-review">' + L('Review calendar and linked records', '核對日曆及已連結記錄') + '</button>' +
        '<a class="btn ghost mt" href="' + whatsappUrl() + '" target="_blank" rel="noopener">' + L('Ask for help reviewing linked arrangements', '尋求協助覆核已連結安排') + '</a>' : '') +
      '<p class="muted small">' + L('This corrects the recorded terms; it does not make a new agreement with the helper. Review any work on the affected dates before confirming the next statement.',
        '此操作只更正已記錄條款，不會代你與外傭訂立新協議。下次確認结算前，請覆核受影響日期的工作記錄。') + '</p>' +
      '<p id="winter-error" class="form-error" role="alert" hidden></p><button class="btn mt" id="winter-save"' + (plan.linked.length ? ' disabled' : '') + '>' +
      L('Confirm choice and dates', '確認選擇及日期') + '</button><button class="btn ghost mt" id="winter-cancel">' + L('Cancel', '取消') + '</button>');
    ov.querySelector('#winter-cancel').onclick = () => closeSheet(ov);
    if (ov.querySelector('#winter-review')) ov.querySelector('#winter-review').onclick = () => { closeSheet(ov); openCalendarReviewSheet(choice); };
    ov.querySelector('#winter-save').onclick = () => {
      if (!requireMembership()) return;
      const fail = message => { const box = ov.querySelector('#winter-error'); box.textContent = message; box.hidden = false; };
      if (plan.linked.length || state.ui.helperMode || Store.profiles.active()!==profileId || original !== Legal.checksum(state.config)) {
        fail(L('Settings have changed or linked agreements need review. Close and reopen this preview.', '設定已改變或已有協議須覆核，請關閉後重新預覽。')); return;
      }
      try {
        const next=HolidayReview.revision(state.config,plan.next,{id:uid(),recordedAt:new Date().toISOString(),reason:L('Confirmed contractual winter holiday choice','確認合約冬季假日選擇')},'winter_choice');
        Store.saveConfig(next); state.config = next; closeSheet(ov); render(); toast(L('Winter choice and calendar saved together', '冬季假日選擇及日曆已一併儲存'));
      }
      catch { fail(L('Could not save. The original choice and dates are unchanged.', '未能儲存，原有選擇及日期均未改動。')); }
    };
  }

  function payHistoryHtml(config) {
    const records = PayHistory.rows(config);
    const complete = PayHistory.complete(config);
    return (!complete ? '<p class="banner">' + L('This history needs review. Existing payments and confirmed statements remain unchanged.', '此歷史須核對，原有付款及已確認結算保持不變。') + '</p>' : '') +
      '<p class="muted small">' + L('Record actual agreed terms and their effective dates. A change does not rewrite past statements or make an agreement on behalf of either party.',
        '按生效日期記錄實際議定的條款；此處不會改寫過往結算，亦不會代任何一方訂立協議。') + '</p>' +
      '<ol class="pay-history">' + records.map((row, index) => '<li><b>' + esc(row.effectiveFrom) + ' – ' +
        esc(index + 1 < records.length ? E.addDays(records[index + 1].effectiveFrom, -1) : config.contractEndDate) + '</b><p>' +
        L('Monthly wage: ', '月薪：') + (row.monthlyWage === '' ? L('Not recorded', '未記錄') : money(row.monthlyWage)) + '<br>' +
        (row.mode === 'provided' ? L('Food provided free', '免費提供膳食') : row.mode === 'allowance' ? L('Monthly food allowance: ', '每月膳食津貼：') + money(row.monthlyAmount) : L('Food terms not recorded', '膳食條款未記錄')) + '</p></li>').join('') + '</ol>';
  }

  function openPayHistorySheet() {
    const complete = PayHistory.complete(state.config);
    const ov = openSheet('<h2>' + L('Wage & food history', '工資及膳食歷史') + '</h2>' + payHistoryHtml(state.config) +
      '<p>' + L('Choose what actually happened:', '請選擇實際情況：') + '</p>' +
      (complete ? '<button class="btn mt" id="history-change">' + L('Record a wage / food change from a date', '記錄某日起的加薪／膳食變更') + '</button>' :
        '<button class="btn mt" id="history-confirm">' + L('Complete and check my history', '補齊並核對歷史') + '</button>') +
      '<button class="btn secondary mt" id="history-correct">' + L('Correct an earlier input mistake', '更正以往輸入錯誤') + '</button>' +
      '<p class="muted small mt">' + L('If you are unsure, keep the existing record and check the contract or ask for help. Do not confirm that the whole contract was unchanged unless that is true.',
        '若不確定，請保留原記錄並核對合約或尋求協助；不可將曾經變更的安排確認為整份合約不變。') + '</p>' +
      '<a class="btn ghost mt" href="' + whatsappUrl() + '" target="_blank" rel="noopener">' + L('Ask for help', '尋求協助') + '</a>' +
      ((state.config.payTermRevisions || []).length ? '<details class="mt"><summary>' + L('Saved change history', '已保存的更改記錄') + '</summary>' +
        state.config.payTermRevisions.slice().reverse().map(r => '<div class="card"><b>' + esc(r.recordedAt) + '</b><p>' + esc(r.reason) + '</p></div>').join('') + '</details>' : '') +
      '<button class="btn ghost mt" id="history-close">' + L('Close', '關閉') + '</button>');
    for (const [id, kind] of [['change', 'change'], ['confirm', 'confirm'], ['correct', 'correction']]) {
      const button = ov.querySelector('#history-' + id);
      if (button) button.onclick = () => { closeSheet(ov); openPayHistoryEditor(kind); };
    }
    ov.querySelector('#history-close').onclick = () => closeSheet(ov);
  }

  function openPayHistoryEditor(kind) {
    if (state.ui.helperMode) return;
    const config = state.config, original = Legal.checksum(config), profileId = Store.profiles.active();
    if (!validRecordDate(config.startDate) || !validRecordDate(config.contractEndDate) || !validRecordDate(config.contractSignedOn)) {
      openSheet('<h2>' + L('Complete the contract dates first', '請先補齊合約日期') + '</h2><p>' +
        L('Enter the signed date, start date and two-year end date in Settings, then reopen wage history.', '請先在設定填寫簽署日期、開始日期及兩年完結日期，再打開工資歷史。') + '</p>'); return;
    }
    const complete = PayHistory.complete(config);
    let draft = kind === 'change' ? [{ effectiveFrom: '', monthlyWage: '', mode: '', monthlyAmount: '' }] : PayHistory.rows(config);
    if (!(config.wagePeriods?.length || config.foodTerms?.length)) draft = [{ effectiveFrom: config.startDate,
      monthlyWage: config.monthlyWage ?? '', mode: config.foodMode || '', monthlyAmount: config.foodAllowance ?? '' }];
    let preview = null;
    const ov = openSheet('<h2>' + (kind === 'change' ? L('Record a dated change', '記錄按日期生效的變更') : kind === 'correction' ? L('Correct recorded history', '更正已記錄歷史') : L('Check and complete history', '核對並補齊歷史')) + '</h2>' +
      '<p>' + (kind === 'change' ? L('Earlier periods and any later recorded changes will be preserved. Enter all terms that apply from the effective date.', '會保留較早期間及已記錄的較後變更。請填寫由生效日期起適用的完整條款。') :
        L('Start with the contract start date and add a row each time wage or food terms changed. Keep rows in date order; each row lasts until the next change or contract end.',
          '由合約開始日期填起；工資或膳食每次變更便加一行。請按日期順序填寫，每行適用至下次變更前一天或合約完結。')) + '</p>' +
      (!complete ? '<p class="banner">' + L('These are unconfirmed draft values, not a verified history. Check each period against your records.', '以下只是未確認的草稿值，並非已核實歷史，請按你的記錄逐段核對。') + '</p>' : '') +
      '<div id="history-rows"></div>' + (kind !== 'change' ? '<button class="btn secondary mt" id="history-add">' + L('+ Add another effective date', '+ 加入另一生效日期') + '</button>' : '') +
      '<label for="history-reason">' + L('Reason / record checked (required)', '原因／已核對的記錄（必填）') + '</label><textarea id="history-reason" required></textarea>' +
      '<p class="muted small">' + L('A saved history is not approval of statutory average-wage calculations. A changed or partial month may still need the official calculator. Existing statements and payments will not be rewritten.',
        '保存歷史不代表法定平均工資計算已獲核證。工資變更或非完整月份仍可能須使用官方計算機；原有結算及付款不會改寫。') + '</p>' +
      '<p id="history-error" class="form-error" role="alert" hidden></p>' +
      '<button class="btn mt" id="history-preview">' + L('Preview the effective periods', '預覽生效期間') + '</button>' +
      '<div id="history-review" aria-live="polite"></div><button class="btn mt" id="history-save" hidden>' + L('Confirm and save this history', '確認並保存此歷史') + '</button>' +
      '<button class="btn ghost mt" id="history-cancel">' + L('Cancel', '取消') + '</button>');
    const invalidate = () => { preview = null; ov.querySelector('#history-save').hidden = true; ov.querySelector('#history-review').innerHTML = ''; };
    const capture = () => draft = draft.map((row, i) => ({ effectiveFrom: ov.querySelector('#history-date-' + i).value,
      monthlyWage: ov.querySelector('#history-wage-' + i).value, mode: ov.querySelector('#history-food-' + i).value,
      monthlyAmount: ov.querySelector('#history-amount-' + i).value }));
    const draw = () => {
      ov.querySelector('#history-rows').innerHTML = draft.map((row, i) => '<fieldset class="card pay-history-row"><legend>' + L('Period ', '期間 ') + (i + 1) + '</legend>' +
        '<label for="history-date-' + i + '">' + L('Effective from', '生效日期') + '</label><input id="history-date-' + i + '" type="date" required min="' + esc(config.startDate) + '" max="' + esc(config.contractEndDate) + '" value="' + esc(row.effectiveFrom) + '">' +
        '<label for="history-wage-' + i + '">' + L('Monthly wage (HK$)', '月薪（港幣）') + '</label><input id="history-wage-' + i + '" type="number" inputmode="decimal" step="0.01" required value="' + esc(row.monthlyWage) + '">' +
        '<label for="history-food-' + i + '">' + L('Food arrangement', '膳食安排') + '</label><select id="history-food-' + i + '"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="provided"' + (row.mode === 'provided' ? ' selected' : '') + '>' + L('Food provided free', '免費提供膳食') + '</option><option value="allowance"' + (row.mode === 'allowance' ? ' selected' : '') + '>' + L('Monthly allowance', '每月膳食津貼') + '</option></select>' +
        '<div id="history-amount-row-' + i + '"' + (row.mode !== 'allowance' ? ' hidden' : '') + '><label for="history-amount-' + i + '">' + L('Monthly food allowance (HK$)', '每月膳食津貼（港幣）') + '</label><input id="history-amount-' + i + '" type="number" inputmode="decimal" step="0.01" value="' + esc(row.monthlyAmount) + '"></div>' +
        (kind !== 'change' && i > 0 ? '<button class="btn ghost mt" data-remove-period="' + i + '">' + L('Remove this draft row', '移除此草稿行') + '</button>' : '') + '</fieldset>').join('');
      draft.forEach((row, i) => ov.querySelector('#history-food-' + i).onchange = () => {
        ov.querySelector('#history-amount-row-' + i).hidden = ov.querySelector('#history-food-' + i).value !== 'allowance';
      });
      ov.querySelectorAll('[data-remove-period]').forEach(button => button.onclick = () => {
        capture(); draft.splice(Number(button.dataset.removePeriod), 1); invalidate(); draw(); ov._dirty = true;
      });
    };
    draw();
    ov.addEventListener('input', invalidate); ov.addEventListener('change', invalidate);
    const add = ov.querySelector('#history-add');
    if (add) add.onclick = () => { capture(); draft.push({ effectiveFrom: '', monthlyWage: '', mode: '', monthlyAmount: '' }); invalidate(); draw(); ov._dirty = true; };
    const fail = (message, field) => {
      const box = ov.querySelector('#history-error'); box.hidden = false; box.textContent = message;
      const input = ov.querySelector('#history-' + field); if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    };
    ov.querySelector('#history-preview').onclick = () => {
      capture(); invalidate();
      const result = PayHistory.prepare(config, draft, { kind, reason: ov.querySelector('#history-reason').value,
        asOf: E.todayStr(), id: uid(), recordedAt: new Date().toISOString() });
      if (result.errors.length) {
        const error = result.errors[0], messages = {
          reason: L('Enter why you are changing or confirming these records.', '請填寫更改或確認此記錄的原因。'),
          date: L('Check the effective dates: start at the contract start, keep date order, and do not repeat or exceed the contract dates.', '請核對生效日期：由合約開始日填起，按順序排列，不可重複或超出合約期。'),
          existing_date: L('A period already starts on that date. Use “Correct an earlier input mistake” if it needs changing.', '該日期已有期間開始；如須更改，請使用「更正以往輸入錯誤」。'),
          history_first: L('Complete the earlier history before adding a new change.', '請先補齊較早歷史，再加入新變更。'),
          below_maw: L('A monthly wage is below the minimum for the contract signing date.', '有期間的月薪低於合約簽署日期適用的最低工資。'),
          below_minimum: L('A food allowance is below the minimum for this contract.', '有期間的膳食津貼低於此合約適用的最低金額。'),
          wage: L('Enter a valid positive monthly wage for every period.', '請為每個期間填寫有效的正數月薪。'),
          food: L('Choose food provided or allowance for every period.', '請為每個期間選擇提供膳食或支付津貼。'),
          amount: L('Enter a valid food allowance amount.', '請填寫有效膳食津貼金額。')
        };
        fail(messages[error.code] || L('Check the contract dates and every effective period.', '請核對合約日期及每個生效期間。'), error.field); return;
      }
      preview = result.next; ov.querySelector('#history-error').hidden = true;
      ov.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
      ov.querySelector('#history-review').innerHTML = '<h3 class="mt">' + L('Check before saving', '保存前請核對') + '</h3>' + payHistoryHtml(preview);
      ov.querySelector('#history-save').hidden = false;
      ov.querySelector('#history-review').scrollIntoView({ block: 'start' });
    };
    ov.querySelector('#history-save').onclick = () => {
      if (!requireMembership()) return;
      if (!preview || state.ui.helperMode || Store.profiles.active() !== profileId || Legal.checksum(state.config) !== original) {
        fail(L('The data changed. Close and reopen the history, then preview again.', '資料已改變，請關閉並重新打開歷史，再次預覽。'), 'save'); return;
      }
      try { Store.saveConfig(preview); state.config = preview; closeSheet(ov); render();
        toast(L('Effective-dated history saved; existing statements and payments unchanged.', '生效歷史已保存，原有結算及付款未改動。')); }
      catch { fail(L('Could not save. Your entered values are still here; the original history is unchanged. Retry after checking storage.', '未能保存，已填內容仍保留，原有歷史未改動；請檢查儲存空間後重試。'), 'save'); }
    };
    ov.querySelector('#history-cancel').onclick = () => closeSheet(ov);
  }

  function bindSettings() {
    organizeSettings();
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
    const winter = $('#st-winter');
    winter.onchange = () => { const choice = winter.value; winter.value = c.winterHolidayChoice || ''; openWinterCalendarSheet(choice); };

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
    if (confirmTerms) confirmTerms.onclick = openPayHistorySheet;

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

    $$('#view [data-review-holiday]').forEach(b => b.onclick = () => openHolidayRecordReview(+b.dataset.reviewHoliday));
    $('#st-hol-add').onclick = () => openHolidayRecordReview(null);
    $('#st-hol-review').onclick = () => openCalendarReviewSheet();

    $('#st-export').onclick = async () => {
      const button = $('#st-export');
      button.disabled = true;
      const exportedAt = new Date().toISOString();
      try {
        await window.HSNativeBackup.export(await Store.exportAll(), state.ui.language);
        toast(L('Download requested. Check Files / Downloads to confirm the backup was saved.',
          '已要求下載。請到「檔案」／下載位置確認備份已儲存。'));
        const saved = await confirmDialog(L('Is the backup file saved?', '備份檔案已保存嗎？'),
          L('Check the file in your chosen destination. Confirm only after it is saved; closing a preview or share sheet is not enough. This confirmation updates the backup reminder for all helpers.',
            '請到所選位置檢查檔案，確認已保存才繼續；關閉預覽或分享視窗並不足夠。此確認會更新所有外傭的備份提醒。'),
          L('I checked — file saved', '我已檢查，檔案已保存'));
        if (saved) {
          const ui = { ...state.ui, lastBackupConfirmedAt: exportedAt };
          Store.saveUi(ui); state.ui = ui; render();
        }
      } catch (error) {
        openSheet('<h2>' + L('Backup not confirmed', '備份未確認') + '</h2><p class="form-error" role="alert">' +
          L('The backup reminder has not been reset. Check free storage and your chosen destination, then retry. Existing payroll records have not been erased.',
            '備份提醒尚未重設。請檢查可用空間及所選儲存位置後重試，原有薪酬記錄並未清除。') + '</p>');
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
