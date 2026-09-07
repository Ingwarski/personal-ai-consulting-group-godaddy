# GoDaddy support request — DRAFT, NOT SENT

Subject: Published persistent assets directory unavailable after deployment — project wy2v0putg6

Please investigate persistent filesystem availability for the Published variant of Node.js Hosting project `wy2v0putg6` (Personal AI Consulting Group), Europe, Node.js 22. Published origin: `https://wy2v0putg6.c35.airoapp.ai`.

The application previously used its existing Matrix E2EE state under:

`/app/public/assets/.personal-consultant-matrix-v1/crypto-store`

On 2026-09-07 UTC, the application was already reporting an unavailable store before our latest deployment. We added an authenticated-owner-only, read-only filesystem metadata diagnostic to identify the failure. The current Published source revision is `252815600a84922e74d5b650a07687af1c04fa5d`. Its fresh live result is:

```json
{
  "reason": "store_binding_missing",
  "storagePaths": {
    "application": "directory",
    "public": "directory",
    "assets": "directory",
    "privateRoot": "missing",
    "cryptoStore": "not_checked",
    "deviceBinding": "not_checked",
    "cryptoDatabase": "not_checked",
    "stateDatabase": "not_checked",
    "provisioningIntent": "not_checked"
  }
}
```

`privateRoot` is the exact `/app/public/assets/.personal-consultant-matrix-v1` path. `not_checked` means the diagnostic deliberately did not traverse descendants of a missing ancestor; it does not independently establish whether underlying storage still contains those files. A controlled Published restart also retained the missing-store error. The application is HTTP-live, and MySQL-backed owner authentication works. We have not determined whether this is a mount/snapshot/publication issue or actual data loss.

The app build only copies two fixed UI assets into `/app/dist/assets`; it does not remove or rewrite this private directory. The GoDaddy update dialog states that files, database and secrets are retained. Published runtime logs at `2026-09-07T23:24:34Z` said `Skipping cleanup (cleanAppDirBeforeExtract: false)`, followed by extraction into `/app` and normal startup on Node.js v22.23.2. No native crypto rebuild, database wipe, device reset, store creation or deletion was performed during this investigation.

Your [deployment documentation](https://www.godaddy.com/en-ca/help/deploy-my-cursor-or-claude-app-with-godaddy-nodejs-hosting-42908) identifies `/public/assets/` for files that must persist between deployments.

Please check and report:

1. Which persistent volume/snapshot is mounted at Published `/app/public/assets`, and whether it is the same original volume used by the previously working deployment.
2. Whether dot-prefixed directories beneath `public/assets` are preserved during GitHub code pull, publish, restart and any asset snapshot/synchronization process.
3. Whether the original `.personal-consultant-matrix-v1` directory and its original encrypted SQLite files/device binding still exist in another retained mount or backup. Report availability and timestamps only—do not send keys or file contents.
4. The non-destructive recovery path and, if restoration is needed, its precise snapshot/rollback point and expected impact before any restoration is performed.

Do not reset/create a Matrix device, create an empty store, replace or delete existing crypto files, copy Preview state into Published, change secrets, or wipe/restore MySQL. Do not touch another project or domain. This request is for diagnosis and an original-data recovery plan, not permission to reset or roll back state.

No credentials, message contents or encryption keys are included in this request.
