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
  const PaymentLedger = window.HSPaymentLedger;
  const Compliance = window.HSCompliance;
  const Store = window.HSStore;
  const Holidays = window.HSHolidays;
  const HolidayReview = window.HSHolidayReview;
  const I18n = window.HSI18n;
  const Language = window.HSLanguage;

  const APP_VERSION = '1.1.3-web-free';
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
      }), openSheet, closeSheet, toast, render, saveCheckinStart,
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
  function saveCheckinStart(profileId, startDate, expected) {
    if(state.ui.helperMode || Store.profiles.active()!==profileId || !Store.profiles.list().includes(profileId)) throw Error('profile_changed');
    const current=Store.loadConfig();
    if(!current || JSON.stringify({view:current.checkinView,createdAt:current.createdAt})!==expected) throw Error('preference_changed');
    const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    if(!validRecordDate(startDate) || startDate>today) throw Error('invalid_date');
    const next={...current,checkinView:{version:1,startDate}};
    // This is a backed-up display preference, not a wage or contract amendment.
    // Load the latest config so unrelated changes from another tab survive.
    Store.saveConfig(next);state.config=next;
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
    onboardingStep: 1,            // one welcome screen, then a minimal profile setup
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
  const initialMonth = E.todayStr();
  state.calY = +initialMonth.slice(0, 4); state.calM = +initialMonth.slice(5, 7);
  state.salY = state.calY; state.salM = state.calM;

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
    if (cls.scheduleUnconfirmed) return L('Day type needs checking', '當日類型待核對');
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
      L('Contract terms or recorded leave / work need review. Use the official calculator; payments remain separate facts.', '合約條款或工作／請假記錄須核對，請使用官方計算機；已記錄付款仍屬獨立事實。');
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
    }
    // A body-level toast is hidden behind a native dialog's top layer.
    const host = document.querySelector('.billing-overlay[open]') ||
      [...document.querySelectorAll('#sheet-root dialog[open]')].pop() || document.body;
    if (t.parentNode !== host) host.appendChild(t);
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
    if (overlay._closed) return;
    const L = (en, zh) => (overlay._language || state.ui.language) === 'zh-HK' ? zh : en;
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
    const nativeDialog = typeof document.createElement('dialog').showModal === 'function';
    const text = (en, zh) => (opts.language || state.ui.language) === 'zh-HK' ? zh : en;
    const root = $('#sheet-root');
    const overlay = document.createElement('div');
    overlay.className = 'overlay' + (opts.center ? ' center' : '') + (nativeDialog ? ' native-sheet' : '');
    overlay._returnFocus = document.activeElement;
    overlay._onDismiss = opts.onDismiss;
    overlay._onClosed = opts.onClosed;
    overlay._language = opts.language;
    overlay._guardChanges = opts.guardChanges !== false;
    const tag = nativeDialog ? 'dialog' : 'div';
    overlay.innerHTML = '<' + tag + ' class="sheet"' + (nativeDialog ? '' : ' role="dialog" aria-modal="true" tabindex="-1"') + '>' +
      (!opts.sticky ? '<div class="sheet-toolbar"><button type="button" class="btn ghost compact" data-sheet-close>' + text('Close', '關閉') + ' ×</button></div>' : '') + html + '</' + tag + '>';
    const sheet = overlay.querySelector('.sheet');
    if (opts.language) sheet.lang = opts.language;
    const heading = sheet.querySelector('h1,h2,h3');
    if (heading) { if (!heading.id) heading.id = 'sheet-heading-' + uid(); sheet.setAttribute('aria-labelledby', heading.id); }
    else sheet.setAttribute('aria-label', text('HelperPay form', 'HelperPay 表格'));
    enhanceFormLabels(sheet);
    overlay.querySelector('[data-sheet-close]')?.addEventListener('click', () => requestSheetClose(overlay));
    overlay.addEventListener('input', () => { overlay._dirty = true; });
    overlay.addEventListener('change', () => { overlay._dirty = true; });
    overlay.addEventListener('click', e => {
      if (e.target.closest('.choice') && !e.target.closest('[data-navigation]') && !e.target.closest('.choice').classList.contains('selected')) overlay._dirty = true;
      if (overlay._dirty && e.target.closest('[id$="-cancel"],[id$="-close"],[data-close],[data-act="no"]')) {
        e.preventDefault(); e.stopImmediatePropagation(); requestSheetClose(overlay);
      }
    }, true);
    overlay.addEventListener('click', e => { if (e.target === overlay && !opts.sticky) requestSheetClose(overlay); });
    sheet.addEventListener('cancel', e => {
      e.preventDefault();
      if (root.lastElementChild === overlay && !opts.sticky) requestSheetClose(overlay);
    });
    // Native backdrop clicks target the dialog, not its wrapper. Do not treat
    // clicks in empty space inside the form as dismissals.
    sheet.addEventListener('click', e => {
      if (!nativeDialog || e.target !== sheet || opts.sticky || root.lastElementChild !== overlay) return;
      const rect = sheet.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) requestSheetClose(overlay);
    });
    overlay._keydown = e => {
      if (root.lastElementChild !== overlay || document.querySelector('.billing-overlay')) return;
      if (e.key === 'Escape') { e.preventDefault(); if (!opts.sticky) requestSheetClose(overlay); return; }
      if (e.key !== 'Tab') return;
      const controls = [...sheet.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex="0"]')]
        .filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); sheet.focus(); }
      else if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', overlay._keydown);
    if (!nativeDialog) [...root.children].forEach(child => { child.inert = true; });
    root.appendChild(overlay);
    if (nativeDialog) sheet.showModal();
    sheet.focus();
    if (!nativeDialog) ['#view', '#topbar', '#tabbar'].forEach(selector => { const element = $(selector); if (element) element.inert = true; });
    return overlay;
  }

  function closeSheet(overlay) {
    if (overlay._closed) return;
    overlay._closed = true;
    document.removeEventListener('keydown', overlay._keydown);
    // Let the browser end its modal scope before detaching the dialog.
    const sheet = overlay.querySelector('.sheet');
    if (sheet?.open && typeof sheet.close === 'function') sheet.close();
    sheet?.removeAttribute('aria-modal');
    overlay.remove();
    overlay._onClosed?.();
    const top = $('#sheet-root').lastElementChild;
    if (top) top.inert = false;
    if (!top) ['#view', '#topbar', '#tabbar'].forEach(selector => { const element = $(selector); if (element) element.inert = false; });
    const previous = overlay._returnFocus;
    // Chained sheets often replace the clicked button during render. On touch
    // devices the prior active element may also be body (not focusable). Always
    // restore a live focus target, so WebView's accessibility tree can re-enter
    // the page after the aria-modal dialog is removed.
    if (previous?.isConnected && previous !== document.body && !previous.disabled &&
        !previous.closest('[inert],[hidden]') && previous.getClientRects().length &&
        (!top || top.contains(previous))) previous.focus({ preventScroll: true });
    if (top) {
      if (!top.contains(document.activeElement)) top.querySelector('.sheet')?.focus({ preventScroll: true });
    } else if (document.activeElement === document.body || !document.activeElement?.isConnected) {
      const view = $('#view');
      if (view) { view.setAttribute('tabindex', '-1'); view.focus({ preventScroll: true }); }
    }
    // A caller may render immediately after closing, disconnecting the focus
    // target just restored. Repair only lost focus, never a new dialog/input.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
      if ($('#sheet-root').lastElementChild || (document.activeElement !== document.body && document.activeElement?.isConnected)) return;
      const view = $('#view');
      if (view && !view.inert) { view.setAttribute('tabindex', '-1'); view.focus({ preventScroll: true }); }
    });
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

  function absenceKindLabel(kind) {
    const labels = {unpaid:['Ordinary unpaid leave','普通無薪假'],annual:['Annual leave','年假'],sick:['Sick leave / medical absence','病假／就診'],
      maternity:['Maternity leave','產假'],paternity:['Paternity leave','侍產假'],work_injury:['Work-injury absence','工傷缺勤'],other:['Other leave / absence','其他請假／缺勤'],unknown:['Type needs checking','類型待核對']};
    return labels[kind] ? L(...labels[kind]) : L('Unclassified old record','未分類舊記錄');
  }

  function absenceSummary(entry) {
    if (!E.validAbsence(entry)) return L('Old or incomplete leave record — check type and actual duration', '舊有或不完整的請假記錄 — 請核對類型及實際時間');
    const a=entry.absence;
    const duration=a.duration==='full_day' ? L('whole working day','整個工作日') : a.duration==='unknown' ? L('duration needs checking','時間待核對') :
      Math.floor(a.minutes/60)+L('h ', '小時 ')+(a.minutes%60)+L('m','分鐘');
    return absenceKindLabel(a.kind)+' · '+duration+L(' — pay requires separate review',' — 薪酬須另行核對');
  }

  function openAbsenceSheet(ds, initialDuration, parent, draftNote) {
      if (!requireMembership()) return;
    if (!validRecordDate(ds) || !E.isEmployedOn(ds,state.config)) return;
    const profileId=Store.profiles.active(), helperMode=state.ui.helperMode, original=Legal.checksum({config:state.config,logs:state.logs});
    const entry=state.logs[ds] || {}, a=E.validAbsence(entry) ? entry.absence : {};
    const duration=a.duration || initialDuration || '';
    const ov=openSheet('<h2>'+L('Record leave / absence','記錄請假／缺勤')+'</h2><p>'+esc(fmtDate(ds))+'</p>'+
      '<p class="banner">'+L('This records what happened, not approval of a leave entitlement or a wage deduction. Pay, statutory eligibility and leave balances must be checked separately.',
      '這裡記錄實際情況，不代表已批准假期權益或扣薪。薪酬、法定資格及假期餘額須另行核對。')+'</p>'+
      (E.classifyDay(ds,state.config).type!=='normal' ? '<p class="form-error">'+L('This date is a rest day or holiday. Recording leave will not mark that entitlement as taken or move it. Review any overlap separately.',
        '此日期屬休息日或假日。記錄請假不會把該權益標為已享用，亦不會搬移日期；重疊情況須另行核對。')+'</p>' : '')+
      '<label for="absence-kind">'+L('Leave / absence type','請假／缺勤類型')+'</label><select id="absence-kind"><option value="">'+L('Choose the actual type…','選擇實際類型……')+'</option>'+
      E.ABSENCE_KINDS.map(kind=>'<option value="'+kind+'"'+(a.kind===kind?' selected':'')+'>'+esc(absenceKindLabel(kind))+'</option>').join('')+'</select>'+
      '<label for="absence-duration">'+L('Actual time away from work','實際未上班時間')+'</label><select id="absence-duration"><option value="">'+L('Choose…','請選擇……')+'</option>'+
      [['full_day',L('Whole working day','整個工作日')],['minutes',L('Enter actual hours and minutes','填寫實際小時及分鐘')],['unknown',L('I need to check the duration','時間需要核對')]].map(([value,label])=>'<option value="'+value+'"'+(duration===value?' selected':'')+'>'+label+'</option>').join('')+'</select>'+
      '<div id="absence-time"><p class="muted small">'+L('Enter only time actually absent from scheduled work, excluding planned breaks. No half-day fraction or pay rate is inferred. Record each date separately.',
        '只填原定上班時段內實際未上班的時間，不包括原定休息。系統不會換算成半日或推算扣薪，跨日請分日期記錄。')+'</p><div class="row"><div class="grow"><label for="absence-hours">'+L('Hours','小時')+'</label><input id="absence-hours" type="number" inputmode="numeric" min="0" max="24" step="1" value="'+(a.duration==='minutes'?Math.floor(a.minutes/60):'')+'"></div><div class="grow"><label for="absence-minutes">'+L('Minutes','分鐘')+'</label><input id="absence-minutes" type="number" inputmode="numeric" min="0" max="59" step="1" value="'+(a.duration==='minutes'?a.minutes%60:'')+'"></div></div></div>'+
      '<label for="absence-note">'+L('Note (optional; avoid diagnoses or sensitive medical details)','備註（選填；請避免填寫診斷或敏感醫療資料）')+'</label><input id="absence-note" value="'+esc(draftNote ?? entry.note ?? '')+'">'+
      '<p class="muted small">'+L('Saved only on this device. A helper entry remains pending employer review. Use the official calculator or obtain professional advice for pay; this version does not calculate leave entitlements.',
        '只存於本裝置。外傭輸入的記錄仍待僱主核對。薪酬請使用官方計算機或取得專業意見；此版本不計算假期權益。')+'</p><a href="'+Compliance.OFFICIAL_CALCULATOR+'" target="_blank" rel="noopener">'+L('Official entitlement calculator','官方權益計算機')+'</a>'+
      '<p id="absence-error" role="alert" class="form-error" hidden></p><button class="btn mt" id="absence-save">'+L('Save facts — review pay separately','保存記錄 — 薪酬另行核對')+'</button><button class="btn ghost mt" id="absence-cancel">'+L('Back without saving','返回，不保存')+'</button>');
    const update=()=>{ov.querySelector('#absence-time').hidden=ov.querySelector('#absence-duration').value!=='minutes';};
    ov.querySelector('#absence-duration').value=duration;
    ov.querySelector('#absence-kind').value=a.kind || '';
    ov.querySelector('#absence-duration').onchange=update;update();
    const clearError=()=>{const box=ov.querySelector('#absence-error');box.hidden=true;box.textContent='';};
    ov.addEventListener('input',clearError);ov.addEventListener('change',clearError);
    ov.querySelector('#absence-cancel').onclick=()=>closeSheet(ov);
    let saved=false;
    ov.querySelector('#absence-save').onclick = () => {
      if (!requireMembership()) return;
      const fail=text=>{const box=ov.querySelector('#absence-error');box.hidden=false;box.textContent=text;};
      if(saved)return;
      if(profileId!==Store.profiles.active() || helperMode!==state.ui.helperMode || original!==Legal.checksum({config:state.config,logs:state.logs})) {fail(L('Records changed. Close and reopen this date; nothing was overwritten.','記錄已改變，請關閉並重新開啟此日期；沒有覆蓋資料。'));return;}
      const kind=ov.querySelector('#absence-kind').value, mode=ov.querySelector('#absence-duration').value;
      let minutes=null;
      if(mode==='minutes') {
        const hours=ov.querySelector('#absence-hours').value.trim(), mins=ov.querySelector('#absence-minutes').value.trim();
        if((hours==='' && mins==='') || (hours!=='' && !/^\d+$/.test(hours)) || (mins!=='' && !/^\d+$/.test(mins)) || Number(hours)>24 || Number(mins)>59) {fail(L('Enter whole hours (0–24) and minutes (0–59), not a half-day estimate.','請輸入整數小時（0–24）及分鐘（0–59），不要以半日估算。'));return;}
        minutes=Number(hours)*60+Number(mins);
      }
      const next={work:null,absence:{version:1,kind,duration:mode,minutes},by:helperMode?'helper':'employer',status:helperMode?'pending':'approved',at:new Date().toISOString()};
      if(!E.validAbsence(next)) {fail(L('Choose a type and duration. Actual time must be 1–1,440 minutes, or explicitly choose duration needs checking.','請選類型及時間；實際時間須為1至1,440分鐘，或明確選擇時間待核對。'));return;}
      const note=ov.querySelector('#absence-note').value.trim();if(note)next.note=note;
      const logs={...state.logs,[ds]:next};
      try {Store.saveLogs(logs);state.logs=logs;}
      catch {fail(L('Not saved. Existing records and this form are unchanged; check storage and retry.','未能保存，原有記錄及表格內容仍保留；請檢查儲存空間後重試。'));return;}
      saved=true;closeSheet(ov);if(parent)closeSheet(parent);render();
      toast(helperMode?L('Leave facts saved — awaiting employer review','請假事實已保存 — 待僱主核對'):L('Leave facts saved — pay still needs separate review','請假事實已保存 — 薪酬仍須另行核對'));
    };
    return ov;
  }

  function workOptions(cls) {
    if (cls.scheduleUnconfirmed) return [1, 0.5, 0].map(work => ({ work,
      label: work === 1 ? L('Worked full day', '上班全日') : work === 0.5 ? L('Worked half day', '上班半日') : L('Did not work', '沒有上班'),
      sub: L('Record the fact; day type and pay still need checking', '先記錄實際情況；當日類型及薪酬仍須核對'), amt: L('review', '待覆核'), cl: 'zero' }));
    if (cls.type === 'normal') {
      return [
        { work: 1, label: L('Worked', '已上班'), sub: L('Normal working day', '正常工作日'), amt: L('normal pay', '正常計薪'), cl: 'zero' },
        { work: 0.5, label: L('Leave / absence for part of the day', '部分時間請假／缺勤'), sub: L('Choose type and actual duration next; no automatic deduction', '下一步選類型及實際時間，不會自動扣薪'), amt: L('details', '填寫資料'), cl: 'zero' },
        { work: 0, label: L('Leave / absence for the whole day', '全日請假／缺勤'), sub: L('Choose the actual type next; not necessarily unpaid', '下一步選實際類型，並不一定是無薪假'), amt: L('details', '填寫資料'), cl: 'zero' }
      ];
    }
    const what = cls.type === 'rest' ? L('Rest day', '休息日') : L('Holiday', '法定假日');
    const agreedCash = cls.isRest && !cls.restTerms?.issue && cls.restTerms?.restDayWorkArrangement === 'agreed_payment'
      ? Number(cls.restTerms.restDayWorkPayment) : 0;
    const workOption = work => ({ work, label: work === 1 ? L('Worked full day', '上班全日') : L('Worked half day', '上班半日'),
      sub: agreedCash > 0 ? L('Rest-day agreement effective on this date; subject to review', '採用當日生效的休息日協議；仍須覆核') : L('Check the agreed day-off / compensation arrangement', '請核對已協議的補假／補償安排'),
      amt: agreedCash > 0 ? '+' + money(agreedCash * work) : L('review', '待覆核'), cl: agreedCash > 0 ? 'plus' : 'zero' });
    return [
      { work: 0, label: isZh() ? '已放' + what : what + ' taken', sub: L('Pay follows the recorded contract term', '薪酬按已記錄的合約條款處理'), amt: L('no work', '沒有上班'), cl: 'zero' },
      workOption(0.5), workOption(1)
    ];
  }

  function currentWork(ds, cls) {
    const entry = state.logs[ds];
    if (entry?.dayTypeUnconfirmed || E.isAbsence(entry)) return null;
    return entry && typeof entry.work === 'number' ? entry.work : cls.scheduleUnconfirmed ? null : E.defaultWork(cls.type);
  }

  // Who logged a day matters: helper entries stay "pending" until the
  // employer approves them; employer entries are authoritative immediately.
  // An explicit confirmation is retained even when it matches the default.
  // Older entries with no approval status need review before new finalization.
  function setWork(ds, cls, work, note, voluntary = false) {
    const noteVal = (note || '').trim();
    const entry = { work, by: state.ui.helperMode ? 'helper' : 'employer', status: state.ui.helperMode ? 'pending' : 'approved', at: new Date().toISOString() };
    if (cls.scheduleUnconfirmed) entry.dayTypeUnconfirmed = true;
    if (noteVal) entry.note = noteVal;
    if (cls.isRest && work > 0) entry.restWorkVoluntary = voluntary === true;
    const logs = { ...state.logs, [ds]: entry };
    Store.saveLogs(logs);
    state.logs = logs;
    try { HSTrack('day-logged'); } catch { /* Optional analytics cannot turn a saved record into a reported failure. */ }
  }

  // Approving a default-valued record is still an explicit confirmation.
  function approveLog(ds) {
    const entry = state.logs[ds];
    if (!entry) return;
    const logs = { ...state.logs, [ds]: { ...entry, status: 'approved', approvedAt: new Date().toISOString() } };
    Store.saveLogs(logs);
    state.logs = logs;
  }

  function pendingLogDates() {
    return Object.keys(state.logs).filter(ds => state.logs[ds].status === 'pending').sort();
  }

  function describeLogEffect(ds) {
    const cls = E.classifyDay(ds, state.config);
    if (E.isAbsence(state.logs[ds])) return absenceSummary(state.logs[ds]);
    const w = state.logs[ds].work;
    if (cls.scheduleUnconfirmed || state.logs[ds].dayTypeUnconfirmed) return (w === 1 ? L('Worked full day', '上班全日') : w === 0.5 ? L('Worked half day', '上班半日') : L('Did not work', '沒有上班')) + L(' — day type and pay need checking', ' — 當日類型及薪酬待核對');
    if (cls.type === 'normal') {
      if (w === 1) return L('Worked — normal day (no pay change)', '已上班 — 正常工作日（薪金不變）');
      return L('Old absence marker — type, duration and pay need checking', '舊缺勤標記 — 類型、時間及薪酬須核對');
    }
    const label = dayTypeName(cls);
    if (w === 0) return isZh() ? '已放' + label + '（薪酬按合約條款）' : label + ' taken (pay follows the contract term)';
    return isZh()
      ? label + ' — 已上班' + (w === 0.5 ? '半日（須覆核補償）' : '（須覆核補償）')
      : label + ' — worked' + (w === 0.5 ? ' half day (compensation needs review)' : ' (compensation needs review)');
  }

  function logStatusBadge(entry) {
    if (!entry) return '<span class="badge">' + L('Contract default — not yet recorded', '合約預設 — 尚未記錄') + '</span>';
    if (E.isAbsence(entry)) return '<span class="badge pending">' + (!E.validAbsence(entry) || !['pending','approved'].includes(entry.status) ? L('Leave record needs checking','請假記錄須核對') : entry.status==='pending' ? L('Leave facts awaiting employer review','請假事實待僱主核對') : L('Leave recorded — pay needs review','已記錄請假 — 薪酬待核對')) + '</span>';
    if (entry.dayTypeUnconfirmed) return '<span class="badge pending">' + L('Fact saved — day type needs checking', '實際情況已保存 — 當日類型待核對') + '</span>';
    if (![0, 0.5, 1].includes(entry.work)) return '<span class="badge pending">' + L('Record needs review', '記錄須核對') + '</span>';
    if (entry.status === 'pending') return '<span class="badge pending">⏳ ' + L('Awaiting employer approval', '等待僱主批准') + '</span>';
    if (entry.status !== 'approved') return '<span class="badge pending">' + L('Record needs review', '記錄須核對') + '</span>';
    if (entry.by === 'helper') return '<span class="badge approved">✓ ' + L('Approved', '已批准') + '</span>';
    return '<span class="badge approved">✓ ' + L('Day recorded — not a payment', '已記錄當日情況 — 並非付款') + '</span>';
  }

  function dayBadges(cls) {
    if (cls.scheduleUnconfirmed) return '<span class="badge pending">' + L('Day type needs checking', '當日類型待核對') + '</span> ';
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
    const profileId = Store.profiles.active(), original = Legal.checksum({ config: state.config, logs: state.logs }), helperMode = state.ui.helperMode;
    let selected = [0, 0.5, 1].includes(initialWork) ? initialWork : currentWork(ds, cls);
    const opts = workOptions(cls);

    const choicesHtml = opts.map((o, i) =>
      '<button class="choice' + (o.work === selected ? ' selected' : '') + '" data-i="' + i + '"'+(cls.type==='normal' && !cls.scheduleUnconfirmed && o.work<1?' data-navigation="absence"':'')+'>' +
      '<span>' + esc(o.label) + '<span class="sub">' + esc(o.sub) + '</span></span>' +
      '<span class="row"><span class="amt ' + o.cl + '">' + esc(o.amt) + '</span>' +
      '<span class="check">' + (o.work === selected ? '✓' : '') + '</span></span>' +
      '</button>').join('');

    const restToggle = !state.ui.helperMode
      ? '<details class="mt"><summary>' + L('Separate rest-day agreement (optional)', '另行更改休息日協議（選用）') + '</summary><button class="btn ghost compact mt" id="rest-toggle">' +
        (cls.isRest ? L('Move this rest day', '更改此休息日的日期') : L('Add an agreed rest day', '加入已協議的休息日')) + '</button>' +
        '<p class="muted small" style="margin-top:6px">' + L(
          'Working on a rest day and changing its date are different. Only change the date to reflect the actual agreement; existing work and notes are kept.',
          '休息日上班與更改休息日期並不相同。只按實際協議更改日期；原有工作及備註會保留。'
        ) + '</p></details>'
      : '';

    const restSubstitute = (state.config.holidays || []).find(day =>
      day.type === 'substituted_rest_day' && day.restFor === ds);
    const holidayArrangement = E.owedAlternativeHolidays(state.config, state.logs)
      .find(item => item.date === ds || item.date === cls.holiday?.altFor);
    const restWorkHint = cls.isRest
      ? '<div class="legal-status mt"><label class="row" style="cursor:pointer;font-size:14px;color:var(--text);font-weight:600"><input id="rest-voluntary" type="checkbox" style="width:auto"' + (entry.restWorkVoluntary === true ? ' checked' : '') + '><span>' + L('Any work on this rest day was voluntary', '此休息日的任何工作均屬自願') + '</span></label>' +
        (restSubstitute ? '<p>' + L('Agreed substituted rest day: ', '雙方同意補回休息日：') + '<b>' + esc(fmtDate(restSubstitute.date)) + '</b></p>' : '') +
        (cls.restTerms.restDayWorkArrangement === 'substituted_rest_day' && !state.ui.helperMode
          ? '<button class="btn secondary compact mt" id="add-rest-sub"' + (entry.work > 0 ? '' : ' hidden') + '>' +
            L('Save work and choose the agreed day off', '儲存工作並選擇已協議補假日期') + '</button>' : '') + '</div>'
      : '';

    let holidayHint = cls.holiday && (cls.holiday.type === 'statutory_holiday' || cls.holiday.officialId)
      ? '<p class="muted small mt">⚖️ ' + L(
        'If this statutory holiday was worked, save the work first, then record the actual holiday arrangement. At least 48 hours’ notice and an alternative holiday within 60 days before or after are required; an agreed substituted holiday has different rules. Extra pay cannot replace the holiday.',
        '如在此法定假日上班，請先儲存工作，再記錄實際補假安排。須提前至少48小時通知，並在前後60日內安排另定假日；雙方同意的代替假日另有規則。額外薪金不能取代假日。'
      ) + '</p>'
      : cls.holiday ? '<p class="muted small mt">' + L('This is an arranged day off, not a new statutory holiday. If it was worked, keep the work record and seek an individual review of the remaining entitlement; this app cannot automatically arrange a second replacement.', '這是已安排的補假，並非新的法定假日。如當日上班，請保留工作記錄並另行覆核尚欠的假期；本程式不能自動安排第二次補假。') + '</p>' : '';
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
      '<div class="mt">' + dayBadges(cls) + ' ' + logStatusBadge(state.logs[ds]) + '</div>' +
      '<p class="muted small mt">' + L('Choose what happened, then press Save. Nothing is recorded until you save.', '選擇當日情況後按「儲存」；儲存前不會改動記錄。') + '</p>' +
      (entry.dayTypeUnconfirmed ? '<p class="banner">' + esc(describeLogEffect(ds)) + '<br>' + L('This fact was saved before the day type was known. Check the actual situation below; changing contract settings alone does not classify it as unpaid leave.', '此情況是在當日類型未知時記錄。請在下方重新核對實際情況；只更改合約設定，不會把它當作無薪假。') + '</p>' : '') +
      '<div class="choice-list">' + choicesHtml + '</div>' +
      (E.isAbsence(entry) ? '<p class="banner">'+esc(absenceSummary(entry))+'<br>'+L('Selecting Worked and saving replaces this leave record; existing confirmed statements remain unchanged.','選擇已上班再保存會取代這筆請假事實；已確認結算仍保留。')+'</p>' : '')+
      (E.isAbsence(entry) || cls.type!=='normal' || cls.scheduleUnconfirmed ? '<button class="btn secondary mt" id="day-absence">'+(E.isAbsence(entry)?L('Check / change leave details','核對／更改請假資料'):L('Record leave / absence details','記錄請假／缺勤資料'))+'</button>' : '')+
      '<label>' + L('Note (optional)', '備註（選填）') + '</label>' +
      '<input id="day-note" placeholder="' + L('e.g. agency confirmed, doctor visit…', '例如：僱傭公司已確認、覆診……') + '" value="' + esc(entry.note || '') + '">' +
      restWorkHint +
      holidayHint +
      (holidayArrangement && !state.ui.helperMode ? '<button class="btn secondary compact mt" id="day-alt">' +
        L('View / change day-off arrangement', '查看／更改補假安排') + '</button>' : '') +
      restToggle +
      approveBtn +
      '<p id="day-error" class="form-error" role="alert" hidden></p>' +
      '<button class="btn' + (approveBtn ? ' secondary' : '') + ' mt" id="day-save">' + L('Save', '儲存') + '</button>'
    );
    let saved = false;
    const saveDay = (approve = false) => {
      const fail = message => { const error = ov.querySelector('#day-error'); error.textContent = message; error.hidden = false; };
      if (saved) return false;
      if (!approve && ![0, 0.5, 1].includes(selected)) { fail(L('Choose whether work occurred before saving.', '請先選擇當日有否上班，再儲存。')); return false; }
      if (!approve && cls.type==='normal' && !cls.scheduleUnconfirmed && selected<1) { fail(L('Open leave details and record the actual type and duration. No unpaid leave has been saved.', '請開啟請假資料，記錄實際類型及時間；沒有保存為無薪假。')); return false; }
      if (profileId !== Store.profiles.active() || helperMode !== state.ui.helperMode || original !== Legal.checksum({ config: state.config, logs: state.logs })) {
        fail(L('The helper, settings or records changed. Close and reopen this date; nothing was overwritten.', '外傭、設定或記錄已改變。請關閉並重新開啟此日期；沒有覆蓋原有資料。')); return false;
      }
      if (approve && (state.ui.helperMode || entry.status !== 'pending')) return false;
      if (approve && !E.validLogWork(entry)) { fail(L('This entry has an unsupported work value. Choose the correct situation and Save instead of approving it unchanged.', '此記錄的工作數值不受支援。請選擇正確情況再儲存，不應直接批准原值。')); return false; }
      try {
        if (approve) approveLog(ds);
        else setWork(ds, cls, selected, ov.querySelector('#day-note').value, ov.querySelector('#rest-voluntary')?.checked);
      } catch {
        fail(L('Could not save. The original record is unchanged and your choices are still here. Check storage, then retry.', '未能儲存，原有記錄沒有改動，所選內容仍保留在表格。請檢查儲存空間後重試。')); return false;
      }
      saved = true; return true;
    };
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
      if (!requireMembership()) return;
        if (ov._dirty) { const error = ov.querySelector('#day-error'); error.hidden = false; error.textContent = L('You changed this form. Use Save to record those changes, or reopen it to approve the original helper entry.', '你已更改表格。請按「儲存」記錄更改，或重新開啟以批准外傭的原記錄。'); return; }
        if (!saveDay(true)) return;
        closeSheet(ov);
        render();
        if (!openHolidayWorkNext(ds)) toast(L('Approved — ', '已批准 — ') + fmtDateShort(ds) + ' ✓');
      };
    }

    const subBtn = ov.querySelector('#add-sub-day');
    if (subBtn) {
      subBtn.onclick = () => {
      if (!requireMembership()) return;
        const fail = message => { const box = ov.querySelector('#day-error'); box.textContent = message; box.hidden = false; };
        if (saved) return;
        if (state.ui.helperMode || Store.profiles.active() !== profileId || original !== Legal.checksum({config:state.config,logs:state.logs})) { fail(L('Records changed; reopen this date.', '記錄已改變，請重新開啟此日期。')); return; }
        if (ov._dirty) { fail(L('Save your work changes first, then reopen this date to add the separate collision holiday.', '請先儲存工作更改，再重新開啟此日期，加入假日與休息日重疊的補假。')); return; }
        const sub = E.nextFreeDay(state.config, ds);
        const holidays = (state.config.holidays || []).concat({
          date: sub,
          name: 'Substitute — ' + cls.holiday.name + ' (fell on rest day)',
          type: 'rest_day_collision_holiday',
          collisionFor: ds,
          sourceEventId: cls.holiday.officialId || cls.holiday.id || ds
        });
        holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
        const next = { ...state.config, holidays };
        try { Store.saveConfig(next); state.config = next; }
        catch { fail(L('Could not save the collision holiday. Existing records are unchanged; retry when storage is available.', '未能儲存重疊補假，原有記錄未改動；請檢查儲存空間後重試。')); return; }
        saved = true;
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
        if (!saveDay()) return;
        closeSheet(ov);
        render();
        openRestSubstituteSheet(ds);
      };
    }

    ov.querySelectorAll('.choice').forEach(btn => {
      btn.onclick = () => {
        if (cls.type==='normal' && !cls.scheduleUnconfirmed && opts[+btn.dataset.i].work<1) {
          openAbsenceSheet(ds,opts[+btn.dataset.i].work===0?'full_day':'minutes',ov,ov.querySelector('#day-note').value);return;
        }
        selected = opts[+btn.dataset.i].work;
        ov.querySelectorAll('.choice').forEach((b, j) => {
          b.classList.toggle('selected', opts[j].work === selected);
          b.querySelector('.check').textContent = opts[j].work === selected ? '✓' : '';
        });
        if (restSubBtn) restSubBtn.hidden = !(selected > 0);
      };
    });
    const absenceBtn=ov.querySelector('#day-absence');
    if(absenceBtn)absenceBtn.onclick=()=>openAbsenceSheet(ds,undefined,ov,ov.querySelector('#day-note').value);

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
      if (!saveDay()) return;
      closeSheet(ov);
      render();
      if (!openHolidayWorkNext(ds)) toast(state.ui.helperMode
        ? L('Saved on this device — awaiting employer approval: ', '已儲存在此裝置，待僱主批准：') + fmtDateShort(ds)
        : L('Saved — ', '已儲存 — ') + fmtDateShort(ds));
    };
    return ov;
  }

  function openHolidayWorkNext(ds) {
    const item = E.owedAlternativeHolidays(state.config, state.logs).find(row => row.date === ds);
    if (!item) return;
    const approved = state.logs[ds]?.status === 'approved', employer = !state.ui.helperMode;
    const profileId = Store.profiles.active();
    const ov = openSheet('<h2>' + L('Holiday work saved', '已儲存假日工作') + '</h2><p class="mt">' + esc(fmtDate(ds)) + ' · ' + esc(holidayName(item.name)) + '</p><p class="mt">' +
      (!approved ? L('This record is awaiting employer approval on this device. It has not been sent to another phone. Ask the employer to review it before recording the holiday arrangement.', '此記錄在本裝置待僱主批准，並未傳送到另一部手機。請僱主先核對，再記錄補假安排。')
        : item.scheduled ? L('An arrangement is already recorded for ', '已記錄補假日期：') + esc(fmtDate(item.scheduled)) + L('. This does not confirm the holiday was taken.', '。這不代表已確認放假。')
          : L('The work is saved, but the holiday arrangement is still outstanding. Record the actual arrangement now, or return to the holiday task later. Extra pay does not complete this task.', '工作已保存，但補假安排仍未完成。可現在記錄實際安排，或稍後從補假待辦繼續；額外薪金不代表已完成。')) + '</p>' +
      '<p class="muted small mt">' + L('Closing the next form keeps this work record. No holiday date or notice is filled in for you.', '關閉下一個表格不會刪除這筆工作記錄，系統不會替你填寫補假或通知日期。') + '</p>' +
      (approved && employer ? '<button class="btn mt" id="holiday-next-arrange">' + (item.scheduled ? L('View / change holiday arrangement', '查看／更改補假安排') : L('Record holiday arrangement', '記錄補假安排')) + '</button>' : '') +
      '<button class="btn ghost mt" id="holiday-next-later">' + L('Done for now — keep work saved', '暫時完成，保留工作記錄') + '</button>');
    ov.querySelector('#holiday-next-later').onclick = () => closeSheet(ov);
    const arrange = ov.querySelector('#holiday-next-arrange');
    if (arrange) arrange.onclick = () => {
      if (Store.profiles.active() !== profileId) { toast(L('Helper changed; reopen the recorded date.', '外傭已切換，請重新開啟記錄日期。')); return; }
      const current = E.owedAlternativeHolidays(state.config, state.logs).find(row => row.date === ds);
      if (!current || state.logs[ds]?.status !== 'approved' || state.ui.helperMode) { toast(L('Work record changed; review the recorded date first.', '工作記錄已改變，請先核對該日期。')); return; }
      closeSheet(ov); openScheduleAltSheet(current);
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
    ov.querySelector('#rest-sub-agreed').onchange = () => ov.querySelector('#rest-sub-agreed').removeAttribute('aria-invalid');
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
      const restAgreed = ov.querySelector('#rest-sub-agreed');
      if (!restAgreed.checked) {
        fail(L('Confirm the actual agreement before saving.', '請先確認雙方確已同意此日期。'));
        restAgreed.setAttribute('aria-invalid', 'true'); restAgreed.focus(); return;
      }
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
  function monthPayments(key) { return state.payments.filter(p => PaymentLedger.related(p, key)); }
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
    delete old.recordReview; // A dated employer attestation, not a changing calculation input.
    return Legal.checksum(old) !== Legal.checksum(statementInputs(stmt, profile)) ||
      snapshot.modelVersion !== Legal.MODEL_VERSION || snapshot.legalSourceVersion !== Legal.LEGAL_SOURCE_VERSION ||
      snapshot.holidayCalendarVersion !== Compliance.HOLIDAY_CALENDAR_VERSION;
  }

  function calculationIssueAction(issue) {
    const record = issue.code.match(/^holiday_record_(\d+)_/);
    if (record) return { type: 'holiday', index: +record[1] };
    if (issue.code === 'rest_weekday') return { type: 'guided', guide: 'rest_weekday' };
    const fields = { contract_type: '#st-contract-type', contract_signed_on: '#st-signed', contract_start: '#st-start',
      contract_end: '#st-contract-end', below_maw: '#st-confirm-terms', below_food_allowance: '#st-confirm-terms', food_term: '#st-confirm-terms',
      rest_day_pay: '#st-rest-history', rest_day_work_term: '#st-rest-history', rest_history_missing: '#st-rest-history', first_three_months: '#st-early-holiday',
      winter_choice: '#st-winter', effective_terms: '#st-confirm-terms', active_wage_period: '#st-confirm-terms', pay_history_missing: '#st-confirm-terms' };
    const external = ['partial_month', 'absence_calculation', 'absence_average_history', 'unpaid_early_holiday', 'unpaid_rest_day', 'rate_not_audited', 'intra_month_pay_change', 'variable_wage_average'];
    if (external.includes(issue.code) || /^holiday_calendar_(?!2026$|2027$)/.test(issue.code)) return { type: 'external' };
    if (issue.code.startsWith('rest_work_amount_')) return { type: 'field', selector: '#st-rest-history' };
    if (fields[issue.code]) return { type: 'field', selector: fields[issue.code] };
    if (issue.code.startsWith('holiday_calendar_')) return { type: 'field', selector: '#st-hol-review' };
    const date = issue.code.match(/\d{4}-\d{2}-\d{2}$/)?.[0];
    if (date) return { type: 'date', date };
    return { type: 'view', view: issue.section === 'salary' ? 'salary' : issue.section || 'settings' };
  }

  function calculationChecklistHtml(assessment) {
    return '<div class="legal-status blocked mt"><b>' + L('Before confirming: ', '確認結算前：') + assessment.blockers.length +
      L(assessment.blockers.length === 1 ? ' item to review' : ' items to review', '項需要處理') + '</b><p>' + L('Missing details can be corrected here. Unsupported calculations need a separate check; changing unrelated settings will not unlock them.',
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
      else if (action.type === 'guided' && action.guide === 'rest_weekday') { openQuickRestDaySheet(); }
      else if (action.type === 'field') {
        state.ui.view = 'settings'; saveUi(); render();
        const editor = ['people','contract','holiday','security'].find(section => settingsFields(section).some(row => '#' + row.id === action.selector));
        if (editor) { openSettingsEditor(editor, action.selector); return; }
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
    const rest = E.classifyDay(stmt.periodStart, config).restTerms;
    const restWindow = PayHistory.restWindow(config,
      config.startDate > E.addDays(stmt.periodStart, -6) ? config.startDate : E.addDays(stmt.periodStart, -6), stmt.periodEnd);
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
        restDayWeekday: rest.restDayWeekday,
        restDayPayTerm: rest.restDayPayTerm,
        restDayWorkArrangement: rest.restDayWorkArrangement,
        restDayWorkPayment: rest.restDayWorkPayment || 0,
        // Uniform terms keep the old snapshot shape. Split periods are clipped
        // to the calculation window, so an unrelated future change does not
        // reopen an unchanged historical statement. No saved snapshot is edited.
        ...(config.restTerms && (restWindow.issue || restWindow.periods.length > 1)
          ? { restTerms: restWindow.periods, restTermsVersion: 1, restTermsIssue: restWindow.issue } : {}),
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
    const paymentReview = PaymentLedger.summary(profile.payments, stmt.key, asOf);
    const payments = paymentReview.effective;
    const validPayments = !paymentReview.invalid.length && !paymentReview.pending.length;
    const facts = payments.map(p => ({ id: p.id, amount: p.amount, date: p.date,
      recorded: ['paid', 'approved'].includes(p.status), method: p.method, statementId: p.statementId || null }));
    const paid = paymentReview.paid;
    const snapshots = profile.statements.filter(s => s.inputs?.monthKey === stmt.key);
    const latest = snapshots.at(-1);
    const inputChecksum = Legal.checksum({ inputs: statementInputs(stmt, profile), payments: facts,
      statementId: latest?.statementId || null, model: Legal.MODEL_VERSION, legalSource: Legal.LEGAL_SOURCE_VERSION,
      calendar: Compliance.HOLIDAY_CALENDAR_VERSION });
    const pending = Object.entries(profile.logs).some(([day, log]) => day >= stmt.periodStart && day <= stmt.periodEnd && log.status === 'pending');
    const workReview = monthRecordStatus(stmt, profile, asOf);
    const base = { complete: false, state: 'unreviewed', paid, inputChecksum, validPayments, pending, workReview, periodEnd: stmt.periodEnd };
    if (paymentReview.needsReview) return { ...base, state:'payment_check' };
    if (stmt.periodEnd > asOf) return { ...base, state: 'period_open' };
    if (!validPayments || pending) return { ...base, state: pending ? 'pending' : 'payment_check' };
    if (!workReview.ready) return { ...base, state: 'work_unreviewed' };
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
      if (!current.workReview.ready) { fail(L('Review this month’s missing or invalid work records first. Return to Salary → Check work records.', '請先核對本月漏記或無效的工作記錄。返回「薪金」→「核對工作記錄」。')); return; }
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

  // Completeness is separate from the legal calculation gate. A default day
  // off is an estimate until explicitly recorded; a future day cannot be done.
  function monthRecordStatus(stmt, profile = state, asOf = E.todayStr()) {
    const result = { ready: false, periodOpen: false, missing: [], pending: [], invalid: [], future: [], required: [], normalDefaults: [] };
    if (!stmt || stmt.historicalOnly || !validRecordDate(asOf) || !validRecordDate(stmt.periodStart) ||
        !validRecordDate(stmt.periodEnd) || stmt.periodStart > stmt.periodEnd || E.addDays(stmt.periodStart, 31) <= stmt.periodEnd) return result;
    result.periodOpen = stmt.periodEnd > asOf;
    for (let day = stmt.periodStart, count = 0; day <= stmt.periodEnd && count < 32; day = E.addDays(day, 1), count++) {
      if (!E.isEmployedOn(day, profile.config)) continue;
      const cls = E.classifyDay(day, profile.config), entry = profile.logs[day];
      const required = cls.isRest || !!cls.holiday;
      if (required) result.required.push(day);
      if (day > asOf) { result.future.push(day); continue; }
      if (entry && entry.status === 'pending') result.pending.push(day);
      else if (entry && (!['approved'].includes(entry.status) || !E.validLogWork(entry))) result.invalid.push(day);
      else if (required && !entry) result.missing.push(day);
      else if (!entry) result.normalDefaults.push(day);
    }
    result.ready = !result.periodOpen && !result.missing.length && !result.pending.length && !result.invalid.length;
    return result;
  }

  function monthRecordSummaryHtml(review) {
    return '<p>' + L('Unconfirmed rest/holiday dates: ', '未確認休息／假日：') + review.missing.length +
      L(' · Awaiting employer review: ', ' · 待僱主核對：') + review.pending.length +
      (review.invalid.length ? L(' · Invalid records: ', ' · 記錄須修正：') + review.invalid.length : '') + '</p>' +
      (review.periodOpen ? '<p>' + L('This wage period is not over. ', '此工資期尚未完結。') + review.future.length +
        L(' future dates remain estimates, even if an arrangement has been entered. Only an estimate draft can be saved now.', '個未到日期仍屬預估，即使已輸入安排亦一樣。目前只能保存預估草稿。') +
        (review.future.length ? ' (' + esc(fmtDateShort(review.future[0])) + '–' + esc(fmtDateShort(review.future.at(-1))) + ')' : '') + '</p>' : '') +
      '<p class="small muted">' + L('Normal working days without exceptions use the contract default. Review leave and other exceptions before confirming; this is not automatic proof of attendance.',
        '沒有例外記錄的一般工作日按合約預設計算。確認前須核對請假及其他例外，這並非自動核實出勤。') + '</p>';
  }

  function openMonthRecords(stmt) {
    const review = monthRecordStatus(stmt), profileAtOpen = Store.profiles.active();
    const before = Legal.checksum(statementInputs(stmt)), dates = [...new Set([...review.missing, ...review.pending, ...review.invalid])].sort();
    const ov = openSheet('<h2>' + L('Check this month’s work records', '核對本月工作記錄') + '</h2><p>' + esc(monthLabel(stmt.key)) + '</p>' +
      monthRecordSummaryHtml(review) + (dates.length ? '<ul class="issue-list">' + dates.map(day => {
        const cls = E.classifyDay(day, state.config);
        return '<li><p>' + esc(fmtDate(day)) + ' · ' + esc(dayTypeName(cls)) + ' · ' +
          (review.pending.includes(day) ? L('Awaiting employer review', '待僱主核對') : review.invalid.includes(day) ? L('Check this record', '須修正記錄') : L('Not recorded', '尚未記錄')) + '</p>' +
          '<button class="btn secondary compact" data-review-day="' + day + '">' + L('Review this date', '核對此日期') + '</button></li>';
      }).join('') + '</ul>' : '<p>' + L('No past rest or holiday dates are missing.', '沒有漏記的過往休息／假日。') + '</p>') +
      (!state.ui.helperMode && review.missing.length ? '<details class="mt"><summary>' + L('All unrecorded dates above were taken off?', '上方尚未記錄的日子全部已休息？') + '</summary>' +
        '<p>' + L('Only these dates will be recorded as full days off: ', '只會將以下日期記為全日休息：') + review.missing.map(fmtDateShort).join('、') + '</p>' +
        '<label class="row review-confirm"><input type="checkbox" id="month-days-off-confirm"><span>' + L('I checked each date listed here: no work was done on any of them. Existing and pending records will not be changed.',
          '我已逐一核對以上日期，當日全部沒有工作。不會更改已有或待批准記錄。') + '</span></label>' +
        '<button class="btn mt" id="month-days-off-save">' + L('Record these confirmed days off', '記錄以上已確認休息日') + '</button></details>' : '') +
      '<p id="month-days-error" class="form-error" role="alert" hidden></p><button class="btn ghost mt" id="month-days-close">' + L('Back to salary', '返回薪金') + '</button>');
    ov.querySelector('#month-days-close').onclick = () => closeSheet(ov);
    ov.querySelectorAll('[data-review-day]').forEach(button => button.onclick = () => {
      closeSheet(ov); state.ui.view = 'salary'; state.salY = stmt.year; state.salM = stmt.month; saveUi(); render(); openDaySheet(button.dataset.reviewDay);
    });
    const bulk = ov.querySelector('#month-days-off-save');
    const offConfirmation = ov.querySelector('#month-days-off-confirm');
    if (offConfirmation) offConfirmation.onchange = () => {
      ov.querySelector('#month-days-error').hidden = true;
      offConfirmation.removeAttribute('aria-invalid');
    };
    if (bulk) bulk.onclick = () => {
      if (!requireMembership()) return;
      const fail = text => { const error = ov.querySelector('#month-days-error'); error.hidden = false; error.textContent = text; };
      if (state.ui.helperMode || Store.profiles.active() !== profileAtOpen || Legal.checksum(statementInputs(stmt)) !== before ||
          Legal.checksum(monthRecordStatus(stmt).missing) !== Legal.checksum(review.missing)) { fail(L('Records or date changed. Close and review again.', '記錄或日期已改變，請關閉並重新核對。')); return; }
      const confirmation = ov.querySelector('#month-days-off-confirm');
      if (!confirmation.checked) {
        fail(L('Check each listed date and confirm only if no work was done.', '請逐一核對所列日期，只有全部沒有工作才確認。'));
        // The confirmation sits under the date list and is usually off-screen
        // when this fails, so name the problem AND go to the control that
        // fixes it, the way the contract form already does.
        confirmation.setAttribute('aria-invalid', 'true');
        confirmation.focus();
        return;
      }
      const logs = { ...state.logs }, at = new Date().toISOString();
      review.missing.forEach(day => { logs[day] = { work: 0, status: 'approved', by: 'employer', note: '', recordedAt: at, source: 'explicit-month-days-off-review' }; });
      try { Store.saveLogs(logs); state.logs = logs; closeSheet(ov); render(); toast(L('Confirmed days off recorded. Review the remaining items before confirming salary.', '已記錄確認休息的日期，請核對餘下項目才確認薪金。')); }
      catch { fail(L('No days were saved. Your existing records are unchanged; keep this form and retry.', '休息日未能儲存，原有記錄未改動；請保留表格重試。')); }
    };
  }

  function saveEstimateDraft(stmt) {
    if (state.config.estimateDrafts !== undefined && !Array.isArray(state.config.estimateDrafts)) throw new Error('invalid_estimate_history');
    if (state.ui.helperMode || !Compliance.assessMonth({ statement: stmt, config: state.config, logs: state.logs,
      adjustments: monthAdjustments(stmt.key), engine: E }).ready) throw new Error('Estimate is not available');
    const inputs = JSON.parse(JSON.stringify(statementInputs(stmt)));
    const items = Compliance.acceptedMoneyItems(stmt, state.config, monthAdjustments(stmt.key));
    const draft = { id: 'estimate-' + uid(), status: 'estimate_only', monthKey: stmt.key, savedAt: new Date().toISOString(), asOf: E.todayStr(),
      inputs, inputChecksum: Legal.checksum(inputs), projectedTotal: Legal.calculateStatementTotals(items).projected.total,
      recordStatus: monthRecordStatus(stmt), modelVersion: Legal.MODEL_VERSION, legalSourceVersion: Legal.LEGAL_SOURCE_VERSION };
    const config = { ...state.config, estimateDrafts: [...(state.config.estimateDrafts || []), draft] };
    Store.saveConfig(config); state.config = config;
    return draft;
  }

  function freezeStatement(stmt, revisionReason, recordsConfirmed = false) {
    const review = monthRecordStatus(stmt);
    const assessment = Compliance.assessMonth({ statement: stmt, config: state.config, logs: state.logs, adjustments: monthAdjustments(stmt.key), engine: E });
    if (!review.ready || !assessment.ready || !recordsConfirmed || state.ui.helperMode) throw new Error('Work records must be reviewed before finalizing');
    const inputs = statementInputs(stmt);
    inputs.recordReview = { version: 1, reviewedOn: E.todayStr(), employerConfirmed: true, requiredDates: review.required, normalDefaultDates: review.normalDefaults };
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
    const profileAtOpen = Store.profiles.active(), workReview = monthRecordStatus(stmt);
    const draftsAtOpen = Legal.checksum(state.config.estimateDrafts || []);
    const inputsAtOpen = Legal.checksum(statementInputs(stmt));
    const items = Compliance.acceptedMoneyItems(stmt, state.config, monthAdjustments(stmt.key));
    const preview = { items, totals: Legal.calculateStatementTotals(items) };
    const total = preview.totals.finalized.total;
    const ov = openSheet('<h2>' + L('Review this month’s statement', '預覽本月結算') + '</h2>' +
      '<p class="muted mt">' + esc(monthYear(stmt.year, stmt.month)) + '</p>' + confirmedMoneyHtml(preview) +
      '<div class="stmt-total' + (!workReview.ready ? ' provisional' : '') + '"><span>' + (workReview.ready ? L('Total to confirm', '待確認總額') : L('Estimate only — not confirmed', '只供預估 — 尚未確認')) + '</span><span>' + money(total) + '</span></div>' +
      monthRecordSummaryHtml(workReview) +
      (!workReview.ready ? '<button class="btn secondary mt" id="statement-work-review">' + L('Check work records', '核對工作記錄') + '</button>' : '') +
      (previous ? '<p class="mt">' + L('Previously confirmed: ', '上個已確認版本：') + money(previous.totals.finalized.total) +
        '<br>' + L('Revision difference: ', '本次修訂差額：') + money(total - previous.totals.finalized.total) +
        '</p><label for="statement-reason">' + L('Reason for revision (required)', '修訂原因（必填）') +
        '</label><input id="statement-reason" maxlength="500" required>' : '') +
      '<p class="mt">' + L('Confirming saves a permanent version. Later corrections create a revision; existing statements and payment records stay unchanged. No money is transferred.',
        '確認後會保存此結算版本。日後更正須建立修訂版，原結算及付款記錄會保留。此操作不會轉帳。') + '</p>' +
      (workReview.ready ? '<label class="row review-confirm"><input id="statement-records-confirmed" type="checkbox"><span>' + L('I have checked this wage period’s work, leave and other payment items; there are no omitted exceptions to the normal working-day defaults.',
        '我已核對此工資期的工作、請假及其他款項；按一般工作日預設計算的日子沒有漏記例外情況。') + '</span></label>' : '') +
      '<p id="statement-error" role="alert" class="form-error" hidden></p>' +
      '<button class="btn mt" id="statement-confirm"' + (!workReview.ready ? ' disabled' : '') + '>' + (workReview.ready ? L('Confirm statement and enter payment', '確認結算並填寫付款') : L('Not ready to confirm yet', '暫未可確認結算')) + '</button>' +
      '<button class="btn' + (workReview.ready ? ' secondary' : '') + ' mt" id="statement-draft-save">' + L('Save estimate draft only', '只保存預估草稿') + '</button>' +
      '<p class="muted small">' + L('An estimate draft is not a confirmed statement or payment. It is saved separately; existing work records remain saved if you close this preview.',
        '預估草稿不是已確認結算或付款，會另行保存；關閉預覽不會刪除已保存的工作記錄。') + '</p>' +
      '<button class="btn ghost mt" id="statement-cancel">' + L('Close without saving this preview', '關閉 — 不保存此預覽') + '</button>');
    ov.querySelector('#statement-cancel').onclick = () => closeSheet(ov);
    const recordConfirmation = ov.querySelector('#statement-records-confirmed');
    if (recordConfirmation) recordConfirmation.onchange = () => {
      ov.querySelector('#statement-error').hidden = true;
      recordConfirmation.removeAttribute('aria-invalid');
    };
    const recordsBtn = ov.querySelector('#statement-work-review');
    if (recordsBtn) recordsBtn.onclick = () => { closeSheet(ov); openMonthRecords(stmt); };
    ov.querySelector('#statement-draft-save').onclick = () => {
      if (!requireMembership()) return;
      const fail = text => { const error = ov.querySelector('#statement-error'); error.hidden = false; error.textContent = text; };
      if (state.ui.helperMode || Store.profiles.active() !== profileAtOpen || Legal.checksum(state.config.estimateDrafts || []) !== draftsAtOpen ||
          Legal.checksum(statementInputs(stmt)) !== inputsAtOpen) { fail(L('Records changed or this draft was already saved. Close and review again.', '記錄已改變，或此草稿已保存；請關閉並重新預覽。')); return; }
      try { saveEstimateDraft(stmt); closeSheet(ov); render(); toast(L('Estimate draft saved — no statement confirmed and no payment recorded.', '已保存預估草稿，未確認結算或記錄付款。')); }
      catch (error) { fail(error.message === 'invalid_estimate_history'
        ? L('Saved draft history could not be read. Keep a backup and contact support; existing data has not been replaced.', '未能讀取已有草稿歷史。請保留備份並聯絡支援；原有資料未被取代。')
        : L('Draft was not saved. Keep this form and retry.', '草稿未能保存，請保留表格重試。')); }
    };
    ov.querySelector('#statement-confirm').onclick = () => {
      if (!requireMembership()) return;
      const error = ov.querySelector('#statement-error');
      const fail = message => { error.textContent = message; error.hidden = false; };
      if (state.ui.helperMode || Store.profiles.active() !== profileAtOpen) { fail(L('Only the employer can confirm this helper’s statement. Close and reopen it if the profile changed.', '只可由僱主確認此位外傭的結算；如已切換檔案，請關閉再重新開啟。')); return; }
      const fresh = E.computeMonth(stmt.year, stmt.month, state.config, state.logs);
      const check = fresh && Compliance.assessMonth({ statement: fresh, config: state.config, logs: state.logs,
        adjustments: monthAdjustments(stmt.key), engine: E });
      if (!check || !check.ready || Legal.checksum(statementInputs(fresh)) !== inputsAtOpen ||
          (latestStatement(stmt.key)?.statementId || null) !== (previous?.statementId || null)) {
        fail(L('Records changed. Cancel and review the latest statement before confirming.', '記錄已改變，請取消並重新預覽最新結算。')); return;
      }
      if (!monthRecordStatus(fresh).ready) { fail(L('This period is still open or work records remain unchecked. Save an estimate draft or review the listed dates first.', '工資期尚未完結，或工作記錄未核對完整。請保存預估草稿，或先核對所列日期。')); return; }
      const recordsConfirmed = ov.querySelector('#statement-records-confirmed');
      if (!recordsConfirmed?.checked) {
        fail(L('Confirm that you checked this period’s work, leave and other items.', '請確認已核對本期工作、請假及其他款項。'));
        recordsConfirmed?.setAttribute('aria-invalid', 'true');
        recordsConfirmed?.focus();
        return;
      }
      const reason = ov.querySelector('#statement-reason')?.value.trim() || '';
      if (previous && !reason) { fail(L('Enter the reason for this revision.', '請填寫本次修訂原因。')); ov.querySelector('#statement-reason').focus(); return; }
      try {
        const snapshot = freezeStatement(fresh, reason, true);
        closeSheet(ov); render(); openPaymentSheet(fresh, snapshot);
      } catch { fail(L('The statement was not saved. Keep this form open and retry.', '結算未能儲存，請保留此表格並重試。')); }
    };
  }

  function monthPaid(key) {
    return PaymentLedger.summary(state.payments, key, E.todayStr()).paid;
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
    const existing = state.payments.some(item => item.id === payment.id);
    const profileAtOpen = Store.profiles.active(), originalChecksum = Legal.checksum(payment);
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
      if (existing) {
        const latest = state.payments.find(item => item.id === payment.id);
        if (!latest || Store.profiles.active() !== profileAtOpen || Legal.checksum(latest) !== originalChecksum || state.ui.helperMode ||
            (window.HSBilling && !window.HSBilling.request('record', { helperMode: state.ui.helperMode }))) throw new Error('Payment changed during attachment');
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
    const reviewPending = PaymentLedger.summary(state.payments, stmt.key, E.todayStr()).needsReview;
    const additional = !!snapshot && (balance <= 0 || reviewPending);
    const ov = openSheet(
      '<h2>' + L('Record payment — ', '記錄付款 — ') + monthYear(stmt.year, stmt.month) + '</h2>' +
      '<label>' + L('Amount (HK$)', '金額（港幣）') + '</label>' +
      '<input id="pay-amount" type="number" step="0.01" inputmode="decimal" value="' + (snapshot && !additional ? E.round2(balance) : '') + '">' +
      (additional ? '<p class="banner">' + L('A payment is already recorded, or its correction needs review. Only enter another payment you actually made. To fix an error, cancel and use “Record incorrect?” on that payment.',
        '已有付款記錄，或有更正待核對。只可在此另記一筆確實已付出的款項；如要改錯，請取消並在原付款選擇「記錄有誤？」。') + '</p>' : '') +
      (!snapshot ? '<div class="banner mt">' + L('Externally calculated payment only. HelperPay has not verified the calculation or entitlements. Enter the actual amount paid, not the reference estimate.',
        '只記錄另行核算的付款。HelperPay 未驗證此計算或權益。請輸入實際已付金額，不要直接採用參考估算。') + '</div><label for="pay-basis">' +
        L('External calculation reference / note (required)', '外部核算依據／備註（必填）') + '</label><input id="pay-basis" required maxlength="500">' : '') +
      '<label>' + L('Payment date', '付款日期') + '</label>' +
      '<input id="pay-date" type="date" value="' + E.todayStr() + '">' +
      '<label>' + L('Method', '付款方式') + '</label>' +
      '<select id="pay-method">' +
      ['FPS', 'Bank transfer', 'Cash', 'Cheque', 'Other'].map(method =>
        '<option value="' + method + '">' + esc(I18n.paymentMethod(method, state.ui.language)) + '</option>').join('') + '</select>' +
      '<label>' + (additional ? L('Reason for this additional payment (required)', '另付這筆款項的原因（必填）') : L('Note (optional)', '備註（選填）')) + '</label>' +
      '<input id="pay-note" placeholder="' + L('e.g. remaining salary transferred separately', '例如：餘下薪金另行轉帳') + '">' +
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
      if (additional && !ov.querySelector('#pay-note').value.trim()) { fail(L('Explain the additional payment, or cancel to correct an existing record.', '請說明另付此款項的原因，或取消並更正原有記錄。')); return; }
      const amount = Number(ov.querySelector('#pay-amount').value);
      if (!(amount > 0) || !Number.isFinite(amount) || E.round2(amount) !== amount) { fail(L('Enter a payment amount greater than zero, with at most two decimal places.', '請輸入大於零的實際付款金額，最多兩位小數。')); return; }
      const paymentDate = ov.querySelector('#pay-date').value;
      if (!validRecordDate(paymentDate) || paymentDate > E.todayStr()) { fail(L('Enter a valid actual payment date, not a future date.', '請輸入有效的實際付款日期，不可填未來日期。')); return; }
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
        : 'Payment recorded — ask ' + (state.config.helperName || 'helper') + ' to confirm receipt');
      render();
    };
  }

  function paymentFactsHtml(payment, language = state.ui.language) {
    const L = (en, zh) => language === 'zh-HK' ? zh : en;
    if (!payment) return '<p>' + L('Voided record — not counted as a payment. This is not a refund or a wage deduction.', '已作廢記錄，不計作付款；這並非退款或扣薪。') + '</p>';
    return '<p><b>' + money(payment.amount) + '</b><br>' + esc(I18n.monthYear(+payment.monthKey.slice(0,4), +payment.monthKey.slice(5), language)) + ' · ' + esc(I18n.formatDate(payment.date, language)) + ' · ' +
      esc(I18n.paymentMethod(payment.method, language)) + (payment.note ? '<br>' + esc(payment.note) : '') + '</p>' +
      (payment.approval ? '<p class="small muted">' + L('Helper receipt acknowledged by ', '外傭收款確認：') + esc(payment.approval.name) + ' · ' + esc(payment.approval.at) + '</p>' : '');
  }

  function paymentHistoryHtml(payment) {
    if (!Array.isArray(payment.paymentEvents) || !payment.paymentEvents.length) return '';
    return '<details class="mt"><summary>' + L('Original record and correction history', '原記錄及更正歷史') + '</summary><h3>' + L('Original payment — retained', '原付款記錄 — 保留') + '</h3>' +
      paymentFactsHtml(payment) + payment.paymentEvents.filter(event => event && typeof event === 'object').map(event => '<section class="card"><p>' + esc(event.at) + '</p>' +
        (event.type === 'correction' ? '<b>' + (event.action === 'void' ? L('Void request', '作廢記錄') : L('Correction', '更正記錄')) + '</b><p>' + esc(event.reason) + '</p>' + paymentFactsHtml(event.after) :
          '<p>' + (event.type === 'receipt' ? L('Helper acknowledged receipt', '外傭已確認收款') : event.action === 'accept' ? L('Helper accepted correction', '外傭已確認更正') :
            event.action === 'reject' ? L('Helper did not accept correction', '外傭未接受更正') : L('Employer withdrew correction; prior record retained', '僱主已撤回更正，保留先前記錄')) +
          (event.name ? ' · ' + esc(event.name) : '') + '</p>') + '</section>').join('') + '</details>';
  }

  function paymentCardHtml(payment, monthKey) {
    const view = PaymentLedger.read(payment), effective = view.effective;
    let html = '<div class="payment-item" data-payment="' + esc(payment.id) + '">';
    if (view.issue) html += '<p class="form-error">' + L('Payment history could not be verified. No balance or settlement should be inferred. Keep a backup and contact support.',
      '未能核對付款歷史，不可據此判斷餘額或已付清。請保留備份並聯絡支援。') + '</p>' + paymentFactsHtml(payment);
    else {
      html += paymentFactsHtml(effective);
      if (effective && effective.monthKey !== monthKey) html += '<p class="banner">' + L('Now allocated to ', '目前歸入 ') + esc(monthLabel(effective.monthKey)) + L('; not counted in this month.', '，不計入此月份。') + '</p>';
      if (view.pending) html += '<div class="banner"><b>' + (view.pending.rejected ? L('Correction not accepted — needs discussion', '更正未獲接受 — 須雙方核對') : L('Correction awaiting helper review', '更正待外傭核對')) + '</b><p>' +
        esc(view.pending.reason) + '</p>' + paymentFactsHtml(view.pending.after) + '<p>' + L('The prior payment still applies until this correction is accepted. This month is not marked complete while it is unresolved.',
        '此更正獲接受前，仍保留先前付款數額；未解決前不會將本月標為完成。') + '</p></div>';
      else if (effective) html += '<span class="badge ' + (effective.status === 'approved' ? 'approved' : 'pending') + '">' +
        (effective.status === 'approved' ? L('Helper acknowledged receipt', '外傭已確認收到') : L('Payment recorded · awaiting helper receipt', '僱主已記錄付款 · 待外傭確認收到')) + '</span>';
      if (effective?.statementId) html += '<p class="small muted">' + L('Statement reference: ', '結算編號：') + esc(effective.statementId) + '</p>';
      else if (effective?.calculationBasis === 'external') html += '<p class="small muted">' + L('External calculation — not verified by HelperPay: ', '外部核算 — 未經 HelperPay 驗證：') + esc(effective.externalCalculationNote) + '</p>';
      else if (effective) html += '<p class="small muted">' + L('Legacy payment record; no linked calculation version.', '舊版付款記錄，未連結計算版本。') + '</p>';
    }
    html += paymentHistoryHtml(payment) + '<div class="thumbs" data-thumbs="' + esc(payment.id) + '"></div><div class="row mt wrap">';
    if (!view.issue && view.pending && !view.pending.rejected) html += '<button class="btn blue compact grow" data-payment-review="' + esc(payment.id) + '">' + L('Ask helper to review correction', '請外傭核對更正') + '</button>';
    if (!view.issue && !view.pending && effective?.status === 'paid') html += '<button class="btn blue compact grow" data-approve="' + esc(payment.id) + '">' + L('Helper confirms receipt', '外傭確認收款') + '</button>';
    if (!state.ui.helperMode) {
      html += '<button class="btn ghost compact" data-addphoto="' + esc(payment.id) + '">' + L('+ Photo', '+ 相片') + '</button>';
      if (!view.issue) html += '<button class="btn ghost compact" ' + (view.pending ? 'data-payment-withdraw' : 'data-payment-correct') + '="' + esc(payment.id) + '">' +
        (view.pending ? L('Withdraw correction', '撤回更正') : L('Record incorrect?', '記錄有誤？')) + '</button>';
    }
    return html + '</div></div>';
  }

  function openPaymentCorrection(paymentId) {
      if (!requireMembership()) return;
    if (state.ui.helperMode) return;
    const payment = state.payments.find(p=>p.id===paymentId), current=payment && PaymentLedger.read(payment);
    if (!current || current.issue || current.pending) return;
    const profileAtOpen=Store.profiles.active(), originalChecksum=Legal.checksum(payment), fields=current.effective || PaymentLedger.facts(payment);
    let preview=null;
    const ov=openSheet('<h2>' + L('Correct a payment record', '更正付款記錄') + '</h2><h3>' + L('Current record', '目前記錄') + '</h3>' + paymentFactsHtml(current.effective) +
      '<p>' + L('Use this for input mistakes, not refunds, wage deductions or new transfers. The original record, photos and receipt acknowledgement remain in history.',
        '只用於更正誤記，不作退款、扣薪或新轉帳。原付款、相片及收款確認會保留在歷史內。') + '</p>' +
      '<label for="pc-action">' + L('What needs correcting?', '需要怎樣更正？') + '</label><select id="pc-action"><option value="replace">' + L('Correct amount, date, method or salary month', '更正金額、日期、方式或薪金月份') + '</option>' +
      (current.effective ? '<option value="void">' + L('Void a duplicate / payment that did not happen', '作廢重複／實際未發生的付款記錄') + '</option>' : '') + '</select>' +
      '<div id="pc-fields"><label for="pc-amount">' + L('Actual amount paid (HK$)', '實際已付金額（港幣）') + '</label><input id="pc-amount" type="number" inputmode="decimal" step="0.01" value="' + fields.amount + '">' +
      '<label for="pc-date">' + L('Actual payment date', '實際付款日期') + '</label><input id="pc-date" type="date" value="' + esc(fields.date) + '" max="' + E.todayStr() + '">' +
      '<label for="pc-month">' + L('Salary month this payment covers', '此付款所屬薪金月份') + '</label><input id="pc-month" type="month" value="' + esc(fields.monthKey) + '">' +
      '<label for="pc-method">' + L('Payment method', '付款方式') + '</label><select id="pc-method">' + ['FPS','Bank transfer','Cash','Cheque','Other'].map(method=>'<option value="' + method + '"' + (fields.method===method?' selected':'') + '>' + esc(I18n.paymentMethod(method,state.ui.language)) + '</option>').join('') + '</select>' +
      '<label for="pc-note">' + L('Corrected note (optional)', '更正後備註（選填）') + '</label><textarea id="pc-note">' + esc(fields.note) + '</textarea></div>' +
      '<label for="pc-reason">' + L('Why was the original record wrong? (required)', '原記錄有誤的原因（必填）') + '</label><textarea id="pc-reason" maxlength="1000"></textarea>' +
      '<p id="pc-error" role="alert" class="form-error" hidden></p><button class="btn mt" id="pc-preview">' + L('Preview correction', '預覽更正') + '</button>' +
      '<div id="pc-review" aria-live="polite"></div><button class="btn mt" id="pc-save" hidden>' + L('Save correction record', '保存更正記錄') + '</button><button class="btn ghost mt" id="pc-cancel">' + L('Cancel', '取消') + '</button>');
    const invalidate=()=>{preview=null;ov.querySelector('#pc-save').hidden=true;ov.querySelector('#pc-review').innerHTML='';};
    ov.addEventListener('input',invalidate);ov.addEventListener('change',invalidate);
    ov.querySelector('#pc-action').onchange=()=>{ov.querySelector('#pc-fields').hidden=ov.querySelector('#pc-action').value==='void';};
    const fail=text=>{const box=ov.querySelector('#pc-error');box.textContent=text;box.hidden=false;};
    ov.querySelector('#pc-preview').onclick=()=>{
      invalidate();
      const result=PaymentLedger.propose(payment,{action:ov.querySelector('#pc-action').value,amount:ov.querySelector('#pc-amount').value,date:ov.querySelector('#pc-date').value,
        monthKey:ov.querySelector('#pc-month').value,method:ov.querySelector('#pc-method').value,note:ov.querySelector('#pc-note').value,reason:ov.querySelector('#pc-reason').value},
        {id:uid(),at:new Date().toISOString(),asOf:E.todayStr()});
      if(result.errors.length){const messages={reason:L('Enter why the original record was wrong.', '請填寫原記錄有誤的原因。'),amount:L('Enter a positive actual amount with at most two decimal places.', '請輸入正數實際金額，最多兩位小數。'),date:L('Enter a valid actual payment date, not a future date.', '請填寫有效的實際付款日期，不可填未來日期。'),month:L('Choose a valid salary month.', '請選擇有效薪金月份。'),unchanged:L('No payment details changed. Cancel if the current record is correct.', '付款資料沒有改變，如原記錄正確請取消。')};fail(messages[result.errors[0]] || L('Review the payment details before continuing.', '請核對付款資料再繼續。'));return;}
      preview=result.next;ov.querySelector('#pc-error').hidden=true;
      const view=PaymentLedger.read(preview), proposed=preview.paymentEvents.at(-1);
      ov.querySelector('#pc-review').innerHTML='<h3 class="mt">' + L('Proposed record', '更正後記錄') + '</h3>' + paymentFactsHtml(proposed.after) + '<p>' + esc(proposed.reason) + '</p><p class="banner">' +
        (view.pending ? L('The helper has already acknowledged the prior record. Saving creates a pending correction; amounts change only after the helper reviews and accepts it.',
          '外傭曾確認先前記錄。保存後先列為待核對更正；須外傭核對並接受後，才改變付款金額。') : L('Saving updates the recorded payment facts, not the confirmed salary statement. Any earlier record remains in history; receipt acknowledgement is still separate.',
          '保存會更新付款事實記錄，不會更改已確認薪金結算。先前記錄仍保留，收款確認另行處理。')) + '</p>';
      ov.querySelector('#pc-save').hidden=false;ov.querySelector('#pc-review').scrollIntoView({block:'start'});
    };
    ov.querySelector('#pc-save').onclick = () => {
      if (!requireMembership()) return;
      const latest=state.payments.find(p=>p.id===paymentId);
      if (!preview || state.ui.helperMode || Store.profiles.active()!==profileAtOpen || !latest || Legal.checksum(latest)!==originalChecksum) {fail(L('Records changed. Close and reopen the correction.', '記錄已改變，請關閉並重新打開更正。'));return;}
      const rows=state.payments.map(p=>p.id===paymentId?preview:p);
      try {Store.savePayments(rows);state.payments=rows;closeSheet(ov);render();toast(L('Correction saved; original record retained.', '更正已保存，原記錄保留。'));}
      catch {fail(L('Correction was not saved. Your entries and original record are retained; retry here.', '更正未能保存，已填內容及原記錄仍保留，請在此重試。'));}
    };
    ov.querySelector('#pc-cancel').onclick=()=>closeSheet(ov);
  }

  function openHelperReview(bodyHtml, bindBody) {
    // Language and entered name/PIN live only in this dialog. Neither the
    // employer's app language nor any payroll record changes during handoff.
    let language = state.ui.language, reviewing = state.ui.helperMode === true;
    const headingId = 'recipient-heading-' + uid();
    const R = (en, zh) => language === 'zh-HK' ? zh : en;
    const markup = () => '<div class="row wrap" role="group" aria-label="Language / 語言">' +
      '<button type="button" class="btn secondary compact" id="recipient-en" aria-pressed="' + (language === 'en') + '">English</button>' +
      '<button type="button" class="btn secondary compact" id="recipient-zh" aria-pressed="' + (language === 'zh-HK') + '">繁體中文</button></div>' +
      '<h2 id="' + headingId + '" class="mt">' + R('Helper receipt review', '外傭核對收款') + '</h2>' +
      (reviewing ? bodyHtml(R, language) : '<p class="banner">' + R('Please hand this phone to the helper.', '請把這部手機交給外傭。') + '</p><p>' +
        R('Helper: choose English or 繁體中文 above, then review the payment on the next screen. Nothing is confirmed by continuing.',
          '外傭：請在上方選擇 English 或繁體中文，再到下一頁核對付款。繼續不代表已確認收款。') + '</p><p class="small muted">' +
        R('This takes place on this phone, not remotely. A name or local PIN does not prove identity or bank settlement.',
          '此流程只在這部手機進行，並非遠端確認。姓名或本機 PIN 不會證明身份或銀行已到帳。') + '</p>' +
        '<button class="btn mt" id="recipient-start">' + R('I am the helper — review payment', '我是外傭 — 開始核對付款') + '</button>' +
        '<button class="btn ghost mt" id="recipient-cancel">' + R('Not now', '稍後處理') + '</button>');
    const ov = openSheet('<div id="recipient-content">' + markup() + '</div>');
    const bind = () => {
      ov._language = language;
      const panel = ov.querySelector('#recipient-content'); panel.setAttribute('lang', language);
      const toolbar = ov.querySelector('[data-sheet-close]');
      if (toolbar) toolbar.textContent = R('Close', '關閉') + ' ×';
      for (const [id, next] of [['#recipient-en','en'],['#recipient-zh','zh-HK']]) ov.querySelector(id).onclick = () => {
        if (ov._busy || ov._saved || next === language) return;
        const draft = [...panel.querySelectorAll('input,textarea')].map(input => ({id:input.id,value:input.value,checked:input.checked}));
        const hadError = [...panel.querySelectorAll('[role="alert"]')].some(el => !el.hidden && el.textContent);
        language = next; panel.innerHTML = markup(); bind();
        draft.forEach(row => { const input = ov.querySelector('#' + row.id); if (input) { input.value=row.value;input.checked=row.checked; } });
        if (hadError) { const error = panel.querySelector('[role="alert"]'); if (error) { error.hidden=false; error.textContent=R('Your entries are kept. Check them and try again; no confirmation was saved.', '已填內容保留。請核對後重試；尚未保存確認。'); } }
        ov.querySelector(id === '#recipient-en' ? '#recipient-en' : '#recipient-zh').focus();
      };
      if (reviewing) bindBody(ov, R, language);
      else {
        ov.querySelector('#recipient-start').onclick = () => { reviewing=true;panel.innerHTML=markup();bind();ov.querySelector('#'+headingId).setAttribute('tabindex','-1');ov.querySelector('#'+headingId).focus(); };
        ov.querySelector('#recipient-cancel').onclick = () => closeSheet(ov);
      }
      enhanceFormLabels(panel);
    };
    bind(); return ov;
  }

  function openPaymentCorrectionReview(paymentId) {
    const payment=state.payments.find(p=>p.id===paymentId), current=payment && PaymentLedger.read(payment);
    if (!current?.pending || current.issue || current.pending.rejected) return;
    const profileAtOpen=Store.profiles.active(),originalChecksum=Legal.checksum(payment),pinAtOpen=state.config.helperPin,needPin=!!pinAtOpen;
    openHelperReview((L, language) => '<h3>' + L('Review a payment correction', '核對付款更正') + '</h3><p class="banner">' +
      L('Helper: compare the original and corrected payment below with what actually happened. This does not transfer money or prove bank settlement; a local PIN is not remote identity verification.',
        '外傭：請按實際付款情況核對以下原記錄及更正。這不會轉帳或證明銀行已到帳，本機 PIN 並非遠端身份驗證。') + '</p><h3>' + L('Before', '更正前') + '</h3>' + paymentFactsHtml(current.effective, language) +
      '<h3>' + L('Proposed correction', '建議更正') + '</h3>' + paymentFactsHtml(current.pending.after, language) + '<p>' + esc(current.pending.reason) + '</p>' +
      '<p class="small muted">' + L('Names, notes and the correction reason are shown as entered, without automatic translation.', '姓名、備註及更正原因按原文顯示，不會自動翻譯。') + '</p>' +
      '<p>' + (current.pending.after ? L('Accept only if you received the corrected amount on the stated date. The original acknowledgement remains in history.',
        '只在你確實於所列日期收到更正後金額時接受。原收款確認仍保留在歷史內。') : L('Accept only if this was a duplicate or payment that did not happen. This does not record a refund or allow a deduction from wages.',
        '只在此屬重複記錄或實際未發生的付款時接受。這不代表退款，亦不容許扣薪。')) + '</p>' +
      '<label for="pcr-name">' + L('Your name', '你的姓名') + '</label><input id="pcr-name" value="' + esc(state.config.helperName || '') + '">' +
      (needPin ? '<label for="pcr-pin">' + L('Your PIN', '你的 PIN') + '</label><input id="pcr-pin" type="password" inputmode="numeric" maxlength="6">' : '') +
      '<p id="pcr-error" role="alert" class="form-error" hidden></p><button class="btn mt" id="pcr-accept">' + L('I checked and accept this correction', '我已核對並接受此更正') + '</button>' +
      '<button class="btn secondary mt" id="pcr-reject">' + L('I do not accept this correction', '我不接受此更正') + '</button><button class="btn ghost mt" id="pcr-cancel">' + L('Not now', '稍後處理') + '</button>', (ov, L) => {
    const decide = action => {
      if (ov._saved || ov._busy) return;
      const fail=text=>{const box=ov.querySelector('#pcr-error');box.textContent=text;box.hidden=false;};
      let stored, pin; try { stored=Store.loadPayments();pin=Store.loadConfig()?.helperPin; }
      catch { fail(L('Could not read the latest record. Please retry.', '未能讀取最新記錄，請重試。'));return; }
      if (!Array.isArray(stored)) { fail(L('Payment history needs recovery. Keep a backup and contact support.', '付款歷史須恢復，請保留備份並聯絡支援。'));return; }
      const latest=stored.find(p=>p.id===paymentId),name=ov.querySelector('#pcr-name').value.trim();
      if (!latest || Store.profiles.active()!==profileAtOpen || Legal.checksum(latest)!==originalChecksum || pin!==pinAtOpen || state.config.helperPin!==pinAtOpen) {fail(L('Record changed. Close and review it again.', '記錄已改變，請關閉並重新核對。'));return;}
      if (!name || (needPin && ov.querySelector('#pcr-pin').value!==pinAtOpen)) {fail(L('Enter your name and the correct helper PIN.', '請輸入姓名及正確外傭 PIN。'));return;}
      const result=PaymentLedger.decide(latest,action,{id:uid(),at:new Date().toISOString(),name,pinVerified:needPin});
      if(result.errors.length){fail(L('Could not apply this review; check the record again.', '未能保存此核對，請重新檢查記錄。'));return;}
      const rows=stored.map(p=>p.id===paymentId?result.next:p);
      try {ov._busy=true;Store.savePayments(rows);state.payments=rows;ov._saved=true;ov._dirty=false;closeSheet(ov);render();toast(L('Review saved. Please return the phone to the employer.', '核對已保存，請把手機交回僱主。'));}
      catch {fail(L('Review was not saved. Original records are unchanged; retry here.', '核對未能保存，原記錄未改動，請在此重試。'));}
      finally { ov._busy=false; }
    };
    ov.querySelector('#pcr-accept').onclick=()=>decide('accept');ov.querySelector('#pcr-reject').onclick=()=>decide('reject');
    ov.querySelector('#pcr-cancel').onclick=()=>closeSheet(ov);
    });
  }

  async function withdrawPaymentCorrection(paymentId) {
    if(state.ui.helperMode)return;
    const payment=state.payments.find(p=>p.id===paymentId),profileId=Store.profiles.active();
    if (!payment || !PaymentLedger.read(payment).pending) return;
    const original=Legal.checksum(payment);
    if(!(await confirmDialog(L('Withdraw this correction?', '撤回此更正？'),L('The previous payment stays in effect. The correction and any helper response remain in history. This does not resolve a payment dispute.',
      '先前付款記錄繼續適用，更正及外傭回覆會保留。這不代表付款爭議已解決。'),L('Withdraw correction', '撤回更正'))))return;
    const latest=state.payments.find(p=>p.id===paymentId);
    if(state.ui.helperMode || profileId!==Store.profiles.active() || !latest || Legal.checksum(latest)!==original)return;
    const result=PaymentLedger.decide(latest,'withdraw',{id:uid(),at:new Date().toISOString()});
    if(result.errors.length)return;
    const rows=state.payments.map(p=>p.id===paymentId?result.next:p);
    try {Store.savePayments(rows);state.payments=rows;render();}
    catch {toast(L('Could not withdraw; the correction is unchanged. Please retry.', '未能撤回，更正記錄未改動，請重試。'));}
  }

  function openApprovalSheet(paymentId) {
    const original = state.payments.find(p => p.id === paymentId);
    if (!original) return;
    const view = PaymentLedger.read(original), payment = view.effective;
    if (view.pending) { openPaymentCorrectionReview(paymentId); return; }
    if (view.issue || !payment || payment.status === 'approved') return;
    const profileAtOpen = Store.profiles.active(), originalChecksum = Legal.checksum(original), pinAtOpen = state.config.helperPin;
    const needPin = !!state.config.helperPin;
    openHelperReview((L, language) =>
      '<h3>' + L('Confirm money received', '確認已收到款項') + '</h3>' +
      '<p class="banner">' + L('Helper: check the amount and date below. Confirm only if you have actually received this money. A local PIN does not verify a bank transfer or remote identity.',
        '外傭：請核對以下金額及日期，只在確實收到款項後確認。本機 PIN 不會核實銀行轉帳或遠端身份。') + '</p>' +
      '<p class="muted">' + (language === 'zh-HK'
        ? '請' + esc(state.config.helperName || '外傭') + '確認已收到這筆薪金。'
        : esc(state.config.helperName || 'Helper') + ', please confirm you received this salary payment.') + '</p>' +
      '<div class="approve-amount">' + money(payment.amount) + '</div>' +
      '<p class="muted small">' + esc(I18n.monthYear(+payment.monthKey.slice(0,4),+payment.monthKey.slice(5),language)) + L(' salary · paid ', '薪金 · 付款日期：') + esc(I18n.formatDate(payment.date,language)) +
      ' · ' + esc(I18n.paymentMethod(payment.method, language)) + (payment.note ? ' · ' + esc(payment.note) : '') + '</p>' +
      '<p class="small muted">' + L('Names, notes and attached evidence stay in their original language.', '姓名、備註及附件保留原來語言。') + '</p>' +
      '<div class="thumbs" id="appr-thumbs"></div>' +
      '<label for="appr-name">' + L('Your name', '你的姓名') + '</label>' +
      '<input id="appr-name" value="' + esc(state.config.helperName || '') + '">' +
      (needPin ? '<label for="appr-pin">' + L('Your PIN', '你的 PIN') + '</label><input id="appr-pin" type="password" inputmode="numeric" maxlength="6">' : '') +
      '<p id="appr-error" class="form-error" role="alert" hidden></p>' +
      '<button class="btn mt" id="appr-ok">✓ ' + L('I confirm I received this payment', '我確認已收到這筆款項') + '</button>' +
      '<button class="btn ghost mt" id="appr-cancel">' + L('Not now', '稍後處理') + '</button>', (ov, L, language) => {
    loadThumbs(ov.querySelector('#appr-thumbs'), original, language);
    ov.querySelector('#appr-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#appr-ok').onclick = () => {
      if (ov._saved || ov._busy) return;
      const fail = text => { const box=ov.querySelector('#appr-error');box.textContent=text;box.hidden=false; };
      let stored, pin; try { stored=Store.loadPayments();pin=Store.loadConfig()?.helperPin; }
      catch { fail(L('Could not read the latest record. Please retry.', '未能讀取最新記錄，請重試。'));return; }
      if (!Array.isArray(stored)) { fail(L('Payment history needs recovery. Keep a backup and contact support.', '付款歷史須恢復，請保留備份並聯絡支援。'));return; }
      const current = stored.find(p=>p.id===paymentId);
      if (!current || Store.profiles.active()!==profileAtOpen || pin!==pinAtOpen || state.config.helperPin!==pinAtOpen || Legal.checksum(current)!==originalChecksum) {
        fail(L('This record changed. Close and reopen it before confirming.', '此記錄已改變，請關閉並重新打開後再確認。'));return;
      }
      const name = ov.querySelector('#appr-name').value.trim();
      if (!name) { fail(L('Please enter your name', '請輸入你的姓名')); return; }
      if (needPin && ov.querySelector('#appr-pin').value !== state.config.helperPin) {
        fail(L('Wrong PIN', 'PIN 不正確')); return;
      }
      const result = PaymentLedger.acknowledge(current,{id:uid(),name,at:new Date().toISOString(),pinVerified:needPin});
      if (result.errors.length) { fail(L('This receipt could not be confirmed. Review the payment history.', '未能確認此收款，請核對付款歷史。'));return; }
      const rows=stored.map(p=>p.id===paymentId?result.next:p);
      try { ov._busy=true;Store.savePayments(rows);state.payments=rows;ov._saved=true;ov._dirty=false; }
      catch { fail(L('Confirmation was not saved. The original record is unchanged; retry here.', '確認未能保存，原記錄未改動，請在此重試。'));return; }
      finally { ov._busy=false; }
      HSTrack('payment-approved');
      closeSheet(ov);
      toast(L('Receipt acknowledged. Please return the phone to the employer.', '已確認收到款項，請把手機交回僱主。'));
      render();
    };
    });
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

  function openImageViewer(fileId, language = state.ui.language) {
    const profileId = Store.profiles.active();
    return Store.files.get(fileId).then(rec => {
      if (!rec || Store.profiles.active() !== profileId) return;
      const url = URL.createObjectURL(rec.blob);
      const title = language === 'zh-HK' ? '付款截圖' : 'Payment screenshot';
      try {
        const viewer = openSheet('<h2>' + title + '</h2><img class="payment-image" alt="' + title + '" src="' + esc(url) + '">',
          { language, guardChanges: false, onClosed: () => URL.revokeObjectURL(url) });
        viewer.classList.add('image-sheet');
      } catch (error) { URL.revokeObjectURL(url); throw error; }
    }).catch(() => toast(language === 'zh-HK' ? '未能開啟付款圖片，請重試。' : 'Could not open the payment image. Please try again.'));
  }

  function loadThumbs(container, payment, language = state.ui.language) {
    if (!container) return;
    (payment.fileIds || []).forEach(fid => {
      const img = document.createElement('img');
      img.alt = '';
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'thumbnail-button';
      button.setAttribute('aria-label', language === 'zh-HK' ? '開啟付款截圖' : 'Open payment screenshot');
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
      button.onclick = () => openImageViewer(fid, language);
      button.appendChild(img); container.appendChild(button);
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
    if (state.ui.helperMode || state.logs[owedItem.date]?.status !== 'approved' || !(state.logs[owedItem.date]?.work > 0)) {
      openDaySheet(owedItem.date); return;
    }
    const linkedRows = (state.config.holidays || []).map((row,index)=>({row,index})).filter(item=>item.row.altFor===owedItem.date);
    if (linkedRows.length > 1 || linkedRows.some(item=>!['alternative_holiday','substituted_holiday'].includes(item.row.type))) {
      openHolidayRecordReview(linkedRows[0].index); return;
    }
    const original = Legal.checksum(state.config), profileId = Store.profiles.active();
    const originalWork = Legal.checksum(state.logs[owedItem.date] || null);
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
      '<p class="muted small mt">' + L('Closing this form keeps the saved work record and the existing holiday arrangement, if any. A blank form does not arrange a holiday.', '關閉此表格會保留已保存的工作及原有補假安排（如有）；未填寫並儲存不等於已安排補假。') + '</p>' +
      '<label>' + L('How was this day off arranged?', '這次補假如何安排？') + '</label><select id="alt-type"><option value="alternative_holiday"' + (owedItem.arrangementType !== 'substituted_holiday' ? ' selected' : '') + '>' + L('Employer arranged an alternative holiday (±60 days)', '僱主安排另定假日（前後60日）') + '</option><option value="substituted_holiday"' + (owedItem.arrangementType === 'substituted_holiday' ? ' selected' : '') + '>' + L('Both agreed a substituted holiday (±30 days)', '雙方同意代替假日（前後30日）') + '</option></select>' +
      '<label>' + L('Day off in lieu', '補假日期') + ' <span id="alt-date-state"></span></label>' +
      '<input id="alt-date" type="date" value="' + esc(existing) + '"' +
      ' min="' + esc(E.addDays(owedItem.date, -60)) + '" max="' + esc(owedItem.deadline) + '">' +
      '<p id="alt-range" class="muted small" aria-live="polite"></p>' +
      '<label>' + L('Holiday work starts at (Hong Kong time)', '假日工作開始時間（香港時間）') + ' <span id="alt-work-start-state"></span></label>' +
      '<input id="alt-work-start" type="time" required value="' + esc(savedStart) + '">' +
      '<p class="muted small">' + esc(fmtDate(owedItem.date)) + ' · ' + L('Use the actual agreed start time, not a guessed time. Old arrangements without this detail need checking; saved statements are unchanged.',
        '請記錄實際約定的開始時間，不應猜填。舊安排若缺少此資料，須補核；已保存的結算不會改寫。') + '</p>' +
      '<label>' + L('When was notice of holiday work actually given? (Hong Kong time)', '何時實際通知外傭在假日工作？（香港時間）') + ' <span id="alt-notice-state"></span></label>' +
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
    // Safari may show its device-date/time hints even when value is empty.
    // Label actual input state so those hints cannot be mistaken for our records.
    const updateEmptyFields = () => {
      ['alt-date','alt-work-start','alt-notice'].forEach(id => {
        ov.querySelector('#' + id + '-state').textContent = ov.querySelector('#' + id).value ? '' : L('(not entered)', '（尚未填寫）');
      });
    };
    ['alt-date','alt-work-start','alt-notice'].forEach(id => { ov.querySelector('#' + id).oninput = updateEmptyFields; });
    ov.querySelector('#alt-type').onchange = () => { ov.querySelector('#alt-agreement').checked = false; updateType(); };
    ov.querySelector('#alt-date').onchange = () => { ov.querySelector('#alt-agreement').checked = false; updateEmptyFields(); };
    ov.querySelector('#alt-cancel').onclick = () => closeSheet(ov);
    updateType();
    updateEmptyFields();

    ov.querySelector('#alt-save').onclick = () => {
      if (!requireMembership()) return;
      const fail = (message, selector) => { const box = ov.querySelector('#alt-error'); box.textContent = message; box.hidden = false;
        const field = ov.querySelector(selector); if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } };
      if (state.ui.helperMode || Store.profiles.active() !== profileId || Legal.checksum(state.config) !== original || Legal.checksum(state.logs[owedItem.date] || null) !== originalWork) {
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
      (em ? '<button class="btn compact" data-schedule-alt="' + esc(o.date) + '">' + (state.logs[o.date]?.status === 'approved' ? L('Arrange holiday', '安排補假') : L('Review work first', '先核對工作')) + '</button>' : '') +
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
          'Review any pending work with the employer on this device. Statutory-holiday work requires a separate holiday arrangement; extra pay cannot replace the holiday.',
          '請在此裝置與僱主核對待批准的工作記錄。法定假日工作須另行安排假期，額外薪金不能取代假日。'
        )
        : L(
          'Review pending work first. Statutory-holiday work requires at least 48 hours’ notice and an alternative holiday within 60 days before or after; agreed substituted holidays have different rules. Cash cannot replace the holiday. This card does not confirm any extra pay.',
          '請先核對待批准工作。法定假日工作須提前至少48小時通知，並在前後60日內安排另定假日；雙方同意的代替假日另有規則。現金不能取代假日，此卡片亦不代表已確認任何額外薪金。'
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
    const setupPending = initialSetupPending(state.config);
    if (setupPending.length && !state.ui.helperMode) {
      const recommendedIndex = setupPending.findIndex(item => item.priority === 'recommended');
      const recommended = recommendedIndex >= 0 ? setupPending[recommendedIndex] : null;
      const later = setupPending.map((item, index) => ({ item, index })).filter(row => row.index !== recommendedIndex);
      const setupMarkup = '<section class="card progressive-setup" id="setup-pending"><p class="eyebrow">' + L('Set up as you go', '逐步完成設定') + '</p><h2>' +
        L('One useful step at a time', '每次只處理一項') + '</h2><p>' +
        L('You can record what happened now. Complete extra details only when they are useful for your calendar or a salary check.', '現在已可記錄實際情況；其他資料只需在日曆或薪金核對需要時逐項補充。') + '</p>' +
        (recommended ? '<div class="setup-next"><span class="badge plus">' + L('Recommended next', '建議下一步') + '</span><p><b>' + esc(isZh() ? recommended.zh : recommended.en) + '</b></p>' +
        '<button class="btn secondary" data-resolve-issue="' + recommendedIndex + '">' + L('Do this step', '處理這一步') + '</button></div>' : '') +
        (later.length ? '<details class="mt"><summary>' + L('Other details — only when needed (', '其他資料 — 有需要時才處理（') + later.length + L(')', '）') + '</summary><p class="muted small">' +
          L('These do not have to be completed today. Leaving them unknown keeps only the affected calculations unconfirmed; it does not erase any record.', '這些不必今天完成。保留為未知只會令相關計算不能確認，不會刪除任何記錄。') + '</p><ul class="issue-list">' + later.map(row =>
          '<li><p>' + esc(isZh() ? row.item.zh : row.item.en) + '</p><button class="btn ghost compact" data-resolve-issue="' + row.index + '">' + L('Review when ready', '準備好才核對') + '</button></li>').join('') + '</ul></details>' : '') + '</section>';
      const primaryTodayCard = state.ui.view === 'today' ? view.querySelector(':scope > .card') : null;
      if (primaryTodayCard) primaryTodayCard.insertAdjacentHTML('afterend', setupMarkup);
      else view.insertAdjacentHTML('afterbegin', setupMarkup);
      bindCalculationChecklist($('#setup-pending'), { blockers: setupPending });
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

  function initialSetupPending(config) {
    if (config.initialSetupVersion !== 1) return [];
    const items = [], add = (code, en, zh, priority = 'later') => items.push({ code, en, zh, priority });
    const weekdayKnown = Number.isInteger(config.restDayWeekday) && config.restDayWeekday >= 0 && config.restDayWeekday <= 6;
    if (!weekdayKnown) add('rest_weekday', 'Set the usual weekly day off — this prepares the calendar and reminders', '設定通常每周休息日 — 方便日曆及提醒運作', 'recommended');
    if (config.employmentStartPending === true) add('contract_start', 'Only when checking salary or the contract end: copy the exact first work day from the signed contract', '只在核對薪金或合約完結日期時：從已簽合約抄錄準確首個工作日');
    if (!PayHistory.complete(config)) add('effective_terms', 'Add the actual monthly wage and food arrangement before checking salary', '核對薪金前，補充實際月薪及膳食安排', weekdayKnown ? 'recommended' : 'later');
    if (weekdayKnown && PayHistory.restWindow(config, config.startDate, config.contractEndDate).issue) add('rest_history_missing', 'When needed for salary: check whether rest days are paid and the agreed arrangement if one is worked', '需要核對薪金時：確認休息日是否有薪，以及休息日上班的實際協議');
    if (!validRecordDate(config.contractSignedOn)) add('contract_signed_on', 'Contract signing date — needed only to check which minimum wage and food-allowance rates apply', '合約簽署日期 — 只在核對適用最低工資及膳食津貼金額時需要');
    if (!['paid','unpaid'].includes(config.firstThreeMonthHolidayPayTerm)) add('first_three_months', 'If reviewing the first 3 months: check whether statutory holidays were paid by agreement', '如要核對首3個月：確認法定假日是否按協議有薪');
    if (!['christmas','winter_solstice'].includes(config.winterHolidayChoice)) add('winter_choice', 'Before December: check whether the signed contract selects Winter Solstice (22 Dec) or Christmas Day (25 Dec)', '12月前：查看已簽合約選擇冬節（12月22日）還是聖誕節（12月25日）');
    return items;
  }

  function onboardingProgressHtml(step) {
    return '<div class="onboarding-progress" aria-label="' + L('Onboarding progress', '迎新進度') + '">' +
      [1, 2].map(number =>
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
      (adding ? '' : onboardingProgressHtml(2)) +
      '<div class="onboarding-heading">' +
      '<p class="eyebrow">' + (adding ? L('New helper', '新增外傭') : L('Quick setup', '快速設定')) + '</p>' +
      '<h1>' + (adding ? L('Add another helper', '加入另一位外傭') : L('Start with the basics', '先填基本資料')) + '</h1>' +
      '<p>' + L(
        adding
          ? 'This helper will have a separate calendar, salary statements and payment history.'
          : 'Start tracking from today, or choose another recent date. You do not need to recreate earlier records.',
        adding
          ? '這位外傭會有獨立的日曆、薪金結算單及付款記錄。'
          : '可由今天開始追蹤，或選擇另一個近期日期；毋須重新補錄以前的記錄。'
      ) + '</p></div>' +
      onboardingLanguageHtml() +
      '<p id="setup-section-status" class="onboarding-note" role="status">' + L('No history required · today is already selected', '毋須補錄歷史 · 已預設今天') + '</p>' +
      '<fieldset class="setup-section" data-setup-section="1"><legend class="sr-only">' + L('Basic profile', '基本檔案') + '</legend>' +
      '<label>' + L('Start using HelperPay from', '由哪天開始使用 HelperPay') + '</label><input id="su-start" type="date" required max="' + today + '" value="' + today + '">' +
      '<p class="muted small mt">' + L('This starts reminders and new records. It is not claiming that employment began on this date.', '這只是開始提醒及新記錄，並不代表外傭在這一天入職。') + '</p></fieldset>' +
      '<p id="setup-error" class="form-error" role="alert" hidden></p>' +
      '<button class="btn mt" id="su-create">' + L('Start recording', '開始記錄') + '</button>' +
      '<details class="optional-setup"><summary>' + L('Add useful details now (optional)', '現在加入常用資料（選填）') + '</summary><p class="muted small">' +
      L('These improve the calendar and salary view. Choose “set later” instead of guessing.', '這些資料可改善日曆及薪金顯示；不確定時請選「稍後設定」，不要猜填。') + '</p>' +
      '<label>' + L('Helper\'s name', '外傭姓名') + '</label><input id="su-helper" autocomplete="name" placeholder="' + L('e.g. Maria', '例如：Maria') + '">' +
      '<label>' + L('About which month did employment begin? (optional)', '大約哪個月開始受僱？（選填）') + '</label><input id="su-employment-month" type="month" max="' + today.slice(0, 7) + '">' +
      '<p class="muted small">' + L('An approximate month is enough for now. Add the exact day from the signed contract only if you later check salary or the contract end.', '現在只記大概月份便可；日後要核對薪金或合約完結日期時，才從已簽合約補上準確日期。') + '</p>' +
      '<label>' + L('Usual weekly day off', '通常每周休息日') + '</label><select id="su-rest"><option value="-1">' + L('Set later', '稍後設定') + '</option>' +
      weekdays().map((w, i) => '<option value="' + i + '">' + w + '</option>').join('') + '</select>' +
      '<label>' + L('Current monthly wage (HK$)', '目前月薪（港幣）') + '</label><input id="su-wage" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="' + L('Leave blank to set later', '留空可稍後設定') + '">' +
      '<label>' + L('Food arrangement', '膳食安排') + '</label><select id="su-food-mode"><option value="unknown">' + L('Set later', '稍後設定') + '</option>' +
      '<option value="provided">' + L('Food provided free', '免費提供膳食') + '</option><option value="allowance">' + L('Monthly food allowance', '每月膳食津貼') + '</option></select>' +
      '<label>' + L('Food allowance (HK$/month; only if selected above)', '膳食津貼（港幣／月；只在上方選擇津貼時填寫）') + '</label><input id="su-food" type="number" inputmode="decimal" min="0" step="0.01">' +
      '<p class="muted small mt" id="setup-history-note">' + L('Current amounts are saved only as unconfirmed notes. Earlier wage history is never invented.', '目前金額只會保存為未核對資料；系統絕不會猜測以往工資歷史。') + '</p></details>' +
      '<details class="plain-explanation mt"><summary>' + L('What kind of employment does this cover?', '這適用於哪種僱傭？') + '</summary><p class="muted small">' + L(
        'HelperPay is for a foreign domestic helper employed in Hong Kong under the standard two-year contract. The contract is officially called ID 407; it is not a number you need to look up now.',
        'HelperPay 適用於在香港按標準兩年合約聘用的外傭。該合約正式名稱是 ID 407；你現在毋須尋找任何「407 編號」。') + '</p></details>' +
      (adding
        ? '<button class="btn ghost mt" id="su-cancel">' + L('Cancel', '取消') + '</button>'
        : '<button class="btn ghost mt" id="ob-back">' + L('Back', '返回') + '</button>') +
      (adding ? '' :
        '<p class="muted small mt">' + L('Questions?', '如有問題，請聯絡：') + ' <a href="' + whatsappUrl() + '" target="_blank" rel="noopener" style="color:var(--accent)">WhatsApp ' + WHATSAPP_DISPLAY + '</a></p>') +
      '</div>';
  }

  function setupHtml() {
    const today = E.todayStr();
    const adding = state.addingProfile;
    if (adding || state.onboardingStep === 2) return setupFormHtml(today, adding);

    return '<div class="card onboarding-card">' +
      onboardingProgressHtml(1) +
      '<div class="onboarding-heading"><p class="eyebrow">' + L('Welcome', '歡迎') + '</p>' +
      '<h1>' + L('Know what to do each day', '每天應該怎樣使用？') + '</h1>' +
      '<p>' + L(
        'Normal working days use contract defaults. Confirm whether each rest day and holiday was worked or taken off, and record leave or other exceptions.',
        '一般工作日按合約預設計算。請確認每個休息日及假日有否上班，並記錄請假或其他例外情況。'
      ) + '</p></div>' +
      onboardingLanguageHtml() +
      '<div class="onboarding-actions">' +
      '<div><span class="onboarding-icon">📝</span><p><b>' + L('Today', '今日') + '</b><small>' + L('Record leave, or work on a rest day or holiday', '記錄請假，或在休息日／假日工作') + '</small></p></div>' +
      '<div><span class="onboarding-icon">📅</span><p><b>' + L('Calendar', '日曆') + '</b><small>' + L('Check rest days and Hong Kong statutory holidays', '查看休息日及香港法定假日') + '</small></p></div>' +
      '<div><span class="onboarding-icon">💵</span><p><b>' + L('Salary', '薪金') + '</b><small>' + L('Review monthly calculations and payment records', '檢查每月計算及付款記錄') + '</small></p></div>' +
      '</div>' +
      '<p class="onboarding-note"><b>' + L('Start here:', '由這裡開始：') + '</b> ' + L(
        'Begin with today. No earlier records or exact contract date are required now.',
        '先由今天開始；現在毋須補錄以往記錄或填寫準確合約日期。'
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
    if (next) next.onclick = () => { state.onboardingStep = Math.min(2, state.onboardingStep + 1); render(); };

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
    $$('#view input[id^="su-"], #view select[id^="su-"]').forEach(field => {
      if (Object.prototype.hasOwnProperty.call(state.setupDraft, field.id)) field.value = state.setupDraft[field.id];
      const label = field.previousElementSibling;
      if (label?.tagName === 'LABEL') label.htmlFor = field.id;
      field.addEventListener('input', () => { state.setupDraft[field.id] = field.value; field.removeAttribute('aria-invalid'); });
      field.addEventListener('change', () => { state.setupDraft[field.id] = field.value; updateSetupFields(); });
      field.required = field.id === 'su-start';
    });
    function updateSetupFields() {
      for (const [id, shown] of [['su-food', $('#su-food-mode').value === 'allowance']]) {
        const field = $('#' + id); field.hidden = !shown; field.disabled = !shown; field.required = shown;
        field.previousElementSibling.hidden = !shown;
      }
    }
    updateSetupFields();
    const setupError = (message, selector) => {
      const box = $('#setup-error'); box.textContent = message; box.hidden = false;
      const field = selector ? $(selector) : null; if (field) {
        updateSetupFields(); field.setAttribute('aria-invalid', 'true'); field.focus();
      }
    };
    const readInitialPay = () => PayHistory.prepareInitial({ startDate: $('#su-start').value,
      contractEndDate: Compliance.expectedContractEnd($('#su-start').value), contractSignedOn: '',
      monthlyWage: $('#su-wage').value, foodMode: $('#su-food-mode').value, foodAllowance: $('#su-food').value },
      'unknown', '', { asOf: E.todayStr(), recordedAt: new Date().toISOString() });
    const showPayError = error => {
      const messages = {
        date: L('Enter a valid actual date; leave the signed date blank if it still needs checking.', '請填寫有效的真實日期；如簽署日期仍須核對，可先留空。'),
        wage: L('Enter a positive monthly wage, or leave it blank if unknown.', '請填寫正數月薪；如未知，可先留空。'),
        food: L('Choose the food arrangement, or select “need to check”.', '請選擇膳食安排，或選「需要核對」。'),
        amount: L('Enter the agreed allowance, or mark the food arrangement as needing checking.', '請填寫已協議津貼，或將膳食安排選為需要核對。'),
        choice: L('Say whether wage and food terms were unchanged, changed, or still need checking.', '請選擇工資及膳食安排一直相同、曾經調整，或仍須核對。'),
        unknown_terms: L('Some current amounts or food terms are unknown. Choose “check history later” until they are available.', '目前金額或膳食安排仍未知，請先選「稍後核對歷史」。'),
        effective_date: L('Enter when BOTH current terms began: after the first work day, within the contract, and no later than today. If unsure, choose “check history later”.', '請填寫目前兩項安排同時開始適用的日期：須在首個工作日之後、合約期內且不遲於今天；不確定可選「稍後核對歷史」。'),
        below_maw: L('This wage is below the recorded minimum for the signed date. Check the actual contract.', '此月薪低於簽署日期適用的已記錄最低工資，請核對真實合約。'),
        below_minimum: L('This food allowance is below the recorded minimum for this contract.', '此膳食津貼低於此合約適用的已記錄最低金額。')
      };
      setupError(messages[error.code] || L('Check these contract details.', '請核對這些合約資料。'), '#su-' + error.field);
    };
    $('#su-create').onclick = () => {
      const button = $('#su-create');
      if (button.disabled || state.setupStorageRecoveryNeeded) return;
      if (!$('#su-start').checkValidity() || $('#su-start').value > E.todayStr()) { setupError(L('Choose today or an earlier date to start tracking.', '請選擇今天或較早日期開始追蹤。'), '#su-start'); return; }
      const approximateMonth = $('#su-employment-month').value;
      if (approximateMonth && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(approximateMonth) || approximateMonth > E.todayStr().slice(0, 7))) {
        setupError(L('Choose a valid approximate employment month no later than this month, or leave it blank.', '請選擇不遲於本月的有效大概受僱月份，或留空。'), '#su-employment-month'); return;
      }
      const result = readInitialPay();
      if (result.errors.length) { showPayError(result.errors[0]); return; }
      const initialPay = result.next;
      const restPay = 'unknown';
      const restWork = 'unknown';
      const earlyHoliday = 'unknown';
      const winterChoice = 'unknown';
      const restWeekday = $('#su-rest').value;
      if (!['-1','0','1','2','3','4','5','6'].includes(restWeekday)) { setupError(L('Choose the usual day off, or set it later.', '請選擇通常休息日，或稍後設定。'), '#su-rest'); return; }
      const restAmount = 0;
      const defaults = state.pendingEmployerDefaults || {};
      const config = {
        ...initialPay, initialSetupVersion: 1,
        checkinView: { version: 1, startDate: $('#su-start').value },
        historyTrackingPolicy: 'from_tracking_start',
        employmentStartPending: true,
        employmentStartMonthApprox: approximateMonth || '',
        profileSchemaVersion: 2,
        helperName: $('#su-helper').value.trim(),
        employerName: defaults.employerName || '',
        contractType: 'ID407',
        endDate: '',
        restDayWeekday: Number(restWeekday),
        restDayPayTerm: restPay,
        restDayWorkArrangement: restWork,
        restDayWorkPayment: restAmount,
        firstThreeMonthHolidayPayTerm: earlyHoliday,
        winterHolidayChoice: winterChoice,
        restDayOverrides: {},
        holidays: Holidays.defaultHolidays(winterChoice === 'unknown' ? 'christmas' : winterChoice)
          .filter(day => winterChoice !== 'unknown' || !day.officialId.endsWith(':winter_holiday')),
        holidayCalendarVersion: Holidays.CALENDAR_VERSION,
        holidayWorkBonusAmount: 0,
        helperPin: '',
        employerPin: defaults.employerPin || '',
        lastBackupAt: null,
        createdAt: new Date().toISOString()
      };
      button.disabled = true;
      try { Store.profiles.createWithConfig(config); }
      catch (error) {
        state.setupStorageRecoveryNeeded = error.code === 'setup_recovery_failed';
        setupError(state.setupStorageRecoveryNeeded
          ? L('Saving stopped and recovery could not be confirmed. Keep this page open and contact support before trying again.', '保存已停止，亦未能確認回復狀態。請保留此頁並聯絡支援，暫勿重試。')
          : L('Could not save this profile. Your entries are still here and existing profiles are unchanged. Check storage and retry.', '未能保存檔案。已填內容仍保留，原有檔案未改動；請檢查儲存空間後重試。'));
        button.disabled = !!state.setupStorageRecoveryNeeded; return;
      }
      state.config = config;
      state.setupDraft = {};
      state.setupSection = 1;
      state.logs = {};
      state.payments = [];
      state.adjustments = {};
      state.statements = [];
      state.addingProfile = false;
      state.pendingEmployerDefaults = null;
      state.ui.view = 'today';
      try { HSTrack('setup-completed'); } catch { /* Optional analytics do not undo a saved profile. */ }
      toast(L('Profile saved. Current tasks start today; earlier tasks remain in history.', '檔案已保存。現在待辦由今天起計，較早待辦保留在歷史清單。'));
      render();
    };
  }

  function openQuickRestDaySheet() {
    if (state.ui.helperMode) return;
    if (Object.prototype.hasOwnProperty.call(state.config, 'restTerms')) { openRestHistorySheet(); return; }
    const original = Legal.checksum(state.config), profileId = Store.profiles.active();
    const ov = openSheet('<h2>' + L('Set the usual weekly day off', '設定通常每周休息日') + '</h2><p>' +
      L('This prepares the calendar and reminder dates. It does not decide whether the day is paid or what happens if the helper works; those agreement details can be checked later.', '這只會準備日曆及提醒日期，不會代你決定休息日是否有薪，或外傭在休息日上班時如何處理；這些協議資料可稍後核對。') + '</p>' +
      '<label for="quick-rest-day">' + L('Usual weekly day off', '通常每周休息日') + '</label><select id="quick-rest-day"><option value="">' + L('Choose the actual day', '請選擇實際日期') + '</option>' +
      weekdays().map((day, index) => '<option value="' + index + '">' + day + '</option>').join('') + '</select>' +
      '<p id="quick-rest-error" class="form-error" role="alert" hidden></p><button class="btn mt" id="quick-rest-save">' + L('Save this day', '保存此休息日') + '</button>' +
      '<button class="btn ghost mt" id="quick-rest-later">' + L('Not sure — do this later', '不確定 — 稍後處理') + '</button>');
    ov.querySelector('#quick-rest-later').onclick = () => closeSheet(ov);
    ov.querySelector('#quick-rest-save').onclick = () => {
      if (!requireMembership()) return;
      const value = Number(ov.querySelector('#quick-rest-day').value), fail = message => { const box=ov.querySelector('#quick-rest-error');box.textContent=message;box.hidden=false; };
      if (!Number.isInteger(value) || value < 0 || value > 6) { fail(L('Choose the actual usual day off.', '請選擇實際通常休息日。')); return; }
      if (state.ui.helperMode || Store.profiles.active() !== profileId || Legal.checksum(state.config) !== original) { fail(L('The helper or settings changed. Close and try again.', '外傭或設定已改變，請關閉後重試。')); return; }
      const next = { ...state.config, restDayWeekday: value };
      try { Store.saveConfig(next); state.config = next; closeSheet(ov); render(); toast(L('Usual day off saved. Pay and worked-rest-day terms remain for later.', '通常休息日已保存；薪酬及休息日上班安排可稍後處理。')); }
      catch { fail(L('Could not save. Nothing was changed; try again.', '未能保存，資料沒有改動；請重試。')); }
    };
  }

  // ----- today -----

  function todayHtml() {
    const ds = E.todayStr();
    const employed = E.isEmployedOn(ds, state.config);
    const cls = employed ? E.classifyDay(ds, state.config) : null;
    const entry = state.logs[ds];

    let dayCard;
    if (!employed) {
      dayCard = '<div class="card"><div class="today-date">' + esc(fmtDate(ds)) + '</div>' +
        '<p class="muted mt">' + L('Outside the employment period.', '不在僱傭期內。') + '</p></div>';
    } else {
      const recorded = E.validLogWork(entry);
      const statusText = E.isAbsence(entry) || entry?.dayTypeUnconfirmed || (recorded && cls.type==='normal' && entry.work<1) ? describeLogEffect(ds) : recorded ? workOptions(cls).find(option => option.work === entry.work).label : entry ? L('Check this day’s record', '請核對當日記錄') : cls.scheduleUnconfirmed ? L('Day type not confirmed — record what happened', '當日類型未確認 — 可先記錄實際情況') : cls.type === 'normal'
        ? L('Scheduled working day', '按合約預計上班') : L('Scheduled day off', '按合約預計休息／放假');
      dayCard = '<div class="card">' +
        '<div class="spread"><div class="today-date">' + esc(fmtDate(ds)) + '</div></div>' +
        '<div class="today-type">' + dayBadges(cls) + ' ' + logStatusBadge(entry) + '</div>' +
        '<p class="mt"><b>' + esc(statusText) + '</b></p>' +
        '<p class="muted small mt">' + (entry
          ? L('Open this record to check or change it. Changes are only saved when you press Save.', '開啟記錄以核對或修改；按「儲存」後才會保存更改。')
          : L('This is a plan, not a saved record. Open the form below to record what actually happened, then press Save.', '這只是預設安排，並非已保存記錄。按下方按鈕填寫實際情況，再按「儲存」。')) + '</p>' +
        (entry && entry.note ? '<p class="muted small mt">' + L('Note: ', '備註：') + esc(entry.note) + '</p>' : '') +
        '<button class="btn mt" id="today-more">' + (entry ? L('View / check today’s record', '查看／核對今天記錄') : L('Record today’s situation', '記錄今天情況')) + '</button>' +
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
            ? '<button class="btn compact" data-approve-log="' + d + '">' + L('Review', '核對') + '</button>'
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
            (isZh() ? '逐項核對（' + pend.length + '）' : 'Review ' + pend.length + ' records one by one') + '</button>'
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
        '<div class="stat"><div class="v">' + (stmt.absenceCount || 0) + '</div><div class="k">' + L('Leave records', '請假記錄') + '</div></div>' +
        '<div class="stat"><div class="v">' + (stmt.estimateUnavailable ? '—' : money(stmt.total)) + '</div><div class="k">' +
        (stmt.estimateUnavailable ? L('Pay calculation needs review', '薪酬計算須核對') : L('Projected salary', '預計薪金')) + '</div></div>' +
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
        openDaySheet(b.dataset.approveLog);
      };
    });
    const all = $('#approve-all-logs');
    if (all) all.onclick = () => {
      const next = pendingLogDates()[0];
      if (next) openDaySheet(next);
    };
    $$('#view .pending-row[data-open-day]').forEach(row => {
      row.onclick = () => openDaySheet(row.dataset.openDay);
    });

    const ds = E.todayStr();
    if (!E.isEmployedOn(ds, state.config)) return;
    const more = $('#today-more');
    if (more) more.onclick = () => openDaySheet(ds);
  }

  // ----- calendar -----

  function monthNavigationHtml(prefix, y, m) {
    const key = E.ymd(y, m, 1).slice(0, 7), current = E.todayStr().slice(0, 7);
    return '<div class="cal-head"><button class="nav-btn" id="'+prefix+'-prev" aria-label="'+L('Previous month','上一個月')+'" '+(y===1000&&m===1?'disabled':'')+'>‹</button>'+
      '<button class="title month-picker" id="'+prefix+'-choose" aria-haspopup="dialog" aria-label="'+esc(L('Choose month: ','選擇月份：')+monthYear(y,m))+'">'+esc(monthYear(y,m))+' <span aria-hidden="true">⌄</span></button>'+
      '<button class="nav-btn" id="'+prefix+'-next" aria-label="'+L('Next month','下一個月')+'" '+(y===9999&&m===12?'disabled':'')+'>›</button></div>'+
      '<div class="month-shortcut">'+(key===current?'<span class="muted small">'+L('Current month','本月')+'</span>':'<button class="btn ghost compact" id="'+prefix+'-current">'+L('Back to current month','回到本月')+'</button>')+'</div>';
  }

  function showMonth(prefix, year, month) {
    if (!['cal','sal'].includes(prefix) || !Number.isInteger(year) || year<1000 || year>9999 || !Number.isInteger(month) || month<1 || month>12) return false;
    state[prefix+'Y']=year; state[prefix+'M']=month;
    render();
    const control=$('#'+prefix+'-choose'); if (control) control.focus({preventScroll:true});
    return true;
  }

  function openMonthPicker(prefix) {
    if (!['cal','sal'].includes(prefix)) return;
    const profileId=Store.profiles.active(), view=state.ui.view;
    const ov=openSheet('<h2>'+L('Choose month','選擇月份')+'</h2><p class="muted small">'+L('View another month without changing any records. Saved history outside the current contract remains available.','只切換查看月份，不會修改任何記錄；目前合約以外的已保存歷史仍可查看。')+'</p>'+
      '<label for="month-year">'+L('Year','年份')+'</label><input id="month-year" type="number" inputmode="numeric" min="1000" max="9999" step="1" value="'+state[prefix+'Y']+'">'+
      '<label for="month-number">'+L('Month','月份')+'</label><select id="month-number">'+I18n.months(state.ui.language).map((label,i)=>'<option value="'+(i+1)+'" '+(state[prefix+'M']===i+1?'selected':'')+'>'+esc(label)+'</option>').join('')+'</select>'+
      '<p class="form-error" role="alert" id="month-error" hidden></p><button class="btn mt" id="month-open">'+L('View this month','查看此月份')+'</button><button class="btn ghost mt" id="month-cancel">'+L('Cancel','取消')+'</button>');
    // The picker is a read-only navigation choice, not an unsaved payroll form.
    ov._guardChanges=false;
    ov.querySelector('#month-cancel').onclick=()=>closeSheet(ov);
    ov.querySelector('#month-open').onclick=()=>{
      const fail=message=>{ const error=ov.querySelector('#month-error');error.textContent=message;error.hidden=false; };
      if (Store.profiles.active()!==profileId || state.ui.view!==view) { fail(L('The helper or page changed. Close this picker and reopen it.','外傭或頁面已切換，請關閉後重新選月份。'));return; }
      const year=ov.querySelector('#month-year').value, month=ov.querySelector('#month-number').value;
      if (!/^[1-9]\d{3}$/.test(year) || !/^(?:[1-9]|1[0-2])$/.test(month)) { fail(L('Enter a four-digit year and choose a month.','請輸入四位數年份並選擇月份。'));return; }
      closeSheet(ov);showMonth(prefix,Number(year),Number(month));
    };
    for (const selector of ['#month-year','#month-number']) ov.querySelector(selector).oninput=()=>{ov.querySelector('#month-error').hidden=true;};
    return ov;
  }

  function bindMonthNavigation(prefix) {
    const move=offset=>{const index=state[prefix+'Y']*12+state[prefix+'M']-1+offset;showMonth(prefix,Math.floor(index/12),index%12+1);};
    $('#'+prefix+'-prev').onclick=()=>move(-1);
    $('#'+prefix+'-next').onclick=()=>move(1);
    const choose=$('#'+prefix+'-choose');if(choose)choose.onclick=()=>openMonthPicker(prefix);
    const current=$('#'+prefix+'-current');if(current)current.onclick=()=>{const date=E.todayStr();showMonth(prefix,+date.slice(0,4),+date.slice(5,7));};
  }

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
      const needsReview = entry && (entry.dayTypeUnconfirmed || !E.validLogWork(entry) || !['approved', 'pending'].includes(entry.status));
      let mark = '';
      if (E.isAbsence(entry)) mark = '<span class="mark pend">'+L('L','假')+'</span>';
      else if (cls.scheduleUnconfirmed && entry) mark = '<span class="mark pend">?</span>';
      else if (needsReview) mark = '<span class="mark pend">!</span>';
      else if (entry && typeof entry.work === 'number' && entry.work !== E.defaultWork(cls.type)) {
        if (cls.type === 'normal') {
          mark = '<span class="mark pend">!</span>';
        } else {
          mark = entry.work === 1 ? '<span class="mark plus">+1</span>'
            : entry.work === 0.5 ? '<span class="mark plus">+½</span>' : '';
        }
      } else if (isPending) {
        mark = '<span class="mark pend">?</span>'; // helper reset a day to default — still needs a look
      } else if (entry && entry.status === 'approved' && [0, 0.5, 1].includes(entry.work)) {
        mark = '<span class="mark recorded">✓</span>';
      }
      cells += '<button class="cal-cell' + (isToday ? ' today' : '') +
        (cls.isRest ? ' rest' : '') + (cls.holiday ? ' holiday' : '') +
        (isPending || needsReview ? ' pending' : '') + '" data-date="' + ds + '" aria-label="' + esc(fmtDate(ds) + ' · ' + dayTypeName(cls) + ' · ' +
          (E.isAbsence(entry) ? absenceSummary(entry)+(isPending?L(' — pending',' — 待批准'):'') : needsReview ? L('Record needs review', '記錄須核對') : isPending ? L('Awaiting approval', '待批准') : entry && typeof entry.work === 'number' ? L('Recorded', '已記錄') : L('Contract default, not recorded', '合約預設，未記錄'))) + '">' +
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

    return '<div class="card calendar-card">' +
      // The month sits in a button, so navigating this screen by heading found
      // nothing at all. The visible design is unchanged.
      '<h2 class="sr-only">' + L('Calendar', '日曆') + ' — ' + esc(monthYear(y, m)) + '</h2>' +
      monthNavigationHtml('cal', y, m) +
      '<div class="cal-grid">' +
      weekdaysShort().map((w, i) => '<div class="cal-dow' + (i === 0 ? ' sun' : '') + '">' + w + '</div>').join('') +
      cells +
      '</div>' +
      holList +
      '<div class="cal-legend">' +
      '<span class="item"><span class="dot rest"></span> ' + L('Rest day', '休息日') + '</span>' +
      '<span class="item"><span class="dot holiday"></span> ' + L('Statutory holiday', '法定假日') + '</span>' +
      '<span class="item"><span class="mark plus">+1</span> ' + L('Extra work', '額外工作') + '</span>' +
      '<span class="item"><span class="mark pend">'+L('L','假')+'</span> ' + L('Leave — pay needs review', '請假 — 薪酬須核對') + '</span>' +
      '<span class="item"><span class="mark recorded">✓</span> ' + L('Default confirmed', '已確認與預設相同') + '</span>' +
      '</div>' +
      '<p class="muted small mt">' + L(
        'Tap a date, choose what happened, then Save. Unmarked days are contract defaults, not confirmations.',
        '按日期選擇當日情況，再按「儲存」。沒有記錄標記的日期只是合約預設，並非已確認。'
      ) + '</p>' +
      '</div>';
  }

  function bindCalendar() {
    bindMonthNavigation('cal');
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

    const head = '<div class="card">' + monthNavigationHtml('sal', y, m);

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
    const paymentReview = PaymentLedger.summary(state.payments, stmt.key, E.todayStr());
    const paid = paymentReview.paid;
    const balance = E.round2(due - paid);
    const unacknowledged = paymentReview.rows.find(row => !row.issue && !row.pending && row.effective?.monthKey === stmt.key && row.effective.status === 'paid' && row.effective.date <= E.todayStr());
    const helperMode = state.ui.helperMode;
    const workReview = monthRecordStatus(stmt);

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
      html += '<div class="legal-status mt"><b>' + L('Calculation method supported', '計算方式受支援') + '</b><p>' +
        L('This checks the calculation method, not whether all actual work and leave have been recorded.', '這只檢查計算方式，不代表所有實際工作及請假已記錄。') + '</p></div>';
    }
    if (!stmt.historicalOnly && !(frozen?.inputs?.recordReview?.employerConfirmed && workReview.ready && !changed)) html += '<section class="legal-status mt" id="salary-work-review"><h2>' +
      (workReview.ready ? L('Work records ready for your final check', '工作記錄可作最後核對') : L('Work records still need review', '工作記錄仍須核對')) + '</h2>' +
      monthRecordSummaryHtml(workReview) + '<button class="btn secondary mt" id="sal-check-days">' + L('Check work records', '核對工作記錄') + '</button></section>';

    const absenceLines=stmt.lines.filter(line=>line.kind==='absence-fact');
    if(absenceLines.length) html+='<section class="card mt"><h2>'+L('Current leave / absence facts','目前請假／缺勤事實')+'</h2><p class="muted small">'+L('These records are not deductions or verified leave entitlements. Any existing confirmed statement stays unchanged.','這些記錄不是扣薪或已核實的假期權益；已有已確認結算保持不變。')+'</p>'+
      absenceLines.map(line=>'<p><b>'+esc(fmtDate(line.date))+'</b><br>'+esc(absenceSummary(state.logs[line.date]))+'</p><button class="btn ghost compact" data-absence-date="'+line.date+'">'+L('Check this leave record','核對此請假記錄')+'</button>').join('')+'</section>';

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
    if (paymentReview.needsReview) html += '<p class="form-error mt">' + L('Payment records need review. This month is not marked settled or complete. Review the payment history below.',
      '付款記錄須核對，本月不會標示為已付清或完成。請查看下方付款及更正歷史。') + '</p>';
    if (paid > 0 && !paymentReview.invalid.length) {
      html += '<div class="stmt-line mt"><span class="lbl">' + (paymentReview.pending.length ? L('Prior recorded amount — correction pending', '先前記錄金額 — 更正待核對') : L('Recorded payments so far', '目前已記錄付款')) + '</span><span class="val">' + money(paid) + '</span></div>';
      if (frozen && !paymentReview.needsReview && balance < -0.005) html += '<p class="banner">' + L('Recorded payments exceed this confirmed version by ', '已記錄付款較此確認版本多出 ') + money(-balance) + L('. Check the records; this does not create a refund or deduction.', '。請核對記錄；這不代表退款或可扣薪。') + '</p>';
      else if (frozen && !paymentReview.needsReview) html += '<div class="stmt-line"><span class="lbl"><b>' + L('Balance for confirmed version', '此已確認版本尚欠') + '</b></span><span class="val ' +
        (Math.abs(balance) < 0.005 ? 'plus' : '') + '">' +
        (Math.abs(balance) < 0.005 ? L('Settled ✓', '已付清 ✓') : money(balance)) + '</span></div>';
      else if (!frozen) html += '<p class="muted small">' + L('Payments are recorded facts. No confirmed balance is available for this estimate.', '付款屬已記錄事實；此參考估算尚未有已確認的應付餘額。') + '</p>';
    }

    html += '<div class="row mt">' +
      (frozen || (!stmt.historicalOnly && !stmt.estimateUnavailable) ? '<button class="btn secondary compact grow" id="sal-copy">' + L('Copy statement', '複製結算單') + '</button>' : '') +
      (!helperMode && !frozen && !stmt.historicalOnly ? '<button class="btn ghost compact" id="sal-adj">' + L('+ Voluntary pay', '+ 自願付款') + '</button>' : '') +
      '</div>';
    if (!helperMode) {
      if (changed) html += '<p class="banner mt"><a href="#statement-changes">' + L('New changes are not included in this confirmed total. Review the difference before recording payment ↓', '此已確認總額未包括新增變更。記錄付款前，請先覆核下方差異 ↓') + '</a></p>';
      if (paymentReview.needsReview) html += '<button class="btn mt" id="sal-payment-review">' + L('Review payment records', '核對付款記錄') + '</button>';
      else if (changed) html += '<button class="btn mt" id="sal-check-changes">' + L('Review statement changes', '覆核結算變更') + '</button>';
      else if (frozen && balance <= 0.005) html += unacknowledged
        ? '<button class="btn mt" id="sal-receipt">' + L('Ask helper to confirm receipt', '請外傭確認收到款項') + '</button>'
        : '<button class="btn mt" id="sal-records">' + L('View payment and receipt records', '查看付款及收款記錄') + '</button>';
      else html += '<button class="btn mt" id="sal-pay"' + (!frozen && !assessment.ready ? ' disabled' : '') + '>' +
        (frozen ? L('Record remaining payment: ', '記錄餘款：') + money(balance) : workReview.ready ? L('Preview and confirm statement', '預覽及確認結算') : L('Preview estimate only', '只預覽估算')) + '</button>';
      if (frozen && (balance <= 0.005 || paymentReview.needsReview)) html += '<button class="btn ghost mt" id="sal-extra">' + L('Record another payment actually made', '另記一筆實際已付款項') + '</button>';
      if (!frozen && !assessment.ready) html += '<button class="btn secondary mt" id="sal-external">' +
        L('Record an externally calculated payment', '記錄另行核算後的實際付款') + '</button>';
    }
    if (changed) {
      html += '<section class="legal-status blocked mt" id="statement-changes" tabindex="-1"><b>' + L('Changes need a separate review', '另有變更需要覆核') + '</b><p>' +
        L('The current records or calculation inputs differ from this confirmed version (older versions may lack newer details). The confirmed statement above has not changed.',
          '目前記錄或計算資料與此版本不同（舊版本可能未保存新式資料）。上方已確認結算並未改動。') + '</p><p>' +
        (stmt.estimateUnavailable ? L('Contract terms or work / leave need review; no new estimate or difference is available.', '合約條款或工作／請假須另行核對，目前不會顯示新估算或差額。') :
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
        : wageReview.state === 'work_unreviewed' ? L('Check the missing work records above before completing this month.', '請先核對上方尚未完成的工作記錄，才可完成本月。')
        : L('Still needs review. A payment on its own does not confirm the whole month is settled.', '仍須核對；單是一筆付款，並不代表整月已付清。')) + '</p>' +
      '<p class="small muted">' + L('Wages only. Receipt acknowledgement and other final-contract entitlements are separate. Changed records reopen the check-in.',
        '只限工資。確認收款及其他終止僱傭權益須另行處理；記錄有變更時，待辦會重新開啟。') + '</p>' +
      (wageReview.review ? '<p class="small">' + esc(wageReview.review.reviewedOn) + ' · ' + esc(wageReview.review.basis) + '</p>' : '') +
      (!helperMode && wageReview.state !== 'period_open' && wageReview.state !== 'confirmed_paid' ? '<details class="mt"><summary>' + L('I used another method to calculate this month', '我使用其他方式核算本月薪金') +
        '</summary><p>' + L('Optional: use this only if you independently calculated the complete wage amount outside HelperPay. It does not replace checking work records or confirming receipt.',
          '選用：只適用於已在 HelperPay 以外另行核算完整工資的情況。這不會取代工作記錄核對或收款確認。') + '</p><button class="btn ghost mt" id="sal-month-review">' +
        L('Record this separate wage check', '記錄此另行核算結果') + '</button></details>' : '') + '</section>';
    const draftHistory = state.config.estimateDrafts;
    if (draftHistory !== undefined && !Array.isArray(draftHistory)) html += '<p class="form-error" role="alert">' +
      L('Saved estimate history could not be read. Keep a backup and contact support; it has not been erased.', '未能讀取預估草稿歷史。請保留備份並聯絡支援，原有資料並未清除。') + '</p>';
    const drafts = (Array.isArray(draftHistory) ? draftHistory : []).filter(d => d && d.monthKey === stmt.key && d.status === 'estimate_only');
    if (drafts.length) html += '<details class="mt"><summary>' + L('Saved estimate drafts — not confirmed', '已保存預估草稿 — 非確認結算') + ' (' + drafts.length + ')</summary>' +
      drafts.map(draft => '<section class="card"><p>' + esc(draft.asOf) + ' · ' + L('Estimate only', '只供預估') + '</p><p><b>' + money(draft.projectedTotal) + '</b></p>' +
        '<p class="small">' + L('Saved separately from statements and payments. Current records may differ; never treat this draft as an amount confirmed due or paid.',
          '與結算及付款分開保存，目前記錄可能已不同。此草稿並非已確認應付或已付金額。') + '</p></section>').join('') + '</details>';
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
      html += '<div class="card" id="salary-payments" tabindex="-1"><h2>' + L('Payments', '付款記錄') + '</h2>';
      html += payments.map(payment => paymentCardHtml(payment, stmt.key)).join('');
      html += '</div>';
    }

    return html + '<input type="file" id="hidden-photo" accept="image/*" multiple style="display:none">';
  }

  function bindSalary() {
    $$('#view [data-absence-date]').forEach(button=>button.onclick=()=>openAbsenceSheet(button.dataset.absenceDate));
    bindMonthNavigation('sal');
    const stmt = salaryRecord();
    if (!stmt) return;
    const assessment = salaryAssessment(stmt);
    const frozen = latestStatement(stmt.key);
    bindCalculationChecklist($('#view'), assessment);
    const daysBtn = $('#sal-check-days');
    if (daysBtn) daysBtn.onclick = () => openMonthRecords(stmt);
    const scrollTo = selector => { const section = $(selector); if (section) { section.scrollIntoView({ block: 'start' }); section.focus({ preventScroll: true }); } };
    const recordsBtn = $('#sal-records');
    if (recordsBtn) recordsBtn.onclick = () => scrollTo('#salary-payments');
    const correctionBtn = $('#sal-payment-review');
    if (correctionBtn) correctionBtn.onclick = () => scrollTo('#salary-payments');
    const changesBtn = $('#sal-check-changes');
    if (changesBtn) changesBtn.onclick = () => scrollTo('#statement-changes');
    const receiptBtn = $('#sal-receipt');
    if (receiptBtn) receiptBtn.onclick = () => {
      const review = PaymentLedger.summary(state.payments, stmt.key, E.todayStr());
      const row = review.rows.find(item => !item.issue && !item.pending && item.effective?.monthKey === stmt.key && item.effective.status === 'paid' && item.effective.date <= E.todayStr());
      if (row && !review.needsReview) openApprovalSheet(row.payment.id); else render();
    };
    const extraBtn = $('#sal-extra');
    if (extraBtn) extraBtn.onclick = () => openPaymentSheet(stmt, frozen);

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
        paid: PaymentLedger.summary(state.payments, stmt.key, E.todayStr()).needsReview ? 0 : monthPaid(stmt.key)
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

    $$('#view [data-payment-correct]').forEach(button => { button.onclick = () => openPaymentCorrection(button.dataset.paymentCorrect); });
    $$('#view [data-payment-review]').forEach(button => { button.onclick = () => openPaymentCorrectionReview(button.dataset.paymentReview); });
    $$('#view [data-payment-withdraw]').forEach(button => { button.onclick = () => withdrawPaymentCorrection(button.dataset.paymentWithdraw); });

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

  function settingsFields(section) {
    const unknown=['',L('Not yet checked','待核對')];
    const fields={
      people:[['st-helper','helperName',L("Helper's name",'外傭姓名'),'text'],['st-employer','employerName',L("Employer's name (optional)",'僱主姓名（選填）'),'text']],
      contract:[['st-contract-type','contractType',L('Contract type','合約類型'),'select',[unknown,['ID407','ID 407']]],
        ['st-signed','contractSignedOn',L('Contract signed on','合約簽署日期'),'date'],['st-start','startDate',L('First employment day','首個工作日'),'date'],
        ['st-contract-end','contractEndDate',L('Two-year contract end date','兩年合約完結日期'),'date'],['st-end','endDate',L('Actual last day (early termination only)','實際最後工作日（只限提早終止）'),'date']],
      holiday:[['st-early-holiday','firstThreeMonthHolidayPayTerm',L('First-three-month statutory-holiday pay term','首3個月法定假日薪酬條款'),'select',[unknown,['paid',L('Paid by agreement','按協議有薪')],['unpaid',L('Unpaid','無薪')]]],
        ['st-holiday-bonus','holidayWorkBonusAmount',L('Optional amount per statutory holiday worked (HK$)','每個法定假日工作的自願額外金額（港幣）'),'number']],
      security:[['st-hpin','helperPin',L('Helper PIN (local receipt check)','外傭 PIN（本機收款核對）'),'password'],['st-epin','employerPin',L('Employer PIN (leaving helper mode)','僱主 PIN（離開外傭模式）'),'password']]
    };
    return (fields[section]||[]).map(([id,key,label,type,options])=>({id,key,label,type,options}));
  }

  function settingsValue(row, config) {
    const value=config[row.key];
    if(config.employmentStartPending===true&&row.key==='startDate')return config.employmentStartMonthApprox
      ? L('Exact day not entered · about ','準確日期未填 · 大約 ')+config.employmentStartMonthApprox
      : L('Exact day not entered','準確日期未填');
    if(config.employmentStartPending===true&&row.key==='contractEndDate')return L('Calculated after exact start day is entered','填寫準確開始日期後才計算');
    if(row.type==='password')return value?L('Set','已設定'):L('Not set','未設定');
    if(row.options)return row.options.find(option=>option[0]===value)?.[1]||L('Needs checking','待核對');
    if(row.type==='number')return typeof value==='number'&&Number.isFinite(value)?money(value):L('Not yet checked','待核對');
    if(!value)return row.key==='endDate'?L('Not recorded','未有記錄'):L('Not yet entered','尚未填寫');
    return row.type==='date'&&validRecordDate(value)?I18n.formatDate(value,state.ui.language):String(value);
  }

  function settingsSummary(section, config) {
    const rows=settingsFields(section);
    const history=Array.isArray(config.settingsCorrections)?config.settingsCorrections.filter(item=>item&&item.section===section):[];
    return '<dl class="settings-summary">'+rows.map(row=>'<dt>'+row.label+'</dt><dd>'+esc(settingsValue(row,config))+'</dd>').join('')+'</dl>'+
      (history.length?'<details class="mt"><summary>'+L('Saved corrections','已保存更正')+' ('+history.length+')</summary>'+history.slice().reverse().map(item=>'<section class="card"><p>'+esc(item.at)+' · '+esc(item.reason)+'</p><ul>'+rows.filter(row=>item.before?.[row.key]!==item.after?.[row.key]).map(row=>'<li>'+row.label+': '+esc(settingsValue(row,item.before||{}))+' → '+esc(settingsValue(row,item.after||{}))+'</li>').join('')+'</ul></section>').join('')+'</details>':'');
  }

  function openSettingsEditor(section, focusSelector) {
    if(state.ui.helperMode)return;
    const fields=settingsFields(section);if(!fields.length)return;
    const config=JSON.parse(JSON.stringify(state.config)),profileAtOpen=Store.profiles.active(),checksum=Legal.checksum(config);
    const sensitive=section==='contract'||section==='holiday';let preview=null;
    const title={people:L('Edit names','修改姓名'),contract:L('Correct contract dates and type','更正合約日期及類型'),holiday:L('Correct holiday payment terms','更正假日薪酬條款'),security:L('Change local PINs','更改本機 PIN')}[section];
    const ov=openSheet('<h2>'+title+'</h2><p class="muted">'+(sensitive?L('Preview the effect before saving. This corrects the recorded contract, not a new contract or a future-dated change. Existing work, holiday arrangements, wage histories, payments and confirmed statements will not be rewritten.',
      '先預覽影響，再確認保存。這是更正已記錄的合約，並非新合約或由將來某日起變更。現有工作、假日安排、工資歷史、付款及已確認結算均不會改寫。'):L('Changes stay in this form until you press Save. Cancel keeps the original settings.','按「保存」才會更改設定；取消會保留原設定。'))+'</p>'+
      (section==='security'?'<p class="banner">'+L('Optional: use 4–6 digits, or leave blank to remove a PIN. PINs are local checks, not encryption or remote identity verification. Changing a PIN does not change previous receipt confirmations.','選用：請用4至6位數字，留空可移除 PIN。PIN 只作本機核對，並非加密或遠端身份驗證。更改 PIN 不會改動過往收款確認。')+'</p>':'')+
      fields.map(row=>{const value=section==='contract'&&config.employmentStartPending===true&&['startDate','contractEndDate'].includes(row.key)?'':config[row.key]??'';return '<label for="'+row.id+'">'+row.label+'</label>'+(row.options?'<select id="'+row.id+'">'+row.options.map(([value,label])=>'<option value="'+esc(value)+'"'+((config[row.key]||'')===value?' selected':'')+'>'+label+'</option>').join('')+'</select>':'<input id="'+row.id+'" type="'+row.type+'"'+(row.type==='password'?' inputmode="numeric" minlength="4" maxlength="6" autocomplete="off"':row.type==='number'?' inputmode="decimal" min="0" step="0.01"':'')+' value="'+esc(value)+'">');}).join('')+
      (section==='contract'&&config.employmentStartPending===true?'<p class="banner">'+L('You previously started tracking without an exact employment date'+(config.employmentStartMonthApprox?' (about '+config.employmentStartMonthApprox+')':'')+'. Copy the exact first day from the signed contract; HelperPay will fill the expected two-year end date for you.','你之前在未有準確受僱日期時開始追蹤'+(config.employmentStartMonthApprox?'（大約 '+config.employmentStartMonthApprox+'）':'')+'。請從已簽合約抄錄準確首個工作日；HelperPay 會代你填寫預計兩年合約完結日期。')+'</p>':'')+
      (sensitive?'<label for="settings-reason">'+L('Why is this record being corrected?','更正此記錄的原因')+'</label><textarea id="settings-reason"></textarea><div id="settings-preview"></div><button class="btn secondary mt" id="settings-preview-button">'+L('Preview changes','預覽更改')+'</button>':'')+
      '<p class="form-error" role="alert" id="settings-error" hidden></p><button class="btn mt" id="settings-save"'+(sensitive?' hidden':'')+'>'+L('Save these changes','保存這些更改')+'</button><button class="btn ghost mt" id="settings-cancel">'+L('Cancel','取消')+'</button>');
    const fail=(text,id)=>{const error=ov.querySelector('#settings-error');error.hidden=false;error.textContent=text;if(id)ov.querySelector('#'+id)?.focus();};
    const invalidate=()=>{preview=null;ov.querySelector('#settings-error').hidden=true;if(sensitive){ov.querySelector('#settings-save').hidden=true;ov.querySelector('#settings-preview').innerHTML='';}};
    ov.addEventListener('input',invalidate);ov.addEventListener('change',invalidate);
    const contractStartInput=section==='contract'?ov.querySelector('#st-start'):null;
    if(typeof contractStartInput?.addEventListener==='function')contractStartInput.addEventListener('change',event=>{
      if(validRecordDate(event.target.value))ov.querySelector('#st-contract-end').value=Compliance.expectedContractEnd(event.target.value);
    });
    const read=()=>{
      const changes={};for(const row of fields){const value=ov.querySelector('#'+row.id).value.trim();
        if(row.type==='date'&&value&&!validRecordDate(value)){fail(L('Enter a valid date.','請填寫有效日期。'),row.id);return;}
        if(row.options&&!row.options.some(option=>option[0]===value)){fail(L('Choose one of the listed options.','請選擇列出的選項。'),row.id);return;}
        if(row.type==='password'&&value&&!/^\d{4,6}$/.test(value)){fail(L('Use 4–6 digits, or leave the PIN blank.','PIN 須為4至6位數字，或留空。'),row.id);return;}
        if(row.type==='number'&&(!/^\d+(?:\.\d{1,2})?$/.test(value)||!Number.isSafeInteger(Math.round(Number(value)*100)))){fail(L('Enter zero or a positive amount, with at most two decimal places.','請填0或正數金額，最多兩位小數。'),row.id);return;}
        if(row.key==='helperName'&&!value){fail(L('Enter the helper name.','請填寫外傭姓名。'),row.id);return;}
        changes[row.key]=row.type==='number'?Number(value):value;
      }
      const next={...config,...changes};
      if(section==='contract'){
        if(!validRecordDate(next.startDate)){fail(L('Enter the actual first employment day.','請填寫實際首個工作日。'),'st-start');return;}
        if(!validRecordDate(next.contractEndDate)||next.contractEndDate<next.startDate){fail(L('Enter a contract end date on or after its start.','合約完結日期不得早於開始日期。'),'st-contract-end');return;}
        if(next.endDate&&(next.endDate<next.startDate||next.endDate>next.contractEndDate||next.endDate>E.todayStr())){fail(L('The actual last day must be within the contract and no later than today.','實際最後工作日須在合約期內，並不得遲於今天。'),'st-end');return;}
        next.employmentStartPending=false;
        next.employmentStartMonthApprox=next.startDate.slice(0,7);
      }
      if(fields.every(row=>(config[row.key]??'')===(changes[row.key]??''))){fail(L('Nothing has changed. Use Cancel to return.','沒有更改，請按取消返回。'));return;}
      if(sensitive){
        const reason=ov.querySelector('#settings-reason').value.trim();if(!reason){fail(L('Enter why you are correcting the record.','請填寫更正原因。'),'settings-reason');return;}
        if(config.settingsCorrections!==undefined&&!Array.isArray(config.settingsCorrections)){fail(L('Correction history needs recovery. Export a backup and contact support.','更正歷史須恢復，請匯出備份並聯絡支援。'));return;}
        next.settingsCorrections=[...(config.settingsCorrections||[]),{id:uid(),at:new Date().toISOString(),section,reason,
          before:Object.fromEntries(fields.map(row=>[row.key,config[row.key]??null])),after:changes}];
      }
      return next;
    };
    if(sensitive)ov.querySelector('#settings-preview-button').onclick=()=>{
      invalidate();preview=read();if(!preview)return;
      ov.querySelector('#settings-preview').innerHTML='<section class="card mt"><h3>'+L('Review changes','核對更改')+'</h3><ul>'+fields.filter(row=>(config[row.key]??'')!==(preview[row.key]??'')).map(row=>'<li>'+row.label+': '+esc(settingsValue(row,config))+' → '+esc(settingsValue(row,preview))+'</li>').join('')+'</ul><p class="banner">'+L('These contract-wide corrections can change estimates for earlier dates. Confirmed statements and payments stay unchanged. Check Salary, wage/rest histories and holiday arrangements after saving; unresolved items remain blocked.','此整份合約的更正可能改變較早日期的估算。已確認結算及付款不變。保存後請核對薪金、工資／休息日歷史及假日安排；未解決項目仍會受限制。')+'</p></section>';
      ov.querySelector('#settings-save').hidden=false;ov.querySelector('#settings-preview').scrollIntoView({block:'start'});
    };
    const maySaveSettings = () => {
      if (!requireMembership()) return;
      return !state.ui.helperMode;
    };
    ov.querySelector('#settings-save').onclick=()=>{
      if(ov._saved||ov._busy||state.ui.helperMode)return;
      if(section!=='security'&&!maySaveSettings())return;
      let latest;try{latest=Store.loadConfig();}catch{fail(L('Could not read the latest settings. Retry here.','未能讀取最新設定，請在此重試。'));return;}
      if(Store.profiles.active()!==profileAtOpen||Legal.checksum(latest)!==checksum||Legal.checksum(state.config)!==checksum){fail(L('The helper or settings changed. Cancel and reopen this form; nothing was overwritten.','外傭或設定已改變，請取消後重新開啟表格；沒有覆蓋原資料。'));return;}
      const next=sensitive?preview:read();if(!next){if(sensitive)fail(L('Preview the current changes before saving.','保存前請先預覽目前更改。'));return;}
      try{ov._busy=true;Store.saveConfig(next);state.config=next;ov._saved=true;ov._dirty=false;closeSheet(ov);render();toast(L('Settings saved. Existing records retained.','設定已保存，原有記錄保留。'));}
      catch{fail(L('Settings were not saved. Your entries and original records are kept; retry here.','設定未能保存，已填內容及原記錄均保留，請在此重試。'));}
      finally{ov._busy=false;}
    };
    ov.querySelector('#settings-cancel').onclick=()=>closeSheet(ov);
    if(focusSelector)ov.querySelector(focusSelector)?.focus();
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
      '<p class="muted small">' + L('Display language changes immediately; payroll records do not change.', '顯示語言會即時切換，薪酬記錄不變。') + '</p></div>' +
      languageSwitchHtml() + '</div></div>';

    // helper profiles — a household can employ more than one helper
    const ids = Store.profiles.list();
    const activeId = Store.profiles.active();
    html += '<div class="card" id="settings-profiles"><h2>' + L('Current helper and profiles', '目前外傭及檔案') + '</h2>';
    ids.forEach(id => {
      const cfg = id === activeId ? c : Store.profiles.loadFor(id, 'config', null);
      const name = (cfg && cfg.helperName) || L('Unnamed helper', '未命名外傭');
      html += '<div class="holiday-row">' +
        '<span class="date">' + esc(name) + '</span>' +
        '<span class="name">' + (cfg ? (cfg.employmentStartPending===true
          ? (cfg.employmentStartMonthApprox?L('Began about ','大約開始於 ')+esc(cfg.employmentStartMonthApprox):L('Exact first day not entered','未填準確首個工作日'))
          : L('First day: ', '首個工作日：') + esc(validRecordDate(cfg.startDate) ? I18n.formatDate(cfg.startDate,state.ui.language) : L('Needs checking','待核對'))) : '') + '</span>' +
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

    html += '<div class="card"><h2>' + L('People', '人員資料') + '</h2>' + settingsSummary('people',c) +
      '<button class="btn secondary mt" data-settings-editor="people">'+L('Edit names','修改姓名')+'</button>'+
      '</div>';

    html += '<div class="card"><h2>' + L('Employment contract dates', '僱傭合約日期') + '</h2>' +
      '<div class="banner">⚖️ ' + L(
        'Review the actual contract terms below. Existing records are not changed automatically. Completing these terms does not resolve unsupported calculations; review any remaining items in Salary.',
        '請按實際合約核對以下條款，系統不會自動改寫現有記錄。補齊條款不代表所有計算均受支援；請到「薪金」查看尚需處理的項目。'
      ) + '</div>' +
      '<details class="plain-explanation"><summary>' + L('What does “ID 407” mean?', '「ID 407」是甚麼？') + '</summary><p class="muted small">' + L(
        'It is simply the official name of Hong Kong’s standard two-year contract for employing a foreign domestic helper. It is not your helper’s identity number and you do not need to memorise it.',
        '這只是香港聘用外傭的標準兩年合約正式名稱，並非外傭的身份證號碼，也毋須記住。') + '</p></details>' +
      settingsSummary('contract',c)+'<button class="btn secondary mt" data-settings-editor="contract">'+L('Correct dates / type — preview first','更正日期／類型 — 先預覽')+'</button></div>'+
      '<div class="card">'+
      '<h3 class="mt">' + L('Wage & food history', '工資及膳食歷史') + '</h3>' + payHistoryHtml(c) +
      '<button class="btn secondary mt" id="st-confirm-terms">' + L('Review / update wage and food history', '核對／更新工資及膳食歷史') + '</button>' +
      '<p class="muted small">'+L('Changes are previewed and saved with effective dates. Opening the editor does not save.','更改須填生效日期並預覽後保存；開啟表格不會保存。')+'</p></div>'+
      '<div class="card">'+
      '<h3 class="mt">' + L('Rest-day arrangements', '休息日安排') + '</h3>' + restHistoryHtml(c) +
      '<button class="btn secondary mt" id="st-rest-history">' + L('Change / correct rest-day terms', '變更／更正休息日條款') + '</button>' +
      '<p class="muted small">' + L('Choose an effective date and preview before saving. Changing a weekly pattern does not move individually agreed days off.', '選擇生效日期並預覽後才保存。更改每周安排不會搬移已逐日協議的休息日。') + '</p>' +
      '</div><div class="card"><h3>'+L('Holiday payment terms','假日薪酬條款')+'</h3>'+settingsSummary('holiday',c)+
      '<button class="btn secondary mt" data-settings-editor="holiday">'+L('Correct holiday terms — preview first','更正假日條款 — 先預覽')+'</button>'+
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
      '<p><b>'+L('Which December day is written in the signed contract?','已簽合約列明哪一個12月假日？')+'</b><br>'+L('The standard contract uses either Winter Solstice (22 Dec) or Christmas Day (25 Dec). Check the printed choice; this is not asking which day you prefer and it does not change the other statutory holidays.','標準合約會列明冬節（12月22日）或聖誕節（12月25日）其中一天。請按已簽合約核對；這不是詢問你偏好哪一天，也不會更改其他法定假日。')+'</p>'+
      '<p>'+L('Recorded choice: ','目前記錄：')+esc(c.winterHolidayChoice==='winter_solstice'?L('Winter Solstice','冬節'):c.winterHolidayChoice==='christmas'?L('Christmas Day','聖誕節'):L('Not checked yet','尚未核對'))+'</p><button class="btn secondary mt" id="st-winter">'+L('Check the contract choice','核對合約選擇')+'</button>';
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

    html += '<div class="card"><h2>' + L('Security', '安全設定') + '</h2>' + settingsSummary('security',c)+
      '<button class="btn secondary mt" data-settings-editor="security">'+L('Change local PINs','更改本機 PIN')+'</button>'+
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
      '<label class="row consent-row" style="cursor:pointer;font-size:14px;color:var(--text);font-weight:600">' +
      '<input type="checkbox" id="st-analytics" disabled style="width:auto"' + (state.ui.analyticsConsent === true ? ' checked' : '') + '>' +
      '<span>' + L('Share anonymous usage statistics', '分享匿名使用統計') + '</span></label>' +
      '<p class="muted small mt">' + L(
        'This switch applies immediately. Usage statistics and subscription processing are disabled in this demo. Real payroll and membership are not accessed.',
        '此開關即時生效，此示範模式停用使用統計及訂閱處理，不會存取真實薪酬或會籍資料。'
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
      ['contract', L('Names and contract dates', '姓名及合約日期'), '[data-settings-editor="people"],[data-settings-editor="contract"]'],
      ['pay', L('Wage and food history', '工資及膳食歷史'), '#st-confirm-terms'],
      ['work', L('Work and rest arrangements', '工作及休息安排'), '#st-rest-history,[data-settings-editor="holiday"]'],
      ['holidays', L('Holiday calendar', '假日日曆'), '#st-winter'],
      ['privacy', L('Data, backup and privacy', '資料、備份及私隱'), '[data-settings-editor="security"],#st-export,#st-analytics'],
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
    const profiles=view.querySelector('#settings-profiles');if(profiles)view.prepend(profiles);
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
    const ov = openSheet('<h2>' + L('Check the December contract choice', '核對合約的12月假日') + '</h2><p>' +
      L('Look at the signed standard contract. It names either Winter Solstice (22 Dec) or Christmas Day (25 Dec). Choose what is printed there—not a new preference. Other statutory holidays do not change.',
        '請查看已簽的標準合約，當中會列明冬節（12月22日）或聖誕節（12月25日）其中一天。請按合約原文選擇，並非重新選擇偏好；其他法定假日不會改變。') + '</p><p class="muted small">' +
      L('Existing work, payments, statements and linked arrangements will not be rewritten. You may cancel and check later if the contract is not available.', '現有工作、付款、結算及已連結安排不會被改寫。如合約不在手邊，可取消並稍後核對。') + '</p>' +
      '<label for="calendar-choice">' + L('The signed contract says', '已簽合約列明') + '</label><select id="calendar-choice"><option value="">' + L('I need to check later','我要稍後核對') + '</option><option value="winter_solstice">' + L('Winter Solstice (22 Dec)','冬節（12月22日）') + '</option><option value="christmas">' + L('Christmas Day (25 Dec)','聖誕節（12月25日）') + '</option></select>' +
      '<div id="calendar-preview"></div><label for="calendar-reason">' + L('Reason / checked record','原因／核對依據') + '</label><textarea id="calendar-reason"></textarea>' +
      '<label class="checkline"><input type="checkbox" id="calendar-confirm">' + L('I checked the contract choice and proposed changes. This does not create a new agreement.','我已核對合約選擇及建議更改；此操作不會訂立新協議。') + '</label>' +
      '<p id="calendar-error" class="form-error" role="alert" hidden></p><button class="btn mt" id="calendar-save">' + L('Save reviewed calendar','保存已核對日曆') + '</button>' +
      '<button class="btn ghost mt" id="calendar-cancel">' + L('Cancel','取消') + '</button>' + holidayRevisionHtml(state.config));
    let preview = null;
    ov.querySelector('#calendar-confirm').onchange = () => ov.querySelector('#calendar-confirm').removeAttribute('aria-invalid');
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
      const calendarConfirm = ov.querySelector('#calendar-confirm');
      if (!preview || !calendarConfirm.checked) {
        fail(HolidayReview.message({code:'confirmation'},state.ui.language));
        if (preview) { calendarConfirm.setAttribute('aria-invalid', 'true'); calendarConfirm.focus(); }
        return;
      }
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
      (!complete && config.initialPayTerms?.historyChoice === 'unknown' ? '<p class="muted small">' + L('At setup you entered current monthly wage: ', '建檔時輸入的目前月薪：') +
        (config.initialPayTerms.enteredMonthlyWage === null ? L('unknown', '未知') : money(config.initialPayTerms.enteredMonthlyWage)) +
        L('. Its effective date was not checked; this note is not applied to any past period.', '。其生效日期尚未核對，這項備註不會套用於任何過往期間。') + '</p>' : '') +
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
    if (config.employmentStartPending === true || !validRecordDate(config.startDate) || !validRecordDate(config.contractEndDate) || !validRecordDate(config.contractSignedOn)) {
      const missingDate = !validRecordDate(config.contractSignedOn) ? 'contract_signed_on' : config.employmentStartPending === true || !validRecordDate(config.startDate) ? 'contract_start' : 'contract_end';
      const dates = openSheet('<h2>' + L('Complete the contract dates first', '請先補齊合約日期') + '</h2><p>' +
        L('Enter the signed date, start date and two-year end date in Settings, then reopen wage history.', '請先在設定填寫簽署日期、開始日期及兩年完結日期，再打開工資歷史。') +
        '</p><button class="btn mt" data-resolve-issue="0">' + L('Go to the missing date', '前往填寫欠缺日期') + '</button>');
      bindCalculationChecklist(dates, { blockers: [{ code: missingDate }] }, dates); return;
    }
    const complete = PayHistory.complete(config);
    let draft = kind === 'change' ? [{ effectiveFrom: '', monthlyWage: '', mode: '', monthlyAmount: '' }] : PayHistory.rows(config);
    if (!Object.prototype.hasOwnProperty.call(config, 'wagePeriods') && !Object.prototype.hasOwnProperty.call(config, 'foodTerms')) draft = [{ effectiveFrom: config.startDate,
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

  function restTermLabel(term) {
    return (weekdays()[term.restDayWeekday] || L('Weekday not checked', '星期待核對')) + ' · ' +
      (term.restDayPayTerm === 'paid' ? L('Paid rest days', '有薪休息日') : term.restDayPayTerm === 'unpaid' ? L('Unpaid rest days', '無薪休息日') : L('Pay term not checked', '薪酬條款待核對')) + ' · ' +
      (term.restDayWorkArrangement === 'agreed_payment' ? L('Agreed per full day worked: ', '全日工作的協議金額：') + money(term.restDayWorkPayment || 0) :
        term.restDayWorkArrangement === 'substituted_rest_day' ? L('Agreed substituted rest day', '協議補回休息日') : L('Work arrangement not checked', '工作安排待核對'));
  }

  function restHistoryHtml(config) {
    const rows = PayHistory.restRows(config);
    return (!Object.prototype.hasOwnProperty.call(config, 'restTerms') ? '<p class="muted small">' +
      L('Only the initial terms are recorded, without a change history. A new change preserves those earlier terms; this does not certify that they were historically correct. Use correction if they were wrong.',
        '目前只有入職時的一組條款，未有分段變更歷史。新增變更會保留較早條款，但不代表已核證過往正確；如資料有誤，請選擇更正。') + '</p>' : '') +
      (rows.length ? '<ul>' + rows.map((row, i) => '<li>' + esc(row.effectiveFrom || '—') + ' – ' +
        esc(i + 1 < rows.length && validRecordDate(rows[i + 1].effectiveFrom) ? E.addDays(rows[i + 1].effectiveFrom, -1) : config.contractEndDate || '—') +
        '<br>' + esc(restTermLabel(row)) + '</li>').join('') + '</ul>' : '<p class="form-error">' + L('The rest-day history needs correction.', '休息日歷史須更正。') + '</p>');
  }

  function openRestHistorySheet() {
    if (state.ui.helperMode) return;
    const incomplete = !!PayHistory.restWindow(state.config, state.config.startDate, state.config.contractEndDate).issue;
    const ov = openSheet('<h2>' + L('Rest-day terms and history', '休息日條款及歷史') + '</h2>' + restHistoryHtml(state.config) +
      '<button class="btn mt" id="rest-history-change"' + (incomplete ? ' hidden' : '') + '>' + L('Change from a specific date', '由指定日期起變更') + '</button>' +
      '<button class="btn secondary mt" id="rest-history-correct">' + (incomplete ? L('Check and complete these terms', '核對並補齊這些條款') : L('Correct an earlier input mistake', '更正以往輸入錯誤')) + '</button>' +
      '<details class="mt"><summary>' + L('Saved changes and reasons', '已保存的變更及原因') + '</summary>' +
      ((state.config.restTermRevisions || []).map(r => '<p>' + esc(r.recordedAt) + ' · ' +
        (r.kind === 'change' ? L('Change', '變更') : L('Correction', '更正')) + '<br>' + esc(r.reason) + '</p>').join('') || '<p>' + L('No recorded changes yet.', '尚未有變更記錄。') + '</p>') + '</details>');
    ov.querySelector('#rest-history-change').onclick = () => { closeSheet(ov); openRestHistoryEditor('change'); };
    ov.querySelector('#rest-history-correct').onclick = () => { closeSheet(ov); openRestHistoryEditor(incomplete ? 'confirm' : 'correction'); };
  }

  function restHistoryImpactHtml(before, after) {
    const changed = [], classifications = [], recorded = [], months = new Set();
    for (let date = before.startDate; date <= before.contractEndDate; date = E.addDays(date, 1)) {
      const old = E.classifyDay(date, before), next = E.classifyDay(date, after);
      const keys = ['restDayWeekday', 'restDayPayTerm', 'restDayWorkArrangement', 'restDayWorkPayment', 'issue'];
      if (!keys.some(key => old.restTerms[key] !== next.restTerms[key])) continue;
      changed.push(date); months.add(date.slice(0, 7));
      if (old.type !== next.type) classifications.push(date + ' · ' + dayTypeName(old) + ' → ' + dayTypeName(next));
      if (state.logs[date]) recorded.push(date + ' · ' + L('Existing work record kept; terms will be recalculated', '原工作記錄保留；按新條款重新計算'));
    }
    const saved = state.statements.filter(s => months.has(s.inputs?.monthKey));
    const summary = changed.length ? changed[0] + ' – ' + changed.at(-1) + ' · ' + changed.length + L(' dates use changed terms', '個日期採用變更後條款') : L('No effective terms changed.', '生效條款沒有改變。');
    const estimates = [...months].map(key => {
      const [year, month] = key.split('-').map(Number), old = E.computeMonth(year, month, before, state.logs), next = E.computeMonth(year, month, after, state.logs);
      if (!old || !next) return '';
      const amount = stmt => stmt.estimateUnavailable ? L('Unavailable', '未能估算') : money(stmt.total);
      const ready = Compliance.assessMonth({ config: after, statement: next, logs: state.logs, adjustments: state.adjustments[key] || [], engine: E }).ready;
      return '<li>' + esc(key) + ': ' + amount(old) + ' → ' + amount(next) +
        (!old.estimateUnavailable && !next.estimateUnavailable ? ' (' + L('difference ', '差額 ') + money(next.total - old.total) + ')' : '') +
        (!ready ? ' · ' + L('Separate checks required', '仍須另行核對') : '') + '</li>';
    }).join('');
    return '<h3 class="mt">' + L('Impact before saving', '保存前查看影響') + '</h3><p>' + esc(summary) + '</p>' +
      '<p>' + L('Confirmed statements and payments are kept unchanged. ', '已確認結算及付款原樣保留。') + saved.length + L(' saved statement versions fall in the affected months; any revision must be reviewed separately.', '個已保存結算版本位於受影響月份，如須修訂，必須另行覆核。') + '</p>' +
      '<details class="mt"><summary>' + L('Monthly reference estimates (before → after)', '各月參考估算（修改前 → 修改後）') + '</summary><p class="muted small">' +
      L('These figures exclude separately recorded voluntary payments. They are not confirmed amounts due. An unchanged total does not mean rest-day requirements have been checked.', '此處未包含另記的自願款項，亦非已確認應付額。總額不變不代表休息日要求已核對。') + '</p><ul>' + estimates + '</ul></details>' +
      '<details class="mt"><summary>' + L('Dates changing classification: ', '分類改變的日期：') + classifications.length + '</summary><ul>' + classifications.map(text => '<li>' + esc(text) + '</li>').join('') + '</ul></details>' +
      '<details class="mt"><summary>' + L('Existing work records with changed terms: ', '條款改變的已有工作記錄：') + recorded.length + '</summary><ul>' + recorded.map(text => '<li>' + esc(text) + '</li>').join('') + '</ul></details>';
  }

  function openRestHistoryEditor(kind) {
    if (state.ui.helperMode) return;
    const config = state.config, original = Legal.checksum(config), profileId = Store.profiles.active();
    let preview = null, draft = PayHistory.restRows(config);
    if (kind === 'change') draft = [{ ...PayHistory.restAt(config, E.todayStr()), effectiveFrom: '' }];
    if (!draft.length) draft = [{ effectiveFrom: config.startDate }];
    const ov = openSheet('<h2>' + (kind === 'change' ? L('Change rest-day terms from a date', '由指定日期起變更休息日條款') : kind === 'confirm' ? L('Check and complete rest-day history', '核對並補齊休息日歷史') : L('Correct rest-day history', '更正休息日歷史')) + '</h2>' +
      '<p>' + (kind === 'change' ? L('Choose when the real agreement changed. Earlier dates and any later recorded changes are preserved.', '請選擇實際協議的生效日期。較早日期及已記錄的較後變更會保留。') :
        kind === 'confirm' ? L('Check actual agreements from the first work day. Add every change in date order; unknown periods must not be guessed.', '請核對由首個工作日起的實際協議，按日期逐段加入每次變更；未知期間不可猜填。') :
        L('Correct only input mistakes. Keep every effective period in date order from the contract start; give the reason and review the impact on older estimates.', '只更正輸入錯誤。由合約開始日起，按日期順序保留所有生效期間，填寫原因並覆核對舊估算的影響。')) + '</p>' +
      '<div id="rest-history-rows"></div>' + (kind !== 'change' ? '<button class="btn ghost mt" id="rest-history-add">' + L('Add an effective period', '加入生效期間') + '</button>' : '') +
      '<label for="rest-history-reason">' + L('Reason / agreement reference (required)', '原因／協議記錄（必填）') + '</label><textarea id="rest-history-reason"></textarea>' +
      '<p class="muted small">' + L('This records an existing agreement; it does not obtain consent or waive rest-day requirements. Existing individually agreed rest dates and holidays are not moved. Unpaid rest-day calculations remain unsupported.',
        '這只記錄已有協議，不會取得對方同意或豁免休息日要求。已逐日協議的休息日期及假日不會搬移，無薪休息日計算仍未支援。') + '</p>' +
      '<p id="rest-history-error" class="form-error" role="alert" hidden></p><button class="btn mt" id="rest-history-preview">' + L('Preview dates and amounts', '預覽日期及金額影響') + '</button>' +
      '<div id="rest-history-review" aria-live="polite"></div><button class="btn mt" id="rest-history-save" hidden>' + L('Confirm and save these terms', '確認並保存這些條款') + '</button>' +
      '<button class="btn ghost mt" id="rest-history-cancel">' + L('Cancel', '取消') + '</button>');
    const invalidate = () => { preview = null; ov.querySelector('#rest-history-save').hidden = true; ov.querySelector('#rest-history-review').innerHTML = ''; };
    const capture = () => draft = draft.map((row, i) => ({ effectiveFrom: ov.querySelector('#rh-date-' + i).value,
      restDayWeekday: ov.querySelector('#rh-weekday-' + i).value, restDayPayTerm: ov.querySelector('#rh-pay-' + i).value,
      restDayWorkArrangement: ov.querySelector('#rh-work-' + i).value, restDayWorkPayment: ov.querySelector('#rh-amount-' + i).value }));
    const draw = () => {
      ov.querySelector('#rest-history-rows').innerHTML = draft.map((row, i) => '<fieldset class="card"><legend>' + L('Period ', '期間 ') + (i + 1) + '</legend>' +
        '<label for="rh-date-' + i + '">' + L('Effective from', '生效日期') + '</label><input type="date" id="rh-date-' + i + '" min="' + esc(config.startDate) + '" max="' + esc(config.contractEndDate) + '" value="' + esc(row.effectiveFrom || '') + '">' +
        '<label for="rh-weekday-' + i + '">' + L('Weekly rest day', '每周休息日') + '</label><select id="rh-weekday-' + i + '"><option value="">' + L('Choose…', '請選擇……') + '</option>' + weekdays().map((day, n) => '<option value="' + n + '"' + (row.restDayWeekday !== '' && Number(row.restDayWeekday) === n ? ' selected' : '') + '>' + day + '</option>').join('') + '</select>' +
        '<label for="rh-pay-' + i + '">' + L('Rest-day pay term', '休息日薪酬條款') + '</label><select id="rh-pay-' + i + '"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="paid"' + (row.restDayPayTerm === 'paid' ? ' selected' : '') + '>' + L('Paid', '有薪') + '</option><option value="unpaid"' + (row.restDayPayTerm === 'unpaid' ? ' selected' : '') + '>' + L('Unpaid', '無薪') + '</option></select>' +
        '<label for="rh-work-' + i + '">' + L('Agreed arrangement for rest-day work', '休息日工作之雙方協議安排') + '</label><select id="rh-work-' + i + '"><option value="">' + L('Choose…', '請選擇……') + '</option><option value="agreed_payment"' + (row.restDayWorkArrangement === 'agreed_payment' ? ' selected' : '') + '>' + L('Agreed cash amount', '雙方同意現金金額') + '</option><option value="substituted_rest_day"' + (row.restDayWorkArrangement === 'substituted_rest_day' ? ' selected' : '') + '>' + L('Substituted rest day', '補回休息日') + '</option></select>' +
        '<div id="rh-amount-row-' + i + '"' + (row.restDayWorkArrangement !== 'agreed_payment' ? ' hidden' : '') + '><label for="rh-amount-' + i + '">' + L('Agreed amount per full day worked (HK$)', '每全日工作的協議金額（港幣）') + '</label><input type="number" inputmode="decimal" step="0.01" id="rh-amount-' + i + '" value="' + esc(row.restDayWorkPayment ?? '') + '"></div>' +
        (kind !== 'change' && i > 0 ? '<button class="btn ghost mt" data-remove-rest-period="' + i + '">' + L('Remove this draft period', '移除此草稿期間') + '</button>' : '') + '</fieldset>').join('');
      draft.forEach((row, i) => ov.querySelector('#rh-work-' + i).onchange = () => { ov.querySelector('#rh-amount-row-' + i).hidden = ov.querySelector('#rh-work-' + i).value !== 'agreed_payment'; });
      ov.querySelectorAll('[data-remove-rest-period]').forEach(button => button.onclick = () => { capture(); draft.splice(Number(button.dataset.removeRestPeriod), 1); invalidate(); draw(); ov._dirty = true; });
    };
    draw(); ov.addEventListener('input', invalidate); ov.addEventListener('change', invalidate);
    const add = ov.querySelector('#rest-history-add');
    if (add) add.onclick = () => { capture(); draft.push({ effectiveFrom: '' }); invalidate(); draw(); ov._dirty = true; };
    const fail = (text, field) => {
      const box = ov.querySelector('#rest-history-error'); box.hidden = false; box.textContent = text;
      const input = field === 'reason' ? ov.querySelector('#rest-history-reason') : ov.querySelector('#rh-' + field);
      if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    };
    ov.querySelector('#rest-history-preview').onclick = () => {
      capture(); invalidate();
      const result = PayHistory.prepareRest(config, draft, { kind, reason: ov.querySelector('#rest-history-reason').value, id: uid(), recordedAt: new Date().toISOString() });
      if (result.errors.length) {
        const error = result.errors[0], messages = {
          reason: L('Enter the reason or agreement reference.', '請填寫原因或協議記錄。'),
          date: L('Use real, distinct dates in order within the contract. A corrected history must start on the contract start date.', '請使用合約期內的有效日期，按順序排列且不可重複。更正歷史須由合約開始日起填寫。'),
          existing_date: L('There is already a period starting on this date. Use correction to fix an earlier input mistake.', '該日期已有期間開始；如要更正舊輸入，請使用更正流程。'),
          history_first: L('Earlier terms are incomplete. Cancel and choose correction to review them first.', '較早條款不完整，請取消並選擇更正，先核對舊條款。'),
          weekday: L('Choose the agreed weekly rest day.', '請選擇已協議的每周休息日。'),
          pay: L('Choose the actual paid or unpaid rest-day term.', '請選擇實際有薪或無薪休息日條款。'),
          work: L('Choose the actual agreed work arrangement.', '請選擇實際協議的工作安排。'),
          amount: L('Enter a positive agreed cash amount.', '請輸入大於零的協議現金金額。') };
        fail(messages[error.code] || L('Check the contract dates first.', '請先核對合約日期。'), error.field); return;
      }
      preview = result.next; ov.querySelector('#rest-history-error').hidden = true;
      ov.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
      ov.querySelector('#rest-history-review').innerHTML = restHistoryHtml(preview) + restHistoryImpactHtml(config, preview);
      ov.querySelector('#rest-history-save').hidden = false;
      ov.querySelector('#rest-history-review').scrollIntoView({ block: 'start' });
    };
    ov.querySelector('#rest-history-save').onclick = () => {
      if (!requireMembership()) return;
      if (!preview || state.ui.helperMode || Store.profiles.active() !== profileId || Legal.checksum(state.config) !== original) {
        fail(L('The data changed. Close and reopen this form, then preview again.', '資料已改變，請關閉再打開此表格，重新預覽。')); return;
      }
      try { Store.saveConfig(preview); state.config = preview; closeSheet(ov); render();
        toast(L('Dated rest-day terms saved. Existing statements and payments are unchanged.', '休息日生效條款已保存，原有結算及付款未改動。')); }
      catch { fail(L('Could not save. Your entries remain here and the original terms are unchanged. Check storage and retry.', '未能保存，已填內容仍在，原有條款未改動。請檢查儲存空間後重試。')); }
    };
    ov.querySelector('#rest-history-cancel').onclick = () => closeSheet(ov);
  }

  function bindSettings() {
    organizeSettings();
    const c = state.config;
    $$('#view [data-settings-editor]').forEach(button=>button.onclick=()=>openSettingsEditor(button.dataset.settingsEditor));
    const winter = $('#st-winter');
    winter.onclick = () => { openCalendarReviewSheet(c.winterHolidayChoice || '');$('#calendar-choice')?.focus(); };

    const analytics = $('#st-analytics');
    if (analytics) analytics.onchange = () => {
      const before=state.ui.analyticsConsent;
      state.ui.analyticsConsent = analytics.checked;
      try { saveUi(); }
      catch { state.ui.analyticsConsent=before;analytics.checked=before===true;toast(L('Privacy preference was not saved. The previous choice is kept; retry here.','私隱選項未能保存，原有選擇保留，請在此重試。'));return; }
      if (window.HSAnalytics) window.HSAnalytics.setConsent(analytics.checked);
      toast(analytics.checked
        ? L('Anonymous statistics enabled', '已啟用匿名統計')
        : L('Anonymous statistics disabled', '已停用匿名統計'));
    };

    const confirmTerms = $('#st-confirm-terms');
    if (confirmTerms) confirmTerms.onclick = openPayHistorySheet;
    const restTerms = $('#st-rest-history');
    if (restTerms) restTerms.onclick = openRestHistorySheet;

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

  // ---------- release updates ----------

  // A waiting service worker means newer code is already deployed while this
  // page keeps running the previous calculation rules and legal gates. That is
  // how a superseded wage figure outlives a release, so the page says so and
  // lets the user reload instead of switching code under an open form.
  function pendingUpdate(registration, hasController) {
    // Without an existing controller this is a first install: there is no older
    // page to protect, and the worker activates on its own.
    if (!registration || !registration.waiting || !hasController) return null;
    return registration.waiting;
  }

  function showUpdateBanner(onReload) {
    if ($('#update-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'update-banner';
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = L('New version ready. Reload before confirming pay.',
      '已有新版本，確認薪金前請重新載入。');
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'update-reload';
    button.className = 'btn compact';
    button.textContent = L('Reload', '重新載入');
    button.onclick = onReload;
    bar.append(text, button);
    document.body.appendChild(bar);
    // Shift the page down by the banner's real height instead of covering the
    // sticky header, which carries the employer / helper mode control.
    const height = bar.getBoundingClientRect().height;
    if (height) document.documentElement.style.setProperty('--update-banner-h', height + 'px');
    document.body.classList.add('update-pending');
  }

  function watchForUpdates(registration, scope) {
    const nav = scope.navigator.serviceWorker;
    let awaitingReload = false;
    nav.addEventListener('controllerchange', () => {
      // Only reload for an update the user just accepted; a first install also
      // changes the controller and must not discard what they are typing.
      if (!awaitingReload) return;
      awaitingReload = false;
      scope.location.reload();
    });
    const offer = () => {
      const waiting = pendingUpdate(registration, !!nav.controller);
      if (!waiting) return;
      showUpdateBanner(() => { awaitingReload = true; waiting.postMessage({ type: 'SKIP_WAITING' }); });
    };
    offer();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => { if (installing.state === 'installed') offer(); });
    });
  }

  // ---------- boot ----------

  document.addEventListener('DOMContentLoaded', () => {
    $('#mode-chip').onclick = toggleMode;
    render();
    if (false) { // Demo assets are only loaded from the current package; no service worker.
      navigator.serviceWorker.register('sw.js').then(registration => {
        if (registration) watchForUpdates(registration, window);
      }).catch(() => {});
    }
  });
})();
