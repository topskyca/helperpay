/* HelperPay — anonymous usage analytics (GoatCounter).
 *
 * Reports app opens and a few coarse usage events so the developer can see
 * adoption: visitor counts, device/browser, country, and frequency — on the
 * GoatCounter dashboard (https://<CODE>.goatcounter.com).
 *
 * Privacy: pings carry NO app data — no names, no wages, no dates worked.
 * Salary records never leave the device. GoatCounter stores no raw IPs.
 * count.js ignores localhost, so development doesn't pollute the numbers.
 *
 * To enable: set CODE to the GoatCounter site code (e.g. 'helperpay').
 * Empty string = analytics fully disabled, nothing is loaded or sent.
 */
(function () {
  'use strict';

  var CODE = 'helperpay'; // GoatCounter site code — set to enable, '' disables

  // no-op fallback so app code can always call HSTrack(...)
  window.HSTrack = function () {};

  if (!CODE || location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = 'https://' + CODE + '.goatcounter.com/count';
  document.head.appendChild(s);

  // Coarse usage events (event names only, never data):
  //   setup-completed   — a new household finished onboarding
  //   day-logged        — a work/leave day was logged (core usage signal)
  //   payment-recorded  — a salary payment was recorded
  //   payment-approved  — a helper approved a payment
  window.HSTrack = function (name) {
    if (window.goatcounter && window.goatcounter.count) {
      window.goatcounter.count({ path: name, event: true });
    }
  };
})();
