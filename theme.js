'use strict';

/* 划词翻译 —— 界面主题（共享模块）
   ────────────────────────────────────────────────────────────────
   三个值：
     auto   跟随系统（默认 —— 与改造前的行为完全一致）
     light  强制浅色
     dark   强制深色

   为什么默认是 auto：改造前 popup / 设置页 / 浮层都只写了
   `@media (prefers-color-scheme: dark)`，也就是「跟随系统」。
   auto 等于保持现状，升级不会让任何人的界面变样。

   双模式加载（与 config.js 一致，不引入构建）：
   - MV3 service worker   → 其实用不到，但保持一致
   - content script       → manifest 的 content_scripts.js 里排在 content.js 之前
   - 设置页 / 弹层        → <script src="theme.js"> 排在各自的 js 之前（放 <head> 里防首帧闪）
   - Node（dev/selftest.js）→ require('./theme.js')
*/

(function (root) {
  'use strict';

  const KEY = 'wt-theme-resolved';   // localStorage 里的渲染缓存，不是真源

  const mq = (typeof matchMedia === 'function') ? matchMedia('(prefers-color-scheme: dark)') : null;

  /* 只有扩展页面能用 localStorage 缓存主题（content script 里的 localStorage 属于宿主网页，
     往里写东西既不合适也没意义）。 */
  const isExtPage = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

  function system() {
    return mq && mq.matches ? 'dark' : 'light';
  }

  /* 把 auto 解析成实际值。pref 非法时按 auto 处理。 */
  function resolve(pref) {
    if (pref === 'dark' || pref === 'light') return pref;
    return system();
  }

  /* 把解析结果写成元素的 data-theme 属性。CSS 只认这个属性，不再写媒体查询 ——
     让 JS 把 auto 解析掉，CSS 里就只需要一套 light / 一套 dark，不用重复两遍。 */
  function apply(pref, el) {
    const node = el || (typeof document !== 'undefined' ? document.documentElement : null);
    const value = resolve(pref);
    if (node) node.setAttribute('data-theme', value);
    if (isExtPage) {
      try { localStorage.setItem(KEY, value); } catch (e) { /* 隐私模式下可能写不了 */ }
    }
    return value;
  }

  /* 首帧上色。放在 <head> 里同步执行，避免先按一套配色画出来再被改掉。
     真源是 chrome.storage.local 的 theme，但读它是异步的 —— 这里先用
     localStorage 里的上次结果兜底，没有就按系统走。 */
  function boot() {
    let cached = null;
    if (isExtPage) {
      try { cached = localStorage.getItem(KEY); } catch (e) { /* 忽略 */ }
    }
    const value = (cached === 'dark' || cached === 'light') ? cached : system();
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', value);
    }
    return value;
  }

  /* 系统主题变化时通知调用方重算。只有 auto 会真的变，但重算是幂等的，不必判断。 */
  function onChange(fn) {
    if (!mq) return;
    const handler = () => fn();
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);   // 老版 Chromium 只有 addListener
  }

  const api = { resolve, apply, boot, onChange, system };

  root.WT_THEME = api;

  /* 扩展页面（popup / 设置页）把它放在 <head> 里同步加载 —— 加载完立刻上色，
     避免首帧按默认配色画出来再被改掉。
     content script 跑在网页里，绝不能去动页面的 documentElement，所以按协议区分。
     MV3 禁止内联 <script>，这个自动执行正好补上了「在 head 里调一次」的位置。 */
  if (isExtPage && typeof document !== 'undefined' && document.documentElement) {
    boot();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
