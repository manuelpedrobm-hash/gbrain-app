// «Responder a Hermes»: guarda tu respuesta como un hecho del cerebro que empieza por
// «Respuesta a Hermes (ronda AAAA-MM-DD HH:MM):». Hermes lo lee en su siguiente ronda
// (recall de «Respuesta a Hermes») y deja de empujar lo que ya contestaste. Gratis: no usa el modelo.

import { post, stamp, refreshView } from '../app.js';
import { formDialog } from './confirm.js';
import { toast } from './toast.js';

export const PREFIX = 'Respuesta a Hermes';

/** round: {id: 'AAAA-MM-DD HH:MM'} */
export async function openReplyHermes(round) {
  const saved = await formDialog({
    title: 'Responder a Hermes',
    intro: 'Dile qué has hecho, qué sueltas o qué aplazas. Lo leerá en su próxima ronda y no te empujará por lo ya contestado.',
    submitLabel: 'Enviar respuesta',
    fields: [{
      name: 'texto', label: 'Tu respuesta', type: 'textarea', rows: 4, required: true, maxlength: 400, autofocus: true,
      hint: 'Por ejemplo: «Elliot: ya le escribí, nueva llamada el jueves. César: lo suelto.»',
    }],
    onSubmit: async (v) => {
      const body = {
        fact: `${PREFIX} (ronda ${round.id}): ${v.texto}`,
        kind: 'fact',
        provenance: `panel web, ${stamp()}, respuesta a la ronda de Hermes ${round.id}`,
      };
      const r = await post('/api/facts', body);
      if (r?.verified || r?.status === 'duplicate') toast('Respuesta guardada: Hermes la leerá en su próxima ronda');
      else toast('Guardada, pero no pude comprobarla releyendo la base', { kind: 'warn' });
      return r;
    },
  });
  if (saved) refreshView({ quiet: true });
  return saved;
}
