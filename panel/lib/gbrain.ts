// lib/gbrain.ts — the only way the panel writes to the brain (spec §2).
//
// Runs `gbrain call <tool> '<json>'` as a trusted local call: argv array, no
// shell, cwd "/", MINENV only, 20 s timeout. Only an allowlist of tools can run.
// Every write gets a request_id and one line in ~/.gbrain-panel/audit.jsonl
// ({ts,tool,target,ok,requestId,error?}, never the content). stderr is never
// shown to the user; errors become a Spanish message.

import { appendFileSync } from "node:fs";
import { GBRAIN_BIN, MINENV, config, ensureStateDir, paths } from "./config.ts";

const READ_TOOLS = new Set(["get_page", "get_brain_identity"]);
const WRITE_TOOLS = new Set(["edit_page", "put_page", "remember", "forget", "capture"]);
/** Read-only tools that only check.ts may call. */
const CHECK_TOOLS = new Set(["recall", "get_page"]);

export class GbrainError extends Error {
  constructor(
    public status: number,
    public code: string,
    public message_es: string,
    /** Parsed error payload from gbrain (internal use only, e.g. current_revision). */
    public detail?: any,
  ) {
    super(message_es);
  }
}

const MESSAGES_ES: Record<string, [number, string]> = {
  page_not_found: [404, "No encontré esa página en el cerebro"],
  not_found: [404, "No encontré ese dato en el cerebro"],
  revision_conflict: [409, "Otra sesión cambió la página; recarga"],
  edit_no_match: [409, "La página cambió y ya no encuentro ese texto; recarga"],
  edit_ambiguous_match: [409, "El texto aparece más de una vez en la página; arréglalo desde Claude Code"],
  edit_protected_span: [409, "Esa parte de la página está protegida"],
  page_exists: [409, "La página ya existe"],
  unknown_tool: [500, "El panel pidió una herramienta que GBrain no conoce"],
};

function spanishError(code: string, fallbackStatus = 502): GbrainError {
  const m = MESSAGES_ES[code];
  if (m) return new GbrainError(m[0], code, m[1]);
  return new GbrainError(fallbackStatus, code || "gbrain_error", `GBrain no pudo hacerlo (${code || "error desconocido"})`);
}

function audit(entry: { tool: string; target: string; ok: boolean; requestId: string; error?: string }) {
  try {
    ensureStateDir();
    appendFileSync(paths.audit, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch { /* the audit log must never break a write */ }
}

/** Describes what a write touched, without its content. */
function auditTarget(tool: string, args: any, result?: any): string {
  if (tool === "forget") return `fact#${args?.id ?? "?"}`;
  if (tool === "remember") return result?.id != null ? `fact#${result.id}` : `fact:${args?.entity ?? "sin-entidad"}`;
  if (tool === "capture") return String(result?.slug ?? args?.slug ?? "inbox/");
  return String(args?.slug ?? "?");
}

interface SpawnResult { code: number | null; stdout: string; timedOut: boolean }

async function spawnGbrain(argv: string[], timeoutMs: number): Promise<SpawnResult> {
  const proc = Bun.spawn([GBRAIN_BIN, ...argv], {
    cwd: "/",
    env: MINENV,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGTERM"); } catch { }
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { } }, 2000);
  }, timeoutMs);
  // Drain stderr so the child never blocks on a full pipe; its text is discarded.
  const errDrain = new Response(proc.stderr).arrayBuffer().catch(() => null);
  const stdout = await new Response(proc.stdout).text().catch(() => "");
  const code = await proc.exited;
  clearTimeout(timer);
  await errDrain;
  return { code, stdout, timedOut };
}

/** Parses gbrain's stdout: plain JSON, or MCP-style {content:[{text}]} wrapping JSON. */
export function parseToolOutput(stdout: string): { ok: true; data: any } | { ok: false; code: string; detail?: any } {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (parsed && Array.isArray(parsed.content) && typeof parsed.content[0]?.text === "string") {
    const isError = parsed.isError === true;
    try {
      const inner = JSON.parse(parsed.content[0].text);
      if (isError || (inner && typeof inner === "object" && "error" in inner && !Array.isArray(inner))) {
        return { ok: false, code: String(inner?.code ?? inner?.error ?? "tool_error"), detail: inner };
      }
      return { ok: true, data: inner };
    } catch {
      return isError ? { ok: false, code: "tool_error" } : { ok: false, code: "invalid_json" };
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.isError === true) return { ok: false, code: String(parsed.code ?? "tool_error"), detail: parsed };
    if ("error" in parsed && parsed.error) return { ok: false, code: String(parsed.code ?? parsed.error), detail: parsed };
  }
  return { ok: true, data: parsed };
}

export interface CallOptions { timeoutMs?: number }

/**
 * Calls an allowlisted gbrain tool. Returns the parsed result or throws GbrainError.
 * Writes get request_id and an audit line.
 */
export async function callTool(tool: string, args: Record<string, any>, opts: CallOptions = {}): Promise<any> {
  const isWrite = WRITE_TOOLS.has(tool);
  if (!isWrite && !READ_TOOLS.has(tool)) throw new GbrainError(500, "tool_not_allowed", "El panel no puede usar esa herramienta");

  const a: Record<string, any> = { ...args };
  if (tool === "put_page") {
    // Only to create the tasks page: never replace an existing page.
    if (a.slug !== config.tasksSlug || "expected_revision" in a || "force" in a) {
      throw new GbrainError(500, "tool_not_allowed", "El panel solo puede crear la lista de tareas");
    }
  }
  if (isWrite && !a.request_id) a.request_id = crypto.randomUUID();
  const requestId: string = a.request_id ?? "";

  let res: SpawnResult;
  try {
    res = await spawnGbrain(["call", tool, JSON.stringify(a)], opts.timeoutMs ?? 20_000);
  } catch {
    if (isWrite) audit({ tool, target: auditTarget(tool, a), ok: false, requestId, error: "spawn_failed" });
    throw new GbrainError(502, "spawn_failed", "No pude ejecutar gbrain");
  }

  if (res.timedOut) {
    if (isWrite) audit({ tool, target: auditTarget(tool, a), ok: false, requestId, error: "timeout" });
    throw new GbrainError(504, "timeout", "GBrain tardó demasiado en responder");
  }

  if (res.code === 10) {
    // write_pending: accepted but not yet published.
    if (isWrite) audit({ tool, target: auditTarget(tool, a), ok: false, requestId, error: "write_pending" });
    throw new GbrainError(202, "write_pending", "La escritura quedó pendiente de confirmar; revisa en un momento");
  }

  const out = parseToolOutput(res.stdout);
  if (!out.ok) {
    if (isWrite) audit({ tool, target: auditTarget(tool, a), ok: false, requestId, error: out.code });
    const err = spanishError(out.code);
    err.detail = out.detail;
    throw err;
  }
  if (res.code !== 0) {
    if (isWrite) audit({ tool, target: auditTarget(tool, a), ok: false, requestId, error: `exit_${res.code}` });
    throw new GbrainError(502, "exit_" + res.code, "GBrain terminó con un error");
  }
  if (isWrite) audit({ tool, target: auditTarget(tool, a, out.data), ok: true, requestId });
  return out.data;
}

/** check.ts only: read-only calls outside the panel's allowlist (recall). */
export async function callCheckTool(tool: string, args: Record<string, any>): Promise<any> {
  if (!CHECK_TOOLS.has(tool)) throw new GbrainError(500, "tool_not_allowed", "Herramienta no permitida en la comprobación");
  const res = await spawnGbrain(["call", tool, JSON.stringify(args)], 20_000);
  if (res.timedOut) throw new GbrainError(504, "timeout", "GBrain tardó demasiado");
  const out = parseToolOutput(res.stdout);
  if (!out.ok) throw spanishError(out.code);
  return out.data;
}

/** `gbrain doctor --json --no-migrate` (30 s). --no-migrate keeps it a pure report. */
export async function runDoctorCli(): Promise<any> {
  const res = await spawnGbrain(["doctor", "--json", "--no-migrate"], 30_000);
  if (res.timedOut) throw new GbrainError(504, "timeout", "El diagnóstico tardó más de 30 s");
  try {
    return JSON.parse(res.stdout.trim());
  } catch {
    throw new GbrainError(502, "invalid_json", "El diagnóstico no devolvió un resultado legible");
  }
}

/** Plain read-only helper commands for check.ts (`gbrain serve --help`). */
export async function gbrainHelp(argv: string[]): Promise<string> {
  const res = await spawnGbrain(argv, 15_000);
  return res.stdout;
}
