// Orbit — painel de opções do grafo (contrato C2). Script clássico: globalThis.GrafoPainel.
//   GrafoPainel.criar(el, opcoes, { aoMudar(opcoes, chave), aoRestaurar(), aoTimelapse() }, { local }) → { definir(opcoes), destruir() }
// Não grava nada: só avisa. A busca espera 250 ms; o resto é imediato. Estilo em grafo-painel.css.
(function () {
  'use strict';
  const ESPERA_BUSCA = 250;
  const LOCAL_PADRAO = { profundidade: 1, entrada: true, saida: true, vizinhos: true };
  const clonar = (o) => JSON.parse(JSON.stringify(o));
  let contador = 0;

  function el(tag, attrs, ...filhos) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'texto') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    for (const f of filhos) if (f) e.append(f);
    return e;
  }

  const ICO_X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICO_REST = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  const ICO_ENG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  const COR_NOVA = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#2e8bff', '#a78bfa'];

  function criar(raiz, opcoes, cb, cfg) {
    cb = cb || {};
    const comLocal = !!(cfg && cfg.local);
    const id = 'gp' + (++contador);
    let o = clonar(opcoes || {});
    if (!o.local) o.local = clonar(LOCAL_PADRAO);
    if (!Array.isArray(o.grupos)) o.grupos = [];
    let tBusca = null;
    const ctl = {}; // caminho → { atualizar() }

    const emitir = (chave) => { if (cb.aoMudar) cb.aoMudar(clonar(o), chave); };

    const painel = el('div', { class: 'gp-painel', id: id + '-painel', role: 'group', 'aria-label': 'Opções do grafo' });
    const cab = el('div', { class: 'gp-cab' });
    const btnRest = el('button', { type: 'button', class: 'gp-ib gp-restaurar', 'aria-label': 'Restaurar padrões', title: 'Restaurar padrões' });
    btnRest.innerHTML = ICO_REST;
    const btnFechar = el('button', { type: 'button', class: 'gp-ib gp-fechar', 'aria-label': 'Recolher painel', title: 'Recolher painel', 'aria-controls': id + '-painel' });
    btnFechar.innerHTML = ICO_X;
    cab.append(el('span', { class: 'gp-tit', texto: 'Opções do grafo' }), btnRest, btnFechar);
    painel.append(cab);

    const btnEng = el('button', { type: 'button', class: 'gp-eng', 'aria-label': 'Abrir opções do grafo', title: 'Opções do grafo', 'aria-expanded': 'false', 'aria-controls': id + '-painel' });
    btnEng.innerHTML = ICO_ENG;

    const raizEl = el('div', { class: 'gp' });
    raizEl.append(btnEng, painel);

    function recolherPainel(recolher, foco) {
      raizEl.classList.toggle('gp-recolhido', recolher);
      btnEng.setAttribute('aria-expanded', String(!recolher));
      if (foco) (recolher ? btnEng : btnFechar).focus();
    }
    btnEng.addEventListener('click', () => recolherPainel(false, true));
    btnFechar.addEventListener('click', () => recolherPainel(true, true));
    painel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); recolherPainel(true, true); } });
    recolherPainel(false);

    const ler = (c) => (c.length === 2 ? o[c[0]][c[1]] : o[c[0]]);
    const gravar = (c, v) => { if (c.length === 2) o[c[0]][c[1]] = v; else o[c[0]] = v; };

    function secao(titulo, aberta) {
      const cid = id + '-s' + (++contador);
      const cabS = el('button', { type: 'button', class: 'gp-sec', 'aria-expanded': String(aberta), 'aria-controls': cid });
      cabS.append(el('span', { class: 'gp-seta', 'aria-hidden': 'true' }), el('span', { texto: titulo }));
      const corpo = el('div', { class: 'gp-corpo', id: cid });
      corpo.hidden = !aberta;
      cabS.addEventListener('click', () => {
        const ab = cabS.getAttribute('aria-expanded') !== 'true';
        cabS.setAttribute('aria-expanded', String(ab));
        corpo.hidden = !ab;
      });
      painel.append(el('section', { class: 'gp-bloco' }, cabS, corpo));
      return corpo;
    }

    function chave(corpo, rotulo, caminho, chaveEvento) {
      const lid = id + '-l' + (++contador);
      const b = el('button', { type: 'button', class: 'gp-chave', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': lid });
      b.append(el('span', { class: 'gp-bola' }));
      const lin = el('div', { class: 'gp-lin' }, el('span', { class: 'gp-rot', id: lid, texto: rotulo }), b);
      b.addEventListener('click', () => { const v = !ler(caminho); gravar(caminho, v); b.setAttribute('aria-checked', String(v)); emitir(chaveEvento); });
      lin.addEventListener('click', (e) => { if (e.target === lin || e.target.id === lid) b.click(); });
      const atualizar = () => b.setAttribute('aria-checked', String(!!ler(caminho)));
      ctl[caminho.join('.')] = { atualizar };
      corpo.append(lin);
      atualizar();
    }

    function deslizante(corpo, rotulo, caminho, min, max, passo, chaveEvento, fmt) {
      const iid = id + '-i' + (++contador);
      const inp = el('input', { type: 'range', id: iid, min: String(min), max: String(max), step: String(passo) });
      const val = el('output', { class: 'gp-val', for: iid });
      const mostrar = () => { const v = Number(ler(caminho)); val.textContent = fmt ? fmt(v) : String(+v.toFixed(3)); };
      const lin = el('div', { class: 'gp-lin gp-lin-desl' }, el('label', { class: 'gp-rot', for: iid, texto: rotulo }), val, inp);
      inp.addEventListener('input', () => { gravar(caminho, Number(inp.value)); mostrar(); emitir(chaveEvento); });
      const atualizar = () => { inp.value = String(ler(caminho)); mostrar(); };
      ctl[caminho.join('.')] = { atualizar };
      corpo.append(lin);
      atualizar();
    }

    // ---- Filtros ----
    const sf = secao('Filtros', true);
    const bid = id + '-busca';
    const busca = el('input', { type: 'search', id: bid, class: 'gp-campo', placeholder: 'Buscar arquivos…', autocomplete: 'off', spellcheck: 'false' });
    sf.append(el('div', { class: 'gp-lin gp-lin-col' }, el('label', { class: 'gp-so-sr', for: bid, texto: 'Buscar arquivos' }), busca));
    const enviarBusca = () => { tBusca = null; o.busca = busca.value; emitir('busca'); };
    busca.addEventListener('input', () => { clearTimeout(tBusca); tBusca = setTimeout(enviarBusca, ESPERA_BUSCA); });
    busca.addEventListener('keydown', (e) => { if (e.key === 'Enter' && tBusca) { clearTimeout(tBusca); enviarBusca(); } });
    ctl.busca = { atualizar() { clearTimeout(tBusca); tBusca = null; busca.value = o.busca || ''; } };
    ctl.busca.atualizar();
    chave(sf, 'Tags', ['tags'], 'tags');
    chave(sf, 'Anexos', ['anexos'], 'anexos');
    chave(sf, 'Só existentes', ['soExistentes'], 'soExistentes');
    chave(sf, 'Órfãos', ['orfaos'], 'orfaos');

    // ---- Grafo local ----
    if (comLocal) {
      const sl = secao('Grafo local', true);
      deslizante(sl, 'Saltos', ['local', 'profundidade'], 1, 5, 1, 'local', (v) => String(Math.round(v)));
      chave(sl, 'Links de entrada', ['local', 'entrada'], 'local');
      chave(sl, 'Links de saída', ['local', 'saida'], 'local');
      chave(sl, 'Links entre vizinhos', ['local', 'vizinhos'], 'local');
    }

    // ---- Grupos ----
    const sg = secao('Grupos', false);
    chave(sg, 'Cores por pasta', ['corPorPasta'], 'corPorPasta');
    const listaG = el('div', { class: 'gp-grupos' });
    const btnNovo = el('button', { type: 'button', class: 'gp-btn gp-novo-grupo', texto: 'Novo grupo' });
    sg.append(listaG, btnNovo);
    function desenharGrupos() {
      listaG.textContent = '';
      o.grupos.forEach((g, i) => {
        const q = el('input', { type: 'text', class: 'gp-campo', 'aria-label': 'Consulta do grupo ' + (i + 1), placeholder: 'Consulta (ex.: tag:#ideia)', autocomplete: 'off', spellcheck: 'false' });
        q.value = g.consulta || '';
        const c = el('input', { type: 'color', class: 'gp-cor', 'aria-label': 'Cor do grupo ' + (i + 1) });
        c.value = /^#[0-9a-f]{6}$/i.test(g.cor || '') ? g.cor : '#6366f1';
        const x = el('button', { type: 'button', class: 'gp-ib gp-rem', 'aria-label': 'Remover grupo ' + (i + 1), title: 'Remover grupo' });
        x.innerHTML = ICO_X;
        q.addEventListener('input', () => { o.grupos[i].consulta = q.value; emitir('grupos'); });
        c.addEventListener('input', () => { o.grupos[i].cor = c.value; emitir('grupos'); });
        x.addEventListener('click', () => { o.grupos.splice(i, 1); desenharGrupos(); emitir('grupos'); });
        listaG.append(el('div', { class: 'gp-grupo' }, c, q, x));
      });
    }
    btnNovo.addEventListener('click', () => {
      o.grupos.push({ consulta: '', cor: COR_NOVA[o.grupos.length % COR_NOVA.length] });
      desenharGrupos(); emitir('grupos');
      const q = listaG.querySelectorAll('input[type=text]'); if (q.length) q[q.length - 1].focus();
    });
    ctl.grupos = { atualizar: desenharGrupos };
    desenharGrupos();

    // ---- Exibição ----
    const se = secao('Exibição', false);
    chave(se, 'Setas', ['setas'], 'setas');
    deslizante(se, 'Fade do texto', ['fadeTexto'], -3, 3, 0.1, 'fadeTexto');
    deslizante(se, 'Tamanho do nó', ['tamanhoNo'], 0.1, 5, 0.01, 'tamanhoNo');
    deslizante(se, 'Espessura do link', ['espessuraLink'], 0.1, 5, 0.01, 'espessuraLink');
    const btnTime = el('button', { type: 'button', class: 'gp-btn gp-timelapse', texto: 'Timelapse' });
    btnTime.addEventListener('click', () => { if (cb.aoTimelapse) cb.aoTimelapse(); });
    se.append(btnTime);

    // ---- Forças ----
    const sForcas = secao('Forças', false);
    deslizante(sForcas, 'Força do centro', ['centro'], 0, 1, 0.01, 'centro');
    deslizante(sForcas, 'Força de repulsão', ['repulsao'], 0, 20, 0.1, 'repulsao');
    deslizante(sForcas, 'Força dos links', ['link'], 0, 1, 0.01, 'link');
    deslizante(sForcas, 'Distância dos links', ['distancia'], 30, 500, 1, 'distancia', (v) => String(Math.round(v)));

    btnRest.addEventListener('click', () => { if (cb.aoRestaurar) cb.aoRestaurar(); });

    // O painel não repassa gestos ao canvas do grafo por baixo.
    for (const ev of ['wheel', 'pointerdown', 'dblclick', 'contextmenu']) raizEl.addEventListener(ev, (e) => e.stopPropagation());
    raiz.append(raizEl);

    return {
      definir(novas) {
        o = clonar(novas || {});
        if (!o.local) o.local = clonar(LOCAL_PADRAO);
        if (!Array.isArray(o.grupos)) o.grupos = [];
        for (const k in ctl) ctl[k].atualizar();
      },
      destruir() { clearTimeout(tBusca); tBusca = null; raizEl.remove(); },
    };
  }

  globalThis.GrafoPainel = { criar };
})();
