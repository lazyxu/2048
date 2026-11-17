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
  mkdirSync(stage, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(stage, 'index.html'), '<title>2048</title>');
  writeFileSync(join(stage, 'release.json'), '{"name":"release-test"}\n');
  symlinkSync(stage, join(base, 'current'));
  const original = 'server {\n  listen 80;\n  server_name 2048.yl0126.com;\n  root ' + base + '/current;\n}\n';
  writeFileSync(site, original);
  const mocks = {
    nginx: '#!/bin/sh\nif [ "$1" = -T ]; then printf "# configuration file %s:\\n" "$DEPLOY_TEST_NGINX_TARGET"; cat "$DEPLOY_TEST_NGINX_TARGET"; exit 0; fi\n[ "${DEPLOY_TEST_FAIL_NGINX:-}" != 1 ]\n',
    systemctl: '#!/bin/sh\necho "systemctl $*" >> "$DEPLOY_TEST_LOG"\nexit 0\n',
    certbot: '#!/bin/sh\necho "certbot $*" >> "$DEPLOY_TEST_LOG"\n[ "${DEPLOY_TEST_FAIL_CERTBOT:-}" != 1 ] || exit 42\nmkdir -p "$DEPLOY_TEST_CERT_ROOT/$DEPLOY_TEST_DOMAIN"\nprintf "mock fullchain" > "$DEPLOY_TEST_CERT_ROOT/$DEPLOY_TEST_DOMAIN/fullchain.pem"\nprintf "mock key" > "$DEPLOY_TEST_CERT_ROOT/$DEPLOY_TEST_DOMAIN/privkey.pem"\n',
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
        ...extra,
      },
      encoding: 'utf8', timeout: 10000,
    });
  }
  return { dir, base, site, certRoot, log, original, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    assert.equal(readFileSync(f.log, 'utf8').split('certbot').length - 1, 1);
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
