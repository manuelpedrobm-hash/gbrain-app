#!/bin/zsh
# Sends a scheduled routine (agente-telegram/rutinas/<name>.md) to the Telegram agent's
# Claude Code session, which then writes to __NOMBRE__ first on Telegram.
# Started by launchd: com.__USER__.coach-<name>. Log: ~/Backups/gbrain/rutinas.log
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL="es_ES.UTF-8"
R="${1:?usage: agente-rutina.sh <manana|mediodia|cierre|semanal|bandeja|audio|radar|literatura>}"
TPL="$HOME/GBRAIN/agente-telegram/rutinas/$R.md"
LOG="$HOME/Backups/gbrain/rutinas.log"
STATE="$HOME/.gbrain-ingest/rutinas"
mkdir -p "$STATE" "$(dirname "$LOG")"
log() { print -r -- "$(date '+%F %T') $R $*" >> "$LOG"; }

[ -f "$TPL" ] || { log "FAIL no template $TPL"; exit 1; }
screen -ls gbrain-telegram | grep -q gbrain-telegram || { log "FAIL the Telegram agent is not running"; exit 1; }

if [ "$R" = bandeja ]; then
  # launchd fires on every change in ~/Bandeja (also when the agent moves files out):
  # wait for copies to finish, act only when there are new files, at most every 10 min.
  sleep 20
  n=$(find "$HOME/Bandeja" -maxdepth 1 -type f ! -name '.*' ! -name 'LEEME.txt' | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] || exit 0
  last=$(cat "$STATE/bandeja" 2>/dev/null || print 0)
  now=$(date +%s)
  if (( now - last < 600 )); then log "skip ($n files, sent less than 10 min ago)"; exit 0; fi
  print -r -- "$now" > "$STATE/bandeja"
fi

if [ "$R" = audio ]; then
  # Called by audio-a-cerebro.sh after it wrote new pages: 2-minute debounce only.
  last=$(cat "$STATE/audio" 2>/dev/null || print 0)
  now=$(date +%s)
  if (( now - last < 120 )); then log "skip (sent less than 2 min ago)"; exit 0; fi
  print -r -- "$now" > "$STATE/audio"
fi

if [ "$R" = radar ] || [ "$R" = literatura ]; then
  # Scheduled by launchd (daily / Sunday): 10-minute debounce against double firing (e.g. wake after sleep).
  last=$(cat "$STATE/$R" 2>/dev/null || print 0)
  now=$(date +%s)
  if (( now - last < 600 )); then log "skip (sent less than 10 min ago)"; exit 0; fi
  print -r -- "$now" > "$STATE/$R"
fi

CHAT=$(/usr/bin/python3 -I -c 'import json,os; print(json.load(open(os.path.expanduser("~/.claude/channels/telegram/access.json")))["allowFrom"][0])' 2>/dev/null)
[ -n "$CHAT" ] || { log "FAIL no paired Telegram chat"; exit 1; }
TEXT="[RUTINA $R · $(date '+%A %-d de %B de %Y, %H:%M') · chat_id $CHAT] $(tr '\n' ' ' < "$TPL")"

screen -S gbrain-telegram -p 0 -X stuff "$TEXT"
sleep 1
screen -S gbrain-telegram -p 0 -X stuff $'\r'
log "sent"
