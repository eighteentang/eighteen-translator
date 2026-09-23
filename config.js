'use strict';

/* 划词翻译 —— 共享配置（DEFAULTS 的单一真源）
   ────────────────────────────────────────────────────────────────
   为什么单独拆一个文件：
   原先 DEFAULTS 在 background.js / content.js / options.js 各有一份，
   而且内容不一致（content.js 那份只有 3 个键）。加一个配置项要改三处，
   漏一处就是静默不一致。

   双模式加载（四种宿主共用同一个文件，不引入任何构建步骤）：
   - MV3 service worker   → importScripts('config.js')，读 globalThis.WT_CONFIG
   - content script       → manifest 的 content_scripts.js 里排在 content.js 之前
   - 设置页 options.html  → <script src="config.js"> 排在 options.js 之前
   - Node（dev/selftest.js）→ require('./config.js')
*/

(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,

    /* 额度来源：
       'own'  = 使用用户自己的 API Key（当前唯一可用，也是默认值）
       'free' = 平台免费额度（测试中）

       说明：'free' 的 UI 已置灰不可选，后台的分发分支（translateViaPlatform）
       是预留接缝。将来接入托管后端时，只需实现那一个函数，其余文件不用动。 */
    quotaMode: 'own',

    engine: 'deepseek', // deepseek | google
    targetLang: 'zh',   // zh | en

    deepseekKey: ''
  };

  const api = { DEFAULTS };

  root.WT_CONFIG = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
