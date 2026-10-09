# Claude Code hooks: observed contract

Observed on 2026-10-01 with Claude Code 2.1.286 on Windows 11, one short `claude -p` session in a throwaway project, all hooks configured as `type: "command"` with `async: true` in the project's `.claude/settings.local.json`. Sanitised payloads: `src-tauri/tests/fixtures/claude-code-2.1.286/` (every free-text field replaced by a `SENTINEL_*` string, paths rebased onto `C:\fixture\acme-mini`, ids replaced). Raw captures were deleted after sanitising.

This is evidence from one version and one session, not a general guarantee. Re-capture when Claude Code changes.

| Question (plan task 2.1) | Answer | Evidence |
|---|---|---|
| Do async `Stop`/`SessionEnd` hooks survive `claude -p` exiting? | Yes, in this run both arrived. | fixtures 18, 19 |
| Is the hook command run through a shell on Windows? | Yes, Git Bash (`SHELL` was `...\Git\bin\bash.exe`). A double-quoted absolute path with spaces and forward slashes worked. | capture metadata (not committed) |
| Does the Bash result carry an exit code? | Not on success: `PostToolUse` has `stdout`, `stderr`, `interrupted` only. Non-zero exits produced `PostToolUseFailure` whose `error` starts with `Exit code N` (seen for 1 and 3). | fixtures 13, 15, 17 |
| Does `SessionStart` carry a source? | Yes, `source: "startup"`. | fixture 01 |
| Is there a prompt id? | `prompt_id` appears from `UserPromptSubmit` on; `SessionStart` has none. | fixtures 01, 02 |
| Per-event id or sequence? | None. `tool_use_id` identifies each tool call (shared by its Pre/Post pair). | all tool fixtures |
| Is "added" vs "modified" observable? | `Write`'s `tool_response.type` was `create` for new files. | fixtures 06, 08, 10 |
| Does `timeout` apply to async hooks? | Not tested. The hook binary enforces its own deadline either way. | - |
| `SessionEnd` reason for `-p` | `other`. | fixture 19 |
| Are hooks added to `settings.local.json` picked up by a session that is already open? | Yes on 2.1.295 (2026-10-08, interactive `claude --model haiku`, folder trusted): the next tool call after the write produced `PostToolUse`, then `Stop`; `SessionEnd` on `/exit`. No `SessionStart` exists for such a session. Matches the reference ("direct edits to hooks in settings files are normally picked up automatically by the file watcher"). | local evidence `.local/alpha/E-LIVE.md` (not committed) |
| What silences the hook? | A `heartbeat` file older than 7 days in Raio's data dir: the hook exits 0 without writing. Until 0.1.0-alpha.1 the app never refreshed that file on Windows (an empty rewrite does not change the mtime), so after 7 days every event was skipped. Fixed in the next version. | E-CONTRACT F2 (local) |

## Consequences for Raio

- A Bash `PostToolUse` is recorded as `exitCode: 0` with `exitCodeSource: "tool-success"`; a `PostToolUseFailure` with a parsable `Exit code N` as that code with `exitCodeSource: "failure-message"`. Anything else stays without an exit code and validations show "result unknown".
- A tool call with a `PreToolUse` but no `Post*` (for example a command the permission rules denied, fixture 12) stays "observed" and never becomes passed.
- The event id is derived from session id, `tool_use_id` (or prompt id / a generated value) and the hook event name, including `source` for `SessionStart` (startup, resume and compact reuse the session id).
- Prompts, file contents, tool responses, assistant messages and full command strings are never written by Raio; only the program name and a command class are kept.
