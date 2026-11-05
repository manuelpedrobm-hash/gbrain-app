// server.ts — "Cerebro", __NOMBRE__'s local GBrain panel (spec §2, §4, §5).
//
//   bun run __REPO__/panel/server.ts
//
// One process, 127.0.0.1:3140 only. Reads: read-only SQL (lib/db.ts), proven
// read-only at startup. Writes: `gbrain call` (lib/gbrain.ts). Chat: claude -p
// (lib/chat.ts). Auth: one-time nonce + random revocable session cookie + CSRF rules (lib/auth.ts).
// Logs carry method, path (never the query string), status and milliseconds.

import { readFileSync, realpathSync } from "node:fs";
import { join, normalize } from "node:path";

import { config, ensureStateDir, localDay, paths, PANEL_DIR, readState, writeState } from "./lib/config.ts";
import { createAuth, ensureSecretFile, readJsonBody, secretFromFile } from "./lib/auth.ts";
import * as db from "./lib/db.ts";
import { renderMarkdown } from "./lib/render.ts";
import { computePulse, indexFingerprint } from "./lib/pulse.ts";
import { getHealth, getEstadoPage, runDoctor } from "./lib/health.ts";
import { daysUntil, getEstado, urgencyFor, type Deadline } from "./lib/estado.ts";
import { scanPendingHeadings } from "./lib/pending.ts";
import { callTool, GbrainError } from "./lib/gbrain.ts";
import {
  buildAdd, buildDefer, buildDone, buildEdit, buildMove, buildReopen, getTasksDoc, initTasksPage, mutateTasks,
  sanitizeMetaValue, sanitizeTaskText, TaskError, type SectionKey, type Task,
} from "./lib/tasks.ts";
import { getMensajes, getTelegramSummary, telegramFingerprint } from "./lib/telegram.ts";
import { chatStream, getChat, listChats, panelSpendToday, startChat, stopChat } from "./lib/chat.ts";
import { CorreoError, saveDraft, sendEmail } from "./lib/correo.ts";
import { AjustesError, billingStatus, setAjustes } from "./lib/ajustes.ts";
import { appendEntry, DiarioError, listEntries, NO_PERMISSION_ES } from "./lib/diario.ts";
import { buildEstrategiaView, ESTRATEGIA_SLUG } from "./lib/estrategia.ts";
import * as asistente from "./lib/asistente.ts";

const PUBLIC_DIR = join(PANEL_DIR, "public");

// ---------------------------------------------------------------------------
// Validation (spec §4.6)

const SLUG_RE = /^[a-z0-9][a-z0-9._\/-]{0,200}$/;
const FACT_ID_RE = /^\d{1,19}$/;
const TASK_ID_RE = /^t-\d{8}-\d{2,3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const KINDS = ["fact", "preference", "commitment", "event", "belief"];
const TYPE_RE = /^[a-z][a-z0-9_-]{0,40}$/;

class HttpError extends Error {
  constructor(public status: number, public code: string, public message_es: string) { super(message_es); }
}
const bad = (message_es: string, code = "invalid") => new HttpError(400, code, message_es);

function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function obj(v: unknown): Record<string, any> { return v && typeof v === "object" && !Array.isArray(v) ? (v as any) : {}; }
const noCtl = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

function validFactBody(b: Record<string, any>) {
  const fact = noCtl(str(b.fact)).trim();
  if (!fact || fact.length > 500) throw bad("El hecho tiene que tener entre 1 y 500 caracteres");
  const kind = str(b.kind) || "fact";
  if (!KINDS.includes(kind)) throw bad("Tipo de hecho no válido");
  const provenance = noCtl(str(b.provenance)).trim();
  if (!provenance || provenance.length > 500) throw bad("Falta la procedencia (de dónde sale el dato)");
  const entityRaw = noCtl(str(b.entity)).trim();
  if (entityRaw && entityRaw.length > 200) throw bad("Entidad demasiado larga");
  return { fact, kind, provenance, entity: entityRaw || undefined };
}

function validReason(v: unknown, required: boolean): string {
  const r = noCtl(str(v)).replace(/[\r\n]+/g, " ").trim();
  if (required && !r) throw bad("Escribe un motivo");
  if (r.length > 300) throw bad("El motivo no puede pasar de 300 caracteres");
  return r;
}

// ---------------------------------------------------------------------------
// Responses

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function jsonError(status: number, code: string, message_es: string): Response {
  return json({ error: { code, message_es } }, status);
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError || e instanceof TaskError || e instanceof GbrainError || e instanceof CorreoError ||
      e instanceof DiarioError || e instanceof AjustesError || e instanceof asistente.AsistenteError) {
    return jsonError(e.status, e.code, e.message_es);
  }
  console.error(`[cerebro] error interno: ${String((e as any)?.message ?? e).slice(0, 300)}`);
  return jsonError(500, "internal", "Error interno del panel");
}

function withHeaders(res: Response, pathname: string): Response {
  const set = (h: Headers) => {
    h.set("Content-Security-Policy", CSP);
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "no-referrer");
    h.set("X-Frame-Options", "DENY");
    if (pathname.startsWith("/api/")) h.set("Cache-Control", "no-store");
  };
  try {
    set(res.headers);
    return res;
  } catch {
    // Immutable headers (e.g. a fetched Response): copy into a new one.
    const h = new Headers(res.headers);
    set(h);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
}

// ---------------------------------------------------------------------------
// Guarded access to the Telegram and chat modules: they must never break Hoy.

async function tgSummary() {
  try {
    return await getTelegramSummary();
  } catch {
    return { ok: false, messages: [], lastInboundTs: null, costToday: { usd: 0, requests: 0 }, error_es: "No pude leer el registro de Telegram" };
  }
}
function tgFingerprint(): string {
  try { return telegramFingerprint(); } catch { return "telegram-error"; }
}
function chatSpend(): { usd: number; capUsd: number } {
  try { return panelSpendToday(); } catch { return { usd: 0, capUsd: config.chat.dailyBudgetUsd }; }
}

// ---------------------------------------------------------------------------
// Helpers for views

function parseDate(v: unknown): number | null {
  if (v == null || v === "") return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Latest of several dates, as ISO; and cold = older than coldDays. */
function touch(dates: unknown[]): { lastTouch: string | null; cold: boolean } {
  let max: number | null = null;
  for (const d of dates) {
    const t = parseDate(d);
    if (t !== null && t <= Date.now() + 366 * 86400_000 && (max === null || t > max)) max = t;
  }
  if (max === null) return { lastTouch: null, cold: false };
  return { lastTouch: new Date(max).toISOString(), cold: Date.now() - max > config.coldDays * 86400_000 };
}

const BULKY_FM = new Set(["title", "type", "tags", "aliases", "conversation_uuid"]);
function frontmatterChips(fm: Record<string, unknown>): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [];
  for (const [k, v] of Object.entries(fm ?? {})) {
    if (BULKY_FM.has(k) || v == null || typeof v === "object") continue;
    // YAML dates come back from gbrain as midnight-UTC ISO strings; show the day.
    const s = String(v).replace(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/, "$1");
    if (s.length > 120) continue;
    out.push({ k, v: s });
  }
  return out;
}

function openTasks(sections: { tasks: Task[] }[]): Task[] {
  return sections.flatMap((s) => s.tasks).filter((t) => !t.done && t.section !== "Completed" && t.section !== "Deferred");
}

function taskDeadlines(tasks: Task[], today: string, horizon: number): Deadline[] {
  const out: Deadline[] = [];
  for (const t of tasks) {
    if (!t.due || !DATE_RE.test(t.due) || t.overdue) continue;
    const d = daysUntil(t.due, today);
    if (d < 0 || d > horizon) continue;
    out.push({ date: t.due, label: t.text, source: "task", ref: t.id, urgency: urgencyFor(t.due, today), past: false });
  }
  return out;
}

function commitmentDeadlines(facts: db.Fact[], today: string, horizon: number): Deadline[] {
  const out: Deadline[] = [];
  for (const f of facts) {
    if (!f.valid_until) continue;
    const date = localDay(new Date(f.valid_until));
    const d = daysUntil(date, today);
    if (d < 0 || d > horizon) continue;
    out.push({ date, label: f.fact, source: "commitment", ref: f.id, urgency: urgencyFor(date, today), past: false });
  }
  return out;
}

function estadoMeta(e: ReturnType<typeof getEstado>) {
  return { ok: e.ok, slug: e.slug, mtime: e.mtime, ageDays: e.ageDays, stale: e.stale, ...(e.error_es ? { error_es: e.error_es } : {}) };
}

// ---------------------------------------------------------------------------
// Views

async function viewHoy() {
  const today = localDay();
  const lastSeen = readState().lastSeen ?? new Date().toISOString();
  const [estado, tasksDoc, commits, since, inboxRows, tg] = await Promise.all([
    Promise.resolve(getEstado()),
    getTasksDoc().catch(() => null),
    db.commitments().catch(() => [] as db.Fact[]),
    db.sinceLastSeen(lastSeen).catch(() => ({ facts: [], retired: [], pages: [] })),
    db.inbox(5).catch(() => []),
    tgSummary(),
  ]);
  const open = tasksDoc ? openTasks(tasksDoc.sections) : [];
  const deadlines = [
    ...estado.rows.filter((r) => !r.past && daysUntil(r.date, today) <= 14),
    ...taskDeadlines(open, today, 14),
    ...commitmentDeadlines(commits, today, 14),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return {
    deadlines,
    overdue: open.filter((t) => t.overdue),
    todayTasks: open.filter((t) => t.section === "P0" || t.section === "P1").slice(0, 7),
    openTasks: open.length,
    tasksExists: !!tasksDoc?.exists,
    telegram: { ok: tg.ok, messages: tg.messages ?? [], ...(tg.error_es ? { error_es: tg.error_es } : {}) },
    since: { lastSeen, ...since },
    inbox: inboxRows,
    estado: estadoMeta(estado),
  };
}

async function viewPendientes() {
  const estado = getEstado();
  const [tasks, commits, pagesWithHeadings] = await Promise.all([
    getTasksDoc(),
    db.commitments(),
    db.pendingHeadingPages().catch(() => []),
  ]);
  return {
    tasks,
    commitments: commits,
    deadlines: estado.rows,
    sections: scanPendingHeadings(pagesWithHeadings),
    estado: estadoMeta(estado),
  };
}

/** Estrategia: la página ops/estrategia (solo lectura) con sus tablas leídas. Sin escrituras. */
async function viewEstrategia() {
  const [md, known] = await Promise.all([
    db.tasksPageText(ESTRATEGIA_SLUG),
    db.getKnownSlugs().catch(() => new Set<string>()),
  ]);
  return buildEstrategiaView(md, (text) => renderMarkdown(text, known));
}

async function viewPages(url: URL) {
  const type = url.searchParams.get("type") || null;
  const tag = url.searchParams.get("tag") || null;
  if (type && !TYPE_RE.test(type)) throw bad("Tipo no válido");
  if (tag && (tag.length > 100 || /[\u0000-\u001f]/.test(tag))) throw bad("Etiqueta no válida");
  const counts = await db.typeCounts();
  if (type === "conversation" && !tag) return { counts, pages: await db.conversations() };
  const cards = await db.pageCards({ type, tag });
  return {
    counts,
    pages: cards.map((c) => {
      const t = touch([c.dates.effective, c.dates.fm_updated, c.dates.last_tl, c.dates.last_mention, c.dates.last_fact]);
      return { slug: c.slug, type: c.type, title: c.title, inbound: c.inbound, facts: c.facts, tags: c.tags, lastTouch: t.lastTouch, cold: t.cold };
    }),
  };
}

async function viewPage(url: URL) {
  const slug = (url.searchParams.get("slug") ?? "").trim();
  if (!SLUG_RE.test(slug)) throw bad("Slug no válido");
  const n = Math.max(1, Math.min(200, Number(url.searchParams.get("n")) || 20));
  const b = await db.getPageBundle(slug, n);
  if (!b) throw new HttpError(404, "not_found", "No existe esa página");
  const known = await db.getKnownSlugs();
  const fm = b.frontmatter as Record<string, unknown>;
  const t = touch([b.effective_date, fm?.updated, b.timeline[0]?.date, b.facts[0]?.created_at]);
  const out: any = {
    slug: b.slug, type: b.type, title: b.title, aliases: b.aliases, tags: b.tags,
    chips: frontmatterChips(fm), html: renderMarkdown(b.compiled_truth, known),
    lastTouch: t.lastTouch, cold: t.cold, ingested_via: b.ingested_via,
    facts: b.facts, timeline: b.timeline, backlinks: b.backlinks, outlinks: b.outlinks,
  };
  if (url.searchParams.get("graph") !== "0") {
    const depth = url.searchParams.get("depth") === "1" ? 1 : 2;
    out.graph = await db.miniGraph(b.slug, depth, url.searchParams.get("conv") === "1").catch(() => undefined);
  }
  return out;
}

async function viewSearch(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length > 200) throw bad("La búsqueda no puede pasar de 200 caracteres");
  if (!q) return { pages: [], facts: [] };
  return db.search(q);
}

async function viewFacts(url: URL) {
  const kind = url.searchParams.get("kind") || null;
  const entity = url.searchParams.get("entity") || null;
  if (kind && !KINDS.includes(kind) && kind !== "idea") throw bad("Tipo de hecho no válido");
  if (entity && !SLUG_RE.test(entity)) throw bad("Entidad no válida");
  const expired = url.searchParams.get("expired");
  return { facts: await db.facts({ kind, entity, includeExpired: expired === "1" || expired === "true" }) };
}

// ---------------------------------------------------------------------------
// Writes

async function postFact(body: Record<string, any>) {
  const f = validFactBody(body);
  const r = await callTool("remember", { ...f, content_origin: "user_said" });
  const id = r?.id != null ? String(r.id) : r?.fact_id != null ? String(r.fact_id) : "";
  const check = id ? await db.factById(id) : null;
  if (!check || check.expired_at) throw new HttpError(502, "not_verified", "GBrain dijo que guardó el hecho, pero no lo encuentro activo");
  return { ok: true, id, status: String(r?.status ?? "inserted"), verified: true };
}

async function forgetFact(id: string, body: Record<string, any>) {
  if (!FACT_ID_RE.test(id)) throw bad("Id de hecho no válido");
  const reason = validReason(body.reason, true);
  await callTool("forget", { id, reason });
  const check = await db.factById(id);
  if (!check?.expired_at) throw new HttpError(502, "not_verified", "GBrain no confirmó que el hecho quedara retirado");
  return { ok: true };
}

/** Corregir: remember the new fact first, then forget the old one, then re-read both. */
async function correctFact(oldId: string, body: Record<string, any>) {
  if (!FACT_ID_RE.test(oldId)) throw bad("Id de hecho no válido");
  const f = validFactBody(body);
  const old = await db.factById(oldId);
  if (!old) throw new HttpError(404, "not_found", "No existe ese hecho");
  if (old.expired_at) throw new HttpError(409, "already_expired", "Ese hecho ya estaba retirado");
  const r = await callTool("remember", { ...f, content_origin: "user_said" });
  const newId = r?.id != null ? String(r.id) : r?.fact_id != null ? String(r.fact_id) : "";
  if (!newId) throw new HttpError(502, "not_verified", "GBrain no devolvió el id del hecho nuevo");
  if (r?.status === "duplicate" && newId === oldId) return { ok: true, newId, oldExpired: false, unchanged: true };
  await callTool("forget", { id: oldId, reason: `corregido: sustituido por #${newId}` });
  const [nf, of] = await Promise.all([db.factById(newId), db.factById(oldId)]);
  if (!nf || nf.expired_at || !of?.expired_at) throw new HttpError(502, "not_verified", "No pude comprobar la corrección; revisa los hechos");
  return { ok: true, newId, oldExpired: true };
}

async function postCapture(body: Record<string, any>) {
  const text = noCtl(str(body.text)).trim();
  if (!text) throw bad("Escribe algo para apuntar");
  if (text.length > 4000) throw bad("La nota no puede pasar de 4.000 caracteres");
  const r = await callTool("capture", { content: text, content_origin: "user_said" });
  return { ok: true, slug: String(r?.slug ?? r?.page?.slug ?? "") };
}

async function taskAction(id: string, action: string, body: Record<string, any>) {
  if (!TASK_ID_RE.test(id)) throw bad("Id de tarea no válido");
  let task: Task;
  switch (action) {
    case "done":
      task = await mutateTasks((p, c, today) => buildDone(p, c, id, today));
      break;
    case "reopen":
      task = await mutateTasks((p, c) => buildReopen(p, c, id));
      break;
    case "move": {
      const priority = str(body.priority);
      if (!PRIORITIES.includes(priority)) throw bad("Prioridad no válida");
      task = await mutateTasks((p, c) => buildMove(p, c, id, priority as SectionKey));
      break;
    }
    case "defer": {
      const until = str(body.until);
      if (!DATE_RE.test(until)) throw bad("Fecha no válida (AAAA-MM-DD)");
      const reason = sanitizeMetaValue(validReason(body.reason, false));
      task = await mutateTasks((p, c) => buildDefer(p, c, id, until, reason));
      break;
    }
    case "edit": {
      const text = sanitizeTaskText(body.text);
      if (!text) throw bad("La tarea no puede quedar vacía");
      task = await mutateTasks((p) => buildEdit(p, id, text));
      break;
    }
    default:
      throw new HttpError(404, "not_found", "Acción desconocida");
  }
  return { ok: true, task };
}

async function addTask(body: Record<string, any>) {
  const text = sanitizeTaskText(body.text);
  if (!text) throw bad("Escribe la tarea");
  const priority = str(body.priority) || "P1";
  if (!PRIORITIES.includes(priority)) throw bad("Prioridad no válida");
  const due = str(body.due) || undefined;
  if (due && !DATE_RE.test(due)) throw bad("Fecha no válida (AAAA-MM-DD)");
  const task = await mutateTasks((p, _c, today) => buildAdd(p, { text, priority: priority as SectionKey, due }, today));
  return { ok: true, task };
}

// ---------------------------------------------------------------------------
// Static files

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(pathname: string): Promise<Response> {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return new Response("Not found", { status: 404 }); }
  if (rel === "/" || rel === "/index.html") rel = "/index.html";
  if (rel.includes("\0") || rel.includes("..")) return new Response("Not found", { status: 404 });
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  if (!TYPES[ext]) return new Response("Not found", { status: 404 });
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + "/")) return new Response("Not found", { status: 404 });
  const file = Bun.file(full);
  if (!(await file.exists())) {
    if (rel === "/index.html") {
      return new Response(
        `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cerebro</title></head><body><h1>Cerebro</h1><p>La interfaz del panel no está instalada todavía (falta public/index.html).</p></body></html>`,
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }
  // Refuse symlinks that point outside public/.
  try { if (!realpathSync(full).startsWith(realpathSync(PUBLIC_DIR) + "/")) return new Response("Not found", { status: 404 }); } catch { }
  return new Response(file, { headers: { "Content-Type": TYPES[ext], "Cache-Control": "no-cache" } });
}

// ---------------------------------------------------------------------------
// Diario

async function viewDiario() {
  const known = await db.getKnownSlugs().catch(() => new Set<string>());
  const { entries, original } = listEntries();
  return {
    entries: entries.map((e) => ({ file: e.file, date: e.date, title: e.title, source: e.source, mtime: e.mtime, html: renderMarkdown(e.markdown, known) })),
    original: { ...original, ...(original.error === "EPERM" || original.error === "EACCES" ? { message_es: NO_PERMISSION_ES } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Router

type Server = ReturnType<typeof Bun.serve>;

async function route(req: Request, url: URL, server: Server): Promise<Response> {
  const p = url.pathname;
  const m = req.method === "HEAD" ? "GET" : req.method;
  if (!p.startsWith("/api/")) {
    if (m !== "GET") return jsonError(405, "method", "Método no permitido");
    return serveStatic(p);
  }

  const body = async (): Promise<Record<string, any>> => {
    const r = await readJsonBody(req);
    if (!r.ok) throw Object.assign(new HttpError(r.res.status, "body", "Cuerpo no válido"), { res: r.res });
    return obj(r.body);
  };

  if (m === "GET") {
    switch (p) {
      case "/api/diario": return json(await viewDiario());
      case "/api/pulse": return json(await computePulse(tgFingerprint()));
      case "/api/health": return json(await getHealth({ telegram: tgSummary as any, panelSpend: chatSpend }));
      case "/api/estado": return json(await getEstadoPage());
      case "/api/index": {
        const idx = await db.getIndex();
        return json({ ...idx, fp: indexFingerprint(idx) });
      }
      case "/api/search": return json(await viewSearch(url));
      case "/api/hoy": return json(await viewHoy());
      case "/api/pendientes": return json(await viewPendientes());
      case "/api/estrategia": return json(await viewEstrategia());
      case "/api/reuniones": return json({ reuniones: await db.reuniones() });
      case "/api/informes": return json({ informes: await db.informes() });
      case "/api/asistente": return json(asistente.getAsistente());
      case "/api/tasks": return json(await getTasksDoc());
      case "/api/mensajes": {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const before = url.searchParams.get("before") || undefined;
        if (before && before.length > 64) throw bad("Parámetro before no válido");
        // Bandeja (inbox/ notes) rides along so the view needs one request; a DB
        // failure there must not hide the Telegram list, and vice versa.
        const inboxRows = await db.inbox(5).catch(() => []);
        try {
          return json({ ...(await getMensajes({ limit, before })), inbox: inboxRows });
        } catch {
          return json({ ok: false, messages: [], costByDay: [], inbox: inboxRows, error_es: "No pude leer el registro de Telegram" });
        }
      }
      case "/api/pages": return json(await viewPages(url));
      case "/api/page": return json(await viewPage(url));
      case "/api/facts": return json(await viewFacts(url));
      case "/api/chats": return json(listChats());
      case "/api/ajustes": return json(billingStatus());
      case "/api/chat/stream": return chatStream(req, server);
    }
    const chatId = /^\/api\/chats\/([^/]+)$/.exec(p);
    if (chatId) {
      if (!UUID_RE.test(chatId[1])) throw bad("Id de conversación no válido");
      const c: any = getChat(chatId[1]);
      if (!c) return jsonError(404, "not_found", "No existe esa conversación");
      // Saved assistant turns are re-rendered with the same renderer and options as
      // the live "done" event, so a reopened conversation shows markdown and [[slug]]
      // links, and external URLs as plain text (never clickable in chat output).
      let known: Set<string>;
      try { known = await db.getKnownSlugs(); } catch { known = new Set(); }
      for (const t of Array.isArray(c.turns) ? c.turns : []) {
        if (t?.role === "assistant" && typeof t.text === "string" && t.text.trim()) {
          try { t.html = renderMarkdown(t.text, known, { externalLinks: "text" }); } catch { /* the client falls back to text */ }
        }
      }
      return json(c);
    }
    return jsonError(404, "not_found", "Ruta desconocida");
  }

  if (m === "POST") {
    switch (p) {
      case "/api/logout": return auth.logoutResponse(req);
      case "/api/hoy/seen": {
        await body();
        const lastSeen = new Date().toISOString();
        writeState({ lastSeen });
        return json({ lastSeen });
      }
      case "/api/estado/doctor": await body(); return json(await runDoctor());
      case "/api/tasks/init": await body(); return json(await initTasksPage());
      case "/api/tasks": return json(await addTask(await body()));
      case "/api/facts": return json(await postFact(await body()));
      case "/api/capture": return json(await postCapture(await body()));
      case "/api/correo/enviar": return json(await sendEmail(await body()));
      case "/api/correo/borrador": return json(await saveDraft(await body()));
      case "/api/asistente/preparar": return json(await asistente.preparar(await body(), ctxA(req, server)), 202);
      case "/api/asistente/aprobar": return json(await asistente.aprobar(await body(), ctxA(req, server)));
      case "/api/asistente/rechazar": return json(await asistente.rechazar(await body(), ctxA(req, server)));
      case "/api/asistente/cancelar": return json(await asistente.cancelar(await body(), ctxA(req, server)));
      case "/api/asistente/cerrar": return json(await asistente.cerrarPestana(await body(), ctxA(req, server)));
      case "/api/ajustes": { setAjustes(await body()); return json(billingStatus()); }
      case "/api/diario": {
        const b = await body();
        return json(appendEntry(b.text));
      }
      case "/api/chat": {
        const r = await startChat(await body());
        return json(r.body, r.status);
      }
      case "/api/chat/stop": {
        const r = stopChat(await body());
        return json(r.body, r.status);
      }
    }
    const t = /^\/api\/tasks\/([^/]+)\/(done|reopen|move|defer|edit)$/.exec(p);
    if (t) return json(await taskAction(t[1], t[2], await body()));
    const f = /^\/api\/facts\/([^/]+)\/(forget|correct)$/.exec(p);
    if (f) {
      const b = await body();
      return json(f[2] === "forget" ? await forgetFact(f[1], b) : await correctFact(f[1], b));
    }
    return jsonError(404, "not_found", "Ruta desconocida");
  }

  return jsonError(405, "method", "Método no permitido");
}

// ---------------------------------------------------------------------------
// Startup

ensureStateDir();
ensureSecretFile(paths.secret);
const auth = createAuth({ getSecret: secretFromFile(paths.secret), port: config.port, sessionsFile: paths.sessions });

{
  const st = readState();
  if (!st.lastSeen) {
    const now = new Date().toISOString();
    writeState({ lastSeen: now, installedAt: st.installedAt ?? now });
  }
}

const ctxA = (req: Request, server: Server) => ({ ip: server.requestIP(req)?.address });

async function handle(req: Request, server: Server): Promise<Response> {
  const t0 = performance.now();
  const url = new URL(req.url);
  let res: Response;
  // Todo intento a /api/asistente/* queda en audit.jsonl: las acciones aceptadas o rechazadas por su
  // lógica las audita lib/asistente.ts; aquí van los que no llegan a ella (guardia 401/403/415/413/421,
  // JSON malo, ruta o método desconocido).
  const esAsistente = url.pathname === "/api/asistente" || url.pathname.startsWith("/api/asistente/");
  let propia = false;   // la rechazó/aceptó la lógica del asistente (ya auditada)
  try {
    const g = auth.guard(req, url);
    res = g ?? (await route(req, url, server));
  } catch (e: any) {
    propia = e instanceof asistente.AsistenteError;
    res = e?.res instanceof Response ? e.res : errorResponse(e);
  }
  if (esAsistente && res.status >= 400 && !propia) {
    let codigo = String(res.status);
    try { codigo = String((await res.clone().json())?.error?.code ?? codigo); } catch { /* sin JSON */ }
    asistente.auditarRechazoPrevio(req.method, url.pathname, res.status, codigo, { ip: server.requestIP(req)?.address });
  }
  res = withHeaders(res, url.pathname);
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.status} ${Math.round(performance.now() - t0)}ms`);
  return res;
}

const self = await db.selfTest();
if (!self.ok) {
  console.error(`[cerebro] autocomprobación fallida: ${self.message}. No arranco.`);
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  idleTimeout: 120,
  fetch: handle,
  error(e) {
    console.error(`[cerebro] error no controlado: ${String(e?.message ?? e).slice(0, 300)}`);
    return withHeaders(jsonError(500, "internal", "Error interno del panel"), "/api/");
  },
});

console.log(`[cerebro] escuchando en http://127.0.0.1:${server.port} (${self.message})`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[cerebro] ${sig}: parando`);
    server.stop(true);
    db.sql.close().catch(() => undefined).finally(() => process.exit(0));
  });
}
