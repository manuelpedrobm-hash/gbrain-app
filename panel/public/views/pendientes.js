// Pendientes: una sola lista con todo lo que está abierto.
//   Tareas (escribible: la página ops/tasks del cerebro) · Compromisos (hechos) ·
//   Fechas (ESTADO.md y demás, solo lectura) · En tus páginas (encabezados de pendientes) ·
//   Mapa de misiones (enlace a la pestaña Misiones).

import {
  h, get, post, card, pageHead, emptyState, icon, inlineText, plainMd, fmtDay, relDay, rel,
  todayISO, isTyping, refreshView, slugLink, plural, askChat,
} from '../app.js';
import { dueChip, sourceChip, chip, urgencyOf } from '../components/chips.js';
import { confirmDialog, formDialog, popMenu } from '../components/confirm.js';
import { toast } from '../components/toast.js';

export const title = 'Pendientes';

const PRIORITIES = [['P0', 'P0 · Urgente'], ['P1', 'P1 · Hoy'], ['P2', 'P2 · Esta semana'], ['P3', 'P3 · Algún día']];
const SECTION_LABEL = { P0: 'Urgente', P1: 'Hoy', P2: 'Esta semana', P3: 'Algún día', Deferred: 'Pospuestas', Completed: 'Hechas' };
const TAG_RE = /#[\p{L}\d_-]+/gu;

/* ------------------------------------------------------- acciones (API) */

/** POST /api/tasks/:id/<acción>. Avisa en español si otra sesión cambió la lista (409). */
export async function taskAction(id, action, body = {}) {
  try {
    return await post(`/api/tasks/${encodeURIComponent(id)}/${action}`, body);
  } catch (e) {
    if (e.status === 409) {
      toast('Otra sesión cambió las tareas; recarga', { kind: 'warn', action: { label: 'Recargar', fn: () => refreshView() } });
    } else {
      toast(e.message, { kind: 'error' });
    }
    throw e;
  }
}

/** Marca hecha (con «Deshacer») o reabre una tarea, y refresca la vista. */
export async function toggleDone(task, rowEl) {
  rowEl?.classList.add('working');
  try {
    if (task.done) {
      await taskAction(task.id, 'reopen');
      toast('Reabierta: vuelve a P1');
    } else {
      await taskAction(task.id, 'done');
      toast('Hecha: ' + shorten(plainMd(task.text), 60), {
        action: { label: 'Deshacer', fn: async () => { await taskAction(task.id, 'reopen').catch(() => {}); refreshView(); } },
      });
    }
  } catch {
    rowEl?.classList.remove('working');
    const cb = rowEl?.querySelector('input[type=checkbox]');
    if (cb) cb.checked = !!task.done;
    return;
  }
  refreshView();
}

function shorten(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/** Formulario «Nueva tarea». prefill: {text, priority, due, intro, onCreated(task)} */
export function openTaskForm(prefill = {}) {
  return formDialog({
    title: prefill.title || 'Nueva tarea',
    intro: prefill.intro || 'Se añade a la página ops/tasks del cerebro. Gratis: no usa el modelo.',
    submitLabel: 'Añadir tarea',
    fields: [
      { name: 'text', label: 'Tarea', type: 'textarea', rows: 2, value: shorten(prefill.text, 300), required: true, maxlength: 300, autofocus: true,
        hint: 'Puedes añadir etiquetas como #etiqueta. Máximo 300 caracteres.' },
      { name: 'priority', label: 'Prioridad', type: 'select', options: PRIORITIES, value: prefill.priority || 'P1' },
      { name: 'due', label: 'Fecha límite', type: 'date', optional: true, value: prefill.due || '' },
      ...(prefill.extraFields || []),
    ],
    onSubmit: async (v) => {
      const body = { text: v.text.replace(/\s*\n\s*/g, ' '), priority: v.priority };
      if (v.due) body.due = v.due;
      const r = await post('/api/tasks', body).catch((e) => {
        if (e.status === 409) throw new Error('Otra sesión cambió las tareas; recarga e inténtalo otra vez.');
        throw e;
      });
      if (prefill.onCreated) await prefill.onCreated(r?.task, v);
      toast('Tarea añadida' + (r?.task?.id ? ` (${r.task.id})` : ''));
      refreshView();
      return r;
    },
  });
}

/* ----------------------------------------------------------- fila tarea */

function taskText(text) {
  const out = [];
  const str = String(text ?? '');
  let last = 0;
  for (const m of str.matchAll(TAG_RE)) {
    if (m.index > last) out.push(...inlineText(str.slice(last, m.index)));
    out.push(h('span.tag-inline', m[0]));
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push(...inlineText(str.slice(last)));
  return out;
}

/**
 * Una tarea. opts: {writable, compact, menu}. compact=true para Hoy (sin menú ni pasos).
 */
export function taskRow(task, { writable = true, compact = false } = {}) {
  const row = h('li', { class: ['task', task.done && 'done', task.overdue && 'overdue'], tabindex: '0', dataset: { id: task.id } });
  const cb = h('input', {
    type: 'checkbox', checked: !!task.done, disabled: !writable,
    'aria-label': task.done ? 'Reabrir tarea' : 'Marcar como hecha',
    onchange: () => toggleDone(task, row),
  });
  const meta = [];
  if (task.due && !task.done) meta.push(dueChip(task.due, { overdue: task.overdue }));
  if (task.deferredUntil) meta.push(chip(`pospuesta hasta ${fmtDay(task.deferredUntil)}`, 'muted'));
  if (task.reason) meta.push(h('span.task-reason', task.reason));
  if (task.completed) meta.push(h('span.task-reason', `hecha ${relDay(task.completed)}`));
  if (compact && task.section && /^P[0-3]$/.test(task.section)) meta.unshift(chip(task.section, 'prio prio-' + task.section));
  if (compact && task.steps?.length) meta.push(h('span.task-reason', `${task.steps.filter((s) => s.done).length}/${task.steps.length} pasos`));

  row.append(...[
    h('label.task-check', cb),
    h('div.task-main',
      h('div.task-text', taskText(task.text)),
      meta.length > 0 && h('div.task-meta', meta),
      !compact && task.steps?.length > 0 && h('ul.steps', task.steps.map((s) =>
        h('li', { class: ['step', s.done && 'done'] }, h('span.step-box', { 'aria-hidden': 'true' }, s.done ? '✓' : ''), h('span', inlineText(s.text)))))),
    !compact && writable && h('button.icon-btn.more', {
      type: 'button', 'aria-label': 'Más acciones', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => openTaskMenu(task, e.currentTarget),
    }, icon('more')),
  ].filter(Boolean)); // append nativo: sin el filtro, un false saldría como texto
  return row;
}

// Abre el chat con la tarea como encargo (sin enviarlo: puedes retocarlo). El agente lee
// cerebro, correo y agenda; lo que escriba o envíe llega como propuesta para confirmar.
function askAgent(task) {
  askChat(`Ocúpate de esta tarea: «${task.text}».\n` +
    'Busca lo necesario en el cerebro, mi correo y mi agenda, dime qué propones y, si hace falta escribir a alguien, prepárame el borrador.');
}

function openTaskMenu(task, anchor) {
  const items = [];
  if (!task.done) {
    items.push({ label: 'Pedir al agente…', onClick: () => askAgent(task) });
    items.push('-');
  }
  if (!task.done) {
    items.push({ heading: 'Mover a' });
    for (const [p, label] of PRIORITIES) {
      if (p !== task.section) items.push({ label, onClick: () => moveTask(task, p) });
    }
    items.push('-');
    items.push({ label: 'Posponer…', onClick: () => deferTask(task) });
  }
  items.push({ label: 'Editar…', onClick: () => editTask(task) });
  if (task.done || task.section === 'Deferred') items.push({ label: 'Reabrir', onClick: () => reopenTask(task) });
  popMenu(anchor, items);
}

async function moveTask(task, priority) {
  try { await taskAction(task.id, 'move', { priority }); } catch { return; }
  toast(`Movida a ${priority}`);
  refreshView();
}

async function reopenTask(task) {
  try { await taskAction(task.id, 'reopen'); } catch { return; }
  toast('Reabierta en P1');
  refreshView();
}

function deferTask(task) {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const week = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return formDialog({
    title: 'Posponer tarea',
    intro: shorten(task.text, 140),
    submitLabel: 'Posponer',
    fields: [
      { name: 'until', label: 'Hasta', type: 'date', value: week, required: true },
      { name: 'reason', label: 'Motivo', type: 'text', maxlength: 300, required: true, autofocus: true, placeholder: 'p. ej. espero respuesta de…' },
    ],
    onSubmit: async (v) => {
      await taskAction(task.id, 'defer', { until: v.until, reason: v.reason });
      toast(`Pospuesta hasta ${fmtDay(v.until)}`);
      refreshView();
    },
  });
}

function editTask(task) {
  return formDialog({
    title: 'Editar tarea',
    submitLabel: 'Guardar',
    fields: [{ name: 'text', label: 'Texto', type: 'textarea', rows: 3, value: task.text, required: true, maxlength: 300, autofocus: true,
      hint: 'La fecha y los pasos no cambian; solo el texto.' }],
    onSubmit: async (v) => {
      await taskAction(task.id, 'edit', { text: v.text.replace(/\s*\n\s*/g, ' ') });
      toast('Tarea editada');
      refreshView();
    },
  });
}

/* ------------------------------------------------------------- la vista */

let data = null;
let addDraft = { text: '', priority: 'P1', due: '' };
let keyHandler = null;

export async function mount(el) {
  data = await get('/api/pendientes');
  draw(el);
  if (el.isConnected) installKeys(el); // si ya te fuiste, no dejo el atajo «x» colgando
}

export async function refresh(el) {
  data = await get('/api/pendientes');
  const focusedId = document.activeElement?.closest?.('.task')?.dataset.id;
  draw(el);
  if (focusedId) el.querySelector(`.task[data-id="${CSS.escape(focusedId)}"]`)?.focus();
}

export function unmount() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
}

function installKeys(el) {
  unmount();
  // x = marcar hecha la tarea seleccionada; j/k o flechas = moverse entre tareas.
  keyHandler = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('dialog[open], .menu')) return;
    const row = document.activeElement?.closest?.('.task');
    if (!row || !el.contains(row)) return;
    if (e.key === 'x') {
      const task = findTask(row.dataset.id);
      if (task && !task.done && data?.tasks?.writable) { e.preventDefault(); toggleDone(task, row); }
    } else if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'ArrowUp') {
      const rows = [...el.querySelectorAll('.task')].filter((r) => r.offsetParent);
      const i = rows.indexOf(row);
      const next = rows[i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function findTask(id) {
  for (const s of data?.tasks?.sections || []) for (const t of s.tasks) if (t.id === id) return t;
  return null;
}

function draw(el) {
  const t = data.tasks || {};
  const open = (t.sections || []).filter((s) => /^P[0-3]$/.test(s.key)).reduce((n, s) => n + s.tasks.length, 0);
  const commitments = data.commitments || [];
  const deadlines = data.deadlines || [];
  const future = deadlines.filter((d) => !d.past);
  const sub = [
    t.exists ? plural(open, 'tarea abierta', 'tareas abiertas') : 'sin lista de tareas',
    plural(commitments.length, 'compromiso', 'compromisos'),
    plural(future.length, 'fecha por delante', 'fechas por delante'),
  ].join(' · ');

  const jump = (id, label) => h('button.chip.jump', { type: 'button', onclick: () => el.querySelector('#' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, label);

  el.replaceChildren(
    pageHead('Pendientes', sub, h('button.btn.small.primary', {
      type: 'button',
      title: 'Abre el chat: el agente lee cerebro, correo y agenda, y te propone lo que haya que guardar o enviar',
      onclick: () => askChat('Encargo: '),
    }, 'Encargar al agente')),
    h('nav.jumps', { 'aria-label': 'Secciones de pendientes' },
      jump('pd-tareas', 'Tareas'), jump('pd-compromisos', 'Compromisos'), jump('pd-fechas', 'Fechas'),
      jump('pd-paginas', 'En tus páginas'), jump('pd-mapa', 'Mapa de misiones')),
    h('div.stack',
      tasksCard(t),
      commitmentsCard(commitments),
      deadlinesCard(deadlines),
      pagesCard(data.sections || []),
      mapaCard(data.mapa),
      h('p.footnote', 'No ves «bucles abiertos» porque GBrain no tiene fuentes de Google conectadas: la tabla está vacía. Aparecerán aquí cuando haya alguno.')));
}

/* ------------------------------------------------------------- tareas */

function tasksCard(t) {
  if (!t.exists) {
    return card({ title: 'Tareas', id: 'pd-tareas' },
      emptyState('Aún no tienes lista de tareas',
        'Las tareas del panel se guardan en la página ops/tasks del cerebro, con el mismo formato que usa el gestor de tareas diario (P0–P3, Pospuestas, Hechas). Así también las ven Telegram y Claude Code.',
        h('button.btn.primary', { type: 'button', onclick: createTasksPage }, icon('plus'), 'Crear lista de tareas')));
  }
  const writable = t.writable !== false;
  const sections = t.sections || [];
  return card({ title: 'Tareas', id: 'pd-tareas', actions: h('a.btn.ghost.small', { href: '#/p/' + (t.slug || 'ops/tasks') }, 'Ver la página') },
    !writable && h('div.banner.warn', { role: 'note' }, t.reason_es || 'La lista no se puede editar desde el panel ahora mismo.'),
    writable && addForm(),
    sections.map((s) => sectionBlock(s, writable)),
    (t.unparsed || []).length > 0 && h('div.unparsed',
      h('p.muted.small', 'Líneas que no entiendo (se dejan tal cual en la página):'),
      h('ul', t.unparsed.map((u) => h('li.mono', { title: `línea ${u.lineNo}` }, u.text)))));
}

function addForm() {
  const text = h('input.grow', {
    type: 'text', maxlength: 300, placeholder: 'Añade una tarea…', 'aria-label': 'Nueva tarea', value: addDraft.text,
    oninput: (e) => { addDraft.text = e.target.value; },
  });
  const prio = h('select', { 'aria-label': 'Prioridad', onchange: (e) => { addDraft.priority = e.target.value; } },
    PRIORITIES.map(([v, l]) => h('option', { value: v }, l)));
  prio.value = addDraft.priority;
  const due = h('input', { type: 'date', 'aria-label': 'Fecha límite (opcional)', title: 'Fecha límite (opcional)', value: addDraft.due,
    oninput: (e) => { addDraft.due = e.target.value; } });
  const btn = h('button.btn.primary', { type: 'submit' }, icon('plus'), 'Añadir');
  return h('form.add-task', {
    onsubmit: async (e) => {
      e.preventDefault();
      const v = text.value.trim().replace(/\s*\n\s*/g, ' ');
      if (!v) { text.focus(); return; }
      btn.disabled = true;
      try {
        const body = { text: v, priority: prio.value };
        if (due.value) body.due = due.value;
        const r = await post('/api/tasks', body);
        addDraft = { text: '', priority: prio.value, due: '' };
        toast('Tarea añadida' + (r?.task?.id ? ` (${r.task.id})` : ''));
        await refreshView();
        document.querySelector('.add-task input[type=text]')?.focus();
      } catch (ex) {
        toast(ex.status === 409 ? 'Otra sesión cambió las tareas; recarga' : ex.message, { kind: 'error' });
        btn.disabled = false;
      }
    },
  }, text, prio, due, btn);
}

function sectionBlock(s, writable) {
  const isOpenSection = /^P[0-3]$/.test(s.key);
  let tasks = s.tasks || [];
  let more = 0;
  if (s.key === 'Completed' && tasks.length > 10) { more = tasks.length - 10; tasks = tasks.slice(0, 10); }
  const label = s.label_es || SECTION_LABEL[s.key] || s.key;
  return h('details', { class: ['tsec', 'tsec-' + s.key], open: isOpenSection },
    h('summary',
      isOpenSection && chip(s.key, 'prio prio-' + s.key),
      h('span.tsec-label', label),
      h('span.count', String((s.tasks || []).length))),
    tasks.length
      ? h('ul.tasks', tasks.map((t) => taskRow(t, { writable })))
      : h('p.tsec-empty', isOpenSection ? 'Nada aquí.' : s.key === 'Deferred' ? 'No hay tareas pospuestas.' : 'Aún no has terminado ninguna.'),
    more > 0 && h('p.muted.small', `Y ${more} más en la página.`));
}

async function createTasksPage() {
  const ok = await confirmDialog({
    title: '¿Crear la lista de tareas?',
    message: 'Crearé la página ops/tasks en el cerebro con las secciones P0, P1, P2, P3, Pospuestas y Hechas, vacías.',
    detail: 'Solo se crea si no existe; no sobrescribe nada. Queda registrado en el diario de cambios del panel.',
    confirmLabel: 'Crear lista',
  });
  if (!ok) return;
  try {
    const r = await post('/api/tasks/init', {});
    if (r?.fileWritten === false) toast('Lista creada, pero escrita solo en la base de datos (mira Estado)', { kind: 'warn' });
    else toast('Lista de tareas creada');
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
  refreshView();
}

/* -------------------------------------------------------- compromisos */

function commitmentsCard(list) {
  return card({ title: 'Compromisos', count: list.length || null, id: 'pd-compromisos',
    note: list.length ? 'Hechos de tipo «compromiso» que siguen activos.' : null },
  list.length
    ? h('ul.rows', list.map(commitmentRow))
    : emptyState('No hay compromisos activos',
      'Un compromiso es un hecho de tipo «compromiso» guardado con Recordar (aquí, desde Telegram o en Claude Code). Cuando lo cumplas, se retira.'));
}

function commitmentRow(f) {
  const until = f.valid_until;
  return h('li.row.commit',
    h('div.row-main',
      h('p.row-text', inlineText(f.fact)),
      h('div.row-meta',
        until && dueChip(until),
        f.entity_slug && slugLink(f.entity_slug),
        h('span.muted', `hecho #${f.id} · ${rel(f.created_at)}`),
        f.source && h('span.muted.clip', { title: f.source }, f.source))),
    h('div.row-actions',
      h('button.btn.small', { type: 'button', onclick: () => fulfil(f) }, icon('check'), 'Cumplido'),
      h('button.btn.small.ghost', { type: 'button', onclick: () => convert(f) }, 'Convertir en tarea')));
}

async function fulfil(f) {
  const ok = await confirmDialog({
    title: '¿Marcar como cumplido?',
    message: `«${shorten(f.fact, 200)}»`,
    detail: 'El compromiso se retira de la memoria activa (forget). El historial puede conservarlo.',
    confirmLabel: 'Cumplido',
  });
  if (!ok) return;
  try {
    await post(`/api/facts/${encodeURIComponent(f.id)}/forget`, { reason: `cumplido, marcado en el panel ${todayISO()}` });
    toast('Compromiso cumplido y retirado');
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
  refreshView();
}

function convert(f) {
  return openTaskForm({
    title: 'Convertir en tarea',
    intro: 'Se crea una tarea con este texto. El compromiso sigue activo salvo que marques la casilla.',
    text: f.fact,
    due: f.valid_until ? String(f.valid_until).slice(0, 10) : '',
    extraFields: [{ name: 'retire', type: 'checkbox', label: 'Retirar el compromiso', value: false,
      hint: 'Lo marca como sustituido por la tarea (forget con motivo).' }],
    onCreated: async (task, v) => {
      if (!v.retire) return;
      await post(`/api/facts/${encodeURIComponent(f.id)}/forget`, { reason: `convertido en tarea ${task?.id || ''}`.trim() });
    },
  });
}

/* --------------------------------------------------------------- fechas */

export function deadlineRow(d, { estadoAge, pageLink = false } = {}) {
  const day = parseInt(String(d.date).slice(8, 10), 10);
  const dt = new Date(String(d.date).slice(0, 10) + 'T12:00:00');
  const month = isNaN(dt) ? '' : new Intl.DateTimeFormat('es', { month: 'short' }).format(dt).replace('.', '');
  const wd = isNaN(dt) ? '' : new Intl.DateTimeFormat('es', { weekday: 'short' }).format(dt).replace('.', '');
  const u = d.past ? 'past' : d.urgency || urgencyOf(d.date);
  return h('li', { class: ['row', 'deadline', 'u-' + u] },
    h('div.datebox', { 'aria-hidden': 'true' }, h('span.wd', wd), h('span.d', isNaN(day) ? '?' : String(day)), h('span.m', month)),
    h('div.row-main',
      h('p.row-text', inlineText(d.label)),
      h('div.row-meta',
        h('span', { class: ['when', 'u-' + u] }, relDay(d.date)),
        d.timeLabel && chip(d.timeLabel, 'muted'),
        deadlineSource(d, estadoAge)),
      pageLink && d.source === 'estado' && h('p.row-sub',
        'abre la página ', h('a.mono', { href: '#/p/sources/informes-claude/estado' }, 'sources/informes-claude/estado'))));
}

/** Chip de procedencia de una fecha. estadoAge: días desde la última modificación de ESTADO.md. */
export function deadlineSource(d, estadoAge) {
  if (d.source === 'estado') {
    const age = estadoAge != null ? ` · actualizado ${estadoAge === 0 ? 'hoy' : estadoAge === 1 ? 'ayer' : `hace ${estadoAge} días`}` : '';
    return sourceChip('de ESTADO.md' + age, {
      warn: estadoAge != null && estadoAge > 3,
      href: '#/p/sources/informes-claude/estado',
      title: 'Abre la página sources/informes-claude/estado',
    });
  }
  if (d.source === 'task') return sourceChip('de tus tareas' + (d.ref ? ` · ${d.ref}` : ''), { href: '#/pendientes' });
  if (d.source === 'commitment') return sourceChip(`de un compromiso${d.ref ? ` · hecho #${d.ref}` : ''}`, { href: '#/hechos?kind=commitment' });
  return d.source ? sourceChip('de ' + d.source) : null;
}

/** Días desde la última modificación de ESTADO.md, si el servidor la manda (varios nombres aceptados). */
export function estadoAgeOf(payload, deadlines = []) {
  if (Number.isFinite(payload?.estado?.ageDays)) return Math.max(0, Math.round(payload.estado.ageDays));
  const ts = payload?.estadoMtime ?? payload?.estado?.mtime ?? payload?.estado?.updatedAt
    ?? deadlines.find((d) => d.source === 'estado' && (d.updatedAt || d.fileMtime || d.mtime))?.updatedAt
    ?? deadlines.find((d) => d.source === 'estado')?.fileMtime
    ?? deadlines.find((d) => d.source === 'estado')?.mtime;
  if (!ts) return null;
  const t = new Date(ts);
  if (isNaN(t)) return null;
  const a = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const n = new Date();
  const b = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Aviso si ESTADO.md no se pudo leer (el resto de fechas sigue saliendo). */
export function estadoProblem(payload) {
  const e = payload?.estado;
  if (!e || e.ok !== false) return null;
  return h('div.banner.warn.small', { role: 'note' }, e.error_es || 'No pude leer ESTADO.md; sus fechas no salen aquí.');
}

function deadlinesCard(list) {
  const age = estadoAgeOf(data, list);
  const future = list.filter((d) => !d.past).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const past = list.filter((d) => d.past).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return card({ title: 'Fechas', count: future.length || null, id: 'pd-fechas',
    note: 'Solo lectura. Salen de la tabla «Fechas que vencen» de ESTADO.md, de tus tareas con fecha y de compromisos con fecha límite. Para cambiarlas, edita la página de origen.' },
  estadoProblem(data),
  future.length
    ? h('ul.rows', future.map((d) => deadlineRow(d, { estadoAge: age, pageLink: true })))
    : emptyState('No hay fechas por delante', 'Ni ESTADO.md, ni tus tareas, ni tus compromisos tienen fechas futuras.'),
  past.length > 0 && h('details.subgroup',
    h('summary', `Pasadas (${past.length})`),
    h('ul.rows.past', past.map((d) => deadlineRow(d, { estadoAge: age, pageLink: true })))));
}

/* -------------------------------------------------------- en tus páginas */

function pagesCard(sections) {
  if (!sections.length) {
    return card({ title: 'En tus páginas', id: 'pd-paginas' },
      emptyState('Ninguna página tiene pendientes a la vista',
        'Busco encabezados como «Pendiente», «Próximos pasos», «Next steps» o «Preguntas abiertas» en proyectos, fuentes, notas y personas.'));
  }
  const byPage = new Map();
  for (const s of sections) {
    if (!byPage.has(s.slug)) byPage.set(s.slug, { slug: s.slug, title: s.title, heads: [] });
    byPage.get(s.slug).heads.push(s);
  }
  const total = sections.reduce((n, s) => n + (s.items || []).length, 0);
  return card({ title: 'En tus páginas', count: total || null, id: 'pd-paginas',
    note: 'Viñetas bajo encabezados de pendientes en tus páginas. Solo lectura: «Crear tarea» las copia a tu lista.' },
  [...byPage.values()].map((p) => h('div.page-pend',
    h('h3.page-pend-title', slugLink(p.slug, p.title || p.slug), h('span.mono.muted.small', p.slug)),
    p.heads.map((s) => h('div.page-pend-head',
      h('p.page-pend-heading', plainMd(String(s.heading || '').replace(/^#+\s*/, ''))),
      (s.items || []).length
        ? h('ul.bullets', s.items.map((it) => {
          const text = plainMd(it);
          return h('li.bullet',
            h('span.bullet-text', inlineText(String(it).replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '').replace(/\*\*/g, ''))),
            h('span.bullet-actions',
              h('a.btn.tiny.ghost', { href: '#/p/' + s.slug }, 'Abrir'),
              h('button.btn.tiny.ghost', { type: 'button', onclick: () => openTaskForm({ text, intro: `De ${p.title || p.slug} · ${plainMd(s.heading)}` }) }, 'Crear tarea')));
        }))
        : h('p.muted.small', 'El encabezado está, pero sin viñetas debajo.'))))));
}

/* ----------------------------------------------------------------- mapa */

function mapaCard(m) {
  if (!m) return null;
  // El mapa vive ahora en la pestaña Misiones (copia local del artifact de claude.ai).
  const link = h('a.btn', { href: '#/misiones/mapa' }, 'Abrir el mapa', icon('arrow'));
  if (m.mode === 'snapshot' && (m.open || []).length) {
    return card({ title: 'Mapa de misiones', id: 'pd-mapa', actions: link,
      note: `Snapshot del ${fmtDay(m.snapshotAt)}; solo lectura. Lo actualiza una sesión de Claude cuando se lo pides.` },
    h('ul.rows', m.open.map((x) => h('li.row',
      h('div.row-main', h('p.row-text', x.title),
        h('div.row-meta', x.day && dueChip(x.day, { prefix: 'para' }), x.frente && chip('#' + x.frente, 'tag')))))));
  }
  return card({ title: 'Mapa de misiones', id: 'pd-mapa', actions: link },
    h('p.card-text', 'Tus misiones están en la pestaña Misiones, junto a la Cola de borradores y el Diario. Es una copia local del artifact de claude.ai: lo que marques se guarda en tu Mac.'));
}
