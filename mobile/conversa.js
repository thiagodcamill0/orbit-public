// Orbit no celular — tela conversa (onda 3), rota #s=<id>. CSS em /m/conversa.css (+ /m/md.css para o markdown).
// Cabeçalho (sprite/status ao vivo, nome, projeto, "⋯" com Compactar/Limpar/Detalhes), linha do tempo com paginação,
// fluxo SSE /sessao/:id/conversa/fluxo (itens, parcial, reinicio), cartões de permissão no fim (OM.cartoes),
// rolagem grudada no fim com "Novas mensagens", bolha otimista pelos eventos do composer:
//   OM.emitir('composer:enviado', { id, temp, texto, imagens:[{url}] })  → bolha local "Enviando…"
//   OM.emitir('composer:ok',      { id, temp })                         → "Enviado"; some quando o item real chega
//   OM.emitir('composer:falhou',  { id, temp, erro, tentar? })          → erro; "Tentar de novo" se vier tentar()
// O composer é montado no rodapé: OM.composer?.montar(rodape, { id }). Nada de innerHTML; sem estilo inline (CSP).
(() => {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h, txt } = OM;
const B = OM.base || {};
const ROTULO = B.ROTULO_STATUS || {};
const LIMITE = 40;
const RE_ESPERA = 2500;
const VIVAS = new WeakMap();
const CONTA_NOVA = new Set(['assistente', 'usuario', 'par', 'erro', 'compactacao', 'limpeza']);

const ico = (n, t) => (OM.icone ? OM.icone(n, t || 16) : null);
const rota = (v, sub) => '/sessao/' + encodeURIComponent(v.id) + (sub ? '/' + sub : '');
const statusDe = (s) => (s && s.status in ROTULO ? s.status : 'nova');
const reduzido = () => (OM.reduzido ? OM.reduzido() : false);
const hashTxt = (t) => { let x = 0; for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) | 0; return Math.abs(x); };
const fmtK = (n) => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); };
const hora = (ts) => { try { return ts && OM.fmt && OM.fmt.hora ? OM.fmt.hora(ts) : ''; } catch { return ''; } };
const normal = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
const json = (ev) => { try { return JSON.parse(ev.data); } catch { return null; } };

function tituloDe(s) {
  if (!s) return 'Conversa';
  try { return (OM.fmt && OM.fmt.titulo && OM.fmt.titulo(s)) || 'Conversa'; } catch { return 'Conversa'; }
}
function projetoDe(s) {
  if (!s) return '';
  try { return (OM.fmt && OM.fmt.projeto && OM.fmt.projeto(s)) || ''; } catch { return ''; }
}
function spriteDe(s) {
  const st = statusDe(s);
  const ags = Array.isArray(s.agentes) ? s.agentes : [];
  const est = B.estadoSprite ? B.estadoSprite(st, { ferramenta: s.ferramenta, subTrabalhando: ags.some((a) => a && a.status === 'trabalhando') }) : 'dormindo';
  const lista = (B.SPRITE && (B.SPRITE[est] || B.SPRITE.dormindo)) || ['sprites/sprite-sleep'];
  return lista[lista.length === 1 ? 0 : hashTxt(String(s.id) + '|' + (Number(s.desde) || 0) + '|' + est) % lista.length];
}

// ───────────────────────────── montar ─────────────────────────────
function montar(cont, params, ctx) {
  const id = String((params && params.id) || '');
  const v = {
    id, ctx, cont, itens: new Map(), locais: new Map(), respondidos: new Set(), offs: [],
    es: null, reTimer: 0, gen: 0, fase: 'carregando', cursorAntigo: null, cursorNovo: null,
    grudado: true, grudadoAoEsconder: true, visivel: true, morto: false, cartao: null, comp: null,
    sprite: '', limpando: null, buscandoAntigos: false, parcTimer: 0, pendParc: new Map(), ro: null, io: null,
  };
  VIVAS.set(ctx, v);
  ctx.tela.classList.add('cv-tela');

  // Cabeçalho: sprite + nome + (ponto de status · rótulo · projeto); "⋯" à direita.
  v.cabSprite = h('img', { class: 'cv-cab-sprite', alt: '', width: 28, height: 28, decoding: 'async', draggable: 'false' });
  v.cabNome = h('span', { class: 'cv-cab-nome' });
  v.cabPonto = h('span', { class: 'cv-ponto', 'aria-hidden': 'true' });
  v.cabStatus = h('span', { class: 'cv-cab-st' });
  v.cabProj = h('span', { class: 'cv-cab-proj' });
  const cabTit = ctx.cab.querySelector('.cab-tit');
  if (cabTit) {
    cabTit.classList.add('cv-cab-tit');
    cabTit.replaceChildren(v.cabSprite, h('span', { class: 'cv-cab-txt' }, v.cabNome, h('span', { class: 'cv-cab-sub' }, v.cabPonto, v.cabStatus, v.cabProj)));
  }
  v.btMais = h('button', { class: 'btn-icone cv-mais', type: 'button', 'aria-label': 'Mais ações', 'aria-haspopup': 'dialog', onclick: () => abrirMenu(v) }, ico('pontos', 20));
  ctx.acoes.replaceChildren(v.btMais);

  // Corpo: anteriores · lista · bolhas locais · pensando · cartões · estado.
  v.btAntigos = h('button', { class: 'btn cv-antigos', type: 'button', hidden: true, onclick: () => carregarAntigos(v) }, ico('chevron-cima', 16), h('span', null, 'Mensagens anteriores'));
  v.topo = h('div', { class: 'cv-topo' }, v.btAntigos);
  v.lista = h('div', { class: 'cv-lista', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversa' });
  v.locaisEl = h('div', { class: 'cv-locais' });
  v.pensando = h('div', { class: 'cv-pensando', hidden: true, role: 'status' }, h('span', { class: 'cv-pontinhos', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', null, 'Trabalhando…'));
  v.cartoesEl = h('div', { class: 'cv-cartoes' });
  v.estadoEl = h('div', { class: 'cv-estado', hidden: true });
  v.raiz = h('div', { class: 'cv' }, v.topo, v.lista, v.locaisEl, v.pensando, v.cartoesEl, v.estadoEl);
  cont.replaceChildren(v.raiz);

  // Rodapé (composer) e o botão flutuante "Novas mensagens", fora do que rola.
  v.btNovas = h('button', { class: 'cv-novas', type: 'button', hidden: true, onclick: () => { rolarFim(v, true); } }, h('span', null, 'Novas mensagens'), ico('chevron-baixo', 16));
  v.pos = h('div', { class: 'cv-pos' }, v.btNovas);
  v.rodape = h('div', { class: 'cv-rodape' });
  ctx.corpo.after(v.pos, v.rodape);
  try { if (OM.composer && typeof OM.composer.montar === 'function') v.comp = OM.composer.montar(v.rodape, { id }) || null; } catch (e) { console.warn('conversa: composer', e); }

  // Rolagem: grudado = perto do fim. Conteúdo que cresce (imagens, md, cartões, composer) mantém o fim à vista.
  v.aoRolar = () => {
    const c = ctx.corpo;
    if (!c.clientHeight) return;
    v.grudado = c.scrollHeight - c.scrollTop - c.clientHeight < 48;
    if (v.grudado) v.btNovas.hidden = true;
  };
  ctx.corpo.addEventListener('scroll', v.aoRolar, { passive: true });
  if (window.ResizeObserver) {
    v.ro = new ResizeObserver(() => { if (v.grudado && v.visivel) irFim(v); });
    v.ro.observe(v.raiz);
    v.ro.observe(v.rodape);
  }
  if (window.IntersectionObserver) {
    v.io = new IntersectionObserver((ents) => {
      if (ents.some((e) => e.isIntersecting) && v.fase === 'ok' && !v.btAntigos.hidden && !v.grudado) carregarAntigos(v);
    }, { root: ctx.corpo, rootMargin: '240px 0px 0px 0px' });
    v.io.observe(v.topo);
  }

  // Bolha otimista do composer.
  const minha = (d) => d && String(d.id) === v.id && d.temp != null;
  v.offs.push(
    OM.ouvir('composer:enviado', (d) => { if (minha(d)) adicionarLocal(v, d); }),
    OM.ouvir('composer:ok', (d) => { if (minha(d)) marcarLocal(v, d.temp, 'enviado'); }),
    OM.ouvir('composer:falhou', (d) => { if (minha(d)) marcarLocal(v, d.temp, 'erro', d); }),
    OM.ouvir('conexao', (c) => aoConexao(v, c)),
  );
  if (OM.sprites && OM.sprites.ligar) { try { const off = OM.sprites.ligar(ctx.cab); if (typeof off === 'function') v.offs.push(off); } catch {} }

  pintarCab(v);
  carregar(v, true);
}

// ───────────────────────────── estados ─────────────────────────────
function pintarEstado(v) {
  const e = v.estadoEl;
  const f = v.fase;
  const temItens = v.itens.size > 0;
  v.raiz.dataset.fase = f;
  if (f === 'ok' || (temItens && f !== '404')) { e.hidden = true; e.replaceChildren(); return; }
  e.hidden = false;
  if (f === 'carregando') {
    e.replaceChildren(h('div', { class: 'cv-esq', 'aria-hidden': 'true' },
      h('span', { class: 'esq cv-esq-d' }), h('span', { class: 'esq cv-esq-e1' }), h('span', { class: 'esq cv-esq-e2' }),
      h('span', { class: 'esq cv-esq-d cv-esq-curta' }), h('span', { class: 'esq cv-esq-e1' })),
      h('span', { class: 'sr', role: 'status' }, 'Carregando a conversa…'));
    return;
  }
  const bloco = (icone, titulo, texto, ...botoes) => e.replaceChildren(h('div', { class: 'cv-aviso', role: 'status' },
    h('span', { class: 'cv-aviso-ico', 'aria-hidden': 'true' }, ico(icone, 22)), h('p', { class: 'cv-aviso-tit' }, titulo),
    texto ? h('p', { class: 'cv-aviso-txt' }, texto) : null, ...botoes));
  if (f === '404') {
    v.lista.replaceChildren(); v.itens.clear(); v.cartoesEl.replaceChildren(); v.cartao = null; v.btAntigos.hidden = true;
    bloco('info', 'Esta sessão não existe mais', 'Ela pode ter sido encerrada ou removida no PC.',
      h('button', { class: 'btn cv-aviso-bt', type: 'button', onclick: () => v.ctx.voltar() }, ico('chevron-esq', 16), 'Voltar'));
  } else if (f === 'off') {
    bloco('alerta', 'O PC está desconectado', 'A conversa aparece quando o Orbit voltar a responder.',
      h('button', { class: 'btn cv-aviso-bt', type: 'button', onclick: () => { if (OM.tentarAgora) OM.tentarAgora(); carregar(v, true); } }, ico('atualizar', 16), 'Tentar agora'));
  } else {
    bloco('alerta', 'Não deu para abrir a conversa', v.erroTxt || '',
      h('button', { class: 'btn cv-aviso-bt', type: 'button', onclick: () => carregar(v, true) }, ico('atualizar', 16), 'Tentar de novo'));
  }
}

function faseDoErro(e) {
  if (e && e.status === 404) return '404';
  if (e && e.status === 0) return 'off';
  const c = OM.estado && OM.estado.conexao;
  return c === 'pc' || c === 'offline' ? 'off' : 'erro';
}

// ───────────────────────────── carregar ─────────────────────────────
async function carregar(v, substituir) {
  const g = ++v.gen;
  fecharFluxo(v);
  if (substituir || !v.itens.size) { v.fase = 'carregando'; pintarEstado(v); }
  try {
    const d = await OM.api('GET', rota(v, 'conversa') + '?limite=' + LIMITE);
    if (v.morto || g !== v.gen) return;
    if (substituir) { v.lista.replaceChildren(); v.itens.clear(); }
    v.cursorAntigo = d.cursorAntigo != null ? d.cursorAntigo : null;
    v.cursorNovo = d.cursorNovo != null ? d.cursorNovo : v.cursorNovo;
    v.btAntigos.hidden = v.cursorAntigo == null;
    mesclar(v, Array.isArray(d.itens) ? d.itens : [], false);
    v.fase = 'ok';
    pintarEstado(v);
    atualizar(OM.estado, v.ctx);
    v.grudado = true;
    irFim(v);
    abrirFluxo(v);
  } catch (e) {
    if (v.morto || g !== v.gen) return;
    v.fase = faseDoErro(e);
    v.erroTxt = e && e.message ? String(e.message) : '';
    pintarEstado(v);
    if (v.fase === 'erro' && v.itens.size) OM.toast && OM.toast(v.erroTxt || 'Não deu para atualizar a conversa.');
  }
}

async function carregarAntigos(v) {
  if (v.buscandoAntigos || v.cursorAntigo == null || v.fase !== 'ok') return;
  v.buscandoAntigos = true;
  v.btAntigos.disabled = true;
  v.btAntigos.classList.add('carregando');
  const g = v.gen;
  try {
    const d = await OM.api('GET', rota(v, 'conversa') + '?antes=' + encodeURIComponent(v.cursorAntigo) + '&limite=' + LIMITE);
    if (v.morto || g !== v.gen) return;
    v.cursorAntigo = d.cursorAntigo != null ? d.cursorAntigo : null;
    const c = v.ctx.corpo;
    const antes = c.scrollHeight - c.scrollTop;
    const frag = document.createDocumentFragment();
    for (const it of Array.isArray(d.itens) ? d.itens : []) {
      if (!it || it.id == null || v.itens.has(String(it.id))) continue;
      const el = noItem(v, it);
      v.itens.set(String(it.id), el);
      frag.append(el);
    }
    v.lista.prepend(frag);
    c.scrollTop = c.scrollHeight - antes;
  } catch (e) {
    if (!v.morto) OM.toast && OM.toast((e && e.message) || 'Não deu para buscar as mensagens anteriores.');
  } finally {
    v.buscandoAntigos = false;
    v.btAntigos.disabled = false;
    v.btAntigos.classList.remove('carregando');
    v.btAntigos.hidden = v.cursorAntigo == null;
  }
}

// ───────────────────────────── fluxo (SSE) ─────────────────────────────
function fecharFluxo(v) {
  clearTimeout(v.reTimer);
  v.reTimer = 0;
  if (v.es) { try { v.es.close(); } catch {} v.es = null; }
}
function abrirFluxo(v) {
  fecharFluxo(v);
  if (v.morto || v.fase !== 'ok') return;
  if (OM.estado && OM.estado.conexao && OM.estado.conexao !== 'vivo' && OM.estado.conexao !== 'conectando') return;
  let es;
  const q = v.cursorNovo != null ? '?desde=' + encodeURIComponent(v.cursorNovo) : '';
  try { es = new EventSource(rota(v, 'conversa/fluxo') + q); } catch { agendarReabrir(v); return; }
  v.es = es;
  es.addEventListener('itens', (ev) => {
    if (v.es !== es) return;
    const d = json(ev);
    if (!d) return;
    if (d.cursorNovo != null) v.cursorNovo = d.cursorNovo;
    else if (d.cursor != null) v.cursorNovo = d.cursor;
    if (Array.isArray(d.itens)) mesclar(v, d.itens, true);
  });
  es.addEventListener('parcial', (ev) => { if (v.es === es) parcial(v, json(ev)); });
  es.addEventListener('reinicio', (ev) => {
    if (v.es !== es) return;
    const d = json(ev) || {};
    fecharFluxo(v);
    if (d.novaSessao && String(d.novaSessao) !== v.id) v.ctx.ir('#s=' + encodeURIComponent(String(d.novaSessao)));
    else carregar(v, true);
  });
  es.onerror = () => { if (v.es !== es) return; fecharFluxo(v); agendarReabrir(v); };
}
function agendarReabrir(v) {
  clearTimeout(v.reTimer);
  if (v.morto) return;
  v.reTimer = setTimeout(() => {
    v.reTimer = 0;
    const c = OM.estado && OM.estado.conexao;
    if (c && c !== 'vivo') return; // volta pelo evento 'conexao'
    recarregarFim(v);
  }, RE_ESPERA);
}
// Depois de uma queda: busca o fim de novo, mescla por id e reabre o fluxo.
async function recarregarFim(v) {
  if (v.morto) return;
  const g = v.gen;
  try {
    const d = await OM.api('GET', rota(v, 'conversa') + '?limite=' + LIMITE);
    if (v.morto || g !== v.gen) return;
    if (d.cursorNovo != null) v.cursorNovo = d.cursorNovo;
    if (!v.itens.size) { v.cursorAntigo = d.cursorAntigo != null ? d.cursorAntigo : null; v.btAntigos.hidden = v.cursorAntigo == null; }
    mesclar(v, Array.isArray(d.itens) ? d.itens : [], true);
    abrirFluxo(v);
  } catch (e) {
    if (v.morto || g !== v.gen) return;
    if (e && e.status === 404) { v.fase = '404'; pintarEstado(v); return; }
    agendarReabrir(v);
  }
}
function aoConexao(v, c) {
  if (v.morto) return;
  if (c === 'vivo') {
    if (v.fase !== 'ok') carregar(v, true);
    else if (!v.es) recarregarFim(v);
  } else if (c === 'pc' || c === 'offline' || c === 'revogado') {
    fecharFluxo(v);
    if (v.fase === 'carregando' || (v.fase === 'erro' && !v.itens.size)) { v.gen++; v.fase = 'off'; pintarEstado(v); }
  }
}

// ───────────────────────────── itens ─────────────────────────────
function mesclar(v, itens, vivos) {
  let novas = false;
  const frag = document.createDocumentFragment();
  for (const it of itens) {
    if (!it || it.id == null) continue;
    const k = String(it.id);
    const el = noItem(v, it);
    const velho = v.itens.get(k);
    v.pendParc.delete(k);
    if (velho && velho.isConnected) velho.replaceWith(el);
    else {
      if (vivos) el.classList.add('cv-novo');
      frag.append(el);
      if (vivos && CONTA_NOVA.has(it.tipo)) novas = true;
    }
    v.itens.set(k, el);
    if (it.tipo === 'usuario' || it.tipo === 'par' || it.tipo === 'comando') casarLocal(v, it);
  }
  v.lista.append(frag);
  depoisDeMudar(v, novas);
}
function depoisDeMudar(v, novas) {
  if (v.grudado) { irFim(v); return; }
  if (novas) v.btNovas.hidden = false;
}
function parcial(v, d) {
  if (!d || d.id == null) return;
  v.pendParc.set(String(d.id), String(d.texto || ''));
  if (v.parcTimer) return;
  v.parcTimer = setTimeout(() => {
    v.parcTimer = 0;
    let novas = false;
    for (const [k, texto] of v.pendParc) {
      const velho = v.itens.get(k);
      if (velho && velho.dataset.parcial !== '1') continue; // já veio o item final
      const el = noItem(v, { id: k, tipo: 'assistente', texto, parcial: true });
      if (velho && velho.isConnected) velho.replaceWith(el);
      else { el.classList.add('cv-novo'); v.lista.append(el); novas = true; }
      v.itens.set(k, el);
    }
    v.pendParc.clear();
    depoisDeMudar(v, novas);
  }, 60);
}

function noItem(v, it) {
  let el;
  try {
    switch (it.tipo) {
      case 'usuario': case 'par': el = bolha(v, it); break;
      case 'assistente': el = h('div', { class: 'cv-item cv-assist' + (it.parcial ? ' cv-parcial' : '') }, h('div', { class: 'md' }, OM.md(String(it.texto || '')))); if (it.parcial) el.dataset.parcial = '1'; break;
      case 'pensamento': el = h('details', { class: 'cv-item cv-pens' }, h('summary', null, ico('chevron-baixo', 14), h('span', null, 'Pensamento')), h('div', { class: 'cv-pens-txt' }, String(it.texto || ''))); break;
      case 'ferramenta': el = ferramenta(it); break;
      case 'compactacao': {
        const nums = it.pre && it.pos ? ' · ' + fmtK(it.pre) + ' → ' + fmtK(it.pos) : '';
        const quando = it.auto && it.ts ? ' às ' + hora(it.ts) : '';
        el = divisor('comprimir', (it.auto ? 'Compactado automaticamente' + quando : 'Contexto compactado') + nums, it.foco ? 'Foco: ' + it.foco : '');
        break;
      }
      case 'limpeza': el = divisor('borracha', 'Conversa limpa', 'O contexto recomeçou daqui'); break;
      case 'interrupcao': el = h('div', { class: 'cv-item cv-nota' }, ico('parar', 14), h('span', null, 'Interrompido pelo usuário')); break;
      case 'comando': el = h('div', { class: 'cv-item cv-comando' }, ico('terminal', 14), h('code', null, String(it.texto || ''))); break;
      case 'saida': el = h('div', { class: 'cv-item cv-saida' }, h('pre', null, String(it.texto || ''))); break;
      case 'erro': el = h('div', { class: 'cv-item cv-erro', role: 'note' }, ico('alerta', 16), h('span', null, String(it.texto || 'Erro sem detalhe'))); break;
      default: el = h('div', { class: 'cv-item cv-nota' }, h('span', null, String(it.texto || it.tipo || 'item')));
    }
  } catch (e) {
    console.warn('conversa: item', e);
    el = h('div', { class: 'cv-item cv-nota' }, h('span', null, 'Item que não deu para mostrar'));
  }
  el.dataset.id = String(it.id);
  return el;
}
function divisor(icone, rotulo, sub) {
  return h('div', { class: 'cv-item cv-div', role: 'separator' },
    h('span', { class: 'cv-div-linha', 'aria-hidden': 'true' }),
    h('span', { class: 'cv-div-rot' }, h('span', { class: 'cv-div-tit' }, ico(icone, 14), h('span', null, rotulo)), sub ? h('span', { class: 'cv-div-sub' }, sub) : null),
    h('span', { class: 'cv-div-linha', 'aria-hidden': 'true' }));
}
function ferramenta(it) {
  const r = it.resultado || null;
  const erro = !!(r && r.erro);
  const marca = r ? h('span', { class: 'cv-ferr-marca' + (erro ? ' erro' : ' ok'), 'aria-label': erro ? 'Falhou' : 'Concluída' }, ico(erro ? 'x' : 'check', 14))
    : h('span', { class: 'cv-ferr-marca rodando', 'aria-label': 'Rodando' }, h('i'));
  const corpo = r && r.texto != null && String(r.texto) !== ''
    ? h('pre', { class: 'cv-ferr-res' + (erro ? ' erro' : '') }, String(r.texto))
    : h('p', { class: 'cv-ferr-vazio' }, r ? 'Sem saída.' : 'Rodando…');
  return h('details', { class: 'cv-item cv-ferr' + (erro ? ' cv-ferr-erro' : '') },
    h('summary', null, marca, h('span', { class: 'cv-ferr-nome' }, String(it.nome || 'Ferramenta')),
      h('span', { class: 'cv-ferr-resumo' }, String(it.resumo || '')), h('span', { class: 'cv-ferr-chev', 'aria-hidden': 'true' }, ico('chevron-baixo', 14))),
    h('div', { class: 'cv-ferr-corpo' }, corpo));
}
function galeria(v, imagens) {
  const imgs = (Array.isArray(imagens) ? imagens : []).map((x) => ({
    url: (typeof x === 'string' ? x : x && x.url) || (x && x.o != null ? rota(v, 'imagem') + '?o=' + encodeURIComponent(x.o) + '&i=' + encodeURIComponent(x.i) : ''),
  })).filter((x) => x.url);
  if (!imgs.length) return null;
  const g = h('div', { class: 'cv-galeria' + (imgs.length > 1 ? ' varias' : '') });
  imgs.forEach((x, k) => {
    const img = h('img', { src: x.url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    const b = h('button', { type: 'button', class: 'cv-img', 'aria-label': 'Ampliar imagem ' + (k + 1) + ' de ' + imgs.length }, img);
    img.addEventListener('error', () => { b.disabled = true; b.classList.add('falhou'); b.replaceChildren(h('span', null, 'Imagem indisponível')); }, { once: true });
    b.addEventListener('click', () => {
      if (!OM.folha) return;
      OM.folha.abrir({ titulo: 'Imagem ' + (k + 1) + ' de ' + imgs.length, paradas: ['inteira'], conteudo: h('div', { class: 'cv-ampliada' }, h('img', { src: x.url, alt: '', decoding: 'async' })) });
    });
    g.append(b);
  });
  return g;
}
function bolha(v, it, local) {
  const texto = String(it.texto || '');
  const meta = h('div', { class: 'cv-meta' });
  if (it.tipo === 'par') meta.append(h('span', { class: 'cv-tag' }, 'pelo canal'));
  if (!local && it.ts) meta.append(h('span', null, hora(it.ts)));
  return h('div', { class: 'cv-item cv-usu' + (it.tipo === 'par' ? ' cv-par' : '') + (local ? ' cv-local' : '') },
    galeria(v, it.imagens), texto ? h('div', { class: 'cv-bolha' }, texto) : null, meta);
}

// ───────────────────────────── bolha otimista ─────────────────────────────
function adicionarLocal(v, d) {
  const k = String(d.temp);
  if (v.locais.has(k)) return;
  const el = bolha(v, { tipo: 'usuario', texto: d.texto, imagens: d.imagens }, true);
  el.classList.add('cv-novo');
  el.dataset.estado = 'enviando';
  const meta = el.querySelector('.cv-meta');
  const rot = h('span', { class: 'cv-local-st' }, 'Enviando…');
  meta.append(rot);
  v.locais.set(k, { el, rot, meta, texto: normal(d.texto), fotos: Array.isArray(d.imagens) ? d.imagens.length : 0, timer: 0 });
  v.locaisEl.append(el);
  v.grudado = true;
  irFim(v);
}
function marcarLocal(v, temp, estado, d) {
  const l = v.locais.get(String(temp));
  if (!l) return;
  l.el.dataset.estado = estado;
  for (const b of l.meta.querySelectorAll('button')) b.remove();
  if (estado === 'enviado') {
    txt(l.rot, 'Enviado');
    clearTimeout(l.timer);
    l.timer = setTimeout(() => tirarLocal(v, temp), 30000); // se o eco nunca casar, não fica para sempre
  } else if (estado === 'erro') {
    txt(l.rot, (d && d.erro ? String(d.erro) : 'Não foi enviada.'));
    if (d && typeof d.tentar === 'function') {
      l.meta.append(h('button', { class: 'btn cv-local-bt', type: 'button', onclick: () => { marcarLocal(v, temp, 'enviando'); txt(l.rot, 'Enviando…'); try { d.tentar(); } catch (e) { marcarLocal(v, temp, 'erro', { erro: e && e.message }); } } }, ico('atualizar', 14), 'Tentar de novo'));
    }
    l.meta.append(h('button', { class: 'btn cv-local-bt', type: 'button', onclick: () => tirarLocal(v, temp) }, ico('x', 14), 'Descartar'));
  } else txt(l.rot, 'Enviando…');
}
function tirarLocal(v, temp) {
  const k = String(temp);
  const l = v.locais.get(k);
  if (!l) return;
  clearTimeout(l.timer);
  l.el.remove();
  v.locais.delete(k);
}
function casarLocal(v, it) {
  const t = normal(it.texto);
  for (const [k, l] of v.locais) {
    if (l.el.dataset.estado === 'erro') continue;
    if ((t && l.texto === t) || (!t && !l.texto && l.fotos)) { tirarLocal(v, k); return; }
  }
}

// ───────────────────────────── rolagem ─────────────────────────────
function irFim(v) {
  const c = v.ctx.corpo;
  c.scrollTop = c.scrollHeight;
}
function rolarFim(v, suave) {
  const c = v.ctx.corpo;
  v.grudado = true;
  v.btNovas.hidden = true;
  if (suave && !reduzido() && c.scrollTo) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
  else irFim(v);
}

// ───────────────────────────── estado da sessão ─────────────────────────────
function pintarCab(v) {
  const s = OM.sessao ? OM.sessao(v.id) : null;
  const st = statusDe(s);
  txt(v.cabNome, tituloDe(s));
  v.cabPonto.dataset.st = st;
  txt(v.cabStatus, s ? ROTULO[st] || st : '');
  const proj = projetoDe(s);
  txt(v.cabProj, proj ? ' · ' + proj : '');
  if (s && OM.sprites) {
    const nome = spriteDe(s);
    if (nome !== v.sprite) {
      const primeiro = !v.sprite;
      v.sprite = nome;
      try {
        if (/-parado$/.test(nome)) { delete v.cabSprite.dataset.gif; v.cabSprite.src = '/assets/' + nome + '.png'; }
        else if (primeiro || !OM.sprites.trocarSprite || reduzido()) OM.sprites.definir(v.cabSprite, nome);
        else OM.sprites.trocarSprite(v.cabSprite, nome);
      } catch (e) { console.warn('conversa: sprite', e); }
    }
  }
  v.cabSprite.hidden = !v.sprite;
}

function pintarCartao(v, s) {
  const c = s && s.controle;
  const p = c && c.permissao;
  const pid = p && p.id != null ? String(p.id) : '';
  if (!p || !pid || v.respondidos.has(pid) || v.fase !== 'ok') {
    if (v.cartao && (!p || v.cartao.pid !== pid || v.fase !== 'ok')) tirarCartao(v, false);
    return;
  }
  const fila = Math.max(0, (Number(c.pendentes) || 1) - 1);
  if (v.cartao && v.cartao.pid === pid) { if (v.cartao.el.atualizarFila) v.cartao.el.atualizarFila(fila); return; }
  if (v.cartao) tirarCartao(v, false);
  if (!OM.cartoes || !OM.cartoes.cartao) return;
  const api = {
    responder: (corpo) => OM.api('POST', rota(v, 'permissao'), corpo),
    icone: OM.icone, md: OM.md, toast: OM.toast, confirmar: OM.confirmar,
  };
  let el;
  try {
    el = OM.cartoes.cartao(p, api, { fila, aoResponder: (info) => {
      if (info && (info.ok || info.jaRespondido)) { v.respondidos.add(pid); if (v.cartao && v.cartao.pid === pid) tirarCartao(v, true); }
    } });
  } catch (e) { console.warn('conversa: cartão', e); return; }
  if (!el) return;
  const caixa = h('div', { class: 'cv-cartao cv-novo' }, el);
  v.cartao = { pid, el, caixa };
  v.cartoesEl.append(caixa);
  depoisDeMudar(v, true);
}
function tirarCartao(v, animar) {
  const c = v.cartao;
  v.cartao = null;
  if (!c) return;
  if (!animar || reduzido() || !c.caixa.animate) { c.caixa.remove(); return; }
  c.caixa.classList.add('cv-saindo');
  const a = c.caixa.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: OM.cssVar ? OM.cssVar('--ease-saida', 'cubic-bezier(.4,0,1,1)') : 'cubic-bezier(.4,0,1,1)' });
  a.onfinish = () => c.caixa.remove();
  a.oncancel = () => c.caixa.remove();
}

function atualizar(_estado, ctx) {
  const v = VIVAS.get(ctx);
  if (!v || v.morto) return;
  const s = OM.sessao ? OM.sessao(v.id) : null;
  pintarCab(v);
  pintarCartao(v, s);
  const c = s && s.controle;
  const trab = v.fase === 'ok' && statusDe(s) === 'trabalhando' && !(c && c.permissao);
  if (v.pensando.hidden === trab) { v.pensando.hidden = !trab; if (trab) depoisDeMudar(v, false); }
  // Limpar: o servidor zera os itens com a sessão ocupada; quando ela solta, recarrega a lista toda.
  if (v.limpando) {
    const ocupada = !!(c && c.ocupada);
    if (ocupada) v.limpando.viu = true;
    else if (v.limpando.viu) { clearTimeout(v.limpando.timer); v.limpando = null; carregar(v, true); }
  }
}

// ───────────────────────────── menu "⋯" ─────────────────────────────
function abrirMenu(v) {
  if (!OM.folha) return;
  const item = (icone, rotulo, sub, fn, perigo) => h('button', { class: 'cv-menu-item' + (perigo ? ' perigo' : ''), type: 'button', onclick: fn },
    h('span', { class: 'cv-menu-ico', 'aria-hidden': 'true' }, ico(icone, 20)),
    h('span', { class: 'cv-menu-txt' }, h('span', { class: 'cv-menu-rot' }, rotulo), h('span', { class: 'cv-menu-sub' }, sub)));
  OM.folha.abrir({
    titulo: 'Conversa', paradas: ['auto'],
    conteudo: (corpo, f) => {
      corpo.append(h('div', { class: 'cv-menu' },
        item('comprimir', 'Compactar', 'Resume o contexto para liberar espaço', async () => { await f.fechar('botao'); abrirCompactar(v); }),
        item('borracha', 'Limpar', 'Começa do zero, sem a conversa atual', async () => { await f.fechar('botao'); limpar(v); }, true),
        item('info', 'Detalhes', 'Agentes, tarefas, contexto e apelido', async () => { await f.fechar('botao'); v.ctx.ir('#s=' + encodeURIComponent(v.id) + '/detalhe'); })));
    },
  });
}
function abrirCompactar(v) {
  const MAX = 2000;
  OM.folha.abrir({
    titulo: 'Compactar a conversa', paradas: ['auto'],
    conteudo: (corpo, f) => {
      const campo = h('textarea', { class: 'cv-foco', rows: 3, maxlength: MAX, placeholder: 'Ex.: manter as decisões sobre o banco', 'aria-label': 'Foco da compactação (opcional)', autocapitalize: 'sentences' });
      const conta = h('span', { class: 'cv-foco-conta', 'aria-live': 'polite' }, '0/' + MAX);
      campo.addEventListener('input', () => { txt(conta, campo.value.length + '/' + MAX); });
      const bt = h('button', { class: 'btn solido cv-foco-bt', type: 'button' }, ico('comprimir', 16), 'Compactar');
      bt.addEventListener('click', async () => {
        const foco = campo.value.trim().slice(0, MAX);
        bt.disabled = true;
        try {
          await OM.api('POST', rota(v, 'compactar'), foco ? { foco } : {});
          await f.fechar('botao');
          OM.toast && OM.toast('Compactando a conversa…');
        } catch (e) {
          bt.disabled = false;
          OM.toast && OM.toast((e && e.message) || 'Não deu para compactar.');
        }
      });
      corpo.append(h('div', { class: 'cv-compactar' },
        h('p', { class: 'cv-compactar-txt' }, 'O agente resume a conversa até aqui. Diga, se quiser, o que não pode se perder.'),
        h('label', { class: 'cv-foco-rot' }, h('span', null, 'Foco (opcional)'), conta), campo, bt));
    },
  });
}
async function limpar(v) {
  const ok = OM.confirmar ? await OM.confirmar({ titulo: 'Limpar a conversa?', texto: 'O agente começa do zero, sem lembrar desta conversa. Isso não pode ser desfeito.', sim: 'Limpar', nao: 'Cancelar', perigo: true }) : false;
  if (!ok || v.morto) return;
  try {
    await OM.api('POST', rota(v, 'limpar'), { confirmar: true });
    OM.toast && OM.toast('Limpando a conversa…');
    if (v.limpando) clearTimeout(v.limpando.timer);
    v.limpando = { viu: false, timer: setTimeout(() => { if (v.limpando) { v.limpando = null; carregar(v, true); } }, 4000) };
    atualizar(OM.estado, v.ctx);
  } catch (e) {
    OM.toast && OM.toast((e && e.message) || 'Não deu para limpar a conversa.');
  }
}

// ───────────────────────────── ciclo de vida ─────────────────────────────
function mostrar(ctx) {
  const v = VIVAS.get(ctx);
  if (!v) return;
  v.visivel = true;
  v.grudado = v.grudadoAoEsconder;
  if (v.grudado) requestAnimationFrame(() => { if (v.grudado) irFim(v); });
  if (v.fase === 'ok' && !v.es && !v.reTimer) recarregarFim(v);
}
function esconder(ctx) {
  const v = VIVAS.get(ctx);
  if (!v) return;
  v.grudadoAoEsconder = v.grudado;
  v.visivel = false;
}
function desmontar(ctx) {
  const v = VIVAS.get(ctx);
  if (!v) return;
  v.morto = true;
  v.gen++;
  fecharFluxo(v);
  clearTimeout(v.parcTimer);
  if (v.limpando) clearTimeout(v.limpando.timer);
  for (const l of v.locais.values()) clearTimeout(l.timer);
  for (const off of v.offs) { try { off(); } catch {} }
  v.offs = [];
  if (v.ro) v.ro.disconnect();
  if (v.io) v.io.disconnect();
  ctx.corpo.removeEventListener('scroll', v.aoRolar);
  try { if (v.comp && v.comp.desmontar) v.comp.desmontar(); } catch (e) { console.warn('conversa: composer', e); }
  v.pos.remove();
  v.rodape.remove();
  VIVAS.delete(ctx);
}

OM.telas.registrar('conversa', {
  titulo: (p) => tituloDe(OM.sessao && p && p.id ? OM.sessao(p.id) : null),
  semBarra: true,
  montar, mostrar, esconder, atualizar, desmontar,
});
})();
