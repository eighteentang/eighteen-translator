'use strict';
/* 扫描 JS 源码里「用户可见的中文硬编码」（#39 的自动化防线）。
   ────────────────────────────────────────────────────────────────
   规则：字符串字面量（' / " / ` 三种）里出现汉字，就是一条命中 ——
   文案必须走 strings.js 的 t()。

   ⚠️ 为什么需要一个真正的词法器、而不是几行正则：
   1. 注释里会出现汉字（本项目的注释全是中文），必须先剥掉；
   2. 正则字面量里会出现引号和反引号（tech.js 的 RE_UNIX_PATH 就带 " 和 '），
      不认出来就会把后面的整段代码吞进「字符串」里，命中与漏报全乱；
   3. 模板串里会有成对的反引号（注释里写 `t('x')` 这种）。
   所以这里按「块注释 / 行注释 / 字符串 / 正则」四种状态走一遍。

   例外出口：`i18n-allow` 标记 —— 见 exempt()。 */
const CN = /[\u4e00-\u9fff]/;

const KEYWORDS = /^(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await|throw)$/;

/* 把源码过一遍，返回每个「含汉字的字符串字面量」：
   { startLine, endLine, quote, text } */
function findChineseLiterals(src) {
  const n = src.length;
  const hits = [];
  let i = 0;
  let line = 1;
  let lastSig = '';        // 上一个「有意义」的字符（跳过空白与注释）
  let lastWord = '';       // 上一个标识符

  const bump = (seg) => {
    for (let k = 0; k < seg.length; k++) if (seg[k] === '\n') line++;
  };

  while (i < n) {
    const c = src[i], d = src[i + 1];

    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const seg = e < 0 ? src.slice(i) : src.slice(i, e + 2);
      bump(seg); i = e < 0 ? n : e + 2; continue;
    }
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const seg = e < 0 ? src.slice(i) : src.slice(i, e);
      bump(seg); i = e < 0 ? n : e; continue;
    }

    // 正则字面量：`/` 前面不是「值」的时候才是正则，否则是除号
    if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(lastSig || '') && !KEYWORDS.test(lastWord)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      // 正则后面的 flags
      let k = j + 1;
      while (k < n && /[a-z]/.test(src[k])) k++;
      bump(src.slice(i, k));
      lastSig = 'x'; lastWord = '';
      i = k; continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const startLine = line;
      let j = i + 1;
      let buf = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') { buf += src[j] + (src[j + 1] || ''); j += 2; continue; }
        buf += src[j]; j++;
      }
      const seg = src.slice(i, Math.min(j + 1, n));
      bump(seg);
      if (CN.test(buf)) {
        hits.push({ startLine, endLine: line, quote, text: buf });
      }
      lastSig = 'x'; lastWord = '';
      i = j + 1; continue;
    }

    if (/\s/.test(c)) { if (c === '\n') line++; i++; continue; }

    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      lastWord = src.slice(i, j);
      lastSig = c;
      i = j; continue;
    }

    lastSig = c; lastWord = '';
    i++;
  }

  return hits;
}

/* 例外出口。

   为什么需要它：有几处汉字**故意**留在源码里，它们不是「界面文案」：
   - background.js 的提示词（给模型看的，界面语言变了它也不该变）
   - background.js 的 PROMPT_NAME（同上）
   - content.js 的 CSS 模板串（里面的汉字全是给维护者看的注释）
   - options.js 的 SAMPLE（按**语言码**分键的测试数据，必须跟着被测语言走）

   标记写法：`i18n-allow: 理由`，放在字面量所在行的**行尾**，
   或放在它上面最近的一行非空行（模板串跨行时只能这么写）。
   每一条都必须带理由 —— 一个没有理由的豁免，下一个人只会照抄。 */
const MARK = /i18n-allow\s*[:：]/;

function exempt(src, hit) {
  const lines = src.split('\n');
  const own = lines[hit.startLine - 1] || '';
  if (MARK.test(own)) return true;
  for (let i = hit.startLine - 2; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) return false;
    if (MARK.test(l)) return true;
  }
  return false;
}

/* 返回 [{ line, text }]，空数组表示这一份源码干净。 */
function scan(src) {
  return findChineseLiterals(src)
    .filter((h) => !exempt(src, h))
    .map((h) => ({
      line: h.startLine + (h.endLine > h.startLine ? '-' + h.endLine : ''),
      text: h.text.replace(/\s+/g, ' ').slice(0, 60)
    }));
}

/* HTML 的版本：剥掉 <!-- --> 注释与 <style> / <script> 块之后，
   剩下的任何汉字都是「没走 data-i18n 的文案」。

   ⚠️ 为什么连属性一起查：popup.html 的 `aria-label="切换主题"` 就是这么漏出来的 ——
   肉眼扫一遍 HTML 时，属性里的中文最容易看不见。 */
function scanHtml(src) {
  const blank = (seg) => seg.replace(/[^\n]/g, ' ');
  let s = src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<style[\s\S]*?<\/style>/gi, blank)
    .replace(/<script[\s\S]*?<\/script>/gi, blank);

  const hits = [];
  s.split('\n').forEach((line, i) => {
    if (CN.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 60) });
  });
  return hits;
}

/* 要扫哪些文件 —— **只此一份**，命令行与 selftest 共用。
   分成两份的后果：新增一个源文件时只补了其中一处，另一处静默漏扫，
   而漏扫的表现就是「检查通过」。 */
const SCAN_JS = ['background.js', 'content.js', 'config.js', 'lang.js', 'speak.js',
  'tech.js', 'sites.js', 'theme.js', 'popup.js', 'options.js'];
const SCAN_HTML = ['popup.html', 'options.html'];

module.exports = { scan, scanHtml, findChineseLiterals, CN, MARK, SCAN_JS, SCAN_HTML };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');

  /* ⚠️ 不带参数时扫**扩展自己的源码**，而不是什么都不扫。
     以前这里直接遍历 `process.argv.slice(2)`：不带参数就一次都不进循环，
     照样打印 `TOTAL 0` —— 一个永远通过的检查比没有更糟，它会让人以为防线在。 */
  const args = process.argv.slice(2);
  const files = args.length ? args : SCAN_JS.concat(SCAN_HTML);
  let bad = 0;

  files.forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const hits = /\.html?$/i.test(f) ? scanHtml(src) : scan(src);
    if (hits.length) {
      bad += hits.length;
      console.log('=== ' + f + ' (' + hits.length + ') ===');
      hits.forEach((h) => console.log('  ' + h.line + ': ' + h.text));
    }
  });

  console.log('扫了 ' + files.length + ' 个文件：' + files.join(', '));
  console.log('TOTAL ' + bad);
  process.exit(bad ? 1 : 0);
}
