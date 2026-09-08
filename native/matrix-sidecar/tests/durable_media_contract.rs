//! Synthetic spool negatives and explicit real-MySQL pending-media recovery.
use std::{collections::HashSet, sync::Arc};

use personal_consultant_matrix_mysql_store::{Backend, DatabaseConfig, Mutation};
use personal_consultant_matrix_sidecar::{
    config::MAX_MEDIA_OBJECT_BYTES,
    durable_ingress::DurableJournal,
    durable_media,
    ingress::{IngressAck, IngressEvent},
    media_spool::{MediaKind, PrivateSpool},
};

fn private_temp() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    root
}

async fn backend() -> Arc<Backend> {
    let path = std::env::var("MATRIX_MYSQL_TEST_CONFIG").expect("Use isolated MySQL harness");
    let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let config = DatabaseConfig::from_env().unwrap();
    assert!(
        fixture["marker"] == "personal-consultant-synthetic-mysql-v1"
            && config.host == "127.0.0.1"
            && config.database.starts_with("pc_matrix_test_")
            && fixture["database"] == config.database
            && fixture["port"].as_u64() == Some(u64::from(config.port))
    );
    let pool = config.connect().await.unwrap();
    Backend::provision_schema(&pool).await.unwrap();
    let id = *uuid::Uuid::new_v4().as_bytes();
    Backend::provision(&pool, id, b"synthetic-media-fixture", &[7; 32])
        .await
        .unwrap();
    Arc::new(
        Backend::open(pool, id, b"synthetic-media-fixture", &[7; 32], 120_000)
            .await
            .unwrap(),
    )
}

#[test]
fn spool_restore_rejects_path_hash_type_length_and_extension_before_writing() {
    let source = private_temp();
    let destination = private_temp();
    let original = PrivateSpool::create(source.path()).unwrap();
    let restored = PrivateSpool::create(destination.path()).unwrap();
    let bytes = b"%PDF-synthetic fixture";
    let reference = original.write(MediaKind::Pdf, bytes).unwrap();
    let mut invalid = reference.clone();
    invalid.handle = "../outside.pdf".into();
    assert!(restored.restore_verified(&invalid, bytes).is_err());
    let mut invalid = reference.clone();
    invalid.sha256 = "0".repeat(64);
    assert!(restored.restore_verified(&invalid, bytes).is_err());
    let mut invalid = reference.clone();
    invalid.declared_mime = "image/png".into();
    assert!(restored.restore_verified(&invalid, bytes).is_err());
    let mut invalid = reference.clone();
    invalid.length += 1;
    assert!(restored.restore_verified(&invalid, bytes).is_err());
    let mut invalid = reference.clone();
    invalid.handle = invalid.handle.replace(".pdf", ".png");
    assert!(restored.restore_verified(&invalid, bytes).is_err());
    assert!(restored.restore_verified(&reference, b"not a PDF").is_err());
    assert_eq!(
        std::fs::read_dir(destination.path()).unwrap().count(),
        1,
        "Rejected restoration must not create an old-instance directory"
    );
}

#[cfg(unix)]
#[test]
fn spool_restore_rejects_symlink_directory_and_symlink_target_without_overwriting() {
    use std::os::unix::{fs::PermissionsExt, fs::symlink};
    let source = private_temp();
    let destination = private_temp();
    let outside = private_temp();
    let original = PrivateSpool::create(source.path()).unwrap();
    let bytes = b"%PDF-synthetic fixture";
    let reference = original.write(MediaKind::Pdf, bytes).unwrap();
    let restored = PrivateSpool::create(destination.path()).unwrap();
    let directory = destination
        .path()
        .join(format!("boot-{}", original.instance()));
    symlink(outside.path(), &directory).unwrap();
    assert!(restored.restore_verified(&reference, bytes).is_err());
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    // Remove only the symlink created by this test, not its target.
    std::fs::remove_file(&directory).unwrap();
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let sentinel = outside.path().join("sentinel.pdf");
    std::fs::write(&sentinel, b"unchanged synthetic sentinel").unwrap();
    symlink(&sentinel, directory.join(&reference.handle)).unwrap();
    assert!(restored.restore_verified(&reference, bytes).is_err());
    assert_eq!(
        std::fs::read(&sentinel).unwrap(),
        b"unchanged synthetic sentinel"
    );
}

#[tokio::test]
#[ignore = "requires isolated MySQL schema"]
async fn mysql_archive_survives_missing_spool_and_preserves_unicode_event_and_exact_handle() {
    let backend = backend().await;
    let source = private_temp();
    let destination = private_temp();
    let original = PrivateSpool::create(source.path()).unwrap();
    let bytes = b"%PDF-synthetic archived media";
    let reference = original.write(MediaKind::Pdf, bytes).unwrap();
    durable_media::archive(&backend, &original, std::slice::from_ref(&reference))
        .await
        .unwrap();
    let journal = DurableJournal::from_mysql(Arc::clone(&backend));
    let event = IngressEvent {
        event_id: "$media:example".into(),
        room_id: "!room:example".into(),
        sender_mxid: "@owner:example".into(),
        sender_device_id: "OWNER".into(),
        body: Some("Перевір цей документ 🦆 日本語".into()),
        reply_to_event_id: None,
        media: vec![reference.clone()],
    };
    journal.persist(event.clone()).await.unwrap();
    // Delete only this test's generated spool file and now-empty boot directory.
    let file = original.root().join(&reference.handle);
    assert!(file.starts_with(source.path()));
    std::fs::remove_file(file).unwrap();
    std::fs::remove_dir(original.root()).unwrap();
    backend.close().await.unwrap();
    backend.reopen().await.unwrap();
    let replay = journal.replay(64).await.unwrap();
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].event.body, event.body);
    let restored = PrivateSpool::create(destination.path()).unwrap();
    assert_ne!(restored.instance(), original.instance());
    durable_media::restore(&backend, &restored, &replay[0].event.media)
        .await
        .unwrap();
    assert_eq!(restored.read_verified(&reference).unwrap(), bytes);
    assert_eq!(replay[0].event.media[0].handle, reference.handle);
    journal
        .acknowledge(&IngressAck {
            event_id: event.event_id,
            durable_receipt_id: "node-media-commit".into(),
        })
        .await
        .unwrap();
    durable_media::remove(&backend, &reference.handle)
        .await
        .unwrap();
    assert!(backend.scan("app.media.meta").await.unwrap().is_empty());
    assert!(backend.scan("app.media.chunks").await.unwrap().is_empty());
    assert_eq!(journal.unacked_count().await.unwrap(), 0);
    backend.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated MySQL schema"]
async fn mysql_twenty_mib_boundary_uses_five_atomic_chunks_and_restores_hash() {
    let backend = backend().await;
    let source = private_temp();
    let destination = private_temp();
    let original = PrivateSpool::create(source.path()).unwrap();
    let mut bytes = vec![0xff; MAX_MEDIA_OBJECT_BYTES as usize];
    bytes[..5].copy_from_slice(b"%PDF-");
    let reference = original.write(MediaKind::Pdf, &bytes).unwrap();
    durable_media::archive(&backend, &original, std::slice::from_ref(&reference))
        .await
        .unwrap();
    let chunks = backend.scan("app.media.chunks").await.unwrap();
    assert_eq!(chunks.len(), 5);
    assert!(
        chunks
            .iter()
            .all(|(_, chunk)| chunk.len() == 4 * 1024 * 1024)
    );
    drop(chunks);
    let restored = PrivateSpool::create(destination.path()).unwrap();
    durable_media::restore(&backend, &restored, std::slice::from_ref(&reference))
        .await
        .unwrap();
    let actual = restored.read_verified(&reference).unwrap();
    assert_eq!(actual.len(), MAX_MEDIA_OBJECT_BYTES as usize);
    assert!(actual == bytes);
    durable_media::remove(&backend, &reference.handle)
        .await
        .unwrap();
    backend.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated MySQL schema"]
async fn mysql_missing_or_tampered_chunk_refuses_restore_without_creating_plaintext() {
    for missing in [false, true] {
        let backend = backend().await;
        let source = private_temp();
        let destination = private_temp();
        let original = PrivateSpool::create(source.path()).unwrap();
        let bytes = b"%PDF-synthetic fixture";
        let reference = original.write(MediaKind::Pdf, bytes).unwrap();
        durable_media::archive(&backend, &original, std::slice::from_ref(&reference))
            .await
            .unwrap();
        let key = format!("{}/0", reference.handle).into_bytes();
        let mutation = if missing {
            Mutation::Delete {
                namespace: "app.media.chunks".into(),
                key,
            }
        } else {
            let mut damaged = bytes.to_vec();
            damaged[10] ^= 1;
            Mutation::Put {
                namespace: "app.media.chunks".into(),
                key,
                value: damaged,
            }
        };
        backend.write(vec![mutation]).await.unwrap();
        let restored = PrivateSpool::create(destination.path()).unwrap();
        assert!(
            durable_media::restore(&backend, &restored, std::slice::from_ref(&reference))
                .await
                .is_err()
        );
        assert!(std::fs::read_dir(restored.root()).unwrap().next().is_none());
        assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 1);
        backend.close().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires isolated MySQL schema"]
async fn mysql_orphan_pruning_protects_active_handles_and_ack_removal_is_idempotent() {
    let backend = backend().await;
    let source = private_temp();
    let spool = PrivateSpool::create(source.path()).unwrap();
    let active = spool
        .write(MediaKind::Pdf, b"%PDF-active synthetic")
        .unwrap();
    let orphan = spool
        .write(MediaKind::Pdf, b"%PDF-orphan synthetic")
        .unwrap();
    durable_media::archive(&backend, &spool, &[active.clone(), orphan.clone()])
        .await
        .unwrap();
    for reference in [&active, &orphan] {
        let key = reference.handle.as_bytes();
        let value = backend.get("app.media.meta", key).await.unwrap().unwrap();
        let mut manifest: serde_json::Value = serde_json::from_slice(&value).unwrap();
        manifest["created_at_ms"] = serde_json::json!(1);
        backend
            .write(vec![Mutation::Put {
                namespace: "app.media.meta".into(),
                key: key.to_vec(),
                value: serde_json::to_vec(&manifest).unwrap(),
            }])
            .await
            .unwrap();
    }
    let mut protected = HashSet::new();
    protected.insert(active.handle.clone());
    durable_media::prune(&backend, &protected).await.unwrap();
    assert!(
        backend
            .get("app.media.meta", active.handle.as_bytes())
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        backend
            .get("app.media.meta", orphan.handle.as_bytes())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(backend.scan("app.media.chunks").await.unwrap().len(), 1);
    durable_media::remove(&backend, &active.handle)
        .await
        .unwrap();
    durable_media::remove(&backend, &active.handle)
        .await
        .unwrap();
    assert!(backend.scan("app.media.meta").await.unwrap().is_empty());
    assert!(backend.scan("app.media.chunks").await.unwrap().is_empty());
    backend.close().await.unwrap();
}
