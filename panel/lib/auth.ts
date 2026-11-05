// lib/auth.ts — Host check, one-time login nonce, HMAC cookie and CSRF rules
// (spec §4.1–4.3).
//
// Flow: "Abrir panel.command" POSTs the secret (from ~/.gbrain-panel/secret,
// sent through stdin so it never shows in `ps`) to /api/login-nonce, gets a
// nonce valid once for 60 s, and opens /login?n=<nonce>.
//
// Sessions (security audit 2026-10-26; replaces the spec's fixed
// HMAC(secret,"panel-v1") cookie, which was the same for every login and could
// not be revoked): /login mints a random 256-bit token per login and sets
// panel=<token> for 30 days. The server keeps only HMAC-SHA256(secret, token)
// with its expiry, in memory and in ~/.gbrain-panel/sessions.json (0600), so a
// copy of that file is not a usable cookie. POST /api/logout deletes the
// session on the server, not just in the browser. Replacing the secret file
// still logs every session out (no stored key matches any more).
//
// Cookies are not isolated by port, so the browser also sends this cookie to
// other services on 127.0.0.1; the short life and real logout limit the damage.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const MAX_BODY_BYTES = 64 * 1024;
const COOKIE_NAME = "panel";
export const SESSION_TTL_MS = 30 * 86400_000;          // 30 days
const COOKIE_MAX_AGE = SESSION_TTL_MS / 1000;
const MAX_SESSIONS = 20;                                 // oldest dropped beyond this
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface AuthOptions {
  /** Returns the current secret (hex). Empty string means "no secret": nobody gets in. */
  getSecret: () => string;
  port?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  nonceTtlMs?: number;
  /** Where sessions survive a restart (0600 JSON). Omitted: memory only (tests). */
  sessionsFile?: string;
  sessionTtlMs?: number;
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Creates the secret file (0600, 32 random bytes hex) if it does not exist yet. */
export function ensureSecretFile(path: string): void {
  if (existsSync(path)) return;
  try {
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
}

/** Reads the secret, re-reading only when the file changes (mtime/size). */
export function secretFromFile(path: string): () => string {
  let cache: { mtimeMs: number; size: number; value: string } | null = null;
  return () => {
    try {
      const st = statSync(path);
      if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
        cache = { mtimeMs: st.mtimeMs, size: st.size, value: readFileSync(path, "utf8").trim() };
      }
      return cache.value;
    } catch {
      cache = null;
      return "";
    }
  };
}

function jsonError(status: number, code: string, message_es: string): Response {
  return new Response(JSON.stringify({ error: { code, message_es } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const LOGIN_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cerebro</title></head>
<body><h1>Cerebro</h1><p>Abre el panel con «Abrir panel».</p>
<p>Si no funciona, el panel quizá no está en marcha: <code>launchctl kickstart -k gui/__UID__/com.__USER__.gbrain-panel</code></p>
</body></html>`;

function htmlUnauthorized(): Response {
  return new Response(LOGIN_HTML, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createAuth(opts: AuthOptions) {
  const port = opts.port ?? 3140;
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.nonceTtlMs ?? 60_000;
  const ORIGIN = `http://127.0.0.1:${port}`;
  const HOST_OK = `127.0.0.1:${port}`;
  const HOST_REDIRECT = `localhost:${port}`;
  const sessionTtl = opts.sessionTtlMs ?? SESSION_TTL_MS;
  const nonces = new Map<string, number>(); // nonce -> expiry (ms)
  const sessions = loadSessions();          // HMAC(secret, token) hex -> expiry (ms)

  function loadSessions(): Map<string, number> {
    const m = new Map<string, number>();
    if (!opts.sessionsFile) return m;
    try {
      const raw = JSON.parse(readFileSync(opts.sessionsFile, "utf8"));
      for (const [k, exp] of Object.entries(raw?.s ?? {})) {
        if (/^[0-9a-f]{64}$/.test(k) && typeof exp === "number") m.set(k, exp);
      }
    } catch { /* first run or unreadable: nobody is logged in */ }
    return m;
  }

  function saveSessions(): void {
    if (!opts.sessionsFile) return;
    try {
      const tmp = opts.sessionsFile + ".tmp";
      writeFileSync(tmp, JSON.stringify({ v: 1, s: Object.fromEntries(sessions) }), { mode: 0o600 });
      renameSync(tmp, opts.sessionsFile);
    } catch (e: any) {
      // Logins still work for this process; they just will not survive a restart.
      console.error(`[cerebro] no pude guardar las sesiones: ${String(e?.code ?? e?.message ?? e).slice(0, 80)}`);
    }
  }

  /** The stored form of a session token: HMAC-SHA256 keyed with the current secret. */
  function sessionKey(token: string): string | null {
    const secret = opts.getSecret();
    if (!secret) return null;
    const key = /^[0-9a-f]+$/i.test(secret) && secret.length % 2 === 0 ? Buffer.from(secret, "hex") : Buffer.from(secret);
    return createHmac("sha256", key).update("session-v2:" + token).digest("hex");
  }

  function pruneSessions(): void {
    const t = now();
    for (const [k, exp] of sessions) if (exp <= t) sessions.delete(k);
    // Map keeps insertion order, so the first keys are the oldest logins.
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  }

  function cookieToken(req: Request): string | null {
    const got = parseCookies(req.headers.get("cookie"))[COOKIE_NAME];
    return got && TOKEN_RE.test(got) ? got : null;
  }

  function isAuthed(req: Request): boolean {
    const token = cookieToken(req);
    if (!token) return false;
    const key = sessionKey(token);
    if (!key) return false;
    const exp = sessions.get(key);
    if (exp === undefined) return false;
    if (exp <= now()) { sessions.delete(key); saveSessions(); return false; }
    return true;
  }

  /** Creates a session and returns its cookie token, or null when there is no secret. */
  function newSession(): string | null {
    const token = randomBytes(32).toString("hex");
    const key = sessionKey(token);
    if (!key) return null;
    pruneSessions();
    sessions.set(key, now() + sessionTtl);
    pruneSessions();
    saveSessions();
    return token;
  }

  function pruneNonces() {
    const t = now();
    for (const [n, exp] of nonces) if (exp <= t) nonces.delete(n);
  }

  /** 421 for a foreign Host; 302 localhost → 127.0.0.1 (GET only), so there is one cookie origin. */
  function checkHost(req: Request, url: URL): Response | null {
    const host = req.headers.get("host") ?? "";
    if (host === HOST_OK) return null;
    if (host === HOST_REDIRECT && (req.method === "GET" || req.method === "HEAD")) {
      return new Response(null, { status: 302, headers: { Location: `${ORIGIN}${url.pathname}${url.search}` } });
    }
    return new Response("Misdirected Request", { status: 421, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  /** POST /api/login-nonce with header X-Panel-Secret → text/plain nonce. */
  function handleLoginNonce(req: Request): Response {
    if (req.method !== "POST") return jsonError(405, "method", "Método no permitido");
    // A browser always sends Origin on POST: refusing it keeps web pages from minting nonces.
    if (req.headers.has("origin")) return jsonError(403, "origin", "Origen no permitido");
    const secret = opts.getSecret();
    const given = req.headers.get("x-panel-secret") ?? "";
    if (!secret || !given || !safeEqual(given.trim(), secret)) return jsonError(401, "unauthorized", "Secreto incorrecto");
    pruneNonces();
    if (nonces.size > 50) nonces.clear(); // only secret holders get here; keep it bounded anyway
    const nonce = randomBytes(24).toString("hex");
    nonces.set(nonce, now() + ttl);
    return new Response(nonce, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  /** Consumes a nonce exactly once. */
  function consumeNonce(n: string | null): boolean {
    if (!n || !/^[0-9a-f]{48}$/.test(n)) return false;
    const exp = nonces.get(n);
    nonces.delete(n);
    return exp !== undefined && exp > now();
  }

  /** GET /login?n= → cookie + 302 /, or 401 HTML. */
  function handleLogin(url: URL): Response {
    if (!opts.getSecret() || !consumeNonce(url.searchParams.get("n"))) return htmlUnauthorized();
    const value = newSession();
    if (!value) return htmlUnauthorized();
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
      },
    });
  }

  /** Deletes this browser's session on the server and tells the browser to drop the cookie. */
  function logoutResponse(req?: Request): Response {
    const token = req ? cookieToken(req) : null;
    const key = token ? sessionKey(token) : null;
    if (key && sessions.delete(key)) saveSessions();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      },
    });
  }

  /**
   * Runs before every route. Returns a Response to stop the request, or null to continue.
   * Order: Host → public routes → cookie → CSRF (non-GET).
   */
  function guard(req: Request, url: URL): Response | null {
    const host = checkHost(req, url);
    if (host) return host;
    // Browsers ask for /favicon.ico on their own (index.html has a data: icon);
    // answering 204 before the cookie check avoids a 401 in the console.
    if (url.pathname === "/favicon.ico" && (req.method === "GET" || req.method === "HEAD")) return new Response(null, { status: 204 });
    if (url.pathname === "/api/login-nonce") return handleLoginNonce(req);
    if (url.pathname === "/login") return req.method === "GET" ? handleLogin(url) : jsonError(405, "method", "Método no permitido");

    if (!isAuthed(req)) {
      return url.pathname.startsWith("/api/") ? jsonError(401, "unauthorized", "Abre el panel con «Abrir panel»") : htmlUnauthorized();
    }
    if (req.method === "GET" || req.method === "HEAD") return null;

    // Every request with side effects: exact Origin, X-Panel: 1, JSON, ≤ 64 KB.
    if (req.headers.get("origin") !== ORIGIN) return jsonError(403, "origin", "Origen no permitido");
    if (req.headers.get("x-panel") !== "1") return jsonError(403, "x_panel", "Falta la cabecera X-Panel");
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!/^application\/json\s*(;|$)/.test(ct)) return jsonError(415, "content_type", "El cuerpo tiene que ser JSON");
    const len = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) return jsonError(413, "too_large", "Petición demasiado grande");
    return null;
  }

  return { ORIGIN, guard, checkHost, isAuthed, handleLoginNonce, handleLogin, consumeNonce, logoutResponse, sessionCount: () => sessions.size };
}

export type Auth = ReturnType<typeof createAuth>;

/** Reads a JSON body with the 64 KB cap (also enforced when Content-Length is absent). */
export async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return { ok: false, res: jsonError(413, "too_large", "Petición demasiado grande") };
  const text = new TextDecoder().decode(buf).trim();
  if (!text) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: jsonError(400, "bad_json", "El cuerpo no es JSON válido") };
  }
}
