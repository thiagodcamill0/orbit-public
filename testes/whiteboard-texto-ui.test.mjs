// Teste de texto, nota adesiva e borracha (assets/whiteboard-texto.js) contra testes/whiteboard-demo.html.
// Servidor estático próprio (só GET) numa porta livre de 47822–47826, Edge headless mudo, perfil temporário apagado, fecharEdge no fim.
// O duplo clique do núcleo não é usado: editar/criarEm são chamados direto (window.WhiteboardTexto).
// node testes/whiteboard-texto-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-tx-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47824);
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
  const tecla = async (key, code, vk = 0, text) => {
    const p = { key, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(80);
  };
  const mouse = (type, x, y, button = 'none', buttons = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const clicar = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'left', 1); await mouse('mouseReleased', x, y, 'left', 0); await dormir(120); };
  const arrastar2 = async (x0, y0, x1, y1) => { await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1); for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, 'left', 1); await mouse('mouseReleased', x1, y1, 'left', 0); await dormir(150); };
  const digitar = async (s) => { await cdp('Input.insertText', { text: s }); await dormir(80); };
  const resetCam = () => av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(200);
  };
  const els = () => av(`Whiteboard.nucleo.elementos().map((e) => ({ id: e.id, tipo: e.tipo, x: e.x, y: e.y, w: e.w, h: e.h, v: e.texto && e.texto.valor, op: e.opacidade, ap: !!e._esmaecer }))`);
  const campo = () => av(`(() => { const t = document.querySelector('.wb-tx-campo'); if (!t) return null; const r = t.getBoundingClientRect(); return { v: t.value, w: r.width, h: r.height, foco: document.activeElement === t }; })()`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await resetCam();
  const of = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const T = (x, y) => [of.l + x, of.t + y]; // mundo (zoom 1, câmera 0) → tela
  await av(`window.rotulos = []; Whiteboard.nucleo.on('confirmar', (d) => rotulos.push(d && d.rotulo))`);

  // ── 1. Texto ──
  let r = await av(`[...document.querySelectorAll('.wb-barra .wb-ferr')].map((b) => b.dataset.ferramenta)`);
  conferir(['texto', 'nota', 'borracha'].every((n) => r.includes(n)), 'barra tem texto, nota e borracha', r);
  await tecla('t', 'KeyT', 84, 't');
  conferir((await av(`Whiteboard.nucleo.ferramenta()`)) === 'texto', 'tecla T ativa a ferramenta texto');
  await clicar(...T(300, 200));
  let c = await campo();
  conferir(c && c.foco, 'clicar com a ferramenta texto cria e já edita (campo focado)', c);
  await digitar('Olá');
  await tecla('Enter', 'Enter', 13, '\r');
  await digitar('mundo');
  let e = (await els())[0];
  conferir(e && e.tipo === 'texto' && e.v === 'Olá\nmundo' && e.w > 10 && e.h > 40, 'digitar com Enter quebra linha e a caixa acompanha o texto', e);
  const larg1 = (await campo()).w;
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 2 }, { animar: false })`);
  await dormir(150);
  c = await campo();
  conferir(c && Math.abs(c.w / larg1 - 2) < 0.1, 'campo acompanha o zoom', { larg1, c });
  await resetCam();
  await tecla('Escape', 'Escape', 27);
  r = await av(`({ campo: !!document.querySelector('.wb-tx-campo'), f: Whiteboard.nucleo.ferramenta(), sel: Whiteboard.nucleo.selecao(), rot: rotulos.slice() })`);
  e = (await els())[0];
  conferir(!r.campo && r.f === 'selecionar' && r.sel[0] === e.id && r.rot.includes('Criar texto'), 'Esc termina, volta a selecionar com o texto selecionado e confirma', r);

  // vazio some
  await tecla('t', 'KeyT', 84, 't');
  await clicar(...T(300, 400));
  conferir(!!(await campo()), 'segundo clique abre outro campo');
  await tecla('Escape', 'Escape', 27);
  conferir((await els()).length === 1 && !(await campo()), 'texto vazio ao terminar é removido');

  // editar() reabre
  await av(`WhiteboardTexto.editar(Whiteboard.nucleo.elementos()[0].id)`);
  c = await campo();
  conferir(c && c.v === 'Olá\nmundo' && c.foco, 'editar() reabre o campo com o texto', c);
  await digitar('!');
  await tecla('Escape', 'Escape', 27);
  e = (await els())[0];
  conferir(e.v === 'Olá\nmundo!' && (await av(`rotulos.includes('Editar texto')`)), 'editar() e Esc gravam a mudança', e);

  // clicar fora termina
  await av(`WhiteboardTexto.editar(Whiteboard.nucleo.elementos()[0].id)`);
  await clicar(...T(900, 600));
  conferir(!(await campo()), 'clicar fora termina a edição');

  // ── 2. Nota ──
  await tecla('s', 'KeyS', 83, 's');
  await clicar(...T(700, 300));
  c = await campo();
  conferir(c && c.foco, 'ferramenta nota (S): clicar cria e edita', c);
  await digitar('Uma nota com bastante texto para quebrar em varias linhas');
  await tecla('Escape', 'Escape', 27);
  const nota = (await els()).find((x) => x.tipo === 'nota');
  conferir(nota && nota.w === 200 && nota.h === 200 && nota.v.startsWith('Uma nota') && (await av(`Whiteboard.nucleo.selecao()[0]`)) === nota.id && (await av(`Whiteboard.nucleo.ferramenta()`)) === 'selecionar', 'nota 200x200 com texto, selecionada depois de editar', nota);
  const l200 = await av(`WhiteboardTexto.quebrar(Whiteboard.nucleo.elemento('${nota.id}')).length`);
  await av(`Whiteboard.nucleo.atualizar('${nota.id}', { w: 100 })`);
  const l100 = await av(`WhiteboardTexto.quebrar(Whiteboard.nucleo.elemento('${nota.id}')).length`);
  conferir(l200 >= 2 && l100 > l200, 'o texto da nota reflui ao mudar a largura', { l200, l100 });

  // ── 3. Borracha ──
  await av(`Whiteboard.nucleo.remover(Whiteboard.nucleo.elementos().map((x) => x.id))`);
  await av(`[100, 250, 400, 600, 800].forEach((x, i) => Whiteboard.nucleo.adicionar({ id: 'r' + i, tipo: 'retangulo', x, y: 480, w: 100, h: 60, cor: '#7aa2ff', preenchimento: '#7aa2ff55' }))`);
  await av(`Whiteboard.nucleo.selecionar([]); rotulos.length = 0`);
  await tecla('e', 'KeyE', 69, 'e');
  conferir((await av(`Whiteboard.nucleo.ferramenta()`)) === 'borracha', 'tecla E ativa a borracha');
  const [x0, y0] = T(80, 510);
  await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1);
  for (let i = 1; i <= 12; i++) { const [xx, yy] = T(80 + i * 30, 510); await mouse('mouseMoved', xx, yy, 'left', 1); await dormir(15); }
  let es = await els();
  conferir(es.filter((x) => x.ap && x.op === 1).length === 3 && es.length === 5, 'arrastar marca os elementos (esmaecidos) sem apagar ainda', es);
  const [x1, y1] = T(440, 510);
  await mouse('mouseReleased', x1, y1, 'left', 0); await dormir(120);
  es = await els();
  r = await av(`({ rot: rotulos.slice(), f: Whiteboard.nucleo.ferramenta() })`);
  conferir(es.length === 2 && r.rot.filter((x) => x === 'Apagar').length === 1 && r.f === 'borracha', 'soltar apaga os vários de uma vez (um confirmar) e a borracha continua ativa', { es, r });
  await clicar(...T(650, 510));
  es = await els();
  conferir(es.length === 1 && es[0].id === 'r4', 'clique simples apaga o elemento sob o ponteiro', es);
  // Esc cancela
  const [x2, y2] = T(780, 510);
  await mouse('mouseMoved', x2, y2); await mouse('mousePressed', x2, y2, 'left', 1);
  await mouse('mouseMoved', x2 + 60, y2 + 5, 'left', 1); await dormir(50);
  const marcado = (await els())[0].ap;
  await tecla('Escape', 'Escape', 27);
  await mouse('mouseReleased', x2 + 60, y2 + 5, 'left', 0); await dormir(120);
  es = await els();
  conferir(marcado && es.length === 1 && es[0].op === 1 && !es[0].ap, 'Esc cancela: nada é apagado e a opacidade volta', { marcado, es });

  // ── 4. Salvar sem campos "_" ──
  await av(`Whiteboard.salvarAgora()`);
  await esperar(`demo.reqs.some((x) => x[1] === '/whiteboard/salvar')`);
  r = await av(`(() => { const s = demo.reqs.filter((x) => x[1] === '/whiteboard/salvar').pop(); return s ? { n: s[2].elementos.length, sujo: s[2].elementos.some((e) => Object.keys(e).some((k) => k[0] === '_')) } : null; })()`);
  conferir(r && r.n === 1 && r.sujo === false, 'salvar leva os elementos sem campos "_"', r);

  // ── 5. Duplo clique real (CDP, clickCount 2) com a ferramenta Selecionar ──
  const duplo = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await dormir(200);
  };
  await av(`Whiteboard.nucleo.remover(Whiteboard.nucleo.elementos().map((e) => e.id))`);
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);
  const LONGO = 'um dois três quatro cinco seis sete oito nove dez onze doze treze';
  await av(`(() => { const n = Whiteboard.nucleo; n.adicionar({ id: 'dt', tipo: 'texto', x: 100, y: 100, w: 120, h: 30, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, texto: { valor: 'Alvo', tamanho: 20, alinhar: 'esquerda' } });
    n.adicionar({ id: 'dn', tipo: 'nota', x: 400, y: 100, w: 200, h: 200, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, texto: { valor: ${JSON.stringify(LONGO)}, tamanho: 16, alinhar: 'esquerda' } }); n.redesenhar(); })()`);
  await dormir(150);
  await duplo(...T(130, 115));
  c = await campo();
  conferir(c && c.foco && c.v === 'Alvo', 'duplo clique sobre um texto abre a edição dele', c);
  await clicar(...T(200, 650));
  conferir((await campo()) === null, 'clicar fora fecha a edição');
  await duplo(...T(500, 200));
  c = await campo();
  conferir(c && c.foco && c.v === LONGO, 'duplo clique sobre uma nota abre a edição dela', c && { v: c.v });
  await clicar(...T(200, 650));
  const antes = await av(`WhiteboardTexto.quebrar(Whiteboard.nucleo.elemento('dn')).length`);
  await clicar(...T(500, 200));
  await arrastar2(...T(600, 300), ...T(740, 300));
  const dn = (await els()).find((x) => x.id === 'dn');
  const depois = await av(`WhiteboardTexto.quebrar(Whiteboard.nucleo.elemento('dn')).length`);
  conferir(dn && dn.w > 300 && depois < antes, 'redimensionar a nota pela alça reflui o texto (menos linhas)', { w: dn && dn.w, antes, depois });
  await arrastar2(...T(740, 300), ...T(420, 300));
  const mini = (await els()).find((x) => x.id === 'dn');
  conferir(mini && Math.abs(mini.w) >= 80, 'a nota respeita o tamanho mínimo ao encolher', mini && mini.w);
  await clicar(...T(200, 650));
  const antesN = (await els()).length;
  await duplo(...T(200, 600));
  c = await campo();
  conferir(c && c.foco, 'duplo clique no vazio (Selecionar) cria um texto e já edita', c);
  await digitar('criado');
  await clicar(...T(900, 700));
  const novoEl = (await els()).find((x) => x.tipo === 'texto' && x.v === 'criado');
  conferir(novoEl && (await els()).length === antesN + 1, 'o texto criado por duplo clique permanece', novoEl);

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard texto UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
