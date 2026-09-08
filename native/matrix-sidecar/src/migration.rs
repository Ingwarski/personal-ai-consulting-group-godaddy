//! Explicit offline migration into a non-active MySQL candidate. Not a startup
//! fallback. All source reads are immutable, and activation is a separate call.
use crate::{
    config::Config,
    durable_checkpoint::DurableCheckpoint,
    durable_ingress::DurableJournal,
    lock::{StoreLock, read_private_file},
    media_spool::PrivateSpool,
    store::DeviceBinding,
    sync_checkpoint::SyncCheckpoint,
};
use matrix_sdk_base::crypto::store::CryptoStore;
use personal_consultant_matrix_mysql_store::{
    Backend, Mutation, StoreError,
    crypto::MySqlCryptoStore,
    legacy_crypto::{LegacySecret, read_crypto_backup},
    legacy_state::LegacyStateSnapshot,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Arc};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationReceipt {
    version: u32,
    crypto_source: String,
    state_source: String,
    crypto_counts: BTreeMap<String, usize>,
    state_counts: BTreeMap<String, u64>,
    account_fingerprint: String,
    journal: crate::durable_ingress::LegacyJournalImportReceipt,
    verified_records: usize,
    pending_media: usize,
    destination_digest: String,
}
fn corrupt<T>(_: T) -> StoreError {
    StoreError::Corrupt
}

async fn destination_digest(backend: &Backend) -> Result<String, StoreError> {
    fn part(hash: &mut Sha256, data: &[u8]) {
        hash.update((data.len() as u64).to_be_bytes());
        hash.update(data);
    }
    let mut hash = Sha256::new();
    part(&mut hash, b"pc-matrix-candidate-inventory-v1");
    for ns in backend.record_namespaces().await? {
        // The receipt cannot hash itself. Source hashes are separately bound
        // in this encrypted receipt; all runnable data is included below.
        if ns == "app.migration" {
            continue;
        }
        part(&mut hash, ns.as_bytes());
        let mut rows = backend.scan(&ns).await?;
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, value) in rows {
            part(&mut hash, &key);
            part(&mut hash, &value);
        }
    }
    part(&mut hash, b"pc_matrix_inbox");
    let mut inbox = backend.inbox_scan().await?;
    inbox.sort_by(|a, b| a.key.cmp(&b.key));
    for row in inbox {
        part(&mut hash, &row.key);
        part(&mut hash, row.status.as_bytes());
        part(&mut hash, &row.value);
    }
    Ok(hex::encode(hash.finalize()))
}

/// Offline operator entrypoint, hosted in the already packaged setup binary.
/// Credentials remain exclusively in its explicit environment, never argv.
pub async fn run(arguments: &[String]) -> Result<(), StoreError> {
    let Some(operation) = arguments.first().map(String::as_str) else {
        return Err(StoreError::InvalidConfiguration);
    };
    if !matches!(
        operation,
        "--provision-mysql-schema" | "--import-mysql" | "--activate-mysql"
    ) {
        return Err(StoreError::InvalidConfiguration);
    }
    let mut flags = BTreeMap::new();
    for pair in arguments[1..].chunks(2) {
        if pair.len() != 2
            || !matches!(
                pair[0].as_str(),
                "--application-root" | "--source-store" | "--source-media"
            )
            || flags.insert(pair[0].as_str(), pair[1].as_str()).is_some()
        {
            return Err(StoreError::InvalidConfiguration);
        }
    }
    if operation == "--provision-mysql-schema" {
        if flags.len() != 1 {
            return Err(StoreError::InvalidConfiguration);
        }
    } else if flags.len() != 3
        || !flags
            .get("--source-store")
            .is_some_and(|p| Path::new(p).is_absolute())
        || !flags
            .get("--source-media")
            .is_some_and(|p| Path::new(p).is_absolute())
    {
        return Err(StoreError::InvalidConfiguration);
    }
    let root = Path::new(
        flags
            .get("--application-root")
            .ok_or(StoreError::InvalidConfiguration)?,
    );
    let config = Config::from_env(false, root).map_err(corrupt)?;
    if !config.mysql {
        return Err(StoreError::InvalidConfiguration);
    }
    let pool = personal_consultant_matrix_mysql_store::DatabaseConfig::from_env()?
        .connect()
        .await?;
    if operation == "--provision-mysql-schema" {
        let result = Backend::provision_schema(&pool).await;
        pool.close().await;
        result?;
        println!("{{\"migration\":\"schema_provisioned\"}}");
        return Ok(());
    }
    let (id, identity, key) = crate::store::mysql_coordinates(&config).map_err(corrupt)?;
    if operation == "--import-mysql" {
        // Missing key/source never becomes an empty active identity. This may
        // leave an inactive candidate if validation fails. Its registry row
        // freezes legacy authority; it is never permission to restart SQLite.
        match Backend::provision(&pool, id, &identity, &key).await {
            Ok(()) | Err(StoreError::Conflict) => {}
            Err(e) => return Err(e),
        }
    }
    let opened = Backend::open(pool.clone(), id, &identity, &key, 30_000).await;
    pool.close().await;
    let backend = Arc::new(opened?);
    let heartbeat = backend.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if heartbeat.renew().await.is_err() {
                break;
            }
        }
    });
    let result = {
        match (flags.get("--source-store"), flags.get("--source-media")) {
            (Some(store), Some(media)) if operation == "--activate-mysql" => {
                activate_candidate_from_source(
                    &config,
                    Path::new(store),
                    Path::new(media),
                    backend.clone(),
                )
                .await
            }
            (Some(store), Some(media)) => {
                import_candidate(&config, Path::new(store), Path::new(media), backend.clone())
                    .await
                    .map(|_| ())
            }
            _ => Err(StoreError::InvalidConfiguration),
        }
    };
    task.abort();
    let closed = backend.close().await;
    result?;
    closed?;
    println!(
        "{{\"migration\":\"{}\"}}",
        if operation == "--activate-mysql" {
            "activated"
        } else {
            "candidate_verified"
        }
    );
    Ok(())
}

/// CLI cutover always revalidates the exact immutable source while retaining
/// its exclusive lock through the atomic activation commit. No unlocked gap.
pub async fn activate_candidate_from_source(
    config: &Config,
    source: &Path,
    media_parent: &Path,
    backend: Arc<Backend>,
) -> Result<(), StoreError> {
    let _source_lock = StoreLock::acquire_read_only(source).map_err(corrupt)?;
    import_candidate_locked(config, source, media_parent, backend.clone()).await?;
    #[cfg(test)]
    assert!(
        StoreLock::acquire_read_only(source).is_err(),
        "Source lock must remain exclusive before activation"
    );
    activate_verified_candidate(config, backend).await?;
    #[cfg(test)]
    assert!(
        StoreLock::acquire_read_only(source).is_err(),
        "Source lock must remain exclusive through activation commit"
    );
    Ok(())
}

/// Separate explicit cutover, after import/read-back and isolated recovery
/// verification. There is no activation path in normal application startup.
pub async fn activate_verified_candidate(
    config: &Config,
    backend: Arc<Backend>,
) -> Result<(), StoreError> {
    let bytes = backend
        .get("app.migration", b"verified")
        .await?
        .ok_or(StoreError::Schema)?;
    let receipt: MigrationReceipt = serde_json::from_slice(&bytes)?;
    if receipt.version != 1
        || receipt.verified_records == 0
        || receipt.crypto_counts.is_empty()
        || receipt.state_counts.is_empty()
    {
        return Err(StoreError::Corrupt);
    }
    let account = MySqlCryptoStore::new(backend.clone())
        .load_account()
        .await
        .map_err(corrupt)?
        .ok_or(StoreError::Corrupt)?;
    let fp: [u8; 32] =
        Sha256::digest(account.identity_keys().ed25519.to_base64().as_bytes()).into();
    if account.user_id().as_str() != config.bot_mxid
        || account.device_id().as_str() != config.bot_device_id
        || hex::encode(fp) != receipt.account_fingerprint
    {
        return Err(StoreError::Corrupt);
    }
    DurableCheckpoint::from_mysql(backend.clone())
        .await
        .map_err(corrupt)?;
    let journal = DurableJournal::from_mysql(backend.clone());
    let replay = journal.replay_ordered(64).await.map_err(corrupt)?;
    if replay.len() != receipt.journal.pending + receipt.journal.rejected {
        return Err(StoreError::Conflict);
    }
    if destination_digest(&backend).await? != receipt.destination_digest {
        return Err(StoreError::Corrupt);
    }
    let binding = DeviceBinding {
        device_id: config.bot_device_id.clone(),
        store_fingerprint: receipt.account_fingerprint,
    };
    backend
        .activate_candidate(&serde_json::to_vec(&binding)?, fp, &bytes)
        .await
}

async fn write_and_verify(
    backend: &Backend,
    mutations: Vec<Mutation>,
) -> Result<usize, StoreError> {
    let mut count = 0;
    // Import accepts only complete puts, never destructive generic mutations.
    // Batches are resumable inside an inactive namespace; each value is read
    // back and authenticated before it contributes to the receipt.
    let mut batch = Vec::new();
    let mut verify = Vec::new();
    let mut size = 0;
    for mutation in mutations {
        let Mutation::Put {
            namespace,
            key,
            value,
        } = mutation
        else {
            return Err(StoreError::Corrupt);
        };
        size += key.len() + value.len();
        verify.push((
            namespace.clone(),
            key.clone(),
            Sha256::digest(&value).to_vec(),
        ));
        batch.push(Mutation::Put {
            namespace,
            key,
            value,
        });
        if size >= 4 * 1024 * 1024 || batch.len() >= 128 {
            backend.write(std::mem::take(&mut batch)).await?;
            for (ns, key, digest) in verify.drain(..) {
                let value = backend.get(&ns, &key).await?.ok_or(StoreError::Corrupt)?;
                if Sha256::digest(&value).as_slice() != digest {
                    return Err(StoreError::Corrupt);
                }
                count += 1;
            }
            size = 0;
        }
    }
    if !batch.is_empty() {
        backend.write(batch).await?;
        for (ns, key, digest) in verify {
            let value = backend.get(&ns, &key).await?.ok_or(StoreError::Corrupt)?;
            if Sha256::digest(&value).as_slice() != digest {
                return Err(StoreError::Corrupt);
            }
            count += 1;
        }
    }
    Ok(count)
}

/// The caller must explicitly provision this candidate and renew its fence
/// throughout the operation. No live namespace is overwritten or activated.
pub async fn import_candidate(
    config: &Config,
    source: &Path,
    media_parent: &Path,
    backend: Arc<Backend>,
) -> Result<MigrationReceipt, StoreError> {
    let _source_lock = StoreLock::acquire_read_only(source).map_err(corrupt)?;
    import_candidate_locked(config, source, media_parent, backend).await
}

async fn import_candidate_locked(
    config: &Config,
    source: &Path,
    media_parent: &Path,
    backend: Arc<Backend>,
) -> Result<MigrationReceipt, StoreError> {
    if backend.get("app.meta", b"activation").await?.is_some() {
        return Err(StoreError::Conflict);
    }
    let binding: DeviceBinding = serde_json::from_slice(
        &read_private_file(&source.join("device-binding.json"), 4096).map_err(corrupt)?,
    )?;
    let wrapping = backend.legacy_wrapping_key();
    let crypto = read_crypto_backup(
        &source.join("matrix-sdk-crypto.sqlite3"),
        LegacySecret::Passphrase(config.store_passphrase.as_str()),
        &wrapping,
    )?;
    let state = LegacyStateSnapshot::read(
        &source.join("matrix-sdk-state.sqlite3"),
        config.store_passphrase.as_str(),
        &wrapping,
    )?;
    let fingerprint = hex::encode(Sha256::digest(crypto.identity.ed25519.as_bytes()));
    if crypto.identity.user_id != config.bot_mxid
        || crypto.identity.device_id != config.bot_device_id
        || binding.device_id != config.bot_device_id
        || binding.store_fingerprint != fingerprint
    {
        return Err(StoreError::Corrupt);
    }
    let source_hashes = serde_json::to_vec(&(
        hex::encode(crypto.source_sha256),
        hex::encode(state.source_digest()),
        &fingerprint,
    ))?;
    if let Some(old) = backend.get("app.migration", b"source").await? {
        if old != source_hashes {
            return Err(StoreError::Conflict);
        }
    } else {
        backend
            .write(vec![Mutation::Put {
                namespace: "app.migration".into(),
                key: b"source".to_vec(),
                value: source_hashes,
            }])
            .await?;
    }
    let state_counts = state.counts().clone();
    let state_source = hex::encode(state.source_digest());
    let mut verified_records = write_and_verify(&backend, crypto.mutations).await?;
    verified_records += write_and_verify(&backend, state.into_mutations()?).await?;
    let journal = DurableJournal::import_legacy_read_only(
        backend.clone(),
        source,
        config.store_passphrase.as_str(),
    )
    .await
    .map_err(corrupt)?;
    let legacy = SyncCheckpoint::open_read_only(source, config.store_passphrase.as_str())
        .map_err(corrupt)?;
    let expected_cursor = legacy.export_committed_for_migration().map_err(corrupt)?;
    let checkpoint = match DurableCheckpoint::from_mysql(backend.clone()).await {
        Ok(existing) => existing,
        Err(_) => DurableCheckpoint::import_legacy_cursor(backend.clone(), &legacy)
            .await
            .map_err(corrupt)?,
    };
    if checkpoint.committed_cursor().await.map_err(corrupt)? != expected_cursor {
        return Err(StoreError::Conflict);
    }
    let replay = DurableJournal::from_mysql(backend.clone())
        .replay(64)
        .await
        .map_err(corrupt)?;
    let mut pending_media = 0;
    if replay.iter().any(|p| !p.event.media.is_empty()) {
        let spool = PrivateSpool::open_read_only(media_parent).map_err(corrupt)?;
        for pending in replay {
            spool
                .authorize_replay(&pending.event.media)
                .map_err(corrupt)?;
            for reference in &pending.event.media {
                // Exact immutable handle makes interrupted import retry safe;
                // an existing candidate object must restore and verify first.
                if backend
                    .get("app.media.meta", reference.handle.as_bytes())
                    .await?
                    .is_none()
                {
                    crate::durable_media::archive(
                        &backend,
                        &spool,
                        std::slice::from_ref(reference),
                    )
                    .await
                    .map_err(corrupt)?;
                }
                crate::durable_media::verify(&backend, reference)
                    .await
                    .map_err(corrupt)?;
                let bytes = spool.read_verified(reference).map_err(corrupt)?;
                if hex::encode(Sha256::digest(&bytes)) != reference.sha256 {
                    return Err(StoreError::Corrupt);
                }
                pending_media += 1;
            }
        }
    }
    let account = MySqlCryptoStore::new(backend.clone())
        .load_account()
        .await
        .map_err(corrupt)?
        .ok_or(StoreError::Corrupt)?;
    if account.user_id().as_str() != config.bot_mxid
        || account.device_id().as_str() != config.bot_device_id
        || hex::encode(Sha256::digest(
            account.identity_keys().ed25519.to_base64().as_bytes(),
        )) != fingerprint
    {
        return Err(StoreError::Corrupt);
    }
    // This receipt is still a candidate proof, not Published acceptance.
    let receipt = MigrationReceipt {
        version: 1,
        crypto_source: hex::encode(crypto.source_sha256),
        state_source,
        crypto_counts: crypto.source_counts,
        state_counts,
        account_fingerprint: fingerprint,
        journal,
        verified_records,
        pending_media,
        destination_digest: destination_digest(&backend).await?,
    };
    backend
        .write(vec![Mutation::Put {
            namespace: "app.migration".into(),
            key: b"verified".to_vec(),
            value: serde_json::to_vec(&receipt)?,
        }])
        .await?;
    Ok(receipt)
}

#[cfg(test)]
mod argument_tests {
    #[tokio::test]
    async fn activation_requires_both_absolute_source_paths_before_configuration_or_database() {
        for tail in [
            vec![],
            vec!["--source-store", "/private/source"],
            vec!["--source-media", "/private/media"],
            vec![
                "--source-store",
                "relative",
                "--source-media",
                "/private/media",
            ],
            vec![
                "--source-store",
                "/private/source",
                "--source-media",
                "relative",
            ],
            vec![
                "--source-store",
                "/private/source",
                "--source-store",
                "/private/source",
            ],
        ] {
            let args: Vec<String> = [
                vec!["--activate-mysql", "--application-root", "/private/app"],
                tail,
            ]
            .concat()
            .into_iter()
            .map(str::to_owned)
            .collect();
            assert!(matches!(
                super::run(&args).await,
                Err(super::StoreError::InvalidConfiguration)
            ));
        }
    }
}
