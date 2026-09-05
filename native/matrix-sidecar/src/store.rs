use std::fs;
#[cfg(test)]
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

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
}

pub struct OpenStore {
    pub client: Client,
    pub http_client: reqwest::Client,
    pub lock: StoreLock,
    pub root: PathBuf,
    pub fresh: bool,
    pub binding: Option<DeviceBinding>,
    pub sync_checkpoint: crate::sync_checkpoint::SyncCheckpoint,
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
    if !config.store_root.exists() {
        return Err(StoreError::Quarantined);
    }
    let lock = StoreLock::acquire(&config.store_root).map_err(|error| match error {
        LockError::Contended => StoreError::LockContended,
        LockError::UnsafeRoot | LockError::Io => StoreError::Quarantined,
    })?;
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
        lock,
        root: config.store_root.clone(),
        fresh: scenario.fresh,
        binding,
        sync_checkpoint,
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
    let crypto_store =
        SqliteCryptoStore::open(&config.store_root, Some(config.store_passphrase.as_str()))
            .await
            .map_err(|_| StoreError::Quarantined)?;
    let account = crypto_store
        .load_account()
        .await
        .map_err(|_| StoreError::Quarantined)?
        .ok_or(StoreError::Quarantined)?;
    if account.user_id().as_str() != config.bot_mxid
        || account.device_id().as_str() != config.bot_device_id
    {
        return Err(StoreError::Quarantined);
    }
    Ok(hex::encode(Sha256::digest(
        account.identity_keys().ed25519.to_base64().as_bytes(),
    )))
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
