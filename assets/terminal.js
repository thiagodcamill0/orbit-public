// Orbit — terminal integrado: painel inferior com xterm, vários terminais em abas e o PTY no servidor (terminal.mjs).
// Terminal integrado. Expõe window.OrbitTerminal (o nome Terminal é do xterm).
// Nada de innerHTML com dado: nomes, pastas, URLs e mensagens do servidor entram por textContent/atributos.
(() => {
  'use strict';

  const CHAVE = 'gi.terminal';
  // A página roda no navegador da própria máquina: no Mac, os atalhos mostrados são os do Mac (⌘) (16/10).
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const ALT_MIN = 140;            // altura mínima do painel
  const FOLGA = 120;              // o painel nunca passa da altura do main − 120 px
  const ALT_PADRAO = 300;
  const DUR = 240;                // abrir/fechar (ms), com a curva do CSS
  const LIMIAR = 4;               // px até um pointerdown na aba virar arraste
  const PEND_MAX = 512 * 1024;    // saída guardada de um terminal antes do xterm existir
  const RECONEXAO = [1000, 2000, 4000, 8000, 15000];
  const VENDOR = '/terminal/vendor/';
  const NS = 'http://www.w3.org/2000/svg';
  const CURVA = 'cubic-bezier(.2, .8, .2, 1)';
  const FONTE_PADRAO = "'Geist Mono', ui-monospace, monospace";

  // Paleta escura do VS Code (Dark Modern), com vermelho, azul, magenta e cinza clareados até 4,5:1 sobre #141414.
  const TEMA = {
    background: '#141414', foreground: '#d4d4d4', cursor: '#f0f0f0', cursorAccent: '#141414',
    selectionBackground: 'rgba(99, 102, 241, .38)', selectionInactiveBackground: 'rgba(99, 102, 241, .2)',
    scrollbarSliderBackground: 'rgba(255, 255, 255, .1)', scrollbarSliderHoverBackground: 'rgba(255, 255, 255, .18)',
    scrollbarSliderActiveBackground: 'rgba(255, 255, 255, .26)',
    black: '#000000', red: '#d65454', green: '#0dbc79', yellow: '#e5e510', blue: '#3c82ce', magenta: '#c352c3', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#808080', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea',
    brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#f5f5f5',
  };

  const mqMov = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const semMovimento = () => !!(mqMov && mqMov.matches) || document.hidden;

  let S = null; // estado do painel montado

  // ───────────────────────── utilidades ─────────────────────────
  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  const limitar = (v, a, b) => Math.max(a, Math.min(b, v));
  function chamar(fn, ...args) {
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (e) { console.warn('[OrbitTerminal]', e); return undefined; }
  }
  const toast = (t) => { if (S) chamar(S.cfg.toast, String(t)); };
  const bloqueado = () => !!(S && chamar(S.cfg.bloqueado));

  // Ícones próprios (16 × 16, traço de 1,5 px que não escala). Traços fixos do módulo, nunca dado.
  const ICONES = {
    mais: [['path', { d: 'M8 3.5v9M3.5 8h9' }]],
    seta: [['path', { d: 'M4.5 6.5 8 10l3.5-3.5' }]],
    x: [['path', { d: 'M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5' }]],
    maximizar: [['path', { d: 'M4.5 9.75 8 6.25l3.5 3.5' }]],
    restaurar: [['path', { d: 'M4.5 6.25 8 9.75l3.5-3.5' }]],
    minimizar: [['path', { d: 'M3.5 12.5h9' }], ['path', { d: 'M5.25 5.5 8 8.25l2.75-2.75' }]],
    externo: [['path', { d: 'M6.5 4.5h5v5' }], ['path', { d: 'M11.5 4.5 4.5 11.5' }]],
    terminal: [['rect', { x: 2, y: 3, width: 12, height: 10, rx: 2 }], ['path', { d: 'M5 6.5 7 8.25 5 10M8.75 10h2.5' }]],
    desligado: [['rect', { x: 2, y: 3, width: 12, height: 10, rx: 2 }], ['path', { d: 'M5 6.5 7 8.25 5 10' }], ['path', { d: 'M1.5 1.5l13 13' }]],
    alerta: [['circle', { cx: 8, cy: 8, r: 5.75 }], ['path', { d: 'M8 5.25v3.25' }], ['circle', { cx: 8, cy: 10.75, r: .4, fill: 'currentColor' }]],
    ps: [['path', { d: 'M3.75 4.75 7.5 8l-3.75 3.25' }], ['path', { d: 'M8.75 11.5h3.5' }]],
    cmd: [['rect', { x: 2, y: 3, width: 12, height: 10, rx: 2 }], ['path', { d: 'M4.75 7 6.5 8.5 4.75 10' }], ['path', { d: 'M8 10h3' }]],
    bash: [['path', { d: 'M10.4 5.4c-.45-.65-1.3-1.05-2.35-1.05-1.3 0-2.3.7-2.3 1.7 0 2.3 4.6 1.25 4.6 3.75 0 1.05-1.05 1.8-2.45 1.8-1.05 0-1.95-.45-2.4-1.2' }], ['path', { d: 'M8 2.5v1.85M8 11.75v1.75' }]],
    zsh: [['path', { d: 'M11.25 4.25l-6.5 7.5' }], ['circle', { cx: 5.25, cy: 5.25, r: 1.4 }], ['circle', { cx: 10.75, cy: 10.75, r: 1.4 }]],
    pasta: [['path', { d: 'M2.5 5a1 1 0 0 1 1-1h2.8l1.4 1.4h4.8a1 1 0 0 1 1 1V11.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z' }]],
    casa: [['path', { d: 'M3 7.25 8 3l5 4.25V12.5a.5.5 0 0 1-.5.5H9.5V9.75h-3V13h-3a.5.5 0 0 1-.5-.5z' }]],
    copiar: [['rect', { x: 5.5, y: 5.5, width: 7.5, height: 7.5, rx: 1.5 }], ['path', { d: 'M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5' }]],
    colar: [['rect', { x: 3.5, y: 3.5, width: 9, height: 10, rx: 1.5 }], ['path', { d: 'M6 3.5V3a.5.5 0 0 1 .5-.5h3A.5.5 0 0 1 10 3v.5' }], ['path', { d: 'M6 8h4M6 10.5h2.5' }]],
    selecionar: [['rect', { x: 2.75, y: 2.75, width: 10.5, height: 10.5, rx: 1.5, 'stroke-dasharray': '2 1.75' }], ['path', { d: 'M5.5 8h5' }]],
    limpar: [['path', { d: 'M7 12.75h6' }], ['path', { d: 'M3.6 9.4 9.2 3.8a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4L7 12H5.2L3.6 10.4a.7.7 0 0 1 0-1z' }], ['path', { d: 'M6.6 6.4l3 3' }]],
    renomear: [['path', { d: 'M10.25 3.25l2.5 2.5L6 12.5l-3 .5.5-3z' }], ['path', { d: 'M8.75 4.75l2.5 2.5' }]],
    reiniciar: [['path', { d: 'M12.75 8a4.75 4.75 0 1 1-1.4-3.36' }], ['path', { d: 'M12.5 2.75v2.5H10' }]],
  };
  function icone(nome, tam = 16) {
    const s = document.createElementNS(NS, 'svg');
    const at = { width: tam, height: tam, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const k in at) s.setAttribute(k, at[k]);
    for (const [t, a] of ICONES[nome] || []) {
      const p = document.createElementNS(NS, t);
      for (const k in a) p.setAttribute(k, a[k]);
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      s.appendChild(p);
    }
    return s;
  }
  function iconeShell(meta) {
    const id = String((meta && (meta.shell || meta.id)) || '');
    const nome = String((meta && (meta.shellNome || meta.nome)) || '').toLowerCase();
    if (id === 'pwsh' || id === 'powershell') return 'ps';
    if (id === 'cmd') return 'cmd';
    if (id === 'bash' || /bash/.test(nome)) return 'bash';
    if (id === 'zsh' || /zsh|fish/.test(nome)) return 'zsh';
    return 'ps';
  }
  function botao(cls, ic, rot, extra) {
    const b = el('button', cls, Object.assign({ type: 'button', title: rot, 'aria-label': rot }, extra || {}));
    b.appendChild(icone(ic));
    return b;
  }

  // ───────────────────────── persistência ─────────────────────────
  function ler() {
    try {
      const j = JSON.parse(localStorage.getItem(CHAVE) || 'null');
      return j && typeof j === 'object' ? j : {};
    } catch { return {}; }
  }
  function salvar() {
    if (!S) return;
    try {
      localStorage.setItem(CHAVE, JSON.stringify({ v: 1, aberto: S.aberto, altura: Math.round(S.altura), maximizado: S.maximizado, ativo: S.ativo, ordem: S.ordem }));
    } catch {}
  }

  // ───────────────────────── carga preguiçosa do xterm ─────────────────────────
  function injetar(tag, attrs) {
    return new Promise((ok, falha) => {
      const n = document.createElement(tag);
      for (const k in attrs) n[k] = attrs[k];
      n.dataset.termVendor = '';
      n.onload = () => ok(n);
      n.onerror = () => { n.remove(); falha(new Error('não carregou ' + (attrs.src || attrs.href))); };
      document.head.appendChild(n);
    });
  }
  function garantirVendor() {
    if (!S) return Promise.reject(new Error('desmontado'));
    if (S.vendor) return S.vendor;
    S.vendor = (async () => {
      const css = document.querySelector('link[data-term-vendor]') ? Promise.resolve() : injetar('link', { rel: 'stylesheet', href: VENDOR + 'xterm.css' });
      if (typeof window.Terminal !== 'function') await injetar('script', { src: VENDOR + 'xterm.js', async: false });
      const add = [];
      if (!window.FitAddon) add.push(injetar('script', { src: VENDOR + 'addon-fit.js' }));
      if (!window.WebLinksAddon) add.push(injetar('script', { src: VENDOR + 'addon-web-links.js' }));
      if (!window.Unicode11Addon) add.push(injetar('script', { src: VENDOR + 'addon-unicode11.js' }));
      // A fonte precisa estar pronta antes de o xterm medir a célula.
      const fonte = document.fonts && document.fonts.load ? document.fonts.load('12.5px "Geist Mono"').catch(() => {}) : Promise.resolve();
      await Promise.all([css, fonte, ...add]);
      if (typeof window.Terminal !== 'function' || !window.FitAddon) throw new Error('xterm incompleto');
    })();
    S.vendor.then(() => { if (!S) return; S.vendorOk = true; for (const T of S.terms.values()) criarXterm(T); mostrarAtivo(false); },
      () => { if (!S) return; S.vendor = null; S.vendorOk = false; if (S.aberto) mostrarEstado('erro', 'Não foi possível carregar o terminal', 'Confira a conexão com o servidor do Orbit e tente de novo.'); });
    return S.vendor;
  }

  // ───────────────────────── conexão (WebSocket) ─────────────────────────
  async function conectar() {
    if (!S || S.ws || S.conectando || S.disponivel === false) return;
    S.conectando = true;
    clearTimeout(S.timerRec);
    let bilhete = null;
    try {
      const r = await fetch('/terminal/bilhete', { method: 'POST', headers: { 'x-gerenciador': '1' }, cache: 'no-store' });
      if (r.status === 404) { S.conectando = false; indisponivel(); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      bilhete = (await r.json()).bilhete;
      if (typeof bilhete !== 'string' || !bilhete) throw new Error('sem bilhete');
    } catch {
      if (S) { S.conectando = false; agendarReconexao(); }
      return;
    }
    if (!S) return;
    S.conectando = false;
    S.disponivel = true;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws?bilhete=' + encodeURIComponent(bilhete));
    S.ws = ws;
    ws.onopen = () => { if (!S || S.ws !== ws) return; S.conexao = 'aberto'; S.tent = 0; atualizarFaixa(); if (!S.shells) carregarShells(); };
    ws.onmessage = (m) => { if (!S || S.ws !== ws) return; let j; try { j = JSON.parse(m.data); } catch { return; } if (j && typeof j.t === 'string') receber(j); };
    ws.onerror = () => {}; // o close vem logo depois
    ws.onclose = () => {
      if (!S || S.ws !== ws) return;
      S.ws = null; S.conexao = 'desligado'; S.recebeuLista = false;
      atualizarFaixa();
      agendarReconexao();
    };
  }
  function agendarReconexao() {
    if (!S || S.disponivel === false) return;
    clearTimeout(S.timerRec);
    const ms = RECONEXAO[Math.min(S.tent, RECONEXAO.length - 1)];
    S.tent++;
    S.timerRec = setTimeout(conectar, ms);
    atualizarFaixa();
  }
  function indisponivel() {
    if (!S) return;
    S.disponivel = false;
    clearTimeout(S.timerRec);
    atualizarFaixa();
    if (S.aberto) mostrarEstado('indisponivel');
  }
  function enviar(msg) {
    if (!S || !S.ws || S.ws.readyState !== 1) return false;
    try { S.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }
  async function carregarShells() {
    if (!S) return;
    S.shells = [];
    try {
      const r = await fetch('/terminal/shells', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!S) return;
      S.shells = Array.isArray(j.shells) ? j.shells.filter((s) => s && typeof s.id === 'string') : [];
      S.plataforma = typeof j.plataforma === 'string' ? j.plataforma : '';
    } catch { if (S) S.shells = null; } // tenta de novo na próxima conexão
  }

  // ───────────────────────── mensagens do servidor ─────────────────────────
  function receber(j) {
    switch (j.t) {
      case 'lista': return aoLista(Array.isArray(j.terminais) ? j.terminais : []);
      case 'criado': return aoCriado(j.ref, j.term);
      case 'saida': return aoSaida(j.id, j.d, !!j.replay);
      case 'meta': return aoMeta(j.term);
      case 'saiu': return aoSaiu(j.id, j.codigo);
      case 'removido': return aoRemovido(j.id);
      case 'erro': return aoErro(j);
      default: return undefined;
    }
  }
  const metaValida = (m) => m && typeof m === 'object' && (typeof m.id === 'string' || typeof m.id === 'number');
  function aoLista(lista) {
    S.recebeuLista = true;
    const ids = new Set();
    const animar = fotoAbas();
    for (const m of lista) {
      if (!metaValida(m)) continue;
      const id = String(m.id);
      ids.add(id);
      let T = S.terms.get(id);
      if (!T) T = novoLocal(m);
      else {
        T.meta = m;
        // O replay vem logo depois: o xterm recomeça do zero para não duplicar a saída.
        if (T.xt) { try { T.xt.reset(); } catch {} } else { T.pend = []; T.pendTam = 0; }
        T.aviso = false;
        T.env = null;
      }
      if (!m.vivo) agendarAviso(T);
    }
    for (const T of [...S.terms.values()]) if (!ids.has(T.id)) removerLocal(T);
    // Ordem: a salva primeiro (só quem existe), depois os novos na ordem do servidor.
    const servidor = lista.filter(metaValida).map((m) => String(m.id));
    S.ordem = [...S.ordem.filter((id) => ids.has(id)), ...servidor.filter((id) => !S.ordem.includes(id))];
    S.ordem = [...new Set(S.ordem)];
    if (!S.terms.has(S.ativo)) S.ativo = S.ordem[0] || null;
    if (S.terms.size) garantirVendor().catch(() => {});
    renderAbas(animar);
    atualizarTudo();
    // Pedidos de "criar" feitos antes da conexão.
    const fila = S.fila.splice(0);
    for (const msg of fila) enviar(msg);
    if (S.aberto && !S.terms.size && !S.pedidos.size && S.disponivel !== false) api.novo();
    else mostrarAtivo(false);
  }
  function aoCriado(ref, m) {
    if (!metaValida(m)) return;
    const id = String(m.id);
    const meu = typeof ref === 'string' && S.pedidos.has(ref);
    if (meu) S.pedidos.delete(ref);
    const animar = fotoAbas();
    let T = S.terms.get(id);
    if (!T) T = novoLocal(m); else T.meta = m;
    if (!S.ordem.includes(id)) S.ordem.push(id);
    if (meu || !S.ativo) S.ativo = id;
    renderAbas(animar);
    atualizarTudo();
    salvar();
    if (meu) { if (!S.aberto) definirAberto(true); mostrarAtivo(true); }
  }
  function aoSaida(id, d, replay) {
    const T = S.terms.get(String(id));
    if (!T || typeof d !== 'string' || !d) return;
    escrever(T, d, replay);
    if (replay && !T.meta.vivo) agendarAviso(T);
  }
  function aoMeta(m) {
    if (!metaValida(m)) return;
    const T = S.terms.get(String(m.id));
    if (!T) return;
    const voltou = !T.meta.vivo && m.vivo;
    T.meta = m;
    if (voltou) { T.aviso = false; clearTimeout(T.timerAviso); }
    atualizarAba(T);
    atualizarTudo();
  }
  function aoSaiu(id, codigo) {
    const T = S.terms.get(String(id));
    if (!T) return;
    T.meta = Object.assign({}, T.meta, { vivo: false, codigo: codigo === undefined ? T.meta.codigo : codigo, ocupado: false, urls: [] });
    escreverAviso(T);
    atualizarAba(T);
    atualizarTudo();
  }
  function aoRemovido(id) {
    const T = S.terms.get(String(id));
    if (!T) return;
    const animar = fotoAbas();
    const i = S.ordem.indexOf(T.id);
    removerLocal(T);
    if (S.ativo === T.id) S.ativo = S.ordem[Math.min(i, S.ordem.length - 1)] || null;
    renderAbas(animar);
    atualizarTudo();
    salvar();
    if (!S.terms.size && !S.pedidos.size && S.aberto) definirAberto(false); // como no VS Code: fechar o último esconde o painel
    else mostrarAtivo(S.painel.contains(document.activeElement) || S.focarDepois);
    S.focarDepois = false;
  }
  function aoErro(j) {
    const msg = typeof j.msg === 'string' && j.msg ? j.msg : 'Erro no terminal';
    if (typeof j.ref === 'string' && S.pedidos.has(j.ref)) {
      S.pedidos.delete(j.ref);
      atualizarBotaoNovo();
      if (!S.terms.size && S.aberto) { mostrarEstado('erro', msg, 'O servidor não conseguiu abrir o shell.'); return; }
    }
    toast(msg);
  }

  // ───────────────────────── terminais locais ─────────────────────────
  function novoLocal(m) {
    const id = String(m.id);
    const T = { id, meta: m, xt: null, fit: null, aberto: false, pend: [], pendTam: 0, env: null, aviso: false, timerAviso: 0, silencio: 0 };
    T.vista = el('div', 'term-vista', { 'data-id': id, hidden: '' });
    T.vista.addEventListener('contextmenu', (e) => { e.preventDefault(); menuDoCorpo(T, e.clientX, e.clientY); });
    S.corpo.insertBefore(T.vista, S.estado);
    T.aba = criarAba(T);
    S.terms.set(id, T);
    if (S.vendorOk) criarXterm(T);
    return T;
  }
  function removerLocal(T) {
    clearTimeout(T.timerAviso);
    if (S.confirma && S.confirma.T === T) fecharConfirma(false);
    if (S.edicao && S.edicao.T === T) S.edicao = null;
    try { if (T.xt) T.xt.dispose(); } catch {}
    T.xt = null;
    T.vista.remove();
    T.aba.el.remove();
    S.terms.delete(T.id);
    S.ordem = S.ordem.filter((x) => x !== T.id);
  }
  function opcoesXterm() {
    const o = {
      fontFamily: S.fonte, fontSize: 12.5, lineHeight: 1.2, letterSpacing: 0, fontWeight: 400, fontWeightBold: 600,
      cursorStyle: 'bar', cursorBlink: true, cursorWidth: 2, cursorInactiveStyle: 'outline',
      scrollback: 5000, theme: TEMA, allowProposedApi: true, drawBoldTextInBrightColors: true,
      macOptionIsMeta: true, rightClickSelectsWord: false, smoothScrollDuration: 0, scrollOnUserInput: true,
      linkHandler: { activate: (e, texto) => abrirLink(texto), allowNonHttpProtocols: false },
    };
    if (S.dim) { o.cols = S.dim.cols; o.rows = S.dim.rows; }
    if (S.plataforma === 'win32') o.windowsPty = { backend: 'conpty' };
    return o;
  }
  function criarXterm(T) {
    if (T.xt || !S.vendorOk) return;
    let xt;
    try { xt = new window.Terminal(opcoesXterm()); } catch (e) { console.warn('[OrbitTerminal]', e); return; }
    T.xt = xt;
    try { T.fit = new window.FitAddon.FitAddon(); xt.loadAddon(T.fit); } catch { T.fit = null; }
    try { if (window.WebLinksAddon) xt.loadAddon(new window.WebLinksAddon.WebLinksAddon((ev, uri) => abrirLink(uri))); } catch {}
    try { if (window.Unicode11Addon) { xt.loadAddon(new window.Unicode11Addon.Unicode11Addon()); xt.unicode.activeVersion = '11'; } } catch {}
    xt.attachCustomKeyEventHandler((e) => teclaXterm(e, T));
    xt.onData((d) => entrada(T, d));
    for (const p of T.pend) escrever(T, p.d, p.r);
    T.pend = []; T.pendTam = 0;
  }
  function abrirXterm(T) {
    if (!T.xt || T.aberto) return;
    T.vista.hidden = false;
    try { T.xt.open(T.vista); T.aberto = true; } catch (e) { console.warn('[OrbitTerminal]', e); }
  }
  // Respostas automáticas do xterm (foco, posição do cursor, atributos) durante o replay não podem virar digitação no shell.
  const RESPOSTA = /^(\x1b\[[IO]|\x1b\[[\d;?>]*[Rcn]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;
  function escrever(T, d, replay) {
    if (!T.xt) {
      T.pend.push({ d, r: replay });
      T.pendTam += d.length;
      while (T.pendTam > PEND_MAX && T.pend.length > 1) T.pendTam -= T.pend.shift().d.length;
      return;
    }
    if (replay) { T.silencio++; T.xt.write(d, () => { T.silencio = Math.max(0, T.silencio - 1); }); } else T.xt.write(d);
  }
  function agendarAviso(T) {
    clearTimeout(T.timerAviso);
    T.timerAviso = setTimeout(() => { if (S && S.terms.get(T.id) === T && !T.meta.vivo) escreverAviso(T); }, 80);
  }
  function escreverAviso(T) {
    clearTimeout(T.timerAviso);
    if (T.aviso) return;
    T.aviso = true;
    const c = T.meta.codigo;
    const txt = (c === null || c === undefined) ? 'Processo encerrado. Enter reinicia.' : `Processo encerrado (código ${Number(c)}). Enter reinicia.`;
    escrever(T, '\x1b[0m\r\n\x1b[38;2;112;112;112m' + txt + '\x1b[0m\r\n', false);
  }
  function entrada(T, d) {
    if (T.silencio > 0 && RESPOSTA.test(d)) return;
    if (!T.meta.vivo) {
      if (d.includes('\r') && enviar({ t: 'reiniciar', id: T.meta.id })) { T.aviso = false; escrever(T, '\r\n', false); }
      return;
    }
    enviar({ t: 'entrada', id: T.meta.id, d });
  }

  // ───────────────────────── tamanho do xterm ─────────────────────────
  function medirCelula() {
    if (S.celula) return S.celula;
    try {
      const c = document.createElement('canvas').getContext('2d');
      c.font = '12.5px ' + S.fonte;
      const w = c.measureText('W'.repeat(20)).width / 20;
      if (w > 0) S.celula = { w, h: Math.ceil(12.5 * 1.45) };
    } catch {}
    return S.celula || { w: 7.6, h: 18 };
  }
  // Colunas e linhas para um terminal novo: as do ativo (se aberto) ou uma estimativa pelo tamanho do corpo.
  function dimensoes() {
    const T = S.terms.get(S.ativo);
    if (T && T.aberto && T.fit) {
      try { const p = T.fit.proposeDimensions(); if (p && p.cols > 1 && p.rows > 0) return { cols: limitar(p.cols, 2, 500), rows: limitar(p.rows, 1, 300) }; } catch {}
    }
    const c = medirCelula();
    const w = (S.corpo.clientWidth || 800) - 14 - 14;
    const h = (S.corpo.clientHeight || 260) - 8;
    return { cols: limitar(Math.floor(w / c.w), 2, 500), rows: limitar(Math.floor(h / c.h), 1, 300) };
  }
  function ajustar() {
    S.rafAjuste = 0;
    if (!S.aberto || S.painel.classList.contains('animando')) return;
    const T = S.terms.get(S.ativo);
    if (!T || !T.aberto || !T.fit || T.vista.hidden) return;
    try { T.fit.fit(); } catch {}
    const cols = T.xt.cols, rows = T.xt.rows;
    if (cols > 1 && rows > 0) S.dim = { cols, rows };
    if (T.env && T.env.cols === cols && T.env.rows === rows) return;
    if (enviar({ t: 'tamanho', id: T.meta.id, cols: limitar(cols, 2, 500), rows: limitar(rows, 1, 300) })) T.env = { cols, rows };
  }
  function ajustarDepois() { if (S && !S.rafAjuste) S.rafAjuste = requestAnimationFrame(ajustar); }

  // Mostra a vista do ativo (abre o xterm na primeira vez), o estado vazio/erro quando não há terminal.
  function mostrarAtivo(focar) {
    if (!S) return;
    for (const T of S.terms.values()) if (T.id !== S.ativo && !T.vista.hidden) T.vista.hidden = true;
    const T = S.terms.get(S.ativo);
    if (S.disponivel === false) { if (S.aberto) mostrarEstado('indisponivel'); return; }
    if (!T) {
      if (!S.aberto) return;
      if (S.pedidos.size || !S.recebeuLista || (!S.vendorOk && S.vendor)) mostrarEstado('carregando');
      else if (!S.estadoTipo || S.estadoTipo === 'carregando') mostrarEstado('vazio');
      return;
    }
    if (!S.aberto) return;
    if (!T.xt) { mostrarEstado('carregando'); return; }
    mostrarEstado(null);
    T.vista.hidden = false;
    if (!T.aberto) abrirXterm(T);
    if (!T.aberto) return;
    ajustar();
    try { T.xt.refresh(0, T.xt.rows - 1); } catch {}
    if (focar) T.xt.focus();
  }

  // ───────────────────────── painel: abrir, fechar, altura ─────────────────────────
  function alturaMax() { const h = S.painel.parentElement ? S.painel.parentElement.clientHeight : window.innerHeight; return Math.max(ALT_MIN, h - FOLGA); }
  function alturaEfetiva() { return S.maximizado ? alturaMax() : limitar(S.altura, ALT_MIN, alturaMax()); }
  function aplicarAltura() {
    const h = Math.round(alturaEfetiva());
    S.painel.style.setProperty('--term-h', h + 'px');
    S.alca.setAttribute('aria-valuenow', String(h));
    S.alca.setAttribute('aria-valuemin', String(ALT_MIN));
    S.alca.setAttribute('aria-valuemax', String(Math.round(alturaMax())));
    S.btnMax.replaceChildren(icone(S.maximizado ? 'restaurar' : 'maximizar'));
    const r = S.maximizado ? 'Restaurar o tamanho do painel' : 'Maximizar o painel';
    S.btnMax.title = r; S.btnMax.setAttribute('aria-label', r);
    S.btnMax.setAttribute('aria-pressed', String(S.maximizado));
  }
  function definirAberto(sim, animar = true) {
    if (!S || S.aberto === sim) return;
    const p = S.painel;
    if (sim && !p.contains(document.activeElement)) S.focoAntes = document.activeElement;
    const tinhaFoco = p.contains(document.activeElement);
    S.aberto = sim;
    aplicarAltura();
    const anima = animar && !semMovimento();
    p.classList.toggle('sem-anim', !anima);
    p.classList.add('animando');
    // O xterm já fica no tamanho final antes da animação (a casca tem a altura final); só o fit sai no fim.
    if (sim) { S.casca.inert = false; mostrarAtivo(false); }
    // Força o estilo inicial antes de trocar a classe (para a transição acontecer).
    void p.offsetHeight;
    p.classList.toggle('aberto', sim);
    p.setAttribute('aria-hidden', String(!sim));
    if (!sim) {
      fecharMenu(); fecharConfirma(false); terminarEdicao(true);
      if (tinhaFoco) {
        const v = S.focoAntes;
        if (v && v.isConnected && v !== document.body && typeof v.focus === 'function') v.focus({ preventScroll: true });
        else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      }
    }
    clearTimeout(S.timerAnim);
    const fim = () => {
      if (!S) return;
      p.classList.remove('animando', 'sem-anim');
      if (!S.aberto) S.casca.inert = true;
      else { ajustar(); if (S.focarAoAbrir) { S.focarAoAbrir = false; const T = S.terms.get(S.ativo); if (T && T.aberto) T.xt.focus(); } }
    };
    if (anima) S.timerAnim = setTimeout(fim, DUR + 40); else fim();
    atualizarTudo();
    salvar();
  }
  // Troca de altura animada (maximizar, setas): a casca vai direto ao tamanho final e o fit sai uma vez, no fim.
  function animarAltura() {
    const p = S.painel;
    if (semMovimento() || !S.aberto) { aplicarAltura(); ajustarDepois(); return; }
    p.classList.add('animando');
    clearTimeout(S.timerAnim);
    S.timerAnim = setTimeout(() => { if (!S) return; p.classList.remove('animando'); ajustar(); }, DUR + 40);
    aplicarAltura();
  }
  function alternarMax() {
    S.maximizado = !S.maximizado;
    if (!S.aberto) { definirAberto(true); return; }
    animarAltura();
    salvar();
  }

  // Alça: arrastar redimensiona (mín. 140, máx. main − 120), duplo clique maximiza/restaura, setas ajustam.
  function ligarAlca() {
    const a = S.alca;
    let arr = null;
    a.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !S.aberto) return;
      e.preventDefault();
      arr = { y0: e.clientY, h0: alturaEfetiva(), id: e.pointerId };
      try { a.setPointerCapture(e.pointerId); } catch {}
      S.painel.classList.add('arrastando');
      document.documentElement.classList.add('term-redim');
    });
    a.addEventListener('pointermove', (e) => {
      if (!arr || e.pointerId !== arr.id) return;
      const h = limitar(arr.h0 + (arr.y0 - e.clientY), ALT_MIN, alturaMax());
      S.altura = h; S.maximizado = false;
      aplicarAltura();
      ajustarDepois();
    });
    const soltar = (e) => {
      if (!arr || (e && e.pointerId !== arr.id)) return;
      arr = null;
      S.painel.classList.remove('arrastando');
      document.documentElement.classList.remove('term-redim');
      ajustarDepois();
      salvar();
    };
    a.addEventListener('pointerup', soltar);
    a.addEventListener('pointercancel', soltar);
    a.addEventListener('lostpointercapture', soltar);
    a.addEventListener('dblclick', (e) => { e.preventDefault(); alternarMax(); });
    a.addEventListener('keydown', (e) => {
      const passo = e.shiftKey ? 64 : 16;
      let h = null;
      if (e.key === 'ArrowUp') h = alturaEfetiva() + passo;
      else if (e.key === 'ArrowDown') h = alturaEfetiva() - passo;
      else if (e.key === 'Home') h = ALT_MIN;
      else if (e.key === 'End') h = alturaMax();
      else if (e.key === 'Enter') { e.preventDefault(); alternarMax(); return; }
      if (h === null) return;
      e.preventDefault();
      S.altura = limitar(h, ALT_MIN, alturaMax()); S.maximizado = false;
      animarAltura(); salvar();
    });
  }

  // ───────────────────────── abas ─────────────────────────
  function criarAba(T) {
    const a = { el: el('div', 'term-aba', { role: 'tab', tabindex: '-1', 'aria-selected': 'false', 'data-id': T.id }) };
    a.ic = el('span', 'term-aba-ic', { 'aria-hidden': 'true' });
    a.nome = el('span', 'term-aba-nome');
    a.ponto = el('i', 'term-aba-ponto', { 'aria-hidden': 'true' });
    a.x = el('span', 'term-aba-x', { 'aria-hidden': 'true', title: 'Fechar (clique do meio)' });
    a.x.appendChild(icone('x'));
    a.el.append(a.ic, a.nome, a.ponto, a.x);
    a.icNome = '';
    const e = a.el;
    e.addEventListener('pointerdown', (ev) => {
      if (ev.button === 1) { ev.preventDefault(); return; } // sem rolagem automática do clique do meio
      if (ev.button !== 0 || a.x.contains(ev.target) || T.aba.el.classList.contains('editando')) return;
      iniciarArraste(T, ev);
    });
    e.addEventListener('click', (ev) => {
      if (S.semClique) return;
      if (a.x.contains(ev.target)) { ev.stopPropagation(); fechar(T.id); return; }
      if (e.classList.contains('editando')) return;
      ativar(T.id, true);
    });
    e.addEventListener('auxclick', (ev) => { if (ev.button === 1) { ev.preventDefault(); fechar(T.id); } });
    e.addEventListener('dblclick', (ev) => { if (!a.x.contains(ev.target)) { ev.preventDefault(); renomear(T.id); } });
    e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ativar(T.id, false); menuDaAba(T, ev.clientX, ev.clientY); });
    e.addEventListener('keydown', (ev) => {
      if (e.classList.contains('editando')) return;
      const i = S.ordem.indexOf(T.id);
      const ir = (k) => { ev.preventDefault(); const id = S.ordem[(k + S.ordem.length) % S.ordem.length]; ativar(id, false); const n = S.terms.get(id); if (n) n.aba.el.focus(); };
      if (ev.key === 'ArrowRight') ir(i + 1);
      else if (ev.key === 'ArrowLeft') ir(i - 1);
      else if (ev.key === 'Home') ir(0);
      else if (ev.key === 'End') ir(S.ordem.length - 1);
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ativar(T.id, true); }
      else if (ev.key === 'F2') { ev.preventDefault(); renomear(T.id); }
      else if (ev.key === 'Delete' || (MAC && ev.key === 'Backspace')) { ev.preventDefault(); fechar(T.id); } // o Mac não tem Delete à parte: ⌫
      else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) { ev.preventDefault(); const r = e.getBoundingClientRect(); menuDaAba(T, r.left + 8, r.bottom); }
    });
    return a;
  }
  function atualizarAba(T) {
    const a = T.aba, m = T.meta;
    const ic = iconeShell(m);
    if (a.icNome !== ic) { a.icNome = ic; a.ic.replaceChildren(icone(ic, 14)); }
    if (!a.el.classList.contains('editando')) a.nome.textContent = String(m.nome || m.shellNome || 'Terminal');
    const ativa = T.id === S.ativo;
    a.el.classList.toggle('ativa', ativa);
    a.el.setAttribute('aria-selected', String(ativa));
    a.el.tabIndex = ativa ? 0 : -1;
    a.el.classList.toggle('ocupado', !!(m.vivo && m.ocupado));
    a.el.classList.toggle('morto', !m.vivo);
    const linhas = [String(m.nome || 'Terminal') + (m.shellNome ? ' — ' + m.shellNome : '')];
    if (m.cwd) linhas.push(String(m.cwd));
    if (!m.vivo) linhas.push(m.codigo === null || m.codigo === undefined ? 'Processo encerrado' : `Processo encerrado (código ${Number(m.codigo)})`);
    else if (m.ocupado) linhas.push('Rodando um comando');
    a.el.title = linhas.join('\n');
    a.el.setAttribute('aria-label', linhas.join(', '));
  }
  // FLIP das abas: onde cada uma está antes da mudança; depois, as vizinhas deslizam e as novas surgem.
  function fotoAbas() {
    if (!S || semMovimento() || typeof Element.prototype.animate !== 'function') return null;
    const m = new Map();
    for (const T of S.terms.values()) if (T.aba.el.isConnected) m.set(T.aba.el, { left: T.aba.el.getBoundingClientRect().left, x: T.aba.el.offsetLeft, w: T.aba.el.offsetWidth, T });
    return m;
  }
  function anim(n, quadros, ms) {
    try {
      for (const k of n.getAnimations()) if (k.id === 'term') k.cancel();
      const k = n.animate(quadros, { duration: ms, easing: CURVA });
      k.id = 'term';
      return k;
    } catch { return null; }
  }
  function renderAbas(f) {
    const lista = S.lista;
    S.ordem.forEach((id, k) => {
      const T = S.terms.get(id);
      if (!T) return;
      atualizarAba(T);
      const atual = lista.children[k];
      if (atual !== T.aba.el) lista.insertBefore(T.aba.el, atual || null);
    });
    for (const n of [...lista.children]) if (!S.ordem.includes(n.dataset.id || '') && !n.classList.contains('term-aba-sai')) n.remove();
    if (!f) return;
    const pres = new Set();
    for (const id of S.ordem) {
      const T = S.terms.get(id);
      if (!T) continue;
      const n = T.aba.el;
      pres.add(n);
      if (S.arr && S.arr.T === T && S.arr.ativo) continue;
      const ant = f.get(n);
      if (!ant) { anim(n, [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], 200); continue; }
      const dx = ant.left - n.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) anim(n, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }], 210);
    }
    for (const [n, ant] of f) {
      if (pres.has(n)) continue;
      // Reflexo da aba que saiu, sumindo no lugar.
      const g = el('div', 'term-aba-sai' + (ant.T.id === S.ativo ? ' ativa' : ''), { 'aria-hidden': 'true' });
      g.style.left = ant.x + 'px'; g.style.width = ant.w + 'px';
      g.append(ant.T.aba.ic.cloneNode(true), ant.T.aba.nome.cloneNode(true));
      lista.appendChild(g);
      const k = anim(g, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], 150);
      if (k) k.onfinish = k.oncancel = () => g.remove(); else g.remove();
    }
  }
  function aVista(T) {
    const n = T && T.aba.el, l = S.lista;
    if (!n || !n.isConnected) return;
    const a = n.offsetLeft, b = a + n.offsetWidth;
    if (a < l.scrollLeft) l.scrollLeft = a - 6;
    else if (b > l.scrollLeft + l.clientWidth) l.scrollLeft = b - l.clientWidth + 6;
  }
  function ativar(id, focar) {
    const T = S.terms.get(String(id));
    if (!T) return;
    if (S.ativo !== T.id) {
      S.ativo = T.id;
      for (const x of S.terms.values()) atualizarAba(x);
      salvar();
      atualizarChip();
    }
    aVista(T);
    if (!S.aberto) { S.focarAoAbrir = !!focar; definirAberto(true); return; }
    mostrarAtivo(focar);
  }

  // Arrastar para reordenar: a aba segue o cursor; ao cruzar o centro da vizinha, troca de lugar (FLIP).
  function iniciarArraste(T, ev) {
    const n = T.aba.el;
    S.arr = { T, x0: ev.clientX, y0: ev.clientY, id: ev.pointerId, ativo: false, pega: 0 };
    try { n.setPointerCapture(ev.pointerId); } catch {}
    const mover = (e) => {
      const a = S && S.arr;
      if (!a || e.pointerId !== a.id) return;
      if (!a.ativo) {
        if (Math.abs(e.clientX - a.x0) < LIMIAR && Math.abs(e.clientY - a.y0) < LIMIAR) return;
        a.ativo = true;
        a.pega = a.x0 - n.getBoundingClientRect().left;
        n.classList.add('arrastada');
        S.lista.classList.add('arrastando');
        fecharMenu();
      }
      const lr = S.lista.getBoundingClientRect();
      const esq = e.clientX - a.pega;                 // onde a borda esquerda da aba deveria estar
      const centro = esq - lr.left + S.lista.scrollLeft + n.offsetWidth / 2;
      const outros = S.ordem.filter((id) => id !== T.id);
      let ind = 0;
      for (const id of outros) { const o = S.terms.get(id).aba.el; if (o.offsetLeft + o.offsetWidth / 2 < centro) ind++; }
      if (S.ordem.indexOf(T.id) !== ind) {
        const f = fotoAbas();
        outros.splice(ind, 0, T.id);
        S.ordem = outros;
        renderAbas(f);
      }
      // Posição natural (sem transform) na tela; a aba não sai da barra.
      const nat = lr.left - S.lista.scrollLeft + n.offsetLeft;
      const dx = limitar(esq - nat, lr.left - 6 - nat, lr.right - n.offsetWidth + 6 - nat);
      n.style.transform = `translateX(${dx}px)`;
    };
    const fim = (e) => {
      const a = S && S.arr;
      if (!a || (e && e.pointerId !== a.id)) return;
      n.removeEventListener('pointermove', mover);
      n.removeEventListener('pointerup', fim);
      n.removeEventListener('pointercancel', fim);
      n.removeEventListener('lostpointercapture', fim);
      S.arr = null;
      if (!a.ativo) return;
      S.semClique = true;
      setTimeout(() => { if (S) S.semClique = false; }, 0);
      const dx = parseFloat((n.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
      n.style.transform = '';
      n.classList.remove('arrastada');
      S.lista.classList.remove('arrastando');
      if (dx && !semMovimento()) anim(n, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }], 180);
      salvar();
    };
    n.addEventListener('pointermove', mover);
    n.addEventListener('pointerup', fim);
    n.addEventListener('pointercancel', fim);
    n.addEventListener('lostpointercapture', fim);
  }

  // Renomear no lugar: Enter grava, Esc desiste, sair do campo grava.
  function renomear(id) {
    const T = S.terms.get(String(id));
    if (!T) return;
    if (!S.aberto) definirAberto(true);
    terminarEdicao(true);
    const a = T.aba;
    const atual = String(T.meta.nome || '');
    const inp = el('input', 'term-aba-ed', { type: 'text', maxlength: '40', spellcheck: 'false', 'aria-label': 'Nome do terminal', autocomplete: 'off' });
    inp.value = atual;
    inp.style.width = Math.max(6, Math.min(24, atual.length + 2)) + 'ch';
    a.el.classList.add('editando');
    a.nome.replaceChildren(inp);
    S.edicao = { T, inp, atual };
    inp.addEventListener('input', () => { inp.style.width = Math.max(6, Math.min(24, inp.value.length + 2)) + 'ch'; });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); terminarEdicao(false, true); }
      else if (e.key === 'Escape') { e.preventDefault(); terminarEdicao(true, true); }
    });
    inp.addEventListener('blur', () => terminarEdicao(false));
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('dblclick', (e) => e.stopPropagation());
    aVista(T);
    inp.focus();
    inp.select();
  }
  function terminarEdicao(cancelar, voltarFoco) {
    const ed = S && S.edicao;
    if (!ed) return;
    S.edicao = null;
    const T = ed.T, a = T.aba;
    const novo = ed.inp.value.trim().slice(0, 40);
    a.el.classList.remove('editando');
    a.nome.replaceChildren();
    if (!cancelar && novo && novo !== ed.atual && enviar({ t: 'renomear', id: T.meta.id, nome: novo })) T.meta = Object.assign({}, T.meta, { nome: novo });
    atualizarAba(T);
    if (voltarFoco && S.terms.get(S.ativo) === T && T.aberto) T.xt.focus();
  }

  // Fechar: terminal ocupado pede confirmação no próprio painel.
  function fechar(id) {
    const T = S.terms.get(String(id));
    if (!T) return;
    if (T.meta.vivo && T.meta.ocupado) { confirmarFechar(T); return; }
    fecharJa(T);
  }
  function fecharJa(T) {
    S.focarDepois = S.painel.contains(document.activeElement);
    if (!enviar({ t: 'fechar', id: T.meta.id })) toast('Sem conexão com o terminal. Tente de novo em instantes.');
  }
  function confirmarFechar(T) {
    fecharConfirma(false);
    if (!S.aberto) definirAberto(true);
    if (S.ativo !== T.id) ativar(T.id, false);
    const c = el('div', 'term-conf', { role: 'alertdialog', 'aria-modal': 'false', 'aria-labelledby': 'term-conf-tit', 'aria-describedby': 'term-conf-txt' });
    const tit = el('div', 'term-conf-tit', { id: 'term-conf-tit' });
    tit.textContent = `Encerrar “${String(T.meta.nome || 'Terminal')}”?`;
    const txt = el('div', 'term-conf-txt', { id: 'term-conf-txt' });
    txt.textContent = 'Há um processo rodando neste terminal. Fechar encerra o processo e tudo o que ele abriu.';
    const acoes = el('div', 'term-conf-acoes');
    const nao = el('button', 'term-bt', { type: 'button' }); nao.textContent = 'Cancelar';
    const sim = el('button', 'term-bt primario', { type: 'button' }); sim.textContent = 'Encerrar';
    acoes.append(nao, sim);
    c.append(tit, txt, acoes);
    nao.addEventListener('click', () => fecharConfirma(true));
    sim.addEventListener('click', () => { fecharConfirma(false); fecharJa(T); });
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharConfirma(true); }
      else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === nao ? sim : nao).focus(); }
    });
    S.corpo.appendChild(c);
    S.confirma = { el: c, T };
    nao.focus({ preventScroll: true });
  }
  function fecharConfirma(voltarFoco) {
    const c = S && S.confirma;
    if (!c) return;
    S.confirma = null;
    c.el.remove();
    if (voltarFoco) { const T = S.terms.get(S.ativo); if (T && T.aberto) T.xt.focus(); }
  }

  // ───────────────────────── menus ─────────────────────────
  function fecharMenu(voltar) {
    const m = S && S.menu;
    if (!m) return;
    S.menu = null;
    m.el.remove();
    document.removeEventListener('pointerdown', m.fora, true);
    window.removeEventListener('blur', m.sair);
    window.removeEventListener('resize', m.sair);
    if (m.dona && m.dona.getAttribute('aria-haspopup')) m.dona.setAttribute('aria-expanded', 'false');
    if (voltar && m.dona && m.dona.isConnected) m.dona.focus({ preventScroll: true });
  }
  // itens: [{ rot, ic?, kbd?, dica?, off?, acao }], '-' (separador) ou { tit }. ancora: { x, y } ou um DOMRect (abre embaixo ou em cima).
  function abrirMenu(itens, ancora, dona, opc = {}) {
    fecharMenu();
    const m = { el: el('div', 'term-menu', { role: 'menu', 'aria-label': opc.rotulo || 'Menu' }), dona };
    const botoes = [];
    let antSep = true;
    itens.forEach((it, k) => {
      if (it === '-') {
        if (!antSep && k < itens.length - 1) { m.el.appendChild(el('div', 'term-menu-sep', { role: 'separator' })); antSep = true; }
        return;
      }
      if (it.tit) { const t = el('div', 'term-menu-tit', { role: 'presentation' }); t.textContent = it.tit; m.el.appendChild(t); antSep = false; return; }
      antSep = false;
      const b = el('button', 'term-mi', { type: 'button', role: 'menuitem', tabindex: '-1' });
      if (it.ic) { const s = el('span', 'term-mi-ic', { 'aria-hidden': 'true' }); s.appendChild(icone(it.ic)); b.appendChild(s); }
      const r = el('span', 'term-mi-rot'); r.textContent = String(it.rot); b.appendChild(r);
      if (it.dica) { const d = el('span', 'term-mi-dica'); d.textContent = String(it.dica); b.appendChild(d); }
      if (it.kbd) { const kb = el('kbd'); kb.textContent = it.kbd; b.appendChild(kb); }
      if (it.titulo) b.title = String(it.titulo);
      if (it.off) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', () => { if (it.off) return; fecharMenu(!it.semVoltar); it.acao(); });
      b.addEventListener('pointermove', () => { if (document.activeElement !== b) b.focus({ preventScroll: true }); });
      m.el.appendChild(b); botoes.push(b);
    });
    while (m.el.lastElementChild && /term-menu-(sep|tit)/.test(m.el.lastElementChild.className)) m.el.lastElementChild.remove();
    m.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const i = botoes.indexOf(document.activeElement);
      const ir = (n) => { e.preventDefault(); if (botoes.length) botoes[(n + botoes.length) % botoes.length].focus({ preventScroll: true }); };
      if (e.key === 'ArrowDown') ir(i + 1);
      else if (e.key === 'ArrowUp') ir(i < 0 ? botoes.length - 1 : i - 1);
      else if (e.key === 'Home') ir(0);
      else if (e.key === 'End') ir(botoes.length - 1);
      else if (e.key === 'Escape') { e.preventDefault(); fecharMenu(true); }
      else if (e.key === 'Tab') { e.preventDefault(); fecharMenu(true); }
    });
    m.el.addEventListener('contextmenu', (e) => e.preventDefault());
    // O botão que abriu (▾) alterna o menu no próprio clique; qualquer outro clique fora fecha.
    m.fora = (e) => { if (!m.el.contains(e.target) && !(dona && dona.getAttribute('aria-haspopup') && dona.contains(e.target))) fecharMenu(); };
    m.sair = () => fecharMenu();
    document.body.appendChild(m.el);
    const r = m.el.getBoundingClientRect();
    let x, y;
    if (ancora && 'bottom' in ancora) {
      x = opc.direita ? ancora.right - r.width : ancora.left;
      y = ancora.bottom + 4;
      if (y + r.height > window.innerHeight - 8) { y = ancora.top - r.height - 4; m.el.classList.add('acima'); }
    } else {
      x = ancora.x; y = ancora.y;
      if (y + r.height > window.innerHeight - 8) { y = Math.max(8, y - r.height); m.el.classList.add('acima'); }
    }
    m.el.style.left = Math.round(limitar(x, 8, window.innerWidth - r.width - 8)) + 'px';
    m.el.style.top = Math.round(limitar(y, 8, Math.max(8, window.innerHeight - r.height - 8))) + 'px';
    S.menu = m;
    if (dona && dona.getAttribute('aria-haspopup')) dona.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', m.fora, true);
    window.addEventListener('blur', m.sair);
    window.addEventListener('resize', m.sair);
    const pri = botoes.find((b) => !b.hasAttribute('aria-disabled')) || botoes[0];
    if (pri) pri.focus({ preventScroll: true });
  }
  function menuDaAba(T, x, y) {
    const itens = [
      { rot: 'Renomear', ic: 'renomear', kbd: 'F2', acao: () => renomear(T.id), semVoltar: true },
    ];
    if (!T.meta.vivo) itens.push({ rot: 'Reiniciar', ic: 'reiniciar', acao: () => { if (enviar({ t: 'reiniciar', id: T.meta.id })) { T.aviso = false; escrever(T, '\r\n', false); } ativar(T.id, true); }, semVoltar: true });
    itens.push({ rot: 'Limpar', ic: 'limpar', off: !T.xt, acao: () => { if (T.xt) T.xt.clear(); ativar(T.id, true); }, semVoltar: true },
      '-',
      { rot: 'Fechar', ic: 'x', kbd: MAC ? '⌫' : 'Del', acao: () => fechar(T.id), semVoltar: true });
    abrirMenu(itens, { x, y }, T.aba.el, { rotulo: 'Ações do terminal' });
  }
  function menuDoCorpo(T, x, y) {
    if (!T.xt) return;
    const sel = T.xt.hasSelection();
    abrirMenu([
      { rot: 'Copiar', ic: 'copiar', kbd: MAC ? '⌘C' : 'Ctrl+C', off: !sel, acao: () => { copiar(T); T.xt.focus(); }, semVoltar: true },
      { rot: 'Colar', ic: 'colar', kbd: MAC ? '⌘V' : 'Ctrl+V', acao: () => colar(T), semVoltar: true },
      { rot: 'Selecionar tudo', ic: 'selecionar', acao: () => { T.xt.selectAll(); T.xt.focus(); }, semVoltar: true },
      '-',
      { rot: 'Limpar', ic: 'limpar', acao: () => { T.xt.clear(); T.xt.focus(); }, semVoltar: true },
    ], { x, y }, null, { rotulo: 'Terminal' });
  }
  function menuNovo() {
    const itens = [];
    const shells = Array.isArray(S.shells) && S.shells.length ? S.shells : [{ id: '', nome: 'Shell padrão', padrao: true }];
    for (const s of shells) {
      itens.push({ rot: String(s.nome || s.id), ic: iconeShell(s), dica: s.padrao ? 'padrão' : '', kbd: s.padrao ? 'Ctrl+Shift+`' : '',
        acao: () => api.novo(s.id ? { shell: s.id } : {}), semVoltar: true });
    }
    const projetos = chamar(S.cfg.projetos);
    if (Array.isArray(projetos)) {
      const atual = chamar(S.cfg.projetoAtual);
      itens.push('-', { tit: 'Abrir em:' });
      for (const p of projetos.slice(0, 40)) {
        if (!p || typeof p.nome !== 'string' || !p.nome) continue;
        itens.push({ rot: p.nome, ic: 'pasta', dica: p.nome === atual ? 'atual' : '', titulo: typeof p.pasta === 'string' ? p.pasta : '',
          acao: () => api.novo({ projeto: p.nome }), semVoltar: true });
      }
      itens.push({ rot: 'Pasta pessoal', ic: 'casa', acao: () => api.novo({ projeto: null }), semVoltar: true });
    }
    abrirMenu(itens, S.btnShells.getBoundingClientRect(), S.btnShells, { direita: true, rotulo: 'Novo terminal' });
  }

  // ───────────────────────── copiar, colar, links ─────────────────────────
  function copiarTexto(t) {
    let pr;
    try { pr = navigator.clipboard.writeText(t); } catch (e) { pr = Promise.reject(e); }
    return Promise.resolve(pr).catch(() => {
      // Reserva: textarea temporário + execCommand (contexto sem a API de área de transferência).
      const ta = el('textarea', '', { 'aria-hidden': 'true' });
      ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      const antes = document.activeElement;
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      if (antes && antes.focus) antes.focus({ preventScroll: true });
      if (!ok) throw new Error('sem cópia');
    });
  }
  function copiar(T) {
    if (!T.xt || !T.xt.hasSelection()) return;
    const t = T.xt.getSelection();
    if (!t) return;
    copiarTexto(t).catch(() => toast('Não foi possível copiar'));
  }
  function colar(T) {
    if (!T.xt) return;
    let pr;
    try { pr = navigator.clipboard.readText(); } catch (e) { pr = Promise.reject(e); }
    Promise.resolve(pr).then((t) => { if (t && T.xt) T.xt.paste(t); if (T.xt) T.xt.focus(); },
      () => { toast(MAC ? 'Use ⌘V para colar no terminal' : 'Use Ctrl+V para colar no terminal'); if (T.xt) T.xt.focus(); });
  }
  const ehLocal = (h) => h === 'localhost' || h === '0.0.0.0' || h === '[::1]' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
  function abrirLink(uri) {
    let u;
    try { u = new URL(String(uri)); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.hostname === '0.0.0.0') u.hostname = 'localhost';
    if (ehLocal(u.hostname)) abrirUrl(u.href);
    else window.open(u.href, '_blank', 'noopener');
  }
  function abrirUrl(url) {
    if (typeof S.cfg.abrirUrl === 'function') { chamar(S.cfg.abrirUrl, url); return; }
    const o = window.Orbit;
    if (o && typeof o.abrirNavegador === 'function') { try { o.abrirNavegador(url); return; } catch (e) { console.warn('[OrbitTerminal]', e); } }
    window.open(url, '_blank', 'noopener');
  }

  // ───────────────────────── teclado ─────────────────────────
  // Ctrl+` alterna (também e.code Backquote e o ` do ABNT2, que é Shift+´); Ctrl+Shift+` cria um terminal.
  function ehAlternar(e) {
    if (!e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.code === 'Backquote') return !e.shiftKey;
    if (e.key === '`') return true;
    return e.key === 'Dead' && e.code === 'BracketLeft' && e.shiftKey;
  }
  const ehNovo = (e) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Backquote';
  // Atalhos das abas (assets/abas.js) que, com o foco no xterm, são do shell. Devolve o que o xterm mandaria.
  function seqDasAbas(e) {
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey, alt = e.altKey && !e.ctrlKey && !e.metaKey;
    if (e.code === 'KeyW' && !e.shiftKey) { if (ctrl) return '\x17'; if (alt) return '\x1bw'; }
    if (ctrl && e.key === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t';
    if (alt && !e.shiftKey && e.key === 'PageUp') return '\x1b[5;3~';
    if (alt && !e.shiftKey && e.key === 'PageDown') return '\x1b[6;3~';
    if (ctrl && !e.shiftKey && (e.key === '\\' || e.code === 'Backslash' || e.code === 'IntlBackslash')) return '\x1c';
    return null;
  }
  function termDoAlvo(alvo) {
    const v = alvo && alvo.closest ? alvo.closest('.term-vista') : null;
    return v && S && S.painel.contains(v) ? S.terms.get(v.dataset.id) || null : null;
  }
  // Ouvinte em captura no window, registrado na carga do script (antes do montar das abas, que também escuta ali).
  function guarda(e) {
    if (!S || e.isComposing) return;
    if (ehAlternar(e) || ehNovo(e)) {
      if (bloqueado()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (ehNovo(e)) api.novo(); else { S.focarAoAbrir = true; api.alternar(); }
      return;
    }
    const T = termDoAlvo(e.target);
    if (!T || !T.xt) return;
    const seq = seqDasAbas(e);
    if (seq === null) return;
    // As abas não fecham nem trocam nada; o shell recebe a tecla como receberia num terminal comum.
    e.preventDefault();
    e.stopImmediatePropagation();
    T.xt.input(seq, true);
  }
  window.addEventListener('keydown', guarda, true);

  function teclaXterm(e, T) {
    if (ehAlternar(e) || ehNovo(e)) return false; // sobe para a guarda
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    if (ctrl && e.code === 'KeyC') {
      if (e.shiftKey) { e.preventDefault(); copiar(T); return false; }
      if (T.xt.hasSelection()) { e.preventDefault(); copiar(T); T.xt.clearSelection(); return false; }
      return true; // sem seleção: ^C
    }
    if (ctrl && e.code === 'KeyV') return false; // o navegador cola no textarea do xterm (colagem entre colchetes)
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10' && !e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      const r = T.vista.getBoundingClientRect();
      menuDoCorpo(T, r.left + 40, r.top + 30);
      return false;
    }
    return true;
  }

  // ───────────────────────── indicador, chip, estados ─────────────────────────
  function rodando() { let n = 0; if (S) for (const T of S.terms.values()) if (T.meta.vivo && T.meta.ocupado) n++; return n; }
  function atualizarTudo() {
    if (!S) return;
    const n = rodando();
    for (const b of S.botoes) {
      b.el.setAttribute('aria-pressed', String(S.aberto));
      b.el.classList.toggle('term-rodando', n > 0);
      if (b.n) b.n.textContent = n ? String(n) : '';
      b.el.setAttribute('aria-label', n ? `Terminal, ${n} ${n === 1 ? 'processo rodando' : 'processos rodando'}` : 'Terminal');
    }
    atualizarChip();
    atualizarFaixa();
    atualizarBotaoNovo();
  }
  function rotuloUrl(url) {
    try { const u = new URL(url); return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : ''); } catch { return String(url); }
  }
  function atualizarChip() {
    const T = S.terms.get(S.ativo);
    const urls = T && T.meta.vivo && Array.isArray(T.meta.urls) ? T.meta.urls.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
    const url = urls[0] || '';
    if (!url) { S.chip.hidden = true; S.chip.dataset.url = ''; return; }
    if (S.chip.dataset.url === url && !S.chip.hidden) return;
    S.chip.dataset.url = url;
    S.chipTxt.textContent = rotuloUrl(url);
    S.chip.title = `Abrir ${url} no navegador do Orbit`;
    S.chip.setAttribute('aria-label', `Abrir ${rotuloUrl(url)} no navegador do Orbit`);
    S.chip.hidden = false;
    if (!semMovimento()) { S.chip.classList.remove('surge'); void S.chip.offsetWidth; S.chip.classList.add('surge'); }
  }
  function atualizarFaixa() {
    if (!S) return;
    const caiu = S.disponivel !== false && S.conexao !== 'aberto' && S.terms.size > 0;
    S.faixa.hidden = !caiu;
  }
  function atualizarBotaoNovo() {
    if (!S) return;
    S.btnNovo.setAttribute('aria-busy', String(S.pedidos.size > 0));
  }
  const ESTADOS = {
    carregando: { ic: null, tit: 'Abrindo o terminal…', sub: '' },
    vazio: { ic: 'terminal', tit: 'Nenhum terminal aberto', sub: 'Abra um shell na pasta do projeto selecionado.', acao: 'Novo terminal', kbd: 'Ctrl+Shift+`' },
    indisponivel: { ic: 'desligado', tit: 'O terminal não está disponível neste servidor', sub: 'Atualize e reinicie o servidor do Orbit para usar o terminal integrado.' },
    erro: { ic: 'alerta', tit: 'Não foi possível abrir o terminal', sub: '', acao: 'Tentar de novo' },
  };
  function mostrarEstado(tipo, tit, sub) {
    if (!S) return;
    S.estadoTipo = tipo || null;
    const E = S.estado;
    if (!tipo) { E.hidden = true; return; }
    const d = ESTADOS[tipo];
    const ic = el('div', d.ic ? 'term-estado-ic' : 'term-pontos', { 'aria-hidden': 'true' });
    if (d.ic) ic.appendChild(icone(d.ic, 20)); else ic.append(el('i'), el('i'), el('i'));
    const t = el('div', 'term-estado-tit'); t.textContent = tit || d.tit;
    const s = el('div', 'term-estado-sub'); s.textContent = sub === undefined ? d.sub : sub;
    const filhos = [ic, t, s];
    if (d.acao) {
      const b = el('button', 'term-estado-acao', { type: 'button' });
      b.appendChild(icone(tipo === 'erro' ? 'reiniciar' : 'mais'));
      const r = el('span'); r.textContent = d.acao; b.appendChild(r);
      if (d.kbd) { const k = el('kbd'); k.textContent = d.kbd; b.appendChild(k); }
      b.addEventListener('click', () => {
        if (tipo === 'erro' && !S.vendorOk) { S.vendor = null; mostrarEstado('carregando'); garantirVendor().then(() => { if (!S.terms.size) api.novo(); }, () => {}); }
        else api.novo();
      });
      filhos.push(b);
    }
    E.replaceChildren(...filhos);
    E.setAttribute('role', tipo === 'erro' || tipo === 'indisponivel' ? 'alert' : 'status');
    E.hidden = false;
  }

  // ───────────────────────── montagem ─────────────────────────
  function montarBotoes(lista) {
    const r = [];
    for (const b of lista || []) {
      if (!(b instanceof Element)) continue;
      const ic = [...b.children].find((c) => c.matches('svg, [data-icone]'));
      let ind = b.querySelector('.term-ind');
      if (!ind) {
        ind = el('i', 'term-ind', { 'aria-hidden': 'true' });
        if (ic) { const w = el('span', 'term-ic'); b.insertBefore(w, ic); w.append(ic, ind); } else b.appendChild(ind);
      }
      b.title = 'Terminal (Ctrl+`)';
      b.setAttribute('aria-keyshortcuts', 'Control+`');
      b.setAttribute('aria-controls', S.painel.id || '');
      const fn = (e) => { e.preventDefault(); S.focarAoAbrir = true; api.alternar(); };
      b.addEventListener('click', fn);
      r.push({ el: b, n: b.querySelector('.n'), ind, fn });
    }
    return r;
  }
  function construir() {
    const p = S.painel;
    p.replaceChildren();
    p.classList.add('term-painel');
    p.setAttribute('role', 'region');
    p.setAttribute('aria-label', 'Terminal');
    p.setAttribute('aria-hidden', 'true');
    S.alca = el('div', 'term-alca', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Redimensionar o terminal', tabindex: '0', title: 'Arraste para redimensionar · duplo clique maximiza' });
    S.casca = el('div', 'term-casca');
    S.casca.inert = true;
    const barra = el('div', 'term-barra');
    S.lista = el('div', 'term-abas', { role: 'tablist', 'aria-label': 'Terminais' });
    const acoes = el('div', 'term-acoes');
    S.chip = el('button', 'term-chip', { type: 'button', hidden: '' });
    S.chipTxt = el('span', 'term-chip-txt');
    const seta = icone('externo', 11); seta.setAttribute('class', 'term-chip-seta');
    S.chip.append(el('i', 'term-chip-ponto', { 'aria-hidden': 'true' }), S.chipTxt, seta);
    const grupo = el('div', 'term-novo');
    S.btnNovo = botao('term-btn', 'mais', 'Novo terminal (Ctrl+Shift+`)');
    S.btnShells = botao('term-btn estreito', 'seta', 'Escolher o shell ou a pasta', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    grupo.append(S.btnNovo, S.btnShells);
    S.btnMax = botao('term-btn', 'maximizar', 'Maximizar o painel', { 'aria-pressed': 'false' });
    S.btnMin = botao('term-btn', 'minimizar', 'Minimizar (Ctrl+`)');
    acoes.append(S.chip, grupo, el('span', 'term-sep', { 'aria-hidden': 'true' }), S.btnMax, S.btnMin);
    barra.append(S.lista, acoes);
    S.corpo = el('div', 'term-corpo');
    S.estado = el('div', 'term-estado', { hidden: '' });
    S.faixa = el('div', 'term-faixa', { hidden: '', role: 'status' });
    const ft = el('span'); ft.textContent = 'Reconectando ao terminal…';
    S.faixa.append(el('i', '', { 'aria-hidden': 'true' }), ft);
    S.corpo.append(S.estado, S.faixa);
    S.casca.append(barra, S.corpo);
    p.append(S.alca, S.casca);

    S.btnNovo.addEventListener('click', () => api.novo());
    S.btnShells.addEventListener('click', () => { if (S.menu && S.menu.dona === S.btnShells) fecharMenu(); else menuNovo(); });
    S.btnMax.addEventListener('click', alternarMax);
    S.btnMin.addEventListener('click', () => api.minimizar());
    S.chip.addEventListener('click', () => { const u = S.chip.dataset.url; if (u) abrirLink(u); });
    barra.addEventListener('dblclick', (e) => { if (e.target === barra || e.target === S.lista) api.novo(); });
    S.lista.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || S.lista.scrollWidth <= S.lista.clientWidth) return;
      e.preventDefault();
      S.lista.scrollLeft += e.deltaY;
    }, { passive: false });
    p.addEventListener('focusin', () => p.classList.add('foco'));
    p.addEventListener('focusout', (e) => { if (!p.contains(e.relatedTarget)) p.classList.remove('foco'); });
    ligarAlca();
    if (window.ResizeObserver) {
      S.ro = new ResizeObserver(() => ajustarDepois());
      S.ro.observe(S.corpo);
      if (p.parentElement) {
        S.roMain = new ResizeObserver(() => { if (S) { aplicarAltura(); ajustarDepois(); } });
        S.roMain.observe(p.parentElement);
      }
    }
  }
  function desmontar() {
    if (!S) return;
    fecharMenu();
    clearTimeout(S.timerRec); clearTimeout(S.timerAnim);
    if (S.ro) S.ro.disconnect();
    if (S.roMain) S.roMain.disconnect();
    const ws = S.ws; S.ws = null;
    if (ws) try { ws.close(); } catch {}
    for (const T of S.terms.values()) { clearTimeout(T.timerAviso); try { if (T.xt) T.xt.dispose(); } catch {} }
    for (const b of S.botoes) { b.el.removeEventListener('click', b.fn); b.el.classList.remove('term-rodando'); }
    document.removeEventListener('visibilitychange', S.aoVisivel);
    S.painel.replaceChildren();
    S.painel.classList.remove('term-painel', 'aberto', 'animando', 'sem-anim', 'foco');
    S = null;
  }

  const api = {
    montar(cfg = {}) {
      desmontar();
      if (!cfg.painel) throw new Error('OrbitTerminal.montar: falta cfg.painel');
      const salvo = ler();
      S = {
        cfg, painel: cfg.painel, botoes: [], terms: new Map(), ordem: Array.isArray(salvo.ordem) ? salvo.ordem.map(String) : [],
        aberto: false, altura: Number(salvo.altura) >= ALT_MIN ? Number(salvo.altura) : ALT_PADRAO, maximizado: !!salvo.maximizado,
        ativo: typeof salvo.ativo === 'string' ? salvo.ativo : null,
        disponivel: null, ws: null, conexao: 'desligado', conectando: false, tent: 0, timerRec: 0, recebeuLista: false,
        shells: null, plataforma: '', pedidos: new Map(), fila: [], seqRef: 0,
        vendor: null, vendorOk: false, menu: null, confirma: null, edicao: null, arr: null, semClique: false,
        estadoTipo: null, dim: null, celula: null, focoAntes: null, focarAoAbrir: false, focarDepois: false, timerAnim: 0, rafAjuste: 0,
        fonte: (getComputedStyle(document.documentElement).getPropertyValue('--mono') || '').trim() || FONTE_PADRAO,
      };
      construir();
      S.botoes = montarBotoes(cfg.botoes);
      aplicarAltura();
      S.aoVisivel = () => { if (S && !document.hidden && !S.ws && !S.conectando && S.disponivel !== false) { S.tent = 0; conectar(); } };
      document.addEventListener('visibilitychange', S.aoVisivel);
      if (salvo.aberto) definirAberto(true, false);
      atualizarTudo();
      conectar();
      return api;
    },
    alternar() { if (!S) return; if (S.aberto) api.minimizar(); else api.abrir(); },
    abrir() {
      if (!S) return;
      definirAberto(true);
      if (S.disponivel === false) { mostrarEstado('indisponivel'); return; }
      if (S.disponivel === null && !S.ws && !S.conectando) conectar();
      const T = S.terms.get(S.ativo);
      if (T && T.aberto) { if (S.focarAoAbrir && semMovimento()) { S.focarAoAbrir = false; T.xt.focus(); } return; }
      mostrarAtivo(false);
      garantirVendor().then(() => {
        if (!S || !S.aberto) return;
        if (!S.terms.size && S.recebeuLista && !S.pedidos.size) api.novo();
        else mostrarAtivo(S.focarAoAbrir && !S.painel.classList.contains('animando'));
      }, () => {});
    },
    minimizar() { if (S) definirAberto(false); },
    novo(op = {}) {
      if (!S) return null;
      if (S.disponivel === false) { api.abrir(); return null; }
      if (!S.aberto) definirAberto(true);
      const ref = 'r' + (++S.seqRef) + '-' + Date.now().toString(36);
      const projeto = Object.prototype.hasOwnProperty.call(op, 'projeto') ? op.projeto : chamar(S.cfg.projetoAtual);
      const msg = { t: 'criar', ref };
      if (typeof op.shell === 'string' && op.shell) msg.shell = op.shell;
      if (typeof projeto === 'string' && projeto) msg.projeto = projeto;
      if (typeof op.nome === 'string' && op.nome.trim()) msg.nome = op.nome.trim().slice(0, 40);
      S.pedidos.set(ref, Date.now());
      atualizarBotaoNovo();
      if (!S.terms.size) mostrarEstado('carregando');
      garantirVendor().then(() => {
        if (!S || !S.pedidos.has(ref)) return;
        Object.assign(msg, dimensoes());
        if (!enviar(msg)) { S.fila.push(msg); if (!S.ws && !S.conectando) conectar(); }
      }, () => { if (S) { S.pedidos.delete(ref); atualizarBotaoNovo(); } });
      return ref;
    },
    estado() {
      if (!S) return { montado: false };
      return {
        montado: true, disponivel: S.disponivel, conexao: S.conexao, aberto: S.aberto, altura: Math.round(alturaEfetiva()), maximizado: S.maximizado,
        ativo: S.ativo, rodando: rodando(),
        terminais: S.ordem.filter((id) => S.terms.has(id)).map((id) => {
          const m = S.terms.get(id).meta;
          return { id, nome: m.nome, shell: m.shell, projeto: m.projeto, cwd: m.cwd, vivo: !!m.vivo, codigo: m.codigo, ocupado: !!m.ocupado, urls: Array.isArray(m.urls) ? m.urls.slice() : [] };
        }),
      };
    },
    // Foco dentro do painel (para o `bloqueado` das abas não roubar Ctrl+W/Ctrl+Tab de dentro do terminal).
    temFoco() { return !!(S && S.painel.contains(document.activeElement)); },
    desmontar,
  };
  window.OrbitTerminal = api;
})();
