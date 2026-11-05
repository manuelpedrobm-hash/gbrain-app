// Telegram transcript parser (spec §6.4, §9). Uses an anonymised fixture:
// fake chat/user/file ids and invented text, same record shapes as the real
// agent transcript (claude 2.1.308).

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanTranscript, costByDayOf, isSkippedLine, messagesOf, newFileState, parseTranscriptText, readIncrement, refresh,
} from "../lib/telegram.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "telegram-sample.jsonl");
const TEXT = readFileSync(FIXTURE, "utf8");
const LATER = Date.parse("2026-01-10T12:00:00Z");          // long after the last record
const PRICES = { opus: { in: 4, out: 20, cw5m: 5, cw1h: 8, cr: 0.2 } };

const byId = (msgs: ReturnType<typeof messagesOf>) => Object.fromEntries(msgs.map((m) => [m.messageId, m]));

describe("telegram parser", () => {
  const st = parseTranscriptText(TEXT);
  const msgs = messagesOf(st, LATER);
  const m = byId(msgs);

  test("finds every inbound message once, skips request-log records", () => {
    expect(msgs.map((x) => x.messageId)).toEqual([101, 103, 104, 107, 108]);
    expect(m[999]).toBeUndefined();
    expect(m[998]).toBeUndefined();
    expect(st.badLines).toBe(0);
  });

  test("plain message gets its confirmed reply and turn duration", () => {
    expect(m[101].status).toBe("respondido");
    expect(m[101].reply).toEqual({ ts: "2026-01-10T10:00:02.000Z", text: "Respuesta de prueba uno" });
    expect(m[101].turnMs).toBe(4000);
    expect(m[101].kind).toBe("text");
  });

  test("queued attachment message joins the batch; a second reply is appended", () => {
    for (const id of [103, 104]) {
      expect(m[id].status).toBe("respondido");
      expect(m[id].reply?.text).toBe("Respuesta conjunta\n\nSegunda parte");
      expect(m[id].turnMs).toBe(9000);
    }
    expect(m[104].text).toBe("Mensaje de prueba tres");
  });

  test("voice note carries its transcript without timestamps", () => {
    expect(m[107].kind).toBe("voice");
    expect(m[107].transcript).toBe("Nota de voz de prueba.\nSegunda frase.");
    expect(m[107].reply?.text).toBe("Respuesta a la nota");
    expect(m[107].turnMs).toBe(12000);
  });

  test("a message only enqueued while busy is not answered by the earlier reply", () => {
    expect(m[108].reply).toBeUndefined();
    expect(m[108].status).toBe("sin_respuesta");
    expect(m[108].agentError_es).toBe("El agente falló: error de la API (400)");   // failed reply + API error
    expect(m[108].turnMs).toBe(1500);
  });

  test("unanswered message is 'en curso' while the transcript is fresh", () => {
    const fresh = byId(messagesOf(st, Date.parse("2026-01-10T10:11:00Z")));
    expect(fresh[108].status).toBe("en_curso");
    expect(fresh[101].status).toBe("respondido");
  });

  test("never exposes chat_id, user_id, user or the file id", () => {
    const out = JSON.stringify(msgs);
    for (const secret of ["111111111", "222222222", "usuario_prueba", "FAKEFILEID107", "chat_id", "user_id"]) {
      expect(out.includes(secret)).toBe(false);
    }
  });

  test("cost: deduplicated by requestId, synthetic error records ignored", () => {
    expect(Object.keys(st.usage).sort()).toEqual(["req_1", "req_2", "req_3", "req_4", "req_5", "req_6", "req_7"]);
    // per request: (1000·4 + 1000·20 + 10000·5 + 1000·8 + 100000·0.2) / 1e6 = 0.102
    const days = costByDayOf([st], PRICES);
    expect(days.length).toBe(1);
    expect(days[0].day).toBe("2026-01-10");      // same local day from UTC-10 to UTC+13
    expect(days[0].requests).toBe(7);
    expect(days[0].usd).toBeCloseTo(0.714, 6);
  });

  test("helpers", () => {
    expect(isSkippedLine('{"type":"api-request-blob","x":1}')).toBe(true);
    expect(isSkippedLine('{"type":"api-request-shape"}')).toBe(true);
    expect(isSkippedLine('{"type":"user","message":{"content":"habla de \\"type\\":\\"api-request\\""}}')).toBe(false);
    expect(cleanTranscript("[00:00:00.000 --> 00:00:01.000]  Hola\n\n[00:00:01.000 --> 00:00:02.000] adiós ")).toBe("Hola\nadiós");
  });
});

describe("incremental reading", () => {
  test("reading in two parts (cut mid-line) equals one pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-test-"));
    try {
      const p = join(dir, "a.jsonl");
      const cut = Math.floor(TEXT.length * 0.55);        // inside some line
      writeFileSync(p, TEXT.slice(0, cut));
      let { state, changed } = readIncrement(p, newFileState());
      expect(changed).toBe(true);
      expect(TEXT.slice(0, state.offset).endsWith("\n")).toBe(true);   // partial line not consumed
      appendFileSync(p, TEXT.slice(cut));
      ({ state } = readIncrement(p, state));
      expect(state.offset).toBe(Buffer.byteLength(TEXT));
      expect(messagesOf(state, LATER)).toEqual(messagesOf(parseTranscriptText(TEXT), LATER));
      // Nothing new: nothing changes.
      expect(readIncrement(p, state).changed).toBe(false);
      // Replaced file (new inode) starts over.
      rmSync(p);
      writeFileSync(p, TEXT.split("\n").slice(0, 4).join("\n") + "\n");
      ({ state } = readIncrement(p, state));
      expect(messagesOf(state, LATER).map((x) => x.messageId)).toEqual([101]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refresh merges the 2 newest files and fails cleanly when there are none", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-test-"));
    try {
      expect(() => refresh(dir, false)).toThrow();
      const lines = TEXT.split("\n");
      writeFileSync(join(dir, "old.jsonl"), lines.slice(0, 9).join("\n") + "\n");   // message 101 only
      writeFileSync(join(dir, "new.jsonl"), TEXT);
      writeFileSync(join(dir, "older.jsonl"), TEXT.replaceAll('message_id=\\"101\\"', 'message_id=\\"55\\"'));
      utimesSync(join(dir, "older.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
      const snap = refresh(dir, false, LATER);
      expect(snap.messages.map((x) => x.messageId)).toEqual([108, 107, 104, 103, 101]);   // newest first, 55 not read
      expect(snap.lastInboundTs).toBe("2026-01-10T10:10:20.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
