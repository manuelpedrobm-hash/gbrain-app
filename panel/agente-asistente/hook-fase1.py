#!/usr/bin/env python3
"""Hook PreToolUse de la FASE 1 del asistente de formularios (navigate y tabs_create_mcp).

Complementa a ops/chrome-dominios.py (que valida el dominio): aqui se impide navegar a una URL con
parametros de consulta (?x=...) que __NOMBRE__ no dio. Las URLs de la peticion (campo url del panel y las
que aparezcan en la tarea) llegan en la variable ASISTENTE_URLS como lista JSON. Una URL sin query ni
fragmento de un dominio aprobado pasa (el dominio lo comprueba el otro hook); una URL con query o
fragmento solo pasa si es EXACTAMENTE una de la peticion.

Limite conocido (SPEC.md): no impide navegar a otras rutas sin parametros de un dominio aprobado.
Falla cerrado: JSON ilegible o variable mal formada = rechazar (exit 2).
"""
import json
import os
import sys
from urllib.parse import urlsplit


def rechazar(motivo):
    sys.stderr.write("URL no permitida en la fase de preparacion (%s). Usa solo la URL que dio __NOMBRE__, sin anadir ni cambiar parametros.\n" % motivo)
    sys.exit(2)


def norm(u):
    return u.strip().rstrip("/")


def main():
    try:
        datos = json.loads(sys.stdin.read())
        entrada = datos.get("tool_input", {}) if isinstance(datos, dict) else None
        if not isinstance(entrada, dict):
            raise ValueError("tool_input")
    except Exception:
        rechazar("entrada del hook ilegible")
    url = entrada.get("url")
    if url is None or url == "":
        sys.exit(0)  # pestana en blanco
    if not isinstance(url, str):
        rechazar("url no es texto")
    try:
        permitidas = json.loads(os.environ.get("ASISTENTE_URLS", "[]") or "[]")
        if not isinstance(permitidas, list) or not all(isinstance(x, str) for x in permitidas):
            raise ValueError("lista")
    except Exception:
        rechazar("lista de URLs de la peticion ilegible")
    try:
        p = urlsplit(url.strip() if "://" in url else "https://" + url.strip().lstrip("/"))
    except Exception:
        rechazar("url ilegible")
    if p.query or p.fragment or "?" in url or "#" in url:
        if norm(url) in {norm(x) for x in permitidas}:
            sys.exit(0)
        rechazar("parametros de consulta que __NOMBRE__ no dio")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        sys.stderr.write("Error inesperado en hook-fase1: se rechaza por seguridad.\n")
        sys.exit(2)
