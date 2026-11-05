// lib/estrategia.ts — pestaña «Estrategia»: lee la página del cerebro ops/estrategia
// (solo lectura) y saca de sus tablas Markdown tres cosas: los frentes propuestos,
// la hoja de ruta con su estado y las decisiones abiertas. Si una tabla no se deja
// leer, esa parte sale como null y el cliente enseña el texto tal cual.
//
// El HTML de la página lo genera lib/render.ts (el mismo renderizador seguro del
// resto del panel); aquí no se construye HTML.

export const ESTRATEGIA_SLUG = "ops/estrategia";

export type RoadmapStatus = "HECHO" | "EN CURSO" | "NECESITA TU SI" | "IDEA";
export const ROADMAP_STATUSES: RoadmapStatus[] = ["HECHO", "EN CURSO", "NECESITA TU SI", "IDEA"];

export interface Frente { accion: string; frente: string; detalle: string }
export interface RoadmapItem { status: RoadmapStatus; text: string }
export interface Decision { decision: string; pregunta: string }

export interface EstrategiaParsed {
  frentes: Frente[] | null;
  /** Los frentes con acción «Activo N». */
  activos: Frente[] | null;
  roadmap: RoadmapItem[] | null;
  decisiones: Decision[] | null;
  /** true si la página dice que la propuesta NO está decidida (o no dice lo contrario). */
  pendienteDe__NOMBRE__: boolean;
}

/** Minúsculas sin tildes ni mayúsculas, para comparar etiquetas. */
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Quita negritas, código y la sintaxis de wikilinks para mostrar texto plano. */
export function plainCell(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .trim();
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Devuelve las filas de la primera tabla que hay bajo el encabezado cuyo texto
 * (sin tildes, en minúsculas) contiene `headingPart`. null si no hay tabla.
 */
export function tableUnder(md: string, headingPart: string): { header: string[]; rows: string[][] } | null {
  const lines = md.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  const want = norm(headingPart);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (h && norm(h[2]).includes(want)) { start = i + 1; break; }
  }
  if (start < 0) return null;
  let i = start;
  for (; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) return null; // otro encabezado antes de ninguna tabla
    if (lines[i].trim().startsWith("|") && lines[i + 1] && SEPARATOR_RE.test(lines[i + 1])) break;
  }
  if (i >= lines.length) return null;
  const header = splitRow(lines[i]).map(plainCell);
  const rows: string[][] = [];
  for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) rows.push(splitRow(lines[j]));
  return { header, rows };
}

export function statusOf(label: string): RoadmapStatus | null {
  const n = norm(plainCell(label)).replace(/\s+/g, " ");
  if (n === "hecho") return "HECHO";
  if (n === "en curso") return "EN CURSO";
  if (n === "necesita tu si") return "NECESITA TU SI";
  if (n === "idea") return "IDEA";
  return null;
}

function parseRoadmap(md: string): RoadmapItem[] | null {
  const t = tableUnder(md, "hoja de ruta");
  if (!t || t.header.length < 2) return null;
  const items: RoadmapItem[] = [];
  for (const r of t.rows) {
    if (r.length < 2) return null;
    const status = statusOf(r[0]);
    if (!status) return null; // una etiqueta desconocida: mejor enseñar el texto que adivinar
    const text = plainCell(r.slice(1).join(" | "));
    if (text) items.push({ status, text: text.slice(0, 500) });
  }
  return items.length ? items : null;
}

function parseFrentes(md: string): Frente[] | null {
  const t = tableUnder(md, "frentes");
  if (!t || t.header.length < 3) return null;
  const out: Frente[] = [];
  for (const r of t.rows) {
    if (r.length < 3) return null;
    out.push({ accion: plainCell(r[0]).slice(0, 80), frente: plainCell(r[1]).slice(0, 300), detalle: plainCell(r.slice(2).join(" | ")).slice(0, 500) });
  }
  return out.length ? out : null;
}

function parseDecisiones(md: string): Decision[] | null {
  const t = tableUnder(md, "decisiones abiertas");
  if (!t || t.header.length < 2) return null;
  const out: Decision[] = [];
  for (const r of t.rows) {
    if (r.length < 2) return null;
    out.push({ decision: plainCell(r[0]).slice(0, 200), pregunta: plainCell(r.slice(1).join(" | ")).slice(0, 500) });
  }
  return out.length ? out : null;
}

export function parseEstrategia(md: string): EstrategiaParsed {
  const frentes = parseFrentes(md);
  const activos = frentes ? frentes.filter((f) => /^activo\b/i.test(norm(f.accion))) : null;
  // «NO decidida» / «a decidir por __NOMBRE__» = pendiente. Solo si dice «decidido por __NOMBRE__» sin NO pasa a decidido.
  const n = norm(md);
  const decided = /\bdecidido por [^\s.,;:]+\b/.test(n) && !/\b(no decidid[oa]|a decidir)\b/.test(n);
  return {
    frentes,
    activos: activos && activos.length ? activos : null,
    roadmap: parseRoadmap(md),
    decisiones: parseDecisiones(md),
    pendienteDe__NOMBRE__: !decided,
  };
}

/** Cuenta de elementos por estado, para la cabecera de la hoja de ruta. */
export function countByStatus(items: RoadmapItem[]): Record<RoadmapStatus, number> {
  const c: Record<RoadmapStatus, number> = { "HECHO": 0, "EN CURSO": 0, "NECESITA TU SI": 0, "IDEA": 0 };
  for (const i of items) c[i.status]++;
  return c;
}

export interface EstrategiaView extends EstrategiaParsed {
  ok: boolean;
  slug: string;
  html: string;
  markdown: string;
  error_es?: string;
}

export function buildEstrategiaView(
  md: string | null,
  render: (md: string) => string,
): EstrategiaView {
  if (md == null) {
    return {
      ok: false, slug: ESTRATEGIA_SLUG, html: "", markdown: "", frentes: null, activos: null, roadmap: null,
      decisiones: null, pendienteDe__NOMBRE__: true, error_es: "La página ops/estrategia todavía no existe en el cerebro",
    };
  }
  let parsed: EstrategiaParsed;
  try {
    parsed = parseEstrategia(md);
  } catch {
    parsed = { frentes: null, activos: null, roadmap: null, decisiones: null, pendienteDe__NOMBRE__: true };
  }
  return { ok: true, slug: ESTRATEGIA_SLUG, html: render(md), markdown: md, ...parsed };
}
