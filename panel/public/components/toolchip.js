// Chip de herramienta en el chat: «buscó «ejemplo»», «leyó projects/proyecto-a»…
// Las escrituras van en ámbar. Al pulsarlo se despliega la vista previa del resultado
// (como texto: nunca como HTML).

import { h } from '../app.js';

const FALLBACK = {
  search: 'buscó', query: 'buscó', get_page: 'leyó una página', list_pages: 'listó páginas',
  recall: 'consultó hechos', get_backlinks: 'miró quién enlaza', entity: 'miró una entidad',
  context_pack: 'reunió contexto', traverse_graph: 'recorrió enlaces', delta: 'miró cambios',
  get_recent_salience: 'miró lo reciente', resolve_slugs: 'resolvió nombres', whoami: 'se identificó',
  get_skill: 'leyó una habilidad', list_skills: 'listó habilidades',
  remember: 'propone guardar un hecho', capture: 'propone apuntar una nota', edit_page: 'intentó editar una página',
  add_timeline_entry: 'intentó añadir a la cronología',
};

/** t: {id, name, label_es, write, ok?, preview?}. ok undefined = aún esperando el resultado. */
export function toolChip(t) {
  const name = String(t.name || '').replace(/^mcp__cerebro__/, '');
  const label = t.label_es || FALLBACK[name] || name || 'herramienta';
  const state = t.ok === undefined || t.ok === null ? 'pending' : t.ok ? 'ok' : 'err';
  const preview = h('pre.tool-preview');
  preview.textContent = t.preview
    || (state === 'pending' ? 'Esperando el resultado…' : state === 'err' ? 'La herramienta devolvió un error.' : 'Sin vista previa guardada.');
  return h('details', { class: ['toolchip', t.write && 'write', 's-' + state], dataset: { id: t.id || '' } },
    h('summary', { title: name },
      h('span.tc-dot', { 'aria-hidden': 'true' }),
      h('span.tc-label', label),
      t.write && h('span.tc-w', 'escritura')),
    preview);
}

/** Marca el chip como terminado cuando llega su tool_result (label: nueva etiqueta, si cambia). */
export function settleToolChip(el, { ok, preview, label }) {
  el.classList.remove('s-pending');
  if (label) { const l = el.querySelector('.tc-label'); if (l) l.textContent = label; }
  el.classList.add(ok ? 's-ok' : 's-err');
  el.querySelector('.tool-preview').textContent = preview
    || (ok ? 'Hecho, sin vista previa.' : 'La herramienta devolvió un error.');
}
