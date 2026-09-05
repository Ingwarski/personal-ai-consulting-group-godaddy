use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, AeadCore, KeyInit, OsRng},
};
use matrix_sdk_base::store::{StateStore, StateStoreDataKey, StateStoreDataValue};
use matrix_sdk_sqlite::SqliteStateStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const CHECKPOINT_FILE: &str = "sync-token-checkpoint";
const CURSOR_FILE: &str = "sync-token-cursor";
const MAX_CHECKPOINT_BYTES: u64 = 20 * 1024;

#[derive(Debug, Error)]
#[error("sync checkpoint is unavailable")]
pub struct CheckpointError;

#[derive(Clone)]
pub struct SyncCheckpoint {
    root: PathBuf,
    path: PathBuf,
    cipher: XChaCha20Poly1305,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct CheckpointRecord {
    previous_token: Option<String>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct CursorRecord {
    token: Option<String>,
    room_event_id: Option<String>,
}

impl SyncCheckpoint {
    pub fn open(root: &Path, secret_key: &str) -> Result<Self, CheckpointError> {
        crate::lock::ensure_private_directory(root).map_err(|_| CheckpointError)?;
        crate::lock::cleanup_atomic_temps(root, |target| {
            matches!(target, CHECKPOINT_FILE | CURSOR_FILE)
        })
        .map_err(|_| CheckpointError)?;
        if !crate::config::valid_secret_key(secret_key) {
            return Err(CheckpointError);
        }
        let key_material = hex::decode(secret_key).map_err(|_| CheckpointError)?;
        let key = Sha256::digest(
            [
                b"personal-consultant/sync-checkpoint/v1".as_slice(),
                key_material.as_slice(),
            ]
            .concat(),
        );
        Ok(Self {
            root: root.to_path_buf(),
            path: root.join(CHECKPOINT_FILE),
            cipher: XChaCha20Poly1305::new(&key),
        })
    }

    pub fn begin(&self, previous_token: Option<String>) -> Result<(), CheckpointError> {
        if previous_token.as_ref().is_some_and(|token| {
            token.is_empty() || token.len() > 16 * 1024 || token.contains('\0')
        }) {
            return Err(CheckpointError);
        }
        let plaintext = serde_json::to_vec(&CheckpointRecord { previous_token })
            .map_err(|_| CheckpointError)?;
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_ref())
            .map_err(|_| CheckpointError)?;
        let mut bytes = nonce.to_vec();
        bytes.extend_from_slice(&ciphertext);
        crate::lock::atomic_create_private(&self.path, &bytes).map_err(|_| CheckpointError)
    }

    pub fn complete(&self) -> Result<(), CheckpointError> {
        crate::lock::verify_private_path(&self.path).map_err(|_| CheckpointError)?;
        fs::remove_file(&self.path).map_err(|_| CheckpointError)?;
        sync_directory(&self.root)
    }

    pub async fn initialize_cursor(&self, secret_key: &str) -> Result<(), CheckpointError> {
        let state_store = SqliteStateStore::open(&self.root, Some(secret_key))
            .await
            .map_err(|_| CheckpointError)?;
        let cursor_exists = self.root.join(CURSOR_FILE).exists();
        let token = if cursor_exists {
            self.committed_token()?
        } else {
            match state_store
                .get_kv_data(StateStoreDataKey::SyncToken)
                .await
                .map_err(|_| CheckpointError)?
            {
                Some(StateStoreDataValue::SyncToken(token)) => Some(token),
                None => None,
                _ => return Err(CheckpointError),
            }
        };
        match token.as_ref() {
            Some(token) => state_store
                .set_kv_data(
                    StateStoreDataKey::SyncToken,
                    StateStoreDataValue::SyncToken(token.clone()),
                )
                .await
                .map_err(|_| CheckpointError)?,
            None => state_store
                .remove_kv_data(StateStoreDataKey::SyncToken)
                .await
                .map_err(|_| CheckpointError)?,
        }
        let aligned = match state_store
            .get_kv_data(StateStoreDataKey::SyncToken)
            .await
            .map_err(|_| CheckpointError)?
        {
            Some(StateStoreDataValue::SyncToken(token)) => Some(token),
            None => None,
            _ => return Err(CheckpointError),
        };
        if aligned != token {
            return Err(CheckpointError);
        }
        drop(state_store);
        sync_sqlite_files(&self.root)?;
        if cursor_exists {
            Ok(())
        } else {
            self.write_cursor(
                &CursorRecord {
                    token,
                    room_event_id: None,
                },
                true,
            )
        }
    }

    pub fn committed_token(&self) -> Result<Option<String>, CheckpointError> {
        Ok(self.committed_cursor()?.0)
    }

    pub fn committed_cursor(&self) -> Result<(Option<String>, Option<String>), CheckpointError> {
        let path = self.root.join(CURSOR_FILE);
        let plaintext = self.decrypt_file(&path)?;
        let record: CursorRecord =
            serde_json::from_slice(&plaintext).map_err(|_| CheckpointError)?;
        validate_token(record.token.as_deref())?;
        validate_room_event_anchor(record.room_event_id.as_deref())?;
        Ok((record.token, record.room_event_id))
    }

    pub fn commit_cursor(
        &self,
        token: String,
        room_event_id: Option<String>,
    ) -> Result<(), CheckpointError> {
        validate_token(Some(&token))?;
        self.write_cursor(
            &CursorRecord {
                token: Some(token),
                room_event_id,
            },
            false,
        )
    }

    pub async fn recover_before_client(&self, secret_key: &str) -> Result<(), CheckpointError> {
        if !self.path.exists() {
            return Ok(());
        }
        let record = self.load()?;
        let state_store = SqliteStateStore::open(&self.root, Some(secret_key))
            .await
            .map_err(|_| CheckpointError)?;
        match record.previous_token.as_ref() {
            Some(token) => state_store
                .set_kv_data(
                    StateStoreDataKey::SyncToken,
                    StateStoreDataValue::SyncToken(token.clone()),
                )
                .await
                .map_err(|_| CheckpointError)?,
            None => state_store
                .remove_kv_data(StateStoreDataKey::SyncToken)
                .await
                .map_err(|_| CheckpointError)?,
        }
        let restored = state_store
            .get_kv_data(StateStoreDataKey::SyncToken)
            .await
            .map_err(|_| CheckpointError)?;
        let restored = match restored {
            Some(StateStoreDataValue::SyncToken(token)) => Some(token),
            None => None,
            _ => return Err(CheckpointError),
        };
        if restored != record.previous_token {
            return Err(CheckpointError);
        }
        drop(state_store);
        sync_sqlite_files(&self.root)?;
        self.complete()
    }

    fn load(&self) -> Result<CheckpointRecord, CheckpointError> {
        let plaintext = self.decrypt_file(&self.path)?;
        let record: CheckpointRecord =
            serde_json::from_slice(&plaintext).map_err(|_| CheckpointError)?;
        validate_token(record.previous_token.as_deref())?;
        Ok(record)
    }

    fn decrypt_file(&self, path: &Path) -> Result<Vec<u8>, CheckpointError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| CheckpointError)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_CHECKPOINT_BYTES
        {
            return Err(CheckpointError);
        }
        let bytes = crate::lock::read_private_file(path, MAX_CHECKPOINT_BYTES)
            .map_err(|_| CheckpointError)?;
        if bytes.len() <= 24 {
            return Err(CheckpointError);
        }
        self.cipher
            .decrypt(XNonce::from_slice(&bytes[..24]), &bytes[24..])
            .map_err(|_| CheckpointError)
    }

    fn write_cursor(&self, record: &CursorRecord, create: bool) -> Result<(), CheckpointError> {
        validate_token(record.token.as_deref())?;
        validate_room_event_anchor(record.room_event_id.as_deref())?;
        let path = self.root.join(CURSOR_FILE);
        if !create {
            crate::lock::verify_private_path(&path).map_err(|_| CheckpointError)?;
        }
        let plaintext = serde_json::to_vec(record).map_err(|_| CheckpointError)?;
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_ref())
            .map_err(|_| CheckpointError)?;
        let mut bytes = nonce.to_vec();
        bytes.extend_from_slice(&ciphertext);
        if create {
            crate::lock::atomic_create_private(&path, &bytes).map_err(|_| CheckpointError)
        } else {
            crate::lock::atomic_replace_private(&path, &bytes).map_err(|_| CheckpointError)
        }
    }
}

fn validate_room_event_anchor(anchor: Option<&str>) -> Result<(), CheckpointError> {
    if anchor.is_some_and(|event_id| {
        !event_id.starts_with('$') || event_id.len() > 255 || !event_id.is_ascii()
    }) {
        return Err(CheckpointError);
    }
    Ok(())
}

fn validate_token(token: Option<&str>) -> Result<(), CheckpointError> {
    if token
        .is_some_and(|token| token.is_empty() || token.len() > 16 * 1024 || token.contains('\0'))
    {
        return Err(CheckpointError);
    }
    Ok(())
}

fn sync_sqlite_files(root: &Path) -> Result<(), CheckpointError> {
    for name in ["matrix-sdk-state.sqlite3", "matrix-sdk-state.sqlite3-wal"] {
        let path = root.join(name);
        if path.exists() {
            crate::lock::verify_private_path(&path).map_err(|_| CheckpointError)?;
            OpenOptions::new()
                .read(true)
                .open(path)
                .and_then(|file| file.sync_all())
                .map_err(|_| CheckpointError)?;
        }
    }
    sync_directory(root)
}

fn sync_directory(path: &Path) -> Result<(), CheckpointError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| CheckpointError)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn private_temp() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        temp
    }

    #[cfg(unix)]
    fn secure_state_files(root: &Path) {
        use std::os::unix::fs::PermissionsExt;
        for name in ["matrix-sdk-state.sqlite3", "matrix-sdk-state.sqlite3-wal"] {
            let path = root.join(name);
            if path.exists() {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
    }

    #[test]
    fn checkpoint_begin_is_exclusive_authenticated_and_complete_is_durable() {
        let temp = private_temp();
        let checkpoint = SyncCheckpoint::open(temp.path(), KEY).unwrap();
        checkpoint.begin(Some("previous".into())).unwrap();
        assert!(checkpoint.begin(Some("other".into())).is_err());
        assert!(
            !fs::read(&checkpoint.path)
                .unwrap()
                .windows("previous".len())
                .any(|window| window == b"previous")
        );
        checkpoint.complete().unwrap();
        assert!(!checkpoint.path.exists());
    }

    #[tokio::test]
    async fn crash_recovery_restores_token_and_none_before_client_construction() {
        for previous in [Some("old-token".to_owned()), None] {
            let temp = private_temp();
            let checkpoint = SyncCheckpoint::open(temp.path(), KEY).unwrap();
            let store = SqliteStateStore::open(temp.path(), Some(KEY))
                .await
                .unwrap();
            store
                .set_kv_data(
                    StateStoreDataKey::SyncToken,
                    StateStoreDataValue::SyncToken("advanced-token".into()),
                )
                .await
                .unwrap();
            drop(store);
            #[cfg(unix)]
            for name in ["matrix-sdk-state.sqlite3", "matrix-sdk-state.sqlite3-wal"] {
                use std::os::unix::fs::PermissionsExt;
                let path = temp.path().join(name);
                if path.exists() {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
                }
            }
            checkpoint.begin(previous.clone()).unwrap();
            checkpoint.recover_before_client(KEY).await.unwrap();
            assert!(!checkpoint.path.exists());
            let restored = SqliteStateStore::open(temp.path(), Some(KEY))
                .await
                .unwrap();
            let found = match restored
                .get_kv_data(StateStoreDataKey::SyncToken)
                .await
                .unwrap()
            {
                Some(StateStoreDataValue::SyncToken(token)) => Some(token),
                None => None,
                _ => panic!("unexpected state-store value"),
            };
            assert_eq!(found, previous);
        }
    }

    #[tokio::test]
    async fn application_cursor_ignores_sdk_advance_until_explicit_commit() {
        let temp = private_temp();
        let checkpoint = SyncCheckpoint::open(temp.path(), KEY).unwrap();
        let store = SqliteStateStore::open(temp.path(), Some(KEY))
            .await
            .unwrap();
        store
            .set_kv_data(
                StateStoreDataKey::SyncToken,
                StateStoreDataValue::SyncToken("committed-old".into()),
            )
            .await
            .unwrap();
        drop(store);
        #[cfg(unix)]
        secure_state_files(temp.path());
        checkpoint.initialize_cursor(KEY).await.unwrap();
        assert_eq!(
            checkpoint.committed_token().unwrap().as_deref(),
            Some("committed-old")
        );

        let store = SqliteStateStore::open(temp.path(), Some(KEY))
            .await
            .unwrap();
        store
            .set_kv_data(
                StateStoreDataKey::SyncToken,
                StateStoreDataValue::SyncToken("sdk-advanced".into()),
            )
            .await
            .unwrap();
        drop(store);
        checkpoint.initialize_cursor(KEY).await.unwrap();
        assert_eq!(
            checkpoint.committed_token().unwrap().as_deref(),
            Some("committed-old")
        );
        let aligned = SqliteStateStore::open(temp.path(), Some(KEY))
            .await
            .unwrap();
        let aligned_token = match aligned
            .get_kv_data(StateStoreDataKey::SyncToken)
            .await
            .unwrap()
        {
            Some(StateStoreDataValue::SyncToken(token)) => Some(token),
            None => None,
            _ => panic!("unexpected state-store value"),
        };
        assert_eq!(aligned_token.as_deref(), Some("committed-old"));
        drop(aligned);
        checkpoint
            .commit_cursor("committed-new".into(), Some("$event:matrix.org".into()))
            .unwrap();
        assert_eq!(
            checkpoint.committed_token().unwrap().as_deref(),
            Some("committed-new")
        );
        assert_eq!(
            checkpoint.committed_cursor().unwrap().1.as_deref(),
            Some("$event:matrix.org")
        );
    }

    #[tokio::test]
    async fn valid_anchor_round_trips_and_invalid_commit_preserves_prior_cursor() {
        let temp = private_temp();
        let checkpoint = SyncCheckpoint::open(temp.path(), KEY).unwrap();
        let store = SqliteStateStore::open(temp.path(), Some(KEY))
            .await
            .unwrap();
        drop(store);
        #[cfg(unix)]
        secure_state_files(temp.path());
        checkpoint.initialize_cursor(KEY).await.unwrap();
        checkpoint
            .commit_cursor("baseline".into(), Some("$baseline:matrix.org".into()))
            .unwrap();
        assert_eq!(
            checkpoint.committed_cursor().unwrap(),
            (Some("baseline".into()), Some("$baseline:matrix.org".into()))
        );
        assert!(
            checkpoint
                .commit_cursor("bad".into(), Some("not-a-matrix-event".into()))
                .is_err()
        );
        assert_eq!(
            checkpoint.committed_cursor().unwrap(),
            (Some("baseline".into()), Some("$baseline:matrix.org".into()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn checkpoint_open_removes_only_known_private_atomic_orphans() {
        use std::os::unix::fs::PermissionsExt;
        let temp = private_temp();
        let orphan = temp.path().join(format!(
            ".atomic-sync-token-checkpoint-{}.tmp",
            "a".repeat(32)
        ));
        fs::write(&orphan, b"torn").unwrap();
        fs::set_permissions(&orphan, fs::Permissions::from_mode(0o600)).unwrap();
        SyncCheckpoint::open(temp.path(), KEY).unwrap();
        assert!(!orphan.exists());

        let unknown = temp
            .path()
            .join(format!(".atomic-unrelated-{}.tmp", "b".repeat(32)));
        fs::write(&unknown, b"private").unwrap();
        fs::set_permissions(&unknown, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(SyncCheckpoint::open(temp.path(), KEY).is_err());
        assert!(unknown.exists());
    }
}
