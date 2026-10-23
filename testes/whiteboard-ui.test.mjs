// Teste da interface do Whiteboard (assets/whiteboard.js) contra testes/whiteboard-demo.html (fetch falso em memória).
// Servidor estático próprio (só GET, só arquivos do projeto) numa porta livre de 47822–47826, Edge headless mudo,
// perfil numa pasta temporária apagada no fim, Edge fechado com fecharEdge. Não depende do visual (whiteboard.css).
// node testes/whiteboard-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-ui-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

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
  const tecla = async (key, code, mods = 0, vk = 0) => {
    const p = { key, code, windowsVirtualKeyCode: vk, modifiers: mods };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(60);
  };
  const roda = async (x, y, deltaX, deltaY, modifiers = 0) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers }); await dormir(40); };
  const mouse = (type, x, y, button = 'none', buttons = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const arrastar = async (x0, y0, x1, y1, button = 'left') => {
    const b = button === 'left' ? 1 : button === 'middle' ? 4 : 2;
    await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, button, b);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, button, b); await dormir(15); }
    await mouse('mouseReleased', x1, y1, button, 0); await dormir(60);
  };
  // espera a animação da câmera terminar (câmera igual em duas leituras seguidas)
  const assentar = async () => { let ant = ""; for (let i = 0; i < 60; i++) { await dormir(100); const c = JSON.stringify(await av(`Whiteboard.nucleo.camera()`)); if (c === ant) return; ant = c; } };
  const cam = () => av(`Whiteboard.nucleo.camera()`);
  const resetCam = () => av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(200);
  };
  const reqs = () => av(`demo.reqs`);
  const pct = () => av(`document.querySelector('.wb-zoom-pct').textContent`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir();

  // ── 1. Abre e cria ──
  let r = await av(`({ q: Whiteboard.quadro(), n: Whiteboard.nucleo.elementos().length, nome: document.querySelector('.wb-nome')?.textContent, canvas: !!document.querySelector('#whiteboard canvas.wb-canvas'),
    barra: document.querySelectorAll('.wb-barra .wb-ferr').length, pct: document.querySelector('.wb-zoom-pct')?.textContent, ultimo: localStorage.getItem('orbit.whiteboard.ultimo'), reqs: demo.reqs.map((x) => x[0] + ' ' + x[1]) })`);
  conferir(r.q?.nome === 'Mapa do projeto' && r.n === 3 && r.nome === 'Mapa do projeto', 'abre o quadro semente com 3 elementos e o nome no cabeçalho', r);
  conferir(r.canvas && r.barra >= 2 && r.pct === '100%', 'monta canvas, barra de ferramentas e zoom 100%', r);
  conferir(r.reqs[0] === 'GET /whiteboard/lista' && r.reqs.some((x) => x.startsWith('GET /whiteboard/quadro?id=')) && r.ultimo === r.q?.id, 'carrega lista + quadro e guarda o último', r);
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  r = await av(`({ q: Whiteboard.quadro(), total: Whiteboard.quadros().length, reqs: demo.reqs.map((x) => x[0] + ' ' + x[1]), vazio: !document.querySelector('.wb-vazio').hidden })`);
  conferir(r.q && r.total === 1 && r.reqs.includes('POST /whiteboard/novo') && r.vazio, 'sem quadros: cria um sozinho e mostra a dica de quadro vazio', r);
  await av(`document.querySelector('.wb-quadro-btn').click()`);
  conferir(await esperar(`!!document.querySelector('.wb-painel .wb-novo')`), 'chip do quadro abre o painel');
  const idAntes = await av(`Whiteboard.quadro().id`);
  await av(`document.querySelector('.wb-painel .wb-novo').click()`);
  await esperar(`Whiteboard.quadro().id !== ${JSON.stringify(idAntes)}`);
  await dormir(300);
  r = await av(`({ id: Whiteboard.quadro().id, total: Whiteboard.quadros().length, painel: !!document.querySelector('.wb-painel:not(.saindo)') })`);
  conferir(r.id !== idAntes && r.total === 2 && !r.painel, 'botão Novo quadro cria, abre e fecha o painel', r);

  // volta ao cenário com a semente
  await av(`localStorage.clear()`);
  await abrir();
  await resetCam();
  const ret = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  conferir(ret.w > 600 && ret.h > 400, 'palco ocupa a vista', ret);

  // ── 2. Zoom com Ctrl+rolagem mantém o ponto sob o cursor ──
  const px = ret.l + 420, py = ret.t + 310;
  const mundoSob = () => av(`Whiteboard.nucleo.telaParaMundo(${px - ret.l}, ${py - ret.t})`);
  const antes = await mundoSob();
  await roda(px, py, 0, -40, 2);
  await dormir(500);
  let c = await cam();
  let depois = await mundoSob();
  conferir(c.zoom > 1.1 && perto(depois.x, antes.x) && perto(depois.y, antes.y), 'Ctrl+rolagem aproxima mantendo o ponto do mundo sob o cursor', { c, antes, depois });
  await roda(px, py, 0, 40, 2); await roda(px, py, 0, 40, 2); await dormir(500);
  c = await cam();
  depois = await mundoSob();
  conferir(c.zoom < 1 && perto(depois.x, antes.x) && perto(depois.y, antes.y), 'Ctrl+rolagem para baixo afasta, ponto continua sob o cursor', { c, antes, depois });
  conferir((await pct()) === Math.round(c.zoom * 100) + '%', 'indicador de zoom acompanha', await pct());

  // ── 3. Rolagem sem Ctrl desloca ──
  await resetCam();
  await roda(px, py, 0, 120); await roda(px, py, 60, 0);
  c = await cam();
  conferir(perto(c.y, 120) && perto(c.x, 60) && c.zoom === 1, 'rolagem sem Ctrl desloca a câmera sem mudar o zoom', c);
  await resetCam();
  await roda(px, py, 0, 100, 8); // Shift: vertical vira horizontal
  c = await cam();
  conferir(perto(c.x, 100) && perto(c.y, 0), 'Shift + rolagem desloca na horizontal', c);

  // ── 4. Pan ──
  await resetCam();
  await av(`document.querySelector('.wb-palco').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await dormir(60);
  conferir((await av(`Whiteboard.nucleo.ferramenta()`)) === 'selecionar', 'Espaço segurado não troca a ferramenta');
  await arrastar(px, py, px + 80, py + 50);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  c = await cam();
  conferir(perto(c.x, -80, 1) && perto(c.y, -50, 1), 'Espaço + arrastar move a vista', c);
  conferir((await av(`Whiteboard.nucleo.selecao().length`)) === 0, 'Espaço + arrastar não seleciona nem move elementos');
  await resetCam();
  await arrastar(px, py, px - 60, py - 40, 'middle');
  c = await cam();
  conferir(perto(c.x, 60, 1) && perto(c.y, 40, 1), 'botão do meio + arrastar move a vista', c);
  await resetCam();
  await arrastar(1000, 700, 1050, 740);
  c = await cam();
  conferir(c.x === 0 && c.y === 0, 'sem Espaço, arrastar no vazio não move a câmera', c);

  // ── 5. Limites de zoom ──
  await resetCam();
  for (let i = 0; i < 40; i++) await roda(px, py, 0, 40, 2);
  await dormir(500);
  c = await cam();
  conferir(perto(c.zoom, 0.1, 1e-6) && (await pct()) === '10%', 'zoom mínimo 10%', { c, p: await pct() });
  for (let i = 0; i < 80; i++) await roda(px, py, 0, -40, 2);
  await dormir(500);
  c = await cam();
  conferir(perto(c.zoom, 8, 1e-6) && (await pct()) === '800%', 'zoom máximo 800%', { c, p: await pct() });
  await av(`Whiteboard.nucleo.zoomEm(0.001, 100, 100, false)`);
  conferir(perto((await cam()).zoom, 0.1, 1e-6), 'zoomEm abaixo do mínimo é limitado a 10%');
  await av(`Whiteboard.nucleo.zoomEm(99, 100, 100, false)`);
  conferir(perto((await cam()).zoom, 8, 1e-6), 'zoomEm acima do máximo é limitado a 800%');

  // ── 6. Ajustar à tela e 100% ──
  const caixaNaTela = () => av(`(() => { const n = Whiteboard.nucleo, t = n.tamanho(), z = n.camera().zoom;
    const cx = n.elementos().map((e) => n.caixaMundo(e));
    const x0 = Math.min(...cx.map((b) => b.x)), y0 = Math.min(...cx.map((b) => b.y)), x1 = Math.max(...cx.map((b) => b.x + b.w)), y1 = Math.max(...cx.map((b) => b.y + b.h));
    return { z, a: (({ sx, sy }) => ({ x: sx, y: sy }))(n.mundoParaTela(x0, y0)), b: (({ sx, sy }) => ({ x: sx, y: sy }))(n.mundoParaTela(x1, y1)), t }; })()`);
  await av(`Whiteboard.nucleo.definirCamera({ x: 5000, y: 5000, zoom: 3 }, { animar: false })`);
  await av(`document.querySelector('[data-zoom="ajustar"]').click()`);
  await esperar(`Whiteboard.nucleo.camera().zoom < 3`, 6000); await assentar();
  r = await caixaNaTela();
  conferir(r.a.x >= 0 && r.a.y >= 0 && r.b.x <= r.t.w && r.b.y <= r.t.h && r.z < 3 && r.z > 0.3, 'botão Ajustar à tela enquadra todos os elementos dentro da vista', r);
  await av(`document.querySelector('.wb-zoom-pct').click()`);
  await esperar(`Math.abs(Whiteboard.nucleo.camera().zoom - 1) < 1e-3`, 6000); await assentar();
  c = await cam();
  conferir(perto(c.zoom, 1, 1e-3), 'clicar no percentual volta a 100%', c);
  await av(`Whiteboard.nucleo.definirCamera({ x: 5000, y: 5000, zoom: 3 }, { animar: false }); document.querySelector('.wb-palco').focus()`);
  await tecla('!', 'Digit1', 8);
  await esperar(`Whiteboard.nucleo.camera().zoom < 3`, 6000); await assentar();
  r = await caixaNaTela();
  conferir(r.z < 3 && r.a.x >= 0 && r.a.y >= 0 && r.b.x <= r.t.w && r.b.y <= r.t.h, 'Shift+1 ajusta à tela', r);

  // ── 7. Salvamento automático ──
  await resetCam();
  // a câmera pendente (2 s) precisa gravar antes: sem salvamento marcado e status salvo, nada além do arrastar pode disparar o POST
  conferir(await esperar(`!Whiteboard.estado().pendente && Whiteboard.estado().status === 'salvo'`, 6000), 'antes do arraste não há salvamento pendente (status salvo)', await av(`Whiteboard.estado()`));
  // Medição válida só se a página ficou visível: ao ficar oculta (visibilitychange) o app grava na hora, por projeto
  // (linha do visibilitychange no núcleo); então a tentativa é repetida (até 4x) e a ocultação aparece na mensagem.
  let a0, movido, pendCedo, cedo, chegou, tp, dt, tentativas = 0;
  do {
    tentativas++;
    await esperar(`!Whiteboard.estado().pendente && Whiteboard.estado().status === 'salvo'`, 6000);
    await dormir(300);
    await av(`demo.reqs.length = 0`);
    a0 = await av(`(() => { const e = Whiteboard.nucleo.elemento('ea'); const p = Whiteboard.nucleo.mundoParaTela(e.x + 100, e.y + 60); return { x: e.x, y: e.y, sx: p.sx, sy: p.sy }; })()`);
    // relógio da página: soltar o ponteiro (pointerup) -> chegada do POST de salvar (independe da lentidão do CDP)
    await av(`(() => {
      window.__wbT = { vis: [], up: null, sv: null };
      if (window.__wbHook) return;
      window.__wbHook = true;
      window.addEventListener('pointerup', () => { window.__wbT.up = performance.now(); }, true);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') window.__wbT.vis.push(performance.now()); });
      const push = demo.reqs.push.bind(demo.reqs);
      demo.reqs.push = (...a) => { if (a[0] && a[0][1] === '/whiteboard/salvar' && window.__wbT.sv == null) window.__wbT.sv = performance.now(); return push(...a); };
    })()`);
    await arrastar(ret.l + a0.sx, ret.t + a0.sy, ret.l + a0.sx + 70, ret.t + a0.sy + 30);
    movido = await av(`(({ x, y }) => { const e = Whiteboard.nucleo.elemento('ea'); return { dx: e.x - x, dy: e.y - y }; })(${JSON.stringify(a0)})`);
    cedo = (await reqs()).filter((x) => x[1] === '/whiteboard/salvar').length;
    pendCedo = await av(`Whiteboard.estado().pendente`);
    chegou = await esperar(`demo.reqs.some((x) => x[1] === '/whiteboard/salvar')`, 3000);
    tp = await av(`window.__wbT`);
    dt = tp.sv != null && tp.up != null ? tp.sv - tp.up : -1;
    if (tp.vis.length) await av(`Whiteboard.nucleo.atualizar('ea', { x: ${a0.x}, y: ${a0.y} }); Whiteboard.nucleo.confirmar('voltar')`);
  } while (tp.vis.length && tentativas < 4);
  conferir(perto(movido.dx, 70, 1) && perto(movido.dy, 30, 1), 'arrastar um retângulo com a ferramenta Selecionar o move', movido);
  conferir(cedo === 0 && pendCedo, 'a gravação espera (não grava na hora)', cedo);
  const sv = (await reqs()).filter((x) => x[1] === '/whiteboard/salvar');
  const corpo = sv[0]?.[2];
  conferir(chegou && dt >= 450 && dt < 2500, 'salvamento automático chega ~600 ms depois da mudança', { dt, tp, tentativas });
  conferir(sv[0]?.[0] === 'POST' && corpo?.id === (await av(`Whiteboard.quadro().id`)) && corpo?.camera && typeof corpo.camera.zoom === 'number' && Array.isArray(corpo.elementos) && corpo.elementos.length === 3
    && perto(corpo.elementos.find((e) => e.id === 'ea').x, a0.x + 70, 1) && !JSON.stringify(corpo).includes('"_'), 'POST /whiteboard/salvar leva id, camera e elementos (sem campos "_")', corpo && { id: corpo.id, camera: corpo.camera, n: corpo.elementos?.length });
  await esperar(`Whiteboard.estado().status === 'salvo'`, 2000);
  conferir((await av(`Whiteboard.estado().status`)) === 'salvo' && !(await av(`Whiteboard.estado().pendente`)), 'status volta a "salvo"', await av(`Whiteboard.estado()`));
  await av(`demo.reqs.length = 0`);
  await av(`Whiteboard.nucleo.definirCamera({ x: 33, y: 44, zoom: 1.5 }, { animar: false })`);
  const camSalva = await esperar(`demo.reqs.some((x) => x[1] === '/whiteboard/salvar')`, 4500);
  const sv2 = (await reqs()).find((x) => x[1] === '/whiteboard/salvar');
  conferir(camSalva && perto(sv2[2].camera.x, 33) && perto(sv2[2].camera.zoom, 1.5), 'só mudar a câmera também grava', sv2?.[2]?.camera);

  // ── 8. Renomear, duplicar, excluir ──
  const id1 = await av(`Whiteboard.quadro().id`);
  await av(`document.querySelector('.wb-quadro-btn').click()`);
  await esperar(`!!document.querySelector('.wb-item')`);
  await av(`document.querySelector('.wb-item[data-id="${id1}"] [data-acao="lapis"]').click()`);
  conferir(await esperar(`document.activeElement && document.activeElement.classList.contains('wb-campo')`), 'Renomear abre o campo com foco');
  await cdp('Input.insertText', { text: 'Plano B' });
  await tecla('Enter', 'Enter', 0, 13);
  await esperar(`Whiteboard.quadro().nome === 'Plano B'`);
  r = await av(`({ nome: Whiteboard.quadro().nome, cab: document.querySelector('.wb-nome').textContent, item: document.querySelector('.wb-item[data-id="${id1}"] .wb-item-nome')?.textContent, campo: !!document.querySelector('.wb-campo') })`);
  conferir(r.nome === 'Plano B' && r.cab === 'Plano B' && r.item === 'Plano B' && !r.campo, 'renomear atualiza cabeçalho e lista', r);
  conferir((await reqs()).some((x) => x[1] === '/whiteboard/renomear' && x[2].id === id1 && x[2].nome === 'Plano B'), 'POST /whiteboard/renomear enviado');
  await av(`document.querySelector('.wb-item[data-id="${id1}"] [data-acao="lapis"]').click()`);
  await esperar(`!!document.querySelector('.wb-campo')`);
  await tecla('Escape', 'Escape', 0, 27);
  r = await av(`({ nome: Whiteboard.quadro().nome, campo: !!document.querySelector('.wb-campo'), painel: !!document.querySelector('.wb-painel') })`);
  conferir(r.nome === 'Plano B' && !r.campo && r.painel, 'Esc no renomear cancela e mantém o painel', r);
  await av(`document.querySelector('.wb-item[data-id="${id1}"] [data-acao="copiar"]').click()`);
  await esperar(`Whiteboard.quadro().id !== '${id1}'`);
  r = await av(`({ q: Whiteboard.quadro(), n: Whiteboard.nucleo.elementos().length, total: Whiteboard.quadros().length, ultimo: localStorage.getItem('orbit.whiteboard.ultimo') })`);
  const id2 = r.q.id;
  conferir(id2 !== id1 && r.n === 3 && r.total === 2 && /Plano B/.test(r.q.nome) && r.ultimo === id2, 'duplicar cria cópia com os elementos e abre a cópia', r);
  await av(`document.querySelector('.wb-quadro-btn').click()`);
  await esperar(`!!document.querySelector('.wb-item[data-id="${id2}"]')`);
  await av(`document.querySelector('.wb-item[data-id="${id2}"] [data-acao="lixeira"]').click()`);
  await esperar(`!!document.querySelector('.wb-dialogo')`);
  r = await av(`({ foco: document.activeElement?.textContent, titulo: document.querySelector('.wb-dialogo h2')?.textContent, ainda: Whiteboard.quadros().length })`);
  conferir(r.foco === 'Cancelar' && /Excluir/.test(r.titulo) && r.ainda === 2, 'excluir pede confirmação, foco em Cancelar, nada apagado ainda', r);
  await tecla('Escape', 'Escape', 0, 27);
  await dormir(300);
  await esperar(`!document.querySelector('.wb-dialogo')`, 1500);
  r = await av(`({ dlg: !!document.querySelector('.wb-dialogo'), total: Whiteboard.quadros().length, post: demo.reqs.some((x) => x[1] === '/whiteboard/excluir') })`);
  conferir(!r.dlg && r.total === 2 && !r.post, 'Esc cancela a exclusão', r);
  await av(`document.querySelector('.wb-quadro-btn').click()`);
  await esperar(`!!document.querySelector('.wb-item[data-id="${id2}"]')`);
  await av(`document.querySelector('.wb-item[data-id="${id2}"] [data-acao="lixeira"]').click()`);
  await esperar(`!!document.querySelector('.wb-dialogo')`);
  await av(`document.querySelector('.wb-btn-perigo').click()`);
  await esperar(`Whiteboard.quadro() && Whiteboard.quadro().id === '${id1}'`);
  await esperar(`!document.querySelector('.wb-dialogo')`, 1500);
  r = await av(`({ id: Whiteboard.quadro().id, total: Whiteboard.quadros().length, dlg: !!document.querySelector('.wb-dialogo'), post: demo.reqs.some((x) => x[1] === '/whiteboard/excluir' && x[2].id === '${id2}') })`);
  conferir(r.id === id1 && r.total === 1 && !r.dlg && r.post, 'confirmar exclui, fecha o diálogo e abre o outro quadro', r);

  // ── 9. Recarregar abre o último ──
  await av(`document.querySelector('.wb-quadro-btn').click()`);
  await esperar(`!!document.querySelector('.wb-novo')`);
  await av(`document.querySelector('.wb-novo').click()`);
  await esperar(`Whiteboard.quadro().id !== '${id1}'`);
  const idNovo = await av(`Whiteboard.quadro().id`);
  await abrir();
  r = await av(`({ id: Whiteboard.quadro().id, ultimo: localStorage.getItem('orbit.whiteboard.ultimo') })`);
  conferir(r.id === idNovo && r.ultimo === idNovo, 'recarregar abre o último quadro', { ...r, esperado: idNovo });

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
