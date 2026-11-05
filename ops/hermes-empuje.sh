#!/bin/zsh
# Ronda de empuje de Hermes: un `hermes chat --oneshot` con el cerebro y el correo (solo lectura +
# remember) y su memoria propia; lo que responde se manda a Telegram y se apunta en el cerebro.
# Lo arranca launchd (com.__USER__.hermes-empuje). Log: ~/Backups/gbrain/hermes-empuje.log
# La clave de Anthropic se lee del Llavero en cada ronda (no se copia a ~/.hermes/.env).
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="es_ES.UTF-8" LC_ALL="es_ES.UTF-8"
DIR="$HOME/GBRAIN"
LOG="$HOME/Backups/gbrain/hermes-empuje.log"
OUTDIR="$HOME/.gbrain-ingest/hermes"
mkdir -p "$OUTDIR" "$(dirname "$LOG")"
log() { print -r -- "$(date '+%F %T') $*" >> "$LOG"; }

# Mac dormido o sin red: launchd lanza la ronda pendiente al despertar; no repetir en <2 h.
last=$(cat "$OUTDIR/last" 2>/dev/null || print 0); now=$(date +%s)
if [ "${1:-}" != "--forzar" ] && (( now - last < 7200 )); then log "skip (ronda hace menos de 2 h)"; exit 0; fi
print -r -- "$now" > "$OUTDIR/last"

ANTHROPIC_API_KEY=$(/usr/bin/security find-generic-password -s anthropic-api-key -a __USER__ -w 2>/dev/null) || ANTHROPIC_API_KEY=""
[ -n "$ANTHROPIC_API_KEY" ] || { log "FAIL sin clave de Anthropic en el Llavero"; exit 1; }
export ANTHROPIC_API_KEY

STAMP=$(date '+%Y-%m-%d-%H%M')
PROMPT="$OUTDIR/prompt-$STAMP.md"
sed "s/{{FECHA}}/$(date '+%A %-d de %B de %Y, %H:%M')/" "$DIR/agente-hermes/empuje.md" > "$PROMPT"
OUT="$OUTDIR/ronda-$STAMP.md"

cd "$DIR/agente-hermes" || exit 1
hermes chat --oneshot --quiet --source tool \
  --toolsets memory,todo,session_search,mcp-cerebro,mcp-correo \
  --max-turns 40 --query-file "$PROMPT" > "$OUT" 2>> "$LOG"
rc=$?
rm -f "$PROMPT"
unset ANTHROPIC_API_KEY
if [ $rc -ne 0 ] || [ ! -s "$OUT" ]; then log "FAIL hermes rc=$rc"; exit 1; fi
if grep -qx 'SIN NOVEDAD' "$OUT"; then log "ok sin novedad"; exit 0; fi

/usr/bin/python3 -I "$DIR/ops/telegram-enviar.py" "$OUT" >> "$LOG" 2>&1 && log "enviado" || log "FAIL telegram"

# Copia en el cerebro (una página por mes) para que el agente de Telegram y el panel lo vean.
PAGE="$DIR/brain/ops/hermes/empuje-$(date '+%Y-%m').md"
mkdir -p "$(dirname "$PAGE")"
[ -f "$PAGE" ] || printf -- '---\ntype: note\ntitle: "Hermes: rondas de empuje %s"\ntags: [hermes, empuje]\n---\n\n# Hermes: rondas de empuje\n\n' "$(date '+%Y-%m')" > "$PAGE"
{ print -r -- ""; print -r -- "## $(date '+%Y-%m-%d %H:%M')"; print -r -- ""; cat "$OUT"; print -r -- ""; } >> "$PAGE"
