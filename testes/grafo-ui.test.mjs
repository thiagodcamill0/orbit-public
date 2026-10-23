// Teste da vista do grafo (assets/grafo-vista.js) contra testes/grafo-demo.html (102 nós de exemplo, sem servidor do Orbit).
// Servidor estático próprio (só GET, só arquivos do projeto) numa porta livre de 47822–47826, Edge headless mudo,
// perfil numa pasta temporária apagada no fim, Edge fechado com fecharEdge. Usa vista._estado() e vista._no(id).
// Não testa o rótulo do hover (animação) nem o enquadramento inicial. node testes/grafo-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grafo-ui-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47823);
const srv = http.createServer((req, r2) => {
  if (req.method !== 'GET') { r2.writeHead(405); r2.end(); return; }
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const alvo = path.resolve(PROJ, '.' + rel);
  if (!alvo.startsWith(PROJ + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { r2.writeHead(404); r2.end(); return; }
  r2.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(alvo).pipe(r2);
});
await new Promise((r) => srv.listen(PORTA, '127.0.0.1', r));
const URL_DEMO = `http://127.0.0.1:${PORTA}/testes/grafo-demo.html`;

let pcdp, ws, manter;
try {
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
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
  const roda = async (x, y, deltaY, modifiers = 0) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers }); await dormir(30); };
  const mouse = (type, x, y, button = 'none', buttons = 0, modifiers = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const clicar = async (x, y, button = 'left', modifiers = 0) => {
    const b = button === 'left' ? 1 : 2;
    await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, button, b, modifiers); await mouse('mouseReleased', x, y, button, 0, modifiers); await dormir(80);
  };
  const tecla = (type, key, code, vk) => cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
  const est = () => av(`vista._estado()`);
  const noP = (id) => av(`vista._no(${JSON.stringify(id)})`);
  manter = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1000);
  // física assentada
  const assentou = (ms = 8000) => esperar(`vista._estado().alphaFisica < 0.001`, ms);
  // zoom/câmera assentados
  const camAssentou = (ms = 5000) => esperar(`(() => { const s = vista._estado(); return Math.abs(s.escala / s.escalaAlvo - 1) < 1e-6 && !s.inercia; })()`, ms);
  // posições de todos os nós na tela, escolhendo os "isolados" (sem outro nó por perto) dentro da vista
  const isolados = () => av(`(() => {
    const L = innerWidth, A = innerHeight;
    const todos = demo.nos.map((n) => ({ id: n.id, ...vista._no(n.id) })).filter((n) => n.criado);
    return todos.filter((n) => n.sx > 80 && n.sx < L - 80 && n.sy > 80 && n.sy < A - 80 && n.viz.length >= 2
      && todos.every((o) => o === n || Math.hypot(o.sx - n.sx, o.sy - n.sy) > Math.max(n.r, 6) + Math.max(o.r, 6) + 14))
      .map((n) => ({ id: n.id, sx: n.sx, sy: n.sy, r: n.r, viz: n.viz, alpha: n.alpha }));
  })()`);
  // ponto vazio na vista (sem nó a menos de 40 px)
  const vazio = (preferido) => av(`(() => {
    const todos = demo.nos.map((n) => vista._no(n.id)).filter((n) => n && n.criado);
    const pts = [${preferido ? JSON.stringify(preferido) : 'null'}].filter(Boolean);
    for (let y = 120; y < innerHeight - 100; y += 40) for (let x = 120; x < innerWidth - 100; x += 40) pts.push([x, y]);
    return pts.find(([x, y]) => todos.every((n) => Math.hypot(n.sx - x, n.sy - y) > Math.max(n.r, 6) + 40)) || null;
  })()`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: URL_DEMO });
  await esperar(`document.readyState === 'complete' && !!window.vista`, 8000);
  await esperar(`vista._estado().criados > 0`, 6000);

  // ── 1. Monta, física assenta ──
  let s = await est();
  conferir(s.n === 102 && s.links > 100, 'carrega os 102 nós e os links da demo', s);
  const cv = await av(`(() => { const c = document.querySelector('#grafo canvas'); const r = c && c.getBoundingClientRect(); return c ? { l: r.left, t: r.top, w: r.width, h: r.height } : null; })()`);
  conferir(cv && cv.w === 1200 && cv.h === 800 && cv.l === 0 && cv.t === 0, 'canvas ocupa a vista', cv);
  conferir(await assentou(7000), 'física assenta (alpha < 0,001) em poucos segundos', await est());
  conferir(await esperar(`vista._estado().criados === 102`, 5000), 'todos os nós criados (carga progressiva termina)', await est());
  await av(`vista.centralizar()`);
  await camAssentou();

  // ── 2. Zoom pela roda ──
  s = await est();
  const cx = 800, cy = 280;
  const mundoAntes = [(cx - s.panX) / s.escala, (cy - s.panY) / s.escala];
  await roda(cx, cy, -120);
  let s2 = await est();
  conferir(perto(s2.escalaAlvo / s.escalaAlvo, 1.5, 0.01), 'um entalhe aproximando multiplica o alvo por 1,5', { antes: s.escalaAlvo, depois: s2.escalaAlvo });
  await camAssentou();
  s2 = await est();
  conferir(perto(s2.escala / s.escala, 1.5, 0.02), 'a escala chega ao alvo (×1,5)', { antes: s.escala, depois: s2.escala });
  conferir(perto(mundoAntes[0] * s2.escala + s2.panX, cx, 1.5) && perto(mundoAntes[1] * s2.escala + s2.panY, cy, 1.5), 'aproximar mantém o ponto do mundo sob o cursor', { s2, mundoAntes });
  const mundoCentro = [(600 - s2.panX) / s2.escala, (400 - s2.panY) / s2.escala];
  await roda(cx, cy, 120);
  await camAssentou();
  const s3 = await est();
  conferir(perto(s3.escala / s2.escala, 1 / 1.5, 0.02), 'um entalhe afastando divide por 1,5', { antes: s2.escala, depois: s3.escala });
  conferir(perto(mundoCentro[0] * s3.escala + s3.panX, 600, 1.5) && perto(mundoCentro[1] * s3.escala + s3.panY, 400, 1.5), 'afastar ancora no centro da vista', { s3, mundoCentro });
  for (let i = 0; i < 16; i++) await roda(cx, cy, -120);
  s2 = await est();
  conferir(s2.escalaAlvo === 8, 'aproximar tem limite em 8', s2.escalaAlvo);
  await camAssentou();
  for (let i = 0; i < 40; i++) await roda(cx, cy, 120);
  s2 = await est();
  conferir(perto(s2.escalaAlvo, 1 / 128, 1e-9), 'afastar tem limite em 1/128', s2.escalaAlvo);
  await camAssentou();
  await av(`vista.centralizar()`);
  await camAssentou();
  await assentou();

  // ── 3. Hover: vizinhos 1, demais 0,2 ──
  let iso = await isolados();
  conferir(iso.length >= 3, 'há nós isolados na vista para os testes de mouse', iso.length);
  const alvoH = iso[0];
  await mouse('mouseMoved', alvoH.sx - 40, alvoH.sy - 40);
  await mouse('mouseMoved', alvoH.sx, alvoH.sy);
  conferir(await esperar(`vista._estado().hover === ${JSON.stringify(alvoH.id)}`, 3000), 'mouse sobre o nó o põe em hover', await est());
  const naoViz = await av(`(() => { const v = new Set(vista._no(${JSON.stringify(alvoH.id)}).viz); return demo.nos.map((n) => n.id).filter((id) => id !== ${JSON.stringify(alvoH.id)} && !v.has(id) && vista._no(id).criado); })()`);
  const algumViz = alvoH.viz[0];
  const apagou = await esperar(`${JSON.stringify(naoViz.slice(0, 12))}.every((id) => Math.abs(vista._no(id).alpha - 0.2) < 0.02) && Math.abs(vista._no(${JSON.stringify(algumViz)}).alpha - 1) < 0.02 && Math.abs(vista._no(${JSON.stringify(alvoH.id)}).alpha - 1) < 0.02`, 4000);
  conferir(apagou && naoViz.length > 10, 'hover: nó e vizinhos em 1 e não vizinhos em 0,2', { naoViz: naoViz.length, viz: await noP(algumViz), outro: await noP(naoViz[0]) });
  const livre = await vazio();
  await mouse('mouseMoved', livre[0], livre[1]);
  conferir(await esperar(`vista._estado().hover === null && ${JSON.stringify(naoViz.slice(0, 12))}.every((id) => vista._no(id).alpha > 0.98)`, 4000), 'tirar o mouse do nó restaura a opacidade 1', await noP(naoViz[0]));

  // ── 4. Clique, Ctrl+clique e botão direito ──
  iso = await isolados();
  let n1 = iso[1];
  await av(`demo.abertos.length = 0; demo.menus.length = 0; true`);
  await clicar(n1.sx, n1.sy);
  let ab = await av(`demo.abertos`);
  conferir(ab.length === 1 && ab[0][0] === n1.id && !ab[0][1], 'clique no nó dispara aoAbrir com o id', ab);
  iso = await isolados();
  n1 = iso.find((n) => n.id === n1.id) || iso[1];
  await clicar(n1.sx, n1.sy, 'left', 2);
  ab = await av(`demo.abertos`);
  conferir(ab.length === 2 && ab[1][0] === n1.id && ab[1][1] === true, 'Ctrl+clique pede nova aba', ab);
  // movimento de 3 px ainda é clique
  await mouse('mouseMoved', n1.sx, n1.sy); await mouse('mousePressed', n1.sx, n1.sy, 'left', 1);
  await mouse('mouseMoved', n1.sx + 3, n1.sy, 'left', 1); await mouse('mouseReleased', n1.sx + 3, n1.sy, 'left', 0); await dormir(80);
  conferir((await av(`demo.abertos.length`)) === 3, 'movimento de até 5 px continua sendo clique');
  // clique no vazio não abre nada
  const lv = await vazio();
  await clicar(lv[0], lv[1]);
  conferir((await av(`demo.abertos.length`)) === 3, 'clique no vazio não dispara aoAbrir');
  iso = await isolados();
  n1 = iso.find((n) => n.id === n1.id) || iso[1];
  await clicar(n1.sx, n1.sy, 'right');
  const mn = await av(`demo.menus`);
  conferir(mn.length === 1 && mn[0][0] === n1.id && typeof mn[0][1] === 'number', 'botão direito no nó dispara aoMenu(id, x, y)', mn);
  conferir((await av(`demo.abertos.length`)) === 3, 'botão direito não abre a nota');
  await clicar(lv[0], lv[1], 'right');
  conferir((await av(`demo.menus.length`)) === 1, 'botão direito no vazio não dispara aoMenu');

  // ── 5. Pan com inércia ──
  const pv = await vazio([400, 500]);
  const pan = async (x0, y0, dx, dy, folga) => {
    await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1);
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', x0 + dx * i / 8, y0 + dy * i / 8, 'left', 1); await dormir(12); }
    if (folga) await dormir(folga);
    await mouse('mouseReleased', x0 + dx, y0 + dy, 'left', 0);
  };
  s = await est();
  await pan(pv[0], pv[1], 100, 0, 0);
  const sa = await est();
  conferir(perto(sa.panX - s.panX, 100, 3), 'arrastar o fundo desloca a vista', { antes: s.panX, depois: sa.panX });
  conferir(sa.inercia === true, 'soltar em movimento deixa inércia', sa);
  await dormir(200);
  const sb = await est();
  conferir(Math.abs(sb.panX - sa.panX) > 5, 'a vista continua deslizando depois de soltar', { a: sa.panX, b: sb.panX });
  conferir(await esperar(`!vista._estado().inercia`, 6000), 'a inércia termina sozinha');
  await camAssentou();
  const pv2 = await vazio([400, 500]);
  s = await est();
  await pan(pv2[0], pv2[1], 100, 0, 250);
  await dormir(150);
  const sc = await est();
  conferir(!sc.inercia && perto(sc.panX - s.panX, 100, 3), 'parar antes de soltar não deixa inércia', { s: s.panX, sc });

  // ── 6. Teclado só com foco ──
  await av(`document.activeElement && document.activeElement.blur(); true`);
  s = await est();
  conferir(!(await av(`document.activeElement === document.querySelector('#grafo canvas')`)), 'canvas sem foco antes do teste de teclado');
  await tecla('keyDown', 'ArrowRight', 'ArrowRight', 39); await dormir(400); await tecla('keyUp', 'ArrowRight', 'ArrowRight', 39); await dormir(300);
  const sd = await est();
  conferir(sd.panX === s.panX && sd.panY === s.panY, 'setas sem foco no grafo não movem a vista', { s: s.panX, sd: sd.panX });
  await clicar(pv2[0], pv2[1]); // clicar no fundo foca o canvas
  await camAssentou();
  conferir(await av(`document.activeElement === document.querySelector('#grafo canvas')`), 'clicar no grafo dá foco ao canvas');
  s = await est();
  await tecla('keyDown', 'ArrowRight', 'ArrowRight', 39); await dormir(400); await tecla('keyUp', 'ArrowRight', 'ArrowRight', 39);
  await dormir(300);
  const se = await est();
  conferir(Math.abs(se.panX - s.panX) > 20 && Math.abs(se.panY - s.panY) < 1, 'seta com foco move a vista na horizontal', { s: s.panX, se: se.panX });
  await tecla('keyDown', '+', 'Equal', 187); await dormir(300); await tecla('keyUp', '+', 'Equal', 187); await dormir(100);
  const sf = await est();
  conferir(sf.escala > se.escala * 1.05, 'tecla + com foco aproxima', { antes: se.escala, depois: sf.escala });
  await camAssentou();
  await clicar(pv2[0], pv2[1]);
  await tecla('keyDown', 'ArrowRight', 'ArrowRight', 39); await dormir(150);
  await av(`document.activeElement.blur(); true`); // perde o foco com a tecla ainda segurada
  // a suavização do movimento morre sozinha em instantes; com a tecla ainda segurada ele nunca pararia
  let sg = await est(), sg2 = sg;
  for (let i = 0; i < 25; i++) { await dormir(150); sg2 = await est(); if (perto(sg2.panX, sg.panX, 0.3)) break; sg = sg2; }
  conferir(perto(sg2.panX, sg.panX, 0.3), 'perder o foco para o movimento por teclado', { antes: sg.panX, depois: sg2.panX });
  await tecla('keyUp', 'ArrowRight', 'ArrowRight', 39);

  // ── 7. Arrastar nó ──
  await av(`vista.centralizar()`);
  await camAssentou();
  await assentou();
  iso = await isolados();
  const nd = iso[2] || iso[0];
  const antesAb = await av(`demo.abertos.length`);
  await mouse('mouseMoved', nd.sx, nd.sy); await mouse('mousePressed', nd.sx, nd.sy, 'left', 1);
  const dx = 90, dy = 60;
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', nd.sx + dx * i / 8, nd.sy + dy * i / 8, 'left', 1); await dormir(20); }
  await dormir(120);
  const du = await av(`({ s: vista._estado(), n: vista._no(${JSON.stringify(nd.id)}) })`);
  conferir(du.s.arraste === nd.id, 'arrastar a partir do nó marca o arraste dele', du.s);
  conferir(perto(du.n.sx, nd.sx + dx, 2) && perto(du.n.sy, nd.sy + dy, 2), 'o nó acompanha o cursor durante o arraste', { n: du.n, esperado: [nd.sx + dx, nd.sy + dy] });
  const panAntes = (await est()).panX;
  await mouse('mouseReleased', nd.sx + dx, nd.sy + dy, 'left', 0); await dormir(150);
  conferir((await av(`demo.abertos.length`)) === antesAb, 'arrastar mais de 5 px não dispara o clique');
  const sh = await est();
  conferir(sh.arraste === null && sh.panX === panAntes, 'ao soltar o arraste termina e a vista não se mexeu', sh);
  conferir(await assentou(8000), 'a física volta a assentar depois do arraste');

  // ── 8. Timelapse ──
  await av(`vista.timelapse()`);
  conferir(await esperar(`vista._estado().timelapse !== null && vista._estado().criados < 102`, 3000), 'timelapse esconde os nós e começa a revelar', await est());
  const c1 = (await est()).criados;
  conferir(await esperar(`vista._estado().criados > ${c1}`, 4000), 'timelapse revela mais nós com o tempo', { c1, depois: (await est()).criados });
  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  clearInterval(manter);
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nGrafo UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
