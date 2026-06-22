# Reddit Tracker

A standalone, platform-agnostic copy of RECON. Tracks Smash Balloon mentions on
Reddit and Google AI Overview citations. Chrome extension + local Node bridge.
**No cloud** — all data is local JSON. Runs identically on macOS and Windows.

## Layout

```
reddit-tracker/
├── extension/      Chrome extension (load unpacked)
├── bridge/         Standalone Node/Express bridge (port 3458)
│   ├── server.js
│   ├── claude-runner.js   spawns the `claude` CLI (uses existing login, no API key)
│   └── package.json
└── data/           Local JSON state (auto-created, starts empty)
```

## Run

1. **Bridge** (needs Node + the `claude` CLI on PATH):
   ```
   cd bridge
   npm install      # first time only
   npm start        # → http://localhost:3458
   ```
2. **Extension**: open `chrome://extensions`, enable Developer mode,
   "Load unpacked" → select `reddit-tracker/extension`. Click the toolbar icon
   to open the dashboard tab.

## How it differs from RECON

- **Separate bridge** on port **3458** (RECON shares content-pipeline's bridge on 3457).
- **Platform-agnostic**: data dir is resolved relative to the bridge
  (`../data`) instead of a hardcoded `/Users/...` path; the Claude runner uses
  `os.tmpdir()` and shells out on Windows. The macOS-only AppleScript thread
  scraper is gone — thread scraping for **both** comment-logging and mention
  scanning now happens in the extension via `chrome.scripting`, and the
  scraped `{post, comments}` payload is POSTed to the bridge.
- **No cloud layer**: all Cloudflare Worker / D1 sync, backup/restore, and the
  Pages dashboard are removed. The extension dashboard is the only UI.

Internal route paths are still `/recon/*` (invisible to the user; kept to
minimize divergence from the original).
