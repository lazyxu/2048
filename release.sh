#!/usr/bin/env bash
set -euo pipefail

# Like yl/release.sh, build a self-contained, versioned release before SSH upload.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

npm run check
npm test
npm run build

version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid package version' >&2; exit 1; }
commit="$(git rev-parse --verify HEAD 2>/dev/null || true)"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || commit="unknown"
short="${commit:0:8}"
now="$(date -u +%Y%m%dT%H%M%SZ)"
name="release-${version}-${now}-${short}"
out="releases/$name"
[[ ! -e "$out" ]] || { echo "Release already exists: $out" >&2; exit 1; }
mkdir -p "$out"
cp -R dist/. "$out/"

# Give each deployment its own cache namespace so installed iOS PWAs receive updates.
RELEASE_NAME="$name" GIT_COMMIT="$commit" RELEASE_TIME="$now" node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const dir = `releases/${process.env.RELEASE_NAME}`;
const sw = `${dir}/sw.js`;
const original = readFileSync(sw, 'utf8');
const needle = 'const CACHE_NAME = `${CACHE_PREFIX}v1`;';
if (!original.includes(needle)) throw Error('Expected service-worker cache declaration not found');
writeFileSync(sw, original.replace(needle, `const CACHE_NAME = \`\${CACHE_PREFIX}v1-${process.env.RELEASE_NAME}\`;`));
writeFileSync(`${dir}/release.json`, JSON.stringify({
  name: process.env.RELEASE_NAME,
  commit: process.env.GIT_COMMIT,
  built_at_utc: process.env.RELEASE_TIME,
  app: 'lazyxu/2048',
}, null, 2) + '\n');
JS

# Remote activation verifies this file BEFORE touching the serving symlink.
(cd "$out" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS)
printf '%s\n' "$name" > releases/.latest-release
printf 'Build complete: %s\n' "$out"
