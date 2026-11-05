// lib/diario.ts — "Diario de __ORG__" tab.
//
// The diary is one Markdown file per day, YYYY-MM-DD.md, in
// ~/Documents/DIARIO (the original). The brain keeps a
// copy in sources/informes-claude/DIARIO, refreshed every night.
//
// Reading: every YYYY-MM-DD*.md of both folders, newest first; when the panel
// can read the original, its version wins (it may have today's notes).
// Writing: only APPENDS to today's file in the original folder, under a
// "## Apuntes desde el panel" heading. It never rewrites or truncates a file:
// a new file is created with flag "wx", an existing one is opened for append.
// macOS may refuse the launchd process access to the Desktop (privacy, TCC):
// that comes back as EPERM and is reported in Spanish, never worked around.

import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

let ORIG_DIR = "__HOME__/Documents/DIARIO";
let BRAIN_DIR = join(config.brainDir, "sources/informes-claude/DIARIO");

export const HEADING = "## Apuntes desde el panel";
const FILE_RE = /^(\d{4}-\d{2}-\d{2})[^/]*\.md$/;
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export class DiarioError extends Error {
  constructor(public status: number, public code: string, public message_es: string) { super(message_es); }
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const NO_PERMISSION_ES =
  "macOS no deja al panel escribir en el Escritorio. Para permitirlo: Ajustes del Sistema → Privacidad y seguridad → " +
  "Archivos y carpetas (o Acceso total al disco) → activa «bun» para la carpeta Escritorio, y reinicia el panel. " +
  "Mientras tanto, apunta en el diario desde Claude Code.";

function isPermError(e: any) { return e?.code === "EPERM" || e?.code === "EACCES"; }

function listDir(dir: string): { files: string[]; error?: string } {
  try { return { files: readdirSync(dir).filter((f) => FILE_RE.test(f)) }; }
  catch (e: any) { return { files: [], error: String(e?.code ?? "error") }; }
}

export interface DiarioEntry { file: string; date: string; title: string; markdown: string; source: "original" | "cerebro"; mtime: string }

export function listEntries(limit = 60): { entries: DiarioEntry[]; original: { readable: boolean; error?: string; dir: string } } {
  const orig = listDir(ORIG_DIR);
  const brain = listDir(BRAIN_DIR);
  const byName = new Map<string, { dir: string; source: "original" | "cerebro" }>();
  for (const f of brain.files) byName.set(f, { dir: BRAIN_DIR, source: "cerebro" });
  for (const f of orig.files) byName.set(f, { dir: ORIG_DIR, source: "original" });
  const names = [...byName.keys()].sort().reverse().slice(0, limit);
  const entries: DiarioEntry[] = [];
  for (const name of names) {
    let { dir, source } = byName.get(name)!;
    let text: string, st;
    try { text = readFileSync(join(dir, name), "utf8"); st = statSync(join(dir, name)); }
    catch {
      if (source === "original" && brain.files.includes(name)) {
        dir = BRAIN_DIR; source = "cerebro";
        try { text = readFileSync(join(dir, name), "utf8"); st = statSync(join(dir, name)); } catch { continue; }
      } else continue;
    }
    const h1 = /^#\s+(.+)$/m.exec(text);
    entries.push({ file: name, date: FILE_RE.exec(name)![1], title: h1 ? h1[1].trim() : name, markdown: text, source, mtime: st.mtime.toISOString() });
  }
  return { entries, original: { readable: !orig.error, ...(orig.error ? { error: orig.error } : {}), dir: ORIG_DIR } };
}

/** Cleans one diary line: no control characters, one line, ≤ 1000 characters. */
export function cleanLine(v: unknown): string {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
}

/** Appends "- **HH:MM** — text" to today's file in the original folder. Never overwrites. */
export function appendEntry(text: unknown, now: Date = new Date()): { ok: true; file: string; line: string } {
  const t = cleanLine(text);
  if (!t) throw new DiarioError(400, "empty", "Escribe algo para apuntar");
  const file = join(ORIG_DIR, `${dayOf(now)}.md`);
  const line = `- **${pad(now.getHours())}:${pad(now.getMinutes())}** — ${t}\n`;
  try {
    let existing: string | null = null;
    try { existing = readFileSync(file, "utf8"); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    if (existing === null) {
      const head = `# ${now.getDate()} de ${MESES[now.getMonth()]} de ${now.getFullYear()}\n\n${HEADING}\n\n`;
      try {
        writeFileSync(file, head + line, { flag: "wx", mode: 0o644 });
        return { ok: true, file, line: line.trim() };
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        existing = readFileSync(file, "utf8"); // created meanwhile: append below
      }
    }
    const headings = existing.match(/^## .*$/gm) || [];
    const underOurs = headings.length > 0 && headings[headings.length - 1].trim() === HEADING;
    let add = existing.length && !existing.endsWith("\n") ? "\n" : "";
    if (!underOurs) add += `\n${HEADING}\n\n`;
    appendFileSync(file, add + line, { flag: "a" });
    return { ok: true, file, line: line.trim() };
  } catch (e: any) {
    if (isPermError(e)) throw new DiarioError(403, "sin_permiso", NO_PERMISSION_ES);
    if (e?.code === "ENOENT") throw new DiarioError(404, "sin_carpeta", `No encuentro la carpeta del diario (${ORIG_DIR}).`);
    throw e;
  }
}

/** Same as appendEntry but never throws (used by the "done" hooks). */
export function appendQuiet(text: string): void {
  try { appendEntry(text); }
  catch (e: any) { console.error(`[cerebro] diario: no pude apuntar (${String(e?.code ?? e?.message ?? e).slice(0, 80)})`); }
}

export const __testing = {
  setDirs(orig: string, brain: string) { ORIG_DIR = orig; BRAIN_DIR = brain; },
};
