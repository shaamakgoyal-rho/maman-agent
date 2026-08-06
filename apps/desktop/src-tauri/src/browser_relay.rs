//! Desktop → extension push channel.
//!
//! The bridge was one-directional by construction: the extension connected, sent
//! one line, read one reply, and the connection closed. Actuation needs the
//! opposite direction, so the extension now also opens a PERSISTENT native port;
//! the host registers that port here, and this module is what the run path writes
//! into.
//!
//! Three things are deliberately true of this module:
//!
//! - It holds NO key material and makes no security decision. Envelopes are signed
//!   before they get here and verified after they leave; a compromised relay can
//!   drop or delay a request, which is a liveness problem, not an authenticity one.
//! - Results arrive on a DIFFERENT connection from the one the request went out on
//!   (the extension answers through the ordinary extension → host → desktop path),
//!   so request and result are correlated by `request_id` through `pending`.
//! - A request that is never answered must not leak a waiting thread or a map
//!   entry, so every wait has a timeout and every exit path abandons its entry.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// How long the desktop waits for the browser to answer one action.
///
/// Generous relative to the work (a field write is instant) because the cost of
/// being wrong differs by direction: too short abandons a request the browser is
/// about to perform, leaving the desktop believing a write failed when it landed.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(20);

struct Registered {
    stream: UnixStream,
    installation_id: String,
}

pub struct Relay {
    registered: Mutex<Option<Registered>>,
    pending: Mutex<HashMap<String, Sender<serde_json::Value>>>,
}

pub fn relay() -> &'static Relay {
    static RELAY: OnceLock<Relay> = OnceLock::new();
    RELAY.get_or_init(|| Relay {
        registered: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
    })
}

impl Relay {
    /// Registers the host's persistent connection.
    ///
    /// A later registration REPLACES an earlier one. There is one browser relay per
    /// device, and a reconnect after the service worker was evicted must take over
    /// rather than be refused — otherwise a stale, dead socket would keep the live
    /// one out.
    pub fn register(&self, stream: UnixStream, installation_id: &str) {
        let mut guard = self.registered.lock().expect("relay lock");
        *guard = Some(Registered {
            stream,
            installation_id: installation_id.to_string(),
        });
    }

    pub fn forget(&self) {
        *self.registered.lock().expect("relay lock") = None;
    }

    pub fn is_connected(&self) -> bool {
        self.registered.lock().expect("relay lock").is_some()
    }

    /// The extension's installation id, needed to address an envelope to it. Taken
    /// from the registration rather than persisted at pairing time, so it can never
    /// name an extension that is not the one currently connected.
    pub fn installation_id(&self) -> Option<String> {
        self.registered
            .lock()
            .expect("relay lock")
            .as_ref()
            .map(|r| r.installation_id.clone())
    }

    /// Writes one JSON line to the registered relay.
    ///
    /// A write error means the browser side is gone, so the registration is dropped
    /// rather than retried: leaving a dead socket registered would make every later
    /// push fail silently instead of reporting that no browser is connected.
    pub fn push(&self, envelope: &serde_json::Value) -> Result<(), String> {
        let mut guard = self.registered.lock().expect("relay lock");
        let Some(registered) = guard.as_mut() else {
            return Err("no browser relay connected".into());
        };
        let line = serde_json::to_string(envelope).map_err(|e| e.to_string())?;
        match registered
            .stream
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|()| registered.stream.flush())
        {
            Ok(()) => Ok(()),
            Err(e) => {
                *guard = None;
                Err(format!("browser relay disconnected: {e}"))
            }
        }
    }

    /// Registers interest in a result before the request is pushed. Doing this
    /// first is what makes a fast answer safe — the reply can arrive before `push`
    /// has even returned.
    pub fn begin(&self, request_id: &str) -> Receiver<serde_json::Value> {
        let (tx, rx) = channel();
        self.pending
            .lock()
            .expect("pending lock")
            .insert(request_id.to_string(), tx);
        rx
    }

    /// Hands a result to whoever is waiting. False when nobody is — an unmatched
    /// result is dropped rather than acted on, which is also what happens to a
    /// replayed one.
    pub fn deliver(&self, request_id: &str, result: serde_json::Value) -> bool {
        let sender = self
            .pending
            .lock()
            .expect("pending lock")
            .remove(request_id);
        match sender {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    pub fn abandon(&self, request_id: &str) {
        self.pending.lock().expect("pending lock").remove(request_id);
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("pending lock").len()
    }

    /// Waits for a result, giving up after `timeout`. The entry is always removed,
    /// so a late answer to an abandoned request finds no waiter and is dropped.
    pub fn wait(
        &self,
        request_id: &str,
        rx: Receiver<serde_json::Value>,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let outcome = rx
            .recv_timeout(timeout)
            .map_err(|_| "the browser did not answer in time".to_string());
        self.abandon(request_id);
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn fresh() -> Relay {
        Relay {
            registered: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn a_push_without_a_registered_relay_reports_that_rather_than_hanging() {
        let r = fresh();
        assert!(!r.is_connected());
        let err = r.push(&serde_json::json!({"a": 1})).unwrap_err();
        assert!(err.contains("no browser relay connected"), "{err}");
    }

    #[test]
    fn a_registered_relay_receives_one_json_line_per_push() {
        let (ours, theirs) = UnixStream::pair().expect("socketpair");
        let r = fresh();
        r.register(ours, "install-1");
        assert!(r.is_connected());
        assert_eq!(r.installation_id().as_deref(), Some("install-1"));

        r.push(&serde_json::json!({"n": 1})).expect("push 1");
        r.push(&serde_json::json!({"n": 2})).expect("push 2");

        let mut reader = BufReader::new(theirs);
        let mut first = String::new();
        let mut second = String::new();
        reader.read_line(&mut first).expect("line 1");
        reader.read_line(&mut second).expect("line 2");
        assert_eq!(first.trim(), r#"{"n":1}"#);
        assert_eq!(second.trim(), r#"{"n":2}"#);
    }

    #[test]
    fn a_dead_peer_drops_the_registration_instead_of_failing_forever() {
        let (ours, theirs) = UnixStream::pair().expect("socketpair");
        let r = fresh();
        r.register(ours, "install-1");
        drop(theirs); // the browser went away

        // The first push may succeed into the socket buffer; what matters is that
        // once a write fails, nothing stays registered.
        let mut saw_error = false;
        for _ in 0..64 {
            if r.push(&serde_json::json!({"n": 1})).is_err() {
                saw_error = true;
                break;
            }
        }
        assert!(saw_error, "writing to a closed peer never reported an error");
        assert!(!r.is_connected(), "a dead relay stayed registered");
    }

    #[test]
    fn a_later_registration_takes_over_from_a_stale_one() {
        let (a, _keep_a) = UnixStream::pair().expect("socketpair");
        let (b, keep_b) = UnixStream::pair().expect("socketpair");
        let r = fresh();
        r.register(a, "old");
        r.register(b, "new");
        assert_eq!(r.installation_id().as_deref(), Some("new"));

        r.push(&serde_json::json!({"to": "new"})).expect("push");
        let mut line = String::new();
        BufReader::new(keep_b).read_line(&mut line).expect("line");
        assert_eq!(line.trim(), r#"{"to":"new"}"#);
    }

    #[test]
    fn forget_clears_the_registration() {
        let (ours, _theirs) = UnixStream::pair().expect("socketpair");
        let r = fresh();
        r.register(ours, "install-1");
        r.forget();
        assert!(!r.is_connected());
        assert!(r.installation_id().is_none());
    }

    #[test]
    fn a_result_reaches_the_thread_waiting_for_it() {
        let r = fresh();
        let rx = r.begin("req-1");
        assert_eq!(r.pending_count(), 1);
        assert!(r.deliver("req-1", serde_json::json!({"outcome": "applied"})));
        let got = r.wait("req-1", rx, Duration::from_millis(50)).expect("result");
        assert_eq!(got["outcome"], "applied");
        assert_eq!(r.pending_count(), 0);
    }

    #[test]
    fn a_result_nobody_is_waiting_for_is_dropped() {
        let r = fresh();
        assert!(!r.deliver("never-asked", serde_json::json!({"outcome": "applied"})));
    }

    #[test]
    fn a_result_delivered_twice_is_only_accepted_once() {
        let r = fresh();
        let rx = r.begin("req-1");
        assert!(r.deliver("req-1", serde_json::json!({"n": 1})));
        // The entry is consumed on the first delivery, so a replay finds no waiter.
        assert!(!r.deliver("req-1", serde_json::json!({"n": 2})));
        let got = r.wait("req-1", rx, Duration::from_millis(50)).expect("result");
        assert_eq!(got["n"], 1);
    }

    #[test]
    fn a_timeout_reports_it_and_leaves_no_entry_behind() {
        let r = fresh();
        let rx = r.begin("req-1");
        let err = r
            .wait("req-1", rx, Duration::from_millis(10))
            .expect_err("should time out");
        assert!(err.contains("did not answer in time"), "{err}");
        assert_eq!(r.pending_count(), 0, "an abandoned request leaked its entry");
    }

    #[test]
    fn a_late_answer_to_an_abandoned_request_finds_no_waiter() {
        let r = fresh();
        let rx = r.begin("req-1");
        let _ = r.wait("req-1", rx, Duration::from_millis(10));
        assert!(!r.deliver("req-1", serde_json::json!({"n": 1})));
    }

    #[test]
    fn concurrent_requests_do_not_cross_answers() {
        let r = fresh();
        let one = r.begin("req-1");
        let two = r.begin("req-2");
        assert_eq!(r.pending_count(), 2);
        r.deliver("req-2", serde_json::json!({"which": 2}));
        r.deliver("req-1", serde_json::json!({"which": 1}));
        let got_two = r.wait("req-2", two, Duration::from_millis(50)).expect("two");
        let got_one = r.wait("req-1", one, Duration::from_millis(50)).expect("one");
        assert_eq!(got_two["which"], 2);
        assert_eq!(got_one["which"], 1);
    }
}
