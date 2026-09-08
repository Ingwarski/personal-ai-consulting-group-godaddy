// Copyright 2026 Personal Consultant contributors.
// Pinned codec/schema knowledge adapted from matrix-sdk-sqlite 0.18.0:
// Copyright 2022 The Matrix.org Foundation C.I.C.
// Licensed under the Apache License, Version 2.0.
// https://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, this software is
// distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

//! Lossless read-only capture of an encrypted SDK 0.18 state schema (version 15).
//!
//! Some SQLite keys cannot be reconstructed: arbitrary custom/filter keys,
//! display names, custom receipt types and thread IDs are only keyed hashes.
//! Consequently these records must remain queryable with the original cipher.
//! This module preserves ALL original columns, ciphertexts and queue row order;
//! the destination Backend adds its own authenticated encryption. Capturing a
//! snapshot is NOT activating it: the migration coordinator must verify identity,
//! quiescence, counts, fallback reads and atomic cutover separately.

use crate::{Backend, Mutation, StoreError};
use matrix_sdk_store_encryption::StoreCipher;
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
};

type Result<T> = std::result::Result<T, StoreError>;
const META: &str = "legacy.state.meta";
const MAX_ROWS: usize = 1_000_000;
const MAX_SNAPSHOT_BYTES: usize = 512 * 1024 * 1024;
const MAX_CELL_BYTES: usize = 16 * 1024 * 1024;

struct Table {
    name: &'static str,
    columns: &'static [&'static str],
    primary: &'static [&'static str],
    encrypted: &'static [&'static str],
}
const TABLES: &[Table] = &[
    Table {
        name: "kv_blob",
        columns: &["key", "value"],
        primary: &["key"],
        // The pinned SDK stores arbitrary custom values verbatim here, while
        // typed KV/presence values are encrypted. Hashed keys cannot classify
        // arbitrary custom entries; preserve bytes and use the caller's type
        // at lookup rather than rejecting legitimate raw custom values.
        encrypted: &[],
    },
    Table {
        name: "room_info",
        columns: &["room_id", "state", "data"],
        primary: &["room_id"],
        encrypted: &["data"],
    },
    Table {
        name: "state_event",
        columns: &[
            "room_id",
            "event_type",
            "state_key",
            "stripped",
            "event_id",
            "data",
        ],
        primary: &["room_id", "event_type", "state_key"],
        encrypted: &["data"],
    },
    Table {
        name: "global_account_data",
        columns: &["event_type", "data"],
        primary: &["event_type"],
        encrypted: &["data"],
    },
    Table {
        name: "room_account_data",
        columns: &["room_id", "event_type", "data"],
        primary: &["room_id", "event_type"],
        encrypted: &["data"],
    },
    Table {
        name: "member",
        columns: &["room_id", "user_id", "membership", "stripped", "data"],
        primary: &["room_id", "user_id"],
        encrypted: &["data"],
    },
    Table {
        name: "profile",
        columns: &["room_id", "user_id", "data"],
        primary: &["room_id", "user_id"],
        encrypted: &["data"],
    },
    Table {
        name: "receipt",
        columns: &[
            "room_id",
            "user_id",
            "receipt_type",
            "thread",
            "event_id",
            "data",
        ],
        primary: &["room_id", "user_id", "receipt_type", "thread"],
        encrypted: &["data"],
    },
    Table {
        name: "display_name",
        columns: &["room_id", "name", "data"],
        primary: &["room_id", "name"],
        encrypted: &["data"],
    },
    Table {
        name: "send_queue_events",
        columns: &[
            "room_id",
            "room_id_val",
            "transaction_id",
            "content",
            "wedge_reason",
            "priority",
            "created_at",
        ],
        primary: &["room_id", "transaction_id"],
        encrypted: &["room_id_val", "content", "wedge_reason"],
    },
    // No primary key in SQLite: ROWID distinguishes every dependent request.
    Table {
        name: "dependent_send_queue_events",
        columns: &[
            "room_id",
            "parent_transaction_id",
            "own_transaction_id",
            "parent_key",
            "content",
            "created_at",
        ],
        primary: &["room_id", "$rowid"],
        encrypted: &["parent_key", "content"],
    },
    Table {
        name: "thread_subscriptions",
        columns: &["room_id", "event_id", "status", "bump_stamp"],
        primary: &["room_id", "event_id"],
        encrypted: &[],
    },
];

fn table(name: &str) -> Result<&'static Table> {
    TABLES
        .iter()
        .find(|t| t.name == name)
        .ok_or(StoreError::Schema)
}
fn namespace(name: &str) -> Result<String> {
    Ok(format!("legacy.state.{}", table(name)?.name))
}

/// SQL values retain their SQLite storage class, not just declared affinity.
/// In particular transaction IDs are TEXT in a declared BLOB column.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub enum LegacyCell {
    Null,
    Integer(i64),
    Text(String),
    Blob(Vec<u8>),
}
impl LegacyCell {
    pub fn bytes(&self) -> Result<&[u8]> {
        match self {
            Self::Blob(v) => Ok(v),
            Self::Text(v) => Ok(v.as_bytes()),
            _ => Err(StoreError::Corrupt),
        }
    }
    pub fn integer(&self) -> Result<i64> {
        match self {
            Self::Integer(v) => Ok(*v),
            _ => Err(StoreError::Corrupt),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LegacyStateRow {
    pub rowid: i64,
    pub columns: BTreeMap<String, LegacyCell>,
}
impl LegacyStateRow {
    pub fn cell(&self, name: &str) -> Result<&LegacyCell> {
        self.columns.get(name).ok_or(StoreError::Corrupt)
    }
    pub fn blob(&self, name: &str) -> Result<&[u8]> {
        self.cell(name)?.bytes()
    }
    pub fn optional_blob(&self, name: &str) -> Result<Option<&[u8]>> {
        match self.cell(name)? {
            LegacyCell::Null => Ok(None),
            cell => Ok(Some(cell.bytes()?)),
        }
    }
}

/// Stable length-delimited keys preserve opaque hashes and allow scoped scans.
/// Prefixes consist of COMPLETE components; there is no delimiter ambiguity.
pub fn legacy_key(parts: &[&[u8]]) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    for part in parts {
        let length: u32 = part.len().try_into().map_err(|_| StoreError::Corrupt)?;
        result.extend(length.to_be_bytes());
        result.extend(*part);
    }
    Ok(result)
}
fn row_key(table: &Table, row: &LegacyStateRow) -> Result<Vec<u8>> {
    let mut parts = Vec::new();
    for column in table.primary {
        if *column == "$rowid" {
            parts.push(row.rowid.to_be_bytes().to_vec());
        } else {
            parts.push(row.blob(column)?.to_vec());
        }
    }
    legacy_key(&parts.iter().map(Vec::as_slice).collect::<Vec<_>>())
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    schema: u8,
    source_digest: [u8; 32],
    counts: BTreeMap<String, u64>,
    wrapped_cipher: Vec<u8>,
}

/// No Debug implementation: the snapshot contains encrypted private data and
/// key material wrapped under a caller-supplied, secret-derived migration key.
pub struct LegacyStateSnapshot {
    manifest: Manifest,
    rows: Vec<(String, Vec<u8>, LegacyStateRow)>,
}
impl LegacyStateSnapshot {
    /// Read a frozen backup, never the active writer's database. Opening uses
    /// READ_ONLY + immutable and never invokes SDK open/migrations or creates
    /// sidecar journal files. Only a checkpointed standalone backup is accepted.
    pub fn read(path: &Path, old_passphrase: &str, wrapping_key: &[u8; 32]) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| StoreError::Schema)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
            return Err(StoreError::Schema);
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sibling = path.as_os_str().to_owned();
            sibling.push(suffix);
            match std::fs::symlink_metadata(Path::new(&sibling)) {
                Ok(_) => return Err(StoreError::Schema),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(StoreError::Schema),
            }
        }
        let absolute = path.canonicalize().map_err(|_| StoreError::Schema)?;
        let mut uri = url::Url::from_file_path(absolute).map_err(|_| StoreError::Schema)?;
        uri.query_pairs_mut()
            .append_pair("immutable", "1")
            .append_pair("mode", "ro");
        let connection = Connection::open_with_flags(
            uri.as_str(),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| StoreError::Schema)?;
        connection
            .execute_batch("PRAGMA query_only=ON; BEGIN DEFERRED TRANSACTION;")
            .map_err(|_| StoreError::Schema)?;
        validate_schema(&connection)?;
        let version: Vec<u8> = connection
            .query_row("SELECT value FROM kv WHERE key='version'", [], |r| r.get(0))
            .map_err(|_| StoreError::Schema)?;
        if version != [15] {
            return Err(StoreError::Schema);
        }
        let exported: Vec<u8> = connection
            .query_row("SELECT value FROM kv WHERE key='cipher'", [], |r| r.get(0))
            .map_err(|_| StoreError::Schema)?;
        let cipher =
            StoreCipher::import(old_passphrase, &exported).map_err(|_| StoreError::Corrupt)?;
        Self::capture(&connection, &cipher, wrapping_key)
    }
    fn capture(
        connection: &Connection,
        cipher: &StoreCipher,
        wrapping_key: &[u8; 32],
    ) -> Result<Self> {
        let mut rows = Vec::new();
        let mut counts = BTreeMap::new();
        let mut digest = Sha256::new();
        let mut bytes = 0usize;
        digest.update(b"personal-consultant/legacy-state/v15\0");
        digest.update(cipher.hash_key("legacy-source-fingerprint", b"state"));
        for schema in TABLES {
            // Identifier comes exclusively from the static allowlist above.
            let mut statement = connection
                .prepare(&format!(
                    "SELECT ROWID,* FROM \"{}\" ORDER BY ROWID",
                    schema.name
                ))
                .map_err(|_| StoreError::Schema)?;
            let mut cursor = statement.query([]).map_err(|_| StoreError::Schema)?;
            let mut count = 0u64;
            while let Some(record) = cursor.next().map_err(|_| StoreError::Corrupt)? {
                if rows.len() >= MAX_ROWS {
                    return Err(StoreError::Corrupt);
                }
                let rowid: i64 = record.get(0).map_err(|_| StoreError::Corrupt)?;
                let mut columns = BTreeMap::new();
                for (index, name) in schema.columns.iter().enumerate() {
                    let cell = match record.get_ref(index + 1).map_err(|_| StoreError::Corrupt)? {
                        ValueRef::Null => LegacyCell::Null,
                        ValueRef::Integer(v) => LegacyCell::Integer(v),
                        ValueRef::Text(v) => {
                            if v.len() > MAX_CELL_BYTES {
                                return Err(StoreError::Corrupt);
                            }
                            LegacyCell::Text(
                                std::str::from_utf8(v)
                                    .map_err(|_| StoreError::Corrupt)?
                                    .into(),
                            )
                        }
                        ValueRef::Blob(v) => {
                            if v.len() > MAX_CELL_BYTES {
                                return Err(StoreError::Corrupt);
                            }
                            LegacyCell::Blob(v.into())
                        }
                        ValueRef::Real(_) => return Err(StoreError::Corrupt),
                    };
                    columns.insert((*name).to_owned(), cell);
                }
                let row = LegacyStateRow { rowid, columns };
                for column in schema.encrypted {
                    if let Some(payload) = row.optional_blob(column)? {
                        let _ = decode(cipher, payload)?;
                    }
                }
                let key = row_key(schema, &row)?;
                let encoded = serde_json::to_vec(&row)?;
                bytes = bytes
                    .checked_add(encoded.len())
                    .ok_or(StoreError::Corrupt)?;
                if bytes > MAX_SNAPSHOT_BYTES {
                    return Err(StoreError::Corrupt);
                }
                digest.update((schema.name.len() as u64).to_be_bytes());
                digest.update(schema.name.as_bytes());
                digest.update((encoded.len() as u64).to_be_bytes());
                digest.update(&encoded);
                rows.push((namespace(schema.name)?, key, row));
                count += 1;
            }
            counts.insert(schema.name.to_owned(), count);
        }
        let source_digest = digest.finalize().into();
        let wrapped_cipher = cipher
            .export_with_key(wrapping_key)
            .map_err(|_| StoreError::Corrupt)?;
        Ok(Self {
            manifest: Manifest {
                schema: 15,
                source_digest,
                counts,
                wrapped_cipher,
            },
            rows,
        })
    }
    pub fn counts(&self) -> &BTreeMap<String, u64> {
        &self.manifest.counts
    }
    pub fn source_digest(&self) -> [u8; 32] {
        self.manifest.source_digest
    }
    /// Deterministic opaque record keys make interrupted candidate imports
    /// resumable. Caller batches writes into a NON-ACTIVE candidate namespace.
    /// The manifest is last; it does not itself authorize activation.
    pub fn into_mutations(self) -> Result<Vec<Mutation>> {
        let mut mutations = Vec::with_capacity(self.rows.len() + 1);
        let sequence = self
            .rows
            .iter()
            .filter(|(ns, _, _)| ns.ends_with("send_queue_events"))
            .map(|(_, _, r)| r.rowid)
            .max()
            .unwrap_or(0);
        if sequence < 0 {
            return Err(StoreError::Corrupt);
        }
        for (namespace, key, row) in self.rows {
            mutations.push(Mutation::Put {
                namespace,
                key,
                value: serde_json::to_vec(&row)?,
            });
        }
        mutations.push(Mutation::Put {
            namespace: "state.meta".into(),
            key: serde_json::to_vec(&["sequence"])?,
            value: serde_json::to_vec(&(sequence as u64))?,
        });
        mutations.push(Mutation::Put {
            namespace: META.into(),
            key: b"manifest".to_vec(),
            value: serde_json::to_vec(&self.manifest)?,
        });
        Ok(mutations)
    }
}

fn validate_schema(connection: &Connection) -> Result<()> {
    let mut statement=connection.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') ORDER BY name").map_err(|_|StoreError::Schema)?;
    let actual: BTreeSet<String> = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| StoreError::Schema)?
        .map(|r| {
            let (name, kind) = r.map_err(|_| StoreError::Schema)?;
            if kind != "table" {
                return Err(StoreError::Schema);
            }
            Ok(name)
        })
        .collect::<Result<_>>()?;
    let mut expected: BTreeSet<String> = TABLES.iter().map(|t| t.name.to_owned()).collect();
    expected.insert("kv".into());
    if actual != expected {
        return Err(StoreError::Schema);
    }
    for (name, columns) in std::iter::once(("kv", &["key", "value"][..]))
        .chain(TABLES.iter().map(|t| (t.name, t.columns)))
    {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info(\"{name}\")"))
            .map_err(|_| StoreError::Schema)?;
        let actual: Vec<String> = statement
            .query_map([], |r| r.get(1))
            .map_err(|_| StoreError::Schema)?
            .collect::<std::result::Result<_, _>>()
            .map_err(|_| StoreError::Schema)?;
        if actual != columns {
            return Err(StoreError::Schema);
        }
    }
    let mut statement = connection
        .prepare("SELECT key FROM kv ORDER BY key")
        .map_err(|_| StoreError::Schema)?;
    let keys: Vec<String> = statement
        .query_map([], |r| r.get(0))
        .map_err(|_| StoreError::Schema)?
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| StoreError::Schema)?;
    if keys != ["cipher", "version"] {
        return Err(StoreError::Schema);
    }
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|_| StoreError::Schema)?;
    if integrity != "ok" {
        return Err(StoreError::Corrupt);
    }
    Ok(())
}
fn decode(cipher: &StoreCipher, payload: &[u8]) -> Result<Vec<u8>> {
    let envelope = rmp_serde::from_slice(payload).map_err(|_| StoreError::Corrupt)?;
    cipher
        .decrypt_value_data(envelope)
        .map_err(|_| StoreError::Corrupt)
}

/// Compatibility reads use retained original hashes, never guesses at plaintext
/// keys. Mutating callers MUST delete corresponding opaque rows in the same
/// fenced transaction as their canonical replacement; otherwise deleted data
/// could reappear from this fallback.
pub struct LegacyStateReader {
    backend: Arc<Backend>,
    cipher: StoreCipher,
    manifest: Manifest,
}
impl std::fmt::Debug for LegacyStateReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LegacyStateReader").finish_non_exhaustive()
    }
}
impl LegacyStateReader {
    pub async fn load(backend: Arc<Backend>, wrapping_key: &[u8; 32]) -> Result<Option<Self>> {
        let Some(payload) = backend.get(META, b"manifest").await? else {
            return Ok(None);
        };
        let manifest: Manifest = serde_json::from_slice(&payload)?;
        if manifest.schema != 15
            || manifest.counts.keys().any(|k| table(k).is_err())
            || manifest.counts.len() != TABLES.len()
        {
            return Err(StoreError::Schema);
        }
        let cipher = StoreCipher::import_with_key(wrapping_key, &manifest.wrapped_cipher)
            .map_err(|_| StoreError::Corrupt)?;
        Ok(Some(Self {
            backend,
            cipher,
            manifest,
        }))
    }
    pub fn hash(&self, table_name: &str, logical_key: &[u8]) -> Result<[u8; 32]> {
        table(table_name)?;
        Ok(self.cipher.hash_key(table_name, logical_key))
    }
    pub fn source_digest(&self) -> [u8; 32] {
        self.manifest.source_digest
    }
    pub async fn get(&self, table_name: &str, parts: &[&[u8]]) -> Result<Option<LegacyStateRow>> {
        self.backend
            .get(&namespace(table_name)?, &legacy_key(parts)?)
            .await?
            .map(|v| serde_json::from_slice(&v).map_err(Into::into))
            .transpose()
    }
    pub async fn scan(
        &self,
        table_name: &str,
        parts: &[&[u8]],
    ) -> Result<Vec<(Vec<u8>, LegacyStateRow)>> {
        self.backend
            .scan_prefix(&namespace(table_name)?, &legacy_key(parts)?)
            .await?
            .into_iter()
            .map(|(k, v)| Ok((k, serde_json::from_slice(&v)?)))
            .collect()
    }
    pub fn decode_bytes(&self, payload: &[u8]) -> Result<Vec<u8>> {
        decode(&self.cipher, payload)
    }
    pub fn decode_json<T: DeserializeOwned>(&self, payload: &[u8]) -> Result<T> {
        Ok(serde_json::from_slice(&self.decode_bytes(payload)?)?)
    }
    pub fn decode_msgpack<T: DeserializeOwned>(&self, payload: &[u8]) -> Result<T> {
        rmp_serde::from_slice(&self.decode_bytes(payload)?).map_err(|_| StoreError::Corrupt)
    }
    pub fn delete(&self, table_name: &str, parts: &[&[u8]]) -> Result<Mutation> {
        self.delete_key(table_name, legacy_key(parts)?)
    }
    pub fn delete_key(&self, table_name: &str, key: Vec<u8>) -> Result<Mutation> {
        Ok(Mutation::Delete {
            namespace: namespace(table_name)?,
            key,
        })
    }
    /// Room hashes are domain-separated per legacy table. Preserve that detail
    /// while removing every room-owned row, including opaque names/thread IDs.
    pub async fn delete_room(&self, room: &[u8]) -> Result<Vec<Mutation>> {
        let mut batch = Vec::new();
        for schema in TABLES
            .iter()
            .filter(|t| t.primary.first() == Some(&"room_id"))
        {
            let hash = self.hash(schema.name, room)?;
            for (key, _) in self.scan(schema.name, &[&hash]).await? {
                batch.push(self.delete_key(schema.name, key)?);
            }
        }
        Ok(batch)
    }

    /// Return current-codec bytes and the EXACT original key to suppress when
    /// the canonical row is subsequently changed. Opaque primary keys are never
    /// decoded by guessing or discarding unknown entries.
    async fn current_rows(
        &self,
        ns: &str,
        parts: &[String],
        exact: bool,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>, String, Vec<u8>)>> {
        use serde_json::{Value, json};
        let at = |n: usize| parts.get(n).map(String::as_str).ok_or(StoreError::Corrupt);
        let mut out = Vec::new();
        let mut add = |key_parts: Vec<String>,
                       value: Vec<u8>,
                       name: &str,
                       legacy_key: Vec<u8>|
         -> Result<()> {
            if !exact || key_parts == parts {
                out.push((
                    serde_json::to_vec(&key_parts)?,
                    value,
                    name.to_owned(),
                    legacy_key,
                ));
            }
            Ok(())
        };
        match ns {
            "state.kv" | "state.presence" => {
                let logical = if ns == "state.presence" {
                    format!("presence:{}", at(0)?)
                } else {
                    legacy_kv_name(parts)?
                };
                let hash = self.hash("kv_blob", logical.as_bytes())?;
                let old = legacy_key(&[&hash])?;
                if let Some(row) = self.get("kv_blob", &[&hash]).await? {
                    let bytes = if ns == "state.presence" {
                        self.decode_bytes(row.blob("value")?)?
                    } else if at(0)? == "otk_uploaded" {
                        serde_json::to_vec(&())?
                    } else {
                        self.decode_kv_json(at(0)?, row.blob("value")?)?
                    };
                    add(parts.to_vec(), bytes, "kv_blob", old)?;
                }
            }
            "state.room" => {
                let rows = if parts.is_empty() {
                    self.scan("room_info", &[]).await?
                } else {
                    let hash = self.hash("room_info", at(0)?.as_bytes())?;
                    self.scan("room_info", &[&hash]).await?
                };
                for (old, row) in rows {
                    let data = self.decode_bytes(row.blob("data")?)?;
                    let info: matrix_sdk_base::RoomInfo = serde_json::from_slice(&data)?;
                    add(vec![info.room_id().to_string()], data, "room_info", old)?;
                }
            }
            "state.event" | "state.stripped" => {
                let room = at(0)?;
                let room_hash = self.hash("state_event", room.as_bytes())?;
                for (old, row) in self.scan("state_event", &[&room_hash]).await? {
                    if (row.cell("stripped")?.integer()? != 0) != (ns == "state.stripped") {
                        continue;
                    }
                    let data = self.decode_bytes(row.blob("data")?)?;
                    let event: Value = serde_json::from_slice(&data)?;
                    let typ = event["type"].as_str().ok_or(StoreError::Corrupt)?;
                    let state_key = event["state_key"].as_str().ok_or(StoreError::Corrupt)?;
                    if parts.get(1).is_some_and(|v| v != typ) {
                        continue;
                    }
                    add(
                        vec![room.into(), typ.into(), state_key.into()],
                        data,
                        "state_event",
                        old,
                    )?;
                }
            }
            "state.member" => {
                let room = at(0)?;
                let room_hash = self.hash("member", room.as_bytes())?;
                for (old, row) in self.scan("member", &[&room_hash]).await? {
                    let user: String = self.decode_msgpack(row.blob("data")?)?;
                    if parts.get(1).is_some_and(|v| v != &user) {
                        continue;
                    }
                    let room_event_hash = self.hash("state_event", room.as_bytes())?;
                    let type_hash = self.hash("state_event", b"m.room.member")?;
                    let user_hash = self.hash("state_event", user.as_bytes())?;
                    let event = self
                        .get("state_event", &[&room_event_hash, &type_hash, &user_hash])
                        .await?;
                    let data: Value = if let Some(event) = event {
                        self.decode_json(event.blob("data")?)?
                    } else {
                        // A redaction may already have promoted the event while
                        // leaving its membership index in the legacy family.
                        let ns = if row.cell("stripped")?.integer()? != 0 {
                            "state.stripped"
                        } else {
                            "state.event"
                        };
                        let key = serde_json::to_vec(&[room, "m.room.member", user.as_str()])?;
                        let value = self
                            .backend
                            .get(ns, &key)
                            .await?
                            .ok_or(StoreError::Corrupt)?;
                        serde_json::from_slice(&value)?
                    };
                    let membership = data["content"]["membership"]
                        .as_str()
                        .ok_or(StoreError::Corrupt)?;
                    if self.hash("member", membership.as_bytes())?.as_slice()
                        != row.blob("membership")?
                    {
                        return Err(StoreError::Corrupt);
                    }
                    add(
                        vec![room.into(), user.clone()],
                        serde_json::to_vec(
                            &json!({"user":user,"membership":membership,"stripped":row.cell("stripped")?.integer()?!=0}),
                        )?,
                        "member",
                        old,
                    )?;
                }
            }
            "state.profile" | "state.name" | "state.account" | "state.room_account"
            | "state.thread" => {
                let name = match ns {
                    "state.profile" => "profile",
                    "state.name" => "display_name",
                    "state.account" => "global_account_data",
                    "state.room_account" => "room_account_data",
                    _ => "thread_subscriptions",
                };
                let hashes: Vec<[u8; 32]> = parts
                    .iter()
                    .map(|p| self.hash(name, p.as_bytes()))
                    .collect::<Result<_>>()?;
                let keys: Vec<&[u8]> = hashes.iter().map(|v| v.as_slice()).collect();
                if keys.len() != table(name)?.primary.len() {
                    return Err(StoreError::Corrupt);
                }
                if let Some(row) = self.get(name, &keys).await? {
                    let bytes = if ns == "state.thread" {
                        let status = std::str::from_utf8(row.blob("status")?)
                            .map_err(|_| StoreError::Corrupt)?;
                        let bump = match row.cell("bump_stamp")? {
                            LegacyCell::Null => None,
                            cell => Some(
                                u64::try_from(cell.integer()?).map_err(|_| StoreError::Corrupt)?,
                            ),
                        };
                        serde_json::to_vec(&json!({"status":status,"bump_stamp":bump}))?
                    } else {
                        self.decode_bytes(row.blob("data")?)?
                    };
                    add(parts.to_vec(), bytes, name, legacy_key(&keys)?)?;
                }
            }
            "state.receipt" => {
                use ruma::events::receipt::ReceiptThread;
                let room = at(0)?;
                let typ = at(1)?;
                let thread = at(2)?;
                let receipt_thread = ReceiptThread::try_from(if thread.is_empty() {
                    None
                } else {
                    Some(thread)
                })
                .map_err(|_| StoreError::Corrupt)?;
                let room_hash = self.hash("receipt", room.as_bytes())?;
                let type_hash = self.hash("receipt", typ.as_bytes())?;
                let thread_hash = self.hash(
                    "receipt",
                    &rmp_serde::to_vec_named(&receipt_thread).map_err(|_| StoreError::Corrupt)?,
                )?;
                for (old, row) in self.scan("receipt", &[&room_hash]).await? {
                    if row.blob("receipt_type")? != type_hash || row.blob("thread")? != thread_hash
                    {
                        continue;
                    }
                    let data: Value = self.decode_json(row.blob("data")?)?;
                    let user = data["user_id"].as_str().ok_or(StoreError::Corrupt)?;
                    add(
                        vec![room.into(), typ.into(), thread.into(), user.into()],
                        serde_json::to_vec(
                            &json!({"user":data["user_id"],"event":data["event_id"],"receipt":data["receipt"]}),
                        )?,
                        "receipt",
                        old,
                    )?;
                }
            }
            "state.queue" | "state.dependent" => {
                let name = if ns == "state.queue" {
                    "send_queue_events"
                } else {
                    "dependent_send_queue_events"
                };
                let rows = if parts.is_empty() {
                    if ns != "state.queue" {
                        return Err(StoreError::Corrupt);
                    }
                    self.scan(name, &[]).await?
                } else {
                    let hash = self.hash(name, at(0)?.as_bytes())?;
                    self.scan(name, &[&hash]).await?
                };
                for (old, row) in rows {
                    let room = if ns == "state.queue" {
                        self.decode_msgpack::<String>(row.blob("room_id_val")?)?
                    } else {
                        at(0)?.into()
                    };
                    let id_col = if ns == "state.queue" {
                        "transaction_id"
                    } else {
                        "own_transaction_id"
                    };
                    let txn =
                        std::str::from_utf8(row.blob(id_col)?).map_err(|_| StoreError::Corrupt)?;
                    let created = match row.cell("created_at")? {
                        LegacyCell::Null => 0,
                        cell => u64::try_from(cell.integer()?).map_err(|_| StoreError::Corrupt)?,
                    };
                    let sequence = u64::try_from(row.rowid).map_err(|_| StoreError::Corrupt)?;
                    let kind: Value = self.decode_json(row.blob("content")?)?;
                    let data = if ns == "state.queue" {
                        let error = row
                            .optional_blob("wedge_reason")?
                            .map(|v| self.decode_msgpack::<Value>(v))
                            .transpose()?;
                        json!({"kind":kind,"transaction_id":txn,"error":error,"priority":row.cell("priority")?.integer()?,"created_at":created,"sequence":sequence})
                    } else {
                        let parent = std::str::from_utf8(row.blob("parent_transaction_id")?)
                            .map_err(|_| StoreError::Corrupt)?;
                        let parent_key = row
                            .optional_blob("parent_key")?
                            .map(|v| self.decode_json::<Value>(v))
                            .transpose()?;
                        json!({"sequence":sequence,"request":{"kind":kind,"own_transaction_id":txn,"parent_transaction_id":parent,"parent_key":parent_key,"created_at":created}})
                    };
                    add(
                        vec![room, txn.into()],
                        serde_json::to_vec(&data)?,
                        name,
                        old,
                    )?;
                }
            }
            "state.meta" => {}
            _ => return Err(StoreError::Schema),
        }
        Ok(out)
    }
    pub async fn current_get(&self, ns: &str, key: &[u8]) -> Result<Option<Vec<u8>>> {
        if ns == "state.custom" {
            let mut logical = b"custom:".to_vec();
            logical.extend(key);
            let hash = self.hash("kv_blob", &logical)?;
            return self
                .get("kv_blob", &[&hash])
                .await?
                .map(|r| Ok(r.blob("value")?.to_vec()))
                .transpose();
        }
        let parts: Vec<String> = serde_json::from_slice(key)?;
        let mut rows = self.current_rows(ns, &parts, true).await?;
        if rows.len() > 1 {
            return Err(StoreError::Corrupt);
        }
        Ok(rows.pop().map(|(_, v, _, _)| v))
    }
    fn decode_kv_json(&self, kind: &str, payload: &[u8]) -> Result<Vec<u8>> {
        use matrix_sdk_base::StateStoreDataValue as V;
        // Typed decoding preserves MessagePack binary fields, including the
        // bloom filter, that cannot safely pass through serde_json::Value.
        fn convert<T: DeserializeOwned + Serialize>(
            reader: &LegacyStateReader,
            payload: &[u8],
            _: fn(T) -> V,
        ) -> Result<Vec<u8>> {
            Ok(serde_json::to_vec(&reader.decode_msgpack::<T>(payload)?)?)
        }
        match kind {
            "sync" => convert(self, payload, V::SyncToken),
            "versions" => convert(self, payload, V::SupportedVersions),
            "well_known" => convert(self, payload, V::WellKnown),
            "filter" => convert(self, payload, V::Filter),
            "avatar" => convert(self, payload, V::UserAvatarUrl),
            "recent" => convert(self, payload, V::RecentlyVisitedRooms),
            "utd" => convert(self, payload, V::UtdHookManagerData),
            "draft" => convert(self, payload, V::ComposerDraft),
            "knocks" => convert(self, payload, V::SeenKnockRequests),
            "thread_tokens" => convert(self, payload, V::ThreadSubscriptionsCatchupTokens),
            "capabilities" => convert(self, payload, V::HomeserverCapabilities),
            _ => Err(StoreError::Corrupt),
        }
    }
    pub async fn current_scan(&self, ns: &str, prefix: &[&str]) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        Ok(self
            .current_rows(
                ns,
                &prefix.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
                false,
            )
            .await?
            .into_iter()
            .map(|(k, v, _, _)| (k, v))
            .collect())
    }
    pub async fn suppress_current(&self, ns: &str, key: &[u8]) -> Result<Vec<Mutation>> {
        if ns == "state.custom" {
            let mut logical = b"custom:".to_vec();
            logical.extend(key);
            let hash = self.hash("kv_blob", &logical)?;
            return Ok(vec![self.delete("kv_blob", &[&hash])?]);
        }
        let parts: Vec<String> = serde_json::from_slice(key)?;
        self.current_rows(ns, &parts, true)
            .await?
            .into_iter()
            .map(|(_, _, table, key)| self.delete_key(&table, key))
            .collect()
    }
}

fn legacy_kv_name(parts: &[String]) -> Result<String> {
    let at = |n: usize| parts.get(n).map(String::as_str).ok_or(StoreError::Corrupt);
    Ok(match at(0)? {
        "sync" => "sync_token".into(),
        "versions" => "server_capabilities".into(),
        "well_known" => "well_known".into(),
        "filter" => format!("filter:{}", at(1)?),
        "avatar" => format!("user_avatar_url:{}", at(1)?),
        "recent" => format!("recently_visited_rooms:{}", at(1)?),
        "utd" => "utd_hook_manager_data".into(),
        "otk_uploaded" => "one_time_key_already_uploaded".into(),
        "draft" => {
            if at(2)?.is_empty() {
                format!("composer_draft:{}", at(1)?)
            } else {
                format!("composer_draft:{}:{}", at(1)?, at(2)?)
            }
        }
        "knocks" => format!("seen_knock_requests:{}", at(1)?),
        "thread_tokens" => "thread_subscriptions_catchup_tokens".into(),
        "capabilities" => "homeserver_capabilities".into(),
        _ => return Err(StoreError::Corrupt),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opaque_keys_are_unambiguous_and_prefix_queryable() {
        assert_ne!(
            legacy_key(&[b"ab", b"c"]).unwrap(),
            legacy_key(&[b"a", b"bc"]).unwrap()
        );
        let room = [7; 32];
        let full = legacy_key(&[&room, b"thread"]).unwrap();
        assert!(full.starts_with(&legacy_key(&[&room]).unwrap()));
    }
    #[test]
    fn legacy_messagepack_envelope_and_json_value_decode() {
        let cipher = StoreCipher::new().unwrap();
        let plain = serde_json::to_vec(&serde_json::json!({"text":"Привіт"})).unwrap();
        let payload =
            rmp_serde::to_vec_named(&cipher.encrypt_value_data(plain.clone()).unwrap()).unwrap();
        assert_eq!(decode(&cipher, &payload).unwrap(), plain);
        assert!(decode(&StoreCipher::new().unwrap(), &payload).is_err());
    }
    #[test]
    fn retained_cipher_preserves_irreversible_lookup_hash() {
        let cipher = StoreCipher::new().unwrap();
        let hash = cipher.hash_key("kv_blob", b"custom:unknown/arbitrary");
        let exported = cipher.export_with_key(&[9; 32]).unwrap();
        let restored = StoreCipher::import_with_key(&[9; 32], &exported).unwrap();
        assert_eq!(
            restored.hash_key("kv_blob", b"custom:unknown/arbitrary"),
            hash
        );
        assert!(StoreCipher::import_with_key(&[10; 32], &exported).is_err());
    }
    #[test]
    fn unknown_or_incomplete_schema_is_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE kv(key TEXT,value BLOB);")
            .unwrap();
        assert!(matches!(
            validate_schema(&connection),
            Err(StoreError::Schema)
        ));
    }
}

#[cfg(all(test, feature = "integration-tests"))]
mod migration_tests {
    use super::*;
    use crate::state::MySqlStateStore;
    use matrix_sdk_base::{
        RoomMemberships, StateStoreDataKey as K, StateStoreDataValue as V,
        deserialized_responses::DisplayName,
        store::{
            ChildTransactionId, DependentQueuedRequestKind, IntoStateStore,
            SerializableEventContent, StateStore, StateStoreIntegrationTests,
            StoredThreadSubscription, ThreadSubscriptionStatus,
        },
    };
    use ruma::{
        MilliSecondsSinceUnixEpoch, TransactionId, event_id,
        events::{
            StateEventType,
            receipt::{ReceiptThread, ReceiptType},
            room::message::RoomMessageEventContent,
        },
        room_id, user_id,
    };

    #[tokio::test]
    async fn sdk_state_snapshot_reads_and_mutates_without_sqlite_after_import()
    -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let directory = tempfile::tempdir()?;
        let source = matrix_sdk_sqlite::SqliteStateStore::open(
            directory.path(),
            Some("synthetic-migration-passphrase"),
        )
        .await?;
        source
            .clone()
            .into_state_store()
            .populate()
            .await
            .expect("SDK synthetic fixture must populate");
        let room = room_id!("!test:localhost");
        let user = user_id!("@example:localhost");
        let thread = event_id!("$irreversible-thread-id");
        source
            .set_custom_value(b"\xffarbitrary/custom\0key", vec![0, 128, 255])
            .await?;
        source
            .set_kv_data(
                K::Filter("custom/filter:ім'я"),
                V::Filter("filter-value".into()),
            )
            .await?;
        source
            .upsert_thread_subscriptions(vec![(
                room,
                thread,
                StoredThreadSubscription {
                    status: ThreadSubscriptionStatus::Subscribed { automatic: false },
                    bump_stamp: Some(90),
                },
            )])
            .await?;
        let txn = TransactionId::new();
        let child = ChildTransactionId::new();
        let content =
            SerializableEventContent::new(&RoomMessageEventContent::text_plain("Привіт").into())?;
        source
            .save_send_queue_request(
                room,
                txn.clone(),
                MilliSecondsSinceUnixEpoch::now(),
                content.into(),
                2,
            )
            .await?;
        source
            .save_dependent_queued_request(
                room,
                &txn,
                child.clone(),
                MilliSecondsSinceUnixEpoch::now(),
                DependentQueuedRequestKind::RedactEvent,
            )
            .await?;
        let expected_presence = source
            .get_presence_event(user)
            .await?
            .unwrap()
            .json()
            .get()
            .to_owned();
        let expected_members = source.get_user_ids(room, RoomMemberships::empty()).await?;
        let expected_profile = serde_json::to_value(source.get_profile(room, user).await?)?;
        let expected_names = source
            .get_users_with_display_name(room, &DisplayName::new("example"))
            .await?;
        let expected_receipt = source
            .get_user_room_receipt_event(room, ReceiptType::Read, ReceiptThread::Unthreaded, user)
            .await?;
        source.close().await?;
        // Produce an explicit consistent standalone backup. SDK pool shutdown
        // can finish WAL cleanup asynchronously, so its live directory is not
        // the immutable input whose inventory this test promises to preserve.
        let backup_directory = tempfile::tempdir()?;
        let path = backup_directory.path().join("matrix-sdk-state.sqlite3");
        let connection = Connection::open(directory.path().join("matrix-sdk-state.sqlite3"))?;
        connection.execute("VACUUM INTO ?1", [path.to_str().ok_or(StoreError::Schema)?])?;
        drop(connection);
        let before = std::fs::read(&path)?;
        let inventory = || -> std::io::Result<BTreeSet<std::ffi::OsString>> {
            std::fs::read_dir(backup_directory.path())?
                .map(|entry| entry.map(|entry| entry.file_name()))
                .collect()
        };
        let inventory_before = inventory()?;
        let backend = crate::test_support::backend().await?;
        let snapshot = LegacyStateSnapshot::read(
            &path,
            "synthetic-migration-passphrase",
            &backend.legacy_wrapping_key(),
        )?;
        assert_eq!(snapshot.counts().len(), TABLES.len());
        assert_eq!(snapshot.counts()["thread_subscriptions"], 1);
        let fingerprint = snapshot.source_digest();
        let retry = LegacyStateSnapshot::read(
            &path,
            "synthetic-migration-passphrase",
            &backend.legacy_wrapping_key(),
        )?;
        assert_eq!(fingerprint, retry.source_digest());
        assert_eq!(before, std::fs::read(&path)?);
        assert!(
            LegacyStateSnapshot::read(&path, "wrong-passphrase", &backend.legacy_wrapping_key())
                .is_err()
        );
        assert_eq!(inventory_before, inventory()?);
        backend.write(snapshot.into_mutations()?).await?;
        // Removing the generated source proves reads no longer reach SQLite.
        drop(source);
        directory.close()?;
        backup_directory.close()?;
        let target = MySqlStateStore::new(backend.clone());
        assert_eq!(
            target
                .get_custom_value(b"\xffarbitrary/custom\0key")
                .await?,
            Some(vec![0, 128, 255])
        );
        assert_eq!(
            target
                .get_kv_data(K::Filter("custom/filter:ім'я"))
                .await?
                .unwrap()
                .into_filter(),
            Some("filter-value".into())
        );
        assert_eq!(
            target.get_presence_event(user).await?.unwrap().json().get(),
            expected_presence
        );
        assert_eq!(
            target
                .get_user_ids(room, RoomMemberships::empty())
                .await?
                .into_iter()
                .collect::<BTreeSet<_>>(),
            expected_members.into_iter().collect::<BTreeSet<_>>()
        );
        assert_eq!(
            serde_json::to_value(target.get_profile(room, user).await?)?,
            expected_profile
        );
        assert_eq!(
            target
                .get_users_with_display_name(room, &DisplayName::new("example"))
                .await?,
            expected_names
        );
        assert_eq!(
            serde_json::to_value(
                target
                    .get_user_room_receipt_event(
                        room,
                        ReceiptType::Read,
                        ReceiptThread::Unthreaded,
                        user
                    )
                    .await?
            )?,
            serde_json::to_value(expected_receipt)?
        );
        assert!(
            target
                .get_state_event(room, StateEventType::RoomTopic, "")
                .await?
                .is_some()
        );
        assert_eq!(
            target
                .load_thread_subscription(room, thread)
                .await?
                .unwrap()
                .bump_stamp,
            Some(90)
        );
        assert_eq!(
            target.load_send_queue_requests(room).await?[0].transaction_id,
            txn
        );
        assert_eq!(
            target.load_dependent_queued_requests(room).await?[0].own_transaction_id,
            child
        );
        // Redacting a legacy member event promotes only its state-event row.
        // Its still-legacy membership index must continue to resolve correctly.
        let member = target
            .get_state_event(room, StateEventType::RoomMember, user.as_str())
            .await?
            .unwrap();
        let matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedState::Sync(member) =
            member
        else {
            panic!("expected synthetic joined member")
        };
        let member_id = member.get_field::<ruma::OwnedEventId>("event_id")?.unwrap();
        let redaction=ruma::serde::Raw::new(&serde_json::json!({"type":"m.room.redaction","sender":user,"event_id":"$synthetic-redaction","origin_server_ts":1,"redacts":member_id,"content":{}}))?.cast_unchecked();
        let mut changes = matrix_sdk_base::StateChanges::default();
        changes.add_redaction(room, &member_id, redaction);
        target.save_changes(&changes).await?;
        assert!(
            target
                .get_user_ids(room, RoomMemberships::empty())
                .await?
                .contains(&user.to_owned())
        );
        let next = TransactionId::new();
        let content =
            SerializableEventContent::new(&RoomMessageEventContent::text_plain("new").into())?;
        target
            .save_send_queue_request(
                room,
                next.clone(),
                MilliSecondsSinceUnixEpoch::now(),
                content.into(),
                2,
            )
            .await?;
        assert_eq!(
            target
                .load_send_queue_requests(room)
                .await?
                .into_iter()
                .map(|v| v.transaction_id)
                .collect::<Vec<_>>(),
            vec![txn.clone(), next]
        );
        target
            .remove_custom_value(b"\xffarbitrary/custom\0key")
            .await?;
        target
            .remove_kv_data(K::Filter("custom/filter:ім'я"))
            .await?;
        target.remove_thread_subscription(room, thread).await?;
        assert!(target.remove_send_queue_request(room, &txn).await?);
        assert!(target.remove_dependent_queued_request(room, &child).await?);
        let reopened = MySqlStateStore::new(backend);
        assert!(
            reopened
                .get_custom_value(b"\xffarbitrary/custom\0key")
                .await?
                .is_none()
        );
        assert!(
            reopened
                .get_kv_data(K::Filter("custom/filter:ім'я"))
                .await?
                .is_none()
        );
        assert!(
            reopened
                .load_thread_subscription(room, thread)
                .await?
                .is_none()
        );
        assert!(
            reopened
                .load_dependent_queued_requests(room)
                .await?
                .is_empty()
        );
        reopened.remove_room(room).await?;
        assert!(reopened.get_profile(room, user).await?.is_none());
        assert!(
            reopened
                .get_users_with_display_name(room, &DisplayName::new("example"))
                .await?
                .is_empty()
        );
        assert!(
            reopened
                .get_state_events(room, StateEventType::RoomMember)
                .await?
                .is_empty()
        );
        Ok(())
    }
}
