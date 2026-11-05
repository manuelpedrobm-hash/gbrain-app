// lib/pulse.ts — change fingerprint for the 20 s browser poll (spec §6.1).
//
// fp = sha1(DB change row + newest Telegram transcript "size:mtime" + ESTADO.md
// mtime). The browser refetches the current view only when fp changes.
// The Telegram part comes from lib/telegram.ts (telegramFingerprint), passed in
// by server.ts so this module stays independent of the transcript parser.

import { createHash } from "node:crypto";
import { pulseRow } from "./db.ts";
import { estadoMtimeMs } from "./estado.ts";

export async function computePulse(telegramFp: string): Promise<{ fp: string; ts: string }> {
  const row = await pulseRow();
  const fp = createHash("sha1")
    .update(JSON.stringify(row))
    .update("|" + telegramFp)
    .update("|" + estadoMtimeMs())
    .digest("hex");
  return { fp, ts: new Date().toISOString() };
}

/** Fingerprint of the palette index, so /api/index can be cached by the client. */
export function indexFingerprint(index: unknown): string {
  return createHash("sha1").update(JSON.stringify(index)).digest("hex").slice(0, 16);
}
