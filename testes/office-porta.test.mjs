// Office: os agentes entram nas casas (como no protótipo da Vila) e os balões de fala no estilo pixel art.
// node testes/office-porta.test.mjs [pasta-de-saida]
// Servidor estático mínimo (porta por escolherPorta, padrão 47824) + página gerada com API falsa de sessões
// controlável (__alterar). Edge headless + CDP. Confere:
//  1) quem já trabalha ao abrir começa dentro da casa (o robô some, o crachá fica na porta e abre o cartão);
//  2) trabalhando: anda da estação até a porta e some aos poucos, sem salto; a posição lógica segue na estação;
//  3) conversa: o anfitrião sai da casa e os dois ficam visíveis durante a troca;
//  4) ao terminar: surge na porta antes de andar e chega ao descanso visível;
//  5) balão de fala: pergaminho com contorno preto de 2 px, sem cantos arredondados nem sombra borrada;
//  6) movimento reduzido: entra e sai sem animação; pausar/retomar sem erro; zero erros de console.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (SAIDA) fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const conferir = (ok, msg) => { console.log((ok ? 'ok   ' : 'FALHA ') + msg); if (!ok) falhas.push(msg); };
const consoleErros = [];

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Office · porta</title>
<link rel="icon" href="data:,">
<style>html,body{height:100%;margin:0;background:#0a0a0a}#office{width:100vw;height:100vh}</style></head><body><section id="office"></section>
<script>
(function () {
  const T0 = Date.now(), ouv = {}, mapa = new Map(), copia = (o) => JSON.parse(JSON.stringify(o));
  const sess = (o) => Object.assign({ id: '', status: 'trabalhando', desde: T0, titulo: '', apelido: '', projeto: 'Orbit', cwd: 'D:\\\\x', tarefa: '', primeira: '',
    detalhe: '', ferramenta: null, agentes: [], subagentes: 0, pai: null, vivo: true, atividade: T0, nome: '', controle: null }, o);
  mapa.set('m1', sess({ id: 'm1', nome: 'm-lider', titulo: 'Lider do time', status: 'trabalhando', ferramenta: { nome: 'Read', alvo: 'D:/x/plano.md' } }));
  const dep = (id, primeira) => mapa.set(id, sess({ id, pai: 'm1', nome: 'm-' + id, titulo: '', primeira, status: 'concluido' }));
  dep('d1', 'Rode a fumaca e verifique os testes');
  dep('d2', 'Pesquise referencias do pathfinding');
  dep('d3', 'Ajuste a rota do servidor');
  dep('d4', 'Ajuste o layout da pagina');
  const emitir = (s) => (ouv.sessao || []).forEach((f) => f(copia(s)));
  window.__alterar = (id, campos) => { const s = mapa.get(id); for (const k in campos) { if (campos[k] === null) delete s[k]; else s[k] = campos[k]; } s.atividade = Date.now(); emitir(s); };
  window.GerenciadorAPI = {
    sessoes: () => [...mapa.values()].map(copia), sessao: (id) => (mapa.has(id) ? copia(mapa.get(id)) : null),
    eventos: async (id) => ({ sessao: mapa.get(id) || null, eventos: [] }), uso: () => null, config: () => ({}),
    on: (t, fn) => { (ouv[t] = ouv[t] || []).push(fn); return () => {}; }, selecionada: () => null, abrirSessao: () => {},
  };
  window.__robo = (nome) => Office._debug().robos.find((r) => r.nome === nome) || null;
  // Gravador por quadro: posição lógica, visual, opacidade e a fase das conversas.
  window.__gravar = (nomes) => {
    window.__log = [];
    const f = () => {
      const d = Office._debug();
      window.__log.push({ conv: d.interacoes.filter((i) => i.fase === 'conversa').map((i) => [i.v, i.h]),
        r: Object.fromEntries(nomes.map((n) => { const r = d.robos.find((x) => x.nome === n); return [n, r ? { c: r.celula, v: r.visual, a: r.alfa, d: r.dentro, e: r.estacao, an: r.andando } : null]; })) });
      if (window.__rec) requestAnimationFrame(f);
    };
    window.__rec = true; f();
  };
  window.__parar = () => { window.__rec = false; return window.__log; };
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/assets/office.css'; document.head.appendChild(css);
  const js = document.createElement('script'); js.src = '/assets/office.js';
  js.onload = () => {
    window.Office.CONFIG.velocidade = 20; window.Office.CONFIG.conversaMs = 900; window.Office.CONFIG.respostaMs = 200;
    const m = () => window.Office.montar(document.getElementById('office'), window.GerenciadorAPI);
    css.sheet ? m() : css.addEventListener('load', m);
  };
  document.head.appendChild(js);
})();
</script></body></html>`;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__office-porta.html') { res.writeHead(200, { 'content-type': TIPOS['.html'] }); res.end(PAGINA); return; }
  const arq = path.normalize(path.join(PASTA, decodeURIComponent(u.pathname)));
  if (!arq.startsWith(PASTA) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(arq).pipe(res);
});

let edge = null, dbg = 0, perfil = '', ws, seq = 0, PORTA = 0;
const pend = new Map();
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
async function esperar(expr, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await avaliar(`!!(${expr})`).catch(() => false)) return true; await dormir(50); }
  return false;
}
const alt = (id, campos) => avaliar(`__alterar(${JSON.stringify(id)}, ${JSON.stringify(campos)})`);
const robo = (nome) => avaliar(`__robo(${JSON.stringify(nome)})`);
async function foto(nome) {
  if (!SAIDA) return;
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
}
// Elementos do robô e do ícone de estado de um agente (pela ordem do _debug, que é a ordem de criação do DOM).
const DOM = (nome) => `(() => {
  const d = Office._debug(), i = d.robos.findIndex((r) => r.nome === ${JSON.stringify(nome)});
  const b = document.querySelectorAll('.of-ator')[i], c = document.querySelectorAll('.of-icone')[i];
  const cs = getComputedStyle(b), cc = getComputedStyle(c), rc = c.getBoundingClientRect(), rp = document.querySelector('.of-palco').getBoundingClientRect();
  return { robo: { vis: cs.visibility, pe: cs.pointerEvents, dentro: b.classList.contains('of-dentro') },
    cracha: { vis: c.hidden ? 'hidden' : cc.visibility, dentro: c.classList.contains('of-dentro'), x: rc.left + rc.width / 2, y: rc.top + rc.height / 2,
      caixa: { x: rc.left - rp.left, y: rc.top - rp.top, w: rc.width, h: rc.height } } };
})()`;
const PORTA_DE = (nome) => `(() => {
  const d = Office._debug(), r = d.robos.find((x) => x.nome === ${JSON.stringify(nome)});
  const a = Office.CONFIG.areas.find((q) => q.estacoes.some((e) => e.x === r.estacao[0] && e.y === r.estacao[1]));
  return a && a.porta ? [a.porta.x, a.porta.y] : null;
})()`;

async function abrir() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORTA}/__office-porta.html` });
  await esperar('window.Office && document.querySelectorAll(".of-ator").length >= 5', 20000);
  await esperar("Office._debug().mapa === 'vila'", 8000);
}

try {
  PORTA = await escolherPorta(Number(process.env.OFFICE_PORTA) || 47824); // faixa 47822–47826, nunca a 47821
  await new Promise((r, j) => servidor.listen(PORTA, '127.0.0.1', r).on('error', j));
  dbg = 9600 + Math.floor(Math.random() * 150);
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-office-porta-'));
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${perfil}`, '--no-first-run',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 80 && !alvo; i++) {
    try { alvo = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!alvo) await dormir(200);
  }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert')) consoleErros.push('console: ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  globalThis.__frente = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1500);

  // ── 1) quem já trabalha ao abrir começa dentro ──
  await abrir();
  conferir(await esperar("__robo('Mestre') && __robo('Mestre').dentro", 6000), 'abertura: o Mestre (trabalhando) já está dentro da Guilda');
  const m0 = await robo('Mestre');
  conferir(m0.celula[0] === m0.estacao[0] && m0.celula[1] === m0.estacao[1], 'abertura: a posição lógica do Mestre continua na estação');
  const dm = await avaliar(DOM('Mestre'));
  conferir(dm.robo.vis === 'hidden' && dm.robo.pe === 'none' && dm.robo.dentro, 'abertura: o robô do Mestre some e não recebe clique');
  conferir(dm.cracha.vis === 'visible' && dm.cracha.dentro, 'abertura: o ícone de estado do Mestre fica visível, com a marca de dentro');
  // o ícone de quem está dentro fica na trilha, abaixo da porta: não cobre fachada nem porta
  const guilda = (await avaliar('Office._debug().casasPx')).find((c) => c.id === 'guild');
  const ci = dm.cracha.caixa;
  conferir(guilda && ci.y >= guilda.y + guilda.h - 0.5 && Math.abs(ci.x + ci.w / 2 - guilda.porta) < ci.w * 2, 'abertura: o ícone do Mestre fica logo abaixo da porta da Guilda, sem cobrir a casa (' + JSON.stringify({ ci, guilda }) + ')');
  conferir(await avaliar("document.querySelectorAll('.of-balao.of-vis').length === 0"), 'abertura: sem hover nem clique, nenhum balão aberto (só o ícone)');
  conferir(await avaliar("![...document.querySelectorAll('.of-rotulos *, .of-areas *')].some((e) => /^(of-cracha|of-nome)$/.test(e.className))"), 'abertura: sem a etiqueta de nome embaixo do agente');
  // ícone abre o cartão e o balão (com o nome dentro)
  await avaliar(`(() => { const d = Office._debug(), i = d.robos.findIndex((r) => r.nome === 'Mestre'); document.querySelectorAll('.of-icone')[i].click(); })()`);
  conferir(await avaliar("!document.querySelector('.of-cartao').hidden && document.querySelector('.of-cartao .of-c-tit b').textContent === 'Mestre'"), 'abertura: o ícone na porta abre o cartão do Mestre');
  conferir(await esperar("(() => { const b = document.querySelector('.of-balao.of-vis'); return !!b && /^Mestre\\./.test(b.querySelector('.of-sr').textContent); })()", 3000), 'abertura: o clique abre o balão, com o nome dentro');
  await avaliar("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await foto('porta-abertura');

  // ── 5) estilo do balão: pixel art em canvas, escala inteira, sem raio nem sombra borrada ──
  const est = await avaliar(`(async () => { const d0 = Office._debug(), i0 = d0.robos.findIndex((r) => r.nome === 'Mestre'); document.querySelectorAll('.of-icone')[i0].click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = document.querySelector('.of-balao.of-vis'); if (!b) return null; const c = b.querySelector('canvas.of-px'), s = getComputedStyle(b), cs = getComputedStyle(c);
    const u = Office._debug().pixel.u, m = new DOMMatrix(s.transform), rp = document.querySelector('.of-palco').getBoundingClientRect(), dpr = devicePixelRatio;
    const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let tons = new Set(); for (let i = 0; i < g.length; i += 4) if (g[i + 3]) tons.add(g[i] + ',' + g[i + 1] + ',' + g[i + 2]);
    return { raio: s.borderTopLeftRadius, sombra: s.boxShadow, render: cs.imageRendering, larg: parseFloat(cs.width), arte: c.width, u, k: u * dpr,
      x: (m.m41 + rp.left) * dpr, y: (m.m42 + rp.top) * dpr, alfaMeio: [...g].filter((v, i) => i % 4 === 3 && v > 0 && v < 255).length, tons: tons.size, largura: c.width }; })()`);
  conferir(est && est.raio === '0px' && est.sombra === 'none', 'balão: sem cantos arredondados nem sombra (' + JSON.stringify(est && [est.raio, est.sombra]) + ')');
  conferir(est && est.render === 'pixelated' && Math.abs(est.k - Math.round(est.k)) < 1e-6 && Math.abs(est.larg - est.arte * est.u) < 0.01, 'balão: canvas em escala inteira de pixels, sem suavizar (' + JSON.stringify(est) + ')');
  conferir(est && Math.abs(est.x - Math.round(est.x)) < 0.01 && Math.abs(est.y - Math.round(est.y)) < 0.01, 'balão: posto em pixel inteiro do aparelho');
  conferir(est && est.alfaMeio === 0 && est.tons <= 12, 'balão: pixels opacos e paleta curta (fonte bitmap, sem antialias): ' + (est && est.tons) + ' tons');
  conferir(est && est.largura <= 132 + 10 + 3, 'balão: largura limitada (' + (est && est.largura) + ' px de arte)');
  await avaliar("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

  // ── 2 e 3) Frontend começa a trabalhar: anda até a porta e some; o Mestre sai para a conversa ──
  await avaliar("__gravar(['Frontend', 'Mestre'])");
  await alt('d4', { status: 'trabalhando', ferramenta: { nome: 'Edit', alvo: 'D:/x/index.html' } });
  const entrou = await esperar("__robo('Frontend').dentro && Office._debug().interacoes.length === 0 && __robo('Mestre').dentro", 25000);
  const log1 = await avaliar('__parar()');
  conferir(entrou, 'trabalhando: o Frontend entra na Taverna e o Mestre volta para a Guilda depois da conversa');
  const fr = await robo('Frontend');
  conferir(fr.celula[0] === fr.estacao[0] && fr.celula[1] === fr.estacao[1], 'trabalhando: a posição lógica do Frontend fica na estação');
  const porta = await avaliar(PORTA_DE('Frontend'));
  conferir(porta && Math.abs(fr.visual[0] - porta[0]) < 0.05 && Math.abs(fr.visual[1] - (porta[1] - 0.45)) < 0.05, 'trabalhando: o robô some na soleira da porta da Taverna');
  // sem salto: a posição visual anda no máximo ~1 célula por quadro e a opacidade só desce enquanto entra
  let salto = 0;
  for (let i = 1; i < log1.length; i++) {
    const p = log1[i - 1].r.Frontend, q = log1[i].r.Frontend;
    if (p && q && p.v && q.v) salto = Math.max(salto, Math.hypot(q.v[0] - p.v[0], q.v[1] - p.v[1]));
  }
  conferir(salto < 1.2, `trabalhando: sem salto na posição visual (maior passo ${salto.toFixed(2)} célula)`);
  const fases = log1.map((l) => l.r.Frontend).filter((x) => x && x.c[0] === fr.estacao[0] && x.c[1] === fr.estacao[1] && !x.an);
  const meio = fases.filter((x) => x.a > 0 && x.a < 1).length;
  conferir(meio >= 3, `trabalhando: some aos poucos (${meio} quadros entre visível e dentro)`);
  // conversa: durante toda a troca, quem conversa está fora (opacidade 1)
  const convs = log1.filter((l) => l.conv.length);
  const visiveis = convs.every((l) => l.conv.every(([v, h]) => (!l.r[v] || l.r[v].a === 1) && (!l.r[h] || l.r[h].a === 1)));
  conferir(convs.length > 0 && visiveis, `conversa: os dois ficam fora da casa durante a troca (${convs.length} quadros de conversa)`);
  const mestreSaiu = log1.some((l) => l.r.Mestre && l.r.Mestre.a === 1) && log1.some((l) => l.r.Mestre && l.r.Mestre.a === 0);
  conferir(mestreSaiu, 'conversa: o Mestre sai da Guilda para receber o Frontend e volta');
  await foto('porta-dentro');

  // ── 4) terminou: surge na porta antes de andar e chega ao descanso visível ──
  await avaliar("__gravar(['Frontend'])");
  await alt('d4', { status: 'concluido', ferramenta: null });
  const descansou = await esperar("(() => { const r = __robo('Frontend'); return r.lugar && r.celula[0] === r.lugar[0] && r.celula[1] === r.lugar[1] && !r.andando; })()", 25000);
  const log2 = await avaliar('__parar()');
  conferir(descansou, 'terminou: o Frontend chega ao descanso');
  const fora = log2.filter((l) => l.r.Frontend && (l.r.Frontend.c[0] !== fr.estacao[0] || l.r.Frontend.c[1] !== fr.estacao[1]));
  conferir(fora.length > 0 && fora.every((l) => l.r.Frontend.a === 1 && !l.r.Frontend.d), 'terminou: só anda depois de surgir na porta (opacidade 1 fora da estação)');
  conferir(log2.some((l) => l.r.Frontend && l.r.Frontend.a > 0 && l.r.Frontend.a < 1), 'terminou: surge aos poucos na porta');
  const df = await avaliar(DOM('Frontend'));
  conferir(df.robo.vis === 'visible' && df.robo.pe !== 'none' && !df.cracha.dentro, 'terminou: robô visível e clicável no descanso, ícone sem a marca de dentro');

  // ── pausar/retomar com alguém dentro ──
  await avaliar('Office.pausar()'); await dormir(300); await avaliar('Office.retomar()'); await dormir(600);
  conferir((await robo('Mestre')).dentro, 'pausar/retomar: o Mestre continua dentro');

  // ── 6) movimento reduzido: entra e sai sem animação ──
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await abrir();
  await avaliar("__gravar(['Backend'])");
  await alt('d3', { status: 'trabalhando', ferramenta: { nome: 'Edit', alvo: 'D:/x/servidor.mjs' } });
  const red = await esperar("__robo('Backend').dentro", 30000);
  const log3 = await avaliar('__parar()');
  conferir(red, 'reduzido: o Backend entra na Forja');
  conferir(!log3.some((l) => l.r.Backend && l.r.Backend.a > 0 && l.r.Backend.a < 1), 'reduzido: sem quadros intermediários de opacidade');
  await foto('porta-reduzido');
  await cdp('Emulation.setEmulatedMedia', { features: [] });

  conferir(consoleErros.length === 0, 'sem erros de console' + (consoleErros.length ? ': ' + consoleErros.slice(0, 3).join(' | ') : ''));
} catch (e) {
  falhas.push('exceção: ' + (e.stack || e));
  console.log('FALHA exceção: ' + (e.stack || e));
} finally {
  clearInterval(globalThis.__frente);
  try { ws?.close(); } catch {}
  if (dbg) await fecharEdge(dbg, perfil);
  try { edge?.kill(); } catch {}
  servidor.close();
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
}
console.log(`\n${falhas.length ? 'FALHOU' : 'ok'}: ${falhas.length} falha(s).`);
process.exit(falhas.length ? 1 : 0);
