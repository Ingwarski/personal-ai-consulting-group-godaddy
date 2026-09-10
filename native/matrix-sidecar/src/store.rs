use personal_consultant_matrix_mysql_store::{
    Backend, DatabaseConfig, crypto::MySqlCryptoStore, state::MySqlStateStore,
};
use std::fs;
#[cfg(test)]
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use matrix_sdk::{
    Client, SessionMeta, SessionTokens,
    authentication::matrix::MatrixSession,
    ruma::{OwnedDeviceId, OwnedUserId},
};
use matrix_sdk_base::crypto::store::CryptoStore;
use matrix_sdk_base::crypto::{CollectStrategy, DecryptionSettings, TrustRequirement};
use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::config::Config;
use crate::lock::{
    LockError, StoreLock, atomic_create_private, is_atomic_temp_name, read_private_file,
    verify_private_path,
};

const BINDING_FILE: &str = "device-binding.json";
const LOCK_FILE: &str = "sidecar.lock";
const PROVISIONING_FILE: &str = "provisioning-intent.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceBinding {
    pub device_id: String,
    pub store_fingerprint: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProvisioningIntent {
    bot_mxid: String,
    device_id: String,
    nonce: String,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("crypto store is locked by another process")]
    LockContended,
    #[error("crypto store is quarantined")]
    Quarantined,
    #[error("crypto store could not be opened")]
    Open,
    /// This instance must be discarded. Recovery creates a fresh fenced
    /// backend and reloads committed state; it never retries poisoned caches.
    #[error("Matrix database needs a fresh runtime instance")]
    RetryWithNewInstance,
}

pub fn mysql_error(error: personal_consultant_matrix_mysql_store::StoreError) -> StoreError {
    classify_mysql_error(&error)
}

fn classify_mysql_error(error: &personal_consultant_matrix_mysql_store::StoreError) -> StoreError {
    use personal_consultant_matrix_mysql_store::StoreError as DatabaseError;
    match error {
        DatabaseError::Unavailable | DatabaseError::Fenced | DatabaseError::Closed => {
            StoreError::RetryWithNewInstance
        }
        DatabaseError::Conflict => StoreError::LockContended,
        DatabaseError::Corrupt | DatabaseError::InvalidConfiguration | DatabaseError::Schema => {
            StoreError::Quarantined
        }
    }
}

fn crypto_error(error: matrix_sdk_base::crypto::store::CryptoStoreError) -> StoreError {
    if let matrix_sdk_base::crypto::store::CryptoStoreError::Backend(error) = error
        && let Some(database) =
            error.downcast_ref::<personal_consultant_matrix_mysql_store::StoreError>()
    {
        return classify_mysql_error(database);
    }
    StoreError::Quarantined
}

fn state_error(error: matrix_sdk_base::store::StoreError) -> StoreError {
    if let matrix_sdk_base::store::StoreError::Backend(error) = error
        && let Some(database) =
            error.downcast_ref::<personal_consultant_matrix_mysql_store::StoreError>()
    {
        return classify_mysql_error(database);
    }
    StoreError::Quarantined
}

pub fn checkpoint_error(error: crate::durable_checkpoint::CheckpointError) -> StoreError {
    match error {
        crate::durable_checkpoint::CheckpointError::Database(error) => mysql_error(error),
        crate::durable_checkpoint::CheckpointError::Invalid => StoreError::Quarantined,
    }
}

fn restore_mysql_session_error(error: matrix_sdk::Error) -> StoreError {
    match error {
        matrix_sdk::Error::CryptoStoreError(error) => crypto_error(*error),
        matrix_sdk::Error::StateStore(error) => state_error(*error),
        _ => StoreError::Quarantined,
    }
}

pub struct OpenStore {
    pub client: Client,
    pub http_client: reqwest::Client,
    pub lock: Option<StoreLock>,
    pub mysql: Option<Arc<Backend>>,
    _lease: Option<DatabaseLease>,
    pub root: PathBuf,
    pub fresh: bool,
    pub binding: Option<DeviceBinding>,
    pub sync_checkpoint: crate::durable_checkpoint::DurableCheckpoint,
}

struct DatabaseLease {
    task: Option<tokio::task::JoinHandle<()>>,
    backend: Arc<Backend>,
}
impl DatabaseLease {
    fn start(backend: Arc<Backend>) -> Self {
        let active = backend.clone();
        let task = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(std::time::Duration::from_secs(10));
            loop {
                ticks.tick().await;
                if active.renew().await.is_err() {
                    break;
                }
            }
        });
        Self {
            task: Some(task),
            backend,
        }
    }

    async fn shutdown(&mut self) -> Result<(), StoreError> {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        self.backend.close().await.map_err(mysql_error)
    }
}
impl Drop for DatabaseLease {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let backend = self.backend.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = backend.close().await;
                });
            }
        }
    }
}

impl OpenStore {
    /// Release the database writer lease before a failed initialization exits.
    /// Drop remains a best-effort fallback for unexpected process teardown.
    pub async fn shutdown(&mut self) -> Result<(), StoreError> {
        if let Some(mut lease) = self._lease.take() {
            lease.shutdown().await
        } else {
            Ok(())
        }
    }
}

/// Stable namespace coordinates bind this application room and exact device.
/// No additional owner secret or randomly regenerated environment ID is needed.
pub type MysqlCoordinates = ([u8; 16], Vec<u8>, [u8; 32]);

pub fn mysql_coordinates(config: &Config) -> Result<MysqlCoordinates, StoreError> {
    let identity = serde_json::to_vec(&(
        "personal-consultant-matrix-v1",
        config.homeserver.origin(),
        &config.room_id,
        &config.bot_mxid,
        &config.bot_device_id,
    ))
    .map_err(|_| StoreError::Quarantined)?;
    let digest = Sha256::digest(&identity);
    let mut id = [0; 16];
    id.copy_from_slice(&digest[..16]);
    let key: [u8; 32] = hex::decode(config.store_passphrase.as_str())
        .map_err(|_| StoreError::Quarantined)?
        .try_into()
        .map_err(|_| StoreError::Quarantined)?;
    Ok((id, identity, key))
}

async fn open_mysql(config: &Config, setup_preflight: bool) -> Result<OpenStore, StoreError> {
    if config.provision_fresh && !setup_preflight {
        return Err(StoreError::Quarantined);
    }
    let db = DatabaseConfig::from_env().map_err(mysql_error)?;
    let pool = db.connect().await.map_err(mysql_error)?;
    let (id, identity, key) = mysql_coordinates(config)?;
    if config.provision_fresh {
        // Explicit setup only. Never overwrite an existing namespace or a
        // device with published keys, including a previous failed attempt.
        crate::setup::verify_session_binding_with_identity(config, None).await?;
        Backend::provision_schema(&pool)
            .await
            .map_err(mysql_error)?;
        Backend::provision(&pool, id, &identity, &key)
            .await
            .map_err(mysql_error)?;
    }
    let opened = if setup_preflight {
        Backend::open(pool.clone(), id, &identity, &key, 30_000).await
    } else {
        Backend::open_for_deployment(
            pool.clone(),
            id,
            &identity,
            &key,
            30_000,
            config
                .deployment_generation
                .ok_or(StoreError::Quarantined)?,
        )
        .await
    };
    pool.close().await;
    let backend = Arc::new(opened.map_err(mysql_error)?);
    let mut lease = DatabaseLease::start(backend.clone());
    let initialized = async {
        // A partially imported namespace is never a runnable store.
        if !config.provision_fresh
            && backend
                .get("app.meta", b"activation")
                .await
                .map_err(mysql_error)?
                .as_deref()
                != Some(b"ready")
        {
            return Err(StoreError::Quarantined);
        }
        let binding: Option<DeviceBinding> = if config.provision_fresh {
            None
        } else {
            Some(
                serde_json::from_slice(
                    &backend
                        .get("app.meta", b"device-binding")
                        .await
                        .map_err(mysql_error)?
                        .ok_or(StoreError::Quarantined)?,
                )
                .map_err(|_| StoreError::Quarantined)?,
            )
        };
        if binding
            .as_ref()
            .is_some_and(|b| b.device_id != config.bot_device_id)
        {
            return Err(StoreError::Quarantined);
        }
        let crypto = MySqlCryptoStore::new(backend.clone());
        if let Some(binding) = &binding {
            let account = crypto
                .load_account()
                .await
                .map_err(mysql_error)?
                .ok_or(StoreError::Quarantined)?;
            if account.user_id().as_str() != config.bot_mxid
                || account.device_id().as_str() != config.bot_device_id
            {
                return Err(StoreError::Quarantined);
            }
            let fingerprint = hex::encode(Sha256::digest(
                account.identity_keys().ed25519.to_base64().as_bytes(),
            ));
            validate_bound_identity(binding, Some(&fingerprint))?;
            if setup_preflight {
                crate::setup::verify_session_binding_with_identity(config, Some(&fingerprint))
                    .await?;
            }
        }
        let checkpoint = if config.provision_fresh {
            crate::durable_checkpoint::DurableCheckpoint::initialize_mysql(
                backend.clone(),
                None,
                None,
            )
            .await
        } else {
            crate::durable_checkpoint::DurableCheckpoint::open_mysql(backend.clone()).await
        }
        .map_err(checkpoint_error)?;
        let http_client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| StoreError::Open)?;
        let stores = matrix_sdk::config::StoreConfig::new(
            matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::SingleProcess,
        )
        .crypto_store(crypto)
        .state_store(MySqlStateStore::new(backend.clone()));
        // The backend fence governs the single writer; disposable SDK caches use
        // StoreConfig's memory implementations, not another private SQLite file.
        let client = private_client_builder()
            .homeserver_url(config.homeserver.as_url().as_str())
            .http_client(http_client.clone())
            .respect_login_well_known(false)
            .store_config(stores)
            .build()
            .await
            .map_err(|_| StoreError::Open)?;
        client
            .restore_session(MatrixSession {
                meta: SessionMeta {
                    user_id: config
                        .bot_mxid
                        .parse()
                        .map_err(|_| StoreError::Quarantined)?,
                    device_id: config.bot_device_id.clone().into(),
                },
                tokens: SessionTokens {
                    access_token: config.access_token.to_string(),
                    refresh_token: None,
                },
            })
            .await
            .map_err(restore_mysql_session_error)?;
        let binding = if config.provision_fresh {
            let account = MySqlCryptoStore::new(backend.clone())
                .load_account()
                .await
                .map_err(mysql_error)?
                .ok_or(StoreError::Quarantined)?;
            if account.user_id().as_str() != config.bot_mxid
                || account.device_id().as_str() != config.bot_device_id
            {
                return Err(StoreError::Quarantined);
            }
            let fingerprint: [u8; 32] =
                Sha256::digest(account.identity_keys().ed25519.to_base64().as_bytes()).into();
            let binding = DeviceBinding {
                device_id: config.bot_device_id.clone(),
                store_fingerprint: hex::encode(fingerprint),
            };
            backend
                .activate_candidate(
                    &serde_json::to_vec(&binding).map_err(|_| StoreError::Quarantined)?,
                    fingerprint,
                    br#"{"version":1,"operation":"explicit-fresh-device"}"#,
                )
                .await
                .map_err(mysql_error)?;
            Some(binding)
        } else {
            binding
        };
        Ok::<_, StoreError>((client, http_client, binding, checkpoint))
    }
    .await;
    let (client, http_client, binding, checkpoint) = match initialized {
        Ok(initialized) => initialized,
        Err(error) => {
            lease.shutdown().await?;
            return Err(error);
        }
    };
    Ok(OpenStore {
        client,
        http_client,
        lock: None,
        mysql: Some(backend),
        _lease: Some(lease),
        root: config.store_root.clone(),
        fresh: config.provision_fresh,
        binding,
        sync_checkpoint: checkpoint,
    })
}

fn private_client_builder() -> matrix_sdk::ClientBuilder {
    Client::builder()
        // Inbound cross-signing requirements do not constrain outbound key
        // sharing: the SDK otherwise defaults to AllDevices. Keep the
        // recipient restriction explicit alongside the existing trust policy.
        .with_room_key_recipient_strategy(CollectStrategy::OnlyTrustedDevices)
        .with_enable_share_history_on_invite(false)
        .with_decryption_settings(DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::CrossSigned,
        })
}

pub async fn open(config: &Config) -> Result<OpenStore, StoreError> {
    open_internal(config, false).await
}

/// Setup must establish that the supplied token owns the configured device and
/// may never replace encryption keys belonging to an existing Element session.
pub async fn open_for_setup(config: &Config) -> Result<OpenStore, StoreError> {
    open_internal(config, true).await
}

async fn open_internal(config: &Config, setup_preflight: bool) -> Result<OpenStore, StoreError> {
    if config.mysql {
        return open_mysql(config, setup_preflight).await;
    }
    if !config.store_root.exists() {
        return Err(StoreError::Quarantined);
    }
    let lock = StoreLock::acquire(&config.store_root).map_err(|error| match error {
        LockError::Contended => StoreError::LockContended,
        LockError::UnsafeRoot | LockError::Io => StoreError::Quarantined,
    })?;
    if setup_preflight {
        crate::setup::verify_session_binding(config).await?;
    }
    let scenario = validate_scenario(config)?;
    if scenario.fresh {
        let bootstrap_state =
            SqliteStateStore::open(&config.store_root, Some(config.store_passphrase.as_str()))
                .await
                .map_err(|_| StoreError::Quarantined)?;
        drop(bootstrap_state);
        secure_fresh_store_files(&config.store_root)?;
    }
    let sync_checkpoint = crate::sync_checkpoint::SyncCheckpoint::open(
        &config.store_root,
        config.store_passphrase.as_str(),
    )
    .map_err(|_| StoreError::Quarantined)?;
    sync_checkpoint
        .recover_before_client(config.store_passphrase.as_str())
        .await
        .map_err(|_| StoreError::Quarantined)?;
    sync_checkpoint
        .initialize_cursor(config.store_passphrase.as_str())
        .await
        .map_err(|_| StoreError::Quarantined)?;
    if !scenario.fresh {
        let binding = scenario.binding.as_ref().ok_or(StoreError::Quarantined)?;
        let identity = durable_account_identity(config).await?;
        validate_bound_identity(binding, Some(&identity))?;
    }
    let http_client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| StoreError::Open)?;
    let client = private_client_builder()
        .homeserver_url(config.homeserver.as_url().as_str())
        .http_client(http_client.clone())
        .respect_login_well_known(false)
        .sqlite_store(&config.store_root, Some(config.store_passphrase.as_str()))
        .build()
        .await
        .map_err(|_| StoreError::Open)?;
    if scenario.fresh {
        secure_fresh_store_files(&config.store_root)?;
    }
    let user_id: OwnedUserId = config
        .bot_mxid
        .parse()
        .map_err(|_| StoreError::Quarantined)?;
    let device_id: OwnedDeviceId = config.bot_device_id.clone().into();
    client
        .restore_session(MatrixSession {
            meta: SessionMeta { user_id, device_id },
            tokens: SessionTokens {
                access_token: config.access_token.to_string(),
                refresh_token: None,
            },
        })
        .await
        .map_err(|_| StoreError::Quarantined)?;
    let binding = if scenario.fresh {
        secure_fresh_store_files(&config.store_root)?;
        let identity = durable_account_identity(config).await?;
        let binding = write_binding_once(&config.store_root, &config.bot_device_id, &identity)?;
        remove_provisioning_intent(&config.store_root)?;
        Some(binding)
    } else {
        if scenario.complete_provisioning {
            remove_provisioning_intent(&config.store_root)?;
        }
        scenario.binding
    };
    Ok(OpenStore {
        client,
        http_client,
        lock: Some(lock),
        mysql: None,
        _lease: None,
        root: config.store_root.clone(),
        fresh: scenario.fresh,
        binding,
        sync_checkpoint: crate::durable_checkpoint::DurableCheckpoint::Legacy(sync_checkpoint),
    })
}

struct StoreScenario {
    fresh: bool,
    binding: Option<DeviceBinding>,
    complete_provisioning: bool,
}

fn validate_scenario(config: &Config) -> Result<StoreScenario, StoreError> {
    if config.provision_fresh {
        cleanup_resumable_atomic_temps(config)?;
    }
    let entries = fs::read_dir(&config.store_root)
        .map_err(|_| StoreError::Quarantined)?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|_| StoreError::Quarantined)
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|name| name != LOCK_FILE)
        .collect::<Vec<_>>();
    if config.provision_fresh {
        if entries.is_empty() {
            write_provisioning_intent(config)?;
            return Ok(StoreScenario {
                fresh: true,
                binding: None,
                complete_provisioning: false,
            });
        }
        if resumable_provisioning(config, &entries)? {
            if entries.iter().any(|entry| entry == BINDING_FILE) {
                let binding = load_restore_binding(config)?;
                return Ok(StoreScenario {
                    fresh: false,
                    binding: Some(binding),
                    complete_provisioning: true,
                });
            }
            return Ok(StoreScenario {
                fresh: true,
                binding: None,
                complete_provisioning: false,
            });
        }
        if entries.iter().any(|entry| entry == BINDING_FILE)
            && completed_provisioning_snapshot(&config.store_root, &entries)
        {
            return Ok(StoreScenario {
                fresh: false,
                binding: Some(load_restore_binding(config)?),
                complete_provisioning: false,
            });
        }
        return Err(StoreError::Quarantined);
    }
    let binding = load_restore_binding(config)?;
    Ok(StoreScenario {
        fresh: false,
        binding: Some(binding),
        complete_provisioning: false,
    })
}

fn cleanup_resumable_atomic_temps(config: &Config) -> Result<(), StoreError> {
    let entries = fs::read_dir(&config.store_root)
        .map_err(|_| StoreError::Quarantined)?
        .map(|entry| entry.map_err(|_| StoreError::Quarantined))
        .collect::<Result<Vec<_>, _>>()?;
    let temp_entries = entries
        .iter()
        .filter(|entry| entry.file_name().to_str().is_some_and(is_atomic_temp_name))
        .collect::<Vec<_>>();
    if temp_entries.is_empty() {
        return Ok(());
    }
    if !temp_entries
        .iter()
        .all(|entry| safe_owned_regular_file(&entry.path()))
    {
        return Err(StoreError::Quarantined);
    }
    let durable = entries
        .iter()
        .filter(|entry| {
            entry.file_name() != LOCK_FILE
                && !entry.file_name().to_str().is_some_and(is_atomic_temp_name)
        })
        .map(|entry| entry.file_name())
        .collect::<Vec<_>>();
    let resumable = durable.iter().any(|entry| entry == PROVISIONING_FILE)
        && resumable_provisioning(config, &durable)?;
    let completed = durable.iter().any(|entry| entry == BINDING_FILE)
        && completed_provisioning_snapshot(&config.store_root, &durable);
    if !durable.is_empty() && !resumable && !completed {
        return Err(StoreError::Quarantined);
    }
    crate::lock::cleanup_atomic_temps(&config.store_root, |target| {
        matches!(
            target,
            PROVISIONING_FILE | BINDING_FILE | "sync-token-cursor" | "sync-token-checkpoint"
        )
    })
    .map_err(|_| StoreError::Quarantined)
}

fn load_restore_binding(config: &Config) -> Result<DeviceBinding, StoreError> {
    let binding_path = config.store_root.join(BINDING_FILE);
    verify_private_path(&binding_path).map_err(|_| StoreError::Quarantined)?;
    let binding_bytes =
        read_private_file(&binding_path, 4 * 1024).map_err(|_| StoreError::Quarantined)?;
    let binding: DeviceBinding =
        serde_json::from_slice(&binding_bytes).map_err(|_| StoreError::Quarantined)?;
    if binding.device_id != config.bot_device_id
        || binding.store_fingerprint.len() != 64
        || !binding
            .store_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StoreError::Quarantined);
    }
    for database in ["matrix-sdk-state.sqlite3", "matrix-sdk-crypto.sqlite3"] {
        let path = config.store_root.join(database);
        let metadata = fs::symlink_metadata(&path).map_err(|_| StoreError::Quarantined)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
            return Err(StoreError::Quarantined);
        }
        verify_private_path(&path).map_err(|_| StoreError::Quarantined)?;
    }
    Ok(binding)
}

fn write_provisioning_intent(config: &Config) -> Result<(), StoreError> {
    let intent = ProvisioningIntent {
        bot_mxid: config.bot_mxid.clone(),
        device_id: config.bot_device_id.clone(),
        nonce: uuid::Uuid::new_v4().simple().to_string(),
    };
    let bytes = serde_json::to_vec(&intent).map_err(|_| StoreError::Open)?;
    let path = config.store_root.join(PROVISIONING_FILE);
    atomic_create_private(&path, &bytes).map_err(|_| StoreError::Open)
}

fn resumable_provisioning(
    config: &Config,
    entries: &[std::ffi::OsString],
) -> Result<bool, StoreError> {
    let allowed = [
        PROVISIONING_FILE,
        BINDING_FILE,
        "sync-token-cursor",
        "matrix-sdk-state.sqlite3",
        "matrix-sdk-state.sqlite3-wal",
        "matrix-sdk-state.sqlite3-shm",
        "matrix-sdk-crypto.sqlite3",
        "matrix-sdk-crypto.sqlite3-wal",
        "matrix-sdk-crypto.sqlite3-shm",
        "matrix-sdk-event-cache.sqlite3",
        "matrix-sdk-event-cache.sqlite3-wal",
        "matrix-sdk-event-cache.sqlite3-shm",
    ];
    if !entries.iter().any(|entry| entry == PROVISIONING_FILE) {
        return Ok(false);
    }
    if !entries
        .iter()
        .all(|entry| allowed.iter().any(|allowed| entry == allowed))
    {
        return Ok(false);
    }
    if !entries
        .iter()
        .all(|entry| safe_owned_regular_file(&config.store_root.join(entry)))
    {
        return Ok(false);
    }
    let path = config.store_root.join(PROVISIONING_FILE);
    let bytes = read_private_file(&path, 4 * 1024).map_err(|_| StoreError::Quarantined)?;
    let intent: ProvisioningIntent =
        serde_json::from_slice(&bytes).map_err(|_| StoreError::Quarantined)?;
    Ok(intent.bot_mxid == config.bot_mxid
        && intent.device_id == config.bot_device_id
        && intent.nonce.len() == 32
        && intent
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

/// Read-only recognition of the precise crash window before an account and
/// binding have both been saved. Merely passing --provision-fresh is not proof:
/// the preexisting private intent must match this user/device and every entry
/// must belong to the already-supported provisioning snapshot allowlist.
pub(crate) fn incomplete_provisioning_is_resumable(config: &Config) -> Result<bool, StoreError> {
    if !config.provision_fresh {
        return Ok(false);
    }
    let entries = fs::read_dir(&config.store_root)
        .map_err(|_| StoreError::Quarantined)?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|_| StoreError::Quarantined)
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|name| name != LOCK_FILE)
        .collect::<Vec<_>>();
    if entries.iter().any(|name| name == BINDING_FILE) || !resumable_provisioning(config, &entries)?
    {
        return Ok(false);
    }
    for entry in entries {
        verify_private_path(&config.store_root.join(entry)).map_err(|_| StoreError::Quarantined)?;
    }
    Ok(true)
}

#[cfg(unix)]
fn safe_owned_regular_file(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == rustix::process::geteuid().as_raw()
    })
}

#[cfg(not(unix))]
fn safe_owned_regular_file(_path: &Path) -> bool {
    false
}

fn completed_provisioning_snapshot(root: &Path, entries: &[std::ffi::OsString]) -> bool {
    let allowed = [
        BINDING_FILE,
        "sync-token-cursor",
        "matrix-sdk-state.sqlite3",
        "matrix-sdk-state.sqlite3-wal",
        "matrix-sdk-state.sqlite3-shm",
        "matrix-sdk-crypto.sqlite3",
        "matrix-sdk-crypto.sqlite3-wal",
        "matrix-sdk-crypto.sqlite3-shm",
        "matrix-sdk-event-cache.sqlite3",
        "matrix-sdk-event-cache.sqlite3-wal",
        "matrix-sdk-event-cache.sqlite3-shm",
    ];
    [
        BINDING_FILE,
        "matrix-sdk-state.sqlite3",
        "matrix-sdk-crypto.sqlite3",
    ]
    .into_iter()
    .all(|required| entries.iter().any(|entry| entry == required))
        && entries.iter().all(|entry| {
            allowed.iter().any(|allowed| entry == allowed)
                && safe_owned_regular_file(&root.join(entry))
        })
}

fn remove_provisioning_intent(root: &Path) -> Result<(), StoreError> {
    let path = root.join(PROVISIONING_FILE);
    verify_private_path(&path).map_err(|_| StoreError::Quarantined)?;
    fs::remove_file(path).map_err(|_| StoreError::Open)?;
    sync_directory(root)
}

fn sync_directory(root: &Path) -> Result<(), StoreError> {
    fs::File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| StoreError::Open)
}

pub fn write_binding_once(
    root: &Path,
    device_id: &str,
    own_ed25519_sha256: &str,
) -> Result<DeviceBinding, StoreError> {
    if device_id.is_empty() || !device_id.is_ascii() || !valid_lower_sha256(own_ed25519_sha256) {
        return Err(StoreError::Quarantined);
    }
    let binding = DeviceBinding {
        device_id: device_id.into(),
        store_fingerprint: own_ed25519_sha256.into(),
    };
    let bytes = serde_json::to_vec(&binding).map_err(|_| StoreError::Open)?;
    let path = root.join(BINDING_FILE);
    atomic_create_private(&path, &bytes).map_err(|_| StoreError::Open)?;
    Ok(binding)
}

pub async fn durable_account_identity(config: &Config) -> Result<String, StoreError> {
    durable_account_identity_if_present(config)
        .await?
        .ok_or(StoreError::Quarantined)
}

pub(crate) async fn setup_account_identity(config: &Config) -> Result<Option<String>, StoreError> {
    // Inspect the unchanged snapshot before opening SQLite. An actual load or
    // decryption error is always an error, never interpreted as an absent key.
    let incomplete = incomplete_provisioning_is_resumable(config)?;
    let identity = durable_account_identity_if_present(config).await?;
    if identity.is_none() && !incomplete {
        return Err(StoreError::Quarantined);
    }
    Ok(identity)
}

async fn durable_account_identity_if_present(
    config: &Config,
) -> Result<Option<String>, StoreError> {
    let crypto_store =
        SqliteCryptoStore::open(&config.store_root, Some(config.store_passphrase.as_str()))
            .await
            .map_err(|_| StoreError::Quarantined)?;
    let account = crypto_store
        .load_account()
        .await
        .map_err(|_| StoreError::Quarantined);
    // Pool drops may drain on background tasks. Wait for that drain before
    // callers inspect the exact on-disk scenario, otherwise WAL/SHM entries
    // can disappear between the directory inventory and no-follow checks.
    crypto_store
        .close()
        .await
        .map_err(|_| StoreError::Quarantined)?;
    let account = account?;
    let Some(account) = account else {
        return Ok(None);
    };
    if account.user_id().as_str() != config.bot_mxid
        || account.device_id().as_str() != config.bot_device_id
    {
        return Err(StoreError::Quarantined);
    }
    Ok(Some(hex::encode(Sha256::digest(
        account.identity_keys().ed25519.to_base64().as_bytes(),
    ))))
}

fn validate_bound_identity(
    binding: &DeviceBinding,
    durable_identity: Option<&str>,
) -> Result<(), StoreError> {
    let durable_identity = durable_identity.ok_or(StoreError::Quarantined)?;
    if !valid_lower_sha256(durable_identity) || binding.store_fingerprint != durable_identity {
        return Err(StoreError::Quarantined);
    }
    Ok(())
}

fn valid_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn secure_fresh_store_files(root: &Path) -> Result<(), StoreError> {
    for name in [
        "matrix-sdk-state.sqlite3",
        "matrix-sdk-state.sqlite3-wal",
        "matrix-sdk-state.sqlite3-shm",
        "matrix-sdk-crypto.sqlite3",
        "matrix-sdk-crypto.sqlite3-wal",
        "matrix-sdk-crypto.sqlite3-shm",
        "matrix-sdk-event-cache.sqlite3",
        "matrix-sdk-event-cache.sqlite3-wal",
        "matrix-sdk-event-cache.sqlite3-shm",
    ] {
        let path = root.join(name);
        if !path.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(|_| StoreError::Quarantined)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(StoreError::Quarantined);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|_| StoreError::Open)?;
        }
        verify_private_path(&path).map_err(|_| StoreError::Open)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_startup_errors_preserve_recovery_and_quarantine_boundaries() {
        use personal_consultant_matrix_mysql_store::StoreError as Db;
        for error in [Db::Unavailable, Db::Fenced, Db::Closed] {
            assert!(matches!(
                mysql_error(error),
                StoreError::RetryWithNewInstance
            ));
        }
        assert!(matches!(
            mysql_error(Db::Conflict),
            StoreError::LockContended
        ));
        for error in [Db::Corrupt, Db::InvalidConfiguration, Db::Schema] {
            assert!(matches!(mysql_error(error), StoreError::Quarantined));
        }
    }

    #[test]
    fn sdk_and_checkpoint_wrappers_do_not_hide_database_failure_classes() {
        use personal_consultant_matrix_mysql_store::StoreError as Db;
        assert!(matches!(
            crypto_error(Db::Unavailable.into()),
            StoreError::RetryWithNewInstance
        ));
        assert!(matches!(
            crypto_error(Db::Corrupt.into()),
            StoreError::Quarantined
        ));
        assert!(matches!(
            state_error(Db::Fenced.into()),
            StoreError::RetryWithNewInstance
        ));
        assert!(matches!(
            state_error(Db::Schema.into()),
            StoreError::Quarantined
        ));
        assert!(matches!(
            checkpoint_error(crate::durable_checkpoint::CheckpointError::Database(
                Db::Closed
            )),
            StoreError::RetryWithNewInstance
        ));
        assert!(matches!(
            checkpoint_error(crate::durable_checkpoint::CheckpointError::Invalid),
            StoreError::Quarantined
        ));
        assert!(matches!(
            restore_mysql_session_error(matrix_sdk::Error::CryptoStoreError(Box::new(
                Db::Unavailable.into()
            ))),
            StoreError::RetryWithNewInstance
        ));
        assert!(matches!(
            restore_mysql_session_error(matrix_sdk::Error::StateStore(Box::new(
                Db::Corrupt.into()
            ))),
            StoreError::Quarantined
        ));
        // Error messages, even plausible database messages, grant no retry class.
        assert!(matches!(
            crypto_error(matrix_sdk_base::crypto::store::CryptoStoreError::Backend(
                Box::new(std::io::Error::other("Matrix database unavailable"))
            )),
            StoreError::Quarantined
        ));
    }
    use crate::config::FixedHomeserver;
    use std::io::Write;
    use zeroize::Zeroizing;

    const IDENTITY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const IDENTITY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn production_builder_restricts_outbound_keys_to_trusted_devices() {
        // Inspect the real pinned SDK builder before adding any credentials.
        // Its private field has no public accessor, but its derived Debug
        // output exposes the configured strategy without building a client.
        let sdk_default = format!("{:?}", Client::builder());
        assert!(sdk_default.contains("room_key_recipient_strategy: AllDevices"));
        let production = format!("{:?}", private_client_builder());
        assert!(production.contains("room_key_recipient_strategy: OnlyTrustedDevices"));
        assert!(production.contains("sender_device_trust_requirement: CrossSigned"));
        assert!(production.contains("enable_share_history_on_invite: false"));
    }

    #[cfg(unix)]
    fn make_private(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(not(unix))]
    fn make_private(_path: &Path) {}

    fn config(root: PathBuf, device: &str) -> Config {
        if root.exists() {
            make_private(&root);
        }
        Config {
            mysql: false,
            deployment_generation: None,
            homeserver: FixedHomeserver::parse("https://matrix.example").unwrap(),
            store_root: root.clone(),
            spool_parent: root.join("spool"),
            store_passphrase: Zeroizing::new("a".repeat(64)),
            access_token: Zeroizing::new("test-only".into()),
            room_id: "!room:example".into(),
            owner_mxid: "@owner:example".into(),
            bot_mxid: "@bot:example".into(),
            bot_device_id: device.into(),
            allowed_origins: vec![FixedHomeserver::parse("https://matrix.example").unwrap()],
            provision_fresh: false,
        }
    }

    #[cfg(unix)]
    fn write_private(path: &Path, bytes: &[u8]) {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        options.open(path).unwrap().write_all(bytes).unwrap();
    }

    #[test]
    fn fresh_requires_exact_empty_store_and_restore_requires_exact_binding() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("fresh");
        fs::create_dir(&root).unwrap();
        assert!(validate_scenario(&config(root.clone(), "DEVICE")).is_err());
        let mut fresh_config = config(root.clone(), "DEVICE");
        fresh_config.provision_fresh = true;
        assert!(validate_scenario(&fresh_config).unwrap().fresh);
        fs::write(root.join("unknown"), b"state").unwrap();
        assert!(validate_scenario(&config(root, "DEVICE")).is_err());

        let restore = temp.path().join("restore");
        fs::create_dir(&restore).unwrap();
        make_private(&restore);
        write_binding_once(&restore, "DEVICE", IDENTITY_A).unwrap();
        write_private(&restore.join("matrix-sdk-state.sqlite3"), b"state");
        write_private(&restore.join("matrix-sdk-crypto.sqlite3"), b"crypto");
        let scenario = validate_scenario(&config(restore.clone(), "DEVICE")).unwrap();
        assert!(!scenario.fresh);
        assert_eq!(scenario.binding.unwrap().device_id, "DEVICE");
        assert!(validate_scenario(&config(restore, "OTHER")).is_err());
    }

    #[tokio::test]
    async fn mysql_fresh_is_rejected_by_normal_runtime_before_database_or_network() {
        let temp = tempfile::tempdir().unwrap();
        let mut c = config(temp.path().to_owned(), "NEW_DEVICE");
        c.mysql = true;
        c.provision_fresh = true;
        assert!(matches!(
            open_mysql(&c, false).await,
            Err(StoreError::Quarantined)
        ));
    }

    #[test]
    fn mysql_namespace_matches_node_utf8_tuple() {
        let temp = tempfile::tempdir().unwrap();
        let mut c = config(temp.path().to_owned(), "BOT_DEVICE_1");
        c.homeserver = FixedHomeserver::parse("https://matrix.org").unwrap();
        c.room_id = "!private-room:matrix.org".into();
        c.bot_mxid = "@consultant-bot:matrix.org".into();
        assert_eq!(
            hex::encode(mysql_coordinates(&c).unwrap().0),
            "bffc6137918f06551a73123b566c15ef"
        );
    }

    #[test]
    fn explicit_fresh_resume_accepts_only_its_exact_crash_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("resume");
        fs::create_dir(&root).unwrap();
        let mut fresh = config(root.clone(), "DEVICE");
        fresh.provision_fresh = true;
        assert!(validate_scenario(&fresh).unwrap().fresh);
        write_private(&root.join("matrix-sdk-state.sqlite3"), b"state");
        write_private(&root.join("matrix-sdk-crypto.sqlite3"), b"crypto");
        write_private(&root.join("sync-token-cursor"), b"encrypted-cursor");
        assert!(validate_scenario(&fresh).unwrap().fresh);

        write_binding_once(&root, "DEVICE", IDENTITY_A).unwrap();
        let completion = validate_scenario(&fresh).unwrap();
        assert!(!completion.fresh);
        assert!(completion.complete_provisioning);
        assert_eq!(completion.binding.unwrap().store_fingerprint, IDENTITY_A);

        let changed_device = config(root.clone(), "OTHER");
        let mut changed_fresh = changed_device;
        changed_fresh.provision_fresh = true;
        assert!(validate_scenario(&changed_fresh).is_err());
        fs::write(root.join("unexpected"), b"state").unwrap();
        assert!(validate_scenario(&fresh).is_err());
    }

    #[test]
    fn missing_account_resume_requires_an_existing_exact_private_intent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("account-not-written");
        fs::create_dir(&root).unwrap();
        let mut fresh = config(root.clone(), "DEVICE");
        fresh.provision_fresh = true;
        assert!(!incomplete_provisioning_is_resumable(&fresh).unwrap());
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            0,
            "read-only check created state"
        );
        assert!(validate_scenario(&fresh).unwrap().fresh);
        let before = fs::read(root.join(PROVISIONING_FILE)).unwrap();
        assert!(incomplete_provisioning_is_resumable(&fresh).unwrap());
        assert_eq!(fs::read(root.join(PROVISIONING_FILE)).unwrap(), before);
        fresh.provision_fresh = false;
        assert!(!incomplete_provisioning_is_resumable(&fresh).unwrap());
        fresh.provision_fresh = true;
        fresh.bot_device_id = "DIFFERENT".into();
        assert!(!incomplete_provisioning_is_resumable(&fresh).unwrap());
        fresh.bot_device_id = "DEVICE".into();
        write_private(&root.join("unexpected-state"), b"preserve me");
        assert!(!incomplete_provisioning_is_resumable(&fresh).unwrap());
        assert_eq!(
            fs::read(root.join("unexpected-state")).unwrap(),
            b"preserve me"
        );
    }

    #[cfg(unix)]
    #[test]
    fn missing_account_resume_rejects_binding_and_unsafe_intent() {
        use std::os::unix::fs::PermissionsExt;
        for case in ["binding", "mode", "symlink"] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join(case);
            fs::create_dir(&root).unwrap();
            let mut fresh = config(root.clone(), "DEVICE");
            fresh.provision_fresh = true;
            assert!(validate_scenario(&fresh).unwrap().fresh);
            match case {
                "binding" => {
                    write_binding_once(&root, "DEVICE", IDENTITY_A).unwrap();
                }
                "mode" => fs::set_permissions(
                    root.join(PROVISIONING_FILE),
                    fs::Permissions::from_mode(0o644),
                )
                .unwrap(),
                _ => std::os::unix::fs::symlink(
                    temp.path().join("outside"),
                    root.join("matrix-sdk-crypto.sqlite3"),
                )
                .unwrap(),
            }
            assert!(!incomplete_provisioning_is_resumable(&fresh).unwrap_or(false));
        }
    }

    #[tokio::test]
    async fn interrupted_empty_crypto_database_is_not_confused_with_wrong_key_or_lost_account() {
        use matrix_sdk_base::crypto::{olm::Account, store::types::PendingChanges};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("crypto-before-account");
        fs::create_dir(&root).unwrap();
        let mut fresh = config(root.clone(), "DEVICE");
        fresh.provision_fresh = true;
        assert!(validate_scenario(&fresh).unwrap().fresh);
        let fixture_crypto = SqliteCryptoStore::open(&root, Some(fresh.store_passphrase.as_str()))
            .await
            .unwrap();
        secure_fresh_store_files(&root).unwrap();
        assert!(
            incomplete_provisioning_is_resumable(&fresh).unwrap(),
            "snapshot must be recognized: {:?}",
            fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>()
        );
        assert!(
            durable_account_identity_if_present(&fresh)
                .await
                .unwrap()
                .is_none(),
            "successful empty account load"
        );
        assert!(setup_account_identity(&fresh).await.unwrap().is_none());
        assert!(
            durable_account_identity(&fresh).await.is_err(),
            "normal restore must remain strict"
        );
        fresh.provision_fresh = false;
        assert!(setup_account_identity(&fresh).await.is_err());
        fresh.provision_fresh = true;
        fresh.store_passphrase = Zeroizing::new("b".repeat(64));
        assert!(
            setup_account_identity(&fresh).await.is_err(),
            "wrong key must not look like an empty account"
        );
        fresh.store_passphrase = Zeroizing::new("a".repeat(64));
        assert!(setup_account_identity(&fresh).await.unwrap().is_none());
        let user: OwnedUserId = fresh.bot_mxid.parse().unwrap();
        let account = Account::with_device_id(&user, fresh.bot_device_id.as_str().into());
        let expected = hex::encode(Sha256::digest(
            account.identity_keys().ed25519.to_base64().as_bytes(),
        ));
        fixture_crypto
            .save_pending_changes(PendingChanges {
                account: Some(account),
            })
            .await
            .unwrap();
        assert_eq!(
            setup_account_identity(&fresh).await.unwrap(),
            Some(expected)
        );
        fresh.bot_device_id = "WRONG".into();
        assert!(
            setup_account_identity(&fresh).await.is_err(),
            "existing identity must never be regenerated"
        );
        fixture_crypto.close().await.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn explicit_fresh_resume_rejects_sdk_symlinks_before_open() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("resume-symlink");
        fs::create_dir(&root).unwrap();
        let mut fresh = config(root.clone(), "DEVICE");
        fresh.provision_fresh = true;
        assert!(validate_scenario(&fresh).unwrap().fresh);
        let target = temp.path().join("outside.sqlite3");
        write_private(&target, b"outside");
        std::os::unix::fs::symlink(target, root.join("matrix-sdk-state.sqlite3")).unwrap();
        assert!(validate_scenario(&fresh).is_err());
    }

    #[test]
    fn missing_store_is_never_implicit_fresh_provisioning() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("lost-store");
        let config = config(missing.clone(), "DEVICE");
        assert!(validate_scenario(&config).is_err());
        assert!(!missing.exists());
        let mut explicitly_fresh = config;
        explicitly_fresh.provision_fresh = true;
        assert!(validate_scenario(&explicitly_fresh).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn marker_without_exact_sqlite_snapshot_is_quarantined() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("marker-only");
        fs::create_dir(&root).unwrap();
        make_private(&root);
        write_binding_once(&root, "DEVICE", IDENTITY_A).unwrap();
        assert!(validate_scenario(&config(root, "DEVICE")).is_err());
    }

    #[test]
    fn binding_rejects_accountless_and_swapped_crypto_store_identity() {
        let temp = tempfile::tempdir().unwrap();
        make_private(temp.path());
        let binding = write_binding_once(temp.path(), "DEVICE", IDENTITY_A).unwrap();
        assert!(validate_bound_identity(&binding, None).is_err());
        assert!(validate_bound_identity(&binding, Some(IDENTITY_B)).is_err());
        assert!(validate_bound_identity(&binding, Some(IDENTITY_A)).is_ok());
    }

    #[test]
    fn copied_marker_cannot_validate_a_different_account_identity() {
        let source = DeviceBinding {
            device_id: "DEVICE".into(),
            store_fingerprint: IDENTITY_A.into(),
        };
        let copied_marker = serde_json::to_vec(&source).unwrap();
        let restored: DeviceBinding = serde_json::from_slice(&copied_marker).unwrap();
        assert!(validate_bound_identity(&restored, Some(IDENTITY_B)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn explicit_fresh_recovers_only_known_atomic_temps() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("torn-intent");
        fs::create_dir(&root).unwrap();
        make_private(&root);
        let torn_intent = root.join(format!(
            ".atomic-{PROVISIONING_FILE}-{}.tmp",
            "a".repeat(32)
        ));
        write_private(&torn_intent, b"partial");
        let mut fresh = config(root.clone(), "DEVICE");
        fresh.provision_fresh = true;
        assert!(validate_scenario(&fresh).unwrap().fresh);
        assert!(!torn_intent.exists());
        assert!(root.join(PROVISIONING_FILE).exists());

        write_private(
            &root.join(format!(".atomic-unrelated-{}.tmp", "b".repeat(32))),
            b"private",
        );
        assert!(validate_scenario(&fresh).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn completed_store_recovers_known_control_temp_without_reprovisioning() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("completed");
        fs::create_dir(&root).unwrap();
        make_private(&root);
        write_binding_once(&root, "DEVICE", IDENTITY_A).unwrap();
        write_private(&root.join("matrix-sdk-state.sqlite3"), b"state");
        write_private(&root.join("matrix-sdk-crypto.sqlite3"), b"crypto");
        let orphan = root.join(format!(".atomic-sync-token-cursor-{}.tmp", "c".repeat(32)));
        write_private(&orphan, b"torn-cursor");
        let mut fresh = config(root.clone(), "DEVICE");
        fresh.provision_fresh = true;
        cleanup_resumable_atomic_temps(&fresh).unwrap();
        assert!(!orphan.exists());
        let scenario = validate_scenario(&fresh).unwrap();
        assert!(!scenario.fresh);
        assert!(!scenario.complete_provisioning);
    }
}
