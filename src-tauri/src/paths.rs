//! Where Raio keeps local data. Shared by the app and the `raio-hook` process, so it cannot rely on
//! Tauri's path resolver; it follows the same per-user convention (`<data dir>/<identifier>`).

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Shared by Connect, map preview and folder launch intents; never requires the hook sidecar.
pub fn project_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() { return Err("not a folder".into()); }
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    // Windows canonicalisation uses verbatim prefixes; Git Bash needs ordinary drive/UNC paths.
    if cfg!(windows) {
        let text = canonical.to_str().ok_or("folder path is not valid Unicode")?;
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") { return Ok(PathBuf::from(format!(r"\\{unc}"))); }
        if let Some(drive) = text.strip_prefix(r"\\?\") { return Ok(PathBuf::from(drive)); }
    }
    Ok(canonical)
}

pub(crate) fn temporary_path(path: &Path) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    path.with_file_name(format!(".{}.{}-{nanos}-{}.tmp", path.file_name().unwrap().to_string_lossy(), std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)))
}

/// Replace a small data file on the same volume; readers see the complete old or new document.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = temporary_path(path);
    let result = (|| {
        let mut file = fs::File::options().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() { let _ = fs::remove_file(tmp); }
    result
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_roots_are_canonical_absolute_folders_including_spaces_and_accents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("demo espaço");
        std::fs::create_dir(&root).unwrap();
        let got = project_root(&root.join(".")).unwrap();
        assert!(got.is_absolute());
        assert_eq!(got, project_root(&root).unwrap());
        assert!(!got.to_string_lossy().starts_with(r"\\?\"), "normal Windows paths remain usable by Git Bash");
        let relative = Path::new(".");
        assert!(project_root(relative).unwrap().is_absolute());
    }

    #[test]
    fn project_roots_reject_empty_missing_and_file_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, []).unwrap();
        for path in [Path::new(""), file.as_path(), dir.path().join("missing").as_path()] {
            assert!(project_root(path).is_err());
        }
    }
}
