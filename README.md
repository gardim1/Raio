# Raio

A local-first desktop companion that shows where an AI coding agent worked in a project: an animated map of the areas it touched, factual notices, honest validation states, and a short session replay.

Status: early development. Windows 11 is the only platform where anything has been run. macOS and Linux are targets, not verified. See `docs/STATUS.md` for what works and what was verified.

- Architecture: `docs/ARCHITECTURE.md`
- Current plan: `docs/plans/2026-10-01-m0-m1-e2e1.md`
- Claude Code hook contract (observed): `docs/integrations/claude-code-hooks.md`

## Develop

Requirements: Node 20.19+ (22 used), Rust stable with the MSVC toolchain on Windows, the WebView2 runtime.

```bash
npm ci
npm test            # domain and adapter tests (Vitest)
npm run build       # typecheck + product build + check that no dev-harness code ships
npm run dev:harness # browser review harness with the labelled demo fixture
npm run test:visual # renderer screenshots against local goldens (Playwright, Edge channel)
cargo test --manifest-path src-tauri/Cargo.toml
npm run app:build   # tauri build --no-bundle: src-tauri/target/release/raio.exe and raio-hook.exe
```

`index.html` is the product; `harness.html` is a development-only review harness (mode dock, concept film, states gallery) and never ships.

## What to open

| You want | Command | What it is |
|---|---|---|
| **The product** (native Windows app) | `npm run app:build` once, then `npm run app` (`-- --surface=island\|mini\|expanded`) | Tauri app with real data from connected projects. Warns if the build is older than the sources. Quit from the tray icon. |
| Dev review harness | `npm run dev:harness`, then open the printed `http://127.0.0.1:<port>/harness.html` | Browser-only, labelled **demo fixture** data, review controls (mode dock, film, states). Never ships. Does not open a browser by itself. |
| Design reference | not in the repository | The approved design export is kept locally by the owner; it is the visual reference, not the product. |

There is no installer yet: `npm run app` runs the development build in place.

## Use (development build)

1. Run `npm run app` (or `src-tauri/target/release/raio.exe` directly; `--surface=island|mini|expanded` picks the first surface; the tray switches surfaces).
2. **Choose a folder**, review the exact change to `<project>/.claude/settings.local.json`, and **Connect**. Nothing is written before you confirm; the original file is backed up; **Disconnect** removes only Raio's entries.
3. Start a new Claude Code session in that folder. Raio records minimised events (no prompts, file contents, tool output or full command lines) in a local SQLite database under your user's app data folder and shows the latest session; **View changes** replays it.

The `raio-hook` binary must stay next to `raio.exe` (packaging is not done yet). The hook is asynchronous, always exits 0, and goes inert if Raio has not run for 7 days.

## Privacy

Everything stays on this machine. There is no account, cloud backend, telemetry or LLM call. Grouping of files into areas is a heuristic, relationships between areas are shown as unknown, and edits are reported as "consistent on disk", never as proven authorship.
