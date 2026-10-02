//! The hard-deadline protocol of `raio-hook`: when the watchdog fires, it must not lose an event silently,
//! and one invocation must never leave two markers (or a marker and a record).
//!
//! The hook moves through four states with compare-and-swap, so exactly one party decides the outcome:
//! `Inert` (nothing at stake: not our arguments, stale heartbeat) -> `Armed` (an event is awaited) ->
//! `Writing` (somebody claimed the one allowed write: a record, or a drop marker) -> `Done`; or, when the
//! watchdog gets there first, `Expired` (it writes the marker; the main thread must not exit before it). The main thread
//! `claim()`s before every write, record or marker alike, and skips the write when the claim fails; the
//! watchdog claims by taking `Armed` -> `Done` and then leaves the `hard-deadline` marker itself.
//!
//! Remaining window, by design: a write that is still not finished 300 ms after the deadline is abandoned
//! (the process exits), leaving neither record nor marker. The record is written to a temp file and renamed
//! into place atomically, so a half-written record never appears; the orphaned temp file is removed by the
//! app's housekeeping. This needs a write that stalls for over 2.3 s in total.

use std::sync::atomic::{AtomicU8, Ordering};

const INERT: u8 = 0;
const ARMED: u8 = 1;
const WRITING: u8 = 2;
const DONE: u8 = 3;
/// The watchdog took the event and is writing its marker; the process must not exit before it does.
const EXPIRED: u8 = 4;

/// What the watchdog has to do when the deadline passes.
#[derive(Debug, PartialEq)]
pub enum Expiry {
    /// An event was awaited and nothing was written: leave a `hard-deadline` drop marker, then exit.
    Drop,
    /// A write is in flight: give it a short grace period, then exit.
    Grace,
    /// Nothing to report (the hook finished, was inert, or the deadline was already handled): just exit.
    Finished,
}

pub struct Guard {
    state: AtomicU8,
}

impl Default for Guard {
    fn default() -> Self {
        Guard { state: AtomicU8::new(INERT) }
    }
}

impl Guard {
    /// An event is now awaited (the hook is Raio's, the heartbeat is fresh): from here a deadline is a loss.
    pub fn arm(&self) {
        let _ = self.state.compare_exchange(INERT, ARMED, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// The main thread, before its one write (a record or a drop marker). False: do not write; the watchdog
    /// already decided, a write was already claimed, or nothing was awaited.
    pub fn claim(&self) -> bool {
        self.state.compare_exchange(ARMED, WRITING, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

    /// The main thread has finished (written, or nothing to write).
    ///
    /// True when the watchdog owns the exit (it took the event and is still writing its marker): the main
    /// thread must then wait for the watchdog to end the process instead of exiting first.
    pub fn finish(&self) -> bool {
        self.state.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |s| (s != EXPIRED).then_some(DONE)).is_err()
    }

    /// The watchdog, when the deadline has passed.
    pub fn expire(&self) -> Expiry {
        loop {
            match self.state.compare_exchange(ARMED, EXPIRED, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return Expiry::Drop,
                Err(WRITING) => return Expiry::Grace,
                Err(INERT) => {
                    // Close the door on a late `arm`; if it just armed, look again.
                    if self.state.compare_exchange(INERT, DONE, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                        return Expiry::Finished;
                    }
                }
                Err(_) => return Expiry::Finished,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed() -> Guard {
        let g = Guard::default();
        g.arm();
        g
    }

    #[test]
    fn a_deadline_before_anything_is_written_leaves_one_marker_and_forbids_every_later_write() {
        let g = armed();
        assert_eq!(g.expire(), Expiry::Drop);
        assert!(!g.claim(), "the watchdog's marker is the only one: no stdin-timeout or payload marker, no record, no panic marker");
        assert_eq!(g.expire(), Expiry::Finished, "decided once");
    }

    #[test]
    fn whoever_claims_first_is_the_only_writer() {
        let g = armed();
        assert!(g.claim());
        assert!(!g.claim(), "a second marker or record in the same invocation is refused");
        assert_eq!(g.expire(), Expiry::Grace, "the claimed write is in flight: the watchdog only waits");
        assert_eq!(g.expire(), Expiry::Grace);
    }

    #[test]
    fn a_hook_that_never_armed_has_nothing_at_stake() {
        // Inert paths: not our args, stale heartbeat. The watchdog must not leave a marker for them.
        let g = Guard::default();
        assert_eq!(g.expire(), Expiry::Finished);
        assert!(!g.claim());
        let g = Guard::default();
        assert!(!g.claim(), "an unarmed hook has no event to write or to lose");
    }

    #[test]
    fn a_filtered_event_finishes_without_a_marker() {
        let g = armed();
        g.finish();
        assert_eq!(g.expire(), Expiry::Finished);
        assert!(!g.claim());
    }

    #[test]
    fn the_main_thread_must_not_exit_while_the_watchdog_is_still_writing_its_marker() {
        let g = armed();
        assert_eq!(g.expire(), Expiry::Drop);
        assert!(g.finish(), "the watchdog owns the exit now: the main thread waits for it");
        assert_eq!(g.expire(), Expiry::Finished);
        let plain = armed();
        assert!(!plain.finish(), "nobody else is writing: the main thread may exit");
        let inert = Guard::default();
        assert_eq!(inert.expire(), Expiry::Finished);
        assert!(!inert.finish(), "an inert expiry left no marker to wait for");
    }

    #[test]
    fn arming_twice_or_after_the_deadline_changes_nothing() {
        let g = armed();
        assert!(g.claim());
        g.arm();
        assert!(!g.claim(), "still one writer");
        let late = Guard::default();
        assert_eq!(late.expire(), Expiry::Finished);
        late.arm();
        assert!(!late.claim(), "the deadline already decided");
    }
}
