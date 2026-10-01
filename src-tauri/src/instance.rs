//! One Raio per user: a second `raio.exe` must not double-watch projects or double-ingest the inbox.
//!
//! The first instance holds an exclusive advisory lock on `instance.lock` in the data directory for its
//! whole lifetime (std only: `File::try_lock`, i.e. `LockFileEx` on Windows and `flock` elsewhere). The
//! lock belongs to the open handle, so the OS releases it when the process exits *or crashes*; the file
//! left behind is just an empty marker and never makes a later start think Raio is still running.
//! A second instance asks the first to show its Expanded view by dropping a `show-request` marker, then
//! exits. The first consumes the marker from its ingest loop.

use std::fs::{self, File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

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
    fs::write(marker(data, SHOW_REQUEST), b"")
}

/// Called by the running instance: true once per pending request.
pub fn take_show_request(data: &Path) -> bool {
    fs::remove_file(marker(data, SHOW_REQUEST)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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
