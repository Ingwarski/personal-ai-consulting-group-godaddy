# Development plan

## Implemented

1. Authenticated browser consultation with explicit consent, secret rejection, idempotent submission, stop, recovery, and one-active-session leadership.
2. Canonical registrar projection independent of presentation transport.
3. Archive-before-close with AES-GCM MySQL storage, whole-session export, explicit deletion, and tombstones.
4. Repository Markdown initialization with encrypted, versioned, transactionally consistent Settings edits and immutable session snapshots.
5. Separate encryption roots for provider credentials, instructions, and archives.
6. Removal of obsolete messaging, password-authentication, and alternate-host runtime code.
7. Node.js 22 alignment, bounded shared MySQL pool, namespace-derived advisory locks, neutral CI, and real MySQL integration coverage.

## Deployment work still required

1. Generate distinct production keys and place them only in the production secret store.
2. Apply the schema to an isolated target database and prove backup/restore.
3. Configure the exact Google origin/callback and verify the sole owner account.
4. Complete Codex and optional Claude Code subscription authorization.
5. Exercise consultation, stop, restart recovery, archive export/delete, session revoke, and graceful shutdown with synthetic data on the deployed host.
6. Record deployment revision, runtime version, database identity, and rollback procedure.

Extracting GoDaddy from the composition root and running a deep security scan are separate tasks and are not part of this implementation.
