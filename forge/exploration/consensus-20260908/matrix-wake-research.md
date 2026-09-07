# Matrix automatic intake: bounded read-only findings, 2026-09-08

Scope: repository bd854ee; Published receipt from prior work is fcbe5462fcce3deb37cf016ad1d6c8ac7cb63a34. Current inspection is code/documentation only. No current live request, pusher registration, deployment, secrets, keys, DB or Matrix messages changed. Prior store_binding_unavailable observation is historical, not a newly reproduced incident.

## Current code

- src/godaddy/server.mjs:197–200 starts application.start() after HTTP listen. src/godaddy/application-runtime.ts:192 starts Matrix. Settings login is not a startup dependency; src/godaddy/settings-runtime.ts:560 reads status.
- src/godaddy/matrix-store-binding.ts:149–194 collapses filesystem read failures into store_binding_unavailable. src/godaddy/matrix-service.ts:874–881 fails closed; setTerminal at 704–709 clears maintenance/ingress/outbox timers. Missing, inaccessible, transient and invalid identity are not sufficiently distinguished. The source of the previously observed failure is not yet established.
- native/matrix-sidecar/src/client.rs:271–273 and 1385–1386 treats sync failure as fatal. src/godaddy/matrix-sidecar-supervisor.ts:16–18,956–962,1767–1776 opens a circuit after three crashes in 60 seconds without half-open recovery. This is a code risk, not proof that this path caused the live incident.
- src/godaddy/matrix-release-install.ts:85 and matrix-service-config.ts:141 select /app/public/assets/.personal-consultant-matrix-v1/crypto-store. Existing device binding is required; do not recreate it. Filesystem continuity across redeploy requires live evidence.
- No current push gateway/pusher route was found in the targeted code search. Continuous authenticated sync remains the primary input path.

## Verified primary documentation

1. https://www.godaddy.com/resources/news/godaddy-nodejs-hosting-launch — published August 20, 2026, describes persistent Node 22 processes and background work, not per-request serverless execution. It does not prove uninterrupted service, automatic restart policy, or filesystem durability. Do not diagnose ordinary Published sleep from this source.
2. https://spec.matrix.org/latest/push-gateway-api/ — POST /_matrix/push/v1/notify, minimal event_id_only notifications, retry guidance, duplicate-event handling and rejected pushkey semantics. Protocol endpoint has no standard authentication requirement; our wake hint must still be bounded and cannot be trusted as an owner request.
3. https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv3pushersset — account-scoped HTTP pushers use HTTPS /_matrix/push/v1/notify and may request event_id_only. Account push rules determine whether relevant encrypted messages notify.

All three were browsed in this run. These capabilities establish a candidate integration, not successful registration or runtime verification on this specific GoDaddy app.

## Proposed no-extra-host architecture

First fix typed storage failures, restart/backoff and circuit recovery for the existing persistent process, preserving validated keys/device/cursors/queues and exclusive worker fencing. Then evaluate an additional account-scoped matrix.org HTTP pusher to the same Published origin /_matrix/push/v1/notify. No new server, local worker, cron host or paid service.

Use a dedicated app_id and high-entropy pushkey with event_id_only, preserving existing pushers/rules. Validate app/key/allowed room hints, bound input/rate, coalesce wakes. Do not consume hint content or run an agent. Resume existing authenticated E2EE sync and accept only the verified owner event through durable ingress. Return a transient failure rather than reject a valid pushkey if temporary handoff fails. Do not return success claiming a durable handoff before it exists.

Before live acceptance: inspect precise storage failure and available persistence, confirm pusher support/registration and allowed-room push rules, GoDaddy/WAF HTTPS reachability, and test idle/restart/redeploy with Settings closed. Duplicate hints/events and concurrent restarts must produce no duplicate consultation or altered crypto identity. HTTP push alone is not a guaranteed exactly-once queue or a repair for corrupt/revoked credentials. If the same-host option cannot meet the requirement, report the blocker without buying services or weakening security.
