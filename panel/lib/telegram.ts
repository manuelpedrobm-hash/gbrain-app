// lib/telegram.ts — reads the Telegram agent's Claude Code transcripts (spec §6.4).
//
// Read-only. The agent (launchd → screen → claude) writes one JSONL file per
// session under config.telegram.projectDir; a restart starts a new UUID file.
// We parse the 2 most recently modified files incrementally: a byte offset per
// file is kept in ~/.gbrain-panel/telegram-index.json together with the parsed
// state, so each call only reads the bytes appended since the last one.
//
// Privacy (spec §4.8): Telegram chat_id, user_id and user are never stored or
// returned. The voice file id is kept only as a short hash, to match the
// download_attachment call to its message.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config, ensureStateDir, STATE_DIR } from "./config.ts";

// ---------------------------------------------------------------------------
// Public types

export interface Msg {
  messageId: number;
  ts: string;                       // when Telegram received it (ISO, UTC)
  kind: "text" | "voice";
  text: string;                     // message body; a short placeholder for voice notes
  transcript?: string;              // voice notes: the agent's whisper transcription
  status: "respondido" | "sin_respuesta" | "en_curso";
  reply?: { ts: string; text: string };
  turnMs?: number;                  // duration of the agent turn that handled it
  attachment?: string;              // non-voice attachment kind (photo, document…), if any
  agentError_es?: string;           // the agent's turn failed (API error) while this was pending
}

export interface CostDay { day: string; usd: number; requests: number }

export const TELEGRAM_ERROR_ES = "No pude leer el registro de Telegram";
export const COST_NOTE_ES = "estimación; la factura real está en la Console";

// ---------------------------------------------------------------------------
// Parser state (serialisable, persisted per file in telegram-index.json)

interface InMsg {
  messageId: string;
  ts: string;
  kind: "text" | "voice";
  attachment?: string;
  text: string;
  fileKey?: string;                 // sha256(attachment_file_id).slice(0,16)
  delivered: boolean;               // reached the model (user record or queued_command attachment)
  transcript?: string;
  reply?: { ts: string; text: string };
  turnMs?: number;
  agentError?: string;
}

interface Usage {
  ts: string;                       // timestamp of the first record of this request
  fam: string | null;               // price family: opus | sonnet | haiku | …
  in: number; out: number; cw5m: number; cw1h: number; cr: number;
  fast?: boolean;
}

export interface FileState {
  ino: number;
  offset: number;                   // bytes consumed (always just after a "\n")
  lastTs: string | null;            // newest record timestamp seen
  msgs: Record<string, InMsg>;
  pending: string[];                // delivered, not answered yet
  lastAnswered: string[];           // batch that got the latest reply (extra replies append to it)
  inTurn: string[];                 // delivered since the last turn_duration
  replyCalls: Record<string, { ts: string; text: string }>;   // reply tool_use id → awaiting "sent"
  awaitTranscribe: string[];        // voice messages downloaded, waiting for the "Transcri…" Bash call
  transcribeCalls: Record<string, string>;                     // Bash tool_use id → message id
  usage: Record<string, Usage>;     // requestId → usage (deduplicated)
  badLines: number;
  frozen?: boolean;                 // no longer among the 2 newest files: only usage is kept
}

interface IndexFile { v: number; files: Record<string, FileState> }

const INDEX_VERSION = 1;
const INDEX_PATH = join(STATE_DIR, "telegram-index.json");
const CHUNK = 4 * 1024 * 1024;
const MAX_TEXT = 4000;
const EN_CURSO_MS = 2 * 60 * 1000;

const TAG_RE = /<channel source="plugin:telegram:telegram"([^>]*)>([\s\S]*?)<\/channel>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const STAMP_RE = /\[\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\]/g;
const REPLY_TOOL = "mcp__plugin_telegram_telegram__reply";
const DOWNLOAD_TOOL = "mcp__plugin_telegram_telegram__download_attachment";

export function newFileState(ino = 0): FileState {
  return {
    ino, offset: 0, lastTs: null, msgs: {}, pending: [], lastAnswered: [], inTurn: [],
    replyCalls: {}, awaitTranscribe: [], transcribeCalls: {}, usage: {}, badLines: 0,
  };
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + "…" : s);
const fileKey = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

function toolResultText(block: any): string {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: any) => (x && typeof x.text === "string" ? x.text : "")).join("");
  return "";
}

export function cleanTranscript(s: string): string {
  return s.replace(STAMP_RE, " ").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n").trim();
}

function priceFamily(model: unknown): string | null {
  if (typeof model !== "string" || model.startsWith("<")) return null;   // "<synthetic>" = local error record
  const m = model.toLowerCase();
  for (const fam of ["opus", "sonnet", "haiku", "fable", "mythos"]) if (m.includes(fam)) return fam;
  return null;
}

/** True for the bulky request-log records we never parse (spec §6.4). */
export function isSkippedLine(line: string): boolean {
  // These records start with their type; checking the head avoids false hits on
  // message text that merely mentions the words.
  const head = line.slice(0, 80);
  return head.includes('"type":"api-request') || head.includes("api-request-shape");
}

// ---------------------------------------------------------------------------
// Record walker: feed records in file order (≈ time order)

export function feedRecord(st: FileState, o: any): void {
  if (!o || typeof o !== "object") return;
  const ts: string | undefined = typeof o.timestamp === "string" ? o.timestamp : undefined;
  if (ts && (!st.lastTs || ts > st.lastTs)) st.lastTs = ts;

  // 1. Inbound messages, in the three places the tag can appear.
  const sources: { s: string; deliver: boolean }[] = [];
  if (o.type === "user") {
    const c = o.message?.content;
    if (typeof c === "string") sources.push({ s: c, deliver: true });
    else if (Array.isArray(c)) for (const b of c) if (b?.type === "text" && typeof b.text === "string") sources.push({ s: b.text, deliver: true });
  } else if (o.type === "attachment" && typeof o.attachment?.prompt === "string") {
    sources.push({ s: o.attachment.prompt, deliver: true });           // queued_command absorbed mid-turn
  } else if (o.type === "queue-operation" && o.operation === "enqueue" && typeof o.content === "string") {
    sources.push({ s: o.content, deliver: false });                     // seen, not yet given to the model
  }
  for (const { s, deliver } of sources) {
    if (!s.includes("plugin:telegram:telegram")) continue;
    for (const m of s.matchAll(TAG_RE)) {
      const a: Record<string, string> = {};
      for (const x of m[1].matchAll(ATTR_RE)) a[x[1]] = x[2];
      const mid = a.message_id;
      if (!mid || !/^\d{1,19}$/.test(mid)) continue;
      let msg = st.msgs[mid];
      if (!msg) {
        const ak = a.attachment_kind;
        msg = st.msgs[mid] = {
          messageId: mid,
          ts: a.ts || ts || "",
          kind: ak === "voice" ? "voice" : "text",
          text: clip(m[2].trim()),
          delivered: false,
        };
        if (ak && ak !== "voice") msg.attachment = ak;
        if (a.attachment_file_id) msg.fileKey = fileKey(a.attachment_file_id);
      }
      if (deliver && !msg.delivered) {
        msg.delivered = true;
        st.pending.push(mid);
        st.inTurn.push(mid);
      }
    }
  }

  // 2. Assistant: reply calls, voice download/transcription calls, API errors, usage.
  if (o.type === "assistant") {
    if (o.isApiErrorMessage || o.error) {
      const status = typeof o.apiErrorStatus === "number" ? ` (${o.apiErrorStatus})` : "";
      for (const mid of st.pending) st.msgs[mid].agentError = `El agente falló: error de la API${status}`;
    }
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const b of content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      if (b.name === REPLY_TOOL) {
        st.replyCalls[b.id] = { ts: ts ?? "", text: clip(String(b.input?.text ?? "")) };
      } else if (b.name === DOWNLOAD_TOOL && typeof b.input?.file_id === "string") {
        const key = fileKey(b.input.file_id);
        const target = Object.values(st.msgs).find((m) => m.fileKey === key && m.kind === "voice" && !m.transcript);
        if (target && !st.awaitTranscribe.includes(target.messageId)) st.awaitTranscribe.push(target.messageId);
      } else if (b.name === "Bash" && /^transcri/i.test(String(b.input?.description ?? "")) && st.awaitTranscribe.length) {
        st.transcribeCalls[b.id] = st.awaitTranscribe.shift()!;
      }
    }
    const u = o.message?.usage;
    if (u && typeof o.requestId === "string") {
      const fam = priceFamily(o.message?.model);
      if (fam) {
        const cc = u.cache_creation ?? {};
        const rec: Usage = {
          ts: st.usage[o.requestId]?.ts ?? ts ?? "",
          fam,
          in: +u.input_tokens || 0,
          out: +u.output_tokens || 0,
          // Older records have no split: count all cache writes as 5-minute writes.
          cw5m: cc.ephemeral_5m_input_tokens != null ? +cc.ephemeral_5m_input_tokens || 0 : +u.cache_creation_input_tokens || 0,
          cw1h: +cc.ephemeral_1h_input_tokens || 0,
          cr: +u.cache_read_input_tokens || 0,
        };
        if (u.speed === "fast") rec.fast = true;
        const prev = st.usage[o.requestId];
        // One API response is split over several records with the same usage;
        // keep the most complete one.
        if (!prev || rec.out >= prev.out) st.usage[o.requestId] = rec;
      }
    }
  }

  // 3. Tool results: confirmed replies and transcripts.
  if (o.type === "user" && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const id = b.tool_use_id;
      if (st.replyCalls[id]) {
        const call = st.replyCalls[id];
        delete st.replyCalls[id];
        if (b.is_error || !/^sent\b/i.test(toolResultText(b).trim())) continue;
        if (st.pending.length) {
          for (const mid of st.pending) {
            const m = st.msgs[mid];
            m.reply = { ts: call.ts, text: call.text };
            delete m.agentError;
          }
          st.lastAnswered = st.pending;
          st.pending = [];
        } else {
          // A second reply in the same exchange: add it to the batch it follows.
          for (const mid of st.lastAnswered) {
            const m = st.msgs[mid];
            if (m?.reply) m.reply.text = clip(m.reply.text + "\n\n" + call.text, MAX_TEXT * 2);
          }
        }
      } else if (st.transcribeCalls[id]) {
        const mid = st.transcribeCalls[id];
        delete st.transcribeCalls[id];
        const t = b.is_error ? "" : cleanTranscript(toolResultText(b));
        if (t && st.msgs[mid]) st.msgs[mid].transcript = clip(t);
      }
    }
  }

  // 4. Turn duration.
  if (o.type === "system" && o.subtype === "turn_duration" && typeof o.durationMs === "number") {
    for (const mid of st.inTurn) if (st.msgs[mid] && st.msgs[mid].turnMs == null) st.msgs[mid].turnMs = o.durationMs;
    st.inTurn = [];
  }
}

/** Feeds complete JSONL lines. Unparseable lines are counted and skipped. */
export function feedLines(st: FileState, lines: Iterable<string>): void {
  for (const line of lines) {
    if (!line || line.length < 2 || isSkippedLine(line)) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { st.badLines++; continue; }
    feedRecord(st, o);
  }
}

/** Convenience for tests: parse a whole transcript text in one go. */
export function parseTranscriptText(text: string): FileState {
  const st = newFileState();
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();          // last partial line is not consumed
  feedLines(st, lines);
  return st;
}

/** Messages of one file, as API objects (oldest first). */
export function messagesOf(st: FileState, nowMs = Date.now()): Msg[] {
  const fresh = st.lastTs ? nowMs - Date.parse(st.lastTs) < EN_CURSO_MS : false;
  return Object.values(st.msgs)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : +a.messageId - +b.messageId))
    .map((m) => {
      const out: Msg = {
        messageId: Number(m.messageId),
        ts: m.ts,
        kind: m.kind,
        text: m.text,
        status: m.reply ? "respondido" : fresh ? "en_curso" : "sin_respuesta",
      };
      if (m.transcript) out.transcript = m.transcript;
      if (m.reply) out.reply = { ts: m.reply.ts, text: m.reply.text };
      if (m.turnMs != null) out.turnMs = m.turnMs;
      if (m.attachment) out.attachment = m.attachment;
      if (!m.reply && m.agentError) out.agentError_es = m.agentError;
      return out;
    });
}

// ---------------------------------------------------------------------------
// Cost estimate (spec §6.4): per request, grouped by local day of `timestamp`.

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function usageUsd(u: Usage, prices: Record<string, { in: number; out: number; cw5m: number; cw1h: number; cr: number }>): number | null {
  const p = u.fam ? prices[u.fam] : undefined;
  if (!p) return null;
  const k = u.fast ? 2 : 1;                       // fast mode bills input/output at 2x
  return (u.in * p.in * k + u.out * p.out * k + u.cw5m * p.cw5m + u.cw1h * p.cw1h + u.cr * p.cr) / 1e6;
}

export function costByDayOf(states: FileState[], prices = config.prices as Record<string, any>): CostDay[] {
  const days = new Map<string, CostDay>();
  const seen = new Set<string>();
  for (const st of states) {
    for (const [rid, u] of Object.entries(st.usage)) {
      if (seen.has(rid)) continue;
      seen.add(rid);
      const usd = usageUsd(u, prices);
      if (usd == null || !u.ts) continue;
      const d = new Date(u.ts);
      if (Number.isNaN(d.getTime())) continue;
      const key = localDay(d);
      const row = days.get(key) ?? { day: key, usd: 0, requests: 0 };
      row.usd += usd;
      row.requests += 1;
      days.set(key, row);
    }
  }
  return [...days.values()]
    .map((r) => ({ ...r, usd: Math.round(r.usd * 10000) / 10000 }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Incremental reader

/** Reads the bytes appended since st.offset and feeds complete lines. `changed` is true if any line was consumed. */
export function readIncrement(path: string, st: FileState): { state: FileState; changed: boolean } {
  const fd = openSync(path, "r");
  try {
    const s = fstatSync(fd);
    if (s.ino !== st.ino || s.size < st.offset) st = newFileState(s.ino);   // replaced or truncated
    // (a fresh state for a new inode counts as a change even before any line is read)
    if (s.size === st.offset) return { state: st, changed: false };
    let pos = st.offset;
    let carry: Buffer = Buffer.alloc(0);
    const dec = new TextDecoder("utf-8");
    while (pos < s.size) {
      const len = Math.min(CHUNK, s.size - pos);
      const chunk = Buffer.allocUnsafe(len);
      const got = readSync(fd, chunk, 0, len, pos);
      if (got <= 0) break;
      pos += got;
      const buf: Buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
      const nl = buf.lastIndexOf(10);
      if (nl < 0) { carry = buf; continue; }
      feedLines(st, dec.decode(buf.subarray(0, nl)).split("\n"));
      carry = buf.subarray(nl + 1);
    }
    // Everything up to the last "\n" is consumed; a partial last line (the agent
    // may be mid-write) is read again next time.
    const offset = pos - carry.length;
    const changed = offset !== st.offset;
    st.offset = offset;
    return { state: st, changed };
  } finally {
    closeSync(fd);
  }
}

let index: IndexFile | null = null;

function loadIndex(): IndexFile {
  if (index) return index;
  try {
    const raw = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
    if (raw?.v === INDEX_VERSION && raw.files && typeof raw.files === "object") return (index = raw);
  } catch { /* first run or unreadable: start over */ }
  return (index = { v: INDEX_VERSION, files: {} });
}

function saveIndex(ix: IndexFile): void {
  try {
    ensureStateDir();
    const tmp = INDEX_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(ix), { mode: 0o600 });
    renameSync(tmp, INDEX_PATH);
  } catch { /* the cache is an optimisation; reading still works without it */ }
}

function listTranscripts(dir: string): { path: string; mtimeMs: number; size: number }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const p = join(dir, e.name);
      const s = statSync(p);
      return { path: p, mtimeMs: s.mtimeMs, size: s.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

interface Snapshot { messages: Msg[]; costByDay: CostDay[]; lastInboundTs: string | null }

/** Brings the index up to date and returns merged messages (newest first) and costs. */
export function refresh(dir = config.telegram.projectDir, persist = true, nowMs = Date.now()): Snapshot {
  if (!existsSync(dir)) throw new Error("no transcript folder");
  const files = listTranscripts(dir);
  if (!files.length) throw new Error("no transcripts");
  const ix = persist ? loadIndex() : { v: INDEX_VERSION, files: {} as Record<string, FileState> };
  const live = files.slice(0, 2).map((f) => f.path);
  let dirty = false;

  for (const p of live) {
    const prev = ix.files[p];
    const start = prev && !prev.frozen ? prev : newFileState(prev?.ino ?? 0);
    const { state, changed } = readIncrement(p, start);
    if (changed || state !== prev) { ix.files[p] = state; dirty = true; }
  }
  // Older files: keep only their usage for the cost history; forget deleted ones.
  const present = new Set(files.map((f) => f.path));
  for (const [p, st] of Object.entries(ix.files)) {
    if (!present.has(p)) { delete ix.files[p]; dirty = true; continue; }
    if (!live.includes(p) && !st.frozen) {
      ix.files[p] = { ...newFileState(st.ino), offset: st.offset, usage: st.usage, frozen: true };
      dirty = true;
    }
  }
  if (dirty && persist) saveIndex(ix);

  const byId = new Map<number, Msg>();
  for (const p of live) {
    for (const m of messagesOf(ix.files[p], nowMs)) {
      const old = byId.get(m.messageId);
      if (!old || (!old.reply && m.reply)) byId.set(m.messageId, m);
    }
  }
  const messages = [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.messageId - a.messageId));
  return {
    messages,
    costByDay: costByDayOf(Object.values(ix.files)),
    lastInboundTs: messages.length ? messages[0].ts : null,
  };
}

// Calls are serialised so two requests never read and write the index at once.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => T): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Module contract

export async function getMensajes(opts: { limit: number; before?: string }): Promise<{
  ok: boolean; messages: Msg[]; costByDay: CostDay[]; costNote_es?: string; error_es?: string;
}> {
  try {
    const snap = await serial(() => refresh());
    const limit = Math.max(1, Math.min(200, Math.floor(Number(opts?.limit) || 50)));
    let list = snap.messages;
    const before = typeof opts?.before === "string" ? opts.before.trim() : "";
    if (/^\d{1,19}$/.test(before)) list = list.filter((m) => m.messageId < Number(before));
    else if (before && !Number.isNaN(Date.parse(before))) list = list.filter((m) => Date.parse(m.ts) < Date.parse(before));
    return { ok: true, messages: list.slice(0, limit), costByDay: snap.costByDay, costNote_es: COST_NOTE_ES };
  } catch {
    return { ok: false, messages: [], costByDay: [], error_es: TELEGRAM_ERROR_ES };
  }
}

export async function getTelegramSummary(): Promise<{
  ok: boolean; messages: Msg[]; lastInboundTs: string | null; costToday: { usd: number; requests: number }; error_es?: string;
}> {
  try {
    const snap = await serial(() => refresh());
    const today = snap.costByDay.find((d) => d.day === localDay(new Date()));
    return {
      ok: true,
      messages: snap.messages.slice(0, 5),
      lastInboundTs: snap.lastInboundTs,
      costToday: { usd: today?.usd ?? 0, requests: today?.requests ?? 0 },
    };
  } catch {
    return { ok: false, messages: [], lastInboundTs: null, costToday: { usd: 0, requests: 0 }, error_es: TELEGRAM_ERROR_ES };
  }
}

/** `size:mtime` of the newest transcript, for /api/pulse. Cheap and synchronous. */
export function telegramFingerprint(): string {
  try {
    const f = listTranscripts(config.telegram.projectDir)[0];
    return f ? `${f.size}:${Math.floor(f.mtimeMs)}` : "none";
  } catch {
    return "none";
  }
}
