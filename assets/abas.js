// Orbit — abas e painéis em grade (lado a lado e empilhados) na área principal, no estilo do VS Code (rodada 9).
// Rodada 9 — Abas e painéis na área principal. Expõe window.Abas.
// Sem dependências. Nada de innerHTML com dado: títulos, dicas e caminhos entram por textContent/atributos.
(() => {
  'use strict';

  const MAX_GRUPOS = 4;
  // No Mac o ⌫ faz o papel do Delete (o teclado do Mac não tem Delete à parte) (16/10).
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const MIN_PX = 240;       // largura mínima de um grupo ao redimensionar
  const MIN_ALT = 140;      // altura mínima de um grupo ao redimensionar (painéis empilhados)
  const LIMIAR = 4;         // px até um pointerdown virar arraste
  const SELOS = ['novo', 'atencao'];
  const NS = 'http://www.w3.org/2000/svg';
  // Logo do Orbit ao lado deste script (assets/logo.png), para o estado vazio padrão.
  const LOGO = (() => { try { return new URL('logo.png', document.currentScript.src).href; } catch { return ''; } })();

  let seqAba = 0;
  let seqGrupo = 0;
  let S = null; // estado do layout montado

  // ───────────────────────── utilidades ─────────────────────────
  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  // Ícones fixos do módulo (traços constantes, nunca dado).
  function icone(nome, tam = 16) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', tam); s.setAttribute('height', tam); s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.3');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('aria-hidden', 'true');
    const d = {
      x: ['M4.5 4.5l7 7M11.5 4.5l-7 7'],
      dividir: ['M2.5 3.5h11v9h-11z', 'M8 3.5v9'],
      mais: [],
    }[nome] || [];
    for (const c of d) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', c); s.appendChild(p); }
    if (nome === 'mais') for (const cx of [4, 8, 12]) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', 8); c.setAttribute('r', 1); c.setAttribute('fill', 'currentColor'); c.setAttribute('stroke', 'none');
      s.appendChild(c);
    }
    return s;
  }
  const limitar = (v, a, b) => Math.max(a, Math.min(b, v));
  const copiar = (v) => { try { return structuredClone(v); } catch { try { return JSON.parse(JSON.stringify(v)); } catch { return v; } } };
  // Chamada protegida a um provedor/instância: um erro lá não pode quebrar o layout.
  function chamar(fn, ctx, ...args) {
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(ctx, args); } catch (e) { console.error('[Abas]', e); return undefined; }
  }
  const prov = (a) => S.tipos[a.tipo] || {};
  const achar = (id) => (id && S ? S.mapa.get(id) || null : null);
  const grupoPorId = (id) => S.grupos.find((g) => g.id === id) || null;

  // Objeto público da aba (o mesmo objeto vive enquanto a aba existe; o provedor recebe este em criar()).
  function pub(a) {
    if (!a) return null;
    const p = a.pub;
    p.id = a.id; p.tipo = a.tipo; p.chave = a.chave; p.dados = a.dados; p.previa = a.previa; p.selo = a.selo; p.grupo = a.g ? a.g.id : null;
    return p;
  }

  // Operações públicas passam por aqui: ao fim da mais externa, persiste e avisa os ganchos uma vez só.
  // A mais externa também fotografa as abas antes e anima a diferença depois (só visual, ver "movimento").
  let prof = 0;
  function op(fn) {
    if (!S) return undefined;
    const dono = !prof && !S.flip;
    if (dono) S.flip = foto();
    prof++;
    try { return fn(); } finally {
      if (--prof === 0) {
        notificar();
        if (dono && S) { const f = S.flip; S.flip = null; animar(f); }
      }
    }
  }

  // ───────────────────────── movimento ─────────────────────────
  // Camada só visual (FLIP): nada aqui muda o estado das abas. Respeita o "reduzir movimento" do sistema.
  const CURVA = 'cubic-bezier(.2, .8, .2, 1)';
  const mqMov = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function animavel() {
    return !!S && !(mqMov && mqMov.matches) && !document.hidden && typeof Element.prototype.animate === 'function';
  }
  // Animação marcada como nossa: só as nossas são canceladas/encerradas (as do provedor ficam).
  function anim(n, quadros, ms) {
    try {
      for (const x of n.getAnimations()) if (x.id === 'abas') x.cancel();
      const k = n.animate(quadros, { duration: ms, easing: CURVA });
      k.id = 'abas';
      return k;
    } catch { return null; }
  }
  function encerrarAnimacoes() {
    if (!S || typeof Element.prototype.getAnimations !== 'function') return;
    for (const g of S.grupos) for (const a of g.abas) for (const x of a.el.getAnimations()) if (x.id === 'abas') x.finish();
  }
  // Onde cada aba está na tela agora (com deslocamentos de arraste e animações em curso).
  function foto() {
    if (!animavel()) return null;
    const m = new Map(), ativas = new Map();
    for (const g of S.grupos) {
      ativas.set(g, g.ativa);
      for (const a of g.abas) m.set(a.el, { r: a.el.getBoundingClientRect(), lista: g.lista, a, x: a.el.offsetLeft, w: a.el.offsetWidth, ativa: a.id === g.ativa });
    }
    return { m, ativas };
  }
  function animar(f) {
    if (!f || !animavel()) return;
    const vivos = new Set();
    for (const g of S.grupos) {
      const grupoNovo = !f.ativas.has(g);
      if (grupoNovo) anim(g.el, [{ opacity: 0 }, { opacity: 1 }], 200);
      else if (g.ativa && g.ativa !== f.ativas.get(g)) { const at = achar(g.ativa); if (at) anim(at.painel, [{ opacity: 0.35 }, { opacity: 1 }], 150); }
      for (const a of g.abas) {
        vivos.add(a.el);
        if (grupoNovo) continue;
        const ant = f.m.get(a.el), r = a.el.getBoundingClientRect();
        const dx = ant ? ant.r.left - r.left : 0, dy = ant ? ant.r.top - r.top : 0;
        // Aba nova (ou vinda de longe): surge no lugar; as vizinhas deslizam abrindo espaço.
        if (!ant || (ant.lista !== g.lista && !ant.voo) || Math.abs(dy) > r.height) {
          anim(a.el, [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], 170);
          continue;
        }
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        anim(a.el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], 210);
      }
    }
    for (const [n, ant] of f.m) if (!vivos.has(n) && !n.isConnected && ant.lista.isConnected) sair(ant);
  }
  // Aba fechada: um reflexo dela some no lugar enquanto as vizinhas ocupam o espaço.
  function sair(ant) {
    const n = el('div', 'abas-sai' + (ant.ativa ? ' ativa' : ''), { 'aria-hidden': 'true' });
    n.style.left = ant.x + 'px';
    n.style.width = ant.w + 'px';
    n.append(ant.a.ic.cloneNode(true), ant.a.tit.cloneNode(true));
    ant.lista.appendChild(n);
    const k = anim(n, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], 140);
    if (k) k.onfinish = k.oncancel = () => n.remove(); else n.remove();
  }
  function notificar() {
    if (!S) return;
    marcarFoco();
    salvar();
    chamar(S.ganchos.mudou, S.ganchos, estado());
    const a = S.foco && achar(S.foco.ativa);
    const k = (S.foco ? S.foco.id : '') + '|' + (a ? a.id : '');
    if (k !== S.ultFoco) { S.ultFoco = k; chamar(S.ganchos.focoMudou, S.ganchos, pub(a)); }
  }
  function toast(t) { chamar(S.ganchos.toast, S.ganchos, t); }

  // ───────────────────────── persistência ─────────────────────────
  function estado() {
    return {
      v: 1,
      grupos: S.grupos.map((g) => ({
        abas: g.abas.map((a) => ({ tipo: a.tipo, chave: a.chave, dados: a.dados === undefined ? null : a.dados, previa: !!a.previa })),
        ativa: Math.max(0, g.abas.findIndex((a) => a.id === g.ativa)),
        tamanho: g.tamanho,
      })),
      foco: Math.max(0, S.grupos.indexOf(S.foco)),
      arvore: salvarArvore(S.arvore),
    };
  }
  // Grade em árvore: folha = índice em `grupos`; ramo = { d: 'linha' | 'coluna', t: tamanho, f: filhos }.
  function salvarArvore(n) {
    if (!ehRamo(n)) return { g: S.grupos.indexOf(n) };
    return { d: n.dir, t: n.tamanho, f: n.filhos.map(salvarArvore) };
  }
  // Remonta a grade salva com os grupos que voltaram (porOrig: índice salvo → grupo). Inválida → null.
  function lerArvore(no, porOrig, total) {
    const usados = new Set();
    const construir = (x) => {
      if (!x || typeof x !== 'object') return null;
      if (Number.isInteger(x.g)) {
        const g = porOrig.get(x.g);
        if (!g || usados.has(g)) return null;
        usados.add(g);
        return g;
      }
      if ((x.d !== 'linha' && x.d !== 'coluna') || !Array.isArray(x.f)) return null;
      const r = novoRamo(x.d);
      r.tamanho = Number(x.t) > 0 ? Number(x.t) : 0;
      for (const y of x.f) { const c = construir(y); if (c) { c.pai = r; r.filhos.push(c); } }
      return r.filhos.length ? r : null;
    };
    const raiz = construir(no);
    if (!raiz || usados.size !== total) return null;
    const a = arrumar(raiz);
    a.pai = null;
    return a;
  }
  function salvar() {
    if (!S.chave) return;
    try { localStorage.setItem(S.chave, JSON.stringify(estado())); } catch {}
  }
  function ler() {
    try {
      const j = JSON.parse(localStorage.getItem(S.chave) || 'null');
      return j && j.v === 1 && Array.isArray(j.grupos) ? j : null;
    } catch { return null; }
  }

  // ───────────────────────── grupos ─────────────────────────
  // Grade em árvore, como no VS Code: um ramo é uma linha (filhos lado a lado) ou uma coluna (filhos
  // empilhados); as folhas são os grupos. `tamanho` é a fração do nó dentro do ramo pai. S.grupos guarda
  // as folhas na ordem da árvore (Ctrl+1–4, API, persistência). Todos os grupos e divisórias ficam na raiz,
  // posicionados por fração: dividir ou fechar nunca tira um painel do lugar no documento (isso zeraria a
  // rolagem e recarregaria iframes).
  const ehRamo = (n) => !!(n && n.ramo);
  function novoRamo(dir) { return { ramo: true, dir, filhos: [], pai: null, tamanho: 1, sep: null, r: null }; }
  function folhas(n = S.arvore, out = []) {
    if (ehRamo(n)) for (const f of n.filhos) folhas(f, out);
    else if (n) out.push(n);
    return out;
  }
  // Ramo com um filho só cede o lugar a ele; ramo dentro de ramo da mesma direção se funde ao pai.
  function arrumar(n) {
    if (!ehRamo(n)) return n;
    const fs = [];
    for (const c0 of n.filhos) {
      const c = arrumar(c0);
      if (ehRamo(c) && c.dir === n.dir) {
        const s = c.filhos.reduce((t, x) => t + (x.tamanho > 0 ? x.tamanho : 0), 0) || 1;
        for (const x of c.filhos) { x.tamanho = (x.tamanho > 0 ? x.tamanho : 0) / s * c.tamanho; fs.push(x); }
      } else fs.push(c);
    }
    n.filhos = fs;
    for (const c of fs) c.pai = n;
    if (fs.length === 1) { fs[0].tamanho = n.tamanho; fs[0].pai = n.pai; return fs[0]; }
    return n;
  }

  function criarGrupo() {
    const g = { id: 'aba-g' + (++seqGrupo), abas: [], ativa: null, mru: [], tamanho: 1, sep: null, pai: null, r: null };
    g.el = el('section', 'abas-grupo', { 'data-grupo': g.id });
    g.barra = el('div', 'abas-barra');
    g.lista = el('div', 'abas-lista', { role: 'tablist', 'aria-orientation': 'horizontal' });
    g.ins = el('div', 'abas-ins', { 'aria-hidden': 'true' });
    const acoes = el('div', 'abas-acoes');
    g.btnDiv = el('button', 'abas-btn', { type: 'button', title: 'Dividir à direita', 'aria-label': 'Dividir à direita' });
    g.btnDiv.appendChild(icone('dividir'));
    g.btnMais = el('button', 'abas-btn', { type: 'button', title: 'Mais ações', 'aria-label': 'Mais ações', 'aria-haspopup': 'menu' });
    g.btnMais.appendChild(icone('mais'));
    acoes.append(g.btnDiv, g.btnMais);
    g.barra.append(g.lista, g.ins, acoes);
    g.corpo = el('div', 'abas-corpo');
    g.zona = el('div', 'abas-zona', { 'aria-hidden': 'true' });
    g.corpo.appendChild(g.zona);
    g.el.append(g.barra, g.corpo);

    // Foco do grupo: pointerdown ou foco dentro dele.
    g.el.addEventListener('pointerdown', () => { if (S && S.foco !== g) op(() => { S.foco = g; }); }, true);
    g.el.addEventListener('focusin', () => { if (S && S.foco !== g) op(() => { S.foco = g; }); });
    g.btnDiv.addEventListener('click', () => { const a = achar(g.ativa); if (a) api.dividir(a.id, 'direita'); });
    g.btnMais.addEventListener('click', () => {
      const r = g.btnMais.getBoundingClientRect();
      abrirMenu([{ rot: 'Fechar todas', off: !g.abas.length, acao: () => api.fecharTodas(g.id) }], r.right, r.bottom + 4, g.btnMais, true);
    });
    // Roda do mouse rola a barra na horizontal.
    g.lista.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || g.lista.scrollWidth <= g.lista.clientWidth) return;
      e.preventDefault();
      g.lista.scrollLeft += e.deltaY;
    }, { passive: false });
    // A ativa continua à vista quando a barra muda de largura (janela, divisória).
    if (window.ResizeObserver) { g.ro = new ResizeObserver(() => { const a = S && achar(g.ativa); if (a && a.g === g) aVista(a); }); g.ro.observe(g.lista); }
    return g;
  }

  // Novo grupo ao lado de `ref` ('esquerda' | 'direita' | 'cima' | 'baixo'), tomando metade do tamanho dele.
  // Se o ramo de `ref` corre na outra direção, `ref` vira um ramo novo com os dois.
  function novoGrupo(ref, lado = 'direita') {
    if (S.grupos.length >= MAX_GRUPOS) return null;
    ref = ref || S.foco || S.grupos[0];
    const dir = lado === 'cima' || lado === 'baixo' ? 'coluna' : 'linha';
    const antes = lado === 'esquerda' || lado === 'cima';
    let p = ref.pai;
    if (!p || p.dir !== dir) {
      const r = novoRamo(dir);
      r.tamanho = ref.tamanho; r.pai = p;
      if (p) p.filhos[p.filhos.indexOf(ref)] = r; else S.arvore = r;
      ref.pai = r; ref.tamanho = 1;
      r.filhos.push(ref);
      p = r;
    }
    const g = criarGrupo();
    g.pai = p;
    g.tamanho = ref.tamanho / 2; ref.tamanho /= 2;
    const i = p.filhos.indexOf(ref);
    p.filhos.splice(antes ? i : i + 1, 0, g);
    layout();
    return g;
  }

  function removerGrupo(g) {
    const p = g.pai;
    if (!p || S.grupos.length < 2) return;
    const i = p.filhos.indexOf(g);
    if (i < 0) return;
    const viz = p.filhos[i - 1] || p.filhos[i + 1];
    viz.tamanho += g.tamanho;
    p.filhos.splice(i, 1);
    if (g.sep) { g.sep.remove(); g.sep = null; }
    if (g.ro) g.ro.disconnect();
    g.el.remove();
    g.pai = null;
    if (S.foco === g) { const fv = folhas(viz); S.foco = p.filhos.indexOf(viz) < i ? fv[fv.length - 1] : fv[0]; }
    S.arvore = arrumar(S.arvore);
    S.arvore.pai = null;
    layout();
  }
  function talvezRemoverGrupo(g) { if (!g.abas.length && S.grupos.length > 1) removerGrupo(g); else layout(); }

  // Liga a árvore ao documento: divisórias certas em cada ramo, grupos e divisórias na raiz (sem mexer em
  // quem já está no lugar), posições e estado vazio.
  function layout() {
    S.arvore.pai = null;
    S.grupos = folhas();
    const seps = [];
    const varrer = (n, k) => {
      if (!n.pai || k === 0) { if (n.sep) { n.sep.remove(); n.sep = null; } }
      else {
        if (!n.sep) n.sep = criarDivisoria();
        const deLado = n.pai.dir === 'linha';
        n.sep.no = n;
        n.sep.classList.toggle('deitada', !deLado);
        n.sep.setAttribute('aria-orientation', deLado ? 'vertical' : 'horizontal');
        seps.push(n.sep);
      }
      if (ehRamo(n)) n.filhos.forEach((c, i) => { c.pai = n; varrer(c, i); });
    };
    varrer(S.arvore, 0);
    const quer = [...S.grupos.map((g) => g.el), ...seps];
    quer.forEach((n, k) => { const atual = S.raiz.children[k]; if (atual !== n) S.raiz.insertBefore(n, atual || null); });
    while (S.raiz.children.length > quer.length) S.raiz.lastElementChild.remove();
    S.grupos.forEach((g, i) => g.lista.setAttribute('aria-label', S.grupos.length > 1 ? `Abas do painel ${i + 1}` : 'Abas'));
    posicionar();
    // Estado vazio: só no último grupo que restou, sem abas.
    const vazio = S.grupos.length === 1 && !S.grupos[0].abas.length;
    const g0 = S.grupos[0];
    g0.el.classList.toggle('vazio', vazio);
    if (vazio && !g0.vazioEl) {
      g0.vazioEl = el('div', 'abas-vazio');
      if (typeof S.ganchos.vazio === 'function') chamar(S.ganchos.vazio, S.ganchos, g0.vazioEl);
      else {
        if (LOGO) { const im = el('img', 'abas-vazio-logo', { src: LOGO, alt: '', width: '56', height: '56' }); im.addEventListener('error', () => im.remove()); g0.vazioEl.appendChild(im); }
        const t = el('div', 'abas-vazio-txt'); t.textContent = 'Nenhuma aba aberta'; g0.vazioEl.appendChild(t);
      }
      g0.corpo.appendChild(g0.vazioEl);
    }
    S.grupos.forEach((g) => { if (g.vazioEl && !(vazio && g === g0)) { g.vazioEl.remove(); g.vazioEl = null; } });
    S.grupos.forEach((g) => { g.btnDiv.disabled = !g.abas.length; });
    marcarFoco();
  }

  // Posições por fração da raiz (redimensionar a janela não pede JS). A divisória ocupa 1 px no começo
  // do nó que vem depois dela; quem não encosta na borda esquerda/de cima recua esse 1 px.
  const pc = (v) => +(v * 100).toFixed(4) + '%';
  const QUASE = 1e-6;
  function posicionar() {
    const medir = (n, x, y, w, h) => {
      n.r = { x, y, w, h };
      if (!ehRamo(n)) {
        const s = n.el.style, l = x > QUASE, t = y > QUASE;
        s.left = l ? `calc(${pc(x)} + 1px)` : '0px';
        s.top = t ? `calc(${pc(y)} + 1px)` : '0px';
        s.width = l ? `calc(${pc(w)} - 1px)` : pc(w);
        s.height = t ? `calc(${pc(h)} - 1px)` : pc(h);
        return;
      }
      const soma = n.filhos.reduce((t, c) => t + (c.tamanho > 0 ? c.tamanho : 0), 0) || 1;
      const deLado = n.dir === 'linha';
      let ac = 0;
      n.filhos.forEach((c, k) => {
        c.tamanho = c.tamanho > 0 ? c.tamanho / soma : 1 / n.filhos.length;
        if (k && c.sep) {
          const s = c.sep.style;
          if (deLado) {
            const t = y > QUASE;
            s.left = pc(x + w * ac); s.width = '';
            s.top = t ? `calc(${pc(y)} + 1px)` : '0px'; s.height = t ? `calc(${pc(h)} - 1px)` : pc(h);
          } else {
            const l = x > QUASE;
            s.top = pc(y + h * ac); s.height = '';
            s.left = l ? `calc(${pc(x)} + 1px)` : '0px'; s.width = l ? `calc(${pc(w)} - 1px)` : pc(w);
          }
          c.sep.setAttribute('aria-valuenow', String(Math.round(ac * 100)));
        }
        if (deLado) medir(c, x + w * ac, y, w * c.tamanho, h);
        else medir(c, x, y + h * ac, w, h * c.tamanho);
        ac += c.tamanho;
      });
    };
    medir(S.arvore, 0, 0, 1, 1);
  }
  function marcarFoco() {
    if (!S.foco || !S.grupos.includes(S.foco)) S.foco = S.grupos[0];
    for (const g of S.grupos) g.el.classList.toggle('foco', g === S.foco);
  }

  // ───────────────────────── divisória ─────────────────────────
  // Cada divisória pertence ao nó que vem depois dela (d.no) e o separa do anterior no mesmo ramo:
  // em pé entre painéis lado a lado, deitada entre painéis empilhados.
  function criarDivisoria() {
    const d = el('div', 'abas-div', { role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Redimensionar painéis' });
    const par = () => {
      const b = d.no, p = b && b.pai;
      if (!p) return null;
      const i = p.filhos.indexOf(b);
      return i > 0 ? { p, a: p.filhos[i - 1], b, deitada: p.dir === 'coluna' } : null;
    };
    // Tamanho em px do ramo no eixo da divisória.
    const extensao = (q) => { const r = S.raiz.getBoundingClientRect(); return (q.deitada ? r.height * q.p.r.h : r.width * q.p.r.w) || 1; };
    let arr = null;
    d.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const q = par(); if (!q) return;
      e.preventDefault();
      const ext = extensao(q), f = q.a.tamanho + q.b.tamanho;
      arr = { q, c0: q.deitada ? e.clientY : e.clientX, sA: ext * q.a.tamanho, tot: ext * f, f };
      d.setPointerCapture(e.pointerId);
      d.classList.add('arrastando');
      S.raiz.classList.add('redimensionando');
      S.raiz.classList.toggle('em-altura', q.deitada);
    });
    d.addEventListener('pointermove', (e) => {
      if (!arr) return;
      const { q } = arr, min = Math.min(q.deitada ? MIN_ALT : MIN_PX, arr.tot / 2);
      const nA = limitar(arr.sA + (q.deitada ? e.clientY : e.clientX) - arr.c0, min, arr.tot - min);
      q.a.tamanho = arr.f * nA / arr.tot; q.b.tamanho = arr.f - q.a.tamanho;
      posicionar();
    });
    const fim = () => {
      if (!arr) return;
      arr = null;
      d.classList.remove('arrastando');
      if (S) S.raiz.classList.remove('redimensionando', 'em-altura');
      op(() => layout());
    };
    d.addEventListener('pointerup', fim);
    d.addEventListener('pointercancel', fim);
    // Duplo clique iguala os painéis deste ramo.
    d.addEventListener('dblclick', () => { const q = par(); if (q) op(() => { for (const c of q.p.filhos) c.tamanho = 1 / q.p.filhos.length; layout(); }); });
    d.addEventListener('keydown', (e) => {
      const q = par(); if (!q) return;
      const menos = q.deitada ? 'ArrowUp' : 'ArrowLeft', mais = q.deitada ? 'ArrowDown' : 'ArrowRight';
      if (e.key !== menos && e.key !== mais) return;
      e.preventDefault();
      const f = q.a.tamanho + q.b.tamanho, minF = Math.min((q.deitada ? MIN_ALT : MIN_PX) / extensao(q), f / 2);
      const nA = limitar(q.a.tamanho + (e.key === mais ? 0.05 : -0.05), minF, f - minF);
      op(() => { q.a.tamanho = nA; q.b.tamanho = f - nA; layout(); });
    });
    return d;
  }

  // ───────────────────────── abas ─────────────────────────
  function novaAba(tipo, chave, dados, previa) {
    const n = ++seqAba;
    const a = { id: 'aba-' + n, tipo, chave, dados: dados === undefined ? null : dados, previa: !!previa, selo: null, g: null, inst: null, rolagem: 0, pub: {} };
    a.el = el('div', 'aba', { role: 'tab', id: a.id, tabindex: '-1', 'aria-selected': 'false', 'aria-controls': a.id + '-p', 'data-aba': a.id });
    a.ic = el('span', 'aba-ic', { 'aria-hidden': 'true' });
    a.tit = el('span', 'aba-tit');
    const acao = el('span', 'aba-acao');
    a.x = el('span', 'aba-x', { 'aria-hidden': 'true', title: 'Fechar' });
    a.x.appendChild(icone('x'));
    a.seloEl = el('span', 'aba-selo', { 'aria-hidden': 'true' });
    acao.append(a.seloEl, a.x);
    a.el.append(a.ic, a.tit, acao);
    a.painel = el('div', 'aba-painel', { role: 'tabpanel', id: a.id + '-p', 'aria-labelledby': a.id, tabindex: '0' });
    a.painel.hidden = true;
    ligarAba(a);
    S.mapa.set(a.id, a);
    return a;
  }

  function desenharAba(a) {
    const p = prov(a), pa = pub(a);
    const titulo = String(chamar(p.titulo, p, pa) ?? a.chave);
    a.tit.textContent = titulo;
    a.el.setAttribute('data-chave', a.chave);
    const dica = chamar(p.dica, p, pa) || chamar(p.caminho, p, pa) || titulo;
    a.el.title = String(dica);
    a.ic.replaceChildren();
    const ic = chamar(p.icone, p, pa, 16);
    if (ic instanceof Node) a.ic.appendChild(ic);
    a.el.classList.toggle('previa', !!a.previa);
    if (a.selo) a.el.setAttribute('data-selo', a.selo); else a.el.removeAttribute('data-selo');
    const extra = (a.previa ? ', prévia' : '') + (a.selo === 'novo' ? ', atividade nova' : a.selo === 'atencao' ? ', aguardando você' : '');
    a.el.setAttribute('aria-label', titulo + extra);
  }

  function marcarAbas(g) {
    for (const a of g.abas) {
      const at = a.id === g.ativa;
      a.el.classList.toggle('ativa', at);
      a.el.setAttribute('aria-selected', at ? 'true' : 'false');
      a.el.tabIndex = at ? 0 : -1;
    }
  }

  // Põe a aba no grupo `g` na posição `i` (array e DOM).
  function inserir(a, g, i) {
    i = limitar(i ?? g.abas.length, 0, g.abas.length);
    g.abas.splice(i, 0, a);
    a.g = g;
    const prox = g.abas[i + 1];
    g.lista.insertBefore(a.el, prox ? prox.el : null);
    if (a.painel.parentNode !== g.corpo) g.corpo.insertBefore(a.painel, g.zona);
    desenharAba(a);
  }

  function esconderAba(a) {
    if (a.painel.hidden) return;
    a.rolagem = a.painel.scrollTop;
    a.painel.hidden = true;
    if (a.inst) chamar(a.inst.esconder, a.inst);
  }
  function revelarAba(a) {
    if (!a.painel.hidden && a.inst) return;
    a.painel.hidden = false;
    if (!a.inst) {
      const p = prov(a);
      a.inst = chamar(p.criar, p, pub(a), a.painel) || {};
    } else {
      chamar(a.inst.mostrar, a.inst);
      a.painel.scrollTop = a.rolagem || 0;
      // O conteúdo pode se redesenhar no mostrar(); reforça a rolagem no próximo quadro.
      const r = a.rolagem || 0;
      if (r) requestAnimationFrame(() => { if (!a.painel.hidden && a.painel.scrollTop !== r) a.painel.scrollTop = r; });
    }
  }
  // A aba fica ativa no grupo dela (instância criada só agora, se for a 1ª vez).
  function ativarInterno(a) {
    const g = a.g;
    const ant = g.ativa && g.ativa !== a.id ? achar(g.ativa) : null;
    if (ant) esconderAba(ant);
    g.ativa = a.id;
    g.mru = [a.id, ...g.mru.filter((x) => x !== a.id)];
    revelarAba(a);
    marcarAbas(g);
    aVista(a);
  }
  function aVista(a) {
    const l = a.g.lista, x = a.el.offsetLeft, w = a.el.offsetWidth;
    if (x < l.scrollLeft) l.scrollLeft = x;
    else if (x + w > l.scrollLeft + l.clientWidth) l.scrollLeft = x + w - l.clientWidth;
  }
  // Foco de teclado na aba: o conteúdo (focar do provedor) ou, sem ele, a própria aba.
  function focarAba(a, soConteudo) {
    if (!a) return;
    S.foco = a.g;
    if (a.inst && typeof a.inst.focar === 'function') chamar(a.inst.focar, a.inst);
    else if (!soConteudo) a.el.focus({ preventScroll: true });
  }

  // Tira a aba do grupo. destruir=false quando ela vai para outro grupo (o painel e a instância seguem).
  function removerAba(a, { destruir = true, reativar = true } = {}) {
    const g = a.g;
    const i = g.abas.indexOf(a);
    if (i < 0) return;
    const eraAtiva = g.ativa === a.id;
    g.abas.splice(i, 1);
    g.mru = g.mru.filter((x) => x !== a.id);
    a.el.remove();
    if (destruir) {
      if (a.inst) chamar(a.inst.destruir, a.inst);
      a.inst = null;
      a.painel.remove();
      S.mapa.delete(a.id);
      a.g = null;
    }
    if (eraAtiva) {
      g.ativa = null;
      if (reativar && g.abas.length) ativarInterno(achar(g.mru[0]) || g.abas[Math.min(i, g.abas.length - 1)]);
    }
    marcarAbas(g);
  }

  function fecharInterno(a, comFoco) {
    const g = a.g;
    const tinhaFoco = comFoco || g.el.contains(document.activeElement);
    removerAba(a);
    talvezRemoverGrupo(g);
    if (tinhaFoco) {
      const alvo = S.grupos.includes(g) ? g : S.foco;
      const n = achar(alvo.ativa);
      if (n) focarAba(n); else alvo.lista.focus?.();
    }
  }

  function fixarInterno(a) { if (a.previa) { a.previa = false; desenharAba(a); } }

  // Move a aba para g2 na posição `indice` (mesmo grupo = reordenar). Não recria a instância.
  function moverInterno(a, g2, indice) {
    const g1 = a.g;
    if (indice == null) indice = g2.abas.length;
    if (g1 === g2) {
      const de = g1.abas.indexOf(a);
      let para = limitar(indice, 0, g1.abas.length);
      if (para > de) para--;
      if (para === de) return a;
      g1.abas.splice(de, 1);
      g1.abas.splice(para, 0, a);
      const prox = g1.abas[para + 1];
      g1.lista.insertBefore(a.el, prox ? prox.el : null);
      aVista(a);
      return a;
    }
    const dup = g2.abas.find((x) => x.tipo === a.tipo && x.chave === a.chave);
    if (dup) { removerAba(a); talvezRemoverGrupo(g1); ativarInterno(dup); return dup; }
    const visivel = !a.painel.hidden, rol = a.painel.scrollTop;
    removerAba(a, { destruir: false });
    if (a.previa && g2.abas.some((x) => x.previa)) a.previa = false;
    inserir(a, g2, indice);
    ativarInterno(a);
    if (visivel && rol) a.painel.scrollTop = rol;
    talvezRemoverGrupo(g1);
    return a;
  }

  // 'ativo' | 'lado' | idGrupo → grupo.
  function resolverGrupo(alvo) {
    if (alvo === 'lado') {
      const i = S.grupos.indexOf(S.foco);
      return S.grupos[i + 1] || novoGrupo(S.foco, 'direita') || S.grupos[S.grupos.length - 1];
    }
    if (alvo && alvo !== 'ativo') return grupoPorId(alvo) || S.foco;
    return S.foco;
  }

  function ciclar(passo) {
    const g = S.foco;
    if (!g || g.abas.length < 2) return false;
    const i = g.abas.findIndex((a) => a.id === g.ativa);
    const n = g.abas[(i + passo + g.abas.length) % g.abas.length];
    ativarInterno(n);
    focarAba(n);
    return true;
  }

  // ───────────────────────── eventos da aba ─────────────────────────
  let arr = null;          // arraste de aba em curso
  let semClique = false;   // o clique que fecha um arraste não ativa nada

  function ligarAba(a) {
    const t = a.el;
    t.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.aba-x')) return;
      op(() => { S.foco = a.g; ativarInterno(a); });
      arr = { a, x0: e.clientX, y0: e.clientY, pid: e.pointerId, ativo: false, alvo: null };
      try { t.setPointerCapture(e.pointerId); } catch {}
    });
    t.addEventListener('pointermove', (e) => {
      if (!arr || arr.a !== a || e.pointerId !== arr.pid) return;
      if (!arr.ativo) {
        if (Math.hypot(e.clientX - arr.x0, e.clientY - arr.y0) < LIMIAR) return;
        comecarArraste();
      }
      moverArraste(e.clientX, e.clientY);
    });
    t.addEventListener('pointerup', (e) => {
      if (!arr || arr.a !== a) return;
      const fim = arr; arr = null;
      if (fim.ativo) {
        semClique = true; setTimeout(() => { semClique = false; }, 0);
        const alvo = fim.alvo, ft = fotoArraste(fim);
        limparArraste();
        S.flip = ft;
        try { soltar(a, alvo); } finally { if (S && S.flip === ft) S.flip = null; animar(ft); }
      }
    });
    t.addEventListener('pointercancel', () => { if (arr && arr.a === a) cancelarArraste(); });
    t.addEventListener('click', (e) => {
      if (semClique) return;
      if (e.target.closest('.aba-x')) { op(() => fecharInterno(a)); return; }
      if (a.g && a.inst && typeof a.inst.focar === 'function') chamar(a.inst.focar, a.inst);
    });
    t.addEventListener('dblclick', (e) => { if (!e.target.closest('.aba-x') && a.previa) op(() => fixarInterno(a)); });
    // Clique do meio fecha; sem o preventDefault no mousedown o Windows abre a auto-rolagem.
    t.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    t.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); op(() => fecharInterno(a)); } });
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (S.menu && S.menu.dona === a.el) return; // já aberto pelo teclado (Shift+F10)
      let x = e.clientX, y = e.clientY;
      if (!x && !y) { const r = t.getBoundingClientRect(); x = r.left + 8; y = r.bottom + 2; }
      menuDaAba(a, x, y);
    });
    t.addEventListener('keydown', (e) => {
      const g = a.g; if (!g) return;
      const i = g.abas.indexOf(a);
      let alvo = null;
      if (e.key === 'ArrowRight') alvo = g.abas[(i + 1) % g.abas.length];
      else if (e.key === 'ArrowLeft') alvo = g.abas[(i - 1 + g.abas.length) % g.abas.length];
      else if (e.key === 'Home') alvo = g.abas[0];
      else if (e.key === 'End') alvo = g.abas[g.abas.length - 1];
      if (alvo) { e.preventDefault(); alvo.el.focus({ preventScroll: true }); aVista(alvo); return; }
      if ((e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.altKey) { e.preventDefault(); op(() => { S.foco = g; ativarInterno(a); focarAba(a, true); }); return; }
      if ((e.key === 'Delete' || (MAC && e.key === 'Backspace')) && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const viz = g.abas[i + 1] || g.abas[i - 1];
        op(() => { removerAba(a); talvezRemoverGrupo(g); if (viz && viz.g) viz.el.focus({ preventScroll: true }); else { const n = achar(S.foco.ativa); if (n) n.el.focus({ preventScroll: true }); } });
        return;
      }
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        const r = t.getBoundingClientRect();
        menuDaAba(a, r.left + 8, r.bottom + 2);
      }
    });
  }

  // ───────────────────────── arrastar abas ─────────────────────────
  // A aba "sai" da barra: um fantasma com a cara dela segue o cursor (preso no ponto onde foi pega).
  function comecarArraste() {
    arr.ativo = true;
    encerrarAnimacoes();
    const t = arr.a.el, r = t.getBoundingClientRect();
    arr.w = t.offsetWidth;
    arr.dx = arr.x0 - r.left; arr.dy = arr.y0 - r.top;
    const f = el('div', 'abas-fantasma' + (arr.a.previa ? ' previa' : ''), { 'aria-hidden': 'true' });
    const tit = el('span', 'aba-tit'); tit.textContent = arr.a.tit.textContent;
    f.append(arr.a.ic.cloneNode(true), tit);
    f.style.width = Math.round(r.width) + 'px';
    f.style.height = Math.round(r.height) + 'px';
    f.style.transformOrigin = `${Math.round(arr.dx)}px ${Math.round(arr.dy)}px`;
    arr.fantasma = f;
    document.body.appendChild(f);
    t.classList.add('arrastada');
    S.raiz.classList.add('arrastando');
    fecharMenu();
  }
  function moverArraste(x, y) {
    arr.fantasma.style.transform = `translate3d(${Math.round(x - arr.dx)}px, ${Math.round(y - arr.dy)}px, 0)`;
    arr.alvo = calcularAlvo(x, y);
    // Sobre a própria barra sem mudar de lugar: o alvo é nulo (soltar não faz nada), mas o vão fica na origem.
    desenharAlvo(arr.alvo || origemNaBarra(x, y));
  }
  function origemNaBarra(x, y) {
    const g = arr.a.g; if (!g) return null;
    const rb = g.barra.getBoundingClientRect();
    return x >= rb.left && x < rb.right && y >= rb.top && y < rb.bottom ? { tipo: 'barra', g, ind: g.abas.indexOf(arr.a) } : null;
  }
  function calcularAlvo(x, y) {
    const a = arr.a;
    for (const g of S.grupos) {
      const rg = g.el.getBoundingClientRect();
      if (x < rg.left || x >= rg.right || y < rg.top || y >= rg.bottom) continue;
      const rb = g.barra.getBoundingClientRect();
      if (y < rb.bottom) {
        // Posições de layout (offsetLeft), não as da tela: as abas abrindo o vão estão deslocadas.
        const x0 = g.lista.getBoundingClientRect().left - g.lista.scrollLeft;
        let ind = g.abas.length;
        for (let k = 0; k < g.abas.length; k++) { const e = g.abas[k].el; if (x < x0 + e.offsetLeft + e.offsetWidth / 2) { ind = k; break; } }
        if (g === a.g) { const de = g.abas.indexOf(a); if (ind === de || ind === de + 1) return null; }
        return { tipo: 'barra', g, ind };
      }
      const rc = g.corpo.getBoundingClientRect();
      const fx = (x - rc.left) / (rc.width || 1), fy = (y - rc.top) / (rc.height || 1);
      const proprioSo = g === a.g && g.abas.length === 1;
      const lados = S.grupos.length < MAX_GRUPOS && !proprioSo;
      if (lados) {
        // No terço de uma borda, divide para aquele lado; num canto, vale a borda mais perto.
        let lado = null, d = 1 / 3;
        for (const [k, v] of [['esquerda', fx], ['direita', 1 - fx], ['cima', fy], ['baixo', 1 - fy]]) if (v < d) { lado = k; d = v; }
        if (lado) return { tipo: lado, g };
      }
      return g === a.g ? null : { tipo: 'centro', g };
    }
    return null;
  }
  const LADOS = ['esquerda', 'direita', 'cima', 'baixo', 'centro'];
  // Liga/desliga um indicador. Ao acender do zero, posiciona sem transição (só a opacidade anima).
  function acender(n, on, posicionar) {
    const era = n.classList.contains('on');
    if (on && posicionar) {
      if (!era) { n.classList.add('sem-tr'); posicionar(); void n.offsetWidth; n.classList.remove('sem-tr'); }
      else posicionar();
    }
    n.classList.toggle('on', !!on);
  }
  function desenharAlvo(alvo) {
    for (const g of S.grupos) {
      const z = alvo && alvo.g === g && alvo.tipo !== 'barra' ? alvo.tipo : '';
      acender(g.zona, !!z, () => { for (const k of LADOS) g.zona.classList.toggle(k, k === z); });
      abrirVao(g, alvo && alvo.g === g && alvo.tipo === 'barra' ? alvo.ind : -1);
    }
    if (arr && arr.a.el) arr.a.el.classList.toggle('fora', !(alvo && alvo.tipo === 'barra' && alvo.g === arr.a.g));
  }
  // As abas de `g` se afastam para mostrar onde a arrastada entra (`ind`, na ordem de layout); -1 fecha o vão.
  function abrirVao(g, ind) {
    const a = arr && arr.ativo ? arr.a : null;
    if (!a || ind < 0) {
      for (const x of g.abas) if (x.el.style.transform) x.el.style.transform = '';
      acender(g.ins, false);
      return;
    }
    const w = arr.w, de = a.g === g ? g.abas.indexOf(a) : -1;
    g.abas.forEach((x, k) => {
      if (x === a) return;
      let s = 0;
      if (de < 0) s = k >= ind ? w : 0;
      else if (ind > de + 1 && k > de && k < ind) s = -w;
      else if (ind < de && k >= ind && k < de) s = w;
      x.el.style.transform = s ? `translateX(${s}px)` : '';
    });
    const fim = (x) => x.el.offsetLeft + x.el.offsetWidth;
    let L;
    if (de >= 0) L = ind > de + 1 ? fim(g.abas[ind - 1]) - w : ind < de ? g.abas[ind].el.offsetLeft : a.el.offsetLeft;
    else L = ind < g.abas.length ? g.abas[ind].el.offsetLeft : g.abas.length ? fim(g.abas[g.abas.length - 1]) : 0;
    acender(g.ins, true, () => {
      const l0 = g.lista.offsetLeft, lw = g.lista.clientWidth, larg = Math.min(w, lw);
      const esq = limitar(l0 + L - g.lista.scrollLeft, l0, l0 + lw - larg);
      g.ins.style.left = Math.round(esq + 2) + 'px';
      g.ins.style.width = Math.max(0, Math.round(larg - 4)) + 'px';
    });
  }
  function limparArraste() {
    if (!S) return;
    document.querySelectorAll('.abas-fantasma').forEach((n) => n.remove());
    document.querySelectorAll('.aba.arrastada').forEach((n) => n.classList.remove('arrastada', 'fora'));
    S.raiz.classList.remove('arrastando');
    desenharAlvo(null);
  }
  // Foto para o FLIP ao soltar/cancelar: a arrastada parte de onde o fantasma está.
  function fotoArraste(fim) {
    const ft = foto();
    if (ft && fim && fim.fantasma && fim.fantasma.isConnected) {
      const e = ft.m.get(fim.a.el);
      if (e) { e.r = fim.fantasma.getBoundingClientRect(); e.voo = true; }
    }
    return ft;
  }
  function cancelarArraste() {
    const ft = fotoArraste(arr);
    arr = null;
    limparArraste();
    animar(ft);
  }
  function soltar(a, alvo) {
    if (!alvo || !a.g) return;
    op(() => {
      if (alvo.tipo === 'barra') { moverInterno(a, alvo.g, alvo.ind); S.foco = a.g; return; }
      if (alvo.tipo === 'centro') { const r = moverInterno(a, alvo.g, alvo.g.abas.length); S.foco = r.g; return; }
      const ng = novoGrupo(alvo.g, alvo.tipo);
      if (!ng) return;
      const r = moverInterno(a, ng, 0);
      S.foco = r.g;
    });
  }

  // ───────────────────────── menu ─────────────────────────
  function fecharMenu(voltar) {
    if (!S || !S.menu) return;
    const m = S.menu; S.menu = null;
    m.el.remove();
    document.removeEventListener('pointerdown', m.fora, true);
    window.removeEventListener('blur', m.sair);
    window.removeEventListener('resize', m.sair);
    if (voltar && m.dona && m.dona.isConnected) m.dona.focus({ preventScroll: true });
  }
  // itens: [{ rot, off?, acao }] ou '-' (separador). x/y: canto do menu; `direita` alinha a borda direita em x.
  function abrirMenu(itens, x, y, dona, direita) {
    fecharMenu();
    const m = { el: el('div', 'abas-menu', { role: 'menu' }), dona };
    const botoes = [];
    let antSep = true;
    itens.forEach((it, k) => {
      if (it === '-') {
        if (!antSep && k < itens.length - 1) { m.el.appendChild(el('div', 'abas-menu-sep', { role: 'separator' })); antSep = true; }
        return;
      }
      antSep = false;
      const b = el('button', 'abas-mi', { type: 'button', role: 'menuitem', tabindex: '-1' });
      const r = el('span', 'abas-mi-rot'); r.textContent = it.rot; b.appendChild(r);
      if (it.off) b.setAttribute('aria-disabled', 'true');
      // Fecha devolvendo o foco a quem abriu (a aba), para o fechar seguinte saber onde pôr o foco.
      b.addEventListener('click', () => { if (it.off) return; fecharMenu(true); it.acao(); });
      b.addEventListener('pointermove', () => { if (document.activeElement !== b) b.focus({ preventScroll: true }); });
      m.el.appendChild(b); botoes.push(b);
    });
    if (m.el.lastElementChild && m.el.lastElementChild.classList.contains('abas-menu-sep')) m.el.lastElementChild.remove();
    m.el.addEventListener('keydown', (e) => {
      const i = botoes.indexOf(document.activeElement);
      const ir = (n) => { e.preventDefault(); botoes[(n + botoes.length) % botoes.length].focus({ preventScroll: true }); };
      if (e.key === 'ArrowDown') ir(i + 1);
      else if (e.key === 'ArrowUp') ir(i < 0 ? botoes.length - 1 : i - 1);
      else if (e.key === 'Home') ir(0);
      else if (e.key === 'End') ir(botoes.length - 1);
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharMenu(true); }
      else if (e.key === 'Tab') { e.preventDefault(); fecharMenu(true); }
    });
    m.el.addEventListener('contextmenu', (e) => e.preventDefault());
    m.fora = (e) => { if (!m.el.contains(e.target)) fecharMenu(); };
    m.sair = () => fecharMenu();
    document.body.appendChild(m.el);
    const r = m.el.getBoundingClientRect();
    const px = direita ? x - r.width : x;
    m.el.style.left = Math.round(limitar(px, 8, window.innerWidth - r.width - 8)) + 'px';
    m.el.style.top = Math.round(y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height - 4) : y) + 'px';
    S.menu = m;
    document.addEventListener('pointerdown', m.fora, true);
    window.addEventListener('blur', m.sair);
    window.addEventListener('resize', m.sair);
    const pri = botoes.find((b) => !b.hasAttribute('aria-disabled')) || botoes[0];
    if (pri) pri.focus({ preventScroll: true });
  }

  function menuDaAba(a, x, y) {
    const g = a.g, p = prov(a), i = g.abas.indexOf(a);
    const caminho = chamar(p.caminho, p, pub(a));
    const itens = [
      { rot: 'Fechar', acao: () => api.fechar(a.id) },
      { rot: 'Fechar outras', off: g.abas.length < 2, acao: () => api.fecharOutras(a.id) },
      { rot: 'Fechar à direita', off: i >= g.abas.length - 1, acao: () => api.fecharDireita(a.id) },
      { rot: 'Fechar todas', acao: () => api.fecharTodas(g.id) },
      '-',
    ];
    if (caminho) itens.push({ rot: 'Copiar caminho', acao: () => copiarTexto(String(caminho)) });
    if (a.previa) itens.push({ rot: 'Fixar aba', acao: () => api.fixar(a.id) });
    itens.push('-',
      { rot: 'Dividir à direita', acao: () => api.dividir(a.id, 'direita') },
      { rot: 'Dividir à esquerda', acao: () => api.dividir(a.id, 'esquerda') },
      { rot: 'Dividir para baixo', acao: () => api.dividir(a.id, 'baixo') });
    abrirMenu(itens, x, y, a.el);
  }
  function copiarTexto(t) {
    let pr;
    try { pr = navigator.clipboard.writeText(t); } catch (e) { pr = Promise.reject(e); }
    Promise.resolve(pr).then(() => toast('Caminho copiado'), () => toast('Não foi possível copiar o caminho'));
  }

  // ───────────────────────── atalhos ─────────────────────────
  function teclas(e) {
    if (!S) return;
    if (arr && arr.ativo && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelarArraste(); return; }
    if (S.menu || e.isComposing) return;
    if (chamar(S.ganchos.bloqueado, S.ganchos)) return;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey, alt = e.altKey && !e.ctrlKey && !e.metaKey;
    if (!ctrl && !alt) return; // digitação comum não passa daqui (nada de salvar a cada tecla)
    let feito = false;
    const dono = !prof && !S.flip && (e.code === 'KeyW' || e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp' || e.key === '\\' || /^(Backslash|IntlBackslash|Digit[1-4])$/.test(e.code));
    if (dono) S.flip = foto();
    prof++; // como op(), mas só avisa os ganchos se algum atalho agiu
    try {
      const ativa = achar(S.foco && S.foco.ativa);
      if (e.code === 'KeyW' && !e.shiftKey && (ctrl || alt)) { if (ativa) { fecharInterno(ativa, true); feito = true; } }
      else if (ctrl && e.key === 'Tab') feito = ciclar(e.shiftKey ? -1 : 1) || !!ativa;
      else if (alt && !e.shiftKey && (e.key === 'PageDown' || e.key === 'PageUp')) feito = ciclar(e.key === 'PageDown' ? 1 : -1) || !!ativa;
      else if (ctrl && !e.shiftKey && (e.key === '\\' || e.code === 'Backslash' || e.code === 'IntlBackslash')) { if (ativa) { api.dividir(ativa.id, 'direita'); } feito = true; }
      else if (ctrl && !e.shiftKey && /^Digit[1-4]$/.test(e.code)) {
        const g = S.grupos[Number(e.code.slice(5)) - 1];
        if (g) { S.foco = g; const n = achar(g.ativa); if (n) focarAba(n); feito = true; }
      }
    } finally { prof--; }
    if (feito) { e.preventDefault(); e.stopPropagation(); if (!prof) notificar(); }
    if (dono && S) { const f = S.flip; S.flip = null; if (feito) animar(f); }
  }

  // ───────────────────────── montagem ─────────────────────────
  function desmontar() {
    if (!S) return;
    fecharMenu();
    limparArraste();
    for (const g of S.grupos) { if (g.ro) g.ro.disconnect(); for (const a of g.abas) if (a.inst) chamar(a.inst.destruir, a.inst); }
    window.removeEventListener('keydown', teclas, true);
    S.raiz.replaceChildren();
    S.raiz.classList.remove('abas-raiz', 'arrastando', 'redimensionando', 'em-altura');
    S = null;
  }

  function montar(raiz, cfg = {}) {
    desmontar();
    S = {
      raiz, tipos: cfg.tipos || {}, ganchos: cfg.ganchos || {}, chave: cfg.chave === undefined ? 'gi.abas' : cfg.chave,
      grupos: [], arvore: null, foco: null, mapa: new Map(), menu: null, ultFoco: null, flip: null,
    };
    raiz.replaceChildren();
    raiz.classList.add('abas-raiz');
    prof++;
    try {
      const salvo = cfg.restaurar === false ? null : ler();
      const unicas = new Set();
      const restaurados = [];
      if (salvo) {
        for (const sg of salvo.grupos.slice(0, MAX_GRUPOS)) {
          if (!sg || !Array.isArray(sg.abas)) continue;
          const lista = [];
          let temPrevia = false;
          for (const sa of sg.abas) {
            if (!sa || !S.tipos[sa.tipo] || typeof sa.chave !== 'string') continue; // tipo desconhecido sai
            const k = sa.tipo + '\u001f' + sa.chave;
            if (S.tipos[sa.tipo].unica && unicas.has(k)) continue;
            if (lista.some((x) => x.tipo === sa.tipo && x.chave === sa.chave)) continue;
            unicas.add(k);
            const previa = !!sa.previa && !temPrevia;
            if (previa) temPrevia = true;
            lista.push({ tipo: sa.tipo, chave: sa.chave, dados: sa.dados, previa, orig: sg.abas.indexOf(sa) });
          }
          if (!lista.length) continue;
          const ia = lista.findIndex((x) => x.orig === sg.ativa);
          restaurados.push({ lista, ativa: ia >= 0 ? ia : 0, tamanho: Number(sg.tamanho) > 0 ? Number(sg.tamanho) : 0, orig: salvo.grupos.indexOf(sg) });
        }
      }
      for (const r of restaurados) {
        const g = r.g = criarGrupo();
        g.tamanho = r.tamanho || 1 / restaurados.length;
        for (const x of r.lista) inserir(novaAba(x.tipo, x.chave, x.dados, x.previa), g, g.abas.length);
      }
      // A grade salva; sem ela (ou inválida), os grupos voltam lado a lado.
      S.arvore = restaurados.length ? lerArvore(salvo.arvore, new Map(restaurados.map((r) => [r.orig, r.g])), restaurados.length) : null;
      if (!S.arvore && restaurados.length > 1) {
        S.arvore = novoRamo('linha');
        for (const r of restaurados) { r.g.pai = S.arvore; S.arvore.filhos.push(r.g); }
      } else if (!S.arvore) S.arvore = restaurados.length ? restaurados[0].g : criarGrupo();
      const rf = restaurados.find((r) => r.orig === salvo.foco);
      layout();
      S.foco = rf ? rf.g : S.grupos[0];
      // Só a ativa de cada grupo é criada agora (instância preguiçosa).
      for (const r of restaurados) ativarInterno(r.g.abas[r.ativa]);
    } finally { prof--; }
    window.addEventListener('keydown', teclas, true);
    notificar();
    return api;
  }

  // ───────────────────────── API pública ─────────────────────────
  const api = {
    montar,
    abrir(o = {}) {
      return op(() => {
        const p = S.tipos[o.tipo];
        if (!p || o.chave == null) return null;
        const tipo = o.tipo, chave = String(o.chave), previa = !!o.previa, focar = o.focar !== false;
        let a = null;
        if (p.unica) for (const g of S.grupos) { a = g.abas.find((x) => x.tipo === tipo && x.chave === chave); if (a) break; }
        const g = a ? a.g : resolverGrupo(o.grupo);
        if (!a) a = g.abas.find((x) => x.tipo === tipo && x.chave === chave) || null;
        if (a) {
          if (o.dados !== undefined) a.dados = o.dados;
          if (!previa) fixarInterno(a);
          ativarInterno(a);
          if (focar) focarAba(a, true);
          return pub(a);
        }
        const nova = novaAba(tipo, chave, o.dados, previa);
        let i;
        const velha = previa ? g.abas.find((x) => x.previa) : null;
        if (velha) { i = g.abas.indexOf(velha); removerAba(velha, { reativar: false }); }
        else { const at = g.abas.findIndex((x) => x.id === g.ativa); i = at >= 0 ? at + 1 : g.abas.length; }
        inserir(nova, g, i);
        ativarInterno(nova);
        layout();
        if (focar) focarAba(nova, true);
        return pub(nova);
      });
    },
    fechar(id) { const a = achar(id); if (a) op(() => fecharInterno(a)); },
    fecharOutras(id) {
      const a = achar(id); if (!a) return;
      op(() => { const g = a.g; ativarInterno(a); for (const x of g.abas.slice()) if (x !== a) removerAba(x, { reativar: false }); layout(); });
    },
    fecharDireita(id) {
      const a = achar(id); if (!a) return;
      op(() => {
        const g = a.g, i = g.abas.indexOf(a);
        const dir = g.abas.slice(i + 1);
        if (dir.some((x) => x.id === g.ativa)) ativarInterno(a);
        for (const x of dir) removerAba(x, { reativar: false });
        layout();
      });
    },
    fecharTodas(idGrupo) {
      op(() => {
        const alvos = idGrupo ? [grupoPorId(idGrupo)].filter(Boolean) : S.grupos.slice();
        for (const g of alvos) { for (const x of g.abas.slice()) removerAba(x, { reativar: false }); talvezRemoverGrupo(g); }
        layout();
      });
    },
    fixar(id) { const a = achar(id); if (a) op(() => fixarInterno(a)); },
    ativar(id, { focar = true } = {}) {
      const a = achar(id); if (!a) return;
      op(() => { ativarInterno(a); if (focar) focarAba(a, true); });
    },
    mover(id, idGrupo, indice) {
      const a = achar(id), g = S && grupoPorId(idGrupo);
      if (!a || !g) return null;
      return op(() => pub(moverInterno(a, g, indice)));
    },
    dividir(id, lado = 'direita') {
      const a = achar(id); if (!a) return null;
      return op(() => {
        const g = a.g, gi = S.grupos.indexOf(g), p = prov(a);
        if (p.unica && g.abas.length === 1 && S.grupos.length === 1) return pub(a); // nada a dividir
        if (!['esquerda', 'direita', 'cima', 'baixo'].includes(lado)) lado = 'direita';
        const antes = lado === 'esquerda' || lado === 'cima';
        const ng = novoGrupo(g, lado) || S.grupos[antes ? gi - 1 : gi + 1];
        if (!ng) { toast('No máximo 4 painéis'); return null; }
        let r;
        if (p.unica) r = moverInterno(a, ng, ng.abas.length);
        else {
          r = ng.abas.find((x) => x.tipo === a.tipo && x.chave === a.chave);
          if (!r) { r = novaAba(a.tipo, a.chave, copiar(a.dados), false); inserir(r, ng, ng.abas.length); }
          ativarInterno(r);
          layout();
        }
        S.foco = r.g;
        focarAba(r, true);
        return pub(r);
      });
    },
    atualizar(id) {
      if (!S) return;
      if (id) { const a = achar(id); if (a) desenharAba(a); }
      else for (const g of S.grupos) for (const a of g.abas) desenharAba(a);
    },
    marcar(id, selo) {
      const a = achar(id); if (!a) return;
      op(() => { a.selo = SELOS.includes(selo) ? selo : null; desenharAba(a); });
    },
    trocarChave(id, chave, dados) {
      const a = achar(id); if (!a || chave == null) return;
      op(() => { a.chave = String(chave); if (dados !== undefined) a.dados = dados; desenharAba(a); });
    },
    abas() { return S ? S.grupos.flatMap((g) => g.abas.map(pub)) : []; },
    porChave(chave) {
      if (!S) return null;
      for (const g of S.grupos) { const a = g.abas.find((x) => x.chave === chave); if (a) return pub(a); }
      return null;
    },
    ativa() { return S && S.foco ? pub(achar(S.foco.ativa)) : null; },
    visivel(id) { const a = achar(id); return !!(a && a.g && a.g.ativa === a.id); },
    grupos() {
      return S ? S.grupos.map((g) => ({ id: g.id, abas: g.abas.map(pub), ativa: g.ativa, tamanho: g.tamanho, foco: g === S.foco })) : [];
    },
    estado() { return S ? estado() : null; },
  };

  window.Abas = api;
})();
