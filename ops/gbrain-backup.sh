#!/bin/zsh
# Daily GBrain backup: Postgres dump + ~/.gbrain config/state + brain repo commit.
# Run by launchd (com.__USER__.gbrain-backup). Keeps the last KEEP copies.
set -u
umask 077
PG=/opt/homebrew/opt/postgresql@17/bin
DEST="$HOME/Backups/gbrain"
KEEP=14
STAMP=$(date +%Y-%m-%d-%H%M)
LOG="$DEST/backup.log"
mkdir -p "$DEST" && chmod 700 "$DEST"
log() { print -r -- "$(date '+%F %T') $*" >> "$LOG"; }

# 1. Postgres dump (custom format, restorable with pg_restore), verified by listing its TOC
if "$PG/pg_dump" -Fc -d gbrain -f "$DEST/gbrain-$STAMP.dump.tmp" 2>>"$LOG" \
   && "$PG/pg_restore" -l "$DEST/gbrain-$STAMP.dump.tmp" >/dev/null 2>>"$LOG"; then
  mv "$DEST/gbrain-$STAMP.dump.tmp" "$DEST/gbrain-$STAMP.dump"
  log "ok dump gbrain-$STAMP.dump ($(du -h "$DEST/gbrain-$STAMP.dump" | cut -f1))"
else
  rm -f "$DEST/gbrain-$STAMP.dump.tmp"; log "FAIL pg_dump"
fi

# 2. ~/.gbrain (config, tokens, transcript corpus); skip runtime sockets and cache
if tar -czf "$DEST/gbrain-home-$STAMP.tgz" -C "$HOME" --exclude '.gbrain/run' --exclude '.gbrain/cache' .gbrain 2>>"$LOG"; then
  log "ok home gbrain-home-$STAMP.tgz"
else
  log "FAIL tar ~/.gbrain"
fi

# 2b. Local assets outside ~/.gbrain: launchd plists, coach reminders, panel state,
#     ingest state, Bandeja (incl. Audio) and the tools working tree (uncommitted work).
#     Excluded: panel session secret, any .env / *.env, brain/ (own repo), node_modules.
#     Stays in ~/Backups (700); never pushed to GitHub.
PLISTS=$(cd "$HOME/Library/LaunchAgents" && ls com.__USER__.*.plist com.gbrain.*.plist 2>/dev/null)
EXTRA=()
for d in Library/LaunchAgents/${^=PLISTS} .gbrain-coach .gbrain-panel .gbrain-ingest Bandeja GBRAIN; do
  [ -e "$HOME/$d" ] && EXTRA+=("$d")
done
if tar -czf "$DEST/gbrain-extras-$STAMP.tgz" -C "$HOME" \
     --exclude '.gbrain-panel/secret' --exclude '*.env' --exclude '.env*' \
     --exclude 'GBRAIN/brain' --exclude 'GBRAIN/.git' --exclude 'node_modules' \
     --exclude '.gbrain-ingest/audio-work' "${EXTRA[@]}" 2>>"$LOG"; then
  log "ok extras gbrain-extras-$STAMP.tgz ($(du -h "$DEST/gbrain-extras-$STAMP.tgz" | cut -f1))"
else
  log "FAIL tar extras"
fi

# 3. Commit any change in the brain's markdown repo
REPO="$HOME/GBRAIN/brain"
if [ -d "$REPO/.git" ] && [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  git -C "$REPO" add -A && git -C "$REPO" -c user.name="__NOMBRE_COMPLETO__" -c user.email="__EMAIL__" \
    commit -qm "Daily snapshot $STAMP" && log "ok git commit" || log "FAIL git commit"
fi

# 4. Prune old copies
for pat in 'gbrain-[0-9]*.dump' 'gbrain-home-*.tgz' 'gbrain-extras-*.tgz'; do
  ls -1t $DEST/${~pat} 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
done
