use crate::StoreError;
use matrix_sdk_store_encryption::StoreCipher;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    ConnectOptions, MySql, MySqlPool, Row, Transaction,
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode},
};
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};
use tokio::sync::{Mutex, RwLock, RwLockReadGuard};
use zeroize::Zeroizing;

pub const SCHEMA_SQL: &str = include_str!("../schema.sql");
const VERSION: u32 = 1;
const MAX_VALUE: usize = 16 * 1024 * 1024;
const MAX_BATCH: usize = 64 * 1024 * 1024;
const PAGE_SIZE: i64 = 128;
const PREFIX_BYTES: usize = 16;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(15);

fn classify_connection_error(error: &sqlx::Error) -> &'static str {
    match error {
        sqlx::Error::Tls(_) => "mysql_tls_failed",
        sqlx::Error::Database(_) => "mysql_login_or_database_failed",
        sqlx::Error::Configuration(_) | sqlx::Error::InvalidArgument(_) => {
            "mysql_client_configuration_failed"
        }
        sqlx::Error::Protocol(_) => "mysql_protocol_failed",
        sqlx::Error::Io(error) => match error.kind() {
            std::io::ErrorKind::NotFound
            | std::io::ErrorKind::AddrNotAvailable
            | std::io::ErrorKind::InvalidInput => "mysql_address_failed",
            std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::HostUnreachable
            | std::io::ErrorKind::NetworkUnreachable
            | std::io::ErrorKind::NotConnected => "mysql_connection_refused",
            std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::BrokenPipe => "mysql_connection_closed",
            std::io::ErrorKind::PermissionDenied => "mysql_socket_denied",
            std::io::ErrorKind::TimedOut => "mysql_connection_timeout",
            _ => "mysql_io_failed",
        },
        _ => "mysql_connection_failed",
    }
}

fn pool_options(max_connections: u32) -> MySqlPoolOptions {
    MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|connection, _| {
            Box::pin(async move {
                // Bound server-side row-lock waits too; a client timeout alone must
                // not leave a transaction waiting indefinitely on the server.
                sqlx::query("SET SESSION innodb_lock_wait_timeout=5, max_execution_time=10000")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
}

/// No Debug: the password and connection parameters are never diagnostics.
pub struct DatabaseConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: Zeroizing<String>,
    pub ca_file: Option<std::path::PathBuf>,
}

impl DatabaseConfig {
    /// Setup-only, read-only probe. Never returns server text or credentials.
    pub async fn probe(&self) -> Result<(), &'static str> {
        use sqlx::Connection;
        let mut options = MySqlConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .database(&self.database)
            .username(&self.username)
            .password(&self.password)
            .ssl_mode(MySqlSslMode::VerifyIdentity)
            .disable_statement_logging();
        if let Some(path) = &self.ca_file {
            options = options.ssl_ca(path);
        }
        let mut connection = tokio::time::timeout(
            Duration::from_secs(10),
            sqlx::MySqlConnection::connect_with(&options),
        )
        .await
        .map_err(|_| "mysql_connection_timeout")?
        .map_err(|error| classify_connection_error(&error))?;
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            sqlx::query("SET SESSION innodb_lock_wait_timeout=5, max_execution_time=10000")
                .execute(&mut connection),
        )
        .await
        .map_err(|_| "mysql_session_timeout")?
        .map_err(|_| "mysql_session_configuration_failed");
        let _ = connection.close().await;
        result.map(|_| ())
    }

    pub fn from_env() -> Result<Self, StoreError> {
        let required = |name| {
            std::env::var(name)
                .ok()
                .filter(|s| !s.is_empty())
                .ok_or(StoreError::InvalidConfiguration)
        };
        let port_text = required("DB_PORT")?;
        let port: u16 = port_text
            .parse()
            .map_err(|_| StoreError::InvalidConfiguration)?;
        if port == 0 || port.to_string() != port_text {
            return Err(StoreError::InvalidConfiguration);
        }
        Ok(Self {
            host: required("DB_HOST")?,
            port,
            database: required("DB_NAME")?,
            username: required("DB_USER")?,
            password: Zeroizing::new(required("DB_PASSWORD")?),
            ca_file: std::env::var_os("DB_SSL_CA_FILE").map(Into::into),
        })
    }

    pub async fn connect(&self) -> Result<MySqlPool, StoreError> {
        if self.host.is_empty()
            || self.database.is_empty()
            || self.username.is_empty()
            || self.port == 0
        {
            return Err(StoreError::InvalidConfiguration);
        }
        let mut options = MySqlConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .database(&self.database)
            .username(&self.username)
            .password(&self.password)
            .ssl_mode(MySqlSslMode::VerifyIdentity)
            .disable_statement_logging();
        if let Some(path) = &self.ca_file {
            options = options.ssl_ca(path);
        }
        pool_options(4)
            .connect_with(options)
            .await
            .map_err(Into::into)
    }
}

#[cfg(test)]
mod connection_error_tests {
    use super::classify_connection_error;
    use std::io::{Error, ErrorKind};

    #[test]
    fn classifies_transport_failures_without_exposing_error_text() {
        for (kind, code) in [
            (ErrorKind::AddrNotAvailable, "mysql_address_failed"),
            (ErrorKind::ConnectionRefused, "mysql_connection_refused"),
            (ErrorKind::ConnectionReset, "mysql_connection_closed"),
            (ErrorKind::PermissionDenied, "mysql_socket_denied"),
            (ErrorKind::TimedOut, "mysql_connection_timeout"),
            (ErrorKind::Other, "mysql_io_failed"),
        ] {
            let error = sqlx::Error::Io(Error::new(kind, "secret host and database detail"));
            assert_eq!(classify_connection_error(&error), code);
        }
        assert_eq!(
            classify_connection_error(&sqlx::Error::Protocol("private protocol bytes".into())),
            "mysql_protocol_failed"
        );
        assert_eq!(
            classify_connection_error(&sqlx::Error::Configuration("private config".into())),
            "mysql_client_configuration_failed"
        );
    }
}

/// Every member of a batch commits together, after a DB-time fencing check.
pub enum Mutation {
    Put {
        namespace: String,
        key: Vec<u8>,
        value: Vec<u8>,
    },
    Delete {
        namespace: String,
        key: Vec<u8>,
    },
    Clear {
        namespace: String,
    },
}

pub struct InboxEntry {
    pub key: Vec<u8>,
    pub status: String,
    pub value: Vec<u8>,
}
pub enum InboxMutation {
    Put {
        key: Vec<u8>,
        status: String,
        value: Vec<u8>,
    },
    Delete {
        key: Vec<u8>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    store: [u8; 16],
    schema: u32,
    namespace: String,
    #[serde(with = "serde_bytes")]
    key: Vec<u8>,
    revision: u64,
    #[serde(with = "serde_bytes")]
    value: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    store: [u8; 16],
    schema: u32,
    fingerprint: [u8; 32],
}
#[derive(Serialize, Deserialize)]
struct SdkLease {
    holder: String,
    expires_ms: u64,
    generation: u64,
}

/// One backend instance is one fenced writer. A lost/ambiguous commit poisons
/// it; callers must discard SDK memory and open a new instance, never retry an
/// in-memory cryptographic mutation against unknown durable state.
pub struct Backend {
    pool: std::sync::RwLock<MySqlPool>,
    options: MySqlConnectOptions,
    store: [u8; 16],
    cipher: StoreCipher,
    holder: [u8; 16],
    epoch: AtomicU64,
    fingerprint: [u8; 32],
    lease_ms: u32,
    closed: RwLock<bool>,
    poisoned: AtomicBool,
    pub mutation_lock: Mutex<()>,
    #[cfg(feature = "integration-tests")]
    lose_commit_response_once: AtomicBool,
    #[cfg(feature = "integration-tests")]
    disconnect_before_commit_once: AtomicBool,
}

impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Backend").finish_non_exhaustive()
    }
}

impl Backend {
    /// Bounded namespace inventory for offline migration read-back. This reads
    /// metadata only; values are subsequently authenticated through scan().
    pub async fn record_namespaces(&self) -> Result<Vec<String>, StoreError> {
        self.deadline(async {
            let _guard=self.guard().await?;let mut tx=self.owned_tx().await?;
            let raw:Vec<Vec<u8>>=sqlx::query_scalar("SELECT DISTINCT namespace FROM pc_matrix_records WHERE store_id=? ORDER BY namespace LIMIT 1025")
                .bind(self.store.as_slice()).fetch_all(&mut *tx).await?;
            if raw.len()>1024{return Err(StoreError::Corrupt);}
            let mut names=Vec::new();
            for bytes in raw {let name=String::from_utf8(bytes).map_err(|_|StoreError::Corrupt)?;self.hash(&name,b"")?;names.push(name);}
            tx.rollback().await?;Ok(names)
        }).await
    }
    /// Explicit additive provisioning command only. Runtime open never calls it.
    pub async fn provision_schema(pool: &MySqlPool) -> Result<(), StoreError> {
        sqlx::raw_sql(SCHEMA_SQL).execute(pool).await?;
        Ok(())
    }
    /// An expired operation poisons this SDK instance. Cancellation cannot tell
    /// whether COMMIT reached MySQL, so in-place retries are forbidden. Pool
    /// closure is initiated and bounded; this is an API deadline, not a claim
    /// that the operating system has already torn down every stalled TCP socket.
    async fn deadline<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, StoreError>>,
    ) -> Result<T, StoreError> {
        match tokio::time::timeout(OPERATION_TIMEOUT, operation).await {
            Ok(result) => result,
            Err(_) => {
                self.poisoned.store(true, Ordering::Release);
                let pool = self
                    .pool
                    .read()
                    .map_err(|_| StoreError::Unavailable)?
                    .clone();
                let _ = tokio::time::timeout(Duration::from_millis(100), pool.close()).await;
                Err(StoreError::Unavailable)
            }
        }
    }

    #[cfg(feature = "integration-tests")]
    pub fn inject_lost_commit_response_once_for_test(&self) {
        self.lose_commit_response_once
            .store(true, Ordering::Release);
    }

    #[cfg(feature = "integration-tests")]
    pub fn inject_disconnect_before_commit_once_for_test(&self) {
        self.disconnect_before_commit_once
            .store(true, Ordering::Release);
    }

    pub async fn inbox_scan(&self) -> Result<Vec<InboxEntry>, StoreError> {
        self.deadline(self.inbox_scan_inner()).await
    }
    pub async fn inbox_write(&self, changes: Vec<InboxMutation>) -> Result<(), StoreError> {
        self.deadline(self.inbox_write_inner(changes)).await
    }
    pub async fn get(&self, namespace: &str, key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.deadline(self.get_inner(namespace, key)).await
    }
    pub async fn scan_prefix(
        &self,
        namespace: &str,
        prefix: &[u8],
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, StoreError> {
        self.deadline(self.scan_prefix_inner(namespace, prefix))
            .await
    }
    pub async fn write(&self, changes: Vec<Mutation>) -> Result<(), StoreError> {
        self.deadline(self.write_inner(changes)).await
    }
    pub async fn renew(&self) -> Result<(), StoreError> {
        self.deadline(self.renew_inner()).await
    }
    pub async fn release(&self) -> Result<(), StoreError> {
        self.deadline(self.release_inner()).await
    }
    pub async fn close(&self) -> Result<(), StoreError> {
        self.deadline(self.close_inner()).await
    }
    pub async fn reopen(&self) -> Result<(), StoreError> {
        self.deadline(self.reopen_inner()).await
    }
    pub async fn check_open(&self) -> Result<(), StoreError> {
        self.deadline(self.check_open_inner()).await
    }
    pub async fn get_size(&self) -> Result<Option<usize>, StoreError> {
        self.deadline(self.get_size_inner()).await
    }
    pub async fn try_take_leased_lock(
        &self,
        duration: u32,
        key: &str,
        holder: &str,
    ) -> Result<Option<u64>, StoreError> {
        self.deadline(self.try_take_leased_lock_inner(duration, key, holder))
            .await
    }

    /// Final candidate cutover only. Caller has already verified every source
    /// family, identity and replay proof; this method does not manufacture them.
    /// Binding, receipt, public account fingerprint and ready marker commit in
    /// the same fenced transaction. Re-activation is always a conflict.
    pub async fn activate_candidate(
        &self,
        binding_json: &[u8],
        account_fingerprint: [u8; 32],
        receipt_json: &[u8],
    ) -> Result<(), StoreError> {
        self.deadline(async {
            let _mutation = self.mutation_lock.lock().await;
            let _guard = self.guard().await?;
            if binding_json.is_empty()
                || receipt_json.is_empty()
                || binding_json.len() > MAX_VALUE
                || receipt_json.len() > MAX_VALUE
            {
                return Err(StoreError::InvalidConfiguration);
            }
            serde_json::from_slice::<serde_json::Value>(binding_json)?;
            serde_json::from_slice::<serde_json::Value>(receipt_json)?;
            let mut tx = self.owned_tx().await?;
            if self
                .get_tx(&mut tx, "app.meta", b"activation")
                .await?
                .is_some()
            {
                return Err(StoreError::Conflict);
            }
            // A complete crypto account is a necessary (not sufficient) check;
            // the caller supplies the broader state/inbox completeness receipt.
            if self
                .get_tx(&mut tx, "crypto.meta", b"account")
                .await?
                .is_none()
            {
                return Err(StoreError::Schema);
            }
            self.put_tx(
                &mut tx,
                "app.meta",
                b"device-binding",
                binding_json.to_vec(),
            )
            .await?;
            self.put_tx(
                &mut tx,
                "app.meta",
                b"import-receipt",
                receipt_json.to_vec(),
            )
            .await?;
            self.put_tx(&mut tx, "app.meta", b"activation", b"ready".to_vec())
                .await?;
            let digest=Sha256::digest(receipt_json);
            let migration_id=&digest[..16];
            let receipt_envelope=rmp_serde::to_vec_named(&Envelope {store:self.store,schema:VERSION,namespace:"migration.active".to_owned(),key:migration_id.to_vec(),revision:1,value:receipt_json.to_vec()}).map_err(|_|StoreError::Corrupt)?;
            let encrypted=self.cipher.encrypt_value_data(receipt_envelope).map_err(|_|StoreError::Corrupt)?;
            let payload=rmp_serde::to_vec_named(&encrypted).map_err(|_|StoreError::Corrupt)?;
            sqlx::query("INSERT INTO pc_matrix_migrations (store_id,migration_id,phase,payload) VALUES (?,?,?,?)")
                .bind(self.store.as_slice()).bind(migration_id).bind(b"active".as_slice()).bind(payload).execute(&mut *tx).await?;
            sqlx::query("UPDATE pc_matrix_stores SET account_fingerprint=? WHERE store_id=?")
                .bind(account_fingerprint.as_slice())
                .bind(self.store.as_slice())
                .execute(&mut *tx)
                .await?;
            self.commit(tx).await
        })
        .await
    }

    /// Rewrap imported legacy ciphers without retaining the old passphrase.
    pub fn legacy_wrapping_key(&self) -> [u8; 32] {
        self.cipher
            .hash_key("pc-matrix-legacy-cipher-wrap-v1", &self.store)
    }

    /// Bounded authenticated journal rows; status is bound into the AEAD purpose.
    async fn inbox_scan_inner(&self) -> Result<Vec<InboxEntry>, StoreError> {
        let _guard = self.guard().await?;
        let mut tx = self.owned_tx().await?;
        let rows=sqlx::query("SELECT event_key,revision,status,CAST(OCTET_LENGTH(payload) AS UNSIGNED) AS size FROM pc_matrix_inbox WHERE store_id=? ORDER BY event_key LIMIT 4161")
            .bind(self.store.as_slice()).fetch_all(&mut *tx).await?;
        if rows.len() > 4160 {
            return Err(StoreError::Corrupt);
        }
        let mut metadata = Vec::with_capacity(rows.len());
        let mut total = 0usize;
        for row in rows {
            let status =
                String::from_utf8(row.try_get("status")?).map_err(|_| StoreError::Corrupt)?;
            if !matches!(status.as_str(), "pending" | "rejected" | "ack") {
                return Err(StoreError::Corrupt);
            }
            let size: u64 = row.try_get("size")?;
            if size > 524_288 {
                return Err(StoreError::Corrupt);
            }
            total = total
                .checked_add(size as usize)
                .ok_or(StoreError::Corrupt)?;
            if total > MAX_BATCH {
                return Err(StoreError::Corrupt);
            }
            let hash: Vec<u8> = row.try_get("event_key")?;
            metadata.push((hash, row.try_get::<u64, _>("revision")?, status));
        }
        let mut output = Vec::with_capacity(metadata.len());
        for page in metadata.chunks(PAGE_SIZE as usize) {
            let mut expected: std::collections::BTreeMap<_, _> = page
                .iter()
                .map(|(key, revision, status)| (key.clone(), (*revision, status.clone())))
                .collect();
            let mut query = sqlx::QueryBuilder::<MySql>::new(
                "SELECT event_key,IF(OCTET_LENGTH(payload)<=524288,payload,NULL) AS payload FROM pc_matrix_inbox WHERE store_id=",
            );
            query
                .push_bind(self.store.as_slice())
                .push(" AND event_key IN (");
            {
                let mut separated = query.separated(",");
                for (key, _, _) in page {
                    separated.push_bind(key);
                }
            }
            query.push(") ORDER BY event_key");
            let values = query.build().fetch_all(&mut *tx).await?;
            if values.len() != page.len() {
                return Err(StoreError::Corrupt);
            }
            for row in values {
                let hash: Vec<u8> = row.try_get("event_key")?;
                let (revision, status) = expected.remove(&hash).ok_or(StoreError::Corrupt)?;
                let payload: Option<Vec<u8>> = row.try_get("payload")?;
                let payload = payload.ok_or(StoreError::Corrupt)?;
                // Event indexing stays stable when pending becomes an ACK, while
                // the encrypted record binds status and the dedicated inbox table.
                let purpose = format!("inbox.{status}");
                let encrypted = rmp_serde::from_slice(&payload).map_err(|_| StoreError::Corrupt)?;
                let clear = Zeroizing::new(
                    self.cipher
                        .decrypt_value_data(encrypted)
                        .map_err(|_| StoreError::Corrupt)?,
                );
                let env: Envelope =
                    rmp_serde::from_slice(&clear).map_err(|_| StoreError::Corrupt)?;
                if env.store != self.store
                    || env.schema != VERSION
                    || env.namespace != purpose
                    || env.revision != revision
                    || self.hash("inbox.index", &env.key)?.as_slice() != hash
                    || env.value.len() > 266_240
                {
                    return Err(StoreError::Corrupt);
                }
                output.push(InboxEntry {
                    key: env.key,
                    status,
                    value: env.value,
                });
            }
        }
        tx.rollback().await?;
        Ok(output)
    }

    /// Caller serializes read/decision/write with mutation_lock. Every change
    /// in the batch, including pending-to-ACK and pruning, commits together.
    async fn inbox_write_inner(&self, changes: Vec<InboxMutation>) -> Result<(), StoreError> {
        let _guard = self.guard().await?;
        if changes.len() > 4161 {
            return Err(StoreError::InvalidConfiguration);
        }
        let mut tx = self.owned_tx().await?;
        let mut total = 0usize;
        for change in changes {
            match change {
                InboxMutation::Delete { key } => {
                    let hash = self.hash("inbox.index", &key)?;
                    sqlx::query("DELETE FROM pc_matrix_inbox WHERE store_id=? AND event_key=?")
                        .bind(self.store.as_slice())
                        .bind(hash.as_slice())
                        .execute(&mut *tx)
                        .await?;
                }
                InboxMutation::Put { key, status, value } => {
                    if !matches!(status.as_str(), "pending" | "rejected" | "ack")
                        || value.len() > 266_240
                        || (status != "pending" && value.len() > 4096)
                    {
                        return Err(StoreError::InvalidConfiguration);
                    }
                    total = total
                        .checked_add(key.len() + value.len())
                        .ok_or(StoreError::InvalidConfiguration)?;
                    if total > MAX_BATCH {
                        return Err(StoreError::InvalidConfiguration);
                    }
                    let hash = self.hash("inbox.index", &key)?;
                    let old: Option<u64> = sqlx::query_scalar(
                        "SELECT revision FROM pc_matrix_inbox WHERE store_id=? AND event_key=?",
                    )
                    .bind(self.store.as_slice())
                    .bind(hash.as_slice())
                    .fetch_optional(&mut *tx)
                    .await?;
                    let revision = old.unwrap_or(0).checked_add(1).ok_or(StoreError::Corrupt)?;
                    let plain = rmp_serde::to_vec_named(&Envelope {
                        store: self.store,
                        schema: VERSION,
                        namespace: format!("inbox.{status}"),
                        key,
                        revision,
                        value,
                    })
                    .map_err(|_| StoreError::Corrupt)?;
                    let encrypted = self
                        .cipher
                        .encrypt_value_data(plain)
                        .map_err(|_| StoreError::Corrupt)?;
                    let payload =
                        rmp_serde::to_vec_named(&encrypted).map_err(|_| StoreError::Corrupt)?;
                    sqlx::query("INSERT INTO pc_matrix_inbox (store_id,event_key,revision,status,payload) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),status=VALUES(status),payload=VALUES(payload)")
                        .bind(self.store.as_slice()).bind(hash.as_slice()).bind(revision).bind(status.as_bytes()).bind(payload).execute(&mut *tx).await?;
                }
            }
        }
        self.commit(tx).await
    }

    /// Explicit fresh-store provisioning, not a runtime fallback. Caller must
    /// have separately authorized NEW identity, or use the migration importer.
    /// Existing IDs conflict; neither records nor keys are overwritten.
    pub async fn provision(
        pool: &MySqlPool,
        store: [u8; 16],
        identity: &[u8],
        key: &[u8; 32],
    ) -> Result<(), StoreError> {
        if identity.is_empty() {
            return Err(StoreError::InvalidConfiguration);
        }
        let cipher = StoreCipher::new().map_err(|_| StoreError::Corrupt)?;
        let export = cipher
            .export_with_key(key)
            .map_err(|_| StoreError::Corrupt)?;
        let fingerprint: [u8; 32] = Sha256::digest(identity).into();
        let binding = cipher
            .encrypt_value(&Binding {
                store,
                schema: VERSION,
                fingerprint,
            })
            .map_err(|_| StoreError::Corrupt)?;
        sqlx::query("INSERT INTO pc_matrix_stores (store_id,schema_version,identity_fingerprint,cipher_export,binding) VALUES (?,?,?,?,?)")
            .bind(store.as_slice()).bind(VERSION).bind(fingerprint.as_slice()).bind(export).bind(binding).execute(pool).await
            .map_err(|e| if e.as_database_error().is_some_and(|d| d.is_unique_violation()) {StoreError::Conflict} else {StoreError::Unavailable})?;
        Ok(())
    }

    /// Does not create tables/store/account. Identity/key verification happens
    /// before acquiring ownership. An existing live writer is never displaced.
    pub async fn open(
        pool: MySqlPool,
        store: [u8; 16],
        identity: &[u8],
        key: &[u8; 32],
        lease_ms: u32,
    ) -> Result<Self, StoreError> {
        tokio::time::timeout(
            OPERATION_TIMEOUT,
            Self::open_inner(pool, store, identity, key, lease_ms),
        )
        .await
        .map_err(|_| StoreError::Unavailable)?
    }

    async fn open_inner(
        pool: MySqlPool,
        store: [u8; 16],
        identity: &[u8],
        key: &[u8; 32],
        lease_ms: u32,
    ) -> Result<Self, StoreError> {
        if identity.is_empty() || !(100..=300_000).contains(&lease_ms) {
            return Err(StoreError::InvalidConfiguration);
        }
        // Each store owns its pool, so SDK close cannot close another store's
        // connections. Preserve verified TLS and disabled query logging.
        let options = (*pool.connect_options()).clone();
        let pool = pool_options(2).connect_lazy_with(options.clone());
        let mut tx = pool.begin().await?;
        let row = sqlx::query("SELECT schema_version,identity_fingerprint,cipher_export,binding,fence,lease_expires_ms FROM pc_matrix_stores WHERE store_id=? FOR UPDATE")
            .bind(store.as_slice()).fetch_optional(&mut *tx).await?.ok_or(StoreError::Schema)?;
        let fingerprint: [u8; 32] = Sha256::digest(identity).into();
        let version: u32 = row.try_get("schema_version")?;
        let actual: Vec<u8> = row.try_get("identity_fingerprint")?;
        if version != VERSION || actual != fingerprint {
            return Err(StoreError::Schema);
        }
        let export: Vec<u8> = row.try_get("cipher_export")?;
        let cipher = StoreCipher::import_with_key(key, &export).map_err(|_| StoreError::Corrupt)?;
        let encoded: Vec<u8> = row.try_get("binding")?;
        let binding: Binding = cipher
            .decrypt_value(&encoded)
            .map_err(|_| StoreError::Corrupt)?;
        if binding.store != store || binding.schema != VERSION || binding.fingerprint != fingerprint
        {
            return Err(StoreError::Corrupt);
        }
        let now = db_now(&mut tx).await?;
        let expires: u64 = row.try_get("lease_expires_ms")?;
        if expires > now {
            return Err(StoreError::Conflict);
        }
        let epoch = row
            .try_get::<u64, _>("fence")?
            .checked_add(1)
            .ok_or(StoreError::Corrupt)?;
        let holder = *uuid::Uuid::new_v4().as_bytes();
        sqlx::query(
            "UPDATE pc_matrix_stores SET fence=?,owner_nonce=?,lease_expires_ms=? WHERE store_id=?",
        )
        .bind(epoch)
        .bind(holder.as_slice())
        .bind(now + u64::from(lease_ms))
        .bind(store.as_slice())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Self {
            pool: std::sync::RwLock::new(pool),
            options,
            store,
            cipher,
            holder,
            epoch: AtomicU64::new(epoch),
            fingerprint,
            lease_ms,
            closed: RwLock::new(false),
            poisoned: AtomicBool::new(false),
            mutation_lock: Mutex::new(()),
            #[cfg(feature = "integration-tests")]
            lose_commit_response_once: AtomicBool::new(false),
            #[cfg(feature = "integration-tests")]
            disconnect_before_commit_once: AtomicBool::new(false),
        })
    }

    async fn guard(&self) -> Result<RwLockReadGuard<'_, bool>, StoreError> {
        let guard = self.closed.read().await;
        if *guard {
            return Err(StoreError::Closed);
        }
        if self.poisoned.load(Ordering::Acquire) {
            return Err(StoreError::Fenced);
        }
        Ok(guard)
    }

    async fn owned_tx(&self) -> Result<Transaction<'static, MySql>, StoreError> {
        let pool = self
            .pool
            .read()
            .map_err(|_| StoreError::Unavailable)?
            .clone();
        let mut tx = pool.begin().await?;
        self.check_owner(&mut tx).await?;
        Ok(tx)
    }

    async fn check_owner(&self, tx: &mut Transaction<'_, MySql>) -> Result<(), StoreError> {
        let row=sqlx::query("SELECT fence,owner_nonce,lease_expires_ms FROM pc_matrix_stores WHERE store_id=? FOR UPDATE")
            .bind(self.store.as_slice()).fetch_optional(&mut **tx).await?.ok_or(StoreError::Fenced)?;
        let epoch: u64 = row.try_get("fence")?;
        let holder: Option<Vec<u8>> = row.try_get("owner_nonce")?;
        let expiry: u64 = row.try_get("lease_expires_ms")?;
        if epoch != self.epoch.load(Ordering::Acquire)
            || holder.as_deref() != Some(self.holder.as_slice())
            || expiry <= db_now(tx).await?
        {
            self.poisoned.store(true, Ordering::Release);
            return Err(StoreError::Fenced);
        }
        Ok(())
    }

    async fn commit(&self, mut tx: Transaction<'_, MySql>) -> Result<(), StoreError> {
        self.check_owner(&mut tx).await?;
        #[cfg(feature = "integration-tests")]
        if self
            .disconnect_before_commit_once
            .swap(false, Ordering::AcqRel)
        {
            let connection_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
                .fetch_one(&mut *tx)
                .await?;
            let pool = self
                .pool
                .read()
                .map_err(|_| StoreError::Unavailable)?
                .clone();
            // Numeric server-returned ID, no external identifier interpolation.
            sqlx::query(&format!("KILL CONNECTION {connection_id}"))
                .execute(&pool)
                .await?;
        }
        tx.commit().await.map_err(|_| {
            self.poisoned.store(true, Ordering::Release);
            StoreError::Unavailable
        })?;
        // Deterministic fault after a real successful COMMIT. Tests explicitly
        // label this a response-loss simulation, not actual TCP interruption.
        #[cfg(feature = "integration-tests")]
        if self.lose_commit_response_once.swap(false, Ordering::AcqRel) {
            self.poisoned.store(true, Ordering::Release);
            return Err(StoreError::Unavailable);
        }
        Ok(())
    }

    fn hash(&self, namespace: &str, key: &[u8]) -> Result<[u8; 32], StoreError> {
        if namespace.is_empty()
            || namespace.len() > 64
            || !namespace.is_ascii()
            || key.len() > 65_536
        {
            return Err(StoreError::InvalidConfiguration);
        }
        Ok(self
            .cipher
            .hash_key(&format!("pc-matrix-record-v1/{namespace}"), key))
    }

    fn decode(
        &self,
        namespace: &str,
        hash: &[u8],
        revision: u64,
        payload: &[u8],
    ) -> Result<(Vec<u8>, Vec<u8>), StoreError> {
        if payload.len() > MAX_VALUE * 2 {
            return Err(StoreError::Corrupt);
        }
        let encrypted = rmp_serde::from_slice(payload).map_err(|_| StoreError::Corrupt)?;
        let plaintext = Zeroizing::new(
            self.cipher
                .decrypt_value_data(encrypted)
                .map_err(|_| StoreError::Corrupt)?,
        );
        let env: Envelope = rmp_serde::from_slice(&plaintext).map_err(|_| StoreError::Corrupt)?;
        if env.store != self.store
            || env.schema != VERSION
            || env.namespace != namespace
            || env.revision != revision
            || env.value.len() > MAX_VALUE
            || self.hash(namespace, &env.key)?.as_slice() != hash
        {
            return Err(StoreError::Corrupt);
        }
        Ok((env.key, env.value))
    }

    async fn get_tx(
        &self,
        tx: &mut Transaction<'_, MySql>,
        namespace: &str,
        key: &[u8],
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let hash = self.hash(namespace, key)?;
        let row=sqlx::query("SELECT revision,OCTET_LENGTH(payload) AS payload_size,IF(OCTET_LENGTH(payload)<=33554432,payload,NULL) AS payload FROM pc_matrix_records WHERE store_id=? AND namespace=? AND record_key=?")
            .bind(self.store.as_slice()).bind(namespace.as_bytes()).bind(hash.as_slice()).fetch_optional(&mut **tx).await?;
        row.map(|row| {
            let payload: Option<Vec<u8>> = row.try_get("payload")?;
            let payload = payload.ok_or(StoreError::Corrupt)?;
            let (actual, value) =
                self.decode(namespace, &hash, row.try_get("revision")?, &payload)?;
            if actual != key {
                return Err(StoreError::Corrupt);
            }
            Ok(value)
        })
        .transpose()
    }

    async fn get_inner(&self, namespace: &str, key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        let _guard = self.guard().await?;
        let mut tx = self.owned_tx().await?;
        let value = self.get_tx(&mut tx, namespace, key).await?;
        tx.rollback().await?;
        Ok(value)
    }

    pub async fn scan(&self, namespace: &str) -> Result<Vec<(Vec<u8>, Vec<u8>)>, StoreError> {
        self.scan_prefix(namespace, b"").await
    }

    async fn scan_prefix_inner(
        &self,
        namespace: &str,
        prefix: &[u8],
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, StoreError> {
        let _guard = self.guard().await?;
        self.hash(namespace, b"")?;
        let mut tx = self.owned_tx().await?;
        let bucket = (prefix.len() >= PREFIX_BYTES).then(|| self.prefix_bucket(namespace, prefix));
        let mut bytes = 0usize;
        let mut output = Vec::new();
        let mut cursor: Option<Vec<u8>> = None;
        loop {
            // Fetch only bounded metadata first. Oversized payloads are never
            // materialized in memory; payload pages have a separate byte cap.
            let mut query = sqlx::QueryBuilder::<MySql>::new(
                "SELECT record_key,revision,CAST(OCTET_LENGTH(payload) AS UNSIGNED) AS payload_size FROM pc_matrix_records WHERE store_id=",
            );
            query
                .push_bind(self.store.as_slice())
                .push(" AND namespace=")
                .push_bind(namespace.as_bytes());
            if let Some(bucket) = &bucket {
                query
                    .push(" AND prefix_bucket=")
                    .push_bind(bucket.as_slice());
            }
            if let Some(cursor) = &cursor {
                query.push(" AND record_key>").push_bind(cursor);
            }
            query
                .push(" ORDER BY record_key LIMIT ")
                .push_bind(PAGE_SIZE);
            let rows = query.build().fetch_all(&mut *tx).await?;
            if rows.is_empty() {
                break;
            }
            let mut metadata = Vec::with_capacity(rows.len());
            for row in rows {
                let hash: Vec<u8> = row.try_get("record_key")?;
                let size: u64 = row.try_get("payload_size")?;
                if size > (MAX_VALUE * 2) as u64 {
                    return Err(StoreError::Corrupt);
                }
                metadata.push((hash, row.try_get::<u64, _>("revision")?, size as usize));
            }
            let mut start = 0;
            while start < metadata.len() {
                let mut end = start;
                let mut page_bytes = 0usize;
                while end < metadata.len() && page_bytes + metadata[end].2 <= MAX_BATCH {
                    page_bytes += metadata[end].2;
                    end += 1;
                }
                if end == start {
                    return Err(StoreError::Corrupt);
                }
                let page = &metadata[start..end];
                let mut expected: std::collections::BTreeMap<_, _> = page
                    .iter()
                    .map(|(key, revision, _)| (key.clone(), *revision))
                    .collect();
                let mut query = sqlx::QueryBuilder::<MySql>::new(
                    "SELECT record_key,IF(OCTET_LENGTH(payload)<=33554432,payload,NULL) AS payload FROM pc_matrix_records WHERE store_id=",
                );
                query
                    .push_bind(self.store.as_slice())
                    .push(" AND namespace=")
                    .push_bind(namespace.as_bytes())
                    .push(" AND record_key IN (");
                {
                    let mut separated = query.separated(",");
                    for (key, _, _) in page {
                        separated.push_bind(key);
                    }
                }
                query.push(") ORDER BY record_key");
                let values = query.build().fetch_all(&mut *tx).await?;
                if values.len() != page.len() {
                    return Err(StoreError::Corrupt);
                }
                for row in values {
                    let hash: Vec<u8> = row.try_get("record_key")?;
                    let revision = expected.remove(&hash).ok_or(StoreError::Corrupt)?;
                    let payload: Option<Vec<u8>> = row.try_get("payload")?;
                    let payload = payload.ok_or(StoreError::Corrupt)?;
                    let (key, value) = self.decode(namespace, &hash, revision, &payload)?;
                    cursor = Some(hash);
                    if key.starts_with(prefix) {
                        bytes = bytes
                            .checked_add(key.len() + value.len())
                            .ok_or(StoreError::Corrupt)?;
                        if bytes > MAX_BATCH * 2 {
                            return Err(StoreError::Corrupt);
                        }
                        output.push((key, value));
                    }
                }
                start = end;
            }
        }
        tx.rollback().await?;
        Ok(output)
    }

    fn prefix_bucket(&self, namespace: &str, key: &[u8]) -> [u8; 32] {
        self.cipher.hash_key(
            &format!("pc-matrix-prefix-v1/{namespace}"),
            &key[..key.len().min(PREFIX_BYTES)],
        )
    }

    async fn put_tx(
        &self,
        tx: &mut Transaction<'_, MySql>,
        namespace: &str,
        key: &[u8],
        value: Vec<u8>,
    ) -> Result<(), StoreError> {
        if value.len() > MAX_VALUE {
            return Err(StoreError::InvalidConfiguration);
        }
        let hash = self.hash(namespace, key)?;
        let old:Option<u64>=sqlx::query_scalar("SELECT revision FROM pc_matrix_records WHERE store_id=? AND namespace=? AND record_key=?")
            .bind(self.store.as_slice()).bind(namespace.as_bytes()).bind(hash.as_slice()).fetch_optional(&mut **tx).await?;
        let revision = old.unwrap_or(0).checked_add(1).ok_or(StoreError::Corrupt)?;
        let plaintext = rmp_serde::to_vec_named(&Envelope {
            store: self.store,
            schema: VERSION,
            namespace: namespace.into(),
            key: key.to_vec(),
            revision,
            value,
        })
        .map_err(|_| StoreError::Corrupt)?;
        let encrypted = self
            .cipher
            .encrypt_value_data(plaintext)
            .map_err(|_| StoreError::Corrupt)?;
        let payload = rmp_serde::to_vec_named(&encrypted).map_err(|_| StoreError::Corrupt)?;
        if payload.len() > MAX_VALUE * 2 {
            return Err(StoreError::InvalidConfiguration);
        }
        sqlx::query("INSERT INTO pc_matrix_records (store_id,namespace,record_key,prefix_bucket,revision,payload) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE prefix_bucket=VALUES(prefix_bucket),revision=VALUES(revision),payload=VALUES(payload)")
            .bind(self.store.as_slice()).bind(namespace.as_bytes()).bind(hash.as_slice()).bind(self.prefix_bucket(namespace,key).as_slice()).bind(revision).bind(payload).execute(&mut **tx).await?;
        Ok(())
    }

    async fn write_inner(&self, mutations: Vec<Mutation>) -> Result<(), StoreError> {
        let _guard = self.guard().await?;
        let size = mutations
            .iter()
            .try_fold(0usize, |size, op| {
                size.checked_add(match op {
                    Mutation::Put { key, value, .. } => key.len() + value.len(),
                    _ => 0,
                })
            })
            .ok_or(StoreError::InvalidConfiguration)?;
        if size > MAX_BATCH || mutations.len() > 32_768 {
            return Err(StoreError::InvalidConfiguration);
        }
        let mut tx = self.owned_tx().await?;
        for mutation in mutations {
            match mutation {
                Mutation::Put {
                    namespace,
                    key,
                    value,
                } => self.put_tx(&mut tx, &namespace, &key, value).await?,
                Mutation::Delete { namespace, key } => {
                    let hash = self.hash(&namespace, &key)?;
                    sqlx::query("DELETE FROM pc_matrix_records WHERE store_id=? AND namespace=? AND record_key=?")
                        .bind(self.store.as_slice()).bind(namespace.as_bytes()).bind(hash.as_slice()).execute(&mut *tx).await?;
                }
                Mutation::Clear { namespace } => {
                    self.hash(&namespace, b"")?;
                    sqlx::query("DELETE FROM pc_matrix_records WHERE store_id=? AND namespace=?")
                        .bind(self.store.as_slice())
                        .bind(namespace.as_bytes())
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
        self.commit(tx).await
    }

    async fn renew_inner(&self) -> Result<(), StoreError> {
        let _guard = self.guard().await?;
        let mut tx = self.owned_tx().await?;
        let expires = db_now(&mut tx).await? + u64::from(self.lease_ms);
        sqlx::query("UPDATE pc_matrix_stores SET lease_expires_ms=? WHERE store_id=?")
            .bind(expires)
            .bind(self.store.as_slice())
            .execute(&mut *tx)
            .await?;
        self.commit(tx).await
    }

    /// Release only this generation; it cannot release a successor's lease.
    async fn release_inner(&self) -> Result<(), StoreError> {
        let _mutation = self.mutation_lock.lock().await;
        let mut closed = self.closed.write().await;
        let result = async {
            let mut tx = self.owned_tx().await?;
            sqlx::query(
                "UPDATE pc_matrix_stores SET lease_expires_ms=0,owner_nonce=NULL WHERE store_id=?",
            )
            .bind(self.store.as_slice())
            .execute(&mut *tx)
            .await?;
            tx.commit().await.map_err(|_| StoreError::Unavailable)
        }
        .await;
        *closed = true;
        self.poisoned.store(true, Ordering::Release);
        let pool = self
            .pool
            .read()
            .map_err(|_| StoreError::Unavailable)?
            .clone();
        pool.close().await;
        result
    }

    async fn close_inner(&self) -> Result<(), StoreError> {
        let _mutation = self.mutation_lock.lock().await;
        let mut closed = self.closed.write().await;
        if *closed {
            return Ok(());
        }
        let result = async {
            let mut tx = self.owned_tx().await?;
            sqlx::query(
                "UPDATE pc_matrix_stores SET lease_expires_ms=0,owner_nonce=NULL WHERE store_id=?",
            )
            .bind(self.store.as_slice())
            .execute(&mut *tx)
            .await?;
            tx.commit().await.map_err(|_| StoreError::Unavailable)
        }
        .await;
        if result.is_err() {
            self.poisoned.store(true, Ordering::Release);
        }
        *closed = true;
        let pool = self
            .pool
            .read()
            .map_err(|_| StoreError::Unavailable)?
            .clone();
        pool.close().await;
        result
    }
    async fn reopen_inner(&self) -> Result<(), StoreError> {
        let _mutation = self.mutation_lock.lock().await;
        let mut closed = self.closed.write().await;
        if self.poisoned.load(Ordering::Acquire) {
            return Err(StoreError::Fenced);
        }
        if !*closed {
            return Ok(());
        }
        let pool = pool_options(2).connect_lazy_with(self.options.clone());
        let mut tx = pool.begin().await?;
        let row=sqlx::query("SELECT fence,lease_expires_ms,binding FROM pc_matrix_stores WHERE store_id=? FOR UPDATE")
            .bind(self.store.as_slice()).fetch_optional(&mut *tx).await?.ok_or(StoreError::Schema)?;
        let binding: Vec<u8> = row.try_get("binding")?;
        let binding: Binding = self
            .cipher
            .decrypt_value(&binding)
            .map_err(|_| StoreError::Corrupt)?;
        if binding.store != self.store
            || binding.schema != VERSION
            || binding.fingerprint != self.fingerprint
        {
            return Err(StoreError::Corrupt);
        }
        if row.try_get::<u64, _>("fence")? != self.epoch.load(Ordering::Acquire) {
            self.poisoned.store(true, Ordering::Release);
            return Err(StoreError::Fenced);
        }
        let now = db_now(&mut tx).await?;
        if row.try_get::<u64, _>("lease_expires_ms")? > now {
            return Err(StoreError::Conflict);
        }
        let epoch = row
            .try_get::<u64, _>("fence")?
            .checked_add(1)
            .ok_or(StoreError::Corrupt)?;
        sqlx::query(
            "UPDATE pc_matrix_stores SET fence=?,owner_nonce=?,lease_expires_ms=? WHERE store_id=?",
        )
        .bind(epoch)
        .bind(self.holder.as_slice())
        .bind(now + u64::from(self.lease_ms))
        .bind(self.store.as_slice())
        .execute(&mut *tx)
        .await?;
        if tx.commit().await.is_err() {
            self.poisoned.store(true, Ordering::Release);
            return Err(StoreError::Unavailable);
        }
        *self.pool.write().map_err(|_| StoreError::Unavailable)? = pool;
        self.epoch.store(epoch, Ordering::Release);
        *closed = false;
        Ok(())
    }
    pub async fn is_closed(&self) -> bool {
        *self.closed.read().await
    }
    async fn check_open_inner(&self) -> Result<(), StoreError> {
        let _guard = self.guard().await?;
        let tx = self.owned_tx().await?;
        tx.rollback().await?;
        Ok(())
    }
    async fn get_size_inner(&self) -> Result<Option<usize>, StoreError> {
        let _guard = self.guard().await?;
        let mut tx = self.owned_tx().await?;
        let bytes:u64=sqlx::query_scalar("SELECT CAST(COALESCE(SUM(OCTET_LENGTH(payload)),0) AS UNSIGNED) FROM pc_matrix_records WHERE store_id=?")
            .bind(self.store.as_slice()).fetch_one(&mut *tx).await?;
        tx.rollback().await?;
        Ok(Some(
            usize::try_from(bytes).map_err(|_| StoreError::Corrupt)?,
        ))
    }

    async fn try_take_leased_lock_inner(
        &self,
        duration_ms: u32,
        key: &str,
        holder: &str,
    ) -> Result<Option<u64>, StoreError> {
        let _mutation = self.mutation_lock.lock().await;
        let _guard = self.guard().await?;
        let mut tx = self.owned_tx().await?;
        let now = db_now(&mut tx).await?;
        let old = self
            .get_tx(&mut tx, "sdk_leases", key.as_bytes())
            .await?
            .map(|data| serde_json::from_slice::<SdkLease>(&data))
            .transpose()?;
        if old
            .as_ref()
            .is_some_and(|old| old.holder != holder && old.expires_ms > now)
        {
            tx.rollback().await?;
            return Ok(None);
        }
        let generation = match old {
            Some(old) if old.holder == holder => old.generation,
            Some(old) => old.generation.checked_add(1).ok_or(StoreError::Corrupt)?,
            None => 1,
        };
        self.put_tx(
            &mut tx,
            "sdk_leases",
            key.as_bytes(),
            serde_json::to_vec(&SdkLease {
                holder: holder.into(),
                expires_ms: now + u64::from(duration_ms),
                generation,
            })?,
        )
        .await?;
        self.commit(tx).await?;
        Ok(Some(generation))
    }
}

async fn db_now(tx: &mut Transaction<'_, MySql>) -> Result<u64, StoreError> {
    sqlx::query_scalar("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED)")
        .fetch_one(&mut **tx)
        .await
        .map_err(Into::into)
}
