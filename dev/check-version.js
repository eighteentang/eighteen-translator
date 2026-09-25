/* 划词翻译 · 版本号与 CHANGELOG 一致性检查
   ────────────────────────────────────────────────────────────────
   Issue #42 定下的约定：`manifest.json` 的 `version` 是**单一真源**，
   git tag 与 `CHANGELOG.md` 顶部都跟着它走。

   这个脚本只查最容易断的那一环 —— **改了一处、忘了另一处**：

     1. `CHANGELOG.md` 存在，且顶部第一条版本就是 manifest 的当前版本
     2. `CHANGELOG.md` 里每个版本标题都带 `YYYY-MM-DD` 日期
     3. `CHANGELOG.md` 里没有重复的版本号
     4. manifest 的 `version` 是 `x.y.z` 三段（Chrome 不接受四段）

   ⚠️ 为什么单独一个脚本、不并进 `check.js`：
   `check.js` 管的是「扩展能不能加载 / manifest 字段对不对」，
   这一条管的是「发布流程有没有走完」。两件事，坏了要修的地方也不同。
   所以 `check.js` 仍然是五项，这一条是第六道检查。

   零依赖、纯 Node。发现任一项即非零退出，可直接接进 CI。
   跑法：node dev/check-version.js
*/

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const problems = [];
const notes = [];

function bad(msg) {
  problems.push(msg);
}

/* 版本标题：## [0.4.1] - 2026-09-25
   Keep a Changelog 允许 `## [Unreleased]`（无日期），单独放行。 */
const RE_RELEASED = /^##\s+\[(\d+\.\d+\.\d+)\]\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/;
const RE_UNRELEASED = /^##\s+\[Unreleased\]\s*$/i;
/* 像版本标题但格式不对 —— 单独抓出来，否则它会被静默当成正文 */
const RE_LOOKS_LIKE = /^##\s+\[[^\]]*\]/;

/* ---------- manifest ---------- */

let manifest = null;
let version = null;

try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  bad('读不了 manifest.json：' + e.message);
}

if (manifest) {
  version = String(manifest.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    bad('manifest.json 的 version 是「' + version + '」，不是 x.y.z 三段 —— ' +
      'Chrome 不接受四段，写错会让更新推不上去');
  }
}

/* ---------- CHANGELOG ---------- */

const released = [];
let sawUnreleased = false;
let looksLikeCount = 0;

if (!fs.existsSync(CHANGELOG)) {
  bad('找不到 CHANGELOG.md —— #42 约定它必须存在，且顶部一条就是当前版本');
} else {
  const lines = fs.readFileSync(CHANGELOG, 'utf8').split(/\r?\n/);

  lines.forEach((line, i) => {
    const no = i + 1;

    if (RE_UNRELEASED.test(line)) {
      sawUnreleased = true;
      return;
    }

    const m = line.match(RE_RELEASED);
    if (m) {
      released.push({ version: m[1], date: m[2], line: no });
      return;
    }

    if (RE_LOOKS_LIKE.test(line)) {
      looksLikeCount += 1;
      bad('CHANGELOG.md 第 ' + no + ' 行的版本标题格式不对：「' + line.trim() +
        '」—— 要写成 `## [x.y.z] - YYYY-MM-DD`（或 `## [Unreleased]`）');
    }
  });

  if (!released.length && !looksLikeCount) {
    bad('CHANGELOG.md 里一个版本标题都没有 —— 至少要有一条 `## [x.y.z] - YYYY-MM-DD`');
  }

  /* 顶部第一条 = 当前版本。倒序是约定，所以取「文件里最先出现的那条」。 */
  if (released.length && version) {
    const top = released[0];
    if (top.version !== version) {
      bad('版本对不上：manifest.json 是 ' + version + '，' +
        'CHANGELOG.md 顶部是 ' + top.version + '（第 ' + top.line + ' 行）—— ' +
        '发版时两处必须一起改');
    }
  }

  /* 重复版本号：复制粘贴一条旧记录、只改了日期，会走到这里 */
  const seen = new Map();
  released.forEach((r) => {
    if (seen.has(r.version)) {
      bad('CHANGELOG.md 里 ' + r.version + ' 出现了两次（第 ' +
        seen.get(r.version) + ' 行与第 ' + r.line + ' 行）');
    } else {
      seen.set(r.version, r.line);
    }
  });
}

/* ---------- 结果 ---------- */

console.log('划词翻译 · 版本号与 CHANGELOG 检查');
console.log('目录：' + ROOT);

if (version) console.log('  · manifest.json 的 version = ' + version);
if (released.length) {
  console.log('  · CHANGELOG.md 记录了 ' + released.length + ' 个版本：' +
    released.map((r) => r.version).join(' → '));
  console.log('  · 最新一条：' + released[0].version + '（' + released[0].date + '）');
}
if (sawUnreleased) {
  notes.push('CHANGELOG.md 里有 `[Unreleased]` 段 —— 发版时记得把它改成具体版本号');
}
notes.forEach((n) => console.log('  · ' + n));

if (problems.length) {
  console.log('\n发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}

console.log('\n✅ 版本号与 CHANGELOG 一致');
