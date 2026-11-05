#!/usr/bin/env python3
"""Hook PreToolUse de Claude Code para el asistente de formularios (Claude in Chrome).

Lee el JSON del hook por stdin, busca URLs en tool_input (tambien anidadas) y las valida
contra ~/.gbrain-coach/formularios-dominios.json. Si no esta permitido: exit 2 y mensaje
en stderr (Claude Code lo bloquea y se lo cuenta al agente). Falla cerrado: JSON roto,
lista ilegible o cualquier error inesperado = rechazar.

Uso: /usr/bin/python3 -I __REPO__/ops/chrome-dominios.py
(solo para pruebas: --lista RUTA --log RUTA)

El log (~/Backups/gbrain/formularios.log) guarda fecha, decision, herramienta, dominio y
motivo. Nunca rutas, parametros ni contenido de formularios.
"""
import ipaddress
import json
import os
import re
import sys
from datetime import datetime
from urllib.parse import urlsplit

HOME = os.path.expanduser("~")
LISTA = os.path.join(HOME, ".gbrain-coach", "formularios-dominios.json")
LOG = os.path.join(HOME, "Backups", "gbrain", "formularios.log")

# Herramientas que SIEMPRE necesitan URL valida (si falta, se rechaza)
NECESITAN_URL = ("navigate", "tabs_create_mcp")
# tabs_create_mcp sin url abre una pestana en blanco: inofensivo
SIN_URL_OK = ("tabs_create_mcp",)

ACORTADORES = {
    "bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly",
    "cutt.ly", "shorturl.at", "t.ly", "lnkd.in", "rb.gy", "bit.do", "tiny.cc", "s.id",
    "v.gd", "shorte.st", "adf.ly", "tr.im", "u.to", "qr.ae", "soo.gd", "clck.ru",
}
ESQUEMAS_PELIGROSOS = re.compile(
    r"^\s*(javascript|data|blob|about|chrome|chrome-extension|view-source|ftp|mailto|tel|vbscript|filesystem):",
    re.I)
CON_ESQUEMA = re.compile(r"^\s*([a-z][a-z0-9+.\-]*)://", re.I)
# archivos locales solo de pruebas
FILE_OK = ("/private/tmp/", "/tmp/", "__REPO__/panel/test/")


def log(decision, tool, host, motivo):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        corto = (tool or "?").replace("mcp__claude-in-chrome__", "")
        linea = "%s %s tool=%s host=%s motivo=%s\n" % (
            datetime.now().astimezone().isoformat(timespec="seconds"),
            decision, corto, host or "-", motivo)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(linea)
    except Exception:
        pass  # el log no puede tumbar ni abrir la puerta


def rechazar(tool, host, motivo, mensaje=None):
    log("RECHAZADO", tool, host, motivo)
    sys.stderr.write(
        (mensaje or "Dominio no aprobado: pide a __NOMBRE__ que lo apruebe.")
        + " (%s). No navegues ahi ni intentes otra via; avisa a __NOMBRE__ por Telegram.\n" % motivo)
    sys.exit(2)


def buscar_urls(obj, claves_url=True, acc=None):
    """Valores de claves url/uri/href/link/target_url a cualquier nivel (por ejemplo dentro de
    browser_batch). No se mira el texto libre que se teclea en formularios."""
    if acc is None:
        acc = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and str(k).lower() in ("url", "uri", "href", "link", "target_url"):
                acc.append(v)
            else:
                buscar_urls(v, claves_url, acc)
    elif isinstance(obj, list):
        for v in obj:
            buscar_urls(v, claves_url, acc)
    return acc


def cargar_lista(ruta):
    with open(ruta, encoding="utf-8") as f:
        d = json.load(f)
    if not isinstance(d["permitidos"], list) or not isinstance(d["bloqueados"], list):
        raise ValueError("lista mal formada")
    perm = [str(x).strip().lower().rstrip(".") for x in d["permitidos"]]
    bloq = [str(x).strip().lower() for x in d["bloqueados"]]
    return perm, bloq


def coincide(host, dom):
    return host == dom or host.endswith("." + dom)


def bloqueado(host, bloq):
    for b in bloq:
        if not b:
            continue
        if b in host:  # patron: texto dentro del dominio (falla cerrado)
            return b
    return None


def validar(url, perm, bloq):
    """Devuelve (host, None) si vale; (host, motivo) si no."""
    u = url.strip()
    if not u:
        return None, "url vacia"
    if ESQUEMAS_PELIGROSOS.match(u):
        return None, "esquema no permitido"
    m = CON_ESQUEMA.match(u)
    if m:
        esquema = m.group(1).lower()
    else:
        if re.match(r"^[a-z][a-z0-9+.\-]*:(?!\d+(/|$))", u, re.I):
            return None, "esquema no permitido"
        u = "https://" + u.lstrip("/")
        esquema = "https"
    if esquema == "file":
        # Production: file: is never allowed (percent-encoded .. bypassed the old path check).
        # Local tests use http://127.0.0.1:<port>/ instead.
        return None, "file no permitido"
    if esquema not in ("http", "https"):
        return None, "esquema no permitido"
    try:
        p = urlsplit(u)
        netloc = p.netloc
        host = p.hostname
        p.port  # fuerza error si el puerto es raro
    except Exception:
        return None, "url ilegible"
    if not host:
        return None, "sin dominio"
    if "@" in netloc:
        return host, "url con usuario@ (engano posible)"
    host = host.lower().rstrip(".")
    try:
        host = host.encode("ascii").decode("ascii")
    except UnicodeError:
        try:
            host = host.encode("idna").decode("ascii")
        except Exception:
            return host, "dominio no ascii"
        return host, "dominio internacional (posible suplantacion)"
    if "xn--" in host:
        return host, "dominio punycode (posible suplantacion)"
    if host in ACORTADORES or any(coincide(host, a) for a in ACORTADORES):
        return host, "acortador de enlaces"
    b = bloqueado(host, bloq)
    if b:
        return host, "dominio bloqueado (%s)" % b
    es_ip = False
    try:
        ipaddress.ip_address(host)
        es_ip = True
    except ValueError:
        if re.fullmatch(r"[0-9a-fx.]+", host) and re.search(r"\d", host):
            es_ip = True  # formas raras de IP (decimal, hex, octal)
    if es_ip:
        if host in perm:  # solo 127.0.0.1 / ::1 si estan en la lista
            return host, None
        return host, "IP directa"
    if any(coincide(host, d) for d in perm):
        return host, None
    return host, "dominio no esta en la lista aprobada"


def main():
    global LISTA, LOG
    a = sys.argv[1:]
    while a:
        if a[0] == "--lista" and len(a) > 1:
            LISTA = a[1]
            a = a[2:]
        elif a[0] == "--log" and len(a) > 1:
            LOG = a[1]
            a = a[2:]
        else:
            a = a[1:]

    tool = None
    try:
        datos = json.loads(sys.stdin.read())
        if not isinstance(datos, dict):
            raise ValueError("no es un objeto")
        tool = str(datos.get("tool_name", ""))
        entrada = datos.get("tool_input", {})
    except Exception:
        rechazar(tool, None, "JSON del hook ilegible", "Entrada del hook no valida: se rechaza por seguridad.")

    base = tool.split("__")[-1]
    try:
        urls = buscar_urls(entrada)
    except Exception:
        rechazar(tool, None, "no se pudo leer tool_input")

    if not urls:
        if base in NECESITAN_URL and base not in SIN_URL_OK:
            rechazar(tool, None, "falta la url")
        log("PERMITIDO", tool, None, "sin url (%s)" % ("pestana en blanco" if base in SIN_URL_OK else "accion sin url"))
        sys.exit(0)

    try:
        perm, bloq = cargar_lista(LISTA)
    except Exception:
        rechazar(tool, None, "lista de dominios ilegible",
                 "No se puede leer la lista de dominios aprobados: se rechaza por seguridad.")

    ultimo = None
    for u in urls:
        try:
            host, motivo = validar(u, perm, bloq)
        except Exception:
            host, motivo = None, "error al validar"
        ultimo = host
        if motivo:
            rechazar(tool, host, motivo)
    log("PERMITIDO", tool, ultimo, "dominio aprobado")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        sys.stderr.write("Error inesperado en el hook de dominios: se rechaza por seguridad.\n")
        sys.exit(2)
