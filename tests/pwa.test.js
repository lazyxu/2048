import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

test('manifest uses an installable standalone app and PNG icons', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    assert.ok(statSync(join(root, icon.src)).size > 1000);
  }
  assert.ok(statSync(join(root, 'icons/apple-touch-icon.png')).size > 1000);
});

test('app shell assets are present in the offline cache list', () => {
  const worker = read('sw.js');
  for (const path of ['index.html', 'styles.css', 'src/app.js', 'src/game.js', 'manifest.webmanifest', 'icons/apple-touch-icon.png']) {
    assert.ok(worker.includes(`'./${path}'`), `${path} is not cached for offline`);
  }
  assert.match(read('index.html'), /apple-touch-icon/);
  assert.match(read('styles.css'), /touch-action: none/);
});


test('service worker activation only deletes this app\'s old caches', async () => {
  const handlers = {};
  const deleted = [];
  const fakeCaches = {
    keys: async () => ['2048-ios-pwa-v0', '2048-ios-pwa-v1', 'another-pwa-v9'],
    delete: async key => { deleted.push(key); return true; },
  };
  const fakeSelf = {
    addEventListener: (type, callback) => { handlers[type] = callback; },
    clients: { claim: async () => {} },
  };
  runInNewContext(read('sw.js'), { self: fakeSelf, caches: fakeCaches, Promise });
  let activation;
  handlers.activate({ waitUntil: promise => { activation = promise; } });
  await activation;
  assert.deepEqual(deleted, ['2048-ios-pwa-v0']);
});
