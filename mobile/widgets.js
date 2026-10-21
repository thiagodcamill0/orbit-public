// Orbit no celular — aba "Visão geral" (#visao): sessões por estado, uso de contexto e uso do plano.
// As contas vêm de assets/comum/widgets.js (OrbitWidgets); a cor e a barra, de OrbitBase. Sem innerHTML, sem inline (CSP).
// Dados: GET /estado (sessões + uso), lido a cada 10 s só com a aba à vista.
(() => {
'use strict';
const W = window.OrbitWidgets, B = window.OrbitBase;
const raiz = document.getElementById('p-visao');
if (!W || !B || !raiz) return;

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
function h(tag, props, ...filhos) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const f of filhos) if (f != null && f !== false) e.append(f);
  return e;
}
function sv(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}
const limpo = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
const nomeSessao = (s) => limpo(s.apelido) || limpo(s.titulo) || limpo(s.primeira) || limpo(s.tarefa) || limpo(s.nome) || limpo(s.projeto) || 'Sessão ' + String(s.id).slice(0, 8);
const hora = (ms) => W.horaPadrao(ms);
const corCtx = (p) => B.corEscala(p, W.CTX_ESCALA);

const dados = { projetos: undefined, criar: undefined, sessoes: [], uso: null, lido: 0, erro: false };
const GRUPOS_MOSTRADOS = W.GRUPOS_ESTADO.filter((x) => x.g !== 'revisadas'); // "revisadas" é estado local do PC
let amostras = [];
try { const a = JSON.parse(localStorage.getItem('orbit.m.usoAmostras') || '[]'); if (Array.isArray(a)) amostras = a.filter((x) => x && isFinite(x.t) && isFinite(x.p) && isFinite(x.r)); } catch {}
function guardarAmostra(t, p, r) {
  if (!t || !r) return;
  for (let i = amostras.length - 1; i >= 0; i--) if (Math.abs(amostras[i].r - r) >= 120e3) amostras.splice(i, 1);
  const u = amostras[amostras.length - 1];
  if (u && u.t >= t) return;
  amostras.push({ t, p, r });
  if (amostras.length > 40) amostras.splice(0, amostras.length - 40);
  try { localStorage.setItem('orbit.m.usoAmostras', JSON.stringify(amostras)); } catch {}
}

// ───────────────────────────── esqueleto ─────────────────────────────
function cartao(id, titulo, ...extra) {
  return h('section', { class: 'wg', id: 'wg-' + id, 'aria-labelledby': 'wg-' + id + '-t' },
    h('header', { class: 'wg-cab' }, h('h2', { id: 'wg-' + id + '-t', text: titulo }), ...extra),
    h('div', { class: 'wg-corpo', id: 'wg-' + id + '-c' }));
}
raiz.replaceChildren(
  cartao('projetos', 'Projetos'),
  cartao('sessoes', 'Sessões'),
  cartao('contexto', 'Uso de contexto'),
  cartao('uso', 'Uso do plano', h('span', { class: 'wg-selo', id: 'wg-uso-selo', hidden: true })),
  h('p', { class: 'wg-rodape', id: 'wg-rodape', role: 'status' }));
const corpo = (id) => $('wg-' + id + '-c');

// ───────────────────────────── projetos ─────────────────────────────
const normPasta = (p) => String(p || '').replace(/[\\]/g, '/').replace(/\/+$/, '').toLowerCase();
function renderProjetos() {
  const c = corpo('projetos');
  const msg = (t, cls) => c.replaceChildren(h('p', { class: 'wg-vazio' + (cls === 'erro' ? ' erro' : ''), 'data-estado': cls, text: t }));
  if (dados.criar === false) return msg('Para abrir instâncias por aqui, ligue "Criar instâncias" no acesso remoto, nas Configurações do Orbit no PC.', 'off');
  if (dados.criar === undefined || dados.projetos === undefined) return msg('Carregando projetos…', 'carregando');
  if (dados.projetos === null) return msg('Não deu para listar os projetos agora.', 'erro');
  if (!dados.projetos.length) return msg('Nenhum projeto cadastrado no Orbit.', 'vazio');
  c.replaceChildren(h('div', { class: 'wg-projs' }, ...dados.projetos.map((p) => {
    const alvo = normPasta(p.pasta);
    const n = dados.sessoes.filter((s) => s.status !== 'encerrada' && normPasta(s.cwd) === alvo).length;
    const b = h('button', { type: 'button', class: 'wg-proj', 'data-pasta': p.pasta },
      h('span', { class: 'wg-nome', text: limpo(p.nome) || String(p.pasta).split(/[\\/]/).filter(Boolean).pop() || p.pasta }),
      h('span', { class: 'wg-meta num', text: n ? n + (n === 1 ? ' sessão ativa' : ' sessões ativas') : 'nenhuma sessão ativa' }));
    b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('orbit:nova', { detail: { pasta: p.pasta } })));
    return b;
  })));
}

// ───────────────────────────── sessões ─────────────────────────────
function renderSessoes() {
  const cont = W.contarGrupos(dados.sessoes);
  const { total, fatias } = W.fatiasRosca(cont);
  const svg = sv('svg', { class: 'wg-rosca', viewBox: '0 0 120 120', width: 120, height: 120, role: 'img', 'aria-label': 'Sessões por estado: ' + GRUPOS_MOSTRADOS.map((x) => x.rot + ' ' + cont[x.g]).join(', ') });
  svg.append(sv('circle', { class: 'wg-rosca-fundo', cx: 60, cy: 60, r: W.ROSCA_R }));
  for (const f of fatias) {
    if (!f.n || !GRUPOS_MOSTRADOS.some((x) => x.g === f.g)) continue;
    const c = sv('circle', { class: 'wg-rosca-seg', cx: 60, cy: 60, r: W.ROSCA_R, 'data-g': f.g });
    c.style.stroke = W.GRUPOS_ESTADO.find((x) => x.g === f.g).cor;
    c.style.strokeDasharray = f.vis + ' ' + (W.ROSCA_C - f.vis);
    c.style.strokeDashoffset = String(f.desloc);
    svg.append(c);
  }
  const centro = h('div', { class: 'wg-rosca-centro' }, h('b', { class: 'num', text: String(total) }), h('span', { text: total === 1 ? 'sessão' : 'sessões' }));
  const leg = h('ul', { class: 'wg-leg' }, ...GRUPOS_MOSTRADOS.map((x) => {
    const n = cont[x.g];
    const i = h('i'); i.style.background = x.cor;
    return h('li', { class: n ? '' : 'zero', 'data-g': x.g }, i, h('span', { class: 'wg-leg-rot', text: x.rot }), h('b', { class: 'num', text: String(n) }), h('span', { class: 'wg-leg-p num', text: total && n ? W.fmtPct(n / total) : '' }));
  }));
  const ag = dados.sessoes.reduce((a, s) => a + W.agentesAtivos(s), 0);
  corpo('sessoes').replaceChildren(
    h('div', { class: 'wg-linha' }, h('div', { class: 'wg-rosca-caixa' }, svg, centro), leg),
    h('p', { class: 'wg-sub' + (ag ? ' bom' : ''), 'data-sub': 'agentes' }, ...(ag ? [h('b', { text: String(ag) }), ag === 1 ? ' subagente ativo' : ' subagentes ativos'] : total ? ['nenhum subagente ativo'] : ['nenhuma sessão ainda'])));
}

// ───────────────────────────── contexto ─────────────────────────────
function renderContexto() {
  const lista = dados.sessoes.filter((s) => s.status !== 'encerrada' && W.contexto(s))
    .map((s) => ({ s, c: W.contexto(s), p: W.ctxPct(s) }))
    .sort((a, b) => b.p - a.p || String(a.s.id).localeCompare(b.s.id));
  const altos = lista.filter((x) => x.p >= 0.7).length;
  const top = lista.slice(0, 5);
  const maior = top[0];
  const c = corpo('contexto');
  if (!maior) { c.replaceChildren(h('p', { class: 'wg-vazio', text: 'Nenhuma sessão aberta com contexto medido ainda.' })); return; }
  const num = h('b', { class: 'wg-grande num', text: maior.c.acima ? W.fmtK(maior.c.tokens) : Math.round(maior.p * 100) + '%' });
  num.style.color = corCtx(maior.c.acima ? 1 : maior.p);
  c.replaceChildren(
    h('div', { class: 'wg-topo' }, num, h('span', { class: 'wg-uni', text: maior.c.acima ? 'passou do limite' : lista.length > 1 ? 'a mais cheia' : 'de contexto' })),
    h('p', { class: 'wg-sub ' + (altos ? 'alerta' : 'bom') }, ...(altos ? [h('b', { text: String(altos) }), altos === 1 ? ' sessão com 70% ou mais' : ' sessões com 70% ou mais'] : ['todas com folga, abaixo de 70%'])),
    h('div', { class: 'wg-itens' }, ...top.map(({ s, c: x, p }) => {
      const pct = Math.round(p * 100);
      const cor = corCtx(x.acima ? 1 : p);
      const i = h('i'); i.style.width = (x.acima ? 100 : Math.max(2, Math.min(100, pct))) + '%'; i.style.background = cor;
      const val = h('span', { class: 'wg-val num', text: x.acima ? '> 100%' : pct + '%' }); val.style.color = cor;
      return h('div', { class: 'wg-item', 'data-id': s.id },
        h('span', { class: 'wg-item-l1' }, h('span', { class: 'wg-nome', text: nomeSessao(s) }), val),
        h('span', { class: 'wg-trilho' }, i),
        h('span', { class: 'wg-meta num' }, h('b', { text: W.fmtK(x.tokens) }), (x.acima ? ' · limite de ' : ' de ') + W.fmtK(x.limite) + ' tokens'));
    })));
}

// ───────────────────────────── uso do plano ─────────────────────────────
function renderUso() {
  const agora = Date.now();
  const u = dados.uso && (dados.uso.cincoHoras || dados.uso.semanal) ? dados.uso : null;
  const c = corpo('uso');
  const selo = $('wg-uso-selo');
  if (!u) {
    selo.hidden = true;
    c.replaceChildren(h('p', { class: 'wg-vazio', text: 'Nenhuma leitura do uso ainda. Ela chega junto com uma instância do Orbit ou da status line do terminal.' }));
    return;
  }
  const lido = Number(u.atualizado) || 0;
  const velho = !!lido && agora - lido > W.USO_VELHO;
  selo.hidden = !velho;
  selo.textContent = 'Estimado';
  selo.title = 'Última leitura real há ' + W.durRen(agora - lido) + '. O uso pode ter mudado desde então.';
  if (lido && u.cincoHoras && isFinite(u.cincoHoras.pct)) guardarAmostra(lido, u.cincoHoras.pct, W.msAbs(u.cincoHoras.renova));
  const linhas = W.linhasUso(u, agora);
  const med = linhas.filter((x) => x.pct != null);
  const maior = med.reduce((a, x) => (!a || x.pct > a.pct ? x : a), null);
  const perto = med.filter((x) => x.pct >= W.USO_PERTO);
  const num = h('b', { class: 'wg-grande num', text: maior ? maior.pct + '%' : '—' });
  if (maior) num.style.color = corCtx(maior.pct / 100);
  const sub = perto.length ? h('p', { class: 'wg-sub alerta' }, h('b', { text: perto.length > 1 ? 'Sessão e semana' : perto[0].curto }), ' perto do limite')
    : maior ? h('p', { class: 'wg-sub bom', text: 'com folga, abaixo de ' + W.USO_PERTO + '%' }) : h('p', { class: 'wg-sub', text: 'aguardando nova leitura' });
  const barras = linhas.map((x) => {
    const i = h('i');
    if (x.pct != null) { i.style.width = Math.max(2, x.pct) + '%'; B.degradeEscala(i, x.pct / 100, W.CTX_ESCALA); }
    const ren = !x.tem ? ['sem dados'] : !x.r ? [] : x.renovou ? ['renovou ' + W.quandoUso(x.r, agora, hora)]
      : ['renova em ', h('b', { text: W.durRen(x.r - agora) }), ' · ' + W.quandoUso(x.r, agora, hora).replace(/^às /, '')];
    return h('div', { class: 'wg-item', 'data-k': x.k },
      h('span', { class: 'wg-item-l1' }, h('span', { class: 'wg-nome', text: x.rot }), h('span', { class: 'wg-val num', text: x.pct != null ? x.pct + '%' : '—' })),
      h('span', { class: 'wg-trilho' }, i), h('span', { class: 'wg-meta' }, ...ren));
  });
  const prev = W.previsaoUso(u.cincoHoras, lido, agora, amostras, hora);
  c.replaceChildren(
    h('div', { class: 'wg-topo' }, num, h('span', { class: 'wg-uni', text: maior ? maior.uni : 'aguardando nova leitura' })), sub,
    h('div', { class: 'wg-itens' }, ...barras),
    prev ? h('p', { class: 'wg-prev ' + (prev.cls === 'aviso' ? 'alerta' : prev.cls), title: prev.dica }, ...prev.partes.map((p) => (typeof p === 'string' ? p : h('b', { text: p.b })))) : null,
    h('p', { class: 'wg-lido', text: lido ? (agora - lido < 60e3 ? 'Lido agora' : 'Lido há ' + W.durRen(agora - lido)) : 'Lido' }));
}

function renderTudo() {
  renderProjetos(); renderSessoes(); renderContexto(); renderUso();
  const r = $('wg-rodape');
  r.textContent = dados.erro ? 'Sem conexão com o Orbit. Mostrando a última leitura.' : '';
  r.hidden = !dados.erro;
}

// ───────────────────────────── dados ─────────────────────────────
const visivel = () => !raiz.hidden && !document.hidden && !!$('v-principal') && !$('v-principal').hidden;
let lendo = false;
async function ler(caminho) {
  const r = await fetch(caminho, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function atualizarProjetos() {
  try {
    const eu = await ler('/remoto/eu');
    dados.criar = !!(eu && eu.opcoes && eu.opcoes.criarInstancias);
  } catch { if (dados.criar === undefined) dados.criar = false; return; }
  if (!dados.criar) { dados.projetos = undefined; return; }
  try {
    const r = await ler('/remoto/projetos');
    dados.projetos = (Array.isArray(r) ? r : (r && r.projetos) || []).filter((p) => p && p.pasta);
  } catch { if (!Array.isArray(dados.projetos)) dados.projetos = null; }
}
async function atualizar() {
  if (lendo || !visivel()) return;
  lendo = true;
  try {
    const [e] = await Promise.allSettled([ler('/estado')]);
    if (e.status === 'fulfilled') {
      const d = e.value || {};
      dados.sessoes = Array.isArray(d.sessoes) ? d.sessoes : [];
      if ('uso' in d) dados.uso = d.uso || null;
      dados.erro = false;
    } else dados.erro = true;
    await atualizarProjetos();
    dados.lido = Date.now();
    renderTudo();
  } finally { lendo = false; }
}

renderTudo();
let timer = 0;
function parar() { clearInterval(timer); timer = 0; }
function seVisivel() {
  if (visivel()) { renderTudo(); atualizar(); if (!timer) timer = setInterval(atualizar, 10e3); } else parar();
}
new MutationObserver(seVisivel).observe(raiz, { attributes: true, attributeFilter: ['hidden'] });
if ($('v-principal')) new MutationObserver(seVisivel).observe($('v-principal'), { attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('visibilitychange', seVisivel);

// Ícone da aba (o mobile.js só troca os das três abas dele).
const aba = $('aba-visao');
if (aba) {
  aba.addEventListener('click', () => { location.hash = '#visao'; });
  const ic = aba.querySelector('.ic');
  const v = sv('svg', { viewBox: '0 0 16 16', width: 22, height: 22, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
  v.append(sv('path', { d: 'M2.5 2.5h4.5v5.5H2.5zM9 2.5h4.5v3H9zM9 7.5h4.5v6H9zM2.5 10h4.5v3.5H2.5z' }));
  if (ic) ic.replaceWith(v);
}
seVisivel();
})();
