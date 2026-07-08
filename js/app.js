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
  const Store = window.HSStore;
  const Holidays = window.HSHolidays;

  const APP_VERSION = '0.4.0-beta';
  const FEEDBACK_EMAIL = 'admin@adflow.vip';
  const WHATSAPP_DISPLAY = '+852 5229 5286';
  const WHATSAPP_URL = 'https://wa.me/85252295286?text=' +
    encodeURIComponent('Hi! I’m using HelperPay — ');

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEKDAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // ---------- state ----------

  Store.migrate(); // legacy single-helper data -> profile layout

  const state = {
    config: Store.loadConfig(),
    logs: Store.loadLogs(),
    payments: Store.loadPayments(),
    adjustments: Store.loadAdjustments(),
    ui: Object.assign({ view: 'today', helperMode: false }, Store.loadUi()),
    addingProfile: false,          // true while the "add another helper" setup is open
    pendingEmployerDefaults: null  // employer name/PIN carried into a new profile
  };

  function loadActiveProfile() {
    state.config = Store.loadConfig();
    state.logs = Store.loadLogs();
    state.payments = Store.loadPayments();
    state.adjustments = Store.loadAdjustments();
  }
  const now = new Date();
  state.calY = now.getFullYear(); state.calM = now.getMonth() + 1;
  state.salY = now.getFullYear(); state.salM = now.getMonth() + 1;

  const objectUrls = new Map(); // fileId -> objectURL cache

  // ---------- tiny helpers ----------

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function money(x) { return E.fmtMoney(x); }

  function fmtDate(ds) {
    const p = E.parseYmd(ds);
    const wd = WEEKDAYS[E.weekdayOf(ds)].slice(0, 3);
    return wd + ', ' + p.d + ' ' + MONTHS[p.m - 1].slice(0, 3) + ' ' + p.y;
  }

  function fmtDateShort(ds) {
    const p = E.parseYmd(ds);
    return p.d + ' ' + MONTHS[p.m - 1].slice(0, 3);
  }

  function daysLabel(d, signed) {
    const sign = signed || '';
    if (d === 0.5) return sign + '½ day';
    return sign + d + ' day' + (d === 1 ? '' : 's');
  }

  function saveUi() { Store.saveUi({ view: state.ui.view, helperMode: state.ui.helperMode }); }
  function saveConfig() { Store.saveConfig(state.config); }
  function saveLogs() { Store.saveLogs(state.logs); }
  function savePayments() { Store.savePayments(state.payments); }
  function saveAdjustments() { Store.saveAdjustments(state.adjustments); }

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
        '<button class="btn ghost" data-act="no">Cancel</button>' +
        '<button class="btn ' + (danger ? 'danger' : '') + '" data-act="yes">' + esc(confirmLabel || 'Confirm') + '</button>' +
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
        '<button class="btn ghost" data-act="no">Cancel</button>' +
        '<button class="btn" data-act="yes">OK</button>' +
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
        { work: 1, label: 'Worked', sub: 'Normal working day', amt: 'paid', cl: 'zero' },
        { work: 0.5, label: 'Half-day leave', sub: 'Ordinary unpaid leave', amt: '−½ day', cl: 'minus' },
        { work: 0, label: 'Full-day leave', sub: 'Ordinary unpaid leave', amt: '−1 day', cl: 'minus' }
      ];
    }
    const what = cls.type === 'rest' ? 'Rest day' : 'Holiday';
    return [
      { work: 0, label: what + ' taken', sub: 'Paid, no deduction', amt: 'paid', cl: 'zero' },
      { work: 0.5, label: 'Worked half day', sub: 'Extra pay for ' + what.toLowerCase() + ' work', amt: '+½ day', cl: 'plus' },
      { work: 1, label: 'Worked full day', sub: 'Extra pay for ' + what.toLowerCase() + ' work', amt: '+1 day', cl: 'plus' }
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
      if (!existing && work === def && !noteVal) return;
      const entry = { work: work, by: 'helper', status: 'pending', at: new Date().toISOString() };
      if (noteVal) entry.note = noteVal;
      state.logs[ds] = entry;
    } else {
      if (work === def && !noteVal) {
        delete state.logs[ds]; // matches default — keep the log clean
      } else {
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
    if (entry.work === E.defaultWork(cls.type) && !entry.note) {
      delete state.logs[ds];
    } else {
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
      if (w === 1) return 'Worked — normal day (no pay change)';
      return w === 0.5 ? 'Half-day leave (−½ day)' : 'Full-day leave (−1 day)';
    }
    const label = E.describeType(cls);
    if (w === 0) return label + ' taken (paid, no extra)';
    return label + ' — worked' + (w === 0.5 ? ' half day (+½ day)' : ' (+1 day)');
  }

  function logStatusBadge(entry) {
    if (!entry || !entry.status) return '';
    if (entry.status === 'pending') return '<span class="badge pending">⏳ Awaiting employer approval</span>';
    if (entry.by === 'helper') return '<span class="badge approved">✓ Approved</span>';
    return '';
  }

  function dayBadges(cls) {
    let out = '';
    if (cls.isRest) out += '<span class="badge rest">Rest day</span> ';
    if (cls.holiday) out += '<span class="badge holiday">' + esc(cls.holiday.name) + '</span> ';
    if (!cls.isRest && !cls.holiday) out += '<span class="badge normal">Working day</span> ';
    return out;
  }

  function openDaySheet(ds) {
    if (!E.isEmployedOn(ds, state.config)) { toast('Outside employment period'); return; }
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
        (cls.isRest ? 'Not a rest day this week' : 'Mark as rest day') + '</button>' +
        '<p class="muted small" style="margin-top:6px">Use this when the agency confirms a different rest-day date.</p>'
      : '';

    const holidayHint = cls.holiday
      ? '<p class="muted small mt">⚖️ If this statutory holiday is worked: extra pay is added to the statement, ' +
        'and the law also requires an alternative day off within 60 days (cash cannot replace it). ' +
        'The Today tab tracks owed days off.</p>'
      : '';

    const approveBtn = !state.ui.helperMode && entry.status === 'pending'
      ? '<button class="btn mt" id="day-approve" style="background:var(--green)">✓ Approve ' +
        esc(state.config.helperName || 'helper') + '’s log</button>'
      : '';

    const ov = openSheet(
      '<h2>' + esc(fmtDate(ds)) + '</h2>' +
      '<div class="mt">' + dayBadges(cls) + ' ' + logStatusBadge(entry) + '</div>' +
      '<div class="choice-list">' + choicesHtml + '</div>' +
      '<label>Note (optional)</label>' +
      '<input id="day-note" placeholder="e.g. agency confirmed, doctor visit…" value="' + esc(entry.note || '') + '">' +
      holidayHint +
      restToggle +
      approveBtn +
      '<button class="btn' + (approveBtn ? ' secondary' : '') + ' mt" id="day-save">Save</button>'
    );

    const ap = ov.querySelector('#day-approve');
    if (ap) {
      ap.onclick = () => {
        approveLog(ds);
        closeSheet(ov);
        toast('Approved — ' + fmtDateShort(ds) + ' ✓');
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
        const wdRule = E.weekdayOf(ds) === (state.config.restDayWeekday == null ? 0 : state.config.restDayWeekday);
        const newVal = !cls.isRest;
        if (newVal === wdRule) delete state.config.restDayOverrides[ds];
        else state.config.restDayOverrides[ds] = newVal;
        saveConfig();
        delete state.logs[ds]; // day type changed; stale log defaults no longer apply
        saveLogs();
        closeSheet(ov);
        toast(newVal ? 'Marked as rest day' : 'Rest day removed');
        render();
        openDaySheet(ds);
      };
    }

    ov.querySelector('#day-save').onclick = () => {
      setWork(ds, cls, selected, ov.querySelector('#day-note').value);
      closeSheet(ov);
      toast(state.ui.helperMode
        ? 'Sent to employer for approval — ' + fmtDateShort(ds)
        : 'Saved — ' + fmtDateShort(ds));
      render();
    };
  }

  // ---------- payments & adjustments ----------

  function monthAdjustments(key) { return state.adjustments[key] || []; }
  function monthPayments(key) { return state.payments.filter(p => p.monthKey === key); }

  function monthDue(stmt) {
    let due = stmt.totalExact;
    monthAdjustments(stmt.key).forEach(a => { due += a.amount; });
    return due;
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

  function openPaymentSheet(stmt) {
    const balance = monthDue(stmt) - monthPaid(stmt.key);
    const ov = openSheet(
      '<h2>Record payment — ' + MONTHS[stmt.month - 1] + ' ' + stmt.year + '</h2>' +
      '<label>Amount (HK$)</label>' +
      '<input id="pay-amount" type="number" step="0.01" inputmode="decimal" value="' + E.round2(Math.max(balance, 0)) + '">' +
      '<label>Payment date</label>' +
      '<input id="pay-date" type="date" value="' + E.todayStr() + '">' +
      '<label>Method</label>' +
      '<select id="pay-method"><option>FPS</option><option>Bank transfer</option><option>Cash</option><option>Cheque</option><option>Other</option></select>' +
      '<label>Note (optional)</label>' +
      '<input id="pay-note" placeholder="e.g. includes May correction −HK$76.18">' +
      '<label>Payment screenshot(s)</label>' +
      '<input id="pay-files" type="file" accept="image/*" multiple>' +
      '<button class="btn mt" id="pay-save">Save payment</button>'
    );
    ov.querySelector('#pay-save').onclick = async () => {
      const amount = parseFloat(ov.querySelector('#pay-amount').value);
      if (!(amount > 0)) { toast('Enter an amount'); return; }
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
        createdAt: new Date().toISOString()
      };
      ov.querySelector('#pay-save').textContent = 'Saving…';
      await attachFiles(payment, ov.querySelector('#pay-files').files);
      state.payments.push(payment);
      savePayments();
      HSTrack('payment-recorded');
      closeSheet(ov);
      toast('Payment recorded — ask ' + (state.config.helperName || 'helper') + ' to approve');
      render();
    };
  }

  function openApprovalSheet(paymentId) {
    const payment = state.payments.find(p => p.id === paymentId);
    if (!payment) return;
    const needPin = !!state.config.helperPin;
    const ov = openSheet(
      '<h2>Payment approval</h2>' +
      '<p class="muted">' + esc(state.config.helperName || 'Helper') + ', please confirm you received this salary payment.</p>' +
      '<div class="approve-amount">' + money(payment.amount) + '</div>' +
      '<p class="muted small">' + esc(monthLabel(payment.monthKey)) + ' salary · paid ' + esc(fmtDate(payment.date)) +
      ' · ' + esc(payment.method) + (payment.note ? ' · ' + esc(payment.note) : '') + '</p>' +
      '<div class="thumbs" id="appr-thumbs"></div>' +
      '<label>Your name</label>' +
      '<input id="appr-name" value="' + esc(state.config.helperName || '') + '">' +
      (needPin ? '<label>Your PIN</label><input id="appr-pin" type="password" inputmode="numeric" maxlength="6">' : '') +
      '<button class="btn mt" id="appr-ok">✓ I confirm I received this payment</button>' +
      '<button class="btn ghost mt" id="appr-cancel">Not now</button>'
    );
    loadThumbs(ov.querySelector('#appr-thumbs'), payment);
    ov.querySelector('#appr-cancel').onclick = () => closeSheet(ov);
    ov.querySelector('#appr-ok').onclick = () => {
      const name = ov.querySelector('#appr-name').value.trim();
      if (!name) { toast('Please enter your name'); return; }
      if (needPin && ov.querySelector('#appr-pin').value !== state.config.helperPin) {
        toast('Wrong PIN'); return;
      }
      payment.status = 'approved';
      payment.approval = { name: name, at: new Date().toISOString(), pinVerified: needPin };
      savePayments();
      HSTrack('payment-approved');
      closeSheet(ov);
      toast('Approved ✓ Thank you!');
      render();
    };
  }

  function openAdjustmentSheet(stmt) {
    const ov = openSheet(
      '<h2>Add adjustment — ' + MONTHS[stmt.month - 1] + ' ' + stmt.year + '</h2>' +
      '<p class="muted small mt">Use for corrections, e.g. “May over-payment correction −76.18”. Negative = deduct, positive = add.</p>' +
      '<label>Description</label>' +
      '<input id="adj-label" placeholder="e.g. Correction for May over-payment">' +
      '<label>Amount (HK$, use − for deduction)</label>' +
      '<input id="adj-amount" type="number" step="0.01" inputmode="decimal" placeholder="-76.18">' +
      '<button class="btn mt" id="adj-save">Add adjustment</button>'
    );
    ov.querySelector('#adj-save').onclick = () => {
      const label = ov.querySelector('#adj-label').value.trim();
      const amount = parseFloat(ov.querySelector('#adj-amount').value);
      if (!label || isNaN(amount)) { toast('Enter description and amount'); return; }
      if (!state.adjustments[stmt.key]) state.adjustments[stmt.key] = [];
      state.adjustments[stmt.key].push({ id: uid(), label: label, amount: E.round2(amount) });
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
      img.alt = 'payment screenshot';
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
    return MONTHS[+p[1] - 1] + ' ' + p[0];
  }

  // ---------- alternative day off for statutory-holiday work ----------

  // EO rule: working a statutory holiday requires an alternative day off
  // within 60 days — cash in lieu is prohibited (fine HK$50,000).
  function openScheduleAltSheet(owedItem) {
    const ov = openSheet(
      '<h2>Schedule day off in lieu</h2>' +
      '<p class="muted mt">' + esc(state.config.helperName || 'Helper') + ' worked <b>' +
      esc(owedItem.name) + '</b> on ' + esc(fmtDate(owedItem.date)) + '. ' +
      'The law requires an alternative day off within 60 days (by ' + esc(fmtDate(owedItem.deadline)) + ') — ' +
      'extra pay is welcome but cannot replace the day off.</p>' +
      '<label>Day off in lieu</label>' +
      '<input id="alt-date" type="date" min="' + esc(E.addDays(owedItem.date, -60)) + '" max="' + esc(owedItem.deadline) + '">' +
      '<p class="muted small" style="margin-top:6px">Pick a normal working day within 60 days of the holiday. She takes that day off with full pay.</p>' +
      '<button class="btn mt" id="alt-save">Schedule day off</button>'
    );
    ov.querySelector('#alt-save').onclick = () => {
      const date = ov.querySelector('#alt-date').value;
      if (!date) { toast('Pick a date'); return; }
      if (date < E.addDays(owedItem.date, -60) || date > owedItem.deadline) {
        toast('Must be within 60 days of the holiday'); return;
      }
      const cls = E.classifyDay(date, state.config);
      if (cls.type !== 'normal') { toast('Pick a normal working day (not a rest day or holiday)'); return; }
      state.config.holidays.push({
        date: date,
        name: 'Day off in lieu — ' + owedItem.name + ' (' + fmtDateShort(owedItem.date) + ')',
        altFor: owedItem.date
      });
      state.config.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
      saveConfig();
      closeSheet(ov);
      toast('Day off scheduled — ' + fmtDateShort(date) + ' ✓');
      render();
    };
  }

  function owedCardHtml() {
    const owed = E.owedAlternativeHolidays(state.config, state.logs)
      .filter(o => !o.scheduled);
    if (!owed.length) return '';
    const rows = owed.map((o, i) =>
      '<div class="pending-row" style="cursor:default">' +
      '<div class="grow"><b>' + esc(fmtDate(o.date)) + ' · ' + esc(o.name) + '</b>' +
      '<div class="' + (o.overdue ? '' : 'muted') + ' small"' + (o.overdue ? ' style="color:var(--red);font-weight:700"' : '') + '>' +
      (o.overdue ? 'OVERDUE — was due by ' : 'Day off due by ') + esc(fmtDate(o.deadline)) + '</div></div>' +
      (!state.ui.helperMode
        ? '<button class="btn compact" data-schedule-alt="' + i + '">Schedule</button>'
        : '') +
      '</div>').join('');
    return '<div class="card">' +
      '<h2>⚖️ ' + (state.ui.helperMode
        ? 'Days off owed to you (' + owed.length + ')'
        : 'Day off owed for holiday work (' + owed.length + ')') + '</h2>' +
      rows +
      '<p class="muted small mt">' + (state.ui.helperMode
        ? 'You worked these statutory holidays — the law says you get another day off within 60 days, on top of any extra pay.'
        : 'Working a statutory holiday needs 48-hour notice and an alternative day off within 60 days. Paying cash instead of the day off is prohibited (fine HK$50,000) — extra pay on top is fine and already in the statement.') +
      '</p></div>';
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
        toast('Holidays synced — ' + result.added + ' new date' + (result.added === 1 ? '' : 's') + ' from HK Gov');
        render();
      } else if (!opts.silent) {
        toast('Holidays already up to date');
        render();
      }
      return result.added;
    } catch (err) {
      if (!opts.silent) toast('Holiday sync failed — check your connection');
      return -1;
    }
  }

  function maybeAutoSyncHolidays() {
    if (!state.config || !navigator.onLine) return;
    const last = state.config.lastHolidaySync;
    if (last && Date.now() - new Date(last).getTime() < 30 * 86400000) return;
    syncHolidays({ silent: true });
  }

  // ---------- views ----------

  function render() {
    renderHeader();
    renderTabbar();
    const view = $('#view');
    if (!state.config || state.addingProfile) { view.innerHTML = setupHtml(); bindSetup(); return; }
    if (state.ui.helperMode && state.ui.view === 'settings') state.ui.view = 'today';
    switch (state.ui.view) {
      case 'today': view.innerHTML = todayHtml(); bindToday(); break;
      case 'calendar': view.innerHTML = calendarHtml(); bindCalendar(); break;
      case 'salary': view.innerHTML = salaryHtml(); bindSalary(); break;
      case 'settings': view.innerHTML = settingsHtml(); bindSettings(); break;
    }
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
      ? '👩 ' + (state.config.helperName || 'Helper')
      : '🔑 Employer';
  }

  function renderTabbar() {
    const bar = $('#tabbar');
    if (!state.config) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const tabs = [
      { id: 'today', ico: '📝', label: 'Today' },
      { id: 'calendar', ico: '📅', label: 'Calendar' },
      { id: 'salary', ico: '💵', label: 'Salary' }
    ];
    if (!state.ui.helperMode) tabs.push({ id: 'settings', ico: '⚙️', label: 'Settings' });
    bar.innerHTML = tabs.map(t =>
      '<button data-tab="' + t.id + '" class="' + (state.ui.view === t.id ? 'active' : '') + '">' +
      '<span class="ico">' + t.ico + '</span>' + t.label + '</button>').join('');
    bar.querySelectorAll('button').forEach(b => {
      b.onclick = () => { state.ui.view = b.dataset.tab; saveUi(); render(); };
    });
  }

  // ----- setup (first run) -----

  function setupHtml() {
    const today = E.todayStr();
    const adding = state.addingProfile;
    return '' +
      (adding
        ? '<div class="hero"><div class="logo">👩‍👩‍👧</div><h1>Add another helper</h1>' +
          '<p>She gets her own calendar, salary statements,<br>payments and PIN.</p></div>'
        : '<div class="hero"><img class="logo-img" src="icon.svg" alt="HelperPay"><h1>HelperPay</h1>' +
          '<p>Salary tracking for your domestic helper,<br>the Hong Kong Employment Ordinance way.</p></div>') +
      '<div class="card">' +
      '<label>Helper\'s name</label><input id="su-helper" placeholder="e.g. Maria">' +
      '<label>Monthly wage (HK$)</label><input id="su-wage" type="number" inputmode="decimal" value="5100">' +
      '<p class="muted small" style="margin-top:4px">Minimum Allowable Wage for contracts signed from Sep 2025 is HK$5,100 — check the current rate when you sign.</p>' +
      '<label>Food allowance (HK$/month, 0 if food provided)</label><input id="su-food" type="number" inputmode="decimal" value="0">' +
      '<label>First day of work</label><input id="su-start" type="date" value="' + today + '">' +
      '<label>Weekly rest day</label><select id="su-rest">' +
      WEEKDAYS.map((w, i) => '<option value="' + i + '"' + (i === 0 ? ' selected' : '') + '>' + w + '</option>').join('') +
      '</select>' +
      '<button class="btn mt" id="su-create">' + (state.addingProfile ? 'Add helper' : 'Start tracking') + '</button>' +
      (state.addingProfile ? '<button class="btn ghost mt" id="su-cancel">Cancel</button>' : '') +
      '<p class="muted small mt">2026 Hong Kong statutory holidays are prefilled automatically. Everything can be changed later in Settings.</p>' +
      (state.addingProfile ? '' :
        '<p class="muted small mt">Questions? <a href="' + WHATSAPP_URL + '" target="_blank" rel="noopener" style="color:var(--accent)">WhatsApp ' + WHATSAPP_DISPLAY + '</a></p>') +
      '</div>';
  }

  function bindSetup() {
    const cancel = $('#su-cancel');
    if (cancel) cancel.onclick = () => {
      state.addingProfile = false;
      state.pendingEmployerDefaults = null;
      loadActiveProfile();
      render();
    };

    $('#su-create').onclick = () => {
      const wage = parseFloat($('#su-wage').value);
      const start = $('#su-start').value;
      if (!(wage > 0) || !start) { toast('Please fill wage and start date'); return; }
      const defaults = state.pendingEmployerDefaults || {};

      const id = Store.profiles.create();
      Store.profiles.setActive(id);
      state.config = {
        helperName: $('#su-helper').value.trim(),
        employerName: defaults.employerName || '',
        monthlyWage: wage,
        foodAllowance: parseFloat($('#su-food').value) || 0,
        startDate: start,
        endDate: '',
        restDayWeekday: +$('#su-rest').value,
        restDayOverrides: {},
        holidays: Holidays.defaultHolidays(),
        helperPin: '',
        employerPin: defaults.employerPin || '',
        lastBackupAt: null,
        createdAt: new Date().toISOString()
      };
      state.logs = {};
      state.payments = [];
      state.adjustments = {};
      state.addingProfile = false;
      state.pendingEmployerDefaults = null;
      saveConfig();
      saveLogs();
      savePayments();
      saveAdjustments();
      HSTrack('setup-completed');
      toast(state.config.helperName ? 'Welcome, ' + state.config.helperName + '! 🎉' : 'Welcome! 🎉');
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
        '<p class="muted mt">Outside the employment period.</p></div>';
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
        (entry && entry.note ? '<p class="muted small mt">Note: ' + esc(entry.note) + '</p>' : '') +
        '<button class="btn ghost compact mt" id="today-more">Add a note / more options</button>' +
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
          ? 'Waiting for employer approval (' + pend.length + ')'
          : '⏳ ' + esc(state.config.helperName || 'Helper') + '’s logs to approve (' + pend.length + ')') + '</h2>' +
        rows +
        (!state.ui.helperMode && pend.length > 1
          ? '<button class="btn secondary compact mt" id="approve-all-logs">Approve all ' + pend.length + '</button>'
          : '') +
        '</div>';
    }

    // this-month summary (always the real current month, not the browsed one)
    const today = E.parseYmd(ds);
    const stmt = E.computeMonth(today.y, today.m, state.config, state.logs);
    let summary = '';
    if (stmt) {
      summary = '<div class="card">' +
        '<h2>' + MONTHS[stmt.month - 1] + ' so far</h2>' +
        '<div class="stat-row">' +
        '<div class="stat"><div class="v plus">+' + (stmt.allowanceDays || 0) + 'd</div><div class="k">Extra work</div></div>' +
        '<div class="stat"><div class="v minus">−' + (stmt.deductionDays || 0) + 'd</div><div class="k">Leave</div></div>' +
        '<div class="stat"><div class="v">' + money(stmt.total) + '</div><div class="k">Projected salary</div></div>' +
        '</div>' +
        '<p class="muted small mt">Only exceptions need logging — normal working days count automatically.</p>' +
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
      upcoming = '<div class="card"><h2>Coming up</h2>' + items.join('') + '</div>';
    }

    return dayCard + pendingCard + owedCardHtml() + summary + upcoming;
  }

  function bindToday() {
    const owed = E.owedAlternativeHolidays(state.config, state.logs).filter(o => !o.scheduled);
    $$('#view [data-schedule-alt]').forEach(b => {
      b.onclick = () => openScheduleAltSheet(owed[+b.dataset.scheduleAlt]);
    });
    $$('#view [data-approve-log]').forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        approveLog(b.dataset.approveLog);
        toast('Approved ✓');
        render();
      };
    });
    const all = $('#approve-all-logs');
    if (all) all.onclick = () => {
      const n = pendingLogDates().length;
      pendingLogDates().forEach(approveLog);
      toast(n + ' logs approved ✓');
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
        const entry = state.logs[ds];
        setWork(ds, cls, parseFloat(btn.dataset.work), entry && entry.note);
        toast(state.ui.helperMode ? 'Sent for approval ✓' : 'Saved ✓');
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

    return '<div class="card">' +
      '<div class="cal-head">' +
      '<button class="nav-btn" id="cal-prev">‹</button>' +
      '<div class="title">' + MONTHS[m - 1] + ' ' + y + '</div>' +
      '<button class="nav-btn" id="cal-next">›</button>' +
      '</div>' +
      '<div class="cal-grid">' +
      WEEKDAYS_SHORT.map((w, i) => '<div class="cal-dow' + (i === 0 ? ' sun' : '') + '">' + w + '</div>').join('') +
      cells +
      '</div>' +
      '<div class="cal-legend">' +
      '<span class="item"><span class="dot rest"></span> Rest day</span>' +
      '<span class="item"><span class="dot holiday"></span> Statutory holiday</span>' +
      '<span class="item"><span class="mark plus">+1</span> Extra work</span>' +
      '<span class="item"><span class="mark minus">−1</span> Leave</span>' +
      '</div>' +
      '<p class="muted small mt">Tap any day to log work, leave, or rest-day changes.</p>' +
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
  }

  // ----- salary -----

  function salaryHtml() {
    const y = state.salY, m = state.salM;
    const stmt = E.computeMonth(y, m, state.config, state.logs);

    const head = '<div class="card"><div class="cal-head">' +
      '<button class="nav-btn" id="sal-prev">‹</button>' +
      '<div class="title">' + MONTHS[m - 1] + ' ' + y + '</div>' +
      '<button class="nav-btn" id="sal-next">›</button>' +
      '</div>';

    if (!stmt) {
      return head + '<p class="muted">No employment in this month.</p></div>';
    }

    const adjustments = monthAdjustments(stmt.key);
    const payments = monthPayments(stmt.key);
    const due = monthDue(stmt);
    const paid = monthPaid(stmt.key);
    const balance = E.round2(due - paid);
    const helperMode = state.ui.helperMode;

    const allowLines = stmt.lines.filter(l => l.kind === 'allowance');
    const dedLines = stmt.lines.filter(l => l.kind === 'deduction');

    let html = head;
    html += '<p class="muted small">' + esc(fmtDateShort(stmt.periodStart)) + ' – ' + esc(fmtDateShort(stmt.periodEnd)) +
      (stmt.partial ? ' · partial month (' + stmt.periodDays + ' days)' : '') + '</p>';
    html += '<p class="muted small">Daily wage: ' + money(state.config.monthlyWage) + ' × 12 ÷ 365 = HK$' +
      stmt.dailyWage.toFixed(4) + '</p>';

    html += '<div class="mt">';
    html += '<div class="stmt-line"><span class="lbl"><b>Base pay</b>' +
      (stmt.partial ? ' (' + stmt.periodDays + ' days × daily wage)' : ' (monthly wage)') + '</span>' +
      '<span class="val">' + money(stmt.base) + '</span></div>';

    const pendTag = l => (l.pending ? ' <span class="badge pending">pending</span>' : '');
    allowLines.forEach(l => {
      html += '<div class="stmt-line sub"><span class="lbl">' + esc(fmtDateShort(l.date)) + ' · ' + esc(l.label) + pendTag(l) + '</span>' +
        '<span class="val plus">+' + money(l.days * stmt.dailyWage) + '</span></div>';
    });
    dedLines.forEach(l => {
      html += '<div class="stmt-line sub"><span class="lbl">' + esc(fmtDateShort(l.date)) + ' · ' + esc(l.label) + pendTag(l) + '</span>' +
        '<span class="val minus">−' + money(l.days * stmt.dailyWage) + '</span></div>';
    });
    if (stmt.food > 0) {
      html += '<div class="stmt-line"><span class="lbl"><b>Food allowance</b></span><span class="val">+' + money(stmt.food) + '</span></div>';
    }
    adjustments.forEach(a => {
      html += '<div class="stmt-line"><span class="lbl"><b>Adjustment</b> · ' + esc(a.label) + '</span>' +
        '<span class="val ' + (a.amount >= 0 ? 'plus' : 'minus') + '">' + (a.amount >= 0 ? '+' : '−') + money(Math.abs(a.amount)) +
        (!helperMode ? ' <button class="del" data-del-adj="' + a.id + '" style="color:var(--red);font-weight:800">×</button>' : '') +
        '</span></div>';
    });
    html += '</div>';

    if (stmt.pendingCount > 0) {
      html += '<div class="banner mt">⏳ ' + stmt.pendingCount + ' day log' + (stmt.pendingCount === 1 ? '' : 's') +
        ' in this month still need' + (stmt.pendingCount === 1 ? 's' : '') +
        ' employer approval — see the Today tab. The total below already includes them.</div>';
    }

    html += '<div class="stmt-total"><span>Total due</span><span class="amt">' + money(due) + '</span></div>';
    if (paid > 0) {
      html += '<div class="stmt-line mt"><span class="lbl">Paid so far</span><span class="val">' + money(paid) + '</span></div>';
      html += '<div class="stmt-line"><span class="lbl"><b>Balance</b></span><span class="val ' +
        (Math.abs(balance) < 0.005 ? 'plus' : '') + '">' +
        (Math.abs(balance) < 0.005 ? 'Settled ✓' : money(balance)) + '</span></div>';
    }

    html += '<div class="row mt">' +
      '<button class="btn secondary compact grow" id="sal-copy">Copy statement</button>' +
      (!helperMode ? '<button class="btn ghost compact" id="sal-adj">+ Adjustment</button>' : '') +
      '</div>';
    if (!helperMode) {
      html += '<button class="btn mt" id="sal-pay">Record payment</button>';
    }
    html += '</div>';

    // payments list
    if (payments.length) {
      html += '<div class="card"><h2>Payments</h2>';
      payments.forEach(p => {
        const badge = p.status === 'approved'
          ? '<span class="badge approved">Approved ✓</span>'
          : '<span class="badge pending">Awaiting approval</span>';
        html += '<div class="payment-item" data-payment="' + p.id + '">' +
          '<div class="spread"><b>' + money(p.amount) + '</b>' + badge + '</div>' +
          '<p class="muted small">' + esc(fmtDate(p.date)) + ' · ' + esc(p.method) +
          (p.note ? ' · ' + esc(p.note) : '') + '</p>' +
          (p.approval ? '<p class="muted small">Approved by ' + esc(p.approval.name) + ' on ' +
            esc(new Date(p.approval.at).toLocaleString()) + (p.approval.pinVerified ? ' (PIN verified)' : '') + '</p>' : '') +
          '<div class="thumbs" data-thumbs="' + p.id + '"></div>' +
          '<div class="row mt">' +
          (p.status !== 'approved' ? '<button class="btn blue compact grow" data-approve="' + p.id + '">Helper approval</button>' : '') +
          (!helperMode ? '<button class="btn ghost compact" data-addphoto="' + p.id + '">+ Photo</button>' : '') +
          (!helperMode && p.status !== 'approved' ? '<button class="btn ghost compact" data-delpay="' + p.id + '" style="color:var(--red)">Delete</button>' : '') +
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

    const copyBtn = $('#sal-copy');
    if (copyBtn) copyBtn.onclick = () => {
      const text = E.statementText(stmt, state.config, {
        adjustments: monthAdjustments(stmt.key),
        paid: monthPaid(stmt.key) || 0
      });
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => toast('Statement copied — paste into WhatsApp'))
        .catch(() => { window.prompt('Copy the statement:', text); });
    };

    const adjBtn = $('#sal-adj');
    if (adjBtn) adjBtn.onclick = () => openAdjustmentSheet(stmt);
    const payBtn = $('#sal-pay');
    if (payBtn) payBtn.onclick = async () => {
      if (stmt.pendingCount > 0) {
        const go = await confirmDialog('Unapproved day logs',
          stmt.pendingCount + ' day log(s) in this month are still awaiting your approval, and they affect the total. Pay anyway?',
          'Pay anyway', false);
        if (!go) return;
      }
      openPaymentSheet(stmt);
    };

    $$('#view [data-del-adj]').forEach(b => {
      b.onclick = async () => {
        if (!(await confirmDialog('Delete adjustment?', 'This removes the adjustment line.', 'Delete', true))) return;
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
        if (!(await confirmDialog('Delete payment?', 'The payment record and its screenshots will be removed.', 'Delete', true))) return;
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
      const p = state.payments.find(x => x.id === hidden.dataset.paymentId);
      if (p && hidden.files.length) {
        await attachFiles(p, hidden.files);
        toast('Screenshot added');
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
      html += '<div class="banner">📥 Your records live only on this phone — export a backup below and keep it in your cloud drive.</div>';
    }

    // helper profiles — a household can employ more than one helper
    const ids = Store.profiles.list();
    const activeId = Store.profiles.active();
    html += '<div class="card"><h2>Helpers</h2>';
    ids.forEach(id => {
      const cfg = id === activeId ? c : Store.profiles.loadFor(id, 'config', null);
      const name = (cfg && cfg.helperName) || 'Unnamed helper';
      html += '<div class="holiday-row">' +
        '<span class="date">' + esc(name) + '</span>' +
        '<span class="name">' + (cfg ? 'from ' + esc(fmtDateShort(cfg.startDate)) + ' · ' + money(cfg.monthlyWage) + '/mo' : '') + '</span>' +
        (id === activeId
          ? '<span class="badge approved">active</span>'
          : '<button class="btn ghost compact" data-switch-helper="' + id + '">Switch</button>') +
        (ids.length > 1 ? '<button class="del" data-del-helper="' + id + '">×</button>' : '') +
        '</div>';
    });
    html += '<button class="btn secondary compact mt" id="add-helper">+ Add helper</button>' +
      '<p class="muted small mt">Each helper has her own calendar, statements, payments and PIN. ' +
      'Switch to the right helper before handing the phone over.</p></div>';

    html += '<div class="card"><h2>People</h2>' +
      '<label>Helper\'s name</label><input id="st-helper" value="' + esc(c.helperName) + '">' +
      '<label>Employer\'s name (optional)</label><input id="st-employer" value="' + esc(c.employerName || '') + '">' +
      '</div>';

    html += '<div class="card"><h2>Pay</h2>' +
      '<label>Monthly wage (HK$)</label><input id="st-wage" type="number" inputmode="decimal" value="' + c.monthlyWage + '">' +
      '<label>Food allowance (HK$/month, 0 if food provided)</label><input id="st-food" type="number" inputmode="decimal" value="' + (c.foodAllowance || 0) + '">' +
      '<label>First day of work</label><input id="st-start" type="date" value="' + esc(c.startDate) + '">' +
      '<label>Last day of work (leave empty while employed)</label><input id="st-end" type="date" value="' + esc(c.endDate || '') + '">' +
      '<label>Weekly rest day</label><select id="st-rest">' +
      WEEKDAYS.map((w, i) => '<option value="' + i + '"' + (i === c.restDayWeekday ? ' selected' : '') + '>' + w + '</option>').join('') +
      '</select>' +
      '<label class="row" style="margin-top:14px;cursor:pointer;font-size:14px;color:var(--text);font-weight:600">' +
      '<input type="checkbox" id="st-firstweek" style="width:auto"' + (c.firstWeekNoRestDay !== false ? ' checked' : '') + '>' +
      '<span>No rest day during the first 7 days of employment</span></label>' +
      '<p class="muted small" style="margin-top:4px">One rest day is earned per 7 days served, so the first week has none ' +
      '(e.g. started Fri 8 May → the Sunday 2 days later is a working day; first rest day is the next Sunday). ' +
      'A specific date can always be changed by tapping it in the Calendar.</p>' +
      '<p class="muted small mt">Daily rate is always monthly wage × 12 ÷ 365 (Labour Department formula). One-off rest-day date changes: tap the day in the Calendar.</p>' +
      '</div>';

    // holidays grouped by year
    const byYear = {};
    (c.holidays || []).forEach(h => {
      const y = h.date.slice(0, 4);
      (byYear[y] = byYear[y] || []).push(h);
    });
    html += '<div class="card"><h2>Statutory holidays</h2>';
    Object.keys(byYear).sort().forEach(y => {
      html += '<h3>' + y + '</h3>';
      byYear[y].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(h => {
        html += '<div class="holiday-row"><span class="date">' + esc(fmtDateShort(h.date)) + '</span>' +
          '<span class="name">' + esc(h.name) + '</span>' +
          '<button class="del" data-del-holiday="' + esc(h.date) + '">×</button></div>';
      });
    });
    html += '<label>Add holiday</label>' +
      '<div class="row"><input id="st-hol-date" type="date"><input id="st-hol-name" placeholder="Name"></div>' +
      '<div class="row mt">' +
      '<button class="btn secondary compact grow" id="st-hol-add">Add</button>' +
      '<button class="btn ghost compact" id="st-hol-restore">Restore official list</button>' +
      '</div>' +
      '<button class="btn blue compact mt" id="st-hol-sync">⟳ Sync from HK Gov (data.gov.hk)</button>' +
      '<p class="muted small" style="margin-top:6px">' +
      (c.lastHolidaySync
        ? 'Last synced ' + new Date(c.lastHolidaySync).toLocaleDateString() + '. '
        : 'Never synced. ') +
      'Each year\'s new dates are also fetched automatically about once a month when the app is open and online. ' +
      'Only statutory (labour-law) holidays are imported — general bank holidays like Good Friday don\'t apply until 2028. ' +
      'Synced dates assume a Sunday rest day (a holiday falling on Sunday is imported as its substitute day).</p>' +
      '</div>';

    html += '<div class="card"><h2>Security</h2>' +
      '<label>Helper\'s PIN (verifies payment approvals)</label>' +
      '<input id="st-hpin" type="password" inputmode="numeric" maxlength="6" placeholder="not set" value="' + esc(c.helperPin || '') + '">' +
      '<label>Employer\'s PIN (locks helper mode)</label>' +
      '<input id="st-epin" type="password" inputmode="numeric" maxlength="6" placeholder="not set" value="' + esc(c.employerPin || '') + '">' +
      '<p class="muted small mt">Both optional. Set them if you hand the phone to your helper for logging and approvals.</p>' +
      '</div>';

    html += '<div class="card"><h2>Data &amp; backup</h2>' +
      '<p class="muted small">All records are stored on this device only. A backup includes every helper. ' +
      (c.lastBackupAt ? 'Last backup: ' + new Date(c.lastBackupAt).toLocaleDateString() + '.' : 'No backup yet.') + '</p>' +
      '<div class="row mt">' +
      '<button class="btn secondary compact grow" id="st-export">Export backup</button>' +
      '<button class="btn ghost compact grow" id="st-import">Import backup</button>' +
      '</div>' +
      '<input type="file" id="st-import-file" accept="application/json,.json" style="display:none">' +
      '<button class="btn ghost compact mt" id="st-reset" style="color:var(--red);border-color:var(--red)">Erase all data</button>' +
      '</div>';

    html += '<div class="card"><h2>How salary is calculated</h2>' +
      '<p class="muted small">• Daily wage = monthly wage × 12 ÷ 365 (kept exact, rounded only at the end).<br>' +
      '• Weekly rest days and statutory holidays are paid — never deducted.<br>' +
      '• One rest day is earned per 7 days served, so by default there is no rest day in the first week (toggle above).<br>' +
      '• Working a rest day or statutory holiday adds one extra day\'s wage (half day adds half).<br>' +
      '• Ordinary leave on a working day deducts the daily wage (half day deducts half).<br>' +
      '• A rest day never offsets a statutory holiday — each date counts on its own.<br>' +
      '• A rest day and holiday on the same date count once, not twice.<br>' +
      '• First/last month is pro-rated by calendar days × daily wage.<br><br>' +
      '<b>Statutory holidays — the official rules (Labour Department):</b><br>' +
      '• The day off itself is required from day one, for every employee regardless of length of service.<br>' +
      '• Statutory holiday <b>pay</b> under the Ordinance starts after 3 months of continuous contract. ' +
      'For monthly-paid helpers the monthly wage covers these days anyway — this app treats them as paid from day one (the common contract/agency arrangement).<br>' +
      '• A helper may work a statutory holiday only with 48 hours’ prior notice, and the employer <b>must grant an alternative day off within 60 days</b>. ' +
      'The app tracks owed days off on the Today tab.<br>' +
      '• <b>Paying cash instead of the day off is prohibited</b> — any form of payment in lieu of a statutory holiday is an offence (fine HK$50,000), ' +
      'even with mutual agreement. Extra pay on top of the day off is voluntary and legal.<br><br>' +
      'Reference: HK Labour Department, “A Concise Guide to the Employment Ordinance” and “FAQ on Statutory Holidays”.</p>' +
      '<a class="btn secondary compact mt" style="text-decoration:none" href="guide.html" target="_blank" rel="noopener">' +
      '📖 User guide · 使用指南</a>' +
      '<a class="btn secondary compact mt" style="text-decoration:none" href="' + WHATSAPP_URL + '" target="_blank" rel="noopener">' +
      '💬 WhatsApp the developer — ' + WHATSAPP_DISPLAY + '</a>' +
      '<p class="muted small mt">HelperPay v' + APP_VERSION + ' · ' +
      '<a href="mailto:' + FEEDBACK_EMAIL + '?subject=HelperPay%20feedback" style="color:var(--accent)">Email feedback</a></p>' +
      '<p class="muted small mt">The app reports anonymous usage counts (app opens, device type, country) so the developer can see adoption. ' +
      'Your names, wages and records never leave this phone.</p>' +
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
        toast('Saved');
      };
    };
    bindField('#st-helper', 'helperName', v => v.trim());
    bindField('#st-employer', 'employerName', v => v.trim());
    bindField('#st-wage', 'monthlyWage', v => parseFloat(v) || 0);
    bindField('#st-food', 'foodAllowance', v => parseFloat(v) || 0);
    bindField('#st-start', 'startDate');
    bindField('#st-end', 'endDate');
    bindField('#st-rest', 'restDayWeekday', v => +v);
    bindField('#st-hpin', 'helperPin', v => v.trim());
    bindField('#st-epin', 'employerPin', v => v.trim());

    const fw = $('#st-firstweek');
    if (fw) fw.onchange = () => {
      c.firstWeekNoRestDay = fw.checked;
      saveConfig();
      toast('Saved');
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
        toast('Switched to ' + (state.config && state.config.helperName || 'helper'));
        render();
      };
    });

    $$('#view [data-del-helper]').forEach(b => {
      b.onclick = async () => {
        const id = b.dataset.delHelper;
        const cfg = Store.profiles.loadFor(id, 'config', null);
        const name = (cfg && cfg.helperName) || 'this helper';
        if (!(await confirmDialog('Remove ' + name + '?',
          'All of ' + name + '’s day logs, statements, payments and screenshots will be permanently deleted from this device.',
          'Remove', true))) return;
        if (!(await confirmDialog('Are you sure?', 'This cannot be undone. Export a backup first if unsure.', 'Yes, remove', true))) return;
        const pays = Store.profiles.loadFor(id, 'payments', []);
        for (const p of pays) for (const fid of p.fileIds || []) await Store.files.remove(fid);
        Store.profiles.remove(id);
        loadActiveProfile();
        toast(name + ' removed');
        render();
      };
    });

    $('#st-hol-sync').onclick = async () => {
      const btn = $('#st-hol-sync');
      btn.textContent = 'Syncing…';
      btn.disabled = true;
      await syncHolidays({ silent: false });
      if (document.body.contains(btn)) { btn.textContent = '⟳ Sync from HK Gov (data.gov.hk)'; btn.disabled = false; }
    };

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
      if (!date || !name) { toast('Enter date and name'); return; }
      c.holidays = c.holidays.filter(h => h.date !== date);
      c.holidays.push({ date: date, name: name });
      c.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
      saveConfig();
      render();
    };

    $('#st-hol-restore').onclick = async () => {
      if (!(await confirmDialog('Restore official list?', 'Replaces the holiday list with the prefilled official dates. Custom entries will be lost.', 'Restore'))) return;
      c.holidays = Holidays.defaultHolidays();
      saveConfig();
      render();
    };

    $('#st-export').onclick = async () => {
      const json = await Store.exportAll();
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'helperpay-backup-' + E.todayStr() + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      c.lastBackupAt = new Date().toISOString();
      saveConfig();
      toast('Backup exported');
      render();
    };

    $('#st-import').onclick = () => $('#st-import-file').click();
    $('#st-import-file').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!(await confirmDialog('Import backup?', 'This replaces ALL current data with the backup file.', 'Import', true))) return;
      try {
        await Store.importAll(await file.text());
        loadActiveProfile();
        toast('Backup restored');
        render();
      } catch (err) {
        toast('Import failed: ' + err.message);
      }
    };

    $('#st-reset').onclick = async () => {
      if (!(await confirmDialog('Erase all data?', 'Config, day logs, payments and screenshots will be permanently deleted from this device.', 'Erase', true))) return;
      if (!(await confirmDialog('Are you absolutely sure?', 'This cannot be undone. Export a backup first if unsure.', 'Yes, erase everything', true))) return;
      await Store.resetAll();
      location.reload();
    };
  }

  // ---------- mode toggle ----------

  async function toggleMode() {
    if (!state.config) return;
    if (!state.ui.helperMode) {
      state.ui.helperMode = true;
      if (state.ui.view === 'settings') state.ui.view = 'today';
      saveUi();
      toast('Helper mode — hand the phone over 👋');
      render();
    } else {
      if (state.config.employerPin) {
        const pin = await pinDialog('Exit helper mode', 'Enter the employer PIN.');
        if (pin === null) return;
        if (pin !== state.config.employerPin) { toast('Wrong PIN'); return; }
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
    setTimeout(maybeAutoSyncHolidays, 1500);
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  });
})();
