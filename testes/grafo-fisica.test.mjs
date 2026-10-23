// Teste da física do Grafo (assets/grafo-fisica.js e assets/grafo-worker.js).
// node testes/grafo-fisica.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS = path.join(PROJ, 'assets');
await import(pathToFileURL(path.join(ASSETS, 'grafo-fisica.js')).href);
const GF = globalThis.GrafoFisica;

const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// Monta uma simulação com posições dadas (sem forças rodando), para testar cada força isolada.
function simCom(pontos, links = [], salvos = {}) {
  const sim = GF.criar();
  sim.definirDados({ nos: pontos.map((_, i) => ({ id: 'n' + i })), links: links.map(([a, b]) => ({ origem: 'n' + a, destino: 'n' + b })) });
  sim.definirForcas(salvos);
  const st = sim._estado();
  pontos.forEach(([px, py], i) => { st.x[i] = px; st.y[i] = py; st.vx[i] = 0; st.vy[i] = 0; });
  return { sim, st };
}
const distancia = (sim, a, b) => Math.hypot(sim.pos[2 * a] - sim.pos[2 * b], sim.pos[2 * a + 1] - sim.pos[2 * b + 1]);
const rodarAteParar = (sim, max = 2000) => { let k = 0; while (sim.ativa() && k < max) { sim.tick(); k++; } return k; };

try {
  // ── mapear ──
  const p = GF.mapear(GF.PADROES);
  conferir(perto(p.centro, 0.1, 1e-4) && p.repulsao === 1000 && p.link === 1 && p.distancia === 250, 'mapear(padrões) = {0,1; 1000; 1; 250}', p);
  conferir(GF.mapear({}).repulsao === 1000, 'mapear({}) usa os padrões');
  conferir(GF.mapear({ centro: 0 }).centro === 0 && perto(GF.mapear({ centro: 1 }).centro, 1, 1e-12), 'escala log: 0 → 0, 1 → 1');
  conferir(GF.mapear({ repulsao: 0.5 }).repulsao === 1 && GF.mapear({ repulsao: 2 }).repulsao === 8 && GF.mapear({ repulsao: 20 }).repulsao === 8000, 'repulsão = s³, mínimo 1');
  conferir(GF.mapear({ distancia: 10 }).distancia === 30 && GF.mapear({ distancia: 600 }).distancia === 500 && GF.mapear({ distancia: 77 }).distancia === 77, 'distância direta, faixa 30–500');
  conferir(perto(GF.mapear({ link: 0.5 }).link, (0.1 - 0.01) / 0.99, 1e-12), 'link 0,5 → (0,01^0,5 − 0,01)/0,99');

  // ── alpha ──
  {
    const s = GF.criar(); s.definirDados({ nos: [], links: [] });
    conferir(s.alpha === 1 && s.alvo === 0, 'alpha inicial 1, alvo 0');
    conferir(rodarAteParar(s) === 300, '300 ticks de alpha 1 até alphaMin');
    s.aquecer(0.3);
    conferir(s.alpha === 0.3 && rodarAteParar(s) === 248, '248 ticks de alpha 0,3 até alphaMin');
    s.aquecer(0.3, 0.3);
    for (let i = 0; i < 1000; i++) s.tick();
    conferir(s.ativa() && perto(s.alpha, 0.3, 1e-9), 'com alvo 0,3 fica quente em 0,3');
    s.aquecer(undefined, 0);
    conferir(rodarAteParar(s) === 248 && !s.ativa(), 'soltar (alvo 0) esfria em 248 ticks');
    const s2 = GF.criar(); s2.aquecer(0.3);
    conferir(s2.alpha === 1, 'aquecer não esfria (alpha só sobe)');
    conferir(perto(GF.ALPHA_DECAY, 0.022763, 1e-6), 'alphaDecay ≈ 0,022763');
  }

  // ── centro ──
  {
    const { sim, st } = simCom([[100, -40]], [], { centro: 1 });
    sim.alpha = 0.5; sim._forcas.centro();
    conferir(perto(st.vx[0], -50) && perto(st.vy[0], 20), 'centro: v −= alpha·centro·posição', [st.vx[0], st.vy[0]]);
  }

  // ── links ──
  {
    const { sim, st } = simCom([[0, 0], [100, 0]], [[0, 1]], { link: 1, distancia: 250 });
    sim.alpha = 1; sim._forcas.links();
    // d = (100, 0→0,1); l = √(10000,01); k = (l−250)/l; b = 1/2
    const l = Math.sqrt(10000.01), k = (l - 250) / l;
    conferir(perto(st.vx[1], -100 * k * 0.5) && perto(st.vy[1], -0.1 * k * 0.5) && perto(st.vx[0], 100 * k * 0.5) && perto(st.vy[0], 0.1 * k * 0.5),
      'link: k = alpha·força·(|d|−dist)/|d|/min(grau), componente zero → 0,1', [st.vx[0], st.vy[0], st.vx[1], st.vy[1]]);
    conferir(perto(st.vx[1], 75, 1e-3), 'link: conta à mão (alvo anda +75)', st.vx[1]);
  }
  {
    // Estrela: 0 ligado a 1 e 2 → grau 2 e 1; viés b = 2/3, min(grau) = 1.
    const { sim, st } = simCom([[0, 0], [0, 50], [300, 300]], [[0, 1], [0, 2]], { link: 1, distancia: 250 });
    sim.alpha = 1;
    // aplica só o primeiro link: zera o segundo pondo-o na distância exata não dá (é sequencial); calcula à mão os dois.
    sim._forcas.links();
    const b = 2 / 3;
    // link 0→1: d = (0→0,1, 50); l = √(2500,01); k = (l−250)/l
    const l1 = Math.sqrt(2500.01), k1 = (l1 - 250) / l1;
    const v1x = -0.1 * k1 * b, v1y = -50 * k1 * b;
    let v0x = 0.1 * k1 * (1 - b), v0y = 50 * k1 * (1 - b);
    // link 0→2: usa a velocidade já atualizada de 0
    let dx = 300 - v0x, dy = 300 - v0y;
    const l2 = Math.hypot(dx, dy), k2 = (l2 - 250) / l2;
    const v2x = -dx * k2 * b, v2y = -dy * k2 * b;
    v0x += dx * k2 * (1 - b); v0y += dy * k2 * (1 - b);
    conferir(perto(st.vx[1], v1x) && perto(st.vy[1], v1y) && perto(st.vx[2], v2x) && perto(st.vy[2], v2y) && perto(st.vx[0], v0x) && perto(st.vy[0], v0y),
      'link: viés por grau (b = grau origem/(soma)) e aplicação sequencial', [st.vx[0], st.vy[0], st.vx[2]]);
  }

  // ── repulsão ──
  {
    const { sim, st } = simCom([[0, 0], [10, 0]], [], { repulsao: 10 });
    sim.alpha = 1; sim._forcas.repulsao();
    // célula agregada com o outro nó: Δ = (10, 0→0,5); dist² = 100,25; v += Δ·(−1000)/dist²
    conferir(perto(st.vx[0], -10000 / 100.25) && perto(st.vy[0], -500 / 100.25) && perto(st.vx[1], 10000 / 100.25) && perto(st.vy[1], -500 / 100.25),
      'repulsão: v += Δ·força·n/dist², componente zero → 0,5', [st.vx[0], st.vy[0], st.vx[1], st.vy[1]]);
  }
  {
    const { sim, st } = simCom([[0, 0], [3, 0]], [], { repulsao: 10 });
    sim.alpha = 0.5; sim._forcas.repulsao();
    const d2 = Math.sqrt(30 * 9.25); // dist² < 30 → √(dist²·30)
    conferir(perto(st.vx[0], 3 * -500 / d2), 'repulsão: dist² mínima 30 (√(dist²·30))', st.vx[0]);
  }
  {
    // Barnes-Hut x força bruta (mesma fórmula, sem agregação) em 300 nós.
    const pts = []; let sem = 7;
    const r = () => { sem = (Math.imul(sem, 1664525) + 1013904223) >>> 0; return sem / 4294967296; };
    for (let i = 0; i < 300; i++) pts.push([r() * 2000 - 1000, r() * 2000 - 1000]);
    const { sim, st } = simCom(pts, [], { repulsao: 10 });
    sim.alpha = 1; sim._forcas.repulsao();
    let erro = 0, total = 0;
    for (let i = 0; i < pts.length; i++) {
      let ax = 0, ay = 0;
      for (let j = 0; j < pts.length; j++) {
        if (j === i) continue;
        const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
        let d2 = dx * dx + dy * dy; if (d2 < 30) d2 = Math.sqrt(30 * d2);
        ax += dx * -1000 / d2; ay += dy * -1000 / d2;
      }
      erro += Math.hypot(st.vx[i] - ax, st.vy[i] - ay); total += Math.hypot(ax, ay);
    }
    conferir(erro / total < 0.05, 'Barnes-Hut (θ 0,9) perto da força bruta (erro < 5%)', erro / total);
  }

  // ── colisão ──
  {
    const { sim, st } = simCom([[0, 0], [100, 0]]);
    sim._forcas.colisao();
    // dist 100 < 120: cada nó anda metade de Δ·0,5·(120−100)/100 = 5
    conferir(perto(st.vx[0], -5) && perto(st.vx[1], 5) && Math.abs(st.vy[0]) < 1e-6 && Math.abs(st.vy[1]) < 1e-6, 'colisão: raio 60, força 0,5, metade para cada', [st.vx[0], st.vx[1]]);
  }
  {
    const { sim, st } = simCom([[0, 0], [130, 0]]);
    sim._forcas.colisao();
    conferir(st.vx[0] === 0 && st.vx[1] === 0, 'colisão: sem efeito a partir de 120');
  }
  {
    const { sim, st } = simCom([[0, 0], [130, 0]]);
    st.vx[1] = -40; // posição prevista 90 → colide
    sim._forcas.colisao();
    conferir(perto(st.vx[0], -90 * 0.5 * (30 / 90) * 0.5) && perto(st.vx[1], -40 + 90 * 0.5 * (30 / 90) * 0.5), 'colisão usa a posição prevista (x + v)', [st.vx[0], st.vx[1]]);
  }

  // ── integração ──
  {
    const { sim, st } = simCom([[1, 2]]);
    st.vx[0] = 10; st.vy[0] = -5;
    sim._forcas.integrar();
    conferir(perto(st.vx[0], 6) && perto(st.x[0], 7) && perto(st.vy[0], -3) && perto(st.y[0], -1), 'integração: v ← v·0,6; x ← x + v');
  }

  // ── 2 nós ligados convergem ──
  {
    const s = GF.criar(); s.definirDados({ nos: [{ id: 'a' }, { id: 'b' }], links: [{ origem: 'a', destino: 'b' }] });
    s.definirForcas({ centro: 0, repulsao: 0 });
    rodarAteParar(s);
    conferir(Math.abs(distancia(s, 0, 1) - 250) < 1, '2 nós (sem centro/repulsão) → distância 250', distancia(s, 0, 1));
    // padrões: equilíbrio por nó: 1000/d − 0,1·d/2 − (d−250)/2 = 0 → 0,55d² − 125d − 1000 = 0
    const t = GF.criar(); t.definirDados({ nos: [{ id: 'a' }, { id: 'b' }], links: [{ origem: 'a', destino: 'b' }] });
    rodarAteParar(t);
    const esperado = (125 + Math.sqrt(125 * 125 + 4 * 0.55 * 1000)) / 1.1;
    conferir(Math.abs(distancia(t, 0, 1) - esperado) < 2, `2 nós (padrões) → distância de equilíbrio ≈ ${esperado.toFixed(1)}`, distancia(t, 0, 1));
  }

  // ── estrela e cadeia estabilizam ──
  for (const [nome, links, qtd] of [
    ['estrela', Array.from({ length: 12 }, (_, i) => [0, i + 1]), 13],
    ['cadeia', Array.from({ length: 19 }, (_, i) => [i, i + 1]), 20],
  ]) {
    const s = GF.criar();
    s.definirDados({ nos: Array.from({ length: qtd }, (_, i) => ({ id: 'n' + i })), links: links.map(([a, b]) => ({ origem: 'n' + a, destino: 'n' + b })) });
    rodarAteParar(s);
    const antes = s.pos.slice(); s.tick();
    let mov = 0, finito = true, minD = Infinity;
    for (let i = 0; i < qtd; i++) {
      mov = Math.max(mov, Math.hypot(s.pos[2 * i] - antes[2 * i], s.pos[2 * i + 1] - antes[2 * i + 1]));
      if (!Number.isFinite(s.pos[2 * i]) || !Number.isFinite(s.pos[2 * i + 1])) finito = false;
      for (let j = i + 1; j < qtd; j++) minD = Math.min(minD, distancia(s, i, j));
    }
    conferir(finito && mov < 0.5, `${nome}: estabiliza (movimento no fim < 0,5)`, mov);
    conferir(minD > 90, `${nome}: nós não se sobrepõem (colisão)`, minD);
  }

  // ── nós fixos ──
  {
    const s = GF.criar();
    s.definirDados({ nos: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ origem: 'a', destino: 'b' }, { origem: 'b', destino: 'c' }] });
    s.fixar(1, 50, -20);
    conferir(s.pos[2] === 50 && s.pos[3] === -20, 'fixar põe o nó na posição na hora');
    for (let i = 0; i < 150; i++) s.tick();
    conferir(s.pos[2] === 50 && s.pos[3] === -20, 'nó fixo não se move com os ticks');
    s.soltar(1); s.aquecer(0.3);
    for (let i = 0; i < 20; i++) s.tick();
    conferir(s.pos[2] !== 50 || s.pos[3] !== -20, 'nó solto volta a se mover');
  }

  // ── determinismo ──
  {
    const dados = { nos: Array.from({ length: 60 }, (_, i) => ({ id: 'n' + i })), links: Array.from({ length: 80 }, (_, i) => ({ origem: 'n' + (i % 60), destino: 'n' + ((i * 7 + 3) % 60) })) };
    const a = GF.criar(), b = GF.criar();
    a.definirDados(dados); b.definirDados(dados);
    for (let i = 0; i < 120; i++) { a.tick(); b.tick(); }
    conferir(a.pos.every((v, i) => v === b.pos[i]), 'determinismo: mesmos dados → mesmas posições');
  }

  // ── posição inicial ──
  {
    const N = 50;
    const s = GF.criar(); s.definirDados({ nos: Array.from({ length: N }, (_, i) => ({ id: 'n' + i })), links: [] });
    let rmax = 0; for (let i = 0; i < N; i++) rmax = Math.max(rmax, Math.hypot(s.pos[2 * i], s.pos[2 * i + 1]));
    conferir(rmax <= 60 * Math.sqrt(N / Math.PI) + 1e-6, 'primeira carga: disco de raio 60·√(N/π)', rmax);
    for (let i = 0; i < 100; i++) s.tick();
    const antigo = s.pos.slice();
    let R = 0; for (let i = 0; i < N; i++) R = Math.max(R, Math.hypot(antigo[2 * i], antigo[2 * i + 1]));
    const nos = Array.from({ length: N }, (_, i) => ({ id: 'n' + i }));
    nos.push({ id: 'viz' }, { id: 'solto1' }, { id: 'solto2' }, { id: 'viz2' });
    s.definirDados({ nos, links: [{ origem: 'viz', destino: 'n3' }, { origem: 'viz', destino: 'n4' }, { origem: 'viz2', destino: 'viz' }] });
    conferir(antigo.every((v, i) => v === s.pos[i]), 'ids que já existiam mantêm a posição');
    const ruido = 30 * Math.sqrt(4);
    const mx = (antigo[6] + antigo[8]) / 2, my = (antigo[7] + antigo[9]) / 2;
    const iv = s.indiceDe('viz');
    conferir(Math.abs(s.pos[2 * iv] - mx) <= ruido + 1e-3 && Math.abs(s.pos[2 * iv + 1] - my) <= ruido + 1e-3, 'nó novo com vizinhos: média ± 30·√N');
    const iv2 = s.indiceDe('viz2');
    conferir(Math.abs(s.pos[2 * iv2] - s.pos[2 * iv]) <= ruido + 1e-3, 'nó novo usa vizinho colocado no mesmo lote');
    const rFora = Math.sqrt(3600 * 4 / Math.PI + R * R);
    const okAnel = ['solto1', 'solto2'].every((id) => { const i = s.indiceDe(id); const r = Math.hypot(s.pos[2 * i], s.pos[2 * i + 1]); return r >= R - 1e-3 && r <= rFora + 1e-3; });
    conferir(okAnel, 'nó novo sem vizinhos: anel entre R e √(3600N/π + R²)');
  }

  // ── desempenho: 2000 nós ──
  {
    const N = 2000; let sem = 3;
    const r = () => { sem = (Math.imul(sem, 1664525) + 1013904223) >>> 0; return sem / 4294967296; };
    const links = [];
    for (let i = 1; i < N; i++) links.push({ origem: 'n' + i, destino: 'n' + Math.floor(r() * i) });
    for (let i = 0; i < 1000; i++) links.push({ origem: 'n' + Math.floor(r() * N), destino: 'n' + Math.floor(r() * N) });
    const s = GF.criar();
    s.definirDados({ nos: Array.from({ length: N }, (_, i) => ({ id: 'n' + i })), links });
    for (let i = 0; i < 30; i++) s.tick();
    const T = 200, t0 = performance.now();
    for (let i = 0; i < T; i++) s.tick();
    const media = (performance.now() - t0) / T;
    console.log(`tick com ${N} nós e ${links.length} links: ${media.toFixed(2)} ms em média`);
    conferir(media < 8, '2000 nós: tick médio < 8 ms', media);
  }

  // ── worker (num contexto vm com importScripts/postMessage falsos) ──
  {
    const msgs = [];
    const ctx = { setTimeout, clearTimeout, console };
    ctx.self = ctx;
    ctx.postMessage = (m) => msgs.push(m);
    ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ASSETS, f), 'utf8'), ctx, { filename: f });
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ASSETS, 'grafo-worker.js'), 'utf8'), ctx, { filename: 'grafo-worker.js' });
    const enviar = (data) => ctx.self.onmessage({ data });
    const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
    enviar({ tipo: 'dados', nos: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ origem: 'a', destino: 'b' }] });
    conferir(msgs.length === 1 && msgs[0].tipo === 'pos' && Object.prototype.toString.call(msgs[0].pos) === '[object Float32Array]' && msgs[0].pos.length === 6, 'worker: dados → envia pos (Float32Array) na hora');
    await esperar(200);
    const n1 = msgs.length;
    conferir(n1 >= 5 && n1 <= 16, 'worker: ~60 Hz (5–16 mensagens em 200 ms)', n1);
    conferir(msgs[n1 - 1].alpha < msgs[1].alpha, 'worker: alpha cai a cada tick');
    enviar({ tipo: 'fixar', i: 0, x: 10, y: 20 });
    await esperar(60);
    const u = msgs[msgs.length - 1];
    conferir(u.pos[0] === 10 && u.pos[1] === 20, 'worker: fixar segura o nó');
    enviar({ tipo: 'soltar', i: 0 });
    enviar({ tipo: 'forcas', forcas: { centro: 1 } });
    enviar({ tipo: 'aquecer', alpha: 0.9 });
    await esperar(60);
    conferir(msgs[msgs.length - 1].alpha > 0.8, 'worker: aquecer sobe alpha', msgs[msgs.length - 1].alpha);
  }
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
}

console.log(`${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('FALHA: ' + f);
process.exit(res.falhas.length ? 1 : 0);
