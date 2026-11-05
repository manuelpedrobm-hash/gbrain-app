// The startup self-test (spec §11: "the server refuses to start if CREATE TEMP
// TABLE succeeds"). Mocked connections only: no SQL reaches Postgres here.
import { describe, expect, test } from "bun:test";
import { selfTest } from "../lib/db.ts";

describe("selfTest", () => {
  test("a connection where CREATE TEMP TABLE succeeds fails the self-test", async () => {
    const statements: string[] = [];
    const writable = async (strings: TemplateStringsArray) => { statements.push(strings.join("?")); return []; };
    const r = await selfTest(writable);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("NO es de solo lectura");
    expect(statements).toEqual(["CREATE TEMP TABLE _probe(x int)"]);
  });

  test("a read-only refusal passes, by message or by SQLSTATE 25006", async () => {
    const byMessage = async () => { throw new Error("cannot execute CREATE TABLE in a read-only transaction"); };
    expect((await selfTest(byMessage)).ok).toBe(true);
    const byCode = async () => { throw Object.assign(new Error("x"), { errno: "25006" }); };
    expect((await selfTest(byCode)).ok).toBe(true);
  });

  test("any other error (Postgres down) fails", async () => {
    const down = async () => { throw new Error("connection refused"); };
    const r = await selfTest(down);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("connection refused");
  });
});
