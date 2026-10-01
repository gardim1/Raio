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

/// Leaves one marker per dropped event (no shared counter to race on); the app shows the count.
pub fn mark_dropped(dirs: &Dirs, reason: &'static str) -> WriteOutcome {
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

/// Bounds for one housekeeping pass.
#[derive(Clone, Debug)]
pub struct Policy {
    /// Writer temp files older than this are orphans of a crashed hook.
    pub tmp_max_age: Duration,
    /// Pending events older than this are dropped (with a `expired` marker each), not ingested late.
    pub ttl: Duration,
    /// `dropped/` and `quarantine/` entries older than this are removed.
    pub marker_max_age: Duration,
    /// ... and only the newest this many are kept in each of them.
    pub marker_max_count: usize,
    /// Directory entries examined per directory per pass; the rest waits for the next pass.
    pub budget: usize,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            tmp_max_age: Duration::from_secs(3600),
            // Longer than the hook's inertness window: anything the hook could still write while Raio was
            // closed (heartbeat younger than HEARTBEAT_MAX_AGE) is ingested on the next start, not expired.
            ttl: HEARTBEAT_MAX_AGE + Duration::from_secs(24 * 3600),
            marker_max_age: Duration::from_secs(14 * 24 * 3600),
            marker_max_count: 1_000,
            budget: 2_000,
        }
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub tmp_removed: usize,
    pub expired: usize,
    pub markers_removed: usize,
}

/// Files directly inside `dir` (at most `budget`), each with its modification time.
fn aged_files(dir: &Path, budget: usize, only_json: bool) -> Vec<(PathBuf, SystemTime)> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    entries
        .filter_map(Result::ok)
        .take(budget)
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            let path = e.path();
            (!only_json || path.extension().is_some_and(|x| x == "json")).then_some(())?;
            Some((path, meta.modified().ok()?))
        })
        .collect()
}

fn older_than(now: SystemTime, modified: SystemTime, limit: Duration) -> bool {
    now.duration_since(modified).is_ok_and(|age| age > limit)
}

/// One bounded housekeeping pass: orphaned writer temp files, old and excess `dropped/` and
/// `quarantine/` markers, then pending events past their TTL (each leaves an `expired` marker, so the
/// loss is counted). Never fails: anything it cannot remove is retried by the next pass.
pub fn tidy(dirs: &Dirs, now: SystemTime, policy: &Policy) -> Report {
    let mut report = Report::default();
    for (path, modified) in aged_files(&dirs.tmp, policy.budget, false) {
        if older_than(now, modified, policy.tmp_max_age) && fs::remove_file(path).is_ok() {
            report.tmp_removed += 1;
        }
    }
    // Markers first, so the `expired` markers written below cannot be pruned in the pass that made them.
    for dir in [&dirs.dropped, &dirs.quarantine] {
        let mut files = aged_files(dir, policy.budget, false);
        files.sort_by_key(|f| std::cmp::Reverse(f.1)); // newest first
        for (i, (path, modified)) in files.into_iter().enumerate() {
            if (i >= policy.marker_max_count || older_than(now, modified, policy.marker_max_age)) && fs::remove_file(path).is_ok() {
                report.markers_removed += 1;
            }
        }
    }
    for (path, modified) in aged_files(&dirs.inbox, policy.budget, true) {
        if older_than(now, modified, policy.ttl) && fs::remove_file(path).is_ok() {
            mark_dropped(dirs, "expired");
            report.expired += 1;
        }
    }
    report
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

    fn age(path: &Path, by: Duration) {
        let when = SystemTime::now() - by;
        fs::File::options().write(true).open(path).unwrap().set_modified(when).unwrap();
    }

    const HOUR: Duration = Duration::from_secs(3600);
    const DAY: Duration = Duration::from_secs(24 * 3600);

    #[test]
    fn removes_orphaned_temp_files_but_not_a_writer_in_progress() {
        let (_d, dirs) = fresh();
        let (old, young) = (dirs.tmp.join("old.json"), dirs.tmp.join("young.json"));
        fs::write(&old, b"{").unwrap();
        fs::write(&young, b"{").unwrap();
        age(&old, 2 * HOUR);
        let report = tidy(&dirs, SystemTime::now(), &Policy::default());
        assert_eq!(report, Report { tmp_removed: 1, ..Report::default() });
        assert!(!old.exists() && young.exists());
    }

    #[test]
    fn expired_pending_events_are_dropped_with_a_counted_marker_never_silently() {
        let (_d, dirs) = fresh();
        for n in 0..3 {
            assert_eq!(write(&dirs, &event(n)), WriteOutcome::Written);
        }
        let mut files: Vec<_> = fs::read_dir(&dirs.inbox).unwrap().filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_file()).collect();
        files.sort();
        age(&files[0], 9 * DAY);
        age(&files[1], 9 * DAY);
        let before = dropped_count(&dirs);
        let report = tidy(&dirs, SystemTime::now(), &Policy::default());
        assert_eq!(report.expired, 2);
        assert_eq!(dropped_count(&dirs), before + 2, "every expired event leaves a marker");
        let left: Vec<_> = pending(&dirs, 10).into_iter().map(|p| p.event.unwrap().source_at.unwrap()).collect();
        assert_eq!(left.len(), 1);
        let markers: Vec<String> = fs::read_dir(&dirs.dropped).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(markers.iter().all(|m| m.ends_with("-expired")), "{markers:?}");
    }

    #[test]
    fn events_inside_the_ttl_are_left_alone() {
        let (_d, dirs) = fresh();
        assert_eq!(write(&dirs, &event(1)), WriteOutcome::Written);
        let file = fs::read_dir(&dirs.inbox).unwrap().filter_map(Result::ok).map(|e| e.path()).find(|p| p.is_file()).unwrap();
        age(&file, 6 * DAY); // e.g. Raio closed for most of a week: still ingested
        assert_eq!(tidy(&dirs, SystemTime::now(), &Policy::default()), Report::default());
        assert_eq!(pending(&dirs, 10).len(), 1);
    }

    #[test]
    fn old_markers_go_by_age_and_the_rest_are_capped_to_the_newest() {
        let (_d, dirs) = fresh();
        let policy = Policy { marker_max_count: 3, ..Policy::default() };
        for i in 0..6 {
            let p = dirs.dropped.join(format!("d{i}"));
            fs::write(&p, b"").unwrap();
            age(&p, Duration::from_secs(60 * (6 - i))); // d5 is the newest
        }
        let ancient = dirs.dropped.join("ancient");
        fs::write(&ancient, b"").unwrap();
        age(&ancient, 30 * DAY);
        for i in 0..5 {
            let p = dirs.quarantine.join(format!("q{i}.json"));
            fs::write(&p, b"{}").unwrap();
            age(&p, Duration::from_secs(60 * (5 - i)));
        }
        let report = tidy(&dirs, SystemTime::now(), &policy);
        assert_eq!(report.markers_removed, 1 + 3 + 2);
        let mut kept: Vec<String> = fs::read_dir(&dirs.dropped).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(kept, ["d3", "d4", "d5"]);
        assert_eq!(fs::read_dir(&dirs.quarantine).unwrap().count(), 3);
    }

    #[test]
    fn a_pass_is_bounded_and_the_next_pass_finishes_the_work() {
        let (_d, dirs) = fresh();
        let policy = Policy { budget: 10, ..Policy::default() };
        for i in 0..25 {
            let p = dirs.tmp.join(format!("o{i}.json"));
            fs::write(&p, b"{").unwrap();
            age(&p, 2 * HOUR);
        }
        assert_eq!(tidy(&dirs, SystemTime::now(), &policy).tmp_removed, 10);
        assert_eq!(tidy(&dirs, SystemTime::now(), &policy).tmp_removed, 10);
        assert_eq!(tidy(&dirs, SystemTime::now(), &policy).tmp_removed, 5);
        assert_eq!(tidy(&dirs, SystemTime::now(), &policy), Report::default());
    }

    #[test]
    fn tidying_a_missing_layout_does_nothing_and_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = Dirs::new(&dir.path().join("nope"));
        assert_eq!(tidy(&dirs, SystemTime::now(), &Policy::default()), Report::default());
    }
}
