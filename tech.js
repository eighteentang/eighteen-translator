'use strict';

/* 划词翻译 —— 「这看起来是技术内容」判定（共享模块）
   ────────────────────────────────────────────────────────────────
   为什么单独拆一个文件：
   判定要同时被 content.js（决定这次请求发不发）与 dev/selftest.js（断言）用到。
   和当初把语言判定拆成 lang.js 是同一个理由 —— 纯函数单独放，才测得到。

   双模式加载（与 config.js / lang.js 完全一致，不引入任何构建步骤）：
   - content script       → manifest 的 content_scripts.js 里排在 content.js 之前
   - Node（dev/selftest.js）→ require('./tech.js')

   ⚠️ **只有 content.js 需要它**。设置页与弹层只负责存那个开关，不做判定，
   所以这两个页面不加载本文件 —— 这是有意的，不是漏了。

   它解决什么（Issue #60）：
   读技术文档时随手选到一段代码、一个 URL、一个邮箱，会照发一次请求，
   返回一段没有意义的「译文」—— 既花钱又干扰。现有那三道拦截
   （超 1000 字符、空文本、纯符号）都拦不住它：代码里有大量字母。

   ⚠️ 判定是启发式的，**一定会误伤**（「他说：{引用的内容}」这类）。
   所以调用方**必须**给一条「仍然翻译」的出口 —— 与语言判定同一个思路：
   误判可以接受，误判之后无路可走不行。
*/

(function (root) {
  'use strict';

  /* 只在短文本上判定。

     长文本几乎一定含句号、括号、斜杠，符号占比会被摊薄到阈值以下，判定本来就会失效；
     而一篇长文里夹了一行代码时，**跳过整段**才是真正的误伤。
     所以一超长度就直接不判 —— 「宁可不拦，不可错拦」。 */
  const MAX_LEN = 200;

  // URL 与邮箱：`https://…` / `www.…` / `a@b.com`
  const RE_URL = /https?:\/\/|www\.[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
  const RE_MAIL = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;

  /* 文件路径。分两种写法：
     - Windows：盘符后跟反斜杠，或 UNC（\\host\share）
     - Unix：斜杠 + 一段以**扩展名**收尾的名字

     ⚠️ 扩展名必须由字母开头（`\.[A-Za-z]`），否则 `3.5/4.2`、`2024/01/15`
     这种普通数字会被判成路径。 */
  const RE_WIN_PATH = /[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\/;
  const RE_UNIX_PATH = /(?:^|[\s"'(])[^\s"')]*\/[^\s"')]*\.[A-Za-z][A-Za-z0-9]{0,5}(?![A-Za-z0-9])/;

  /* 代码里才有的符号组合。单独出现不算 —— 必须同时满足符号占比。 */
  const RE_CODE_TOKEN = /\{\}|=>|<\/|::|;|\{|\}/;

  /* 命令行：行首的 `$`，或几个几乎不会出现在英文句子开头的命令名。
     ⚠️ 故意**只收小写**，且不收 `go` / `make` / `node` / `cd` / `ls` ——
     那些在正常句子里太常见了（「go to the store」会被判成命令行）。 */
  const RE_SHELL = /(?:^|\n)\s*\$\s|(?:^|\n)\s*(?:npm|npx|yarn|pnpm|git|pip|pip3|docker|curl|wget|sudo|brew|apt-get)\s/;

  /* 计入「符号」的字符。**只收 ASCII 的结构性标点**：
     - 不收中文的逗号句号，否则一句正常的中文会被算成高符号占比
     - 也不收 `.` `,` `?` `'` `"` —— 它们在正常句子里太密，
       收进来会把「Hi, Bob; how are you?」这种句子推进阈值 */
  const RE_SYMBOL = /[{}()\[\];:=<>+\-*/%!&|^~`@#$\\]/;

  const CODE_SYMBOL_RATIO = 0.15;

  /* 判定这段文字是不是「技术内容」。

     返回命中的类别（'url' / 'mail' / 'path' / 'code' / 'shell'），不命中返回 ''。

     ⚠️ 返回类别而不是 true / false：调用方要据此告诉用户**拦的是什么** ——
     「这看起来是个链接」比「已跳过」有用得多，而且断言也才有东西可写。 */
  function looksTechnical(text) {
    const t = String(text || '');
    if (!t || t.length > MAX_LEN) return '';

    if (RE_URL.test(t)) return 'url';
    if (RE_MAIL.test(t)) return 'mail';
    if (RE_WIN_PATH.test(t) || RE_UNIX_PATH.test(t)) return 'path';
    if (RE_SHELL.test(t)) return 'shell';

    if (RE_CODE_TOKEN.test(t)) {
      let sym = 0;
      for (let i = 0; i < t.length; i++) if (RE_SYMBOL.test(t[i])) sym++;
      if (sym / t.length > CODE_SYMBOL_RATIO) return 'code';
    }

    return '';
  }

  /* 给用户看的说法**不在这里**（#39）。
     原先这里有一张 LABEL 表（'url' → '一个链接'…），问题是它把「类别」与
     「中文文案」焊在了一起：界面切成英文时，判定结果仍是中文。
     现在由 strings.js 的 `tech.<kind>` 提供，调用方取 `t('tech.' + kind)`。

     ⚠️ 那「两处都忘不了」的保障没有丢，只是换了个位置：
     KINDS 是类别的单一真源，selftest 里有一条断言钉死
     「每一个 KINDS 成员在 strings.js 的 zh / en 两张表里都有键」。 */
  const KINDS = ['url', 'mail', 'path', 'code', 'shell'];

  const api = { MAX_LEN, CODE_SYMBOL_RATIO, KINDS, looksTechnical };

  root.WT_TECH = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
