#!/usr/bin/env python3
"""Read-only IMAP access to __NOMBRE__'s IONOS mailbox.

Password comes from the macOS Keychain (service "ionos-imap"); it is never
printed or written anywhere. Mailboxes are opened with EXAMINE (read-only),
so nothing is marked as read, moved or deleted.

Usage:
  ionos-imap.py USER folders
  ionos-imap.py USER search "Apellido"   # From/To/Cc/Subject in INBOX + Sent
  ionos-imap.py USER read "Apellido" [SINCE]   # same, with plain-text bodies (SINCE e.g. 01-Sep-2026)
"""
import email
import email.header
import email.utils
import imaplib
import re
import subprocess
import sys

HOST = "imap.ionos.es"


def password(user):
    return subprocess.run(
        ["security", "find-generic-password", "-s", "ionos-imap", "-a", user, "-w"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def decode(value):
    try:
        parts = email.header.decode_header(str(value or ""))
    except Exception:
        return str(value or "")
    out = []
    for p, enc in parts:
        if isinstance(p, bytes):
            try:
                out.append(p.decode(enc or "utf-8", "replace"))
            except LookupError:  # e.g. unknown-8bit
                out.append(p.decode("utf-8", "replace"))
        else:
            out.append(p)
    return "".join(out)


def connect(user):
    m = imaplib.IMAP4_SSL(HOST)
    m.login(user, password(user))
    return m


def folders(m):
    _, rows = m.list()
    return [r.decode() for r in rows]


def sent_folder(m):
    for r in folders(m):
        if "\\Sent" in r:
            return r.rsplit(' "/" ', 1)[-1].strip('"')
    return None


def body(msg):
    for part in msg.walk():
        if part.get_content_type() == "text/plain" and not part.get_filename():
            data = part.get_payload(decode=True) or b""
            return data.decode(part.get_content_charset() or "utf-8", "replace")
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            data = part.get_payload(decode=True) or b""
            text = data.decode(part.get_content_charset() or "utf-8", "replace")
            return re.sub(r"<[^>]+>", " ", text)
    return ""


def search(m, term, since=None, bodies=False):
    for box in ["INBOX", sent_folder(m)]:
        if not box:
            continue
        m.select(f'"{box}"', readonly=True)
        ids = set()
        for field in ["FROM", "TO", "CC", "SUBJECT"]:
            crit = [field, b'"' + term.replace('"', "").encode("utf-8") + b'"'] + (["SINCE", since] if since else [])
            _, data = m.search("UTF-8", *crit)
            ids.update(data[0].split())
        rows = []
        for i in ids:
            if bodies:
                _, d = m.fetch(i, "(BODY.PEEK[])")
                msg = email.message_from_bytes(d[0][1])
                dt = email.utils.parsedate_to_datetime(msg["Date"])
                rows.append((dt.isoformat()[:16], decode(msg["From"]), decode(msg["To"]),
                             decode(msg["Subject"]), body(msg)))
                continue
            _, d = m.fetch(i, "(BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT)])")
            h = email.message_from_bytes(d[0][1])
            dt = email.utils.parsedate_to_datetime(h["Date"]) if h["Date"] else None
            rows.append((dt.isoformat()[:10] if dt else "?", decode(h["From"]),
                         decode(h["To"]), decode(h["Subject"])))
        print(f"## {box}: {len(rows)}")
        for r in sorted(rows):
            if bodies:
                print(f"\n=== {r[0]} | From: {r[1]} | To: {r[2]} | {r[3]}\n{r[4].strip()}")
            else:
                print(" | ".join(r))


if __name__ == "__main__":
    user, cmd = sys.argv[1], sys.argv[2]
    m = connect(user)
    if cmd == "folders":
        print("\n".join(folders(m)))
    elif cmd == "search":
        search(m, sys.argv[3])
    elif cmd == "read":
        search(m, sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None, bodies=True)
    m.logout()
