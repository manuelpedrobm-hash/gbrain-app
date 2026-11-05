// Hermes rounds reader (lib/hermes.ts): parsing of the monthly pages written by ops/hermes-empuje.sh.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing, listRounds, parseRounds, urgentOf } from "../lib/hermes.ts";

const ROOT = mkdtempSync(join(tmpdir(), "hermes-test-"));
let n = 0;
let dir = "";
beforeEach(() => { dir = join(ROOT, String(++n)); mkdirSync(dir, { recursive: true }); __testing.setDir(dir); });

const MES = `---\ntype: note\ntitle: "Hermes: rondas"\n---\n\n# Hermes: rondas de empuje\n\n
## 2026-11-05 14:10\n\n🔱 Hermes · 14:09\n\n👉 Lo más urgente ahora: llamar a [[people/ana|Ana]] hoy.\n⏳ Hilos colgados:\nAna: desde el lunes\n\n
## 2026-11-05 21:01\n\n🔱 Hermes · 21:00\n\n👉 Lo más urgente ahora: decidir el proyecto [[projects/alfa]].\n`;

describe("parseRounds", () => {
  test("splits rounds by heading and ignores the preamble", () => {
    const r = parseRounds(MES);
    expect(r.map((x) => x.id)).toEqual(["2026-11-05 14:10", "2026-11-05 21:01"]);
    expect(r[0].markdown.startsWith("🔱 Hermes · 14:09")).toBe(true);
    expect(r[0].markdown).toContain("Ana: desde el lunes");
    expect(r[0].markdown).not.toContain("2026-11-05 21:01");
  });
  test("an empty round is dropped; text without headings gives nothing", () => {
    expect(parseRounds("## 2026-11-05 10:00\n\n\n## 2026-11-05 11:00\n\nhola")).toHaveLength(1);
    expect(parseRounds("solo texto")).toEqual([]);
  });
  test("summary: the urgent line without wikilink syntax, trimmed", () => {
    expect(urgentOf("x\n👉 Lo más urgente ahora: llamar a [[people/ana|Ana]] hoy.\ny")).toBe("llamar a Ana hoy.");
    expect(urgentOf("sin esa línea")).toBe("");
    expect(urgentOf("Lo más urgente ahora: " + "a".repeat(300)).length).toBe(158);
  });
});

describe("listRounds", () => {
  test("newest first across months; other files ignored", () => {
    writeFileSync(join(dir, "empuje-2026-10.md"), "## 2026-10-30 09:00\n\nviejo\n");
    writeFileSync(join(dir, "empuje-2026-11.md"), MES);
    writeFileSync(join(dir, "notas.md"), "## 2026-12-01 09:00\n\nno es un empuje\n");
    const { rounds, total, folder } = listRounds();
    expect(folder).toBe(true);
    expect(total).toBe(3);
    expect(rounds.map((r) => r.id)).toEqual(["2026-11-05 21:01", "2026-11-05 14:10", "2026-10-30 09:00"]);
  });
  test("limit trims the list but not the total; a missing folder is reported", () => {
    writeFileSync(join(dir, "empuje-2026-11.md"), MES);
    expect(listRounds(1).rounds).toHaveLength(1);
    expect(listRounds(1).total).toBe(2);
    __testing.setDir(join(ROOT, "no-existe"));
    expect(listRounds()).toEqual({ rounds: [], total: 0, folder: false });
  });
});

describe("summary for the Hoy card", () => {
  const md = "🔱 Hermes · 21:00\n\n👉 Lo más urgente ahora: decidir si sigue [[projects/alfa]].\nPrimer paso: escribe una línea.\n\n⏳ Hilos colgados:\nAna: desde el lunes\nJosé: desde el martes\n\n🧊 Frentes parados:\nBeta: 7 días\n\n✅ Bien: algo.";
  test("whole urgent paragraph and section counts", async () => {
    const { summarize, urgentFullOf, countSection } = await import("../lib/hermes.ts");
    expect(urgentFullOf(md)).toBe("decidir si sigue projects/alfa. Primer paso: escribe una línea.");
    expect(countSection(md, "Hilos colgados")).toBe(2);
    expect(countSection(md, "Frentes parados")).toBe(1);
    expect(countSection(md, "No existe")).toBe(0);
    const s = summarize({ id: "2026-11-05 21:01", date: "2026-11-05", time: "21:01", markdown: md, urgent: "x" });
    expect([s.hilos, s.parados]).toEqual([2, 1]);
  });
  test("mtime of the monthly pages moves when a round is appended", async () => {
    const { hermesMtimeMs } = await import("../lib/hermes.ts");
    expect(hermesMtimeMs()).toBe(0);
    writeFileSync(join(dir, "empuje-2026-11.md"), MES);
    expect(hermesMtimeMs()).toBeGreaterThan(0);
  });
});
