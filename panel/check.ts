// check.ts — read-only health check of the panel's dependencies (spec §9).
//
//   bun __REPO__/panel/check.ts
//
// Run it after every gbrain or claude upgrade. It never starts a model, never
// writes to the brain and never prints secrets. Prints PASS / WARN / FAIL per
// line and exits 1 if anything failed.

import { config } from "./lib/config.ts";
import * as db from "./lib/db.ts";
import { callCheckTool, gbrainHelp } from "./lib/gbrain.ts";
import { getEstado } from "./lib/estado.ts";
import { checkCopia, checkSync, runCmd } from "./lib/health.ts";

let fails = 0, warns = 0;
function report(level: "PASS" | "WARN" | "FAIL", what: string, detail = "") {
  if (level === "FAIL") fails++;
  if (level === "WARN") warns++;
  console.log(`${level.padEnd(4)}  ${what}${detail ? ` — ${detail}` : ""}`);
}

async function step(what: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e: any) { report("FAIL", what, String(e?.message_es ?? e?.message ?? e).slice(0, 200)); }
}

// 1. Read-only self-test
await step("SQL de solo lectura", async () => {
  const r = await db.selfTest();
  report(r.ok ? "PASS" : "FAIL", "SQL de solo lectura", r.message);
});

// 2. Every query in db.ts
await step("consultas de db.ts", async () => {
  const results = await db.runQueryChecks();
  for (const r of results) report(r.ok ? "PASS" : "FAIL", `consulta ${r.name}`, r.ok ? `${r.ms} ms` : r.error);
});

// 3. gbrain call get_page returns a revision
await step("gbrain get_page", async () => {
  const r = await callCheckTool("get_page", { slug: "projects/proyecto-a", include_content: true, content_only: true });
  const ok = typeof r?.revision === "string" && r.revision.length > 0 && typeof r?.content === "string";
  report(ok ? "PASS" : "FAIL", "gbrain get_page devuelve revision", ok ? "" : "sin revision/content");
});

// 4. gbrain call recall returns facts[].id
await step("gbrain recall", async () => {
  const r = await callCheckTool("recall", { grep: "GBrain", limit: 1 });
  const id = r?.facts?.[0]?.id;
  report(id != null ? "PASS" : "FAIL", "gbrain recall devuelve facts[].id", id != null ? "" : "sin facts[].id");
});

// 5. ESTADO parser
await step("ESTADO.md", async () => {
  const e = getEstado();
  if (!e.ok) return report("FAIL", "ESTADO.md", e.error_es);
  if (!e.rows.length) return report("FAIL", "ESTADO.md", "no encuentro filas en «Fechas que vencen»");
  const future = e.rows.filter((r) => !r.past).length;
  report(future ? "PASS" : "WARN", "ESTADO.md", `${e.rows.length} filas, ${future} futuras, archivo de hace ${e.ageDays} días`);
});

// 6. Telegram parser (lib/telegram.ts, written by its own module)
await step("Telegram", async () => {
  const tg = await import("./lib/telegram.ts");
  const r = await tg.getMensajes({ limit: 200 });
  if (!r.ok) return report("FAIL", "Telegram", r.error_es ?? "error");
  report(r.messages.length ? "PASS" : "WARN", "Telegram", `${r.messages.length} mensajes entrantes, ${r.costByDay.length} días con coste`);
});

// 7. Health checks run
await step("comprobaciones de salud", async () => {
  try {
    const res = await fetch("http://127.0.0.1:3131/health", { signal: AbortSignal.timeout(2000) });
    const j: any = await res.json();
    report(j?.status === "ok" ? "PASS" : "WARN", "salud: cerebro (3131)", `status=${j?.status} versión=${j?.version}`);
  } catch { report("WARN", "salud: cerebro (3131)", "no responde"); }
  report((await db.ping()) ? "PASS" : "FAIL", "salud: postgres");
  const l = await runCmd(["/bin/launchctl", "print", `gui/__UID__/${config.telegram.launchdLabel}`], 5000);
  const state = /^\s*state = (\S+)/m.exec(l.stdout)?.[1] ?? "desconocido";
  report(state === "running" ? "PASS" : "WARN", "salud: agente de Telegram", `state=${state}`);
  const c = checkCopia();
  report(c.status === "ok" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL", "salud: copia", c.detail_es);
  const s = checkSync();
  report(s.status === "ok" ? "PASS" : "WARN", "salud: sincronización", s.detail_es);
});

// 8. claude CLI flags the chat depends on
await step("claude", async () => {
  const v = await runCmd(["/opt/homebrew/bin/claude", "--version"], 15_000);
  report(v.code === 0 ? "PASS" : "FAIL", "claude --version", v.stdout.trim().split("\n")[0] ?? "");
  const h = await runCmd(["/opt/homebrew/bin/claude", "--help"], 15_000);
  for (const flag of ["--strict-mcp-config", "--max-budget-usd"]) {
    report(h.stdout.includes(flag) ? "PASS" : "FAIL", `claude --help menciona ${flag}`);
  }
});

// 9. gbrain serve --surface (chat uses the starter surface)
await step("gbrain serve --help", async () => {
  const out = await gbrainHelp(["serve", "--help"]);
  report(out.includes("--surface") ? "PASS" : "FAIL", "gbrain serve --help menciona --surface");
});

// 10. Every tool the chat's gbrain server offers is classified (ALLOW / PROPOSE / DENY).
// A tool added by a gbrain upgrade is refused by dontAsk anyway; this says which to decide on.
await step("herramientas del chat", async () => {
  const { ALLOW, PROPOSE, DENY } = await import("./lib/chat.ts");
  const mcp = JSON.parse(await Bun.file("__REPO__/panel/agente-chat/mcp.json").text()).mcpServers.cerebro;
  const p = Bun.spawn([mcp.command, ...mcp.args], { cwd: "/", env: mcp.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const send = (o: object) => { p.stdin.write(JSON.stringify(o) + "\n"); p.stdin.flush(); };
  const timer = setTimeout(() => p.kill(), 30_000);
  let names: string[] | null = null;
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "panel-check", version: "1" } } });
  const dec = new TextDecoder();
  let buf = "";
  try {
    outer: for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); }
        if (o.id === 2) { names = (o.result?.tools ?? []).map((t: any) => String(t.name)); break outer; }
      }
    }
  } finally {
    clearTimeout(timer);
    p.kill();
  }
  if (!names) return report("WARN", "herramientas del chat", "gbrain serve --surface starter no listó herramientas");
  const known = new Set([...ALLOW, ...PROPOSE, ...DENY].map((t) => t.replace(/^mcp__cerebro__/, "")));
  const unplaced = names.filter((n) => !known.has(n));
  report(unplaced.length ? "WARN" : "PASS", "herramientas del chat clasificadas",
    unplaced.length ? `sin decidir (el chat las rechaza): ${unplaced.join(", ")}` : `${names.length} herramientas`);
});

console.log(`\n${fails ? "FALLOS" : "OK"}: ${fails} fallos, ${warns} avisos`);
await db.sql.close().catch(() => undefined);
process.exit(fails ? 1 : 0);
