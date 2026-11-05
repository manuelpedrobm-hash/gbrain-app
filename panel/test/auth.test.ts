// Auth: 421, 401, 403 for a bad or missing Origin, 403 without X-Panel, nonce replay and expiry (spec §9, §11).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth, readJsonBody, safeEqual } from "../lib/auth.ts";

const SECRET = "ab".repeat(32);
const ORIGIN = "http://127.0.0.1:3140";

function setup(extra: { sessionsFile?: string } = {}) {
  let now = 1_000_000;
  let secret = SECRET;
  const auth = createAuth({ getSecret: () => secret, port: 3140, now: () => now, ...extra });
  return {
    auth,
    tick: (ms: number) => { now += ms; },
    rotate: (s: string) => { secret = s; },
  };
}

function req(path: string, init: RequestInit & { host?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "127.0.0.1:3140");
  const r = new Request(`http://127.0.0.1:3140${path}`, { ...init, headers });
  return { r, url: new URL(r.url) };
}

function guard(a: ReturnType<typeof setup>["auth"], path: string, init: RequestInit & { host?: string } = {}) {
  const { r, url } = req(path, init);
  return a.guard(r, url);
}

async function login(a: ReturnType<typeof setup>["auth"]): Promise<string> {
  const res = guard(a, "/api/login-nonce", { method: "POST", headers: { "X-Panel-Secret": SECRET } })!;
  expect(res.status).toBe(200);
  const nonce = await res.text();
  const l = guard(a, `/login?n=${nonce}`)!;
  expect(l.status).toBe(302);
  const cookie = l.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("Max-Age=2592000");                          // 30 days
  expect(cookie).toMatch(/^panel=[0-9a-f]{64};/);
  return cookie.split(";")[0];
}

const goodPost = (cookie: string, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { cookie, Origin: ORIGIN, "X-Panel": "1", "Content-Type": "application/json", ...extra },
  body: "{}",
});

describe("host", () => {
  test("foreign Host → 421", () => {
    const { auth } = setup();
    expect(guard(auth, "/api/hoy", { host: "evil.example:3140" })!.status).toBe(421);
    expect(guard(auth, "/", { host: "127.0.0.1:80" })!.status).toBe(421);
  });

  test("localhost → 302 to 127.0.0.1, keeping path and query", () => {
    const { auth } = setup();
    const res = guard(auth, "/login?n=abc", { host: "localhost:3140" })!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:3140/login?n=abc");
  });
});

describe("login", () => {
  test("no cookie → 401 (JSON for the API, HTML for pages)", async () => {
    const { auth } = setup();
    const api = guard(auth, "/api/hoy")!;
    expect(api.status).toBe(401);
    expect(((await api.json()) as any).error.code).toBe("unauthorized");
    const page = guard(auth, "/")!;
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Abre el panel con «Abrir panel»");
  });

  test("nonce: wrong secret 401, any Origin 403", () => {
    const { auth } = setup();
    expect(guard(auth, "/api/login-nonce", { method: "POST", headers: { "X-Panel-Secret": "nope" } })!.status).toBe(401);
    expect(guard(auth, "/api/login-nonce", { method: "POST" })!.status).toBe(401);
    expect(guard(auth, "/api/login-nonce", { method: "POST", headers: { "X-Panel-Secret": SECRET, Origin: ORIGIN } })!.status).toBe(403);
  });

  test("a nonce works once", async () => {
    const { auth } = setup();
    const res = guard(auth, "/api/login-nonce", { method: "POST", headers: { "X-Panel-Secret": SECRET } })!;
    const nonce = await res.text();
    expect(guard(auth, `/login?n=${nonce}`)!.status).toBe(302);
    const replay = guard(auth, `/login?n=${nonce}`)!;
    expect(replay.status).toBe(401);
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  test("a nonce is refused after 60 s", async () => {
    const s = setup();
    const res = guard(s.auth, "/api/login-nonce", { method: "POST", headers: { "X-Panel-Secret": SECRET } })!;
    const nonce = await res.text();
    s.tick(61_000);
    expect(guard(s.auth, `/login?n=${nonce}`)!.status).toBe(401);
  });

  test("cookie grants GET; replacing the secret logs out", async () => {
    const s = setup();
    const cookie = await login(s.auth);
    expect(guard(s.auth, "/api/hoy", { headers: { cookie } })).toBeNull();
    s.rotate("cd".repeat(32));
    expect(guard(s.auth, "/api/hoy", { headers: { cookie } })!.status).toBe(401);
  });

  test("empty secret: nobody gets in", async () => {
    const auth = createAuth({ getSecret: () => "", port: 3140 });
    expect(guard(auth, "/api/login-nonce", { method: "POST", headers: { "X-Panel-Secret": "" } })!.status).toBe(401);
    expect(guard(auth, "/api/hoy", { headers: { cookie: "panel=" } })!.status).toBe(401);
  });

  test("logout clears the cookie", () => {
    const { auth } = setup();
    expect(auth.logoutResponse().headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("each login gets its own random token", async () => {
    const s = setup();
    const a = await login(s.auth);
    const b = await login(s.auth);
    expect(a).not.toBe(b);
    expect(guard(s.auth, "/api/hoy", { headers: { cookie: a } })).toBeNull();
    expect(guard(s.auth, "/api/hoy", { headers: { cookie: b } })).toBeNull();
  });

  test("logout revokes the session on the server (a replayed cookie gets 401); other sessions survive", async () => {
    const s = setup();
    const a = await login(s.auth);
    const b = await login(s.auth);
    const { r } = req("/api/logout", goodPost(a));
    s.auth.logoutResponse(r);
    expect(guard(s.auth, "/api/hoy", { headers: { cookie: a } })!.status).toBe(401);
    expect(guard(s.auth, "/api/hoy", { headers: { cookie: b } })).toBeNull();
  });

  test("a session expires after 30 days", async () => {
    const s = setup();
    const cookie = await login(s.auth);
    s.tick(29 * 86400_000);
    expect(guard(s.auth, "/api/hoy", { headers: { cookie } })).toBeNull();
    s.tick(2 * 86400_000);
    expect(guard(s.auth, "/api/hoy", { headers: { cookie } })!.status).toBe(401);
  });

  test("the old fixed HMAC cookie and malformed tokens are refused", () => {
    const s = setup();
    const { createHmac } = require("node:crypto");
    const old = createHmac("sha256", Buffer.from(SECRET, "hex")).update("panel-v1").digest("hex");
    expect(guard(s.auth, "/api/hoy", { headers: { cookie: `panel=${old}` } })!.status).toBe(401);
    expect(guard(s.auth, "/api/hoy", { headers: { cookie: "panel=xyz" } })!.status).toBe(401);
  });

  test("sessions survive a restart through the 0600 file, which holds no usable token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-test-"));
    try {
      const file = join(dir, "sessions.json");
      const s1 = setup({ sessionsFile: file });
      const cookie = await login(s1.auth);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).not.toContain(cookie.slice("panel=".length));
      const s2 = setup({ sessionsFile: file });                          // "restart"
      expect(guard(s2.auth, "/api/hoy", { headers: { cookie } })).toBeNull();
      const { r } = req("/api/logout", goodPost(cookie));
      s2.auth.logoutResponse(r);
      const s3 = setup({ sessionsFile: file });
      expect(guard(s3.auth, "/api/hoy", { headers: { cookie } })!.status).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/favicon.ico answers 204 without a cookie, before the auth check", () => {
    const s = setup();
    expect(guard(s.auth, "/favicon.ico")!.status).toBe(204);
    expect(guard(s.auth, "/favicon.ico", { host: "evil.example:3140" })!.status).toBe(421);
  });
});

describe("CSRF on non-GET", () => {
  test("all rules satisfied → passes", async () => {
    const s = setup();
    const cookie = await login(s.auth);
    expect(guard(s.auth, "/api/capture", goodPost(cookie))).toBeNull();
  });

  test("POST without cookie → 401", () => {
    const { auth } = setup();
    expect(guard(auth, "/api/capture", goodPost(""))!.status).toBe(401);
  });

  test("missing or foreign Origin → 403", async () => {
    const s = setup();
    const cookie = await login(s.auth);
    const noOrigin = goodPost(cookie);
    delete (noOrigin.headers as any).Origin;
    expect(guard(s.auth, "/api/capture", noOrigin)!.status).toBe(403);
    expect(guard(s.auth, "/api/capture", goodPost(cookie, { Origin: "http://localhost:3140" }))!.status).toBe(403);
    expect(guard(s.auth, "/api/capture", goodPost(cookie, { Origin: "https://evil.example" }))!.status).toBe(403);
    expect(guard(s.auth, "/api/capture", goodPost(cookie, { Origin: "null" }))!.status).toBe(403);
  });

  test("missing X-Panel → 403", async () => {
    const s = setup();
    const cookie = await login(s.auth);
    const p = goodPost(cookie);
    delete (p.headers as any)["X-Panel"];
    const res = guard(s.auth, "/api/capture", p)!;
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("x_panel");
  });

  test("wrong Content-Type → 415; Content-Length over 64 KB → 413", async () => {
    const s = setup();
    const cookie = await login(s.auth);
    expect(guard(s.auth, "/api/capture", goodPost(cookie, { "Content-Type": "text/plain" }))!.status).toBe(415);
    expect(guard(s.auth, "/api/capture", goodPost(cookie, { "Content-Length": String(65 * 1024) }))!.status).toBe(413);
  });

  test("readJsonBody enforces 64 KB even without Content-Length", async () => {
    const big = new Request("http://127.0.0.1:3140/api/capture", { method: "POST", body: JSON.stringify({ text: "x".repeat(70 * 1024) }) });
    const r = await readJsonBody(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.res.status).toBe(413);
    const bad = await readJsonBody(new Request("http://x/", { method: "POST", body: "{nope" }));
    expect(bad.ok).toBe(false);
  });
});

test("safeEqual", () => {
  expect(safeEqual("abc", "abc")).toBe(true);
  expect(safeEqual("abc", "abd")).toBe(false);
  expect(safeEqual("abc", "abcd")).toBe(false);
});
