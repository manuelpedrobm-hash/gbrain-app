"""Shared mail helpers for __NOMBRE__'s IONOS mailbox (__EMAIL__).

Used by correo-mcp.py (the panel agent's mail/calendar tools), correo-enviar.py
(sends a draft __NOMBRE__ confirmed in the panel) and gbrain-ingest-correo.py (the
daily copy into the brain).

Reading: IMAP, mailboxes opened read-only (EXAMINE), nothing is marked as read.
Sending: SMTP, plus a copy APPENDed to the Sent folder so it shows in Mail.
The password comes from the macOS Keychain (service "ionos-imap"); it is never
printed or written anywhere.
"""
import datetime as dt
import email
import email.header
import email.message
import email.utils
import imaplib
import json
import re
import smtplib
import subprocess
import functools
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

USER = "__EMAIL__"
FROM_NAME = "__NOMBRE_COMPLETO__"
IMAP_HOST = "imap.ionos.es"
SMTP_HOST = "smtp.ionos.es"
AGENDA_APP = "__REPO__/ops/bin/Agenda.app"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MADRID = ZoneInfo("Europe/Madrid")   # dates shown in Madrid time, whatever the Mac's clock
EMAIL_RE = re.compile(r"^[^@\s<>,;\"]+@[^@\s<>,;\"]+\.[A-Za-z]{2,}$")


def password():
    return subprocess.run(
        ["security", "find-generic-password", "-s", "ionos-imap", "-a", USER, "-w"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


# Transient network errors only. Authentication failures (imaplib.IMAP4.error
# without .abort, e.g. LOGIN rejected) are NOT included and fail immediately.
TRANSIENT = (ConnectionError, TimeoutError, OSError, imaplib.IMAP4.abort)
RETRY_WAITS = (5, 20, 60)   # seconds to wait before each of the 3 retries


def _with_retries(fn, reconnect=None):
    """Runs fn(); on a transient network error waits 5/20/60 s and tries again
    (up to 3 retries), calling reconnect() before each retry. Never logs secrets."""
    for i in range(len(RETRY_WAITS) + 1):
        try:
            return fn()
        except TRANSIENT as e:
            if i == len(RETRY_WAITS):
                raise
            wait = RETRY_WAITS[i]
            print(f"correo: error de red ({type(e).__name__}), reintento {i + 1}/{len(RETRY_WAITS)} en {wait}s",
                  file=sys.stderr, flush=True)
            time.sleep(wait)
            if reconnect:
                try:
                    reconnect()
                except TRANSIENT:
                    pass   # the next attempt will fail again and be retried or raised


def reconnecting(method):
    """Method decorator for read-only Mailbox operations: retries with reconnection."""
    @functools.wraps(method)
    def wrapper(self, *a, **kw):
        def attempt():
            if self.m is None:      # a previous reconnect failed: connect first
                self._connect()
            return method(self, *a, **kw)
        return _with_retries(attempt, self._connect)
    return wrapper


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
            except LookupError:
                out.append(p.decode("utf-8", "replace"))
        else:
            out.append(p)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def imap_date(d):
    return f"{d.day:02d}-{MONTHS[d.month - 1]}-{d.year}"


class Mailbox:
    def __init__(self):
        self.m = None
        self._sent = None
        _with_retries(self._connect)

    def _connect(self):
        if self.m is not None:
            try:
                self.m.logout()
            except Exception:
                pass
            self.m = None
        m = imaplib.IMAP4_SSL(IMAP_HOST)
        m.login(USER, password())
        self.m = m

    def close(self):
        try:
            self.m.logout()
        except Exception:
            pass

    def sent(self):
        if self._sent is None:
            _, rows = self.m.list()
            for r in rows:
                r = r.decode()
                if "\\Sent" in r:
                    self._sent = r.rsplit(' "/" ', 1)[-1].strip('"')
                    break
        return self._sent

    def boxes(self):
        return [b for b in ["INBOX", self.sent()] if b]

    def _examine(self, box):
        self.m.select(f'"{box}"', readonly=True)

    def _headers(self, box, uids):
        rows = []
        for uid in uids:
            _, d = self.m.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC SUBJECT MESSAGE-ID)])")
            if not d or not isinstance(d[0], tuple):
                continue
            h = email.message_from_bytes(d[0][1])
            try:
                when = email.utils.parsedate_to_datetime(h["Date"]).astimezone(MADRID)
            except Exception:
                when = None
            rows.append({
                "id": f"{box}|{uid.decode() if isinstance(uid, bytes) else uid}",
                "carpeta": "enviados" if box == self.sent() else "recibidos",
                "fecha": when.strftime("%Y-%m-%d %H:%M") if when else "?",
                "de": decode(h["From"]), "para": decode(h["To"]), "cc": decode(h["Cc"]),
                "asunto": decode(h["Subject"]),
            })
        return rows

    @reconnecting
    def search(self, text=None, since=None, before=None, limit=30):
        """Messages in INBOX + Sent whose From/To/Cc/Subject contains `text` (all if None)."""
        out = []
        for box in self.boxes():
            self._examine(box)
            dates = (["SINCE", imap_date(since)] if since else []) + (["BEFORE", imap_date(before)] if before else [])
            uids = set()
            if text:
                term = b'"' + text.replace('"', "").encode("utf-8") + b'"'
                for field in ["FROM", "TO", "CC", "SUBJECT"]:
                    _, d = self.m.uid("SEARCH", "CHARSET", "UTF-8", field, term, *dates)
                    uids.update(d[0].split())
            else:
                _, d = self.m.uid("SEARCH", *(dates or ["ALL"]))
                uids.update(d[0].split())
            out += self._headers(box, sorted(uids, key=int)[-limit:])
        out.sort(key=lambda r: r["fecha"], reverse=True)
        return out[:limit]

    @reconnecting
    def read(self, msg_id, max_chars=8000):
        box, _, uid = msg_id.rpartition("|")
        if box not in self.boxes() or not uid.isdigit():
            raise ValueError("id de correo no válido")
        self._examine(box)
        _, d = self.m.uid("FETCH", uid, "(BODY.PEEK[])")
        if not d or not isinstance(d[0], tuple):
            raise ValueError("no encuentro ese correo")
        msg = email.message_from_bytes(d[0][1])
        try:
            when = email.utils.parsedate_to_datetime(msg["Date"]).astimezone(MADRID).strftime("%Y-%m-%d %H:%M")
        except Exception:
            when = "?"
        attachments = [decode(p.get_filename()) for p in msg.walk()
                       if p.get_filename() and not decode(p.get_filename()).startswith(("OutlookEmoji", "image0", "Outlook-"))]
        return {
            "id": msg_id, "fecha": when, "de": decode(msg["From"]), "para": decode(msg["To"]),
            "cc": decode(msg["Cc"]), "asunto": decode(msg["Subject"]),
            "message_id": (msg["Message-ID"] or "").strip(), "references": decode(msg["References"]),
            "adjuntos": attachments, "cuerpo": clean_body(body_text(msg))[:max_chars],
            "masivo": bool(msg["List-Unsubscribe"] or re.match(r"(?i)bulk|list|junk", msg["Precedence"] or "")),
        }

    def drafts(self):
        _, rows = self.m.list()
        for r in rows:
            r = r.decode()
            if "\\Drafts" in r:
                return r.rsplit(' "/" ', 1)[-1].strip('"')
        return None

    def append_draft(self, raw_bytes):
        box = self.drafts()
        if not box:
            raise RuntimeError("no encuentro la carpeta Borradores")
        self.m.append(f'"{box}"', "\\Draft \\Seen", imaplib.Time2Internaldate(time.time()), raw_bytes)

    def append_sent(self, raw_bytes):
        box = self.sent()
        if box:
            self.m.append(f'"{box}"', "\\Seen", imaplib.Time2Internaldate(time.time()), raw_bytes)


def body_text(msg):
    for part in msg.walk():
        if part.get_content_type() == "text/plain" and not part.get_filename():
            data = part.get_payload(decode=True) or b""
            return data.decode(part.get_content_charset() or "utf-8", "replace")
    for part in msg.walk():
        if part.get_content_type() == "text/html" and not part.get_filename():
            data = part.get_payload(decode=True) or b""
            html = data.decode(part.get_content_charset() or "utf-8", "replace")
            html = re.sub(r"(?is)<(style|script|head)[^>]*>.*?</\1>", " ", html)
            html = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", html)
            return re.sub(r"<[^>]+>", " ", html).replace("&nbsp;", " ").replace("&amp;", "&")
    return ""


def clean_body(text):
    text = re.sub(r"<?https?://\S{90,}>?", "[enlace]", text)      # tracking links
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def strip_quoted(text):
    """Drops the quoted thread below a reply ("On … wrote:", "El … escribió:", "> …")."""
    cut = re.search(r"(?m)^\s*(On .{5,200}wrote:|El .{5,200}escribi[oó]:|-{2,} ?Original Message|De: .+\n.*Enviado)", text)
    if cut:
        text = text[:cut.start()]
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith(">")).strip()


def agenda(start=None, days=14):
    start = start or dt.date.today()
    # Launched through LaunchServices (`open`) so that Agenda.app, not the panel's
    # background process, is the one macOS asks for Calendar permission.
    with tempfile.NamedTemporaryFile("r", suffix=".json") as f:
        subprocess.run(["/usr/bin/open", "-g", "-n", "-W", "--stdout", f.name, "--stderr", f.name, "-a", AGENDA_APP,
                        "--args", start.isoformat(), str(days)], capture_output=True, text=True, timeout=60)
        text = f.read().strip()
    try:
        out = json.loads(text)
    except ValueError:
        raise RuntimeError(text[:300] or "no pude leer el Calendario")
    if out.get("error"):
        raise RuntimeError(out["error"])
    # The Mac's clock may be on travel time: add Madrid time, which is what __NOMBRE__ plans in.
    src, mad = ZoneInfo(out.get("zona") or "UTC"), ZoneInfo("Europe/Madrid")
    for ev in out.get("eventos", []):
        if not ev.get("todo_el_dia"):
            for k in ("inicio", "fin"):
                t = dt.datetime.strptime(ev[k], "%Y-%m-%d %H:%M").replace(tzinfo=src)
                ev[k + "_madrid"] = t.astimezone(mad).strftime("%Y-%m-%d %H:%M")
    return out


def parse_addresses(values):
    out = []
    for v in values or []:
        for name, addr in email.utils.getaddresses([str(v)]):
            addr = addr.strip()
            if not EMAIL_RE.match(addr):
                raise ValueError(f"dirección no válida: {v}")
            out.append(email.utils.formataddr((name, addr)) if name else addr)
    return out


def _build(mb, to, subject, body, cc=None, reply_to_id=None, draft=False):
    to, cc = parse_addresses(to), parse_addresses(cc)
    if not to and not draft:
        raise ValueError("falta el destinatario")
    if len(to) + len(cc) > 10:
        raise ValueError("demasiados destinatarios (máximo 10)")
    subject = (subject or "").strip()
    if not subject or not (body or "").strip():
        raise ValueError("faltan el asunto o el texto")
    msg = email.message.EmailMessage()
    msg["From"] = email.utils.formataddr((FROM_NAME, USER))
    if to:
        msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain="__DOMINIO__")
    if reply_to_id:
        orig = mb.read(reply_to_id, max_chars=0)
        if orig["message_id"]:
            msg["In-Reply-To"] = orig["message_id"]
            msg["References"] = (orig["references"] + " " + orig["message_id"]).strip()
    msg.set_content(body.strip() + "\n")
    return msg


def save_draft(to, subject, body, cc=None, reply_to_id=None):
    """Files the email in IONOS «Borradores» (it shows in Mail as a draft). Sends nothing."""
    mb = Mailbox()
    try:
        msg = _build(mb, to, subject, body, cc, reply_to_id, draft=True)
        mb.append_draft(msg.as_bytes())
    finally:
        mb.close()
    return msg["Message-ID"]


def send(to, subject, body, cc=None, reply_to_id=None):
    """Sends one plain-text email as __NOMBRE__ and files a copy in Sent. Returns the Message-ID."""
    mb = Mailbox()
    try:
        msg = _build(mb, to, subject, body, cc, reply_to_id)
        with smtplib.SMTP_SSL(SMTP_HOST, 465, timeout=60) as s:
            s.login(USER, password())
            s.send_message(msg)
        try:
            mb.append_sent(msg.as_bytes())
        except Exception:
            pass   # sent anyway; only the copy in Sent is missing
    finally:
        mb.close()
    return msg["Message-ID"]
