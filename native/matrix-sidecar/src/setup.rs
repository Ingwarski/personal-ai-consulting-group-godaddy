//! Explicit, operator-controlled bootstrap. This module never installs message
//! ingress, sends consultation messages, logs credentials, or resets identity.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use matrix_sdk::{
    config::SyncSettings,
    encryption::verification::{SasVerification, VerificationRequest, VerificationRequestState},
    ruma::{OwnedUserId, events::key::verification::VerificationMethod},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::{
    client::MatrixClient,
    config::Config,
    store::{self, OpenStore, StoreError},
};

const MAX_INPUT_BYTES: usize = 4096;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_REQUESTS: usize = 2048;
const SETUP_LIFETIME: Duration = Duration::from_secs(15 * 60);
const FLOW_LIFETIME: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupRequest {
    pub version: u16,
    pub id: String,
    pub command: SetupCommand,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SetupCommand {
    Status {},
    StartSelfVerification {
        device_id: String,
    },
    StartOwnerVerification {
        device_id: String,
    },
    ConfirmSas {
        flow_id: String,
        comparison_token: String,
    },
    CancelSas {
        flow_id: String,
    },
    Finish {},
    Shutdown {},
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Target {
    Own,
    Owner,
}

struct ActiveVerification {
    target: Target,
    device_id: String,
    request: VerificationRequest,
    sas: Option<SasVerification>,
    generation: String,
    comparison_token: Option<String>,
    confirmed: bool,
    created: Instant,
}

struct Setup {
    store: OpenStore,
    config: Config,
    active: Option<ActiveVerification>,
    sync_barrier: Arc<tokio::sync::Mutex<()>>,
}

fn ascii_id(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn parse_request(bytes: &[u8], seen: &mut HashSet<String>) -> Result<SetupRequest, &'static str> {
    let request: SetupRequest = serde_json::from_slice(bytes).map_err(|_| "invalid_request")?;
    if request.version != 1
        || !ascii_id(&request.id, 64)
        || seen.len() >= MAX_REQUESTS
        || !seen.insert(request.id.clone())
    {
        return Err("invalid_request");
    }
    match &request.command {
        SetupCommand::StartSelfVerification { device_id }
        | SetupCommand::StartOwnerVerification { device_id }
            if !ascii_id(device_id, 255) =>
        {
            return Err("invalid_request");
        }
        SetupCommand::ConfirmSas {
            flow_id,
            comparison_token,
        } if !ascii_id(flow_id, 255) || !valid_comparison_token(comparison_token) => {
            return Err("invalid_request");
        }
        SetupCommand::CancelSas { flow_id } if !ascii_id(flow_id, 255) => {
            return Err("invalid_request");
        }
        _ => (),
    }
    Ok(request)
}

fn valid_comparison_token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn signing_subkeys_ready(status: &matrix_sdk_base::crypto::CrossSigningStatus) -> bool {
    // The private master key is needed for identity/key replacement, which
    // setup does not perform. Only these subkeys sign our device and owner;
    // verified public master identity is checked separately by runtime policy.
    status.has_self_signing && status.has_user_signing
}

fn confirmation_allowed(active: &ActiveVerification, flow_id: &str, token: &str) -> bool {
    comparison_matches(
        active.request.flow_id(),
        active.comparison_token.as_deref(),
        flow_id,
        token,
        !active.confirmed
            && active.created.elapsed() < FLOW_LIFETIME
            && !active.request.is_cancelled()
            && active
                .sas
                .as_ref()
                .is_some_and(|sas| sas.can_be_presented() && !sas.is_done() && !sas.is_cancelled()),
    )
}

fn comparison_matches(
    active_flow: &str,
    active_token: Option<&str>,
    submitted_flow: &str,
    submitted_token: &str,
    can_confirm: bool,
) -> bool {
    can_confirm && active_flow == submitted_flow && active_token == Some(submitted_token)
}

pub fn parse_options(arguments: &[String]) -> Result<(PathBuf, bool), &'static str> {
    let (root, fresh) = match arguments {
        [flag, root] if flag == "--application-root" => (root, false),
        [flag, root, provision]
            if flag == "--application-root" && provision == "--provision-fresh" =>
        {
            (root, true)
        }
        _ => return Err("invalid_options"),
    };
    let root = PathBuf::from(root);
    if !root.is_absolute()
        || root
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir))
    {
        return Err("invalid_options");
    }
    Ok((root, fresh))
}

/// Called while store.rs owns the exclusive crypto-store lock and before an SDK
/// Client can upload keys. A token copied from Element cannot be transplanted
/// into an empty store. A resumable store must match the already-published key.
pub(crate) async fn verify_session_binding(config: &Config) -> Result<(), StoreError> {
    let http = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| StoreError::Open)?;
    let whoami_url = config
        .homeserver
        .as_url()
        .join("/_matrix/client/v3/account/whoami")
        .map_err(|_| StoreError::Open)?;
    let whoami = bounded_json(
        http.get(whoami_url)
            .bearer_auth(config.access_token.as_str()),
    )
    .await?;
    if !session_matches(&whoami, &config.bot_mxid, &config.bot_device_id) {
        return Err(StoreError::Quarantined);
    }
    let keys_url = config
        .homeserver
        .as_url()
        .join("/_matrix/client/v3/keys/query")
        .map_err(|_| StoreError::Open)?;
    let keys = bounded_json(
        http.post(keys_url)
            .bearer_auth(config.access_token.as_str())
            .header("content-type", "application/json")
            .body(json!({"device_keys": {&config.bot_mxid: [&config.bot_device_id]}}).to_string()),
    )
    .await?;
    let local_identity = if config.store_root.join("matrix-sdk-crypto.sqlite3").exists() {
        crate::lock::verify_private_path(&config.store_root.join("matrix-sdk-crypto.sqlite3"))
            .map_err(|_| StoreError::Quarantined)?;
        store::setup_account_identity(config).await?
    } else {
        None
    };
    if !server_key_matches(
        &keys,
        &config.bot_mxid,
        &config.bot_device_id,
        local_identity.as_deref(),
    ) {
        return Err(StoreError::Quarantined);
    }
    Ok(())
}

fn session_matches(whoami: &Value, bot: &str, device: &str) -> bool {
    whoami.get("user_id").and_then(Value::as_str) == Some(bot)
        && whoami.get("device_id").and_then(Value::as_str) == Some(device)
        && whoami.get("is_guest").and_then(Value::as_bool) != Some(true)
}

fn server_key_matches(keys: &Value, bot: &str, device: &str, local_sha: Option<&str>) -> bool {
    let Some(users) = keys.get("device_keys").and_then(Value::as_object) else {
        return false;
    };
    if keys
        .get("failures")
        .is_some_and(|value| !value.as_object().is_some_and(|v| v.is_empty()))
    {
        return false;
    }
    let remote = users
        .get(bot)
        .and_then(Value::as_object)
        .and_then(|devices| devices.get(device));
    match (remote, local_sha) {
        // A new dedicated session has no E2EE device keys yet. The server may
        // omit its user map altogether, or return an empty map.
        (None, _) => users
            .get(bot)
            .is_none_or(|v| v.as_object().is_some_and(|v| !v.contains_key(device))),
        (Some(remote), Some(local)) => {
            remote.get("user_id").and_then(Value::as_str) == Some(bot)
                && remote.get("device_id").and_then(Value::as_str) == Some(device)
                && remote
                    .get("keys")
                    .and_then(|v| v.get(format!("ed25519:{device}")))
                    .and_then(Value::as_str)
                    .is_some_and(|key| hex::encode(Sha256::digest(key.as_bytes())) == local)
        }
        // Existing server keys with no matching local account are unsafe.
        // If the server has no keys, an already-bound local account can safely
        // resume an interrupted first upload; store.rs still validates that
        // account, device binding and exact resumable on-disk scenario.
        _ => false,
    }
}

async fn bounded_json(request: reqwest::RequestBuilder) -> Result<Value, StoreError> {
    let mut response = request.send().await.map_err(|_| StoreError::Open)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(StoreError::Open);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| StoreError::Open)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(StoreError::Open);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| StoreError::Open)
}

impl Setup {
    async fn refresh_identities(&self) -> Result<(), &'static str> {
        for mxid in [&self.config.bot_mxid, &self.config.owner_mxid] {
            let user: OwnedUserId = mxid.parse().map_err(|_| "configuration_invalid")?;
            self.store
                .client
                .encryption()
                .request_user_identity(&user)
                .await
                .map_err(|_| "transport_unavailable")?;
        }
        Ok(())
    }

    async fn private_keys_ready(&self) -> bool {
        self.store
            .client
            .encryption()
            .cross_signing_status()
            .await
            .is_some_and(|status| signing_subkeys_ready(&status))
    }

    async fn identity_verified(&self, mxid: &str) -> Result<bool, &'static str> {
        let user: OwnedUserId = mxid.parse().map_err(|_| "configuration_invalid")?;
        Ok(self
            .store
            .client
            .encryption()
            .get_user_identity(&user)
            .await
            .map_err(|_| "transport_unavailable")?
            .is_some_and(|identity| identity.is_verified()))
    }

    async fn start(&mut self, target: Target, device_id: String) -> Result<(), &'static str> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| !active.request.is_done() && !active.request.is_cancelled())
        {
            return Err("verification_already_active");
        }
        self.refresh_identities().await?;
        let mxid = match target {
            Target::Own => {
                if device_id == self.config.bot_device_id {
                    return Err("invalid_verification_target");
                }
                &self.config.bot_mxid
            }
            Target::Owner => {
                if !self.private_keys_ready().await
                    || !self.identity_verified(&self.config.bot_mxid).await?
                {
                    return Err("self_verification_required");
                }
                &self.config.owner_mxid
            }
        };
        let user: OwnedUserId = mxid.parse().map_err(|_| "configuration_invalid")?;
        let device = self
            .store
            .client
            .encryption()
            .get_device(&user, device_id.as_str().into())
            .await
            .map_err(|_| "transport_unavailable")?
            .ok_or("invalid_verification_target")?;
        if device.is_deleted() || device.is_blacklisted() || !device.is_cross_signed_by_owner() {
            return Err("peer_not_cross_signed");
        }
        // A Device request uses to-device transport. UserIdentity's other-user
        // helper can create a new DM, which this setup is not permitted to do.
        let request = device
            .request_verification_with_methods(vec![VerificationMethod::SasV1])
            .await
            .map_err(|_| "transport_unavailable")?;
        self.active = Some(ActiveVerification {
            target,
            device_id,
            request,
            sas: None,
            generation: uuid::Uuid::new_v4().simple().to_string(),
            comparison_token: None,
            confirmed: false,
            created: Instant::now(),
        });
        Ok(())
    }

    async fn progress(&mut self) -> Result<(), &'static str> {
        let Some(active) = self.active.as_mut() else {
            return Ok(());
        };
        if active.created.elapsed() >= FLOW_LIFETIME
            && !active.request.is_done()
            && !active.request.is_cancelled()
        {
            active
                .request
                .cancel()
                .await
                .map_err(|_| "transport_unavailable")?;
            active.comparison_token = None;
            return Ok(());
        }
        if active.sas.is_none() {
            match active.request.state() {
                VerificationRequestState::Ready {
                    other_device_data, ..
                } => {
                    if other_device_data.device_id().as_str() != active.device_id {
                        active
                            .request
                            .cancel()
                            .await
                            .map_err(|_| "transport_unavailable")?;
                        return Err("verification_peer_changed");
                    }
                    active.sas = active
                        .request
                        .start_sas()
                        .await
                        .map_err(|_| "transport_unavailable")?;
                }
                VerificationRequestState::Transitioned { verification } => {
                    active.sas = verification.sas()
                }
                _ => (),
            }
        }
        if let Some(sas) = &active.sas {
            if sas.other_device().device_id().as_str() != active.device_id
                || sas.other_user_id() != active.request.other_user_id()
            {
                sas.cancel().await.map_err(|_| "transport_unavailable")?;
                return Err("verification_peer_changed");
            }
            // Only continue the operator-initiated, exact-device request. No
            // unsolicited incoming request handler is installed anywhere.
            if matches!(
                sas.state(),
                matrix_sdk::encryption::verification::SasState::Started { .. }
            ) {
                sas.accept().await.map_err(|_| "transport_unavailable")?;
            }
            if sas.can_be_presented()
                && !sas.is_done()
                && !sas.is_cancelled()
                && active.comparison_token.is_none()
                && !active.confirmed
            {
                active.comparison_token = Some(uuid::Uuid::new_v4().simple().to_string());
            }
        }
        Ok(())
    }

    async fn devices(&self, mxid: &str) -> Result<Value, &'static str> {
        let user: OwnedUserId = mxid.parse().map_err(|_| "configuration_invalid")?;
        let devices = self
            .store
            .client
            .encryption()
            .get_user_devices(&user)
            .await
            .map_err(|_| "transport_unavailable")?;
        let mut values = Vec::new();
        for device in devices.devices() {
            if values.len() >= 64 {
                return Err("too_many_devices");
            }
            values.push(json!({
                "device_id": device.device_id().as_str(),
                "ed25519": device.ed25519_key().map(|key| key.to_base64()),
                "verified": device.is_verified_with_cross_signing(),
                "cross_signed_by_owner": device.is_cross_signed_by_owner(),
                "blacklisted": device.is_blacklisted(), "deleted": device.is_deleted(),
            }));
        }
        values.sort_by(|left, right| left["device_id"].as_str().cmp(&right["device_id"].as_str()));
        Ok(Value::Array(values))
    }

    async fn status(&mut self) -> Result<Value, &'static str> {
        self.progress().await?;
        self.refresh_identities().await?;
        let own = self
            .store
            .client
            .encryption()
            .get_own_device()
            .await
            .map_err(|_| "transport_unavailable")?;
        let verification = self.active.as_ref().map(|active| {
            let sas = active.sas.as_ref();
            let phase = if active.request.is_cancelled() || sas.is_some_and(|sas| sas.is_cancelled()) { "cancelled" }
                else if active.request.is_done() || sas.is_some_and(|sas| sas.is_done()) { "done" }
                else if active.confirmed { "waiting_for_peer_confirmation" }
                else if active.comparison_token.is_some() { "compare" }
                else { "waiting_for_peer" };
            let emojis = sas.and_then(|sas| sas.emoji()).map(|emojis| emojis.into_iter()
                .map(|emoji| json!({"symbol": emoji.symbol, "description": emoji.description})).collect::<Vec<_>>());
            let decimals = sas.and_then(|sas| sas.decimals()).map(|(a,b,c)| vec![a,b,c]);
            json!({"phase": phase, "target": match active.target { Target::Own => "self", Target::Owner => "owner" },
                "other_device_id": active.device_id, "other_user_id": active.request.other_user_id(),
                "flow_id": active.request.flow_id(), "generation": active.generation,
                "comparison_token": if phase == "compare" { active.comparison_token.as_deref() } else { None },
                "emojis": emojis, "decimals": decimals, "confirmed": active.confirmed})
        });
        Ok(json!({
            "own_bot_device_id": self.config.bot_device_id,
            "own_bot_ed25519": own.and_then(|device| device.ed25519_key()).map(|key| key.to_base64()),
            "self_identity_verified": self.identity_verified(&self.config.bot_mxid).await?,
            "owner_identity_verified": self.identity_verified(&self.config.owner_mxid).await?,
            "private_cross_signing_ready": self.private_keys_ready().await,
            "devices": {"self": self.devices(&self.config.bot_mxid).await?, "owner": self.devices(&self.config.owner_mxid).await?},
            "verification": verification,
        }))
    }

    async fn command(&mut self, command: SetupCommand) -> Result<(Value, bool), &'static str> {
        let mut finish = false;
        match command {
            SetupCommand::Status {} => (),
            SetupCommand::StartSelfVerification { device_id } => {
                self.start(Target::Own, device_id).await?
            }
            SetupCommand::StartOwnerVerification { device_id } => {
                self.start(Target::Owner, device_id).await?
            }
            SetupCommand::ConfirmSas {
                flow_id,
                comparison_token,
            } => {
                let active = self.active.as_mut().ok_or("no_active_verification")?;
                if !confirmation_allowed(active, &flow_id, &comparison_token) {
                    return Err("stale_comparison");
                }
                // Invalidate this operator action before network I/O. A retry
                // cannot blindly confirm again after an uncertain response.
                active.comparison_token = None;
                active.confirmed = true;
                active
                    .sas
                    .as_ref()
                    .ok_or("no_active_verification")?
                    .confirm()
                    .await
                    .map_err(|_| "transport_unavailable")?;
            }
            SetupCommand::CancelSas { flow_id } => {
                let active = self.active.as_mut().ok_or("no_active_verification")?;
                if active.request.flow_id() != flow_id {
                    return Err("stale_comparison");
                }
                active
                    .request
                    .cancel()
                    .await
                    .map_err(|_| "transport_unavailable")?;
                active.comparison_token = None;
            }
            SetupCommand::Finish {} => {
                if !self.private_keys_ready().await {
                    return Err("self_verification_required");
                }
                // A background SDK sync must not change checked room/device
                // caches during the final production-policy validation.
                let _sync_guard = self.sync_barrier.lock().await;
                let matrix = MatrixClient::new(
                    self.store.client.clone(),
                    self.store.http_client.clone(),
                    &self.config,
                    self.store.sync_checkpoint.clone(),
                )
                .map_err(|_| "policy_not_ready")?;
                matrix
                    .validate_setup_policy()
                    .await
                    .map_err(|_| "policy_not_ready")?;
                finish = true;
            }
            SetupCommand::Shutdown {} => return Ok((json!({"shutdown": true}), true)),
        }
        Ok((self.status().await?, finish))
    }
}

async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>, &'static str> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader.fill_buf().await.map_err(|_| "input_unavailable")?;
        if buffer.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("invalid_request")
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(buffer.len(), |position| position + 1);
        if bytes.len().saturating_add(count) > MAX_INPUT_BYTES {
            return Err("invalid_request");
        }
        bytes.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(bytes));
        }
    }
}

async fn write_json<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: Value,
) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "output_unavailable")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("output_unavailable");
    }
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| "output_unavailable")?;
    writer.flush().await.map_err(|_| "output_unavailable")
}

pub async fn run(arguments: Vec<String>) -> Result<(), &'static str> {
    let (root, fresh) = parse_options(&arguments)?;
    let config = Config::from_env(fresh, &root).map_err(|_| "configuration_invalid")?;
    let store = store::open_for_setup(&config)
        .await
        .map_err(|error| match error {
            StoreError::LockContended => "store_locked",
            StoreError::Quarantined => "store_or_device_quarantined",
            StoreError::Open => "transport_or_store_unavailable",
        })?;
    let client = store.client.clone();
    let sync_barrier = Arc::new(tokio::sync::Mutex::new(()));
    let background_sync_barrier = sync_barrier.clone();
    let sync_task = tokio::spawn(async move {
        loop {
            // No application handlers are installed and the application cursor
            // is not committed by this SDK-only synchronization.
            {
                let _sync_guard = background_sync_barrier.lock().await;
                let _ = tokio::time::timeout(
                    Duration::from_secs(15),
                    client.sync_once(SyncSettings::new().timeout(Duration::from_secs(5))),
                )
                .await;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
    let mut setup = Setup {
        store,
        config,
        active: None,
        sync_barrier,
    };
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let result = async {
        write_json(&mut output, json!({"version":1,"type":"setup_ready"})).await?;
        let mut seen = HashSet::new();
        let deadline = tokio::time::Instant::now() + SETUP_LIFETIME;
        loop {
            let bytes = tokio::time::timeout_at(deadline, read_line(&mut input))
                .await
                .map_err(|_| "setup_expired")??;
            let Some(bytes) = bytes else {
                break;
            };
            let request = parse_request(&bytes, &mut seen)?;
            let response =
                tokio::time::timeout(Duration::from_secs(45), setup.command(request.command)).await;
            let (value, done) = match response {
                Ok(Ok((status, done))) => (
                    json!({"version":1,"id":request.id,"ok":true,"status":status}),
                    done,
                ),
                Ok(Err(error)) => (
                    json!({"version":1,"id":request.id,"ok":false,"error":error}),
                    false,
                ),
                Err(_) => (
                    json!({"version":1,"id":request.id,"ok":false,"error":"operation_timed_out"}),
                    false,
                ),
            };
            write_json(&mut output, value).await?;
            if done {
                break;
            }
        }
        Ok(())
    }
    .await;
    sync_task.abort();
    let _ = sync_task.await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_strict_bounded_and_replay_protected() {
        let mut seen = HashSet::new();
        let valid = br#"{"version":1,"id":"s1","command":{"type":"status"}}"#;
        assert!(parse_request(valid, &mut seen).is_ok());
        assert!(parse_request(valid, &mut seen).is_err());
        for request in [
            r#"{"version":2,"id":"s2","command":{"type":"status"}}"#,
            r#"{"version":1,"id":"s3","command":{"type":"status","access_token":"secret"}}"#,
            r#"{"version":1,"id":"s4","command":{"type":"reset_identity"}}"#,
            r#"{"version":1,"id":"s5","command":{"type":"confirm_sas","flow_id":"a","comparison_token":"guess"}}"#,
            r#"{"version":1,"id":"s6","command":{"type":"start_self_verification","device_id":""}}"#,
            r#"{"version":1,"id":"s7","command":{"type":"status"},"untrusted":true}"#,
        ] {
            assert!(
                parse_request(request.as_bytes(), &mut seen).is_err(),
                "accepted {request}"
            );
        }
    }

    #[test]
    fn options_never_default_to_fresh_or_accept_arbitrary_roots() {
        assert!(parse_options(&[]).is_err());
        assert!(parse_options(&["--provision-fresh".into()]).is_err());
        assert!(parse_options(&["--application-root".into(), "relative".into()]).is_err());
        assert!(parse_options(&["--application-root".into(), "/app/../etc".into()]).is_err());
        assert_eq!(
            parse_options(&["--application-root".into(), "/app".into()]).unwrap(),
            (PathBuf::from("/app"), false)
        );
    }

    #[test]
    fn token_identity_must_match_configured_non_guest_device() {
        let valid = json!({"user_id":"@bot:matrix.org","device_id":"NEW","is_guest":false});
        assert!(session_matches(&valid, "@bot:matrix.org", "NEW"));
        assert!(!session_matches(&valid, "@owner:matrix.org", "NEW"));
        assert!(!session_matches(&valid, "@bot:matrix.org", "ELEMENT"));
        assert!(!session_matches(
            &json!({"user_id":"@bot:matrix.org"}),
            "@bot:matrix.org",
            "NEW"
        ));
        assert!(!session_matches(
            &json!({"user_id":"@bot:matrix.org","device_id":"NEW","is_guest":true}),
            "@bot:matrix.org",
            "NEW"
        ));
    }

    #[test]
    fn setup_needs_signing_subkeys_but_not_unused_private_master() {
        use matrix_sdk_base::crypto::CrossSigningStatus;
        for has_master in [false, true] {
            assert!(signing_subkeys_ready(&CrossSigningStatus {
                has_master,
                has_self_signing: true,
                has_user_signing: true
            }));
            assert!(!signing_subkeys_ready(&CrossSigningStatus {
                has_master,
                has_self_signing: false,
                has_user_signing: true
            }));
            assert!(!signing_subkeys_ready(&CrossSigningStatus {
                has_master,
                has_self_signing: true,
                has_user_signing: false
            }));
            assert!(!signing_subkeys_ready(&CrossSigningStatus {
                has_master,
                has_self_signing: false,
                has_user_signing: false
            }));
        }
    }

    #[test]
    fn confirmation_is_bound_to_the_displayed_flow_and_one_time_token() {
        let token = "a".repeat(32);
        assert!(comparison_matches(
            "flow-a",
            Some(&token),
            "flow-a",
            &token,
            true
        ));
        assert!(!comparison_matches(
            "flow-a",
            Some(&token),
            "flow-b",
            &token,
            true
        ));
        assert!(!comparison_matches(
            "flow-a",
            Some(&token),
            "flow-a",
            &"b".repeat(32),
            true
        ));
        assert!(!comparison_matches("flow-a", None, "flow-a", &token, true));
        // Not displayed yet, expired, confirmed, done or cancelled are all
        // rejected by the can_confirm state fence.
        assert!(!comparison_matches(
            "flow-a",
            Some(&token),
            "flow-a",
            &token,
            false
        ));
    }

    #[test]
    fn fresh_session_cannot_replace_element_device_keys() {
        let key = "public-device-key";
        let keys = json!({"device_keys":{"@bot:matrix.org":{"ELEMENT":{
            "user_id":"@bot:matrix.org","device_id":"ELEMENT","keys":{"ed25519:ELEMENT":key}
        }}},"failures":{}});
        assert!(!server_key_matches(
            &keys,
            "@bot:matrix.org",
            "ELEMENT",
            None
        ));
        assert!(server_key_matches(
            &keys,
            "@bot:matrix.org",
            "ELEMENT",
            Some(&hex::encode(Sha256::digest(key.as_bytes())))
        ));
        assert!(!server_key_matches(
            &keys,
            "@bot:matrix.org",
            "ELEMENT",
            Some(&"a".repeat(64))
        ));
        assert!(server_key_matches(
            &json!({"device_keys":{"@bot:matrix.org":{}},"failures":{}}),
            "@bot:matrix.org",
            "NEW",
            None
        ));
        assert!(!server_key_matches(
            &json!({"device_keys":{},"failures":{"matrix.org":{}}}),
            "@bot:matrix.org",
            "NEW",
            None
        ));
        assert!(!server_key_matches(
            &json!({}),
            "@bot:matrix.org",
            "NEW",
            None
        ));
        assert!(!server_key_matches(
            &json!({"device_keys":{"@bot:matrix.org":null}}),
            "@bot:matrix.org",
            "NEW",
            None
        ));
        assert!(server_key_matches(
            &json!({"device_keys":{}}),
            "@bot:matrix.org",
            "NEW",
            Some(&"a".repeat(64))
        ));
    }

    #[tokio::test]
    async fn input_reader_rejects_oversize_and_unterminated_frames() {
        let mut valid = BufReader::new(&b"{}\n"[..]);
        assert_eq!(read_line(&mut valid).await.unwrap().unwrap(), b"{}\n");
        let mut partial = BufReader::new(&b"{}"[..]);
        assert!(read_line(&mut partial).await.is_err());
        let data = vec![b'x'; MAX_INPUT_BYTES + 1];
        assert!(
            read_line(&mut BufReader::new(data.as_slice()))
                .await
                .is_err()
        );
    }
}
