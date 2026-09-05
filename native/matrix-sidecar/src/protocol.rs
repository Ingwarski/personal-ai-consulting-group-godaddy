use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config::{
    MAX_FORMATTED_BYTES, MAX_FRAME_BYTES, MAX_ID_BYTES, MAX_OUTSTANDING_REQUESTS,
    MAX_PLAINTEXT_BYTES, MAX_REPLAY_IDS, PROTOCOL_VERSION,
};
use crate::ingress::IngressAck;
use crate::media_spool::MediaReference;
use crate::room_policy::RoomPolicySnapshot;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum IncomingFrame {
    Hello {
        version: u16,
        id: String,
        supervisor: String,
    },
    Request {
        version: u16,
        id: String,
        command: RequestCommand,
    },
    Ack {
        version: u16,
        id: String,
        ack: IngressAck,
    },
    Shutdown {
        version: u16,
        id: String,
    },
}

impl IncomingFrame {
    fn version(&self) -> u16 {
        match self {
            Self::Hello { version, .. }
            | Self::Request { version, .. }
            | Self::Ack { version, .. }
            | Self::Shutdown { version, .. } => *version,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Hello { id, .. }
            | Self::Request { id, .. }
            | Self::Ack { id, .. }
            | Self::Shutdown { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "name", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestCommand {
    Initialize,
    Health,
    Send(Box<SendCommand>),
    InspectMedia { media: Vec<MediaReference> },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendCommand {
    pub room_policy: RoomPolicySnapshot,
    pub transaction_id: String,
    pub body: String,
    pub formatted_body: Option<String>,
    pub reply_to_event_id: Option<String>,
    #[serde(default)]
    pub media: Vec<MediaReference>,
}

impl SendCommand {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.body.trim().is_empty()
            || self.body.contains('\0')
            || self.body.len() > MAX_PLAINTEXT_BYTES
            || self.formatted_body.as_ref().is_some_and(|body| {
                body.trim().is_empty() || body.contains('\0') || body.len() > MAX_FORMATTED_BYTES
            })
            || !valid_identifier(&self.transaction_id)
            || self
                .reply_to_event_id
                .as_ref()
                .is_some_and(|id| !valid_matrix_event_id(id))
            || !self.media.is_empty()
        {
            return Err(ProtocolError::Schema);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutgoingFrame {
    Hello {
        version: u16,
        id: String,
        build: String,
    },
    Ready {
        version: u16,
        id: String,
        readiness: crate::state::Readiness,
        identity: ReadyIdentity,
    },
    Response {
        version: u16,
        id: String,
        ok: bool,
        result: Option<ResponseBody>,
        error: Option<PublicError>,
    },
    Event {
        version: u16,
        id: String,
        event: crate::ingress::IngressEvent,
    },
    EventRejected {
        version: u16,
        id: String,
        rejection: RejectedEvent,
    },
    Status {
        version: u16,
        id: String,
        readiness: crate::state::Readiness,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct ReadyIdentity {
    pub build: String,
    pub homeserver_origin: String,
    pub room_id_sha256: String,
    pub owner_mxid_sha256: String,
    pub bot_mxid_sha256: String,
    pub bot_device_id_sha256: String,
    pub store_fingerprint: String,
    pub spool_instance: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RejectedEvent {
    pub event_id: String,
    pub room_id: String,
    pub sender_mxid: String,
    pub sender_device_id: String,
    pub body_hash: String,
    pub media_manifest_hash: String,
    pub event_hash: String,
    pub reason: crate::ingress::IngressRejection,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "name", rename_all = "snake_case")]
pub enum ResponseBody {
    Initialized,
    Health,
    Accepted {
        event_id: String,
    },
    Media {
        objects: Vec<crate::media_spool::InspectedMedia>,
    },
    ShutdownAccepted,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicError {
    InvalidFrame,
    InvalidState,
    NotReady,
    PolicyDenied,
    MediaDenied,
    LockContended,
    StoreQuarantined,
    TransportFailed,
}

impl OutgoingFrame {
    pub fn hello() -> Self {
        Self::Hello {
            version: PROTOCOL_VERSION,
            id: "sidecar-hello".into(),
            build: env!("CARGO_PKG_VERSION").into(),
        }
    }

    pub fn error(id: impl Into<String>, error: PublicError) -> Self {
        Self::Response {
            version: PROTOCOL_VERSION,
            id: id.into(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }

    pub fn rejected(rejection: crate::ingress::PendingRejection) -> Self {
        Self::EventRejected {
            version: PROTOCOL_VERSION,
            id: rejection.receipt_id,
            rejection: RejectedEvent {
                event_id: rejection.event_id,
                room_id: rejection.room_id,
                sender_mxid: rejection.sender_mxid,
                sender_device_id: rejection.sender_device_id,
                body_hash: rejection.body_hash,
                media_manifest_hash: rejection.media_manifest_hash,
                event_hash: rejection.event_hash,
                reason: rejection.reason,
            },
        }
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ProtocolError {
    #[error("frame exceeds limit")]
    Oversized,
    #[error("frame encoding is invalid")]
    Encoding,
    #[error("frame schema is invalid")]
    Schema,
    #[error("frame version is unsupported")]
    Version,
    #[error("frame id is invalid")]
    Id,
    #[error("frame id has already been observed")]
    Duplicate,
    #[error("outstanding request limit reached")]
    Backpressure,
}

#[derive(Debug, Default)]
pub struct FrameDecoder {
    outstanding: HashSet<String>,
    // Bounded for one child-process generation. Node drains and retires the
    // child before this hard limit; only a fresh verified process gets an
    // empty set. Eviction or resetting a live decoder would admit replays.
    observed: HashSet<String>,
}

impl FrameDecoder {
    pub fn decode(&mut self, bytes: &[u8]) -> Result<IncomingFrame, ProtocolError> {
        let payload = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        if payload.len() > MAX_FRAME_BYTES {
            return Err(ProtocolError::Oversized);
        }
        std::str::from_utf8(payload).map_err(|_| ProtocolError::Encoding)?;
        let frame: IncomingFrame =
            serde_json::from_slice(payload).map_err(|_| ProtocolError::Schema)?;
        if frame.version() != PROTOCOL_VERSION {
            return Err(ProtocolError::Version);
        }
        if !valid_identifier(frame.id()) {
            return Err(ProtocolError::Id);
        }
        match &frame {
            IncomingFrame::Hello { supervisor, .. } if !valid_identifier(supervisor) => {
                return Err(ProtocolError::Schema);
            }
            IncomingFrame::Ack { ack, .. } if !ack.is_valid() => {
                return Err(ProtocolError::Schema);
            }
            _ => {}
        }
        let is_request = matches!(frame, IncomingFrame::Request { .. });
        if let IncomingFrame::Request {
            command: RequestCommand::Send(command),
            ..
        } = &frame
        {
            command.validate()?;
        }
        if self.observed.contains(frame.id()) {
            return Err(ProtocolError::Duplicate);
        }
        if is_request && self.outstanding.len() >= MAX_OUTSTANDING_REQUESTS {
            return Err(ProtocolError::Backpressure);
        }
        self.remember(frame.id())?;
        if is_request {
            self.outstanding.insert(frame.id().to_owned());
        }
        Ok(frame)
    }

    pub fn complete(&mut self, id: &str) {
        self.outstanding.remove(id);
    }

    fn remember(&mut self, id: &str) -> Result<(), ProtocolError> {
        if self.observed.len() >= MAX_REPLAY_IDS {
            return Err(ProtocolError::Backpressure);
        }
        self.observed.insert(id.to_owned());
        Ok(())
    }
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn valid_matrix_event_id(value: &str) -> bool {
    value.starts_with('$')
        && value.len() <= 255
        && value.is_ascii()
        && !value.bytes().any(|byte| byte.is_ascii_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_fields_types_versions_and_invalid_ids() {
        let mut decoder = FrameDecoder::default();
        assert!(matches!(decoder.decode(br#"{"version":1,"type":"request","id":"ok","command":{"name":"health"},"extra":true}"#), Err(ProtocolError::Schema)));
        assert!(matches!(
            decoder.decode(br#"{"version":1,"type":"mystery","id":"ok"}"#),
            Err(ProtocolError::Schema)
        ));
        assert!(matches!(
            decoder
                .decode(br#"{"version":2,"type":"request","id":"ok","command":{"name":"health"}}"#),
            Err(ProtocolError::Version)
        ));
        assert!(matches!(
            decoder.decode(
                br#"{"version":1,"type":"request","id":"has space","command":{"name":"health"}}"#
            ),
            Err(ProtocolError::Id)
        ));
        assert!(matches!(
            decoder
                .decode(br#"{"version":1,"type":"hello","id":"hello","supervisor":"has space"}"#),
            Err(ProtocolError::Schema)
        ));
        assert!(matches!(
            decoder.decode(br#"{"version":1,"type":"request","id":"empty-send","command":{"name":"send","room_policy":{"room_id":"!room:example","owner_mxid":"@owner:example","bot_mxid":"@bot:example","encrypted":true,"invite_only":true,"joined_members":["@owner:example","@bot:example"],"pending_invites":0,"history_visibility_joined":true,"public_alias":false,"public_listing":false,"guests_allowed":false,"bridges_present":false,"widgets_present":false,"owner_devices_trusted":true,"bot_device_trusted":true,"devices_non_revoked":true,"observed_at_ms":1},"transaction_id":"txn-1","body":" ","formatted_body":null,"reply_to_event_id":null,"media":[]}}"#),
            Err(ProtocolError::Schema)
        ));
    }

    #[test]
    fn rejects_malformed_utf8_and_oversized_frames() {
        assert!(matches!(
            FrameDecoder::default().decode(&[0xff]),
            Err(ProtocolError::Encoding)
        ));
        assert!(matches!(
            FrameDecoder::default().decode(&vec![b'x'; MAX_FRAME_BYTES + 1]),
            Err(ProtocolError::Oversized)
        ));
    }

    #[test]
    fn rejects_duplicate_request_id_after_response_completion() {
        let frame = br#"{"version":1,"type":"request","id":"r-1","command":{"name":"health"}}"#;
        let mut decoder = FrameDecoder::default();
        decoder.decode(frame).unwrap();
        assert!(matches!(
            decoder.decode(frame),
            Err(ProtocolError::Duplicate)
        ));
        decoder.complete("r-1");
        assert!(matches!(
            decoder.decode(frame),
            Err(ProtocolError::Duplicate)
        ));
    }

    #[test]
    fn rejects_replayed_hello_ack_and_shutdown_ids() {
        for frame in [
            br#"{"version":1,"type":"hello","id":"replayed","supervisor":"godaddy-node"}"#.as_slice(),
            br#"{"version":1,"type":"ack","id":"replayed","ack":{"event_id":"$event:example","durable_receipt_id":"mysql-1"}}"#.as_slice(),
            br#"{"version":1,"type":"shutdown","id":"replayed"}"#.as_slice(),
        ] {
            let mut decoder = FrameDecoder::default();
            decoder.decode(frame).unwrap();
            assert!(matches!(
                decoder.decode(frame),
                Err(ProtocolError::Duplicate)
            ));
        }
    }

    #[test]
    fn completed_id_memory_saturates_fail_closed_without_eviction() {
        let mut decoder = FrameDecoder::default();
        for index in 0..MAX_REPLAY_IDS {
            decoder
                .decode(
                    format!(r#"{{"version":1,"type":"shutdown","id":"shutdown-{index}"}}"#)
                        .as_bytes(),
                )
                .unwrap();
        }
        assert_eq!(decoder.observed.len(), MAX_REPLAY_IDS);
        assert!(matches!(
            decoder.decode(br#"{"version":1,"type":"shutdown","id":"after-cap"}"#),
            Err(ProtocolError::Backpressure)
        ));
        assert!(matches!(
            decoder.decode(br#"{"version":1,"type":"shutdown","id":"shutdown-0"}"#),
            Err(ProtocolError::Duplicate)
        ));
    }

    #[test]
    fn replay_memory_remains_bounded_across_clean_process_generations() {
        for generation in 0..3 {
            let mut decoder = FrameDecoder::default();
            for index in 0..3_072 {
                let id = format!("request-{generation}-{index}");
                let frame = format!(
                    r#"{{"version":1,"type":"request","id":"{id}","command":{{"name":"health"}}}}"#
                );
                decoder.decode(frame.as_bytes()).unwrap();
                decoder.complete(&id);
                assert!(matches!(
                    decoder.decode(frame.as_bytes()),
                    Err(ProtocolError::Duplicate)
                ));
            }
            assert_eq!(decoder.observed.len(), 3_072);
            decoder
                .decode(
                    format!(r#"{{"version":1,"type":"shutdown","id":"shutdown-{generation}"}}"#)
                        .as_bytes(),
                )
                .unwrap();
            assert!(decoder.observed.len() < MAX_REPLAY_IDS);
            // Dropping this decoder models a confirmed process exit, never
            // a live-session replay-history reset.
        }
    }

    #[test]
    fn node_wire_fixtures_round_trip_strict_schema() {
        let fixtures = [
            br#"{"type":"hello","version":1,"id":"hello-1","supervisor":"godaddy-node"}"#.as_slice(),
            br#"{"type":"request","version":1,"id":"initialize-1","command":{"name":"initialize"}}"#.as_slice(),
            br#"{"type":"request","version":1,"id":"send-1","command":{"name":"send","room_policy":{"room_id":"!room:example","owner_mxid":"@owner:example","bot_mxid":"@bot:example","encrypted":true,"invite_only":true,"joined_members":["@owner:example","@bot:example"],"pending_invites":0,"history_visibility_joined":true,"public_alias":false,"public_listing":false,"guests_allowed":false,"bridges_present":false,"widgets_present":false,"owner_devices_trusted":true,"bot_device_trusted":true,"devices_non_revoked":true,"observed_at_ms":1},"transaction_id":"txn-1","body":"hello","formatted_body":null,"reply_to_event_id":null,"media":[]}}"#.as_slice(),
            br#"{"type":"ack","version":1,"id":"ack-1","ack":{"event_id":"$event:example","durable_receipt_id":"mysql-1"}}"#.as_slice(),
            br#"{"type":"shutdown","version":1,"id":"shutdown-1"}"#.as_slice(),
        ];
        let mut decoder = FrameDecoder::default();
        for fixture in fixtures {
            let id = decoder.decode(fixture).unwrap().id().to_owned();
            decoder.complete(&id);
        }

        let hello = serde_json::to_value(OutgoingFrame::hello()).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["version"], 1);
        assert_eq!(hello["id"], "sidecar-hello");
        assert!(hello["build"].is_string());
        let success = serde_json::to_value(OutgoingFrame::Response {
            version: 1,
            id: "initialize-1".into(),
            ok: true,
            result: Some(ResponseBody::Initialized),
            error: None,
        })
        .unwrap();
        assert_eq!(success["result"]["name"], "initialized");
        assert!(success["error"].is_null());

        let ready = serde_json::to_value(OutgoingFrame::Ready {
            version: 1,
            id: "sidecar-ready-0123456789abcdef0123456789abcdef".into(),
            readiness: crate::state::Readiness::Ready,
            identity: ReadyIdentity {
                build: "0.1.0".into(),
                homeserver_origin: "https://matrix.org".into(),
                room_id_sha256: "a".repeat(64),
                owner_mxid_sha256: "b".repeat(64),
                bot_mxid_sha256: "c".repeat(64),
                bot_device_id_sha256: "d".repeat(64),
                store_fingerprint: "e".repeat(64),
                spool_instance: "0123456789abcdef0123456789abcdef".into(),
            },
        })
        .unwrap();
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["readiness"], "ready");
        assert_eq!(ready["identity"]["homeserver_origin"], "https://matrix.org");
        assert_eq!(
            ready["identity"]["spool_instance"].as_str().unwrap().len(),
            32
        );
    }
}
