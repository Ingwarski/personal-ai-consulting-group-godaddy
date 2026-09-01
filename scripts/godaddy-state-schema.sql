-- Run only through the explicitly approved Published database operation.
-- Preview must remain stateless until GoDaddy proves a separate state boundary.
CREATE TABLE IF NOT EXISTS personal_consultant_state (
  state_namespace VARCHAR(64) NOT NULL,
  state_key VARCHAR(191) NOT NULL,
  state_value JSON NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (state_namespace, state_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
