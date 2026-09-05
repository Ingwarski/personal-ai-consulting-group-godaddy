//! Credential-free regressions against the pinned SDK's real state store and HTTP sender.
//! These isolate the cache/send barrier, not cross-signing or live E2EE certification.
use super::*;
use crate::live_policy::{LivePolicySource, PolicyError, authorize_current};
use matrix_sdk::{
    SessionMeta, SessionTokens,
    authentication::matrix::MatrixSession,
    config::RequestConfig,
    ruma::{api::MatrixVersion, room_id, user_id},
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct MockHomeserver {
    url: String,
    cached_state: Arc<std::sync::Mutex<Value>>,
    requests: Arc<std::sync::Mutex<Vec<String>>>,
    hold_send: Arc<AtomicBool>,
    send_entered: Arc<tokio::sync::Notify>,
    send_release: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockHomeserver {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn room_state(encrypted: bool, third_member: bool, history: &str) -> Value {
    let mut events = vec![
        (
            "m.room.create",
            "",
            json!({"creator":"@bot:matrix.org","room_version":"10"}),
        ),
        (
            "m.room.member",
            "@bot:matrix.org",
            json!({"membership":"join"}),
        ),
        (
            "m.room.member",
            "@owner:matrix.org",
            json!({"membership":"join"}),
        ),
        (
            "m.room.history_visibility",
            "",
            json!({"history_visibility":history}),
        ),
        ("m.room.join_rules", "", json!({"join_rule":"invite"})),
        (
            "m.room.guest_access",
            "",
            json!({"guest_access":"forbidden"}),
        ),
    ];
    if encrypted {
        events.push((
            "m.room.encryption",
            "",
            json!({"algorithm":"m.megolm.v1.aes-sha2"}),
        ));
    }
    if third_member {
        events.push((
            "m.room.member",
            "@third:matrix.org",
            json!({"membership":"join"}),
        ));
    }
    Value::Array(
        events
            .into_iter()
            .enumerate()
            .map(|(index, (kind, key, content))| {
                json!({
                    "type":kind,"state_key":key,"content":content,"sender":"@bot:matrix.org",
                    "event_id":format!("$state-{index}:matrix.org"),"origin_server_ts":1,
                    "room_id":"!room:matrix.org"
                })
            })
            .collect(),
    )
}

impl MockHomeserver {
    async fn start(cached_state: Value) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let cached_state = Arc::new(std::sync::Mutex::new(cached_state));
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let fixture = cached_state.clone();
        let observed = requests.clone();
        let generation = Arc::new(AtomicU64::new(0));
        let hold_send = Arc::new(AtomicBool::new(false));
        let send_entered = Arc::new(tokio::sync::Notify::new());
        let send_release = Arc::new(tokio::sync::Notify::new());
        let sending = (
            hold_send.clone(),
            send_entered.clone(),
            send_release.clone(),
        );
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let fixture = fixture.clone();
                let observed = observed.clone();
                let generation = generation.clone();
                let sending = sending.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    let (path, header_end, content_length) = loop {
                        let mut chunk = [0_u8; 4096];
                        let count = socket.read(&mut chunk).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                        assert!(bytes.len() < 1024 * 1024);
                        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&bytes[..end]);
                            let path = header
                                .lines()
                                .next()
                                .unwrap()
                                .split_whitespace()
                                .nth(1)
                                .unwrap()
                                .to_owned();
                            let length = header
                                .lines()
                                .filter_map(|line| line.split_once(':'))
                                .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
                            break (path, end + 4, length);
                        }
                    };
                    while bytes.len() < header_end + content_length {
                        let mut chunk = [0_u8; 4096];
                        let count = socket.read(&mut chunk).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                    }
                    observed.lock().unwrap().push(path.clone());
                    let state = fixture.lock().unwrap().clone();
                    let endpoint = path.split('?').next().unwrap();
                    if endpoint.contains("/send/") && sending.0.load(Ordering::SeqCst) {
                        sending.1.notify_one();
                        sending.2.notified().await;
                    }
                    let (status, body) = if endpoint.ends_with("/sync") {
                        let token = generation.fetch_add(1, Ordering::SeqCst);
                        (
                            200,
                            json!({"next_batch":format!("s{token}"),"rooms":{"join":{"!room:matrix.org":{
                            "state":{"events":state},"timeline":{"events":[],"limited":false,"prev_batch":"p0"},
                            "ephemeral":{"events":[]},"account_data":{"events":[]}
                        }}},"device_lists":{"changed":[],"left":[]},"to_device":{"events":[]}}),
                        )
                    } else if endpoint.ends_with("/members") {
                        (
                            200,
                            json!({"chunk":state.as_array().unwrap().iter().filter(|event| event["type"] == "m.room.member").collect::<Vec<_>>()}),
                        )
                    } else if endpoint.ends_with("/state") {
                        // Independent authoritative state stays good even when the SDK cache differs.
                        (200, room_state(true, false, "joined"))
                    } else if endpoint.contains("/directory/list/room/") {
                        (200, json!({"visibility":"private"}))
                    } else if endpoint.ends_with("/aliases") {
                        (200, json!({"aliases":[]}))
                    } else if endpoint.ends_with("/keys/query") {
                        (
                            200,
                            json!({"device_keys":{},"failures":{},"master_keys":{},"self_signing_keys":{},"user_signing_keys":{}}),
                        )
                    } else if endpoint.ends_with("/keys/upload") {
                        (200, json!({"one_time_key_counts":{}}))
                    } else if endpoint.ends_with("/keys/claim") {
                        (200, json!({"one_time_keys":{},"failures":{}}))
                    } else if endpoint.contains("/sendToDevice/") {
                        (200, json!({}))
                    } else if endpoint.contains("/send/") {
                        (200, json!({"event_id":"$sent:matrix.org"}))
                    } else {
                        (
                            404,
                            json!({"errcode":"M_NOT_FOUND","error":"fixture endpoint absent"}),
                        )
                    };
                    let body = body.to_string();
                    let response = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        Self {
            url,
            cached_state,
            requests,
            hold_send,
            send_entered,
            send_release,
            task,
        }
    }

    async fn client(&self) -> Client {
        let client = Client::builder()
            .homeserver_url(&self.url)
            .server_versions([MatrixVersion::V1_11])
            .with_room_key_recipient_strategy(
                matrix_sdk_base::crypto::CollectStrategy::OnlyTrustedDevices,
            )
            .with_enable_share_history_on_invite(false)
            .request_config(
                RequestConfig::new()
                    .retry_limit(0)
                    .timeout(Duration::from_secs(1)),
            )
            .build()
            .await
            .unwrap();
        client
            .restore_session(MatrixSession {
                meta: SessionMeta {
                    user_id: user_id!("@bot:matrix.org").to_owned(),
                    device_id: "BOT".into(),
                },
                tokens: SessionTokens {
                    access_token: "fixture-token".into(),
                    refresh_token: None,
                },
            })
            .await
            .unwrap();
        client
    }

    fn clear(&self) {
        self.requests.lock().unwrap().clear();
    }
    fn writes(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|path| path.contains("/send/") || path.contains("/sendToDevice/"))
            .cloned()
            .collect()
    }
}

struct HttpPolicy<'a>(&'a MockHomeserver);
impl HttpPolicy<'_> {
    async fn get(&self, suffix: &str) -> Result<Value, PolicyError> {
        let body = reqwest::get(format!("{}{suffix}", self.0.url))
            .await
            .map_err(|_| PolicyError::Unavailable)?
            .bytes()
            .await
            .map_err(|_| PolicyError::Unavailable)?;
        serde_json::from_slice(&body).map_err(|_| PolicyError::Unavailable)
    }
}
impl LivePolicySource for HttpPolicy<'_> {
    async fn room_state(&self) -> Result<Value, PolicyError> {
        self.get("/_matrix/client/v3/rooms/room/state").await
    }
    async fn visibility(&self) -> Result<Value, PolicyError> {
        self.get("/_matrix/client/v3/directory/list/room/room")
            .await
    }
    async fn aliases(&self) -> Result<Value, PolicyError> {
        self.get("/_matrix/client/v3/rooms/room/aliases").await
    }
    async fn refresh_verified_devices(&self) -> Result<(), PolicyError> {
        // Deliberately isolate cached room inputs; production performs signed SDK key queries.
        Ok(())
    }
}

fn expected() -> ExpectedRoom<'static> {
    ExpectedRoom {
        room_id: "!room:matrix.org",
        owner_mxid: "@owner:matrix.org",
        bot_mxid: "@bot:matrix.org",
        max_age_ms: 60_000,
    }
}

async fn fresh(server: &MockHomeserver) -> Result<(), TransportError> {
    authorize_current(
        &HttpPolicy(server),
        expected().room_id,
        expected().owner_mxid,
        expected().bot_mxid,
        Duration::from_secs(1),
    )
    .await
    .map_err(TransportError::from)
}

async fn sync(barrier: &Mutex<()>, client: &Client) {
    sync_with_sdk_guard(
        barrier,
        client,
        room_id!("!room:matrix.org"),
        SyncSettings::new().timeout(Duration::ZERO),
        Duration::from_secs(1),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn pinned_sdk_fresh_good_policy_cannot_authorize_stale_recipient_or_history_caches() {
    for (third, history) in [(true, "joined"), (false, "shared")] {
        let server = MockHomeserver::start(room_state(true, third, history)).await;
        let client = server.client().await;
        let barrier = Mutex::new(());
        sync(&barrier, &client).await;
        let room = client.get_room(room_id!("!room:matrix.org")).unwrap();
        assert!(room.are_members_synced());
        fresh(&server).await.unwrap();
        server.clear();
        assert!(matches!(
            send_with_sdk_guard(
                &barrier,
                &room,
                &expected(),
                fresh(&server),
                RoomMessageEventContent::text_plain("fixture"),
                "fixture-send".into()
            )
            .await,
            Err(TransportError::TransportFailed)
        ));
        assert!(
            server.writes().is_empty(),
            "stale SDK cache reached encryption/key sharing or send"
        );
    }
}

#[tokio::test]
async fn pinned_sdk_known_not_encrypted_cache_is_blocked_before_plaintext_send() {
    let server = MockHomeserver::start(room_state(false, false, "joined")).await;
    let client = server.client().await;
    let barrier = Mutex::new(());
    sync(&barrier, &client).await;
    let room = client.get_room(room_id!("!room:matrix.org")).unwrap();
    room.request_encryption_state().await.unwrap();
    assert!(matches!(
        room.encryption_state(),
        matrix_sdk_base::EncryptionState::NotEncrypted
    ));
    // Negative control proves the actual pinned SDK would send plaintext from this cache.
    room.send(RoomMessageEventContent::text_plain(
        "credential-free negative control",
    ))
    .await
    .unwrap();
    assert!(
        server
            .writes()
            .iter()
            .any(|path| path.contains("/send/m.room.message/"))
    );
    server.clear();
    assert!(matches!(
        send_with_sdk_guard(
            &barrier,
            &room,
            &expected(),
            fresh(&server),
            RoomMessageEventContent::text_plain("must not leave process"),
            "blocked-send".into()
        )
        .await,
        Err(TransportError::TransportFailed)
    ));
    assert!(server.writes().is_empty());
}

#[tokio::test]
async fn pinned_sdk_cache_validation_accepts_exact_encrypted_joined_recipients() {
    let server = MockHomeserver::start(room_state(true, false, "joined")).await;
    let client = server.client().await;
    let barrier = Mutex::new(());
    sync(&barrier, &client).await;
    let room = client.get_room(room_id!("!room:matrix.org")).unwrap();
    fresh(&server).await.unwrap();
    validate_sdk_send_cache(&room, &expected()).await.unwrap();
    server.clear();
    send_with_sdk_guard(
        &barrier,
        &room,
        &expected(),
        fresh(&server),
        RoomMessageEventContent::text_plain("encrypted cache fixture"),
        "encrypted-send".into(),
    )
    .await
    .unwrap();
    assert!(
        server
            .writes()
            .iter()
            .any(|path| path.contains("/send/m.room.encrypted/"))
    );
    assert!(
        !server
            .writes()
            .iter()
            .any(|path| path.contains("/send/m.room.message/"))
    );
    // Incomplete membership must not let room.send trigger an unchecked /members refresh.
    room.mark_members_missing();
    server.clear();
    assert!(validate_sdk_send_cache(&room, &expected()).await.is_err());
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pinned_sdk_concurrent_sync_drift_is_checked_before_send_and_lock_wait_is_bounded() {
    let server = Arc::new(MockHomeserver::start(room_state(true, false, "joined")).await);
    let client = server.client().await;
    let barrier = Arc::new(Mutex::new(()));
    sync(&barrier, &client).await;
    let room = client.get_room(room_id!("!room:matrix.org")).unwrap();
    validate_sdk_send_cache(&room, &expected()).await.unwrap();
    let held = barrier.lock().await;
    server.clear();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(20),
            send_with_sdk_guard(
                &barrier,
                &room,
                &expected(),
                fresh(&server),
                RoomMessageEventContent::text_plain("bounded waiter"),
                "waiter".into()
            )
        )
        .await
        .is_err()
    );
    assert!(server.requests.lock().unwrap().is_empty());
    *server.cached_state.lock().unwrap() = room_state(true, true, "joined");
    let mutation = tokio::spawn({
        let barrier = barrier.clone();
        let client = client.clone();
        async move {
            sync(&barrier, &client).await;
        }
    });
    // Tokio Mutex queues FIFO; explicitly poll the mutation waiter before send.
    tokio::task::yield_now().await;
    let send = tokio::spawn({
        let barrier = barrier.clone();
        let server = server.clone();
        async move {
            send_with_sdk_guard(
                &barrier,
                &room,
                &expected(),
                fresh(&server),
                RoomMessageEventContent::text_plain("must not share with third"),
                "drift-send".into(),
            )
            .await
        }
    });
    drop(held);
    mutation.await.unwrap();
    assert!(matches!(
        send.await.unwrap(),
        Err(TransportError::TransportFailed)
    ));
    assert!(server.writes().is_empty());
}

#[tokio::test]
async fn pinned_sdk_sync_cannot_mutate_checked_cache_during_the_actual_encrypted_send() {
    let server = Arc::new(MockHomeserver::start(room_state(true, false, "joined")).await);
    let client = server.client().await;
    let barrier = Arc::new(Mutex::new(()));
    sync(&barrier, &client).await;
    let room = client.get_room(room_id!("!room:matrix.org")).unwrap();
    server.clear();
    server.hold_send.store(true, Ordering::SeqCst);
    let sending = tokio::spawn({
        let barrier = barrier.clone();
        let server = server.clone();
        let room = room.clone();
        async move {
            send_with_sdk_guard(
                &barrier,
                &room,
                &expected(),
                fresh(&server),
                RoomMessageEventContent::text_plain("encrypted in-flight fixture"),
                "inflight-send".into(),
            )
            .await
        }
    });
    tokio::time::timeout(Duration::from_secs(10), server.send_entered.notified())
        .await
        .unwrap();
    assert!(
        server
            .writes()
            .iter()
            .any(|path| path.contains("/send/m.room.encrypted/"))
    );
    *server.cached_state.lock().unwrap() = room_state(true, true, "joined");
    let syncing = tokio::spawn({
        let barrier = barrier.clone();
        let client = client.clone();
        async move {
            sync(&barrier, &client).await;
        }
    });
    tokio::task::yield_now().await;
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|path| path.contains("/sync?"))
    );
    validate_sdk_send_cache(&room, &expected()).await.unwrap();
    server.send_release.notify_one();
    sending.await.unwrap().unwrap();
    syncing.await.unwrap();
    server.clear();
    assert!(matches!(
        send_with_sdk_guard(
            &barrier,
            &room,
            &expected(),
            fresh(&server),
            RoomMessageEventContent::text_plain("blocked after drift"),
            "post-drift".into()
        )
        .await,
        Err(TransportError::TransportFailed)
    ));
    assert!(server.writes().is_empty());
}
