// Estado: cómo está tu sistema. Comprobaciones, problemas conocidos explicados en
// español con «cómo arreglarlo» (nunca se arreglan solos), diagnóstico de gbrain bajo
// demanda, actividad reciente y ajustes del panel (tema, cerrar sesión).

import {
  h, get, post, card, pageHead, emptyState, icon, rel, fmtDateTime, usd, setTheme, getTheme,
} from '../app.js';
import { confirmDialog } from '../components/confirm.js';
import { toast } from '../components/toast.js';

export const title = 'Estado';

const SEV = { error: ['grave', 'error'], warn: ['aviso', 'warn'], info: ['info', 'muted'] };
const STATUS_ES = { ok: 'bien', warn: 'aviso', error: 'fallo' };

let doctorResult = null;

export async function mount(el) {
  const [estado, health, ajustes] = await Promise.all([
    get('/api/estado'),
    get('/api/health').catch((e) => ({ error: e })),
    get('/api/ajustes').catch(() => null),
  ]);
  draw(el, estado, health, ajustes);
}
export const refresh = mount;

function draw(el, estado, health, ajustes) {
  const issues = estado.issues || [];
  const bad = (health.checks || []).filter((c) => c.status !== 'ok').length;
  let sub = 'Todo en orden.';
  if (issues.length) sub = `${issues.length} ${issues.length === 1 ? 'problema conocido' : 'problemas conocidos'}. Nada se arregla solo: cada uno dice cómo arreglarlo.`;
  else if (bad) sub = `Sin problemas conocidos, pero ${bad === 1 ? 'una comprobación tiene' : `${bad} comprobaciones tienen`} aviso.`;
  el.replaceChildren(
    pageHead('Estado', sub),
    h('div.estado-grid',
      h('div.col', checksCard(health), issuesCard(issues), activityCard(estado.activity)),
      h('div.col', ajustesCard(ajustes), gbrainCard(estado), doctorCard(estado.doctor), panelCard())));
}

function checksCard(health) {
  if (health.error) return card({ title: 'Comprobaciones' }, emptyState('No pude leer la salud', health.error.message));
  const checks = health.checks || [];
  const tg = health.telegramCostToday;
  const pc = health.panelChatToday;
  return card({ title: 'Comprobaciones', note: health.at ? `Comprobado ${rel(health.at)} (se guarda 60 s).` : null },
    h('ul.rows.checks', checks.map((c) => h('li.row',
      h('span', { class: ['dot', 'big', 's-' + c.status], 'aria-hidden': 'true' }),
      h('div.row-main',
        h('p.row-text', h('strong', c.label_es), h('span', { class: ['status-word', 's-' + c.status] }, ' · ' + (STATUS_ES[c.status] || c.status))),
        c.detail_es && h('p.row-sub', c.detail_es))))),
    h('div.kv',
      tg && h('div', h('span.muted', 'Agente de Telegram hoy'), h('span', `≈ ${usd(tg.usd)} · ${tg.requests ?? 0} peticiones`, h('span.muted.small', ' (estimación)'))),
      pc && h('div', h('span.muted', 'Chat del panel hoy'), h('span', `${usd(pc.usd)} de ${usd(pc.capUsd)}`))));
}

function issuesCard(issues) {
  return card({ title: 'Problemas conocidos', count: issues.length || null },
    issues.length
      ? h('ul.issues', issues.map((i) => {
        const [label, cls] = SEV[i.severity] || [i.severity || 'aviso', 'warn'];
        return h('li', { class: ['issue', 'sev-' + cls] },
          h('div.issue-head', h('span', { class: ['chip', 'sev', 'sev-' + cls] }, label), h('h3.issue-title', i.title_es)),
          i.detail_es && h('p.issue-detail', i.detail_es),
          i.fix_es && h('details.issue-fix', h('summary', 'Cómo arreglarlo'), h('p.pre', i.fix_es)));
      }))
      : emptyState('No detecto problemas conocidos', 'Reviso la copia nocturna, la sincronización, el repositorio del cerebro, los embeddings, las actualizaciones y la lista de tareas.'));
}

function gbrainCard(estado) {
  const id = estado.identity || {};
  return card({ title: 'GBrain' },
    h('div.kv',
      h('div', h('span.muted', 'Versión'), h('span.mono', id.version || '—')),
      id.updateAvailable && h('div', h('span.muted', 'Actualización'), h('span.warn-text',
        // El servidor manda updateAvailable:boolean y, si la conoce, latestVersion.
        `disponible${id.latestVersion ? ': ' + id.latestVersion : typeof id.updateAvailable === 'string' ? ': ' + id.updateAvailable : ''}`))),
    id.updateAvailable && h('p.muted.small', 'Actualizar es decisión tuya: hazlo desde Claude Code, y después ejecuta check.ts del panel.'));
}

function doctorCard(cached) {
  const result = doctorResult || cached;
  const out = h('div.doctor-out');
  const btn = h('button.btn', { type: 'button' }, icon('estado'), 'Ejecutar diagnóstico');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.replaceChildren(h('span.spinner', { 'aria-hidden': 'true' }), 'Diagnosticando… (hasta 30 s)');
    try {
      doctorResult = { ...(await post('/api/estado/doctor', {})), at: new Date().toISOString() };
      out.replaceChildren(doctorView(doctorResult));
    } catch (e) {
      toast(e.status === 429 ? 'Espera un minuto entre diagnósticos.' : e.message, { kind: e.status === 429 ? 'warn' : 'error' });
    }
    btn.disabled = false;
    btn.replaceChildren(icon('estado'), 'Ejecutar diagnóstico');
  });
  if (result) out.append(doctorView(result));
  else out.append(h('p.muted.small', 'Ejecuta «gbrain doctor»: unos 2 segundos, sin coste. Como mucho una vez por minuto.'));
  return card({ title: 'Diagnóstico', actions: btn }, out);
}

function doctorView(d) {
  const score = d.health_score;
  const top = d.top_issues || [];
  const warns = d.warn_checks || [];
  const cls = score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'error';
  return h('div',
    h('div.score-row',
      score != null && h('p', { class: ['big-number', 's-' + cls] }, String(score), h('span.muted.small', ' / 100')),
      h('div',
        d.status && h('p', h('strong', d.status === 'ok' ? 'bien' : d.status === 'warnings' ? 'con avisos' : d.status)),
        d.at && h('p.muted.small', `Ejecutado ${fmtDateTime(d.at)}`))),
    top.length > 0 && h('div.subsec', h('h3.group-title', 'Lo más importante'),
      h('ul.plain', top.map((t) => typeof t === 'string'
        ? h('li', t)
        // El servidor manda {name, status, fix}.
        : h('li', h('span.mono', t.name || '—'), (t.fix || t.message) && ` — ${t.fix || t.message}`)))),
    warns.length > 0 && h('div.subsec', h('h3.group-title', 'Comprobaciones con aviso'),
      h('ul.plain', warns.map((w) => h('li', h('span.mono', w.name), w.message && ` — ${w.message}`)))));
}

function activityCard(a) {
  if (!a) return null;
  const audit = a.audit || [];
  const facts = a.facts || [];
  const git = a.git || [];
  const mcp = a.mcp || [];
  return card({ title: 'Actividad', note: 'Escrituras del panel, hechos de los últimos 7 días, commits del cerebro y llamadas MCP de hoy.' },
    audit.length > 0 && h('details.subgroup', { open: true }, h('summary', `Escrituras del panel (${audit.length})`),
      // El servidor ya las manda de la más nueva a la más vieja (health.ts auditTail).
      h('ul.rows.tight', audit.map((x) => h('li.row',
        h('div.row-main',
          h('p.row-text', h('span.mono', x.tool), x.target && [' · ', h('span.mono', x.target)], ' ', h('span', { class: ['status-word', x.ok ? 's-ok' : 's-error'] }, x.ok ? 'bien' : 'falló')),
          h('p.row-sub', rel(x.ts), x.error && ` · ${x.error}`)))))),
    facts.length > 0 && h('details.subgroup', h('summary', `Hechos creados o retirados (${facts.length})`),
      h('ul.rows.tight', facts.map((f) => h('li.row', h('div.row-main',
        h('p.row-text', f.expired_at ? h('s', f.fact) : f.fact),
        h('p.row-sub', `#${f.id} · ${f.expired_at ? 'retirado ' + rel(f.expired_at) : 'creado ' + rel(f.created_at)}`)))))),
    git.length > 0 && h('details.subgroup', h('summary', `Commits del cerebro (${git.length})`),
      h('ul.rows.tight', git.map((g) => {
        const [hash, date, ...msg] = typeof g === 'string' ? g.split('|') : [g.hash, g.date, g.subject];
        return h('li.row', h('div.row-main', h('p.row-text', msg.join('|')), h('p.row-sub', h('span.mono', hash), ' · ', rel(date))));
      }))),
    mcp.length > 0 && h('details.subgroup', h('summary', 'Llamadas MCP (24 h)'),
      h('table.mini', h('thead', h('tr', h('th', 'Operación'), h('th', 'Estado'), h('th.num', 'Veces'), h('th', 'Última'))),
        h('tbody', mcp.map((m) => h('tr', h('td.mono', m.operation), h('td', m.status), h('td.num', String(m.count ?? m.n ?? '')), h('td', rel(m.max ?? m.last))))))),
    !audit.length && !facts.length && !git.length && !mcp.length && h('p.muted.small', 'Sin actividad reciente que mostrar.'));
}

function panelCard() {
  const current = getTheme() || 'system';
  const seg = (value, label) => h('button', {
    class: ['seg-btn', current === value && 'active'], type: 'button', 'aria-pressed': current === value ? 'true' : 'false',
    onclick: (e) => {
      setTheme(value === 'system' ? null : value);
      e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach((b) => {
        const on = b === e.currentTarget;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    },
  }, label);
  return card({ title: 'Panel' },
    h('div.kv',
      h('div', h('span.muted', 'Tema'), h('div.seg', { role: 'group', 'aria-label': 'Tema' }, seg('system', 'Sistema'), seg('light', 'Claro'), seg('dark', 'Oscuro'))),
      h('div', h('span.muted', 'Atajos'), h('span.small', h('kbd', '⌘K'), ' o ', h('kbd', '/'), ' buscar · ', h('kbd', 'x'), ' marcar tarea hecha'))),
    h('div.btn-row',
      h('button.btn.ghost.danger-text', {
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '¿Cerrar sesión?',
            message: 'Para volver a entrar tendrás que abrir el panel con «Abrir panel».',
            confirmLabel: 'Cerrar sesión',
          });
          if (!ok) return;
          try { await post('/api/logout', {}); } catch { /* aunque falle, la cookie se ignora */ }
          location.reload();
        },
      }, 'Cerrar sesión')));
}

/* ------------------------------------------------------------- ajustes */
// Facturación (créditos de la API o plan de claude.ai), modelo por defecto del chat y topes.
// La facturación vale para el chat y para Claude Code en la terminal.

function ajustesCard(a) {
  if (!a) return card({ title: 'Ajustes' }, emptyState('No pude leer los ajustes', 'Recarga la página.'));
  const save = async (patch, okMsg) => {
    try {
      const r = await post('/api/ajustes', patch);
      toast(okMsg);
      return r;
    } catch (e) {
      toast(e?.message || 'No se pudo guardar.', { kind: 'error' });
      return null;
    }
  };
  const seg = (name, value, label, current, onPick) => h('button.seg-btn', {
    type: 'button', class: current === value ? 'active' : '', 'aria-pressed': current === value ? 'true' : 'false',
    onclick: async (e) => {
      const btnEl = e.currentTarget;
      const r = await onPick(value);
      if (!r) return;
      btnEl.parentElement.querySelectorAll('.seg-btn').forEach((b) => {
        const on = b === btnEl;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    },
  }, label);
  const fact = h('div.seg', { role: 'group', 'aria-label': 'Facturación' },
    seg('f', 'api', 'Créditos API', a.facturacion, (v) => save({ facturacion: v }, 'Ahora se usan los créditos de la API')),
    seg('f', 'plan', 'Plan claude.ai', a.facturacion, (v) => save({ facturacion: v }, 'Ahora se usa tu plan de claude.ai')));
  const modelo = h('div.seg', { role: 'group', 'aria-label': 'Modelo del chat' },
    seg('m', 'haiku', 'Haiku', a.modelo, (v) => save({ modelo: v }, 'Modelo por defecto: Haiku')),
    seg('m', 'sonnet', 'Sonnet', a.modelo, (v) => save({ modelo: v }, 'Modelo por defecto: Sonnet')),
    seg('m', 'opus', 'Opus', a.modelo, (v) => save({ modelo: v }, 'Modelo por defecto: Opus')));
  const money = (key, label, max) => {
    const input = h('input.money', { type: 'number', min: '0.1', max: String(max), step: '0.5', value: a[key], 'aria-label': label, style: { width: '6em' } });
    input.addEventListener('change', () => save({ [key]: input.value }, `${label}: US$${input.value}`));
    return h('div', h('span.muted', label), h('span', 'US$ ', input));
  };
  return card({ title: 'Ajustes' },
    h('div.kv',
      h('div', h('span.muted', 'Facturación'), fact),
      h('div', h('span.muted', 'Modelo del chat'), modelo),
      money('presupuestoConversacion', 'Tope por conversación', 20),
      money('presupuestoDiario', 'Tope diario', 100)),
    !a.claveEnLlavero && h('p.small.warn', 'No hay clave de API en el Llavero: solo puedes usar el plan.'),
    a.planB && h('p.small.warn', `La clave de API falló: hasta las ${new Date(a.planB).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} se usa tu plan. Pulsa «Créditos API» para reintentar.`),
    h('p.muted.small', 'La facturación vale para el chat y para Claude Code en la terminal (al abrir una sesión nueva). Con créditos, los US$ del panel son gasto real.'));
}
