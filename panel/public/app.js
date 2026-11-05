// Cerebro — núcleo del frontend del panel local de GBrain.
//
// Sin build ni dependencias. Aquí viven:
//   - h(): crea nodos DOM; todo texto se inserta como texto (escapado por defecto).
//     El único HTML que entra sin escapar es el que pasa por raw(), y solo se usa con
//     HTML ya saneado por el servidor (lib/render.ts) o con fragmentos escapados aquí.
//   - el cliente de la API (cookie same-origin; los POST llevan X-Panel y JSON).
//   - el enrutado por hash, el pulso cada 20 s (solo con la pestaña visible),
//     la franja de salud y el tema claro/oscuro.
//
// Nota sobre importaciones circulares: los componentes importan helpers de este
// archivo y este archivo importa palette.js y toast.js. Funciona porque todo lo que
// se exporta aquí son declaraciones de función (se inicializan antes de evaluar) y
// ningún módulo las llama al cargarse.

import { openPalette, invalidateIndex } from './components/palette.js';
import { toast } from './components/toast.js';

/* ------------------------------------------------------------------ DOM */

const RAW = '__cerebroRawHtml';
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'autofocus',
  'required', 'hidden', 'open', 'multiple', 'readOnly', 'tabIndex']);

/** Marca HTML de confianza (renderizado y saneado en el servidor). */
export function raw(html) { return { [RAW]: String(html ?? '') }; }

/** Escapa texto para meterlo dentro de un fragmento HTML propio. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * h('div.card.big', {attrs}, ...hijos)
 * - Los hijos string/number se insertan como nodos de texto (nunca como HTML).
 * - on<evento>: función → addEventListener.  style: objeto → CSSOM (CSP no permite style="").
 * - href solo admite #, /, http(s): y mailto:.
 */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs) || RAW in attrs) {
    children.unshift(attrs);
    attrs = {};
  }
  const [name, ...classes] = String(tag).split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') {
      const list = (Array.isArray(v) ? v : [v]).filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
      if (list.length) el.classList.add(...list);
    } else if (k === 'style') {
      if (typeof v === 'string') {
        // 'width:6em; color:red' → CSSOM, property by property (CSP blocks style="").
        for (const decl of v.split(';')) {
          const i = decl.indexOf(':');
          if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
        }
      } else {
        for (const [p, val] of Object.entries(v)) {
          if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val;
        }
      }
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = dv;
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'ref') {
      v(el);
    } else if (k === 'href' || k === 'action') {
      if (safeHref(v)) el.setAttribute(k, v);
    } else if (PROPS.has(k)) {
      el[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

/** Sustituye los hijos de `el` con las mismas reglas que h() (texto escapado, raw(), arrays, false ignorado). */
export function fill(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
  return el;
}

function safeHref(v) { return /^(#|\/(?!\/)|https?:|mailto:)/i.test(String(v)); }

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.append(c);
    else if (typeof c === 'object' && RAW in c) {
      const t = document.createElement('template');
      t.innerHTML = c[RAW];
      el.append(t.content);
    } else el.append(document.createTextNode(String(c)));
  }
}

/** Crea elementos SVG (mismo contrato que h, sin clases en el nombre). */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'href') { if (safeHref(v)) el.setAttribute('href', v); }
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z"/>',
  hoy: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 2.5v4M16 2.5v4"/><path d="M8.5 14h3"/>',
  pendientes: '<path d="M11 6.5h9M11 12h9M11 17.5h9"/><path d="m3.8 6.5 1.4 1.4 2.6-2.6M3.8 12l1.4 1.4 2.6-2.6M3.8 17.5l1.4 1.4 2.6-2.6"/>',
  diario: '<path d="M5 21V4"/><path d="M5 4.5h11l-2 4 2 4H5"/>',
  mensajes: '<path d="M20.5 11.6a8.3 8.3 0 0 1-12.2 7.3L3.5 20.5l1.6-4.6a8.3 8.3 0 1 1 15.4-4.3z"/>',
  memoria: '<path d="M2.5 5h5.5a4 4 0 0 1 4 4v11.5a3 3 0 0 0-3-3H2.5zM21.5 5H16a4 4 0 0 0-4 4v11.5a3 3 0 0 1 3-3h6.5z"/>',
  chat: '<path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z"/><path d="M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>',
  estado: '<path d="M21.5 12h-4l-3 8.5-5-17-3 8.5h-4"/>',
  asistente: '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M8 8.5h8M8 12h8M8 15.5h4"/><path d="m14.5 17.5 1.5 1.5 3-3"/>',
  estrategia: '<path d="M4.5 20.5V3.5"/><path d="M4.5 5h12.5l-2.2 3.8 2.2 3.7H4.5"/><circle cx="17.5" cy="18" r="2.2"/><path d="M12 18h3.3"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5"/>',
  send: '<path d="M12 19V5.5M5.5 12 12 5.5l6.5 6.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  refresh: '<path d="M19.5 11a7.5 7.5 0 1 0-2.2 5.6M19.5 4.5V11H13"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  pen: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  note: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8.5h5M9 13h7M9 16.5h5"/>',
};

/** Icono SVG de trazo (decorativo, aria-hidden). */
export function icon(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ico ${esc(cls)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

/* ---------------------------------------------------------------- texto */

/** Minúsculas sin tildes, para buscar sin importar acentos. */
export function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Quita marcas de markdown de una línea suelta (viñetas de páginas, etc.). */
export function plainMd(s) {
  return String(s ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
}

const WIKI = /\[\[([a-z0-9][a-z0-9._/-]*)(?:\|([^\]]+))?\]\]/g;

/** Texto plano con [[slug]] convertidos en enlaces internos. El resto, texto. */
export function inlineText(s) {
  const out = [];
  let last = 0;
  const str = String(s ?? '');
  for (const m of str.matchAll(WIKI)) {
    if (m.index > last) out.push(str.slice(last, m.index));
    out.push(h('a.wikilink', { href: '#/p/' + m[1] }, m[2] || m[1]));
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push(str.slice(last));
  return out;
}

export function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/* --------------------------------------------------------------- fechas */
// Siempre en la zona horaria del navegador: el usuario puede viajar entre zonas horarias.

/** Marca de tiempo (ISO, número o Date) → Date. 'YYYY-MM-DD' se toma como día local. */
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/** Día de calendario (columnas date, 'YYYY-MM-DD…'): toma los 10 primeros caracteres como día local. */
export function parseDay(v) {
  if (v == null || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v instanceof Date ? v.toISOString() : v));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

/** Días de calendario desde hoy hasta ese día (negativo si ya pasó). */
export function daysFrom(v) {
  const d = parseDay(v);
  if (!d) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}

function rtf() { return new Intl.RelativeTimeFormat('es', { numeric: 'auto' }); }

/** «hace 3 horas», «ayer», «dentro de 2 días». */
export function rel(v) {
  const d = parseDate(v);
  if (!d) return '';
  const diff = (d - Date.now()) / 1000;
  const a = Math.abs(diff);
  if (a < 45) return 'ahora mismo';
  if (a < 3600) return rtf().format(Math.round(diff / 60), 'minute');
  if (a < 86400) return rtf().format(Math.round(diff / 3600), 'hour');
  const days = daysFrom(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  if (Math.abs(days) < 7) return rtf().format(days, 'day');
  if (a < 86400 * 30) return rtf().format(Math.round(diff / 86400 / 7), 'week');
  if (a < 86400 * 365) return rtf().format(Math.round(diff / 86400 / 30), 'month');
  return rtf().format(Math.round(diff / 86400 / 365), 'year');
}

/** Relativo en días de calendario: «hoy», «mañana», «dentro de 5 días». */
export function relDay(v) {
  const n = daysFrom(v);
  return n == null ? '' : rtf().format(n, 'day');
}

function pad(n) { return String(n).padStart(2, '0'); }

/** «mar, 28 oct» (o con año si no es este año). long=true: «martes, 28 de octubre de 2026». */
export function fmtDay(v, long = false) {
  const d = parseDay(v) || parseDate(v);
  if (!d) return String(v ?? '');
  const opts = long
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
  return new Intl.DateTimeFormat('es', opts).format(d);
}

export function fmtTime(v) {
  const d = parseDate(v);
  return d ? new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(d) : '';
}

export function fmtDateTime(v) {
  const d = parseDate(v);
  return d ? new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d) : '';
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD HH:MM' local, para la procedencia por defecto. */
export function stamp() {
  const d = new Date();
  return `${todayISO()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function usd(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '—';
  const v = Number(n);
  const dec = v > 0 && v < 0.01 ? 3 : 2;
  return 'US$' + v.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/* ------------------------------------------------------------------ API */

export class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const DEFAULT_ERR = {
  400: 'La petición no es válida.',
  401: 'Tu sesión no es válida. Abre el panel con «Abrir panel».',
  403: 'El panel rechazó la petición por seguridad. Recarga la página.',
  404: 'No encontrado.',
  409: 'Otra operación está en curso.',
  413: 'El texto es demasiado largo.',
  429: 'Demasiadas peticiones; espera un poco.',
  502: 'GBrain no respondió bien. Mira Estado.',
  504: 'GBrain tardó demasiado en responder.',
};

/** fetch a la API del panel. Lanza ApiError con un mensaje en español. */
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    // El navegador añade Origin solo; el servidor exige además X-Panel y JSON.
    init.headers['X-Panel'] = '1';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'No hay conexión con el panel. ¿Está en marcha?');
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) {
    try { data = await res.json(); } catch { data = null; }
  }
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    const msg = data?.error?.message_es || DEFAULT_ERR[res.status] || `Error ${res.status}.`;
    throw new ApiError(res.status, data?.error?.code || String(res.status), msg, data);
  }
  return data;
}

export function get(path) { return api(path); }
export function post(path, body) { return api(path, { method: 'POST', body }); }

let unauthorizedShown = false;
function onUnauthorized() {
  if (unauthorizedShown) return;
  unauthorizedShown = true;
  stopPulse();
  const root = document.getElementById('view');
  root.replaceChildren(h('div.view', h('div.empty.big',
    h('p.empty-title', 'Tu sesión ha caducado'),
    h('p.empty-why', 'El panel solo se abre desde tu Mac con «Abrir panel» (doble clic en el archivo de la carpeta panel). Así nadie más puede entrar.'),
    h('p.empty-why.muted', 'Si cambiaste el archivo secreto, todas las sesiones se cierran: es normal.'))));
}

/* ------------------------------------------------------------- helpers UI */

export function loading(text = 'Cargando…') {
  return h('div.loading', { role: 'status' }, h('span.spinner', { 'aria-hidden': 'true' }), text);
}

export function emptyState(title, why, action) {
  return h('div.empty', h('p.empty-title', title), why && h('p.empty-why', why), action && h('div.empty-action', action));
}

export function errorState(err, retry) {
  return h('div.empty.error', { role: 'alert' },
    h('p.empty-title', 'No pude cargar esto'),
    h('p.empty-why', err?.message || String(err)),
    retry && h('div.empty-action', h('button.btn', { type: 'button', onclick: retry }, icon('refresh'), 'Reintentar')));
}

/** Tarjeta con cabecera: card({title, count, note, actions, cls, id}, ...cuerpo) */
export function card({ title, count, note, actions, cls, id } = {}, ...body) {
  return h('section', { class: ['card', cls], id },
    (title || actions) && h('header.card-head',
      h('h2.card-title', title, count != null && h('span.count', String(count))),
      actions && h('div.card-actions', actions)),
    note && h('p.card-note', note),
    ...body);
}

export function pageHead(title, sub, actions) {
  return h('div.page-head',
    h('div.page-head-text', h('h1', title), sub && h('p.page-sub', sub)),
    actions && h('div.page-actions', actions));
}

export function slugLink(slug, title) {
  return h('a.slug-link', { href: '#/p/' + slug }, title || slug);
}

/** ¿El foco está en un campo de texto? (para no robar teclas al escribir) */
export function isTyping(t = document.activeElement) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado');
  } catch {
    toast('No pude copiar al portapapeles', { kind: 'warn' });
  }
}

/** Apunta una nota rápida en inbox/ (gbrain capture). */
export async function capture(text) {
  const r = await post('/api/capture', { text });
  toast(r?.slug ? `Apuntado en ${r.slug}` : 'Apuntado');
  return r;
}

/* ----------------------------------------------------------------- chat */
// Otras vistas abren el chat con un texto preparado (y opcionalmente lo envían).

let chatDraft = null;
export function takeChatDraft() { const d = chatDraft; chatDraft = null; return d; }

/** Abre una conversación nueva con `text` en la caja; send=true lo envía (usa el modelo). */
export function askChat(text, { send = false } = {}) {
  chatDraft = { text, send };
  if (location.hash === '#/chat') route(); else go('#/chat');
}

/* --------------------------------------------------------------- router */

const ROUTES = {
  hoy: () => import('./views/hoy.js'),
  pendientes: () => import('./views/pendientes.js'),
  diario: () => import('./views/diario.js'),
  mensajes: () => import('./views/mensajes.js'),
  memoria: () => import('./views/memoria.js'),
  p: () => import('./views/pagina.js'),
  hechos: () => import('./views/hechos.js'),
  chat: () => import('./views/chat.js'),
  estrategia: () => import('./views/estrategia.js'),
  informes: () => import('./views/informes.js'),
  reuniones: () => import('./views/reuniones.js'),
  asistente: () => import('./views/asistente.js'),
  estado: () => import('./views/estado.js'),
};
const TAB_OF = { p: 'memoria', hechos: 'memoria' };

let current = { name: null, mod: null, route: null, el: null };
let seq = 0;

export function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
export function currentRoute() { return current.route; }

function parseHash() {
  const rawHash = location.hash.replace(/^#\/?/, '');
  const qi = rawHash.indexOf('?');
  const path = qi < 0 ? rawHash : rawHash.slice(0, qi);
  const query = new URLSearchParams(qi < 0 ? '' : rawHash.slice(qi + 1));
  const segs = path.split('/');
  const name = segs[0] || 'hoy';
  const rest = segs.slice(1).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
  return { name, rest, query, hash: location.hash };
}

async function route() {
  if (unauthorizedShown) return;
  if (!location.hash.startsWith('#/')) { history.replaceState(null, '', '#/hoy'); }
  const r = parseHash();
  const loader = ROUTES[r.name];
  if (!loader) { location.replace('#/hoy'); return; }
  const mySeq = ++seq;
  try { current.mod?.unmount?.(); } catch (e) { console.error(e); }
  setActiveTab(TAB_OF[r.name] || r.name);
  // Cada montaje recibe su propio contenedor: si el usuario navega antes de que
  // termine la carga, la vista vieja escribe en un nodo desconectado y no molesta.
  const el = h('div.view', { dataset: { view: r.name } }, loading());
  const root = document.getElementById('view');
  root.replaceChildren(el);
  window.scrollTo(0, 0);
  current = { name: r.name, mod: null, route: r, el };
  let mod;
  try {
    mod = await loader();
  } catch (e) {
    if (mySeq === seq) el.replaceChildren(errorState(new Error('No pude cargar esta sección del panel.'), route));
    return;
  }
  if (mySeq !== seq) return;
  current.mod = mod;
  const title = typeof mod.title === 'function' ? mod.title(r) : mod.title;
  document.title = title ? `${title} · Cerebro` : 'Cerebro';
  try {
    await mod.mount(el, r);
  } catch (e) {
    console.error(e);
    if (mySeq === seq && !unauthorizedShown) el.replaceChildren(errorState(e, () => route()));
  }
}

function setActiveTab(tab) {
  for (const a of document.querySelectorAll('#tabs a')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

let pendingRefresh = false;

/** Vuelve a pedir los datos de la vista actual sin parpadeo. quiet: no molestar si estás escribiendo. */
export async function refreshView({ quiet = false } = {}) {
  const { mod, el, route: r } = current;
  if (!mod || !el) return;
  if (quiet && busy()) { pendingRefresh = true; return; }
  pendingRefresh = false;
  const y = window.scrollY;
  try {
    if (mod.refresh) await mod.refresh(el, r);
    else await mod.mount(el, r);
  } catch (e) {
    if (!quiet) toast(e.message, { kind: 'error' });
  }
  if (quiet) window.scrollTo(0, y);
}

function busy() {
  if (document.querySelector('dialog[open], .menu')) return true;
  const a = document.activeElement;
  return !!(a && current.el?.contains(a) && isTyping(a) && a.value);
}

/* ---------------------------------------------------------------- pulso */
// Cada 20 s, y solo con la pestaña visible, pregunta /api/pulse. Si la huella cambia,
// recarga la vista actual, la salud y (en diferido) el índice de la paleta.

let lastFp = null;
let pulseTimer = null;
let ticks = 0;

async function pulse() {
  if (document.visibilityState !== 'visible' || unauthorizedShown) return;
  ticks++;
  try {
    const { fp } = await get('/api/pulse');
    if (lastFp && fp !== lastFp) {
      invalidateIndex();
      refreshHealth();
      refreshView({ quiet: true });
    } else if (pendingRefresh) {
      refreshView({ quiet: true });
    } else if (ticks % 3 === 0) {
      refreshHealth(); // la salud cambia sin tocar la base (Telegram, copias): cada minuto
    }
    lastFp = fp;
  } catch { /* sin conexión: la franja de salud lo mostrará en la próxima vuelta */ }
}

function startPulse() {
  stopPulse();
  pulseTimer = setInterval(pulse, 20000);
}
function stopPulse() { if (pulseTimer) clearInterval(pulseTimer); pulseTimer = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { pulse(); startPulse(); } else stopPulse();
});

/* ---------------------------------------------------------------- salud */

let health = null;
export function getHealth() { return health; }

const STATUS_ES = { ok: 'bien', warn: 'aviso', error: 'fallo' };

export async function refreshHealth() {
  const el = document.getElementById('health');
  try {
    health = await get('/api/health');
  } catch (e) {
    if (e.status === 401) return;
    health = null;
    el.replaceChildren(h('span.hc', h('span.dot.s-error'), h('span.hl.always', 'sin conexión')));
    el.title = e.message;
    return;
  }
  const checks = health.checks || [];
  const tg = health.telegramCostToday;
  const pc = health.panelChatToday;
  el.replaceChildren(
    h('span.dots', checks.map((c) => h('span.hc', { title: `${c.label_es}: ${c.detail_es || STATUS_ES[c.status] || c.status}` },
      h('span', { class: ['dot', 's-' + c.status] }), h('span.hl', c.label_es)))),
    // Con poco ancho el texto se recorta con «…»; el título lo da entero.
    h('span.health-text', { title: [tg && `Telegram hoy ≈ ${usd(tg.usd)} (estimación)`, pc && `Chat ${usd(pc.usd)} de ${usd(pc.capUsd)}`].filter(Boolean).join(' · ') },
      tg && h('span', `Telegram hoy ≈ ${usd(tg.usd)}`),
      pc && h('span', `Chat ${usd(pc.usd)} de ${Number.isInteger(pc.capUsd) ? 'US$' + pc.capUsd : usd(pc.capUsd)}`)));
  const bad = checks.filter((c) => c.status !== 'ok');
  el.setAttribute('aria-label', 'Estado del sistema: ' + (bad.length
    ? bad.map((c) => `${c.label_es} ${STATUS_ES[c.status] || c.status}`).join(', ')
    : 'todo bien') + '. Abrir Estado.');
  el.removeAttribute('title');
  window.dispatchEvent(new CustomEvent('cerebro:health', { detail: health }));
}

/* ----------------------------------------------------------------- tema */

const THEME_KEY = 'cerebro.theme';

function storedTheme() { try { return localStorage.getItem(THEME_KEY); } catch { return null; } }

/** t: 'light' | 'dark' | null (null = seguir al sistema). */
export function setTheme(t) {
  try { if (t) localStorage.setItem(THEME_KEY, t); else localStorage.removeItem(THEME_KEY); } catch { /* sin almacenamiento */ }
  applyTheme(t);
}
export function getTheme() { return document.documentElement.dataset.theme || null; }

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const dark = effectiveDark();
    btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    btn.setAttribute('aria-label', dark ? 'Usar tema claro' : 'Usar tema oscuro');
    btn.title = dark ? 'Tema claro' : 'Tema oscuro';
  }
}

function effectiveDark() {
  const t = getTheme();
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function toggleTheme() { setTheme(effectiveDark() ? 'light' : 'dark'); }

/* ------------------------------------------------------------- arranque */

function boot() {
  applyTheme(storedTheme());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getTheme()));
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('open-palette').addEventListener('click', () => openPalette());
  const searchBtn = document.getElementById('open-palette');
  searchBtn.prepend(icon('search'));

  for (const a of document.querySelectorAll('#tabs a')) a.prepend(icon(a.dataset.tab));

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !isTyping(e.target) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      openPalette();
    }
  });

  window.addEventListener('hashchange', route);
  route();
  refreshHealth();
  pulse();
  startPulse();
}

boot();
