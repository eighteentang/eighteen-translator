'use strict';

/* 划词翻译 —— 排除站点匹配（#29）
   ────────────────────────────────────────────────────────────────
   三个地方要用**同一套规则**：
   - content.js  → 页面加载时判断「这个域名要不要跳过」
   - options.js  → 保存时逐行校验，指出写错的是第几行
   - dev/selftest.js

   各写一份的话，「设置页说合法、页面却不跳过」这种不一致不会报错，
   只会表现为「加了没用」—— 所以按 config.js / lang.js 的老办法：
   单独一个文件，四种宿主共用（无构建步骤）。

   允许的写法（一行一个）：
     example.com        后缀匹配 —— 连 a.example.com 一起命中
     *.example.com      同上（写 *. 只是把意图写清楚，语义完全一样）
     intranet           单段主机名也允许（公司内网常见）
     # 备注             以 # 开头的行是备注，不参与匹配
     空行               跳过

   **不做正则**：用户写不对，而且有性能与注入风险。
   中间带 * 的行（如 foo.*.com）会被当成**格式错误**报出来，
   而不是当成字面量 —— 字面量永远不会命中，用户只会以为「加了没用」。
*/

(function (root) {
  'use strict';

  /* 一行 → 规范化的域名；空行返回 ''；不合法返回 null（由调用方报错）。 */
  function normalize(line) {
    let s = String(line == null ? '' : line).trim().toLowerCase();
    if (!s) return '';
    if (s.charAt(0) === '#') return '';   // 备注

    /* 用户会直接**粘贴网址** —— 把 scheme / 路径 / 查询串 / 端口都去掉。
       不这么做的话，粘一个 https://a.com/b 进来永远不会命中，
       而界面上看不出任何异常。 */
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.replace(/^\/\//, '');
    s = s.split('/')[0].split('?')[0].split('#')[0];
    s = s.replace(/:\d+$/, '');
    s = s.replace(/\.+$/, '');            // 结尾多余的点
    if (!s) return null;

    /* 一个光秃秃的 * 会让「哪里都不翻译」—— 那是总开关该干的事。
       在这里接受它，用户会以为自己只排除了一部分。 */
    if (s === '*') return null;

    const star = s.slice(0, 2) === '*.';
    const body = star ? s.slice(2) : s;
    if (body.indexOf('*') !== -1) return null;

    /* 只收 ASCII 字母数字与 - . ，且每段不能以 - 开头 / 结尾。
       中文域名（IDN）在这里会被判成不合法 —— 用户填的是 punycode 形式
       （xn--...），浏览器给的 hostname 也是 punycode，两边能对上。 */
    const label = '[a-z0-9]([a-z0-9-]*[a-z0-9])?';
    if (!new RegExp('^' + label + '(\\.' + label + ')*$').test(body)) return null;

    return star ? '*.' + body : body;
  }

  /* 整段文本 → { list, bad }。
     bad 里带行号，设置页要能说清「是第几行写错了」。 */
  function parse(text) {
    const lines = String(text == null ? '' : text).split('\n');
    const list = [];
    const bad = [];
    const seen = Object.create(null);

    lines.forEach((line, i) => {
      const s = normalize(line);
      if (s === '') return;
      if (s === null) {
        bad.push({ line: i + 1, text: String(line).trim() });
        return;
      }
      if (seen[s]) return;      // 重复的行不算错，也不重复存
      seen[s] = true;
      list.push(s);
    });

    return { list: list, bad: bad };
  }

  /* 域名命中判定。
     后缀匹配要**卡住点号边界**：example.com 不能命中 notexample.com，
     也不能命中 example.com.evil.com —— 否则排除列表会顺手排除掉别人的站。 */
  function matches(hostname, list) {
    const h = String(hostname == null ? '' : hostname).toLowerCase().replace(/\.+$/, '');
    if (!h || !list || !list.length) return false;

    for (let i = 0; i < list.length; i++) {
      let p = list[i];
      if (p.slice(0, 2) === '*.') p = p.slice(2);
      if (h === p) return true;
      if (h.length > p.length && h.slice(-p.length - 1) === '.' + p) return true;
    }
    return false;
  }

  /* 把 host 加进 / 移出排除列表（#29）—— popup 那个勾选框用。

     刻意**只动相关的行**：写错的行、# 备注、空行都原样留着。
     图省事从 parse() 的结果重新拼一份的话，用户写在列表里的备注会被悄悄删掉 ——
     而他在设置页里看不到任何提示。 */
  function setExcluded(text, host, on) {
    const h = String(host == null ? '' : host).trim().toLowerCase();
    if (!h) return String(text == null ? '' : text);

    const kept = String(text == null ? '' : text).split('\n').filter((line) => {
      const n = normalize(line);
      /* 会命中这个域名的行全部去掉 —— 可能不止一行
         （列表里同时有 example.com 与 *.example.com 时两条都命中）。 */
      return !n || !matches(h, [n]);
    });

    /* 首尾的空行统一收拾掉（两种情况都要）——
       否则「列表末尾本来就有一个空行」时，新域名会被顶到空行下面，
       看起来像多出一段空隙；取消勾选后也容易在开头留一个空行。 */
    while (kept.length && !kept[0].trim()) kept.shift();
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();

    if (on) kept.push(h);

    return kept.join('\n');
  }

  const api = {
    normalize: normalize,
    parse: parse,
    matches: matches,
    setExcluded: setExcluded
  };

  root.WT_SITES = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
