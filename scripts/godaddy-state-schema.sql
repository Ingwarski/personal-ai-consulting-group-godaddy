-- Run only through the explicitly approved Published database operation.
-- Preview remains stateless until the host proves a separate state boundary.
CREATE TABLE IF NOT EXISTS personal_consultant_state (
  state_namespace VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  state_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  state_value JSON NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (state_namespace, state_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- State keys and idempotency identifiers are byte-sensitive.
ALTER TABLE personal_consultant_state
  MODIFY state_namespace VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  MODIFY state_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- Archive ciphertext is kept outside the generic state table. The application
-- encryption key is a Published-only secret and is never stored in MySQL.
CREATE TABLE IF NOT EXISTS personal_consultant_archives (
  archive_id VARCHAR(196) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lifecycle ENUM('staged', 'committed') NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  manifest JSON NOT NULL,
  iv_base64 VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ciphertext_base64 LONGTEXT NOT NULL,
  PRIMARY KEY (archive_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS personal_consultant_archive_tombstones (
  archive_id VARCHAR(196) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  deleted_at VARCHAR(64) NOT NULL,
  plaintext_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (archive_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
