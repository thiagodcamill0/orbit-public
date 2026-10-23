// Orbit no celular: núcleo da casca (onda 2). Define window.OM: api, h, estado ao vivo (GET /estado + SSE /fluxo com
// recuo exponencial), faixas de conexão, utilitários (toast, ícone, sprites, md, formatadores), pareamento e push (a
// lógica do app antigo, mobile.js). Sem innerHTML e sem nada inline (CSP do contrato). API: contrato "App do celular".
(() => {
'use strict';

const OM = (window.OM = window.OM || {});
const doc = document;
const $ = (id) => doc.getElementById(id);

// ───────────────────────────── h: elementos sem innerHTML ─────────────────────────────
// h('button', { class: 'btn', type: 'button', onclick: fn, dados: { id: 'x' }, estilo: { width: '40%' } }, 'texto', no, [lista])
const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate']);
function anexar(e, filhos) {
  for (const f of filhos) {
    if (f == null || f === false || f === true) continue;
    if (Array.isArray(f)) anexar(e, f);
    else e.append(f instanceof Node ? f : String(f));
  }
}
function h(tag, attrs, ...filhos) {
  const e = doc.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'estilo' || k === 'style') { if (typeof v === 'object') Object.assign(e.style, v); } // atributo style= é barrado pela CSP
      else if (k === 'dados') { for (const d in v) if (v[d] != null) e.dataset[d] = String(v[d]); }
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  anexar(e, filhos);
  return e;
}
const txt = (el, v) => { const t = v == null ? '' : String(v); if (el.textContent !== t) el.textContent = t; };

// ───────────────────────────── api ─────────────────────────────
// api(metodo, rota, corpo?, { semSessao, sinal, cru }) → JSON (ou o Response com `cru`). Erro: Error com .status
// (0 = sem rede), .codigo, .dados, .rede. 401 (ou 403 nao_pareado/revogado) = aparelho revogado → modo 'parear'.
const REVOGADO = new Set(['nao_pareado', 'revogado', 'aparelho_revogado']);
async function api(metodo, rota, corpo, opc = {}) {
  metodo = String(metodo || 'GET').toUpperCase();
  const init = { method: metodo, cache: 'no-store', credentials: 'same-origin' };
  if (metodo !== 'GET') {
    init.headers = { 'content-type': 'application/json', 'x-gerenciador': '1' };
    init.body = JSON.stringify(corpo === undefined ? {} : corpo);
  }
  if (opc.sinal) init.signal = opc.sinal;
  let r;
  try {
    r = await fetch(rota, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    const e = new Error('Sem conexão com o Orbit. Confira se o PC está ligado e conectado ao Tailscale.');
    e.rede = true;
    e.status = 0;
    throw e;
  }
  if (r.ok && opc.cru) return r;
  let d = null;
  if (/json/i.test(r.headers.get('content-type') || '')) { try { d = await r.json(); } catch {} } else { try { await r.text(); } catch {} }
  if (!r.ok) {
    const codigo = (d && (d.codigo || d.erro)) || '';
    if (!opc.semSessao && (r.status === 401 || (r.status === 403 && REVOGADO.has(codigo)))) revogado();
    const e = new Error((d && typeof d.erro === 'string' && /\s/.test(d.erro) && d.erro) || 'O servidor respondeu ' + r.status + '.');
    e.status = r.status;
    e.codigo = codigo;
    e.dados = d;
    throw e;
  }
  return d == null ? {} : d;
}

// ───────────────────────────── eventos (store) ─────────────────────────────
const ouvintes = new Map();
function ouvir(evento, fn) {
  let s = ouvintes.get(evento);
  if (!s) ouvintes.set(evento, (s = new Set()));
  s.add(fn);
  return () => { s.delete(fn); };
}
function emitir(evento, dados) {
  const s = ouvintes.get(evento);
  if (!s) return;
  for (const fn of [...s]) { try { fn(dados); } catch (err) { console.warn('OM.' + evento, err); } }
}

const estado = (OM.estado = {
  modo: 'carregando',      // 'carregando' | 'app' | 'parear'
  conexao: 'conectando',   // 'conectando' | 'vivo' | 'reconectando' | 'pc' | 'offline' | 'revogado'
  motivoParear: '',        // '' | 'novo' | 'revogado' | 'saiu'
  eu: null,                // GET /remoto/eu: { aparelho:{id,nome}, opcoes:{criarInstancias}, vapidPublica }
  sessoes: new Map(),      // id → Sessao (só nativas)
  uso: null,
  resumoDia: null,
  pendentes: 0,            // permissões/perguntas esperando resposta (badge de Aprovações)
  proximaTentativa: 0,     // ms (Date.now) da próxima tentativa de reconectar
});

const pendentesDe = (s) => { const c = s && s.controle; return c && c.permissao ? Math.max(1, Number(c.pendentes) || 1) : 0; };
let rafMudou = 0;
function mudou() {
  if (rafMudou) return;
  const rodar = () => {
    rafMudou = 0;
    let n = 0;
    for (const s of estado.sessoes.values()) n += pendentesDe(s);
    if (n !== estado.pendentes) { estado.pendentes = n; emitir('pendentes', n); }
    doc.title = n ? '(' + n + ') Orbit' : 'Orbit';
    emitir('estado', estado);
  };
  // Aba oculta não roda rAF: um tempo curto garante que o estado chega mesmo assim.
  rafMudou = doc.hidden ? setTimeout(rodar, 50) : requestAnimationFrame(rodar);
}
function aplicarSessoes(lista) {
  const m = new Map();
  for (const s of Array.isArray(lista) ? lista : []) if (s && s.id != null) m.set(String(s.id), s);
  estado.sessoes = m;
}

// ───────────────────────────── modo e conexão ─────────────────────────────
// O aviso "Abrindo o Orbit…" só existe enquanto carrega: fora disso sai da árvore de acessibilidade (hidden + aria-hidden).
function pintarAbertura() {
  const el = doc.getElementById('abertura');
  if (!el) return;
  const ativo = estado.modo === 'carregando';
  el.hidden = !ativo;
  if (ativo) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
}
function definirModo(m) {
  if (estado.modo === m) return;
  estado.modo = m;
  doc.body.dataset.modo = m;
  pintarAbertura();
  emitir('modo', m);
  pintarFaixa();
}
let graca = 0;
function definirConexao(c) {
  if (estado.conexao === c) { pintarFaixa(); return; }
  estado.conexao = c;
  doc.body.dataset.conexao = c;
  emitir('conexao', c);
  mudou();
  clearTimeout(graca);
  // Queda curta (reinício, troca de rede) não pisca a faixa: "reconectando" só aparece depois de 0,8 s.
  if (c === 'reconectando') { graca = setTimeout(() => pintarFaixa(true), 800); pintarFaixa(false); } else pintarFaixa();
}

const fx = { es: null, timer: 0, tentativas: 0, sondando: false };
const EVENTOS_FLUXO = ['inicio', 'sessao', 'remover', 'uso', 'alerta', 'acao', 'resumoDia'];
function fecharFluxo() {
  if (fx.es) { try { fx.es.close(); } catch {} fx.es = null; }
}
function abrirFluxo() {
  fecharFluxo();
  let es;
  try { es = new EventSource('/fluxo'); } catch { perdeu(); return; }
  fx.es = es;
  for (const nome of EVENTOS_FLUXO) {
    es.addEventListener(nome, (ev) => {
      if (fx.es !== es) return;
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      receber(nome, d);
    });
  }
  es.onopen = () => { if (fx.es === es) conectado(); };
  es.onerror = () => { if (fx.es !== es) return; fecharFluxo(); perdeu(); };
}
function receber(nome, d) {
  if (nome === 'inicio') {
    aplicarSessoes(d && d.sessoes);
    if (d && 'uso' in d) estado.uso = d.uso || null;
    if (d && 'resumoDia' in d) estado.resumoDia = d.resumoDia || null;
    conectado();
  } else if (nome === 'sessao') { if (!d || d.id == null) return; estado.sessoes.set(String(d.id), d); }
  else if (nome === 'remover') { if (!d || d.id == null) return; estado.sessoes.delete(String(d.id)); }
  else if (nome === 'uso') estado.uso = d || null;
  else if (nome === 'resumoDia') estado.resumoDia = d || null;
  emitir(nome, d);
  if (nome !== 'alerta' && nome !== 'acao') mudou();
}
function conectado() {
  fx.tentativas = 0;
  clearTimeout(fx.timer);
  definirConexao('vivo');
}
function perdeu() {
  if (estado.modo !== 'app') return;
  definirConexao(navigator.onLine === false ? 'offline' : 'reconectando');
  sondar();
}
// Recuo exponencial com jitter: 1 s, 1–2 s, 2–4 s, 4–8 s, 7,5–15 s (nunca menos de 1 s nem mais de 15 s).
const recuo = (n) => Math.min(15000, Math.max(1000, Math.round(Math.min(15000, 1000 * 2 ** n) * (0.5 + Math.random() * 0.5))));
function agendar() {
  clearTimeout(fx.timer);
  const ms = recuo(fx.tentativas++);
  estado.proximaTentativa = Date.now() + ms;
  fx.timer = setTimeout(sondar, ms);
  pintarFaixa();
}
// Confere se o PC responde e se o aparelho continua pareado; se sim, religa o fluxo e recarrega o estado.
async function sondar() {
  clearTimeout(fx.timer);
  if (fx.sondando || estado.modo === 'parear') return;
  if (navigator.onLine === false) { definirConexao('offline'); agendar(); return; }
  fx.sondando = true;
  try {
    const eu = await api('GET', '/remoto/eu', undefined, { semSessao: true });
    estado.eu = eu;
    if (estado.modo !== 'app') definirModo('app');
    if (estado.conexao !== 'vivo') definirConexao('reconectando');
    abrirFluxo();
    carregarEstado();
  } catch (e) {
    if (e.status === 401) revogado();
    else { definirConexao(navigator.onLine === false ? 'offline' : 'pc'); agendar(); }
  } finally {
    fx.sondando = false;
  }
}
function tentarAgora() {
  fx.tentativas = 0;
  sondar();
}
function revogado(motivo = 'revogado') {
  if (estado.modo === 'parear') return;
  fecharFluxo();
  clearTimeout(fx.timer);
  estado.eu = null;
  estado.sessoes = new Map();
  estado.motivoParear = motivo;
  // Sem aparelho pareado, nada do PC fica no celular (pasta lembrada, filtro, amostras do uso, rascunhos, casca).
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  try { if (window.caches) caches.delete('orbit-casca-m-v1').catch(() => {}); } catch {}
  definirConexao('revogado');
  definirModo('parear');
  mudou();
}
async function carregarEstado() {
  try {
    const d = await api('GET', '/estado');
    if (d && Array.isArray(d.sessoes)) aplicarSessoes(d.sessoes);
    if (d && 'uso' in d) estado.uso = d.uso || null;
    if (d && 'resumoDia' in d) estado.resumoDia = d.resumoDia || null;
    mudou();
    return d;
  } catch { return null; }
}

// Faixa de conexão (topo, flutuante): sem internet, PC desconectado (com "tentar agora"), reconectando.
let relogioFaixa = 0, contarFaixa = null;
function pintarFaixa(passouGraca) {
  const el = $('faixa');
  if (!el) return;
  const c = estado.conexao;
  const mostrar = estado.modo === 'app' && (c === 'offline' || c === 'pc' || (c === 'reconectando' && (passouGraca || el.dataset.tipo === 'reconectando' || !el.hidden)));
  clearInterval(relogioFaixa); relogioFaixa = 0;
  if (!mostrar) {
    if (!el.hidden) { el.hidden = true; el.dataset.tipo = ''; }
    return;
  }
  const novo = el.hidden || el.dataset.tipo !== c;
  el.dataset.tipo = c;
  const sub = h('small', { class: 'faixa-sub' });
  const linhas = h('span', { class: 'faixa-txt' },
    h('strong', null, c === 'offline' ? 'Sem internet' : c === 'pc' ? 'PC desconectado' : 'Reconectando…'), sub);
  const ico = c === 'reconectando' ? h('span', { class: 'faixa-giro', 'aria-hidden': 'true' }) : h('span', { class: 'faixa-ico' }, icone(c === 'offline' ? 'globo' : 'alerta', 16));
  const filhos = [ico, linhas];
  if (c === 'pc') filhos.push(h('button', { class: 'btn faixa-btn', type: 'button', onclick: tentarAgora }, 'Tentar agora'));
  el.replaceChildren(...filhos);
  const contar = () => {
    if (c === 'offline') txt(sub, 'O Orbit volta sozinho quando a conexão voltar.');
    else if (c === 'pc') {
      const s = Math.max(0, Math.ceil((estado.proximaTentativa - Date.now()) / 1000));
      txt(sub, fx.sondando || !s ? 'Tentando agora…' : 'Tentando de novo em ' + s + ' s');
    } else txt(sub, 'Ligando de novo ao Orbit do PC.');
  };
  contar();
  contarFaixa = contar;
  if (c === 'pc') relogioFaixa = setInterval(() => { if (!doc.hidden) contar(); }, 1000);
  el.hidden = false;
  if (novo) { el.classList.remove('entra'); void el.offsetWidth; el.classList.add('entra'); }
}

// ───────────────────────────── utilitários ─────────────────────────────
function icone(nome, tam = 20) {
  const I = window.OrbitIcones;
  if (I && typeof I.icone === 'function') { try { return I.icone(nome, tam); } catch {} }
  return h('span', { class: 'ico-vazio', 'aria-hidden': 'true' });
}
const reduzido = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const cssVar = (nome, padrao = '') => (getComputedStyle(doc.documentElement).getPropertyValue(nome) || '').trim() || padrao;

let toastEl = null, toastTimer = 0;
function fecharToast() {
  clearTimeout(toastTimer);
  if (!toastEl || toastEl.hidden) return;
  if (reduzido()) { toastEl.hidden = true; return; }
  toastEl.classList.remove('entrando');
  toastEl.classList.add('saindo');
  toastTimer = setTimeout(() => { toastEl.hidden = true; toastEl.classList.remove('saindo'); }, 130);
}
// toast(texto, { acao: { rotulo, fn }, ms })
function toast(texto, op = {}) {
  if (!toastEl) { toastEl = h('div', { class: 'toast', id: 'toast', role: 'status', 'aria-live': 'polite', hidden: true }); doc.body.append(toastEl); }
  clearTimeout(toastTimer);
  const filhos = [h('span', null, texto)];
  if (op.acao && typeof op.acao.fn === 'function') filhos.push(h('button', { class: 'btn', type: 'button', onclick: () => { fecharToast(); op.acao.fn(); } }, op.acao.rotulo || 'Ok'));
  toastEl.replaceChildren(...filhos);
  toastEl.classList.remove('saindo', 'entrando');
  toastEl.hidden = false;
  void toastEl.offsetWidth;
  toastEl.classList.add('entrando');
  toastTimer = setTimeout(fecharToast, op.ms || (op.acao ? 6000 : 3800));
}

// Formatadores (os mesmos do app antigo).
const limpo = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
function emMs(t) {
  if (typeof t === 'string') { const d = Date.parse(t); return Number.isFinite(d) ? d : 0; }
  const n = Number(t) || 0;
  return n && n < 1e12 ? n * 1000 : n;
}
function tempo(t) {
  const d = Math.max(0, Date.now() - emMs(t));
  if (d < 60e3) return 'agora';
  const m = Math.floor(d / 60e3);
  if (m < 60) return m + ' min';
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + ' h';
  return Math.floor(hr / 24) + ' d';
}
function duracao(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60e3);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return m + ' min';
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  return Math.floor(hr / 24) + ' d' + (hr % 24 ? ' ' + (hr % 24) + ' h' : '');
}
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function hora(t) { try { return new Date(emMs(t)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function quando(t, agora = Date.now()) {
  const ms = emMs(t);
  const d = new Date(ms);
  if (d.toDateString() === new Date(agora).toDateString()) return 'às ' + hora(ms);
  if (Math.abs(ms - agora) < 6 * 86400e3) return DIAS[d.getDay()] + ' ' + hora(ms);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
const projeto = (s) => limpo(s && s.projeto) || basename(s && s.cwd) || 'Sem projeto';
const titulo = (s) => limpo(s && s.apelido) || limpo(s && s.titulo) || limpo(s && s.primeira) || 'Sessão nova';

// ───────────────────────────── pareamento (lógica do app antigo) ─────────────────────────────
const ERROS_PAREAR = {
  codigo_errado: 'Código errado. Confira os 6 dígitos que aparecem no PC.',
  expirado: 'O código expirou (vale 2 minutos). Peça outro.',
  bloqueado: 'Muitas tentativas erradas. O pareamento fica bloqueado por 10 minutos.',
  pedido_pendente: 'Já existe um pedido de pareamento aberto. Espere ele expirar ou recuse-o no Orbit do PC.',
  desativado: 'O acesso pelo celular está desligado no Orbit do PC.',
};
function textoErroParear(e, confirmando) {
  const c = String((e && e.codigo) || '');
  if (ERROS_PAREAR[c]) return ERROS_PAREAR[c];
  if (e && e.rede) return e.message;
  if (e.status === 409) return ERROS_PAREAR.pedido_pendente;
  if (e.status === 410) return ERROS_PAREAR.expirado;
  if (e.status === 423 || e.status === 429) return ERROS_PAREAR.bloqueado;
  if (/\s/.test(c)) return c;
  if (confirmando && (e.status === 400 || e.status === 401 || e.status === 403)) return ERROS_PAREAR.codigo_errado;
  return 'Não deu para parear (o servidor respondeu ' + (e.status || 'sem resposta') + ').';
}
const parear = {
  ERROS: ERROS_PAREAR,
  textoErro: textoErroParear,
  // → { pedido, expiraEm (ms) }
  async pedir(nome) {
    const n = limpo(nome).slice(0, 40) || 'iPhone';
    const d = await api('POST', '/remoto/parear/pedir', { nome: n }, { semSessao: true });
    return { pedido: d.pedido, expiraEm: emMs(d.expiraEm) || Date.now() + 120e3 };
  },
  // Código certo: guarda o cookie (o servidor manda) e entra no app. Erro: lança (use textoErro(e, true)).
  async confirmar(pedido, codigo) {
    await api('POST', '/remoto/parear/confirmar', { pedido, codigo: String(codigo || '').replace(/\D/g, '') }, { semSessao: true });
    estado.motivoParear = '';
    await iniciar();
    return true;
  },
  // Erro que pede voltar ao passo do nome (expirou ou bloqueou).
  recomecar: (e) => { const c = String((e && e.codigo) || ''); return c === 'expirado' || c === 'bloqueado' || [410, 423, 429].includes(e && e.status); },
};

// ───────────────────────────── push e este aparelho (lógica do app antigo) ─────────────────────────────
const instalado = () => navigator.standalone === true || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
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
const push = {
  suportado: pushSuportado,
  instalado,
  assinaturaAtual,
  // { instalado, suportado, permissao, ativa }
  async situacao() {
    const inst = instalado();
    const sup = pushSuportado();
    const permissao = sup ? Notification.permission : 'denied';
    const sub = inst && sup ? await assinaturaAtual() : null;
    return { instalado: inst, suportado: sup, permissao, ativa: !!sub && permissao === 'granted' };
  },
  // Tem de ser chamado direto de um toque (o iOS exige). Lança Error com a mensagem para o usuário.
  async ativar() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('A permissão de notificações não foi concedida.');
    if (!estado.eu || !estado.eu.vapidPublica) throw new Error('O PC ainda não gerou as chaves de notificação. Abra o Orbit no PC e tente de novo.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(estado.eu.vapidPublica) });
    await api('POST', '/remoto/push/assinar', { assinatura: typeof sub.toJSON === 'function' ? sub.toJSON() : sub });
    return true;
  },
  testar: () => api('POST', '/remoto/push/teste', {}),
  async desativar() {
    const sub = await assinaturaAtual();
    if (sub) await sub.unsubscribe();
    await api('POST', '/remoto/push/cancelar', {});
    return true;
  },
};
// Sair deste aparelho: cancela o push, avisa o PC e volta ao pareamento.
async function sair() {
  try { const sub = await assinaturaAtual(); if (sub) await sub.unsubscribe(); } catch {}
  try { await api('POST', '/remoto/sair', {}, { semSessao: true }); } catch (e) { if (e.status !== 401) throw e; }
  history.replaceState(null, '', location.pathname);
  revogado('saiu');
}

// ───────────────────────────── início ─────────────────────────────
async function iniciar() {
  let eu;
  try {
    eu = await api('GET', '/remoto/eu', undefined, { semSessao: true });
  } catch (e) {
    if (e.status === 401) { estado.motivoParear = estado.motivoParear || 'novo'; definirConexao('revogado'); definirModo('parear'); return; }
    // PC fora do ar: abre a casca com a faixa e segue tentando com recuo.
    definirModo('app');
    definirConexao(navigator.onLine === false ? 'offline' : 'pc');
    agendar();
    return;
  }
  estado.eu = eu;
  estado.motivoParear = '';
  fx.tentativas = 0;
  if (estado.conexao !== 'vivo') definirConexao('conectando');
  definirModo('app');
  abrirFluxo();
  carregarEstado();
}

function abrirUrl(url) {
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin || !/^\/m\/?$/.test(u.pathname)) return;
    const hash = u.hash && u.hash !== '#' ? u.hash : '#inicio';
    if (OM.rotas && OM.rotas.ir) OM.rotas.ir(hash); else location.hash = hash;
  } catch {}
}
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('service worker', e));
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev.data;
    if (d && d.tipo === 'abrir' && typeof d.url === 'string') abrirUrl(d.url);
  });
}

// iPhone: o teclado encolhe só a janela visual; o #app acompanha (html.tec + --vv-h/--vv-top), como no app antigo.
function ligarTeclado() {
  const vv = window.visualViewport;
  if (!vv) return;
  const raiz = doc.documentElement;
  let cheia = 0, orient = innerWidth > innerHeight;
  const editavel = () => { const a = doc.activeElement; return !!a && (a.isContentEditable || /^(TEXTAREA|SELECT)$/.test(a.tagName) || (a.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|file|range|color|reset|image)$/.test(a.type))); };
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
      if (scrollY || raiz.scrollTop || doc.body.scrollTop) { scrollTo(0, 0); raiz.scrollTop = 0; doc.body.scrollTop = 0; }
    }
  };
  const reconferir = () => { ajustar(); for (const ms of [60, 250, 600]) setTimeout(ajustar, ms); };
  vv.addEventListener('resize', ajustar);
  vv.addEventListener('scroll', ajustar);
  addEventListener('resize', ajustar);
  addEventListener('orientationchange', reconferir);
  doc.addEventListener('focusin', reconferir);
  doc.addEventListener('focusout', reconferir);
  ajustar();
}

function ligar() {
  doc.body.dataset.modo = estado.modo;
  pintarAbertura();
  doc.body.classList.toggle('oculta', doc.hidden);
  doc.addEventListener('visibilitychange', () => {
    doc.body.classList.toggle('oculta', doc.hidden);
    emitir('visivel', !doc.hidden);
    if (doc.hidden || estado.modo !== 'app') return;
    if (contarFaixa && relogioFaixa) contarFaixa();
    // O iOS suspende a página: ao voltar, religa o fluxo (se caiu) e recarrega o estado.
    if (estado.conexao !== 'vivo' || !fx.es || fx.es.readyState === EventSource.CLOSED) tentarAgora();
    else { carregarEstado(); mudou(); }
  });
  addEventListener('online', () => { if (estado.modo === 'app' && estado.conexao !== 'vivo') tentarAgora(); });
  addEventListener('offline', () => { if (estado.modo === 'app') definirConexao('offline'); });
  ligarTeclado();
  registrarSW();
  iniciar();
}

Object.assign(OM, {
  h, txt, api, ouvir, emitir, iniciar, recarregar: carregarEstado, tentarAgora, sair, parear, push,
  sessoes: () => [...estado.sessoes.values()],
  sessao: (id) => estado.sessoes.get(String(id)) || null,
  pendentesDe,
  icone, toast, fecharToast, reduzido, cssVar,
  sprites: window.OrbitSprites ? window.OrbitSprites.criar({ base: '/assets/' }) : null,
  md: (texto) => (window.OrbitMd ? window.OrbitMd.render(texto) : doc.createTextNode(String(texto == null ? '' : texto))),
  base: window.OrbitBase || null,
  cartoes: window.OrbitCartoes || null,
  fmt: { emMs, tempo, duracao, hora, quando, projeto, titulo, basename, limpo },
  _revogado: revogado,
});

if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ligar, { once: true }); else setTimeout(ligar, 0);
})();
