// Teste da seleção completa do Whiteboard (alças de redimensionar/girar, duplo clique, setas, estilo atual)
// contra testes/whiteboard-demo.html (fetch falso em memória). Servidor estático próprio numa porta livre de
// 47822–47826, Edge headless mudo, perfil temporário apagado no fim, Edge fechado com fecharEdge.
// node testes/whiteboard-selecao-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-sel-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47826);
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

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir('?vazio=1');
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const pal = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const L = pal.l, T = pal.t;
  await av(`window.__rot = []; Whiteboard.nucleo.on('confirmar', (d) => __rot.push(d.rotulo));
    Whiteboard.registrarTipo('fake', { desenhar(ctx, el) { ctx.strokeStyle = '#7aa2ff'; ctx.strokeRect(el.x, el.y, el.w, el.h); }, editar(el) { window.__editou = el.id; }, aoRedimensionar(el, campos) { window.__aoRed = { w: campos.w, h: campos.h }; } });
    Whiteboard.registrarFerramenta('texto', { rotulo: 'Texto falso', icone: 'selecionar', tecla: 't', ordem: 60, criarEm(p) { window.__criou = { x: p.x, y: p.y, nucleo: !!p.nucleo }; } });`);

  const base = (o) => ({ tipo: 'retangulo', x: 100, y: 100, w: 200, h: 120, angulo: 0, cor: '#7aa2ff', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, ...o });
  // monta uma cena: remove tudo, adiciona os elementos e seleciona os ids pedidos
  const cena = async (lista, sel) => {
    await av(`(() => { const n = Whiteboard.nucleo; n.remover(n.elementos().map((e) => e.id)); for (const e of ${JSON.stringify(lista)}) n.adicionar(e); n.selecionar(${JSON.stringify(sel)}); n.redesenhar(); window.__rot = []; delete window.__editou; delete window.__criou; delete window.__aoRed; })()`);
    await dormir(80);
  };
  // roda uma ação e confere que confirmar(rótulo) saiu e o quadro foi salvo
  const passo = async (nome, rotulo, fn) => {
    const n0 = await salvos();
    await fn();
    const gravou = await esperar(`demo.reqs.filter((x) => x[0] === 'POST' && x[1].endsWith('/salvar')).length > ${n0}`, 3500);
    const rots = await av(`__rot`);
    conferir(rots.includes(rotulo) && gravou, nome + ': confirmar("' + rotulo + '") e salvar', { rots, gravou });
  };

  const A = base({ id: 'a' }), B = base({ id: 'b', x: 500, y: 100, w: 100, h: 100 });
  const px = (x, y) => [L + x, T + y];

  // ── Alças aparecem (cursor certo ao pairar) ──
  await cena([A, B], ['a']);
  const cur = {};
  for (const [nome, x, y] of [['se', 304, 224], ['nw', 96, 96], ['ne', 304, 96], ['e', 304, 160], ['n', 200, 96], ['rot', 200, 72]]) {
    await mouse('mouseMoved', ...px(x, y)); await dormir(40); cur[nome] = await cursor();
  }
  conferir(cur.se === 'nwse-resize' && cur.nw === 'nwse-resize' && cur.ne === 'nesw-resize' && cur.e === 'ew-resize' && cur.n === 'ns-resize' && cur.rot === 'grab', 'alças nos cantos, lados e a de rotação (cursor certo em cada uma)', cur);
  await mouse('mouseMoved', ...px(400, 600)); await dormir(40);
  conferir((await cursor()) !== 'nwse-resize', 'fora das alças o cursor volta ao normal', await cursor());

  // ── Redimensionar por canto e por lado ──
  await passo('canto SE', 'redimensionar', () => arrastar(...px(304, 224), ...px(404, 274)));
  let a = await get('a');
  conferir(perto(a.x, 100) && perto(a.y, 100) && perto(a.w, 300) && perto(a.h, 170), 'canto SE: âncora no NO e caixa 300x170', a);
  await cena([A], ['a']);
  await passo('canto NO', 'redimensionar', () => arrastar(...px(96, 96), ...px(46, 66)));
  a = await get('a');
  conferir(perto(a.x, 50) && perto(a.y, 70) && perto(a.w, 250) && perto(a.h, 150), 'canto NO: âncora no SE', a);
  await cena([A], ['a']);
  await passo('lado E', 'redimensionar', () => arrastar(...px(304, 160), ...px(354, 220)));
  a = await get('a');
  conferir(perto(a.x, 100) && perto(a.w, 250) && perto(a.h, 120) && perto(a.y, 100), 'lado E muda só a largura', a);
  await cena([A], ['a']);
  await passo('lado S', 'redimensionar', () => arrastar(...px(200, 224), ...px(260, 264)));
  a = await get('a');
  conferir(perto(a.h, 160) && perto(a.w, 200) && perto(a.y, 100), 'lado S muda só a altura', a);
  await cena([A], ['a']);
  await arrastar(...px(304, 224), ...px(104, 224)); // arrastado além do mínimo
  a = await get('a');
  conferir(a.w >= 3.9 && a.w < 10, 'tamanho mínimo respeitado', a);

  // ── Shift proporcional, Alt pelo centro ──
  await cena([A], ['a']);
  await passo('Shift proporcional', 'redimensionar', () => arrastar(...px(304, 224), ...px(404, 234), SHIFT));
  a = await get('a');
  conferir(perto(a.w, 300) && perto(a.h, 180) && perto(a.x, 100) && perto(a.y, 100), 'Shift mantém a proporção (200x120 → 300x180)', a);
  await cena([A], ['a']);
  await passo('Alt pelo centro', 'redimensionar', () => arrastar(...px(304, 224), ...px(354, 254), ALT));
  a = await get('a');
  conferir(perto(a.w, 300) && perto(a.h, 180) && perto(a.x, 50) && perto(a.y, 70), 'Alt redimensiona a partir do centro', a);

  // ── Girar ──
  await cena([A], ['a']);
  await passo('girar', 'girar', () => arrastar(...px(200, 72), ...px(300, 160)));
  a = await get('a');
  conferir(perto(a.angulo, Math.PI / 2, 0.05) && perto(a.x, 100) && perto(a.w, 200), 'alça de rotação gira 90°', a);
  await mouse('mouseMoved', ...px(400, 600));
  await cena([A], ['a']);
  const r0 = 88, ang = (-90 + 50) * Math.PI / 180; // 50° adiante; Shift trava em 45°
  await passo('girar com Shift', 'girar', () => arrastar(...px(200, 72), ...px(200 + r0 * Math.cos(ang), 160 + r0 * Math.sin(ang)), SHIFT));
  a = await get('a');
  conferir(perto(a.angulo, Math.PI / 4, 0.01), 'Shift gira em passos de 15° (50° → 45°)', a);
  // girado: o cursor das alças acompanha o ângulo (canto SE de um quadrado girado 45° vira ns/ew)
  await cena([base({ id: 'q', x: 100, y: 100, w: 100, h: 100, angulo: Math.PI / 4 })], ['q']);
  // canto SE local (150+54, 150+54) girado 45° em torno de (150,150) → (150, 150 + 54*1.4142)
  await mouse('mouseMoved', ...px(150, 150 + 54 * Math.SQRT2)); await dormir(40);
  conferir((await cursor()) === 'ns-resize', 'cursor da alça considera o ângulo do elemento', await cursor());

  // ── Vários elementos escalam juntos ──
  await cena([A, B], ['a', 'b']);
  await passo('vários', 'redimensionar', () => arrastar(...px(608, 228), ...px(708, 228)));
  a = await get('a'); const b = await get('b');
  conferir(perto(a.w, 240) && perto(b.x, 580) && perto(b.w, 120) && perto(a.h, 120) && perto(b.h, 100), 'vários: escala o conjunto pela caixa (x1,2)', { a, b });

  // ── Elemento com pontos ──
  await cena([{ ...base({ id: 'p', tipo: 'xyz', x: 100, y: 100, w: 100, h: 50 }), pontos: [[0, 0], [50, 40], [100, 50]] }], ['p']);
  await passo('pontos', 'redimensionar', () => arrastar(...px(204, 154), ...px(304, 254)));
  const p = await get('p');
  conferir(perto(p.w, 200) && perto(p.h, 150) && perto(p.pontos[1][0], 100) && perto(p.pontos[1][1], 120) && perto(p.pontos[2][0], 200) && perto(p.pontos[2][1], 150), 'elemento com pontos: escala os pontos e atualiza w,h', p);

  // ── Linha de 2 pontos: alças nos extremos ──
  await cena([{ ...base({ id: 'l', tipo: 'xlinha', x: 100, y: 300, w: 100, h: 60 }), pontos: [[0, 0], [100, 60]] }], ['l']);
  await mouse('mouseMoved', ...px(200, 360)); await dormir(40);
  conferir((await cursor()) === 'crosshair', 'linha de 2 pontos: alça no extremo');
  await passo('extremo da linha', 'mover ponto', () => arrastar(...px(200, 360), ...px(260, 420)));
  const l = await get('l');
  conferir(perto(l.w, 160) && perto(l.h, 120) && perto(l.x, 100) && perto(l.pontos[0][0], 0) && perto(l.pontos[1][0], 160) && perto(l.pontos[1][1], 120), 'arrastar o extremo move só aquele ponto', l);

  // ── aoRedimensionar e texto ──
  await cena([base({ id: 'f', tipo: 'fake' })], ['f']);
  await arrastar(...px(304, 224), ...px(404, 274));
  const ar = await av(`window.__aoRed`);
  conferir(ar && perto(ar.w, 300) && perto(ar.h, 170), 'tipo com aoRedimensionar(el, campos, nucleo) é chamado com os campos novos', ar);
  await cena([{ ...base({ id: 't', tipo: 'texto', x: 100, y: 100, w: 100, h: 40 }), texto: { valor: 'Olá', tamanho: 20, alinhar: 'esquerda' } }], ['t']);
  await arrastar(...px(204, 144), ...px(304, 184));
  const t = await get('t');
  conferir(t.texto && t.texto.tamanho > 30, 'tipo texto: redimensionar escala texto.tamanho', t.texto);

  // ── Duplo clique ──
  await cena([base({ id: 'f', tipo: 'fake' })], []);
  await duplo(...px(150, 150));
  conferir((await av(`window.__editou`)) === 'f', 'duplo clique em elemento chama editar(el, nucleo) do tipo');
  await duplo(...px(700, 500));
  const cr = await av(`window.__criou`);
  conferir(cr && perto(cr.x, 700) && perto(cr.y, 500) && cr.nucleo, 'duplo clique no vazio chama ferramenta texto.criarEm({ x, y, nucleo })', cr);

  // ── Setas ──
  await cena([A], []);
  await arrastar(...px(100, 160), ...px(100, 160)); // clique na borda seleciona e dá o foco
  await passo('seta →', 'mover', () => tecla('ArrowRight', 'ArrowRight', 0, 39));
  a = await get('a');
  conferir(perto(a.x, 101, 0.01) && perto(a.y, 100, 0.01), 'seta direita move 1 px', a);
  await passo('Shift + seta ↓', 'mover', () => tecla('ArrowDown', 'ArrowDown', SHIFT, 40));
  a = await get('a');
  conferir(perto(a.x, 101, 0.01) && perto(a.y, 110, 0.01), 'Shift + seta baixo move 10 px', a);
  await tecla('Delete', 'Delete', 0, 46);
  conferir((await av(`Whiteboard.nucleo.elementos().length`)) === 0, 'atalhos antigos continuam (Delete exclui a seleção)');

  // ── Estilo atual ──
  const est0 = await av(`Whiteboard.nucleo.estiloAtual()`);
  conferir(est0.cor === '#e5e5e5' && est0.traco.largura === 2 && est0.traco.estilo === 'solido' && est0.preenchimento === null && est0.opacidade === 1, 'estiloAtual() devolve o padrão do contrato', est0);
  const est1 = await av(`(() => { window.__ev = []; Whiteboard.nucleo.on('estilo', (e) => __ev.push(e)); Whiteboard.nucleo.definirEstilo({ cor: '#ff0000', traco: { largura: 4 }, opacidade: 0.5 }); return Whiteboard.nucleo.estiloAtual(); })()`);
  const ev = await av(`__ev`);
  conferir(est1.cor === '#ff0000' && est1.traco.largura === 4 && est1.traco.estilo === 'solido' && est1.opacidade === 0.5 && est1.preenchimento === null && ev.length === 1 && ev[0].cor === '#ff0000', 'definirEstilo(parcial) mescla, devolve e emite o evento estilo', { est1, ev });
  const cp = await av(`(() => { const e = Whiteboard.nucleo.estiloAtual(); e.cor = 'x'; return Whiteboard.nucleo.estiloAtual().cor; })()`);
  conferir(cp === '#ff0000', 'estiloAtual() devolve cópia');

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard seleção UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
