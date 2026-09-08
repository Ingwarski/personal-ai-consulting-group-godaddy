// Copyright 2020, 2026 The Matrix.org Foundation C.I.C.
// Copyright 2026 Personal Consultant contributors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Durable implementation of Matrix SDK 0.18's complete crypto-store contract.
//! Serialization follows the SDK's public pickle APIs. No cache is authoritative:
//! a failed commit cannot leave a locally successful but non-durable mutation.

use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use async_trait::async_trait;
use matrix_sdk_common::cross_process_lock::CrossProcessLockGeneration;
use matrix_sdk_crypto::{
    Account, DeviceData, GossipRequest, SecretInfo, UserIdentityData,
    olm::{
        InboundGroupSession, OlmMessageHash, OutboundGroupSession, PickledInboundGroupSession,
        PrivateCrossSigningIdentity, SenderDataType, Session, StaticAccountData,
    },
    store::{
        CryptoStore,
        types::{
            BackupKeys, Changes, DehydratedDeviceKey, PendingChanges, RoomKeyCounts,
            RoomKeyWithheldEntry, RoomPendingKeyBundleDetails, RoomSettings,
            StoredRoomKeyBundleData, TrackedUser,
        },
    },
};
use ruma::{
    DeviceId, OwnedDeviceId, RoomId, TransactionId, UserId, events::secret::request::SecretName,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use vodozemac::Curve25519PublicKey;
use zeroize::Zeroizing;

use crate::legacy_crypto::{
    ALIAS_DOWNLOADED, ALIAS_SECRETS, ALIAS_SETTINGS, ALIAS_WITHHELD, alias_delete, alias_get,
    withheld_for_room, withheld_key,
};
use crate::{Backend, Mutation, StoreError};

type Result<T> = std::result::Result<T, StoreError>;

/// This adapter shares the backend's fenced transaction and serialization lock
/// with the state store and sidecar inbox, not a process-local imitation of SQL.
#[derive(Clone)]
pub struct MySqlCryptoStore {
    backend: Arc<Backend>,
    // Diagnostic SDK-test compatibility only. Reads and writes never rely on it.
    static_account: Arc<RwLock<Option<StaticAccountData>>>,
}

impl std::fmt::Debug for MySqlCryptoStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MySqlCryptoStore").finish_non_exhaustive()
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct InboundRecord {
    pub(crate) pickle: PickledInboundGroupSession,
    pub(crate) backed_up_to: Option<String>,
}

pub(crate) fn key(parts: &[&str]) -> Vec<u8> {
    // Length-delimited coordinates avoid collisions between concatenated IDs.
    let mut result = Vec::new();
    for part in parts {
        result.extend_from_slice(&(part.len() as u64).to_be_bytes());
        result.extend_from_slice(part.as_bytes());
    }
    result
}

pub(crate) fn put<T: Serialize>(namespace: &str, key: Vec<u8>, value: &T) -> Result<Mutation> {
    Ok(Mutation::Put {
        namespace: namespace.to_owned(),
        key,
        value: serde_json::to_vec(value)?,
    })
}

fn delete(namespace: &str, key: Vec<u8>) -> Mutation {
    Mutation::Delete {
        namespace: namespace.to_owned(),
        key,
    }
}

impl MySqlCryptoStore {
    // Caller holds mutation_lock so normal/legacy lookup is one logical read
    // relative to alias retirement by a concurrent save or delete.
    async fn secrets_unlocked(&self, name: &str) -> Result<Vec<String>> {
        if let Some(values) = self.get("crypto.secrets", &key(&[name])).await? {
            return Ok(values);
        }
        Ok(alias_get(
            &self.backend,
            ALIAS_SECRETS,
            "secrets_inbox",
            name.as_bytes(),
        )
        .await?
        .unwrap_or_default())
    }

    pub fn new(backend: Arc<Backend>) -> Self {
        Self {
            backend,
            static_account: Arc::new(RwLock::new(None)),
        }
    }

    pub fn get_static_account(&self) -> Option<StaticAccountData> {
        self.static_account
            .read()
            .ok()
            .and_then(|value| value.clone())
    }

    async fn get<T: DeserializeOwned>(&self, namespace: &str, key: &[u8]) -> Result<Option<T>> {
        self.backend
            .get(namespace, key)
            .await?
            .map(|value| serde_json::from_slice(&value).map_err(StoreError::from))
            .transpose()
    }

    async fn scan<T: DeserializeOwned>(&self, namespace: &str) -> Result<Vec<(Vec<u8>, T)>> {
        self.backend
            .scan(namespace)
            .await?
            .into_iter()
            .map(|(key, value)| Ok((key, serde_json::from_slice(&value)?)))
            .collect()
    }

    async fn scan_prefix<T: DeserializeOwned>(
        &self,
        namespace: &str,
        prefix: &[u8],
    ) -> Result<Vec<T>> {
        self.backend
            .scan_prefix(namespace, prefix)
            .await?
            .into_iter()
            .map(|(_, value)| serde_json::from_slice(&value).map_err(StoreError::from))
            .collect()
    }

    async fn inbound_mutations(
        &self,
        sessions: Vec<InboundGroupSession>,
        version: Option<&str>,
    ) -> Result<Vec<Mutation>> {
        let mut updates = Vec::with_capacity(sessions.len());
        for session in sessions {
            let coordinate = key(&[session.room_id().as_str(), session.session_id()]);
            // A sender-data update must not forget a previously committed backup.
            let previous: Option<InboundRecord> = self.get("crypto.inbound", &coordinate).await?;
            let backed_up_to = version
                .map(str::to_owned)
                .or_else(|| previous.and_then(|p| p.backed_up_to));
            if backed_up_to.is_some() {
                session.mark_as_backed_up();
            }
            updates.push(put(
                "crypto.inbound",
                coordinate,
                &InboundRecord {
                    pickle: session.pickle().await,
                    backed_up_to,
                },
            )?);
        }
        Ok(updates)
    }

    fn unpickle_inbound(record: InboundRecord) -> Result<InboundGroupSession> {
        let session =
            InboundGroupSession::from_pickle(record.pickle).map_err(|_| StoreError::Corrupt)?;
        if record.backed_up_to.is_some() {
            session.mark_as_backed_up();
        }
        Ok(session)
    }
}

#[async_trait]
impl CryptoStore for MySqlCryptoStore {
    type Error = StoreError;

    async fn load_account(&self) -> Result<Option<Account>> {
        let account = self
            .get("crypto.meta", b"account")
            .await?
            .map(|pickle| Account::from_pickle(pickle).map_err(|_| StoreError::Corrupt))
            .transpose()?;
        *self
            .static_account
            .write()
            .map_err(|_| StoreError::Corrupt)? = account.as_ref().map(|a| a.static_data().clone());
        Ok(account)
    }

    async fn load_identity(&self) -> Result<Option<PrivateCrossSigningIdentity>> {
        self.get("crypto.meta", b"identity")
            .await?
            .map(|pickle| {
                PrivateCrossSigningIdentity::from_pickle(pickle).map_err(|_| StoreError::Corrupt)
            })
            .transpose()
    }

    async fn save_pending_changes(&self, changes: PendingChanges) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let static_account = changes.account.as_ref().map(|a| a.static_data().clone());
        let mutations = match changes.account {
            Some(account) => vec![put("crypto.meta", b"account".to_vec(), &account.pickle())?],
            None => Vec::new(),
        };
        self.backend.write(mutations).await?;
        if let Some(account) = static_account {
            *self
                .static_account
                .write()
                .map_err(|_| StoreError::Corrupt)? = Some(account);
        }
        Ok(())
    }

    async fn save_changes(&self, changes: Changes) -> Result<()> {
        // Hold before any pickle await: sessions share internal mutable state.
        let _guard = self.backend.mutation_lock.lock().await;
        let mut updates = Vec::new();
        if let Some(identity) = changes.private_identity {
            updates.push(put(
                "crypto.meta",
                b"identity".to_vec(),
                &identity.pickle().await,
            )?);
        }
        for session in changes.sessions {
            updates.push(put(
                "crypto.sessions",
                key(&[&session.sender_key.to_base64(), session.session_id()]),
                &session.pickle().await,
            )?);
        }
        updates.extend(
            self.inbound_mutations(changes.inbound_group_sessions, None)
                .await?,
        );
        for session in changes.outbound_group_sessions {
            updates.push(put(
                "crypto.outbound",
                key(&[session.room_id().as_str()]),
                &session.pickle().await,
            )?);
        }
        for device in changes
            .devices
            .new
            .into_iter()
            .chain(changes.devices.changed)
        {
            updates.push(put(
                "crypto.devices",
                key(&[device.user_id().as_str(), device.device_id().as_str()]),
                &device,
            )?);
        }
        for device in changes.devices.deleted {
            updates.push(delete(
                "crypto.devices",
                key(&[device.user_id().as_str(), device.device_id().as_str()]),
            ));
        }
        for identity in changes
            .identities
            .new
            .into_iter()
            .chain(changes.identities.changed)
        {
            updates.push(put(
                "crypto.identities",
                key(&[identity.user_id().as_str()]),
                &identity,
            )?);
        }
        for hash in changes.message_hashes {
            updates.push(put(
                "crypto.message_hashes",
                key(&[&hash.sender_key, &hash.hash]),
                &true,
            )?);
        }
        for request in changes.key_requests {
            updates.push(put(
                "crypto.requests",
                key(&[request.request_id.as_str()]),
                &request,
            )?);
        }
        if let Some(version) = changes.backup_version {
            updates.push(put("crypto.meta", b"backup_version".to_vec(), &version)?);
        }
        if let Some(decryption_key) = changes.backup_decryption_key {
            updates.push(put("crypto.meta", b"backup_key".to_vec(), &decryption_key)?);
        }
        if let Some(dehydrated_key) = changes.dehydrated_device_pickle_key {
            updates.push(put(
                "crypto.meta",
                b"dehydrated_key".to_vec(),
                &dehydrated_key,
            )?);
        }
        // Group multiple secrets for the same name in this atomic SDK batch.
        let mut inbox: HashMap<String, Vec<String>> = HashMap::new();
        for secret in changes.secrets {
            let name = secret.secret_name.to_string();
            if !inbox.contains_key(&name) {
                let previous = self.secrets_unlocked(&name).await?;
                inbox.insert(name.clone(), previous);
            }
            inbox
                .get_mut(&name)
                .ok_or(StoreError::Corrupt)?
                .push(secret.secret.to_string());
        }
        for (name, secrets) in inbox {
            updates.push(put("crypto.secrets", key(&[&name]), &secrets)?);
            updates.extend(
                alias_delete(
                    &self.backend,
                    ALIAS_SECRETS,
                    "secrets_inbox",
                    name.as_bytes(),
                )
                .await?,
            );
        }
        for (room, sessions) in changes.withheld_session_info {
            for (session_id, event) in sessions {
                updates.push(put(
                    "crypto.withheld",
                    key(&[room.as_str(), &session_id]),
                    &event,
                )?);
                if let Some(coordinate) =
                    withheld_key(&self.backend, room.as_bytes(), session_id.as_bytes()).await?
                {
                    updates.push(delete(ALIAS_WITHHELD, coordinate));
                }
            }
        }
        if let Some(token) = changes.next_batch_token {
            updates.push(put("crypto.meta", b"next_batch".to_vec(), &token)?);
        }
        for (room, settings) in changes.room_settings {
            updates.push(put(
                "crypto.room_settings",
                key(&[room.as_str()]),
                &settings,
            )?);
            updates.extend(
                alias_delete(
                    &self.backend,
                    ALIAS_SETTINGS,
                    "room_settings",
                    room.as_bytes(),
                )
                .await?,
            );
        }
        for bundle in changes.received_room_key_bundles {
            updates.push(put(
                "crypto.bundles",
                key(&[
                    bundle.bundle_data.room_id.as_str(),
                    bundle.sender_user.as_str(),
                ]),
                &bundle,
            )?);
        }
        for room in changes.room_key_backups_fully_downloaded {
            updates.push(put("crypto.downloaded", key(&[room.as_str()]), &true)?);
            updates.extend(
                alias_delete(
                    &self.backend,
                    ALIAS_DOWNLOADED,
                    "room_key_backups_fully_downloaded",
                    room.as_bytes(),
                )
                .await?,
            );
        }
        for (room, details) in changes.rooms_pending_key_bundle {
            updates.push(match details {
                Some(details) => put("crypto.pending_bundles", key(&[room.as_str()]), &details)?,
                None => delete("crypto.pending_bundles", key(&[room.as_str()])),
            });
        }
        self.backend.write(updates).await
    }

    async fn save_inbound_group_sessions(
        &self,
        sessions: Vec<InboundGroupSession>,
        version: Option<&str>,
    ) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.backend
            .write(self.inbound_mutations(sessions, version).await?)
            .await
    }

    async fn get_sessions(&self, sender_key: &str) -> Result<Option<Vec<Session>>> {
        let device_keys = self.get_own_device().await?.as_device_keys().clone();
        let prefix = key(&[sender_key]);
        let mut sessions = Vec::new();
        for (_, value) in self.backend.scan_prefix("crypto.sessions", &prefix).await? {
            sessions.push(
                Session::from_pickle(device_keys.clone(), serde_json::from_slice(&value)?)
                    .map_err(|_| StoreError::Corrupt)?,
            );
        }
        Ok((!sessions.is_empty()).then_some(sessions))
    }

    async fn get_inbound_group_session(
        &self,
        room: &RoomId,
        session: &str,
    ) -> Result<Option<InboundGroupSession>> {
        self.get("crypto.inbound", &key(&[room.as_str(), session]))
            .await?
            .map(Self::unpickle_inbound)
            .transpose()
    }

    async fn get_withheld_info(
        &self,
        room: &RoomId,
        session: &str,
    ) -> Result<Option<RoomKeyWithheldEntry>> {
        let _guard = self.backend.mutation_lock.lock().await;
        if let Some(value) = self
            .get("crypto.withheld", &key(&[room.as_str(), session]))
            .await?
        {
            return Ok(Some(value));
        }
        let Some(coordinate) =
            withheld_key(&self.backend, room.as_bytes(), session.as_bytes()).await?
        else {
            return Ok(None);
        };
        self.get(ALIAS_WITHHELD, &coordinate).await
    }

    async fn get_withheld_sessions_by_room_id(
        &self,
        room: &RoomId,
    ) -> Result<Vec<RoomKeyWithheldEntry>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let prefix = key(&[room.as_str()]);
        let mut values = self.scan_prefix("crypto.withheld", &prefix).await?;
        values.extend(withheld_for_room(&self.backend, room.as_bytes()).await?);
        Ok(values)
    }

    async fn get_inbound_group_sessions(&self) -> Result<Vec<InboundGroupSession>> {
        self.scan("crypto.inbound")
            .await?
            .into_iter()
            .map(|(_, value)| Self::unpickle_inbound(value))
            .collect()
    }

    async fn inbound_group_session_counts(&self, version: Option<&str>) -> Result<RoomKeyCounts> {
        let records = self.scan::<InboundRecord>("crypto.inbound").await?;
        Ok(RoomKeyCounts {
            total: records.len(),
            backed_up: records
                .iter()
                .filter(|(_, r)| version.is_some() && r.backed_up_to.as_deref() == version)
                .count(),
        })
    }

    async fn get_inbound_group_sessions_by_room_id(
        &self,
        room: &RoomId,
    ) -> Result<Vec<InboundGroupSession>> {
        let prefix = key(&[room.as_str()]);
        self.scan_prefix("crypto.inbound", &prefix)
            .await?
            .into_iter()
            .map(Self::unpickle_inbound)
            .collect()
    }

    async fn get_inbound_group_sessions_for_device_batch(
        &self,
        curve_key: Curve25519PublicKey,
        sender_data_type: SenderDataType,
        after: Option<String>,
        limit: usize,
    ) -> Result<Vec<InboundGroupSession>> {
        let mut sessions: Vec<_> = self
            .get_inbound_group_sessions()
            .await?
            .into_iter()
            .filter(|s| {
                s.sender_key() == curve_key
                    && s.sender_data.to_type() == sender_data_type
                    && after
                        .as_ref()
                        .is_none_or(|after| s.session_id() > after.as_str())
            })
            .collect();
        sessions.sort_by(|a, b| a.session_id().cmp(b.session_id()));
        sessions.truncate(limit);
        Ok(sessions)
    }

    async fn inbound_group_sessions_for_backup(
        &self,
        version: &str,
        limit: usize,
    ) -> Result<Vec<InboundGroupSession>> {
        self.scan::<InboundRecord>("crypto.inbound")
            .await?
            .into_iter()
            .filter(|(_, r)| r.backed_up_to.as_deref() != Some(version))
            .take(limit)
            .map(|(_, r)| Self::unpickle_inbound(r))
            .collect()
    }

    async fn mark_inbound_group_sessions_as_backed_up(
        &self,
        version: &str,
        ids: &[(&RoomId, &str)],
    ) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut updates = Vec::new();
        for (room, session) in ids {
            let coordinate = key(&[room.as_str(), session]);
            if let Some(mut record) = self
                .get::<InboundRecord>("crypto.inbound", &coordinate)
                .await?
            {
                record.backed_up_to = Some(version.to_owned());
                let session = Self::unpickle_inbound(record)?;
                updates.push(put(
                    "crypto.inbound",
                    coordinate,
                    &InboundRecord {
                        pickle: session.pickle().await,
                        backed_up_to: Some(version.to_owned()),
                    },
                )?);
            }
        }
        self.backend.write(updates).await
    }

    async fn reset_backup_state(&self) -> Result<()> {
        // We track exact backup versions. As specified by CryptoStore, changing
        // the active version does not erase historical version membership.
        // Still validate the live backend (closed/fenced stores must not succeed).
        let _guard = self.backend.mutation_lock.lock().await;
        self.backend.write(Vec::new()).await
    }

    async fn load_backup_keys(&self) -> Result<BackupKeys> {
        // Read both values from one database statement: concurrent save_changes
        // must not expose a key from one backup and a version from another.
        let mut keys = BackupKeys::default();
        for (coordinate, value) in self.backend.scan("crypto.meta").await? {
            match coordinate.as_slice() {
                b"backup_version" => keys.backup_version = Some(serde_json::from_slice(&value)?),
                b"backup_key" => keys.decryption_key = Some(serde_json::from_slice(&value)?),
                _ => {}
            }
        }
        Ok(keys)
    }

    async fn load_dehydrated_device_pickle_key(&self) -> Result<Option<DehydratedDeviceKey>> {
        self.get("crypto.meta", b"dehydrated_key").await
    }

    async fn delete_dehydrated_device_pickle_key(&self) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.backend
            .write(vec![delete("crypto.meta", b"dehydrated_key".to_vec())])
            .await
    }

    async fn get_outbound_group_session(
        &self,
        room: &RoomId,
    ) -> Result<Option<OutboundGroupSession>> {
        let Some(pickle) = self.get("crypto.outbound", &key(&[room.as_str()])).await? else {
            return Ok(None);
        };
        let account = self.load_account().await?.ok_or(StoreError::Corrupt)?;
        let data = account.static_data();
        Ok(Some(
            OutboundGroupSession::from_pickle(
                data.device_id.clone(),
                data.identity_keys.clone(),
                pickle,
            )
            .map_err(|_| StoreError::Corrupt)?,
        ))
    }

    async fn load_tracked_users(&self) -> Result<Vec<TrackedUser>> {
        Ok(self
            .scan("crypto.tracked")
            .await?
            .into_iter()
            .map(|(_, value)| value)
            .collect())
    }

    async fn save_tracked_users(&self, users: &[(&UserId, bool)]) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.backend
            .write(
                users
                    .iter()
                    .map(|(user, dirty)| {
                        put(
                            "crypto.tracked",
                            key(&[user.as_str()]),
                            &TrackedUser {
                                user_id: (*user).to_owned(),
                                dirty: *dirty,
                            },
                        )
                    })
                    .collect::<Result<_>>()?,
            )
            .await
    }

    async fn get_device(&self, user: &UserId, device: &DeviceId) -> Result<Option<DeviceData>> {
        self.get("crypto.devices", &key(&[user.as_str(), device.as_str()]))
            .await
    }

    async fn get_user_devices(&self, user: &UserId) -> Result<HashMap<OwnedDeviceId, DeviceData>> {
        let prefix = key(&[user.as_str()]);
        Ok(self
            .scan_prefix::<DeviceData>("crypto.devices", &prefix)
            .await?
            .into_iter()
            .map(|d| (d.device_id().to_owned(), d))
            .collect())
    }

    async fn get_own_device(&self) -> Result<DeviceData> {
        let account = self.load_account().await?.ok_or(StoreError::Corrupt)?;
        self.get_device(account.user_id(), account.device_id())
            .await?
            .ok_or(StoreError::Corrupt)
    }

    async fn get_user_identity(&self, user: &UserId) -> Result<Option<UserIdentityData>> {
        self.get("crypto.identities", &key(&[user.as_str()])).await
    }

    async fn is_message_known(&self, hash: &OlmMessageHash) -> Result<bool> {
        Ok(self
            .get::<bool>(
                "crypto.message_hashes",
                &key(&[&hash.sender_key, &hash.hash]),
            )
            .await?
            .unwrap_or(false))
    }

    async fn get_outgoing_secret_requests(
        &self,
        request: &TransactionId,
    ) -> Result<Option<GossipRequest>> {
        self.get("crypto.requests", &key(&[request.as_str()])).await
    }

    async fn get_secret_request_by_info(&self, info: &SecretInfo) -> Result<Option<GossipRequest>> {
        Ok(self
            .scan::<GossipRequest>("crypto.requests")
            .await?
            .into_iter()
            .map(|(_, r)| r)
            .find(|r| &r.info == info))
    }

    async fn get_unsent_secret_requests(&self) -> Result<Vec<GossipRequest>> {
        Ok(self
            .scan::<GossipRequest>("crypto.requests")
            .await?
            .into_iter()
            .map(|(_, r)| r)
            .filter(|r| !r.sent_out)
            .collect())
    }

    async fn delete_outgoing_secret_requests(&self, request: &TransactionId) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.backend
            .write(vec![delete("crypto.requests", key(&[request.as_str()]))])
            .await
    }

    async fn get_secrets_from_inbox(&self, name: &SecretName) -> Result<Vec<Zeroizing<String>>> {
        let _guard = self.backend.mutation_lock.lock().await;
        Ok(self
            .secrets_unlocked(name.as_str())
            .await?
            .into_iter()
            .map(Zeroizing::new)
            .collect())
    }

    async fn delete_secrets_from_inbox(&self, name: &SecretName) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut mutations = vec![delete("crypto.secrets", key(&[name.as_str()]))];
        mutations.extend(
            alias_delete(
                &self.backend,
                ALIAS_SECRETS,
                "secrets_inbox",
                name.as_str().as_bytes(),
            )
            .await?,
        );
        self.backend.write(mutations).await
    }

    async fn get_room_settings(&self, room: &RoomId) -> Result<Option<RoomSettings>> {
        let _guard = self.backend.mutation_lock.lock().await;
        if let Some(value) = self
            .get("crypto.room_settings", &key(&[room.as_str()]))
            .await?
        {
            return Ok(Some(value));
        }
        alias_get(
            &self.backend,
            ALIAS_SETTINGS,
            "room_settings",
            room.as_bytes(),
        )
        .await
    }

    async fn get_received_room_key_bundle_data(
        &self,
        room: &RoomId,
        user: &UserId,
    ) -> Result<Option<StoredRoomKeyBundleData>> {
        self.get("crypto.bundles", &key(&[room.as_str(), user.as_str()]))
            .await
    }

    async fn get_pending_key_bundle_details_for_room(
        &self,
        room: &RoomId,
    ) -> Result<Option<RoomPendingKeyBundleDetails>> {
        self.get("crypto.pending_bundles", &key(&[room.as_str()]))
            .await
    }

    async fn get_all_rooms_pending_key_bundles(&self) -> Result<Vec<RoomPendingKeyBundleDetails>> {
        Ok(self
            .scan("crypto.pending_bundles")
            .await?
            .into_iter()
            .map(|(_, v)| v)
            .collect())
    }

    async fn has_downloaded_all_room_keys(&self, room: &RoomId) -> Result<bool> {
        let _guard = self.backend.mutation_lock.lock().await;
        if let Some(value) = self
            .get("crypto.downloaded", &key(&[room.as_str()]))
            .await?
        {
            return Ok(value);
        }
        Ok(alias_get(
            &self.backend,
            ALIAS_DOWNLOADED,
            "room_key_backups_fully_downloaded",
            room.as_bytes(),
        )
        .await?
        .unwrap_or(false))
    }

    async fn get_custom_value(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.backend.get("crypto.custom", key.as_bytes()).await
    }

    async fn set_custom_value(&self, key: &str, value: Vec<u8>) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.backend
            .write(vec![Mutation::Put {
                namespace: "crypto.custom".to_owned(),
                key: key.as_bytes().to_vec(),
                value,
            }])
            .await
    }

    async fn remove_custom_value(&self, key: &str) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.backend
            .write(vec![delete("crypto.custom", key.as_bytes().to_vec())])
            .await
    }

    async fn try_take_leased_lock(
        &self,
        duration: u32,
        key: &str,
        holder: &str,
    ) -> Result<Option<CrossProcessLockGeneration>> {
        self.backend
            .try_take_leased_lock(duration, key, holder)
            .await
    }

    async fn next_batch_token(&self) -> Result<Option<String>> {
        self.get("crypto.meta", b"next_batch").await
    }

    async fn close(&self) -> Result<()> {
        self.backend.close().await
    }
    async fn reopen(&self) -> Result<()> {
        self.backend.reopen().await
    }
    async fn get_size(&self) -> Result<Option<usize>> {
        self.backend.get_size().await
    }
}

#[cfg(test)]
mod coordinate_tests {
    use super::key;

    #[test]
    fn key_coordinates_are_unambiguous_and_support_component_prefixes() {
        assert_ne!(key(&["ab", "c"]), key(&["a", "bc"]));
        assert_ne!(key(&["", "abc"]), key(&["abc", ""]));
        assert!(
            key(&["!кімната:example.org", "session"]).starts_with(&key(&["!кімната:example.org"]))
        );
        assert!(
            !key(&["!кімната:example.org.x", "session"])
                .starts_with(&key(&["!кімната:example.org"]))
        );
    }
}

#[cfg(all(test, feature = "integration-tests"))]
#[path = "crypto_contract_tests.rs"]
mod contract_tests;
