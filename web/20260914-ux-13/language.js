/* Shared language navigation. Reads no payroll or browser storage. */
(function(global) {
  'use strict';
  const valid = value => value === 'en' || value === 'zh-HK';
  function pick(search, saved, fallback='en') {
    const query=new URLSearchParams(search || '').get('lang');
    return valid(query) ? query : valid(saved) ? saved : valid(fallback) ? fallback : 'en';
  }
  function href(page, language, demo=false) {
    if (!['index.html','demo.html','guide.html','privacy.html','subscription-terms.html'].includes(page)) throw Error('Unsupported local page');
    const query=new URLSearchParams({lang:valid(language)?language:'en'});
    if (demo && !['index.html','demo.html'].includes(page)) query.set('from','demo');
    return page+'?'+query;
  }
  function updateUrl(language) {
    try {
      const url=new URL(global.location.href);url.searchParams.set('lang',valid(language)?language:'en');
      global.history.replaceState(global.history.state,'',url.href);
    } catch { /* The language still changes when history is unavailable. */ }
  }
  function initPage(doc=global.document) {
    const root=doc?.querySelector('[data-language-page]');
    if(!root) return;
    const demo=new URLSearchParams(global.location.search).get('from')==='demo';
    let language=pick(global.location.search,null,doc.documentElement.lang);
    const render=()=>{
      doc.documentElement.lang=language;
      const title=language==='zh-HK'?root.dataset.titleZh:root.dataset.titleEn;
      if(title) doc.title=title;
      doc.querySelectorAll('[data-page-language]').forEach(element=>{element.hidden=element.dataset.pageLanguage!==language;});
      doc.querySelectorAll('[data-page-switch]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.pageSwitch===language)));
      doc.querySelectorAll('a[data-local-page]').forEach(link=>{link.href=href(link.dataset.localPage,language,demo);});
      doc.querySelectorAll('[data-page-return]').forEach(link=>{
        link.href=href(demo?'demo.html':'index.html',language);
        link.textContent=demo ? (language==='zh-HK'?'返回示範（樣本會重設）':'Back to demo (resets samples)') : (language==='zh-HK'?'返回 HelperPay':'Back to HelperPay');
      });
    };
    doc.querySelectorAll('[data-page-switch]').forEach(button=>button.addEventListener('click',()=>{
      language=button.dataset.pageSwitch;updateUrl(language);render();
    }));
    doc.querySelectorAll('[data-page-switcher]').forEach(element=>{element.hidden=false;});
    render();
  }
  const api={pick,href,updateUrl,initPage};
  global.HSLanguage=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  if(global.document) {
    if(global.document.readyState==='loading') global.document.addEventListener('DOMContentLoaded',()=>initPage());
    else initPage();
  }
})(typeof window!=='undefined'?window:globalThis);
