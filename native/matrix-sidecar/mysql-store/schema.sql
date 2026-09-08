-- Explicit additive provisioning only. Never executed by Backend::open.
CREATE TABLE IF NOT EXISTS pc_matrix_stores (
  store_id BINARY(16) NOT NULL PRIMARY KEY,
  schema_version INT UNSIGNED NOT NULL,
  identity_fingerprint BINARY(32) NOT NULL,
  account_fingerprint BINARY(32) NULL,
  cipher_export BLOB NOT NULL,
  binding BLOB NOT NULL,
  fence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  owner_nonce BINARY(16) NULL,
  lease_expires_ms BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pc_matrix_records (
  store_id BINARY(16) NOT NULL,
  namespace VARBINARY(64) NOT NULL,
  record_key BINARY(32) NOT NULL,
  prefix_bucket BINARY(32) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  payload LONGBLOB NOT NULL,
  PRIMARY KEY (store_id, namespace, record_key),
  KEY ix_pc_matrix_record_prefix (store_id, namespace, prefix_bucket, record_key),
  CONSTRAINT fk_pc_matrix_record_store FOREIGN KEY (store_id)
    REFERENCES pc_matrix_stores(store_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pc_matrix_inbox (
  store_id BINARY(16) NOT NULL,
  event_key BINARY(32) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  status VARBINARY(24) NOT NULL,
  payload LONGBLOB NOT NULL,
  PRIMARY KEY (store_id, event_key),
  CONSTRAINT fk_pc_matrix_inbox_store FOREIGN KEY (store_id)
    REFERENCES pc_matrix_stores(store_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pc_matrix_migrations (
  store_id BINARY(16) NOT NULL,
  migration_id BINARY(16) NOT NULL,
  phase VARBINARY(24) NOT NULL,
  payload LONGBLOB NOT NULL,
  PRIMARY KEY (store_id, migration_id),
  CONSTRAINT fk_pc_matrix_migration_store FOREIGN KEY (store_id)
    REFERENCES pc_matrix_stores(store_id)
) ENGINE=InnoDB;
