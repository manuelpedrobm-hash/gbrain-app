// lib/artdb.ts — local store for the two artifacts brought over from claude.ai
// ("Cola de borradores" and "Mapa de misiones"), served in the Misiones tab.
//
// The pages call `window.claude.use("db")`; public/artifacts/claude-shim.js
// implements the subset they use on top of /api/artdb/<page>. Here each page is
// one JSON file, ~/.gbrain-panel/artdb/<page>.json (0600, written tmp+rename):
//
//   { v: 1, rev: <int>, collections: { <name>: { <docId>: {...fields} } } }
//
// `rev` goes up on every write, so the shim polls cheaply (GET ?since=rev).
// Only the collections each page really uses are accepted. The server runs one
// process and these calls are synchronous, so a write is read-modify-write
// without interleaving.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.ts";

export const PAGES: Record<string, string[]> = {
  cola: ["items", "config"],
  mapa: ["missions", "checkins", "preguntas", "config"],
};

const ID_RE = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class ArtdbError extends Error {
  constructor(public status: number, public code: string, public message_es: string) { super(message_es); }
}

export interface Store { v: 1; rev: number; collections: Record<string, Record<string, Record<string, unknown>>> }
export type WriteOp = "set" | "update" | "delete" | "add";
export interface WriteResult { ok: true; rev: number; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

let DIR = join(STATE_DIR, "artdb");
const cache = new Map<string, { mtimeMs: number; size: number; store: Store }>();

function fileOf(page: string) { return join(DIR, `${page}.json`); }

export function checkPage(page: string): void {
  if (!Object.prototype.hasOwnProperty.call(PAGES, page)) throw new ArtdbError(404, "not_found", "No existe esa página");
}

function checkCollection(page: string, col: string): void {
  if (!PAGES[page].includes(col)) throw new ArtdbError(400, "bad_collection", "Colección no permitida");
}

function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new ArtdbError(400, "bad_id", "Id de documento no válido");
  return id;
}

function plainObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ArtdbError(400, "bad_data", "Los datos tienen que ser un objeto");
  return v as Record<string, unknown>;
}

function empty(page: string): Store {
  return { v: 1, rev: 0, collections: Object.fromEntries(PAGES[page].map((c) => [c, {}])) };
}

/** Reads a page's store (cached by mtime/size). A missing file is an empty store. */
export function load(page: string): Store {
  checkPage(page);
  const f = fileOf(page);
  let st;
  try { st = statSync(f); } catch { cache.delete(page); return empty(page); }
  const c = cache.get(page);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.store;
  const raw = JSON.parse(readFileSync(f, "utf8"));
  const store = empty(page);
  store.rev = Number(raw?.rev) || 0;
  for (const col of PAGES[page]) {
    const docs = raw?.collections?.[col];
    if (docs && typeof docs === "object") store.collections[col] = docs;
  }
  cache.set(page, { mtimeMs: st.mtimeMs, size: st.size, store });
  return store;
}

function save(page: string, store: Store): void {
  const text = JSON.stringify(store);
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new ArtdbError(413, "quota_exceeded", "La base de datos de la página está llena");
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(DIR, 0o700); } catch { /* not ours to fix */ }
  const f = fileOf(page);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, f);
  const st = statSync(f);
  cache.set(page, { mtimeMs: st.mtimeMs, size: st.size, store });
}

/** Snapshot for the shim. With `since` equal to the current rev, only {rev, unchanged}. */
export function snapshot(page: string, since?: number): { rev: number; unchanged?: true; collections?: Store["collections"] } {
  const s = load(page);
  if (since != null && since === s.rev) return { rev: s.rev, unchanged: true };
  return { rev: s.rev, collections: s.collections };
}

/** Firestore-like auto id: 20 characters [a-z0-9]. */
export function newId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => a[b % a.length]).join("");
}

/**
 * One write. set replaces, update merges top-level fields (the document must
 * exist), delete removes (missing is fine), add creates with a new id.
 */
export function write(page: string, op: unknown, collection: unknown, id: unknown, data?: unknown): WriteResult {
  checkPage(page);
  if (typeof collection !== "string") throw new ArtdbError(400, "bad_collection", "Colección no válida");
  checkCollection(page, collection);
  if (op !== "set" && op !== "update" && op !== "delete" && op !== "add") throw new ArtdbError(400, "bad_op", "Operación no válida");
  const docId = op === "add" ? newId() : checkId(id);
  const cur = load(page);
  // Copy-on-write: the cached store is only replaced after a successful save.
  const next: Store = { v: 1, rev: cur.rev + 1, collections: { ...cur.collections, [collection]: { ...cur.collections[collection] } } };
  const docs = next.collections[collection];
  const before = Object.prototype.hasOwnProperty.call(docs, docId) ? docs[docId] : null;
  let after: Record<string, unknown> | null = null;
  if (op === "delete") {
    if (!before) return { ok: true, rev: cur.rev, id: docId, before: null, after: null };
    delete docs[docId];
  } else if (op === "update") {
    if (!before) throw new ArtdbError(404, "not_found", "No existe ese documento");
    after = { ...before, ...plainObject(data) };
    docs[docId] = after;
  } else {
    after = { ...plainObject(data) };
    docs[docId] = after;
  }
  save(page, next);
  return { ok: true, rev: next.rev, id: docId, before, after };
}

/** Replaces a whole page (used once, to seed from the claude.ai export). */
export function replaceAll(page: string, collections: Store["collections"]): Store {
  checkPage(page);
  const store = empty(page);
  for (const col of PAGES[page]) if (collections[col]) store.collections[col] = collections[col];
  store.rev = load(page).rev + 1;
  save(page, store);
  return store;
}

export const __testing = {
  setDir(dir: string) { DIR = dir; cache.clear(); },
};
