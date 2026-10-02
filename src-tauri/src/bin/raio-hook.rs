//! `raio-hook`: the command Claude Code runs (asynchronously) for each configured hook.
//! Reads the payload from stdin, keeps only minimised fields, writes one inbox record and exits 0.
//! It never blocks or fails the agent: bounded input, a hard deadline, and exit code 0 on every path. The whole
//! run is bounded by the deadline (2 s) plus a short grace (300 ms) even when the filesystem is stuck.

use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use raio_lib::hook_guard::{Expiry, Guard};
use raio_lib::{claude, inbox, paths};

const MAX_STDIN: u64 = 4 * 1024 * 1024;
const READ_DEADLINE: Duration = Duration::from_millis(1500);
const HARD_DEADLINE: Duration = Duration::from_secs(2);
/// How long a write that is already in flight, or the watchdog's own marker, may take after the hard deadline.
const WRITE_GRACE: Duration = Duration::from_millis(300);
/// What the main thread adds to the grace before it exits on its own if the watchdog never ends the process.
const EXIT_MARGIN: Duration = Duration::from_millis(100);

/// The hard deadline. Debug builds (the integration tests) may shorten it with `RAIO_HOOK_HARD_DEADLINE_MS`;
/// release builds ignore the variable.
fn hard_deadline() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("RAIO_HOOK_HARD_DEADLINE_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        return Duration::from_millis(ms);
    }
    HARD_DEADLINE
}

/// Test seam, debug builds only: pretend a filesystem call is stuck for `$var` milliseconds. Release builds
/// compile it to nothing.
fn stall(var: &str) {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var(var).ok().and_then(|v| v.parse::<u64>().ok()) {
        thread::sleep(Duration::from_millis(ms));
    }
    #[cfg(not(debug_assertions))]
    let _ = var;
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// The one allowed marker of this invocation: skipped when the watchdog (or an earlier write) got there first.
fn drop_event(dirs: &inbox::Dirs, guard: &Guard, reason: &'static str) {
    if guard.claim() {
        inbox::mark_dropped(dirs, reason);
    }
}

fn run(dirs: &inbox::Dirs, guard: &Guard) {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("claude") {
        return;
    }
    let (Some(project_id), Some(root)) = (arg(&args, "--project"), arg(&args, "--root")) else { return };
    // From here on, losing the event is a drop that must leave a marker: even a heartbeat check that hangs on a
    // stuck filesystem is covered. Only argument parsing, above, is not.
    guard.arm();
    stall("RAIO_HOOK_STALL_HEARTBEAT_MS");
    if !inbox::heartbeat_fresh(dirs, SystemTime::now()) {
        guard.finish(); // Raio has not run recently: stay inert instead of filling the inbox; nothing was lost
        return;
    }

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::stdin().take(MAX_STDIN).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let Ok(bytes) = rx.recv_timeout(READ_DEADLINE) else {
        drop_event(dirs, guard, "stdin-timeout");
        return;
    };
    if bytes.len() as u64 >= MAX_STDIN {
        drop_event(dirs, guard, "stdin-too-large");
        return;
    }
    let Some(payload) = claude::parse_payload(&bytes) else {
        drop_event(dirs, guard, "unreadable-payload");
        return;
    };
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let root = PathBuf::from(root);
    let ctx = claude::Context { project_id: &project_id, root: &root, now_ms };
    match claude::normalize(&payload, &ctx) {
        // If the watchdog already left its drop marker, writing now would count the event twice.
        Some(event) => {
            if guard.claim() {
                let _ = inbox::write(dirs, &event);
            }
        }
        None => {
            guard.finish(); // an event Raio does not record: nothing was lost
        }
    }
}

fn main() {
    // Built before the watchdog starts, so the watchdog can leave a marker without touching anything else.
    let dirs = Arc::new(paths::data_dir().map(|data| inbox::Dirs::new(&data)));
    let guard = Arc::new(Guard::default());
    let deadline = hard_deadline();
    {
        let (dirs, guard) = (dirs.clone(), guard.clone());
        thread::spawn(move || {
            thread::sleep(deadline);
            match guard.expire() {
                Expiry::Drop => {
                    // On a helper thread, so a stuck filesystem cannot keep the hook alive: the marker gets the
                    // same short grace as any write, then the process exits regardless (marker lost, by design).
                    let (written, done) = mpsc::channel();
                    let dirs = dirs.clone();
                    thread::spawn(move || {
                        stall("RAIO_HOOK_STALL_MARKER_MS");
                        if let Some(dirs) = dirs.as_ref() {
                            inbox::mark_dropped(dirs, "hard-deadline");
                        }
                        let _ = written.send(());
                    });
                    let _ = done.recv_timeout(WRITE_GRACE);
                }
                Expiry::Grace => thread::sleep(WRITE_GRACE),
                Expiry::Finished => {}
            }
            std::process::exit(0);
        });
    }
    if let Some(dirs) = dirs.as_ref()
        && std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(dirs, &guard))).is_err()
    {
        drop_event(dirs, &guard, "panic");
    }
    if guard.finish() {
        // The watchdog took the event and is writing its marker: it ends the process when it is done (within
        // the grace). Wait for that, but never longer than grace + margin: this thread exits by itself then.
        let give_up = Instant::now() + WRITE_GRACE + EXIT_MARGIN;
        while let Some(left) = give_up.checked_duration_since(Instant::now()) {
            thread::park_timeout(left);
        }
    }
    std::process::exit(0);
}
