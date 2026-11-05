// lib/db.ts — read-only Postgres pool, startup self-test and every SQL query
// the panel runs (spec §2, §6). Tagged templates only: every value is a bound
// parameter. The connection sets default_transaction_read_only=on, and
// selfTest() proves it before the server starts listening.
//
// Never write through SQL: gbrain's triggers guard pages and facts, and all
// writes go through `gbrain call` (lib/gbrain.ts).

import { SQL } from "bun";
import { DB_URL } from "./config.ts";

export const sql = new SQL({
  url: DB_URL,
  max: 4,
  connection: { default_transaction_read_only: "on", application_name: "gbrain-panel" },
});

// ---------------------------------------------------------------------------
// Row normalisers. Bun returns bigint/count as strings and timestamps as Date.

export function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  return String(v);
}

/** For `date` columns (Bun gives UTC midnight): YYYY-MM-DD. */
export function day(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const n = (v: unknown) => (v == null ? 0 : Number(v));

export interface Fact {
  id: string; kind: string; entity_slug: string | null; fact: string; source: string;
  confidence: number | null; trust_tier: string | null; created_at: string | null;
  valid_from?: string | null; valid_until?: string | null; expired_at?: string | null;
}

function toFact(r: any): Fact {
  const f: Fact = {
    id: String(r.id), kind: r.kind, entity_slug: r.entity_slug ?? null, fact: r.fact, source: r.source ?? "",
    confidence: r.confidence == null ? null : Number(r.confidence), trust_tier: r.trust_tier ?? null,
    created_at: iso(r.created_at),
  };
  if ("valid_from" in r) f.valid_from = iso(r.valid_from);
  if ("valid_until" in r) f.valid_until = iso(r.valid_until);
  if ("expired_at" in r) f.expired_at = iso(r.expired_at);
  return f;
}

/** Escapes % _ and \ for ILIKE (default escape character is backslash). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

// ---------------------------------------------------------------------------
// Self-test and known slugs

/**
 * Proves the connection is read-only: CREATE TEMP TABLE must fail with
 * "read-only transaction". `conn` is injectable for tests only.
 *
 * Note (security audit 2026-10-26): this proves the session default only. The
 * role is a superuser, so a query could still turn it off; that is why every
 * query is a tagged template (test/chat.test.ts greps lib/ for sql.unsafe). A
 * SELECT-only role would close it, but that is a database change for __NOMBRE__.
 */
export async function selfTest(conn: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> = sql): Promise<{ ok: boolean; message: string }> {
  try {
    await conn`CREATE TEMP TABLE _probe(x int)`;
    return { ok: false, message: "CREATE TEMP TABLE funcionó: la conexión NO es de solo lectura" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/read-only transaction/i.test(msg) || e?.errno === "25006") return { ok: true, message: "conexión de solo lectura comprobada" };
    return { ok: false, message: "Postgres no respondió como se esperaba: " + msg.slice(0, 200) };
  }
}

export async function ping(): Promise<boolean> {
  const r = await sql`SELECT 1 AS one`;
  return Number(r[0]?.one) === 1;
}

let knownCache: { at: number; set: Set<string> } | null = null;

/** Slugs plus aliases, for wikilink resolution. Cached 5 minutes. */
export async function getKnownSlugs(): Promise<Set<string>> {
  if (knownCache && Date.now() - knownCache.at < 5 * 60_000) return knownCache.set;
  const rows = await sql`
    SELECT slug AS k FROM pages WHERE deleted_at IS NULL
    UNION SELECT alias_norm FROM page_aliases WHERE alias_norm IS NOT NULL
    UNION SELECT alias_text FROM page_aliases WHERE alias_text IS NOT NULL`;
  const set = new Set<string>();
  for (const r of rows) if (r.k) set.add(String(r.k));
  knownCache = { at: Date.now(), set };
  return set;
}

// ---------------------------------------------------------------------------
// Header: palette index, search, pulse (§6.1)

export async function getIndex() {
  const pages = await sql`
    SELECT p.slug s, p.title t, p.type y,
      COALESCE((SELECT array_agg(DISTINCT COALESCE(a.alias_text, a.alias_norm))
                FROM page_aliases a WHERE a.slug = p.slug AND COALESCE(a.alias_text, a.alias_norm) IS NOT NULL), '{}') a
    FROM pages p WHERE p.deleted_at IS NULL`;
  const tags = await sql`SELECT tag, count(*) n FROM tags GROUP BY tag ORDER BY n DESC`;
  return {
    pages: pages.map((r: any) => ({ s: r.s, t: r.t, y: r.y, a: Array.isArray(r.a) ? r.a : [] })),
    tags: tags.map((r: any) => ({ tag: r.tag, n: n(r.n) })),
  };
}

const HL = "StartSel=\u0001,StopSel=\u0002,MaxWords=18,MinWords=6,MaxFragments=1";

/** Full-text + title/slug search. Snippets carry \u0001…\u0002 markers; the client escapes then marks. */
export async function search(q: string) {
  const pat = `%${escapeLike(q)}%`;
  const pages = await sql`
    SELECT slug, type, title, ts_headline('spanish', left(compiled_truth, 20000), q, ${HL}) snip, ts_rank(search_vector, q) r
    FROM pages, websearch_to_tsquery('spanish', ${q}) q
    WHERE deleted_at IS NULL AND (search_vector @@ q OR title ILIKE ${pat} OR slug ILIKE ${pat})
    ORDER BY (type <> 'conversation') DESC, r DESC LIMIT 20`;
  const facts = await sql`
    SELECT id, kind, entity_slug, fact, source, confidence, trust_tier, created_at FROM facts
    WHERE expired_at IS NULL AND fact ILIKE ${pat} ORDER BY created_at DESC LIMIT 10`;
  return {
    pages: pages.map((r: any) => ({ slug: r.slug, type: r.type, title: r.title, snip: r.snip ?? "", r: Number(r.r) || 0 })),
    facts: facts.map(toFact),
  };
}

export async function pulseRow() {
  const r = await sql`
    SELECT (SELECT max(updated_at) FROM pages) pu, (SELECT count(*) FROM pages WHERE deleted_at IS NULL) pc,
           (SELECT max(created_at) FROM facts) fc, (SELECT max(expired_at) FROM facts) fe,
           (SELECT count(*) FROM timeline_entries) tc`;
  const x = r[0] ?? {};
  return { pu: iso(x.pu), pc: n(x.pc), fc: iso(x.fc), fe: iso(x.fe), tc: n(x.tc) };
}

// ---------------------------------------------------------------------------
// Hoy (§6.2)

export async function sinceLastSeen(lastSeen: string) {
  const ts = new Date(lastSeen);
  const facts = await sql`
    SELECT id, kind, entity_slug, fact, source, confidence, trust_tier, created_at FROM facts
    WHERE expired_at IS NULL AND created_at > ${ts} ORDER BY created_at DESC LIMIT 10`;
  const retired = await sql`
    SELECT id, fact, expired_at FROM facts WHERE expired_at > ${ts} ORDER BY expired_at DESC LIMIT 5`;
  const pages = await sql`
    SELECT slug, type, title, updated_at, ingested_via FROM pages
    WHERE deleted_at IS NULL AND type <> 'conversation' AND updated_at > ${ts} ORDER BY updated_at DESC LIMIT 10`;
  return {
    facts: facts.map(toFact),
    retired: retired.map((r: any) => ({ id: String(r.id), fact: r.fact, expired_at: iso(r.expired_at) })),
    pages: pages.map((r: any) => ({ slug: r.slug, type: r.type, title: r.title, updated_at: iso(r.updated_at), ingested_via: r.ingested_via ?? null })),
  };
}

export async function inbox(limit = 5) {
  const rows = await sql`
    SELECT slug, title, created_at FROM pages
    WHERE deleted_at IS NULL AND slug LIKE 'inbox/%' ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r: any) => ({ slug: r.slug, title: r.title, created_at: iso(r.created_at) }));
}

// ---------------------------------------------------------------------------
// Pendientes (§6.3)

/** Display copy of the tasks page. Writes never use this: they re-read via get_page. */
export async function tasksPageText(slug: string): Promise<string | null> {
  const rows = await sql`SELECT compiled_truth FROM pages WHERE slug = ${slug} AND deleted_at IS NULL`;
  return rows.length ? String(rows[0].compiled_truth ?? "") : null;
}

/** Which slug gbrain stored for the tasks page after put_page. */
export async function tasksStoredSlug(): Promise<string | null> {
  const rows = await sql`SELECT slug FROM pages WHERE slug IN ('ops/tasks', 'ops/tasks.md') AND deleted_at IS NULL ORDER BY slug LIMIT 1`;
  return rows.length ? rows[0].slug : null;
}

export async function commitments(): Promise<Fact[]> {
  const rows = await sql`
    SELECT id, kind, entity_slug, fact, valid_from, valid_until, source, confidence, trust_tier, created_at FROM facts
    WHERE kind = 'commitment' AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())
    ORDER BY created_at DESC`;
  return rows.map(toFact);
}

/** Pages with pending-type headings (scanned in JS by lib/pending.ts). */
export async function pendingHeadingPages() {
  const rows = await sql`
    SELECT slug, title, compiled_truth FROM pages
    WHERE deleted_at IS NULL AND type IN ('project', 'source', 'note', 'person')
      AND slug <> 'sources/informes-claude/estado'
      AND compiled_truth ~* ${"(^|\n)#{1,6} [^\n]*(pendiente|próximos pasos|next steps|preguntas abiertas|open questions)"}`;
  return rows.map((r: any) => ({ slug: r.slug, title: r.title, compiled_truth: String(r.compiled_truth ?? "") }));
}

// ---------------------------------------------------------------------------
// Memoria (§6.5)

export async function typeCounts(): Promise<Record<string, number>> {
  const rows = await sql`SELECT type, count(*) n FROM pages WHERE deleted_at IS NULL GROUP BY type`;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = n(r.n);
  return out;
}

/** Person/project cards (and the same rows for lists). type and tag are optional filters. */
export async function pageCards(opts: { type?: string | null; tag?: string | null }) {
  const type = opts.type ?? null, tag = opts.tag ?? null;
  const rows = await sql`
    SELECT p.slug, p.title, p.type, CASE WHEN p.effective_date_source = 'fallback' THEN NULL ELSE p.effective_date END effective_date, p.frontmatter->>'updated' fm_updated,
     (SELECT count(*) FROM links l JOIN pages f ON f.id = l.from_page_id WHERE l.to_page_id = p.id AND f.deleted_at IS NULL) inbound,
     (SELECT max(te.date) FROM timeline_entries te WHERE te.page_id = p.id) last_tl,
     (SELECT max(CASE WHEN f.effective_date_source = 'fallback' THEN NULL ELSE f.effective_date END) FROM links l JOIN pages f ON f.id = l.from_page_id WHERE l.to_page_id = p.id AND f.deleted_at IS NULL) last_mention,
     (SELECT max(fa.created_at) FROM facts fa WHERE fa.entity_slug = p.slug) last_fact,
     (SELECT count(*) FROM facts fa WHERE fa.entity_slug = p.slug AND fa.expired_at IS NULL) facts,
     (SELECT coalesce(array_agg(t.tag ORDER BY t.tag), '{}') FROM tags t WHERE t.page_id = p.id) tags
    FROM pages p
    WHERE p.deleted_at IS NULL
      AND (${type}::text IS NULL OR p.type = ${type}::text)
      AND (${type}::text IS NOT NULL OR p.type <> 'conversation')
      AND (${tag}::text IS NULL OR EXISTS (SELECT 1 FROM tags t2 WHERE t2.page_id = p.id AND t2.tag = ${tag}::text))
    ORDER BY inbound DESC, p.title LIMIT 300`;
  return rows.map((r: any) => ({
    slug: r.slug, type: r.type, title: r.title, inbound: n(r.inbound), facts: n(r.facts),
    tags: Array.isArray(r.tags) ? r.tags : [],
    dates: { effective: iso(r.effective_date), fm_updated: r.fm_updated ?? null, last_tl: day(r.last_tl), last_mention: iso(r.last_mention), last_fact: iso(r.last_fact) },
  }));
}

/** Reuniones: preparación y notas (reuniones/<fecha>-...) y transcripciones (reuniones/transcripciones/...). Solo lectura. */
export async function reuniones() {
  const rows = await sql`
    SELECT slug, title, frontmatter->>'date' date, frontmatter->>'estado' estado, frontmatter->>'con' con, length(compiled_truth) chars FROM pages
    WHERE deleted_at IS NULL AND slug LIKE 'reuniones/%' AND slug <> 'reuniones/readme' ORDER BY frontmatter->>'date' DESC NULLS LAST, title LIMIT 500`;
  return rows.map((r: any) => ({ slug: r.slug, title: r.title, kind: String(r.slug).startsWith("reuniones/transcripciones/") ? "transcripcion" : "nota",
    date: r.date ? String(r.date).slice(0, 10) : null, estado: r.estado ?? null, con: r.con ?? null, chars: Number(r.chars) }));
}

/** Informes de trabajo: páginas informes/<tema>/<nombre>. Solo lectura. */
export async function informes() {
  const rows = await sql`
    SELECT slug, title, frontmatter->>'date' date, length(compiled_truth) chars FROM pages
    WHERE deleted_at IS NULL AND slug LIKE 'informes/%' ORDER BY frontmatter->>'date' DESC NULLS LAST, title LIMIT 300`;
  return rows.map((r: any) => ({ slug: r.slug, title: r.title, tema: String(r.slug).split("/")[1] ?? "", date: r.date ? String(r.date).slice(0, 10) : null, chars: Number(r.chars) }));
}

export async function conversations() {
  const rows = await sql`
    SELECT slug, title, frontmatter->>'date' date, frontmatter->>'messages' messages FROM pages
    WHERE deleted_at IS NULL AND type = 'conversation' ORDER BY frontmatter->>'date' DESC NULLS LAST LIMIT 300`;
  return rows.map((r: any) => ({ slug: r.slug, title: r.title, date: r.date ?? null, messages: r.messages == null ? null : Number(r.messages) }));
}

/** Everything the page view needs, or null. Falls back to an alias (page_aliases.alias_norm). */
export async function getPageBundle(slugIn: string, timelineLimit = 30) {
  let rows = await sql`
    SELECT id, slug, type, title, compiled_truth, frontmatter, CASE WHEN effective_date_source = 'fallback' THEN NULL ELSE effective_date END effective_date, source_path, ingested_via
    FROM pages WHERE slug = ${slugIn} AND deleted_at IS NULL LIMIT 1`;
  if (!rows.length) {
    const alias = await sql`
      SELECT p.slug FROM page_aliases a JOIN pages p ON p.slug = a.slug AND p.deleted_at IS NULL
      WHERE a.alias_norm = lower(${slugIn}) OR a.alias_text = ${slugIn} LIMIT 1`;
    if (!alias.length) return null;
    rows = await sql`
      SELECT id, slug, type, title, compiled_truth, frontmatter, CASE WHEN effective_date_source = 'fallback' THEN NULL ELSE effective_date END effective_date, source_path, ingested_via
      FROM pages WHERE slug = ${alias[0].slug} AND deleted_at IS NULL LIMIT 1`;
    if (!rows.length) return null;
  }
  const p = rows[0];
  const id = p.id, slug = p.slug;
  const [tags, aliases, facts, timeline, backlinks, outlinks] = await Promise.all([
    sql`SELECT tag FROM tags WHERE page_id = ${id} ORDER BY tag`,
    sql`SELECT COALESCE(alias_text, alias_norm) alias FROM page_aliases WHERE slug = ${slug}`,
    sql`SELECT id, kind, entity_slug, fact, source, confidence, trust_tier, created_at FROM facts
        WHERE entity_slug = ${slug} AND expired_at IS NULL ORDER BY created_at DESC`,
    sql`SELECT date, summary, detail, source FROM timeline_entries WHERE page_id = ${id} ORDER BY date DESC LIMIT ${timelineLimit}`,
    sql`SELECT f.slug from_slug, f.title from_title, f.type from_type, l.link_type, left(l.context, 200) context
        FROM links l JOIN pages f ON f.id = l.from_page_id
        WHERE l.to_page_id = ${id} AND f.deleted_at IS NULL ORDER BY (f.type = 'conversation'), f.title LIMIT 200`,
    sql`SELECT t.slug to_slug, t.title to_title, t.type to_type, l.link_type
        FROM links l JOIN pages t ON t.id = l.to_page_id WHERE l.from_page_id = ${id} AND t.deleted_at IS NULL`,
  ]);
  return {
    id, slug, type: p.type, title: p.title, compiled_truth: String(p.compiled_truth ?? ""),
    frontmatter: (p.frontmatter && typeof p.frontmatter === "object") ? p.frontmatter : {},
    effective_date: iso(p.effective_date), source_path: p.source_path ?? null, ingested_via: p.ingested_via ?? null,
    tags: tags.map((r: any) => r.tag),
    aliases: aliases.map((r: any) => r.alias).filter(Boolean),
    facts: facts.map(toFact),
    timeline: timeline.map((r: any) => ({ date: day(r.date), summary: r.summary, detail: r.detail ?? "", source: r.source ?? "" })),
    backlinks: backlinks.map((r: any) => ({ from_slug: r.from_slug, from_title: r.from_title, from_type: r.from_type, link_type: r.link_type, context: r.context ?? "" })),
    outlinks: outlinks.map((r: any) => ({ to_slug: r.to_slug, to_title: r.to_title, to_type: r.to_type, link_type: r.link_type })),
  };
}

/** Undirected 1–2 hop neighbourhood for the radial mini-graph. At most `max` nodes. */
export async function miniGraph(slug: string, depth = 2, includeConversations = false, max = 40) {
  const d = Math.max(1, Math.min(2, depth));
  const nodes = await sql`
    WITH RECURSIVE e AS (SELECT from_page_id a, to_page_id b FROM links UNION SELECT to_page_id, from_page_id FROM links),
    w(id, d) AS (SELECT id, 0 FROM pages WHERE slug = ${slug} AND deleted_at IS NULL
                 UNION SELECT e.b, w.d + 1 FROM w JOIN e ON e.a = w.id WHERE w.d < ${d})
    SELECT p.id, p.slug, p.title, p.type, min(w.d) d FROM w JOIN pages p ON p.id = w.id
    WHERE p.deleted_at IS NULL GROUP BY 1, 2, 3, 4 ORDER BY d, p.title`;
  const kept = nodes
    .filter((r: any) => Number(r.d) === 0 || includeConversations || r.type !== "conversation")
    .slice(0, max);
  if (!kept.length) return { nodes: [], edges: [] };
  const ids = kept.map((r: any) => r.id);
  const edges = await sql`
    SELECT DISTINCT f.slug a, t.slug b, l.link_type FROM links l
    JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
    WHERE l.from_page_id IN ${sql(ids)} AND l.to_page_id IN ${sql(ids)}`;
  return {
    nodes: kept.map((r: any) => ({ slug: r.slug, title: r.title, type: r.type, d: Number(r.d) })),
    edges: edges.map((r: any) => ({ from: r.a, to: r.b, link_type: r.link_type })),
  };
}

export async function facts(opts: { kind?: string | null; entity?: string | null; includeExpired?: boolean }): Promise<Fact[]> {
  const kind = opts.kind ?? null, entity = opts.entity ?? null, all = !!opts.includeExpired;
  const rows = await sql`
    SELECT id, kind, entity_slug, fact, source, confidence, trust_tier, created_at, valid_from, valid_until, expired_at FROM facts
    WHERE (${kind}::text IS NULL OR kind = ${kind}::text)
      AND (${entity}::text IS NULL OR entity_slug = ${entity}::text)
      AND (${all}::boolean OR expired_at IS NULL)
    ORDER BY created_at DESC LIMIT 500`;
  return rows.map(toFact);
}

/** Re-read after remember/forget: {id, fact, expired_at} or null. */
export async function factById(id: string): Promise<{ id: string; fact: string; expired_at: string | null } | null> {
  if (!/^\d{1,19}$/.test(id)) return null;
  const rows = await sql`SELECT id, fact, expired_at FROM facts WHERE id = ${id}::bigint`;
  return rows.length ? { id: String(rows[0].id), fact: rows[0].fact, expired_at: iso(rows[0].expired_at) } : null;
}

// ---------------------------------------------------------------------------
// Estado → Actividad (§6.7)

export async function factActivity(days = 7) {
  const created = await sql`
    SELECT id, kind, entity_slug, fact, created_at FROM facts
    WHERE created_at > now() - make_interval(days => ${days}) ORDER BY created_at DESC LIMIT 30`;
  const retired = await sql`
    SELECT id, kind, entity_slug, fact, expired_at FROM facts
    WHERE expired_at > now() - make_interval(days => ${days}) ORDER BY expired_at DESC LIMIT 30`;
  return {
    created: created.map((r: any) => ({ id: String(r.id), kind: r.kind, entity_slug: r.entity_slug, fact: r.fact, created_at: iso(r.created_at) })),
    retired: retired.map((r: any) => ({ id: String(r.id), kind: r.kind, entity_slug: r.entity_slug, fact: r.fact, expired_at: iso(r.expired_at) })),
  };
}

export async function requestLogSummary() {
  const rows = await sql`
    SELECT operation, status, count(*) n, max(created_at) last FROM mcp_request_log
    WHERE created_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY n DESC`;
  return rows.map((r: any) => ({ operation: r.operation, status: r.status, n: n(r.n), last: iso(r.last) }));
}

/** Count of embedded chunks (0 means keyword-only search). */
export async function embeddedChunkCount(): Promise<number> {
  const r = await sql`SELECT count(*) n FROM content_chunks WHERE embedding IS NOT NULL`;
  return n(r[0]?.n);
}

// ---------------------------------------------------------------------------
// check.ts: run every query once with sample arguments.

export async function runQueryChecks(): Promise<{ name: string; ok: boolean; ms: number; error?: string }[]> {
  const sample: [string, () => Promise<unknown>][] = [
    ["ping", ping],
    ["getKnownSlugs", getKnownSlugs],
    ["getIndex", getIndex],
    ["search", () => search("ejemplo")],
    ["pulseRow", pulseRow],
    ["sinceLastSeen", () => sinceLastSeen(new Date(Date.now() - 86400_000).toISOString())],
    ["inbox", () => inbox(1)],
    ["tasksPageText", () => tasksPageText("ops/tasks")],
    ["tasksStoredSlug", tasksStoredSlug],
    ["commitments", commitments],
    ["pendingHeadingPages", pendingHeadingPages],
    ["typeCounts", typeCounts],
    ["pageCards(person)", () => pageCards({ type: "person" })],
    ["pageCards(tag)", () => pageCards({ tag: "ejemplo" })],
    ["conversations", conversations],
    ["getPageBundle", () => getPageBundle("projects/proyecto-a", 1)],
    ["miniGraph", () => miniGraph("projects/proyecto-a", 2)],
    ["facts", () => facts({ includeExpired: true })],
    ["factById", () => factById("1")],
    ["factActivity", () => factActivity(7)],
    ["requestLogSummary", requestLogSummary],
    ["embeddedChunkCount", embeddedChunkCount],
  ];
  const out = [];
  for (const [name, fn] of sample) {
    const t = performance.now();
    try {
      await fn();
      out.push({ name, ok: true, ms: Math.round(performance.now() - t) });
    } catch (e: any) {
      out.push({ name, ok: false, ms: Math.round(performance.now() - t), error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return out;
}
