// Teste do historico (desfazer/refazer) e do evento mudanca do Whiteboard, contra testes/whiteboard-demo.html
// (fetch falso em memoria). Servidor estatico proprio numa porta livre de 47822-47826, Edge headless mudo,
// perfil temporario apagado no fim, Edge fechado com fecharEdge.
// node testes/whiteboard-historico-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-hist-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

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

  const N = (e) => av(`(() => { const n = Whiteboard.nucleo; return ${e}; })()`);
  const estado = () => N(`({ x: n.elemento('ea')?.x, y: n.elemento('ea')?.y, total: n.elementos().length, sel: n.selecao(), d: n.podeDesfazer(), r: n.podeRefazer(), bd: document.querySelector('[data-hist=desfazer]').disabled, br: document.querySelector('[data-hist=refazer]').disabled })`);
  const ultimoSalvo = () => av(`(() => { const r = demo.reqs.filter((x) => x[0] === 'POST' && x[1].endsWith('/salvar')).pop(); if (!r) return null; const c = typeof r[2] === 'string' ? JSON.parse(r[2]) : r[2]; return c.elementos.map((e) => [e.id, e.x, Object.keys(e).filter((k) => k[0] === '_').length]); })()`);
  const CTRL = 2;

  await abrir(); await av(`localStorage.clear()`); await abrir();
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const pal = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const L = pal.l, T = pal.t;
  await av(`window.__mud = []; window.__his = []; Whiteboard.nucleo.on('mudanca', (d) => __mud.push(d)); Whiteboard.nucleo.on('historico', (d) => __his.push(d));`);

  // ── Estado inicial ──
  let s = await estado();
  conferir(!s.d && !s.r && s.bd && s.br, 'início: nada a desfazer/refazer e botões desabilitados', s);

  // ── Mover + desfazer/refazer por teclado ──
  await arrastar(L + 200, T + 160, L + 300, T + 260);
  s = await estado();
  conferir(s.x > 150 && s.d && !s.r && !s.bd && s.br && s.sel.join() === 'ea', 'mover: elemento andou, desfazer habilitado, seleção mantida', s);
  const xMov = s.x, yMov = s.y;
  await tecla('z', 'KeyZ', CTRL, 90);
  s = await estado();
  conferir(s.x === 100 && s.y === 100 && !s.d && s.r && s.sel.join() === 'ea', 'Ctrl+Z desfaz o mover e mantém o elemento selecionado', s);
  await tecla('Z', 'KeyZ', CTRL | SHIFT, 90);
  s = await estado();
  conferir(s.x === xMov && s.y === yMov && s.d && !s.r, 'Ctrl+Shift+Z refaz o mover', s);
  await tecla('z', 'KeyZ', CTRL, 90);
  await tecla('y', 'KeyY', CTRL, 89);
  s = await estado();
  conferir(s.x === xMov && !s.r, 'Ctrl+Y também refaz', s);

  // ── Salvar depois de desfazer ──
  const n0 = await salvos();
  await tecla('z', 'KeyZ', CTRL, 90);
  const gravou = await esperar(`demo.reqs.filter((x) => x[0] === 'POST' && x[1].endsWith('/salvar')).length > ${n0}`, 3500);
  const sv = await ultimoSalvo();
  conferir(gravou && sv && sv.find((e) => e[0] === 'ea')[1] === 100 && sv.every((e) => e[2] === 0), 'desfazer marca para gravar e o servidor recebe o estado desfeito (sem campos "_")', { gravou, sv });

  // ── Botões ──
  await av(`document.querySelector('[data-hist=refazer]').click()`);
  s = await estado();
  conferir(s.x === xMov && !s.r && s.d, 'botão Refazer', s);
  await av(`document.querySelector('[data-hist=desfazer]').click()`);
  s = await estado();
  conferir(s.x === 100 && s.r && !s.d && !s.br && s.bd, 'botão Desfazer e estados dos botões', s);

  // ── Novo passo depois de desfazer descarta o refazer ──
  await av(`Whiteboard.nucleo.atualizar('ea', { y: 130 }); Whiteboard.nucleo.confirmar('teste')`);
  s = await estado();
  conferir(s.d && !s.r && s.y === 130, 'confirmar depois de desfazer descarta o refazer', s);
  await tecla('z', 'KeyZ', CTRL, 90);

  // ── Criar ──
  await av(`Whiteboard.nucleo.selecionar([])`);
  await av('document.querySelector(".wb-palco").focus()'); await tecla('r', 'KeyR', 0, 82);
  const fer = await av('Whiteboard.nucleo.ferramenta()'); await av('window.__pd = []; document.querySelector(".wb-palco").addEventListener("pointerdown", (e) => __pd.push([e.clientX, e.clientY, e.button, e.target.className]), true)');
  const t0 = (await estado()).total;
  const livre = await av(`(() => { const ok = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e.classList.contains("wb-palco") || e.classList.contains("wb-canvas")); }; for (let y = 120; y < 700; y += 40) for (let x = 560; x < 1100; x += 40) { if ([[0,0],[130,0],[0,70],[130,70],[65,35]].every(([dx, dy]) => ok(x + dx, y + dy)) && !Whiteboard.nucleo.elementoEm(x + 65 - document.querySelector(".wb-palco").getBoundingClientRect().left, y + 35)) return [x, y]; } return null; })()`);
  await arrastar(L + livre[0], T + livre[1], L + livre[0] + 120, T + livre[1] + 60);
  s = await estado();
  const novo = s.sel[0]; const pdd = await av('__pd');
  conferir(s.total === t0 + 1 && novo && s.sel.length === 1, 'criar: elemento novo existe e está selecionado', { s, fer, pdd, topo: await av("(() => { const e = document.elementFromPoint(120, 330); return e && e.className + \"/\" + e.tagName; })()") });
  await tecla('z', 'KeyZ', CTRL, 90);
  s = await estado();
  conferir(s.total === t0 && !(await N(`!!n.elemento(${JSON.stringify(novo)})`)), 'desfazer remove o elemento criado', s);
  await tecla('Z', 'KeyZ', CTRL | SHIFT, 90);
  s = await estado();
  conferir(s.total === t0 + 1 && s.sel.join() === novo, 'refazer recria o elemento e a seleção', s);
  await tecla('z', 'KeyZ', CTRL, 90);

  // ── Apagar ──
  await av(`Whiteboard.nucleo.selecionar(['ec'])`);
  await tecla('Delete', 'Delete', 0, 46);
  s = await estado();
  conferir(s.total === t0 - 1 && !s.sel.length, 'apagar: ec some', s);
  await tecla('z', 'KeyZ', CTRL, 90);
  s = await estado();
  conferir(s.total === t0 && s.sel.join() === 'ec', 'desfazer apagar traz ec de volta já selecionado', s);
  await tecla('Z', 'KeyZ', CTRL | SHIFT, 90);
  s = await estado();
  conferir(s.total === t0 - 1, 'refazer apagar', s);
  await tecla('z', 'KeyZ', CTRL, 90);

  // ── Fora de campos editáveis ──
  await av(`window.__in = document.body.appendChild(Object.assign(document.createElement('input'), { id: 'campo-teste' })); __in.focus()`);
  const antes = await estado();
  await tecla('z', 'KeyZ', CTRL, 90);
  const depois = await estado();
  conferir(JSON.stringify(antes) === JSON.stringify(depois), 'Ctrl+Z dentro de um campo de texto não mexe no quadro', { antes, depois });
  await av(`__in.remove(); Whiteboard.nucleo.selecionar([]); document.querySelector('.wb-palco').focus()`);

  // ── Evento mudanca ──
  await av(`__mud.length = 0`);
  await N(`(n.adicionar({ id: 'm1', tipo: 'retangulo', x: 0, y: 0, w: 10, h: 10 }), n.atualizar('m1', { x: 5 }), n.remover(['m1']), n.confirmar('m'), 0)`);
  let mud = await av(`__mud`);
  conferir(mud.length === 3 && mud[0].tipo === 'adicionar' && mud[0].ids[0] === 'm1' && mud[1].tipo === 'atualizar' && mud[1].ids[0] === 'm1' && mud[2].tipo === 'remover' && mud[2].ids[0] === 'm1', 'mudanca em adicionar/atualizar/remover', mud);
  await N(`(n.adicionar({ id: 'm2', tipo: 'retangulo', x: 0, y: 0, w: 10, h: 10 }), n.confirmar('m2'), __mud.length = 0, n.desfazer(), 0)`);
  mud = await av(`__mud`);
  conferir(mud.length === 1 && mud[0].tipo === 'desfazer' && mud[0].ids.join() === 'm2', 'mudanca ao desfazer traz só os ids afetados', mud);
  await av(`__mud.length = 0; Whiteboard.nucleo.refazer()`);
  mud = await av(`__mud`);
  conferir(mud.length === 1 && mud[0].tipo === 'desfazer' && mud[0].ids.join() === 'm2', 'mudanca ao refazer', mud);

  // ── Evento historico ──
  const his = await av(`__his`);
  conferir(his.length > 5 && his.every((h2) => 'podeDesfazer' in h2 && 'podeRefazer' in h2), 'evento historico emitido com o estado', his.slice(0, 2));

  // ── Limite de ~100 passos ──
  await abrir();
  await av(`(() => { const n = Whiteboard.nucleo; for (let i = 1; i <= 130; i++) { n.atualizar('eb', { x: 500 + i }); n.confirmar('p' + i); } })()`);
  const cont = await av(`(() => { const n = Whiteboard.nucleo; let c = 0; while (n.podeDesfazer()) { n.desfazer(); c++; } return { c, x: n.elemento('eb').x }; })()`);
  conferir(cont.c === 100 && cont.x === 530, 'limite: guarda 100 passos de desfazer', cont);
  const ref = await av(`(() => { const n = Whiteboard.nucleo; let c = 0; while (n.podeRefazer()) { n.refazer(); c++; } return { c, x: n.elemento('eb').x }; })()`);
  conferir(ref.c === 100 && ref.x === 630, 'refazer percorre os mesmos 100 passos', ref);

  // ── Troca de quadro zera ──
  await av(`window.__mud = []; Whiteboard.nucleo.on('mudanca', (d) => __mud.push(d))`);
  const id1 = await av(`Whiteboard.quadro().id`);
  await av(`Whiteboard.novoQuadro()`);
  await esperar(`Whiteboard.quadro().id !== ${JSON.stringify(id1)}`, 4000);
  await dormir(150);
  s = await estado();
  conferir(!s.d && !s.r && s.bd && s.br, 'novo quadro zera o histórico', s);
  mud = await av(`__mud`);
  conferir(mud.some((m) => m.tipo === 'carregar'), 'mudanca tipo carregar ao abrir quadro', mud);
  await av(`Whiteboard.nucleo.adicionar({ tipo: 'retangulo', x: 0, y: 0, w: 20, h: 20 }); Whiteboard.nucleo.confirmar('x')`);
  await av(`Whiteboard.abrirQuadro(${JSON.stringify(id1)})`);
  await esperar(`Whiteboard.quadro().id === ${JSON.stringify(id1)}`, 4000);
  await dormir(150);
  s = await estado();
  conferir(!s.d && !s.r && s.bd, 'voltar ao quadro anterior também começa com histórico vazio', s);
  const tAntes = s.total;
  await tecla('z', 'KeyZ', CTRL, 90);
  s = await estado();
  conferir(s.total === tAntes, 'Ctrl+Z sem histórico não faz nada', s);

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard histórico UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
