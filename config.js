'use strict';

/* 划词翻译 —— 共享配置（DEFAULTS 的单一真源）、档位表与小工具
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

    /* 排除站点（#29）：一行一个域名，命中时不翻译。空字符串 = 所有站点都生效。

       存**原始文本**而不是解析好的数组，有两个理由：
       ① 用户写错的那些行要留在输入框里让他改 —— 解析后丢掉就找不回来了；
       ② 解析规则将来变了（比如支持通配），老配置不用迁移，重新解析一遍就行。
       规则与匹配在 sites.js，设置页的逐行校验读的是同一份。

       ⚠️ 判断只在页面加载时做一次 —— 改完要刷新已打开的标签页（设置页会提示）。 */
    excludeSites: '',

    /* 额度来源：
       'own'  = 使用用户自己的 API Key（当前唯一可用，也是默认值）
       'free' = 平台免费额度（测试中）

       说明：'free' 的 UI 已置灰不可选，后台的分发分支（translateViaPlatform）
       是预留接缝。将来接入托管后端时，只需实现那一个函数，其余文件不用动。 */
    quotaMode: 'own',

    engine: 'deepseek', // deepseek | google

    /* 触发方式（#6）：'auto' 选中即译 | 'manual' 选中只出一个小图标，点了才译。

       默认 auto（**实现 #6 时别顺手改它** —— 手动是给「读长文嫌烦」的人用的，
       对多数人来说多一次点击是净损失）。

       手动模式不只是「少打扰」：自动模式是「先发请求、再被取消」，
       取消发生在请求发出之后，旧请求仍可能已经开始处理。
       手动模式是根本不发 —— 所以它能避免误选时产生请求。 */
    triggerMode: 'auto',

    /* 翻译方向由「一对」语言决定，不是一个。
       只给一个 targetLang 时，「源语言 = 目标语言」就没法处理 ——
       在中文页选中文，会照发一次请求、把原文再回一遍，白花钱还让人以为坏了。

       给了这一对之后：
         检测到 = preferredLang  → 译成 targetLang
         检测到 = targetLang     → 反向译回 preferredLang
         判不出来 / 其他语言     → 译成 targetLang
       ⚠️ 两者不允许相等，否则又退化成「译成同语言」。设置页会拦，后台也有兜底。

       ⚠️ **默认值是「英文 → 中文」（2026-09-24 用户确认）** ——
       主要场景是读英文页面，划词出来中文；反向（选中文 → 英文）是白送的。
       改这两个值之前先想清楚：`background.js` 的 onInstalled 迁移逻辑依赖
       「老配置里那个 targetLang 是**输出语言**」这个前提。 */
    preferredLang: 'en',  // 首选语言：你主要会选中的文字的语言
    targetLang: 'zh',     // 目标语言：你想译成的语言

    /* 界面主题：auto 跟随系统 | light 浅色 | dark 深色
       auto 与改造前的行为完全一致（原先只写了 prefers-color-scheme）。 */
    theme: 'auto',

    /* 界面语言（#35）：'auto' 跟随浏览器 | 'zh' 中文 | 'en' English。

       ⚠️ 存的是**偏好**而不是解析结果 —— 与 panelFont 存档位名同一个理由：
       'auto' 是一个会随时间变的答案（用户换了浏览器语言），
       把它解析成 'zh' 再存下来，用户就永远回不到「跟随」了。

       ⚠️ 默认 'auto'。这与改造前（全中文）**不一致**：浏览器是英文的用户
       装上来就是英文界面。这是 #35 的本意（面向国际用户），
       但它是这一步里唯一一处默认行为的改变，写在这里免得以后当成 bug 查。

       只影响**界面文案**。扩展的名字与商店描述走 `_locales`，
       跟随的是浏览器语言、不受这个开关影响 —— 这个分工是刻意的，
       设置页里也写明了（否则用户会疑惑「界面切成英文了，名字怎么还是中文」）。 */
    uiLang: 'auto',

    /* 浮层的字号与最大宽度（#25）。

       存的是**档位名**而不是像素值 —— 像素值是实现细节，将来想微调某一档时，
       老用户存储里的 'md' 仍然成立；存 '14px' 就得写迁移了。

       字号用四档，用户需要的是「大一点 / 小一点」，不是精确值。
       具体像素值见下面的 FONT_STEPS / WIDTH_STEPS，设置页的滑块按同一张表渲染。 */
    panelFont: 'md',    // sm 10 | md 14 | lg 18 | xl 24
    panelWidth: 'md',   // narrow 320 | md 420 | wide 560

    /* 朗读（#10）—— 用浏览器内置的 speechSynthesis，离线、不花钱、不需要权限。

       speakRate 存档位名（slow / normal / fast），理由与 panelFont 一样。
       具体倍率见下面的 RATE_STEPS。

       speakAccent 只对**英语**有意义：`speechSynthesis` 里 en-US 与 en-GB
       是两套独立的声音（同一台机器上通常都有），所以这是一个真选择。
       'auto' = 交给系统默认（英国机器上就是英式）。
       别的语言下这个设置不起作用 —— 设置页里写明了，免得用户以为坏了。 */
    speakRate: 'normal',   // slow 0.8 | normal 1 | fast 1.25
    speakAccent: 'auto',   // auto 跟随系统 | en-US 美式 | en-GB 英式

    /* 跳过技术内容（#60）：选中代码 / 链接 / 邮箱 / 路径 / 命令行时不发请求。

       默认开。判定规则与阈值在 tech.js 里，是**启发式**的，一定会误伤 ——
       所以浮层上永远有一个「仍然翻译」，这是这个开关能默认开的前提。
       用户嫌误伤多的话，关掉它就完全回到旧行为。 */
    skipTech: true,

    /* 每日翻译次数上限（#19）。0 = 不限制。

       ⚠️ 这个数字**不在设置页上显示**（2026-09-24 用户定的）：
       显示出来，用户会开始跟它谈判（「为什么是 500 不是 1000」）；
       不显示，他只知道「今天用掉几次」和「用满了能调高」——
       上限就从「一个要争的配额」退回成「一道防呆的闸」，这才是它的本意。

       设置页只提供「调高上限」按钮，每点一次 +500，也不回显新值。
       所以改这个默认值时，别顺手把它加到设置页的某个 <span> 里。 */
    quotaDaily: 500,

    deepseekKey: ''
  };

  /* 字号 / 最大宽度的档位表（#25）。

     为什么放在这里、而不是只写在 content.js 的 CSS 旁边：
     设置页的滑块要按**同一张表**渲染。各写一份的话，某天把某一档从 14px
     改成 15px，下拉里会一直写着 14px —— 而且**不会报错**。
     这与 todayKey 是同一类坑：两个地方各存一份「同一个事实」。

     档位名（id）进存储，像素值（px）只用于渲染与 CSS。

     ⚠️ **这里没有 name 字段**（#39）：显示名（小 / 中 / 大 / 窄 / 宽）在
     strings.js 里按 `step.<id>` 取。留在这里的话，它就是一个「只在中文下正确」
     的硬编码 —— 界面切成英文时下拉会显示成「Small（13px）」里的中文，
     而且不会报错。 */
  const FONT_STEPS = [
    { id: 'sm', px: 10 },
    { id: 'md', px: 14 },
    { id: 'lg', px: 18 },
    { id: 'xl', px: 24 }
  ];

  const WIDTH_STEPS = [
    { id: 'narrow', px: 320 },
    { id: 'md', px: 420 },
    { id: 'wide', px: 560 }
  ];

  /* 朗读语速档位（#10）。倍率直接给 `SpeechSynthesisUtterance.rate`。

     为什么只给三档、不做滑块：朗读「听个发音」的场景里，用户要的是
     「慢一点 / 快一点」，不是 0.05 的精度；滑块还会让设置页多一个控件，
     而这个控件 99% 的时间没人碰。 */
  const RATE_STEPS = [
    { id: 'slow', rate: 0.8 },
    { id: 'normal', rate: 1 },
    { id: 'fast', rate: 1.25 }
  ];

  /* 按档位名取某个字段。认不出的值（老配置、手改的存储、将来删掉的档）
     优先退回 md / normal 这类明确的默认档；没有明确默认档时才取中间位置。 */
  function stepOf(list, id, key) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i][key];
    }
    const fallback = list.find((s) => s.id === 'md')
      || list.find((s) => s.id === 'normal')
      || list[Math.floor((list.length - 1) / 2)];
    return fallback[key];
  }

  const stepPx = (list, id) => stepOf(list, id, 'px');

  /* 用量按「本地日期」分桶，键是 YYYY-MM-DD（#18 / #19）。

     ⚠️ 这个函数**必须两边共用** —— 它定义了 `usage.byDay` 的键格式，
     也就是 background.js（写入方）与 options.js（读取方）之间的数据契约。
     各写一份的话，格式一旦不同，设置页会一直显示「今日 0 次」，
     而且**不会报错** —— 这是最难查的一类问题。
     放在这里，是因为 config.js 是四个宿主都会加载的那个文件。 */
  function todayKey(d) {
    const t = d || new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  const api = {
    DEFAULTS, todayKey,
    FONT_STEPS, WIDTH_STEPS, RATE_STEPS, stepPx,
    /* 朗读语速：档位名 → 倍率。与 stepPx 同一个「认不出就退回中间档」的策略。 */
    stepRate: (id) => stepOf(RATE_STEPS, id, 'rate')
  };

  root.WT_CONFIG = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
