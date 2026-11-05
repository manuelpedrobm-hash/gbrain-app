// Avisos breves abajo a la derecha (abajo del todo en móvil, sobre la barra de pestañas).

import { h } from '../app.js';

let box = null;

function container() {
  if (!box || !box.isConnected) {
    box = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  return box;
}

/**
 * toast('Guardado') · toast('Falló', {kind:'error'}) · toast('Hecha', {action:{label:'Deshacer', fn}})
 * kind: 'ok' | 'warn' | 'error'. Devuelve una función para cerrarlo.
 */
export function toast(message, { kind = 'ok', action, timeout } = {}) {
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    t.classList.add('out');
    setTimeout(() => t.remove(), 180);
  };
  const t = h('div', { class: ['toast', 'toast-' + kind] },
    h('span.toast-msg', message),
    action && h('button.toast-action', { type: 'button', onclick: () => { close(); action.fn(); } }, action.label),
    h('button.toast-close', { type: 'button', 'aria-label': 'Cerrar aviso', onclick: close }, '×'));
  container().append(t);
  const ms = timeout ?? (kind === 'error' ? 9000 : action ? 7000 : 4000);
  timer = setTimeout(close, ms);
  return close;
}
