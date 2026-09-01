-- Run only through the explicitly approved Published database operation.
-- Preview must remain stateless until GoDaddy proves a separate state boundary.
CREATE TABLE IF NOT EXISTS personal_consultant_state (
  state_namespace VARCHAR(64) NOT NULL,
  state_key VARCHAR(191) NOT NULL,
  state_value JSON NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (state_namespace, state_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Archive ciphertext is intentionally not stored in the generic state table.
-- The encryption key is a Published-only secret and is never stored here.
CREATE TABLE IF NOT EXISTS personal_consultant_archives (
  archive_id VARCHAR(196) NOT NULL,
  lifecycle ENUM('staged', 'committed') NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  manifest JSON NOT NULL,
  iv_base64 VARCHAR(32) NOT NULL,
  ciphertext_base64 LONGTEXT NOT NULL,
  PRIMARY KEY (archive_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS personal_consultant_archive_tombstones (
  archive_id VARCHAR(196) NOT NULL,
  deleted_at VARCHAR(64) NOT NULL,
  plaintext_sha256 CHAR(64) NOT NULL,
  PRIMARY KEY (archive_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
