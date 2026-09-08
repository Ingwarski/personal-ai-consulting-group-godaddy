//! Real synthetic MySQL faults. Never point this fixture at an application DB.
#![cfg(feature = "integration-tests")]

use personal_consultant_matrix_mysql_store::{
    Backend, DatabaseConfig, Mutation, SCHEMA_SQL, StoreError,
};
use sqlx::MySqlPool;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const KEY: [u8; 32] = [37; 32];
const IDENTITY: &[u8] = b"synthetic-fault-fixture-device";

async fn fresh() -> (MySqlPool, [u8; 16], Arc<Backend>) {
    let marker_path = std::env::var("MATRIX_MYSQL_TEST_CONFIG")
        .expect("isolated synthetic MySQL harness required");
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(marker_path).unwrap()).unwrap();
    let config = DatabaseConfig::from_env().unwrap();
    assert_eq!(marker["marker"], "personal-consultant-synthetic-mysql-v1");
    assert_eq!(config.host, "127.0.0.1");
    assert_eq!(marker["host"], config.host);
    assert!(config.database.starts_with("pc_matrix_test_"));
    assert_eq!(marker["database"], config.database);
    assert_eq!(marker["port"].as_u64(), Some(u64::from(config.port)));
    let pool = config.connect().await.unwrap();
    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(version.starts_with("8.") && !version.contains("MariaDB"));
    sqlx::raw_sql(SCHEMA_SQL).execute(&pool).await.unwrap();
    // Explicit additive fixture upgrade for an existing isolated test database.
    // This helper is feature-gated, requires its private synthetic marker, and
    // is never invoked by application startup.
    let present:i64=sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pc_matrix_stores' AND column_name='account_fingerprint'").fetch_one(&pool).await.unwrap();
    if present == 0 {
        sqlx::query("ALTER TABLE pc_matrix_stores ADD COLUMN account_fingerprint BINARY(32) NULL")
            .execute(&pool)
            .await
            .unwrap();
    }
    let id = *uuid::Uuid::new_v4().as_bytes();
    Backend::provision(&pool, id, IDENTITY, &KEY).await.unwrap();
    let backend = Arc::new(
        Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000)
            .await
            .unwrap(),
    );
    (pool, id, backend)
}

fn put(key: &[u8], value: &[u8]) -> Mutation {
    Mutation::Put {
        namespace: "fault.fixture".to_owned(),
        key: key.to_vec(),
        value: value.to_vec(),
    }
}

#[tokio::test]
#[ignore = "requires isolated genuine MySQL 8 with TLS"]
async fn blocked_row_lock_fails_within_deadline_and_commits_no_partial_batch() {
    let (pool, id, backend) = fresh().await;
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT store_id FROM pc_matrix_stores WHERE store_id=? FOR UPDATE")
        .bind(id.as_slice())
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let started = Instant::now();
    assert!(matches!(
        backend
            .write(vec![put(b"first", b"one"), put(b"second", b"two")])
            .await,
        Err(StoreError::Unavailable)
    ));
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "API must not wait indefinitely for a DB row lock"
    );
    blocker.rollback().await.unwrap();
    assert!(
        backend
            .get("fault.fixture", b"first")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        backend
            .get("fault.fixture", b"second")
            .await
            .unwrap()
            .is_none()
    );
    backend.write(vec![put(b"recovered", b"ok")]).await.unwrap();
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated genuine MySQL 8 with TLS"]
async fn simulated_lost_response_after_real_commit_poisons_instance_and_reloads_committed_batch() {
    let (pool, id, backend) = fresh().await;
    backend
        .write(vec![Mutation::Put {
            namespace: "crypto.meta".to_owned(),
            key: b"account-fixture".to_vec(),
            value: b"immutable-device-fixture".to_vec(),
        }])
        .await
        .unwrap();
    // This fault occurs AFTER actual MySQL COMMIT succeeds. It models losing
    // the acknowledgement deterministically; it is not an actual TCP-drop test.
    backend.inject_lost_commit_response_once_for_test();
    assert!(matches!(
        backend
            .write(vec![put(b"first", b"one"), put(b"second", b"two")])
            .await,
        Err(StoreError::Unavailable)
    ));
    assert!(matches!(
        backend.get("fault.fixture", b"first").await,
        Err(StoreError::Fenced)
    ));
    assert!(matches!(
        backend.write(vec![put(b"illegal-retry", b"no")]).await,
        Err(StoreError::Fenced)
    ));
    backend.close().await.unwrap();
    assert!(
        matches!(backend.reopen().await, Err(StoreError::Fenced)),
        "discard uncertain SDK memory; do not reopen in place"
    );
    let fresh = Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000)
        .await
        .unwrap();
    assert_eq!(
        fresh.get("fault.fixture", b"first").await.unwrap(),
        Some(b"one".to_vec())
    );
    assert_eq!(
        fresh.get("fault.fixture", b"second").await.unwrap(),
        Some(b"two".to_vec())
    );
    assert!(
        fresh
            .get("fault.fixture", b"illegal-retry")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fresh.get("crypto.meta", b"account-fixture").await.unwrap(),
        Some(b"immutable-device-fixture".to_vec())
    );
    fresh.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated genuine MySQL 8 with TLS"]
async fn killed_connection_rolls_back_uncommitted_batch_before_new_owner_reload() {
    let (pool, id, backend) = fresh().await;
    backend
        .write(vec![put(b"prior", b"committed")])
        .await
        .unwrap();
    // The feature-only hook obtains the active transaction's real MySQL thread
    // ID, then kills that connection from another connection before COMMIT.
    backend.inject_disconnect_before_commit_once_for_test();
    assert!(matches!(
        backend
            .write(vec![put(b"first", b"one"), put(b"second", b"two")])
            .await,
        Err(StoreError::Unavailable)
    ));
    assert!(matches!(
        backend.get("fault.fixture", b"prior").await,
        Err(StoreError::Fenced)
    ));
    backend.close().await.unwrap();
    let fresh = Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000)
        .await
        .unwrap();
    assert_eq!(
        fresh.get("fault.fixture", b"prior").await.unwrap(),
        Some(b"committed".to_vec())
    );
    assert!(
        fresh
            .get("fault.fixture", b"first")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fresh
            .get("fault.fixture", b"second")
            .await
            .unwrap()
            .is_none()
    );
    fresh.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated genuine MySQL 8 with TLS"]
async fn cutover_marker_binding_and_fingerprint_are_atomic_and_not_repeatable() {
    let (pool, id, backend) = fresh().await;
    assert!(matches!(
        backend.activate_candidate(b"{}", [5; 32], b"{}").await,
        Err(StoreError::Schema)
    ));
    assert!(
        backend
            .get("app.meta", b"activation")
            .await
            .unwrap()
            .is_none()
    );
    backend
        .write(vec![Mutation::Put {
            namespace: "crypto.meta".to_owned(),
            key: b"account".to_vec(),
            value: b"synthetic-account-proof".to_vec(),
        }])
        .await
        .unwrap();
    backend
        .activate_candidate(br#"{"device":"fixture"}"#, [5; 32], br#"{"complete":true}"#)
        .await
        .unwrap();
    assert_eq!(
        backend.get("app.meta", b"activation").await.unwrap(),
        Some(b"ready".to_vec())
    );
    assert_eq!(
        backend.get("app.meta", b"device-binding").await.unwrap(),
        Some(br#"{"device":"fixture"}"#.to_vec())
    );
    let fingerprint: Vec<u8> =
        sqlx::query_scalar("SELECT account_fingerprint FROM pc_matrix_stores WHERE store_id=?")
            .bind(id.as_slice())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(fingerprint, vec![5; 32]);
    assert!(matches!(
        backend.activate_candidate(b"{}", [9; 32], b"{}").await,
        Err(StoreError::Conflict)
    ));
    backend.release().await.unwrap();
    pool.close().await;
}
