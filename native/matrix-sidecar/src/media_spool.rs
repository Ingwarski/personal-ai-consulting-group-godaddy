use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::config::{MAX_MEDIA_AGGREGATE_BYTES, MAX_MEDIA_OBJECT_BYTES, MAX_MEDIA_OBJECTS};
use crate::lock::ensure_private_directory;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaReference {
    pub handle: String,
    pub declared_mime: String,
    pub length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct InspectedMedia {
    pub handle: String,
    pub kind: MediaKind,
    pub length: u64,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Jpeg,
    Png,
    Pdf,
    Ogg,
}

impl MediaKind {
    fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Pdf => "application/pdf",
            Self::Ogg => "audio/ogg",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Pdf => "pdf",
            Self::Ogg => "ogg",
        }
    }
}

#[derive(Debug, Error)]
#[error("media object is not permitted")]
pub struct MediaError;

#[derive(Debug)]
pub(crate) enum MediaWriteError {
    InvalidMedia,
    Unavailable,
}

#[derive(Clone, Debug)]
pub struct PrivateSpool {
    parent: PathBuf,
    root: PathBuf,
    instance: String,
    replay_instances: Arc<RwLock<HashSet<String>>>,
}

pub struct StagingFile {
    pub path: PathBuf,
    pub file: fs::File,
}

impl PrivateSpool {
    pub fn open_read_only(parent: &Path) -> Result<Self, MediaError> {
        let meta = fs::symlink_metadata(parent).map_err(|_| MediaError)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(MediaError);
        }
        ensure_private_directory(parent).map_err(|_| MediaError)?;
        Ok(Self {
            parent: parent.to_owned(),
            root: parent.to_owned(),
            instance: "migration-read-only".into(),
            replay_instances: Arc::new(RwLock::new(HashSet::new())),
        })
    }
    pub fn create(parent: &Path) -> Result<Self, MediaError> {
        if !parent.exists() {
            return Err(MediaError);
        }
        ensure_private_directory(parent).map_err(|_| MediaError)?;
        let instance = Uuid::new_v4().simple().to_string();
        let root = parent.join(format!("boot-{instance}"));
        fs::create_dir(&root).map_err(|_| MediaError)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| MediaError)?;
        }
        ensure_private_directory(&root).map_err(|_| MediaError)?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| MediaError)?;
        Ok(Self {
            parent: parent.to_path_buf(),
            root,
            instance,
            replay_instances: Arc::new(RwLock::new(HashSet::new())),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    /// Read only an already validated private handle for encrypted SQL staging.
    pub fn read_verified(&self, reference: &MediaReference) -> Result<Vec<u8>, MediaError> {
        self.inspect(reference)?;
        let bytes = crate::lock::read_private_file(
            &self.resolve(&reference.handle)?,
            MAX_MEDIA_OBJECT_BYTES,
        )
        .map_err(|_| MediaError)?;
        if bytes.len() as u64 != reference.length
            || hex::encode(Sha256::digest(&bytes)) != reference.sha256
        {
            return Err(MediaError);
        }
        Ok(bytes)
    }

    /// Recreate a committed opaque handle in a NEW private ephemeral root. The
    /// reference's hash/length/type are verified before any file is created.
    pub fn restore_verified(
        &self,
        reference: &MediaReference,
        bytes: &[u8],
    ) -> Result<(), MediaError> {
        let (instance, _) = parse_handle(&reference.handle).ok_or(MediaError)?;
        let kind = detect_kind(bytes).ok_or(MediaError)?;
        if bytes.len() as u64 != reference.length
            || reference.length > MAX_MEDIA_OBJECT_BYTES
            || hex::encode(Sha256::digest(bytes)) != reference.sha256
            || kind.mime() != reference.declared_mime
            || Path::new(&reference.handle)
                .extension()
                .and_then(|s| s.to_str())
                != Some(kind.extension())
        {
            return Err(MediaError);
        }
        ensure_private_directory(&self.parent).map_err(|_| MediaError)?;
        let directory = self.parent.join(format!("boot-{instance}"));
        if !directory.exists() {
            fs::create_dir(&directory).map_err(|_| MediaError)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                    .map_err(|_| MediaError)?;
            }
        }
        ensure_private_directory(&directory).map_err(|_| MediaError)?;
        let target = directory.join(&reference.handle);
        if !target.exists() {
            crate::lock::atomic_create_private(&target, bytes).map_err(|_| MediaError)?;
        }
        self.authorize_replay(std::slice::from_ref(reference))?;
        self.inspect(reference)?;
        Ok(())
    }

    pub fn write(&self, kind: MediaKind, bytes: &[u8]) -> Result<MediaReference, MediaError> {
        self.write_reader(kind, &mut std::io::Cursor::new(bytes))
    }

    pub fn write_reader(
        &self,
        kind: MediaKind,
        reader: &mut impl Read,
    ) -> Result<MediaReference, MediaError> {
        self.write_reader_classified(kind, reader)
            .map_err(|_| MediaError)
    }

    pub(crate) fn write_reader_classified(
        &self,
        kind: MediaKind,
        reader: &mut impl Read,
    ) -> Result<MediaReference, MediaWriteError> {
        let token = Uuid::new_v4().simple().to_string()[..24].to_owned();
        let handle = format!("{}-{token}.{}", self.instance, kind.extension());
        let path = self.root.join(&handle);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| MediaWriteError::Unavailable)?;
        let result = (|| {
            let mut total = 0_u64;
            let mut prefix = Vec::with_capacity(8);
            let mut digest = Sha256::new();
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                let count = reader
                    .read(&mut buffer)
                    .map_err(|_| MediaWriteError::Unavailable)?;
                if count == 0 {
                    break;
                }
                total = total
                    .checked_add(count as u64)
                    .ok_or(MediaWriteError::InvalidMedia)?;
                if total > MAX_MEDIA_OBJECT_BYTES {
                    return Err(MediaWriteError::InvalidMedia);
                }
                if prefix.len() < 8 {
                    let remaining = 8 - prefix.len();
                    prefix.extend_from_slice(&buffer[..count.min(remaining)]);
                }
                digest.update(&buffer[..count]);
                file.write_all(&buffer[..count])
                    .map_err(|_| MediaWriteError::Unavailable)?;
            }
            if detect_kind(&prefix) != Some(kind) {
                return Err(MediaWriteError::InvalidMedia);
            }
            file.sync_all().map_err(|_| MediaWriteError::Unavailable)?;
            fs::File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| MediaWriteError::Unavailable)?;
            crate::lock::verify_private_path(&path).map_err(|_| MediaWriteError::Unavailable)?;
            Ok(MediaReference {
                handle,
                declared_mime: kind.mime().into(),
                length: total,
                sha256: hex::encode(digest.finalize()),
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&path);
        }
        result
    }

    pub fn create_staging_file(&self) -> Result<StagingFile, MediaError> {
        let token = Uuid::new_v4().simple().to_string()[..24].to_owned();
        let path = self.root.join(format!("{}-{token}.stage", self.instance));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|_| MediaError)?;
        crate::lock::verify_private_path(&path).map_err(|_| MediaError)?;
        Ok(StagingFile { path, file })
    }

    pub fn remove_staging_file(&self, path: &Path) -> Result<(), MediaError> {
        if path.parent() != Some(self.root.as_path())
            || !path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| valid_stage(value, &self.instance))
        {
            return Err(MediaError);
        }
        crate::lock::verify_private_path(path).map_err(|_| MediaError)?;
        fs::remove_file(path).map_err(|_| MediaError)
    }

    pub fn authorize_replay(&self, references: &[MediaReference]) -> Result<(), MediaError> {
        let mut instances = self.replay_instances.write().map_err(|_| MediaError)?;
        for reference in references {
            let instance = parse_handle(&reference.handle).ok_or(MediaError)?.0;
            if instance == self.instance {
                continue;
            }
            let directory = self.parent.join(format!("boot-{instance}"));
            if !directory.is_dir() {
                return Err(MediaError);
            }
            ensure_private_directory(&directory).map_err(|_| MediaError)?;
            instances.insert(instance.to_owned());
        }
        Ok(())
    }

    pub fn inspect_batch(
        &self,
        references: &[MediaReference],
    ) -> Result<Vec<InspectedMedia>, MediaError> {
        if references.len() > MAX_MEDIA_OBJECTS {
            return Err(MediaError);
        }
        let mut total = 0_u64;
        let mut inspected = Vec::with_capacity(references.len());
        for reference in references {
            let item = self.inspect(reference)?;
            total = total.checked_add(item.length).ok_or(MediaError)?;
            if total > MAX_MEDIA_AGGREGATE_BYTES {
                return Err(MediaError);
            }
            inspected.push(item);
        }
        Ok(inspected)
    }

    pub fn inspect(&self, reference: &MediaReference) -> Result<InspectedMedia, MediaError> {
        if parse_handle(&reference.handle).is_none()
            || reference.length > MAX_MEDIA_OBJECT_BYTES
            || reference.sha256.len() != 64
        {
            return Err(MediaError);
        }
        let path = self.resolve(&reference.handle)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| MediaError)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != reference.length
        {
            return Err(MediaError);
        }
        crate::lock::verify_private_path(&path).map_err(|_| MediaError)?;
        let canonical = path.canonicalize().map_err(|_| MediaError)?;
        let canonical_root = path
            .parent()
            .ok_or(MediaError)?
            .canonicalize()
            .map_err(|_| MediaError)?;
        if canonical.parent() != Some(canonical_root.as_path()) {
            return Err(MediaError);
        }
        let bytes = crate::lock::read_private_file(&canonical, MAX_MEDIA_OBJECT_BYTES)
            .map_err(|_| MediaError)?;
        if bytes.len() as u64 != reference.length {
            return Err(MediaError);
        }
        let kind = detect_kind(&bytes).ok_or(MediaError)?;
        let expected_extension = Path::new(&reference.handle)
            .extension()
            .and_then(|value| value.to_str());
        let digest = hex::encode(Sha256::digest(&bytes));
        if reference.declared_mime != kind.mime()
            || expected_extension != Some(kind.extension())
            || digest != reference.sha256
        {
            return Err(MediaError);
        }
        Ok(InspectedMedia {
            handle: reference.handle.clone(),
            kind,
            length: reference.length,
            sha256: digest,
        })
    }

    pub fn acknowledge(&self, handle: &str) -> Result<(), MediaError> {
        let path = self.resolve(handle)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| MediaError)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(MediaError);
        }
        crate::lock::verify_private_path(&path).map_err(|_| MediaError)?;
        fs::remove_file(path).map_err(|_| MediaError)
    }

    pub fn cleanup_expired(
        &self,
        ttl: Duration,
        protected_handles: &HashSet<String>,
    ) -> Result<usize, MediaError> {
        let now = SystemTime::now();
        let mut removed = 0;
        for directory in fs::read_dir(&self.parent).map_err(|_| MediaError)? {
            let directory = directory.map_err(|_| MediaError)?;
            let directory_path = directory.path();
            let directory_metadata =
                fs::symlink_metadata(&directory_path).map_err(|_| MediaError)?;
            let directory_name = directory.file_name();
            let Some(instance) = directory_name
                .to_str()
                .and_then(|name| name.strip_prefix("boot-"))
                .filter(|value| valid_instance(value))
            else {
                continue;
            };
            if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
                return Err(MediaError);
            }
            ensure_private_directory(&directory_path).map_err(|_| MediaError)?;
            for entry in fs::read_dir(&directory_path).map_err(|_| MediaError)? {
                let entry = entry.map_err(|_| MediaError)?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|_| MediaError)?;
                let name = entry.file_name();
                let handle = name.to_str().ok_or(MediaError)?;
                if !protected_handles.contains(handle)
                    && metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && (valid_handle(handle, instance) || valid_stage(handle, instance))
                    && now
                        .duration_since(metadata.modified().map_err(|_| MediaError)?)
                        .is_ok_and(|age| age >= ttl)
                {
                    fs::remove_file(path).map_err(|_| MediaError)?;
                    removed += 1;
                }
            }
            if instance != self.instance
                && fs::read_dir(&directory_path)
                    .map_err(|_| MediaError)?
                    .next()
                    .is_none()
            {
                fs::remove_dir(&directory_path).map_err(|_| MediaError)?;
            }
        }
        Ok(removed)
    }

    fn resolve(&self, handle: &str) -> Result<PathBuf, MediaError> {
        let (instance, _) = parse_handle(handle).ok_or(MediaError)?;
        let replay_allowed = self
            .replay_instances
            .read()
            .map_err(|_| MediaError)?
            .contains(instance);
        if instance != self.instance && !replay_allowed {
            return Err(MediaError);
        }
        let directory = self.parent.join(format!("boot-{instance}"));
        ensure_private_directory(&directory).map_err(|_| MediaError)?;
        Ok(directory.join(handle))
    }
}

fn valid_handle(value: &str, instance: &str) -> bool {
    parse_handle(value).is_some_and(|(found, _)| found == instance)
}

fn valid_stage(value: &str, instance: &str) -> bool {
    let Some((stem, extension)) = value.split_once('.') else {
        return false;
    };
    let Some(token) = stem
        .strip_prefix(instance)
        .and_then(|tail| tail.strip_prefix('-'))
    else {
        return false;
    };
    extension == "stage" && token.len() == 24 && token.bytes().all(is_lower_hex)
}

fn parse_handle(value: &str) -> Option<(&str, &str)> {
    if value.len() > 80
        || !value.is_ascii()
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
    {
        return None;
    }
    let (stem, extension) = value.split_once('.')?;
    let (instance, token) = stem.split_once('-')?;
    (valid_instance(instance)
        && token.len() == 24
        && token.bytes().all(is_lower_hex)
        && matches!(extension, "jpg" | "png" | "pdf" | "ogg"))
    .then_some((instance, extension))
}

fn valid_instance(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(is_lower_hex)
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn detect_kind(bytes: &[u8]) -> Option<MediaKind> {
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some(MediaKind::Jpeg)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(MediaKind::Png)
    } else if bytes.starts_with(b"%PDF-") {
        Some(MediaKind::Pdf)
    } else if bytes.starts_with(b"OggS") {
        Some(MediaKind::Ogg)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_magic_is_permanent_but_storage_read_failures_are_retryable() {
        let temp = tempfile::tempdir().unwrap();
        let spool = create_spool(&temp);
        assert!(matches!(
            spool.write_reader_classified(MediaKind::Png, &mut std::io::Cursor::new(b"not png")),
            Err(MediaWriteError::InvalidMedia)
        ));
        struct BrokenReader;
        impl Read for BrokenReader {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("fixture storage failure"))
            }
        }
        assert!(matches!(
            spool.write_reader_classified(MediaKind::Png, &mut BrokenReader),
            Err(MediaWriteError::Unavailable)
        ));
        assert_eq!(fs::read_dir(spool.root()).unwrap().count(), 0);
    }

    #[test]
    fn verified_ogg_voice_note_keeps_its_opaque_private_handle() {
        let temp = tempfile::tempdir().unwrap();
        let spool = create_spool(&temp);
        let reference = spool.write(MediaKind::Ogg, b"OggS\0\x02voice").unwrap();
        assert!(reference.handle.ends_with(".ogg"));
        assert_eq!(reference.declared_mime, "audio/ogg");
        assert_eq!(spool.inspect(&reference).unwrap().kind, MediaKind::Ogg);
    }

    fn create_spool(temp: &tempfile::TempDir) -> PrivateSpool {
        let parent = temp.path().join("spool");
        fs::create_dir(&parent).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        }
        PrivateSpool::create(&parent).unwrap()
    }

    #[test]
    fn spool_has_private_permissions_and_validates_magic_mime_hash_and_handle() {
        let temp = tempfile::tempdir().unwrap();
        let spool = create_spool(&temp);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(spool.root()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let reference = spool.write(MediaKind::Pdf, b"%PDF-1.7\n%%EOF").unwrap();
        assert_eq!(spool.instance().len(), 32);
        assert!(spool.instance().bytes().all(is_lower_hex));
        assert!(reference.handle.starts_with(spool.instance()));
        assert!(reference.handle.len() <= 64);
        assert_eq!(spool.inspect(&reference).unwrap().kind, MediaKind::Pdf);
        let mut wrong = reference.clone();
        wrong.declared_mime = "image/png".into();
        assert!(spool.inspect(&wrong).is_err());
        let mut escaping = reference;
        escaping.handle = "../secret.pdf".into();
        assert!(spool.inspect(&escaping).is_err());
    }

    #[test]
    fn rejects_too_many_objects() {
        let temp = tempfile::tempdir().unwrap();
        let spool = create_spool(&temp);
        let item = MediaReference {
            handle: "x.pdf".into(),
            declared_mime: "application/pdf".into(),
            length: 1,
            sha256: "0".repeat(64),
        };
        assert!(
            spool
                .inspect_batch(&vec![item; MAX_MEDIA_OBJECTS + 1])
                .is_err()
        );
    }

    #[test]
    fn ttl_cleanup_only_removes_valid_regular_spool_files() {
        let temp = tempfile::tempdir().unwrap();
        let old_spool = create_spool(&temp);
        let old_root = old_spool.root().to_path_buf();
        let reference = old_spool.write(MediaKind::Pdf, b"%PDF-1.7").unwrap();
        let spool = PrivateSpool::create(old_spool.parent.as_path()).unwrap();
        assert_eq!(
            spool
                .cleanup_expired(Duration::ZERO, &HashSet::new())
                .unwrap(),
            1
        );
        assert!(!old_root.exists());
        assert!(spool.inspect(&reference).is_err());
    }

    #[test]
    fn pending_journal_media_expires_to_content_free_replay_and_is_removed() {
        use crate::ingress::{IngressAck, IngressEvent, PendingJournal};
        use crate::protocol::OutgoingFrame;

        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("spool");
        fs::create_dir(&parent).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let store = temp.path().join("store");
        let original_spool = PrivateSpool::create(&parent).unwrap();
        let reference = original_spool
            .write(MediaKind::Pdf, b"%PDF-1.7\n%%EOF")
            .unwrap();
        let journal = PendingJournal::open(&store, &"a".repeat(64)).unwrap();
        journal
            .persist(IngressEvent {
                event_id: "$outage:example".into(),
                room_id: "!room:example".into(),
                sender_mxid: "@owner:example".into(),
                sender_device_id: "OWNERDEVICE".into(),
                body: Some("caption".into()),
                reply_to_event_id: None,
                media: vec![reference.clone()],
            })
            .unwrap();
        drop(journal);
        drop(original_spool);

        let restarted_journal = PendingJournal::open(&store, &"a".repeat(64)).unwrap();
        let restarted_spool = PrivateSpool::create(&parent).unwrap();
        let expired = restarted_journal.expire_media(Duration::ZERO).unwrap();
        assert_eq!(expired.len(), 1);
        assert!(restarted_journal.replay(64).unwrap().is_empty());
        let rejection = expired[0].rejection.clone();
        let frame = serde_json::to_value(OutgoingFrame::rejected(rejection.clone())).unwrap();
        assert_eq!(frame.as_object().unwrap().len(), 4);
        assert_eq!(frame["type"], "event_rejected");
        assert_eq!(frame["id"], rejection.receipt_id);
        assert_eq!(frame["rejection"].as_object().unwrap().len(), 8);
        assert_eq!(frame["rejection"]["reason"], "media_expired");
        assert!(frame.get("body").is_none());
        assert!(frame.get("media").is_none());
        assert!(frame.get("reply_to_event_id").is_none());
        assert!(frame.get("handle").is_none());
        assert!(frame["rejection"].get("body").is_none());
        assert!(frame["rejection"].get("media").is_none());
        assert!(frame["rejection"].get("handle").is_none());
        assert_eq!(
            restarted_spool
                .cleanup_expired(Duration::ZERO, &HashSet::new())
                .unwrap(),
            1
        );
        assert!(restarted_spool.inspect(&reference).is_err());
        drop(restarted_journal);

        let replayed_journal = PendingJournal::open(&store, &"a".repeat(64)).unwrap();
        let replayed = replayed_journal.replay_rejections(64).unwrap();
        assert_eq!(replayed.len(), 1);
        assert_eq!(replayed[0].receipt_id, rejection.receipt_id);
        assert_eq!(replayed[0].event_hash, rejection.event_hash);

        replayed_journal
            .acknowledge(&IngressAck {
                event_id: "$outage:example".into(),
                durable_receipt_id: "mysql-outage".into(),
            })
            .unwrap();
        assert!(replayed_journal.replay_rejections(64).unwrap().is_empty());
    }

    #[test]
    fn prior_boot_handle_is_denied_until_pending_replay_authorizes_it() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("spool");
        fs::create_dir(&parent).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let old = PrivateSpool::create(&parent).unwrap();
        let reference = old.write(MediaKind::Pdf, b"%PDF-1.7").unwrap();
        let current = PrivateSpool::create(&parent).unwrap();
        assert!(current.inspect(&reference).is_err());
        current
            .authorize_replay(std::slice::from_ref(&reference))
            .unwrap();
        assert!(current.inspect(&reference).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_files() {
        let temp = tempfile::tempdir().unwrap();
        let spool = create_spool(&temp);
        let outside = temp.path().join("outside.pdf");
        fs::write(&outside, b"%PDF-1.7").unwrap();
        let handle = format!("{}-linked.pdf", spool.instance);
        std::os::unix::fs::symlink(outside, spool.root().join(&handle)).unwrap();
        let reference = MediaReference {
            handle,
            declared_mime: "application/pdf".into(),
            length: 8,
            sha256: hex::encode(Sha256::digest(b"%PDF-1.7")),
        };
        assert!(spool.inspect(&reference).is_err());
    }
}
