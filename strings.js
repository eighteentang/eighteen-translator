'use strict';

/* 划词翻译 —— 用户可见文案的单一真源（#39）
   ────────────────────────────────────────────────────────────────
   为什么单独拆一个文件：
   文案原先散在 6 个地方（background.js / content.js / popup.html /
   options.html / config.js 的档位名 / tech.js 的类别名）。改一句话要翻六个文件，
   漏一处就是「同一件事有两种说法」，而且**不会报错**。
   更关键的是：它是 #35（界面多语言）的前置 —— 没有这一步，多语言只能到处打补丁。

   双模式加载（同 config.js）：
   - MV3 service worker   → importScripts('strings.js')
   - content script       → manifest 的 content_scripts.js 里排在 content.js 之前
   - 设置页 / 弹层        → <script src="strings.js">
   - Node（dev/selftest.js）→ require('./strings.js')

   ⚠️ **不引任何 i18n 库**。零依赖是刻意的：这点功能不值得引一个依赖。

   ⚠️ 为什么不用 chrome.i18n + _locales 做界面文案：
   那条路只能跟随**浏览器语言**，用户无法手动切换（#35 要求可手动切）。
   `_locales` 只用来解决 manifest 里 name / description 的本地化（#56）——
   那两行**没法由 JS 改**，是唯一必须走 _locales 的地方。
*/

(function (root) {
  'use strict';

  /* ---------- 文案表 ----------
     键名用「域.名字」，域与文件对应（panel = content.js 的浮层，opt = 设置页…）。
     ⚠️ 两张表的**键必须完全一致** —— 少一个键不会报错，只会静默回退成中文，
     表现是「英文界面里冒出一句中文」。selftest 里有一条断言钉死这件事。

     插值用 {name}；⚠️ 值不做 HTML 转义（见 applyI18n 那段关于 innerHTML 的说明），
     所以**用户数据绝不能**通过 vars 传进来。 */
  const STRINGS = {
    zh: {
      'ext.name': '划词翻译',

      // ---- 引擎名（浮层右上角的标签）----
      'engine.google': 'Google 翻译',
      'engine.deepseek': 'DeepSeek',
      'engine.fallback': '翻译',
      // 句子中间的说法（「X 偶尔需要几秒」）—— 和标签上那个「翻译」不是一回事
      'engine.any': '引擎',

      // ---- 浮层（content.js）----
      'panel.loading': '翻译中',
      'panel.slow': '比平时慢一些，{engine} 偶尔需要几秒，请稍候。',
      'panel.copy': '复制',
      'panel.copied': '已复制',
      'panel.copyFail': '复制失败',
      'panel.close': '关闭',
      /* 朗读（#10）。只有一个朗读译文的图标按钮，读的过程中变成停止图标；
         title / aria-label 仍然需要这两条文案。 */
      'panel.readOut': '朗读译文',
      'panel.readOriginal': '朗读原文',
      'panel.stopRead': '停止',
      'panel.noVoice': '这台设备没有可用的语音包，朗读不可用',
      'panel.noVoiceLang': '没有{lang}的语音包',
      'panel.readFail': '朗读失败',
      'panel.altIdle': '译成…',
      'panel.altTo': '译成{lang}',
      'panel.reversedTag': '{base} · 反向',
      'panel.dot': '译',
      'panel.dotTitle': '翻译选中的文字',
      'panel.skipped': '这看起来是{kind}，已跳过翻译。',
      'panel.force': '仍然翻译',
      'panel.retry': '重试',
      'panel.goSettings': '去设置',
      'panel.fail': '翻译失败',
      'panel.stale': '扩展未就绪，请到 chrome://extensions 重新加载本扩展，然后刷新页面',
      'panel.gone': '扩展上下文已失效，请刷新页面',
      'panel.tooLong': '选中了 {n} 个字符，超过 {max} 的上限，未翻译。请缩短选区后重试。',

      // ---- 技术内容类别（tech.js 判定，这里只放名字）----
      'tech.url': '一个链接',
      'tech.mail': '一个邮箱地址',
      'tech.path': '一个文件路径',
      'tech.code': '一段代码',
      'tech.shell': '一条命令行',
      'tech.other': '技术内容',

      // ---- 后台返回的错误（background.js）----
      'err.quota': '今日翻译次数已用完。到设置页的「用量」里可以调高上限。',
      'err.google429': 'Google 免费接口返回 429（请求过多）。这是公共接口对共享 IP 的限流，'
        + '换个代理节点可能恢复，或到设置页改用 DeepSeek 引擎',
      'err.googleHttp': 'Google 接口返回 HTTP {status}'
        + '（若在中国大陆，请确认代理已开启且浏览器走代理）',
      'err.googleEmpty': 'Google 接口返回内容为空',
      'err.noKey': '尚未填写 DeepSeek API Key，请到设置页填写',
      'err.dsParse': 'DeepSeek 返回了无法解析的内容（HTTP {status}）',
      'err.dsError': 'DeepSeek 报错：{msg}',
      'err.dsEmpty': 'DeepSeek 返回内容为空',
      'err.platform': '平台免费额度正在测试中，尚未开放。请到设置页改用「使用自己的 API Key」',
      'err.cancelled': '这次翻译已被取消',
      'err.unknown': '未知错误',
      'err.timeout': '请求超时，请检查网络或代理',
      'err.network': '网络请求失败：可能是网络不通、代理未开启，或该接口域名被拦截',
      'err.emptyText': '没有可翻译的内容',

      // ---- 语言名（lang.js 的 code → 显示名）（#9）----
      // ⚠️ 每加一门语言（lang.js 的 LANGS）都要在这里补一行，
      //    否则下拉里显示的是键名本身（'lang.xx'），而且不会报错。
      'lang.zh': '中文',
      'lang.zh-Hant': '繁体中文',
      'lang.en': '英文',
      'lang.ja': '日文',
      'lang.ko': '韩文',
      'lang.fr': '法文',
      'lang.de': '德文',
      'lang.es': '西班牙文',
      'lang.ru': '俄文',
      'lang.ar': '阿拉伯文',
      'lang.th': '泰文',

      // ---- 档位名（config.js 的 FONT_STEPS / WIDTH_STEPS）----
      'step.sm': '小',
      'step.md': '中',
      'step.lg': '大',
      'step.xl': '特大',
      'step.narrow': '窄',
      'step.wide': '宽',
      // 朗读语速档位（#10，config.js 的 RATE_STEPS）
      'step.slow': '慢',
      'step.normal': '正常',
      'step.fast': '快',

      // ---- 开发期守卫（不是给用户看的，但也不该散落在源码里）----
      'dev.moduleMissing': '{name} 未加载：请确认 manifest 的 service_worker 与自测脚本都已先加载它',

      // ---- 工具栏弹层（popup.html / popup.js）----
      'pop.title': '划词翻译',
      'pop.enabled': '启用划词翻译',
      'pop.enabledDesc': '关闭后所有网页都不再触发',
      'pop.siteOff': '在此域名不可用',
      'pop.siteNoHost': '这个页面用不了（浏览器内置页面，或页面还没加载完）',
      'pop.siteOffDesc': '{host} 上不触发划词翻译',
      'pop.siteCovered': '{host} 被列表里的「{rule}」覆盖',
      'pop.themeTo': '切换到{name}模式',
      /* 语言快捷按钮（#35 第 3 步）的提示文字。
         ⚠️ 只是 title / aria-label —— 按钮上**看得见**的那个字（EN / CN）
         刻意不走 t()，见 popup.js 里的注释：它一跟着翻译就会自指。 */
      'pop.langTo': '切换到{lang}界面',
      'theme.light': '浅色',
      'theme.dark': '深色',
      'pop.warnNoKey': '还没填 DeepSeek API Key —— 划词不会出结果。请到「完整设置」里填写。',
      'pop.on': '已开启划词翻译',
      'pop.off': '已关闭划词翻译',
      'pop.noHost': '拿不到这个页面的域名，请刷新页面后重试',
      'pop.siteAdded': '已在这个域名上关闭 —— 刷新页面后生效',
      'pop.siteRemoved': '已恢复 —— 刷新页面后生效',
      'pop.noExt': '当前不在扩展环境中',
      'pop.options': '完整设置',
      'pop.trigger': '触发方式',
      'pop.auto': '自动',
      'pop.manual': '手动',
      'pop.triggerAuto': '自动翻译',
      'pop.triggerManual': '手动确认',
      'pop.triggerAutoDesc': '选中后自动翻译',
      'pop.triggerManualDesc': '选中后点击图标翻译',
      'pop.target': '目标语言',
      'pop.targetDesc': '快速调整翻译成什么语言',
      'pop.targetSaved': '目标语言已切换为{lang}',
      'pop.usageToday': '今日已翻译',
      'pop.usageTodayDesc': '按本机日期统计',
      'pop.saveFail': '保存失败：{msg}',
      'pop.readFail': '读取配置失败：{msg}',

      // ---- 设置页（options.html / options.js）----
      'opt.title': '划词翻译 · 设置',
      'opt.h1': '划词翻译',
      'opt.sub': '在任意网页选中文字，松开鼠标即可看到译文。',
      'opt.banner': '首次使用请先选好引擎：DeepSeek 需要填 API Key，Google 免费接口无需任何配置。',

      'opt.enabled': '启用划词翻译',
      'opt.enabledDesc': '关闭后所有网页都不再触发',
      'opt.navGeneral': '常规',
      'opt.navTranslation': '翻译',
      'opt.navAppearance': '外观',
      'opt.navUsage': '用量',
      'opt.navSites': '站点',

      'opt.secMode': '服务模式',
      'opt.ownKey': '使用自己的 API Key',
      'opt.badgeDefault': '默认',
      'opt.ownKeyHint': '需自行申请并配置凭据',
      'opt.free': '平台免费额度',
      'opt.badgeTesting': '测试中',
      'opt.freeHint': '无需任何配置，装上即用 —— 尚未开放',
      'opt.freeNote': '平台免费额度由本扩展的服务端代付，目前仍在测试、暂未开放。'
        + '在此之前请使用自己的 API Key。',

      'opt.secEngine': '翻译引擎',
      'opt.badgeRecommended': '推荐',
      'opt.dsHint': '需 API Key。能结合语境翻译，适合长句与技术内容',
      'opt.googleName': 'Google 免费接口',
      'opt.googleHint': '零配置。公共接口对共享 IP 限流严格，可能需要代理；国内网络建议用 DeepSeek',

      'opt.secKey': 'DeepSeek 凭据',
      'opt.keyLabel': 'API Key',
      'opt.show': '显示',
      'opt.hide': '隐藏',
      'opt.showAria': '显示 API Key',
      'opt.hideAria': '隐藏 API Key',
      'opt.keyNote': '在 DeepSeek 开放平台创建 API Key，并按平台要求完成账户配置后使用。',
      'opt.keyNote2': '本插件无云端存储，本地电脑请自行保管。'
        + '<br>（Key 以<b>明文</b>存在本机浏览器的扩展存储里，不加密、不上传 —— '
        + '能读到浏览器配置目录的人就能看到。上面那个「显示 / 隐藏」只是遮住屏幕，不是加密。）',

      'opt.secDir': '翻译方向',
      'opt.preferred': '首选语言',
      'opt.preferredDesc': '你主要会选中的文字',
      'opt.target': '目标语言',
      'opt.targetDesc': '你想译成的语言',
      'opt.dirNote': '选中<b>首选语言</b>时，译成目标语言；选中<b>目标语言</b>时，反向译回首选语言。'
        + '判不出语言、或文本太短时，一律按目标语言处理。'
        + '语言是自动认的，认错时浮层上有一个「译成 X」，点一下就能换方向。',
      'opt.langSame': '首选语言与目标语言不能相同 —— 那样等于不翻译。请改成两种不同的语言。',

      'opt.secLang': '界面语言',
      'opt.uiLangLabel': '语言',
      'opt.uiLangDesc': '设置页、弹层与浮层提示的语言',
      'opt.uiLangAuto': '跟随浏览器',
      'opt.uiLangNote': '这里只切<b>界面文案</b>。扩展在浏览器里的<b>名字与商店描述</b>'
        + '走的是另一套机制（<code>_locales</code>），跟随浏览器语言 —— '
        + '所以可能出现「界面是英文、扩展名字还是中文」。'
        + '<br>这与上面「翻译方向」的语言是两回事：那里选的是<b>翻译成什么</b>，'
        + '这里选的是<b>按钮和说明用什么语言写</b>。'
        + '<br>工具栏弹层右上角那个 <code>EN</code> / <code>CN</code> 按钮是同一个开关的快捷方式。',

      'opt.secTheme': '界面主题',
      'opt.themeLabel': '主题',
      'opt.themeAuto': '跟随系统',
      'opt.themeLight': '浅色',
      'opt.themeDark': '深色',
      'opt.themeNote': '工具栏弹层右上角还有一个快捷按钮，点一下就在浅色 / 深色之间切换。'
        + '想回到「跟随系统」，回到这里选。',

      'opt.secPanel': '浮层外观',
      'opt.fontLabel': '字号',
      'opt.fontDesc': '译文正文的大小',
      'opt.widthLabel': '最大宽度',
      'opt.widthDesc': '长句多时调宽，窄窗口下调窄',
      'opt.stepOption': '{name}（{px}px）',
      'opt.panelNote': '改完<b>立即生效</b>，不用点保存、也不用刷新已经打开的网页 —— 浮层当场就是新尺寸。'
        + '<br>宽度是<b>上限</b>而不是固定值：短句的浮层仍然是紧凑的，只有长句才会撑到这一档。',

      'opt.secSpeak': '朗读',
      'opt.speakRate': '语速',
      'opt.speakRateDesc': '朗读快慢，改完立即生效',
      'opt.speakAccent': '英语口音',
      'opt.speakAccentDesc': '只影响英语朗读',
      'opt.accentAuto': '跟随系统',
      'opt.accentUS': '美式英语',
      'opt.accentGB': '英式英语',
      'opt.speakNote': '朗读用的是浏览器<b>自带</b>的语音合成：离线、不上传，也不需要任何额外配置。'
        + '<br>⚠️ 音色由系统决定，各台机器不一样；装没装语音包也由系统决定。'
        + '没有可用语音包时，浮层上的朗读按钮会说明原因，不会静默失败。'
        + '<br>⚠️ 英语口音这一项<b>只对英语生效</b> —— 别的语言没有这个区分，选了也不起作用。',

      'opt.secUsage': '用量',
      'opt.usageToday': '今日已翻译',
      'opt.usageTodayDesc': '按本机日期统计请求次数',
      'opt.quota': '每日上限',
      'opt.quotaDesc': '到上限后当天不再发请求，避免误操作刷掉额度',
      'opt.quotaFull': '今天已经到上限了 —— 点右边按钮即可继续',
      'opt.raise': '调高上限',
      'opt.cache': '译文缓存',
      'opt.cacheDesc': '缓存译文，同样的内容不再重复请求引擎',
      'opt.cacheCount': '已缓存 {n} 条，命中时不再请求引擎',
      'opt.clearCache': '清空缓存',
      'opt.usageNote': '上限是一道<b>防误触保护</b>：反复划同一个词、或网页脚本误触发时，'
        + '它会先挡住重复请求。真到上限了，点「调高上限」即可继续。',

      'opt.secTech': '跳过技术内容',
      'opt.skipTech': '跳过代码 / 链接 / 邮箱 / 路径 / 命令行',
      'opt.skipTechDesc': '选中这类内容时不发请求',
      'opt.techNote': '读技术文档时随手选到一段代码、一个 URL，翻出来只是把原文回一遍 —— 既多余又干扰。'
        + '打开这一项后，这类内容不发请求，浮层会说明<b>拦的是什么</b>，并且始终给一个「仍然翻译」。'
        + '<br>只在<b>短于 200 字符</b>的选区上判定：长文里夹一行代码时跳过整段，才是真正的误伤。'
        + '嫌误伤多就关掉它，完全回到旧行为。',

      'opt.secTrigger': '触发方式',
      'opt.auto': '自动',
      'opt.autoHint': '选中文字、松开鼠标就翻译',
      'opt.manual': '手动',
      'opt.manualHint': '选中后只在旁边出一颗小圆点，点它才翻译',
      'opt.triggerNote': '读长文时自动翻译容易被误触发，而每一次误触发都会真的发一次请求。'
        + '手动模式多一次点击，但<b>一次误触发的请求都不会发</b> —— '
        + '自动模式是「先发出去、再取消」，手动模式可以避免这类请求。',

      'opt.secSites': '排除站点',
      'opt.sitesLabel': '在这些域名上不翻译（一行一个）',
      'opt.sitesEmpty': '留空表示所有站点都生效',
      'opt.sitesCount': '已排除 {n} 个域名',
      'opt.sitesBad': '有 {n} 行没看懂，不会生效：',
      'opt.sitesBadLine': '第 {line} 行「{text}」',
      'opt.sitesBadHint': '。请写域名（example.com）或 *.example.com；不支持正则，* 只能写在最前面。',
      'opt.listSep': '、',
      'opt.sitesNote': '写域名就行：<code>example.com</code> 会连 <code>a.example.com</code> 一起排除。'
        + '直接粘贴网址也可以，会自动去掉 <code>https://</code> 与后面的路径。'
        + '以 <code>#</code> 开头的行是备注。'
        + '<br>⚠️ <b>改完要刷新已打开的标签页</b> —— 判断只在页面加载时做一次，'
        + '这正是它几乎不花性能的原因。'
        + '<br>想让<b>所有</b>站点都不生效，请用最上面的总开关，不要在这里写 <code>*</code>。',

      'opt.localOnly': '以上配置（含 API Key）<b>只存在本机</b>，不随浏览器账号同步 —— '
        + '换设备需要重新填写。',
      'opt.save': '保存',
      'opt.test': '测试当前引擎',
      'opt.saved': '已保存',
      'opt.savedRefreshOn': '已保存 —— 请刷新已打开的标签页生效',
      'opt.savedRefreshOff': '已保存 —— 排除列表已清空，刷新页面后恢复翻译',
      'opt.saveFail': '保存失败：{msg}',
      'opt.testing': '正在测试…',
      'opt.testOk': '测试通过：{text}',
      'opt.testFail': '测试失败：{msg}',
      'opt.noExtSave': '当前不在扩展环境中，无法保存',
      'opt.noExtTest': '当前不在扩展环境中，无法测试',
      'opt.noExtOp': '当前不在扩展环境中，无法操作',
      'opt.langSameErr': '首选语言与目标语言不能相同',
      'opt.translateFail': '翻译失败',
      'opt.themeSwitched': '主题已切换',
      'opt.quotaNoLimit': '当前未设置每日上限，无需调高',
      'opt.quotaRaised': '上限已调高，可以继续翻译了',
      'opt.cacheCleared': '缓存已清空',
      'opt.clearFail': '清空失败：{msg}',
      'opt.copyFail': '复制失败：{msg}',
      'opt.diagCopied': '诊断信息已复制，粘贴到 issue 里即可',
      'opt.diag': '复制诊断信息',

      /* 「复制诊断信息」（#59）里每一行的标签。
         ⚠️ 它也要走 i18n —— 这几行是**用户看得见**的（复制前会显示在状态条上，
         粘进 issue 后也是他在看）。留成中文字面量的话，英文界面的用户
         复制出来的是一份中英混排的东西。 */
      'opt.diagUnknownBrowser': '未知浏览器',
      'opt.diagUnknownOs': '未知系统',
      'opt.diagSet': '已填写',
      'opt.diagUnset': '未填写',
      'opt.diagOn': '是',
      'opt.diagOff': '否',
      'opt.diagSkipOn': '开',
      'opt.diagSkipOff': '关',
      'opt.diagEngine': '引擎: {engine} · API Key: {key}',
      'opt.diagDir': '翻译方向: {from} → {to}',
      'opt.diagTheme': '主题: {theme} · 服务模式: {mode} · 启用: {on}',
      'opt.diagTrigger': '触发: {trigger} · 跳过技术内容: {skip}',
      'opt.diagPanel': '浮层: 字号 {font} · 宽度 {width}',
      'opt.diagSites': '排除站点: {n} 个',
      'opt.diagUsed': '今日已用: {n} 次',

      'opt.feedback': '反馈建议 ↗'
    },

    en: {
      'ext.name': 'Eighteen Translator',

      'engine.google': 'Google Translate',
      'engine.deepseek': 'DeepSeek',
      'engine.fallback': 'Translation',
      'engine.any': 'the engine',

      'panel.loading': 'Translating',
      'panel.slow': 'Slower than usual — {engine} sometimes takes a few seconds.',
      'panel.copy': 'Copy',
      'panel.copied': 'Copied',
      'panel.copyFail': 'Copy failed',
      'panel.close': 'Close',
      'panel.readOut': 'Read translation',
      'panel.readOriginal': 'Read original',
      'panel.stopRead': 'Stop',
      'panel.noVoice': 'No speech voices are available on this device',
      'panel.noVoiceLang': 'No {lang} voice is installed',
      'panel.readFail': 'Could not read aloud',
      'panel.altIdle': 'Translate to…',
      'panel.altTo': 'To {lang}',
      'panel.reversedTag': '{base} · reverse',
      'panel.dot': 'T',
      'panel.dotTitle': 'Translate the selected text',
      'panel.skipped': 'This looks like {kind}, so it was skipped.',
      'panel.force': 'Translate anyway',
      'panel.retry': 'Retry',
      'panel.goSettings': 'Open settings',
      'panel.fail': 'Translation failed',
      'panel.stale': 'Extension not ready. Reload it at chrome://extensions, then refresh this page.',
      'panel.gone': 'The extension context is gone. Please refresh this page.',
      'panel.tooLong': 'Selected {n} characters — over the {max} limit, so nothing was translated. '
        + 'Shorten the selection and try again.',

      'tech.url': 'a link',
      'tech.mail': 'an email address',
      'tech.path': 'a file path',
      'tech.code': 'a piece of code',
      'tech.shell': 'a command line',
      'tech.other': 'technical content',

      'err.quota': "You've hit today's translation limit. "
        + 'You can raise it under "Usage" in the settings.',
      'err.google429': 'The free Google endpoint returned 429 (too many requests). '
        + 'This public endpoint rate-limits shared IPs. Try another proxy node, '
        + 'or switch to the DeepSeek engine in the settings.',
      'err.googleHttp': 'The Google endpoint returned HTTP {status}. '
        + '(In mainland China, make sure your proxy is on and that the browser actually uses it.)',
      'err.googleEmpty': 'The Google endpoint returned an empty result',
      'err.noKey': 'No DeepSeek API key yet — add one in the settings',
      'err.dsParse': "DeepSeek returned something we couldn't parse (HTTP {status})",
      'err.dsError': 'DeepSeek error: {msg}',
      'err.dsEmpty': 'DeepSeek returned an empty result',
      'err.platform': 'The free platform quota is still in testing and not open yet. '
        + 'Please switch to "Use your own API key" in the settings.',
      'err.cancelled': 'This translation was cancelled',
      'err.unknown': 'Unknown error',
      'err.timeout': 'The request timed out — check your network or proxy',
      'err.network': 'The request failed: the network may be down, the proxy may be off, '
        + 'or the endpoint domain may be blocked',
      'err.emptyText': 'Nothing to translate',

      'lang.zh': 'Chinese',
      'lang.zh-Hant': 'Chinese (Traditional)',
      'lang.en': 'English',
      'lang.ja': 'Japanese',
      'lang.ko': 'Korean',
      'lang.fr': 'French',
      'lang.de': 'German',
      'lang.es': 'Spanish',
      'lang.ru': 'Russian',
      'lang.ar': 'Arabic',
      'lang.th': 'Thai',

      'step.sm': 'Small',
      'step.md': 'Medium',
      'step.lg': 'Large',
      'step.xl': 'Extra large',
      'step.narrow': 'Narrow',
      'step.wide': 'Wide',
      'step.slow': 'Slow',
      'step.normal': 'Normal',
      'step.fast': 'Fast',

      'dev.moduleMissing': '{name} was not loaded: make sure both the manifest service_worker '
        + 'and the self-test load it first',

      'pop.title': 'Eighteen Translator',
      'pop.enabled': 'Enable select-to-translate',
      'pop.enabledDesc': 'When off, nothing triggers on any page',
      'pop.siteOff': 'Disable on this site',
      'pop.siteNoHost': "Not available here (a browser page, or the page hasn't finished loading)",
      'pop.siteOffDesc': "Won't trigger on {host}",
      'pop.siteCovered': '{host} is covered by "{rule}" in the list',
      'pop.themeTo': 'Switch to {name} mode',
      'pop.langTo': 'Switch the interface to {lang}',
      'theme.light': 'light',
      'theme.dark': 'dark',
      'pop.warnNoKey': 'No DeepSeek API key yet — nothing will be translated. '
        + 'Add one under "Full settings".',
      'pop.on': 'Select-to-translate is on',
      'pop.off': 'Select-to-translate is off',
      'pop.noHost': "Couldn't get this page's domain — refresh the page and try again",
      'pop.siteAdded': 'Disabled on this domain — refresh the page to apply',
      'pop.siteRemoved': 'Re-enabled — refresh the page to apply',
      'pop.noExt': 'Not running inside the extension',
      'pop.options': 'Full settings',
      'pop.trigger': 'Trigger mode',
      'pop.auto': 'Auto',
      'pop.manual': 'Manual',
      'pop.triggerAuto': 'Automatic',
      'pop.triggerManual': 'Manual',
      'pop.triggerAutoDesc': 'Translate as soon as you select text',
      'pop.triggerManualDesc': 'Select text, then click the icon',
      'pop.target': 'Target language',
      'pop.targetDesc': 'Quickly choose what to translate into',
      'pop.targetSaved': 'Target language changed to {lang}',
      'pop.usageToday': 'Translated today',
      'pop.usageTodayDesc': 'Counted by local date',
      'pop.saveFail': 'Save failed: {msg}',
      'pop.readFail': 'Failed to read the settings: {msg}',

      'opt.title': 'Eighteen Translator · Settings',
      'opt.h1': 'Eighteen Translator',
      'opt.sub': 'Select text on any page and release the mouse to see the translation.',
      'opt.banner': 'Pick an engine first: DeepSeek needs an API key, '
        + "while Google's free endpoint needs no setup at all.",

      'opt.enabled': 'Enable select-to-translate',
      'opt.enabledDesc': 'When off, nothing triggers on any page',
      'opt.navGeneral': 'General',
      'opt.navTranslation': 'Translation',
      'opt.navAppearance': 'Appearance',
      'opt.navUsage': 'Usage',
      'opt.navSites': 'Sites',

      'opt.secMode': 'Service mode',
      'opt.ownKey': 'Use your own API key',
      'opt.badgeDefault': 'default',
      'opt.ownKeyHint': 'You apply for the credentials and pay for usage',
      'opt.free': 'Free platform quota',
      'opt.badgeTesting': 'in testing',
      'opt.freeHint': 'No setup at all — not open yet',
      'opt.freeNote': 'The free quota is paid for by this extension’s server and is still in '
        + 'testing. Until then, please use your own API key.',

      'opt.secEngine': 'Translation engine',
      'opt.badgeRecommended': 'recommended',
      'opt.dsHint': 'Needs an API key. Context-aware; useful for long and technical text',
      'opt.googleName': 'Google (free endpoint)',
      'opt.googleHint': 'No setup. This public endpoint rate-limits shared IPs and may need a proxy; '
        + 'on mainland China networks, use DeepSeek instead',

      'opt.secKey': 'DeepSeek credentials',
      'opt.keyLabel': 'API Key',
      'opt.show': 'Show',
      'opt.hide': 'Hide',
      'opt.showAria': 'Show API key',
      'opt.hideAria': 'Hide API key',
      'opt.keyNote': 'Create an API key on the DeepSeek platform and complete the account setup required there.',
      'opt.keyNote2': 'This extension has no cloud storage — keep the key safe on your own machine.'
        + '<br>(The key is stored <b>in plain text</b> in this browser’s extension storage: '
        + 'not encrypted, never uploaded. Anyone who can read your browser profile can read it. '
        + 'The "Show / Hide" button only covers the screen; it is not encryption.)',

      'opt.secDir': 'Translation direction',
      'opt.preferred': 'Preferred language',
      'opt.preferredDesc': 'The language you usually select',
      'opt.target': 'Target language',
      'opt.targetDesc': 'The language you want to read',
      'opt.dirNote': 'Select the <b>preferred language</b> → you get the target language. '
        + 'Select the <b>target language</b> → it translates back to the preferred one. '
        + 'When the language cannot be detected, or the text is too short, the target language is used. '
        + 'The language is detected automatically — if it guesses wrong, the panel has a '
        + '"Translate to X" button to switch direction on the spot.',
      'opt.langSame': 'The preferred and target languages must differ — '
        + 'otherwise there is nothing to translate.',

      'opt.secLang': 'Interface language',
      'opt.uiLangLabel': 'Language',
      'opt.uiLangDesc': 'The language of this page, the popup and the on-page panel',
      'opt.uiLangAuto': 'Follow the browser',
      'opt.uiLangNote': 'This only switches the <b>interface text</b>. The extension’s '
        + '<b>name and store description</b> go through a different mechanism '
        + '(<code>_locales</code>) and follow the browser language — so you may see an '
        + 'English interface with a Chinese extension name.'
        + '<br>This is separate from the languages under “Translation direction”: '
        + 'those decide <b>what to translate into</b>, this one decides '
        + '<b>what language the buttons and notes are written in</b>.'
        + '<br>The <code>EN</code> / <code>CN</code> button in the toolbar popup is a shortcut for this same setting.',

      'opt.secTheme': 'Appearance',
      'opt.themeLabel': 'Theme',
      'opt.themeAuto': 'Follow system',
      'opt.themeLight': 'Light',
      'opt.themeDark': 'Dark',
      'opt.themeNote': 'The toolbar popup has a shortcut button that flips between light and dark. '
        + 'To go back to "Follow system", choose it here.',

      'opt.secPanel': 'Panel size',
      'opt.fontLabel': 'Font size',
      'opt.fontDesc': 'Size of the translated text',
      'opt.widthLabel': 'Max width',
      'opt.widthDesc': 'Wider for long sentences, narrower in small windows',
      'opt.stepOption': '{name} ({px}px)',
      'opt.panelNote': 'Takes effect <b>immediately</b> — no need to save, and no need to reload '
        + 'open pages: the panel is already the new size.'
        + '<br>The width is a <b>maximum</b>, not a fixed value: short translations stay compact, '
        + 'only long ones reach it.',

      'opt.secSpeak': 'Read aloud',
      'opt.speakRate': 'Speaking rate',
      'opt.speakRateDesc': 'How fast it reads; takes effect immediately',
      'opt.speakAccent': 'English accent',
      'opt.speakAccentDesc': 'Affects English only',
      'opt.accentAuto': 'Follow system',
      'opt.accentUS': 'American English',
      'opt.accentGB': 'British English',
      'opt.speakNote': 'Read-aloud uses the browser’s <b>built-in</b> speech synthesis: '
        + 'offline, nothing uploaded, and no setup required.'
        + '<br>⚠️ The voice itself comes from your system, so it differs between machines — '
        + 'and so does whether any voices are installed at all. When none is available, '
        + 'the button in the panel says so instead of failing silently.'
        + '<br>⚠️ The accent setting applies to <b>English only</b> — other languages have no '
        + 'such distinction, and the setting does nothing for them.',

      'opt.secUsage': 'Usage',
      'opt.usageToday': 'Translated today',
      'opt.usageTodayDesc': 'Counted by local date as request calls',
      'opt.quota': 'Daily limit',
      'opt.quotaDesc': 'Once reached, no more requests go out today',
      'opt.quotaFull': "Today's limit is reached — click the button to continue",
      'opt.raise': 'Raise limit',
      'opt.cache': 'Translation cache',
      'opt.cacheDesc': "Caches translations so identical text isn't sent twice",
      'opt.cacheCount': '{n} entries cached; hits skip the engine',
      'opt.clearCache': 'Clear cache',
      'opt.usageNote': 'The limit is a <b>safety catch</b>: it stops repeated requests caused by '
        + 'selecting the same text or by a page script misfiring. If you do hit it, click "Raise limit" and carry on.',

      'opt.secTech': 'Skip technical content',
      'opt.skipTech': 'Skip code / links / emails / paths / commands',
      'opt.skipTechDesc': 'No request is sent for these',
      'opt.techNote': 'While reading docs you often select a snippet of code or a URL, and the '
        + 'result is just the original text back and gets in the way. With this on, '
        + 'no request is sent and the panel says <b>what</b> was caught, always offering '
        + '"Translate anyway".'
        + '<br>It only applies to selections <b>shorter than 200 characters</b>: skipping a whole '
        + 'long paragraph because it contains one line of code would be the real false positive. '
        + 'Turn it off if that happens too often.',

      'opt.secTrigger': 'Trigger',
      'opt.auto': 'Automatic',
      'opt.autoHint': 'Translates as soon as you release the mouse',
      'opt.manual': 'Manual',
      'opt.manualHint': 'Shows a small dot; nothing is sent until you click it',
      'opt.triggerNote': 'While reading long texts, automatic mode misfires easily — and every '
        + 'misfire really does send a request. Manual mode needs one click, but <b>sends nothing '
        + 'on a misfire</b>: automatic mode fires first and cancels after.',

      'opt.secSites': 'Excluded sites',
      'opt.sitesLabel': "Don't translate on these domains (one per line)",
      'opt.sitesEmpty': 'Empty means every site works',
      'opt.sitesCount': '{n} domains excluded',
      'opt.sitesBad': "{n} line(s) couldn't be parsed and won't apply: ",
      'opt.sitesBadLine': 'line {line} "{text}"',
      'opt.sitesBadHint': '. Write a domain (example.com) or *.example.com; '
        + "regular expressions aren't supported and * may only appear at the start.",
      'opt.listSep': ', ',
      'opt.sitesNote': 'Just write the domain: <code>example.com</code> also excludes '
        + '<code>a.example.com</code>. Pasting a full URL is fine too — <code>https://</code> '
        + 'and the path are stripped. Lines starting with <code>#</code> are comments.'
        + '<br>⚠️ <b>Refresh open tabs after changing this</b> — the check runs once per page load, '
        + 'which is exactly why it does not make a network request.'
        + '<br>To disable the extension <b>everywhere</b>, use the main switch at the top instead '
        + 'of writing <code>*</code> here.',

      'opt.localOnly': 'All of the above (including the API key) is stored <b>on this machine only</b> '
        + 'and is not synced with your browser account — you will need to re-enter it on another device.',
      'opt.save': 'Save',
      'opt.test': 'Test the current engine',
      'opt.saved': 'Saved',
      'opt.savedRefreshOn': 'Saved — refresh open tabs to apply',
      'opt.savedRefreshOff': 'Saved — the exclusion list is empty now; refresh to re-enable',
      'opt.saveFail': 'Save failed: {msg}',
      'opt.testing': 'Testing…',
      'opt.testOk': 'Test passed: {text}',
      'opt.testFail': 'Test failed: {msg}',
      'opt.noExtSave': 'Not running inside the extension — cannot save',
      'opt.noExtTest': 'Not running inside the extension — cannot test',
      'opt.noExtOp': 'Not running inside the extension',
      'opt.langSameErr': 'The preferred and target languages must differ',
      'opt.translateFail': 'Translation failed',
      'opt.themeSwitched': 'Theme switched',
      'opt.quotaNoLimit': 'There is no daily limit to raise',
      'opt.quotaRaised': 'Limit raised — you can carry on',
      'opt.cacheCleared': 'Cache cleared',
      'opt.clearFail': 'Could not clear: {msg}',
      'opt.copyFail': 'Copy failed: {msg}',
      'opt.diagCopied': 'Diagnostics copied — paste them into the issue',
      'opt.diag': 'Copy diagnostics',
      'opt.diagUnknownBrowser': 'unknown browser',
      'opt.diagUnknownOs': 'unknown OS',
      'opt.diagSet': 'set',
      'opt.diagUnset': 'not set',
      'opt.diagOn': 'yes',
      'opt.diagOff': 'no',
      'opt.diagSkipOn': 'on',
      'opt.diagSkipOff': 'off',
      'opt.diagEngine': 'engine: {engine} · API key: {key}',
      'opt.diagDir': 'direction: {from} → {to}',
      'opt.diagTheme': 'theme: {theme} · mode: {mode} · enabled: {on}',
      'opt.diagTrigger': 'trigger: {trigger} · skip technical: {skip}',
      'opt.diagPanel': 'panel: font {font} · width {width}',
      'opt.diagSites': 'excluded sites: {n}',
      'opt.diagUsed': 'used today: {n}',
      'opt.feedback': 'Feedback ↗'
    }
  };

  const DEFAULT_LANG = 'zh';

  /* 界面**能切**的语言（#35 / #9）。

     ⚠️ 这一份与 lang.js 的 LANGS（**能翻译的**语言）是两件事，故意不共用：
     能翻译的语言有 11 种，但界面文案只有 zh / en 两张表。
     把界面语言下拉按 LANGS 渲染的话，加一门翻译语言会往里面塞进一堆
     没有文案的语言 —— 选了它，界面会静默回退成中文（has() 挡住，不报错）。

     这里由 STRINGS 的键推出来，**不另写一份名单** —— 加一张文案表就自动多一档。 */
  const UI_LANGS = Object.keys(STRINGS);

  /* 当前界面语言。默认中文 —— #39 这一步**刻意不改任何默认行为**：
   「跟随浏览器」与手动切换是 #35 的事，这一步只把文案搬到一处。 */
  let lang = DEFAULT_LANG;

  /* ⚠️ 必须挡住「这个语言码根本没有表」的情况（`STRINGS[l]` 是 undefined）——
     直接 hasOwnProperty.call(undefined, …) 会抛 TypeError。
     这不是假想：setLang 要接受外部传进来的值（存储里的旧配置、将来用户手改的值），
     一个拼错的语言码就会把整个扩展页面打白。 */
  function has(l, key) {
    const table = STRINGS[l];
    return !!table && Object.prototype.hasOwnProperty.call(table, key);
  }

  /* 浏览器语言 → 我们支持的界面语言（#35）。

     ⚠️ 只认中英两种，其余语言给**英文**（国际默认），**不是** DEFAULT_LANG ——
     DEFAULT_LANG 管的是另一件事：「文案表缺键时回退到哪张表」，
     那张表必须是最完整的那张（中文）。而这里是「一个法国用户该看到什么界面」，
     给他一门完全看不懂的中文，比给英文更糟。 */
  function browserLang() {
    let tag = '';
    try {
      // 扩展里这是最准的来源：它就是浏览器界面语言
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
        tag = chrome.i18n.getUILanguage() || '';
      }
    } catch (e) { /* 不在扩展环境里（Node 自测、普通网页） */ }
    if (!tag) {
      try { tag = (typeof navigator !== 'undefined' && navigator.language) || ''; } catch (e) { /* 没有 navigator */ }
    }
    return /^zh/i.test(tag) ? 'zh' : 'en';
  }

  /* 把存储里的**偏好**解析成实际使用的语言。三种取值，三种含义：
       'zh' / 'en'  → 用户明确指定
       'auto'       → 跟随浏览器
       其余          → 老配置 / 手改的存储 / 将来删掉的档 → 默认语言，**不猜** */
  function resolveLang(pref) {
    if (pref === 'zh' || pref === 'en') return pref;
    if (pref === 'auto') return browserLang();
    return DEFAULT_LANG;
  }

  function setLang(pref) {
    const l = resolveLang(pref);
    lang = has(l, 'ext.name') ? l : DEFAULT_LANG;
    return lang;
  }

  function getLang() {
    return lang;
  }

  /* 取文案。vars 做 {name} 插值。

     ⚠️ 缺键时**回退到中文，并且再缺就返回键名本身**，绝不返回空字符串 ——
     空字符串是最坏的结果：界面上少一句话，没有任何痕迹，也没人会发现。
     返回键名（如 `opt.secUsage`）至少能一眼看出「这里缺一条文案」。 */
  function t(key, vars) {
    let s = has(lang, key) ? STRINGS[lang][key] : undefined;
    if (s === undefined && has(DEFAULT_LANG, key)) s = STRINGS[DEFAULT_LANG][key];
    if (s === undefined) return key;

    if (vars) {
      Object.keys(vars).forEach((k) => {
        s = s.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
  }

  /* 页面加载时先藏住，填完文案再显示 —— 否则会先闪一下空标签。
     见 options.html / popup.html 里的 .i18n-pending。 */
  const PENDING_CLASS = 'i18n-pending';

  const ATTRS = ['title', 'aria-label', 'placeholder'];

  /* 把 DOM 里带 data-i18n 的文案填上：
       data-i18n="key"              → 元素内容
       data-i18n-title="key"        → title 属性
       data-i18n-aria-label="key"   → aria-label 属性
       data-i18n-placeholder="key"  → placeholder 属性

     ⚠️ 这里用 innerHTML，因为不少说明文案里夹着 <b> / <code> / <br>。
     **只用于静态文案** —— 这些字符串全部写死在上面两张表里，不含任何用户数据。
     带用户数据的文本一律走 textContent（见 content.js 的 setBody、
     options.js 的 checkSites）。这条界限不能糊：糊了就是一个注入口。 */
  function applyI18n(root) {
    const doc = root || document;
    if (!doc || !doc.querySelectorAll) return;

    Array.prototype.forEach.call(doc.querySelectorAll('[data-i18n]'), (el) => {
      el.innerHTML = t(el.getAttribute('data-i18n'));
    });

    ATTRS.forEach((attr) => {
      const name = 'data-i18n-' + attr;
      Array.prototype.forEach.call(doc.querySelectorAll('[' + name + ']'), (el) => {
        el.setAttribute(attr, t(el.getAttribute(name)));
      });
    });

    const html = doc.documentElement || (doc.body && doc.body.parentNode);
    if (html) {
      // <html lang> 跟着界面语言走：影响字体回退与拼写检查，不是装饰
      html.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
      if (html.classList) html.classList.remove(PENDING_CLASS);
    }
  }

  const api = {
    STRINGS: STRINGS,
    DEFAULT_LANG: DEFAULT_LANG,
    UI_LANGS: UI_LANGS,
    PENDING_CLASS: PENDING_CLASS,
    t: t,
    setLang: setLang,
    getLang: getLang,
    resolveLang: resolveLang,
    browserLang: browserLang,
    applyI18n: applyI18n
  };

  root.WT_STRINGS = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
