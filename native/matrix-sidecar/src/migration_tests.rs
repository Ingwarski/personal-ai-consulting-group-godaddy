//! Whole-unit offline candidate migration, using genuine SDK SQLite + MySQL.
//! No real Matrix credentials, HTTP requests, Published state or implicit activation.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use matrix_sdk_base::{
    crypto::{
        Account, DeviceData,
        store::{
            CryptoStore,
            types::{Changes, DeviceChanges, PendingChanges},
        },
    },
    store::{StateStore, StateStoreDataKey, StateStoreDataValue},
};
use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore};
use personal_consultant_matrix_mysql_store::{
    Backend, DatabaseConfig, Mutation, StoreError, crypto::MySqlCryptoStore, state::MySqlStateStore,
};
use sha2::{Digest, Sha256};

use crate::{
    config::{Config, FixedHomeserver},
    durable_checkpoint::DurableCheckpoint,
    durable_ingress::DurableJournal,
    ingress::{IngressAck, IngressEvent, PendingJournal},
    lock::StoreLock,
    media_spool::{MediaKind, PrivateSpool},
    migration::{activate_candidate_from_source, activate_verified_candidate, import_candidate},
    store::{DeviceBinding, mysql_coordinates},
    sync_checkpoint::SyncCheckpoint,
};

fn private_temp() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    private_mode(directory.path(), 0o700);
    directory
}
fn private_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
}
fn copy_file(source: &Path, target: &Path) {
    std::fs::copy(source, target).unwrap();
    private_mode(target, 0o600);
}
fn copy_tree(source: &Path, target: &Path) {
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let from = entry.path();
        let to = target.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&from).unwrap();
        assert!(!metadata.file_type().is_symlink());
        if metadata.is_dir() {
            std::fs::create_dir(&to).unwrap();
            private_mode(&to, 0o700);
            copy_tree(&from, &to);
        } else {
            assert!(metadata.is_file());
            copy_file(&from, &to);
        }
    }
}
fn inventory(root: &Path) -> BTreeMap<PathBuf, ([u8; 32], u64)> {
    fn visit(root: &Path, current: &Path, result: &mut BTreeMap<PathBuf, ([u8; 32], u64)>) {
        for entry in std::fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert!(!metadata.file_type().is_symlink());
            if metadata.is_dir() {
                visit(root, &path, result);
            } else {
                let value = std::fs::read(&path).unwrap();
                result.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    (Sha256::digest(&value).into(), metadata.len()),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}

struct SourceFixture {
    _live: tempfile::TempDir,
    backup: tempfile::TempDir,
    media: tempfile::TempDir,
    config: Config,
    binding: DeviceBinding,
    account_fingerprint: [u8; 32],
    media_handle: String,
}

async fn source_fixture() -> SourceFixture {
    let live = private_temp();
    let backup = private_temp();
    let media = private_temp();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let room = format!("!migration{nonce}:matrix.org");
    let bot = format!("@migration_{nonce}:matrix.org");
    let device = format!("FIXTURE{nonce}");
    let key = "a".repeat(64);
    let user_id: matrix_sdk::ruma::OwnedUserId = bot.parse().unwrap();
    let device_id: matrix_sdk::ruma::OwnedDeviceId = device.clone().into();
    let account = Account::with_device_id(&user_id, &device_id);
    let fingerprint: [u8; 32] =
        Sha256::digest(account.identity_keys().ed25519.to_base64().as_bytes()).into();
    let crypto = SqliteCryptoStore::open(live.path(), Some(&key))
        .await
        .unwrap();
    crypto
        .save_pending_changes(PendingChanges {
            account: Some(account.deep_clone()),
        })
        .await
        .unwrap();
    crypto
        .save_changes(Changes {
            devices: DeviceChanges {
                new: vec![DeviceData::from_account(&account)],
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .unwrap();
    crypto.close().await.unwrap();
    drop(crypto);
    let state = SqliteStateStore::open(live.path(), Some(&key))
        .await
        .unwrap();
    state
        .set_kv_data(
            StateStoreDataKey::SyncToken,
            StateStoreDataValue::SyncToken("committed-before-crash".into()),
        )
        .await
        .unwrap();
    state
        .set_custom_value("довільний-ключ".as_bytes(), vec![0, 128, 255])
        .await
        .unwrap();
    drop(state);
    for entry in std::fs::read_dir(live.path()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            private_mode(&path, 0o600);
        }
    }
    let checkpoint = SyncCheckpoint::open(live.path(), &key).unwrap();
    checkpoint.initialize_cursor(&key).await.unwrap();
    checkpoint
        .commit_cursor(
            "committed-before-crash".into(),
            Some("$committed:matrix.org".into()),
        )
        .unwrap();
    checkpoint
        .begin(Some("committed-before-crash".into()))
        .unwrap();
    // SDK can save its newer token before app ingress ACK/cursor commit. This
    // standalone source backup deliberately exercises that exact recovery seam.
    let state = SqliteStateStore::open(live.path(), Some(&key))
        .await
        .unwrap();
    state
        .set_kv_data(
            StateStoreDataKey::SyncToken,
            StateStoreDataValue::SyncToken("sdk-ahead-of-journal".into()),
        )
        .await
        .unwrap();
    drop(state);
    let spool = PrivateSpool::create(media.path()).unwrap();
    let reference = spool
        .write(MediaKind::Pdf, b"%PDF-synthetic candidate import")
        .unwrap();
    let journal = PendingJournal::open(live.path(), &key).unwrap();
    let event = IngressEvent {
        event_id: "$pending:matrix.org".into(),
        room_id: room.clone(),
        sender_mxid: "@owner:matrix.org".into(),
        sender_device_id: "OWNER".into(),
        body: Some("Перевір цей документ 🦆".into()),
        reply_to_event_id: None,
        media: vec![reference.clone()],
    };
    journal.persist(event).unwrap();
    journal
        .persist(IngressEvent {
            event_id: "$already-acked:matrix.org".into(),
            room_id: room.clone(),
            sender_mxid: "@owner:matrix.org".into(),
            sender_device_id: "OWNER".into(),
            body: Some("Acknowledged fixture".into()),
            reply_to_event_id: None,
            media: Vec::new(),
        })
        .unwrap();
    journal
        .acknowledge(&IngressAck {
            event_id: "$already-acked:matrix.org".into(),
            durable_receipt_id: "synthetic-node-commit".into(),
        })
        .unwrap();
    let binding = DeviceBinding {
        device_id: device.clone(),
        store_fingerprint: hex::encode(fingerprint),
    };
    std::fs::write(
        live.path().join("device-binding.json"),
        serde_json::to_vec(&binding).unwrap(),
    )
    .unwrap();
    private_mode(&live.path().join("device-binding.json"), 0o600);
    drop(StoreLock::acquire(live.path()).unwrap());
    for name in ["matrix-sdk-crypto.sqlite3", "matrix-sdk-state.sqlite3"] {
        let connection = rusqlite::Connection::open(live.path().join(name)).unwrap();
        let target = backup.path().join(name);
        connection
            .execute("VACUUM INTO ?1", [target.to_str().unwrap()])
            .unwrap();
        drop(connection);
        private_mode(&target, 0o600);
    }
    for name in [
        "device-binding.json",
        "sidecar.lock",
        "sync-token-cursor",
        "sync-token-checkpoint",
    ] {
        copy_file(&live.path().join(name), &backup.path().join(name));
    }
    for name in [
        "pending-ingress",
        "rejected-ingress",
        "ingress-ack-tombstones",
    ] {
        let target = backup.path().join(name);
        std::fs::create_dir(&target).unwrap();
        private_mode(&target, 0o700);
        copy_tree(&live.path().join(name), &target);
    }
    assert!(!backup.path().join("matrix-sdk-state.sqlite3-wal").exists());
    assert!(!backup.path().join("matrix-sdk-crypto.sqlite3-wal").exists());
    let config = Config {
        mysql: true,
        homeserver: FixedHomeserver::parse("https://matrix.org").unwrap(),
        store_root: backup.path().to_owned(),
        spool_parent: media.path().to_owned(),
        store_passphrase: key.into(),
        access_token: "synthetic-never-sent".to_owned().into(),
        room_id: room,
        owner_mxid: "@owner:matrix.org".into(),
        bot_mxid: bot,
        bot_device_id: device,
        allowed_origins: vec![FixedHomeserver::parse("https://matrix.org").unwrap()],
        provision_fresh: false,
    };
    SourceFixture {
        _live: live,
        backup,
        media,
        config,
        binding,
        account_fingerprint: fingerprint,
        media_handle: reference.handle,
    }
}

#[tokio::test]
#[ignore = "requires isolated MySQL schema"]
async fn whole_candidate_migration_preserves_identity_recovery_media_and_explicit_activation() {
    let path = std::env::var("MATRIX_MYSQL_TEST_CONFIG").expect("Use isolated MySQL harness");
    let runtime: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let database = DatabaseConfig::from_env().unwrap();
    assert!(
        runtime["marker"] == "personal-consultant-synthetic-mysql-v1"
            && database.host == "127.0.0.1"
            && database.database.starts_with("pc_matrix_test_")
            && runtime["database"] == database.database
            && runtime["port"].as_u64() == Some(u64::from(database.port))
    );
    let pool = database.connect().await.unwrap();
    Backend::provision_schema(&pool).await.unwrap();
    let source = source_fixture().await;
    let before = inventory(source.backup.path());
    let (id, identity, key) = mysql_coordinates(&source.config).unwrap();
    Backend::provision(&pool, id, &identity, &key)
        .await
        .unwrap();
    let backend = Arc::new(
        Backend::open(pool.clone(), id, &identity, &key, 120_000)
            .await
            .unwrap(),
    );
    let receipt = import_candidate(
        &source.config,
        source.backup.path(),
        source.media.path(),
        Arc::clone(&backend),
    )
    .await
    .unwrap();
    let proof = serde_json::to_value(&receipt).unwrap();
    assert_eq!(
        proof["account_fingerprint"],
        source.binding.store_fingerprint
    );
    assert_eq!(proof["journal"]["pending"], 1);
    assert_eq!(proof["journal"]["acknowledged"], 1);
    assert_eq!(proof["pending_media"], 1);
    assert!(proof["verified_records"].as_u64().unwrap() > 0);
    assert!(proof["crypto_counts"].as_object().unwrap().len() > 1);
    assert!(proof["state_counts"].as_object().unwrap().len() > 1);
    assert_eq!(
        inventory(source.backup.path()),
        before,
        "Migration must preserve every source byte and filename"
    );
    assert!(
        backend
            .get("app.meta", b"activation")
            .await
            .unwrap()
            .is_none(),
        "Import must not activate a candidate"
    );
    let crypto = MySqlCryptoStore::new(Arc::clone(&backend));
    let account = crypto.load_account().await.unwrap().unwrap();
    assert_eq!(account.user_id().as_str(), source.config.bot_mxid);
    assert_eq!(account.device_id().as_str(), source.config.bot_device_id);
    assert_eq!(
        Sha256::digest(account.identity_keys().ed25519.to_base64().as_bytes()).as_slice(),
        source.account_fingerprint
    );
    assert!(
        crypto
            .get_device(account.user_id(), account.device_id())
            .await
            .unwrap()
            .is_some()
    );
    let state = MySqlStateStore::new(Arc::clone(&backend));
    assert_eq!(
        state
            .get_custom_value("довільний-ключ".as_bytes())
            .await
            .unwrap(),
        Some(vec![0, 128, 255])
    );
    let journal = DurableJournal::from_mysql(Arc::clone(&backend));
    let pending = journal.replay(64).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].event.body.as_deref(),
        Some("Перевір цей документ 🦆")
    );
    assert_eq!(pending[0].event.media[0].handle, source.media_handle);
    let cursor = DurableCheckpoint::from_mysql(Arc::clone(&backend))
        .await
        .unwrap();
    assert_eq!(
        cursor.committed_token().await.unwrap().as_deref(),
        Some("committed-before-crash")
    );
    // A new process may retry the inactive import after a lost final reply.
    backend.close().await.unwrap();
    let restarted = Arc::new(
        Backend::open(pool.clone(), id, &identity, &key, 120_000)
            .await
            .unwrap(),
    );
    let retried = import_candidate(
        &source.config,
        source.backup.path(),
        source.media.path(),
        Arc::clone(&restarted),
    )
    .await
    .unwrap();
    let retried_json = serde_json::to_value(&retried).unwrap();
    assert_eq!(retried_json["crypto_source"], proof["crypto_source"]);
    assert_eq!(retried_json["state_source"], proof["state_source"]);
    assert_eq!(retried_json["journal"]["already_imported"], true);

    // A verified receipt is not permanent permission to activate a candidate
    // whose non-account records disappeared or changed afterwards.
    let state_record = restarted
        .scan("legacy.state.kv_blob")
        .await
        .unwrap()
        .into_iter()
        .next()
        .expect("Fixture must include imported non-account state");
    restarted
        .write(vec![Mutation::Delete {
            namespace: "legacy.state.kv_blob".into(),
            key: state_record.0.clone(),
        }])
        .await
        .unwrap();
    assert!(
        activate_verified_candidate(&source.config, Arc::clone(&restarted))
            .await
            .is_err(),
        "Activation must recheck the complete destination, not just account/cursor/journal counts"
    );
    assert!(
        restarted
            .get("app.meta", b"activation")
            .await
            .unwrap()
            .is_none()
    );
    restarted
        .write(vec![Mutation::Put {
            namespace: "legacy.state.kv_blob".into(),
            key: state_record.0,
            value: state_record.1,
        }])
        .await
        .unwrap();
    let chunk_key = format!("{}/0", source.media_handle).into_bytes();
    let chunk = restarted
        .get("app.media.chunks", &chunk_key)
        .await
        .unwrap()
        .unwrap();
    restarted
        .write(vec![Mutation::Delete {
            namespace: "app.media.chunks".into(),
            key: chunk_key.clone(),
        }])
        .await
        .unwrap();
    assert!(
        activate_verified_candidate(&source.config, Arc::clone(&restarted))
            .await
            .is_err(),
        "An existing media manifest is not evidence that every archived chunk survived"
    );
    assert!(
        import_candidate(
            &source.config,
            source.backup.path(),
            source.media.path(),
            Arc::clone(&restarted)
        )
        .await
        .is_err(),
        "Candidate retry must reject an existing archive with a missing chunk"
    );
    assert!(
        restarted
            .get("app.meta", b"activation")
            .await
            .unwrap()
            .is_none()
    );
    restarted
        .write(vec![Mutation::Put {
            namespace: "app.media.chunks".into(),
            key: chunk_key,
            value: chunk,
        }])
        .await
        .unwrap();
    // The failed retry may have rewritten nested encrypted SDK values before
    // discovering the missing media chunk. It must remain inactive until a
    // complete successful read-back creates a current destination receipt.
    import_candidate(
        &source.config,
        source.backup.path(),
        source.media.path(),
        Arc::clone(&restarted),
    )
    .await
    .unwrap();
    let divergent = private_temp();
    copy_tree(source.backup.path(), divergent.path());
    let changed = private_temp();
    copy_file(
        &source.backup.path().join("matrix-sdk-state.sqlite3"),
        &changed.path().join("matrix-sdk-state.sqlite3"),
    );
    let modified = SqliteStateStore::open(
        changed.path(),
        Some(source.config.store_passphrase.as_str()),
    )
    .await
    .unwrap();
    modified
        .set_custom_value("довільний-ключ".as_bytes(), vec![9, 8, 7])
        .await
        .unwrap();
    drop(modified);
    let connection =
        rusqlite::Connection::open(changed.path().join("matrix-sdk-state.sqlite3")).unwrap();
    let replacement = divergent.path().join("replacement.sqlite3");
    connection
        .execute("VACUUM INTO ?1", [replacement.to_str().unwrap()])
        .unwrap();
    drop(connection);
    private_mode(&replacement, 0o600);
    // Replace only this test's generated copied DB with another complete backup.
    std::fs::rename(
        &replacement,
        divergent.path().join("matrix-sdk-state.sqlite3"),
    )
    .unwrap();
    let divergence = import_candidate(
        &source.config,
        divergent.path(),
        source.media.path(),
        Arc::clone(&restarted),
    )
    .await;
    assert!(
        matches!(divergence, Err(StoreError::Conflict)),
        "A different logical source must not overwrite an already imported candidate"
    );
    assert!(
        matches!(
            activate_candidate_from_source(
                &source.config,
                divergent.path(),
                source.media.path(),
                Arc::clone(&restarted)
            )
            .await,
            Err(StoreError::Conflict)
        ),
        "Activation must re-read source and reject post-import changes"
    );
    let held_source_lock = StoreLock::acquire_read_only(source.backup.path()).unwrap();
    assert!(
        activate_candidate_from_source(
            &source.config,
            source.backup.path(),
            source.media.path(),
            Arc::clone(&restarted)
        )
        .await
        .is_err(),
        "CLI activation may not bypass an existing source writer lock"
    );
    drop(held_source_lock);
    assert!(
        restarted
            .get("app.meta", b"activation")
            .await
            .unwrap()
            .is_none()
    );
    // This final call is an explicit test-only cutover, not production authorization.
    activate_candidate_from_source(
        &source.config,
        source.backup.path(),
        source.media.path(),
        Arc::clone(&restarted),
    )
    .await
    .unwrap();
    assert_eq!(
        inventory(source.backup.path()),
        before,
        "Locked activation must not modify source"
    );
    drop(StoreLock::acquire_read_only(source.backup.path()).unwrap());
    assert_eq!(
        restarted
            .get("app.meta", b"activation")
            .await
            .unwrap()
            .as_deref(),
        Some(b"ready".as_slice())
    );
    assert!(matches!(
        import_candidate(
            &source.config,
            source.backup.path(),
            source.media.path(),
            Arc::clone(&restarted)
        )
        .await,
        Err(StoreError::Conflict)
    ));
    let checkpoint = DurableCheckpoint::open_mysql(Arc::clone(&restarted))
        .await
        .unwrap();
    assert_eq!(
        checkpoint.committed_token().await.unwrap().as_deref(),
        Some("committed-before-crash")
    );
    let state = MySqlStateStore::new(Arc::clone(&restarted));
    assert!(
        matches!(state.get_kv_data(StateStoreDataKey::SyncToken).await.unwrap(),Some(StateStoreDataValue::SyncToken(token)) if token=="committed-before-crash")
    );
    let new_spool_root = private_temp();
    let new_spool = PrivateSpool::create(new_spool_root.path()).unwrap();
    crate::durable_media::restore(&restarted, &new_spool, &pending[0].event.media)
        .await
        .unwrap();
    assert_eq!(
        new_spool.read_verified(&pending[0].event.media[0]).unwrap(),
        b"%PDF-synthetic candidate import"
    );
    assert_eq!(inventory(source.backup.path()), before);
    restarted.close().await.unwrap();
    pool.close().await;
}
