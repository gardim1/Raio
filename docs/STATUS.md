# Raio status

Last updated: 2026-10-01. Platform for every check below: Windows 11 Pro 10.0.26200, one 1920x1080 display at 100% scaling (96 DPI), Node 22.19.0, Rust 1.98.1 (per-user rustup, `stable-msvc`), WebView2 154.0.4258.48. Nothing here was run on macOS or Linux.

## Done and verified

### M0 - central UI in the browser
- Prototype ported unchanged first (`022b4da`): 16 ported domain tests passed and the build succeeded before any change.
- Product (`index.html`) separated from the labelled dev harness (`harness.html`); `npm run build` fails if harness markers reach `dist/` (negative test: a planted marker makes it exit 1).
- Semantic corrections (`ca43a58`): no "calls/connected" copy, edges only from the map, out-of-scope only when user-marked, factual risk labels, unknown/incomplete validations, honest summary verdict, incomplete sessions, grouping instead of dropping when the replay overflows.
- Approved export's renderer details ported by the worker and reviewed (`f6ba810`).
- Visual tests (Playwright, local Edge channel, renderer only): 18 scenes at a frozen clock, tolerance 0.05%. Film keyframes vs the design reference: 0.07-0.32% of pixels differ (threshold 0.1). Goldens are local under `.local/visual/` and not published.

### M1 - Tauri shell (Windows, release build)
- `cargo test`: 2 passed. `npx tauri build --no-bundle` succeeds (needs the VS 2019 Build Tools environment on this machine; see blockers).
- Island gate, exercised with `.local/tools/island-gate.ps1` (a probe that only clicks on the Island or on its own test window): 20 hovers with an editor-like window in the foreground -> focus never changed (0/40 checks); click outside the capsule reached the window beneath; keystrokes kept reaching the foreground window while hovering; clicking the capsule body did not take focus; "Open full view" showed Expanded (1280x642 client) and hid the Island.
- Mini Player: dragging the header moved the OS window by exactly (-200,-120); the pin toggled always-on-top (True -> False).
- Measured (one run each, release, demo fixture): Expanded idle 20.6% of one core (1.28% of 16 cores), working set 632 MB / private 362 MB summed over raio.exe + 8 WebView2 processes; Island idle 12.8% of one core after pausing hidden CSS animations, 569 MB / 296 MB.

## Not done, not verified, or failing
- **Idle cost is above the brief's budget** (< 1% CPU idle, < 150 MB). Next steps: create floating webviews lazily, imperative per-frame rendering (brief section 8), profile the remaining CSS animation and backdrop-filter cost.
- Not exercised: 125/150% scaling (changing display scaling is a machine setting), multiple monitors, display disconnection, tray menu clicks, minimize/resume, keyboard access to the non-focusable Island (it cannot take focus by design; the tray and Expanded remain keyboard reachable), Windows 11 Mica/Acrylic vibrancy (CSS glass only), OS-specific chrome for Expanded (it currently uses the default Windows title bar plus the design's inner title row), cross-surface morph (deferred: each surface is its own window and switches without the morph), corner snapping of the Mini.
- Independent review by a different model family (Codex) did not happen: `codex` is not installed on this machine. Reviews were done by read-only Claude subagents.
- `899aba0` (docs) accidentally contains five file renames staged earlier, so that commit alone does not build; fixed by `e721cf0`. History was not rewritten.

## Incidents during this session
- The prototype's Vite config had `server.open: true`; every dev server started by the tooling (including Playwright's) opened a tab in the owner's default browser. Removed. Such tabs at `127.0.0.1:<port>` can be closed.
- One Island probe run used a hidden test window by mistake, so one click (at screen 762,174) and the keystrokes "raio" went to a Chrome window whose active tab was the local Raio harness. The probe now refuses to click or type unless the target window is ours and in the foreground.
- A first full-desktop screenshot captured unrelated browser tabs; it was deleted and probes now capture only Raio's own windows.

## Blockers and machine notes
- The VS 2022 Community toolset on this machine lacks the MSVC libraries (`msvcrt.lib`); builds run inside the VS 2019 Build Tools environment through a local, process-only wrapper (`.local/tools/with-msvc.cmd`, not committed). No global settings were changed; rustup was installed with `--no-modify-path`.

## Next
E2E-1: capture real Claude Code hook payloads, `raio-hook` + inbox + SQLite ingestion, projection and replay from persisted events, connect/disconnect, a real session.
