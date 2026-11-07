#!/usr/bin/env bash
# Server-side installer for the ESS Twin static site.
# Usage (on server): WEBROOT=/var/www/ess-twin PORT=80 bash /tmp/install.sh /tmp/ess-twin-static.tar.gz
#   - extracts into WEBROOT (default /var/www/ess-twin)
#   - if root + nginx present: writes a vhost conf and reloads nginx
#   - non-root: only extracts, prints the nginx snippet for manual setup
set -euo pipefail

TARBALL="${1:-/tmp/ess-twin-static.tar.gz}"
WEBROOT="${WEBROOT:-/var/www/ess-twin}"
PORT="${PORT:-80}"

[ -f "$TARBALL" ] || { echo "ERROR: tarball not found: $TARBALL" >&2; exit 1; }
mkdir -p "$WEBROOT"
tar -xzf "$TARBALL" -C "$WEBROOT"
[ -f "$WEBROOT/index.html" ] || { echo "ERROR: index.html missing after extract" >&2; exit 1; }
echo "[install] extracted to $WEBROOT ($(find "$WEBROOT" -type f | wc -l) files)"
echo "[install] pages: $(cd "$WEBROOT" && ls *.html | tr '\n' ' ')"

NGINX_CONF="/etc/nginx/conf.d/ess-twin.conf"
if [ "$(id -u)" -eq 0 ] && command -v nginx >/dev/null 2>&1 && [ -d /etc/nginx/conf.d ]; then
  cat > "$NGINX_CONF" <<EOF
server {
    listen ${PORT};
    server_name _;
    root ${WEBROOT};
    index index.html;
    location / { try_files \$uri \$uri/ =404; }
    location ~* \.(png|jpg|gif|svg|js|css|woff2?)$ {
        expires 7d;
        add_header Cache-Control "public";
    }
}
EOF
  if nginx -t >/dev/null 2>&1; then
    (systemctl reload nginx 2>/dev/null || nginx -s reload) || true
    echo "[install] nginx vhost ${NGINX_CONF} active on port ${PORT}"
  else
    echo "WARN: nginx -t failed, please inspect ${NGINX_CONF}" >&2
  fi
else
  echo "[install] skipped nginx auto-config (need root + nginx). Serve ${WEBROOT} with any static server."
fi

if command -v curl >/dev/null 2>&1 && [ "${SKIP_SMOKE:-0}" != "1" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/index.html" || true)"
  echo "[install] local smoke: GET /index.html -> ${code:-no-server-yet}"
fi
echo "[install] done. NOTE: static-only deploy has no WS backend;"
echo "           '?ws=live' falls back to local simulation (amber badge). Run bridge.js + reverse proxy /ws for real-time."
echo "[install] for real WS: see deploy/static/nginx-ws.conf.example (same-origin /ws + 3600s timeout)."
