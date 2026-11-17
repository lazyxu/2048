#!/usr/bin/env bash
set -euo pipefail

# One-time HTTPS setup for the independent 2048 Nginx site.
# No CI production access. Reuse the SSH deployment credentials.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="t-fluid.com"
REMOTE_USER="root"
REMOTE_PORT="22"
REMOTE_BASE="/2048"
DOMAIN="2048.1zkl.com"
EMAIL=""
DRYRUN=0

usage() {
  echo 'Usage: bash enable_https.sh [--dryrun] [--host host] [--user user] [--port port] [--base /path] [--domain hostname] [--email address]'
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dryrun) DRYRUN=1; shift ;;
    --host|--user|--port|--base|--domain|--email)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      case "$1" in
        --host) REMOTE_HOST="$2" ;;
        --user) REMOTE_USER="$2" ;;
        --port) REMOTE_PORT="$2" ;;
        --base) REMOTE_BASE="$2" ;;
        --domain) DOMAIN="$2" ;;
        --email) EMAIL="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$REMOTE_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ &&
   "$REMOTE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ &&
   "$REMOTE_PORT" =~ ^[0-9]+$ && 10#$REMOTE_PORT -ge 1 && 10#$REMOTE_PORT -le 65535 &&
   "$REMOTE_BASE" =~ ^/[a-zA-Z0-9_/-]+$ && "$REMOTE_BASE" != / &&
   "$REMOTE_BASE" != *..* && "$REMOTE_BASE" != /yl0126 && "$REMOTE_BASE" != /yl0126/* &&
   "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ && "$DOMAIN" != *..* ]] || {
  echo 'Invalid SSH target, base, or domain' >&2; exit 2;
}
if [[ -n "$EMAIL" && ! "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo 'Invalid certificate contact email' >&2; exit 2
fi

if [[ "$DRYRUN" == 1 ]]; then
  echo "Preview: enable Let's Encrypt HTTPS for $DOMAIN on $REMOTE_USER@$REMOTE_HOST:$REMOTE_PORT"
  echo "Dedicated 2048 web root: $REMOTE_BASE/current; no other site's Nginx configuration is touched."
  echo 'Requires: DNS records pointing to the host, inbound TCP/80 and TCP/443, certbot.'
  echo 'No SSH connection and no production changes.'
  exit 0
fi

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -p "$REMOTE_PORT")
ssh "${ssh_opts[@]}" "$REMOTE_USER@$REMOTE_HOST" \
  "bash -s -- '$REMOTE_BASE' '$DOMAIN' '$EMAIL'" < "$ROOT/scripts/configure-https.sh"
echo "HTTPS setup completed. Open https://$DOMAIN/ after public DNS and routing verification."
