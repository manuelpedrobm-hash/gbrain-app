#!/bin/zsh
# Encrypted off-site copy of the latest GBrain backup set to iCloud Drive.
# Uses only the age PUBLIC key; the private key is never needed here.
# Exit code != 0 on any failure (logged to offsite.log).
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SRC="$HOME/Backups/gbrain"
OUT="$HOME/Library/Mobile Documents/com~apple~CloudDocs/gbrain-backups"
RCPT="$HOME/.gbrain/backup-age-recipient.txt"
LOG="$SRC/offsite.log"
KEEP=7
log() { print -r -- "$(date '+%F %T') $*" >> "$LOG"; }
die() { log "FAIL $*"; print -u2 -r -- "gbrain-offsite FAIL: $*"; exit 1; }

command -v age >/dev/null || die "age not found"
[ -s "$RCPT" ] || die "recipient file missing/empty"
grep -q '^age1' "$RCPT" || die "recipient file is not an age public key"
mkdir -p "$OUT" || die "cannot create $OUT"

dump=$(ls -1t "$SRC"/gbrain-[0-9]*.dump 2>/dev/null | head -1)
[ -n "$dump" ] || die "no dump found"
stamp=${${dump:t}#gbrain-}; stamp=${stamp%.dump}
files=("$dump" "$SRC/gbrain-home-$stamp.tgz" "$SRC/gbrain-extras-$stamp.tgz")
for f in $files; do [ -s "$f" ] || die "missing source $f"; done

for f in $files; do
  dst="$OUT/${f:t}.age"
  # Encrypt OUTSIDE iCloud first (iCloud starts syncing a file the moment it appears and can lock it
  # for a while: a plain mv failed once overnight), then copy in with retries.
  tmpl="$(mktemp "${TMPDIR:-/tmp}/gbrain-offsite.XXXXXX")" || die "mktemp"
  age -R "$RCPT" -o "$tmpl" "$f" || { rm -f "$tmpl"; die "encrypt ${f:t}"; }
  ok=0
  for wait in 0 5 20 60; do
    sleep "$wait"
    if cp "$tmpl" "$dst.part" && mv -f "$dst.part" "$dst"; then ok=1; break; fi
    rm -f "$dst.part"
  done
  rm -f "$tmpl"
  [ "$ok" = 1 ] || die "copy to iCloud ${f:t}.age (4 attempts)"
  [ -s "$dst" ] || die "empty output ${dst:t}"
done

for pat in 'gbrain-[0-9]*.dump.age' 'gbrain-home-*.tgz.age' 'gbrain-extras-*.tgz.age'; do
  ls -1t "$OUT"/${~pat} 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
done
log "ok offsite stamp=$stamp ($(ls -1 "$OUT"/*.age | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
