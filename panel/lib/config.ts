// lib/config.ts — panel configuration, runtime state folder and the minimal
// environment every child process gets (spec §2, §3).
//
// Nothing here holds a secret. The panel secret lives in STATE_DIR/secret and
// is handled only by lib/auth.ts.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PANEL_DIR = "__REPO__/panel";
export const STATE_DIR = "__HOME__/.gbrain-panel";

export interface PriceRow { in: number; out: number; cw5m: number; cw1h: number; cr: number }
export interface PanelConfig {
  port: number;
  brainDir: string;
  tasksSlug: string;
  coldDays: number;
  estadoFile: string;
  chat: {
    defaultModel: "sonnet" | "haiku" | "opus";
    allowOpus: boolean;
    convBudgetUsd: number;
    dailyBudgetUsd: number;
    maxTurns: number;
    gbrainHooks: boolean;
    runTimeoutSec: number;
  };
  telegram: { projectDir: string; launchdLabel: string; botPidFile: string };
  logs: { backup: string; daily: string };
  mapaUrl: string;
  prices: Record<"opus" | "sonnet" | "haiku", PriceRow>;
}

export const config: PanelConfig = JSON.parse(readFileSync(join(PANEL_DIR, "config.json"), "utf8"));

/** The only environment passed to gbrain, git, claude… Never the server's own env. */
export const MINENV: Record<string, string> = {
  HOME: "__HOME__",
  USER: "__USER__",
  LOGNAME: "__USER__",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: "es_ES.UTF-8",
  PATH: "/opt/homebrew/bin:__HOME__/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin",
};

export const GBRAIN_BIN = "__HOME__/.bun/bin/gbrain";
export const DB_URL = "postgres://__USER__@localhost:5432/gbrain";

export const paths = {
  secret: join(STATE_DIR, "secret"),
  sessions: join(STATE_DIR, "sessions.json"),
  state: join(STATE_DIR, "state.json"),
  chats: join(STATE_DIR, "chats"),
  spend: join(STATE_DIR, "spend.jsonl"),
  audit: join(STATE_DIR, "audit.jsonl"),
  telegramIndex: join(STATE_DIR, "telegram-index.json"),
  mapaSnapshot: join(STATE_DIR, "mapa-snapshot.json"),
};

/** Creates ~/.gbrain-panel (0700) and its chats/ folder. Safe to call often. */
export function ensureStateDir(): void {
  for (const dir of [STATE_DIR, paths.chats]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* not ours to fix */ }
  }
}

// ---------------------------------------------------------------------------
// state.json {lastSeen, tasksSlug, ...}: small, written atomically, mode 0600.

export interface PanelState {
  lastSeen?: string;      // ISO; "Nuevo desde tu última visita"
  tasksSlug?: string;     // slug actually stored for the tasks page
  installedAt?: string;
  identity?: { at: string; version?: string; updateAvailable?: boolean; latestVersion?: string };
  [k: string]: unknown;
}

export function readState(): PanelState {
  try { return JSON.parse(readFileSync(paths.state, "utf8")); } catch { return {}; }
}

export function writeState(patch: Partial<PanelState>): PanelState {
  ensureStateDir();
  const next = { ...readState(), ...patch };
  const tmp = paths.state + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, paths.state);
  return next;
}

/** Slug of the tasks page: the one recorded at creation, else config. */
export function tasksSlug(): string {
  const s = readState().tasksSlug;
  return typeof s === "string" && s ? s : config.tasksSlug;
}

/** Local calendar date YYYY-MM-DD (the Mac's time zone). */
export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
