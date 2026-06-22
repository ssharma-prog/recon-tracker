---
name: reddit-tracker-install
version: 1.1.0
description: |
  Install the Reddit Tracker tool from a zip file. Use when the user wants to
  install, set up, or deploy Reddit Tracker (the standalone, multi-brand Reddit
  mention & AI-citation tracker) from a zip containing its extension/ and bridge/
  folders. Unzips it to the OS-appropriate location, installs deps, and starts +
  connects the bridge to Claude Code. Preserves existing per-brand data and
  backups on re-install. Works on macOS and Windows.
allowed-tools:
  - Bash
  - Read
---

# Reddit Tracker — Installer

Install Reddit Tracker from a zip onto this machine, place it at the canonical
OS location, install dependencies, and start the local bridge (which connects to
Claude Code via the `claude` CLI). Work through these steps IN ORDER. If a step
fails, stop and report the exact error — do not skip ahead.

## Canonical install location (do not deviate)

| OS      | Install folder                  | Data ends up at        |
|---------|---------------------------------|------------------------|
| macOS   | `~/reddit-tracker`              | `~/reddit-tracker/data`|
| Windows | `%USERPROFILE%\reddit-tracker`  | `…\reddit-tracker\data`|

The bridge writes `data/` (live per-brand data) and `backups/` (per-brand local
save backups) next to itself, so it MUST live in this user-writable home location
— never Program Files / Applications / AppData / Library. Both `data/` and
`backups/` must survive a re-install (code update).

## 1. Detect the OS

Run `uname -s`.
- `Darwin` → **macOS** path (use Mac/Linux commands throughout).
- `Linux` → treat as Mac/Linux (same commands), install folder `~/reddit-tracker`.
- Command fails / anything else → **Windows** (use the PowerShell commands).

Set `TARGET`:
- Mac/Linux: `$HOME/reddit-tracker`
- Windows: `$env:USERPROFILE\reddit-tracker`

## 2. Ask for the zip

Ask the user for the full path to the Reddit Tracker zip (e.g.
`~/Downloads/reddit-tracker.zip`). Wait for their answer. Verify the file exists
before continuing — if not, tell them and stop.

## 3. Check prerequisites

- `node --version` — if it fails, tell the user to install Node.js from
  nodejs.org and stop.
- `claude --version` — if it fails, tell the user to install Claude Code and log
  in (`claude` must be on PATH; the bridge uses it for Analyze + Log Comment),
  then stop.

## 4. Guard an existing install (protect their data)

Check whether `TARGET` already exists.
- If it does NOT exist: continue to step 5.
- If it DOES exist: it may contain real per-brand data in `TARGET/data` and
  backups in `TARGET/backups`. Do NOT overwrite blindly. Ask the user to choose:
  - **Update code, keep data** — replace `extension/` and `bridge/` only, leave
    `data/` and `backups/` untouched.
  - **Cancel** — stop and change nothing.
  Only proceed per their choice. Never delete or overwrite `TARGET/data` or
  `TARGET/backups`.

## 5. Extract to a temp dir and find the root

The zip may or may not have a top-level `reddit-tracker/` folder, so extract to a
temp dir first, then locate the folder that directly contains `bridge/server.js`.

Mac/Linux:
```bash
TMP=$(mktemp -d)
unzip -q "<zip path>" -d "$TMP"
# find the dir containing bridge/server.js
ROOT=$(dirname "$(dirname "$(find "$TMP" -type f -path '*/bridge/server.js' | head -1)")")
echo "ROOT=$ROOT"
```

Windows (PowerShell):
```powershell
$TMP = Join-Path $env:TEMP ("rt_" + [guid]::NewGuid().ToString("N"))
Expand-Archive -Path "<zip path>" -DestinationPath $TMP -Force
$server = Get-ChildItem -Path $TMP -Recurse -Filter server.js | Where-Object { $_.FullName -match '\\bridge\\server.js$' } | Select-Object -First 1
$ROOT = Split-Path (Split-Path $server.FullName)
$ROOT
```

If no `bridge/server.js` is found anywhere in the zip, the zip is wrong — report
that and stop.

## 6. Move into place

Create `TARGET` and move `extension/` and `bridge/` from `ROOT` into it. Leave any
existing `TARGET/data` and `TARGET/backups` alone — only the two code dirs are
replaced.

Mac/Linux:
```bash
mkdir -p "$TARGET"
rm -rf "$TARGET/extension" "$TARGET/bridge"   # only code dirs; never data/ or backups/
cp -R "$ROOT/extension" "$TARGET/extension"
cp -R "$ROOT/bridge"    "$TARGET/bridge"
[ -d "$ROOT/data" ] && [ ! -d "$TARGET/data" ] && cp -R "$ROOT/data" "$TARGET/data"
mkdir -p "$TARGET/data"
rm -rf "$TMP"
```

Windows (PowerShell):
```powershell
New-Item -ItemType Directory -Force -Path $TARGET | Out-Null
Remove-Item -Recurse -Force "$TARGET\extension","$TARGET\bridge" -ErrorAction SilentlyContinue  # never data\ or backups\
Copy-Item -Recurse "$ROOT\extension" "$TARGET\extension"
Copy-Item -Recurse "$ROOT\bridge"    "$TARGET\bridge"
if ((Test-Path "$ROOT\data") -and -not (Test-Path "$TARGET\data")) { Copy-Item -Recurse "$ROOT\data" "$TARGET\data" }
New-Item -ItemType Directory -Force -Path "$TARGET\data" | Out-Null
Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
```

## 7. Install dependencies

Run `npm install` inside `TARGET/bridge`.
- Mac/Linux: `npm install --prefix "$TARGET/bridge"`
- Windows: `npm install` with working dir `$TARGET\bridge` (e.g.
  `Push-Location "$TARGET\bridge"; npm install; Pop-Location`).

## 8. Start the bridge (connect to Claude Code)

First check if it's already running: `curl -s http://localhost:3458/ping`. If the
response contains `"ok":true`, it's already up — skip to step 9.

Otherwise start it detached:
- Mac/Linux:
  ```bash
  nohup node "$TARGET/bridge/server.js" > "$TARGET/bridge/bridge.log" 2>&1 &
  ```
- Windows (PowerShell):
  ```powershell
  Start-Process node -ArgumentList "$env:USERPROFILE\reddit-tracker\bridge\server.js" -WindowStyle Hidden -RedirectStandardOutput "$env:USERPROFILE\reddit-tracker\bridge\bridge.log" -RedirectStandardError "$env:USERPROFILE\reddit-tracker\bridge\bridge.err.log"
  ```

The bridge spawns the `claude` CLI on demand for Analyze + Log Comment, so it
uses the user's existing Claude Code login — no API key needed.

## 9. Confirm

Wait 3 seconds, then run `curl -s http://localhost:3458/ping`.
- If the response contains `"ok":true`: success. Report the `dataDir` from the
  ping response and continue to step 10.
- If not: show the last 20 lines of `TARGET/bridge/bridge.log` and report the
  error. Stop.

## 10. Tell the user how to load the extension

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
To start the bridge again later:  run this skill, or `npm start` in <TARGET>/bridge
```

Do not move the folder after loading the extension — Chrome pins the path and
moving it breaks the extension until you re-load it.
