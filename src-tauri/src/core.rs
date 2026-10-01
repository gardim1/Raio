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
use crate::paths;
use crate::store::{Insert, Project, Store};
use crate::watch::{self, ProjectWatch};

const INGEST_EVERY: Duration = Duration::from_millis(500);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(3600);
pub const INGESTED_EVENT: &str = "events-ingested";

pub struct Core {
    pub dirs: Dirs,
    pub store: Mutex<Store>,
    watches: Mutex<HashMap<String, ProjectWatch>>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Core {
    pub fn open() -> Result<Core, String> {
        let data = paths::data_dir().ok_or("no per-user data directory")?;
        fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let dirs = Dirs::new(&data);
        dirs.create().map_err(|e| e.to_string())?;
        inbox::touch_heartbeat(&dirs).map_err(|e| e.to_string())?;
        let store = Store::open(&data.join("raio.db"), now_ms()).map_err(|e| e.to_string())?;
        let _ = store.apply_retention(now_ms());
        Ok(Core { dirs, store: Mutex::new(store), watches: Mutex::default() })
    }

    /// Moves pending inbox records into the store. Returns how many new events were stored.
    pub fn ingest_once(&self) -> usize {
        let pending = inbox::pending(&self.dirs, 500);
        let Ok(store) = self.store.lock() else { return 0 };
        let mut stored = 0;
        for p in pending {
            match p.event {
                Ok(event) => match store.insert(&event, now_ms()) {
                    // Delete only after the row is committed; a crash in between is covered by dedupe.
                    Ok(Insert::Inserted(_)) => {
                        stored += 1;
                        let _ = fs::remove_file(&p.path);
                    }
                    Ok(Insert::Duplicate | Insert::Capped) => {
                        let _ = fs::remove_file(&p.path);
                    }
                    Err(_) => {} // leave it for the next pass
                },
                Err(_) => inbox::quarantine(&self.dirs, &p.path),
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
            since_heartbeat += INGEST_EVERY;
            if since_heartbeat >= HEARTBEAT_EVERY {
                let _ = inbox::touch_heartbeat(&core.dirs);
                since_heartbeat = Duration::ZERO;
            }
            thread::sleep(INGEST_EVERY);
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

#[tauri::command]
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

#[tauri::command]
pub fn list_projects(core: State<'_, Core>) -> Result<Vec<Project>, String> {
    core.store.lock().map_err(|e| e.to_string())?.connected_projects().map_err(|e| e.to_string())
}

#[tauri::command]
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

#[tauri::command]
pub fn preview_connect(root: String) -> Result<connect::Preview, String> {
    let (root, _, command) = root_and_command(&root)?;
    connect::preview(&root, &command)
}

#[tauri::command]
pub fn connect_project(app: AppHandle, core: State<'_, Core>, root: String, previewed: connect::Preview) -> Result<Project, String> {
    let (root_path, id, command) = root_and_command(&root)?;
    connect::connect(&root_path, &command, &previewed, now_ms())?;
    let name = root_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
    let project = Project { id, root: root_path.to_string_lossy().into_owned(), name, connected_at: now_ms() };
    core.store.lock().map_err(|e| e.to_string())?.upsert_project(&project).map_err(|e| e.to_string())?;
    let _ = inbox::touch_heartbeat(&core.dirs);
    core.start_watch(&app, &project);
    let _ = app.emit(INGESTED_EVENT, ());
    Ok(project)
}

#[tauri::command]
pub fn disconnect_project(app: AppHandle, core: State<'_, Core>, project_id: String) -> Result<(), String> {
    let store = core.store.lock().map_err(|e| e.to_string())?;
    let project = store.connected_projects().map_err(|e| e.to_string())?.into_iter().find(|p| p.id == project_id).ok_or("unknown project")?;
    connect::disconnect(Path::new(&project.root))?;
    store.disconnect_project(&project_id, now_ms()).map_err(|e| e.to_string())?;
    if let Ok(mut w) = core.watches.lock() {
        w.remove(&project_id);
    }
    let _ = app.emit(INGESTED_EVENT, ());
    Ok(())
}
