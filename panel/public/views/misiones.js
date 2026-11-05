// Misiones: las dos páginas que vivían como artifacts en claude.ai (Cola de
// borradores y Mapa de misiones), servidas por el propio panel en un iframe del
// mismo origen, y el Diario de __ORG__.
//
// Las páginas son el HTML original sin tocar; el servidor les inyecta
// /artifacts/claude-shim.js, que guarda sus datos en ~/.gbrain-panel/artdb/.

import { h, get, post, card, raw, emptyState, fmtDay, rel, getTheme, icon } from '../app.js';
import { toast } from '../components/toast.js';

export const title = (r) => (SUBS.find((s) => s.key === sub(r)) || SUBS[0]).label;

const SUBS = [
  { key: 'cola', label: 'Cola de borradores', src: '/artifacts/cola.html' },
  { key: 'mapa', label: 'Mapa de misiones', src: '/artifacts/mapa.html' },
  { key: 'diario', label: 'Diario' },
];

function sub(r) {
  const k = (r?.rest || '').split('/')[0];
  return SUBS.some((s) => s.key === k) ? k : 'cola';
}

let themeObs = null;
let draft = '';

export async function mount(el, r) {
  const k = sub(r);
  const nav = h('nav.seg.mis-seg', { 'aria-label': 'Misiones' },
    SUBS.map((s) => h('a', {
      class: ['seg-btn', s.key === k && 'active'], href: '#/misiones/' + s.key,
      'aria-current': s.key === k ? 'page' : null,
    }, s.label)));
  const body = h('div.mis-body');
  el.replaceChildren(h('div.mis-head', nav), body);
  if (k === 'diario') await drawDiario(body);
  else drawFrame(body, SUBS.find((s) => s.key === k));
}

/** El pulso del panel no recarga los iframes (perderías lo que estás escribiendo). */
export async function refresh(el, r) {
  if (sub(r) !== 'diario') return;
  const body = el.querySelector('.mis-body');
  const a = document.activeElement;
  if (body && !(a && body.contains(a) && a.value)) await drawDiario(body);
}

export function unmount() {
  if (themeObs) { themeObs.disconnect(); themeObs = null; }
}

/* ------------------------------------------------------------ páginas */

function drawFrame(body, s) {
  const frame = h('iframe.mis-frame', { src: s.src, title: s.label, allow: 'clipboard-write' });
  // El tema claro/oscuro del panel también manda dentro de la página.
  const syncTheme = () => {
    try {
      const root = frame.contentDocument?.documentElement;
      if (!root) return;
      const t = getTheme();
      if (t) root.dataset.theme = t; else delete root.dataset.theme;
    } catch { /* otra página: no tocar */ }
  };
  frame.addEventListener('load', syncTheme);
  if (themeObs) themeObs.disconnect();
  themeObs = new MutationObserver(syncTheme);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  body.replaceChildren(frame,
    h('p.muted.small.mis-note', 'Copia local del artifact de claude.ai: los cambios se guardan en tu Mac (~/.gbrain-panel/artdb), no en claude.ai. ',
      h('a', { href: s.src, target: '_blank', rel: 'noopener' }, 'Abrir a pantalla completa', icon('external'))));
}

/* -------------------------------------------------------------- diario */

async function drawDiario(body) {
  const data = await get('/api/diario');
  const entries = data.entries || [];
  const orig = data.original || {};
  const input = h('textarea.grow', {
    rows: 2, maxlength: 1000, placeholder: 'Qué ha pasado, qué has decidido…', 'aria-label': 'Apunte para el diario',
    value: draft, oninput: (e) => { draft = e.target.value; },
  });
  const btn = h('button.btn.primary', { type: 'submit' }, icon('pen'), 'Apuntar');
  const form = h('form.mis-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) { toast('Escribe algo para apuntar', { kind: 'warn' }); return; }
      btn.disabled = true;
      try {
        const r = await post('/api/diario', { text });
        draft = '';
        toast('Apuntado en el diario de hoy');
        await drawDiario(body);
        return r;
      } catch (err) {
        toast(err.message, { kind: 'error' });
      } finally { btn.disabled = false; }
    },
  }, input, btn);

  body.replaceChildren(
    card({ title: 'Apuntar en el diario', note: 'Se añade al final del diario de hoy, con la hora, en la sección «Apuntes desde el panel». Nunca se borra ni se reescribe nada.' },
      !orig.readable && h('div.banner.warn', { role: 'note' },
        orig.message_es || `No puedo abrir la carpeta original del diario (${orig.dir}): ${orig.error || 'error'}. Lo que ves es la copia del cerebro, que se actualiza cada noche.`),
      form),
    entries.length
      ? entries.map((e, i) => card({
        title: e.title, cls: 'mis-entry',
        note: `${fmtDay(e.date, true)} · ${e.source === 'cerebro' ? 'copia del cerebro' : 'original'} · modificado ${rel(e.mtime)}`,
      }, i === 0
        ? h('div.prose', raw(e.html))
        : h('details', h('summary', 'Leer'), h('div.prose', raw(e.html)))))
      : emptyState('El diario está vacío', 'Aquí salen los archivos AAAA-MM-DD.md de la carpeta DIARIO, del más reciente al más antiguo.'));
}
