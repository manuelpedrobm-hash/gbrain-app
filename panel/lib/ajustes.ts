// lib/ajustes.ts — settings __NOMBRE__ changes from the panel (Estado → Ajustes).
//
// Stored in ~/.gbrain-panel/ajustes.json; config.json keeps the defaults.
//  - facturacion: "api" spends the Anthropic API credits (key in the macOS
//    Keychain, service "anthropic-api-key", account "__USER__"); "plan" uses the
//    claude.ai subscription Claude Code is logged into. The same choice is
//    mirrored to ~/.gbrain-panel/facturacion (one word), which the `claude`
//    function in ~/.zshrc reads, so the terminal follows the panel switch.
//  - modelo / presupuestos: the chat's default model and spend caps.
// Plan B: when the API key fails (credits used up, key revoked), runs fall back
// to the plan for an hour and the panel says so. The key itself is read per run,
// kept in memory for a minute, and never logged, written or sent to the browser.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ensureStateDir, STATE_DIR } from "./config.ts";

export type Facturacion = "api" | "plan";
export interface Ajustes {
  facturacion: Facturacion;
  modelo: "sonnet" | "haiku" | "opus";
  presupuestoConversacion: number;
  presupuestoDiario: number;
}

let FILE = join(STATE_DIR, "ajustes.json");
let MIRROR = join(STATE_DIR, "facturacion");
const FALLBACK_MS = 60 * 60 * 1000;
const KEY_TTL_MS = 60 * 1000;
const FAIL_RE = /credit balance|insufficient.?credit|invalid.?x-api-key|invalid api key|authentication_error|api key.*(revoked|disabled)/i;

let keyCache: { key: string | null; at: number } | null = null;
let fallbackUntil = 0;

export class AjustesError extends Error {
  constructor(public status: number, public code: string, public message_es: string) { super(message_es); }
}

function defaults(): Ajustes {
  return {
    facturacion: "plan",
    modelo: (config.chat.defaultModel as Ajustes["modelo"]) || "sonnet",
    presupuestoConversacion: config.chat.convBudgetUsd,
    presupuestoDiario: config.chat.dailyBudgetUsd,
  };
}

export function getAjustes(): Ajustes {
  try { return { ...defaults(), ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { return defaults(); }
}

export function setAjustes(body: Record<string, any>): Ajustes {
  const cur = getAjustes();
  const next = { ...cur };
  if (body.facturacion != null) {
    if (body.facturacion !== "api" && body.facturacion !== "plan") throw new AjustesError(400, "bad_request", "Facturación no válida.");
    if (body.facturacion === "api" && !apiKey(true)) {
      throw new AjustesError(409, "no_key", "No encuentro la clave de API en el Llavero (servicio anthropic-api-key, cuenta __USER__).");
    }
    next.facturacion = body.facturacion;
    fallbackUntil = 0;
  }
  if (body.modelo != null) {
    if (!["sonnet", "haiku", "opus"].includes(body.modelo)) throw new AjustesError(400, "bad_request", "Modelo no válido.");
    next.modelo = body.modelo;
  }
  for (const [k, max] of [["presupuestoConversacion", 20], ["presupuestoDiario", 100]] as const) {
    if (body[k] == null) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0.1 || n > max) throw new AjustesError(400, "bad_request", `Presupuesto fuera de rango (0,10 a ${max} US$).`);
    next[k] = Math.round(n * 100) / 100;
  }
  ensureStateDir();
  writeFileSync(FILE + ".tmp", JSON.stringify(next, null, 1), { mode: 0o600 });
  renameSync(FILE + ".tmp", FILE);
  writeFileSync(MIRROR, next.facturacion + "\n", { mode: 0o600 });
  return next;
}

/** The API key from the Keychain (cached a minute), or null. */
function apiKey(fresh = false): string | null {
  if (!fresh && keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.key;
  let key: string | null = null;
  try {
    const r = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "anthropic-api-key", "-a", "__USER__", "-w"], { stdout: "pipe", stderr: "pipe" });
    const k = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    key = k.startsWith("sk-ant-") ? k : null;
  } catch { key = null; }
  keyCache = { key, at: Date.now() };
  return key;
}

/** What a run will bill to, and the env it needs for that. */
export function billing(): { mode: Facturacion; env: Record<string, string>; fallback: boolean } {
  const a = getAjustes();
  if (a.facturacion !== "api") return { mode: "plan", env: {}, fallback: false };
  if (Date.now() < fallbackUntil) return { mode: "plan", env: {}, fallback: true };
  const key = apiKey();
  if (!key) return { mode: "plan", env: {}, fallback: true };
  return { mode: "api", env: { ANTHROPIC_API_KEY: key }, fallback: false };
}

/** True when `text` looks like a key or credit failure; starts the one-hour fallback to the plan. */
export function noteApiFailure(text: string): boolean {
  if (!FAIL_RE.test(text || "")) return false;
  fallbackUntil = Date.now() + FALLBACK_MS;
  keyCache = null;
  return true;
}

export function billingStatus(): object {
  const a = getAjustes();
  return {
    ...a,
    claveEnLlavero: !!apiKey(),
    planB: Date.now() < fallbackUntil ? new Date(fallbackUntil).toISOString() : null,
  };
}

export const __testing = {
  setFiles(dir: string) { FILE = join(dir, "ajustes.json"); MIRROR = join(dir, "facturacion"); fallbackUntil = 0; keyCache = null; },
  setKey(key: string | null) { keyCache = { key, at: Date.now() }; },
};
