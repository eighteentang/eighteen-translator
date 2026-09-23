/* 临时自测脚本：mock chrome API 与 fetch，验证 background.js 的引擎调度与错误处理 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'config.js'));   // 共享配置需先加载，background.js 依赖它

let handler = null;
let override = {};
let mockFetch = async () => { throw new Error('no mock set'); };
let captured = {};

global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { handler = fn; } },
    onInstalled: { addListener: () => {} },
    openOptionsPage: () => {}
  },
  storage: {
    local: {
      get: (defaults) => Promise.resolve(Object.assign({}, defaults, override)),
      set: () => Promise.resolve()
    }
  },
  action: { onClicked: { addListener: () => {} } }
};

global.fetch = (url, opts) => mockFetch(url, opts);

require(path.join(ROOT, 'background.js'));

function call(text) {
  return new Promise((resolve) => {
    handler({ type: 'translate', text }, {}, resolve);
  });
}

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

(async () => {
  /* 1. DeepSeek */
  override = { engine: 'deepseek', targetLang: 'zh', deepseekKey: 'sk-test' };
  captured = {};
  mockFetch = async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    captured.auth = opts.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '  \u4f60\u597d\uff0c\u4e16\u754c  ' } }] }) };
  };

  let r = await call('Hello, world');
  check('DeepSeek \u8fd4\u56de\u8bd1\u6587\u5e76\u53bb\u9996\u5c3e\u7a7a\u767d', r.ok === true && r.text === '\u4f60\u597d\uff0c\u4e16\u754c', JSON.stringify(r));
  check('DeepSeek \u4f7f\u7528 deepseek-flash \u6a21\u578b', captured.body.model === 'deepseek-flash', captured.body.model);
  check('DeepSeek \u5df2\u663e\u5f0f\u5173\u95ed\u601d\u8003\u6a21\u5f0f', !!(captured.body.thinking && captured.body.thinking.type === 'disabled'), JSON.stringify(captured.body.thinking));
  check('DeepSeek \u5e26 Bearer \u8ba4\u8bc1', captured.auth === 'Bearer sk-test', captured.auth);
  check('DeepSeek \u76ee\u6807\u8bed\u8a00\u5199\u8fdb\u63d0\u793a\u8bcd', /\u7b80\u4f53\u4e2d\u6587/.test(captured.body.messages[0].content));
  check('DeepSeek \u54cd\u5e94\u5305\u542b engine \u5b57\u6bb5', r.engine === 'deepseek', String(r.engine));

  /* 2. Google：多段结果拼接 */
  override = { engine: 'google', targetLang: 'zh' };
  mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [[['\u4f60\u597d', 'hello', null, null, 10], ['\u4e16\u754c', ' world', null, null, 10]], null, 'en']
  });
  r = await call('hello world');
  check('Google \u591a\u6bb5\u7ed3\u679c\u6b63\u786e\u62fc\u63a5', r.ok === true && r.text === '\u4f60\u597d\u4e16\u754c', JSON.stringify(r));

  /* 4. Google 429 */
  override = { engine: 'google', targetLang: 'zh' };
  mockFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  r = await call('hello');
  check('Google 429 \u6709\u4e13\u95e8\u63d0\u793a', r.ok === false && /429/.test(r.error), r.error);

  /* 4. DeepSeek 缺凭据：不发请求，给出可读提示 */
  override = { engine: 'deepseek', targetLang: 'zh', deepseekKey: '' };
  mockFetch = async () => { throw new Error('\u4e0d\u5e94\u53d1\u8d77\u8bf7\u6c42'); };
  r = await call('hello');
  check('DeepSeek \u7f3a\u51ed\u636e\u65f6\u4e0d\u53d1\u8bf7\u6c42\u5e76\u63d0\u793a', r.ok === false && /\u5c1a\u672a\u586b\u5199/.test(r.error), r.error);

  /* 5. 网络失败 */
  override = { engine: 'google', targetLang: 'zh' };
  mockFetch = async () => { throw new TypeError('Failed to fetch'); };
  r = await call('hello');
  check('\u7f51\u7edc\u5931\u8d25\u88ab\u8f6c\u6210\u53ef\u8bfb\u63d0\u793a', r.ok === false && /\u7f51\u7edc\u8bf7\u6c42\u5931\u8d25/.test(r.error), r.error);

  /* 6. 空文本 */
  override = { engine: 'google', targetLang: 'zh' };
  r = await call('');
  check('\u7a7a\u6587\u672c\u88ab\u62d2\u7edd', r.ok === false, JSON.stringify(r));

  /* 7. 英文目标语言 */
  override = { engine: 'deepseek', targetLang: 'en', deepseekKey: 'sk-test' };
  captured = {};
  mockFetch = async (url, opts) => {
    captured.body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hello' } }] }) };
  };
  r = await call('\u4f60\u597d');
  check('DeepSeek \u76ee\u6807\u4e3a\u82f1\u6587\u65f6\u63d0\u793a\u8bcd\u6b63\u786e', /English/.test(captured.body.messages[0].content));

  /* 8. 共享配置：quotaMode 默认值（config.js 是单一真源） */
  check('DEFAULTS.quotaMode \u9ed8\u8ba4\u4e3a own', CFG.DEFAULTS.quotaMode === 'own', String(CFG.DEFAULTS.quotaMode));

  /* 9. 平台免费额度：预留接缝，应明确报「尚未开放」且不发任何请求 */
  override = { quotaMode: 'free', engine: 'deepseek', targetLang: 'zh', deepseekKey: 'sk-test' };
  mockFetch = async () => { throw new Error('\u4e0d\u5e94\u53d1\u8d77\u8bf7\u6c42'); };
  r = await call('hello');
  check('\u5e73\u53f0\u514d\u8d39\u989d\u5ea6\u672a\u5f00\u653e\u65f6\u6709\u660e\u786e\u63d0\u793a', r.ok === false && /\u5c1a\u672a\u5f00\u653e/.test(r.error), r.error);

  /* 10. quotaMode='free' 优先于引擎选择 —— 即使填了凭据也不走引擎 */
  override = { quotaMode: 'free', engine: 'deepseek', targetLang: 'zh', deepseekKey: 'sk-test' };
  mockFetch = async () => { throw new Error('\u4e0d\u5e94\u53d1\u8d77\u8bf7\u6c42'); };
  r = await call('hello');
  check('quotaMode=free \u4f18\u5148\u4e8e\u5f15\u64ce\u9009\u62e9', r.ok === false && /\u5c1a\u672a\u5f00\u653e/.test(r.error), r.error);

  /* 11. 百度已移除：配置里不应再残留相关键 */
  check('\u914d\u7f6e\u91cc\u5df2\u4e0d\u542b\u767e\u5ea6\u76f8\u5173\u952e', !('baiduAppId' in CFG.DEFAULTS) && !('baiduKey' in CFG.DEFAULTS), Object.keys(CFG.DEFAULTS).join(','));

  console.log('\n==> ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
