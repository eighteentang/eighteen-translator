'use strict';

/* 划词翻译 · 图标导出
   ────────────────────────────────────────────────────────────────
   把 icons/ 下的 SVG 源文件渲染成 Chrome 需要的 PNG。

   为什么需要这个脚本，而不是「随手导一次就完事」：
   manifest 只认 PNG，不认 SVG。而 icons/ 里有两个源文件——
   icon.svg（32/48/128 用完整版）和 icon-16.svg（16px 用简化版）。
   哪一档用哪个文件、以及 16px 为什么要单独做一版，只有这个脚本知道。
   随手导一次，下一个人就会拿 icon.svg 缩到 16px，然后得到一个糊成白块的图标。

   依赖：puppeteer-core（不在 package.json 里，本项目扩展本体零依赖，这是开发脚本）
     npm i puppeteer-core            # 装在任意目录
     export NODE_PATH=<那个目录>/node_modules

   浏览器：自动探测 Chrome / Edge，也可以用 WT_BROWSER=<可执行文件路径> 指定。

   用法：
     node dev/export-icons.js              只导出 PNG
     node dev/export-icons.js --preview    额外出放大检查图与明暗底预览图
                                           （写到 dev/icon-preview/，不写进 icons/）
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'icons');
const FULL = path.join(DIR, 'icon.svg');
const SMALL = path.join(DIR, 'icon-16.svg');
const SIZES = [16, 32, 48, 128];

/* 检查图写到 dev/ 下，**不写进 icons/**。
   ⚠️ 它们原来叫 icons/_zoom.png / icons/_preview.png —— 扩展目录里任何以 `_`
   开头的名字都是 Chrome 的保留名（`_locales` / `_metadata` 除外），
   轻则拒绝加载、重则打包时踩雷。dev/ 下怎么写都无所谓，而且它们本来就不该
   出现在扩展本体里（dev/ 不进商店包，见 Issue #37）。 */
const PREVIEW_DIR = path.join(ROOT, 'dev', 'icon-preview');

// 每个尺寸用哪个源文件 —— 16px 单独简化，理由见 icons/icon-16.svg 的注释
const sourceFor = (n) => (n === 16 ? SMALL : FULL);

const WANT_PREVIEW = process.argv.includes('--preview');

function findBrowser() {
  const candidates = [
    process.env.WT_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome / Edge，请用 WT_BROWSER=<可执行文件路径> 指定');
}

async function main() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    console.error('缺少 puppeteer-core。先装：npm i puppeteer-core，并设置 NODE_PATH。');
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1'],
  });

  let failed = 0;
  try {
    const page = await browser.newPage();
    const sized = (file, n) =>
      fs.readFileSync(file, 'utf8').replace(/width="128" height="128"/, `width="${n}" height="${n}"`);

    // ---- 导出 ----
    for (const n of SIZES) {
      await page.setViewport({ width: n, height: n, deviceScaleFactor: 1 });
      await page.setContent(
        `<style>html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${n}px;height:${n}px}</style>${sized(sourceFor(n), n)}`,
        { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 120));
      const buf = await page.screenshot({ omitBackground: true });
      fs.writeFileSync(path.join(DIR, `icon${n}.png`), buf);
      console.log(`WROTE icons/icon${n}.png  ${buf.length} bytes  (源: ${path.basename(sourceFor(n))})`);
    }

    // ---- 校验：把 PNG 读回浏览器量真实像素 ----
    console.log('\n--- 校验 ---');
    for (const n of SIZES) {
      const b64 = fs.readFileSync(path.join(DIR, `icon${n}.png`)).toString('base64');
      const r = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++;
        let corner = 0;
        [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]]
          .forEach(([x, y]) => { corner += g.getImageData(x, y, 1, 1).data[3]; });
        return { w: img.naturalWidth, h: img.naturalHeight,
                 opaque: +(opaque / (c.width * c.height) * 100).toFixed(1), corner };
      }, b64);

      const okSize = r.w === n && r.h === n;
      const okCorner = r.corner === 0;      // 圆角之外必须透明，否则图标会是方块
      // 圆角方块理论填充率约 94.5%（rx=30 时四角各切约 1.4%），
      // 小尺寸抗锯齿会把边缘算成不透明，上限放到 97%。
      const okFill = r.opaque > 55 && r.opaque < 97;
      const pass = okSize && okCorner && okFill;
      if (!pass) failed++;
      console.log(`${pass ? 'PASS' : 'FAIL'} icon${n}.png  ${r.w}x${r.h}  ` +
        `不透明像素 ${r.opaque}%  四角 alpha 合计 ${r.corner}  ` +
        `${okSize ? '' : '[尺寸错] '}${okCorner ? '' : '[圆角外不是透明] '}${okFill ? '' : '[填充比异常]'}`);
    }

    if (WANT_PREVIEW) {
      fs.mkdirSync(PREVIEW_DIR, { recursive: true });
      const MAG = 8;
      await page.setViewport({ width: 920, height: 620, deviceScaleFactor: 1 });
      await page.setContent(`<style>
        html,body{margin:0;background:#fff;font:12px system-ui,sans-serif}
        .wrap{display:flex;gap:22px;padding:22px;align-items:flex-start;flex-wrap:wrap}
        .z{display:flex;flex-direction:column;align-items:center;gap:8px}
        .stage{background:#f4f5f7;border-radius:10px;padding:10px;display:flex}
        img{display:block;image-rendering:pixelated}
        span{color:#555}
      </style><div class="wrap">${[16, 32, 48].map((n) => `
        <div class="z"><div class="stage"><img style="width:${n * MAG}px;height:${n * MAG}px"
          src="data:image/png;base64,${fs.readFileSync(path.join(DIR, `icon${n}.png`)).toString('base64')}"></div>
          <span>${n}px ×${MAG}</span></div>`).join('')}</div>`, { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(path.join(PREVIEW_DIR, 'zoom.png'), await page.screenshot({ fullPage: true }));

      const cell = (n, dark) => `
        <div class="cell" style="background:${dark ? '#1f1f1f' : '#f4f5f7'}">
          <div class="box">${sized(sourceFor(n), n)}</div>
          <span style="color:${dark ? '#bbb' : '#666'}">${n}px</span>
        </div>`;
      await page.setViewport({ width: 660, height: 360, deviceScaleFactor: 2 });
      await page.setContent(`<style>
        html,body{margin:0;background:#fff;font:12px system-ui,sans-serif}
        .row{display:flex;align-items:flex-end;gap:24px;padding:20px 24px}
        .cell{display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 16px;border-radius:10px}
        .box{display:flex;align-items:center;justify-content:center}
        .box svg{display:block}
      </style>
      <div class="row">${SIZES.slice().reverse().map((n) => cell(n, false)).join('')}</div>
      <div class="row">${SIZES.slice().reverse().map((n) => cell(n, true)).join('')}</div>`,
        { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(path.join(PREVIEW_DIR, 'preview.png'), await page.screenshot({ fullPage: true }));
      console.log('\nWROTE dev/icon-preview/zoom.png 与 dev/icon-preview/preview.png（已 gitignore）');
    }
  } finally {
    await browser.close();
  }

  if (failed) { console.error(`\n${failed} 项校验未通过`); process.exit(1); }
  console.log('\n全部校验通过');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
