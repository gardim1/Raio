//! One Raio per user: a second `raio.exe` must not double-watch projects or double-ingest the inbox.
//!
//! The first instance holds an exclusive advisory lock on `instance.lock` in the data directory for its
//! whole lifetime (std only: `File::try_lock`, i.e. `LockFileEx` on Windows and `flock` elsewhere). The
//! lock belongs to the open handle, so the OS releases it when the process exits *or crashes*; the file
//! left behind is just an empty marker and never makes a later start think Raio is still running.
//! A second instance asks the first to show its Expanded view by dropping a `show-request` marker, then
//! exits. The first consumes the marker from its ingest loop.

use std::fs::{self, File, TryLockError};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

const MAX_REQUEST_BYTES: usize = 8 * 1024;

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShowRequest {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
}

impl ShowRequest {
    pub fn target_surface(&self) -> &str {
        if self.project.is_some() { crate::surfaces::EXPANDED } else { self.surface.as_deref().unwrap_or(crate::surfaces::EXPANDED) }
    }
}

pub fn launch_project(args: impl IntoIterator<Item = String>) -> Option<Result<String, String>> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let value = if arg == "--project" { Some(args.next().unwrap_or_default()) } else { arg.strip_prefix("--project=").map(str::to_owned) };
        if let Some(value) = value {
            return Some(crate::paths::project_root(Path::new(&value)).and_then(|p| p.into_os_string().into_string().map_err(|_| "folder path is not valid Unicode".into())));
        }
    }
    None
}

pub fn request_show_with(data: &Path, request: &ShowRequest) -> io::Result<()> {
    let bytes = serde_json::to_vec(request)?;
    if bytes.len() > MAX_REQUEST_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidInput, "show request too large")); }
    crate::paths::write_atomic(&marker(data, SHOW_REQUEST), &bytes)
}

/// Claim before reading: a replacement arriving meanwhile stays pending for the next pass.
pub fn take_launch_request(data: &Path) -> Option<ShowRequest> {
    let path = marker(data, SHOW_REQUEST);
    let claimed = crate::paths::temporary_path(&path);
    fs::rename(&path, &claimed).ok()?;
    let read = (|| -> Result<ShowRequest, String> {
        let mut bytes = Vec::new();
        File::open(&claimed).and_then(|f| f.take(MAX_REQUEST_BYTES as u64 + 1).read_to_end(&mut bytes)).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_REQUEST_BYTES { return Err("show request too large".into()); }
        let mut request: ShowRequest = if bytes.is_empty() { ShowRequest::default() } else { serde_json::from_slice(&bytes).map_err(|e| e.to_string())? };
        if let Some(root) = &request.project {
            if !Path::new(root).is_absolute() { return Err("project request root must be absolute".into()); }
            request.project = Some(crate::paths::project_root(Path::new(root))?.into_os_string().into_string().map_err(|_| "folder path is not valid Unicode")?);
        }
        if let Some(surface) = &request.surface
            && !matches!(crate::surfaces::launch_surface(vec![format!("--surface={surface}")]), Some(Ok(_))) {
            return Err("unknown launch surface".into());
        }
        Ok(request)
    })();
    let _ = fs::remove_file(claimed);
    match read {
        Ok(request) => Some(request),
        Err(error) => { eprintln!("Raio ignores invalid show request: {error}"); None }
    }
}

const LOCK_FILE: &str = "instance.lock";
const SHOW_REQUEST: &str = "show-request";

/// Held for the process lifetime; dropping it (or the process dying) releases the lock.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

#[derive(Debug)]
pub enum Acquire {
    /// This process is the single instance.
    First(InstanceLock),
    /// Another Raio holds the lock.
    AlreadyRunning,
}

fn marker(data: &Path, name: &str) -> PathBuf {
    data.join(name)
}

pub fn acquire(data: &Path) -> io::Result<Acquire> {
    fs::create_dir_all(data)?;
    let file = File::options().create(true).truncate(false).write(true).open(marker(data, LOCK_FILE))?;
    match file.try_lock() {
        Ok(()) => {
            // Only the holder may discard requests, so a refused launch never clears one for the live app.
            let _ = fs::remove_file(marker(data, SHOW_REQUEST));
            Ok(Acquire::First(InstanceLock { _file: file }))
        }
        Err(TryLockError::WouldBlock) => Ok(Acquire::AlreadyRunning),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// Called by a second instance: asks the running one to come forward.
pub fn request_show(data: &Path) -> io::Result<()> {
    request_show_with(data, &ShowRequest::default())
}

/// Called by the running instance: true once per pending request.
pub fn take_show_request(data: &Path) -> bool {
    take_launch_request(data).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_project_launch_accepts_both_forms_and_rejects_invalid_values() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("demo espaço");
        fs::create_dir(&root).unwrap();
        let root = root.to_str().unwrap();
        let expected = crate::paths::project_root(Path::new(root)).unwrap().to_string_lossy().into_owned();
        for args in [vec!["raio.exe".into(), "--project".into(), root.into(), "--surface=mini".into()], vec![format!("--project={root}")]] {
            assert_eq!(launch_project(args), Some(Ok(expected.clone())));
        }
        assert!(launch_project(vec!["--project".into()]).unwrap().is_err());
        assert!(launch_project(vec!["--project=".into()]).unwrap().is_err());
        assert!(launch_project(vec![format!("--project={root}/missing")]).unwrap().is_err());
        assert_eq!(launch_project(vec!["--surface=mini".into()]), None);
    }

    #[test]
    fn alpha_project_request_carries_path_and_surface_once_with_no_temp_residue() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::paths::project_root(dir.path()).unwrap().to_string_lossy().into_owned();
        let request = ShowRequest { project: Some(root), surface: Some("mini".into()) };
        request_show_with(dir.path(), &request).unwrap();
        assert_eq!(take_launch_request(dir.path()), Some(request));
        assert_eq!(take_launch_request(dir.path()), None);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn alpha_malformed_oversized_and_invalid_project_requests_are_deleted_and_ignored() {
        let dir = tempfile::tempdir().unwrap();
        for bytes in [b"{broken".to_vec(), vec![b' '; MAX_REQUEST_BYTES + 1], b"{\"project\":false}".to_vec(),
            b"{\"surface\":\"bogus\"}".to_vec(), b"{\"unknown\":true}".to_vec(),
            b"{\"project\":\".\"}".to_vec(),
            serde_json::to_vec(&ShowRequest { project: Some(dir.path().join("gone").to_string_lossy().into_owned()), surface: None }).unwrap()] {
            fs::write(marker(dir.path(), SHOW_REQUEST), bytes).unwrap();
            assert_eq!(take_launch_request(dir.path()), None);
            assert!(!marker(dir.path(), SHOW_REQUEST).exists());
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn alpha_project_request_before_startup_is_discarded_and_project_overrides_surface() {
        let dir = tempfile::tempdir().unwrap();
        let request = ShowRequest { project: Some(dir.path().to_string_lossy().into_owned()), surface: Some("mini".into()) };
        request_show_with(dir.path(), &request).unwrap();
        let _first = acquire(dir.path()).unwrap();
        assert_eq!(take_launch_request(dir.path()), None);
        assert_eq!(request.target_surface(), "expanded");
        assert_eq!(ShowRequest { project: None, surface: Some("mini".into()) }.target_surface(), "mini");
    }

    #[test]
    fn alpha_oversized_outbound_request_is_rejected_without_creating_a_marker() {
        let dir = tempfile::tempdir().unwrap();
        assert!(request_show_with(dir.path(), &ShowRequest { project: Some("x".repeat(MAX_REQUEST_BYTES)), surface: None }).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_first_instance_wins_and_a_second_is_refused_while_it_lives() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path()).unwrap();
        assert!(matches!(first, Acquire::First(_)));
        assert!(matches!(acquire(dir.path()).unwrap(), Acquire::AlreadyRunning));
        assert!(matches!(acquire(dir.path()).unwrap(), Acquire::AlreadyRunning));
    }

    #[test]
    fn the_lock_is_released_when_the_holder_goes_away() {
        let dir = tempfile::tempdir().unwrap();
        drop(acquire(dir.path()).unwrap()); // stands in for exit/crash: the OS closes the handle
        assert!(dir.path().join(LOCK_FILE).exists(), "the marker file stays behind");
        assert!(matches!(acquire(dir.path()).unwrap(), Acquire::First(_)), "a leftover file must not look like a running Raio");
    }

    #[test]
    fn different_data_directories_do_not_exclude_each_other() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let _first = acquire(a.path()).unwrap();
        assert!(matches!(acquire(b.path()).unwrap(), Acquire::First(_)));
    }

    #[test]
    fn creates_the_data_directory_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("not").join("yet");
        assert!(matches!(acquire(&nested).unwrap(), Acquire::First(_)));
    }

    #[test]
    fn a_show_request_is_delivered_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!take_show_request(dir.path()));
        request_show(dir.path()).unwrap();
        request_show(dir.path()).unwrap(); // several launches before the first noticed collapse into one
        assert!(take_show_request(dir.path()));
        assert!(!take_show_request(dir.path()));
    }

    #[test]
    fn a_request_left_over_from_before_this_start_is_discarded_by_the_new_first_instance() {
        let dir = tempfile::tempdir().unwrap();
        request_show(dir.path()).unwrap();
        let _first = acquire(dir.path()).unwrap();
        assert!(!take_show_request(dir.path()), "starting must not pop the window open because of an old request");
    }

    #[test]
    fn a_refused_second_instance_does_not_clear_a_pending_request() {
        let dir = tempfile::tempdir().unwrap();
        let _first = acquire(dir.path()).unwrap();
        request_show(dir.path()).unwrap();
        assert!(matches!(acquire(dir.path()).unwrap(), Acquire::AlreadyRunning));
        assert!(take_show_request(dir.path()));
    }
}
