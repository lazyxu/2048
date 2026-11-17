#!/usr/bin/env bash
set -euo pipefail

# Manual SSH deployment, following yl's release_deploy.sh. Never deploy from CI.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
DRYRUN=0
REMOTE_USER="root"
REMOTE_HOST="t-fluid.com"
REMOTE_PORT="22"
REMOTE_BASE="/2048"
DOMAIN="2048.1zkl.com" # Actual hostname; HTTPS must be configured on the server.
NGINX_MODE="auto" # Install once; preserve existing config (especially managed TLS) thereafter.

usage() {
  echo "Usage: $0 [--dryrun] [--host hostname] [--user username] [--port port] [--base /absolute/path] [--domain host.name] [--nginx-replace|--skip-nginx]"
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dryrun) DRYRUN=1; shift ;;
    --host|--user|--port|--base|--domain)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      case "$1" in
        --host) REMOTE_HOST="$2" ;;
        --user) REMOTE_USER="$2" ;;
        --port) REMOTE_PORT="$2" ;;
        --base) REMOTE_BASE="$2" ;;
        --domain) DOMAIN="$2" ;;
      esac
      shift 2 ;;
    --nginx-replace) NGINX_MODE="replace"; shift ;;
    --skip-nginx) NGINX_MODE="skip"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$REMOTE_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$REMOTE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ && "$REMOTE_PORT" =~ ^[0-9]+$ && 10#$REMOTE_PORT -ge 1 && 10#$REMOTE_PORT -le 65535 ]] || { echo 'Invalid SSH target' >&2; exit 2; }
[[ "$REMOTE_BASE" =~ ^/[a-zA-Z0-9_/-]+$ && "$REMOTE_BASE" != / && "$REMOTE_BASE" != *..* && "$REMOTE_BASE" != /yl0126 && "$REMOTE_BASE" != /yl0126/* ]] || { echo 'Invalid or protected deployment directory (yl is protected)' >&2; exit 2; }
[[ "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ && "$DOMAIN" != *..* ]] || { echo 'Invalid domain' >&2; exit 2; }

bash "$ROOT/release.sh"
name="$(cat releases/.latest-release)"
[[ "$name" =~ ^release-[0-9A-Za-z._-]+$ && "$name" != *..* ]] || { echo 'Invalid release name' >&2; exit 2; }
stage="$REMOTE_BASE/.2048-releases/$name"

if [[ "$DRYRUN" == 1 ]]; then
  echo "Preview: releases/$name -> $REMOTE_USER@$REMOTE_HOST:$stage"
  echo "Serving: $REMOTE_BASE/current (Nginx host: $DOMAIN, Nginx mode: $NGINX_MODE)"
  echo 'Dry run finished. No SSH connection and no production changes.'
  exit 0
fi

command -v ssh >/dev/null || { echo 'ssh is required' >&2; exit 1; }
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -p "$REMOTE_PORT")
target="$REMOTE_USER@$REMOTE_HOST"
ssh "${ssh_opts[@]}" "$target" "mkdir -p '$REMOTE_BASE/.2048-releases' && mkdir '$stage'"
tar -C "releases/$name" -czf - . | ssh "${ssh_opts[@]}" "$target" "tar -xzf - -C '$stage'"

# Render and stage a dedicated vhost; never alter yl0126.conf.
template="$(cat "$ROOT/deploy/nginx/2048.conf.template")"
template="${template//__DOMAIN__/$DOMAIN}"
template="${template//__WEB_ROOT__/$REMOTE_BASE\/current}"
printf '%s\n' "$template" | ssh "${ssh_opts[@]}" "$target" "cat > '$stage/.nginx-new.conf'"

ssh "${ssh_opts[@]}" "$target" "bash -s -- '$REMOTE_BASE' '$stage' '$DOMAIN' '$NGINX_MODE'" < "$ROOT/scripts/activate-staged-release.sh"
echo "Release deployed on SSH host: $stage"
echo "HTTPS/DNS must be configured separately; then open https://$DOMAIN/"
