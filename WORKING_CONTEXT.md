# Working context

## Current objective

Operate Personal Consultant as a private browser application for one owner. The owner can request a consultation, use the configured subscription-backed AI providers, edit reviewed Markdown instructions, and manage encrypted whole-session archives.

## Confirmed decisions

- The current deployment composition root remains the existing GoDaddy Node.js 22 application with MySQL.
- Removing GoDaddy from the application core is deferred and outside the current implementation scope.
- Consultation uses the authenticated browser surface.
- Google verifies the one allowed owner identity. The application creates its own short-lived session; there is no password fallback.
- Provider API keys, pay-as-you-go credentials, custom endpoints, and cloud credential fallbacks are forbidden.
- `AGENTS.md`, `CONSILIUM.md`, `CONSULTING_PLAYBOOK.md`, and this file are reviewed repository defaults. First startup imports them; later Settings edits are encrypted and versioned in MySQL.
- Every new consultation pins an immutable instruction snapshot and settings snapshot.
- Archives contain the whole confirmed transcript, are encrypted before MySQL storage, and support explicit whole-session export and deletion only.
- A deep security scan was excluded from the current implementation request. Ordinary tests and security-focused unit/integration checks remain required.

## Current verification boundary

Local build, type checking, unit tests, environment checks, and MySQL integration tests are implementation evidence. They do not prove a live GoDaddy deployment, a real Google login, provider subscription availability, production key custody, backup restoration, or production network controls.

## Next operational checkpoint

Before deployment, create distinct production keys, apply `scripts/godaddy-state-schema.sql`, configure the exact HTTPS origin and Google callback, verify provider subscription login, exercise restart recovery with synthetic data, and prove encrypted backup and restore on an isolated database.
