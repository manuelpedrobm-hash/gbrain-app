#!/bin/zsh
# Voice note -> text, 100% local (ffmpeg + whisper.cpp). Usage: voz-a-texto.sh <audio file>
# Prints ONLY the transcript on stdout (no timestamps). Errors go to stderr, exit != 0.
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
MODEL="$HOME/.cache/whisper-cpp/ggml-large-v3-turbo.bin"
f="${1:-}"
[ -n "$f" ] || { print -u2 "uso: voz-a-texto.sh <fichero de audio>"; exit 2; }
[ -f "$f" ] || { print -u2 "error: no existe el fichero: $f"; exit 2; }
[ -f "$MODEL" ] || { print -u2 "error: falta el modelo $MODEL"; exit 3; }
command -v ffmpeg >/dev/null && command -v whisper-cli >/dev/null || { print -u2 "error: falta ffmpeg o whisper-cli"; exit 3; }
W=$(mktemp -d "${TMPDIR:-/tmp}/voz.XXXXXX") || { print -u2 "error: no se pudo crear tmp"; exit 3; }
trap 'rm -rf "$W"' EXIT
ffmpeg -nostdin -loglevel error -y -i "$f" -ar 16000 -ac 1 -c:a pcm_s16le "$W/a.wav" 2>"$W/ff.err" \
  || { print -u2 "error: ffmpeg no pudo leer el audio: $(head -c 300 "$W/ff.err")"; exit 4; }
clean() { /usr/bin/sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' "$W/t.txt" | /usr/bin/grep -v '^$' | tr '\n' ' ' | /usr/bin/sed -E 's/[[:space:]]+$//'; }
run() { whisper-cli -m "$MODEL" -f "$W/a.wav" -l "$1" -t 6 -nt -np >"$W/t.txt" 2>"$W/w.err"; }
if ! run auto || [ -z "$(tr -d '[:space:]' <"$W/t.txt")" ]; then
  run es || { print -u2 "error: whisper fallo: $(tail -c 300 "$W/w.err")"; exit 5; }
fi
out=$(clean)
[ -n "$out" ] || { print -u2 "error: transcripcion vacia (audio sin voz?)"; exit 6; }
print -r -- "$out"
