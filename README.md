# HelperPay — free web app / 免費網頁版

[Open HelperPay](https://topskyca.github.io/helperpay/) · [Guide](https://topskyca.github.io/helperpay/guide.html) · [Privacy](https://topskyca.github.io/helperpay/privacy.html)

The web app remains free, with no subscription, account signup or trial expiry. Native Android/iOS membership is separate and is not loaded by this website.

網頁版繼續免費，毋須訂閱或註冊，亦沒有試用期限。Android／iOS 會籍屬另一版本，不會載入此網站。

## September 2026 update

- Hong Kong Traditional Chinese and English, shorter guided setup that retains drafts when changing language, and an isolated sample demo.
- Contract-specific calculation checks, official 2026–2027 statutory holiday options, explicit time-off arrangements, approval controls and confirmed statement versions. Previewing or cancelling a payment does not confirm a statement.
- Effective-dated wage and food terms, holiday-data review, and rest-day changes that retain existing work and notes. Actual notifications and agreements must be recorded; the app does not invent them.
- Local records and attachments, validated backup import with recovery, optional analytics (off by default), and erasure controls.
- In-page rest-day, holiday/time-off and payday check-ins retain unfinished items and link to the relevant date or month. They do not send notifications while the page is closed and do not assume that work or payment happened.
- Clear issue lists, external-calculation payment records for unsupported cases, grouped settings, unsaved-change warnings and explicit backup-save confirmation.

今次改善首次設定、未完成待辦、結算預覽及修訂、工資生效日期、補假及備份流程。更改休息日期會保留原有工作及備註；取消付款草稿不會自動確認結算。未支援的計算仍須在外部核對，實際付款可另行如實記錄。

## Existing records

Keep using the same website and browser. On the first upgrade, download the complete JSON backup and confirm that it is safely saved before continuing. On iPhone, a Safari preview is not a saved file: save it to Files / iCloud Drive. Do not clear website data to update.

Existing payment records are retained. The calculator does not invent missing contract dates, wage histories or agreement details; older profiles may require additional information before a new statement can be finalized. Old estimates may differ from the new checks. Payroll remains local to this browser; it is not automatically synchronized between devices.

請繼續使用相同網址及瀏覽器。首次升級須先下載完整 JSON 備份，並確認已妥善儲存。iPhone 如出現 Safari 預覽，請另存到「檔案」／iCloud Drive；切勿清除網站資料以更新。過往付款記錄會保留；缺少合約或工資歷史資料時，新結算單可能暫時不能確認。

## Scope and limitations

HelperPay is a reference tracker for Hong Kong ID 407 foreign domestic-helper records, not legal advice, a bank/payment-transfer service or an authoritative payroll product. Unsupported calculations are blocked from finalized statements and directed to [Labour Department's reference calculator](https://www.lr.labour.gov.hk/web/en/calculator/index.html). Full statutory entitlement coverage and professional legal review are not implied.

The active release is identified in `web-release.json`. Its active scripts are under `web/20260913-ux-4/`; older versioned assets and root `js/` and `css/` files are retained for old cached pages and are not the active calculator. The website service worker caches a complete versioned release, without caching or uploading payroll records. A software rollback does not restore or alter browser payroll data; retain your backup.

Support: [yonghe@affluentbyte.hk](mailto:yonghe@affluentbyte.hk)
