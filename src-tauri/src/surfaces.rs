//! The three product surfaces are separate native windows. Exactly one is shown at a time. The Expanded
//! window comes from the app config; the Island and the Mini Player are usually hidden, so each is
//! created the first time it is shown instead of at startup (a webview costs real memory).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock, mpsc};
use std::thread::{self, ThreadId};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::island;

pub const EXPANDED: &str = "expanded";
pub const ISLAND: &str = "island";
pub const MINI: &str = "mini";
const SURFACES: [&str; 3] = [EXPANDED, ISLAND, MINI];

/// Logical size of the Island window: room for the open capsule (384x156) plus margins.
pub const ISLAND_SIZE: (f64, f64) = (420.0, 184.0);
const MINI_SIZE: (f64, f64) = (380.0, 300.0);
const EDGE_MARGIN: f64 = 24.0;

/// How long a freshly created window may take to load its page before it is shown anyway.
const LOAD_WAIT: Duration = Duration::from_secs(1);

/// Pending `surface-intent`s, pulled by the renderer on mount (`take_surface_intent`). An event emitted
/// while a freshly created page is still loading would be lost, so the intent waits here until the window
/// has pulled once; afterwards it is emitted live.
#[derive(Default)]
pub struct Intents {
    pending_intent: HashMap<String, String>,
    pulled: HashSet<String>,
}

impl Intents {
    /// Stores `intent` for `label`. True when the window has already pulled (its listener is up): the caller
    /// must then emit it now, and nothing is left pending.
    pub fn record(&mut self, label: &str, intent: &str) -> bool {
        if self.pulled.contains(label) {
            self.pending_intent.remove(label);
            true
        } else {
            self.pending_intent.insert(label.to_owned(), intent.to_owned());
            false
        }
    }

    /// The renderer's pull: returns and clears the pending intent and marks the window as pulled.
    pub fn take(&mut self, label: &str) -> Option<String> {
        self.pulled.insert(label.to_owned());
        self.pending_intent.remove(label)
    }

    /// A window with this label was just created: it has not pulled and anything pending was for its predecessor.
    pub fn reset(&mut self, label: &str) {
        self.pulled.remove(label);
        self.pending_intent.remove(label);
    }
}

/// Managed state of the surfaces.
#[derive(Default)]
pub struct SurfaceState {
    /// Held for the whole of `show`: window creation, hide/show of the three windows, the emits and the
    /// cursor-watch start. Two shows (tray, IPC, startup, a second launch) can never interleave.
    show: Mutex<()>,
    intents: Mutex<Intents>,
    main_thread: OnceLock<ThreadId>,
}

impl SurfaceState {
    /// Called once from the main thread (setup) so that creating a webview there can be caught in debug builds.
    pub fn mark_main_thread(&self) {
        let _ = self.main_thread.set(thread::current().id());
    }

    fn intents(&self) -> MutexGuard<'_, Intents> {
        self.intents.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The renderer's pull of the intent a `show` left for its window, called once on mount (after it has
/// registered its `surface-intent` listener). Returns it and clears it; from then on the core emits
/// intents to this window live.
#[tauri::command]
pub fn take_surface_intent(window: WebviewWindow, state: State<'_, SurfaceState>) -> Option<String> {
    state.intents().take(window.label())
}

/// `--surface=<name>` from the launch arguments: `None` when absent, `Err(name)` when it is not a surface.
pub fn launch_surface(args: impl IntoIterator<Item = String>) -> Option<Result<&'static str, String>> {
    let name = args.into_iter().find_map(|a| a.strip_prefix("--surface=").map(str::to_owned))?;
    Some(SURFACES.iter().copied().find(|s| *s == name).ok_or(name))
}

/// The Expanded window comes from the app config and would be created visible. When Raio is launched straight
/// into the Island or the Mini Player, create it hidden instead: hiding it later (even in `setup`) still
/// leaves it on screen, blank, for the half second the webview takes to come up.
pub fn start_expanded_hidden(config: &mut tauri::Config) {
    for window in config.app.windows.iter_mut().filter(|w| w.label == EXPANDED) {
        window.visible = false;
    }
}

fn floating(app: &AppHandle, label: &str, size: (f64, f64), loaded: mpsc::Sender<()>) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("index.html?surface={label}").into()))
        // The Island must never take focus from the user's editor, even when clicked.
        .focusable(label != ISLAND)
        .title("Raio")
        .inner_size(size.0, size.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = loaded.send(());
            }
        })
        .build()
}

/// Where a floating surface sits on the primary display, in physical pixels: the Island top-centre,
/// the Mini Player bottom-right. `None` for surfaces that are not placed by Raio.
pub fn placement(label: &str, origin: (i32, i32), size: (u32, u32), scale: f64) -> Option<(i32, i32)> {
    match label {
        ISLAND => {
            let island_w = (ISLAND_SIZE.0 * scale) as i32;
            Some((origin.0 + (size.0 as i32 - island_w) / 2, origin.1))
        }
        MINI => {
            let (mini_w, mini_h) = ((MINI_SIZE.0 * scale) as i32, (MINI_SIZE.1 * scale) as i32);
            let margin = (EDGE_MARGIN * scale) as i32;
            Some((origin.0 + size.0 as i32 - mini_w - margin, origin.1 + size.1 as i32 - mini_h - margin * 3))
        }
        _ => None,
    }
}

/// Sets up a window that was just built: click-through for the Island first (a transparent Island must
/// never swallow clicks), then its place on the primary display.
fn configure(window: &WebviewWindow, label: &str) -> tauri::Result<()> {
    if label == ISLAND {
        // Until the renderer publishes the capsule rectangle, the transparent Island lets clicks through.
        window.set_ignore_cursor_events(true)?;
    }
    if let Some(monitor) = window.primary_monitor()? {
        let (origin, extent) = (monitor.position(), monitor.size());
        if let Some((x, y)) = placement(label, (origin.x, origin.y), (extent.width, extent.height), monitor.scale_factor()) {
            window.set_position(PhysicalPosition::new(x, y))?;
        }
    }
    Ok(())
}

/// Creates the Island or the Mini Player on first use, hidden and placed. `Ok(None)` when it already exists;
/// otherwise a receiver that fires when its page finished loading. A window that cannot be configured is
/// destroyed and reported, never left half set up. The caller holds the `show` lock and is off the main
/// thread (building a webview there deadlocks on Windows).
fn ensure_floating(app: &AppHandle, state: &SurfaceState, label: &str) -> tauri::Result<Option<mpsc::Receiver<()>>> {
    if app.get_webview_window(label).is_some() {
        return Ok(None);
    }
    debug_assert!(
        state.main_thread.get() != Some(&thread::current().id()),
        "surfaces::show must not create a webview on the main thread"
    );
    let size = if label == ISLAND { ISLAND_SIZE } else { MINI_SIZE };
    let (tx, rx) = mpsc::channel();
    let window = floating(app, label, size, tx)?;
    if let Err(e) = configure(&window, label) {
        eprintln!("Raio could not set up the {label} window: {e}");
        let _ = window.destroy();
        return Err(e);
    }
    // A new page has not pulled anything yet, and what was pending belonged to a window that no longer exists.
    state.intents().reset(label);
    Ok(Some(rx))
}

/// Intents a surface may receive when it is shown.
const INTENTS: [&str; 1] = ["replay"];

/// Shows one surface and hides the others. Only the Expanded window takes keyboard focus. The Island and
/// the Mini Player are created the first time they are shown (the page is given up to a second to load
/// first, so the window does not appear blank). An optional intent (e.g. "replay") is stored for the
/// surface to pull, or emitted as `surface-intent` when it already pulled.
///
/// The whole call is serialised. Call it **off the main thread**: it may have to create a webview, which
/// deadlocks there on Windows (tray menu events and setup must spawn a thread; async commands are fine).
pub fn show(app: &AppHandle, surface: &str, intent: Option<&str>) -> Result<(), String> {
    if !SURFACES.contains(&surface) {
        return Err(format!("unknown surface: {surface}"));
    }
    if let Some(intent) = intent {
        if !INTENTS.contains(&intent) {
            return Err(format!("unknown intent: {intent}"));
        }
    }
    let state = app.state::<SurfaceState>();
    let _show = state.show.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = if surface == EXPANDED { None } else { ensure_floating(app, &state, surface).map_err(|e| e.to_string())? };
    if let Some(loaded) = fresh {
        // The surface on screen stays up meanwhile.
        let _ = loaded.recv_timeout(LOAD_WAIT);
    }
    for label in SURFACES {
        let Some(window) = app.get_webview_window(label) else { continue };
        let result = if label == surface {
            window.show().and_then(|_| if label == EXPANDED { window.set_focus() } else { Ok(()) })
        } else {
            window.hide()
        };
        result.map_err(|e| e.to_string())?;
        // Hidden webviews may keep animating; tell each surface whether it is on screen.
        let _ = app.emit_to(label, "surface-visible", label == surface);
    }
    if surface == ISLAND {
        island::ensure_cursor_watch(app);
    }
    if let Some(intent) = intent {
        let emit_now = state.intents().record(surface, intent);
        if emit_now {
            app.emit_to(surface, "surface-intent", intent).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The renderer's entry point. Async so the first-show webview creation runs off the main thread.
#[tauri::command]
pub async fn show_surface(app: AppHandle, surface: String, intent: Option<String>) -> Result<(), String> {
    show(&app, &surface, intent.as_deref())
}

/// Optional always-on-top for the Mini Player (the "pin" toggle).
#[tauri::command]
pub fn set_always_on_top(app: AppHandle, surface: String, on_top: bool) -> Result<(), String> {
    if surface != MINI {
        return Err("only the Mini Player has an always-on-top toggle".into());
    }
    let window = app.get_webview_window(MINI).ok_or("mini window missing")?;
    window.set_always_on_top(on_top).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_intent_waits_for_the_first_pull_and_is_delivered_once() {
        let mut i = Intents::default();
        assert!(!i.record(MINI, "replay"), "not pulled yet: store, do not emit");
        assert_eq!(i.take(MINI), Some("replay".into()));
        assert_eq!(i.take(MINI), None, "a pull clears it");
    }

    #[test]
    fn after_the_first_pull_intents_are_emitted_live_and_not_kept() {
        let mut i = Intents::default();
        assert_eq!(i.take(MINI), None, "nothing pending, but the window is now known to listen");
        assert!(i.record(MINI, "replay"), "pulled already: emit now");
        assert_eq!(i.take(MINI), None, "a reload must not replay an intent that was already delivered");
    }

    #[test]
    fn intents_are_per_window_and_the_latest_wins() {
        let mut i = Intents::default();
        assert!(!i.record(MINI, "replay"));
        assert!(!i.record(MINI, "replay"));
        assert_eq!(i.take(ISLAND), None);
        assert!(!i.record(EXPANDED, "replay"), "Expanded has not pulled although Island did");
        assert_eq!(i.take(MINI), Some("replay".into()));
        assert_eq!(i.take(EXPANDED), Some("replay".into()));
    }

    #[test]
    fn a_recreated_window_starts_unpulled_with_nothing_pending() {
        let mut i = Intents::default();
        i.take(MINI);
        i.reset(MINI);
        assert!(!i.record(MINI, "replay"), "the new page has not pulled");
        i.reset(MINI);
        assert_eq!(i.take(MINI), None, "what was pending belonged to the old window");
    }

    #[test]
    fn only_the_expanded_window_of_the_config_is_created_hidden() {
        let window = |label: &str| tauri::utils::config::WindowConfig { label: label.into(), ..Default::default() };
        let mut config = tauri::Config::default();
        config.app.windows = vec![window(EXPANDED), window("other")];
        assert!(config.app.windows.iter().all(|w| w.visible), "windows are visible by default");
        start_expanded_hidden(&mut config);
        let visible: Vec<(&str, bool)> = config.app.windows.iter().map(|w| (w.label.as_str(), w.visible)).collect();
        assert_eq!(visible, [(EXPANDED, false), ("other", true)]);
    }

    #[test]
    fn the_launch_surface_is_validated_before_anything_is_hidden() {
        assert_eq!(launch_surface(args(&["raio.exe"])), None);
        assert_eq!(launch_surface(args(&["raio.exe", "--surface=island"])), Some(Ok(ISLAND)));
        assert_eq!(launch_surface(args(&["raio.exe", "--surface=expanded"])), Some(Ok(EXPANDED)));
        assert_eq!(launch_surface(args(&["raio.exe", "--surface=bogus"])), Some(Err("bogus".into())));
        assert_eq!(launch_surface(args(&["raio.exe", "--surface="])), Some(Err(String::new())));
        assert_eq!(launch_surface(args(&["raio.exe", "--surface=mini", "--surface=island"])), Some(Ok(MINI)), "first one wins");
    }

    #[test]
    fn the_island_is_centred_on_the_top_edge_of_the_primary_display() {
        assert_eq!(placement(ISLAND, (0, 0), (2880, 1620), 1.5), Some((1125, 0)));
        assert_eq!(placement(ISLAND, (-1920, 0), (1920, 1080), 1.0), Some((-1170, 0)));
    }

    #[test]
    fn the_mini_player_sits_bottom_right_clear_of_the_taskbar() {
        assert_eq!(placement(MINI, (0, 0), (2880, 1620), 1.5), Some((2274, 1062)));
        assert_eq!(placement(MINI, (-1920, 0), (1920, 1080), 1.0), Some((-404, 708)));
    }

    #[test]
    fn only_the_floating_surfaces_are_placed() {
        assert_eq!(placement(EXPANDED, (0, 0), (1920, 1080), 1.0), None);
        assert_eq!(placement("nope", (0, 0), (1920, 1080), 1.0), None);
    }
}
