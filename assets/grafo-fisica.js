// Física do Grafo do Orbit (código próprio, escrito a partir da especificação
// "06 Referências/Graph View do Obsidian — especificação.md", §2, e do modelo documentado do d3-force).
// Script clássico: define globalThis.GrafoFisica. Funciona por <script src>, por importScripts() num Worker
// e em node com `await import()` (lendo globalThis.GrafoFisica depois).
//
// Tick (ordem da spec): alpha → centro → links → repulsão (Barnes-Hut) → colisão → integração → fixos.
(function (raiz) {
  'use strict';

  const ALPHA_MIN = 0.001;
  const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300); // ≈ 0,022763: 300 ticks de 1 até alphaMin
  const AMORTECIMENTO = 0.6;                         // v ← v·0,6 (velocityDecay 0,4 do d3)
  const THETA2 = 0.9 * 0.9;                          // critério de Barnes-Hut (θ = 0,9)
  const DIST2_MIN = 30;                              // dist² mínima da repulsão
  const RAIO_COLISAO = 60;
  const FORCA_COLISAO = 0.5;
  const AREA_POR_NO = 3600;
  const PADROES = Object.freeze({ centro: 0.518713, repulsao: 10, link: 1, distancia: 250 });

  const limitar = (v, a, b) => (v < a ? a : v > b ? b : v);
  const numero = (v, padrao) => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);

  // Escala logarítmica dos sliders 0–1 (centro e links): 0 → 0, 1 → 1.
  function escalaLog(s) {
    s = limitar(s, 0, 1);
    return (Math.pow(0.01, 1 - s) - 0.01) / 0.99;
  }

  // Valores salvos (sliders) → valores físicos.
  function mapear(salvos) {
    const s = salvos || {};
    const rep = Math.pow(limitar(numero(s.repulsao, PADROES.repulsao), 0, 20), 3);
    return {
      centro: escalaLog(numero(s.centro, PADROES.centro)),
      repulsao: rep < 1 ? 1 : rep,
      link: escalaLog(numero(s.link, PADROES.link)),
      distancia: limitar(numero(s.distancia, PADROES.distancia), 30, 500),
    };
  }

  function criar(opcoes) {
    const op = opcoes || {};
    // Aleatório determinístico (LCG de 32 bits); a semente fixa torna a simulação reprodutível.
    let semente = (numero(op.semente, 1) >>> 0) || 1;
    const aleatorio = () => { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; return semente / 4294967296; };
    const tremor = () => (aleatorio() - 0.5) * 1e-6;

    let fis = mapear(PADROES);
    let alpha = 1, alvo = 0;

    // Estado dos nós
    let n = 0, ids = [], indice = new Map();
    let x = new Float64Array(0), y = x, vx = x, vy = x, fx = x, fy = x;
    let fixo = new Uint8Array(0);
    let pos = new Float32Array(0);
    // Links (já resolvidos em índices)
    let m = 0, lo = new Int32Array(0), la = lo, vies = new Float64Array(0), invMin = vies;

    // Quadtree (repulsão): células em arrays tipados, crescem sob demanda.
    let qCap = 0, qN = 0;
    let qFilho = new Int32Array(0), qPai = qFilho, qPonto = qFilho, qInterno = new Uint8Array(0);
    let qLado = new Float64Array(0), qCnt = qLado, qSx = qLado, qSy = qLado;
    let prox = new Int32Array(0), pilha = new Int32Array(0);
    // Grade de colisão (hash espacial)
    let gCab = new Int32Array(0), gProx = gCab, gX = gCab, gY = gCab, gMasc = 0;

    function crescer(arr, tam) { const novo = new arr.constructor(tam); novo.set(arr.subarray(0, Math.min(arr.length, tam))); return novo; }
    function qGarantir(c) {
      if (c <= qCap) return;
      const cap = Math.max(c, qCap * 2, 64);
      qFilho = crescer(qFilho, cap * 4); qPai = crescer(qPai, cap); qPonto = crescer(qPonto, cap);
      qInterno = crescer(qInterno, cap); qLado = crescer(qLado, cap); qCnt = crescer(qCnt, cap);
      qSx = crescer(qSx, cap); qSy = crescer(qSy, cap);
      qCap = cap;
    }
    function qNova(pai, lado) {
      qGarantir(qN + 1);
      const c = qN++;
      const b = c * 4;
      qFilho[b] = qFilho[b + 1] = qFilho[b + 2] = qFilho[b + 3] = -1;
      qPai[c] = pai; qPonto[c] = -1; qInterno[c] = 0; qLado[c] = lado; qCnt[c] = 0; qSx[c] = 0; qSy[c] = 0;
      return c;
    }

    function construirArvore() {
      qN = 0;
      if (!n) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const a = x[i], b = y[i];
        if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b;
      }
      let lado = Math.max(x1 - x0, y1 - y0);
      if (!(lado > 0)) lado = 1;
      qNova(-1, lado);
      for (let p = 0; p < n; p++) {
        const px = x[p], py = y[p];
        let c = 0, cx = x0, cy = y0, s = lado;
        for (;;) {
          if (qInterno[c]) {
            const h = s / 2;
            let q = 0;
            if (px >= cx + h) { q |= 1; cx += h; }
            if (py >= cy + h) { q |= 2; cy += h; }
            s = h;
            let f = qFilho[c * 4 + q];
            if (f < 0) { f = qNova(c, s); qFilho[c * 4 + q] = f; qPonto[f] = p; prox[p] = -1; break; }
            c = f;
            continue;
          }
          const h0 = qPonto[c];
          if (h0 < 0) { qPonto[c] = p; prox[p] = -1; break; }
          if ((x[h0] === px && y[h0] === py) || s < 1e-9) { prox[p] = h0; qPonto[c] = p; break; } // coincidentes: lista
          // Divide a folha: a lista existente desce para o quadrante dela; p continua descendo.
          qInterno[c] = 1; qPonto[c] = -1;
          const h = s / 2;
          const q = (x[h0] >= cx + h ? 1 : 0) | (y[h0] >= cy + h ? 2 : 0);
          const f = qNova(c, h);
          qFilho[c * 4 + q] = f; qPonto[f] = h0;
        }
      }
      // Massas e somas (filhos sempre têm índice maior que o pai).
      for (let c = qN - 1; c >= 0; c--) {
        if (!qInterno[c]) {
          let k = 0, sx = 0, sy = 0;
          for (let p = qPonto[c]; p >= 0; p = prox[p]) { k++; sx += x[p]; sy += y[p]; }
          qCnt[c] = k; qSx[c] = sx; qSy[c] = sy;
        }
        const pai = qPai[c];
        if (pai >= 0) { qCnt[pai] += qCnt[c]; qSx[pai] += qSx[c]; qSy[pai] += qSy[c]; }
      }
      if (pilha.length < qN + 4) pilha = new Int32Array(qCap + 4);
    }

    function forcaCentro() {
      const k = alpha * fis.centro;
      if (!k) return;
      for (let i = 0; i < n; i++) { vx[i] -= k * x[i]; vy[i] -= k * y[i]; }
    }

    function forcaLinks() {
      const base = alpha * fis.link, dist = fis.distancia;
      if (!base) return;
      for (let e = 0; e < m; e++) {
        const s = lo[e], t = la[e];
        let dx = x[t] + vx[t] - x[s] - vx[s];
        let dy = y[t] + vy[t] - y[s] - vy[s];
        if (dx === 0) dx = 0.1;
        if (dy === 0) dy = 0.1;
        const l = Math.sqrt(dx * dx + dy * dy);
        const k = base * (l - dist) / l * invMin[e];
        dx *= k; dy *= k;
        const b = vies[e];
        vx[t] -= dx * b; vy[t] -= dy * b;
        vx[s] += dx * (1 - b); vy[s] += dy * (1 - b);
      }
    }

    function forcaRepulsao() {
      if (n < 2) return;
      construirArvore();
      const forca = -fis.repulsao * alpha;
      for (let i = 0; i < n; i++) {
        const xi = x[i], yi = y[i];
        let ax = 0, ay = 0, sp = 0;
        pilha[sp++] = 0;
        while (sp > 0) {
          const c = pilha[--sp];
          const k = qCnt[c];
          if (k === 0) continue;
          let dx = qSx[c] / k - xi, dy = qSy[c] / k - yi;
          let l = dx * dx + dy * dy;
          const w = qLado[c];
          if (w * w / THETA2 < l) { // célula longe o bastante: agrega
            if (dx === 0) { dx = 0.5; l += 0.25; }
            if (dy === 0) { dy = 0.5; l += 0.25; }
            if (l < DIST2_MIN) l = Math.sqrt(DIST2_MIN * l);
            const f = forca * k / l;
            ax += dx * f; ay += dy * f;
            continue;
          }
          if (qInterno[c]) {
            const b = c * 4;
            for (let q = 0; q < 4; q++) { const f = qFilho[b + q]; if (f >= 0) pilha[sp++] = f; }
            continue;
          }
          for (let p = qPonto[c]; p >= 0; p = prox[p]) {
            if (p === i) continue;
            const ex = x[p] - xi, ey = y[p] - yi;
            let d2 = ex * ex + ey * ey;
            if (d2 === 0) continue; // sobreposição exata: ignora
            if (d2 < DIST2_MIN) d2 = Math.sqrt(DIST2_MIN * d2);
            const f = forca / d2;
            ax += ex * f; ay += ey * f;
          }
        }
        vx[i] += ax; vy[i] += ay;
      }
    }

    function forcaColisao() {
      if (n < 2) return;
      const diam = RAIO_COLISAO * 2, d2max = diam * diam;
      // Hash espacial com células do tamanho do diâmetro, sobre a posição prevista (x + v).
      for (let i = 0; i < n; i++) {
        const gx = Math.floor((x[i] + vx[i]) / diam), gy = Math.floor((y[i] + vy[i]) / diam);
        gX[i] = gx; gY[i] = gy;
      }
      gCab.fill(-1);
      for (let i = n - 1; i >= 0; i--) {
        const h = (Math.imul(gX[i], 73856093) ^ Math.imul(gY[i], 19349663)) & gMasc;
        gProx[i] = gCab[h]; gCab[h] = i;
      }
      for (let i = 0; i < n; i++) {
        const xi = x[i] + vx[i], yi = y[i] + vy[i];
        const gxi = gX[i], gyi = gY[i];
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const gx = gxi + ox, gy = gyi + oy;
            const h = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) & gMasc;
            for (let j = gCab[h]; j >= 0; j = gProx[j]) {
              if (j <= i || gX[j] !== gx || gY[j] !== gy) continue;
              let dx = xi - x[j] - vx[j], dy = yi - y[j] - vy[j];
              let l = dx * dx + dy * dy;
              if (l >= d2max) continue;
              if (dx === 0) { dx = tremor(); l += dx * dx; }
              if (dy === 0) { dy = tremor(); l += dy * dy; }
              l = Math.sqrt(l);
              const k = (diam - l) / l * FORCA_COLISAO * 0.5; // metade para cada nó (raios iguais)
              dx *= k; dy *= k;
              vx[i] += dx; vy[i] += dy;
              vx[j] -= dx; vy[j] -= dy;
            }
          }
        }
      }
    }

    function integrar() {
      for (let i = 0; i < n; i++) {
        if (fixo[i]) { x[i] = fx[i]; y[i] = fy[i]; vx[i] = 0; vy[i] = 0; continue; }
        vx[i] *= AMORTECIMENTO; vy[i] *= AMORTECIMENTO;
        x[i] += vx[i]; y[i] += vy[i];
      }
    }

    function atualizarPos() {
      for (let i = 0; i < n; i++) { pos[2 * i] = x[i]; pos[2 * i + 1] = y[i]; }
    }

    function tick() {
      alpha += (alvo - alpha) * ALPHA_DECAY;
      forcaCentro();
      forcaLinks();
      forcaRepulsao();
      forcaColisao();
      integrar();
      atualizarPos();
      return alpha;
    }

    function definirDados(dados) {
      const nos = (dados && dados.nos) || [];
      const lks = (dados && dados.links) || [];
      const antigo = indice;
      const ox = x, oy = y, ovx = vx, ovy = vy, ofixo = fixo, ofx = fx, ofy = fy;

      // Nós (ids repetidos ficam com a primeira ocorrência)
      const novosIds = [], novoIndice = new Map();
      for (const no of nos) {
        const id = no && typeof no === 'object' ? no.id : no;
        if (id === undefined || id === null || novoIndice.has(String(id))) continue;
        novoIndice.set(String(id), novosIds.length);
        novosIds.push(String(id));
      }
      n = novosIds.length; ids = novosIds; indice = novoIndice;
      x = new Float64Array(n); y = new Float64Array(n); vx = new Float64Array(n); vy = new Float64Array(n);
      fx = new Float64Array(n); fy = new Float64Array(n); fixo = new Uint8Array(n);
      pos = new Float32Array(2 * n);
      const colocado = new Uint8Array(n);
      let R = 0, novos = 0;
      for (let i = 0; i < n; i++) {
        const j = antigo.get(ids[i]);
        if (j === undefined) { novos++; continue; }
        x[i] = ox[j]; y[i] = oy[j]; vx[i] = ovx[j]; vy[i] = ovy[j];
        fixo[i] = ofixo[j]; fx[i] = ofx[j]; fy[i] = ofy[j];
        colocado[i] = 1;
        const r = Math.sqrt(x[i] * x[i] + y[i] * y[i]);
        if (r > R) R = r;
      }

      // Links (descarta extremidades desconhecidas e laços no mesmo nó)
      const ls = [], la2 = [];
      const grau = new Int32Array(n);
      for (const lk of lks) {
        if (!lk) continue;
        const s = indice.get(String(lk.origem)), t = indice.get(String(lk.destino));
        if (s === undefined || t === undefined || s === t) continue;
        ls.push(s); la2.push(t); grau[s]++; grau[t]++;
      }
      m = ls.length;
      lo = Int32Array.from(ls); la = Int32Array.from(la2);
      vies = new Float64Array(m); invMin = new Float64Array(m);
      for (let e = 0; e < m; e++) {
        const gs = grau[lo[e]], gt = grau[la[e]];
        vies[e] = gs / (gs + gt);
        invMin[e] = 1 / Math.min(gs, gt);
      }

      // Posição inicial dos nós novos (spec §2): vizinhos já colocados → média ± ruído; senão anel por área.
      if (novos) {
        const inicio = new Int32Array(n + 1);
        for (let i = 0; i < n; i++) inicio[i + 1] = inicio[i] + grau[i];
        const viz = new Int32Array(2 * m), cur = inicio.slice(0, n);
        for (let e = 0; e < m; e++) { viz[cur[lo[e]]++] = la[e]; viz[cur[la[e]]++] = lo[e]; }
        const ruido = 30 * Math.sqrt(novos);
        const rFora = Math.sqrt(AREA_POR_NO * novos / Math.PI + R * R);
        for (let i = 0; i < n; i++) {
          if (colocado[i]) continue;
          let k = 0, sx = 0, sy = 0;
          for (let a = inicio[i]; a < inicio[i + 1]; a++) {
            const v = viz[a];
            if (colocado[v]) { k++; sx += x[v]; sy += y[v]; }
          }
          if (k) {
            x[i] = sx / k + (aleatorio() * 2 - 1) * ruido;
            y[i] = sy / k + (aleatorio() * 2 - 1) * ruido;
          } else {
            const ang = aleatorio() * 2 * Math.PI;
            const r = R + Math.sqrt(aleatorio()) * (rFora - R);
            x[i] = r * Math.cos(ang); y[i] = r * Math.sin(ang);
          }
          colocado[i] = 1;
        }
      }

      // Estruturas auxiliares
      prox = new Int32Array(n);
      let tab = 16; while (tab < 2 * n) tab <<= 1;
      gCab = new Int32Array(tab); gMasc = tab - 1;
      gProx = new Int32Array(n); gX = new Int32Array(n); gY = new Int32Array(n);
      atualizarPos();
    }

    function definirForcas(salvos) { fis = mapear(Object.assign({}, PADROES, salvos || {})); }

    // Reaquecimento: alpha só sobe (nunca esfria); alvo é definido quando informado.
    function aquecer(a, t) {
      if (typeof a === 'number' && Number.isFinite(a) && a > alpha) alpha = a;
      if (typeof t === 'number' && Number.isFinite(t)) alvo = Math.max(0, t);
    }

    function fixar(i, px, py) {
      if (!(i >= 0 && i < n)) return;
      fixo[i] = 1; fx[i] = px; fy[i] = py;
      x[i] = px; y[i] = py; vx[i] = 0; vy[i] = 0;
      pos[2 * i] = px; pos[2 * i + 1] = py;
    }
    function soltar(i) { if (i >= 0 && i < n) fixo[i] = 0; }

    return {
      definirDados, definirForcas, tick, aquecer, fixar, soltar,
      ativa: () => alpha >= ALPHA_MIN || alvo > 0,
      indiceDe: (id) => indice.get(String(id)),
      get pos() { return pos; },
      get ids() { return ids; },
      get n() { return n; },
      get alpha() { return alpha; }, set alpha(v) { alpha = +v; },
      get alvo() { return alvo; }, set alvo(v) { alvo = +v; },
      get forcas() { return Object.assign({}, fis); },
      get vel() { const v = new Float64Array(2 * n); for (let i = 0; i < n; i++) { v[2 * i] = vx[i]; v[2 * i + 1] = vy[i]; } return v; },
      // Acesso direto para testes de fórmula (posições/velocidades em Float64).
      _estado: () => ({ x, y, vx, vy }),
      _forcas: { centro: forcaCentro, links: forcaLinks, repulsao: forcaRepulsao, colisao: forcaColisao, integrar },
    };
  }

  raiz.GrafoFisica = Object.freeze({
    criar, mapear, escalaLog, PADROES,
    ALPHA_MIN, ALPHA_DECAY, AMORTECIMENTO, THETA: 0.9, DIST2_MIN, RAIO_COLISAO, FORCA_COLISAO, AREA_POR_NO,
  });
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
