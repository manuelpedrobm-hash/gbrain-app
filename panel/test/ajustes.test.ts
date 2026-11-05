import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing, billing, getAjustes, noteApiFailure, setAjustes } from "../lib/ajustes.ts";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ajustes-")); __testing.setFiles(dir); });

describe("ajustes", () => {
  test("defaults to the plan; model and caps validate and persist, mirror file follows", () => {
    expect(getAjustes().facturacion).toBe("plan");
    expect(billing()).toEqual({ mode: "plan", env: {}, fallback: false });
    setAjustes({ modelo: "haiku", presupuestoDiario: 7.5 });
    expect(getAjustes()).toMatchObject({ modelo: "haiku", presupuestoDiario: 7.5, facturacion: "plan" });
    expect(readFileSync(join(dir, "facturacion"), "utf8").trim()).toBe("plan");
    expect(() => setAjustes({ modelo: "gpt" })).toThrow();
    expect(() => setAjustes({ presupuestoDiario: 1000 })).toThrow();
    expect(() => setAjustes({ facturacion: "gratis" })).toThrow();
  });

  test("key failures are recognised; other errors are not", () => {
    expect(noteApiFailure("Credit balance is too low to access the Anthropic API")).toBe(true);
    expect(noteApiFailure("Invalid API key · Fix external API key")).toBe(true);
    expect(noteApiFailure("Overloaded")).toBe(false);
  });
});
