//! Synthetic inputs only: never launches Claude Code or reads its settings/account.
use raio_lib::inbox::{self, Dirs};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn launch(data: &Path, args: &[&str], input: &[u8]) {
    let root = data.join("project");
    let args: Vec<_> = args
        .iter()
        .map(|a| {
            if *a == "C:/fixture" {
                root.to_string_lossy().into_owned()
            } else {
                (*a).to_string()
            }
        })
        .collect();
    let mut child = Command::new(env!("CARGO_BIN_EXE_raio-hook"))
        .args(args)
        .env("RAIO_DATA_DIR", data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(input);
    let result = child.wait_with_output().unwrap();
    assert_eq!(result.status.code(), Some(0));
    assert!(result.stdout.is_empty() && result.stderr.is_empty());
}
fn connect_fixture(data: &Path) {
    let root = data.join("project");
    let settings = root.join(".claude/settings.local.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let hook = raio_lib::connect::hook_command(
        Path::new(env!("CARGO_BIN_EXE_raio-hook")),
        "fixtureproject",
        &root,
    );
    let command = raio_lib::usage_connect::command(&hook).unwrap();
    fs::write(
        settings,
        serde_json::json!({"statusLine":{"type":"command","command":command}}).to_string(),
    )
    .unwrap();
}
fn files(dir: &Path) -> Vec<Vec<u8>> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|e| {
            if e.path().is_dir() {
                files(&e.path())
            } else {
                vec![fs::read(e.path()).unwrap()]
            }
        })
        .collect()
}
const ARGS: &[&str] = &[
    "statusline",
    "--project",
    "fixtureproject",
    "--root",
    "C:/fixture",
    "--raio-managed",
];
const INPUT: &[u8] = br#"{"session_id":"synthetic-session","version":"2.1.294","cwd":"PRIVATE_CWD","transcript_path":"PRIVATE_TRANSCRIPT","cost":{"total_cost_usd":123},"rate_limits":{"five_hour":{"used_percentage":0,"resets_at":1791450000},"seven_day":{"used_percentage":100,"resets_at":1791950000}}}"#;

#[test]
fn statusline_persists_only_allowlisted_usage_without_inbox_history() {
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    connect_fixture(data.path());
    launch(data.path(), ARGS, INPUT);
    let snapshots = files(&data.path().join("usage"));
    assert_eq!(snapshots.len(), 1, "one per-source snapshot");
    let value: serde_json::Value = serde_json::from_slice(&snapshots[0]).unwrap();
    assert_eq!(value["fiveHour"]["usedPercentage"].as_f64(), Some(0.0));
    assert_eq!(value["sevenDay"]["usedPercentage"].as_f64(), Some(100.0));
    assert_eq!(value["fiveHour"]["resetsAtMs"], 1791450000000_i64);
    assert_eq!(value["source"]["claudeVersion"], "2.1.294");
    for forbidden in ["PRIVATE", "cwd", "transcript", "cost", "C:/fixture"] {
        assert!(!String::from_utf8_lossy(&snapshots[0]).contains(forbidden));
    }
    assert!(inbox::pending(&dirs, 100).is_empty());
    assert_eq!(inbox::drop_accounting(&dirs).count, 0);
}

#[test]
fn statusline_is_inert_for_stale_heartbeat_foreign_args_and_oversize_input() {
    let data = tempfile::tempdir().unwrap();
    launch(data.path(), ARGS, INPUT);
    assert!(!data.path().join("usage").exists());
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    connect_fixture(data.path());
    fs::File::options()
        .write(true)
        .open(&dirs.heartbeat)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
        .unwrap();
    launch(data.path(), ARGS, INPUT);
    assert!(!data.path().join("usage").exists());
    inbox::touch_heartbeat(&dirs).unwrap();
    for args in [
        &ARGS[..5],
        &[
            "statusline",
            "--project",
            "../foreign",
            "--root",
            "C:/fixture",
            "--raio-managed",
        ],
        &[
            "statusline",
            "--project",
            "p",
            "--root",
            "C:/fixture",
            "--raio-managed",
            "extra",
        ],
    ] {
        launch(data.path(), args, INPUT);
    }
    launch(data.path(), ARGS, &vec![b' '; 256 * 1024 + 1]);
    assert!(!data.path().join("usage").exists());
    assert_eq!(inbox::drop_accounting(&dirs).count, 0);
}

#[test]
fn a_running_session_stops_collecting_after_project_opt_out() {
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    connect_fixture(data.path());
    launch(data.path(), ARGS, INPUT);
    assert_eq!(files(&data.path().join("usage")).len(), 1);
    fs::remove_file(data.path().join("project/.claude/settings.local.json")).unwrap();
    launch(
        data.path(),
        ARGS,
        br#"{"session_id":"after-opt-out","rate_limits":{"five_hour":{"used_percentage":1}}}"#,
    );
    assert_eq!(
        files(&data.path().join("usage")).len(),
        1,
        "old Claude sessions cannot keep collecting after opt-out"
    );
}

#[test]
fn statusline_deadline_exits_silently_without_an_event_drop_marker() {
    let data = tempfile::tempdir().unwrap();
    let dirs = Dirs::new(data.path());
    dirs.create().unwrap();
    inbox::touch_heartbeat(&dirs).unwrap();
    let started = std::time::Instant::now();
    let result = Command::new(env!("CARGO_BIN_EXE_raio-hook"))
        .args(ARGS)
        .env("RAIO_DATA_DIR", data.path())
        .env("RAIO_HOOK_HARD_DEADLINE_MS", "100")
        .env("RAIO_HOOK_STALL_HEARTBEAT_MS", "2000")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(0));
    assert!(result.stdout.is_empty() && result.stderr.is_empty());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert!(!data.path().join("usage").exists());
    assert_eq!(inbox::drop_accounting(&dirs).count, 0);
}
