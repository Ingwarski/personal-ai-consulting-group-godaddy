# Project context

This repository contains the application domain, the current GoDaddy Node.js composition root, browser owner surfaces, MySQL adapters, provider process adapters, and deterministic tests.

The main trust boundaries are:

1. Browser to application: exact HTTPS origin, Google identity, secure cookies, same-origin checks, and purpose-bound action tokens.
2. Application to providers: subscription-backed isolated processes with an explicit environment allowlist and no API-key fallback.
3. Application to MySQL: canonical session state, settings, encrypted instruction versions, provider credential ciphertext, archive ciphertext, and deletion tombstones.
4. Repository to runtime instructions: reviewed Markdown is seed material only; database revisions become the active source after initialization.

Production secrets and owner data are outside Git. Preview must remain stateless unless it has a separately proven database and credential boundary.
