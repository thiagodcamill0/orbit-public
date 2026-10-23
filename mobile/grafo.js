// Orbit no celular — tela "grafo" (#mais/grafo, onda 5): grafo do brain do projeto, só leitura. API no contrato, "App do celular".
// Dados: GET /remoto/projetos → [{ pasta, nome }]; GET /remoto/grafo?projeto=<pasta> → { pasta, nos, links, truncado } (404 sem_brain);
// GET /remoto/grafo/nota?projeto=&id= → { id, texto }. Desenho num canvas próprio, sem worker: física (a do grafo do PC, grade espacial no
// lugar da árvore de Barnes-Hut) que se acomoda e PARA; destaque dos vizinhos como no PC (os outros a 20%); cores só dos tokens de base.css.
(function () {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h, api, ouvir, icone, toast } = OM;

const CHAVE_PROJETO = 'orbit.m.grafoProjeto';
const MAX_LINKS_BRUTOS = 50000;    // links lidos do servidor
const MAX_PARES = 6000;            // pares que entram no desenho e na física
const MAX_CACHE_CHARS = 2e6;       // teto do cache de notas (soma de caracteres)
const MAX_NOS = 700;              // acima disso fica só com os mais ligados (a física precisa caber num celular)
const APAGADO = 0.2;               // alpha dos não vizinhos com destaque (grafo do PC)
const ROTULO_DESCE = 15;           // px: o rótulo do nó destacado desce
const ESC_MIN = 1 / 64, ESC_MAX = 8, ESC_ENCAIXE_MAX = 1.2;
const SUAVE = 0.85;                // novo = atual·0,85 + alvo·0,15 por quadro
const LIMIAR_TOQUE = 6;            // px: abaixo disso o dedo "tocou", acima "arrastou"
const MAX_TOQUE_MS = 600;
const MAX_ROTULOS_BUSCA = 20;

// Física (valores do grafo do PC: assets/grafo-fisica.js)
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
const AMORT = 0.6;
const CENTRO = (Math.pow(0.01, 1 - 0.518713) - 0.01) / 0.99;
const REPULSAO = 1000;
const DISTANCIA = 250;
const DIST2_MIN = 30;
const RAIO_COLISAO = 60;
const FORCA_COLISAO = 0.5;
const AREA_POR_NO = 3600;
const CELULA = 400;                // repulsão só até aqui (a 400 a força já é desprezível)
const PASSOS_POR_QUADRO = 2;       // ~150 quadros (2,5 s) até dormir

const limitar = (v, a, b) => (v < a ? a : v > b ? b : v);
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mensagem = (e) => (e && e.rede ? 'Sem conexão com o Orbit. Confira se o PC está ligado.' : (e && e.message) || 'Algo deu errado.');
const lerSalvo = () => { try { return localStorage.getItem(CHAVE_PROJETO) || ''; } catch { return ''; } };
const gravarSalvo = (v) => { try { localStorage.setItem(CHAVE_PROJETO, v); } catch {} };
const semFrontmatter = (t) => String(t == null ? '' : t).replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
const rgbaTxt = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (a == null ? c[3] : a).toFixed(3) + ')';

// ───────────── cores: sempre dos tokens de assets/comum/base.css ─────────────
let sonda = null;
function corRGBA(txt, padrao) {
  if (!txt) return padrao.slice();
  try {
    if (!sonda) { const c = document.createElement('canvas'); c.width = c.height = 1; sonda = c.getContext('2d', { willReadFrequently: true }); }
    sonda.clearRect(0, 0, 1, 1);
    sonda.fillStyle = '#000'; sonda.fillStyle = txt;
    const a = sonda.fillStyle;
    sonda.fillStyle = '#fff'; sonda.fillStyle = txt;
    if (sonda.fillStyle !== a) return padrao.slice();
    sonda.fillRect(0, 0, 1, 1);
    const d = sonda.getImageData(0, 0, 1, 1).data;
    return d[3] ? [d[0], d[1], d[2], d[3] / 255] : padrao.slice();
  } catch { return padrao.slice(); }
}
const token = (nome, padrao) => corRGBA(OM.cssVar(nome, ''), padrao);
const misturar = (a, b, k) => [0, 1, 2, 3].map((i) => a[i] + (b[i] - a[i]) * k);
const comAlpha = (c, a) => [c[0], c[1], c[2], c[3] * a];
// Papéis do grafo do PC (--grafo-*) → tokens do celular.
function lerCores() {
  const t1 = token('--t1', [240, 240, 240, 1]), t2 = token('--t2', [136, 136, 136, 1]), t3 = token('--t3', [92, 92, 92, 1]);
  const int = token('--int', [110, 86, 207, 1]), intT = token('--int-t', [186, 167, 255, 1]);
  return {
    no: misturar(t1, t2, 0.5), linha: comAlpha(t3, 0.75), texto: t1,
    foco: intT, destaque: int, linkDestaque: comAlpha(intT, 0.65),
    inexistente: comAlpha(t3, 0.5), anexo: token('--agu-t', [255, 202, 22, 1]), tag: token('--trab-t', [112, 184, 255, 1]),
    // pastas: 1 cinza claro · 2 verde · 3 laranja · 4 amarelo · 5 rosa · 6 violeta (como --grafo-g1..g6 do PC)
    grupos: [null, misturar(t1, t2, 0.5), token('--ok-t', [61, 214, 140, 1]), token('--uso-laranja', [255, 154, 31, 1]),
      token('--uso-amarelo', [255, 198, 26, 1]), token('--erro-t', [255, 149, 146, 1]), token('--uso-roxo', [167, 139, 250, 1])],
    bastidores: token('--enc', [105, 110, 119, 1]), outras: t3,
  };
}

// ───────────── pastas → cor (assets/grafo-dados.js, gruposPorPasta) ─────────────
const CONHECIDOS = [
  { chave: 'decisoes', slot: 1, re: /^decis/ }, { chave: 'tarefas', slot: 2, re: /^tarefa/ }, { chave: 'referencias', slot: 3, re: /^referenc/ },
  { chave: 'padroes', slot: 4, re: /^padr(ao|oes)$/ }, { chave: 'diario', slot: 5, re: /^diari/ }, { chave: 'gestor', slot: 6, re: /^(projeto|gestor)$/ },
];
function pastaDe(no) {
  if (no.tipo && no.tipo !== 'nota') return null;
  const partes = String(no.id).split('/');
  if (partes.length < 2) return { chave: 'gestor', slot: 6 };
  const pasta = partes[0];
  if (pasta.charAt(0) === '_') return { chave: 'bastidores', slot: -1 };
  const rotulo = pasta.replace(/^[\d\s._-]+/, '').trim() || pasta;
  const palavras = norm(rotulo).split(/[^a-z0-9]+/).filter(Boolean);
  for (const c of CONHECIDOS) if (palavras.some((p) => c.re.test(p))) return { chave: c.chave, slot: c.slot };
  return { chave: 'p:' + norm(rotulo), slot: 0 };
}
// Mapa índice → cor [r,g,b,a] (ou null: cor do tipo).
function coresDasPastas(nos, cores) {
  const grupos = new Map(), porNo = [];
  nos.forEach((n, i) => {
    const g = pastaDe(n);
    if (!g) { porNo[i] = null; return; }
    const e = grupos.get(g.chave) || grupos.set(g.chave, { ...g, n: 0 }).get(g.chave);
    e.n++;
    porNo[i] = e;
  });
  const usados = new Set([...grupos.values()].map((g) => g.slot));
  const livres = [1, 2, 3, 4, 5, 6].filter((s) => !usados.has(s));
  const novos = [...grupos.values()].filter((g) => g.slot === 0).sort((a, b) => b.n - a.n || (a.chave < b.chave ? -1 : 1));
  for (const g of novos) g.slot = livres.length ? livres.shift() : -2;
  return porNo.map((g) => (!g ? null : g.slot > 0 ? cores.grupos[g.slot] : g.slot === -1 ? cores.bastidores : cores.outras));
}

// ───────────── física ─────────────
function criarFisica(n, pares, anterior) {
  const x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  let semente = 1;
  const aleatorio = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };
  let conhecidos = 0;
  for (let i = 0; i < n; i++) {
    const a = anterior && anterior.get(i);
    if (a) { x[i] = a[0]; y[i] = a[1]; conhecidos++; }
    else { const r = Math.sqrt(AREA_POR_NO * (i + 0.5) / Math.PI), ang = i * 2.399963; x[i] = r * Math.cos(ang); y[i] = r * Math.sin(ang); }
  }
  const m = pares.length;
  const lo = new Int32Array(m), la = new Int32Array(m), vies = new Float64Array(m), invMin = new Float64Array(m);
  const grau = new Int32Array(n);
  for (let e = 0; e < m; e++) { lo[e] = pares[e][0]; la[e] = pares[e][1]; grau[lo[e]]++; grau[la[e]]++; }
  for (let e = 0; e < m; e++) { const gs = grau[lo[e]], gt = grau[la[e]]; vies[e] = gs / (gs + gt); invMin[e] = 1 / Math.min(gs, gt); }
  let tab = 16; while (tab < 2 * n) tab <<= 1;
  const masc = tab - 1, cab = new Int32Array(tab), prox = new Int32Array(n), gX = new Int32Array(n), gY = new Int32Array(n);
  let alpha = conhecidos === n && n ? 0.3 : 1;
  const diam = RAIO_COLISAO * 2, d2col = diam * diam, d2rep = CELULA * CELULA;

  function tick() {
    alpha += (0 - alpha) * ALPHA_DECAY;
    const kc = alpha * CENTRO;
    for (let i = 0; i < n; i++) { vx[i] -= kc * x[i]; vy[i] -= kc * y[i]; }
    for (let e = 0; e < m; e++) {
      const s = lo[e], t = la[e];
      let dx = x[t] + vx[t] - x[s] - vx[s], dy = y[t] + vy[t] - y[s] - vy[s];
      if (dx === 0) dx = 0.1;
      if (dy === 0) dy = 0.1;
      const l = Math.sqrt(dx * dx + dy * dy);
      const k = alpha * (l - DISTANCIA) / l * invMin[e];
      dx *= k; dy *= k;
      const b = vies[e];
      vx[t] -= dx * b; vy[t] -= dy * b; vx[s] += dx * (1 - b); vy[s] += dy * (1 - b);
    }
    // repulsão e colisão numa passada só, por grade espacial de células de CELULA
    for (let i = 0; i < n; i++) { gX[i] = Math.floor(x[i] / CELULA); gY[i] = Math.floor(y[i] / CELULA); }
    cab.fill(-1);
    for (let i = n - 1; i >= 0; i--) { const k = (Math.imul(gX[i], 73856093) ^ Math.imul(gY[i], 19349663)) & masc; prox[i] = cab[k]; cab[k] = i; }
    const fr = REPULSAO * alpha;
    for (let i = 0; i < n; i++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const gx = gX[i] + ox, gy = gY[i] + oy;
          for (let j = cab[(Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) & masc]; j >= 0; j = prox[j]) {
            if (j <= i || gX[j] !== gx || gY[j] !== gy) continue;
            let dx = x[j] - x[i], dy = y[j] - y[i];
            if (dx === 0) dx = (aleatorio() - 0.5) * 1e-3;
            if (dy === 0) dy = (aleatorio() - 0.5) * 1e-3;
            let d2 = dx * dx + dy * dy;
            if (d2 >= d2rep) continue;
            const real = d2;
            if (d2 < DIST2_MIN) d2 = Math.sqrt(DIST2_MIN * d2);
            const f = fr / d2;
            vx[i] -= dx * f; vy[i] -= dy * f; vx[j] += dx * f; vy[j] += dy * f;
            if (real < d2col) {
              const l = Math.sqrt(real);
              const k = (diam - l) / l * FORCA_COLISAO * 0.5;
              vx[i] -= dx * k; vy[i] -= dy * k; vx[j] += dx * k; vy[j] += dy * k;
            }
          }
        }
      }
    }
    for (let i = 0; i < n; i++) { vx[i] *= AMORT; vy[i] *= AMORT; x[i] += vx[i]; y[i] += vy[i]; }
    return alpha;
  }
  return { x, y, tick, get alpha() { return alpha; }, ativa: () => alpha >= ALPHA_MIN };
}

// ═════════════════════════════ tela ═════════════════════════════
let inst = null;

OM.telas.registrar('grafo', {
  titulo: 'Grafo do brain',
  montar(cont, params, ctx) {
    ctx.tela.classList.add('gf-raiz');

    // ── estado ──
    let projetos = [];            // [{ pasta, nome }]
    let pasta = '';
    let carga = 'carregando';     // carregando | ok | vazio | sem-brain | erro | sem-projetos
    let msgErro = '', truncado = false, aviso2 = '';
    let seqCarga = 0, abortar = null;
    let nos = [], links = [], fis = null, sel = -1, casam = null, busca = '';
    let L = 1, A = 1, dpr = 1, escala = 1, panX = 0, panY = 0;
    let alvoEsc = 1, alvoPx = 0, alvoPy = 0, seguir = true, medido = false;
    let cores = lerCores(), reduz = OM.reduzido();
    let raf = 0, destruido = false, noTopo = true, visivel = !document.hidden, quadros = 0, animando = false;
    let folha = null, seqNota = 0, notaDe = -1, fonte = '';
    const cacheNotas = new Map();
    let somaNotas = 0;

    // ── elementos ──
    const sel$ = h('select', { class: 'gf-sel', 'aria-label': 'Projeto', onchange: () => { pasta = sel$.value; gravarSalvo(pasta); fecharFolha(); nos = []; links = []; fis = null; sel = -1; casam = null; carregarGrafo(); } });
    const btEncaixar = h('button', { class: 'btn-icone gf-bt toque', type: 'button', 'aria-label': 'Encaixar', title: 'Encaixar', onclick: () => { encaixar(false); seguir = true; pedir(); } }, icone('comprimir', 20));
    const btAtualizar = h('button', { class: 'btn-icone gf-bt toque', type: 'button', 'aria-label': 'Atualizar', title: 'Atualizar', onclick: () => carregarGrafo() }, icone('atualizar', 20));
    const campo = h('input', { class: 'gf-busca', type: 'search', placeholder: 'Buscar nota', 'aria-label': 'Buscar nota pelo nome', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'search' });
    const contagem = h('span', { class: 'gf-contagem', 'aria-live': 'polite' });
    const aviso = h('div', { class: 'gf-aviso', role: 'status', hidden: true });
    const aviso$ = h('div', { class: 'gf-nota-aviso', role: 'status', hidden: true });
    const canvas = h('canvas', { class: 'gf-canvas', role: 'img', 'aria-label': 'Grafo do brain' });
    const c2 = canvas.getContext('2d');
    const resumo = h('div', { class: 'gf-resumo', 'aria-hidden': 'true', hidden: true });
    const estado = h('div', { class: 'gf-estado', hidden: true });
    const palco = h('div', { class: 'gf-palco' }, canvas, resumo, estado);
    cont.append(h('div', { class: 'gf-tela' },
      aviso,
      h('div', { class: 'gf-barra' }, h('div', { class: 'gf-sel-caixa' }, sel$, h('span', { class: 'gf-sel-chev', 'aria-hidden': 'true' }, icone('chevron-baixo', 16))), btEncaixar, btAtualizar),
      h('div', { class: 'gf-busca-caixa' }, h('span', { class: 'gf-busca-ico', 'aria-hidden': 'true' }, icone('busca', 16)), campo, contagem),
      aviso$, palco));

    // ── câmera ──
    const paraMundo = (sx, sy) => [(sx - panX) / escala, (sy - panY) / escala];
    function zoomEm(nova, cx, cy) {
      nova = limitar(nova, ESC_MIN, ESC_MAX);
      const wx = (cx - panX) / escala, wy = (cy - panY) / escala;
      escala = nova; panX = cx - wx * escala; panY = cy - wy * escala;
      alvoEsc = escala; alvoPx = panX; alvoPy = panY;
    }
    function encaixar(imediato) {
      if (!fis || !nos.length) return;
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (let i = 0; i < nos.length; i++) {
        const r = nos[i].tam;
        a = Math.min(a, fis.x[i] - r); c = Math.max(c, fis.x[i] + r);
        b = Math.min(b, fis.y[i] - r); d = Math.max(d, fis.y[i] + r + 24);
      }
      const w = Math.max(c - a, 1), hh = Math.max(d - b, 1), mg = 32;
      const esc = limitar(Math.min((L - 2 * mg) / w, (A - 2 * mg) / hh), ESC_MIN, ESC_ENCAIXE_MAX);
      alvoEsc = esc; alvoPx = L / 2 - ((a + c) / 2) * esc; alvoPy = A / 2 - ((b + d) / 2) * esc;
      if (imediato || reduz) { escala = alvoEsc; panX = alvoPx; panY = alvoPy; }
    }
    function irAo(i) { // centra o nó sem mexer no zoom
      if (!fis) return;
      seguir = false;
      alvoEsc = escala; alvoPx = L / 2 - fis.x[i] * escala; alvoPy = A / 2 - fis.y[i] * escala;
      if (reduz) { panX = alvoPx; panY = alvoPy; }
    }
    function medir() {
      const r = palco.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return; // tela escondida
      const nl = Math.max(1, Math.round(r.width)), na = Math.max(1, Math.round(r.height)), nd = window.devicePixelRatio || 1;
      if (nl === L && na === A && nd === dpr && medido) return;
      if (!medido) { panX = nl / 2; panY = na / 2; alvoPx = panX; alvoPy = panY; }
      else { panX += (nl - L) / 2; panY += (na - A) / 2; alvoPx += (nl - L) / 2; alvoPy += (na - A) / 2; }
      L = nl; A = na; dpr = nd;
      canvas.width = Math.round(L * dpr); canvas.height = Math.round(A * dpr);
      if (!medido) { medido = true; if (fis) { encaixar(true); } }
      else if (seguir && fis) encaixar(reduz);
      pedir();
    }

    // ── dados do desenho ──
    function raio(n) { return limitar(3 * Math.sqrt(n.peso + 1), 8, 30); }
    function corDoTipo(n) {
      if (n.cor) return n.cor;
      if (n.tipo === 'tag') return cores.tag;
      if (n.tipo === 'inexistente') return cores.inexistente;
      if (n.tipo === 'anexo') return cores.anexo;
      return cores.no;
    }
    function montarDados(g) {
      let lista = Array.isArray(g.nos) ? g.nos.filter((n) => n && n.id != null) : [];
      const vistos = new Set();
      lista = lista.filter((n) => (vistos.has(String(n.id)) ? false : (vistos.add(String(n.id)), true)));
      let brutos = (Array.isArray(g.links) ? g.links : []).slice(0, MAX_LINKS_BRUTOS).filter((l) => l && l.origem != null && l.destino != null);
      aviso2 = '';
      if (lista.length > MAX_NOS) {
        const grau = new Map();
        for (const l of brutos) { grau.set(String(l.origem), (grau.get(String(l.origem)) || 0) + 1); grau.set(String(l.destino), (grau.get(String(l.destino)) || 0) + 1); }
        const total = lista.length;
        lista = lista.map((n, i) => ({ n, i, g: grau.get(String(n.id)) || 0 })).sort((a, b) => b.g - a.g || a.i - b.i).slice(0, MAX_NOS).sort((a, b) => a.i - b.i).map((x) => x.n);
        aviso2 = 'Mostrando as ' + MAX_NOS + ' notas mais ligadas de ' + total + '.';
      }
      const anterior = new Map();
      if (fis) nos.forEach((n, i) => anterior.set(n.id, [fis.x[i], fis.y[i]]));
      const indice = new Map();
      const novos = lista.map((d, i) => {
        indice.set(String(d.id), i);
        const nome = d.nome != null && d.nome !== '' ? String(d.nome) : String(d.id).replace(/^.*\//, '').replace(/\.md$/i, '');
        return { id: String(d.id), nome, nomeN: norm(nome), tipo: d.tipo || 'nota', tags: Array.isArray(d.tags) ? d.tags : [], peso: 0, viz: new Set(), ent: new Set(), sai: new Set(),
          cor: null, tam: 8, alpha: 0, rgb: null, dy: 0, sx: 0, sy: 0, sr: 0 };
      });
      const pares = [], ligs = [], vistosL = new Map();
      let cortouLinks = false;
      for (const l of brutos) {
        const a = indice.get(String(l.origem)), b = indice.get(String(l.destino));
        if (a === undefined || b === undefined || a === b) continue;
        novos[a].peso++; novos[b].peso++;
        novos[a].viz.add(b); novos[b].viz.add(a); novos[a].sai.add(b); novos[b].ent.add(a);
        const k2 = b + '>' + a, k1 = a + '>' + b;
        if (vistosL.has(k2)) continue;
        if (vistosL.has(k1)) continue;
        if (pares.length >= MAX_PARES) { cortouLinks = true; continue; }
        vistosL.set(k1, 1);
        pares.push([a, b]);
        ligs.push({ a, b, alpha: 0, mix: 0 });
      }
      if (cortouLinks) aviso2 = (aviso2 ? aviso2 + ' ' : '') + 'Mostrando ' + MAX_PARES + ' ligações.';
      const gc = coresDasPastas(novos, cores);
      novos.forEach((n, i) => { n.cor = gc[i]; n.tam = raio(n); });
      const ant = new Map();
      novos.forEach((n, i) => { const p = anterior.get(n.id); if (p) ant.set(i, p); });
      nos = novos; links = ligs; sel = -1; casam = null; notaDe = -1;
      fis = criarFisica(nos.length, pares, ant.size ? ant : null);
      aplicarBusca(false);
      seguir = true;
      if (reduz) passosComOrcamento();
      if (medido) encaixar(true); else if (reduz) { /* encaixa ao medir */ }
      canvas.setAttribute('aria-label', 'Grafo do brain: ' + nos.length + (nos.length === 1 ? ' nota, ' : ' notas, ') + links.length + (links.length === 1 ? ' ligação' : ' ligações'));
    }

    // ── desenho ──
    function ani(v, alvo, eps) {
      if (reduz) return alvo;
      const d = alvo - v;
      if (Math.abs(d) <= (eps || 0.01)) return alvo;
      animando = true;
      return alvo - d * SUAVE;
    }
    function desenhar() {
      animando = false;
      if (!medido) return;
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.clearRect(0, 0, L, A);
      const n = nos.length;
      if (!n || !fis) return;
      const se = Math.sqrt(escala);
      const alvoTexto = limitar(Math.log2(escala) + 1, 0, 1);
      const d = sel;
      const vizD = d >= 0 ? nos[d].viz : null;
      for (let i = 0; i < n; i++) {
        const no = nos[i];
        const alvoA = d >= 0 ? (i === d || vizD.has(i) ? 1 : APAGADO) : casam ? (casam.has(i) ? 1 : APAGADO) : 1;
        const c = i === d ? cores.destaque : corDoTipo(no);
        if (!no.rgb) no.rgb = c.slice();
        no.alpha = ani(no.alpha, alvoA);
        for (let k = 0; k < 4; k++) no.rgb[k] = ani(no.rgb[k], c[k], k < 3 ? 0.5 : 0.002);
        no.dy = ani(no.dy, i === d ? ROTULO_DESCE : 0, 0.05);
        no.sx = fis.x[i] * escala + panX; no.sy = fis.y[i] * escala + panY; no.sr = no.tam * se;
      }
      // ligações
      const cl = cores.linha, ch = cores.linkDestaque;
      c2.lineCap = 'butt'; c2.lineWidth = 1;
      const avulsas = [];
      c2.beginPath();
      let lote = false;
      for (const l of links) {
        const p = nos[l.a], q = nos[l.b];
        const ligado = d >= 0 && (l.a === d || l.b === d);
        const alvoA = d >= 0 ? (ligado ? 1 : APAGADO) : casam ? (casam.has(l.a) && casam.has(l.b) ? 1 : APAGADO) : 1;
        l.alpha = ani(l.alpha, alvoA); l.mix = ani(l.mix, ligado ? 1 : 0);
        if (Math.max(p.sx, q.sx) < 0 || Math.min(p.sx, q.sx) > L || Math.max(p.sy, q.sy) < 0 || Math.min(p.sy, q.sy) > A) continue;
        const dx = q.sx - p.sx, dy = q.sy - p.sy, dist = Math.hypot(dx, dy);
        if (dist <= p.sr + q.sr) continue;
        const ux = dx / dist, uy = dy / dist;
        const seg = [p.sx + ux * p.sr, p.sy + uy * p.sr, q.sx - ux * q.sr, q.sy - uy * q.sr];
        if (l.alpha >= 1 && l.mix === 0) { c2.moveTo(seg[0], seg[1]); c2.lineTo(seg[2], seg[3]); lote = true; }
        else avulsas.push([seg, l.alpha, l.mix]);
      }
      if (lote) { c2.strokeStyle = rgbaTxt(cl, cl[3]); c2.stroke(); }
      for (const [seg, a, m] of avulsas) {
        const c = misturar(cl, ch, m);
        c2.strokeStyle = rgbaTxt(c, c[3] * a);
        c2.beginPath(); c2.moveTo(seg[0], seg[1]); c2.lineTo(seg[2], seg[3]); c2.stroke();
      }
      // nós e anel do selecionado
      for (let i = 0; i < n; i++) {
        const no = nos[i];
        if (no.sx + no.sr < 0 || no.sx - no.sr > L || no.sy + no.sr < 0 || no.sy - no.sr > A) continue;
        c2.fillStyle = rgbaTxt(no.rgb, no.rgb[3] * no.alpha);
        c2.beginPath(); c2.arc(no.sx, no.sy, no.sr, 0, Math.PI * 2); c2.fill();
        if (i === d) {
          c2.lineWidth = 1.5; c2.strokeStyle = rgbaTxt(cores.foco, cores.foco[3]);
          c2.beginPath(); c2.arc(no.sx, no.sy, no.sr + 1.5, 0, Math.PI * 2); c2.stroke();
        }
      }
      // rótulos: com o zoom (como no PC); o selecionado e os achados da busca sempre
      c2.textAlign = 'center'; c2.textBaseline = 'top';
      const ct = cores.texto;
      if (!fonte) fonte = OM.cssVar('--sans', 'system-ui, sans-serif');
      const forcaBusca = casam && casam.size <= MAX_ROTULOS_BUSCA;
      for (let i = 0; i < n; i++) {
        const no = nos[i];
        const forca = i === d || (forcaBusca && casam.has(i));
        const at = forca ? ct[3] : alvoTexto * no.alpha * ct[3];
        if (at <= 0.01) continue;
        const base = 14 + no.tam / 4;
        const topo = no.sy + (no.tam + 5) * se + no.dy;
        if (no.sx + 200 < 0 || no.sx - 200 > L || topo + 40 < 0 || topo > A) continue;
        const k = forca && escala < 1 ? 1 : se;
        c2.font = (base * k).toFixed(2) + 'px ' + fonte;
        c2.fillStyle = rgbaTxt(ct, at);
        const txt = no.nome.length > 28 ? no.nome.slice(0, 27) + '…' : no.nome;
        c2.fillText(txt, Math.round(no.sx), Math.round(topo));
      }
    }

    // ── laço: acomoda e PARA ──
    const ativo = () => !destruido && visivel && noTopo && !document.hidden && cont.isConnected;
    // movimento reduzido: acomoda sem animar, mas em fatias de ~40 ms para não travar o fio principal
    function passosComOrcamento() {
      const fim = performance.now() + 40;
      let k = 0;
      while (fis.ativa() && k < 400 && performance.now() < fim) { fis.tick(); k++; }
    }
    function pedir() { if (!raf && ativo()) raf = requestAnimationFrame(quadro); }
    function quadro() {
      raf = 0;
      if (!ativo()) return;
      quadros++;
      let quente = false;
      if (fis && fis.ativa()) {
        if (reduz) {
          passosComOrcamento();
          if (fis.ativa()) { pedir(); return; } // sem animação: só desenha quando a física dormir
        } else { for (let k = 0; k < PASSOS_POR_QUADRO && fis.ativa(); k++) fis.tick(); quente = fis.ativa(); }
        if (seguir && medido && (quadros % 3 === 0 || !quente)) encaixar(false);
      }
      let mexeu = false;
      if (!reduz) {
        const de = alvoEsc - escala, dx = alvoPx - panX, dy = alvoPy - panY;
        if (Math.abs(de) > 0.0005 * escala || Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) {
          escala += de * 0.2; panX += dx * 0.2; panY += dy * 0.2; mexeu = true;
        } else if (de || dx || dy) { escala = alvoEsc; panX = alvoPx; panY = alvoPy; }
      }
      desenhar();
      if (quente || mexeu || animando) pedir();
    }

    // ── busca, seleção e hit-test ──
    function aplicarBusca(redesenhar) {
      const q = norm(busca).trim();
      if (!q) casam = null;
      else { casam = new Set(); nos.forEach((no, i) => { if (no.nomeN.includes(q)) casam.add(i); }); }
      contagem.textContent = casam ? (casam.size ? casam.size + (casam.size === 1 ? ' nota' : ' notas') : 'Nada') : '';
      if (redesenhar) pedir();
    }
    function noEm(x, y) {
      let melhor = -1, dm = Infinity;
      for (let i = 0; i < nos.length; i++) {
        const no = nos[i];
        const dx = x - no.sx, dy = y - no.sy, d = Math.hypot(dx, dy), r = Math.max(no.sr, 14) + 4;
        if (d <= r && d - no.sr < dm) { dm = d - no.sr; melhor = i; }
      }
      return melhor;
    }
    function selecionar(i, abrir) {
      sel = i;
      pedir();
      if (i >= 0 && abrir) abrirNota(i);
    }

    // ── gestos: arrastar move, pinça dá zoom; a faixa da borda esquerda é do "voltar" ──
    const dedos = new Map();
    let g = null;
    const zona = () => (OM.gestos && OM.gestos.ZONA_BORDA) || 24;
    const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function baixo(e) {
      if (!medido || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (e.pointerType !== 'mouse' && e.clientX <= zona() && !dedos.size) return;
      const [x, y] = local(e);
      dedos.set(e.pointerId, { x, y });
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      seguir = false; alvoEsc = escala; alvoPx = panX; alvoPy = panY;
      if (dedos.size === 1) g = { modo: 'um', t0: performance.now(), x0: x, y0: y, px: panX, py: panY, moveu: false };
      else if (dedos.size === 2) iniciarPinca();
      pedir();
    }
    function iniciarPinca() {
      const [a, b] = [...dedos.values()];
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      g = { modo: 'dois', d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), esc0: escala, wx: (cx - panX) / escala, wy: (cy - panY) / escala, moveu: true };
    }
    function mover(e) {
      const d = dedos.get(e.pointerId);
      if (!d || !g) return;
      [d.x, d.y] = local(e);
      if (g.modo === 'um') {
        const dx = d.x - g.x0, dy = d.y - g.y0;
        if (!g.moveu && Math.hypot(dx, dy) < LIMIAR_TOQUE) return;
        g.moveu = true;
        panX = g.px + dx; panY = g.py + dy;
      } else if (dedos.size >= 2) {
        const [a, b] = [...dedos.values()];
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        escala = limitar(g.esc0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, ESC_MIN, ESC_MAX);
        panX = cx - g.wx * escala; panY = cy - g.wy * escala;
      }
      alvoEsc = escala; alvoPx = panX; alvoPy = panY;
      pedir();
    }
    function soltar(e, cancelou) {
      const d = dedos.get(e.pointerId);
      if (!d) return;
      dedos.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      const era = g;
      if (dedos.size === 0) {
        g = null;
        if (era && era.modo === 'um' && !era.moveu && !cancelou && performance.now() - era.t0 < MAX_TOQUE_MS) tocar(era.x0, era.y0);
      } else if (dedos.size === 1) { // sobrou um dedo depois da pinça: segue arrastando
        const [r] = [...dedos.values()];
        g = { modo: 'um', t0: 0, x0: r.x, y0: r.y, px: panX, py: panY, moveu: true };
      } else iniciarPinca();
      pedir();
    }
    // A folha só abre no "click" que o navegador solta logo depois do toque: se abrisse já no pointerup, o fundo dela apareceria
    // sob o dedo e esse mesmo click cairia nele e a fecharia. Sem click (raro), um relógio abre do mesmo jeito.
    let abrirDepois = -1, relogio = 0;
    function abrirPendente() { clearTimeout(relogio); relogio = 0; const i = abrirDepois; abrirDepois = -1; if (i >= 0 && i === sel && !destruido) abrirNota(i); }
    function tocar(x, y) {
      const i = noEm(x, y);
      if (i >= 0) { selecionar(i, false); abrirDepois = i; clearTimeout(relogio); relogio = setTimeout(abrirPendente, 350); }
      else { abrirDepois = -1; if (sel >= 0) selecionar(-1); }
    }
    function roda(e) {
      e.preventDefault();
      const [x, y] = local(e);
      seguir = false;
      zoomEm(escala * Math.exp(-e.deltaY * 0.0015), x, y);
      pedir();
    }
    canvas.addEventListener('pointerdown', baixo);
    canvas.addEventListener('pointermove', mover);
    canvas.addEventListener('pointerup', (e) => soltar(e, false));
    canvas.addEventListener('pointercancel', (e) => soltar(e, true));
    canvas.addEventListener('lostpointercapture', (e) => { if (dedos.has(e.pointerId)) soltar(e, true); });
    canvas.addEventListener('wheel', roda, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('click', abrirPendente);

    // ── nota na folha ──
    function fecharFolha() { const f = folha; folha = null; notaDe = -1; seqNota++; if (f) f.fechar('troca'); }
    const rotuloTipo = (no) => (no.tipo === 'anexo' ? 'anexo' : no.tipo === 'inexistente' ? 'ainda não existe' : no.tipo === 'tag' ? 'tag' : '');
    function abrirNota(i) {
      const no = nos[i];
      if (!no) return;
      notaDe = i;
      if (!folha) {
        const f = OM.folha.abrir({
          titulo: no.nome, paradas: ['meia', 'inteira'], rotulo: 'Nota do brain',
          conteudo: () => h('div', { class: 'gf-folha' }),
          aoFechar: () => { if (folha === f) { folha = null; notaDe = -1; seqNota++; } },
        });
        folha = f;
      }
      preencherFolha(i);
    }
    function preencherFolha(i) {
      const no = nos[i];
      const f = folha;
      if (!f || !no) return;
      const tit = f.el.querySelector('.folha-tit');
      if (tit) tit.textContent = no.nome;
      const meu = ++seqNota;
      const corpo = f.corpo;
      corpo.replaceChildren(h('div', { class: 'gf-folha' }, subtitulo(no), h('div', { class: 'esq gf-esq-n' }), h('div', { class: 'esq gf-esq-n gf-esq-c' })));
      corpo.scrollTop = 0;
      const mostrar = (...filhos) => { if (meu === seqNota && folha === f) { corpo.replaceChildren(h('div', { class: 'gf-folha' }, subtitulo(no), ...filhos)); corpo.scrollTop = 0; } };
      if (no.tipo !== 'nota' || !/\.md$/i.test(no.id)) {
        mostrar(h('p', { class: 'gf-folha-msg', text: no.tipo === 'inexistente' ? 'Esta nota é citada no brain, mas ainda não existe.' : no.tipo === 'anexo' ? 'Anexo do brain. O celular só mostra o texto das notas.' : 'Este item não tem texto para mostrar.' }), ligacoes(i));
        return;
      }
      const chave = pasta + '\n' + no.id;
      const dado = cacheNotas.get(chave);
      if (dado != null) { mostrar(textoDaNota(dado), ligacoes(i)); return; }
      api('GET', '/remoto/grafo/nota?projeto=' + encodeURIComponent(pasta) + '&id=' + encodeURIComponent(no.id)).then((r) => {
        if (meu !== seqNota || folha !== f || chave !== pasta + '\n' + no.id) return;
        const texto = r && typeof r.texto === 'string' ? r.texto : '';
        guardarNota(chave, texto);
        mostrar(textoDaNota(texto), ligacoes(i));
      }, (e) => {
        if (meu !== seqNota || folha !== f) return;
        const msg = e && e.status === 404 ? 'Esta nota não está mais no brain.' : e && e.status === 413 ? 'Esta nota é grande demais para abrir no celular.' : mensagem(e);
        mostrar(h('p', { class: 'gf-folha-msg', text: msg }),
          e && e.status === 404 ? null : h('button', { class: 'btn toque gf-tentar', type: 'button', onclick: () => preencherFolha(i) }, icone('atualizar', 18), h('span', { text: 'Tentar de novo' })),
          ligacoes(i));
      });
    }
    function guardarNota(chave, texto) {
      const velho = cacheNotas.get(chave);
      if (velho != null) somaNotas -= velho.length;
      cacheNotas.delete(chave);
      cacheNotas.set(chave, texto);
      somaNotas += texto.length;
      while (cacheNotas.size > 1 && (cacheNotas.size > 40 || somaNotas > MAX_CACHE_CHARS)) {
        const k = cacheNotas.keys().next().value;
        somaNotas -= cacheNotas.get(k).length;
        cacheNotas.delete(k);
      }
    }
    function subtitulo(no) {
      const caminho = no.id.includes('/') ? no.id.replace(/\/[^/]*$/, '') : '';
      return caminho ? h('p', { class: 'gf-folha-caminho', text: caminho }) : null;
    }
    function textoDaNota(texto) {
      const corpo = semFrontmatter(texto).trim();
      return corpo ? h('div', { class: 'md gf-md' }, OM.md(corpo)) : h('p', { class: 'gf-folha-msg', text: 'Nota vazia.' });
    }
    function ligacoes(i) {
      const no = nos[i];
      if (!no) return null;
      const grupo = (rot, conj) => {
        const ids = [...conj].sort((a, b) => (nos[a].nomeN < nos[b].nomeN ? -1 : 1));
        if (!ids.length) return null;
        return h('section', { class: 'gf-lig', 'aria-label': rot },
          h('h3', { class: 'gf-lig-tit', text: rot }),
          h('div', { class: 'gf-lig-lista' }, ...ids.map((j) => {
            const v = nos[j], pode = v.tipo === 'nota' && /\.md$/i.test(v.id), tipo = rotuloTipo(v);
            return h(pode ? 'button' : 'div', pode ? { class: 'gf-lig-item toque', type: 'button', onclick: () => irParaNota(j) } : { class: 'gf-lig-item gf-lig-morto' },
              h('span', { class: 'gf-lig-nome', text: v.nome }), tipo ? h('span', { class: 'gf-lig-tipo', text: tipo }) : icone('chevron', 14));
          })));
      };
      const sai = grupo('Aponta para', no.sai), ent = grupo('Citada por', no.ent);
      return sai || ent ? h('div', { class: 'gf-ligacoes' }, sai, ent) : null;
    }
    function irParaNota(j) {
      sel = j; notaDe = j;
      irAo(j);
      pedir();
      preencherFolha(j);
    }

    // ── estados da tela ──
    function pintar() {
      const conexao = OM.estado.conexao;
      const semPc = conexao === 'pc' || conexao === 'offline';
      aviso.hidden = !semPc;
      if (semPc) aviso.replaceChildren(icone('aparelho', 18), h('div', null, h('strong', { text: conexao === 'pc' ? 'PC desconectado' : 'Sem conexão' }),
        h('span', { text: nos.length ? 'Mostrando o grafo que já estava aqui.' : 'O grafo volta quando a conexão voltar.' })));
      const ok = carga === 'ok';
      const textoAviso = [truncado ? 'O brain é grande: o PC mandou só parte das notas.' : '', aviso2].filter(Boolean).join(' ');
      aviso$.hidden = !(ok && textoAviso);
      if (!aviso$.hidden) aviso$.replaceChildren(icone('info', 16), h('span', { text: textoAviso }));
      estado.hidden = ok;
      if (!ok && medido) { c2.setTransform(dpr, 0, 0, dpr, 0, 0); c2.clearRect(0, 0, L, A); }
      resumo.hidden = !ok;
      if (ok) resumo.textContent = nos.length + (nos.length === 1 ? ' nota' : ' notas') + ' · ' + links.length + (links.length === 1 ? ' ligação' : ' ligações');
      campo.disabled = !ok; btEncaixar.disabled = !ok;
      if (ok) { estado.replaceChildren(); return; }
      if (carga === 'carregando') estado.replaceChildren(h('div', { class: 'gf-esqueleto', 'aria-hidden': 'true' }, h('div', { class: 'esq gf-esq-grande' })), h('p', { class: 'gf-estado-txt', role: 'status', text: 'Carregando o grafo…' }));
      else if (carga === 'sem-brain') estado.replaceChildren(h('span', { class: 'gf-estado-ico' }, icone('grafo', 32)), h('p', { class: 'gf-estado-tit', text: 'Sem brain' }),
        h('p', { class: 'gf-estado-txt', text: 'Este projeto não tem brain vinculado. Vincule no PC: Editar projeto → Brain.' }));
      else if (carga === 'vazio') estado.replaceChildren(h('span', { class: 'gf-estado-ico' }, icone('grafo', 32)), h('p', { class: 'gf-estado-tit', text: 'Brain vazio' }),
        h('p', { class: 'gf-estado-txt', text: 'Ainda não há notas neste brain.' }));
      else if (carga === 'sem-projetos') estado.replaceChildren(h('span', { class: 'gf-estado-ico' }, icone('pasta', 32)), h('p', { class: 'gf-estado-tit', text: 'Nenhum projeto' }),
        h('p', { class: 'gf-estado-txt', text: 'Cadastre um projeto no PC para ver o grafo do brain dele.' }));
      else estado.replaceChildren(h('span', { class: 'gf-estado-ico' }, icone('alerta', 32)),
        h('p', { class: 'gf-estado-tit', text: semPc ? 'Sem conexão com o PC' : 'Não deu para carregar' }), h('p', { class: 'gf-estado-txt', text: msgErro || 'Tente de novo em instantes.' }),
        h('button', { class: 'btn toque', type: 'button', onclick: () => iniciar() }, icone('atualizar', 18), h('span', { text: 'Tentar de novo' })));
    }
    function preencherSeletor() {
      sel$.replaceChildren(...projetos.map((p) => h('option', { value: p.pasta, text: p.nome })));
      if (pasta) sel$.value = pasta;
      sel$.disabled = projetos.length < 2;
      sel$.parentElement.classList.toggle('so-um', projetos.length < 2);
    }

    // ── carga ──
    async function listarProjetos(sinal) {
      try {
        const r = await api('GET', '/remoto/projetos', undefined, { sinal });
        const lista = Array.isArray(r) ? r : r && Array.isArray(r.projetos) ? r.projetos : [];
        const ok = lista.filter((p) => p && typeof p.pasta === 'string' && p.pasta).map((p) => ({ pasta: p.pasta, nome: String(p.nome || p.pasta.replace(/^.*[\\/]/, '')) }));
        if (ok.length) return ok;
      } catch (e) { if (e && e.name === 'AbortError') throw e; if (e && e.rede) throw e; }
      // sem a lista do PC (criar instâncias desligado): usa as pastas das sessões que o app já conhece
      const mapa = new Map();
      for (const s of OM.estado.sessoes ? OM.estado.sessoes.values() : []) if (s && s.cwd && !mapa.has(s.cwd)) mapa.set(s.cwd, { pasta: s.cwd, nome: String(s.projeto || s.cwd.replace(/^.*[\\/]/, '')) });
      return [...mapa.values()];
    }
    async function iniciar() {
      const meu = ++seqCarga;
      if (abortar) abortar.abort();
      abortar = new AbortController();
      const sinal = abortar.signal;
      if (!nos.length) { carga = 'carregando'; pintar(); }
      try {
        const lista = await listarProjetos(sinal);
        if (meu !== seqCarga) return;
        projetos = lista;
        if (!projetos.length) { carga = 'sem-projetos'; pintar(); return; }
        const salvo = lerSalvo();
        pasta = projetos.some((p) => p.pasta === pasta) ? pasta : projetos.some((p) => p.pasta === salvo) ? salvo : projetos[0].pasta;
        preencherSeletor();
      } catch (e) {
        if (meu !== seqCarga || (e && e.name === 'AbortError')) return;
        falhou(e);
        return;
      }
      carregarGrafo(meu);
    }
    async function carregarGrafo(minha) {
      if (!pasta) return iniciar();
      const meu = minha || ++seqCarga;
      if (!minha) { if (abortar) abortar.abort(); abortar = new AbortController(); }
      const sinal = abortar.signal;
      if (!nos.length) { carga = 'carregando'; pintar(); }
      try {
        const r = await api('GET', '/remoto/grafo?projeto=' + encodeURIComponent(pasta), undefined, { sinal });
        if (meu !== seqCarga) return;
        truncado = !!(r && r.truncado);
        cacheNotas.clear(); somaNotas = 0;
        fecharFolha();
        montarDados(r || {});
        carga = nos.length ? 'ok' : 'vazio';
        if (!nos.length) { fis = null; links = []; }
        pintar();
        pedir();
      } catch (e) {
        if (meu !== seqCarga || (e && e.name === 'AbortError')) return;
        if (e && e.status === 404 && /^(sem_brain|brain_nao_encontrado)$/.test(e.codigo || '')) { nos = []; links = []; fis = null; carga = 'sem-brain'; pintar(); return; }
        if (nos.length && !(e && e.status === 404)) { toast('Não deu para atualizar o grafo'); return; }
        falhou(e);
      }
    }
    function falhou(e) {
      nos = []; links = []; fis = null;
      msgErro = e && e.status === 403 ? 'Este projeto não está liberado para o celular.' : mensagem(e);
      carga = 'erro';
      pintar();
    }

    // ── ligações com o resto do app ──
    campo.addEventListener('input', () => { busca = campo.value; aplicarBusca(true); });
    campo.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const primeiro = casam && casam.size ? Math.min(...casam) : -1;
      campo.blur();
      if (primeiro >= 0) { irAo(primeiro); selecionar(primeiro, true); }
    });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => medir()) : null;
    if (ro) ro.observe(palco);
    const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const aoReduzir = () => {
      reduz = OM.reduzido();
      if (reduz && fis) { passosComOrcamento(); if (seguir) encaixar(true); else { escala = alvoEsc; panX = alvoPx; panY = alvoPy; } }
      pedir();
    };
    if (mq && mq.addEventListener) mq.addEventListener('change', aoReduzir);
    const offs = [
      ouvir('visivel', (v) => { visivel = !!v; if (visivel) pedir(); }),
      ouvir('conexao', () => { if (cont.isConnected) pintar(); }),
    ];

    inst = {
      iniciar,
      mostrar() { noTopo = true; cores = lerCores(); if (nos.length) { const gc = coresDasPastas(nos, cores); nos.forEach((n, i) => { n.cor = gc[i]; n.rgb = null; }); } medir(); pedir(); if (carga === 'erro') iniciar(); },
      esconder() { noTopo = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } },
      estado() {
        return {
          carga, projeto: pasta, projetos: projetos.length, nos: nos.length, links: links.length, truncado, medido, L, A, dpr, escala,
          dormindo: !raf, alphaFisica: fis ? fis.alpha : 0, reduzido: reduz, quadros, selecionado: sel >= 0 ? nos[sel].id : null,
          vizinhos: sel >= 0 ? [...nos[sel].viz].map((j) => nos[j].id) : [], folha: !!folha, notaAberta: notaDe >= 0 ? nos[notaDe].id : null,
          casam: casam ? casam.size : null, seguir,
        };
      },
      posicao(id) {
        const i = nos.findIndex((n) => n.id === id);
        if (i < 0) return null;
        const r = canvas.getBoundingClientRect();
        return { x: r.left + nos[i].sx, y: r.top + nos[i].sy, r: nos[i].sr };
      },
      ids: () => nos.map((n) => n.id),
      limpar() {
        destruido = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (abortar) abortar.abort();
        if (ro) ro.disconnect();
        if (mq && mq.removeEventListener) mq.removeEventListener('change', aoReduzir);
        for (const o of offs) o();
        clearTimeout(relogio);
        fecharFolha();
      },
    };
    pintar();
    iniciar();
  },
  mostrar() { if (inst) inst.mostrar(); },
  esconder() { if (inst) inst.esconder(); },
  desmontar() { if (inst) { inst.limpar(); inst = null; } },
});

// Ganchos de leitura (testes e depuração): estado da tela aberta, posição de um nó na tela e ids.
OM.grafo = {
  estado: () => (inst ? inst.estado() : null),
  posicao: (id) => (inst ? inst.posicao(id) : null),
  ids: () => (inst ? inst.ids() : []),
};
})();
