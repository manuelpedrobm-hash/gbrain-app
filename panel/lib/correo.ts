// lib/correo.ts — sends an email __NOMBRE__ reviewed and confirmed in the panel.
//
// The chat never sends: its enviar_correo calls arrive as proposals (chat.ts).
// Only POST /api/correo/enviar, after a click on «Enviar» in the review dialog,
// runs ops/correo-enviar.py, which sends through IONOS SMTP and files a copy in
// «Elementos enviados». The audit line names the recipients' domains, never the
// content.

import { appendFileSync } from "node:fs";
import { ensureStateDir, MINENV, paths } from "./config.ts";

const PYTHON = "/usr/bin/python3";
const SENDER = "__REPO__/ops/correo-enviar.py";
const EMAIL_RE = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[A-Za-z]{2,}$/;
const ID_RE = /^(INBOX|Elementos enviados)\|\d+$/;

export class CorreoError extends Error {
  constructor(public status: number, public code: string, public message_es: string) { super(message_es); }
}

function list(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : [];
  return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
}

/** Bare address of "Name <a@b.c>" or "a@b.c". */
function addr(s: string): string {
  const m = /<([^>]+)>\s*$/.exec(s);
  return (m ? m[1] : s).trim();
}

function audit(target: string, ok: boolean, error?: string, draft = false) {
  try {
    ensureStateDir();
    appendFileSync(paths.audit, JSON.stringify({ ts: new Date().toISOString(), tool: draft ? "guardar_borrador" : "enviar_correo", target, ok, requestId: crypto.randomUUID(), ...(error ? { error } : {}) }) + "\n", { mode: 0o600 });
  } catch { /* the audit log must never break a send */ }
}

export function sendEmail(body: Record<string, any>) { return run(body, false); }

/** Files the email in IONOS «Borradores» (Mail shows it as a draft). Sends nothing. */
export function saveDraft(body: Record<string, any>) { return run(body, true); }

async function run(body: Record<string, any>, draft: boolean): Promise<{ ok: true; messageId: string }> {
  const para = list(body.para);
  const cc = list(body.cc);
  const asunto = String(body.asunto ?? "").replace(/[\r\n]+/g, " ").trim();
  const cuerpo = String(body.cuerpo ?? "").replace(/\u0000/g, "").trim();
  const responder = body.responder_a_id ? String(body.responder_a_id) : "";
  if (!para.length && !draft) throw new CorreoError(400, "bad_request", "Falta el destinatario.");
  for (const a of [...para, ...cc]) if (!EMAIL_RE.test(addr(a))) throw new CorreoError(400, "bad_address", `Dirección no válida: ${a}`);
  if (para.length + cc.length > 10) throw new CorreoError(400, "too_many", "Máximo 10 destinatarios.");
  if (!asunto || asunto.length > 300) throw new CorreoError(400, "bad_subject", "Revisa el asunto.");
  if (!cuerpo || cuerpo.length > 20000) throw new CorreoError(400, "bad_body", "Revisa el texto del correo.");
  if (responder && !ID_RE.test(responder)) throw new CorreoError(400, "bad_reply", "El correo al que respondes no es válido.");

  const target = [...new Set([...para, ...cc].map((a) => addr(a).split("@")[1]))].join(",");
  const proc = Bun.spawn([PYTHON, "-I", SENDER, ...(draft ? ["--borrador"] : [])], {
    env: MINENV, stdin: new Blob([JSON.stringify({ para, cc, asunto, cuerpo, responder_a_id: responder || null })]),
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 90_000);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  let r: any = null;
  try { r = JSON.parse(out.trim().split("\n").pop() || "null"); } catch { /* below */ }
  if (!r?.ok) {
    const msg = typeof r?.error === "string" ? r.error : "no respondió";
    audit(target, false, msg.slice(0, 120), draft);
    throw new CorreoError(502, "send_failed", `No se pudo ${draft ? "guardar el borrador" : "enviar"}: ${msg}`);
  }
  audit(target, true, undefined, draft);
  return { ok: true, messageId: String(r.message_id ?? "") };
}
