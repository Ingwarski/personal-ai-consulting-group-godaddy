#!/usr/bin/env node
/** Opt-in synthetic MySQL only. Never connects to an existing database. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const marker = 'personal-consultant-synthetic-mysql-v1';
const [action, configPath, ...tail] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) fail(`Synthetic MySQL command failed: ${binary.split('/').at(-1)} (details retained in private runtime directory).`);
  return result.stdout;
}
function privateWrite(path, value) { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); }
function load(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.marker !== marker || !config.database.match(/^pc_matrix_test_[a-f0-9]{16}$/) || config.host !== '127.0.0.1') fail('Not a synthetic Matrix MySQL runtime configuration.');
  if (resolve(path) !== join(config.directory, 'connection.json') || !config.directory.startsWith(resolve(tmpdir()) + '/pc-matrix-mysql-')) fail('Runtime is not in its private temporary directory.');
  return config;
}
function client(config, sql) {
  return run(join(config.basedir, 'bin/mysql'), [`--defaults-extra-file=${join(config.directory, 'admin.cnf')}`, '--protocol=SOCKET', `--socket=${config.socket}`], { input: sql });
}
async function waitReady(config) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { client(config, 'SELECT 1;'); return; } catch { await delay(100); }
  }
  fail(`Synthetic MySQL did not start; inspect ${join(config.directory, 'mysql.log')}.`);
}
async function launch(config, bootstrap) {
  const args = ['--no-defaults', `--basedir=${config.basedir}`, `--datadir=${join(config.directory, 'data')}`, `--socket=${config.socket}`, `--pid-file=${join(config.directory, 'mysql.pid')}`, `--log-error=${join(config.directory, 'mysql.log')}`, '--mysqlx=OFF', '--skip-log-bin', '--innodb-buffer-pool-size=32M', '--max-connections=20'];
  if (bootstrap) args.push('--skip-networking');
  else args.push('--bind-address=127.0.0.1', `--port=${config.port}`, '--require-secure-transport=ON', `--ssl-ca=${config.caFile}`, `--ssl-cert=${join(config.directory, 'server-cert.pem')}`, `--ssl-key=${join(config.directory, 'server-key.pem')}`);
  const child = spawn(join(config.basedir, 'bin/mysqld'), args, { detached: true, stdio: 'ignore' });
  child.unref();
  child.on('error', () => {});
  await waitReady(config);
}
async function shutdown(config) {
  client(config, 'SHUTDOWN;');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!existsSync(join(config.directory, 'mysql.pid'))) return;
    await delay(100);
  }
  fail('Synthetic MySQL did not finish shutdown; no process was force-killed.');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}
async function start() {
  if (configPath || tail.length) fail('Usage: node scripts/test-matrix-mysql-runtime.mjs start');
  const fallback = '/Applications/Local.app/Contents/Resources/extraResources/lightning-services/mysql-8.0.35+4/bin/darwin-arm64';
  const basedir = process.env.MYSQL_BASEDIR || fallback;
  if (!existsSync(join(basedir, 'bin/mysqld'))) fail('Set MYSQL_BASEDIR to an installed genuine MySQL distribution. This harness does not install software or use an existing server.');
  const version = run(join(basedir, 'bin/mysqld'), ['--version']).trim();
  if (!version.includes('MySQL Community Server') || !/Ver\s+8\./.test(version)) fail('This harness requires genuine MySQL Community Server 8.x.');
  const directory = mkdtempSync(join(tmpdir(), 'pc-matrix-mysql-'));
  chmodSync(directory, 0o700);
  const config = { marker, directory, basedir, host: '127.0.0.1', port: await freePort(), database: `pc_matrix_test_${randomBytes(8).toString('hex')}`, user: 'pc_matrix_test', password: randomBytes(32).toString('hex'), caFile: join(directory, 'ca.pem'), socket: join(directory, 'mysql.sock'), version };
  const rootPassword = randomBytes(32).toString('hex');
  privateWrite(join(directory, 'connection.json'), JSON.stringify(config, null, 2));
  privateWrite(join(directory, 'admin.cnf'), '[client]\nuser=root\n');
  mkdirSync(join(directory, 'data'), { mode: 0o700 });
  run(join(basedir, 'bin/mysqld'), ['--no-defaults', '--initialize-insecure', `--basedir=${basedir}`, `--datadir=${join(directory, 'data')}`, `--log-error=${join(directory, 'mysql.log')}`]);
  // Certificate's SAN binds the same loopback IP used by the strict TLS client.
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Matrix Synthetic MySQL Test CA', '-keyout', join(directory, 'ca-key.pem'), '-out', config.caFile]);
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', join(directory, 'server-key.pem'), '-out', join(directory, 'server.csr')]);
  privateWrite(join(directory, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  run('openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', config.caFile, '-CAkey', join(directory, 'ca-key.pem'), '-CAcreateserial', '-days', '2', '-extfile', join(directory, 'server.ext'), '-out', join(directory, 'server-cert.pem')]);
  chmodSync(join(directory, 'ca-key.pem'), 0o600); chmodSync(join(directory, 'server-key.pem'), 0o600);
  try {
    await launch(config, true);
    client(config, `CREATE DATABASE ${config.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin; CREATE USER '${config.user}'@'127.0.0.1' IDENTIFIED BY '${config.password}' REQUIRE SSL; GRANT ALL PRIVILEGES ON ${config.database}.* TO '${config.user}'@'127.0.0.1'; ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';`);
    privateWrite(join(directory, 'admin.cnf'), `[client]\nuser=root\npassword=${rootPassword}\n`);
    await shutdown(config);
    await launch(config, false);
    privateWrite(join(directory, 'client.cnf'), `[client]\nuser=${config.user}\npassword=${config.password}\nhost=127.0.0.1\nport=${config.port}\nssl-mode=VERIFY_IDENTITY\nssl-ca=${config.caFile}\n`);
    run(join(basedir, 'bin/mysql'), [`--defaults-extra-file=${join(directory, 'client.cnf')}`, '--protocol=TCP', config.database, '-e', 'SELECT VERSION(); SHOW SESSION STATUS LIKE "Ssl_cipher";']);
    console.log(join(directory, 'connection.json'));
  } catch (error) {
    try { await shutdown(config); } catch { /* Preserve failure evidence, never kill an unrelated process. */ }
    throw error;
  }
}
try {
  if (action === 'start') await start();
  else if (action === 'stop') { const config = load(configPath); await shutdown(config); console.log(`Synthetic MySQL stopped. Test data retained at ${config.directory}; no production data was touched.`); }
  else if (action === 'restart') { const config = load(configPath); await shutdown(config); await launch(config, false); console.log('Synthetic MySQL restarted with the same synthetic data and TLS identity.'); }
  else if (action === 'check') {
    const config = load(configPath);
    const result = run(join(config.basedir, 'bin/mysql'), [`--defaults-extra-file=${join(config.directory, 'client.cnf')}`, '--protocol=TCP', config.database, '-e', 'SELECT VERSION(); SHOW SESSION STATUS LIKE "Ssl_cipher"; SELECT @@require_secure_transport;']);
    console.log(result.trim());
  }
  else if (action === 'run') {
    const config = load(configPath);
    const args = tail[0] === '--' ? tail.slice(1) : tail;
    if (!args.length) fail('Usage: ... run <private connection.json> -- <test command> [args]');
    const env = { ...process.env, MATRIX_MYSQL_TEST_CONFIG: resolve(configPath), DB_HOST: config.host, DB_PORT: String(config.port), DB_NAME: config.database, DB_USER: config.user, DB_PASSWORD: config.password, DB_SSL_CA_FILE: config.caFile };
    const child = spawn(args[0], args.slice(1), { env, stdio: 'inherit' });
    child.on('error', () => { console.error('Could not start synthetic MySQL test command.'); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
  } else fail('Usage: test-matrix-mysql-runtime.mjs start | run <config> -- <command> | check <config> | restart <config> | stop <config>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
