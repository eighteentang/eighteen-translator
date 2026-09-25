/* 划词翻译 · 后台逻辑自测
   mock 掉 chrome API 与 fetch，验证 background.js 的引擎调度与错误处理。
   测的是「不打开浏览器就能测的部分」——浮层有没有真的出现属于另一件事，
   见 dev/e2e-panel.js。跑法：node dev/selftest.js */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'config.js'));       // 共享配置需先加载，background.js 依赖它
const LANGUTIL = require(path.join(ROOT, 'lang.js'));    // 语言判定同上
const TECH = require(path.join(ROOT, 'tech.js'));        // 技术内容判定（#60）
const SITES = require(path.join(ROOT, 'sites.js'));      // 排除站点匹配（#29）
/* 界面文案（#39）。⚠️ 必须排在 background.js **之前** —— 后者在模块顶层就
   `const T = globalThis.WT_STRINGS`，拿不到会直接抛错（这是故意的，见那边注释）。 */
const STRINGS = require(path.join(ROOT, 'strings.js'));
const I18N = require(path.join(__dirname, 'scan-i18n.js'));  // 中文硬编码扫描器（#39）
/* 朗读（#10）。⚠️ 它平时**只被 content script 加载**（不是四宿主共享模块）——
   但它里面的分句 / 选音 / 错误过滤都是纯函数，正是最该被钉住的部分，
   所以这里用 require 拿它来测。 */
const SPEAK = require(path.join(ROOT, 'speak.js'));

let handler = null;
let installedHandler = null;
let openedOptions = 0;
let savedCfg = null;
let override = {};
let mockFetch = async () => { throw new Error('no mock set'); };
let captured = {};

/* chrome.tabs 的 mock（#29）—— background.js 的 currentHostname() 用它问
   「当前标签页的域名」。两个开关分别模拟两种真实失败：
   tabList = []      → 没有活动标签页（比如扩展刚装好、还没开网页）
   tabFails = true   → 那个标签页里没有内容脚本（chrome:// 页面、商店页、扩展页） */
let tabList = [{ id: 1 }];
let tabAnswer = 'example.com';
let tabFails = false;

/* 浏览器界面语言的 mock（#35）。
   strings.js 的 browserLang() 优先读 `chrome.i18n.getUILanguage()` ——
   真机上是它，Node 里没有这个 API，所以要给一个可改的桩，
   否则「跟随浏览器」这条分支在自测里根本走不到。 */
let uiLangTag = 'zh-CN';

/* 模拟 chrome.storage.local 里**真正持久**的那部分 —— 用量计数与译文缓存（#18 / #17）。
   ⚠️ 与 `override` 分开是刻意的：override 是「当前配置」，每个用例都要换一份；
   而用量与缓存必须跨用例累积，才能测出「第二次命中缓存」「到顶被拦」这类行为。
   把两者混在一起的话，上一个用例 set 进去的配置会串到下一个用例的 get(null) 上。 */
const PERSISTED = ['usage', 'cache'];
let store = {};

global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { handler = fn; } },
    onInstalled: { addListener: (fn) => { installedHandler = fn; } },
    openOptionsPage: () => { openedOptions++; }
  },
  storage: {
    local: {
      get: (defaults) => {
        const out = Object.assign({}, defaults, override);
        // 只有用量与缓存从 store 里补 —— 配置一律以 override 为准（见上面那段注释）
        PERSISTED.forEach((k) => { if (k in store) out[k] = store[k]; });
        return Promise.resolve(out);
      },
      set: (v) => {
        PERSISTED.forEach((k) => { if (k in v) store[k] = v[k]; });
        savedCfg = v;
        return Promise.resolve();
      },
      remove: (k) => { delete store[k]; return Promise.resolve(); }
    }
  },
  action: { onClicked: { addListener: () => {} } },
  i18n: { getUILanguage: () => uiLangTag },
  tabs: {
    query: (q, cb) => cb(tabList),
    sendMessage: (id, msg, cb) => {
      if (tabFails) {
        global.chrome.runtime.lastError = { message: 'Could not establish connection.' };
        cb(undefined);
        // 真实 Chrome 里 lastError 只在回调期间存在，读完就没了
        delete global.chrome.runtime.lastError;
        return;
      }
      cb({ hostname: tabAnswer });
    }
  }
};

global.fetch = (url, opts) => mockFetch(url, opts);

require(path.join(ROOT, 'background.js'));

function call(text, forceTarget) {
  return send({ type: 'translate', text: text, forceTarget: forceTarget });
}

function send(msg) {
  return new Promise((resolve) => {
    handler(msg, {}, resolve);
  });
}

// 等一轮宏任务 —— getConfig() 与 fetch 都在微任务里排队，一个 tick 足够
const tick = () => new Promise((r) => setTimeout(r, 0));

/* 等几轮。一个 tick 就能冲干净微任务队列，但有些用例里存在**故意不 await** 的请求
   （它们本就设计成永不返回），需要多给几轮，让它们的 fetch 真正发出来 ——
   否则那个 fetch 会晚一步落到**下一个**用例的 mock 上
   （`global.fetch` 是调用时才解引用 mockFetch），把断言读的元素挤掉。 */
async function drain() { for (let i = 0; i < 4; i++) await tick(); }

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

(async () => {
  /* 1. DeepSeek */
  override = { engine: 'deepseek', targetLang: 'zh', deepseekKey: 'sk-test' };
  captured = {};
  mockFetch = async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    captured.auth = opts.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '  \u4f60\u597d\uff0c\u4e16\u754c  ' } }] }) };
  };

  let r = await call('Hello, world');
  check('DeepSeek \u8fd4\u56de\u8bd1\u6587\u5e76\u53bb\u9996\u5c3e\u7a7a\u767d', r.ok === true && r.text === '\u4f60\u597d\uff0c\u4e16\u754c', JSON.stringify(r));
  check('DeepSeek \u4f7f\u7528 deepseek-flash \u6a21\u578b', captured.body.model === 'deepseek-flash', captured.body.model);
  check('DeepSeek \u5df2\u663e\u5f0f\u5173\u95ed\u601d\u8003\u6a21\u5f0f', !!(captured.body.thinking && captured.body.thinking.type === 'disabled'), JSON.stringify(captured.body.thinking));
  check('DeepSeek \u5e26 Bearer \u8ba4\u8bc1', captured.auth === 'Bearer sk-test', captured.auth);
  check('DeepSeek \u76ee\u6807\u8bed\u8a00\u5199\u8fdb\u63d0\u793a\u8bcd', /\u7b80\u4f53\u4e2d\u6587/.test(captured.body.messages[0].content));
  check('DeepSeek \u54cd\u5e94\u5305\u542b engine \u5b57\u6bb5', r.engine === 'deepseek', String(r.engine));

  /* 2. Google：多段结果拼接 */
  override = { engine: 'google', targetLang: 'zh' };
  mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [[['\u4f60\u597d', 'hello', null, null, 10], ['\u4e16\u754c', ' world', null, null, 10]], null, 'en']
  });
  r = await call('hello world');
  check('Google \u591a\u6bb5\u7ed3\u679c\u6b63\u786e\u62fc\u63a5', r.ok === true && r.text === '\u4f60\u597d\u4e16\u754c', JSON.stringify(r));

  /* 3. Google 429 */
  override = { engine: 'google', targetLang: 'zh' };
  mockFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  r = await call('hello');
  check('Google 429 \u6709\u4e13\u95e8\u63d0\u793a', r.ok === false && /429/.test(r.error), r.error);

  /* 4. DeepSeek 缺凭据：不发请求，给出可读提示 */
  override = { engine: 'deepseek', targetLang: 'zh', deepseekKey: '' };
  mockFetch = async () => { throw new Error('\u4e0d\u5e94\u53d1\u8d77\u8bf7\u6c42'); };
  r = await call('hello');
  check('DeepSeek \u7f3a\u51ed\u636e\u65f6\u4e0d\u53d1\u8bf7\u6c42\u5e76\u63d0\u793a', r.ok === false && /\u5c1a\u672a\u586b\u5199/.test(r.error), r.error);

  /* 5. 网络失败 */
  override = { engine: 'google', targetLang: 'zh' };
  mockFetch = async () => { throw new TypeError('Failed to fetch'); };
  r = await call('hello');
  check('\u7f51\u7edc\u5931\u8d25\u88ab\u8f6c\u6210\u53ef\u8bfb\u63d0\u793a', r.ok === false && /\u7f51\u7edc\u8bf7\u6c42\u5931\u8d25/.test(r.error), r.error);

  /* 6. 空文本 */
  override = { engine: 'google', targetLang: 'zh' };
  r = await call('');
  check('\u7a7a\u6587\u672c\u88ab\u62d2\u7edd', r.ok === false, JSON.stringify(r));

  /* 7. 英文目标语言 */
  override = { engine: 'deepseek', targetLang: 'en', deepseekKey: 'sk-test' };
  captured = {};
  mockFetch = async (url, opts) => {
    captured.body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hello' } }] }) };
  };
  r = await call('\u4f60\u597d');
  check('DeepSeek \u76ee\u6807\u4e3a\u82f1\u6587\u65f6\u63d0\u793a\u8bcd\u6b63\u786e', /English/.test(captured.body.messages[0].content));

  /* 8. 共享配置：quotaMode 默认值（config.js 是单一真源） */
  check('DEFAULTS.quotaMode \u9ed8\u8ba4\u4e3a own', CFG.DEFAULTS.quotaMode === 'own', String(CFG.DEFAULTS.quotaMode));

  /* 9. 平台免费额度：预留接缝，应明确报「尚未开放」且不发任何请求 */
  override = { quotaMode: 'free', engine: 'deepseek', targetLang: 'zh', deepseekKey: 'sk-test' };
  mockFetch = async () => { throw new Error('\u4e0d\u5e94\u53d1\u8d77\u8bf7\u6c42'); };
  r = await call('hello');
  check('\u5e73\u53f0\u514d\u8d39\u989d\u5ea6\u672a\u5f00\u653e\u65f6\u6709\u660e\u786e\u63d0\u793a', r.ok === false && /\u5c1a\u672a\u5f00\u653e/.test(r.error), r.error);

  /* 10. quotaMode='free' 优先于引擎选择 —— 即使填了凭据也不走引擎 */
  override = { quotaMode: 'free', engine: 'deepseek', targetLang: 'zh', deepseekKey: 'sk-test' };
  mockFetch = async () => { throw new Error('\u4e0d\u5e94\u53d1\u8d77\u8bf7\u6c42'); };
  r = await call('hello');
  check('quotaMode=free \u4f18\u5148\u4e8e\u5f15\u64ce\u9009\u62e9', r.ok === false && /\u5c1a\u672a\u5f00\u653e/.test(r.error), r.error);

  /* 11. 百度已移除：配置里不应再残留相关键 */
  check('\u914d\u7f6e\u91cc\u5df2\u4e0d\u542b\u767e\u5ea6\u76f8\u5173\u952e', !('baiduAppId' in CFG.DEFAULTS) && !('baiduKey' in CFG.DEFAULTS), Object.keys(CFG.DEFAULTS).join(','));

  /* ---------- 取消机制（Issue #1「连续划词会重复计费」） ---------- */

  /* 12. 第二次请求发出时，第一次必须已被 abort
     这是 #1 的关闭条件里点名要的那条断言。
     断言的是 fetch 实际收到的那个 signal —— 也就是取消真的传到了网络层，
     而不只是在后台内部记了个状态。 */
  override = { engine: 'deepseek', targetLang: 'zh', deepseekKey: 'sk-test' };
  const seen = [];
  mockFetch = (url, opts) => {
    seen.push(opts.signal);
    if (seen.length === 1) return new Promise(() => {});   // 挂住，模拟 DeepSeek 还在生成
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    });
  };

  call('第一次');          // 故意不 await：它会被取消，永远不返回
  await tick();
  call('第二次');
  await tick();

  check('第二次请求发出时，第一次的 signal 已被 abort',
    seen.length === 2 && seen[0].aborted === true,
    '请求数=' + seen.length + ' aborted=' + (seen[0] ? seen[0].aborted : 'n/a'));

  /* 13. 被取消的请求报「已取消」，不是误导性的「超时」 */
  mockFetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('The user aborted a request.');
      e.name = 'AbortError';
      reject(e);
    });
  });

  const slow = call('慢请求');
  await tick();
  call('新请求');
  const cancelled = await slow;
  check('被取消的请求报「已取消」而不是「超时」',
    cancelled.ok === false && /取消/.test(cancelled.error), JSON.stringify(cancelled));

  /* 14. 关浮层时发的 cancel 消息能停掉在飞的请求
     content.js 的 close() 靠这条消息止血：用户点了别处、结果没人要，
     请求不该继续跑完并计费。

     ⚠️ 必须先「清场」再换 mock。上面两个用例里有故意不 await 的请求
     （它们本就设计成永不返回），而它们的 fetch 可能**还没发出去** ——
     `global.fetch` 是调用时才解引用 mockFetch，于是那个 fetch 会晚一步
     落进本用例的 mock 里，把 live[0] 占成上一个请求的（已被 abort 的）signal，
     断言就会读到错的元素。这是测试自身的时序问题，不是产品缺陷。 */
  await send({ type: 'cancel' });
  await drain();

  const live = [];
  mockFetch = (url, opts) => { live.push(opts.signal); return new Promise(() => {}); };

  call('要取消的');
  await drain();
  const beforeCancel = live.length === 1 && live[0].aborted === false;
  await send({ type: 'cancel' });
  check('cancel 消息能停掉在飞的请求',
    beforeCancel && live.length === 1 && live[0].aborted === true,
    '请求数=' + live.length + ' 取消前=' + beforeCancel
      + ' 取消后=' + (live[0] ? live[0].aborted : 'n/a'));

  /* 15. 没有请求在飞时收到 cancel，不应报错 */
  let cancelRes = null;
  await send({ type: 'cancel' }).then((r) => { cancelRes = r; });
  check('空转的 cancel 不报错', !!(cancelRes && cancelRes.ok === true), JSON.stringify(cancelRes));

  /* ---------- 语言判定与翻译方向（Issue #2） ---------- */

  const ZH = '这是一段足够长的中文文本，用来测试翻译方向。';
  const EN = 'This is a long enough English sentence for detection.';

  /* 16. detect() 直接断言 */
  check('含假名 → 判为日文，不被汉字带偏',
    LANGUTIL.detect('これは日本語の文章です') === 'ja', LANGUTIL.detect('これは日本語の文章です'));
  check('含谚文 → 判为韩文',
    LANGUTIL.detect('이것은 한국어 문장입니다') === 'ko', LANGUTIL.detect('이것은 한국어 문장입니다'));
  check('中文段落 → zh', LANGUTIL.detect(ZH) === 'zh', LANGUTIL.detect(ZH));
  check('英文段落 → en', LANGUTIL.detect(EN) === 'en', LANGUTIL.detect(EN));
  check('短文本不做判定', LANGUTIL.detect('OK') === 'unknown', LANGUTIL.detect('OK'));
  check('中英混排按汉字占比 → zh',
    LANGUTIL.detect('帮我看看这个 API 文档到底要怎么写') === 'zh',
    LANGUTIL.detect('帮我看看这个 API 文档到底要怎么写'));
  check('英文夹中文词按拉丁占比 → en',
    LANGUTIL.detect('Check the folder and the document please') === 'en',
    LANGUTIL.detect('Check the folder and the document please'));

  /* 17. 源语言 = 首选语言 → 译成目标语言

     ⚠️ 先清一次缓存（#17 加了结果缓存）。下面几个用例反复用同一段 ZH / EN，
     不清的话第二个用例会直接命中第一个的缓存 —— **根本没走到引擎**，
     `captured` 也就不会被赋值，断言会以一种难懂的方式失败。

     （21 / 22 仍可能命中缓存，那没关系：它们断言的是 `pickTarget` 的结果，
     而方向判定发生在查缓存**之前**，两条路径拿到的是同一个 dir。） */
  store = {};

  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'en', deepseekKey: 'sk-test' };
  captured = {};
  mockFetch = async (url, opts) => {
    captured.body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hello' } }] }) };
  };
  let dir = await call(ZH);
  check('选中中文 → 译成英文',
    dir.ok === true && dir.target === 'en' && dir.reversed === false
      && /English/.test(captured.body.messages[0].content),
    JSON.stringify({ target: dir.target, reversed: dir.reversed }));

  /* 18. 源语言 = 目标语言 → 反向译回首选语言 */
  captured = {};
  dir = await call(EN);
  check('选中英文 → 反向译回中文',
    dir.ok === true && dir.target === 'zh' && dir.reversed === true
      && /简体中文/.test(captured.body.messages[0].content),
    JSON.stringify({ target: dir.target, reversed: dir.reversed }));

  /* 19. 判不出来 → 按目标语言，不反向 */
  captured = {};
  dir = await call('OK');
  check('判不出来 → 按目标语言，不反向',
    dir.ok === true && dir.target === 'en' && dir.reversed === false,
    JSON.stringify({ target: dir.target, reversed: dir.reversed }));

  /* 20. forceTarget 覆盖判定 —— 这是误判的唯一出口。
     故意挑一个「自然结果与强制方向相反」的例子，否则测不出覆盖是否生效。 */
  captured = {};
  dir = await call(ZH, 'zh');   // 中文的自然方向是「译成英文」，这里强制译成中文
  check('强制方向覆盖判定结果',
    dir.ok === true && dir.target === 'zh' && dir.reversed === false
      && /简体中文/.test(captured.body.messages[0].content),
    JSON.stringify({ target: dir.target }));

  /* 21. 非法 forceTarget 要被忽略，不能把任意字符串透进引擎 */
  captured = {};
  dir = await call(ZH, 'rm -rf /');
  check('非法 forceTarget 被忽略，回落到判定结果',
    dir.ok === true && dir.target === 'en',
    JSON.stringify({ target: dir.target }));

  /* 22. 首选 = 目标 时的兜底：不做反向，否则绕回「译成同语言」 */
  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'zh', deepseekKey: 'sk-test' };
  captured = {};
  dir = await call(EN);
  check('首选 = 目标 时不做反向（否则等于没修）',
    dir.ok === true && dir.target === 'zh' && dir.reversed === false,
    JSON.stringify({ target: dir.target, reversed: dir.reversed }));

  /* ---------- 语言扩展（#9）：判定细分 + 引擎代码映射 ----------

     这一节守的是「加了一门语言，但某处没跟着改」—— 这类漏改**全都不报错**，
     表现是「选了法文，出来还是英文」这种无声错误。
     最要紧的是拉丁语系细分：法 / 德 / 西 全是拉丁字母，原来一律判成 en，
     配上「首选中文 / 目标法文」就会绕回「译成同语言」那个 bug（#2 修过一次，
     从另一个门又进来）。 */

  const DETECT_CASES = [
    ['这是一段足够长的中文文本，用来测试翻译方向。', 'zh'],
    ['今天天气很好，我们一起去公园散步吧。', 'zh'],
    ['這是一段足夠長的繁體中文文本，用來確認翻譯引擎能否正常工作。', 'zh-Hant'],
    ['これは日本語の文章です', 'ja'],
    ['이것은 한국어 문장입니다', 'ko'],
    ['นี่คือข้อความทดสอบภาษาไทยเพื่อยืนยันว่าเครื่องมือแปลทำงานได้', 'th'],
    ['هذا نص تجريبي باللغة العربية للتأكد من أن محرك الترجمة يعمل', 'ar'],
    ['Это тестовый текст на русском языке для проверки работы.', 'ru'],
    ['This is a long enough English sentence for detection.', 'en'],
    ['Ceci est un texte de test en français pour vérifier que le moteur fonctionne.', 'fr'],
    ['Dies ist ein Testtext auf Deutsch, um zu prüfen, ob die Maschine funktioniert.', 'de'],
    ['Este es un texto de prueba en español para comprobar que el motor funciona.', 'es']
  ];
  const detectMiss = DETECT_CASES
    .filter(([txt, want]) => LANGUTIL.detect(txt) !== want)
    .map(([txt, want]) => want + '≠' + LANGUTIL.detect(txt));
  check('detect() 认出新加的 9 种语言（含拉丁语系细分）（#9）',
    detectMiss.length === 0, detectMiss.join(', ') || DETECT_CASES.length + ' 种全对');

  /* 一句英文里引一个俄文词，不该判成俄文 —— 泰 / 阿 / 西里尔用的是占比门槛，
     不是「出现过就算」。这条就是钉那个门槛的。 */
  check('一句英文里引一个俄文词 → 仍判英文（占比门槛）（#9）',
    LANGUTIL.detect('the Russian word Привет means hello') === 'en',
    LANGUTIL.detect('the Russian word Привет means hello'));

  /* 简繁判定的字表：等长、逐位不同、互不相交、各自无重复 ——
     错一个字就会让某个常用字判错方向，而且完全看不出来。 */
  const hintT = [...LANGUTIL.HINTS.trad];
  const hintS = [...LANGUTIL.HINTS.simp];
  check('简繁字表：等长 / 逐位不同 / 互不相交 / 无重复（#9）',
    hintT.length === hintS.length
      && hintT.length > 20
      && hintT.every((c, i) => c !== hintS[i])
      && new Set(hintT).size === hintT.length
      && new Set(hintS).size === hintS.length
      && hintT.every((c) => hintS.indexOf(c) < 0),
    'len ' + hintT.length + '/' + hintS.length);

  /* other() 是「这对配置里的另一个」，不是「LANGS 里随便另一个」（#9）——
     11 种语言下，从表里猜会切到一门用户根本没配过的语言。 */
  check('other() 在配置的这一对语言之间切，而不是从 LANGS 里猜（#9）',
    LANGUTIL.other('en', 'en', 'ja') === 'ja'
      && LANGUTIL.other('ja', 'en', 'ja') === 'en'
      && LANGUTIL.other('zh', 'zh-Hant', 'zh') === 'zh-Hant'
      && LANGUTIL.other('zh-Hant', 'zh-Hant', 'zh') === 'zh',
    [LANGUTIL.other('en', 'en', 'ja'), LANGUTIL.other('ja', 'en', 'ja')].join(' / '));

  /* 界面语言表（能切的）与语言表（能翻的）不是一回事（#9）——
     混用的话，加一门翻译语言会往「界面语言」下拉里塞进没有文案的语言。 */
  check('界面语言只有有文案表的那些（zh / en），不跟着翻译语言一起长（#9）',
    STRINGS.UI_LANGS.join(',') === 'zh,en'
      && LANGUTIL.LANGS.length > STRINGS.UI_LANGS.length
      && STRINGS.UI_LANGS.every((c) => ('lang.' + c) in STRINGS.STRINGS.zh),
    'UI=' + STRINGS.UI_LANGS.join(',') + ' / 可翻译=' + LANGUTIL.LANGS.length + ' 种');

  /* 引擎代码映射：每个语言都要有 Google 的 tl 与 DeepSeek 的提示词名（#9）。
     漏一行的表现是「选了那门语言，出来的还是中文」——静默、且看不出原因。 */
  const GOOGLE_TL = { zh: 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko',
    fr: 'fr', de: 'de', es: 'es', ru: 'ru', ar: 'ar', th: 'th' };
  const PROMPT_OF = { zh: '简体中文', 'zh-Hant': '繁體中文', en: 'English', ja: '日本語',
    ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский',
    ar: 'العربية', th: 'ไทย' };

  await drain();
  store = {};
  override = { engine: 'google', preferredLang: 'en', targetLang: 'zh', quotaDaily: 0 };
  const tlBad = [];
  for (const l of LANGUTIL.LANGS) {
    captured = {};
    mockFetch = async (url) => {
      captured.url = url;
      return { ok: true, status: 200, json: async () => [[['x', 'y', null, null, 10]], null, 'en'] };
    };
    const g = await call(ZH, l.code);
    const hit = /[?&]tl=([^&]+)/.exec(captured.url || '');
    const tl = hit ? decodeURIComponent(hit[1]) : '(无)';
    if (!g.ok || tl !== GOOGLE_TL[l.code]) tlBad.push(l.code + '→' + tl);
  }
  check('Google 引擎：每种语言的 tl 代码都正确（#9）',
    tlBad.length === 0, tlBad.join(', ') || LANGUTIL.LANGS.length + ' 种全对');

  await drain();
  store = {};
  override = { engine: 'deepseek', preferredLang: 'en', targetLang: 'zh', deepseekKey: 'sk-test', quotaDaily: 0 };
  const promptBad = [];
  for (const l of LANGUTIL.LANGS) {
    captured = {};
    mockFetch = async (url, opts) => {
      captured.body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const d = await call(ZH, l.code);
    const sys = (captured.body && captured.body.messages[0].content) || '';
    if (!d.ok || sys.indexOf(PROMPT_OF[l.code]) < 0) promptBad.push(l.code);
  }
  check('DeepSeek 引擎：每种语言的提示词名都在（#9）',
    promptBad.length === 0, promptBad.join(', ') || LANGUTIL.LANGS.length + ' 种全对');

  /* 设置页「测试翻译」的样本句：每门语言都要有一条（#9）——
     漏了不会报错，`SAMPLE[cfg.preferredLang] || SAMPLE.zh` 会静默退回中文样本，
     表现是「我首选法文，点测试翻译，却在拿中文试」。
     options.js 要 DOM 才能 require，所以这里按源码里的那张表查（与 #39 的扫描同一个路子）。 */
  const optSrc = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
  const sampleBlock = (/const SAMPLE = \{[\s\S]*?\n\};/.exec(optSrc) || [''])[0];
  const sampleMiss = LANGUTIL.LANGS.map((l) => l.code)
    .filter((c) => sampleBlock.indexOf("'" + c + "':") < 0 && sampleBlock.indexOf(c + ':') < 0);
  check('设置页的测试样本句覆盖每一门语言（#9）',
    sampleBlock.length > 0 && sampleMiss.length === 0,
    sampleMiss.join(', ') || LANGUTIL.LANGS.length + ' 种');

  /* 23. 未配置凭据的错误必须带机器可读的 code（#58）——
     浮层靠它决定「要不要给一个能点的动作」；靠正则去猜文案迟早会失效。

     ⚠️ 这里必须清缓存：上面已经用 (deepseek, en, ZH) 缓存过一条，
     不清的话这次会**命中缓存直接返回 ok**，根本走不到「没 key」那一步。
     顺带说明一个刻意保留的行为：**缓存命中优先于凭据检查** ——
     命中就不发请求、不花钱，所以不需要 key 也说得通。 */
  await drain();
  store = {};

  override = { engine: 'deepseek', deepseekKey: '' };
  const noKey = await call(ZH);
  check('未配置凭据时报 no-key 错误码',
    noKey.ok === false && noKey.code === 'no-key',
    JSON.stringify({ ok: noKey.ok, code: noKey.code }));

  /* 24. 「去设置」消息要被后台转成 openOptionsPage ——
     content script 不能直接调那个 API（它是扩展页面 API）。 */
  openedOptions = 0;
  const opened = await send({ type: 'openOptions' });
  check('openOptions 消息被转发到 openOptionsPage',
    !!(opened && opened.ok === true) && openedOptions === 1,
    'calls=' + openedOptions);

  /* 25 / 26. 首次安装自动打开设置页，升级不打扰（#58） */
  openedOptions = 0;
  if (installedHandler) installedHandler({ reason: 'update' });
  check('升级时不打开设置页', openedOptions === 0, 'calls=' + openedOptions);

  openedOptions = 0;
  if (installedHandler) installedHandler({ reason: 'install' });
  check('首次安装自动打开设置页', openedOptions === 1, 'calls=' + openedOptions);

  /* 27. 默认方向是「英文 → 中文」（2026-09-24 用户确认）。
     主要场景是读英文页面，划词出来中文。 */
  check('DEFAULTS 默认方向是 英文 → 中文',
    CFG.DEFAULTS.preferredLang === 'en' && CFG.DEFAULTS.targetLang === 'zh',
    CFG.DEFAULTS.preferredLang + ' → ' + CFG.DEFAULTS.targetLang);

  /* 28 / 29. 老配置迁移：老的那个 targetLang 是**输出语言**，迁移后必须仍然是输出语言。
     ⚠️ 反过来写（当成 preferredLang）会把 targetLang='en' 的用户从「译成英文」
     悄悄改成「译成中文」—— 默认值改成「英→中」之后特别容易写错。 */
  savedCfg = null;
  override = { targetLang: 'zh', deepseekKey: 'sk-test' };   // 老配置：只想译成中文
  if (installedHandler) installedHandler({ reason: 'update' });
  await tick();
  check('老配置 targetLang=zh 迁移后仍译成中文',
    !!savedCfg && savedCfg.targetLang === 'zh' && savedCfg.preferredLang === 'en',
    JSON.stringify(savedCfg && { p: savedCfg.preferredLang, t: savedCfg.targetLang }));

  savedCfg = null;
  override = { targetLang: 'en', deepseekKey: 'sk-test' };   // 老配置：只想译成英文
  if (installedHandler) installedHandler({ reason: 'update' });
  await tick();
  check('老配置 targetLang=en 迁移后仍译成英文',
    !!savedCfg && savedCfg.targetLang === 'en' && savedCfg.preferredLang === 'zh',
    JSON.stringify(savedCfg && { p: savedCfg.preferredLang, t: savedCfg.targetLang }));

  /* ---------- 触发方式（#6）----------

     这条只断言默认值。真正的行为（选中只出圆点、点了才发请求）发生在 content.js，
     那是 e2e-panel.js 的地盘 —— 这里测不到 DOM。
     ⚠️ 实现 #6 时最容易犯的错就是「顺手把默认值改成 manual」，这条断言就是拦它的。 */
  check('DEFAULTS.triggerMode 默认是 auto（#6）',
    CFG.DEFAULTS.triggerMode === 'auto', String(CFG.DEFAULTS.triggerMode));

  /* ---------- 技术内容判定（#60） ----------
     纯函数，直接断言。这几条是「默认开」的底气 —— 判错的代价虽然有出口
     （浮层上永远有一个「仍然翻译」），但判错太多，这个开关就没人敢开了。 */

  const SKIP_SAMPLES = [
    ['https://github.com/eighteentang/eighteen-translator/issues', 'url'],
    ['www.example.com/docs/getting-started', 'url'],
    ['zhang.san@example.com', 'mail'],
    ['src/content/panel.js', 'path'],
    ['C:\\Users\\me\\project\\app.js', 'path'],
    ['npm install puppeteer-core', 'shell'],
    ['git commit -m "fix: 修复浮层定位"', 'shell'],
    ['$ npm run build', 'shell'],
    ['function pick() { return sel.toString().trim(); }', 'code'],
    ['<div class="wrap">{children}</div>', 'code']
  ];
  const skipMiss = SKIP_SAMPLES.filter(([s, want]) => TECH.looksTechnical(s) !== want);
  check('技术内容：URL / 邮箱 / 路径 / 命令行 / 代码五类样本全部命中（#60）',
    skipMiss.length === 0,
    skipMiss.length
      ? skipMiss.map(([s]) => '[' + TECH.looksTechnical(s) + ']' + s).join(' | ')
      : SKIP_SAMPLES.length + '/' + SKIP_SAMPLES.length + ' 命中');

  /* 这一组是「不许误伤」的样本。刻意挑的都是**看起来有点像代码**的正常句子：
     分号、引号花括号、斜杠、带点的数字、句首的 Git —— 判定要是糙一点就会全中。 */
  const KEEP_SAMPLES = [
    'The quick brown fox jumps over the lazy dog near the riverbank at dawn.',
    'Translation is the communication of meaning from one language to another.',
    '这是一段足够长的中文文本，用来测试翻译方向。',
    'He said: "{quoted content}"',
    'She arrived; he left without a word.',
    'The ratio a/b is about 3.5/4.2 in this case.',
    'On 2024/01/15 the release went out.',
    'Either/or is a false choice in most cases.',
    'Git is a distributed version control system.'
  ];
  const keptWrong = KEEP_SAMPLES.filter((s) => TECH.looksTechnical(s) !== '');
  check('技术内容：正常句子不被误判（#60）',
    keptWrong.length === 0,
    keptWrong.length
      ? keptWrong.map((s) => '[' + TECH.looksTechnical(s) + ']' + s).join(' | ')
      : KEEP_SAMPLES.length + '/' + KEEP_SAMPLES.length + ' 正确放过');

  /* 长度闸门：长文里夹一行代码时，跳过整段才是真正的误伤 */
  const longPlain = 'word '.repeat(60);
  const longWithUrl = 'https://example.com/a/b 这里是一段很长的说明文字。'.repeat(8);
  check('技术内容：超过 MAX_LEN 就不判定（长文里夹个链接不该跳过整段）（#60）',
    longPlain.length > TECH.MAX_LEN && TECH.looksTechnical(longPlain) === ''
      && TECH.looksTechnical(longWithUrl) === '',
    'MAX_LEN=' + TECH.MAX_LEN + ' 样本长度=' + longPlain.length + '/' + longWithUrl.length);

  /* 类别 → 文案必须一一对应：浮层要把「拦的是什么」说出来，
     漏一个类别就会退化成含糊的「技术内容」。
     ⚠️ 文案本身在 strings.js（#39）—— 所以这里断言的是「每个类别都有对应的键」，
     而不是「tech.js 里有一张写死的中文表」。 */
  check('技术内容：每个类别都有专门的文案（#60）',
    TECH.KINDS.every((k) => {
      const key = 'tech.' + k;
      return STRINGS.STRINGS.zh[key] && STRINGS.STRINGS.zh[key] !== STRINGS.STRINGS.zh['tech.other'];
    }),
    TECH.KINDS.map((k) => k + '=' + STRINGS.STRINGS.zh['tech.' + k]).join(' / '));

  /* ---------- 朗读（#10） ----------

     只用浏览器内置的 speechSynthesis。这一节测的都是**纯函数与状态机**，
     用桩件注入 —— 真正「发出声音」验不了（无头环境没有音频输出），
     所以那一条在 e2e 与 issue 评论里都写明了要真机确认。 */

  const RS = CFG.RATE_STEPS;
  check('朗读：语速三档、倍率递增，认不出的档位退回中间档（#10）',
    RS.length === 3 && RS[0].rate < RS[1].rate && RS[1].rate < RS[2].rate
      && CFG.stepRate('fast') === RS[2].rate
      && CFG.stepRate('nope') === RS[1].rate,
    RS.map((s) => s.id + '=' + s.rate).join(' / '));

  check('朗读：默认语速 normal、口音 auto（跟随系统）（#10）',
    CFG.DEFAULTS.speakRate === 'normal' && CFG.DEFAULTS.speakAccent === 'auto',
    CFG.DEFAULTS.speakRate + ' / ' + CFG.DEFAULTS.speakAccent);

  const SPLIT_CASES = [
    ['Hello. World! Yes?', 3],
    ['你好。世界！今天真好？', 3],
    ['没有句末标点的短句', 1],
    ['', 0],
    ['   ', 0],
    ['！？…。', 0]
  ];
  const splitBad = SPLIT_CASES
    .filter(([s, n]) => SPEAK.splitSentences(s).length !== n)
    .map(([s, n]) => JSON.stringify(s) + '→' + SPEAK.splitSentences(s).length + '≠' + n);
  check('朗读：分句认中英文标点，空串 / 纯符号返回空数组（#10）',
    splitBad.length === 0, splitBad.join(' | ') || SPLIT_CASES.length + ' 例');

  const longSpeak = '这是一个很长的句子，'.repeat(40) + '。';
  const longParts = SPEAK.splitSentences(longSpeak);
  check('朗读：超长句按软标点二次切分，每段不超过上限（#10）',
    longParts.length > 1 && longParts.every((p) => p.length <= SPEAK.MAX_SENTENCE),
    longParts.length + ' 段，最长 ' + Math.max.apply(null, longParts.map((p) => p.length)) +
      '（上限 ' + SPEAK.MAX_SENTENCE + '）');

  const V = (lang, extra) => Object.assign({ lang: lang }, extra || {});
  const VOICES = [
    V('ja-JP', { localService: true }),
    V('en-US', { localService: false, default: true }),
    V('en-GB', { localService: true }),
    V('zh-CN', { localService: true })
  ];

  /* ⚠️ 这条是「不要直接用 getVoices()[0]」的自动化版本：
     挑错语音的表现是「选了日文、读出来是英文」，用户完全看不出原因。 */
  check('朗读：选音按语言过滤，不会硬塞一门别的语言（#10）',
    SPEAK.pickVoice(VOICES, 'ja', 'auto').lang === 'ja-JP'
      && SPEAK.pickVoice(VOICES, 'zh', 'auto').lang === 'zh-CN'
      && SPEAK.pickVoice(VOICES, 'ru', 'auto') === null,
    'ja/zh/ru → ' + ['ja', 'zh', 'ru']
      .map((l) => JSON.stringify((SPEAK.pickVoice(VOICES, l, 'auto') || {}).lang || null)).join(' / '));

  check('朗读：英语口音真的换到那一套语音，且同一档里优先本地语音（#10）',
    SPEAK.pickVoice(VOICES, 'en', 'en-US').lang === 'en-US'
      && SPEAK.pickVoice(VOICES, 'en', 'en-GB').lang === 'en-GB'
      && SPEAK.pickVoice(VOICES, 'en', 'auto').lang === 'en-GB',
    ['en-US', 'en-GB', 'auto']
      .map((a) => a + '→' + (SPEAK.pickVoice(VOICES, 'en', a) || {}).lang).join(' / '));

  const VOICES2 = [
    V('en-US', { localService: true }),
    V('en-GB', { localService: true, default: true })
  ];
  check('朗读：本地语音里再优先系统默认那条（#10）',
    SPEAK.pickVoice(VOICES2, 'en', 'auto').lang === 'en-GB'
      && SPEAK.pickVoice([], 'en', 'auto') === null
      && SPEAK.pickVoice(null, 'en', 'auto') === null,
    (SPEAK.pickVoice(VOICES2, 'en', 'auto') || {}).lang);

  check('朗读：canceled / interrupted 不算错误（用户自己停的，不该报「朗读失败」）（#10）',
    SPEAK.isBenignError('canceled') && SPEAK.isBenignError('interrupted')
      && !SPEAK.isBenignError('synthesis-failed') && !SPEAK.isBenignError(undefined));

  function mockSynth(voices) {
    return {
      list: voices || [],
      spoken: [],
      cancelled: 0,
      getVoices() { return this.list; },
      speak(u) { this.spoken.push(u); },
      cancel() { this.cancelled++; }
    };
  }
  function MockUtterance(text) { this.text = text; }

  const EN_VOICE = [V('en-US', { localService: true })];

  const st1 = [];
  const s1 = mockSynth(EN_VOICE);
  const sp1 = SPEAK.createSpeaker({
    synth: s1, Utterance: MockUtterance, lang: 'en', accent: 'auto', rate: 1.5,
    onState: (x) => st1.push(x), onError: () => {}
  });
  const ok1 = sp1.start('One. Two.');
  s1.spoken[0].onend();
  s1.spoken[1].onend();
  check('朗读：分句排队逐句读完，读完回到 idle（#10）',
    ok1 === true && s1.spoken.length === 2
      && s1.spoken[0].text === 'One.' && s1.spoken[1].text === 'Two.'
      && s1.spoken[0].rate === 1.5
      && s1.spoken[0].voice.lang === 'en-US'
      && st1.join(',') === 'speaking,idle'
      && sp1.isSpeaking() === false,
    JSON.stringify({ spoken: s1.spoken.length, states: st1.join(','), rate: s1.spoken[0].rate }));

  const st2 = [];
  const s2 = mockSynth(EN_VOICE);
  const sp2 = SPEAK.createSpeaker({
    synth: s2, Utterance: MockUtterance, lang: 'en', accent: 'auto', rate: 1,
    onState: (x) => st2.push(x), onError: () => {}
  });
  sp2.start('One. Two. Three.');
  /* start() 自己会先 cancel 一次（清掉上一轮的队列），所以这里量的是**增量** ——
     直接断言总数会把那条合理行为误判成 bug。 */
  const cancelBeforeStop = s2.cancelled;
  sp2.stop();
  const staleEnd = s2.spoken[0];
  if (staleEnd.onend) staleEnd.onend();   // 停止之后旧回调再触发也不能继续推进
  check('朗读：停止会 cancel 合成器、回到 idle，且旧回调不再推进（#10）',
    s2.cancelled === cancelBeforeStop + 1 && st2.join(',') === 'speaking,idle'
      && sp2.isSpeaking() === false && s2.spoken.length === 1,
    JSON.stringify({ cancelled: s2.cancelled, states: st2.join(','), spoken: s2.spoken.length }));

  const st3 = [];
  const err3 = [];
  const s3 = mockSynth(EN_VOICE);
  const sp3 = SPEAK.createSpeaker({
    synth: s3, Utterance: MockUtterance, lang: 'en', accent: 'auto', rate: 1,
    onState: (x) => st3.push(x), onError: (e) => err3.push(e)
  });
  sp3.start('One. Two.');
  s3.spoken[0].onerror({ error: 'canceled' });          // 用户主动停 —— 不该报错
  const afterBenign = sp3.isSpeaking();
  s3.spoken[0].onerror({ error: 'synthesis-failed' });  // 真错误 —— 报一次并结束
  check('朗读：canceled 不报错，真错误报一次并结束（#10）',
    afterBenign === true && err3.length === 1 && err3[0] === 'synthesis-failed'
      && sp3.isSpeaking() === false && st3[st3.length - 1] === 'idle',
    JSON.stringify({ benign: afterBenign, errs: err3, states: st3.join(',') }));

  /* 看门狗：切到后台标签页时 `onend` 可能永远不来，队列会卡死、
     按钮一直停在「停止」。用一个假定时器把 18 秒快进掉。 */
  let wd = null;
  const s4 = mockSynth(EN_VOICE);
  const sp4 = SPEAK.createSpeaker({
    synth: s4, Utterance: MockUtterance, lang: 'en', accent: 'auto', rate: 1,
    setTimeout: (fn) => { wd = fn; return 1; },
    clearTimeout: () => { wd = null; },
    onState: () => {}, onError: () => {}
  });
  sp4.start('One. Two.');
  const beforeWd = s4.spoken.length;
  if (wd) wd();
  check('朗读：看门狗在单句超时后强制推进（#10）',
    beforeWd === 1 && s4.spoken.length === 2, beforeWd + ' → ' + s4.spoken.length);
  sp4.stop();

  const s5 = mockSynth([]);
  const sp5 = SPEAK.createSpeaker({
    synth: s5, Utterance: MockUtterance, lang: 'en', accent: 'auto', rate: 1,
    onState: () => {}, onError: () => {}
  });
  const s6 = mockSynth([V('ja-JP', { localService: true })]);
  const sp6 = SPEAK.createSpeaker({
    synth: s6, Utterance: MockUtterance, lang: 'en', accent: 'auto', rate: 1,
    onState: () => {}, onError: () => {}
  });
  check('朗读：没有语音包 / 没有这门语言的语音包时 start 返回 false（调用方靠它给提示）（#10）',
    sp5.start('Hello.') === false && sp6.start('Hello.') === false
      && sp5.isSpeaking() === false && sp6.isSpeaking() === false,
    'no-voices=' + sp5.start('Hello.') + ' wrong-lang=' + sp6.start('Hello.'));

  /* 档位 / 口音的文案键。⚠️ 这里用 STRINGS.STRINGS.zh 而不是后面那个 ZH_T ——
     后者在 #39 那一节才声明，在这里读会踩 const 的暂时性死区。 */
  const SPEAK_ZH = STRINGS.STRINGS.zh;
  const SPEAK_EN = STRINGS.STRINGS.en;
  const SPEAK_KEYS = ['step.slow', 'step.normal', 'step.fast', 'opt.secSpeak', 'opt.speakRate',
    'opt.speakRateDesc', 'opt.speakAccent', 'opt.speakAccentDesc', 'opt.accentAuto',
    'opt.accentUS', 'opt.accentGB', 'opt.speakNote',
    'panel.readOut', 'panel.readOriginal', 'panel.stopRead', 'panel.noVoice', 'panel.noVoiceLang',
    'panel.readFail'];
  const speakMissKey = SPEAK_KEYS.filter((k) => !(k in SPEAK_ZH) || !(k in SPEAK_EN));
  check('朗读：语速 / 口音 / 浮层按钮的文案键都在（zh 与 en）（#10）',
    speakMissKey.length === 0, speakMissKey.join(', ') || SPEAK_KEYS.length + ' 条');

  /* ---------- 每日上限 / 用量统计 / 结果缓存（#19 / #18 / #17） ----------

     这三个共用 `store` 里那两个键。每个用例都**先 drain 再重置 store** ——
     残留的缓存写入（cacheChain 是串行的，可能还没落盘）会污染下一个用例。 */

  const today = CFG.todayKey();

  check('DEFAULTS.quotaDaily 默认为 500（#19）',
    CFG.DEFAULTS.quotaDaily === 500, String(CFG.DEFAULTS.quotaDaily));

  check('todayKey 是本地日期 YYYY-MM-DD（#18）',
    /^\d{4}-\d{2}-\d{2}$/.test(today), today);

  /* ---------- 浮层字号 / 宽度的档位表（#25）----------

     这一节测的是**共享档位表**本身。「改完设置浮层当场变」验不到这里 ——
     那要真的浏览器，见 dev/e2e-panel.js。 */

  /* 这两个键必须在 DEFAULTS 里：content.js 的 storage.onChanged 只同步
     DEFAULTS 里存在的键（见那段 hasOwnProperty 判断）——
     漏了的话，改设置会**静默不生效**，而存储里明明写进去了。 */
  check('字号 / 宽度在 DEFAULTS 里（否则 storage.onChanged 不会同步给 content script）（#25）',
    Object.prototype.hasOwnProperty.call(CFG.DEFAULTS, 'panelFont')
      && Object.prototype.hasOwnProperty.call(CFG.DEFAULTS, 'panelWidth'),
    Object.keys(CFG.DEFAULTS).join(', '));

  check('浮层字号 / 宽度默认是中间档（#25）',
    CFG.DEFAULTS.panelFont === 'md' && CFG.DEFAULTS.panelWidth === 'md',
    CFG.DEFAULTS.panelFont + ' / ' + CFG.DEFAULTS.panelWidth);

  /* 默认档位的像素值必须与改造前写死的 14px / 420px 完全一致 ——
     不一致的话，「升级之后浮层变样了」会被当成 bug 报上来。 */
  check('默认档位与改造前写死的 14px / 420px 一致（#25）',
    CFG.stepPx(CFG.FONT_STEPS, CFG.DEFAULTS.panelFont) === 14
      && CFG.stepPx(CFG.WIDTH_STEPS, CFG.DEFAULTS.panelWidth) === 420,
    CFG.stepPx(CFG.FONT_STEPS, CFG.DEFAULTS.panelFont) + 'px / '
      + CFG.stepPx(CFG.WIDTH_STEPS, CFG.DEFAULTS.panelWidth) + 'px');

  check('字号四档、宽度三档，且都包含默认那一档（#25）',
    CFG.FONT_STEPS.length === 4 && CFG.WIDTH_STEPS.length === 3
      && CFG.FONT_STEPS.map((s) => s.px).join(',') === '10,14,18,24'
      && CFG.FONT_STEPS.some((s) => s.id === CFG.DEFAULTS.panelFont)
      && CFG.WIDTH_STEPS.some((s) => s.id === CFG.DEFAULTS.panelWidth),
    CFG.FONT_STEPS.map((s) => s.id + '=' + s.px).join(' ')
      + ' · ' + CFG.WIDTH_STEPS.map((s) => s.id + '=' + s.px).join(' '));

  /* 认不出的档位名必须**退回中间档**，而不是第一档：
     存储里可能留着老版本删掉的档位名（或用户手改的值），
     退回最小字号 / 最窄宽度会让人以为设置坏了。 */
  check('认不出的档位名退回中间档（#25）',
    CFG.stepPx(CFG.FONT_STEPS, 'nope') === 14
      && CFG.stepPx(CFG.WIDTH_STEPS, 'nope') === 420
      && CFG.stepPx(CFG.FONT_STEPS, undefined) === 14,
    'font=' + CFG.stepPx(CFG.FONT_STEPS, 'nope')
      + ' width=' + CFG.stepPx(CFG.WIDTH_STEPS, 'nope'));

  /* 档位 id 不能重复：重复的话下拉里会出现两个同值选项，
     选中一个另一个也跟着变，改档位会变得莫名其妙。 */
  const hasDupe = (list) => new Set(list.map((s) => s.id)).size !== list.length;
  check('档位表的 id 不重复（#25）',
    !hasDupe(CFG.FONT_STEPS) && !hasDupe(CFG.WIDTH_STEPS),
    CFG.FONT_STEPS.map((s) => s.id).join(',') + ' | ' + CFG.WIDTH_STEPS.map((s) => s.id).join(','));

  /* ---------- 排除站点匹配（#29）----------

     这里测的是**规则**。「命中之后真的不注册监听、不发请求」要真的浏览器，
     见 dev/e2e-panel.js。 */

  const M = (host, text) => SITES.matches(host, SITES.parse(text).list);

  /* 后缀匹配必须**卡住点号边界**。不卡的话 example.com 会命中 notexample.com，
     用户填一个域名等于顺手排除了别人的站 —— 这类错最难被发现，
     因为表现是「某个网站莫名其妙不翻译了」。 */
  check('排除站点：后缀匹配命中自身与子域（#29）',
    M('example.com', 'example.com') && M('a.example.com', 'example.com')
      && M('a.b.example.com', 'example.com') && M('EXAMPLE.COM', 'example.com'),
    'example.com / a.example.com / a.b.example.com / EXAMPLE.COM');

  check('排除站点：后缀匹配卡住点号边界，不误伤别人的站（#29）',
    !M('notexample.com', 'example.com') && !M('example.com.evil.com', 'example.com')
      && !M('myexample.com', 'example.com'),
    'notexample.com / example.com.evil.com / myexample.com');

  check('排除站点：*. 前缀与不写完全等价（#29）',
    M('a.google.com', '*.google.com') && M('google.com', '*.google.com')
      && !M('google.com.hk', '*.google.com'),
    'a.google.com / google.com / google.com.hk');

  /* 用户会直接粘网址 —— 规范化做不到位的话，「加了没用」而且界面上看不出异常 */
  check('排除站点：粘贴的网址会被规范化成域名（#29）',
    M('mail.google.com', 'https://mail.google.com/mail/u/0?x=1#top')
      && M('example.com', 'http://example.com:8080/a/b')
      && M('example.com', 'example.com.'),
    'https://…/mail/u/0?x=1#top · http://example.com:8080/a/b · example.com.');

  check('排除站点：空行与 # 备注被跳过，不算错（#29）',
    (() => {
      const r = SITES.parse('\n# 公司内网\nintranet\n\n');
      return r.bad.length === 0 && r.list.length === 1 && r.list[0] === 'intranet';
    })(), JSON.stringify(SITES.parse('\n# 公司内网\nintranet\n\n')));

  check('排除站点：重复的行不重复存，也不报错（#29）',
    (() => {
      const r = SITES.parse('a.com\nA.com\na.com\n');
      return r.bad.length === 0 && r.list.length === 1;
    })(), JSON.stringify(SITES.parse('a.com\nA.com\na.com\n').list));

  /* 写错的行要报出来**并带行号** —— 设置页要能说清「是第几行」，
     否则用户在一堆域名里找不出哪一行有问题。 */
  const badSites = SITES.parse('good.com\nfoo.*.com\n*\nhttp://\nexa mple.com\n-bad.com');
  check('排除站点：写错的行被报出来，并带行号（#29）',
    badSites.list.length === 1 && badSites.list[0] === 'good.com'
      && badSites.bad.length === 5
      && badSites.bad[0].line === 2 && badSites.bad[0].text === 'foo.*.com',
    '合法=' + badSites.list.length + ' 非法=' + badSites.bad.length
      + ' 首个=' + JSON.stringify(badSites.bad[0]));

  /* 空列表 / 空域名不能命中任何东西 —— 这是「默认不排除任何站点」的保证，
     写错的话默认配置会让整个扩展在所有站点上都不工作。 */
  check('排除站点：空列表不命中任何域名（#29）',
    !M('example.com', '') && !M('example.com', '\n\n# 只有备注\n')
      && !M('', 'example.com') && !M('   ', 'example.com'),
    '空文本 / 只有备注 / 空 hostname');

  /* 单段主机名（公司内网）必须能用 —— 否则「wiki / jira」这类站没法排除 */
  check('排除站点：单段主机名（内网）也能匹配（#29）',
    M('wiki', 'wiki') && M('wiki', 'wiki') && !M('wiki.example.com', 'wiki'),
    'wiki / wiki.example.com');

  /* DEFAULTS 里必须有这个键：content.js 的 storage.onChanged 只同步 DEFAULTS 里
     存在的键，漏了的话「改完列表没反应」会以最莫名其妙的方式出现。 */
  check('DEFAULTS.excludeSites 默认为空（所有站点都生效）（#29）',
    Object.prototype.hasOwnProperty.call(CFG.DEFAULTS, 'excludeSites')
      && CFG.DEFAULTS.excludeSites === '',
    JSON.stringify(CFG.DEFAULTS.excludeSites));

  /* setExcluded 是 popup 那个勾选框的写入逻辑（#29）。
     ⚠️ 最要紧的一条是「**只动相关的行**」：列表里可能有 # 备注、
     也可能有一行还没改完的错写法 —— 从 parse() 的结果重新拼一份的话，
     它们会被悄悄删掉，而用户在设置页里看不到任何提示。 */
  check('排除列表：勾上时加进当前域名（#29）',
    SITES.setExcluded('', 'a.example.com', true) === 'a.example.com'
      && SITES.setExcluded('b.com\n', 'a.example.com', true) === 'b.com\na.example.com',
    JSON.stringify(SITES.setExcluded('b.com\n', 'a.example.com', true)));

  check('排除列表：取消时移掉会命中当前域名的规则（#29）',
    SITES.setExcluded('a.example.com\nb.com', 'a.example.com', false) === 'b.com'
      && SITES.setExcluded('example.com\nb.com', 'a.example.com', false) === 'b.com'
      && SITES.setExcluded('*.example.com\nb.com', 'a.example.com', false) === 'b.com',
    JSON.stringify(SITES.setExcluded('example.com\nb.com', 'a.example.com', false)));

  check('排除列表：增删时保留 # 备注与写错的行（#29）',
    (() => {
      const text = '# 公司内网\nintranet\nfoo.*.com';
      const off = SITES.setExcluded(text, 'intranet', false);
      const on = SITES.setExcluded(text, 'wiki', true);
      return off === '# 公司内网\nfoo.*.com'
        && on === '# 公司内网\nintranet\nfoo.*.com\nwiki';
    })(),
    JSON.stringify(SITES.setExcluded('# 公司内网\nintranet\nfoo.*.com', 'intranet', false)));

  /* popup 要问「当前标签页是哪个域名」。三种失败都不能抛异常 ——
     抛出去的话 popup 会白屏，而用户只看到「点开是空的」。 */
  override = {};
  tabList = [{ id: 1 }];
  tabAnswer = 'a.example.com';
  tabFails = false;
  let hn = await send({ type: 'hostname' });
  check('hostname：能拿到当前标签页的域名（#29）',
    hn.ok === true && hn.hostname === 'a.example.com', JSON.stringify(hn));

  tabFails = true;
  hn = await send({ type: 'hostname' });
  check('hostname：页面里没有内容脚本时返回空，不报错（#29）',
    hn.ok === false && hn.hostname === '', JSON.stringify(hn));

  tabFails = false;
  tabList = [];
  hn = await send({ type: 'hostname' });
  check('hostname：没有活动标签页时返回空，不报错（#29）',
    hn.ok === false && hn.hostname === '', JSON.stringify(hn));

  tabList = [{ id: 1 }];
  tabAnswer = '';          // 内容脚本答了，但域名是空的（file:// 之类）
  hn = await send({ type: 'hostname' });
  check('hostname：域名是空串时返回 ok=false（#29）',
    hn.ok === false && hn.hostname === '', JSON.stringify(hn));
  tabAnswer = 'example.com';

  /* 一个会看引擎返回不同形状的 mock —— 下面要测「换引擎后缓存不命中」 */
  let hit = 0;
  mockFetch = async (url) => {
    hit++;
    if (String(url).includes('googleapis')) {
      return { ok: true, status: 200, json: async () => [[['你好', 'hi', null, null, 10]], null, 'en'] };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) };
  };

  /* 30. 到上限后必须在**发请求之前**就拦住 —— 发出去就计费了，#19 就没有意义 */
  await drain();
  store = { usage: { byDay: {} } };
  store.usage.byDay[today] = 3;
  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'en', deepseekKey: 'sk-test', quotaDaily: 3 };
  hit = 0;
  let q = await call(ZH);
  check('到每日上限后不发请求，并返回 quota 错误码（#19）',
    q.ok === false && q.code === 'quota' && hit === 0,
    JSON.stringify({ ok: q.ok, code: q.code, hit: hit }));

  /* 31. 未到上限：正常翻译，并且计数 +1 */
  await drain();
  store = { usage: { byDay: {} } };
  store.usage.byDay[today] = 1;
  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'en', deepseekKey: 'sk-test', quotaDaily: 3 };
  hit = 0;
  q = await call(ZH);
  check('未到上限时正常翻译，并把用量加一（#19 / #18）',
    q.ok === true && hit === 1 && store.usage.byDay[today] === 2,
    JSON.stringify({ ok: q.ok, hit: hit, count: store.usage.byDay[today] }));

  /* 32. 缓存命中：不发请求、也不计数
     不计数是关键 —— 否则反复划同一个词会莫名撞上限，用户完全无法理解 */
  await drain();
  store = { usage: { byDay: {} } };
  hit = 0;
  const c1 = await call(ZH);
  const after1 = store.usage.byDay[today] || 0;
  const c2 = await call(ZH);
  check('同样的内容第二次命中缓存：不发请求、不重复计数（#17）',
    c1.ok === true && c2.ok === true && c2.cached === true && hit === 1
      && after1 === 1 && (store.usage.byDay[today] || 0) === 1,
    JSON.stringify({ hit: hit, after1: after1, after2: store.usage.byDay[today] || 0, cached: c2.cached }));

  /* 33. 缓存键必须含目标语言 —— 否则改完方向会拿到旧译文，
     而且是以「改了设置不生效」的形式暴露，最难查 */
  hit = 0;
  const c3 = await call(ZH, 'zh');   // 强制成中文，与缓存里那条英文方向不同
  check('缓存键含目标语言：换方向后不命中旧缓存（#17）',
    c3.ok === true && c3.cached !== true && hit === 1,
    JSON.stringify({ ok: c3.ok, cached: c3.cached, hit: hit }));

  /* 34. 缓存键也必须含引擎 */
  hit = 0;
  override = { engine: 'google', preferredLang: 'zh', targetLang: 'en' };
  const c4 = await call(ZH);
  check('缓存键含引擎：换引擎后不命中旧缓存（#17）',
    c4.ok === true && c4.cached !== true && hit === 1,
    JSON.stringify({ ok: c4.ok, cached: c4.cached, hit: hit }));

  /* 35. 超长**译文**不写缓存 —— 一条就能吃掉可观的存储，不如让它老实重复请求。
     （量的是存进去的译文，不是原文；原文那边 content.js 已卡在 1000 字符。） */
  await drain();
  store = { usage: { byDay: {} } };
  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'en', deepseekKey: 'sk-test' };
  hit = 0;
  const normalFetch = mockFetch;
  mockFetch = async () => {
    hit++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x'.repeat(2100) } }] }) };
  };
  const l1 = await call(ZH);
  const l2 = await call(ZH);
  mockFetch = normalFetch;
  check('超长译文不写缓存（#17）',
    l1.ok === true && l2.ok === true && hit === 2,
    JSON.stringify({ hit: hit, cached: l2.cached }));

  /* 36. 跨天归零：昨天的用量不该占用今天的额度 */
  await drain();
  store = { usage: { byDay: { '2020-01-01': 999 } } };
  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'en', deepseekKey: 'sk-test', quotaDaily: 3 };
  hit = 0;
  q = await call(ZH);
  check('昨天的用量不占用今天的额度（跨天归零）（#19）',
    q.ok === true && hit === 1, JSON.stringify({ ok: q.ok, hit: hit }));

  /* 37. 只留最近 30 天 —— 否则这个键会随使用无限膨胀 */
  await drain();
  const oldDays = {};
  const p2 = (n) => (n < 10 ? '0' + n : String(n));
  for (let i = 1; i <= 40; i++) {
    const d = new Date(Date.UTC(2020, 0, i));
    oldDays['2020-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())] = 1;
  }
  oldDays[today] = 0;
  store = { usage: { byDay: oldDays } };
  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'en', deepseekKey: 'sk-test', quotaDaily: 0 };
  await call(ZH);
  const keptKeys = Object.keys(store.usage.byDay);
  check('用量只保留最近 30 天（#18）',
    keptKeys.length === 30 && keptKeys[keptKeys.length - 1] === today,
    '天数=' + keptKeys.length + ' 最新=' + keptKeys[keptKeys.length - 1]);

  /* ---------- 文案单一真源（#39） ----------

     这一节守的是「文案不许再散回源码里」。三层：
       ① 两张表的键必须完全一致 —— 少一个键**不会报错**，只会静默回退成中文，
          表现是「英文界面里冒出一句中文」；
       ② 每个动态拼出来的键（step.<id> / lang.<code> / tech.<kind>）都必须存在；
       ③ 源码里不许再有中文的字符串字面量（例外必须显式标 i18n-allow 并写明理由）。
     ⚠️ ③ 是这一节里最要紧的一条 —— 它是唯一能挡住「下一个人顺手写死一句话」的防线。 */

  const ZH_T = STRINGS.STRINGS.zh;
  const EN_T = STRINGS.STRINGS.en;
  const i18nZhKeys = Object.keys(ZH_T).sort();
  const i18nEnKeys = Object.keys(EN_T).sort();
  const i18nOnlyZh = i18nZhKeys.filter((k) => !(k in EN_T));
  const i18nOnlyEn = i18nEnKeys.filter((k) => !(k in ZH_T));

  check('文案：zh / en 两张表的键完全一致（#39）',
    i18nOnlyZh.length === 0 && i18nOnlyEn.length === 0,
    '仅 zh: ' + (i18nOnlyZh.join(', ') || '-') + ' / 仅 en: ' + (i18nOnlyEn.join(', ') || '-') + '（共 ' + i18nZhKeys.length + ' 条）');

  /* 插值：{name} 要真的被换掉，而且不留残渣 */
  const i18nInterp = STRINGS.t('panel.altTo', { lang: 'XYZ' });
  check('文案：t() 做 {name} 插值（#39）',
    i18nInterp.includes('XYZ') && !i18nInterp.includes('{lang}'), i18nInterp);

  /* 缺键 → **返回键名**，绝不返回空串。
     空串是最坏的结果：界面上少一句话，没有任何痕迹，也没人会发现。 */
  check('文案：缺键返回键名而不是空串（#39）',
    STRINGS.t('no.such.key') === 'no.such.key' && STRINGS.t('no.such.key') !== '',
    JSON.stringify(STRINGS.t('no.such.key')));

  /* 英文缺键 → 回退中文（#35 之后用户可能手动切到英文，宁可中英混一句，
     也不能让整句话消失）。这里临时从 en 表里抠掉一个键来验。 */
  const i18nKeptEn = EN_T['panel.copy'];
  delete EN_T['panel.copy'];
  STRINGS.setLang('en');
  const i18nFellBack = STRINGS.t('panel.copy');
  EN_T['panel.copy'] = i18nKeptEn;
  STRINGS.setLang('zh');
  check('文案：英文缺键时回退到中文（#39）', i18nFellBack === ZH_T['panel.copy'], i18nFellBack);

  /* 认不出的语言码 → 退回默认语言，不能把 lang 变成一个空表 */
  check('文案：setLang 认不出的语言码退回默认（#39）',
    STRINGS.setLang('xx') === STRINGS.DEFAULT_LANG && STRINGS.getLang() === STRINGS.DEFAULT_LANG,
    STRINGS.getLang());
  STRINGS.setLang('zh');

  /* 动态拼出来的键：加档位 / 加语言 / 加技术类别时，忘补文案就是一句英文里的中文。
     ⚠️ 三张档位表都要在这里 —— 漏一张，那张表新增档位时不会有人发现。 */
  const i18nStepTables = CFG.FONT_STEPS.concat(CFG.WIDTH_STEPS, CFG.RATE_STEPS);
  const i18nMissStep = i18nStepTables
    .map((s) => 'step.' + s.id).filter((k) => !(k in ZH_T));
  check('文案：每个字号 / 宽度 / 语速档位都有 step.<id>（#39 / #10）',
    i18nMissStep.length === 0, i18nMissStep.join(', ') || i18nStepTables.length + ' 个档位');

  const i18nMissLang = LANGUTIL.LANGS.map((l) => 'lang.' + l.code).filter((k) => !(k in ZH_T));
  check('文案：每种语言都有 lang.<code>（#39）',
    i18nMissLang.length === 0, i18nMissLang.join(', ') || LANGUTIL.LANGS.map((l) => l.code).join(', '));

  const i18nMissTech = TECH.KINDS.concat(['other']).map((k) => 'tech.' + k).filter((k) => !(k in ZH_T));
  check('文案：每个技术内容类别都有 tech.<kind>（#39）',
    i18nMissTech.length === 0, i18nMissTech.join(', ') || TECH.KINDS.join(', '));

  /* 显示名不许再留在这两张表里 —— 留着就是一处「只在中文下正确」的硬编码 */
  check('文案：档位表里不再有显示名 name（#39）',
    CFG.FONT_STEPS.every((s) => !('name' in s)) && CFG.WIDTH_STEPS.every((s) => !('name' in s)),
    JSON.stringify(CFG.FONT_STEPS[0]));
  check('文案：lang.js 的语言表里不再有显示名（#39）',
    LANGUTIL.LANGS.every((l) => !('name' in l)),
    JSON.stringify(LANGUTIL.LANGS));

  /* applyI18n：四个选择器 + 撤 i18n-pending + 同步 <html lang>。
     这里用最小 DOM 桩 —— selftest 跑在 Node 里，没有 document。 */
  const i18nTextEl = { innerHTML: '', getAttribute: () => 'panel.copy' };
  const i18nAttrEls = {
    title: { rec: {}, getAttribute: () => 'panel.copy', setAttribute(a, v) { this.rec[a] = v; } },
    'aria-label': { rec: {}, getAttribute: () => 'panel.copy', setAttribute(a, v) { this.rec[a] = v; } },
    placeholder: { rec: {}, getAttribute: () => 'panel.copy', setAttribute(a, v) { this.rec[a] = v; } }
  };
  const i18nSeen = { lang: null, removed: [] };
  const i18nFakeDoc = {
    documentElement: {
      setAttribute(a, v) { i18nSeen.lang = v; },
      classList: { remove(c) { i18nSeen.removed.push(c); } }
    },
    querySelectorAll(sel) {
      if (sel === '[data-i18n]') return [i18nTextEl];
      const m = /^\[data-i18n-(title|aria-label|placeholder)\]$/.exec(sel);
      return m ? [i18nAttrEls[m[1]]] : [];
    }
  };

  STRINGS.setLang('en');
  STRINGS.applyI18n(i18nFakeDoc);
  const i18nEnCopy = STRINGS.t('panel.copy');
  check('文案：applyI18n 填内容 + 三个属性 + 撤 i18n-pending + 同步 html[lang]（#39）',
    i18nTextEl.innerHTML === i18nEnCopy
      && i18nAttrEls.title.rec.title === i18nEnCopy
      && i18nAttrEls['aria-label'].rec['aria-label'] === i18nEnCopy
      && i18nAttrEls.placeholder.rec.placeholder === i18nEnCopy
      && i18nSeen.lang === 'en'
      && i18nSeen.removed.indexOf(STRINGS.PENDING_CLASS) >= 0,
    JSON.stringify({ inner: i18nTextEl.innerHTML, lang: i18nSeen.lang, removed: i18nSeen.removed }));

  /* 后台的错误文案必须**在发送的那一刻**取 —— 若哪天有人把 T.t(...) 的结果
     提到模块顶层（快照），切完语言后台还会说旧语言，这条会立刻红。 */
  await drain();
  store = {};
  override = { engine: 'deepseek', preferredLang: 'zh', targetLang: 'en', deepseekKey: '' };
  STRINGS.setLang('en');
  const i18nEnErr = await call(ZH);
  STRINGS.setLang('zh');
  const i18nZhErr = await call(ZH);
  check('文案：后台错误文案跟着界面语言走（#39）',
    i18nEnErr.ok === false && i18nZhErr.ok === false
      && i18nEnErr.error === EN_T['err.noKey'] && i18nZhErr.error === ZH_T['err.noKey'],
    JSON.stringify({ en: i18nEnErr.error, zh: i18nZhErr.error }));

  /* 源码层：中文的字符串字面量（例外必须带 i18n-allow 与理由） */
  const I18N_SCAN_FILES = ['background.js', 'content.js', 'config.js', 'lang.js', 'speak.js', 'tech.js',
    'sites.js', 'theme.js', 'popup.js', 'options.js'];
  const i18nDirtyJs = [];
  I18N_SCAN_FILES.forEach((f) => {
    I18N.scan(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .forEach((h) => i18nDirtyJs.push(f + ':' + h.line + ' ' + h.text));
  });
  check('文案：JS 源码里不再有中文的字符串字面量（#39）',
    i18nDirtyJs.length === 0, i18nDirtyJs.join(' | '));

  const i18nDirtyHtml = [];
  ['options.html', 'popup.html'].forEach((f) => {
    I18N.scanHtml(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .forEach((h) => i18nDirtyHtml.push(f + ':' + h.line + ' ' + h.text));
  });
  check('文案：两个页面里不再有中文硬编码（连属性一起查）（#39）',
    i18nDirtyHtml.length === 0, i18nDirtyHtml.join(' | '));

  /* ---------- 界面语言：跟随浏览器 / 手动切（#35 第 2、3 步）----------

     这里守的是「偏好 → 实际语言」这一步的解析规则。它是**唯一**一处
     把存储里的值翻译成行为的地方，写错了表现是「切了没反应」或「切完变回中文」，
     而且不会报错。 */
  check('DEFAULTS.uiLang 默认是 auto（跟随浏览器）（#35）',
    CFG.DEFAULTS.uiLang === 'auto', String(CFG.DEFAULTS.uiLang));

  check('界面语言：明确指定的两种直接生效（#35）',
    STRINGS.resolveLang('zh') === 'zh' && STRINGS.resolveLang('en') === 'en',
    STRINGS.resolveLang('zh') + ' / ' + STRINGS.resolveLang('en'));

  const savedTag = uiLangTag;
  uiLangTag = 'zh-CN';
  const autoZh = STRINGS.resolveLang('auto');
  uiLangTag = 'en-US';
  const autoEn = STRINGS.resolveLang('auto');
  uiLangTag = 'zh-Hant-TW';
  const autoZhTw = STRINGS.resolveLang('auto');
  /* 既不是中文也不是英文 → 给**英文**（国际默认），不是 DEFAULT_LANG。
     给一个法文用户看中文界面，比给他看英文更糟。 */
  uiLangTag = 'fr-FR';
  const autoFr = STRINGS.resolveLang('auto');
  uiLangTag = savedTag;

  check('界面语言：auto 跟随浏览器（zh-CN→zh，en-US→en，zh-Hant-TW→zh）（#35）',
    autoZh === 'zh' && autoEn === 'en' && autoZhTw === 'zh',
    [autoZh, autoEn, autoZhTw].join(' / '));
  check('界面语言：浏览器是第三种语言时给英文，而不是默认语言（#35）',
    autoFr === 'en', 'fr-FR → ' + autoFr);

  check('界面语言：认不出的偏好退回默认语言（不猜）（#35）',
    STRINGS.resolveLang('xx') === STRINGS.DEFAULT_LANG
      && STRINGS.resolveLang('') === STRINGS.DEFAULT_LANG
      && STRINGS.resolveLang(undefined) === STRINGS.DEFAULT_LANG,
    [STRINGS.resolveLang('xx'), STRINGS.resolveLang('')].join(' / '));

  uiLangTag = 'en-US';
  const setAuto = STRINGS.setLang('auto');
  const gotAuto = STRINGS.getLang();
  uiLangTag = savedTag;
  STRINGS.setLang('zh');
  check('界面语言：setLang("auto") 存的是偏好、用的是解析结果（#35）',
    setAuto === 'en' && gotAuto === 'en' && STRINGS.getLang() === 'zh',
    setAuto + ' / ' + gotAuto);

  /* 「跟随浏览器」这条路要有东西可跟。chrome.i18n 缺席时（Node、普通网页）
     必须安静退回 navigator / 默认值，不能抛 —— 抛了整页会白。 */
  const realChrome = global.chrome;
  let noI18nThrew = false;
  try {
    global.chrome = { runtime: realChrome.runtime, storage: realChrome.storage };
    STRINGS.browserLang();
    STRINGS.resolveLang('auto');
  } catch (e) {
    noI18nThrew = true;
  }
  global.chrome = realChrome;
  check('界面语言：没有 chrome.i18n 时不抛错（#35）', noI18nThrew === false);

  /* 设置页那个下拉的三档，每一档都要有对应的文案键 */
  check('界面语言：下拉三档（跟随浏览器 / 中文 / English）的文案都在（#35）',
    ['opt.uiLangAuto', 'lang.zh', 'lang.en', 'opt.secLang', 'opt.uiLangNote']
      .every((k) => (k in ZH_T) && (k in EN_T)),
    ['opt.uiLangAuto', 'lang.zh', 'lang.en'].map((k) => ZH_T[k]).join(' / '));

  /* 弹层语言按钮的**提示文字**可以翻译；但按钮上那两个字（EN / CN）
     是常量，刻意不翻译 —— 见 popup.js 的注释。这里只钉住提示文字的键存在。 */
  check('界面语言：弹层语言按钮的提示文案在（#35）',
    typeof ZH_T['pop.langTo'] === 'string' && typeof EN_T['pop.langTo'] === 'string',
    ZH_T['pop.langTo']);

  console.log('\n==> ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
