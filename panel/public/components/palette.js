// Paleta ⌘K (o «/»): busca en el índice local de páginas sin distinguir tildes.
//   @texto   solo personas          #texto   etiquetas
//   ?texto   pregunta al chat       !texto   apunta una nota rápida
//   >texto   comandos del panel     Intro sobre texto libre → búsqueda en todo el texto
// El índice (/api/index) se pide una vez y se renueva cuando el pulso detecta cambios.

import { h, raw, esc, get, go, fold, icon, askChat, capture, toggleTheme } from '../app.js';
import { typeChip, kindChip } from './chips.js';
import { toast } from './toast.js';

let index = null;
let indexPromise = null;
let stale = false;

export function invalidateIndex() { stale = true; }

export async function getIndex() {
  if (index && !stale) return index;
  if (!indexPromise) {
    indexPromise = get('/api/index')
      .then((d) => { index = prepare(d); stale = false; return index; })
      .catch((e) => { if (index) return index; throw e; })
      .finally(() => { indexPromise = null; });
  }
  return indexPromise;
}

function prepare(d) {
  return {
    pages: (d?.pages || []).map((p) => ({
      s: p.s, t: p.t || p.s, y: p.y, a: p.a || [],
      fs: fold(p.s), ft: fold(p.t || p.s), fa: (p.a || []).map(fold),
    })),
    tags: (d?.tags || []).map((t) => ({ tag: t.tag, n: Number(t.n) || 0, f: fold(t.tag) })),
  };
}

/* Puntuación difusa: prefijo > inicio de palabra > subcadena > subsecuencia. */
function scoreOne(q, target) {
  if (!target) return 0;
  const i = target.indexOf(q);
  if (i === 0) return 100 - Math.min(target.length, 60) * 0.05;
  if (i > 0) return (/[\s/\-_.,(]/.test(target[i - 1]) ? 82 : 62) - Math.min(i, 40) * 0.1;
  let from = 0;
  let last = -1;
  let gaps = 0;
  for (const ch of q) {
    const j = target.indexOf(ch, from);
    if (j < 0) return 0;
    if (last >= 0) gaps += j - last - 1;
    last = j;
    from = j + 1;
  }
  return Math.max(1, 40 - gaps * 1.5);
}

function scoreWords(words, target) {
  let total = 0;
  for (const w of words) {
    const s = scoreOne(w, target);
    if (!s) return 0;
    total += s;
  }
  return total / words.length;
}

function scorePage(words, p) {
  let best = scoreWords(words, p.ft);
  for (const a of p.fa) best = Math.max(best, scoreWords(words, a) * 0.95);
  best = Math.max(best, scoreWords(words, p.fs) * 0.85);
  if (p.y === 'conversation') best *= 0.75;
  return best;
}

const COMMANDS = [
  { label: 'Ir a Hoy', hint: 'inicio', run: () => go('#/hoy') },
  { label: 'Ir a Pendientes', run: () => go('#/pendientes') },
  { label: 'Ir a Mensajes', run: () => go('#/mensajes') },
  { label: 'Ir a Memoria', run: () => go('#/memoria') },
  { label: 'Ir a Hechos', run: () => go('#/hechos') },
  { label: 'Ir al Chat', run: () => go('#/chat') },
  { label: 'Ir a Estrategia', hint: 'frentes, hoja de ruta, decisiones', run: () => go('#/estrategia') },
  { label: 'Ir al Asistente', hint: 'formularios web, aprobar antes de enviar', run: () => go('#/asistente') },
  { label: 'Ir a Estado', hint: 'salud, problemas, diagnóstico', run: () => go('#/estado') },
  { label: 'Nueva tarea', hint: 'gratis', run: async () => (await import('../views/pendientes.js')).openTaskForm() },
  { label: 'Recordar un hecho', hint: 'gratis', run: async () => (await import('../views/hechos.js')).openRemember() },
  { label: 'Apuntar una nota', hint: 'gratis', run: async () => (await import('../views/hoy.js')).openCapture() },
  { label: 'Nueva conversación', hint: 'chat', run: () => go('#/chat') },
  { label: 'Cambiar tema claro / oscuro', run: () => toggleTheme() },
].map((c) => ({ ...c, f: fold(c.label + ' ' + (c.hint || '')) }));

/** Resalta un fragmento de búsqueda: se escapa todo y luego \u0001…\u0002 pasa a <mark>. */
export function markSnippet(s) {
  let open = 0;
  const html = esc(s).replace(/[\u0001\u0002]/g, (c) => {
    if (c === '\u0001' && !open) { open = 1; return '<mark>'; }
    if (c === '\u0002' && open) { open = 0; return '</mark>'; }
    return '';
  });
  return raw(open ? html + '</mark>' : html);
}

export function openPalette(initial = '') {
  if (document.querySelector('dialog.palette')) return;
  const input = h('input.pal-input', {
    type: 'text', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search',
    placeholder: 'Busca páginas, personas, proyectos…',
    'aria-label': 'Buscar en el cerebro', role: 'combobox', 'aria-expanded': 'true',
    'aria-controls': 'pal-list', 'aria-autocomplete': 'list',
  });
  const list = h('div.pal-list', { id: 'pal-list', role: 'listbox', 'aria-label': 'Resultados' });
  const status = h('div.pal-status', { 'aria-live': 'polite' });
  const dlg = h('dialog.dlg.palette', { 'aria-label': 'Buscar' },
    h('div.pal-box',
      h('div.pal-head', icon('search'), input,
        h('button.pal-close', { type: 'button', 'aria-label': 'Cerrar', onclick: () => close() }, h('kbd', 'esc'))),
      status,
      list,
      h('div.pal-foot',
        h('span', h('kbd', '@'), ' personas'), h('span', h('kbd', '#'), ' etiquetas'),
        h('span', h('kbd', '?'), ' chat'), h('span', h('kbd', '!'), ' nota'), h('span', h('kbd', '>'), ' comandos'),
        h('span.pal-foot-enter', h('kbd', '↵'), ' buscar en todo'))));

  let items = [];
  let sel = 0;
  let searchSeq = 0;
  let searched = false; // true mientras se muestran resultados de la búsqueda completa

  const close = () => { if (dlg.open) dlg.close(); dlg.remove(); };

  function render() {
    list.replaceChildren(...items.map((it, i) => {
      if (it.section) return h('div.pal-section', { role: 'presentation' }, it.section);
      const el = h('div', {
        class: ['pal-item', i === sel && 'sel', it.kind && 'pk-' + it.kind], role: 'option', id: 'pal-opt-' + i,
        'aria-selected': i === sel ? 'true' : 'false',
        onmousemove: () => { if (sel !== i) { sel = i; mark(); } },
        onclick: () => choose(i),
      }, it.render());
      return el;
    }));
    mark();
  }

  function mark() {
    list.querySelectorAll('.pal-item').forEach((el) => {
      const on = el.id === 'pal-opt-' + sel;
      el.classList.toggle('sel', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', 'pal-opt-' + sel);
  }

  function selectable(i) { return items[i] && !items[i].section; }
  function move(delta) {
    if (!items.some((it) => !it.section)) return;
    let i = sel;
    do { i = (i + delta + items.length) % items.length; } while (!selectable(i));
    sel = i;
    mark();
  }

  async function choose(i) {
    const it = items[i];
    if (!it || it.section) return;
    if (it.keepOpen) return it.run();
    close();
    try { await it.run(); } catch (e) { toast(e.message || 'No se pudo', { kind: 'error' }); }
  }

  function pageItem(p) {
    return {
      kind: 'page',
      run: () => go('#/p/' + p.s),
      render: () => [typeChip(p.y), h('span.pal-title', p.t), h('span.pal-sub.mono', p.s)],
    };
  }

  function setItems(next) {
    items = next;
    sel = items.findIndex((it) => !it.section);
    if (sel < 0) sel = 0;
    render();
  }

  function update() {
    searchSeq++;
    searched = false;
    const q = input.value;
    const trimmed = q.trim();
    status.textContent = '';
    const first = trimmed[0];

    if (!trimmed) {
      setItems([
        { section: 'Ir a' },
        ...COMMANDS.slice(0, 7).map(cmdItem),
        { section: 'Acciones rápidas (gratis, sin modelo)' },
        ...COMMANDS.slice(7, 10).map(cmdItem),
      ]);
      return;
    }

    if (first === '?') {
      const text = trimmed.slice(1).trim();
      setItems(text ? [{
        kind: 'ask', run: () => askChat(text, { send: true }),
        render: () => [icon('chat'), h('span.pal-title', `Preguntar al chat: «${text}»`), h('span.pal-sub', 'usa el modelo (Sonnet)')],
      }] : [hint('Escribe tu pregunta después de «?». Se abre una conversación nueva con Sonnet.')]);
      return;
    }

    if (first === '!') {
      const text = trimmed.slice(1).trim();
      setItems(text ? [{
        kind: 'note', run: () => capture(text),
        render: () => [icon('note'), h('span.pal-title', `Apuntar: «${text}»`), h('span.pal-sub', 'nota en inbox/, gratis')],
      }] : [hint('Escribe la nota después de «!». Se guarda en inbox/ del cerebro.')]);
      return;
    }

    if (first === '>') {
      const words = fold(trimmed.slice(1)).split(/\s+/).filter(Boolean);
      const found = COMMANDS.filter((c) => !words.length || scoreWords(words, c.f) > 0);
      setItems(found.length ? found.map(cmdItem) : [hint('Ningún comando coincide.')]);
      return;
    }

    if (!index) {
      status.textContent = 'Cargando el índice…';
      setItems([searchAllItem(trimmed)]);
      return;
    }

    if (first === '#') {
      const words = fold(trimmed.slice(1)).split(/\s+/).filter(Boolean);
      const tags = index.tags
        .map((t) => ({ t, s: words.length ? scoreWords(words, t.f) : 1 + t.n / 1000 }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 30)
        .map(({ t }) => ({
          kind: 'tag', run: () => go('#/memoria?tag=' + encodeURIComponent(t.tag)),
          render: () => [h('span.chip.tag', '#' + t.tag), h('span.pal-sub', `${t.n} ${t.n === 1 ? 'página' : 'páginas'}`)],
        }));
      setItems(tags.length ? tags : [hint('Ninguna etiqueta coincide.')]);
      return;
    }

    const people = first === '@';
    const words = fold(people ? trimmed.slice(1) : trimmed).split(/\s+/).filter(Boolean);
    const pool = people ? index.pages.filter((p) => p.y === 'person') : index.pages;
    const ranked = (words.length ? pool.map((p) => ({ p, s: scorePage(words, p) })).filter((x) => x.s > 0)
      : pool.map((p) => ({ p, s: 1 })))
      .sort((a, b) => b.s - a.s || a.p.t.localeCompare(b.p.t, 'es'))
      .slice(0, 40)
      .map(({ p }) => pageItem(p));
    const next = ranked.length ? ranked : [hint(people ? 'Ninguna persona coincide.' : 'Ningún título ni alias coincide.')];
    if (!people && words.length) next.push(searchAllItem(trimmed));
    setItems(next);
  }

  function cmdItem(c) {
    return { kind: 'cmd', run: c.run, render: () => [icon('arrow'), h('span.pal-title', c.label), c.hint && h('span.pal-sub', c.hint)] };
  }

  function hint(text) {
    return { kind: 'hint', run: () => {}, keepOpen: true, render: () => [h('span.pal-sub', text)] };
  }

  function searchAllItem(q) {
    return {
      kind: 'search', keepOpen: true, run: () => fullSearch(q),
      render: () => [icon('search'), h('span.pal-title', `Buscar «${q}» en el texto de todo el cerebro`), h('span.pal-sub', 'Intro')],
    };
  }

  async function fullSearch(q) {
    const mySeq = ++searchSeq;
    searched = true;
    status.textContent = 'Buscando…';
    let r;
    try {
      r = await get('/api/search?q=' + encodeURIComponent(q.slice(0, 200)));
    } catch (e) {
      if (mySeq === searchSeq) status.textContent = e.message;
      return;
    }
    if (mySeq !== searchSeq) return;
    const pages = r?.pages || [];
    const facts = r?.facts || [];
    status.textContent = pages.length || facts.length
      ? `${pages.length} ${pages.length === 1 ? 'página' : 'páginas'} y ${facts.length} ${facts.length === 1 ? 'hecho' : 'hechos'} para «${q}»`
      : `Nada para «${q}». Sin embeddings, la búsqueda solo encuentra palabras exactas: prueba sin tilde, en singular o con la raíz.`;
    const next = [];
    if (pages.length) next.push({ section: 'Páginas' });
    for (const p of pages) {
      next.push({
        kind: 'page', run: () => go('#/p/' + p.slug),
        render: () => [typeChip(p.type), h('span.pal-col',
          h('span.pal-title', p.title || p.slug),
          p.snip && h('span.pal-snip', markSnippet(p.snip)))],
      });
    }
    if (facts.length) next.push({ section: 'Hechos' });
    for (const f of facts) {
      next.push({
        kind: 'fact', run: () => go(f.entity_slug ? '#/p/' + f.entity_slug : '#/hechos'),
        render: () => [kindChip(f.kind), h('span.pal-col', h('span.pal-title.wrap', f.fact),
          h('span.pal-sub', `hecho #${f.id}${f.entity_slug ? ' · ' + f.entity_slug : ''}`))],
      });
    }
    setItems(next.length ? next : []);
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[sel];
      if (it && !it.section && it.kind !== 'hint') choose(sel);
      else if (input.value.trim() && !/^[?!>#@]/.test(input.value.trim())) fullSearch(input.value.trim());
    }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });

  document.body.append(dlg);
  dlg.showModal();
  input.value = initial;
  input.focus();
  update();
  getIndex().then(() => { if (dlg.isConnected && !searched) update(); })
    .catch((e) => { if (dlg.isConnected) status.textContent = 'No pude cargar el índice: ' + e.message; });
}
