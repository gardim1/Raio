//! Raio desktop core: windows, tray, local ingestion and persistence. Product semantics (grouping,
//! notices, replay) live in the renderer; this crate does I/O and durability.

pub mod claude;
pub mod connect;
mod core;
pub mod event;
pub mod hook_guard;
pub mod imports;
pub mod inbox;
pub mod inventory;
pub mod instance;
mod island;
pub mod paths;
pub mod store;
mod surfaces;
mod tray;
pub mod watch;

use tauri::Manager;

/// True when Raio starts straight into the Island or the Mini Player, so the Expanded window is created on
/// first use instead of at startup. An absent or invalid `--surface` (and `expanded` itself) keeps the
/// normal startup: the Expanded window is created and shown.
fn defers_expanded(launch: &Option<Result<&'static str, String>>) -> bool {
    matches!(launch, Some(Ok(surface)) if *surface != surfaces::EXPANDED)
}

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
    surfaces::configure_expanded_chrome(context.config_mut());
    // Launched straight into the Island or the Mini Player: the Expanded window is created when first shown,
    // so neither a hidden webview nor a flash of it comes before the surface that was asked for.
    let launch = surfaces::launch_surface(std::env::args());
    let deferred_expanded = if defers_expanded(&launch) { surfaces::defer_expanded(context.config_mut()) } else { None };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(island::IslandState::default())
        .manage(surfaces::SurfaceState::with_deferred_expanded(deferred_expanded))
        .manage(core)
        .invoke_handler(tauri::generate_handler![
            surfaces::show_surface,
            surfaces::set_always_on_top,
            surfaces::take_surface_intent,
            island::set_island_hit_rect,
            core::core_status,
            core::list_projects,
            core::project_events,
            core::project_hooks_state,
            core::preview_connect,
            core::connect_project,
            core::disconnect_project,
            imports::project_imports,
            inventory::project_inventory,
        ])
        .setup(|app| {
            tray::install(app.handle())?;
            core::start(app.handle());
            app.state::<surfaces::SurfaceState>().mark_main_thread();
            // `--surface=island|mini|expanded` chooses the surface shown at launch (default: expanded).
            match launch {
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
        .build(context)
        .expect("error while building Raio")
        .run(|app, event| surfaces::on_run_event(app, &event));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_launch_into_the_island_or_the_mini_player_defers_the_expanded_window() {
        assert!(!defers_expanded(&None), "no --surface: Expanded opens as usual");
        assert!(!defers_expanded(&Some(Ok(surfaces::EXPANDED))), "asked for Expanded: create it now");
        assert!(defers_expanded(&Some(Ok(surfaces::ISLAND))));
        assert!(defers_expanded(&Some(Ok(surfaces::MINI))));
        assert!(!defers_expanded(&Some(Err("bogus".into()))), "an invalid surface falls back to the normal startup");
    }
}
