'use strict';

/* 划词翻译 —— 内容脚本
   职责：监听划词，在选区旁显示浮层，把文本交给后台翻译后渲染结果。
   浮层用 Shadow DOM 封装，避免被宿主页面的 CSS 污染。 */

(() => {
  const HOST_ID = 'wt-translate-host';
  // DEFAULTS 的单一真源在 config.js，语言表在 lang.js，技术内容判定在 tech.js
  // —— manifest 的 content_scripts 已把它们都排在 content.js 之前
  const DEFAULTS = globalThis.WT_CONFIG.DEFAULTS;
  const LANGUTIL = globalThis.WT_LANG;
  const THEME = globalThis.WT_THEME;
  const TECHLIB = globalThis.WT_TECH;
  // 排除站点匹配（#29）—— 与设置页的逐行校验共用一套规则，见 sites.js
  const SITES = globalThis.WT_SITES;
  // 字号 / 宽度的档位表（#25）—— 与设置页的下拉共用一张，见 config.js
  const FONT_STEPS = globalThis.WT_CONFIG.FONT_STEPS;
  const WIDTH_STEPS = globalThis.WT_CONFIG.WIDTH_STEPS;
  const stepPx = globalThis.WT_CONFIG.stepPx;
  // 朗读语速的档位表（#10）—— 同一个 stepOf 策略，认不出的档位退回中间档
  const stepRate = globalThis.WT_CONFIG.stepRate;
  /* 朗读（#10）。⚠️ 这个模块**只有 content script 加载**（不是四宿主共享模块）——
     目前只有浮层用得到它，所以不做成双模式，见 speak.js 顶部的说明。
     它仍然必须排在 content.js **之前**（manifest 的 content_scripts.js），
     否则这里拿到 undefined，整段朗读功能静默失效 —— dev/check.js 会挡这一条。 */
  const SPEAK = globalThis.WT_SPEAK;
  /* 用户可见文案的单一真源（#39）。
     ⚠️ 一律在**渲染的那一刻**调用 T.t()，绝不把结果快照进模块级常量 ——
     快照会把浮层文案锁死在脚本加载时的语言上，将来切语言只对新页面生效。 */
  const T = globalThis.WT_STRINGS;

  /* 引擎名。用一张显式的表而不是 `'engine.' + engine`：
     将来某个引擎改名 / 下线时，配置里可能还留着旧值，
     这时候要的是「退回一个通用名字」，不是把 'engine.xyz' 这种键名显示给用户。 */
  const ENGINE_KEYS = { google: 'engine.google', deepseek: 'engine.deepseek' };
  /* 认不出的引擎退回 fallbackKey 指定的说法：
     浮层右上角的标签用 'engine.fallback'（「翻译」），
     句子中间的「X 偶尔需要几秒」用 'engine.any'（「引擎」）——
     同一个「认不出」在两种句式里要的其实是两个词。 */
  function engineLabel(engine, fallbackKey) {
    return T.t(ENGINE_KEYS[engine] || fallbackKey || 'engine.fallback');
  }

  /* 技术内容的类别名。tech.js 只给类别（'url' / 'code'…），名字在 strings.js。
     缺键时退回「技术内容」而不是把 'tech.foo' 显示出来 —— 与 t() 的
     「缺键返回键名」策略相反，因为这里是**面向用户**的那一层。 */
  function techLabel(kind) {
    const key = 'tech.' + kind;
    const s = T.t(key);
    return s === key ? T.t('tech.other') : s;
  }

  const MAX_LEN = 1000;   // 超过这个长度不翻译，避免误选整页
  const DEBOUNCE = 220;   // 松开鼠标后延迟，等浏览器把选区确定下来
  const GAP = 8;          // 浮层与选区的间距
  /* 手动模式那个小图标贴得更近一点（#6）—— 离选区远了会让人不确定它属于哪一段。 */
  const MINI_GAP = 6;
  const MARGIN = 8;       // 浮层与视口边缘的最小间距
  /* 超过这个时间还没结果，就在「翻译中」下面补一句「请稍候」（#20）。
     目的不是报进度，是把「是不是卡死了」这个问题**提前答掉** ——
     用户真正焦虑的时刻大约就在第三秒。 */
  const SLOW_MS = 3000;

  /* iframe 里最小可用的视口。见下面的 tooSmallFrame()。 */
  const MIN_FRAME = { w: 320, h: 220 };

  /* ---------- 「我是谁」（#29）----------

     popup 里那个「在此域名不可用」需要知道当前是哪个域名。
     popup 自己读不到 `tab.url` —— 那需要 `tabs` 权限，安装时会多一条
     「读取你的浏览记录」，为这一个勾选框不值当。所以由内容脚本回答。

     ⚠️ 这条监听必须在**所有早退之前**注册（在 tooSmallFrame / excluded 之前），
     而且排除站点上也要保留。原因很实在：用户在排除站点上打开 popup 时，
     勾选框要显示成「已勾选」才有意义 —— 否则他看到的永远是未勾选，
     也就永远没办法在这里把它取消掉。

     它只回一个字符串：不碰 DOM、不发请求、不建浮层。
     这是「命中排除站点后什么都不做」的一个**明确例外**，不是漏了。 */
  try {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || msg.type !== 'whoami') return;
      /* all_frames: true，所以一个标签页里每个框架都有这份脚本。
         只让顶层框架回答 —— 否则 iframe 里的域名可能抢先答上来。 */
      if (window.top !== window.self) return;
      respond({ hostname: location.hostname });
    });
  } catch (e) {
    // 扩展被重新加载后旧脚本会失效，忽略即可
  }

  /* i18n-allow: 下面这个模板串是 CSS，里面的汉字全是给维护者看的注释，不是文案 */
  const CSS = `
    :host { all: initial; }
    .panel {
      position: absolute;
      top: 0;
      left: 0;
      box-sizing: border-box;
      display: none;
      width: max-content;
      /* 字号与宽度由 content.js 写在**宿主元素**的 inline style 上（#25）。
         这里的默认值是「配置读不到 / 值认不出」时的兜底，也是不装设置页时
         的行为 —— 和改造前写死的 14px / 420px 完全一致。
         ⚠️ :host 上的 all: initial 不会清掉自定义属性（all 不覆盖 custom
         property），所以宿主上设的变量一定能传进来。 */
      max-width: var(--wt-mw, 420px);
      min-width: var(--wt-minw, 200px);
      padding: 10px 12px 11px;
      border: 1px solid rgba(0, 0, 0, 0.10);
      border-radius: 10px;
      background: #ffffff;
      color: #1c1c1c;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: var(--wt-fs, 14px);
      line-height: 1.65;
      text-align: left;
      word-break: break-word;
      overflow-wrap: anywhere;
      -webkit-font-smoothing: antialiased;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 5px;
    }
    .tag {
      font-size: 11px;
      color: #8a8a8a;
      white-space: nowrap;
      /* ⚠️ 加朗读按钮之后工具条变宽了（#10）。窄档（320px）下面板会挤，
         这时**先压缩引擎名**（省略号），而不是让按钮换行 —— 按钮换行会让
         整个头部的布局跳一下，而引擎名本来就只是个标签。 */
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tools { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .btn {
      all: unset;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 5px;
      font-size: 11px;
      line-height: 1.4;
      color: #8a8a8a;
      white-space: nowrap;
    }
    .btn:hover { background: rgba(128, 128, 128, 0.16); color: #444444; }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
    }
    .icon-btn svg { width: 15px; height: 15px; display: block; fill: currentColor; }
    /* 错误文案下方的动作按钮（如「去设置」）—— 要看起来能点，
       不能做成 .btn 那种纯文字，否则和「复制 / 关闭」混在一起看不出来。 */
    .act {
      all: unset;
      display: inline-block;
      cursor: pointer;
      margin-top: 8px;
      padding: 4px 12px;
      border: 1px solid currentColor;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.5;
      color: #c0392b;
    }
    .act:hover { background: rgba(192, 57, 43, 0.10); }
    /* 说明类（不是错误）里的动作按钮，如「仍然翻译」——
       用强调色而不是红色：它不是出错了，只是被拦了一下。 */
    .act.soft { color: #2f6fed; }
    .act.soft:hover { background: rgba(47, 111, 237, 0.10); }
    .text { white-space: pre-wrap; }
    .muted { color: #8a8a8a; font-size: 13px; }
    .err { color: #c0392b; font-size: 13px; }
    /* 等待态的进度指示（#20）。
       三个点在跳，只是要让「它还在动」这件事看得见 —— 静态的「翻译中…」
       在慢的时候和卡死分不出来。 */
    .wait { margin-left: 4px; }
    .wait i {
      display: inline-block;
      width: 3px;
      height: 3px;
      margin-left: 3px;
      border-radius: 50%;
      background: currentColor;
      vertical-align: middle;
      opacity: 0.35;
      animation: wt-wait 1.05s infinite ease-in-out;
    }
    .wait i:nth-child(2) { animation-delay: 0.15s; }
    .wait i:nth-child(3) { animation-delay: 0.30s; }
    @keyframes wt-wait {
      0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-3px); }
    }
    /* ⚠️ 必须尊重「减弱动态效果」。照抄 popup 主题按钮那套降级思路：
       动画关掉之后不能什么都不留 —— 三个点还在、只是不动，
       配上「翻译中」这三个字，仍然表达得出「正在进行」。 */
    @media (prefers-reduced-motion: reduce) {
      .wait i { animation: none; opacity: 0.6; }
    }
    /* 慢响应提示（#20）。单独一行、字号更小 —— 它是补充说明，不该抢译文的注意力。 */
    .slow { margin-top: 6px; color: #8a8a8a; font-size: 12px; }
    /* 朗读的即时提示（#10）：没有语音包 / 朗读失败。
       ⚠️ 它是**追加**在译文下面的一行，不是 replace 掉整屏 ——
       否则「点朗读发现没语音包」会把用户刚拿到的译文弄没，那是净损失。 */
    .speak-hint { margin-top: 6px; color: #c0392b; font-size: 11px; }
    /* 手动模式的小图标（#6）。
       它必须**看起来就能点** —— 参考 popup 主题按钮那次的教训：裸图标和背景
       分不开，用户根本不知道那儿有个东西。所以给足尺寸 + 描边 + 阴影。
       .panel.mini 把这个图标之外的面板样式全部撤掉，复用同一个宿主。

       ⚠️ 圆点**不跟随**字号设置（#25）：它是一个图标，尺寸就是那个圆的尺寸，
       里面的「译」是图形的一部分而不是要读的正文。让 16px 的字挤在 24px 的
       圆里只会显得局促，还得跟着改圆的大小 —— 那又是另一个设置项了。 */
    .panel.mini {
      padding: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      min-width: 0;
      max-width: none;
    }
    .dot {
      all: unset;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: 1px solid rgba(0, 0, 0, 0.16);
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22);
      color: #1c1c1c;
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      user-select: none;
    }
    .dot:hover { background: #f0f4ff; border-color: rgba(47, 111, 237, 0.5); color: #2f6fed; }
    .dot:active { transform: scale(0.93); }
    :host([data-theme="dark"]) .dot {
      background: #2f2f2f;
      border-color: rgba(255, 255, 255, 0.22);
      color: #ededed;
    }
    :host([data-theme="dark"]) .dot:hover {
      background: #3a4356;
      border-color: rgba(111, 157, 255, 0.6);
      color: #6f9dff;
    }
    /* 主题：theme.js 把 auto 解析成 light / dark，由 content.js 写在宿主元素上。
       用 :host([data-theme="dark"]) 而不是媒体查询 —— 手动选的主题必须能盖过系统。 */
    :host([data-theme="dark"]) .panel {
      background: #2a2a2a;
      color: #ededed;
      border-color: rgba(255, 255, 255, 0.14);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    }
    :host([data-theme="dark"]) .tag,
    :host([data-theme="dark"]) .btn,
    :host([data-theme="dark"]) .muted { color: #9a9a9a; }
    :host([data-theme="dark"]) .btn:hover {
      background: rgba(255, 255, 255, 0.14);
      color: #e0e0e0;
    }
    :host([data-theme="dark"]) .err { color: #ff8f85; }
    :host([data-theme="dark"]) .slow { color: #9a9a9a; }
    :host([data-theme="dark"]) .speak-hint { color: #ff8f85; }
    :host([data-theme="dark"]) .act { color: #ff8f85; }
    :host([data-theme="dark"]) .act:hover { background: rgba(255, 143, 133, 0.14); }
    :host([data-theme="dark"]) .act.soft { color: #6f9dff; }
    :host([data-theme="dark"]) .act.soft:hover { background: rgba(111, 157, 255, 0.16); }
  `;

  let cfg = Object.assign({}, DEFAULTS);
  let host = null;
  let panel = null;
  let copyBtn = null;
  let altBtn = null;
  let altAction = 'translate'; // translate | readOriginal
  let readBtn = null;      // 朗读译文（#10）
  let tagEl = null;
  let timer = null;
  let seq = 0;
  // 是否有请求正在等结果。关浮层时靠它决定要不要通知后台取消 ——
  // 没在等的时候不发消息，避免每次点击都把 service worker 唤醒一次。
  let waiting = false;
  let curRect = null;
  let curGap = GAP;       // 当前这次浮层该离选区多远（手动模式的小图标更近，见 MINI_GAP）
  let scrollRef = 0;
  let lastResult = '';
  // 上一次请求的原文与最终译成的语言。「译成 X」按钮靠这两个重发一次反向请求。
  let lastText = '';
  let lastTarget = '';
  /* 上一次请求用的**强制方向**（'' = 没强制）。
     「重试」要原样重发一次，所以不能拿 lastTarget 去凑 ——
     lastTarget 是响应里的最终目标语言，拿它当 forceTarget 会把方向钉死，
     用户之后改了配置再重试，拿到的还是旧方向。 */
  let lastForce = '';
  // 手动模式下「待翻译」的原文 —— 点小图标时才用它去发请求（#6）
  let dotText = '';
  let slowTimer = null;   // 慢响应提示的定时器（#20）
  let rafPending = false;
  let booted = false;     // 监听是否已注册（#29 的排除站点会让它一直为 false）

  /* ---------- 朗读（#10）----------

     一个实例跟着浮层走：换选区、重新翻译、关浮层都要把它停掉，
     否则声音会在后台继续播（用户已经不看那一屏了）。

     ⚠️ 每次开始朗读都**新建**一个 speaker，不复用：语速与口音是用户在设置页
     当场改的，复用会把它们锁死在第一次朗读时的值上 —— 而且不报错。 */
  let speaker = null;
  let hintTimer = null;
  /* 取语音列表是**异步**的（最多等 3 秒）。等回来的时候用户可能已经关了浮层、
     或者又点了别的 —— 用一个令牌把过期的那次丢掉，否则会在看不见的浮层上
     突然开始朗读。与 request() 的 seq 是同一个套路。 */
  let readToken = 0;

  /* ---------- iframe 兜底（#3） ----------

     宿主是 position: fixed，在 iframe 内部它以 **iframe 自己的视口**为基准，
     而 place() 又按 window.innerWidth / innerHeight 夹取 —— 所以浮层**不会跑出**
     iframe 的边界，它已经被夹住了。

     真正的问题是：iframe 本身太矮或太窄时，浮层装不下，**被 iframe 的盒子裁掉**
     （iframe 会裁切自己的内容）。表现是「时好时坏的怪现象」—— 用户没法解释，
     我们也解释不清。

     这里把它变成一个明确的「不做」：装不下就不注册任何监听，连请求都不发
     （顺带省一次计费）。README 的「已知限制」写了同一条。

     ⚠️ 判断只在脚本加载时做一次（与 #29 排除站点同一个道理）——
     iframe 事后被拉大不会自动恢复，需要刷新页面。 */
  function tooSmallFrame() {
    // 比较 window.top 与 window.self 不涉及跨域访问，任何页面都安全
    if (window.top === window.self) return false;
    return window.innerWidth < MIN_FRAME.w || window.innerHeight < MIN_FRAME.h;
  }

  if (tooSmallFrame()) return;

  /* ---------- 排除站点（#29） ----------

     ⚠️ 关闭条件里原本写的是「命中时**完全不注入**浮层」—— 那做不到：
     内容脚本是 manifest 声明的（`matches: <all_urls>`），**脚本一定会被注入**，
     没有任何办法阻止。要真做到「不注入」，得改成 `chrome.scripting` 动态注入，
     代价是失去「选中即翻」的自动性，不划算。所以关闭条件改成了能做到的表述：
     **命中时不注册监听、不弹浮层、不发请求。**

     判断只在脚本加载时做一次。代价是改完配置要**刷新页面**才生效（设置页会提示），
     换来的是「每个页面只算一次」，而不是每次 mouseup 都去比一遍。
     与上面 tooSmallFrame() 是同一个取舍。 */
  function excluded() {
    return SITES.matches(location.hostname, SITES.parse(cfg.excludeSites).list);
  }

  /* ---------- 配置 ---------- */

  /* 把当前主题写到宿主元素上（CSS 用 :host([data-theme="dark"]) 取）。
     浮层还没创建时什么都不做 —— ensure() 建好之后会再调一次。 */
  function applyTheme() {
    if (!host) return;
    host.setAttribute('data-theme', THEME.resolve(cfg.theme));
  }

  /* 把字号与最大宽度写进**宿主元素**的 inline style（#25）。

     ⚠️ 绝不能写到宿主页面的 documentElement 上 —— content script 不该改页面的
     任何样式，那样做等于把我们自己的 CSS 变量塞进页面的作用域里。
     写在宿主元素上则天然被 Shadow DOM 关住：自定义属性沿 shadow 边界继承，
     只有 .panel 看得到（这是「变量」而不是「拼字符串」的意义所在）。

     ⚠️ 也不能把值拼进 <style> 的文本里重建样式表 —— 那样等于给自己开了一个
     注入面，而且每次改设置都要重建整张表。setProperty 只做赋值。

     min-width 不给用户调：宽度是 max-content 打底、max-width 封顶，
     最小值只在「短词」上起作用，给它三档看不出差别。 */
  function applySize() {
    if (!host) return;
    host.style.setProperty('--wt-fs', stepPx(FONT_STEPS, cfg.panelFont) + 'px');
    host.style.setProperty('--wt-mw', stepPx(WIDTH_STEPS, cfg.panelWidth) + 'px');
  }

  /* 读配置 → 应用 → 启动。

     ⚠️ 启动被挪到了这个回调里（原来是同步注册监听），因为「排除站点」必须在
     **注册任何监听之前**判断，而排除列表只有异步读得到。
     两条防线保证它不会变成「整个扩展静默失效」：
     ① 读失败（扩展上下文已失效）时**照常启动** —— 让用户看到
        「扩展上下文已失效，请刷新页面」，而不是「什么都没发生」；
     ② 超时兜底：storage 万一不回调，1.5 秒后也照常启动。
        排除列表是「少做一件事」，读不到就该按「不排除」处理。 */
  function loadConfig() {
    let answered = false;

    try {
      chrome.storage.local.get(DEFAULTS, (v) => {
        answered = true;
        if (!chrome.runtime.lastError) {
          cfg = Object.assign({}, DEFAULTS, v);
          applyTheme();
          applySize();
          if (excluded()) return;   // 命中排除站点：连监听都不注册（#29）
        }
        boot();
      });
    } catch (e) {
      boot();
      return;
    }

    setTimeout(() => { if (!answered) boot(); }, 1500);
  }

  loadConfig();

  /* ---------- 选区几何（#22） ----------

     取「这次划词该以哪个矩形为基准」。

     ⚠️ **不能直接用 `getBoundingClientRect()`**：跨行选中时它是**整段的包围盒**。
     包围盒的宽度取的是最长那一行，于是浮层被定位到整段的中间 ——
     而用户的眼睛在**首行**（那是他这次划词的起点）。

     所以拆开取：
     - 纵向：首行的 `top`（浮层翻到上方时用）/ 末行的 `bottom`（放下方时用）
     - 横向：按**首行**的 left + width 居中

     `getClientRects()` 在跨行时会返回多个矩形（同一行的多个片段也会各占一条），
     所以首行 = top 最小的那条，末行 = bottom 最大的那条。

     拿不到 client rects 时退回包围盒 —— 位置粗一点，总比什么都不显示强。 */
  function selectionRect(sel) {
    let range = null;
    try {
      range = sel.getRangeAt(0);
    } catch (e) {
      return null;
    }

    let box = null;
    try {
      box = range.getBoundingClientRect();
    } catch (e) {
      box = null;
    }
    if (!box) return null;

    let rects = [];
    try {
      rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    } catch (e) {
      rects = [];
    }
    if (!rects.length) {
      return { top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
    }

    let first = rects[0];
    let last = rects[0];
    for (const r of rects) {
      if (r.top < first.top) first = r;
      if (r.bottom > last.bottom) last = r;
    }

    return {
      top: first.top,
      bottom: last.bottom,
      left: first.left,
      width: first.width,
      height: last.bottom - first.top
    };
  }

  /* 当前选区对应的矩形；没有有效选区时返回 null。 */
  function currentRect() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    return selectionRect(sel);
  }


  /* ---------- 浮层 ---------- */

  function ensure() {
    if (host && host.isConnected) return true;

    try {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('style',
        'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;');

      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      panel = document.createElement('div');
      panel.className = 'panel';
      shadow.appendChild(panel);

      document.documentElement.appendChild(host);
      applyTheme();
      applySize();
      return true;
    } catch (e) {
      host = null;
      panel = null;
      return false;
    }
  }

  function build() {
    panel.className = 'panel';   // 从手动模式的小图标切回来时要把 .mini 撤掉
    panel.textContent = '';
    altAction = 'translate';

    const head = document.createElement('div');
    head.className = 'head';

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = engineLabel(cfg.engine);
    tagEl = tag;

    const tools = document.createElement('div');
    tools.className = 'tools';

    /* 「译成 X」—— 语言判定是启发式的，一定会判错的时候（中英混排、短句、专有名词）。
       这个按钮是唯一的出口：判错时一键换方向，不用跑去设置页改配置。
       没出结果之前不显示（那时还不知道目标语言是什么）。 */
    altBtn = document.createElement('button');
    altBtn.className = 'btn';
    altBtn.type = 'button';
    altBtn.textContent = T.t('panel.altIdle');
    altBtn.setAttribute('title', T.t('panel.altIdle'));
    altBtn.setAttribute('aria-label', T.t('panel.altIdle'));
    altBtn.style.display = 'none';
    altBtn.addEventListener('click', onAlt);

    copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.type = 'button';
    copyBtn.textContent = T.t('panel.copy');
    copyBtn.addEventListener('click', onCopy);

    /* 朗读（#10）。只保留朗读译文按钮，用喇叭图标表达动作。
       没出结果之前不显示（那时没有译文可读）。 */
    readBtn = document.createElement('button');
    readBtn.className = 'btn icon-btn';
    readBtn.type = 'button';
    readBtn.style.display = 'none';
    readBtn.addEventListener('click', onRead);
    paintRead();

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.type = 'button';
    closeBtn.textContent = T.t('panel.close');
    closeBtn.addEventListener('click', close);

    tools.appendChild(altBtn);
    tools.appendChild(readBtn);
    tools.appendChild(copyBtn);
    tools.appendChild(closeBtn);
    head.appendChild(tag);
    head.appendChild(tools);

    const body = document.createElement('div');
    body.className = 'body';

    panel.appendChild(head);
    panel.appendChild(body);
  }

  function setBody(text, cls) {
    const body = panel.querySelector('.body');
    body.textContent = '';
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    body.appendChild(div);
  }

  /* 等待态（#20）：文字 + 三个在跳的点。
     没有走「把 HTML 塞给 setBody」那条路 —— 那会让所有文案都变成可注入的字符串，
     为了一处排版把一个安全问题引进来不划算。 */
  function setWaiting() {
    const body = panel.querySelector('.body');
    body.textContent = '';
    const div = document.createElement('div');
    div.className = 'muted';
    div.appendChild(document.createTextNode(T.t('panel.loading')));
    const wait = document.createElement('span');
    wait.className = 'wait';
    for (let i = 0; i < 3; i++) wait.appendChild(document.createElement('i'));
    div.appendChild(wait);
    body.appendChild(div);
  }

  /* 慢响应提示（#20）。到点还没结果就补一句 —— 它只加一次，
     而且只在浮层还开着、这一屏还是等待态的时候加。 */
  function clearSlow() {
    if (slowTimer) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
  }

  function onSlow() {
    slowTimer = null;
    if (!panel || panel.style.display === 'none' || !waiting) return;
    const body = panel.querySelector('.body');
    if (!body || body.querySelector('.slow')) return;
    const p = document.createElement('div');
    p.className = 'slow';
    p.textContent = T.t('panel.slow', { engine: engineLabel(cfg.engine, 'engine.any') });
    body.appendChild(p);
    place();
  }

  function place() {
    if (!panel || !curRect) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;

    /* 纵向：优先放选区**下方**；下方装不下就翻到**上方**；两边都装不下才贴住视口。
       放下方时以末行的 bottom 为基准、翻上去时以首行的 top 为基准 ——
       这正是 selectionRect() 把首行 / 末行分开的原因。 */
    let top = curRect.bottom + curGap;
    if (top + ph > vh - MARGIN) {
      const above = curRect.top - curGap - ph;
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - ph - MARGIN);
    }

    /* 横向：先按选区中心对齐；**贴边时换边，而不是硬夹**（#22）。

       硬夹的后果不是「浮层出界」（夹取本身保证了不出界），而是
       「浮层虽然没出界，却整个盖在选区上」—— 用户看不到自己选了什么。
       所以左边放不下就改成与选区**左缘**对齐，右边放不下就与**右缘**对齐，
       最后才夹取兜底。 */
    const center = curRect.left + curRect.width / 2;
    let left = center - pw / 2;

    if (left < MARGIN) {
      left = curRect.left;
    } else if (left + pw > vw - MARGIN) {
      left = curRect.left + curRect.width - pw;
    }
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - pw - MARGIN));

    panel.style.top = Math.round(top) + 'px';
    panel.style.left = Math.round(left) + 'px';
  }

  /* 作废当前这次请求：seq++ 让回来的响应被丢掉，并通知后台停掉在飞的请求。

     通知后台那一步不能省：以前 close() 只做 seq++，请求仍在后台跑完并计费 ——
     用户已经点了别处、浮层都关了，结果没人要，这笔钱是纯浪费。 */
  function abortCurrent() {
    clearSlow();
    seq++;
    if (!waiting) return;
    waiting = false;
    try {
      chrome.runtime.sendMessage({ type: 'cancel' });
    } catch (e) {
      /* 扩展上下文已失效，忽略即可 —— 反正页面一刷新也会重来 */
    }
  }

  function close() {
    abortCurrent();
    /* ⚠️ 必须停朗读（#10）：用户已经把浮层关了，声音还在念上一屏的译文，
       比「没反应」更让人困惑。 */
    stopRead();
    if (panel) panel.style.display = 'none';
    curRect = null;
    lastResult = '';
    dotText = '';   // 手动模式下的小图标已经收起来了，别再留着一个能点的东西
  }

  /* 复制：navigator.clipboard 只在**安全上下文**存在 —— 在 http:// 页面上它是
     undefined，调用抛错后被 catch 吞掉，用户只看到「复制失败」且不知道为什么。

     所以补一条回退链：能用 clipboard 就用它，否则用隐藏 textarea +
     document.execCommand('copy')（在老页面里仍然有效）。
     ⚠️ 顺序不能反 —— 先修路径再加功能，否则新选项在新页面上照样失败。 */
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

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return Promise.resolve().then(() => legacyCopy(text));
  }

  function onCopy() {
    if (!lastResult) return;
    writeClipboard(lastResult).then(() => {
      if (!copyBtn) return;
      copyBtn.textContent = T.t('panel.copied');
      setTimeout(() => {
        if (copyBtn) copyBtn.textContent = T.t('panel.copy');
      }, 1200);
    }).catch(() => {
      if (copyBtn) copyBtn.textContent = T.t('panel.copyFail');
    });
  }

  /* ---------- 朗读（#10）----------

     只用浏览器内置的 speechSynthesis（离线、不上传、零成本、零权限）。
     分句 / 选音 / 状态机在 speak.js 里，这里只管与浮层接线。 */

  /* 语音列表是**异步**加载的：首次 `getVoices()` 常常返回空数组，
     要等一次 `voiceschanged` 才有内容。只看一次的话，用户第一次点朗读
     必然得到「没有语音包」—— 而第二次就好了，这种「时好时坏」最难查。
     所以这里等一次事件，另加 3 秒兜底（有些环境永远不发这个事件）。 */
  function withVoices(cb) {
    const synth = window.speechSynthesis;
    if (!synth) { cb([]); return; }

    const now = synth.getVoices();
    if (now && now.length) { cb(now); return; }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (synth.removeEventListener) synth.removeEventListener('voiceschanged', finish);
      cb(synth.getVoices() || []);
    };
    try {
      if (synth.addEventListener) synth.addEventListener('voiceschanged', finish);
    } catch (e) { /* 没有这个 API 的环境直接走下面的超时 */ }
    setTimeout(finish, 3000);
  }

  /* 朗读译文的语言用**响应里的目标语言**，没有响应字段时回退当前设置。 */
  function readLang() {
    return lastTarget || cfg.targetLang;
  }

  /* 朗读原文时重新做一次语言判定。这个按钮只会在「译成中文」这个
     反向出口上出现，所以正常情况下一定能判出中文；判不出时仍回退首选语言。 */
  function originalReadLang() {
    const detected = LANGUTIL.detect(lastText);
    return detected === 'unknown' ? cfg.preferredLang : detected;
  }

  function setReadIcon(stop) {
    if (!readBtn) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(ns, 'path');
    path.setAttribute(
      'd',
      stop
        ? 'M6 5h4v14H6V5zm8 0h4v14h-4V5z'
        : 'M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.1-3.8v7.6a4.5 4.5 0 0 0 2.1-3.8zm0-7.5v2.1A7 7 0 0 1 20 12a7 7 0 0 1-3.5 6.4v2.1A9 9 0 0 0 22 12a9 9 0 0 0-5.5-7.5z'
    );
    svg.appendChild(path);
    readBtn.textContent = '';
    readBtn.appendChild(svg);
    const label = stop ? T.t('panel.stopRead') : T.t('panel.readOut');
    readBtn.setAttribute('title', label);
    readBtn.setAttribute('aria-label', label);
    readBtn.setAttribute('aria-pressed', stop ? 'true' : 'false');
  }

  function paintRead() {
    const on = !!(speaker && speaker.isSpeaking());
    setReadIcon(on);
  }

  /* 一行即时提示（没有语音包 / 朗读失败）。

     ⚠️ **追加**在译文下面，而不是 replace 掉整屏 —— 「点朗读发现没语音包」
     不该把用户刚拿到的译文弄没，那是净损失。 */
  function speakHint(msg) {
    if (!panel) return;
    const body = panel.querySelector('.body');
    if (!body) return;

    const old = body.querySelector('.speak-hint');
    if (old) old.remove();

    const el = document.createElement('div');
    el.className = 'speak-hint';
    el.textContent = msg;
    body.appendChild(el);
    place();

    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hintTimer = null;
      if (el.parentNode) { el.remove(); place(); }
    }, 4000);
  }

  function onSpeakState(state) {
    if (state === 'idle') {
      speaker = null;
    }
    paintRead();
  }

  function stopRead() {
    readToken++;                   // 作废还在等语音列表的那一次
    if (speaker) speaker.stop();   // 会触发 onState('idle')
    speaker = null;
    paintRead();
  }

  /* 共同的朗读启动路径：译文和原文都要等语音列表、选音、处理无语音包，
     只是在文本与语言上不同。 */
  function startRead(text, lang) {
    if (!SPEAK) return;               // speak.js 没加载（不该发生，check.js 会挡）
    const synth = window.speechSynthesis;
    if (!synth) { speakHint(T.t('panel.noVoice')); return; }
    if (!text) return;

    stopRead();
    const my = readToken;

    withVoices((voices) => {
      if (my !== readToken) return;   // 期间用户关了浮层 / 又点了别的
      if (!voices.length) { speakHint(T.t('panel.noVoice')); return; }

      const made = SPEAK.createSpeaker({
        synth: synth,
        Utterance: window.SpeechSynthesisUtterance,
        lang: lang,
        accent: cfg.speakAccent,
        rate: stepRate(cfg.speakRate),
        onState: onSpeakState,
        onError: () => speakHint(T.t('panel.readFail'))
      });

      speaker = made;
      if (!made.start(text)) {
        /* 到这里只有一种可能：没有**这门语言**的语音包
           （一个都没有的情况上面已经挡掉了）。给一句能看懂的话，
           而不是静默无反应 —— 这是 #10 关闭条件里明确要求的。 */
        speaker = null;
        paintRead();
        speakHint(T.t('panel.noVoiceLang', { lang: T.t('lang.' + lang) }));
      }
    });
  }

  /* 点一下朗读 / 再点一下停止 —— 同一个按钮两种动作，与「复制」不一样
     （复制是一次性的，没有「停止复制」这回事）。 */
  function onRead() {
    if (speaker && speaker.isSpeaking()) {
      stopRead();
      return;
    }
    startRead(lastResult, readLang());
  }

  function onReadOriginal() {
    if (speaker && speaker.isSpeaking()) {
      stopRead();
      return;
    }
    startRead(lastText, originalReadLang());
  }

  /* 「译成 X」：拿上一次的原文再翻一次，但强制换成另一种语言。
     这是语言判定的出口 —— 判定是启发式的，判错时用户得有一条不绕路的路。

     ⚠️ 换的是**当前配置这一对语言里的另一个**（#9），不是「LANGS 里随便另一个」——
     能翻译的语言有 11 种，从表里猜会切到一门用户根本没配过的语言。 */
  function onAlt() {
    if (altAction === 'readOriginal') {
      onReadOriginal();
      return;
    }
    if (!lastText || !lastTarget) return;
    request(lastText, LANGUTIL.other(lastTarget, cfg.preferredLang, cfg.targetLang));
  }

  /* ---------- 翻译流程 ---------- */

  /* 手动模式的小图标（#6）。

     为什么值得单独一条路径：自动模式是「先发请求、再被取消」，而按 #1 的实测结论，
     取消发生在请求发出之后 —— **那部分输入 token 已经计费**。手动模式是根本不发。
     所以它不只是「少打扰」，也是「少花钱」。

     复用同一个 Shadow DOM 宿主，只把面板换成一颗圆按钮（.panel.mini + .dot）。
     图标上写「译」而不是画一个图标：目标用户一眼就懂，也不需要额外资源。 */
  function showDot(text) {
    if (!ensure()) return;

    abortCurrent();          // 用户已经在看别的了，在飞的请求别再跑完计费
    stopRead();              // 同上：声音也要跟着停（#10）
    lastResult = '';
    lastTarget = '';
    altAction = 'translate';
    dotText = text;
    curGap = MINI_GAP;

    panel.className = 'panel mini';
    panel.textContent = '';

    const dot = document.createElement('button');
    dot.className = 'dot';
    dot.type = 'button';
    dot.textContent = T.t('panel.dot');
    dot.setAttribute('aria-label', T.t('panel.dotTitle'));
    dot.setAttribute('title', T.t('panel.dotTitle'));
    dot.addEventListener('click', () => {
      const t = dotText;
      dotText = '';
      if (t) go(t);
    });
    panel.appendChild(dot);

    panel.style.display = 'block';
    place();
  }

  /* 真正决定「这次要不要发请求」的地方 —— 自动与手动两条路都走它。
     把判定收在一处，是为了避免「自动模式拦住了、手动模式漏了」这种不一致。 */
  function go(text) {
    /* 技术内容（#60）：代码 / 链接 / 邮箱 / 路径 / 命令行，翻了也没意义。
       ⚠️ 判定一定会误伤，所以「仍然翻译」不是可选项。 */
    if (cfg.skipTech !== false) {
      const kind = TECHLIB.looksTechnical(text);
      if (kind) {
        notice(T.t('panel.skipped', { kind: techLabel(kind) }), {
          label: T.t('panel.force'),
          soft: true,
          run: () => request(text)
        });
        return;
      }
    }
    request(text);
  }

  function request(text, forceTarget) {
    if (!ensure()) return;

    stopRead();              // 新的一屏来了，上一屏的声音必须停（#10）
    curGap = GAP;
    build();
    setWaiting();
    panel.style.display = 'block';
    place();

    const my = ++seq;
    waiting = true;
    lastText = text;
    lastForce = forceTarget || '';

    // 慢响应提示（#20）：只在这一屏仍然是「等待态」时才补那一句
    clearSlow();
    slowTimer = setTimeout(onSlow, SLOW_MS);

    const msg = { type: 'translate', text: text };
    if (forceTarget) msg.forceTarget = forceTarget;

    try {
      chrome.runtime.sendMessage(msg, (res) => {
        // 只有「当前这一次」负责清标志：过期响应不能把新请求的状态抹掉
        if (my === seq) waiting = false;
        if (my !== seq) return;
        clearSlow();

        if (chrome.runtime.lastError) {
          fail(T.t('panel.stale'), null, false);
          return;
        }
        if (!res || !res.ok) {
          const err = (res && res.error) || T.t('panel.fail');
          /* 「去设置」给的是**用户自己能解决**的错误（#58 / #19）；
             其余（网络不通、超时、引擎报错）给「去设置」没用，但给「重试」有用（#20）。 */
          const c = res && res.code;
          const fixable = (c === 'no-key' || c === 'quota');
          fail(err, fixable ? { label: T.t('panel.goSettings') } : null, !fixable);
          return;
        }

        lastResult = res.text;
        lastTarget = res.target || '';

        /* 反向时在引擎名后面缀一个「反向」。
           否则用户设了「目标语言 = 英文」却收到中文，会以为插件坏了。 */
        if (tagEl) {
          const base = engineLabel(cfg.engine);
          tagEl.textContent = res.reversed ? T.t('panel.reversedTag', { base: base }) : base;
        }
        if (altBtn && lastTarget) {
          const altTarget = LANGUTIL.other(lastTarget, cfg.preferredLang, cfg.targetLang);
          const readOriginal = altTarget === 'zh' || altTarget === 'zh-Hant';
          altAction = readOriginal ? 'readOriginal' : 'translate';
          const altLabel = readOriginal
            ? T.t('panel.readOriginal')
            : T.t('panel.altTo', { lang: T.t('lang.' + altTarget) });
          altBtn.textContent = altLabel;
          altBtn.setAttribute('title', altLabel);
          altBtn.setAttribute('aria-label', altLabel);
          altBtn.style.display = '';
        }
        // 有译文了，朗读按钮才出来（#10）—— 没结果之前它不显示
        if (readBtn && lastResult) {
          readBtn.style.display = '';
          paintRead();
        }

        setBody(res.text, 'text');
        place();
      });
    } catch (e) {
      waiting = false;
      clearSlow();
      fail(T.t('panel.gone'), null, false);
    }
  }

  /* 文案下方的可选动作。

     两种用途：
     1. 「去设置」（#58）—— 未配置凭据 / 撞上每日上限时，给一条能点的路。
        光给一句话等于把用户丢在原地（他得自己找到扩展菜单里的「选项」）。
     2. 「仍然翻译」（#60）—— 技术内容判定是启发式的，误判必须有出口。

     ⚠️ content script **不能直接调 openOptionsPage**（那是扩展页面 API），
     所以「去设置」要发消息让后台转发。带 `run` 的动作自己处理，不走那条路。 */
  function addAction(action) {
    const body = panel.querySelector('.body');
    const btn = document.createElement('button');
    btn.className = 'act' + (action.soft ? ' soft' : '');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (typeof action.run === 'function') {
        action.run();
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'openOptions' });
      } catch (e) {
        /* 扩展上下文已失效，忽略 */
      }
      close();
    });
    body.appendChild(btn);
  }

  /* 错误态。第三个参数决定要不要给「重试」（#20）：
     - 扩展上下文已失效 / 扩展未就绪 → 重试没用（得先刷新页面或重载扩展）
     - 撞上「没填 Key」「到了每日上限」→ 重试也没用（得先去设置）
     - 网络不通 / 超时 / 引擎报错 → **重试正是用户想要的那条路** */
  function fail(msg, action, allowRetry) {
    abortCurrent();
    stopRead();            // 出错了就别再念了（#10）
    lastResult = '';
    lastTarget = '';
    altAction = 'translate';
    curGap = GAP;
    if (altBtn) altBtn.style.display = 'none';
    if (readBtn) readBtn.style.display = 'none';   // 没有译文可读（#10）
    setBody(msg, 'err');
    if (action) addAction(action);

    /* 「重试」复用 lastText，用户不必再划一次词 ——
       这是 #20 里真正的价值：以前失败之后唯一的出路是重新划。 */
    if (allowRetry !== false && lastText) {
      addAction({ label: T.t('panel.retry'), soft: true, run: () => request(lastText, lastForce || undefined) });
    }
    place();
  }

  /* 一条不需要发请求就能显示的说明（选区太长、被判定为技术内容而跳过等）。
     与 fail() 的区别：它不是错误，所以不清 lastText / lastTarget —— 用户点
     「仍然翻译」时还要用它们。 */
  function notice(msg, action) {
    if (!ensure()) return;
    abortCurrent();
    stopRead();            // 这一屏没有译文，上一屏的声音该停（#10）
    lastResult = '';       // 这一屏没有译文，别让「复制」拿到上一次的结果
    curGap = GAP;
    build();
    // 没有可复制的东西时，那个按钮点了也不会有反应 —— 直接收掉
    if (copyBtn) copyBtn.style.display = 'none';
    // 同理：没有译文可读，朗读按钮也不该在（#10）
    if (readBtn) readBtn.style.display = 'none';
    setBody(msg, 'muted');
    if (action) addAction(action);
    panel.style.display = 'block';
    place();
  }

  function pick() {
    timer = null;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      close();
      return;
    }

    const text = (sel.toString() || '').trim();
    if (!text) {
      close();
      return;
    }
    // 纯数字、纯符号不翻译
    if (!/[\p{L}\p{N}]/u.test(text)) {
      close();
      return;
    }

    /* ⚠️ 先取选区矩形，**再**判长度 —— 超长提示也要有地方显示。
       以前超长是直接 close()，用户划了一大段却什么都没发生，
       比「翻译质量下降」更让人困惑（#14）。 */
    const rect = currentRect();
    if (!rect || (!rect.width && !rect.height)) {
      close();
      return;
    }

    curRect = rect;
    scrollRef = window.scrollY;

    /* 超过上限：不再静默关闭，改为给一条可读的说明。
       分片翻译（一次划词变 N 次计费）按 #14 的裁决不做，只提示 + README 写明。 */
    if (text.length > MAX_LEN) {
      notice(T.t('panel.tooLong', { n: text.length, max: MAX_LEN }));
      return;
    }

    /* 手动模式（#6）：只出一个小图标，点了才翻译。
       放在长度判断**之后** —— 手动模式也会撞上 1000 字符上限，
       而「太长」是更准确的原因，先说出来更省事。 */
    if (cfg.triggerMode === 'manual') {
      showDot(text);
      return;
    }

    /* 技术内容（#60）与真正的发请求都在 go() 里 —— 手动模式走的是同一条路，
       所以两边对「拦不拦」的判断不会分叉。 */
    go(text);
  }

  /* ---------- 事件 ---------- */

  function inPanel(e) {
    return !!(host && e.composedPath && e.composedPath().indexOf(host) !== -1);
  }

  function onScroll() {
    if (!panel || panel.style.display === 'none' || !curRect || rafPending) return;

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!panel || panel.style.display === 'none' || !curRect) return;

      const rect = currentRect();

      if (rect && (rect.width || rect.height)) {
        curRect = rect;
        scrollRef = window.scrollY;
      } else {
        // 选区已被页面清除，按滚动偏移推算浮层位置
        const dy = scrollRef - window.scrollY;
        curRect = {
          top: curRect.top + dy,
          bottom: curRect.bottom + dy,
          left: curRect.left,
          width: curRect.width,
          height: curRect.height
        };
        scrollRef = window.scrollY;
      }

      place();
    });
  }

  /* 注册全部监听 —— 真正「开始工作」的一步。

     ⚠️ 排除站点（#29）下**不会**走到这里，所以这里的每一条监听都必须
     在 boot() 里面注册，不要顺手挪回顶层。
     反过来说：任何将来新增的监听也要放进这个函数，否则排除列表会被绕过。 */
  function boot() {
    if (booted) return;
    booted = true;

    // 系统主题变了要跟着重算（只有「跟随系统」会真的变，重算是幂等的）
    THEME.onChange(applyTheme);

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        Object.keys(changes).forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) cfg[k] = changes[k].newValue;
        });
        applyTheme();
        applySize();
        /* 字号 / 宽度是**当场生效**的（#25 的关闭条件就是「不需要刷新页面」）。
           已经开着的那块浮层要跟着变，而且变了尺寸就得重新定位一次 ——
           否则它可能从「贴在选区下方」变成「压住选区」。 */
        if (panel && panel.style.display !== 'none') place();
        if (cfg.enabled === false) close();
      });
    } catch (e) {
      // 扩展被重新加载后旧脚本会失效，忽略即可
    }

    document.addEventListener('mouseup', (e) => {
      if (cfg.enabled === false) return;
      if (inPanel(e)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(pick, DEBOUNCE);
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (!panel || panel.style.display === 'none') return;
      if (inPanel(e)) return;
      close();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    }, true);

    window.addEventListener('scroll', onScroll, { capture: true, passive: true });

    /* ⚠️ 这里原来是 `close` —— **拖一下窗口、或移动端旋转，浮层就直接没了**（#22）。
       那不是设计，是顺手写的：内容还在、只是位置该重算，凭什么关掉。
       改成重新定位。

       顺便重新取一次选区矩形：窗口尺寸一变，页面会回流，选区的坐标也可能变。
       拿不到选区（用户已经点别处了）就沿用旧坐标 —— 与 onScroll 里的兜底同一个思路。 */
    window.addEventListener('resize', () => {
      if (!panel || panel.style.display === 'none') return;
      const rect = currentRect();
      if (rect) curRect = rect;
      place();
    }, { passive: true });

    /* 切到别的标签页时，有的浏览器会把「正在读的那一句」冻住、`onend` 永远不来，
       于是队列卡死、按钮一直停在「停止」（#10）。回到前台时把看门狗重新计时，
       让「刚才那段时间」不算进超时里。 */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && speaker) speaker.keepAlive();
    });
  }
})();
