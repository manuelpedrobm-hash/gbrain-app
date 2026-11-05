#!/bin/zsh
# Tarea diaria de GBrain (launchd com.__USER__.gbrain-backup, p. ej. a las 03:30):
# copia el correo de ayer (opcional), ingiere sesiones de Claude Code, hace commit del
# repo del cerebro, lo sincroniza con el motor y hace la copia de seguridad.
# Cada paso opcional falla sin bloquear al resto.
set -u
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
OPS="__REPO__/ops"
REPO="__REPO__/brain"
LOG="$HOME/Backups/gbrain/daily.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
print -r -- "=== $(date '+%F %T') daily start"

# Correo (opcional: necesita ops/correo.py configurado y la clave en el llavero)
[ -f "$OPS/gbrain-ingest-correo.py" ] && { /usr/bin/python3 -I "$OPS/gbrain-ingest-correo.py" || print -r -- "FAIL correo ingest"; }

# Sesiones de Claude Code de este Mac (incremental; los secretos se tachan con
# ~/.gbrain/harvest-private-patterns.txt)
(cd / && /usr/bin/perl -e 'alarm 1200; exec @ARGV' "$HOME/.bun/bin/gbrain" transcripts ingest "$HOME/.claude/projects/*/*.jsonl" --max-bytes 200mb --since last 2>&1 | tail -4) || print -r -- "FAIL transcripts ingest"

if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  git -C "$REPO" add -A && git -C "$REPO" -c user.name="__NOMBRE_COMPLETO__" -c user.email="__EMAIL__" \
    commit -qm "Daily ingest $(date +%F)"
fi
(cd / && "$HOME/.bun/bin/gbrain" sync --no-pull) | tail -5
/bin/zsh "$OPS/gbrain-backup.sh"

# Copia cifrada a iCloud (opcional: necesita `age` y ~/.gbrain/backup-age-recipient.txt)
[ -s "$HOME/.gbrain/backup-age-recipient.txt" ] && { /bin/zsh "$OPS/gbrain-offsite.sh" && print -r -- "ok offsite" || print -r -- "FAIL offsite (ver offsite.log)"; }

# Copia fuera del Mac (opcional): si el repo del cerebro tiene un remoto "origin", se sube
if git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
  git -C "$REPO" push -q origin HEAD && print -r -- "ok push brain" || print -r -- "FAIL push brain"
fi
print -r -- "=== $(date '+%F %T') daily end"
