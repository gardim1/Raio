//! App-side core: opens the store, ingests the inbox, watches connected projects and serves the
//! renderer through IPC commands. It observes only; it never runs project commands.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::connect;
use crate::{usage, usage_connect};
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
const CONNECTIONS_FILE: &str = "connections.json";
/// Present while a connection change is not yet reflected in `connections.json`; readers must then treat the list as unknown.
const CONNECTIONS_PENDING: &str = "connections.pending";

#[cfg(test)]
thread_local! {
    /// Test seam: makes the next `connections.json` rewrites on this thread fail.
    static FAIL_CONNECTIONS_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub struct Core {
    pub dirs: Dirs,
    data: PathBuf,
    backups: PathBuf,
    pub store: Mutex<Store>,
    watches: Mutex<HashMap<String, ProjectWatch>>,
    project_intents: Mutex<surfaces::Intents>,
    /// Serialises whole connection changes (marker, settings, database, published list), so one change can never
    /// clear the pending marker while another is still in flight.
    connection_changes: Mutex<()>,
    usage: Mutex<Result<usage::Reader, String>>,
    /// Configuration/clear invalidations are independent of whether any snapshot remains.
    usage_invalidated: AtomicBool,
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
        let mut more = inbox.more;
        let now_ms = now.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        if let Ok(mut usage) = self.usage.lock() && let Ok(reader) = usage.as_mut() { reader.expire(&self.data, now_ms); }
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
        let usage = Mutex::new(usage::Reader::open(&data, now_ms()));
        let core = Core { dirs, data: data.clone(), backups: data.join("backups"), store: Mutex::new(store), watches: Mutex::default(), project_intents: Mutex::default(), connection_changes: Mutex::default(), usage, usage_invalidated: AtomicBool::new(false) };
        // Before the first ingest pass, so events past the inbox TTL are dropped (and counted), not stored late.
        core.housekeeping(SystemTime::now(), &Limits::default());
        core.refresh_connections();
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

    /// Root folder of a connected project; an unknown or disconnected id is an error.
    pub fn connected_root(&self, project_id: &str) -> Result<PathBuf, String> {
        let store = self.store.lock().map_err(|e| e.to_string())?;
        let projects = store.connected_projects().map_err(|e| e.to_string())?;
        projects.into_iter().find(|p| p.id == project_id).map(|p| PathBuf::from(p.root)).ok_or_else(|| "unknown project".to_string())
    }

    pub(crate) fn record_project_intent(&self, root: &str) -> bool {
        self.project_intents.lock().unwrap_or_else(|e| e.into_inner()).record(surfaces::EXPANDED, root)
    }

    fn take_project_intent(&self) -> Option<String> {
        self.project_intents.lock().unwrap_or_else(|e| e.into_inner()).take(surfaces::EXPANDED)
    }

    fn refresh_connections(&self) {
        let refresh = || -> Result<(), String> {
            // Hold the database lock through replacement: concurrent connection changes must
            // not publish an older snapshot after a newer one.
            let store = self.store.lock().map_err(|e| e.to_string())?;
            let projects = store.connected_projects().map_err(|e| e.to_string())?;
            let mut connections = Vec::new();
            for project in projects {
                let root = PathBuf::from(project.root);
                let root = if root.is_absolute() { root } else { std::env::current_dir().map_err(|e| e.to_string())?.join(root) };
                connections.push(serde_json::json!({ "root": root, "settingsPath": connect::settings_path(&root) }));
            }
            let bytes = serde_json::to_vec(&connections).map_err(|e| e.to_string())?;
            #[cfg(test)]
            if FAIL_CONNECTIONS_WRITE.with(|fail| fail.get()) { return Err("simulated write failure".into()); }
            paths::write_atomic(&self.data.join(CONNECTIONS_FILE), &bytes).map_err(|e| e.to_string())?;
            // Only a successful rewrite clears the marker: the published list is current again.
            match fs::remove_file(self.data.join(CONNECTIONS_PENDING)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            }
        };
        if let Err(error) = refresh() { eprintln!("Raio could not update connections.json: {error}"); }
    }

    /// Before a connection change: mark the published list as pending and withdraw it, so a reader (the
    /// uninstaller) never trusts a list the change could make stale. The marker is a new file, so a reader holding
    /// the old list open cannot block it; it is removed only after a successful rewrite. If the rewrite fails, the
    /// marker (or at least the missing list) tells readers the connections are unknown. Best effort, like the rewrite.
    fn withdraw_connections(&self) {
        if let Err(e) = fs::write(self.data.join(CONNECTIONS_PENDING), b"") {
            eprintln!("Raio could not mark connections.json as pending: {e}");
        }
        match fs::remove_file(self.data.join(CONNECTIONS_FILE)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => eprintln!("Raio could not withdraw connections.json: {e}"),
            _ => {}
        }
    }

    fn connect_at(&self, root: PathBuf, id: String, command: String, previewed: &connect::Preview) -> Result<Project, String> {
        let _change = self.connection_changes.lock().unwrap_or_else(|e| e.into_inner());
        self.withdraw_connections();
        let result = (|| {
            connect::connect(&root, &command, previewed, &self.backups, now_ms())?;
            if previewed.usage.as_ref().is_some_and(|p| !p.enabled) { self.clear_usage(&id); }
            let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
            let project = Project { id, root: root.to_string_lossy().into_owned(), name, connected_at: now_ms() };
            self.store.lock().map_err(|e| e.to_string())?.upsert_project(&project).map_err(|e| e.to_string())?;
            Ok(project)
        })();
        // Also invalidate after partial failures: settings may have been saved before a later step failed.
        self.usage_invalidated.store(true, Ordering::Release);
        self.refresh_connections();
        if result.is_ok() { let _ = inbox::touch_heartbeat(&self.dirs); }
        result
    }

    fn disconnect_id(&self, project_id: &str) -> Result<(), String> {
        let _change = self.connection_changes.lock().unwrap_or_else(|e| e.into_inner());
        let root = self.connected_root(project_id)?;
        self.withdraw_connections();
        let result = (|| {
            connect::disconnect(&root, &self.backups, now_ms())?;
            self.store.lock().map_err(|e| e.to_string())?.disconnect_project(project_id, now_ms()).map_err(|e| e.to_string())
        })();
        self.usage_invalidated.store(true, Ordering::Release);
        self.refresh_connections();
        result?;
        self.clear_usage(project_id);
        if let Ok(mut watches) = self.watches.lock() { watches.remove(project_id); }
        Ok(())
    }

    fn store_events(&self, events: Vec<RaioEvent>) -> usize {
        let Ok(store) = self.store.lock() else { return 0 };
        events.iter().filter(|e| matches!(store.insert(e, now_ms()), Ok(Insert::Inserted(_)))).count()
    }

    fn clear_usage(&self, project: &str) {
        if let Ok(mut usage) = self.usage.lock() && let Ok(reader) = usage.as_mut() { reader.clear(&self.data, project); }
        self.usage_invalidated.store(true, Ordering::Release);
    }

    fn ingest_usage(&self) -> bool {
        let invalidated = self.usage_invalidated.swap(false, Ordering::AcqRel);
        let changed = self.usage.lock().ok().and_then(|mut usage| usage.as_mut().ok().map(|r| r.ingest(&self.data, now_ms()))).unwrap_or(false);
        invalidated || changed
    }

    fn usage_for(&self, project: &str, hook: Option<&Path>, layers: &usage_connect::Layers) -> Result<usage::State, String> {
        let root = self.connected_root(project)?;
        let Some(hook) = hook else { return Ok(usage::State::Incompatible { reason: "Raio's status line reader is unavailable.".into() }) };
        let command = connect::hook_command(hook, project, &root);
        let configuration = usage_connect::configuration(&root, &command, layers);
        if configuration != usage::State::Waiting { return Ok(configuration) }
        let reader = self.usage.lock().map_err(|_| "Usage storage unavailable")?;
        Ok(match reader.as_ref() { Ok(r) => r.state(&self.data, project, now_ms()), Err(reason) => usage::State::Error { reason: reason.clone() } })
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
            if core.ingest_usage() { let _ = handle.emit("claude-usage-changed", ()); }
            // A second `raio.exe` asked this instance to come forward.
            if let Some(request) = instance::take_launch_request(&core.data) {
                let emit = if let Some(project) = &request.project {
                    if handle.get_webview_window(surfaces::EXPANDED).is_none() {
                        core.project_intents.lock().unwrap_or_else(|e| e.into_inner()).reset(surfaces::EXPANDED);
                    }
                    core.record_project_intent(project)
                } else { false };
                match surfaces::show(&handle, request.target_surface(), None) {
                    Ok(()) if emit => {
                        if let Some(project) = request.project { let _ = handle.emit_to(surfaces::EXPANDED, "project-intent", project); }
                    }
                    Err(error) => eprintln!("Raio could not show the requested surface: {error}"),
                    _ => {},
                }
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
    dropped_at_least: bool,
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
    let dropped = inbox::drop_accounting(&core.dirs);
    Ok(CoreStatus {
        schema_version: store.schema_version(),
        events: store.count_events().map_err(|e| e.to_string())?,
        dropped: dropped.count,
        dropped_at_least: dropped.at_least,
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

fn hooks_state_for(core: &Core, project_id: &str, hook: Option<&Path>) -> Result<connect::HooksState, String> {
    let root = core.connected_root(project_id)?;
    let Some(hook) = hook else { return Ok(connect::HooksState::Unknown) };
    let command = connect::hook_command(hook, project_id, &root);
    Ok(connect::read_hooks_state(&root, &command))
}

/// Read-only, off the UI thread: user settings are never rewritten or backed up by a status check.
#[tauri::command(async)]
pub fn project_hooks_state(core: State<'_, Core>, project_id: String) -> Result<connect::HooksState, String> {
    hooks_state_for(&core, &project_id, hook_binary().as_deref())
}

#[tauri::command(async)]
pub fn claude_usage(core: State<'_, Core>, project_id: String) -> Result<usage::State, String> {
    core.usage_for(&project_id, hook_binary().as_deref(), &usage_connect::Layers::discover())
}

fn root_and_command(root: &str) -> Result<(PathBuf, String, String), String> {
    let root = paths::project_root(Path::new(root))?;
    let hook = hook_binary().ok_or("raio-hook was not found next to the Raio app")?;
    let id = project_id(&root);
    let command = connect::hook_command(&hook, &id, &root);
    Ok((root, id, command))
}

#[derive(Serialize)]
pub struct ProjectMap {
    inventory: crate::inventory::Inventory,
    imports: crate::imports::ImportScan,
}

fn scan_project_map(root: &str) -> Result<ProjectMap, String> {
    let root = paths::project_root(Path::new(root))?;
    Ok(ProjectMap {
        inventory: crate::inventory::scan(&root, &crate::inventory::Limits::default())?,
        imports: crate::imports::scan(&root, &crate::imports::Limits::default())?,
    })
}

#[tauri::command]
pub async fn preview_project_map(root: String) -> Result<ProjectMap, String> {
    tauri::async_runtime::spawn_blocking(move || scan_project_map(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn take_project_intent(core: State<'_, Core>) -> Option<String> {
    core.take_project_intent()
}

/// Async so the `git check-ignore` probe never blocks the UI thread.
#[tauri::command]
pub async fn preview_connect(root: String, usage: Option<usage_connect::Options>) -> Result<connect::Preview, String> {
    let (root, _, command) = root_and_command(&root)?;
    connect::preview_usage(&root, &command, usage, &usage_connect::Layers::discover())
}

#[tauri::command(async)]
pub fn connect_project(app: AppHandle, core: State<'_, Core>, root: String, previewed: connect::Preview) -> Result<Project, String> {
    let (root_path, id, command) = root_and_command(&root)?;
    let project = core.connect_at(root_path, id, command, &previewed)?;
    core.start_watch(&app, &project);
    let _ = app.emit(INGESTED_EVENT, ());
    Ok(project)
}

#[tauri::command(async)]
pub fn disconnect_project(app: AppHandle, core: State<'_, Core>, project_id: String) -> Result<(), String> {
    core.disconnect_id(&project_id)?;
    let _ = app.emit(INGESTED_EVENT, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{stable_id, Evidence};
    use crate::store::RETENTION_MS;

    #[test]
    fn usage_configuration_changes_and_empty_clears_invalidate_all_webviews() {
        let data = tempfile::tempdir().unwrap(); let project = tempfile::tempdir().unwrap();
        let root = project.path().to_path_buf();
        let command = connect::hook_command(Path::new("C:/Raio/raio-hook.exe"), "p", &root);
        let core = Core::open_at(data.path()).unwrap();
        for enabled in [false, true, true, false] {
            let preview = connect::preview_usage(&root, &command, Some(usage_connect::Options { enabled, replace_existing:false }), &usage_connect::Layers::default()).unwrap();
            core.connect_at(root.clone(), "p".into(), command.clone(), &preview).unwrap();
            assert!(core.ingest_usage(), "a configuration invalidation must emit even without a snapshot");
            assert!(!core.ingest_usage(), "unchanged usage does not emit periodically");
        }
        core.clear_usage("p");
        assert!(core.ingest_usage(), "clear must invalidate even when already empty");
        assert!(!core.ingest_usage());
        core.disconnect_id("p").unwrap();
        assert!(core.ingest_usage(), "disconnect must invalidate the cleared reading");
    }

    #[test]
    fn usage_is_opt_in_watch_driven_persistent_and_never_a_history_event() {
        let data = tempfile::tempdir().unwrap(); let project = tempfile::tempdir().unwrap();
        let root = project.path().to_path_buf(); let hook = Path::new("C:/Raio/raio-hook.exe");
        let command = connect::hook_command(hook, "p", &root); let layers = usage_connect::Layers::default();
        let core = Core::open_at(data.path()).unwrap();
        let p = connect::preview(&root, &command).unwrap(); core.connect_at(root.clone(), "p".into(), command.clone(), &p).unwrap();
        assert!(core.ingest_usage()); // Configuration notification is independent of a reading.
        assert_eq!(core.usage_for("p", Some(hook), &layers).unwrap(), usage::State::Disabled);
        let p = connect::preview_usage(&root, &command, Some(usage_connect::Options { enabled:true, replace_existing:false }), &layers).unwrap();
        core.connect_at(root.clone(), "p".into(), command.clone(), &p).unwrap();
        assert!(core.ingest_usage());
        assert_eq!(core.usage_for("p", Some(hook), &layers).unwrap(), usage::State::Waiting);
        let snapshot = usage::parse(br#"{"session_id":"synthetic","rate_limits":{"five_hour":{"used_percentage":0}}}"#, "p", now_ms()).unwrap();
        usage::write(data.path(), &snapshot).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(3);
        while !core.ingest_usage() && std::time::Instant::now() < until { thread::sleep(Duration::from_millis(10)); }
        assert!(matches!(core.usage_for("p", Some(hook), &layers).unwrap(), usage::State::Reading { source_count:1, .. }));
        assert_eq!(core.store.lock().unwrap().count_events().unwrap(), 0);
        drop(core);
        let core = Core::open_at(data.path()).unwrap();
        assert!(matches!(core.usage_for("p", Some(hook), &layers).unwrap(), usage::State::Reading { .. }));
        let managed = data.path().join("managed.json"); fs::write(&managed, "presence only").unwrap();
        assert!(matches!(core.usage_for("p", Some(hook), &usage_connect::Layers { user:None, managed:Some(managed), receipts:None }).unwrap(), usage::State::Incompatible { .. }));
        core.disconnect_id("p").unwrap();
        assert!(core.usage_for("p", Some(hook), &layers).is_err());
        assert!(!fs::read_to_string(connect::settings_path(&root)).unwrap().contains("statusLine"));
        assert_eq!(fs::read_dir(usage::directory(data.path())).unwrap().count(), 0);
    }

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
    fn alpha_project_intent_is_pulled_once_or_delivered_live_without_connecting() {
        let (_d, core) = open();
        assert!(!core.record_project_intent("superseded"));
        assert!(!core.record_project_intent("first"));
        assert_eq!(core.take_project_intent(), Some("first".into()));
        assert_eq!(core.take_project_intent(), None);
        assert!(core.record_project_intent("second"));
        assert_eq!(core.take_project_intent(), None, "a delivered event is not replayed on mount");
        assert!(core.store.lock().unwrap().connected_projects().unwrap().is_empty());
    }

    #[test]
    fn alpha_map_preview_uses_real_scans_without_connecting_writing_or_reading_env() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("package.json"), r#"{"dependencies":{"react":"1"}}"#).unwrap();
        fs::write(dir.path().join("app.ts"), "import app from './model';\n").unwrap();
        fs::write(dir.path().join(".env"), "PRIVATE_VALUE=synthetic-do-not-leak").unwrap();
        let env = fs::File::options().read(true).write(true).open(dir.path().join(".env")).unwrap();
        env.try_lock().unwrap();
        let snapshot = || {
            let mut files: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| {
                let e = e.unwrap(); let m = e.metadata().unwrap(); (e.file_name(), m.len(), m.modified().unwrap())
            }).collect();
            files.sort(); files
        };
        let before = snapshot();
        let map = scan_project_map(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(snapshot(), before);
        assert_eq!(map.imports.files.len(), 1);
        assert_eq!(map.imports.files[0].specifiers, ["./model"]);
        assert!(!map.inventory.manifests.is_empty());
        let value = serde_json::to_value(&map).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert!(value["inventory"]["scannedAtMs"].is_number());
        assert!(value["imports"]["scannedAtMs"].is_number());
        assert!(!value.to_string().contains("synthetic-do-not-leak"));
        assert!(!dir.path().join(".claude").exists());
    }

    #[test]
    fn alpha_map_preview_rejects_a_file_or_missing_root() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file"); fs::write(&file, []).unwrap();
        assert!(scan_project_map(file.to_str().unwrap()).is_err());
        assert!(scan_project_map(dir.path().join("gone").to_str().unwrap()).is_err());
    }

    #[test]
    fn alpha_connections_manifest_tracks_connect_disconnect_and_startup() {
        let (data, core) = open();
        let root = tempfile::tempdir().unwrap();
        let root = paths::project_root(root.path()).unwrap();
        let id = project_id(&root);
        let command = connect::hook_command(Path::new("C:/Raio/raio-hook.exe"), &id, &root);
        let preview = connect::preview(&root, &command).unwrap();
        let project = core.connect_at(root.clone(), id.clone(), command, &preview).unwrap();
        let manifest = || serde_json::from_slice::<serde_json::Value>(&fs::read(data.path().join("connections.json")).unwrap()).unwrap();
        assert_eq!(manifest(), serde_json::json!([{ "root": project.root, "settingsPath": connect::settings_path(&root).to_string_lossy() }]));
        fs::write(data.path().join("connections.json"), b"stale").unwrap();
        drop(core);
        let core = Core::open_at(data.path()).unwrap();
        assert_eq!(manifest().as_array().unwrap().len(), 1, "startup rebuilds from the database");
        let other = tempfile::tempdir().unwrap();
        let other_root = paths::project_root(other.path()).unwrap();
        let other_id = project_id(&other_root);
        let command = connect::hook_command(Path::new("C:/Raio/raio-hook.exe"), &other_id, &other_root);
        let preview = connect::preview(&other_root, &command).unwrap();
        core.connect_at(other_root.clone(), other_id.clone(), command, &preview).unwrap();
        assert_eq!(manifest().as_array().unwrap().len(), 2);
        core.disconnect_id(&id).unwrap();
        assert_eq!(manifest(), serde_json::json!([{ "root": other_root, "settingsPath": connect::settings_path(&other_root) }]));
        core.disconnect_id(&other_id).unwrap();
        assert_eq!(manifest(), serde_json::json!([]));
        assert!(core.store.lock().unwrap().connected_projects().unwrap().is_empty());
        assert!(!fs::read_dir(data.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn a_failed_connections_rewrite_leaves_no_stale_list_behind() {
        let (data, core) = open();
        let path = data.path().join(CONNECTIONS_FILE);
        assert_eq!(fs::read(&path).unwrap(), b"[]", "startup publishes the empty list");
        let root = tempfile::tempdir().unwrap();
        let root = paths::project_root(root.path()).unwrap();
        let id = project_id(&root);
        let command = connect::hook_command(Path::new("C:/Raio/raio-hook.exe"), &id, &root);
        let preview = connect::preview(&root, &command).unwrap();
        FAIL_CONNECTIONS_WRITE.with(|fail| fail.set(true));
        core.connect_at(root, id.clone(), command, &preview).unwrap();
        assert!(!path.exists(), "the old empty list must not survive a connect whose rewrite failed");
        assert!(data.path().join(CONNECTIONS_PENDING).exists(), "readers are told the list is unknown");
        FAIL_CONNECTIONS_WRITE.with(|fail| fail.set(false));
        core.disconnect_id(&id).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"[]");
        assert!(!data.path().join(CONNECTIONS_PENDING).exists(), "a successful rewrite clears the marker");
    }

    #[test]
    fn concurrent_connection_changes_never_leave_a_list_without_its_pending_marker() {
        let (data, core) = open();
        let core = std::sync::Arc::new(core);
        let roots: Vec<_> = (0..4).map(|_| tempfile::tempdir().unwrap()).collect();
        let workers: Vec<_> = roots.iter().map(|dir| {
            let (core, root) = (core.clone(), paths::project_root(dir.path()).unwrap());
            std::thread::spawn(move || {
                let id = project_id(&root);
                let command = connect::hook_command(Path::new("C:/Raio/raio-hook.exe"), &id, &root);
                for _ in 0..3 {
                    let preview = connect::preview(&root, &command).unwrap();
                    core.connect_at(root.clone(), id.clone(), command.clone(), &preview).unwrap();
                    core.disconnect_id(&id).unwrap();
                }
            })
        }).collect();
        for worker in workers { worker.join().unwrap(); }
        assert_eq!(fs::read(data.path().join(CONNECTIONS_FILE)).unwrap(), b"[]");
        assert!(!data.path().join(CONNECTIONS_PENDING).exists());
    }

    #[test]
    fn alpha_connections_manifest_write_failure_never_fails_connection_changes() {
        let (data, core) = open();
        let path = data.path().join("connections.json");
        let _ = fs::remove_file(&path); fs::create_dir(&path).unwrap();
        let root = tempfile::tempdir().unwrap();
        let root = paths::project_root(root.path()).unwrap();
        let id = project_id(&root);
        let command = connect::hook_command(Path::new("C:/Raio/raio-hook.exe"), &id, &root);
        let preview = connect::preview(&root, &command).unwrap();
        core.connect_at(root, id.clone(), command, &preview).unwrap();
        core.disconnect_id(&id).unwrap();
        assert!(core.store.lock().unwrap().connected_projects().unwrap().is_empty());
        drop(core);
        assert!(Core::open_at(data.path()).is_ok(), "startup manifest failure is also best effort");
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
    fn project_hooks_state_reads_the_connected_project_without_writing_settings_or_backups() {
        let (_d, core) = open();
        let dir = tempfile::tempdir().unwrap();
        let project = Project { id: "p1".into(), root: dir.path().to_string_lossy().into_owned(), name: "demo".into(), connected_at: 1 };
        core.store.lock().unwrap().upsert_project(&project).unwrap();
        let hook = Path::new("C:/Raio/raio-hook.exe");
        let command = connect::hook_command(hook, "p1", dir.path());
        let settings = connect::with_raio(serde_json::json!({}), &command).unwrap();
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        let original = serde_json::to_string_pretty(&settings).unwrap();
        fs::write(connect::settings_path(dir.path()), &original).unwrap();
        assert_eq!(hooks_state_for(&core, "p1", Some(hook)).unwrap(), connect::HooksState::Current);
        assert_eq!(hooks_state_for(&core, "p1", None).unwrap(), connect::HooksState::Unknown);
        assert_eq!(fs::read_to_string(connect::settings_path(dir.path())).unwrap(), original);
        assert!(!core.backups.exists());
        assert_eq!(fs::read_dir(dir.path().join(".claude")).unwrap().count(), 1);
    }

    #[test]
    fn project_hooks_state_unknown_or_disconnected_project_is_an_error() {
        let (_d, core) = open();
        assert_eq!(hooks_state_for(&core, "nope", None).unwrap_err(), "unknown project");
        let project = Project { id: "p1".into(), root: "C:/fixture/app".into(), name: "demo".into(), connected_at: 1 };
        core.store.lock().unwrap().upsert_project(&project).unwrap();
        core.store.lock().unwrap().disconnect_project("p1", 2).unwrap();
        assert_eq!(hooks_state_for(&core, "p1", None).unwrap_err(), "unknown project");
    }

    #[test]
    fn the_root_of_a_connected_project_is_found_and_an_unknown_or_disconnected_id_is_an_error() {
        let (_d, core) = open();
        let project = Project { id: "p1".into(), root: "C:/work/demo".into(), name: "demo".into(), connected_at: 1 };
        core.store.lock().unwrap().upsert_project(&project).unwrap();
        assert_eq!(core.connected_root("p1").unwrap(), PathBuf::from("C:/work/demo"));
        assert!(core.connected_root("nope").is_err());
        core.store.lock().unwrap().disconnect_project("p1", 2).unwrap();
        assert!(core.connected_root("p1").is_err(), "a disconnected project is not scanned");
    }

    #[test]
    fn drop_accounting_legacy_backlog_keeps_housekeeping_in_catch_up() {
        let (_d, core) = open();
        for i in 0..3100 {
            fs::write(core.dirs.dropped.join(format!("legacy-{i}")), b"").unwrap();
        }
        let first = core.housekeeping(SystemTime::now(), &Limits::default());
        assert_eq!(first.inbox.markers_removed, 1000);
        assert!(first.more, "a 1000-removal pass hit its 2000-entry scan bound with backlog remaining");
        let second = core.housekeeping(SystemTime::now(), &Limits::default());
        assert_eq!(second.inbox.markers_removed, 1000);
        assert!(second.more);
        let third = core.housekeeping(SystemTime::now(), &Limits::default());
        assert_eq!(third.inbox.markers_removed, 100);
        assert!(!third.more);
        assert_eq!(inbox::dropped_count(&core.dirs), 1000);
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
