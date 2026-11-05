// Informes (#/informes): los informes de trabajo guardados como páginas informes/<tema>/<nombre>
// del cerebro, agrupados por tema. Solo lectura; cada uno se abre como página (#/p/<slug>).
// Se crean con el script de sincronización que prefieras (ver README).

import { h, get, pageHead, card, emptyState, slugLink } from '../app.js';

export const title = 'Informes';

const TEMAS = {};   // opcional: { 'slug-del-tema': 'Título que se muestra' }

export async function mount(el) {
  const { informes } = await get('/api/informes');
  const head = pageHead('Informes', 'Informes de trabajo, de más reciente a más antiguo. Solo lectura.');
  if (!informes.length) {
    el.replaceChildren(head, emptyState('Todavía no hay informes', 'Guarda páginas en informes/<tema>/<nombre> del cerebro y ejecuta «gbrain sync»'));
    return;
  }
  const grupos = new Map();
  for (const i of informes) { if (!grupos.has(i.tema)) grupos.set(i.tema, []); grupos.get(i.tema).push(i); }
  el.replaceChildren(head, ...[...grupos].map(([tema, list]) =>
    card({ title: TEMAS[tema] || tema, count: list.length },
      h('ul.rows', list.map((i) => h('li',
        slugLink(i.slug, i.title),
        h('span.muted.small', ' · ' + (i.date || 'sin fecha') + ' · ' + Math.max(1, Math.round(i.chars / 1000)) + ' mil caracteres')))))));
}
export const refresh = mount;
