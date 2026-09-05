use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoomPolicySnapshot {
    pub room_id: String,
    pub owner_mxid: String,
    pub bot_mxid: String,
    pub encrypted: bool,
    pub invite_only: bool,
    pub joined_members: Vec<String>,
    pub pending_invites: u16,
    pub history_visibility_joined: bool,
    pub public_alias: bool,
    pub public_listing: bool,
    pub guests_allowed: bool,
    pub bridges_present: bool,
    pub widgets_present: bool,
    pub owner_devices_trusted: bool,
    pub bot_device_trusted: bool,
    pub devices_non_revoked: bool,
    pub observed_at_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ExpectedRoom<'a> {
    pub room_id: &'a str,
    pub owner_mxid: &'a str,
    pub bot_mxid: &'a str,
    pub max_age_ms: u64,
}

#[derive(Debug, Error)]
#[error("room policy is not authorized")]
pub struct RoomPolicyError;

pub fn validate(
    snapshot: &RoomPolicySnapshot,
    expected: &ExpectedRoom<'_>,
    now_ms: u64,
) -> Result<(), RoomPolicyError> {
    let mut joined = snapshot.joined_members.clone();
    joined.sort();
    let mut required = vec![expected.bot_mxid.to_owned(), expected.owner_mxid.to_owned()];
    required.sort();
    let fresh = snapshot.observed_at_ms <= now_ms
        && now_ms - snapshot.observed_at_ms <= expected.max_age_ms;
    if snapshot.room_id != expected.room_id
        || snapshot.owner_mxid != expected.owner_mxid
        || snapshot.bot_mxid != expected.bot_mxid
        || !snapshot.encrypted
        || !snapshot.invite_only
        || joined != required
        || snapshot.pending_invites != 0
        || !snapshot.history_visibility_joined
        || snapshot.public_alias
        || snapshot.public_listing
        || snapshot.guests_allowed
        || snapshot.bridges_present
        || snapshot.widgets_present
        || !snapshot.owner_devices_trusted
        || !snapshot.bot_device_trusted
        || !snapshot.devices_non_revoked
        || !fresh
    {
        return Err(RoomPolicyError);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> RoomPolicySnapshot {
        RoomPolicySnapshot {
            room_id: "!room:example".into(),
            owner_mxid: "@owner:example".into(),
            bot_mxid: "@bot:example".into(),
            encrypted: true,
            invite_only: true,
            joined_members: vec!["@owner:example".into(), "@bot:example".into()],
            pending_invites: 0,
            history_visibility_joined: true,
            public_alias: false,
            public_listing: false,
            guests_allowed: false,
            bridges_present: false,
            widgets_present: false,
            owner_devices_trusted: true,
            bot_device_trusted: true,
            devices_non_revoked: true,
            observed_at_ms: 100,
        }
    }

    #[test]
    fn every_send_requires_current_exact_policy() {
        let expected = ExpectedRoom {
            room_id: "!room:example",
            owner_mxid: "@owner:example",
            bot_mxid: "@bot:example",
            max_age_ms: 10,
        };
        assert!(validate(&valid(), &expected, 109).is_ok());
        assert!(validate(&valid(), &expected, 111).is_err());
        let mut future = valid();
        future.observed_at_ms = 101;
        assert!(validate(&future, &expected, 100).is_err());
        let mut invalid = valid();
        invalid.joined_members.push("@third:example".into());
        assert!(validate(&invalid, &expected, 100).is_err());
    }
}
