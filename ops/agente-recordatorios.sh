#!/bin/zsh
# Every 5 minutes (launchd com.__USER__.coach-recordatorios): send due reminders
# from ops/recordatorios.py into the Telegram agent's session, which messages __NOMBRE__.
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL="es_ES.UTF-8"
OPS="$HOME/GBRAIN/ops"
LOG="$HOME/Backups/gbrain/rutinas.log"
log() { print -r -- "$(date '+%F %T') recordatorio $*" >> "$LOG"; }

screen -ls gbrain-telegram | grep -q gbrain-telegram || exit 0   # agent down: keep them pending
DUE=$(/usr/bin/python3 -I "$OPS/recordatorios.py" due) || { log "FAIL reading reminders"; exit 1; }
[ "$DUE" = "[]" ] && exit 0

CHAT=$(/usr/bin/python3 -I -c 'import json,os; print(json.load(open(os.path.expanduser("~/.claude/channels/telegram/access.json")))["allowFrom"][0])' 2>/dev/null)
[ -n "$CHAT" ] || { log "FAIL no paired Telegram chat"; exit 1; }
LIST=$(print -r -- "$DUE" | /usr/bin/python3 -I -c 'import json,sys; print(" ; ".join("#%s (intento %s): %s" % (r["id"], r["intento"], r["texto"]) for r in json.load(sys.stdin)))')

TEXT="[RECORDATORIO · $(date '+%A %-d de %B, %H:%M') · chat_id $CHAT] Toca recordarle a __NOMBRE__: $LIST. Antes de escribirle, mira si ya hay señales de que lo hizo (ops/tasks, correo enviado, sesiones de hoy). Si ya está hecho, márcalo con recordatorios.py done y díselo en una línea. Si no, recuérdaselo en una o dos líneas, de forma directa, y pregúntale si ya lo hizo. Sigue las reglas de la sección Recordatorios de tu CLAUDE.md para insistir."
screen -S gbrain-telegram -p 0 -X stuff "$TEXT"
sleep 1
screen -S gbrain-telegram -p 0 -X stuff $'\r'
log "sent: $LIST"
