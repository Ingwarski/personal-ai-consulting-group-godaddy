# QA checklist

## Authentication and HTTP

- Wrong Google identity is denied; no password fallback exists.
- Session expiry, sign-out, and revoke-all invalidate access.
- Cross-origin and missing/wrong action tokens fail before mutation.
- Duplicate cookies, malformed callbacks, oversized bodies, unknown fields, and unsupported methods fail closed.
- Protected responses use restrictive security headers and do not cache confidential data.

## Consultation

- Missing consent, empty/oversized task, and secret-like content are rejected before provider use.
- Repeated request ID is idempotent; a second active request is busy.
- Task plaintext does not appear in the operation record.
- Direct answer, clarification, and consilium keep registrar order.
- Stop wins races with late provider completion.
- Restart does not replay uncertain work.
- Successful session closure occurs only after archive commit.

## Instructions

- First initialization imports all four reviewed Markdown files.
- Persistent rows contain ciphertext rather than Markdown plaintext.
- Invalid, empty, control-character, and oversized documents are rejected.
- Stale revisions return a conflict.
- Ciphertext and its revision pointer commit atomically.
- Restore creates a new revision; old snapshots remain unchanged.
- Editable instructions cannot change auth, consent, provider, tool, or security policy.

## Archive and database

- Wrong key and tampering fail integrity validation.
- Export and delete require explicit whole-session confirmation.
- Tombstones prevent deleted archives from being recreated.
- MySQL transaction rollback, binary key collation, archive lifecycle, and advisory lock behavior pass against real MySQL.
- Pool size and queue are bounded; shutdown order is HTTP drain, consultation, providers, database.

## Deployment evidence

- Exact Node 22 version, revision, environment-name inventory, schema version, health, and logs.
- Real owner login and provider subscription availability.
- Synthetic restart, backup/restore, and rollback rehearsal.
- No real owner content or production service contact during isolated verification.
