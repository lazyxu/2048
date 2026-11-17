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
fi

# One atomic pointer switch; prior version remains available for rollback.
ln -s "$STAGE" "$BASE/.current-next-$$"
mv -Tf "$BASE/.current-next-$$" "$BASE/current"
switched=1

if [[ "$NGINX_MODE" != skip ]]; then
  "${priv[@]}" systemctl reload nginx
  # An HTTP Host-header check confirms that the newly managed vhost serves
  # actual app HTML, without depending on public DNS/TLS provisioning.
  if [[ "$nginx_changed" == 1 ]]; then
    response="$(curl --fail --silent --show-error --max-time 5 -H "Host: $DOMAIN" http://127.0.0.1/)"
    [[ "$response" == *'<title>2048'* ]] || { echo 'HTTP health check returned the wrong site' >&2; false; }
  fi
fi

trap - ERR
printf 'Activated %s; previous release: %s\n' "$STAGE" "${old_target:-none}"
