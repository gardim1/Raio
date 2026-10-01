//! Where Raio keeps local data. Shared by the app and the `raio-hook` process, so it cannot rely on
//! Tauri's path resolver; it follows the same per-user convention (`<data dir>/<identifier>`).

use std::env;
use std::path::PathBuf;

pub const IDENTIFIER: &str = "io.github.gardim1.raio";

/// `RAIO_DATA_DIR` overrides the location (tests, portable use).
pub fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = env::var_os("RAIO_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    let base = if cfg!(windows) {
        env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    }?;
    Some(base.join(IDENTIFIER))
}
