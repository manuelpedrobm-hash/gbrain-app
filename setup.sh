#!/bin/zsh
# Configura esta copia de GBrain-app para TU Mac y TU nombre (se ejecuta una sola vez).
#   zsh setup.sh
# Rellena los marcadores __HOME__, __REPO__, __USER__, __NOMBRE__... en todos los archivos,
# renombra los .plist de launchd y crea tu cerebro vacío en brain/ (repo git aparte).
# Para ejecutarlo sin preguntas: NOMBRE=Ana NOMBRE_COMPLETO="Ana Ruiz" EMAIL=ana@ejemplo.com ORG="Mi empresa" zsh setup.sh
set -eu
cd "${0:A:h}"
REPO="$PWD"

if [[ -f .setup-hecho ]]; then
  print "Ya se configuró antes (.setup-hecho). Si quieres rehacerlo, parte de una copia limpia del repo."; exit 1
fi
for c in python3 git; do command -v $c >/dev/null || { print "Falta $c"; exit 1; }; done

pregunta() {  # pregunta VAR "texto" "por defecto"
  local var="$1" txt="$2" def="${3:-}" val
  val="${(P)var:-}"
  if [[ -z "$val" ]]; then
    read "val?$txt${def:+ [$def]}: "
    val="${val:-$def}"
  fi
  typeset -g "$var=$val"
}
pregunta NOMBRE "Tu nombre de pila (así te hablarán los agentes)" ""
[[ -n "$NOMBRE" ]] || { print "El nombre es obligatorio."; exit 1; }
pregunta NOMBRE_COMPLETO "Tu nombre completo (firma de los commits y correos)" "$NOMBRE"
pregunta EMAIL "Tu correo (commits y remitente de correos)" "tu-correo@ejemplo.com"
pregunta ORG "Tu organización o proyecto (aparece en textos de la interfaz)" "mi proyecto"
DOMINIO="${EMAIL#*@}"

export S_HOME="$HOME" S_REPO="$REPO" S_USER="$(id -un)" S_UID="$(id -u)" \
       S_REPO_SLUG="$(print -r -- "$REPO" | sed 's/[^A-Za-z0-9]/-/g')" \
       S_NOMBRE="$NOMBRE" S_NOMBRE_COMPLETO="$NOMBRE_COMPLETO" S_EMAIL="$EMAIL" S_ORG="$ORG" S_DOMINIO="$DOMINIO"

python3 -I - <<'PY'
import os, sys
E = os.environ
subs = [("__REPO_SLUG__", E["S_REPO_SLUG"]), ("__REPO__", E["S_REPO"]), ("__HOME__", E["S_HOME"]),
        ("__UID__", E["S_UID"]), ("__USER__", E["S_USER"]), ("__NOMBRE_COMPLETO__", E["S_NOMBRE_COMPLETO"]),
        ("__NOMBRE__", E["S_NOMBRE"]), ("__EMAIL__", E["S_EMAIL"]), ("__DOMINIO__", E["S_DOMINIO"]),
        ("__ORG__", E["S_ORG"])]
skip = {".git", "node_modules", "vendor", "brain"}
n = 0
for dp, dn, fn in os.walk("."):
    dn[:] = [d for d in dn if d not in skip]
    for f in fn:
        p = os.path.join(dp, f)
        if f == "setup.sh": continue
        try: s = open(p, encoding="utf8").read()
        except Exception: continue
        o = s
        for a, b in subs: s = s.replace(a, b)
        if s != o: open(p, "w", encoding="utf8").write(s); n += 1
for dp, dn, fn in os.walk("."):
    dn[:] = [d for d in dn if d not in skip]
    for f in fn:
        if "__USER__" in f:
            os.rename(os.path.join(dp, f), os.path.join(dp, f.replace("__USER__", E["S_USER"])))
print(f"{n} archivos personalizados")
PY

chmod +x ops/*.sh ops/*.py panel/*.command 2>/dev/null || true

if [[ ! -d brain ]]; then
  cp -R brain-plantilla brain
  git -C brain init -q -b main
  git -C brain add -A
  git -C brain -c user.name="$NOMBRE_COMPLETO" -c user.email="$EMAIL" commit -qm "Cerebro vacío"
  print "Cerebro vacío creado en $REPO/brain (repo git independiente)."
fi
date +%F > .setup-hecho
print ""
print "Listo. Siguientes pasos en el README (apartado 3 en adelante): instalar GBrain, arrancar el panel e importar tu export de claude.ai."
