// lib/tasks.ts — the writable task list on the brain page ops/tasks, in the
// daily-task-manager format (spec §6.3):
//
//   ## P1 — Today
//   - [ ] <!-- id: t-20261025-01 --> Llamar a X #etiqueta (due: 2026-10-28)
//     - [ ] un paso
//
// Parsing is pure. Every mutation runs under one in-process mutex:
//   get_page (fresh revision + content) → parse → build edits → edit_page with
//   expected_revision → on revision_conflict re-read, rebuild and retry once →
//   second conflict = 409 "Otra sesión cambió las tareas; recarga".
// The SQL copy is only ever used for display.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { callTool, GbrainError } from "./gbrain.ts";
import { config, localDay, tasksSlug, writeState } from "./config.ts";
import { tasksPageText, tasksStoredSlug } from "./db.ts";

export type SectionKey = "P0" | "P1" | "P2" | "P3" | "Deferred" | "Completed";
export const SECTION_KEYS: SectionKey[] = ["P0", "P1", "P2", "P3", "Deferred", "Completed"];
export const LABELS_ES: Record<SectionKey, string> = {
  P0: "P0 · Urgente", P1: "P1 · Hoy", P2: "P2 · Esta semana", P3: "P3 · Más adelante",
  Deferred: "Pospuestas", Completed: "Hechas",
};

/** Headings stay in English so they match the daily-task-manager skill exactly. */
export const TEMPLATE =
  "---\ntype: note\ntitle: Tareas\n---\n# Tasks\n\n## P0 — Urgent\n\n## P1 — Today\n\n## P2 — This Week\n\n## P3 — Backlog\n\n## Deferred\n\n## Completed\n";

const HEADING_RE = /^## (P0|P1|P2|P3|Deferred|Completed)\b/;
const TASK_RE = /^- \[( |x)\] <!-- id: (t-\d{8}-\d{2,3}) --> (.*?)(?:\s+\(([^()]*)\))?\s*$/;
const STEP_RE = /^\s+- \[( |x|X)\] (.*)$/;
const BLOCK_CONT_RE = /^(?: {2,}|\t)\S/;
const TAG_RE = /#[\p{L}\d_-]+/gu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_KEYS = new Set(["due", "deferred until", "reason", "completed"]);

export interface Task {
  id: string; done: boolean; text: string; tags: string[];
  due?: string; deferredUntil?: string; reason?: string; completed?: string;
  section: SectionKey; overdue: boolean; steps: { done: boolean; text: string }[];
}

interface ParsedTask extends Task {
  line: string;                 // verbatim task line
  block: string;                // task line + indented step lines, joined with \n
  stepLines: string[];          // verbatim indented lines
  lineNo: number;               // 1-based
  meta: [string, string][];     // trailing parenthetical, in order
}

export interface TasksParse {
  headings: Partial<Record<SectionKey, string>>;
  duplicateHeadings: SectionKey[];
  duplicateIds: Set<string>;
  tasks: ParsedTask[];
  unparsed: { lineNo: number; text: string }[];
}

export class TaskError extends Error {
  constructor(public status: number, public code: string, public message_es: string) { super(message_es); }
}

// ---------------------------------------------------------------------------
// Parsing

function parseMeta(paren: string | undefined): [string, string][] | null {
  if (paren == null) return null;
  const pairs: [string, string][] = [];
  for (const part of paren.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) { if (part.trim()) pairs.push(["", part.trim()]); continue; }
    pairs.push([part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()]);
  }
  return pairs.some(([k]) => KNOWN_KEYS.has(k)) ? pairs : null;
}

const metaGet = (meta: [string, string][], key: string) => meta.find(([k]) => k === key)?.[1];

export function parseTasks(content: string, today: string = localDay()): TasksParse {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: TasksParse = { headings: {}, duplicateHeadings: [], duplicateIds: new Set(), tasks: [], unparsed: [] };
  let i = 0;
  // YAML frontmatter (present in get_page content, absent in compiled_truth)
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  let section: SectionKey | null = null;
  const seenIds = new Set<string>();
  while (i < lines.length) {
    const line = lines[i];
    const h = HEADING_RE.exec(line);
    if (h) {
      const key = h[1] as SectionKey;
      if (out.headings[key] !== undefined) { if (!out.duplicateHeadings.includes(key)) out.duplicateHeadings.push(key); }
      else out.headings[key] = line;
      section = key;
      i++;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (!/^# /.test(line)) out.unparsed.push({ lineNo: i + 1, text: line }); // unknown heading
      section = null;
      i++;
      continue;
    }
    const t = TASK_RE.exec(line);
    if (t && section) {
      const stepLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && BLOCK_CONT_RE.test(lines[j])) { stepLines.push(lines[j]); j++; }
      const id = t[2];
      if (seenIds.has(id)) out.duplicateIds.add(id);
      seenIds.add(id);
      let text = t[3].trim();
      let meta = parseMeta(t[4]);
      if (t[4] != null && !meta) { text = `${text} (${t[4]})`.trim(); meta = []; }
      meta ??= [];
      const done = t[1] === "x";
      const due = metaGet(meta, "due");
      const task: ParsedTask = {
        id, done, text, tags: text.match(TAG_RE) ?? [], section,
        overdue: !done && section !== "Completed" && !!due && DATE_RE.test(due) && due < today,
        steps: stepLines.map((l) => STEP_RE.exec(l)).filter(Boolean).map((m) => ({ done: m![1].toLowerCase() === "x", text: m![2].trim() })),
        line, stepLines, block: [line, ...stepLines].join("\n"), lineNo: i + 1, meta,
      };
      if (due) task.due = due;
      const du = metaGet(meta, "deferred until"); if (du) task.deferredUntil = du;
      const rs = metaGet(meta, "reason"); if (rs) task.reason = rs;
      const cp = metaGet(meta, "completed"); if (cp) task.completed = cp;
      out.tasks.push(task);
      i = j;
      continue;
    }
    if (line.trim() !== "") out.unparsed.push({ lineNo: i + 1, text: line });
    i++;
  }
  return out;
}

function publicTask(t: ParsedTask): Task {
  const { line, block, stepLines, lineNo, meta, ...pub } = t;
  return pub;
}

export interface TasksDoc {
  slug: string; exists: boolean;
  sections: { key: SectionKey; label_es: string; tasks: Task[] }[];
  unparsed: { lineNo: number; text: string }[];
  writable: boolean; reason_es?: string;
}

export function toDoc(slug: string, parse: TasksParse | null): TasksDoc {
  const sections = SECTION_KEYS.map((key) => ({
    key, label_es: LABELS_ES[key],
    tasks: parse ? parse.tasks.filter((t) => t.section === key).map(publicTask) : [],
  }));
  if (!parse) return { slug, exists: false, sections, unparsed: [], writable: false, reason_es: "Todavía no hay lista de tareas" };
  const doc: TasksDoc = { slug, exists: true, sections, unparsed: parse.unparsed, writable: true };
  if (parse.duplicateHeadings.length) {
    doc.writable = false;
    doc.reason_es = "La lista tiene secciones repetidas; arréglala desde Claude Code";
  }
  return doc;
}

/** Display read (SQL copy). */
export async function getTasksDoc(): Promise<TasksDoc> {
  const slug = tasksSlug();
  const text = await tasksPageText(slug);
  return toDoc(slug, text == null ? null : parseTasks(text));
}

// ---------------------------------------------------------------------------
// Edit builders (pure). Each returns edit_page edits plus the affected task id.

export interface Edit { old_text: string; new_text: string }
export interface Built { edits: Edit[]; id: string }

/** Task text: ≤300 chars, no newlines, no HTML comment markers. */
export function sanitizeTaskText(s: unknown): string {
  return String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
    .trim();
}

/** Values inside the trailing parenthetical must not contain ; ( ) or newlines. */
export function sanitizeMetaValue(s: unknown, max = 300): string {
  return String(s ?? "").replace(/[\r\n]+/g, " ").replace(/<!--|-->/g, "").replace(/;/g, ",").replace(/[()]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function formatLine(done: boolean, id: string, text: string, meta: [string, string][]): string {
  const m = meta.filter(([, v]) => v !== "").map(([k, v]) => (k ? `${k}: ${v}` : v));
  return `- [${done ? "x" : " "}] <!-- id: ${id} --> ${text}${m.length ? ` (${m.join("; ")})` : ""}`;
}

function anchor(p: TasksParse, key: SectionKey): string {
  const h = p.headings[key];
  if (h === undefined) throw new TaskError(422, "missing_section", `Falta la sección ${key} en la lista; arréglala desde Claude Code`);
  return "\n" + h;
}

function findTask(p: TasksParse, id: string): ParsedTask {
  const t = p.tasks.find((x) => x.id === id);
  if (!t) throw new TaskError(404, "task_not_found", "No encontré esa tarea; recarga");
  if (p.duplicateIds.has(id)) throw new TaskError(409, "duplicate_id", "Esa tarea aparece dos veces en la lista; arréglala desde Claude Code");
  return t;
}

/** Removes a task block. Anchored on both ends when possible. */
function removeEdit(content: string, block: string): Edit {
  return content.includes("\n" + block + "\n")
    ? { old_text: "\n" + block + "\n", new_text: "\n" }
    : { old_text: "\n" + block, new_text: "" };
}

function insertEdit(p: TasksParse, key: SectionKey, lines: string[]): Edit {
  const a = anchor(p, key);
  return { old_text: a, new_text: a + "\n" + lines.join("\n") };
}

const keepMeta = (meta: [string, string][], drop: string[]) => meta.filter(([k]) => !drop.includes(k));

export function nextId(p: TasksParse, today: string): string {
  const ymd = today.replace(/-/g, "");
  let max = 0;
  for (const t of p.tasks) {
    const m = /^t-(\d{8})-(\d{2,3})$/.exec(t.id);
    if (m && m[1] === ymd) max = Math.max(max, Number(m[2]));
  }
  return `t-${ymd}-${String(max + 1).padStart(2, "0")}`;
}

export function buildAdd(p: TasksParse, args: { text: string; priority: SectionKey; due?: string }, today: string): Built {
  const id = nextId(p, today);
  const line = formatLine(false, id, args.text, args.due ? [["due", args.due]] : []);
  return { id, edits: [insertEdit(p, args.priority, [line])] };
}

export function buildDone(p: TasksParse, content: string, id: string, today: string): Built {
  const t = findTask(p, id);
  if (t.section === "Completed" && t.done) return { id, edits: [] };
  const line = formatLine(true, id, t.text, [...keepMeta(t.meta, ["due", "deferred until", "reason", "completed"]), ["completed", today]]);
  return { id, edits: [removeEdit(content, t.block), insertEdit(p, "Completed", [line, ...t.stepLines])] };
}

export function buildMove(p: TasksParse, content: string, id: string, priority: SectionKey): Built {
  const t = findTask(p, id);
  if (t.section === priority) return { id, edits: [] };
  let line = t.line;
  if (t.section === "Deferred" || t.section === "Completed" || t.done) {
    line = formatLine(false, id, t.text, keepMeta(t.meta, ["deferred until", "reason", "completed"]));
  }
  return { id, edits: [removeEdit(content, t.block), insertEdit(p, priority, [line, ...t.stepLines])] };
}

export function buildDefer(p: TasksParse, content: string, id: string, until: string, reason: string): Built {
  const t = findTask(p, id);
  const meta: [string, string][] = [...keepMeta(t.meta, ["deferred until", "reason", "completed"]), ["deferred until", until]];
  if (reason) meta.push(["reason", reason]);
  const line = formatLine(false, id, t.text, meta);
  return { id, edits: [removeEdit(content, t.block), insertEdit(p, "Deferred", [line, ...t.stepLines])] };
}

export function buildReopen(p: TasksParse, content: string, id: string): Built {
  const t = findTask(p, id);
  if (!t.done && t.section !== "Completed") return { id, edits: [] };
  const line = formatLine(false, id, t.text, keepMeta(t.meta, ["completed", "deferred until", "reason"]));
  return { id, edits: [removeEdit(content, t.block), insertEdit(p, "P1", [line, ...t.stepLines])] };
}

export function buildEdit(p: TasksParse, id: string, text: string): Built {
  const t = findTask(p, id);
  const line = formatLine(t.done, id, text, t.meta);
  if (line === t.line) return { id, edits: [] };
  return { id, edits: [{ old_text: "\n" + t.line, new_text: "\n" + line }] };
}

/**
 * Applies edits with edit_page's rules (in order, each old_text exactly once).
 * Used as a pre-flight check before writing and to compute the resulting task.
 */
export function applyEdits(content: string, edits: Edit[]): string {
  let text = content;
  for (const e of edits) {
    const first = text.indexOf(e.old_text);
    if (first < 0) throw new TaskError(409, "edit_no_match", "La lista cambió; recarga");
    if (text.indexOf(e.old_text, first + 1) >= 0) throw new TaskError(409, "edit_ambiguous", "Un texto de la lista aparece dos veces; arréglala desde Claude Code");
    text = text.slice(0, first) + e.new_text + text.slice(first + e.old_text.length);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Mutex + write path

let chain: Promise<unknown> = Promise.resolve();
/** Serialises every task write (and the page creation) inside this process. */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export type Action = (p: TasksParse, content: string, today: string) => Built;

/** get_page → build → edit_page(expected_revision); one retry on revision_conflict. */
export function mutateTasks(action: Action): Promise<Task> {
  return withLock(async () => {
    const slug = tasksSlug();
    for (let attempt = 0; attempt < 2; attempt++) {
      let page: any;
      try {
        page = await callTool("get_page", { slug, include_content: true, content_only: true });
      } catch (e) {
        if (e instanceof GbrainError && e.code === "page_not_found") throw new TaskError(404, "no_tasks_page", "Todavía no hay lista de tareas");
        throw e;
      }
      const content = String(page?.content ?? "");
      const revision = page?.revision;
      if (typeof revision !== "string" || !revision) throw new TaskError(502, "no_revision", "GBrain no devolvió la revisión de la lista");
      const today = localDay();
      const parse = parseTasks(content, today);
      if (parse.duplicateHeadings.length) throw new TaskError(409, "duplicate_sections", "La lista tiene secciones repetidas; arréglala desde Claude Code");
      const built = action(parse, content, today);
      const after = built.edits.length ? applyEdits(content, built.edits) : content;
      const task = parseTasks(after, today).tasks.find((t) => t.id === built.id);
      if (!built.edits.length) {
        if (!task) throw new TaskError(404, "task_not_found", "No encontré esa tarea; recarga");
        return publicTask(task);
      }
      try {
        await callTool("edit_page", { slug, expected_revision: revision, edits: built.edits });
      } catch (e) {
        if (e instanceof GbrainError && (e.code === "revision_conflict" || e.code === "edit_no_match")) {
          if (attempt === 0) continue;
          throw new TaskError(409, "conflict", "Otra sesión cambió las tareas; recarga");
        }
        throw e;
      }
      if (!task) throw new TaskError(500, "task_lost", "La tarea no aparece tras el cambio; recarga");
      return publicTask(task);
    }
    throw new TaskError(409, "conflict", "Otra sesión cambió las tareas; recarga");
  });
}

/** Path of the tasks page in the brain repo (to check gbrain wrote the file). */
export function tasksFilePath(slug: string = tasksSlug()): string {
  return join(config.brainDir, slug.endsWith(".md") ? slug : slug + ".md");
}

/**
 * "Crear lista de tareas": put_page without expected_revision/force (create-only),
 * then record which slug gbrain stored and whether the .md file exists.
 */
export function initTasksPage(): Promise<{ ok: true; slug: string; fileWritten: boolean; existed?: boolean }> {
  return withLock(async () => {
    const existing = await tasksStoredSlug();
    if (existing) {
      writeState({ tasksSlug: existing });
      return { ok: true as const, slug: existing, fileWritten: existsSync(tasksFilePath(existing)), existed: true };
    }
    await callTool("put_page", { slug: config.tasksSlug, content: TEMPLATE, content_origin: "user_said" });
    const stored = (await tasksStoredSlug()) ?? config.tasksSlug;
    writeState({ tasksSlug: stored });
    return { ok: true as const, slug: stored, fileWritten: existsSync(tasksFilePath(stored)) };
  });
}
