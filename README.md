# Personal Consultant

A private, single-owner browser application for direct business consultation and multi-agent consilium work. The current production composition root targets the existing GoDaddy Node.js 22 application and MySQL database.

## Current product surfaces

- `/consultation` — submit a consultation request with explicit processing consent, follow confirmed messages, stop work, and export or delete the encrypted whole-session archive.
- `/settings` — choose the available Codex and Critic models and consultation speed.
- `/instructions` — edit the reviewed Markdown instructions used by new sessions.
- `/operations/runtime` — connect subscription-backed AI runtimes and refresh their capability catalog.
- `/healthz` — content-free process liveness only.

All owner surfaces require the configured Google identity and an application session. There is no password fallback. Mutations require same-origin requests and purpose-bound action tokens.

## Runtime

Use Node.js 22 and MySQL 8. Run the schema before starting a production instance:

```bash
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p "$DB_NAME" < scripts/godaddy-state-schema.sql
npm ci
npm run check
npm start
```

Required production configuration:

- `RUNTIME_MODE=production`
- `GODADDY_STATE_DATABASE_ROLE=published`
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- optional `DB_POOL_LIMIT` from 4 through 32; default 8
- `SETTINGS_OWNER_ENABLED=true`
- `SETTINGS_PUBLIC_ORIGIN` as the exact HTTPS origin
- `SETTINGS_OWNER_GOOGLE_EMAIL`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- independent random values for `SETTINGS_SESSION_HMAC_KEY`, `SETTINGS_CSRF_HMAC_KEY`, and `SETTINGS_OAUTH_TRANSACTION_KEY`
- independent 256-bit hex or base64url values for `ARCHIVE_ENCRYPTION_KEY`, `RUNTIME_INSTRUCTION_ENCRYPTION_KEY`, and `RUNTIME_CREDENTIAL_ENCRYPTION_KEY`

The three encryption keys must be different. Instruction content is never supplied through an environment secret. The reviewed repository files `AGENTS.md`, `CONSILIUM.md`, `CONSULTING_PLAYBOOK.md`, and `WORKING_CONTEXT.md` initialize the database once; later edits are encrypted, versioned, and pinned into new consultation snapshots.

Do not configure API or pay-as-you-go provider credentials. The environment validator rejects known API-key and custom-endpoint variables. Provider access uses the supported subscription runtime flows.

## Verification

```bash
npm run check
```

CI also runs `npm run test:mysql` against a real MySQL 8.4 service. That integration test is skipped during ordinary local tests unless `MYSQL_INTEGRATION=1` is set.

## Architecture and operations

- [Architecture](docs/architecture.md)
- [Security and guardrails](docs/guardrails.md)
- [Development plan](docs/development-plan.md)
- [QA checklist](docs/qa-checklist.md)
- [Definition of done](docs/dod-evals.md)
- [Security reporting](SECURITY.md)
