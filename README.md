# Reddit Tracker

A standalone, multi-brand tracker for Reddit mentions and Google AI Overview
citations. Chrome extension + local Node bridge. **No cloud** — all data is local
JSON. Runs identically on macOS and Windows.

For each brand you add, it finds where the brand is mentioned on Reddit, judges
whether each mention is genuinely about the brand, summarizes sentiment and
intent, flags AI-written mentions, and checks whether Google AI Overviews mention
or cite the brand.

## Layout

```
reddit-tracker/
├── extension/      Chrome extension (load unpacked)
├── bridge/         Node/Express bridge (port 3458)
│   ├── server.js
│   ├── claude-runner.js   spawns the `claude` CLI (uses existing login, no API key)
│   └── package.json
├── data/           Local JSON state, one folder per brand (auto-created)
└── backups/        Per-brand local backups (auto-created)
```

## Install

The easiest path is the `reddit-tracker-install` skill in Claude Code: it clones
this repo to `~/reddit-tracker`, installs dependencies, and starts the bridge.
Re-running it updates the code via `git pull` while keeping your data and backups.

## Run (manual)

1. **Bridge** (needs Node + the `claude` CLI on PATH):
   ```
   cd bridge
   npm install      # first time only
   npm start        # → http://localhost:3458
   ```
2. **Extension**: open `chrome://extensions`, enable Developer mode,
   "Load unpacked" → select `reddit-tracker/extension`. Click the toolbar icon
   to open the dashboard.

## First run

No brand is pre-loaded. The dashboard opens with the **Add brand** form. Enter the
brand name, URL, products, your marketing Reddit account (excluded from mentions),
and a short description. The description is the important part: it builds the
relevancy checker that tells real mentions apart from same-named false positives.
Add more brands any time from the dropdown.

