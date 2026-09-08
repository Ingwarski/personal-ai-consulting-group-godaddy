//! Pending media is encrypted in MySQL before the pending event/cursor commit.
//! Local spool files are disposable. Chunks and manifest commit in one batch;
//! an interrupted pre-journal upload is bounded and expires as an orphan.
use crate::{
    config::{MAX_MEDIA_AGGREGATE_BYTES, MAX_MEDIA_OBJECT_BYTES, MEDIA_TTL_SECONDS},
    media_spool::{MediaError as SpoolMediaError, MediaReference, PrivateSpool},
};
use personal_consultant_matrix_mysql_store::{Backend, Mutation};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// Corrupt/missing content stays terminal; a lost database connection requires
/// a fresh fenced runtime, not loss of the encrypted pending media.
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("Matrix durable media invalid")]
    Invalid,
    #[error("Matrix media database operation failed")]
    Database(personal_consultant_matrix_mysql_store::StoreError),
}
impl From<SpoolMediaError> for MediaError {
    fn from(_: SpoolMediaError) -> Self {
        Self::Invalid
    }
}

const META: &str = "app.media.meta";
const CHUNKS: &str = "app.media.chunks";
const CHUNK: usize = 4 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    reference: MediaReference,
    chunks: usize,
    created_at_ms: u64,
}
fn now() -> Result<u64, MediaError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MediaError::Invalid)?
        .as_millis()
        .try_into()
        .map_err(|_| MediaError::Invalid)
}
fn chunk_key(handle: &str, index: usize) -> Vec<u8> {
    format!("{handle}/{index}").into_bytes()
}
fn parse(key: &[u8], data: &[u8]) -> Result<Manifest, MediaError> {
    if data.len() > 4096 {
        return Err(MediaError::Invalid);
    }
    let m: Manifest = serde_json::from_slice(data).map_err(|_| MediaError::Invalid)?;
    if m.reference.handle.as_bytes() != key
        || m.reference.length == 0
        || m.reference.length > MAX_MEDIA_OBJECT_BYTES
        || m.chunks != (m.reference.length as usize).div_ceil(CHUNK)
        || m.created_at_ms == 0
    {
        return Err(MediaError::Invalid);
    }
    Ok(m)
}
fn delete(m: &Manifest) -> Vec<Mutation> {
    let mut ops = vec![Mutation::Delete {
        namespace: META.into(),
        key: m.reference.handle.as_bytes().to_vec(),
    }];
    ops.extend((0..m.chunks).map(|i| Mutation::Delete {
        namespace: CHUNKS.into(),
        key: chunk_key(&m.reference.handle, i),
    }));
    ops
}
pub async fn archive(
    backend: &Arc<Backend>,
    spool: &PrivateSpool,
    references: &[MediaReference],
) -> Result<(), MediaError> {
    if references.is_empty() {
        return Ok(());
    }
    spool.inspect_batch(references)?;
    let _guard = backend.mutation_lock.lock().await;
    let current = backend.scan(META).await.map_err(MediaError::Database)?;
    if current
        .len()
        .checked_add(references.len())
        .is_none_or(|n| n > 256)
    {
        return Err(MediaError::Invalid);
    }
    let mut total = 0u64;
    let mut existing = HashSet::new();
    for (key, data) in current {
        let m = parse(&key, &data)?;
        total = total
            .checked_add(m.reference.length)
            .ok_or(MediaError::Invalid)?;
        existing.insert(m.reference.handle);
    }
    for reference in references {
        // Opaque handles are immutable and generated per download. Never
        // overwrite a pre-existing manifest, even under the same event ID.
        if !existing.insert(reference.handle.clone()) {
            return Err(MediaError::Invalid);
        }
        total = total
            .checked_add(reference.length)
            .ok_or(MediaError::Invalid)?;
        if total > MAX_MEDIA_AGGREGATE_BYTES {
            return Err(MediaError::Invalid);
        }
    }
    for reference in references {
        let mut ops = Vec::new();
        let bytes = zeroize::Zeroizing::new(spool.read_verified(reference)?);
        for (i, chunk) in bytes.chunks(CHUNK).enumerate() {
            ops.push(Mutation::Put {
                namespace: CHUNKS.into(),
                key: chunk_key(&reference.handle, i),
                value: chunk.to_vec(),
            });
        }
        let m = Manifest {
            reference: reference.clone(),
            chunks: bytes.len().div_ceil(CHUNK),
            created_at_ms: now()?,
        };
        ops.push(Mutation::Put {
            namespace: META.into(),
            key: reference.handle.as_bytes().to_vec(),
            value: serde_json::to_vec(&m).map_err(|_| MediaError::Invalid)?,
        });
        // Per-object atomicity preserves the full 64 MiB batch allowance
        // without putting metadata overhead above Backend's batch bound.
        backend.write(ops).await.map_err(MediaError::Database)?;
    }
    Ok(())
}
async fn read_locked(
    backend: &Backend,
    reference: &MediaReference,
) -> Result<zeroize::Zeroizing<Vec<u8>>, MediaError> {
    use sha2::{Digest, Sha256};
    let key = reference.handle.as_bytes();
    let data = backend
        .get(META, key)
        .await
        .map_err(MediaError::Database)?
        .ok_or(MediaError::Invalid)?;
    let m = parse(key, &data)?;
    if m.reference.sha256 != reference.sha256
        || m.reference.length != reference.length
        || m.reference.declared_mime != reference.declared_mime
    {
        return Err(MediaError::Invalid);
    }
    let mut bytes = zeroize::Zeroizing::new(Vec::with_capacity(reference.length as usize));
    for i in 0..m.chunks {
        let chunk = backend
            .get(CHUNKS, &chunk_key(&reference.handle, i))
            .await
            .map_err(MediaError::Database)?
            .ok_or(MediaError::Invalid)?;
        let expected = (reference.length as usize - i * CHUNK).min(CHUNK);
        if chunk.len() != expected {
            return Err(MediaError::Invalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    if hex::encode(Sha256::digest(&bytes)) != reference.sha256 {
        return Err(MediaError::Invalid);
    }
    Ok(bytes)
}
pub async fn verify(backend: &Arc<Backend>, reference: &MediaReference) -> Result<(), MediaError> {
    let _guard = backend.mutation_lock.lock().await;
    let _bytes = read_locked(backend, reference).await?;
    Ok(())
}
pub async fn restore(
    backend: &Arc<Backend>,
    spool: &PrivateSpool,
    references: &[MediaReference],
) -> Result<(), MediaError> {
    if references.len() > crate::config::MAX_MEDIA_OBJECTS
        || references
            .iter()
            .try_fold(0u64, |n, r| n.checked_add(r.length))
            .is_none_or(|n| n > MAX_MEDIA_AGGREGATE_BYTES)
    {
        return Err(MediaError::Invalid);
    }
    let _guard = backend.mutation_lock.lock().await;
    for reference in references {
        let bytes = read_locked(backend, reference).await?;
        spool.restore_verified(reference, &bytes)?;
    }
    Ok(())
}
pub async fn remove(backend: &Arc<Backend>, handle: &str) -> Result<(), MediaError> {
    let _guard = backend.mutation_lock.lock().await;
    if let Some(data) = backend
        .get(META, handle.as_bytes())
        .await
        .map_err(MediaError::Database)?
    {
        let m = parse(handle.as_bytes(), &data)?;
        backend
            .write(delete(&m))
            .await
            .map_err(MediaError::Database)?;
    }
    Ok(())
}
pub async fn prune(backend: &Arc<Backend>, active: &HashSet<String>) -> Result<(), MediaError> {
    let _guard = backend.mutation_lock.lock().await;
    let time = now()?;
    let mut ops = Vec::new();
    for (key, data) in backend.scan(META).await.map_err(MediaError::Database)? {
        let m = parse(&key, &data)?;
        if !active.contains(&m.reference.handle)
            && time.saturating_sub(m.created_at_ms) > MEDIA_TTL_SECONDS * 1000
        {
            ops.extend(delete(&m));
        }
    }
    if !ops.is_empty() {
        backend.write(ops).await.map_err(MediaError::Database)?;
    }
    Ok(())
}
