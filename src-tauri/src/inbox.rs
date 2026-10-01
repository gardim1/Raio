//! The inbox: one small JSON file per minimised event, written by `raio-hook` and consumed by the app.
//! Writers create a temp file in `inbox/.tmp` and rename it into `inbox/` (same volume). Over the cap a
//! writer drops the event and leaves one marker file in `dropped/` (no shared counter to race on).
//! Ordinary files in the user's profile: any process of the same user can write here, so every record is
//! validated again on ingestion. This is not isolation.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use crate::event::RaioEvent;

pub const MAX_FILES: usize = 5_000;
pub const MAX_RECORD_BYTES: usize = 16 * 1024;
/// The hook is inert when the app has not run for this long (the connection is bounded in time).
pub const HEARTBEAT_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

pub struct Dirs {
    pub inbox: PathBuf,
    pub tmp: PathBuf,
    pub dropped: PathBuf,
    pub quarantine: PathBuf,
    pub heartbeat: PathBuf,
}

impl Dirs {
    pub fn new(data: &Path) -> Self {
        let inbox = data.join("inbox");
        Dirs {
            tmp: inbox.join(".tmp"),
            inbox,
            dropped: data.join("dropped"),
            quarantine: data.join("quarantine"),
            heartbeat: data.join("heartbeat"),
        }
    }

    pub fn create(&self) -> std::io::Result<()> {
        for d in [&self.inbox, &self.tmp, &self.dropped, &self.quarantine] {
            fs::create_dir_all(d)?;
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq)]
pub enum WriteOutcome {
    Written,
    Dropped(&'static str),
    Inert,
}

fn unique_name(id: &str) -> String {
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:024}-{}-{}.json", std::process::id(), &id[..id.len().min(12)])
}

fn mark_dropped(dirs: &Dirs, reason: &'static str) -> WriteOutcome {
    let _ = fs::create_dir_all(&dirs.dropped);
    let _ = fs::write(dirs.dropped.join(format!("{}-{reason}", unique_name("drop"))), b"");
    WriteOutcome::Dropped(reason)
}

pub fn heartbeat_fresh(dirs: &Dirs, now: SystemTime) -> bool {
    fs::metadata(&dirs.heartbeat)
        .and_then(|m| m.modified())
        .map(|t| now.duration_since(t).map(|age| age <= HEARTBEAT_MAX_AGE).unwrap_or(true))
        .unwrap_or(false)
}

pub fn touch_heartbeat(dirs: &Dirs) -> std::io::Result<()> {
    fs::write(&dirs.heartbeat, b"")
}

/// Writes one event atomically. Never panics; the caller always exits 0.
pub fn write(dirs: &Dirs, event: &RaioEvent) -> WriteOutcome {
    if !heartbeat_fresh(dirs, SystemTime::now()) {
        return WriteOutcome::Inert;
    }
    let Ok(bytes) = serde_json::to_vec(event) else { return mark_dropped(dirs, "unserialisable") };
    if bytes.len() > MAX_RECORD_BYTES {
        return mark_dropped(dirs, "oversize");
    }
    if dirs.create().is_err() {
        return mark_dropped(dirs, "no-inbox");
    }
    let pending = fs::read_dir(&dirs.inbox).map(|d| d.count()).unwrap_or(0);
    if pending >= MAX_FILES {
        return mark_dropped(dirs, "inbox-full");
    }
    let name = unique_name(&event.id);
    let tmp = dirs.tmp.join(&name);
    let written = fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(&bytes)?;
        f.sync_all()
    });
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
        return mark_dropped(dirs, "write-failed");
    }
    // Antivirus or indexers can briefly hold the file on Windows: bounded retry.
    for attempt in 0..5 {
        match fs::rename(&tmp, dirs.inbox.join(&name)) {
            Ok(()) => return WriteOutcome::Written,
            Err(_) if attempt < 4 => thread::sleep(Duration::from_millis(20 * (attempt + 1))),
            Err(_) => {}
        }
    }
    let _ = fs::remove_file(&tmp);
    mark_dropped(dirs, "rename-failed")
}

/// A pending inbox record (file path + parse result).
pub struct Pending {
    pub path: PathBuf,
    pub event: Result<RaioEvent, String>,
}

/// Pending records in write order (names start with a timestamp). Temp files are skipped.
pub fn pending(dirs: &Dirs, limit: usize) -> Vec<Pending> {
    let Ok(entries) = fs::read_dir(&dirs.inbox) else { return vec![] };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files.truncate(limit);
    files
        .into_iter()
        .map(|path| {
            let event = fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|b| if b.len() > MAX_RECORD_BYTES { Err("oversize".into()) } else { Ok(b) })
                .and_then(|b| serde_json::from_slice::<RaioEvent>(&b).map_err(|e| e.to_string()))
                .and_then(|e| e.validate().map(|_| e));
            Pending { path, event }
        })
        .collect()
}

/// Moves a minimised-but-invalid record aside (it never contains raw payloads).
pub fn quarantine(dirs: &Dirs, path: &Path) {
    let _ = fs::create_dir_all(&dirs.quarantine);
    if let Some(name) = path.file_name() {
        if fs::rename(path, dirs.quarantine.join(name)).is_err() {
            let _ = fs::remove_file(path);
        }
    }
}

pub fn dropped_count(dirs: &Dirs) -> usize {
    fs::read_dir(&dirs.dropped).map(|d| d.count()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{stable_id, Evidence};

    fn event(n: u32) -> RaioEvent {
        RaioEvent {
            schema: 1,
            id: stable_id(&["t", &n.to_string()]),
            source: "claude-hook".into(),
            provenance: "agent-reported".into(),
            attribution: "session".into(),
            project_id: "p".into(),
            session_id: Some("s".into()),
            agent: "claude".into(),
            subagent_id: None,
            source_at: Some(n as i64),
            observed_at: 0,
            seq: 0,
            kind: "turn.ended".into(),
            paths: vec![],
            evidence: Evidence::default(),
        }
    }

    fn fresh() -> (tempfile::TempDir, Dirs) {
        let dir = tempfile::tempdir().unwrap();
        let dirs = Dirs::new(dir.path());
        dirs.create().unwrap();
        touch_heartbeat(&dirs).unwrap();
        (dir, dirs)
    }

    #[test]
    fn writes_atomically_and_reads_back_in_order() {
        let (_d, dirs) = fresh();
        for n in 0..3 {
            assert_eq!(write(&dirs, &event(n)), WriteOutcome::Written);
        }
        let got: Vec<i64> = pending(&dirs, 10).into_iter().map(|p| p.event.unwrap().source_at.unwrap()).collect();
        assert_eq!(got, vec![0, 1, 2]);
        assert_eq!(fs::read_dir(&dirs.tmp).unwrap().count(), 0);
    }

    #[test]
    fn is_inert_without_a_recent_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = Dirs::new(dir.path());
        assert_eq!(write(&dirs, &event(1)), WriteOutcome::Inert);
        assert!(!dirs.inbox.exists());
    }

    #[test]
    fn drops_with_a_marker_when_full_or_oversize() {
        let (_d, dirs) = fresh();
        for i in 0..MAX_FILES {
            fs::write(dirs.inbox.join(format!("{i:08}.json")), b"{}").unwrap();
        }
        assert_eq!(write(&dirs, &event(1)), WriteOutcome::Dropped("inbox-full"));
        let big = RaioEvent { paths: vec!["x".repeat(400); 60], ..event(2) };
        assert_eq!(write(&dirs, &big), WriteOutcome::Dropped("oversize"));
        assert_eq!(dropped_count(&dirs), 2);
    }

    #[test]
    fn concurrent_writers_do_not_lose_or_merge_records() {
        let (_d, dirs) = fresh();
        let root = dirs.inbox.parent().unwrap().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let dirs = Dirs::new(&root);
                    for n in 0..25 {
                        assert_eq!(write(&dirs, &event(t * 100 + n)), WriteOutcome::Written);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let all = pending(&dirs, 1_000);
        assert_eq!(all.len(), 200);
        assert!(all.iter().all(|p| p.event.is_ok()));
    }

    #[test]
    fn invalid_or_truncated_records_are_reported_not_trusted() {
        let (_d, dirs) = fresh();
        fs::write(dirs.inbox.join("0001.json"), b"{\"schema\":1,\"id\":").unwrap();
        fs::write(dirs.inbox.join("0002.json"), serde_json::to_vec(&RaioEvent { kind: "rm -rf".into(), ..event(1) }).unwrap()).unwrap();
        let all = pending(&dirs, 10);
        assert!(all.iter().all(|p| p.event.is_err()));
        for p in &all {
            quarantine(&dirs, &p.path);
        }
        assert_eq!(pending(&dirs, 10).len(), 0);
        assert_eq!(fs::read_dir(&dirs.quarantine).unwrap().count(), 2);
    }
}
