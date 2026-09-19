# Definition of done

A change is complete when:

1. The intended behavior is implemented in the current architecture and obsolete paths are removed.
2. Type checking, build, unit tests, environment checks, and relevant real-MySQL integration tests pass.
3. Security boundaries fail closed under missing configuration, stale revisions, concurrent requests, restart, tampering, and unauthorized mutation.
4. Confidential plaintext is absent from persistent records that promise encryption or hash-only storage.
5. Documentation describes the current code and contains no superseded runtime instructions.
6. The final Git tree and all published refs contain no prohibited retired-component paths or content.
7. Deployment claims are made only after the deployed revision is exercised with synthetic evidence.

Passing repository checks does not prove live authentication, provider availability, key custody, backup recovery, host networking, or deployment readiness. Those require environment-specific evidence.
