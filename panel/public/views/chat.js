// Chat (#/chat, #/chat/<id>): una ejecución de `claude -p` por mensaje, con acceso solo a
// las herramientas de GBrain (mcp__cerebro__*). La respuesta llega por SSE:
//   status → text (deltas, como texto escapado) → tool / tool_result (chips) → done (HTML
//   renderizado en el servidor, coste, denegaciones, propuestas) | error.
// Los botones de arriba (Recordar, Nueva tarea, Apuntar, Buscar) no usan el modelo.
// El chat no escribe solo: si pide guardar un hecho o apuntar una nota, llega como
// «propuesta» y solo se guarda si la confirmas en el mismo diálogo que Recordar/Apuntar.

import {
  h, raw, fill, get, post, icon, rel, usd, getHealth, takeChatDraft, refreshHealth, isTyping, inlineText,
} from '../app.js';
import { confirmDialog, formDialog } from '../components/confirm.js';
import { toolChip, settleToolChip } from '../components/toolchip.js';
import { KINDS } from '../components/chips.js';
import { openPalette } from '../components/palette.js';
import { toast } from '../components/toast.js';

export const title = 'Chat';

const MAX_CHARS = 4000;
const RUN_KEY = 'cerebro.activeRun';
const MODELS = [
  ['sonnet', 'Sonnet', 'por defecto'],
  ['haiku', 'Haiku', 'rápido y barato'],
  ['opus', 'Opus', 'el mejor, más caro'],
];
// Esfuerzo de razonamiento (claude -p --effort). '' = el que traiga el modelo por defecto.
const EFFORTS = [
  ['', 'Esfuerzo normal'],
  ['low', 'Esfuerzo bajo · rápido'],
  ['medium', 'Esfuerzo medio'],
  ['high', 'Esfuerzo alto'],
  ['xhigh', 'Esfuerzo muy alto'],
  ['max', 'Esfuerzo máximo · lento'],
];
const EFFORT_KEY = 'cerebro.effort.v2';
const EFFORT_DEFAULT = 'high';   // elegido por __NOMBRE__ el 5 nov 2026
function loadEffort() { try { const v = localStorage.getItem(EFFORT_KEY); return v != null && EFFORTS.some(([k]) => k === v) ? v : EFFORT_DEFAULT; } catch { return EFFORT_DEFAULT; } }
function saveEffort(v) { try { localStorage.setItem(EFFORT_KEY, v); } catch { /* sin almacenamiento */ } }
// Borrador sin enviar, por conversación: sobrevive a cerrar la pestaña o la app.
const UNSENT_KEY = 'cerebro.unsent.';
function unsentKey() { return UNSENT_KEY + (convId || 'nueva'); }
function loadUnsent() { try { return localStorage.getItem(unsentKey()) || ''; } catch { return ''; } }
function saveUnsent(v) { try { if (v.trim()) localStorage.setItem(unsentKey(), v); else localStorage.removeItem(unsentKey()); } catch { /* sin almacenamiento */ } }
/** 'sonnet' o 'claude-sonnet-…' → 'Sonnet'. */
function modelName(m) {
  const s = String(m || '').toLowerCase();
  for (const [v, n] of MODELS) if (s.includes(v)) return n;
  return m || '';
}

/* Estado del módulo (una sola vista de chat a la vez). */
let el = null;
let convId = null;
let conv = null;
let chats = [];
let model = 'sonnet';
const opusOk = new Set(); // conversaciones donde ya confirmaste Opus
let opusDefault = false;
let run = null;           // {runId, es, turn, text, textNode, tools:Map, lastId, finished}
let ui = {};
let onHealth = null;

// Al recargar o cerrar la pestaña, el navegador corta el EventSource (y Chrome lanza un
// «error» de conexión antes incluso de pagehide). No es un fallo de la ejecución: sigue en el
// servidor y hay que conservar el run guardado para reengancharse al volver.
let unloading = false;
window.addEventListener('beforeunload', () => { unloading = true; });
window.addEventListener('pagehide', () => { unloading = true; });
window.addEventListener('pageshow', () => { unloading = false; });

/* ------------------------------------------------------- run activo (recarga) */

function saveRun(r) { try { sessionStorage.setItem(RUN_KEY, JSON.stringify(r)); } catch { /* sin almacenamiento */ } }
function loadRun() { try { return JSON.parse(sessionStorage.getItem(RUN_KEY) || 'null'); } catch { return null; } }
function clearRun() { try { sessionStorage.removeItem(RUN_KEY); } catch { /* nada */ } }

/* ------------------------------------------------------------ montaje */

export async function mount(container, r) {
  el = container;
  convId = r.rest || null;
  conv = null;
  run = null;
  model = 'sonnet';
  const [list, c, aj] = await Promise.all([
    get('/api/chats').catch(() => ({ chats: [] })),
    convId ? get('/api/chats/' + encodeURIComponent(convId)).catch((e) => (e.status === 404 ? null : Promise.reject(e))) : null,
    get('/api/ajustes').catch(() => null),
  ]);
  if (el !== container) return; // te fuiste de la vista mientras cargaba
  chats = list?.chats || [];
  if (aj?.modelo && MODELS.some(([v]) => v === aj.modelo)) model = aj.modelo;   // Estado → Ajustes
  opusDefault = aj?.modelo === 'opus';   // Opus elegido en Ajustes: no pedir confirmación cada vez
  if (convId && !c) {
    toast('Esa conversación ya no existe; empiezo una nueva', { kind: 'warn' });
    history.replaceState(null, '', '#/chat');
    convId = null;
  }
  conv = c;
  draw();

  onHealth = () => paintSpend();
  window.addEventListener('cerebro:health', onHealth);

  const draft = takeChatDraft();
  if (draft?.text) {
    ui.input.value = draft.text;
    autosize();
    paintCount();
    if (draft.send) send();
    else { ui.input.focus(); ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length); }
  } else if (loadUnsent()) {
    // Lo que dejaste escrito sin enviar (aunque se cerrara la pestaña o el navegador).
    ui.input.value = loadUnsent();
    autosize();
    paintCount();
    const active = loadRun();
    if (active && active.conversationId === convId && convId) reconnect(active.runId);
  } else {
    const active = loadRun();
    if (active && active.conversationId === convId && convId) reconnect(active.runId);
    else if (!isTyping()) ui.input.focus({ preventScroll: true });
  }
}

/** El pulso solo refresca la lista de conversaciones (nunca la que estás leyendo). */
export async function refresh() {
  if (run) return;
  try {
    chats = (await get('/api/chats'))?.chats || [];
    paintList();
  } catch { /* da igual: se intentará en el próximo pulso */ }
}

export function unmount() {
  // Al salir se cierra la conexión, pero la ejecución sigue en el servidor:
  // al volver a esta conversación se reengancha (el servidor repite los eventos).
  if (run?.es) run.es.close();
  run = null;
  if (onHealth) window.removeEventListener('cerebro:health', onHealth);
  onHealth = null;
  el = null;
}

/* ---------------------------------------------------------------- dibujo */

function draw() {
  ui = {};
  ui.list = h('nav.chat-list-items', { 'aria-label': 'Conversaciones' });
  ui.drawer = h('aside.chat-list', {
    id: 'chat-drawer',
    onkeydown: (e) => { if (e.key === 'Escape' && el?.querySelector('.drawer-open')) { closeDrawer(); el.querySelector('.drawer-btn')?.focus(); } },
  },
    h('div.chat-list-head',
      h('a.btn.primary.block', { href: '#/chat', onclick: () => closeDrawer() }, icon('plus'), 'Nueva conversación')),
    ui.list,
    h('p.chat-list-foot.muted.small', 'Se guardan en tu Mac (~/.gbrain-panel/chats). Se listan las 30 últimas.'));
  ui.scrim = h('div.scrim', { onclick: () => closeDrawer() });

  ui.turns = h('div.turns', { 'aria-live': 'polite', 'aria-relevant': 'additions' });
  ui.scroll = h('div.chat-scroll', ui.turns);
  ui.spend = h('span.chat-spend.muted.small');
  ui.title = h('h1.chat-title', conv?.title || 'Nueva conversación');

  ui.input = h('textarea.chat-input', {
    rows: 1, maxlength: MAX_CHARS, placeholder: 'Pregunta a tu cerebro…', 'aria-label': 'Mensaje para el chat',
    enterkeyhint: 'send',
    oninput: () => { autosize(); paintCount(); saveUnsent(ui.input.value); },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send(); }
    },
  });
  ui.count = h('span.char-count.muted.small');
  ui.model = h('select.model-pick', { 'aria-label': 'Modelo', onchange: onModelChange },
    MODELS.map(([v, n, d]) => h('option', { value: v }, `${n} · ${d}`)));
  ui.model.value = model;
  ui.effort = h('select.model-pick', { 'aria-label': 'Esfuerzo', title: 'Cuánto piensa antes de responder. Más esfuerzo: mejor respuesta, más lenta y más cara.', onchange: () => saveEffort(ui.effort.value) },
    EFFORTS.map(([v, n]) => h('option', { value: v }, n)));
  ui.effort.value = loadEffort();
  ui.sendBtn = h('button.btn.primary.send', { type: 'button', onclick: () => (run ? stop() : send()), 'aria-label': 'Enviar' }, icon('send'));

  const free = h('div.free-actions',
    h('span.free-label', 'Gratis, sin modelo:'),
    h('button.btn.tiny', { type: 'button', onclick: async () => (await import('./hechos.js')).openRemember() }, 'Recordar'),
    h('button.btn.tiny', { type: 'button', onclick: async () => (await import('./pendientes.js')).openTaskForm() }, 'Nueva tarea'),
    h('button.btn.tiny', { type: 'button', onclick: async () => (await import('./hoy.js')).openCapture() }, 'Apuntar'),
    h('button.btn.tiny', { type: 'button', onclick: () => openPalette() }, 'Buscar'));

  const composer = h('div.composer',
    free,
    h('div.composer-box',
      ui.input,
      h('div.composer-row', ui.model, ui.effort, ui.count, h('span.grow'), ui.sendBtn)),
    h('p.composer-note.muted.small', 'Claude solo puede usar GBrain: no lee archivos, ni la web, ni envía nada. Cada respuesta muestra su coste estimado.'));

  el.replaceChildren(h('div.chat-layout',
    ui.drawer,
    ui.scrim,
    h('section.chat-main',
      h('header.chat-head',
        h('button.icon-btn.drawer-btn', { type: 'button', 'aria-label': 'Conversaciones', 'aria-controls': 'chat-drawer', onclick: openDrawer }, icon('menu')),
        ui.title,
        ui.spend),
      ui.scroll,
      composer)));

  paintList();
  paintTurns();
  paintSpend();
  paintCount();
}

function openDrawer() {
  el?.querySelector('.chat-layout')?.classList.add('drawer-open');
  ui.drawer.querySelector('a')?.focus();
}
function closeDrawer() { el?.querySelector('.chat-layout')?.classList.remove('drawer-open'); }

function paintList() {
  if (!ui.list) return;
  ui.list.replaceChildren(...(chats.length
    ? chats.slice(0, 30).map((c) => h('a', {
      class: ['chat-item', c.id === convId && 'active'], href: '#/chat/' + encodeURIComponent(c.id),
      'aria-current': c.id === convId ? 'page' : null, onclick: () => closeDrawer(),
    },
    h('span.chat-item-title', c.title || 'Sin título'),
    h('span.chat-item-meta', rel(c.updatedAt || c.createdAt), c.costUsd != null && ` · ${usd(c.costUsd)}`)))
    : [h('p.muted.small.pad', 'Aún no hay conversaciones.')]));
}

function paintSpend() {
  if (!ui.spend) return;
  const pc = getHealth()?.panelChatToday;
  ui.spend.textContent = pc ? `Hoy llevas ${usd(pc.usd)} de ${usd(pc.capUsd)}` : '';
  ui.spend.classList.toggle('warn', !!pc && pc.capUsd && pc.usd >= pc.capUsd * 0.8);
}

function paintCount() {
  const n = ui.input?.value.length || 0;
  ui.count.textContent = n > MAX_CHARS * 0.75 ? `${n} / ${MAX_CHARS}` : '';
}

function autosize() {
  const t = ui.input;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}

function paintTurns() {
  const turns = conv?.turns || [];
  if (!turns.length) {
    ui.turns.replaceChildren(intro());
    return;
  }
  ui.turns.replaceChildren(...turns.map((t) => (t.role === 'user' ? userTurn(t.text) : assistantTurn(t))));
  scrollToEnd(true);
}

function intro() {
  const ask = (text) => { ui.input.value = text; autosize(); send(); };
  return h('div.chat-intro',
    h('h2', 'Pregunta lo que quieras a tu cerebro'),
    h('p', 'Claude busca en tus páginas y hechos y cita de dónde sale cada dato. También lee tu correo de IONOS y tu Calendario. Solo lee: si le pides guardar un hecho, apuntar una nota o enviar un correo, te lo propone y tú lo confirmas con un clic. No edita páginas, no borra ni lee archivos de tu Mac.'),
    h('p.muted.small', 'Sonnet por defecto. Tope: US$2 por conversación y US$5 al día. Opus pide confirmación.'),
    h('div.btn-row',
      h('button.btn.small', { type: 'button', onclick: () => ask('Resúmeme el día') }, 'Resúmeme el día'),
      h('button.btn.small', { type: 'button', onclick: () => ask('¿Qué se me está escapando?') }, '¿Qué se me está escapando?'),
      h('button.btn.small', { type: 'button', onclick: () => { ui.input.value = '¿Qué sé de '; ui.input.focus(); } }, '¿Qué sé de…?')));
}

function userTurn(text) {
  return h('div.turn.user', h('div.bubble.pre', text));
}

/** Turno guardado del asistente. Usa turn.html si el servidor lo guardó; si no, el texto
 *  tal cual (escapado) con los [[slug]] convertidos en enlaces. */
function assistantTurn(t) {
  const tools = (t.tools || []).map((x) => toolChip({ ...x, ok: x.ok ?? true, preview: x.proposed ? 'Propuesta: confírmala abajo si quieres.' : undefined }));
  const hasProposals = (t.proposals || []).length > 0;
  return h('div.turn.assistant',
    tools.length > 0 && h('div.tools', tools),
    t.html ? h('div.answer.prose', raw(t.html))
      : t.text ? h('div.answer.pre', inlineText(t.text))
        : !t.error_es && !t.notice_es && !hasProposals && h('div.answer.muted', 'Sin texto en la respuesta.'),
    proposalCards(t.proposals),
    t.error_es && h('div.banner.small', { class: t.error_es === 'Parado.' ? 'warn' : 'error' }, t.error_es),
    t.notice_es ? noticeNote(t.notice_es, t.denials) : denialNote(t.denials),
    turnMeta(t));
}

/** El mismo aviso que muestra la respuesta en directo (denegaciones, tope, pasos, parada). */
function noticeNote(text, denials) {
  const names = [...new Set((denials || []).map((x) => String(x?.tool_name || x).replace(/^mcp__cerebro__/, '')))];
  return h('div.banner.warn.small', { role: 'note' }, text, names.length > 0 && h('span.muted', ` (${names.join(', ')})`));
}

/* ------------------------------------------------------------- propuestas */
// El asistente no puede escribir: sus llamadas a remember/capture llegan aquí como
// propuestas. «Revisar y guardar» abre el diálogo de siempre, ya relleno; solo se
// guarda si pulsas Guardar/Apuntar allí (POST /api/facts o /api/capture).

function proposalCards(list) {
  if (!list || !list.length) return null;
  return h('div.proposals', list.map(proposalCard));
}

function proposalCard(p) {
  if (p.tool === 'email') return emailCard(p);
  const isFact = p.tool === 'remember';
  const btn = h('button.btn.small.primary', { type: 'button' }, isFact ? 'Revisar y guardar' : 'Revisar y apuntar');
  btn.addEventListener('click', async () => {
    let r = null;
    try {
      r = isFact
        ? await (await import('./hechos.js')).openRemember({ fact: p.fact, entity: p.entity || '', kind: p.kind || 'fact', provenance: p.provenance || '' })
        : await (await import('./hoy.js')).openCapture(p.text || '');
    } catch (e) {
      toast(e?.message || 'No pude abrir el formulario.', { kind: 'error' });
      return;
    }
    if (r) {
      btn.disabled = true;
      btn.textContent = isFact ? 'Guardado ✓' : 'Apuntado ✓';
    }
  });
  const meta = isFact ? [p.entity && `sobre ${p.entity}`, p.kind && p.kind !== 'fact' && (KINDS[p.kind]?.[0] || p.kind)].filter(Boolean).join(' · ') : '';
  return h('div.proposal', { role: 'group', 'aria-label': isFact ? 'Hecho propuesto' : 'Nota propuesta' },
    h('p.proposal-head', h('strong', isFact ? 'Propone guardar un hecho' : 'Propone apuntar una nota'),
      h('span.muted', ' · no se guarda hasta que lo confirmes')),
    h('p.proposal-text', isFact ? `«${p.fact}»` : p.text),
    meta && h('p.muted.small', meta),
    h('div.btn-row', btn));
}

// Correo propuesto: el asistente no envía. «Revisar y enviar» abre el borrador editable y
// solo sale si pulsas Enviar (POST /api/correo/enviar → IONOS, copia en Enviados).
function emailCard(p) {
  const btn = h('button.btn.small.primary', { type: 'button' }, 'Revisar y enviar');
  btn.addEventListener('click', async () => {
    const r = await formDialog({
      title: 'Revisar y enviar correo',
      intro: 'Sale desde __EMAIL__ en cuanto pulses Enviar. Revisa sobre todo el destinatario.',
      submitLabel: 'Enviar',
      cls: 'wide',
      fields: [
        { name: 'para', label: 'Para', type: 'text', value: (p.to || []).join(', '), required: true, maxlength: 1000, spellcheck: 'false' },
        { name: 'cc', label: 'Cc', type: 'text', value: (p.cc || []).join(', '), optional: true, maxlength: 1000, spellcheck: 'false' },
        { name: 'asunto', label: 'Asunto', type: 'text', value: p.subject || '', required: true, maxlength: 300 },
        { name: 'cuerpo', label: 'Texto', type: 'textarea', rows: 14, value: p.body || '', required: true, maxlength: 20000 },
      ],
      onSubmit: async (v) => {
        const res = await post('/api/correo/enviar', { ...v, responder_a_id: p.replyToId || null });
        if (res?.error) throw new Error(res.error.message_es || 'No se pudo enviar.');
        return res;
      },
    });
    if (r) {
      btn.disabled = true;
      btn.textContent = 'Enviado ✓';
      toast('Correo enviado. Tienes la copia en Enviados.');
    }
  });
  const copyBtn = h('button.btn.small', { type: 'button' }, 'Copiar');
  copyBtn.addEventListener('click', async () => {
    const text = `Para: ${(p.to || []).join(', ')}${(p.cc || []).length ? `\nCc: ${p.cc.join(', ')}` : ''}\nAsunto: ${p.subject || ''}\n\n${p.body || ''}`;
    try { await navigator.clipboard.writeText(text); toast('Correo copiado'); }
    catch { toast('No pude copiar: selecciona el texto y usa ⌘C', { kind: 'warn' }); }
  });
  const draftBtn = h('button.btn.small', { type: 'button' }, 'Guardar en Borradores');
  draftBtn.addEventListener('click', async () => {
    draftBtn.disabled = true;
    try {
      await post('/api/correo/borrador', { para: p.to || [], cc: p.cc || [], asunto: p.subject || '', cuerpo: p.body || '', responder_a_id: p.replyToId || null });
      draftBtn.textContent = 'En Borradores ✓';
      toast('Guardado en Borradores: ábrelo en Mail para retocarlo y enviarlo.');
    } catch (e) {
      draftBtn.disabled = false;
      toast(e?.message || 'No pude guardar el borrador.', { kind: 'error' });
    }
  });
  return h('div.proposal', { role: 'group', 'aria-label': 'Correo propuesto' },
    h('p.proposal-head', h('strong', p.replyToId ? 'Propone responder un correo' : 'Propone enviar un correo'),
      h('span.muted', ' · no sale hasta que lo envíes tú')),
    h('p.small', h('strong', 'Para: '), (p.to || []).join(', '), (p.cc || []).length > 0 && h('span', ' · Cc: ' + p.cc.join(', '))),
    h('p.small', h('strong', 'Asunto: '), p.subject || ''),
    h('p.proposal-text', p.body || ''),
    h('div.btn-row', btn, draftBtn, copyBtn));
}

function turnMeta(t) {
  const bits = [];
  if (t.model) bits.push(modelName(t.model));
  if (t.billing) bits.push(t.billing === 'api' ? 'créditos API' : 'plan');
  if (t.costUsd != null) bits.push((t.costEstimated ? '≈ ' : '') + usd(t.costUsd));
  if (t.durationMs != null) bits.push(`${Math.round(t.durationMs / 100) / 10} s`);
  if (!bits.length) return null;
  return h('div.turn-meta', bits.join(' · '), t.costUsd != null && h('span', { title: 'Lo calcula Claude Code; la factura real está en la Console' }, ' · estimación'));
}

function denialNote(denials) {
  if (!denials || !denials.length) return null;
  const names = [...new Set(denials.map((d) => String(d?.tool_name || d).replace(/^mcp__cerebro__/, '')))];
  return h('div.banner.warn.small', { role: 'note' },
    'Esto no lo puede hacer el panel: hazlo desde Claude Code o Telegram.',
    h('span.muted', ` (${names.join(', ')})`));
}

function scrollToEnd(force = false) {
  const s = document.scrollingElement;
  const box = ui.scroll;
  // En escritorio hace scroll la caja del chat; en móvil, la página.
  const target = box && box.scrollHeight > box.clientHeight + 4 ? box : s;
  const near = target.scrollHeight - target.scrollTop - target.clientHeight < 160;
  if (force || near) target.scrollTop = target.scrollHeight;
}

/* ---------------------------------------------------------------- modelo */

async function onModelChange() {
  const next = ui.model.value;
  if (next === 'opus' && !opusDefault && !opusOk.has(convId || 'new')) {
    const ok = await confirmOpus();
    if (!ok) { ui.model.value = model; return; }
  }
  model = next;
}

async function confirmOpus() {
  const ok = await confirmDialog({
    title: '¿Usar Opus en esta conversación?',
    message: 'Opus es el modelo más capaz, pero cuesta aproximadamente el doble que Sonnet por mensaje.',
    detail: 'Sigue valiendo el tope de US$2 por conversación y US$5 al día. Solo te lo pregunto una vez por conversación.',
    confirmLabel: 'Usar Opus',
  });
  if (ok) opusOk.add(convId || 'new');
  return !!ok;
}

/* ------------------------------------------------------------------ envío */

async function send() {
  if (run) return;
  const text = ui.input.value.trim();
  if (!text) { ui.input.focus(); return; }
  if (text.length > MAX_CHARS) { toast(`El mensaje pasa de ${MAX_CHARS} caracteres`, { kind: 'warn' }); return; }
  if (model === 'opus' && !opusDefault && !opusOk.has(convId || 'new') && !(await confirmOpus())) return;

  if (!conv?.turns?.length) ui.turns.replaceChildren();
  const userEl = userTurn(text);
  ui.turns.append(userEl);
  saveUnsent('');
  ui.input.value = '';
  autosize();
  paintCount();
  scrollToEnd(true);
  setBusy(true);

  const body = { text, model };
  if (ui.effort.value) body.effort = ui.effort.value;
  if (convId) body.conversationId = convId;
  if (model === 'opus') body.confirmOpus = true;

  let r;
  try {
    r = await post('/api/chat', body);
  } catch (e) {
    userEl.remove();
    ui.input.value = text;
    saveUnsent(text);
    autosize();
    setBusy(false);
    if (e.status === 412) {
      opusOk.delete(convId || 'new');
      if (await confirmOpus()) { send(); }
      return;
    }
    if (!conv?.turns?.length && !ui.turns.children.length) ui.turns.replaceChildren(intro());
    if (e.status === 409) toast('Ya hay una respuesta en curso (quizá en otra pestaña). Espera a que acabe o detenla.', { kind: 'warn' });
    else if (e.status === 429) {
      ui.turns.append(h('div.banner.warn', { role: 'alert' },
        'Has llegado al tope diario del chat. Mañana se reinicia. Los botones gratis (Recordar, Nueva tarea, Apuntar, Buscar) siguen funcionando.'));
      scrollToEnd(true);
    } else toast(e.message, { kind: 'error' });
    return;
  }

  const wasNew = !convId;
  convId = r.conversationId;
  if (wasNew) {
    if (opusOk.has('new')) { opusOk.delete('new'); opusOk.add(convId); }
    history.replaceState(null, '', '#/chat/' + encodeURIComponent(convId));
    ui.title.textContent = text.length > 60 ? text.slice(0, 60) + '…' : text;
    conv = { id: convId, title: ui.title.textContent, turns: [] };
  }
  conv.turns = [...(conv.turns || []), { role: 'user', text }];
  saveRun({ runId: r.runId, conversationId: convId });
  startStream(r.runId);
  refresh();
}

function setBusy(on) {
  ui.sendBtn.replaceChildren(icon(on ? 'stop' : 'send'));
  ui.sendBtn.setAttribute('aria-label', on ? 'Detener' : 'Enviar');
  ui.sendBtn.title = on ? 'Detener la respuesta' : 'Enviar (Intro)';
  ui.sendBtn.classList.toggle('stop', on);
  ui.sendBtn.disabled = false;
  ui.model.disabled = on;
  ui.effort.disabled = on;
}

async function stop() {
  if (!run) return;
  ui.sendBtn.disabled = true;
  try {
    run.stopping = true;
    await post('/api/chat/stop', { runId: run.runId });
    run.status?.replaceChildren('Deteniendo…');
  } catch (e) {
    toast(e.message, { kind: 'error' });
    ui.sendBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------- SSE */

function reconnect(runId) {
  setBusy(true);
  startStream(runId, { replay: true });
}

function startStream(runId, { replay = false } = {}) {
  const status = h('div.turn-status.muted.small', h('span.typing', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), replay ? 'Recuperando la respuesta…' : 'Pensando…');
  const tools = h('div.tools');
  const textNode = document.createTextNode('');
  const answer = h('div.answer.pre.streaming', textNode);
  const notes = h('div.turn-notes');
  const meta = h('div.turn-meta');
  const turn = h('div.turn.assistant.live', status, tools, answer, notes, meta);
  ui.turns.append(turn);
  scrollToEnd(true);

  const es = new EventSource('/api/chat/stream?run=' + encodeURIComponent(runId));
  run = { runId, es, turn, status, tools, answer, notes, meta, textNode, text: '', toolEls: new Map(), lastId: -1, finished: false };
  const r = run;

  // El servidor numera los eventos (id: n). Si al reconectar repite alguno, lo ignoro.
  const accept = (e) => {
    if (r !== run) return false;
    const id = Number(e.lastEventId);
    if (e.lastEventId !== '' && !Number.isNaN(id)) {
      if (id <= r.lastId) return false;
      r.lastId = id;
    }
    return true;
  };
  const data = (e) => { try { return JSON.parse(e.data || '{}'); } catch { return {}; } };

  const handlers = {
    status: (d) => {
      if (d.model) r.model = d.model;
      const st = typeof d.cerebro === 'string' ? d.cerebro : d.cerebro?.status;
      const cerebro = st && `cerebro ${st === 'connected' ? 'conectado' : st}`;
      const bits = [modelName(d.model), cerebro, d.tools != null && `${d.tools} herramientas`].filter(Boolean);
      r.status.replaceChildren(h('span.typing', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), bits.join(' · ') || 'Pensando…');
    },
    text: (d) => {
      r.text += d.d || '';
      r.textNode.data = r.text; // texto plano: se escapa solo
      scrollToEnd();
    },
    tool: (d) => {
      const chipEl = toolChip(d);
      r.toolEls.set(d.id, chipEl);
      r.tools.append(chipEl);
      scrollToEnd();
    },
    tool_result: (d) => {
      const chipEl = r.toolEls.get(d.id);
      if (chipEl) settleToolChip(chipEl, { ok: d.ok !== false, preview: d.preview, label: d.label_es });
    },
    retry: (d) => {
      r.status.replaceChildren(h('span.typing', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), `Reintentando${d.reason ? ` (${d.reason})` : ''}…`);
    },
    done: (d) => finish(r, d),
  };

  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => { if (accept(e)) fn(data(e)); });
  }
  // Por si el servidor manda eventos sin nombre con {type, …}.
  es.onmessage = (e) => { if (!accept(e)) return; const d = data(e); handlers[d.type]?.(d); };

  // «error» es a la vez el evento propio del servidor (con datos) y el de conexión (sin datos).
  es.addEventListener('error', (e) => {
    if (r !== run || unloading) return;
    if (e.data) {
      if (!accept(e)) return;
      const d = data(e);
      fail(r, d.message_es || 'La ejecución falló.', { stopped: d.code === 'stopped', costUsd: d.costUsd, costEstimated: d.costEstimated });
    } else if (es.readyState === EventSource.CLOSED && !r.finished) {
      // Espero un momento: si la página se está yendo, este código ya no llega a ejecutarse.
      setTimeout(() => {
        if (unloading || r !== run || r.finished) return;
        fail(r, replay ? 'Esa respuesta ya no está disponible. Abajo tienes la conversación guardada.' : 'Se cortó la conexión con la respuesta.', { reload: true });
      }, 400);
    }
    // Si readyState es CONNECTING, el navegador reintenta solo y manda Last-Event-ID.
  });
}

function finish(r, d) {
  r.finished = true;
  r.es.close();
  r.status.remove();
  r.turn.classList.remove('live');
  r.answer.classList.remove('streaming');
  if (d.html != null && String(d.html).trim()) {
    r.answer.classList.remove('pre');
    r.answer.classList.add('prose');
    fill(r.answer, raw(d.html));
  } else if (!r.text.trim()) {
    r.answer.replaceChildren(h('span.muted', 'Sin texto en la respuesta.'));
  }
  // Las herramientas que no recibieron resultado se dan por terminadas.
  for (const chipEl of r.toolEls.values()) if (chipEl.classList.contains('s-pending')) settleToolChip(chipEl, { ok: true });
  const props = proposalCards(d.proposals);
  if (props) r.notes.append(props);
  if (props && r.answer.querySelector('.muted') && !r.text.trim()) r.answer.remove();

  if (d.notice_es) {
    // El servidor ya explica denegaciones, tope de la conversación, pasos o parada.
    const names = (d.denials || []).map((x) => String(x?.tool_name || x).replace(/^mcp__cerebro__/, ''));
    r.notes.append(h('div.banner.warn.small', { role: 'note' }, d.notice_es,
      names.length > 0 && h('span.muted', ` (${[...new Set(names)].join(', ')})`),
      d.subtype === 'error_max_budget_usd' && [' ', h('a.btn.tiny', { href: '#/chat' }, 'Nueva conversación')]));
  } else if (d.denials?.length) {
    r.notes.append(denialNote(d.denials));
  }
  if (d.notice_es) {
    // nada más que añadir
  } else if (d.subtype === 'error_max_budget_usd') {
    r.notes.append(h('div.banner.warn.small', 'Conversación larga: empieza una nueva.', ' ',
      h('a.btn.tiny', { href: '#/chat' }, 'Nueva conversación')));
  } else if (d.subtype === 'error_max_turns') {
    r.notes.append(h('div.banner.warn.small', 'Llegó al máximo de pasos; la respuesta puede estar incompleta.'));
  } else if (r.stopping) {
    r.notes.append(h('p.muted.small', 'La detuviste; lo que ves es lo que llegó a escribir.'));
  } else if (d.subtype && d.subtype !== 'success' && !String(d.subtype).startsWith('success')) {
    r.notes.append(h('div.banner.warn.small', `La ejecución terminó con «${d.subtype}».`));
  }
  const m = turnMeta({ model: r.model || model, costUsd: d.costUsd, costEstimated: d.costEstimated, durationMs: d.durationMs, billing: d.billing });
  if (m) r.meta.replaceWith(m);

  conv?.turns?.push({ role: 'assistant', model: r.model || model, text: r.text, html: d.html, costUsd: d.costUsd, costEstimated: d.costEstimated,
    durationMs: d.durationMs, billing: d.billing, denials: d.denials, proposals: d.proposals || [], notice_es: d.notice_es });
  endRun();
  refreshHealth();
}

function fail(r, message, { reload = false, stopped = false, costUsd, costEstimated } = {}) {
  r.finished = true;
  r.es.close();
  r.status.remove();
  r.turn.classList.remove('live');
  r.answer.classList.remove('streaming');
  if (!r.text.trim()) r.answer.remove();
  for (const chipEl of r.toolEls.values()) if (chipEl.classList.contains('s-pending')) settleToolChip(chipEl, { ok: false });
  r.notes.append(stopped || r.stopping
    ? h('p.muted.small', message === 'Parado.' ? 'La detuviste; lo que ves es lo que llegó a escribir.' : message)
    : h('div.banner.error.small', { role: 'alert' }, message));
  const m = costUsd != null && turnMeta({ model: r.model || model, costUsd, costEstimated });
  if (m) r.meta.replaceWith(m);
  endRun();
  if (reload && convId) {
    get('/api/chats/' + encodeURIComponent(convId)).then((c) => {
      if (c && run == null && el) { conv = c; paintTurns(); }
    }).catch(() => {});
  }
}

function endRun() {
  run = null;
  clearRun();
  if (!ui.sendBtn) return;
  setBusy(false);
  refresh();
  if (!matchMedia('(pointer: coarse)').matches) ui.input.focus({ preventScroll: true });
}
