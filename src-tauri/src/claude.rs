//! Claude Code hook payload -> Raio event v1. Runs inside the short-lived `raio-hook` process,
//! so raw payloads never reach disk: only the fields below are kept.
//! Observed contract: docs/integrations/claude-code-hooks.md.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use crate::event::{stable_id, Evidence, RaioEvent, OUTSIDE_PROJECT, SCHEMA};

const EDIT_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const INSPECT_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];
const MAX_REASON_CHARS: usize = 64;

pub struct Context<'a> {
    pub project_id: &'a str,
    pub root: &'a Path,
    pub now_ms: i64,
}

fn text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).and_then(Value::as_str)
}

/// Lexically normalises `..` and `.` (no filesystem access: the hook must stay fast and side-effect free).
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Project-relative POSIX path, or `outside-project`.
pub fn relative_path(root: &Path, cwd: Option<&str>, raw: &str) -> String {
    let p = Path::new(raw);
    let absolute = if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd.unwrap_or("")).join(p) };
    let absolute = normalise(&absolute);
    let root = normalise(root);
    // Windows verbatim prefixes (from canonicalised paths) must not hide a match.
    let plain = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_start_matches("//?/").trim_end_matches('/').to_string();
    let fold = |p: &Path| plain(p).to_lowercase();
    let (abs_s, root_s) = (fold(&absolute), fold(&root));
    if abs_s == root_s {
        return ".".into();
    }
    match abs_s.strip_prefix(&format!("{root_s}/")) {
        // Keep the original casing of the relative part.
        Some(rest) => {
            let original = plain(&absolute);
            let original = original.as_str();
            let start = original.len().wrapping_sub(rest.len());
            if original.len() == abs_s.len() && original.is_char_boundary(start) { original[start..].to_string() } else { rest.to_string() }
        }
        None => OUTSIDE_PROJECT.into(),
    }
}

/// Command class and program from a command line. The command line itself is never kept.
pub fn classify_command(command: &str) -> (String, Option<String>, bool) {
    let segments: Vec<&str> = command
        .split(|c| c == ';' || c == '|' || c == '\n')
        .flat_map(|s| s.split("&&"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let compound = segments.len() > 1;
    let words = |s: &str| -> Vec<String> {
        s.split_whitespace()
            .skip_while(|w| w.contains('=') && !w.starts_with('-'))
            .map(|w| w.trim_matches(|c| c == '"' || c == '\'').to_lowercase())
            .collect()
    };
    let class_of = |w: &[String]| -> &'static str {
        let j = w.join(" ");
        let has = |needle: &str| j == needle || j.starts_with(&format!("{needle} "));
        let first = w.first().map(String::as_str).unwrap_or("");
        let test = ["npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "npx vitest", "npx jest", "vitest", "jest", "pytest", "python -m pytest", "cargo test", "go test", "dotnet test", "mvn test", "gradle test", "node --test", "deno test", "bun test"];
        let build = ["npm run build", "pnpm build", "pnpm run build", "yarn build", "cargo build", "tsc", "npx tsc", "vite build", "npx vite build", "go build", "dotnet build", "make", "mvn package", "gradle build"];
        let migration = ["npx prisma migrate", "prisma migrate", "alembic upgrade", "npx knex migrate", "knex migrate", "npx sequelize db:migrate", "rails db:migrate", "bin/rails db:migrate", "python manage.py migrate", "npm run migrate", "diesel migration run", "sqlx migrate run"];
        let install = ["npm install", "npm i", "npm ci", "npm add", "pnpm add", "pnpm install", "pnpm i", "yarn add", "yarn install", "pip install", "python -m pip install", "cargo add", "cargo install", "go get", "dotnet add package", "bun add"];
        if test.iter().any(|n| has(n)) {
            "test"
        } else if build.iter().any(|n| has(n)) {
            "build"
        } else if migration.iter().any(|n| has(n)) {
            "migration"
        } else if install.iter().any(|n| has(n)) || (first == "yarn" && w.len() == 1) {
            "install"
        } else {
            "other"
        }
    };
    const PRIORITY: [&str; 5] = ["test", "build", "migration", "install", "other"];
    let mut best = "other";
    for s in &segments {
        let c = class_of(&words(s));
        if PRIORITY.iter().position(|p| *p == c) < PRIORITY.iter().position(|p| *p == best) {
            best = c;
        }
    }
    let program = segments.first().and_then(|s| words(s).into_iter().next()).map(|p| {
        let name = p.rsplit(['/', '\\']).next().unwrap_or(&p).to_string();
        name.trim_end_matches(".exe").chars().take(32).collect()
    });
    (best.into(), program, compound)
}

/// "Exit code N" at the start of a Bash failure message.
fn exit_code_from_error(error: &str) -> Option<i64> {
    error.strip_prefix("Exit code ")?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(now_ms: i64) -> String {
    format!("{now_ms}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Normalises one payload. `None` means "nothing Raio records for this hook" (not an error).
pub fn normalize(payload: &Value, ctx: &Context) -> Option<RaioEvent> {
    let event = text(payload, "hook_event_name")?;
    let session = text(payload, "session_id").map(str::to_owned);
    let cwd = text(payload, "cwd");
    let tool = text(payload, "tool_name");
    let input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
    let tool_use_id = text(payload, "tool_use_id").map(str::to_owned);
    let mut evidence = Evidence { tool_use_id: tool_use_id.clone(), tool_name: tool.map(str::to_owned), ..Evidence::default() };
    let file_path = || text(&input, "file_path").or_else(|| text(&input, "notebook_path")).or_else(|| text(&input, "path"));
    let paths_of = |raw: Option<&str>| raw.map(|r| vec![relative_path(ctx.root, cwd, r)]).unwrap_or_default();

    let (kind, paths, id_key): (&str, Vec<String>, String) = match (event, tool) {
        ("SessionStart", _) => {
            evidence.detail = text(payload, "source").map(str::to_owned);
            ("session.started", vec![], format!("start:{}", evidence.detail.as_deref().unwrap_or("")))
        }
        ("SessionEnd", _) => {
            // Kept as the hook reported it (a short enum such as `clear`, `logout`, `other`); only cut so an
            // unexpected value cannot make the whole record invalid.
            evidence.detail = text(payload, "reason").map(|r| r.chars().take(MAX_REASON_CHARS).collect());
            ("session.ended", vec![], "end".into())
        }
        ("Stop", _) => ("turn.ended", vec![], format!("stop:{}", text(payload, "prompt_id").map(str::to_owned).unwrap_or_else(|| unique(ctx.now_ms)))),
        ("PreToolUse", Some(t)) if EDIT_TOOLS.contains(&t) => ("file.edit.attempted", paths_of(file_path()), String::new()),
        ("PreToolUse", Some("Bash")) | ("PostToolUse", Some("Bash")) | ("PostToolUseFailure", Some("Bash")) => {
            let (class, program, compound) = classify_command(text(&input, "command").unwrap_or(""));
            evidence.command_class = Some(class);
            evidence.program = program;
            let background = input.get("run_in_background").and_then(Value::as_bool).unwrap_or(false);
            let interrupted = payload.get("tool_response").and_then(|r| r.get("interrupted")).and_then(Value::as_bool).unwrap_or(false)
                || payload.get("is_interrupt").and_then(Value::as_bool).unwrap_or(false);
            // The tool's success/failure only reflects the check itself for a single, foreground, completed command.
            let result_reflects_command = !compound && !background && !interrupted;
            evidence.detail = match (compound, background, interrupted) {
                (_, _, true) => Some("interrupted".into()),
                (_, true, _) => Some("background command".into()),
                (true, _, _) => Some("compound command".into()),
                _ => None,
            };
            if event == "PreToolUse" {
                ("command.observed", vec![], String::new())
            } else {
                if !result_reflects_command {
                    // Pipes, `|| true`, `; echo`, background runs and interruptions hide the check's own result.
                } else if event == "PostToolUse" {
                    // Observed with Claude Code 2.1.286: non-zero exits arrive as PostToolUseFailure.
                    evidence.exit_code = Some(0);
                    evidence.exit_code_source = Some("tool-success".into());
                } else if let Some(code) = text(payload, "error").and_then(exit_code_from_error) {
                    evidence.exit_code = Some(code);
                    evidence.exit_code_source = Some("failure-message".into());
                }
                ("command.result", vec![], String::new())
            }
        }
        ("PostToolUse", Some(t)) if EDIT_TOOLS.contains(&t) => {
            evidence.change = Some(match payload.get("tool_response").and_then(|r| text(r, "type")) {
                Some("create") => "added",
                Some("update") => "modified",
                _ => "unknown",
            }
            .into());
            ("file.edit.reported", paths_of(file_path()), String::new())
        }
        ("PostToolUseFailure", Some(t)) if EDIT_TOOLS.contains(&t) => ("file.edit.failed", paths_of(file_path()), String::new()),
        ("PostToolUse", Some(t)) if INSPECT_TOOLS.contains(&t) => {
            let paths = paths_of(file_path());
            if paths.is_empty() {
                return None;
            }
            ("file.inspected", paths, String::new())
        }
        _ => return None,
    };

    let occurrence = if id_key.is_empty() { tool_use_id.unwrap_or_else(|| unique(ctx.now_ms)) } else { id_key };
    Some(RaioEvent {
        schema: SCHEMA,
        id: stable_id(&["claude-hook", session.as_deref().unwrap_or(""), &occurrence, event]),
        source: "claude-hook".into(),
        provenance: "agent-reported".into(),
        attribution: "session".into(),
        project_id: ctx.project_id.into(),
        session_id: session,
        agent: "claude".into(),
        subagent_id: text(payload, "agent_id").map(str::to_owned),
        source_at: Some(ctx.now_ms),
        observed_at: 0,
        seq: 0,
        kind: kind.into(),
        paths,
        evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude-code-2.1.286");

    fn ctx() -> Context<'static> {
        Context { project_id: "pid", root: Path::new("C:\\fixture\\acme-mini"), now_ms: 1_000 }
    }

    fn fixture(name: &str) -> Value {
        serde_json::from_str(&fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap()).unwrap()
    }

    fn all() -> Vec<(String, Option<RaioEvent>)> {
        let mut names: Vec<String> = fs::read_dir(FIXTURES).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names.into_iter().map(|n| (n.clone(), normalize(&fixture(&n), &ctx()))).collect()
    }

    #[test]
    fn maps_every_recorded_payload_and_drops_what_raio_does_not_record() {
        let kinds: Vec<(String, Option<String>)> = all().into_iter().map(|(n, e)| (n, e.map(|e| e.kind))).collect();
        let expect = |name: &str, kind: Option<&str>| {
            let got = kinds.iter().find(|(n, _)| n == name).unwrap().1.as_deref();
            assert_eq!(got, kind, "{name}");
        };
        expect("01-SessionStart.json", Some("session.started"));
        expect("02-UserPromptSubmit.json", None);
        expect("03-PreToolUse-Read.json", None);
        expect("04-PostToolUse-Read.json", Some("file.inspected"));
        expect("05-PreToolUse-Write.json", Some("file.edit.attempted"));
        expect("06-PostToolUse-Write.json", Some("file.edit.reported"));
        expect("12-PreToolUse-Bash.json", Some("command.observed"));
        expect("13-PostToolUseFailure-Bash.json", Some("command.result"));
        expect("17-PostToolUse-Bash.json", Some("command.result"));
        expect("18-Stop.json", Some("turn.ended"));
        expect("19-SessionEnd.json", Some("session.ended"));
    }

    #[test]
    fn never_carries_prompt_content_output_or_full_commands() {
        for (name, event) in all() {
            let Some(event) = event else { continue };
            let json = serde_json::to_string(&event).unwrap();
            assert!(!json.contains("SENTINEL_"), "{name}: {json}");
            assert!(!json.contains("process.exit"), "{name} kept a command line: {json}");
            assert!(!json.contains("fixture\\\\acme-mini") && !json.contains("C:"), "{name} kept an absolute path: {json}");
            assert_eq!(event.validate(), Ok(()), "{name}");
        }
    }

    #[test]
    fn records_exit_codes_only_with_evidence() {
        let failure = normalize(&fixture("13-PostToolUseFailure-Bash.json"), &ctx()).unwrap();
        assert_eq!(failure.evidence.exit_code, Some(1));
        assert_eq!(failure.evidence.exit_code_source.as_deref(), Some("failure-message"));
        assert_eq!(failure.evidence.command_class.as_deref(), Some("test"));
        assert_eq!(failure.evidence.program.as_deref(), Some("node"));
        let success = normalize(&fixture("17-PostToolUse-Bash.json"), &ctx()).unwrap();
        assert_eq!((success.evidence.exit_code, success.evidence.exit_code_source.as_deref()), (Some(0), Some("tool-success")));
        let observed = normalize(&fixture("12-PreToolUse-Bash.json"), &ctx()).unwrap();
        assert_eq!(observed.evidence.exit_code, None);
    }

    #[test]
    fn hides_results_that_do_not_reflect_the_check() {
        let mut p = fixture("17-PostToolUse-Bash.json");
        p["tool_input"]["command"] = serde_json::json!("npm test 2>&1 | tail -50");
        assert_eq!(normalize(&p, &ctx()).unwrap().evidence.exit_code, None);
        let mut p = fixture("17-PostToolUse-Bash.json");
        p["tool_input"]["run_in_background"] = serde_json::json!(true);
        assert_eq!(normalize(&p, &ctx()).unwrap().evidence.exit_code, None);
        let mut p = fixture("17-PostToolUse-Bash.json");
        p["tool_response"]["interrupted"] = serde_json::json!(true);
        let e = normalize(&p, &ctx()).unwrap();
        assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), (None, Some("interrupted")));
    }

    #[test]
    fn reports_added_files_and_project_relative_paths() {
        let e = normalize(&fixture("08-PostToolUse-Write.json"), &ctx()).unwrap();
        assert_eq!(e.paths, vec!["db/migrations/0001_init.sql".to_string()]);
        assert_eq!(e.evidence.change.as_deref(), Some("added"));
    }

    #[test]
    fn pre_and_post_of_one_tool_call_get_different_stable_ids() {
        let pre = normalize(&fixture("05-PreToolUse-Write.json"), &ctx()).unwrap();
        let post = normalize(&fixture("06-PostToolUse-Write.json"), &ctx()).unwrap();
        assert_ne!(pre.id, post.id);
        assert_eq!(post.id, normalize(&fixture("06-PostToolUse-Write.json"), &ctx()).unwrap().id);
    }

    #[test]
    fn unknown_and_truncated_payloads_produce_nothing() {
        assert!(normalize(&serde_json::json!({"hook_event_name": "SomethingNew"}), &ctx()).is_none());
        assert!(normalize(&serde_json::json!({"no": "event"}), &ctx()).is_none());
        assert!(serde_json::from_str::<Value>("{\"hook_event_name\": \"PostToolUse\", \"tool_na").is_err());
    }

    #[test]
    fn paths_outside_the_project_are_not_revealed() {
        let root = Path::new("C:\\work\\app");
        assert_eq!(relative_path(root, None, "C:\\work\\app\\src\\a.ts"), "src/a.ts");
        assert_eq!(relative_path(root, Some("C:\\work\\app"), "src\\b.ts"), "src/b.ts");
        assert_eq!(relative_path(root, None, "C:\\work\\APP\\Src\\C.ts"), "Src/C.ts");
        assert_eq!(relative_path(root, None, "C:\\Users\\someone\\.ssh\\id_rsa"), OUTSIDE_PROJECT);
        assert_eq!(relative_path(root, None, "C:\\work\\app\\..\\other\\x"), OUTSIDE_PROJECT);
        assert_eq!(relative_path(root, None, "C:\\work\\application\\x"), OUTSIDE_PROJECT);
        assert_eq!(relative_path(Path::new("\\\\?\\C:\\work\\app"), None, "C:\\work\\app\\x.ts"), "x.ts");
    }

    fn session_end(reason: Option<&str>) -> RaioEvent {
        let mut p = fixture("19-SessionEnd.json");
        match reason {
            Some(r) => p["reason"] = serde_json::json!(r),
            None => {
                p.as_object_mut().unwrap().remove("reason");
            }
        }
        normalize(&p, &ctx()).unwrap()
    }

    #[test]
    fn session_end_keeps_the_hooks_reason_as_reported() {
        for reason in ["clear", "logout", "prompt_input_exit", "bypass_permissions_disabled", "resume", "other", "some-future-reason"] {
            let e = session_end(Some(reason));
            assert_eq!((e.kind.as_str(), e.evidence.detail.as_deref()), ("session.ended", Some(reason)));
            assert_eq!(e.validate(), Ok(()));
        }
    }

    #[test]
    fn session_end_without_a_reason_claims_none() {
        let e = session_end(None);
        assert_eq!(e.kind, "session.ended");
        assert_eq!(e.evidence.detail, None);
        assert_eq!(e.validate(), Ok(()));
    }

    #[test]
    fn an_overlong_reason_is_cut_not_allowed_to_invalidate_the_event() {
        let e = session_end(Some(&"x".repeat(5_000)));
        let detail = e.evidence.detail.as_deref().unwrap();
        assert!(detail.len() <= 64 && detail.chars().all(|c| c == 'x'), "{detail}");
        assert_eq!(e.validate(), Ok(()));
    }

    #[test]
    fn classifies_commands_without_keeping_them() {
        assert_eq!(classify_command("npm test").0, "test");
        assert_eq!(classify_command("CI=1 npx vitest run").0, "test");
        assert_eq!(classify_command("npm run build && echo ok").0, "build");
        assert_eq!(classify_command("npx prisma migrate deploy").0, "migration");
        assert_eq!(classify_command("npm install left-pad").0, "install");
        assert_eq!(classify_command("ls -la").0, "other");
        assert_eq!(classify_command("echo hi; cargo test").0, "test");
        assert!(classify_command("echo hi; cargo test").2);
        assert_eq!(classify_command("C:/tools/node.exe --test").1.as_deref(), Some("node"));
    }
}
