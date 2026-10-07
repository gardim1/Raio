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

/// Parses a hook payload from raw stdin bytes. Accepts UTF-8 with or without a BOM and UTF-16LE/BE that
/// starts with a BOM (what a Windows PowerShell/.NET pipe may deliver); anything else is `None`.
/// Nothing is ever written from here: the caller drops and counts what this rejects.
pub fn parse_payload(bytes: &[u8]) -> Option<Value> {
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => serde_json::from_slice(rest).ok(),
        [0xFF, 0xFE, rest @ ..] => parse_utf16(rest, u16::from_le_bytes),
        [0xFE, 0xFF, rest @ ..] => parse_utf16(rest, u16::from_be_bytes),
        _ => serde_json::from_slice(bytes).ok(),
    }
}

fn parse_utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> Option<Value> {
    let (pairs, odd) = bytes.as_chunks::<2>();
    if !odd.is_empty() {
        return None;
    }
    let units: Vec<u16> = pairs.iter().map(|p| unit(*p)).collect();
    serde_json::from_str(&String::from_utf16(&units).ok()?).ok()
}

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

fn safe_word_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || b"_./\\:=@%+,-~".contains(&c)
}

/// Advances over safe word/quote fragments only. Quoted # is literal (the contract's explicit positive).
fn allowed_word(bytes: &[u8], i: &mut usize) -> bool {
    let start = *i;
    while let Some(&c) = bytes.get(*i) {
        if safe_word_char(c) {
            // A backslash before a quote/control/space could change shell tokenisation.
            if c == b'\\' && !bytes.get(*i + 1).is_some_and(|next| safe_word_char(*next)) {
                return false;
            }
            *i += 1;
        } else if matches!(c, b'\'' | b'"') {
            *i += 1;
            while bytes.get(*i).is_some_and(|next| *next != c) {
                if matches!(bytes[*i], b'$' | b'`' | b'!' | b'\n' | b'\r') || (c == b'"' && bytes[*i] == b'\\') {
                    return false;
                }
                *i += 1;
            }
            if bytes.get(*i) != Some(&c) {
                return false;
            }
            *i += 1;
        } else {
            break;
        }
    }
    *i > start
}

/// Trust shell status only for this deliberately small grammar, never by absence of known hazards.
fn simple_command_allowed(command: &str, powershell: bool) -> bool {
    // Keep the grammar ASCII-only: PowerShell also treats curly quotes as string delimiters.
    if !command.is_ascii() {
        return false;
    }
    let bytes = command.trim_matches([' ', '\t']).as_bytes();
    // A leading PowerShell string expression is not an invocation without the call operator.
    if powershell && bytes.first().is_some_and(|c| matches!(c, b'\'' | b'"')) {
        return false;
    }
    if bytes.iter().any(|c| matches!(c, b'\n' | b'\r')) {
        return false;
    }
    let mut i = 0;
    if powershell && bytes.first() == Some(&b'&') {
        i = 1;
        if !bytes.get(i).is_some_and(|c| matches!(c, b' ' | b'\t')) {
            return false;
        }
    }
    let mut has_word = false;
    while i < bytes.len() {
        while bytes.get(i).is_some_and(|c| matches!(c, b' ' | b'\t')) { i += 1; }
        if i == bytes.len() { break; }
        let rest = &bytes[i..];
        let descriptor = [b"2>&1".as_slice(), b"1>&2", b">&2"].into_iter()
            .chain(powershell.then_some(b"*>&1".as_slice())).find(|prefix| rest.starts_with(prefix));
        if let Some(prefix) = descriptor {
            i += prefix.len();
            if bytes.get(i).is_some_and(|c| !matches!(c, b' ' | b'\t')) { return false; }
            continue;
        }
        let file_redirect = [b"2>".as_slice(), b">>", b">"].into_iter()
            .chain(Some(if powershell { b"*>".as_slice() } else { b"&>".as_slice() }))
            .find(|prefix| rest.starts_with(prefix));
        if let Some(prefix) = file_redirect {
            i += prefix.len();
            while bytes.get(i).is_some_and(|c| matches!(c, b' ' | b'\t')) { i += 1; }
            if !allowed_word(bytes, &mut i) { return false; }
            if bytes.get(i).is_some_and(|c| !matches!(c, b' ' | b'\t')) { return false; }
            continue;
        }
        let start = i;
        if !allowed_word(bytes, &mut i) { return false; }
        // Other file descriptors (e.g. 3>file or 1>file) are outside the allow-list.
        if bytes[start..i].iter().all(u8::is_ascii_digit) && bytes.get(i) == Some(&b'>') { return false; }
        if bytes.get(i).is_some_and(|c| !matches!(c, b' ' | b'\t' | b'>')) { return false; }
        has_word = true;
    }
    has_word
}

/// Classification/detail heuristic only: numeric status is gated separately by the allow-list.
/// Small lexical scan, not a shell parser: separates unquoted control operators without treating
/// quoted/escaped arguments, descriptor redirections or PowerShell's call operator as background.
/// Unsupported constructs stop the scan: their nested syntax could desynchronise the quote state.
fn command_segments(command: &str, powershell: bool) -> (Vec<&str>, bool, bool) {
    let bytes = command.as_bytes();
    let mut segments = Vec::new();
    let (mut start, mut i, mut quote, mut background) = (0, 0, None, false);
    let mut unmodelled = false;
    let mut previous_redirection = false;
    while i < bytes.len() {
        let c = bytes[i];
        let follows_redirection = std::mem::take(&mut previous_redirection);
        let escape = if powershell { b'`' } else { b'\\' };
        if c == escape && quote != Some(b'\'') {
            // Inside Bash double quotes a backslash only escapes these characters.
            let can_escape = powershell || quote.is_none()
                || bytes.get(i + 1).is_some_and(|next| matches!(next, b'$' | b'`' | b'"' | b'\\' | b'\n'));
            if can_escape {
                i += 2;
                continue;
            }
        }
        let next = bytes.get(i + 1).copied();
        let expansion = quote != Some(b'\'')
            && ((c == b'$' && next == Some(b'(')) || (!powershell && c == b'`'));
        let unquoted_construct = quote.is_none() && if powershell {
            matches!(c, b'{' | b'}') || (c == b'@' && matches!(next, Some(b'(' | b'"' | b'\'')))
        } else {
            (c == b'$' && next == Some(b'\''))
                || (matches!(c, b'<' | b'>') && next == Some(b'('))
                || (c == b'<' && next == Some(b'<'))
        };
        if expansion || unquoted_construct {
            unmodelled = true;
            break;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if matches!(c, b'\'' | b'"') {
            quote = Some(c);
            i += 1;
            continue;
        }
        let mut width = 1;
        let separator = match c {
            b';' | b'\n' => true,
            b'|' => {
                width += usize::from(bytes.get(i + 1) == Some(&b'|'));
                true
            }
            b'&' if bytes.get(i + 1) == Some(&b'&') => {
                width = 2;
                true
            }
            b'&' => {
                let redirection = follows_redirection
                    || (!powershell && bytes.get(i + 1) == Some(&b'>'));
                if redirection {
                    false
                } else if powershell && command[start..i].trim().is_empty() {
                    // Keep the call operator so classification can distinguish invocation from a string.
                    false
                } else {
                    background = true;
                    true
                }
            }
            _ => false,
        };
        if separator {
            segments.push(command[start..i].trim());
            start = i + width;
        }
        previous_redirection = matches!(c, b'>' | b'<');
        i += width;
    }
    segments.push(command[start..].trim());
    segments.retain(|s| !s.is_empty());
    (segments, background, unmodelled || quote.is_some())
}

/// Command class and program from a Bash command line. The command line itself is never kept.
pub fn classify_command(command: &str) -> (String, Option<String>, bool) {
    let (class, program, compound, background, unmodelled) = classify_for_tool(command, false);
    (class, program, compound || background || unmodelled || !simple_command_allowed(command, false))
}

fn classify_for_tool(command: &str, powershell: bool) -> (String, Option<String>, bool, bool, bool) {
    let (segments, background, unmodelled) = command_segments(command, powershell);
    // Any newline is outside the simple-command grammar, including newlines hidden by comment quotes.
    let compound = segments.len() > 1 || command.contains(['\n', '\r']);
    let words = |s: &str| -> Vec<String> {
        let mut remaining = s.trim_start();
        let called = powershell && remaining.starts_with('&');
        if called {
            remaining = remaining[1..].trim_start();
        }
        // Skip simple environment prefixes, but keep a quoted executable (including spaces) whole.
        while !remaining.is_empty() && !remaining.starts_with(['\'', '"']) {
            let end = remaining.find(char::is_whitespace).unwrap_or(remaining.len());
            let word = &remaining[..end];
            if !word.contains('=') || word.starts_with('-') {
                break;
            }
            remaining = remaining[end..].trim_start();
        }
        if remaining.is_empty() || (powershell && !called && remaining.starts_with(['\'', '"'])) {
            return Vec::new();
        }
        let end = if remaining.starts_with(['\'', '"']) {
            // An unmatched quote is already marked unmodelled by the scan above.
            remaining[1..].find(char::from(remaining.as_bytes()[0])).map(|i| i + 2).unwrap_or(remaining.len())
        } else {
            remaining.find(char::is_whitespace).unwrap_or(remaining.len())
        };
        let clean = |w: &str| w.trim_matches(['\'', '"']).to_lowercase();
        let mut first = clean(&remaining[..end]);
        if powershell {
            let name = first.rsplit(['/', '\\']).next().unwrap_or(&first);
            first = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()).map(|(stem, _)| stem).unwrap_or(name).into();
        }
        let mut words = vec![first];
        words.extend(remaining[end..].split_whitespace().map(clean));
        words
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
    (best.into(), program, compound, background, unmodelled)
}

/// "Exit code N" at the start of a command tool failure message.
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
            // Lifecycle payloads have no occurrence id: mint one per producer invocation, not per
            // session/source. Persisted inbox records retain this id when delivery/ingestion is retried.
            ("session.started", vec![], format!("start:{}", unique(ctx.now_ms)))
        }
        ("SessionEnd", _) => {
            // Kept as the hook reported it (a short enum such as `clear`, `logout`, `other`); only cut so an
            // unexpected value cannot make the whole record invalid.
            evidence.detail = text(payload, "reason").map(|r| r.chars().take(MAX_REASON_CHARS).collect());
            ("session.ended", vec![], format!("end:{}", unique(ctx.now_ms)))
        }
        ("Stop", _) => ("turn.ended", vec![], format!("stop:{}", text(payload, "prompt_id").map(str::to_owned).unwrap_or_else(|| unique(ctx.now_ms)))),
        ("PreToolUse", Some(t)) if EDIT_TOOLS.contains(&t) => ("file.edit.attempted", paths_of(file_path()), String::new()),
        ("PreToolUse" | "PostToolUse" | "PostToolUseFailure", Some(t @ ("Bash" | "PowerShell"))) => {
            let powershell = t == "PowerShell";
            let command = text(&input, "command").unwrap_or("");
            let (class, program, compound, syntax_background, _) = classify_for_tool(command, powershell);
            evidence.command_class = Some(class);
            evidence.program = program;
            let background = syntax_background || input.get("run_in_background").and_then(Value::as_bool).unwrap_or(false);
            let interrupted = payload.get("tool_response").and_then(|r| r.get("interrupted")).and_then(Value::as_bool).unwrap_or(false)
                || payload.get("is_interrupt").and_then(Value::as_bool).unwrap_or(false);
            // The tool's success/failure only reflects the check itself for a single, foreground, completed command.
            let result_reflects_command = !compound && !background && !interrupted && simple_command_allowed(command, powershell);
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
                    // Compound, background, interrupted or unmodelled syntax cannot establish the check's result.
                } else if event == "PostToolUse" {
                    // Captured Bash (2.1.286) and PowerShell (2.1.292): non-zero exits arrive as PostToolUseFailure.
                    evidence.exit_code = Some(0);
                    evidence.exit_code_source = Some("tool-success".into());
                } else if event == "PostToolUseFailure"
                    && let Some(code) = text(payload, "error").and_then(exit_code_from_error) {
                    evidence.exit_code = Some(code);
                    evidence.exit_code_source = Some("failure-message".into());
                }
                if evidence.exit_code.is_none() && evidence.detail.is_none() {
                    // Unsupported syntax or a failure without a parseable code establishes no numeric result.
                    evidence.detail = Some("result not established".into());
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
    const POWERSHELL_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude-code-2.1.292-powershell");

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
    fn parse_payload_accepts_the_supported_encodings_and_nothing_else() {
        let json = r#"{"hook_event_name":"Stop","reason":"é"}"#;
        let expected: Value = serde_json::from_str(json).unwrap();
        let le: Vec<u8> = json.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let be: Vec<u8> = json.encode_utf16().flat_map(u16::to_be_bytes).collect();
        assert_eq!(parse_payload(json.as_bytes()), Some(expected.clone()));
        assert_eq!(parse_payload(&[&[0xEF, 0xBB, 0xBF][..], json.as_bytes()].concat()), Some(expected.clone()));
        assert_eq!(parse_payload(&[&[0xFF, 0xFE][..], &le].concat()), Some(expected.clone()));
        assert_eq!(parse_payload(&[&[0xFE, 0xFF][..], &be].concat()), Some(expected));
        assert_eq!(parse_payload(&le), None, "UTF-16 without a BOM is not guessed");
        assert_eq!(parse_payload(&[&[0xFF, 0xFE][..], &le[..le.len() - 1]].concat()), None, "odd byte count");
        assert_eq!(parse_payload(&[0xFF, 0xFE, 0x00, 0xD8]), None, "lone surrogate");
        assert_eq!(parse_payload(&[&[0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF][..], json.as_bytes()].concat()), None);
        assert_eq!(parse_payload(&[]), None);
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
    fn allow_list_comments_and_newlines_never_establish_results() {
        for (tool, command, detail) in [
            ("Bash", "npm test # \"\necho \"ok\" # \"\n", "compound command"),
            ("Bash", "npm test # '\necho 'ok' # '\n", "compound command"),
            ("PowerShell", "npm test # \"\nWrite-Output \"ok\" # \"\n", "compound command"),
            ("PowerShell", "npm test <# \" #>\nWrite-Output \"ok\" <# \" #>\n", "compound command"),
            ("Bash", "npm test # comment", "result not established"),
            ("PowerShell", "npm test # comment", "result not established"),
            ("PowerShell", "npm test <# comment #>", "result not established"),
            ("Bash", "npm test 'line\nbreak'", "compound command"),
            ("PowerShell", "npm test \"line\r\nbreak\"", "compound command"),
        ] {
            for hook in ["PostToolUse", "PostToolUseFailure"] {
                let p = serde_json::json!({ "hook_event_name": hook, "tool_name": tool,
                    "tool_input": { "command": command }, "error": "Exit code 7\nfailed" });
                let e = normalize(&p, &ctx()).unwrap();
                assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{tool}: {command}");
                assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                    (None, None, Some(detail)), "{tool}: {command}");
            }
        }
    }

    #[test]
    fn non_ascii_commands_never_establish_results() {
        for tool in ["Bash", "PowerShell"] {
            for (command, program) in [
                (r#"node --test "a.test.cjs”; node -e “process.exit(0)""#, "node"),
                (r#"npm test "a”; Write-Output “ok""#, "npm"),
                ("npm test 'a’; Write-Output ‘ok'", "npm"),
                (r#"npm test -- --grep "café""#, "npm"),
                ("npm test café", "npm"),
                ("npm test '🧪'", "npm"),
                ("npm test > 'résultat.txt'", "npm"),
            ] {
                for hook in ["PostToolUse", "PostToolUseFailure"] {
                    let p = serde_json::json!({ "hook_event_name": hook, "tool_name": tool,
                        "tool_input": { "command": command }, "error": "Exit code 7\nfailed" });
                    let e = normalize(&p, &ctx()).unwrap();
                    assert_eq!(e.kind, "command.result");
                    assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{tool}: {command}");
                    assert_eq!(e.evidence.program.as_deref(), Some(program), "{tool}: {command}");
                    assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                        (None, None, Some("result not established")), "{hook} {tool}: {command}");
                    assert_eq!(e.validate(), Ok(()));
                }
            }
        }
    }

    #[test]
    fn non_ascii_commands_preserve_stronger_contract_details() {
        for tool in ["Bash", "PowerShell"] {
            for (command, background, interrupted, detail) in [
                ("npm test 'café'; echo ok", false, false, "compound command"),
                ("npm test 'café' &", false, false, "background command"),
                ("npm test 'café'", true, false, "background command"),
                ("npm test 'café'; echo ok", true, true, "interrupted"),
            ] {
                for hook in ["PostToolUse", "PostToolUseFailure"] {
                    let p = serde_json::json!({ "hook_event_name": hook, "tool_name": tool,
                        "tool_input": { "command": command, "run_in_background": background },
                        "is_interrupt": interrupted, "error": "Exit code 7\nfailed" });
                    let e = normalize(&p, &ctx()).unwrap();
                    assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                        (None, None, Some(detail)), "{hook} {tool}: {command}");
                    assert_eq!(e.validate(), Ok(()));
                }
            }
        }
    }

    #[test]
    fn powershell_leading_string_literals_are_not_checks_or_established_results() {
        for command in [r#""pytest""#, "'pytest'", r#""npm test""#, "'npm test'", r#""cargo test""#, "'cargo test'",
            r#" "pytest" -k "not slow" "#, "\t'npm' test", "'npm' test >file"] {
            for hook in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
                let p = serde_json::json!({ "hook_event_name": hook, "tool_name": "PowerShell",
                    "tool_input": { "command": command }, "error": "Exit code 7\nfailed" });
                let e = normalize(&p, &ctx()).unwrap();
                assert_eq!(e.evidence.command_class.as_deref(), Some("other"), "{hook}: {command}");
                assert_eq!(e.evidence.program, None, "{hook}: {command}");
                let detail = (hook != "PreToolUse").then_some("result not established");
                assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                    (None, None, detail), "{hook}: {command}");
                assert_eq!(e.validate(), Ok(()));
            }
        }
    }

    #[test]
    fn quoted_powershell_invocations_and_arguments_and_bash_command_words_still_work() {
        // In Bash a quoted first word IS an invocation; PowerShell requires `&` for that form.
        for (tool, command, program) in [
            ("PowerShell", r#"& "C:/x/node.exe" --test"#, "node"),
            ("PowerShell", "& 'npm.cmd' test", "npm"),
            ("PowerShell", r#"pytest -k "not slow""#, "pytest"),
            ("PowerShell", "pytest -k 'not slow'", "pytest"),
            ("Bash", r#""pytest""#, "pytest"),
            ("Bash", "'pytest'", "pytest"),
            ("Bash", r#""npm" test"#, "npm"),
            ("Bash", "'cargo' test", "cargo"),
        ] {
            for (hook, code, source) in [("PostToolUse", 0, "tool-success"), ("PostToolUseFailure", 7, "failure-message")] {
                let p = serde_json::json!({ "hook_event_name": hook, "tool_name": tool,
                    "tool_input": { "command": command }, "error": "Exit code 7\nfailed" });
                let e = normalize(&p, &ctx()).unwrap();
                assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{tool}: {command}");
                assert_eq!(e.evidence.program.as_deref(), Some(program), "{tool}: {command}");
                assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                    (Some(code), Some(source), None), "{hook} {tool}: {command}");
                assert_eq!(e.validate(), Ok(()));
            }
        }
    }

    #[test]
    fn powershell_compound_segments_distinguish_string_literals_from_invocations() {
        for (command, class) in [("echo done; 'pytest'", "other"), ("'npm test'; echo done", "other"),
            ("echo done; & 'npm.cmd' test", "test"), ("'pytest'; cargo build", "build")] {
            let p = serde_json::json!({ "hook_event_name": "PostToolUse", "tool_name": "PowerShell",
                "tool_input": { "command": command } });
            let e = normalize(&p, &ctx()).unwrap();
            assert_eq!(e.evidence.command_class.as_deref(), Some(class), "{command}");
            assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), (None, Some("compound command")), "{command}");
            assert_eq!(e.validate(), Ok(()));
        }
    }

    #[test]
    fn allow_list_only_accepts_supported_simple_command_forms() {
        for (tool, command, program) in [
            ("Bash", "npm test -- --runInBand", "npm"),
            ("Bash", "npx vitest run src/a.test.ts", "npx"),
            ("Bash", r#"pytest -k "not slow""#, "pytest"),
            ("Bash", "npm test >file >>file 2>&1 >&2 1>&2 2>file &>file", "npm"),
            ("PowerShell", "npm test >file >>file 2>&1 >&2 1>&2 2>file *>file *>&1", "npm"),
            ("PowerShell", r#"& "C:/Program Files/nodejs/node.exe" --test"#, "node"),
            ("PowerShell", r"& 'C:\x\npm.cmd' test", "npm"),
            ("Bash", r##"npm test "#" 'a;b' "x & y""##, "npm"),
            ("PowerShell", r##"npm test "#" 'a;b' "x & y""##, "npm"),
        ] {
            for (hook, code, source) in [("PostToolUse", 0, "tool-success"), ("PostToolUseFailure", 7, "failure-message")] {
                let p = serde_json::json!({ "hook_event_name": hook, "tool_name": tool,
                    "tool_input": { "command": command }, "error": "Exit code 7\nfailed" });
                let e = normalize(&p, &ctx()).unwrap();
                assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{command}");
                assert_eq!(e.evidence.program.as_deref(), Some(program), "{command}");
                assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                    (Some(code), Some(source), None), "{tool}: {command}");
            }
        }
    }

    #[test]
    fn allow_list_rejects_other_characters_and_redirections() {
        for tool in ["Bash", "PowerShell"] {
            for command in ["npm test $ARG", "npm test !", "npm test (argument)", "npm test {argument}", "npm test ?", "npm test *",
                "npm test [argument]", "npm test <file", "npm test 3>file", "npm test 2>&10", "npm test >", "npm test '$(literal)'",
                "npm test \"$ARG\"", "npm test '`literal`'", "npm test '!literal'", r#"npm test "a\b""#] {
                let p = serde_json::json!({ "hook_event_name": "PostToolUse", "tool_name": tool,
                    "tool_input": { "command": command } });
                let e = normalize(&p, &ctx()).unwrap();
                assert_eq!(e.evidence.exit_code, None, "{tool}: {command}");
                assert_eq!(e.evidence.exit_code_source, None, "{tool}: {command}");
                assert_eq!(e.evidence.detail.as_deref(), Some("result not established"), "{tool}: {command}");
            }
        }
    }

    #[test]
    fn bash_syntax_background_never_claims_the_checks_exit_code() {
        for command in ["npm test & wait", "npm test &", "npm test && echo done &"] {
            let mut p = fixture("17-PostToolUse-Bash.json");
            p["tool_input"]["command"] = serde_json::json!(command);
            let e = normalize(&p, &ctx()).unwrap();
            assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{command}");
            assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), (None, Some("background command")), "{command}");
            assert_eq!(e.evidence.exit_code_source, None);
        }
    }

    #[test]
    fn escaped_redirection_characters_do_not_mask_a_following_background_operator() {
        for (tool, command) in [("Bash", r"npm test \>& wait"), ("Bash", r"npm test \<& wait"), ("PowerShell", "npm test `>& wait")] {
            let p = serde_json::json!({ "hook_event_name": "PostToolUse", "tool_name": tool,
                "tool_input": { "command": command } });
            let e = normalize(&p, &ctx()).unwrap();
            assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), (None, Some("background command")), "{command}");
        }
    }

    #[test]
    fn bash_redirections_quotes_and_escapes_follow_the_allow_list() {
        for (command, allowed) in [
            ("npm test 2>&1", true), ("npm test > out.txt 2>&1", true), ("npm test >&2", true), ("npm test &> out.txt", true),
            ("npm test &>> out.txt", false), ("npm test <&0", false), (r#"npm test "a;b" 'x & y' "a|b""#, true),
            (r"npm test a\;b x\&y a\|b", false), (r#"npm test "a\";b""#, false),
        ] {
            let mut p = fixture("17-PostToolUse-Bash.json");
            p["tool_input"]["command"] = serde_json::json!(command);
            let e = normalize(&p, &ctx()).unwrap();
            let expected = if allowed { (Some(0), None) } else { (None, Some("result not established")) };
            assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), expected, "{command}");
            assert_eq!(classify_command(command).2, !allowed, "{command}");
        }
    }

    #[test]
    fn unquoted_control_segments_withhold_the_overall_shell_status() {
        for tool in ["Bash", "PowerShell"] {
            for command in ["npm test; echo done", "npm test | echo done", "npm test || echo done", "npm test && echo done", "npm test\necho done"] {
                let mut p = fixture("17-PostToolUse-Bash.json");
                p["tool_name"] = serde_json::json!(tool);
                p["tool_input"]["command"] = serde_json::json!(command);
                let e = normalize(&p, &ctx()).unwrap();
                assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), (None, Some("compound command")), "{tool}: {command}");
            }
        }
    }

    #[test]
    fn powershell_observations_and_results_keep_only_established_evidence() {
        for (hook, kind, code, source, detail) in [
            ("PreToolUse", "command.observed", None, None, None),
            ("PostToolUse", "command.result", Some(0), Some("tool-success"), None),
            ("PostToolUseFailure", "command.result", Some(1), Some("failure-message"), None),
        ] {
            let p = serde_json::json!({
                "hook_event_name": hook, "tool_name": "PowerShell", "tool_use_id": "ps-check",
                "session_id": "fixture-session", "tool_input": { "command": "npm test" },
                "error": "Exit code 1\nSENTINEL_OUTPUT", "tool_response": { "stdout": "SENTINEL_OUTPUT" }
            });
            let e = normalize(&p, &ctx()).unwrap();
            assert_eq!(e.kind, kind);
            assert_eq!(e.evidence.tool_name.as_deref(), Some("PowerShell"));
            assert_eq!(e.evidence.command_class.as_deref(), Some("test"));
            assert_eq!(e.evidence.program.as_deref(), Some("npm"));
            assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()), (code, source, detail));
            assert_eq!(e.validate(), Ok(()));
            assert!(!serde_json::to_string(&e).unwrap().contains("SENTINEL_"));
        }
    }

    #[test]
    fn captured_powershell_payloads_establish_single_checks_but_not_compound_checks() {
        for (name, kind, code, source, detail) in [
            ("01-PreToolUse.json", "command.observed", None, None, None),
            ("02-PostToolUse.json", "command.result", Some(0), Some("tool-success"), None),
            ("03-PreToolUse.json", "command.observed", None, None, None),
            ("04-PostToolUseFailure.json", "command.result", Some(1), Some("failure-message"), None),
            ("05-PreToolUse.json", "command.observed", None, None, Some("compound command")),
            ("06-PostToolUseFailure.json", "command.result", None, None, Some("compound command")),
            ("07-PreToolUse.json", "command.observed", None, None, Some("compound command")),
            ("08-PostToolUseFailure.json", "command.result", None, None, Some("compound command")),
        ] {
            let payload = parse_payload(&fs::read(format!("{POWERSHELL_FIXTURES}/{name}")).unwrap()).unwrap();
            let e = normalize(&payload, &ctx()).unwrap();
            assert_eq!(e.kind, kind, "{name}");
            assert_eq!(e.evidence.tool_name.as_deref(), Some("PowerShell"), "{name}");
            assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{name}");
            assert_eq!(e.evidence.program.as_deref(), Some("node"), "{name}");
            assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()), (code, source, detail), "{name}");
            assert_eq!(e.validate(), Ok(()), "{name}");
            let json = serde_json::to_string(&e).unwrap();
            for forbidden in ["pass.test.mjs", "fail.test.mjs", "redacted", "<path>", "transcript_path", "other_field_names"] {
                assert!(!json.contains(forbidden), "{name}: retained {forbidden}");
            }
        }
    }

    #[test]
    fn unmodelled_shell_syntax_never_establishes_a_check_result() {
        for (tool, command) in [
            ("Bash", r#"npm test "$(printf '"')" & wait"#),
            ("Bash", r"npm test $'it\'s' & wait"),
            ("Bash", "npm test $(printf argument)"),
            ("Bash", "npm test `printf argument`"),
            ("Bash", r#"npm test "`printf argument`""#),
            ("Bash", "npm test $'argument'"),
            ("Bash", "npm test <(printf argument)"),
            ("Bash", "npm test >(cat)"),
            ("Bash", "npm test <<EOF\nargument\nEOF"),
            ("Bash", "npm test 'unfinished"),
            ("Bash", "npm test \"unfinished"),
            ("PowerShell", "npm test $(Write-Output argument)"),
            ("PowerShell", r#"npm test "$(Write-Output 'argument')""#),
            ("PowerShell", "npm test @(1, 2)"),
            ("PowerShell", "npm test { Write-Output argument }"),
            ("PowerShell", "npm test }"),
            ("PowerShell", "npm test @\"\nargument\n\"@"),
            ("PowerShell", "npm test @'\nargument\n'@"),
            ("PowerShell", "npm test 'unfinished"),
            ("PowerShell", "npm test \"unfinished"),
        ] {
            for hook in ["PostToolUse", "PostToolUseFailure"] {
                let p = serde_json::json!({ "hook_event_name": hook, "tool_name": tool,
                    "tool_input": { "command": command }, "error": "Exit code 7\nfailed" });
                let e = normalize(&p, &ctx()).unwrap();
                assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{tool}: {command}");
                let detail = if command.contains(['\n', '\r']) { "compound command" } else { "result not established" };
                assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                    (None, None, Some(detail)), "{hook} {tool}: {command}");
                assert_eq!(e.validate(), Ok(()));
            }
        }
    }

    #[test]
    fn unmodelled_syntax_preserves_previously_established_contract_details() {
        for (command, background, interrupted, detail) in [
            ("npm test & echo $(argument)", false, false, "background command"),
            ("npm test; echo $(argument)", false, false, "compound command"),
            ("npm test $(argument)", true, false, "background command"),
            ("npm test $(argument)", true, true, "interrupted"),
        ] {
            let p = serde_json::json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash",
                "tool_input": { "command": command, "run_in_background": background }, "is_interrupt": interrupted });
            let e = normalize(&p, &ctx()).unwrap();
            assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                (None, None, Some(detail)), "{command}");
        }
    }

    #[test]
    fn literal_syntax_outside_the_allow_list_keeps_result_unknown() {
        for (tool, command) in [
            ("Bash", "npm test '$(x) `x` <(x) >(x) <<EOF'"),
            ("Bash", r#"npm test "\$(x) \`x\` $'literal' <(x) >(x) <<EOF""#),
            ("Bash", r"npm test \$literal \`literal\` \$\'literal\' \<literal \>literal \<\<EOF"),
            ("PowerShell", r#"npm test '$(x) @(x) {x} @"'"#),
            ("PowerShell", r#"npm test "`$(x) @(x) {x} @'""#),
        ] {
            let p = serde_json::json!({ "hook_event_name": "PostToolUse", "tool_name": tool,
                "tool_input": { "command": command } });
            let e = normalize(&p, &ctx()).unwrap();
            assert_eq!((e.evidence.exit_code, e.evidence.exit_code_source.as_deref(), e.evidence.detail.as_deref()),
                (None, None, Some("result not established")), "{tool}: {command}");
        }
    }

    #[test]
    fn powershell_call_operator_quotes_and_backticks_are_not_background() {
        for (command, program, allowed) in [
            (r#"& "C:/x/node.exe" --test"#, "node", true),
            ("& 'C:/x/node.exe' --test", "node", true),
            (r#"& "C:/Program Files/nodejs/node.exe" --test"#, "node", true),
            (r"& 'C:\x\npm.cmd' test", "npm", true),
            (r"& 'C:\Program Files\nodejs\npm.cmd' test", "npm", true),
            (r#"npm test "a;b" 'x & y'"#, "npm", true),
            ("npm test a`;b x`&y a`|b", "npm", false),
            (r#"npm test "a`";b""#, "npm", false),
            ("npm test 'it''s & quoted'", "npm", true),
            ("npm test 2>&1", "npm", true),
        ] {
            let p = serde_json::json!({ "hook_event_name": "PostToolUseFailure", "tool_name": "PowerShell",
                "tool_input": { "command": command }, "error": "Exit code 7\nfailed" });
            let e = normalize(&p, &ctx()).unwrap();
            let expected = if allowed { (Some(7), None) } else { (None, Some("result not established")) };
            assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), expected, "{command}");
            assert_eq!(e.evidence.program.as_deref(), Some(program), "{command}");
            assert_eq!(e.evidence.command_class.as_deref(), Some("test"), "{command}");
        }
        let p = serde_json::json!({ "hook_event_name": "PostToolUse", "tool_name": "PowerShell",
            "tool_input": { "command": "& 'C:/x/node.exe' --test &" } });
        let e = normalize(&p, &ctx()).unwrap();
        assert_eq!((e.evidence.exit_code, e.evidence.detail.as_deref()), (None, Some("background command")));
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
    fn lifecycle_occurrences_are_distinct_even_with_identical_payloads_and_clock() {
        for (name, detail) in [("01-SessionStart.json", "startup"), ("01-SessionStart.json", "resume"), ("19-SessionEnd.json", "other")] {
            let mut payload = fixture(name);
            if name == "01-SessionStart.json" {
                payload["source"] = serde_json::json!(detail);
            }
            let first = normalize(&payload, &ctx()).unwrap();
            let second = normalize(&payload, &ctx()).unwrap();
            assert_ne!(first.id, second.id, "{name}: {detail}");
            assert_eq!(first.session_id, second.session_id);
            assert_eq!(first.source_at, second.source_at, "fixed clock exercises within-process uniqueness");
            assert_eq!(first.evidence.detail.as_deref(), Some(detail));
            assert_eq!(second.evidence.detail.as_deref(), Some(detail));
            assert_eq!(first.validate(), Ok(()));
            assert_eq!(second.validate(), Ok(()));
        }
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
