// Teste de travar e destravar elementos do Whiteboard (acoes, Ctrl+Shift+L, arrastar, Delete, borracha, laco, Ctrl+A, grupo, historico, salvar)
// contra testes/whiteboard-demo.html (fetch falso em memória). Servidor estático próprio numa porta livre de
// 47822–47826, Edge headless mudo, perfil temporário apagado no fim, Edge fechado com fecharEdge.
// node testes/whiteboard-edicao-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-trv-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

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
  pcdp = 9750 + Math.floor(Math.random() * 150);
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
  const SHIFT = 8, ALT = 1;
  const tecla = async (key, code, mods = 0, vk = 0) => {
    const p = { key, code, windowsVirtualKeyCode: vk, modifiers: mods };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(60);
  };
  const mouse = (type, x, y, button = 'none', buttons = 0, modifiers = 0, clickCount = 1) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : clickCount });
  const arrastar = async (x0, y0, x1, y1, mods = 0) => {
    await mouse('mouseMoved', x0, y0, 'none', 0, mods); await mouse('mousePressed', x0, y0, 'left', 1, mods);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, 'left', 1, mods); await dormir(15); }
    await mouse('mouseReleased', x1, y1, 'left', 0, mods); await dormir(60);
  };
  const duplo = async (x, y) => {
    await mouse('mouseMoved', x, y);
    for (const n of [1, 2]) { await mouse('mousePressed', x, y, 'left', 1, 0, n); await mouse('mouseReleased', x, y, 'left', 0, 0, n); }
    await dormir(80);
  };
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(200);
  };
  const salvos = () => av(`demo.reqs.filter((x) => x[0] === 'POST' && x[1].endsWith('/salvar')).length`);
  const get = (id) => av(`JSON.parse(JSON.stringify(Whiteboard.nucleo.elemento(${JSON.stringify(id)})))`);
  const cursor = () => av(`document.querySelector('.wb-palco').style.cursor`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir('?vazio=1');
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const pal = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const L = pal.l, T = pal.t;
  await av(`window.__rot = []; Whiteboard.nucleo.on('confirmar', (d) => __rot.push(d.rotulo)); const i = document.createElement('input'); i.id = 'campo'; i.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;width:50px'; document.body.append(i);`);

  const CTRL = 2;
  const base = (o) => ({ tipo: 'retangulo', x: 100, y: 100, w: 200, h: 120, angulo: 0, cor: '#7aa2ff', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, ...o });
  const foco = () => av(`document.querySelector('.wb-palco').focus()`);
  const cena = async (lista, sel) => {
    await av(`(() => { const n = Whiteboard.nucleo; n.remover(n.elementos().map((e) => e.id)); for (const e of ${JSON.stringify(lista)}) n.adicionar(e); n.selecionar(${JSON.stringify(sel)}); n.redesenhar(); window.__rot = []; })()`);
    await foco(); await dormir(80);
  };
  const passo = async (nome, rotulo, fn) => {
    const n0 = await salvos();
    await fn();
    const gravou = await esperar(`demo.reqs.filter((x) => x[0] === 'POST' && x[1].endsWith('/salvar')).length > ${n0}`, 3500);
    const rots = await av(`__rot`);
    conferir(rots.includes(rotulo) && gravou, nome + ': confirmar("' + rotulo + '") e salvar', { rots, gravou });
  };
  const todos = () => av(`JSON.parse(JSON.stringify(Whiteboard.nucleo.elementos()))`);
  const sel = () => av(`Whiteboard.nucleo.selecao()`);
  const ordem = () => av(`Whiteboard.nucleo.elementos().map((e) => e.id).join('')`);
  const zs = () => av(`Whiteboard.nucleo.elementos().map((e) => e.z).join(',')`);
  const acao = (js) => av(`Promise.resolve(Whiteboard.acoes.${js})`);
  const px = (x, y) => [L + x, T + y];
  const travado = (id) => av(`!!Whiteboard.nucleo.elemento(${JSON.stringify(id)}).travado`);
  const cadeados = () => av(`Whiteboard.estado().cadeados`);
  const clicar = async (x, y, mods = 0) => { await mouse('mouseMoved', x, y, 'none', 0, mods); await mouse('mousePressed', x, y, 'left', 1, mods); await mouse('mouseReleased', x, y, 'left', 0, mods); await dormir(80); };
  const trava = (id, v = true) => av(`(() => { const e = Whiteboard.nucleo.elemento(${JSON.stringify(id)}); if (${v}) e.travado = true; else delete e.travado; Whiteboard.nucleo.redesenhar(); })()`);

  conferir(await av(`['travar','destravar','alternarTrava'].every((k) => typeof Whiteboard.acoes[k] === 'function') && typeof Whiteboard.nucleo.travado === 'function'`), 'acoes.travar/destravar/alternarTrava e nucleo.travado existem');

  // ── Travar pela ação ──
  const A = base({ id: 'a', x: 100, y: 100, w: 200, h: 120, preenchimento: '#334' }), B = base({ id: 'b', x: 500, y: 100, w: 100, h: 100, preenchimento: '#343' });
  await cena([A, B], ['a']);
  const c0 = await cadeados();
  await passo('travar (ação)', 'Travar', () => acao('travar()'));
  conferir((await travado('a')) && !(await travado('b')), 'travar marca só o selecionado');
  await av(`Whiteboard.nucleo.redesenhar()`); await dormir(150);
  const c1 = await cadeados();
  conferir(c1 > c0, 'cadeado desenhado na seleção do travado', [c0, c1]);
  await av(`Whiteboard.nucleo.selecionar([])`); await dormir(150);
  const c2 = await cadeados(); await av(`Whiteboard.nucleo.redesenhar()`); await dormir(150);
  conferir((await cadeados()) === c2, 'sem seleção não há cadeado', [c2, await cadeados()]);
  await av(`Whiteboard.nucleo.selecionar(['a'])`); await dormir(100);

  // sem alças: a quina e o ponto de giro não fazem nada
  await arrastar(...px(304, 224), ...px(404, 324));
  let a = await get('a');
  conferir(a.w === 200 && a.h === 120 && a.x === 100 && a.y === 100, 'travado: sem alça de redimensionar', a);
  await arrastar(...px(200, 78), ...px(300, 60));
  a = await get('a');
  conferir(a.angulo === 0 && a.x === 100, 'travado: sem alça de giro', a);
  // arrastar sobre ele
  await arrastar(...px(200, 160), ...px(300, 300));
  a = await get('a');
  conferir(a.x === 100 && a.y === 100, 'travado: arrastar sobre ele não move', a);
  conferir(JSON.stringify(await sel()) === '["a"]', 'travado: arrastar a partir dele mantém a seleção (sem laço)', await sel());
  await av(`Whiteboard.nucleo.selecionar([])`);
  await clicar(...px(200, 160));
  conferir(JSON.stringify(await sel()) === '["a"]', 'clique seleciona o travado');

  // seleção mista: só o destravado se move
  await av(`Whiteboard.nucleo.selecionar(['a','b'])`);
  await arrastar(...px(550, 150), ...px(600, 250));
  a = await get('a'); let b = await get('b');
  conferir(a.x === 100 && a.y === 100 && perto(b.x, 550, 1) && perto(b.y, 200, 1), 'seleção mista: só o destravado se move', [a.x, a.y, b.x, b.y]);
  await cena([A, B], []);
  await trava('a');

  // teclado
  await av(`Whiteboard.nucleo.selecionar(['a'])`); await foco();
  await tecla('ArrowRight', 'ArrowRight', 0, 39);
  conferir((await get('a')).x === 100, 'seta do teclado não move travado');
  await tecla('Delete', 'Delete', 0, 46);
  conferir(!!(await get('a')), 'Delete não apaga travado');
  await acao('apagar()');
  conferir(!!(await get('a')), 'acoes.apagar não apaga travado');

  // estilo
  await av(`Whiteboard.nucleo.atualizar('a', { cor: '#ff0000', opacidade: 0.5 })`);
  a = await get('a');
  conferir(a.cor === '#7aa2ff' && a.opacidade === 1, 'estilo em travado não muda', [a.cor, a.opacidade]);

  // borracha
  await av(`Whiteboard.nucleo.definirFerramenta('borracha')`);
  await arrastar(...px(60, 160), ...px(340, 160));
  await dormir(100);
  conferir(!!(await get('a')) && !(await av(`!!Whiteboard.nucleo.elemento('a')._esmaecer`)), 'borracha passa por cima do travado sem apagar nem esmaecer');
  await arrastar(...px(450, 150), ...px(650, 150));
  await dormir(100);
  conferir(!(await get('b')), 'borracha ainda apaga o destravado');
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);

  // laço e Ctrl+A
  await cena([A, base({ id: 'b', x: 500, y: 100, w: 100, h: 100 })], []);
  await trava('a');
  await arrastar(...px(700, 450), ...px(20, 60));
  conferir(JSON.stringify(await sel()) === '["b"]', 'laço não seleciona travados', await sel());
  await av(`Whiteboard.nucleo.selecionar([])`); await foco();
  await tecla('a', 'KeyA', CTRL, 65);
  conferir(JSON.stringify(await sel()) === '["b"]', 'Ctrl+A não inclui travados', await sel());
  await av(`Whiteboard.nucleo.selecionar([])`);
  await acao('selecionarTudo()');
  conferir(JSON.stringify(await sel()) === '["b"]', 'acoes.selecionarTudo não inclui travados');

  // alinhar / camada / agrupar ignoram
  await cena([A, base({ id: 'b', x: 500, y: 300, w: 100, h: 100 })], ['a', 'b']);
  await trava('a');
  await acao('alinhar("base")'); await acao('camada("frente")');
  const gAg = await acao('agrupar()');
  a = await get('a'); b = await get('b');
  conferir(a.y === 100 && a.z === 1 && !a.grupo && b.y === 300 && gAg === false, 'alinhar/camada/agrupar ignoram travados', [a.y, a.z, a.grupo, b.y, gAg]);

  // duplo clique: texto travado não edita; destravado edita
  await cena([base({ id: 't', tipo: 'texto', x: 100, y: 100, w: 200, h: 40, texto: { valor: 'oi', tamanho: 20, alinhar: 'esquerda' } })], []);
  await trava('t');
  await duplo(...px(150, 120));
  conferir(!(await av(`!!document.querySelector('textarea')`)), 'duplo clique em texto travado não abre edição');
  await trava('t', false);
  await duplo(...px(150, 120));
  conferir(await av(`!!document.querySelector('textarea')`), 'destravado: duplo clique edita (controle)');
  await tecla('Escape', 'Escape', 0, 27);

  // ── Atalho Ctrl+Shift+L, grupo, histórico ──
  await cena([base({ id: 'g1', x: 100, y: 100, w: 50, h: 50, grupo: 'G', preenchimento: '#334' }), base({ id: 'g2', x: 200, y: 100, w: 50, h: 50, grupo: 'G' }), base({ id: 'o', x: 400, y: 100, w: 50, h: 50 })], ['g1']);
  await av(`Whiteboard.nucleo.confirmar('cena'); window.__rot = []`); await dormir(80);
  await passo('travar (Ctrl+Shift+L)', 'Travar', () => tecla('L', 'KeyL', CTRL | SHIFT, 76));
  conferir((await travado('g1')) && (await travado('g2')) && !(await travado('o')), 'travar um membro trava o grupo inteiro');
  await av(`Whiteboard.nucleo.desfazer()`); await dormir(80);
  conferir(!(await travado('g1')) && !(await travado('g2')), 'desfazer destrava o grupo');
  await av(`Whiteboard.nucleo.refazer()`); await dormir(80);
  conferir((await travado('g1')) && (await travado('g2')), 'refazer trava de novo');
  await av(`Whiteboard.nucleo.selecionar(['g2'])`);
  await passo('destravar (ação)', 'Destravar', () => acao('destravar()'));
  conferir(!(await travado('g1')) && !(await travado('g2')) && !('travado' in (await get('g1'))), 'destravar solta o grupo inteiro e remove o campo');
  await arrastar(...px(125, 125), ...px(155, 205));
  conferir(perto((await get('g1')).x, 130, 1), 'destravado volta a mover', (await get('g1')).x);
  await av(`Whiteboard.nucleo.selecionar(['g1'])`); await foco();
  await tecla('L', 'KeyL', CTRL | SHIFT, 76);
  const t1 = await travado('g1');
  await tecla('L', 'KeyL', CTRL | SHIFT, 76);
  conferir(t1 && !(await travado('g1')), 'Ctrl+Shift+L alterna (travar e destravar)');

  // ── Salvar e recarregar ──
  await av(`Whiteboard.nucleo.selecionar(['o'])`);
  await passo('travar para salvar', 'Travar', () => acao('alternarTrava()'));
  const corpo = await av(`JSON.stringify(demo.reqs.filter((x) => x[0] === 'POST' && x[1].endsWith('/salvar')).pop()[2])`);
  conferir(/"travado":true/.test(corpo || ''), 'POST /whiteboard/salvar leva travado:true', (corpo || '').slice(0, 200));
  await esperar(`Whiteboard.estado().status === 'salvo'`, 3000);
  await abrir('?vazio=1');
  conferir(await av(`(() => { const e = Whiteboard.nucleo.elemento('o'); return !!e && e.travado === true && !Whiteboard.nucleo.elemento('g1').travado; })()`), 'ao recarregar o quadro, travado volta');

  // ── Texto travado: estilo de texto, ferramenta Texto e camada não o alteram ──
  await av(`(() => { const n = Whiteboard.nucleo; n.remover(n.elementos().map((e) => e.id)); n.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false });
    n.adicionar({ id: 'tt', tipo: 'texto', x: 200, y: 200, w: 120, h: 30, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, texto: { valor: 'fixo', tamanho: 20, alinhar: 'esquerda' }, travado: true });
    n.adicionar({ id: 'rr', tipo: 'retangulo', x: 500, y: 200, w: 80, h: 80, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1 });
    n.selecionar(['tt']); n.redesenhar(); })()`);
  await av(`Whiteboard.nucleo.atualizar('tt', { texto: { valor: 'fixo', tamanho: 40, alinhar: 'centro' } })`);
  conferir(await av(`(() => { const t = Whiteboard.nucleo.elemento('tt').texto; return t.tamanho === 20 && t.alinhar === 'esquerda'; })()`), 'texto travado: tamanho/alinhamento não mudam (núcleo bloqueia texto.*)');
  await av(`Whiteboard.nucleo.definirFerramenta('texto')`);
  await clicar(...px(210, 210)); await dormir(150);
  conferir(await av(`!document.querySelector('.wb-tx-campo')`), 'ferramenta Texto não abre edição em texto travado');
  await av(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  conferir(await av(`!!Whiteboard.nucleo.elemento('tt') && Whiteboard.nucleo.elemento('tt').texto.valor === 'fixo'`), 'texto travado segue intacto');
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar'); Whiteboard.nucleo.selecionar(['tt'])`);
  const z0 = await zs();
  await acao(`camada('frente')`); await acao(`camada('tras')`);
  conferir((await zs()) === z0, 'camada ignora elemento travado selecionado', { z0, z1: await zs() });

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard trava UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
