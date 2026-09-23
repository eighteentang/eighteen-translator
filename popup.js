'use strict';

/* 划词翻译 —— 工具栏弹层
   ────────────────────────────────────────────────────────────────
   只放高频操作（开关、切引擎）。完整配置在 options.html 里，点底部按钮过去。

   popup 一旦关闭就被销毁，所以这里的每一次改动都立即写入 storage，
   不设「保存」按钮。写完之后 content script 会通过 storage.onChanged 自动感知。 */

const DEFAULTS = globalThis.WT_CONFIG.DEFAULTS;
const $ = (id) => document.getElementById(id);

// 允许在没有扩展 API 的环境里打开本页（此时只能看界面）
const hasExt = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime);

function currentEngine() {
  const checked = document.querySelector('input[name="engine"]:checked');
  return checked ? checked.value : 'deepseek';
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind || '';
}

function render(cfg) {
  $('enabled').checked = cfg.enabled !== false;

  const engine = cfg.engine === 'google' ? 'google' : 'deepseek';
  const radio = document.querySelector('input[name="engine"][value="' + engine + '"]');
  if (radio) radio.checked = true;

  const hasKey = !!(cfg.deepseekKey && String(cfg.deepseekKey).trim());
  const hint = $('hint-deepseek');
  hint.textContent = hasKey ? '已配置 API Key' : '未配置 API Key —— 用下方「完整设置」填写';
  hint.className = 'hint ' + (hasKey ? 'ok' : 'warn');

  $('quota-label').textContent = cfg.quotaMode === 'free'
    ? '平台免费额度（测试中，尚未开放）'
    : '使用自己的 API Key';

  // 未配置 API Key 的情况已由上面那行红字说明，底部不再重复提示
}

function save(patch) {
  if (!hasExt) return Promise.resolve();
  return chrome.storage.local.set(patch);
}

/* ---------- 事件 ---------- */

$('enabled').addEventListener('change', () => {
  const on = $('enabled').checked;
  save({ enabled: on })
    .then(() => setStatus(on ? '已开启划词翻译' : '已关闭划词翻译', 'ok'))
    .catch((e) => setStatus('保存失败：' + e.message, 'err'));
});

document.querySelectorAll('input[name="engine"]').forEach((el) => {
  el.addEventListener('change', () => {
    const engine = currentEngine();
    save({ engine })
      .then(() => chrome.storage.local.get(DEFAULTS))
      .then((v) => {
        const hasKey = !!(v.deepseekKey && String(v.deepseekKey).trim());
        if (engine === 'deepseek' && !hasKey) {
          setStatus('已切到 DeepSeek，但还没有 API Key', 'err');
          return;
        }
        setStatus(engine === 'deepseek' ? '已切换到 DeepSeek' : '已切换到 Google 免费接口', 'ok');
      })
      .catch((e) => setStatus('保存失败：' + e.message, 'err'));
  });
});

$('open-options').addEventListener('click', () => {
  if (hasExt && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    window.close();
  } else {
    setStatus('当前不在扩展环境中', 'err');
  }
});

/* ---------- 初始化 ---------- */

if (hasExt) {
  chrome.storage.local.get(DEFAULTS)
    .then((v) => {
      render(Object.assign({}, DEFAULTS, v));
      try {
        $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
      } catch (e) { /* 拿不到版本号不影响使用 */ }
    })
    .catch((e) => setStatus('读取配置失败：' + e.message, 'err'));
} else {
  render(DEFAULTS);
}
