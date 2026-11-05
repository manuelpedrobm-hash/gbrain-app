// Hermes (#/hermes): los mensajes de empuje que Hermes te manda por Telegram, del más reciente
// al más antiguo. Solo lectura: salen de las páginas ops/hermes/empuje-AAAA-MM del cerebro.

import { h, get, card, raw, emptyState, pageHead, fmtDay } from '../app.js';
import { openReplyHermes } from '../components/hermes-reply.js';

export const title = 'Hermes';

export async function mount(el) {
  const d = await get('/api/hermes');
  const rounds = d.rounds || [];
  const head = pageHead('Hermes',
    rounds.length
      ? `${d.total} ${d.total === 1 ? 'ronda' : 'rondas'} con algo que decir. Lo último, primero. Solo lectura.`
      : 'Lo que Hermes te empuja: hilos colgados, frentes parados y lo más urgente.');
  if (!rounds.length) {
    el.replaceChildren(head, emptyState('Hermes todavía no te ha escrito',
      d.folder
        ? 'Cuando haga una ronda con algo que empujar, el mensaje saldrá aquí. Las rondas «sin novedad» no se guardan.'
        : 'No encuentro la carpeta ops/hermes del cerebro. Se crea sola en la primera ronda (ops/hermes-empuje.sh).'));
    return;
  }
  const items = rounds.map((r, i) => {
    const when = `${fmtDay(r.date, true)} · ${r.time}`;
    const body = h('div.prose.hermes-body', raw(r.html));
    const reply = h('button.btn.small', { type: 'button', onclick: () => openReplyHermes(r) }, 'Responder');
    if (i === 0) return card({ title: when, cls: 'hermes-round', note: 'La última ronda', actions: reply }, body);
    return card({ title: when, cls: 'hermes-round', note: r.urgent || undefined, actions: reply },
      h('details', h('summary', 'Leer el mensaje'), body));
  });
  el.replaceChildren(head, ...items);
}

export const refresh = mount;
