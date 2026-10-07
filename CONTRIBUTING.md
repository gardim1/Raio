# Contributing to Raio

Thanks for helping. Raio is an early alpha maintained by one person, so small, focused changes are easiest to review.
Coding agents should also read `AGENTS.md`; it holds the project rules that apply to everyone.

## Before you start

- Bugs and ideas: open an issue first (use the bug template; never paste secrets, private code, prompts or
  transcripts into an issue).
- Keep the approved look: Raio's orb, proportions, typography and motion are deliberate. Visual changes need a
  screenshot before/after in the pull request.
- Raio is local-first: no cloud service, account, telemetry or model API calls. Changes that would add one need a
  discussion first.

## Set up (Windows)

Requirements: Node 20.19+ (22 used), Rust stable with the MSVC toolchain, the Microsoft WebView2 runtime, Microsoft Edge
(for the screenshot tests).

```bash
npm ci
npm test               # domain and adapter tests (Vitest)
npm run build          # typecheck + product build + check that no dev-harness code ships
cargo test --manifest-path src-tauri/Cargo.toml
npm run app:build      # src-tauri/target/release/raio.exe and raio-hook.exe (tauri build --no-bundle)
npm run app            # opens the release build (warns if it is older than the sources)
npm run dev:harness    # browser review harness with labelled demo data (development only)
```

`index.html` is the product; `harness.html` is a development-only review harness (mode dock, concept film, states
gallery) and must never ship. `npm run build` fails if harness markers reach `dist/`.

### Screenshot tests

`npm run test:visual` compares the renderer against screenshot baselines kept outside the repository (rendering differs
between machines, fonts and GPU drivers). On a fresh clone there is no baseline: create yours once from an unchanged
checkout with `npx playwright test --update-snapshots`, then run `npm run test:visual` after your change and attach the
diffs that matter to the pull request. `tests/visual/compare-reference.mjs` is a maintainer-only comparison with the
original design renders, which are not published; it exits 2 when they are absent.

### Packaging

```bash
npm run app:build
npm run app:pack -- --cargo-metadata <file>   # optional: pass `cargo metadata` JSON if cargo is not on PATH
# -> release-local/v<version>/: zip, install-raio.ps1, SHA256SUMS-v<version>.txt and the unpacked folder
#    (raio.exe, raio-hook.exe, LICENSE, THIRD-PARTY-NOTICES.txt, README-PORTABLE.txt)
```

## Pull requests

- One topic per pull request, with tests for domain logic and adapters. Never weaken or delete a test to make it pass.
- Say exactly what you ran (commands, exit codes, Windows version) and what you could not test (tray, DPI, multiple
  monitors and packaging need a real desktop).
- Do not commit credentials, personal absolute paths, captures of private projects, proprietary fonts or unlicensed
  assets.
- By contributing you agree that your contribution is licensed under the MIT License of this repository.
