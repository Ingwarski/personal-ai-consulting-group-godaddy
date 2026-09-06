# Matrix consultation connection — local implementation report

The local application now connects accepted Matrix input to the consultation planner, specialists, the explicitly selected Critic, synthesis and the existing durable outgoing-message queue. It is **not published** and has not been verified against live GoDaddy, Matrix or model providers.

## Fixes delivered

1. **Missing dispatcher:** production startup now drains the durable incoming queue. The head chooses a direct answer, one clarification question or the smallest sufficient specialist group. Ordinary processing requires the owner's one-time consent.
2. **Duplicate and interrupted work:** one MySQL connection-owned lock controls execution. Event replay does not start another consultation. An uncertain provider attempt after restart waits for explicit `Продовжити`; an already closed session is recovered as completed.
3. **Final answer being cancelled:** successful finalization previously called the cancellation operation. It now closes the session normally and preserves its pending final delivery. `Стоп` retains its separate cancellation semantics.
4. **Clarifications and native replies:** answers to the bot's question keep the same logical session, original model settings and earlier confirmed discussion. Replies belonging to another session cannot be joined. Confirmed attachments remain available while awaiting clarification.
5. **Attachments:** encrypted, expiring staging uses existing MySQL KV rows; no new table or production schema operation. Each attachment requires a reply-bound confirmation. PNG/JPEG go through private Codex image inputs. PDFs use bounded, isolated text-layer extraction. Failed or rejected bytes never become metadata-only substitute input.
6. **Bounds and controls:** fast/balanced/thorough allow at most 2/3/5 specialists. One Critic/revision cycle remains mandatory for consultations. Each attempt stops at nine minutes and requests explicit continuation. Waiting notices contain no invented agent progress. Shutdown cancels local work before closing transport/provider/database resources.
7. **Race conditions and privacy:** fixed costs-versus-final, Stop-versus-snapshot, readiness-loss, stale-leader and deadline-notice races. Unsafe outputs are rejected whole before recording. Oversized attachments across separate messages are rejected before they can corrupt saved control state.

## Verification

- Node.js 22.23.2: **678 tests passed**, zero failed, skipped or cancelled; build, TypeScript and runtime-environment checks passed.
- SDD after-implementation checker: 13 artifacts, zero issues and warnings. This checks declared integrity and references, not live release readiness.
- Actual production composition with simulated external adapters: consent → head planning → two specialists → Astra/Extra High Critic → revision → head synthesis → preserved final delivery intent. Exactly seven expected provider turns across five isolated contexts; replay adds none.
- Separate tests cover 15 worker/control/reply scenarios, six SQL-lock/reply boundaries, actual PDF extraction, attachment ownership/expiry and the pinned native Codex image-input schema.
- The unchanged Rust transport was reused. Its historical verification was not relabelled as newly executed evidence.

Detailed source hashes, evidence and remaining limits: [verification.json](verification.json).

## Boundaries still open

Scanned/image-only PDFs, OCR and visually interpreting PDF charts are not supported by this slice. The file must have a usable text layer. Expired or unreadable attachments require `Нова задача` followed by resending the task and safe source files.

The system waiting notice does not prove the complete product timing contract (first specialist response within 30 seconds and specialist intervention at 90 seconds). Owner confirmation plus secret-pattern checks does not establish complete sensitive-document safety. No full Unit or release acceptance is claimed; existing archive, credential/artifact and real-environment gates remain open.

Production data, credentials, GoDaddy publication, domain, HappyPro and Matrix room/device state were untouched. Preview remains non-stateful.

## Next steps — only after separate publication approval

1. Verify the intended GoDaddy Published application/branch and existing non-secret readiness signals. Do not change Preview, the domain or credentials as part of publishing this code.
2. Publish the reviewed code revision through the existing approved release path; verify the running code, not only the delayed dashboard label.
3. In owner Settings, confirm the Codex agent model and explicitly choose the desired Critic provider/model/effort. Save the complete compatible set. No automatic provider substitution.
4. In the already approved encrypted Matrix room, send a harmless multi-disciplinary business test question. If prompted, send exactly `Погоджуюсь на обробку`.
5. Verify that real specialist messages, the selected Critic's review and the final recommendation arrive. Match the final message to the durable accepted delivery record; do not infer delivery from a green local test.
6. Answer a bot clarification using Matrix's Reply action. Verify that it continues the same logical task without changing its original settings.
7. Start a second harmless test and send `Стоп` while it is running. Verify that no late response or duplicate consultation is delivered. Restart/retry and attachment tests require their own bounded live test authorization; do not wipe data or regenerate crypto state.

If any gate fails, retain the evidence, stop the live test and repair the specific failure. Do not mark the next Unit complete from this report.
