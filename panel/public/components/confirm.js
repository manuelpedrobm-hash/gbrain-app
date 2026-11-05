// Diálogos modales (<dialog> nativo: Esc cierra y el foco queda atrapado dentro)
// y un menú emergente pequeño para el botón «⋯» de las filas.

import { h } from '../app.js';

let uid = 0;

/** Abre un <dialog> modal; build(dlg, done) lo rellena; done(valor) lo cierra y resuelve. */
function openDialog(cls, build) {
  const dlg = h('dialog', { class: ['dlg', cls] });
  document.body.append(dlg);
  return new Promise((resolve) => {
    // Se resuelve en el acto (sin esperar al evento «close», que algunos navegadores
    // entregan con retraso). Esc dispara «cancel» y la X nativa «close»: ambos acaban aquí.
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.addEventListener('close', () => done(null));
    // Un clic en el fondo (fuera de la caja) cierra sin hacer nada.
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.dataset.downOutside = '1'; });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && dlg.dataset.downOutside === '1') done(null);
      delete dlg.dataset.downOutside;
    });
    build(dlg, done);
    dlg.showModal();
  });
}

/**
 * Confirmación. Devuelve null si cancelas, o {reason} si confirmas.
 * reason: {label, required, placeholder, max} añade un campo de motivo.
 */
export function confirmDialog({ title, message, detail, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false, reason = null }) {
  return openDialog('confirm', (dlg, done) => {
    const err = h('p.dlg-error', { role: 'alert' });
    const input = reason ? h('textarea', { rows: 2, maxlength: reason.max || 300, placeholder: reason.placeholder || '', autofocus: true }) : null;
    const form = h('form.dlg-body', {
      onsubmit: (e) => {
        e.preventDefault();
        const r = input ? input.value.trim() : '';
        if (reason?.required && !r) { err.textContent = 'Escribe un motivo: queda guardado junto al cambio.'; input.focus(); return; }
        done({ reason: r });
      },
    },
    h('h2.dlg-title', title),
    message && h('p.dlg-msg', message),
    detail && h('p.dlg-detail', detail),
    input && h('label.field', h('span.field-label', reason.label || 'Motivo'), input),
    err,
    h('div.dlg-actions',
      h('button.btn', { type: 'button', onclick: () => done(null) }, cancelLabel),
      h('button', { class: ['btn', danger ? 'danger' : 'primary'], type: 'submit', autofocus: !input }, confirmLabel)));
    dlg.append(form);
  });
}

/**
 * Formulario en un diálogo.
 * fields: [{name, label, type:'text'|'textarea'|'select'|'date'|'checkbox', value, required, optional,
 *           maxlength, placeholder, hint, options:[[valor, etiqueta]], datalist:[{value,label}],
 *           pattern: RegExp, patternMsg, resolve: (valor) => valor normalizado antes de validar}]
 * onSubmit(values) puede lanzar un Error: su mensaje se muestra dentro y el diálogo sigue abierto.
 * Resuelve con lo que devuelva onSubmit (o los valores), o null si cancelas.
 */
export function formDialog({ title, intro, fields, submitLabel = 'Guardar', onSubmit, danger = false, cls }) {
  return openDialog(['form', cls].filter(Boolean).join(' '), (dlg, done) => {
    const inputs = {};
    const err = h('p.dlg-error', { role: 'alert' });
    const submit = h('button', { class: ['btn', danger ? 'danger' : 'primary'], type: 'submit' }, submitLabel);
    const form = h('form.dlg-body', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const values = {};
        for (const f of fields) {
          const el = inputs[f.name];
          let v = f.type === 'checkbox' ? el.checked : el.value.trim();
          if (f.resolve && v) { v = f.resolve(v); el.value = v; }
          values[f.name] = v;
          if (f.required && !v) { err.textContent = `Falta: ${f.label.toLowerCase()}.`; el.focus(); return; }
          if (f.pattern && v && !f.pattern.test(v)) { err.textContent = f.patternMsg || `Revisa: ${f.label.toLowerCase()}.`; el.focus(); return; }
        }
        submit.disabled = true;
        submit.classList.add('busy');
        try {
          const r = onSubmit ? await onSubmit(values) : values;
          done(r ?? values);
        } catch (ex) {
          err.textContent = ex?.message || 'No se pudo guardar.';
          submit.disabled = false;
          submit.classList.remove('busy');
        }
      },
    },
    h('h2.dlg-title', title),
    intro && h('p.dlg-msg', intro),
    fields.map((f) => field(f, inputs)),
    err,
    h('div.dlg-actions',
      h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancelar'),
      submit));
    dlg.append(form);
  });
}

function field(f, inputs) {
  const id = `f-${f.name}-${++uid}`;
  const common = { id, name: f.name, maxlength: f.maxlength, placeholder: f.placeholder, autofocus: f.autofocus };
  let el;
  if (f.type === 'checkbox') {
    el = h('input', { type: 'checkbox', id, name: f.name });
    el.checked = !!f.value;
    inputs[f.name] = el;
    return h('label.field.check', { for: id }, el, h('span', f.label), f.hint && h('span.field-hint', f.hint));
  }
  if (f.type === 'textarea') el = h('textarea', { ...common, rows: f.rows || 3 });
  else if (f.type === 'select') el = h('select', common, f.options.map(([v, l]) => h('option', { value: v }, l)));
  else if (f.type === 'date') el = h('input', { ...common, type: 'date' });
  else {
    el = h('input', { ...common, type: 'text', autocomplete: 'off', spellcheck: f.spellcheck ?? 'true' });
    if (f.datalist) el.setAttribute('list', id + '-list');
  }
  el.value = f.value ?? (f.type === 'select' ? f.options[0][0] : '');
  inputs[f.name] = el;
  return h('label.field', { for: id },
    h('span.field-label', f.label, f.optional && h('span.opt', ' (opcional)')),
    el,
    f.hint && h('span.field-hint', f.hint),
    f.datalist && h('datalist', { id: id + '-list' }, f.datalist.map((o) => h('option', { value: o.value }, o.label || ''))));
}

/* ---------------------------------------------------------------- menú */

let open = null;

/**
 * Menú emergente junto a `anchor`.
 * items: [{label, onClick, danger, disabled} | {heading:'…'} | '-']
 */
export function popMenu(anchor, items) {
  const wasOpenHere = open?.anchor === anchor;
  closeMenu();
  if (wasOpenHere) return;
  const buttons = [];
  const menu = h('div.menu', { role: 'menu' }, items.map((it) => {
    if (it === '-') return h('div.menu-sep', { role: 'separator' });
    if (it.heading) return h('div.menu-heading', it.heading);
    const b = h('button', {
      class: ['menu-item', it.danger && 'danger'], type: 'button', role: 'menuitem', disabled: !!it.disabled,
      onclick: () => { closeMenu(); anchor.focus(); it.onClick(); },
    }, it.label);
    buttons.push(b);
    return b;
  }));
  document.body.append(menu);
  // Posición fija junto al botón, sin salirse de la pantalla (CSSOM: CSP lo permite).
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  anchor.setAttribute('aria-expanded', 'true');

  const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === 'Tab') closeMenu();
  };
  const onScroll = () => closeMenu();
  open = { menu, anchor, onDoc, onKey, onScroll };
  setTimeout(() => {
    if (open?.menu !== menu) return;
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc, { passive: true });
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, { passive: true, once: true });
  window.addEventListener('resize', onScroll, { once: true });
  buttons.find((b) => !b.disabled)?.focus();
}

export function closeMenu() {
  if (!open) return;
  const { menu, anchor, onDoc, onKey, onScroll } = open;
  open = null;
  menu.remove();
  anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onDoc);
  document.removeEventListener('touchstart', onDoc);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('resize', onScroll);
}
