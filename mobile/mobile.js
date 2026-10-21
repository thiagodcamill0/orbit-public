// Orbit no celular (iPhone via Tailscale). Sem framework, sem innerHTML, sem script nem style inline (CSP da porta remota).
// Telas: parear, sessões, sessão (conversa + permissão), uso do plano e este aparelho (notificações).
// Os formatos de dados e os corpos dos POSTs são os mesmos da página do PC (assets/conversa.js, controle.mjs).
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const NS = 'http://www.w3.org/2000/svg';

// ───────────────────────────── utilidades ─────────────────────────────
function h(tag, props, ...filhos) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const f of filhos) if (f != null && f !== false) e.append(f);
  return e;
}
const txt = (el, v) => { const t = v == null ? '' : String(v); if (el.textContent !== t) el.textContent = t; };
const limpo = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

const ICONES = {
  voltar: 'M10 3 5 8l5 5', mais: 'M8 3v10M3 8h10', x: 'M4 4l8 8M12 4l-8 8', check: 'M3.5 8.5l3 3 6-7',
  enviar: 'M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2', parar: 'M4.5 4.5h7v7h-7z',
  foto: 'M2 5.5h2.3l1.2-1.8h5l1.2 1.8H14v7.5H2zM8 11.4a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
  alerta: 'M8 2.4 14.2 13H1.8zM8 6.4v3.1M8 11.3v.1', atividade: 'M1.5 8h2.8l1.8-4.5 3.2 9 1.8-4.5h3.4', play: 'M5.2 3.4v9.2l7-4.6z',
  lista: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1', uso: 'M3 13V8M8 13V3M13 13V6',
  aparelho: 'M5 1.8h6a1 1 0 0 1 1 1v10.4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1zM7 12.2h2',
  cadeado: 'M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2', ajuda: 'M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.3-.8.7-.8 1.3M8 11.6v.1',
  chevron: 'M4.5 6.5 8 10l3.5-3.5', balao: 'M2.5 3.5h11v7h-5l-3 2.5v-2.5h-3z',
};
function ico(nome, tam = 18) {
  const v = document.createElementNS(NS, 'svg');
  for (const [k, x] of Object.entries({ viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, x);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONES[nome] || '');
  v.append(p);
  return v;
}

let toastTimer = 0;
function toast(t) {
  const el = $('toast');
  txt(el, t);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}

// Instante em ms: número em ms ou em s, ou texto ISO.
function emMs(t) {
  if (typeof t === 'string') { const d = Date.parse(t); return Number.isFinite(d) ? d : 0; }
  const n = Number(t) || 0;
  return n && n < 1e12 ? n * 1000 : n;
}
function tempo(ms) {
  const d = Math.max(0, Date.now() - ms);
  if (d < 60e3) return 'agora';
  const m = Math.floor(d / 60e3);
  if (m < 60) return m + ' min';
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + ' h';
  return Math.floor(hr / 24) + ' d';
}
function durRen(ms) {
  const m = Math.floor(Math.max(0, ms) / 60e3);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return m + ' min';
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  return Math.floor(hr / 24) + ' d' + (hr % 24 ? ' ' + (hr % 24) + ' h' : '');
}
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function hora(ms) { try { return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function quando(ms, agora) {
  const d = new Date(ms);
  if (d.toDateString() === new Date(agora).toDateString()) return 'às ' + hora(ms);
  if (Math.abs(ms - agora) < 6 * 86400e3) return DIAS[d.getDay()] + ' ' + hora(ms);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// Chamada à API do Orbit. Todo POST leva JSON. 401 fora do pareamento = aparelho revogado ou sem cookie.
async function api(caminho, corpo, opc = {}) {
  let r;
  try {
    r = await fetch(caminho, corpo === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo) });
  } catch {
    const e = new Error('Sem conexão com o Orbit. Confira se o PC está ligado e conectado ao Tailscale.');
    e.rede = true;
    throw e;
  }
  let d = null;
  try { d = await r.json(); } catch {}
  if (r.status === 401 && !opc.semSessao) desparear();
  if (!r.ok) {
    const e = new Error((d && typeof d.erro === 'string' && /\s/.test(d.erro) && d.erro) || 'O servidor respondeu ' + r.status + '.');
    e.status = r.status;
    e.codigo = (d && (d.codigo || d.erro)) || '';
    e.dados = d;
    throw e;
  }
  return d || {};
}

// ───────────────────────────── estado e rotas ─────────────────────────────
const est = { eu: null, sessoes: new Map(), uso: null, aba: 'sessoes', conexao: 'conectando', es: null, esTimer: 0, avisoTimer: 0, doApp: false, rafRender: 0, vistoUso: 0 };

function rota() {
  const m = /^#s=(.+)$/.exec(location.hash);
  if (m) { try { return { tipo: 'sessao', id: decodeURIComponent(m[1]) }; } catch {} }
  const a = location.hash.slice(1);
  return { tipo: 'aba', aba: a === 'uso' || a === 'aparelho' || a === 'visao' ? a : 'sessoes' };
}
function mostrarTela(nome) {
  $('carregando').hidden = true;
  for (const t of ['parear', 'principal', 'sessao']) $('v-' + t).hidden = t !== nome;
}
function aplicarRota() {
  if (!est.eu) return;
  const r = rota();
  if (r.tipo === 'sessao') {
    mostrarTela('sessao');
    abrirSessao(r.id);
  } else {
    fecharSessao();
    mostrarTela('principal');
    mostrarAba(r.aba);
  }
}
function abrirUrl(url) {
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin || !/^\/m\/?$/.test(u.pathname)) return;
    location.hash = u.hash && u.hash !== '#' ? u.hash : '#sessoes';
  } catch {}
}
function voltar() {
  if (est.doApp) { est.doApp = false; history.back(); return; }
  history.replaceState(null, '', '#sessoes');
  aplicarRota();
}

function mostrarAba(aba) {
  est.aba = aba;
  for (const a of ['visao', 'sessoes', 'uso', 'aparelho']) {
    $('p-' + a).hidden = a !== aba;
    const b = $('aba-' + a);
    if (a === aba) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  txt($('topo-tit'), { visao: 'Visão geral', sessoes: 'Sessões', uso: 'Uso do plano', aparelho: 'Este aparelho' }[aba]);
  $('btn-nova').hidden = !(est.eu && est.eu.opcoes && est.eu.opcoes.criarInstancias) || aba !== 'sessoes';
  $('rolagem-principal').scrollTop = 0;
  if (aba === 'uso') { renderUso(); atualizarUso(); }
  if (aba === 'aparelho') renderAparelho();
  if (aba === 'sessoes') renderLista();
}

// ───────────────────────────── 1. parear ─────────────────────────────
const par = { pedido: null, expiraEm: 0, timer: 0, ocupado: false };
const ERROS_PAREAR = {
  codigo_errado: 'Código errado. Confira os 6 dígitos que aparecem no PC.',
  expirado: 'O código expirou (vale 2 minutos). Peça outro.',
  bloqueado: 'Muitas tentativas erradas. O pareamento fica bloqueado por 10 minutos.',
  pedido_pendente: 'Já existe um pedido de pareamento aberto. Espere ele expirar ou recuse-o no Orbit do PC.',
  desativado: 'O acesso pelo celular está desligado no Orbit do PC.',
};
function textoErroParear(e, confirmando) {
  const c = String(e.codigo || '');
  if (ERROS_PAREAR[c]) return ERROS_PAREAR[c];
  if (e.rede) return e.message;
  if (e.status === 409) return ERROS_PAREAR.pedido_pendente;
  if (e.status === 410) return ERROS_PAREAR.expirado;
  if (e.status === 423 || e.status === 429) return ERROS_PAREAR.bloqueado;
  if (/\s/.test(c)) return c;
  if (confirmando && (e.status === 400 || e.status === 401 || e.status === 403)) return ERROS_PAREAR.codigo_errado;
  return 'Não deu para parear (o servidor respondeu ' + (e.status || 'sem resposta') + ').';
}
function erroParear(t) { const el = $('par-erro'); el.hidden = !t; txt(el, t || ''); }
function mostrarParear() {
  est.eu = null;
  fecharFluxo();
  fecharSessao();
  est.sessoes = new Map();
  mostrarTela('parear');
  passoParear(1);
  erroParear('');
}
function passoParear(n) {
  clearInterval(par.timer);
  $('par-f1').hidden = n !== 1;
  $('par-f2').hidden = n !== 2;
  txt($('par-sub'), n === 1
    ? 'Dê um nome a este aparelho. Depois, digite o código de 6 dígitos que vai aparecer no Orbit do seu PC.'
    : 'Abra o Orbit no PC, veja o código de 6 dígitos e digite aqui.');
  if (n === 2) {
    $('par-codigo').value = '';
    $('par-confirmar').disabled = false;
    par.timer = setInterval(tiquePar, 500);
    tiquePar();
    $('par-codigo').focus();
  }
}
function tiquePar() {
  const falta = par.expiraEm - Date.now();
  const el = $('par-expira');
  if (falta <= 0) {
    clearInterval(par.timer);
    el.classList.add('fim');
    txt(el, 'O código expirou. Peça outro.');
    $('par-confirmar').disabled = true;
    return;
  }
  el.classList.remove('fim');
  const s = Math.ceil(falta / 1000);
  txt(el, 'Expira em ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
}
async function pedirCodigo(ev) {
  ev.preventDefault();
  if (par.ocupado) return;
  const nome = limpo($('par-nome').value).slice(0, 40) || 'iPhone';
  par.ocupado = true;
  $('par-pedir').disabled = true;
  erroParear('');
  try {
    const d = await api('/remoto/parear/pedir', { nome }, { semSessao: true });
    par.pedido = d.pedido;
    par.expiraEm = emMs(d.expiraEm) || Date.now() + 120e3;
    passoParear(2);
  } catch (e) {
    erroParear(textoErroParear(e, false));
  } finally {
    par.ocupado = false;
    $('par-pedir').disabled = false;
  }
}
async function confirmarCodigo(ev) {
  ev.preventDefault();
  if (par.ocupado) return;
  const codigo = $('par-codigo').value.replace(/\D/g, '');
  if (codigo.length !== 6) { erroParear('Digite os 6 dígitos do código.'); return; }
  par.ocupado = true;
  $('par-confirmar').disabled = true;
  erroParear('');
  try {
    await api('/remoto/parear/confirmar', { pedido: par.pedido, codigo }, { semSessao: true });
    clearInterval(par.timer);
    par.pedido = null;
    await iniciar();
  } catch (e) {
    const c = String(e.codigo || '');
    erroParear(textoErroParear(e, true));
    if (c === 'expirado' || e.status === 410 || c === 'bloqueado' || e.status === 423 || e.status === 429) passoParear(1);
    else { $('par-codigo').value = ''; $('par-codigo').focus(); $('par-confirmar').disabled = Date.now() >= par.expiraEm; }
  } finally {
    par.ocupado = false;
  }
}
function desparear() {
  if (!$('v-parear').hidden) return;
  mostrarParear();
  erroParear('Este aparelho não está mais pareado. Pareie de novo para continuar.');
}

// ───────────────────────────── fluxo ao vivo (SSE) ─────────────────────────────
function definirConexao(c) {
  est.conexao = c;
  clearTimeout(est.avisoTimer);
  if (c === 'vivo') $('aviso-conexao').hidden = true;
  else est.avisoTimer = setTimeout(() => { if (est.conexao !== 'vivo') $('aviso-conexao').hidden = false; }, 1500);
}
function fecharFluxo() {
  clearTimeout(est.esTimer);
  if (est.es) { try { est.es.close(); } catch {} est.es = null; }
}
async function aindaPareado() {
  try { await api('/remoto/eu'); return true; } catch (e) { return !e.status; }
}
function conectarFluxo() {
  fecharFluxo();
  let es;
  try { es = new EventSource('/fluxo'); } catch { est.esTimer = setTimeout(conectarFluxo, 3000); return; }
  est.es = es;
  const ouvir = (nome, fn) => es.addEventListener(nome, (ev) => {
    if (est.es !== es) return;
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    try { fn(d); } catch (err) { console.warn('fluxo ' + nome, err); }
  });
  es.onopen = () => definirConexao('vivo');
  es.onerror = () => {
    if (est.es !== es) return;
    definirConexao('reconectando');
    if (es.readyState === EventSource.CLOSED) {
      est.esTimer = setTimeout(async () => { if (est.eu && await aindaPareado() && est.eu) conectarFluxo(); }, 3000);
    }
  };
  ouvir('inicio', (d) => {
    const novas = new Map();
    for (const s of (d && d.sessoes) || []) if (s && s.id) novas.set(String(s.id), s);
    est.sessoes = novas;
    if (d && 'uso' in d) est.uso = d.uso || null;
    definirConexao('vivo');
    agendarRender();
  });
  ouvir('sessao', (s) => { if (s && s.id) { est.sessoes.set(String(s.id), s); agendarRender(); } });
  ouvir('remover', (d) => { if (d && d.id) { est.sessoes.delete(String(d.id)); agendarRender(); } });
  ouvir('uso', (u) => { est.uso = u || null; agendarRender(); });
}
async function carregarEstado() {
  try {
    const d = await api('/estado');
    if (d && Array.isArray(d.sessoes)) {
      est.sessoes = new Map(d.sessoes.filter((s) => s && s.id).map((s) => [String(s.id), s]));
    }
    if (d && 'uso' in d) est.uso = d.uso || null;
    agendarRender();
  } catch {}
}
async function atualizarUso() {
  if (Date.now() - est.vistoUso < 5000) return;
  est.vistoUso = Date.now();
  try { est.uso = (await api('/uso')) || est.uso; renderUso(); } catch {}
}
function agendarRender() {
  if (est.rafRender) return;
  est.rafRender = requestAnimationFrame(() => {
    est.rafRender = 0;
    if (!est.eu) return;
    try { renderLista(); renderUso(); renderSessao(); } catch (e) { console.warn('render', e); }
  });
}

// ───────────────────────────── 2. sessões ─────────────────────────────
const { ROTULO_STATUS: ROTULO, SPRITE, estadoSprite, pilula: pill } = OrbitBase; // assets/comum/base.js (a mesma do PC)
const GRUPOS = [
  { chave: 'precisa', titulo: 'Precisa de você' },
  { chave: 'trabalhando', titulo: 'Trabalhando' },
  { chave: 'paradas', titulo: 'Paradas' },
];
const MAX_PARADAS = 15;
const statusDe = (s) => (s.status in ROTULO ? s.status : 'nova');
const grupoDe = (s) => { const st = statusDe(s); return st === 'aguardando' || st === 'erro' ? 'precisa' : st === 'trabalhando' ? 'trabalhando' : 'paradas'; };
const nomeProj = (s) => limpo(s.projeto) || basename(s.cwd) || 'Sem projeto';
const nomeSessao = (s) => limpo(s.apelido) || limpo(s.titulo) || limpo(s.primeira) || limpo(s.tarefa) || limpo(s.nome) || 'Sessão ' + String(s.id).slice(0, 8);
function tipoPermissao(p) {
  if (p.tipo === 'pergunta' || p.tipo === 'plano' || p.tipo === 'ferramenta') return p.tipo;
  if (p.ferramenta === 'AskUserQuestion' && Array.isArray(p.perguntas)) return 'pergunta';
  if (p.ferramenta === 'ExitPlanMode') return 'plano';
  return 'ferramenta';
}
function detalheDe(s) {
  const st = statusDe(s);
  const p = s.controle && s.controle.permissao;
  if (st === 'aguardando') {
    if (!p) return 'Esperando você';
    const t = tipoPermissao(p);
    return t === 'pergunta' ? 'Fez uma pergunta' : t === 'plano' ? 'Plano para aprovar' : 'Pede permissão' + (p.ferramenta ? ': ' + p.ferramenta : '');
  }
  if (st === 'erro') return limpo(s.detalhe) || 'Terminou com erro';
  if (st === 'trabalhando') return limpo(s.detalhe) || (s.ferramenta && limpo(s.ferramenta.nome)) || 'Trabalhando…';
  return { concluida: 'Terminou a volta', interrompida: 'Interrompida', nova: 'Ainda sem pedido', encerrada: 'Processo encerrado' }[st] || '';
}
const referenciaTempo = (s) => (grupoDe(s) === 'precisa' ? Number(s.desde) || Number(s.atividade) || Date.now() : Number(s.atividade) || Number(s.desde) || Date.now());
// Avatar do agente: sprite pelo estado da sessão (mesma regra do PC: OrbitBase.estadoSprite), com o selo de status.
const hashTxt = (t) => { let x = 0; for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) | 0; return Math.abs(x); };
function spriteDe(s) {
  const st = statusDe(s);
  const ags = Array.isArray(s.agentes) ? s.agentes : [];
  const tokens = st === 'trabalhando' && s.contexto ? Number(s.contexto.tokens) || 0 : 0;
  const estado = estadoSprite(st, { ferramenta: s.ferramenta, subTrabalhando: ags.some((a) => a && a.status === 'trabalhando'), tokens });
  const l = SPRITE[estado] || SPRITE.dormindo;
  return l[l.length === 1 ? 0 : hashTxt(String(s.id) + '|' + (Number(s.desde) || 0) + '|' + estado) % l.length];
}
// Contexto usado (0 a 1) quando o servidor manda a porcentagem ou a janela; senão, sem barra.
function ctxDe(s) {
  const c = s.contexto;
  if (!c || !Number(c.tokens)) return null;
  const p = c.pct != null && isFinite(Number(c.pct)) ? Number(c.pct) / 100 : Number(c.janela) > 0 ? Number(c.tokens) / Number(c.janela) : null;
  return p == null ? null : Math.min(1, Math.max(0, p));
}
function avatar(st, sprite) {
  const img = h('img', { class: 'spr', alt: '', width: 46, height: 46, decoding: 'async', 'data-gif': sprite, src: '/assets/' + sprite + (/-parado$/.test(sprite) ? '.png' : '.gif') });
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  const selo = h('span', { class: 'av-selo', 'aria-hidden': 'true' });
  if (st === 'aguardando' || st === 'erro') selo.append('!');
  else if (st === 'concluida') selo.append(ico('check', 9));
  return h('span', { class: 'av-robo', 'data-s': st }, img, selo);
}

const lista = { grupos: new Map(), cards: new Map(), verTodas: false, vazio: null, chips: null, chipsSig: '', chipsPastas: new Map() };
// Filtro por projeto (aba Sessões): chave = pasta normalizada (cwd) ou, sem cwd, o nome do projeto.
const normPasta = (p) => String(p || '').replace(/[\\]/g, '/').replace(/\/+$/, '').toLowerCase();
const chaveProj = (s) => normPasta(s.cwd) || 'n:' + nomeProj(s).toLowerCase();
const FILTRO_LS = 'orbit.sessoes.projeto';
let filtroProj = 'todos';
try { filtroProj = localStorage.getItem(FILTRO_LS) || 'todos'; } catch {}
function escolherProj(k) {
  filtroProj = k;
  try { if (k === 'todos') localStorage.removeItem(FILTRO_LS); else localStorage.setItem(FILTRO_LS, k); } catch {}
  renderLista();
}
function renderChips(todas) {
  const mapa = new Map();
  for (const s of todas) {
    const k = chaveProj(s);
    const m = mapa.get(k) || { k, nome: nomeProj(s), pasta: s.cwd || '', n: 0 };
    m.n++; mapa.set(k, m);
  }
  const projs = [...mapa.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  if (filtroProj !== 'todos' && !mapa.has(filtroProj) && todas.length) { // projeto sumiu
    filtroProj = 'todos';
    try { localStorage.removeItem(FILTRO_LS); } catch {}
  }
  const itens = [{ k: 'todos', nome: 'Todos', n: todas.length }, ...projs];
  const sig = JSON.stringify([filtroProj, itens.map((i) => [i.k, i.nome, i.n])]);
  lista.chips.hidden = todas.length === 0;
  lista.chipsPastas = new Map(projs.map((p) => [p.k, p.pasta]));
  if (sig === lista.chipsSig) return;
  lista.chipsSig = sig;
  lista.chips.replaceChildren(...itens.map((i) => {
    const b = h('button', { type: 'button', class: 'chip sans filtro-proj', 'data-k': i.k, 'aria-pressed': String(i.k === filtroProj) },
      h('span', { class: 'filtro-nome' }, i.nome), h('span', { class: 'filtro-n' }, String(i.n)));
    b.addEventListener('click', () => escolherProj(i.k));
    return b;
  }));
}
function montarGrupos() {
  const raiz = $('lista-sessoes');
  for (const g of GRUPOS) {
    const n = h('span', { class: 'n' }, '0');
    const cards = h('div', { class: 'cards' });
    const sec = h('section', { class: 'grupo', 'data-g': g.chave, hidden: true }, h('h2', { class: 'grupo-cab' }, h('span', null, g.titulo), n), cards);
    lista.grupos.set(g.chave, { sec, n, cards, ordem: '' });
    raiz.append(sec);
  }
  lista.vazio = h('div', { class: 'vazio', hidden: true }, ico('lista', 32), h('p', null, 'Nenhuma instância do Orbit aberta.'));
  lista.verMais = h('button', { class: 'btn bloco', type: 'button', hidden: true }, '');
  lista.verMais.addEventListener('click', () => { lista.verTodas = !lista.verTodas; renderLista(); });
  raiz.append(lista.vazio, lista.verMais);
  lista.chips = h('div', { class: 'filtro-projs', role: 'group', 'aria-label': 'Filtrar por projeto', hidden: true });
  raiz.prepend(lista.chips);
}
function sigCard(s) {
  return JSON.stringify([statusDe(s), nomeProj(s), nomeSessao(s), detalheDe(s), spriteDe(s), ctxDe(s) == null ? null : Math.round(ctxDe(s) * 100)]);
}
function preencherCard(el, s) {
  const st = statusDe(s);
  el.dataset.s = st;
  el.dataset.desde = String(referenciaTempo(s));
  el.setAttribute('aria-label', nomeProj(s) + ': ' + nomeSessao(s) + '. ' + ROTULO[st] + '. ' + detalheDe(s));
  const tempoEl = h('span', { class: 'card-tempo' }, tempo(referenciaTempo(s)));
  tempoEl.dataset.tempo = '1';
  const pct = ctxDe(s);
  el.replaceChildren(avatar(st, spriteDe(s)), h('div', { class: 'card-txt' },
    h('div', { class: 'card-l1' }, h('span', { class: 'card-proj', title: nomeProj(s) }, nomeProj(s)), tempoEl),
    h('p', { class: 'card-nome', title: nomeSessao(s) }, nomeSessao(s)),
    h('div', { class: 'card-l3' }, pill(st), h('span', { class: 'card-det' }, detalheDe(s))),
    ...(pct == null ? [] : [OrbitBase.barraUso(pct, Math.round(pct * 100) + '%')])));
}
function cardDe(s) {
  const id = String(s.id);
  let c = lista.cards.get(id);
  if (!c) {
    const el = h('a', { class: 'card', href: '#s=' + enc(id) });
    el.addEventListener('click', () => { est.doApp = true; });
    c = { el, sig: '' };
    lista.cards.set(id, c);
  }
  const sig = sigCard(s);
  if (c.sig !== sig) { c.sig = sig; preencherCard(c.el, s); }
  return c.el;
}
function renderLista() {
  if (!lista.grupos.size) montarGrupos();
  const todas = [...est.sessoes.values()];
  renderChips(todas);
  const por = { precisa: [], trabalhando: [], paradas: [] };
  const nPrecisa = todas.filter((s) => grupoDe(s) === 'precisa').length;
  for (const s of todas) if (filtroProj === 'todos' || chaveProj(s) === filtroProj) por[grupoDe(s)].push(s);
  por.precisa.sort((a, b) => referenciaTempo(a) - referenciaTempo(b));
  por.trabalhando.sort((a, b) => referenciaTempo(b) - referenciaTempo(a));
  por.paradas.sort((a, b) => referenciaTempo(b) - referenciaTempo(a));
  const totalParadas = por.paradas.length;
  if (!lista.verTodas) por.paradas = por.paradas.slice(0, MAX_PARADAS);
  for (const g of GRUPOS) {
    const o = lista.grupos.get(g.chave);
    const itens = por[g.chave];
    o.sec.hidden = !itens.length;
    txt(o.n, g.chave === 'paradas' ? totalParadas : itens.length);
    const els = itens.map(cardDe);
    const ordem = itens.map((s) => s.id).join('|');
    if (o.ordem !== ordem) { o.ordem = ordem; o.cards.replaceChildren(...els); }
  }
  for (const [id, c] of lista.cards) if (!est.sessoes.has(id)) { c.el.remove(); lista.cards.delete(id); }
  lista.vazio.hidden = todas.length > 0;
  lista.verMais.hidden = totalParadas <= MAX_PARADAS;
  txt(lista.verMais, lista.verTodas ? 'Mostrar menos' : 'Ver todas as paradas (' + totalParadas + ')');
  const n = nPrecisa;
  const conta = $('aba-sessoes').querySelector('.conta');
  if (n && !conta) $('aba-sessoes').append(h('span', { class: 'conta', 'aria-label': n + ' precisam de você' }, String(n)));
  else if (n) { txt(conta, n); conta.setAttribute('aria-label', n + ' precisam de você'); }
  else if (conta) conta.remove();
  document.title = (n ? '(' + n + ') ' : '') + 'Orbit';
}
function atualizarTempos() {
  for (const el of document.querySelectorAll('.card')) {
    const t = el.querySelector('[data-tempo]');
    if (t) txt(t, tempo(Number(el.dataset.desde)));
  }
}

// ───────────────────────────── 4. uso do plano ─────────────────────────────
const USO_VELHO = 20 * 60e3;
const USO_JANELAS = [
  { k: 'cincoHoras', rot: 'Sessão', janela: 'janela de 5 h' },
  { k: 'semanal', rot: 'Semana', janela: 'janela de 7 dias' },
];
function renderUso() {
  const u = est.uso;
  const real = u && (u.cincoHoras || u.semanal) ? u : null;
  const caixa = $('uso-barras');
  const agora = Date.now();
  if (!real) {
    txt($('uso-sub'), '');
    caixa.replaceChildren(h('div', { class: 'vazio' }, ico('uso', 32), h('p', null, 'Ainda não há leitura do uso do plano. Ela aparece depois que o Orbit ou o terminal do PC usar o Claude.')));
    return;
  }
  const lido = Number(real.atualizado) || 0;
  const velho = !!lido && agora - lido > USO_VELHO;
  txt($('uso-sub'), lido ? 'Última leitura há ' + durRen(agora - lido) + (velho ? ' (pode ter mudado)' : '') : '');
  const cartoes = USO_JANELAS.map((x) => {
    const j = real[x.k];
    const tem = !!j && typeof j.pct === 'number' && isFinite(j.pct);
    const r = tem ? emMs(j.renova) : 0;
    const renovou = !!r && r <= agora;
    const pct = tem && !renovou ? Math.max(0, Math.min(100, Math.round(j.pct))) : null;
    const ren = !tem ? 'sem dados' : !r ? '' : renovou ? 'renovou ' + quando(r, agora) : null;
    const trilho = h('div', { class: 'trilho', role: 'meter', 'aria-label': x.rot + ', ' + x.janela, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct == null ? 0 : pct) });
    const barra = h('i');
    barra.style.width = (pct == null ? 0 : Math.max(2, pct)) + '%';
    if (pct != null) OrbitBase.degradeEscala(barra, pct / 100); // verde até 45%, amarelo, vermelho, roxo: a escala do PC
    trilho.append(barra);
    const renEl = h('p', { class: 'uso-ren' });
    if (ren != null) renEl.textContent = ren;
    else renEl.append('renova em ', h('b', null, durRen(r - agora)), ' · ' + quando(r, agora).replace(/^às /, ''));
    return h('div', { class: 'uso-cartao', 'data-k': x.k },
      h('div', { class: 'uso-l1' }, h('span', { class: 'quad' }, ico('uso', 16)), h('div', { class: 'uso-nome' }, x.rot, h('small', null, x.janela)), h('div', { class: 'uso-val' }, pct == null ? '—' : pct + '%')),
      trilho, renEl);
  });
  caixa.replaceChildren(...cartoes);
}

// ───────────────────────────── 3. sessão ─────────────────────────────
const LIMITE = 40;
const LONGA = 4000;
const cv = {
  id: null, gen: 0, itens: [], porId: new Map(), nos: new Map(), cursor: null, es: null, esTimer: 0,
  permId: '', permResp: '', anexos: [], seqLocal: 0, abertos: new Set(), parcPend: new Set(), parcRaf: 0,
  modelos: null, modelosErro: false, ajSig: '', ajPend: false, orbitOcup: false, orfaoTimer: 0, carregando: false,
};
const sessaoAtual = () => (cv.id ? est.sessoes.get(cv.id) : null);
const rotaSessao = (id, resto) => '/sessao/' + enc(id) + '/' + resto;
const ctl = () => { const s = sessaoAtual(); return s && s.controle ? s.controle : null; };

function fecharConversa() {
  clearTimeout(cv.esTimer);
  if (cv.es) { try { cv.es.close(); } catch {} cv.es = null; }
}
function fecharSessao() {
  if (!cv.id) return;
  fecharConversa();
  cv.id = null;
  cv.gen++;
  clearTimeout(cv.orfaoTimer);
}
async function abrirSessao(id) {
  if (cv.id === id) { renderSessao(); return; }
  fecharConversa();
  cv.id = id;
  const gen = ++cv.gen;
  Object.assign(cv, { itens: [], porId: new Map(), nos: new Map(), cursor: null, permId: '', permResp: '', ajSig: '', parcPend: new Set(), carregando: true });
  clearTimeout(cv.orfaoTimer);
  $('toast').hidden = true;
  $('cv-itens').replaceChildren();
  $('cv-mais').hidden = true;
  $('cv-novas').hidden = true;
  $('cv-texto').value = '';
  ajustarAltura();
  limparAnexos();
  $('cv-vazio').hidden = false;
  mostrarVazio('Carregando a conversa…');
  renderSessao();
  carregarModelos();
  if (!est.sessoes.has(id)) buscarSessao(id, gen);
  carregarInicio(id, gen);
}
async function buscarSessao(id, gen) {
  try {
    const d = await api(rotaSessao(id, '').replace(/\/$/, ''));
    if (gen !== cv.gen) return;
    if (d && d.sessao && d.sessao.id && !est.sessoes.has(id)) { est.sessoes.set(id, d.sessao); agendarRender(); }
  } catch (e) {
    if (gen === cv.gen && e.status === 404) mostrarVazio('Esta instância não está mais disponível no celular.');
  }
}
function mostrarVazio(t, comTentar) {
  const el = $('cv-vazio');
  el.replaceChildren(t);
  if (comTentar) el.append(h('br'), h('button', { class: 'btn', type: 'button', onclick: comTentar }, 'Tentar de novo'));
  el.hidden = false;
}
async function carregarInicio(id, gen) {
  try {
    const d = await api(rotaSessao(id, 'conversa?limite=' + LIMITE));
    if (gen !== cv.gen) return;
    cv.carregando = false;
    cv.cursor = d.cursorAntigo || null;
    receberItens(Array.isArray(d.itens) ? d.itens : [], { fim: true });
    if (!cv.itens.length) mostrarVazio('Nenhuma mensagem ainda.');
    $('cv-mais').hidden = !cv.cursor;
    conectarConversa(id, gen, d.cursorNovo);
  } catch (e) {
    if (gen !== cv.gen) return;
    cv.carregando = false;
    mostrarVazio(e.status === 404 ? 'Esta instância não está mais disponível no celular.' : 'Não deu para carregar a conversa. ' + e.message, e.status === 404 ? null : () => { cv.carregando = true; mostrarVazio('Carregando a conversa…'); carregarInicio(id, gen); });
  }
}
async function carregarAnteriores() {
  const id = cv.id, gen = cv.gen;
  if (!cv.cursor || cv.carregando) return;
  cv.carregando = true;
  const b = $('cv-mais');
  b.disabled = true;
  try {
    const d = await api(rotaSessao(id, 'conversa?antes=' + enc(cv.cursor) + '&limite=' + LIMITE));
    if (gen !== cv.gen) return;
    cv.cursor = d.cursorAntigo || null;
    const novos = (Array.isArray(d.itens) ? d.itens : []).filter((it) => it && it.id != null && !cv.porId.has(String(it.id)));
    const area = $('cv-rolagem');
    const antes = area.scrollHeight - area.scrollTop;
    const frag = document.createDocumentFragment();
    for (const it of novos) { const no = noItem(it); cv.nos.set(String(it.id), no); cv.porId.set(String(it.id), it); frag.append(no); }
    cv.itens.unshift(...novos);
    $('cv-itens').prepend(frag);
    area.scrollTop = area.scrollHeight - antes; // mantém o que já estava na tela
    b.hidden = !cv.cursor;
  } catch (e) {
    toast('Não deu para carregar: ' + e.message);
  } finally {
    cv.carregando = false;
    b.disabled = false;
  }
}
function conectarConversa(id, gen, desde) {
  fecharConversa();
  let es;
  try { es = new EventSource(rotaSessao(id, 'conversa/fluxo') + (desde != null && desde !== '' ? '?desde=' + enc(desde) : '')); } catch { return; }
  cv.es = es;
  const ler = (fn) => (ev) => { if (gen !== cv.gen || cv.es !== es) return; let d; try { d = JSON.parse(ev.data); } catch { return; } try { fn(d); } catch (e) { console.warn('conversa', e); } };
  es.addEventListener('itens', ler((d) => receberItens(Array.isArray(d && d.itens) ? d.itens : [])));
  es.addEventListener('parcial', ler((d) => receberParcial(d)));
  es.addEventListener('reinicio', ler((d) => {
    if (d && d.motivo === 'limpeza' && d.novaSessao && d.novaSessao !== cv.id) { location.hash = '#s=' + enc(d.novaSessao); return; }
    const i = cv.id; cv.id = null; abrirSessao(i);
  }));
  es.onerror = () => {
    if (gen !== cv.gen || cv.es !== es) return;
    try { es.close(); } catch {}
    cv.es = null;
    clearTimeout(cv.esTimer);
    cv.esTimer = setTimeout(() => { if (gen === cv.gen) retomarConversa(id, gen); }, 2500);
  };
}
// Depois de uma queda (ou de voltar ao app): busca o fim, junta pelo id e reabre o fluxo.
async function retomarConversa(id, gen) {
  try {
    const d = await api(rotaSessao(id, 'conversa?limite=' + LIMITE));
    if (gen !== cv.gen) return;
    receberItens(Array.isArray(d.itens) ? d.itens : []);
    conectarConversa(id, gen, d.cursorNovo);
  } catch {
    if (gen !== cv.gen) return;
    clearTimeout(cv.esTimer);
    cv.esTimer = setTimeout(() => retomarConversa(id, gen), 4000);
  }
}

const pertoDoFim = () => { const a = $('cv-rolagem'); return a.scrollHeight - a.scrollTop - a.clientHeight < 140; };
function rolarFim() { const a = $('cv-rolagem'); a.scrollTop = a.scrollHeight; $('cv-novas').hidden = true; }
function receberItens(lista_, opc = {}) {
  const perto = opc.fim || pertoDoFim();
  let novas = 0;
  const caixa = $('cv-itens');
  for (const it of lista_) {
    if (!it || it.id == null) continue;
    const chave = String(it.id);
    const ex = cv.porId.get(chave);
    if (ex) {
      const i = cv.itens.indexOf(ex);
      if (i >= 0) cv.itens[i] = it;
      cv.porId.set(chave, it);
      const velho = cv.nos.get(chave);
      const no = noItem(it);
      if (velho) velho.replaceWith(no); else caixa.append(no);
      cv.nos.set(chave, no);
      continue;
    }
    if (it.tipo === 'usuario' || it.tipo === 'par') casarLocal(it);
    cv.itens.push(it);
    cv.porId.set(chave, it);
    const no = noItem(it);
    cv.nos.set(chave, no);
    caixa.append(no);
    if (it.tipo === 'assistente' || it.tipo === 'erro') novas++;
  }
  if (cv.itens.length) $('cv-vazio').hidden = true;
  if (perto) rolarFim(); else if (novas) $('cv-novas').hidden = false;
}
// A bolha otimista some quando o item real da mesma mensagem chega do transcript.
function casarLocal(it) {
  const t = limpo(it.texto);
  const loc = cv.itens.find((x) => x.local && x.estado !== 'erro' && limpo(x.texto) === t);
  if (!loc) return;
  cv.itens.splice(cv.itens.indexOf(loc), 1);
  cv.porId.delete(String(loc.id));
  const no = cv.nos.get(String(loc.id));
  if (no) no.remove();
  cv.nos.delete(String(loc.id));
}
function receberParcial(d) {
  if (!d || d.id == null) return;
  const id = String(d.id);
  const texto = typeof d.texto === 'string' ? d.texto : '';
  const ex = cv.porId.get(id);
  if (ex) {
    if (!ex.parcial || ex.texto === texto) return;
    ex.texto = texto;
    cv.parcPend.add(id);
    if (!cv.parcRaf) cv.parcRaf = requestAnimationFrame(aplicarParciais);
    return;
  }
  receberItens([{ id: d.id, ts: Date.now(), tipo: 'assistente', texto, parcial: true }]);
}
function aplicarParciais() {
  cv.parcRaf = 0;
  const perto = pertoDoFim();
  for (const id of cv.parcPend) {
    const it = cv.porId.get(id), no = cv.nos.get(id);
    if (it && it.parcial && no) no.replaceChildren(md(it.texto));
  }
  cv.parcPend.clear();
  if (perto) rolarFim();
}
// A volta terminou e o parcial não ganhou o item final: marca como incompleto.
function marcarIncompletos() {
  for (const it of cv.itens) {
    if (!it.parcial) continue;
    it.parcial = false;
    it.incompleta = true;
    const velho = cv.nos.get(String(it.id));
    if (velho) { const no = noItem(it); velho.replaceWith(no); cv.nos.set(String(it.id), no); }
  }
}

// Markdown mínimo, montado com DOM (nada de innerHTML): blocos de código, listas, títulos, `código` e **negrito**.
function inline(el, t) {
  for (const parte of String(t).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
    if (!parte) continue;
    if (parte.startsWith('`') && parte.endsWith('`') && parte.length > 2) el.append(h('code', null, parte.slice(1, -1)));
    else if (parte.startsWith('**') && parte.endsWith('**') && parte.length > 4) el.append(h('strong', null, parte.slice(2, -2)));
    else el.append(parte);
  }
}
function md(texto) {
  const raiz = h('div', { class: 'md' });
  const partes = String(texto || '').split(/```[^\n]*\n?/);
  partes.forEach((parte, i) => {
    if (i % 2 === 1) { raiz.append(h('pre', null, h('code', null, parte.replace(/\n$/, '')))); return; }
    let lista_ = null;
    let par_ = [];
    const fecharPar = () => { if (par_.length) { const p = h('p'); par_.forEach((l, k) => { if (k) p.append(h('br')); inline(p, l); }); raiz.append(p); par_ = []; } };
    for (const l of parte.split('\n')) {
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(l);
      const tit = /^#{1,6}\s+(.*)$/.exec(l);
      if (li) {
        fecharPar();
        const ord = /^\s*\d+\./.test(l);
        if (!lista_ || lista_.ord !== ord) { lista_ = { ord, el: h(ord ? 'ol' : 'ul') }; raiz.append(lista_.el); }
        const item = h('li');
        inline(item, li[1]);
        lista_.el.append(item);
      } else {
        lista_ = null;
        if (tit) { fecharPar(); const t = h('h4'); inline(t, tit[1]); raiz.append(t); }
        else if (!l.trim()) fecharPar();
        else par_.push(l);
      }
    }
    fecharPar();
  });
  return raiz;
}

function fotosDe(it) {
  const urls = (it.imagens || []).map((x) => x.url || (x.o != null ? rotaSessao(cv.id, 'imagem') + '?o=' + x.o + '&i=' + x.i : '')).filter(Boolean);
  if (!urls.length) return null;
  return h('div', { class: 'it-fotos' }, ...urls.map((u) => h('img', { src: u, alt: 'Foto enviada', loading: 'lazy', decoding: 'async' })));
}
function noItem(it) {
  let el;
  try {
    switch (it.tipo) {
      case 'usuario': case 'par': el = bolha(it); break;
      case 'assistente': {
        el = h('div', { class: 'it it-assist', 'data-parcial': it.parcial ? '1' : null }, md(it.texto));
        if (it.incompleta) el.append(h('p', { class: 'nota' }, 'Resposta incompleta'));
        break;
      }
      case 'pensamento': {
        const t = limpo(it.texto);
        el = t ? h('details', { class: 'it it-pens' }, h('summary', null, 'Pensamento'), h('div', null, String(it.texto))) : h('div', { class: 'it it-nota' }, 'Pensou');
        break;
      }
      case 'ferramenta': el = ferramenta(it); break;
      case 'compactacao': el = h('div', { class: 'it it-nota' }, it.auto ? 'Contexto compactado automaticamente' : 'Contexto compactado'); break;
      case 'limpeza': el = h('div', { class: 'it it-nota' }, 'Conversa limpa'); break;
      case 'interrupcao': el = h('div', { class: 'it it-nota' }, 'Interrompido'); break;
      case 'comando': el = h('div', { class: 'it it-nota' }, String(it.texto || '')); break;
      case 'saida': el = h('div', { class: 'it it-saida' }, String(it.texto || '')); break;
      case 'erro': el = h('div', { class: 'it it-erro', role: 'note' }, String(it.texto || 'Erro sem detalhe')); break;
      default: el = h('div', { class: 'it it-nota' }, String(it.texto || it.tipo || 'item'));
    }
  } catch (e) {
    console.warn('item', e);
    el = h('div', { class: 'it it-nota' }, 'Item que não deu para mostrar');
  }
  el.dataset.id = String(it.id);
  return el;
}
function bolha(it) {
  const texto = String(it.texto || '');
  const meta = h('div', { class: 'it-meta' });
  if (it.local) {
    if (it.estado === 'em_andamento') meta.append('Enviando…');
    else if (it.estado === 'sucesso') meta.append(ico('check', 12), 'Enviada');
    else if (it.estado === 'erro') meta.append('Não enviada');
  } else if (it.ts) meta.append(hora(it.ts));
  const corpo = texto.length > LONGA && !cv.abertos.has(String(it.id)) ? texto.slice(0, LONGA) + '…' : texto;
  const el = h('div', { class: 'it it-usuario', 'data-estado': it.local ? it.estado : null }, fotosDe(it), texto ? corpo : null, meta);
  if (it.local && it.estado === 'erro') {
    el.append(h('div', { class: 'it-erro-msg', role: 'alert' }, it.erro || 'O servidor não explicou o erro.'),
      h('div', { class: 'it-meta' },
        h('button', { class: 'link', type: 'button', onclick: () => tentarDeNovo(it) }, 'Tentar de novo'),
        h('button', { class: 'link', type: 'button', onclick: () => descartar(it) }, 'Descartar')));
  }
  return el;
}
function ferramenta(it) {
  const res = it.resultado;
  const e = !res ? 'andando' : res.erro ? 'erro' : 'ok';
  const chave = String(it.id);
  const aberta = cv.abertos.has(chave);
  const corpo = h('div', { class: 'it-ferr-corpo', hidden: !aberta });
  const preencher = () => {
    if (corpo.firstChild) return;
    const t = res && String(res.texto || '');
    corpo.append(h('pre', null, !res ? 'Ainda rodando…' : t ? (t.length > LONGA ? t.slice(0, LONGA) + '\n…' : t) : res.erro ? 'Falhou sem mensagem.' : 'Sem saída.'));
  };
  if (aberta) preencher();
  const cab = h('button', { class: 'it-ferr-cab', type: 'button', 'aria-expanded': String(aberta) },
    ico(e === 'andando' ? 'atividade' : e === 'erro' ? 'x' : 'check', 14),
    h('span', { class: 'it-ferr-nome' }, String(it.nome || 'Ferramenta')),
    h('span', { class: 'it-ferr-res' }, String(it.resumo || '')),
    h('span', { class: 'sr' }, e === 'andando' ? ', rodando' : e === 'erro' ? ', com erro' : ', concluída'));
  cab.addEventListener('click', () => {
    const abrir = corpo.hidden;
    if (abrir) { preencher(); cv.abertos.add(chave); } else cv.abertos.delete(chave);
    corpo.hidden = !abrir;
    cab.setAttribute('aria-expanded', String(abrir));
  });
  return h('div', { class: 'it it-ferr', 'data-e': e }, cab, corpo);
}

// ── cabeçalho, estado e envio ──
function renderSessao() {
  if (!cv.id || $('v-sessao').hidden) return;
  const s = sessaoAtual();
  txt($('s-proj'), s ? nomeProj(s) : '');
  txt($('s-nome'), s ? nomeSessao(s) : 'Sessão');
  $('s-nome').title = s ? nomeSessao(s) : '';
  const pl = $('s-pill');
  const st = s ? statusDe(s) : '';
  if (pl.dataset.s !== st) { pl.dataset.s = st; pl.replaceChildren(...(st ? [pill(st)] : [])); }
  renderPerm();
  renderEstado();
  renderAjustes();
  renderMedidor();
  atualizarEnvio();
}
function renderEstado() {
  const c = ctl();
  const ocup = !!(c && c.ocupada);
  const iniciando = !!(c && /inician/i.test(c.motivo || ''));
  $('cv-estado').hidden = !ocup;
  txt($('cv-estado-txt'), iniciando ? 'Iniciando a instância…' : c && c.permissao ? 'Esperando você' : 'Trabalhando…');
  const aviso = $('cv-aviso');
  const dorme = !!(c && c.processo === 'dormindo');
  aviso.hidden = !dorme;
  if (dorme) txt(aviso, 'Instância dormindo: ao enviar uma mensagem ela acorda.');
  if (cv.orbitOcup && !ocup) { clearTimeout(cv.orfaoTimer); cv.orfaoTimer = setTimeout(marcarIncompletos, 4000); }
  if (ocup) clearTimeout(cv.orfaoTimer);
  cv.orbitOcup = ocup;
}
async function pararVolta() {
  const id = cv.id;
  const b = $('cv-parar');
  b.disabled = true;
  try { await api(rotaSessao(id, 'parar'), {}); toast('Parando a volta…'); } catch (e) { toast('Não deu para parar: ' + e.message); } finally { b.disabled = false; }
}

// Permissão (ferramenta | pergunta | plano), com os mesmos corpos da página do PC.
function btn(classe, rotulo, extra) {
  const b = h('button', { type: 'button', class: 'btn ' + classe, ...extra }, rotulo);
  b._txt = rotulo;
  return b;
}
function renderPerm() {
  const box = $('cv-perm');
  const c = ctl();
  const p = c && c.permissao && c.permissao.id != null && String(c.permissao.id) !== cv.permResp ? c.permissao : null;
  if (!p) {
    if (!box.hidden) { box.hidden = true; box.replaceChildren(); }
    cv.permId = '';
    return;
  }
  const fila = Math.max(0, (Number(c.pendentes) || 1) - 1);
  if (cv.permId === String(p.id)) {
    const f = box.querySelector('.perm-fila');
    if (f) { txt(f, fila ? 'mais ' + fila + ' na fila' : ''); f.hidden = !fila; }
    return;
  }
  cv.permId = String(p.id);
  const tipo = tipoPermissao(p);
  const cartao = { p, tipo, id: cv.id, gen: cv.gen, erro: h('p', { class: 'erro perm-erro', role: 'alert', hidden: true }) };
  let partes;
  try { partes = tipo === 'pergunta' ? cartaoPergunta(cartao) : tipo === 'plano' ? cartaoPlano(cartao) : cartaoFerramenta(cartao); } catch (e) { console.warn('permissão', e); partes = cartaoFerramenta(cartao); }
  const [icone, titulo, chip, corpo, botoes] = partes;
  box.dataset.tipo = tipo;
  box.replaceChildren(
    h('div', { class: 'perm-cab' }, ico(icone, 18), h('strong', null, titulo, ' ', h('span', { class: 'perm-fila', hidden: !fila }, fila ? 'mais ' + fila + ' na fila' : '')),
      chip ? h('span', { class: 'perm-chip', title: chip }, chip) : null),
    corpo, cartao.erro, botoes);
  box.hidden = false;
  box.scrollTop = 0;
}
async function responderPermissao(cartao, corpo, botao, aviso) {
  const { p, id, gen } = cartao;
  if (gen !== cv.gen || cv.permId !== String(p.id)) return;
  const box = $('cv-perm');
  const controles = [...box.querySelectorAll('button, input, textarea')];
  for (const x of controles) x.disabled = true;
  cartao.erro.hidden = true;
  if (botao) botao.textContent = 'Enviando…';
  const destravar = () => { for (const x of controles) x.disabled = false; if (botao) botao.textContent = botao._txt; if (cartao.validar) cartao.validar(); };
  try {
    await api(rotaSessao(id, 'permissao'), { id: p.id, ...corpo });
    if (gen !== cv.gen) return;
    cv.permResp = String(p.id);
    toast(aviso);
    renderPerm();
  } catch (e) {
    if (gen !== cv.gen) return;
    if (e.status === 404 || e.status === 409) { cv.permResp = String(p.id); toast('Esse pedido já foi respondido.'); renderPerm(); return; }
    destravar();
    txt(cartao.erro, 'Não deu para responder: ' + e.message);
    cartao.erro.hidden = false;
  }
}
const sugestoesDe = (p) => (Array.isArray(p.sugestoes) ? p.sugestoes : []).filter((s) => s && s.indice != null && limpo(s.rotulo));
const ehAceitarEdicoes = (s) => s && (s.modo === 'acceptEdits' || /aceit\w*\s+(as\s+)?edi[cç]/i.test(String(s.rotulo || '')));

function cartaoFerramenta(cartao) {
  const { p } = cartao;
  let entrada = '';
  try { entrada = p.entrada == null ? '' : typeof p.entrada === 'string' ? p.entrada : JSON.stringify(p.entrada, null, 2); } catch {}
  const corpo = h('div', null,
    p.resumo ? h('div', { class: 'perm-resumo' }, String(p.resumo)) : null,
    entrada ? h('details', null, h('summary', null, 'Ver a entrada completa'), h('pre', null, entrada)) : null);
  const sugs = sugestoesDe(p).map((s) => {
    const b = btn('', String(s.rotulo));
    b.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir', sugestao: s.indice }, b, 'Permitido: ' + s.rotulo + '.'));
    return b;
  });
  if (sugs.length) corpo.append(h('div', { class: 'perm-sugs', role: 'group', 'aria-label': 'Permitir com uma regra' }, ...sugs));
  const motivo = h('input', { class: 'campo perm-motivo', type: 'text', maxlength: 2000, placeholder: 'Motivo (opcional): o agente recebe este texto', 'aria-label': 'Motivo da negativa', autocomplete: 'off', hidden: true });
  const comMotivo = h('button', { type: 'button', class: 'link', 'aria-expanded': 'false' }, 'Negar com motivo…');
  const negar = btn('', 'Negar');
  const permitir = btn('prim', 'Permitir');
  const enviarNegar = () => { const m = motivo.hidden ? '' : motivo.value.trim().slice(0, 2000); responderPermissao(cartao, m ? { decisao: 'negar', mensagem: m } : { decisao: 'negar' }, negar, m ? 'Negado, com o motivo.' : 'Negado.'); };
  comMotivo.addEventListener('click', () => {
    motivo.hidden = !motivo.hidden;
    comMotivo.setAttribute('aria-expanded', String(!motivo.hidden));
    txt(comMotivo, motivo.hidden ? 'Negar com motivo…' : 'Sem motivo');
    if (motivo.hidden) motivo.value = ''; else motivo.focus();
  });
  negar.addEventListener('click', enviarNegar);
  permitir.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir' }, permitir, 'Permitido.'));
  corpo.append(comMotivo, motivo);
  return ['cadeado', 'Permissão pedida', String(p.ferramenta || 'Ferramenta'), corpo, h('div', { class: 'perm-b' }, negar, permitir)];
}
function cartaoPergunta(cartao) {
  const { p } = cartao;
  const perguntas = (Array.isArray(p.perguntas) ? p.perguntas : []).filter((q) => q && limpo(q.pergunta));
  if (!perguntas.length) return cartaoFerramenta(cartao);
  const nome = 'q-' + String(p.id).replace(/[^\w-]/g, '_');
  const estado = perguntas.map(() => ({ sel: new Set(), outra: false }));
  const corpo = h('div');
  const responder = btn('prim', 'Responder');
  const pular = btn('', 'Não responder');
  const livres = [];
  perguntas.forEach((q, qi) => {
    const multipla = !!q.multipla;
    const opcoes = (Array.isArray(q.opcoes) ? q.opcoes : []).filter((o) => o && limpo(o.rotulo));
    const ops = h('div', { class: 'q-ops', role: multipla ? 'group' : 'radiogroup' });
    const livre = h('input', { class: 'campo', type: 'text', maxlength: 2000, placeholder: 'Escreva a sua resposta', 'aria-label': 'Outra resposta para: ' + q.pergunta, autocomplete: 'off', hidden: true });
    livres[qi] = livre;
    const opcao = (rotulo, descricao, chave) => {
      const input = h('input', { type: multipla ? 'checkbox' : 'radio', name: nome + '-' + qi, value: String(chave) });
      const lab = h('label', { class: 'op' }, input, h('span', null, h('span', { class: 'op-rot' }, rotulo), descricao ? h('span', { class: 'op-desc' }, descricao) : null));
      input.addEventListener('change', () => {
        const e = estado[qi];
        if (!multipla) { e.sel.clear(); e.outra = false; }
        if (chave === 'outra') e.outra = input.checked;
        else if (input.checked) e.sel.add(chave); else e.sel.delete(chave);
        for (const l of ops.querySelectorAll('.op')) l.classList.toggle('marcada', l.firstChild.checked);
        livre.hidden = !e.outra;
        if (e.outra && chave === 'outra') livre.focus();
        validar();
      });
      return lab;
    };
    opcoes.forEach((o, oi) => ops.append(opcao(String(o.rotulo), o.descricao ? String(o.descricao) : '', oi)));
    ops.append(opcao('Outra resposta', '', 'outra'));
    livre.addEventListener('input', validar);
    corpo.append(h('div', { class: 'q', role: 'group' },
      q.cabecalho ? h('span', { class: 'q-tag' }, String(q.cabecalho)) : null,
      h('p', { class: 'q-txt' }, String(q.pergunta), multipla ? ' (escolha uma ou mais)' : ''),
      ops, livre));
  });
  function respostas() {
    const r = {};
    let faltam = 0;
    perguntas.forEach((q, qi) => {
      const e = estado[qi];
      const opcoes = (Array.isArray(q.opcoes) ? q.opcoes : []).filter((o) => o && limpo(o.rotulo));
      const partes = [...e.sel].sort((a, b) => a - b).map((i) => String(opcoes[i].rotulo));
      const livre = e.outra ? livres[qi].value.trim() : '';
      if (livre) partes.push(livre);
      if (!partes.length) { faltam++; return; }
      r[String(q.pergunta)] = q.multipla ? partes.join(', ') : partes[0];
    });
    return { r, faltam };
  }
  function validar() {
    const { faltam } = respostas();
    responder._motivo = !faltam ? '' : perguntas.length === 1 ? 'Escolha uma resposta primeiro.' : faltam === 1 ? 'Falta responder 1 pergunta.' : 'Faltam ' + faltam + ' perguntas.';
    responder.setAttribute('aria-disabled', responder._motivo ? 'true' : 'false');
  }
  cartao.validar = validar;
  validar();
  responder.addEventListener('click', () => {
    if (responder.getAttribute('aria-disabled') === 'true') { txt(cartao.erro, responder._motivo); cartao.erro.hidden = false; return; }
    responderPermissao(cartao, { decisao: 'permitir', respostas: respostas().r }, responder, 'Resposta enviada.');
  });
  pular.addEventListener('click', () => responderPermissao(cartao, { decisao: 'negar' }, pular, 'Pergunta recusada.'));
  return ['ajuda', perguntas.length > 1 ? 'O agente tem ' + perguntas.length + ' perguntas' : 'Pergunta do agente', null, corpo, h('div', { class: 'perm-b' }, pular, responder)];
}
function cartaoPlano(cartao) {
  const { p } = cartao;
  let plano = typeof p.plano === 'string' ? p.plano : '';
  if (!plano && p.entrada && typeof p.entrada.plan === 'string') plano = p.entrada.plan;
  const corpo = h('div', null, h('div', { class: 'perm-plano' }, md(plano || '_O agente não mandou o texto do plano._')));
  const sugs = sugestoesDe(p);
  const aceitar = sugs.find(ehAceitarEdicoes);
  const outras = sugs.filter((s) => s !== aceitar).map((s) => {
    const b = btn('', String(s.rotulo));
    b.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir', sugestao: s.indice }, b, 'Plano aprovado: ' + s.rotulo + '.'));
    return b;
  });
  const comentario = h('textarea', { class: 'campo perm-motivo', rows: 2, maxlength: 2000, placeholder: 'O que mudar no plano (opcional): o agente recebe este texto', 'aria-label': 'Comentário sobre o plano', hidden: true });
  const continuar = btn('', 'Continuar planejando');
  const aprovar = btn('prim', 'Aprovar');
  continuar.addEventListener('click', () => {
    if (comentario.hidden) { comentario.hidden = false; continuar._txt = 'Enviar e continuar planejando'; continuar.textContent = continuar._txt; comentario.focus(); return; }
    const m = comentario.value.trim().slice(0, 2000);
    responderPermissao(cartao, m ? { decisao: 'negar', mensagem: m } : { decisao: 'negar' }, continuar, 'O agente continua planejando.');
  });
  aprovar.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir' }, aprovar, 'Plano aprovado.'));
  const botoes = [aprovar];
  if (aceitar) {
    const ae = btn('', 'Aprovar e aceitar edições');
    ae.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir', sugestao: aceitar.indice }, ae, 'Plano aprovado; edições aceitas sem perguntar.'));
    botoes.push(ae);
  }
  botoes.push(...outras, continuar);
  corpo.append(comentario);
  return ['lista', 'Plano para aprovar', null, corpo, h('div', { class: 'perm-sugs' }, ...botoes)];
}

// ── modelo e esforço ──
const ROTULO_ESFORCO = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
const rotuloEsforco = (e) => ROTULO_ESFORCO[e] || e || 'Padrão';
function rotuloModelo(m) {
  if (m.valor !== 'default') return m.nome || m.valor;
  const alvo = (cv.modelos || []).find((x) => x.valor !== 'default' && x.modelo === m.modelo);
  return 'Padrão · ' + ((alvo && alvo.nome) || m.descricao || m.modelo || 'recomendado');
}
// O servidor responde 503 enquanto ainda não leu os modelos do Claude: tenta de novo algumas vezes.
async function carregarModelos(tentativa = 0) {
  if (cv.modelos) return;
  try {
    const d = await api('/modelos');
    const l = Array.isArray(d) ? d : Array.isArray(d.modelos) ? d.modelos : null;
    if (l) { cv.modelos = l.filter((m) => m && m.valor); cv.ajSig = ''; renderAjustes(); }
  } catch (e) {
    cv.modelosErro = true;
    if (e.status === 503 && tentativa < 4 && est.eu) setTimeout(() => carregarModelos(tentativa + 1), 5000);
  }
}
function renderAjustes() {
  const det = $('cv-aj');
  const c = ctl();
  const ok = !!(c && c.modo === 'orbit' && cv.modelos && cv.modelos.length);
  det.hidden = !ok;
  if (!ok) return;
  const valor = c.modelo || 'default';
  const m = cv.modelos.find((x) => x.valor === valor) || null;
  const esf = c.esforco || '';
  const sig = JSON.stringify([cv.id, valor, esf, cv.ajPend]);
  if (sig === cv.ajSig) return;
  cv.ajSig = sig;
  const sm = $('cv-modelo'), se = $('cv-esforco');
  sm.replaceChildren(...cv.modelos.map((x) => h('option', { value: x.valor }, rotuloModelo(x))));
  if (!m) sm.append(h('option', { value: valor }, valor));
  sm.value = valor;
  const lista_ = m && Array.isArray(m.esforcos) ? m.esforcos : [];
  se.replaceChildren(...(esf && !lista_.includes(esf) ? [h('option', { value: esf }, rotuloEsforco(esf))] : []), ...(esf ? [] : [h('option', { value: '', disabled: true }, 'Padrão')]), ...lista_.map((e) => h('option', { value: e }, rotuloEsforco(e))));
  se.value = esf;
  sm.disabled = cv.ajPend;
  se.disabled = cv.ajPend || !lista_.length;
  det.querySelector('summary').replaceChildren('Modelo e esforço · ', h('b', null, m ? rotuloModelo(m).replace(/^Padrão · /, '') : valor), lista_.length ? ' · ' + rotuloEsforco(esf) : '');
}
async function trocarAjuste(tipo, valor) {
  const id = cv.id, gen = cv.gen;
  if (!id || !valor || cv.ajPend) return;
  cv.ajPend = true;
  cv.ajSig = '';
  renderAjustes();
  try {
    await api(rotaSessao(id, tipo), tipo === 'modelo' ? { modelo: valor } : { esforco: valor });
    toast((tipo === 'modelo' ? 'Modelo' : 'Esforço') + ' alterado: vale a partir da próxima resposta.');
  } catch (e) {
    toast((tipo === 'modelo' ? 'O modelo não mudou: ' : 'O esforço não mudou: ') + e.message);
  } finally {
    cv.ajPend = false;
    cv.ajSig = '';
    if (gen === cv.gen) renderAjustes();
  }
}

// ── compositor ──
function ajustarAltura() {
  const t = $('cv-texto');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}
// Medidor de contexto do compositor: anel fino com a fração usada; sem dado, fica oculto.
const RAIO_ANEL = 11, VOLTA_ANEL = 2 * Math.PI * RAIO_ANEL;
function renderMedidor() {
  const m = $('cv-medidor');
  const s = sessaoAtual();
  const p = s ? ctxDe(s) : null;
  m.hidden = p == null;
  if (p == null) return;
  if (!m.firstChild) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('aria-hidden', 'true');
    for (const c of ['tr', 'pr']) {
      const k = document.createElementNS(NS, 'circle');
      k.setAttribute('class', c); k.setAttribute('cx', '14'); k.setAttribute('cy', '14'); k.setAttribute('r', String(RAIO_ANEL));
      svg.append(k);
    }
    m.append(svg);
  }
  const pr = m.querySelector('.pr');
  pr.setAttribute('stroke-dasharray', (Math.max(0.02, p) * VOLTA_ANEL).toFixed(2) + ' ' + VOLTA_ANEL.toFixed(2));
  m.style.color = OrbitBase.corEscala(p);
  const n = Math.round(p * 100), tk = Number(s.contexto.tokens) || 0;
  const rot = 'Contexto: ' + n + '%' + (tk ? ' (' + (tk >= 1000 ? Math.round(tk / 1000) + ' mil' : tk) + ' tokens)' : '');
  m.dataset.pct = String(n);
  m.dataset.rot = rot;
  m.setAttribute('aria-label', rot);
  m.title = rot;
}
function atualizarEnvio() {
  const c = ctl();
  const iniciando = !!(c && /inician/i.test(c.motivo || ''));
  const pronto = ($('cv-texto').value.trim() || cv.anexos.length) && !cv.anexos.some((a) => a.preparando) && !iniciando;
  $('cv-enviar').disabled = !pronto;
}
function renderFaixa() {
  const f = $('cv-faixa');
  f.hidden = !cv.anexos.length;
  f.replaceChildren(...cv.anexos.map((a) => h('div', { class: 'cv-miniatura' },
    a.preparando ? h('div', { class: 'nota' }, 'Preparando…') : h('img', { src: a.url, alt: 'Foto anexada' }),
    h('button', { type: 'button', 'aria-label': 'Remover foto', onclick: () => { cv.anexos = cv.anexos.filter((x) => x !== a); if (a.url) URL.revokeObjectURL(a.url); renderFaixa(); atualizarEnvio(); } }, h('span', null, ico('x', 12))))));
}
function limparAnexos(manter) {
  if (!manter) for (const a of cv.anexos) if (a.url) URL.revokeObjectURL(a.url);
  cv.anexos = [];
  renderFaixa();
}
const MAX_FOTOS = 4;
function blobBase64(blob) {
  return new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => falha(new Error('leitura da foto'));
    r.readAsDataURL(blob);
  });
}
async function imagemDe(file) {
  try { return await createImageBitmap(file); } catch {}
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((ok, falha) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => falha(new Error('imagem')); i.src = url; });
  } finally { URL.revokeObjectURL(url); }
}
// Reduz para no máximo 1600 px e vira JPEG: fotos do iPhone passam de 5 MB e podem vir em HEIC.
async function prepararImagem(file) {
  const img = await imagemDe(file);
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const esc = Math.min(1, 1600 / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * esc));
  c.height = Math.max(1, Math.round(h0 * esc));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
  if (!blob) throw new Error('conversão');
  return { tipo: 'image/jpeg', dados: await blobBase64(blob), url: URL.createObjectURL(blob) };
}
async function adicionarFotos(files) {
  for (const f of files) {
    if (cv.anexos.length >= MAX_FOTOS) { toast('No máximo ' + MAX_FOTOS + ' fotos por mensagem.'); break; }
    const marca = { preparando: true };
    cv.anexos.push(marca);
    renderFaixa();
    atualizarEnvio();
    try {
      Object.assign(marca, await prepararImagem(f));
      marca.preparando = false;
    } catch {
      cv.anexos = cv.anexos.filter((x) => x !== marca);
      toast('Não consegui usar esta foto.');
    }
    renderFaixa();
    atualizarEnvio();
  }
}
async function enviarMensagem(ev) {
  if (ev) ev.preventDefault();
  const id = cv.id;
  const texto = $('cv-texto').value.trim();
  const imgs = cv.anexos.filter((a) => !a.preparando);
  if (!id || (!texto && !imgs.length) || $('cv-enviar').disabled) return;
  const local = { id: 'local-' + (++cv.seqLocal), tipo: 'usuario', texto, local: true, estado: 'em_andamento', imagens: imgs.map((a) => ({ url: a.url })), _envio: imgs.map((a) => ({ tipo: a.tipo, dados: a.dados })) };
  cv.itens.push(local);
  cv.porId.set(local.id, local);
  const no = noItem(local);
  cv.nos.set(local.id, no);
  $('cv-itens').append(no);
  $('cv-vazio').hidden = true;
  $('cv-texto').value = '';
  ajustarAltura();
  limparAnexos(true);
  atualizarEnvio();
  rolarFim();
  await enviarLocal(local, id);
}
async function enviarLocal(local, id) {
  local.estado = 'em_andamento';
  trocarNo(local);
  try {
    await api(rotaSessao(id, 'mensagem'), local._envio.length ? { texto: local.texto, imagens: local._envio } : { texto: local.texto });
    local.estado = 'sucesso';
  } catch (e) {
    local.estado = 'erro';
    local.erro = e.message;
  }
  if (cv.porId.get(local.id) === local) trocarNo(local);
}
function trocarNo(it) {
  const velho = cv.nos.get(String(it.id));
  const no = noItem(it);
  if (velho) velho.replaceWith(no);
  cv.nos.set(String(it.id), no);
}
function tentarDeNovo(it) { enviarLocal(it, cv.id); }
function descartar(it) {
  cv.itens.splice(cv.itens.indexOf(it), 1);
  cv.porId.delete(String(it.id));
  const no = cv.nos.get(String(it.id));
  if (no) no.remove();
  cv.nos.delete(String(it.id));
  if (!cv.itens.length) mostrarVazio('Nenhuma mensagem ainda.');
}

// ───────────────────────────── nova instância ─────────────────────────────
const nova = { projetos: null, ocupado: false };
function erroNova(t) { const el = $('nova-erro'); el.hidden = !t; txt(el, t || ''); }
async function abrirNova(pasta) {
  $('v-nova').hidden = false;
  erroNova('');
  $('nova-texto').value = '';
  const sp = $('nova-projeto'), sm = $('nova-modelo');
  sp.replaceChildren(h('option', { value: '' }, 'Carregando…'));
  sm.replaceChildren(h('option', { value: '' }, 'Carregando…'));
  $('nova-esforco').replaceChildren();
  $('nova-criar').disabled = true;
  const [pr, mo] = await Promise.allSettled([api('/remoto/projetos'), api('/modelos')]);
  if (pr.status === 'fulfilled') {
    const l = (Array.isArray(pr.value) ? pr.value : pr.value.projetos || []).filter((p) => p && p.pasta);
    nova.projetos = l;
    sp.replaceChildren(...(l.length ? l.map((p) => h('option', { value: p.pasta }, p.nome || basename(p.pasta))) : [h('option', { value: '' }, 'Nenhum projeto cadastrado')]));
    const alvoN = typeof pasta === 'string' ? normPasta(pasta) : '', ach = alvoN && l.find((p) => normPasta(p.pasta) === alvoN);
    if (ach) sp.value = ach.pasta;
  } else { sp.replaceChildren(h('option', { value: '' }, 'Indisponível')); erroNova('Não deu para listar os projetos: ' + pr.reason.message); }
  if (mo.status === 'fulfilled') {
    const l = (Array.isArray(mo.value) ? mo.value : mo.value.modelos || []).filter((m) => m && m.valor);
    cv.modelos = cv.modelos || l;
    sm.replaceChildren(...l.map((m) => h('option', { value: m.valor }, rotuloModelo(m))));
    preencherEsforcoNova();
  } else { sm.replaceChildren(h('option', { value: '' }, 'Modelo padrão')); }
  $('nova-criar').disabled = !(nova.projetos && nova.projetos.length);
}
function preencherEsforcoNova() {
  const m = (cv.modelos || []).find((x) => x.valor === $('nova-modelo').value);
  const l = m && Array.isArray(m.esforcos) ? m.esforcos : [];
  const se = $('nova-esforco');
  se.replaceChildren(h('option', { value: '' }, l.length ? 'Padrão' : 'Sem esforço'), ...l.map((e) => h('option', { value: e }, rotuloEsforco(e))));
  se.disabled = !l.length;
}
async function criarInstancia(ev) {
  ev.preventDefault();
  if (nova.ocupado) return;
  const pasta = $('nova-projeto').value;
  if (!pasta) { erroNova('Escolha um projeto.'); return; }
  const corpo = { pasta, cwd: pasta, permissao: $('nova-perm').value || 'default' };
  if ($('nova-modelo').value) corpo.modelo = $('nova-modelo').value;
  if ($('nova-esforco').value) corpo.esforco = $('nova-esforco').value;
  const texto = $('nova-texto').value;
  if (texto.trim()) corpo.texto = texto.slice(0, 20000);
  nova.ocupado = true;
  $('nova-criar').disabled = true;
  erroNova('');
  try {
    const d = await api('/instancias', corpo);
    const s = d && d.sessao;
    const id = typeof s === 'string' ? s : (s && s.id) || (d && d.acao && d.acao.sessao) || '';
    $('v-nova').hidden = true;
    toast('Instância criada.');
    if (id) { est.doApp = true; location.hash = '#s=' + enc(id); }
  } catch (e) {
    erroNova('Não deu para criar a instância: ' + e.message);
  } finally {
    nova.ocupado = false;
    $('nova-criar').disabled = false;
  }
}

// ───────────────────────────── 5. este aparelho ─────────────────────────────
const instalado = () => navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
const pushSuportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function urlB64(s) {
  const p = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function assinaturaAtual() {
  if (!pushSuportado()) return null;
  try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch { return null; }
}
function erroAparelho(t) { const el = $('ap-erro'); el.hidden = !t; txt(el, t || ''); }
async function renderAparelho() {
  if (!est.eu) return;
  txt($('ap-nome'), (est.eu.aparelho && est.eu.aparelho.nome) || 'Este aparelho');
  const inst = instalado();
  $('ap-instalar').hidden = inst;
  const suportado = pushSuportado();
  const perm = suportado ? Notification.permission : 'denied';
  const sub = inst && suportado ? await assinaturaAtual() : null;
  const ativa = !!sub && perm === 'granted';
  $('ap-notif-estado').dataset.on = ativa ? '1' : '0';
  txt($('ap-notif-estado-txt'), ativa ? 'Ativadas neste aparelho' : 'Desativadas');
  $('ap-ativar').hidden = !inst || !suportado || ativa || perm === 'denied';
  $('ap-testar').hidden = !ativa;
  $('ap-desativar').hidden = !ativa;
  txt($('ap-notif-txt'),
    !inst ? 'Avisos de "precisa de você" e "terminou" só chegam com o Orbit instalado na Tela de Início. Siga os passos acima.'
      : !suportado ? 'Este navegador não oferece notificações. Use o Orbit pelo ícone da Tela de Início (iOS 16.4 ou mais novo).'
        : perm === 'denied' ? 'As notificações estão bloqueadas. Libere em Ajustes do iPhone, Notificações, Orbit.'
          : ativa ? 'Você recebe um aviso quando uma instância precisa de você e quando ela termina.'
            : 'Receba um aviso quando uma instância precisar de você ou terminar.');
}
async function ativarNotificacoes() {
  erroAparelho('');
  const b = $('ap-ativar');
  b.disabled = true;
  try {
    const perm = await Notification.requestPermission(); // tem de ser chamado direto de um toque
    if (perm !== 'granted') throw new Error('A permissão de notificações não foi concedida.');
    if (!est.eu.vapidPublica) throw new Error('O PC ainda não gerou as chaves de notificação. Abra o Orbit no PC e tente de novo.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(est.eu.vapidPublica) });
    await api('/remoto/push/assinar', { assinatura: typeof sub.toJSON === 'function' ? sub.toJSON() : sub });
    toast('Notificações ativadas.');
  } catch (e) {
    erroAparelho('Não deu para ativar: ' + (e.message || e));
  } finally {
    b.disabled = false;
    renderAparelho();
  }
}
async function testarNotificacao() {
  erroAparelho('');
  const b = $('ap-testar');
  b.disabled = true;
  try { await api('/remoto/push/teste', {}); toast('Enviada. Ela deve chegar em alguns segundos.'); } catch (e) { erroAparelho('Não deu para testar: ' + e.message); } finally { b.disabled = false; }
}
async function desativarNotificacoes() {
  erroAparelho('');
  const b = $('ap-desativar');
  b.disabled = true;
  try {
    const sub = await assinaturaAtual();
    if (sub) await sub.unsubscribe();
    await api('/remoto/push/cancelar', {});
    toast('Notificações desativadas.');
  } catch (e) { erroAparelho('Não deu para desativar: ' + e.message); } finally { b.disabled = false; renderAparelho(); }
}
async function sair() {
  try {
    const sub = await assinaturaAtual();
    if (sub) await sub.unsubscribe();
  } catch {}
  try { await api('/remoto/sair', {}, { semSessao: true }); } catch (e) { if (!e.status || e.status !== 401) { toast('Não deu para sair: ' + e.message); return; } }
  history.replaceState(null, '', location.pathname);
  mostrarParear();
}

// ───────────────────────────── início ─────────────────────────────
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('service worker', e));
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev.data;
    if (d && d.tipo === 'abrir' && typeof d.url === 'string') abrirUrl(d.url);
  });
}
function falhaInicial(msg) {
  mostrarTela('');
  const c = $('carregando');
  c.hidden = false;
  c.replaceChildren(msg, h('br'), h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Tentar de novo'));
}
async function iniciar() {
  try {
    est.eu = await api('/remoto/eu', undefined, { semSessao: true });
  } catch (e) {
    if (e.status === 401) { mostrarParear(); return; }
    falhaInicial(e.message);
    return;
  }
  conectarFluxo();
  carregarEstado();
  aplicarRota();
}
function ligar() {
  for (const a of ['sessoes', 'uso', 'aparelho']) {
    const b = $('aba-' + a);
    b.querySelector('.ic').replaceWith(ico({ sessoes: 'lista', uso: 'uso', aparelho: 'aparelho' }[a], 22));
    b.addEventListener('click', () => { location.hash = '#' + a; });
  }
  $('btn-nova').append(ico('mais', 20));
  $('s-voltar').append(ico('voltar', 22));
  $('cv-foto').append(ico('mais', 22));
  $('cv-medidor').addEventListener('click', () => toast($('cv-medidor').dataset.rot || ''));
  $('cv-enviar').append(ico('enviar', 20));
  $('nova-fechar').append(ico('x', 20));
  $('par-f1').addEventListener('submit', pedirCodigo);
  $('par-f2').addEventListener('submit', confirmarCodigo);
  $('par-outro').addEventListener('click', () => { erroParear(''); passoParear(1); });
  $('par-codigo').addEventListener('input', () => {
    const v = $('par-codigo').value.replace(/\D/g, '').slice(0, 6);
    if ($('par-codigo').value !== v) $('par-codigo').value = v;
    if (v.length === 6 && !par.ocupado && Date.now() < par.expiraEm) $('par-f2').requestSubmit();
  });
  $('btn-nova').addEventListener('click', () => abrirNova(lista.chipsPastas.get(filtroProj)));
  document.addEventListener('orbit:nova', (ev) => abrirNova(ev.detail && ev.detail.pasta)); // card Projetos da Visão geral (widgets.js)
  $('nova-fechar').addEventListener('click', () => { $('v-nova').hidden = true; });
  $('nova-f').addEventListener('submit', criarInstancia);
  $('nova-modelo').addEventListener('change', preencherEsforcoNova);
  $('s-voltar').addEventListener('click', voltar);
  $('cv-mais').addEventListener('click', carregarAnteriores);
  $('cv-novas-b').addEventListener('click', rolarFim);
  $('cv-rolagem').addEventListener('scroll', () => { if (pertoDoFim()) $('cv-novas').hidden = true; }, { passive: true });
  $('cv-parar').addEventListener('click', pararVolta);
  $('cv-comp').addEventListener('submit', enviarMensagem);
  $('cv-texto').addEventListener('input', () => { ajustarAltura(); atualizarEnvio(); });
  $('cv-foto').addEventListener('click', () => $('cv-arq').click());
  $('cv-arq').addEventListener('change', () => { const f = [...$('cv-arq').files]; $('cv-arq').value = ''; adicionarFotos(f); });
  $('cv-modelo').addEventListener('change', () => trocarAjuste('modelo', $('cv-modelo').value));
  $('cv-esforco').addEventListener('change', () => trocarAjuste('esforco', $('cv-esforco').value));
  $('ap-ativar').addEventListener('click', ativarNotificacoes);
  $('ap-testar').addEventListener('click', testarNotificacao);
  $('ap-desativar').addEventListener('click', desativarNotificacoes);
  $('ap-sair').addEventListener('click', () => { $('ap-sair').hidden = true; $('ap-sair-conf').hidden = false; });
  $('ap-sair-nao').addEventListener('click', () => { $('ap-sair').hidden = false; $('ap-sair-conf').hidden = true; });
  $('ap-sair-sim').addEventListener('click', () => { $('ap-sair').hidden = false; $('ap-sair-conf').hidden = true; sair(); });
  addEventListener('hashchange', aplicarRota);
  // iPhone: o teclado encolhe só a janela visual; a tela acompanha para o campo de mensagem não ficar escondido.
  if (window.visualViewport) {
    // No iOS o innerHeight acompanha o teclado (não serve de referência) e o resize do fim da animação às vezes não chega.
    // Por isso: teclado só conta com um campo editável focado, a altura cheia vem do layout (clientHeight) e da maior
    // janela visual já vista, e tudo é reconferido em focusin/focusout e no scroll da janela visual.
    // Com teclado, #app ocupa exatamente a janela visual (top = offsetTop, height = height) e a área segura de baixo sai.
    const raiz = document.documentElement;
    const vv = window.visualViewport;
    let cheia = 0, orient = innerWidth > innerHeight;
    const editavel = () => { const a = document.activeElement; return !!a && (a.isContentEditable || (/^(TEXTAREA|SELECT)$/.test(a.tagName)) || (a.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|file|range|color|reset|image)$/.test(a.type))); };
    const ajustar = () => {
      const o = innerWidth > innerHeight;
      if (o !== orient) { orient = o; cheia = 0; }
      const base = Math.max(raiz.clientHeight, cheia);
      const tec = editavel() && base - vv.height > 100;
      if (!tec) cheia = Math.max(cheia, Math.round(vv.height));
      raiz.classList.toggle('tec', tec);
      if (tec) {
        raiz.style.setProperty('--vv-h', Math.round(vv.height) + 'px');
        raiz.style.setProperty('--vv-top', Math.max(0, Math.round(vv.offsetTop)) + 'px');
      } else {
        raiz.style.removeProperty('--vv-h');
        raiz.style.removeProperty('--vv-top');
        // O iOS rola o documento para mostrar o campo; fechado o teclado, volta ao topo (só a lista de mensagens rola).
        if (scrollY || raiz.scrollTop || document.body.scrollTop) { scrollTo(0, 0); raiz.scrollTop = 0; document.body.scrollTop = 0; }
      }
    };
    const reconferir = () => { ajustar(); for (const ms of [60, 250, 600]) setTimeout(ajustar, ms); };
    vv.addEventListener('resize', ajustar);
    vv.addEventListener('scroll', ajustar);
    addEventListener('resize', ajustar);
    addEventListener('orientationchange', reconferir);
    document.addEventListener('focusin', reconferir);
    document.addEventListener('focusout', reconferir);
    // Com o teclado aberto o documento não rola: arrastar fora de uma área rolável não move a página.
    document.addEventListener('touchmove', (e) => {
      if (!raiz.classList.contains('tec')) return;
      for (let n = e.target; n && n !== document.body; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return;
      }
      e.preventDefault();
    }, { passive: false });
    ajustar();
  }
  // Ao voltar ao app (o iOS suspende a página): confere o pareamento, religa o fluxo e atualiza a conversa.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !est.eu) return;
    agendarRender();
    if (!est.es || est.es.readyState === EventSource.CLOSED) conectarFluxo();
    carregarEstado();
    if (cv.id && !cv.es) retomarConversa(cv.id, cv.gen);
    atualizarTempos();
  });
  setInterval(() => { if (document.hidden || !est.eu) return; atualizarTempos(); if (est.aba === 'uso' && !$('v-principal').hidden) renderUso(); }, 30e3);
  registrarSW();
  iniciar();
}
ligar();
})();
