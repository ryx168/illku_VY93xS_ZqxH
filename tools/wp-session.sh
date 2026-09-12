#!/usr/bin/env bash
# Open the tunnel, hold the editing session, autosave, and stop when idle.
set -euo pipefail

IDLE_MIN="${1:-15}"
WORK=/tmp/wp

echo "::group::Tunnel"
curl -sSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
chmod +x /tmp/cloudflared
setsid nohup /tmp/cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" > /tmp/tunnel.log 2>&1 < /dev/null &
for i in $(seq 1 30); do
  grep -qi "Registered tunnel connection" /tmp/tunnel.log && break
  sleep 2
done
grep -ci "Registered tunnel connection" /tmp/tunnel.log | sed 's/^/  tunnel connections: /'
echo "::endgroup::"

echo "session open; idle stop after ${IDLE_MIN} min"

# Activity is measured from the PHP access log: an open wp-admin tab
# heartbeats roughly once a minute, so a real session stays alive on its own.
# Activity means a PERSON in the admin: anything under /wp-admin/ (the open
# editor's heartbeat included) or a login POST. Not the size of the log - that
# counts scanners probing /wp-json and WordPress cron, and a session kept alive
# by those never ends.
admin_hits() { grep -cE '\]: ((GET|POST|HEAD) /wp-admin/|POST /wp-login\.php)' /tmp/php.log 2>/dev/null || true; }
last_hits=$(admin_hits)
idle_secs=0
elapsed=0
autosave_every=300      # 5 minutes - a runner can die with no usable hook,
                        # so never rely on saving only at shutdown
since_save=0

while true; do
  sleep 30
  elapsed=$((elapsed + 30))
  since_save=$((since_save + 30))

  hits=$(admin_hits)
  if [ "${hits:-0}" -ne "${last_hits:-0}" ]; then
    idle_secs=0
    last_hits=$hits
  else
    idle_secs=$((idle_secs + 30))
  fi

  if [ "$since_save" -ge "$autosave_every" ]; then
    bash tools/wp-save.sh autosave || echo "  autosave failed (continuing)"
    echo "autosaved (periodic) after ${elapsed}s"
    since_save=0
  fi

  if [ "$idle_secs" -ge $((IDLE_MIN * 60)) ]; then
    echo "idle for ${IDLE_MIN} min - closing the session"
    break
  fi
done
