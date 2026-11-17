import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const activation = join(root, 'scripts/activate-staged-release.sh');
const template = readFileSync(join(root, 'deploy/nginx/2048.conf.template'), 'utf8');

// This harness exercises Linux deployment primitives: absolute POSIX paths,
// flock, GNU mv -T, and atomic symbolic-link replacement. Windows Node.js
// produces Win32 temp paths, and Git Bash may emulate 'ln -s' by copying.
// Keep the production path validation intact and run all fault tests on Linux CI.
const linuxDeploymentTest = (name, fn) => test(name, {
  skip: process.platform === 'linux'
    ? false
    : 'Linux-only integration: requires POSIX paths, flock and real symlinks (covered in Ubuntu CI)',
}, fn);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), '2048-deploy-'));
  const base = join(dir, '2048');
  mkdirSync(base, { recursive: true });
  const nginx = join(dir, '2048.conf');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'commands.log');
  for (const [name, body] of [
    ['nginx', '#!/bin/sh\nprintf "nginx %s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n[ "${DEPLOY_TEST_FAIL_NGINX:-}" != 1 ]'],
    ['systemctl', '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n[ "${DEPLOY_TEST_FAIL_RELOAD:-}" != 1 ]'],
    ['curl', '#!/bin/sh\n[ "${DEPLOY_TEST_FAIL_HEALTH:-}" != 1 ] || exit 22\nprintf "<!doctype html><title>2048 - Test</title>"'],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, body + '\n'); chmodSync(path, 0o755);
  }
  function stage(suffix) {
    const path = join(base, '.2048-releases', `release-${suffix}`);
    mkdirSync(join(path, 'icons'), { recursive: true });
    const files = {
      'index.html': '<!DOCTYPE html><title>2048</title>',
      'sw.js': `const VERSION = '${suffix}';`,
      'manifest.webmanifest': '{"name":"2048"}',
      'icons/apple-touch-icon.png': 'fake-png',
      'release.json': JSON.stringify({ name: suffix }),
    };
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(path, name), contents);
    const hashes = Object.entries(files).map(([name, contents]) => `${createHash('sha256').update(contents).digest('hex')}  ./${name}`).join('\n');
    writeFileSync(join(path, 'SHA256SUMS'), hashes + '\n');
    writeFileSync(join(path, '.nginx-new.conf'), template.replaceAll('__DOMAIN__', '2048.example.com').replaceAll('__WEB_ROOT__', `${base}/current`));
    return path;
  }
  function activate(target, mode='auto', extra={}) {
    return spawnSync('bash', [activation, base, target, '2048.example.com', mode], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_TEST_NGINX_TARGET: nginx, DEPLOY_TEST_LOG: log, ...extra },
      encoding: 'utf8', timeout: 5000,
    });
  }
  return { dir, base, nginx, log, stage, activate, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('manual SSH deployment replaces Pages, with independent Nginx hostname and paths', () => {
  const workflows = readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8');
  assert.doesNotMatch(workflows, /deploy-pages|pages: write|github-pages/);
  assert.match(workflows, /release_deploy\.sh --dryrun/);
  assert.match(template, /server_name __DOMAIN__/);
  assert.match(template, /root __WEB_ROOT__/);
  assert.doesNotMatch(template, /yl0126\.conf|proxy_pass/);
  assert.match(readFileSync(join(root, 'release_deploy.sh'), 'utf8'), /REMOTE_BASE="\/2048"/);
  for (const file of ['release.sh', 'release_deploy.sh', 'scripts/activate-staged-release.sh']) {
    const result = spawnSync('bash', ['-n', join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

linuxDeploymentTest('first release installs isolated Nginx vhost, then updates only current symlink', () => {
  const f = fixture();
  try {
    const first = f.stage('first');
    const res = f.activate(first);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readlinkSync(join(f.base, 'current')), first);
    assert.match(readFileSync(f.nginx, 'utf8'), /server_name 2048\.example\.com/);
    writeFileSync(f.nginx, 'custom TLS config preserved\n');
    const second = f.stage('second');
    const update = f.activate(second);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(readlinkSync(join(f.base, 'current')), second);
    assert.equal(readFileSync(f.nginx, 'utf8'), 'custom TLS config preserved\n');
    assert.equal(existsSync(first), true);
  } finally { f.cleanup(); }
});

linuxDeploymentTest('checksum failures block activation before changing live release', () => {
  const f = fixture();
  try {
    const first = f.stage('first');
    assert.equal(f.activate(first).status, 0);
    const broken = f.stage('broken');
    writeFileSync(join(broken, 'index.html'), 'tampered!');
    const update = f.activate(broken);
    assert.notEqual(update.status, 0);
    assert.equal(readlinkSync(join(f.base, 'current')), first);
  } finally { f.cleanup(); }
});

linuxDeploymentTest('Nginx syntax failure restores previous config and release pointer', () => {
  const f = fixture();
  try {
    const first = f.stage('first');
    assert.equal(f.activate(first).status, 0);
    const before = readFileSync(f.nginx, 'utf8');
    const second = f.stage('second');
    const update = f.activate(second, 'replace', { DEPLOY_TEST_FAIL_NGINX: '1' });
    assert.notEqual(update.status, 0);
    assert.equal(readlinkSync(join(f.base, 'current')), first);
    assert.equal(readFileSync(f.nginx, 'utf8'), before);
  } finally { f.cleanup(); }
});

linuxDeploymentTest('Nginx reload failure rolls back symlink and Nginx configuration', () => {
  const f = fixture();
  try {
    const first = f.stage('first');
    assert.equal(f.activate(first).status, 0);
    const before = readFileSync(f.nginx, 'utf8');
    const second = f.stage('second');
    const update = f.activate(second, 'replace', { DEPLOY_TEST_FAIL_RELOAD: '1' });
    assert.notEqual(update.status, 0);
    assert.equal(readlinkSync(join(f.base, 'current')), first);
    assert.equal(readFileSync(f.nginx, 'utf8'), before);
  } finally { f.cleanup(); }
});

linuxDeploymentTest('HTTP health-check failure rolls back an otherwise valid activation', () => {
  const f = fixture();
  try {
    const first = f.stage('first');
    assert.equal(f.activate(first).status, 0);
    const second = f.stage('second');
    const update = f.activate(second, 'replace', { DEPLOY_TEST_FAIL_HEALTH: '1' });
    assert.notEqual(update.status, 0);
    assert.equal(readlinkSync(join(f.base, 'current')), first);
  } finally { f.cleanup(); }
});
