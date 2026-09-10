// Copyright 2026 Personal Consultant contributors.
// State/queue semantics adapted from matrix-sdk-base 0.18.0 MemoryStore:
// Copyright 2021 The Matrix.org Foundation C.I.C.
// Licensed under the Apache License, Version 2.0.
// https://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, this software is
// distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

//! Direct durable StateStore. Each record is read from MySQL; there is no
//! process-local state mirror. Backend fencing and the shared mutation mutex
//! protect read/modify/write operations, including atomic SDK state batches.

use crate::legacy_state::LegacyStateReader;
use crate::{Backend, Mutation, StoreError};
use async_trait::async_trait;
use matrix_sdk_base::{
    MinimalRoomMemberEvent, RoomInfo, RoomMemberships, RoomState, StateStoreDataKey,
    StateStoreDataValue,
    deserialized_responses::{DisplayName, RawAnySyncOrStrippedState},
    store::{
        ChildTransactionId, DependentQueuedRequest, DependentQueuedRequestKind, QueueWedgeError,
        QueuedRequest, QueuedRequestKind, RoomLoadSettings, SentRequestKey, StateChanges,
        StateStore, StoredThreadSubscription, compare_thread_subscription_bump_stamps,
    },
};
use matrix_sdk_common::ROOM_VERSION_RULES_FALLBACK;
use ruma::{
    CanonicalJsonObject, EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId,
    OwnedTransactionId, OwnedUserId, RoomId, TransactionId, UserId,
    canonical_json::{RedactedBecause, redact},
    events::{
        AnyGlobalAccountDataEvent, AnyRoomAccountDataEvent, AnyStrippedStateEvent,
        AnySyncStateEvent, GlobalAccountDataEventType, RoomAccountDataEventType, StateEventType,
        presence::PresenceEvent,
        receipt::{Receipt, ReceiptThread, ReceiptType},
        room::member::{MembershipState, StrippedRoomMemberEvent, SyncRoomMemberEvent},
    },
    serde::Raw,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};

type Result<T> = std::result::Result<T, StoreError>;
const KV: &str = "state.kv";
const STATE: &str = "state.event";
const STRIPPED: &str = "state.stripped";
const MEMBERS: &str = "state.member";
const PROFILES: &str = "state.profile";
const NAMES: &str = "state.name";
const ROOMS: &str = "state.room";
const PRESENCE: &str = "state.presence";
const ACCOUNT: &str = "state.account";
const ROOM_ACCOUNT: &str = "state.room_account";
const RECEIPTS: &str = "state.receipt";
const CUSTOM: &str = "state.custom";
const QUEUE: &str = "state.queue";
const DEPENDENT: &str = "state.dependent";
const THREADS: &str = "state.thread";
const META: &str = "state.meta";

#[derive(Debug)]
pub struct MySqlStateStore {
    backend: Arc<Backend>,
    legacy: tokio::sync::OnceCell<Option<LegacyStateReader>>,
}

fn key(parts: &[&str]) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(parts)?)
}
fn put<T: Serialize + ?Sized>(namespace: &str, key: Vec<u8>, value: &T) -> Result<Mutation> {
    Ok(Mutation::Put {
        namespace: namespace.into(),
        key,
        value: serde_json::to_vec(value)?,
    })
}
fn delete(namespace: &str, key: Vec<u8>) -> Mutation {
    Mutation::Delete {
        namespace: namespace.into(),
        key,
    }
}
fn name_key(name: &DisplayName) -> &str {
    name.as_normalized_str()
        .unwrap_or_else(|| name.as_raw_str())
}
fn kv_key(k: StateStoreDataKey<'_>) -> Result<Vec<u8>> {
    use StateStoreDataKey::*;
    key(&match k {
        SyncToken => vec!["sync"],
        SupportedVersions => vec!["versions"],
        WellKnown => vec!["well_known"],
        Filter(v) => vec!["filter", v],
        UserAvatarUrl(v) => vec!["avatar", v.as_str()],
        RecentlyVisitedRooms(v) => vec!["recent", v.as_str()],
        UtdHookManagerData => vec!["utd"],
        OneTimeKeyAlreadyUploaded => vec!["otk_uploaded"],
        ComposerDraft(r, t) => vec!["draft", r.as_str(), t.map_or("", EventId::as_str)],
        SeenKnockRequests(r) => vec!["knocks", r.as_str()],
        ThreadSubscriptionsCatchupTokens => vec!["thread_tokens"],
        HomeserverCapabilities => vec!["capabilities"],
    })
}

#[derive(Serialize, Deserialize)]
struct Member {
    user: OwnedUserId,
    membership: MembershipState,
    stripped: bool,
}
#[derive(Serialize, Deserialize)]
struct StoredReceipt {
    user: OwnedUserId,
    event: OwnedEventId,
    receipt: Receipt,
}
#[derive(Serialize, Deserialize)]
struct QueueEntry {
    kind: QueuedRequestKind,
    transaction_id: OwnedTransactionId,
    error: Option<QueueWedgeError>,
    priority: usize,
    created_at: MilliSecondsSinceUnixEpoch,
    sequence: u64,
}
impl QueueEntry {
    fn into_request(self) -> QueuedRequest {
        QueuedRequest {
            kind: self.kind,
            transaction_id: self.transaction_id,
            error: self.error,
            priority: self.priority,
            created_at: self.created_at,
        }
    }
}
#[derive(Serialize, Deserialize)]
struct DependentEntry {
    request: DependentQueuedRequest,
    sequence: u64,
}

#[derive(Serialize, Deserialize)]
struct ThreadEntry {
    status: String,
    bump_stamp: Option<u64>,
}
impl From<StoredThreadSubscription> for ThreadEntry {
    fn from(value: StoredThreadSubscription) -> Self {
        Self {
            status: value.status.as_str().into(),
            bump_stamp: value.bump_stamp,
        }
    }
}
impl TryFrom<ThreadEntry> for StoredThreadSubscription {
    type Error = StoreError;
    fn try_from(value: ThreadEntry) -> Result<Self> {
        Ok(Self {
            status: value.status.parse().map_err(|_| StoreError::Corrupt)?,
            bump_stamp: value.bump_stamp,
        })
    }
}

impl MySqlStateStore {
    pub fn new(backend: Arc<Backend>) -> Self {
        Self {
            backend,
            legacy: tokio::sync::OnceCell::new(),
        }
    }
    async fn legacy(&self) -> Result<Option<&LegacyStateReader>> {
        Ok(self
            .legacy
            .get_or_try_init(|| async {
                LegacyStateReader::load(self.backend.clone(), &self.backend.legacy_wrapping_key())
                    .await
            })
            .await?
            .as_ref())
    }
    async fn get_raw(&self, ns: &str, k: &[u8]) -> Result<Option<Vec<u8>>> {
        if let Some(value) = self.backend.get(ns, k).await? {
            return Ok(Some(value));
        }
        match self.legacy().await? {
            Some(legacy) => legacy.current_get(ns, k).await,
            None => Ok(None),
        }
    }
    // Called with the mutation lock held. Canonical replacement/deletion and
    // suppression of its opaque legacy counterpart are ONE fenced transaction.
    async fn write(&self, mut batch: Vec<Mutation>) -> Result<()> {
        if let Some(legacy) = self.legacy().await? {
            let mut suppressed = Vec::new();
            for op in &batch {
                match op {
                    Mutation::Put { namespace, key, .. } | Mutation::Delete { namespace, key }
                        if namespace.starts_with("state.") =>
                    {
                        suppressed.extend(legacy.suppress_current(namespace, key).await?)
                    }
                    Mutation::Clear { namespace } if namespace.starts_with("state.") => {
                        return Err(StoreError::Schema);
                    }
                    _ => {}
                }
            }
            suppressed.append(&mut batch);
            batch = suppressed;
        }
        self.backend.write(batch).await
    }
    async fn get<T: DeserializeOwned>(&self, ns: &str, k: &[u8]) -> Result<Option<T>> {
        self.get_raw(ns, k)
            .await?
            .map(|v| serde_json::from_slice(&v).map_err(Into::into))
            .transpose()
    }
    async fn scan_native<T: DeserializeOwned>(
        &self,
        ns: &str,
        prefix: &[&str],
    ) -> Result<Vec<(Vec<u8>, T)>> {
        let mut result = Vec::new();
        let mut encoded_prefix = if prefix.is_empty() {
            Vec::new()
        } else {
            key(prefix)?
        };
        // ["room","type"] -> ["room","type". The closing quote
        // remains, so a longer identifier cannot alias a component prefix.
        if !encoded_prefix.is_empty() {
            encoded_prefix.pop();
        }
        for (k, v) in self.backend.scan_prefix(ns, &encoded_prefix).await? {
            let parts: Vec<String> = serde_json::from_slice(&k)?;
            if parts.len() >= prefix.len() && parts.iter().zip(prefix).all(|(a, b)| a == b) {
                result.push((k, serde_json::from_slice(&v)?));
            }
        }
        Ok(result)
    }
    async fn scan<T: DeserializeOwned>(
        &self,
        ns: &str,
        prefix: &[&str],
    ) -> Result<Vec<(Vec<u8>, T)>> {
        let mut rows: BTreeMap<Vec<u8>, T> = BTreeMap::new();
        if let Some(legacy) = self.legacy().await? {
            for (k, v) in legacy.current_scan(ns, prefix).await? {
                rows.insert(k, serde_json::from_slice(&v)?);
            }
        }
        for (k, v) in self.scan_native(ns, prefix).await? {
            rows.insert(k, v);
        }
        Ok(rows.into_iter().collect())
    }
    async fn remove_prefix(
        &self,
        ns: &str,
        prefix: &[&str],
        batch: &mut Vec<Mutation>,
    ) -> Result<()> {
        for (k, _) in self.scan::<serde_json::Value>(ns, prefix).await? {
            batch.push(delete(ns, k));
        }
        Ok(())
    }
    // Called only with mutation_lock held. The counter and its request commit
    // together, so equal-priority order survives retries and process restarts.
    async fn next_sequence(&self, batch: &mut Vec<Mutation>) -> Result<u64> {
        let k = key(&["sequence"])?;
        let current = self.get::<u64>(META, &k).await?.unwrap_or(0);
        let next = current.checked_add(1).ok_or_else(|| {
            serde_json::Error::io(std::io::Error::other("state queue sequence exhausted"))
        })?;
        batch.push(put(META, k, &next)?);
        Ok(next)
    }
}

#[async_trait]
impl StateStore for MySqlStateStore {
    type Error = StoreError;
    async fn get_kv_data(&self, k: StateStoreDataKey<'_>) -> Result<Option<StateStoreDataValue>> {
        let Some(v) = self.get_raw(KV, &kv_key(k)?).await? else {
            return Ok(None);
        };
        use StateStoreDataKey as K;
        use StateStoreDataValue as V;
        Ok(Some(match k {
            K::SyncToken => V::SyncToken(serde_json::from_slice(&v)?),
            K::SupportedVersions => V::SupportedVersions(serde_json::from_slice(&v)?),
            K::WellKnown => V::WellKnown(serde_json::from_slice(&v)?),
            K::Filter(_) => V::Filter(serde_json::from_slice(&v)?),
            K::UserAvatarUrl(_) => V::UserAvatarUrl(serde_json::from_slice(&v)?),
            K::RecentlyVisitedRooms(_) => V::RecentlyVisitedRooms(serde_json::from_slice(&v)?),
            K::UtdHookManagerData => V::UtdHookManagerData(serde_json::from_slice(&v)?),
            K::OneTimeKeyAlreadyUploaded => {
                let _: () = serde_json::from_slice(&v)?;
                V::OneTimeKeyAlreadyUploaded
            }
            K::ComposerDraft(..) => V::ComposerDraft(serde_json::from_slice(&v)?),
            K::SeenKnockRequests(_) => V::SeenKnockRequests(serde_json::from_slice(&v)?),
            K::ThreadSubscriptionsCatchupTokens => {
                V::ThreadSubscriptionsCatchupTokens(serde_json::from_slice(&v)?)
            }
            K::HomeserverCapabilities => V::HomeserverCapabilities(serde_json::from_slice(&v)?),
        }))
    }
    async fn set_kv_data(
        &self,
        k: StateStoreDataKey<'_>,
        value: StateStoreDataValue,
    ) -> Result<()> {
        use StateStoreDataKey as K;
        use StateStoreDataValue as V;
        let bytes = match (k, value) {
            (K::SyncToken, V::SyncToken(v)) | (K::Filter(_), V::Filter(v)) => {
                serde_json::to_vec(&v)?
            }
            (K::SupportedVersions, V::SupportedVersions(v)) => serde_json::to_vec(&v)?,
            (K::WellKnown, V::WellKnown(v)) => serde_json::to_vec(&v)?,
            (K::UserAvatarUrl(_), V::UserAvatarUrl(v)) => serde_json::to_vec(&v)?,
            (K::RecentlyVisitedRooms(_), V::RecentlyVisitedRooms(v)) => serde_json::to_vec(&v)?,
            (K::UtdHookManagerData, V::UtdHookManagerData(v)) => serde_json::to_vec(&v)?,
            (K::OneTimeKeyAlreadyUploaded, V::OneTimeKeyAlreadyUploaded) => {
                serde_json::to_vec(&())?
            }
            (K::ComposerDraft(..), V::ComposerDraft(v)) => serde_json::to_vec(&v)?,
            (K::SeenKnockRequests(_), V::SeenKnockRequests(v)) => serde_json::to_vec(&v)?,
            (K::ThreadSubscriptionsCatchupTokens, V::ThreadSubscriptionsCatchupTokens(v)) => {
                serde_json::to_vec(&v)?
            }
            (K::HomeserverCapabilities, V::HomeserverCapabilities(v)) => serde_json::to_vec(&v)?,
            _ => panic!("state key/value variants must match"),
        };
        let _guard = self.backend.mutation_lock.lock().await;
        self.write(vec![Mutation::Put {
            namespace: KV.into(),
            key: kv_key(k)?,
            value: bytes,
        }])
        .await
    }
    async fn remove_kv_data(&self, k: StateStoreDataKey<'_>) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.write(vec![delete(KV, kv_key(k)?)]).await
    }
    async fn save_changes(&self, changes: &StateChanges) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut batch = Vec::new();
        // A room can move from joined/left to invited and back. Remove the
        // obsolete representation before inserting this batch, exactly as the
        // pinned SQLite store does. RoomInfo-only transitions also clean up.
        for (r, info) in &changes.room_infos {
            let invited = info.state() == RoomState::Invited;
            self.remove_prefix(
                if invited { STATE } else { STRIPPED },
                &[r.as_str()],
                &mut batch,
            )
            .await?;
            for (k, member) in self.scan::<Member>(MEMBERS, &[r.as_str()]).await? {
                if member.stripped != invited {
                    batch.push(delete(MEMBERS, k));
                }
            }
        }
        if let Some(token) = &changes.sync_token {
            batch.push(put(KV, kv_key(StateStoreDataKey::SyncToken)?, token)?);
        }
        for (r, users) in &changes.profiles_to_delete {
            for u in users {
                batch.push(delete(PROFILES, key(&[r.as_str(), u.as_str()])?));
            }
        }
        for (r, users) in &changes.profiles {
            for (u, v) in users {
                batch.push(put(PROFILES, key(&[r.as_str(), u.as_str()])?, v)?);
            }
        }
        for (r, names) in &changes.ambiguity_maps {
            for (n, v) in names {
                batch.push(put(NAMES, key(&[r.as_str(), name_key(n)])?, v)?);
            }
        }
        for (t, v) in &changes.account_data {
            batch.push(put(ACCOUNT, key(&[&t.to_string()])?, v)?);
        }
        for (r, events) in &changes.room_account_data {
            for (t, v) in events {
                batch.push(put(ROOM_ACCOUNT, key(&[r.as_str(), &t.to_string()])?, v)?);
            }
        }
        // Keep a batch overlay so a redaction can target a state event saved
        // by this same sync response, without reading uncommitted data.
        let mut state_overlay: BTreeMap<Vec<u8>, Raw<AnySyncStateEvent>> = BTreeMap::new();
        for (r, types) in &changes.state {
            if !types.is_empty() {
                self.remove_prefix(STRIPPED, &[r.as_str()], &mut batch)
                    .await?;
                for (k, m) in self.scan::<Member>(MEMBERS, &[r.as_str()]).await? {
                    if m.stripped {
                        batch.push(delete(MEMBERS, k));
                    }
                }
            }
            for (t, events) in types {
                for (s, v) in events {
                    let k = key(&[r.as_str(), &t.to_string(), s])?;
                    state_overlay.insert(k, v.clone());
                    if *t == StateEventType::RoomMember
                        && let Ok(ev) = v.deserialize_as_unchecked::<SyncRoomMemberEvent>()
                    {
                        batch.push(put(
                            MEMBERS,
                            key(&[r.as_str(), ev.state_key().as_str()])?,
                            &Member {
                                user: ev.state_key().to_owned(),
                                membership: ev.membership().clone(),
                                stripped: false,
                            },
                        )?);
                    }
                }
            }
        }
        for (r, types) in &changes.stripped_state {
            for (t, events) in types {
                for (s, v) in events {
                    batch.push(put(STRIPPED, key(&[r.as_str(), &t.to_string(), s])?, v)?);
                    if *t == StateEventType::RoomMember
                        && let Ok(ev) = v.deserialize_as_unchecked::<StrippedRoomMemberEvent>()
                    {
                        batch.push(put(
                            MEMBERS,
                            key(&[r.as_str(), ev.state_key.as_str()])?,
                            &Member {
                                user: ev.state_key.clone(),
                                membership: ev.content.membership,
                                stripped: true,
                            },
                        )?);
                    }
                }
            }
        }
        for (r, info) in &changes.room_infos {
            batch.push(put(ROOMS, key(&[r.as_str()])?, info)?);
        }
        for (u, v) in &changes.presence {
            batch.push(put(PRESENCE, key(&[u.as_str()])?, v)?);
        }
        // A receipt's key is user/type/thread: replacing it automatically
        // removes the old event association, including replacements in a batch.
        for (r, content) in &changes.receipts {
            for (event, types) in &content.0 {
                for (t, users) in types {
                    for (u, receipt) in users {
                        batch.push(put(
                            RECEIPTS,
                            key(&[
                                r.as_str(),
                                t.as_ref(),
                                receipt.thread.as_str().unwrap_or(""),
                                u.as_str(),
                            ])?,
                            &StoredReceipt {
                                user: u.clone(),
                                event: event.clone(),
                                receipt: receipt.clone(),
                            },
                        )?);
                    }
                }
            }
        }
        for (r, redactions) in &changes.redactions {
            let info = match changes.room_infos.get(r) {
                Some(v) => Some(v.clone()),
                None => self.get::<RoomInfo>(ROOMS, &key(&[r.as_str()])?).await?,
            };
            let rules = info
                .as_ref()
                .map(RoomInfo::room_version_rules_or_default)
                .unwrap_or(ROOM_VERSION_RULES_FALLBACK)
                .redaction;
            let cleared = changes
                .room_infos
                .get(r)
                .is_some_and(|v| v.state() == RoomState::Invited);
            let mut events: BTreeMap<_, _> = if cleared {
                BTreeMap::new()
            } else {
                self.scan::<Raw<AnySyncStateEvent>>(STATE, &[r.as_str()])
                    .await?
                    .into_iter()
                    .collect()
            };
            for (k, v) in &state_overlay {
                let parts: Vec<String> = serde_json::from_slice(k)?;
                if parts[0] == r.as_str() {
                    events.insert(k.clone(), v.clone());
                }
            }
            for (k, v) in events {
                if let Ok(Some(id)) = v.get_field::<OwnedEventId>("event_id")
                    && let Some(redaction) = redactions.get(&id)
                {
                    let object = redact(
                        v.deserialize_as::<CanonicalJsonObject>()?,
                        &rules,
                        Some(RedactedBecause::from_raw_event(redaction)?),
                    )
                    .map_err(|_| {
                        serde_json::Error::io(std::io::Error::other("state event redaction failed"))
                    })?;
                    state_overlay.insert(k, Raw::new(&object)?.cast_unchecked());
                }
            }
        }
        for (k, v) in state_overlay {
            batch.push(put(STATE, k, &v)?);
        }
        self.write(batch).await
    }
    async fn get_presence_event(&self, u: &UserId) -> Result<Option<Raw<PresenceEvent>>> {
        self.get(PRESENCE, &key(&[u.as_str()])?).await
    }
    async fn get_presence_events(&self, users: &[OwnedUserId]) -> Result<Vec<Raw<PresenceEvent>>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut out = Vec::new();
        for u in users {
            if let Some(v) = self.get_presence_event(u).await? {
                out.push(v);
            }
        }
        Ok(out)
    }
    async fn get_state_event(
        &self,
        r: &RoomId,
        t: StateEventType,
        s: &str,
    ) -> Result<Option<RawAnySyncOrStrippedState>> {
        Ok(self
            .get_state_events_for_keys(r, t, &[s])
            .await?
            .into_iter()
            .next())
    }
    async fn get_state_events(
        &self,
        r: &RoomId,
        t: StateEventType,
    ) -> Result<Vec<RawAnySyncOrStrippedState>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let stripped = self
            .scan::<Raw<AnyStrippedStateEvent>>(STRIPPED, &[r.as_str(), &t.to_string()])
            .await?;
        if !stripped.is_empty() {
            return Ok(stripped
                .into_iter()
                .map(|(_, v)| RawAnySyncOrStrippedState::Stripped(v))
                .collect());
        }
        Ok(self
            .scan::<Raw<AnySyncStateEvent>>(STATE, &[r.as_str(), &t.to_string()])
            .await?
            .into_iter()
            .map(|(_, v)| RawAnySyncOrStrippedState::Sync(v))
            .collect())
    }
    async fn get_state_events_for_keys(
        &self,
        r: &RoomId,
        t: StateEventType,
        keys: &[&str],
    ) -> Result<Vec<RawAnySyncOrStrippedState>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let stripped = !self
            .scan::<Raw<AnyStrippedStateEvent>>(STRIPPED, &[r.as_str(), &t.to_string()])
            .await?
            .is_empty();
        let mut out = Vec::new();
        for s in keys {
            let k = key(&[r.as_str(), &t.to_string(), s])?;
            if stripped {
                if let Some(v) = self.get(STRIPPED, &k).await? {
                    out.push(RawAnySyncOrStrippedState::Stripped(v));
                }
            } else if let Some(v) = self.get(STATE, &k).await? {
                out.push(RawAnySyncOrStrippedState::Sync(v));
            }
        }
        Ok(out)
    }
    async fn get_profile(&self, r: &RoomId, u: &UserId) -> Result<Option<MinimalRoomMemberEvent>> {
        self.get(PROFILES, &key(&[r.as_str(), u.as_str()])?).await
    }
    async fn get_profiles<'a>(
        &self,
        r: &RoomId,
        users: &'a [OwnedUserId],
    ) -> Result<BTreeMap<&'a UserId, MinimalRoomMemberEvent>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut out = BTreeMap::new();
        for u in users {
            if let Some(v) = self.get_profile(r, u).await? {
                out.insert(u.as_ref(), v);
            }
        }
        Ok(out)
    }
    async fn get_user_ids(&self, r: &RoomId, m: RoomMemberships) -> Result<Vec<OwnedUserId>> {
        Ok(self
            .scan::<Member>(MEMBERS, &[r.as_str()])
            .await?
            .into_iter()
            .filter(|(_, v)| m.matches(&v.membership))
            .map(|(_, v)| v.user)
            .collect())
    }
    async fn get_room_infos(&self, settings: &RoomLoadSettings) -> Result<Vec<RoomInfo>> {
        match settings {
            RoomLoadSettings::All => Ok(self
                .scan(ROOMS, &[])
                .await?
                .into_iter()
                .map(|(_, v)| v)
                .collect()),
            RoomLoadSettings::One(r) => Ok(self
                .get(ROOMS, &key(&[r.as_str()])?)
                .await?
                .into_iter()
                .collect()),
        }
    }
    async fn get_users_with_display_name(
        &self,
        r: &RoomId,
        n: &DisplayName,
    ) -> Result<BTreeSet<OwnedUserId>> {
        Ok(self
            .get(NAMES, &key(&[r.as_str(), name_key(n)])?)
            .await?
            .unwrap_or_default())
    }
    async fn get_users_with_display_names<'a>(
        &self,
        r: &RoomId,
        names: &'a [DisplayName],
    ) -> Result<HashMap<&'a DisplayName, BTreeSet<OwnedUserId>>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut out: HashMap<&DisplayName, BTreeSet<OwnedUserId>> = HashMap::new();
        for n in names {
            if let Some(v) = self.get(NAMES, &key(&[r.as_str(), name_key(n)])?).await? {
                out.insert(n, v);
            }
            // SQLite v15 can retain pre-normalization display-name hashes.
            // Match the pinned SDK's multi-name compatibility lookup by merging
            // the exact raw bucket as well as the normalized bucket.
            if n.as_raw_str() != name_key(n)
                && let Some(legacy) = self.legacy().await?
                && let Some(value) = legacy
                    .current_get(NAMES, &key(&[r.as_str(), n.as_raw_str()])?)
                    .await?
            {
                out.entry(n)
                    .or_default()
                    .extend(serde_json::from_slice::<BTreeSet<OwnedUserId>>(&value)?);
            }
        }
        Ok(out)
    }
    async fn get_account_data_event(
        &self,
        t: GlobalAccountDataEventType,
    ) -> Result<Option<Raw<AnyGlobalAccountDataEvent>>> {
        self.get(ACCOUNT, &key(&[&t.to_string()])?).await
    }
    async fn get_room_account_data_event(
        &self,
        r: &RoomId,
        t: RoomAccountDataEventType,
    ) -> Result<Option<Raw<AnyRoomAccountDataEvent>>> {
        self.get(ROOM_ACCOUNT, &key(&[r.as_str(), &t.to_string()])?)
            .await
    }
    async fn get_user_room_receipt_event(
        &self,
        r: &RoomId,
        t: ReceiptType,
        thread: ReceiptThread,
        u: &UserId,
    ) -> Result<Option<(OwnedEventId, Receipt)>> {
        Ok(self
            .get::<StoredReceipt>(
                RECEIPTS,
                &key(&[
                    r.as_str(),
                    t.as_ref(),
                    thread.as_str().unwrap_or(""),
                    u.as_str(),
                ])?,
            )
            .await?
            .map(|v| (v.event, v.receipt)))
    }
    async fn get_event_room_receipt_events(
        &self,
        r: &RoomId,
        t: ReceiptType,
        thread: ReceiptThread,
        event: &EventId,
    ) -> Result<Vec<(OwnedUserId, Receipt)>> {
        Ok(self
            .scan::<StoredReceipt>(
                RECEIPTS,
                &[r.as_str(), t.as_ref(), thread.as_str().unwrap_or("")],
            )
            .await?
            .into_iter()
            .filter(|(_, v)| v.event == event)
            .map(|(_, v)| (v.user, v.receipt))
            .collect())
    }
    async fn get_custom_value(&self, k: &[u8]) -> Result<Option<Vec<u8>>> {
        self.get_raw(CUSTOM, k).await
    }
    async fn set_custom_value(&self, k: &[u8], v: Vec<u8>) -> Result<Option<Vec<u8>>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let old = self.get_raw(CUSTOM, k).await?;
        self.write(vec![Mutation::Put {
            namespace: CUSTOM.into(),
            key: k.to_vec(),
            value: v,
        }])
        .await?;
        Ok(old)
    }
    async fn remove_custom_value(&self, k: &[u8]) -> Result<Option<Vec<u8>>> {
        let _guard = self.backend.mutation_lock.lock().await;
        let old = self.get_raw(CUSTOM, k).await?;
        self.write(vec![delete(CUSTOM, k.to_vec())]).await?;
        Ok(old)
    }
    async fn remove_room(&self, r: &RoomId) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut batch = Vec::new();
        for ns in [
            STATE,
            STRIPPED,
            MEMBERS,
            PROFILES,
            NAMES,
            ROOMS,
            ROOM_ACCOUNT,
            RECEIPTS,
            QUEUE,
            DEPENDENT,
            THREADS,
        ] {
            for (key, _) in self
                .scan_native::<serde_json::Value>(ns, &[r.as_str()])
                .await?
            {
                batch.push(delete(ns, key));
            }
        }
        if let Some(legacy) = self.legacy().await? {
            batch.extend(legacy.delete_room(r.as_bytes()).await?);
        }
        for (k, _) in self.backend.scan(KV).await? {
            let parts: Vec<String> = serde_json::from_slice(&k)?;
            if parts.len() > 1
                && (parts[0] == "draft" || parts[0] == "knocks")
                && parts[1] == r.as_str()
            {
                batch.push(delete(KV, k));
            }
        }
        self.write(batch).await
    }
    async fn save_send_queue_request(
        &self,
        r: &RoomId,
        transaction_id: OwnedTransactionId,
        created_at: MilliSecondsSinceUnixEpoch,
        kind: QueuedRequestKind,
        priority: usize,
    ) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut batch = Vec::new();
        let k = key(&[r.as_str(), transaction_id.as_str()])?;
        let sequence = match self.get::<QueueEntry>(QUEUE, &k).await? {
            Some(v) => v.sequence,
            None => self.next_sequence(&mut batch).await?,
        };
        batch.push(put(
            QUEUE,
            k,
            &QueueEntry {
                kind,
                transaction_id,
                error: None,
                priority,
                created_at,
                sequence,
            },
        )?);
        self.write(batch).await
    }
    async fn update_send_queue_request(
        &self,
        r: &RoomId,
        t: &TransactionId,
        kind: QueuedRequestKind,
    ) -> Result<bool> {
        let _guard = self.backend.mutation_lock.lock().await;
        let k = key(&[r.as_str(), t.as_str()])?;
        let Some(mut v) = self.get::<QueueEntry>(QUEUE, &k).await? else {
            return Ok(false);
        };
        v.kind = kind;
        v.error = None;
        self.write(vec![put(QUEUE, k, &v)?]).await?;
        Ok(true)
    }
    async fn remove_send_queue_request(&self, r: &RoomId, t: &TransactionId) -> Result<bool> {
        let _guard = self.backend.mutation_lock.lock().await;
        let k = key(&[r.as_str(), t.as_str()])?;
        let exists = self.get_raw(QUEUE, &k).await?.is_some();
        self.write(vec![delete(QUEUE, k)]).await?;
        Ok(exists)
    }
    async fn load_send_queue_requests(&self, r: &RoomId) -> Result<Vec<QueuedRequest>> {
        let mut entries: Vec<QueueEntry> = self
            .scan(QUEUE, &[r.as_str()])
            .await?
            .into_iter()
            .map(|(_, v)| v)
            .collect();
        entries.sort_by_key(|v| (Reverse(v.priority), v.sequence));
        Ok(entries.into_iter().map(QueueEntry::into_request).collect())
    }
    async fn update_send_queue_request_status(
        &self,
        r: &RoomId,
        t: &TransactionId,
        error: Option<QueueWedgeError>,
    ) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let k = key(&[r.as_str(), t.as_str()])?;
        if let Some(mut v) = self.get::<QueueEntry>(QUEUE, &k).await? {
            v.error = error;
            self.write(vec![put(QUEUE, k, &v)?]).await?;
        }
        Ok(())
    }
    async fn load_rooms_with_unsent_requests(&self) -> Result<Vec<OwnedRoomId>> {
        let mut rooms = BTreeSet::new();
        for (k, _) in self.scan::<QueueEntry>(QUEUE, &[]).await? {
            let parts: Vec<OwnedRoomId> = serde_json::from_slice::<Vec<String>>(&k)?
                .into_iter()
                .take(1)
                .map(|v| serde_json::from_value(serde_json::Value::String(v)))
                .collect::<std::result::Result<_, _>>()?;
            rooms.extend(parts);
        }
        Ok(rooms.into_iter().collect())
    }
    async fn save_dependent_queued_request(
        &self,
        r: &RoomId,
        parent: &TransactionId,
        own: ChildTransactionId,
        created_at: MilliSecondsSinceUnixEpoch,
        kind: DependentQueuedRequestKind,
    ) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut batch = Vec::new();
        let k = key(&[r.as_str(), own.as_str()])?;
        let sequence = match self.get::<DependentEntry>(DEPENDENT, &k).await? {
            Some(v) => v.sequence,
            None => self.next_sequence(&mut batch).await?,
        };
        let request = DependentQueuedRequest {
            own_transaction_id: own,
            kind,
            parent_transaction_id: parent.to_owned(),
            parent_key: None,
            created_at,
        };
        batch.push(put(DEPENDENT, k, &DependentEntry { request, sequence })?);
        self.write(batch).await
    }
    async fn mark_dependent_queued_requests_as_ready(
        &self,
        r: &RoomId,
        parent: &TransactionId,
        sent: SentRequestKey,
    ) -> Result<usize> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut batch = Vec::new();
        for (k, mut v) in self
            .scan::<DependentEntry>(DEPENDENT, &[r.as_str()])
            .await?
        {
            if v.request.parent_transaction_id == parent {
                v.request.parent_key = Some(sent.clone());
                batch.push(put(DEPENDENT, k, &v)?);
            }
        }
        let count = batch.len();
        self.write(batch).await?;
        Ok(count)
    }
    async fn update_dependent_queued_request(
        &self,
        r: &RoomId,
        t: &ChildTransactionId,
        kind: DependentQueuedRequestKind,
    ) -> Result<bool> {
        let _guard = self.backend.mutation_lock.lock().await;
        let k = key(&[r.as_str(), t.as_str()])?;
        let Some(mut v) = self.get::<DependentEntry>(DEPENDENT, &k).await? else {
            return Ok(false);
        };
        v.request.kind = kind;
        self.write(vec![put(DEPENDENT, k, &v)?]).await?;
        Ok(true)
    }
    async fn remove_dependent_queued_request(
        &self,
        r: &RoomId,
        t: &ChildTransactionId,
    ) -> Result<bool> {
        let _guard = self.backend.mutation_lock.lock().await;
        let k = key(&[r.as_str(), t.as_str()])?;
        let exists = self.get_raw(DEPENDENT, &k).await?.is_some();
        self.write(vec![delete(DEPENDENT, k)]).await?;
        Ok(exists)
    }
    async fn load_dependent_queued_requests(
        &self,
        r: &RoomId,
    ) -> Result<Vec<DependentQueuedRequest>> {
        let mut values: Vec<DependentEntry> = self
            .scan(DEPENDENT, &[r.as_str()])
            .await?
            .into_iter()
            .map(|(_, v)| v)
            .collect();
        values.sort_by_key(|v| v.sequence);
        Ok(values.into_iter().map(|v| v.request).collect())
    }
    async fn upsert_thread_subscriptions(
        &self,
        updates: Vec<(&RoomId, &EventId, StoredThreadSubscription)>,
    ) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        let mut overlay: BTreeMap<Vec<u8>, StoredThreadSubscription> = BTreeMap::new();
        for (r, t, mut new) in updates {
            let k = key(&[r.as_str(), t.as_str()])?;
            let old = match overlay.get(&k) {
                Some(v) => Some(*v),
                None => self
                    .get::<ThreadEntry>(THREADS, &k)
                    .await?
                    .map(TryInto::try_into)
                    .transpose()?,
            };
            if let Some(old) = old
                && !compare_thread_subscription_bump_stamps(old.bump_stamp, &mut new.bump_stamp)
            {
                continue;
            }
            overlay.insert(k, new);
        }
        let batch = overlay
            .into_iter()
            .map(|(k, v)| put(THREADS, k, &ThreadEntry::from(v)))
            .collect::<Result<Vec<_>>>()?;
        self.write(batch).await
    }
    async fn remove_thread_subscription(&self, r: &RoomId, t: &EventId) -> Result<()> {
        let _guard = self.backend.mutation_lock.lock().await;
        self.write(vec![delete(THREADS, key(&[r.as_str(), t.as_str()])?)])
            .await
    }
    async fn load_thread_subscription(
        &self,
        r: &RoomId,
        t: &EventId,
    ) -> Result<Option<StoredThreadSubscription>> {
        self.get::<ThreadEntry>(THREADS, &key(&[r.as_str(), t.as_str()])?)
            .await?
            .map(TryInto::try_into)
            .transpose()
    }
    async fn close(&self) -> Result<()> {
        self.backend.close().await
    }
    async fn reopen(&self) -> Result<()> {
        self.backend.reopen().await
    }
    async fn optimize(&self) -> Result<()> {
        self.backend.check_open().await
    }
    async fn get_size(&self) -> Result<Option<usize>> {
        self.backend.get_size().await
    }
}

#[cfg(all(test, feature = "integration-tests"))]
mod state_contract_tests {
    use super::*;
    async fn get_store()
    -> std::result::Result<MySqlStateStore, Box<dyn std::error::Error + Send + Sync>> {
        Ok(MySqlStateStore::new(crate::test_support::backend().await?))
    }
    matrix_sdk_base::statestore_integration_tests!();
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk_base::store::SerializableEventContent;
    use ruma::{events::room::message::RoomMessageEventContent, room_id, user_id};

    #[test]
    fn logical_keys_preserve_boundaries_and_unicode() {
        assert_ne!(key(&["a", "b:c"]).unwrap(), key(&["a:b", "c"]).unwrap());
        let original = [
            "!кімната:example.org",
            "@користувач:example.org",
            "quoted\"\u{0000}key",
        ];
        let encoded = key(&original).unwrap();
        assert_eq!(
            serde_json::from_slice::<Vec<String>>(&encoded).unwrap(),
            original
        );
    }

    #[test]
    fn typed_kv_keys_never_alias() {
        let room = room_id!("!room:example.org");
        let user = user_id!("@user:example.org");
        let keys = [
            StateStoreDataKey::SyncToken,
            StateStoreDataKey::Filter("sync"),
            StateStoreDataKey::UserAvatarUrl(user),
            StateStoreDataKey::RecentlyVisitedRooms(user),
            StateStoreDataKey::ComposerDraft(room, None),
            StateStoreDataKey::SeenKnockRequests(room),
            StateStoreDataKey::ThreadSubscriptionsCatchupTokens,
            StateStoreDataKey::HomeserverCapabilities,
        ];
        let encoded: BTreeSet<_> = keys.into_iter().map(|k| kv_key(k).unwrap()).collect();
        assert_eq!(encoded.len(), keys.len());
    }

    #[test]
    fn queued_request_round_trip_retains_order_and_content() {
        let kind: QueuedRequestKind =
            SerializableEventContent::new(&RoomMessageEventContent::text_plain("Привіт").into())
                .unwrap()
                .into();
        let original = QueueEntry {
            kind,
            transaction_id: "stable-transaction".into(),
            error: None,
            priority: 7,
            created_at: MilliSecondsSinceUnixEpoch::now(),
            sequence: 987,
        };
        let restored: QueueEntry =
            serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
        assert_eq!(restored.transaction_id, original.transaction_id);
        assert_eq!(restored.priority, original.priority);
        assert_eq!(restored.sequence, original.sequence);
        assert_eq!(restored.created_at, original.created_at);
        assert_eq!(
            serde_json::to_value(&restored.kind).unwrap(),
            serde_json::to_value(&original.kind).unwrap()
        );
        assert!(restored.into_request().as_event().is_some());
    }

    #[test]
    fn dependent_request_round_trip_preserves_parent_and_sequence() {
        let original = DependentEntry {
            sequence: 11,
            request: DependentQueuedRequest {
                own_transaction_id: "child".to_owned().into(),
                parent_transaction_id: "parent".into(),
                parent_key: None,
                kind: DependentQueuedRequestKind::RedactEvent,
                created_at: MilliSecondsSinceUnixEpoch::now(),
            },
        };
        let restored: DependentEntry =
            serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
        assert_eq!(restored.sequence, original.sequence);
        assert_eq!(
            restored.request.own_transaction_id,
            original.request.own_transaction_id
        );
        assert_eq!(
            restored.request.parent_transaction_id,
            original.request.parent_transaction_id
        );
    }

    #[test]
    fn thread_subscription_codec_preserves_all_statuses_and_rejects_unknown() {
        use matrix_sdk_base::store::ThreadSubscriptionStatus;
        for status in [
            ThreadSubscriptionStatus::Subscribed { automatic: true },
            ThreadSubscriptionStatus::Subscribed { automatic: false },
            ThreadSubscriptionStatus::Unsubscribed,
        ] {
            let original = StoredThreadSubscription {
                status,
                bump_stamp: Some(100),
            };
            let stored = ThreadEntry::from(original);
            let decoded: ThreadEntry =
                serde_json::from_slice(&serde_json::to_vec(&stored).unwrap()).unwrap();
            assert_eq!(
                StoredThreadSubscription::try_from(decoded).unwrap(),
                original
            );
        }
        assert!(matches!(
            StoredThreadSubscription::try_from(ThreadEntry {
                status: "unknown".into(),
                bump_stamp: None
            }),
            Err(StoreError::Corrupt)
        ));
    }
}
