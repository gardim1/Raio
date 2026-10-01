//! `raio-hook`: the command Claude Code runs (asynchronously) for each configured hook.
//! Reads the payload from stdin, keeps only minimised fields, writes one inbox record and exits 0.
//! It never blocks or fails the agent: bounded input, a hard deadline, and exit code 0 on every path.

use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use raio_lib::{claude, inbox, paths};

const MAX_STDIN: u64 = 4 * 1024 * 1024;
const READ_DEADLINE: Duration = Duration::from_millis(1500);
const HARD_DEADLINE: Duration = Duration::from_secs(2);

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("claude") {
        return;
    }
    let (Some(project_id), Some(root)) = (arg(&args, "--project"), arg(&args, "--root")) else { return };
    let Some(data) = paths::data_dir() else { return };
    let dirs = inbox::Dirs::new(&data);
    if !inbox::heartbeat_fresh(&dirs, SystemTime::now()) {
        return; // Raio has not run recently: stay inert instead of filling the inbox.
    }

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::stdin().take(MAX_STDIN).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let Ok(bytes) = rx.recv_timeout(READ_DEADLINE) else { return };
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return };
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let root = PathBuf::from(root);
    let ctx = claude::Context { project_id: &project_id, root: &root, now_ms };
    if let Some(event) = claude::normalize(&payload, &ctx) {
        let _ = inbox::write(&dirs, &event);
    }
}

fn main() {
    thread::spawn(|| {
        thread::sleep(HARD_DEADLINE);
        std::process::exit(0);
    });
    let _ = std::panic::catch_unwind(run);
    std::process::exit(0);
}
