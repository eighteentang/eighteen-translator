# Eighteen Translator

[![test](https://github.com/eighteentang/eighteen-translator/actions/workflows/test.yml/badge.svg)](https://github.com/eighteentang/eighteen-translator/actions/workflows/test.yml)

**English** · [中文](README.zh-CN.md)

A Chrome / Edge extension (Manifest V3). Select text on any page — a small panel shows the translation. No build step, no dependencies, no account.

- All logic runs on your machine. Nothing goes through a server of ours — the only network calls are to the translation engine **you** configure.
- The panel is wrapped in Shadow DOM, so site CSS can't distort it.
- **11 languages** in any direction (Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Russian, Arabic, Thai). Direction is detected locally.
- **Read the translation aloud** from the panel — the browser's built-in speech synthesis, offline.
- Settings never leave the device and are not synced.
- MIT licensed.

---

## Install (developer mode)

1. Open `chrome://extensions/` (or `edge://extensions/`)
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

> ⚠️ **You need to configure an engine on first run.** The default engine is DeepSeek and needs an API key. If you'd rather not sign up for one, switch to the free Google endpoint.
> The settings page opens itself once on first install (not on updates).

> After changing code, click the reload button on the extension card, then reload the page.

---

## Two entry points

| Entry | How to open | What's in it |
|---|---|---|
| **Toolbar popup** | Click the extension icon | Master switch, trigger mode, target language, today's usage, theme toggle, "disable on this domain", link to settings |
| **Settings page** | "Full settings" in the popup | Engine, API key, translation direction, trigger mode, theme, panel font size and width, read-aloud speed and accent, test engine, usage and cache |

**The split is deliberate**: the popup holds only high-frequency actions. Engine, credentials and the full language pair live in the settings page.

---

## Choosing an engine

> **Measured on the author's machine (2026-09-23)**
>
> | Engine | Result |
> |---|---|
> | Google free endpoint | **Unusable** — 429 through a proxy; a real Chrome UA gets an anti-abuse block page; other params return 403 |
> | DeepSeek | Reachable — HTTP 401 without a key, 0.65 s |
>
> Hence **DeepSeek is the default**. The Google option is kept: it works on networks where the endpoint is reachable and the exit IP isn't rate-limited.

### Google endpoint: where it works

This is an honest labelling, not "temporarily broken". It depends on your network, not on the code:

| Your network | Google free endpoint |
|---|---|
| Outside mainland China, or a clean exit | **Works** |
| Direct connection from mainland China | **Does not work** |
| Proxy whose exit IP is rate-limited | **Does not work** (steady 429) |

The URL, parameters, response parsing, error handling and timeouts were all checked against the endpoint's actual behaviour. A 429 on one machine says something about that machine's exit IP, not about the engine.

### DeepSeek (default)

1. Sign up at the DeepSeek open platform
2. Create an API key under **API keys** (shown once)
3. Paste it into the settings page

Thinking mode is explicitly disabled in code — it defaults to on with `high` effort, which only slows translation down.

---

## How it works

- Select text → release the mouse → a panel appears next to the selection with the translation
- Panel buttons: **copy** and **close**. Close with `Esc` or by clicking away
- The panel follows the selection while scrolling, never covers it, and flips sides near the viewport edge
- **Cross-line selections align to the first line**, not the bounding box centre — the box is as wide as the longest line, and your eye is on the line you started from
- Resizing the window repositions the panel instead of closing it
- Selections over **1000 characters** are refused with an explanation (long text must be selected in parts)
- Pure numbers and symbols don't trigger translation
- **Code, links, emails, file paths and shell commands** are skipped, with a "translate anyway" escape hatch. Can be turned off in settings
- Failures (network, timeout, engine error) offer a **retry** — no need to re-select
- Inside **small iframes** (narrower than 320px or shorter than 220px) nothing happens and no request is sent

### Automatic vs manual

| Mode | Behaviour |
|---|---|
| **Automatic** (default) | Select and release — it translates |
| **Manual** | A small dot appears next to the selection; click it to translate |

Manual mode never sends a request on its own.

### Excluded sites

Two entry points, one shared list: the popup's "disable on this domain" checkbox, and the settings page's list (one domain per line).

Write just the domain — `example.com` also covers all its subdomains. Pasting a full URL works. `#` starts a comment. **Regex is not supported**; `*` may only appear at the front.

> ⚠️ **Reload open tabs after changing the list.** The check runs once at page load, which is exactly why it costs almost nothing.
> The content script is still injected — it just does nothing. "Not translated", not "not injected".

---

## Privacy

Everything runs locally. The extension processes only the text you select, sends it to the engine you chose (DeepSeek with your own key, or the Google endpoint), and stores settings, key, counters and cache in `chrome.storage.local` — **in plain text, never uploaded**. Uninstalling removes all of it.

There is no account system, no analytics, no telemetry, no remote code, and nothing is sold or shared.

**Full policy: [eighteentang.github.io/eighteen-translator/privacy](https://eighteentang.github.io/eighteen-translator/privacy)** (also [in this repo](docs/privacy.html))

### Permissions

| Permission | Why |
|---|---|
| `storage` | Save settings, key, counters, cache locally |
| `https://api.deepseek.com/*`, `https://translate.googleapis.com/*` | Send selected text to the chosen engine |
| Content script on `<all_urls>` | Select-to-translate has to work on the page you're reading |

No other permissions are requested.

---

## Development

Zero dependencies, no build step, plain Node for the checks.

```bash
node dev/check.js         # files & manifest — 5 checks
node dev/selftest.js      # backend logic & pure functions — 123 assertions
node dev/scan-i18n.js     # finds hard-coded Chinese that bypasses strings.js
node dev/check-version.js # manifest version must match CHANGELOG.md
node dev/pack.js          # produce dist/eighteen-translator-v<version>.zip
```

`dev/check.js` catches the failures that are otherwise silent: `_`-prefixed names (Chrome refuses to load the extension), files referenced by the manifest but missing, manifest field problems, and — the one most easily broken without anyone noticing — a shared module placed *after* `content.js` in `content_scripts.js`, which makes `globalThis.WT_*` `undefined` and silently kills the whole script.

`dev/e2e-panel.js` loads the unpacked extension in a headless Chromium and asserts against the real DOM (122 assertions). It needs `puppeteer-core` and takes about two minutes:

```bash
export NODE_PATH=<dir with puppeteer-core>/node_modules
node dev/e2e-panel.js
WT_EXT_DIR=<extracted dir> node dev/e2e-panel.js   # verify a packed zip
```

> ⚠️ Assertions can prove a property changed; they cannot prove a hand-drawn SVG isn't crooked. Icons and layout still get looked at.

### Versioning

`manifest.json`'s `version` is the **single source of truth**; the git tag and `CHANGELOG.md` follow it. `dev/check-version.js` (run in CI) fails if they drift.

| Segment | Bump when |
|---|---|
| `z` | Bug fixes, copy changes |
| `y` | New features |
| `x` | Breaking changes (config keys, storage shape) |

### Release

```bash
node dev/pack.js
```

Produces `dist/eighteen-translator-v<version>.zip` — a whitelist build: only files referenced by the manifest or by the HTML pages, plus `icons/` and `_locales/`. Nothing from `dev/`, `docs/`, or the repo docs. The script reads the archive back and byte-compares every entry before reporting success.

---

## Not implemented

All deliberately deferred, not rejected — see the [issue list](https://github.com/eighteentang/eighteen-translator/issues).

- Custom keyboard shortcuts, side-by-side original/translation, word lookup, whole-page translation
- Vocabulary book / translation history
- Full accessibility pass, settings import/export, automatic engine fallback
- Touch support
- Hosted quota (extension pays, you don't configure credentials) — designed, not started

**Removed**: the Baidu engine (since v0.3.0), including its MD5 signature implementation. Recoverable from git history if ever needed.

---

## License

MIT. See [LICENSE](LICENSE).
