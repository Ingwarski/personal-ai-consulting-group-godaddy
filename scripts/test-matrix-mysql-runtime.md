# Opt-in isolated real-MySQL Matrix tests

This harness uses **genuine MySQL Community Server 8.x**, not SQLite or a mocked
driver. It never connects to an existing database or launches an installed GUI
application. Every `start` initializes its own temporary data directory, random
database name, random credentials, and two-day synthetic CA/server certificate.
Only `127.0.0.1` is bound. TLS is mandatory and the native client verifies the
server identity against the synthetic CA. This is a local test dependency, not a
production hosting option or evidence about Published.

## Start

Use an already available unpacked MySQL distribution:

```sh
MYSQL_BASEDIR=/path/to/mysql node scripts/test-matrix-mysql-runtime.mjs start
```

`MYSQL_BASEDIR` contains `bin/mysqld` and `bin/mysql`. On macOS the harness can
discover the specific MySQL 8.0.35 ARM64 distribution bundled with Local.app;
this uses its binaries only and never touches Local.app's databases. No software
installation, global services, Docker account, external host or paid service is
required. OpenSSL and Node.js must be available.

The command prints only the path to a private `connection.json`. The runtime
directory is mode 0700; config files and private keys are mode 0600. Do not paste
config contents into logs, source control, or messages.

## Run the integration tests

Replace `<config>` with the returned private config path:

```sh
node scripts/test-matrix-mysql-runtime.mjs check <config>
node scripts/test-matrix-mysql-runtime.mjs run <config> -- cargo test --manifest-path native/matrix-sidecar/Cargo.toml -p personal-consultant-matrix-mysql-store --features integration-tests -- --include-ignored --test-threads=1
node scripts/test-matrix-mysql-runtime.mjs run <config> -- cargo test --manifest-path native/matrix-sidecar/Cargo.toml -p personal-consultant-matrix-sidecar -- --include-ignored --test-threads=1
```

`run` supplies `MATRIX_MYSQL_TEST_CONFIG`, `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD` and `DB_SSL_CA_FILE` only to the specified subprocess.
The test executable must explicitly opt into real-MySQL tests; ordinary tests
must not read a user's production configuration. Schema installation is a test
action against this generated database, not implicit application startup DDL.
Production `Backend::connect` must retain certificate and hostname verification.

The harness alone does **not** prove adapter behavior. SDK integration, atomic
batch/fencing, wrong-key/context rejection, migration, crash and replay test
results must be recorded separately. A skipped integration test is not a pass.

## Restart and finish

```sh
node scripts/test-matrix-mysql-runtime.mjs restart <config>
node scripts/test-matrix-mysql-runtime.mjs stop <config>
```

`restart` performs a graceful database stop/start preserving synthetic data;
it is not a forced-crash test. `stop` requests shutdown through the private Unix
socket; it never kills an arbitrary PID or other MySQL process. Test data is
retained for failure inspection. After the test owner is done, move the exact
printed runtime directory to Trash. Never target a parent temporary directory,
workspace, existing database, or unresolved wildcard for deletion.

Evidence from the initial harness check: MySQL Community 8.0.35, TLS
`TLS_AES_256_GCM_SHA384`, native `VERIFY_IDENTITY`, server secure transport
required. This identifies the local test runtime only, not GoDaddy's database
version or TLS behavior.
