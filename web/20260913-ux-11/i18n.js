/* HelperPay — English / Hong Kong Traditional Chinese language helpers.
 *
 * The selected language is stored by app.js. This module stays pure so its
 * locale detection and formatting can be tested without a browser DOM.
 */
(function (global) {
  'use strict';

  const EN = 'en';
  const ZH_HK = 'zh-HK';

  const WEEKDAYS = {
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    'zh-HK': ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  };

  const WEEKDAYS_SHORT = {
    en: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
    'zh-HK': ['日', '一', '二', '三', '四', '五', '六']
  };

  const MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'],
    'zh-HK': ['1月', '2月', '3月', '4月', '5月', '6月',
      '7月', '8月', '9月', '10月', '11月', '12月']
  };

  const HOLIDAY_NAMES = {
    "New Year's Day": '元旦',
    'The first day of January': '一月一日',
    'Lunar New Year — Day 1': '農曆年初一',
    'Lunar New Year — Day 2': '農曆年初二',
    'Lunar New Year — Day 3': '農曆年初三',
    'Lunar New Year’s Day': '農曆年初一',
    "Lunar New Year's Day": '農曆年初一',
    'The second day of Lunar New Year': '農曆年初二',
    'The third day of Lunar New Year': '農曆年初三',
    'The fourth day of Lunar New Year': '農曆年初四',
    'Ching Ming Festival': '清明節',
    'Ching Ming': '清明節',
    'Easter Monday': '復活節星期一',
    'Labour Day': '勞動節',
    "Buddha's Birthday": '佛誕',
    'The Birthday of the Buddha': '佛誕',
    'Tuen Ng Festival': '端午節',
    'HKSAR Establishment Day': '香港特別行政區成立紀念日',
    'Hong Kong Special Administrative Region Establishment Day': '香港特別行政區成立紀念日',
    'Day after Mid-Autumn Festival': '中秋節翌日',
    'The day following the Chinese Mid-Autumn Festival': '中秋節翌日',
    'National Day': '國慶日',
    'Chung Yeung Festival': '重陽節',
    'Chung Yeung': '重陽節',
    'Chinese Winter Solstice Festival or Christmas Day': '冬節或聖誕節',
    'Christmas Day': '聖誕節',
    'First weekday after Christmas': '聖誕節後第一個周日',
    'The first weekday after Christmas Day': '聖誕節後第一個周日'
  };

  function normalizeLanguage(value) {
    const lang = String(value || '').trim().toLowerCase();
    return lang === 'zh-hk' || lang.indexOf('zh') === 0 ? ZH_HK : EN;
  }

  function detectLanguage(languages) {
    const list = Array.isArray(languages) ? languages : [languages];
    return list.some(lang => String(lang || '').toLowerCase().indexOf('zh') === 0) ? ZH_HK : EN;
  }

  function choose(language, english, chinese) {
    return normalizeLanguage(language) === ZH_HK ? chinese : english;
  }

  function weekdays(language) { return WEEKDAYS[normalizeLanguage(language)].slice(); }
  function weekdaysShort(language) { return WEEKDAYS_SHORT[normalizeLanguage(language)].slice(); }
  function months(language) { return MONTHS[normalizeLanguage(language)].slice(); }

  function parseYmd(value) {
    const p = String(value).split('-');
    return { y: +p[0], m: +p[1], d: +p[2] };
  }

  function weekdayOf(value) {
    const p = parseYmd(value);
    return new Date(p.y, p.m - 1, p.d).getDay();
  }

  function formatDate(value, language) {
    const lang = normalizeLanguage(language);
    const p = parseYmd(value);
    if (lang === ZH_HK) return p.y + '年' + p.m + '月' + p.d + '日（' + WEEKDAYS[lang][weekdayOf(value)] + '）';
    return WEEKDAYS.en[weekdayOf(value)].slice(0, 3) + ', ' + p.d + ' ' + MONTHS.en[p.m - 1].slice(0, 3) + ' ' + p.y;
  }

  function formatDateShort(value, language) {
    const lang = normalizeLanguage(language);
    const p = parseYmd(value);
    return lang === ZH_HK ? p.m + '月' + p.d + '日' : p.d + ' ' + MONTHS.en[p.m - 1].slice(0, 3);
  }

  function monthYear(year, month, language) {
    return normalizeLanguage(language) === ZH_HK
      ? year + '年' + month + '月'
      : MONTHS.en[month - 1] + ' ' + year;
  }

  function holidayName(name, language) {
    if (normalizeLanguage(language) !== ZH_HK) return String(name || '');
    const raw = String(name || '');
    if (HOLIDAY_NAMES[raw]) return HOLIDAY_NAMES[raw];

    let match = raw.match(/^Substitute — (.+?) \(fell on (?:a )?(?:Sunday|rest day)\)$/i);
    if (match) return '補假 — ' + holidayName(match[1], ZH_HK) + '（原定假日適逢休息日）';

    match = raw.match(/^Day off in lieu — (.+?) \((.+)\)$/i);
    if (match) return '補假 — ' + holidayName(match[1], ZH_HK) + '（' + match[2] + '）';

    return raw;
  }

  function paymentMethod(value, language) {
    if (normalizeLanguage(language) !== ZH_HK) return value;
    return ({
      FPS: '轉數快（FPS）',
      'Bank transfer': '銀行轉帳',
      Cash: '現金',
      Cheque: '支票',
      Other: '其他'
    })[value] || value;
  }

  const api = {
    EN,
    ZH_HK,
    normalizeLanguage,
    detectLanguage,
    choose,
    weekdays,
    weekdaysShort,
    months,
    formatDate,
    formatDateShort,
    monthYear,
    holidayName,
    paymentMethod
  };

  global.HSI18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
