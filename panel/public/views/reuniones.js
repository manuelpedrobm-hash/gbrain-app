// Reuniones (#/reuniones): todas las reuniones del cerebro, de más reciente a más antigua.
// Cada una puede tener nota de preparación y/o transcripción (reuniones/transcripciones/…).
// Solo lectura; se abren como página (#/p/<slug>). Transcripciones: ops/reuniones-sync.py.

import { h, get, pageHead, card, emptyState, slugLink } from '../app.js';

export const title = 'Reuniones';

export async function mount(el) {
  const { reuniones } = await get('/api/reuniones');
  const head = pageHead('Reuniones', 'Preparación, notas y transcripciones de todas las reuniones. Solo lectura.');
  if (!reuniones.length) {
    el.replaceChildren(head, emptyState('Todavía no hay reuniones', 'Las notas viven en reuniones/ del cerebro.'));
    return;
  }
  const fila = (r) => h('li', slugLink(r.slug, r.title),
    h('span.muted.small', ' · ' + (r.date || 'sin fecha') + (r.estado ? ' · ' + r.estado : '')));
  const tr = reuniones.filter((r) => r.kind === 'transcripcion');
  const notas = reuniones.filter((r) => r.kind !== 'transcripcion');
  const hoy = new Date().toISOString().slice(0, 10);
  const proximas = notas.filter((r) => r.date && r.date >= hoy).reverse();
  const pasadas = notas.filter((r) => !(r.date && r.date >= hoy));
  const bloques = [
    [`Próximas`, proximas], [`Transcripciones`, tr], [`Notas y preparación (pasadas o sin fecha)`, pasadas],
  ].filter(([, l]) => l.length).map(([t, l]) => card({ title: t, count: l.length }, h('ul.rows', l.map(fila))));
  el.replaceChildren(head, ...bloques);
}
export const refresh = mount;
