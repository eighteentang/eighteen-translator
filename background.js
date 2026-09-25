'use strict';

/* 划词翻译 —— 后台服务（Service Worker）
   职责：接收 content script 的翻译请求，按配置调用对应引擎，返回译文。
   放在后台统一发请求的原因：content script 受页面 CSP 限制，跨域请求容易失败。 */

/* DEFAULTS 的单一真源在 config.js，语言判定在 lang.js —— 这里不再自带拷贝。
   MV3 的 service worker 是 classic script，importScripts 为同步加载；
   Node 环境（dev/selftest.js）由测试脚本先行 require 这两个文件。 */
if (typeof importScripts === 'function') importScripts('config.js', 'strings.js', 'lang.js');

/* 这两条守卫要在**任何文案表可用之前**就能抛错 —— 它们报的正是「某个模块没加载」，
   所以不能依赖 t()。文案表自己缺失时退回一句英文，至少控制台里看得懂。 */
function devMissing(name) {
  const S = globalThis.WT_STRINGS;
  return new Error(S ? S.t('dev.moduleMissing', { name }) : (name + ' was not loaded'));
}

if (!globalThis.WT_CONFIG) throw devMissing('config.js');
if (!globalThis.WT_STRINGS) throw devMissing('strings.js');
if (!globalThis.WT_LANG) throw devMissing('lang.js');

const DEFAULTS = globalThis.WT_CONFIG.DEFAULTS;
const LANGUTIL = globalThis.WT_LANG;

/* 用户可见文案的单一真源（#39）。
   ⚠️ 所有文案都在**发送的那一刻**才求值，绝不在模块顶层做快照 ——
   快照下来的话，将来 #35 切换界面语言时，后台这边的错误文案会停在旧语言。 */
const T = globalThis.WT_STRINGS;

/* 各家引擎的语言代码不一致，在这里做映射。
   ⚠️ 加语言时**这张表和 lang.js 的 LANGS 要一起改**（#9）——
   Google 认的是它的 BCP-47 变体（繁体中文是 zh-TW，不是 zh-Hant），
   漏一行不会报错，只是那门语言被静默换成 zh-CN。

   兜底：认不出的 code 用 zh-CN（与 DEFAULTS.targetLang 一致）。 */
const LANG = {
  google: {
    zh: 'zh-CN',
    'zh-Hant': 'zh-TW',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    fr: 'fr',
    de: 'de',
    es: 'es',
    ru: 'ru',
    ar: 'ar',
    th: 'th'
  }
};

/* 写进提示词里的语言名。用**该语言自己的写法**（简体中文 / English / 日本語 / Русский）——
   提示词给的是模型看，不是用户看，用母语写法比用中文名更稳。
   加语言时在这里补一行（#9）。 */
const PROMPT_NAME = {
  zh: '简体中文',        // i18n-allow: 提示词给模型看，不随界面语言变
  'zh-Hant': '繁體中文', // i18n-allow: 同上
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
  ar: 'العربية',
  th: 'ไทย'
};

const TIMEOUT_MS = {
  google: 10000,
  deepseek: 25000
};

function getConfig() {
  return chrome.storage.local.get(DEFAULTS).then((v) => Object.assign({}, DEFAULTS, v));
}

/* 给错误打一个机器可读的标签，让浮层能决定「要不要给一个能点的动作」（#58）。
   文案是给人看的、会随措辞改；code 是给代码看的 —— 靠正则去猜文案必然会失效。 */
function coded(err, code) {
  err.wtCode = code;
  return err;
}

/* 同一时间只允许一个翻译请求在飞。

   为什么需要它：content.js 用 seq 把过期响应丢掉，但**丢掉的是结果，不是请求** ——
   请求早就发出去、DeepSeek 那边已经在生成。
   快速连划时前几次的请求不会再被使用，而且浮层里只会显示最后一次的结果。

   有了它之后：
   - 新请求一来，旧请求立刻 abort（不再继续生成输出）
   - 浮层被关掉时（点了别处 / 按 Esc），在飞的请求也停掉
     —— 用户已经不要结果了，让它跑完就是纯浪费 */
let inflight = null;

function cancelInflight() {
  if (!inflight) return;
  inflight.wtCancelled = true;   // 与「超时」区分开，错误文案才不会误导
  try {
    inflight.abort();
  } catch (e) {
    /* 已经结束的 controller 再 abort 是安全的，这里只是防御 */
  }
  inflight = null;
}

function fetchWithTimeout(url, options, ms, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);

  /* 把两个取消来源合成一个：内部的「超时」和外部的「用户又划了一次 / 关掉了浮层」。
     没有用 AbortSignal.any()，因为它要 Chrome 116+，而 manifest 没有声明最低版本 ——
     手动链接几行就够，不必为此抬高门槛。 */
  let onAbort = null;
  if (signal) {
    if (signal.aborted) {
      ctrl.abort();
    } else {
      onAbort = () => ctrl.abort();
      signal.addEventListener('abort', onAbort);
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  };

  return fetch(url, Object.assign({}, options, { signal: ctrl.signal }))
    .finally(cleanup);
}

/* ---------- 用量计数与每日额度（#18 / #19） ----------

   两条共用一个计数器：`usage.byDay`（按本地日期分桶）。
   ⚠️ **不另起一个 quota.used** —— 两个计数器必然漂移，而「用量」显示的数字
   与「到顶拦截」用的数字必须是同一个，否则用户会看到「已用 499」却被拦住。

   #18 只统计不拦截；#19 才拦截。 */

const USAGE_KEEP_DAYS = 30;

/* 日期键由 config.js 提供 —— 它与设置页的读取方共用同一份实现，
   免得两边格式不一致时静默显示成「今日 0 次」。 */
const todayKey = globalThis.WT_CONFIG.todayKey;

/* 只留最近 N 天。键是 YYYY-MM-DD，字典序 = 时间序，不用真解析日期。 */
function pruneUsage(byDay, keep) {
  const keys = Object.keys(byDay).sort();
  const drop = keys.length - keep;
  for (let i = 0; i < drop; i++) delete byDay[keys[i]];
  return byDay;
}

async function readUsage() {
  const v = await chrome.storage.local.get({ usage: null });
  const u = v && v.usage;
  const byDay = (u && u.byDay && typeof u.byDay === 'object') ? u.byDay : {};
  return { byDay };
}

/* 计数写盘串行化 —— 读-改-写不是原子的，两个请求叠在一起会丢一次计数。 */
let usageChain = Promise.resolve();

function recordUsage() {
  usageChain = usageChain.then(async () => {
    const u = await readUsage();
    const k = todayKey();
    u.byDay[k] = (u.byDay[k] || 0) + 1;
    pruneUsage(u.byDay, USAGE_KEEP_DAYS);
    await chrome.storage.local.set({ usage: { byDay: u.byDay } });
  }).catch(() => { /* 计数失败不该影响翻译本身 */ });
  return usageChain;
}

/* ⚠️ 一处**故意偏离 #18 初稿**的地方，记在这里：

   初稿写的是「在请求结束后累加，否则被取消的请求也会算进去」。
   取消发生在请求发出之后，砍掉的是后续输出；
   因此被取消的请求仍应计入本地请求次数，避免统计遗漏快速重复操作。

   所以计数点在**请求发出时**（真正走到引擎那一步），不是成功后。 */
const QUOTA_MSG_KEY = 'err.quota';

/* ---------- 结果缓存（#17） ----------

   键 = hash(引擎 + 目标语言 + 原文)。
   ⚠️ **引擎与目标语言必须进键** —— 否则改完翻译方向会拿到上一次的旧译文，
   而且会以「改了设置不生效」的形式暴露，最难查。 */

const CACHE_MAX = 200;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

/* 单条**译文**超过这个长度就不缓存。

   ⚠️ 量的是**存进去的那段文本**（译文），不是原文 —— 占存储的是值，不是键
   （键是定长散列）。原文长度不必管：content.js 那边已经卡在 1000 字符，
   根本进不来更长的；而且就算进来了，缓存长原文反而更省 —— 省的是输入 token。 */
const CACHE_MAX_OUT = 2000;

/* 两个 32 位散列拼起来（FNV-1a + djb2）—— 64 位，200 条的规模下碰撞概率可以忽略，
   而且不引依赖、不用 BigInt。 */
function hashStr(s) {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = (h1 * 0x01000193) >>> 0;
    h2 = ((h2 * 33) ^ c) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36);
}

function cacheKey(engine, target, text) {
  return hashStr(String(engine) + '|' + String(target) + '|' + text);
}

async function readCache() {
  const v = await chrome.storage.local.get({ cache: null });
  const c = v && v.cache;
  return (c && typeof c === 'object') ? c : {};
}

let cacheChain = Promise.resolve();

async function cacheGet(k) {
  const c = await readCache();
  const hit = c[k];
  if (!hit || typeof hit.t !== 'string') return '';
  if (Date.now() - (hit.at || 0) > CACHE_TTL) return '';

  // 命中即刷新时间戳 —— 这样淘汰才是「最久未用」，而不是「最早写入」
  hit.at = Date.now();
  cacheChain = cacheChain.then(() => chrome.storage.local.set({ cache: c })).catch(() => {});
  return hit.t;
}

function cachePut(k, text) {
  if (!text || text.length > CACHE_MAX_OUT) return;
  cacheChain = cacheChain.then(async () => {
    const c = await readCache();
    c[k] = { t: text, at: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
      keys.slice(0, keys.length - CACHE_MAX).forEach((x) => { delete c[x]; });
    }
    await chrome.storage.local.set({ cache: c });
  }).catch(() => { /* 缓存写失败不影响这次翻译 */ });
  return cacheChain;
}

/* ---------- 引擎 1：Google 免费接口（无需配置） ---------- */

async function translateGoogle(text, target, signal) {
  const tl = LANG.google[target] || 'zh-CN';
  const url = 'https://translate.googleapis.com/translate_a/single'
    + '?client=gtx&dt=t&sl=auto&tl=' + encodeURIComponent(tl)
    + '&q=' + encodeURIComponent(text);

  const res = await fetchWithTimeout(url, {}, TIMEOUT_MS.google, signal);
  if (res.status === 429) {
    throw new Error(T.t('err.google429'));
  }
  if (!res.ok) {
    throw new Error(T.t('err.googleHttp', { status: res.status }));
  }

  const data = await res.json();
  const segs = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  const out = segs.map((seg) => (Array.isArray(seg) ? seg[0] : '') || '').join('');
  if (!out) throw new Error(T.t('err.googleEmpty'));
  return out;
}

/* ---------- 引擎 2：DeepSeek ---------- */

async function translateDeepseek(text, target, cfg, signal) {
  if (!cfg.deepseekKey) {
    throw coded(new Error(T.t('err.noKey')), 'no-key');
  }

  const langName = PROMPT_NAME[target] || target;
  const body = {
    model: 'deepseek-flash',
    messages: [
      {
        role: 'system',
        /* ⚠️ 这一段**故意不进 strings.js**：它是给模型看的提示词，不是界面文案。
           界面语言变了，提示词也不该跟着变 —— 那是两个不同的东西。
           i18n-allow: 提示词不是界面文案 */
        content: '你是一个翻译引擎。把用户给出的文本翻译成' + langName
          + '。只输出译文本身：不要解释、不要加引号、不要重复原文、不要添加任何前后缀。'
      },
      { role: 'user', content: text }
    ],
    stream: false,
    // 思考模式默认开启且强度为 high，对翻译任务纯属拖慢速度，这里显式关闭
    thinking: { type: 'disabled' }
  };

  const res = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.deepseekKey
    },
    body: JSON.stringify(body)
  }, TIMEOUT_MS.deepseek, signal);

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(T.t('err.dsParse', { status: res.status }));
  }

  if (!res.ok) {
    const m = data && data.error && data.error.message ? data.error.message : ('HTTP ' + res.status);
    throw new Error(T.t('err.dsError', { msg: m }));
  }

  const msg = data && data.choices && data.choices[0] ? data.choices[0].message : null;
  const out = msg && msg.content ? String(msg.content).trim() : '';
  if (!out) throw new Error(T.t('err.dsEmpty'));
  return out;
}

/* ---------- 引擎 3：平台免费额度（预留接缝，尚未开放） ---------- */

/* 用户不配置任何凭据、由本扩展的服务端代付额度。

   将来接入托管后端时，只需实现这个函数（请求自己的 Worker），
   其余文件 —— 设置页、配置存储、调度逻辑 —— 都不用动。

   实现时要注意的三条（先记在这里，免得以后忘）：
   1. 服务端地址写在这里，绝不要把任何 API Key 打进扩展包；
   2. 服务端要能识别设备、按日限额，并设「每日总预算熔断」兜底 ——
      单靠每人每日上限挡不住批量刷，熔断才是唯一能兜住损失的机制；
   3. 网络失败时不要锁死用户，退回提示「改用自己的 API Key」，而不是卡住不动。 */
async function translateViaPlatform(text, target, cfg, signal) {
  throw new Error(T.t('err.platform'));
}

/* ---------- 调度与错误翻译 ---------- */

/* 定出这次译成什么语言。

   forceTarget 是浮层「译成 X」按钮传来的 —— 用户明确指定方向时不再做判定。
   这是误判的唯一出口，所以它必须覆盖一切，包括检测结果。 */
function pickTarget(text, cfg, forceTarget) {
  if (forceTarget) return { target: forceTarget, reversed: false, detected: null };

  const detected = LANGUTIL.detect(text);
  const r = LANGUTIL.resolve(detected, cfg.preferredLang, cfg.targetLang);
  return { target: r.target, reversed: r.reversed, detected };
}

/* 真正去调引擎。

   方向由调用方先算好再传进来（而不是在这里算）—— 因为**缓存键需要目标语言**，
   而缓存检查必须发生在发请求之前。 */
function translateNow(text, cfg, dir, signal) {
  // 额度来源优先于引擎选择：走平台额度时不看用户配置的引擎与凭据
  if (cfg.quotaMode === 'free') return translateViaPlatform(text, dir.target, cfg, signal);
  if (cfg.engine === 'google') return translateGoogle(text, dir.target, signal);
  return translateDeepseek(text, dir.target, cfg, signal);
}

/* cancelled 参数用来区分两种 AbortError：
   - 超时（内部定时器触发）→ 告诉用户是网络问题
   - 用户自己又划了一次 / 关掉了浮层（外部取消）→ 这不是错误，文案不能吓人
   注：被取消的响应 content.js 会按 seq 丢掉，正常不会显示出来；
   这里区分开是为了让测试能断言，也免得将来别处复用时报出误导性文案。 */
function friendlyError(err, cancelled) {
  if (cancelled) return T.t('err.cancelled');
  if (!err) return T.t('err.unknown');
  const name = err.name || '';
  const msg = err.message || String(err);
  if (name === 'AbortError' || /aborted/i.test(msg)) return T.t('err.timeout');
  if (/Failed to fetch|NetworkError|net::/i.test(msg)) {
    return T.t('err.network');
  }
  return msg;
}

/* 当前标签页的域名（#29）。
   ⚠️ `chrome.tabs.query` 本身不需要 `tabs` 权限 —— 那条权限只挡 url / title /
   favIconUrl 这些敏感字段。这里只用 tab.id 去问内容脚本，所以权限一个都不用加。 */
function currentHostname() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id === undefined || tab.id === null) { resolve(''); return; }
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'whoami' }, (res) => {
            // ⚠️ lastError 必须在回调里读掉，否则控制台会冒出「Unchecked runtime.lastError」
            const bad = chrome.runtime.lastError;
            resolve((!bad && res && res.hostname) ? String(res.hostname) : '');
          });
        } catch (e) {
          resolve('');
        }
      });
    } catch (e) {
      resolve('');
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  /* 浮层被关掉（点了别处 / 按 Esc）→ 把还在飞的请求也停掉。
     用户已经不要结果了，让它跑完只是白付一次钱。 */
  if (msg.type === 'cancel') {
    cancelInflight();
    sendResponse({ ok: true });
    return;
  }

  /* 浮层里的「去设置」按钮（#58）—— content script 不能直接调 openOptionsPage
     （那是扩展页面 API），只能让后台转发。 */
  if (msg.type === 'openOptions') {
    try {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  /* popup 的「在此域名不可用」要知道**当前标签页是哪个域名**（#29）。

     ⚠️ 这一步只能由后台代劳：
     ① popup 自己读 `tab.url` 需要 `tabs` 权限 —— 安装时会多一条
        「读取你的浏览记录」，为这一个勾选框不值当；
     ② 而且内容脚本在**排除站点上**也会回答这个问题（见 content.js 里那段），
        否则用户在排除站点上打开 popup 会看到未勾选，也就没法把它取消掉。

     拿不到就返回空串（浏览器内置页面、扩展页面、还没注入脚本的页面）——
     由 popup 决定怎么显示，这里不猜。 */
  if (msg.type === 'hostname') {
    currentHostname().then((h) => sendResponse({ ok: !!h, hostname: h }));
    return true;   // 异步
  }

  if (msg.type !== 'translate') return;

  const text = String(msg.text || '');
  if (!text) {
    sendResponse({ ok: false, error: T.t('err.emptyText') });
    return;
  }

  // 同一时间只允许一个：新的一来就把旧的砍掉
  cancelInflight();
  const ctrl = new AbortController();
  inflight = ctrl;

  // 只有「当前在飞的那个」才负责清空，避免旧请求结束时把新请求的记录抹掉
  const done = () => { if (inflight === ctrl) inflight = null; };

  // 强制方向只在它是合法语言代码时才认，别把任意字符串透进引擎
  const force = LANGUTIL.LANGS.some((l) => l.code === msg.forceTarget) ? msg.forceTarget : '';

  /* 顺序是刻意的：**先缓存、再额度、最后发请求**。

     - 缓存命中既不发请求、也不计次数（避免反复划同一个词时莫名撞上限）
     - 额度到顶就不发请求，并且给一个明确的 code 让浮层能放「去设置」 */
  getConfig()
    .then(async (cfg) => {
      const dir = pickTarget(text, cfg, force);

      const ck = cacheKey(cfg.engine, dir.target, text);
      const hit = await cacheGet(ck);
      if (hit) {
        done();
        sendResponse({
          ok: true, text: hit, engine: cfg.engine,
          target: dir.target, reversed: dir.reversed, cached: true
        });
        return;
      }

      const u = await readUsage();
      if (cfg.quotaDaily > 0 && (u.byDay[todayKey()] || 0) >= cfg.quotaDaily) {
        done();
        sendResponse({ ok: false, code: 'quota', error: T.t(QUOTA_MSG_KEY) });
        return;
      }

      recordUsage();   // 发出即计数，理由见上面的注释

      try {
        const out = await translateNow(text, cfg, dir, ctrl.signal);
        cachePut(ck, out);
        done();
        sendResponse({
          ok: true, text: out, engine: cfg.engine,
          target: dir.target, reversed: dir.reversed
        });
      } catch (err) {
        done();
        sendResponse({
          ok: false,
          error: friendlyError(err, ctrl.wtCancelled),
          code: (err && err.wtCode) || ''
        });
      }
    })
    .catch((err) => {
      done();
      sendResponse({ ok: false, error: friendlyError(err, false), code: '' });
    });

  return true; // 保持消息通道打开，等待异步 sendResponse
});

chrome.runtime.onInstalled.addListener((details) => {
  /* 首次安装直接把设置页打开（#58）。

     装完不知道要干什么是新用户流失最快的一步：他选中文字只会得到一句
     「尚未填写 DeepSeek API Key」，而没有任何可以点的路。

     ⚠️ 安装瞬间调用 openOptionsPage **可能被浏览器拦截**（用户还没有任何交互），
     所以这一条**不是唯一的路** —— 浮层里那条「未配置」错误旁还有一个「去设置」按钮。
     升级用户不受打扰（只在 reason === 'install' 时打开）。 */
  if (details && details.reason === 'install') {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {
      /* 被拦就算了，浮层里有兜底 */
    }
  }

  /* 读原始键（而不是 getConfig() 合并后的结果），才能分辨这是不是一份老配置。

     老配置里只有一个 targetLang，它的意思是**输出语言**（当时的默认 'zh' = 什么都译成中文）。
     新语义下它仍然该是「目标语言」，而「首选语言」取另一种 ——
     也就是「把反向也打开」，而不是改变他原来要的方向。

     ⚠️ 别反过来写（把老 targetLang 当 preferredLang）：那样一份 targetLang='en' 的老配置
     会从「译成英文」变成「译成中文」，等于把他的设置偷偷改掉。
     这条在默认值从「中→英」改成「英→中」之后更容易写错，见 config.js 的注释。 */
  chrome.storage.local.get(null).then((raw) => {
    const cfg = Object.assign({}, DEFAULTS, raw);

    if (!('preferredLang' in raw) && 'targetLang' in raw) {
      cfg.targetLang = raw.targetLang;
      cfg.preferredLang = raw.targetLang === 'zh' ? 'en' : 'zh';
    }

    // 两个字段相等 = 不翻译，兜一下
    if (cfg.preferredLang === cfg.targetLang) {
      cfg.targetLang = cfg.preferredLang === 'zh' ? 'en' : 'zh';
    }

    chrome.storage.local.set(cfg);
  });
});

/* 注：点击工具栏图标现在会弹出 popup.html（manifest 里配了 default_popup）。
   一旦配置了 popup，chrome.action.onClicked 就不再触发，所以这里不再监听它。
   需要完整设置页时，从 popup 里点「完整设置」，或用扩展详情页的「扩展程序选项」。 */
