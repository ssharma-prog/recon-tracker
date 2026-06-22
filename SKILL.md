---
name: reddit-tracker-install
version: 2.0.0
description: |
  Install or update the Reddit Tracker tool from GitHub. Use when the user wants
  to install, set up, update, or deploy Reddit Tracker (the standalone, multi-brand
  Reddit mention & AI-citation tracker). Clones github.com/ssharma-prog/recon-tracker
  to the OS-appropriate folder (or git-pulls to update), installs deps, and starts
  the local bridge. Preserves existing per-brand data and backups. macOS + Windows.
allowed-tools:
  - Bash
  - Read
---

# Reddit Tracker — Installer

Install (or update) Reddit Tracker on this machine from GitHub, install
dependencies, and start the local bridge (which connects to Claude Code via the
`claude` CLI). Work through these steps IN ORDER. If a step fails, stop and
report the exact error — do not skip ahead.

Source repo: `https://github.com/ssharma-prog/recon-tracker.git` (public).
The repo IS the install folder. `data/` and `backups/` are gitignored, so a
`git pull` updates the code and never touches the user's brands or backups.

## Canonical install location (do not deviate)

| OS      | Install folder                  | Data ends up at        |
|---------|---------------------------------|------------------------|
| macOS   | `~/reddit-tracker`              | `~/reddit-tracker/data`|
| Windows | `%USERPROFILE%\reddit-tracker`  | `…\reddit-tracker\data`|

The bridge writes `data/` (live per-brand data) and `backups/` next to itself, so
it MUST live in this user-writable home location — never Program Files /
Applications / AppData / Library.

## 1. Detect the OS and set paths

Run `uname -s`.
- `Darwin` or `Linux` → Mac/Linux commands; `TARGET="$HOME/reddit-tracker"`.
- Command fails / anything else → Windows (PowerShell); `$TARGET="$env:USERPROFILE\reddit-tracker"`.

## 2. Check prerequisites

- `git --version` — if it fails, tell the user to install Git and stop.
- `node --version` — if it fails, tell the user to install Node.js from nodejs.org and stop.
- `claude --version` — if it fails, tell the user to install Claude Code and sign in
  (`claude` must be on PATH; the bridge uses it for Analyze, Log Comment, and the
  AI-writing checks), then stop.

## 3. Clone (fresh) or pull (update)

Decide based on what is already at `TARGET`:

**A. `TARGET` does not exist → fresh clone.**
```bash
git clone https://github.com/ssharma-prog/recon-tracker.git "$TARGET"
```
```powershell
git clone https://github.com/ssharma-prog/recon-tracker.git $TARGET
```

**B. `TARGET` exists AND is a git repo (`TARGET/.git` present) → update in place.**
This preserves data/ and backups/ automatically (they are gitignored).
```bash
git -C "$TARGET" pull --ff-only
```
```powershell
git -C $TARGET pull --ff-only
```

**C. `TARGET` exists but is NOT a git repo (older zip install with real data) →
update code without losing data.** Clone to a temp dir, copy the code folders in,
leave `data/` and `backups/` untouched.
```bash
TMP=$(mktemp -d)
git clone --depth 1 https://github.com/ssharma-prog/recon-tracker.git "$TMP/rt"
rm -rf "$TARGET/extension" "$TARGET/bridge"   # code dirs only — never data/ or backups/
cp -R "$TMP/rt/extension" "$TARGET/extension"
cp -R "$TMP/rt/bridge"    "$TARGET/bridge"
rm -rf "$TMP"
```
```powershell
$TMP = Join-Path $env:TEMP ("rt_" + [guid]::NewGuid().ToString("N"))
git clone --depth 1 https://github.com/ssharma-prog/recon-tracker.git "$TMP\rt"
Remove-Item -Recurse -Force "$TARGET\extension","$TARGET\bridge" -ErrorAction SilentlyContinue  # never data\ or backups\
Copy-Item -Recurse "$TMP\rt\extension" "$TARGET\extension"
Copy-Item -Recurse "$TMP\rt\bridge"    "$TARGET\bridge"
Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
```

## 4. Install dependencies

- Mac/Linux: `npm install --prefix "$TARGET/bridge"`
- Windows: `Push-Location "$TARGET\bridge"; npm install; Pop-Location`

## 5. Start the bridge

First check if it's already running: `curl -s http://localhost:3458/ping`. If the
response contains `"ok":true`, it's already up — skip to step 6.

Otherwise start it detached:
- Mac/Linux:
  ```bash
  nohup node "$TARGET/bridge/server.js" > "$TARGET/bridge/bridge.log" 2>&1 &
  ```
- Windows (PowerShell):
  ```powershell
  Start-Process node -ArgumentList "$env:USERPROFILE\reddit-tracker\bridge\server.js" -WindowStyle Hidden -RedirectStandardOutput "$env:USERPROFILE\reddit-tracker\bridge\bridge.log" -RedirectStandardError "$env:USERPROFILE\reddit-tracker\bridge\bridge.err.log"
  ```

The bridge spawns the `claude` CLI on demand, so it uses the user's existing
Claude Code login — no API key needed.

## 6. Confirm

Wait 3 seconds, then run `curl -s http://localhost:3458/ping`.
- Response contains `"ok":true` → success. Note `claude` in the response: if
  `"claude":false`, warn that Analyze / Log Comment / AI-writing checks need the
  `claude` CLI on PATH. Continue to step 7.
- Otherwise → show the last 20 lines of `TARGET/bridge/bridge.log` and stop.

## 7. Tell the user how to load the extension

Print, with the real absolute `TARGET` path filled in:

```
Reddit Tracker is installed and the bridge is running on http://localhost:3458.

Load the extension (one time):
  1. Open chrome://extensions
  2. Turn on "Developer mode" (top-right)
  3. Click "Load unpacked"
  4. Select:  <TARGET>/extension
  5. Click the Reddit Tracker toolbar icon to open the dashboard.

First run: no brand is pre-loaded. The dashboard opens with the "Add brand" form
— enter the brand's name, URL, products, marketing Reddit account, and a short
description, and it builds that brand's relevancy checker. Add more brands any
time from the dropdown at the top.

Your data lives at:    <TARGET>/data       (one folder per brand)
Local backups live at: <TARGET>/backups    (auto-saved after scans/analysis;
                                             also Download/Import Backup buttons)
To update later:       run this skill again (git pull, your data is kept).
To start the bridge:   run this skill, or `npm start` in <TARGET>/bridge
```

Do not move the folder after loading the extension — Chrome pins the path and
moving it breaks the extension until you re-load it. Chrome cannot load the
extension automatically; the "Load unpacked" step is manual by Chrome's design.
