'use strict';

/* 划词翻译 —— 朗读（TTS）（#10）
   ────────────────────────────────────────────────────────────────
   只用浏览器内置的 `speechSynthesis`：
   离线、不上传、不需要任何权限、不需要 Key、服务端成本为 0。

   ⚠️ **这不是「四宿主双模式」的共享模块**（与 config.js / strings.js 那几个不一样）——
   目前只有浮层用得到它，所以只按 content script 的方式加载
   （manifest 的 content_scripts.js 里排在 content.js **之前**）。
   将来设置页要做「试听」时再升级成双模式，现在不提前设计。

   双模式里的「Node」这一半仍然有：`dev/selftest.js` 用 `require` 拿它来测
   分句 / 选音 / 错误过滤这三件事 —— 它们都是纯函数，正是最该被钉住的部分。
*/

(function (root) {
  'use strict';

  /* 单条 utterance 的长度上限。
     各浏览器对「一次能读多长」都有自己的限制（而且不告诉你），
     超了的表现是**后半段被静默吞掉** —— 所以宁可切成多句排队读。 */
  const MAX_SENTENCE = 300;

  /* 句末标点。中英文都认，`…` 与 `；` 也算（长句常常只用分号断）。
     ⚠️ 这里**不含逗号** —— 逗号是「同一句里的停顿」，切开会把语调切碎。
     它只作为超长句的二次切分点，见 hardSplit()。
     ⚠️ `.` 必须显式写进字符类：它是英文句号，漏了会让**整段英文被当成一句**
     （selftest 抓到过 —— 那样长文本就不分句了，正好踩上「后半段被吞掉」那个坑）。 */
  const SENT_END = /(?<=[。！？!?…；;.])/u;

  /* 超长句的二次切分点：软标点（逗号 / 顿号 / 冒号 / 右括号）——
     在这些地方断开，听感上还是一个完整的短语。 */
  const SOFT_END = /[，,、：:）)】」』]/;

  /* 先把连续空白压成一个空格：朗读时换行没有意义，而且会让分句变碎。
     纯符号 / 纯数字（没有字母或数字…… 准确说是没有任何可读内容）返回空数组。 */
  function splitSentences(text, maxLen) {
    const max = maxLen || MAX_SENTENCE;
    const src = String(text || '').replace(/\s+/g, ' ').trim();
    if (!src) return [];
    if (!/[\p{L}\p{N}]/u.test(src)) return [];

    const out = [];
    src.split(SENT_END).forEach((part) => {
      const s = part.trim();
      if (!s) return;
      if (s.length <= max) {
        out.push(s);
      } else {
        hardSplit(s, max).forEach((x) => out.push(x));
      }
    });
    return out;
  }

  /* 把一个超长句切成若干段。
     优先在**后半段**找一个软标点断开（`max` 往回找到一半为止）——
     这样每段都尽量长（少切几次），但不会切在半个词上。
     找不到软标点就硬切。 */
  function hardSplit(s, max) {
    const out = [];
    let rest = s;
    while (rest.length > max) {
      let cut = -1;
      for (let i = max; i > Math.floor(max / 2); i--) {
        if (SOFT_END.test(rest[i - 1])) { cut = i; break; }
      }
      if (cut < 0) cut = max;
      const head = rest.slice(0, cut).trim();
      if (head) out.push(head);
      rest = rest.slice(cut);
    }
    if (rest.trim()) out.push(rest.trim());
    return out;
  }

  /* `speechSynthesis.onerror` 里这两种**不是错误**：
   - `canceled`：我们自己调了 cancel()（用户点了停止 / 换了选区 / 关了浮层）
   - `interrupted`：用户又点了一次朗读，新的一句打断了旧的
   把它们当错误报出来，用户会看到一句莫名其妙的「朗读失败」。 */
  function isBenignError(err) {
    return err === 'canceled' || err === 'interrupted';
  }

  /* 语言 → 优先匹配的语音 lang 前缀列表。
     `voice.lang` 是 'en-US' / 'zh-CN' / 'zh-TW' 这种，与我们内部的 code 不一样，
     所以这里要做一次映射（和 background.js 的 LANG.google 是同一类事）。 */
  function langPrefs(lang, accent) {
    const l = String(lang || '').toLowerCase();
    if (l === 'zh-hant') return ['zh-tw', 'zh-hk', 'zh-hant'];
    if (l === 'zh') return ['zh-cn', 'zh-hans'];
    if (l === 'en') {
      if (accent === 'en-GB') return ['en-gb'];
      if (accent === 'en-US') return ['en-us'];
      return [];   // auto：不指定变体，交给下面的通用匹配
    }
    return [];
  }

  /* 选一条语音。

     ⚠️ **不要直接用 `getVoices()[0]`** —— 不同系统上第一条可能是任何语言，
     表现是「选了日文，读出来是英文」这种完全看不懂的结果。

     顺序：
       1. 按 `langPrefs` 指定的变体精确匹配（en-US / en-GB / zh-TW 这种）
       2. 再按语言主码匹配（'en' 匹配 'en-US' / 'en-GB' / 'en'）
       3. 同一档里优先**本地**语音（`localService`，离线可用、延迟低）
       4. 再优先 `default`
       5. 都没有 → **返回 null**（调用方给可读提示，不要硬塞一条别的语言的声音） */
  function pickVoice(voices, lang, accent) {
    const list = voices || [];
    if (!list.length) return null;

    const key = (v) => String((v && v.lang) || '').toLowerCase().replace(/_/g, '-');
    const base = String(lang || '').toLowerCase().split('-')[0];

    const variants = langPrefs(lang, accent);
    const tiers = variants.concat(base ? [base] : []);

    for (const tier of tiers) {
      const hit = list.filter((v) => {
        const k = key(v);
        return k === tier || k.indexOf(tier + '-') === 0;
      });
      if (!hit.length) continue;

      const local = hit.filter((v) => v.localService === true);
      const pool = local.length ? local : hit;
      const def = pool.find((v) => v.default === true);
      return def || pool[0];
    }

    return null;
  }

  /* 朗读器：把一段文本按句排队读完。

     为什么要有状态机（而不是直接对整段调一次 speak）：
     - 长文本要分句（见 splitSentences）
     - 要能停（停止 = cancel + 清队列）
     - 要能知道「现在在不在读」（浮层按钮靠它切换「读 / 停止」）
     - 要有看门狗：切到后台标签页时 `onend` 可能永远不来，
       那时队列会卡死、按钮一直停在「停止」—— 见 armWatchdog()。

     ⚠️ 全程**不用 `pause()` / `resume()`**：各浏览器行为不一致，
     Safari 尤其不可靠（`resume()` 后不出声是最常见的表现）。
     「暂停」在这条功能里干脆不做 —— 需要的话点停止再点一次重读。

     依赖全部从 `env` 注入，方便在 Node 里测（没有 speechSynthesis）：
       synth / Utterance / setTimeout / clearTimeout / onState / onError */
  function createSpeaker(env) {
    const synth = env.synth;
    const Utterance = env.Utterance;
    const setT = env.setTimeout || setTimeout;
    const clearT = env.clearTimeout || clearTimeout;
    const onState = env.onState || function () {};
    const onError = env.onError || function () {};

    /* 单句最长读这么久。18 秒足够读完 300 字符（正常语速约 4 字/秒），
       而它主要防的是「切到后台标签页后 onend 永远不来」。 */
    const WATCHDOG_MS = 18000;

    let queue = [];
    let idx = 0;
    let speaking = false;
    let watchdog = null;

    function clearWatchdog() {
      if (watchdog) { clearT(watchdog); watchdog = null; }
    }

    function armWatchdog() {
      clearWatchdog();
      watchdog = setT(() => { next(); }, WATCHDOG_MS);
    }

    function finish() {
      clearWatchdog();
      speaking = false;
      queue = [];
      idx = 0;
      onState('idle');
    }

    function next() {
      if (!speaking) return;
      clearWatchdog();
      if (idx >= queue.length) { finish(); return; }

      const text = queue[idx++];
      const u = new Utterance(text);
      u.rate = env.rate;

      const v = pickVoice(synth.getVoices(), env.lang, env.accent);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = env.lang; }

      u.onend = () => next();
      u.onerror = (e) => {
        const code = e && e.error;
        // 用户主动停 / 被新的一次打断 —— 不是错误，而且此时状态已经清过了
        if (isBenignError(code)) return;
        onError(code || 'error');
        finish();
      };

      armWatchdog();
      try {
        synth.speak(u);
      } catch (e) {
        onError('exception');
        finish();
      }
    }

    return {
      /* 开始朗读。返回 false 表示「没读」（空文本 / 没有可用的语音包）——
         调用方靠它决定要不要给提示，所以**不能**静默返回 undefined。 */
      start(text) {
        if (!synth || !Utterance) return false;
        const sents = splitSentences(text);
        if (!sents.length) return false;
        if (!synth.getVoices().length) return false;
        if (!pickVoice(synth.getVoices(), env.lang, env.accent)) return false;

        try { synth.cancel(); } catch (e) { /* 没在读时 cancel 是安全的 */ }
        queue = sents;
        idx = 0;
        speaking = true;
        onState('speaking');
        next();
        return true;
      },

      stop() {
        if (!speaking) return;
        speaking = false;
        clearWatchdog();
        queue = [];
        idx = 0;
        try { synth.cancel(); } catch (e) { /* 同上 */ }
        onState('idle');
      },

      isSpeaking() { return speaking; },

      /* 页面被隐藏 / 重新显示时调一下。切到后台再回来时，有的浏览器会把
         正在读的那句「冻住」，看门狗要重新计时 —— 否则回来时它已经超时、
         莫名其妙跳到下一句。 */
      keepAlive() { if (speaking) armWatchdog(); }
    };
  }

  const api = {
    MAX_SENTENCE,
    splitSentences,
    pickVoice,
    langPrefs,
    isBenignError,
    createSpeaker
  };

  root.WT_SPEAK = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
