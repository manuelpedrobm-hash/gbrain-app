// Estrategia (#/estrategia): la página ops/estrategia del cerebro, solo lectura.
// Arriba, los tres frentes propuestos y si __NOMBRE__ ya decidió; luego la hoja de ruta
// con insignias de color por estado; luego las decisiones abiertas y la página
// completa renderizada en el servidor (lib/render.ts). «Proponer cambio» no edita
// la página: abre el formulario «Recordar» ya relleno, y un hecho guardado por ahí
// pasa por la misma lista cerrada de escrituras (remember) y queda en audit.jsonl.

import { h, raw, get, pageHead, card, emptyState, icon, slugLink } from '../app.js';
import { openRemember } from './hechos.js';

export const title = 'Estrategia';

const STATUS_LABEL = { 'HECHO': 'Hecho', 'EN CURSO': 'En curso', 'NECESITA TU SI': 'Necesita tu sí', 'IDEA': 'Idea' };
const STATUS_CLASS = { 'HECHO': 'st-done', 'EN CURSO': 'st-doing', 'NECESITA TU SI': 'st-ask', 'IDEA': 'st-idea' };
const STATUS_ORDER = ['NECESITA TU SI', 'EN CURSO', 'HECHO', 'IDEA'];

let filter = 'all';

/** Abre «Recordar» con la propuesta a medio escribir; no guarda nada hasta que pulses Guardar. */
export function proponerCambio(sobre) {
  return openRemember({
    entity: 'ops/estrategia',
    kind: 'fact',
    fact: sobre ? `Propuesta de cambio a la estrategia (${sobre}): ` : 'Propuesta de cambio a la estrategia: ',
    provenance: 'propuesta desde la pestaña Estrategia del panel, escrita por __NOMBRE__',
  });
}

export function statusBadge(status) {
  return h('span', { class: ['badge', STATUS_CLASS[status] || 'st-idea'] }, STATUS_LABEL[status] || status);
}

export async function mount(el) {
  const data = await get('/api/estrategia');
  draw(el, data);
}
export const refresh = mount;

function draw(el, d) {
  const head = pageHead('Estrategia', 'Lo que se propone y en qué punto está. Solo lectura: los cambios se proponen, no se escriben aquí.',
    h('button.btn.primary', { type: 'button', onclick: () => proponerCambio() }, icon('pen'), 'Proponer cambio'));
  if (!d.ok) {
    el.replaceChildren(head, emptyState('Todavía no hay página de estrategia',
      d.error_es || 'No encuentro la página ops/estrategia en el cerebro.'));
    return;
  }
  el.replaceChildren(head, frentesCard(d), roadmapCard(d, el), decisionesCard(d), pageCard(d));
}

function frentesCard(d) {
  const pend = d.pendienteDe__NOMBRE__;
  const state = h('span', { class: ['badge', pend ? 'st-ask' : 'st-done'] }, pend ? 'Pendiente de __NOMBRE__' : 'Decidido por __NOMBRE__');
  const note = pend
    ? 'Es una propuesta: nada de esto está decidido. Lo decides tú.'
    : 'Marcado como decidido en la página.';
  return card({ title: 'Los 3 frentes propuestos', actions: state, note, cls: 'est-frentes' },
    d.activos
      ? h('ol.est-list', d.activos.map((f) => h('li',
        h('span.est-tag', f.accion),
        h('div.est-main', h('strong', f.frente), f.detalle && h('p.muted.small', f.detalle)))))
      : h('p.muted.small', 'No pude leer la tabla de frentes de la página. Mira la página completa más abajo.'),
    h('p.small.est-link', 'Inventario completo: ', slugLink('ops/frentes', 'Frentes')));
}

function roadmapCard(d, root) {
  const items = d.roadmap;
  if (!items) {
    return card({ title: 'Hoja de ruta', note: 'No pude leer la tabla; este es el texto de la página tal cual.' },
      h('pre.pre.est-raw', d.markdown));
  }
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  const chips = h('nav.chip-row', { 'aria-label': 'Filtrar por estado' },
    h('button', { type: 'button', class: ['chip', 'folder', filter === 'all' && 'active'], 'aria-pressed': filter === 'all' ? 'true' : 'false',
      onclick: () => { filter = 'all'; draw(root, d); } }, `Todo (${items.length})`),
    STATUS_ORDER.filter((s) => counts[s]).map((s) => h('button', {
      type: 'button', class: ['chip', 'folder', filter === s && 'active'], 'aria-pressed': filter === s ? 'true' : 'false',
      onclick: () => { filter = s; draw(root, d); },
    }, `${STATUS_LABEL[s]} (${counts[s]})`)));
  const shown = filter === 'all' ? items : items.filter((i) => i.status === filter);
  const groups = STATUS_ORDER.map((s) => [s, shown.filter((i) => i.status === s)]).filter(([, l]) => l.length);
  return card({ title: 'Hoja de ruta', count: items.length, cls: 'est-roadmap' }, chips,
    groups.map(([s, list]) => h('section.est-group',
      h('h3.est-group-title', statusBadge(s), h('span.muted.small', STATUS_HINT[s])),
      h('ul.rows.tight', list.map((i) => h('li.est-item',
        h('span.est-text', i.text),
        h('button.btn.ghost.small.est-prop', {
          type: 'button', 'aria-label': `Proponer cambio sobre: ${i.text}`, title: 'Proponer cambio sobre esto',
          onclick: () => proponerCambio(i.text.slice(0, 60)),
        }, icon('pen'))))))));
}

const STATUS_HINT = {
  'NECESITA TU SI': 'espera tu decisión',
  'EN CURSO': 'se está haciendo',
  'HECHO': 'terminado',
  'IDEA': 'sin empezar',
};

function decisionesCard(d) {
  if (!d.decisiones) return null;
  return card({ title: 'Decisiones abiertas', count: d.decisiones.length },
    h('ul.rows.tight', d.decisiones.map((x) => h('li.est-dec', h('strong', x.decision), h('span.muted', ' · ' + x.pregunta)))));
}

function pageCard(d) {
  return card({ title: 'La página completa', note: 'Texto de ops/estrategia en el cerebro. ' },
    h('article.prose', raw(d.html)),
    h('p.small', slugLink('ops/estrategia', 'Abrir como página del cerebro')));
}
