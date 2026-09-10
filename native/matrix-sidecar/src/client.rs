use std::io::{Seek, SeekFrom};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use matrix_sdk::{
    Client, RoomState,
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
use tokio::sync::{Mutex, mpsc};
use zeroize::Zeroizing;

use crate::config::{Config, SEND_TIMEOUT_SECONDS};
use crate::durable_ingress::DurableJournal as PendingJournal;
use crate::ingress::{IngressEvent, PendingIngress, PendingRejection};
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

#[cfg(test)]
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

impl From<crate::live_policy::PolicyError> for TransportError {
    fn from(error: crate::live_policy::PolicyError) -> Self {
        match error {
            crate::live_policy::PolicyError::Unavailable => Self::TransportFailed,
            crate::live_policy::PolicyError::Denied => Self::PolicyDenied,
        }
    }
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
    sync_checkpoint: crate::durable_checkpoint::DurableCheckpoint,
    // SDK sync applies cached encryption, membership, history and device state.
    // Keep that mutation out of the authorization-to-send/key-sharing boundary.
    sdk_send_barrier: Arc<Mutex<()>>,
}

impl MatrixClient {
    pub fn new(
        inner: Client,
        http: reqwest::Client,
        config: &Config,
        sync_checkpoint: crate::durable_checkpoint::DurableCheckpoint,
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
            sdk_send_barrier: Arc::new(Mutex::new(())),
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

    pub async fn requires_pre_ingress_baseline(&self) -> Result<bool, TransportError> {
        self.sync_checkpoint
            .committed_token()
            .await
            .map(|token| token.is_none())
            .map_err(|_| TransportError::TransportFailed)
    }

    /// Establishes the event-free boundary for a new application cursor. Events before this
    /// boundary are intentionally outside ingress scope; no application event handler may be
    /// installed until this returns and durably commits the response token.
    pub async fn establish_pre_ingress_baseline(&self) -> Result<(), TransportError> {
        if !self.requires_pre_ingress_baseline().await? {
            return Ok(());
        }
        let response = self
            .sync_sdk(
                SyncSettings::new()
                    .timeout(Duration::from_secs(0))
                    .token(SyncToken::NoToken),
                Duration::from_secs(SEND_TIMEOUT_SECONDS),
            )
            .await?
            .map_err(|_| TransportError::TransportFailed)?;
        let room_event_id = match configured_room_baseline_anchor(&response, &self.room_id)? {
            Some(event_id) => event_id,
            None => self.latest_configured_room_event_id().await?,
        };
        self.sync_checkpoint
            .commit_cursor(response.next_batch, Some(room_event_id))
            .await
            .map_err(|_| TransportError::TransportFailed)
    }

    pub async fn establish_readiness(&self) -> Result<(), TransportError> {
        self.sync_once().await?;
        self.revalidate_current().await?;
        self.sync_ready.store(true, Ordering::Release);
        Ok(())
    }

    /// Validate the exact production policy after setup-only synchronization.
    /// Unlike normal ingress synchronization, this deliberately never advances
    /// the durable application cursor: setup must not consume user messages.
    pub async fn validate_setup_policy(&self) -> Result<(), TransportError> {
        let _guard = self.sdk_send_barrier.lock().await;
        tokio::time::timeout(
            Duration::from_secs(15),
            self.inner
                .sync_once(SyncSettings::new().timeout(Duration::ZERO)),
        )
        .await
        .map_err(|_| TransportError::TransportFailed)?
        .map_err(|_| TransportError::TransportFailed)?;
        self.last_sync_ms.store(now_ms(), Ordering::Release);
        self.revalidate_current_guarded().await
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
                    match journal.unacked_count().await {
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
                match journal.unacked_count().await {
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
                        SyncSettings::new().timeout(Duration::from_secs(10)),
                        Duration::from_secs(15),
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
                // A Matrix /sync request can fail transiently while the
                // encrypted store and durable journal remain healthy. Keep
                // this exact process/store writer alive, publish blocked
                // readiness above, and retry after the bounded delay below.
                // Restarting here only adds lock contention and postpones the
                // durable outbox; journal failures are still fatal in the
                // explicit branches above.
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
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        self.sync_checkpoint
            .begin(previous_token.clone())
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        let settings_with_cursor = settings.clone().token(match previous_token.clone() {
            Some(token) => SyncToken::Specific(token),
            None => SyncToken::NoToken,
        });
        let first = self.sync_sdk(settings_with_cursor, timeout).await?;
        let (response, require_boundary) = match first {
            Ok(response) => (response, false),
            Err(error)
                if previous_token.is_some()
                    && previous_room_event_id.is_some()
                    && self.homeserver.origin() == crate::config::PRODUCTION_HOMESERVER_ORIGIN
                    && is_synapse_invalid_stream_token(&error) =>
            {
                let response = self
                    .sync_sdk(settings.token(SyncToken::NoToken), timeout)
                    .await?
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
            .await
            .map_err(|_| TransportError::TransportFailed)?;
        self.sync_checkpoint
            .complete()
            .await
            .map_err(|_| TransportError::TransportFailed)
    }

    async fn sync_sdk(
        &self,
        settings: SyncSettings,
        timeout: Duration,
    ) -> Result<Result<SyncResponse, matrix_sdk::Error>, TransportError> {
        sync_with_sdk_guard(
            &self.sdk_send_barrier,
            &self.inner,
            &self.room_id,
            settings,
            timeout,
        )
        .await
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
        self.revalidate_current().await?;
        let device = self
            .inner
            .encryption()
            .get_device(&self.owner_mxid, sender_device)
            .await
            .map_err(|_| TransportError::TransportFailed)?
            .ok_or(TransportError::TransportFailed)?;
        if device.is_deleted()
            || !device_policy_allows(
                device.is_verified_with_cross_signing(),
                device.is_blacklisted(),
            )
        {
            return Err(TransportError::PolicyDenied);
        }
        let reply_to_event_id =
            event
                .content
                .relates_to
                .as_ref()
                .and_then(|relation| match relation {
                    Relation::Reply(reply) => Some(reply.in_reply_to.event_id.to_string()),
                    _ => None,
                });
        let mut ingress = IngressEvent {
            event_id: event.event_id.to_string(),
            room_id: room.room_id().to_string(),
            sender_mxid: event.sender.to_string(),
            sender_device_id: sender_device.to_string(),
            body: None,
            reply_to_event_id,
            media: Vec::new(),
        };
        match &event.content.msgtype {
            MessageType::Text(text) if bounded_nonempty_text(&text.body) => {
                ingress.body = Some(text.body.clone());
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
                let size = image
                    .info
                    .as_ref()
                    .and_then(|info| info.size)
                    .map(u64::from)
                    .unwrap_or(0);
                ingress.body = image.caption().and_then(nonempty_caption);
                let descriptor = serde_json::to_value(&event.content.msgtype)
                    .map_err(|_| TransportError::TransportFailed)?;
                let outcome =
                    download_media(self, &pipeline.spool, kind, size, image.source.clone()).await;
                let Some(reference) =
                    record_media_outcome(&pipeline, &ingress, &descriptor, outcome).await?
                else {
                    return Ok(());
                };
                ingress.media.push(reference);
            }
            MessageType::File(file) => {
                if file.info.as_ref().and_then(|info| info.mimetype.as_deref())
                    != Some("application/pdf")
                {
                    return Ok(());
                }
                let size = file
                    .info
                    .as_ref()
                    .and_then(|info| info.size)
                    .map(u64::from)
                    .unwrap_or(0);
                ingress.body = file.caption().and_then(nonempty_caption);
                let descriptor = serde_json::to_value(&event.content.msgtype)
                    .map_err(|_| TransportError::TransportFailed)?;
                let outcome = download_media(
                    self,
                    &pipeline.spool,
                    MediaKind::Pdf,
                    size,
                    file.source.clone(),
                )
                .await;
                let Some(reference) =
                    record_media_outcome(&pipeline, &ingress, &descriptor, outcome).await?
                else {
                    return Ok(());
                };
                ingress.media.push(reference);
            }
            _ => return Ok(()),
        }
        let cleanup_media = ingress.media.clone();
        if let PendingJournal::MySql(backend) = &pipeline.journal {
            crate::durable_media::archive(backend, &pipeline.spool, &ingress.media)
                .await
                .map_err(|_| TransportError::TransportFailed)?;
        }
        match pipeline.journal.persist(ingress).await {
            Ok(outcome) => {
                if outcome.requires_incoming_media_cleanup() {
                    for media in cleanup_media {
                        if let PendingJournal::MySql(backend) = &pipeline.journal {
                            crate::durable_media::remove(backend, &media.handle)
                                .await
                                .map_err(|_| TransportError::TransportFailed)?;
                        }
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
                // A failed SQL commit may have succeeded server-side. Retain
                // encrypted media until recovery/TTL determines reachability.
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
        // Leave a response margin within the Node supervisor's 30-second deadline;
        // authorization is part of this same bounded operation.
        tokio::time::timeout(
            Duration::from_secs(SEND_TIMEOUT_SECONDS - 1),
            self.send_authorized(command),
        )
        .await
        .map_err(|_| TransportError::TransportFailed)?
    }

    async fn send_authorized(&self, command: &SendCommand) -> Result<String, TransportError> {
        command
            .validate()
            .map_err(|_| TransportError::PolicyDenied)?;
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
        send_with_sdk_guard(
            &self.sdk_send_barrier,
            &room,
            &ExpectedRoom {
                room_id: self.room_id.as_str(),
                owner_mxid: self.owner_mxid.as_str(),
                bot_mxid: self.bot_mxid.as_str(),
                max_age_ms: 60_000,
            },
            self.revalidate(command),
            content,
            txn_id,
        )
        .await
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
        if !self.is_ready() || !valid_identifier(&command.transaction_id) {
            return Err(TransportError::TransportFailed);
        }
        self.revalidate_current_guarded().await
    }

    async fn revalidate_current(&self) -> Result<(), TransportError> {
        let _guard = self.sdk_send_barrier.lock().await;
        self.revalidate_current_guarded().await
    }

    async fn revalidate_current_guarded(&self) -> Result<(), TransportError> {
        if now_ms().saturating_sub(self.last_sync_ms.load(Ordering::Acquire)) > 60_000 {
            return Err(TransportError::TransportFailed);
        }
        if !self.homeserver.permits(&self.inner.homeserver())
            || self
                .inner
                .get_room(&self.room_id)
                .is_none_or(|room| room.state() != RoomState::Joined)
        {
            return Err(TransportError::PolicyDenied);
        }
        crate::live_policy::authorize_current(
            self,
            self.room_id.as_str(),
            self.owner_mxid.as_str(),
            self.bot_mxid.as_str(),
            Duration::from_secs(crate::config::CONTROL_TIMEOUT_SECONDS),
        )
        .await
        .map_err(TransportError::from)
    }

    async fn policy_json(
        &self,
        path: &[&str],
        max_bytes: usize,
    ) -> Result<serde_json::Value, crate::live_policy::PolicyError> {
        let mut url = self.homeserver.as_url().clone();
        url.path_segments_mut()
            .map_err(|_| crate::live_policy::PolicyError::Unavailable)?
            .clear()
            .extend(path.iter().copied());
        if !self.homeserver.permits(&url) {
            return Err(crate::live_policy::PolicyError::Unavailable);
        }
        let mut response = self
            .http
            .get(url)
            .bearer_auth(self.access_token.as_str())
            .send()
            .await
            .map_err(|_| crate::live_policy::PolicyError::Unavailable)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(crate::live_policy::PolicyError::Unavailable);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| crate::live_policy::PolicyError::Unavailable)?
        {
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(crate::live_policy::PolicyError::Unavailable);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| crate::live_policy::PolicyError::Unavailable)
    }

    async fn validate_devices(&self) -> Result<(), TransportError> {
        for user_id in [&self.owner_mxid, &self.bot_mxid] {
            // Unlike get_user_devices, this performs /keys/query and applies the
            // signed response to the SDK crypto store even when sync has not advanced.
            let identity = self
                .inner
                .encryption()
                .request_user_identity(user_id)
                .await
                .map_err(|_| TransportError::TransportFailed)?
                .ok_or(TransportError::PolicyDenied)?;
            if !identity.is_verified() {
                return Err(TransportError::PolicyDenied);
            }
            let devices = self
                .inner
                .encryption()
                .get_user_devices(user_id)
                .await
                .map_err(|_| TransportError::TransportFailed)?;
            let collected = devices.devices().collect::<Vec<_>>();
            if collected.is_empty()
                || collected.iter().any(|device| {
                    device.is_deleted()
                        || !device_policy_allows(
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
            || own.is_deleted()
            || !device_policy_allows(own.is_verified_with_cross_signing(), own.is_blacklisted())
        {
            return Err(TransportError::PolicyDenied);
        }
        Ok(())
    }
}

async fn sync_with_sdk_guard(
    barrier: &Mutex<()>,
    client: &Client,
    room_id: &matrix_sdk::ruma::RoomId,
    settings: SyncSettings,
    timeout: Duration,
) -> Result<Result<SyncResponse, matrix_sdk::Error>, TransportError> {
    let _guard = barrier.lock().await;
    // A healthy authorized send may own the barrier longer than the sync HTTP
    // budget. Waiting for it must not falsely classify sync as a fatal failure.
    tokio::time::timeout(timeout, async {
        let response = client.sync_once(settings).await?;
        // Initial/limited SDK sync leaves the member cache incomplete. Finish it
        // under the same barrier, never implicitly during an authorized send.
        if let Some(room) = client.get_room(room_id) {
            room.sync_members().await?;
        }
        Ok(response)
    })
    .await
    .map_err(|_| TransportError::TransportFailed)
}

async fn send_with_sdk_guard(
    barrier: &Mutex<()>,
    room: &matrix_sdk::Room,
    expected: &ExpectedRoom<'_>,
    authorize: impl std::future::Future<Output = Result<(), TransportError>>,
    content: RoomMessageEventContent,
    transaction_id: OwnedTransactionId,
) -> Result<String, TransportError> {
    // The caller's single send deadline includes waiting for this lock.
    let _guard = barrier.lock().await;
    authorize.await?;
    validate_sdk_send_cache(room, expected).await?;
    // No SDK sync, member refresh, or other sidecar policy refresh can mutate
    // the checked cache until encryption, key sharing and the send complete.
    let result = room
        .send(content)
        .with_transaction_id(transaction_id)
        .await
        .map_err(|_| TransportError::TransportFailed)?;
    Ok(result.response.event_id.to_string())
}

async fn validate_sdk_send_cache(
    room: &matrix_sdk::Room,
    expected: &ExpectedRoom<'_>,
) -> Result<(), TransportError> {
    use matrix_sdk::{RoomMemberships, ruma::events::room::history_visibility::HistoryVisibility};

    // These are the exact SDK inputs used by room.send and share_room_key.
    // A fresh raw /state check alone does not replace any of these caches.
    if room.room_id().as_str() != expected.room_id
        || room.state() != RoomState::Joined
        || !room.encryption_state().is_encrypted()
        || !room.are_members_synced()
        || room.history_visibility() != Some(HistoryVisibility::Joined)
    {
        return Err(TransportError::TransportFailed);
    }
    let encryption = room
        .encryption_settings()
        .and_then(|settings| serde_json::to_value(settings).ok())
        .ok_or(TransportError::TransportFailed)?;
    if encryption
        .get("algorithm")
        .and_then(serde_json::Value::as_str)
        != Some("m.megolm.v1.aes-sha2")
    {
        return Err(TransportError::TransportFailed);
    }
    let client = room.client();
    let joined = client
        .state_store()
        .get_user_ids(room.room_id(), RoomMemberships::JOIN)
        .await
        .map_err(|_| TransportError::TransportFailed)?;
    let other_active = client
        .state_store()
        .get_user_ids(
            room.room_id(),
            RoomMemberships::INVITE | RoomMemberships::KNOCK,
        )
        .await
        .map_err(|_| TransportError::TransportFailed)?;
    if joined.len() != 2
        || !joined
            .iter()
            .any(|user| user.as_str() == expected.owner_mxid)
        || !joined.iter().any(|user| user.as_str() == expected.bot_mxid)
        || !other_active.is_empty()
    {
        return Err(TransportError::TransportFailed);
    }
    Ok(())
}

impl crate::live_policy::LivePolicySource for MatrixClient {
    async fn room_state(&self) -> Result<serde_json::Value, crate::live_policy::PolicyError> {
        self.policy_json(
            &[
                "_matrix",
                "client",
                "v3",
                "rooms",
                self.room_id.as_str(),
                "state",
            ],
            1024 * 1024,
        )
        .await
    }
    async fn visibility(&self) -> Result<serde_json::Value, crate::live_policy::PolicyError> {
        self.policy_json(
            &[
                "_matrix",
                "client",
                "v3",
                "directory",
                "list",
                "room",
                self.room_id.as_str(),
            ],
            MAX_ALIAS_RESPONSE_BYTES,
        )
        .await
    }
    async fn aliases(&self) -> Result<serde_json::Value, crate::live_policy::PolicyError> {
        self.policy_json(
            &[
                "_matrix",
                "client",
                "v3",
                "rooms",
                self.room_id.as_str(),
                "aliases",
            ],
            MAX_ALIAS_RESPONSE_BYTES,
        )
        .await
    }
    async fn refresh_verified_devices(&self) -> Result<(), crate::live_policy::PolicyError> {
        self.validate_devices().await.map_err(|error| match error {
            TransportError::PolicyDenied => crate::live_policy::PolicyError::Denied,
            TransportError::TransportFailed => crate::live_policy::PolicyError::Unavailable,
        })
    }
}

#[cfg(test)]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MediaDownloadError {
    InvalidMedia,
    Retry,
}

async fn record_media_outcome(
    pipeline: &IngressPipeline,
    event: &IngressEvent,
    descriptor: &serde_json::Value,
    outcome: Result<crate::media_spool::MediaReference, MediaDownloadError>,
) -> Result<Option<crate::media_spool::MediaReference>, TransportError> {
    match outcome {
        Ok(reference) => Ok(Some(reference)),
        Err(MediaDownloadError::Retry) => Err(TransportError::TransportFailed),
        Err(MediaDownloadError::InvalidMedia) => {
            if let Some(rejection) = pipeline
                .journal
                .reject_invalid_media(event, descriptor)
                .await
                .map_err(|_| TransportError::TransportFailed)?
            {
                pipeline
                    .sender
                    .send(MatrixOutput::Rejected(rejection))
                    .await
                    .map_err(|_| TransportError::TransportFailed)?;
            }
            Ok(None)
        }
    }
}

async fn download_media(
    client: &MatrixClient,
    spool: &PrivateSpool,
    kind: MediaKind,
    declared_size: u64,
    source: matrix_sdk::ruma::events::room::MediaSource,
) -> Result<crate::media_spool::MediaReference, MediaDownloadError> {
    use matrix_sdk::ruma::events::room::{
        EncryptedFileHash, EncryptedFileHashAlgorithm, MediaSource,
    };
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    if declared_size == 0 || declared_size > crate::config::MAX_MEDIA_OBJECT_BYTES {
        return Err(MediaDownloadError::InvalidMedia);
    }
    let encrypted = match source {
        MediaSource::Encrypted(file) => file,
        MediaSource::Plain(_) => return Err(MediaDownloadError::InvalidMedia),
    };
    let Some(EncryptedFileHash::Sha256(expected_hash)) =
        encrypted.hashes.get(&EncryptedFileHashAlgorithm::Sha256)
    else {
        return Err(MediaDownloadError::InvalidMedia);
    };
    let expected_hash = expected_hash.clone().into_inner();
    let url = authenticated_media_url(&client.homeserver, &encrypted.url)
        .map_err(|_| MediaDownloadError::InvalidMedia)?;
    let staging = spool
        .create_staging_file()
        .map_err(|_| MediaDownloadError::Retry)?;
    let staging_path = staging.path.clone();
    let mut staging_file = tokio::fs::File::from_std(staging.file);
    let download_result = tokio::time::timeout(Duration::from_secs(SEND_TIMEOUT_SECONDS), async {
        let mut response = client
            .http
            .get(url)
            .bearer_auth(client.access_token.as_str())
            .send()
            .await
            .map_err(|_| MediaDownloadError::Retry)?;
        validate_media_response(response.status().as_u16(), response.content_length())?;
        let mut received = 0_u64;
        let mut digest = Sha256::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| MediaDownloadError::Retry)?
        {
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or(MediaDownloadError::InvalidMedia)?;
            if received > crate::config::MAX_MEDIA_OBJECT_BYTES {
                return Err(MediaDownloadError::InvalidMedia);
            }
            digest.update(&chunk);
            staging_file
                .write_all(&chunk)
                .await
                .map_err(|_| MediaDownloadError::Retry)?;
        }
        if digest.finalize().as_slice() != expected_hash {
            return Err(MediaDownloadError::InvalidMedia);
        }
        staging_file
            .sync_all()
            .await
            .map_err(|_| MediaDownloadError::Retry)?;
        Ok::<(), MediaDownloadError>(())
    })
    .await
    .unwrap_or(Err(MediaDownloadError::Retry));
    if let Err(error) = download_result {
        drop(staging_file);
        spool
            .remove_staging_file(&staging_path)
            .map_err(|_| MediaDownloadError::Retry)?;
        return Err(error);
    }
    let mut encrypted_file = staging_file.into_std().await;
    encrypted_file
        .seek(SeekFrom::Start(0))
        .map_err(|_| MediaDownloadError::Retry)?;
    let spool_for_write = spool.clone();
    let reference = tokio::task::spawn_blocking(move || {
        let result = (|| {
            let mut decryptor = matrix_sdk_base::crypto::AttachmentDecryptor::new(
                &mut encrypted_file,
                encrypted.as_ref().clone().into(),
            )
            .map_err(|_| MediaDownloadError::InvalidMedia)?;
            spool_for_write
                .write_reader_classified(kind, &mut decryptor)
                .map_err(|error| match error {
                    crate::media_spool::MediaWriteError::InvalidMedia => {
                        MediaDownloadError::InvalidMedia
                    }
                    crate::media_spool::MediaWriteError::Unavailable => MediaDownloadError::Retry,
                })
        })();
        drop(encrypted_file);
        spool_for_write
            .remove_staging_file(&staging_path)
            .map_err(|_| MediaDownloadError::Retry)?;
        result
    })
    .await
    .map_err(|_| MediaDownloadError::Retry)??;
    if reference.length != declared_size {
        spool
            .acknowledge(&reference.handle)
            .map_err(|_| MediaDownloadError::Retry)?;
        return Err(MediaDownloadError::InvalidMedia);
    }
    Ok(reference)
}

fn validate_media_response(status: u16, length: Option<u64>) -> Result<(), MediaDownloadError> {
    if matches!(status, 404 | 410 | 413) {
        return Err(MediaDownloadError::InvalidMedia);
    }
    if !(200..300).contains(&status) {
        return Err(MediaDownloadError::Retry);
    }
    if length.is_some_and(|length| length > crate::config::MAX_MEDIA_OBJECT_BYTES) {
        return Err(MediaDownloadError::InvalidMedia);
    }
    Ok(())
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

async fn with_ingress_deadline<T>(
    duration: Duration,
    future: impl std::future::Future<Output = Result<T, TransportError>>,
) -> Result<T, TransportError> {
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| TransportError::TransportFailed)?
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
    fn authoritative_policy_failure_preserves_retry_or_denial_at_the_protocol_boundary() {
        assert!(matches!(
            TransportError::from(crate::live_policy::PolicyError::Unavailable),
            TransportError::TransportFailed
        ));
        assert!(matches!(
            TransportError::from(crate::live_policy::PolicyError::Denied),
            TransportError::PolicyDenied
        ));
    }

    async fn test_checkpoint(
        store: &std::path::Path,
        secret: &str,
    ) -> crate::sync_checkpoint::SyncCheckpoint {
        drop(
            matrix_sdk_sqlite::SqliteStateStore::open(store, Some(secret))
                .await
                .unwrap(),
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in [
                "matrix-sdk-state.sqlite3",
                "matrix-sdk-state.sqlite3-wal",
                "matrix-sdk-state.sqlite3-shm",
            ] {
                let path = store.join(name);
                if path.exists() {
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
                }
            }
        }
        let checkpoint = crate::sync_checkpoint::SyncCheckpoint::open(store, secret).unwrap();
        checkpoint.initialize_cursor(secret).await.unwrap();
        checkpoint
    }

    #[test]
    fn permanent_media_failures_are_distinct_from_access_and_transport_failures() {
        for status in [404, 410, 413] {
            assert_eq!(
                validate_media_response(status, None),
                Err(MediaDownloadError::InvalidMedia)
            );
        }
        for status in [401, 403, 429, 500, 503] {
            assert_eq!(
                validate_media_response(status, None),
                Err(MediaDownloadError::Retry)
            );
        }
        assert_eq!(
            validate_media_response(200, Some(crate::config::MAX_MEDIA_OBJECT_BYTES + 1)),
            Err(MediaDownloadError::InvalidMedia)
        );
        assert!(validate_media_response(200, Some(8)).is_ok());
    }

    #[tokio::test]
    async fn invalid_media_is_durable_and_does_not_poison_the_next_event_or_restart() {
        use crate::ingress::{IngressAck, OrderedReplay};
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/matrix-invalid-media.json"
        ))
        .unwrap();
        let bad: IngressEvent = serde_json::from_value(fixture["invalid_event"].clone()).unwrap();
        let following: IngressEvent =
            serde_json::from_value(fixture["following_event"].clone()).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let store = temp.path().join("store");
        crate::lock::ensure_private_directory(&store).unwrap();
        let spool = PrivateSpool::create(&store).unwrap();
        let secret = "ab".repeat(32);
        let journal = PendingJournal::open(&store, &secret).unwrap();
        let (sender, mut receiver) = mpsc::channel(4);
        let pipeline = IngressPipeline {
            journal: journal.clone(),
            spool,
            sender,
        };
        assert!(
            record_media_outcome(
                &pipeline,
                &bad,
                &fixture["invalid_descriptor"],
                Err(MediaDownloadError::InvalidMedia)
            )
            .await
            .unwrap()
            .is_none()
        );
        let Some(MatrixOutput::Rejected(rejected)) = receiver.recv().await else {
            panic!("missing rejection");
        };
        assert_eq!(
            serde_json::to_value(crate::protocol::OutgoingFrame::rejected(rejected)).unwrap(),
            fixture["invalid_rejection"]
        );
        let following_receipt = journal
            .persist(following.clone())
            .await
            .unwrap()
            .into_pending()
            .unwrap();
        assert_eq!(following_receipt.sequence, 2);

        // The sync cursor may advance only after both outcomes are durably journaled.
        let checkpoint = test_checkpoint(&store, &secret).await;
        checkpoint
            .commit_cursor("after-both".into(), Some(following.event_id.clone()))
            .unwrap();
        drop(pipeline);
        drop(journal);
        let restored = PendingJournal::open(&store, &secret).unwrap();
        let replay = restored.replay_ordered(4).await.unwrap();
        assert!(matches!(
            &replay[..],
            [OrderedReplay::Rejected(_), OrderedReplay::Ingress(_)]
        ));
        assert_eq!(
            checkpoint.committed_token().unwrap().as_deref(),
            Some("after-both")
        );
        restored
            .acknowledge(&IngressAck {
                event_id: bad.event_id.clone(),
                durable_receipt_id: "mysql-bad".into(),
            })
            .await
            .unwrap();
        restored
            .acknowledge(&IngressAck {
                event_id: following.event_id,
                durable_receipt_id: "mysql-good".into(),
            })
            .await
            .unwrap();
        assert!(restored.replay_ordered(4).await.unwrap().is_empty());
        assert!(
            restored
                .reject_invalid_media(&bad, &fixture["invalid_descriptor"])
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn transient_media_failure_keeps_cursor_and_has_no_permanent_rejection() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/matrix-invalid-media.json"
        ))
        .unwrap();
        let bad: IngressEvent = serde_json::from_value(fixture["invalid_event"].clone()).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let store = temp.path().join("store");
        crate::lock::ensure_private_directory(&store).unwrap();
        let journal = PendingJournal::open(&store, &"ab".repeat(32)).unwrap();
        let checkpoint = test_checkpoint(&store, &"ab".repeat(32)).await;
        checkpoint
            .commit_cursor("before-failure".into(), Some("$before:matrix.org".into()))
            .unwrap();
        let (sender, mut receiver) = mpsc::channel(4);
        let pipeline = IngressPipeline {
            journal: journal.clone(),
            spool: PrivateSpool::create(&store).unwrap(),
            sender,
        };
        assert!(
            record_media_outcome(
                &pipeline,
                &bad,
                &fixture["invalid_descriptor"],
                Err(MediaDownloadError::Retry)
            )
            .await
            .is_err()
        );
        assert!(journal.replay_ordered(4).await.unwrap().is_empty());
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            checkpoint.committed_token().unwrap().as_deref(),
            Some("before-failure")
        );
    }

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
    fn sync_failure_blocks_until_in_process_recovery_readies() {
        assert_eq!(readiness_transition(true, false), Some(Readiness::Blocked));
        assert_eq!(readiness_transition(false, true), Some(Readiness::Ready));
        assert_eq!(readiness_transition(true, true), None);
        assert!(sync_result_allows_readiness(true, false));
        assert!(!sync_result_allows_readiness(true, true));
        assert!(!sync_result_allows_readiness(false, false));
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

#[cfg(test)]
#[path = "client_sdk_tests.rs"]
mod sdk_tests;
