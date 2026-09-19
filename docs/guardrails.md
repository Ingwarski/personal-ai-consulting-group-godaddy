# Guardrails

- Fail closed when authentication, database configuration, encryption keys, provider capability, or archive persistence is unavailable.
- Keep owner authentication, action tokens, provider credentials, instruction encryption, and archive encryption in separate key purposes. Production key values must be independently random.
- Never accept provider selection, model authority, tool permissions, or security-policy changes from consultation text or editable instructions.
- Never pass Google credentials, application cookies, action tokens, database credentials, or encryption keys to AI providers.
- Reject known API-key, pay-as-you-go, alternate endpoint, and cloud credential variables.
- Do not log request bodies, provider tokens, instruction plaintext, confirmed message bodies, or decrypted archives.
- Store consultation task hashes in operation records; keep task plaintext only for the active execution path and confirmed output only in the registrar/archive.
- Close a successful session only after its encrypted archive is committed.
- Do not replay an uncertain provider operation after restart.
- Permit whole-session archive export and deletion only after an authenticated, same-origin, explicitly confirmed request.
- Never allow per-message archive mutation or deletion.
- Treat `/healthz` as liveness only.
- Keep the GoDaddy composition root until a separately authorized host-extraction migration supplies equivalent deployment evidence.
