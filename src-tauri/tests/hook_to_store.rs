//! Integration: the real `raio-hook` binary, fed the recorded Claude Code payloads on stdin, writes
//! inbox records that ingest into SQLite; no free-text content ever reaches disk.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use raio_lib::inbox::{self, Dirs};
use raio_lib::store::{Insert, Store};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude-code-2.1.286");

fn run_hook(data: &Path, stdin: &[u8]) -> (i32, Duration) {
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_raio-hook"))
        .args(["claude", "--project", "fixtureproject", "--root", "C:/fixture/acme-mini", "--raio-managed"])
        .env("RAIO_DATA_DIR", data)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let status = child.wait().unwrap();
    (status.code().unwrap_or(-1), started.elapsed())
}

fn all_bytes_under(dir: &Path) -> Vec<u8> {
    let mut out = vec![];
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let p = entry.path();
        if p.is_dir() {
            out.extend(all_bytes_under(&p));
        } else {
            out.extend(fs::read(&p).unwrap());
        }
    }
    out
}

#[test]
fn recorded_session_flows_from_hook_to_store_without_content() {
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();

    let mut names: Vec<_> = fs::read_dir(FIXTURES).unwrap().map(|e| e.unwrap().path()).collect();
    names.sort();
    for path in &names {
        let (code, took) = run_hook(data.path(), &fs::read(path).unwrap());
        assert_eq!(code, 0, "{}", path.display());
        assert!(took < Duration::from_secs(3), "{} took {took:?}", path.display());
    }
    // Garbage, truncated input and an unknown event must also exit 0 and write nothing.
    for junk in [&b"not json"[..], b"{\"hook_event_name\":\"PostToolUse\",\"tool", b"{\"hook_event_name\":\"BrandNewEvent\"}"] {
        assert_eq!(run_hook(data.path(), junk).0, 0);
    }

    let pending = inbox::pending(&dirs, 1000);
    assert_eq!(pending.len(), 17, "19 fixtures minus UserPromptSubmit and PreToolUse Read");
    let store = Store::open(&data.path().join("raio.db"), 0).unwrap();
    for p in &pending {
        assert!(matches!(store.insert(p.event.as_ref().unwrap(), 1).unwrap(), Insert::Inserted(_)));
        fs::remove_file(&p.path).unwrap();
    }
    // Replaying the same hook payloads (duplicate delivery) adds nothing.
    for path in &names {
        run_hook(data.path(), &fs::read(path).unwrap());
    }
    for p in inbox::pending(&dirs, 1000) {
        let inserted = store.insert(p.event.as_ref().unwrap(), 2).unwrap();
        // Session start/end and tool events have stable ids; Stop ids are per prompt and also stable.
        assert_eq!(inserted, Insert::Duplicate);
    }
    let events = store.project_events("fixtureproject").unwrap();
    assert_eq!(events.len(), 17);
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds.first(), Some(&"session.started"));
    assert_eq!(kinds.last(), Some(&"session.ended"));
    drop(store);

    let everything = all_bytes_under(data.path());
    let text = String::from_utf8_lossy(&everything);
    for forbidden in ["SENTINEL_", "process.exit", "acme-mini\\", "C:/fixture", "transcripts"] {
        assert!(!text.contains(forbidden), "found {forbidden:?} on disk");
    }
}

#[test]
fn hook_stays_inert_without_a_heartbeat() {
    let data = tempfile::tempdir().unwrap();
    let payload = fs::read(format!("{FIXTURES}/06-PostToolUse-Write.json")).unwrap();
    assert_eq!(run_hook(data.path(), &payload).0, 0);
    assert!(!data.path().join("inbox").exists());
}
