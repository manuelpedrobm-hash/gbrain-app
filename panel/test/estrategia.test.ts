// La pestaña Estrategia: lectura de las tablas de ops/estrategia y HTML seguro (sin base de datos).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEstrategiaView, countByStatus, parseEstrategia, statusOf, tableUnder } from "../lib/estrategia.ts";
import { renderMarkdown } from "../lib/render.ts";

const MD = readFileSync(join(import.meta.dir, "fixtures", "estrategia.md"), "utf8");
const render = (m: string) => renderMarkdown(m, new Set(["ops/frentes"]));

describe("parseEstrategia", () => {
  const p = parseEstrategia(MD);

  test("los tres frentes activos salen de la tabla, sin los aparcados", () => {
    expect(p.frentes!.length).toBe(4);
    expect(p.activos!.map((f) => f.frente)).toEqual(["Proyecto Alfa", "Beca Beta (condicionado)", "Producto Gamma"]);
    expect(p.activos![0].accion).toBe("Activo 1");
  });

  test("la propuesta consta como pendiente de __NOMBRE__", () => {
    expect(p.pendienteDe__NOMBRE__).toBe(true);
  });

  test("hoja de ruta: estado de cada fila, sin negritas ni wikilinks", () => {
    const r = p.roadmap!;
    expect(r.length).toBe(6);
    expect(r[0]).toEqual({ status: "HECHO", text: "Salud del sistema" });
    expect(r[1].text).toBe("Inventario de frentes (ops/frentes)");
    expect(r.find((i) => i.status === "NECESITA TU SI")!.text).toBe("Clave de Voyage para buscar por significado");
    expect(countByStatus(r)).toEqual({ "HECHO": 2, "EN CURSO": 1, "NECESITA TU SI": 1, "IDEA": 2 });
  });

  test("decisiones abiertas", () => {
    expect(p.decisiones).toEqual([
      { decision: "Alfa", pregunta: "Con analisis o producto" },
      { decision: "Empresa propia", pregunta: "Jurisdiccion" },
    ]);
  });

  test("las etiquetas de estado ignoran mayúsculas y tildes", () => {
    expect(statusOf("necesita tu sí")).toBe("NECESITA TU SI");
    expect(statusOf("**Hecho**")).toBe("HECHO");
    expect(statusOf("quizá")).toBeNull();
  });
});

describe("si el parseo falla, no se inventa nada", () => {
  test("una etiqueta de estado desconocida deja la hoja de ruta en null", () => {
    const md = MD.replace("| EN CURSO | Radar de plazos |", "| PENSANDOLO | Radar de plazos |");
    expect(parseEstrategia(md).roadmap).toBeNull();
    expect(parseEstrategia(md).frentes).not.toBeNull(); // el resto sigue leyéndose
  });

  test("sin tablas todo es null y la vista conserva el texto", () => {
    const v = buildEstrategiaView("# Estrategia\n\nSolo texto.", render);
    expect(v.ok).toBe(true);
    expect(v.roadmap).toBeNull();
    expect(v.frentes).toBeNull();
    expect(v.markdown).toContain("Solo texto.");
  });

  test("tableUnder no salta a una tabla de otra sección", () => {
    expect(tableUnder("## A\n\ntexto\n\n## B\n\n| x | y |\n|---|---|\n| 1 | 2 |\n", "a")).toBeNull();
  });

  test("página inexistente: ok false con mensaje en español", () => {
    const v = buildEstrategiaView(null, render);
    expect(v.ok).toBe(false);
    expect(v.error_es).toContain("ops/estrategia");
  });

  test("si dice «decidido por __NOMBRE__» sin reservas, deja de estar pendiente", () => {
    expect(parseEstrategia("Frentes decididos por __NOMBRE__ el 5 nov.").pendienteDe__NOMBRE__).toBe(true); // «decididos» no es la frase exacta
    expect(parseEstrategia("Propuesta decidido por __NOMBRE__.").pendienteDe__NOMBRE__).toBe(false);
  });
});

describe("HTML de la página", () => {
  const v = buildEstrategiaView(MD, render);

  test("el <script> del texto sale como texto, nunca como etiqueta", () => {
    expect(v.html).not.toContain("<script");
    expect(v.html).toContain("&lt;script&gt;");
  });

  test("los wikilinks son enlaces internos y las tablas se renderizan", () => {
    expect(v.html).toContain('href="#/p/ops/frentes"');
    expect(v.html).toContain("<table");
  });
});
