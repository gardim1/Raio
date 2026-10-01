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
npx tauri build --no-bundle   # src-tauri/target/release/raio.exe and raio-hook.exe
```

`index.html` is the product; `harness.html` is a development-only review harness (mode dock, concept film, states gallery) and never ships.

## Use (development build)

1. Run `src-tauri/target/release/raio.exe` (`--surface=island|mini|expanded` picks the first surface; the tray switches surfaces).
2. **Choose a folder**, review the exact change to `<project>/.claude/settings.local.json`, and **Connect**. Nothing is written before you confirm; the original file is backed up; **Disconnect** removes only Raio's entries.
3. Start a new Claude Code session in that folder. Raio records minimised events (no prompts, file contents, tool output or full command lines) in a local SQLite database under your user's app data folder and shows the latest session; **View changes** replays it.

The `raio-hook` binary must stay next to `raio.exe` (packaging is not done yet). The hook is asynchronous, always exits 0, and goes inert if Raio has not run for 7 days.

## Privacy

Everything stays on this machine. There is no account, cloud backend, telemetry or LLM call. Grouping of files into areas is a heuristic, relationships between areas are shown as unknown, and edits are reported as "consistent on disk", never as proven authorship.
