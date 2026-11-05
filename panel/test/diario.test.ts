// Diary appender and reader (lib/diario.ts).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing as diarioTesting, appendEntry, HEADING, listEntries } from "../lib/diario.ts";

const ROOT = mkdtempSync(join(tmpdir(), "diario-test-"));
let dir = "";
let n = 0;
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("diario", () => {
  const orig = join(ROOT, "diario-orig");
  const brain = join(ROOT, "diario-brain");
  beforeEach(() => {
    rmSync(orig, { recursive: true, force: true }); rmSync(brain, { recursive: true, force: true });
    mkdirSync(orig, { recursive: true }); mkdirSync(brain, { recursive: true });
    diarioTesting.setDirs(orig, brain);
  });

  test("creates today's file with a dated title and the panel heading", () => {
    const now = new Date(2026, 9, 26, 9, 5);
    appendEntry("Primera nota", now);
    expect(readFileSync(join(orig, "2026-10-26.md"), "utf8")).toBe(`# 26 de octubre de 2026\n\n${HEADING}\n\n- **09:05** — Primera nota\n`);
  });

  test("appends below an existing entry, never rewriting it", () => {
    const f = join(orig, "2026-10-26.md");
    const existing = "# 26 de octubre de 2026 — Foro\n\n## Avances\n\n- algo";
    writeFileSync(f, existing);
    appendEntry("uno\nen dos líneas", new Date(2026, 9, 26, 10, 0));
    appendEntry("dos", new Date(2026, 9, 26, 11, 30));
    const text = readFileSync(f, "utf8");
    expect(text.startsWith(existing + "\n")).toBe(true);
    expect(text.slice(existing.length)).toBe(`\n\n${HEADING}\n\n- **10:00** — uno en dos líneas\n- **11:30** — dos\n`);
  });

  test("a later section written by someone else gets a new panel heading", () => {
    const f = join(orig, "2026-10-26.md");
    writeFileSync(f, `# d\n\n${HEADING}\n\n- **09:00** — a\n\n## Decisiones\n\n- b\n`);
    appendEntry("c", new Date(2026, 9, 26, 12, 0));
    expect(readFileSync(f, "utf8").endsWith(`## Decisiones\n\n- b\n\n${HEADING}\n\n- **12:00** — c\n`)).toBe(true);
  });

  test("empty text is refused; a read-only folder is a sin_permiso error", () => {
    expect(() => appendEntry("   ")).toThrow("Escribe algo");
    chmodSync(orig, 0o500);
    try {
      appendEntry("x", new Date(2026, 9, 27, 8, 0));
      throw new Error("no lanzó");
    } catch (e: any) {
      expect(e.code).toBe("sin_permiso");
    } finally { chmodSync(orig, 0o700); }
  });

  test("lists both folders newest first; the original wins", () => {
    writeFileSync(join(brain, "2026-10-21.md"), "# Copia vieja\n");
    writeFileSync(join(brain, "2026-10-20.md"), "# Solo en el cerebro\n");
    writeFileSync(join(orig, "2026-10-21.md"), "# Original\n");
    writeFileSync(join(orig, "notas.md"), "# no es del diario\n");
    const { entries, original } = listEntries();
    expect(original.readable).toBe(true);
    expect(entries.map((e) => [e.date, e.title, e.source])).toEqual([
      ["2026-10-21", "Original", "original"], ["2026-10-20", "Solo en el cerebro", "cerebro"],
    ]);
  });

  test("an unreadable original falls back to the brain copy", () => {
    rmSync(orig, { recursive: true, force: true });
    writeFileSync(join(brain, "2026-10-21.md"), "# Copia\n");
    const r = listEntries();
    expect(r.original.readable).toBe(false);
    expect(r.entries.map((e) => e.source)).toEqual(["cerebro"]);
  });
});
