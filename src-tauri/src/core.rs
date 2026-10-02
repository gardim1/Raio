//! App-side core: opens the store, ingests the inbox, watches connected projects and serves the
//! renderer through IPC commands. It observes only; it never runs project commands.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::connect;
use crate::event::{project_id, RaioEvent};
use crate::inbox::{self, Dirs};
use crate::instance;
use crate::paths;
use crate::surfaces;
use crate::store::{Insert, Project, Store};
use crate::watch::{self, ProjectWatch};

const INGEST_EVERY: Duration = Duration::from_millis(500);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(3600);
/// Upkeep cadence; a pass that stopped at its bounds is followed up sooner.
const HOUSEKEEPING_EVERY: Duration = Duration::from_secs(3600);
const HOUSEKEEPING_CATCH_UP: Duration = Duration::from_secs(60);
pub const INGESTED_EVENT: &str = "events-ingested";

pub struct Core {
    pub dirs: Dirs,
    data: PathBuf,
    backups: PathBuf,
    pub store: Mutex<Store>,
    watches: Mutex<HashMap<String, ProjectWatch>>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Bounds of one housekeeping pass.
#[derive(Clone, Debug)]
pub struct Limits {
    pub retention_batch: usize,
    pub retention_batches: usize,
    pub inbox: inbox::Policy,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { retention_batch: 1_000, retention_batches: 20, inbox: inbox::Policy::default() }
    }
}

// Read by the tests; kept so a pass can be inspected.
#[allow(dead_code)]
#[derive(Debug, Default)]
pub struct Housekeeping {
    pub retention_removed: usize,
    pub inbox: inbox::Report,
    /// A bound was reached: more work is waiting for the next pass.
    pub more: bool,
}

impl Core {
    pub fn open() -> Result<Core, String> {
        Self::open_at(&paths::data_dir().ok_or("no per-user data directory")?)
    }

    /// One bounded pass of upkeep: inbox hygiene (orphans, TTL, markers) and event retention. Retention
    /// runs in short batches and the store lock is released between them, so ingestion is never held up
    /// for long. Safe to call from any thread; leftover work is reported through `more`.
    pub fn housekeeping(&self, now: SystemTime, limits: &Limits) -> Housekeeping {
        let inbox = inbox::tidy(&self.dirs, now, &limits.inbox);
        let budget = limits.inbox.budget;
        let mut more = [inbox.tmp_removed, inbox.expired, inbox.markers_removed].iter().any(|n| *n >= budget);
        let now_ms = now.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let mut retention_removed = 0;
        for batch in 1..=limits.retention_batches {
            let removed = match self.store.lock().map(|store| store.apply_retention_batch(now_ms, limits.retention_batch)) {
                Ok(Ok(n)) => n,
                _ => break,
            };
            retention_removed += removed;
            if removed < limits.retention_batch {
                break;
            }
            more |= batch == limits.retention_batches;
        }
        Housekeeping { retention_removed, inbox, more }
    }

    pub fn open_at(data: &Path) -> Result<Core, String> {
        let data = data.to_path_buf();
        fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let dirs = Dirs::new(&data);
        dirs.create().map_err(|e| e.to_string())?;
        inbox::touch_heartbeat(&dirs).map_err(|e| e.to_string())?;
        let store = Store::open(&data.join("raio.db"), now_ms()).map_err(|e| e.to_string())?;
        let core = Core { dirs, data: data.clone(), backups: data.join("backups"), store: Mutex::new(store), watches: Mutex::default() };
        // Before the first ingest pass, so events past the inbox TTL are dropped (and counted), not stored late.
        core.housekeeping(SystemTime::now(), &Limits::default());
        Ok(core)
    }

    /// Moves pending inbox records into the store. Returns how many new events were stored.
    pub fn ingest_once(&self) -> usize {
        let pending = inbox::pending(&self.dirs, 500);
        if pending.is_empty() {
            return 0;
        }
        let Ok(store) = self.store.lock() else { return 0 };
        let _ = store.begin();
        let mut stored = 0;
        let mut done = vec![];
        for p in pending {
            match p.event {
                Ok(event) => match store.insert(&event, now_ms()) {
                    Ok(Insert::Inserted(_)) => {
                        stored += 1;
                        done.push(p.path);
                    }
                    Ok(Insert::Duplicate | Insert::Capped) => done.push(p.path),
                    Err(_) => {} // leave it for the next pass
                },
                Err(_) => inbox::quarantine(&self.dirs, &p.path),
            }
        }
        // Delete inbox files only after the batch is committed; a crash before that re-ingests (dedupe).
        if store.commit().is_ok() {
            for path in done {
                let _ = fs::remove_file(path);
            }
        }
        stored
    }

    fn store_events(&self, events: Vec<RaioEvent>) -> usize {
        let Ok(store) = self.store.lock() else { return 0 };
        events.iter().filter(|e| matches!(store.insert(e, now_ms()), Ok(Insert::Inserted(_)))).count()
    }

    fn start_watch(&self, app: &AppHandle, project: &Project) {
        let handle = app.clone();
        let result = watch::watch(project.id.clone(), PathBuf::from(&project.root), move |events| {
            let core = handle.state::<Core>();
            if core.store_events(events) > 0 {
                let _ = handle.emit(INGESTED_EVENT, ());
            }
        });
        if let (Ok(w), Ok(mut map)) = (result, self.watches.lock()) {
            map.insert(project.id.clone(), w);
        }
    }
}

pub fn start(app: &AppHandle) {
    start_housekeeping(app);
    let core = app.state::<Core>();
    if let Ok(projects) = core.store.lock().map(|s| s.connected_projects().unwrap_or_default()) {
        for p in projects {
            core.start_watch(app, &p);
        }
    }
    let handle = app.clone();
    thread::spawn(move || {
        let mut since_heartbeat = Duration::ZERO;
        loop {
            let core = handle.state::<Core>();
            if core.ingest_once() > 0 {
                let _ = handle.emit(INGESTED_EVENT, ());
            }
            // A second `raio.exe` asked this instance to come forward.
            if instance::take_show_request(&core.data) {
                let _ = surfaces::show(&handle, surfaces::EXPANDED, None);
            }
            since_heartbeat += INGEST_EVERY;
            if since_heartbeat >= HEARTBEAT_EVERY {
                let _ = inbox::touch_heartbeat(&core.dirs);
                since_heartbeat = Duration::ZERO;
            }
            thread::sleep(INGEST_EVERY);
        }
    });
}

/// Upkeep on its own thread so a slow pass can never stall ingestion; `Core::open` already did the first one.
fn start_housekeeping(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let mut wait = HOUSEKEEPING_CATCH_UP;
        loop {
            thread::sleep(wait);
            let report = handle.state::<Core>().housekeeping(SystemTime::now(), &Limits::default());
            wait = if report.more { HOUSEKEEPING_CATCH_UP } else { HOUSEKEEPING_EVERY };
        }
    });
}

/* IPC ------------------------------------------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    schema_version: i64,
    events: i64,
    dropped: usize,
    history_reset_from: Option<String>,
    watcher_overflow: bool,
    hook_binary: Option<String>,
}

fn hook_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "raio-hook.exe" } else { "raio-hook" };
    let path = exe.parent()?.join(name);
    path.exists().then_some(path)
}

#[tauri::command(async)]
pub fn core_status(core: State<'_, Core>) -> Result<CoreStatus, String> {
    let store = core.store.lock().map_err(|e| e.to_string())?;
    let overflow = core.watches.lock().map(|w| w.values().any(|p| p.overflowed.load(Ordering::Relaxed))).unwrap_or(false);
    Ok(CoreStatus {
        schema_version: store.schema_version(),
        events: store.count_events().map_err(|e| e.to_string())?,
        dropped: inbox::dropped_count(&core.dirs),
        history_reset_from: store.reset_from.as_ref().map(|p| p.to_string_lossy().into_owned()),
        watcher_overflow: overflow,
        hook_binary: hook_binary().map(|p| p.to_string_lossy().into_owned()),
    })
}

#[tauri::command(async)]
pub fn list_projects(core: State<'_, Core>) -> Result<Vec<Project>, String> {
    core.store.lock().map_err(|e| e.to_string())?.connected_projects().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn project_events(core: State<'_, Core>, project_id: String) -> Result<Vec<RaioEvent>, String> {
    core.store.lock().map_err(|e| e.to_string())?.project_events(&project_id).map_err(|e| e.to_string())
}

fn root_and_command(root: &str) -> Result<(PathBuf, String, String), String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("not a folder".into());
    }
    let hook = hook_binary().ok_or("raio-hook was not found next to the Raio app")?;
    let id = project_id(&root);
    let command = connect::hook_command(&hook, &id, &root);
    Ok((root, id, command))
}

/// Async so the `git check-ignore` probe never blocks the UI thread.
#[tauri::command]
pub async fn preview_connect(root: String) -> Result<connect::Preview, String> {
    let (root, _, command) = root_and_command(&root)?;
    connect::preview(&root, &command)
}

#[tauri::command(async)]
pub fn connect_project(app: AppHandle, core: State<'_, Core>, root: String, previewed: connect::Preview) -> Result<Project, String> {
    let (root_path, id, command) = root_and_command(&root)?;
    connect::connect(&root_path, &command, &previewed, &core.backups, now_ms())?;
    let name = root_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
    let project = Project { id, root: root_path.to_string_lossy().into_owned(), name, connected_at: now_ms() };
    core.store.lock().map_err(|e| e.to_string())?.upsert_project(&project).map_err(|e| e.to_string())?;
    let _ = inbox::touch_heartbeat(&core.dirs);
    core.start_watch(&app, &project);
    let _ = app.emit(INGESTED_EVENT, ());
    Ok(project)
}

#[tauri::command(async)]
pub fn disconnect_project(app: AppHandle, core: State<'_, Core>, project_id: String) -> Result<(), String> {
    let project = {
        let store = core.store.lock().map_err(|e| e.to_string())?;
        store.connected_projects().map_err(|e| e.to_string())?.into_iter().find(|p| p.id == project_id).ok_or("unknown project")?
    };
    connect::disconnect(Path::new(&project.root), &core.backups, now_ms())?;
    core.store.lock().map_err(|e| e.to_string())?.disconnect_project(&project_id, now_ms()).map_err(|e| e.to_string())?;
    if let Ok(mut w) = core.watches.lock() {
        w.remove(&project_id);
    }
    let _ = app.emit(INGESTED_EVENT, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{stable_id, Evidence};
    use crate::store::RETENTION_MS;

    fn event(n: u32) -> RaioEvent {
        RaioEvent {
            schema: 1,
            id: stable_id(&["core", &n.to_string()]),
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

    fn open() -> (tempfile::TempDir, Core) {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open_at(dir.path()).unwrap();
        (dir, core)
    }

    #[test]
    fn housekeeping_applies_retention_in_bounded_batches_until_done() {
        let (_d, core) = open();
        let now = now_ms();
        {
            let store = core.store.lock().unwrap();
            for n in 0..7 {
                store.insert(&event(n), now - RETENTION_MS - 1_000).unwrap();
            }
            store.insert(&event(99), now).unwrap();
        }
        let limits = Limits { retention_batch: 3, retention_batches: 2, ..Limits::default() };
        let first = core.housekeeping(SystemTime::now(), &limits);
        assert_eq!(first.retention_removed, 6);
        assert!(first.more, "one old event is still waiting for the next pass");
        let second = core.housekeeping(SystemTime::now(), &limits);
        assert_eq!(second.retention_removed, 1);
        assert!(!second.more);
        assert_eq!(core.store.lock().unwrap().count_events().unwrap(), 1);
    }

    #[test]
    fn housekeeping_also_tidies_the_inbox() {
        let (_d, core) = open();
        let stale = core.dirs.tmp.join("orphan.json");
        std::fs::write(&stale, b"{").unwrap();
        std::fs::File::options().write(true).open(&stale).unwrap().set_modified(SystemTime::now() - Duration::from_secs(7200)).unwrap();
        let report = core.housekeeping(SystemTime::now(), &Limits::default());
        assert_eq!(report.inbox.tmp_removed, 1);
        assert!(!stale.exists());
    }

    #[test]
    fn housekeeping_does_not_hold_the_store_while_it_returns() {
        let (_d, core) = open();
        core.housekeeping(SystemTime::now(), &Limits::default());
        assert!(core.store.try_lock().is_ok());
    }

    #[test]
    fn opening_applies_the_inbox_ttl_before_anything_is_ingested() {
        let dir = tempfile::tempdir().unwrap();
        {
            let core = Core::open_at(dir.path()).unwrap();
            let old = core.dirs.inbox.join("0001.json");
            std::fs::write(&old, b"{}").unwrap();
            std::fs::File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - Duration::from_secs(30 * 24 * 3600)).unwrap();
        }
        let core = Core::open_at(dir.path()).unwrap();
        assert!(!core.dirs.inbox.join("0001.json").exists());
        assert_eq!(inbox::dropped_count(&core.dirs), 1);
    }
}
