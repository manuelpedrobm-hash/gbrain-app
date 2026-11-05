// lib/pending.ts — "En tus páginas" heading scanner and the Mapa card
// (spec §6.3).
//
// The scanner takes pages whose headings say pendiente / próximos pasos /
// next steps / preguntas abiertas / open questions, and returns the bullets
// under each matching heading (up to the next heading of the same or higher
// level), at most 10 per heading. Read-only.
//
// Mapa: the "Mapa de misiones" now lives in the Misiones tab (a local copy of
// the claude.ai artifact, lib/artdb.ts); the Pendientes card links there. If a
// Claude session ever writes ~/.gbrain-panel/mapa-snapshot.json, it is shown read-only.

import { readFileSync } from "node:fs";
import { config, paths } from "./config.ts";

const HEADING_RE = /^(#{1,6}) (.*)$/;
const KEYWORDS = /(pendiente|próximos pasos|proximos pasos|next steps|preguntas abiertas|open questions)/i;
const BULLET_RE = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;

export interface PendingSection { slug: string; title: string; heading: string; items: string[] }

/** Cleans a bullet for display: checkbox, bold, wikilink syntax. The client escapes it. */
export function cleanBullet(s: string): string {
  return s
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .trim();
}

export function scanPendingHeadings(pages: { slug: string; title: string; compiled_truth: string }[]): PendingSection[] {
  const out: PendingSection[] = [];
  for (const p of pages) {
    const lines = p.compiled_truth.split(/\r?\n/);
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      const h = HEADING_RE.exec(lines[i]);
      if (!h || !KEYWORDS.test(h[2])) continue;
      const level = h[1].length;
      const items: string[] = [];
      let fence = false;
      for (let j = i + 1; j < lines.length && items.length < 10; j++) {
        if (/^\s*(```|~~~)/.test(lines[j])) { fence = !fence; continue; }
        if (fence) continue;
        const hh = HEADING_RE.exec(lines[j]);
        if (hh && hh[1].length <= level) break;
        const b = BULLET_RE.exec(lines[j]);
        if (b) {
          const text = cleanBullet(b[1]);
          if (text) items.push(text.slice(0, 500));
        }
      }
      if (items.length) out.push({ slug: p.slug, title: p.title, heading: h[2].replace(/\*\*/g, "").trim(), items });
    }
  }
  return out;
}

export interface MapaCard {
  mode: "link" | "snapshot";
  url: string;
  snapshotAt?: string;
  open?: { title: string; day: string; frente: string }[];
}

export function getMapaCard(): MapaCard {
  try {
    const snap = JSON.parse(readFileSync(paths.mapaSnapshot, "utf8"));
    if (snap && Array.isArray(snap.missions)) {
      const open = snap.missions
        .filter((m: any) => m && !m.done)
        .map((m: any) => ({ title: String(m.title ?? ""), day: String(m.day ?? ""), frente: String(m.frente ?? "") }))
        .slice(0, 200);
      return { mode: "snapshot", url: String(snap.url || config.mapaUrl), snapshotAt: String(snap.exportedAt ?? ""), open };
    }
  } catch { /* no snapshot: link only (decision B) */ }
  return { mode: "link", url: config.mapaUrl };
}
