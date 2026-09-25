'use strict';

/* 划词翻译 · 浮层端到端验证
   ────────────────────────────────────────────────────────────────
   dev/selftest.js 用 mock 测的是后台逻辑（引擎调度、错误文案、配额分支）。
   它测不到「浮层到底有没有出现」——那需要真实的浏览器、真实的扩展加载、
   真实的 DOM。这个脚本补的就是这一段。

   为什么值得单独写：浮层不出现时，肉眼只能看到「什么都没发生」，
   而可能的原因有七八个（脚本没注入 / 选区为空 / 定位跑到视口外 /
   被页面元素盖住 / 开关被关掉 / 扩展上下文失效…）。这个脚本把它们逐条拆开断言。

   依赖：puppeteer-core（开发脚本，扩展本体零依赖）
     npm i puppeteer-core && export NODE_PATH=<那个目录>/node_modules

   浏览器：自动探测 Chrome / Edge，也可用 WT_BROWSER=<可执行文件路径> 指定。
   注意：Chrome / Edge 的新无头模式支持加载扩展；老式 --headless 不支持。

   用法：node dev/e2e-panel.js
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const PORT = 8971;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>panel e2e</title>
<style>
  body{font:16px/1.7 system-ui,sans-serif;margin:0;padding:40px 60px;max-width:760px}
  p{margin:0 0 22px}
  .box{height:1400px}
</style></head><body>
<p id="p1">Translation is the communication of meaning from one language to another. A translator must decide whether to preserve form or sense.</p>
<p id="p2">The quick brown fox jumps over the lazy dog near the riverbank at dawn.</p>
<!-- #22 的样本：第一行**明显比第二行短**。
     用整段包围盒的中心定位，浮层会跑到第二行中间；用首行的中心才是用户眼睛所在的地方。 -->
<p id="ragged">Short first line.<br>But the second line goes on and on and is much wider than the first one.</p>
<p id="code1">const x = await fetch('/api/v1/items.json');</p>
<div class="box"></div>
<p id="p3">A third paragraph sits far below the fold so we can test scrolling behaviour.</p>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 读浮层状态：宿主要从 document 拿（shadow 内容对 document 不可见）
const probe = (page) => page.evaluate(() => {
  const h = document.getElementById('wt-translate-host');
  if (!h) return { exists: false };
  const sr = h.shadowRoot;
  const p = sr && sr.querySelector('.panel');
  const cs = p ? getComputedStyle(p) : null;
  const r = p ? p.getBoundingClientRect() : null;
  return {
    exists: true, shadow: !!sr, panelFound: !!p,
    display: cs ? cs.display : null,
    width: r ? Math.round(r.width) : 0, height: r ? Math.round(r.height) : 0,
    top: r ? Math.round(r.top) : null, left: r ? Math.round(r.left) : null,
    text: p ? (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140) : null,
    hostZ: getComputedStyle(h).zIndex, hostPos: getComputedStyle(h).position,
  };
});

/* 显式建立选区再派发 mouseup。
   不用真实鼠标拖选，是因为无头模式下拖选经常建立不起选区（实测长度 0），
   而这里要验的是「content script 拿到非空选区后浮层出不出来」，
   不是浏览器的拖选手感。content script 也不检查 isTrusted。 */
const selectAndMouseUp = (page, id) => page.evaluate((id) => {
  const el = document.getElementById(id);
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  return s.toString().trim().length;
}, id);

async function main() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    console.error('缺少 puppeteer-core。先装：npm i puppeteer-core，并设置 NODE_PATH。');
    process.exit(2);
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profile = path.join(os.tmpdir(), 'wt-e2e-prof-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  const results = [];
  const ok = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
  };

  try {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    // 注入检测必须走 CDP 执行上下文：page.evaluate 跑在页面主世界，
    // content script 在隔离世界，主世界看不到 chrome.runtime。
    const cdp = await page.createCDPSession();
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
    await cdp.send('Runtime.enable');

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await sleep(1000);

    const extCtx = contexts.filter((c) => /chrome-extension|划词翻译|eighteen/i.test(
      (c.name || '') + (c.origin || '')));
    ok('content script 已注入', extCtx.length > 0,
      extCtx.length ? extCtx.map((c) => c.name || c.origin).join(' , ')
                    : `共 ${contexts.length} 个上下文，无扩展来源`);

    // ---- 选区 + mouseup → 浮层 ----
    await selectAndMouseUp(page, 'p1');
    await sleep(1600);                       // DEBOUNCE 220ms + 请求往返
    let h = await probe(page);
    ok('#wt-translate-host 已插入 DOM', h.exists,
      h.exists ? `position=${h.hostPos} z-index=${h.hostZ}` : '不存在');

    // 主题写在宿主元素上（CSS 靠 :host([data-theme="dark"]) 取）
    const hostTheme = h.exists ? await page.evaluate(() =>
      document.getElementById('wt-translate-host').getAttribute('data-theme')) : null;
    ok('浮层宿主带上了主题属性', hostTheme === 'light' || hostTheme === 'dark',
      `data-theme=${hostTheme}`);
    ok('Shadow DOM 与 .panel 已创建', !!h.shadow && !!h.panelFound);
    ok('.panel 处于可见状态', h.display === 'block', `display=${h.display}`);
    ok('浮层尺寸非零', h.width > 0 && h.height > 0, `${h.width} x ${h.height}`);

    if (h.panelFound && h.width > 0) {
      ok('浮层落在视口内', h.top >= 0 && h.left >= 0 &&
        h.top + h.height <= 800 && h.left + h.width <= 1100, `@ (${h.left}, ${h.top})`);
      ok('浮层有内容', !!h.text, JSON.stringify(h.text));
      /* #58：未配置凭据是最常见的「装了没反应」。光给一句话等于把用户丢在原地
         （他得自己找到扩展菜单里的「选项」），所以错误下方必须有一个能点的路。
         这一条与「首次安装自动打开设置页」互为兜底 —— 后者可能被浏览器拦掉。 */
      ok('未配置凭据时，浮层给出可点的「去设置」', /去设置/.test(h.text || ''),
        JSON.stringify(h.text));
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return 'null';
        // 点在 shadow 内容上时 document.elementFromPoint 返回的是**宿主元素**，
        // 所以比 host 的 id。用 el.getRootNode().host 判断是错的 ——
        // 宿主的根节点是 document，document 没有 .host，会永远判成「被盖住」。
        return el.id === 'wt-translate-host' ? 'wt-host'
          : el.tagName + (el.id ? '#' + el.id : '');
      }, [h.left + h.width / 2, h.top + h.height / 2]);
      ok('浮层中心可命中（未被页面盖住）', hit === 'wt-host', `命中: ${hit}`);
    }

    // ---- 滚动跟随 ----
    if (h.panelFound) {
      await page.evaluate(() => window.scrollBy(0, 240));
      await sleep(400);
      const a = await probe(page);
      ok('滚动后浮层仍在并重新定位', a.display === 'block', `top ${h.top} → ${a.top}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);
    }

    /* ---- resize 不再关掉浮层（#22）----
       这原来是 `window.addEventListener('resize', close)` ——
       拖一下窗口、或移动端旋转，浮层就没了。那不是设计，是顺手写的。
       改成重新定位之后，除了「还在」，还要确认它**按新视口重算过** ——
       所以顺带断言它落在新视口里面。 */
    const beforeR = await probe(page);
    await page.setViewport({ width: 900, height: 700 });
    await sleep(500);
    const afterR = await probe(page);
    ok('改窗口尺寸后浮层重新定位，而不是直接关掉（#22）',
      afterR.display === 'block',
      `display ${beforeR.display} → ${afterR.display}`);
    ok('重新定位之后落在新的视口内（#22）',
      afterR.top >= 0 && afterR.left >= 0
        && afterR.top + afterR.height <= 700 && afterR.left + afterR.width <= 900,
      `@ (${afterR.left}, ${afterR.top}) ${afterR.width}x${afterR.height} · 视口 900x700`);
    await page.setViewport({ width: 1100, height: 800 });
    await sleep(400);

    // ---- Esc 关闭 ----
    await page.keyboard.press('Escape');
    await sleep(250);
    let a = await probe(page);
    ok('Esc 能关闭浮层', a.exists && a.display === 'none', `display=${a.display}`);

    // ---- 关闭后可重新打开 ----
    await selectAndMouseUp(page, 'p2');
    await sleep(1600);
    a = await probe(page);
    ok('关闭后可再次划词打开', a.display === 'block', `display=${a.display}`);

    /* ---- 跨行选区按「首行」定位（#22）----
       ragged 那一段的第一行明显比第二行短：用整段包围盒的中心定位，
       浮层会跑到第二行中间；用首行的中心才是用户眼睛所在的地方。
       断言写成「离首行中心更近」而不是「等于某个像素」—— 后者会绑死在字体度量上。 */
    await selectAndMouseUp(page, 'ragged');
    await sleep(1600);
    const rag = await page.evaluate(() => {
      const s = window.getSelection();
      const range = s.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      const first = rects.reduce((x, y) => (y.top < x.top ? y : x));
      const last = rects.reduce((x, y) => (y.bottom > x.bottom ? y : x));
      const box = range.getBoundingClientRect();
      return {
        n: rects.length,
        firstLeft: first.left,
        firstCenter: first.left + first.width / 2,
        boxCenter: box.left + box.width / 2,
        lastBottom: last.bottom,
      };
    });
    const rp = await probe(page);
    const panelCenter = rp.left + rp.width / 2;
    ok('跨行选区按「首行」定位，而不是整段包围盒的中心（#22）',
      rag.n >= 2
        && Math.abs(panelCenter - rag.firstCenter) < Math.abs(panelCenter - rag.boxCenter),
      `rects=${rag.n} 浮层中心=${Math.round(panelCenter)}`
        + ` 首行中心=${Math.round(rag.firstCenter)} 包围盒中心=${Math.round(rag.boxCenter)}`);
    /* 这一段的首行贴着视口左边，居中会让浮层溢出 —— 正好验「换边而不是硬夹」。
       硬夹的结果是 left=8（视口边缘），换边之后应该对齐**选区左缘**。 */
    ok('贴边时横向换边对齐选区，而不是硬夹到视口边（#22）',
      rag.firstLeft > 20 && Math.abs(rp.left - rag.firstLeft) < 2,
      `浮层左=${rp.left} 首行左=${Math.round(rag.firstLeft)}（硬夹会是 8）`);
    ok('浮层与选区之间留出空隙，不盖住选区（#22）',
      rp.top >= Math.round(rag.lastBottom) + 6,
      `浮层顶=${rp.top} 选区底=${Math.round(rag.lastBottom)}`
        + ` 间隙=${rp.top - Math.round(rag.lastBottom)}px`);

    // ---- 超长选区（> MAX_LEN 1000）：不再静默无反应，改为给一条可读说明（#14）----
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'long';
      el.textContent = 'word '.repeat(400);
      document.body.appendChild(el);
    });
    await selectAndMouseUp(page, 'long');
    await sleep(900);
    a = await probe(page);
    /* 旧行为是直接 close()，用户划了一大段什么都没发生 —— 比「翻译质量下降」更困惑。
       现在弹一条说明，并且**不发请求**（省一次计费）。 */
    ok('超长选区给出说明而不是静默无反应',
      a.display === 'block' && /超过 1000 的上限/.test(a.text || '')
        && /选中了 \d{4} 个字符/.test(a.text || ''),
      `display=${a.display} text=${JSON.stringify(a.text)}`);
    await page.keyboard.press('Escape');
    await sleep(250);

    // ---- 取消机制（Issue #1）----
    /* selftest.js 能证明「取消信号会传到 fetch」，但证明不了
       「content.js 的 close() 真的会主动发 cancel」—— 那需要真实的扩展在跑。
       做法：给 service worker 装一个假 key 让请求真的走到 fetch，
       再把 fetch 换成永不返回的探针 —— 就是「上一次还在生成、用户又划了一次」的场景。 */
    const swTarget = (await browser.targets()).find(
      (t) => t.type() === 'service_worker' && /^chrome-extension:/.test(t.url()));
    const worker = swTarget ? await swTarget.worker() : null;

    if (!worker) {
      ok('能拿到 service worker 上下文', false, 'service worker 不在运行，取消机制无法验证');
    } else {
      ok('能拿到 service worker 上下文', true);

      await worker.evaluate(() => {
        globalThis.__wtOrigFetch = globalThis.fetch;
        globalThis.__wtCalls = [];
        chrome.storage.local.set({ engine: 'deepseek', deepseekKey: 'sk-fake-for-e2e' });
        globalThis.fetch = (url, opts) => {
          const rec = { url: String(url), aborted: false };
          globalThis.__wtCalls.push(rec);
          return new Promise((resolve, reject) => {
            const sig = opts && opts.signal;
            if (!sig) return;                       // 没有 signal 就一直挂着
            sig.addEventListener('abort', () => {
              rec.aborted = true;
              const e = new Error('The user aborted a request.');
              e.name = 'AbortError';
              reject(e);
            });
          });
        };
      });
      await sleep(200);

      // 间隔 400ms > DEBOUNCE(220ms)，所以三次都会真的发出去；
      // 而探针 fetch 永不返回，上一次必然还在「生成中」。
      await selectAndMouseUp(page, 'p1');
      await sleep(400);
      await selectAndMouseUp(page, 'p2');
      await sleep(400);
      await selectAndMouseUp(page, 'p3');
      await sleep(400);

      let calls = await worker.evaluate(() =>
        globalThis.__wtCalls.map((c) => ({ url: c.url, aborted: c.aborted })));
      const ds = calls.filter((c) => /api\.deepseek\.com/.test(c.url)).length;
      ok('连划三次，三次请求都发出去了', calls.length === 3 && ds === 3,
        `共 ${calls.length} 次 fetch（DeepSeek ${ds} 次）`);
      ok('新请求到达时，前两次已被 abort',
        calls.length === 3 && calls[0].aborted === true && calls[1].aborted === true
          && calls[2].aborted === false,
        calls.map((c, i) => `#${i + 1}:${c.aborted ? 'aborted' : 'running'}`).join(' '));

      // Esc 关浮层 → close() 应该把最后那个也停掉，否则它会跑完并计费
      await page.keyboard.press('Escape');
      await sleep(500);
      calls = await worker.evaluate(() => globalThis.__wtCalls.map((c) => c.aborted));
      ok('关闭浮层后，在飞的请求也被取消',
        calls.length === 3 && calls[2] === true,
        calls.map((v, i) => `#${i + 1}:${v ? 'aborted' : 'running'}`).join(' '));

      /* ---- 跳过技术内容（#60）----
         这一段验的是**没发请求** —— 那正是这条 issue 的全部意义（省钱 + 不干扰）。
         判定函数本身由 selftest.js 直接断言；这里验的是接线：
         拦住了没有、拦的是什么说不说得清、出口在不在、点了出口之后请求发不发。 */
      const before60 = await worker.evaluate(() => globalThis.__wtCalls.length);
      await selectAndMouseUp(page, 'code1');
      await sleep(900);
      const t60 = await probe(page);
      const after60 = await worker.evaluate(() => globalThis.__wtCalls.length);

      ok('技术内容被拦下，并说明拦的是什么（#60）',
        t60.display === 'block' && /已跳过翻译/.test(t60.text || '')
          && /文件路径/.test(t60.text || ''),
        `display=${t60.display} text=${JSON.stringify(t60.text)}`);
      ok('被拦下时一个请求都没发出去（#60）', after60 === before60,
        `fetch 次数 ${before60} → ${after60}`);

      /* 误判出口。判定是启发式的，一定会误伤 —— 有这个出口，
         「默认开」才成立；没有它，默认开就等于替用户决定了「这段你不许翻」。 */
      ok('浮层给出「仍然翻译」的出口（#60）', /仍然翻译/.test(t60.text || ''),
        JSON.stringify(t60.text));

      const alt60 = await page.evaluate(() => {
        const el = document.getElementById('wt-translate-host');
        const b = [...el.shadowRoot.querySelectorAll('.act')]
          .find((x) => x.textContent === '仍然翻译');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (alt60) {
        await page.mouse.click(alt60.x, alt60.y);
        await sleep(800);
      }
      const afterAlt = await worker.evaluate(() => globalThis.__wtCalls.length);
      ok('点「仍然翻译」之后请求照发（#60）',
        !!alt60 && afterAlt === before60 + 1,
        `点击=${!!alt60} fetch 次数 ${after60} → ${afterAlt}`);

      /* ---- 手动模式（#6）----
         这一段的重点是「**选中之后一次请求都不发**」—— 那正是它比自动模式更省钱的地方
         （自动模式是「先发出去、再取消」，那部分输入 token 已经计费）。 */
      await worker.evaluate(() => chrome.storage.local.set({ triggerMode: 'manual' }));
      await sleep(400);   // 等 content script 的 storage.onChanged 落到自己的 cfg 上

      const beforeM = await worker.evaluate(() => globalThis.__wtCalls.length);
      await selectAndMouseUp(page, 'p2');
      await sleep(800);
      const m1 = await probe(page);
      const afterM = await worker.evaluate(() => globalThis.__wtCalls.length);

      const dotInfo = await page.evaluate(() => {
        const el = document.getElementById('wt-translate-host');
        const d = el && el.shadowRoot ? el.shadowRoot.querySelector('.dot') : null;
        if (!d) return null;
        const r = d.getBoundingClientRect();
        const cs = getComputedStyle(d);
        return {
          text: d.textContent,
          w: Math.round(r.width), h: Math.round(r.height),
          border: parseFloat(cs.borderTopWidth),
          shadow: cs.boxShadow,
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)
        };
      });

      ok('手动模式下选中只出小圆点，一个请求都不发（#6）',
        m1.display === 'block' && !!dotInfo && afterM === beforeM,
        `display=${m1.display} 圆点=${!!dotInfo} fetch ${beforeM} → ${afterM}`);

      /* 圆点必须**看起来就能点** —— 参考 popup 主题按钮那次的教训：
         裸图标和背景分不开，用户根本不知道那儿有东西。所以量出来，
         不靠「我觉得挺明显」。 */
      ok('小圆点肉眼可分：直径 ≥ 20px，且有描边与阴影（#6）',
        !!dotInfo && dotInfo.w >= 20 && dotInfo.h >= 20
          && dotInfo.border >= 1 && dotInfo.shadow !== 'none',
        dotInfo
          ? `${dotInfo.w}x${dotInfo.h} 描边=${dotInfo.border}px 阴影=${dotInfo.shadow}`
          : '没找到 .dot');

      if (dotInfo) {
        await page.mouse.click(dotInfo.x, dotInfo.y);
        await sleep(900);
      }
      const afterDot = await worker.evaluate(() => globalThis.__wtCalls.length);
      ok('点了小圆点之后才真的发请求（#6）',
        !!dotInfo && afterDot === beforeM + 1,
        `fetch ${afterM} → ${afterDot}`);

      // 还原，别影响后面的用例
      await worker.evaluate(() => chrome.storage.local.set({ triggerMode: 'auto' }));
      await sleep(400);

      /* ---- 等待体验（#20）----
         三段：等待态看得见在动、慢响应时把「是不是卡死了」提前答掉、失败后能一键重试。

         ⚠️ 这里必须用**还没被缓存过**的文本。上面几段里 p1 从没成功返回过
         （探针 fetch 永不 resolve），所以缓存里没有它 —— 一旦这里命中缓存，
         就根本不会进入等待态，整段断言都会以莫名其妙的方式失败。 */
      await selectAndMouseUp(page, 'p1');
      await sleep(600);   // 越过 DEBOUNCE(220)，但还没到 SLOW_MS(3000)
      const w1 = await probe(page);
      const dots = await page.evaluate(() => {
        const el = document.getElementById('wt-translate-host');
        const w = el && el.shadowRoot ? el.shadowRoot.querySelector('.wait') : null;
        return w ? { n: w.querySelectorAll('i').length } : null;
      });
      ok('等待态有进度指示，不只是三个字（#20）',
        /翻译中/.test(w1.text || '') && !!dots && dots.n === 3,
        `text=${JSON.stringify(w1.text)} 圆点数=${dots ? dots.n : '没找到 .wait'}`);

      await sleep(3000);   // 越过 SLOW_MS
      const w2 = await probe(page);
      ok('慢响应时补一句「请稍候」，把「是不是卡死了」提前答掉（#20）',
        /请稍候/.test(w2.text || ''), JSON.stringify(w2.text));

      /* 失败 → 重试。这条是 #20 里真正的价值：
         以前失败之后唯一的出路是**重新划一次词**。 */
      await worker.evaluate(() => {
        globalThis.__wtFailCalls = 0;
        globalThis.fetch = async () => {
          globalThis.__wtFailCalls++;
          throw new TypeError('Failed to fetch');
        };
      });
      await sleep(200);

      await selectAndMouseUp(page, 'p2');
      await sleep(1200);
      const f1 = await probe(page);
      ok('失败后给出「重试」按钮（#20）', /重试/.test(f1.text || ''), JSON.stringify(f1.text));

      const retryPos = await page.evaluate(() => {
        const el = document.getElementById('wt-translate-host');
        const b = [...el.shadowRoot.querySelectorAll('.act')]
          .find((x) => x.textContent === '重试');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (retryPos) {
        await page.mouse.click(retryPos.x, retryPos.y);
        await sleep(1000);
      }
      const failCalls = await worker.evaluate(() => globalThis.__wtFailCalls);
      ok('点「重试」会重新发一次请求，不用重新划词（#20）',
        !!retryPos && failCalls === 2,
        `点击=${!!retryPos} 请求数=${failCalls}（首次 + 重试 = 2）`);

      // 收拾干净，别影响后面的 popup / 开关测试
      await worker.evaluate(() => {
        globalThis.fetch = globalThis.__wtOrigFetch;
        chrome.storage.local.set({ deepseekKey: '' });
      });
      await sleep(200);

      /* ---- 复制（#13）----
         这一段验「复制这条路在重写之后还走得通」（回退链、按钮状态机）。

         ⚠️ 它验不到 #13 真正修的那个失败：测试页跑在 127.0.0.1，按规范它属于
         **安全上下文**，`navigator.clipboard` 在那里是存在的 —— 所以
         「http 页面 → clipboard 不存在 → 走 execCommand 回退」这条分支不会被走到。
         **真实 http 页面上的回退没有验证过。** */
      await worker.evaluate(() => {
        chrome.storage.local.set({ engine: 'deepseek', deepseekKey: 'sk-fake-for-e2e' });
        globalThis.fetch = async () => ({
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: 'E2E 译文' } }] })
        });
      });
      await sleep(200);

      await selectAndMouseUp(page, 'p1');
      await sleep(1200);
      const c1 = await probe(page);
      ok('拿到译文后浮层显示译文', /E2E 译文/.test(c1.text || ''), JSON.stringify(c1.text));

      // 复制按钮要**真的用鼠标点**：程序化 element.click() 不构成用户激活，
      // 剪贴板 API 会直接拒绝 —— 那样测出来的失败是假的。
      const copyPos = await page.evaluate(() => {
        const el = document.getElementById('wt-translate-host');
        const b = [...el.shadowRoot.querySelectorAll('.btn')]
          .find((x) => x.textContent === '复制');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (copyPos) {
        await page.mouse.click(copyPos.x, copyPos.y);
        await sleep(400);
        const c2 = await probe(page);
        ok('点「复制」后按钮变成「已复制」', /已复制/.test(c2.text || ''),
          JSON.stringify(c2.text));
      } else {
        ok('点「复制」后按钮变成「已复制」', false, '没找到复制按钮');
      }

      await worker.evaluate(() => {
        globalThis.fetch = globalThis.__wtOrigFetch;
        chrome.storage.local.set({ deepseekKey: '' });
      });
      await sleep(200);
    }

    // ---- popup 页面 ----
    const sw = (await browser.targets()).find(
      (t) => t.type() === 'service_worker' && /^chrome-extension:/.test(t.url()));
    if (!sw) {
      ok('service worker 已注册', false, '找不到扩展的 service worker target');
    } else {
      const extId = new URL(sw.url()).host;
      ok('service worker 已注册', true, `扩展 ID ${extId}`);
      const pop = await browser.newPage();
      const popErr = [];
      pop.on('pageerror', (e) => popErr.push(e.message));
      await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
      await sleep(500);
      const pInfo = await pop.evaluate(() => ({
        ver: (document.getElementById('ver') || {}).textContent,
        hasToggle: !!document.getElementById('enabled'),
        // 引擎选择已搬去设置页 —— 弹层里不该再有 radio
        hasEngineRadio: !!document.querySelector('input[name="engine"]'),
        warn: (document.getElementById('warnline') || {}).textContent,
        feedback: (document.getElementById('feedback') || {}).href,
        w: Math.round(document.body.getBoundingClientRect().width),
      }));
      ok('popup 能打开并渲染', pInfo.hasToggle && pInfo.w > 0,
        `版本 ${pInfo.ver} · 宽 ${pInfo.w}px`);
      ok('popup 里不再有引擎选择（已搬到设置页）', pInfo.hasEngineRadio === false,
        pInfo.hasEngineRadio ? '仍然存在 input[name=engine]' : '无 radio');
      ok('未配 Key 时弹层给出提示（引擎选择搬走后唯一的提醒点）',
        /DeepSeek API Key/.test(pInfo.warn || ''), `「${pInfo.warn}」`);
      ok('popup 有「反馈建议」，指向 GitHub Issues',
        /^https:\/\/github\.com\/eighteentang\/eighteen-translator\/issues/.test(pInfo.feedback || ''),
        pInfo.feedback || '(空)');
      ok('popup 无脚本错误', popErr.length === 0, popErr.join(' | ') || '无');

      /* ---- 文案单一真源（#39）----
         HTML 里一个字都不写（只有 data-i18n 键），正文全部由 strings.js 在
         加载时填上。这里验两件事：
           ① 已经填过 —— i18n-pending 撤掉了，正文非空（页面不会白着）；
           ② 换一个界面语言重填，正文真的跟着变 —— 这正是 #35 的地基。
         不验 ② 的话，「文案确实都在一张表里」只是源码层面的推断，
         真跑起来完全可能有一半节点没被 applyI18n 碰到。 */
      const i18nPop = await pop.evaluate(() => {
        const S = window.WT_STRINGS;
        const pick = () => ({
          lang: document.documentElement.getAttribute('lang'),
          pending: document.documentElement.classList.contains(S.PENDING_CLASS),
          title: (document.querySelector('[data-i18n="pop.title"]') || {}).textContent || '',
          toggle: (document.querySelector('[data-i18n="pop.enabled"]') || {}).textContent || '',
          feedback: (document.querySelector('[data-i18n="pop.feedback"]') || {}).textContent || '',
        });
        const zh = pick();
        S.setLang('en');
        S.applyI18n();
        const en = pick();
        S.setLang('zh');
        S.applyI18n();
        return { zh: zh, en: en, back: pick().title };
      });
      ok('popup 的正文是 JS 填的：i18n-pending 已撤、正文非空（#39）',
        i18nPop.zh.pending === false && i18nPop.zh.title.length > 0
          && i18nPop.zh.toggle.length > 0 && i18nPop.zh.feedback.length > 0,
        JSON.stringify(i18nPop.zh));
      ok('popup 切成英文后正文真的跟着变，切回来也还原（#39 给 #35 铺的路）',
        i18nPop.en.lang === 'en' && i18nPop.en.title !== i18nPop.zh.title
          && i18nPop.back === i18nPop.zh.title,
        JSON.stringify({ zh: i18nPop.zh.title, en: i18nPop.en.title, back: i18nPop.back }));

      /* ---- 界面语言快捷按钮（#57 / #35 第 3 步）----
         先把偏好钉成「中文」，免得这条断言跟着跑测机器的浏览器语言漂。 */
      await pop.evaluate(() => chrome.storage.local.set({ uiLang: 'zh' }));
      await pop.reload({ waitUntil: 'load' });
      await sleep(400);

      const langBefore = await pop.evaluate(() => {
        const btn = document.getElementById('lang');
        const theme = document.getElementById('theme');
        return {
          hasBtn: !!btn,
          label: btn ? btn.textContent : '',
          title: btn ? btn.title : '',
          h1: (document.querySelector('[data-i18n="pop.title"]') || {}).textContent || '',
          htmlLang: document.documentElement.getAttribute('lang'),
          // 与主题按钮并排：两者的垂直中心要对齐（并排量的是这个，不是目测）
          centerGap: (btn && theme)
            ? Math.round(Math.abs(
              (btn.getBoundingClientRect().top + btn.getBoundingClientRect().bottom) / 2 -
              (theme.getBoundingClientRect().top + theme.getBoundingClientRect().bottom) / 2))
            : -1,
        };
      });
      ok('popup 右上角有界面语言按钮，与主题按钮并排，中文界面下写着 EN（#57 / #35）',
        langBefore.hasBtn && langBefore.label === 'EN' && langBefore.centerGap >= 0
          && langBefore.centerGap <= 2 && langBefore.h1.length > 0
          && langBefore.htmlLang === 'zh-CN',
        JSON.stringify(langBefore));

      await pop.click('#lang');
      await sleep(300);
      const langAfter = await pop.evaluate(async () => {
        const btn = document.getElementById('lang');
        const cfg = await chrome.storage.local.get({ uiLang: '' });
        return {
          label: btn ? btn.textContent : '',
          title: btn ? btn.title : '',
          h1: (document.querySelector('[data-i18n="pop.title"]') || {}).textContent || '',
          toggle: (document.querySelector('[data-i18n="pop.enabled"]') || {}).textContent || '',
          htmlLang: document.documentElement.getAttribute('lang'),
          docTitle: document.title,
          stored: cfg.uiLang,
        };
      });
      /* ⚠️ 按钮上那个字**刻意不翻译**：中文界面显示 EN，点完变成 CN。
         它要是跟着翻译就会自指 —— 所以这里同时验「按钮变了」和「正文变了」。 */
      ok('点一下语言按钮：整页切英文、按钮变成 CN、并写进存储（#57 / #35）',
        langAfter.label === 'CN' && langAfter.htmlLang === 'en' && langAfter.stored === 'en'
          && langAfter.h1 !== langBefore.h1 && langAfter.h1.length > 0
          && !/[\u4e00-\u9fff]/.test(langAfter.h1 + langAfter.toggle)
          && !/[\u4e00-\u9fff]/.test(langAfter.docTitle),
        JSON.stringify(langAfter));

      await pop.click('#lang');
      await sleep(300);
      const langBack = await pop.evaluate(async () => ({
        label: document.getElementById('lang').textContent,
        h1: (document.querySelector('[data-i18n="pop.title"]') || {}).textContent || '',
        htmlLang: document.documentElement.getAttribute('lang'),
        stored: (await chrome.storage.local.get({ uiLang: '' })).uiLang,
      }));
      ok('再点一下切回中文，按钮与正文都还原（#57 / #35）',
        langBack.label === 'EN' && langBack.htmlLang === 'zh-CN'
          && langBack.h1 === langBefore.h1 && langBack.stored === 'zh',
        JSON.stringify(langBack));

      /* ---- 排除站点：popup 的「在此域名不可用」（#29）----
         用户裁决里明确要求 popup 里有这个勾选框，与设置页那份列表联动。

         ⚠️ 这里**不能**指望勾选框自己勾上：e2e 里 popup 是以普通标签页打开的，
         所以「当前标签页」就是 popup 自己，拿不到网页域名
         （真实使用时它是个弹层，当前标签页才是用户正在看的那个网页）。
         于是分三段测：
         ① 内容脚本能不能回答「我是谁」—— 这是整条链路的根，直接在 SW 层问
         ② 拿到域名之后，勾选框的判断与写入对不对（直接调 paintSite 注入域名）
         ③ 拿不到域名时置灰并说明原因 —— 这一条在 e2e 里正好能真验到 */
      const who = await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const ids = tabs.map((t) => t.id).filter((x) => x !== undefined && x !== null);
        for (const id of ids) {
          const res = await new Promise((r) => {
            chrome.tabs.sendMessage(id, { type: 'whoami' }, (v) => {
              r(chrome.runtime.lastError ? null : v);
            });
          });
          if (res && res.hostname) return { hostname: res.hostname, tried: ids.length };
        }
        return { hostname: '', tried: ids.length };
      });
      ok('内容脚本能回答「我是谁」—— popup 的勾选框靠它（#29）',
        who.hostname === '127.0.0.1', JSON.stringify(who));

      const site = await pop.evaluate(async () => {
        const box = document.getElementById('siteOff');
        const desc = document.getElementById('siteDesc');
        const wait = () => new Promise((r) => setTimeout(r, 300));
        if (!box) return { has: false };

        // ③ e2e 里 popup 是标签页，拿不到网页域名 —— 应当置灰并说明原因
        const noHost = { disabled: box.disabled, desc: desc.textContent };

        // ② 注入域名，走「拿到域名之后」的那条路
        paintSite('a.example.com', '');
        const fresh = { checked: box.checked, desc: desc.textContent };

        paintSite('a.example.com', 'example.com');
        const covered = { checked: box.checked, desc: desc.textContent };

        paintSite('a.example.com', '');
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        await wait();
        const stored = (await chrome.storage.local.get({ excludeSites: '' })).excludeSites;
        const status = document.getElementById('status').textContent;

        box.checked = false;
        box.dispatchEvent(new Event('change'));
        await wait();
        const cleared = (await chrome.storage.local.get({ excludeSites: '' })).excludeSites;

        return { has: true, noHost, fresh, covered, stored, status, cleared };
      });
      ok('popup 里有「在此域名不可用」勾选框（#29）', site.has === true);
      ok('拿不到域名时置灰并说明原因，而不是留一个能点的空勾选框（#29）',
        site.noHost && site.noHost.disabled === true && /用不了/.test(site.noHost.desc || ''),
        JSON.stringify(site.noHost));
      ok('勾选框状态是算出来的：被更宽的规则覆盖时也勾上，并说明是哪条规则（#29）',
        site.fresh && site.fresh.checked === false
          && site.covered && site.covered.checked === true
          && /example\.com/.test(site.covered.desc || ''),
        JSON.stringify({ fresh: site.fresh, covered: site.covered }));
      ok('勾上真的写进设置页那份列表，并提示要刷新页面（#29）',
        site.stored === 'a.example.com' && /刷新/.test(site.status || '')
          && site.cleared === '',
        `stored=${JSON.stringify(site.stored)} status=${JSON.stringify(site.status)} cleared=${JSON.stringify(site.cleared)}`);

      // ---- 开关联动：popup 里关掉后，划词不应弹浮层 ----
      await pop.evaluate(() => chrome.storage.local.set({ enabled: false }));
      await sleep(500);
      await selectAndMouseUp(page, 'p3');
      await sleep(900);
      a = await probe(page);
      ok('开关关闭后不弹浮层', a.display === 'none', `display=${a.display}`);

      await pop.evaluate(() => chrome.storage.local.set({ enabled: true }));
      await sleep(400);
      await selectAndMouseUp(page, 'p3');
      await sleep(1500);
      a = await probe(page);
      ok('开关重新打开后恢复弹浮层', a.display === 'block', `display=${a.display}`);

      // ---- 主题切换（popup 右上角 + 全局生效）----
      const t0 = await pop.evaluate(() => {
        const btn = document.getElementById('theme');
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        return {
          hasBtn: !!document.getElementById('theme'),
          // 按钮必须真的在 h1 的右半边（用户要的位置）
          inHeadRight: !!document.querySelector('h1 .head-right > #theme'),
          sunAndMoon: !!document.querySelector('#theme .sun') && !!document.querySelector('#theme .moon'),
          theme: document.documentElement.getAttribute('data-theme'),
          // 用户反馈「不像按钮、和背景区分不开」—— 所以它必须有描边、有底色、有阴影
          border: cs.borderTopWidth + ' ' + cs.borderTopColor,
          bg: cs.backgroundColor,
          shadow: cs.boxShadow,
          size: Math.round(r.width) + 'x' + Math.round(r.height),
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      });
      ok('popup 右上角有主题按钮（含太阳与月亮两个图标）',
        t0.hasBtn && t0.inHeadRight && t0.sunAndMoon, `data-theme=${t0.theme}`);
      ok('主题按钮看起来像按钮：有描边 + 有底色 + 有阴影，且底色与弹层背景不同',
        parseFloat(t0.border) > 0 && t0.shadow !== 'none' && t0.bg !== t0.bodyBg,
        `${t0.size} · 描边 ${t0.border} · 底色 ${t0.bg}（弹层 ${t0.bodyBg}）· 阴影 ${t0.shadow}`);

      await pop.click('#theme');
      await sleep(350);
      const t1 = await pop.evaluate(async () => {
        const stored = await new Promise((r) =>
          chrome.storage.local.get({ theme: null }, (v) => r(v.theme)));
        return { theme: document.documentElement.getAttribute('data-theme'), stored };
      });
      ok('点一下就翻转主题，并写进 storage',
        t1.theme !== t0.theme && t1.stored === t1.theme,
        `${t0.theme} → ${t1.theme} · storage=${t1.stored}`);

      // 改 storage 里的 theme → 网页里的浮层应立刻跟着变
      await pop.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
      await sleep(500);
      const hostDark = await page.evaluate(() =>
        document.getElementById('wt-translate-host').getAttribute('data-theme'));
      ok('storage 改主题后，浮层同步跟随', hostDark === 'dark', `data-theme=${hostDark}`);

      // 收拾干净，别影响别的断言
      await pop.evaluate(() => chrome.storage.local.set({ theme: 'auto' }));
      await sleep(300);

      /* ---- 浮层字号 / 最大宽度（#25）----
         关闭条件是「改完立即生效、**不需要刷新页面**」—— 所以这里刻意
         不 reload 网页，直接改 storage，看已经开着的那块浮层有没有当场变。

         ⚠️ 必须先用一段**长译文**把 max-content 顶到上限以上。
         用短文本时面板宽度由内容决定（实测约 299px），
         那样「宽度 ≤ 上限」这种断言在 max-width 完全失效时也会通过 ——
         测出来的是「CSS 属性被写上了」，不是「它真的在起作用」。

         用 p2 而不是 p1：p1 在上面「复制」那一段已经成功返回并被缓存了，
         再选它会直接命中缓存、拿到那句短的「E2E 译文」。
         p2 只在失败用例里出现过，缓存里没有它。

         还得把 Key 填回去 —— 上面的用例为了验「未配凭据」把它清空了，
         不填的话这里拿到的是错误浮层，量出来的是那句错误文案的宽度。 */
      await worker.evaluate(() => {
        chrome.storage.local.set({ engine: 'deepseek', deepseekKey: 'sk-fake-for-e2e' });
        globalThis.fetch = async () => ({
          ok: true, status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: '这是一段足够长的译文，'.repeat(8) + '用来把浮层的宽度顶到上限。'
              }
            }]
          })
        });
      });
      await sleep(400);

      const sizeOf = () => page.evaluate(() => {
        const el = document.getElementById('wt-translate-host');
        const p = el && el.shadowRoot ? el.shadowRoot.querySelector('.panel') : null;
        if (!p) return null;
        const cs = getComputedStyle(p);
        const r = p.getBoundingClientRect();
        return {
          fs: cs.fontSize, mw: cs.maxWidth, w: Math.round(r.width), h: Math.round(r.height),
          text: (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          hostVar: el.style.getPropertyValue('--wt-fs').trim(),
          pageVar: document.documentElement.style.getPropertyValue('--wt-fs').trim(),
        };
      });

      await pop.evaluate(() => chrome.storage.local.set({ panelFont: 'lg', panelWidth: 'wide' }));
      await sleep(300);
      await selectAndMouseUp(page, 'p2');
      await sleep(1400);
      const big = await sizeOf();
      ok('大 / 宽档：字号 16px，宽度被上限 560px 卡住（#25）',
        !!big && big.fs === '16px' && big.mw === '560px'
          && big.w >= 558 && big.w <= 560,
        big ? `字号=${big.fs} 上限=${big.mw} 实测宽=${big.w} 内容=${JSON.stringify(big.text)}` : '没找到 .panel');

      /* 面板**已经开着**的时候改设置 —— 这才是「不用刷新页面」的真正含义：
         不重新划词、不重新加载网页，浮层当场就是新尺寸。 */
      await pop.evaluate(() => chrome.storage.local.set({ panelFont: 'sm', panelWidth: 'narrow' }));
      await sleep(500);
      const small = await sizeOf();
      ok('浮层开着时改设置，它当场跟着变（不重新划词、不刷新页面）（#25）',
        !!small && small.fs === '13px' && small.mw === '320px'
          && small.w >= 318 && small.w <= 320,
        small ? `字号=${small.fs} 上限=${small.mw} 实测宽=${small.w} 内容=${JSON.stringify(small.text)}` : '没找到 .panel');

      /* ⚠️ 这一条是 #25 方案里唯一的硬约束：变量只能写在宿主元素上。
         写到 documentElement 上就是 content script 改了页面的样式 ——
         哪怕同名概率低，也是把自己的实现细节泄进页面的作用域。 */
      ok('CSS 变量写在宿主元素上，没有污染页面（#25）',
        !!big && big.hostVar === '16px' && big.pageVar === '',
        big ? `宿主=${JSON.stringify(big.hostVar)} 页面=${JSON.stringify(big.pageVar)}` : '');

      // 还原成默认档，别影响后面的用例
      await pop.evaluate(() => chrome.storage.local.set({ panelFont: 'md', panelWidth: 'md' }));
      await sleep(400);

      /* 宽度是**上限**而不是固定值 —— 这是设置页那句说明的对应断言：
         短内容的面板应当明显窄于上限，否则每一块浮层都撑满 560px，
         页面上会横着一大块白。 */
      await worker.evaluate(() => {
        globalThis.fetch = async () => ({
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: 'E2E 译文' } }] })
        });
      });
      await selectAndMouseUp(page, 'p1');
      await sleep(1400);
      const shortPanel = await sizeOf();
      ok('短内容时浮层仍然是紧凑的（宽度是上限，不是固定值）（#25）',
        !!shortPanel && shortPanel.w < 420,
        shortPanel ? `实测宽=${shortPanel.w} 上限=${shortPanel.mw}` : '没找到 .panel');

      /* ---- 朗读（#10）----

         ⚠️ **无头环境里没有音频输出** —— 所以这里能验的只有：
         按钮在不在、点了会不会报脚本错误、点下去**有没有反应**、没有语音包时说不说得清楚。
         **「真的发出声音」这一条验不了**，必须真机确认（issue 评论里写明了）。

         这一段的两个标签在两种界面语言下都认 —— 别把断言钉死在中文上
         （上面的用例切过界面语言，而且它本来就是可切的）。 */
      const READ_SRC = ['读原文', 'Read original'];
      const READ_OUT = ['读译文', 'Read translation'];

      const readState = () => page.evaluate(([src, out]) => {
        const el = document.getElementById('wt-translate-host');
        const sr = el && el.shadowRoot;
        const btns = sr ? Array.from(sr.querySelectorAll('.tools .btn')) : [];
        const labels = btns.map((b) => b.textContent);
        const hint = sr ? sr.querySelector('.speak-hint') : null;
        const p = sr ? sr.querySelector('.panel') : null;
        return {
          labels: labels,
          hasSrc: labels.some((l) => src.indexOf(l) >= 0),
          hasOut: labels.some((l) => out.indexOf(l) >= 0),
          // 朗读中那两个字会变成「停止」/「Stop」—— 这是「看得出来的状态」
          speaking: labels.some((l) => /停止|Stop/.test(l)),
          hint: hint ? hint.textContent : '',
          voices: window.speechSynthesis ? window.speechSynthesis.getVoices().length : -1,
          text: p ? (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '',
        };
      }, [READ_SRC, READ_OUT]);

      const readUi = await readState();
      ok('浮层工具条里有朗读按钮（读原文 / 读译文）（#10）',
        readUi.hasSrc && readUi.hasOut, JSON.stringify(readUi.labels));

      const boxOf = (re) => page.evaluate((src) => {
        const el = document.getElementById('wt-translate-host');
        const sr = el && el.shadowRoot;
        const btns = sr ? Array.from(sr.querySelectorAll('.tools .btn')) : [];
        const target = btns.filter((b) => new RegExp(src).test(b.textContent))[0];
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, re.source);

      /* ⚠️ 用**真实鼠标点击**，不用 `element.click()`。
         浮层在 Shadow DOM 里、由 content script 的隔离世界创建，
         实测 `element.click()` 派发的事件到不了那边的监听器（点了没反应，
         而且不报错）—— 与浮层上其它按钮的验法保持一致（见上面的 altBtn）。 */
      const readBox = await boxOf(/读译文|Read translation/);
      if (readBox) await page.mouse.click(readBox.x, readBox.y);

      /* 轮询而不是等固定时长：一句「E2E 译文」不到一秒就读完了，
         等 3.6 秒再去看，那时早就回到初始态了（**这是踩过的坑**）。
         所以要抓的是「**某一刻**进入过朗读态或出现过提示」。 */
      let readSeen = null;
      for (let i = 0; i < 14 && !readSeen; i++) {
        await sleep(300);
        const s = await readState();
        if (s.speaking || s.hint) readSeen = s;
      }
      /* 进入朗读态、或给出一句能看懂的话 —— 两种都算通过，
         **唯一不通过的是「点了什么都不发生」**（#10 的关闭条件）。 */
      ok('点朗读：要么进入朗读态（按钮变「停止」）、要么给出可读提示（不许静默无反应）（#10）',
        !!readBox && !!readSeen,
        JSON.stringify(readSeen || { note: '4 秒内既没进入朗读态、也没有提示' }));

      /* 提示是**追加**在译文下面的一行，不是 replace 掉整屏 ——
         否则「点朗读发现没语音包」会把用户刚拿到的译文弄没，那是净损失。 */
      ok('朗读提示不会把译文顶掉（提示是追加的一行，不是 replace 整屏）（#10）',
        !!readSeen && readSeen.text.indexOf('E2E') >= 0,
        JSON.stringify(readSeen && readSeen.text));

      /* 无语音包的那条路（#10 关闭条件里明确要求的一条）：
         把目标语言换成一个**这台机器几乎不可能装了语音包**的语言（泰文），
         再读一次 —— 必须给出一句能看懂的话，而不是点了没反应。
         ⚠️ 万一本机真有泰文语音，就按「进入朗读态」放行，别把一个真机差异报成 bug。 */
      const hasThai = await page.evaluate(() => {
        const s = window.speechSynthesis;
        return !!s && s.getVoices().some((v) => /^th/i.test(v.lang));
      });
      await worker.evaluate(() => chrome.storage.local.set({ targetLang: 'th' }));
      await sleep(400);
      await selectAndMouseUp(page, 'p1');
      await sleep(1600);
      const thBox = await boxOf(/读译文|Read translation/);
      if (thBox) await page.mouse.click(thBox.x, thBox.y);
      await sleep(1000);
      const thState = await readState();
      ok('没有这门语言的语音包时给出可读提示（不是静默失败）（#10）',
        hasThai || thState.speaking || /语音包|voice/i.test(thState.hint),
        JSON.stringify({ hasThai: hasThai, hint: thState.hint, speaking: thState.speaking }));
      ok('朗读提示出现时，译文仍然在面板里（#10）',
        hasThai || thState.text.indexOf('E2E') >= 0, JSON.stringify(thState.text));

      // 收尾：把朗读停掉、语言改回去，别影响后面的用例
      const stopBox = await boxOf(/停止|Stop/);
      if (stopBox) await page.mouse.click(stopBox.x, stopBox.y);
      await sleep(400);
      await worker.evaluate(() => chrome.storage.local.set({ targetLang: 'zh' }));
      await sleep(300);
      const readBack = await readState();
      ok('朗读按钮回到初始态（不会卡在「停止」）（#10）',
        !readBack.speaking, JSON.stringify(readBack.labels));


      /* ---- 排除站点（#29）----
         ⚠️ 内容脚本是 manifest 声明的（matches: <all_urls>），**一定会被注入** ——
         所以这里验的不是「没注入」，而是「注入之后什么都不做」：
         没有浮层宿主、没有请求。

         测试页跑在 127.0.0.1，所以排除项就写 127.0.0.1。
         判断只在脚本加载时做一次 → 必须刷新页面才生效（这正是那条已知限制，
         下面的第二步会把它验实）。 */
      await worker.evaluate(() => chrome.storage.local.set({ excludeSites: '127.0.0.1' }));
      await sleep(400);
      await page.reload({ waitUntil: 'load' });
      await sleep(1200);

      const beforeEx = await worker.evaluate(() => globalThis.__wtCalls.length);
      await selectAndMouseUp(page, 'p1');
      await sleep(1200);
      const ex = await probe(page);
      const afterEx = await worker.evaluate(() => globalThis.__wtCalls.length);

      ok('排除站点上划词：连浮层宿主都不建，一个请求都不发（#29）',
        ex.exists === false && afterEx === beforeEx,
        `宿主=${ex.exists ? '存在' : '不存在'} fetch ${beforeEx} → ${afterEx}`);

      /* 从列表里去掉 → 刷新 → 恢复。
         顺带把「改完要刷新页面」这条限制验实（不是猜的）。 */
      await worker.evaluate(() => chrome.storage.local.set({ excludeSites: '' }));
      await sleep(400);
      await page.reload({ waitUntil: 'load' });
      await sleep(1200);
      await selectAndMouseUp(page, 'p1');
      await sleep(1500);
      const back29 = await probe(page);
      ok('从排除列表里去掉之后（刷新页面）恢复翻译（#29）',
        back29.display === 'block', `display=${back29.display}`);

      await pop.close();

      // ---- 设置页：翻译方向的两个下拉必须并排同一行 ----
      const opt = await browser.newPage();
      const optErr = [];
      opt.on('pageerror', (e) => optErr.push(e.message));
      await opt.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'load' });
      await sleep(600);

      const oInfo = await opt.evaluate(() => {
        const p = document.getElementById('preferredLang');
        const t = document.getElementById('targetLang');
        const pr = p.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        return {
          options: Array.from(p.options).map((o) => o.value).join(','),
          texts: Array.from(p.options).map((o) => o.textContent),
          // 「同一行」要量出来：两个 select 的上边缘必须在同一水平线上
          sameRow: Math.abs(pr.top - tr.top) < 2,
          gap: Math.round(tr.left - pr.right),
          pv: p.value, tv: t.value,
          theme: document.documentElement.getAttribute('data-theme'),
        };
      });
      /* #9：语言表从 2 种扩到 11 种。⚠️ 断言写成**整份清单**而不是「包含」——
         少一门、多一门、顺序变了都要能被看见。 */
      ok('设置页有「首选语言 / 目标语言」两个下拉，11 种语言（选项由 lang.js 渲染）（#9）',
        oInfo.options === 'zh,zh-Hant,en,ja,ko,fr,de,es,ru,ar,th',
        `选项=${oInfo.options} · 当前 ${oInfo.pv} / ${oInfo.tv}`);
      /* 显示名必须来自 strings.js（t('lang.<code>')），不是语言码本身 ——
         漏补一条文案的话，t() 会把键名原样返回（'lang.xx'），而且不报错。
         这条与界面语言无关：无论当前是中文还是英文界面，都不该看见键名。 */
      ok('语言下拉显示的是语言名而不是语言码（#9）',
        oInfo.texts.length === 11
          && oInfo.texts.every((s, i) => s && s !== ('lang.' + oInfo.options.split(',')[i])),
        JSON.stringify(oInfo.texts));
      ok('两个下拉并排同一行', oInfo.sameRow,
        `上边缘对齐=${oInfo.sameRow} · 水平间距=${oInfo.gap}px`);
      ok('设置页也带上了主题属性',
        oInfo.theme === 'light' || oInfo.theme === 'dark', `data-theme=${oInfo.theme}`);

      // 设置页页脚：版本号（用户报问题时唯一的「我装的是哪一版」凭证）+ 反馈入口
      const oFoot = await opt.evaluate(() => ({
        ver: (document.getElementById('ver') || {}).textContent,
        feedback: (document.getElementById('feedback') || {}).href,
      }));
      ok('设置页页脚显示版本号', /^v\d+\.\d+\.\d+$/.test(oFoot.ver || ''), oFoot.ver || '(空)');
      ok('设置页页脚也有「反馈建议」',
        /^https:\/\/github\.com\/eighteentang\/eighteen-translator\/issues/.test(oFoot.feedback || ''),
        oFoot.feedback || '(空)');

      /* ---- 凭据显示 / 隐藏 + 存储方式说明（#4）、配置只存本机（#45）----
         这两条的重点**都不是那个切换按钮**，而是「说清楚」：
         #4 不说会让人以为 Key 被保护了，#45 不说会让人以为登同一个账号就同步。 */
      const keyUi = await opt.evaluate(() => {
        const inp = document.getElementById('deepseekKey');
        const btn = document.getElementById('toggleKey');
        const before = inp.type;
        if (btn) btn.click();
        const after = inp.type;
        if (btn) btn.click();
        const notes = [...document.querySelectorAll('p.note')]
          .map((n) => n.textContent).join('\n');
        return {
          hasBtn: !!btn, before, after, restored: inp.type,
          tellsPlain: /无云端存储/.test(notes) && /明文/.test(notes),
          tellsLocalOnly: /只存在本机/.test(notes),
        };
      });
      ok('凭据输入框有显示 / 隐藏切换',
        keyUi.hasBtn && keyUi.before === 'password' && keyUi.after === 'text'
          && keyUi.restored === 'password',
        `type: ${keyUi.before} → ${keyUi.after} → ${keyUi.restored}`);
      ok('设置页写明 Key 是明文存在本机的（#4）', keyUi.tellsPlain,
        keyUi.tellsPlain ? '' : '没找到那句说明');
      ok('设置页写明配置只存本机、不同步（#45）', keyUi.tellsLocalOnly,
        keyUi.tellsLocalOnly ? '' : '没找到那句说明');

      /* ---- 反馈入口（#59）----
         模板解决「该问什么」，一键复制解决「他懒得填」。
         ⚠️ 最要紧的一条是**不能泄漏 Key** —— 诊断信息会被贴到公开 issue 里。 */
      const diag = await opt.evaluate(() => {
        const href = (document.getElementById('feedback') || {}).href || '';
        const inp = document.getElementById('deepseekKey');
        inp.value = 'sk-SENTINEL-DO-NOT-LEAK';
        const t = typeof diagText === 'function' ? diagText() : '';
        return {
          template: /template=bug_report\.yml/.test(href),
          hasBtn: !!document.getElementById('diag'),
          leaks: /SENTINEL/.test(t),
          saysFilled: /已填写/.test(t),
          hasVer: /划词翻译 v\d+\.\d+\.\d+/.test(t),
        };
      });
      ok('反馈入口带上 issue 模板（#59）', diag.template,
        diag.template ? '' : '链接里没有 template=bug_report.yml');
      ok('设置页有「复制诊断信息」按钮（#59）', diag.hasBtn);
      ok('诊断信息带版本号、只报「已填 / 未填」，且不含 Key 本身（#59）',
        diag.hasVer && diag.saysFilled && diag.leaks === false,
        `版本=${diag.hasVer} 已填=${diag.saysFilled} 泄漏=${diag.leaks}`);

      /* ---- 用量 / 每日上限 / 译文缓存（#18 / #19 / #17）----
         ⚠️ 这里最要紧的一条不是「按钮点了有反应」，而是「**上限的数值不出现在页面上**」——
         那是 #19 里用户明确定的：看得到数字，用户就会开始跟它谈判。
         所以下面既断言按钮真的改了存储，也断言改完的数值没有被渲染出来。
         （也正因如此，那节说明文案里连「每次加 500」都没写 —— 写了就等于漏了默认值。） */
      const usage = await opt.evaluate(async () => {
        const $ = (id) => document.getElementById(id);
        const num = $('usageToday');
        const raise = $('raiseQuota');
        const clear = $('clearCache');
        const desc = $('quotaDesc');
        const wait = () => new Promise((r) => setTimeout(r, 300));

        // 用 DEFAULTS 兜底读，因为全新 profile 里 quotaDaily 还没被写进存储
        const before = (await chrome.storage.local.get({ quotaDaily: WT_CONFIG.DEFAULTS.quotaDaily })).quotaDaily;
        const textBefore = document.body.innerText;

        if (raise) raise.click();
        await wait();

        const after = (await chrome.storage.local.get({ quotaDaily: WT_CONFIG.DEFAULTS.quotaDaily })).quotaDaily;
        const textAfter = document.body.innerText;

        // 往缓存里塞一条，再点「清空缓存」，验证真的被清掉（而不是只改了界面文字）
        await chrome.storage.local.set({ cache: { deadbeef: { t: 'x', at: Date.now() } } });
        if (clear) clear.click();
        await wait();
        const cacheLeft = Object.keys((await chrome.storage.local.get('cache')).cache || {}).length;

        return {
          hasNum: !!num, hasRaise: !!raise, hasClear: !!clear,
          before, after,
          leaksBefore: textBefore.includes(String(before)),
          leaksAfter: textAfter.includes(String(after)),
          cacheLeft,
          numText: num ? num.textContent : '',
          descText: desc ? desc.textContent : '',
        };
      });
      ok('设置页有「用量」一节：今日次数 / 调高上限 / 清空缓存（#18 #19 #17）',
        usage.hasNum && usage.hasRaise && usage.hasClear,
        JSON.stringify({ num: usage.hasNum, raise: usage.hasRaise, clear: usage.hasClear }));
      ok('「调高上限」真的把上限往上加了（#19）',
        usage.after > usage.before && usage.after === usage.before + 500,
        `${usage.before} → ${usage.after}`);
      ok('上限的数值不出现在页面上（#19）',
        usage.leaksBefore === false && usage.leaksAfter === false,
        `改前泄漏=${usage.leaksBefore} 改后泄漏=${usage.leaksAfter}`);
      ok('「清空缓存」真的清掉了存储里的缓存（#17）',
        usage.cacheLeft === 0, '剩余条数=' + usage.cacheLeft);

      /* ---- 跳过技术内容：设置页的开关（#60）----
         光有复选框不算数 —— 要确认它真的被写进存储，而且默认是开的。 */
      const st = await opt.evaluate(async () => {
        const el = document.getElementById('skipTech');
        const before = el ? el.checked : null;
        const wait = () => new Promise((r) => setTimeout(r, 400));
        if (el) el.checked = false;
        document.getElementById('save').click();
        await wait();
        const stored = (await chrome.storage.local.get('skipTech')).skipTech;
        if (el) { el.checked = true; document.getElementById('save').click(); }
        await wait();
        return { has: !!el, before, stored };
      });
      ok('设置页有「跳过技术内容」开关，默认开，关掉后真的写进存储（#60）',
        st.has && st.before === true && st.stored === false, JSON.stringify(st));

      /* ---- 触发方式：设置页的二选一（#6）----
         同样地，光有两个 radio 不算数 —— 要确认默认是自动、且选手动真的写进存储。 */
      const tm = await opt.evaluate(async () => {
        const auto = document.querySelector('input[name="triggerMode"][value="auto"]');
        const manual = document.querySelector('input[name="triggerMode"][value="manual"]');
        const checked = (document.querySelector('input[name="triggerMode"]:checked') || {}).value;
        const wait = () => new Promise((r) => setTimeout(r, 400));
        if (manual) manual.checked = true;
        document.getElementById('save').click();
        await wait();
        const stored = (await chrome.storage.local.get('triggerMode')).triggerMode;
        if (auto) auto.checked = true;
        document.getElementById('save').click();
        await wait();
        return { has: !!auto && !!manual, checked, stored };
      });
      ok('设置页有「自动 / 手动」二选一，默认自动，选手动后真的写进存储（#6）',
        tm.has && tm.checked === 'auto' && tm.stored === 'manual', JSON.stringify(tm));

      /* ---- 浮层外观：设置页的两个下拉（#25）----
         选项由 config.js 的档位表渲染（与 content.js 的 CSS 变量同一张表），
         所以这里既查「三档都在」，也查「改完不点保存就写进了存储」——
         它是纯显示设置，还要求再点一次保存的话，用户会以为没生效。 */
      const sz = await opt.evaluate(async () => {
        const f = document.getElementById('panelFont');
        const w = document.getElementById('panelWidth');
        const wait = () => new Promise((r) => setTimeout(r, 300));
        const opts = f ? Array.from(f.options).map((o) => o.value) : [];
        const wOpts = w ? Array.from(w.options).map((o) => o.value) : [];
        const labels = f ? Array.from(f.options).map((o) => o.textContent) : [];
        const before = f ? f.value : null;
        if (w) { w.value = 'wide'; w.dispatchEvent(new Event('change')); }
        await wait();
        const stored = (await chrome.storage.local.get({ panelWidth: null })).panelWidth;
        if (w) { w.value = 'md'; w.dispatchEvent(new Event('change')); }
        await wait();
        const back = (await chrome.storage.local.get({ panelWidth: null })).panelWidth;
        return { opts, wOpts, labels, before, stored, back };
      });
      ok('设置页有「字号 / 最大宽度」两个三档下拉，默认中间档（#25）',
        sz.opts.join(',') === 'sm,md,lg' && sz.wOpts.join(',') === 'narrow,md,wide'
          && sz.before === 'md',
        `字号=${sz.opts.join(',')} 宽度=${sz.wOpts.join(',')} 当前=${sz.before}`);
      ok('档位下拉里带上了像素值（「大一点」没有参照物）（#25）',
        /px/.test(sz.labels.join(' ')), sz.labels.join(' / '));
      ok('改浮层外观不点保存也立即写进存储（#25）',
        sz.stored === 'wide' && sz.back === 'md',
        `${sz.before} → ${sz.stored} → ${sz.back}`);

      /* ---- 朗读的设置项（#10）----
         两个下拉：语速（三档）与英语口音（跟随系统 / 美式 / 英式）。
         ⚠️ 口音那两个值是**语音包的标识**（en-US / en-GB），不是界面文案 ——
         所以断言的是 value 而不是显示名。 */
      const spk = await opt.evaluate(async () => {
        const r = document.getElementById('speakRate');
        const a = document.getElementById('speakAccent');
        const wait = () => new Promise((res) => setTimeout(res, 300));
        const rOpts = r ? Array.from(r.options).map((o) => o.value) : [];
        const aOpts = a ? Array.from(a.options).map((o) => o.value) : [];
        const rLabels = r ? Array.from(r.options).map((o) => o.textContent) : [];
        const aLabels = a ? Array.from(a.options).map((o) => o.textContent) : [];
        const before = { r: r && r.value, a: a && a.value };
        if (r) { r.value = 'fast'; r.dispatchEvent(new Event('change')); }
        if (a) { a.value = 'en-GB'; a.dispatchEvent(new Event('change')); }
        await wait();
        const stored = await chrome.storage.local.get({ speakRate: null, speakAccent: null });
        if (r) { r.value = 'normal'; r.dispatchEvent(new Event('change')); }
        if (a) { a.value = 'auto'; a.dispatchEvent(new Event('change')); }
        await wait();
        const back = await chrome.storage.local.get({ speakRate: null, speakAccent: null });
        return {
          rOpts, aOpts, rLabels, aLabels, before,
          stored: stored, back: back
        };
      });
      ok('设置页有「语速 / 英语口音」两个下拉，默认正常语速 + 跟随系统（#10）',
        spk.rOpts.join(',') === 'slow,normal,fast'
          && spk.aOpts.join(',') === 'auto,en-US,en-GB'
          && spk.before.r === 'normal' && spk.before.a === 'auto',
        `语速=${spk.rOpts.join(',')} 口音=${spk.aOpts.join(',')} 当前=${spk.before.r}/${spk.before.a}`);
      ok('语速下拉不带像素值，口音下拉显示的是可读的名字（#10）',
        spk.rLabels.every((s) => s && !/px/.test(s))
          && spk.aLabels.length === 3 && spk.aLabels.every((s) => s && s.length > 0),
        spk.rLabels.join(' / ') + ' ｜ ' + spk.aLabels.join(' / '));
      ok('改朗读设置不点保存也立即写进存储（#10）',
        spk.stored.speakRate === 'fast' && spk.stored.speakAccent === 'en-GB'
          && spk.back.speakRate === 'normal' && spk.back.speakAccent === 'auto',
        JSON.stringify({ stored: spk.stored, back: spk.back }));

      /* ---- 排除站点：设置页（#29）----
         三个点：写错的行要**报出来并带行号**、有写错的行**不阻止保存**
         （一个笔误不该把整页设置都锁住，连 API Key 都存不进去）、
         改了列表要提示「请刷新页面」—— 判断只在页面加载时做一次。 */
      const st29 = await opt.evaluate(async () => {
        const ta = document.getElementById('excludeSites');
        const warn = document.getElementById('sites-warn');
        const status = document.getElementById('status');
        const wait = () => new Promise((r) => setTimeout(r, 400));

        if (!ta) return { has: false };

        // 故意混一行写错的进去
        ta.value = 'example.com\nfoo.*.com\nhttps://mail.google.com/mail/u/0';
        ta.dispatchEvent(new Event('input'));
        await wait();
        const warnText = warn.textContent;

        document.getElementById('save').click();
        await wait();
        const statusText = status.textContent;
        const stored = (await chrome.storage.local.get({ excludeSites: '' })).excludeSites;

        // 还原，别影响后面的用例
        ta.value = '';
        ta.dispatchEvent(new Event('input'));
        document.getElementById('save').click();
        await wait();
        const cleared = (await chrome.storage.local.get({ excludeSites: '' })).excludeSites;

        return { has: true, warnText, statusText, stored, cleared };
      });
      ok('设置页有排除站点输入框，写错的行报出来时带行号（#29）',
        st29.has && /第 2 行/.test(st29.warnText || '')
          && /foo\.\*\.com/.test(st29.warnText || ''),
        JSON.stringify(st29.warnText));
      ok('有写错的行也照样保存（笔误不该锁住整页设置），并提示要刷新页面（#29）',
        /已保存/.test(st29.statusText || '') && /刷新/.test(st29.statusText || '')
          && /foo\.\*\.com/.test(st29.stored || '') && st29.cleared === '',
        `status=${JSON.stringify(st29.statusText)} stored=${JSON.stringify(st29.stored)}`);

      /* 到上限时，状态必须靠「文案 + 变色」表达，而不是把上限值印出来。
         （注意：此时「今日已翻译」的数字天然等于上限 —— 那是计数，不是设置项，
         所以这一条只查文案与颜色，不再查「数值有没有出现」。） */
      const capNow = await opt.evaluate(async () => {
        const cap = (await chrome.storage.local.get({ quotaDaily: WT_CONFIG.DEFAULTS.quotaDaily })).quotaDaily;
        const d = new Date();
        const p = (n) => (n < 10 ? '0' + n : String(n));
        const k = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
        await chrome.storage.local.set({ usage: { byDay: { [k]: cap } } });
        return cap;
      });
      await opt.reload({ waitUntil: 'load' });
      await sleep(600);
      const fullState = await opt.evaluate(() => {
        const el = document.getElementById('usageToday');
        return {
          num: el ? el.textContent : '',
          red: !!el && el.classList.contains('at-cap'),
          desc: (document.getElementById('quotaDesc') || {}).textContent || '',
        };
      });
      ok('到上限后给出明确状态：文案 + 变色（#19）',
        fullState.red === true && /到上限/.test(fullState.desc),
        JSON.stringify({ red: fullState.red, desc: fullState.desc, num: fullState.num }));
      ok('到上限时「今日已翻译」的数字确实等于上限（说明统计与拦截用的是同一个计数）',
        fullState.num === String(capNow),
        `页面=${fullState.num} 上限=${capNow}`);

      // 两个下拉选同一个值时必须拦住 —— 否则又退化成「译成同语言」。
      // ⚠️ 不能写死 'zh'：默认值变了这条就失效（实测踩过），要跟着「首选语言」的当前值走。
      const warn = await opt.evaluate(() => {
        const p = document.getElementById('preferredLang');
        const t = document.getElementById('targetLang');
        t.value = p.value;
        t.dispatchEvent(new Event('change'));
        return document.getElementById('lang-warn').textContent.trim();
      });
      ok('两个下拉选同一个值时给出警告', /不能相同/.test(warn), JSON.stringify(warn));

      /* ---- 文案单一真源（#39）----
         设置页有 40 多个 data-i18n 节点，只要有一个没被 applyI18n 碰到，
         页面上就是一块空白 —— 而这在源码层面完全看不出来。
         所以这里逐个节点查「填没填」，再整体切一次语言查「跟不跟着变」。 */
      const i18nOpt = await opt.evaluate(() => {
        const S = window.WT_STRINGS;
        const nodes = Array.prototype.slice.call(document.querySelectorAll('[data-i18n]'));
        const keyOf = (el) => el.getAttribute('data-i18n');
        // 空白 = 这个节点没被填；缺键 = t() 原样把键名返回来了（见 strings.js 的策略）
        const blank = nodes.filter((el) => !el.innerHTML.trim()).map(keyOf);
        const missing = nodes.filter((el) => el.innerHTML === keyOf(el)).map(keyOf);

        const pick = () => ({
          lang: document.documentElement.getAttribute('lang'),
          pending: document.documentElement.classList.contains(S.PENDING_CLASS),
          h1: (document.querySelector('[data-i18n="opt.h1"]') || {}).textContent || '',
          sub: (document.querySelector('[data-i18n="opt.sub"]') || {}).textContent || '',
        });
        const zh = pick();
        S.setLang('en');
        S.applyI18n();
        const en = pick();
        S.setLang('zh');
        S.applyI18n();
        return { count: nodes.length, blank: blank, missing: missing, zh: zh, en: en, back: pick().h1 };
      });
      ok(`设置页的 ${i18nOpt.count} 个 data-i18n 节点全部填上了，没有一个缺键（#39）`,
        i18nOpt.blank.length === 0 && i18nOpt.missing.length === 0,
        '空白=' + (i18nOpt.blank.join(',') || '无') + ' · 缺键=' + (i18nOpt.missing.join(',') || '无'));
      ok('设置页的正文是 JS 填的：i18n-pending 已撤、正文非空（#39）',
        i18nOpt.zh.pending === false && i18nOpt.zh.h1.length > 0 && i18nOpt.zh.sub.length > 0,
        JSON.stringify(i18nOpt.zh));
      ok('设置页切成英文后正文真的跟着变，切回来也还原（#39 给 #35 铺的路）',
        i18nOpt.en.lang === 'en' && i18nOpt.en.h1 !== i18nOpt.zh.h1
          && i18nOpt.back === i18nOpt.zh.h1,
        JSON.stringify({ zh: i18nOpt.zh.h1, en: i18nOpt.en.h1, back: i18nOpt.back }));

      /* ---- 商店名字与描述（#35 第 2 步 / #56）----
         manifest 里的字符串**没法由 JS 改**，只能走 `_locales` + `__MSG_xxx__`。
         这条路最阴的一点是：占位符写错一个字母，Chrome 会把 `__MSG_extName__`
         原样显示出来 —— 而那时候扩展**照样能正常加载**，什么都不会报。
         所以这里在真实浏览器里把它读回来。 */
      const i18nMf = await opt.evaluate(() => ({
        uiLang: chrome.i18n.getUILanguage(),
        name: chrome.i18n.getMessage('extName'),
        desc: chrome.i18n.getMessage('extDesc'),
        actionTitle: chrome.i18n.getMessage('extActionTitle'),
        mfName: chrome.runtime.getManifest().name,
        mfDesc: chrome.runtime.getManifest().description,
      }));
      ok('_locales 的三个键都能被 chrome.i18n 读到，且 description ≤ 132（#56）',
        i18nMf.name.length > 0 && !/__MSG_/.test(i18nMf.name)
          && i18nMf.desc.length > 0 && i18nMf.desc.length <= 132
          && i18nMf.actionTitle.length > 0,
        JSON.stringify(i18nMf));
      ok('manifest 的 name / description 在运行时已解析（不是 __MSG__ 原文）（#56）',
        i18nMf.mfName.length > 0 && !/__MSG_/.test(i18nMf.mfName)
          && i18nMf.mfDesc.length > 0 && !/__MSG_/.test(i18nMf.mfDesc),
        JSON.stringify({ name: i18nMf.mfName, desc: i18nMf.mfDesc }));

      /* ---- 界面语言下拉（#35 第 3 步）----
         这一条的关键不是「文案变了」，而是**三个下拉的选项文案也一起变**。
         它们由 JS 渲染（renderSelects），漏刷任何一处都会停在
         「页面是英文、下拉里还是中文」这种半截状态 —— 源码里完全看不出来。 */
      const uiSel = await opt.evaluate(() => {
        const s = document.getElementById('uiLang');
        return s
          ? {
            values: Array.prototype.map.call(s.options, (o) => o.value),
            texts: Array.prototype.map.call(s.options, (o) => o.textContent),
            value: s.value,
          }
          : null;
      });
      ok('设置页有「界面语言」下拉，三档（跟随浏览器 / 中文 / English）（#35）',
        !!uiSel && uiSel.values.join(',') === 'auto,zh,en' && uiSel.texts.length === 3
          && uiSel.texts.every((x) => x && x.length > 0),
        JSON.stringify(uiSel));

      const uiSwitched = await opt.evaluate(async () => {
        const before = {
          dir: document.getElementById('preferredLang').value,
          font: document.getElementById('panelFont').value,
          rate: document.getElementById('speakRate').value,
          accent: document.getElementById('speakAccent').value,
          stepText: document.getElementById('panelFont').options[0].textContent,
        };
        const s = document.getElementById('uiLang');
        s.value = 'en';
        s.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 250));
        const after = {
          h1: (document.querySelector('[data-i18n="opt.h1"]') || {}).textContent || '',
          secLang: (document.querySelector('[data-i18n="opt.secLang"]') || {}).textContent || '',
          stepText: document.getElementById('panelFont').options[0].textContent,
          dirText: document.getElementById('preferredLang').options[0].textContent,
          dir: document.getElementById('preferredLang').value,
          font: document.getElementById('panelFont').value,
          rate: document.getElementById('speakRate').value,
          accent: document.getElementById('speakAccent').value,
          selValue: s.value,
          htmlLang: document.documentElement.getAttribute('lang'),
          docTitle: document.title,
          stored: (await chrome.storage.local.get({ uiLang: '' })).uiLang,
        };
        return { before: before, after: after };
      });
      ok('设置页切界面语言：静态文案 + 三个下拉的选项文案一起跟着变（#35）',
        uiSwitched.after.htmlLang === 'en' && uiSwitched.after.h1 !== '划词翻译'
          && uiSwitched.after.stepText !== uiSwitched.before.stepText
          && uiSwitched.after.dirText !== uiSwitched.before.stepText
          && !/[\u4e00-\u9fff]/.test(uiSwitched.after.secLang + uiSwitched.after.dirText)
          && !/[\u4e00-\u9fff]/.test(uiSwitched.after.docTitle)
          && uiSwitched.after.stored === 'en',
        JSON.stringify(uiSwitched));
      /* ⚠️ 这里列的是**所有由 renderSelects() 重建的下拉** ——
         漏一个不会报错，只会在切界面语言时把它悄悄改掉（#10 加朗读那两个时差点漏掉）。 */
      ok('切语言不会把别的下拉重置掉（翻译方向 / 浮层档位 / 朗读设置保持原值）（#35 / #10）',
        uiSwitched.after.dir === uiSwitched.before.dir
          && uiSwitched.after.font === uiSwitched.before.font
          && uiSwitched.after.rate === uiSwitched.before.rate
          && uiSwitched.after.accent === uiSwitched.before.accent
          && uiSwitched.after.selValue === 'en',
        JSON.stringify({ before: uiSwitched.before, after: uiSwitched.after }));

      // 切回中文，免得影响后面的用例（这一步也是「切回来能不能还原」的断言）
      const uiBack = await opt.evaluate(async () => {
        const s = document.getElementById('uiLang');
        s.value = 'zh';
        s.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 250));
        return {
          h1: (document.querySelector('[data-i18n="opt.h1"]') || {}).textContent || '',
          stepText: document.getElementById('panelFont').options[0].textContent,
          htmlLang: document.documentElement.getAttribute('lang'),
          stored: (await chrome.storage.local.get({ uiLang: '' })).uiLang,
        };
      });
      ok('设置页切回中文，正文与下拉一起还原（#35）',
        uiBack.h1 === '划词翻译' && uiBack.htmlLang === 'zh-CN' && uiBack.stored === 'zh'
          && /[\u4e00-\u9fff]/.test(uiBack.stepText),
        JSON.stringify(uiBack));

      ok('设置页无脚本错误', optErr.length === 0, optErr.join(' | ') || '无');
      await opt.close();
    }

    const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    ok('页面无控制台错误', errs.length === 0, errs.join(' | ') || '无');
    if (logs.length) { console.log('\n--- 页面控制台 ---'); console.log(logs.join('\n')); }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await sleep(700);   // Windows 上文件锁不一定立刻释放，等一拍再删
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==> ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
