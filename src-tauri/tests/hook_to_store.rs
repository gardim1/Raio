//! Integration: the real `raio-hook` binary, fed the recorded Claude Code payloads on stdin, writes
//! inbox records that ingest into SQLite; no free-text content ever reaches disk.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Once;
use std::time::{Duration, Instant};

use raio_lib::inbox::{self, Dirs};
use raio_lib::store::{Insert, Store};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude-code-2.1.286");
const POWERSHELL_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude-code-2.1.292-powershell");

/// The first launch of a freshly linked `raio-hook.exe` can be slow (antivirus scan, cold file cache). The hook
/// exits at its own 2 s deadline whatever happens, so a cold start could make a test lose its record before
/// the hook wrote it. One unmeasured launch (inert: no heartbeat) warms the binary up before any test counts.
static WARM_UP: Once = Once::new();

fn run_hook(data: &Path, stdin: &[u8]) -> (i32, Duration) {
    WARM_UP.call_once(|| {
        let cold = tempfile::tempdir().unwrap();
        launch_hook(cold.path(), b"{}");
    });
    launch_hook(data, stdin)
}

fn launch_hook(data: &Path, stdin: &[u8]) -> (i32, Duration) {
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
        // The hook's own 2 s deadline is the real guarantee; this only catches a hang.
        assert!(took < Duration::from_secs(10), "{} took {took:?}", path.display());
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
fn captured_powershell_checks_flow_from_hook_to_store_without_raw_content() {
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    let store = Store::open(&data.path().join("raio.db"), 0).unwrap();
    for (name, kind, code, detail) in [
        ("01-PreToolUse.json", "command.observed", None, None),
        ("02-PostToolUse.json", "command.result", Some(0), None),
        ("03-PreToolUse.json", "command.observed", None, None),
        ("04-PostToolUseFailure.json", "command.result", Some(1), None),
        ("05-PreToolUse.json", "command.observed", None, Some("compound command")),
        ("06-PostToolUseFailure.json", "command.result", None, Some("compound command")),
        ("07-PreToolUse.json", "command.observed", None, Some("compound command")),
        ("08-PostToolUseFailure.json", "command.result", None, Some("compound command")),
    ] {
        assert_eq!(run_hook(data.path(), &fs::read(format!("{POWERSHELL_FIXTURES}/{name}")).unwrap()).0, 0, "{name}");
        let pending = inbox::pending(&dirs, 1000);
        assert_eq!(pending.len(), 1, "{name}");
        let event = pending[0].event.as_ref().unwrap();
        assert_eq!(event.kind, kind, "{name}");
        assert_eq!(event.evidence.tool_name.as_deref(), Some("PowerShell"), "{name}");
        assert_eq!(event.evidence.command_class.as_deref(), Some("test"), "{name}");
        assert_eq!((event.evidence.exit_code, event.evidence.detail.as_deref()), (code, detail), "{name}");
        assert!(matches!(store.insert(event, 1).unwrap(), Insert::Inserted(_)), "{name}");
        fs::remove_file(&pending[0].path).unwrap();
    }
    assert_eq!(store.project_events("fixtureproject").unwrap().len(), 8);
    drop(store);
    let everything = all_bytes_under(data.path());
    let text = String::from_utf8_lossy(&everything);
    for forbidden in ["pass.test.mjs", "fail.test.mjs", "redacted", "<path>", "transcript_path", "other_field_names"] {
        assert!(!text.contains(forbidden), "retained {forbidden} on disk");
    }
}

#[test]
fn hook_stays_inert_without_a_heartbeat() {
    let data = tempfile::tempdir().unwrap();
    let payload = fs::read(format!("{FIXTURES}/06-PostToolUse-Write.json")).unwrap();
    assert_eq!(run_hook(data.path(), &payload).0, 0);
    assert!(!data.path().join("inbox").exists());
    assert!(!data.path().join("dropped").exists(), "an inert hook is not a lost event: no marker");
}

fn utf16(text: &str, big_endian: bool, bom: bool) -> Vec<u8> {
    let mut out = vec![];
    if bom {
        out.extend(if big_endian { [0xFE, 0xFF] } else { [0xFF, 0xFE] });
    }
    for unit in text.encode_utf16() {
        out.extend(if big_endian { unit.to_be_bytes() } else { unit.to_le_bytes() });
    }
    out
}

fn prefixed(prefix: &[u8], body: &[u8]) -> Vec<u8> {
    [prefix, body].concat()
}

/// Runs every recorded fixture through the hook encoded by `encode`, in a fresh data dir, and returns
/// (records written to the inbox, drop markers by reason, all bytes on disk).
fn feed_all(encode: impl Fn(&[u8]) -> Vec<u8>) -> (usize, Vec<String>, Vec<u8>) {
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    let mut names: Vec<_> = fs::read_dir(FIXTURES).unwrap().map(|e| e.unwrap().path()).collect();
    names.sort();
    for path in &names {
        assert_eq!(run_hook(data.path(), &encode(&fs::read(path).unwrap())).0, 0, "{}", path.display());
    }
    let dropped = fs::read_dir(data.path().join("dropped"))
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    (inbox::pending(&dirs, 1000).len(), dropped, all_bytes_under(data.path()))
}

/// Every record is either in the inbox or counted as dropped because the hook's 2 s hard deadline hit first
/// (a slow machine); it is never silently missing, and nothing else may be dropped.
fn assert_all_accounted(written: usize, dropped: &[String], expected: usize, what: &str) {
    assert!(dropped.iter().all(|d| d.ends_with("-hard-deadline")), "{what}: unexpected drops {dropped:?}");
    assert_eq!(written + dropped.len(), expected, "{what}: written {written} + dropped {dropped:?}");
}

#[test]
fn utf8_with_a_bom_is_accepted_like_plain_utf8() {
    // What a .NET/PowerShell pipe delivers (PERF-1): EF BB BF before the opening brace.
    let (written, dropped, _) = feed_all(|b| prefixed(&[0xEF, 0xBB, 0xBF], b));
    assert_all_accounted(written, &dropped, 17, "same 17 records as the BOM-less run");
}

#[test]
fn utf16_with_a_bom_is_decoded_in_both_byte_orders() {
    for big_endian in [false, true] {
        let (written, dropped, on_disk) = feed_all(|b| utf16(std::str::from_utf8(b).unwrap(), big_endian, true));
        assert_all_accounted(written, &dropped, 17, &format!("big_endian={big_endian}"));
        assert!(!String::from_utf8_lossy(&on_disk).contains("SENTINEL_"), "no raw payload on disk");
    }
}

#[test]
fn undecodable_input_is_dropped_counted_and_never_written_raw() {
    let body = fs::read(format!("{FIXTURES}/06-PostToolUse-Write.json")).unwrap();
    let text = std::str::from_utf8(&body).unwrap();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("utf16-le-without-bom", utf16(text, false, false)),
        ("utf16-be-without-bom", utf16(text, true, false)),
        ("utf32-le-bom", prefixed(&[0xFF, 0xFE, 0x00, 0x00], &body)),
        ("latin1-byte-in-json", prefixed(b"{\"hook_event_name\":\"Stop\",\"x\":\"\xE9\"}", b"")),
        ("odd-length-utf16", prefixed(&[0xFF, 0xFE], &utf16(text, false, false)[..7])),
        ("lone-surrogate-utf16", prefixed(&[0xFF, 0xFE, 0x00, 0xD8], b"")),
        ("double-bom", prefixed(&[0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF], &body)),
        ("bom-only", vec![0xEF, 0xBB, 0xBF]),
        ("empty", vec![]),
    ];
    for (name, bytes) in cases {
        let data = tempfile::tempdir().unwrap();
        let dirs = Dirs::new(data.path());
        dirs.create().unwrap();
        inbox::touch_heartbeat(&dirs).unwrap();
        assert_eq!(run_hook(data.path(), &bytes).0, 0, "{name}");
        assert_eq!(inbox::pending(&dirs, 10).len(), 0, "{name}: nothing may be recorded");
        let dropped: Vec<String> = fs::read_dir(data.path().join("dropped")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(dropped.len(), 1, "{name}: counted exactly once, got {dropped:?}");
        assert!(dropped[0].ends_with("unreadable-payload"), "{name}: {dropped:?}");
        assert!(!String::from_utf8_lossy(&all_bytes_under(data.path())).contains("SENTINEL_"), "{name}: raw stdin written");
    }
}

/// Markers left in the data dir's `dropped/`, by reason suffix.
fn markers(dirs: &Dirs) -> Vec<String> {
    fs::read_dir(&dirs.dropped).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
}

/// Spawns the hook with a silent open stdin and the given environment (debug builds only honour the seams).
#[cfg(debug_assertions)]
fn hook_waiting_on_silent_stdin_with(data: &Path, envs: &[(&str, &str)]) -> (Option<i32>, Duration) {
    let started = Instant::now();
    let mut command = Command::new(env!("CARGO_BIN_EXE_raio-hook"));
    command
        .args(["claude", "--project", "fixtureproject", "--root", "C:/fixture/acme-mini", "--raio-managed"])
        .env("RAIO_DATA_DIR", data)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
    let _open_stdin = child.stdin.take().unwrap();
    let status = child.wait().unwrap();
    (status.code(), started.elapsed())
}

#[cfg(debug_assertions)]
fn hook_waiting_on_silent_stdin(data: &Path, hard_deadline_ms: &str) -> (Option<i32>, Duration) {
    hook_waiting_on_silent_stdin_with(data, &[("RAIO_HOOK_HARD_DEADLINE_MS", hard_deadline_ms)])
}

// The deadline override exists in debug builds only (`cargo test --release` would not honour it).
#[cfg(debug_assertions)]
#[test]
fn the_hard_deadline_leaves_a_drop_marker_instead_of_vanishing() {
    // stdin stays open and silent, so the hook is still waiting for its payload when the watchdog fires.
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    let _ = run_hook(tempfile::tempdir().unwrap().path(), b"{}"); // warm-up, as for the other tests
    let (code, took) = hook_waiting_on_silent_stdin(data.path(), "250");
    assert_eq!(code, Some(0));
    assert!(took < Duration::from_secs(10), "{took:?}");
    let dropped = markers(&dirs);
    // Load-insensitive: the watchdog (250 ms) should beat the 1.5 s stdin timeout; if a very slow machine lets the
    // stdin timeout win, that is still exactly one marker, but this test is about the watchdog's.
    assert_eq!(dropped.len(), 1, "{dropped:?}");
    assert!(!dropped[0].ends_with("stdin-timeout"), "the stdin timeout won the race on this machine: {dropped:?}");
    assert!(dropped[0].ends_with("-hard-deadline"), "{dropped:?}");
    assert_eq!(inbox::pending(&dirs, 10).len(), 0);
}

#[cfg(debug_assertions)]
#[test]
fn an_invocation_leaves_one_marker_even_when_the_stdin_timeout_and_the_watchdog_collide() {
    // Both fire at about 1.5 s; whichever claims first writes the only marker.
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    let _ = run_hook(tempfile::tempdir().unwrap().path(), b"{}");
    for _ in 0..3 {
        let _ = fs::remove_dir_all(&dirs.dropped);
        let (code, _) = hook_waiting_on_silent_stdin(data.path(), "1500");
        assert_eq!(code, Some(0));
        let dropped = markers(&dirs);
        assert_eq!(dropped.len(), 1, "{dropped:?}");
        assert!(dropped[0].ends_with("stdin-timeout") || dropped[0].ends_with("hard-deadline"), "{dropped:?}");
    }
}

#[cfg(debug_assertions)]
#[test]
fn a_stuck_marker_write_cannot_keep_the_hook_alive_past_deadline_plus_grace() {
    // The watchdog's marker write is stalled for 10 s (a stuck filesystem). The hook must still exit by itself:
    // deadline 250 ms + 300 ms grace + margin. Generous bound (5 s) so machine load cannot make it flaky, yet far
    // below the stall.
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    let _ = run_hook(tempfile::tempdir().unwrap().path(), b"{}");
    let (code, took) = hook_waiting_on_silent_stdin_with(data.path(), &[("RAIO_HOOK_HARD_DEADLINE_MS", "250"), ("RAIO_HOOK_STALL_MARKER_MS", "10000")]);
    assert_eq!(code, Some(0));
    assert!(took < Duration::from_secs(5), "the hook hung on a stuck marker write: {took:?}");
    assert!(markers(&dirs).is_empty(), "the stalled marker could not have been written: {:?}", markers(&dirs));
}

#[cfg(debug_assertions)]
#[test]
fn a_hook_stuck_before_the_heartbeat_check_is_accounted_for_when_the_deadline_hits() {
    // The heartbeat stat hangs for 3 s; the deadline (250 ms) arrives while the hook is already past its argument
    // check, so the lost event leaves a marker. Only argument parsing is uncovered.
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    let _ = run_hook(tempfile::tempdir().unwrap().path(), b"{}");
    let (code, took) = hook_waiting_on_silent_stdin_with(data.path(), &[("RAIO_HOOK_HARD_DEADLINE_MS", "250"), ("RAIO_HOOK_STALL_HEARTBEAT_MS", "3000")]);
    assert_eq!(code, Some(0));
    assert!(took < Duration::from_secs(5), "{took:?}");
    let dropped = markers(&dirs);
    assert_eq!(dropped.len(), 1, "{dropped:?}");
    assert!(dropped[0].ends_with("-hard-deadline"), "{dropped:?}");
}
