// lib/render.ts — server-side Markdown → safe HTML (spec §4.5).
//
// Rules:
//  - raw HTML (block or inline) is shown as escaped text, never interpreted;
//  - links survive only for http:, https:, mailto: and in-app "#/" URLs; any
//    other scheme (javascript:, data:, vbscript:, file:…) becomes plain text;
//    external links open in a new tab with rel="noopener noreferrer";
//  - images become their escaped alt text (no remote loads, CSP img-src 'self');
//  - [[slug]] / [[slug|Alias]] become in-app links (#/p/slug); a target missing
//    from the slug+alias set gets class="missing";
//  - relative Markdown links to brain pages ([x](people/foo.md)) become in-app
//    links when the slug exists, otherwise plain text;
//  - with { externalLinks: "text" } (chat replies), http(s)/mailto links are
//    not clickable: the link text is followed by the full URL as plain text, so
//    a model-written reply cannot hide brain data in a link behind innocent
//    words (security audit 2026-10-26). Brain pages keep clickable links.

import { Marked, type Tokens } from "../vendor/marked.esm.js";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

const WIKILINK = /\[\[([a-z0-9][a-z0-9._\/-]*)(?:\|([^\]]+))?\]\]/g;
const SLUG_RE = /^[a-z0-9][a-z0-9._\/-]{0,200}$/;

/** Backslash-escapes characters that would change Markdown meaning inside link text. */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_\[\]<>]/g, (c) => "\\" + c);
}

/**
 * Rewrites wikilinks to Markdown links, outside fenced code blocks and inline
 * code spans (so code samples keep their literal brackets).
 */
export function preprocessWikilinks(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(WIKILINK, (_m, slug: string, alias?: string) => {
      const text = (alias ?? slug).trim() || slug;
      return `[${mdEscape(text)}](#/p/${slug})`;
    });
  }
  return parts.join("");
}

// The known-slug set for the render in progress. marked parses synchronously,
// so a module-level variable is safe here.
let currentKnown: Set<string> = new Set();
let externalAsText = false;

function isKnown(slug: string): boolean {
  return currentKnown.has(slug) || currentKnown.has(slug.toLowerCase());
}

function safeHref(raw: string): { kind: "external" | "internal" | "none"; href: string; slug?: string } {
  const href = (raw ?? "").trim();
  // Control characters or whitespace inside a URL are a classic scheme-smuggling trick.
  if (!href || /[\u0000-\u001f\u007f\s]/.test(href)) return { kind: "none", href: "" };
  if (/^(https?:\/\/|mailto:)/i.test(href)) return { kind: "external", href };
  if (href.startsWith("#/")) {
    const m = /^#\/p\/(.+)$/.exec(href);
    if (m) {
      let slug = m[1];
      try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
      return { kind: "internal", href, slug };
    }
    return { kind: "internal", href };
  }
  // Relative link to a brain page, e.g. people/foo.md or ./people/foo
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) {
    const slug = href.replace(/^\.\//, "").replace(/\.md$/i, "").replace(/#.*$/, "");
    if (SLUG_RE.test(slug) && isKnown(slug)) return { kind: "internal", href: `#/p/${slug}`, slug };
  }
  return { kind: "none", href: "" };
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML in the source is shown, never run.
    html(token: Tokens.HTML | Tokens.Tag): string {
      const text = escapeHtml(token.text);
      return (token as Tokens.HTML).block ? `<p>${text}</p>\n` : text;
    },
    link(this: any, token: Tokens.Link): string {
      const inner = this.parser.parseInline(token.tokens);
      const h = safeHref(token.href);
      if (h.kind === "none") return inner;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      if (h.kind === "external") {
        if (externalAsText) {
          // Autolinks repeat the URL as their text; show it once.
          const sameText = token.text === h.href || token.text === h.href.replace(/^mailto:/i, "");
          const url = `<span class="ext-url" title="Enlace externo: cópialo si te fías de él">${escapeHtml(h.href)}</span>`;
          return sameText ? url : `${inner} (${url})`;
        }
        return `<a href="${escapeHtml(h.href)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`;
      }
      const missing = h.slug !== undefined && !isKnown(h.slug) ? ` class="missing"` : "";
      return `<a href="${escapeHtml(h.href)}"${title}${missing}>${inner}</a>`;
    },
    image(token: Tokens.Image): string {
      return escapeHtml(token.text ?? "");
    },
  },
});

export interface RenderOptions {
  /** "link" (default, brain pages) or "text" (chat replies: external URLs shown, not clickable). */
  externalLinks?: "link" | "text";
}

/** Renders Markdown (brain pages, chat replies) to HTML that is safe to insert. */
export function renderMarkdown(md: string, known: Set<string>, opts: RenderOptions = {}): string {
  currentKnown = known ?? new Set();
  externalAsText = opts.externalLinks === "text";
  try {
    return marked.parse(preprocessWikilinks(String(md ?? "")), { async: false }) as string;
  } catch {
    return `<pre>${escapeHtml(String(md ?? ""))}</pre>`;
  } finally {
    currentKnown = new Set();
    externalAsText = false;
  }
}
