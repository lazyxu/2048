#!/usr/bin/env bash
set -eEuo pipefail

# Remote Linux only. Configure HTTPS for the dedicated 2048 Nginx vhost.
BASE="${1:?base required}"
DOMAIN="${2:?domain required}"
EMAIL="${3:-}"

[[ "$BASE" =~ ^/[a-zA-Z0-9_/-]+$ && "$BASE" != / && "$BASE" != *..* &&
   "$BASE" != /yl0126 && "$BASE" != /yl0126/* &&
   "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ && "$DOMAIN" != *..* ]] || {
  echo 'Invalid 2048 HTTPS parameters' >&2; exit 2;
}
[[ -z "$EMAIL" || "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || {
  echo 'Invalid certificate email' >&2; exit 2;
}
[[ "$(id -u)" == 0 || -n "${DEPLOY_TEST_NGINX_TARGET:-}" ]] || {
  echo 'HTTPS setup must run as root on the SSH server' >&2; exit 2;
}
[[ -L "$BASE/current" && -s "$BASE/current/index.html" && -s "$BASE/current/release.json" ]] || {
  echo 'Missing active 2048 release. Deploy the app first.' >&2; exit 2;
}
command -v certbot >/dev/null || {
  echo 'Missing certbot. Install it on the server (e.g. apt install certbot), then rerun.' >&2; exit 2;
}
command -v openssl >/dev/null || { echo 'Missing openssl' >&2; exit 2; }
command -v nginx >/dev/null || { echo 'Missing nginx' >&2; exit 2; }

SITE="${DEPLOY_TEST_NGINX_TARGET:-}"
nginx_dump="$(nginx -T 2>&1)" || { echo 'nginx -T failed; refusing HTTPS changes' >&2; exit 2; }
if [[ -z "$SITE" ]]; then
  for candidate in /etc/nginx/conf.d/2048.conf /etc/nginx/sites-enabled/2048.conf; do
    if grep -Fq "# configuration file $candidate:" <<< "$nginx_dump"; then
      SITE="$candidate"
      break
    fi
  done
fi
[[ -n "$SITE" && -f "$SITE" && ! -L "$SITE" ]] || {
  echo 'Cannot locate a regular, actively loaded 2048 Nginx configuration' >&2; exit 2;
}
if [[ -z "${DEPLOY_TEST_NGINX_TARGET:-}" ]] && ! grep -Fq "# configuration file $SITE:" <<< "$nginx_dump"; then
  echo "2048 Nginx config is not loaded: $SITE" >&2; exit 2
fi
if ! grep -Fq "root $BASE/current;" "$SITE"; then
  echo "Refusing to edit $SITE: it does not belong to 2048 web root $BASE/current" >&2
  exit 2
fi
CERT_ROOT="${DEPLOY_TEST_CERT_ROOT:-/etc/letsencrypt/live}"
CERT="$CERT_ROOT/$DOMAIN/fullchain.pem"
KEY="$CERT_ROOT/$DOMAIN/privkey.pem"
# Existing TLS must remain intact. Rechecking a correctly configured domain
# is idempotent and never replaces its certificate or nginx settings.
if grep -Eq '(^|[[:space:];{])(listen[[:space:]]+([^;[:space:]]+:)?443([[:space:];]|$)|ssl_certificate[[:space:]]+)' "$SITE"; then
  if grep -Fq "server_name $DOMAIN;" "$SITE" &&
     grep -Fq "ssl_certificate $CERT;" "$SITE" &&
     grep -Fq "ssl_certificate_key $KEY;" "$SITE" &&
     [[ -s "$CERT" && -s "$KEY" ]]; then
    probe="$(mktemp "$BASE/.https-already.XXXXXX")"
    if curl --noproxy '*' --fail --silent --show-error --max-time 8 \
      --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/release.json" > "$probe" &&
      cmp -s "$BASE/current/release.json" "$probe"; then
      rm -f "$probe"
      echo "HTTPS already active for https://$DOMAIN/; no changes made."
      exit 0
    fi
    rm -f "$probe"
  fi
  echo "Existing TLS configuration in $SITE was not verified; refusing to overwrite it." >&2
  exit 2
fi

mkdir -p "$BASE/.https-backups" "$BASE/.well-known/acme-challenge"
exec 9>"$BASE/.deploy.lock"
flock -n 9 || { echo 'Another 2048 deployment is in progress' >&2; exit 2; }
BACKUP="$(mktemp "$BASE/.https-backups/nginx-pre-https.XXXXXX")"
cp -p "$SITE" "$BACKUP"
changed=0
challenge_path=""
site_tmp=""
install_site() {
  # Hidden temporary config is excluded by the normal Nginx * / *.conf globs.
  chmod 0644 "$site_tmp"
  mv -f "$site_tmp" "$SITE"
  site_tmp=""
  changed=1
}
rollback() {
  local rc="$?"
  trap - ERR
  set +e
  [[ -z "$challenge_path" ]] || rm -f "$challenge_path"
  [[ -z "$site_tmp" ]] || rm -f "$site_tmp"
  if [[ "$changed" == 1 ]]; then
    restore_tmp="$(mktemp "$(dirname "$SITE")/.2048-restore.XXXXXX")"
    if cp -p "$BACKUP" "$restore_tmp" && mv -f "$restore_tmp" "$SITE"; then
      :
    else
      echo 'CRITICAL: Failed to restore previous 2048 vhost' >&2
    fi
    nginx -t && systemctl reload nginx || echo 'CRITICAL: Failed to reload restored Nginx config' >&2
  fi
  echo "HTTPS configuration failed (exit $rc); previous 2048 Nginx config restored from $BACKUP" >&2
  exit "$rc"
}
trap rollback ERR

# Temporary HTTP vhost for HTTP-01; keep dotfile denial except challenge.
site_tmp="$(mktemp "$(dirname "$SITE")/.2048-http.XXXXXX")"
cat > "$site_tmp" <<NGINX_HTTP
# Managed by lazyxu/2048 HTTPS bootstrap; previous config at $BACKUP
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    root $BASE/current;
    index index.html;
    location ^~ /.well-known/acme-challenge/ {
        root $BASE;
        default_type text/plain;
        try_files \$uri =404;
    }
    location ~ /\\. { deny all; }
    location / { try_files \$uri \$uri/ =404; }
}
NGINX_HTTP
install_site
nginx -t
systemctl reload nginx
challenge_name="2048-https-check-$$"
challenge_path="$BASE/.well-known/acme-challenge/$challenge_name"
printf '%s' "$challenge_name" > "$challenge_path"
received="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  -H "Host: $DOMAIN" "http://127.0.0.1/.well-known/acme-challenge/$challenge_name")"
[[ "$received" == "$challenge_name" ]] || {
  echo 'The 2048 ACME challenge is not routed to this Nginx vhost on localhost:80' >&2
  false
}
rm -f "$challenge_path"
challenge_path=""

if [[ -s "$CERT" && -s "$KEY" ]] && \
   openssl x509 -in "$CERT" -noout -checkend 86400 >/dev/null 2>&1 && \
   openssl x509 -in "$CERT" -noout -checkhost "$DOMAIN" >/dev/null 2>&1; then
  echo "Reusing valid certificate for $DOMAIN"
else
  certbot_opts=(certonly --non-interactive --agree-tos --webroot --webroot-path "$BASE" \
    --cert-name "$DOMAIN" -d "$DOMAIN" --deploy-hook 'systemctl reload nginx')
  if [[ -n "$EMAIL" ]]; then
    certbot_opts+=(--email "$EMAIL")
  else
    certbot_opts+=(--register-unsafely-without-email)
  fi
  certbot "${certbot_opts[@]}"
fi
[[ -s "$CERT" && -s "$KEY" ]] || {
  echo "Certificate files for $DOMAIN are missing after issuance" >&2
  false
}
openssl x509 -in "$CERT" -noout -checkhost "$DOMAIN" >/dev/null || {
  echo "Certificate does not cover $DOMAIN" >&2; false;
}

# Public HTTP redirects to HTTPS. Localhost-only /release.json remains for
# release_deploy.sh's trusted, no-redirect deployment health probe.
site_tmp="$(mktemp "$(dirname "$SITE")/.2048-tls.XXXXXX")"
cat > "$site_tmp" <<NGINX_TLS
# Managed by lazyxu/2048: only this vhost, no changes to other sites.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root $BASE;
        default_type text/plain;
        try_files \$uri =404;
    }
    location = /release.json {
        root $BASE/current;
        allow 127.0.0.1;
        allow ::1;
        deny all;
        try_files /release.json =404;
    }
    location / { return 308 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    root $BASE/current;
    index index.html;
    charset utf-8;
    autoindex off;
    ssl_certificate $CERT;
    ssl_certificate_key $KEY;
    ssl_protocols TLSv1.2 TLSv1.3;
    location = / { try_files /index.html =404; add_header Cache-Control "no-cache"; }
    location = /index.html { try_files /index.html =404; add_header Cache-Control "no-cache"; }
    location = /sw.js {
        try_files /sw.js =404;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Service-Worker-Allowed "/";
    }
    location = /manifest.webmanifest {
        types { application/manifest+json webmanifest; }
        try_files /manifest.webmanifest =404;
        add_header Cache-Control "no-cache";
    }
    location ~ /\\. { deny all; }
    location / { try_files \$uri \$uri/ =404; }
}
NGINX_TLS
install_site
nginx -t
systemctl reload nginx
expected="$BASE/current/release.json"
health_body="$(mktemp "$BASE/.https-check.XXXXXX")"
if ! curl --noproxy '*' --fail --silent --show-error --max-time 8 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/release.json" > "$health_body"; then
  rm -f "$health_body"
  echo 'HTTPS endpoint failed certificate-verified local TLS probe' >&2
  false
fi
if ! cmp -s "$expected" "$health_body"; then
  rm -f "$health_body"
  echo 'HTTPS endpoint returned another application or release' >&2
  false
fi
rm -f "$health_body"
changed=0
trap - ERR
echo "HTTPS enabled for https://$DOMAIN/ (active release verified)."
echo "Nginx backup kept at: $BACKUP"
echo 'Check automatic renewal scheduling with: systemctl list-timers | grep -E "certbot|snap.certbot"'
