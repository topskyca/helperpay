/* HelperPay — optional, consent-based usage analytics.
 *
 * Analytics is OFF by default. Nothing is downloaded or sent until the user
 * actively opts in under Settings → Privacy. Consent can be withdrawn at any
 * time. Names, wage figures, dates, notes, payments and screenshots are never
 * included in an analytics event.
 */
(function (global) {
  'use strict';

  const CODE = 'helperpay';
  const SCRIPT_ID = 'helperpay-goatcounter';
  let consent = false;
  let loading = false;

  function isDevelopment() {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
  }

  function loadScript() {
    if (!consent || !CODE || loading || document.getElementById(SCRIPT_ID) || isDevelopment()) return;
    loading = true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = 'https://gc.zgo.at/count.js';
    script.dataset.goatcounter = 'https://' + CODE + '.goatcounter.com/count';
    script.onload = () => { loading = false; };
    script.onerror = () => { loading = false; };
    document.head.appendChild(script);
  }

  function setConsent(value) {
    consent = value === true;
    if (consent) loadScript();
  }

  function track(name) {
    if (!consent) return;
    loadScript();
    if (global.goatcounter && global.goatcounter.count) {
      global.goatcounter.count({ path: String(name), event: true });
    }
  }

  global.HSAnalytics = Object.freeze({ setConsent, track, hasConsent: () => consent });
  global.HSTrack = track;
})(typeof globalThis !== 'undefined' ? globalThis : this);
