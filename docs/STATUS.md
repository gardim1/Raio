# Raio status

Last updated: 2026-10-01 (end of the M0 -> M1 -> E2E-1 session). Platform for every check below: Windows 11 Pro 10.0.26200, one 1920x1080 display at 100% scaling (96 DPI), Node 22.19.0, Rust 1.98.1 (per-user rustup, `stable-msvc`, PATH not modified), WebView2 154.0.4258.48, Claude Code 2.1.286. Nothing was run on macOS or Linux.

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
