'use strict';

/* 划词翻译 —— 内容脚本
   职责：监听划词，在选区旁显示浮层，把文本交给后台翻译后渲染结果。
   浮层用 Shadow DOM 封装，避免被宿主页面的 CSS 污染。 */

(() => {
  const HOST_ID = 'wt-translate-host';
  const DEFAULTS = { enabled: true, engine: 'deepseek', targetLang: 'zh' };
  const ENGINE_LABEL = { google: 'Google 翻译', baidu: '百度翻译', deepseek: 'DeepSeek' };

  const MAX_LEN = 1000;   // 超过这个长度不翻译，避免误选整页
  const DEBOUNCE = 220;   // 松开鼠标后延迟，等浏览器把选区确定下来
  const GAP = 8;          // 浮层与选区的间距
  const MARGIN = 8;       // 浮层与视口边缘的最小间距

  const CSS = `
    :host { all: initial; }
    .panel {
      position: absolute;
      top: 0;
      left: 0;
      box-sizing: border-box;
      display: none;
      width: max-content;
      max-width: 420px;
      min-width: 200px;
      padding: 10px 12px 11px;
      border: 1px solid rgba(0, 0, 0, 0.10);
      border-radius: 10px;
      background: #ffffff;
      color: #1c1c1c;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.65;
      text-align: left;
      word-break: break-word;
      overflow-wrap: anywhere;
      -webkit-font-smoothing: antialiased;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 5px;
    }
    .tag {
      font-size: 11px;
      color: #8a8a8a;
      white-space: nowrap;
    }
    .tools { display: flex; align-items: center; gap: 2px; }
    .btn {
      all: unset;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 5px;
      font-size: 11px;
      line-height: 1.4;
      color: #8a8a8a;
      white-space: nowrap;
    }
    .btn:hover { background: rgba(128, 128, 128, 0.16); color: #444444; }
    .text { white-space: pre-wrap; }
    .muted { color: #8a8a8a; font-size: 13px; }
    .err { color: #c0392b; font-size: 13px; }
    @media (prefers-color-scheme: dark) {
      .panel {
        background: #2a2a2a;
        color: #ededed;
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
      }
      .tag, .btn, .muted { color: #9a9a9a; }
      .btn:hover { background: rgba(255, 255, 255, 0.14); color: #e0e0e0; }
      .err { color: #ff8f85; }
    }
  `;

  let cfg = Object.assign({}, DEFAULTS);
  let host = null;
  let panel = null;
  let copyBtn = null;
  let timer = null;
  let seq = 0;
  let curRect = null;
  let scrollRef = 0;
  let lastResult = '';
  let rafPending = false;

  /* ---------- 配置 ---------- */

  function loadConfig() {
    try {
      chrome.storage.local.get(DEFAULTS, (v) => {
        if (chrome.runtime.lastError) return;
        cfg = Object.assign({}, DEFAULTS, v);
      });
    } catch (e) {
      // 扩展被重新加载后旧脚本会失效，忽略即可
    }
  }

  loadConfig();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      Object.keys(changes).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) cfg[k] = changes[k].newValue;
      });
      if (cfg.enabled === false) close();
    });
  } catch (e) {
    // 同上
  }

  /* ---------- 浮层 ---------- */

  function ensure() {
    if (host && host.isConnected) return true;

    try {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('style',
        'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;');

      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      panel = document.createElement('div');
      panel.className = 'panel';
      shadow.appendChild(panel);

      document.documentElement.appendChild(host);
      return true;
    } catch (e) {
      host = null;
      panel = null;
      return false;
    }
  }

  function build() {
    panel.textContent = '';

    const head = document.createElement('div');
    head.className = 'head';

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = ENGINE_LABEL[cfg.engine] || '翻译';

    const tools = document.createElement('div');
    tools.className = 'tools';

    copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.type = 'button';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', onCopy);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', close);

    tools.appendChild(copyBtn);
    tools.appendChild(closeBtn);
    head.appendChild(tag);
    head.appendChild(tools);

    const body = document.createElement('div');
    body.className = 'body';

    panel.appendChild(head);
    panel.appendChild(body);
  }

  function setBody(text, cls) {
    const body = panel.querySelector('.body');
    body.textContent = '';
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    body.appendChild(div);
  }

  function place() {
    if (!panel || !curRect) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;

    let top = curRect.bottom + GAP;
    if (top + ph > vh - MARGIN) {
      const above = curRect.top - GAP - ph;
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - ph - MARGIN);
    }

    let left = curRect.left + curRect.width / 2 - pw / 2;
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - pw - MARGIN));

    panel.style.top = Math.round(top) + 'px';
    panel.style.left = Math.round(left) + 'px';
  }

  function close() {
    seq++;
    if (panel) panel.style.display = 'none';
    curRect = null;
    lastResult = '';
  }

  function onCopy() {
    if (!lastResult) return;
    navigator.clipboard.writeText(lastResult).then(() => {
      if (!copyBtn) return;
      copyBtn.textContent = '已复制';
      setTimeout(() => {
        if (copyBtn) copyBtn.textContent = '复制';
      }, 1200);
    }).catch(() => {
      if (copyBtn) copyBtn.textContent = '复制失败';
    });
  }

  /* ---------- 翻译流程 ---------- */

  function request(text) {
    if (!ensure()) return;

    build();
    setBody('翻译中…', 'muted');
    panel.style.display = 'block';
    place();

    const my = ++seq;

    try {
      chrome.runtime.sendMessage({ type: 'translate', text: text }, (res) => {
        if (my !== seq) return;

        if (chrome.runtime.lastError) {
          fail('扩展未就绪，请到 chrome://extensions 重新加载本扩展，然后刷新页面');
          return;
        }
        if (!res || !res.ok) {
          fail((res && res.error) || '翻译失败');
          return;
        }

        lastResult = res.text;
        setBody(res.text, 'text');
        place();
      });
    } catch (e) {
      fail('扩展上下文已失效，请刷新页面');
    }
  }

  function fail(msg) {
    lastResult = '';
    setBody(msg, 'err');
    place();
  }

  function pick() {
    timer = null;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      close();
      return;
    }

    const text = (sel.toString() || '').trim();
    if (!text || text.length > MAX_LEN) {
      close();
      return;
    }
    // 纯数字、纯符号不翻译
    if (!/[\p{L}\p{N}]/u.test(text)) {
      close();
      return;
    }

    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (e) {
      rect = null;
    }
    if (!rect || (!rect.width && !rect.height)) {
      close();
      return;
    }

    curRect = {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };
    scrollRef = window.scrollY;

    request(text);
  }

  /* ---------- 事件 ---------- */

  function inPanel(e) {
    return !!(host && e.composedPath && e.composedPath().indexOf(host) !== -1);
  }

  document.addEventListener('mouseup', (e) => {
    if (cfg.enabled === false) return;
    if (inPanel(e)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(pick, DEBOUNCE);
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (!panel || panel.style.display === 'none') return;
    if (inPanel(e)) return;
    close();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  }, true);

  function onScroll() {
    if (!panel || panel.style.display === 'none' || !curRect || rafPending) return;

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!panel || panel.style.display === 'none' || !curRect) return;

      let rect = null;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed) {
          rect = sel.getRangeAt(0).getBoundingClientRect();
        }
      } catch (e) {
        rect = null;
      }

      if (rect && (rect.width || rect.height)) {
        curRect = {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height
        };
        scrollRef = window.scrollY;
      } else {
        // 选区已被页面清除，按滚动偏移推算浮层位置
        const dy = scrollRef - window.scrollY;
        curRect = {
          top: curRect.top + dy,
          bottom: curRect.bottom + dy,
          left: curRect.left,
          width: curRect.width,
          height: curRect.height
        };
        scrollRef = window.scrollY;
      }

      place();
    });
  }

  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', close, { passive: true });
})();
