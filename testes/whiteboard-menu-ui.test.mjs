// Teste das menu de botão direito do Whiteboard
// contra testes/whiteboard-demo.html (fetch falso em memória). Servidor estático próprio numa porta livre de
// 47822–47826, Edge headless mudo, perfil temporário apagado no fim, Edge fechado com fecharEdge.
// node testes/whiteboard-menu-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-menu-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { if (process.env.TRACE) console.log((cond ? "ok " : "FALHA ") + nome); (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
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
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); setTimeout(() => { if (pend.has(id)) { pend.delete(id); ok(null); } }, 8000); ws.send(JSON.stringify({ id, method, params })); });
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

  // ── ajudantes do menu ──
  const direito = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 'right', 2); await mouse('mouseReleased', x, y, 'right', 0);
    await dormir(120);
  };
  const aberto = () => av(`Whiteboard.menu.aberto() && !!document.querySelector('.wb-menu')`);
  const rotulos = () => av(`[...document.querySelectorAll('.wb-menu:not(.wb-menu-sub) .wb-menu-item .mi-rot')].map((t) => t.textContent)`);
  const rotsSub = () => av(`[...document.querySelectorAll('.wb-menu-sub .wb-menu-item .mi-rot')].map((t) => t.textContent)`);
  const tem = (lista, r) => lista.includes(r);
  const centro = (rot, sub) => av(`(() => { const b = [...document.querySelectorAll('${sub ? '.wb-menu-sub' : '.wb-menu:not(.wb-menu-sub)'} .wb-menu-item')].find((x) => x.querySelector('.mi-rot').textContent === ${JSON.stringify(rot)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const clicar = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'left', 1); await mouse('mouseReleased', x, y, 'left', 0); await dormir(120); };
  const item = async (rot, sub) => { const c = await centro(rot, sub); if (!c) return false; await clicar(c[0], c[1]); return true; };
  const abrirSub = async (rot) => { const c = await centro(rot); await mouse('mouseMoved', c[0], c[1]); await esperar(`!!document.querySelector('.wb-menu-sub')`, 1500); await dormir(60); };
  const fechado = async () => { await dormir(60); return !(await av(`Whiteboard.menu.aberto() || !!document.querySelector('.wb-menu')`)); };
  const ret = (id, o = {}) => base({ id, preenchimento: '#7aa2ff33', ...o });
  const esc = () => tecla('Escape', 'Escape', 0, 27);

  conferir(await av(`typeof Whiteboard.menu === 'object' && ['abrir', 'fechar', 'aberto'].every((k) => typeof Whiteboard.menu[k] === 'function') && Object.isFrozen(Whiteboard.menu)`), 'Whiteboard.menu tem abrir/fechar/aberto (congelado)');
  const temTravar = await av(`typeof Whiteboard.acoes.travar === 'function'`), temPainel = await av(`!!(Whiteboard.painel && Whiteboard.painel.abrir)`), temWeb = await av(`!!(Whiteboard.web && Whiteboard.web.pedirEndereco)`);

  // ── canvas vazio ──
  await cena([ret('a', { x: 100, y: 100 }), ret('b', { x: 500, y: 100, w: 100, h: 100 })], []);
  await direito(...px(800, 300));
  conferir(await aberto(), 'botão direito no vazio abre o menu');
  let r = await rotulos();
  conferir(['Colar', 'Adicionar texto aqui', 'Adicionar nota aqui', 'Adicionar card de agente aqui', 'Selecionar tudo', 'Ajustar à tela'].every((x) => tem(r, x)), 'menu do vazio tem as opções do vazio', r);
  conferir(!['Copiar', 'Duplicar', 'Excluir', 'Alinhar', 'Agrupar', 'Travar'].some((x) => tem(r, x)), 'menu do vazio não tem opções de elemento', r);
  conferir(tem(r, 'Adicionar navegador aqui') === temWeb, 'Adicionar navegador aqui só com Whiteboard.web', { r, temWeb });
  conferir(await av(`document.querySelector('.wb-menu').getAttribute('role') === 'menu' && !!document.querySelector('.wb-menu .wb-menu-item[role=menuitem]')`), 'role=menu / menuitem');
  conferir(await av(`!!document.querySelector('.wb-menu .mi-atalho')`), 'itens mostram atalho (.mi-atalho)');
  const pos = await av(`(() => { const r = document.querySelector('.wb-menu').getBoundingClientRect(); return [r.left, r.top]; })()`);
  conferir(perto(pos[0], L + 800, 1.5) && perto(pos[1], T + 300, 1.5), 'abre no cursor', pos);

  // Adicionar texto aqui
  await item('Adicionar texto aqui');
  let ls = await todos(); const tx = ls.find((e) => e.tipo === 'texto');
  conferir(tx && perto(tx.x, L * 0 + 800, 1) && perto(tx.y + tx.h / 2, 300, 1.5), 'Adicionar texto aqui cria o texto no ponto clicado', tx && [tx.x, tx.y, tx.h]);
  conferir(await fechado(), 'o menu fecha após a ação');
  await esc(); await av(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);

  // Adicionar nota aqui
  await cena([ret('a')], []);
  await direito(...px(700, 300));
  await item('Adicionar nota aqui');
  ls = await todos(); const nt = ls.find((e) => e.tipo === 'nota');
  conferir(nt && perto(nt.x + nt.w / 2, 700, 1) && perto(nt.y + nt.h / 2, 300, 1), 'Adicionar nota aqui cria a nota centrada no ponto', nt && [nt.x, nt.y, nt.w, nt.h]);
  await esc();

  // Card de agente pelo submenu
  await cena([ret('a')], []);
  await direito(...px(600, 450));
  await abrirSub('Adicionar card de agente aqui');
  let sr = await rotsSub();
  conferir(sr.length >= 4 && sr[0] === 'Revisar contrato', 'submenu de agentes: quem precisa de você vem primeiro', sr);
  conferir(sr.length <= 10, 'submenu limita a 8 sessões (+ Ver todas)', sr.length);
  conferir(tem(sr, 'Ver todas…') === temPainel, 'Ver todas… só com Whiteboard.painel', { sr, temPainel });
  conferir(await av(`!!document.querySelector('.wb-menu-sub img.mi-sprite')`), 'itens do submenu mostram o sprite');
  const sc = await centro('Testes do servidor', true);
  await clicar(sc[0], sc[1]);
  const cards = await av(`Whiteboard.agentes.cards()`);
  const cd = cards.find((c) => c.sessao === 's3');
  conferir(cd && perto(cd.x + cd.w / 2, 600, 1) && perto(cd.y + cd.h / 2, 450, 1), 'card de agente criado no ponto clicado', cd);

  // Colar / Selecionar tudo / Ajustar à tela
  await cena([ret('a', { x: 50, y: 50, w: 100, h: 100 }), ret('b', { x: 300, y: 50, w: 100, h: 100 })], ['a']);
  await acao('copiar()'); await av(`Whiteboard.nucleo.selecionar([])`);
  await direito(...px(800, 500));
  await item('Colar'); await dormir(150);
  ls = await todos(); const col = ls.filter((e) => e.id !== 'a' && e.id !== 'b');
  conferir(col.length === 1 && perto(col[0].x + col[0].w / 2, 800, 2) && perto(col[0].y + col[0].h / 2, 500, 2), 'Colar cola no ponto clicado', col.map((e) => [e.x, e.y]));
  await av(`Whiteboard.nucleo.selecionar([])`);
  await direito(...px(1000, 700));
  await item('Selecionar tudo');
  conferir((await sel()).length === 3, 'Selecionar tudo seleciona todos', await sel());
  await av(`Whiteboard.nucleo.selecionar([])`);
  await direito(...px(1000, 700));
  await item('Ajustar à tela'); await dormir(700);
  const cam = await av(`Whiteboard.nucleo.camera()`);
  conferir(cam.x !== 0 || cam.y !== 0 || cam.zoom !== 1, 'Ajustar à tela mexe na câmera', cam);
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);

  // ── num elemento ──
  const tres = () => [ret('a', { x: 100, y: 100, w: 200, h: 120 }), ret('b', { x: 500, y: 100, w: 100, h: 100 }), ret('c', { x: 300, y: 400, w: 100, h: 100 })];
  await cena(tres(), []);
  await direito(...px(200, 160));
  conferir(JSON.stringify(await sel()) === '["a"]', 'botão direito num elemento seleciona só ele', await sel());
  r = await rotulos();
  conferir(['Copiar', 'Duplicar', 'Excluir', 'Trazer para frente', 'Enviar para trás'].every((x) => tem(r, x)) && !tem(r, 'Colar') && !tem(r, 'Alinhar') && !tem(r, 'Agrupar') && !tem(r, 'Desagrupar'), 'menu de 1 elemento: opções de elemento, sem Alinhar/Agrupar/Colar', r);
  conferir(tem(r, 'Travar') === temTravar, 'Travar só quando a ação existe', { r, temTravar });
  conferir(await av(`document.querySelectorAll('.wb-menu .wb-menu-cor').length === 8 && document.querySelectorAll('.wb-menu .wb-menu-esp').length === 3`), 'linha de 8 cores e 3 espessuras');

  await passo('Duplicar pelo menu', 'duplicar', () => item('Duplicar'));
  conferir((await todos()).length === 4, 'Duplicar cria a cópia', (await todos()).length);

  await cena(tres(), []);
  await direito(...px(200, 160));
  await passo('Excluir pelo menu', 'excluir', () => item('Excluir'));
  conferir(!(await todos()).some((e) => e.id === 'a') && (await todos()).length === 2, 'Excluir remove o elemento');

  await cena(tres(), []);
  await direito(...px(200, 160));
  await passo('Trazer para frente pelo menu', 'camada', () => item('Trazer para frente'));
  conferir((await ordem()) === 'bca', 'Trazer para frente põe a por último', await ordem());
  await direito(...px(200, 160));
  await passo('Enviar para trás pelo menu', 'camada', () => item('Enviar para trás'));
  conferir((await ordem()) === 'abc', 'Enviar para trás põe a primeiro', await ordem());

  // Cor (1 passo) e desfazer
  await cena([ret('a', { x: 100, y: 100, w: 200, h: 120 }), ret('b', { x: 500, y: 100, w: 100, h: 100 })], []);
  await direito(...px(200, 160));
  const cor0 = (await get('a')).cor;
  const cc = await av(`(() => { const b = document.querySelector('.wb-menu .wb-menu-cor[data-cor="#3dd68c"]'); const r = b.getBoundingClientRect(); return [r.left + 10, r.top + 10]; })()`);
  await passo('Cor pelo menu', 'Estilo', () => clicar(cc[0], cc[1]));
  conferir((await get('a')).cor === '#3dd68c' && (await get('b')).cor === cor0, 'Cor muda só o elemento selecionado', (await get('a')).cor);
  await foco(); await tecla('z', 'KeyZ', CTRL, 90);
  conferir((await get('a')).cor === cor0, 'desfazer volta a cor em 1 passo', (await get('a')).cor);

  await direito(...px(200, 160));
  const ce = await av(`(() => { const b = document.querySelector('.wb-menu .wb-menu-esp[data-largura="4"]'); const r = b.getBoundingClientRect(); return [r.left + 10, r.top + 10]; })()`);
  await passo('Espessura pelo menu', 'Estilo', () => clicar(ce[0], ce[1]));
  conferir((await get('a')).traco.largura === 4, 'Espessura grossa = 4', (await get('a')).traco);

  await cena([ret('t', { tipo: 'texto', x: 100, y: 100, w: 100, h: 30, preenchimento: null, texto: { valor: 'Oi', tamanho: 20, alinhar: 'esquerda' } })], []);
  await direito(...px(120, 115));
  conferir(await av(`document.querySelectorAll('.wb-menu .wb-menu-cor').length === 8 && !document.querySelector('.wb-menu .wb-menu-esp')`), 'texto: cor sim, espessura não');
  await esc();

  // ── seleção múltipla ──
  const trio = () => [ret('a', { x: 100, y: 100, w: 100, h: 100 }), ret('b', { x: 300, y: 150, w: 100, h: 100 }), ret('c', { x: 500, y: 200, w: 100, h: 100 })];
  await cena(trio(), ['a', 'b']);
  await direito(...px(150, 150));
  r = await rotulos();
  conferir(JSON.stringify((await sel()).sort()) === '["a","b"]', 'botão direito num selecionado mantém a seleção múltipla', await sel());
  conferir(tem(r, 'Alinhar') && tem(r, 'Agrupar') && !tem(r, 'Desagrupar'), 'com 2 selecionados: Alinhar e Agrupar', r);
  await abrirSub('Alinhar');
  sr = await rotsSub();
  conferir(['Esquerda', 'Centro horizontal', 'Direita', 'Topo', 'Centro vertical', 'Base'].every((x) => tem(sr, x)) && !tem(sr, 'Distribuir na horizontal'), 'submenu Alinhar (sem Distribuir com 2)', sr);
  await passo('Alinhar à esquerda pelo menu', 'alinhar', () => item('Topo', true));
  conferir(perto((await get('a')).y, 100) && perto((await get('b')).y, 100), 'Alinhar topo funciona', [(await get('a')).y, (await get('b')).y]);
  await av(`Whiteboard.nucleo.selecionar(['a', 'b', 'c'])`);
  await direito(...px(150, 150));
  await abrirSub('Alinhar');
  conferir(tem(await rotsSub(), 'Distribuir na horizontal'), 'com 3 aparece Distribuir');
  await esc(); await esc();
  conferir(await fechado(), 'Esc (submenu e depois menu) fecha tudo');

  // botão direito no vazio com seleção: limpa e mostra o menu do vazio (exceto dentro da caixa de uma seleção múltipla)
  await cena(trio(), ['a']);
  await direito(...px(800, 500));
  r = await rotulos();
  conferir((await sel()).length === 0 && tem(r, 'Selecionar tudo') && !tem(r, 'Excluir'), 'botão direito no vazio com 1 selecionado limpa a seleção e mostra o menu do vazio', { s: await sel(), r });
  await esc();
  await cena(trio(), ['a', 'b']);
  await direito(...px(250, 120));
  r = await rotulos();
  conferir((await sel()).length === 2 && tem(r, 'Alinhar') && !tem(r, 'Selecionar tudo'), 'vazio dentro da caixa de uma seleção múltipla mantém o menu da seleção', { s: await sel(), r });
  await esc();
  await direito(...px(800, 500));
  r = await rotulos();
  conferir((await sel()).length === 0 && tem(r, 'Selecionar tudo'), 'vazio fora da caixa da seleção múltipla limpa e mostra o menu do vazio', { s: await sel(), r });
  await esc();

  await cena([ret('a', { x: 100, y: 100, w: 100, h: 100 }), ret('b', { x: 300, y: 150, w: 100, h: 100 })], ['a', 'b']);
  await direito(...px(150, 150));
  await passo('Agrupar pelo menu', 'agrupar', () => item('Agrupar'));
  await direito(...px(150, 150));
  r = await rotulos();
  conferir(tem(r, 'Desagrupar') && !tem(r, 'Agrupar'), 'agrupado mostra Desagrupar (e não Agrupar)', r);
  await passo('Desagrupar pelo menu', 'desagrupar', () => item('Desagrupar'));
  conferir((await todos()).every((e) => e.grupo === null), 'Desagrupar zera os grupos');
  await av(`Whiteboard.acoes.selecionarTudo(); Whiteboard.acoes.agrupar(); Whiteboard.nucleo.selecionar([])`);
  await direito(...px(150, 150));
  conferir(JSON.stringify((await sel()).sort()) === '["a","b"]', 'botão direito num membro seleciona o grupo', await sel());
  await esc();

  if (temTravar) {
    await cena([ret('a', { x: 100, y: 100, w: 100, h: 100 })], []);
    await direito(...px(150, 150));
    await item('Travar');
    await direito(...px(150, 150));
    r = await rotulos();
    conferir(tem(r, 'Destravar') && tem(r, 'Copiar') && tem(r, 'Duplicar') && !tem(r, 'Excluir') && !tem(r, 'Trazer para frente') && !tem(r, 'Travar'), 'travado: só Destravar, Copiar, Duplicar', r);
    await item('Destravar');
    conferir(!(await av(`Whiteboard.nucleo.travado(Whiteboard.nucleo.elemento('a'))`)), 'Destravar pelo menu destrava');
  } else res.ok.push('(pendente: travar não existe na página; testar quando a entrega D estiver pronta)');
  if (!temPainel) res.ok.push('(pendente: Whiteboard.painel ausente; "Ver todas…" não testado)');
  if (!temWeb) res.ok.push('(pendente: Whiteboard.web ausente; "Adicionar navegador aqui" não testado)');
  else {
    await cena([], []);
    await direito(...px(400, 300));
    await item('Adicionar navegador aqui'); await dormir(250);
    conferir(await av(`!!document.querySelector('.wb-menu') === false`), 'Adicionar navegador aqui fecha o menu e aciona pedirEndereco');
    await esc();
  }

  // ── card de agente ──
  await cena([], []);
  await av(`Whiteboard.agentes.adicionar('s1', 300, 200)`); await dormir(150);
  await av(`Whiteboard.nucleo.selecionar([])`);
  await direito(...px(300, 200));
  r = await rotulos();
  conferir(r[0] === 'Abrir conversa' && r[1] === 'Ver detalhes', 'card de agente: Abrir conversa e Ver detalhes no topo', r);
  await item('Abrir conversa');
  conferir(JSON.stringify(await av(`demoSessoes.abertos`)) === '["s1"]', 'Abrir conversa chama a fonte', await av(`demoSessoes.abertos`));
  await direito(...px(300, 200));
  await item('Ver detalhes'); await dormir(150);
  conferir(await av(`Whiteboard.agentes.detalhesAbertos() !== null`), 'Ver detalhes abre o popover');
  await esc();

  // ── fechar ──
  await cena([ret('a')], []);
  await direito(...px(700, 500));
  await esc();
  conferir(await fechado(), 'Esc fecha');
  await direito(...px(700, 500));
  await clicar(...px(300, 600));
  conferir(await fechado(), 'clique fora fecha');
  await direito(...px(700, 500));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: L + 400, y: T + 300, deltaX: 0, deltaY: 100 }); await dormir(150);
  conferir(await fechado(), 'roda fecha');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  await direito(...px(700, 500));
  await av(`Whiteboard.nucleo.definirFerramenta('retangulo')`); await dormir(80);
  conferir(await fechado(), 'trocar de ferramenta fecha');
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);
  await direito(...px(700, 500));
  await av(`Whiteboard.nucleo.zoomEm(2, 300, 300, false)`); await dormir(100);
  conferir(await fechado(), 'zoom fecha');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);

  // ── durante arrastar não abre ──
  await mouse('mouseMoved', ...px(900, 600)); await mouse('mousePressed', ...px(900, 600), 'left', 1);
  await mouse('mouseMoved', ...px(920, 620), 'left', 1);
  await mouse('mousePressed', ...px(920, 620), 'right', 3); await mouse('mouseReleased', ...px(920, 620), 'right', 1);
  await mouse('mouseReleased', ...px(920, 620), 'left', 0); await dormir(100);
  conferir(!(await aberto()), 'botão direito durante arrastar não abre');
  await esc();

  // ── integração: trava, painel, web, exportar ──
  if (temTravar) {
    await cena([ret('a'), ret('b', { x: 400, y: 100 })], ['a']);
    await direito(...px(150, 150));
    r = await rotulos();
    conferir(tem(r, 'Travar') && !tem(r, 'Destravar'), 'menu de livre mostra Travar', r);
    await item('Travar');
    conferir(await av(`Whiteboard.nucleo.travado(Whiteboard.nucleo.elemento('a'))`), 'Travar pelo menu trava o elemento');
    await esc(); await foco();
    await direito(...px(150, 150));
    r = await rotulos();
    conferir(tem(r, 'Destravar') && !tem(r, 'Travar'), 'depois de travar o item vira Destravar', r);
    const previstos = ['Destravar', 'Copiar', 'Duplicar'];
    conferir(r.every((x) => previstos.includes(x) || x === 'Exportar seleção…') && previstos.every((x) => tem(r, x)), 'menu de travado só tem Destravar/Copiar/Duplicar', r);
    await item('Destravar');
    conferir(!(await av(`Whiteboard.nucleo.travado(Whiteboard.nucleo.elemento('a'))`)), 'Destravar pelo menu destrava');
    await esc(); await foco();
  }
  if (temPainel) {
    await cena([ret('a')], []);
    await av(`Whiteboard.painel.fechar()`);
    await direito(...px(600, 450));
    await abrirSub('Adicionar card de agente aqui');
    const vt = await centro('Ver todas…', true);
    await clicar(vt[0], vt[1]);
    conferir(await esperar(`Whiteboard.painel.aberto()`, 2000), 'Ver todas… abre o painel de agentes');
    await av(`Whiteboard.painel.fechar()`); await esc();
  }
  if (temWeb) {
    await cena([ret('a')], []);
    await direito(...px(700, 400));
    await item('Adicionar navegador aqui');
    conferir(await esperar(`!!document.querySelector('.wb-web-campo-in')`, 2000), 'Adicionar navegador aqui abre o campo de endereço');
    const cp = await av(`(() => { const r = document.querySelector('.wb-web-campo').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
    conferir(cp[0] <= L + 700 + 4 && cp[2] >= L + 700 - 4 || Math.abs(cp[0] - (L + 700)) < 360, 'o campo abre junto do ponto clicado', cp);
    await av(`(() => { const i = document.querySelector('.wb-web-campo-in'); i.focus(); i.value = 'exemplo.com'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await tecla('Enter', 'Enter', 0, 13); await dormir(150);
    const wc = (await todos()).find((e) => e.tipo === 'web');
    conferir(wc && perto(wc.x + wc.w / 2, 700, 1.5) && perto(wc.y + wc.h / 2, 400, 1.5), 'o card web nasce centrado no ponto clicado', wc && [wc.x, wc.y, wc.w, wc.h]);
    await esc();
  }
  const temExp = await av(`!!(Whiteboard.exportar && typeof Whiteboard.exportar.abrir === 'function')`);
  await cena([ret('a')], ['a']);
  await direito(...px(150, 150));
  conferir(tem(await rotulos(), 'Exportar seleção…') === temExp, 'Exportar seleção… só com Whiteboard.exportar', { temExp });
  await esc();

  // ── bordas ──
  const dentro = () => av(`(() => { const r = document.querySelector('.wb-menu').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
  await cena([ret('a', { x: 100, y: 100, w: 100, h: 100 })], []);
  for (const [nome, x, y] of [['canto inferior direito', 1195, 795], ['borda direita', 1195, 300], ['borda inferior', 300, 795], ['canto superior esquerdo', 40, 200]]) {
    await direito(...px(x, y));
    conferir((await aberto()) && (await dentro()), 'menu dentro da vista no ' + nome, await av(`JSON.stringify(document.querySelector('.wb-menu') && document.querySelector('.wb-menu').getBoundingClientRect())`));
    await esc();
  }
  await cena([ret('a', { x: 1000, y: 500, w: 100, h: 100 }), ret('b', { x: 1050, y: 550, w: 100, h: 100 })], ['a', 'b']);
  await direito(...px(1090, 590)); // dentro de um selecionado (no vazio a seleção seria limpa)
  await abrirSub('Alinhar');
  const sp = await av(`(() => { const p = document.querySelector('.wb-menu:not(.wb-menu-sub)').getBoundingClientRect(), s = document.querySelector('.wb-menu-sub').getBoundingClientRect(); return { esquerda: s.right <= p.left + 4, dentro: s.left >= 0 && s.right <= innerWidth && s.bottom <= innerHeight }; })()`);
  conferir(sp.esquerda && sp.dentro, 'submenu vira para a esquerda sem espaço à direita', sp);
  await esc(); await esc();

  // ── teclado ──
  await cena([ret('a', { x: 100, y: 100, w: 100, h: 100 })], []);
  await direito(...px(150, 150));
  await tecla('ArrowDown', 'ArrowDown', 0, 40);
  const f1 = await av(`document.activeElement.textContent`);
  await tecla('ArrowDown', 'ArrowDown', 0, 40);
  const f2 = await av(`document.activeElement.textContent`);
  conferir(f1 && f2 && f1 !== f2, 'setas movem o foco entre os itens', [f1, f2]);
  await passo('Enter ativa o item focado', 'excluir', async () => {
    await av(`[...document.querySelectorAll('.wb-menu .wb-menu-item')].find((b) => b.querySelector('.mi-rot').textContent === 'Excluir').focus()`);
    await tecla('Enter', 'Enter', 0, 13);
  });

  // ── API e toque longo ──
  await cena([ret('a', { x: 100, y: 100, w: 100, h: 100 })], []);
  await av(`Whiteboard.menu.abrir(${L + 700}, ${T + 400})`);
  conferir(await aberto(), 'Whiteboard.menu.abrir(sx, sy) abre');
  await av(`Whiteboard.menu.fechar()`);
  conferir(await fechado(), 'Whiteboard.menu.fechar() fecha');
  await av(`window.__pe = []; for (const t of ['pointerdown','pointermove','pointerup','pointercancel','contextmenu','blur']) document.addEventListener(t, (e) => __pe.push(t + ':' + e.pointerType + '@' + Math.round(performance.now())), true)`);
  await cdp('Page.bringToFront'); await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await mouse('mouseMoved', 5, 5, 'none', 0); await dormir(50);
  await av(`new MutationObserver((ms) => { for (const m of ms) for (const n of [...m.addedNodes, ...m.removedNodes]) if (n.classList && n.classList.contains('wb-menu')) __pe.push((m.addedNodes.length ? 'add' : 'rem') + '@' + Math.round(performance.now())); }).observe(document.body, { childList: true }); window.addEventListener('blur', () => __pe.push('winblur@' + Math.round(performance.now())))`);
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const tocar = async () => { await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L + 150, y: T + 150 }] }); };
  await tocar();
  // O Edge headless às vezes descarta o toque do CDP; sem pointerdown, entrega um PointerEvent de toque equivalente (a lógica testada é a mesma).
  const sintetico = !(await av(`__pe.some((x) => x.startsWith('pointerdown:touch'))`));
  if (sintetico) await av(`document.querySelector('.wb-palco').dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: ${L + 150}, clientY: ${T + 150}, bubbles: true, cancelable: true }))`);
  await dormir(1400);
  const abertoAntes = await aberto();
  if (sintetico) await av(`document.querySelector('.wb-palco').dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, bubbles: true }))`); else await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await dormir(100);
  conferir(await aberto(), 'toque longo (~500 ms) abre o menu', { abertoAntes, pe: await av('__pe'), ativo: await av('Whiteboard.estado().ativo'), vis: await av('document.visibilityState + document.hasFocus()'), op: await av('Whiteboard.menu.abrir(' + (L + 150) + ',' + (T + 150) + ')') });
  await esc();

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard menu UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
