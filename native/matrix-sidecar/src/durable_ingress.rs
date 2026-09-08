//! Fenced durable ingress with the legacy journal preserved as an explicit backend.
//! SQL rows contain encrypted event/rejection/ACK state; no durable local file is used.
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use personal_consultant_matrix_mysql_store::{Backend, InboxMutation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    config::{MAX_FRAME_BYTES, MAX_UNACKED_EVENTS},
    ingress::{
        AckOutcome, ExpiredIngress, IngressAck, IngressEvent, JournalError as LegacyJournalError,
        OrderedReplay, PendingIngress, PendingJournal, PendingRejection, PersistOutcome,
        ingress_hashes, invalid_media_rejection, receipt_id_for, valid_lower_sha256,
        valid_matrix_event_id,
    },
    protocol::valid_identifier,
};

/// Errors retain only safe classification; SQL source details never cross IPC.
#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("Matrix ingress journal invalid")]
    Invalid,
    #[error("Matrix ingress database operation failed")]
    Database(personal_consultant_matrix_mysql_store::StoreError),
}
impl From<LegacyJournalError> for JournalError {
    fn from(_: LegacyJournalError) -> Self {
        Self::Invalid
    }
}

const MAX_ACKS: usize = 4_096;
const ACK_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone)]
pub enum DurableJournal {
    Legacy(PendingJournal),
    MySql(Arc<Backend>),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Entry {
    Pending {
        pending: PendingIngress,
        created_at_ms: u64,
    },
    Rejected {
        rejection: PendingRejection,
    },
    Ack {
        receipt_id: String,
        event_id: String,
        event_hash: String,
        durable_receipt_id: String,
        acknowledged_at_ms: u64,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LegacyJournalImportReceipt {
    pub pending: usize,
    pub rejected: usize,
    pub acknowledged: usize,
    pub source_fingerprint: String,
    pub already_imported: bool,
}

impl Entry {
    fn status(&self) -> &'static str {
        match self {
            Self::Pending { .. } => "pending",
            Self::Rejected { .. } => "rejected",
            Self::Ack { .. } => "ack",
        }
    }
    fn event_id(&self) -> &str {
        match self {
            Self::Pending { pending, .. } => &pending.event.event_id,
            Self::Rejected { rejection } => &rejection.event_id,
            Self::Ack { event_id, .. } => event_id,
        }
    }
    fn sequence(&self) -> Option<u64> {
        match self {
            Self::Pending { pending, .. } => Some(pending.sequence),
            Self::Rejected { rejection } => Some(rejection.sequence),
            Self::Ack { .. } => None,
        }
    }
    fn validate(&self) -> bool {
        match self {
            Self::Pending {
                pending,
                created_at_ms,
            } => {
                *created_at_ms > 0
                    && pending.sequence > 0
                    && pending.event.is_valid()
                    && serde_json::to_vec(pending).is_ok_and(|value| value.len() <= MAX_FRAME_BYTES)
                    && pending.receipt_id
                        == receipt_id_for(&pending.event.event_id, &pending.event.sender_device_id)
            }
            Self::Rejected { rejection } => rejection.is_valid(),
            Self::Ack {
                receipt_id,
                event_id,
                event_hash,
                durable_receipt_id,
                acknowledged_at_ms,
            } => {
                valid_identifier(receipt_id)
                    && valid_matrix_event_id(event_id)
                    && valid_lower_sha256(event_hash)
                    && valid_identifier(durable_receipt_id)
                    && *acknowledged_at_ms > 0
            }
        }
    }
    fn mutation(&self) -> Result<InboxMutation, JournalError> {
        if !self.validate() {
            return Err(JournalError::Invalid);
        }
        let value = serde_json::to_vec(self).map_err(|_| JournalError::Invalid)?;
        let maximum = if matches!(self, Self::Pending { .. }) {
            MAX_FRAME_BYTES + 1024
        } else {
            4096
        };
        if value.len() > maximum {
            return Err(JournalError::Invalid);
        }
        Ok(InboxMutation::Put {
            key: self.event_id().as_bytes().to_vec(),
            status: self.status().into(),
            value,
        })
    }
}

fn now_ms() -> Result<u64, JournalError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .filter(|value| *value > 0)
        .ok_or(JournalError::Invalid)
}

async fn snapshot(backend: &Backend) -> Result<Vec<Entry>, JournalError> {
    let rows = backend.inbox_scan().await.map_err(JournalError::Database)?;
    if rows.len() > MAX_UNACKED_EVENTS + MAX_ACKS {
        return Err(JournalError::Invalid);
    }
    let mut entries = Vec::with_capacity(rows.len());
    let mut sequences = HashSet::new();
    let mut events = HashSet::new();
    let mut unacked = 0;
    let mut acks = 0;
    for row in rows {
        if row.value.len() > MAX_FRAME_BYTES + 1024 {
            return Err(JournalError::Invalid);
        }
        let entry: Entry = serde_json::from_slice(&row.value).map_err(|_| JournalError::Invalid)?;
        if !entry.validate()
            || entry.status() != row.status
            || entry.event_id().as_bytes() != row.key
            || !events.insert(entry.event_id().to_owned())
        {
            return Err(JournalError::Invalid);
        }
        if let Some(sequence) = entry.sequence() {
            unacked += 1;
            if !sequences.insert(sequence) {
                return Err(JournalError::Invalid);
            }
        } else {
            acks += 1;
        }
        if unacked > MAX_UNACKED_EVENTS || acks > MAX_ACKS {
            return Err(JournalError::Invalid);
        }
        entries.push(entry);
    }
    Ok(entries)
}

fn next_sequence(entries: &[Entry]) -> Result<u64, JournalError> {
    if entries
        .iter()
        .filter(|entry| entry.sequence().is_some())
        .count()
        >= MAX_UNACKED_EVENTS
    {
        return Err(JournalError::Invalid);
    }
    entries
        .iter()
        .filter_map(Entry::sequence)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(JournalError::Invalid)
}

fn prune(entries: &[Entry], now: u64, maximum: usize) -> Vec<InboxMutation> {
    let mut acks = entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Ack {
                event_id,
                acknowledged_at_ms,
                ..
            } => Some((event_id, *acknowledged_at_ms)),
            _ => None,
        })
        .collect::<Vec<_>>();
    acks.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
    let excess = acks.len().saturating_sub(maximum);
    acks.into_iter()
        .enumerate()
        .filter(|(index, (_, time))| *index < excess || now.saturating_sub(*time) >= ACK_TTL_MS)
        .map(|(_, (event_id, _))| InboxMutation::Delete {
            key: event_id.as_bytes().to_vec(),
        })
        .collect()
}

impl DurableJournal {
    pub fn open(root: &Path, passphrase: &str) -> Result<Self, JournalError> {
        PendingJournal::open(root, passphrase)
            .map(Self::Legacy)
            .map_err(Into::into)
    }
    /// Backend must already be provisioned and bound; this never creates state.
    pub fn from_mysql(backend: Arc<Backend>) -> Self {
        Self::MySql(backend)
    }

    /// Explicit candidate import. Legacy state must be a consistent stopped,
    /// read-only backup. Existing different SQL rows are never overwritten.
    /// A retry after an unknown commit succeeds only on exact snapshot equality.
    pub async fn import_legacy_read_only(
        backend: Arc<Backend>,
        root: &Path,
        passphrase: &str,
    ) -> Result<LegacyJournalImportReceipt, JournalError> {
        let legacy = PendingJournal::export_read_only(root, passphrase)?;
        let mut imported = BTreeMap::<String, Entry>::new();
        for (pending, created_at_ms) in legacy.pending {
            let id = pending.event.event_id.clone();
            if imported
                .insert(
                    id,
                    Entry::Pending {
                        pending,
                        created_at_ms,
                    },
                )
                .is_some()
            {
                return Err(JournalError::Invalid);
            }
        }
        for rejection in legacy.rejected {
            if let Some(entry) = imported.get(&rejection.event_id) {
                match entry {
                    Entry::Pending { pending, .. }
                        if rejection.matches(&PendingRejection::from_pending(pending)?) => {}
                    _ => return Err(JournalError::Invalid),
                }
            }
            imported.insert(rejection.event_id.clone(), Entry::Rejected { rejection });
        }
        for ack in legacy.acknowledged {
            if let Some(entry) = imported.get(&ack.event_id) {
                let matches = match entry {
                    Entry::Pending { pending, .. } => {
                        pending.receipt_id == ack.receipt_id
                            && ingress_hashes(&pending.event)?.event == ack.event_hash
                    }
                    Entry::Rejected { rejection } => {
                        rejection.receipt_id == ack.receipt_id
                            && rejection.event_hash == ack.event_hash
                    }
                    Entry::Ack { .. } => false,
                };
                if !matches {
                    return Err(JournalError::Invalid);
                }
            }
            imported.insert(
                ack.event_id.clone(),
                Entry::Ack {
                    receipt_id: ack.receipt_id,
                    event_id: ack.event_id,
                    event_hash: ack.event_hash,
                    durable_receipt_id: ack.durable_receipt_id,
                    acknowledged_at_ms: ack.acknowledged_at_ms,
                },
            );
        }
        let entries = imported.values().collect::<Vec<_>>();
        let mut sequence = HashSet::new();
        let pending = entries
            .iter()
            .filter(|entry| matches!(entry, Entry::Pending { .. }))
            .count();
        let rejected = entries
            .iter()
            .filter(|entry| matches!(entry, Entry::Rejected { .. }))
            .count();
        let acknowledged = entries.len() - pending - rejected;
        if pending + rejected > MAX_UNACKED_EVENTS || acknowledged > MAX_ACKS {
            return Err(JournalError::Invalid);
        }
        for entry in &entries {
            if !entry.validate()
                || entry
                    .sequence()
                    .is_some_and(|value| !sequence.insert(value))
            {
                return Err(JournalError::Invalid);
            }
        }
        let encoded = serde_json::to_vec(&imported).map_err(|_| JournalError::Invalid)?;
        let source_fingerprint = hex::encode(Sha256::digest(&encoded));
        let mutations = entries
            .iter()
            .map(|entry| entry.mutation())
            .collect::<Result<Vec<_>, _>>()?;
        let _guard = backend.mutation_lock.lock().await;
        let existing = snapshot(&backend).await?;
        let already_imported = !existing.is_empty();
        if already_imported {
            let existing = existing
                .into_iter()
                .map(|entry| (entry.event_id().to_owned(), entry))
                .collect::<BTreeMap<_, _>>();
            if serde_json::to_vec(&existing).map_err(|_| JournalError::Invalid)? != encoded {
                return Err(JournalError::Invalid);
            }
        } else if !mutations.is_empty() {
            backend
                .inbox_write(mutations)
                .await
                .map_err(JournalError::Database)?;
            let restored = snapshot(&backend)
                .await?
                .into_iter()
                .map(|entry| (entry.event_id().to_owned(), entry))
                .collect::<BTreeMap<_, _>>();
            if serde_json::to_vec(&restored).map_err(|_| JournalError::Invalid)? != encoded {
                return Err(JournalError::Invalid);
            }
        }
        Ok(LegacyJournalImportReceipt {
            pending,
            rejected,
            acknowledged,
            source_fingerprint,
            already_imported,
        })
    }

    pub async fn persist(&self, event: IngressEvent) -> Result<PersistOutcome, JournalError> {
        let Self::MySql(backend) = self else {
            let Self::Legacy(journal) = self else {
                unreachable!()
            };
            return journal.persist(event).map_err(Into::into);
        };
        if !event.is_valid() {
            return Err(JournalError::Invalid);
        }
        let _guard = backend.mutation_lock.lock().await;
        let entries = snapshot(backend).await?;
        let receipt = receipt_id_for(&event.event_id, &event.sender_device_id);
        let hash = ingress_hashes(&event)?.event;
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.event_id() == event.event_id)
        {
            return match entry {
                Entry::Pending { pending, .. }
                    if pending.receipt_id == receipt
                        && ingress_hashes(&pending.event)?.event == hash =>
                {
                    Ok(PersistOutcome::Existing(pending.clone()))
                }
                Entry::Rejected { rejection } => {
                    let candidate = PendingIngress {
                        sequence: rejection.sequence,
                        receipt_id: receipt,
                        event,
                    };
                    if rejection.matches(&PendingRejection::from_pending(&candidate)?) {
                        Ok(PersistOutcome::Finalized)
                    } else {
                        Err(JournalError::Invalid)
                    }
                }
                Entry::Ack {
                    receipt_id,
                    event_hash,
                    ..
                } if receipt_id == &receipt && event_hash == &hash => Ok(PersistOutcome::Finalized),
                _ => Err(JournalError::Invalid),
            };
        }
        let pending = PendingIngress {
            sequence: next_sequence(&entries)?,
            receipt_id: receipt,
            event,
        };
        let now = now_ms()?;
        let mut mutations = prune(&entries, now, MAX_ACKS);
        mutations.push(
            Entry::Pending {
                pending: pending.clone(),
                created_at_ms: now,
            }
            .mutation()?,
        );
        backend
            .inbox_write(mutations)
            .await
            .map_err(JournalError::Database)?;
        Ok(PersistOutcome::Created(pending))
    }

    pub async fn reject_invalid_media(
        &self,
        event: &IngressEvent,
        descriptor: &serde_json::Value,
    ) -> Result<Option<PendingRejection>, JournalError> {
        let Self::MySql(backend) = self else {
            let Self::Legacy(journal) = self else {
                unreachable!()
            };
            return journal
                .reject_invalid_media(event, descriptor)
                .map_err(Into::into);
        };
        let _guard = backend.mutation_lock.lock().await;
        let entries = snapshot(backend).await?;
        let mut rejection = invalid_media_rejection(event, descriptor)?;
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.event_id() == event.event_id)
        {
            return match entry {
                Entry::Ack {
                    receipt_id,
                    event_hash,
                    ..
                } if receipt_id == &rejection.receipt_id && event_hash == &rejection.event_hash => {
                    Ok(None)
                }
                Entry::Rejected {
                    rejection: existing,
                } => {
                    rejection.sequence = existing.sequence;
                    if existing.matches(&rejection) {
                        Ok(Some(existing.clone()))
                    } else {
                        Err(JournalError::Invalid)
                    }
                }
                _ => Err(JournalError::Invalid),
            };
        }
        rejection.sequence = next_sequence(&entries)?;
        let mut mutations = prune(&entries, now_ms()?, MAX_ACKS);
        mutations.push(
            Entry::Rejected {
                rejection: rejection.clone(),
            }
            .mutation()?,
        );
        backend
            .inbox_write(mutations)
            .await
            .map_err(JournalError::Database)?;
        Ok(Some(rejection))
    }

    pub async fn replay_ordered(&self, maximum: usize) -> Result<Vec<OrderedReplay>, JournalError> {
        match self {
            Self::Legacy(journal) => journal.replay_ordered(maximum).map_err(Into::into),
            Self::MySql(backend) => {
                let _guard = backend.mutation_lock.lock().await;
                let mut entries = snapshot(backend)
                    .await?
                    .into_iter()
                    .filter_map(|entry| match entry {
                        Entry::Pending { pending, .. } => Some(OrderedReplay::Ingress(pending)),
                        Entry::Rejected { rejection } => Some(OrderedReplay::Rejected(rejection)),
                        Entry::Ack { .. } => None,
                    })
                    .collect::<Vec<_>>();
                if entries.len() > maximum {
                    return Err(JournalError::Invalid);
                }
                entries.sort_by_key(OrderedReplay::sequence);
                Ok(entries)
            }
        }
    }
    pub async fn replay(&self, maximum: usize) -> Result<Vec<PendingIngress>, JournalError> {
        Ok(self
            .replay_ordered(maximum)
            .await?
            .into_iter()
            .filter_map(|entry| match entry {
                OrderedReplay::Ingress(pending) => Some(pending),
                _ => None,
            })
            .collect())
    }
    pub async fn replay_rejections(
        &self,
        maximum: usize,
    ) -> Result<Vec<PendingRejection>, JournalError> {
        Ok(self
            .replay_ordered(maximum)
            .await?
            .into_iter()
            .filter_map(|entry| match entry {
                OrderedReplay::Rejected(rejection) => Some(rejection),
                _ => None,
            })
            .collect())
    }
    pub async fn unacked_count(&self) -> Result<usize, JournalError> {
        Ok(self.replay_ordered(MAX_UNACKED_EVENTS).await?.len())
    }
    pub async fn active_media_handles(&self) -> Result<HashSet<String>, JournalError> {
        Ok(self
            .replay(MAX_UNACKED_EVENTS)
            .await?
            .into_iter()
            .flat_map(|pending| pending.event.media.into_iter().map(|media| media.handle))
            .collect())
    }
    pub async fn expire_media(&self, ttl: Duration) -> Result<Vec<ExpiredIngress>, JournalError> {
        let Self::MySql(backend) = self else {
            let Self::Legacy(journal) = self else {
                unreachable!()
            };
            return journal.expire_media(ttl).map_err(Into::into);
        };
        let _guard = backend.mutation_lock.lock().await;
        let entries = snapshot(backend).await?;
        let now = now_ms()?;
        let ttl = u64::try_from(ttl.as_millis()).map_err(|_| JournalError::Invalid)?;
        let mut mutations = Vec::new();
        let mut expired = Vec::new();
        for entry in entries {
            if let Entry::Pending {
                pending,
                created_at_ms,
            } = entry
            {
                if pending.event.media.is_empty()
                    || now < created_at_ms
                    || now - created_at_ms < ttl
                {
                    continue;
                }
                let rejection = PendingRejection::from_pending(&pending)?;
                mutations.push(
                    Entry::Rejected {
                        rejection: rejection.clone(),
                    }
                    .mutation()?,
                );
                expired.push(ExpiredIngress {
                    rejection,
                    media: pending.event.media,
                });
            }
        }
        if !mutations.is_empty() {
            backend
                .inbox_write(mutations)
                .await
                .map_err(JournalError::Database)?;
        }
        Ok(expired)
    }
    pub async fn acknowledge(&self, ack: &IngressAck) -> Result<AckOutcome, JournalError> {
        let Self::MySql(backend) = self else {
            let Self::Legacy(journal) = self else {
                unreachable!()
            };
            return journal.acknowledge(ack).map_err(Into::into);
        };
        if !ack.is_valid() {
            return Err(JournalError::Invalid);
        }
        let _guard = backend.mutation_lock.lock().await;
        let entries = snapshot(backend).await?;
        let entry = entries
            .iter()
            .find(|entry| entry.event_id() == ack.event_id)
            .ok_or(JournalError::Invalid)?;
        let (receipt_id, event_hash, pending) = match entry {
            Entry::Pending { pending, .. } => (
                pending.receipt_id.clone(),
                ingress_hashes(&pending.event)?.event,
                Some(pending.clone()),
            ),
            Entry::Rejected { rejection } => (
                rejection.receipt_id.clone(),
                rejection.event_hash.clone(),
                None,
            ),
            Entry::Ack {
                durable_receipt_id, ..
            } => {
                return if durable_receipt_id == &ack.durable_receipt_id {
                    Ok(AckOutcome { pending: None })
                } else {
                    Err(JournalError::Invalid)
                };
            }
        };
        let now = now_ms()?;
        let mut mutations = prune(&entries, now, MAX_ACKS - 1);
        mutations.push(
            Entry::Ack {
                receipt_id,
                event_id: ack.event_id.clone(),
                event_hash,
                durable_receipt_id: ack.durable_receipt_id.clone(),
                acknowledged_at_ms: now,
            }
            .mutation()?,
        );
        backend
            .inbox_write(mutations)
            .await
            .map_err(JournalError::Database)?;
        Ok(AckOutcome { pending })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event() -> IngressEvent {
        IngressEvent {
            event_id: "$fixture:example".into(),
            room_id: "!room:example".into(),
            sender_mxid: "@owner:example".into(),
            sender_device_id: "OWNER".into(),
            body: Some("Українська 🦆".into()),
            reply_to_event_id: None,
            media: Vec::new(),
        }
    }
    #[tokio::test]
    async fn legacy_wrapper_preserves_exact_ack_and_conflict_rules() {
        let temp = tempfile::tempdir().unwrap();
        let journal = DurableJournal::open(temp.path(), &"a".repeat(64)).unwrap();
        assert!(matches!(
            journal.persist(event()).await.unwrap(),
            PersistOutcome::Created(_)
        ));
        assert!(matches!(
            journal.persist(event()).await.unwrap(),
            PersistOutcome::Existing(_)
        ));
        let mut conflict = event();
        conflict.body = Some("different".into());
        assert!(journal.persist(conflict).await.is_err());
        assert_eq!(journal.unacked_count().await.unwrap(), 1);
        let ack = IngressAck {
            event_id: event().event_id,
            durable_receipt_id: "mysql-fixture".into(),
        };
        assert!(journal.acknowledge(&ack).await.unwrap().pending.is_some());
        assert!(matches!(
            journal.persist(event()).await.unwrap(),
            PersistOutcome::Finalized
        ));
        assert_eq!(journal.unacked_count().await.unwrap(), 0);
    }
    #[test]
    fn malformed_entries_reject_zero_sequence_and_conflicting_receipt() {
        let pending = PendingIngress {
            sequence: 0,
            receipt_id: receipt_id_for(&event().event_id, "OWNER"),
            event: event(),
        };
        assert!(
            !Entry::Pending {
                pending,
                created_at_ms: 1
            }
            .validate()
        );
    }

    async fn mysql_fixture() -> (Arc<Backend>, DurableJournal) {
        use personal_consultant_matrix_mysql_store::DatabaseConfig;
        let path = std::env::var("MATRIX_MYSQL_TEST_CONFIG").expect("Use isolated MySQL harness");
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let config = DatabaseConfig::from_env().unwrap();
        assert!(
            fixture["marker"] == "personal-consultant-synthetic-mysql-v1"
                && config.host == "127.0.0.1"
                && config.database.starts_with("pc_matrix_test_")
                && fixture["database"] == config.database
                && fixture["port"].as_u64() == Some(u64::from(config.port))
        );
        // The synthetic fixture explicitly installs DDL; the journal never does.
        let pool = config.connect().await.unwrap();
        Backend::provision_schema(&pool).await.unwrap();
        let id = *uuid::Uuid::new_v4().as_bytes();
        Backend::provision(&pool, id, b"synthetic-journal", &[7; 32])
            .await
            .unwrap();
        let backend = Arc::new(
            Backend::open(pool, id, b"synthetic-journal", &[7; 32], 120_000)
                .await
                .unwrap(),
        );
        let journal = DurableJournal::from_mysql(Arc::clone(&backend));
        (backend, journal)
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn mysql_journal_replays_unicode_until_exact_ack_after_reopen() {
        let (backend, journal) = mysql_fixture().await;
        let original = event();
        let pending = journal
            .persist(original.clone())
            .await
            .unwrap()
            .into_pending()
            .unwrap();
        assert!(matches!(
            journal.persist(original.clone()).await.unwrap(),
            PersistOutcome::Existing(_)
        ));
        let mut conflict = original.clone();
        conflict.body = Some("conflict".into());
        assert!(journal.persist(conflict).await.is_err());
        backend.close().await.unwrap();
        backend.reopen().await.unwrap();
        let replay = journal.replay_ordered(64).await.unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].receipt_id(), pending.receipt_id);
        let ack = IngressAck {
            event_id: original.event_id.clone(),
            durable_receipt_id: "node-commit-fixture".into(),
        };
        assert!(journal.acknowledge(&ack).await.unwrap().pending.is_some());
        assert!(journal.acknowledge(&ack).await.unwrap().pending.is_none());
        let wrong = IngressAck {
            event_id: original.event_id.clone(),
            durable_receipt_id: "wrong-commit".into(),
        };
        assert!(journal.acknowledge(&wrong).await.is_err());
        backend.close().await.unwrap();
        backend.reopen().await.unwrap();
        assert!(matches!(
            journal.persist(original).await.unwrap(),
            PersistOutcome::Finalized
        ));
        assert_eq!(journal.unacked_count().await.unwrap(), 0);
        let rows = backend.inbox_scan().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "ack");
        backend.close().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn mysql_invalid_media_rejection_is_ordered_idempotent_and_hash_bound() {
        let (backend, journal) = mysql_fixture().await;
        let first = journal
            .persist(event())
            .await
            .unwrap()
            .into_pending()
            .unwrap();
        let mut rejected_event = event();
        rejected_event.event_id = "$rejected:example".into();
        let descriptor = serde_json::json!({"source": "invalid-synthetic"});
        let rejected = journal
            .reject_invalid_media(&rejected_event, &descriptor)
            .await
            .unwrap()
            .unwrap();
        assert!(rejected.sequence > first.sequence);
        assert_eq!(journal.unacked_count().await.unwrap(), 2);
        assert_eq!(journal.replay_rejections(64).await.unwrap().len(), 1);
        assert!(journal.replay_ordered(1).await.is_err());
        assert!(
            journal
                .reject_invalid_media(&rejected_event, &serde_json::json!({"source":"changed"}))
                .await
                .is_err()
        );
        journal
            .acknowledge(&IngressAck {
                event_id: rejected_event.event_id.clone(),
                durable_receipt_id: "rejection-commit".into(),
            })
            .await
            .unwrap();
        assert!(
            journal
                .reject_invalid_media(&rejected_event, &descriptor)
                .await
                .unwrap()
                .is_none()
        );
        backend.close().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn mysql_expiry_atomically_replaces_pending_media_with_rejection() {
        let (backend, journal) = mysql_fixture().await;
        let mut incoming = event();
        incoming.media = vec![crate::media_spool::MediaReference {
            handle: "synthetic-handle".into(),
            declared_mime: "image/png".into(),
            length: 3,
            sha256: "a".repeat(64),
        }];
        let pending = journal
            .persist(incoming.clone())
            .await
            .unwrap()
            .into_pending()
            .unwrap();
        assert!(
            journal
                .active_media_handles()
                .await
                .unwrap()
                .contains("synthetic-handle")
        );
        let expired = journal.expire_media(Duration::ZERO).await.unwrap();
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].rejection.sequence, pending.sequence);
        assert!(journal.active_media_handles().await.unwrap().is_empty());
        assert!(journal.replay(64).await.unwrap().is_empty());
        assert_eq!(journal.replay_rejections(64).await.unwrap().len(), 1);
        assert!(matches!(
            journal.persist(incoming).await.unwrap(),
            PersistOutcome::Finalized
        ));
        let rows = backend.inbox_scan().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "rejected");
        backend.close().await.unwrap();
    }

    #[test]
    fn read_only_legacy_export_rejects_unknown_files_without_cleaning_them() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let secret = "a".repeat(64);
        let journal = PendingJournal::open(root.path(), &secret).unwrap();
        journal.persist(event()).unwrap();
        let unknown = root.path().join("pending-ingress").join("unfinished.tmp");
        std::fs::write(&unknown, b"synthetic incomplete write").unwrap();
        assert!(PendingJournal::export_read_only(root.path(), &secret).is_err());
        assert_eq!(
            std::fs::read(&unknown).unwrap(),
            b"synthetic incomplete write"
        );
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn mysql_legacy_import_preserves_ack_timestamp_and_retries_without_overwrite() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let secret = "a".repeat(64);
        let legacy = PendingJournal::open(root.path(), &secret).unwrap();
        let mut acknowledged = event();
        acknowledged.event_id = "$acked:example".into();
        legacy.persist(acknowledged.clone()).unwrap();
        legacy
            .acknowledge(&IngressAck {
                event_id: acknowledged.event_id.clone(),
                durable_receipt_id: "legacy-node-commit".into(),
            })
            .unwrap();
        legacy.persist(event()).unwrap();
        let mut rejected = event();
        rejected.event_id = "$rejected:example".into();
        legacy
            .reject_invalid_media(&rejected, &serde_json::json!({"invalid":"fixture"}))
            .unwrap();
        let original = PendingJournal::export_read_only(root.path(), &secret).unwrap();
        let created_at = original.pending[0].1;
        let ack_time = original.acknowledged[0].acknowledged_at_ms;
        let (backend, journal) = mysql_fixture().await;
        let receipt =
            DurableJournal::import_legacy_read_only(Arc::clone(&backend), root.path(), &secret)
                .await
                .unwrap();
        assert_eq!(
            (receipt.pending, receipt.rejected, receipt.acknowledged),
            (1, 1, 1)
        );
        assert!(!receipt.already_imported);
        let imported = snapshot(&backend).await.unwrap();
        assert!(imported.iter().any(
            |entry| matches!(entry,Entry::Pending {created_at_ms,..} if *created_at_ms==created_at)
        ));
        assert!(imported.iter().any(|entry|matches!(entry,Entry::Ack {acknowledged_at_ms,..} if *acknowledged_at_ms==ack_time)));
        let retry =
            DurableJournal::import_legacy_read_only(Arc::clone(&backend), root.path(), &secret)
                .await
                .unwrap();
        assert!(retry.already_imported);
        assert_eq!(retry.source_fingerprint, receipt.source_fingerprint);
        assert!(matches!(
            journal.persist(acknowledged).await.unwrap(),
            PersistOutcome::Finalized
        ));
        // Changing source after a successful import must not overwrite SQL.
        let mut extra = event();
        extra.event_id = "$extra:example".into();
        legacy.persist(extra).unwrap();
        assert!(
            DurableJournal::import_legacy_read_only(Arc::clone(&backend), root.path(), &secret)
                .await
                .is_err()
        );
        assert_eq!(journal.unacked_count().await.unwrap(), 2);
        backend.close().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn closed_database_preserves_journal_and_media_error_classification() {
        let (backend, journal) = mysql_fixture().await;
        journal.persist(event()).await.unwrap();
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let spool = crate::media_spool::PrivateSpool::create(root.path()).unwrap();
        let reference = spool
            .write(
                crate::media_spool::MediaKind::Pdf,
                b"%PDF-synthetic reconnect fixture",
            )
            .unwrap();
        crate::durable_media::archive(&backend, &spool, std::slice::from_ref(&reference))
            .await
            .unwrap();
        backend.close().await.unwrap();
        assert!(matches!(
            journal.replay_ordered(64).await,
            Err(JournalError::Database(
                personal_consultant_matrix_mysql_store::StoreError::Closed
            ))
        ));
        assert!(matches!(
            crate::durable_media::restore(&backend, &spool, std::slice::from_ref(&reference)).await,
            Err(crate::durable_media::MediaError::Database(
                personal_consultant_matrix_mysql_store::StoreError::Closed
            ))
        ));
        backend.reopen().await.unwrap();
        assert_eq!(journal.replay_ordered(64).await.unwrap().len(), 1);
        crate::durable_media::verify(&backend, &reference)
            .await
            .unwrap();
        backend.close().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn mysql_journal_rejects_authenticated_but_inconsistent_status_payload() {
        let (backend, journal) = mysql_fixture().await;
        let incoming = event();
        let entry = Entry::Ack {
            receipt_id: receipt_id_for(&incoming.event_id, &incoming.sender_device_id),
            event_id: incoming.event_id.clone(),
            event_hash: ingress_hashes(&incoming).unwrap().event,
            durable_receipt_id: "synthetic-ack".into(),
            acknowledged_at_ms: now_ms().unwrap(),
        };
        // Deliberately inject a synthetic semantically inconsistent row through
        // the trusted backend API: encryption alone is not journal validation.
        backend
            .inbox_write(vec![InboxMutation::Put {
                key: incoming.event_id.as_bytes().to_vec(),
                status: "pending".into(),
                value: serde_json::to_vec(&entry).unwrap(),
            }])
            .await
            .unwrap();
        assert!(journal.replay_ordered(64).await.is_err());
        backend.close().await.unwrap();
    }
}
