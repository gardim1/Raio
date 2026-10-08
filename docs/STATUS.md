# Raio status

Last updated: 2026-10-08 (sidebar, Island, approved character). Earlier sections keep their own dates.

## Sidebar, Island and the approved character (2026-10-08)

Windows 11 (10.0.26200), browser checks in Edge (Playwright); the native desktop checks listed under "Not exercised"
were not run for this round. Nothing run on macOS or Linux.

- **Sidebar without activity**: project name once (ellipsis + full name on hover), one factual indicator
  ("Connected · no activity yet", "Hooks out of date", ...), one short message and one action. Distinct states for
  mapping, empty folder ("No code to map yet" + "Choose another folder", preview first), files with no recognised areas,
  partial/stale listing, listing unavailable (the core's reason, with paths replaced by `[folder]`; "access denied"
  only when the error says so), and connected without a session ("Waiting for activity" + start a new Claude Code
  session). Heuristic notes and technology hints sit under a collapsed **About this map**; warnings stay visible.
- **Island**: placed on the primary display's work area (taskbar respected), 10 logical px below its top. Hovering the
  collapsed capsule opens its own 340x124 preview in every state (also with no session or no project); it stays open
  while the pointer or keyboard focus is inside and closes 260 ms after the pointer leaves; Esc closes. Natively the
  hover truth is the core's cursor poll (`island-pointer`), not DOM events of a click-through window. Clicking the
  character only makes it react; **Open Mini Player** and **Open window** are the only surface switches. The
  preview shows the latest observed fact with its time and source; a Claude Code `Stop` reads "Turn ended", never a
  check result. The capsule is a disclosure button with a separately named preview.
- **Approved character** (local design reference, not published): a TypeScript port of the approved design's engine
  (springs, eyes, sparks, gaze, click, dizzy after four clicks, cookie, turn ended, celebration) replaces the old orb in
  the Island, Mini, title bar and map. One loop per window runs only while something moves and stops when the surface
  is hidden; rest is quiet (the old idle float is gone); reduced motion follows the design. Mood comes from existing
  presence: failure > attention > working > idle. "Turn ended" reacts once, live, after the window opened, never in a
  replay. The **celebration for a fixed check is not triggered live**: events carry only the command class, program and
  exit code, which cannot prove that the same check failed and then passed; it exists only in the dev harness.
  **Give Raio a cookie** in the Island preview is a free manual gesture (no balance, reward or counter).
- **Windows**: Expanded's X (and Alt+F4) now hides the window to the tray (taskbar entry removed); the tray's Open Raio,
  a second launch or `--project` bring it back as it was; — still minimises; only **Quit Raio** exits. The character in
  the title bar is not a drag or maximise handle. The native Expanded no longer draws a CSS 1 px outline next to the
  Windows border (two adjacent lines were observed; the Windows border itself follows the user's accent setting).
- Known deviations from the approved design: product copy in English; the Island's failure dot uses the app's danger
  token (#ff8f86) instead of the design's #ff7b72; after a reaction the character returns to its functional pose
  (attention/failure gaze) where the reference briefly lost it.

Tests on `8dac01e`: vitest 1067 (80 files), tsc + build + bundle check 0, cargo 234 unit + 13 integration (+3 ignored),
clippy 0 with 2 existing warnings, Playwright 63 passed / 21 screenshot differences (the new sidebar, Island and
character; goldens not re-blessed, awaiting the owner's visual approval). Independent reviews found 3 P2 issues in the
sidebar/Island work (fixed) and none above P3 in the character work.

Not exercised: native hover/click-through/focus with a real mouse, X-to-tray and every restore path on the desktop,
work-area placement with a top taskbar, DPI other than this machine's, multiple monitors, screen readers, and CPU/memory
of the new release (the previous measurement is in the alpha section below).

## Alpha preparation (2026-10-07): open on a folder, presence states, installer

Windows 11 (10.0.26200), 96 dpi, one 1920x1080 monitor, 16 logical cores, WebView2 154, Claude Code 2.1.292 (headless,
subscription). Nothing run on macOS, Linux or a second machine.

- **Open on a folder**: `raio.exe --project "<path>"`; a running Raio comes forward on that folder (no second process);
  an unconnected folder opens the Connect preview. Nothing is connected without the click.
- **Map before connecting**: the Connect preview shows the folder's map (same read-only listing as a connected project).
- **Presence states** on existing tokens with a label for each: neutral (connected, quiet), blue (recent activity),
  amber (migration file added, dependency manifest changed, events possibly lost, hooks outdated), red (observed
  failure; an older failure or one followed by changes is shown as history), neutral + own symbol for unknown /
  disconnected. While activity is recent the Island and Mini keep showing what the agent is doing; colour and
  accessible label carry the state.
- **Hidden means hidden**: rendering subscriptions, clocks and CSS animation pause while a surface is not visible;
  ingestion continues; showing a surface reconciles to the current state.
- **Replay with new activity**: "New activity" + "Back to live"; a finished replay returns to live by itself.
- **Map heuristics**: Python/FastAPI + Next layouts (integrations, persistence/Alembic, templates, tests);
  "Authentication (detected from file names)" only with path evidence; image/binary folders do not take an area slot;
  Alembic revision files count as "migration file added" (a file, not a migration that ran).
- **Installer** `scripts/install-raio.ps1`: per-user (`%LOCALAPPDATA%\Programs\Raiopp`, stable for hooks), SHA256 of
  the zip checked against the release manifest before extraction (integrity, not a signature), refuses while Raio runs,
  WebView2 check, `-Uninstall` refuses while projects are connected (Raio keeps `connections.json` plus a pending marker
  during changes), `-RemoveData` separate. Package: `npm run app:pack` -> `release-local/v<version>/` with LICENSE and
  generated THIRD-PARTY-NOTICES (fails if any component lacks license text).

Native QA on the packaged release of `e40ea6d` (installed outside the checkout in a path with spaces and accents,
isolated data, synthetic project): install, update, refuse-while-running, tampered manifest rejected; `--project` +
Connect wrote only the 6 managed hooks; real sessions: neutral -> blue -> red for a failing command, amber for a
`migrations/` file; Mini kept its position at the first session; replay 4.6-7.5 s; "New activity"/"Back to live";
all surfaces hidden during a session then restored to the current state in 0.6 s; history and replay after a forced
stop and relaunch; Disconnect left exactly the user's content; uninstall refused while connected; `-RemoveData`
removed only the data folder. Found and fixed afterwards: the Connect preview's title bar ignored real mouse input,
Alembic revisions raised no notice, the Island's visible text stayed "starting" (re-checked on the final package, see
below). Not exercised: tray "Open Raio"/"Quit" (owner manual check), interrupted download, missing WebView2, DPI,
multi-monitor, another machine. A planned check against a private real project was not run.

Idle cost on that release (n=2, app + 6 WebView2 processes, 60 s windows, % of one core): Expanded 1.23/1.64, Island
2.20/1.75, Mini 1.66/1.59, all hidden 1.19/1.30, active session 1.34/1.53; working set 374-400 MB, private 90-107 MB.
**Above the project's own target (< 1% of a core, 150 MB).** Replay playing measured 52-82% of one core in ~12 s windows
that include a UI Automation call (overstates a pure replay). Hook runtime per event: median 24-28 ms, p95 32-35 ms.

## Round 4 (2026-10-07): audit fixes, PowerShell checks, one title bar, local package

Windows 11, 96 dpi single monitor during native QA (earlier rounds used 175% and two monitors). Nothing run on macOS or Linux. Work came from the independent Round 3 audit (findings F1-F6) and the open items above; every change was implemented in its own worktree, reviewed by a second agent, then integrated.

- **Checks run through Claude Code's PowerShell tool now reach Raio** (F6). Real sanitized payloads from Claude Code 2.1.292 (`src-tauri/tests/fixtures/claude-code-2.1.292-powershell/`) show PowerShell failures arrive like Bash ones ("Exit code N"), so a single command's result is trusted the same way. Projects connected before this need a reconnect; Raio now says when a connection's hooks are out of date (`project_hooks_state`, read-only) and offers the usual preview + Connect.
- **No more false green from shell syntax** (F4). A command's exit status is trusted only when the whole command is one simple command (allow-list: plain words, quoted strings without expansions, a short list of redirections, PowerShell `& "exe"`). Background `&`, compounds, pipes, comments, substitutions, non-ASCII text and quoted PowerShell literals stay "result unknown", now with the reason shown ("combined with other commands", "ran in the background", "interrupted", "tool result can't confirm it"). This is a closed lexical grammar, not a shell parser.
- **"No checks observed"** replaces "No checks ran" (absence of telemetry is not proof).
- **Resumed sessions are live again** (F2): every start/end occurrence is kept; the latest boundary decides open/ended.
- **Map before the first session** (F1): a connected project shows its whole map with "No session yet"; nothing about a session is invented.
- **Bounded drop accounting while Raio is closed** (F3): fixed per-reason counters (at most 14 small files) plus an "at least" flag when a count could not be updated; the UI says "At least N" or "Some events may not have been recorded". Readers do not lock counters; the flag survives clock changes and expires with the counters.
- **Hook ownership** (F5): only Raio's exact hook command is treated as Raio's; a user hook containing `--raio-managed` is kept.
- **One title bar on Windows**: Expanded is undecorated; the design's three dots are close (still minimizes), minimize and maximize; the title bar drags and double-click maximizes; edges resize.
- **Island idle cost**: geometry is cached and invalidated by window events, click-through is re-applied after the Island window is recreated, and the cursor poll slows from 33 ms to 80 ms far from the capsule.
- **Flaky Rust test fixed at the cause** (it used the production 2 s scan budget).
- **Local portable package**: `npm run app:build` then `npm run app:pack` -> `release-local/raio-<sha>-windows-x64/` (+ zip) with commit and SHA256 in its README. Unsigned, not an installer, nothing published.

A finished replay now returns to live when new activity arrives (a playing replay is not interrupted). Native QA (release `8d60649`, hash-checked, isolated data/WebView2, throwaway project, real headless Claude Code 2.1.292): PASS for the live title bar (drag, double-click, dots, Alt+F4, edge resize), second-instance restore (x4, 201-419 ms), Island click-through (20/20 hovers, ~72 ms, focus kept), connect preview with PowerShell matchers, pre-session map, live checks passed/failed/"combined with other commands", resume stays live, forced-stop relaunch keeps timeline and replay, disconnect keeps the user's hook. FAIL found and fixed afterwards: the pre-session Expanded had no window controls (fixed in `8597c48`; re-checked natively on that release: drag, double-click, dots, Alt+F4 and "1 system mapped" pass). Not run: tray "Open Raio"/"Quit" (icon sits in the hidden-icons flyout), Island restore from a minimized Expanded. Disconnect restores settings semantically, not byte-identically (re-serialised JSON; the first backup is byte-identical).

Idle CPU, A/B in one sitting (same data, 45 s settle + 60 s window, app + WebView2 tree, 16 logical cores, ~13% background load, n=2 single samples each, % of one core): Expanded 1.52 -> 1.14, Island 3.60 -> 1.81, Mini 1.08 -> 1.25 (within noise). Memory unchanged (~370-425 MB working set, 88-131 MB private). Not a guarantee or a worst case.

Tests on the final commit: `8597c48`: vitest 727 (38 files), tsc + build + bundle check 0, cargo 218 unit + 13 integration (+3 ignored), clippy 0 with 2 existing warnings, Playwright 39/39 in two runs. On the preceding branch commit one full Playwright run failed `film 04-auth-to-api-traversal` by 2% of pixels and passed on every rerun (3/3 isolated, 2/2 full); not re-blessed, cause unknown (the film route does not mount the changed App code). Release `raio.exe` SHA256 `8A7BC4F9…14C7099`, `raio-hook.exe` `87F0B611…F26D6AF`; portable package `release-local/raio-8597c48e5866-windows-x64(.zip)` (ignored, local).

Open: events that arrive while a replay is still playing leave the view on "Replay complete" until the next event or "Close replay"; tray menu clicks and graceful Quit (owner manual check), replay of short sessions lasts ~6 s rather than ~10 s, Mini position resets when the first session starts, cross-surface morph (still deferred), installer/signing, other DPI/multi-monitor this round, macOS/Linux never run.

## Round 3 (2026-10-02): real interactive session, import edges, whole-project map

Windows 11, release builds of the commits below. Display during these checks: 175% scaling, two monitors. Nothing run on macOS or Linux.

- **Real interactive Claude Code session, verified end to end** (release `7fd6950`, throwaway `.local/e2e-project` connected by the owner): the session read Auth, added `src/api/profile.ts` (imports `../auth/session`), a migration, a test, and edited `health.ts`. Window captures show the orb following events while they happened (12 s of movement), then a static frame (no idle frames). Final map: API (2 files), DB with "Migration file added", Tests, Auth dimmed (read only); timeline 00:00-01:16; edits "reported, consistent on disk". After an app restart the window content was **0 px different** (excluding the OS title bar, whose colour follows focus), and the replay's end frame was 0 px different before/after another restart. "Tests result unknown" is correct: the command was `node --test ... | tail`, so the exit code was tail's. Evidence: `.local/e2e-live/` (local).
- **Import edges** (`4cd5790` Rust facts, `7fd6950` TS): static TS/JS imports between areas, reference geometry, labelled heuristic; owner approved the updated live screenshots. Observed natively: the API->Auth edge (dashed, dormant until travelled).
- **Whole-project map** (`531db7c` Rust `project_inventory`, `ec558b8` TS): areas from the full listing, untouched areas dimmed (observed natively: Config); technology hints only from manifest names; engines only from compose images or the Prisma provider; stable 12 by file count. Five realistic fixture projects (`.local/map-fixtures`) are acceptance tests using the real Rust listing; not yet connected natively except e2e-project.
- **Hook**: every dropped event leaves a marker (`0313aa5`); runtime bounded to ~2.4 s even on a stuck filesystem (`ea1b2fa`).
- **Windows**: Expanded's X minimizes it (`5cc6ed0`, owner decision); closing the last window keeps Raio in the tray (Windows only); tray Quit exits. Expanded is created lazily for island/mini launches (`c128703`, median time to a visible Island 625 -> 499 ms).
- **Idle float**: the idle mini-orb floats ~30 s after a state change, then rests (`16e4e38`, owner option a). Native CPU after this change not re-measured.
- Tests on main at `ec558b8`: vitest 621, tsc 0, build 0, Playwright 27/27, cargo 150 unit + 9 integration (+3 ignored fixture/timing tests passing).

Open: "window inside a window" look (native title bar above the app's own; owner will describe), tray/Island click paths for the minimized Expanded not exercised, native CPU re-measure after the bounded float, showing why a test result is unknown (e.g. piped output), sparse 20k-file trees near the 2 s listing budget, optional GitHub integration (proposal only), macOS/Linux never run.

## Round 2 (2026-10-01/02): live director, idle cost, robustness

Same machine and OS. Claude Code 2.1.287. Display during the PERF-3 checks: 175% scaling with two monitors (changed by the owner between measurements, so PERF-1 and PERF-3 are not like-for-like). Nothing run on macOS or Linux.

- **Validation history** (`fc63269`): results keep the status they had when they happened; a pass later outlived by a change gets a later `stale` entry; a failure stays `failed`, annotated "code changed since". Map rows keep clear of the resting orb (1-13 groups, tested).
- **Live director** (`8dd1098`): the orb follows live sessions as events arrive (same beats and frame model as the replay), within ~2 s of the latest event except while back-to-back protected moments play; never skips failures/warnings/notices; no edges are invented; the loop stops once parked. Two independent read-only reviews; findings fixed. Unit and visual tests only: **not exercised with a real interactive session yet** (see below).
- **One instance per user, inbox hygiene, retention, nested .gitignore, stricter path validation, settings key order** (`fb4b9ad`). Inbox TTL is 8 days (longer than the hook's 7-day inertness).
- **Idle cost** (release, `.local/perf/REPORT-PERF-1.md` and `REPORT-PERF-3.md`, 3 runs per state, median % of one core): before (8dd1098, 100%, 1 monitor) Expanded 14.1, Island 16.7, Mini 0.62, minimized 12.8; after (2ce809f, 175%, 2 monitors) Expanded 12.2, Island 14.8, Mini 0.25, **minimized 0.13** (`525147e`). Private working set ~140 -> 88-116 MB; processes 9 -> 7-8 (Island/Mini created on first use, `d5d48da`). **Still over the < 1% budget while Expanded or Island is visible**: the cause is the infinite `raio-bob` CSS animation of the idle mini-orb (injecting `animation: none` gave 0.06% / 1.7%) plus the Island's 33 ms cursor poll. Changing `raio-bob` is a visible change awaiting the owner's decision.
- **Surface intent** (`2ce809f`): "View changes" opened the Mini Player in replay 9/9 natively (3 cold). `--surface=island` showed no Expanded flash in 18 launches; **one of those launches showed no Island within 6 s (not diagnosed)**.
- **raio-hook** accepts UTF-8 with/without BOM and UTF-16 with BOM (PowerShell pipes add a BOM; 17/17 fixture events stored natively).
- **Opening the app**: `npm run app` (product), `npm run dev:harness` (labelled fixture harness; no longer opens a browser tab) (`63e35c0`).
- **Dev server watcher** (`a0163e9`): ignoring `src-tauri/target`, `.local` and `.worktrees` fixed the first-test-per-worker Playwright timeouts (3 consecutive 26/26 runs); likely the earlier "cold scene" flake.
- Tests on main at `2ce809f`: vitest 311 passed, tsc 0, build 0, Playwright 26/26, cargo 72 unit + 5 integration.

Not done this round: a real **interactive** Claude Code session with replay after an app restart (blocked: the native folder picker cannot be driven through UI Automation; needs the owner to connect the throwaway project once); TS/JS import edges (authorisation unclear); morph and installer (backlog); tray clicks, occlusion, 100%/150% DPI comparisons.

## What works (verified)

### M0 - central UI in the browser
- Prototype ported unchanged first (`022b4da`): 16 ported tests passed and the build succeeded before any change.
- Product (`index.html`) separated from the labelled dev harness (`harness.html`); `npm run build` fails if harness markers reach `dist/` (a planted marker makes the check exit 1).
- Semantic corrections (`ca43a58`), approved-export renderer details (`f6ba810`).
- Film keyframes vs the design's reference renders: 0.07-0.32% of pixels differ (threshold 0.1).

### M1 - Tauri shell (release build)
- Island gate (`.local/tools/island-gate.ps1`, which only clicks on the Island or its own test window), run with fixture data and again with real session data after the review fixes: 20 hovers with an editor-like window in front, focus never changed (0/40 checks), the Island was the window under the cursor 20/20, a click outside the capsule reached the window beneath, keystrokes kept going to the foreground window, clicking the capsule body did not take focus, "Open full view" showed Expanded and hid the Island. With no session the Island shows an idle capsule that opens Raio.
- Mini Player: header drag moved the OS window by exactly (-200,-120); the pin toggled always-on-top (True -> False).

### E2E-1 - real Claude Code sessions -> Raio
- Hook contract observed and recorded (`docs/integrations/claude-code-hooks.md`, sanitised fixtures).
- UI connect flow exercised natively: Choose a folder -> review (other settings masked) -> Connect wrote 6 marked async hooks, kept the existing permission rule, and backed up the original into Raio's data folder; UI Disconnect restored the original JSON exactly (0 Raio handlers left).
- Three real `claude -p` sessions (subscription, no permission bypass) in a throwaway project under ignored `.local/`: 43 events persisted (SQLite `user_version` 1; inbox, dropped and quarantine empty). Shown correctly: areas touched, "Migration file added", "Dependency manifest changed", "Tests passed" backed by the tool-success event, "Tests stale" after a post-test edit, "Tests failed / Needs attention" for a failing run, every edit "reported, consistent on disk".
- Replay from persisted events; after an app restart both the session view and the replay end frame were pixel-identical to before (0 px differ).

### Test suites (last run on the final code)
- `npm test`: 211 passed (15 files). `npx tsc --noEmit`: exit 0. `npm run build`: exit 0, harness check passed.
- `cargo test`: 33 unit + 2 integration passed (the integration test drives the real `raio-hook` binary with the recorded payloads and asserts no sentinel text, command line or absolute path reaches disk).
- `npm run test:visual`: 18 passed (3 consecutive runs). The suite is intermittently flaky on a cold first scene (2 isolated failures in about 10 runs, each passing on rerun).

### Reviews
- Read-only Claude reviews of the plan and of the M1/E2E-1 milestone; all high and medium findings were fixed in `d4f93d6` except those listed below. **No independent review by a different model family (Codex) happened**: `codex` is not installed on this machine.

## Not done, not verified, or failing
- **Idle cost above budget** (brief: < 1% CPU idle, < 150 MB). Latest release measurement with no session: Expanded idle 16.7% of one core (1.05% of 16 cores), Island 18.4%; ~520 MB working set / 242 MB private over raio.exe + 8 WebView2 processes. The React clock is not the cause; next suspects are infinite CSS animations, backdrop-filter and three webviews. Next: lazy floating webviews, imperative rendering (brief section 8), profiling.
- Live animated director: live sessions show their compiled end state, refreshed on every event; the orb does not yet follow the agent in real time.
- Not exercised natively: 125/150% scaling, multiple monitors, display disconnection, tray menu clicks, minimize/resume, keyboard access to the non-focusable Island, Mica/Acrylic vibrancy, OS-specific chrome for Expanded, cross-surface morph (deferred), Mini corner snapping, interactive (non `-p`) Claude Code sessions, subagents/parallel activity with a real agent.
- Map: no edges yet (relationships shown as unknown); node positions are deterministic but not persisted or user-editable; groups are heuristic.
- Review findings still open (low severity): serde_json reorders keys of the user's settings file on connect (content preserved, formatting not); no single-instance guard (two Raio instances would double-watch); inbox `.tmp` orphans, `dropped/` and `quarantine/` are not pruned and the planned inbox TTL is not implemented; retention runs only at startup; `session.ended` reasons all map to "completed"; the watcher reads only the root `.gitignore`; event validation rejects only `:`-style absolute paths; the failure summary says "change worth reviewing" instead of the spec's "check(s) failed"; replay story lists validations after later edits (the times shown are correct).
- Packaging: `raio-hook` must sit next to `raio.exe`; no installer, signing or auto-start.
- `899aba0` (docs) accidentally contains five file renames, so that commit alone does not build; fixed by `e721cf0`. History was not rewritten.

## Incidents during this session
- The prototype's Vite config opened a browser tab whenever a dev server started (including Playwright's); removed. Tabs at `127.0.0.1:<port>` in the owner's browser can be closed.
- One Island probe run used a hidden test window, so one click (screen 762,174) and the keystrokes "raio" went to a Chrome window whose active tab was the local Raio harness. Probes now refuse to click or type unless the target window is Raio's or the probe's own.
- Two captures included personal content (a full-desktop screenshot with browser tabs; a folder dialog listing Documents); both were deleted. Probes now capture only Raio's own windows.

## Machine notes and blockers
- VS 2022 Community on this machine lacks the MSVC libraries; Rust builds run in the VS 2019 Build Tools environment through a local, process-only wrapper (`.local/tools/with-msvc.cmd`, not committed).
- Local-only tooling and evidence (not committed): `.local/tools/` (probes, wrappers), `.local/native/` (window captures), `.local/visual/` (goldens and design-export renders), `.local/e2e-project/` (throwaway project, disconnected).

## Next
1. Owner manual checks on the real desktop (list above), especially 150% scaling and multi-monitor.
2. Idle cost investigation and lazy webviews.
3. Live director so the orb follows the agent during a session; TS/JS import edges (E2E-2).
4. Remaining low-severity review items; then the Codex adapter once `codex` is installed.
