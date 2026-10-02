//! Island hover and click-through. The Island window is transparent and larger than the capsule:
//! outside the capsule rectangle (published by the renderer, in CSS pixels) it ignores the cursor
//! so clicks reach the window beneath. A low-rate cursor poll toggles that, and runs only while the Island is visible.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::surfaces::ISLAND;

const POLL: Duration = Duration::from_millis(33);

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
        let mut inside_before: Option<bool> = None;
        loop {
            let Some(window) = app.get_webview_window(ISLAND).filter(|w| should_poll(true, w.is_visible())) else {
                inside_before = None;
                if app.state::<IslandState>().gate.release_or_continue(|| island_visible(&app)) {
                    continue;
                }
                return;
            };
            let rect = app.state::<IslandState>().hit.lock().ok().and_then(|h| *h);
            let inside = match (rect, window.cursor_position(), window.outer_position(), window.scale_factor()) {
                (Some(rect), Ok(cursor), Ok(origin), Ok(scale)) => {
                    let (x, y) = to_local((cursor.x, cursor.y), (origin.x, origin.y), scale);
                    rect.contains(x, y)
                }
                _ => false,
            };
            if inside_before != Some(inside) {
                let _ = window.set_ignore_cursor_events(!inside);
                let _ = window.emit("island-pointer", inside);
                inside_before = Some(inside);
            }
            thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
