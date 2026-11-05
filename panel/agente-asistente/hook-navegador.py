#!/usr/bin/env python3
"""Hook PreToolUse para mcp__claude-in-chrome__select_browser en el asistente de formularios.

Con varios navegadores conectados a la cuenta, la extension exige elegir uno. Aqui solo se deja elegir
el que __NOMBRE__ fijo en ~/.gbrain-panel/asistente.json (navegadorId), que el panel pasa por la variable
ASISTENTE_NAVEGADOR. Cualquier otro deviceId, o sin variable, se rechaza. Falla cerrado.
"""
import json
import os
import sys

try:
    datos = json.loads(sys.stdin.read())
    quiero = str(datos.get("tool_input", {}).get("deviceId", ""))
    permitido = os.environ.get("ASISTENTE_NAVEGADOR", "")
    if permitido and quiero == permitido:
        sys.exit(0)
    sys.stderr.write("Solo puedes elegir el navegador que __NOMBRE__ configuro para el asistente.\n")
    sys.exit(2)
except SystemExit:
    raise
except BaseException:
    sys.stderr.write("Error en hook-navegador: se rechaza por seguridad.\n")
    sys.exit(2)
