// Orbit no celular — tela sessoes (onda 3). Lista agrupada como no PC, busca, filtro por projeto, deslizar (revisada,
// fixar, silenciar), reordenação ao vivo com FLIP e puxar para atualizar. API no contrato, "App do celular".
// Nada de innerHTML com dado do servidor (OM.h); CSP sem inline (só CSSOM: transform/transition na reordenação).
(function () {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h, fmt } = OM;
const B = OM.base || window.OrbitBase || {};
const doc = document;

// Mesma ordem e regras do PC (index.html: GRUPOS_LISTA). Interrompida fica com as concluídas; "erro" com quem precisa de você.
const GRUPOS = [
  { k: 'precisa', t: 'Precisa de você' },
  { k: 'trabalhando', t: 'Trabalhando' },
  { k: 'novas', t: 'Novas' },
  { k: 'concluidas', t: 'Concluídas' },
  { k: 'revisadas', t: 'Revisadas' },
  { k: 'encerradas', t: 'Encerradas' },
];
const ROTULO = B.ROTULO_STATUS || {};
const REVISAVEL = new Set(['concluida', 'interrompida']);
const FILTRO_LS = 'orbit.m.sessoes.projeto';
const FLIP_MS = 200;

// ───────────────────────────── regras de uma sessão ─────────────────────────────
const limpo = fmt.limpo;
const statusDe = (s) => (s && s.status in ROTULO ? s.status : 'nova');
const revisavel = (s) => REVISAVEL.has(statusDe(s));
const revisada = (s) => revisavel(s) && !!s.revisadaEm;
function grupoDe(s) {
  const st = statusDe(s);
  if (st === 'aguardando' || st === 'erro') return 'precisa';
  if (st === 'trabalhando') return 'trabalhando';
  if (st === 'nova') return 'novas';
  if (st === 'encerrada') return 'encerradas';
  return revisada(s) ? 'revisadas' : 'concluidas';
}
const desdeDe = (s) => Number(s.desde) || Number(s.atividade) || Number(s.inicio) || 0;
const nomeProj = (s) => fmt.projeto(s);
const normPasta = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const chaveProj = (s) => normPasta(s.cwd) || 'n:' + nomeProj(s).toLowerCase();
const norm = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const agentesDe = (s) => (Array.isArray(s.agentes) ? s.agentes.filter(Boolean) : []);
const agentesAtivos = (s) => Math.max(agentesDe(s).filter((a) => a.status === 'trabalhando').length, Number(s.subagentes) || 0);
const tarefasBg = (s) => (s.controle && Array.isArray(s.controle.tarefas) ? s.controle.tarefas.length : 0);

function casaBusca(s, termos) {
  if (!termos.length) return true;
  const alvo = norm([s.apelido, s.titulo, s.projeto, nomeProj(s), s.tarefa, s.primeira, agentesDe(s).map((a) => (a.tipo || '') + ' ' + (a.descricao || '')).join(' ')].join(' '));
  return termos.every((t) => alvo.includes(t));
}

function detalheDe(s) {
  const st = statusDe(s);
  const p = s.controle && s.controle.permissao;
  const tarefa = limpo(s.tarefa) || limpo(s.primeira);
  if (st === 'aguardando') {
    if (p) {
      const t = p.tipo === 'pergunta' || p.ferramenta === 'AskUserQuestion' ? 'pergunta' : p.tipo === 'plano' || p.ferramenta === 'ExitPlanMode' ? 'plano' : 'ferramenta';
      return t === 'pergunta' ? 'Fez uma pergunta' : t === 'plano' ? 'Plano para aprovar' : 'Pede permissão' + (p.ferramenta ? ': ' + p.ferramenta : '');
    }
    return limpo(s.detalhe) || 'Esperando você';
  }
  if (st === 'erro') return limpo(s.detalhe) || 'Terminou com erro';
  if (st === 'trabalhando') {
    const f = s.ferramenta;
    if (f && f.nome) return limpo(f.nome + ' ' + (f.alvo || ''));
    return limpo(s.detalhe) || tarefa || 'Trabalhando…';
  }
  if (st === 'nova') return tarefa || 'Aberta, ainda sem pedidos';
  if (st === 'encerrada') return limpo(s.detalhe) || tarefa || 'Processo encerrado';
  return tarefa || (st === 'interrompida' ? 'Interrompida' : 'Terminou a volta');
}

// Sprite pelo estado, a mesma regra do PC (OrbitBase.estadoSprite). Os "-parado" são PNG; os outros, GIF.
const hashTxt = (t) => { let x = 0; for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) | 0; return Math.abs(x); };
function spriteDe(s) {
  const st = statusDe(s);
  const subTrab = agentesDe(s).some((a) => a.status === 'trabalhando');
  const estado = B.estadoSprite ? B.estadoSprite(st, { ferramenta: s.ferramenta, subTrabalhando: subTrab, revisada: st === 'concluida' && !subTrab && revisada(s) }) : 'dormindo';
  const lista = (B.SPRITE && (B.SPRITE[estado] || B.SPRITE.dormindo)) || ['sprites/sprite-sleep'];
  const nome = lista[lista.length === 1 ? 0 : hashTxt(String(s.id) + '|' + desdeDe(s) + '|' + estado) % lista.length];
  return /-parado$/.test(nome) ? '/assets/' + nome + '.png' : nome;
}
function pintarSprite(r, nome) {
  if (r.sprite === nome) return;
  const primeira = !r.sprite;
  r.sprite = nome;
  if (!OM.sprites) { r.img.src = nome.startsWith('/') ? nome : '/assets/' + nome + '.gif'; return; }
  if (primeira) OM.sprites.definir(r.img, nome); else OM.sprites.trocarSprite(r.img, nome);
}

// ───────────────────────────── estado da tela (vive enquanto a raiz fica montada) ─────────────────────────────
const E = {
  ctx: null, cont: null, montada: false, ativa: false,
  busca: '', projeto: 'todos', fechados: new Set(['encerradas']),
  topo: null, input: null, limpar: null, chips: null, chipsSig: '', grupos: new Map(), msg: null, nova: null,
  linhas: new Map(), offPuxar: null, offSprites: null, relogio: 0, quadro: 0, semAnim: false, ultimaMsg: '',
};
try { E.projeto = localStorage.getItem(FILTRO_LS) || 'todos'; } catch {}

// ───────────────────────────── linha ─────────────────────────────
function criarLinha(id) {
  const img = h('img', { class: 'spr', alt: '', width: 46, height: 46, decoding: 'async' });
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  const selo = h('span', { class: 'av-selo', 'aria-hidden': 'true' });
  const av = h('span', { class: 'av-robo', 'aria-hidden': 'true' }, img, selo);
  const tit = h('span', { class: 'sx-tit' });
  const tempo = h('span', { class: 'sx-tempo' });
  const marcas = h('span', { class: 'sx-marcas' });
  const proj = h('span', { class: 'sx-proj' });
  const det = h('p', { class: 'sx-det' });
  const tags = h('div', { class: 'sx-tags' });
  const item = h('a', { class: 'sx-item toque', href: '#s=' + encodeURIComponent(id) },
    av, h('div', { class: 'sx-txt' },
      h('div', { class: 'sx-l1' }, tit, tempo),
      h('div', { class: 'sx-l2' }, proj, marcas),
      det, tags));
  const li = h('li', { class: 'sx-linha', dados: { id } }, item);
  const r = { id, li, item, av, img, selo, tit, tempo, marcas, proj, det, tags, sprite: '', sig: '', sigTags: '', rev: null, desl: null, ref: 0, fimT: 0 };
  return r;
}

function textoDe(el, v) { if (el.textContent !== v) el.textContent = v; }

function ligarDeslizar(r, s) {
  if (r.desl) r.desl.off();
  const rev = revisavel(s);
  r.rev = rev;
  const esquerda = rev ? [{ rotulo: revisada(s) ? 'Desfazer' : 'Revisada', icone: revisada(s) ? 'voltar' : 'check', tipo: 'sucesso', acao: () => alternarRevisada(r.id) }] : [];
  const direita = [
    { rotulo: s.fixada ? 'Desafixar' : 'Fixar', icone: 'alfinete', tipo: 'acento', acao: () => alternarCampo(r.id, 'fixada') },
    { rotulo: s.silenciada ? 'Som' : 'Silenciar', icone: s.silenciada ? 'sino' : 'sino-mudo', tipo: 'neutro', acao: () => alternarCampo(r.id, 'silenciada') },
  ];
  r.desl = OM.gestos.deslizar(r.item, { esquerda, direita });
  r.rotulosSig = '';
}
// Rótulos das ações mudam com o estado (Revisada ↔ Desfazer etc.) sem refazer o gesto.
function rotularAcoes(r, s) {
  const sig = [revisada(s), !!s.fixada, !!s.silenciada].join();
  if (r.rotulosSig === sig || !r.desl) return;
  r.rotulosSig = sig;
  const trocar = (btn, rotulo, icone) => {
    if (!btn) return;
    const rot = btn.querySelector('.desl-rot');
    if (rot) textoDe(rot, rotulo);
    const velho = btn.querySelector('svg');
    if (velho && velho.dataset.i !== icone) velho.replaceWith(OM.icone(icone, 20));
  };
  const bEsq = r.desl.el.querySelectorAll('.desl-acoes.desl-esq .desl-acao');
  const bDir = r.desl.el.querySelectorAll('.desl-acoes.desl-dir .desl-acao');
  if (bEsq[0]) trocar(bEsq[0], revisada(s) ? 'Desfazer' : 'Revisada', revisada(s) ? 'voltar' : 'check');
  trocar(bDir[0], s.fixada ? 'Desafixar' : 'Fixar', 'alfinete');
  trocar(bDir[1], s.silenciada ? 'Som' : 'Silenciar', s.silenciada ? 'sino' : 'sino-mudo');
}

function preencher(r, s) {
  const st = statusDe(s);
  const g = grupoDe(s);
  const rv = revisada(s);
  r.ref = desdeDe(s);
  textoDe(r.tit, fmt.titulo(s));
  textoDe(r.proj, nomeProj(s));
  textoDe(r.det, detalheDe(s));
  textoDe(r.tempo, r.ref ? fmt.tempo(r.ref) : '');
  r.tempo.dataset.ref = String(r.ref);
  if (r.av.dataset.s !== (rv ? 'revisada' : st)) r.av.dataset.s = rv ? 'revisada' : st;
  if (r.item.dataset.g !== g) r.item.dataset.g = g;
  // selo do avatar: "!" (aguardando/erro) e check (concluída), como no PC
  const selo = st === 'aguardando' || st === 'erro' ? '!' : st === 'concluida' ? 'ok' : '';
  if (r.selo.dataset.v !== selo) {
    r.selo.dataset.v = selo;
    r.selo.replaceChildren(...(selo === 'ok' ? [OM.icone('check', 9)] : selo ? [doc.createTextNode(selo)] : []));
  }
  pintarSprite(r, spriteDe(s));
  // marcas (fixada/silenciada) na linha do projeto
  const sigM = (s.fixada ? 'f' : '') + (s.silenciada ? 's' : '');
  if (r.marcas.dataset.v !== sigM) {
    r.marcas.dataset.v = sigM;
    r.marcas.replaceChildren(...(s.fixada ? [h('span', { class: 'sx-marca', title: 'Fixada' }, OM.icone('alfinete', 13))] : []),
      ...(s.silenciada ? [h('span', { class: 'sx-marca', title: 'Silenciada' }, OM.icone('sino-mudo', 13))] : []));
  }
  // tags: status, pendentes, agentes, tarefas em segundo plano
  const pend = OM.pendentesDe ? OM.pendentesDe(s) : 0;
  const ag = agentesAtivos(s);
  const tb = tarefasBg(s);
  const sigT = [st, rv, pend, ag, tb].join();
  if (r.sigTags !== sigT) {
    r.sigTags = sigT;
    const filhos = [];
    filhos.push(B.pilula ? B.pilula(st, rv ? 'Revisada' : undefined, true) : h('span', { class: 'pilula p' }, ROTULO[st] || st));
    if (pend > 0) filhos.push(h('span', { class: 'selo medio sx-pend' }, pend === 1 ? '1 pendente' : pend + ' pendentes'));
    if (ag > 0) filhos.push(h('span', { class: 'chip sans sx-chip' }, OM.icone('robo', 12), ag === 1 ? '1 agente' : ag + ' agentes'));
    if (tb > 0) filhos.push(h('span', { class: 'chip sans sx-chip' }, OM.icone('terminal', 12), tb === 1 ? '1 em 2º plano' : tb + ' em 2º plano'));
    r.tags.replaceChildren(...filhos);
  }
  if (r.rev !== revisavel(s) || !r.desl) ligarDeslizar(r, s);
  rotularAcoes(r, s);
}

// ───────────────────────────── ações (otimistas, com reversão) ─────────────────────────────
function rota(id, sufixo) { return '/sessao/' + encodeURIComponent(id) + (sufixo || ''); }
function falhou(texto) { OM.toast(texto); }

function alternarRevisada(id, comToast = true) {
  const s = OM.sessao(id);
  if (!s || !revisavel(s)) return;
  const revisar = !revisada(s);
  const antes = s.revisadaEm;
  if (revisar) s.revisadaEm = Math.max(Date.now(), Number(s.desde) || 0); else delete s.revisadaEm;
  render();
  OM.api('POST', rota(id, '/revisada'), { revisada: revisar }).catch(() => {
    const atual = OM.sessao(id);
    if (atual && !!atual.revisadaEm === revisar) { if (antes) atual.revisadaEm = antes; else delete atual.revisadaEm; }
    render();
    falhou('Não deu para ' + (revisar ? 'marcar como revisada' : 'desfazer a revisão') + '.');
  });
  if (comToast) OM.toast(revisar ? 'Marcada como revisada' : 'Voltou para Concluídas', { acao: { rotulo: 'Desfazer', fn: () => alternarRevisada(id, false) } });
}

function alternarCampo(id, campo, comToast = true) {
  const s = OM.sessao(id);
  if (!s) return;
  const novo = !s[campo];
  const antes = s[campo];
  s[campo] = novo;
  render();
  OM.api('POST', rota(id), { [campo]: novo }).catch(() => {
    const atual = OM.sessao(id);
    if (atual && !!atual[campo] === novo) atual[campo] = antes;
    render();
    falhou('Não deu para ' + (campo === 'fixada' ? (novo ? 'fixar' : 'desafixar') : (novo ? 'silenciar' : 'reativar o som')) + ' a sessão.');
  });
  if (comToast) {
    const texto = campo === 'fixada' ? (novo ? 'Sessão fixada no topo' : 'Sessão desafixada') : (novo ? 'Sessão silenciada' : 'Som da sessão reativado');
    OM.toast(texto, { acao: { rotulo: 'Desfazer', fn: () => alternarCampo(id, campo, false) } });
  }
}

// ───────────────────────────── modelo ─────────────────────────────
function projetosDe(todas) {
  const mapa = new Map();
  for (const s of todas) {
    const k = chaveProj(s);
    const m = mapa.get(k) || { k, nome: nomeProj(s), n: 0 };
    m.n++;
    mapa.set(k, m);
  }
  return [...mapa.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
function modelo() {
  const todas = OM.sessoes();
  const projs = projetosDe(todas);
  if (E.projeto !== 'todos' && todas.length && !projs.some((p) => p.k === E.projeto)) escolherProjeto('todos', true); // o projeto sumiu
  const termos = norm(E.busca).split(/\s+/).filter(Boolean);
  const por = Object.fromEntries(GRUPOS.map((g) => [g.k, []]));
  let total = 0;
  for (const s of todas) {
    if (E.projeto !== 'todos' && chaveProj(s) !== E.projeto) continue;
    if (!casaBusca(s, termos)) continue;
    por[grupoDe(s)].push(s);
    total++;
  }
  for (const g of GRUPOS) {
    const asc = g.k === 'precisa' || g.k === 'trabalhando';
    por[g.k].sort((a, b) => (!!b.fixada - !!a.fixada) || (asc ? desdeDe(a) - desdeDe(b) : desdeDe(b) - desdeDe(a)) || String(a.id).localeCompare(String(b.id)));
  }
  return { todas, projs, por, total, termos };
}

// ───────────────────────────── montagem ─────────────────────────────
function montarTopo() {
  E.input = h('input', { class: 'sx-campo', type: 'search', placeholder: 'Buscar sessões', 'aria-label': 'Buscar sessões', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'search', value: E.busca });
  E.limpar = h('button', { class: 'btn-icone sx-limpar', type: 'button', 'aria-label': 'Limpar busca', hidden: true }, OM.icone('x', 16));
  const busca = h('div', { class: 'sx-busca' }, h('span', { class: 'sx-lupa', 'aria-hidden': 'true' }, OM.icone('busca', 18)), E.input, E.limpar);
  E.input.addEventListener('input', () => { E.busca = E.input.value; E.semAnim = true; agendar(); });
  E.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') E.input.blur(); });
  E.limpar.addEventListener('click', () => { E.busca = ''; E.input.value = ''; E.semAnim = true; render(); E.input.focus(); });
  E.chips = h('div', { class: 'sx-chips', role: 'group', 'aria-label': 'Filtrar por projeto', hidden: true });
  E.topo = h('div', { class: 'sx-topo', hidden: true }, busca, E.chips);
}
function montarGrupos() {
  const raiz = h('div', { class: 'sx-grupos' });
  for (const g of GRUPOS) {
    const n = h('span', { class: 'sx-n' }, '0');
    const chev = h('span', { class: 'sx-chev', 'aria-hidden': 'true' }, OM.icone('chevron-baixo', 16));
    const cab = h('button', { class: 'sx-gcab', type: 'button', 'aria-expanded': 'true' }, chev, h('span', { class: 'sx-gtit' }, g.t), n);
    const ul = h('ul', { class: 'sx-lista', 'aria-label': g.t });
    const sec = h('section', { class: 'sx-grupo', dados: { g: g.k }, hidden: true }, h('h2', { class: 'sx-gh' }, cab), ul);
    cab.addEventListener('click', () => {
      if (E.fechados.has(g.k)) E.fechados.delete(g.k); else E.fechados.add(g.k);
      E.semAnim = true;
      render();
    });
    E.grupos.set(g.k, { sec, cab, n, ul });
    raiz.append(sec);
  }
  return raiz;
}

function escolherProjeto(k, silencioso) {
  E.projeto = k;
  try { if (k === 'todos') localStorage.removeItem(FILTRO_LS); else localStorage.setItem(FILTRO_LS, k); } catch {}
  if (!silencioso) { E.semAnim = true; render(); }
}
function desenharChips(projs, total) {
  const itens = [{ k: 'todos', nome: 'Todos', n: total }, ...projs];
  const sig = JSON.stringify([E.projeto, itens.map((i) => [i.k, i.nome, i.n])]);
  E.chips.hidden = projs.length < 2 && E.projeto === 'todos';
  if (sig === E.chipsSig) return;
  E.chipsSig = sig;
  E.chips.replaceChildren(...itens.map((i) => {
    const b = h('button', { type: 'button', class: 'chip sans sx-fp', 'aria-pressed': String(i.k === E.projeto), dados: { k: i.k } },
      h('span', { class: 'sx-fp-nome' }, i.nome), h('span', { class: 'sx-fp-n' }, String(i.n)));
    b.addEventListener('click', () => escolherProjeto(i.k));
    return b;
  }));
}

// Esqueleto / vazio / erro.
function mostrarMsg(tipo, extra) {
  const sig = tipo + '|' + (extra || '');
  if (E.ultimaMsg === sig) return;
  E.ultimaMsg = sig;
  if (!tipo) { E.msg.hidden = true; E.msg.replaceChildren(); return; }
  E.msg.hidden = false;
  if (tipo === 'esqueleto') {
    E.msg.replaceChildren(...[0, 1, 2].map((i) => h('div', { class: 'sx-esq-linha', 'aria-hidden': 'true' },
      h('span', { class: 'esq sx-esq-av' }), h('span', { class: 'sx-esq-txt' }, h('span', { class: 'esq sx-esq-a' }), h('span', { class: 'esq sx-esq-b' })))));
    E.msg.setAttribute('aria-busy', 'true');
    return;
  }
  E.msg.removeAttribute('aria-busy');
  if (tipo === 'vazio') {
    E.msg.replaceChildren(h('div', { class: 'sx-vazio' }, OM.icone('balao', 32), h('p', { class: 'sx-vazio-t' }, extra === 'busca' ? 'Nada encontrado para a busca' : 'Nenhuma sessão'),
      ...(extra === 'busca' ? [h('button', { class: 'btn', type: 'button', onclick: limparFiltros }, 'Limpar busca e filtro')] : [h('p', { class: 'sx-vazio-s' }, 'As sessões abertas no Orbit aparecem aqui.')])));
    return;
  }
  E.msg.replaceChildren(h('div', { class: 'sx-vazio', role: 'alert' }, OM.icone('alerta', 32), h('p', { class: 'sx-vazio-t' }, 'Não deu para carregar as sessões'),
    h('p', { class: 'sx-vazio-s' }, 'Sem conexão com o Orbit do PC.'),
    h('button', { class: 'btn', type: 'button', onclick: () => OM.tentarAgora() }, 'Tentar de novo')));
}
function limparFiltros() {
  E.busca = '';
  if (E.input) E.input.value = '';
  escolherProjeto('todos', true);
  E.semAnim = true;
  render();
}

// ───────────────────────────── desenho + FLIP ─────────────────────────────
const visivel = (el) => el.isConnected && el.offsetParent !== null;
function medirAntes() {
  const m = new Map(), lim = innerHeight + 200;   // só o que está perto da tela (as outras nem animam)
  for (const [id, r] of E.linhas) if (visivel(r.li)) { const b = r.li.getBoundingClientRect(); if (b.bottom > -200 && b.top < lim) m.set(id, b); }
  return m;
}
function animarFlip(antes) {
  if (!antes || !antes.size || OM.reduzido()) return;
  const mover = [];
  for (const [id, b0] of antes) {
    const r = E.linhas.get(id);
    if (!r || !visivel(r.li)) continue;
    const b1 = r.li.getBoundingClientRect();
    const dx = b0.left - b1.left, dy = b0.top - b1.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    mover.push([r, dx, dy]);
  }
  if (!mover.length) return;
  for (const [r, dx, dy] of mover) {
    r.li.style.transition = 'none';
    r.li.style.transform = 'translate(' + Math.round(dx) + 'px, ' + Math.round(dy) + 'px)';
  }
  void doc.body.offsetWidth;
  for (const [r] of mover) {
    r.li.style.transition = 'transform ' + FLIP_MS + 'ms var(--ease-press)';
    r.li.style.transform = '';
    clearTimeout(r.fimT);
    r.fimT = setTimeout(() => { r.li.style.transition = ''; }, FLIP_MS + 80);
  }
}
function pararFlip() {
  for (const r of E.linhas.values()) {
    if (r.li.style.transform || r.li.style.transition) { clearTimeout(r.fimT); r.li.style.transition = 'none'; r.li.style.transform = ''; }
  }
}

function render() {
  if (!E.montada) return;
  cancelAnimationFrame(E.quadro);
  E.quadro = 0;
  const animar = !E.semAnim && E.ativa;
  E.semAnim = false;
  const antes = animar ? medirAntes() : null;
  pararFlip();

  const est = OM.estado || {};
  const { todas, projs, por, total, termos } = modelo();
  const filtrando = termos.length > 0 || E.projeto !== 'todos';

  // topo (busca e chips) só com sessões; botão "+" só com a opção ligada
  E.topo.hidden = todas.length === 0;
  E.limpar.hidden = !E.busca;
  if (E.input.value !== E.busca) E.input.value = E.busca;
  desenharChips(projs, todas.length);
  const podeCriar = !!(est.eu && est.eu.opcoes && est.eu.opcoes.criarInstancias);
  if (E.nova.hidden === podeCriar) E.nova.hidden = !podeCriar;

  // linhas: cria/atualiza as que existem, tira as que sumiram
  const vivas = new Set(todas.map((s) => String(s.id)));
  for (const [id, r] of E.linhas) if (!vivas.has(id)) { if (r.desl) r.desl.off(); r.li.remove(); clearTimeout(r.fimT); E.linhas.delete(id); }
  for (const g of GRUPOS) {
    const o = E.grupos.get(g.k);
    const itens = por[g.k];
    const fechado = E.fechados.has(g.k) && termos.length === 0; // buscando, tudo aparece
    o.sec.hidden = !itens.length;
    o.sec.dataset.fechado = fechado ? '1' : '';
    o.ul.hidden = fechado;
    o.cab.setAttribute('aria-expanded', String(!fechado));
    textoDe(o.n, String(itens.length));
    o.cab.setAttribute('aria-label', g.t + ', ' + itens.length + (itens.length === 1 ? ' sessão' : ' sessões') + (fechado ? ', recolhido' : ''));
    const els = itens.map((s) => {
      const id = String(s.id);
      let r = E.linhas.get(id);
      if (!r) { r = criarLinha(id); E.linhas.set(id, r); o.ul.append(r.li); }
      preencher(r, s);
      return r.li;
    });
    // ordem com o mínimo de movimentos (não solta quem está sendo arrastado sem precisar)
    for (let i = 0; i < els.length; i++) if (o.ul.children[i] !== els[i]) o.ul.insertBefore(els[i], o.ul.children[i] || null);
    while (o.ul.children.length > els.length) o.ul.lastElementChild.remove();
  }

  // estados
  const conn = est.conexao;
  if (!todas.length) {
    if (!conn || conn === 'conectando') mostrarMsg('esqueleto');
    else if (conn === 'vivo') mostrarMsg('vazio');
    else mostrarMsg('erro');
  } else if (!total) mostrarMsg('vazio', filtrando ? 'busca' : '');
  else mostrarMsg('');

  animarFlip(antes);
}
function agendar() {
  if (E.quadro) return;
  E.quadro = requestAnimationFrame(() => { E.quadro = 0; render(); });
}

function atualizarTempos() {
  for (const r of E.linhas.values()) { const ref = Number(r.tempo.dataset.ref) || 0; if (ref) textoDe(r.tempo, fmt.tempo(ref)); }
}

// ───────────────────────────── registro ─────────────────────────────
OM.telas.registrar('sessoes', {
  titulo: 'Sessões',
  tituloGrande: true,
  montar(cont, params, ctx) {
    E.ctx = ctx;
    E.cont = cont;
    cont.classList.add('sx');
    montarTopo();
    E.msg = h('div', { class: 'sx-msg', hidden: true, 'aria-live': 'polite' });
    cont.append(E.topo, montarGrupos(), E.msg);
    E.nova = h('button', { class: 'btn-icone sx-nova toque', type: 'button', 'aria-label': 'Nova instância', hidden: true, onclick: () => ctx.ir('#nova') }, OM.icone('mais', 22));
    ctx.acoes.append(E.nova);
    if (OM.gestos && OM.gestos.puxar) {
      E.offPuxar = OM.gestos.puxar(ctx.corpo, async () => {
        const d = await OM.recarregar();
        if (d === null) OM.toast('Não deu para atualizar. Confira a conexão.');
      });
    }
    if (OM.sprites && OM.sprites.ligar) E.offSprites = OM.sprites.ligar(cont);
    E.montada = true;
    render();
  },
  mostrar() {
    E.ativa = true;
    E.semAnim = true; // volta à tela sem animar o que mudou enquanto estava fora
    render();
    clearInterval(E.relogio);
    E.relogio = setInterval(() => { if (!document.hidden) atualizarTempos(); }, 30000);
  },
  atualizar() {
    render();
  },
  esconder() {
    E.ativa = false;
    clearInterval(E.relogio);
    E.relogio = 0;
  },
  desmontar() {
    E.ativa = false;
    E.montada = false;
    clearInterval(E.relogio);
    cancelAnimationFrame(E.quadro);
    if (E.offPuxar) E.offPuxar();
    if (E.offSprites) E.offSprites();
    for (const r of E.linhas.values()) { clearTimeout(r.fimT); if (r.desl) r.desl.off(); }
    E.linhas.clear();
    E.grupos.clear();
    E.chipsSig = '';
    E.ultimaMsg = '';
    E.offPuxar = E.offSprites = null;
  },
});
})();
