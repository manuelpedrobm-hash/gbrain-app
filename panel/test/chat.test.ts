// Chat backend (spec §6.6) without calling a model: request validation that
// returns before any spawn, the stream-json → SSE mapping on a synthetic
// stream, and the per-turn cost rule.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing as ajustesTesting } from "../lib/ajustes.ts";
import {
  __testing, ALLOW, chatStream, DENY, getChat, listChats, panelSpendToday, perTurnCost, PROPOSE, settleTurnCost, splitDenials,
  startChat, stopChat, toolLabel,
} from "../lib/chat.ts";

const STATE = mkdtempSync(join(tmpdir(), "chat-test-"));
beforeAll(() => { __testing.setStateDir(STATE); ajustesTesting.setFiles(STATE); });   // ajustes de la carpeta temporal, no los reales
afterAll(() => rmSync(STATE, { recursive: true, force: true }));

const line = (o: object) => JSON.stringify(o);
const P = "mcp__cerebro__";

// The 35 tools of `gbrain serve --surface starter`, from MCP tools/list on 2026-10-26.
const STARTER = [
  "remember", "entity", "synthesize", "forget", "get_page", "put_page", "list_pages", "capture", "edit_page",
  "get_write_request", "list_write_requests", "cancel_write_request", "search", "query", "get_backlinks",
  "list_link_sources", "traverse_graph", "add_timeline_entry", "list_skills", "get_skill", "list_brain_skillpack",
  "get_skill_asset", "resolve_slugs", "get_ingest_log", "cancel_job", "submit_agent", "get_agent_job", "whoami",
  "request_tools", "get_recent_salience", "find_anomalies", "recall", "context_pack", "delta", "mute_notice",
];

describe("tool lists", () => {
  test("allow, propose and deny are disjoint and all cerebro- or correo-prefixed", () => {
    for (const t of [...ALLOW, ...PROPOSE, ...DENY]) expect(t.startsWith(P) || t.startsWith("mcp__correo__")).toBe(true);
    for (const t of DENY) expect(t.startsWith(P)).toBe(true);
    expect(ALLOW.filter((t) => DENY.includes(t) || PROPOSE.includes(t))).toEqual([]);
    expect(PROPOSE.filter((t) => DENY.includes(t))).toEqual([]);
    for (const t of ["put_page", "delete_page", "forget", "submit_agent", "request_tools", "synthesize"]) expect(DENY).toContain(P + t);
  });

  test("the chat can write nothing on its own: no write tool is allowed (audit 2026-10-26)", () => {
    for (const t of ["edit_page", "add_timeline_entry", "remember", "capture", "mute_notice", "put_page"]) expect(ALLOW).not.toContain(P + t);
    for (const t of ["edit_page", "add_timeline_entry", "mute_notice"]) expect(DENY).toContain(P + t);
    expect(PROPOSE).toEqual([P + "remember", P + "capture", "mcp__correo__enviar_correo"]);
    expect(ALLOW.filter((t) => t.startsWith("mcp__correo__"))).toEqual(["mcp__correo__buscar_correo", "mcp__correo__leer_correo", "mcp__correo__agenda"]);
  });

  test("every starter-surface tool is in exactly one list", () => {
    const unplaced = STARTER.filter((t) => ![...ALLOW, ...PROPOSE, ...DENY].includes(P + t));
    expect(unplaced).toEqual([]);
  });

  test("lib/ never builds SQL from strings (no sql.unsafe)", () => {
    const { readdirSync, readFileSync } = require("node:fs");
    const dir = join(import.meta.dir, "..", "lib");
    const hits = readdirSync(dir).filter((f: string) => f.endsWith(".ts") && /\.unsafe\s*\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("startChat validation (never reaches the spawn)", () => {
  test("400 for empty or too long text, bad model, bad conversation id", async () => {
    expect((await startChat({ text: "  " })).status).toBe(400);
    expect((await startChat({ text: "x".repeat(4001) })).status).toBe(400);
    expect((await startChat({ text: "hola", model: "gpt" })).status).toBe(400);
    expect((await startChat({ text: "hola", conversationId: "../../etc" })).status).toBe(400);
    expect((await startChat({})).status).toBe(400);
  });

  test("404 for an unknown conversation", async () => {
    expect((await startChat({ text: "hola", conversationId: crypto.randomUUID() })).status).toBe(404);
  });

  test("412 for Opus without confirmation", async () => {
    const r = await startChat({ text: "hola", model: "opus" });
    expect(r.status).toBe(412);
    expect((r.body as any).error.code).toBe("confirm_opus");
  });

  test("429 at the daily cap", async () => {
    writeFileSync(join(STATE, "spend.jsonl"),
      line({ ts: new Date().toISOString(), conversationId: "x", runId: "y", model: "sonnet", costUsd: 3 }) + "\n" +
      line({ ts: "2020-01-01T00:00:00Z", conversationId: "x", runId: "z", model: "sonnet", costUsd: 99 }) + "\n" +
      line({ ts: new Date().toISOString(), conversationId: "x", runId: "w", model: "sonnet", costUsd: 2 }) + "\n");
    expect(panelSpendToday()).toEqual({ usd: 5, capUsd: 5 });
    const r = await startChat({ text: "hola" });
    expect(r.status).toBe(429);
    expect((r.body as any).error.code).toBe("daily_cap");
    rmSync(join(STATE, "spend.jsonl"));
    expect(panelSpendToday().usd).toBe(0);
  });

  test("stop, list and get behave with nothing running", () => {
    expect(stopChat({ runId: crypto.randomUUID() }).status).toBe(404);
    expect(stopChat({}).status).toBe(400);
    expect(listChats()).toEqual({ chats: [] });
    expect(getChat("nope")).toBeNull();
    expect(__testing.activeRunId()).toBeNull();
  });
});

describe("stream-json → SSE", () => {
  const init = (servers: object[], tools: string[]) =>
    line({ type: "system", subtype: "init", session_id: "s-1", model: "claude-sonnet-5-5", mcp_servers: servers, tools });

  test("maps init, text, tools, results and done", async () => {
    const { events, initError } = await __testing.simulate([
      init([{ name: "cerebro", status: "connected" }], [P + "search", P + "get_page"]),
      line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Mira " } } }),
      line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } } }),
      line({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Mira " }, { type: "tool_use", id: "t1", name: P + "search", input: { query: "ejemplo" } }], usage: { input_tokens: 10, output_tokens: 20 } } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x".repeat(900) }] }] } }),
      line({ type: "assistant", message: { id: "m2", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "t2", name: P + "delete_page", input: { slug: "projects/proyecto-a" } }], usage: { input_tokens: 10, output_tokens: 5 } } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "Permission denied" }] } }),
      line({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, error: "rate_limit", error_status: 429 }),
      line({ type: "assistant", message: { id: "m3", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Ver [[projects/proyecto-a]]. <script>alert(1)</script>" }], usage: { input_tokens: 10, output_tokens: 30 } } }),
      line({ type: "result", subtype: "success", total_cost_usd: 0.0123, duration_ms: 1500, session_id: "s-1", permission_denials: [{ tool_name: P + "delete_page", tool_use_id: "t2", tool_input: {} }] }),
    ]);
    expect(initError).toBeNull();
    const kinds = events.map((e) => e.event);
    expect(kinds).toEqual(["status", "text", "tool", "tool_result", "tool", "tool_result", "retry", "done"]);
    expect(events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events[0].data).toEqual({ model: "claude-sonnet-5-5", cerebro: "connected", correo: "ausente", tools: 2, unlisted: [] });
    expect(events[1].data).toEqual({ d: "Mira " });
    expect(events[2].data).toEqual({ id: "t1", name: "search", label_es: "buscó «ejemplo»", write: false });
    expect(events[3].data.ok).toBe(true);
    expect(events[3].data.preview.length).toBe(600);
    expect(events[4].data).toMatchObject({ name: "delete_page", write: true });
    expect(events[5].data.ok).toBe(false);
    expect(events[6].data.reason).toBe("rate_limit");
    const done = events[7].data;
    expect(done).toMatchObject({ costUsd: 0.0123, durationMs: 1500, sessionId: "s-1", subtype: "success", denials: ["delete_page"] });
    expect(done.notice_es).toContain("Esto no lo puede hacer el panel");
    expect(done.html).toContain('href="#/p/projects/proyecto-a"');
    expect(done.html).not.toContain("<script>");
    expect(done.proposals).toEqual([]);
  });

  test("a refused remember/capture becomes a proposal, not a denial; nothing is written", async () => {
    const lines = [
      init([{ name: "cerebro", status: "connected" }], [P + "search", P + "remember", P + "capture", P + "mute_notice"]),
      line({ type: "assistant", message: { id: "m1", model: "claude-haiku-5-5", content: [
        { type: "tool_use", id: "r1", name: P + "remember", input: { fact: "Ana prefiere\u0007 las mañanas", entity: "people/ana", kind: "preference" } },
        { type: "tool_use", id: "c1", name: P + "capture", input: { content: "Llamar a Ana" } },
        { type: "tool_use", id: "m9", name: P + "mute_notice", input: { code: "x" } },
      ], usage: { input_tokens: 10, output_tokens: 20 } } }),
      line({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "r1", is_error: true, content: "Claude requested permissions to use mcp__cerebro__remember, but you haven't granted it yet." },
        { type: "tool_result", tool_use_id: "c1", is_error: true, content: "permission denied" },
        { type: "tool_result", tool_use_id: "m9", is_error: true, content: "permission denied" },
      ] } }),
      line({ type: "result", subtype: "success", total_cost_usd: 0.002, duration_ms: 900, session_id: "s-2", permission_denials: [
        { tool_name: P + "remember", tool_use_id: "r1", tool_input: { fact: "Ana prefiere\u0007 las mañanas", entity: "people/ana", kind: "preference" } },
        { tool_name: P + "capture", tool_use_id: "c1", tool_input: { content: "Llamar a Ana" } },
        { tool_name: P + "mute_notice", tool_use_id: "m9", tool_input: { code: "x" } },
      ] }),
    ];
    const { events } = await __testing.simulate(lines);
    expect(events[0].data.unlisted).toEqual(["mute_notice"]);
    const tools = events.filter((e) => e.event === "tool").map((e) => e.data);
    expect(tools.map((t) => t.label_es)).toEqual(["propone guardar un hecho", "propone apuntar una nota", "intentó usar mute_notice"]);
    const results = events.filter((e) => e.event === "tool_result").map((e) => e.data);
    expect(results.map((r) => [r.ok, !!r.proposed])).toEqual([[true, true], [true, true], [false, false]]);
    const done = events.at(-1)!.data;
    expect(done.denials).toEqual(["mute_notice"]);              // the denial chip is only for real refusals
    expect(done.notice_es).toContain("Esto no lo puede hacer el panel");
    expect(done.proposals).toEqual([
      { tool: "remember", fact: "Ana prefiere las mañanas", entity: "people/ana", kind: "preference", provenance: expect.stringContaining("panel web, chat") },
      { tool: "capture", text: "Llamar a Ana" },
    ]);
  });

  test("proposals only: no denial notice", async () => {
    const r = await __testing.simulateRun([
      line({ type: "result", subtype: "success", total_cost_usd: 0.001, permission_denials: [{ tool_name: P + "remember", tool_input: { fact: "x" } }] }),
    ]);
    expect(r.denials).toEqual([]);
    expect(r.notice).toBeNull();
    expect(r.proposals.length).toBe(1);
  });

  test("chat replies show external URLs as text, never as clickable links", async () => {
    const { events } = await __testing.simulate([
      line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "[ver](https://example.com/collect?d=ejemplo%20terap) y https://example.org/x y [[projects/proyecto-a]]" }] } }),
      line({ type: "result", subtype: "success", total_cost_usd: 0.001, permission_denials: [] }),
    ]);
    const html = events.at(-1)!.data.html as string;
    expect(html).not.toContain("<a href=\"https://");
    expect(html).toContain("ver (<span class=\"ext-url\"");
    expect(html).toContain("https://example.com/collect?d=ejemplo%20terap</span>");
    expect(html).toContain('href="#/p/projects/proyecto-a"');                // in-app links stay
  });

  test("a stopped run with usage but no new claude total records the estimate", async () => {
    const r = await __testing.simulateRun([
      line({ type: "assistant", message: { id: "m1", model: "claude-haiku-5-5", content: [{ type: "tool_use", id: "t1", name: P + "get_recent_salience", input: {} }], usage: { input_tokens: 20000, output_tokens: 50 } } }),
      line({ type: "result", subtype: "error_during_execution", total_cost_usd: 0, permission_denials: [] }),
    ], { stopReason: "user" });
    expect(r.estimated).toBe(true);
    expect(r.turnCost).toBeGreaterThan(0);
    expect(r.notice).toBe("Parado.");
  });

  test("init with another MCP server, no cerebro, or a built-in tool is refused", async () => {
    for (const [servers, tools] of [
      [[{ name: "cerebro", status: "connected" }, { name: "telegram", status: "connected" }], [P + "search"]],
      [[{ name: "cerebro", status: "failed" }], []],
      [[{ name: "cerebro", status: "connected" }], [P + "search", "Bash"]],
      [[{ name: "cerebro", status: "connected" }], [P + "get_page"]],
    ] as [object[], string[]][]) {
      const { initError } = await __testing.simulate([init(servers, tools)]);
      expect(typeof initError).toBe("string");
    }
  });

  test("budget subtype shows the 'empieza una nueva' notice", async () => {
    const { events } = await __testing.simulate([line({ type: "result", subtype: "error_max_budget_usd", total_cost_usd: 2.01, permission_denials: [] })]);
    expect(events.at(-1)!.data.notice_es).toContain("Conversación larga");
  });
});

describe("per-turn cost", () => {
  test("first turn is the total; resumed turns subtract the saved total", () => {
    expect(perTurnCost(0.05, false, 0, 0.05)).toEqual({ cost: 0.05, mode: "run" });
    expect(perTurnCost(0.08, true, 0.05, 0.03).mode).toBe("cumulative");
    expect(perTurnCost(0.08, true, 0.05, 0.03).cost).toBeCloseTo(0.03, 10);
    expect(perTurnCost(0.08, true, 0.05, 0).cost).toBeCloseTo(0.03, 10);   // no estimate: trust the docs
    expect(perTurnCost(0.02, true, 0.05, 0.02)).toEqual({ cost: 0.02, mode: "run" });   // total restarted
    expect(perTurnCost(0.09, true, 0.05, 0.09)).toEqual({ cost: 0.09, mode: "run" });   // estimate says: this run only
  });

  test("settleTurnCost: a run that called the API is never free", () => {
    expect(settleTurnCost(0, 0.0012)).toEqual({ cost: 0.0012, estimated: true });
    expect(settleTurnCost(0.003, 0.0012)).toEqual({ cost: 0.003, estimated: false });
    expect(settleTurnCost(0, 0)).toEqual({ cost: 0, estimated: false });
  });

  test("enviar_correo becomes an email proposal; drafts missing to/subject/body are dropped", () => {
    const r = splitDenials([
      { tool_name: "mcp__correo__enviar_correo", tool_input: { para: ["Sarah <sarah@example.com>"], asunto: "Re: reunión", cuerpo: "Hola", responder_a_id: "INBOX|12" } },
      { tool_name: "mcp__correo__enviar_correo", tool_input: { para: [], asunto: "x", cuerpo: "y" } },
    ]);
    expect(r.proposals).toEqual([{ tool: "email", to: ["Sarah <sarah@example.com>"], cc: [], subject: "Re: reunión", body: "Hola", replyToId: "INBOX|12" }]);
    expect(r.denials).toEqual([]);
  });

  test("splitDenials clips, validates and caps proposals", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ fact: "f" + i }));
    const r = splitDenials([
      { tool_name: P + "remember", tool_input: { items: many } },
      { tool_name: P + "remember", tool_input: { fact: "y".repeat(900), kind: "nonsense" } },
      { tool_name: P + "capture", tool_input: { content: "" } },
      { tool_name: P + "delete_page", tool_input: {} },
      { tool_name: P + "delete_page", tool_input: {} },
    ]);
    expect(r.proposals.length).toBe(5);
    expect(r.denials).toEqual(["delete_page"]);
    const big = splitDenials([{ tool_name: P + "remember", tool_input: { fact: "y".repeat(900), kind: "nonsense" } }]).proposals[0] as any;
    expect(big.fact.length).toBe(500);
    expect(big.kind).toBe("fact");
  });

  test("labels", () => {
    expect(toolLabel("get_page", { slug: "people/ana" })).toBe("leyó people/ana");
    expect(toolLabel("remember", {})).toBe("propone guardar un hecho");
    expect(toolLabel("edit_page", { slug: "ops/tasks" })).toBe("intentó editar ops/tasks");
    expect(toolLabel("capture", {})).toBe("propone apuntar una nota");
    expect(toolLabel("recall", { grep: "x" })).toBe("consultó hechos");
  });
});

describe("runner with a fake claude (no model call)", () => {
  const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
  const raw: any[] = [];
  beforeAll(() => {
    __testing.setClaudeBin(FAKE, [200, 400]);
    __testing.setRawTap((o) => raw.push(o));
  });
  afterAll(() => {
    __testing.setClaudeBin("/opt/homebrew/bin/claude");
    __testing.setRawTap(null);
  });

  const sse = async (runId: string, lastId?: number) => {
    const headers: Record<string, string> = lastId != null ? { "Last-Event-ID": String(lastId) } : {};
    const res = chatStream(new Request(`http://127.0.0.1:3140/api/chat/stream?run=${runId}`, { headers }), { timeout() {} });
    if (res.status !== 200) return { status: res.status, events: [] as { id: number; event: string; data: any }[] };
    const text = await res.text();
    const events = text.split("\n\n").filter((b) => b.includes("event:")).map((b) => {
      const f = Object.fromEntries(b.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
      return { id: Number(f.id), event: f.event, data: JSON.parse(f.data) };
    });
    return { status: 200, events };
  };
  const lastResult = () => JSON.parse(raw.filter((o) => o.type === "result").at(-1).result);

  let convId = "";
  test("first turn: argv, stdin, env, SSE and saved conversation", async () => {
    const r = await startChat({ text: "hola panel", model: "haiku" });
    expect(r.status).toBe(202);
    const { runId, conversationId } = r.body as any;
    convId = conversationId;
    const { events } = await sse(runId);
    expect(events.map((e) => e.event)).toEqual(["status", "text", "done"]);
    expect(events[1].data.d).toBe("eco: hola panel");
    expect(events[2].data).toMatchObject({ costUsd: 0.01, costMode: "run", sessionId: "s-fake", subtype: "success" });
    const { argv, stdin, envKeys } = lastResult();
    expect(stdin).toBe("hola panel");
    expect(argv).not.toContain("hola panel");                          // prompt never in argv
    expect(argv.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("__REPO__/panel/agente-chat/mcp.json");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("2.00");
    expect(argv).not.toContain("--resume");
    expect(envKeys).toContain("ENABLE_TOOL_SEARCH");
    expect(envKeys.filter((k: string) => /^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_)/.test(k))).toEqual([]);
    expect(__testing.activeRunId()).toBeNull();
    const c = getChat(convId) as any;
    expect(c.turns.map((t: any) => t.role)).toEqual(["user", "assistant"]);
    expect(c.sessionId).toBe("s-fake");
    expect(c.costUsd).toBe(0.01);
  });

  test("second turn resumes; cumulative total becomes a per-turn cost", async () => {
    const r = await startChat({ text: "y ahora", conversationId: convId, model: "haiku" });
    expect(r.status).toBe(202);
    const { events } = await sse((r.body as any).runId);
    expect(events.at(-1)!.data).toMatchObject({ costUsd: 0.02, totalCostUsd: 0.03, costMode: "cumulative" });
    const { argv } = lastResult();
    expect(argv[argv.indexOf("--resume") + 1]).toBe("s-fake");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1.99");    // what is left of the $2 conversation budget
    expect((getChat(convId) as any).costUsd).toBeCloseTo(0.03, 6);
    expect(panelSpendToday().usd).toBeCloseTo(0.03, 6);
    expect((listChats() as any).chats.length).toBe(1);
  });

  test("one run at a time; stop escalates SIGINT → SIGTERM; replay and 204", async () => {
    const r = await startChat({ text: "colgar", model: "haiku" });
    expect(r.status).toBe(202);
    const runId = (r.body as any).runId;
    expect((await startChat({ text: "otra", model: "haiku" })).status).toBe(409);
    await Bun.sleep(150);                                               // let the fake install its SIGINT handler
    expect(stopChat({ runId }).status).toBe(200);
    const { events } = await sse(runId);
    const last = events.at(-1)!;
    expect(last.event).toBe("error");
    expect(last.data).toMatchObject({ code: "stopped", message_es: "Parado." });
    expect(__testing.activeRunId()).toBeNull();
    const replay = await sse(runId, 1);
    expect(replay.events.map((e) => e.id)).toEqual(events.filter((e) => e.id > 1).map((e) => e.id));
    expect((await sse(runId, last.id)).status).toBe(204);
  });
});

describe("refused init", () => {
  test("a result after a refused init emits no done event", async () => {
    const { events, initError } = await __testing.simulate([
      JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "cerebro", status: "connected" }, { name: "x", status: "connected" }], tools: ["mcp__cerebro__search"] }),
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "no debe salir" } } }),
      JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.001, permission_denials: [] }),
    ]);
    expect(typeof initError).toBe("string");
    expect(events.map((e) => e.event)).toEqual(["status"]);
  });
});
