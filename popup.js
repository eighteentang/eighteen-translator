'use strict';

/* 划词翻译 —— 工具栏弹层
   ────────────────────────────────────────────────────────────────
   只放高频操作：总开关、主题快捷切换、「在此域名不可用」、去设置页、反馈入口。

   「在此域名不可用」（#29）是唯一一个「按当前页面决定显示什么」的控件 ——
   所以它要问内容脚本当前是什么域名，见下面的 currentHostname()。

   刻意不放「翻译引擎」—— 那不是天天改的配置，放这里既占地方，
   又让弹层看起来像个设置面板。引擎、凭据、翻译方向、主题档位全在 options.html。

   popup 一旦关闭就被销毁，所以这里的每一次改动都立即写入 storage，
   不设「保存」按钮。写完之后 content script 会通过 storage.onChanged 自动感知。 */

const DEFAULTS = globalThis.WT_CONFIG.DEFAULTS;
const THEME = globalThis.WT_THEME;
// 界面文案（#39）—— 所有给用户看的字都在 strings.js 里，这里只取
const T = globalThis.WT_STRINGS;
const t = (key, vars) => T.t(key, vars);
// 排除站点的解析与匹配（#29）—— 与 content.js / 设置页用的是同一套规则
const SITES = globalThis.WT_SITES;
const $ = (id) => document.getElementById(id);

// 允许在没有扩展 API 的环境里打开本页（此时只能看界面）
const hasExt = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime);

// 当前的主题偏好：'auto' | 'light' | 'dark'
let themePref = DEFAULTS.theme || 'auto';

/* 当前标签页的域名 + 排除列表原文（#29）。
   ⚠️ 域名不是自己读的：popup 读 `tab.url` 需要 `tabs` 权限，
   安装时会多一条「读取你的浏览记录」，为一个勾选框不值当。
   改成让后台去问那个标签页里的内容脚本（见 background.js 的 currentHostname）。
   内容脚本即使处在被排除的站点上也会回答这一个问题 —— 否则勾选框永远
   显示未勾选，用户也就永远没法在这里把它取消掉。 */
let currentHost = '';
let sitesText = '';

/* 最近一次读到的配置 —— 切界面语言时要拿它重画那些由 JS 拼出来的文字 */
let lastCfg = null;

function currentHostname() {
  return new Promise((resolve) => {
    if (!hasExt || !chrome.runtime.sendMessage) { resolve(''); return; }
    try {
      chrome.runtime.sendMessage({ type: 'hostname' }, (res) => {
        // ⚠️ lastError 必须在回调里读掉，否则控制台会冒出 Unchecked runtime.lastError
        const bad = chrome.runtime.lastError;
        resolve((!bad && res && res.hostname) ? String(res.hostname) : '');
      });
    } catch (e) {
      resolve('');
    }
  });
}

/* 画「在此域名不可用」那一行。

   ⚠️ 拆成独立函数是**为了能被单独调用**：e2e 里 popup 是以普通标签页打开的，
   那时「当前标签页」就是 popup 自己，拿不到网页域名。
   把「判断与渲染」和「能不能拿到域名」分开，两件事才都能测。 */
function paintSite(host, text) {
  const box = $('siteOff');
  const desc = $('siteDesc');
  if (!box || !desc) return;

  // 记下来：勾选框的 change 处理要用它（画的是哪个域名，写的就是哪个域名）
  currentHost = host || '';
  sitesText = text || '';

  if (!host) {
    box.checked = false;
    box.disabled = true;
    desc.textContent = t('pop.siteNoHost');
    return;
  }

  /* 命中它的可能是**更宽的一条规则**（列表里写的是 example.com，当前是
     a.example.com）。不说清楚的话，用户会以为「勾选框自己勾上了」。 */
  const rules = SITES.parse(text).list.filter((p) => SITES.matches(host, [p]));

  box.disabled = false;
  box.checked = rules.length > 0;
  desc.textContent = rules.length && rules.indexOf(host) === -1
    ? t('pop.siteCovered', { host: host, rule: rules[0] })
    : t('pop.siteOffDesc', { host: host });
}

/* 语言快捷按钮上那两个字（#57 / #35 第 3 步）。

   ⚠️ **刻意不走 t()，也不跟着翻译**：
     中文界面显示 EN（点一下切到英文），英文界面显示 CN（点一下切回中文）。
     它要是一起翻译了就会**自指** —— 中文界面里写着「英文」，
     用户根本不知道点下去会发生什么。
     所以这两个标签是常量而不是文案（纯 ASCII，连 i18n-allow 都不用标）。 */
const LANG_LABEL = { zh: 'EN', en: 'CN' };

/* 界面语言一变，这一页里**由 JS 拼出来的**文字都得重画一遍。
   静态部分（data-i18n 那些）由 applyI18n 负责，这里只管动态的：
   警告行、排除站点那一行的说明、主题按钮与语言按钮的提示。 */
function repaintDynamic() {
  if (lastCfg) {
    paintWarn(lastCfg);
    paintSite(currentHost, sitesText);
  }
  paintTheme();
  paintLang();
}

function paintLang() {
  const btn = $('lang');
  if (!btn) return;
  const cur = T.getLang();
  btn.textContent = LANG_LABEL[cur] || LANG_LABEL.zh;
  /* 提示文字是描述「这个动作」的，可以翻译 —— 它不自指：
     中文界面下说「切换到英文界面」，英文界面下说「Switch the interface to Chinese」。 */
  const label = t('pop.langTo', { lang: t(cur === 'zh' ? 'lang.en' : 'lang.zh') });
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/* 主题按钮：浅色 ↔ 深色 直接互切。
   刻意不做「第三档 auto」—— 按钮只有两个状态，点一下就是明确的「换成另一种」。
   要回到跟随系统，去设置页的「界面主题」里选（那里是三档）。 */
function paintTheme() {
  const resolved = THEME.apply(themePref, document.documentElement);
  const next = t(resolved === 'dark' ? 'theme.light' : 'theme.dark');
  const label = t('pop.themeTo', { name: next });
  const btn = $('theme');
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/* 弹层里不再有引擎选择，所以「配没配 Key」是这里唯一还能提前告诉用户的事 ——
   否则他会看到一个一切正常的弹层，然后在网页上划词毫无反应。 */
function paintWarn(cfg) {
  const el = $('warnline');
  const engine = cfg.engine === 'google' ? 'google' : 'deepseek';
  const hasKey = !!(cfg.deepseekKey && String(cfg.deepseekKey).trim());

  if (engine === 'deepseek' && !hasKey) {
    el.textContent = t('pop.warnNoKey');
    return;
  }
  el.textContent = '';
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind || '';
}

function render(cfg) {
  lastCfg = cfg;
  $('enabled').checked = cfg.enabled !== false;
  paintWarn(cfg);
  themePref = cfg.theme || 'auto';
  paintTheme();
  paintLang();

  // 排除列表：先用配置里已有的文本画一版，等域名回来再画一次
  // （域名要问内容脚本，是异步的；先画一版可以让弹层不出现空白）
  paintSite(currentHost, cfg.excludeSites || '');
  currentHostname().then((h) => paintSite(h, sitesText));
}

function save(patch) {
  if (!hasExt) return Promise.resolve();
  return chrome.storage.local.set(patch);
}

/* ---------- 事件 ---------- */

$('enabled').addEventListener('change', () => {
  const on = $('enabled').checked;
  save({ enabled: on })
    .then(() => setStatus(on ? t('pop.on') : t('pop.off'), 'ok'))
    .catch((e) => setStatus(t('pop.saveFail', { msg: e.message }), 'err'));
});

/* 勾选框 = 「把当前域名加进 / 移出排除列表」（#29）。
   弹层一关就被销毁，所以改完立即写 storage，与总开关同一个做法。

   ⚠️ 列表是**原文**存的（可能带 # 备注、带写错的行），所以这里用
   SITES.setExcluded 做「只动相关行」的增删，而不是重新拼一份。 */
$('siteOff').addEventListener('change', () => {
  const on = $('siteOff').checked;
  if (!currentHost) {
    setStatus(t('pop.noHost'), 'err');
    return;
  }

  chrome.storage.local.get({ excludeSites: '' }).then((v) => {
    const next = SITES.setExcluded(v.excludeSites || '', currentHost, on);
    return save({ excludeSites: next }).then(() => {
      paintSite(currentHost, next);
      // 判断只在页面加载时做一次，所以必须说清楚要刷新
      setStatus(on ? t('pop.siteAdded') : t('pop.siteRemoved'), 'ok');
    });
  }).catch((e) => setStatus(t('pop.saveFail', { msg: e.message }), 'err'));
});

$('open-options').addEventListener('click', () => {
  if (hasExt && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    window.close();
  } else {
    setStatus(t('pop.noExt'), 'err');
  }
});

// 「反馈建议」是一个普通的 <a target="_blank">：浏览器会开新标签页，
// 弹层随之关闭。不需要 JS，也就不需要 tabs 权限。
// 万一在没有扩展 API 的环境里打开本页，点击它也不会报错（只是普通链接）。

$('theme').addEventListener('click', () => {
  // 从当前「实际显示的样子」翻到另一种，所以 auto 点一下也会变成明确的选择
  themePref = THEME.resolve(themePref) === 'dark' ? 'light' : 'dark';
  paintTheme();
  save({ theme: themePref }).catch((e) => setStatus(t('pop.saveFail', { msg: e.message }), 'err'));
});

// 系统主题变了要跟着重算（只有 auto 会真的变，重算是幂等的）
THEME.onChange(paintTheme);

/* 语言快捷按钮（#57 / #35 第 3 步）。

   与主题按钮同一个做法：点一下就是明确的「换成另一种」，立即写 storage。
   ⚠️ 它把 uiLang 从 'auto' 变成明确的一种 —— 这正是这个按钮的语义：
     用户主动点了一次，就不再是「跟随浏览器」了。
     想回到跟随，去设置页的「界面语言」里选（那里是三档）。 */
$('lang').addEventListener('click', () => {
  const next = T.getLang() === 'zh' ? 'en' : 'zh';

  T.setLang(next);
  T.applyI18n();
  document.title = t('pop.title');
  repaintDynamic();

  save({ uiLang: next }).catch((e) => setStatus(t('pop.saveFail', { msg: e.message }), 'err'));
});

/* ---------- 初始化 ---------- */

/* ⚠️ 第一件事就是同步填文案：这一步同时把 html.i18n-pending 撤掉。
   等 storage 读回来再填的话，弹层会先白一下（文案全空）。 */
T.applyI18n();
document.title = t('pop.title');
// 同步先画一次语言按钮，免得它空着（真实语言要等配置读回来才定）
paintLang();

if (hasExt) {
  chrome.storage.local.get(DEFAULTS)
    .then((v) => {
      const cfg = Object.assign({}, DEFAULTS, v);
      /* 界面语言来自配置，所以读完要再填一次（首次那次用的是默认语言）。
         语言没变时这一步是幂等的，代价只是再走一遍 querySelectorAll。 */
      T.setLang(cfg.uiLang);
      T.applyI18n();
      document.title = t('pop.title');
      render(cfg);
      try {
        $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
      } catch (e) { /* 拿不到版本号不影响使用 */ }
    })
    .catch((e) => setStatus(t('pop.readFail', { msg: e.message }), 'err'));
} else {
  render(DEFAULTS);
}
