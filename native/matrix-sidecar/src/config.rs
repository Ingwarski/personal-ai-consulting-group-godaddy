use std::path::{Path, PathBuf};
use std::{env, fs};

use thiserror::Error;
use url::Url;
use zeroize::Zeroizing;

use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_ID_BYTES: usize = 64;
pub const MAX_OUTSTANDING_REQUESTS: usize = 32;
pub const MAX_REPLAY_IDS: usize = 4_096;
pub const MAX_UNACKED_EVENTS: usize = 64;
pub const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
pub const MAX_FORMATTED_BYTES: usize = 128 * 1024;
pub const MAX_MEDIA_OBJECTS: usize = 4;
pub const MAX_MEDIA_OBJECT_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_MEDIA_AGGREGATE_BYTES: u64 = 64 * 1024 * 1024;
pub const MEDIA_TTL_SECONDS: u64 = 15 * 60;
pub const CONTROL_TIMEOUT_SECONDS: u64 = 5;
pub const SEND_TIMEOUT_SECONDS: u64 = 30;
pub const PRODUCTION_HOMESERVER_ORIGIN: &str = "https://matrix.org";
const PERSISTENT_NAMESPACE: &str = ".personal-consultant-matrix-v1";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("configuration is incomplete")]
    Missing,
    #[error("configured origin is not permitted")]
    Origin,
    #[error("configured path is not permitted")]
    Path,
}

pub struct Config {
    pub mysql: bool,
    pub homeserver: FixedHomeserver,
    pub store_root: PathBuf,
    pub spool_parent: PathBuf,
    pub store_passphrase: Zeroizing<String>,
    pub access_token: Zeroizing<String>,
    pub room_id: String,
    pub owner_mxid: String,
    pub bot_mxid: String,
    pub bot_device_id: String,
    pub allowed_origins: Vec<FixedHomeserver>,
    pub provision_fresh: bool,
}

impl Config {
    pub fn from_env(provision_fresh: bool, application_root: &Path) -> Result<Self, ConfigError> {
        let homeserver = production_homeserver(&required("MATRIX_HOMESERVER_URL")?)?;
        let mysql = match env::var("MATRIX_STORE_BACKEND").as_deref() {
            Ok("mysql") => true,
            Ok("sqlite") | Err(_) => false,
            _ => return Err(ConfigError::Missing),
        };
        // MySQL startup cannot implicitly create a replacement crypto identity.
        if mysql && provision_fresh {
            return Err(ConfigError::Missing);
        }
        let (store_root, spool_parent) = if mysql {
            // Node creates this private per-boot directory and needs the same
            // path to consume validated media. No durable crypto files live here.
            let root = PathBuf::from(required("MATRIX_MEDIA_SPOOL_DIR")?);
            let temp = fs::canonicalize(env::temp_dir()).map_err(|_| ConfigError::Path)?;
            let resolved = fs::canonicalize(&root).map_err(|_| ConfigError::Path)?;
            if !root.is_absolute()
                || resolved.parent() != Some(temp.as_path())
                || !resolved
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with("pc-matrix-"))
            {
                return Err(ConfigError::Path);
            }
            crate::lock::ensure_private_directory(&root).map_err(|_| ConfigError::Path)?;
            (root.clone(), root)
        } else {
            matrix_private_paths(
                &required("MATRIX_STORE_DIR")?,
                &required("MATRIX_MEDIA_SPOOL_DIR")?,
                application_root,
            )?
        };
        let store_passphrase = Zeroizing::new(required("MATRIX_STORE_PASSPHRASE")?);
        if !valid_secret_key(&store_passphrase) {
            return Err(ConfigError::Missing);
        }
        let access_token = Zeroizing::new(required("MATRIX_ACCESS_TOKEN")?);
        let room_id = required("MATRIX_ROOM_ID")?;
        let owner_mxid = required("MATRIX_OWNER_MXID")?;
        let bot_mxid = required("MATRIX_BOT_MXID")?;
        let bot_device_id = required("MATRIX_BOT_DEVICE_ID")?;
        validate_matrix_identity(
            &room_id,
            &owner_mxid,
            &bot_mxid,
            &bot_device_id,
            access_token.as_str(),
        )?;
        let allowed_origins =
            parse_allowed_origins(&required("MATRIX_ALLOWED_HTTPS_ORIGINS")?, &homeserver)?;
        Ok(Self {
            mysql,
            homeserver,
            store_root,
            spool_parent,
            store_passphrase,
            access_token,
            room_id,
            owner_mxid,
            bot_mxid,
            bot_device_id,
            allowed_origins,
            provision_fresh,
        })
    }
}

fn validate_matrix_identity(
    room_id: &str,
    owner_mxid: &str,
    bot_mxid: &str,
    bot_device_id: &str,
    access_token: &str,
) -> Result<(), ConfigError> {
    let room: OwnedRoomId = room_id.parse().map_err(|_| ConfigError::Missing)?;
    let owner: OwnedUserId = owner_mxid.parse().map_err(|_| ConfigError::Missing)?;
    let bot: OwnedUserId = bot_mxid.parse().map_err(|_| ConfigError::Missing)?;
    if room
        .server_name()
        .is_none_or(|server| server.as_str() != "matrix.org")
        || owner.server_name().as_str() != "matrix.org"
        || bot.server_name().as_str() != "matrix.org"
        || owner == bot
        || bot_device_id.is_empty()
        || bot_device_id.len() > 255
        || !bot_device_id
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte))
        || access_token.is_empty()
        || access_token.len() > 4096
        || access_token.as_bytes().contains(&0)
    {
        return Err(ConfigError::Missing);
    }
    Ok(())
}

pub fn valid_secret_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn production_homeserver(value: &str) -> Result<FixedHomeserver, ConfigError> {
    let homeserver = FixedHomeserver::parse(value)?;
    if homeserver.origin() != PRODUCTION_HOMESERVER_ORIGIN {
        return Err(ConfigError::Origin);
    }
    Ok(homeserver)
}

fn parse_allowed_origins(
    value: &str,
    homeserver: &FixedHomeserver,
) -> Result<Vec<FixedHomeserver>, ConfigError> {
    let origins = value
        .split(',')
        .map(str::trim)
        .map(FixedHomeserver::parse)
        .collect::<Result<Vec<_>, _>>()?;
    if origins.len() != 1 || origins.first() != Some(homeserver) {
        return Err(ConfigError::Origin);
    }
    Ok(origins)
}

fn required(name: &str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or(ConfigError::Missing)
}

fn matrix_private_paths(
    store_value: &str,
    spool_value: &str,
    application_root: &Path,
) -> Result<(PathBuf, PathBuf), ConfigError> {
    if !application_root.is_absolute()
        || application_root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(ConfigError::Path);
    }
    let namespace = application_root
        .join("public/assets")
        .join(PERSISTENT_NAMESPACE);
    let expected_store = namespace.join("crypto-store");
    let expected_spool = namespace.join("media-spool");
    let store = exact_absolute_path(store_value, &expected_store)?;
    let spool = exact_absolute_path(spool_value, &expected_spool)?;

    let application_root = fs::canonicalize(application_root).map_err(|_| ConfigError::Path)?;
    if !application_root.is_dir() {
        return Err(ConfigError::Path);
    }
    let assets = application_root.join("public/assets");
    let resolved_assets = fs::canonicalize(&assets).map_err(|_| ConfigError::Path)?;
    if !resolved_assets.is_dir() || !resolved_assets.starts_with(&application_root) {
        return Err(ConfigError::Path);
    }
    let resolved_namespace = resolved_destination(&assets.join(PERSISTENT_NAMESPACE))?;
    if !resolved_namespace.starts_with(&resolved_assets) {
        return Err(ConfigError::Path);
    }
    let resolved_store = resolved_destination(&store)?;
    let resolved_spool = resolved_destination(&spool)?;
    if resolved_store != resolved_namespace.join("crypto-store")
        || resolved_spool != resolved_namespace.join("media-spool")
    {
        return Err(ConfigError::Path);
    }
    reject_overlapping_private_paths(&resolved_store, &resolved_spool)?;
    Ok((store, spool))
}

fn exact_absolute_path(value: &str, expected: &Path) -> Result<PathBuf, ConfigError> {
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || path != expected
    {
        return Err(ConfigError::Path);
    }
    Ok(path.to_path_buf())
}

fn reject_overlapping_private_paths(store: &Path, spool: &Path) -> Result<(), ConfigError> {
    let store = resolved_destination(store)?;
    let spool = resolved_destination(spool)?;
    if store.starts_with(&spool) || spool.starts_with(&store) {
        return Err(ConfigError::Path);
    }
    Ok(())
}

fn resolved_destination(path: &Path) -> Result<PathBuf, ConfigError> {
    let mut existing = path;
    let mut missing = Vec::new();
    while !existing.exists() {
        missing.push(
            existing
                .file_name()
                .ok_or(ConfigError::Path)?
                .to_os_string(),
        );
        existing = existing.parent().ok_or(ConfigError::Path)?;
    }
    let mut resolved = fs::canonicalize(existing).map_err(|_| ConfigError::Path)?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FixedHomeserver(Url);

impl FixedHomeserver {
    pub fn parse(value: &str) -> Result<Self, ConfigError> {
        let parsed = Url::parse(value).map_err(|_| ConfigError::Origin)?;
        let clean_path = parsed.path().is_empty() || parsed.path() == "/";
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !clean_path
        {
            return Err(ConfigError::Origin);
        }
        Ok(Self(parsed))
    }

    pub fn as_url(&self) -> &Url {
        &self.0
    }

    pub fn permits(&self, candidate: &Url) -> bool {
        candidate.scheme() == "https"
            && candidate.host_str() == self.0.host_str()
            && candidate.port_or_known_default() == self.0.port_or_known_default()
            && candidate.username().is_empty()
            && candidate.password().is_none()
    }

    pub fn origin(&self) -> String {
        self.0.origin().ascii_serialization()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_origin_rejects_redirect_style_or_ambiguous_urls() {
        for url in [
            "http://matrix.example",
            "https://user@matrix.example",
            "https://matrix.example/path",
            "https://matrix.example/?next=elsewhere",
        ] {
            assert!(FixedHomeserver::parse(url).is_err(), "{url}");
        }
        let fixed = FixedHomeserver::parse("https://matrix.example").unwrap();
        assert!(
            fixed.permits(&Url::parse("https://matrix.example/_matrix/client/v3/sync").unwrap())
        );
        assert!(
            !fixed
                .permits(&Url::parse("https://elsewhere.example/_matrix/client/v3/sync").unwrap())
        );
        assert!(parse_allowed_origins("https://matrix.example", &fixed).is_ok());
        assert!(
            parse_allowed_origins("https://matrix.example,https://media.example", &fixed).is_err()
        );
    }

    #[test]
    fn production_configuration_hard_requires_matrix_dot_org() {
        assert!(production_homeserver("https://matrix.org").is_ok());
        assert!(production_homeserver("https://matrix.org/").is_ok());
        assert!(production_homeserver("https://matrix.example").is_err());
        assert!(production_homeserver("https://attacker.example").is_err());
    }

    #[test]
    fn store_secret_requires_a_canonical_32_byte_key() {
        assert!(valid_secret_key(&"a".repeat(64)));
        assert!(!valid_secret_key(&"a".repeat(63)));
        assert!(!valid_secret_key(&"A".repeat(64)));
        assert!(!valid_secret_key(&"x".repeat(64)));
    }

    #[test]
    fn persistent_paths_require_the_exact_provider_namespace() {
        let temp = tempfile::tempdir().unwrap();
        let application = temp.path().join("app");
        fs::create_dir_all(application.join("public/assets")).unwrap();
        let namespace = application.join("public/assets").join(PERSISTENT_NAMESPACE);
        let store = namespace.join("crypto-store");
        let spool = namespace.join("media-spool");
        let found = matrix_private_paths(
            store.to_str().unwrap(),
            spool.to_str().unwrap(),
            &application,
        )
        .unwrap();
        assert_eq!(found, (store.clone(), spool.clone()));
        assert!(
            matrix_private_paths(
                namespace.join("wrong-store").to_str().unwrap(),
                spool.to_str().unwrap(),
                &application,
            )
            .is_err()
        );
        #[cfg(unix)]
        {
            let outside = temp.path().join("outside");
            fs::create_dir(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, &namespace).unwrap();
            assert!(
                matrix_private_paths(
                    store.to_str().unwrap(),
                    spool.to_str().unwrap(),
                    &application,
                )
                .is_err()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn public_assets_must_not_escape_the_application_root() {
        let temp = tempfile::tempdir().unwrap();
        let application = temp.path().join("app");
        let outside_assets = temp.path().join("outside-assets");
        fs::create_dir_all(application.join("public")).unwrap();
        fs::create_dir(&outside_assets).unwrap();
        std::os::unix::fs::symlink(&outside_assets, application.join("public/assets")).unwrap();
        let namespace = application.join("public/assets").join(PERSISTENT_NAMESPACE);

        assert!(
            matrix_private_paths(
                namespace.join("crypto-store").to_str().unwrap(),
                namespace.join("media-spool").to_str().unwrap(),
                &application,
            )
            .is_err()
        );
    }

    #[test]
    fn store_and_spool_paths_must_not_overlap_even_through_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let store = temp.path().join("state");
        let spool = temp.path().join("spool");
        fs::create_dir(&store).unwrap();
        fs::create_dir(&spool).unwrap();
        assert!(reject_overlapping_private_paths(&store, &spool).is_ok());
        assert!(reject_overlapping_private_paths(&store, &store).is_err());
        assert!(reject_overlapping_private_paths(&store, &store.join("media")).is_err());
        assert!(reject_overlapping_private_paths(&spool.join("store"), &spool).is_err());
        #[cfg(unix)]
        {
            let alias = temp.path().join("state-alias");
            std::os::unix::fs::symlink(&store, &alias).unwrap();
            assert!(reject_overlapping_private_paths(&store, &alias.join("media")).is_err());
        }
    }

    #[test]
    fn matrix_identity_contract_is_exact_and_bounded() {
        assert!(
            validate_matrix_identity(
                "!room:matrix.org",
                "@owner:matrix.org",
                "@bot:matrix.org",
                "DEVICE-1",
                "token",
            )
            .is_ok()
        );
        for candidate in [
            (
                "!room:elsewhere.example",
                "@owner:matrix.org",
                "@bot:matrix.org",
                "D",
                "t",
            ),
            (
                "!room:matrix.org",
                "@owner:elsewhere.example",
                "@bot:matrix.org",
                "D",
                "t",
            ),
            (
                "!room:matrix.org",
                "@owner:matrix.org",
                "@bot:elsewhere.example",
                "D",
                "t",
            ),
            (
                "!room:matrix.org",
                "@bot:matrix.org",
                "@bot:matrix.org",
                "D",
                "t",
            ),
            (
                "!room:matrix.org",
                "@owner:matrix.org",
                "@bot:matrix.org",
                "bad id",
                "t",
            ),
            (
                "!room:matrix.org",
                "@owner:matrix.org",
                "@bot:matrix.org",
                "D",
                "",
            ),
        ] {
            assert!(
                validate_matrix_identity(
                    candidate.0,
                    candidate.1,
                    candidate.2,
                    candidate.3,
                    candidate.4
                )
                .is_err()
            );
        }
        assert!(
            validate_matrix_identity(
                "!room:matrix.org",
                "@owner:matrix.org",
                "@bot:matrix.org",
                &"D".repeat(256),
                "t",
            )
            .is_err()
        );
        assert!(
            validate_matrix_identity(
                "!room:matrix.org",
                "@owner:matrix.org",
                "@bot:matrix.org",
                "D",
                &"t".repeat(4097),
            )
            .is_err()
        );
    }
}
