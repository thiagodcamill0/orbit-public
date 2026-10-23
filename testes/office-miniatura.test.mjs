// Office.miniatura({largura, altura}): miniatura parada da Vila para o canvas de escritórios.
// node testes/office-miniatura.test.mjs
// Servidor estático próprio (porta por escolherPorta, faixa 47822–47826) + Edge headless + CDP. Confere:
//  1) com o Office nunca montado (só o script): canvas do tamanho pedido, data-mapa='vila', pixels não vazios;
//  2) duas chamadas devolvem canvas diferentes (cópias), com o mesmo desenho; alterar uma não altera a outra;
//  3) com o Office montado e animando: a miniatura não muda o mapa do palco, não monta outro palco e não gera erro;
//  4) tamanhos diferentes (cache por largura×altura) e entrada inválida usam o padrão 192x120;
//  5) imagens indisponíveis (base inexistente): data-mapa='simples', com pixels, e sem travar.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const conferir = (ok, msg) => { console.log((ok ? 'ok   ' : 'FALHA ') + msg); if (!ok) falhas.push(msg); };
const consoleErros = [];
let ignorarLog = false; // a fase do fallback gera 404 de propósito

const BASE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Office · miniatura</title><link rel="icon" href="data:,">
<style>html,body{height:100%;margin:0;background:#0a0a0a}#office{width:100vw;height:100vh}</style></head><body><section id="office"></section>`;
// Só o script carregado (Office nunca montado); ?base= troca CONFIG.vila.base antes de qualquer chamada.
const PAGINA_SOLTA = BASE + `<script>
const q = new URLSearchParams(location.search);
const js = document.createElement('script'); js.src = '/assets/office.js';
js.onload = () => { if (q.get('base')) Office.CONFIG.vila.base = q.get('base'); window.__pronto = true; };
document.head.appendChild(js);
</script></body></html>`;
// Office montado e animando, com API falsa mínima de sessões (uma trabalhando).
const PAGINA_MONTADA = BASE + `<script>
(function () {
  const T0 = Date.now(), copia = (o) => JSON.parse(JSON.stringify(o));
  const sess = (o) => Object.assign({ id: '', status: 'trabalhando', desde: T0, titulo: '', apelido: '', projeto: 'Orbit', cwd: 'D:\\\\x', tarefa: '', primeira: '',
    detalhe: '', ferramenta: null, agentes: [], subagentes: 0, pai: null, vivo: true, atividade: T0, nome: '', controle: null }, o);
  const mapa = new Map([['m1', sess({ id: 'm1', nome: 'm-lider', titulo: 'Lider', ferramenta: { nome: 'Read', alvo: 'D:/x/plano.md' } })]]);
  window.GerenciadorAPI = {
    sessoes: () => [...mapa.values()].map(copia), sessao: (id) => (mapa.has(id) ? copia(mapa.get(id)) : null),
    eventos: async (id) => ({ sessao: mapa.get(id) || null, eventos: [] }), uso: () => null, config: () => ({}),
    on: () => () => {}, selecionada: () => null, abrirSessao: () => {},
  };
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/assets/office.css'; document.head.appendChild(css);
  const js = document.createElement('script'); js.src = '/assets/office.js';
  js.onload = () => { const m = () => Office.montar(document.getElementById('office'), window.GerenciadorAPI); css.sheet ? m() : css.addEventListener('load', m); };
  document.head.appendChild(js);
})();
</script></body></html>`;
const PAGINAS = { '/__mini-solta.html': PAGINA_SOLTA, '/__mini-montada.html': PAGINA_MONTADA };

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (PAGINAS[u.pathname]) { res.writeHead(200, { 'content-type': TIPOS['.html'] }); res.end(PAGINAS[u.pathname]); return; }
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
async function ir(caminho) {
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORTA}${caminho}` });
  await dormir(150);
}
// Resumo de um canvas devolvido pela miniatura: tamanho, mapa, pixels opacos e cores distintas (amostra).
const RESUMO = `(c) => { const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data; let opacos = 0; const cores = new Set();
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 0) opacos++; cores.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3)); }
  return { w: c.width, h: c.height, mapa: c.dataset.mapa, opacos, total: c.width * c.height, cores: cores.size, ehCanvas: c instanceof HTMLCanvasElement }; }`;

try {
  PORTA = await escolherPorta(Number(process.env.OFFICE_PORTA) || 47823); // faixa 47822–47826, nunca a 47821
  await new Promise((r, j) => servidor.listen(PORTA, '127.0.0.1', r).on('error', j));
  dbg = 9600 + Math.floor(Math.random() * 150);
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-office-miniatura-'));
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
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !ignorarLog) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  globalThis.__frente = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1500);

  // ── 1) Office nunca montado: só o script ──
  await ir('/__mini-solta.html');
  conferir(await esperar('window.__pronto && window.Office'), 'página solta carregou o office.js');
  conferir(await avaliar(`typeof Office.miniatura === 'function'`), 'Office.miniatura é função');
  conferir(await avaliar(`document.querySelector('.of-palco') === null && Office._debug().mapa === ''`), 'Office nunca montado (sem palco)');
  const a = await avaliar(`Office.miniatura({ largura: 192, altura: 120 }).then(${RESUMO})`);
  conferir(a.ehCanvas && a.w === 192 && a.h === 120, `devolve HTMLCanvasElement do tamanho pedido (${a.w}x${a.h})`);
  conferir(a.mapa === 'vila', `data-mapa='vila' (veio '${a.mapa}')`);
  conferir(a.opacos === a.total && a.cores > 50, `pixels não vazios: ${a.opacos}/${a.total} opacos, ${a.cores} cores`);
  conferir(await avaliar(`document.querySelector('.of-palco') === null && document.querySelector('canvas') === null`), 'a miniatura não montou palco nem pôs canvas na página');

  // ── 2) cópias ──
  const c = await avaliar(`(async () => {
    const x = await Office.miniatura({ largura: 192, altura: 120 }), y = await Office.miniatura({ largura: 192, altura: 120 });
    const dx = x.getContext('2d').getImageData(0, 0, 192, 120).data, dy = y.getContext('2d').getImageData(0, 0, 192, 120).data;
    let igual = true; for (let i = 0; i < dx.length; i++) if (dx[i] !== dy[i]) { igual = false; break; }
    x.getContext('2d').fillStyle = '#f0f'; x.getContext('2d').fillRect(0, 0, 192, 120);
    const z = await Office.miniatura({ largura: 192, altura: 120 }), dz = z.getContext('2d').getImageData(0, 0, 1, 1).data;
    return { diferentes: x !== y && x !== z && y !== z, igual, intacta: !(dz[0] === 255 && dz[1] === 0 && dz[2] === 255), mapa: [x.dataset.mapa, y.dataset.mapa, z.dataset.mapa] };
  })()`);
  conferir(c.diferentes, 'duas chamadas devolvem canvas diferentes (cópias)');
  conferir(c.igual, 'as cópias têm o mesmo desenho');
  conferir(c.intacta && c.mapa.every((m) => m === 'vila'), 'pintar uma cópia não estraga o cache; todas com data-mapa=vila');

  // ── 4) outros tamanhos e entrada inválida ──
  const t = await avaliar(`(async () => { const r = []; for (const o of [{ largura: 96, altura: 60 }, { largura: 384, altura: 240 }, {}, undefined]) { const k = await Office.miniatura(o); r.push([k.width, k.height, k.dataset.mapa]); } return r; })()`);
  conferir(t[0][0] === 96 && t[0][1] === 60 && t[1][0] === 384 && t[1][1] === 240, 'tamanhos diferentes respeitados (96x60, 384x240)');
  conferir(t[2][0] === 192 && t[2][1] === 120 && t[3][0] === 192 && t[3][1] === 120, 'sem tamanho válido usa 192x120');
  conferir(t.every((x) => x[2] === 'vila'), 'todos com data-mapa=vila');

  // ── 3) Office montado e animando ──
  await ir('/__mini-montada.html');
  conferir(await esperar('window.Office && document.querySelectorAll(".of-ator").length >= 1', 20000), 'Office montado com robô');
  conferir(await esperar("Office._debug().mapa === 'vila'", 10000), 'palco com mapa vila antes da miniatura');
  const antes = await avaliar(`(() => { const d = Office._debug(), p = document.querySelector('.of-vila'); return { mapa: d.mapa, w: p.width, h: p.height, palcos: document.querySelectorAll('.of-palco').length, vilas: document.querySelectorAll('.of-vila').length, robos: d.robos.length }; })()`);
  const m = await avaliar(`(async () => {
    const x = await Promise.all([Office.miniatura({ largura: 192, altura: 120 }), Office.miniatura({ largura: 256, altura: 160 })]);
    await new Promise((r) => setTimeout(r, 400));
    const y = await Office.miniatura({ largura: 192, altura: 120 });
    const d = Office._debug(), p = document.querySelector('.of-vila');
    return { mapas: [x[0].dataset.mapa, x[1].dataset.mapa, y.dataset.mapa], tam: [x[0].width, x[1].width, y.width], mapa: d.mapa, w: p.width, h: p.height,
      palcos: document.querySelectorAll('.of-palco').length, vilas: document.querySelectorAll('.of-vila').length, robos: d.robos.length, dataMapa: p.dataset.mapa };
  })()`);
  conferir(m.mapas.every((x) => x === 'vila') && m.tam.join() === '192,256,192', 'montado: miniaturas vila nos tamanhos pedidos');
  conferir(m.mapa === antes.mapa && m.dataMapa === 'vila', `montado: dataset.mapa do palco continua '${m.dataMapa}'`);
  conferir(m.w === antes.w && m.h === antes.h && m.palcos === antes.palcos && m.vilas === antes.vilas && m.robos === antes.robos, 'montado: palco, canvas do mapa e robôs inalterados');
  await dormir(500);
  conferir(await avaliar(`document.querySelector('.of-vila').dataset.mapa === 'vila' && document.querySelectorAll('.of-ator').length >= 1`), 'montado: animação segue depois da miniatura');
  conferir(consoleErros.length === 0, 'sem erros de console' + (consoleErros.length ? ': ' + consoleErros.slice(0, 3).join(' | ') : ''));

  // ── 5) fallback: base inexistente ──
  ignorarLog = true;
  await ir('/__mini-solta.html?base=' + encodeURIComponent('/inexistente/'));
  conferir(await esperar('window.__pronto && window.Office'), 'página do fallback carregou');
  const f = await avaliar(`Office.miniatura({ largura: 192, altura: 120 }).then(${RESUMO})`);
  conferir(f.ehCanvas && f.w === 192 && f.h === 120, 'fallback: canvas do tamanho pedido');
  conferir(f.mapa === 'simples', `fallback: data-mapa='simples' (veio '${f.mapa}')`);
  conferir(f.opacos === f.total && f.cores >= 3, `fallback: pixels não vazios (${f.cores} cores)`);
  const f2 = await avaliar(`Office.miniatura({ largura: 192, altura: 120 }).then(${RESUMO})`);
  conferir(f2.mapa === 'simples', 'fallback repetido continua simples (sem cache enganoso)');
  ignorarLog = false;
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
