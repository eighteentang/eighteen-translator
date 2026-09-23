'use strict';

/* 划词翻译 —— 设置页逻辑 */

const DEFAULTS = {
  enabled: true,
  engine: 'deepseek',
  targetLang: 'zh',
  baiduAppId: '',
  baiduKey: '',
  deepseekKey: ''
};

const TEST_TEXT = {
  zh: 'The quick brown fox jumps over the lazy dog.',
  en: '这是一段用于测试的中文文本。'
};

const $ = (id) => document.getElementById(id);

function currentEngine() {
  const checked = document.querySelector('input[name="engine"]:checked');
  return checked ? checked.value : 'google';
}

function syncEnginePanels() {
  const engine = currentEngine();
  $('cfg-baidu').classList.toggle('on', engine === 'baidu');
  $('cfg-deepseek').classList.toggle('on', engine === 'deepseek');
}

function fill(cfg) {
  $('enabled').checked = cfg.enabled !== false;
  $('targetLang').value = cfg.targetLang || 'zh';
  $('baiduAppId').value = cfg.baiduAppId || '';
  $('baiduKey').value = cfg.baiduKey || '';
  $('deepseekKey').value = cfg.deepseekKey || '';

  const radio = document.querySelector('input[name="engine"][value="' + (cfg.engine || 'google') + '"]');
  if (radio) radio.checked = true;

  syncEnginePanels();
}

function collect() {
  return {
    enabled: $('enabled').checked,
    engine: currentEngine(),
    targetLang: $('targetLang').value,
    baiduAppId: $('baiduAppId').value.trim(),
    baiduKey: $('baiduKey').value.trim(),
    deepseekKey: $('deepseekKey').value.trim()
  };
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// 允许在没有扩展 API 的环境里打开本页（此时只能看界面，不能保存或测试）
const hasExt = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime);

function save() {
  if (!hasExt) return Promise.reject(new Error('当前不在扩展环境中，无法保存'));
  return chrome.storage.local.set(collect());
}

function translate(text) {
  return new Promise((resolve, reject) => {
    if (!hasExt) {
      reject(new Error('当前不在扩展环境中，无法测试'));
      return;
    }
    chrome.runtime.sendMessage({ type: 'translate', text: text }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res || !res.ok) {
        reject(new Error((res && res.error) || '翻译失败'));
        return;
      }
      resolve(res);
    });
  });
}

/* ---------- 事件 ---------- */

document.querySelectorAll('input[name="engine"]').forEach((el) => {
  el.addEventListener('change', syncEnginePanels);
});

$('save').addEventListener('click', () => {
  save()
    .then(() => setStatus('已保存', 'ok'))
    .catch((e) => setStatus('保存失败：' + e.message, 'err'));
});

$('test').addEventListener('click', () => {
  const btn = $('test');
  btn.disabled = true;
  setStatus('正在测试…');

  const cfg = collect();

  // 先保存，确保后台读到的是当前表单里的配置
  save()
    .then(() => translate(TEST_TEXT[cfg.targetLang] || TEST_TEXT.zh))
    .then((res) => {
      setStatus('测试通过：' + res.text, 'ok');
    })
    .catch((e) => {
      setStatus('测试失败：' + e.message, 'err');
    })
    .finally(() => {
      btn.disabled = false;
    });
});

/* ---------- 初始化 ---------- */

if (hasExt) {
  chrome.storage.local.get(DEFAULTS).then((v) => fill(Object.assign({}, DEFAULTS, v)));
} else {
  fill(DEFAULTS);
}
