use std::collections::HashSet;
use std::fs;
#[cfg(test)]
use std::fs::OpenOptions;
#[cfg(test)]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, AeadCore, KeyInit, OsRng},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::config::{
    MAX_FRAME_BYTES, MAX_MEDIA_AGGREGATE_BYTES, MAX_MEDIA_OBJECTS, MAX_PLAINTEXT_BYTES,
    MAX_UNACKED_EVENTS,
};
use crate::media_spool::MediaReference;
use crate::protocol::valid_identifier;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IngressEvent {
    pub event_id: String,
    pub room_id: String,
    pub sender_mxid: String,
    pub sender_device_id: String,
    pub body: Option<String>,
    pub reply_to_event_id: Option<String>,
    pub media: Vec<MediaReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PendingIngress {
    pub sequence: u64,
    pub receipt_id: String,
    pub event: IngressEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PendingRejection {
    pub sequence: u64,
    pub receipt_id: String,
    pub event_id: String,
    pub room_id: String,
    pub sender_mxid: String,
    pub sender_device_id: String,
    pub reason: IngressRejection,
    pub body_hash: String,
    pub media_manifest_hash: String,
    pub event_hash: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IngressRejection {
    MediaExpired,
    InvalidMedia,
}

#[derive(Debug)]
pub struct ExpiredIngress {
    pub rejection: PendingRejection,
    pub media: Vec<MediaReference>,
}

#[derive(Debug)]
pub enum PersistOutcome {
    Created(PendingIngress),
    Existing(PendingIngress),
    Finalized,
}

impl PersistOutcome {
    pub fn requires_incoming_media_cleanup(&self) -> bool {
        !matches!(self, Self::Created(_))
    }

    pub fn into_pending(self) -> Option<PendingIngress> {
        match self {
            Self::Created(pending) | Self::Existing(pending) => Some(pending),
            Self::Finalized => None,
        }
    }

    #[cfg(test)]
    fn is_none(&self) -> bool {
        matches!(self, Self::Finalized)
    }
}

#[derive(Debug)]
pub enum OrderedReplay {
    Ingress(PendingIngress),
    Rejected(PendingRejection),
}

impl OrderedReplay {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Ingress(pending) => pending.sequence,
            Self::Rejected(rejection) => rejection.sequence,
        }
    }

    pub fn receipt_id(&self) -> &str {
        match self {
            Self::Ingress(pending) => &pending.receipt_id,
            Self::Rejected(rejection) => &rejection.receipt_id,
        }
    }
}

#[derive(Debug, Error)]
#[error("pending ingress journal is unavailable")]
pub struct JournalError;

#[derive(Clone)]
pub struct PendingJournal {
    root: PathBuf,
    rejection_root: PathBuf,
    ack_root: PathBuf,
    cipher: XChaCha20Poly1305,
    mutation: Arc<Mutex<()>>,
}

const MAX_ACK_TOMBSTONES: usize = 4_096;
const ACK_TOMBSTONE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Debug)]
pub struct AckOutcome {
    pub pending: Option<PendingIngress>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AckTombstone {
    receipt_id: String,
    event_id: String,
    event_hash: String,
    durable_receipt_id: String,
    acknowledged_at_ms: u64,
}

impl PendingJournal {
    pub fn open(store_root: &Path, passphrase: &str) -> Result<Self, JournalError> {
        if !crate::config::valid_secret_key(passphrase) {
            return Err(JournalError);
        }
        let root = store_root.join("pending-ingress");
        let rejection_root = store_root.join("rejected-ingress");
        let ack_root = store_root.join("ingress-ack-tombstones");
        crate::lock::ensure_private_directory(&root).map_err(|_| JournalError)?;
        crate::lock::ensure_private_directory(&rejection_root).map_err(|_| JournalError)?;
        crate::lock::ensure_private_directory(&ack_root).map_err(|_| JournalError)?;
        crate::lock::cleanup_atomic_temps(&root, |target| valid_journal_target(target, "pending"))
            .map_err(|_| JournalError)?;
        crate::lock::cleanup_atomic_temps(&rejection_root, |target| {
            valid_journal_target(target, "rejected")
        })
        .map_err(|_| JournalError)?;
        crate::lock::cleanup_atomic_temps(&ack_root, |target| valid_journal_target(target, "ack"))
            .map_err(|_| JournalError)?;
        let key_material = hex::decode(passphrase).map_err(|_| JournalError)?;
        let key = Sha256::digest(
            [
                b"personal-consultant/pending-ingress/v1".as_slice(),
                key_material.as_slice(),
            ]
            .concat(),
        );
        let journal = Self {
            root,
            rejection_root,
            ack_root,
            cipher: XChaCha20Poly1305::new(&key),
            mutation: Arc::new(Mutex::new(())),
        };
        {
            let _guard = journal.mutation.lock().map_err(|_| JournalError)?;
            journal.prune_tombstones_locked(SystemTime::now(), MAX_ACK_TOMBSTONES)?;
        }
        Ok(journal)
    }

    pub fn persist(&self, event: IngressEvent) -> Result<PersistOutcome, JournalError> {
        if !event.is_valid() {
            return Err(JournalError);
        }
        let receipt_id = receipt_id_for(&event.event_id, &event.sender_device_id);
        let event_key = event_key_for(&event.event_id);
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        let path = self.root.join(format!("{event_key}.pending"));
        let acknowledged_path = self.ack_root.join(format!("{event_key}.ack"));
        if acknowledged_path.exists() {
            let tombstone = load_tombstone(&acknowledged_path)?;
            let event_hash = ingress_hashes(&event)?.event;
            return if tombstone.event_id == event.event_id
                && tombstone.receipt_id == receipt_id
                && tombstone.event_hash == event_hash
            {
                Ok(PersistOutcome::Finalized)
            } else {
                Err(JournalError)
            };
        }
        let rejected_path = self.rejection_root.join(format!("{event_key}.rejected"));
        if rejected_path.exists() {
            let rejected = self.load_rejection(&rejected_path)?;
            let candidate = PendingIngress {
                sequence: rejected.sequence,
                receipt_id,
                event,
            };
            return if rejected.matches(&PendingRejection::from_pending(&candidate)?) {
                Ok(PersistOutcome::Finalized)
            } else {
                Err(JournalError)
            };
        }
        if path.exists() {
            let existing = self.load(&path)?;
            return if existing.receipt_id == receipt_id
                && ingress_hashes(&existing.event)?.event == ingress_hashes(&event)?.event
            {
                Ok(PersistOutcome::Existing(existing))
            } else {
                Err(JournalError)
            };
        }
        let ordered = self.replay_ordered_locked(MAX_UNACKED_EVENTS)?;
        if ordered.len() >= MAX_UNACKED_EVENTS {
            return Err(JournalError);
        }
        let sequence = ordered
            .last()
            .map(OrderedReplay::sequence)
            .unwrap_or(0)
            .checked_add(1)
            .filter(|sequence| *sequence > 0)
            .ok_or(JournalError)?;
        let pending = PendingIngress {
            sequence,
            receipt_id,
            event,
        };
        self.write_encrypted_once(&path, &pending, MAX_FRAME_BYTES)?;
        sync_directory(&self.root)?;
        Ok(PersistOutcome::Created(pending))
    }

    /// Records a permanent media rejection without storing the attachment's
    /// content, encrypted source/key, caption, or filesystem path.
    pub fn reject_invalid_media(
        &self,
        event: &IngressEvent,
        descriptor: &serde_json::Value,
    ) -> Result<Option<PendingRejection>, JournalError> {
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        let event_key = event_key_for(&event.event_id);
        let body_hash = hash_json(&event.body)?;
        let media_manifest_hash = hash_json(descriptor)?;
        let event_hash = hash_json(&HashEvent {
            event_id: &event.event_id,
            room_id: &event.room_id,
            sender_mxid: &event.sender_mxid,
            sender_device_id: &event.sender_device_id,
            encrypted: true,
            body_hash: &body_hash,
            relation_event_id: event.reply_to_event_id.as_deref(),
            media_manifest_hash: &media_manifest_hash,
        })?;
        let mut rejection = PendingRejection {
            sequence: 1,
            receipt_id: receipt_id_for(&event.event_id, &event.sender_device_id),
            event_id: event.event_id.clone(),
            room_id: event.room_id.clone(),
            sender_mxid: event.sender_mxid.clone(),
            sender_device_id: event.sender_device_id.clone(),
            reason: IngressRejection::InvalidMedia,
            body_hash,
            media_manifest_hash,
            event_hash,
        };
        if !rejection.is_valid() {
            return Err(JournalError);
        }
        let ack_path = self.ack_root.join(format!("{event_key}.ack"));
        if ack_path.exists() {
            let tombstone = load_tombstone(&ack_path)?;
            return if tombstone.event_id == rejection.event_id
                && tombstone.receipt_id == rejection.receipt_id
                && tombstone.event_hash == rejection.event_hash
            {
                Ok(None)
            } else {
                Err(JournalError)
            };
        }
        let rejected_path = self.rejection_root.join(format!("{event_key}.rejected"));
        if rejected_path.exists() {
            let existing = self.load_rejection(&rejected_path)?;
            rejection.sequence = existing.sequence;
            return if existing.matches(&rejection) {
                Ok(Some(existing))
            } else {
                Err(JournalError)
            };
        }
        if self.root.join(format!("{event_key}.pending")).exists() {
            return Err(JournalError);
        }
        let ordered = self.replay_ordered_locked(MAX_UNACKED_EVENTS)?;
        if ordered.len() >= MAX_UNACKED_EVENTS {
            return Err(JournalError);
        }
        rejection.sequence = ordered
            .last()
            .map(OrderedReplay::sequence)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(JournalError)?;
        self.write_encrypted_once(&rejected_path, &rejection, 4 * 1024)?;
        sync_directory(&self.rejection_root)?;
        Ok(Some(rejection))
    }

    pub fn replay(&self, maximum: usize) -> Result<Vec<PendingIngress>, JournalError> {
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        Ok(self
            .replay_ordered_locked(maximum)?
            .into_iter()
            .filter_map(|item| match item {
                OrderedReplay::Ingress(pending) => Some(pending),
                OrderedReplay::Rejected(_) => None,
            })
            .collect())
    }

    pub fn replay_rejections(&self, maximum: usize) -> Result<Vec<PendingRejection>, JournalError> {
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        Ok(self
            .replay_ordered_locked(maximum)?
            .into_iter()
            .filter_map(|item| match item {
                OrderedReplay::Ingress(_) => None,
                OrderedReplay::Rejected(rejection) => Some(rejection),
            })
            .collect())
    }

    pub fn replay_ordered(&self, maximum: usize) -> Result<Vec<OrderedReplay>, JournalError> {
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        self.replay_ordered_locked(maximum)
    }

    pub fn unacked_count(&self) -> Result<usize, JournalError> {
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        pending_count(&self.root)?
            .checked_add(rejection_count(&self.rejection_root)?)
            .filter(|count| *count <= MAX_UNACKED_EVENTS)
            .ok_or(JournalError)
    }

    pub fn active_media_handles(&self) -> Result<HashSet<String>, JournalError> {
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        Ok(self
            .replay_ordered_locked(MAX_UNACKED_EVENTS)?
            .into_iter()
            .filter_map(|item| match item {
                OrderedReplay::Ingress(pending) => Some(pending),
                OrderedReplay::Rejected(_) => None,
            })
            .flat_map(|pending| pending.event.media.into_iter().map(|media| media.handle))
            .collect())
    }

    pub fn expire_media(&self, ttl: Duration) -> Result<Vec<ExpiredIngress>, JournalError> {
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        let now = SystemTime::now();
        let mut paths = fs::read_dir(&self.root)
            .map_err(|_| JournalError)?
            .map(|entry| entry.map(|entry| entry.path()).map_err(|_| JournalError))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("pending"))
            .collect::<Vec<_>>();
        paths.sort();
        let mut expired = Vec::new();
        for path in paths {
            let metadata = fs::symlink_metadata(&path).map_err(|_| JournalError)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(JournalError);
            }
            if !now
                .duration_since(metadata.modified().map_err(|_| JournalError)?)
                .is_ok_and(|age| age >= ttl)
            {
                continue;
            }
            let pending = self.load(&path)?;
            if pending.event.media.is_empty() {
                continue;
            }
            let rejection = PendingRejection::from_pending(&pending)?;
            let event_key = event_key_for(&pending.event.event_id);
            let rejected_path = self.rejection_root.join(format!("{event_key}.rejected"));
            if rejected_path.exists() {
                let existing = self.load_rejection(&rejected_path)?;
                if !existing.matches(&rejection) {
                    return Err(JournalError);
                }
            } else {
                self.write_encrypted_once(&rejected_path, &rejection, 4 * 1024)?;
                sync_directory(&self.rejection_root)?;
            }
            fs::remove_file(&path).map_err(|_| JournalError)?;
            sync_directory(&self.root)?;
            expired.push(ExpiredIngress {
                rejection,
                media: pending.event.media,
            });
        }
        Ok(expired)
    }

    pub fn acknowledge(&self, ack: &IngressAck) -> Result<AckOutcome, JournalError> {
        if !ack.is_valid() {
            return Err(JournalError);
        }
        let event_key = event_key_for(&ack.event_id);
        let _guard = self.mutation.lock().map_err(|_| JournalError)?;
        let tombstone_path = self.ack_root.join(format!("{event_key}.ack"));
        if tombstone_path.exists() {
            let tombstone = load_tombstone(&tombstone_path)?;
            if tombstone.event_id != ack.event_id
                || tombstone.durable_receipt_id != ack.durable_receipt_id
            {
                return Err(JournalError);
            }
            let pending_path = self.root.join(format!("{event_key}.pending"));
            let rejected_path = self.rejection_root.join(format!("{event_key}.rejected"));
            let pending = if pending_path.exists() {
                let pending = self.load(&pending_path)?;
                if pending.event.event_id != ack.event_id
                    || pending.receipt_id != tombstone.receipt_id
                    || ingress_hashes(&pending.event)?.event != tombstone.event_hash
                {
                    return Err(JournalError);
                }
                fs::remove_file(pending_path).map_err(|_| JournalError)?;
                sync_directory(&self.root)?;
                Some(pending)
            } else {
                None
            };
            if rejected_path.exists() {
                let rejected = self.load_rejection(&rejected_path)?;
                if rejected.event_id != ack.event_id
                    || rejected.receipt_id != tombstone.receipt_id
                    || rejected.event_hash != tombstone.event_hash
                {
                    return Err(JournalError);
                }
                fs::remove_file(rejected_path).map_err(|_| JournalError)?;
                sync_directory(&self.rejection_root)?;
            }
            return Ok(AckOutcome { pending });
        }
        self.prune_tombstones_locked(SystemTime::now(), MAX_ACK_TOMBSTONES.saturating_sub(1))?;
        let pending_path = self.root.join(format!("{event_key}.pending"));
        let rejected_path = self.rejection_root.join(format!("{event_key}.rejected"));
        let (receipt_id, event_hash, pending) = if rejected_path.exists() {
            let rejected = self.load_rejection(&rejected_path)?;
            if rejected.event_id != ack.event_id {
                return Err(JournalError);
            }
            let pending = if pending_path.exists() {
                let pending = self.load(&pending_path)?;
                if !rejected.matches(&PendingRejection::from_pending(&pending)?) {
                    return Err(JournalError);
                }
                Some(pending)
            } else {
                None
            };
            (rejected.receipt_id, rejected.event_hash, pending)
        } else {
            let pending = self.load(&pending_path)?;
            if pending.event.event_id != ack.event_id {
                return Err(JournalError);
            }
            let event_hash = ingress_hashes(&pending.event)?.event;
            (pending.receipt_id.clone(), event_hash, Some(pending))
        };
        let tombstone = AckTombstone {
            receipt_id,
            event_id: ack.event_id.clone(),
            event_hash,
            durable_receipt_id: ack.durable_receipt_id.clone(),
            acknowledged_at_ms: now_ms(),
        };
        write_tombstone_once(&tombstone_path, &tombstone)?;
        sync_directory(&self.ack_root)?;
        if pending_path.exists() {
            fs::remove_file(pending_path).map_err(|_| JournalError)?;
            sync_directory(&self.root)?;
        }
        if rejected_path.exists() {
            fs::remove_file(rejected_path).map_err(|_| JournalError)?;
            sync_directory(&self.rejection_root)?;
        }
        Ok(AckOutcome { pending })
    }

    fn load(&self, path: &Path) -> Result<PendingIngress, JournalError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| JournalError)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 512 * 1024 {
            return Err(JournalError);
        }
        let bytes = crate::lock::read_private_file(path, 512 * 1024).map_err(|_| JournalError)?;
        if bytes.len() <= 24 {
            return Err(JournalError);
        }
        let nonce = XNonce::from_slice(&bytes[..24]);
        let plaintext = self
            .cipher
            .decrypt(nonce, &bytes[24..])
            .map_err(|_| JournalError)?;
        let pending: PendingIngress =
            serde_json::from_slice(&plaintext).map_err(|_| JournalError)?;
        let expected_name = format!("{}.pending", event_key_for(&pending.event.event_id));
        if pending.sequence == 0
            || !pending.event.is_valid()
            || pending.receipt_id
                != receipt_id_for(&pending.event.event_id, &pending.event.sender_device_id)
            || path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str())
        {
            return Err(JournalError);
        }
        Ok(pending)
    }

    fn replay_ordered_locked(&self, maximum: usize) -> Result<Vec<OrderedReplay>, JournalError> {
        let pending_paths = fs::read_dir(&self.root)
            .map_err(|_| JournalError)?
            .map(|entry| entry.map(|entry| entry.path()).map_err(|_| JournalError))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("pending"))
            .collect::<Vec<_>>();
        let mut ordered = Vec::new();
        for path in pending_paths {
            let pending = self.load(&path)?;
            let event_key = event_key_for(&pending.event.event_id);
            let rejected_path = self.rejection_root.join(format!("{event_key}.rejected"));
            if rejected_path.exists() {
                let rejected = self.load_rejection(&rejected_path)?;
                if !rejected.matches(&PendingRejection::from_pending(&pending)?) {
                    return Err(JournalError);
                }
            } else {
                ordered.push(OrderedReplay::Ingress(pending));
            }
        }
        for path in rejection_paths(&self.rejection_root)? {
            ordered.push(OrderedReplay::Rejected(self.load_rejection(&path)?));
        }
        if ordered.len() > maximum {
            return Err(JournalError);
        }
        ordered.sort_by_key(OrderedReplay::sequence);
        if ordered
            .windows(2)
            .any(|pair| pair[0].sequence() == pair[1].sequence())
        {
            return Err(JournalError);
        }
        Ok(ordered)
    }

    fn load_rejection(&self, path: &Path) -> Result<PendingRejection, JournalError> {
        let rejection: PendingRejection = self.load_encrypted(path, 4 * 1024)?;
        let expected_name = format!("{}.rejected", event_key_for(&rejection.event_id));
        if !rejection.is_valid()
            || path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str())
        {
            return Err(JournalError);
        }
        Ok(rejection)
    }

    fn load_encrypted<T: for<'de> Deserialize<'de>>(
        &self,
        path: &Path,
        maximum: usize,
    ) -> Result<T, JournalError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| JournalError)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > maximum as u64 + 64
        {
            return Err(JournalError);
        }
        let bytes =
            crate::lock::read_private_file(path, maximum as u64 + 64).map_err(|_| JournalError)?;
        if bytes.len() <= 24 {
            return Err(JournalError);
        }
        let nonce = XNonce::from_slice(&bytes[..24]);
        let plaintext = self
            .cipher
            .decrypt(nonce, &bytes[24..])
            .map_err(|_| JournalError)?;
        if plaintext.len() > maximum {
            return Err(JournalError);
        }
        serde_json::from_slice(&plaintext).map_err(|_| JournalError)
    }

    fn write_encrypted_once<T: Serialize>(
        &self,
        path: &Path,
        value: &T,
        maximum: usize,
    ) -> Result<(), JournalError> {
        let plaintext = serde_json::to_vec(value).map_err(|_| JournalError)?;
        if plaintext.len() > maximum {
            return Err(JournalError);
        }
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_ref())
            .map_err(|_| JournalError)?;
        let mut bytes = nonce.to_vec();
        bytes.extend_from_slice(&ciphertext);
        crate::lock::atomic_create_private(path, &bytes).map_err(|_| JournalError)
    }

    fn prune_tombstones_locked(&self, now: SystemTime, maximum: usize) -> Result<(), JournalError> {
        let mut entries = fs::read_dir(&self.ack_root)
            .map_err(|_| JournalError)?
            .map(|entry| {
                let entry = entry.map_err(|_| JournalError)?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|_| JournalError)?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || path.extension().and_then(|value| value.to_str()) != Some("ack")
                {
                    return Err(JournalError);
                }
                let modified = metadata.modified().map_err(|_| JournalError)?;
                Ok((path, modified))
            })
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|(_, modified)| *modified);
        let excess = entries.len().saturating_sub(maximum);
        let mut changed = false;
        for (index, (path, modified)) in entries.into_iter().enumerate() {
            let expired = now
                .duration_since(modified)
                .is_ok_and(|age| age >= ACK_TOMBSTONE_TTL);
            if index < excess || expired {
                fs::remove_file(path).map_err(|_| JournalError)?;
                changed = true;
            }
        }
        if changed {
            sync_directory(&self.ack_root)?;
        }
        Ok(())
    }
}

impl IngressEvent {
    fn is_valid(&self) -> bool {
        let body_valid = self.body.as_ref().is_none_or(|body| {
            !body.trim().is_empty() && !body.contains('\0') && body.len() <= MAX_PLAINTEXT_BYTES
        });
        let reply_valid = self
            .reply_to_event_id
            .as_ref()
            .is_none_or(|value| valid_matrix_event_id(value));
        let media_total = self
            .media
            .iter()
            .try_fold(0_u64, |total, item| total.checked_add(item.length));
        valid_matrix_event_id(&self.event_id)
            && self.room_id.starts_with('!')
            && self.room_id.len() <= 255
            && self.room_id.is_ascii()
            && self.sender_mxid.starts_with('@')
            && self.sender_mxid.len() <= 255
            && self.sender_mxid.is_ascii()
            && !self.sender_device_id.is_empty()
            && self.sender_device_id.len() <= 255
            && self.sender_device_id.is_ascii()
            && body_valid
            && reply_valid
            && self.media.len() <= MAX_MEDIA_OBJECTS
            && media_total.is_some_and(|total| total <= MAX_MEDIA_AGGREGATE_BYTES)
            && (self.body.is_some() || !self.media.is_empty())
    }
}

impl PendingRejection {
    fn from_pending(pending: &PendingIngress) -> Result<Self, JournalError> {
        let hashes = ingress_hashes(&pending.event)?;
        Ok(Self {
            sequence: pending.sequence,
            receipt_id: pending.receipt_id.clone(),
            event_id: pending.event.event_id.clone(),
            room_id: pending.event.room_id.clone(),
            sender_mxid: pending.event.sender_mxid.clone(),
            sender_device_id: pending.event.sender_device_id.clone(),
            reason: IngressRejection::MediaExpired,
            body_hash: hashes.body,
            media_manifest_hash: hashes.media_manifest,
            event_hash: hashes.event,
        })
    }

    fn is_valid(&self) -> bool {
        self.sequence > 0
            && valid_matrix_event_id(&self.event_id)
            && self.room_id.starts_with('!')
            && self.room_id.len() <= 255
            && self.room_id.is_ascii()
            && self.sender_mxid.starts_with('@')
            && self.sender_mxid.len() <= 255
            && self.sender_mxid.is_ascii()
            && !self.sender_device_id.is_empty()
            && self.sender_device_id.len() <= 255
            && self.sender_device_id.is_ascii()
            && self.receipt_id == receipt_id_for(&self.event_id, &self.sender_device_id)
            && [&self.body_hash, &self.media_manifest_hash, &self.event_hash]
                .into_iter()
                .all(|value| valid_lower_sha256(value))
    }

    fn matches(&self, other: &Self) -> bool {
        self.sequence == other.sequence
            && self.receipt_id == other.receipt_id
            && self.event_id == other.event_id
            && self.room_id == other.room_id
            && self.sender_mxid == other.sender_mxid
            && self.sender_device_id == other.sender_device_id
            && self.reason == other.reason
            && self.body_hash == other.body_hash
            && self.media_manifest_hash == other.media_manifest_hash
            && self.event_hash == other.event_hash
    }
}

struct IngressHashes {
    body: String,
    media_manifest: String,
    event: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashMedia<'a> {
    declared_mime: &'a str,
    length: u64,
    sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashEvent<'a> {
    event_id: &'a str,
    room_id: &'a str,
    sender_mxid: &'a str,
    sender_device_id: &'a str,
    encrypted: bool,
    body_hash: &'a str,
    relation_event_id: Option<&'a str>,
    media_manifest_hash: &'a str,
}

fn ingress_hashes(event: &IngressEvent) -> Result<IngressHashes, JournalError> {
    let media = event
        .media
        .iter()
        .map(|item| HashMedia {
            declared_mime: &item.declared_mime,
            length: item.length,
            sha256: &item.sha256,
        })
        .collect::<Vec<_>>();
    let body = hash_json(&event.body)?;
    let media_manifest = hash_json(&media)?;
    let event_hash = hash_json(&HashEvent {
        event_id: &event.event_id,
        room_id: &event.room_id,
        sender_mxid: &event.sender_mxid,
        sender_device_id: &event.sender_device_id,
        encrypted: true,
        body_hash: &body,
        relation_event_id: event.reply_to_event_id.as_deref(),
        media_manifest_hash: &media_manifest,
    })?;
    Ok(IngressHashes {
        body,
        media_manifest,
        event: event_hash,
    })
}

fn hash_json(value: &impl Serialize) -> Result<String, JournalError> {
    let bytes = serde_json::to_vec(value).map_err(|_| JournalError)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn valid_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IngressAck {
    pub event_id: String,
    pub durable_receipt_id: String,
}

impl IngressAck {
    pub fn is_valid(&self) -> bool {
        valid_matrix_event_id(&self.event_id) && valid_identifier(&self.durable_receipt_id)
    }
}

fn valid_matrix_event_id(value: &str) -> bool {
    value.starts_with('$')
        && value.len() <= 255
        && value.is_ascii()
        && !value.bytes().any(|byte| byte.is_ascii_whitespace())
}

fn receipt_id_for(event_id: &str, sender_device_id: &str) -> String {
    format!(
        "ingress-{}",
        &hex::encode(Sha256::digest(
            [event_id.as_bytes(), b"\0", sender_device_id.as_bytes()].concat()
        ))[..32]
    )
}

fn event_key_for(event_id: &str) -> String {
    format!(
        "event-{}",
        &hex::encode(Sha256::digest(event_id.as_bytes()))[..32]
    )
}

fn valid_journal_target(target: &str, extension: &str) -> bool {
    let Some(key) = target.strip_suffix(&format!(".{extension}")) else {
        return false;
    };
    let Some(hash) = key.strip_prefix("event-") else {
        return false;
    };
    hash.len() == 32
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn pending_count(root: &Path) -> Result<usize, JournalError> {
    let entries = fs::read_dir(root)
        .map_err(|_| JournalError)?
        .map(|entry| entry.map_err(|_| JournalError))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries
        .into_iter()
        .filter(|entry| {
            entry.path().extension().and_then(|value| value.to_str()) == Some("pending")
        })
        .take(MAX_UNACKED_EVENTS + 1)
        .count())
}

fn rejection_paths(root: &Path) -> Result<Vec<PathBuf>, JournalError> {
    fs::read_dir(root)
        .map_err(|_| JournalError)?
        .map(|entry| {
            let entry = entry.map_err(|_| JournalError)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| JournalError)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || path.extension().and_then(|value| value.to_str()) != Some("rejected")
            {
                return Err(JournalError);
            }
            Ok(path)
        })
        .collect()
}

fn rejection_count(root: &Path) -> Result<usize, JournalError> {
    Ok(rejection_paths(root)?
        .into_iter()
        .take(MAX_UNACKED_EVENTS + 1)
        .count())
}

fn write_tombstone_once(path: &Path, tombstone: &AckTombstone) -> Result<(), JournalError> {
    let bytes = serde_json::to_vec(tombstone).map_err(|_| JournalError)?;
    if bytes.len() > 4 * 1024 {
        return Err(JournalError);
    }
    crate::lock::atomic_create_private(path, &bytes).map_err(|_| JournalError)
}

fn load_tombstone(path: &Path) -> Result<AckTombstone, JournalError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| JournalError)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4 * 1024 {
        return Err(JournalError);
    }
    let tombstone: AckTombstone = serde_json::from_slice(
        &crate::lock::read_private_file(path, 4 * 1024).map_err(|_| JournalError)?,
    )
    .map_err(|_| JournalError)?;
    if !valid_matrix_event_id(&tombstone.event_id)
        || !valid_identifier(&tombstone.receipt_id)
        || !valid_identifier(&tombstone.durable_receipt_id)
        || !valid_lower_sha256(&tombstone.event_hash)
    {
        return Err(JournalError);
    }
    Ok(tombstone)
}

fn sync_directory(path: &Path) -> Result<(), JournalError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| JournalError)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_ack_needs_matrix_event_and_bounded_receipt_id() {
        assert!(
            IngressAck {
                event_id: "$event:example".into(),
                durable_receipt_id: "mysql-42".into()
            }
            .is_valid()
        );
        assert!(
            !IngressAck {
                event_id: "not-event".into(),
                durable_receipt_id: "mysql-42".into()
            }
            .is_valid()
        );
        assert_ne!(
            receipt_id_for("$event:example", "OWNER-A"),
            receipt_id_for("$event:example", "OWNER-B")
        );
    }

    #[test]
    fn journal_replays_until_exact_ack_and_rejects_tampering() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        journal
            .persist(IngressEvent {
                event_id: "$event:example".into(),
                room_id: "!room:example".into(),
                sender_mxid: "@owner:example".into(),
                sender_device_id: "OWNERDEVICE".into(),
                body: Some("private".into()),
                reply_to_event_id: None,
                media: Vec::new(),
            })
            .unwrap();
        assert_eq!(journal.replay(64).unwrap().len(), 1);
        let file = journal
            .root
            .join(format!("{}.pending", event_key_for("$event:example")));
        let raw = fs::read(&file).unwrap();
        assert!(!raw.windows(b"private".len()).any(|part| part == b"private"));
        let first = journal
            .acknowledge(&IngressAck {
                event_id: "$event:example".into(),
                durable_receipt_id: "mysql-1".into(),
            })
            .unwrap();
        assert!(first.pending.is_some());
        assert!(journal.replay(64).unwrap().is_empty());
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut restored_pending = options.open(&file).unwrap();
        restored_pending.write_all(&raw).unwrap();
        restored_pending.sync_all().unwrap();
        let retry = journal
            .acknowledge(&IngressAck {
                event_id: "$event:example".into(),
                durable_receipt_id: "mysql-1".into(),
            })
            .unwrap();
        assert!(retry.pending.is_some());
        assert!(journal.replay(64).unwrap().is_empty());
        assert!(
            journal
                .acknowledge(&IngressAck {
                    event_id: "$event:example".into(),
                    durable_receipt_id: "mysql-1".into(),
                })
                .unwrap()
                .pending
                .is_none()
        );
        assert!(
            journal
                .acknowledge(&IngressAck {
                    event_id: "$event:example".into(),
                    durable_receipt_id: "mysql-conflict".into(),
                })
                .is_err()
        );
        assert!(
            journal
                .persist(IngressEvent {
                    event_id: "$event:example".into(),
                    room_id: "!room:example".into(),
                    sender_mxid: "@owner:example".into(),
                    sender_device_id: "OWNERDEVICE".into(),
                    body: Some("already durable".into()),
                    reply_to_event_id: None,
                    media: Vec::new(),
                })
                .is_err()
        );
        assert!(
            journal
                .persist(IngressEvent {
                    event_id: "$event:example".into(),
                    room_id: "!room:example".into(),
                    sender_mxid: "@owner:example".into(),
                    sender_device_id: "OWNERDEVICE".into(),
                    body: Some("private".into()),
                    reply_to_event_id: None,
                    media: Vec::new(),
                })
                .unwrap()
                .is_none()
        );
        fs::write(file, b"tampered").unwrap();
        assert!(journal.replay(64).is_err());
    }

    #[test]
    fn journal_rejects_more_than_the_unacked_bound() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        for index in 0..MAX_UNACKED_EVENTS {
            journal
                .persist(IngressEvent {
                    event_id: format!("$event-{index}:example"),
                    room_id: "!room:example".into(),
                    sender_mxid: "@owner:example".into(),
                    sender_device_id: "OWNERDEVICE".into(),
                    body: Some("bounded".into()),
                    reply_to_event_id: None,
                    media: Vec::new(),
                })
                .unwrap();
        }
        assert!(
            journal
                .persist(IngressEvent {
                    event_id: "$overflow:example".into(),
                    room_id: "!room:example".into(),
                    sender_mxid: "@owner:example".into(),
                    sender_device_id: "OWNERDEVICE".into(),
                    body: Some("blocked".into()),
                    reply_to_event_id: None,
                    media: Vec::new(),
                })
                .is_err()
        );
    }

    #[test]
    fn journal_io_loss_fails_before_claiming_a_replayable_event() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        fs::remove_dir(&journal.root).unwrap();
        assert!(
            journal
                .persist(IngressEvent {
                    event_id: "$journal-io:example".into(),
                    room_id: "!room:example".into(),
                    sender_mxid: "@owner:example".into(),
                    sender_device_id: "OWNERDEVICE".into(),
                    body: Some("must not be acknowledged".into()),
                    reply_to_event_id: None,
                    media: Vec::new(),
                })
                .is_err()
        );
    }

    #[test]
    fn expired_ack_tombstones_are_pruned_without_touching_pending_events() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        let event_id = "$expired:example";
        let tombstone_path = journal
            .ack_root
            .join(format!("{}.ack", event_key_for(event_id)));
        write_tombstone_once(
            &tombstone_path,
            &AckTombstone {
                receipt_id: receipt_id_for(event_id, "OWNERDEVICE"),
                event_id: event_id.into(),
                event_hash: "a".repeat(64),
                durable_receipt_id: "mysql-expired".into(),
                acknowledged_at_ms: 0,
            },
        )
        .unwrap();
        OpenOptions::new()
            .write(true)
            .open(&tombstone_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH))
            .unwrap();

        let _guard = journal.mutation.lock().unwrap();
        journal
            .prune_tombstones_locked(UNIX_EPOCH + ACK_TOMBSTONE_TTL + Duration::from_secs(1), 1)
            .unwrap();
        drop(_guard);
        assert!(!tombstone_path.exists());
        assert!(journal.replay(MAX_UNACKED_EVENTS).unwrap().is_empty());
    }

    #[test]
    fn expiry_hashes_match_node_json_contract() {
        let pending = PendingIngress {
            sequence: 1,
            receipt_id: receipt_id_for("$outage:example", "OWNERDEVICE"),
            event: IngressEvent {
                event_id: "$outage:example".into(),
                room_id: "!room:example".into(),
                sender_mxid: "@owner:example".into(),
                sender_device_id: "OWNERDEVICE".into(),
                body: Some("caption".into()),
                reply_to_event_id: None,
                media: vec![MediaReference {
                    handle: format!("{}-{}.pdf", "1".repeat(32), "2".repeat(24)),
                    declared_mime: "application/pdf".into(),
                    length: 14,
                    sha256: "a".repeat(64),
                }],
            },
        };
        let rejection = PendingRejection::from_pending(&pending).unwrap();
        assert_eq!(
            rejection.body_hash,
            "6908edf5239945f250b4f561dd873f439c771c31009c00d87eee59d6143e9e09"
        );
        assert_eq!(
            rejection.media_manifest_hash,
            "6a5c569a9499bd1f5c349b1042182c7ff17ae3198f1c56653191f24886a6db51"
        );
        assert_eq!(
            rejection.event_hash,
            "2e5c6e527c61aa6e165ed2c692ef7c8f05c1428790ac631b35da55c7c7737bbd"
        );
    }

    #[test]
    fn outage_past_ttl_restarts_as_rejection_and_ack_closes_crash_window() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        let event_id = "$expired-media:example";
        journal
            .persist(IngressEvent {
                event_id: event_id.into(),
                room_id: "!room:example".into(),
                sender_mxid: "@owner:example".into(),
                sender_device_id: "OWNERDEVICE".into(),
                body: None,
                reply_to_event_id: None,
                media: vec![MediaReference {
                    handle: format!("{}-{}.pdf", "1".repeat(32), "2".repeat(24)),
                    declared_mime: "application/pdf".into(),
                    length: 8,
                    sha256: "a".repeat(64),
                }],
            })
            .unwrap();
        let pending_path = journal
            .root
            .join(format!("{}.pending", event_key_for(event_id)));
        let pending_bytes = fs::read(&pending_path).unwrap();
        OpenOptions::new()
            .write(true)
            .open(&pending_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH))
            .unwrap();
        drop(journal);

        let restarted = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        let expired = restarted.expire_media(ACK_TOMBSTONE_TTL).unwrap();
        assert_eq!(expired.len(), 1);
        let rejection = expired[0].rejection.clone();
        assert!(restarted.replay(MAX_UNACKED_EVENTS).unwrap().is_empty());
        assert_eq!(
            restarted
                .replay_rejections(MAX_UNACKED_EVENTS)
                .unwrap()
                .len(),
            1
        );

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&pending_path)
            .unwrap()
            .write_all(&pending_bytes)
            .unwrap();
        assert!(restarted.replay(MAX_UNACKED_EVENTS).unwrap().is_empty());
        let recovered = restarted.expire_media(Duration::ZERO).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].rejection.event_hash, rejection.event_hash);
        assert!(!pending_path.exists());

        restarted
            .acknowledge(&IngressAck {
                event_id: event_id.into(),
                durable_receipt_id: rejection.event_hash,
            })
            .unwrap();
        assert!(
            restarted
                .replay_rejections(MAX_UNACKED_EVENTS)
                .unwrap()
                .is_empty()
        );
        assert!(
            restarted
                .acknowledge(&IngressAck {
                    event_id: event_id.into(),
                    durable_receipt_id: "different-receipt".into(),
                })
                .is_err()
        );
    }

    #[test]
    fn duplicate_event_requires_identical_content_and_preserves_original_media() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        let event = |body: &str, handle: &str| IngressEvent {
            event_id: "$duplicate:example".into(),
            room_id: "!room:example".into(),
            sender_mxid: "@owner:example".into(),
            sender_device_id: "OWNERDEVICE".into(),
            body: Some(body.into()),
            reply_to_event_id: None,
            media: vec![MediaReference {
                handle: handle.into(),
                declared_mime: "application/pdf".into(),
                length: 10,
                sha256: "b".repeat(64),
            }],
        };
        let first_handle = format!("{}-{}.pdf", "1".repeat(32), "2".repeat(24));
        let second_handle = format!("{}-{}.pdf", "3".repeat(32), "4".repeat(24));
        assert!(matches!(
            journal.persist(event("same", &first_handle)).unwrap(),
            PersistOutcome::Created(_)
        ));
        let duplicate = journal.persist(event("same", &second_handle)).unwrap();
        assert!(duplicate.requires_incoming_media_cleanup());
        let stored = duplicate.into_pending().unwrap();
        assert_eq!(stored.event.media[0].handle, first_handle);
        assert_ne!(stored.event.media[0].handle, second_handle);
        assert!(journal.persist(event("changed", &second_handle)).is_err());
    }

    #[test]
    fn restart_replay_merges_pending_and_rejection_in_durable_sequence() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        for (index, media) in [false, true, false].into_iter().enumerate() {
            journal
                .persist(IngressEvent {
                    event_id: format!("$ordered-{index}:example"),
                    room_id: "!room:example".into(),
                    sender_mxid: "@owner:example".into(),
                    sender_device_id: "OWNERDEVICE".into(),
                    body: Some(format!("event-{index}")),
                    reply_to_event_id: None,
                    media: media
                        .then(|| MediaReference {
                            handle: format!("{}-{}.pdf", "1".repeat(32), "2".repeat(24)),
                            declared_mime: "application/pdf".into(),
                            length: 10,
                            sha256: "b".repeat(64),
                        })
                        .into_iter()
                        .collect(),
                })
                .unwrap();
        }
        let middle = journal
            .root
            .join(format!("{}.pending", event_key_for("$ordered-1:example")));
        OpenOptions::new()
            .write(true)
            .open(&middle)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH))
            .unwrap();
        journal.expire_media(Duration::ZERO).unwrap();
        drop(journal);

        let restarted = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        let replay = restarted.replay_ordered(MAX_UNACKED_EVENTS).unwrap();
        assert_eq!(
            replay
                .iter()
                .map(OrderedReplay::sequence)
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert!(matches!(replay[0], OrderedReplay::Ingress(_)));
        assert!(matches!(replay[1], OrderedReplay::Rejected(_)));
        assert!(matches!(replay[2], OrderedReplay::Ingress(_)));
    }

    #[test]
    fn duplicate_or_corrupt_durable_sequence_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        journal
            .persist(IngressEvent {
                event_id: "$first:example".into(),
                room_id: "!room:example".into(),
                sender_mxid: "@owner:example".into(),
                sender_device_id: "OWNERDEVICE".into(),
                body: Some("first".into()),
                reply_to_event_id: None,
                media: Vec::new(),
            })
            .unwrap();
        let second_event = IngressEvent {
            event_id: "$second:example".into(),
            room_id: "!room:example".into(),
            sender_mxid: "@owner:example".into(),
            sender_device_id: "OWNERDEVICE".into(),
            body: Some("second".into()),
            reply_to_event_id: None,
            media: Vec::new(),
        };
        let duplicate_sequence = PendingIngress {
            sequence: 1,
            receipt_id: receipt_id_for(&second_event.event_id, &second_event.sender_device_id),
            event: second_event,
        };
        let second_path = journal
            .root
            .join(format!("{}.pending", event_key_for("$second:example")));
        journal
            .write_encrypted_once(&second_path, &duplicate_sequence, MAX_FRAME_BYTES)
            .unwrap();
        assert!(journal.replay_ordered(MAX_UNACKED_EVENTS).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn journal_open_cleans_only_known_private_atomic_orphans() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let journal = PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        let root = journal.root.clone();
        drop(journal);
        let orphan = root.join(format!(
            ".atomic-event-{}.pending-{}.tmp",
            "a".repeat(32),
            "b".repeat(32)
        ));
        fs::write(&orphan, b"torn").unwrap();
        fs::set_permissions(&orphan, fs::Permissions::from_mode(0o600)).unwrap();
        PendingJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        assert!(!orphan.exists());

        let unknown = root.join(format!(".atomic-unrelated-{}.tmp", "c".repeat(32)));
        fs::write(&unknown, b"private").unwrap();
        fs::set_permissions(&unknown, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(PendingJournal::open(temp.path(), &"a".repeat(64)).is_err());
        assert!(unknown.exists());
    }
}
