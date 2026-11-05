// Hechos (#/hechos): los datos sueltos que recuerda el cerebro.
// Recordar · Olvidar (con motivo) · Corregir (guarda el nuevo y luego retira el viejo,
// para que nunca haya un momento sin ninguno activo). Cada escritura se verifica
// releyendo la base antes de decir «guardado ✓».

import {
  h, get, post, pageHead, card, emptyState, icon, rel, stamp, slugLink, inlineText, refreshView, go, fold,
} from '../app.js';
import { KINDS, kindChip } from '../components/chips.js';
import { confirmDialog, formDialog } from '../components/confirm.js';
import { getIndex } from '../components/palette.js';
import { toast } from '../components/toast.js';

export const title = 'Hechos';

const SLUG_RE = /^[a-z0-9][a-z0-9._/-]{0,200}$/;
const KIND_OPTIONS = Object.entries(KINDS).map(([k, [one]]) => [k, one.charAt(0).toUpperCase() + one.slice(1)]);

async function entityOptions() {
  try {
    const idx = await getIndex();
    return idx.pages.filter((p) => ['person', 'project', 'concept'].includes(p.y))
      .sort((a, b) => a.t.localeCompare(b.t, 'es'))
      .map((p) => ({ value: p.s, label: p.t }));
  } catch {
    return [];
  }
}

/** Si escribes el título de una página («Ana García»), lo cambia por su slug. */
function resolveEntity(v, datalist) {
  if (SLUG_RE.test(v)) return v;
  const f = fold(v);
  return datalist.find((o) => fold(o.label) === f)?.value || v;
}

function factFields(prefill, datalist, provenanceDefault) {
  return [
    { name: 'fact', label: 'Qué recordar', type: 'textarea', rows: 3, value: prefill.fact || '', required: true, maxlength: 500, autofocus: !prefill.fact,
      hint: 'Una frase clara. Máximo 500 caracteres.' },
    { name: 'entity', label: 'Sobre quién o qué', optional: true, value: prefill.entity || '', placeholder: 'people/nombre, projects/x…',
      datalist, spellcheck: 'false', resolve: (v) => resolveEntity(v, datalist), pattern: SLUG_RE, patternMsg: 'La entidad debe ser un slug: minúsculas, números, «/», «-», «.» o «_».' },
    { name: 'kind', label: 'Tipo', type: 'select', options: KIND_OPTIONS, value: prefill.kind || 'fact' },
    { name: 'provenance', label: 'De dónde sale', value: prefill.provenance || provenanceDefault, required: true, maxlength: 300,
      hint: 'Obligatorio: así sabrás más adelante por qué el cerebro cree esto.' },
  ];
}

function bodyOf(v) {
  const b = { fact: v.fact, kind: v.kind, provenance: v.provenance };
  if (v.entity) b.entity = v.entity;
  return b;
}

/** Formulario «Recordar». prefill: {fact, entity, kind, provenance} */
export async function openRemember(prefill = {}) {
  const datalist = await entityOptions();
  const saved = await formDialog({
    title: 'Recordar',
    intro: 'Guarda un hecho en la memoria del cerebro. Gratis: no usa el modelo.',
    submitLabel: 'Guardar',
    fields: factFields(prefill, datalist, `panel web, ${stamp()}, escrito por __NOMBRE__`),
    onSubmit: async (v) => {
      const r = await post('/api/facts', bodyOf(v));
      if (r?.status === 'duplicate') toast(`Ya lo sabía: es el hecho #${r.id}`, { kind: 'warn' });
      else if (r?.verified) toast(`guardado ✓ (hecho #${r.id})`);
      else toast('Guardado, pero no pude comprobarlo releyendo la base', { kind: 'warn' });
      return r;
    },
  });
  // Refresca cuando el diálogo ya está cerrado: con él abierto, refreshView({quiet})
  // lo aplazaba hasta el siguiente pulso (hasta 20 s con la lista y el contador viejos).
  if (saved) refreshView({ quiet: true });
  return saved;
}

export async function openForget(f) {
  const ok = await confirmDialog({
    title: '¿Olvidar este hecho?',
    message: `«${f.fact}»`,
    detail: 'Se retira de la memoria activa (forget). El historial y las copias pueden conservarlo.',
    confirmLabel: 'Olvidar', danger: true,
    reason: { label: 'Motivo', required: true, placeholder: 'p. ej. ya no es verdad, era un error…' },
  });
  if (!ok) return;
  try {
    await post(`/api/facts/${encodeURIComponent(f.id)}/forget`, { reason: ok.reason });
    toast(`Olvidado (hecho #${f.id})`);
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
  refreshView();
}

export async function openCorrect(f) {
  const datalist = await entityOptions();
  return formDialog({
    title: `Corregir el hecho #${f.id}`,
    intro: 'Primero se guarda el texto nuevo y después se retira el viejo, así nunca te quedas sin ninguno.',
    submitLabel: 'Corregir',
    fields: factFields({ fact: f.fact, entity: f.entity_slug || '', kind: f.kind || 'fact' }, datalist, `panel web, ${stamp()}, corrección de __NOMBRE__`),
    onSubmit: async (v) => {
      if (v.fact === f.fact && (v.entity || '') === (f.entity_slug || '') && v.kind === f.kind) {
        throw new Error('No has cambiado nada.');
      }
      const r = await post(`/api/facts/${encodeURIComponent(f.id)}/correct`, bodyOf(v));
      if (r?.oldExpired) toast(`Corregido: #${f.id} retirado, #${r.newId} guardado ✓`);
      else toast('Nada cambió: ese texto ya existía como hecho', { kind: 'warn' });
      refreshView();
      return r;
    },
  });
}

/**
 * Fila de un hecho. opts: {hideEntity, compact, actions=true}
 * Los retirados (expired_at) salen tachados y sin acciones.
 */
export function factRow(f, { hideEntity = false, compact = false, actions = true } = {}) {
  const retired = !!f.expired_at;
  return h('li', { class: ['row', 'fact', retired && 'retired', compact && 'compact'] },
    h('div.row-main',
      h('p.row-text', !compact && [kindChip(f.kind), ' '], retired ? h('s', f.fact) : inlineText(f.fact)),
      h('div.row-meta',
        compact && kindChip(f.kind),
        !hideEntity && f.entity_slug && slugLink(f.entity_slug),
        h('span.mono.muted', `#${f.id}`),
        h('span.muted', retired ? `retirado ${rel(f.expired_at)}` : rel(f.created_at)),
        f.trust_tier && h('span.muted', f.trust_tier),
        f.confidence != null && f.confidence !== '' && Number(f.confidence) < 1 && h('span.muted', `confianza ${Math.round(Number(f.confidence) * 100)} %`),
        f.source && h('span.muted.clip', { title: f.source }, f.source))),
    actions && !retired && h('div.row-actions',
      h('button.btn.tiny.ghost', { type: 'button', onclick: () => openCorrect(f) }, 'Corregir'),
      h('button.btn.tiny.ghost.danger-text', { type: 'button', onclick: () => openForget(f) }, 'Olvidar')));
}

/* ------------------------------------------------------------- la vista */

export async function mount(el, r) {
  const kind = r.query.get('kind') || '';
  const entity = r.query.get('entity') || '';
  const expired = r.query.get('expired') === '1';
  const data = await get(`/api/facts?kind=${encodeURIComponent(kind)}&entity=${encodeURIComponent(entity)}&expired=${expired ? 1 : 0}`);
  draw(el, data.facts || [], { kind, entity, expired });
}
export const refresh = mount;

function link(q) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v === true ? '1' : v);
  const s = p.toString();
  return '#/hechos' + (s ? '?' + s : '');
}

function draw(el, facts, q) {
  const active = facts.filter((f) => !f.expired_at).length;
  const sub = `Lo que el cerebro recuerda como datos sueltos: ${active} ${active === 1 ? 'activo' : 'activos'}${q.expired ? `, ${facts.length - active} retirados` : ''}.`;
  el.replaceChildren(
    pageHead('Hechos', sub,
      h('button.btn.primary', { type: 'button', onclick: () => openRemember({ entity: q.entity }) }, icon('plus'), 'Recordar')),
    h('div.filters',
      h('nav.chip-row', { 'aria-label': 'Tipo de hecho' },
        h('a', { class: ['chip', 'folder', !q.kind && 'active'], href: link({ ...q, kind: '' }) }, 'Todos'),
        Object.entries(KINDS).map(([k, [, many]]) =>
          h('a', { class: ['chip', 'folder', 'k-' + k, q.kind === k && 'active'], href: link({ ...q, kind: k }) }, many))),
      h('label.check-inline',
        h('input', { type: 'checkbox', checked: q.expired, onchange: (e) => go(link({ ...q, expired: e.target.checked })) }),
        'Incluir retirados'),
      q.entity && h('span.chip.active', 'sobre ', h('span.mono', q.entity),
        h('a.chip-x', { href: link({ ...q, entity: '' }), 'aria-label': 'Quitar filtro de entidad' }, '×'))),
    card({},
      facts.length
        ? h('ul.rows', facts.map((f) => factRow(f)))
        : emptyState(q.kind || q.entity ? 'No hay hechos con este filtro' : 'Aún no hay hechos',
          `Los hechos se guardan con «Recordar» aquí, desde Telegram o en cualquier sesión de Claude.${q.expired ? '' : ' Los retirados no salen salvo que marques «Incluir retirados».'}`)));
}
