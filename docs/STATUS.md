# Raio status

Last updated: 2026-10-02 (round 3). Earlier sections keep their own dates.

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
- Coordination: one Maestri worker terminal "Raio | Lume" (Claude Code, Sonnet 5.5 high) and the workspace-scoped role "Raio | Implementer" were created; worktrees `.worktrees/m0-deltas` and `.worktrees/e2e-projection` (branches `m0-renderer-deltas`, `e2e-projection`) hold already-integrated work and can be removed.

## Next
1. Owner manual checks on the real desktop (list above), especially 150% scaling and multi-monitor.
2. Idle cost investigation and lazy webviews.
3. Live director so the orb follows the agent during a session; TS/JS import edges (E2E-2).
4. Remaining low-severity review items; then the Codex adapter once `codex` is installed.
