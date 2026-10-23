// Orbit no celular: tela Aprovações (onda 3). Todas as permissões, perguntas e planos que esperam resposta, de todas as
// sessões, agrupados por sessão e do mais antigo ao mais novo. Os cartões vêm de assets/comum/cartoes.js (OM.cartoes) e o
// visual de cartoes.css. API da casca: contrato, "App do celular". Sem innerHTML e sem nada inline (CSP).
//
// Fonte: cada sessão traz só o pedido da FRENTE da fila (controle.permissao) e quantos há (controle.pendentes, via
// OM.pendentesDe). Respondido o da frente, o servidor manda a sessão de novo com o próximo; ele entra aqui sozinho.
(() => {
'use strict';
const OM = (window.OM = window.OM || {});
const h = (...a) => OM.h(...a);

const TEMPO = 300;                 // entrar/sair/mover (ms), a mesma duração do empurrar de tela
const TEMPO_REDUZIDO = 120;        // movimento reduzido: só opacidade
const FALLBACK_EASE = 'cubic-bezier(.23, 1, .32, 1)';
const limpo = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

OM.telas.registrar('aprovacoes', {
  titulo: 'Aprovações',
  tituloGrande: true,

  montar(cont, params, ctx) {
    const grupos = new Map();        // sessão → { sid, el, cab, img, tit, sub, itens, mapa: Map(pid → entrada), saindo }
    const entradas = new Map();      // pid → { pid, sid, wrap, cartao, saindo }
    const respondidos = new Set();   // pids que eu respondi e o estado ainda pode mostrar (até o servidor confirmar)
    const visto = new Map();         // pid → ms da 1ª vez que apareceu (desempate quando a sessão não traz "desde")
    let visivel = false;             // só anima com a tela à vista
    let primeira = true;             // a 1ª montagem aparece pronta, sem animar
    let ultimoAviso = '';
    let timerTempo = 0;
    const offs = [];

    const reduzido = () => !!(OM.reduzido && OM.reduzido());
    const ease = () => (OM.cssVar ? OM.cssVar('--ease-press', FALLBACK_EASE) : FALLBACK_EASE);
    const sprite = (chave, padrao) => { const l = OM.base && OM.base.SPRITE && OM.base.SPRITE[chave]; return (l && l[0]) || padrao; };

    // ───────────── esqueleto da tela ─────────────
    const lista = h('div', { class: 'ap-lista' });
    const carregando = h('div', { class: 'ap-carregando', 'aria-hidden': 'true' },
      h('span', { class: 'esq' }), h('span', { class: 'esq' }));
    const vazioImg = h('img', { class: 'ap-vazio-spr', alt: '', width: 96, height: 96, decoding: 'async' });
    const vazioSub = h('p', null, '');
    const vazio = h('div', { class: 'ap-vazio', role: 'status', hidden: true }, vazioImg, h('strong', null, 'Nada esperando você'), vazioSub);
    const aviso = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    const raiz = h('div', { class: 'ap' }, aviso, lista, carregando, vazio);
    cont.replaceChildren(raiz);
    definirSprite(vazioImg, sprite('dormindo', 'sprites/sprite-sleep'));
    if (OM.sprites && OM.sprites.ligar) offs.push(OM.sprites.ligar(raiz));
    if (OM.gestos && OM.gestos.puxar) offs.push(OM.gestos.puxar(ctx.corpo, async () => { try { await OM.recarregar(); } catch {} }));

    function definirSprite(img, nome) {
      if (OM.sprites && OM.sprites.definir) OM.sprites.definir(img, nome);
      else { img.dataset.gif = nome; img.src = '/assets/' + nome + (/-parado$/.test(nome) ? '.png' : '.gif'); }
    }

    // ───────────── animações (WAAPI: só transform e opacity) ─────────────
    // FLIP: guarda onde cada grupo (na lista) e cada pedido (no grupo) está, deixa `mudar` mexer no DOM e anima o que se deslocou.
    function topo(el, pai) { return el.getBoundingClientRect().top - pai.getBoundingClientRect().top; }
    function fliplar(mudar) {
      const anima = visivel && !primeira && !reduzido() && typeof Element.prototype.animate === 'function';
      const antes = [];
      if (anima) {
        for (const g of grupos.values()) {
          if (g.saindo) continue;
          antes.push([g.el, topo(g.el, lista), lista]);
          for (const e of g.mapa.values()) if (!e.saindo) antes.push([e.wrap, topo(e.wrap, g.el), g.el]);
        }
      }
      mudar();
      if (!anima) return;
      const opc = { duration: TEMPO, easing: ease() };
      for (const [el, y0, pai] of antes) {
        if (!el.isConnected || el.classList.contains('ap-saindo')) continue;
        const d = y0 - topo(el, pai);
        if (Math.abs(d) > 1) el.animate([{ transform: 'translateY(' + d.toFixed(1) + 'px)' }, { transform: 'translateY(0)' }], opc);
      }
    }
    function entrar(el) {
      if (!visivel || primeira || typeof el.animate !== 'function') return;
      if (reduzido()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TEMPO_REDUZIDO, easing: 'ease-out' });
      else el.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: TEMPO, easing: ease() });
    }
    // Sai com opacidade e escala; quem está embaixo sobe pelo FLIP de `fim`. Movimento reduzido: só some.
    function sair(el, depois) {
      if (el.classList.contains('ap-saindo')) return;
      const eraFoco = el.contains(document.activeElement);
      el.classList.add('ap-saindo');
      el.setAttribute('aria-hidden', 'true');
      // Ao remover, o FLIP dos irmãos mede antes e anima só transform (sem animar altura nem padding).
      const fim = () => fliplar(() => { if (el.isConnected) el.remove(); if (depois) depois(); });
      if (eraFoco) { try { ctx.tela.focus({ preventScroll: true }); } catch {} }
      const altura = el.offsetHeight;
      if (!visivel || !altura || typeof el.animate !== 'function') { fim(); return; }
      let acabou = false;
      const terminar = () => { if (acabou) return; acabou = true; fim(); };
      let a;
      if (reduzido()) a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TEMPO_REDUZIDO, easing: 'ease-out', fill: 'forwards' });
      else a = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
        { duration: 200, easing: OM.cssVar ? OM.cssVar('--ease-saida', 'cubic-bezier(.4,0,1,1)') : 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
      a.onfinish = terminar;
      setTimeout(terminar, 450);   // aba escondida pode segurar a animação
    }

    // ───────────── dados ─────────────
    const nomeSessao = (s) => (OM.fmt && OM.fmt.titulo ? OM.fmt.titulo(s) : limpo(s.apelido) || limpo(s.titulo) || 'Sessão');
    const nomeProjeto = (s) => (OM.fmt && OM.fmt.projeto ? OM.fmt.projeto(s) : limpo(s.projeto) || 'Sem projeto');
    const desdeDe = (s) => Number(s && s.desde) || Number(s && s.atividade) || 0;
    function pedidos() {
      const todos = [];
      for (const s of OM.estado.sessoes.values()) {
        const p = s && s.controle && s.controle.permissao;
        if (!p || p.id == null || !OM.pendentesDe(s)) continue;
        const pid = String(p.id);
        if (!visto.has(pid)) visto.set(pid, Date.now());
        todos.push({ sid: String(s.id), s, p, pid, n: OM.pendentesDe(s), desde: desdeDe(s) || visto.get(pid) });
      }
      todos.sort((a, b) => a.desde - b.desde || (visto.get(a.pid) - visto.get(b.pid)) || (a.sid < b.sid ? -1 : 1));
      return todos;
    }
    function textoTempo(s) {
      const d = desdeDe(s);
      if (!d || !OM.fmt) return '';
      const t = OM.fmt.tempo(d);
      return t === 'agora' ? 'agora há pouco' : 'há ' + t;
    }
    function textoSub(s) {
      const t = textoTempo(s);
      return nomeProjeto(s) + (t ? ' · ' + t : '');
    }

    // ───────────── DOM ─────────────
    function apiDe(sid) {
      return {
        responder: (corpo) => OM.api('POST', '/sessao/' + encodeURIComponent(sid) + '/permissao', corpo),
        icone: (nome, tam) => OM.icone(nome, tam),
        md: (texto) => OM.md(texto),
        toast: (texto) => { if (texto) OM.toast(texto); },
        confirmar: (texto) => (OM.confirmar ? OM.confirmar(texto) : Promise.resolve(true)),
      };
    }
    function criarGrupo(d) {
      const img = h('img', { alt: '', width: 44, height: 44, decoding: 'async' });
      definirSprite(img, sprite('precisa', 'sprites/sprite-needu'));
      const tit = h('span', { class: 'ap-tit' });
      const sub = h('span', { class: 'ap-sub' });
      const hash = '#s=' + encodeURIComponent(d.sid);
      const cab = h('a', { class: 'ap-cab toque', href: hash }, h('span', { class: 'ap-spr', 'aria-hidden': 'true' }, img),
        h('span', { class: 'ap-txt' }, tit, sub), h('span', { class: 'ap-seta', 'aria-hidden': 'true' }, OM.icone('chevron', 18)));
      cab.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        ctx.ir(hash);
      });
      const itens = h('div', { class: 'ap-itens' });
      const el = h('section', { class: 'ap-grupo', dados: { sessao: d.sid } }, cab, itens);
      const g = { sid: d.sid, el, cab, img, tit, sub, itens, mapa: new Map(), saindo: false };
      grupos.set(d.sid, g);
      return g;
    }
    function atualizarCab(g, s) {
      OM.txt(g.tit, nomeSessao(s));
      OM.txt(g.sub, textoSub(s));
      g.cab.setAttribute('aria-label', 'Abrir a conversa: ' + nomeSessao(s) + ', ' + textoSub(s));
    }
    function criarEntrada(g, d) {
      const wrap = h('div', { class: 'ap-item', dados: { pedido: d.pid } });
      const cartao = OM.cartoes.cartao(d.p, apiDe(d.sid), {
        fila: Math.max(0, d.n - 1),
        aoResponder: () => { respondidos.add(d.pid); remover(d.pid); },
      });
      wrap.append(cartao);
      const e = { pid: d.pid, sid: d.sid, wrap, cartao, saindo: false };
      entradas.set(d.pid, e);
      g.mapa.set(d.pid, e);
      return e;
    }
    function remover(pid) {
      const e = entradas.get(pid);
      if (!e || e.saindo) return;
      e.saindo = true;
      const g = grupos.get(e.sid);
      const ultimo = !!g && !g.saindo && [...g.mapa.values()].every((x) => x === e || x.saindo);
      const limpar = () => {
        if (entradas.get(pid) === e) entradas.delete(pid);
        if (g && g.mapa.get(pid) === e) g.mapa.delete(pid);
        resumir();
      };
      if (ultimo) { g.saindo = true; grupos.delete(g.sid); sair(g.el, limpar); }   // o último pedido leva o grupo junto
      else sair(e.wrap, limpar);
      resumir();
    }

    // ───────────── reconciliação ─────────────
    // Próximo irmão que não está saindo (mover um nó que já está bem posicionado perderia foco e animação).
    const vivo = (no) => { while (no && no.classList && no.classList.contains('ap-saindo')) no = no.nextSibling; return no; };
    function reconciliar() {
      const lista_ = pedidos();
      const novos = new Set(lista_.map((d) => d.pid));
      // o que eu já respondi some do "respondidos" quando o servidor deixa de mostrar
      for (const pid of respondidos) if (!novos.has(pid)) respondidos.delete(pid);
      for (const pid of visto.keys()) if (!novos.has(pid) && !entradas.has(pid)) visto.delete(pid);
      const desejados = lista_.filter((d) => !respondidos.has(d.pid));
      const quer = new Set(desejados.map((d) => d.pid));
      fliplar(() => {
        for (const e of [...entradas.values()]) if (!e.saindo && !quer.has(e.pid)) remover(e.pid);
        let anterior = null;
        for (const d of desejados) {
          let g = grupos.get(d.sid);
          let novoGrupo = false;
          if (!g || g.saindo) { g = criarGrupo(d); novoGrupo = true; }
          atualizarCab(g, d.s);
          let e = entradas.get(d.pid);
          if (!e || e.saindo) {
            e = criarEntrada(g, d);
            g.itens.append(e.wrap);
            if (!novoGrupo) entrar(e.wrap);
          } else {
            if (e.cartao.atualizarFila) e.cartao.atualizarFila(Math.max(0, d.n - 1));
          }
          // ordem dos grupos: mais antigo em cima
          const alvo = vivo(anterior ? anterior.nextSibling : lista.firstChild);
          if (g.el !== alvo) lista.insertBefore(g.el, alvo);
          if (novoGrupo) entrar(g.el);
          anterior = g.el;
        }
      });
      resumir();
    }

    // Vazio, carregando e aviso para leitor de tela.
    function resumir() {
      const vivos = [...entradas.values()].filter((e) => !e.saindo).length;
      const saindo = [...entradas.values()].some((e) => e.saindo);
      const conexao = OM.estado.conexao;
      const semDados = !OM.estado.sessoes.size && (conexao === 'conectando' || OM.estado.modo !== 'app');
      carregando.hidden = !(semDados && !vivos);
      const mostrarVazio = !vivos && !saindo && !semDados;
      vazio.hidden = !mostrarVazio;
      if (mostrarVazio) {
        const sem = conexao !== 'vivo';
        OM.txt(vazioSub, sem ? 'Sem conexão com o PC agora. A lista volta sozinha quando a conexão voltar.' : 'Quando um agente pedir permissão, fizer uma pergunta ou propor um plano, aparece aqui.');
      }
      const msg = vivos ? (vivos === 1 ? '1 pedido esperando você' : vivos + ' pedidos esperando você') : mostrarVazio ? 'Nada esperando você' : '';
      if (msg !== ultimoAviso) { ultimoAviso = msg; OM.txt(aviso, msg); }
    }

    function atualizarTempos() {
      for (const g of grupos.values()) {
        const s = OM.estado.sessoes.get(g.sid);
        if (s && !g.saindo) OM.txt(g.sub, textoSub(s));
      }
    }

    offs.push(OM.ouvir('conexao', () => { if (visivel) resumir(); }));

    // Ganchos para a tela (ficam no ctx para mostrar/atualizar/esconder/desmontar).
    ctx._ap = {
      reconciliar, atualizarTempos,
      mostrar() {
        visivel = true;
        primeira = true;            // o que mudou enquanto a tela estava escondida entra pronto, sem animar
        reconciliar();
        primeira = false;
        if (OM.sprites && OM.sprites.atualizar) OM.sprites.atualizar(raiz);
        clearInterval(timerTempo);
        timerTempo = setInterval(() => { if (!document.hidden) atualizarTempos(); }, 30000);
      },
      esconder() { visivel = false; clearInterval(timerTempo); timerTempo = 0; },
      desmontar() {
        visivel = false;
        clearInterval(timerTempo);
        for (const off of offs.splice(0)) { try { off(); } catch {} }
        grupos.clear(); entradas.clear();
      },
    };
    reconciliar();
    primeira = false;
  },

  mostrar(ctx) { if (ctx._ap) ctx._ap.mostrar(); },
  esconder(ctx) { if (ctx._ap) ctx._ap.esconder(); },
  atualizar(estado, ctx) { if (ctx._ap) ctx._ap.reconciliar(); },
  desmontar(ctx) { if (ctx._ap) { ctx._ap.desmontar(); ctx._ap = null; } },
});
})();
