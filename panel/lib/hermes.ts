// lib/hermes.ts — the pushes Hermes sends ("Hermes" tab).
//
// ops/hermes-empuje.sh appends every round that had something to say to a brain
// page per month, <brainDir>/ops/hermes/empuje-YYYY-MM.md, each under a
// "## YYYY-MM-DD HH:MM" heading (rounds answered "SIN NOVEDAD" are not saved).
// This module only reads those files, newest round first. Read-only.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

let DIR = join(config.brainDir, "ops/hermes");

const FILE_RE = /^empuje-(\d{4}-\d{2})\.md$/;
const HEADING_RE = /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s*$/;

export interface HermesRound { id: string; date: string; time: string; markdown: string; urgent: string }
export interface HermesSummary { id: string; date: string; time: string; urgent: string; hilos: number; parados: number }

const clean = (t: string) => t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").trim();

/** The whole "Lo más urgente ahora" paragraph (up to the blank line), for the Hoy card. */
export function urgentFullOf(md: string): string {
  const m = /Lo más urgente ahora:\s*([^\n]+(?:\n(?!\s*\n)(?![⏳🧊✅])[^\n]+)*)/i.exec(md);
  if (!m) return "";
  const t = clean(m[1].replace(/\n/g, " "));
  return t.length > 420 ? t.slice(0, 417).trimEnd() + "…" : t;
}

/** Number of lines under a section marker ("⏳ Hilos colgados:") up to the next blank line. */
export function countSection(md: string, marker: string): number {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.includes(marker));
  if (i < 0) return 0;
  let n = 0;
  for (let j = i + 1; j < lines.length && lines[j].trim(); j++) n++;
  return n;
}

export function summarize(r: HermesRound): HermesSummary {
  return { id: r.id, date: r.date, time: r.time, urgent: urgentFullOf(r.markdown) || r.urgent,
    hilos: countSection(r.markdown, "Hilos colgados"), parados: countSection(r.markdown, "Frentes parados") };
}

/** Newest modification time of the monthly pages: lets the browser poll notice a new round at once. */
export function hermesMtimeMs(): number {
  try {
    let max = 0;
    for (const f of readdirSync(DIR)) if (FILE_RE.test(f)) max = Math.max(max, statSync(join(DIR, f)).mtimeMs);
    return max;
  } catch { return 0; }
}

/** First line after "Lo más urgente ahora:", shown as the card summary. */
export function urgentOf(md: string): string {
  const m = /Lo más urgente ahora:\s*([^\n]+)/i.exec(md);
  if (!m) return "";
  const t = clean(m[1]);
  return t.length > 160 ? t.slice(0, 157).trimEnd() + "…" : t;
}

/** Splits one monthly page into its rounds. Text before the first round heading is ignored. */
export function parseRounds(text: string): HermesRound[] {
  const out: HermesRound[] = [];
  let cur: { date: string; time: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const markdown = cur.lines.join("\n").trim();
    if (markdown) out.push({ id: `${cur.date} ${cur.time}`, date: cur.date, time: cur.time, markdown, urgent: urgentOf(markdown) });
  };
  for (const line of String(text).split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m) { flush(); cur = { date: m[1], time: m[2], lines: [] }; continue; }
    if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

/** Newest rounds first, across all monthly pages. */
export function listRounds(limit = 60): { rounds: HermesRound[]; total: number; folder: boolean } {
  let files: string[];
  try { files = readdirSync(DIR).filter((f) => FILE_RE.test(f)).sort().reverse(); }
  catch { return { rounds: [], total: 0, folder: false }; }
  const all: HermesRound[] = [];
  for (const f of files) {
    try { all.push(...parseRounds(readFileSync(join(DIR, f), "utf8"))); } catch { /* unreadable month: skip */ }
  }
  all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { rounds: all.slice(0, limit), total: all.length, folder: true };
}

export const __testing = { setDir(d: string) { DIR = d; } };
