# Google owner-login investigation — 5 September 2026

Status: historical investigation and proposed restoration, **not an implemented or deployed login fix**. Scope is the existing Personal Consultant GoDaddy app. No credentials, Google configuration, Published service, database, domain, HappyPro repository, or original consultant repository was changed.

## Current Owner decision

> I would rather fix the google auth login. Check history of what went wrong and find a solution.
> No MFA for this mvp.

This supersedes the password-only/external-identity-provider prohibition for owner access. It does not authorize additional users, a new domain, paid hosting, or mixing Google owner identity with Codex/Claude subscription authorization. The application will not require a second factor in this MVP. Google's own account security can still challenge its user; Google login alone is not evidence of MFA assurance or full ASVS Level 2 compliance. The exact user-message timestamp is not reconstructed.

## What actually happened

| Evidence | Finding |
|---|---|
| `9339b51`, retained Cloudflare adapter | The original approach verified Cloudflare Access JWTs, with Google upstream. This is different from direct Google login in the GoDaddy adapter. |
| `dafe15034512bae3d09044171fa22dbc75df0875` | Added direct Google authorization-code OIDC, state, nonce, PKCE, server-side token verification, and an owner-email check. |
| Historical conversation, 2 September 02:43–02:45 UTC; `db59a16e04885c425e4d6ea3292850e73573393c` | The assistant concluded that the shared GoDaddy hostname required ownership verification and recommended removing Google. The Owner then requested the password replacement. No actual Google rejection preceding that removal was found in the inspected messages or Git evidence. |
| Historical conversation, 2 September 12:54 UTC onward | The repeated reported “Access denied” failures followed the password replacement. They are not evidence that Google OAuth rejected the app. |
| `a608b15`, `c8ae9fc` | Corrected reliance on upstream HTTP and an internal proxy Host when handling browser origin. |
| `88042b42c20f25d6a6c7c768fd26dc3fa3a85fd4` | Corrected `no-referrer` form-origin behavior and cookie ordering that cleared a newly issued retry challenge. |
| `c1a86c1` | Corrected navigation around Codex device authorization. This was OpenAI subscription login, not Google owner login. |
| `6ec608a1ff9617cf9fd5e6f49c2d4f12f66d7b77` | Added durable local authentication/session protections on the isolated remediation branch. These must not be lost when replacing the credential method. |

History was inspected using parsed message records, not a dump of tool outputs or credentials. Absence of a provider error in the inspected evidence is not a claim that no such error ever occurred.

## Reproduced application defect

The old `dafe150:src/godaddy/settings-runtime.ts` reconstructed the request origin from `Host` and `x-forwarded-proto`. Its `google-oidc.ts` then required that origin to match the configured public HTTPS callback origin exactly. GoDaddy's documented-in-repository proxy behavior can violate that assumption.

The historical source was loaded from Git and TypeScript stripped in memory using Node 22.16.0. Only the Google client boundary was replaced with a mock. No production files or external state were changed.

| Case | Reconstructed origin | Historical login start |
|---|---|---|
| Public HTTPS control | `https://settings.example.test` | Allowed |
| Public Host, upstream HTTP | `http://settings.example.test` | Rejected |
| Internal proxy Host | `https://internal-godaddy.example` | Rejected |

The control callback also accepted the mocked identity and called the token-exchange mock. This establishes an application-origin failure mechanism, **not** a successful Google exchange or proof that this was the historical live Google failure.

The current server deliberately constructs an internal request URL (`http://godaddy.internal/...`, `src/godaddy/server.mjs:54–67`). A restored Google adapter must therefore not derive its public callback from `request.url`, proxy Host, or forwarded protocol either.

## What Google's current documentation establishes

- OAuth domains may be owned, authorized for use, or licensed to the developer. The policy does not impose universal ownership of a hosting provider's apex domain. This corrects the earlier categorical rejection; it does not prove acceptance of this specific client configuration. [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)
- Branding/client domains must be registered in Authorized domains. Search Console ownership verification is required when the app needs verification; those are not the same requirement. The old screenshot containing `cloudflareaccess.com` was an authorized-domain list, not proof of the actual OAuth redirect URI. [Google Branding configuration](https://support.google.com/cloud/answer/15549049?hl=en-GB)
- Personal-use apps for a limited number of known users have verification exceptions. Scope and policy requirements still apply. [Google verification requirements](https://developers.google.com/identity/verification/authentication-verification)
- Testing's usual test-user and seven-day authorization restrictions have a specific exception when only identity scopes (`openid`, email, profile) are requested. Testing is therefore not an application-side owner allowlist. This restoration needs only `openid email`. [Google app audience](https://support.google.com/cloud/answer/15549945?hl=en)
- The Web application client needs an exact registered HTTPS redirect URI. Code exchange and credentials stay on the server. [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- Verify the ID token and bind identity to Google's stable `sub`; do not authorize a submitted email or account-selection hint. Preserve nonce validation and the verified-owner restriction. [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)

Research judgment: direct Google OIDC on the assigned GoDaddy hostname is a viable approach to test, not something the cited policy categorically prohibits. Actual Google Console validation and a real browser round trip remain necessary.

## Minimal restoration design

1. Configure this exact public callback, independent of GoDaddy's internal routing:

   `https://wy2v0putg6.c35.airoapp.ai/auth/google/callback`

   Inspect the existing Google project's Web application client and Authorized domains before any change. Do not delete the old Cloudflare domain or claim ownership of `airoapp.ai`. Request only identity scopes; no Drive/Gmail or offline token requirement.

2. Add direct Google authorization-code login to the **current** adapter. Use state, nonce, PKCE S256, atomic one-use transactions, official token validation and the exact allowed owner identity. Use a short-lived Secure/HttpOnly/host-only `SameSite=Lax` transaction cookie for Google's top-level GET callback. That callback cannot require the same-origin headers used for local mutation requests; the mutation protections remain in place. Verify callback-to-session landing in a real browser instead of weakening cookie controls to hide redirect failures.

3. Preserve the repaired durable session boundary: restart persistence, server-side logout revocation, generation invalidation, rotation, bounded attempts, 30-minute idle expiry and 12-hour absolute expiry. Invalidate password-era sessions when changing methods; do not retain a hidden password fallback. Authentication and runtime preparation must remain available before the capability catalog exists. Test configuration failure without unexpectedly stopping Matrix; the current application startup couples Settings configuration and Matrix readiness.

Do not restore the historical Google implementation unchanged: it also used stateless sessions, lacked durable one-use transaction consumption, and gated login on a capability catalog that might require login to prepare.

## Verification needed before a live-fix claim

- Offline regressions: both proxy variants above, missing/wrong/replayed/expired state, missing transaction cookie, nonce/audience/issuer/signature/expiry mismatch, non-owner Google identity, provider cancellation, callback errors, session landing, logout/restart/expiry, and login before catalog readiness.
- Exact Google client/configuration acceptance on the existing hostname; no successful console check is claimed here.
- Real external-browser login → callback → protected runtime/settings; refresh and return after navigating away; logout must revoke access. A local mock, HTTP 200, or dashboard deployment label cannot substitute for this.

Unauthenticated live HTTP checks during this investigation: `/healthz` returned 200; `/auth/sign-in` returned 200 with a password form and `Referrer-Policy: same-origin`; `/auth/google/start` returned 404. This confirms that the currently served entrance is still password login, not the restored Google solution. It does not identify the exact deployed Git revision.

Browser inspection could not proceed because the Mac was locked. The Owner was asked to unlock it; no lock or account security was bypassed. No Google client secret was read, copied, regenerated or entered.

## SDD handoff boundary

`to-product-idea` owns recording the explicit Google/no-application-MFA change; the old MFA question is answered by this message, not left awaiting the same decision. Downstream PRD/security, architecture, UX, QA and plan reconciliation remains explicit and must not be marked complete from this research alone. The existing invalid implementation authorization remains invalid. This report is investigation evidence and a proposed correction, not a replacement development plan or an implementation receipt.

Owner reconciliation completed under invocation `6c04877e-6bb8-48ce-aa78-92be9b8e4fdd`, submitted `2026-09-05T02:26:37Z`; `docs/product-idea.md` SHA-256 is `c7e0dec20e60f5eae35a16192a3b21a74e43faffb8853f8c15accf457f1eefee`. The stage-aware checker passed both the product-idea pre-check and post-check. That checker verifies declared metadata/integrity, not live login or semantic completeness of downstream requirements. Existing downstream source hashes were deliberately not rebound to unread/unchanged documents. The auth-choice input request is answered, and provider inspection is recorded separately as awaiting user action.
