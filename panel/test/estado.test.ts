// Spanish dates against the anonymised ESTADO fixture (spec §9).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daysUntil, getEstado, parseEstado, parseSpanishDate, urgencyFor } from "../lib/estado.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "estado.md"), "utf8");
const MTIME = new Date(2026, 9, 25, 8, 14); // 25 oct 2026, local
const NOW = new Date(2026, 9, 25, 22, 0);

describe("parseSpanishDate", () => {
  test("28 oct", () => expect(parseSpanishDate("28 oct", MTIME)).toEqual({ date: "2026-10-28" }));
  test("30 oct, 10:00 CET keeps time and zone", () =>
    expect(parseSpanishDate("30 oct, 10:00 CET", MTIME)).toEqual({ date: "2026-10-30", timeLabel: "10:00 CET" }));
  test("3 nov, 15:00 EST", () =>
    expect(parseSpanishDate("3 nov, 15:00 EST", MTIME)).toEqual({ date: "2026-11-03", timeLabel: "15:00 EST" }));
  test("15 ene 2027 uses the explicit year", () => expect(parseSpanishDate("15 ene 2027", MTIME)).toEqual({ date: "2027-01-15" }));
  test("**31 oct** strips bold", () => expect(parseSpanishDate("**31 oct**", MTIME)).toEqual({ date: "2026-10-31" }));
  test("sept and sep both mean September", () => {
    expect(parseSpanishDate("2 sept", new Date(2026, 8, 1))!.date).toBe("2026-09-02");
    expect(parseSpanishDate("2 sep", new Date(2026, 8, 1))!.date).toBe("2026-09-02");
  });
  test("no year: more than 60 days before the mtime rolls to next year", () => {
    expect(parseSpanishDate("15 ene", new Date(2026, 11, 1))!.date).toBe("2027-01-15");
    expect(parseSpanishDate("1 ago", MTIME)!.date).toBe("2027-08-01");
    expect(parseSpanishDate("1 oct", MTIME)!.date).toBe("2026-10-01"); // 24 days before: same year
  });
  test("garbage and impossible dates are rejected", () => {
    expect(parseSpanishDate("sin fecha", MTIME)).toBeNull();
    expect(parseSpanishDate("31 nov", MTIME)).toBeNull();
  });
});

describe("parseEstado", () => {
  const rows = parseEstado(FIXTURE, MTIME, NOW);

  test("reads only the Fechas que vencen table", () => {
    expect(rows.map((r) => r.date)).toEqual([
      "2026-10-22", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-03", "2026-11-04", "2027-01-15",
    ]);
    expect(rows.every((r) => r.source === "estado" && r.ref === "sources/informes-claude/estado")).toBe(true);
  });

  test("labels lose their bold markers; time labels are kept", () => {
    const c = rows.find((r) => r.date === "2026-10-31")!;
    expect(c.label).toBe("Cierra la convocatoria C. Borrador hecho");
    expect(rows.find((r) => r.date === "2026-11-03")!.timeLabel).toBe("15:00 EST");
    expect(rows.find((r) => r.date === "2026-10-30")!.timeLabel).toBe("10:00 CET");
  });

  test("past rows are flagged; urgency colours by days left", () => {
    expect(rows.find((r) => r.date === "2026-10-22")!.past).toBe(true);
    expect(rows.find((r) => r.date === "2026-10-28")!.urgency).toBe("amber"); // 3 days
    expect(rows.find((r) => r.date === "2027-01-15")!.urgency).toBe("normal");
  });

  test("urgency thresholds: ≤2 red, ≤7 amber", () => {
    expect(urgencyFor("2026-10-27", "2026-10-25")).toBe("red");
    expect(urgencyFor("2026-11-01", "2026-10-25")).toBe("amber");
    expect(urgencyFor("2026-11-02", "2026-10-25")).toBe("normal");
    expect(daysUntil("2027-01-01", "2026-12-31")).toBe(1);
  });

  test("no table → no rows; unreadable file → ok:false", () => {
    expect(parseEstado("# nada", MTIME, NOW)).toEqual([]);
    const r = getEstado(NOW, join(import.meta.dir, "fixtures", "no-existe.md"));
    expect(r.ok).toBe(false);
    expect(r.error_es).toBe("No pude leer ESTADO.md");
  });
});
