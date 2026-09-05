use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    Starting,
    Ready,
    Blocked,
    Quarantined,
    ShuttingDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SendState {
    Pending,
    Accepted,
    DeviceDelivered,
    Read,
}

impl SendState {
    pub fn advance(self, next: Self) -> Result<Self, StateError> {
        use SendState::{Accepted, DeviceDelivered, Pending, Read};
        if matches!(
            (self, next),
            (Pending, Accepted) | (Accepted, DeviceDelivered) | (DeviceDelivered, Read)
        ) {
            Ok(next)
        } else {
            Err(StateError)
        }
    }
}

#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("invalid state transition")]
pub struct StateError;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn homeserver_acceptance_is_not_delivery_or_read() {
        assert_eq!(
            SendState::Pending.advance(SendState::Accepted).unwrap(),
            SendState::Accepted
        );
        assert!(SendState::Accepted.advance(SendState::Read).is_err());
        assert!(
            SendState::Pending
                .advance(SendState::DeviceDelivered)
                .is_err()
        );
    }
}
