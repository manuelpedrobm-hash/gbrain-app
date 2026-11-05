#!/usr/bin/env python3
"""Sends ONE email that __NOMBRE__ reviewed and confirmed in the panel
(with --borrador: saves it in IONOS «Borradores» instead, sending nothing).

Reads the draft as JSON on stdin: {"para": [...], "cc": [...], "asunto": "...",
"cuerpo": "...", "responder_a_id": "INBOX|123"}; prints {"ok": true, "message_id": ...}
or {"ok": false, "error": "..."}. Only the panel's /api/correo/enviar runs it, after
a click on «Enviar»; agents never call it directly.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import correo  # noqa: E402

try:
    d = json.loads(sys.stdin.read() or "{}")
    fn = correo.save_draft if "--borrador" in sys.argv else correo.send
    mid = fn(d.get("para") or [], d.get("asunto"), d.get("cuerpo"), d.get("cc") or [], d.get("responder_a_id") or None)
    print(json.dumps({"ok": True, "message_id": mid}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
    sys.exit(1)
