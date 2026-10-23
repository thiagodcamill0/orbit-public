// Orbit — Whiteboard (etapa 2: texto, nota adesiva e borracha). Carregado depois de whiteboard.js.
// Tipos 'texto' e 'nota' (edição num <textarea> na camada HTML, acompanha a câmera), ferramentas texto (T), nota (S) e
// borracha (E). Traço limpo; estilo vem de nucleo.estiloAtual() (ou PADRAO). Excalidraw (MIT) só como referência de técnica.
// Também expõe window.WhiteboardTexto = { quebrar, medir, editar(id), criarEm(x, y, tipo) } (apoio a testes e ao núcleo).
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.registrarTipo || !W.nucleo) return;
  const N = W.nucleo;
  const PADRAO = { cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1 };
  const LH = 1.25;                 // altura de linha (× tamanho)
  const TAM_TEXTO = 20;            // tamanho padrão do texto
  const NOTA = { lado: 200, min: 80, pad: 12, tam: 16, fundo: '#463a1e' }; // fundo: âmbar do Orbit bem discreto
  const estilo = () => { try { return (N.estiloAtual && N.estiloAtual()) || PADRAO; } catch { return PADRAO; } };

  const st = document.createElement('style');
  st.textContent = `
.wb-tx-campo { position: absolute; left: 0; top: 0; margin: 0; padding: 0; border: 0; outline: 1px dashed var(--acento, #6366f1); outline-offset: 2px;
  background: transparent; resize: none; overflow: hidden; pointer-events: auto; font-family: var(--sans, system-ui, sans-serif); font-weight: 400;
  caret-color: currentColor; white-space: pre; box-sizing: content-box; z-index: 100000; }
.wb-tx-campo.wb-tx-nota { white-space: pre-wrap; overflow-wrap: anywhere; box-sizing: border-box; outline-offset: -3px; }`;
  document.head.append(st);

  // ── medição e quebra ──
  let familiaCache = '';
  const familia = () => {
    if (!familiaCache) familiaCache = (getComputedStyle(document.documentElement).getPropertyValue('--sans') || '').trim();
    return familiaCache || 'system-ui, sans-serif';
  };
  const fonte = (tam) => `400 ${tam}px ${familia()}`;
  const cm = document.createElement('canvas').getContext('2d');
  const largura = (s, tam) => { cm.font = fonte(tam); return cm.measureText(s).width; };
  function medir(valor, tam) {
    const ls = String(valor || '').split('\n');
    let w = 0;
    for (const l of ls) w = Math.max(w, largura(l, tam));
    return { w: Math.max(w, tam * 0.5), h: ls.length * tam * LH, linhas: ls };
  }
  // Quebra automática por palavras na largura dada (palavra maior que a largura quebra por letras).
  function quebrarTexto(valor, tam, larg) {
    const saida = [];
    cm.font = fonte(tam);
    for (const par of String(valor || '').split('\n')) {
      let atual = '';
      for (const pal of par.split(/(?<= )/)) {
        if (cm.measureText((atual + pal).trimEnd()).width <= larg) { atual += pal; continue; }
        if (atual) { saida.push(atual.trimEnd()); atual = ''; }
        let resto = pal;
        while (cm.measureText(resto.trimEnd()).width > larg && resto.length > 1) {
          let i = resto.length - 1;
          while (i > 1 && cm.measureText(resto.slice(0, i)).width > larg) i--;
          saida.push(resto.slice(0, i)); resto = resto.slice(i);
        }
        atual = resto;
      }
      saida.push(atual.trimEnd());
    }
    return saida;
  }
  const quebrar = (el) => {
    if (el.tipo === 'nota') return quebrarTexto(el.texto && el.texto.valor, (el.texto && el.texto.tamanho) || NOTA.tam, Math.max(1, Math.abs(el.w) - 2 * NOTA.pad));
    return medir(el.texto && el.texto.valor, (el.texto && el.texto.tamanho) || TAM_TEXTO).linhas;
  };

  // ── tipos ──
  const caixaDe = (el) => N.util.caixaNormal(el);
  registrarTexto();
  function registrarTexto() {
    W.registrarTipo('texto', {
      desenhar(ctx, el) {
        const b = caixaDe(el), t = el.texto || {};
        if (el.preenchimento) { ctx.fillStyle = el.preenchimento; ctx.fillRect(b.x, b.y, b.w, b.h); }
        if (el._editando) return;
        const tam = t.tamanho || TAM_TEXTO, lh = tam * LH, al = t.alinhar || 'esquerda';
        ctx.font = fonte(tam); ctx.fillStyle = el.cor; ctx.textBaseline = 'top';
        ctx.textAlign = al === 'centro' ? 'center' : al === 'direita' ? 'right' : 'left';
        const x = al === 'centro' ? b.x + b.w / 2 : al === 'direita' ? b.x + b.w : b.x;
        String(t.valor || '').split('\n').forEach((l, i) => ctx.fillText(l, x, b.y + i * lh + (lh - tam) / 2));
      },
      testarClique(el, px, py, tol) { return N.util.dentro(caixaDe(el), px, py, tol); },
      editar(el) { iniciar(el.id, false); },
    });
    W.registrarTipo('nota', {
      desenhar(ctx, el, info) {
        const b = caixaDe(el), t = el.texto || {}, z = (info && info.zoom) || 1, dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, .5)'; ctx.shadowBlur = 14 * z * dpr; ctx.shadowOffsetY = 3 * z * dpr;
        ctx.fillStyle = el.preenchimento || NOTA.fundo;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, 4); else ctx.rect(b.x, b.y, b.w, b.h);
        ctx.fill();
        ctx.restore();
        if (el._editando) return;
        const tam = t.tamanho || NOTA.tam, lh = tam * LH;
        ctx.save();
        ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
        ctx.font = fonte(tam); ctx.fillStyle = el.cor; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        quebrar(el).forEach((l, i) => ctx.fillText(l, b.x + NOTA.pad, b.y + NOTA.pad + i * lh + (lh - tam) / 2));
        ctx.restore();
      },
      testarClique(el, px, py, tol) { return N.util.dentro(caixaDe(el), px, py, tol); },
      editar(el) { iniciar(el.id, false); },
      aoRedimensionar(el, campos) {
        const w = campos && campos.w != null ? campos.w : el.w, h = campos && campos.h != null ? campos.h : el.h;
        const aj = {};
        if (Math.abs(w) < NOTA.min) aj.w = w < 0 ? -NOTA.min : NOTA.min;
        if (Math.abs(h) < NOTA.min) aj.h = h < 0 ? -NOTA.min : NOTA.min;
        return Object.keys(aj).length ? aj : undefined;
      },
    });
  }

  // ── edição ──
  let ED = null; // { id, ta, novo, antes, nota }
  function posicionar() {
    if (!ED) return;
    const el = N.elemento(ED.id);
    if (!el) return;
    const s = ED.ta.style, b = caixaDe(el), tam = el.texto.tamanho;
    if (ED.nota) {
      s.left = b.x + 'px'; s.top = b.y + 'px'; s.width = b.w + 'px'; s.height = b.h + 'px';
    } else {
      const folga = Math.ceil(tam * 0.5);
      s.left = (b.x - folga / 2) + 'px'; s.top = b.y + 'px'; s.width = (b.w + folga) + 'px'; s.height = b.h + 'px';
    }
    s.transform = el.angulo ? `rotate(${el.angulo}rad)` : '';
    s.opacity = String(el.opacidade);
  }
  function aoDigitar() {
    if (!ED) return;
    const el = N.elemento(ED.id);
    if (!el) { ED = null; return; }
    const valor = ED.ta.value, t = { ...el.texto, valor };
    if (ED.nota) { N.atualizar(el.id, { texto: t }); return; }
    const m = medir(valor, t.tamanho), dw = m.w - Math.abs(el.w), al = t.alinhar;
    N.atualizar(el.id, { texto: t, w: m.w, h: m.h, x: al === 'centro' ? el.x - dw / 2 : al === 'direita' ? el.x - dw : el.x });
    posicionar();
  }
  function terminar(porTecla) {
    const ed = ED;
    if (!ed) return;
    ED = null;
    const el = N.elemento(ed.id), valor = ed.ta.value;
    ed.ta.remove();
    if (!el) return;
    delete el._editando;
    const mudou = valor !== ed.antes;
    if (!ed.nota && !valor.trim()) {
      N.remover([el.id]);
      if (!ed.novo) N.confirmar('Apagar texto');
    } else {
      N.atualizar(el.id, { texto: { ...el.texto, valor } });
      if (ed.novo || mudou) N.confirmar(ed.novo ? (ed.nota ? 'Criar nota' : 'Criar texto') : 'Editar ' + (ed.nota ? 'nota' : 'texto'));
      N.definirFerramenta('selecionar');
      N.selecionar([el.id]);
    }
    if (!N.elemento(el.id)) N.selecionar([]);
    if (porTecla) { const p = N.camadaHtml() && N.camadaHtml().closest('.wb-palco'); if (p) try { p.focus({ preventScroll: true }); } catch {} }
    N.redesenhar();
  }
  function iniciar(id, novo) {
    terminar(false);
    const el = N.elemento(id), cam = N.camadaHtml();
    if (!el || !cam || (!novo && N.travado(el))) return;
    const nota = el.tipo === 'nota';
    if (!el.texto) N.atualizar(id, { texto: { valor: '', tamanho: nota ? NOTA.tam : TAM_TEXTO, alinhar: 'esquerda' } });
    const t = N.elemento(id).texto;
    const ta = document.createElement('textarea');
    ta.className = 'wb-tx-campo' + (nota ? ' wb-tx-nota' : '');
    ta.value = t.valor || '';
    ta.spellcheck = false; ta.wrap = nota ? 'soft' : 'off'; ta.setAttribute('aria-label', nota ? 'Texto da nota' : 'Texto');
    const s = ta.style;
    s.fontSize = t.tamanho + 'px'; s.lineHeight = String(LH); s.color = el.cor; s.textAlign = nota ? 'left' : t.alinhar === 'centro' ? 'center' : t.alinhar === 'direita' ? 'right' : 'left';
    if (nota) s.padding = NOTA.pad + 'px';
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('dblclick', (e) => e.stopPropagation());
    ta.addEventListener('input', aoDigitar);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); terminar(true); } });
    ta.addEventListener('blur', () => { if (ED && ED.ta === ta) terminar(false); });
    ED = { id, ta, novo, antes: ta.value, nota };
    N.atualizar(id, { _editando: true });
    cam.append(ta);
    posicionar();
    N.redesenhar();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    requestAnimationFrame(() => { if (ED && ED.ta === ta && document.activeElement !== ta) ta.focus({ preventScroll: true }); });
  }
  N.on('quadro', () => { if (ED) { const id = ED.id; ED.ta.remove(); const el = N.elemento(id); if (el) delete el._editando; ED = null; } });

  // ── criação ──
  function criar(tipo, x, y) {
    const e = estilo();
    if (tipo === 'nota') {
      const L = NOTA.lado;
      return N.adicionar({ tipo, x: x - L / 2, y: y - L / 2, w: L, h: L, angulo: 0, cor: e.cor, traco: e.traco, preenchimento: e.preenchimento || NOTA.fundo, opacidade: e.opacidade, texto: { valor: '', tamanho: NOTA.tam, alinhar: 'esquerda' } });
    }
    const m = medir('', TAM_TEXTO);
    return N.adicionar({ tipo: 'texto', x, y: y - m.h / 2, w: m.w, h: m.h, angulo: 0, cor: e.cor, traco: e.traco, preenchimento: null, opacidade: e.opacidade, texto: { valor: '', tamanho: TAM_TEXTO, alinhar: 'esquerda' } });
  }
  function criarEm(x, y, tipo) {
    const el = criar(tipo || 'texto', x, y);
    iniciar(el.id, true);
    return el;
  }
  const ICONE_TEXTO = [['path', { d: 'M3.5 4.5V3h9v1.5M8 3v10M6 13h4' }]];
  const ICONE_NOTA = [['path', { d: 'M3 3h10v6.5L9.5 13H3z' }], ['path', { d: 'M9.5 13V9.5H13' }]];
  const ICONE_BORRACHA = [['path', { d: 'M9.6 13H13M6.2 13H3.6L2.5 11.9a1 1 0 0 1 0-1.4L9 4a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4L8.6 12.4M5 7.6l3.4 3.4' }]];

  // Ferramentas de criação: clicar cria e já edita. Clicar num texto/nota existente edita esse.
  const criador = (tipo, rotulo, tecla, ordem, icone) => ({
    rotulo, icone, tecla, ordem, cursor: tipo === 'texto' ? 'text' : 'crosshair',
    aoDescer(p) { this.d = { x: p.x, y: p.y }; },
    aoSubir(p) {
      const d = this.d; this.d = null;
      if (!d || Math.hypot(p.x - d.x, p.y - d.y) * N.camera().zoom > 6) return;
      const alvo = N.elementoEm(d.x, d.y);
      if (alvo && (alvo.tipo === 'texto' || alvo.tipo === 'nota') && N.travado(alvo)) return; // travado: nem edita nem cria por cima
      if (alvo && (alvo.tipo === 'texto' || alvo.tipo === 'nota')) iniciar(alvo.id, false);
      else criarEm(d.x, d.y, tipo);
    },
    aoCancelar() { this.d = null; },
  });
  W.registrarFerramenta('texto', { ...criador('texto', 'Texto', 't', 60, ICONE_TEXTO), criarEm: (p) => { if (p) criarEm(p.x, p.y, 'texto'); } });
  W.registrarFerramenta('nota', criador('nota', 'Nota adesiva', 's', 70, ICONE_NOTA));

  // ── borracha ──
  const B = { marc: new Set(), trilha: [], ult: null, ativo: false, raf: 0 };
  const TRILHA_MS = 350;
  function marcarEm(x, y) {
    const alvo = N.elementoEm(x, y);
    if (!alvo) return;
    const grupo = alvo.grupo ? N.elementos().filter((o) => o.grupo === alvo.grupo) : [alvo];
    for (const el of grupo) {
      if (B.marc.has(el.id) || N.travado(el)) continue;
      B.marc.add(el.id);
      N.atualizar(el.id, { _esmaecer: true });
    }
  }
  function restaurar() {
    for (const id of B.marc) N.atualizar(id, { _esmaecer: false });
    B.marc.clear();
  }
  function varrer(x, y) {
    const u = B.ult || { x, y }, z = N.camera().zoom;
    const n = Math.max(1, Math.ceil(Math.hypot(x - u.x, y - u.y) * z / 4));
    for (let i = 1; i <= n; i++) marcarEm(u.x + (x - u.x) * i / n, u.y + (y - u.y) * i / n);
    B.ult = { x, y };
  }
  W.registrarFerramenta('borracha', {
    rotulo: 'Borracha', icone: ICONE_BORRACHA, tecla: 'e', ordem: 80, cursor: 'crosshair',
    aoDescer(p) { B.ativo = true; B.ult = null; B.trilha.push({ sx: p.sx, sy: p.sy, t: performance.now(), novo: true }); varrer(p.x, p.y); },
    aoMover(p) { if (!B.ativo) return; B.trilha.push({ sx: p.sx, sy: p.sy, t: performance.now() }); varrer(p.x, p.y); },
    aoSubir() {
      if (!B.ativo) return;
      B.ativo = false; B.ult = null;
      const ids = [...B.marc];
      B.marc.clear();
      if (ids.length) { N.remover(ids); N.confirmar('Apagar'); }
    },
    aoCancelar() { B.ativo = false; B.ult = null; B.trilha.length = 0; restaurar(); },
    aoDesativar() { B.ativo = false; B.ult = null; B.trilha.length = 0; restaurar(); },
    aoDesenhar(ctx) {
      const agora = performance.now();
      while (B.trilha.length && agora - B.trilha[0].t > TRILHA_MS) B.trilha.shift();
      if (!B.trilha.length) return;
      ctx.lineCap = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = '#f0f0f0';
      for (let i = 1; i < B.trilha.length; i++) {
        const a = B.trilha[i - 1], b = B.trilha[i];
        if (b.novo) continue;
        ctx.globalAlpha = Math.max(0, 0.5 * (1 - (agora - b.t) / TRILHA_MS));
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (!B.raf) B.raf = requestAnimationFrame(() => { B.raf = 0; N.redesenhar(); });
    },
  });

  window.WhiteboardTexto = { quebrar, medir, editar: (id) => iniciar(id, false), criarEm };
})();
