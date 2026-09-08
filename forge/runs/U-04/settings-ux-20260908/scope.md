# Settings usability repair — 2026-09-08

## Authority and SDD basis

User request: “Make all settings panels UX friendly - some of it have thinly buttons”.
This is a scoped implementation correction to U-04/SUR-02 and existing Matrix setup utility pages, following the approved design brief's system typography, utility hierarchy, visible focus, responsive controls and adjacent feedback. Tests verify these requirements; they do not replace SDD. The proposed MySQL Matrix storage redesign is not adopted or implemented here.

## Acceptance criteria recorded before implementation

- Login, runtime/provider setup, Matrix setup, schema/collation utilities, no-catalog settings and model settings load the shared stylesheet.
- Buttons and selects have at least 48 CSS px height at default text size; long labels wrap, with space between actions and visible keyboard focus.
- Preserve the existing palette/system font, independent provider settings, form actions, tokens, hidden/disabled states, status feedback and all authorization boundaries.
- Group provider actions separately; make navigation and session actions understandable without adding a dashboard or nested decorative cards.
- Verify 320/390/430/768/1280/1440 widths, expanded text, keyboard access and representative error/disabled/loading states using synthetic local data. No real login, database mutation, Matrix verification or model call is needed for visual testing.
- Run existing regression checks; distinguish local verification, pushed source and Published evidence. Do not mark a development unit or live acceptance complete from this repair alone.

## Exclusions

No authentication redesign, MFA, storage migration, Matrix device reset, database cleanup, new hosting, frozen prototype changes, or HappyPro repository changes. Production state and secrets are not test fixtures.
