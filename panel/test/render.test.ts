// Rendering must leave hostile Markdown inert; wikilinks resolve or get "missing" (spec §9).
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../lib/render.ts";

const KNOWN = new Set(["projects/proyecto-a", "projects/proyecto-b", "people/persona-ejemplo", "proyecto-a"]);
const r = (md: string) => renderMarkdown(md, KNOWN);

describe("inert output", () => {
  test("<script> becomes text", () => {
    const out = r("Hola <script>alert(1)</script> fin");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  test("block-level <script> becomes text", () => {
    const out = r("<script>\nalert(1)\n</script>\n");
    expect(out).not.toContain("<script");
  });

  test("<img onerror> becomes text", () => {
    const out = r('<img src=x onerror="alert(1)">');
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("&lt;img");
  });

  test("raw <a href=javascript:> becomes text", () => {
    expect(r('<a href="javascript:alert(1)">x</a>')).not.toMatch(/<a /i);
  });

  test("[x](javascript:…) keeps only the text", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
      const out = r(`[x](${href})`);
      expect(out).not.toMatch(/<a /i);
      expect(out.toLowerCase()).not.toContain("script:");
      expect(out).toContain("x");
    }
  });

  test("data: links are dropped", () => {
    const out = r("[clic](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)");
    expect(out).not.toMatch(/<a /i);
    expect(out).not.toContain("data:");
  });

  test("autolink with a bad scheme is dropped", () => {
    expect(r("<javascript:alert(1)>")).not.toMatch(/<a /i);
  });

  test("images become their alt text", () => {
    const out = r('![foto "rara"](http://evil.example/x.png)');
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("foto");
  });

  test("titles and hrefs are attribute-escaped", () => {
    const out = r('[x](https://example.com/?a=1&b="2" "t\\"itle")');
    expect(out).not.toMatch(/title="t"itle"/);
  });
});

describe("links", () => {
  test("external links open safely in a new tab", () => {
    expect(r("[ok](https://example.com/a)")).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">ok</a>',
    );
    expect(r("[m](mailto:a@b.es)")).toContain('href="mailto:a@b.es"');
  });

  test("wikilink with alias resolves to an in-app link", () => {
    expect(r("Ver [[projects/proyecto-a|Proyecto A]].")).toContain('<a href="#/p/projects/proyecto-a">Proyecto A</a>');
  });

  test("bare wikilink uses the slug as text", () => {
    expect(r("[[people/persona-ejemplo]]")).toContain('<a href="#/p/people/persona-ejemplo">people/persona-ejemplo</a>');
  });

  test("unknown target gets class=missing", () => {
    expect(r("[[people/nadie]]")).toContain('<a href="#/p/people/nadie" class="missing">');
  });

  test("wikilinks inside code are left alone", () => {
    const out = r("`[[projects/proyecto-a]]` y\n\n```\n[[projects/proyecto-b]]\n```");
    expect(out).not.toContain("#/p/projects/proyecto-a");
    expect(out).not.toContain("#/p/projects/proyecto-b");
    expect(out).toContain("[[projects/proyecto-a]]");
  });

  test("relative .md links to known pages become in-app links; unknown ones become text", () => {
    expect(r("[Proyecto B](projects/proyecto-b.md)")).toContain('<a href="#/p/projects/proyecto-b">Proyecto B</a>');
    expect(r("[X](nada/aqui.md)")).not.toMatch(/<a /i);
  });

  test("alias text with markdown characters does not break out", () => {
    const out = r("[[projects/proyecto-a|a*b_c]<script>]]");
    expect(out).not.toContain("<script");
  });
});
