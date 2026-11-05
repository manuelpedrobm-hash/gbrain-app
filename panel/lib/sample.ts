// lib/sample.ts — `claude.use("sample")` for the Cola de borradores
// («Pedir un cambio a Claude»): one short `claude -p` that rewrites a draft.
//
// Same safety model as lib/chat.ts, tighter: argv array, prompt on stdin,
// --tools "" and --strict-mcp-config with no MCP config (no tools at all),
// MINENV, GBRAIN_HOOKS=0, one run at a time, 0.20 US$ per run, and the spend
// counts toward the chat's daily cap. The answer is only text shown to __NOMBRE__;
// nothing is saved until he presses «Usar esta versión» in the page.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MINENV, STATE_DIR } from "./config.ts";
import { billing } from "./ajustes.ts";
import { panelSpendToday, recordPanelSpend } from "./chat.ts";

const CLAUDE_BIN = "/opt/homebrew/bin/claude";
const MODEL = "sonnet";
const RUN_BUDGET = 0.2;
const TIMEOUT_MS = 120_000;
const MAX_PROMPT = 60_000;
const CWD = join(STATE_DIR, "sample");

export class SampleError extends Error {
  constructor(public status: number, public code: string, public message_es: string) { super(message_es); }
}

let busy = false;

export async function runSample(prompt: unknown, signal?: AbortSignal): Promise<{ text: string; truncated: boolean; costUsd: number }> {
  if (typeof prompt !== "string" || !prompt.trim()) throw new SampleError(400, "empty", "Falta el texto");
  if (prompt.length > MAX_PROMPT) throw new SampleError(413, "too_large", "El texto es demasiado largo");
  const spend = panelSpendToday();
  if (spend.capUsd - spend.usd < RUN_BUDGET) throw new SampleError(429, "daily_cap", `Has llegado al límite diario de Claude en el panel (US$${spend.capUsd}).`);
  if (busy) throw new SampleError(429, "busy", "Ya hay una propuesta en curso");
  busy = true;
  try {
    if (!existsSync(CWD)) mkdirSync(CWD, { recursive: true, mode: 0o700 });
    const args = [
      CLAUDE_BIN, "-p", "--model", MODEL, "--output-format", "json",
      "--permission-mode", "dontAsk", "--tools", "", "--strict-mcp-config",
      "--max-turns", "1", "--max-budget-usd", RUN_BUDGET.toFixed(2),
    ];
    const env = { ...MINENV, GBRAIN_HOOKS: "0", ENABLE_TOOL_SEARCH: "false", ...billing().env };
    const proc = Bun.spawn(args, { cwd: CWD, env, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    const kill = () => { try { proc.kill(); } catch { /* gone */ } };
    const timer = setTimeout(kill, TIMEOUT_MS);
    signal?.addEventListener("abort", kill);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    let o: any = null;
    try { o = JSON.parse(out.trim().split("\n").pop() || ""); } catch { /* below */ }
    const cost = Number(o?.total_cost_usd) || 0;
    if (cost > 0) recordPanelSpend("cola-sample", MODEL, cost);
    if (signal?.aborted) throw new SampleError(499, "cancelled", "Parado");
    if (!o || o.is_error || typeof o.result !== "string") {
      throw new SampleError(502, "sample_failed", code === 0 ? "Claude no devolvió una propuesta" : `Claude falló (código ${code})`);
    }
    return { text: o.result.trim(), truncated: o.subtype !== "success" || o.stop_reason === "max_tokens", costUsd: cost };
  } finally {
    busy = false;
  }
}
