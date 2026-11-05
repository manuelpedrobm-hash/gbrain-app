// Chips y etiquetas pequeñas: tipo de página, tipo de hecho, estado de un mensaje,
// fecha límite, procedencia («de ESTADO.md…») y la marca «frío».

import { h, daysFrom, relDay, fmtDay } from '../app.js';

/* Tipos de página. Los colores salen de las variables --c-<tipo> de app.css,
   las mismas que usa el minigrafo. */
export const TYPES = {
  person: ['persona', 'Personas'],
  project: ['proyecto', 'Proyectos'],
  source: ['fuente', 'Fuentes'],
  concept: ['concepto', 'Conceptos'],
  note: ['nota', 'Notas'],
  conversation: ['conversación', 'Conversaciones'],
};
export const TYPE_ORDER = ['person', 'project', 'source', 'concept', 'note', 'conversation'];

export function typeLabel(t, pluralForm = false) {
  const m = TYPES[t];
  if (m) return m[pluralForm ? 1 : 0];
  return t || 'sin tipo';
}

/** Clase CSS segura para un tipo (los desconocidos van en gris). */
export function typeClass(t) { return 't-' + (TYPES[t] ? t : 'other'); }

export function typeChip(t) {
  return h('span', { class: ['chip', 'type', typeClass(t)] }, typeLabel(t));
}

/* Tipos de hecho (facts.kind). */
export const KINDS = {
  fact: ['dato', 'Datos'],
  preference: ['preferencia', 'Preferencias'],
  commitment: ['compromiso', 'Compromisos'],
  event: ['evento', 'Eventos'],
  belief: ['creencia', 'Creencias'],
};

export function kindChip(k) {
  return h('span', { class: ['chip', 'kind', 'k-' + (KINDS[k] ? k : 'other')] }, KINDS[k]?.[0] || k || 'hecho');
}

/* Estado de un mensaje de Telegram. */
const STATUS = {
  respondido: ['respondido', 'ok'],
  sin_respuesta: ['sin respuesta', 'bad'],
  en_curso: ['en curso', 'warn'],
};

export function statusChip(s) {
  const [label, cls] = STATUS[s] || [s || '—', 'muted'];
  return h('span', { class: ['chip', 'status', 'st-' + cls] }, label);
}

export function chip(text, cls) { return h('span', { class: ['chip', cls] }, text); }

/** Procedencia de un dato. warn=true lo pinta en ámbar (p. ej. archivo de hace más de 3 días). */
export function sourceChip(text, { warn = false, href, title } = {}) {
  const attrs = { class: ['chip', 'source', warn && 'warn'], title };
  return href ? h('a', { ...attrs, href }, text) : h('span', attrs, text);
}

/** Urgencia por días que faltan: rojo ≤ 2 días, ámbar ≤ 7. */
export function urgencyOf(day) {
  const n = daysFrom(day);
  if (n == null) return 'normal';
  if (n <= 2) return 'red';
  if (n <= 7) return 'amber';
  return 'normal';
}

/** Chip de fecha límite: «vence mañana», «vence 3 nov», «venció hace 2 días». */
export function dueChip(day, { overdue = false, prefix = 'vence' } = {}) {
  const n = daysFrom(day);
  const past = overdue || (n != null && n < 0);
  const u = past ? 'red' : urgencyOf(day);
  let txt;
  if (n == null) txt = `${prefix} ${day}`;
  else if (past) txt = `venció ${relDay(day)}`;
  else txt = `${prefix} ${n <= 7 ? relDay(day) : fmtDay(day)}`;
  return h('span', { class: ['chip', 'due', 'u-' + u], title: fmtDay(day, true) }, txt);
}

export function coldBadge() {
  return h('span.chip.cold', { title: 'Hace tiempo que no aparece en nada nuevo (ni enlaces, ni hechos, ni cronología)' }, 'frío');
}

export function tagChip(tag, { link = true } = {}) {
  const t = String(tag).replace(/^#/, '');
  return link
    ? h('a.chip.tag', { href: '#/memoria?tag=' + encodeURIComponent(t) }, '#' + t)
    : h('span.chip.tag', '#' + t);
}
