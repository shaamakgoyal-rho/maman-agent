//! Observer sidecar supervision.
//!
//! The Swift semantic observer (M4) runs as a child process speaking JSON
//! Lines over stdio. This module owns the restart policy: if the observer
//! crashes, restart it at most MAX_RESTARTS times within WINDOW; after that,
//! stop and surface a failure to the UI instead of crash-looping.

use std::time::{Duration, Instant};

pub const MAX_RESTARTS: usize = 3;
pub const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Default)]
pub struct RestartPolicy {
    crashes: Vec<Instant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RestartDecision {
    Restart,
    /// Too many crashes in the window: stop supervising and show a failure.
    GiveUp,
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a crash at `now` and decides whether to restart.
    pub fn on_crash(&mut self, now: Instant) -> RestartDecision {
        self.crashes.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        self.crashes.push(now);
        if self.crashes.len() > MAX_RESTARTS {
            RestartDecision::GiveUp
        } else {
            RestartDecision::Restart
        }
    }

    /// A healthy run long enough to clear history (steady state).
    pub fn on_stable(&mut self) {
        self.crashes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_up_to_three_times_within_window() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        assert_eq!(policy.on_crash(t0), RestartDecision::Restart);
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(10)), RestartDecision::Restart);
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(20)), RestartDecision::Restart);
        // fourth crash within 10 minutes → give up
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(30)), RestartDecision::GiveUp);
    }

    #[test]
    fn old_crashes_age_out_of_the_window() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for i in 0..3 {
            assert_eq!(
                policy.on_crash(t0 + Duration::from_secs(i * 5)),
                RestartDecision::Restart
            );
        }
        // 11 minutes later, history expired: restart allowed again
        assert_eq!(
            policy.on_crash(t0 + Duration::from_secs(11 * 60)),
            RestartDecision::Restart
        );
    }

    #[test]
    fn stable_run_clears_history() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        policy.on_crash(t0);
        policy.on_crash(t0 + Duration::from_secs(1));
        policy.on_crash(t0 + Duration::from_secs(2));
        policy.on_stable();
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(3)), RestartDecision::Restart);
    }
}
