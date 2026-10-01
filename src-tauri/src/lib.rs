//! Raio desktop core: windows, tray and (later) local ingestion. All product semantics live in the renderer.

mod island;
mod surfaces;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(island::IslandState::default())
        .invoke_handler(tauri::generate_handler![
            surfaces::show_surface,
            surfaces::set_always_on_top,
            island::set_island_hit_rect,
        ])
        .setup(|app| {
            surfaces::create_floating_surfaces(app.handle())?;
            tray::install(app.handle())?;
            island::spawn_cursor_watch(app.handle().clone());
            // `--surface=island|mini|expanded` chooses the surface shown at launch (default: expanded).
            if let Some(surface) = std::env::args().find_map(|a| a.strip_prefix("--surface=").map(str::to_owned)) {
                surfaces::show_surface(app.handle().clone(), surface, None)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Raio");
}
