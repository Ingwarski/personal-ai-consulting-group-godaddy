use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use personal_consultant_matrix_sidecar::client::{
    MatrixClient, MatrixOutput, TransportError, pre_ingress_baseline_allowed, startup_requires_sync,
};
use personal_consultant_matrix_sidecar::config::{
    Config, MAX_FRAME_BYTES, MAX_UNACKED_EVENTS, MEDIA_TTL_SECONDS, PROTOCOL_VERSION,
};
use personal_consultant_matrix_sidecar::durable_ingress::DurableJournal as PendingJournal;
use personal_consultant_matrix_sidecar::ingress::OrderedReplay;
use personal_consultant_matrix_sidecar::media_spool::PrivateSpool;
use personal_consultant_matrix_sidecar::protocol::{
    FrameDecoder, IncomingFrame, OutgoingFrame, PublicError, ReadyIdentity, RequestCommand,
    ResponseBody,
};
use personal_consultant_matrix_sidecar::state::Readiness;
use personal_consultant_matrix_sidecar::{store, telemetry};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

struct Runtime {
    _store: store::OpenStore,
    spool: PrivateSpool,
    matrix: MatrixClient,
    sync_task: tokio::task::JoinHandle<()>,
    cleanup_task: tokio::task::JoinHandle<()>,
    journal: PendingJournal,
    output_rx: tokio::sync::mpsc::Receiver<MatrixOutput>,
    readiness: Readiness,
    identity: ReadyIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProtocolPhase {
    AwaitingHello,
    AwaitingInitialize,
    Draining,
    Running,
}

impl ProtocolPhase {
    fn permits_request(self, command: &RequestCommand) -> bool {
        matches!(
            (self, command),
            (Self::AwaitingInitialize, RequestCommand::Initialize)
                | (Self::Draining, RequestCommand::InspectMedia { .. })
                | (Self::Running, RequestCommand::Health)
                | (Self::Running, RequestCommand::Send(_))
                | (Self::Running, RequestCommand::InspectMedia { .. })
        )
    }

    fn permits_ack(self) -> bool {
        matches!(self, Self::Draining | Self::Running)
    }
}

#[tokio::main]
async fn main() {
    if bind_lifetime_to_parent().is_err() {
        telemetry::emit(telemetry::SafeEvent::ProtocolRejected);
        std::process::exit(1);
    }
    if run().await.is_err() {
        telemetry::emit(telemetry::SafeEvent::ProtocolRejected);
        std::process::exit(1);
    }
}

/// GoDaddy may terminate the Node supervisor without giving it a shutdown
/// callback. On Linux, bind this stateful child to that exact parent so an old
/// deployment cannot survive as an orphan and keep renewing the MySQL writer
/// lease. Re-checking the parent closes the race in which it exits between the
/// first lookup and installing the kernel notification.
#[cfg(target_os = "linux")]
fn bind_lifetime_to_parent() -> Result<(), ()> {
    let parent = rustix::process::getppid().ok_or(())?;
    rustix::process::set_parent_process_death_signal(Some(rustix::signal::Signal::Kill))
        .map_err(|_| ())?;
    (rustix::process::getppid() == Some(parent))
        .then_some(())
        .ok_or(())
}

#[cfg(not(target_os = "linux"))]
fn bind_lifetime_to_parent() -> Result<(), ()> {
    Ok(())
}

async fn run() -> Result<(), ()> {
    let options = parse_startup_options(&std::env::args().skip(1).collect::<Vec<_>>())?;
    telemetry::emit(telemetry::SafeEvent::Started);
    let stdin = tokio::io::stdin();
    let mut input = BufReader::new(stdin);
    let mut output = tokio::io::stdout();
    write_frame(&mut output, &OutgoingFrame::hello())
        .await
        .map_err(|_| ())?;
    let mut decoder = FrameDecoder::default();
    let mut runtime: Option<Runtime> = None;
    let mut phase = ProtocolPhase::AwaitingHello;
    let boot_nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut status_sequence = 0_u64;
    let mut terminate_after_response = false;

    loop {
        enum Next {
            Input(Vec<u8>),
            Matrix(MatrixOutput),
        }
        let next = if let Some(active) = runtime.as_mut() {
            tokio::select! {
                bytes = read_bounded_line(&mut input) => Next::Input(bytes.map_err(|_| ())?),
                event = active.output_rx.recv() => match event {
                    Some(event) => Next::Matrix(event),
                    None => return Err(()),
                },
            }
        } else {
            Next::Input(read_bounded_line(&mut input).await.map_err(|_| ())?)
        };
        let bytes = match next {
            Next::Input(bytes) => bytes,
            Next::Matrix(MatrixOutput::Ingress(pending)) => {
                let frame = OutgoingFrame::Event {
                    version: PROTOCOL_VERSION,
                    id: pending.receipt_id,
                    event: pending.event,
                };
                write_frame(&mut output, &frame).await.map_err(|_| ())?;
                continue;
            }
            Next::Matrix(MatrixOutput::Rejected(rejection)) => {
                write_frame(&mut output, &OutgoingFrame::rejected(rejection))
                    .await
                    .map_err(|_| ())?;
                continue;
            }
            Next::Matrix(MatrixOutput::Readiness(readiness)) => {
                let active = runtime.as_mut().ok_or(())?;
                active.readiness = readiness;
                if readiness == Readiness::Ready {
                    phase = ProtocolPhase::Running;
                }
                status_sequence = status_sequence.saturating_add(1);
                let frame = if readiness == Readiness::Ready {
                    OutgoingFrame::Ready {
                        version: PROTOCOL_VERSION,
                        id: format!("sidecar-ready-recovery-{status_sequence}"),
                        readiness,
                        identity: active.identity.clone(),
                    }
                } else {
                    OutgoingFrame::Status {
                        version: PROTOCOL_VERSION,
                        id: format!("status-{status_sequence}"),
                        readiness,
                    }
                };
                write_frame(&mut output, &frame).await.map_err(|_| ())?;
                continue;
            }
            Next::Matrix(MatrixOutput::Fatal) => return Err(()),
        };
        if bytes.is_empty() {
            break;
        }
        let frame = decoder.decode(&bytes).map_err(|_| ())?;
        if phase == ProtocolPhase::AwaitingHello && !matches!(frame, IncomingFrame::Hello { .. }) {
            return Err(());
        }
        let id = frame.id().to_owned();
        let mut send_ready = false;
        let response = match frame {
            IncomingFrame::Hello { .. } => {
                if phase != ProtocolPhase::AwaitingHello {
                    Some(OutgoingFrame::error(id, PublicError::InvalidState))
                } else {
                    phase = ProtocolPhase::AwaitingInitialize;
                    Some(OutgoingFrame::Response {
                        version: PROTOCOL_VERSION,
                        id,
                        ok: true,
                        result: Some(ResponseBody::Health),
                        error: None,
                    })
                }
            }
            IncomingFrame::Request { command, .. } => {
                let initialize = matches!(command, RequestCommand::Initialize);
                let result = if phase.permits_request(&command) {
                    handle_request(
                        command,
                        &mut runtime,
                        options.provision_fresh,
                        &options.application_root,
                    )
                    .await
                } else {
                    Err(PublicError::InvalidState)
                };
                send_ready = initialize
                    && result.is_ok()
                    && runtime
                        .as_ref()
                        .is_some_and(|active| active.readiness == Readiness::Ready);
                terminate_after_response = initialize && result.is_err();
                if initialize && result.is_ok() {
                    phase = if send_ready {
                        ProtocolPhase::Running
                    } else {
                        ProtocolPhase::Draining
                    };
                }
                decoder.complete(&id);
                Some(match result {
                    Ok(body) => OutgoingFrame::Response {
                        version: PROTOCOL_VERSION,
                        id,
                        ok: true,
                        result: Some(body),
                        error: None,
                    },
                    Err(error) => OutgoingFrame::error(id, error),
                })
            }
            IncomingFrame::Ack { ack, .. } => {
                let acknowledged = if phase.permits_ack() && ack.is_valid() {
                    if let Some(active) = runtime.as_ref() {
                        active.journal.acknowledge(&ack).await.ok()
                    } else {
                        None
                    }
                } else {
                    None
                };
                if !ack.is_valid() || acknowledged.is_none() {
                    Some(OutgoingFrame::error(id, PublicError::InvalidFrame))
                } else {
                    if let (Some(active), Some(outcome)) = (runtime.as_ref(), acknowledged)
                        && let Some(pending) = outcome.pending
                    {
                        for media in pending.event.media {
                            if let PendingJournal::MySql(backend) = &active.journal {
                                // ACK is already durable. Cleanup is retryable
                                // by bounded orphan pruning after a crash.
                                let _ = personal_consultant_matrix_sidecar::durable_media::remove(
                                    backend,
                                    &media.handle,
                                )
                                .await;
                            }
                            let _ = active.spool.acknowledge(&media.handle);
                        }
                    }
                    Some(OutgoingFrame::Response {
                        version: PROTOCOL_VERSION,
                        id,
                        ok: true,
                        result: Some(ResponseBody::Health),
                        error: None,
                    })
                }
            }
            IncomingFrame::Shutdown { .. } => {
                if let Some(active) = runtime.as_mut() {
                    active.readiness = Readiness::ShuttingDown;
                }
                let response = OutgoingFrame::Response {
                    version: PROTOCOL_VERSION,
                    id,
                    ok: true,
                    result: Some(ResponseBody::ShutdownAccepted),
                    error: None,
                };
                write_frame(&mut output, &response).await.map_err(|_| ())?;
                telemetry::emit(telemetry::SafeEvent::Shutdown);
                break;
            }
        };
        if let Some(response) = response {
            write_frame(&mut output, &response).await.map_err(|_| ())?;
            if terminate_after_response {
                return Err(());
            }
            if send_ready {
                let active = runtime.as_ref().ok_or(())?;
                write_frame(
                    &mut output,
                    &OutgoingFrame::Ready {
                        version: PROTOCOL_VERSION,
                        id: format!("sidecar-ready-{boot_nonce}"),
                        readiness: Readiness::Ready,
                        identity: active.identity.clone(),
                    },
                )
                .await
                .map_err(|_| ())?;
            }
        }
    }
    Ok(())
}

async fn handle_request(
    command: RequestCommand,
    runtime: &mut Option<Runtime>,
    provision_fresh: bool,
    application_root: &Path,
) -> Result<ResponseBody, PublicError> {
    match command {
        RequestCommand::Initialize => {
            if runtime.is_some() {
                return Err(PublicError::InvalidState);
            }
            let config = Config::from_env(provision_fresh, application_root)
                .map_err(|_| PublicError::StoreQuarantined)?;
            let open_store = store::open(&config).await.map_err(public_store_error)?;
            let spool =
                PrivateSpool::create(&config.spool_parent).map_err(|_| PublicError::MediaDenied)?;
            let matrix = MatrixClient::new(
                open_store.client.clone(),
                open_store.http_client.clone(),
                &config,
                open_store.sync_checkpoint.clone(),
            )
            .map_err(|_| PublicError::StoreQuarantined)?;
            let journal = if let Some(backend) = &open_store.mysql {
                PendingJournal::from_mysql(backend.clone())
            } else {
                PendingJournal::open(&config.store_root, config.store_passphrase.as_str())
                    .map_err(public_journal_error)?
            };
            let (output_tx, mut output_rx) = tokio::sync::mpsc::channel(MAX_UNACKED_EVENTS);
            let startup_expired = journal
                .expire_media(std::time::Duration::from_secs(MEDIA_TTL_SECONDS))
                .await
                .map_err(public_journal_error)?;
            for item in &startup_expired {
                if let PendingJournal::MySql(backend) = &journal {
                    for media in &item.media {
                        personal_consultant_matrix_sidecar::durable_media::remove(
                            backend,
                            &media.handle,
                        )
                        .await
                        .map_err(public_durable_media_error)?;
                    }
                    continue;
                }
                spool
                    .authorize_replay(&item.media)
                    .map_err(|_| PublicError::StoreQuarantined)?;
                for media in &item.media {
                    spool
                        .acknowledge(&media.handle)
                        .map_err(|_| PublicError::StoreQuarantined)?;
                }
            }
            let active_handles = journal
                .active_media_handles()
                .await
                .map_err(public_journal_error)?;
            if spool
                .cleanup_expired(
                    std::time::Duration::from_secs(MEDIA_TTL_SECONDS),
                    &active_handles,
                )
                .is_err()
            {
                let _ = std::fs::remove_dir(spool.root());
                return Err(PublicError::StoreQuarantined);
            }
            let mut buffered = journal
                .replay_ordered(MAX_UNACKED_EVENTS)
                .await
                .map_err(public_journal_error)?;
            for item in &buffered {
                if let OrderedReplay::Ingress(pending) = item {
                    if let PendingJournal::MySql(backend) = &journal {
                        personal_consultant_matrix_sidecar::durable_media::restore(
                            backend,
                            &spool,
                            &pending.event.media,
                        )
                        .await
                        .map_err(public_durable_media_error)?;
                    }
                    spool
                        .authorize_replay(&pending.event.media)
                        .map_err(|_| PublicError::StoreQuarantined)?;
                    spool
                        .inspect_batch(&pending.event.media)
                        .map_err(|_| PublicError::StoreQuarantined)?;
                }
            }
            let startup_backlog = buffered.len();
            let cursor_missing = open_store
                .sync_checkpoint
                .committed_token()
                .await
                .map(|token| token.is_none())
                .map_err(|error| public_store_error(store::checkpoint_error(error)))?;
            if !pre_ingress_baseline_allowed(cursor_missing, startup_backlog) {
                return Err(PublicError::StoreQuarantined);
            }
            if cursor_missing {
                matrix
                    .establish_pre_ingress_baseline()
                    .await
                    .map_err(|_| PublicError::NotReady)?;
            }
            matrix.install_ingress_handler(journal.clone(), spool.clone(), output_tx.clone());
            let drain_before_initial_sync = !startup_requires_sync(startup_backlog);
            if !drain_before_initial_sync {
                let mut establish = Box::pin(matrix.establish_readiness());
                loop {
                    tokio::select! {
                        result = &mut establish => {
                            result.map_err(|_| PublicError::NotReady)?;
                            break;
                        }
                        output = output_rx.recv() => match output {
                            Some(MatrixOutput::Ingress(pending)) => buffered.push(OrderedReplay::Ingress(pending)),
                            Some(MatrixOutput::Rejected(rejection)) => buffered.push(OrderedReplay::Rejected(rejection)),
                            Some(MatrixOutput::Readiness(_)) => return Err(PublicError::NotReady),
                            Some(MatrixOutput::Fatal) => return Err(PublicError::NotReady),
                            None => return Err(PublicError::NotReady),
                        },
                    }
                }
                drop(establish);
            }
            while let Ok(output) = output_rx.try_recv() {
                match output {
                    MatrixOutput::Ingress(pending) => {
                        buffered.push(OrderedReplay::Ingress(pending))
                    }
                    MatrixOutput::Rejected(rejection) => {
                        buffered.push(OrderedReplay::Rejected(rejection))
                    }
                    MatrixOutput::Readiness(_) => return Err(PublicError::NotReady),
                    MatrixOutput::Fatal => return Err(PublicError::NotReady),
                }
            }
            buffered.sort_by_key(OrderedReplay::sequence);
            let mut replay_ids = HashSet::new();
            for item in buffered {
                if replay_ids.insert(item.receipt_id().to_owned()) {
                    let output = match item {
                        OrderedReplay::Ingress(pending) => MatrixOutput::Ingress(pending),
                        OrderedReplay::Rejected(rejection) => MatrixOutput::Rejected(rejection),
                    };
                    output_tx
                        .try_send(output)
                        .map_err(|_| PublicError::NotReady)?;
                }
            }
            let binding = open_store
                .binding
                .clone()
                .ok_or(PublicError::StoreQuarantined)?;
            let identity = ready_identity(&config, &binding.store_fingerprint, spool.instance());
            let sync_task = matrix.spawn_sync_loop(
                output_tx.clone(),
                journal.clone(),
                drain_before_initial_sync,
            );
            let cleanup_spool = spool.clone();
            let cleanup_journal = journal.clone();
            let cleanup_output = output_tx;
            let cleanup_task = tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    let expired = match cleanup_journal
                        .expire_media(std::time::Duration::from_secs(MEDIA_TTL_SECONDS))
                        .await
                    {
                        Ok(expired) => expired,
                        Err(_) => {
                            let _ = cleanup_output.send(MatrixOutput::Fatal).await;
                            return;
                        }
                    };
                    for item in expired {
                        if let PendingJournal::MySql(backend) = &cleanup_journal {
                            for media in &item.media {
                                if personal_consultant_matrix_sidecar::durable_media::remove(
                                    backend,
                                    &media.handle,
                                )
                                .await
                                .is_err()
                                {
                                    let _ = cleanup_output.send(MatrixOutput::Fatal).await;
                                    return;
                                }
                            }
                        }
                        if cleanup_spool.authorize_replay(&item.media).is_err() {
                            let _ = cleanup_output.send(MatrixOutput::Fatal).await;
                            return;
                        }
                        for media in item.media {
                            if cleanup_spool.acknowledge(&media.handle).is_err() {
                                let _ = cleanup_output.send(MatrixOutput::Fatal).await;
                                return;
                            }
                        }
                        if cleanup_output
                            .send(MatrixOutput::Rejected(item.rejection))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    let active_handles = match cleanup_journal.active_media_handles().await {
                        Ok(handles) => handles,
                        Err(_) => {
                            let _ = cleanup_output.send(MatrixOutput::Fatal).await;
                            return;
                        }
                    };
                    if let PendingJournal::MySql(backend) = &cleanup_journal {
                        if personal_consultant_matrix_sidecar::durable_media::prune(
                            backend,
                            &active_handles,
                        )
                        .await
                        .is_err()
                        {
                            let _ = cleanup_output.send(MatrixOutput::Fatal).await;
                            return;
                        }
                    }
                    if cleanup_spool
                        .cleanup_expired(
                            std::time::Duration::from_secs(MEDIA_TTL_SECONDS),
                            &active_handles,
                        )
                        .is_err()
                    {
                        let _ = cleanup_output.send(MatrixOutput::Fatal).await;
                        return;
                    }
                }
            });
            *runtime = Some(Runtime {
                _store: open_store,
                spool,
                matrix,
                sync_task,
                cleanup_task,
                journal,
                output_rx,
                readiness: if drain_before_initial_sync {
                    Readiness::Blocked
                } else {
                    Readiness::Ready
                },
                identity,
            });
            telemetry::emit(telemetry::SafeEvent::Ready);
            Ok(ResponseBody::Initialized)
        }
        RequestCommand::Health => runtime
            .as_ref()
            .filter(|value| value.readiness == Readiness::Ready && value.matrix.is_ready())
            .map(|_| ResponseBody::Health)
            .ok_or(PublicError::NotReady),
        RequestCommand::InspectMedia { media } => {
            let active = runtime.as_ref().ok_or(PublicError::NotReady)?;
            active
                .spool
                .inspect_batch(&media)
                .map(|objects| ResponseBody::Media { objects })
                .map_err(|_| PublicError::MediaDenied)
        }
        RequestCommand::Send(command) => {
            let active = runtime.as_ref().ok_or(PublicError::NotReady)?;
            active
                .matrix
                .send(command.as_ref())
                .await
                .map(|event_id| ResponseBody::Accepted { event_id })
                .map_err(public_send_error)
        }
    }
}

struct StartupOptions {
    provision_fresh: bool,
    application_root: PathBuf,
}

fn parse_startup_options(args: &[String]) -> Result<StartupOptions, ()> {
    let (root, provision_fresh) = match args {
        [flag, root] if flag == "--application-root" => (root, false),
        [flag, root, provision]
            if flag == "--application-root" && provision == "--provision-fresh" =>
        {
            (root, true)
        }
        _ => return Err(()),
    };
    let root = PathBuf::from(root);
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || !root.is_dir()
    {
        return Err(());
    }
    Ok(StartupOptions {
        provision_fresh,
        application_root: root,
    })
}

fn public_send_error(error: TransportError) -> PublicError {
    match error {
        TransportError::PolicyDenied => PublicError::PolicyDenied,
        TransportError::TransportFailed => PublicError::TransportFailed,
    }
}

fn public_journal_error(
    error: personal_consultant_matrix_sidecar::durable_ingress::JournalError,
) -> PublicError {
    match error {
        personal_consultant_matrix_sidecar::durable_ingress::JournalError::Database(error) => {
            public_store_error(store::mysql_error(error))
        }
        personal_consultant_matrix_sidecar::durable_ingress::JournalError::Invalid => {
            PublicError::StoreQuarantined
        }
    }
}

fn public_durable_media_error(
    error: personal_consultant_matrix_sidecar::durable_media::MediaError,
) -> PublicError {
    match error {
        personal_consultant_matrix_sidecar::durable_media::MediaError::Database(error) => {
            public_store_error(store::mysql_error(error))
        }
        personal_consultant_matrix_sidecar::durable_media::MediaError::Invalid => {
            PublicError::StoreQuarantined
        }
    }
}

fn public_store_error(error: store::StoreError) -> PublicError {
    match error {
        store::StoreError::LockContended => PublicError::LockContended,
        store::StoreError::RetryWithNewInstance => PublicError::NotReady,
        store::StoreError::Quarantined | store::StoreError::Open => {
            telemetry::emit(telemetry::SafeEvent::StoreQuarantined);
            PublicError::StoreQuarantined
        }
    }
}

fn ready_identity(config: &Config, store_fingerprint: &str, spool_instance: &str) -> ReadyIdentity {
    ReadyIdentity {
        build: env!("CARGO_PKG_VERSION").into(),
        homeserver_origin: config.homeserver.origin(),
        room_id_sha256: sha256_utf8(&config.room_id),
        owner_mxid_sha256: sha256_utf8(&config.owner_mxid),
        bot_mxid_sha256: sha256_utf8(&config.bot_mxid),
        bot_device_id_sha256: sha256_utf8(&config.bot_device_id),
        store_fingerprint: store_fingerprint.into(),
        spool_instance: spool_instance.into(),
    }
}

fn sha256_utf8(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.sync_task.abort();
        self.cleanup_task.abort();
    }
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(line);
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(take) > MAX_FRAME_BYTES + 1 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "frame limit"));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if line.last() == Some(&b'\n') {
            return Ok(line);
        }
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &OutgoingFrame,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(frame).map_err(io::Error::other)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame limit"));
    }
    writer.write_all(&bytes).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_reader_rejects_before_growing_past_limit() {
        let bytes = vec![b'x'; MAX_FRAME_BYTES + 2];
        let mut reader = BufReader::new(bytes.as_slice());
        assert!(read_bounded_line(&mut reader).await.is_err());
    }

    #[test]
    fn protocol_phase_requires_one_hello_then_one_initialize() {
        let initialize = RequestCommand::Initialize;
        let health = RequestCommand::Health;
        let inspect = RequestCommand::InspectMedia { media: Vec::new() };
        assert!(!ProtocolPhase::AwaitingHello.permits_request(&initialize));
        assert!(ProtocolPhase::AwaitingInitialize.permits_request(&initialize));
        assert!(!ProtocolPhase::AwaitingInitialize.permits_request(&health));
        assert!(!ProtocolPhase::Draining.permits_request(&health));
        assert!(!ProtocolPhase::Draining.permits_request(&initialize));
        assert!(ProtocolPhase::Draining.permits_request(&inspect));
        assert!(ProtocolPhase::Draining.permits_ack());
        assert!(startup_requires_sync(MAX_UNACKED_EVENTS - 1));
        assert!(ProtocolPhase::Running.permits_request(&health));
        assert!(!ProtocolPhase::Running.permits_request(&initialize));
    }

    #[test]
    fn send_error_classes_do_not_conflate_policy_and_transport() {
        assert!(matches!(
            public_send_error(TransportError::PolicyDenied),
            PublicError::PolicyDenied
        ));
        assert!(matches!(
            public_send_error(TransportError::TransportFailed),
            PublicError::TransportFailed
        ));
    }

    #[test]
    fn lock_contention_is_retryable_without_weakening_quarantine() {
        assert!(matches!(
            public_store_error(store::StoreError::LockContended),
            PublicError::LockContended
        ));
        assert!(matches!(
            public_store_error(store::StoreError::Quarantined),
            PublicError::StoreQuarantined
        ));
        assert!(matches!(
            public_store_error(store::StoreError::RetryWithNewInstance),
            PublicError::NotReady
        ));
        // Existing SQLite/open failures retain their historical classification.
        assert!(matches!(
            public_store_error(store::StoreError::Open),
            PublicError::StoreQuarantined
        ));
    }

    #[test]
    fn startup_journal_and_media_transients_retry_but_invalid_content_stays_quarantined() {
        use personal_consultant_matrix_mysql_store::StoreError as Db;
        use personal_consultant_matrix_sidecar::{
            durable_ingress::JournalError, durable_media::MediaError,
        };
        assert!(matches!(
            public_journal_error(JournalError::Database(Db::Unavailable)),
            PublicError::NotReady
        ));
        assert!(matches!(
            public_journal_error(JournalError::Database(Db::Fenced)),
            PublicError::NotReady
        ));
        assert!(matches!(
            public_journal_error(JournalError::Invalid),
            PublicError::StoreQuarantined
        ));
        assert!(matches!(
            public_durable_media_error(MediaError::Database(Db::Closed)),
            PublicError::NotReady
        ));
        assert!(matches!(
            public_durable_media_error(MediaError::Database(Db::Corrupt)),
            PublicError::StoreQuarantined
        ));
        assert!(matches!(
            public_durable_media_error(MediaError::Invalid),
            PublicError::StoreQuarantined
        ));
    }

    #[test]
    fn startup_requires_an_explicit_absolute_application_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap().to_owned();
        let normal = parse_startup_options(&["--application-root".into(), root.clone()]).unwrap();
        assert!(!normal.provision_fresh);
        assert_eq!(normal.application_root, temp.path());
        let fresh = parse_startup_options(&[
            "--application-root".into(),
            root,
            "--provision-fresh".into(),
        ])
        .unwrap();
        assert!(fresh.provision_fresh);
        assert!(parse_startup_options(&[]).is_err());
        assert!(parse_startup_options(&["--application-root".into(), "relative".into()]).is_err());
    }
}
