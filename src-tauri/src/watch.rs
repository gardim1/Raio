//! Filesystem observation of connected projects. Produces `file.changed` events with
//! `provenance: filesystem-observed` and `attribution: unassigned`: the watcher cannot tell who made a
//! change; the projection decides whether a reported agent edit is consistent with it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::claude::relative_path;
use crate::event::{stable_id, Evidence, RaioEvent, OUTSIDE_PROJECT, SCHEMA};

const DEBOUNCE: Duration = Duration::from_millis(150);
const FLUSH_EVERY: Duration = Duration::from_millis(250);

/// Directories never reported, whatever `.gitignore` says.
const ALWAYS_IGNORED: [&str; 12] = [".git", "node_modules", "target", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".claude", ".raio", ".turbo"];

/// Temp files of atomic writes (`name.tmp.<pid>.<hex>`), e.g. Claude Code's Write tool: the rename into
/// place is reported for the real path; the temp file itself is noise.
fn is_atomic_write_temp(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let mut parts = name.rsplitn(3, '.');
    let (Some(hex), Some(pid), Some(rest)) = (parts.next(), parts.next(), parts.next()) else { return false };
    rest.ends_with(".tmp") && !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()) && hex.len() >= 6 && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// One directory's `.gitignore`, with the file stamp it was read at (`None`: the file does not exist).
struct Level {
    stamp: Option<(SystemTime, u64)>,
    rules: Gitignore,
}

/// Decides which project-relative paths are not reported. Honours the root `.gitignore` and nested ones
/// (read lazily, re-read when the file changes), with git's precedence: a deeper file overrides a
/// shallower one, and nothing inside an ignored directory can be re-included. It does not read
/// `.git/info/exclude` or the user's global ignore file.
pub struct Filter {
    root: PathBuf,
    levels: Mutex<HashMap<PathBuf, Level>>,
}

fn stamp_of(file: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(file).ok()?;
    meta.is_file().then(|| (meta.modified().unwrap_or(UNIX_EPOCH), meta.len()))
}

impl Filter {
    pub fn new(root: &Path) -> Self {
        Filter { root: root.to_path_buf(), levels: Mutex::default() }
    }

    /// Rules of `dir/.gitignore`, refreshed when the file appeared, changed or vanished.
    fn rules_for(&self, dir: &Path) -> Option<Gitignore> {
        let file = dir.join(".gitignore");
        let stamp = stamp_of(&file);
        let mut levels = self.levels.lock().ok()?;
        if let Some(level) = levels.get(dir).filter(|l| l.stamp == stamp) {
            return (stamp.is_some()).then(|| level.rules.clone());
        }
        let mut builder = GitignoreBuilder::new(dir);
        if stamp.is_some() {
            let _ = builder.add(&file);
        }
        let rules = builder.build().unwrap_or_else(|_| Gitignore::empty());
        levels.insert(dir.to_path_buf(), Level { stamp, rules: rules.clone() });
        stamp.is_some().then_some(rules)
    }

    /// True when a project-relative path should not be reported.
    pub fn ignored(&self, rel: &str) -> bool {
        if rel == OUTSIDE_PROJECT || rel == "." || rel.is_empty() {
            return true;
        }
        if rel.split('/').any(|seg| ALWAYS_IGNORED.contains(&seg)) {
            return true;
        }
        if is_atomic_write_temp(rel) {
            return true;
        }
        // Walk down from the root like git: each entry is matched against the `.gitignore` of every
        // directory above it (deepest first); an ignored directory ends the walk.
        let segments: Vec<&str> = rel.split('/').collect();
        let mut above: Vec<Gitignore> = self.rules_for(&self.root).into_iter().collect();
        let mut entry = self.root.clone();
        for (i, segment) in segments.iter().enumerate() {
            entry.push(segment);
            let last = i + 1 == segments.len();
            let is_dir = !last || entry.is_dir();
            let verdict = above.iter().rev().map(|r| r.matched(&entry, is_dir)).find(|m| !m.is_none());
            if verdict.is_some_and(|m| m.is_ignore()) {
                return true;
            }
            if !last {
                above.extend(self.rules_for(&entry));
            }
        }
        false
    }
}

fn change_of(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("added"),
        EventKind::Remove(_) => Some("deleted"),
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(_) => Some("modified"),
        _ => None,
    }
}

pub fn file_changed(project_id: &str, rel: &str, change: &str, at_ms: i64) -> RaioEvent {
    RaioEvent {
        schema: SCHEMA,
        id: stable_id(&["fs-watch", project_id, rel, &at_ms.to_string(), change]),
        source: "fs-watch".into(),
        provenance: "filesystem-observed".into(),
        attribution: "unassigned".into(),
        project_id: project_id.into(),
        session_id: None,
        agent: "unknown".into(),
        subagent_id: None,
        source_at: Some(at_ms),
        observed_at: 0,
        seq: 0,
        kind: "file.changed".into(),
        paths: vec![rel.into()],
        evidence: Evidence { change: Some(change.into()), ..Evidence::default() },
    }
}

/// A running watcher; dropping it stops observation.
pub struct ProjectWatch {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
    pub overflowed: Arc<AtomicBool>,
}

impl Drop for ProjectWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Watches `root`; debounced `file.changed` events are passed to `sink` from a background thread.
pub fn watch<F>(project_id: String, root: PathBuf, sink: F) -> notify::Result<ProjectWatch>
where
    F: Fn(Vec<RaioEvent>) + Send + 'static,
{
    let filter = Arc::new(Filter::new(&root));
    let pending: Arc<Mutex<HashMap<String, (&'static str, Instant)>>> = Arc::default();
    let overflowed = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));

    let (p, f, r, o) = (pending.clone(), filter.clone(), root.clone(), overflowed.clone());
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
        Ok(event) => {
            if event.need_rescan() {
                o.store(true, Ordering::Relaxed);
            }
            let Some(change) = change_of(&event.kind) else { return };
            for path in event.paths {
                let rel = relative_path(&r, None, &path.to_string_lossy());
                if f.ignored(&rel) || path.is_dir() {
                    continue;
                }
                if let Ok(mut map) = p.lock() {
                    let entry = map.entry(rel).or_insert((change, Instant::now()));
                    // A create followed by modifications stays "added"; anything else takes the latest kind.
                    entry.0 = if entry.0 == "added" && change == "modified" { "added" } else { change };
                    entry.1 = Instant::now();
                }
            }
        }
        Err(_) => o.store(true, Ordering::Relaxed),
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let (p, s) = (pending, stop.clone());
    thread::spawn(move || {
        while !s.load(Ordering::Relaxed) {
            thread::sleep(FLUSH_EVERY);
            let due: Vec<(String, &'static str)> = match p.lock() {
                Ok(mut map) => {
                    let ready: Vec<String> = map.iter().filter(|(_, (_, at))| at.elapsed() >= DEBOUNCE).map(|(k, _)| k.clone()).collect();
                    ready.into_iter().filter_map(|k| map.remove(&k).map(|(c, _)| (k, c))).collect()
                }
                Err(_) => continue,
            };
            if due.is_empty() {
                continue;
            }
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            sink(due.into_iter().map(|(rel, change)| file_changed(&project_id, &rel, change, now)).collect());
        }
    });
    Ok(ProjectWatch { _watcher: watcher, stop, overflowed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;

    #[test]
    fn ignores_dependencies_build_output_and_gitignored_paths() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "*.log\ncoverage/\n").unwrap();
        let f = Filter::new(dir.path());
        for ignored in ["src/auth/login.ts.tmp.47676.e5194d49b807", "node_modules/a/b.js", ".git/HEAD", "dist/app.js", "debug.log", "coverage/x.json", ".claude/settings.local.json", OUTSIDE_PROJECT] {
            assert!(f.ignored(ignored), "{ignored}");
        }
        for kept in ["src/auth/login.ts", "db/migrations/0001.sql", "package.json", "notes.tmp.md", "a.tmp.12.zz"] {
            assert!(!f.ignored(kept), "{kept}");
        }
    }

    #[test]
    fn honours_nested_gitignore_files_with_git_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("packages/web/generated")).unwrap();
        fs::create_dir_all(root.join("packages/api")).unwrap();
        fs::create_dir_all(root.join("coverage")).unwrap();
        fs::write(root.join(".gitignore"), "*.log\ncoverage/\n").unwrap();
        fs::write(root.join("packages/web/.gitignore"), "generated/\n.env.local\n!keep.log\n").unwrap();
        fs::write(root.join("coverage/.gitignore"), "!lcov.info\n").unwrap();
        let f = Filter::new(root);
        for ignored in [
            "packages/web/generated/client.ts", // nested rule
            "packages/web/.env.local",
            "packages/web/src/a.log",            // root rule still applies below a nested file
            "coverage/lcov.info",                // git cannot re-include inside an excluded directory
        ] {
            assert!(f.ignored(ignored), "{ignored}");
        }
        for kept in [
            "packages/api/generated/client.ts", // the nested rule is scoped to packages/web
            "packages/web/src/a.ts",
            "packages/web/keep.log",            // a deeper file may re-include what a shallower one ignored
            "generated/client.ts",
        ] {
            assert!(!f.ignored(kept), "{kept}");
        }
    }

    #[test]
    fn notices_a_nested_gitignore_that_appears_or_changes_while_watching() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("app")).unwrap();
        let f = Filter::new(root);
        assert!(!f.ignored("app/out.txt"));
        fs::write(root.join("app/.gitignore"), "out.txt\n").unwrap();
        assert!(f.ignored("app/out.txt"));
        fs::write(root.join("app/.gitignore"), "other.txt\n").unwrap();
        // Same-length rewrite within one mtime tick must still be noticed: bump the mtime explicitly.
        let later = std::time::SystemTime::now() + Duration::from_secs(5);
        fs::File::options().write(true).open(root.join("app/.gitignore")).unwrap().set_modified(later).unwrap();
        assert!(!f.ignored("app/out.txt"));
    }

    #[test]
    fn reports_real_changes_debounced_and_skips_a_burst_in_ignored_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let (tx, rx) = mpsc::channel();
        let _watch = watch("p".into(), root.clone(), move |events| {
            let _ = tx.send(events);
        })
        .unwrap();
        thread::sleep(Duration::from_millis(300));
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        for i in 0..2_000 {
            fs::write(root.join(format!("node_modules/pkg/f{i}.js")), b"x").unwrap();
        }
        fs::create_dir_all(root.join("src")).unwrap();
        for _ in 0..5 {
            fs::write(root.join("src/a.ts"), b"export {}").unwrap();
        }
        let mut seen = vec![];
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.extend(batch);
            }
        }
        let paths: Vec<&str> = seen.iter().map(|e| e.paths[0].as_str()).collect();
        assert!(paths.iter().all(|p| !p.starts_with("node_modules")), "{paths:?}");
        assert_eq!(paths.iter().filter(|p| **p == "src/a.ts").count(), 1, "{paths:?}");
        assert!(seen.iter().all(|e| e.attribution == "unassigned" && e.validate().is_ok()));
    }
}
