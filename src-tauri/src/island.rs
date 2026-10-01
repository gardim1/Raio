//! Island hover and click-through. The Island window is transparent and larger than the capsule:
//! outside the capsule rectangle (published by the renderer, in CSS pixels) it ignores the cursor
//! so clicks reach the window beneath. A low-rate cursor poll toggles that while the Island is visible.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::surfaces::ISLAND;

const POLL_VISIBLE: Duration = Duration::from_millis(33);
const POLL_HIDDEN: Duration = Duration::from_millis(250);

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

#[derive(Default)]
pub struct IslandState {
    hit: Mutex<Option<HitRect>>,
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

pub fn spawn_cursor_watch(app: AppHandle) {
    thread::spawn(move || {
        let mut inside_before: Option<bool> = None;
        loop {
            let Some(window) = app.get_webview_window(ISLAND) else { return };
            if !window.is_visible().unwrap_or(false) {
                inside_before = None;
                thread::sleep(POLL_HIDDEN);
                continue;
            }
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
            thread::sleep(POLL_VISIBLE);
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
    fn local_coordinates_account_for_origin_and_scaling() {
        assert_eq!(to_local((1300.0, 30.0), (1000, 0), 1.5), (200.0, 20.0));
        assert_eq!(to_local((-500.0, 10.0), (-800, 0), 1.0), (300.0, 10.0));
    }
}
