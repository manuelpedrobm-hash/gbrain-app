#!/bin/zsh
# Plantilla: copia SEGURA de una carpeta tuya al cerebro (solo lectura del original).
# Copia este archivo como ops/fuentes/<nombre>.sh, cambia ORIGEN y NOMBRE y ejecútalo:
#   --dry-run  (solo lista)   --stage  (prepara en staging)   --publish  (copia al cerebro y gbrain sync)
# Excluye archivos > 2 MB, vacíos, duplicados y los que parezcan contener secretos.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
NOMBRE="mi-fuente"                       # slug de la fuente: sources/<NOMBRE>/
ORIGEN="$HOME/Documents/MI-CARPETA"      # carpeta a copiar
STAGE="$HOME/.gbrain-ingest/staging/$NOMBRE"
DEST="__REPO__/brain/sources/$NOMBRE"
LOG="$HOME/Backups/gbrain/fuentes.log"
MAXB=$((2*1024*1024))
SECRETOS='BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|(password|passwd|secret|api_key|apikey)[[:space:]]*[=:][[:space:]]*[^[:space:]]{4,}'

modo="$1"
[[ "$modo" == --dry-run || "$modo" == --stage || "$modo" == --publish ]] || { echo "Uso: $0 --dry-run|--stage|--publish"; exit 1; }
[[ -d "$ORIGEN" ]] || { echo "No existe $ORIGEN"; exit 1; }

candidatos() {
  find "$ORIGEN" \( -name node_modules -o -name .git -o -name dist -o -name .vscode -o -name .claude -o -name __pycache__ \) -prune -o \
    -type f \( -name '*.md' -o -name '*.txt' -o -name '*.docx' -o -name '*.pdf' \) -print | sort
}

if [[ "$modo" == --publish ]]; then
  [[ -d "$STAGE" ]] || { echo "No hay staging"; exit 1; }
  mkdir -p "$DEST" && cp -R "$STAGE"/. "$DEST"/ && rm -rf "$STAGE"
  echo "Publicado en $DEST"; cd / && gbrain sync; exit $?
fi

modo_stage=0; [[ "$modo" == --stage ]] && modo_stage=1
(( modo_stage )) && { rm -rf "$STAGE"; mkdir -p "$STAGE"; }
typeset -A vistos
copiados=0
while IFS= read -r f; do
  rel="${f#$ORIGEN/}"; tam=$(stat -f %z "$f")
  (( tam > MAXB )) && { echo "EXCLUIDO (>2MB): $rel"; continue; }
  case "$f" in
    *.docx) txt=$(textutil -convert txt -stdout "$f" 2>/dev/null) ;;
    *.pdf)  txt=$(pdftotext -layout "$f" - 2>/dev/null) ;;
    *)      txt=$(cat "$f") ;;
  esac
  [[ -z "${txt//[[:space:]]/}" ]] && { echo "EXCLUIDO (vacío): $rel"; continue; }
  n=$(print -r -- "$txt" | grep -c -E -i "$SECRETOS")
  (( n > 0 )) && { echo "EXCLUIDO (secretos): $rel"; continue; }
  h=$(print -r -- "$txt" | md5 -q)
  [[ -n "${vistos[$h]}" ]] && { echo "EXCLUIDO (duplicado): $rel"; continue; }
  vistos[$h]="$rel"; fecha=$(stat -f '%Sm' -t %Y-%m-%d "$f")
  echo "COPIA: $rel ($tam bytes, $fecha)"; ((copiados++))
  if (( modo_stage )); then
    out="$STAGE/${rel%.*}.md"; mkdir -p "${out:h}"; titulo="${${rel:t}%.*}"
    { print -r -- "---"; print -r -- "type: note"; print -r -- "title: \"$NOMBRE - ${titulo//\"/}\""
      print -r -- "source: $NOMBRE"; print -r -- "origen: \"${rel//\"/}\""; print -r -- "fecha_original: $fecha"
      print -r -- "trust_tier: external_untrusted"; print -r -- "---"; print -r -- ""; print -r -- "$txt"; } > "$out"
  fi
done < <(candidatos)
echo "$(date +%FT%T) $NOMBRE modo=$modo copiados=$copiados" | tee -a "$LOG" >/dev/null
exit 0
