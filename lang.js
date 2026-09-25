'use strict';

/* 划词翻译 —— 语言判定与翻译方向（共享模块）
   ────────────────────────────────────────────────────────────────
   为什么单独拆一个文件：
   语言判定要同时被后台（决定译成什么）和设置页（渲染下拉选项）用到。
   各写一份必然不一致 —— 和当初 DEFAULTS 拆出 config.js 是同一个理由。

   双模式加载（与 config.js 完全一致，不引入任何构建步骤）：
   - MV3 service worker   → importScripts('config.js', 'lang.js')，读 globalThis.WT_LANG
   - content script       → manifest 的 content_scripts.js 里排在 content.js 之前
   - 设置页 / 弹层        → <script src="lang.js"> 排在各自的 js 之前
   - Node（dev/selftest.js）→ require('./lang.js')
*/

(function (root) {
  'use strict';

  /* 支持的语言（#9 扩到 11 种）。加语言时**只改这里** —— 设置页的两个下拉直接由它渲染。

     ⚠️ 加了语言要同步确认**四件事**，漏一件都不会报错：
       1. strings.js 里补 `lang.<code>`（显示名）—— 不补的话下拉里显示的是键名本身；
          显示名**不放在这里**（#39）：那样它就是一个「只在中文下正确」的硬编码。
       2. background.js 的 LANG（各家引擎的语言代码映射，如 google 的 zh-Hant → 'zh-TW'）
       3. background.js 的 PROMPT_NAME（写进提示词的语言名）
       4. options.js 的 SAMPLE（「测试翻译」用的样本句，按语言码分键）
     真正「支持」一门语言还要实测一次能返回合理结果，别只加选项（见 Issue #9）。

     ⚠️ **这份表 ≠ 界面语言表**：界面语言（strings.js 的 UI_LANGS）只有 zh / en 两种，
     因为只有这两张文案表。两者故意不共用一份 —— 共用的话，加一门翻译语言
     会往「界面语言」下拉里塞进一堆没有文案的语言（表现是选了没反应）。 */
  const LANGS = [
    { code: 'zh' },       // 中文（简体）
    { code: 'zh-Hant' },  // 中文（繁体）
    { code: 'en' },       // 英文
    { code: 'ja' },       // 日文
    { code: 'ko' },       // 韩文
    { code: 'fr' },       // 法文
    { code: 'de' },       // 德文
    { code: 'es' },       // 西班牙文
    { code: 'ru' },       // 俄文
    { code: 'ar' },       // 阿拉伯文
    { code: 'th' }        // 泰文
  ];

  /* 短于这个长度不做判定。
     「OK」「好的」「OK 了」这类判不准，也没必要拦 —— 猜错的代价比省下的钱大。 */
  const SHORT = 8;

  /* 兜底的一对语言。调用方（background.js / content.js）一定会把
     cfg.preferredLang / cfg.targetLang 传进来，这两个只是防御。
     ⚠️ **必须与 config.js 的 DEFAULTS 保持一致** —— 不一致的话，某个调用方
     忘了传参时，兜底方向会与设置页显示的默认值相反，而且不会报错。 */
  const FALLBACK_PREFERRED = 'en';
  const FALLBACK_TARGET = 'zh';

  /* 各文字系统。用 \p{Script=...} 而不是手写区间 ——
     拉丁字母带各种变音符号（é / ü / ñ），手写区间一定会漏。 */
  const RE_LETTER = /\p{L}/u;
  const RE_KANA = /[\u3040-\u30ff]/;          // 平假名 + 片假名
  const RE_HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/; // 谚文音节 + 字母
  const RE_THAI = /[\u0e00-\u0e7f]/;          // 泰文
  const RE_ARABIC = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/; // 阿拉伯文
  const RE_CYRILLIC = /[\u0400-\u04ff\u0500-\u052f]/; // 西里尔（俄文等）
  const RE_CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;      // 汉字（含扩展 A 区）
  const RE_LATIN = /\p{Script=Latin}/u;

  /* ---------- 简体 / 繁体（#9）----------

     ⚠️ 这一条**本质上做不到准确**：简体与繁体共用汉字区，按「是不是汉字」区分不了。
     这里用一张「只在繁体里出现 / 只在简体里出现」的常用字表做**启发式**：
     繁体字命中多就判繁体，否则一律判简体。

     为什么值得做：判错只在一种组合下有害 —— 「首选繁体 / 目标简体」时，
     繁体文本被判成简体 → 命中「等于目标语言」→ 反向译回繁体（译成同语言）。
     其余组合判错都只是退回目标语言，结果仍然合理。

     局限（已知、接受）：一段**没有区分字**的文本（如「今天天气很好」）会判成简体。
     这不是 bug，是没有判据 —— 所以设置页里两种中文都保留，让用户能自己指定。 */
  const TRAD_HINT = '們個這說時會對來東語體國學應樣麼讓過進開關點現實發覺買賣錢龍馬鳥魚書車電話網頁數據庫標準確認與為無萬業樂習鄉雲亞產親僅從眾優傳傷價側償億見觀讀寫聽講記識誰幾歲頭臉醫藥鐵銀銅長門問間陽陰風飛飯館龜齒齊';   // i18n-allow: 简繁判定的字表，是被判定的**数据**，不是界面文案
  const SIMP_HINT = '们个这说时会对来东语体国学应样么让过进开关点现实发觉买卖钱龙马鸟鱼书车电话网页数据库标准确认与为无万业乐习乡云亚产亲仅从众优传伤价侧偿亿见观读写听讲记识谁几岁头脸医药铁银铜长门问间阳阴风飞饭馆龟齿齐';   // i18n-allow: 同上

  function cjkVariant(text) {
    let trad = 0, simp = 0;
    for (const ch of text) {
      if (TRAD_HINT.indexOf(ch) >= 0) trad++;
      else if (SIMP_HINT.indexOf(ch) >= 0) simp++;
    }
    return trad > simp ? 'zh-Hant' : 'zh';
  }

  /* ---------- 拉丁语系细分（#9）----------

     阿拉伯 / 泰 / 俄（西里尔）各有专属字符，好认；法 / 德 / 西 全是拉丁字母，
     只看字符分不出来。原来的实现是「拉丁占比 ≥ 0.8 → en」，加了这三门语言之后
     就变成「法文被判成英文」——配上「首选中文 / 目标法文」会绕回「译成同语言」。

     这里用**常用虚词打分**：把文本切成词，数一数各语言的虚词命中几个，取最高的。
     虚词（the / le / der / el 这种）在自然语言里出现频率极高，比字母分布稳。

     为什么不用更「聪明」的办法（语言模型 / 字典）：
     这个文件要能在 MV3 的 service worker 里同步跑、还要零依赖、体积可控 ——
     为一次划词判定引入几百 KB 的数据表不划算。启发式判错的代价也只是
     「方向不对」，而浮层上永远有一个「译成 X」的出口（#2 定的）。

     局限（已知、接受）：
     - 一句「Merci beaucoup」这种没有虚词的短句会判成 en（表里都没有命中）
     - 平局时给 en（英语是默认首选语言，也是拉丁语系里最常见的） */
  const LATIN_WORDS = {
    en: ['the', 'and', 'of', 'to', 'in', 'is', 'you', 'that', 'it', 'was', 'for', 'on', 'are',
      'as', 'with', 'his', 'they', 'at', 'be', 'this', 'have', 'from', 'or', 'one', 'had', 'by',
      'but', 'not', 'what', 'all', 'were', 'we', 'when', 'your', 'can', 'there', 'an', 'each',
      'which', 'she', 'do', 'how', 'their', 'if', 'will', 'up', 'other', 'about', 'out', 'them',
      'these', 'so', 'some', 'her', 'would', 'make', 'like', 'him', 'into', 'time', 'has',
      'look', 'more', 'write', 'go', 'see', 'no', 'way', 'could', 'people', 'my', 'than',
      'first', 'been', 'call', 'who', 'its', 'now', 'find', 'long', 'down', 'day', 'did', 'get',
      'come', 'made', 'may', 'part', 'should', 'because', 'does', 'just', 'only', 'also'],
    fr: ['le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'est', 'en', 'que', 'qui',
      'dans', 'pour', 'pas', 'sur', 'au', 'avec', 'ce', 'il', 'elle', 'ne', 'se', 'plus', 'par',
      'je', 'tu', 'nous', 'vous', 'ils', 'elles', 'son', 'sa', 'ses', 'mais', 'ou', 'où',
      'comme', 'tout', 'fait', 'être', 'avoir', 'cette', 'ces', 'mon', 'ton', 'notre', 'votre',
      'leur', 'sont', 'aux', 'c', 'l', 'd', 'qu', 'j', 'n', 's', 'm', 't', 'été', 'aussi',
      'donc', 'alors', 'très', 'bien', 'sans', 'sous', 'entre', 'encore', 'déjà', 'ici'],
    de: ['der', 'die', 'das', 'und', 'ist', 'von', 'den', 'zu', 'mit', 'sich', 'des', 'auf',
      'für', 'nicht', 'ein', 'eine', 'als', 'auch', 'es', 'an', 'werden', 'aus', 'er', 'hat',
      'dass', 'sie', 'nach', 'wird', 'bei', 'einer', 'um', 'am', 'sind', 'noch', 'wie', 'einem',
      'über', 'einen', 'so', 'zum', 'war', 'haben', 'nur', 'oder', 'aber', 'vor', 'zur', 'bis',
      'mehr', 'durch', 'man', 'sein', 'wurde', 'sei', 'kann', 'muss', 'soll', 'wir', 'ihr',
      'ihre', 'diese', 'dieser', 'dieses', 'wenn', 'dann', 'doch', 'schon', 'immer', 'jetzt'],
    es: ['el', 'la', 'los', 'las', 'de', 'del', 'un', 'una', 'y', 'es', 'en', 'que', 'por',
      'con', 'no', 'se', 'su', 'para', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'o', 'este',
      'sí', 'porque', 'esta', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'también', 'me',
      'hasta', 'hay', 'donde', 'quien', 'desde', 'todo', 'nos', 'durante', 'todos', 'uno',
      'les', 'ni', 'contra', 'otros', 'ese', 'eso', 'ante', 'ellos', 'esto', 'mí', 'antes',
      'son', 'está', 'están', 'fue', 'ser', 'tiene', 'tienen', 'puede', 'hace', 'así', 'aquí']
  };

  /* 只在这门语言里常见的变音字母 —— 一个额外的加分项。
     虚词命中数相同时（短句常见），它能把结果掰对。 */
  const LATIN_ACCENT = {
    de: /[äöüß]/i,
    es: /[ñ¿¡]/i,
    fr: /[àâçèêëîïôùûœ]/i
  };

  const RE_WORD = /\p{Script=Latin}+/gu;

  function latinLang(text) {
    const words = String(text).toLowerCase().match(RE_WORD) || [];
    if (!words.length) return 'en';

    let best = 'en';
    let bestScore = 0;
    let tie = false;

    for (const code of Object.keys(LATIN_WORDS)) {
      const set = LATIN_WORDS[code];
      let score = 0;
      for (const w of words) if (set.indexOf(w) >= 0) score++;
      if (LATIN_ACCENT[code] && LATIN_ACCENT[code].test(text)) score++;
      if (score > bestScore) {
        bestScore = score;
        best = code;
        tie = false;
      } else if (score === bestScore && score > 0) {
        tie = true;
      }
    }

    /* 一个虚词都没命中 → 判不出来，退回 en；
       平局也退回 en（英语是默认首选语言，也是拉丁语系里最常见的）。 */
    if (bestScore === 0 || tie) return 'en';
    return best;
  }

  /* 判定文本主要是什么语言。
     只统计字母，空格 / 标点 / 数字一律不计入分母 —— 否则一段带很多标点的英文会被拉低比例。 */
  function detect(text) {
    const t = String(text || '');
    if (t.length < SHORT) return 'unknown';

    let kana = 0, hangul = 0, thai = 0, arabic = 0, cyrillic = 0, cjk = 0, latin = 0, total = 0;
    for (const ch of t) {
      if (!RE_LETTER.test(ch)) continue;
      total++;
      if (RE_KANA.test(ch)) kana++;
      else if (RE_HANGUL.test(ch)) hangul++;
      else if (RE_THAI.test(ch)) thai++;
      else if (RE_ARABIC.test(ch)) arabic++;
      else if (RE_CYRILLIC.test(ch)) cyrillic++;
      else if (RE_CJK.test(ch)) cjk++;
      else if (RE_LATIN.test(ch)) latin++;
    }
    if (!total) return 'unknown';

    /* ⚠️ 假名和谚文必须排在汉字前面，而且是**出现即判定**。
       日文里夹着大量汉字，先查汉字会把日文整段判成中文 —— 这是最容易踩的一个坑。
       反过来说，假名和谚文只要出现一个就是强信号：别的语言不用这两种字符。 */
    if (kana > 0) return 'ja';
    if (hangul > 0) return 'ko';

    /* 泰文 / 阿拉伯文 / 西里尔文：字符是这门语言专属的，但**不能只看「出现过」**——
       一句英文里引一个俄文词（"the Russian word Привет"）不该判成俄文。
       要求占比过半，才算「主要是什么语言」。 */
    if (thai / total >= 0.5) return 'th';
    if (arabic / total >= 0.5) return 'ar';
    if (cyrillic / total >= 0.5) return 'ru';

    if (cjk / total >= 0.5) return cjkVariant(t);
    if (latin / total >= 0.8) return latinLang(t);
    return 'unknown';
  }

  /* 由「一对语言」和检测结果定出这次要译成什么。
     返回 { target, reversed } —— reversed 表示这次是反向（浮层靠它给提示）。 */
  function resolve(detected, preferred, target) {
    const p = preferred || FALLBACK_PREFERRED;
    const t = target || FALLBACK_TARGET;

    // 两个字段相等 = 配置有问题，不做反向，免得绕回「译成同语言」
    if (p === t) return { target: t, reversed: false };

    if (detected === p) return { target: t, reversed: false };
    if (detected === t) return { target: p, reversed: true };

    // 判不出来 / 判成了第三种语言 → 保守地按目标语言走
    return { target: t, reversed: false };
  }

  /* ⚠️ 这里**故意没有 name(code) → 显示名**（#39）。
     显示名是界面文案，归 strings.js 的 `lang.<code>` 管。
     留在这里的话，同一门语言会有两处说法（「中文」/「Chinese」），
     切界面语言时只改得动一处 —— 而且不会报错。
     需要显示名的地方一律用 `WT_STRINGS.t('lang.' + code)`。 */

  /* 浮层的「译成 X」按钮：在**当前配置的这一对语言**之间切换。

     ⚠️ 参数是「一对语言」而不是从 LANGS 里猜（#9）。
     原来的实现是「LANGS 里第一个不等于这个 code 的」—— 只有两种语言时
     它恰好等于「另一个」，三种以上就退化成「永远只在前两个之间切」，
     按钮文案与实际结果对不上。正确的语义是「这对配置里的另一个」。

     传进来的 code 一定来自 resolve() 的结果（等于 preferred 或 target），
     所以正常路径下一定命中前两个分支；最后一个分支只是防御。 */
  function other(code, preferred, target) {
    const p = preferred || FALLBACK_PREFERRED;
    const t = target || FALLBACK_TARGET;
    if (code === p) return t;
    if (code === t) return p;
    return t;
  }

  /* HINTS 只为自测能验证「两张表等长且不相交」而暴露（#9）——
     它们是启发式用的字表，不是给业务代码用的，别在别处引用。 */
  const api = {
    LANGS, SHORT, detect, resolve, other,
    HINTS: { trad: TRAD_HINT, simp: SIMP_HINT }
  };

  root.WT_LANG = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
