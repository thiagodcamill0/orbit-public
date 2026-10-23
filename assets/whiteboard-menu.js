// Orbit — Whiteboard: menu de botão direito (ajustes). Registra-se em window.Whiteboard.menu = { abrir(sx, sy), fechar(), aberto() }.
// Botão direito (ou toque longo ~500 ms) no canvas ou num elemento abre o menu no cursor. Sem elemento sob o cursor: opções do canvas
// vazio (colar, adicionar texto/nota/card de agente/navegador aqui, selecionar tudo, ajustar à tela). Sobre um elemento fora da seleção,
// seleciona só ele (ou o grupo dele) antes. Opções só aparecem quando fazem sentido e quando a ação/módulo existe na hora
// (Whiteboard.acoes.travar, Whiteboard.painel.abrir, Whiteboard.web.pedirEndereco/abrirExterno/editarEndereco).
// Visual: classes .wb-menu* (whiteboard-menu.css) copiam o .menu-flut do Orbit. O menu fica no <body> (position: fixed).
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.nucleo || typeof W.estender !== 'function') return;
  const N = W.nucleo;
  const NS = 'http://www.w3.org/2000/svg';
  const PALETA_PADRAO = [['#e5e5e5', 'Branco'], ['#888888', 'Cinza'], ['#ff9592', 'Vermelho'], ['#ff9a1f', 'Laranja'], ['#ffca16', 'Amarelo'], ['#3dd68c', 'Verde'], ['#70b8ff', 'Azul'], ['#baa7ff', 'Roxo']];
  const FORMAS = new Set(['retangulo', 'elipse', 'losango', 'linha', 'seta', 'livre']);
  const COM_COR = new Set([...FORMAS, 'texto', 'nota']);
  const ESPESSURAS = [['Fina', 1], ['Média', 2], ['Grossa', 4]];
  const ICONES = {
    copiar: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'], excluir: ['M3.5 5h9', 'M6.5 5V3.5h3V5', 'M5 5l.5 8h5l.5-8'],
    frente: ['M8 13V4', 'M4.5 7.5L8 4l3.5 3.5'], tras: ['M8 3v9', 'M4.5 8.5L8 12l3.5-3.5'],
    agrupar: ['M3 3h5v5H3z', 'M8 8h5v5H8z'], desagrupar: ['M3 3h4v4H3z', 'M9 9h4v4H9z'],
    travar: ['M4.5 7.5h7v5h-7z', 'M6 7.5V5.5a2 2 0 0 1 4 0v2'], destravar: ['M4.5 7.5h7v5h-7z', 'M6 7.5V5.5a2 2 0 0 1 3.7-1'],
    alinhar: ['M3 3v10', 'M6 5h7', 'M6 9h4'], colar: ['M5.5 3.5h5v2h-5z', 'M4 4.5v8.5h8V4.5'],
    texto: ['M3.5 4.5V3h9v1.5', 'M8 3v10', 'M6 13h4'], nota: ['M3 3h10v6.5L9.5 13H3z', 'M9.5 13V9.5H13'],
    agente: ['M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M3.5 13c.5-2.5 2.5-3.5 4.5-3.5s4 1 4.5 3.5'],
    web: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M2.5 8h11', 'M8 2.5c2 2 2 9 0 11', 'M8 2.5c-2 2-2 9 0 11'],
    tudo: ['M3.5 3.5h9v9h-9z'], ajustar: ['M3 6V3h3', 'M13 6V3h-3', 'M3 10v3h3', 'M13 10v3h-3'],
    conversa: ['M3 3.5h10v7H7l-3 2.5v-2.5H3z'], detalhes: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M8 7.5v3.5', 'M8 5.3v.01'], seta: ['M6 4l4 4-4 4'],
  };
  const svg = (nome, w = 15) => {
    const d = ICONES[nome];
    if (!d) { const s = document.createElement('span'); s.className = 'mi-vazio'; return s; }
    const v = document.createElementNS(NS, 'svg');
    for (const [k, val] of Object.entries({ viewBox: '0 0 16 16', width: w, height: w, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, val);
    for (const p of d) { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', p); v.append(e); }
    return v;
  };
  const el = (tag, cls, ...filhos) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const f of filhos) if (f != null) e.append(f.nodeType ? f : String(f)); return e; };
  const A = (nome) => { const a = W.acoes; return a && typeof a[nome] === 'function' ? a[nome] : null; };
  const palco = () => document.querySelector('.wb-palco');
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const CT = MAC ? '⌘' : 'Ctrl+';
  const travado = (e) => (typeof N.travado === 'function' ? !!N.travado(e) : !!(e && e.travado === true));

  let raiz = null, sub = null, subItem = null, aberto = false, ponto = null, tSub = null, abriuEm = 0;
  let esq = false; // botão esquerdo pressionado (arrastar/criar em andamento)

  const temExportar = () => !!(W.exportar && typeof W.exportar.abrir === 'function'); // opcional: o item some sem o módulo
  // ── construção do conteúdo conforme o contexto ──
  function itensAgentes(m) {
    const f = window.OrbitFonteSessoes;
    let lista = [];
    try { lista = f && typeof f.lista === 'function' ? f.lista() || [] : []; } catch { lista = []; }
    const ord = { aguardando: 0, trabalhando: 1 };
    lista = lista.map((r, i) => ({ r, i })).sort((a, b) => (ord[a.r.status] ?? 2) - (ord[b.r.status] ?? 2) || a.i - b.i).slice(0, 8).map((o) => o.r);
    const its = lista.map((r) => ({ t: 'item', rot: r.nome || r.id, sprite: r.sprite, ic: 'agente', dados: { sessao: r.id }, fn: () => criarAgente(r.id, m) }));
    const painel = W.painel && typeof W.painel.abrir === 'function' ? W.painel : null;
    if (painel) { if (its.length) its.push({ t: 'sep' }); its.push({ t: 'item', rot: 'Ver todas…', fn: () => painel.abrir() }); }
    return its;
  }
  function criarAgente(id, m) {
    let tratou = false;
    if (W.times && typeof W.times.soltar === 'function') { try { tratou = !!W.times.soltar(id, m.x, m.y); } catch (e) { console.warn('whiteboard-menu: times.soltar', e); } }
    if (!tratou && W.agentes) W.agentes.adicionar(id, m.x, m.y);
  }
  function itensVazio(m) {
    const its = [];
    its.push({ t: 'item', rot: 'Colar', ic: 'colar', atalho: CT + 'V', fn: async () => {
      const p = palco(); const r = p && p.getBoundingClientRect();
      if (r && ponto) p.dispatchEvent(new PointerEvent('pointermove', { clientX: ponto.sx, clientY: ponto.sy, bubbles: true })); // o colar centra no último ponto do ponteiro
      const c = A('colar'); if (c) await c();
    }, desab: !A('colar') });
    its.push({ t: 'sep' });
    const T = window.WhiteboardTexto;
    if (T && typeof T.criarEm === 'function') {
      its.push({ t: 'item', rot: 'Adicionar texto aqui', ic: 'texto', fn: () => T.criarEm(m.x, m.y, 'texto') });
      its.push({ t: 'item', rot: 'Adicionar nota aqui', ic: 'nota', fn: () => T.criarEm(m.x, m.y, 'nota') });
    }
    if (W.agentes && typeof W.agentes.adicionar === 'function' && window.OrbitFonteSessoes) {
      const s = itensAgentes(m);
      if (s.length) its.push({ t: 'item', rot: 'Adicionar card de agente aqui', ic: 'agente', sub: () => itensAgentes(m) });
    }
    if (W.web && typeof W.web.pedirEndereco === 'function') its.push({ t: 'item', rot: 'Adicionar navegador aqui', ic: 'web', fn: () => W.web.pedirEndereco(m.x, m.y) });
    its.push({ t: 'sep' });
    its.push({ t: 'item', rot: 'Selecionar tudo', ic: 'tudo', atalho: CT + 'A', fn: () => (A('selecionarTudo') ? A('selecionarTudo')() : N.selecionar(N.elementos().filter((e) => !travado(e)).map((e) => e.id))) });
    its.push({ t: 'item', rot: 'Ajustar à tela', ic: 'ajustar', atalho: 'Shift+1', fn: () => N.ajustar(true, false) });
    if (temExportar()) its.push({ t: 'item', rot: 'Exportar quadro…', ic: 'copiar', fn: () => W.exportar.abrir({ selecao: false }) });
    return its;
  }
  function itensFerramentas(fer, travadoAg) { // submenu "Ferramentas ligadas" do card de agente: por site, abrir no card / desligar
    const r = [];
    fer.forEach((f, i) => {
      if (i) r.push({ t: 'sep' });
      const ag = N.selecao().map((id) => N.elemento(id)).find((e) => e && e.tipo === 'agente');
      r.push({ t: 'item', rot: 'Abrir ' + f.titulo + ' no card', ic: 'web', dados: { web: f.web }, fn: () => W.ligacao.focarWeb(f.web) });
      if (!travadoAg && ag && ag.sessao) r.push({ t: 'item', rot: 'Desligar ' + f.titulo, ic: 'excluir', dados: { web: f.web }, fn: () => W.ligacao.desligar(f.web, ag.sessao.id) });
    });
    return r;
  }
  function itensElementos(sel) {
    const its = [];
    const trav = sel.filter(travado), livres = sel.filter((e) => !travado(e));
    const todosTrav = livres.length === 0;
    const unico = sel.length === 1 ? sel[0] : null;
    if (unico && unico.tipo === 'agente' && unico.sessao) {
      its.push({ t: 'item', rot: 'Abrir conversa', ic: 'conversa', fn: () => { const f = window.OrbitFonteSessoes; if (f && typeof f.abrir === 'function') f.abrir(unico.sessao.id); } });
      if (W.agentes && typeof W.agentes.detalhes === 'function') its.push({ t: 'item', rot: 'Ver detalhes', ic: 'detalhes', fn: () => W.agentes.detalhes(unico.id) });
      const fer = W.ligacao && typeof W.ligacao.doAgente === 'function' ? W.ligacao.doAgente(unico.id) : [];
      if (fer.length) its.push({ t: 'item', rot: 'Ferramentas ligadas', ic: 'web', sub: () => itensFerramentas(fer, todosTrav) });
      its.push({ t: 'sep' });
    }
    if (unico && unico.tipo === 'web' && W.web) {
      let n = 0;
      if (typeof W.web.abrirExterno === 'function') { its.push({ t: 'item', rot: 'Abrir no navegador', ic: 'web', fn: () => W.web.abrirExterno(unico.id) }); n++; }
      if (!todosTrav && typeof W.web.editarEndereco === 'function') { its.push({ t: 'item', rot: 'Editar endereço', ic: 'web', fn: () => W.web.editarEndereco(unico.id) }); n++; }
      if (n) its.push({ t: 'sep' });
    }
    if (unico && unico.tipo === 'web' && W.ligacao) {
      const n0 = its.length;
      if (!todosTrav && typeof W.ligacao.escolher === 'function') its.push({ t: 'item', rot: 'Ligar a um agente…', ic: 'agente', fn: () => W.ligacao.escolher(unico.id) });
      const ls = W.ligacao.doWeb(unico.id);
      const acoes = (l) => [
        { t: 'item', rot: 'Reenviar aviso a ' + l.nome, ic: 'conversa', dados: { sessao: l.sessao }, fn: () => W.ligacao.reenviar(unico.id, l.sessao) },
        ...(todosTrav ? [] : [{ t: 'item', rot: 'Desligar de ' + l.nome, ic: 'excluir', dados: { sessao: l.sessao }, fn: () => W.ligacao.desligar(unico.id, l.sessao) }]),
      ];
      if (ls.length === 1) its.push(...acoes(ls[0]));
      else if (ls.length > 1) its.push({ t: 'item', rot: 'Ligações', ic: 'agente', sub: () => ls.flatMap((l, i) => (i ? [{ t: 'sep' }, ...acoes(l)] : acoes(l))) });
      if (its.length > n0) its.push({ t: 'sep' });
    }
    const copiar = A('copiar'), duplicar = A('duplicar');
    // Itens travados: copiar/duplicar/destravar. A ação em si é do módulo de edição (que pode ignorar travados).
    if (copiar) its.push({ t: 'item', rot: 'Copiar', ic: 'copiar', atalho: CT + 'C', fn: () => copiar() });
    if (duplicar) its.push({ t: 'item', rot: 'Duplicar', ic: 'copiar', atalho: CT + 'D', fn: () => duplicar() });
    if (temExportar()) its.push({ t: 'item', rot: 'Exportar seleção…', ic: 'copiar', fn: () => W.exportar.abrir({ selecao: true }) });
    if (todosTrav) {
      const dest = A('destravar');
      if (dest) its.unshift({ t: 'item', rot: 'Destravar', ic: 'destravar', atalho: CT + 'Shift+L', fn: () => dest() });
      return its;
    }
    if (A('apagar')) its.push({ t: 'item', rot: 'Excluir', ic: 'excluir', atalho: 'Delete', perigo: true, fn: () => A('apagar')() });
    const camada = A('camada');
    if (camada) {
      its.push({ t: 'sep' });
      its.push({ t: 'item', rot: 'Trazer para frente', ic: 'frente', atalho: CT + 'Shift+]', fn: () => camada('frente') });
      its.push({ t: 'item', rot: 'Enviar para trás', ic: 'tras', atalho: CT + 'Shift+[', fn: () => camada('tras') });
    }
    const gr = [];
    const mesmoGrupo = livres.length > 1 && livres[0].grupo && livres.every((e) => e.grupo === livres[0].grupo);
    if (A('agrupar') && livres.length >= 2 && !mesmoGrupo) gr.push({ t: 'item', rot: 'Agrupar', ic: 'agrupar', atalho: CT + 'G', fn: () => A('agrupar')() });
    if (A('desagrupar') && livres.some((e) => e.grupo)) gr.push({ t: 'item', rot: 'Desagrupar', ic: 'desagrupar', atalho: CT + 'Shift+G', fn: () => A('desagrupar')() });
    if (A('travar') && livres.length) gr.push({ t: 'item', rot: 'Travar', ic: 'travar', atalho: CT + 'Shift+L', fn: () => A('travar')() });
    if (A('destravar') && trav.length) gr.push({ t: 'item', rot: 'Destravar', ic: 'destravar', atalho: CT + 'Shift+L', fn: () => A('destravar')() });
    if (gr.length) its.push({ t: 'sep' }, ...gr);
    if (A('alinhar') && livres.length >= 2) {
      const s = [['Esquerda', 'esquerda'], ['Centro horizontal', 'centroH'], ['Direita', 'direita'], ['Topo', 'topo'], ['Centro vertical', 'centroV'], ['Base', 'base']].map(([rot, l]) => ({ t: 'item', rot, fn: () => A('alinhar')(l) }));
      if (A('distribuir') && livres.length >= 3) s.push({ t: 'sep' }, { t: 'item', rot: 'Distribuir na horizontal', fn: () => A('distribuir')('h') }, { t: 'item', rot: 'Distribuir na vertical', fn: () => A('distribuir')('v') });
      its.push({ t: 'item', rot: 'Alinhar', ic: 'alinhar', sub: () => s });
    }
    const paraCor = livres.filter((e) => COM_COR.has(e.tipo)), paraEsp = livres.filter((e) => FORMAS.has(e.tipo));
    if (paraCor.length) its.push({ t: 'sep' }, { t: 'tit', rot: 'Cor' }, { t: 'cores', ids: paraCor.map((e) => e.id) });
    if (paraEsp.length) its.push({ t: 'tit', rot: 'Espessura' }, { t: 'esp', ids: paraEsp.map((e) => e.id) });
    return its;
  }

  // ── DOM ──
  function botao(it) {
    const b = el('button', 'wb-menu-item' + (it.perigo ? ' perigo' : ''));
    b.type = 'button'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
    if (it.desab) b.disabled = true;
    if (it.sprite) { const i = el('img', 'mi-sprite'); i.src = it.sprite; i.alt = ''; b.append(i); } else b.append(svg(it.ic));
    b.append(el('span', 'mi-rot', it.rot));
    if (it.atalho) b.append(el('span', 'mi-atalho', it.atalho));
    if (it.sub) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); const s = svg('seta', 13); s.classList.add('mi-seta'); b.append(s); }
    if (it.dados) for (const [k, v] of Object.entries(it.dados)) b.dataset[k] = v;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.sub) { abrirSub(b, it); return; }
      const fn = it.fn; fechar(true);
      if (fn) Promise.resolve().then(fn).catch((err) => console.warn('whiteboard-menu:', err));
    });
    return b;
  }
  function aplicarCor(ids, cor) {
    let mexeu = false;
    for (const id of ids) { const e = N.elemento(id); if (e && !travado(e)) { N.atualizar(id, { cor }); mexeu = true; } }
    if (mexeu) N.confirmar('Estilo');
  }
  function aplicarLargura(ids, largura) {
    let mexeu = false;
    for (const id of ids) { const e = N.elemento(id); if (e && !travado(e)) { N.atualizar(id, { traco: { ...(e.traco || {}), largura } }); mexeu = true; } }
    if (mexeu) N.confirmar('Estilo');
  }
  function montar(its, cls) {
    const m = el('div', 'wb-menu' + (cls ? ' ' + cls : ''));
    m.setAttribute('role', 'menu'); m.tabIndex = -1; m.dataset.medindo = '1';
    for (const it of its) {
      if (it.t === 'sep') m.append(Object.assign(el('div', 'wb-menu-sep'), { role: 'separator' }));
      else if (it.t === 'tit') m.append(el('div', 'wb-menu-tit', it.rot));
      else if (it.t === 'cores' || it.t === 'esp') {
        const l = el('div', 'wb-menu-linha'); l.setAttribute('role', 'group');
        if (it.t === 'cores') {
          const pal = (window.WhiteboardEstilo && window.WhiteboardEstilo.PALETA) || PALETA_PADRAO;
          for (const [c, n] of pal) {
            const b = el('button', 'wb-menu-cor'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1; b.title = n; b.setAttribute('aria-label', 'Cor ' + n); b.dataset.cor = c; b.style.setProperty('--c', c);
            b.addEventListener('click', (e) => { e.stopPropagation(); fechar(true); aplicarCor(it.ids, c); });
            l.append(b);
          }
        } else {
          for (const [n, v] of ESPESSURAS) {
            const b = el('button', 'wb-menu-esp', n); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1; b.dataset.largura = v;
            b.addEventListener('click', (e) => { e.stopPropagation(); fechar(true); aplicarLargura(it.ids, v); });
            l.append(b);
          }
        }
        m.append(l);
      } else {
        const b = botao(it);
        if (it.sub) b.addEventListener('mouseenter', () => { clearTimeout(tSub); tSub = setTimeout(() => abrirSub(b, it), 90); });
        else b.addEventListener('mouseenter', () => { clearTimeout(tSub); if (sub && !sub.contains(b)) tSub = setTimeout(fecharSub, 140); });
        m.append(b);
      }
    }
    return m;
  }
  function encaixar(m, x, y, r) { // r = retângulo do item pai (submenu) ou null
    const vw = window.innerWidth, vh = window.innerHeight, w = m.offsetWidth, h = m.offsetHeight, mg = 8;
    let l, t;
    if (r) {
      l = r.right + 2 + w <= vw - mg ? r.right + 2 : r.left - 2 - w;
      t = r.top - 5;
    } else {
      l = x + w <= vw - mg ? x : x - w;
      t = y + h <= vh - mg ? y : y - h;
    }
    l = Math.max(mg, Math.min(l, vw - w - mg)); t = Math.max(mg, Math.min(t, vh - h - mg));
    m.style.left = l + 'px'; m.style.top = t + 'px';
    delete m.dataset.medindo;
  }
  function abrirSub(b, it) {
    clearTimeout(tSub);
    if (subItem === b && sub) return;
    fecharSub();
    const its = it.sub(); if (!its || !its.length) return;
    sub = montar(its, 'wb-menu-sub'); document.body.append(sub);
    subItem = b; b.dataset.aberto = '1'; b.setAttribute('aria-expanded', 'true');
    encaixar(sub, 0, 0, b.getBoundingClientRect());
    sub.style.maxHeight = 'calc(100vh - 16px)';
  }
  function fecharSub() {
    clearTimeout(tSub);
    if (sub) { sub.remove(); sub = null; }
    if (subItem) { delete subItem.dataset.aberto; subItem.setAttribute('aria-expanded', 'false'); subItem = null; }
  }

  // ── abrir / fechar ──
  function selecionarAlvo(el0) {
    if (!el0) return;
    if (N.selecao().includes(el0.id)) return;
    const ids = el0.grupo ? N.elementos().filter((e) => e.grupo === el0.grupo).map((e) => e.id) : [el0.id];
    N.selecionar(ids);
  }
  function dentroDaMultipla(m) {
    const cs = N.selecao().map((id) => N.elemento(id)).filter(Boolean).map((e) => N.caixaMundo(e));
    if (cs.length < 2) return false;
    const x0 = Math.min(...cs.map((c) => c.x)), y0 = Math.min(...cs.map((c) => c.y));
    const x1 = Math.max(...cs.map((c) => c.x + c.w)), y1 = Math.max(...cs.map((c) => c.y + c.h));
    return m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1;
  }
  function abrir(sx, sy) {
    const p = palco(); if (!p || !W.estado().ativo) return false;
    fechar();
    const r = p.getBoundingClientRect();
    const m = N.telaParaMundo(sx - r.left, sy - r.top);
    const alvo = N.elementoEm(m.x, m.y);
    if (alvo) selecionarAlvo(alvo); else if (!dentroDaMultipla(m)) N.selecionar([]); // vazio limpa a seleção (como Figma); só a caixa de uma seleção múltipla mantém o menu dela
    const sel = N.selecao().map((id) => N.elemento(id)).filter(Boolean);
    const its = sel.length ? itensElementos(sel) : itensVazio(m);
    if (!its.length) return false;
    ponto = { sx, sy, mx: m.x, my: m.y };
    raiz = montar(its); document.body.append(raiz);
    encaixar(raiz, sx, sy, null);
    aberto = true; abriuEm = Date.now();
    try { raiz.focus({ preventScroll: true }); } catch {}
    return true;
  }
  function fechar(devolverFoco) {
    fecharSub();
    if (raiz) { raiz.remove(); raiz = null; }
    const estava = aberto; aberto = false;
    if (estava && devolverFoco) { const p = palco(); if (p) try { p.focus({ preventScroll: true }); } catch {} }
  }

  // ── entrada ──
  const editavel = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  document.addEventListener('pointerdown', (e) => {
    if (e.button === 0) esq = true;
    if (aberto && !(raiz && raiz.contains(e.target)) && !(sub && sub.contains(e.target))) fechar();
  }, true);
  document.addEventListener('pointerup', (e) => { if (e.button === 0) esq = false; }, true);
  document.addEventListener('pointercancel', () => { esq = false; }, true);
  document.addEventListener('contextmenu', (e) => {
    const alvo = e.target;
    if (raiz && raiz.contains(alvo) || (sub && sub.contains(alvo))) { e.preventDefault(); return; }
    const p = palco();
    if (!p || !alvo || !p.contains(alvo) || !W.estado().ativo) return;
    if (editavel(alvo) || (alvo.closest && alvo.closest('.wb-ag-pop, .wb-est, .wb-painel, .wb-dialogo'))) return;
    e.preventDefault();
    if ((e.buttons & 1) || esq) return; // arrastando/criando: não abre
    abrir(e.clientX, e.clientY);
  }, true);
  // Toque longo (~500 ms sem mexer) = botão direito.
  let toque = null;
  document.addEventListener('pointerdown', (e) => {
    clearTimeout(toque && toque.t); toque = null;
    const p = palco();
    if (e.pointerType !== 'touch' || !p || !p.contains(e.target) || editavel(e.target)) return;
    const x = e.clientX, y = e.clientY;
    toque = { id: e.pointerId, x, y, t: setTimeout(() => { toque = null; abrir(x, y); }, 500) };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (toque && e.pointerId === toque.id && Math.hypot(e.clientX - toque.x, e.clientY - toque.y) > 8) { clearTimeout(toque.t); toque = null; }
  }, true);
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => { if (toque) { clearTimeout(toque.t); toque = null; } }, true);
  document.addEventListener('wheel', (e) => { if (aberto && !(raiz && raiz.contains(e.target)) && !(sub && sub.contains(e.target))) fechar(); }, { capture: true, passive: true });
  window.addEventListener('resize', () => fechar());
  window.addEventListener('blur', () => fechar());
  for (const ev of ['camera', 'ferramenta', 'quadro']) N.on(ev, () => { if (aberto && Date.now() - abriuEm > 30) fechar(); });

  // ── teclado ──
  function paradas(cont) {
    const out = []; const ativo = document.activeElement;
    for (const f of cont.children) {
      if (f.matches('button[role=menuitem]:not(:disabled)')) out.push(f);
      else if (f.classList.contains('wb-menu-linha')) out.push(f.contains(ativo) ? ativo : f.querySelector('button'));
    }
    return out.filter(Boolean);
  }
  document.addEventListener('keydown', (e) => {
    if (!aberto) return;
    const k = e.key;
    const ativo = document.activeElement;
    const cont = sub && sub.contains(ativo) ? sub : (sub && !raiz.contains(ativo) ? sub : raiz);
    const consumir = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'Escape') { consumir(); if (sub && cont === sub) { const b = subItem; fecharSub(); if (b) b.focus(); } else fechar(true); return; }
    if (k === 'Tab') { fechar(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ps = paradas(cont);
    const i = ps.indexOf(ps.find((b) => b === ativo));
    const linha = ativo && ativo.parentElement && ativo.parentElement.classList.contains('wb-menu-linha') ? ativo.parentElement : null;
    if (k === 'ArrowDown') { consumir(); ps[(i + 1) % ps.length]?.focus(); }
    else if (k === 'ArrowUp') { consumir(); ps[i <= 0 ? ps.length - 1 : i - 1]?.focus(); }
    else if (k === 'Home') { consumir(); ps[0]?.focus(); }
    else if (k === 'End') { consumir(); ps[ps.length - 1]?.focus(); }
    else if (k === 'ArrowRight') {
      consumir();
      if (linha) { const bs = [...linha.children]; bs[(bs.indexOf(ativo) + 1) % bs.length].focus(); }
      else if (ativo && ativo.getAttribute('aria-haspopup')) { ativo.click(); sub?.querySelector('button')?.focus(); }
    } else if (k === 'ArrowLeft') {
      consumir();
      if (linha) { const bs = [...linha.children]; bs[(bs.indexOf(ativo) + bs.length - 1) % bs.length].focus(); }
      else if (sub && cont === sub) { const b = subItem; fecharSub(); if (b) b.focus(); }
    } else if (k === 'Enter' || k === ' ') {
      consumir();
      if (ativo && ativo.matches && ativo.matches('button[role=menuitem]')) { ativo.click(); if (sub && ativo.getAttribute('aria-haspopup')) sub.querySelector('button')?.focus(); }
    }
  }, true);

  W.estender('menu', Object.freeze({ abrir: (sx, sy) => abrir(+sx || 0, +sy || 0), fechar: () => fechar(true), aberto: () => aberto }));
})();
