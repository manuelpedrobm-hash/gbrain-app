"""Timed reminders for __NOMBRE__'s Telegram agent.

The agent schedules reminders with `add`; launchd runs ops/agente-recordatorios.sh every
5 minutes, which calls `due` and sends each due reminder into the agent's session.

  python3 -I recordatorios.py add --cuando 17:00 --texto "Llamar a Sonia" [--intento 2]
  python3 -I recordatorios.py list
  python3 -I recordatorios.py done <id>        # __NOMBRE__ did it: stop chasing
  python3 -I recordatorios.py cancel <id>
  python3 -I recordatorios.py due              # used by the checker; marks them sent

--cuando accepts "HH:MM" (today, or tomorrow if that time has passed),
"YYYY-MM-DD HH:MM", or a delay like "+45m" / "+2h". Times are the Mac's local time.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile

STATE = os.path.expanduser("~/.gbrain-coach/recordatorios.json")


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save(items):
    os.makedirs(os.path.dirname(STATE), mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STATE))
    with os.fdopen(fd, "w") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def parse_when(s, now):
    s = s.strip()
    m = re.fullmatch(r"\+(\d+)\s*([mh])", s)
    if m:
        n = int(m.group(1))
        return now + (dt.timedelta(minutes=n) if m.group(2) == "m" else dt.timedelta(hours=n))
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", s)
    if m:
        t = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        return t if t > now else t + dt.timedelta(days=1)
    return dt.datetime.strptime(s, "%Y-%m-%d %H:%M")


def fmt(r):
    return f"#{r['id']} {r['cuando']} [{r['estado']}, intento {r['intento']}] {r['texto']}"


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--cuando", required=True)
    a.add_argument("--texto", required=True)
    a.add_argument("--intento", type=int, default=1)
    sub.add_parser("list")
    sub.add_parser("due")
    for c in ("done", "cancel"):
        sub.add_parser(c).add_argument("id", type=int)
    args = p.parse_args()

    now = dt.datetime.now()
    items = load()

    if args.cmd == "add":
        try:
            when = parse_when(args.cuando, now)
        except ValueError:
            sys.exit(f"No entiendo la hora «{args.cuando}». Usa HH:MM, AAAA-MM-DD HH:MM o +45m.")
        rid = max((r["id"] for r in items), default=0) + 1
        r = {"id": rid, "cuando": when.strftime("%Y-%m-%d %H:%M"), "texto": args.texto.strip()[:500],
             "intento": args.intento, "estado": "pendiente", "creado": now.strftime("%Y-%m-%d %H:%M")}
        items.append(r)
        save(items)
        print("Programado:", fmt(r))
    elif args.cmd == "list":
        active = [r for r in items if r["estado"] in ("pendiente", "enviado")]
        print("\n".join(fmt(r) for r in sorted(active, key=lambda r: r["cuando"])) or "No hay recordatorios activos.")
    elif args.cmd in ("done", "cancel"):
        for r in items:
            if r["id"] == args.id:
                r["estado"] = "hecho" if args.cmd == "done" else "cancelado"
                save(items)
                print("Actualizado:", fmt(r))
                break
        else:
            sys.exit(f"No existe el recordatorio #{args.id}.")
    elif args.cmd == "due":
        due = [r for r in items if r["estado"] == "pendiente"
               and dt.datetime.strptime(r["cuando"], "%Y-%m-%d %H:%M") <= now]
        for r in due:
            r["estado"] = "enviado"
        if due:
            save(items)
        print(json.dumps(due, ensure_ascii=False))


if __name__ == "__main__":
    main()
