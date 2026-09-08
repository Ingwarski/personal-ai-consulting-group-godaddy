# Settings usability repair — verification

## Implemented

- Shared owner utility shell for login, runtime/provider setup, Matrix setup, schema/collation utilities and first-time catalog recovery. Existing model settings retain their layout and gain matching navigation and larger controls.
- The read-only Preview verifier receives the same stylesheet and viewport layout; verification logic and script identity are unchanged.
- Minimum 48 CSS px buttons/selects, larger labels/help, wrapping long labels, separated action groups, full-width mobile buttons, visible focus, preserved hidden and disabled states.
- Codex, Claude Code and owner-session actions have separate sections. No provider routing, model capabilities, action URLs, token checks or credential behavior changed.
- `/assets/owner-panel.css` is a presentation-only public alias for the existing built stylesheet, so the login page can load it before authentication. Existing protected settings asset routes remain protected. Tests reject database access while serving this public stylesheet.

## Verification evidence

- `npm run check`: build, TypeScript, all 897 tests and environment policy passed.
- New regression coverage: utility shell/title escaping/script-path rejection; separate provider sections and preserved form tokens; authenticated login/runtime/recovery/schema/collation HTML; public stylesheet without access to protected state, including an unconfigured runtime.
- Real Chromium through Playwright, synthetic local fixture only: runtime, login, Matrix, settings and empty-catalog layouts at 320, 390, 430, 768, 1280 and 1440 CSS px. All 30 combinations had no horizontal overflow, visible hidden elements or visible buttons/selects below 48px.
- 200% text at 390px checked on runtime, login, Matrix and model settings: no horizontal overflow or undersized controls.
- Keyboard: first Tab reaches the skip link with a 3px focus outline. Synthetic login submission sets `aria-busy`, disables its button, focuses the returned error and re-enables the button. Existing model settings disabled controls remain disabled.
- Desktop runtime and mobile runtime/settings screenshots visually inspected. Local screenshots are in ignored `output/playwright/`; they contain only synthetic data.
- Existing session, CSRF, model/router, Matrix, schema and collation regression tests remain green. No real Google login, provider generation, Matrix verification or database write was performed for this repair.

## Boundary

This is local source and browser verification, not Published deployment evidence, full WCAG certification or completion of a blocked SDD unit. The proposed Matrix/MySQL storage redesign remains unimplemented. No production secret, database, Matrix store/device or HappyPro repository was changed.
