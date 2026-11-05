#!/bin/zsh
# Abre Cerebro (http://127.0.0.1:3140) con una sesión nueva.
# El secreto viaja por stdin (curl -H @-), así que nunca aparece en `ps`.
set -eu
N=$(printf 'X-Panel-Secret: %s\n' "$(<$HOME/.gbrain-panel/secret)" | /usr/bin/curl -sf -X POST -H @- http://127.0.0.1:3140/api/login-nonce) \
  || { /usr/bin/osascript -e 'display alert "El panel no está en marcha" message "launchctl kickstart -k gui/__UID__/com.__USER__.gbrain-panel"'; exit 1; }
/usr/bin/open "http://127.0.0.1:3140/login?n=$N"
