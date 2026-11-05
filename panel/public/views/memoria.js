// Memoria: las páginas del cerebro por carpeta (tipo).
// Personas y Proyectos como tarjetas (con «frío» si hace tiempo que no aparecen);
// Fuentes, Conceptos y Notas como lista; Conversaciones agrupadas por mes.

import { h, get, pageHead, emptyState, icon, rel, fold, fmtDay, parseDay, plainMd } from '../app.js';
import { TYPES, TYPE_ORDER, typeLabel, typeChip, coldBadge, tagChip, typeClass } from '../components/chips.js';
import { openPalette } from '../components/palette.js';

export function title(r) {
  const f = r?.query.get('f');
  return f ? typeLabel(f, true) : 'Memoria';
}

let state = null;
let filterText = '';

function params(r) {
  const tag = r.query.get('tag') || '';
  let f = r.query.get('f') || '';
  if (!f && !tag) f = 'person';
  return { f, tag };
}

export async function mount(el, r) {
  const { f, tag } = params(r);
  if (state?.key !== `${f}|${tag}`) filterText = '';
  const data = await get(`/api/pages?type=${encodeURIComponent(f)}&tag=${encodeURIComponent(tag)}`);
  state = { key: `${f}|${tag}`, f, tag, data };
  draw(el);
}
export const refresh = mount;

function folderChips(counts, active, tag) {
  const keys = [...TYPE_ORDER.filter((t) => counts[t] != null),
    ...Object.keys(counts).filter((t) => !TYPE_ORDER.includes(t)).sort((a, b) => counts[b] - counts[a])];
  return h('nav.folders', { 'aria-label': 'Carpetas' },
    keys.map((t) => h('a', {
      class: ['chip', 'folder', typeClass(t), t === active && 'active'],
      href: '#/memoria?f=' + encodeURIComponent(t) + (tag ? '&tag=' + encodeURIComponent(tag) : ''),
      'aria-current': t === active ? 'page' : null,
    }, typeLabel(t, true), h('span.count', String(counts[t])))),
    h('a.chip.folder.facts', { href: '#/hechos' }, 'Hechos', icon('arrow')));
}

function matches(p) {
  if (!filterText) return true;
  const q = fold(filterText);
  return [p.title, p.slug, ...(p.tags || [])].some((x) => fold(x).includes(q));
}

function draw(el) {
  const { f, tag, data } = state;
  const counts = data.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);
  const pages = data.pages || [];

  const filter = h('input.filter', {
    type: 'search', placeholder: 'Filtrar esta lista…', 'aria-label': 'Filtrar esta lista', value: filterText,
    oninput: (e) => { filterText = e.target.value; renderList(); },
  });
  const listSlot = h('div.list-slot');
  const renderList = () => listSlot.replaceChildren(listFor(f, tag, pages.filter(matches)));

  el.replaceChildren(
    pageHead('Memoria', `Lo que sabe el cerebro: ${total} páginas.`,
      h('button.btn', { type: 'button', onclick: () => openPalette() }, icon('search'), 'Buscar en todo', h('kbd', '⌘K'))),
    folderChips(counts, f, tag),
    h('div.list-tools',
      tag && h('span.chip.tag.active', '#' + tag,
        h('a.chip-x', { href: f ? '#/memoria?f=' + encodeURIComponent(f) : '#/memoria', 'aria-label': 'Quitar etiqueta' }, '×')),
      filter,
      h('span.muted.small', `${pages.length} ${f ? typeLabel(f, true).toLowerCase() : 'páginas'}`)),
    listSlot);
  renderList();
}

function listFor(f, tag, pages) {
  if (!pages.length) {
    if (filterText) return emptyState('Nada coincide con el filtro', `Ninguna página de esta carpeta contiene «${filterText}» en el título, el slug o las etiquetas. Prueba ⌘K para buscar en todo el texto.`);
    if (tag) return emptyState('Sin páginas con esa etiqueta', `Ninguna página ${f ? `de tipo «${typeLabel(f)}» ` : ''}tiene la etiqueta #${tag}.`);
    return emptyState(`No hay ${typeLabel(f, true).toLowerCase()}`, `El cerebro no tiene páginas de tipo «${typeLabel(f)}». Se crean al importar fuentes o desde Claude.`);
  }
  if (f === 'person' || f === 'project') return h('div.cards', pages.map(entityCard));
  if (f === 'conversation') return conversations(pages);
  return h('ul.rows.list', pages.map(listRow));
}

function lastTouchText(p) {
  if (!p.lastTouch) return 'sin actividad registrada';
  return 'tocado ' + rel(p.lastTouch);
}

function entityCard(p) {
  return h('a', { class: ['card', 'entity', p.cold && 'is-cold'], href: '#/p/' + p.slug },
    h('div.entity-head', h('h3.entity-title', p.title || p.slug), p.cold && coldBadge()),
    h('p.mono.muted.small.clip', p.slug),
    h('p.entity-stats',
      h('span', `${p.inbound ?? 0} ${Number(p.inbound) === 1 ? 'enlace' : 'enlaces'}`),
      h('span', `${p.facts ?? 0} ${Number(p.facts) === 1 ? 'hecho' : 'hechos'}`)),
    (p.tags || []).length > 0 && h('div.entity-tags', p.tags.slice(0, 4).map((t) => tagChip(t, { link: false })),
      p.tags.length > 4 && h('span.muted.small', `+${p.tags.length - 4}`)),
    h('p.entity-foot.muted.small', lastTouchText(p)));
}

function listRow(p) {
  return h('li.row',
    h('div.row-main',
      h('p.row-text', h('a.slug-link', { href: '#/p/' + p.slug }, p.title || p.slug), p.cold && [' ', coldBadge()]),
      h('div.row-meta',
        !TYPES[p.type] || state.tag ? typeChip(p.type) : null,
        h('span.mono.muted.clip', p.slug),
        p.inbound != null && h('span.muted', `${p.inbound} ${Number(p.inbound) === 1 ? 'enlace' : 'enlaces'}`),
        p.facts ? h('span.muted', `${p.facts} ${Number(p.facts) === 1 ? 'hecho' : 'hechos'}`) : null,
        p.lastTouch && h('span.muted', lastTouchText(p)),
        (p.tags || []).slice(0, 3).map((t) => tagChip(t)))));
}

function conversations(pages) {
  const groups = new Map();
  for (const p of pages) {
    const d = parseDay(p.date);
    const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'sin-fecha';
    if (!groups.has(key)) groups.set(key, { d, items: [] });
    groups.get(key).items.push(p);
  }
  return h('div.conv-months', [...groups.entries()].map(([key, g]) => {
    const label = g.d ? new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' }).format(g.d) : 'Sin fecha';
    return h('details.subgroup.month', { open: true },
      h('summary', label.charAt(0).toUpperCase() + label.slice(1), h('span.count', String(g.items.length))),
      h('ul.rows.list', g.items.map((p) => h('li.row',
        h('div.row-main',
          h('p.row-text', h('a.slug-link', { href: '#/p/' + p.slug }, plainMd(p.title) || p.slug)),
          h('div.row-meta',
            p.date && h('span.muted', fmtDay(p.date)),
            p.messages != null && p.messages !== '' && h('span.muted', `${p.messages} mensajes`)))))));
  }));
}
