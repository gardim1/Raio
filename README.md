# Raio

**Experimental Windows alpha · Claude Code**

**See where your AI coding agent worked.** Raio is a small Windows companion that follows a Claude Code session in
your project and shows it as a calm, animated map: which areas the agent read and changed, factual notices, what Raio
could actually observe about the checks it ran, and a short replay when it finishes. Everything stays on your
computer: no account, no cloud service, no telemetry, no model API of its own.

**Download:** [Raio 0.1.0-alpha.1 pre-release](https://github.com/gardim1/Raio/releases/tag/v0.1.0-alpha.1) ·
[installer `install-raio.ps1`](https://github.com/gardim1/Raio/releases/download/v0.1.0-alpha.1/install-raio.ps1) ·
[portable zip](https://github.com/gardim1/Raio/releases/download/v0.1.0-alpha.1/raio-v0.1.0-alpha.1-windows-x64.zip)
(unsigned; Windows may warn)

![Raio's expanded view after a Claude Code session in a synthetic demo project: the areas the agent touched, a
migration file flagged for review, build and test results it observed, and the session timeline](docs/images/raio-expanded.png)

*Current build with a synthetic demo project, rendered in the development preview (the Windows app shows its — □ ×
window controls where this preview draws three dots).*

> **Experimental alpha.** Windows 10/11 x64 only, unsigned, not stable. Raio observes **Claude Code** sessions only
> (Codex or other agents can install and open Raio, but their sessions are not observed). The optional Claude plan
> usage display depends on Claude Code's status line and can be unavailable or out of date. The "fixed check"
> celebration exists only in the developer preview. macOS and Linux are not validated.

## Install (Windows)

Requirements: Windows 10/11 x64 and the Microsoft WebView2 runtime (present on current Windows); Claude Code for
monitoring. Per user, no administrator rights:

1. Download [`install-raio.ps1`](https://github.com/gardim1/Raio/releases/download/v0.1.0-alpha.1/install-raio.ps1)
   and read it.
2. In PowerShell, from the folder where you saved it:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-raio.ps1 -Version 0.1.0-alpha.1 -Project "C:\path\to\project"
   ```

   It downloads the zip and `SHA256SUMS-v0.1.0-alpha.1.txt` from the release, checks the zip's SHA256 before
   extracting (integrity against that manifest, not a signature), installs to `%LOCALAPPDATA%\Programs\Raio` and opens
   Raio's Connect preview for that folder. Without `-Project` it only installs.

Portable alternative: extract the zip anywhere and run `raio.exe` (keep `raio-hook.exe` next to it).

**Ask your local coding agent to do it** (Claude Code or Codex running on your own Windows machine, not in the cloud):

> Install Raio from https://github.com/gardim1/Raio following its INSTALL_FOR_AGENTS.md and open it on this folder.
> Show me which hooks it will add before anything is connected.

### Build from source (contributors)

Node 20.19+, Rust stable with MSVC, WebView2 runtime:

```powershell
git clone https://github.com/gardim1/Raio.git
cd Raio
npm ci
npm run app:build          # src-tauri\target\release\raio.exe and raio-hook.exe
npm run app                # opens the release build
```

## What it shows

- **Island**: a small capsule just below the top of the screen with what the agent is doing. Hovering it opens a
  compact preview (also when nothing is running) with the latest observed activity and buttons to open the Mini
  Player or the full window. It never takes focus, and clicks outside the capsule reach the window underneath.
- **Mini Player**: a floating window with Raio's character and the session so far.
- **Expanded view**: the project map, the session timeline and an inspector for each area.
- **Raio's character**: reacts to what was actually observed (working, worth a look, observed failure, turn ended)
  and to you: it looks toward the pointer, reacts when clicked, and accepts a cookie (**Give Raio a cookie** in the
  Expanded title bar and the Island preview). The cookie is just a gesture: no score, balance or reward, and it never
  changes what Raio reports. "Turn ended" is not "tests passed". It rests quietly when nothing happens.
- **Replay**: about ten seconds that retell the session in order (short sessions replay in less).
- **Map before any session**: when you choose a folder, Raio groups it into areas from folder names and known manifest
  names (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, compose files, Prisma schema). It never reads `.env`
  values or runs your code. Areas and technology hints are heuristics and say so; relationships between areas are
  static TypeScript/JavaScript imports only, other languages show "relationships unknown".

Colour always comes with a label: neutral when connected and quiet, blue while the agent works, amber for something
worth a look (a migration file added, a dependency manifest changed), red for an observed failure, and its own
"unknown" / "not connected" state when Raio has no data. "No checks observed" means Raio saw none, not that none ran.

## First use

1. Open Raio on a folder: `raio.exe --project "C:\path\to\project"` (a running Raio comes forward on that folder), or
   **Choose a folder** in the app.
2. Raio shows the folder's map and the exact change it would make to `<project>\.claude\settings.local.json`: six
   asynchronous hooks (`SessionStart`, `SessionEnd`, `Stop`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`) that run
   `raio-hook.exe`. Existing settings and hooks are kept and the original file is backed up. **Nothing is written until
   you click Connect.** Raio warns you if git does not ignore that settings file.
3. Installing and connecting is not yet following: Raio says **"Integration configured · waiting for the first Claude
   event"** until Claude Code actually runs one of the hooks. Use Claude Code in that folder: a session that is
   already open there picks the hooks up by itself (verified on Claude Code 2.1.295 once the folder is trusted), and
   a new session works too; the first tool call, edit or turn end shows up in Raio within a second or two. If nothing
   arrives, Raio names the problem (hooks out of date, helper missing, Raio not running for 7 days) and the next step.
   Raio follows the session live and keeps a local history; **View changes** plays the replay. Closing Raio's windows keeps it in the tray
   (the taskbar entry goes away; **Quit Raio** in the tray menu exits); it keeps recording while hidden and shows the
   current state when you open it again.

## Claude plan usage (optional)

Raio can show how much of your Claude plan's **5-hour** and **weekly** limits is used: two rings in the Expanded title
bar and the Island preview (inner ring = 5-hour limit, outer ring = weekly limit; the fill is the share **used**).
Hover, focus or click them for the percentages, reset times and how old the reading is.

- **Source**: the `rate_limits` data that Claude Code itself passes to a
  [status line command](https://code.claude.com/docs/en/statusline). Raio never reads your Claude credentials, never
  logs in, never calls a usage API and never sends a prompt to get a number.
- **How to enable**: in the Connect preview, tick **Show Claude plan usage**. Raio then adds a `statusLine` entry to
  that project's `.claude/settings.local.json` (shown in the diff before anything is written). It runs `raio-hook.exe
  statusline`, which keeps only the two limits, their reset times and the session id, and prints nothing. Side effect:
  Claude Code shows a custom status line in that project, which hides some footer hints such as "esc to interrupt".
- **If you already have a status line** (in your user, project or managed settings), Raio leaves it alone by default:
  Claude Code uses only one status line, so adding Raio's would hide yours in that project. You can explicitly choose
  to replace it **in that project only**. Raio never edits `~/.claude/settings.json`. A status line passed with
  `claude --settings` cannot be detected.
- **What the numbers mean**: a reading is what the latest Claude Code response in a connected project reported. It is
  not live: with Claude Code closed nothing refreshes it, so Raio shows its age, mutes old readings and shows "Usage
  unavailable" (never 0%) when a limit is missing or its reset time has passed. Several sessions may report the same
  account; Raio shows the most recent reading and never adds percentages together. It is your plan's usage, not this
  project's, and not context, tokens or cost.
- **Compatibility**: Claude Code documents these fields for Pro and Max plans, after the first response of a session.
  Verified on Claude Code 2.1.294 with a Team plan; other plans and versions are not verified.
- **Turn it off**: reconnect without the option, or Disconnect. Raio removes only its own `statusLine` entry; if you
  changed that entry yourself, Raio keeps your version.

## What Raio records

Minimised events only: event type, time, project-relative paths, tool name, a command class (test, build, migration,
install, other) and the program name, and exit codes when the hook reports them. **Not recorded**: prompts, file
contents, tool output, transcripts or full command lines. Data lives in `%APPDATA%\io.github.gardim1.raio` (SQLite),
kept 30 days by default. The hook is asynchronous, always exits 0, and goes inert if Raio has not run for 7 days.
With the optional plan usage enabled, Raio also keeps, per Claude Code session, only the two limits' used percentages,
their reset times, the session id, the Claude Code version and when the reading arrived (at most 30 days); nothing
else from the status line input is stored or logged.

## Disconnect and remove

- **Disconnect a project**: select it in Raio and click **Disconnect**. Only Raio's own hook entries are removed; your
  settings stay (the JSON may be re-serialised).
- **Remove Raio**: disconnect your projects, quit from the tray icon, then delete Raio's folder and, if you also want to
  delete its history, `%APPDATA%\io.github.gardim1.raio`. The installer (with the release) adds `-Uninstall`, which
  refuses while projects are still connected, and `-RemoveData`.

## Known limitations (alpha)

- Windows only, tested on one Windows 11 machine. For this build the native checks with a real mouse (Island hover
  and click-through, tray, close-to-tray and restore, window borders), other display scalings, multiple monitors or a
  top taskbar were not exercised; automated browser and Rust tests pass.
- Follows Claude Code only. Edits are shown as "reported and consistent on disk", never as proven authorship; changes
  you make at the same time may be mixed in and are marked "author unknown".
- A command's result is trusted only for a single simple command; pipes, chains and background commands show
  "result unknown" with the reason. A failing command that is not recognised as a test or build shows as "Command
  failed" while the check summary can still say "No checks observed".
- Area grouping, technology hints and notices (e.g. "migration file added") are path-name heuristics; a migration
  file added is not a migration that ran.
- Plan usage (optional) is verified once on Claude Code 2.1.294 with a Team plan; it is as fresh as the last Claude
  Code response and may be unavailable. The "fixed check" celebration is developer-preview only.
- Resource use is measured, not guaranteed: on an earlier build idle CPU was about 1.2–2.2% of one core and the app
  plus its WebView2 processes used about 375–400 MB working set (90–107 MB private), above the project's own target of
  under 1% and 150 MB. Details in [`docs/STATUS.md`](docs/STATUS.md).
- Unsigned build, no auto-update, no installer UI.

Found a bug? Please open an issue with the bug template (no secrets, private code or transcripts).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, tests and packaging. Architecture:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). What is implemented and verified: [`docs/STATUS.md`](docs/STATUS.md).
Claude Code hook contract as observed: [`docs/integrations/claude-code-hooks.md`](docs/integrations/claude-code-hooks.md).

## License

MIT, see [`LICENSE`](LICENSE). Raio is free to use. Third-party components keep their own licenses; the Windows package
includes `THIRD-PARTY-NOTICES.txt` (generated by `scripts/third-party-notices.mjs`). The bundled Inter font is under
the SIL Open Font License 1.1. Claude Code and other agents have their own terms and requirements.
