#!/usr/bin/env bash
set -euo pipefail

# Executed on the SSH host. No Node/MySQL/PM2: 2048 is entirely static.
BASE="${1:?base required}"
STAGE="${2:?stage required}"
DOMAIN="${3:?domain required}"
NGINX_MODE="${4:-auto}"
NGINX_TARGET="${DEPLOY_TEST_NGINX_TARGET:-/etc/nginx/conf.d/2048.conf}"

[[ "$BASE" =~ ^/[a-zA-Z0-9_/-]+$ && "$BASE" != / && "$BASE" != *..* && "$BASE" != /yl0126 && "$BASE" != /yl0126/* && "$STAGE" == "$BASE"/.2048-releases/release-* && "$STAGE" != *..* && "$STAGE" != *//* && "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ && "$NGINX_MODE" =~ ^(auto|replace|skip)$ ]] || { echo 'Invalid deployment arguments' >&2; exit 2; }
[[ -d "$STAGE" && -s "$STAGE/index.html" && -s "$STAGE/sw.js" && -s "$STAGE/manifest.webmanifest" && -s "$STAGE/icons/apple-touch-icon.png" && -s "$STAGE/release.json" && -s "$STAGE/SHA256SUMS" && -s "$STAGE/.nginx-new.conf" ]] || { echo 'Staged release incomplete' >&2; exit 2; }
(cd "$STAGE" && sha256sum --check --status SHA256SUMS) || { echo 'Staged release checksum mismatch' >&2; exit 2; }

mkdir -p "$BASE"
exec 9>"$BASE/.deploy.lock"
flock -n 9 || { echo 'Another deployment is active' >&2; exit 2; }

old_target=""
if [[ -L "$BASE/current" ]]; then
  old_target="$(readlink "$BASE/current")"
  [[ "$old_target" == "$BASE"/.2048-releases/release-* && -s "$old_target/index.html" ]] || { echo 'Unexpected current symlink; refusing overwrite' >&2; exit 2; }
elif [[ -e "$BASE/current" ]]; then
  echo 'Current deployment is not a symlink; refusing overwrite' >&2
  exit 2
fi

priv=()
if [[ "$(id -u)" != 0 && -z "${DEPLOY_TEST_NGINX_TARGET:-}" ]]; then priv=(sudo -n); fi
nginx_changed=0
nginx_existed=0
switched=0
nginx_backup="$STAGE/.nginx-previous.conf"

# Nginx can validate its syntax even if our vhost is absent from the active includes.
# Select a truly enabled site directory; do not touch other applications.
if [[ "$NGINX_MODE" != skip && -z "${DEPLOY_TEST_NGINX_TARGET:-}" ]]; then
  nginx_dump="$("${priv[@]}" nginx -T 2>&1)" || {
    echo 'Cannot inspect active Nginx configuration (nginx -T failed)' >&2
    exit 2
  }
  if grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/conf[.]d/\*([.]conf)?[[:space:]]*;' <<< "$nginx_dump"; then
    NGINX_TARGET='/etc/nginx/conf.d/2048.conf'
  elif grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/sites-enabled/\*([.]conf)?[[:space:]]*;' <<< "$nginx_dump"; then
    NGINX_TARGET='/etc/nginx/sites-enabled/2048.conf'
  else
    echo 'No supported Nginx site include is active (conf.d/*.conf or sites-enabled/*).' >&2
    echo 'Inspect sudo nginx -T; configure a dedicated 2048 vhost before deploying.' >&2
    exit 2
  fi
  echo "Selected active Nginx site path: $NGINX_TARGET"
fi

rollback() {
  local result="$?"
  trap - ERR
  set +e
  if [[ "$switched" == 1 ]]; then
    rm -f "$BASE/current"
    if [[ -n "$old_target" ]]; then
      ln -s "$old_target" "$BASE/.current-rollback-$$"
      mv -Tf "$BASE/.current-rollback-$$" "$BASE/current"
    fi
  fi
  if [[ "$nginx_changed" == 1 ]]; then
    if [[ "$nginx_existed" == 1 ]]; then
      "${priv[@]}" cp -p "$nginx_backup" "$NGINX_TARGET"
    else
      "${priv[@]}" rm -f "$NGINX_TARGET"
    fi
    "${priv[@]}" nginx -t && "${priv[@]}" systemctl reload nginx || echo 'CRITICAL: Nginx restore/reload failed' >&2
  fi
  echo "Activation failed, rolled back current symlink (exit $result)" >&2
  exit "$result"
}
trap rollback ERR

# In auto mode, create this site's vhost once, then leave any operator-added TLS intact.
if [[ "$NGINX_MODE" != skip ]]; then
  if "${priv[@]}" test -e "$NGINX_TARGET"; then
    [[ ! -L "$NGINX_TARGET" ]] || { echo 'Nginx target is a symlink; refusing overwrite' >&2; exit 2; }
    if [[ "$NGINX_MODE" == replace ]]; then
      # Never downgrade an existing HTTPS vhost with the HTTP-only template.
      if "${priv[@]}" grep -Eq '(^|[[:space:];{])(listen[[:space:]]+([^;[:space:]]+:)?443([[:space:];]|$)|ssl_certificate[[:space:]]+)' "$NGINX_TARGET"; then
        echo 'Refusing to replace existing HTTPS vhost with the HTTP-only template' >&2
        exit 2
      fi
      "${priv[@]}" cp -p "$NGINX_TARGET" "$nginx_backup"
      nginx_existed=1
      nginx_changed=1
      "${priv[@]}" cp "$STAGE/.nginx-new.conf" "$NGINX_TARGET"
    else
      echo "Preserving existing Nginx configuration: $NGINX_TARGET"
    fi
  else
    nginx_changed=1
    "${priv[@]}" cp "$STAGE/.nginx-new.conf" "$NGINX_TARGET"
  fi
  "${priv[@]}" nginx -t
  if [[ -z "${DEPLOY_TEST_NGINX_TARGET:-}" ]]; then
    nginx_dump="$("${priv[@]}" nginx -T 2>&1)" || { echo "Failed to re-read active Nginx configuration" >&2; false; }
    if ! grep -Fq "# configuration file $NGINX_TARGET:" <<< "$nginx_dump"; then
      echo "Nginx syntax is valid but the 2048 site was NOT loaded: $NGINX_TARGET" >&2
      echo "Check the active includes with: sudo nginx -T" >&2
      false
    fi
  fi
fi

# One atomic pointer switch; prior version remains available for rollback.
ln -s "$STAGE" "$BASE/.current-next-$$"
mv -Tf "$BASE/.current-next-$$" "$BASE/current"
switched=1

if [[ "$NGINX_MODE" != skip ]]; then
  "${priv[@]}" systemctl reload nginx
  # Probe the specific deployed release, not just a shared HTML title.
  # Force loopback to bypass proxies and reject redirects/wrong-site responses.
  health_body="$(mktemp "$BASE/.health-body.XXXXXX")"
  health_headers="$(mktemp "$BASE/.health-headers.XXXXXX")"
  healthy=0
  status='000'
  for attempt in 1 2 3; do
    status="$(curl --noproxy '*' --silent --show-error --max-time 5 \
      --connect-timeout 2 -H "Host: $DOMAIN" -D "$health_headers" \
      -o "$health_body" -w '%{http_code}' \
      'http://127.0.0.1/release.json')" || status='000'
    if [[ "$status" == 200 ]] && cmp -s "$STAGE/release.json" "$health_body"; then
      healthy=1
      break
    fi
    if (( attempt < 3 )); then sleep 1; fi
  done
  if [[ "$healthy" != 1 ]]; then
    location="$(grep -i '^location:' "$health_headers" | tail -n 1 | tr -d '\r' || true)"
    echo "HTTP 2048 release health check failed: status=$status; expected $STAGE/release.json" >&2
    if [[ -n "$location" ]]; then echo "Nginx response $location" >&2; fi
    echo "The local vhost is not serving the expected release. Verify server_name, active site includes, HTTP redirects and root in: sudo nginx -T" >&2
    echo "Reproduce: curl --noproxy '*' -i -H 'Host: $DOMAIN' http://127.0.0.1/release.json" >&2
    rm -f "$health_body" "$health_headers"
    false
  fi
  rm -f "$health_body" "$health_headers"
fi

trap - ERR
printf 'Activated %s; previous release: %s\n' "$STAGE" "${old_target:-none}"
