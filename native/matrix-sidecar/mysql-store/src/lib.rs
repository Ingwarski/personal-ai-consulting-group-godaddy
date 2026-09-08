//! Direct encrypted MySQL persistence for the pinned Matrix SDK.
//! Provisioning is explicit. Opening a store never creates identity or schema.
mod backend;
pub mod crypto;
pub mod legacy_crypto;
pub mod legacy_state;
pub mod state;

pub use backend::{Backend, DatabaseConfig, InboxEntry, InboxMutation, Mutation, SCHEMA_SQL};

#[cfg(all(test, feature = "integration-tests"))]
pub(crate) mod test_support {
    use super::*;
    use std::sync::Arc;
    pub async fn backend() -> Result<Arc<Backend>, StoreError> {
        let config = DatabaseConfig::from_env()?;
        if !config.database.starts_with("pc_matrix_test_")
            || !matches!(config.host.as_str(), "localhost" | "127.0.0.1")
            || std::env::var_os("MATRIX_MYSQL_TEST_CONFIG").is_none()
        {
            return Err(StoreError::InvalidConfiguration);
        }
        let pool = config.connect().await?;
        sqlx::raw_sql(SCHEMA_SQL).execute(&pool).await?;
        let id = *uuid::Uuid::new_v4().as_bytes();
        Backend::provision(&pool, id, b"SDK synthetic fixture", &[7; 32]).await?;
        let backend = Backend::open(
            pool.clone(),
            id,
            b"SDK synthetic fixture",
            &[7; 32],
            300_000,
        )
        .await?;
        pool.close().await;
        Ok(Arc::new(backend))
    }
}

/// Deliberately excludes source errors: SQL/serialization diagnostics can carry
/// identifiers or sensitive parameters and must not reach sidecar logs.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Matrix database unavailable")]
    Unavailable,
    #[error("Matrix database ownership lost")]
    Fenced,
    #[error("Matrix database closed")]
    Closed,
    #[error("Matrix database record invalid")]
    Corrupt,
    #[error("Matrix database configuration invalid")]
    InvalidConfiguration,
    #[error("Matrix database schema or identity unavailable")]
    Schema,
    #[error("Matrix database operation conflicts with existing state")]
    Conflict,
}

impl From<serde_json::Error> for StoreError {
    fn from(_: serde_json::Error) -> Self {
        Self::Corrupt
    }
}
impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        #[cfg(all(test, feature = "integration-tests"))]
        match &error {
            sqlx::Error::Database(e) => eprintln!("synthetic test database code: {:?}", e.code()),
            sqlx::Error::ColumnDecode { index, source } => {
                eprintln!("synthetic test column type: {index}: {source}")
            }
            _ => eprintln!("synthetic test SQL operation failed (non-database error)"),
        }
        match error {
            sqlx::Error::Database(error) => match error
                .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                .map(|error| error.number())
            {
                Some(1049 | 1054 | 1146) => Self::Schema,
                Some(1044 | 1045 | 1142 | 1143) => Self::InvalidConfiguration,
                Some(1062) => Self::Conflict,
                Some(1264 | 1366 | 1406) => Self::Corrupt,
                _ => Self::Unavailable,
            },
            sqlx::Error::Configuration(_) | sqlx::Error::InvalidArgument(_) => {
                Self::InvalidConfiguration
            }
            sqlx::Error::ColumnNotFound(_)
            | sqlx::Error::ColumnIndexOutOfBounds { .. }
            | sqlx::Error::TypeNotFound { .. } => Self::Schema,
            sqlx::Error::ColumnDecode { .. }
            | sqlx::Error::Decode(_)
            | sqlx::Error::Encode(_)
            | sqlx::Error::RowNotFound => Self::Corrupt,
            sqlx::Error::PoolClosed => Self::Closed,
            _ => Self::Unavailable,
        }
    }
}

#[cfg(test)]
mod error_tests {
    use super::StoreError;
    #[test]
    fn sql_shape_errors_are_not_temporary_outages() {
        assert!(matches!(
            StoreError::from(sqlx::Error::ColumnNotFound("synthetic".into())),
            StoreError::Schema
        ));
        assert!(matches!(
            StoreError::from(sqlx::Error::RowNotFound),
            StoreError::Corrupt
        ));
        assert!(matches!(
            StoreError::from(sqlx::Error::PoolClosed),
            StoreError::Closed
        ));
        assert!(matches!(
            StoreError::from(sqlx::Error::PoolTimedOut),
            StoreError::Unavailable
        ));
    }
}
impl From<StoreError> for matrix_sdk_crypto::store::CryptoStoreError {
    fn from(error: StoreError) -> Self {
        Self::Backend(Box::new(error))
    }
}
impl From<StoreError> for matrix_sdk_base::store::StoreError {
    fn from(error: StoreError) -> Self {
        Self::Backend(Box::new(error))
    }
}
