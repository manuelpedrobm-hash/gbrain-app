// Task grammar round-trip and every edit builder (spec §9).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyEdits, buildAdd, buildDefer, buildDone, buildEdit, buildMove, buildReopen, formatLine, nextId,
  parseTasks, sanitizeMetaValue, sanitizeTaskText, TaskError, TEMPLATE, toDoc,
} from "../lib/tasks.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "tasks.md"), "utf8");
const TODAY = "2026-10-25";

/** Lines removed / added between two versions (multiset diff). */
function lineDiff(a: string, b: string) {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const l of s.split("\n")) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = count(a), cb = count(b);
  const removed: string[] = [], added: string[] = [];
  for (const [l, n] of ca) for (let i = 0; i < n - (cb.get(l) ?? 0); i++) removed.push(l);
  for (const [l, n] of cb) for (let i = 0; i < n - (ca.get(l) ?? 0); i++) added.push(l);
  return { removed, added };
}

/** Section key of the line at index i (by scanning back to the last "## " heading). */
function sectionOf(content: string, needle: string): string | null {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  for (let j = i; j >= 0; j--) {
    const m = /^## (\S+)/.exec(lines[j]);
    if (m) return m[1];
  }
  return null;
}

describe("parse", () => {
  const p = parseTasks(FIXTURE, TODAY);

  test("finds sections, tasks, steps and metadata", () => {
    expect(Object.keys(p.headings).sort()).toEqual(["Completed", "Deferred", "P0", "P1", "P2", "P3"]);
    expect(p.headings.P1).toBe("## P1 — Today");
    expect(p.tasks.length).toBe(7);
    const a = p.tasks.find((t) => t.id === "t-20261025-01")!;
    expect(a.section).toBe("P1");
    expect(a.text).toBe("Llamar a la persona A #equipo");
    expect(a.tags).toEqual(["#equipo"]);
    expect(a.due).toBe("2026-10-27");
    expect(a.steps).toEqual([{ done: false, text: "preparar preguntas" }, { done: true, text: "buscar el número" }]);
    expect(a.overdue).toBe(false);
  });

  test("overdue, deferred and completed fields", () => {
    expect(p.tasks.find((t) => t.id === "t-20261020-01")!.overdue).toBe(true);
    const d = p.tasks.find((t) => t.id === "t-20261015-01")!;
    expect(d.deferredUntil).toBe("2026-11-10");
    expect(d.reason).toBe("espera respuesta");
    const c = p.tasks.find((t) => t.id === "t-20261019-01")!;
    expect(c.done).toBe(true);
    expect(c.completed).toBe("2026-10-19");
    expect(c.overdue).toBe(false);
  });

  test("a parenthetical without known keys stays in the text", () => {
    const t = p.tasks.find((t) => t.id === "t-20261025-02")!;
    expect(t.text).toBe("Revisar borrador (versión 2)");
    expect(t.due).toBeUndefined();
  });

  test("unparsed lines are kept and reported", () => {
    expect(p.unparsed).toEqual([{ lineNo: 15, text: "Una línea suelta que no se entiende" }]);
  });

  test("round trip: canonical lines rebuild byte-for-byte", () => {
    for (const t of p.tasks) {
      if (t.id === "t-20261025-02") continue; // folded parenthetical (rebuilds as text)
      expect(formatLine(t.done, t.id, t.text, (t as any).meta)).toBe((t as any).line);
    }
  });

  test("works on compiled_truth (no frontmatter) too", () => {
    const body = FIXTURE.replace(/^---[\s\S]*?---\n/, "");
    expect(parseTasks(body, TODAY).tasks.length).toBe(7);
  });

  test("the template parses with every section and no tasks", () => {
    const t = parseTasks(TEMPLATE, TODAY);
    expect(Object.keys(t.headings).length).toBe(6);
    expect(t.tasks.length).toBe(0);
    expect(t.unparsed.length).toBe(0);
    expect(toDoc("ops/tasks", t).writable).toBe(true);
  });
});

describe("edit builders", () => {
  const p = parseTasks(FIXTURE, TODAY);

  test("add: new ID for today, one line added right under the heading", () => {
    const b = buildAdd(p, { text: "Nueva tarea #etiqueta", priority: "P1", due: "2026-10-30" }, TODAY);
    expect(b.id).toBe("t-20261025-03");
    const after = applyEdits(FIXTURE, b.edits);
    const d = lineDiff(FIXTURE, after);
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual(["- [ ] <!-- id: t-20261025-03 --> Nueva tarea #etiqueta (due: 2026-10-30)"]);
    expect(after).toContain("## P1 — Today\n- [ ] <!-- id: t-20261025-03 -->");
    const re = parseTasks(after, TODAY).tasks.find((t) => t.id === b.id)!;
    expect(re.section).toBe("P1");
    expect(re.due).toBe("2026-10-30");
  });

  test("add: IDs pad to 2 digits and continue after the day's highest", () => {
    expect(nextId(parseTasks(TEMPLATE), TODAY)).toBe("t-20261025-01");
    expect(nextId(p, "2026-10-22")).toBe("t-20261022-04");
  });

  test("done: block (with steps) leaves P1 and lands under Completed", () => {
    const b = buildDone(p, FIXTURE, "t-20261025-01", TODAY);
    const after = applyEdits(FIXTURE, b.edits);
    const d = lineDiff(FIXTURE, after);
    expect(d.removed).toEqual(["- [ ] <!-- id: t-20261025-01 --> Llamar a la persona A #equipo (due: 2026-10-27)"]);
    expect(d.added).toEqual(["- [x] <!-- id: t-20261025-01 --> Llamar a la persona A #equipo (completed: 2026-10-25)"]);
    expect(sectionOf(after, "t-20261025-01")).toBe("Completed");
    expect(after).toContain("(completed: 2026-10-25)\n  - [ ] preparar preguntas\n  - [x] buscar el número");
    const re = parseTasks(after, TODAY);
    expect(re.tasks.find((t) => t.id === "t-20261025-01")!.steps.length).toBe(2);
    expect(re.tasks.length).toBe(7);
  });

  test("done on an already-completed task is a no-op", () => {
    expect(buildDone(p, FIXTURE, "t-20261019-01", TODAY).edits).toEqual([]);
  });

  test("move: P2 → P0 changes only the position", () => {
    const b = buildMove(p, FIXTURE, "t-20261022-03", "P0");
    const after = applyEdits(FIXTURE, b.edits);
    expect(lineDiff(FIXTURE, after)).toEqual({ removed: [], added: [] });
    expect(sectionOf(after, "t-20261022-03")).toBe("P0");
  });

  test("move out of Deferred drops the deferred metadata", () => {
    const b = buildMove(p, FIXTURE, "t-20261015-01", "P2");
    const after = applyEdits(FIXTURE, b.edits);
    expect(lineDiff(FIXTURE, after).added).toEqual(["- [ ] <!-- id: t-20261015-01 --> Reunión con el inversor"]);
    expect(sectionOf(after, "t-20261015-01")).toBe("P2");
  });

  test("defer: moves under Deferred with until and reason, keeps due", () => {
    const b = buildDefer(p, FIXTURE, "t-20261025-01", "2026-11-05", sanitizeMetaValue("espera (datos); luego"));
    const after = applyEdits(FIXTURE, b.edits);
    expect(lineDiff(FIXTURE, after).added).toEqual([
      "- [ ] <!-- id: t-20261025-01 --> Llamar a la persona A #equipo (due: 2026-10-27; deferred until: 2026-11-05; reason: espera datos, luego)",
    ]);
    expect(sectionOf(after, "t-20261025-01")).toBe("Deferred");
    const re = parseTasks(after, TODAY).tasks.find((t) => t.id === "t-20261025-01")!;
    expect(re.deferredUntil).toBe("2026-11-05");
    expect(re.steps.length).toBe(2);
  });

  test("reopen: Completed → P1 as an open task", () => {
    const b = buildReopen(p, FIXTURE, "t-20261019-01");
    const after = applyEdits(FIXTURE, b.edits);
    expect(lineDiff(FIXTURE, after)).toEqual({
      removed: ["- [x] <!-- id: t-20261019-01 --> Reservar vuelo (completed: 2026-10-19)"],
      added: ["- [ ] <!-- id: t-20261019-01 --> Reservar vuelo"],
    });
    expect(sectionOf(after, "t-20261019-01")).toBe("P1");
  });

  test("edit: replaces exactly one line and keeps metadata", () => {
    const b = buildEdit(p, "t-20261020-01", "Enviar presupuesto final #etiqueta2");
    const after = applyEdits(FIXTURE, b.edits);
    expect(lineDiff(FIXTURE, after)).toEqual({
      removed: ["- [ ] <!-- id: t-20261020-01 --> Enviar presupuesto a la fundación #etiqueta2 (due: 2026-10-24)"],
      added: ["- [ ] <!-- id: t-20261020-01 --> Enviar presupuesto final #etiqueta2 (due: 2026-10-24)"],
    });
  });

  test("unknown task id → 404", () => {
    expect(() => buildEdit(p, "t-20990101-01", "x")).toThrow(TaskError);
  });

  test("a missing section refuses with 422", () => {
    const noP0 = FIXTURE.replace(/## P0 — Urgent\n- \[ \][^\n]*\n/, "");
    const q = parseTasks(noP0, TODAY);
    try {
      buildAdd(q, { text: "x", priority: "P0" }, TODAY);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TaskError);
      expect((e as TaskError).status).toBe(422);
    }
  });

  test("applyEdits refuses an old_text that does not match exactly once", () => {
    expect(() => applyEdits("a\nb\na", [{ old_text: "a", new_text: "c" }])).toThrow(TaskError);
    expect(() => applyEdits("a", [{ old_text: "zz", new_text: "c" }])).toThrow(TaskError);
  });
});

describe("refusals and sanitising", () => {
  test("duplicate headings make the list read-only", () => {
    const dup = FIXTURE + "\n## P1 — Today\n- [ ] <!-- id: t-20261025-09 --> otra\n";
    const p = parseTasks(dup, TODAY);
    expect(p.duplicateHeadings).toEqual(["P1"]);
    const doc = toDoc("ops/tasks", p);
    expect(doc.writable).toBe(false);
    expect(doc.reason_es).toBe("La lista tiene secciones repetidas; arréglala desde Claude Code");
  });

  test("a duplicated task id refuses writes on that task", () => {
    const dup = FIXTURE.replace("## P3 — Backlog\n", "## P3 — Backlog\n- [ ] <!-- id: t-20261022-03 --> copia\n");
    const p = parseTasks(dup, TODAY);
    try {
      buildDone(p, dup, "t-20261022-03", TODAY);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TaskError).code).toBe("duplicate_id");
    }
  });

  test("task text: no newlines, no comment markers, ≤ 300 chars", () => {
    expect(sanitizeTaskText("a\nb <!-- id: x --> c")).toBe("a b id: x c");
    expect(sanitizeTaskText("x".repeat(400)).length).toBe(300);
    expect(sanitizeTaskText("   ")).toBe("");
  });

  test("missing page → doc with exists:false", () => {
    const doc = toDoc("ops/tasks", null);
    expect(doc.exists).toBe(false);
    expect(doc.sections.map((s) => s.key)).toEqual(["P0", "P1", "P2", "P3", "Deferred", "Completed"]);
  });
});

// ---------------------------------------------------------------------------
// Write path with a fake gbrain (no real brain is touched): lock, retry, 409.
import { mock } from "bun:test";
import * as realGbrain from "../lib/gbrain.ts";

describe("mutateTasks against a fake gbrain", async () => {
  const fake = {
    content: FIXTURE,
    rev: 1,
    calls: [] as string[],
    /** Called right before an edit_page is checked: simulates another session writing. */
    outsideEdits: 0,
  };
  mock.module("../lib/gbrain.ts", () => ({
    ...realGbrain,
    callTool: async (tool: string, args: any) => {
      fake.calls.push(tool);
      await Bun.sleep(1);
      if (tool === "get_page") return { slug: args.slug, revision: `r${fake.rev}`, content: fake.content };
      if (tool === "edit_page") {
        if (fake.outsideEdits > 0) {
          fake.outsideEdits--;
          fake.content = fake.content.replace("Leer artículo pendiente", "Leer artículo pendiente ya");
          fake.rev++;
        }
        if (args.expected_revision !== `r${fake.rev}`) {
          throw new realGbrain.GbrainError(409, "revision_conflict", "conflict");
        }
        fake.content = applyEdits(fake.content, args.edits);
        fake.rev++;
        return { revision: `r${fake.rev}` };
      }
      throw new Error("unexpected tool " + tool);
    },
  }));
  const { mutateTasks: mutate } = await import("../lib/tasks.ts");
  const reset = () => { fake.content = FIXTURE; fake.rev = 1; fake.calls = []; fake.outsideEdits = 0; };

  test("done: one read, one edit", async () => {
    reset();
    const t = await mutate((p, c, today) => buildDone(p, c, "t-20261022-03", today));
    expect(t.section).toBe("Completed");
    expect(fake.calls).toEqual(["get_page", "edit_page"]);
    expect(sectionOf(fake.content, "t-20261022-03")).toBe("Completed");
  });

  test("an outside edit between read and write → re-read, retry, success", async () => {
    reset();
    fake.outsideEdits = 1;
    const t = await mutate((p, c) => buildMove(p, c, "t-20261022-03", "P0"));
    expect(t.section).toBe("P0");
    expect(fake.calls).toEqual(["get_page", "edit_page", "get_page", "edit_page"]);
    expect(fake.content).toContain("Leer artículo pendiente ya"); // the outside edit survived
  });

  test("two outside edits → 409 «recarga»", async () => {
    reset();
    fake.outsideEdits = 2;
    try {
      await mutate((p, c) => buildMove(p, c, "t-20261022-03", "P0"));
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.status).toBe(409);
      expect(e.code).toBe("conflict");
      expect(e.message_es).toBe("Otra sesión cambió las tareas; recarga");
    }
  });

  test("two quick done clicks are serialised: no lost edit", async () => {
    reset();
    const [a, b] = await Promise.all([
      mutate((p, c, today) => buildDone(p, c, "t-20261022-03", today)),
      mutate((p, c, today) => buildDone(p, c, "t-20261001-01", today)),
    ]);
    expect(a.section).toBe("Completed");
    expect(b.section).toBe("Completed");
    expect(fake.calls).toEqual(["get_page", "edit_page", "get_page", "edit_page"]);
    const p = parseTasks(fake.content, TODAY);
    expect(p.tasks.filter((t) => t.section === "Completed").length).toBe(3);
  });
});
