// Minigrafo local de una página: la página en el centro, sus vecinos a 1 salto en el
// primer anillo y los de 2 saltos en el segundo, cerca de su «padre». SVG a mano, sin
// librerías. Colores por tipo (las mismas variables --c-<tipo> que los chips).
// Como mucho 40 nodos; las conversaciones se ocultan salvo que se pidan.

import { h, svg } from '../app.js';
import { typeClass, typeLabel } from './chips.js';

const MAX_NODES = 40;
const R1 = 120;
const R2 = 215;
const W = 620;
const H = 520;
const LABEL_PX = 12;      // tamaño de las etiquetas en pantalla, sea cual sea la escala del SVG

/**
 * Ajusta las etiquetas a la escala real del dibujo: en el raíl (~300 px para 620
 * unidades) una letra de 13 unidades medía unos 6 px. Pone --mg-fs para que midan
 * LABEL_PX en pantalla, recorta cada etiqueta al espacio que le queda hasta el borde y,
 * si el dibujo es pequeño, oculta las del segundo anillo (salen al pasar el ratón; el
 * título completo está siempre en el <title> del nodo).
 */
function fitLabels(svgEl) {
  const w = svgEl.getBoundingClientRect().width;
  if (!w) return;
  const fs = Math.min(40, Math.max(11, LABEL_PX * (W / w)));
  svgEl.style.setProperty('--mg-fs', fs.toFixed(1) + 'px');
  for (const t of svgEl.querySelectorAll('text[data-full]')) {
    const full = t.dataset.full;
    const ring = Number(t.dataset.ring);
    const charW = fs * (ring === 0 ? 0.62 : 0.56);
    const x = Number(t.getAttribute('x'));
    const anchor = t.getAttribute('text-anchor');
    const room = anchor === 'middle' ? W - 12 : anchor === 'start' ? W / 2 - 6 - x : x + W / 2 - 6;
    const maxChars = Math.floor(room / charW);
    t.classList.toggle('mg-hidden', (ring >= 2 && fs > 18) || maxChars < 4);
    t.textContent = full.length > maxChars ? full.slice(0, Math.max(3, maxChars - 1)) + '…' : full;
    // La estimación por carácter falla con mayúsculas: si se ve, mido de verdad y recorto.
    if (!t.classList.contains('mg-hidden') && typeof t.getComputedTextLength === 'function') {
      let n = Math.min(full.length, maxChars);
      while (n > 3 && t.getComputedTextLength() > room) {
        n--;
        t.textContent = full.slice(0, n - 1) + '…';
      }
    }
  }
}

/**
 * graph: {nodes:[{slug,title,type,d}], edges:[…]} — las aristas se aceptan como
 * {from,to} | {a,b} | {source,target} | {from_slug,to_slug} | [a,b], por slug o por id.
 */
export function miniGraph(graph, center, { conversations = false } = {}) {
  let nodes = (graph?.nodes || []).map((n) => ({ ...n, d: Number(n.d ?? n.depth ?? 0) }));
  if (!conversations) nodes = nodes.filter((n) => n.d === 0 || n.slug === center || n.type !== 'conversation');
  nodes.sort((a, b) => a.d - b.d || String(a.type).localeCompare(String(b.type)) || String(a.title || a.slug).localeCompare(String(b.title || b.slug), 'es'));
  nodes = nodes.slice(0, MAX_NODES);
  if (nodes.length <= 1) return null;

  const bySlug = new Map(nodes.map((n) => [n.slug, n]));
  const byId = new Map(nodes.filter((n) => n.id != null).map((n) => [String(n.id), n]));
  const pick = (x) => (x == null ? null : bySlug.get(x) || byId.get(String(x)) || null);

  const edges = [];
  const seen = new Set();
  for (const e of graph.edges || []) {
    const a = pick(Array.isArray(e) ? e[0] : e.from ?? e.a ?? e.source ?? e.from_slug);
    const b = pick(Array.isArray(e) ? e[1] : e.to ?? e.b ?? e.target ?? e.to_slug);
    if (!a || !b || a === b) continue;
    const key = [a.slug, b.slug].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([a, b]);
  }

  // Disposición radial.
  const root = bySlug.get(center) || nodes.find((n) => n.d === 0) || nodes[0];
  root.x = 0; root.y = 0; root.d = 0;
  const ring1 = nodes.filter((n) => n !== root && n.d <= 1);
  const ring2 = nodes.filter((n) => n !== root && n.d >= 2);
  ring1.forEach((n, i) => {
    n.angle = (2 * Math.PI * i) / Math.max(ring1.length, 1) - Math.PI / 2;
    n.x = R1 * Math.cos(n.angle);
    n.y = R1 * Math.sin(n.angle);
  });
  // Cada nodo de 2 saltos se coloca cerca del primer vecino de 1 salto que tenga.
  for (const n of ring2) {
    const parent = edges.map(([a, b]) => (a === n ? b : b === n ? a : null)).find((p) => p && ring1.includes(p));
    n.pa = parent ? parent.angle : 0;
  }
  ring2.sort((a, b) => a.pa - b.pa);
  ring2.forEach((n, i) => {
    const even = (2 * Math.PI * i) / Math.max(ring2.length, 1) - Math.PI / 2;
    const ang = ring2.length > 8 ? even : n.pa + (i % 2 ? 0.18 : -0.18);
    n.x = R2 * Math.cos(ang);
    n.y = R2 * Math.sin(ang);
    n.angle = ang;
  });

  const showAllLabels = nodes.length <= 18;
  const lines = edges.map(([a, b]) => svg('line', {
    x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
    class: 'mg-edge' + (a === root || b === root ? ' mg-edge-root' : ''),
  }));

  const dots = nodes.map((n) => {
    const r = n === root ? 11 : n.d <= 1 ? 7.5 : 5.5;
    const label = String(n.title || n.slug);
    const short = label.length > 22 ? label.slice(0, 21) + '…' : label;   // hasta que fitLabels mida
    const right = Math.cos(n.angle ?? 0) >= -0.01;
    const showLabel = n === root || n.d <= 1 || showAllLabels;
    const lx = n === root ? 0 : n.x + (right ? r + 5 : -(r + 5));
    const ly = n === root ? n.y + r + 16 : n.y + 4;
    return svg('a', { href: '#/p/' + n.slug, class: `mg-node ${typeClass(n.type)}${n === root ? ' mg-root' : ''}` },
      svg('title', {}, `${label} (${typeLabel(n.type)})`),
      svg('circle', { cx: n.x.toFixed(1), cy: n.y.toFixed(1), r }),
      showLabel && svg('text', {
        x: lx.toFixed(1), y: ly.toFixed(1),
        'text-anchor': n === root ? 'middle' : right ? 'start' : 'end',
        'data-full': label, 'data-ring': String(n === root ? 0 : n.d <= 1 ? 1 : 2),
      }, short));
  });

  const graphEl = svg('svg', {
    viewBox: `${-W / 2} ${-H / 2} ${W} ${H}`, class: 'minigraph', role: 'img',
    'aria-label': `Mapa local de enlaces: ${nodes.length - 1} páginas cercanas`,
  }, svg('g', {}, lines), svg('g', {}, dots));
  // Se ajusta al insertarse y cada vez que cambia de tamaño (raíl, móvil, girar la pantalla).
  // El setTimeout cubre el primer ajuste aunque el navegador aún no haya pintado (pestaña en
  // segundo plano), cuando el SVG ya está en la página.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitLabels(graphEl)).observe(graphEl);
  setTimeout(() => fitLabels(graphEl), 0);

  const types = [...new Set(nodes.map((n) => n.type))];
  const legend = h('div.mg-legend', types.map((t) => h('span.mg-key', h('span', { class: ['mg-swatch', typeClass(t)] }), typeLabel(t))));
  return h('div.mg-wrap', graphEl, legend);
}
