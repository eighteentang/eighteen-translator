'use strict';

/* 划词翻译 —— 后台服务（Service Worker）
   职责：接收 content script 的翻译请求，按配置调用对应引擎，返回译文。
   放在后台统一发请求的原因：content script 受页面 CSP 限制，跨域请求容易失败。 */

/* DEFAULTS 的单一真源在 config.js —— 这里不再自带一份拷贝。
   MV3 的 service worker 是 classic script，importScripts 为同步加载；
   Node 环境（dev/selftest.js）由测试脚本先行 require('./config.js')。 */
if (typeof importScripts === 'function') importScripts('config.js');
if (!globalThis.WT_CONFIG) {
  throw new Error('config.js 未加载：请确认 manifest 的 service_worker 与自测脚本都已先加载它');
}
const DEFAULTS = globalThis.WT_CONFIG.DEFAULTS;

// 各家引擎的语言代码不一致，在这里做映射
const LANG = {
  google: { zh: 'zh-CN', en: 'en' },
  baidu: { zh: 'zh', en: 'en' }
};

const TIMEOUT_MS = {
  google: 10000,
  baidu: 10000,
  deepseek: 25000
};

function getConfig() {
  return chrome.storage.local.get(DEFAULTS).then((v) => Object.assign({}, DEFAULTS, v));
}

function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal }))
    .finally(() => clearTimeout(timer));
}

/* ---------- 引擎 1：Google 免费接口（无需配置） ---------- */

async function translateGoogle(text, target) {
  const tl = LANG.google[target] || 'zh-CN';
  const url = 'https://translate.googleapis.com/translate_a/single'
    + '?client=gtx&dt=t&sl=auto&tl=' + encodeURIComponent(tl)
    + '&q=' + encodeURIComponent(text);

  const res = await fetchWithTimeout(url, {}, TIMEOUT_MS.google);
  if (res.status === 429) {
    throw new Error('Google 免费接口返回 429（请求过多）。这是公共接口对共享 IP 的限流，'
      + '换个代理节点可能恢复，或到设置页改用百度 / DeepSeek 引擎');
  }
  if (!res.ok) {
    throw new Error('Google 接口返回 HTTP ' + res.status
      + '（若在中国大陆，请确认代理已开启且浏览器走代理）');
  }

  const data = await res.json();
  const segs = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  const out = segs.map((seg) => (Array.isArray(seg) ? seg[0] : '') || '').join('');
  if (!out) throw new Error('Google 接口返回内容为空');
  return out;
}

/* ---------- 引擎 2：百度翻译开放平台 ---------- */

async function translateBaidu(text, target, cfg) {
  if (!cfg.baiduAppId || !cfg.baiduKey) {
    throw new Error('尚未填写百度翻译的 AppID 或密钥，请到设置页填写');
  }

  const to = LANG.baidu[target] || 'zh';
  const salt = String(Date.now());
  const sign = md5(cfg.baiduAppId + text + salt + cfg.baiduKey);

  const qs = new URLSearchParams({
    q: text,
    from: 'auto',
    to: to,
    appid: cfg.baiduAppId,
    salt: salt,
    sign: sign
  }).toString();

  const res = await fetchWithTimeout(
    'https://fanyi-api.baidu.com/api/trans/vip/translate?' + qs,
    {},
    TIMEOUT_MS.baidu
  );

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('百度接口返回了无法解析的内容（HTTP ' + res.status + '）');
  }

  if (data && data.error_code) {
    throw new Error('百度翻译报错 ' + data.error_code + '：' + (data.error_msg || '未知原因'));
  }

  const rows = data && Array.isArray(data.trans_result) ? data.trans_result : [];
  const out = rows.map((i) => i.dst || '').join('\n');
  if (!out) throw new Error('百度接口返回内容为空');
  return out;
}

/* ---------- 引擎 3：DeepSeek ---------- */

async function translateDeepseek(text, target, cfg) {
  if (!cfg.deepseekKey) {
    throw new Error('尚未填写 DeepSeek API Key，请到设置页填写');
  }

  const langName = target === 'en' ? 'English' : '简体中文';
  const body = {
    model: 'deepseek-flash',
    messages: [
      {
        role: 'system',
        content: '你是一个翻译引擎。把用户给出的文本翻译成' + langName
          + '。只输出译文本身：不要解释、不要加引号、不要重复原文、不要添加任何前后缀。'
      },
      { role: 'user', content: text }
    ],
    stream: false,
    // 思考模式默认开启且强度为 high，对翻译任务纯属拖慢速度，这里显式关闭
    thinking: { type: 'disabled' }
  };

  const res = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.deepseekKey
    },
    body: JSON.stringify(body)
  }, TIMEOUT_MS.deepseek);

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('DeepSeek 返回了无法解析的内容（HTTP ' + res.status + '）');
  }

  if (!res.ok) {
    const m = data && data.error && data.error.message ? data.error.message : ('HTTP ' + res.status);
    throw new Error('DeepSeek 报错：' + m);
  }

  const msg = data && data.choices && data.choices[0] ? data.choices[0].message : null;
  const out = msg && msg.content ? String(msg.content).trim() : '';
  if (!out) throw new Error('DeepSeek 返回内容为空');
  return out;
}

/* ---------- 引擎 4：平台免费额度（预留接缝，尚未开放） ---------- */

/* 用户不配置任何凭据、由本扩展的服务端代付额度。

   将来接入托管后端时，只需实现这个函数（请求自己的 Worker），
   其余文件 —— 设置页、配置存储、调度逻辑 —— 都不用动。

   实现时要注意的三条（先记在这里，免得以后忘）：
   1. 服务端地址写在这里，绝不要把任何 API Key 打进扩展包；
   2. 服务端要能识别设备、按日限额，并设「每日总预算熔断」兜底 ——
      单靠每人每日上限挡不住批量刷，熔断才是唯一能兜住损失的机制；
   3. 网络失败时不要锁死用户，退回提示「改用自己的 API Key」，而不是卡住不动。 */
async function translateViaPlatform(text, target, cfg) {
  throw new Error('平台免费额度正在测试中，尚未开放。请到设置页改用「使用自己的 API Key」');
}

/* ---------- 调度与错误翻译 ---------- */

function runTranslate(text, cfg) {
  const target = cfg.targetLang || 'zh';

  // 额度来源优先于引擎选择：走平台额度时不看用户配置的引擎与凭据
  if (cfg.quotaMode === 'free') return translateViaPlatform(text, target, cfg);

  if (cfg.engine === 'baidu') return translateBaidu(text, target, cfg);
  if (cfg.engine === 'deepseek') return translateDeepseek(text, target, cfg);
  return translateGoogle(text, target);
}

function friendlyError(err) {
  if (!err) return '未知错误';
  const name = err.name || '';
  const msg = err.message || String(err);
  if (name === 'AbortError' || /aborted/i.test(msg)) return '请求超时，请检查网络或代理';
  if (/Failed to fetch|NetworkError|net::/i.test(msg)) {
    return '网络请求失败：可能是网络不通、代理未开启，或该接口域名被拦截';
  }
  return msg;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'translate') return;

  const text = String(msg.text || '');
  if (!text) {
    sendResponse({ ok: false, error: '没有可翻译的内容' });
    return;
  }

  getConfig()
    .then((cfg) => runTranslate(text, cfg)
      .then((out) => sendResponse({ ok: true, text: out, engine: cfg.engine })))
    .catch((err) => sendResponse({ ok: false, error: friendlyError(err) }));

  return true; // 保持消息通道打开，等待异步 sendResponse
});

chrome.runtime.onInstalled.addListener(() => {
  getConfig().then((cfg) => chrome.storage.local.set(cfg));
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/* ---------- MD5（百度签名需要，浏览器 Web Crypto 不提供 MD5） ---------- */

function md5(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const len = bytes.length;
  const bitLen = len * 8;

  const buf = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  buf.set(bytes);
  buf[len] = 0x80;

  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, bitLen >>> 0, true);
  dv.setUint32(buf.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }

  const M = new Uint32Array(16);

  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = dv.getUint32(off + i * 4, true);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0 >>> 0, true);
  odv.setUint32(4, b0 >>> 0, true);
  odv.setUint32(8, c0 >>> 0, true);
  odv.setUint32(12, d0 >>> 0, true);

  return Array.from(out).map((b) => b.toString(16).padStart(2, '0')).join('');
}
