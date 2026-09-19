# Screen map

| Route | Purpose | Access |
|---|---|---|
| `/auth/sign-in` | Begin Google owner authentication | Public, rate limited |
| `/auth/google/callback` | Complete the fixed OAuth callback | Public protocol endpoint |
| `/consultation` | Submit, observe, stop, export, and delete | Authenticated owner |
| `/settings` | Select provider models and speed | Authenticated owner |
| `/instructions` | Edit encrypted versioned Markdown instructions | Authenticated owner |
| `/operations/runtime` | Connect runtimes and refresh capabilities | Authenticated owner |
| `/healthz` | Process liveness | Public, content free |

Primary navigation links Consultation, Models/Critic, AI subscriptions, and Instructions. Mutation endpoints are JSON APIs behind the same owner session and purpose-bound action tokens.
