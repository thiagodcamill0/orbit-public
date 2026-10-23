// Teste das formas do Whiteboard (assets/whiteboard-formas.js) contra testes/whiteboard-demo.html (fetch falso em memória).
// Servidor estático próprio (só GET, só arquivos do projeto) numa porta livre de 47822–47826, Edge headless mudo,
// perfil numa pasta temporária apagada no fim, Edge fechado com fecharEdge.
// node testes/whiteboard-formas-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-formas-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const SHIFT = 8, ALT = 1;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47822);
const srv = http.createServer((req, r2) => {
  if (req.method !== 'GET') { r2.writeHead(405); r2.end(); return; }
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const alvo = path.resolve(PROJ, '.' + rel);
  if (!alvo.startsWith(PROJ + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { r2.writeHead(404); r2.end(); return; }
  r2.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(alvo).pipe(r2);
});
await new Promise((r) => srv.listen(PORTA, '127.0.0.1', r));
const URL_DEMO = `http://127.0.0.1:${PORTA}/testes/whiteboard-demo.html`;

let pcdp, ws;
try {
  const EDGE = (await import('./edge.mjs')).caminhoNavegador();
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) consoleErros.push(d.params.type + ': ' + d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon/.test(d.params.entry.url || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + '\n' + expr.slice(0, 200));
    return r.result?.result?.value;
  };
  const esperar = async (expr, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(40); } return false; };
  const VK = { Escape: 27, Enter: 13 };
  const tecla = async (key, mods = 0) => {
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    const vk = VK[key] || key.toUpperCase().charCodeAt(0);
    const p = { key, code, windowsVirtualKeyCode: vk, modifiers: mods };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(70);
  };
  const mouse = (type, x, y, button = 'none', buttons = 0, modifiers = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 });
  let OX = 0, OY = 0; // origem do palco na página: mundo (câmera 0,0, zoom 1) → cliente
  const arrastar = async (x0, y0, x1, y1, mods = 0, passos = 6) => {
    await mouse('mouseMoved', OX + x0, OY + y0, 'none', 0, mods); await mouse('mousePressed', OX + x0, OY + y0, 'left', 1, mods);
    for (let i = 1; i <= passos; i++) { await mouse('mouseMoved', OX + x0 + (x1 - x0) * i / passos, OY + y0 + (y1 - y0) * i / passos, 'left', 1, mods); await dormir(12); }
    await mouse('mouseReleased', OX + x1, OY + y1, 'left', 0, mods); await dormir(90);
  };
  const clicar = async (x, y) => {
    await mouse('mouseMoved', OX + x, OY + y); await mouse('mousePressed', OX + x, OY + y, 'left', 1);
    await mouse('mouseReleased', OX + x, OY + y, 'left', 0); await dormir(70);
  };
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(200);
  };
  const els = () => av(`Whiteboard.nucleo.elementos().map((e) => JSON.parse(JSON.stringify(e)))`);
  const ult = async () => { const l = await els(); return l[l.length - 1]; };
  const ferr = () => av(`Whiteboard.nucleo.ferramenta()`);
  const sel = () => av(`Whiteboard.nucleo.selecao()`);
  const limpar = () => av(`Whiteboard.nucleo.remover(Whiteboard.nucleo.elementos().map((e) => e.id))`);
  const caixaIgual = (e, x, y, w, h) => perto(e.x, x) && perto(e.y, y) && perto(e.w, w) && perto(e.h, h);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const ret = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  OX = ret.l; OY = ret.t;
  conferir(ret.w > 900 && ret.h > 650, 'palco ocupa a vista', ret);

  // ── 1. Registro e atalhos ──
  let r = await av(`[...document.querySelectorAll('.wb-barra .wb-ferr')].map((b) => b.dataset.ferramenta)`);
  conferir(['retangulo', 'elipse', 'losango', 'linha', 'livre'].every((n) => r.includes(n)), 'barra mostra as 5 ferramentas de formas', r);
  conferir(r.indexOf('retangulo') < r.indexOf('elipse') && r.indexOf('elipse') < r.indexOf('losango') && r.indexOf('losango') < r.indexOf('linha') && r.indexOf('linha') < r.indexOf('livre'), 'ordem da barra: retângulo, elipse, losango, linha, livre', r);
  await av(`document.querySelector('.wb-palco').focus()`);
  for (const [k, n] of [['r', 'retangulo'], ['o', 'elipse'], ['d', 'losango'], ['l', 'linha'], ['p', 'livre'], ['v', 'selecionar']]) {
    await tecla(k);
    conferir((await ferr()) === n, `tecla ${k.toUpperCase()} ativa ${n}`, await ferr());
  }

  // ── 2. Retângulo, elipse, losango ──
  await tecla('r');
  await arrastar(300, 150, 500, 250);
  let e = await ult();
  conferir(e.tipo === 'retangulo' && caixaIgual(e, 300, 150, 200, 100), 'retângulo por arrasto: tipo e caixa certos', e);
  conferir((await ferr()) === 'selecionar' && JSON.stringify(await sel()) === JSON.stringify([e.id]), 'depois de criar volta para selecionar com o novo selecionado', { f: await ferr(), s: await sel() });
  conferir(typeof e.cor === 'string' && e.traco && e.traco.largura > 0 && e.traco.estilo && e.angulo === 0 && e.pontos === null, 'retângulo recebe o estilo atual', e);

  await tecla('r');
  await arrastar(600, 150, 800, 230, SHIFT);
  e = await ult();
  conferir(e.tipo === 'retangulo' && caixaIgual(e, 600, 150, 200, 200), 'Shift deixa o retângulo quadrado (maior lado)', e);

  await tecla('o');
  await arrastar(500, 500, 560, 540, ALT);
  e = await ult();
  conferir(e.tipo === 'elipse' && caixaIgual(e, 440, 460, 120, 80), 'elipse com Alt cresce a partir do centro', e);

  await tecla('o');
  await arrastar(900, 400, 850, 430, SHIFT);
  e = await ult();
  conferir(e.tipo === 'elipse' && caixaIgual(e, 850, 400, 50, 50), 'elipse com Shift para a esquerda/baixo vira círculo', e);

  await tecla('d');
  await arrastar(300, 350, 420, 430);
  e = await ult();
  conferir(e.tipo === 'losango' && caixaIgual(e, 300, 350, 120, 80), 'losango por arrasto: tipo e caixa certos', e);

  await tecla('d');
  await arrastar(700, 450, 760, 400, SHIFT | ALT);
  e = await ult();
  conferir(e.tipo === 'losango' && caixaIgual(e, 640, 390, 120, 120), 'Shift+Alt: proporcional a partir do centro', e);

  await tecla('r');
  await clicar(700, 560);
  e = await ult();
  conferir(e.tipo === 'retangulo' && caixaIgual(e, 620, 510, 160, 100), 'clique sem arrastar cria o tamanho padrão centrado', e);
  const antes = (await els()).length;
  await tecla('o'); await clicar(100, 600);
  e = await ult();
  conferir(e.tipo === 'elipse' && caixaIgual(e, 20, 550, 160, 100) && (await els()).length === antes + 1, 'clique cria elipse padrão', e);

  // ── 3. Linha ──
  await limpar();
  await tecla('l');
  await arrastar(300, 600, 500, 660, SHIFT);
  e = await ult();
  const ang = e.pontos ? Math.atan2(e.pontos[1][1] - e.pontos[0][1], e.pontos[1][0] - e.pontos[0][0]) * 180 / Math.PI : -1;
  conferir(e.tipo === 'linha' && e.pontos?.length === 2 && perto(ang, 15, 0.05), 'linha com Shift trava em 15°', { e, ang });
  conferir(perto(e.x, 300) && perto(e.y, 600) && perto(e.w, Math.hypot(200, 60) * Math.cos(15 * Math.PI / 180), 0.6) && e.preenchimento === null, 'caixa da linha acompanha os pontos', e);
  conferir((await ferr()) === 'selecionar' && (await sel())[0] === e.id, 'linha criada volta para selecionar com ela selecionada');

  await tecla('l');
  await arrastar(600, 600, 700, 640);
  e = await ult();
  conferir(e.tipo === 'linha' && e.pontos.length === 2 && perto(e.pontos[1][0], 100) && perto(e.pontos[1][1], 40), 'arrastar faz segmento simples sem Shift', e);

  await tecla('l');
  await clicar(100, 500); await clicar(180, 540); await clicar(260, 500);
  conferir((await ferr()) === 'linha' && (await els()).length === 2, 'clicar-clicar mantém a polilinha em andamento');
  await tecla('Enter');
  e = await ult();
  conferir(e.tipo === 'linha' && e.pontos.length === 3 && perto(e.pontos[1][0], 80) && perto(e.pontos[1][1], 40) && perto(e.pontos[2][0], 160) && perto(e.pontos[2][1], 0), 'Enter termina a polilinha com 3 pontos', e);
  conferir((await ferr()) === 'selecionar', 'polilinha terminada volta para selecionar');

  await tecla('l');
  await clicar(100, 600); await clicar(160, 640); await clicar(220, 600); await clicar(220, 600);
  e = await ult();
  conferir(e.tipo === 'linha' && e.pontos.length === 3 && (await ferr()) === 'selecionar', 'clique de novo no último ponto (duplo clique) termina a polilinha', e);

  await tecla('l');
  await clicar(400, 300); await clicar(460, 340);
  await tecla('Escape');
  e = await ult();
  conferir(e.tipo === 'linha' && e.pontos.length === 2 && perto(e.pontos[1][0], 60) && (await ferr()) === 'selecionar', 'Esc termina a polilinha com os pontos já postos', e);
  const nLinhas = (await els()).length;
  await tecla('l'); await clicar(800, 300);
  await tecla('Escape');
  conferir((await els()).length === nLinhas, 'Esc com um ponto só não cria nada');
  await tecla('v');

  // ── 4. Mão livre ──
  await limpar();
  await tecla('p');
  const N = 61; // seno com 61 pontos brutos
  await mouse('mouseMoved', OX + 300, OY + 650); await mouse('mousePressed', OX + 300, OY + 650, 'left', 1);
  for (let i = 1; i < N; i++) { await mouse('mouseMoved', OX + 300 + 10 * i, OY + 650 + 40 * Math.sin(i / 6), 'left', 1); }
  await mouse('mouseReleased', OX + 900, OY + 650 + 40 * Math.sin((N - 1) / 6), 'left', 0); await dormir(90);
  e = await ult();
  conferir(e.tipo === 'livre' && e.pontos.length >= 6 && e.pontos.length < N - 5, 'mão livre simplifica os pontos (menos que os brutos, mais que uma reta)', { n: e.pontos?.length });
  conferir(perto(e.x, 300, 1) && perto(e.w, 600, 1) && e.h > 60 && e.h < 85, 'caixa da mão livre cobre o traço', e);
  conferir((await ferr()) === 'livre' && (await sel()).length === 0, 'mão livre continua ativa e não seleciona');
  conferir(e.pontos.every((p) => Math.abs(p[0] * 10 - Math.round(p[0] * 10)) < 1e-6), 'pontos da mão livre com 1 casa decimal', e.pontos.slice(0, 3));
  await mouse('mouseMoved', OX + 300, OY + 500); await mouse('mousePressed', OX + 300, OY + 500, 'left', 1);
  for (let i = 1; i <= 40; i++) await mouse('mouseMoved', OX + 300 + 5 * i, OY + 500 + i, 'left', 1);
  await mouse('mouseReleased', OX + 500, OY + 540, 'left', 0); await dormir(90);
  e = await ult();
  conferir(e.tipo === 'livre' && e.pontos.length <= 3 && (await els()).length === 2, 'traço reto de 40 movimentos vira quase 2 pontos', { n: e.pontos?.length });
  await clicar(900, 500);
  e = await ult();
  conferir(e.tipo === 'livre' && e.pontos.length === 1 && (await els()).length === 3 && (await ferr()) === 'livre', 'clique com a mão livre cria um ponto', e);
  await tecla('v');

  // ── 5. Estilo do traço (sólido/tracejado/pontilhado) ──
  await limpar();
  await av(`window.__dash = []; const o = CanvasRenderingContext2D.prototype.setLineDash; CanvasRenderingContext2D.prototype.setLineDash = function (a) { window.__dash.push(JSON.stringify(a)); return o.call(this, a); };`);
  for (const [i, estilo] of ['tracejado', 'pontilhado'].entries()) {
    for (const tipo of ['retangulo', 'elipse', 'losango']) await av(`Whiteboard.nucleo.adicionar({ tipo: '${tipo}', x: ${100 + i * 300}, y: 100, w: 100, h: 80, cor: '#fff', traco: { largura: 2, estilo: '${estilo}' } })`);
    await av(`Whiteboard.nucleo.adicionar({ tipo: 'linha', x: ${100 + i * 300}, y: 300, w: 100, h: 50, cor: '#fff', traco: { largura: 2, estilo: '${estilo}' }, pontos: [[0, 0], [100, 50]] })`);
  }
  await esperar(`window.__dash.includes('[8,6]') && window.__dash.includes('[0.001,5]')`, 2000);
  const dash = await av(`window.__dash`);
  conferir(dash.includes('[8,6]') && dash.includes('[0.001,5]'), 'tracejado e pontilhado chegam ao canvas', [...new Set(dash)]);

  // ── 6. Clique acerta/erra cada forma ──
  await limpar();
  const add = (o) => av(`Whiteboard.nucleo.adicionar(Object.assign({ cor: '#fff', traco: { largura: 2, estilo: 'solido' } }, ${JSON.stringify(o)})).id`);
  const em = (x, y) => av(`(Whiteboard.nucleo.elementoEm(${x}, ${y}) || {}).id || null`);
  const idR = await add({ tipo: 'retangulo', x: 100, y: 100, w: 200, h: 100 });
  const idRp = await add({ tipo: 'retangulo', x: 100, y: 300, w: 200, h: 100, preenchimento: '#333' });
  conferir((await em(100, 150)) === idR && (await em(200, 100)) === idR && (await em(200, 150)) === null && (await em(50, 150)) === null, 'retângulo vazio: acerta a borda, erra o interior e o fora');
  conferir((await em(200, 350)) === idRp && (await em(320, 350)) === null, 'retângulo preenchido: acerta o interior');
  const idE = await add({ tipo: 'elipse', x: 400, y: 100, w: 200, h: 100 });
  const idEp = await add({ tipo: 'elipse', x: 400, y: 300, w: 200, h: 100, preenchimento: '#333' });
  conferir((await em(600, 150)) === idE && (await em(500, 100)) === idE && (await em(500, 150)) === null && (await em(402, 102)) === null, 'elipse vazia: acerta a borda, erra o centro e o canto da caixa');
  conferir((await em(500, 350)) === idEp && (await em(402, 302)) === null, 'elipse preenchida: acerta o centro e erra o canto da caixa');
  const idL = await add({ tipo: 'losango', x: 700, y: 100, w: 200, h: 100 });
  const idLp = await add({ tipo: 'losango', x: 700, y: 300, w: 200, h: 100, preenchimento: '#333' });
  conferir((await em(850, 125)) === idL && (await em(800, 100)) === idL && (await em(800, 150)) === null && (await em(702, 102)) === null, 'losango vazio: acerta a borda, erra o centro e o canto da caixa');
  conferir((await em(800, 350)) === idLp && (await em(702, 302)) === null && (await em(880, 330)) === null, 'losango preenchido: acerta o centro e erra os cantos');
  const idLi = await add({ tipo: 'linha', x: 100, y: 500, w: 100, h: 100, pontos: [[0, 0], [100, 100]] });
  conferir((await em(150, 550)) === idLi && (await em(150, 553)) === idLi && (await em(150, 575)) === null && (await em(300, 500)) === null, 'linha: acerta perto do traço, erra longe');
  const idPo = await add({ tipo: 'linha', x: 300, y: 500, w: 100, h: 50, pontos: [[0, 0], [100, 0], [100, 50]] });
  conferir((await em(350, 500)) === idPo && (await em(400, 525)) === idPo && (await em(350, 525)) === null, 'polilinha: acerta nos dois segmentos, erra no vazio entre eles');
  const idLv = await add({ tipo: 'livre', x: 600, y: 500, w: 100, h: 50, pontos: [[0, 0], [50, 0], [100, 50]] });
  conferir((await em(625, 500)) === idLv && (await em(675, 525)) === idLv && (await em(625, 530)) === null, 'mão livre: acerta perto do traço, erra longe');
  const cx = await av(`['linha', 'livre'].map((t) => { const e = Whiteboard.nucleo.elementos().find((x) => x.tipo === t); return Whiteboard.nucleo.caixaMundo(e); })`);
  conferir(perto(cx[0].w, 100) && perto(cx[0].h, 100) && perto(cx[1].w, 100) && perto(cx[1].h, 50), 'caixaMundo de linha e livre bate com os pontos', cx);

  // ── 7. Salvar leva os elementos ──
  await av(`Whiteboard.nucleo.confirmar('teste')`);
  await av(`Whiteboard.salvarAgora()`);
  await esperar(`demo.reqs.some((x) => x[1] === '/whiteboard/salvar')`, 3000);
  const salvo = await av(`(() => { const s = demo.reqs.filter((x) => x[1] === '/whiteboard/salvar').pop(); return s && s[2].elementos.map((e) => e.tipo); })()`);
  conferir(salvo && ['retangulo', 'elipse', 'losango', 'linha', 'livre'].every((t) => salvo.includes(t)) && salvo.length === 9, 'salvar leva os 9 elementos das 5 formas', salvo);
  await abrir('?vazio=1');
  const volta = await av(`Whiteboard.nucleo.elementos().map((e) => e.tipo).sort().join(',')`);
  conferir(volta === 'elipse,elipse,linha,linha,livre,losango,losango,retangulo,retangulo', 'recarregar devolve os mesmos tipos', volta);

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard formas UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
