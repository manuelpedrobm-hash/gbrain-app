// Servidor de pruebas SOLO para el frontend: sirve public/ con las mismas cabeceras de
// seguridad que el panel real (CSP 'self', nosniff…) y respuestas inventadas para cada
// endpoint de la API (spec §5), más un chat simulado por SSE.
// No toca la base de datos, ni gbrain, ni claude. Todos los datos son ficticios.
//
//   bun run __REPO__/panel/test/mock-server.ts        (puerto 3141)
//   MOCK_PORT=3150 bun run …/test/mock-server.ts
//
// Modos (para ver los estados vacíos y de error): GET /__mock?mode=normal|empty|error|tgfail
// (tgfail: el registro de Telegram no se puede leer; el resto de Hoy debe cargar igual)

import { join, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { buildEstrategiaView } from "../lib/estrategia.ts";
import { renderMarkdown } from "../lib/render.ts";

const PORT = Number(process.env.MOCK_PORT || 3141);
const PUBLIC = normalize(join(import.meta.dir, "..", "public"));
let mode: "normal" | "empty" | "error" | "tgfail" = "normal";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SEC = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png",
};

/* ------------------------------------------------------------ fechas */
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 3600e3, D = 24 * H;
const day = (offset: number) => {
  const d = new Date(now + offset * D);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* -------------------------------------------------------------- datos */
const task = (id: string, text: string, section: string, extra: any = {}) => ({
  id, done: section === "Completed", text, tags: (text.match(/#[\p{L}\d_-]+/gu) || []).map((t) => t.slice(1)),
  section, overdue: false, steps: [], ...extra,
});

const tasksDoc = () => ({
  slug: "ops/tasks", exists: mode !== "empty", writable: true,
  sections: mode === "empty" ? [] : [
    { key: "P0", label_es: "Urgente", tasks: [task("t-20261024-01", "Enviar el presupuesto revisado a la fundación #grant", "P0", { due: day(-1), overdue: true })] },
    { key: "P1", label_es: "Hoy", tasks: [
      task("t-20261025-01", "Llamar a Ana para cerrar la fecha del ensayo #ensayo", "P1", { due: day(1) }),
      task("t-20261025-02", "Revisar las notas de [[projects/alfa]] y decidir siguiente paso", "P1", {
        steps: [{ done: true, text: "Leer el borrador" }, { done: false, text: "Escribir 3 dudas" }],
      }),
      task("t-20261025-03", "Contestar el correo del comité <script>alert(1)</script>", "P1"),
    ] },
    { key: "P2", label_es: "Esta semana", tasks: [task("t-20261023-02", "Preparar diapositivas para la reunión del jueves #equipo", "P2", { due: day(5) })] },
    { key: "P3", label_es: "Algún día", tasks: [] },
    { key: "Deferred", label_es: "Pospuestas", tasks: [task("t-20261020-01", "Renovar el dominio", "Deferred", { deferredUntil: day(10), reason: "espero factura" })] },
    { key: "Completed", label_es: "Hechas", tasks: [task("t-20261022-01", "Subir la copia de seguridad", "Completed", { completed: day(-2) })] },
  ],
  unparsed: mode === "empty" ? [] : [{ lineNo: 14, text: "- algo escrito a mano sin id" }],
});

const fact = (id: number, kind: string, text: string, entity: string | null, hoursAgo: number, extra: any = {}) => ({
  id, kind, entity_slug: entity, fact: text, source: "panel web, 2026-10-24 09:12, escrito por __NOMBRE__",
  confidence: 1, trust_tier: "user", created_at: iso(hoursAgo * H), ...extra,
});

const facts = () => mode === "empty" ? [] : [
  fact(12, "commitment", "Enviar la propuesta completa antes del día 17", "projects/alfa", 20, { valid_until: day(9) + "T23:59:00Z" }),
  fact(11, "preference", "Prefiere las reuniones por la mañana, hora de Madrid", "people/ana-garcia", 30),
  fact(10, "fact", "El texto <img src=x onerror=alert(1)> debe verse como texto", null, 50),
  fact(9, "event", "Vuelo a Madrid el día 28", null, 70),
  fact(8, "belief", "El piloto necesita al menos 12 semanas para ver efecto", "projects/beta", 90),
];

const deadlines = () => mode === "empty" ? [] : [
  { date: day(1), label: "Llamada con el equipo del ensayo", timeLabel: "10:00 CET", source: "estado", ref: "ESTADO.md", urgency: "red", past: false },
  { date: day(3), label: "Vuelo a Madrid", source: "estado", ref: "ESTADO.md", urgency: "amber", past: false },
  { date: day(5), label: "Preparar diapositivas para la reunión del jueves", source: "task", ref: "t-20261023-02", urgency: "amber", past: false },
  { date: day(9), label: "Cierra la convocatoria del acelerador", timeLabel: "15:00 EST", source: "estado", ref: "ESTADO.md", urgency: "normal", past: false },
  { date: day(9), label: "Enviar la propuesta completa", source: "commitment", ref: "12", urgency: "normal", past: false },
  { date: day(-2), label: "Entrega del informe intermedio", source: "estado", ref: "ESTADO.md", urgency: "red", past: true },
];

const msgs = () => mode === "empty" ? [] : [
  { messageId: 18, ts: iso(0.5 * H), kind: "text", text: "¿Me recuerdas qué quedamos con el comité?", status: "en_curso" },
  { messageId: 17, ts: iso(3 * H), kind: "voice", text: "(voice message)", transcript: "Apunta que mañana tengo que llamar a Ana por lo del ensayo, y que me mande el calendario.", status: "respondido", reply: { ts: iso(2.95 * H), text: "Apuntado. Mañana: llamar a Ana (ensayo) y pedirle el calendario." }, turnMs: 42000 },
  { messageId: 16, ts: iso(5 * H), kind: "text", text: "Busca lo último sobre el proyecto alfa", status: "respondido", reply: { ts: iso(4.9 * H), text: "En [[projects/alfa]] lo último es la reunión del 21: decidisteis revisar el presupuesto." }, turnMs: 18000 },
  { messageId: 15, ts: iso(26 * H), kind: "text", text: "Esto no tuvo respuesta <b>negrita falsa</b>", status: "sin_respuesta" },
  { messageId: 14, ts: iso(27 * H), kind: "voice", text: "(voice message)", status: "respondido", reply: { ts: iso(26.9 * H), text: "Hecho." }, turnMs: 9000 },
];

const index = () => ({
  fp: "mock",
  pages: [
    { s: "people/ana-garcia", t: "Ana García", y: "person", a: ["Ana"] },
    { s: "people/jose-perez", t: "José Pérez", y: "person", a: ["Pepe"] },
    { s: "people/maria-lopez", t: "María López", y: "person", a: [] },
    { s: "projects/alfa", t: "Proyecto Alfa", y: "project", a: ["alfa"] },
    { s: "projects/beta", t: "Piloto Beta", y: "project", a: [] },
    { s: "concepts/concepto-ejemplo", t: "Concepto de ejemplo", y: "concept", a: ["VB"] },
    { s: "sources/informes-claude/estado", t: "ESTADO", y: "source", a: [] },
    { s: "ops/tasks", t: "Tareas", y: "note", a: [] },
    { s: "conversations/claude-ai/2026/10/proximos-pasos", t: "Próximos pasos del piloto", y: "conversation", a: [] },
  ],
  tags: [{ tag: "grant", n: 5 }, { tag: "ensayo", n: 3 }, { tag: "equipo", n: 2 }],
});

const pageList = (type: string, tag: string) => {
  const counts = mode === "empty" ? { person: 0, project: 0 } : { person: 26, project: 18, source: 21, concept: 2, note: 1, conversation: 229 };
  if (mode === "empty") return { counts, pages: [] };
  if (type === "conversation") return { counts, pages: [
    { slug: "conversations/claude-ai/2026/10/proximos-pasos", title: "Próximos pasos del piloto", date: day(-3), messages: "42" },
    { slug: "conversations/claude-ai/2026/10/organizar-tareas", title: "Organizar las tareas de la semana", date: day(-6), messages: "17" },
    { slug: "conversations/claude-ai/2026/09/presupuesto", title: "Presupuesto **v2**", date: "2026-09-12", messages: "8" },
  ] };
  const people = [
    { slug: "people/ana-garcia", type: "person", title: "Ana García", inbound: 14, facts: 2, tags: ["ensayo", "madrid"], lastTouch: iso(2 * D), cold: false },
    { slug: "people/jose-perez", type: "person", title: "José Pérez", inbound: 6, facts: 0, tags: [], lastTouch: iso(80 * D), cold: true },
    { slug: "people/maria-lopez", type: "person", title: "María López con un nombre bastante largo para ver el recorte", inbound: 1, facts: 1, tags: ["a", "b", "c", "d", "e"], lastTouch: null, cold: true },
  ];
  const projects = [
    { slug: "projects/alfa", type: "project", title: "Proyecto Alfa", inbound: 21, facts: 3, tags: ["grant"], lastTouch: iso(1 * D), cold: false },
    { slug: "projects/beta", type: "project", title: "Piloto Beta", inbound: 4, facts: 1, tags: [], lastTouch: iso(50 * D), cold: true },
  ];
  const sources = [
    { slug: "sources/informes-claude/estado", type: "source", title: "ESTADO", inbound: 3, facts: 0, tags: ["informes"], lastTouch: iso(4 * D), cold: false },
    { slug: "sources/informes-claude/proximos-pasos-v2", type: "source", title: "Próximos pasos v2", inbound: 0, facts: 0, tags: [], lastTouch: iso(60 * D), cold: true },
  ];
  let pages: any[] = type === "project" ? projects : type === "source" ? sources : type === "person" ? people : [...people, ...projects, ...sources];
  if (tag) pages = pages.filter((p) => p.tags.includes(tag));
  return { counts, pages };
};

const PAGE_HTML = `<h2>Resumen</h2>
<p>Proyecto para probar un piloto con <a href="#/p/people/ana-garcia">Ana García</a> y <a href="#/p/people/nadie" class="missing">Alguien que no existe</a>.</p>
<p>Texto que intentó colarse: &lt;script&gt;alert(1)&lt;/script&gt; (el servidor lo escapa).</p>
<h2>Pendientes antes del envío</h2>
<ul><li>Confirmar los dos co-investigadores</li><li>Reenviar la muestra que no llegó</li></ul>
<h3>Tabla</h3>
<table><thead><tr><th>fecha</th><th>qué</th></tr></thead><tbody><tr><td>28 oct</td><td>Vuelo con una descripción larguísima que debería envolver o desplazarse dentro de la tabla sin romper el ancho de la página en el móvil</td></tr></tbody></table>
<pre><code>gbrain call get_page '{"slug":"projects/alfa"}'</code></pre>
<blockquote>Una cita para ver el estilo.</blockquote>
<p>Enlace externo: <a href="https://example.com" target="_blank" rel="noopener noreferrer">example.com</a></p>`;

const page = (slug: string) => {
  if (slug === "people/nadie") return null;
  const isProj = slug.startsWith("projects/");
  return {
    slug, type: isProj ? "project" : slug.startsWith("people/") ? "person" : "note",
    title: isProj ? "Proyecto Alfa" : slug.split("/").pop(), aliases: isProj ? ["alfa"] : [], tags: ["grant", "piloto"],
    chips: [{ k: "status", v: "activo" }, { k: "updated", v: "2026-09-23" }, { k: "description", v: "no debe salir" }],
    html: PAGE_HTML, lastTouch: iso(1 * D), cold: false, ingested_via: "import",
    facts: facts().filter((f) => f.entity_slug === slug || slug === "projects/alfa").slice(0, 3),
    timeline: Array.from({ length: 8 }, (_, i) => ({ date: day(-10 - i * 9), summary: `Reunión número ${8 - i} sobre [[projects/alfa]]`, detail: i === 0 ? "Detalle **largo** de la reunión con muchas cosas que contar para ver cómo se recorta en tres líneas como máximo dentro del carril derecho de la página, sin romper nada." : "", source: "informes" })),
    backlinks: [
      { from_slug: "people/ana-garcia", from_title: "Ana García", from_type: "person", link_type: "mentions", context: "Ana coordina el piloto de [[projects/alfa]] desde Madrid…" },
      { from_slug: "conversations/claude-ai/2026/10/proximos-pasos", from_title: "Próximos pasos del piloto", from_type: "conversation", link_type: "mentions", context: "…hablamos de alfa…" },
    ],
    outlinks: [{ to_slug: "people/ana-garcia", to_title: "Ana García", to_type: "person", link_type: "mentions" }, { to_slug: "concepts/concepto-ejemplo", to_title: "Concepto de ejemplo", to_type: "concept" }],
    graph: {
      nodes: [
        { slug, title: "Proyecto Alfa", type: "project", d: 0 },
        { slug: "people/ana-garcia", title: "Ana García", type: "person", d: 1 },
        { slug: "concepts/concepto-ejemplo", title: "Concepto de ejemplo", type: "concept", d: 1 },
        { slug: "conversations/claude-ai/2026/10/proximos-pasos", title: "Próximos pasos del piloto", type: "conversation", d: 1 },
        { slug: "sources/informes-claude/estado", title: "ESTADO", type: "source", d: 1 },
        { slug: "people/jose-perez", title: "José Pérez", type: "person", d: 2 },
        { slug: "projects/beta", title: "Piloto Beta", type: "project", d: 2 },
        { slug: "people/maria-lopez", title: "María López", type: "person", d: 2 },
      ],
      edges: [
        { from: slug, to: "people/ana-garcia" }, { from: slug, to: "concepts/concepto-ejemplo" },
        { from: "conversations/claude-ai/2026/10/proximos-pasos", to: slug }, { from: "sources/informes-claude/estado", to: slug },
        { from: "people/ana-garcia", to: "people/jose-perez" }, { from: "concepts/concepto-ejemplo", to: "projects/beta" },
        { from: "people/ana-garcia", to: "people/maria-lopez" },
      ],
    },
  };
};

const chats = new Map<string, any>([["c-1", {
  id: "c-1", title: "¿Qué sé de Ana García?", sessionId: "s-1", createdAt: iso(2 * D), updatedAt: iso(2 * D), costUsd: 0.04,
  turns: [
    { role: "user", text: "¿Qué sé de Ana García?", ts: iso(2 * D) },
    { role: "assistant", text: "Ana coordina el piloto…", html: "<p>Ana coordina el piloto de <a href=\"#/p/projects/alfa\">Proyecto Alfa</a> (<a href=\"#/p/people/ana-garcia\">people/ana-garcia</a>). Prefiere reuniones por la mañana (hecho #11).</p>", tools: [{ name: "search", label_es: "buscó «Ana García»", write: false, ok: true }, { name: "get_page", label_es: "leyó people/ana-garcia", write: false, ok: true }], costUsd: 0.04, durationMs: 8200, denials: [], ts: iso(2 * D) },
  ],
}]]);
const runs = new Map<string, Run>();
let spend = 0.32;

/* ---------------------------------------------------------- respuestas */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SEC },
});
const err = (status: number, code: string, message_es: string) => json({ error: { code, message_es } }, status);

function get(path: string, q: URLSearchParams): Response | null {
  if (mode === "error" && path !== "/api/pulse" && path !== "/api/health") return err(502, "gbrain", "GBrain no respondió bien (modo error del mock).");
  switch (path) {
    case "/api/pulse": return json({ fp: "fp-" + Math.floor(Date.now() / 60000), ts: new Date().toISOString() });
    case "/api/health": return json({
      checks: [
        { id: "cerebro", status: "ok", label_es: "cerebro", detail_es: "v0.60.368.0, sin reinicio pendiente" },
        { id: "postgres", status: "ok", label_es: "postgres", detail_es: "responde" },
        { id: "telegram", status: "ok", label_es: "telegram", detail_es: "en marcha; último mensaje hace 30 min" },
        { id: "copia", status: "warn", label_es: "copia", detail_es: "última copia hace 40 h" },
        { id: "sync", status: "error", label_es: "sync", detail_es: "env: bun: No such file or directory" },
      ],
      telegramCostToday: { usd: 1.23, requests: 31 }, panelChatToday: { usd: spend, capUsd: 5 }, at: new Date().toISOString(),
    });
    case "/api/estado": return json({
      issues: mode === "empty" ? [] : [
        { id: "sync", severity: "error", title_es: "La sincronización nocturna falla", detail_es: "El registro diario dice «env: bun: No such file or directory»: la base no se actualiza desde git cada noche.", fix_es: "Añade /opt/homebrew/bin al PATH en __REPO__/ops/gbrain-daily.sh." },
        { id: "remote", severity: "warn", title_es: "No hay copia fuera de este Mac", detail_es: "El repositorio del cerebro no tiene remoto.", fix_es: "Crea un repositorio privado y añádelo como remoto." },
        { id: "embed", severity: "info", title_es: "Embeddings desactivados", detail_es: "La búsqueda solo encuentra palabras exactas.", fix_es: "Decide si quieres una clave de embeddings." },
      ],
      identity: { version: "0.60.368.0", updateAvailable: "0.60.461.0" },
      activity: { audit: [{ ts: iso(H), tool: "remember", target: "people/ana-garcia", ok: true, requestId: "r1" }, { ts: iso(2 * H), tool: "edit_page", target: "ops/tasks", ok: false, requestId: "r2", error: "revision_conflict" }], facts: facts().slice(0, 2), git: ["ba48da2|2026-10-25T08:27:00-07:00|ingest", "52e4750|2026-10-22T10:00:00-07:00|scaffold"], mcp: [{ operation: "recall", status: "ok", count: 6, max: iso(H) }] },
    });
    case "/api/index": return json(index());
    case "/api/search": {
      const term = q.get("q") || "";
      return json({
        pages: [
          { slug: "concepts/concepto-ejemplo", type: "concept", title: "Concepto de ejemplo", snip: `La \u0001${term}\u0002 es frecuente; <script>no</script> aparece como texto`, r: 0.9 },
          { slug: "projects/alfa", type: "project", title: "Proyecto Alfa", snip: `piloto sobre \u0001${term}\u0002 en Madrid`, r: 0.5 },
        ],
        facts: [fact(8, "belief", `Sobre ${term}: el piloto necesita 12 semanas`, "projects/beta", 90)],
      });
    }
    case "/api/hoy": return json({
      deadlines: deadlines().filter((d) => !d.past || d.source !== "estado"),
      overdue: mode === "empty" ? [] : [task("t-20261024-01", "Enviar el presupuesto revisado a la fundación #grant", "P0", { due: day(-1), overdue: true })],
      todayTasks: mode === "empty" ? [] : tasksDoc().sections.find((s) => s.key === "P1")!.tasks,
      openTasks: mode === "empty" ? 0 : 5,
      telegram: mode === "tgfail" ? { ok: false, messages: [], error_es: "No pude leer el registro de Telegram" } : { ok: true, messages: msgs().slice(0, 5) },
      since: { lastSeen: iso(20 * H), facts: facts().slice(0, 2), retired: mode === "empty" ? [] : [{ id: 7, fact: "Hecho viejo que se corrigió", expired_at: iso(5 * H) }], pages: mode === "empty" ? [] : [{ slug: "projects/alfa", type: "project", title: "Proyecto Alfa", updated_at: iso(6 * H), ingested_via: "mcp" }] },
      inbox: mode === "empty" ? [] : [{ slug: "inbox/2026-10-25-idea", title: "Idea para el piloto", created_at: iso(2 * H) }, { slug: "inbox/2026-10-24-recado", title: "Comprar **cartuchos**", created_at: iso(30 * H) }],
      tasksExists: mode !== "empty",
      estado: { ok: true, slug: "sources/informes-claude/estado", mtime: iso(4 * D), ageDays: 4, stale: true },
    });
    case "/api/asistente": return json({
      dominios: { ok: true, permitidos: ["localhost", "127.0.0.1", "financiador.example", "otro-financiador.example"], bloqueados: ["paypal", "gmail"] },
      run: mode === "empty" ? null : { id: "mock-1", fase: 1, estado: "propuesta", tarea: "Rellena la solicitud de prueba", creada: iso(0), actualizada: iso(0), expira: iso(-14 * 60_000), pasos: [{ ts: iso(0), texto: "Abriendo 127.0.0.1:8765", fase: 1 }], aprobada: false, clic: false, fuente: "prueba (mock)", hash: "a".repeat(64), hashCorto: "aaaaaaaa", ocupado: false,
        propuesta: { url: "http://127.0.0.1:8765/form.html", formulario: "Formulario de prueba", campos: [{ etiqueta: "Nombre", valor: "<b>Ana</b> Ficticia", fuente: "DATOS" }, { etiqueta: "Correo", valor: "ana@example.test", fuente: "DATOS" }], faltan: [], aviso: ["Texto de la web: <script>alert(1)</script>"], boton_envio: "Enviar", detenido: false } },
      history: [], fuente: "prueba (mock)", limites: { fase1Seg: 300, fase2Seg: 120, caducaMin: 15 }, ocupado: false,
    });
    case "/api/estrategia": return json(buildEstrategiaView(
      mode === "empty" ? null : readFileSync(join(import.meta.dir, "fixtures", "estrategia.md"), "utf8"),
      (md) => renderMarkdown(md, new Set(["ops/frentes"])),
    ));
    case "/api/pendientes": return json({
      tasks: tasksDoc(), commitments: facts().filter((f) => f.kind === "commitment"), deadlines: deadlines(),
      sections: mode === "empty" ? [] : [
        { slug: "projects/alfa", title: "Proyecto Alfa", heading: "## Pendientes antes del envío", items: ["- Confirmar que los dos co-investigadores aceptan", "- Reenviar la **muestra** que no llegó", "- Terminar el presupuesto y [[people/ana-garcia|Ana]] revisa"] },
        { slug: "projects/beta", title: "Piloto Beta", heading: "### Preguntas abiertas", items: ["1. ¿Cepa única o consorcio?"] },
      ],
      mapa: { mode: "link", url: "https://claude.ai/artifact/EXAMPLE" },
      estado: { ok: true, slug: "sources/informes-claude/estado", mtime: iso(4 * D), ageDays: 4, stale: true },
    });
    case "/api/tasks": return json(tasksDoc());
    case "/api/mensajes": {
      const before = q.get("before");
      const list = before ? [] : msgs();
      if (mode === "tgfail") return json({ ok: false, messages: [], costByDay: [], error_es: "No pude leer el registro de Telegram" });
      return json({ ok: true, messages: list, costByDay: mode === "empty" ? [] : [{ day: day(0), usd: 1.23, requests: 31 }, { day: day(-1), usd: 1.71, requests: 49 }, { day: day(-2), usd: 0.4, requests: 9 }] });
    }
    case "/api/pages": return json(pageList(q.get("type") || "", q.get("tag") || ""));
    case "/api/page": { const p = page(q.get("slug") || ""); return p ? json(p) : err(404, "not_found", "No existe esa página."); }
    case "/api/facts": {
      let list = facts();
      if (q.get("kind")) list = list.filter((f) => f.kind === q.get("kind"));
      if (q.get("entity")) list = list.filter((f) => f.entity_slug === q.get("entity"));
      if (q.get("expired") === "1") list = [...list, { ...fact(7, "fact", "Hecho viejo que se corrigió", null, 100), expired_at: iso(5 * H) }];
      return json({ facts: list });
    }
    case "/api/chats": return json({ chats: [...chats.values()].map(({ turns, sessionId, ...c }) => c).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  }
  if (path.startsWith("/api/chats/")) {
    const c = chats.get(decodeURIComponent(path.slice("/api/chats/".length)));
    return c ? json(c) : err(404, "not_found", "No existe esa conversación.");
  }
  return null;
}

async function postRoute(req: Request, path: string): Promise<Response> {
  // Las mismas comprobaciones CSRF que el panel real (sin cookie).
  if (req.headers.get("x-panel") !== "1") return err(403, "csrf", "Falta X-Panel.");
  if (!(req.headers.get("content-type") || "").startsWith("application/json")) return err(403, "csrf", "Content-Type no es JSON.");
  const origin = req.headers.get("origin");
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return err(403, "csrf", "Origin no permitido.");
  const body: any = await req.json().catch(() => ({}));
  await Bun.sleep(250);
  if (path === "/api/capture") return json({ ok: true, slug: "inbox/2026-10-25-nota" });
  if (path === "/api/hoy/seen") return json({ lastSeen: new Date().toISOString() });
  if (path === "/api/tasks/init") return json({ ok: true, slug: "ops/tasks", fileWritten: true });
  if (path === "/api/tasks") return json({ ok: true, task: task("t-20261025-04", body.text, body.priority) });
  if (/^\/api\/tasks\/t-\d{8}-\d{2,3}\/(done|reopen|move|defer|edit)$/.test(path)) {
    if (body?.text === "conflicto") return err(409, "conflict", "Otra sesión cambió las tareas; recarga");
    return json({ ok: true, task: {} });
  }
  if (path === "/api/facts") return json({ ok: true, id: 13, status: "created", verified: true });
  if (/^\/api\/facts\/\d+\/forget$/.test(path)) return json({ ok: true });
  if (/^\/api\/facts\/\d+\/correct$/.test(path)) return json({ ok: true, newId: 14, oldExpired: true });
  if (path === "/api/estado/doctor") { await Bun.sleep(1200); return json({ health_score: 85, status: "warnings", top_issues: ["Sin embeddings: la búsqueda solo encuentra palabras exactas"], warn_checks: [{ name: "backup_coverage", message: "no hay remoto git" }, { name: "extract_atoms_backlog", message: "232 páginas" }] }); }
  if (path === "/api/logout") return json({ ok: true });
  if (path === "/api/chat") {
    if (spend >= 5) return err(429, "daily_cap", "Has llegado al tope diario del chat.");
    if (body.model === "opus" && !body.confirmOpus) return err(412, "confirm_opus", "Opus necesita confirmación.");
    if ([...runs.values()].some((r) => !r.finished)) return err(409, "busy", "Ya hay una respuesta en curso.");
    let convId = body.conversationId;
    if (!convId || !chats.has(convId)) {
      convId = "c-" + crypto.randomUUID().slice(0, 8);
      chats.set(convId, { id: convId, title: String(body.text).slice(0, 60), sessionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), costUsd: 0, turns: [] });
    }
    chats.get(convId).turns.push({ role: "user", text: body.text, ts: new Date().toISOString() });
    const runId = crypto.randomUUID();
    const run: Run = { convId, text: body.text, stopped: false, finished: false, buffer: [], listeners: new Set() };
    runs.set(runId, run);
    simulate(run);
    return json({ runId, conversationId: convId }, 202);
  }
  if (path === "/api/chat/stop") { const r = runs.get(body.runId); if (r) r.stopped = true; return json({ ok: true }); }
  return err(404, "not_found", "Ruta desconocida en el mock.");
}

/* Chat simulado, como el servidor real: la ejecución sigue aunque se cierre la conexión,
   guarda sus eventos numerados en un búfer y cada conexión SSE repite los que faltan
   (Last-Event-ID) y luego recibe los nuevos. */
type Ev = { id: number; name: string; data: any };
type Run = { convId: string; text: string; stopped: boolean; finished: boolean; buffer: Ev[]; listeners: Set<(e: Ev | null) => void> };

function simulate(run: Run) {
  const answer = run.text.includes("error")
    ? null
    : `Según [[projects/alfa]], lo más urgente es el presupuesto. Ojo: <script>alert("x")</script> se ve como texto.\n\nTambién tienes la llamada con Ana mañana.`;
  const plan: [string, any][] = [
    ["status", { model: "claude-sonnet-5-5", cerebro: "connected", tools: 22, unlisted: [] }],
    ["tool", { id: "tu1", name: "search", label_es: "buscó «presupuesto»", write: false }],
    ["tool_result", { id: "tu1", ok: true, preview: "[{\"slug\":\"projects/alfa\",\"title\":\"Proyecto Alfa\"}]" }],
    // El chat ya no escribe: remember llega como propuesta (lib/chat.ts, auditoría 2026-10-26).
    ["tool", { id: "tu2", name: "remember", label_es: "propone guardar un hecho", write: true }],
    ["tool_result", { id: "tu2", ok: true, proposed: true, preview: "Propuesta: no se ha guardado nada. Confírmala abajo si quieres." }],
  ];
  const proposals = [{ tool: "remember", fact: "El presupuesto de Proyecto Alfa es lo más urgente", entity: "projects/alfa", kind: "fact", provenance: "panel web, chat, simulado" }];
  if (answer) for (const w of answer.match(/\S+\s*/g) || []) plan.push(["text", { d: w }]);
  const html = `<p>Según <a href="#/p/projects/alfa">Proyecto Alfa</a>, lo más urgente es el presupuesto. Ojo: &lt;script&gt;alert("x")&lt;/script&gt; se ve como texto.</p><p>También tienes la llamada con Ana mañana.</p>`;
  const denied = run.text.includes("borra");
  if (answer) plan.push(["done", { costUsd: 0.0312, durationMs: 6400, sessionId: "s-x", subtype: "success", denials: denied ? ["delete_page"] : [], proposals, html,
    ...(denied ? { notice_es: "Esto no lo puede hacer el panel: hazlo desde Claude Code o Telegram" } : {}) }]);
  else plan.push(["error", { message_es: "La ejecución terminó con un error (simulado)." }]);

  const emit = (name: string, data: any) => {
    const ev = { id: run.buffer.length, name, data };
    run.buffer.push(ev);
    for (const l of run.listeners) l(ev);
  };
  (async () => {
    for (const [name, data] of plan) {
      await Bun.sleep(name === "text" ? 80 : 500);
      if (run.stopped) { emit("error", { message_es: "Parado.", code: "stopped", costUsd: 0.01, costEstimated: true }); break; }
      emit(name, data);
    }
    const c = chats.get(run.convId);
    if (c && answer && !run.stopped) {
      c.turns.push({ role: "assistant", text: answer, html, tools: [{ name: "search", label_es: "buscó «presupuesto»", write: false, ok: true }, { name: "remember", label_es: "propone guardar un hecho", write: true, ok: true, proposed: true }], costUsd: 0.0312, durationMs: 6400, denials: denied ? ["delete_page"] : [], proposals, ...(denied ? { notice_es: "Esto no lo puede hacer el panel: hazlo desde Claude Code o Telegram" } : {}), ts: new Date().toISOString() });
      c.updatedAt = new Date().toISOString();
      c.costUsd += 0.0312;
      spend += 0.0312;
    }
    run.finished = true;
    run.stopped = true;
    for (const l of run.listeners) l(null);
  })();
}

function chatStream(req: Request, server: any): Response {
  server.timeout(req, 0);
  const url = new URL(req.url);
  const run = runs.get(url.searchParams.get("run") || "");
  if (!run) return err(404, "no_run", "Esa ejecución ya no existe.");
  const lastId = Number(req.headers.get("last-event-id") ?? -1);
  const enc = new TextEncoder();
  let listener: ((e: Ev | null) => void) | null = null;
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (e: Ev) => { try { ctrl.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.name}\ndata: ${JSON.stringify(e.data)}\n\n`)); } catch { /* conexión cerrada */ } };
      const end = () => { try { ctrl.close(); } catch { /* ya cerrada */ } if (listener) run.listeners.delete(listener); };
      ctrl.enqueue(enc.encode(": hola\n\n"));
      for (const e of run.buffer) if (e.id > lastId) send(e);
      if (run.finished) return end();
      listener = (e) => (e ? send(e) : end());
      run.listeners.add(listener);
    },
    cancel() { if (listener) run.listeners.delete(listener); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", ...SEC } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/__mock") {
      const m = url.searchParams.get("mode");
      if (m === "normal" || m === "empty" || m === "error" || m === "tgfail") mode = m;
      if (url.searchParams.has("spend")) spend = Number(url.searchParams.get("spend"));
      return json({ mode, spend });
    }
    if (path === "/api/chat/stream") return chatStream(req, srv);
    if (path.startsWith("/api/")) {
      if (req.method === "POST") return postRoute(req, path);
      return get(path, url.searchParams) ?? err(404, "not_found", "Ruta desconocida en el mock.");
    }
    // Ficheros estáticos de public/ (sin salir de la carpeta).
    const rel = path === "/" ? "/index.html" : path;
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + "/")) return new Response("No", { status: 403 });
    const f = Bun.file(file);
    if (!(await f.exists())) return new Response("No encontrado", { status: 404, headers: SEC });
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(f, { headers: { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-cache", ...SEC } });
  },
});

console.log(`mock del panel en http://127.0.0.1:${server.port}  (modo: ${mode})`);
