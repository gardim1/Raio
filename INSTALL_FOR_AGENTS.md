# Installing Raio — instructions for a local coding agent

Read this when a user asks something like "install Raio from this repository and open it in this folder". It works
for an agent running **on the user's own Windows computer** (for example Claude Code or Codex in a local terminal).
An agent running in a cloud container cannot install Raio for the user: downloading the files there does not put
anything on the user's machine.

## What Raio is (so you can explain it)

Raio is a local desktop app for Windows that shows where a Claude Code session worked in a project: a map of the
project's areas, factual notices, the result of checks it could observe, and a short replay of the session. It runs
entirely on the user's computer. No account, no cloud service, no telemetry, no model API of its own.

- It observes **Claude Code** sessions. It does **not** observe Codex sessions yet. Codex can install and open Raio
  using these steps, but Raio will not show what Codex does.
- Windows 10/11 x64 only for now. macOS and Linux have not been tested.
- This is an **alpha**: unsigned, may have bugs. See "Limitations" in `README.md`.

## Requirements

- Windows x64 with the Microsoft Edge WebView2 Runtime (present on most Windows 10/11 machines). The installer checks
  for it and, if missing, points to Microsoft's download page; it never installs it silently.
- PowerShell 5.1 or later (built into Windows). No Node, Rust or Git is needed to use Raio.
- No administrator rights. Nothing is added to PATH, the registry or Windows startup.

## Steps

1. Ask the user for the folder they want to open (or use the current working folder **only if the user said so**).
   Do not look through their disk, shell history, windows or other repositories to guess a project.
2. Find the release to install. Open `https://github.com/gardim1/Raio/releases` (or `gh release list -R gardim1/Raio`)
   and use an explicit version tag such as `v0.1.0-alpha.1`; do not rely on "latest" (alphas are pre-releases).
   **If no release is listed yet**, stop and tell the user; offer to build from source instead (needs Node 20.19+,
   Rust stable with MSVC and Git): `git clone https://github.com/gardim1/Raio.git`, `npm ci`, `npm run app:build`, then
   `src-tauri	argeteleaseaio.exe --project "<folder>"`.
3. Download the installer script of that release and show it to the user before running it:

   ```powershell
   $v = '0.1.0-alpha.1'   # the release tag without the leading v
   $dir = Join-Path $env:TEMP "raio-install-$v"
   New-Item -ItemType Directory -Force $dir | Out-Null
   Invoke-WebRequest "https://github.com/gardim1/Raio/releases/download/v$v/install-raio.ps1" -OutFile "$dir\install-raio.ps1"
   Get-Content "$dir\install-raio.ps1"   # let the user read it
   ```

   Only use `https://github.com/gardim1/Raio/releases/download/`. Do not pipe remote text into `Invoke-Expression`.
4. Run it for this process only (it never changes the machine's execution policy):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install-raio.ps1" -Version $v -Project "C:\path	o\project"
   ```

   The script downloads the release zip and its SHA256 manifest from the same release, checks the hash before
   extracting, installs to `%LOCALAPPDATA%\Programs\Raiopp\` and opens Raio on that folder. It stops if Raio is
   running ("Quit Raio from the tray icon, then run again"). The SHA256 check proves the zip matches the manifest
   published next to it; it is not a code signature. The build is unsigned, so Windows SmartScreen may warn. Do not
   tell the user to disable SmartScreen or antivirus.
5. Raio opens on the folder and shows, before writing anything:
   - the project map it could read (folder names, known manifest names; it never reads `.env` values or runs the
     project's code);
   - the exact change it would make to `<project>\.claude\settings.local.json`: six asynchronous command hooks
     (`SessionStart`, `SessionEnd`, `Stop`, and `PreToolUse` / `PostToolUse` / `PostToolUseFailure` for file-edit,
     Bash, PowerShell and read/search tools) that run `raio-hook.exe` and are marked as Raio's. Existing settings and
     hooks are kept, and the original file is backed up.
   Tell the user that **nothing is written until they click Connect** in Raio, and that the hooks apply to **new**
   Claude Code sessions started in that folder after connecting.
   The preview also offers an optional **Show Claude plan usage** (off by default). It adds a project-local
   `statusLine` entry; if the user already has a status line, Raio keeps it unless the user explicitly chooses to
   replace it in that project only. Leave this choice to the user; do not tick it for them, and never edit
   `~/.claude/settings.json`.
6. Tell the user to start a new Claude Code session in that folder. Raio shows it live (Island, Mini Player or the
   full window) and keeps a local history with a short replay.

Do not edit `settings.local.json` yourself and do not connect projects the user did not ask for.

## Already installed

- Open another folder: `& "$env:LOCALAPPDATA\Programs\Raio\app\raio.exe" --project "C:\path\to\project"`. If Raio is
  already running, the running app comes forward on that folder (no second copy).
- Update: run the installer again with the new `-Version`. Quit Raio from its tray icon first; the script stops if
  Raio is running. The install path stays the same, so connected projects keep working.

## Removing

Three separate things:

1. **Integration** (per project): in Raio, select the project and click **Disconnect**. Only Raio's own hook entries
   are removed; everything else in the settings file stays.
2. **Program**: quit Raio from the tray icon, then run the installer with `-Uninstall`. It refuses while projects are
   still connected (their hooks would point at a missing program) and lists them.
3. **History**: add `-RemoveData` to also delete Raio's local history in `%APPDATA%\io.github.gardim1.raio`.

## Status of this document

Written for the first Windows alpha. If the release you are told to install does not exist at the URL above, say so;
do not substitute another source. The same script can install from a local folder that holds the release zip and its
`SHA256SUMS-v<version>.txt`, with `-Source <folder>`.
