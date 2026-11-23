#!/bin/bash
# Jori on a rented server — https://getjori.ai/cloud-init.sh
#
# The getjori.ai/cloud page hands the owner a few lines to paste into their
# cloud provider's "user data" box when they create a server (Hetzner,
# DigitalOcean, any Ubuntu 24.04 machine with cloud-init). Those lines run
# this as root on the server's first boot:
#
#   curl -fsSL https://getjori.ai/cloud-init.sh | JORI_SETUP_TOKEN=<token> bash
#
# It needs nobody at a terminal:
#   1. makes a `jori` user (passwordless sudo, lingering on) and runs the
#      normal installer (site/install.sh) as that user;
#   2. puts Caddy in front of the setup page at https://<ip>.sslip.io, where
#      Caddy gets a real certificate by itself, so the browser shows no warning;
#   3. runs `jori setup --public-host <ip>.sslip.io --token <token>` as a
#      service. The owner already holds the token (the cloud page made it in
#      their browser), so the page opens at https://<ip>.sslip.io/?t=<token>.
#   4. when the owner finishes setup, the service removes the proxy: nothing
#      of Jori answers on the internet afterwards.
#
# Progress: /var/log/jori-cloud-init.log, and https://<ip>.sslip.io/status
# (a plain "installing" / "ready" page the cloud page polls) until setup opens.

set -euo pipefail
exec > >(tee -a /var/log/jori-cloud-init.log) 2>&1

TOKEN="${JORI_SETUP_TOKEN:-}"
[[ ${#TOKEN} -ge 24 && $TOKEN =~ ^[A-Za-z0-9_-]+$ ]] || { echo "JORI_SETUP_TOKEN must be 24+ letters, digits, - or _"; exit 2; }
[[ $(id -u) == 0 ]] || { echo "run as root (cloud-init does)"; exit 2; }
command -v apt-get >/dev/null || { echo "this script expects Ubuntu or Debian"; exit 2; }

U=jori
JHOME=/home/$U
REPO="${JORI_REPO:-https://github.com/jori-ai/jori.git}"
INSTALLER="${JORI_INSTALLER_URL:-https://getjori.ai/install.sh}"

echo "▸ $(date -u +%FT%TZ) Jori cloud install"

# The public IPv4 address: the source address of the default route.
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[[ $IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "couldn't find this server's IPv4 address"; exit 1; }
HOST="${IP//./-}.sslip.io"
echo "  address: https://$HOST"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates cron xz-utils caddy >/dev/null
systemctl enable --now cron >/dev/null 2>&1 || true

# ── a status page while the install runs ───────────────────────────────────
mkdir -p /var/lib/jori-cloud
echo installing > /var/lib/jori-cloud/status
cat > /etc/caddy/Caddyfile <<EOF
# Jori setup (site/cloud-init.sh). Removed when setup finishes.
$HOST {
	header Cache-Control no-store
	header Access-Control-Allow-Origin https://getjori.ai
	handle /status {
		header Content-Type "text/plain; charset=utf-8"
		root * /var/lib/jori-cloud
		rewrite * /status
		file_server
	}
	handle {
		header Content-Type "text/plain; charset=utf-8"
		root * /var/lib/jori-cloud
		rewrite * /status
		file_server
	}
}
EOF
systemctl reload caddy || systemctl restart caddy

# ── the jori user ──────────────────────────────────────────────────────────
if ! id "$U" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$U"
fi
# Setup's own steps (Ollama, cron, lingering) use sudo; nobody is at a
# terminal to type a password, and the account has none.
echo "$U ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-jori && chmod 440 /etc/sudoers.d/90-jori
loginctl enable-linger "$U"
UID_J=$(id -u "$U")
for _ in $(seq 1 30); do [[ -S /run/user/$UID_J/bus ]] && break; sleep 1; done

# ── Jori ───────────────────────────────────────────────────────────────────
curl -fsSL "$INSTALLER" -o /tmp/jori-install.sh
chmod 755 /tmp/jori-install.sh
sudo -u "$U" -H env JORI_NO_SETUP=1 JORI_REPO="$REPO" XDG_RUNTIME_DIR="/run/user/$UID_J" bash /tmp/jori-install.sh < /dev/null
rm -f /tmp/jori-install.sh

NODE="$JHOME/.local/bin/node"
[[ -x $NODE ]] || NODE=$(command -v node)
PORT=$(sudo -u "$U" -H "$NODE" -p "require('$JHOME/Dev/jori/lib/ports.cjs').port('setup')")

# ── the setup page as a service, behind Caddy ──────────────────────────────
install -m 600 -o "$U" /dev/null /var/lib/jori-cloud/token
printf 'JORI_SETUP_TOKEN=%s\n' "$TOKEN" > /var/lib/jori-cloud/token

cat > /usr/local/sbin/jori-cloud-close <<'EOF'
#!/bin/bash
# Setup finished: stop answering on the internet.
printf '# Jori setup finished %s; nothing is served here.\n' "$(date -u +%FT%TZ)" > /etc/caddy/Caddyfile
systemctl reload caddy 2>/dev/null || systemctl stop caddy
systemctl disable caddy 2>/dev/null || true
echo done > /var/lib/jori-cloud/status
rm -f /var/lib/jori-cloud/token
EOF
chmod 755 /usr/local/sbin/jori-cloud-close

cat > /etc/systemd/system/jori-setup.service <<EOF
# Jori setup page for a rented server (site/cloud-init.sh).
[Unit]
Description=Jori setup page
After=network-online.target caddy.service

[Service]
Type=simple
User=$U
WorkingDirectory=$JHOME/Dev/jori
Environment=JORI_HOME=$JHOME/Dev/jori
Environment=XDG_RUNTIME_DIR=/run/user/$UID_J
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_J/bus
Environment=PATH=$JHOME/.local/bin:$JHOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/var/lib/jori-cloud/token
ExecStart=$NODE $JHOME/Dev/jori/bin/jori setup --public-host $HOST
# A clean exit is the owner pressing Finish: close the door. A crash restarts.
ExecStopPost=+/bin/sh -c '[ "\$\$SERVICE_RESULT" = success ] && /usr/local/sbin/jori-cloud-close || true'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
# Jori setup (site/cloud-init.sh). Removed when setup finishes.
$HOST {
	header Cache-Control no-store
	handle /status {
		header Access-Control-Allow-Origin https://getjori.ai
		header Content-Type "text/plain; charset=utf-8"
		root * /var/lib/jori-cloud
		rewrite * /status
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:$PORT
	}
}
EOF
echo ready > /var/lib/jori-cloud/status
systemctl daemon-reload
systemctl enable --now jori-setup.service
systemctl reload caddy || systemctl restart caddy
echo "✓ $(date -u +%FT%TZ) setup is open at https://$HOST/?t=<your token>"
