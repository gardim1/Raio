//! Latest status-line readings, separate from the event store. No account or transcript access.
use crate::{event::stable_id, paths};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};

pub const MAX_INPUT: u64 = 256 * 1024;
const MAX_SNAPSHOT: u64 = 4096;
const MAX_PROJECTS: usize = 64;
const MAX_SOURCES: usize = 32;
const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS: i64 = 60_000;
const RECENT_MS: i64 = 15 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Window {
    pub used_percentage: f64,
    pub resets_at_ms: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub kind: String,
    pub session_id: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_version: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub source: Source,
    pub received_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<Window>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<Window>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum State {
    Disabled,
    Incompatible {
        reason: String,
    },
    Waiting,
    Error {
        reason: String,
    },
    Reading {
        latest: Snapshot,
        #[serde(rename = "sourceCount")]
        source_count: usize,
    },
}
fn identifier(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && !text.starts_with('-')
        && text
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
pub fn arguments(args: &[String]) -> Option<(&str, &str)> {
    let [mode, project_flag, project, root_flag, root, marker] = args else {
        return None;
    };
    (mode == "statusline"
        && project_flag == "--project"
        && identifier(project)
        && root_flag == "--root"
        && !root.is_empty()
        && !root.contains(['\n', '\r'])
        && Path::new(root).is_absolute()
        && marker == crate::connect::MARKER)
        .then_some((project, root))
}
fn epoch(ms: i64) -> bool {
    (1_577_836_800_000..=4_102_444_800_000).contains(&ms)
}
fn percentage(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|p| p.is_finite() && (0.0..=100.0).contains(p))
}
fn window(v: Option<&Value>) -> Option<Window> {
    let v = v?;
    let used_percentage = percentage(v.get("used_percentage")?)?;
    // Milliseconds are deliberately rejected, not guessed. A bad/missing reset is unknown, never zero.
    let resets_at_ms = v
        .get("resets_at")
        .and_then(Value::as_i64)
        .and_then(|s| s.checked_mul(1000))
        .filter(|ms| epoch(*ms));
    Some(Window {
        used_percentage,
        resets_at_ms,
    })
}
pub fn parse(bytes: &[u8], project: &str, now: i64) -> Option<Snapshot> {
    if bytes.len() as u64 > MAX_INPUT || !identifier(project) || !epoch(now) {
        return None;
    }
    let v = crate::claude::parse_payload(bytes)?;
    let session_id = v.get("session_id")?.as_str()?.to_string();
    if !identifier(&session_id) {
        return None;
    }
    let claude_version = v
        .get("version")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
        })
        .map(str::to_string);
    let limits = v.get("rate_limits");
    Some(Snapshot {
        source: Source {
            kind: "claude-statusline".into(),
            session_id,
            project_id: project.into(),
            claude_version,
        },
        received_at_ms: now,
        five_hour: window(limits.and_then(|l| l.get("five_hour"))),
        seven_day: window(limits.and_then(|l| l.get("seven_day"))),
    })
}
fn valid(s: &Snapshot, now: i64) -> bool {
    s.source.kind == "claude-statusline"
        && identifier(&s.source.project_id)
        && identifier(&s.source.session_id)
        && s.source.claude_version.as_ref().is_none_or(|v| {
            !v.is_empty()
                && v.len() <= 64
                && v.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
        })
        && epoch(s.received_at_ms)
        && s.received_at_ms <= now.saturating_add(FUTURE_TOLERANCE_MS)
        && [&s.five_hour, &s.seven_day].into_iter().flatten().all(|w| {
            w.used_percentage.is_finite()
                && (0.0..=100.0).contains(&w.used_percentage)
                && w.resets_at_ms.is_none_or(epoch)
        })
}
pub fn directory(data: &Path) -> PathBuf {
    data.join("usage")
}
fn project_dir(data: &Path, project: &str) -> PathBuf {
    directory(data).join(stable_id(&[project]))
}
fn snapshot_path(data: &Path, s: &Snapshot) -> PathBuf {
    project_dir(data, &s.source.project_id)
        .join(format!("{}.json", stable_id(&[&s.source.session_id])))
}
fn entries(dir: &Path, cap: usize) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .take(cap)
        .map(|e| e.path())
        .collect()
}
fn read(path: &Path, now: i64) -> Result<Snapshot, ()> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| ())?
        .take(MAX_SNAPSHOT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_SNAPSHOT {
        return Err(());
    }
    let s: Snapshot = serde_json::from_slice(&bytes).map_err(|_| ())?;
    valid(&s, now).then_some(s).ok_or(())
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
#[derive(Debug, PartialEq, Eq)]
pub struct WriteError;
pub fn write(data: &Path, snapshot: &Snapshot) -> Result<bool, WriteError> {
    write_inner(data, snapshot).map_err(|_| WriteError)
}
fn write_inner(data: &Path, snapshot: &Snapshot) -> Result<bool, ()> {
    if !valid(snapshot, snapshot.received_at_ms) {
        return Err(());
    }
    let dir = project_dir(data, &snapshot.source.project_id);
    fs::create_dir_all(directory(data)).map_err(|_| ())?;
    if !dir.exists() && entries(&directory(data), MAX_PROJECTS + 1).len() >= MAX_PROJECTS {
        return Err(());
    }
    fs::create_dir_all(&dir).map_err(|_| ())?;
    let lock = dir.join("write.lock");
    // Every writer has a 2s process deadline; only reclaim a lock safely beyond that deadline.
    if fs::metadata(&lock)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age > Duration::from_secs(30))
    {
        let _ = fs::remove_file(&lock);
    }
    drop(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|_| ())?,
    );
    let _lock = Lock(lock);
    let path = snapshot_path(data, snapshot);
    let now = snapshot.received_at_ms.max(clock_ms());
    if let Ok(previous) = read(&path, now)
        && previous.received_at_ms >= snapshot.received_at_ms
    {
        return Ok(false);
    }
    let mut existing: Vec<_> = entries(&dir, MAX_SOURCES + 16)
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter_map(|p| match read(&p, now) {
            Ok(s) if now.saturating_sub(s.received_at_ms) <= RETENTION_MS => {
                Some((p, s.received_at_ms))
            }
            _ => {
                let _ = fs::remove_file(p);
                None
            }
        })
        .collect();
    existing.sort_by_key(|(_, at)| *at);
    if !path.exists() && existing.len() >= MAX_SOURCES {
        for (p, _) in existing.iter().take(existing.len() + 1 - MAX_SOURCES) {
            let _ = fs::remove_file(p);
        }
    }
    let bytes = serde_json::to_vec(snapshot).map_err(|_| ())?;
    paths::write_atomic(&path, &bytes).map_err(|_| ())?;
    Ok(true)
}
pub fn clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Reader {
    dirty: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
    stamps: HashMap<PathBuf, (SystemTime, u64)>,
    sources: HashMap<PathBuf, Snapshot>,
    bad: HashSet<PathBuf>,
}
impl Reader {
    pub fn open(data: &Path, now: i64) -> Result<Self, String> {
        fs::create_dir_all(directory(data)).map_err(|_| "Usage storage unavailable")?;
        let dirty = Arc::new(AtomicBool::new(true));
        let flag = dirty.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if match event {
                    Err(_) => true,
                    Ok(e) => matches!(
                        e.kind,
                        notify::EventKind::Create(_)
                            | notify::EventKind::Modify(_)
                            | notify::EventKind::Remove(_)
                    ),
                } {
                    flag.store(true, Ordering::Release);
                }
            })
            .map_err(|_| "Usage watcher unavailable")?;
        watcher
            .watch(&directory(data), RecursiveMode::Recursive)
            .map_err(|_| "Usage watcher unavailable")?;
        let mut reader = Self {
            dirty,
            _watcher: watcher,
            stamps: HashMap::new(),
            sources: HashMap::new(),
            bad: HashSet::new(),
        };
        reader.ingest(data, now);
        Ok(reader)
    }
    pub fn ingest(&mut self, data: &Path, now: i64) -> bool {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return false;
        }
        let before = (self.sources.clone(), self.bad.clone());
        let mut seen = HashSet::new();
        for dir in entries(&directory(data), MAX_PROJECTS) {
            if !dir.is_dir() {
                continue;
            }
            for path in entries(&dir, MAX_SOURCES + 16)
                .into_iter()
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
            {
                seen.insert(path.clone());
                let Ok(meta) = fs::metadata(&path) else {
                    continue;
                };
                let stamp = (
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                );
                if self.stamps.get(&path) == Some(&stamp) {
                    continue;
                }
                self.stamps.insert(path.clone(), stamp);
                match read(&path, now) {
                    Ok(s) if snapshot_path(data, &s) == path => {
                        self.bad.remove(&path);
                        if now.saturating_sub(s.received_at_ms) > RETENTION_MS {
                            let _ = fs::remove_file(&path);
                            self.sources.remove(&path);
                            self.stamps.remove(&path);
                            continue;
                        }
                        if let Some(old) = self
                            .sources
                            .get(&path)
                            .filter(|old| old.received_at_ms > s.received_at_ms)
                        {
                            // Repair a late producer's replacement too, so restart cannot resurrect older data.
                            let _ = write(data, old);
                        } else if self
                            .sources
                            .get(&path)
                            .is_none_or(|old| old.received_at_ms < s.received_at_ms)
                        {
                            self.sources.insert(path, s);
                        }
                    }
                    _ => {
                        self.bad.insert(path);
                    }
                }
            }
        }
        self.stamps.retain(|p, _| seen.contains(p));
        self.sources.retain(|p, _| seen.contains(p));
        self.bad.retain(|p| seen.contains(p));
        let mut projects: HashMap<String, Vec<(PathBuf, i64)>> = HashMap::new();
        for (path, s) in &self.sources {
            projects
                .entry(s.source.project_id.clone())
                .or_default()
                .push((path.clone(), s.received_at_ms));
        }
        for sources in projects.values_mut() {
            sources.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
            for (path, _) in sources.iter().skip(MAX_SOURCES) {
                let _ = fs::remove_file(path);
                self.sources.remove(path);
                self.stamps.remove(path);
            }
        }
        before != (self.sources.clone(), self.bad.clone())
    }
    pub fn expire(&mut self, data: &Path, now: i64) {
        let expired: Vec<_> = self
            .sources
            .iter()
            .filter(|(_, s)| now.saturating_sub(s.received_at_ms) > RETENTION_MS)
            .map(|(p, _)| p.clone())
            .collect();
        for path in expired {
            let _ = fs::remove_file(&path);
        }
        // Empty project directories would otherwise permanently consume the bounded project slots.
        for dir in entries(&directory(data), MAX_PROJECTS) {
            for path in entries(&dir, MAX_SOURCES + 16) {
                let age = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|t| now.saturating_sub(t.as_millis() as i64));
                let temporary = path.extension().is_some_and(|e| e == "tmp" || e == "lock");
                if age.is_some_and(|age| age > if temporary { 30_000 } else { RETENTION_MS }) {
                    let _ = fs::remove_file(path);
                }
            }
            let _ = fs::remove_dir(dir);
        }
    }
    pub fn clear(&mut self, data: &Path, project: &str) {
        let dir = project_dir(data, project);
        for path in entries(&dir, MAX_SOURCES + 16) {
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
        let _ = fs::remove_dir(&dir);
        self.sources.retain(|p, _| !p.starts_with(&dir));
        self.stamps.retain(|p, _| !p.starts_with(&dir));
        self.bad.retain(|p| !p.starts_with(&dir));
    }
    pub fn state(&self, data: &Path, project: &str, now: i64) -> State {
        if self
            .bad
            .iter()
            .any(|p| p.starts_with(project_dir(data, project)))
        {
            return State::Error {
                reason: "Stored usage reading is invalid or unreadable.".into(),
            };
        }
        let sources: Vec<_> = self
            .sources
            .values()
            .filter(|s| {
                s.source.project_id == project
                    && valid(s, now)
                    && now.saturating_sub(s.received_at_ms) <= RETENTION_MS
            })
            .collect();
        let Some(latest) = sources.iter().max_by_key(|s| s.received_at_ms) else {
            return State::Waiting;
        };
        if latest.five_hour.is_none() && latest.seven_day.is_none() {
            return State::Waiting;
        }
        let source_count = sources
            .iter()
            .filter(|s| now.saturating_sub(s.received_at_ms) <= RECENT_MS)
            .count();
        State::Reading {
            latest: (*latest).clone(),
            source_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn sample(session: &str, at: i64) -> Snapshot {
        parse(serde_json::to_string(&json!({"session_id":session,"rate_limits":{"five_hour":{"used_percentage":25,"resets_at":1791450000}}})).unwrap().as_bytes(), "project", at).unwrap()
    }
    #[test]
    fn windows_are_independent_and_bad_percentages_never_become_zero() {
        for percent in [
            json!(-1),
            json!(101),
            json!("50"),
            json!(null),
            json!("NaN"),
        ] {
            let payload = json!({"session_id":"s","rate_limits":{"five_hour":{"used_percentage":percent},"seven_day":{"used_percentage":100}}});
            let s = parse(payload.to_string().as_bytes(), "p", clock_ms()).unwrap();
            assert!(s.five_hour.is_none());
            assert_eq!(s.seven_day.unwrap().used_percentage, 100.0);
        }
        for limits in [
            json!(null),
            json!({}),
            json!({"five_hour":{"used_percentage":0}}),
        ] {
            let s = parse(
                json!({"session_id":"s","rate_limits":limits})
                    .to_string()
                    .as_bytes(),
                "p",
                clock_ms(),
            )
            .unwrap();
            assert!(s.seven_day.is_none());
        }
        for reset in [
            json!(1791450000000_i64),
            json!(-1),
            json!("1791450000"),
            json!(null),
        ] {
            let s = parse(json!({"session_id":"s","rate_limits":{"five_hour":{"used_percentage":0,"resets_at":reset}}}).to_string().as_bytes(), "p", clock_ms()).unwrap();
            assert_eq!(s.five_hour.unwrap().resets_at_ms, None);
        }
        assert!(
            parse(
                br#"{"session_id":"s","rate_limits":{"five_hour":{"used_percentage":NaN}}}"#,
                "p",
                clock_ms()
            )
            .is_none()
        );
        assert!(parse(br#"{"session_id":"../../escape"}"#, "p", clock_ms()).is_none());
        assert!(parse(&vec![b' '; MAX_INPUT as usize + 1], "p", clock_ms()).is_none());
    }
    #[test]
    fn sources_are_not_merged_and_older_readings_cannot_replace_newer_on_restart() {
        let data = tempfile::tempdir().unwrap();
        let now = clock_ms();
        let mut newer = sample("a", now);
        newer.seven_day = Some(Window {
            used_percentage: 90.0,
            resets_at_ms: None,
        });
        assert_eq!(write(data.path(), &newer), Ok(true));
        assert_eq!(write(data.path(), &sample("a", now - 1000)), Ok(false));
        let latest = sample("b", now + 1);
        write(data.path(), &latest).unwrap();
        let reader = Reader::open(data.path(), now + 1).unwrap();
        assert_eq!(
            reader.state(data.path(), "project", now + 1),
            State::Reading {
                latest,
                source_count: 2
            }
        );
        assert_eq!(reader.state(data.path(), "other", now), State::Waiting);
    }
    #[test]
    fn late_disk_replacement_is_repaired_and_restart_cannot_resurrect_it() {
        let data = tempfile::tempdir().unwrap();
        let now = clock_ms();
        let latest = sample("a", now);
        write(data.path(), &latest).unwrap();
        let mut reader = Reader::open(data.path(), now).unwrap();
        fs::write(
            snapshot_path(data.path(), &latest),
            serde_json::to_vec(&sample("a", now - 1000)).unwrap(),
        )
        .unwrap();
        reader.dirty.store(true, Ordering::Release);
        reader.ingest(data.path(), now);
        let restarted = Reader::open(data.path(), now).unwrap();
        assert_eq!(
            restarted.state(data.path(), "project", now),
            State::Reading {
                latest,
                source_count: 1
            }
        );
    }
    #[test]
    fn storage_is_bounded_expires_and_validates_extra_fields() {
        let data = tempfile::tempdir().unwrap();
        let now = clock_ms();
        for n in 0..40 {
            write(data.path(), &sample(&format!("s{n}"), now + n)).unwrap();
        }
        assert_eq!(entries(&project_dir(data.path(), "project"), 100).len(), 32);
        let mut reader = Reader::open(data.path(), now + 40).unwrap();
        assert!(matches!(
            reader.state(data.path(), "project", now + RECENT_MS + 100),
            State::Reading {
                source_count: 0,
                ..
            }
        ));
        reader.expire(data.path(), now + RETENTION_MS + 100);
        assert_eq!(
            reader.state(data.path(), "project", now + RETENTION_MS + 100),
            State::Waiting
        );
        let s = sample("corrupt", now);
        let path = snapshot_path(data.path(), &s);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut v = serde_json::to_value(s).unwrap();
        v["transcript_path"] = json!("PRIVATE");
        fs::write(&path, v.to_string()).unwrap();
        let reader = Reader::open(data.path(), now).unwrap();
        assert!(matches!(
            reader.state(data.path(), "project", now),
            State::Error { .. }
        ));
    }
    #[test]
    fn notifications_read_changed_files_once_and_clear_does_not_touch_other_projects() {
        let data = tempfile::tempdir().unwrap();
        let now = clock_ms();
        let mut reader = Reader::open(data.path(), now).unwrap();
        write(data.path(), &sample("a", now)).unwrap();
        reader.dirty.store(true, Ordering::Release);
        assert!(reader.ingest(data.path(), now));
        reader.dirty.store(false, Ordering::Release);
        assert!(!reader.ingest(data.path(), now));
        let mut other = sample("b", now);
        other.source.project_id = "other".into();
        write(data.path(), &other).unwrap();
        reader.clear(data.path(), "project");
        assert!(snapshot_path(data.path(), &other).exists());
        assert_eq!(reader.state(data.path(), "project", now), State::Waiting);
    }
}
