use std::collections::HashSet;
use std::future::Future;
use std::time::Duration;

use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PolicyError {
    Unavailable,
    Denied,
}

pub(crate) trait LivePolicySource: Sync {
    fn room_state(&self) -> impl Future<Output = Result<Value, PolicyError>> + Send;
    fn visibility(&self) -> impl Future<Output = Result<Value, PolicyError>> + Send;
    fn aliases(&self) -> impl Future<Output = Result<Value, PolicyError>> + Send;
    /// Must query current device keys before applying the SDK's verified-trust checks.
    fn refresh_verified_devices(&self) -> impl Future<Output = Result<(), PolicyError>> + Send;
}

pub(crate) async fn authorize_current(
    source: &impl LivePolicySource,
    room_id: &str,
    owner_mxid: &str,
    bot_mxid: &str,
    deadline: Duration,
) -> Result<(), PolicyError> {
    tokio::time::timeout(deadline, async {
        let (state, visibility, aliases, ()) = tokio::try_join!(
            source.room_state(),
            source.visibility(),
            source.aliases(),
            source.refresh_verified_devices(),
        )?;
        validate_state(&state, room_id, owner_mxid, bot_mxid)?;
        if visibility.get("visibility").and_then(Value::as_str) != Some("private")
            || aliases
                .get("aliases")
                .and_then(Value::as_array)
                .is_none_or(|v| !v.is_empty())
        {
            return Err(PolicyError::Denied);
        }
        Ok(())
    })
    .await
    .map_err(|_| PolicyError::Unavailable)?
}

fn validate_state(
    state: &Value,
    room_id: &str,
    owner_mxid: &str,
    bot_mxid: &str,
) -> Result<(), PolicyError> {
    let events = state.as_array().ok_or(PolicyError::Denied)?;
    if events.len() > 4096 {
        return Err(PolicyError::Denied);
    }
    let mut seen = HashSet::new();
    let mut joined = HashSet::new();
    let mut encryption = false;
    let mut invite_only = false;
    let mut joined_history = false;
    let mut no_guests = false;
    for event in events {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or(PolicyError::Denied)?;
        let state_key = event
            .get("state_key")
            .and_then(Value::as_str)
            .ok_or(PolicyError::Denied)?;
        let content = event
            .get("content")
            .and_then(Value::as_object)
            .ok_or(PolicyError::Denied)?;
        if !seen.insert((event_type, state_key))
            || event
                .get("room_id")
                .is_some_and(|value| value.as_str() != Some(room_id))
        {
            return Err(PolicyError::Denied);
        }
        let field = |name: &str| content.get(name).and_then(Value::as_str);
        match event_type {
            "m.room.member" => match field("membership") {
                Some("join") => {
                    joined.insert(state_key);
                }
                Some("invite" | "knock") => return Err(PolicyError::Denied),
                Some("leave" | "ban") => {}
                _ => return Err(PolicyError::Denied),
            },
            "m.room.encryption" if state_key.is_empty() => {
                encryption = field("algorithm") == Some("m.megolm.v1.aes-sha2");
            }
            "m.room.join_rules" if state_key.is_empty() => {
                invite_only = field("join_rule") == Some("invite");
            }
            "m.room.history_visibility" if state_key.is_empty() => {
                joined_history = field("history_visibility") == Some("joined");
            }
            "m.room.guest_access" if state_key.is_empty() => {
                no_guests = field("guest_access") == Some("forbidden");
            }
            "m.room.canonical_alias" => {
                if content.get("alias").is_some_and(|value| !value.is_null())
                    || content.get("alt_aliases").is_some_and(|value| {
                        value.as_array().is_none_or(|values| !values.is_empty())
                    })
                {
                    return Err(PolicyError::Denied);
                }
            }
            "m.bridge" | "uk.half-shot.bridge" | "im.vector.modular.widgets" => {
                if !content.is_empty() {
                    return Err(PolicyError::Denied);
                }
            }
            _ => {}
        }
    }
    if !encryption
        || !invite_only
        || !joined_history
        || !no_guests
        || joined != HashSet::from([owner_mxid, bot_mxid])
    {
        return Err(PolicyError::Denied);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    struct Source {
        state: Mutex<Value>,
        devices_trusted: AtomicBool,
        state_unavailable: AtomicBool,
        devices_unavailable: AtomicBool,
        requests: AtomicUsize,
        delay: Duration,
    }

    impl Source {
        fn valid() -> Self {
            Self {
                state: Mutex::new(json!([
                    {"type":"m.room.encryption","state_key":"","content":{"algorithm":"m.megolm.v1.aes-sha2"}},
                    {"type":"m.room.join_rules","state_key":"","content":{"join_rule":"invite"}},
                    {"type":"m.room.history_visibility","state_key":"","content":{"history_visibility":"joined"}},
                    {"type":"m.room.guest_access","state_key":"","content":{"guest_access":"forbidden"}},
                    {"type":"m.room.member","state_key":"@owner:matrix.org","content":{"membership":"join"}},
                    {"type":"m.room.member","state_key":"@bot:matrix.org","content":{"membership":"join"}}
                ])),
                devices_trusted: AtomicBool::new(true),
                state_unavailable: AtomicBool::new(false),
                devices_unavailable: AtomicBool::new(false),
                requests: AtomicUsize::new(0),
                delay: Duration::ZERO,
            }
        }
    }

    impl LivePolicySource for Source {
        async fn room_state(&self) -> Result<Value, PolicyError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            if self.state_unavailable.load(Ordering::SeqCst) {
                return Err(PolicyError::Unavailable);
            }
            tokio::time::sleep(self.delay).await;
            Ok(self.state.lock().unwrap().clone())
        }
        async fn visibility(&self) -> Result<Value, PolicyError> {
            Ok(json!({"visibility":"private"}))
        }
        async fn aliases(&self) -> Result<Value, PolicyError> {
            Ok(json!({"aliases":[]}))
        }
        async fn refresh_verified_devices(&self) -> Result<(), PolicyError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            if self.devices_unavailable.load(Ordering::SeqCst) {
                return Err(PolicyError::Unavailable);
            }
            self.devices_trusted
                .load(Ordering::SeqCst)
                .then_some(())
                .ok_or(PolicyError::Denied)
        }
    }

    async fn check(source: &Source) -> Result<(), PolicyError> {
        authorize_current(
            source,
            "!room:matrix.org",
            "@owner:matrix.org",
            "@bot:matrix.org",
            Duration::from_millis(50),
        )
        .await
    }

    #[tokio::test]
    async fn send_rechecks_policy_after_a_previously_compliant_sync() {
        for change in ["membership", "history", "invite", "widget", "device"] {
            let source = Source::valid();
            check(&source).await.unwrap();
            match change {
                "membership" => source.state.lock().unwrap().as_array_mut().unwrap().push(json!({"type":"m.room.member","state_key":"@third:matrix.org","content":{"membership":"join"}})),
                "history" => source.state.lock().unwrap()[2]["content"]["history_visibility"] = json!("world_readable"),
                "invite" => source.state.lock().unwrap()[1]["content"]["join_rule"] = json!("public"),
                "widget" => source.state.lock().unwrap().as_array_mut().unwrap().push(json!({"type":"im.vector.modular.widgets","state_key":"widget","content":{"url":"https://example.invalid"}})),
                _ => source.devices_trusted.store(false, Ordering::SeqCst),
            }
            assert_eq!(check(&source).await, Err(PolicyError::Denied), "{change}");
            assert_eq!(source.requests.load(Ordering::SeqCst), 4);
        }
    }

    #[tokio::test]
    async fn temporary_authoritative_failures_remain_retryable_and_recover_fresh() {
        let mut source = Source::valid();
        check(&source).await.unwrap();
        source.delay = Duration::from_secs(30);
        assert_eq!(check(&source).await, Err(PolicyError::Unavailable));
        source.delay = Duration::ZERO;
        check(&source).await.unwrap();
        for failure in [&source.state_unavailable, &source.devices_unavailable] {
            failure.store(true, Ordering::SeqCst);
            assert_eq!(check(&source).await, Err(PolicyError::Unavailable));
            failure.store(false, Ordering::SeqCst);
            check(&source).await.unwrap();
        }
        assert!(source.requests.load(Ordering::SeqCst) >= 12);
    }
}
