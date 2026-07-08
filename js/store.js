/* HelperPay — persistence layer with multi-helper profiles.
 *
 * Everything lives on this device:
 *   localStorage  — helper profiles (config, day logs, payments, adjustments)
 *   IndexedDB     — payment screenshots (image blobs)
 *
 * A household can employ several helpers: each helper is a "profile" with its
 * own config/logs/payments/adjustments, stored under namespaced keys
 * (helperpay.p.<id>.*). One profile is active at a time; the registry lives
 * in helperpay.profiles / helperpay.active. Legacy single-helper data (the
 * original flat helperpay.config etc.) is migrated into a profile on boot.
 *
 * exportAll()/importAll() produce/consume a single self-contained JSON backup
 * of ALL helpers (screenshots embedded as data URLs). v1 (single-helper)
 * backups import cleanly as one profile.
 */
(function (global) {
  'use strict';

  const PREFIX = 'helperpay.';
  const DB_NAME = 'helperpay-files';
  const DB_STORE = 'files';
  const PROFILE_KEYS = ['config', 'logs', 'payments', 'adjustments'];

  function uid() { return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---------- raw localStorage JSON ----------

  function getRaw(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function setRaw(key, value) { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
  function delRaw(key) { localStorage.removeItem(PREFIX + key); }

  // ---------- profile registry ----------

  function pkey(id, key) { return 'p.' + id + '.' + key; }

  function profileList() { return getRaw('profiles', []); }
  function saveProfileList(ids) { setRaw('profiles', ids); }
  function activeProfile() { return getRaw('active', null); }
  function setActiveProfile(id) { setRaw('active', id); }

  // One-time migration of the original flat single-helper layout.
  function migrate() {
    if (profileList().length) return;
    const legacyConfig = getRaw('config', null);
    if (!legacyConfig) return;
    const id = uid();
    setRaw(pkey(id, 'config'), legacyConfig);
    setRaw(pkey(id, 'logs'), getRaw('logs', {}));
    setRaw(pkey(id, 'payments'), getRaw('payments', []));
    setRaw(pkey(id, 'adjustments'), getRaw('adjustments', {}));
    saveProfileList([id]);
    setActiveProfile(id);
    PROFILE_KEYS.forEach(delRaw);
  }

  function createProfile() {
    const id = uid();
    saveProfileList(profileList().concat(id));
    return id;
  }

  function deleteProfile(id) {
    PROFILE_KEYS.forEach(k => delRaw(pkey(id, k)));
    saveProfileList(profileList().filter(x => x !== id));
    if (activeProfile() === id) {
      const rest = profileList();
      setActiveProfile(rest.length ? rest[0] : null);
    }
  }

  function loadFor(id, key, fallback) { return getRaw(pkey(id, key), fallback); }

  // ---------- active-profile data ----------

  function load(key, fallback) {
    const id = activeProfile();
    return id ? getRaw(pkey(id, key), fallback) : fallback;
  }

  function save(key, value) {
    const id = activeProfile();
    if (!id) throw new Error('No active helper profile');
    setRaw(pkey(id, key), value);
  }

  // ---------- IndexedDB blobs ----------

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function idb(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const store = tx.objectStore(DB_STORE);
      const out = fn(store);
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
    }));
  }

  const files = {
    put(id, blob, meta) {
      return idb('readwrite', s => s.put(Object.assign({ id, blob, addedAt: Date.now() }, meta || {})));
    },
    get(id) {
      return openDb().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }));
    },
    remove(id) { return idb('readwrite', s => s.delete(id)); },
    all() {
      return openDb().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      }));
    },
    clear() { return idb('readwrite', s => s.clear()); }
  };

  // ---------- backup / restore ----------

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/data:(.*?);/)[1];
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function exportAll() {
    const fileRecords = await files.all();
    const exportedFiles = [];
    for (const f of fileRecords) {
      exportedFiles.push({
        id: f.id,
        paymentId: f.paymentId || null,
        addedAt: f.addedAt || null,
        dataUrl: await blobToDataUrl(f.blob)
      });
    }
    const profiles = {};
    profileList().forEach(id => {
      profiles[id] = {
        config: loadFor(id, 'config', null),
        logs: loadFor(id, 'logs', {}),
        payments: loadFor(id, 'payments', []),
        adjustments: loadFor(id, 'adjustments', {})
      };
    });
    return JSON.stringify({
      app: 'helperpay',
      version: 2,
      exportedAt: new Date().toISOString(),
      activeProfile: activeProfile(),
      profiles: profiles,
      files: exportedFiles
    });
  }

  async function importAll(jsonText) {
    const data = JSON.parse(jsonText);
    if (!data || data.app !== 'helperpay') throw new Error('Not a HelperPay backup file.');

    // wipe current profiles, then restore from the backup
    profileList().forEach(id => PROFILE_KEYS.forEach(k => delRaw(pkey(id, k))));

    if (data.version >= 2) {
      const ids = Object.keys(data.profiles || {});
      ids.forEach(id => {
        const p = data.profiles[id] || {};
        setRaw(pkey(id, 'config'), p.config || null);
        setRaw(pkey(id, 'logs'), p.logs || {});
        setRaw(pkey(id, 'payments'), p.payments || []);
        setRaw(pkey(id, 'adjustments'), p.adjustments || {});
      });
      saveProfileList(ids);
      setActiveProfile(data.activeProfile && ids.indexOf(data.activeProfile) !== -1
        ? data.activeProfile : (ids[0] || null));
    } else {
      // v1 single-helper backup becomes one profile
      const id = uid();
      setRaw(pkey(id, 'config'), data.config || null);
      setRaw(pkey(id, 'logs'), data.logs || {});
      setRaw(pkey(id, 'payments'), data.payments || []);
      setRaw(pkey(id, 'adjustments'), data.adjustments || {});
      saveProfileList([id]);
      setActiveProfile(id);
    }

    await files.clear();
    for (const f of data.files || []) {
      await files.put(f.id, dataUrlToBlob(f.dataUrl), { paymentId: f.paymentId, addedAt: f.addedAt });
    }
    return data;
  }

  async function resetAll() {
    Object.keys(localStorage)
      .filter(k => k.indexOf(PREFIX) === 0)
      .forEach(k => localStorage.removeItem(k));
    await files.clear();
  }

  const api = {
    migrate,
    profiles: {
      list: profileList,
      active: activeProfile,
      setActive: setActiveProfile,
      create: createProfile,
      remove: deleteProfile,
      loadFor: loadFor
    },
    loadConfig: () => load('config', null),
    saveConfig: c => save('config', c),
    loadLogs: () => load('logs', {}),
    saveLogs: l => save('logs', l),
    loadPayments: () => load('payments', []),
    savePayments: p => save('payments', p),
    loadAdjustments: () => load('adjustments', {}),
    saveAdjustments: a => save('adjustments', a),
    loadUi: () => getRaw('ui', {}),
    saveUi: u => setRaw('ui', u),
    files,
    exportAll, importAll, resetAll
  };

  global.HSStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
