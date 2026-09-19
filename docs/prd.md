# Product requirements

## Functional requirements

1. Only the configured Google owner identity can enter protected routes.
2. Owner sessions have absolute and idle expiry, explicit sign-out, and global revocation.
3. All protected mutations require same-origin validation and a purpose-bound action token.
4. A consultation requires a non-empty bounded request and explicit processing consent.
5. Secret-like request content is rejected before provider dispatch.
6. An idempotency key identifies each submission; one active consultation is allowed per canonical database.
7. The registrar owns session generation, ordering, deduplication, stop, and close state.
8. Direct answers and clarifications are archived successfully before the session closes.
9. Consilium finalization also passes the archive close barrier before closure.
10. Restart recovery marks uncertain in-flight provider work failed and never silently replays it.
11. The four managed Markdown files initialize instruction state and are editable from authenticated Settings.
12. Instruction updates use optimistic revisions and transactionally commit encrypted content with its metadata pointer.
13. Each new session pins settings and instruction snapshots.
14. Archives expose whole-session export and deletion only, both with explicit owner confirmation.
15. The owner can select only models proven available by a current capability receipt.
16. Provider API-key, pay-as-you-go, custom-endpoint, and cloud-credential fallback variables are rejected.

## Non-functional requirements

- Node.js 22 and MySQL 8 are the supported runtime baseline.
- Persistent confidential content uses application-layer authenticated encryption with independent keys.
- HTTP responses use restrictive security headers and no-store behavior for protected data.
- Request bodies, identifiers, documents, cookies, and stored collections have explicit bounds.
- Shutdown drains HTTP requests, aborts active consultation work, closes provider processes, then closes MySQL.
- The connection pool is process-wide, bounded, and uses a finite wait queue.
- Logs and health responses contain no owner content, secrets, provider credentials, or archive plaintext.
