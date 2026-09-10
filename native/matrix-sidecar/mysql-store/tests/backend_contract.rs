//! Explicit real-MySQL tests. Run only through the synthetic runtime harness.
//! Ignored tests are NOT evidence of a passing database contract.
use std::{sync::Arc, time::Duration};

use personal_consultant_matrix_mysql_store::{
    Backend, DatabaseConfig, Mutation, SCHEMA_SQL, StoreError,
};
use sqlx::{MySqlPool, Row};

const KEY: [u8; 32] = [7; 32];
const IDENTITY: &[u8] = b"synthetic-fixture-device";

async fn pool() -> MySqlPool {
    let path = std::env::var("MATRIX_MYSQL_TEST_CONFIG")
        .expect("Run ignored MySQL tests with the isolated synthetic runtime harness");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(path).expect("Private synthetic runtime config must exist"),
    )
    .expect("Private synthetic runtime config must be valid JSON");
    assert!(
        fixture["marker"] == "personal-consultant-synthetic-mysql-v1",
        "Refusing a non-synthetic database configuration"
    );
    let config = DatabaseConfig::from_env().expect("Harness must supply connection variables");
    assert!(
        config.host == "127.0.0.1" && fixture["host"] == config.host,
        "Only the harness loopback server is allowed"
    );
    assert!(
        config.database.starts_with("pc_matrix_test_")
            && fixture["database"] == config.database
            && fixture["port"].as_u64() == Some(u64::from(config.port)),
        "Only the harness-created database is allowed"
    );
    let pool = config
        .connect()
        .await
        .expect("Genuine MySQL with verified TLS must connect");
    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&pool)
        .await
        .expect("Read real server version");
    assert!(
        version.starts_with("8.") && !version.contains("MariaDB"),
        "Genuine MySQL 8.x required"
    );
    for statement in SCHEMA_SQL
        .split(';')
        .filter(|statement| !statement.trim().is_empty())
    {
        sqlx::query(statement)
            .execute(&pool)
            .await
            .expect("Explicit isolated test schema setup");
    }
    pool
}

async fn fresh(lease_ms: u32) -> (MySqlPool, [u8; 16], Backend) {
    let pool = pool().await;
    let id = *uuid::Uuid::new_v4().as_bytes();
    Backend::provision(&pool, id, IDENTITY, &KEY)
        .await
        .expect("Explicit synthetic identity provisioning");
    let backend = Backend::open(pool.clone(), id, IDENTITY, &KEY, lease_ms)
        .await
        .expect("Open fixture");
    (pool, id, backend)
}

fn put(namespace: &str, key: &[u8], value: &[u8]) -> Mutation {
    Mutation::Put {
        namespace: namespace.into(),
        key: key.into(),
        value: value.into(),
    }
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn unicode_records_roundtrip_scan_and_reopen_without_new_identity() {
    let (pool, id, backend) = fresh(30_000).await;
    let key = "кімната/мій-ключ/🦆".as_bytes();
    let value = "Українська відповідь — 日本語 — 🦆".as_bytes();
    backend
        .write(vec![
            put("state", key, value),
            put("state", b"other", b"second"),
        ])
        .await
        .unwrap();
    assert_eq!(
        backend.get("state", key).await.unwrap().as_deref(),
        Some(value)
    );
    let records = backend.scan("state").await.unwrap();
    assert_eq!(records.len(), 2);
    assert!(records.iter().any(|(k, v)| k == key && v == value));
    assert!(
        backend
            .get_size()
            .await
            .unwrap()
            .is_some_and(|bytes| bytes > value.len())
    );
    assert!(matches!(
        Backend::provision(&pool, id, IDENTITY, &KEY).await,
        Err(StoreError::Conflict)
    ));
    backend.release().await.unwrap();
    let reopened = Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000)
        .await
        .unwrap();
    assert_eq!(
        reopened.get("state", key).await.unwrap().as_deref(),
        Some(value)
    );
    reopened.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn second_owner_is_blocked_without_displacing_current_owner() {
    let (pool, id, backend) = fresh(30_000).await;
    assert!(matches!(
        Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000).await,
        Err(StoreError::Conflict)
    ));
    backend
        .write(vec![put("fixture", b"owner", b"still-owned")])
        .await
        .unwrap();
    backend.renew().await.unwrap();
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn verified_deployment_takeover_fences_predecessor_but_not_same_release_peer() {
    let pool = pool().await;
    let id = *uuid::Uuid::new_v4().as_bytes();
    Backend::provision(&pool, id, IDENTITY, &KEY).await.unwrap();
    let first = Backend::open_for_deployment(pool.clone(), id, IDENTITY, &KEY, 30_000, [1; 16])
        .await
        .unwrap();
    assert!(matches!(
        Backend::open_for_deployment(pool.clone(), id, IDENTITY, &KEY, 30_000, [1; 16]).await,
        Err(StoreError::Conflict)
    ));
    let successor = Backend::open_for_deployment(pool.clone(), id, IDENTITY, &KEY, 30_000, [2; 16])
        .await
        .unwrap();
    assert!(matches!(first.renew().await, Err(StoreError::Fenced)));
    assert!(matches!(first.release().await, Err(StoreError::Fenced)));
    successor
        .write(vec![put("fixture", b"successor", b"owns-store")])
        .await
        .unwrap();
    successor.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn stale_owner_cannot_write_renew_or_release_successor() {
    let (pool, id, first) = fresh(100).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let second = Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000)
        .await
        .unwrap();
    assert!(matches!(
        first.write(vec![put("fixture", b"bad", b"stale")]).await,
        Err(StoreError::Fenced)
    ));
    assert!(matches!(first.renew().await, Err(StoreError::Fenced)));
    assert!(matches!(first.release().await, Err(StoreError::Fenced)));
    second
        .write(vec![put("fixture", b"good", b"successor")])
        .await
        .unwrap();
    assert_eq!(second.get("fixture", b"bad").await.unwrap(), None);
    assert_eq!(
        second.get("fixture", b"good").await.unwrap(),
        Some(b"successor".to_vec())
    );
    second.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn wrong_key_identity_and_absent_store_do_not_provision_or_take_ownership() {
    let pool = pool().await;
    let id = *uuid::Uuid::new_v4().as_bytes();
    Backend::provision(&pool, id, IDENTITY, &KEY).await.unwrap();
    assert!(matches!(
        Backend::open(pool.clone(), id, IDENTITY, &[9; 32], 30_000).await,
        Err(StoreError::Corrupt)
    ));
    assert!(matches!(
        Backend::open(pool.clone(), id, b"different-device", &KEY, 30_000).await,
        Err(StoreError::Schema)
    ));
    let absent = *uuid::Uuid::new_v4().as_bytes();
    assert!(matches!(
        Backend::open(pool.clone(), absent, IDENTITY, &KEY, 30_000).await,
        Err(StoreError::Schema)
    ));
    let fence: u64 = sqlx::query_scalar("SELECT fence FROM pc_matrix_stores WHERE store_id=?")
        .bind(id.as_slice())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fence, 0, "Failed binding checks must not change ownership");
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pc_matrix_stores WHERE store_id=?")
        .bind(absent.as_slice())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        rows, 0,
        "Opening absent state must never fabricate an identity"
    );
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn invalid_second_mutation_rolls_back_entire_logical_batch() {
    let (pool, _, backend) = fresh(30_000).await;
    backend
        .write(vec![put("fixture", b"original", b"before")])
        .await
        .unwrap();
    assert!(matches!(
        backend
            .write(vec![
                put("fixture", b"original", b"must-rollback"),
                put("fixture", b"new", b"must-not-appear"),
                put("", b"invalid", b"reject"),
            ])
            .await,
        Err(StoreError::InvalidConfiguration)
    ));
    assert_eq!(
        backend.get("fixture", b"original").await.unwrap(),
        Some(b"before".to_vec())
    );
    assert_eq!(backend.get("fixture", b"new").await.unwrap(), None);
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn ciphertext_bit_flip_is_rejected_and_plaintext_is_absent_from_rows() {
    let (pool, id, backend) = fresh(30_000).await;
    let secret = b"synthetic-sensitive-value-never-stored-plaintext";
    backend
        .write(vec![put("fixture", b"sensitive-lookup-key", secret)])
        .await
        .unwrap();
    let row = sqlx::query(
        "SELECT record_key,payload FROM pc_matrix_records WHERE store_id=? AND namespace=?",
    )
    .bind(id.as_slice())
    .bind(b"fixture".as_slice())
    .fetch_one(&pool)
    .await
    .unwrap();
    let lookup: Vec<u8> = row.try_get("record_key").unwrap();
    let mut payload: Vec<u8> = row.try_get("payload").unwrap();
    assert_eq!(lookup.len(), 32);
    assert!(!payload.windows(secret.len()).any(|window| window == secret));
    assert!(
        !payload
            .windows(b"sensitive-lookup-key".len())
            .any(|window| window == b"sensitive-lookup-key")
    );
    let middle = payload.len() / 2;
    payload[middle] ^= 0x40;
    sqlx::query("UPDATE pc_matrix_records SET payload=? WHERE store_id=? AND namespace=?")
        .bind(payload)
        .bind(id.as_slice())
        .bind(b"fixture".as_slice())
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        backend.get("fixture", b"sensitive-lookup-key").await,
        Err(StoreError::Corrupt)
    ));
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn authenticated_row_context_rejects_namespace_and_revision_substitution() {
    let (pool, id, backend) = fresh(30_000).await;
    backend
        .write(vec![
            put("one", b"key", b"first"),
            put("two", b"key", b"second"),
            put("revision", b"key", b"third"),
        ])
        .await
        .unwrap();
    let payload: Vec<u8> = sqlx::query_scalar(
        "SELECT payload FROM pc_matrix_records WHERE store_id=? AND namespace=?",
    )
    .bind(id.as_slice())
    .bind(b"one".as_slice())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE pc_matrix_records SET payload=? WHERE store_id=? AND namespace=?")
        .bind(payload)
        .bind(id.as_slice())
        .bind(b"two".as_slice())
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        backend.get("two", b"key").await,
        Err(StoreError::Corrupt)
    ));
    sqlx::query(
        "UPDATE pc_matrix_records SET revision=revision+1 WHERE store_id=? AND namespace=?",
    )
    .bind(id.as_slice())
    .bind(b"revision".as_slice())
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        backend.get("revision", b"key").await,
        Err(StoreError::Corrupt)
    ));
    assert_eq!(
        backend.get("one", b"key").await.unwrap(),
        Some(b"first".to_vec())
    );
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn identity_binding_ciphertext_cannot_be_substituted_between_stores() {
    let pool = pool().await;
    let a = *uuid::Uuid::new_v4().as_bytes();
    let b = *uuid::Uuid::new_v4().as_bytes();
    Backend::provision(&pool, a, IDENTITY, &KEY).await.unwrap();
    Backend::provision(&pool, b, IDENTITY, &KEY).await.unwrap();
    let binding: Vec<u8> =
        sqlx::query_scalar("SELECT binding FROM pc_matrix_stores WHERE store_id=?")
            .bind(a.as_slice())
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE pc_matrix_stores SET binding=? WHERE store_id=?")
        .bind(binding)
        .bind(b.as_slice())
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        Backend::open(pool.clone(), b, IDENTITY, &KEY, 30_000).await,
        Err(StoreError::Corrupt)
    ));
    let unchanged = Backend::open(pool.clone(), a, IDENTITY, &KEY, 30_000)
        .await
        .unwrap();
    unchanged.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn sdk_leases_start_at_one_renew_same_generation_and_increment_for_successor() {
    let (pool, _, backend) = fresh(30_000).await;
    assert_eq!(
        backend
            .try_take_leased_lock(0, "lock", "alice")
            .await
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        backend
            .try_take_leased_lock(100, "lock", "alice")
            .await
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        backend
            .try_take_leased_lock(100, "lock", "bob")
            .await
            .unwrap(),
        None
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        backend
            .try_take_leased_lock(100, "lock", "bob")
            .await
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        backend
            .try_take_leased_lock(100, "lock", "bob")
            .await
            .unwrap(),
        Some(2)
    );
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn close_blocks_operations_until_reopen_and_release_fences_instance_permanently() {
    let (pool, _, backend) = fresh(30_000).await;
    backend
        .write(vec![put("fixture", b"key", b"value")])
        .await
        .unwrap();
    backend.close().await.unwrap();
    assert!(backend.is_closed().await);
    assert!(matches!(
        backend.get("fixture", b"key").await,
        Err(StoreError::Closed)
    ));
    assert!(matches!(
        backend.write(vec![put("fixture", b"key", b"bad")]).await,
        Err(StoreError::Closed)
    ));
    assert!(matches!(
        backend.scan("fixture").await,
        Err(StoreError::Closed)
    ));
    backend.reopen().await.unwrap();
    assert!(!backend.is_closed().await);
    assert_eq!(
        backend.get("fixture", b"key").await.unwrap(),
        Some(b"value".to_vec())
    );
    backend.release().await.unwrap();
    assert!(matches!(backend.reopen().await, Err(StoreError::Fenced)));
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn concurrent_batches_do_not_interleave_or_lose_updates() {
    let (pool, _, backend) = fresh(30_000).await;
    let backend = Arc::new(backend);
    let left = Arc::clone(&backend);
    let right = Arc::clone(&backend);
    let a = tokio::spawn(async move {
        left.write(vec![put("left", b"a", b"one"), put("left", b"b", b"two")])
            .await
    });
    let b = tokio::spawn(async move {
        right
            .write(vec![
                put("right", b"a", b"three"),
                put("right", b"b", b"four"),
            ])
            .await
    });
    a.await.unwrap().unwrap();
    b.await.unwrap().unwrap();
    assert_eq!(backend.scan("left").await.unwrap().len(), 2);
    assert_eq!(backend.scan("right").await.unwrap().len(), 2);
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn close_releases_ownership_and_stale_reopen_refuses_intervening_writer() {
    let (pool, id, first) = fresh(30_000).await;
    first
        .write(vec![put("fixture", b"key", b"before")])
        .await
        .unwrap();
    first.close().await.unwrap();
    // No lease-expiry sleep: SDK close must release this owner immediately.
    let second = Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000)
        .await
        .unwrap();
    second
        .write(vec![put("fixture", b"key", b"successor")])
        .await
        .unwrap();
    second.release().await.unwrap();
    // A now-unowned row does not make the first SDK instance's old memory safe.
    assert!(matches!(first.reopen().await, Err(StoreError::Fenced)));
    assert!(first.is_closed().await);
    let third = Backend::open(pool.clone(), id, IDENTITY, &KEY, 30_000)
        .await
        .unwrap();
    assert_eq!(
        third.get("fixture", b"key").await.unwrap(),
        Some(b"successor".to_vec())
    );
    third.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn large_binary_value_roundtrips_without_json_byte_array_expansion() {
    let (pool, _, backend) = fresh(120_000).await;
    let packet: u64 = sqlx::query_scalar("SELECT @@max_allowed_packet")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        packet >= 32 * 1024 * 1024,
        "Synthetic test MySQL max_allowed_packet must allow the explicitly bounded fixture"
    );
    let value = vec![0xff; 9 * 1024 * 1024];
    backend
        .write(vec![put("binary", b"large", &value)])
        .await
        .unwrap();
    let restored = backend.get("binary", b"large").await.unwrap().unwrap();
    // Avoid dumping a 9 MiB fixture in a failed assertion.
    assert_eq!(restored.len(), value.len());
    assert!(restored.iter().all(|byte| *byte == 0xff));
    backend.release().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated MySQL"]
async fn prefix_scan_preserves_short_exact_long_and_binary_prefix_semantics() {
    let (pool, _, backend) = fresh(30_000).await;
    let keys: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"ab".to_vec(),
        b"ab-short".to_vec(),
        b"abcdefghijklmnop".to_vec(),
        b"abcdefghijklmnop-tail-a".to_vec(),
        b"abcdefghijklmnop-tail-b".to_vec(),
        b"abcdefghijklmnox-other".to_vec(),
        b"unrelated".to_vec(),
        "кімната-🦆-один".as_bytes().to_vec(),
        "кімната-🦆-два".as_bytes().to_vec(),
        vec![0, 0xff, 1, 2],
    ];
    backend
        .write(
            keys.iter()
                .map(|key| put("prefix", key, b"fixture"))
                .collect(),
        )
        .await
        .unwrap();
    let prefixes: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"a".to_vec(),
        b"ab".to_vec(),
        b"abcdefghijklmnop".to_vec(),
        b"abcdefghijklmnop-tail".to_vec(),
        b"abcdefghijklmnop-tail-a".to_vec(),
        b"abcdefghijklmnop-tail-a-missing".to_vec(),
        b"missing".to_vec(),
        "кімната-🦆-".as_bytes().to_vec(),
        vec![0, 0xff],
    ];
    for prefix in prefixes {
        let mut expected: Vec<Vec<u8>> = keys
            .iter()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        let mut actual: Vec<Vec<u8>> = backend
            .scan_prefix("prefix", &prefix)
            .await
            .unwrap()
            .into_iter()
            .map(|(key, value)| {
                assert_eq!(value, b"fixture");
                key
            })
            .collect();
        expected.sort();
        actual.sort();
        assert_eq!(
            actual, expected,
            "Prefix query must not omit short or indexed-prefix matches"
        );
    }
    backend.release().await.unwrap();
    pool.close().await;
}
