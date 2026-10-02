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

use tauri::Manager;

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
    let mut context = tauri::generate_context!();
    // Launched straight into the Island or the Mini Player: the Expanded window must not flash up first.
    if matches!(surfaces::launch_surface(std::env::args()), Some(Ok(surface)) if surface != surfaces::EXPANDED) {
        surfaces::start_expanded_hidden(context.config_mut());
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(island::IslandState::default())
        .manage(surfaces::SurfaceState::default())
        .manage(core)
        .invoke_handler(tauri::generate_handler![
            surfaces::show_surface,
            surfaces::set_always_on_top,
            surfaces::take_surface_intent,
            island::set_island_hit_rect,
            core::core_status,
            core::list_projects,
            core::project_events,
            core::preview_connect,
            core::connect_project,
            core::disconnect_project,
        ])
        .setup(|app| {
            tray::install(app.handle())?;
            core::start(app.handle());
            app.state::<surfaces::SurfaceState>().mark_main_thread();
            // `--surface=island|mini|expanded` chooses the surface shown at launch (default: expanded).
            match surfaces::launch_surface(std::env::args()) {
                None => {}
                Some(Err(name)) => eprintln!("Raio ignores --surface={name}: expected expanded, island or mini"),
                Some(Ok(surface)) => {
                    // Off the main thread: showing the Island or the Mini Player may have to create its webview.
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        if let Err(e) = surfaces::show(&handle, surface, None) {
                            eprintln!("Raio could not show the {surface} surface: {e}");
                            if surface != surfaces::EXPANDED {
                                let _ = surfaces::show(&handle, surfaces::EXPANDED, None);
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .run(context)
        .expect("error while running Raio");
}
