/* 划词翻译 · 文件与 manifest 自检
   ────────────────────────────────────────────────────────────────
   把踩过的坑变成自动化防线。目前查五项（对应 Issue #48 / #35 / #56）：

     1. `_` 前缀 —— 扩展目录及其所有子目录里以 `_` 开头的文件 / 目录
        （`_locales` / `_metadata` 除外）。违反**直接拒绝加载**，
        而且与是否被 manifest 引用无关（全目录递归扫描）。
     2. manifest 引用 —— icons / content_scripts.js / service_worker /
        default_popup / options_page 指向的文件都得存在。
     3. manifest 字段体检 —— 必填字段、版本号格式、host_permissions
        与实际请求的域名一致。
     4. 加载顺序 —— content.js 读到的每个 `globalThis.WT_*`，它对应的
        文件必须在 content_scripts.js 里排在 content.js **之前**。
        顺序错了会拿到 undefined 而**整段脚本静默失效** —— 这是四项里
        最容易被无声破坏的一条。
     5. `_locales` 与 `__MSG__` —— manifest 的字符串没法由 JS 改，
        只能走这条路；而这条路上全是「错了就静默失效」的坑
        （漏 `default_locale` 直接加载失败、`zh-CN` 被静默忽略、
        少一个键就悄悄退回默认语言、description 超长要等上架才知道）。

   零依赖、纯 Node。发现任一项即非零退出，可直接接进 CI（见 #61）。
   跑法：node dev/check.js
*/

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* 扫描时跳过的目录。
   `.git` 里有几千个对象文件，既慢又与本检查无关；
   `node_modules` 同理（本项目本身零依赖，但它可能在开发机上存在）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/* 唯一允许 `_` 前缀的两个名字（Chrome 的保留目录） */
const ALLOWED_UNDERSCORE = new Set(['_locales', '_metadata']);

const problems = [];
const notes = [];

function bad(msg) {
  problems.push(msg);
}

/* ---------- 1. `_` 前缀 ---------- */

function walk(dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const r = rel ? rel + '/' + ent.name : ent.name;
    out.push({ rel: r, dir: ent.isDirectory() });
    if (ent.isDirectory()) walk(path.join(dir, ent.name), r, out);
  }
  return out;
}

const all = walk(ROOT, '', []);

for (const item of all) {
  const base = item.rel.split('/').pop();
  if (!base.startsWith('_')) continue;
  if (ALLOWED_UNDERSCORE.has(base)) continue;
  bad('`_` 前缀：' + item.rel + (item.dir ? '/' : '') +
    ' —— 扩展会直接拒绝加载（与是否被 manifest 引用无关）');
}

/* ---------- 2. manifest 引用 ---------- */

const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
let mf = null;
try {
  mf = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
} catch (e) {
  bad('manifest.json 读不了或不是合法 JSON：' + e.message);
}

function exists(rel) {
  try {
    fs.accessSync(path.join(ROOT, rel));
    return true;
  } catch (e) {
    return false;
  }
}

if (mf) {
  const referenced = [];
  Object.values(mf.icons || {}).forEach((p) => referenced.push(['icons', p]));
  (mf.content_scripts || []).forEach((cs, i) => {
    (cs.js || []).forEach((p) => referenced.push(['content_scripts[' + i + '].js', p]));
    (cs.css || []).forEach((p) => referenced.push(['content_scripts[' + i + '].css', p]));
  });
  if (mf.background && mf.background.service_worker) {
    referenced.push(['background.service_worker', mf.background.service_worker]);
  }
  if (mf.options_page) referenced.push(['options_page', mf.options_page]);
  if (mf.action && mf.action.default_popup) {
    referenced.push(['action.default_popup', mf.action.default_popup]);
  }
  Object.values((mf.action && mf.action.default_icon) || {})
    .forEach((p) => referenced.push(['action.default_icon', p]));

  for (const [where, rel] of referenced) {
    if (!exists(rel)) bad('manifest 引用了不存在的文件：' + where + ' → ' + rel);
  }
  notes.push('manifest 引用了 ' + referenced.length + ' 个文件，全部存在');
}

/* ---------- 3. manifest 字段体检 ---------- */

if (mf) {
  for (const key of ['manifest_version', 'name', 'version', 'description']) {
    if (mf[key] === undefined || mf[key] === '') bad('manifest 缺少必填字段：' + key);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(mf.version || ''))) {
    bad('版本号必须是 x.y.z（Chrome 不接受四段）：' + mf.version);
  }
  if (mf.description && String(mf.description).length > 132) {
    bad('description 超过 Chrome 的 132 字符上限：' + String(mf.description).length);
  }

  /* host_permissions 与实际请求的域名要对得上。
     两个方向都查：声明了却不用 = 上架时要多解释一条权限；
     用了却没声明 = 运行时直接失败（而且很难看出原因）。 */
  const declared = new Set((mf.host_permissions || []).map((p) =>
    String(p).replace(/^https?:\/\//, '').replace(/\/\*$/, '').replace(/\/$/, '')));

  const used = new Set();
  let bg = '';
  try {
    bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  } catch (e) { /* 没这个文件时下面会各自报错 */ }
  const re = /https?:\/\/([a-z0-9.-]+)/gi;
  let m;
  while ((m = re.exec(bg))) used.add(m[1]);

  for (const h of used) {
    if (!declared.has(h)) bad('background.js 请求了 ' + h + '，但 host_permissions 里没有它');
  }
  for (const h of declared) {
    if (!used.has(h)) bad('host_permissions 声明了 ' + h + '，但 background.js 里没有请求它');
  }
  notes.push('host_permissions 与 background.js 的请求域名一致（' +
    [...declared].join(' / ') + '）');
}

/* ---------- 4. 加载顺序（content.js 依赖的共享模块必须排在它前面）---------- */

function rootJsFiles() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);
}

/* WT_NAME → 定义它的文件名（按 `root.WT_X = ` 找） */
const definedBy = {};
for (const f of rootJsFiles()) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const reDef = /root\.(WT_[A-Z0-9_]+)\s*=/g;
  let m;
  while ((m = reDef.exec(src))) definedBy[m[1]] = f;
}

if (mf && Array.isArray(mf.content_scripts)) {
  for (const cs of mf.content_scripts) {
    const list = cs.js || [];
    const idx = list.indexOf('content.js');
    if (idx === -1) continue;

    const before = list.slice(0, idx);
    const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

    const reUse = /globalThis\.(WT_[A-Z0-9_]+)/g;
    const need = new Set();
    let m;
    while ((m = reUse.exec(content))) need.add(m[1]);

    for (const name of need) {
      const file = definedBy[name];
      if (!file) {
        bad('content.js 读了 globalThis.' + name + '，但没有任何根目录 js 定义它');
        continue;
      }
      if (!before.includes(file)) {
        bad('加载顺序：content.js 读 globalThis.' + name + '（定义在 ' + file +
          '），但 ' + file + ' 没有排在 content.js 之前 —— 会拿到 undefined 而整段静默失效');
      }
    }
    notes.push('content.js 依赖 ' + [...need].join(' / ') + '，加载顺序正确');
  }
}

/* ---------- 5. `_locales` 与 `__MSG__`（#35 第 2 步 / #56）----------

   manifest 里的字符串**没法由 JS 改** —— 要本地化它们，只有 `_locales` +
   `__MSG_xxx__` 这一条路。而这条路上全是「错了就静默失效」的坑，全部在这里挡掉：

   - 加了 `_locales` 却忘了声明 `default_locale` → 扩展**直接拒绝加载**
   - `__MSG_xxx__` 少一个字母 → Chrome 把占位符原样显示出来（界面上出现 `__MSG_extName__`）
   - 某个语言少一个键 → 那个语言下显示的是默认语言的文案，**不报错**
   - 目录名写成 `zh-CN`（横线）→ Chrome 认不出来，静默退回默认语言
   - description 超 132 字符 → 上架被拒；而这一条现在**在 manifest 里看不出来**，
     因为它已经变成 `__MSG_extDesc__` 了 —— 必须去 _locales 里量 */
const LOCALES_DIR = path.join(ROOT, '_locales');

function localeDirs() {
  try {
    return fs.readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    return [];
  }
}

const locDirs = localeDirs();
const tables = {};

for (const d of locDirs) {
  /* Chrome 只认 `en` / `zh_CN` 这种写法。写成 `zh-CN` 不报错，但会被**静默忽略** ——
     表现是「我明明加了中文，怎么还是英文」，最难查的一类。 */
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(d)) {
    bad('_locales 目录名不合规范：' + d + '（要 `en` 或 `zh_CN` 这种；写成 `zh-CN` 会被 Chrome 静默忽略）');
  }
  try {
    tables[d] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, d, 'messages.json'), 'utf8'));
  } catch (e) {
    bad('_locales/' + d + '/messages.json 读不了或不是合法 JSON：' + e.message);
  }
}

const locNames = Object.keys(tables);

if (locNames.length && mf) {
  if (!mf.default_locale) {
    bad('有 _locales 但 manifest 没有声明 default_locale —— Chrome 会**直接拒绝加载**');
  } else if (!locDirs.includes(mf.default_locale)) {
    bad('default_locale = ' + mf.default_locale + '，但 _locales/' + mf.default_locale + ' 不存在');
  }
}

/* 各语言的消息键必须完全一致。少一个键不报错，只是那个语言下悄悄退回默认语言。 */
if (locNames.length > 1) {
  const base = locNames[0];
  for (const d of locNames.slice(1)) {
    const miss = Object.keys(tables[base]).filter((k) => !(k in tables[d]));
    const extra = Object.keys(tables[d]).filter((k) => !(k in tables[base]));
    if (miss.length || extra.length) {
      bad('_locales 各语言的消息键不一致：' + d +
        (miss.length ? ' 缺 ' + miss.join(',') : '') +
        (extra.length ? ' 多 ' + extra.join(',') : ''));
    }
  }
}

/* manifest 里出现的每一个 __MSG_xxx__ 都要在**每个**语言里有非空的值。 */
const msgRefs = new Set();
if (mf) {
  JSON.stringify(mf).replace(/__MSG_([A-Za-z0-9_]+)__/g, (all, k) => { msgRefs.add(k); return all; });
}
for (const k of msgRefs) {
  for (const d of locNames) {
    const entry = tables[d][k];
    if (!entry) {
      bad('manifest 用了 __MSG_' + k + '__，但 _locales/' + d + ' 里没有这个键');
    } else if (!String(entry.message || '').trim()) {
      bad('_locales/' + d + ' 的 ' + k + ' 是空的 —— 界面上会显示成空字符串');
    }
  }
}

/* 长度。两个上限不一样，别混：
   - manifest 的硬上限：name 75 / description 132
   - **商店的标题上限是 45** —— 超了上架会被拒或截断。这一条不是错误（扩展本身合法），
     所以只报一条提示，不进 exit code。 */
for (const d of locNames) {
  const desc = String((tables[d].extDesc || {}).message || '');
  const name = String((tables[d].extName || {}).message || '');
  if (desc.length > 132) {
    bad('_locales/' + d + ' 的 extDesc 有 ' + desc.length + ' 字符，超过 Chrome 的 132 上限');
  }
  if (name.length > 75) {
    bad('_locales/' + d + ' 的 extName 有 ' + name.length + ' 字符，超过 manifest 的 75 上限');
  } else if (name.length > 45) {
    notes.push('⚠️ _locales/' + d + ' 的 extName 有 ' + name.length +
      ' 字符 —— manifest 允许 75，但**商店的标题上限是 45**，上架时这一版会被拒或被截断');
  }
}

if (locNames.length) {
  notes.push('_locales：' + locNames.join(' / ') + '（default_locale = ' + (mf && mf.default_locale) +
    '），manifest 用了 ' + msgRefs.size + ' 个 __MSG__ 键');
}

/* ---------- 结果 ---------- */

console.log('划词翻译 · 文件与 manifest 自检');
console.log('目录：' + ROOT);
console.log('扫到 ' + all.length + ' 个文件 / 目录');
notes.forEach((n) => console.log('  · ' + n));

if (problems.length) {
  console.log('\n发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}

console.log('\n✅ 五项检查全部通过');
