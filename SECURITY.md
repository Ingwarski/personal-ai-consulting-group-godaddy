# Security policy

## Supported code

Only the current default branch is supported. Do not report findings against deleted historical components unless the same behavior exists in the current tree.

## Reporting

Report a suspected vulnerability privately to the repository owner. Include the affected revision, route or module, preconditions, impact, and a minimal reproduction using synthetic data. Do not include real credentials, owner data, provider tokens, archive plaintext, or production database contents.

## Safe testing boundary

Use isolated local or CI fixtures. Do not contact production services, attempt account takeover, weaken authentication, broaden permissions, or run destructive database operations without explicit authorization.

## Secrets

Never commit or send passwords, access tokens, OAuth codes, private keys, payment-card data, government identifiers, or medical data. Rotate any credential that may have entered Git, logs, an issue, a prompt, or an exported archive.
