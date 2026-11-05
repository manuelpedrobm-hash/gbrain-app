// lib/health.ts — health strip checks (60 s cache), the Estado issues list,
// "Ejecutar diagnóstico" (gbrain doctor) and Actividad (spec §6.1, §6.7).
//
// Nothing here fixes anything: issues are explained in Spanish with
// "cómo arreglarlo", and __NOMBRE__ decides. No doctor/stats/health calls run
// except from the Estado button. Telegram data (last inbound, cost) is passed
// in by server.ts from lib/telegram.ts.

import { existsSync, openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { MINENV, config, paths, readState, writeState } from "./config.ts";
import { embeddedChunkCount, factActivity, ping, requestLogSummary, tasksStoredSlug } from "./db.ts";
import { callTool, GbrainError, runDoctorCli } from "./gbrain.ts";
import { tasksFilePath } from "./tasks.ts";

export type Status = "ok" | "warn" | "error";
export interface Check { id: "cerebro" | "postgres" | "telegram" | "copia" | "sync"; status: Status; label_es: string; detail_es: string }

export interface HealthDeps {
  /** From lib/telegram.ts getTelegramSummary(). */
  telegram: () => Promise<{ ok: boolean; lastInboundTs: string | null; costToday: { usd: number; requests: number } }>;
  /** From lib/chat.ts panelSpendToday(). */
  panelSpend: () => { usd: number; capUsd: number };
}

// ---------------------------------------------------------------------------
// helpers

/** Runs a command with MINENV, no shell, cwd "/". stderr is discarded. */
export async function runCmd(argv: string[], timeoutMs = 10_000): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  const bin = argv[0].startsWith("/") ? argv[0] : Bun.which(argv[0], { PATH: MINENV.PATH }) ?? argv[0];
  const proc = Bun.spawn([bin, ...argv.slice(1)], { cwd: "/", env: MINENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL"); } catch { } }, timeoutMs);
  const errDrain = new Response(proc.stderr).arrayBuffer().catch(() => null);
  const stdout = await new Response(proc.stdout).text().catch(() => "");
  const code = await proc.exited;
  clearTimeout(t);
  await errDrain;
  return { code, stdout, timedOut };
}

/** Last `maxBytes` of a text file (logs can grow). "" if unreadable. */
export function tailText(path: string, maxBytes = 65536): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { }
  }
}

/** "2026-10-25 22:45:24" (local time in the logs) → Date. */
function parseLogTime(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function agoEs(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

const BAD_SYNC = /No such file|Operation not permitted|error/i;

/** The last "=== … daily start" block of daily.log. */
export function lastDailyBlock(text: string): { start: Date | null; lines: string[] } | null {
  const lines = text.split(/\r?\n/);
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^=== .* daily start/.test(lines[i])) { idx = i; break; }
  if (idx < 0) return null;
  const m = /^=== (.+?) daily start/.exec(lines[idx]);
  return { start: m ? parseLogTime(m[1]) : null, lines: lines.slice(idx + 1).filter((l) => l.trim() !== "") };
}

// ---------------------------------------------------------------------------
// individual checks

async function checkCerebro(): Promise<Check> {
  try {
    const r = await fetch("http://127.0.0.1:3131/health", { signal: AbortSignal.timeout(2000) });
    const j: any = await r.json();
    if (j?.status !== "ok") return { id: "cerebro", status: "error", label_es: "Cerebro", detail_es: "GBrain responde, pero no dice «ok»" };
    const pending = !!j?.build?.restart_pending;
    return {
      id: "cerebro", status: pending ? "warn" : "ok", label_es: "Cerebro",
      detail_es: `GBrain ${j.version ?? "?"}${pending ? " · reinicio pendiente" : ""}`,
    };
  } catch {
    return { id: "cerebro", status: "error", label_es: "Cerebro", detail_es: "GBrain no responde en 127.0.0.1:3131" };
  }
}

async function checkPostgres(): Promise<Check> {
  try {
    const ok = await ping();
    return { id: "postgres", status: ok ? "ok" : "error", label_es: "Base de datos", detail_es: ok ? "Postgres responde" : "Postgres respondió algo raro" };
  } catch {
    return { id: "postgres", status: "error", label_es: "Base de datos", detail_es: "Postgres no responde" };
  }
}

async function checkTelegram(lastInboundTs: string | null): Promise<Check> {
  let running = false;
  try {
    const r = await runCmd(["/bin/launchctl", "print", `gui/__UID__/${config.telegram.launchdLabel}`], 5000);
    const m = /^\s*state = (\S+)/m.exec(r.stdout);
    running = m?.[1] === "running";
  } catch { /* treated as not running */ }
  let botAlive = false;
  try {
    const pid = Number(readFileSync(config.telegram.botPidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 1) { process.kill(pid, 0); botAlive = true; }
  } catch { botAlive = false; }
  const last = lastInboundTs ? ` · último mensaje ${agoEs(Date.now() - new Date(lastInboundTs).getTime())}` : "";
  if (running && botAlive) return { id: "telegram", status: "ok", label_es: "Telegram", detail_es: `Agente y bot en marcha${last}` };
  if (running) return { id: "telegram", status: "warn", label_es: "Telegram", detail_es: `El agente corre, pero el bot no${last}` };
  return { id: "telegram", status: "error", label_es: "Telegram", detail_es: `El agente de Telegram no está en marcha${last}` };
}

export function checkCopia(text: string = tailText(config.logs.backup), now = Date.now()): Check {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ok dump (\S+)(?: \(([^)]+)\))?/.exec(lines[i]);
    if (!m) continue;
    const t = parseLogTime(m[1]);
    if (!t) continue;
    const age = now - t.getTime();
    const size = m[3] ? ` (${m[3]})` : "";
    return {
      id: "copia", status: age > 36 * 3600_000 ? "warn" : "ok", label_es: "Copia",
      detail_es: `Última copia ${agoEs(age)}${size}`,
    };
  }
  return { id: "copia", status: "error", label_es: "Copia", detail_es: "No encuentro ninguna copia en backup.log" };
}

export function checkSync(text: string = tailText(config.logs.daily), now = Date.now()): Check {
  const block = lastDailyBlock(text);
  if (!block) return { id: "sync", status: "warn", label_es: "Sincronización", detail_es: "daily.log no tiene ninguna ejecución" };
  const bad = block.lines.find((l) => BAD_SYNC.test(l));
  const when = block.start ? agoEs(now - block.start.getTime()) : "fecha desconocida";
  if (bad) return { id: "sync", status: "error", label_es: "Sincronización", detail_es: `Última ejecución (${when}): ${bad.slice(0, 160)}` };
  const old = block.start ? now - block.start.getTime() > 36 * 3600_000 : true;
  return {
    id: "sync", status: old ? "warn" : "ok", label_es: "Sincronización",
    detail_es: old ? `La tarea diaria no corre desde ${when}` : `Última ejecución ${when}, sin errores`,
  };
}

// ---------------------------------------------------------------------------
// /api/health

let healthCache: { at: number; checks: Check[]; telegramCostToday: { usd: number; requests: number } } | null = null;

export async function getHealth(deps: HealthDeps) {
  if (!healthCache || Date.now() - healthCache.at > 60_000) {
    let tg = { ok: false, lastInboundTs: null as string | null, costToday: { usd: 0, requests: 0 } };
    try { tg = await deps.telegram(); } catch { /* the strip still renders */ }
    const checks = await Promise.all([
      checkCerebro(), checkPostgres(), checkTelegram(tg.lastInboundTs),
      Promise.resolve(checkCopia()), Promise.resolve(checkSync()),
    ]);
    healthCache = { at: Date.now(), checks, telegramCostToday: tg.costToday ?? { usd: 0, requests: 0 } };
  }
  let panelChatToday = { usd: 0, capUsd: config.chat.dailyBudgetUsd };
  try { panelChatToday = deps.panelSpend(); } catch { }
  return { checks: healthCache.checks, telegramCostToday: healthCache.telegramCostToday, panelChatToday, at: new Date(healthCache.at).toISOString() };
}

// ---------------------------------------------------------------------------
// Estado: issues, identity, doctor, actividad

export interface Issue { id: string; severity: "error" | "warn" | "info"; title_es: string; detail_es: string; fix_es: string }

/** get_brain_identity at most once a day (cached in state.json). */
async function identity(): Promise<{ version: string | null; updateAvailable?: boolean; latestVersion?: string }> {
  const st = readState();
  const cached = st.identity;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < 86400_000) {
    return { version: cached.version ?? null, updateAvailable: cached.updateAvailable, latestVersion: cached.latestVersion };
  }
  try {
    const r = await callTool("get_brain_identity", {});
    const id = { at: new Date().toISOString(), version: r?.version, updateAvailable: !!r?.update_available, latestVersion: r?.latest_version };
    writeState({ identity: id });
    return { version: id.version ?? null, updateAvailable: id.updateAvailable, latestVersion: id.latestVersion };
  } catch {
    return { version: cached?.version ?? null };
  }
}

export async function computeIssues(id: { version: string | null; updateAvailable?: boolean; latestVersion?: string }): Promise<Issue[]> {
  const issues: Issue[] = [];
  const block = lastDailyBlock(tailText(config.logs.daily));
  const blockText = block ? block.lines.join("\n") : "";
  if (/bun: No such file/i.test(blockText)) {
    issues.push({
      id: "sync_bun_path", severity: "error",
      title_es: "La sincronización nocturna falla",
      detail_es: "La tarea diaria no encuentra bun («env: bun: No such file or directory»), así que la base de datos no se pone al día con el repositorio cada noche.",
      fix_es: "Añade /opt/homebrew/bin al PATH en __REPO__/ops/gbrain-daily.sh.",
    });
  }
  if (/Operation not permitted/i.test(blockText)) {
    issues.push({
      id: "informes_blocked", severity: "warn",
      title_es: "macOS bloquea la copia de los informes",
      detail_es: "La privacidad de macOS impide que la tarea diaria lea la carpeta de informes («Operation not permitted»), aunque el registro diga «copied».",
      fix_es: "En Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco, da acceso a /bin/zsh (lo usa la tarea de launchd), o mueve los informes fuera del Escritorio.",
    });
  }
  try {
    const r = await runCmd(["git", "-C", config.brainDir, "remote"], 5000);
    if (r.code === 0 && r.stdout.trim() === "") {
      issues.push({
        id: "no_remote", severity: "warn",
        title_es: "Las copias no salen de este Mac",
        detail_es: "El repositorio del cerebro no tiene remoto: si el disco falla, se pierde todo.",
        fix_es: "Crea un repositorio privado (por ejemplo en GitHub), añádelo con «git remote add origin …» y haz «git push». La base de datos necesita además copiar los volcados fuera del Mac.",
      });
    }
  } catch { }
  try {
    if ((await embeddedChunkCount()) === 0) {
      issues.push({
        id: "embeddings_off", severity: "info",
        title_es: "La búsqueda solo encuentra palabras exactas",
        detail_es: "Los embeddings están apagados: buscar «ejemplo» funciona, pero no encuentra sinónimos ni ignora tildes.",
        fix_es: "Es una decisión pendiente: configurar una clave de embeddings (Voyage) en GBrain.",
      });
    }
  } catch { }
  if (id.updateAvailable) {
    issues.push({
      id: "update_available", severity: "info",
      title_es: `Hay una versión nueva de GBrain${id.latestVersion ? ` (${id.version ?? "?"} → ${id.latestVersion})` : ""}`,
      detail_es: "La versión instalada funciona; la nueva puede traer arreglos.",
      fix_es: "Pide a Claude Code que actualice GBrain y reinicie com.gbrain.serve; después ejecuta «bun __REPO__/panel/check.ts».",
    });
  }
  issues.push({
    id: "admin_blank", severity: "info",
    title_es: "La página /admin de GBrain carga en blanco",
    detail_es: "Es un fallo conocido de GBrain (bug #7126). No afecta a este panel.",
    fix_es: "Nada que hacer: espera a una versión que lo arregle.",
  });
  try {
    const stored = await tasksStoredSlug();
    if (stored && !existsSync(tasksFilePath(stored))) {
      issues.push({
        id: "tasks_db_only", severity: "warn",
        title_es: "La lista de tareas está escrita solo en la base de datos",
        detail_es: `No existe ${tasksFilePath(stored)} en el repositorio: escrito solo en la base de datos.`,
        fix_es: "Pide a Claude Code que ejecute «gbrain sync» o que exporte la página al repositorio.",
      });
    }
  } catch { }
  return issues;
}

let lastDoctor: { at: string; result: DoctorSummary } | null = null;
let lastDoctorRunAt = 0;

export interface DoctorSummary { health_score: number | null; status: string; top_issues: { name: string; status: string; fix: string }[]; warn_checks: { name: string; message: string }[] }

/** "Ejecutar diagnóstico": gbrain doctor --json, 30 s timeout, at most once a minute. */
export async function runDoctor(): Promise<DoctorSummary> {
  if (Date.now() - lastDoctorRunAt < 60_000) throw new GbrainError(429, "too_soon", "Espera un minuto antes de repetir el diagnóstico");
  lastDoctorRunAt = Date.now();
  const d = await runDoctorCli();
  const result: DoctorSummary = {
    health_score: typeof d?.health_score === "number" ? d.health_score : null,
    status: String(d?.status ?? "desconocido"),
    top_issues: Array.isArray(d?.top_issues)
      ? d.top_issues.slice(0, 10).map((x: any) => ({ name: String(x?.name ?? ""), status: String(x?.status ?? ""), fix: String(x?.fix ?? "").slice(0, 600) }))
      : [],
    warn_checks: Array.isArray(d?.checks)
      ? d.checks.filter((c: any) => c && c.status !== "ok").slice(0, 30).map((c: any) => ({ name: String(c.name ?? ""), message: String(c.message ?? "").slice(0, 600) }))
      : [],
  };
  lastDoctor = { at: new Date().toISOString(), result };
  return result;
}

function auditTail(n = 30): unknown[] {
  const text = tailText(paths.audit, 64 * 1024);
  return text.split("\n").filter(Boolean).slice(-n).reverse().map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

async function gitLog(): Promise<{ hash: string; date: string; subject: string }[]> {
  const r = await runCmd(["git", "-C", config.brainDir, "log", "--pretty=%h|%aI|%s", "-n", "20"], 5000);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const [hash, date, ...rest] = l.split("|");
    return { hash, date, subject: rest.join("|") };
  });
}

export async function getEstadoPage() {
  const id = await identity();
  const [issues, facts, git, requests] = await Promise.all([
    computeIssues(id),
    factActivity(7).catch(() => ({ created: [], retired: [] })),
    gitLog().catch(() => []),
    requestLogSummary().catch(() => []),
  ]);
  // Facts created or retired in the last 7 days, newest first, as one list
  // (the Estado view strikes through the retired ones).
  const factRows = [
    ...facts.created.map((f: any) => ({ ...f, expired_at: null as string | null })),
    ...facts.retired,
  ].sort((a: any, b: any) => String(b.expired_at ?? b.created_at ?? "").localeCompare(String(a.expired_at ?? a.created_at ?? "")))
    .slice(0, 40);
  const out: any = {
    issues,
    identity: { version: id.version, ...(id.updateAvailable !== undefined ? { updateAvailable: id.updateAvailable } : {}), ...(id.latestVersion ? { latestVersion: id.latestVersion } : {}) },
    activity: { audit: auditTail(30), facts: factRows, git, mcp: requests },
  };
  if (lastDoctor) out.doctor = { ...lastDoctor.result, at: lastDoctor.at };
  return out;
}
