//! The three product surfaces are separate native windows. Exactly one is shown at a time. The Expanded
//! window comes from the app config; the Island and the Mini Player are usually hidden, so each is
//! created the first time it is shown instead of at startup (a webview costs real memory). When Raio is
//! launched straight into the Island or the Mini Player the Expanded window is held back the same way:
//! creating it first would put a whole hidden webview ahead of the surface the user asked for.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock, mpsc};
use std::thread::{self, ThreadId};
use std::time::Duration;

use tauri::utils::config::WindowConfig;
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
    /// The config of an Expanded window that was not created at startup; consumed by its first `show`.
    deferred_expanded: Mutex<Option<WindowConfig>>,
}

impl SurfaceState {
    pub fn with_deferred_expanded(config: Option<WindowConfig>) -> Self {
        Self { deferred_expanded: Mutex::new(config), ..Self::default() }
    }

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

/// The product title bar is Expanded's window chrome on Windows. Apply before startup creation or
/// deferral so both paths keep the same window sizing, centering and native edge-resize behaviour.
pub fn configure_expanded_chrome(config: &mut tauri::Config) {
    if cfg!(windows)
        && let Some(window) = config.app.windows.iter_mut().find(|w| w.label == EXPANDED)
    {
        window.decorations = false;
    }
}

/// The Expanded window comes from the app config and would be created, with its webview, before anything
/// else. When Raio is launched straight into the Island or the Mini Player, take it out of the config so it
/// is created on first use instead: it would otherwise sit hidden, blank, ahead of the requested surface in
/// the startup queue (hiding it later, even in `setup`, still leaves it on screen for the half second the
/// webview takes to come up). Returns its config so `show` can create it later.
pub fn defer_expanded(config: &mut tauri::Config) -> Option<WindowConfig> {
    let at = config.app.windows.iter().position(|w| w.label == EXPANDED)?;
    Some(config.app.windows.remove(at))
}

/// Whether closing this window (its X button, Alt+F4) minimizes it instead of destroying it.
pub fn minimizes_on_close(label: &str) -> bool {
    label == EXPANDED
}

/// Whether `show` must un-minimize this window first: a window the user minimized (or whose X minimized it)
/// stays iconic after a plain `show`, and focusing it would not bring it back. Only Expanded has a taskbar
/// entry to be minimized from, and a window that is not minimized is left exactly as it is.
fn restores_before_show(label: &str, minimized: bool) -> bool {
    minimized && label == EXPANDED
}

/// Whether an exit request is to be refused: `None` is the runtime asking because no window is left.
pub fn prevents_exit(code: Option<i32>) -> bool {
    prevents_exit_on(cfg!(windows), code)
}

/// Only the Windows behaviour was observed: on macOS Cmd+Q or the Dock's Quit may arrive as `None` and must
/// still quit, so other platforms never refuse.
fn prevents_exit_on(windows: bool, code: Option<i32>) -> bool {
    windows && code.is_none()
}

/// Closing Expanded (its X button, Alt+F4) minimizes it: its taskbar entry stays and restoring it brings it
/// back as it was. A destroyed window would leave the tray's "Open Raio", a second launch and the Island's
/// "Open" with nothing to show (and, with no other window, would end the app). Hooked to `RunEvent::WindowEvent` because that is where the
/// close request of every window was observed to arrive: in this build (tauri 2.12.1, Windows) neither
/// `Builder::on_window_event` nor a per-window listener was ever called for the window created from the
/// startup config, only for windows built later. No `show` lock on purpose: this runs on the main thread,
/// which `show` may be waiting on to build a webview.
///
/// No `surface-visible` event is sent on minimize: the window is still the surface that is shown, and the
/// renderer already folds "minimized" into its visibility (see `surfaceVisibilityTracker.ts`), so it stops
/// animating by itself and `show` need not special-case a restore. If the window cannot be minimized, it is
/// hidden instead (and told so), so the X never does nothing.
///
/// Also keeps Raio alive when the last window goes (e.g. the Mini Player of a `--surface=mini` launch
/// closed with Alt+F4): only an explicit exit, the tray's "Quit Raio" (`app.exit(0)`), ends the app.
pub fn on_run_event(app: &AppHandle, event: &tauri::RunEvent) {
    match event {
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if minimizes_on_close(label) => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window(label)
                && let Err(e) = window.minimize()
            {
                eprintln!("Raio could not minimize the {label} window, hiding it instead: {e}");
                let _ = window.hide();
                // Hidden webviews may keep animating; tell the surface it is off screen.
                let _ = app.emit_to(label.as_str(), "surface-visible", false);
            }
        }
        tauri::RunEvent::ExitRequested { code, api, .. } if prevents_exit(*code) => api.prevent_exit(),
        _ => {}
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

/// The deferred Expanded window, built from its original config but hidden: `show` reveals it once its
/// page has loaded.
fn deferred_expanded(app: &AppHandle, config: &WindowConfig, loaded: mpsc::Sender<()>) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::from_config(app, config)?
        .visible(false)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = loaded.send(());
            }
        })
        .build()
}

/// Creates a surface's window on first use, hidden: the Island or the Mini Player (placed), or the Expanded
/// window when it was deferred at launch. `Ok(None)` when it already exists (or Expanded was never
/// deferred); otherwise a receiver that fires when its page finished loading. A window that cannot be
/// configured is destroyed and reported, never left half set up. The caller holds the `show` lock and is off
/// the main thread (building a webview there deadlocks on Windows).
fn ensure_window(app: &AppHandle, state: &SurfaceState, label: &str) -> tauri::Result<Option<mpsc::Receiver<()>>> {
    if app.get_webview_window(label).is_some() {
        return Ok(None);
    }
    let deferred = if label == EXPANDED {
        match state.deferred_expanded.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            Some(config) => Some(config),
            None => return Ok(None),
        }
    } else {
        None
    };
    debug_assert!(
        state.main_thread.get() != Some(&thread::current().id()),
        "surfaces::show must not create a webview on the main thread"
    );
    let (tx, rx) = mpsc::channel();
    let window = match &deferred {
        Some(config) => deferred_expanded(app, config, tx)?,
        None => floating(app, label, if label == ISLAND { ISLAND_SIZE } else { MINI_SIZE }, tx)?,
    };
    if deferred.is_some() {
        // Built: later shows find the window itself.
        *state.deferred_expanded.lock().unwrap_or_else(|e| e.into_inner()) = None;
    } else if let Err(e) = configure(&window, label) {
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

/// Shows one surface and hides the others. Only the Expanded window takes keyboard focus (and is restored
/// first when it was minimized). The Island and
/// the Mini Player (and the Expanded window, when Raio was launched into one of them) are created the first
/// time they are shown (the page is given up to a second to load first, so the window does not appear
/// blank). An optional intent (e.g. "replay") is stored for the surface to pull, or emitted as
/// `surface-intent` when it already pulled.
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
    let fresh = ensure_window(app, &state, surface).map_err(|e| e.to_string())?;
    if let Some(loaded) = fresh {
        // The surface on screen stays up meanwhile.
        let _ = loaded.recv_timeout(LOAD_WAIT);
    }
    for label in SURFACES {
        let Some(window) = app.get_webview_window(label) else { continue };
        let result = if label == surface {
            let minimized = window.is_minimized().unwrap_or(false);
            window
                .show()
                .and_then(|_| if restores_before_show(label, minimized) { window.unminimize() } else { Ok(()) })
                .and_then(|_| if label == EXPANDED { window.set_focus() } else { Ok(()) })
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

    #[test]
    fn expanded_uses_product_chrome_on_windows_without_changing_other_surfaces() {
        let mut config = tauri::Config::default();
        config.app.windows = vec![
            WindowConfig { label: EXPANDED.into(), min_width: Some(960.0), min_height: Some(520.0), center: true, ..Default::default() },
            WindowConfig { label: MINI.into(), ..Default::default() },
        ];
        configure_expanded_chrome(&mut config);
        let expanded = &config.app.windows[0];
        assert_eq!(expanded.decorations, !cfg!(windows));
        assert!(expanded.resizable);
        assert!(expanded.center);
        assert_eq!((expanded.min_width, expanded.min_height), (Some(960.0), Some(520.0)));
        assert!(config.app.windows[1].decorations);
        let deferred = defer_expanded(&mut config).unwrap();
        assert_eq!(deferred.decorations, !cfg!(windows), "lazy creation must keep the same chrome");
    }

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
    fn deferring_expanded_takes_only_that_window_out_of_the_config_and_hands_it_back() {
        let window = |label: &str| tauri::utils::config::WindowConfig { label: label.into(), ..Default::default() };
        let mut config = tauri::Config::default();
        config.app.windows = vec![window("other"), window(EXPANDED)];
        let held = defer_expanded(&mut config).expect("the Expanded window was in the config");
        assert_eq!(held.label, EXPANDED);
        let left: Vec<&str> = config.app.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(left, ["other"], "nothing else is touched, and Expanded is no longer created at startup");
        assert!(defer_expanded(&mut config).is_none(), "a config without an Expanded window has nothing to defer");
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
    fn closing_expanded_minimizes_it_so_it_can_be_shown_again() {
        assert!(minimizes_on_close(EXPANDED));
        assert!(!minimizes_on_close(ISLAND), "recreated by ensure_window on its next show");
        assert!(!minimizes_on_close(MINI));
        assert!(!minimizes_on_close("other"));
    }

    #[test]
    fn showing_expanded_restores_it_only_when_it_is_minimized() {
        assert!(restores_before_show(EXPANDED, true), "a minimized window stays minimized after a plain show");
        assert!(!restores_before_show(EXPANDED, false), "unminimizing a normal or maximized window would change it");
        assert!(!restores_before_show(MINI, true), "floating surfaces have no taskbar entry to minimize from");
        assert!(!restores_before_show(ISLAND, true));
    }

    #[test]
    fn closing_the_last_window_keeps_raio_in_the_tray_but_an_explicit_exit_quits() {
        assert!(prevents_exit_on(true, None), "Windows: no window left, stay in the tray");
        assert!(!prevents_exit_on(true, Some(0)), "tray Quit Raio calls app.exit(0)");
        assert!(!prevents_exit_on(true, Some(1)));
        assert_eq!(prevents_exit(None), cfg!(windows));
    }

    #[test]
    fn other_platforms_always_quit_when_asked() {
        // macOS Cmd+Q / Dock Quit may arrive as `None` and must still quit (macOS is not verified).
        assert!(!prevents_exit_on(false, None));
        assert!(!prevents_exit_on(false, Some(0)));
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
