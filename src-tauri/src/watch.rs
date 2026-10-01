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

pub struct Filter {
    gitignore: Gitignore,
}

impl Filter {
    pub fn new(root: &Path) -> Self {
        let mut builder = GitignoreBuilder::new(root);
        let _ = builder.add(root.join(".gitignore"));
        Filter { gitignore: builder.build().unwrap_or_else(|_| Gitignore::empty()) }
    }

    /// True when a project-relative path should not be reported.
    pub fn ignored(&self, root: &Path, rel: &str) -> bool {
        if rel == OUTSIDE_PROJECT || rel == "." || rel.is_empty() {
            return true;
        }
        if rel.split('/').any(|seg| ALWAYS_IGNORED.contains(&seg)) {
            return true;
        }
        let abs = root.join(rel);
        self.gitignore.matched_path_or_any_parents(&abs, abs.is_dir()).is_ignore()
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
                if f.ignored(&r, &rel) || path.is_dir() {
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
        for ignored in ["node_modules/a/b.js", ".git/HEAD", "dist/app.js", "debug.log", "coverage/x.json", ".claude/settings.local.json", OUTSIDE_PROJECT] {
            assert!(f.ignored(dir.path(), ignored), "{ignored}");
        }
        for kept in ["src/auth/login.ts", "db/migrations/0001.sql", "package.json"] {
            assert!(!f.ignored(dir.path(), kept), "{kept}");
        }
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
