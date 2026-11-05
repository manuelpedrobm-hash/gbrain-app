#!/bin/zsh
# Detecta un export nuevo de claude.ai en ~/Downloads e importa las conversaciones nuevas.
# Uso: export-claude-detectar.sh --dry-run | --run | --hay-nuevo
# Variables opcionales (pruebas): EXPORT_DIR (carpeta a vigilar), EXPORT_WORK, EXPORT_SEEN, EXPORT_LOG
# El contenido del zip es NO CONFIABLE: solo se lee con python3 -I, nunca se ejecuta.
# No mueve ni borra el zip original.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
MODE="${1:---dry-run}"
DIR="${EXPORT_DIR:-$HOME/Downloads}"
WORKROOT="${EXPORT_WORK:-$HOME/.gbrain-ingest/export-work}"
SEEN="${EXPORT_SEEN:-$HOME/.gbrain-ingest/export-visto.json}"
LOG="${EXPORT_LOG:-$HOME/Backups/gbrain/export.log}"
mkdir -p "$WORKROOT" "${LOG:h}" "${SEEN:h}"
log() { print -r -- "$(date '+%F %T') $*" >> "$LOG"; }

# Zips candidatos (solo primer nivel; nombres tipo export de claude.ai) aun no vistos
candidatos() {
  python3 -I - "$DIR" "$SEEN" <<'PY'
import sys, os, re, json, hashlib
d, seen = sys.argv[1], sys.argv[2]
try: vistos = set(json.load(open(seen)).keys())
except Exception: vistos = set()
pat = re.compile(r'^(data-.*|conversations-.*|memories-.*|claude-.*export.*)\.zip$', re.I)
for n in sorted(os.listdir(d)):
    p = os.path.join(d, n)
    if not (pat.match(n) and os.path.isfile(p)): continue
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1<<20), b''): h.update(b)
    if h.hexdigest() not in vistos:
        print(h.hexdigest() + '\t' + p)
PY
}

NUEVOS=("${(@f)$(candidatos)}")
NUEVOS=("${(@)NUEVOS:#}")
if [[ "$MODE" == "--hay-nuevo" ]]; then [[ ${#NUEVOS} -gt 0 ]]; exit $?; fi
[[ "$MODE" == "--run" || "$MODE" == "--dry-run" ]] || { print "Uso: $0 --dry-run | --run"; exit 2; }
if [[ ${#NUEVOS} -eq 0 ]]; then print "No hay zips nuevos de export de claude.ai en $DIR"; exit 0; fi

for linea in "${NUEVOS[@]}"; do
  hash="${linea%%$'\t'*}"; zip="${linea#*$'\t'}"
  dest="$WORKROOT/$(date +%F)-${hash[1,8]}"
  [[ -e "$dest" ]] && dest="${dest}-$(date +%H%M%S)"
  mkdir -p "$dest"
  print "Zip nuevo: ${zip:t} (sha ${hash[1,12]})"
  # Descomprimir de forma segura y localizar conversations.json / memories
  info=$(python3 -I - "$zip" "$dest" <<'PY'
import sys, zipfile, os
z, dest = sys.argv[1], os.path.realpath(sys.argv[2])
MAX = 2 * 1024**3
conv = mem = None
with zipfile.ZipFile(z) as zf:
    if sum(i.file_size for i in zf.infolist()) > MAX: print('ERROR demasiado grande'); sys.exit(1)
    for i in zf.infolist():
        if i.is_dir(): continue
        t = os.path.realpath(os.path.join(dest, i.filename))
        if not t.startswith(dest + os.sep): continue   # evita rutas fuera del directorio
        base = os.path.basename(i.filename).lower()
        # solo se extraen conversaciones y memorias; light_metadata y datos de cuenta no
        if base != 'conversations.json' and not base.startswith('memories'): continue
        os.makedirs(os.path.dirname(t), exist_ok=True)
        with zf.open(i) as s, open(t, 'wb') as o: o.write(s.read())
        if base == 'conversations.json': conv = t
        else: mem = t
print('CONV=' + (conv or '')); print('MEM=' + (mem or ''))
PY
)
  conv=$(print -r -- "$info" | sed -n 's/^CONV=//p'); mem=$(print -r -- "$info" | sed -n 's/^MEM=//p')
  if [[ -z "$conv" ]]; then
    print "  Sin conversations.json en este zip (puede ser memorias u otra parte)."
    log "$MODE zip=${zip:t} sha=${hash[1,12]} sin-conversations"
  else
    [[ -n "$mem" ]] && print "  Memorias encontradas (quedan en la carpeta de trabajo, no se importan)."
    if [[ "$MODE" == "--dry-run" ]]; then
      (cd / && gbrain transcripts ingest "$conv" --format claude-export --dry-run 2>&1 | tail -15)
      log "dry-run zip=${zip:t} sha=${hash[1,12]}"
    else
      (cd / && gbrain transcripts ingest "$conv" --format claude-export --quiet) >/dev/null 2>&1
      rc=$?
      log "run zip=${zip:t} sha=${hash[1,12]} rc=$rc"
      if [[ $rc -ne 0 ]]; then print "  Fallo la importacion (codigo $rc); no se marca como visto."; continue; fi
      print "  Conversaciones importadas."
    fi
  fi
  if [[ "$MODE" == "--run" ]]; then
    python3 -I - "$SEEN" "$hash" "${zip:t}" <<'PY'
import sys, json, datetime
p, h, n = sys.argv[1:4]
try: d = json.load(open(p))
except Exception: d = {}
d[h] = {"zip": n, "fecha": datetime.datetime.now().isoformat(timespec='seconds')}
json.dump(d, open(p, 'w'), indent=1)
PY
  else
    rm -rf "$dest"   # el modo seco no deja nada
  fi
done
exit 0
