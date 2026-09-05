-- Run only through the explicitly approved Published database operation.
-- Preview must remain stateless until GoDaddy proves a separate state boundary.
CREATE TABLE IF NOT EXISTS personal_consultant_state (
  state_namespace VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  state_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  state_value JSON NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (state_namespace, state_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Existing deployments must not keep the earlier case-insensitive key index:
-- Matrix event IDs embedded in registrar keys are byte-significant.
ALTER TABLE personal_consultant_state
  MODIFY state_namespace VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  MODIFY state_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- The registrar inserts a confirmed message in personal_consultant_state and
-- its publication intent here through one connection and one transaction.
CREATE TABLE IF NOT EXISTS personal_consultant_matrix_outbox (
  generation BIGINT UNSIGNED NOT NULL,
  sequence_no BIGINT UNSIGNED NOT NULL,
  transaction_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('pending', 'leased', 'accepted', 'device_delivered', 'read', 'blocked', 'cancelled') NOT NULL,
  record_kind ENUM('message', 'control') NOT NULL,
  message_json JSON NOT NULL,
  body_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delivery_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reply_to_event_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  matrix_event_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_expires_at VARCHAR(64) NULL,
  attempt_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  available_at VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  accepted_at VARCHAR(64) NULL,
  device_delivered_at VARCHAR(64) NULL,
  read_at VARCHAR(64) NULL,
  device_delivery_evidence_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  device_delivery_evidence_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  read_evidence_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  read_evidence_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (generation, sequence_no),
  UNIQUE KEY uq_matrix_outbox_transaction (transaction_id),
  UNIQUE KEY uq_matrix_outbox_event (matrix_event_id),
  KEY ix_matrix_outbox_head (state, generation, sequence_no)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Existing U-06 schemas may predate the digest that binds record kind,
-- visible time and the complete delivery envelope. Keep this migration
-- idempotent without assuming a particular MySQL minor version supports
-- ADD COLUMN IF NOT EXISTS.
SET @pc_delivery_hash_migration = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE personal_consultant_matrix_outbox ADD COLUMN delivery_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER body_hash',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'personal_consultant_matrix_outbox'
    AND COLUMN_NAME = 'delivery_hash'
);
PREPARE pc_delivery_hash_statement FROM @pc_delivery_hash_migration;
EXECUTE pc_delivery_hash_statement;
DEALLOCATE PREPARE pc_delivery_hash_statement;
-- This intentionally fails closed if a pre-U-06 outbox contains rows that
-- have not been reconciled to a canonical delivery digest.
ALTER TABLE personal_consultant_matrix_outbox
  MODIFY delivery_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

-- The Matrix event ID is the durable dedupe key. ACK becomes eligible only
-- after the complete work intent commits and any media is durably consumed;
-- the leased consumer then performs the idempotent registrar/session operation
-- without relying on sidecar replay or ephemeral media handles.
CREATE TABLE IF NOT EXISTS personal_consultant_matrix_ingress (
  event_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  event_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('ready', 'leased', 'processed', 'rejected', 'blocked') NOT NULL,
  room_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  owner_mxid VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  body_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  media_manifest_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  work_intent_json JSON NOT NULL,
  ack_eligible_at VARCHAR(64) NULL,
  media_consumption_receipt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  media_consumed_at VARCHAR(64) NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_expires_at VARCHAR(64) NULL,
  session_id VARCHAR(128) NULL,
  generation BIGINT UNSIGNED NULL,
  received_at VARCHAR(64) NOT NULL,
  acknowledged_at VARCHAR(64) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (event_id),
  KEY ix_matrix_ingress_recovery (state, lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Existing U-06 schemas need the durable, content-free poison-input state.
-- Run this only as part of the same explicitly approved Published migration.
ALTER TABLE personal_consultant_matrix_ingress
  MODIFY state ENUM('ready', 'leased', 'processed', 'rejected', 'blocked') NOT NULL;

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
