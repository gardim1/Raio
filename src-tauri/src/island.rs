//! Island hover and click-through. The Island window is transparent and larger than the capsule:
//! outside the capsule rectangle (published by the renderer, in CSS pixels) it ignores the cursor
//! so clicks reach the window beneath. A low-rate cursor poll toggles that, and runs only while the Island is visible.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::surfaces::ISLAND;

const NEAR_POLL: Duration = Duration::from_millis(33);
// An arrival from far away waits at most this sleep before the next sample, excluding OS/IPC delays.
const FAR_POLL: Duration = Duration::from_millis(80);
const NEAR_PADDING: f64 = 48.0;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl HitRect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

fn poll_delay(rect: Option<HitRect>, local_cursor: Option<(f64, f64)>) -> Duration {
    if let (Some(rect), Some((x, y))) = (rect, local_cursor)
        && (HitRect { x: rect.x - NEAR_PADDING, y: rect.y - NEAR_PADDING, width: rect.width + 2.0 * NEAR_PADDING, height: rect.height + 2.0 * NEAR_PADDING }).contains(x, y)
    {
        NEAR_POLL
    } else {
        FAR_POLL
    }
}

/// Last successfully submitted click-through state for a window generation. Failed dispatches retry.
#[derive(Default)]
struct HoverState {
    applied: Option<(u64, bool)>,
}

impl HoverState {
    fn update<E>(&mut self, window_epoch: u64, inside: bool, set_ignore: impl FnOnce(bool) -> Result<(), E>) -> bool {
        if self.applied == Some((window_epoch, inside)) || set_ignore(!inside).is_err() {
            return false;
        }
        self.applied = Some((window_epoch, inside));
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WindowGeometry {
    origin: (i32, i32),
    scale: f64,
}

/// A cache local to the single poll thread. An event racing with sampling changes the epoch and forces
/// another read next tick. Errors are never cached, and an invalidated generation never uses old geometry.
#[derive(Default)]
struct GeometryCache(Option<(u64, WindowGeometry)>);

impl GeometryCache {
    fn get<E>(&mut self, epoch: u64, sample: impl FnOnce() -> Result<WindowGeometry, E>) -> Option<WindowGeometry> {
        if self.0.is_none_or(|(cached_epoch, _)| cached_epoch != epoch) {
            self.0 = sample().ok().map(|geometry| (epoch, geometry));
        }
        self.0.map(|(_, geometry)| geometry)
    }
}

fn invalidates_geometry(label: &str, event: &tauri::WindowEvent) -> bool {
    label == ISLAND && matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Destroyed)
}

/// Reuse the core's RunEvent hook, including destruction/recreation, without adding per-show listeners.
pub fn on_window_event(app: &AppHandle, label: &str, event: &tauri::WindowEvent) {
    app.state::<IslandState>().on_window_event(label, event);
}

/// Whether a cursor-poll thread is running. At most one runs, and only while the Island is visible.
#[derive(Default)]
pub struct PollGate {
    running: AtomicBool,
}

impl PollGate {
    /// True when the caller should spawn the poll thread (none was running).
    pub fn try_start(&self) -> bool {
        self.running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }

    /// Called by the poll thread when it sees nothing to watch. Releases the gate, then re-checks
    /// `wanted` so a show that raced with the release is not left unwatched. True means keep polling.
    pub fn release_or_continue(&self, wanted: impl Fn() -> bool) -> bool {
        self.running.store(false, Ordering::Release);
        wanted() && self.try_start()
    }
}

#[derive(Default)]
pub struct IslandState {
    hit: Mutex<Option<HitRect>>,
    gate: PollGate,
    geometry_epoch: AtomicU64,
    window_epoch: AtomicU64,
}

impl IslandState {
    fn on_window_event(&self, label: &str, event: &tauri::WindowEvent) {
        if invalidates_geometry(label, event) {
            self.geometry_epoch.fetch_add(1, Ordering::Release);
            if matches!(event, tauri::WindowEvent::Destroyed) {
                self.window_epoch.fetch_add(1, Ordering::Release);
            }
        }
    }

    /// A replacement starts with click-through enabled; both poll caches belonged to the old window.
    pub fn on_window_created(&self, label: &str) {
        if label == ISLAND {
            self.geometry_epoch.fetch_add(1, Ordering::Release);
            self.window_epoch.fetch_add(1, Ordering::Release);
        }
    }
}

#[tauri::command]
pub fn set_island_hit_rect(state: State<'_, IslandState>, rect: HitRect) {
    if let Ok(mut hit) = state.hit.lock() {
        *hit = Some(rect);
    }
}

/// Converts a physical screen cursor position into the window's CSS-pixel coordinates.
pub fn to_local(cursor: (f64, f64), window_origin: (i32, i32), scale: f64) -> (f64, f64) {
    ((cursor.0 - window_origin.0 as f64) / scale, (cursor.1 - window_origin.1 as f64) / scale)
}

/// Whether the cursor poll should go on: the Island exists and is visible. A transient error while asking
/// is not a reason to stop (the poll would not come back until the next show).
fn should_poll<E>(exists: bool, visible: Result<bool, E>) -> bool {
    exists && visible.unwrap_or(true)
}

fn island_visible(app: &AppHandle) -> bool {
    app.get_webview_window(ISLAND).is_some_and(|w| should_poll(true, w.is_visible()))
}

/// Starts the cursor poll if it is not already running. It runs only while the Island exists and is
/// visible, and stops by itself as soon as it is not, so a hidden or never-created Island costs nothing.
pub fn ensure_cursor_watch(app: &AppHandle) {
    if !app.state::<IslandState>().gate.try_start() {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<IslandState>();
        let mut hover = HoverState::default();
        let mut geometry = GeometryCache::default();
        loop {
            // Snapshot before obtaining the window: a racing replacement must refresh next tick,
            // even if this sample still dispatches successfully to the old window.
            let window_epoch = state.window_epoch.load(Ordering::Acquire);
            let geometry_epoch = state.geometry_epoch.load(Ordering::Acquire);
            let Some(window) = app.get_webview_window(ISLAND).filter(|w| should_poll(true, w.is_visible())) else {
                hover = HoverState::default();
                geometry = GeometryCache::default();
                if state.gate.release_or_continue(|| island_visible(&app)) {
                    continue;
                }
                return;
            };
            let rect = state.hit.lock().ok().and_then(|h| *h);
            let local_cursor = rect.and_then(|_| {
                let geometry = geometry.get(geometry_epoch, || {
                    let origin = window.outer_position()?;
                    let scale = window.scale_factor()?;
                    Ok::<_, tauri::Error>(WindowGeometry { origin: (origin.x, origin.y), scale })
                })?;
                let cursor = window.cursor_position().ok()?;
                Some(to_local((cursor.x, cursor.y), geometry.origin, geometry.scale))
            });
            let inside = rect.zip(local_cursor).is_some_and(|(rect, (x, y))| rect.contains(x, y));
            if hover.update(window_epoch, inside, |ignore| window.set_ignore_cursor_events(ignore)) {
                let _ = window.emit("island-pointer", inside);
            }
            thread::sleep(poll_delay(rect, local_cursor));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_through_changes_only_when_inside_changes() {
        let mut hover = HoverState::default();
        let mut flags = Vec::new();
        for inside in [false, false, true, true, false, false] {
            hover.update(0, inside, |ignore| { flags.push(ignore); Ok::<_, ()>(()) });
        }
        assert_eq!(flags, [true, false, true]);
    }

    #[test]
    fn a_failed_click_through_dispatch_is_retried_without_publishing_the_change() {
        let mut hover = HoverState::default();
        assert!(!hover.update(0, true, |_| Err(())));
        assert!(hover.update(0, true, |ignore| { assert!(!ignore); Ok::<_, ()>(()) }));
        assert!(!hover.update::<()>(0, true, |_| panic!("unchanged state must not dispatch")));
    }

    #[test]
    fn replacement_between_samples_reapplies_click_through_without_a_boundary_crossing() {
        let state = IslandState::default();
        let mut hover = HoverState::default();
        let mut geometry = GeometryCache::default();
        let old = WindowGeometry { origin: (0, 0), scale: 1.0 };
        let new = WindowGeometry { origin: (-1000, 35), scale: 1.75 };
        let mut ignores_cursor = true;
        assert_eq!(geometry.get(0, || Ok::<_, ()>(old)), Some(old));
        assert!(hover.update(state.window_epoch.load(Ordering::Acquire), true, |ignore| {
            ignores_cursor = ignore;
            Ok::<_, ()>(())
        }));
        assert!(!ignores_cursor);

        // Destroy/recreate wholly between samples: no hidden/missing tick or cursor movement.
        state.on_window_event(ISLAND, &tauri::WindowEvent::Destroyed);
        state.on_window_created(ISLAND);
        ignores_cursor = true; // configure initializes the replacement to click-through.
        assert_eq!(geometry.get(state.geometry_epoch.load(Ordering::Acquire), || Ok::<_, ()>(new)), Some(new));
        assert!(hover.update(state.window_epoch.load(Ordering::Acquire), true, |ignore| {
            ignores_cursor = ignore;
            Ok::<_, ()>(())
        }));
        assert!(!ignores_cursor, "the replacement must accept clicks on the capsule");
        assert!(!hover.update::<()>(state.window_epoch.load(Ordering::Acquire), true, |_| panic!("unchanged replacement must not dispatch")));
    }

    #[test]
    fn either_destruction_or_creation_invalidates_the_hover_decision() {
        for destroyed in [true, false] {
            let state = IslandState::default();
            let mut hover = HoverState::default();
            assert!(hover.update(0, true, |_| Ok::<_, ()>(())));
            if destroyed {
                state.on_window_event(ISLAND, &tauri::WindowEvent::Destroyed);
            } else {
                state.on_window_created(ISLAND);
            }
            let epoch = state.window_epoch.load(Ordering::Acquire);
            assert!(!hover.update(epoch, true, |_| Err(())), "failed replacement dispatch must retry");
            assert!(hover.update(epoch, true, |ignore| { assert!(!ignore); Ok::<_, ()>(()) }));
        }
    }

    #[test]
    fn destruction_during_a_dispatch_cannot_cache_the_replacement_as_applied() {
        let state = IslandState::default();
        let mut hover = HoverState::default();
        let sampled_epoch = state.window_epoch.load(Ordering::Acquire);
        assert!(hover.update(sampled_epoch, true, |_| {
            state.on_window_event(ISLAND, &tauri::WindowEvent::Destroyed);
            state.on_window_created(ISLAND);
            Ok::<_, ()>(())
        }));
        assert!(hover.update(state.window_epoch.load(Ordering::Acquire), true, |ignore| { assert!(!ignore); Ok::<_, ()>(()) }));
    }

    #[test]
    fn movement_and_other_windows_do_not_invalidate_island_hover() {
        let state = IslandState::default();
        let mut hover = HoverState::default();
        assert!(hover.update(0, true, |_| Ok::<_, ()>(())));
        state.on_window_event(ISLAND, &tauri::WindowEvent::Moved(tauri::PhysicalPosition::new(-1000, 35)));
        for label in ["mini", "expanded"] {
            state.on_window_event(label, &tauri::WindowEvent::Destroyed);
            state.on_window_created(label);
        }
        assert_eq!(state.geometry_epoch.load(Ordering::Acquire), 1);
        assert!(!hover.update::<()>(state.window_epoch.load(Ordering::Acquire), true, |_| panic!("same Island must not dispatch")));
    }

    #[test]
    fn adaptive_poll_stays_fast_in_and_near_the_capsule_and_bounds_far_away_waits() {
        let rect = Some(HitRect { x: 18.0, y: 0.0, width: 384.0, height: 156.0 });
        for point in [(20.0, 20.0), (402.0, 156.0), (450.0, 204.0), (-30.0, -48.0)] {
            assert_eq!(poll_delay(rect, Some(point)), Duration::from_millis(33));
        }
        for point in [(450.1, 204.0), (-30.1, 10.0), (20.0, 204.1), (5000.0, 5000.0)] {
            assert_eq!(poll_delay(rect, Some(point)), Duration::from_millis(80));
        }
        assert_eq!(poll_delay(None, Some((20.0, 20.0))), Duration::from_millis(80));
        assert_eq!(poll_delay(rect, None), Duration::from_millis(80));
    }

    #[test]
    fn geometry_is_read_once_until_a_move_or_scale_epoch_changes() {
        let mut cache = GeometryCache::default();
        let first = WindowGeometry { origin: (-1000, 35), scale: 1.0 };
        let moved = WindowGeometry { origin: (1000, 0), scale: 1.75 };
        assert_eq!(cache.get(0, || Ok::<_, ()>(first)), Some(first));
        assert_eq!(cache.get::<()>(0, || panic!("idle ticks must not re-read geometry")), Some(first));
        assert_eq!(cache.get(1, || Ok::<_, ()>(moved)), Some(moved));
        // An event during sampling advances the epoch; the next tick refreshes again.
        assert_eq!(cache.get(2, || Ok::<_, ()>(first)), Some(first));
    }

    #[test]
    fn failed_geometry_reads_are_retried_and_do_not_reuse_stale_geometry() {
        let mut cache = GeometryCache::default();
        let geo = WindowGeometry { origin: (0, 0), scale: 1.0 };
        assert_eq!(cache.get(0, || Ok::<_, ()>(geo)), Some(geo));
        assert_eq!(cache.get(1, || Err(())), None);
        assert_eq!(cache.get(1, || Ok::<_, ()>(geo)), Some(geo));
    }

    #[test]
    fn only_island_geometry_events_invalidate_the_cache() {
        use tauri::{PhysicalPosition, PhysicalSize, WindowEvent};
        let events = [
            WindowEvent::Moved(PhysicalPosition::new(-1000, 35)),
            WindowEvent::Destroyed,
        ];
        // The upstream DPI variant is non-exhaustive and cannot be constructed here.
        // Scale refresh is exercised by the epoch/cache and coordinate tests above.
        for event in events {
            assert!(invalidates_geometry(ISLAND, &event));
            assert!(!invalidates_geometry("expanded", &event));
            assert!(!invalidates_geometry("mini", &event));
        }
        assert!(!invalidates_geometry(ISLAND, &WindowEvent::Focused(false)));
        assert!(!invalidates_geometry(ISLAND, &WindowEvent::Resized(PhysicalSize::new(420, 184))));
    }

    #[test]
    fn local_coordinates_support_100_150_and_175_percent_with_negative_monitor_origin() {
        assert_eq!(to_local((-580.0, 245.0), (-1000, 35), 1.0), (420.0, 210.0));
        assert_eq!(to_local((-580.0, 245.0), (-1000, 35), 1.5), (280.0, 140.0));
        assert_eq!(to_local((-580.0, 245.0), (-1000, 35), 1.75), (240.0, 120.0));
    }

    #[test]
    fn hit_rect_contains_its_edges_and_nothing_outside() {
        let r = HitRect { x: 18.0, y: 0.0, width: 384.0, height: 156.0 };
        assert!(r.contains(18.0, 0.0));
        assert!(r.contains(402.0, 156.0));
        assert!(!r.contains(17.9, 10.0));
        assert!(!r.contains(100.0, 156.1));
    }


    #[test]
    fn a_transient_visibility_error_keeps_the_poll_alive_but_a_missing_or_hidden_island_stops_it() {
        assert!(should_poll::<()>(true, Ok(true)));
        assert!(!should_poll::<()>(true, Ok(false)));
        assert!(!should_poll::<()>(false, Ok(true)));
        assert!(!should_poll(false, Err(())));
        assert!(should_poll(true, Err(())), "is_visible() failed once: keep polling");
    }

    #[test]
    fn only_one_poll_thread_runs_and_it_can_be_restarted_after_it_stops() {
        let gate = PollGate::default();
        assert!(gate.try_start());
        assert!(!gate.try_start(), "a second show while polling must not spawn another thread");
        assert!(!gate.release_or_continue(|| false), "nothing to watch: the thread stops");
        assert!(gate.try_start(), "the next show starts a new poll");
    }

    #[test]
    fn a_show_that_races_with_the_release_keeps_the_poll_alive() {
        let gate = PollGate::default();
        assert!(gate.try_start());
        // The Island became visible again between the thread's last check and its release.
        assert!(gate.release_or_continue(|| true), "the thread must keep going");
        assert!(!gate.try_start(), "and it still owns the gate");
    }

    #[test]
    fn local_coordinates_account_for_origin_and_scaling() {
        assert_eq!(to_local((1300.0, 30.0), (1000, 0), 1.5), (200.0, 20.0));
        assert_eq!(to_local((-500.0, 10.0), (-800, 0), 1.0), (300.0, 10.0));
    }
}
