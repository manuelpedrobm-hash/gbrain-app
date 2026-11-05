#!/usr/bin/env python3
"""Hook PreToolUse de la FASE 2 del asistente de formularios (solo para mcp__claude-in-chrome__computer).

Deja pasar solo acciones de mirar (screenshot, zoom, scroll, scroll_to, wait) y UN unico left_click
sobre el elemento cuyo ref sea EXACTAMENTE el boton_ref que __NOMBRE__ aprobo (sin modificadores, sin
texto, sin coordenadas). El boton_ref no llega por el prompt: el servidor lo escribe, al aprobar, en
el archivo de la variable ASISTENTE_APROBACION ({"id","hash","boton_ref"}), que solo lee este hook.
Todo lo demas (teclear, Enter, atajos, arrastrar, doble clic, clic derecho, clic por coordenadas,
clic en otro ref) se rechaza.

El "un solo clic" se hace cumplir creando el archivo de la variable ASISTENTE_CLICKFILE con O_EXCL:
el segundo intento falla. El archivo solo se crea cuando el ref ya se comprobo, de modo que un clic
rechazado por ref distinto no gasta el unico clic. El panel mira si ese archivo existe para saber si
hubo clic de verdad.

Falla cerrado: sin variables, sin archivo de aprobacion valido, sin JSON valido o cualquier error = rechazar (exit 2).
"""
import json
import os
import re
import sys

LIBRES = {"screenshot", "zoom", "scroll", "scroll_to", "wait"}
REF_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,60}$")


def rechazar(motivo):
    sys.stderr.write("Accion no permitida en la fase de envio (%s). Solo puedes mirar y hacer un unico clic en el boton aprobado (su ref exacto).\n" % motivo)
    sys.exit(2)


def ref_aprobado():
    ruta = os.environ.get("ASISTENTE_APROBACION", "")
    if not ruta or not os.path.isabs(ruta):
        rechazar("sin aprobacion para esta ejecucion")
    try:
        with open(ruta, encoding="utf-8") as f:
            d = json.load(f)
        ref = d["boton_ref"]
        if not isinstance(ref, str) or not REF_RE.match(ref):
            raise ValueError("boton_ref")
        return ref
    except Exception:
        rechazar("archivo de aprobacion ilegible")


def main():
    try:
        datos = json.loads(sys.stdin.read())
        if not isinstance(datos, dict):
            raise ValueError("no es objeto")
        entrada = datos.get("tool_input", {})
        if not isinstance(entrada, dict):
            raise ValueError("tool_input")
    except Exception:
        rechazar("entrada del hook ilegible")
    accion = str(entrada.get("action", ""))
    if accion in LIBRES:
        sys.exit(0)
    if accion != "left_click":
        rechazar("accion " + (accion or "vacia"))
    if entrada.get("modifiers") or entrada.get("text") or entrada.get("coordinate") or entrada.get("start_coordinate"):
        rechazar("el clic debe ser por ref, sin modificadores ni coordenadas")
    ref = entrada.get("ref")
    if not isinstance(ref, str) or not ref:
        rechazar("falta ref")
    if ref != ref_aprobado():
        rechazar("ese ref no es el del boton aprobado")
    ruta = os.environ.get("ASISTENTE_CLICKFILE", "")
    if not ruta or not os.path.isabs(ruta):
        rechazar("sin permiso de clic para esta ejecucion")
    try:
        fd = os.open(ruta, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        rechazar("el unico clic ya se hizo")
    except Exception:
        rechazar("no se pudo reservar el clic")
    try:
        os.write(fd, b"clic\n")
    finally:
        os.close(fd)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        sys.stderr.write("Error inesperado en hook-fase2: se rechaza por seguridad.\n")
        sys.exit(2)
