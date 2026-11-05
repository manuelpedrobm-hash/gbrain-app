// Diario: los archivos AAAA-MM-DD.md de la carpeta DIARIO, del más reciente al más antiguo,
// y un cuadro para apuntar algo en el de hoy.

import { h, get, post, card, raw, emptyState, fmtDay, rel, icon } from '../app.js';
import { toast } from '../components/toast.js';

export const title = 'Diario';

let draft = '';

export async function mount(el) {
  const body = h('div.mis-body');
  el.replaceChildren(body);
  await drawDiario(body);
}

/** El pulso del panel no pisa lo que estás escribiendo. */
export async function refresh(el) {
  const body = el.querySelector('.mis-body');
  const a = document.activeElement;
  if (body && !(a && body.contains(a) && a.value)) await drawDiario(body);
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
    ...(entries.length
      ? entries.map((e, i) => card({
        title: e.title, cls: 'mis-entry',
        note: `${fmtDay(e.date, true)} · ${e.source === 'cerebro' ? 'copia del cerebro' : 'original'} · modificado ${rel(e.mtime)}`,
      }, i === 0
        ? h('div.prose', raw(e.html))
        : h('details', h('summary', 'Leer'), h('div.prose', raw(e.html)))))
      : [emptyState('El diario está vacío', 'Aquí salen los archivos AAAA-MM-DD.md de la carpeta DIARIO, del más reciente al más antiguo.')]));
}
