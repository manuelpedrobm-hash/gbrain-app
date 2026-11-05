#!/bin/zsh
# Meeting audio -> brain. Started by launchd (com.__USER__.audio-bandeja) when
# ~/Bandeja/Audio changes. Everything is local: ffmpeg + whisper.cpp, nothing leaves the Mac.
# Each file or subfolder in ~/Bandeja/Audio = one meeting -> brain/sources/audio/AAAA-MM-DD-<slug>.md.
# Log (no meeting content): ~/Backups/gbrain/audio.log
# Test knobs: AUDIO_WAIT (default 20 s), AUDIO_STABLE (default 10 s), AUDIO_NO_AGENTE=1, AUDIO_NO_SYNC=1.
set -u
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL="es_ES.UTF-8"
IN="${AUDIO_IN:-$HOME/Bandeja/Audio}"
DONE="$IN/procesado"
BRAIN="$HOME/GBRAIN/brain"
OUT="$BRAIN/sources/audio"
OPS="$HOME/GBRAIN/ops"
MODEL="$HOME/.cache/whisper-cpp/ggml-large-v3-turbo.bin"
LOG="$HOME/Backups/gbrain/audio.log"
WORK="$HOME/.gbrain-ingest/audio-work"
LOCK="$HOME/.gbrain-ingest/audio.lock"
mkdir -p "$(dirname "$LOG")" "$OUT" "$DONE" "$WORK" "$(dirname "$LOCK")"
log() { print -r -- "$(date '+%F %T') $*" >> "$LOG"; }

# Lock (mkdir is atomic); a stale lock from a dead pid is taken over.
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null || print 0)
  if kill -0 "$old" 2>/dev/null; then log "skip: another run is active (pid $old)"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 0
fi
print -r -- $$ > "$LOCK/pid"
CUR=""
cleanup() { rm -rf "$LOCK"; }
on_signal() {
  if [ -n "$CUR" ] && [ -s "$CUR" ]; then
    mkdir -p "$WORK/parcial"; cp "$CUR" "$WORK/parcial/$(date +%Y%m%d-%H%M%S).txt"
    log "INTERRUPTED partial transcript kept in $WORK/parcial"
  else log "INTERRUPTED"; fi
  cleanup; exit 1
}
trap cleanup EXIT
trap on_signal INT TERM HUP

AUDIO_EXT='aiff|aif|m4a|mp3|wav|mp4|mov|aac|flac|ogg|opus|webm|caf'
TEXT_EXT='txt|md|vtt|srt|docx|pdf'
is_ext() { local e="${1:e:l}"; [[ "$e" =~ ^(${2})$ ]]; }

size_of() { find "$1" -type f ! -name '.*' -exec stat -f %z {} + 2>/dev/null | awk '{s+=$1} END{print s+0}'; }

list_items() {
  find "$IN" -mindepth 1 -maxdepth 1 ! -name '.*' ! -name procesado ! -name LEEME.txt 2>/dev/null | sort
}

[ -z "$(list_items)" ] && exit 0
sleep "${AUDIO_WAIT:-20}"

fmt_ts() { # whisper stdout -> "[mm:ss] text"
  /usr/bin/awk '/^\[[0-9:.]+ --> /{
      split($1,a,":"); sub(/\[/,"",a[1]); m=a[1]*60+a[2]; s=int(a[3]);
      line=$0; sub(/^\[[^]]*\] */,"",line); printf "[%02d:%02d] %s\n", m, s, line }'
}

# Transcribe one media file. Sets T_TEXT (path), T_LANG, T_DUR (seconds). Returns 0 on success.
transcribe() {
  local f="$1" id wav raw err t0 t1
  id="$(date +%s)-$$-$RANDOM"
  wav="$WORK/$id.wav"; raw="$WORK/$id.raw"; err="$WORK/$id.err"
  ffmpeg -nostdin -loglevel error -y -i "$f" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$wav" 2>"$err" \
    || { log "FAIL ffmpeg: ${f:t}: $(head -c 200 "$err" | tr '\n' ' ')"; rm -f "$wav" "$err"; return 1; }
  T_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$wav" 2>/dev/null | cut -d. -f1)
  T_DUR=${T_DUR:-0}
  CUR="$raw"
  t0=$(date +%s)
  whisper-cli -m "$MODEL" -f "$wav" -l auto -t 6 -pp >"$raw" 2>"$err"
  local rc=$?
  T_LANG=$(grep -o 'auto-detected language: [a-z]*' "$err" | head -1 | awk '{print $3}')
  if [ $rc -ne 0 ] || ! grep -q -- '-->' "$raw"; then
    log "WARN auto-detect gave no text for ${f:t} (rc=$rc); retrying with -l es"
    whisper-cli -m "$MODEL" -f "$wav" -l es -t 6 >"$raw" 2>"$err"; rc=$?
    T_LANG="es"
  fi
  CUR=""
  t1=$(date +%s)
  if [ $rc -ne 0 ] || ! grep -q -- '-->' "$raw"; then
    log "FAIL whisper: ${f:t} rc=$rc"; rm -f "$wav" "$raw" "$err"; return 1
  fi
  T_TEXT="$WORK/$id.txt"
  fmt_ts < "$raw" > "$T_TEXT"
  log "transcribed ${f:t}: ${T_DUR}s audio in $((t1-t0))s, lang=${T_LANG:-?}"
  rm -f "$wav" "$raw" "$err"
  return 0
}

fmt_dur() { local s=$1; printf '%d:%02d:%02d' $((s/3600)) $(((s%3600)/60)) $((s%60)); }

# Plain-text extraction for existing transcripts. Prints to a file, returns 0 if useful text.
extract_text() {
  local f="$1" o="$2"
  case "${f:e:l}" in
    txt|md|vtt|srt) cp "$f" "$o" ;;
    docx) textutil -convert txt -stdout "$f" > "$o" 2>/dev/null ;;
    pdf) pdftotext -layout "$f" "$o" 2>/dev/null ;;
  esac
  [ -s "$o" ] && [ "$(wc -w < "$o")" -ge 20 ]
}

PAGES=0
for item in ${(f)"$(list_items)"}; do
  [ -e "$item" ] || continue
  name="${item:t}"
  # Wait until sizes stop changing (copy finished); give up on this item for this run otherwise.
  stable=0
  for _ in 1 2 3 4 5 6; do
    s1=$(size_of "$item"); sleep "${AUDIO_STABLE:-10}"; s2=$(size_of "$item")
    [ "$s1" = "$s2" ] && { stable=1; break; }
  done
  [ $stable = 1 ] || { log "SKIP $name: still being copied"; continue; }
  [ -e "$item" ] || continue

  # Collect pieces: manifest kind<TAB>label<TAB>path
  man="$WORK/manifest-$$-$RANDOM.tsv"; : > "$man"
  tmpfiles=("$man"); ok=1; total=0; lang=""
  if [ -d "$item" ]; then
    mdate=$(stat -f %Sm -t %F "$item")
    files=(${(f)"$(find "$item" -type f ! -name '.*' | sort)"})
  else
    mdate=$(stat -f %Sm -t %F "$item")
    files=("$item")
  fi
  nmedia=0; ntext=0
  for f in $files; do
    rel="${f#$item/}"; [ -d "$item" ] || rel="$name"
    if is_ext "$f" "$AUDIO_EXT"; then
      nmedia=$((nmedia+1))
      if transcribe "$f"; then
        printf 'whisper\tTranscripción Whisper · %s\t%s\n' "$rel" "$T_TEXT" >> "$man"
        tmpfiles+=("$T_TEXT"); total=$((total+T_DUR)); [ -z "$lang" ] && lang="$T_LANG"
      else ok=0; break; fi
    elif is_ext "$f" "$TEXT_EXT"; then
      t="$WORK/txt-$$-$RANDOM.txt"
      if extract_text "$f" "$t"; then
        printf 'texto\tTranscripción aportada · %s\t%s\n' "$rel" "$t" >> "$man"; tmpfiles+=("$t"); ntext=$((ntext+1))
      else
        printf 'nota\tFichero no procesado · %s\tNo se pudo extraer texto (escaneado, vacío o formato no legible); sigue en la carpeta procesado.\n' "$rel" >> "$man"
        log "NOTE no text extracted from $rel"
      fi
    else
      printf 'nota\tFichero no procesado · %s\tFormato sin tratar; sigue en la carpeta procesado.\n' "$rel" >> "$man"
    fi
  done
  if [ $ok = 1 ] && [ $nmedia -eq 0 ] && [ $ntext -eq 0 ]; then
    log "FAIL $name: no audio or readable transcript inside"; ok=0
  fi
  if [ $ok = 0 ]; then log "FAIL $name left in place"; rm -f $tmpfiles; continue; fi

  page=$(/usr/bin/python3 -I "$OPS/audio-pagina.py" "$OUT" "$name" "$mdate" "${lang:-es}" "$(fmt_dur $total)" "$man" 2>>"$LOG")
  if [ -z "$page" ] || [ ! -s "$page" ]; then log "FAIL $name: page not written"; rm -f $tmpfiles; continue; fi
  rm -f $tmpfiles
  dest="$DONE/$(date +%Y-%m)"; mkdir -p "$dest"
  [ -e "$dest/$name" ] && dest="$dest/$(date +%H%M%S)" && mkdir -p "$dest"
  if mv "$item" "$dest/"; then
    log "OK $name -> ${page:t}, original in procesado/${dest:t}, ${total}s audio"
    PAGES=$((PAGES+1))
  else
    log "FAIL $name: page written (${page:t}) but original could not be moved"
  fi
done

[ $PAGES -gt 0 ] || exit 0

if [ "${AUDIO_NO_SYNC:-0}" != 1 ]; then
  if git -C "$BRAIN" add -- sources/audio >/dev/null 2>&1; then
    git -C "$BRAIN" -c user.name="__NOMBRE_COMPLETO__" -c user.email="__EMAIL__" \
      commit -qm "Audio de reuniones $(date +%F)" -- sources/audio >/dev/null 2>&1
  fi
  if command -v gbrain >/dev/null && [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/mcp)" -ge 200 ] 2>/dev/null; then
    if (cd / && gbrain sync --no-pull >>"$LOG.sync" 2>&1); then log "sync ok"; else log "WARN sync failed (nightly job will retry)"; fi
  else
    log "gbrain not responding; nightly job will index"
  fi
fi

# Ask the Telegram agent to summarise (2-minute debounce is inside agente-rutina.sh).
if [ "${AUDIO_NO_AGENTE:-0}" != 1 ]; then
  if screen -ls gbrain-telegram | grep -q gbrain-telegram; then
    /bin/zsh "$OPS/agente-rutina.sh" audio && log "agent notified" || log "WARN agent notify failed"
  else
    log "Telegram agent not running; no summary requested"
  fi
fi
exit 0
