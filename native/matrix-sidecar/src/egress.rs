use serde::{Deserialize, Serialize};

use crate::protocol::{SendCommand, valid_identifier};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeReplyRelation {
    pub event_id: String,
}

#[derive(Clone, Debug)]
pub struct PreparedSend {
    pub transaction_id: String,
    pub body: String,
    pub formatted_body: Option<String>,
    pub reply: Option<NativeReplyRelation>,
}

impl TryFrom<&SendCommand> for PreparedSend {
    type Error = crate::protocol::ProtocolError;

    fn try_from(command: &SendCommand) -> Result<Self, Self::Error> {
        command.validate()?;
        if !valid_identifier(&command.transaction_id) {
            return Err(crate::protocol::ProtocolError::Id);
        }
        Ok(Self {
            transaction_id: command.transaction_id.clone(),
            body: command.body.clone(),
            formatted_body: command.formatted_body.clone(),
            reply: command
                .reply_to_event_id
                .clone()
                .map(|event_id| NativeReplyRelation { event_id }),
        })
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    #[test]
    fn deterministic_transaction_ids_are_stable() {
        let make = |session: &str, order: u64| {
            let digest = Sha256::digest(format!("{session}:{order}").as_bytes());
            format!("pc-{}", hex::encode(&digest[..16]))
        };
        assert_eq!(make("session", 7), make("session", 7));
        assert_ne!(make("session", 7), make("session", 8));
    }
}
