// Local store of the Misiones artifacts (lib/artdb.ts) and the diary appender (lib/diario.ts).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as artdb from "../lib/artdb.ts";
import { __testing as diarioTesting, appendEntry, HEADING, listEntries } from "../lib/diario.ts";

const ROOT = mkdtempSync(join(tmpdir(), "artdb-test-"));
let dir = "";
let n = 0;
beforeEach(() => { dir = join(ROOT, String(++n)); artdb.__testing.setDir(dir); });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("artdb store", () => {
  test("a missing file is an empty store with the page's collections", () => {
    expect(artdb.snapshot("cola")).toEqual({ rev: 0, collections: { items: {}, config: {} } });
  });

  test("unknown page, collection, op or id are refused", () => {
    expect(() => artdb.snapshot("otra")).toThrow(artdb.ArtdbError);
    expect(() => artdb.write("cola", "set", "missions", "a", {})).toThrow("Colección no permitida");
    expect(() => artdb.write("cola", "merge", "items", "a", {})).toThrow("Operación no válida");
    for (const bad of ["", "..", "a/b", "a b", "x".repeat(201)]) expect(() => artdb.write("cola", "set", "items", bad, {})).toThrow("Id de documento");
    expect(() => artdb.write("cola", "set", "items", "a", [1])).toThrow("objeto");
  });

  test("set, update (merge), delete and rev", () => {
    expect(artdb.write("cola", "set", "items", "x1", { titulo: "Uno", estado: "pendiente" }).rev).toBe(1);
    const u = artdb.write("cola", "update", "items", "x1", { estado: "hecho", nota: null });
    expect(u.before).toEqual({ titulo: "Uno", estado: "pendiente" });
    expect(u.after).toEqual({ titulo: "Uno", estado: "hecho", nota: null });
    expect(artdb.snapshot("cola").collections!.items.x1).toEqual({ titulo: "Uno", estado: "hecho", nota: null });
    artdb.write("cola", "set", "items", "x1", { titulo: "Otro" });
    expect(artdb.snapshot("cola").collections!.items.x1).toEqual({ titulo: "Otro" });
    expect(artdb.write("cola", "delete", "items", "x1").rev).toBe(4);
    expect(artdb.snapshot("cola").collections!.items).toEqual({});
    // Deleting what is not there changes nothing.
    expect(artdb.write("cola", "delete", "items", "x1").rev).toBe(4);
  });

  test("update of a missing document is not_found", () => {
    try { artdb.write("mapa", "update", "missions", "nope", { done: true }); throw new Error("no lanzó"); }
    catch (e: any) { expect(e.code).toBe("not_found"); expect(e.status).toBe(404); }
  });

  test("add creates a new 20-character id", () => {
    const r = artdb.write("mapa", "add", "missions", undefined, { title: "Nueva" });
    expect(r.id).toMatch(/^[a-z0-9]{20}$/);
    expect(artdb.snapshot("mapa").collections!.missions[r.id]).toEqual({ title: "Nueva" });
  });

  test("since=rev answers unchanged", () => {
    artdb.write("mapa", "set", "config", "main", { target: 3 });
    const s = artdb.snapshot("mapa");
    expect(artdb.snapshot("mapa", s.rev)).toEqual({ rev: s.rev, unchanged: true });
    expect(artdb.snapshot("mapa", s.rev - 1).collections!.config.main).toEqual({ target: 3 });
  });

  test("file is 0600 in a 0700 folder, written atomically and survives a reload", () => {
    artdb.write("cola", "set", "config", "order", { ids: ["a", "b"] });
    const f = join(dir, "cola.json");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(f + ".tmp")).toBe(false);
    const onDisk = JSON.parse(readFileSync(f, "utf8"));
    expect(onDisk.collections.config.order).toEqual({ ids: ["a", "b"] });
    artdb.__testing.setDir(dir); // drops the cache
    expect(artdb.snapshot("cola").collections!.config.order).toEqual({ ids: ["a", "b"] });
  });

  test("a failed write leaves the cached store untouched", () => {
    artdb.write("cola", "set", "items", "a", { v: 1 });
    expect(() => artdb.write("cola", "update", "items", "zzz", { v: 2 })).toThrow();
    expect(artdb.snapshot("cola").rev).toBe(1);
  });

  test("replaceAll seeds a page and bumps rev", () => {
    artdb.write("mapa", "set", "missions", "old", { title: "x" });
    const s = artdb.replaceAll("mapa", { missions: { m1: { title: "Uno" } }, preguntas: { p1: { q: "?" } }, otra: { z: {} } } as any);
    expect(s.rev).toBe(2);
    expect(Object.keys(s.collections)).toEqual(["missions", "checkins", "preguntas", "config"]);
    expect(artdb.snapshot("mapa").collections!.missions).toEqual({ m1: { title: "Uno" } });
  });
});

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
