// Teste da Visão de Office com Edge headless + CDP.
// node testes/office.test.mjs [pasta-de-saida]
// Sobe um servidor estático da pasta inteira (porta OFFICE_PORTA, padrão 47826), abre
// testes/office-demo.html (API falsa com roteiro) e confere:
//  1) zero erros de console; 2) 30 s de amostras a cada 100 ms: robô nunca em célula
//  bloqueada nem salto > 1 célula; rótulos sem sobreposição; balões ≤ 60 caracteres;
//  3) tecla F liga/desliga a tela cheia; 4) capturas 1440×900 e 1024×700, normal e cheia;
//  5) clique num robô abre o cartão (Esc fecha). Imprime um resumo JSON; sai 1 se falhar.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'gerenciador-office'));
fs.mkdirSync(SAIDA, { recursive: true });
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const PORTA = Number(process.env.OFFICE_PORTA || 47826);
const AMOSTRA_S = Number(process.env.OFFICE_AMOSTRA_S || 30);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const resumo = { porta: PORTA, saida: SAIDA, console: [], amostras: null, demo: null, telaCheia: {}, cartao: null, capturas: {} };

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
const perfil = path.join(SAIDA, 'edge-office-' + dbg);
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
async function tecla(key) {
  const vk = { Escape: 27, f: 70, F: 70 }[key] || key.toUpperCase().charCodeAt(0);
  const base = { key, code: key === 'Escape' ? 'Escape' : 'Key' + key.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : undefined });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function clicar(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}
async function foto(nome) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const arq = path.join(SAIDA, nome + '.png');
  fs.writeFileSync(arq, Buffer.from(r.result.data, 'base64'));
  resumo.capturas[nome] = arq;
  return arq;
}
async function abrir(w, h, consulta = '') {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + consulta });
  for (let i = 0; i < 50; i++) { if (await avaliar('!!(window.Office && document.querySelector(".of-ator"))').catch(() => false)) break; await dormir(100); }
  await dormir(600);
}

// Amostrador dentro da página (não sofre com a latência do CDP).
const AMOSTRADOR = `(() => {
  window.__am = []; clearInterval(window.__amT);
  window.__amT = setInterval(() => {
    const d = Office._debug();
    window.__am.push({ t: performance.now(), r: d.robos.map((r) => [r.id, r.x, r.y]), rot: d.rotulos.map((q) => [q.tipo, q.x, q.y, q.w, q.h, q.texto || '']) });
  }, 100);
  return Office._debug().caminhavel;
})()`;

function analisar(grade, am) {
  const r = { amostras: am.length, lacunas: 0, robosVistos: 0, foraDoCaminho: 0, saltos: 0, maiorSalto: 0, maiorIntervaloMs: 0, distanciaTotal: 0,
    sobreposicoes: 0, piorSobreposicaoPx2: 0, baloes: 0, balaoMaisLongo: 0, exemplos: [] };
  const ult = new Map(), ids = new Set();
  let tAnt = null;
  for (const s of am) {
    if (tAnt != null) { r.maiorIntervaloMs = Math.max(r.maiorIntervaloMs, Math.round(s.t - tAnt)); if (s.t - tAnt > 400) r.lacunas++; }
    tAnt = s.t;
    for (const [id, x, y] of s.r) {
      ids.add(id);
      const cx = Math.floor(x), cy = Math.floor(y);
      if (grade[cy]?.[cx] !== '1') { r.foraDoCaminho++; if (r.exemplos.length < 5) r.exemplos.push(`fora: ${id} (${x.toFixed(2)},${y.toFixed(2)})`); }
      const p = ult.get(id);
      if (p) {
        const salto = Math.max(Math.abs(x - p[0]), Math.abs(y - p[1]));
        r.maiorSalto = Math.max(r.maiorSalto, salto);
        r.distanciaTotal += Math.hypot(x - p[0], y - p[1]);
        if (salto > 1.0001) { r.saltos++; if (r.exemplos.length < 5) r.exemplos.push(`salto: ${id} ${salto.toFixed(2)}`); }
      }
      ult.set(id, [x, y]);
    }
    for (let i = 0; i < s.rot.length; i++) {
      const a = s.rot[i];
      if (a[0] === 'balao') { r.baloes++; r.balaoMaisLongo = Math.max(r.balaoMaisLongo, a[5].length); }
      for (let j = i + 1; j < s.rot.length; j++) {
        const b = s.rot[j];
        const ix = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
        const iy = Math.min(a[2] + a[4], b[2] + b[4]) - Math.max(a[2], b[2]);
        if (ix > 1 && iy > 1) { r.sobreposicoes++; r.piorSobreposicaoPx2 = Math.max(r.piorSobreposicaoPx2, Math.round(ix * iy)); }
      }
    }
  }
  r.robosVistos = ids.size;
  r.maiorSalto = +r.maiorSalto.toFixed(3);
  r.distanciaTotal = +r.distanciaTotal.toFixed(1);
  return r;
}

async function telaCheia(rotulo, nome) {
  const ligada = 'document.fullscreenElement === document.querySelector(".of-raiz") || document.querySelector(".of-raiz").classList.contains("of-cheia")';
  await tecla('f'); await dormir(700);
  const on = await avaliar(ligada);
  const nativa = await avaliar('!!document.fullscreenElement');
  await foto(nome);
  await tecla('f'); await dormir(600);
  const off = await avaliar(ligada);
  resumo.telaCheia[rotulo] = { ligou: on, nativa, desligou: !off };
  if (!on || off) falhas.push(`tecla F (${rotulo}): ligou=${on} desligou=${!off}`);
}

try {
  await conectar();
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  // O Edge headless no Windows marca a página como oculta depois de ~15 s (o rAF para e a
  // Visão de Office pausa, como deve). Trazer a aba para a frente a cada 1,5 s mantém 60 fps.
  frente = setInterval(() => { cdp('Page.bringToFront'); }, 1500);

  // 1440×900 — dados "reais" da API falsa
  await abrir(1440, 900);
  resumo.fundo = await avaliar(`(() => ({
    carregado: document.querySelector('.of-palco').style.backgroundImage.includes('fundo.png'),
    telas: document.querySelectorAll('.of-vidro').length,
    mesasSvg: document.querySelectorAll('.of-mesa').length,
    fios: document.querySelectorAll('.of-fio-cor').length,
    decoracoes: Office.CONFIG.areas.flatMap(a => a.moveis).filter(m => m.tipo === 'deco').length
  }))()`);
  if (!resumo.fundo.carregado || resumo.fundo.telas !== 16 || resumo.fundo.mesasSvg !== 0 || resumo.fundo.fios !== 6 || resumo.fundo.decoracoes !== 10) falhas.push('fundo ou camadas dinâmicas incorretos');
  await foto('office-1440-inicio');
  const grade = await avaliar(AMOSTRADOR);
  for (let s = 0; s < AMOSTRA_S; s += 5) {
    await dormir(5000);
    if (s === 5 || s === 15 || s === 20) await foto(`office-1440-t${s + 5}`);
  }
  const am = await avaliar('window.__am');
  resumo.amostras = analisar(grade, am);
  const a = resumo.amostras;
  if (a.foraDoCaminho) falhas.push(`robô fora do caminho em ${a.foraDoCaminho} amostras`);
  if (a.saltos) falhas.push(`${a.saltos} saltos > 1 célula`);
  if (a.distanciaTotal < 20) falhas.push('robôs quase não andaram (' + a.distanciaTotal + ' células)');
  if (a.balaoMaisLongo > 60) falhas.push('balão com ' + a.balaoMaisLongo + ' caracteres');
  if (a.sobreposicoes) falhas.push(`${a.sobreposicoes} sobreposições de rótulos`);
  // Uma captura de tela no meio da amostragem segura a página por ~0,7 s; mais que isso é estrangulamento.
  if (a.amostras < AMOSTRA_S * 9 || a.lacunas > 3) falhas.push(`amostragem estrangulada: ${a.amostras} amostras, ${a.lacunas} lacunas > 400 ms`);
  resumo.interacoesVistas = await avaliar('Office._debug().interacoes');

  // Cartão: clica num robô parado
  const alvo = await avaliar(`(() => {
    const d = Office._debug(); const r = d.robos.find((q) => !q.andando && !q.saindo) || d.robos[0];
    const el = [...document.querySelectorAll('.of-ator')][d.robos.indexOf(r)];
    const b = el.getBoundingClientRect(); return { nome: r.nome, x: b.left + b.width / 2, y: b.top + b.height * 0.62 };
  })()`);
  await clicar(alvo.x, alvo.y); await dormir(500);
  const cartao = await avaliar(`(() => { const c = document.querySelector('.of-cartao'); return { aberto: !c.hidden, nome: c.querySelector('.of-c-tit b').textContent, estado: c.querySelector('.of-pilula').textContent, tarefa: c.querySelectorAll('dd')[3].textContent, sel: !!document.querySelector('.of-ator.of-sel') }; })()`);
  await foto('office-1440-cartao');
  // Etapa 5: "Abrir conversa" chama abrirSessao (a Conversa do Orbit), nunca o VS Code.
  cartao.abrir = await avaliar(`(() => { window.__abriuConversa = null; window.__abriuVSCode = null; const b = document.querySelector('.of-c-abrir'); if (!b || b.hidden) return { visivel: false }; b.click(); return { visivel: true, rotulo: b.textContent, conversa: window.__abriuConversa, vscode: window.__abriuVSCode }; })()`);
  if (cartao.abrir.visivel && (!cartao.abrir.conversa || cartao.abrir.vscode)) falhas.push('o botão do cartão não abriu a Conversa (ou chamou o VS Code)');
  await tecla('Escape'); await dormir(300);
  cartao.fechouComEsc = await avaliar('document.querySelector(".of-cartao").hidden');
  resumo.cartao = { clicado: alvo.nome, ...cartao };
  if (!cartao.aberto || !cartao.sel) falhas.push('clique no robô não abriu o cartão');
  // Etapa 4/5: a instância do Orbit dormindo (dep-dorme do demo) aparece parada com zZ.
  resumo.dormindo = await avaliar(`[...document.querySelectorAll('.of-ator')].filter((b) => { const z = b.querySelector('.of-dorme'); return z && !z.hidden; }).length`);
  if (!resumo.dormindo) falhas.push('a instância dormindo não aparece com a pose zZ');
  if (!cartao.fechouComEsc) falhas.push('Esc não fechou o cartão');

  await telaCheia('1440', 'office-1440-cheia');

  // Trocas que chegaram ao encontro lado a lado, por tipo (roteiro de 120 s da API falsa; lê aos ~110 s, incluindo a fila de encontros).
  await dormir(Math.max(0, 110000 - (await avaliar('performance.now()'))));
  const hist = await avaliar('Office._debug().historico');
  resumo.trocasConcluidas = hist.filter((h) => h.ok).reduce((m, h) => ((m[h.tipo] = (m[h.tipo] || 0) + 1), m), {});
  resumo.trocasDescartadas = hist.filter((h) => !h.ok).map((h) => h.tipo + ' ' + h.v + '→' + h.h);
  for (const tipo of ['delegar', 'entregar', 'referencias', 'falhas']) if (!resumo.trocasConcluidas[tipo]) falhas.push('nenhuma troca concluída do tipo ' + tipo);

  // 1024×700
  await abrir(1024, 700);
  await dormir(6000);
  await foto('office-1024');
  await telaCheia('1024', 'office-1024-cheia');

  // Modo demonstração forçado (?office-demo=1) e sem sessões (?vazio=1)
  await abrir(1440, 900, '?office-demo=1');
  const gradeD = await avaliar(AMOSTRADOR);
  await dormir(15000);
  await foto('office-demo-1440');
  resumo.demo = analisar(gradeD, await avaliar('window.__am'));
  resumo.demo.modo = await avaliar('Office._debug().modo');
  resumo.demo.selo = await avaliar('!document.querySelector(".of-selo").hidden');
  resumo.demo.usoNota = await avaliar('document.querySelector(".of-selo").textContent');
  if (resumo.demo.modo !== 'demo' || !resumo.demo.selo) falhas.push('modo demonstração não ligou');
  if (resumo.demo.foraDoCaminho || resumo.demo.saltos) falhas.push('demo: robô fora do caminho ou salto');
  if (resumo.demo.amostras < 130 || resumo.demo.lacunas > 1) falhas.push('demo: amostragem estrangulada');
  if (resumo.demo.sobreposicoes) falhas.push(`demo: ${resumo.demo.sobreposicoes} sobreposições de rótulos`);
  if (resumo.demo.distanciaTotal < 5) falhas.push('demo: robôs não andaram');

  await abrir(1024, 700, '?vazio=1');
  await dormir(9000);
  resumo.vazio = { modo: await avaliar('Office._debug().modo'), usoNota: await avaliar('document.querySelector(".of-selo").textContent') };
  await foto('office-vazio-1024');
  if (resumo.vazio.modo !== 'demo') falhas.push('sem sessões não entrou em demonstração');

  // Network failure must retain the complete vector scene, then recover on remount.
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs', { urls: ['*/assets/office/fundo.png'] });
  const errosAntesFallback = resumo.console.length;
  await abrir(1024, 700);
  resumo.fallback = await avaliar(`({ semImagem: !document.querySelector('.of-palco').style.backgroundImage, mesas: document.querySelectorAll('.of-mesa').length, telas: document.querySelectorAll('.of-vidro').length })`);
  if (!resumo.fallback.semImagem || resumo.fallback.mesas < 15 || resumo.fallback.telas !== 16) falhas.push('fallback SVG incompleto');
  // Ignore only the resource failure deliberately induced by this test.
  resumo.console = resumo.console.filter((e, i) => i < errosAntesFallback || !e.includes('ERR_BLOCKED_BY_CLIENT'));
  await foto('office-fallback-1024');
  await cdp('Network.setBlockedURLs', { urls: [] });
  await abrir(1024, 700);

  // Pausar / retomar não quebram nada
  resumo.pausa = await avaliar(`(async () => { Office.pausar(); const a = JSON.stringify(Office._debug().robos.map(r => [r.x, r.y])); await new Promise(r => setTimeout(r, 800)); const b = JSON.stringify(Office._debug().robos.map(r => [r.x, r.y])); Office.retomar(); return { parado: a === b, pausado: Office._debug().pausado }; })()`);
  if (!resumo.pausa.parado) falhas.push('pausar() não parou o movimento');
} catch (e) {
  falhas.push('teste: ' + (e?.stack || e));
} finally {
  if (resumo.console.length) falhas.push(resumo.console.length + ' erro(s) de console');
  resumo.falhas = falhas;
  resumo.ok = falhas.length === 0;
  clearInterval(frente);
  try { ws?.close(); } catch {}
  await fecharEdge(dbg, perfil); // o perfil sai; as capturas ficam
  servidor.close();
  console.log(JSON.stringify(resumo, null, 2));
  setTimeout(() => process.exit(falhas.length ? 1 : 0), 300);
}


