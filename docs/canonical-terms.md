# Canonical terms

| Term | Meaning |
|---|---|
| Owner | The single Google identity allowed to use the application. |
| Owner session | The application session created after verified Google identity. |
| Consultation | One owner request and its confirmed response sequence. |
| Direct answer | A bounded Head-only answer selected by intake policy. |
| Consilium | A multi-agent consultation with a Head, selected specialists, and a required Critic. |
| Registrar | The canonical MySQL-backed authority for session generation and confirmed-message order. |
| Instruction document | One editable Markdown operating document stored encrypted and versioned. |
| Instruction snapshot | The immutable set of instruction revisions pinned to a new consultation. |
| Archive | The AES-GCM-encrypted whole-session transcript stored in MySQL. |
| Tombstone | Durable evidence that an archive was deleted and must not be recreated. |
| Capability receipt | Time-bounded provider-confirmed model availability used to validate saved settings. |
| Subscription runtime | Codex or Claude Code access through the supported account flow without API-key fallback. |
| Liveness | Proof that the Node process responds; it does not prove database, auth, provider, or consultation readiness. |
