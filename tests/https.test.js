import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const wrapper = join(root, 'enable_https.sh');
const remote = join(root, 'scripts/configure-https.sh');
const domain = '2048.1zkl.com';
const linuxTest = (name, fn) => test(name, {
  skip: process.platform === 'linux' ? false : 'requires Linux symlinks, flock and POSIX paths',
}, fn);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), '2048-https-'));
  const base = join(dir, '2048');
  const stage = join(base, '.2048-releases', 'release-test');
  const bin = join(dir, 'bin');
  const certRoot = join(dir, 'certs');
  const site = join(dir, '2048.conf');
  const log = join(dir, 'commands.log');
  const systemd = join(dir, 'systemd');
  const hooks = join(dir, 'renewal-hooks', 'deploy');
  mkdirSync(systemd, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(stage, 'index.html'), '<title>2048</title>');
  writeFileSync(join(stage, 'release.json'), '{"name":"release-test"}\n');
  symlinkSync(stage, join(base, 'current'));
  const original = 'server {\n  listen 80;\n  server_name 2048.yl0126.com;\n  root ' + base + '/current;\n}\n';
  writeFileSync(site, original);
  const mocks = {
    nginx: '#!/bin/sh\nif [ "$1" = -T ]; then printf "# configuration file %s:\\n" "$DEPLOY_TEST_NGINX_TARGET"; cat "$DEPLOY_TEST_NGINX_TARGET"; exit 0; fi\n[ "${DEPLOY_TEST_FAIL_NGINX:-}" != 1 ]\n',
    systemctl: '#!/bin/sh\necho "systemctl $*" >> "$DEPLOY_TEST_LOG"\nif [ "${DEPLOY_TEST_FAIL_TIMER:-}" = 1 ] && [ "$1" = enable ]; then exit 52; fi\nexit 0\n',
    certbot: '#!/bin/sh\necho "certbot $*" >> "$DEPLOY_TEST_LOG"\n[ "${DEPLOY_TEST_FAIL_CERTBOT:-}" != 1 ] || exit 42\nif [ "$1" = renew ] && [ "${DEPLOY_TEST_FAIL_RENEW:-}" = 1 ]; then exit 53; fi\nmkdir -p "$DEPLOY_TEST_CERT_ROOT/$DEPLOY_TEST_DOMAIN"\nprintf "mock fullchain" > "$DEPLOY_TEST_CERT_ROOT/$DEPLOY_TEST_DOMAIN/fullchain.pem"\nprintf "mock key" > "$DEPLOY_TEST_CERT_ROOT/$DEPLOY_TEST_DOMAIN/privkey.pem"\n',
    openssl: '#!/bin/sh\nexit 0\n',
    curl: '#!/bin/bash\nurl="${*: -1}"\nif [[ "$url" == http://127.0.0.1/.well-known/acme-challenge/* ]]; then\n  token="${url##*/}"\n  if [[ "${DEPLOY_TEST_FAIL_ACME:-}" == 1 ]]; then echo wrong-token; else cat "$DEPLOY_TEST_BASE/.well-known/acme-challenge/$token"; fi\nelif [[ "$url" == https://$DEPLOY_TEST_DOMAIN/release.json ]]; then\n  if [[ "${DEPLOY_TEST_FAIL_TLS:-}" == 1 ]]; then echo wrong-site; else cat "$DEPLOY_TEST_BASE/current/release.json"; fi\nelse\n  exit 22\nfi\n',
  };
  for (const [name, body] of Object.entries(mocks)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  function run(extra = {}) {
    return spawnSync('bash', [remote, base, domain, ''], {
      env: {
        ...process.env, PATH: bin + ':' + process.env.PATH,
        DEPLOY_TEST_NGINX_TARGET: site,
        DEPLOY_TEST_CERT_ROOT: certRoot,
        DEPLOY_TEST_DOMAIN: domain,
        DEPLOY_TEST_BASE: base,
        DEPLOY_TEST_LOG: log,
        DEPLOY_TEST_SYSTEMD_DIR: systemd,
        DEPLOY_TEST_RENEW_HOOK_DIR: hooks,
        ...extra,
      },
      encoding: 'utf8', timeout: 10000,
    });
  }
  return { dir, base, site, certRoot, log, systemd, hooks, original, run, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('HTTPS setup defaults to 2048.1zkl.com and dry-run never connects to production', () => {
  const script = readFileSync(wrapper, 'utf8');
  const deploy = readFileSync(join(root, 'release_deploy.sh'), 'utf8');
  const activate = readFileSync(join(root, 'scripts/activate-staged-release.sh'), 'utf8');
  assert.match(script, /DOMAIN="2048\.1zkl\.com"/);
  assert.match(deploy, /DOMAIN="2048\.1zkl\.com"/);
  assert.match(activate, /Refusing to replace existing HTTPS vhost/);
  const preview = spawnSync('bash', [wrapper, '--dryrun'], { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /No SSH connection/);
  for (const file of [wrapper, remote]) {
    const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  const invalid = spawnSync('bash', [wrapper, '--dryrun', '--domain', "evil.com'; rm -rf /"], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
});

linuxTest('HTTPS obtains a separate certificate, redirects public HTTP and preserves local health check', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const conf = readFileSync(f.site, 'utf8');
    assert.match(conf, /server_name 2048\.1zkl\.com/);
    assert.match(conf, /listen 443 ssl/);
    assert.match(conf, /ssl_certificate .*2048\.1zkl\.com\/fullchain\.pem/);
    assert.match(conf, /location \^~ \/\.well-known\/acme-challenge\//);
    assert.match(conf, /location = \/release\.json/);
    assert.match(conf, /allow 127\.0\.0\.1/);
    assert.match(conf, /return 308 https:\/\/\$host\$request_uri/);
    assert.match(readFileSync(f.log, 'utf8'), /certbot certonly .*--webroot/);
    assert.ok(existsSync(join(f.certRoot, domain, 'fullchain.pem')));
    const second = f.run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already active/);
    const log = readFileSync(f.log, 'utf8');
    assert.equal((log.match(/^certbot certonly /gm) ?? []).length, 1, 'certificate is issued only once');
    assert.equal((log.match(/^certbot renew --cert-name /gm) ?? []).length, 2, 'renewal dry-run verified on first setup and rerun');
    assert.match(log, /systemctl enable --now 2048-cert-renew\.timer/);
    assert.match(log, /systemctl is-active --quiet 2048-cert-renew\.timer/);
  } finally { f.cleanup(); }
});

linuxTest('failed ACME routing and failed Certbot both roll back the existing Nginx config', () => {
  for (const injected of [{ DEPLOY_TEST_FAIL_ACME: '1' }, { DEPLOY_TEST_FAIL_CERTBOT: '1' }]) {
    const f = fixture();
    try {
      const result = f.run(injected);
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(f.site, 'utf8'), f.original);
      assert.match(result.stderr, /previous 2048 Nginx config restored/);
    } finally { f.cleanup(); }
  }
});

linuxTest('an incorrect TLS response cannot activate HTTPS and restores prior HTTP config', () => {
  const f = fixture();
  try {
    const result = f.run({ DEPLOY_TEST_FAIL_TLS: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.site, 'utf8'), f.original);
    assert.match(result.stderr, /returned another application or release/);
  } finally { f.cleanup(); }
});

linuxTest('an existing manually managed TLS vhost cannot be overwritten', () => {
  const f = fixture();
  try {
    const conf = readFileSync(f.site, 'utf8') + '  listen 443 ssl;\n';
    writeFileSync(f.site, conf);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Existing TLS configuration/);
    assert.equal(readFileSync(f.site, 'utf8'), conf);
  } finally { f.cleanup(); }
});


linuxTest('automatic renewal installs isolated twice-daily timer and successful-cert-only nginx hook', () => {
  const f = fixture();
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    const service = readFileSync(join(f.systemd, '2048-cert-renew.service'), 'utf8');
    const timer = readFileSync(join(f.systemd, '2048-cert-renew.timer'), 'utf8');
    const hookPath = join(f.hooks, '2048-nginx-reload.sh');
    const hook = readFileSync(hookPath, 'utf8');
    assert.match(service, /certbot renew --cert-name 2048\.1zkl\.com --non-interactive --quiet/);
    assert.match(timer, /OnCalendar=\*-\*-\* 03,15:00:00/);
    assert.match(timer, /Persistent=true/);
    assert.match(hook, /RENEWED_LINEAGE/);
    const firstLog = readFileSync(f.log, 'utf8');
    assert.match(firstLog, /certbot renew --cert-name 2048\.1zkl\.com --dry-run --non-interactive/);
    const other = spawnSync('bash', [hookPath], {
      env: { ...process.env, PATH: f.bin + ':' + process.env.PATH, DEPLOY_TEST_LOG: f.log,
        RENEWED_LINEAGE: join(f.certRoot, 'another.example.org') }, encoding: 'utf8',
    });
    assert.equal(other.status, 0, other.stderr);
    assert.equal(readFileSync(f.log, 'utf8'), firstLog, 'unrelated renewal never reloads nginx');
    const own = spawnSync('bash', [hookPath], {
      env: { ...process.env, PATH: f.bin + ':' + process.env.PATH, DEPLOY_TEST_LOG: f.log,
        RENEWED_LINEAGE: join(f.certRoot, domain) }, encoding: 'utf8',
    });
    assert.equal(own.status, 0, own.stderr);
    assert.match(readFileSync(f.log, 'utf8'), /systemctl reload nginx/);
  } finally { f.cleanup(); }
});

linuxTest('failed renewal dry-run restores prior nginx and removes newly installed timer/hook', () => {
  const f = fixture();
  try {
    const failed = f.run({ DEPLOY_TEST_FAIL_RENEW: '1' });
    assert.notEqual(failed.status, 0, 'dry-run failure must block HTTPS activation');
    assert.equal(readFileSync(f.site, 'utf8'), f.original);
    assert.equal(existsSync(join(f.systemd, '2048-cert-renew.service')), false);
    assert.equal(existsSync(join(f.systemd, '2048-cert-renew.timer')), false);
    assert.equal(existsSync(join(f.hooks, '2048-nginx-reload.sh')), false);
    assert.match(readFileSync(f.log, 'utf8'), /systemctl disable --now 2048-cert-renew\.timer/);
    assert.match(failed.stderr, /renewal installation or dry-run failed/);
  } finally { f.cleanup(); }
});

linuxTest('timer enable failure aborts HTTPS activation and restores old configs', () => {
  const f = fixture();
  try {
    const failed = f.run({ DEPLOY_TEST_FAIL_TIMER: '1' });
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(f.site, 'utf8'), f.original);
    assert.equal(existsSync(join(f.systemd, '2048-cert-renew.timer')), false);
    assert.equal(existsSync(join(f.hooks, '2048-nginx-reload.sh')), false);
    assert.match(failed.stderr, /renewal installation or dry-run failed/);
  } finally { f.cleanup(); }
});
