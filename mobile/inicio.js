// Orbit no celular — tela Início (onda 3): a Visão geral em widgets. Contrato: "App do celular" (window.OM).
// Widgets, em ordem: Precisa de você (só com pendências) · Sessões · Contexto · Uso do plano · Sincronização · Resumo do dia.
// As contas (contexto, uso, sincronização) vêm de assets/comum/widgets.js (OrbitWidgets, as mesmas do PC); a cor e o sprite,
// de OrbitBase. Cada widget decide o próprio estado (esqueleto, vazio, erro, conteúdo) e só repinta quando o que ele mostra
// mudou (assinatura), com listas por chave: ao vivo nada é recriado, as barras só correm até o novo valor. Sem innerHTML
// com dado do servidor, sem nada inline (CSP).
(() => {
'use strict';
const OM = window.OM;
const B = window.OrbitBase;
if (!OM || !OM.telas || !B) return;
const { h, txt } = OM;
const doc = document;

const msgErro = 'Não deu para mostrar isto agora.';
const hashSessao = (s) => '#s=' + encodeURIComponent(s.id);
const nome = (s) => OM.fmt.titulo(s);
const quantoTempo = (t) => { const x = OM.fmt.tempo(t); return x === 'agora' ? 'agora' : 'há ' + x; };
const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);

// OrbitWidgets vem do <script> de assets/comum/widgets.js do index.html; se faltar, os widgets de conta mostram erro (sem quebrar a tela).
let W = window.OrbitWidgets || null;
let wFalhou = !W;

// ───────────────────────────── peças ─────────────────────────────
// Lista por chave: reaproveita os elementos (data-k), cria só os novos e tira os que sumiram. Devolve true se criou algum.
function lista(pai, itens, criar, pintar, animar) {
  const atuais = new Map();
  for (const e of Array.from(pai.children)) atuais.set(e.dataset.k, e);
  let criou = false;
  const card = animar ? pai.closest('.in-card') : null;
  const vivo = !!card && card.dataset.estado === 'ok';
  itens.forEach((it, i) => {
    let e = atuais.get(it.k);
    if (e) atuais.delete(it.k);
    else { e = criar(it); e.dataset.k = it.k; criou = true; if (vivo) e.classList.add('entra'); }
    pintar(e, it);
    if (pai.children[i] !== e) pai.insertBefore(e, pai.children[i] || null);
  });
  for (const e of atuais.values()) e.remove();
  return criou;
}
const trilho = () => h('span', { class: 'in-trilho' }, h('i'));
function pintarTrilho(el, pct, cor) {
  const i = el.firstElementChild;
  i.style.width = Math.max(2, Math.min(100, pct)) + '%';
  if (typeof cor === 'function') cor(i); else i.style.background = cor;
}

// Um widget: cartão (a, se leva a outra tela; section, se só mostra) com cabeçalho, esqueleto, mensagem e conteúdo.
//   def = { id, titulo, hash?, extra? (Node no cabeçalho), conteudo (Node), esq (nº de linhas), oculto? () → bool,
//           coletar (estado) → { tipo: 'esq'|'vazio'|'erro'|'ok', msg?, dados? }, pintar (dados) }
function criarWidget(def, indice) {
  const cab = h('div', { class: 'in-cab' }, h('h2', { class: 'in-tit', text: def.titulo }), def.extra || null,
    def.hash ? h('span', { class: 'in-seta', 'aria-hidden': 'true' }, OM.icone('chevron', 16)) : null);
  const esq = h('div', { class: 'in-esq', 'aria-hidden': 'true' },
    ...Array.from({ length: def.esq || 2 }, (_, i) => h('span', { class: 'esq in-esq-l' + (i + 1) })));
  const msg = h('p', { class: 'in-msg' });
  msg.hidden = true;
  def.conteudo.classList.add('in-conteudo');
  def.conteudo.hidden = true;
  const corpo = h('div', { class: 'in-corpo' }, esq, msg, def.conteudo);
  const el = def.hash
    ? h('a', { class: ['in-card', 'tile', 'toque', def.classe], href: def.hash, dados: { w: def.id }, onclick: (e) => { e.preventDefault(); OM.rotas.ir(def.hash); } }, cab, corpo)
    : h('section', { class: ['in-card', 'tile', def.classe], dados: { w: def.id }, 'aria-label': def.titulo }, cab, corpo);
  el.style.setProperty('--i', String(indice));
  const w = { def, el, esq, msg, corpo, cont: def.conteudo, tipo: '', sig: '', visivel: true, mostrou: false };
  el.addEventListener('animationend', (e) => { if (e.target === el) el.classList.remove('entra'); });
  return w;
}
function rodar(w, estado) {
  const d = w.def;
  try {
    if (d.oculto) {
      const o = !!d.oculto(estado);
      if (o !== !w.visivel) {
        w.visivel = !o;
        w.el.hidden = o;
        if (!o && w.mostrou) { w.el.classList.remove('entra'); void w.el.offsetWidth; w.el.classList.add('entra'); }
      }
      if (o) return;
    }
    const r = d.coletar(estado);
    const sig = r.tipo + '|' + (r.msg || '') + '|' + (r.tipo === 'ok' ? JSON.stringify(r.dados) : '');
    if (sig === w.sig) return;
    w.sig = sig;
    if (r.tipo === 'ok') d.pintar(r.dados);
    aplicarTipo(w, r.tipo, r.msg);
  } catch {
    if (w.sig !== 'erro') { w.sig = 'erro'; aplicarTipo(w, 'erro', msgErro); }
  }
}
function aplicarTipo(w, tipo, msg) {
  const antes = w.tipo;
  w.tipo = tipo;
  w.esq.hidden = tipo !== 'esq';
  w.msg.hidden = tipo !== 'vazio' && tipo !== 'erro';
  w.cont.hidden = tipo !== 'ok';
  w.el.dataset.estado = tipo;
  if (tipo !== 'ok' && w.def.aoVazio) w.def.aoVazio();
  if (tipo === 'vazio' || tipo === 'erro') { txt(w.msg, msg || ''); w.msg.classList.toggle('erro', tipo === 'erro'); }
  // Entrada do que acabou de chegar (esqueleto → conteúdo): translateY(4px) scale(.98), com atraso por posição.
  if (antes === 'esq' && tipo !== 'esq' && w.visivel) {
    w.el.classList.remove('entra'); void w.el.offsetWidth; w.el.classList.add('entra');
  }
  if (tipo !== 'esq') w.mostrou = true;
}

// ───────────────────────────── 1. Precisa de você ─────────────────────────────
function widgetPrecisa() {
  const num = h('span', { class: 'tile-num num' });
  const rot = h('small', { class: 'in-un' });
  const lin = h('div', { class: 'in-esp' });
  const mais = h('p', { class: 'in-mais' });
  mais.hidden = true;
  const cont = h('div', null,
    h('div', { class: 'tile-meio' }, h('span', { class: 'in-tile-n' }, num, rot), h('span', { class: 'tile-ico' }, OM.icone('alerta', 20))), lin, mais);
  return {
    id: 'precisa', titulo: 'Precisa de você', hash: '#aprovacoes', classe: 'alerta', conteudo: cont, esq: 2,
    oculto: (e) => !(e.pendentes > 0),
    coletar(e) {
      const ls = [...e.sessoes.values()].filter((s) => OM.pendentesDe(s) > 0)
        .sort((a, b) => (OM.fmt.emMs(a.desde) || 0) - (OM.fmt.emMs(b.desde) || 0));
      return { tipo: 'ok', dados: {
        n: e.pendentes,
        sessoes: ls.slice(0, 3).map((s) => ({ k: String(s.id), nome: nome(s), meta: OM.fmt.projeto(s) + ' · ' + quantoTempo(s.desde) })),
        resto: Math.max(0, ls.length - 3),
      } };
    },
    pintar(d) {
      txt(num, d.n);
      txt(rot, d.n === 1 ? 'pedido esperando' : 'pedidos esperando');
      lista(lin, d.sessoes, () => h('div', { class: 'in-esp-l' }, h('span', { class: 'in-nome' }), h('span', { class: 'in-meta' })),
        (e, it) => { txt(e.children[0], it.nome); txt(e.children[1], it.meta); }, true);
      mais.hidden = !d.resto;
      txt(mais, '+ ' + plural(d.resto, 'sessão', 'sessões'));
    },
  };
}

// ───────────────────────────── 2. Sessões ─────────────────────────────
const ORDEM_ST = ['aguardando', 'erro', 'trabalhando', 'concluida', 'interrompida', 'nova', 'encerrada'];
const PESO_ST = { aguardando: 0, erro: 1, trabalhando: 2, concluida: 3, interrompida: 4, nova: 6, encerrada: 7 };
const revisada = (s) => !!s.revisadaEm && (s.status === 'concluida' || s.status === 'interrompida');
function maisRelevante(ls) {
  let m = null, mp = 99;
  for (const s of ls) {
    const p = revisada(s) ? 5 : PESO_ST[s.status] ?? 8;
    const a = OM.fmt.emMs(s.atividade) || 0;
    if (!m || p < mp || (p === mp && a > (OM.fmt.emMs(m.atividade) || 0))) { m = s; mp = p; }
  }
  return m;
}
function spriteDe(s) {
  if (!s) return B.SPRITE.dormindo[0];
  const ags = Array.isArray(s.agentes) ? s.agentes : [];
  const est = B.estadoSprite(s.status, {
    ferramenta: s.ferramenta, tokens: (s.contexto && Number(s.contexto.tokens)) || 0,
    subTrabalhando: ags.some((a) => a && a.status === 'trabalhando'), revisada: revisada(s),
  });
  return (B.SPRITE[est] || B.SPRITE.dormindo)[0];
}
function widgetSessoes() {
  const total = h('b', { class: 'num' });
  const un = h('span', { class: 'in-un' });
  const linhas = h('div', { class: 'in-sts' });
  const img = h('img', { class: 'in-sprite', alt: '', width: 72, height: 72, decoding: 'async', draggable: 'false' });
  const leg = h('span', { class: 'in-leg' });
  const fig = h('div', { class: 'in-fig' }, img, leg);
  const cont = h('div', { class: 'in-sess' }, h('div', { class: 'in-sess-e' }, h('div', { class: 'in-topo' }, total, un), linhas), fig);
  let atual = '';
  return {
    id: 'sessoes', titulo: 'Sessões', hash: '#sessoes', conteudo: cont, esq: 3,
    coletar(e) {
      const ls = [...e.sessoes.values()];
      if (!ls.length) return { tipo: 'vazio', msg: 'Nenhuma sessão ainda. Abra o Claude Code no PC e ela aparece aqui.' };
      const qtd = {};
      for (const s of ls) qtd[s.status] = (qtd[s.status] || 0) + 1;
      const m = maisRelevante(ls);
      return { tipo: 'ok', dados: {
        total: ls.length,
        sts: ORDEM_ST.filter((st) => qtd[st]).map((st) => ({ k: st, n: qtd[st] })),
        sprite: spriteDe(m), quem: m ? nome(m) : '',
      } };
    },
    pintar(d) {
      txt(total, d.total);
      txt(un, d.total === 1 ? 'sessão' : 'sessões');
      lista(linhas, d.sts, (it) => {
        const ponto = h('span', { class: 'in-ponto' }, B.pontoStatus(it.k, 12));
        return h('div', { class: 'in-st', dados: { s: it.k } }, ponto, h('span', { class: 'in-st-rot', text: B.ROTULO_STATUS[it.k] || it.k }), h('b', { class: 'in-st-n num' }));
      }, (e, it) => txt(e.lastElementChild, it.n), true);
      txt(leg, d.quem);
      fig.title = d.quem;
      if (d.sprite !== atual) {
        const primeiro = !atual;
        atual = d.sprite;
        if (OM.sprites) { if (primeiro) OM.sprites.definir(img, d.sprite); else OM.sprites.trocarSprite(img, d.sprite); }
      }
    },
  };
}

// ───────────────────────────── 3. Contexto ─────────────────────────────
const corCtx = (p) => B.corEscala(p, W && W.CTX_ESCALA ? W.CTX_ESCALA : undefined);
function widgetContexto() {
  const sub = h('p', { class: 'in-sub' });
  const itens = h('div', { class: 'in-itens' });
  const cont = h('div', null, sub, itens);
  return {
    id: 'contexto', titulo: 'Contexto', conteudo: cont, esq: 3,
    coletar(e) {
      if (!W) return wFalhou ? { tipo: 'erro', msg: msgErro } : { tipo: 'esq' };
      const ls = [...e.sessoes.values()].filter((s) => s.status !== 'encerrada' && W.contexto(s))
        .map((s) => ({ s, c: W.contexto(s), p: W.ctxPct(s) }))
        .sort((a, b) => b.p - a.p || String(a.s.id).localeCompare(String(b.s.id)));
      if (!ls.length) return { tipo: 'vazio', msg: 'Nenhuma sessão aberta com contexto medido ainda.' };
      return { tipo: 'ok', dados: {
        altos: ls.filter((x) => x.p >= 0.7).length,
        itens: ls.slice(0, 4).map(({ s, c, p }) => ({
          k: String(s.id), hash: hashSessao(s), nome: nome(s), p: c.acima ? 1 : p, acima: c.acima,
          pct: c.acima ? '> 100%' : Math.round(p * 100) + '%',
          meta: W.fmtK(c.tokens) + (c.acima ? ' · limite de ' : ' de ') + W.fmtK(c.limite) + ' tokens',
        })),
      } };
    },
    pintar(d) {
      sub.className = 'in-sub ' + (d.altos ? 'alerta' : 'bom');
      txt(sub, d.altos ? plural(d.altos, 'sessão com 70% ou mais', 'sessões com 70% ou mais') : 'Todas com folga, abaixo de 70%.');
      lista(itens, d.itens, (it) => h('a', { class: 'in-linha toque', href: it.hash, onclick: (ev) => { ev.preventDefault(); OM.rotas.ir(it.hash); } },
        h('span', { class: 'in-l1' }, h('span', { class: 'in-nome' }), h('span', { class: 'in-val num' })), trilho(), h('span', { class: 'in-meta num' })),
      (e, it) => {
        e.setAttribute('href', it.hash);
        const l1 = e.children[0];
        txt(l1.children[0], it.nome);
        txt(l1.children[1], it.pct);
        l1.children[1].style.color = corCtx(it.p);
        pintarTrilho(e.children[1], Math.round(it.p * 100), corCtx(it.p));
        txt(e.children[2], it.meta);
      }, true);
    },
  };
}

// ───────────────────────────── 4. Uso do plano ─────────────────────────────
function widgetUso() {
  const selo = h('span', { class: 'selo in-selo', text: 'Estimado' });
  selo.hidden = true;
  const itens = h('div', { class: 'in-itens' });
  const lido = h('p', { class: 'in-lido' });
  const cont = h('div', null, itens, lido);
  return {
    id: 'uso', titulo: 'Uso do plano', hash: '#mais/uso', extra: selo, conteudo: cont, esq: 3,
    coletar(e) {
      if (!W) return wFalhou ? { tipo: 'erro', msg: msgErro } : { tipo: 'esq' };
      const u = e.uso && (e.uso.cincoHoras || e.uso.semanal) ? e.uso : null;
      if (!u) return { tipo: 'vazio', msg: 'Ainda sem leitura do uso do plano. Ela chega junto com uma instância do Orbit.' };
      const agora = Date.now();
      const t = Number(u.atualizado) || 0;
      const velho = !!t && agora - t > W.USO_VELHO;
      return { tipo: 'ok', dados: {
        velho,
        lido: t ? (agora - t < 60e3 ? 'Lido agora' : 'Lido há ' + W.durRen(agora - t)) : '',
        itens: W.linhasUso(u, agora).map((x) => ({
          k: x.k, rot: x.rot, pct: x.pct, tem: x.tem,
          val: x.pct != null ? x.pct + '%' : '—',
          meta: !x.tem ? 'sem dados' : !x.r ? '' : x.renovou ? 'renovou ' + W.quandoUso(x.r, agora, W.horaPadrao)
            : 'renova em ' + W.durRen(x.r - agora) + ' · ' + W.quandoUso(x.r, agora, W.horaPadrao).replace(/^às /, ''),
        })),
      } };
    },
    pintar(d) {
      selo.hidden = !d.velho;
      lista(itens, d.itens, () => h('div', { class: 'in-item' },
        h('span', { class: 'in-l1' }, h('span', { class: 'in-nome' }), h('span', { class: 'in-val num' })), trilho(), h('span', { class: 'in-meta' })),
      (e, it) => {
        const l1 = e.children[0];
        txt(l1.children[0], it.rot);
        txt(l1.children[1], it.val);
        const barra = e.children[1];
        if (it.pct != null) { barra.hidden = false; pintarTrilho(barra, it.pct, (i) => B.degradeEscala(i, it.pct / 100, W.CTX_ESCALA)); }
        else barra.hidden = true;
        txt(e.children[2], it.meta);
      }, false);
      lido.hidden = !d.lido;
      txt(lido, d.lido);
    },
  };
}

// ───────────────────────────── 5. Sincronização (GET /sincronia, só leitura) ─────────────────────────────
const SINC_ATIVA = false; // Orbit Public: a rota GET /sincronia não existe; o widget fica no código, desligado
const sinc = { dados: undefined, falhou: false, lido: 0, lendo: false };
function widgetSinc() {
  const chip = h('span', { class: 'in-chip' });
  chip.hidden = true;
  const repos = h('div', { class: 'in-itens' });
  const rodape = h('p', { class: 'in-lido' });
  const cont = h('div', null, repos, rodape);
  return {
    id: 'sinc', titulo: 'Sincronização', extra: chip, conteudo: cont, esq: 3,
    coletar() {
      if (!W) return wFalhou ? { tipo: 'erro', msg: msgErro } : { tipo: 'esq' };
      const s = sinc.dados;
      if (s === undefined) return sinc.falhou ? { tipo: 'erro', msg: 'Não deu para ler a sincronização agora.' } : { tipo: 'esq' };
      const rs = s && Array.isArray(s.repos) ? s.repos.filter((r) => r && r.id != null) : [];
      if (!s || !s.ativa || !rs.length) return { tipo: 'vazio', msg: 'A sincronização está desligada neste servidor.' };
      const g = W.estadoSync(rs, !!s.ocupada);
      const ts = rs.map((r) => Date.parse(r.ultimaBusca || '')).filter(Boolean);
      return { tipo: 'ok', dados: {
        tom: g.tom, texto: g.texto,
        repos: rs.map((r) => (r.ausente
          ? { k: String(r.id), nome: r.nome || String(r.id), tom: '', branch: '', n: 'sem git nesta pasta', envio: '' }
          : { k: String(r.id), nome: r.nome || String(r.id), tom: W.tomRepo(r), branch: r.branch || '', n: W.linhaNumeros(r),
            envio: Date.parse(r.ultimoEnvio || '') ? 'enviado ' + W.haQuanto(r.ultimoEnvio) : 'sem envio registrado' })),
        rodape: (ts.length ? 'Buscado ' + W.haQuanto(Math.min(...ts)) : '') + (sinc.falhou ? (ts.length ? ' · ' : '') + 'não atualizou agora' : ''),
      } };
    },
    pintar(d) {
      chip.hidden = false;
      chip.dataset.tom = d.tom;
      txt(chip, d.texto);
      lista(repos, d.repos, () => h('div', { class: 'in-repo' },
        h('span', { class: 'in-repo-l1' }, h('i', { class: 'in-pt' }), h('b', { class: 'in-nome' }), h('code', { class: 'in-branch' })),
        h('span', { class: 'in-meta' }), h('span', { class: 'in-meta' })),
      (e, it) => {
        const l1 = e.children[0];
        l1.children[0].dataset.tom = it.tom;
        txt(l1.children[1], it.nome);
        l1.children[2].hidden = !it.branch;
        txt(l1.children[2], it.branch);
        txt(e.children[1], it.n);
        e.children[2].hidden = !it.envio;
        txt(e.children[2], it.envio);
      }, false);
      rodape.hidden = !d.rodape;
      txt(rodape, d.rodape);
    },
    aoVazio() { chip.hidden = true; },
  };
}

// ───────────────────────────── 6. Resumo do dia ─────────────────────────────
function widgetResumo() {
  const turnos = h('b', { class: 'num' });
  const un = h('span', { class: 'in-un' });
  const sub = h('p', { class: 'in-sub' });
  const par = (rot) => { const v = h('b', { class: 'in-stat-v num' }); return [h('div', { class: 'in-stat' }, h('span', { class: 'in-stat-r', text: rot }), v), v]; };
  const [sT, vT] = par('Trabalhando'), [sA, vA] = par('Aguardando'), [sE, vE] = par('Esperas');
  const cont = h('div', null, h('div', { class: 'in-topo' }, turnos, un), sub, h('div', { class: 'in-stats' }, sT, sA, sE));
  const n = (v) => Math.max(0, Number(v) || 0);
  return {
    id: 'resumo', titulo: 'Resumo do dia', conteudo: cont, esq: 3,
    coletar(e) {
      const r = e.resumoDia;
      if (!r || typeof r !== 'object' || (!n(r.turnos) && !n(r.msTrabalhando) && !n(r.esperas))) return { tipo: 'vazio', msg: 'Nada por hoje ainda. Os números aparecem com o primeiro turno.' };
      return { tipo: 'ok', dados: { turnos: n(r.turnos), sessoes: n(r.sessoes), trab: OM.fmt.duracao(n(r.msTrabalhando)), agu: OM.fmt.duracao(n(r.msAguardando)), esperas: n(r.esperas) } };
    },
    pintar(d) {
      txt(turnos, d.turnos);
      txt(un, d.turnos === 1 ? 'turno hoje' : 'turnos hoje');
      txt(sub, 'em ' + plural(d.sessoes, 'sessão', 'sessões'));
      txt(vT, d.trab); txt(vA, d.agu); txt(vE, d.esperas);
    },
  };
}

// ───────────────────────────── a tela ─────────────────────────────
OM.telas.registrar('inicio', {
  titulo: 'Início',
  tituloGrande: true,
  montar(cont, params, ctx) {
    const defs = [widgetPrecisa(), widgetSessoes(), widgetContexto(), widgetUso(), widgetResumo()]; // Orbit Public: sem o card Sincronização (não há sincronia do próprio Orbit)
    const ws = defs.map((d, i) => criarWidget(d, i));
    const raiz = h('div', { class: 'in-lista' }, ...ws.map((w) => w.el));
    cont.append(raiz);
    for (const w of ws) { if (w.def.oculto) { w.visivel = false; w.el.hidden = true; } aplicarTipo(w, 'esq'); }
    ctx.inicio = { ws, raiz, timer: 0, offs: [], visivel: false, lendo: 0 };
    const I = ctx.inicio;

    const carregado = (e) => e.conexao !== 'conectando' || e.sessoes.size > 0 || !!e.resumoDia || !!e.uso;
    const velho = (e) => e.conexao === 'pc' || e.conexao === 'offline';
    const pintarTudo = (e) => {
      e = e || OM.estado;
      raiz.classList.toggle('velho', velho(e));
      if (!carregado(e)) { for (const w of ws) if (w.tipo !== 'esq') { w.sig = ''; aplicarTipo(w, 'esq'); } return; }
      for (const w of ws) rodar(w, e);
    };
    I.pintar = pintarTudo;

    async function lerSinc() {
      if (!SINC_ATIVA || sinc.lendo || velho(OM.estado) || OM.estado.modo !== 'app') return;
      sinc.lendo = true;
      try {
        const d = await OM.api('GET', '/sincronia');
        sinc.dados = d && typeof d === 'object' ? d : null;
        sinc.falhou = false;
        sinc.lido = Date.now();
      } catch {
        sinc.falhou = true;
      } finally { sinc.lendo = false; }
      if (I.vivo) pintarTudo();
    }
    I.lerSinc = lerSinc;
    I.vivo = true;

    // Puxar para atualizar: recarrega o /estado e a sincronização; os widgets se repintam sozinhos pelo evento de estado.
    I.offs.push(OM.gestos.puxar(ctx.corpo, async () => { await Promise.all([OM.recarregar(), lerSinc()]); pintarTudo(); }));
    if (OM.sprites && OM.sprites.ligar) I.offs.push(OM.sprites.ligar(raiz));
    I.offs.push(OM.ouvir('conexao', (c) => {
      if (I.vivo) raiz.classList.toggle('velho', velho(OM.estado));
      if (c === 'vivo' && I.visivel) lerSinc();
    }));

    W = window.OrbitWidgets || null;
    wFalhou = !W;
    pintarTudo();
  },
  mostrar(ctx) {
    const I = ctx.inicio;
    if (!I) return;
    I.visivel = true;
    I.pintar();
    I.lerSinc();
    clearInterval(I.timer);
    // Relógio leve: refaz os textos de tempo ("renova em", "há 5 min") e relê a sincronização; só pinta o que mudou.
    let tick = 0;
    I.timer = setInterval(() => { if (doc.hidden) return; I.pintar(); if (++tick % 3 === 0 && !doc.hidden) I.lerSinc(); }, 20e3);
  },
  esconder(ctx) {
    const I = ctx.inicio;
    if (!I) return;
    I.visivel = false;
    clearInterval(I.timer);
    I.timer = 0;
  },
  atualizar(estado, ctx) {
    const I = ctx && ctx.inicio;
    if (I) I.pintar(estado);
  },
  desmontar(ctx) {
    const I = ctx.inicio;
    if (!I) return;
    I.vivo = false;
    clearInterval(I.timer);
    for (const off of I.offs) { try { off(); } catch {} }
    ctx.inicio = null;
  },
});
})();
