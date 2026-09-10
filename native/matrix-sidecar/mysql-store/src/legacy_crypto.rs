// Copyright 2023, 2026 The Matrix.org Foundation C.I.C.
// Copyright 2026 Personal Consultant contributors.
// SPDX-License-Identifier: Apache-2.0
// Codec conventions are adapted from matrix-sdk-sqlite 0.18.0 utils.rs and
// crypto_store.rs, distributed under the Apache License, Version 2.0.

//! Offline, pinned-schema crypto import. This module never opens a legacy SDK
//! store, upgrades SQLite, resets an identity, or activates a MySQL candidate.
//! The caller must stop the old writer and supply a consistent standalone backup.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
};

use matrix_sdk_crypto::{
    Account, DeviceData, GossipRequest, UserIdentityData,
    olm::{
        InboundGroupSession, OlmMessageHash, OutboundGroupSession, PickledAccount,
        PickledCrossSigningIdentity, PickledInboundGroupSession, PickledOutboundGroupSession,
        PickledSession, PrivateCrossSigningIdentity, Session,
    },
    store::types::{
        BackupDecryptionKey, DehydratedDeviceKey, RoomKeyWithheldEntry,
        RoomPendingKeyBundleDetails, RoomSettings, StoredRoomKeyBundleData, TrackedUser,
    },
};
use matrix_sdk_store_encryption::StoreCipher;
use rusqlite::{Connection, OpenFlags};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::{
    Backend, Mutation, StoreError,
    crypto::{InboundRecord, key, put},
};

pub(crate) const ALIAS_META: &str = "legacy.crypto.meta";
pub(crate) const ALIAS_SETTINGS: &str = "legacy.crypto.room_settings";
pub(crate) const ALIAS_DOWNLOADED: &str = "legacy.crypto.downloaded";
pub(crate) const ALIAS_SECRETS: &str = "legacy.crypto.secrets";
pub(crate) const ALIAS_WITHHELD: &str = "legacy.crypto.withheld";
const MAX_BACKUP_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;

/// The original SDK accepted either the existing passphrase string or a raw key.
/// The production caller must choose its actual historical open mode.
pub enum LegacySecret<'a> {
    Passphrase(&'a str),
    Key(&'a [u8; 32]),
}

/// Public account identity evidence; never contains private keys or credentials.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LegacyCryptoIdentity {
    pub user_id: String,
    pub device_id: String,
    pub curve25519: String,
    pub ed25519: String,
}

/// Complete conversion output, not permission to mutate an active store.
/// Candidate activation requires the caller's identity/count/replay checks and
/// app/state-store migration receipts. Never print `mutations` or serialize them
/// into a plaintext handoff file.
pub struct LegacyCryptoImport {
    pub mutations: Vec<Mutation>,
    pub source_sha256: [u8; 32],
    pub identity: LegacyCryptoIdentity,
    pub source_counts: BTreeMap<String, usize>,
    pub source_schema: u8,
}

fn corrupt<T>(_: T) -> StoreError {
    StoreError::Corrupt
}

fn decoded(cipher: &StoreCipher, value: &[u8]) -> Result<Vec<u8>, StoreError> {
    cipher
        .decrypt_value_data(rmp_serde::from_slice(value).map_err(corrupt)?)
        .map_err(corrupt)
}
fn msgpack<T: DeserializeOwned>(cipher: &StoreCipher, value: &[u8]) -> Result<T, StoreError> {
    rmp_serde::from_slice(&decoded(cipher, value)?).map_err(corrupt)
}
fn json<T: DeserializeOwned>(cipher: &StoreCipher, value: &[u8]) -> Result<T, StoreError> {
    Ok(serde_json::from_slice(&decoded(cipher, value)?)?)
}
fn sql<T>(result: rusqlite::Result<T>) -> Result<T, StoreError> {
    result.map_err(corrupt)
}

fn check_hash(
    cipher: &StoreCipher,
    family: &str,
    plain: &[u8],
    hashed: &[u8],
) -> Result<(), StoreError> {
    if cipher.hash_key(family, plain).as_slice() != hashed {
        return Err(StoreError::Corrupt);
    }
    Ok(())
}

/// Hash-compatible aliases preserve room settings, downloaded-room markers,
/// secret names and withheld payloads without room/session identifiers. Their
/// original keys are one-way hashes absent from the decrypted values.
/// The legacy cipher export is wrapped with a domain-separated key derived from
/// the target backend cipher, then stored inside its context-bound AEAD value.
/// Neither that derived key nor the old cipher becomes a new external secret.
pub(crate) async fn alias_key(
    backend: &Backend,
    family: &str,
    plain: &[u8],
) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(export) = backend.get(ALIAS_META, b"cipher").await? else {
        return Ok(None);
    };
    let cipher =
        StoreCipher::import_with_key(&backend.legacy_wrapping_key(), &export).map_err(corrupt)?;
    Ok(Some(cipher.hash_key(family, plain).to_vec()))
}

pub(crate) async fn alias_get<T: DeserializeOwned>(
    backend: &Backend,
    namespace: &str,
    family: &str,
    plain: &[u8],
) -> Result<Option<T>, StoreError> {
    let Some(coordinate) = alias_key(backend, family, plain).await? else {
        return Ok(None);
    };
    backend
        .get(namespace, &coordinate)
        .await?
        .map(|v| serde_json::from_slice(&v).map_err(StoreError::from))
        .transpose()
}

pub(crate) async fn alias_delete(
    backend: &Backend,
    namespace: &str,
    family: &str,
    plain: &[u8],
) -> Result<Option<Mutation>, StoreError> {
    Ok(alias_key(backend, family, plain)
        .await?
        .map(|key| Mutation::Delete {
            namespace: namespace.to_owned(),
            key,
        }))
}

pub(crate) async fn withheld_key(
    backend: &Backend,
    room: &[u8],
    session: &[u8],
) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(export) = backend.get(ALIAS_META, b"cipher").await? else {
        return Ok(None);
    };
    let cipher =
        StoreCipher::import_with_key(&backend.legacy_wrapping_key(), &export).map_err(corrupt)?;
    let mut coordinate = cipher.hash_key("direct_withheld_info", room).to_vec();
    coordinate.extend_from_slice(&cipher.hash_key("direct_withheld_info", session));
    Ok(Some(coordinate))
}

pub(crate) async fn withheld_for_room(
    backend: &Backend,
    room: &[u8],
) -> Result<Vec<RoomKeyWithheldEntry>, StoreError> {
    let Some(prefix) = alias_key(backend, "direct_withheld_info", room).await? else {
        return Ok(Vec::new());
    };
    backend
        .scan_prefix(ALIAS_WITHHELD, &prefix)
        .await?
        .into_iter()
        .map(|(_, v)| serde_json::from_slice(&v).map_err(StoreError::from))
        .collect()
}

fn inventory(conn: &Connection) -> Result<BTreeMap<String, usize>, StoreError> {
    // Version 17 is the final migration executed by pinned SDK 0.18.0. Unknown
    // versions/tables/columns fail before producing any candidate mutations.
    let expected: &[(&str, &[&str])] = &[
        ("kv", &["key", "value"]),
        ("session", &["session_id", "sender_key", "data"]),
        (
            "inbound_group_session",
            &[
                "session_id",
                "room_id",
                "backed_up",
                "data",
                "sender_key",
                "sender_data_type",
            ],
        ),
        ("outbound_group_session", &["room_id", "data"]),
        ("device", &["user_id", "device_id", "data"]),
        ("identity", &["user_id", "data"]),
        ("tracked_user", &["user_id", "data"]),
        ("olm_hash", &["data"]),
        ("key_requests", &["request_id", "sent_out", "data"]),
        ("room_settings", &["room_id", "data"]),
        ("direct_withheld_info", &["session_id", "room_id", "data"]),
        (
            "lease_locks",
            &["key", "holder", "expiration", "generation"],
        ),
        (
            "received_room_key_bundle",
            &["room_id", "sender_user_id", "bundle_data"],
        ),
        ("room_key_backups_fully_downloaded", &["room_id"]),
        ("rooms_pending_key_bundle", &["room_id", "data"]),
        ("secrets_inbox", &["secret_name", "secret"]),
    ];
    let mut statement = sql(conn.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'"))?;
    let actual = sql(statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(corrupt)?;
    if actual.iter().any(|(_, kind)| kind != "table") {
        return Err(StoreError::Schema);
    }
    let names: BTreeSet<_> = actual.into_iter().map(|(name, _)| name).collect();
    if names
        != expected
            .iter()
            .map(|(name, _)| (*name).to_owned())
            .collect()
    {
        return Err(StoreError::Schema);
    }
    let mut counts = BTreeMap::new();
    for (table, columns) in expected {
        // Identifiers are constants from the pinned schema above, never input.
        let mut statement = sql(conn.prepare(&format!("PRAGMA table_info(\"{table}\")")))?;
        let actual = sql(statement.query_map([], |row| row.get::<_, String>(1)))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(corrupt)?;
        if actual != *columns {
            return Err(StoreError::Schema);
        }
        let count: usize = sql(conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{table}\""),
            [],
            |r| r.get(0),
        ))?;
        if count > MAX_ROWS {
            return Err(StoreError::Corrupt);
        }
        counts.insert((*table).to_owned(), count);
    }
    Ok(counts)
}

fn rows(conn: &Connection, query: &str) -> Result<Vec<Vec<Vec<u8>>>, StoreError> {
    let mut statement = sql(conn.prepare(query))?;
    let count = statement.column_count();
    sql(statement.query_map([], |row| {
        (0..count)
            .map(|i| row.get::<_, Vec<u8>>(i))
            .collect::<rusqlite::Result<Vec<_>>>()
    }))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(corrupt)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, StoreError> {
    let metadata = std::fs::symlink_metadata(path).map_err(corrupt)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BACKUP_BYTES
    {
        return Err(StoreError::InvalidConfiguration);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(corrupt)?
        .take(MAX_BACKUP_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(corrupt)?;
    if bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err(StoreError::InvalidConfiguration);
    }
    Ok(bytes)
}

/// Read a stopped-writer, standalone SQLite backup. Requires no WAL/SHM/journal
/// siblings so an incomplete main file cannot be mistaken for a full backup.
/// The whole source is read-only and a source-digest recheck detects replacement
/// or mutation during conversion. Validation errors never produce partial output.
pub fn read_crypto_backup(
    path: &Path,
    secret: LegacySecret<'_>,
    target_wrapping_key: &[u8; 32],
) -> Result<LegacyCryptoImport, StoreError> {
    let before = read_bounded(path)?;
    let source_sha256: [u8; 32] = Sha256::digest(&before).into();
    drop(before);
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sibling = path.as_os_str().to_os_string();
        sibling.push(suffix);
        if Path::new(&sibling).exists() {
            return Err(StoreError::InvalidConfiguration);
        }
    }
    // READ_ONLY alone can still create WAL/SHM siblings for a WAL-mode database.
    // immutable=1 is valid only because this API requires a standalone, stopped
    // writer backup, rejects all journals, and verifies its digest again below.
    let absolute = std::fs::canonicalize(path).map_err(corrupt)?;
    let mut uri = url::Url::from_file_path(absolute).map_err(corrupt)?;
    uri.query_pairs_mut().append_pair("immutable", "1");
    let conn = sql(Connection::open_with_flags(
        uri.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_URI,
    ))?;
    sql(conn.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED"))?;
    let check: String = sql(conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)))?;
    if check != "ok" {
        return Err(StoreError::Corrupt);
    }
    let source_counts = inventory(&conn)?;
    let mut kv = BTreeMap::new();
    let mut statement = sql(conn.prepare("SELECT key,value FROM kv ORDER BY key"))?;
    for row in sql(statement.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
    }))? {
        let (k, v) = sql(row)?;
        kv.insert(k, v);
    }
    if kv.remove("version").as_deref() != Some(&[17][..]) {
        return Err(StoreError::Schema);
    }
    let encrypted_cipher = kv.remove("cipher").ok_or(StoreError::Schema)?;
    let cipher = match secret {
        LegacySecret::Passphrase(p) => StoreCipher::import(p, &encrypted_cipher),
        LegacySecret::Key(k) => StoreCipher::import_with_key(k, &encrypted_cipher),
    }
    .map_err(corrupt)?;
    let mut mutations = vec![Mutation::Put {
        namespace: ALIAS_META.to_owned(),
        key: b"cipher".to_vec(),
        value: cipher
            .export_with_key(target_wrapping_key)
            .map_err(corrupt)?,
    }];
    let raw_account = kv.remove("account").ok_or(StoreError::Schema)?;
    let account_pickle: PickledAccount = msgpack(&cipher, &raw_account)?;
    let account = Account::from_pickle(account_pickle).map_err(corrupt)?;
    let identity = LegacyCryptoIdentity {
        user_id: account.user_id().to_string(),
        device_id: account.device_id().to_string(),
        curve25519: account.identity_keys().curve25519.to_base64(),
        ed25519: account.identity_keys().ed25519.to_base64(),
    };
    mutations.push(put("crypto.meta", b"account".to_vec(), &account.pickle())?);
    let backup_version: Option<String> = kv
        .get("backup_version_v1")
        .map(|v| msgpack(&cipher, v))
        .transpose()?;
    for (name, value) in kv {
        let (target, encoded) = match name.as_str() {
            "identity" => {
                let pickle: PickledCrossSigningIdentity = msgpack(&cipher, &value)?;
                // Validate before preserving the SDK's serializable private keys.
                let encoded = serde_json::to_vec(&pickle)?;
                PrivateCrossSigningIdentity::from_pickle(pickle).map_err(corrupt)?;
                ("identity", encoded)
            }
            "next_batch_token" => (
                "next_batch",
                serde_json::to_vec(&msgpack::<String>(&cipher, &value)?)?,
            ),
            "backup_version_v1" => (
                "backup_version",
                serde_json::to_vec(&msgpack::<String>(&cipher, &value)?)?,
            ),
            "recovery_key_v1" => (
                "backup_key",
                serde_json::to_vec(&msgpack::<BackupDecryptionKey>(&cipher, &value)?)?,
            ),
            "dehydrated_device_pickle_key" => (
                "dehydrated_key",
                serde_json::to_vec(&msgpack::<DehydratedDeviceKey>(&cipher, &value)?)?,
            ),
            // Custom keys are TEXT, not hashed; custom values use only the outer
            // encryption codec, not an additional MessagePack serialization.
            _ => {
                mutations.push(Mutation::Put {
                    namespace: "crypto.custom".to_owned(),
                    key: name.into_bytes(),
                    value: decoded(&cipher, &value)?,
                });
                continue;
            }
        };
        mutations.push(Mutation::Put {
            namespace: "crypto.meta".to_owned(),
            key: target.as_bytes().to_vec(),
            value: encoded,
        });
    }
    for row in rows(&conn, "SELECT session_id,sender_key,data FROM session")? {
        let pickle: PickledSession = msgpack(&cipher, &row[2])?;
        let encoded = serde_json::to_vec(&pickle)?;
        let session =
            Session::from_pickle(account.device_keys().clone(), pickle).map_err(corrupt)?;
        let sender = session.sender_key.to_base64();
        check_hash(&cipher, "session", session.session_id().as_bytes(), &row[0])?;
        check_hash(&cipher, "session", sender.as_bytes(), &row[1])?;
        mutations.push(Mutation::Put {
            namespace: "crypto.sessions".to_owned(),
            key: key(&[&sender, session.session_id()]),
            value: encoded,
        });
    }
    let mut statement = sql(conn.prepare("SELECT session_id,room_id,backed_up,data,sender_key,sender_data_type FROM inbound_group_session"))?;
    let mut cursor = sql(statement.query([]))?;
    while let Some(row) = sql(cursor.next())? {
        let mut pickle: PickledInboundGroupSession =
            msgpack(&cipher, &sql(row.get::<_, Vec<u8>>(3))?)?;
        pickle.backed_up = sql(row.get::<_, bool>(2))?;
        // SQLite tracks a flag against the currently stored backup version. If
        // there is no version, preserve the flag but do not invent membership.
        let backed_up_to = if pickle.backed_up {
            backup_version.clone()
        } else {
            None
        };
        let encoded = serde_json::to_vec(&InboundRecord {
            pickle,
            backed_up_to,
        })?;
        let record: InboundRecord = serde_json::from_slice(&encoded)?;
        let session = InboundGroupSession::from_pickle(record.pickle).map_err(corrupt)?;
        check_hash(
            &cipher,
            "inbound_group_session",
            session.session_id().as_bytes(),
            &sql(row.get::<_, Vec<u8>>(0))?,
        )?;
        check_hash(
            &cipher,
            "inbound_group_session",
            session.room_id().as_bytes(),
            &sql(row.get::<_, Vec<u8>>(1))?,
        )?;
        if let Some(sender) = sql(row.get::<_, Option<Vec<u8>>>(4))? {
            check_hash(
                &cipher,
                "inbound_group_session",
                session.sender_key().to_base64().as_bytes(),
                &sender,
            )?;
        }
        if let Some(sender_type) = sql(row.get::<_, Option<u8>>(5))?
            && sender_type != session.sender_data_type() as u8
        {
            return Err(StoreError::Corrupt);
        }
        mutations.push(Mutation::Put {
            namespace: "crypto.inbound".to_owned(),
            key: key(&[session.room_id().as_str(), session.session_id()]),
            value: encoded,
        });
    }
    for row in rows(&conn, "SELECT room_id,data FROM outbound_group_session")? {
        let pickle: PickledOutboundGroupSession = json(&cipher, &row[1])?;
        check_hash(
            &cipher,
            "outbound_group_session",
            pickle.room_id.as_bytes(),
            &row[0],
        )?;
        let coordinate = key(&[pickle.room_id.as_str()]);
        let encoded = serde_json::to_vec(&pickle)?;
        OutboundGroupSession::from_pickle(
            account.device_id().to_owned(),
            account.static_data().identity_keys.clone(),
            pickle,
        )
        .map_err(corrupt)?;
        mutations.push(Mutation::Put {
            namespace: "crypto.outbound".to_owned(),
            key: coordinate,
            value: encoded,
        });
    }
    let mut own_device_found = false;
    for row in rows(&conn, "SELECT user_id,device_id,data FROM device")? {
        let device: DeviceData = msgpack(&cipher, &row[2])?;
        check_hash(&cipher, "device", device.user_id().as_bytes(), &row[0])?;
        check_hash(&cipher, "device", device.device_id().as_bytes(), &row[1])?;
        if device.user_id() == account.user_id() && device.device_id() == account.device_id() {
            if device.as_device_keys() != &account.device_keys() {
                return Err(StoreError::Corrupt);
            }
            own_device_found = true;
        }
        mutations.push(put(
            "crypto.devices",
            key(&[device.user_id().as_str(), device.device_id().as_str()]),
            &device,
        )?);
    }
    if !own_device_found {
        return Err(StoreError::Schema);
    }
    for row in rows(&conn, "SELECT user_id,data FROM identity")? {
        let value: UserIdentityData = msgpack(&cipher, &row[1])?;
        check_hash(&cipher, "identity", value.user_id().as_bytes(), &row[0])?;
        mutations.push(put(
            "crypto.identities",
            key(&[value.user_id().as_str()]),
            &value,
        )?);
    }
    for row in rows(&conn, "SELECT user_id,data FROM tracked_user")? {
        let value: TrackedUser = msgpack(&cipher, &row[1])?;
        check_hash(&cipher, "tracked_users", value.user_id.as_bytes(), &row[0])?;
        mutations.push(put(
            "crypto.tracked",
            key(&[value.user_id.as_str()]),
            &value,
        )?);
    }
    for row in rows(&conn, "SELECT data FROM olm_hash")? {
        // Contrary to other tables, this is unencrypted compact MessagePack.
        let hash: OlmMessageHash = rmp_serde::from_slice(&row[0]).map_err(corrupt)?;
        mutations.push(put(
            "crypto.message_hashes",
            key(&[&hash.sender_key, &hash.hash]),
            &true,
        )?);
    }
    let mut statement = sql(conn.prepare("SELECT request_id,sent_out,data FROM key_requests"))?;
    let mut cursor = sql(statement.query([]))?;
    while let Some(row) = sql(cursor.next())? {
        let mut value: GossipRequest = msgpack(&cipher, &sql(row.get::<_, Vec<u8>>(2))?)?;
        value.sent_out = sql(row.get(1))?;
        check_hash(
            &cipher,
            "key_requests",
            value.request_id.as_bytes(),
            &sql(row.get::<_, Vec<u8>>(0))?,
        )?;
        mutations.push(put(
            "crypto.requests",
            key(&[value.request_id.as_str()]),
            &value,
        )?);
    }
    for row in rows(
        &conn,
        "SELECT session_id,room_id,data FROM direct_withheld_info",
    )? {
        let value: RoomKeyWithheldEntry = json(&cipher, &row[2])?;
        if let (Some(room), Some(session)) =
            (value.content.room_id(), value.content.megolm_session_id())
        {
            check_hash(&cipher, "direct_withheld_info", session.as_bytes(), &row[0])?;
            check_hash(&cipher, "direct_withheld_info", room.as_bytes(), &row[1])?;
            mutations.push(put(
                "crypto.withheld",
                key(&[room.as_str(), session]),
                &value,
            )?);
        } else {
            // Unknown algorithms/NoOlm payloads can omit both original IDs.
            // Their SQL lookup keys are still meaningful, so preserve them.
            if row[0].len() != 32 || row[1].len() != 32 {
                return Err(StoreError::Corrupt);
            }
            let mut coordinate = row[1].clone();
            coordinate.extend_from_slice(&row[0]);
            mutations.push(put(ALIAS_WITHHELD, coordinate, &value)?);
        }
    }
    for row in rows(&conn, "SELECT room_id,data FROM room_settings")? {
        if row[0].len() != 32 {
            return Err(StoreError::Corrupt);
        }
        mutations.push(put(
            ALIAS_SETTINGS,
            row[0].clone(),
            &msgpack::<RoomSettings>(&cipher, &row[1])?,
        )?);
    }
    for row in rows(
        &conn,
        "SELECT room_id FROM room_key_backups_fully_downloaded",
    )? {
        if row[0].len() != 32 {
            return Err(StoreError::Corrupt);
        }
        mutations.push(put(ALIAS_DOWNLOADED, row[0].clone(), &true)?);
    }
    let mut secrets: BTreeMap<Vec<u8>, Vec<String>> = BTreeMap::new();
    for row in rows(&conn, "SELECT secret_name,secret FROM secrets_inbox")? {
        if row[0].len() != 32 {
            return Err(StoreError::Corrupt);
        }
        secrets
            .entry(row[0].clone())
            .or_default()
            .push(json(&cipher, &row[1])?);
    }
    for (coordinate, values) in secrets {
        mutations.push(put(ALIAS_SECRETS, coordinate, &values)?);
    }
    for row in rows(
        &conn,
        "SELECT room_id,sender_user_id,bundle_data FROM received_room_key_bundle",
    )? {
        let value: StoredRoomKeyBundleData = msgpack(&cipher, &row[2])?;
        check_hash(
            &cipher,
            "received_room_key_bundle",
            value.bundle_data.room_id.as_bytes(),
            &row[0],
        )?;
        check_hash(
            &cipher,
            "received_room_key_bundle",
            value.sender_user.as_bytes(),
            &row[1],
        )?;
        mutations.push(put(
            "crypto.bundles",
            key(&[
                value.bundle_data.room_id.as_str(),
                value.sender_user.as_str(),
            ]),
            &value,
        )?);
    }
    for row in rows(&conn, "SELECT room_id,data FROM rooms_pending_key_bundle")? {
        let value: RoomPendingKeyBundleDetails = msgpack(&cipher, &row[1])?;
        check_hash(
            &cipher,
            "rooms_pending_key_bundle",
            value.room_id.as_bytes(),
            &row[0],
        )?;
        mutations.push(put(
            "crypto.pending_bundles",
            key(&[value.room_id.as_str()]),
            &value,
        )?);
    }
    // A stopped legacy writer's process leases must never become active MySQL
    // ownership. Preserve their complete values as audit metadata, and acquire
    // the new DB-time/fenced lease independently during candidate activation.
    let mut statement =
        sql(conn.prepare("SELECT key,holder,expiration,generation FROM lease_locks"))?;
    let mut cursor = sql(statement.query([]))?;
    while let Some(row) = sql(cursor.next())? {
        let name: String = sql(row.get(0))?;
        let holder: String = sql(row.get(1))?;
        let expiration: f64 = sql(row.get(2))?;
        let generation: u64 = sql(row.get(3))?;
        mutations.push(put(
            "legacy.crypto.leases",
            name.into_bytes(),
            &(holder, expiration, generation),
        )?);
    }
    sql(conn.execute_batch("ROLLBACK"))?;
    let after = read_bounded(path)?;
    if <[u8; 32]>::from(Sha256::digest(&after)) != source_sha256 {
        return Err(StoreError::Conflict);
    }
    Ok(LegacyCryptoImport {
        mutations,
        source_sha256,
        identity,
        source_counts,
        source_schema: 17,
    })
}

#[cfg(all(test, feature = "integration-tests"))]
mod tests {
    use super::*;
    use crate::crypto::MySqlCryptoStore;
    use matrix_sdk_crypto::{
        SecretInfo,
        olm::SenderData,
        store::{
            CryptoStore,
            types::{Changes, DeviceChanges, IdentityChanges, PendingChanges, SecretsInboxItem},
        },
        testing::get_other_identity,
        types::events::{
            room_key_bundle::RoomKeyBundleContent,
            room_key_withheld::{
                CommonWithheldCodeContent, MegolmV1AesSha2WithheldContent, RoomKeyWithheldContent,
            },
        },
    };
    use matrix_sdk_sqlite::SqliteCryptoStore;
    use ruma::{TransactionId, device_id, events::secret::request::SecretName, room_id, user_id};

    const LEGACY_KEY: [u8; 32] = [19; 32];

    async fn fixture() -> (tempfile::TempDir, String, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteCryptoStore::open_with_key(dir.path(), Some(&LEGACY_KEY))
            .await
            .unwrap();
        let account =
            Account::with_device_id(user_id!("@migration:example.org"), device_id!("MIGRATION"));
        let mut other =
            Account::with_device_id(user_id!("@other:example.org"), device_id!("OTHER"));
        other.generate_one_time_keys(1);
        let olm_session = account
            .create_outbound_session_helper(
                Default::default(),
                other.identity_keys().curve25519,
                *other.one_time_keys().values().next().unwrap(),
                false,
                account.device_keys(),
            )
            .unwrap();
        let sender = olm_session.sender_key.to_base64();
        let room = room_id!("!r:s.co");
        // The settings/downloaded room does not appear in any decrypted session.
        // Migration cannot reconstruct this ID by enumerating session metadata.
        let orphan = room_id!("!orphan:example.org");
        let (outbound, inbound) = account.create_group_session_pair_with_defaults(room).await;
        let session_id = inbound.session_id().to_owned();
        let secret_name = SecretName::from("org.example.custom-secret");
        let request_id = TransactionId::new();
        let withheld = RoomKeyWithheldEntry {
            sender: account.user_id().to_owned(),
            content: RoomKeyWithheldContent::MegolmV1AesSha2(
                MegolmV1AesSha2WithheldContent::Unverified(
                    CommonWithheldCodeContent::new(
                        room.to_owned(),
                        session_id.clone(),
                        account.identity_keys().curve25519,
                        account.device_id().to_owned(),
                    )
                    .into(),
                ),
            ),
        };
        let opaque_withheld:RoomKeyWithheldEntry=serde_json::from_value(serde_json::json!({"sender":account.user_id(),"content":{"algorithm":"org.example.future","code":"m.unavailable","future_info":"opaque"}})).unwrap();
        let file = ruma::events::room::EncryptedFile::new(
            "mxc://example.org/bundle".into(),
            ruma::events::room::V2EncryptedFileInfo::encode([0; 32], [0; 16]).into(),
            Default::default(),
        );
        store
            .save_pending_changes(PendingChanges {
                account: Some(account.deep_clone()),
            })
            .await
            .unwrap();
        store
            .save_changes(Changes {
                private_identity: Some(PrivateCrossSigningIdentity::new(
                    account.user_id().to_owned(),
                )),
                backup_version: Some("backup-A".to_owned()),
                backup_decryption_key: Some(BackupDecryptionKey::new()),
                dehydrated_device_pickle_key: Some(DehydratedDeviceKey::new()),
                sessions: vec![olm_session],
                inbound_group_sessions: vec![inbound],
                outbound_group_sessions: vec![outbound],
                devices: DeviceChanges {
                    new: vec![DeviceData::from_account(&account)],
                    ..Default::default()
                },
                identities: IdentityChanges {
                    new: vec![get_other_identity().into()],
                    ..Default::default()
                },
                message_hashes: vec![OlmMessageHash {
                    sender_key: "old-sender".to_owned(),
                    hash: "old-replay-hash".to_owned(),
                }],
                key_requests: vec![GossipRequest {
                    request_recipient: account.user_id().to_owned(),
                    request_id: request_id.clone(),
                    info: SecretInfo::SecretRequest(SecretName::RecoveryKey),
                    sent_out: true,
                }],
                withheld_session_info: BTreeMap::from([(
                    room.to_owned(),
                    BTreeMap::from([
                        (session_id.clone(), withheld),
                        ("opaque-session".to_owned(), opaque_withheld),
                    ]),
                )]),
                room_settings: std::collections::HashMap::from([(
                    orphan.to_owned(),
                    RoomSettings {
                        only_allow_trusted_devices: true,
                        ..Default::default()
                    },
                )]),
                secrets: vec![SecretsInboxItem {
                    secret_name,
                    secret: "legacy-secret-value".to_owned().into(),
                }],
                next_batch_token: Some("legacy-to-device-token".to_owned()),
                received_room_key_bundles: vec![StoredRoomKeyBundleData {
                    sender_user: account.user_id().to_owned(),
                    sender_key: account.identity_keys().curve25519,
                    sender_data: SenderData::unknown(),
                    bundle_data: RoomKeyBundleContent {
                        room_id: room.to_owned(),
                        file,
                    },
                }],
                room_key_backups_fully_downloaded: std::collections::HashSet::from([
                    orphan.to_owned()
                ]),
                rooms_pending_key_bundle: std::collections::HashMap::from([(
                    room.to_owned(),
                    Some(RoomPendingKeyBundleDetails {
                        room_id: room.to_owned(),
                        invite_accepted_at: ruma::MilliSecondsSinceUnixEpoch::now(),
                        inviter: account.user_id().to_owned(),
                    }),
                )]),
            })
            .await
            .unwrap();
        store
            .mark_inbound_group_sessions_as_backed_up("backup-A", &[(room, &session_id)])
            .await
            .unwrap();
        store
            .save_tracked_users(&[(account.user_id(), true)])
            .await
            .unwrap();
        store
            .set_custom_value("довільний-ключ", vec![0, 1, 2, 255])
            .await
            .unwrap();
        store
            .try_take_leased_lock(0, "retired-lock", "old-holder")
            .await
            .unwrap();
        store.close().await.unwrap();
        drop(store);
        (dir, session_id, sender, request_id.to_string())
    }

    #[tokio::test]
    async fn complete_crypto_sqlite_transfer_preserves_every_family_and_alias_delete() {
        let (dir, session_id, sender, request_id) = fixture().await;
        let path = dir.path().join("matrix-sdk-crypto.sqlite3");
        let backend = crate::test_support::backend().await.unwrap();
        let import = read_crypto_backup(
            &path,
            LegacySecret::Key(&LEGACY_KEY),
            &backend.legacy_wrapping_key(),
        )
        .unwrap();
        assert_eq!(import.source_schema, 17);
        assert_eq!(import.identity.user_id, "@migration:example.org");
        assert_eq!(import.source_counts.len(), 16);
        assert!(
            import.source_counts.values().all(|count| *count > 0),
            "every pinned table must have synthetic coverage"
        );
        let source_digest = import.source_sha256;
        {
            let _guard = backend.mutation_lock.lock().await;
            backend.write(import.mutations).await.unwrap();
        }
        let store = MySqlCryptoStore::new(backend.clone());
        let account = store.load_account().await.unwrap().unwrap();
        assert_eq!(
            store.get_own_device().await.unwrap().device_id(),
            account.device_id()
        );
        assert_eq!(store.get_sessions(&sender).await.unwrap().unwrap().len(), 1);
        let room = room_id!("!r:s.co");
        let orphan = room_id!("!orphan:example.org");
        assert!(
            store
                .get_inbound_group_session(room, &session_id)
                .await
                .unwrap()
                .unwrap()
                .backed_up()
        );
        assert_eq!(
            store
                .inbound_group_session_counts(Some("backup-A"))
                .await
                .unwrap()
                .backed_up,
            1
        );
        assert!(
            store
                .get_outbound_group_session(room)
                .await
                .unwrap()
                .is_some()
        );
        assert!(store.load_identity().await.unwrap().is_some());
        assert!(
            store
                .get_user_identity(get_other_identity().user_id())
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(store.load_tracked_users().await.unwrap().len(), 1);
        assert!(
            store
                .is_message_known(&OlmMessageHash {
                    sender_key: "old-sender".to_owned(),
                    hash: "old-replay-hash".to_owned()
                })
                .await
                .unwrap()
        );
        let request: &ruma::TransactionId = request_id.as_str().into();
        assert!(
            store
                .get_outgoing_secret_requests(request)
                .await
                .unwrap()
                .unwrap()
                .sent_out
        );
        assert!(store.get_unsent_secret_requests().await.unwrap().is_empty());
        assert!(
            store
                .load_backup_keys()
                .await
                .unwrap()
                .decryption_key
                .is_some()
        );
        assert!(
            store
                .load_dehydrated_device_pickle_key()
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            store.next_batch_token().await.unwrap().as_deref(),
            Some("legacy-to-device-token")
        );
        assert!(
            store
                .get_withheld_info(room, &session_id)
                .await
                .unwrap()
                .is_some()
        );
        let mut opaque = store
            .get_withheld_info(room, "opaque-session")
            .await
            .unwrap()
            .unwrap();
        assert!(opaque.content.room_id().is_none());
        assert_eq!(
            store
                .get_withheld_sessions_by_room_id(room)
                .await
                .unwrap()
                .len(),
            2
        );
        opaque.sender = user_id!("@updated:example.org").to_owned();
        store
            .save_changes(Changes {
                withheld_session_info: BTreeMap::from([(
                    room.to_owned(),
                    BTreeMap::from([("opaque-session".to_owned(), opaque)]),
                )]),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            store
                .get_withheld_info(room, "opaque-session")
                .await
                .unwrap()
                .unwrap()
                .sender,
            user_id!("@updated:example.org")
        );
        let old_withheld_key = withheld_key(&backend, room.as_bytes(), b"opaque-session")
            .await
            .unwrap()
            .unwrap();
        assert!(
            backend
                .get(ALIAS_WITHHELD, &old_withheld_key)
                .await
                .unwrap()
                .is_none(),
            "overwrite retires opaque alias atomically"
        );
        assert!(
            store
                .get_received_room_key_bundle_data(room, account.user_id())
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            store
                .get_all_rooms_pending_key_bundles()
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.get_custom_value("довільний-ключ").await.unwrap(),
            Some(vec![0, 1, 2, 255])
        );
        assert!(
            store
                .get_room_settings(orphan)
                .await
                .unwrap()
                .unwrap()
                .only_allow_trusted_devices
        );
        assert!(store.has_downloaded_all_room_keys(orphan).await.unwrap());
        let name = SecretName::from("org.example.custom-secret");
        assert_eq!(
            store.get_secrets_from_inbox(&name).await.unwrap()[0].as_str(),
            "legacy-secret-value"
        );
        store
            .save_changes(Changes {
                secrets: vec![SecretsInboxItem {
                    secret_name: name.clone(),
                    secret: "new-secret".to_owned().into(),
                }],
                room_settings: std::collections::HashMap::from([(
                    orphan.to_owned(),
                    RoomSettings::default(),
                )]),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(store.get_secrets_from_inbox(&name).await.unwrap().len(), 2);
        assert!(
            !store
                .get_room_settings(orphan)
                .await
                .unwrap()
                .unwrap()
                .only_allow_trusted_devices
        );
        store.delete_secrets_from_inbox(&name).await.unwrap();
        assert!(
            store
                .get_secrets_from_inbox(&name)
                .await
                .unwrap()
                .is_empty()
        );
        store.close().await.unwrap();
        store.reopen().await.unwrap();
        assert!(
            store
                .get_secrets_from_inbox(&name)
                .await
                .unwrap()
                .is_empty(),
            "retired alias must not resurrect after restart"
        );
        assert!(
            alias_get::<Vec<String>>(
                &backend,
                ALIAS_SECRETS,
                "secrets_inbox",
                name.as_str().as_bytes()
            )
            .await
            .unwrap()
            .is_none()
        );
        assert_eq!(
            source_digest,
            <[u8; 32]>::from(Sha256::digest(std::fs::read(path).unwrap())),
            "import never changes legacy source"
        );
        store.close().await.unwrap();
    }

    #[tokio::test]
    async fn crypto_import_rejects_unknown_schema_wrong_key_and_wal_snapshot() {
        let (dir, _, _, _) = fixture().await;
        let path = dir.path().join("matrix-sdk-crypto.sqlite3");
        assert!(read_crypto_backup(&path, LegacySecret::Key(&[20; 32]), &[7; 32]).is_err());
        let conn = Connection::open(&path).unwrap();
        conn.execute("CREATE TABLE unknown_crypto (value BLOB)", [])
            .unwrap();
        conn.close().unwrap();
        assert!(matches!(
            read_crypto_backup(&path, LegacySecret::Key(&LEGACY_KEY), &[7; 32]),
            Err(StoreError::Schema)
        ));
        let conn = Connection::open(&path).unwrap();
        conn.execute("DROP TABLE unknown_crypto", []).unwrap();
        conn.close().unwrap();
        // A sibling WAL (even empty) means this was not the promised standalone
        // backup; read-only importer must not silently ignore it.
        let wal = path.with_file_name("matrix-sdk-crypto.sqlite3-wal");
        let _wal = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        std::fs::hard_link(_wal.path(), &wal).unwrap();
        assert!(matches!(
            read_crypto_backup(&path, LegacySecret::Key(&LEGACY_KEY), &[7; 32]),
            Err(StoreError::InvalidConfiguration)
        ));
    }
}
