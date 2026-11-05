// lib/pending.ts — "En tus páginas" heading scanner
// (spec §6.3).
//
// The scanner takes pages whose headings say pendiente / próximos pasos /
// next steps / preguntas abiertas / open questions, and returns the bullets
// under each matching heading (up to the next heading of the same or higher
// level), at most 10 per heading. Read-only.
//

import { readFileSync } from "node:fs";

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
