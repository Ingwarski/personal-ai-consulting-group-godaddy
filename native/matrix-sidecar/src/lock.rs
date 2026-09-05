use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use fs2::FileExt;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LockError {
    #[error("store root is not private")]
    UnsafeRoot,
    #[error("store is already locked")]
    Contended,
    #[error("store lock is unavailable")]
    Io,
}

#[derive(Debug)]
pub struct StoreLock {
    file: File,
    path: PathBuf,
}

impl StoreLock {
    pub fn acquire(store_root: &Path) -> Result<Self, LockError> {
        ensure_private_directory(store_root)?;
        let path = store_root.join("sidecar.lock");
        reject_unsafe_file_if_present(&path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(nofollow_flag())
            .open(&path)
            .map_err(|_| LockError::Io)?;
        verify_private_file(&file)?;
        file.try_lock_exclusive().map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                LockError::Contended
            } else {
                LockError::Io
            }
        })?;
        Ok(Self { file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn ensure_private_directory(path: &Path) -> Result<(), LockError> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|_| LockError::Io)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !private_owner_mode(&metadata, 0o700)
        {
            return Err(LockError::UnsafeRoot);
        }
    } else {
        fs::create_dir_all(path).map_err(|_| LockError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| LockError::Io)?;
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| LockError::Io)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !private_owner_mode(&metadata, 0o700)
        {
            return Err(LockError::UnsafeRoot);
        }
    }
    Ok(())
}

pub fn verify_private_path(path: &Path) -> Result<(), LockError> {
    reject_unsafe_file_if_present(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nofollow_flag())
        .open(path)
        .map_err(|_| LockError::Io)?;
    verify_private_file(&file)
}

pub fn read_private_file(path: &Path, maximum: u64) -> Result<Vec<u8>, LockError> {
    reject_unsafe_file_if_present(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nofollow_flag())
        .open(path)
        .map_err(|_| LockError::Io)?;
    verify_private_file(&file)?;
    let mut bytes = Vec::new();
    file.take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| LockError::Io)?;
    if bytes.len() as u64 > maximum {
        return Err(LockError::UnsafeRoot);
    }
    Ok(bytes)
}

pub fn atomic_create_private(path: &Path, bytes: &[u8]) -> Result<(), LockError> {
    atomic_write_private(path, bytes, false)
}

pub fn atomic_replace_private(path: &Path, bytes: &[u8]) -> Result<(), LockError> {
    atomic_write_private(path, bytes, true)
}

fn atomic_write_private(path: &Path, bytes: &[u8], replace: bool) -> Result<(), LockError> {
    let parent = path.parent().ok_or(LockError::Io)?;
    ensure_private_directory(parent)?;
    if replace {
        verify_private_path(path)?;
    } else {
        reject_unsafe_file_if_present(path)?;
        if path.exists() {
            return Err(LockError::Io);
        }
    }
    let target = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| valid_atomic_target(value))
        .ok_or(LockError::Io)?;
    let temp = parent.join(format!(
        ".atomic-{target}-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nofollow_flag())
            .open(&temp)
            .map_err(|_| LockError::Io)?;
        verify_private_file(&file)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| LockError::Io)?;
        verify_private_path(&temp)?;
        if replace {
            fs::rename(&temp, path).map_err(|_| LockError::Io)?;
        } else {
            fs::hard_link(&temp, path).map_err(|_| LockError::Io)?;
        }
        verify_private_path(path)?;
        sync_private_directory(parent)?;
        if !replace {
            fs::remove_file(&temp).map_err(|_| LockError::Io)?;
            sync_private_directory(parent)?;
        }
        Ok(())
    })();
    if result.is_err() && temp.exists() {
        let _ = fs::remove_file(&temp);
        let _ = sync_private_directory(parent);
    }
    result
}

pub fn cleanup_atomic_temps(
    directory: &Path,
    allowed_target: impl Fn(&str) -> bool,
) -> Result<(), LockError> {
    ensure_private_directory(directory)?;
    let mut removed = false;
    for entry in fs::read_dir(directory).map_err(|_| LockError::Io)? {
        let entry = entry.map_err(|_| LockError::Io)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(".atomic-") {
            continue;
        }
        let target = atomic_temp_target(name).ok_or(LockError::UnsafeRoot)?;
        if !allowed_target(target) {
            return Err(LockError::UnsafeRoot);
        }
        let path = entry.path();
        verify_private_path(&path)?;
        fs::remove_file(path).map_err(|_| LockError::Io)?;
        removed = true;
    }
    if removed {
        sync_private_directory(directory)?;
    }
    Ok(())
}

pub fn is_atomic_temp_name(name: &str) -> bool {
    atomic_temp_target(name).is_some()
}

fn atomic_temp_target(name: &str) -> Option<&str> {
    let inner = name
        .strip_prefix(".atomic-")
        .and_then(|value| value.strip_suffix(".tmp"))?;
    let (target, nonce) = inner.rsplit_once('-')?;
    (valid_atomic_target(target)
        && nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(target)
}

fn valid_atomic_target(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn sync_private_directory(path: &Path) -> Result<(), LockError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| LockError::Io)
}

fn reject_unsafe_file_if_present(path: &Path) -> Result<(), LockError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || !private_owner_mode(&metadata, 0o600)
            {
                return Err(LockError::UnsafeRoot);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(LockError::Io),
    }
    Ok(())
}

fn verify_private_file(file: &File) -> Result<(), LockError> {
    let metadata = file.metadata().map_err(|_| LockError::Io)?;
    if !metadata.is_file() || !private_owner_mode(&metadata, 0o600) {
        return Err(LockError::UnsafeRoot);
    }
    Ok(())
}

#[cfg(unix)]
fn private_owner_mode(metadata: &fs::Metadata, required_mode: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.mode() & 0o777 == required_mode
        && metadata.uid() == rustix::process::geteuid().as_raw()
}

#[cfg(not(unix))]
fn private_owner_mode(_metadata: &fs::Metadata, _required_mode: u32) -> bool {
    false
}

#[cfg(unix)]
fn nofollow_flag() -> i32 {
    i32::try_from(rustix::fs::OFlags::NOFOLLOW.bits()).expect("O_NOFOLLOW fits i32")
}

#[cfg(not(unix))]
fn nofollow_flag() -> i32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_exclusive_for_process_lifetime() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let first = StoreLock::acquire(&root).unwrap();
        assert!(matches!(
            StoreLock::acquire(&root),
            Err(LockError::Contended)
        ));
        drop(first);
        StoreLock::acquire(&root).unwrap();
    }

    #[test]
    fn symlink_root_is_rejected() {
        #[cfg(unix)]
        {
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join("target");
            fs::create_dir(&target).unwrap();
            let root = temp.path().join("store");
            std::os::unix::fs::symlink(target, &root).unwrap();
            assert!(matches!(
                StoreLock::acquire(&root),
                Err(LockError::UnsafeRoot)
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_unsafe_permissions_are_rejected_without_chmod() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            StoreLock::acquire(&root),
            Err(LockError::UnsafeRoot)
        ));
        assert_eq!(
            fs::metadata(root).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(unix)]
    #[test]
    fn existing_symlink_or_unsafe_lock_file_is_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let lock = root.join("sidecar.lock");
        fs::write(&lock, b"").unwrap();
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            StoreLock::acquire(&root),
            Err(LockError::UnsafeRoot)
        ));
        fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink(root.join("missing"), &lock).unwrap();
        assert!(StoreLock::acquire(&root).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_private_publish_is_no_clobber_and_cleanup_is_target_aware() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        ensure_private_directory(&root).unwrap();
        let record = root.join("record.json");
        atomic_create_private(&record, b"one").unwrap();
        assert_eq!(read_private_file(&record, 16).unwrap(), b"one");
        assert!(atomic_create_private(&record, b"clobber").is_err());
        atomic_replace_private(&record, b"two").unwrap();
        assert_eq!(read_private_file(&record, 16).unwrap(), b"two");

        let orphan = root.join(format!(".atomic-record.json-{}.tmp", "a".repeat(32)));
        fs::write(&orphan, b"torn").unwrap();
        fs::set_permissions(&orphan, fs::Permissions::from_mode(0o600)).unwrap();
        cleanup_atomic_temps(&root, |target| target == "record.json").unwrap();
        assert!(!orphan.exists());

        let unknown = root.join(format!(".atomic-unrelated-{}.tmp", "b".repeat(32)));
        fs::write(&unknown, b"private").unwrap();
        fs::set_permissions(&unknown, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(cleanup_atomic_temps(&root, |target| target == "record.json").is_err());
        assert!(unknown.exists());
    }
}
