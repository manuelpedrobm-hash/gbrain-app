// Página del cerebro (#/p/<slug>): cabecera con chips, cuerpo renderizado en el servidor
// (marked + wikilinks + lista blanca de URLs) y un carril con hechos, cronología,
// quién enlaza aquí, a dónde enlaza y el minigrafo local.

import {
  h, raw, get, card, emptyState, icon, rel, fmtDay, copyText, askChat, inlineText, plainMd, ApiError,
} from '../app.js';
import { typeChip, typeLabel, coldBadge, tagChip, chip } from '../components/chips.js';
import { miniGraph } from '../components/minigraph.js';
import { openPalette } from '../components/palette.js';
import { factRow, openRemember } from './hechos.js';

const SLUG_RE = /^[a-z0-9][a-z0-9._/-]{0,200}$/;

let page = null;
let showConv = false;
let tlAll = false;

export function title(r) { return page?.slug === r?.rest ? page.title || r.rest : r?.rest || 'Página'; }

export async function mount(el, r) {
  const slug = r.rest;
  if (!SLUG_RE.test(slug)) {
    el.replaceChildren(emptyState('Ese nombre de página no es válido', `«${slug}» no parece un slug del cerebro (minúsculas, números, «/», «-», «.» y «_»).`));
    return;
  }
  if (page?.slug !== slug) { tlAll = false; }
  try {
    page = await get('/api/page?slug=' + encodeURIComponent(slug));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) { page = null; el.replaceChildren(notFound(slug)); return; }
    throw e;
  }
  document.title = `${page.title || page.slug} · Cerebro`;
  draw(el);
}
export const refresh = mount;

function notFound(slug) {
  return h('div.view-narrow',
    emptyState('Esta página no existe todavía',
      `Algún enlace apunta a «${slug}», pero no hay ninguna página con ese nombre ni con ese alias. Los enlaces rotos salen en rojo discontinuo.`,
      h('div.btn-row',
        h('button.btn', { type: 'button', onclick: () => openPalette(slug.split('/').pop().replace(/[-_.]/g, ' ')) }, icon('search'), 'Buscar algo parecido'),
        h('button.btn.ghost', { type: 'button', onclick: () => history.back() }, 'Volver'))));
}

/** Claves de frontmatter que no merece la pena enseñar como chips. */
const BULKY = new Set(['title', 'type', 'tags', 'aliases', 'content', 'body', 'messages_json', 'transcript', 'summary', 'description']);

function draw(el) {
  const p = page;
  const chips = (p.chips || []).filter((c) => c && c.k && !BULKY.has(c.k) && String(c.v ?? '').length <= 80);

  const head = h('header.page-header',
    h('nav.crumbs', { 'aria-label': 'Ruta' },
      h('a', { href: '#/memoria' }, 'Memoria'), h('span', { 'aria-hidden': 'true' }, '›'),
      h('a', { href: '#/memoria?f=' + encodeURIComponent(p.type || '') }, typeLabel(p.type, true))),
    h('h1.page-title', p.title || p.slug),
    h('div.chips',
      typeChip(p.type),
      h('span.chip.slug-chip.mono', p.slug,
        h('button.chip-btn', { type: 'button', 'aria-label': 'Copiar slug', title: 'Copiar slug', onclick: () => copyText(p.slug) }, icon('copy'))),
      p.cold && coldBadge(),
      (p.aliases || []).length > 0 && h('span.chip.muted', { title: 'Alias' }, 'también: ' + p.aliases.join(', ')),
      (p.tags || []).map((t) => tagChip(t)),
      chips.map((c) => chip(`${c.k}: ${c.v}`, 'muted')),
      p.ingested_via && chip(`entró por ${p.ingested_via}`, 'muted'),
      p.lastTouch && h('span.muted.small', 'tocada ' + rel(p.lastTouch))),
    h('div.btn-row',
      h('button.btn.small', { type: 'button', onclick: () => askChat(`Sobre [[${p.slug}]]: `) }, icon('chat'), 'Preguntar en el chat'),
      h('button.btn.small', { type: 'button', onclick: () => openRemember({ entity: p.slug }) }, icon('plus'), 'Recordar algo sobre esto')));

  const body = p.html && String(p.html).trim()
    ? h('article.prose', raw(p.html))
    : emptyState('Esta página no tiene texto', 'Solo tiene metadatos, enlaces o hechos. El texto se escribe desde Claude o al importar fuentes.');

  el.replaceChildren(h('div.page-layout',
    h('div.page-main', head, body),
    h('aside.page-rail', factsCard(), timelineCard(), backlinksCard(), outlinksCard(), graphCard())));
}

function factsCard() {
  const facts = page.facts || [];
  return card({ title: 'Hechos sobre esto', count: facts.length || null },
    facts.length
      ? h('ul.rows.tight', facts.map((f) => factRow({ ...f, entity_slug: page.slug }, { hideEntity: true, compact: true })))
      : h('p.muted.small', 'No hay hechos guardados sobre esta página. Usa «Recordar algo sobre esto».'));
}

function timelineCard() {
  const tl = page.timeline || [];
  const shown = tlAll ? tl : tl.slice(0, 5);
  return card({ title: 'Cronología', count: tl.length || null },
    tl.length
      ? [
        h('ol.timeline', shown.map((t) => h('li',
          h('span.tl-date', fmtDay(t.date)),
          h('p.tl-sum', inlineText(t.summary)),
          t.detail && h('p.tl-detail', inlineText(plainMd(t.detail))),
          t.source && h('p.tl-src.muted', t.source)))),
        tl.length > 5 && h('button.btn.ghost.small', {
          type: 'button',
          onclick: (e) => { tlAll = !tlAll; e.currentTarget.closest('.card').replaceWith(timelineCard()); },
        }, tlAll ? 'Ver menos' : `Ver más (${tl.length - 5})`),
      ]
      : h('p.muted.small', 'Sin entradas de cronología.'));
}

function backlinksCard() {
  const bl = page.backlinks || [];
  return card({ title: 'Enlazan aquí', count: bl.length || null },
    bl.length
      ? h('ul.links', bl.map((b) => h('li',
        h('div.link-head', typeChip(b.from_type), h('a.slug-link', { href: '#/p/' + b.from_slug }, plainMd(b.from_title) || b.from_slug),
          b.link_type && b.link_type !== 'mentions' && h('span.muted.small', b.link_type)),
        b.context && h('p.link-ctx', plainMd(b.context)))))
      : h('p.muted.small', 'Ninguna página enlaza aquí todavía.'));
}

function outlinksCard() {
  const ol = page.outlinks || [];
  return card({ title: 'Enlaza a', count: ol.length || null },
    ol.length
      ? h('ul.links', ol.map((o) => h('li',
        h('div.link-head', typeChip(o.to_type), h('a.slug-link', { href: '#/p/' + o.to_slug }, plainMd(o.to_title) || o.to_slug)))))
      : h('p.muted.small', 'Esta página no enlaza a otras.'));
}

// El servidor quita las conversaciones del grafo salvo que se pidan con conv=1
// (así los 40 nodos son páginas de verdad). Al activar el interruptor se pide ese
// grafo una vez y se guarda para esta página.
let convGraph = null; // { slug, graph }

function graphCard() {
  const g = page.graph;
  if (!g || !(g.nodes || []).length) return null;
  const slug = page.slug;
  const slot = h('div.graph-slot');
  const paint = async () => {
    let graph = g;
    if (showConv) {
      if (convGraph?.slug !== slug) {
        slot.replaceChildren(h('p.muted.small', 'Cargando conversaciones…'));
        try {
          const r = await get('/api/page?slug=' + encodeURIComponent(slug) + '&conv=1');
          convGraph = { slug, graph: r.graph };
        } catch { convGraph = null; }
      }
      if (page?.slug !== slug) return; // el usuario ya cambió de página
      graph = convGraph?.graph || g;
    }
    const svgEl = miniGraph(graph, slug, { conversations: showConv });
    const noConv = showConv && !(graph.nodes || []).some((n) => n.type === 'conversation' && n.slug !== slug);
    // replaceChildren nativo convierte false en el texto «false»: solo nodos reales.
    slot.replaceChildren(...[
      svgEl || h('p.muted.small', showConv
        ? 'Sin vecinos a uno o dos saltos.'
        : 'Sin páginas vecinas (sin contar conversaciones). Actívalas para verlas.'),
      noConv && h('p.muted.small', 'Ninguna conversación enlaza con estas páginas.'),
    ].filter(Boolean));
  };
  paint();
  return card({ title: 'Mapa local', note: 'Páginas a uno y dos saltos.' },
    slot,
    h('label.check-inline',
      h('input', { type: 'checkbox', checked: showConv, onchange: (e) => { showConv = e.target.checked; paint(); } }),
      'Incluir conversaciones'));
}
