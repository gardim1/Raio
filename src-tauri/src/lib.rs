//! Raio desktop core: windows, tray, local ingestion and persistence. Product semantics (grouping,
//! notices, replay) live in the renderer; this crate does I/O and durability.

pub mod claude;
pub mod connect;
mod core;
pub mod event;
pub mod inbox;
pub mod instance;
mod island;
pub mod paths;
pub mod store;
mod surfaces;
mod tray;
pub mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let Some(data) = paths::data_dir() else {
        eprintln!("Raio could not find its per-user data directory");
        std::process::exit(1);
    };
    // One Raio per user: a second launch asks the running one to come forward and exits. The lock lives
    // until the process ends (the OS also releases it if Raio crashes).
    let _instance = match instance::acquire(&data) {
        Ok(instance::Acquire::First(lock)) => lock,
        Ok(instance::Acquire::AlreadyRunning) => {
            let _ = instance::request_show(&data);
            return;
        }
        Err(e) => {
            eprintln!("Raio could not take its instance lock: {e}");
            std::process::exit(1);
        }
    };
    let core = match core::Core::open() {
        Ok(core) => core,
        Err(e) => {
            eprintln!("Raio could not open its local data: {e}");
            std::process::exit(1);
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(island::IslandState::default())
        .manage(core)
        .invoke_handler(tauri::generate_handler![
            surfaces::show_surface,
            surfaces::set_always_on_top,
            island::set_island_hit_rect,
            core::core_status,
            core::list_projects,
            core::project_events,
            core::preview_connect,
            core::connect_project,
            core::disconnect_project,
        ])
        .setup(|app| {
            surfaces::create_floating_surfaces(app.handle())?;
            tray::install(app.handle())?;
            island::spawn_cursor_watch(app.handle().clone());
            core::start(app.handle());
            // `--surface=island|mini|expanded` chooses the surface shown at launch (default: expanded).
            if let Some(surface) = std::env::args().find_map(|a| a.strip_prefix("--surface=").map(str::to_owned)) {
                surfaces::show_surface(app.handle().clone(), surface, None)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Raio");
}
