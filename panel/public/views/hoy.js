// Hoy: la pantalla de cada mañana.
//   Izquierda: Vence pronto (+ Atrasado) · Tareas de hoy.
//   Derecha:   Llegó por Telegram · Nuevo desde tu última visita · Apunta algo.

import {
  h, get, post, card, emptyState, icon, rel, plural, slugLink, inlineText, askChat,
  capture, refreshView, plainMd,
} from '../app.js';
import { typeChip, kindChip } from '../components/chips.js';
import { formDialog } from '../components/confirm.js';
import { toast } from '../components/toast.js';
import { taskRow, deadlineRow, estadoAgeOf, estadoProblem } from './pendientes.js';
import { messageItem } from './mensajes.js';

export const title = 'Hoy';

let data = null;
let noteDraft = '';

/** Diálogo «Apuntar» (lo usan el chat y la paleta). Gratis: gbrain capture. */
export async function openCapture(prefill = '') {
  const saved = await formDialog({
    title: 'Apuntar una nota',
    intro: 'Se guarda como nota en inbox/ del cerebro. Gratis: no usa el modelo.',
    submitLabel: 'Apuntar',
    fields: [{ name: 'text', label: 'Nota', type: 'textarea', rows: 4, value: prefill, required: true, maxlength: 4000, autofocus: true }],
    onSubmit: async (v) => { await capture(v.text); },
  });
  if (saved) refreshView({ quiet: true });   // con el diálogo ya cerrado (ver hechos.js)
  return saved;
}

export async function mount(el) {
  data = await get('/api/hoy');
  draw(el);
}
export const refresh = mount;

function greeting() {
  const hr = new Date().getHours();
  if (hr < 6) return 'Buenas noches';
  if (hr < 14) return 'Buenos días';
  if (hr < 21) return 'Buenas tardes';
  return 'Buenas noches';
}

function draw(el) {
  const today = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  el.replaceChildren(
    h('div.hoy-head',
      h('div',
        h('h1', `${greeting()}, __NOMBRE__`),
        h('p.page-sub', today.charAt(0).toUpperCase() + today.slice(1)),
        summaryLine()),
      h('div.presets',
        h('span.presets-label', 'usa el chat'),
        h('button.btn.small', { type: 'button', onclick: () => askChat('Resúmeme el día', { send: true }) }, icon('chat'), 'Resúmeme el día'),
        h('button.btn.small', { type: 'button', onclick: () => askChat('¿Qué se me está escapando?', { send: true }) }, icon('chat'), '¿Qué se me está escapando?'))),
    h('div.hoy-grid',
      h('div.col', deadlinesCard(), tasksCard()),
      h('div.col', telegramCard(), sinceCard(), noteCard())));
}

function summaryLine() {
  const soon = (data.deadlines || []).filter((d) => !d.past && d.urgency !== 'normal').length;
  const overdue = (data.overdue || []).length;
  const today = (data.todayTasks || []).length;
  const waiting = (data.telegram?.messages || []).filter((m) => m.status === 'sin_respuesta').length;
  const parts = [];
  if (soon) parts.push(plural(soon, 'fecha esta semana', 'fechas esta semana'));
  if (overdue) parts.push(plural(overdue, 'tarea atrasada', 'tareas atrasadas'));
  if (today) parts.push(plural(today, 'tarea para hoy', 'tareas para hoy'));
  if (waiting) parts.push(plural(waiting, 'mensaje sin respuesta', 'mensajes sin respuesta'));
  return h('p.summary', parts.length ? parts.join(' · ') : 'Nada urgente a la vista.');
}

/* ---------------------------------------------------------- vence pronto */

function deadlinesCard() {
  const all = data.deadlines || [];
  const overdueTasks = data.overdue || [];
  const overdueIds = new Set(overdueTasks.map((t) => t.id));
  const age = estadoAgeOf(data, all);
  // Una tarea atrasada ya sale en «Atrasado» con su casilla: no la repito como fecha.
  const visible = all.filter((d) => !(d.source === 'task' && overdueIds.has(d.ref)));
  const pastLate = visible.filter((d) => d.past && d.source !== 'estado');
  const upcoming = visible.filter((d) => !d.past).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const hasLate = overdueTasks.length > 0 || pastLate.length > 0;

  return card({ title: 'Vence pronto', note: 'Próximos 14 días.', actions: h('a.btn.ghost.small', { href: '#/pendientes' }, 'Todas las fechas') },
    estadoProblem(data),
    hasLate && h('div.late',
      h('h3.group-title.danger', 'Atrasado'),
      overdueTasks.length > 0 && h('ul.tasks', overdueTasks.map((t) => taskRow(t, { compact: true }))),
      pastLate.length > 0 && h('ul.rows', pastLate.map((d) => deadlineRow(d, { estadoAge: age })))),
    upcoming.length
      ? h('ul.rows', upcoming.map((d) => deadlineRow(d, { estadoAge: age })))
      : !hasLate && emptyState('Nada vence en los próximos 14 días',
        'Miro la tabla «Fechas que vencen» de ESTADO.md, tus tareas con fecha y los compromisos con fecha límite.'));
}

/* ------------------------------------------------------------- tareas */

function tasksCard() {
  const tasks = (data.todayTasks || []).slice(0, 7);
  const n = data.openTasks ?? 0;
  return card({ title: 'Tareas de hoy', count: tasks.length || null,
    actions: h('a.btn.ghost.small', { href: '#/pendientes' }, `Ver todo (${n})`) },
  tasks.length
    ? h('ul.tasks', tasks.map((t) => taskRow(t, { compact: true })))
    : data.tasksExists === false
      ? emptyState('Aún no tienes lista de tareas',
        'Aquí salen tus tareas P0 y P1 de la página ops/tasks del cerebro. Créala en Pendientes con un clic.',
        h('a.btn.small', { href: '#/pendientes' }, 'Ir a Pendientes'))
    : n > 0
      ? emptyState('Nada urgente para hoy', `No tienes tareas P0 ni P1. Hay ${plural(n, 'tarea abierta', 'tareas abiertas')} con menos prioridad en Pendientes.`)
      : emptyState('No hay tareas abiertas',
        'Aquí salen tus tareas P0 y P1 de la página ops/tasks. Si aún no existe, créala en Pendientes.',
        h('a.btn.small', { href: '#/pendientes' }, 'Ir a Pendientes')));
}

/* ----------------------------------------------------------- telegram */

function telegramCard() {
  const tg = data.telegram || {};
  const msgs = tg.messages || [];
  return card({ title: 'Llegó por Telegram', actions: h('a.btn.ghost.small', { href: '#/mensajes' }, 'Ver todos'),
    note: 'Correo: no conectado (IONOS no lo soporta GBrain).' },
  tg.ok === false
    ? h('div.banner.error', { role: 'note' }, tg.error_es || 'No pude leer el registro de Telegram', h('span.muted', ' El resto de Hoy funciona igual; mira Estado.'))
    : msgs.length
      ? h('div.msgs.compact', msgs.slice(0, 5).map((m) => messageItem(m, { compact: true })))
      : emptyState('Sin mensajes recientes', 'No hay mensajes en los últimos registros del agente de Telegram.'));
}

/* ---------------------------------------------------- desde la última visita */

function sinceCard() {
  const s = data.since || {};
  const facts = s.facts || [];
  const retired = s.retired || [];
  const pages = s.pages || [];
  const total = facts.length + retired.length + pages.length;
  const seenBtn = h('button.btn.small', {
    type: 'button',
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await post('/api/hoy/seen', {}); toast('Marcado como visto'); } catch (ex) { toast(ex.message, { kind: 'error' }); }
      refreshView();
    },
  }, icon('check'), 'Marcar como visto');
  return card({ title: 'Nuevo desde tu última visita', count: total || null,
    note: s.lastSeen ? `Tu última visita marcada: ${rel(s.lastSeen)}.` : null, actions: total ? seenBtn : null },
  total === 0 && emptyState('Nada nuevo',
    `Desde ${s.lastSeen ? rel(s.lastSeen) : 'tu última visita'} no hay hechos, páginas ni retiradas nuevas.`),
  facts.length > 0 && h('div.subsec',
    h('h3.group-title', 'Hechos nuevos'),
    h('ul.rows.tight', facts.map((f) => h('li.row',
      h('div.row-main',
        h('p.row-text', kindChip(f.kind), ' ', inlineText(f.fact)),
        h('div.row-meta', f.entity_slug && slugLink(f.entity_slug), h('span.muted', `#${f.id} · ${rel(f.created_at)}`))))))),
  retired.length > 0 && h('div.subsec',
    h('h3.group-title', 'Retirados'),
    h('ul.rows.tight', retired.map((f) => h('li.row.retired',
      h('div.row-main', h('p.row-text', h('s', f.fact)), h('div.row-meta', h('span.muted', `#${f.id} · retirado ${rel(f.expired_at)}`))))))),
  pages.length > 0 && h('div.subsec',
    h('h3.group-title', 'Páginas cambiadas'),
    h('ul.rows.tight', pages.map((p) => h('li.row',
      h('div.row-main',
        h('p.row-text', typeChip(p.type), ' ', slugLink(p.slug, p.title)),
        h('div.row-meta', h('span.muted', rel(p.updated_at)), p.ingested_via && h('span.muted', `· entró por ${p.ingested_via}`))))))));
}

/* ------------------------------------------------------------ apuntar */

function noteCard() {
  const ta = h('textarea', {
    rows: 3, maxlength: 4000, placeholder: 'Una idea, un recado, algo que no quieres olvidar…', 'aria-label': 'Nota rápida',
    oninput: (e) => { noteDraft = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } },
  });
  ta.value = noteDraft;
  const btn = h('button.btn.primary', { type: 'submit' }, 'Apuntar');
  const form = h('form.note-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      btn.disabled = true;
      try {
        await capture(text);
        noteDraft = '';
        await refreshView();
      } catch (ex) {
        toast(ex.message, { kind: 'error' });
        btn.disabled = false;
      }
    },
  }, ta, h('div.note-foot', h('span.muted.small', 'Se guarda en inbox/ del cerebro · ⌘↵'), btn));
  const inbox = data.inbox || [];
  return card({ title: 'Apunta algo' },
    form,
    h('h3.group-title', 'Últimas notas'),
    inbox.length
      ? h('ul.rows.tight', inbox.map((n) => h('li.row',
        h('div.row-main', h('p.row-text', slugLink(n.slug, plainMd(n.title) || n.slug)), h('div.row-meta', h('span.muted', rel(n.created_at)))))))
      : h('p.muted.small', 'Aún no hay notas en inbox/. Lo que apuntes aquí aparecerá en esta lista.'));
}
