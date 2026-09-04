use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use fs2::FileExt;
use matrix_sdk::{
    Client,
    ruma::api::{MatrixVersion, client::discovery::get_supported_versions},
};
use serde::{Deserialize, Serialize};

const PROBE_SCHEMA_VERSION: u8 = 1;
const MATRIX_SDK_VERSION: &str = "0.18.0";
const STORE_PASSPHRASE: &str = "godaddy-rust-matrix-probe-v1-public-synthetic-passphrase";
const WRONG_STORE_PASSPHRASE: &str = "godaddy-rust-matrix-probe-v1-wrong-public-synthetic-passphrase";
const MARKER_FILE: &str = "probe-receipt.json";
const LOCK_FILE: &str = ".probe.lock";

#[derive(Debug)]
struct Arguments {
    command: String,
    root: PathBuf,
    boot_id: String,
    deployment_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct Receipt {
    schema_version: u8,
    created_boot_id: String,
    created_deployment_id: String,
}

#[derive(Debug, Serialize)]
struct ProbeResult {
    ok: bool,
    schema_version: u8,
    matrix_sdk_version: &'static str,
    store_created: bool,
    store_reopened: bool,
    wrong_key_rejected: bool,
    matrix_https: bool,
    survived_restart: bool,
    survived_redeploy: bool,
}

#[derive(Debug, Serialize)]
struct FailureResult {
    ok: bool,
    code: &'static str,
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn parse_arguments() -> Result<Arguments, &'static str> {
    let mut values = env::args().skip(1);
    let command = values.next().ok_or("invalid_arguments")?;
    if !matches!(command.as_str(), "start" | "status" | "hold-lock" | "self-check") {
        return Err("invalid_arguments");
    }

    if command == "self-check" {
        return Ok(Arguments {
            command,
            root: PathBuf::new(),
            boot_id: "self-check".to_owned(),
            deployment_id: "self-check".to_owned(),
        });
    }

    let root_flag = values.next().ok_or("invalid_arguments")?;
    let root = values.next().ok_or("invalid_arguments")?;
    let boot_flag = values.next().ok_or("invalid_arguments")?;
    let boot_id = values.next().ok_or("invalid_arguments")?;
    let deployment_flag = values.next().ok_or("invalid_arguments")?;
    let deployment_id = values.next().ok_or("invalid_arguments")?;
    if root_flag != "--root"
        || boot_flag != "--boot-id"
        || deployment_flag != "--deployment-id"
        || values.next().is_some()
        || !valid_identifier(&boot_id)
        || !valid_identifier(&deployment_id)
    {
        return Err("invalid_arguments");
    }

    let root = PathBuf::from(root);
    if !root.is_absolute() || root.components().count() < 4 {
        return Err("invalid_arguments");
    }

    Ok(Arguments { command, root, boot_id, deployment_id })
}

fn print_json<T: Serialize>(value: &T) {
    let encoded = serde_json::to_string(value).unwrap_or_else(|_| "{\"ok\":false,\"code\":\"serialization_failed\"}".to_owned());
    let _ = writeln!(io::stdout(), "{encoded}");
}

fn lock_store(root: &Path) -> Result<File, &'static str> {
    fs::create_dir_all(root).map_err(|_| "store_unavailable")?;
    let _ = fs::set_permissions(root, fs::Permissions::from_mode(0o700));
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(root.join(LOCK_FILE))
        .map_err(|_| "store_unavailable")?;
    lock.try_lock_exclusive().map_err(|_| "store_locked")?;
    Ok(lock)
}

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(not(unix))]
trait PermissionsMode {
    fn from_mode(_: u32) -> fs::Permissions;
}

#[cfg(not(unix))]
impl PermissionsMode for fs::Permissions {
    fn from_mode(_: u32) -> fs::Permissions {
        fs::metadata(".").expect("metadata").permissions()
    }
}

async fn build_client(root: &Path, passphrase: &str) -> Result<Client, ()> {
    Client::builder()
        .homeserver_url("https://matrix.org")
        .server_versions([MatrixVersion::V1_0])
        .sqlite_store(root, Some(passphrase))
        .build()
        .await
        .map_err(|_| ())
}

async fn check_matrix_https(client: &Client) -> bool {
    client
        .send(get_supported_versions::Request::new())
        .await
        .map(|response| !response.versions.is_empty())
        .unwrap_or(false)
}

fn receipt_path(root: &Path) -> PathBuf {
    root.join(MARKER_FILE)
}

fn load_receipt(root: &Path) -> Result<Option<Receipt>, &'static str> {
    match fs::read(receipt_path(root)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| "invalid_receipt"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("store_unavailable"),
    }
}

fn write_receipt(root: &Path, boot_id: &str, deployment_id: &str) -> Result<Receipt, &'static str> {
    let receipt = Receipt {
        schema_version: PROBE_SCHEMA_VERSION,
        created_boot_id: boot_id.to_owned(),
        created_deployment_id: deployment_id.to_owned(),
    };
    let bytes = serde_json::to_vec(&receipt).map_err(|_| "serialization_failed")?;
    fs::write(receipt_path(root), bytes).map_err(|_| "store_unavailable")?;
    let _ = fs::set_permissions(receipt_path(root), fs::Permissions::from_mode(0o600));
    Ok(receipt)
}

async fn execute_probe(arguments: &Arguments) -> Result<ProbeResult, &'static str> {
    let _lock = lock_store(&arguments.root)?;
    let existing = load_receipt(&arguments.root)?;
    if arguments.command == "status" && existing.is_none() {
        return Err("store_missing");
    }

    let created = existing.is_none();
    let client = build_client(&arguments.root, STORE_PASSPHRASE)
        .await
        .map_err(|_| "encrypted_store_unavailable")?;
    drop(client);

    let reopened = build_client(&arguments.root, STORE_PASSPHRASE)
        .await
        .map_err(|_| "encrypted_store_reopen_failed")?;
    let matrix_https = check_matrix_https(&reopened).await;
    drop(reopened);

    let wrong_key_rejected = build_client(&arguments.root, WRONG_STORE_PASSPHRASE).await.is_err();
    if !wrong_key_rejected {
        return Err("wrong_key_accepted");
    }

    let receipt = match existing {
        Some(receipt) => receipt,
        None => write_receipt(&arguments.root, &arguments.boot_id, &arguments.deployment_id)?,
    };
    if receipt.schema_version != PROBE_SCHEMA_VERSION
        || !valid_identifier(&receipt.created_boot_id)
        || !valid_identifier(&receipt.created_deployment_id)
    {
        return Err("invalid_receipt");
    }

    Ok(ProbeResult {
        ok: matrix_https,
        schema_version: PROBE_SCHEMA_VERSION,
        matrix_sdk_version: MATRIX_SDK_VERSION,
        store_created: created,
        store_reopened: true,
        wrong_key_rejected,
        matrix_https,
        survived_restart: !created && receipt.created_boot_id != arguments.boot_id,
        survived_redeploy: !created && receipt.created_deployment_id != arguments.deployment_id,
    })
}

#[tokio::main]
async fn main() {
    let arguments = match parse_arguments() {
        Ok(arguments) => arguments,
        Err(code) => {
            print_json(&FailureResult { ok: false, code });
            std::process::exit(2);
        }
    };

    if arguments.command == "self-check" {
        print_json(&ProbeResult {
            ok: true,
            schema_version: PROBE_SCHEMA_VERSION,
            matrix_sdk_version: MATRIX_SDK_VERSION,
            store_created: false,
            store_reopened: false,
            wrong_key_rejected: false,
            matrix_https: false,
            survived_restart: false,
            survived_redeploy: false,
        });
        return;
    }

    if arguments.command == "hold-lock" {
        match lock_store(&arguments.root) {
            Ok(_lock) => {
                print_json(&serde_json::json!({ "ok": true, "ready": true }));
                thread::sleep(Duration::from_secs(30));
                return;
            }
            Err(code) => {
                print_json(&FailureResult { ok: false, code });
                std::process::exit(3);
            }
        }
    }

    match execute_probe(&arguments).await {
        Ok(result) => {
            let success = result.ok;
            print_json(&result);
            if !success {
                std::process::exit(4);
            }
        }
        Err(code) => {
            print_json(&FailureResult { ok: false, code });
            std::process::exit(5);
        }
    }
}
