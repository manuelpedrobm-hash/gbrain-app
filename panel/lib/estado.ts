// lib/estado.ts — deadlines from the "## Fechas que vencen" table in
// sources/informes-claude/ESTADO.md, with a Spanish short-date parser (spec §6.3).
//
// Row examples: "| **28 oct** | … |", "| 30 oct, 10:00 CET | … |",
// "| 15 ene 2027 | … |". A missing year takes the year of the file's mtime;
// if that lands more than 60 days before the mtime, the next year.

import { statSync, readFileSync } from "node:fs";
import { config, localDay } from "./config.ts";

export const ESTADO_SLUG = "sources/informes-claude/estado";

const MONTHS: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12,
};
const DATE_RE = /(\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)(?: (\d{4}))?(?:, (\d{1,2}:\d{2})\s*([A-Za-z]+))?/i;
const ROW_RE = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/;

export interface Deadline {
  date: string;            // YYYY-MM-DD
  label: string;
  timeLabel?: string;      // raw time + zone, e.g. "15:00 EST"
  source: "estado" | "task" | "commitment";
  ref: string;             // page slug, task id or fact id
  urgency: "red" | "amber" | "normal";
  past: boolean;
}

const stripBold = (s: string) => s.replace(/\*\*/g, "").trim();

/** Parses one Spanish short date. `mtime` decides the year when it is missing. */
export function parseSpanishDate(text: string, mtime: Date): { date: string; timeLabel?: string } | null {
  const m = DATE_RE.exec(stripBold(text));
  if (!m) return null;
  const dayN = Number(m[1]);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month || dayN < 1 || dayN > 31) return null;
  let year = m[3] ? Number(m[3]) : mtime.getFullYear();
  if (!m[3]) {
    const candidate = new Date(year, month - 1, dayN);
    if (mtime.getTime() - candidate.getTime() > 60 * 86400_000) year += 1;
  }
  const d = new Date(year, month - 1, dayN);
  if (d.getMonth() !== month - 1) return null; // e.g. 31 nov
  const out: { date: string; timeLabel?: string } = { date: localDay(d) };
  if (m[4]) out.timeLabel = m[5] ? `${m[4]} ${m[5]}` : m[4];
  return out;
}

/** Whole days from `today` (YYYY-MM-DD) to `date` (YYYY-MM-DD). */
export function daysUntil(date: string, today: string): number {
  const [y1, m1, d1] = date.split("-").map(Number);
  const [y2, m2, d2] = today.split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400_000);
}

export function urgencyFor(date: string, today: string): "red" | "amber" | "normal" {
  const d = daysUntil(date, today);
  if (d <= 2) return "red";
  if (d <= 7) return "amber";
  return "normal";
}

/** Parses the "## Fechas que vencen" table out of ESTADO.md text. */
export function parseEstado(text: string, mtime: Date, now: Date = new Date()): Deadline[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Fechas que vencen\b/i.test(l.trim()));
  if (start < 0) return [];
  const today = localDay(now);
  const rows: Deadline[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,2}\s/.test(line)) break; // next section
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const c1 = stripBold(m[1]), c2 = stripBold(m[2]);
    if (/^:?-{3,}/.test(c1) || /^fecha$/i.test(c1)) continue; // header and separator
    const parsed = parseSpanishDate(c1, mtime);
    if (!parsed) continue;
    const row: Deadline = {
      date: parsed.date,
      label: c2,
      source: "estado",
      ref: ESTADO_SLUG,
      urgency: urgencyFor(parsed.date, today),
      past: parsed.date < today,
    };
    if (parsed.timeLabel) row.timeLabel = parsed.timeLabel;
    rows.push(row);
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export interface EstadoResult {
  ok: boolean;
  rows: Deadline[];
  mtime: string | null;
  ageDays: number | null;
  stale: boolean;          // file older than 3 days: the chip turns amber
  slug: string;
  error_es?: string;
}

/** Reads ESTADO.md from disk. Never throws. */
export function getEstado(now: Date = new Date(), file: string = config.estadoFile): EstadoResult {
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    const ageDays = Math.floor((now.getTime() - st.mtime.getTime()) / 86400_000);
    return { ok: true, rows: parseEstado(text, st.mtime, now), mtime: st.mtime.toISOString(), ageDays, stale: ageDays > 3, slug: ESTADO_SLUG };
  } catch {
    return { ok: false, rows: [], mtime: null, ageDays: null, stale: true, slug: ESTADO_SLUG, error_es: "No pude leer ESTADO.md" };
  }
}

export function estadoMtimeMs(file: string = config.estadoFile): number {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}
