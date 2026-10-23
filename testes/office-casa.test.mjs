// Teste do balão da casa (interior) da Visão de Office, com Edge headless + CDP.
// node testes/office-casa.test.mjs [pasta-de-saida]
// Sobe um servidor estático da pasta inteira (porta OFFICE_PORTA, padrão 47825), abre testes/office-demo.html e confere:
//  1) mouse parado sobre cada casa abre o balão depois da espera (não antes); sair fecha; passar direto não abre;
//  2) o balão fica inteiro dentro do palco em 1440×900, 1024×700 e 640×480 (casas de canto incluídas);
//  3) os agentes do balão são os que têm estação na casa, com o estado ao vivo;
//  4) o interior só é desenhado com o balão aberto; pausar fecha e para; desmontar tira o balão;
//  5) toque: tocar na casa abre, tocar fora fecha; o clique na casa continua fechando o cartão do agente;
//  6) sem as folhas do interior, a cena sai em blocos de cor e os agentes continuam; zero erros de console.
// Imprime um resumo JSON; sai 1 se falhar.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'gerenciador-office-casa'));
fs.mkdirSync(SAIDA, { recursive: true });
const EDGE = caminhoNavegador();
const PORTA = await escolherPorta(Number(process.env.OFFICE_PORTA) || 47825); // faixa 47822–47826, nunca a 47821
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const resumo = { porta: PORTA, saida: SAIDA, console: [], casas: {}, bordas: {}, capturas: {} };

// ── servidor estático mínimo ──
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const arq = path.normalize(path.join(PASTA, decodeURIComponent(u.pathname)));
  if (!arq.startsWith(PASTA) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(arq).pipe(res);
});
await new Promise((r, j) => servidor.listen(PORTA, '127.0.0.1', r).on('error', j));
const BASE = `http://127.0.0.1:${PORTA}/testes/office-demo.html`;

// ── Edge + CDP ──
const dbg = 9800 + Math.floor(Math.random() * 150);
const perfil = path.join(SAIDA, 'edge-office-casa-' + dbg);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${perfil}`, '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0, frente = null;
const pend = new Map();
async function conectar() {
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
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert')) resumo.console.push('console: ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') resumo.console.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') resumo.console.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
}
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
const mover = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
async function clicar(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
}
async function tocar(x, y) {
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await dormir(40);
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function foto(nome) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const arq = path.join(SAIDA, nome + '.png');
  fs.writeFileSync(arq, Buffer.from(r.result.data, 'base64'));
  resumo.capturas[nome] = arq;
}
async function abrir(w, h, consulta = '', toque = false) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: toque });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: toque, maxTouchPoints: toque ? 5 : 1 });
  await cdp('Page.navigate', { url: BASE + consulta });
  for (let i = 0; i < 50; i++) { if (await avaliar('!!(window.Office && document.querySelector(".of-ator"))').catch(() => false)) break; await dormir(100); }
  for (let i = 0; i < 40 && (await avaliar('Office._debug().mapa')) !== 'vila'; i++) await dormir(100);
  await dormir(1500); // os robôs chegam às estações
}

// Centro de cada casa em px da página, a partir do CONFIG (células) e do palco.
const CASAS = `(() => {
  const p = document.querySelector('.of-palco').getBoundingClientRect(), d = Office._debug(), c = d.celula;
  return Office.CONFIG.areas.filter((a) => a.vila).map((a) => ({ id: a.id, vila: a.vila, casa: a.casa,
    x: p.left + (a.x + a.w / 2) * c, y: p.top + (a.y + a.h * 0.55) * c,
    est: a.estacoes.map((e) => e.x + ',' + e.y) }));
})()`;
// Balão inteiro dentro do palco (moldura e rabicho) e os agentes esperados (estação na casa) com estado coerente.
const CONFERIR = (est) => `(() => {
  const d = Office._debug(), b = d.casa; if (!b) return null;
  const p = document.querySelector('.of-palco').getBoundingClientRect();
  const r = [document.querySelector('.of-casa-caixa'), document.querySelector('.of-casa-ponta')].map((e) => e.getBoundingClientRect());
  const dentro = r.every((q) => q.left >= p.left - 0.5 && q.top >= p.top - 0.5 && q.right <= p.right + 0.5 && q.bottom <= p.bottom + 0.5);
  const est = ${JSON.stringify(est)};
  const esperados = d.robos.filter((q) => !q.saindo && q.estacao && est.includes(q.estacao.join(','))).map((q) => q.id).sort();
  const vistos = b.agentes.map((a) => a.id).sort();
  const coerente = b.agentes.every((a) => { const q = d.robos.find((x) => x.id === a.id); if (!q) return false;
    if (q.dormindo) return a.estado === 'dormindo';
    return ({ trabalhando: ['trabalhando', 'pensando'], ocioso: ['ocioso'], aguardando: ['aguardando'], erro: ['erro'] })[q.estado].includes(a.estado); });
  return { id: b.id, nome: b.nome, func: b.func, lado: b.lado, dentro, interior: b.interior, esperados, vistos, coerente,
    agentes: b.agentes.map((a) => a.nome + ' · ' + a.texto), vazia: !document.querySelector('.of-casa-vazia').hidden };
})()`;
const casaAberta = () => avaliar('Office._debug().casa && Office._debug().casa.id');

try {
  await conectar();
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  frente = setInterval(() => { cdp('Page.bringToFront'); }, 1500);

  // 1) 1440×900: cada casa, com espera, conferência e captura
  await abrir(1440, 900);
  const vazio = { x: 0, y: 0 };
  const pal = await avaliar(`(() => { const p = document.querySelector('.of-palco').getBoundingClientRect(); return { l: p.left, t: p.top, r: p.right, b: p.bottom }; })()`);
  vazio.x = pal.l + 10; vazio.y = pal.b - 10; // canto da floresta, fora das casas
  const casas = await avaliar(CASAS);
  for (const c of casas) {
    await mover(vazio.x, vazio.y); await dormir(120);
    await mover(c.x, c.y);
    await dormir(90);
    const cedo = await casaAberta();
    await dormir(260);
    let info = await avaliar(CONFERIR(c.est));
    for (let i = 0; i < 30 && (!info || info.interior !== 'vila'); i++) { await dormir(100); info = await avaliar(CONFERIR(c.est)); }
    resumo.casas[c.id] = { cedo: !!cedo, ...info };
    if (cedo) falhas.push(`${c.id}: o balão abriu antes da espera`);
    if (!info || info.id !== c.id) { falhas.push(`${c.id}: o balão não abriu com o mouse parado`); continue; }
    if (!info.dentro) falhas.push(`${c.id}: o balão passa da borda do palco (1440)`);
    if (info.interior !== 'vila') falhas.push(`${c.id}: interior não carregou (${info.interior})`);
    if (JSON.stringify(info.esperados) !== JSON.stringify(info.vistos)) falhas.push(`${c.id}: agentes do balão ${info.vistos} ≠ esperados ${info.esperados}`);
    if (!info.coerente) falhas.push(`${c.id}: estado de algum agente não bate com o mapa`);
    if (!info.nome || !info.func) falhas.push(`${c.id}: sem nome ou função no topo`);
    await foto('casa-1440-' + c.vila);
  }
  // sair da casa fecha
  await mover(vazio.x, vazio.y); await dormir(80);
  if (await casaAberta()) falhas.push('o balão não fechou ao sair da casa');

  // 2) passar direto: atravessa a Guilda em passos de 25 ms, sem parar (nunca abre)
  const gu = casas.find((c) => c.vila === 'guild');
  let piscou = false;
  for (let i = -6; i <= 6; i++) {
    await mover(gu.x + i * 14, gu.y);
    await dormir(25);
    if (await casaAberta()) piscou = true;
  }
  await mover(vazio.x, vazio.y); await dormir(300);
  if (piscou || (await casaAberta())) piscou = true;
  resumo.passarDireto = { abriu: piscou };
  if (piscou) falhas.push('passar o mouse direto pela casa abriu o balão');

  // 3) desempenho: fechado não desenha; aberto desenha
  const d0 = await avaliar('Office._debug().casaDesenhos'); await dormir(1000);
  const d1 = await avaliar('Office._debug().casaDesenhos');
  await mover(gu.x, gu.y); await dormir(400);
  const d2 = await avaliar('Office._debug().casaDesenhos'); await dormir(1000);
  const d3 = await avaliar('Office._debug().casaDesenhos');
  resumo.desenhos = { fechadoPor1s: d1 - d0, abertoPor1s: d3 - d2 };
  if (d1 !== d0) falhas.push('o interior foi desenhado com o balão fechado');
  if (d3 - d2 < 3) falhas.push('o interior não anima com o balão aberto');
  // 4) pausar fecha e para de desenhar; retomar não reabre; desmontar tira o balão
  resumo.pausa = await avaliar(`(async () => {
    const aberto = !!Office._debug().casa; Office.pausar();
    const a = Office._debug().casaDesenhos; await new Promise((r) => setTimeout(r, 600)); const b = Office._debug().casaDesenhos;
    const fechou = !Office._debug().casa && !document.querySelector('.of-casa.of-vis');
    Office.retomar(); await new Promise((r) => setTimeout(r, 300));
    return { aberto, fechou, parou: a === b, reabriu: !!Office._debug().casa };
  })()`);
  if (!resumo.pausa.aberto || !resumo.pausa.fechou || !resumo.pausa.parou || resumo.pausa.reabriu) falhas.push('pausar/retomar com o balão aberto: ' + JSON.stringify(resumo.pausa));
  // clique na casa continua fazendo o de sempre (fecha o cartão do agente) e o balão não atrapalha
  // (o ícone de estado: o robô de quem trabalha pode estar dentro da casa, sem clique)
  const robo = await avaliar(`(() => { const b = document.querySelector('.of-icone:not([hidden])').getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, e = document.elementFromPoint(x, y); return { x, y, alvo: e ? e.className + '' : '' }; })()`);
  await clicar(robo.x, robo.y); await dormir(300);
  const cartaoAntes = await avaliar('!document.querySelector(".of-cartao").hidden');
  const tor = casas.find((c) => c.vila === 'tower');
  await mover(tor.x, tor.y); await dormir(400);
  await clicar(tor.x, tor.y); await dormir(300);
  resumo.cliqueNaCasa = { alvo: robo.alvo, cartaoAntes, cartaoDepois: await avaliar('!document.querySelector(".of-cartao").hidden'), balao: await casaAberta() };
  if (!cartaoAntes || resumo.cliqueNaCasa.cartaoDepois) falhas.push('o clique na casa deixou de fechar o cartão do agente');
  await mover(vazio.x, vazio.y); await dormir(100);

  // 5) bordas: todas as casas em 1024×700 e 640×480 (palco pequeno)
  for (const [w, h] of [[1024, 700], [640, 480]]) {
    await abrir(w, h);
    const cs = await avaliar(CASAS);
    const ruins = [], lados = {};
    for (const c of cs) {
      await mover(4, 4); await dormir(60);
      await mover(c.x, c.y); await dormir(250);
      let info = await avaliar(CONFERIR(c.est));
      for (let i = 0; i < 12 && (!info || info.id !== c.id); i++) { await dormir(100); info = await avaliar(CONFERIR(c.est)); } // headless pode atrasar o timer
      if (!info || info.id !== c.id) {
        const sob = await avaliar(`(() => { const e = document.elementFromPoint(${c.x}, ${c.y}); return (e && e.className) + ' · aberto=' + (Office._debug().casa && Office._debug().casa.id); })()`);
        ruins.push(c.id + ':não abriu (' + sob + ')'); continue;
      }
      lados[c.id] = info.lado;
      if (!info.dentro) ruins.push(c.id + ':fora');
      if (c.vila === 'tower' || c.vila === 'hut') await foto(`casa-${w}-${c.vila}`);
    }
    resumo.bordas[w + 'x' + h] = { lados, ruins };
    if (ruins.length) falhas.push(`${w}×${h}: ${ruins.join(', ')}`);
  }
  // desmontar tira o balão
  resumo.desmontar = await avaliar(`(() => { const el = document.querySelector('.of-raiz').parentElement; Office.desmontar(); const sobrou = !!document.querySelector('.of-casa'); Office.montar(el); return { sobrou, depois: !!Office._debug().casa }; })()`);
  if (resumo.desmontar.sobrou || resumo.desmontar.depois) falhas.push('desmontar deixou o balão');

  // 6) toque (PWA): tocar na casa abre, tocar em outra troca, tocar fora fecha
  await abrir(820, 1180, '', true);
  const ct = await avaliar(CASAS);
  const t1 = ct.find((c) => c.vila === 'forge'), t2 = ct.find((c) => c.vila === 'tavern');
  const palT = await avaliar(`(() => { const p = document.querySelector('.of-palco').getBoundingClientRect(); return { l: p.left, b: p.bottom }; })()`);
  await tocar(t1.x, t1.y); await dormir(250);
  const toque1 = await avaliar('Office._debug().casa');
  await tocar(t2.x, t2.y); await dormir(250);
  const toque2 = await avaliar('Office._debug().casa');
  const info2 = await avaliar(CONFERIR(t2.est));
  await foto('casa-toque-taverna');
  await tocar(palT.l + 8, palT.b - 8); await dormir(250);
  const toque3 = await avaliar('Office._debug().casa');
  resumo.toque = { abriu: toque1 && toque1.id, toque: toque1 && toque1.toque, trocou: toque2 && toque2.id, dentro: info2 && info2.dentro, fechou: !toque3 };
  if (!toque1 || toque1.id !== t1.id || !toque1.toque) falhas.push('toque na casa não abriu o balão');
  if (!toque2 || toque2.id !== t2.id) falhas.push('toque em outra casa não trocou o balão');
  if (info2 && !info2.dentro) falhas.push('toque: balão fora do palco');
  if (toque3) falhas.push('toque fora da casa não fechou o balão');

  // 7) sem as folhas do interior: blocos de cor, com os agentes; volta ao remontar
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs', { urls: ['*/assets/vila/iwalls.png'] });
  const errosAntes = resumo.console.length;
  await abrir(1440, 900);
  const cf = (await avaliar(CASAS)).find((c) => c.vila === 'guild');
  await mover(cf.x, cf.y); await dormir(400);
  let fb = await avaliar(CONFERIR(cf.est));
  for (let i = 0; i < 20 && fb && fb.interior === 'carregando'; i++) { await dormir(100); fb = await avaliar(CONFERIR(cf.est)); }
  resumo.fallback = fb;
  await foto('casa-fallback-guilda');
  resumo.console = resumo.console.filter((e, i) => i < errosAntes || !e.includes('ERR_BLOCKED_BY_CLIENT'));
  if (!fb || fb.interior !== 'simples' || JSON.stringify(fb.esperados) !== JSON.stringify(fb.vistos)) falhas.push('fallback do interior incompleto: ' + JSON.stringify(fb && { interior: fb.interior, vistos: fb.vistos }));
  await cdp('Network.setBlockedURLs', { urls: [] });
  await abrir(1440, 900);
  await mover(cf.x, cf.y); await dormir(400);
  let rc = null;
  for (let i = 0; i < 30; i++) { rc = await avaliar('Office._debug().casa && Office._debug().casa.interior'); if (rc === 'vila') break; await dormir(100); }
  resumo.recuperou = rc;
  if (rc !== 'vila') falhas.push('o interior não voltou depois da falha de rede');
} catch (e) {
  falhas.push('teste: ' + (e?.stack || e));
} finally {
  if (resumo.console.length) falhas.push(resumo.console.length + ' erro(s) de console');
  resumo.falhas = falhas;
  resumo.ok = falhas.length === 0;
  clearInterval(frente);
  try { ws?.close(); } catch {}
  await fecharEdge(dbg, perfil);
  servidor.close();
  console.log(JSON.stringify(resumo, null, 2));
  setTimeout(() => process.exit(falhas.length ? 1 : 0), 300);
}
