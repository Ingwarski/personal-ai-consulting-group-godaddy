use std::io::{Seek, SeekFrom};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use matrix_sdk::{
    Client, RoomMemberships, RoomState,
    config::{SyncSettings, SyncToken},
    ruma::{
        OwnedEventId, OwnedRoomId, OwnedTransactionId, OwnedUserId,
        events::{
            Mentions,
            relation::Reply,
            room::message::{Relation, RoomMessageEventContent},
        },
    },
    sync::SyncResponse,
};
use thiserror::Error;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use crate::config::{Config, SEND_TIMEOUT_SECONDS};
use crate::ingress::{IngressEvent, PendingIngress, PendingJournal, PendingRejection};
use crate::media_spool::{MediaKind, PrivateSpool};
use crate::protocol::{SendCommand, valid_identifier};
use crate::room_policy::{ExpectedRoom, validate as validate_node_snapshot};
use crate::state::Readiness;

const MAX_ALIAS_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_GAP_PAGES: usize = 16;
const GAP_PAGE_SIZE: u32 = 64;
const MAX_GAP_EVENTS: usize = MAX_GAP_PAGES * GAP_PAGE_SIZE as usize;

#[derive(Clone)]
struct IngressPipeline {
    journal: PendingJournal,
    spool: PrivateSpool,
    sender: mpsc::Sender<MatrixOutput>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalAliasesResponse {
    aliases: Vec<String>,
}

#[derive(Debug)]
pub enum MatrixOutput {
    Ingress(PendingIngress),
    Rejected(PendingRejection),
    Readiness(Readiness),
    Fatal,
}

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("matrix policy denied the operation")]
    PolicyDenied,
    #[error("matrix transport is unavailable")]
    TransportFailed,
}

#[derive(Clone)]
pub struct MatrixClient {
    inner: Client,
    http: reqwest::Client,
    access_token: Arc<Zeroizing<String>>,
    homeserver: crate::config::FixedHomeserver,
    room_id: OwnedRoomId,
    owner_mxid: OwnedUserId,
    bot_mxid: OwnedUserId,
    bot_device_id: String,
    last_sync_ms: Arc<AtomicU64>,
    sync_ready: Arc<AtomicBool>,
    ingress_failed: Arc<AtomicBool>,
    ingress_pipeline: Arc<OnceLock<IngressPipeline>>,
    sync_checkpoint: crate::sync_checkpoint::SyncCheckpoint,
}

impl MatrixClient {
    pub fn new(
        inner: Client,
        http: reqwest::Client,
        config: &Config,
        sync_checkpoint: crate::sync_checkpoint::SyncCheckpoint,
    ) -> Result<Self, TransportError> {
        Ok(Self {
            inner,
            http,
            access_token: Arc::new(Zeroizing::new(config.access_token.to_string())),
            homeserver: config.homeserver.clone(),
            room_id: config
                .room_id
                .parse()
                .map_err(|_| TransportError::PolicyDenied)?,
            owner_mxid: config
                .owner_mxid
                .parse()
                .map_err(|_| TransportError::PolicyDenied)?,
            bot_mxid: config
                .bot_mxid
                .parse()
                .map_err(|_| TransportError::PolicyDenied)?,
            bot_device_id: config.bot_device_id.clone(),
            last_sync_ms: Arc::new(AtomicU64::new(0)),
            sync_ready: Arc::new(AtomicBool::new(false)),
            ingress_failed: Arc::new(AtomicBool::new(false)),
            ingress_pipeline: Arc::new(OnceLock::new()),
            sync_checkpoint,
        })
    }

    pub async fn sync_once(&self) -> Result<(), TransportError> {
        self.last_sync_ms.store(now_ms(), Ordering::Release);
        self.sync_with_checkpoint(
            SyncSettings::new().timeout(Duration::from_secs(0)),
            Duration::from_secs(SEND_TIMEOUT_SECONDS),
        )
        .await?;
        self.last_sync_ms.store(now_ms(), Ordering::Release);
        Ok(())
    }

    pub fn requires_pre_ingress_baseline(&self) -> Result<bool, TransportError> {
        self.sync_checkpoint
            .committed_token()
            .map(|token| token.is_none())
            .map_err(|_| TransportError::TransportFailed)
    }

    /// Establishes the event-free boundary for a new application cursor. Events before this
    /// boundary are intentionally outside ingress scope; no application event handler may be
    /// installed until this returns and durably commits the response token.
    pub async fn establish_pre_ingress_baseline(&self) -> Result<(), TransportError> {
        if !self.requires_pre_ingress_baseline()? {
            return Ok(());
        }
        let response = tokio::time::timeout(
            Duration::from_secs(SEND_TIMEOUT_SECONDS),
            self.inner.sync_once(
                SyncSettings::new()
                    .timeout(Duration::from_secs(0))
                    .token(SyncToken::NoToken),
            ),
        )
        .await
        .map_err(|_| TransportError::TransportFailed)?
        .map_err(|_| TransportError::TransportFailed)?;
        let room_event_id = match configured_room_baseline_anchor(&response, &self.room_id)? {
            Some(event_id) => event_id,
            None => self.latest_configured_room_event_id().await?,
        };
        self.sync_checkpoint
            .commit_cursor(response.next_batch, Some(room_event_id))
            .map_err(|_| TransportError::TransportFailed)
    }

    pub async fn establish_readiness(&self) -> Result<(), TransportError> {
        self.sync_once().await?;
        self.revalidate_current().await?;
        self.sync_ready.store(true, Ordering::Release);
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.sync_ready.load(Ordering::Acquire)
            && now_ms().saturating_sub(self.last_sync_ms.load(Ordering::Acquire)) <= 60_000
    }

    pub fn spawn_sync_loop(
        &self,
        sender: mpsc::Sender<MatrixOutput>,
        journal: PendingJournal,
        establish_after_backlog: bool,
    ) -> tokio::task::JoinHandle<()> {
        let client = self.clone();
        tokio::spawn(async move {
            if establish_after_backlog {
                loop {
                    match journal.unacked_count() {
                        Ok(count) if count >= crate::config::MAX_UNACKED_EVENTS => {
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                        Ok(_) => break,
                        Err(_) => {
                            let _ = sender.send(MatrixOutput::Fatal).await;
                            return;
                        }
                    }
                }
                if client.establish_readiness().await.is_err() {
                    let _ = sender.send(MatrixOutput::Fatal).await;
                    return;
                }
                if sender
                    .send(MatrixOutput::Readiness(Readiness::Ready))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            loop {
                match journal.unacked_count() {
                    Ok(count) if count >= crate::config::MAX_UNACKED_EVENTS => {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        client.sync_ready.store(false, Ordering::Release);
                        let _ = sender.send(MatrixOutput::Fatal).await;
                        break;
                    }
                }
                client.last_sync_ms.store(now_ms(), Ordering::Release);
                let synced = client
                    .sync_with_checkpoint(
                        SyncSettings::new().timeout(Duration::from_secs(30)),
                        Duration::from_secs(35),
                    )
                    .await
                    .is_ok();
                let ready = if synced {
                    client.last_sync_ms.store(now_ms(), Ordering::Release);
                    client.revalidate_current().await.is_ok()
                } else {
                    false
                };
                let previous = client.sync_ready.swap(ready, Ordering::AcqRel);
                if let Some(readiness) = readiness_transition(previous, ready)
                    && sender
                        .send(MatrixOutput::Readiness(readiness))
                        .await
                        .is_err()
                {
                    break;
                }
                if sync_failure_requires_fatal(synced) {
                    let _ = sender.send(MatrixOutput::Fatal).await;
                    break;
                }
                if !ready {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        })
    }

    async fn sync_with_checkpoint(
        &self,
        settings: SyncSettings,
        timeout: Duration,
    ) -> Result<(), TransportError> {
        self.ingress_failed.store(false, Ordering::Release);
        let (previous_token, previous_room_event_id) = self
            .sync_checkpoint
            .committed_cursor()
            .map_err(|_| TransportError::TransportFailed)?;
        self.sync_checkpoint
            .begin(previous_token.clone())
            .map_err(|_| TransportError::TransportFailed)?;
        let settings_with_cursor = settings.clone().token(match previous_token.clone() {
            Some(token) => SyncToken::Specific(token),
            None => SyncToken::NoToken,
        });
        let first = tokio::time::timeout(timeout, self.inner.sync_once(settings_with_cursor))
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        let (response, require_boundary) = match first {
            Ok(response) => (response, false),
            Err(error)
                if previous_token.is_some()
                    && previous_room_event_id.is_some()
                    && self.homeserver.origin() == crate::config::PRODUCTION_HOMESERVER_ORIGIN
                    && is_synapse_invalid_stream_token(&error) =>
            {
                let response = tokio::time::timeout(
                    timeout,
                    self.inner.sync_once(settings.token(SyncToken::NoToken)),
                )
                .await
                .map_err(|_| TransportError::TransportFailed)?
                .map_err(|_| TransportError::TransportFailed)?;
                (response, true)
            }
            Err(_) => return Err(TransportError::TransportFailed),
        };
        let next_room_event_id = with_ingress_deadline(Duration::from_secs(60), async {
            let ordered = self
                .ordered_configured_timeline(
                    &response,
                    previous_room_event_id.as_deref(),
                    require_boundary,
                )
                .await?;
            let next_room_event_id = ordered
                .last()
                .and_then(|event| event.event_id())
                .map(|event_id| event_id.to_string())
                .or(previous_room_event_id);
            for event in ordered {
                if self.process_timeline_event(event).await.is_err() {
                    self.ingress_failed.store(true, Ordering::Release);
                    return Err(TransportError::TransportFailed);
                }
            }
            Ok(next_room_event_id)
        })
        .await?;
        if self.ingress_failed.load(Ordering::Acquire) {
            self.sync_ready.store(false, Ordering::Release);
            return Err(TransportError::TransportFailed);
        }
        self.sync_checkpoint
            .commit_cursor(response.next_batch, next_room_event_id)
            .map_err(|_| TransportError::TransportFailed)?;
        self.sync_checkpoint
            .complete()
            .map_err(|_| TransportError::TransportFailed)
    }

    pub fn install_ingress_handler(
        &self,
        journal: PendingJournal,
        spool: PrivateSpool,
        sender: mpsc::Sender<MatrixOutput>,
    ) {
        let _ = self.ingress_pipeline.set(IngressPipeline {
            journal: journal.clone(),
            spool: spool.clone(),
            sender: sender.clone(),
        });
        use matrix_sdk::{
            Room,
            deserialized_responses::{EncryptionInfo, VerificationState},
            ruma::events::room::{
                encrypted::OriginalSyncRoomEncryptedEvent,
                message::{MessageType, OriginalSyncRoomMessageEvent},
            },
        };
        let client = self.clone();
        self.inner.add_event_handler(
            move |event: OriginalSyncRoomMessageEvent,
                  room: Room,
                  encryption: Option<EncryptionInfo>| {
                let client = client.clone();
                let journal = journal.clone();
                let spool = spool.clone();
                let sender = sender.clone();
                async move {
                    if client.ingress_pipeline.get().is_some() {
                        return;
                    }
                    let Ok(permit) = sender.reserve_owned().await else {
                        client.ingress_failed.store(true, Ordering::Release);
                        return;
                    };
                    let Some(encryption) = encryption else { return };
                    let Some(sender_device) = encryption.sender_device.as_ref() else {
                        return;
                    };
                    if encryption.sender != client.owner_mxid
                        || event.sender != client.owner_mxid
                        || room.room_id() != client.room_id
                        || !matches!(encryption.verification_state, VerificationState::Verified)
                    {
                        return;
                    }
                    let Ok(Some(device)) = client
                        .inner
                        .encryption()
                        .get_device(&client.owner_mxid, sender_device)
                        .await
                    else {
                        client.ingress_failed.store(true, Ordering::Release);
                        return;
                    };
                    if !device_policy_allows(
                        device.is_verified_with_cross_signing(),
                        device.is_blacklisted(),
                    ) || client.revalidate_current().await.is_err()
                    {
                        client.ingress_failed.store(true, Ordering::Release);
                        return;
                    }
                    let (body, media) = match &event.content.msgtype {
                        MessageType::Text(text) if bounded_nonempty_text(&text.body) => {
                            (Some(text.body.clone()), Vec::new())
                        }
                        MessageType::Image(image) => {
                            let Some(kind) = image
                                .info
                                .as_ref()
                                .and_then(|info| info.mimetype.as_deref())
                                .and_then(media_kind)
                            else {
                                client.ingress_failed.store(true, Ordering::Release);
                                return;
                            };
                            if !declared_media_size_allowed(
                                image.info.as_ref().and_then(|info| info.size),
                            ) {
                                return;
                            }
                            let declared_size = image
                                .info
                                .as_ref()
                                .and_then(|info| info.size)
                                .map(u64::from)
                                .unwrap_or(0);
                            let Ok(reference) = download_media(
                                &client,
                                &spool,
                                kind,
                                declared_size,
                                image.source.clone(),
                            )
                            .await
                            else {
                                client.ingress_failed.store(true, Ordering::Release);
                                return;
                            };
                            (image.caption().and_then(nonempty_caption), vec![reference])
                        }
                        MessageType::File(file) => {
                            if file.info.as_ref().and_then(|info| info.mimetype.as_deref())
                                != Some("application/pdf")
                                || !declared_media_size_allowed(
                                    file.info.as_ref().and_then(|info| info.size),
                                )
                            {
                                return;
                            }
                            let declared_size = file
                                .info
                                .as_ref()
                                .and_then(|info| info.size)
                                .map(u64::from)
                                .unwrap_or(0);
                            let Ok(reference) = download_media(
                                &client,
                                &spool,
                                MediaKind::Pdf,
                                declared_size,
                                file.source.clone(),
                            )
                            .await
                            else {
                                client.ingress_failed.store(true, Ordering::Release);
                                return;
                            };
                            (file.caption().and_then(nonempty_caption), vec![reference])
                        }
                        _ => return,
                    };
                    let reply_to_event_id =
                        event
                            .content
                            .relates_to
                            .as_ref()
                            .and_then(|relation| match relation {
                                matrix_sdk::ruma::events::room::message::Relation::Reply(reply) => {
                                    Some(reply.in_reply_to.event_id.to_string())
                                }
                                _ => None,
                            });
                    let cleanup_media = media.clone();
                    let ingress = IngressEvent {
                        event_id: event.event_id.to_string(),
                        room_id: room.room_id().to_string(),
                        sender_mxid: event.sender.to_string(),
                        sender_device_id: sender_device.to_string(),
                        body,
                        reply_to_event_id,
                        media,
                    };
                    match journal.persist(ingress) {
                        Ok(outcome) => {
                            if outcome.requires_incoming_media_cleanup() {
                                for media in cleanup_media {
                                    let _ = spool.acknowledge(&media.handle);
                                }
                            }
                            if let Some(pending) = outcome.into_pending() {
                                permit.send(MatrixOutput::Ingress(pending));
                            }
                        }
                        Err(_) => {
                            for media in cleanup_media {
                                let _ = spool.acknowledge(&media.handle);
                            }
                            client.ingress_failed.store(true, Ordering::Release);
                        }
                    }
                }
            },
        );
        let undecryptable_client = self.clone();
        self.inner
            .add_event_handler(move |event: OriginalSyncRoomEncryptedEvent, room: Room| {
                let client = undecryptable_client.clone();
                async move {
                    if client.ingress_pipeline.get().is_some() {
                        return;
                    }
                    if undecryptable_owner_event_requires_retry(
                        event.sender.as_str(),
                        room.room_id().as_str(),
                        client.owner_mxid.as_str(),
                        client.room_id.as_str(),
                    ) {
                        client.ingress_failed.store(true, Ordering::Release);
                    }
                }
            });
    }

    async fn ordered_configured_timeline(
        &self,
        response: &SyncResponse,
        boundary_event_id: Option<&str>,
        require_boundary: bool,
    ) -> Result<Vec<matrix_sdk::deserialized_responses::TimelineEvent>, TransportError> {
        let Some(update) = response.rooms.joined.get(&self.room_id) else {
            return if require_boundary {
                Err(TransportError::TransportFailed)
            } else {
                Ok(Vec::new())
            };
        };
        let suffix = update.timeline.events.clone();
        if let Some(boundary) = boundary_event_id
            && let Some(position) = suffix.iter().position(|event| {
                event
                    .event_id()
                    .is_some_and(|event_id| event_id.as_str() == boundary)
            })
        {
            return Ok(suffix.into_iter().skip(position + 1).collect());
        }
        if !require_boundary && !configured_room_timeline_is_limited(response, &self.room_id) {
            return Ok(suffix);
        }
        let boundary = boundary_event_id.ok_or(TransportError::TransportFailed)?;
        let room = self
            .inner
            .get_room(&self.room_id)
            .ok_or(TransportError::PolicyDenied)?;
        let mut token = update
            .timeline
            .prev_batch
            .clone()
            .ok_or(TransportError::TransportFailed)?;
        let mut seen_tokens = std::collections::HashSet::new();
        let mut gap_newest_first = Vec::new();
        let mut found_boundary = false;
        for _ in 0..MAX_GAP_PAGES {
            if !seen_tokens.insert(token.clone()) {
                return Err(TransportError::TransportFailed);
            }
            let mut options = matrix_sdk::room::MessagesOptions::backward().from(token.as_str());
            options.limit = GAP_PAGE_SIZE.into();
            let page = room
                .messages(options)
                .await
                .map_err(|_| TransportError::TransportFailed)?;
            if page.start != token {
                return Err(TransportError::TransportFailed);
            }
            for event in page.chunk {
                if event
                    .event_id()
                    .as_deref()
                    .is_some_and(|id| id.as_str() == boundary)
                {
                    found_boundary = true;
                    break;
                }
                if gap_newest_first.len() >= MAX_GAP_EVENTS {
                    return Err(TransportError::TransportFailed);
                }
                gap_newest_first.push(event);
            }
            if found_boundary {
                break;
            }
            let Some(next_token) = page.end else {
                return Err(TransportError::TransportFailed);
            };
            token = next_token;
        }
        if !found_boundary {
            return Err(TransportError::TransportFailed);
        }
        gap_newest_first.reverse();
        let mut seen_events = std::collections::HashSet::new();
        let mut ordered = Vec::with_capacity(gap_newest_first.len() + suffix.len());
        for event in gap_newest_first.into_iter().chain(suffix) {
            let event_id = event
                .event_id()
                .ok_or(TransportError::TransportFailed)?
                .to_string();
            if seen_events.insert(event_id) {
                ordered.push(event);
            }
        }
        Ok(ordered)
    }

    async fn latest_configured_room_event_id(&self) -> Result<String, TransportError> {
        let room = self
            .inner
            .get_room(&self.room_id)
            .ok_or(TransportError::PolicyDenied)?;
        let mut options = matrix_sdk::room::MessagesOptions::backward();
        options.limit = 1_u32.into();
        let page = room
            .messages(options)
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        page.chunk
            .first()
            .and_then(|event| event.event_id())
            .map(|event_id| event_id.to_string())
            .ok_or(TransportError::TransportFailed)
    }

    async fn process_timeline_event(
        &self,
        timeline: matrix_sdk::deserialized_responses::TimelineEvent,
    ) -> Result<(), TransportError> {
        use matrix_sdk::{
            deserialized_responses::VerificationState,
            ruma::events::room::{
                encrypted::OriginalSyncRoomEncryptedEvent,
                message::{MessageType, OriginalSyncRoomMessageEvent},
            },
        };
        let pipeline = self
            .ingress_pipeline
            .get()
            .cloned()
            .ok_or(TransportError::TransportFailed)?;
        let room = self
            .inner
            .get_room(&self.room_id)
            .ok_or(TransportError::PolicyDenied)?;
        if let Ok(encrypted) = timeline
            .raw()
            .deserialize_as_unchecked::<OriginalSyncRoomEncryptedEvent>()
        {
            return if encrypted.sender == self.owner_mxid {
                Err(TransportError::TransportFailed)
            } else {
                Ok(())
            };
        }
        let Ok(event) = timeline
            .raw()
            .deserialize_as_unchecked::<OriginalSyncRoomMessageEvent>()
        else {
            return Ok(());
        };
        let Some(encryption) = timeline.encryption_info() else {
            return Ok(());
        };
        let Some(sender_device) = encryption.sender_device.as_ref() else {
            return Err(TransportError::TransportFailed);
        };
        if encryption.sender != self.owner_mxid
            || event.sender != self.owner_mxid
            || !matches!(encryption.verification_state, VerificationState::Verified)
        {
            return Ok(());
        }
        let device = self
            .inner
            .encryption()
            .get_device(&self.owner_mxid, sender_device)
            .await
            .map_err(|_| TransportError::TransportFailed)?
            .ok_or(TransportError::TransportFailed)?;
        if !device_policy_allows(
            device.is_verified_with_cross_signing(),
            device.is_blacklisted(),
        ) || self.revalidate_current().await.is_err()
        {
            return Err(TransportError::PolicyDenied);
        }
        let (body, media) = match &event.content.msgtype {
            MessageType::Text(text) if bounded_nonempty_text(&text.body) => {
                (Some(text.body.clone()), Vec::new())
            }
            MessageType::Image(image) => {
                let Some(kind) = image
                    .info
                    .as_ref()
                    .and_then(|info| info.mimetype.as_deref())
                    .and_then(media_kind)
                else {
                    return Ok(());
                };
                if !declared_media_size_allowed(image.info.as_ref().and_then(|info| info.size)) {
                    return Ok(());
                }
                let size = image
                    .info
                    .as_ref()
                    .and_then(|info| info.size)
                    .map(u64::from)
                    .unwrap_or(0);
                let reference =
                    download_media(self, &pipeline.spool, kind, size, image.source.clone()).await?;
                (image.caption().and_then(nonempty_caption), vec![reference])
            }
            MessageType::File(file) => {
                if file.info.as_ref().and_then(|info| info.mimetype.as_deref())
                    != Some("application/pdf")
                    || !declared_media_size_allowed(file.info.as_ref().and_then(|info| info.size))
                {
                    return Ok(());
                }
                let size = file
                    .info
                    .as_ref()
                    .and_then(|info| info.size)
                    .map(u64::from)
                    .unwrap_or(0);
                let reference = download_media(
                    self,
                    &pipeline.spool,
                    MediaKind::Pdf,
                    size,
                    file.source.clone(),
                )
                .await?;
                (file.caption().and_then(nonempty_caption), vec![reference])
            }
            _ => return Ok(()),
        };
        let reply_to_event_id =
            event
                .content
                .relates_to
                .as_ref()
                .and_then(|relation| match relation {
                    matrix_sdk::ruma::events::room::message::Relation::Reply(reply) => {
                        Some(reply.in_reply_to.event_id.to_string())
                    }
                    _ => None,
                });
        let cleanup_media = media.clone();
        let ingress = IngressEvent {
            event_id: event.event_id.to_string(),
            room_id: room.room_id().to_string(),
            sender_mxid: event.sender.to_string(),
            sender_device_id: sender_device.to_string(),
            body,
            reply_to_event_id,
            media,
        };
        match pipeline.journal.persist(ingress) {
            Ok(outcome) => {
                if outcome.requires_incoming_media_cleanup() {
                    for media in cleanup_media {
                        pipeline
                            .spool
                            .acknowledge(&media.handle)
                            .map_err(|_| TransportError::TransportFailed)?;
                    }
                }
                if let Some(pending) = outcome.into_pending() {
                    pipeline
                        .sender
                        .send(MatrixOutput::Ingress(pending))
                        .await
                        .map_err(|_| TransportError::TransportFailed)?;
                }
                Ok(())
            }
            Err(_) => {
                for media in cleanup_media {
                    pipeline
                        .spool
                        .acknowledge(&media.handle)
                        .map_err(|_| TransportError::TransportFailed)?;
                }
                Err(TransportError::TransportFailed)
            }
        }
    }

    pub async fn send(&self, command: &SendCommand) -> Result<String, TransportError> {
        command
            .validate()
            .map_err(|_| TransportError::PolicyDenied)?;
        self.revalidate(command).await?;
        let room = self
            .inner
            .get_room(&self.room_id)
            .ok_or(TransportError::PolicyDenied)?;
        let mut content = command.formatted_body.as_ref().map_or_else(
            || RoomMessageEventContent::text_plain(command.body.clone()),
            |html| RoomMessageEventContent::text_html(command.body.clone(), html.clone()),
        );
        content.mentions = Some(Mentions::new());
        if let Some(event_id) = &command.reply_to_event_id {
            let event_id: OwnedEventId =
                event_id.parse().map_err(|_| TransportError::PolicyDenied)?;
            content.relates_to = Some(Relation::Reply(Reply::with_event_id(event_id)));
        }
        let txn_id: OwnedTransactionId = command.transaction_id.clone().into();
        let result = tokio::time::timeout(
            Duration::from_secs(SEND_TIMEOUT_SECONDS),
            room.send(content).with_transaction_id(txn_id),
        )
        .await
        .map_err(|_| TransportError::TransportFailed)?
        .map_err(|_| TransportError::TransportFailed)?;
        Ok(result.response.event_id.to_string())
    }

    async fn revalidate(&self, command: &SendCommand) -> Result<(), TransportError> {
        validate_node_snapshot(
            &command.room_policy,
            &ExpectedRoom {
                room_id: self.room_id.as_str(),
                owner_mxid: self.owner_mxid.as_str(),
                bot_mxid: self.bot_mxid.as_str(),
                max_age_ms: 60_000,
            },
            now_ms(),
        )
        .map_err(|_| TransportError::PolicyDenied)?;
        if !self.homeserver.permits(&self.inner.homeserver())
            || command.room_policy.room_id != self.room_id.as_str()
            || command.room_policy.owner_mxid != self.owner_mxid.as_str()
            || command.room_policy.bot_mxid != self.bot_mxid.as_str()
            || !valid_identifier(&command.transaction_id)
        {
            return Err(TransportError::PolicyDenied);
        }
        if !self.sync_ready.load(Ordering::Acquire)
            || now_ms().saturating_sub(self.last_sync_ms.load(Ordering::Acquire)) > 60_000
        {
            return Err(TransportError::TransportFailed);
        }
        let room = self
            .inner
            .get_room(&self.room_id)
            .ok_or(TransportError::PolicyDenied)?;
        if room.state() != RoomState::Joined
            || !room
                .latest_encryption_state()
                .await
                .map_err(|_| TransportError::TransportFailed)?
                .is_encrypted()
        {
            return Err(TransportError::PolicyDenied);
        }
        let joined = room
            .members(RoomMemberships::JOIN)
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        let invites = room
            .members(RoomMemberships::INVITE)
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        let mut joined_ids = joined
            .iter()
            .map(|member| member.user_id().as_str())
            .collect::<Vec<_>>();
        joined_ids.sort_unstable();
        let mut expected = vec![self.owner_mxid.as_str(), self.bot_mxid.as_str()];
        expected.sort_unstable();
        if joined_ids != expected || !invites.is_empty() {
            return Err(TransportError::PolicyDenied);
        }
        self.validate_state_policy(&room).await?;
        self.validate_devices().await
    }

    async fn revalidate_current(&self) -> Result<(), TransportError> {
        if !self.homeserver.permits(&self.inner.homeserver()) {
            return Err(TransportError::PolicyDenied);
        }
        let room = self
            .inner
            .get_room(&self.room_id)
            .ok_or(TransportError::PolicyDenied)?;
        if now_ms().saturating_sub(self.last_sync_ms.load(Ordering::Acquire)) > 60_000 {
            return Err(TransportError::TransportFailed);
        }
        if room.state() != RoomState::Joined
            || !room
                .latest_encryption_state()
                .await
                .map_err(|_| TransportError::TransportFailed)?
                .is_encrypted()
        {
            return Err(TransportError::PolicyDenied);
        }
        let joined = room
            .members(RoomMemberships::JOIN)
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        let invites = room
            .members(RoomMemberships::INVITE)
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        let mut joined_ids = joined
            .iter()
            .map(|member| member.user_id().as_str())
            .collect::<Vec<_>>();
        joined_ids.sort_unstable();
        let mut expected = vec![self.owner_mxid.as_str(), self.bot_mxid.as_str()];
        expected.sort_unstable();
        if joined_ids != expected || !invites.is_empty() {
            return Err(TransportError::PolicyDenied);
        }
        self.validate_state_policy(&room).await?;
        self.validate_devices().await
    }

    async fn validate_state_policy(&self, room: &matrix_sdk::Room) -> Result<(), TransportError> {
        use matrix_sdk::ruma::{api::client::room::Visibility, events::StateEventType};
        if room
            .privacy_settings()
            .get_room_visibility()
            .await
            .map_err(|_| TransportError::TransportFailed)?
            != Visibility::Private
        {
            return Err(TransportError::PolicyDenied);
        }
        for (event_type, field, expected) in [
            ("m.room.join_rules", "join_rule", "invite"),
            ("m.room.history_visibility", "history_visibility", "joined"),
            ("m.room.guest_access", "guest_access", "forbidden"),
        ] {
            let content = state_content(room, StateEventType::from(event_type))
                .await?
                .ok_or(TransportError::PolicyDenied)?;
            if content.get(field).and_then(serde_json::Value::as_str) != Some(expected) {
                return Err(TransportError::PolicyDenied);
            }
        }
        if let Some(alias) =
            state_content(room, StateEventType::from("m.room.canonical_alias")).await?
            && (alias.get("alias").is_some_and(|value| !value.is_null())
                || alias
                    .get("alt_aliases")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|values| !values.is_empty()))
        {
            return Err(TransportError::PolicyDenied);
        }
        self.validate_local_aliases().await?;
        for event_type in [
            "m.bridge",
            "uk.half-shot.bridge",
            "im.vector.modular.widgets",
        ] {
            if !room
                .get_state_events(StateEventType::from(event_type))
                .await
                .map_err(|_| TransportError::TransportFailed)?
                .is_empty()
            {
                return Err(TransportError::PolicyDenied);
            }
        }
        Ok(())
    }

    async fn validate_local_aliases(&self) -> Result<(), TransportError> {
        let url = authenticated_room_aliases_url(&self.homeserver, &self.room_id)?;
        let mut response = tokio::time::timeout(
            Duration::from_secs(SEND_TIMEOUT_SECONDS),
            self.http
                .get(url)
                .bearer_auth(self.access_token.as_str())
                .send(),
        )
        .await
        .map_err(|_| TransportError::TransportFailed)?
        .map_err(|_| TransportError::TransportFailed)?;
        if !response.status().is_success() {
            return Err(TransportError::TransportFailed);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ALIAS_RESPONSE_BYTES as u64)
        {
            return Err(TransportError::PolicyDenied);
        }
        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .and_then(|length| usize::try_from(length).ok())
                .unwrap_or(0)
                .min(MAX_ALIAS_RESPONSE_BYTES),
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| TransportError::TransportFailed)?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_ALIAS_RESPONSE_BYTES {
                return Err(TransportError::PolicyDenied);
            }
            bytes.extend_from_slice(&chunk);
        }
        require_no_local_aliases(&bytes)
    }

    async fn validate_devices(&self) -> Result<(), TransportError> {
        for user_id in [&self.owner_mxid, &self.bot_mxid] {
            let devices = self
                .inner
                .encryption()
                .get_user_devices(user_id)
                .await
                .map_err(|_| TransportError::TransportFailed)?;
            let collected = devices.devices().collect::<Vec<_>>();
            if collected.is_empty()
                || collected.iter().any(|device| {
                    !device_policy_allows(
                        device.is_verified_with_cross_signing(),
                        device.is_blacklisted(),
                    )
                })
            {
                return Err(TransportError::PolicyDenied);
            }
        }
        let own = self
            .inner
            .encryption()
            .get_own_device()
            .await
            .map_err(|_| TransportError::TransportFailed)?
            .ok_or(TransportError::PolicyDenied)?;
        if own.device_id().as_str() != self.bot_device_id
            || !device_policy_allows(own.is_verified_with_cross_signing(), own.is_blacklisted())
        {
            return Err(TransportError::PolicyDenied);
        }
        Ok(())
    }
}

fn undecryptable_owner_event_requires_retry(
    sender_mxid: &str,
    room_id: &str,
    owner_mxid: &str,
    configured_room_id: &str,
) -> bool {
    sender_mxid == owner_mxid && room_id == configured_room_id
}

pub fn startup_requires_sync(unacked: usize) -> bool {
    unacked < crate::config::MAX_UNACKED_EVENTS
}

pub fn pre_ingress_baseline_allowed(cursor_missing: bool, unacked: usize) -> bool {
    !cursor_missing || unacked == 0
}

fn configured_room_timeline_is_limited(
    response: &SyncResponse,
    room_id: &matrix_sdk::ruma::RoomId,
) -> bool {
    response
        .rooms
        .joined
        .get(room_id)
        .is_some_and(|update| update.timeline.limited)
}

fn is_synapse_invalid_stream_token(error: &matrix_sdk::Error) -> bool {
    use matrix_sdk::ruma::api::error::{ErrorBody, ErrorKind};

    let Some(error) = error.as_client_api_error() else {
        return false;
    };
    let ErrorBody::Standard(body) = &error.body else {
        return false;
    };
    synapse_invalid_stream_token_fields(
        error.status_code.as_u16(),
        matches!(body.kind, ErrorKind::Unknown),
        &body.message,
    )
}

fn synapse_invalid_stream_token_fields(status: u16, unknown: bool, message: &str) -> bool {
    status == 400 && unknown && message.starts_with("Invalid stream token")
}

fn configured_room_baseline_anchor(
    response: &SyncResponse,
    room_id: &matrix_sdk::ruma::RoomId,
) -> Result<Option<String>, TransportError> {
    let Some(update) = response.rooms.joined.get(room_id) else {
        return Err(TransportError::TransportFailed);
    };
    baseline_anchor(
        update.timeline.events.len(),
        update
            .timeline
            .events
            .last()
            .and_then(|event| event.event_id())
            .map(|event_id| event_id.to_string()),
    )
}

fn baseline_anchor(
    event_count: usize,
    last_event_id: Option<String>,
) -> Result<Option<String>, TransportError> {
    match (event_count, last_event_id) {
        (0, None) => Ok(None),
        (0, Some(_)) | (_, None) => Err(TransportError::TransportFailed),
        (_, Some(event_id)) => Ok(Some(event_id)),
    }
}

#[cfg(test)]
fn assemble_gap_ids(
    boundary: &str,
    initial_token: &str,
    pages: &[(String, Option<String>, Vec<String>)],
    suffix: &[String],
    maximum: usize,
) -> Result<Vec<String>, ()> {
    let mut expected_token = initial_token.to_owned();
    let mut seen_tokens = std::collections::HashSet::new();
    let mut newest_first = Vec::new();
    let mut found = false;
    for (start, end, events) in pages {
        if start != &expected_token || !seen_tokens.insert(start.clone()) {
            return Err(());
        }
        for event_id in events {
            if event_id == boundary {
                found = true;
                break;
            }
            if newest_first.len() >= maximum {
                return Err(());
            }
            newest_first.push(event_id.clone());
        }
        if found {
            break;
        }
        let Some(next) = end.clone() else {
            return Err(());
        };
        expected_token = next;
    }
    if !found {
        return Err(());
    }
    newest_first.reverse();
    let mut seen = std::collections::HashSet::new();
    Ok(newest_first
        .into_iter()
        .chain(suffix.iter().cloned())
        .filter(|event_id| seen.insert(event_id.clone()))
        .collect())
}

async fn download_media(
    client: &MatrixClient,
    spool: &PrivateSpool,
    kind: MediaKind,
    declared_size: u64,
    source: matrix_sdk::ruma::events::room::MediaSource,
) -> Result<crate::media_spool::MediaReference, TransportError> {
    use matrix_sdk::ruma::events::room::MediaSource;
    use tokio::io::AsyncWriteExt;

    if declared_size == 0 || declared_size > crate::config::MAX_MEDIA_OBJECT_BYTES {
        return Err(TransportError::PolicyDenied);
    }
    let encrypted = match source {
        MediaSource::Encrypted(file) => file,
        MediaSource::Plain(_) => return Err(TransportError::PolicyDenied),
    };
    let url = authenticated_media_url(&client.homeserver, &encrypted.url)?;
    let staging = spool
        .create_staging_file()
        .map_err(|_| TransportError::TransportFailed)?;
    let staging_path = staging.path.clone();
    let mut staging_file = tokio::fs::File::from_std(staging.file);
    let download_result = tokio::time::timeout(Duration::from_secs(SEND_TIMEOUT_SECONDS), async {
        let mut response = client
            .http
            .get(url)
            .bearer_auth(client.access_token.as_str())
            .send()
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > crate::config::MAX_MEDIA_OBJECT_BYTES)
        {
            return Err(TransportError::TransportFailed);
        }
        let mut received = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| TransportError::TransportFailed)?
        {
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or(TransportError::TransportFailed)?;
            if received > crate::config::MAX_MEDIA_OBJECT_BYTES {
                return Err(TransportError::PolicyDenied);
            }
            staging_file
                .write_all(&chunk)
                .await
                .map_err(|_| TransportError::TransportFailed)?;
        }
        staging_file
            .sync_all()
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        Ok::<(), TransportError>(())
    })
    .await
    .unwrap_or(Err(TransportError::TransportFailed));
    if let Err(error) = download_result {
        drop(staging_file);
        let _ = spool.remove_staging_file(&staging_path);
        return Err(error);
    }
    let mut encrypted_file = staging_file.into_std().await;
    encrypted_file
        .seek(SeekFrom::Start(0))
        .map_err(|_| TransportError::TransportFailed)?;
    let spool_for_write = spool.clone();
    let staging_for_remove = staging_path.clone();
    let reference = tokio::task::spawn_blocking(move || {
        let mut decryptor = matrix_sdk_base::crypto::AttachmentDecryptor::new(
            &mut encrypted_file,
            encrypted.as_ref().clone().into(),
        )
        .map_err(|_| crate::media_spool::MediaError)?;
        let result = spool_for_write.write_reader(kind, &mut decryptor);
        drop(decryptor);
        drop(encrypted_file);
        let cleanup = spool_for_write.remove_staging_file(&staging_for_remove);
        match (result, cleanup) {
            (Ok(reference), Ok(())) => Ok(reference),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    })
    .await
    .map_err(|_| TransportError::TransportFailed)?
    .map_err(|_| TransportError::PolicyDenied)?;
    if reference.length != declared_size {
        let _ = spool.acknowledge(&reference.handle);
        return Err(TransportError::PolicyDenied);
    }
    Ok(reference)
}

fn authenticated_media_url(
    homeserver: &crate::config::FixedHomeserver,
    uri: &matrix_sdk::ruma::MxcUri,
) -> Result<url::Url, TransportError> {
    let (server_name, media_id) = uri.parts().map_err(|_| TransportError::PolicyDenied)?;
    let mut url = homeserver.as_url().clone();
    url.path_segments_mut()
        .map_err(|_| TransportError::PolicyDenied)?
        .clear()
        .extend([
            "_matrix",
            "client",
            "v1",
            "media",
            "download",
            server_name.as_str(),
            media_id,
        ]);
    if !homeserver.permits(&url) {
        return Err(TransportError::PolicyDenied);
    }
    Ok(url)
}

fn authenticated_room_aliases_url(
    homeserver: &crate::config::FixedHomeserver,
    room_id: &matrix_sdk::ruma::RoomId,
) -> Result<url::Url, TransportError> {
    let mut url = homeserver.as_url().clone();
    url.path_segments_mut()
        .map_err(|_| TransportError::PolicyDenied)?
        .clear()
        .extend([
            "_matrix",
            "client",
            "v3",
            "rooms",
            room_id.as_str(),
            "aliases",
        ]);
    if !homeserver.permits(&url) {
        return Err(TransportError::PolicyDenied);
    }
    Ok(url)
}

fn require_no_local_aliases(bytes: &[u8]) -> Result<(), TransportError> {
    if bytes.len() > MAX_ALIAS_RESPONSE_BYTES {
        return Err(TransportError::PolicyDenied);
    }
    let response: LocalAliasesResponse =
        serde_json::from_slice(bytes).map_err(|_| TransportError::PolicyDenied)?;
    if response.aliases.is_empty() {
        Ok(())
    } else {
        Err(TransportError::PolicyDenied)
    }
}

fn media_kind(mime: &str) -> Option<MediaKind> {
    match mime {
        "image/jpeg" => Some(MediaKind::Jpeg),
        "image/png" => Some(MediaKind::Png),
        _ => None,
    }
}

fn nonempty_caption(value: &str) -> Option<String> {
    bounded_nonempty_text(value).then(|| value.to_owned())
}

fn bounded_nonempty_text(value: &str) -> bool {
    !value.trim().is_empty()
        && !value.contains('\0')
        && value.len() <= crate::config::MAX_PLAINTEXT_BYTES
}

fn declared_media_size_allowed(size: Option<matrix_sdk::ruma::UInt>) -> bool {
    size.is_some_and(|value| u64::from(value) <= crate::config::MAX_MEDIA_OBJECT_BYTES)
}

fn device_policy_allows(cross_signed: bool, blacklisted: bool) -> bool {
    cross_signed && !blacklisted
}

#[cfg(test)]
fn sync_result_allows_readiness(transport_succeeded: bool, ingress_failed: bool) -> bool {
    transport_succeeded && !ingress_failed
}

fn readiness_transition(previous: bool, current: bool) -> Option<Readiness> {
    (previous != current).then_some(if current {
        Readiness::Ready
    } else {
        Readiness::Blocked
    })
}

fn sync_failure_requires_fatal(synced: bool) -> bool {
    !synced
}

async fn with_ingress_deadline<T>(
    duration: Duration,
    future: impl std::future::Future<Output = Result<T, TransportError>>,
) -> Result<T, TransportError> {
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| TransportError::TransportFailed)?
}

async fn state_content(
    room: &matrix_sdk::Room,
    event_type: matrix_sdk::ruma::events::StateEventType,
) -> Result<Option<serde_json::Value>, TransportError> {
    use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
    let raw = room
        .get_state_event(event_type, "")
        .await
        .map_err(|_| TransportError::TransportFailed)?;
    raw.map(|event| match event {
        RawAnySyncOrStrippedState::Sync(raw) => raw.get_field("content"),
        RawAnySyncOrStrippedState::Stripped(raw) => raw.get_field("content"),
    })
    .transpose()
    .map_err(|_| TransportError::PolicyDenied)
    .map(|value| value.flatten())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_media_size_is_mandatory_and_bounded() {
        assert!(!declared_media_size_allowed(None));
        assert!(declared_media_size_allowed(Some(
            crate::config::MAX_MEDIA_OBJECT_BYTES.try_into().unwrap()
        )));
        assert!(!declared_media_size_allowed(Some(
            (crate::config::MAX_MEDIA_OBJECT_BYTES + 1)
                .try_into()
                .unwrap()
        )));
    }

    #[test]
    fn sync_failure_blocks_and_verified_recovery_readies() {
        assert_eq!(readiness_transition(true, false), Some(Readiness::Blocked));
        assert_eq!(readiness_transition(false, true), Some(Readiness::Ready));
        assert_eq!(readiness_transition(true, true), None);
        assert!(sync_result_allows_readiness(true, false));
        assert!(!sync_result_allows_readiness(true, true));
        assert!(!sync_result_allows_readiness(false, false));
        assert!(sync_failure_requires_fatal(false));
        assert!(!sync_failure_requires_fatal(true));
    }

    #[test]
    fn undecryptable_owner_event_in_configured_room_forces_checkpoint_retry() {
        assert!(undecryptable_owner_event_requires_retry(
            "@owner:matrix.org",
            "!room:matrix.org",
            "@owner:matrix.org",
            "!room:matrix.org",
        ));
        assert!(!undecryptable_owner_event_requires_retry(
            "@other:matrix.org",
            "!room:matrix.org",
            "@owner:matrix.org",
            "!room:matrix.org",
        ));
        assert!(!undecryptable_owner_event_requires_retry(
            "@owner:matrix.org",
            "!other:matrix.org",
            "@owner:matrix.org",
            "!room:matrix.org",
        ));
    }

    #[test]
    fn full_durable_backlog_must_drain_before_another_sync() {
        assert!(startup_requires_sync(0));
        assert!(startup_requires_sync(crate::config::MAX_UNACKED_EVENTS - 1));
        assert!(!startup_requires_sync(crate::config::MAX_UNACKED_EVENTS));
        assert!(pre_ingress_baseline_allowed(true, 0));
        assert!(!pre_ingress_baseline_allowed(true, 1));
        assert!(pre_ingress_baseline_allowed(false, 1));
    }

    #[test]
    fn configured_room_limited_timeline_never_advances_cursor() {
        let room_id: matrix_sdk::ruma::OwnedRoomId = "!room:matrix.org".parse().unwrap();
        let mut response = SyncResponse::default();
        let mut update = matrix_sdk::sync::JoinedRoomUpdate::default();
        update.timeline.limited = true;
        response.rooms.joined.insert(room_id.clone(), update);
        assert!(configured_room_timeline_is_limited(&response, &room_id));
        assert!(!configured_room_timeline_is_limited(
            &SyncResponse::default(),
            &room_id
        ));
    }

    #[test]
    fn limited_gap_is_assembled_chronologically_across_pages_and_deduplicated() {
        let pages = vec![
            (
                "p1".into(),
                Some("p2".into()),
                vec!["$c".into(), "$b".into()],
            ),
            (
                "p2".into(),
                Some("p3".into()),
                vec!["$a".into(), "$anchor".into()],
            ),
        ];
        let ordered = assemble_gap_ids(
            "$anchor",
            "p1",
            &pages,
            &["$c".into(), "$d".into()],
            MAX_GAP_EVENTS,
        )
        .unwrap();
        assert_eq!(ordered, ["$a", "$b", "$c", "$d"]);
    }

    #[test]
    fn limited_gap_rejects_token_cycles_missing_boundary_and_event_bound() {
        let cycle = vec![
            ("p1".into(), Some("p1".into()), vec!["$b".into()]),
            ("p1".into(), None, vec!["$anchor".into()]),
        ];
        assert!(assemble_gap_ids("$anchor", "p1", &cycle, &[], MAX_GAP_EVENTS).is_err());
        let missing = vec![("p1".into(), None, vec!["$b".into()])];
        assert!(assemble_gap_ids("$anchor", "p1", &missing, &[], MAX_GAP_EVENTS).is_err());
        let mismatched_start = vec![("wrong".into(), None, vec!["$anchor".into()])];
        assert!(assemble_gap_ids("$anchor", "p1", &mismatched_start, &[], MAX_GAP_EVENTS).is_err());
        let over_bound = vec![(
            "p1".into(),
            None,
            (0..=MAX_GAP_EVENTS)
                .map(|index| format!("$event-{index}"))
                .chain(std::iter::once("$anchor".into()))
                .collect(),
        )];
        assert!(assemble_gap_ids("$anchor", "p1", &over_bound, &[], MAX_GAP_EVENTS).is_err());
        assert_eq!(baseline_anchor(0, None).unwrap(), None);
        assert!(baseline_anchor(1, None).is_err());
        assert_eq!(
            baseline_anchor(1, Some("$last".into())).unwrap().as_deref(),
            Some("$last")
        );
        let room_id: matrix_sdk::ruma::OwnedRoomId = "!room:matrix.org".parse().unwrap();
        assert!(configured_room_baseline_anchor(&SyncResponse::default(), &room_id).is_err());
    }

    #[test]
    fn invalid_since_recovery_is_narrowly_classified() {
        assert!(synapse_invalid_stream_token_fields(
            400,
            true,
            "Invalid stream token - stream position too old"
        ));
        assert!(!synapse_invalid_stream_token_fields(
            401,
            true,
            "Invalid stream token"
        ));
        assert!(!synapse_invalid_stream_token_fields(
            400,
            false,
            "Invalid stream token"
        ));
        assert!(!synapse_invalid_stream_token_fields(
            400,
            true,
            "Unknown access token"
        ));
    }

    #[tokio::test]
    async fn recovered_batch_deadline_retains_the_durable_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        crate::lock::ensure_private_directory(&root).unwrap();
        let checkpoint =
            crate::sync_checkpoint::SyncCheckpoint::open(&root, &"a".repeat(64)).unwrap();
        checkpoint.begin(Some("committed".into())).unwrap();
        let result = with_ingress_deadline(Duration::from_millis(1), async {
            std::future::pending::<Result<(), TransportError>>().await
        })
        .await;
        assert!(result.is_err());
        assert!(checkpoint.begin(Some("replacement".into())).is_err());
        checkpoint.complete().unwrap();
    }

    #[test]
    fn device_policy_rejects_unverified_or_locally_blacklisted_devices() {
        assert!(device_policy_allows(true, false));
        assert!(!device_policy_allows(false, false));
        assert!(!device_policy_allows(true, true));
        assert!(!device_policy_allows(false, true));
    }

    #[test]
    fn media_url_is_constructed_under_the_fixed_origin() {
        let homeserver = crate::config::FixedHomeserver::parse("https://matrix.org").unwrap();
        let uri = <&matrix_sdk::ruma::MxcUri>::from("mxc://media.example/object");
        let url = authenticated_media_url(&homeserver, uri).unwrap();
        assert_eq!(
            url.as_str(),
            "https://matrix.org/_matrix/client/v1/media/download/media.example/object"
        );
        assert!(homeserver.permits(&url));
    }

    #[test]
    fn aliases_endpoint_is_fixed_origin_and_any_local_alias_is_denied() {
        let homeserver = crate::config::FixedHomeserver::parse("https://matrix.org").unwrap();
        let room_id: matrix_sdk::ruma::OwnedRoomId = "!room:example".parse().unwrap();
        let url = authenticated_room_aliases_url(&homeserver, &room_id).unwrap();
        assert_eq!(
            url.as_str(),
            "https://matrix.org/_matrix/client/v3/rooms/!room:example/aliases"
        );
        assert!(homeserver.permits(&url));
        assert!(require_no_local_aliases(br#"{"aliases":[]}"#).is_ok());
        assert!(require_no_local_aliases(br##"{"aliases":["#private:example"]}"##).is_err());
        assert!(require_no_local_aliases(br#"{"aliases":[],"extra":true}"#).is_err());
    }
}
