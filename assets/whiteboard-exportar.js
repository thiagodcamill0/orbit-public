// Orbit — Whiteboard (etapa 6: exportar o quadro em PNG e SVG). Carregado depois dos outros módulos do whiteboard.
// Publica Whiteboard.exportar = { png(op) → Promise<Blob>, svg(op) → Promise<string>, abrir(op), fechar(), aberto(),
//   medir(op) → { vazio, w, h, escala, reduzida, vx, vy, vw, vh, total }, nomeArquivo(ext) }.
//   op = { selecao: bool (padrão: a seleção se houver, senão tudo), fundo: 'tema' | 'transparente', escala: 1 | 2 | 3 (PNG),
//          margem: 32 }. PNG limitado a ~16 MP (e 16384 px de lado): a escala é reduzida e medir() avisa (reduzida: true).
// Como desenha (o resultado deve parecer a tela, sem grade, seleção, alças, cadeado nem esmaecido da borracha):
//   · duas passadas, como na tela: primeiro o que vai no canvas (em z), depois a camada HTML (em z), sempre por cima;
//   · PNG: canvas fora da tela com a câmera na caixa do conteúdo, usando as próprias funções desenhar() dos tipos (nucleo.tipo(nome));
//   · SVG: elementos nativos equivalentes (rect com rx, ellipse, polygon, path, text/tspan com a mesma quebra da nota);
//   · cards só-HTML (agente, subagente, cabeçalho do time): um clone do nó vivo, fora da tela e sem seleção/transição, é
//     percorrido em caixas (fundo/borda/raio), textos (fonte computada, reticências) e imagens (sprite → PNG pelo quadro
//     atual do gif). Card web: desenhado à mão como o cartão-resumo (cabeçalho com globo e título; corpo com globo, host
//     e endereço) — o conteúdo do iframe não é exportável.
// Interface: botão no cabeçalho flutuante (.wb-topo) e Ctrl+Shift+E abrem um diálogo (prévia, formato, área, fundo, escala,
// Copiar/Baixar). Enquanto aberto, as teclas não chegam ao quadro (ouvinte de captura na window).
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.nucleo || typeof W.estender !== 'function') return;
  const N = W.nucleo;
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_PX = 16e6, MAX_LADO = 16384, MARGEM = 32;
  const HTML_SO = new Set(['agente', 'subagente', 'web']);
  const GLOBO = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3.6 9h16.8 M3.6 15h16.8 M12 3c-2.4 2.6-3.6 5.6-3.6 9s1.2 6.4 3.6 9 M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9';
  const num = (v, d = 0) => (v != null && Number.isFinite(+v) ? +v : d);
  const f = (n) => String(Math.round(num(n) * 100) / 100);
  const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const reduzido = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const vista = () => { const c = N.camadaHtml && N.camadaHtml(); return (c && c.closest('.wb-vista')) || document.querySelector('.wb-vista'); };

  // ── tipos registrados (só leitura) ──
  const tipos = () => ({ get: (n) => { try { return N.tipo(n) || null; } catch { return null; } } });
  const temHtml = (el) => { const t = tipos().get(el.tipo); return t ? !!t.html : HTML_SO.has(el.tipo) || el.tipo === 'time'; };
  const soHtml = (el) => { const t = tipos().get(el.tipo); return t ? !!t.html && !t.desenhar : HTML_SO.has(el.tipo); };

  // ── cores e fontes ──
  const cm = document.createElement('canvas').getContext('2d');
  function rgba(c) {
    cm.fillStyle = '#000'; cm.fillStyle = String(c || '');
    const s = cm.fillStyle;
    if (s[0] === '#') return { hex: s, a: 1 };
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return { hex: '#000000', a: 1 };
    const p = m[1].split(',').map((x) => parseFloat(x));
    const hex = '#' + p.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    return { hex, a: p.length > 3 ? p[3] : 1 };
  }
  const alfa = (c) => (!c || c === 'transparent' ? 0 : rgba(c).a);
  const pintura = (attr, c) => { const r = rgba(c); return ` ${attr}="${r.hex}"` + (r.a < 1 ? ` ${attr}-opacity="${f(Math.round(r.a * 1000) / 1000)}"` : ''); };
  function token(n, p) { const v = vista() || document.documentElement; return getComputedStyle(v).getPropertyValue(n).trim() || p; }
  function corFundo() { const v = vista(); const c = v ? getComputedStyle(v).backgroundColor : ''; return alfa(c) > 0 ? c : token('--fundo', '#0a0a0a'); }
  const familiaTexto = () => (getComputedStyle(document.documentElement).getPropertyValue('--sans') || '').trim() || 'system-ui, sans-serif';
  const comReserva = (fam) => (/sans-serif\s*$/.test(fam) || /monospace\s*$/.test(fam) ? fam : fam + ', system-ui, sans-serif');
  // Deslocamento da linha de base: canvas 'top' (topo do quadrado em) e 'middle' (meio dele) → y alfabético do SVG.
  function metricas(fonte, tam) {
    cm.font = fonte; cm.textBaseline = 'alphabetic';
    const m = cm.measureText('Mg');
    const asc = num(m.emHeightAscent, NaN), desc = num(m.emHeightDescent, NaN);
    return Number.isFinite(asc) && Number.isFinite(desc) ? { asc, desc } : { asc: tam * 0.8, desc: tam * 0.2 };
  }
  function cortar(txt, fonte, larg) {
    cm.font = fonte;
    if (cm.measureText(txt).width <= larg + 0.5) return txt;
    let a = 0, b = txt.length;
    while (a < b) { const m = (a + b + 1) >> 1; if (cm.measureText(txt.slice(0, m).trimEnd() + '…').width <= larg + 0.5) a = m; else b = m - 1; }
    return txt.slice(0, a).trimEnd() + '…';
  }

  // ── o que exportar ──
  function conteudo(op) {
    const todos = N.elementos().filter((el) => el && el.tipo);
    const sel = new Set(N.selecao());
    const usarSel = op.selecao == null ? sel.size > 0 : !!op.selecao;
    let lista = todos;
    if (usarSel) {
      const raizes = new Set(todos.filter((el) => sel.has(el.id) && el.tipo === 'time' && el.time).map((el) => el.time.raiz));
      lista = todos.filter((el) => sel.has(el.id) || (el.tipo !== 'time' && el.time && raizes.has(el.time.raiz)));
    }
    let caixa = null;
    for (const el of lista) {
      let c; try { c = N.caixaMundo(el); } catch { continue; }
      if (!c || ![c.x, c.y, c.w, c.h].every(Number.isFinite)) continue;
      caixa = caixa ? { x0: Math.min(caixa.x0, c.x), y0: Math.min(caixa.y0, c.y), x1: Math.max(caixa.x1, c.x + c.w), y1: Math.max(caixa.y1, c.y + c.h) } : { x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h };
    }
    return { lista, soSelecao: usarSel, caixa: caixa && { x: caixa.x0, y: caixa.y0, w: caixa.x1 - caixa.x0, h: caixa.y1 - caixa.y0 } };
  }
  function plano(op = {}) {
    const c = conteudo(op);
    const m = Math.max(0, num(op.margem, MARGEM)), fundo = op.fundo === 'transparente' ? 'transparente' : 'tema';
    const pedida = num(op.escala, 1) > 0 ? num(op.escala, 1) : 1;
    if (!c.lista.length || !c.caixa) return { ...c, vazio: true, m, fundo, escala: pedida, pedida, reduzida: false, w: 0, h: 0, total: 0 };
    const vw = Math.max(1, c.caixa.w + 2 * m), vh = Math.max(1, c.caixa.h + 2 * m);
    const lim = Math.min(Math.sqrt(MAX_PX / (vw * vh)), MAX_LADO / Math.max(vw, vh));
    const reduzida = pedida > lim, s = reduzida ? lim : pedida;
    return { ...c, vazio: false, m, fundo, escala: s, pedida, reduzida, vx: c.caixa.x - m, vy: c.caixa.y - m, vw, vh,
      w: Math.max(1, Math.round(vw * s)), h: Math.max(1, Math.round(vh * s)), total: c.lista.length };
  }

  // ── cena dos cards só-HTML: itens em coordenadas locais do card ──
  const px = (v) => parseFloat(v) || 0;
  const noDe = (id) => { const c = N.camadaHtml && N.camadaHtml(); return c ? c.querySelector(`.wb-no[data-id="${CSS.escape(id)}"]`) : null; };
  function cenaDoNo(el) {
    const vivo = noDe(el.id);
    if (!vivo || !vivo.parentNode) return null;
    const cl = vivo.cloneNode(true);
    cl.removeAttribute('data-id');
    for (const n of [cl, ...cl.querySelectorAll('*')]) for (const c of [...n.classList]) if (/-sel$|destaque|-entra$|^entra$|^saindo$/.test(c)) n.classList.remove(c);
    cl.classList.add('wb-ex-clone');
    cl.style.transform = 'translate(-100000px, -100000px)';
    cl.style.opacity = '1';
    vivo.parentNode.append(cl);
    const vivas = [...vivo.querySelectorAll('img')], copias = [...cl.querySelectorAll('img')];
    try {
      const R = cl.getBoundingClientRect(), k = R.width / (cl.offsetWidth || 1) || 1;
      const caixa = (e) => { const r = e.getBoundingClientRect(); return { x: (r.left - R.left) / k, y: (r.top - R.top) / k, w: r.width / k, h: r.height / k }; };
      const itens = [];
      const visitar = (e, a, clip) => {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (e !== cl) a *= num(parseFloat(cs.opacity), 1);
        if (a <= 0.004) return;
        const b = caixa(e), r = Math.max(0, Math.min(px(cs.borderTopLeftRadius), b.w / 2, b.h / 2));
        if (e.tagName === 'IMG') {
          itens.push({ t: 'img', ...b, a, clip, img: vivas[copias.indexOf(e)] || e, filtro: cs.filter && cs.filter !== 'none' ? cs.filter : '', pixel: /pixelated|crisp/.test(cs.imageRendering) });
          return;
        }
        if (e instanceof SVGElement || /^(IFRAME|VIDEO|CANVAS|INPUT|TEXTAREA|BUTTON)$/.test(e.tagName)) return;
        const bl = cs.borderTopStyle !== 'none' ? px(cs.borderTopWidth) : 0;
        const fundo = alfa(cs.backgroundColor) > 0 ? cs.backgroundColor : null, borda = bl > 0 && alfa(cs.borderTopColor) > 0 ? cs.borderTopColor : null;
        if ((fundo || borda) && b.w > 0 && b.h > 0) itens.push({ t: 'caixa', ...b, r, fundo, borda, bl, a, clip });
        if (!e.children.length) {
          let txt = e.textContent.replace(/\s+/g, ' ').trim();
          if (!txt) { const c = getComputedStyle(e, '::before').content; if (c && /^["']/.test(c)) txt = c.slice(1, -1); }
          if (txt) itens.push(textoDe(cs, b, txt, a));
        }
        const filhos = cs.overflow !== 'visible' ? { x: b.x, y: b.y, w: b.w, h: b.h, r } : clip;
        for (const filho of e.children) visitar(filho, a, filhos);
      };
      visitar(cl, 1, null);
      return itens;
    } finally { cl.remove(); }
  }
  function textoDe(cs, b, txt, a) {
    const tam = px(cs.fontSize) || 12, lh = cs.lineHeight === 'normal' ? tam * 1.2 : px(cs.lineHeight) || tam * 1.2;
    const pl = px(cs.paddingLeft) + px(cs.borderLeftWidth), pr = px(cs.paddingRight) + px(cs.borderRightWidth), pt = px(cs.paddingTop) + px(cs.borderTopWidth);
    const fonte = `${cs.fontStyle} ${cs.fontWeight} ${tam}px ${cs.fontFamily}`, w = Math.max(0, b.w - pl - pr);
    const al = /center/.test(cs.textAlign) ? 'centro' : /right|end/.test(cs.textAlign) ? 'direita' : 'esquerda';
    const corta = cs.textOverflow === 'ellipsis' || cs.overflowX !== 'visible';
    return { t: 'texto', x: b.x + pl, y: b.y + pt + lh / 2, w, txt: corta ? cortar(txt, fonte, w) : txt, fonte, tam, fam: cs.fontFamily, peso: cs.fontWeight, estilo: cs.fontStyle, cor: cs.color, alinhar: al, a };
  }
  const texto = (x, y, w, txt, tam, peso, cor, alinhar = 'esquerda', fam = familiaTexto()) => {
    const fonte = `normal ${peso} ${tam}px ${fam}`;
    return { t: 'texto', x, y, w, txt: cortar(txt, fonte, w), fonte, tam, fam, peso: String(peso), estilo: 'normal', cor, alinhar, a: 1 };
  };
  // Card web: cartão-resumo desenhado à mão (o iframe não é exportável).
  function cenaWeb(el) {
    const w = Math.abs(el.w), h = Math.abs(el.h), dados = el.web || {}, url = String(dados.url || '');
    let host = '', legivel = url, titulo = dados.titulo || '';
    try { host = new URL(url).host; } catch {}
    const Nav = window.Navegador;
    if (!titulo && Nav && Nav.titulo) { try { titulo = Nav.titulo({ url }); } catch {} }
    if (Nav && Nav.legivel) { try { legivel = Nav.legivel(url); } catch {} }
    titulo = titulo || host || url || 'Página';
    const t1 = token('--t1', '#f0f0f0'), t2 = token('--t2', '#888'), t3 = token('--t3', '#5c5c5c');
    const carta = { x: 0, y: 0, w, h, r: Math.min(14, w / 2, h / 2) };
    const cy = 35 + (h - 35) / 2;
    return [
      { t: 'caixa', ...carta, fundo: token('--lat-fundo', '#1d1d1d'), borda: null, bl: 0, a: 1, clip: null },
      { t: 'caixa', x: 0, y: 35, w, h: h - 35, r: 0, fundo: token('--poco', '#171717'), borda: null, bl: 0, a: 1, clip: carta },
      { t: 'caixa', x: 0, y: 34, w, h: 1, r: 0, fundo: token('--fio', 'rgba(255,255,255,.06)'), borda: null, bl: 0, a: 1, clip: carta },
      { t: 'caixa', ...carta, fundo: null, borda: token('--fio-2', 'rgba(255,255,255,.085)'), bl: 1, a: 1, clip: null },
      { t: 'path', d: GLOBO, x: 10, y: 10, k: 14 / 24, cor: t2, lw: 1.4, a: 1 },
      texto(32, 17, Math.max(0, w - 44), titulo, 12.5, 500, t1),
      { t: 'caixa', x: w / 2 - 26, y: cy - 49, w: 52, h: 52, r: 14, fundo: token('--bloco', '#262626'), borda: null, bl: 0, a: 1, clip: null },
      { t: 'path', d: GLOBO, x: w / 2 - 13, y: cy - 36, k: 26 / 24, cor: t2, lw: 1.6, a: 1 },
      texto(16, cy + 18, Math.max(0, w - 32), host || titulo, 15, 500, t1, 'centro'),
      texto(16, cy + 39, Math.max(0, w - 32), legivel, 11.5, 400, t3, 'centro'),
    ];
  }
  // Sem nó vivo (vista nunca montada): versão mínima a partir dos dados do elemento.
  function cenaSimples(el) {
    const w = Math.abs(el.w), h = Math.abs(el.h), t1 = token('--t1', '#f0f0f0'), t2 = token('--t2', '#888');
    if (el.tipo === 'time') return [texto(18, 22, Math.max(0, w - 36), (el.time && el.time.nome) || 'Time', 13, 500, t1)];
    const r = (el.sessao && el.sessao.resumo) || (el.subagente && el.subagente.resumo) || {};
    return [
      { t: 'caixa', x: 0, y: 0, w, h, r: Math.min(14, w / 2, h / 2), fundo: token('--lat-fundo', '#1d1d1d'), borda: token('--fio-2', 'rgba(255,255,255,.085)'), bl: 1, a: 1, clip: null },
      texto(12, 24, Math.max(0, w - 24), r.nome || r.tipo || el.tipo, 13.5, 500, t1),
      texto(12, 44, Math.max(0, w - 24), r.projeto || r.descricao || '', 11.5, 400, t2),
    ];
  }
  async function rasterizar(it) {
    const img = it.img;
    try { if (!img.complete || !img.naturalWidth) await Promise.race([img.decode(), dormir(1500)]); } catch {}
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;
    const cv = document.createElement('canvas'); cv.width = nw; cv.height = nh;
    const c = cv.getContext('2d');
    if (it.filtro) c.filter = it.filtro;
    try { c.drawImage(img, 0, 0); it.url = cv.toDataURL('image/png'); it.cv = cv; } catch { it.cv = null; it.url = ''; }
  }
  async function cenas(lista) {
    const saida = [];
    for (const el of lista) {
      if (!temHtml(el)) continue;
      let itens = null;
      try { itens = el.tipo === 'web' ? cenaWeb(el) : cenaDoNo(el); } catch (e) { console.warn('whiteboard-exportar: card', el.tipo, e); }
      saida.push({ el, itens: itens || cenaSimples(el) });
    }
    await Promise.all(saida.flatMap((c) => c.itens.filter((it) => it.t === 'img').map(rasterizar)));
    return saida;
  }
  const cobrir = (it, nw, nh) => { const s = Math.max(it.w / nw, it.h / nh), w = nw * s, h = nh * s; return { x: it.x + (it.w - w) / 2, y: it.y + (it.h - h) / 2, w, h }; };
  const posHtml = (el) => { const w = Math.abs(el.w), h = Math.abs(el.h); return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w, h }; };

  // ── PNG ──
  function caminhoRR(ctx, x, y, w, h, r) { ctx.beginPath(); if (r > 0.3 && ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
  function pintarCena(ctx, itens) {
    const base = ctx.globalAlpha;
    for (const it of itens) {
      ctx.save();
      ctx.globalAlpha = base * it.a;
      if (it.clip) { caminhoRR(ctx, it.clip.x, it.clip.y, it.clip.w, it.clip.h, it.clip.r); ctx.clip(); }
      if (it.t === 'caixa') {
        if (it.fundo) { caminhoRR(ctx, it.x, it.y, it.w, it.h, it.r); ctx.fillStyle = it.fundo; ctx.fill(); }
        if (it.borda) { const d = it.bl / 2; caminhoRR(ctx, it.x + d, it.y + d, it.w - it.bl, it.h - it.bl, Math.max(0, it.r - d)); ctx.lineWidth = it.bl; ctx.strokeStyle = it.borda; ctx.stroke(); }
      } else if (it.t === 'img' && it.cv) {
        ctx.imageSmoothingEnabled = !it.pixel;
        const r = cobrir(it, it.cv.width, it.cv.height);
        ctx.drawImage(it.cv, r.x, r.y, r.w, r.h);
      } else if (it.t === 'texto') {
        ctx.font = it.fonte; ctx.fillStyle = it.cor; ctx.textBaseline = 'middle';
        ctx.textAlign = it.alinhar === 'centro' ? 'center' : it.alinhar === 'direita' ? 'right' : 'left';
        ctx.fillText(it.txt, it.alinhar === 'centro' ? it.x + it.w / 2 : it.alinhar === 'direita' ? it.x + it.w : it.x, it.y);
      } else if (it.t === 'path') {
        ctx.translate(it.x, it.y); ctx.scale(it.k, it.k);
        ctx.lineWidth = it.lw / it.k; ctx.strokeStyle = it.cor; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke(new Path2D(it.d));
      }
      ctx.restore();
    }
  }
  const carregar = (src) => new Promise((ok, erro) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => erro(new Error('imagem')); i.src = src; });
  async function desenharViaSvg(ctx, el) {
    const b = N.caixaMundo(el), m = 40, g = gerador();
    const corpo = svgDe(el, g);
    const svg = `<svg xmlns="${NS}" width="${f(b.w + 2 * m)}" height="${f(b.h + 2 * m)}" viewBox="${f(b.x - m)} ${f(b.y - m)} ${f(b.w + 2 * m)} ${f(b.h + 2 * m)}"><defs>${g.defs.join('')}</defs>${corpo}</svg>`;
    const img = await carregar('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    ctx.drawImage(img, b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
  }
  async function renderizar(p) {
    const cv = document.createElement('canvas');
    cv.width = p.w; cv.height = p.h;
    const ctx = cv.getContext('2d');
    if (p.fundo === 'tema') { ctx.fillStyle = corFundo(); ctx.fillRect(0, 0, p.w, p.h); }
    const sx = p.w / p.vw, sy = p.h / p.vh, T = tipos();
    const html = await cenas(p.lista);
    ctx.setTransform(sx, 0, 0, sy, -p.vx * sx, -p.vy * sy);
    for (const el of p.lista) {
      if (soHtml(el)) continue;
      const t = T.get(el.tipo);
      ctx.save();
      try {
        if (!t || !t.desenhar) await desenharViaSvg(ctx, el); // tipo sem desenho conhecido: o SVG próprio (já com giro e opacidade)
        else {
          ctx.globalAlpha = num(el.opacidade, 1);
          if (el.angulo) { const cx = el.x + el.w / 2, cy = el.y + el.h / 2; ctx.translate(cx, cy); ctx.rotate(el.angulo); ctx.translate(-cx, -cy); }
          t.desenhar(ctx, el, { zoom: 1, nucleo: N, selecionado: false });
        }
      } catch (e) { console.warn('whiteboard-exportar: desenhar', el.tipo, e); } finally { ctx.restore(); }
    }
    try { pintarLigacoes(ctx, p.lista); } catch (e) { console.warn('whiteboard-exportar: ligações', e); }
    for (const { el, itens } of html) {
      const b = posHtml(el);
      ctx.save();
      ctx.globalAlpha = num(el.opacidade, 1);
      ctx.translate(b.x, b.y);
      if (el.angulo) { ctx.translate(b.w / 2, b.h / 2); ctx.rotate(el.angulo); ctx.translate(-b.w / 2, -b.h / 2); }
      try { pintarCena(ctx, itens); } catch (e) { console.warn('whiteboard-exportar: card', el.tipo, e); }
      ctx.restore();
    }
    return cv;
  }
  async function png(op = {}) {
    const p = plano(op);
    if (p.vazio) throw new Error('Quadro vazio: nada para exportar');
    const cv = await renderizar(p);
    return new Promise((ok, erro) => cv.toBlob((b) => (b ? ok(b) : erro(new Error('Não foi possível gerar o PNG'))), 'image/png'));
  }

  // ── SVG ──
  function gerador() { let n = 0; const defs = []; return { defs, id: (p) => `wbx-${p}-${++n}`, add: (s) => defs.push(s) }; }
  function svgTraco(el, semTraco) {
    const t = el.traco || {}, l = num(t.largura);
    if (l <= 0) return ' stroke="none"';
    const dash = semTraco ? '' : t.estilo === 'tracejado' ? `${f(l * 4)} ${f(l * 3)}` : t.estilo === 'pontilhado' ? `0.001 ${f(l * 2.5)}` : '';
    return pintura('stroke', el.cor) + ` stroke-width="${f(l)}" stroke-linejoin="round" stroke-linecap="round"` + (dash ? ` stroke-dasharray="${dash}"` : '');
  }
  const preench = (c) => (c ? pintura('fill', c) : ' fill="none"');
  const pts = (el) => (el.pontos || []).map(([dx, dy]) => [el.x + dx, el.y + dy]);
  function svgTextoLinhas(linhas, x, yTopo, tam, lh, fonteFam, cor, ancora) {
    const fonte = `400 ${tam}px ${fonteFam}`, { asc } = metricas(fonte, tam);
    const spans = linhas.map((l, i) => `<tspan x="${f(x)}" y="${f(yTopo + i * lh + (lh - tam) / 2 + asc)}">${esc(l)}</tspan>`).join('');
    return `<text xml:space="preserve" font-family="${esc(comReserva(fonteFam))}" font-size="${f(tam)}" font-weight="400"${pintura('fill', cor)} text-anchor="${ancora}" style="white-space:pre">${spans}</text>`;
  }
  function svgForma(el, g) {
    const b = N.util.caixaNormal(el);
    switch (el.tipo) {
      case 'retangulo': {
        const r = Math.min(8, b.w / 4, b.h / 4);
        return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}"${r > 0.5 ? ` rx="${f(r)}" ry="${f(r)}"` : ''}${preench(el.preenchimento)}${svgTraco(el)}/>`;
      }
      case 'elipse': return `<ellipse cx="${f(b.x + b.w / 2)}" cy="${f(b.y + b.h / 2)}" rx="${f(b.w / 2)}" ry="${f(b.h / 2)}"${preench(el.preenchimento)}${svgTraco(el)}/>`;
      case 'losango': {
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        return `<polygon points="${f(cx)},${f(b.y)} ${f(b.x + b.w)},${f(cy)} ${f(cx)},${f(b.y + b.h)} ${f(b.x)},${f(cy)}"${preench(el.preenchimento)}${svgTraco(el)}/>`;
      }
      case 'linha': {
        const P = pts(el);
        return P.length < 2 ? '' : `<path d="M${P.map(([x, y]) => f(x) + ' ' + f(y)).join(' L')}" fill="none"${svgTraco(el)}/>`;
      }
      case 'livre': {
        const P = pts(el), n = P.length;
        if (!n) return '';
        if (n === 1) return `<circle cx="${f(P[0][0])}" cy="${f(P[0][1])}" r="${f(Math.max(0.5, num(el.traco && el.traco.largura, 2) / 2))}"${pintura('fill', el.cor)}/>`;
        let d = `M${f(P[0][0])} ${f(P[0][1])}`;
        if (n === 2) d += ` L${f(P[1][0])} ${f(P[1][1])}`;
        else {
          for (let i = 1; i < n - 1; i++) d += ` Q${f(P[i][0])} ${f(P[i][1])} ${f((P[i][0] + P[i + 1][0]) / 2)} ${f((P[i][1] + P[i + 1][1]) / 2)}`;
          d += ` L${f(P[n - 1][0])} ${f(P[n - 1][1])}`;
        }
        return `<path d="${d}" fill="none"${svgTraco(el)}/>`;
      }
      case 'seta': {
        const P = pts(el), l = num(el.traco && el.traco.largura, 2);
        if (P.length < 2 || l <= 0) return '';
        const cab = (de, ate) => {
          const dx = ate[0] - de[0], dy = ate[1] - de[1], d = Math.hypot(dx, dy);
          if (d < 0.5) return '';
          const c = Math.min(7 + l * 2.4, d * 0.7), an = Math.atan2(dy, dx), ab = 0.47;
          return ` M${f(ate[0] - c * Math.cos(an - ab))} ${f(ate[1] - c * Math.sin(an - ab))} L${f(ate[0])} ${f(ate[1])} L${f(ate[0] - c * Math.cos(an + ab))} ${f(ate[1] - c * Math.sin(an + ab))}`;
        };
        const pon = el.pontas || {}, n = P.length;
        const cabecas = (pon.fim !== 'nenhuma' ? cab(P[n - 2], P[n - 1]) : '') + (pon.inicio === 'seta' ? cab(P[1], P[0]) : '');
        return `<path d="M${P.map(([x, y]) => f(x) + ' ' + f(y)).join(' L')}" fill="none"${svgTraco(el)}/>` + (cabecas ? `<path d="${cabecas.trim()}" fill="none"${svgTraco(el, true)}/>` : '');
      }
      case 'texto': {
        const t = el.texto || {}, tam = t.tamanho || 20, lh = tam * 1.25, al = t.alinhar || 'esquerda';
        const x = al === 'centro' ? b.x + b.w / 2 : al === 'direita' ? b.x + b.w : b.x;
        const fundo = el.preenchimento ? `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}"${pintura('fill', el.preenchimento)}/>` : '';
        return fundo + svgTextoLinhas(String(t.valor || '').split('\n'), x, b.y, tam, lh, familiaTexto(), el.cor, al === 'centro' ? 'middle' : al === 'direita' ? 'end' : 'start');
      }
      case 'nota': {
        const t = el.texto || {}, tam = t.tamanho || 16, lh = tam * 1.25;
        const sombra = g.id('sombra'), corte = g.id('nota');
        g.add(`<filter id="${sombra}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="7" flood-color="#000" flood-opacity="0.5"/></filter>`);
        g.add(`<clipPath id="${corte}"><rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}"/></clipPath>`);
        const Tx = window.WhiteboardTexto;
        let linhas = String(t.valor || '').split('\n');
        if (Tx && typeof Tx.quebrar === 'function') { try { linhas = Tx.quebrar(el); } catch {} }
        return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="4" ry="4"${pintura('fill', el.preenchimento || '#463a1e')} filter="url(#${sombra})"/>`
          + `<g clip-path="url(#${corte})">${svgTextoLinhas(linhas, b.x + 12, b.y + 12, tam, lh, familiaTexto(), el.cor, 'start')}</g>`;
      }
      case 'time': return svgTime(el);
      default: {
        const t3 = (N.cores && N.cores().t3) || '#5c5c5c';
        return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="none"${pintura('stroke', t3)} stroke-width="1" stroke-dasharray="6 4"/>`;
      }
    }
  }
  // Quadro do time: mesmo desenho de whiteboard-times.js (fundo, borda, divisória do cabeçalho e linhas suaves da hierarquia).
  function svgTime(q) {
    const b = N.caixaMundo(q), R = 16, CAB = 44;
    let s = `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="${R}" ry="${R}" fill="#ffffff" fill-opacity="0.026" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1.25"/>`
      + `<path d="M${f(b.x + R)} ${f(b.y + CAB)} H${f(b.x + b.w - R)}" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1"/>`;
    let linhas = [];
    try { linhas = (W.times && q.time && W.times.linhas(q.time.raiz)) || []; } catch {}
    for (const l of linhas) {
      const de = N.elemento(l.de), para = N.elemento(l.para);
      if (!de || !para) continue;
      const lb = N.caixaMundo(de), mb = N.caixaMundo(para), acima = mb.y + mb.h < lb.y;
      const x0 = lb.x + lb.w / 2, y0 = acima ? lb.y : lb.y + lb.h, x1 = mb.x + mb.w / 2, y1 = acima ? mb.y + mb.h : mb.y;
      const dy = Math.max(30, Math.abs(y1 - y0) * 0.5) * (acima ? -1 : 1), sub = para.tipo === 'subagente';
      const no = noDe(para.id), fim = sub && /^(concluido|erro)$/.test(String((no && no.dataset.status) || ''));
      const op = (fim ? 0.5 : 1) * (sub ? 0.13 : 0.2);
      s += `<path d="M${f(x0)} ${f(y0)} C${f(x0)} ${f(y0 + dy)} ${f(x1)} ${f(y1 - dy)} ${f(x1)} ${f(y1)}" fill="none" stroke="#ffffff" stroke-opacity="${f(op)}" stroke-width="1.5" stroke-linecap="round"${sub ? ' stroke-dasharray="5 4"' : ''}/>`
        + `<circle cx="${f(x1)}" cy="${f(y1)}" r="2.5" fill="#ffffff" fill-opacity="${f(op)}"/>`;
    }
    return s;
  }
  // Ligações card de site ↔ card de agente (whiteboard-web.js): curva tracejada na cor de acento com o plug no meio.
  const PLUG_D = ['M6 2v3', 'M10 2v3', 'M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0z', 'M8 11v3'];
  const ligacoes = (lista) => { try { return (W.ligacao && W.ligacao.linhas(lista.map((e) => e.id))) || []; } catch { return []; } };
  const corAcento = () => (N.cores && N.cores().acento) || '#6366f1';
  function svgLigacoes(lista) {
    const ls = ligacoes(lista);
    if (!ls.length) return '';
    const ac = corAcento(), fundo = corFundo();
    return ls.map((l) => `<g data-tipo="ligacao"><path d="${l.d}" fill="none"${pintura('stroke', ac)} stroke-width="2" stroke-dasharray="7 6" stroke-linecap="round" stroke-opacity="0.75"/>`
      + `<circle cx="${f(l.mx)}" cy="${f(l.my)}" r="11"${pintura('fill', fundo)}${pintura('stroke', ac)} stroke-width="1.5"/>`
      + `<g transform="translate(${f(l.mx - 6.5)} ${f(l.my - 6.5)}) scale(0.8125)" fill="none"${pintura('stroke', ac)} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${PLUG_D.map((d) => `<path d="${d}"/>`).join('')}</g></g>`).join(String.fromCharCode(10));
  }
  function pintarLigacoes(ctx, lista) {
    const ac = corAcento(), fundo = corFundo();
    for (const l of ligacoes(lista)) {
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.75; ctx.strokeStyle = ac; ctx.lineWidth = 2; ctx.setLineDash([7, 6]);
      ctx.stroke(new Path2D(l.d));
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(l.mx, l.my, 11, 0, Math.PI * 2); ctx.fillStyle = fundo; ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.translate(l.mx - 6.5, l.my - 6.5); ctx.scale(0.8125, 0.8125); ctx.lineWidth = 1.4;
      for (const d of PLUG_D) ctx.stroke(new Path2D(d));
      ctx.restore();
    }
  }
  function svgDe(el, g) {
    const corpo = svgForma(el, g);
    if (!corpo) return '';
    const op = num(el.opacidade, 1), rot = el.angulo ? ` transform="rotate(${f(el.angulo * 180 / Math.PI)} ${f(el.x + el.w / 2)} ${f(el.y + el.h / 2)})"` : '';
    return `<g data-tipo="${esc(el.tipo)}"${op < 1 ? ` opacity="${f(op)}"` : ''}${rot}>${corpo}</g>`;
  }
  function svgCena(itens, g) {
    let s = '';
    for (const it of itens) {
      const op = it.a < 1 ? ` opacity="${f(it.a)}"` : '';
      let clip = '';
      if (it.clip) {
        const id = g.id('corte'), c = it.clip;
        g.add(`<clipPath id="${id}"><rect x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${f(c.h)}"${c.r > 0.3 ? ` rx="${f(c.r)}" ry="${f(c.r)}"` : ''}/></clipPath>`);
        clip = ` clip-path="url(#${id})"`;
      }
      const rr = (r) => (r > 0.3 ? ` rx="${f(r)}" ry="${f(r)}"` : '');
      if (it.t === 'caixa') {
        if (it.fundo) s += `<rect x="${f(it.x)}" y="${f(it.y)}" width="${f(it.w)}" height="${f(it.h)}"${rr(it.r)}${pintura('fill', it.fundo)}${op}${clip}/>`;
        if (it.borda) { const d = it.bl / 2; s += `<rect x="${f(it.x + d)}" y="${f(it.y + d)}" width="${f(it.w - it.bl)}" height="${f(it.h - it.bl)}"${rr(Math.max(0, it.r - d))} fill="none"${pintura('stroke', it.borda)} stroke-width="${f(it.bl)}"${op}${clip}/>`; }
      } else if (it.t === 'img' && it.url) {
        const r = cobrir(it, it.cv.width, it.cv.height);
        s += `<image x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" href="${it.url}" preserveAspectRatio="none"${it.pixel ? ' image-rendering="optimizeSpeed" style="image-rendering:pixelated"' : ''}${op}${clip}/>`;
      } else if (it.t === 'texto') {
        const { asc, desc } = metricas(it.fonte, it.tam);
        const x = it.alinhar === 'centro' ? it.x + it.w / 2 : it.alinhar === 'direita' ? it.x + it.w : it.x;
        const anc = it.alinhar === 'centro' ? 'middle' : it.alinhar === 'direita' ? 'end' : 'start';
        s += `<text x="${f(x)}" y="${f(it.y + (asc - desc) / 2)}" font-family="${esc(comReserva(it.fam))}" font-size="${f(it.tam)}" font-weight="${esc(it.peso)}"${it.estilo !== 'normal' ? ` font-style="${esc(it.estilo)}"` : ''}${pintura('fill', it.cor)} text-anchor="${anc}" xml:space="preserve"${op}${clip}>${esc(it.txt)}</text>`;
      } else if (it.t === 'path') {
        s += `<path transform="translate(${f(it.x)} ${f(it.y)}) scale(${f(it.k * 1000) / 1000})" d="${it.d}" fill="none"${pintura('stroke', it.cor)} stroke-width="${f(it.lw / it.k)}" stroke-linecap="round" stroke-linejoin="round"${op}${clip}/>`;
      }
    }
    return s;
  }
  async function svg(op = {}) {
    const p = plano(op);
    if (p.vazio) throw new Error('Quadro vazio: nada para exportar');
    const g = gerador(), partes = [];
    if (p.fundo === 'tema') partes.push(`<rect x="${f(p.vx)}" y="${f(p.vy)}" width="${f(p.vw)}" height="${f(p.vh)}"${pintura('fill', corFundo())}/>`);
    for (const el of p.lista) if (!soHtml(el)) { try { partes.push(svgDe(el, g)); } catch (e) { console.warn('whiteboard-exportar: svg', el.tipo, e); } }
    const sl = svgLigacoes(p.lista);
    if (sl) partes.push(sl);
    for (const { el, itens } of await cenas(p.lista)) {
      const b = posHtml(el), o = num(el.opacidade, 1);
      const tr = `translate(${f(b.x)} ${f(b.y)})` + (el.angulo ? ` rotate(${f(el.angulo * 180 / Math.PI)} ${f(b.w / 2)} ${f(b.h / 2)})` : '');
      partes.push(`<g data-tipo="${esc(el.tipo)}-card" transform="${tr}"${o < 1 ? ` opacity="${f(o)}"` : ''}>${svgCena(itens, g)}</g>`);
    }
    const q = W.quadro && W.quadro();
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="${NS}" version="1.1" width="${f(p.vw)}" height="${f(p.vh)}" viewBox="${f(p.vx)} ${f(p.vy)} ${f(p.vw)} ${f(p.vh)}">\n`
      + `<title>${esc((q && q.nome) || 'Quadro')}</title>\n<defs>${g.defs.join('')}</defs>\n${partes.join('\n')}\n</svg>\n`;
  }
  function nomeArquivo(ext) {
    const q = W.quadro && W.quadro();
    let n = String((q && q.nome) || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = '';
    return (n.slice(0, 80).trim() || 'quadro') + '.' + ext;
  }
  function baixar(blob, nome) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = nome; a.rel = 'noopener'; a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const podeCopiar = () => typeof window.ClipboardItem === 'function' && !!(navigator.clipboard && typeof navigator.clipboard.write === 'function');

  // ── interface ──
  const h = (tag, attrs, ...filhos) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v); }
    for (const c of filhos) if (c != null) e.append(c);
    return e;
  };
  function icone(d, tam = 15) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', tam); s.setAttribute('height', tam); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.5'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p);
    return s;
  }
  const IC_EXPORTAR = 'M8 2.5v7.2M5 6.9l3 3 3-3M3 10.5v1.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5v-1.5';
  const IC_FECHAR = 'M4.5 4.5l7 7M11.5 4.5l-7 7';
  const ESC = { formato: 'png', fundo: 'tema', escala: 1 }; // últimas escolhas (memória da sessão)
  const D = { veu: null, caixa: null, op: null, gen: 0, t: 0, ocupado: false, origem: null };
  let botao = null;

  function injetarBotao() {
    const topo = document.querySelector('.wb-topo');
    if (!topo) return false;
    if (botao && botao.isConnected) return true;
    botao = h('button', { class: 'wb-ib wb-ex-btn', type: 'button', title: 'Exportar imagem (Ctrl+Shift+E)', 'aria-label': 'Exportar imagem', 'aria-haspopup': 'dialog' }, icone(IC_EXPORTAR));
    botao.addEventListener('click', () => abrir());
    topo.append(botao);
    return true;
  }
  if (!injetarBotao()) {
    const mo = new MutationObserver(() => { if (injetarBotao()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  try { N.on('quadro', () => { injetarBotao(); if (D.veu) fechar(); }); } catch {}

  function segmento(nome, rotulo, opcoes) {
    const g = h('div', { class: 'wb-ex-seg', role: 'radiogroup', 'aria-label': rotulo, 'data-campo': nome });
    for (const [v, txt] of opcoes) {
      const b = h('button', { class: 'wb-ex-op', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-v': v, tabindex: '-1' }, txt);
      b.addEventListener('click', () => { if (!b.disabled) escolher(nome, v); });
      g.append(b);
    }
    return h('div', { class: 'wb-ex-linha', 'data-linha': nome }, h('span', { class: 'wb-ex-rot' }, rotulo), g);
  }
  function abrir(op = {}) {
    if (D.veu) { atualizar(); return true; }
    const vi = vista();
    if (!vi) return false;
    const temSel = N.selecao().length > 0;
    D.op = {
      formato: op.formato === 'svg' || op.formato === 'png' ? op.formato : ESC.formato,
      selecao: op.selecao == null ? temSel : !!op.selecao && temSel,
      fundo: op.fundo === 'transparente' || op.fundo === 'tema' ? op.fundo : ESC.fundo,
      escala: [1, 2, 3].includes(+op.escala) ? +op.escala : ESC.escala,
      margem: num(op.margem, MARGEM),
    };
    D.origem = document.activeElement;
    const fechar_ = h('button', { class: 'wb-ib wb-ex-fechar', type: 'button', title: 'Fechar (Esc)', 'aria-label': 'Fechar' }, icone(IC_FECHAR, 14));
    fechar_.addEventListener('click', () => fechar());
    const previa = h('div', { class: 'wb-ex-previa', 'data-fundo': D.op.fundo }, h('canvas', { class: 'wb-ex-mini', 'aria-hidden': 'true' }), h('p', { class: 'wb-ex-vazio', hidden: true }, 'Nada para exportar'));
    const copiar = h('button', { class: 'wb-btn wb-ex-copiar', type: 'button' }, 'Copiar');
    const baixarB = h('button', { class: 'wb-btn wb-ex-baixar', type: 'button' }, 'Baixar');
    copiar.addEventListener('click', aoCopiar);
    baixarB.addEventListener('click', aoBaixar);
    D.caixa = h('div', { class: 'wb-dialogo wb-ex', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wb-ex-tit' },
      h('div', { class: 'wb-ex-cab' }, h('h2', { id: 'wb-ex-tit' }, 'Exportar quadro'), fechar_),
      previa,
      h('div', { class: 'wb-ex-opcoes' },
        segmento('formato', 'Formato', [['png', 'PNG'], ['svg', 'SVG']]),
        segmento('selecao', 'Área', [['0', 'Tudo'], ['1', 'Seleção']]),
        segmento('fundo', 'Fundo', [['tema', 'Tema'], ['transparente', 'Transparente']]),
        segmento('escala', 'Escala', [['1', '1x'], ['2', '2x'], ['3', '3x']])),
      h('p', { class: 'wb-ex-info', 'aria-live': 'polite' }),
      h('p', { class: 'wb-ex-aviso', hidden: true }),
      h('div', { class: 'wb-dialogo-acoes' }, copiar, baixarB));
    D.veu = h('div', { class: 'wb-veu wb-ex-veu' }, D.caixa);
    D.veu.addEventListener('pointerdown', (e) => { if (e.target === D.veu) fechar(); });
    vi.append(D.veu);
    atualizar();
    const marcado = D.caixa.querySelector('.wb-ex-op[aria-checked="true"]');
    (marcado || baixarB).focus({ preventScroll: true });
    return true;
  }
  function fechar() {
    const veu = D.veu;
    if (!veu) return;
    D.veu = null; D.caixa = null; D.gen++;
    clearTimeout(D.t);
    veu.classList.add('saindo');
    setTimeout(() => veu.remove(), reduzido() ? 0 : 160);
    const volta = D.origem && D.origem.isConnected ? D.origem : document.querySelector('.wb-palco');
    D.origem = null;
    try { volta && volta.focus({ preventScroll: true }); } catch {}
  }
  function escolher(campo, v) {
    if (!D.op) return;
    if (campo === 'formato') D.op.formato = ESC.formato = v === 'svg' ? 'svg' : 'png';
    else if (campo === 'selecao') D.op.selecao = v === '1';
    else if (campo === 'fundo') D.op.fundo = ESC.fundo = v === 'transparente' ? 'transparente' : 'tema';
    else if (campo === 'escala') D.op.escala = ESC.escala = [1, 2, 3].includes(+v) ? +v : 1;
    atualizar(campo !== 'formato' && campo !== 'escala');
  }
  function valorDe(campo) { const o = D.op; return campo === 'selecao' ? (o.selecao ? '1' : '0') : String(o[campo]); }
  function atualizar(refazerPrevia = true) {
    const c = D.caixa;
    if (!c) return;
    const temSel = N.selecao().length > 0;
    if (!temSel) D.op.selecao = false;
    for (const g of c.querySelectorAll('.wb-ex-seg')) {
      const campo = g.dataset.campo, v = valorDe(campo);
      for (const b of g.querySelectorAll('.wb-ex-op')) {
        const on = b.dataset.v === v;
        b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
        b.disabled = campo === 'selecao' && b.dataset.v === '1' && !temSel;
        if (b.disabled) b.title = 'Nada selecionado'; else b.removeAttribute('title');
      }
    }
    const ehPng = D.op.formato === 'png';
    c.querySelector('[data-linha="escala"]').hidden = !ehPng;
    c.querySelector('.wb-ex-previa').dataset.fundo = D.op.fundo;
    const p = plano(opExport());
    const copiar = c.querySelector('.wb-ex-copiar'), baixarB = c.querySelector('.wb-ex-baixar');
    copiar.hidden = !ehPng || !podeCopiar();
    copiar.disabled = baixarB.disabled = p.vazio || D.ocupado;
    const info = c.querySelector('.wb-ex-info'), aviso = c.querySelector('.wb-ex-aviso');
    info.textContent = p.vazio ? '' : ehPng ? `${p.w} × ${p.h} px` : `${Math.round(p.vw)} × ${Math.round(p.vh)} · vetorial`;
    const avisos = [];
    if (p.vazio) avisos.push(D.op.selecao ? 'A seleção está vazia.' : 'O quadro está vazio: não há o que exportar.');
    if (!p.vazio && ehPng && p.reduzida) avisos.push(`Imagem muito grande: escala reduzida para ${(Math.floor(p.escala * 100) / 100).toLocaleString('pt-BR')}x (limite de 16 MP).`);
    if (!p.vazio && p.lista.some((el) => el.tipo === 'web')) avisos.push('Sites embutidos saem como cartão: o conteúdo da página não é exportável.');
    aviso.textContent = avisos.join(' ');
    aviso.hidden = !avisos.length;
    c.dataset.vazio = p.vazio ? '1' : '0';
    if (refazerPrevia) { clearTimeout(D.t); D.t = setTimeout(() => previa(p), 40); }
  }
  const opExport = () => ({ selecao: D.op.selecao, fundo: D.op.fundo, escala: D.op.escala, margem: D.op.margem });
  async function previa(p) {
    const c = D.caixa;
    if (!c) return;
    const gen = ++D.gen, alvo = c.querySelector('.wb-ex-mini'), vazio = c.querySelector('.wb-ex-vazio');
    vazio.hidden = !p.vazio; alvo.hidden = p.vazio;
    if (p.vazio) return;
    const LW = 348, LH = 180, dpr = window.devicePixelRatio || 1;
    const k = Math.min(LW / p.vw, LH / p.vh, 2);
    try {
      const cv = await renderizar(plano({ ...opExport(), escala: k * dpr }));
      if (gen !== D.gen || !D.caixa) return;
      alvo.width = cv.width; alvo.height = cv.height;
      alvo.style.width = cv.width / dpr + 'px'; alvo.style.height = cv.height / dpr + 'px';
      alvo.getContext('2d').drawImage(cv, 0, 0);
    } catch (e) { console.warn('whiteboard-exportar: prévia', e); }
  }
  async function ocupar(fn) {
    if (D.ocupado || !D.caixa) return;
    D.ocupado = true; D.caixa.setAttribute('aria-busy', 'true'); atualizar(false);
    try { await fn(); } finally { D.ocupado = false; if (D.caixa) { D.caixa.removeAttribute('aria-busy'); atualizar(false); } }
  }
  function avisar(msg) { const a = D.caixa && D.caixa.querySelector('.wb-ex-aviso'); if (a) { a.textContent = msg; a.hidden = false; } }
  function aoBaixar() {
    return ocupar(async () => {
      try {
        const op = opExport();
        if (D.op.formato === 'svg') baixar(new Blob([await svg(op)], { type: 'image/svg+xml' }), nomeArquivo('svg'));
        else baixar(await png(op), nomeArquivo('png'));
        setTimeout(fechar, 0);
      } catch (e) { avisar('Não foi possível exportar: ' + e.message); }
    });
  }
  function aoCopiar() {
    const b = D.caixa && D.caixa.querySelector('.wb-ex-copiar');
    return ocupar(async () => {
      try {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png(opExport()) })]);
        if (b) { b.textContent = 'Copiado'; setTimeout(() => { b.textContent = 'Copiar'; }, 1400); }
      } catch (e) { avisar('Não foi possível copiar a imagem' + (e && e.message ? ': ' + e.message : '.')); }
    });
  }
  const editavel = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  const atalho = (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE';
  function prenderFoco(e) {
    const fs = [...D.caixa.querySelectorAll('button')].filter((b) => !b.disabled && b.tabIndex >= 0 && b.getClientRects().length);
    if (!fs.length) return;
    const i = fs.indexOf(document.activeElement);
    const prox = i < 0 ? fs[0] : fs[(i + (e.shiftKey ? -1 : 1) + fs.length) % fs.length];
    e.preventDefault(); prox.focus({ preventScroll: true });
  }
  function setas(e) {
    const b = document.activeElement;
    if (!b || !b.classList || !b.classList.contains('wb-ex-op')) return false;
    const passo = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!passo) return false;
    const ops = [...b.parentNode.querySelectorAll('.wb-ex-op')].filter((x) => !x.disabled);
    const n = ops[(ops.indexOf(b) + passo + ops.length) % ops.length];
    e.preventDefault();
    if (n) { escolher(b.parentNode.dataset.campo, n.dataset.v); n.focus({ preventScroll: true }); }
    return true;
  }
  // Captura na window: roda antes do núcleo (que ouve na captura do document).
  window.addEventListener('keydown', (e) => {
    if (D.veu) {
      if (!D.veu.isConnected) { D.veu = null; D.caixa = null; return; }
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); fechar(); }
      else if (e.key === 'Tab') prenderFoco(e);
      else if (atalho(e)) e.preventDefault();
      else setas(e);
      return;
    }
    if (!atalho(e) || e.repeat) return;
    const vi = vista(), t = e.target;
    let ativo = false;
    try { ativo = !!(W.estado().ativo && vi && vi.getClientRects().length); } catch {}
    if (!ativo || editavel(t)) return;
    if (t !== document.body && t !== document.documentElement && !vi.contains(t)) return;
    if (vi.querySelector('.wb-veu, .wb-painel')) return;
    e.preventDefault(); e.stopPropagation();
    abrir();
  }, true);
  // Seleção mudou com o diálogo aberto (raro): atualiza a área.
  try { N.on('selecao', () => { if (D.veu) atualizar(); }); } catch {}

  W.estender('exportar', Object.freeze({
    png, svg, abrir, fechar, aberto: () => !!D.veu, nomeArquivo,
    medir: (op = {}) => { const p = plano(op); return { vazio: p.vazio, total: p.total, w: p.w, h: p.h, escala: p.escala, reduzida: p.reduzida, vx: p.vx, vy: p.vy, vw: p.vw, vh: p.vh, soSelecao: p.soSelecao }; },
  }));
})();
