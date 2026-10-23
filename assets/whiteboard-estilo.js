// Orbit — Whiteboard (etapa 3: painel de propriedades/estilo). Carregado depois de whiteboard.js.
// Painel flutuante à esquerda: aparece com seleção ou com ferramenta de desenho ativa. Com seleção aplica em cada elemento
// (nucleo.atualizar + confirmar('Estilo')); sem seleção grava em nucleo.definirEstilo (próximas formas).
// Botões de camadas/alinhar/agrupar/duplicar/apagar chamam Whiteboard.acoes?.x?.() (somem se a ação não existir).
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.nucleo) return;
  const N = W.nucleo;
  const NS = 'http://www.w3.org/2000/svg';

  // Paleta do Orbit (tons claros dos tokens de status, legíveis no tema escuro).
  const PALETA = [
    ['#e5e5e5', 'Branco'], ['#888888', 'Cinza'], ['#ff9592', 'Vermelho'], ['#ff9a1f', 'Laranja'],
    ['#ffca16', 'Amarelo'], ['#3dd68c', 'Verde'], ['#70b8ff', 'Azul'], ['#baa7ff', 'Roxo'],
  ];
  const FUNDO_NOTA = '#1d1d1d';
  const ESPESSURAS = [['Fina', 1], ['Média', 2], ['Grossa', 4]];
  const ESTILOS = [['Sólido', 'solido'], ['Tracejado', 'tracejado'], ['Pontilhado', 'pontilhado']];
  const TAMANHOS = [['P', 14], ['M', 20], ['G', 32], ['XG', 48]];
  const ALINHAMENTOS = [['Esquerda', 'esquerda'], ['Centro', 'centro'], ['Direita', 'direita']];
  const FERR_DESENHO = new Set(['retangulo', 'elipse', 'losango', 'linha', 'seta', 'livre', 'texto', 'nota']);
  const SEM_PREENCHIMENTO = new Set(['linha', 'seta']);
  const MISTO = Symbol('misto');

  const st = document.createElement('style');
  st.textContent = `
.wb-est { position: absolute; z-index: 3; right: 12px; top: 64px; width: 212px; max-height: calc(100% - 132px); overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 10px; padding: 10px; box-sizing: border-box; background: var(--bloco, #262626);
  border: 1px solid var(--fio-2, rgba(255,255,255,.085)); border-radius: 14px; box-shadow: var(--sombra); color: var(--t1, #f0f0f0);
  font-family: var(--sans, system-ui, sans-serif); font-size: 12px; scrollbar-width: thin;
  opacity: 1; transform: translateX(0); transition: opacity .18s ease, transform .18s var(--ease-press, cubic-bezier(.23, 1, .32, 1)), visibility 0s linear 0s; }
.wb-est[data-fora] { opacity: 0; transform: translateX(8px); visibility: hidden; pointer-events: none; transition: opacity .18s ease, transform .18s var(--ease-press, cubic-bezier(.23, 1, .32, 1)), visibility 0s linear .18s; }
.wb-est-sec { display: flex; flex-direction: column; gap: 6px; }
.wb-est-sec[hidden], .wb-est [hidden] { display: none !important; }
.wb-est-rot { display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--t2, #888); }
.wb-est-misto { font-size: 10px; letter-spacing: .04em; text-transform: none; font-weight: 500; color: var(--t3, #5c5c5c); }
.wb-est-linha { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wb-est-cor { width: 20px; height: 20px; padding: 0; border-radius: 6px; border: 1px solid var(--fio-3, rgba(255,255,255,.13)); background: var(--c); cursor: pointer;
  transition: transform .18s ease, box-shadow .18s ease; position: relative; }
.wb-est-cor:hover { transform: scale(1.1); }
.wb-est-cor:active { transform: scale(.975); }
.wb-est-cor[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--lat-fundo, #1d1d1d), 0 0 0 3.5px var(--t1, #f0f0f0); }
.wb-est-cor.wb-est-nenhum { background: var(--poco, #171717); }
.wb-est-cor.wb-est-nenhum::after { content: ''; position: absolute; left: 3px; right: 3px; top: 50%; height: 1.5px; background: var(--erro-t, #ff9592); transform: rotate(-45deg); border-radius: 1px; }
.wb-est-seg { display: flex; gap: 2px; padding: 2px; background: var(--poco, #171717); box-shadow: var(--poco-sombra); border-radius: 10px; }
.wb-est-b { flex: 1 1 0; min-width: 0; height: 28px; padding: 0 4px; display: inline-grid; place-items: center; border: 0; border-radius: 8px; background: transparent;
  color: var(--lat-t, #9a9a9a); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background .18s ease, color .18s ease, transform .18s ease; }
.wb-est-b:hover { background: var(--lat-hover, #252525); color: var(--t1, #f0f0f0); }
.wb-est-b:active { transform: scale(.975); }
.wb-est-b[aria-pressed="true"] { background: var(--lat-pilula, #2d2d2d); color: var(--t1, #f0f0f0); box-shadow: var(--lat-pilula-sombra); }
.wb-est-b svg { display: block; }
.wb-est-acoes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.wb-est-acoes .wb-est-b { background: var(--bloco-2, #2e2e2e); height: 30px; flex: none; }
.wb-est-acoes .wb-est-b:hover { background: var(--lat-pilula, #2d2d2d); }
.wb-est-acoes .wb-est-b.wb-est-perigo:hover { color: var(--erro-t, #ff9592); }
.wb-est-acoes .wb-est-b:disabled { opacity: .4; pointer-events: none; }
.wb-est-opac { display: flex; align-items: center; gap: 8px; }
.wb-est-opac input { flex: 1; min-width: 0; margin: 0; accent-color: var(--acento, #6366f1); height: 18px; cursor: pointer; }
.wb-est-opac output { width: 34px; text-align: right; font-family: var(--mono, ui-monospace, monospace); font-size: 11px; font-variant-numeric: tabular-nums; color: var(--lat-t, #9a9a9a); }
.wb-est button:focus-visible, .wb-est input:focus-visible { outline: 2px solid var(--foco, #70b8ff); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .wb-est, .wb-est[data-fora], .wb-est-cor, .wb-est-b { transition: none; }
  .wb-est-cor:hover, .wb-est-cor:active, .wb-est-b:active { transform: none; }
}`;
  document.head.append(st);

  // ── utilidades ──
  const h = (tag, at, ...filhos) => {
    const e = document.createElement(tag);
    if (at) for (const [k, v] of Object.entries(at)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const f of filhos.flat(Infinity)) if (f != null && f !== false) e.append(f.nodeType ? f : String(f));
    return e;
  };
  const svg = (paths) => {
    const v = document.createElementNS(NS, 'svg');
    for (const [k, val] of Object.entries({ viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, val);
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); v.append(p); }
    return v;
  };
  const rgb = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const suave = (hex) => { const [r, g, b] = rgb(hex); return `rgba(${r}, ${g}, ${b}, 0.22)`; };
  const mistura = (hex, base, t) => {
    const a = rgb(hex), b = rgb(base);
    return '#' + a.map((v, i) => Math.round(b[i] + (v - b[i]) * t).toString(16).padStart(2, '0')).join('');
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const comum = (vals) => {
    if (!vals.length) return undefined;
    return vals.every((v) => eq(v, vals[0])) ? vals[0] : MISTO;
  };
  const acao = (nome) => { const A = window.Whiteboard && window.Whiteboard.acoes; const f = A && A[nome]; return typeof f === 'function' ? f : null; };

  // ── estado ──
  let painel = null, ligado = false;
  const R = {}; // referências dos controles
  let ferrAnt = null, quadroPend = false, pendente = false;

  const selecionados = () => N.selecao().map((id) => N.elemento(id)).filter(Boolean);

  // ── aplicar ──
  function aplicar(campo, valor) {
    const els = selecionados();
    if (!els.length) {
      const e = {};
      if (campo === 'cor') e.cor = valor;
      else if (campo === 'preenchimento') e.preenchimento = valor;
      else if (campo === 'opacidade') e.opacidade = valor;
      else if (campo === 'largura') e.traco = { largura: valor };
      else if (campo === 'estilo') e.traco = { estilo: valor };
      else return;
      N.definirEstilo(e);
      return;
    }
    for (const el of els) {
      let c = null;
      if (campo === 'cor') c = { cor: valor };
      else if (campo === 'preenchimento') c = { preenchimento: valor };
      else if (campo === 'fundoNota') { if (el.tipo === 'nota') c = { preenchimento: valor }; }
      else if (campo === 'opacidade') c = { opacidade: valor };
      else if (campo === 'largura') { if (el.tipo !== 'texto' && el.tipo !== 'nota') c = { traco: { ...(el.traco || {}), largura: valor } }; }
      else if (campo === 'estilo') { if (el.tipo !== 'texto' && el.tipo !== 'nota') c = { traco: { ...(el.traco || {}), estilo: valor } }; }
      else if (campo === 'tamanho' || campo === 'alinhar') { if (el.texto) c = { texto: { ...el.texto, [campo]: valor } }; }
      if (c) N.atualizar(el.id, c);
    }
    N.confirmar('Estilo');
  }

  // ── construção ──
  function rotulo(texto, chave) {
    const misto = h('span', { class: 'wb-est-misto', hidden: true }, 'misto');
    R['misto_' + chave] = misto;
    return h('div', { class: 'wb-est-rot' }, h('span', null, texto), misto);
  }
  function botaoSeg(nome, rot, onclick, conteudo) {
    return h('button', { type: 'button', class: 'wb-est-b', 'aria-label': nome, title: nome, 'aria-pressed': 'false', onclick }, conteudo ?? rot);
  }
  function amostra(cor, nome, pressionar, extra = '') {
    const b = h('button', { type: 'button', class: 'wb-est-cor ' + extra, 'aria-label': nome, title: nome, 'aria-pressed': 'false', onclick: pressionar });
    if (cor) b.style.setProperty('--c', cor);
    return b;
  }

  function construir() {
    const sec = (chave, ...filhos) => (R['sec_' + chave] = h('div', { class: 'wb-est-sec' }, ...filhos));

    // Cor do traço
    R.cores = PALETA.map(([c, n]) => { const b = amostra(c, 'Cor do traço: ' + n, () => aplicar('cor', c)); b.dataset.valor = c; return b; });
    R.corExtra = amostra('#000', 'Cor atual', () => {}, ''); R.corExtra.hidden = true;
    const sCor = sec('cor', rotulo('Cor', 'cor'), h('div', { class: 'wb-est-linha', role: 'group', 'aria-label': 'Cor do traço' }, R.cores, R.corExtra));

    // Preenchimento
    R.fillNenhum = amostra(null, 'Sem preenchimento', () => aplicar('preenchimento', null), 'wb-est-nenhum');
    R.fills = PALETA.map(([c, n]) => { const v = suave(c); const b = amostra(v, 'Preenchimento: ' + n, () => aplicar('preenchimento', v)); b.dataset.valor = v; return b; });
    R.fillExtra = amostra('#000', 'Preenchimento atual', () => {}, ''); R.fillExtra.hidden = true;
    const sFill = sec('fill', rotulo('Preenchimento', 'fill'), h('div', { class: 'wb-est-linha', role: 'group', 'aria-label': 'Preenchimento' }, R.fillNenhum, R.fills, R.fillExtra));

    // Fundo da nota
    R.fundos = PALETA.map(([c, n]) => { const v = mistura(c, FUNDO_NOTA, 0.3); const b = amostra(v, 'Fundo da nota: ' + n, () => aplicar('fundoNota', v)); b.dataset.valor = v; return b; });
    R.fundoExtra = amostra('#000', 'Fundo atual da nota', () => {}, ''); R.fundoExtra.hidden = true;
    const sNota = sec('nota', rotulo('Fundo da nota', 'nota'), h('div', { class: 'wb-est-linha', role: 'group', 'aria-label': 'Fundo da nota' }, R.fundos, R.fundoExtra));

    // Espessura
    R.larg = ESPESSURAS.map(([n, v], i) => { const b = botaoSeg('Espessura ' + n.toLowerCase(), '', () => aplicar('largura', v), svg(['M3 8h10'])); b.firstChild.setAttribute('stroke-width', [1, 2, 4][i]); b.dataset.valor = v; return b; });
    const sLarg = sec('larg', rotulo('Espessura', 'larg'), h('div', { class: 'wb-est-seg', role: 'group', 'aria-label': 'Espessura' }, R.larg));

    // Estilo do traço
    R.estilos = ESTILOS.map(([n, v]) => {
      const b = botaoSeg('Traço ' + n.toLowerCase(), '', () => aplicar('estilo', v), svg(['M2.5 8h11']));
      const p = b.firstChild.firstChild;
      if (v === 'tracejado') p.setAttribute('stroke-dasharray', '3 2.5');
      if (v === 'pontilhado') p.setAttribute('stroke-dasharray', '0.1 3');
      b.dataset.valor = v; return b;
    });
    const sEst = sec('estilo', rotulo('Traço', 'estilo'), h('div', { class: 'wb-est-seg', role: 'group', 'aria-label': 'Estilo do traço' }, R.estilos));

    // Opacidade
    R.opac = h('input', { type: 'range', min: 0, max: 100, step: 5, value: 100, 'aria-label': 'Opacidade' });
    R.opacSaida = h('output', null, '100%');
    R.opac.addEventListener('input', () => { R.opacSaida.textContent = R.opac.value + '%'; aplicarOpac(false); });
    R.opac.addEventListener('change', () => aplicarOpac(true));
    const sOp = sec('opac', rotulo('Opacidade', 'opac'), h('div', { class: 'wb-est-opac' }, R.opac, R.opacSaida));

    // Texto
    R.tams = TAMANHOS.map(([n, v]) => { const b = botaoSeg('Tamanho ' + n, n, () => aplicar('tamanho', v)); b.dataset.valor = v; return b; });
    const ICO_ALIN = { esquerda: ['M3 4h10M3 8h6M3 12h8'], centro: ['M3 4h10M5 8h6M4 12h8'], direita: ['M3 4h10M7 8h6M5 12h8'] };
    R.alins = ALINHAMENTOS.map(([n, v]) => { const b = botaoSeg('Alinhar texto: ' + n.toLowerCase(), '', () => aplicar('alinhar', v), svg(ICO_ALIN[v])); b.dataset.valor = v; return b; });
    const sTx = sec('texto', rotulo('Texto', 'tam'),
      h('div', { class: 'wb-est-seg', role: 'group', 'aria-label': 'Tamanho do texto' }, R.tams),
      h('div', { class: 'wb-est-seg', role: 'group', 'aria-label': 'Alinhamento do texto' }, R.alins));

    // Ações
    const IC = {
      frente: ['M8 2.5 13 6 8 9.5 3 6z', 'M3 9l5 3.5L13 9'], tras: ['M8 13.5 3 10 8 6.5l5 3.5z', 'M3 7l5-3.5L13 7'],
      subir: ['M8 13V3.5M4.5 7 8 3.5 11.5 7'], descer: ['M8 3v9.5M4.5 9 8 12.5 11.5 9'],
      esq: ['M3 2.5v11M5.5 5h7M5.5 10h4'], ch: ['M8 2.5v11M4 5h8M5.5 10h5'], dir: ['M13 2.5v11M3.5 5h7.5M6.5 10h4.5'],
      topo: ['M2.5 3h11M5 5.5v7M10 5.5v4'], cv: ['M2.5 8h11M5 4v8M10 5.5v5'], base: ['M2.5 13h11M5 3.5v7M10 6.5v4'],
      dh: ['M3 2.5v11M13 2.5v11M8 5v6'], dv: ['M2.5 3h11M2.5 13h11M5 8h6'],
      agrupar: ['M2.5 2.5h4v4h-4zM9.5 9.5h4v4h-4z', 'M6.5 4.5h3v5'], desagrupar: ['M2.5 2.5h4v4h-4zM9.5 9.5h4v4h-4z'],
      duplicar: ['M5.5 5.5h8v8h-8z', 'M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7'],
      apagar: ['M2.8 4.3h10.4M6.3 4.3V3a.8.8 0 0 1 .8-.8h1.8a.8.8 0 0 1 .8.8v1.3M4.2 4.3l.6 8.6a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.6'],
    };
    const btnAcao = (nome, rot, ic, fn, extra = '') => {
      const b = h('button', { type: 'button', class: 'wb-est-b ' + extra, 'aria-label': rot, title: rot, 'data-acao': nome }, svg(IC[ic]));
      b.addEventListener('click', () => { const f = fn(); if (f) f(); });
      return b;
    };
    R.acCamada = [
      btnAcao('frente', 'Trazer para frente', 'frente', () => { const f = acao('camada'); return f && (() => f('frente')); }),
      btnAcao('subir', 'Subir uma camada', 'subir', () => { const f = acao('camada'); return f && (() => f('subir')); }),
      btnAcao('descer', 'Descer uma camada', 'descer', () => { const f = acao('camada'); return f && (() => f('descer')); }),
      btnAcao('trás', 'Enviar para trás', 'tras', () => { const f = acao('camada'); return f && (() => f('trás')); }),
    ];
    R.acAlinhar = [
      ['esquerda', 'Alinhar à esquerda', 'esq'], ['centroH', 'Centralizar na horizontal', 'ch'], ['direita', 'Alinhar à direita', 'dir'],
      ['topo', 'Alinhar ao topo', 'topo'], ['centroV', 'Centralizar na vertical', 'cv'], ['base', 'Alinhar à base', 'base'],
    ].map(([l, r, ic]) => btnAcao('alinhar-' + l, r, ic, () => { const f = acao('alinhar'); return f && (() => f(l)); }));
    R.acDistrib = [
      btnAcao('distribuir-h', 'Distribuir na horizontal', 'dh', () => { const f = acao('distribuir'); return f && (() => f('h')); }),
      btnAcao('distribuir-v', 'Distribuir na vertical', 'dv', () => { const f = acao('distribuir'); return f && (() => f('v')); }),
    ];
    R.acGrupo = [
      btnAcao('agrupar', 'Agrupar', 'agrupar', () => acao('agrupar')),
      btnAcao('desagrupar', 'Desagrupar', 'desagrupar', () => acao('desagrupar')),
    ];
    R.acFim = [
      btnAcao('duplicar', 'Duplicar', 'duplicar', () => acao('duplicar')),
      btnAcao('apagar', 'Apagar', 'apagar', () => acao('apagar'), 'wb-est-perigo'),
    ];
    const grade = (lista) => h('div', { class: 'wb-est-acoes' }, lista);
    const sCam = sec('camadas', rotulo('Camadas', 'cam'), grade(R.acCamada));
    const sAli = sec('alinhar', rotulo('Alinhar', 'ali'), grade([R.acAlinhar, R.acDistrib]));
    const sAc = sec('acoes', grade([R.acGrupo, R.acFim]));

    painel = h('div', { class: 'wb-est', role: 'region', 'aria-label': 'Propriedades', 'data-fora': '' }, sCor, sFill, sNota, sLarg, sEst, sOp, sTx, sCam, sAli, sAc);
    painel.addEventListener('pointerdown', (e) => e.stopPropagation());
    painel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    painel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { try { document.querySelector('.wb-palco')?.focus({ preventScroll: true }); } catch {} } });
  }

  function aplicarOpac(fechar) {
    const v = Math.max(0, Math.min(100, +R.opac.value)) / 100;
    const els = selecionados();
    if (!els.length) { N.definirEstilo({ opacidade: v }); return; }
    for (const el of els) if (el.opacidade !== v) N.atualizar(el.id, { opacidade: v });
    if (fechar) N.confirmar('Estilo');
  }

  // ── reflexo do estado ──
  function marcar(botoes, valor, ignorarEstilo) {
    for (const b of botoes) {
      const v = b.dataset.valor;
      const on = valor !== MISTO && valor !== undefined && String(valor) === v;
      b.setAttribute('aria-pressed', String(on));
    }
  }
  function extra(btn, valor, lista, fn) {
    const fora = typeof valor === 'string' && !lista.some((b) => b.dataset.valor === valor);
    btn.hidden = !fora;
    if (fora) { btn.style.setProperty('--c', valor); btn.setAttribute('aria-pressed', 'true'); btn.setAttribute('aria-label', btn.getAttribute('aria-label').replace(/:.*$/, '') + ': ' + valor); }
  }
  function dizerMisto(chave, misto) { if (R['misto_' + chave]) R['misto_' + chave].hidden = !misto; }

  function atualizarPainel() {
    pendente = false;
    tentarMontar();
    if (!painel) return;
    const els = selecionados();
    const ferr = N.ferramenta();
    const desenho = FERR_DESENHO.has(ferr);
    const visivel = els.length > 0 || desenho;
    painel.toggleAttribute('data-fora', !visivel);
    painel.setAttribute('aria-hidden', String(!visivel));
    if (!visivel) return;

    const est = N.estiloAtual();
    const tipos = new Set(els.map((e) => e.tipo));
    const soTexto = els.length > 0 && els.every((e) => e.tipo === 'texto');
    const haNota = tipos.has('nota');
    const haTexto = els.some((e) => (e.tipo === 'texto' || e.tipo === 'nota') && e.texto);
    const haForma = els.length === 0 ? !(ferr === 'texto' || ferr === 'nota') : els.some((e) => e.tipo !== 'texto' && e.tipo !== 'nota');
    const haPreench = els.length === 0 ? !SEM_PREENCHIMENTO.has(ferr) && haForma : els.some((e) => e.tipo !== 'texto' && e.tipo !== 'nota' && !SEM_PREENCHIMENTO.has(e.tipo));

    const vis = (chave, on) => { R['sec_' + chave].hidden = !on; };
    vis('cor', true);
    vis('fill', haPreench && !soTexto);
    vis('nota', haNota);
    vis('larg', haForma);
    vis('estilo', haForma);
    vis('opac', true);
    vis('texto', haTexto);
    const n = els.length;
    vis('camadas', n > 0 && !!acao('camada'));
    for (const b of R.acCamada) b.hidden = !acao('camada');
    vis('alinhar', n >= 2 && (!!acao('alinhar') || !!acao('distribuir')));
    for (const b of R.acAlinhar) b.hidden = !acao('alinhar');
    for (const b of R.acDistrib) b.hidden = !acao('distribuir');
    const temGrupo = els.some((e) => e.grupo);
    R.acGrupo[0].hidden = !(n >= 2 && acao('agrupar'));
    R.acGrupo[1].hidden = !(temGrupo && acao('desagrupar'));
    R.acFim[0].hidden = !(n > 0 && acao('duplicar'));
    R.acFim[1].hidden = !(n > 0 && acao('apagar'));
    vis('acoes', n > 0 && [...R.acGrupo, ...R.acFim].some((b) => !b.hidden));

    const val = (fn, padrao) => (n ? comum(els.map(fn)) : padrao);
    const formas = els.filter((e) => e.tipo !== 'texto' && e.tipo !== 'nota');
    const valForma = (fn, padrao) => (n ? comum(formas.map(fn)) : padrao);

    const cor = val((e) => e.cor, est.cor);
    marcar(R.cores, cor); extra(R.corExtra, cor, R.cores); dizerMisto('cor', cor === MISTO);

    const pre = n ? comum(els.filter((e) => e.tipo !== 'nota' && e.tipo !== 'texto').map((e) => e.preenchimento ?? null)) : (est.preenchimento ?? null);
    marcar(R.fills, pre);
    R.fillNenhum.setAttribute('aria-pressed', String(pre === null));
    extra(R.fillExtra, pre, R.fills); dizerMisto('fill', pre === MISTO);

    const fundo = comum(els.filter((e) => e.tipo === 'nota').map((e) => e.preenchimento ?? null));
    marcar(R.fundos, fundo); extra(R.fundoExtra, fundo, R.fundos); dizerMisto('nota', fundo === MISTO);

    const larg = valForma((e) => e.traco?.largura, est.traco.largura);
    marcar(R.larg, larg); dizerMisto('larg', larg === MISTO);
    const estilo = valForma((e) => e.traco?.estilo, est.traco.estilo);
    marcar(R.estilos, estilo); dizerMisto('estilo', estilo === MISTO);

    const op = val((e) => e.opacidade ?? 1, est.opacidade);
    dizerMisto('opac', op === MISTO);
    if (document.activeElement !== R.opac) R.opac.value = String(Math.round((op === MISTO ? (els[0].opacidade ?? 1) : op) * 100));
    R.opacSaida.textContent = op === MISTO ? '—' : Math.round(op * 100) + '%';

    const comTexto = els.filter((e) => e.texto);
    const tam = comum(comTexto.map((e) => e.texto.tamanho));
    marcar(R.tams, tam); dizerMisto('tam', tam === MISTO);
    marcar(R.alins, comum(comTexto.map((e) => e.texto.alinhar)));
  }

  function pedir() {
    if (pendente) return;
    pendente = true;
    requestAnimationFrame(atualizarPainel);
  }

  // ── montagem na vista e ligação aos eventos ──
  function tentarMontar() {
    const raiz = document.querySelector('.wb-vista');
    if (!raiz) return false;
    if (!painel) construir();
    if (painel.parentNode !== raiz) raiz.append(painel);
    if (!ligado) {
      ligado = true;
      for (const ev of ['selecao', 'estilo', 'ferramenta', 'quadro', 'mudanca', 'historico', 'confirmar']) { try { N.on(ev, pedir); } catch {} }
    }
    return true;
  }

  tentarMontar();
  pedir();

  window.WhiteboardEstilo = { PALETA, atualizar: atualizarPainel };
})();
