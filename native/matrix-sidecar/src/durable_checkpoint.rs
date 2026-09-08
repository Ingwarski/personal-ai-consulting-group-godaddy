//! Authoritative committed sync cursor. The SDK token is aligned before client creation.
//! A SQL cursor is created only by an explicit fresh/import operation, never by open.
use std::{path::Path, sync::Arc};

use matrix_sdk_base::store::{StateStore, StateStoreDataKey, StateStoreDataValue};
use personal_consultant_matrix_mysql_store::{Backend, Mutation, state::MySqlStateStore};
use serde::{Deserialize, Serialize};

use crate::sync_checkpoint::{
    CheckpointError as LegacyCheckpointError, SyncCheckpoint, validate_room_event_anchor,
    validate_token,
};

/// Retain database classification through startup alignment; never attach raw SQL
/// diagnostics to a public error or infer recovery from an error message.
#[derive(Debug, thiserror::Error)]
pub enum CheckpointError {
    #[error("committed Matrix checkpoint invalid")]
    Invalid,
    #[error("Matrix checkpoint database operation failed")]
    Database(personal_consultant_matrix_mysql_store::StoreError),
}
impl From<LegacyCheckpointError> for CheckpointError {
    fn from(_: LegacyCheckpointError) -> Self {
        Self::Invalid
    }
}

const NAMESPACE: &str = "app.sync";
const CURSOR: &[u8] = b"committed_cursor";
const CHECKPOINT: &[u8] = b"in_flight_checkpoint";
const MAX_BYTES: usize = 20 * 1024;

#[derive(Clone)]
pub enum DurableCheckpoint {
    Legacy(SyncCheckpoint),
    MySql(Arc<Backend>),
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CursorRecord {
    token: Option<String>,
    room_event_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CheckpointRecord {
    previous_token: Option<String>,
}

fn put<T: Serialize>(key: &[u8], value: &T) -> Result<Mutation, CheckpointError> {
    let value = serde_json::to_vec(value).map_err(|_| CheckpointError::Invalid)?;
    if value.len() > MAX_BYTES {
        return Err(CheckpointError::Invalid);
    }
    Ok(Mutation::Put {
        namespace: NAMESPACE.into(),
        key: key.to_vec(),
        value,
    })
}

async fn cursor(backend: &Backend) -> Result<CursorRecord, CheckpointError> {
    let bytes = backend
        .get(NAMESPACE, CURSOR)
        .await
        .map_err(CheckpointError::Database)?
        .ok_or(CheckpointError::Invalid)?;
    if bytes.len() > MAX_BYTES {
        return Err(CheckpointError::Invalid);
    }
    let cursor: CursorRecord =
        serde_json::from_slice(&bytes).map_err(|_| CheckpointError::Invalid)?;
    validate_token(cursor.token.as_deref())?;
    validate_room_event_anchor(cursor.room_event_id.as_deref())?;
    Ok(cursor)
}

async fn checkpoint(backend: &Backend) -> Result<Option<CheckpointRecord>, CheckpointError> {
    let Some(bytes) = backend
        .get(NAMESPACE, CHECKPOINT)
        .await
        .map_err(CheckpointError::Database)?
    else {
        return Ok(None);
    };
    if bytes.len() > MAX_BYTES {
        return Err(CheckpointError::Invalid);
    }
    let record: CheckpointRecord =
        serde_json::from_slice(&bytes).map_err(|_| CheckpointError::Invalid)?;
    validate_token(record.previous_token.as_deref())?;
    Ok(Some(record))
}

impl DurableCheckpoint {
    pub fn open(root: &Path, secret: &str) -> Result<Self, CheckpointError> {
        SyncCheckpoint::open(root, secret)
            .map(Self::Legacy)
            .map_err(Into::into)
    }

    pub async fn from_mysql(backend: Arc<Backend>) -> Result<Self, CheckpointError> {
        // Missing committed state is a recovery fault, not permission to reset.
        cursor(&backend).await?;
        checkpoint(&backend).await?;
        Ok(Self::MySql(backend))
    }

    pub async fn open_mysql(backend: Arc<Backend>) -> Result<Self, CheckpointError> {
        let checkpoint = Self::from_mysql(backend).await?;
        checkpoint.recover_before_client("").await?;
        Ok(checkpoint)
    }

    /// Explicit migration/fresh-identity operation on an already provisioned namespace.
    /// Existing cursor or checkpoint records conflict, including an empty cursor.
    pub async fn initialize_mysql(
        backend: Arc<Backend>,
        token: Option<String>,
        room_event_id: Option<String>,
    ) -> Result<Self, CheckpointError> {
        validate_token(token.as_deref())?;
        validate_room_event_anchor(room_event_id.as_deref())?;
        {
            let _guard = backend.mutation_lock.lock().await;
            if backend
                .get(NAMESPACE, CURSOR)
                .await
                .map_err(CheckpointError::Database)?
                .is_some()
                || backend
                    .get(NAMESPACE, CHECKPOINT)
                    .await
                    .map_err(CheckpointError::Database)?
                    .is_some()
            {
                return Err(CheckpointError::Invalid);
            }
            backend
                .write(vec![put(
                    CURSOR,
                    &CursorRecord {
                        token,
                        room_event_id,
                    },
                )?])
                .await
                .map_err(CheckpointError::Database)?;
        }
        Self::from_mysql(backend).await
    }

    /// Caller must already hold a consistent, read-only legacy backup. The
    /// committed cursor wins over an SDK token advanced by an interrupted sync.
    pub async fn import_legacy_cursor(
        backend: Arc<Backend>,
        legacy: &SyncCheckpoint,
    ) -> Result<Self, CheckpointError> {
        let (token, room_event_id) = legacy.export_committed_for_migration()?;
        Self::initialize_mysql(backend, token, room_event_id).await
    }

    pub async fn begin(&self, previous_token: Option<String>) -> Result<(), CheckpointError> {
        match self {
            Self::Legacy(legacy) => legacy.begin(previous_token).map_err(Into::into),
            Self::MySql(backend) => {
                validate_token(previous_token.as_deref())?;
                let _guard = backend.mutation_lock.lock().await;
                if cursor(backend).await?.token != previous_token
                    || checkpoint(backend).await?.is_some()
                {
                    return Err(CheckpointError::Invalid);
                }
                backend
                    .write(vec![put(CHECKPOINT, &CheckpointRecord { previous_token })?])
                    .await
                    .map_err(CheckpointError::Database)
            }
        }
    }

    pub async fn complete(&self) -> Result<(), CheckpointError> {
        match self {
            Self::Legacy(legacy) => legacy.complete().map_err(Into::into),
            Self::MySql(backend) => {
                let _guard = backend.mutation_lock.lock().await;
                cursor(backend).await?;
                if checkpoint(backend).await?.is_none() {
                    return Err(CheckpointError::Invalid);
                }
                backend
                    .write(vec![Mutation::Delete {
                        namespace: NAMESPACE.into(),
                        key: CHECKPOINT.to_vec(),
                    }])
                    .await
                    .map_err(CheckpointError::Database)
            }
        }
    }

    pub async fn committed_token(&self) -> Result<Option<String>, CheckpointError> {
        Ok(self.committed_cursor().await?.0)
    }
    pub async fn committed_cursor(
        &self,
    ) -> Result<(Option<String>, Option<String>), CheckpointError> {
        match self {
            Self::Legacy(legacy) => legacy.committed_cursor().map_err(Into::into),
            Self::MySql(backend) => {
                let record = cursor(backend).await?;
                Ok((record.token, record.room_event_id))
            }
        }
    }
    pub async fn commit_cursor(
        &self,
        token: String,
        room_event_id: Option<String>,
    ) -> Result<(), CheckpointError> {
        match self {
            Self::Legacy(legacy) => legacy
                .commit_cursor(token, room_event_id)
                .map_err(Into::into),
            Self::MySql(backend) => {
                validate_token(Some(&token))?;
                validate_room_event_anchor(room_event_id.as_deref())?;
                let _guard = backend.mutation_lock.lock().await;
                cursor(backend).await?;
                backend
                    .write(vec![put(
                        CURSOR,
                        &CursorRecord {
                            token: Some(token),
                            room_event_id,
                        },
                    )?])
                    .await
                    .map_err(CheckpointError::Database)
            }
        }
    }

    pub async fn initialize_cursor(&self, secret: &str) -> Result<(), CheckpointError> {
        match self {
            Self::Legacy(legacy) => legacy.initialize_cursor(secret).await.map_err(Into::into),
            Self::MySql(backend) => align(backend, false).await,
        }
    }
    pub async fn recover_before_client(&self, secret: &str) -> Result<(), CheckpointError> {
        match self {
            Self::Legacy(legacy) => {
                legacy.recover_before_client(secret).await?;
                legacy.initialize_cursor(secret).await.map_err(Into::into)
            }
            Self::MySql(backend) => align(backend, true).await,
        }
    }
}

async fn align(backend: &Arc<Backend>, clear_checkpoint: bool) -> Result<(), CheckpointError> {
    let (committed, in_flight) = {
        let _guard = backend.mutation_lock.lock().await;
        (cursor(backend).await?, checkpoint(backend).await?)
    };
    // Never hold mutation_lock across SDK StateStore calls, which acquire it.
    let store = MySqlStateStore::new(Arc::clone(backend));
    match &committed.token {
        Some(token) => store
            .set_kv_data(
                StateStoreDataKey::SyncToken,
                StateStoreDataValue::SyncToken(token.clone()),
            )
            .await
            .map_err(CheckpointError::Database)?,
        None => store
            .remove_kv_data(StateStoreDataKey::SyncToken)
            .await
            .map_err(CheckpointError::Database)?,
    }
    let actual = match store
        .get_kv_data(StateStoreDataKey::SyncToken)
        .await
        .map_err(CheckpointError::Database)?
    {
        Some(StateStoreDataValue::SyncToken(token)) => Some(token),
        None => None,
        _ => return Err(CheckpointError::Invalid),
    };
    if actual != committed.token {
        return Err(CheckpointError::Invalid);
    }
    let _guard = backend.mutation_lock.lock().await;
    if cursor(backend).await? != committed || checkpoint(backend).await? != in_flight {
        return Err(CheckpointError::Invalid);
    }
    if clear_checkpoint && in_flight.is_some() {
        backend
            .write(vec![Mutation::Delete {
                namespace: NAMESPACE.into(),
                key: CHECKPOINT.to_vec(),
            }])
            .await
            .map_err(CheckpointError::Database)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn legacy_wrapper_still_requires_explicit_cursor_initialization() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let checkpoint = DurableCheckpoint::open(root.path(), &"a".repeat(64)).unwrap();
        assert!(checkpoint.committed_token().await.is_err());
        drop(
            matrix_sdk_sqlite::SqliteStateStore::open(root.path(), Some(&"a".repeat(64)))
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
                let path = root.path().join(name);
                if path.exists() {
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
                }
            }
        }
        checkpoint.initialize_cursor(&"a".repeat(64)).await.unwrap();
        assert_eq!(checkpoint.committed_token().await.unwrap(), None);
        checkpoint.begin(None).await.unwrap();
        assert!(checkpoint.begin(None).await.is_err());
        let path = root.path().join("sync-token-checkpoint");
        let before = std::fs::read(&path).unwrap();
        let readonly = SyncCheckpoint::open_read_only(root.path(), &"a".repeat(64)).unwrap();
        assert_eq!(readonly.committed_token().unwrap(), None);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "Read-only migration constructor must preserve the unfinished source checkpoint"
        );
        assert!(SyncCheckpoint::open_read_only(root.path(), &"b".repeat(64)).is_err());
        checkpoint.complete().await.unwrap();
        let incomplete = root
            .path()
            .join(".atomic-sync-token-cursor-00000000000000000000000000000000.tmp");
        std::fs::write(&incomplete, b"synthetic incomplete checkpoint").unwrap();
        assert!(SyncCheckpoint::open_read_only(root.path(), &"a".repeat(64)).is_err());
        assert!(
            incomplete.exists(),
            "Migration must not clean the source backup"
        );
    }

    async fn fixture() -> Arc<Backend> {
        use personal_consultant_matrix_mysql_store::DatabaseConfig;
        let path = std::env::var("MATRIX_MYSQL_TEST_CONFIG").expect("Use isolated MySQL harness");
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
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
        Backend::provision(&pool, id, b"synthetic-checkpoint", &[7; 32])
            .await
            .unwrap();
        Arc::new(
            Backend::open(pool, id, b"synthetic-checkpoint", &[7; 32], 120_000)
                .await
                .unwrap(),
        )
    }
    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn closed_backend_is_not_misreported_as_corrupt_checkpoint() {
        let backend = fixture().await;
        DurableCheckpoint::initialize_mysql(backend.clone(), None, None)
            .await
            .unwrap();
        backend.close().await.unwrap();
        assert!(matches!(
            DurableCheckpoint::open_mysql(backend).await,
            Err(CheckpointError::Database(
                personal_consultant_matrix_mysql_store::StoreError::Closed
            ))
        ));
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn missing_sql_cursor_blocks_open_and_duplicate_initialization_is_rejected() {
        let backend = fixture().await;
        assert!(
            DurableCheckpoint::from_mysql(Arc::clone(&backend))
                .await
                .is_err()
        );
        let checkpoint = DurableCheckpoint::initialize_mysql(Arc::clone(&backend), None, None)
            .await
            .unwrap();
        assert!(
            DurableCheckpoint::initialize_mysql(Arc::clone(&backend), None, None)
                .await
                .is_err()
        );
        assert_eq!(checkpoint.committed_token().await.unwrap(), None);
        checkpoint.initialize_cursor("").await.unwrap();
        backend.close().await.unwrap();
    }
    #[tokio::test]
    #[ignore = "requires isolated MySQL schema"]
    async fn interrupted_batch_rewinds_sdk_to_committed_cursor_but_keeps_accepted_batch() {
        let backend = fixture().await;
        let checkpoint = DurableCheckpoint::initialize_mysql(
            Arc::clone(&backend),
            Some("before".into()),
            Some("$before:example".into()),
        )
        .await
        .unwrap();
        checkpoint.begin(Some("before".into())).await.unwrap();
        let store = MySqlStateStore::new(Arc::clone(&backend));
        store
            .set_kv_data(
                StateStoreDataKey::SyncToken,
                StateStoreDataValue::SyncToken("sdk-advanced-before-journal".into()),
            )
            .await
            .unwrap();
        checkpoint.recover_before_client("").await.unwrap();
        assert!(
            matches!(store.get_kv_data(StateStoreDataKey::SyncToken).await.unwrap(),
            Some(StateStoreDataValue::SyncToken(token)) if token == "before")
        );
        checkpoint.begin(Some("before".into())).await.unwrap();
        checkpoint
            .commit_cursor(
                "after-durable-journal".into(),
                Some("$after:example".into()),
            )
            .await
            .unwrap();
        // Crash after durable cursor commit but before clearing checkpoint.
        backend.close().await.unwrap();
        backend.reopen().await.unwrap();
        checkpoint.recover_before_client("").await.unwrap();
        assert_eq!(
            checkpoint.committed_token().await.unwrap(),
            Some("after-durable-journal".into())
        );
        assert!(
            matches!(store.get_kv_data(StateStoreDataKey::SyncToken).await.unwrap(),
            Some(StateStoreDataValue::SyncToken(token)) if token == "after-durable-journal")
        );
        assert!(checkpoint.complete().await.is_err());
        backend.close().await.unwrap();
    }
}
