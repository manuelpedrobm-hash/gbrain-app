// Asistente (#/asistente): rellena formularios web en tu navegador (Dia) y espera tu Aprobar.
// Todo texto que viene del agente o de una web se pinta como texto (h() lo escapa); aquí no
// se usa raw() para nada. Mientras hay una ejecución en marcha se consulta /api/asistente cada
// 1,5 s (solo con la pestaña visible). Aprobar manda el id y el hash de lo que ves en pantalla.

import { h, get, post, pageHead, card, emptyState, icon, fmtDateTime, plural } from '../app.js';
import { toast } from '../components/toast.js';
import { visibles } from '../components/visibles.js';

export const title = 'Asistente';

const ESTADO = {
  preparando: ['Preparando', 'st-doing'], propuesta: ['Esperando tu decisión', 'st-ask'], detenido: ['Detenido', 'st-ask'],
  enviando: ['Enviando', 'st-doing'], enviado: ['Enviado', 'st-done'], no_enviado: ['No enviado', 'st-idea'],
  rechazada: ['Rechazada', 'st-idea'], cancelada: ['Cancelada', 'st-idea'], caducada: ['Caducada', 'st-idea'], error: ['Error', 'st-ask'],
};

let timer = null, tick = null, root = null, data = null, draft = { tarea: '', url: '' }, busy = false;

export async function mount(el) { root = el; await load(); }
export const refresh = mount;
export function unmount() { clearInterval(timer); clearInterval(tick); timer = tick = null; root = null; }

async function load() {
  try { data = await get('/api/asistente'); } catch (e) { if (root) root.replaceChildren(h('div.empty.error', { role: 'alert' }, h('p.empty-title', 'No pude cargar el asistente'), h('p.empty-why', e.message))); return; }
  draw();
  const vivo = data.ocupado || ['preparando', 'enviando'].includes(data.run?.estado);
  if (vivo && !timer) timer = setInterval(() => { if (document.visibilityState === 'visible') poll(); }, 1500);
  if (!vivo && timer) { clearInterval(timer); timer = null; }
}
async function poll() { if (!root) return; const f = root.querySelector('textarea:focus, input:focus'); if (f) return light(); await load(); }
// Con el foco en un campo no se repinta todo: solo se actualizan los pasos.
async function light() { try { data = await get('/api/asistente'); const l = root?.querySelector('.as-steps'); if (l) l.replaceWith(steps(data.run)); } catch { /* siguiente vuelta */ } }

function badge(estado) { const [t, c] = ESTADO[estado] || [estado, 'st-idea']; return h('span', { class: ['badge', c] }, t); }

function draw() {
  const r = data.run;
  const ocupado = data.ocupado || (r && ['preparando', 'enviando'].includes(r.estado));
  const pendiente = r?.estado === 'propuesta';
  root.replaceChildren(...visibles(
    pageHead('Asistente', 'Rellena un formulario web en tu navegador con los datos del cerebro. Nada se envía sin tu Aprobar.'),
    formCard(ocupado || pendiente),
    r && estadoCard(r),
    r?.propuesta && propuestaCard(r),
    domCard(),
    histCard(),
  ));
  clearInterval(tick); tick = null;
  if (pendiente) tick = setInterval(() => { const e = root?.querySelector('.as-left'); if (e) e.textContent = left(r.expira); if (Date.parse(r.expira) <= Date.now()) load(); }, 1000);
}

function formCard(bloqueado) {
  const ta = h('textarea.input', { rows: 3, maxlength: 1500, placeholder: 'Rellena la solicitud X en la web con los datos de __ORG__', 'aria-label': 'Tarea', disabled: bloqueado, value: draft.tarea, oninput: (e) => { draft.tarea = e.target.value; } });
  const url = h('input.input', { type: 'url', maxlength: 500, placeholder: 'https://… (opcional si ya está en la tarea)', 'aria-label': 'Dirección del formulario', disabled: bloqueado, value: draft.url, oninput: (e) => { draft.url = e.target.value; } });
  const go = h('button.btn.primary', { type: 'button', disabled: bloqueado || busy, onclick: async () => {
    busy = true; go.disabled = true;
    try { await post('/api/asistente/preparar', { tarea: draft.tarea, url: draft.url || undefined }); draft = { tarea: '', url: '' }; await load(); }
    catch (e) { toast(e.message, { kind: 'error' }); }
    busy = false; if (root) go.disabled = false;
  } }, icon('send'), 'Preparar');
  return card({ title: 'Nueva tarea', note: `Datos de: ${data.fuente}. ${data.fuente !== 'cerebro' ? 'MODO PRUEBA: datos ficticios, no es la ficha real. ' : ''}Si falta un dato, te lo dice en vez de inventarlo.` },
    h('div.as-form', ta, url, h('div.btn-row', go)));
}

function steps(r) {
  return h('ol.as-steps', { 'aria-live': 'polite' }, (r?.pasos || []).slice(-14).map((p) => h('li', { class: p.bloqueado ? 'blocked' : '' }, h('span.muted.small', new Date(p.ts).toLocaleTimeString('es-ES')), ' ', p.texto)));
}

function estadoCard(r) {
  const vivo = ['preparando', 'enviando'].includes(r.estado);
  const cancel = vivo && h('button.btn.small', { type: 'button', onclick: async () => { try { await post('/api/asistente/cancelar', { id: r.id }); toast('Cancelado'); await load(); } catch (e) { toast(e.message, { kind: 'error' }); } } }, icon('stop'), 'Cancelar');
  const cerrar = r.pestanaAbierta && !r.cerrando && !vivo && h('button.btn.small', { type: 'button', title: 'Cierra la pestaña del navegador que usó el asistente', onclick: async () => { try { await post('/api/asistente/cerrar', { id: r.id }); toast('Cerrando la pestaña'); await load(); } catch (e) { toast(e.message, { kind: 'error' }); } } }, icon('x'), 'Cerrar pestaña');
  return card({ title: 'Ejecución', actions: visibles(badge(r.estado), cancel, cerrar), note: `${r.tarea}` },
    r.error_es && h('p.banner.small', { role: 'alert' }, r.error_es),
    r.diferencias?.length > 0 && h('div', h('p.small', 'La página no coincide con lo aprobado:'), h('ul', r.diferencias.map((d) => h('li', d)))),
    r.confirmacion && h('p.small', h('strong', 'La web dice: '), r.confirmacion),
    r.cerrando && h('p.muted.small', 'Cerrando la pestaña…'),
    r.pestanaAbierta && !r.cerrando && h('p.muted.small', 'La pestaña sigue abierta en tu navegador para que veas la confirmación de la web. Ciérrala tú o con «Cerrar pestaña».'),
    r.registro && h('p.muted.small', r.registro === 'ok' ? 'Anotado en notes/formularios-registro.' : `No pude anotarlo en el registro (${r.registro}).`),
    steps(r));
}

function left(expira) { const s = Math.max(0, Math.round((Date.parse(expira) - Date.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function propuestaCard(r) {
  const p = r.propuesta, pend = r.estado === 'propuesta';
  const act = async (que, body) => {
    try { await post('/api/asistente/' + que, { id: r.id, ...body }); toast(que === 'aprobar' ? 'Aprobado: comprobando y enviando' : 'Rechazada'); } catch (e) { toast(e.message, { kind: 'error' }); }
    await load();
  };
  const faltan = p.faltan.length > 0;
  const aceptar = faltan && h('input', { type: 'checkbox', id: 'as-acepta', 'aria-label': 'Acepto enviarlo incompleto' });
  return card({ title: 'Propuesta', actions: pend ? h('span.small.muted', 'Caduca en ', h('span.as-left', left(r.expira))) : null,
    note: pend ? 'Revisa cada valor. Aprobar vale solo para esta propuesta y se usa una vez.' : undefined },
    h('dl.as-meta', h('dt', 'Web'), h('dd', p.url), h('dt', 'Formulario'), h('dd', p.formulario), h('dt', 'Botón que se pulsaría'), h('dd', p.boton_envio ? `«${p.boton_envio}»` : '—'),
      h('dt', 'Referencia del botón'), h('dd', p.boton_ref ? h('code', p.boton_ref) : '—'),
      pend && h('dt', 'Huella'), pend && h('dd', h('code', r.hashCorto))),
    p.campos.length ? h('table.mini', h('thead', h('tr', ['Campo', 'Valor', 'De dónde sale'].map((t) => h('th', t)))),
      h('tbody', p.campos.map((c) => h('tr', h('td', c.etiqueta), h('td.as-val', c.valor), h('td.muted', c.fuente))))) : h('p.muted', 'No se rellenó ningún campo.'),
    faltan && h('div.banner.small', h('strong', 'Faltan datos: '), p.faltan.join(' · ')),
    p.aviso.length > 0 && h('div.banner.small', { role: 'alert' }, h('strong', 'Avisos: '), h('ul', p.aviso.map((a) => h('li', a)))),
    p.detenido && h('p.banner.small', 'El asistente se detuvo: lo que falta lo tienes que hacer tú en la web. Aquí no hay nada que aprobar.'),
    (pend || r.estado === 'detenido') && h('div.btn-row.as-actions',
      pend && h('button.btn.primary', { type: 'button', onclick: () => { if (faltan && !aceptar.checked) { toast('Marca la casilla para enviar incompleto', { kind: 'error' }); return; } act('aprobar', { hash: r.hash, aceptaFaltas: faltan ? true : undefined }); } }, icon('check'), 'Aprobar y enviar'),
      faltan && pend && h('label.small', aceptar, ' Acepto enviarlo incompleto'),
      h('button.btn', { type: 'button', onclick: () => act('rechazar', {}) }, icon('x'), 'Rechazar')));
}

function domCard() {
  const d = data.dominios;
  return card({ title: 'Dominios aprobados', count: d.permitidos.length, note: 'Solo lectura. La lista se cambia fuera del panel, con tu sí (página notes/formularios-dominios). Un filtro rechaza cualquier otra web.' },
    d.ok ? h('div.chips', d.permitidos.map((x) => h('span.chip', x))) : h('p.banner.small', { role: 'alert' }, d.error_es),
    d.ok && h('p.muted.small', `Bloqueados siempre: ${plural(d.bloqueados.length, 'palabra', 'palabras')} (bancos, pagos, correo, redes…).`));
}

function histCard() {
  if (!data.history.length) return null;
  return card({ title: 'Últimos formularios', count: data.history.length },
    h('table.mini', h('thead', h('tr', ['Fecha', 'Web', 'Formulario', 'Aprobado', 'Enviado'].map((t) => h('th', t)))),
      h('tbody', data.history.slice(0, 10).map((x) => h('tr', h('td', fmtDateTime(x.fecha)), h('td', x.web), h('td', x.formulario + (x.fuente !== 'cerebro' ? ' (prueba)' : '')), h('td', x.aprobada ? 'sí' : 'no'), h('td', x.enviado ? 'sí' : 'no'))))));
}
