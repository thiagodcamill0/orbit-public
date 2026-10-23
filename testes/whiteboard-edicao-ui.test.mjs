// Teste das ações de edição do Whiteboard (agrupar, duplicar, copiar/colar, alinhar, camadas, atalhos)
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
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-edi-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

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
  const quatro = () => ['a', 'b', 'c', 'd'].map((id, i) => base({ id, x: 50 + i * 40, y: 50 + i * 30, w: 30, h: 30 }));

  conferir(await av(`typeof Whiteboard.acoes === 'object' && ['agrupar','desagrupar','duplicar','apagar','copiar','colar','alinhar','distribuir','camada','selecionarTudo'].every((k) => typeof Whiteboard.acoes[k] === 'function')`), 'Whiteboard.acoes tem as 10 ações do contrato');

  // ── Agrupar / desagrupar ──
  const A = base({ id: 'a' }), B = base({ id: 'b', x: 500, y: 100, w: 100, h: 100 }), C = base({ id: 'c', x: 300, y: 450, w: 50, h: 50 });
  await cena([A, B, C], ['a', 'b']);
  await passo('agrupar (ação)', 'agrupar', () => acao('agrupar()'));
  let l = await todos(); const ga = l.find((e) => e.id === 'a').grupo;
  conferir(ga && l.find((e) => e.id === 'b').grupo === ga && l.find((e) => e.id === 'c').grupo === null, 'agrupar dá o mesmo grupo aos dois e não toca no terceiro', l.map((e) => e.grupo));
  await av(`Whiteboard.nucleo.selecionar([])`);
  await mouse('mouseMoved', ...px(100, 160)); await mouse('mousePressed', ...px(100, 160), 'left', 1); await mouse('mouseReleased', ...px(100, 160), 'left', 0); await dormir(80);
  conferir(JSON.stringify((await sel()).sort()) === '["a","b"]', 'clicar num membro seleciona o grupo inteiro', await sel());
  await passo('desagrupar (Ctrl+Shift+G)', 'desagrupar', () => tecla('G', 'KeyG', CTRL | SHIFT, 71));
  l = await todos();
  conferir(l.every((e) => e.grupo === null), 'desagrupar zera o grupo', l.map((e) => e.grupo));
  await av(`Whiteboard.nucleo.selecionar(['a', 'c'])`);
  await passo('agrupar (Ctrl+G)', 'agrupar', () => tecla('g', 'KeyG', CTRL, 71));
  l = await todos();
  conferir(l.find((e) => e.id === 'a').grupo && l.find((e) => e.id === 'a').grupo === l.find((e) => e.id === 'c').grupo, 'Ctrl+G agrupa a seleção');
  await av(`Whiteboard.nucleo.selecionar(['a']); window.__rot = []`);
  await acao('agrupar()');
  conferir(!(await av(`__rot`)).includes('agrupar'), 'agrupar com 1 elemento não faz nada');

  // ── Duplicar ──
  await cena([A, B, C], ['a', 'b']);
  await acao('agrupar()');
  await av(`window.__rot = []`);
  await passo('duplicar (Ctrl+D)', 'duplicar', () => tecla('d', 'KeyD', CTRL, 68));
  l = await todos();
  const novos = await sel();
  const na = l.find((e) => e.id === novos[0]), nb = l.find((e) => e.id === novos[1]);
  conferir(l.length === 5 && novos.length === 2 && novos.every((i) => !['a', 'b', 'c'].includes(i)), 'duplicar cria 2 elementos com ids novos e os seleciona', { n: l.length, novos });
  conferir(na && nb && perto(na.x, 116, 0.01) && perto(na.y, 116, 0.01) && perto(nb.x, 516, 0.01) && perto(nb.y, 116, 0.01), 'duplicar desloca 16 px', { na, nb });
  conferir(na.grupo && na.grupo === nb.grupo && na.grupo !== l.find((e) => e.id === 'a').grupo, 'duplicar cria grupo novo para o grupo duplicado', l.map((e) => e.grupo));
  conferir(l.slice(-2).map((e) => e.id).join() === novos.join() && na.z > l.find((e) => e.id === 'c').z, 'duplicar mantém a ordem e fica por cima', await zs());

  // ── Apagar ──
  await cena([A, B, C], ['a', 'c']);
  await passo('apagar (ação)', 'excluir', () => acao('apagar()'));
  conferir((await ordem()) === 'b' && (await sel()).length === 0, 'apagar remove a seleção', await ordem());

  // ── Copiar / colar ──
  await cena([A, B, C], ['a', 'b']);
  await tecla('c', 'KeyC', CTRL, 67);
  await av(`Whiteboard.nucleo.selecionar([])`);
  await mouse('mouseMoved', ...px(600, 500)); await dormir(60); await foco();
  await passo('colar (Ctrl+V)', 'colar', () => tecla('v', 'KeyV', CTRL, 86));
  l = await todos();
  const col = await sel();
  const ca = l.find((e) => e.id === col[0]), cb = l.find((e) => e.id === col[1]);
  conferir(l.length === 5 && col.length === 2 && col.every((i) => !['a', 'b', 'c'].includes(i)), 'colar cria ids novos e seleciona', { n: l.length, col });
  // união original: x 100..600, y 100..220 → centro (350,160) vai para o ponteiro (600,500)
  conferir(ca && cb && perto(ca.x, 350, 0.6) && perto(ca.y, 440, 0.6) && perto(cb.x, 750, 0.6), 'colar põe o conjunto centrado no ponteiro', { ca, cb });
  await passo('colar de novo (Ctrl+V)', 'colar', () => tecla('v', 'KeyV', CTRL, 86));
  const c2 = await sel(); const cc = (await todos()).find((e) => e.id === c2[0]);
  conferir((await todos()).length === 7 && perto(cc.x, 366, 0.6) && perto(cc.y, 456, 0.6), 'segunda colagem no mesmo ponto desloca 16 px', cc);
  const clip = await av(`(async () => { try { return await navigator.clipboard.readText(); } catch { return null; } })()`);
  conferir(clip === null || clip === '' || (() => { try { const o = JSON.parse(clip); return o.orbit === 'orbit-whiteboard' && o.elementos.length === 2; } catch { return true; } })(), 'área de transferência, se legível, traz o JSON com a marca do Orbit', clip && clip.slice(0, 80));
  conferir(!(await todos()).some((e) => Object.keys(e).some((k) => k.startsWith('_'))), 'campos de execução (_) não são copiados');
  conferir(new Set((await todos()).map((e) => e.id)).size === 7, 'todos os ids continuam únicos');

  // ── Alinhar ──
  const A3 = base({ id: 'a' }), B3 = base({ id: 'b', x: 500, y: 300, w: 100, h: 100 }), C3 = base({ id: 'c', x: 300, y: 50, w: 50, h: 50 });
  const alin = async (lado, campo, esperado) => {
    await cena([A3, B3, C3], ['a', 'b', 'c']);
    await passo('alinhar ' + lado, 'alinhar', () => acao(`alinhar('${lado}')`));
    const o = Object.fromEntries((await todos()).map((e) => [e.id, e]));
    conferir(['a', 'b', 'c'].every((id, i) => perto(o[id][campo], esperado[i], 0.01)), `alinhar ${lado}: ${campo} = ${esperado.join(', ')}`, ['a', 'b', 'c'].map((id) => o[id][campo]));
  };
  await alin('esquerda', 'x', [100, 100, 100]);
  await alin('direita', 'x', [400, 500, 550]);
  await alin('centroH', 'x', [250, 300, 325]);
  await alin('topo', 'y', [50, 50, 50]);
  await alin('base', 'y', [280, 300, 350]);
  await alin('centroV', 'y', [165, 175, 200]);

  // ── Distribuir ──
  await cena([A3, B3, C3], ['a', 'b', 'c']);
  await passo('distribuir h', 'distribuir', () => acao(`distribuir('h')`));
  let o = Object.fromEntries((await todos()).map((e) => [e.id, e]));
  conferir(perto(o.a.x, 100, 0.01) && perto(o.c.x, 375, 0.01) && perto(o.b.x, 500, 0.01), 'distribuir h: vãos iguais de 75 (a=100, c=375, b=500)', [o.a.x, o.c.x, o.b.x]);
  await cena([A3, B3, C3], ['a', 'b', 'c']);
  await passo('distribuir v', 'distribuir', () => acao(`distribuir('v')`));
  o = Object.fromEntries((await todos()).map((e) => [e.id, e]));
  conferir(perto(o.c.y, 50, 0.01) && perto(o.a.y, 140, 0.01) && perto(o.b.y, 300, 0.01), 'distribuir v: vãos iguais de 40 (c=50, a=140, b=300)', [o.c.y, o.a.y, o.b.y]);
  await cena([A3, B3, C3], ['a', 'b']);
  await acao(`distribuir('h')`);
  conferir(!(await av(`__rot`)).includes('distribuir'), 'distribuir com menos de 3 não faz nada');

  // ── Camadas ──
  await cena(quatro(), ['b']);
  await passo('camada frente (Ctrl+Shift+])', 'camada', () => tecla('}', 'BracketRight', CTRL | SHIFT, 221));
  conferir((await ordem()) === 'acdb' && (await zs()) === '1,2,3,4', 'frente: b vai ao topo e z é reescrito 1..4', [await ordem(), await zs()]);
  await passo('camada trás (Ctrl+Shift+[)', 'camada', () => tecla('{', 'BracketLeft', CTRL | SHIFT, 219));
  conferir((await ordem()) === 'bacd' && (await zs()) === '1,2,3,4', 'trás: b vai ao fundo', [await ordem(), await zs()]);
  await passo('camada subir (Ctrl+])', 'camada', () => tecla(']', 'BracketRight', CTRL, 221));
  conferir((await ordem()) === 'abcd', 'subir: b sobe uma posição', await ordem());
  await av(`Whiteboard.nucleo.selecionar(['c'])`);
  await passo('camada descer (Ctrl+[)', 'camada', () => tecla('[', 'BracketLeft', CTRL, 219));
  conferir((await ordem()) === 'acbd' && (await zs()) === '1,2,3,4', 'descer: c desce uma posição', [await ordem(), await zs()]);
  await cena(quatro(), ['a', 'c']);
  await acao(`camada('subir')`);
  conferir((await ordem()) === 'badc', 'subir com seleção múltipla preserva a ordem relativa', await ordem());
  await cena(quatro(), ['d']);
  await acao(`camada('frente')`);
  conferir(!(await av(`__rot`)).includes('camada'), 'camada que não muda nada não confirma');

  // ── Selecionar tudo ──
  await cena(quatro(), []);
  await acao('selecionarTudo()');
  conferir((await sel()).length === 4, 'selecionarTudo seleciona todos');

  // ── Alt+arrastar duplica (gancho do núcleo na ferramenta selecionar) ──
  await cena([base({ id: 'a', preenchimento: '#334' })], []);
  const palA = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  await arrastar(palA.l + 200, palA.t + 160, palA.l + 500, palA.t + 160, 1);
  {
    const l = await todos(); const orig = l.find((e) => e.id === 'a'); const nova = l.find((e) => e.id !== 'a');
    conferir(l.length === 2 && orig && perto(orig.x, 100, 0.01) && perto(orig.y, 100, 0.01), 'Alt+arrastar: o original fica no lugar', l.map((e) => [e.id, e.x, e.y]));
    conferir(!!nova && perto(nova.x, 416, 2) && perto(nova.y, 116, 2), 'Alt+arrastar: a cópia (+16 px) é arrastada junto com o ponteiro', nova && [nova.x, nova.y]);
    conferir(JSON.stringify(await sel()) === JSON.stringify([nova && nova.id]), 'Alt+arrastar: só a cópia fica selecionada');
  }
  await cena([base({ id: 'a', preenchimento: '#334' })], []);
  await arrastar(palA.l + 200, palA.t + 160, palA.l + 500, palA.t + 160, 0);
  conferir((await todos()).length === 1, 'arrastar sem Alt não duplica');

  // ── Condições dos atalhos ──
  await cena(quatro(), ['a']);
  await av(`document.getElementById('campo').focus()`);
  await tecla('d', 'KeyD', CTRL, 68);
  conferir((await todos()).length === 4, 'Ctrl+D em campo editável não duplica');
  await av(`document.getElementById('campo').blur(); document.querySelector('.wb-palco').focus()`);
  await av(`Whiteboard.sair()`); await dormir(100);
  await tecla('d', 'KeyD', CTRL, 68);
  conferir((await todos()).length === 4, 'com a vista inativa os atalhos não agem');

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard edição UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
