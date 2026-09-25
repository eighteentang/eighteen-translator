'use strict';

/* 划词翻译 —— 设置页逻辑 */

// DEFAULTS 的单一真源在 config.js，语言表在 lang.js，主题在 theme.js
// （options.html 里已按顺序先加载它们）
const DEFAULTS = globalThis.WT_CONFIG.DEFAULTS;
const LANGUTIL = globalThis.WT_LANG;
const THEME = globalThis.WT_THEME;
// 界面文案（#39）—— 所有给用户看的字都在 strings.js 里
const T = globalThis.WT_STRINGS;
const t = (key, vars) => T.t(key, vars);
// 排除站点的解析与匹配（#29）—— 与 content.js 加载时判断用的是同一套规则
const SITES = globalThis.WT_SITES;

/* 测试用的样本文本 —— 写成「首选语言」的样子。
   这样它一定会被判成首选语言、进而译成目标语言，正好覆盖正常路径。

   ⚠️ 每加一门语言（lang.js 的 LANGS）都要在这里补一句（#9）——
   漏了不会报错：`SAMPLE[cfg.preferredLang] || SAMPLE.zh` 会静默退回中文样本，
   表现是「我首选法文，点测试翻译，却在拿中文试」。

   样本句都写得**够长且带虚词**：detect() 对短句（< 8 字符）不做判定，
   对没有虚词的拉丁短句会退回 en —— 样本要能真的走通判定那条路。 */
const SAMPLE = {
  zh: '这是一段用于测试的中文文本，用来确认翻译引擎能否正常工作。',   // i18n-allow: 按语言码分键的测试数据
  'zh-Hant': '這是一段用於測試的繁體中文文本，用來確認翻譯引擎能否正常工作。',   // i18n-allow: 同上
  en: 'The quick brown fox jumps over the lazy dog.',
  ja: 'これは翻訳エンジンが正常に動作するか確認するためのテスト用の文章です。',   // i18n-allow: 同上
  ko: '이것은 번역 엔진이 정상적으로 작동하는지 확인하기 위한 테스트 문장입니다.',
  fr: 'Ceci est un texte de test en français pour vérifier que le moteur de traduction fonctionne.',
  de: 'Dies ist ein Testtext auf Deutsch, um zu prüfen, ob die Übersetzungsmaschine funktioniert.',
  es: 'Este es un texto de prueba en español para comprobar que el motor de traducción funciona.',
  ru: 'Это тестовый текст на русском языке для проверки работы переводчика.',
  ar: 'هذا نص تجريبي باللغة العربية للتأكد من أن محرك الترجمة يعمل بشكل صحيح.',
  th: 'นี่คือข้อความทดสอบภาษาไทยเพื่อยืนยันว่าเครื่องมือแปลทำงานได้อย่างถูกต้อง'
};

const $ = (id) => document.getElementById(id);

function currentEngine() {
  const checked = document.querySelector('input[name="engine"]:checked');
  return checked ? checked.value : 'google';
}

function currentQuotaMode() {
  const checked = document.querySelector('input[name="quotaMode"]:checked');
  return checked ? checked.value : 'own';
}

function currentTriggerMode() {
  const checked = document.querySelector('input[name="triggerMode"]:checked');
  return checked ? checked.value : 'auto';
}

/* 「平台免费额度」模式下不需要选引擎、也不需要填凭据 —— 由服务端代付。
   该模式目前置灰不可选，这段分支是为将来开放预留的：
   届时只需放开那个 radio，再把 background.js 的 translateViaPlatform 实现掉，
   这里不用改。 */
function syncEnginePanels() {
  const isFree = currentQuotaMode() === 'free';
  const engine = currentEngine();

  $('sec-engine').classList.toggle('is-hidden', isFree);
  $('cfg-deepseek').classList.toggle('on', !isFree && engine === 'deepseek');
}

/* 两个下拉的选项由 lang.js 的 LANGS 渲染 —— 加语言只改那一处，这里不用动。 */
function renderLangSelects() {
  ['preferredLang', 'targetLang'].forEach((id) => {
    const sel = $(id);
    sel.textContent = '';
    LANGUTIL.LANGS.forEach((l) => {
      const o = document.createElement('option');
      o.value = l.code;
      // 显示名在 strings.js 里（'lang.zh' / 'lang.en'）—— 语言码与显示名是两件事
      o.textContent = t('lang.' + l.code);
      sel.appendChild(o);
    });
  });
}

/* 界面语言下拉（#35 第 3 步）。三档：跟随浏览器 / 中文 / English。

   ⚠️ 选项来自 `T.UI_LANGS`（**有文案表的**语言），不是 `LANGUTIL.LANGS`
   （**能翻译的**语言）。两者在 #9 之后就不一样了：能翻译的有 11 种，
   但界面文案只有 zh / en 两张表。混用的话，加一门翻译语言就会往这个下拉里
   塞进一堆没文案的语言 —— 选了它界面会静默回退成中文。

   ⚠️ 后两档的显示名走 t('lang.<code>')，而「跟随浏览器」是一条**文案** ——
   一个是语言自己的名字，一个是界面的说法，两件事别混。 */
function renderUiLangSelect() {
  const sel = $('uiLang');
  sel.textContent = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  add('auto', t('opt.uiLangAuto'));
  T.UI_LANGS.forEach((code) => add(code, t('lang.' + code)));
}

/* 三个「选项由代码渲染」的下拉（界面语言 / 翻译方向 / 浮层档位）。

   ⚠️ 它们的选项文案都走 t()，所以**每次界面语言变了都必须重画一遍** ——
   否则会停在「页面是英文、下拉里还是中文」这种半截状态。
   ⚠️ 重画会清掉当前选中值，所以调用方要在**重画之后**再设一次 value。 */
function renderSelects() {
  renderUiLangSelect();
  renderLangSelects();
  renderStepSelects();
  renderAccentSelect();
}

/* 字号 / 宽度的下拉也按**同一张表**渲染（#25）——
   表在 config.js，content.js 的 CSS 变量用的是同一个 stepPx()。
   像素值写进选项文案（「中（14px）」），是因为「大一点」没有参照物；
   但它是从表里读出来的，不是抄在 HTML 里的，改档位不会对不上。

   朗读语速（#10）用同一张表的另一列：它没有像素值，所以**不能**复用
   opt.stepOption 那句「（14px）」的模板，只写档位名。 */
function renderStepSelects() {
  const map = {
    panelFont: globalThis.WT_CONFIG.FONT_STEPS,
    panelWidth: globalThis.WT_CONFIG.WIDTH_STEPS,
    speakRate: globalThis.WT_CONFIG.RATE_STEPS
  };
  Object.keys(map).forEach((id) => {
    const sel = $(id);
    sel.textContent = '';
    const withPx = id !== 'speakRate';
    map[id].forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id;
      // 档位名（小 / 中 / 大 / 慢 / 正常 / 快）在 strings.js 里
      o.textContent = withPx
        ? t('opt.stepOption', { name: t('step.' + s.id), px: s.px })
        : t('step.' + s.id);
      sel.appendChild(o);
    });
  });
}

/* 英语口音（#10）。三档：跟随系统 / 美式 / 英式。

   ⚠️ 这一项**只对英语有意义**：`speechSynthesis` 里 en-US 与 en-GB 是两套
   独立的声音，别的语言没有这个区分。设置页里写明了，免得用户以为坏了。
   ⚠️ 选项文案里那两个「美式 / 英式」是界面语言的一部分（走 t()），
   而 `en-US` / `en-GB` 是**语音包的标识**（不能翻译）—— 两件事别混。 */
function renderAccentSelect() {
  const sel = $('speakAccent');
  if (!sel) return;
  sel.textContent = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  add('auto', t('opt.accentAuto'));
  add('en-US', t('opt.accentUS'));
  add('en-GB', t('opt.accentGB'));
}

/* 首选语言与目标语言不能相同 —— 那样等于不翻译，正是 #2 要修掉的那个 bug。
   返回 true 表示没问题。 */
function checkLangs() {
  const el = $('lang-warn');
  if ($('preferredLang').value === $('targetLang').value) {
    el.textContent = t('opt.langSame');
    return false;
  }
  el.textContent = '';
  return true;
}

/* ---------- 排除站点（#29）----------

   写错的行**不会静默丢弃**：明确报出是第几行、错在哪。
   这一点比「拦住不让保存」重要 —— 后者会让一个笔误把整页设置都锁住
   （连 API Key 都存不进去），代价远大于收益。

   校验用的是 sites.js，与 content.js 加载时判断用的是**同一个函数** ——
   两边各写一份的话，「设置页说合法、页面却不跳过」不会报错，只会表现为「加了没用」。 */
function checkSites() {
  const r = SITES.parse($('excludeSites').value);
  const desc = $('sitesDesc');
  const warn = $('sites-warn');

  desc.textContent = r.list.length
    ? t('opt.sitesCount', { n: r.list.length })
    : t('opt.sitesEmpty');

  warn.textContent = '';
  if (!r.bad.length) return r;

  /* ⚠️ 这一段里夹着**用户输入**（他写的那几行），所以：
     - 静态部分走 t()（textContent 就够，这一段没有标记）
     - 用户写的行只走 textContent，绝不拼进 innerHTML
     与 strings.js 里 applyI18n 那段讲的是同一条界限。 */
  warn.textContent = t('opt.sitesBad', { n: r.bad.length });
  const detail = document.createElement('span');
  detail.textContent = r.bad
    .map((b) => t('opt.sitesBadLine', { line: b.line, text: b.text }))
    .join(t('opt.listSep'));
  warn.appendChild(detail);
  warn.appendChild(document.createTextNode(t('opt.sitesBadHint')));
  return r;
}

/* 主题改完立即生效（也立即保存）。
   其他字段都是「改完点保存」，这里例外 —— 它是个纯显示设置，
   点了之后页面当场变色，如果还要再点一次保存才生效，反而像没生效。 */
function applyTheme() {
  THEME.apply($('theme').value, document.documentElement);
}

function fill(cfg) {
  /* 界面语言先定下来，再把静态文案填一遍 —— 后面 checkLangs / checkSites
     生成的文字都走 t()，顺序反了会有一瞬间是上一种语言。 */
  T.setLang(cfg.uiLang);
  T.applyI18n();
  document.title = t('opt.title');

  /* ⚠️ 必须排在 setLang 之后：三个下拉的选项文案也是 t() 出来的。
     初始化时先画过一遍（那时还是默认语言），这里按配置重画第二遍。 */
  renderSelects();

  $('enabled').checked = cfg.enabled !== false;
  $('skipTech').checked = cfg.skipTech !== false;
  /* 认不出的偏好（老配置 / 手改的存储）显示成「跟随浏览器」，
     也就是它实际会走的那条路 —— 不显示一个下拉里没有的空值。
     ⚠️ 合法值从 T.UI_LANGS 推，不写死 'zh' / 'en'（#9 之后语言表会变）。 */
  $('uiLang').value = ['auto'].concat(T.UI_LANGS).indexOf(cfg.uiLang) >= 0 ? cfg.uiLang : 'auto';
  $('preferredLang').value = cfg.preferredLang || 'zh';
  $('targetLang').value = cfg.targetLang || 'en';
  $('theme').value = cfg.theme || 'auto';
  $('panelFont').value = cfg.panelFont || 'md';
  $('panelWidth').value = cfg.panelWidth || 'md';
  $('speakRate').value = cfg.speakRate || 'normal';
  $('speakAccent').value = ['auto', 'en-US', 'en-GB'].indexOf(cfg.speakAccent) >= 0 ? cfg.speakAccent : 'auto';
  $('excludeSites').value = cfg.excludeSites || '';
  savedSites = $('excludeSites').value;   // 「这次有没有改过列表」的基准
  $('deepseekKey').value = cfg.deepseekKey || '';

  const radio = document.querySelector('input[name="engine"][value="' + (cfg.engine || 'google') + '"]');
  if (radio) radio.checked = true;

  const tRadio = document.querySelector('input[name="triggerMode"][value="' + (cfg.triggerMode || 'auto') + '"]');
  if (tRadio) tRadio.checked = true;

  // 置灰的选项不参与回填，免得把用户困在一个不可用的模式上
  const qRadio = document.querySelector('input[name="quotaMode"][value="' + (cfg.quotaMode || 'own') + '"]');
  if (qRadio && !qRadio.disabled) qRadio.checked = true;

  syncEnginePanels();
  checkLangs();
  checkSites();
  applyTheme();
}

function collect() {
  return {
    enabled: $('enabled').checked,
    quotaMode: currentQuotaMode(),
    engine: currentEngine(),
    triggerMode: currentTriggerMode(),
    preferredLang: $('preferredLang').value,
    targetLang: $('targetLang').value,
    theme: $('theme').value,
    /* 界面语言（#35）：存**偏好**（'auto' / 'zh' / 'en'），不存解析结果 ——
       存 'zh' 的话，用户换了浏览器语言就永远回不到「跟随」了。 */
    uiLang: $('uiLang').value,
    panelFont: $('panelFont').value,
    panelWidth: $('panelWidth').value,
    /* 朗读（#10）：语速存档位名（slow / normal / fast），口音存
       'auto' / 'en-US' / 'en-GB' —— 后者是**语音包的标识**，不是界面文案。 */
    speakRate: $('speakRate').value,
    speakAccent: $('speakAccent').value,
    /* ⚠️ 存**原文**，不做规范化，也不删掉写错的行。
       理由：用户可能在列表里写备注（# 开头）、也可能刚粘了一行还没改完 ——
       保存时把它抹掉，他就再也看不到自己写过什么了。
       规范化（去 scheme / 去路径）发生在**匹配时**（sites.js），
       所以原文留着不影响匹配，只是每次加载多解析一遍这几行。
       写错的行会一直留在输入框里、警告也一直显示，直到他改对。 */
    excludeSites: $('excludeSites').value,
    skipTech: $('skipTech').checked,
    deepseekKey: $('deepseekKey').value.trim()
  };
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/* 上一次保存时的排除列表原文（#29）。
   用它判断「这次保存有没有动过列表」—— 只有动过才提示「请刷新页面」，
   否则每次保存 Key 都弹一句无关的提醒，用户很快就学会无视它。 */
let savedSites = '';

// 允许在没有扩展 API 的环境里打开本页（此时只能看界面，不能保存或测试）
const hasExt = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime);

function save() {
  if (!hasExt) return Promise.reject(new Error(t('opt.noExtSave')));
  if (!checkLangs()) return Promise.reject(new Error(t('opt.langSameErr')));
  return chrome.storage.local.set(collect());
}

function translate(text) {
  return new Promise((resolve, reject) => {
    if (!hasExt) {
      reject(new Error(t('opt.noExtTest')));
      return;
    }
    chrome.runtime.sendMessage({ type: 'translate', text: text }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res || !res.ok) {
        reject(new Error((res && res.error) || t('opt.translateFail')));
        return;
      }
      resolve(res);
    });
  });
}

/* ---------- 用量 / 上限 / 缓存（#18 / #19 / #17） ----------

   三件事放在一节里，是因为它们读的是同一批存储键，而且数字必须自洽：
   「今日已翻译 N 次」与「到没到上限」用的必须是**同一个** N。

   ⚠️ 上限数值**不上屏**（2026-09-24 用户定的）——
   用户看得到数字，就会开始跟它谈判（「为什么是 500 不是 1000」）。
   看不到数字，他只知道「今天用掉几次」和「用满了能调高」，
   上限就从「一个要争的配额」退回成「一道防呆的闸」。
   所以下面只有「调高」按钮，没有输入框、也不回显新值。 */

const QUOTA_STEP = 500;

/* 键格式由 config.js 的 todayKey 定义（与 background.js 的写入方共用一份） */
const todayKey = globalThis.WT_CONFIG.todayKey;

function readUsage() {
  return chrome.storage.local.get({ usage: null }).then((v) => {
    const u = v && v.usage;
    const byDay = (u && u.byDay && typeof u.byDay === 'object') ? u.byDay : {};
    return { byDay };
  });
}

function renderUsage() {
  if (!hasExt) {
    $('usageToday').textContent = '—';
    $('cacheDesc').textContent = t('opt.cacheDesc');
    return Promise.resolve();
  }

  return Promise.all([
    readUsage(),
    chrome.storage.local.get({ cache: null, quotaDaily: DEFAULTS.quotaDaily })
  ]).then(([u, v]) => {
    const n = u.byDay[todayKey()] || 0;
    const cap = typeof v.quotaDaily === 'number' ? v.quotaDaily : DEFAULTS.quotaDaily;

    $('usageToday').textContent = String(n);

    // 到没到上限用**颜色和文案**表达，不用数字
    const full = cap > 0 && n >= cap;
    $('usageToday').classList.toggle('at-cap', full);
    $('quotaDesc').textContent = full ? t('opt.quotaFull') : t('opt.quotaDesc');

    const c = (v && v.cache && typeof v.cache === 'object') ? v.cache : {};
    const cnt = Object.keys(c).length;
    $('cacheDesc').textContent = cnt
      ? t('opt.cacheCount', { n: cnt })
      : t('opt.cacheDesc');
  }).catch(() => {
    /* 读不到就保持占位符 —— 这是显示层，不该因为它读失败而报错吓人 */
  });
}

$('raiseQuota').addEventListener('click', () => {
  if (!hasExt) {
    setStatus(t('opt.noExtSave'), 'err');
    return;
  }
  chrome.storage.local.get({ quotaDaily: DEFAULTS.quotaDaily }).then((v) => {
    const cap = typeof v.quotaDaily === 'number' ? v.quotaDaily : DEFAULTS.quotaDaily;
    // cap <= 0 表示「不限制」，已经是最松的了，没有可调高的空间
    if (cap <= 0) {
      setStatus(t('opt.quotaNoLimit'), 'err');
      return null;
    }
    return chrome.storage.local.set({ quotaDaily: cap + QUOTA_STEP }).then(() => {
      // ⚠️ 提示里**不写新上限的数值**（#19）—— 用户只需要知道「现在能继续了」
      setStatus(t('opt.quotaRaised'), 'ok');
      return renderUsage();
    });
  }).catch((e) => setStatus(t('opt.saveFail', { msg: e.message }), 'err'));
});

$('clearCache').addEventListener('click', () => {
  if (!hasExt) {
    setStatus(t('opt.noExtOp'), 'err');
    return;
  }
  chrome.storage.local.remove('cache').then(() => {
    setStatus(t('opt.cacheCleared'), 'ok');
    return renderUsage();
  }).catch((e) => setStatus(t('opt.clearFail', { msg: e.message }), 'err'));
});

/* ---------- 一键复制诊断信息（#59） ----------

   用户从 issue 页面提交的问题通常只有一句话（「翻译不出来」）——
   没有版本号、没有浏览器、没有引擎、没有报错原文，每一条都要来回问两轮。

   ⚠️ 只报「已填 / 未填」，**绝不含 API Key 本身**，也绝不含选中的文本。 */
function diagText(todayCount) {
  const cfg = collect();
  const ua = navigator.userAgent;
  const m = ua.match(/(Edg|EdgA|Chrome|Firefox)\/([\d.]+)/);
  const name = m ? ({ Edg: 'Edge', EdgA: 'Edge', Chrome: 'Chrome', Firefox: 'Firefox' }[m[1]]) : t('opt.diagUnknownBrowser');

  let ver = '?';
  try { ver = chrome.runtime.getManifest().version; } catch (e) { /* 非扩展环境 */ }

  const lines = [
    t('ext.name') + ' v' + ver,
    name + (m ? ' ' + m[2] : '') + ' / ' + (navigator.platform || t('opt.diagUnknownOs')),
    t('opt.diagEngine', {
      engine: cfg.engine,
      key: cfg.deepseekKey ? t('opt.diagSet') : t('opt.diagUnset')
    }),
    t('opt.diagDir', { from: cfg.preferredLang, to: cfg.targetLang }),
    t('opt.diagTheme', {
      theme: cfg.theme,
      mode: cfg.quotaMode,
      on: cfg.enabled ? t('opt.diagOn') : t('opt.diagOff')
    }),
    // 这两项是「为什么没反应」的两大来源：手动模式没点圆点、技术内容被跳过
    t('opt.diagTrigger', {
      trigger: cfg.triggerMode,
      skip: cfg.skipTech !== false ? t('opt.diagSkipOn') : t('opt.diagSkipOff')
    }),
    // 「字太小 / 浮层太宽」也是常见反馈，报问题时不带这个就得来回问一轮
    t('opt.diagPanel', { font: cfg.panelFont, width: cfg.panelWidth }),
    // 「这个站怎么不翻译」有一半是排除列表命中 —— 报问题时带上条数，省一轮来回
    t('opt.diagSites', { n: SITES.parse(cfg.excludeSites).list.length })
  ];

  // 「翻译不出来」有一半是撞上了每日上限 —— 报问题时不带这个数字，就得来回问一轮
  if (typeof todayCount === 'number') lines.push(t('opt.diagUsed', { n: todayCount }));

  lines.push('UA: ' + ua);
  return lines.join('\n');
}

/* 设置页是 chrome-extension://，属于安全上下文，clipboard 一定存在；
   仍然留一条 textarea 回退，免得这段将来被复用到普通页面上时静默失败。 */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  }
  return Promise.resolve().then(() => legacyCopy(text));
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(ta);
  if (!ok) throw new Error('copy failed');
}

$('diag').addEventListener('click', () => {
  const usage = hasExt
    ? readUsage().then((u) => u.byDay[todayKey()] || 0).catch(() => null)
    : Promise.resolve(null);

  usage
    .then((n) => copyText(diagText(n)))
    .then(() => setStatus(t('opt.diagCopied'), 'ok'))
    .catch((e) => setStatus(t('opt.copyFail', { msg: e.message }), 'err'));
});

/* ---------- 事件 ---------- */

document.querySelectorAll('input[name="engine"]').forEach((el) => {
  el.addEventListener('change', syncEnginePanels);
});

document.querySelectorAll('input[name="quotaMode"]').forEach((el) => {
  el.addEventListener('change', syncEnginePanels);
});

['preferredLang', 'targetLang'].forEach((id) => {
  $(id).addEventListener('change', checkLangs);
});

// 排除列表边写边校验（#29）—— 报错要出现在他刚写完那一行的时候，
// 而不是点了保存之后才发现有一行从来没生效过
$('excludeSites').addEventListener('input', checkSites);

/* 凭据的显示 / 隐藏（#4）。
   ⚠️ 这只是**显示层遮蔽**，不是加密 —— 加密了也没用：密钥只能一起放在扩展里，
   等于没加，反而给人虚假的安全感。真正有用的是下面那段说明文案。 */
$('toggleKey').addEventListener('click', () => {
  const el = $('deepseekKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? t('opt.hide') : t('opt.show');
  $('toggleKey').setAttribute('aria-label', t(show ? 'opt.hideAria' : 'opt.showAria'));
});

$('theme').addEventListener('change', () => {
  applyTheme();
  if (!hasExt) return;
  chrome.storage.local.set({ theme: $('theme').value })
    .then(() => setStatus(t('opt.themeSwitched'), 'ok'))
    .catch((e) => setStatus(t('opt.saveFail', { msg: e.message }), 'err'));
});

/* 界面语言（#35 第 3 步）。

   和主题一样是**纯显示设置**：改完立即生效、立即保存，不要求再点一次「保存」——
   它改的就是这一页本身，要是还要再点一次保存，用户会以为没生效。

   ⚠️ 光换 setLang + applyI18n 不够。这一页里还有三处**由 JS 渲染**的文字：
     ① 三个下拉的选项文案（renderSelects）
     ② checkLangs / checkSites / 用量那几行的动态说明
     ③ document.title
   少刷任何一处，用户就会看到半截语言 —— 而这在源码里完全看不出来。
   ⚠️ renderSelects() 会清掉下拉的选中值，所以重画之后要把值设回去。 */
$('uiLang').addEventListener('change', () => {
  const pref = $('uiLang').value;

  /* 先记下另外几个下拉当前选的是什么 —— renderSelects() 会清空并重建它们，
     不记的话用户的「翻译方向」「浮层档位」「朗读语速 / 口音」会被悄悄重置。
     ⚠️ 这里列的是**所有由 renderSelects() 重建的下拉**（除了 uiLang 自己）——
     漏一个不会报错，只会在切界面语言时把它悄悄改掉。 */
  const keep = {};
  ['preferredLang', 'targetLang', 'panelFont', 'panelWidth', 'speakRate', 'speakAccent']
    .forEach((id) => { keep[id] = $(id).value; });

  T.setLang(pref);
  T.applyI18n();
  document.title = t('opt.title');
  renderSelects();
  $('uiLang').value = pref;
  Object.keys(keep).forEach((id) => { $(id).value = keep[id]; });
  checkLangs();
  checkSites();
  renderUsage();

  if (!hasExt) return;
  chrome.storage.local.set({ uiLang: pref })
    .then(() => setStatus(t('opt.saved'), 'ok'))
    .catch((e) => setStatus(t('opt.saveFail', { msg: e.message }), 'err'));
});

/* 字号 / 宽度 / 朗读语速与主题一样是**纯显示设置**：改完立即保存、立即生效（#25 / #10）。
   这一页上看不到效果（浮层在网页里），所以更不该再要求一次「保存」点击 ——
   用户会以为没生效，然后回去重新选一遍。 */
['panelFont', 'panelWidth', 'speakRate', 'speakAccent'].forEach((id) => {
  $(id).addEventListener('change', () => {
    if (!hasExt) return;
    const patch = {};
    patch[id] = $(id).value;
    chrome.storage.local.set(patch)
      .then(() => setStatus(t('opt.saved'), 'ok'))
      .catch((e) => setStatus(t('opt.saveFail', { msg: e.message }), 'err'));
  });
});

// 系统主题变了要跟着重算（只有「跟随系统」会真的变，重算是幂等的）
THEME.onChange(applyTheme);

$('save').addEventListener('click', () => {
  /* 校验在保存前跑一次，取它的结果用来决定提示语。
     ⚠️ 有写错的行**不阻止保存** —— 那样一个笔误会把整页设置都锁住
     （连 API Key 都存不进去），代价远大于收益。写错的行照样存在原文里，
     警告一直显示到用户改对为止。 */
  const sites = checkSites();
  const before = savedSites;

  save()
    .then(() => {
      savedSites = $('excludeSites').value;
      /* 排除列表是唯一一个「存了但已打开的页面不会立刻生效」的设置项（#29）——
         判断只在页面加载时做一次。改了就得说清楚，否则用户会以为没生效。 */
      if (savedSites !== before) {
        setStatus(t(sites.list.length ? 'opt.savedRefreshOn' : 'opt.savedRefreshOff'), 'ok');
      } else {
        setStatus(t('opt.saved'), 'ok');
      }
    })
    .catch((e) => setStatus(t('opt.saveFail', { msg: e.message }), 'err'));
});

$('test').addEventListener('click', () => {
  const btn = $('test');
  btn.disabled = true;
  setStatus(t('opt.testing'));

  const cfg = collect();

  // 先保存，确保后台读到的是当前表单里的配置
  save()
    .then(() => translate(SAMPLE[cfg.preferredLang] || SAMPLE.zh))
    .then((res) => {
      setStatus(t('opt.testOk', { text: res.text }), 'ok');
      // 这次测试也计了一次用量，把「今日已翻译」刷新一下，
      // 否则用户会看到「刚测了一次，数字却没动」，进而怀疑统计没在工作
      renderUsage();
    })
    .catch((e) => {
      setStatus(t('opt.testFail', { msg: e.message }), 'err');
    })
    .finally(() => {
      btn.disabled = false;
    });
});

/* ---------- 初始化 ---------- */

/* 三个下拉先按**默认语言**画一遍 —— 它们不能等 storage 读回来才有内容，
   否则页面会先出现三个空下拉。读完配置后 fill() 会按实际语言重画第二遍。 */
renderSelects();

// 版本号显示在页脚：用户报问题时，这是唯一能确认「他装的是哪一版」的手段
if (hasExt) {
  try {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) { /* 拿不到版本号不影响使用 */ }
}

if (hasExt) {
  chrome.storage.local.get(DEFAULTS).then((v) => fill(Object.assign({}, DEFAULTS, v)));
} else {
  fill(DEFAULTS);
}

// 用量 / 上限 / 缓存是只读展示，与表单回填互不依赖，各走各的
renderUsage();
