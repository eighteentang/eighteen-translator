/* 划词翻译 · 打包（Issue #37）
   ────────────────────────────────────────────────────────────────
   一条命令产出**可提交商店**的 zip：

       node dev/pack.js

   为什么不用 `zip` 命令 / `archiver`：
   本项目零依赖是刻意的。系统 `zip` 在 Windows 上不一定有，
   `archiver` 会带进一棵依赖树。ZIP 的「store + deflate」两种写法
   用 `node:zlib` 就能拼出来，一次性成本约 150 行。

   ⚠️ **白名单，不是黑名单**：
   只打包「manifest 声明到的文件 + HTML 引用到的文件 + `icons/` + `_locales/`」。
   黑名单（排除 `dev/`、`README`…）的问题在于 —— 将来新增一个开发文件，
   忘了加进忽略列表就会**悄悄进包**。白名单相反：新文件默认不进包，
   要它进包就得先在 manifest 或 HTML 里被引用（那正是它该在的地方）。

   ⚠️ **HTML 那一层不能漏**：`options.js` / `popup.js` 只被
   `options.html` / `popup.html` 的 `<script src>` 引用，**manifest 里根本看不到它们**。
   只按 manifest 收，打出来的包一装就是「设置页空白」。
   所以这里会把 HTML 里的 `src` / `href` 也扫一遍（相对路径才收）。

   产物：`dist/eighteen-translator-v<版本号>.zip`，版本号取自 manifest.json
   （与 #42 的「manifest 是单一真源」一致，所以包名不会和版本号脱节）。

   ⚠️ `dist/` 已进 .gitignore —— zip 是构建产物，不进版本库；
   发版时挂到 GitHub Release 上（见 #42 / #37）。

   零依赖、纯 Node。跑法：node dev/pack.js
*/

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* ---------- CRC32（ZIP 每个条目都要） ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* DOS 时间戳：ZIP 只认这套格式，年份从 1980 起、秒按 2 秒精度 */
function dosStamp(date) {
  const y = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/* ---------- 白名单 ---------- */

function collectWhitelist(mf) {
  const set = new Set();
  const add = (p) => {
    if (!p || typeof p !== 'string') return false;
    const clean = p.replace(/^\.\//, '').replace(/^\/+/, '');
    if (!clean || set.has(clean)) return false;
    set.add(clean);
    return true;
  };

  add('manifest.json');

  if (mf.background && mf.background.service_worker) add(mf.background.service_worker);
  (mf.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  });
  if (mf.action) {
    add(mf.action.default_popup);
    const di = mf.action.default_icon;
    if (typeof di === 'string') add(di);
    else if (di && typeof di === 'object') Object.values(di).forEach(add);
  }
  if (mf.options_page) add(mf.options_page);
  if (mf.options_ui && mf.options_ui.page) add(mf.options_ui.page);
  if (typeof mf.icons === 'object' && mf.icons) Object.values(mf.icons).forEach(add);

  /* ⚠️ 再走一遍 HTML：manifest 只看得到页面本身，看不到页面里引的脚本。
     漏了这一层，包里就没有 options.js / popup.js。 */
  let frontier = [...set].filter((p) => /\.html?$/i.test(p));
  const seen = new Set(frontier);
  while (frontier.length) {
    const next = [];
    frontier.forEach((htmlRel) => {
      const abs = path.join(ROOT, htmlRel);
      if (!fs.existsSync(abs)) return;
      const html = fs.readFileSync(abs, 'utf8');
      const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
      let m = re.exec(html);
      while (m) {
        const ref = m[1].split('#')[0].split('?')[0];
        /* 外链、协议相对、data:、锚点一律跳过 */
        if (ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) && !ref.startsWith('#')) {
          const rel = path.posix.normalize(path.posix.join(path.posix.dirname(htmlRel), ref));
          if (add(rel) && /\.html?$/i.test(rel) && !seen.has(rel)) {
            seen.add(rel);
            next.push(rel);
          }
        }
        m = re.exec(html);
      }
    });
    frontier = next;
  }

  /* `icons/` 与 `_locales/` 整目录收进来：
     - `_locales` 的目录结构是 Chrome 运行时按 locale 名解析的，
       manifest 里不出现文件名，只列 manifest 引用会漏掉所有非默认语言；
     - `icons/` 里另有 2 个 .svg 源文件（manifest 只认 PNG，所以引用不到），
       一并带上，让下载 zip 的人能看到图标是怎么来的。 */
  ['icons', '_locales'].forEach((dir) => {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) walk(abs, dir, set);
  });

  return set;
}

function walk(absDir, relDir, set) {
  fs.readdirSync(absDir, { withFileTypes: true }).forEach((ent) => {
    const rel = relDir + '/' + ent.name;
    if (ent.isDirectory()) walk(path.join(absDir, ent.name), rel, set);
    else if (ent.isFile()) set.add(rel);
  });
}

/* ---------- 组装 zip ---------- */

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const raw = zlib.deflateRawSync(e.data, { level: 9 });
    /* 压不动就退回 store —— 小文件 deflate 有时反而更大 */
    const useDeflate = raw.length < e.data.length;
    const body = useDeflate ? raw : e.data;
    const method = useDeflate ? 8 : 0;
    const stamp = dosStamp(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // flag：文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);      // extra length

    localParts.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(stamp.time, 12);
    cd.writeUInt16LE(stamp.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);         // extra
    cd.writeUInt16LE(0, 32);         // comment
    cd.writeUInt16LE(0, 34);         // disk number start
    cd.writeUInt16LE(0, 36);         // internal attrs
    cd.writeUInt32LE(0o644 << 16, 38); // external attrs
    cd.writeUInt32LE(offset, 42);    // 本条目 local header 的偏移

    centralParts.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  });

  const cdBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, cdBuf, eocd]);
}

/* ---------- 把产物读回来 ---------- */

function readCentralDirectory(buf) {
  let p = buf.length - 22;
  while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) p -= 1;
  if (p < 0) throw new Error('找不到 EOCD —— 产出的不是合法 zip');

  const count = buf.readUInt16LE(p + 10);
  let off = buf.readUInt32LE(p + 16);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('第 ' + (i + 1) + ' 条中央目录记录的签名不对 —— 产出的 zip 结构有问题');
    }
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    out.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      method: buf.readUInt16LE(off + 10),
      crc: buf.readUInt32LE(off + 16),
      compSize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      localOffset: buf.readUInt32LE(off + 42)
    });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/* 逐条解压回来，和源文件逐字节比对 ——
   结构合法还不够，得证明**内容**真的能还原（deflate 写错、CRC 写错都在这里暴露）。 */
function verifyRoundTrip(zip, cd, entries) {
  const byName = new Map(entries.map((e) => [e.name, e.data]));

  cd.forEach((rec) => {
    const src = byName.get(rec.name);
    if (!src) throw new Error('zip 里有源文件之外的条目：' + rec.name);

    const lo = rec.localOffset;
    if (zip.readUInt32LE(lo) !== 0x04034b50) {
      throw new Error(rec.name + ' 的 local header 签名不对');
    }
    const nameLen = zip.readUInt16LE(lo + 26);
    const extraLen = zip.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const body = zip.subarray(start, start + rec.compSize);

    let data;
    if (rec.method === 8) data = zlib.inflateRawSync(body);
    else if (rec.method === 0) data = body;
    else throw new Error(rec.name + ' 的压缩方式 ' + rec.method + ' 不是我们写的（只会有 0 或 8）');

    if (data.length !== src.length) {
      throw new Error(rec.name + ' 解压后 ' + data.length + ' B，源文件 ' + src.length + ' B');
    }
    if (crc32(data) !== rec.crc) {
      throw new Error(rec.name + ' 解压后的 CRC32 与记录不符');
    }
    if (!data.equals(src)) {
      throw new Error(rec.name + ' 解压后与源文件内容不一致');
    }
  });
}

/* ---------- 主流程 ---------- */

function main() {
  const mfPath = path.join(ROOT, 'manifest.json');
  let mf;
  try {
    mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  } catch (e) {
    console.error('✗ 读不了 manifest.json：' + e.message);
    process.exit(1);
  }

  const version = String(mf.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('✗ manifest.json 的 version 是「' + version + '」，不是 x.y.z 三段');
    process.exit(1);
  }

  const wanted = [...collectWhitelist(mf)].sort();
  const problems = [];
  const entries = [];

  wanted.forEach((rel) => {
    /* 防御：以 `_` 开头的名字（`_locales` / `_metadata` 除外）会让 Chrome 直接拒绝加载。
       check.js 已经递归查过一遍，这里再挡一次 —— 打包是最后一道门。 */
    const base = path.basename(rel);
    if (base.startsWith('_') && !rel.startsWith('_locales/') && !rel.startsWith('_metadata/')) {
      problems.push(rel + ' —— 以 `_` 开头的文件不能进扩展包（Chrome 保留名）');
      return;
    }

    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      problems.push(rel + ' —— 不存在（manifest 或 HTML 引用了它，但文件不在）');
      return;
    }
    const stat = fs.statSync(abs);
    entries.push({ name: rel, data: fs.readFileSync(abs), mtime: stat.mtime });
  });

  if (problems.length) {
    console.error('✗ 打包前检查没过：');
    problems.forEach((p) => console.error('   · ' + p));
    process.exit(1);
  }

  /* 兜底：白名单万一被改错，别让开发文件悄悄进包 */
  const FORBIDDEN = [/^dev\//, /^\.git/, /^README/i, /^LICENSE$/, /^docs\//, /^CHANGELOG/i];
  const leaked = entries.filter((e) => FORBIDDEN.some((re) => re.test(e.name)));
  if (leaked.length) {
    console.error('✗ 这些文件不该进包：' + leaked.map((e) => e.name).join('、'));
    process.exit(1);
  }

  const zip = buildZip(entries);

  let cd;
  try {
    cd = readCentralDirectory(zip);
    if (cd.length !== entries.length) {
      throw new Error('zip 里读出 ' + cd.length + ' 条，期望 ' + entries.length + ' 条');
    }
    verifyRoundTrip(zip, cd, entries);
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }

  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, 'eighteen-translator-v' + version + '.zip');
  fs.writeFileSync(out, zip);

  const raw = entries.reduce((n, e) => n + e.data.length, 0);
  console.log('划词翻译 · 打包');
  console.log('版本：' + version + '（取自 manifest.json）');
  console.log('条目：' + entries.length + ' 个');
  entries.forEach((e) => {
    console.log('  · ' + e.name + '  (' + e.data.length + ' B)');
  });
  console.log('原始 ' + raw + ' B → 压缩后 ' + zip.length + ' B' +
    '（' + Math.round((1 - zip.length / raw) * 100) + '% 省下）');
  console.log('产物：' + out);
  console.log('\n✅ 打包完成：结构已解析、每条内容已解压回来逐字节比对');
}

main();
