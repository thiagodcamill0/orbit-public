// Teste de UI do canvas de escritórios (assets/escritorios-canvas.js) contra testes/escritorios-canvas.html.
// Servidor estático próprio (porta livre de 47822–47826; nunca 47821): serve /assets e /testes. A página usa um fetch falso
// (window.__banco, window.__chamadas), então nenhuma rota real é necessária. Edge headless mudo, perfil temporário apagado no fim.
// Cobre: ladrilhos (N+1, pontos, pílula), card de resumo (hover e Tab), arrastar (grade de 20 px, sem sobrepor, POST {canvas},
// falha do POST), renomear inline, duplo clique, menu (⋯, clique direito, teclado, callbacks), Sessões, criar, zoom/pan/câmera
// salva, Ajustar, atualizar(ev), lista vazia/erro de carga, miniatura que falha, desmontar sem listeners/timers e 0 erro de console.
// node testes/escritorios-canvas-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-escritorios-canvas-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// ───────── servidor estático ─────────
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47825);
const srv = http.createServer((req, r2) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { r2.writeHead(405); r2.end(); return; }
    const alvo = path.resolve(PROJ, '.' + decodeURIComponent(url.pathname));
    if (!alvo.startsWith(PROJ + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { r2.writeHead(404); r2.end(); return; }
    r2.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(alvo).pipe(r2);
  } catch (e) { if (!r2.headersSent) r2.writeHead(500); r2.end(String(e?.message || e)); }
});
await new Promise((r) => srv.listen(PORTA, '127.0.0.1', r));
const URL_PAG = `http://127.0.0.1:${PORTA}/testes/escritorios-canvas.html`;

// Espiões instalados antes dos scripts da página: listeners (addEventListener) e timers/rAF pendentes.
const ESPIAO = `(() => {
  const reg = [];
  const cap = (o) => (typeof o === 'boolean' ? o : !!(o && o.capture));
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (tipo, fn, o) {
    if (fn && !reg.some((x) => x.t === this && x.tipo === tipo && x.fn === fn && x.cap === cap(o))) reg.push({ t: this, tipo, fn, cap: cap(o) });
    return add.call(this, tipo, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (tipo, fn, o) {
    const i = reg.findIndex((x) => x.t === this && x.tipo === tipo && x.fn === fn && x.cap === cap(o));
    if (i >= 0) reg.splice(i, 1);
    return rem.call(this, tipo, fn, o);
  };
  // vivos = presos a window/document ou a nós ainda no documento
  window.__ouvintes = () => reg.filter((x) => x.t === window || x.t === document || (x.t instanceof Node && x.t.isConnected)).map((x) => (x.t === window ? 'window' : x.t === document ? 'document' : x.t.nodeName) + ':' + x.tipo);
  const t = new Set(), r = new Set();
  const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval, raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.setTimeout = (f, ms, ...a) => { const id = st(() => { t.delete(id); if (typeof f === 'function') f(...a); }, ms); t.add(id); return id; };
  window.clearTimeout = (id) => { t.delete(id); return ct(id); };
  window.setInterval = (f, ms, ...a) => { const id = si(f, ms, ...a); t.add(id); return id; };
  window.clearInterval = (id) => { t.delete(id); return ci(id); };
  window.requestAnimationFrame = (f) => { const id = raf((ts) => { r.delete(id); f(ts); }); r.add(id); return id; };
  window.cancelAnimationFrame = (id) => { r.delete(id); return caf(id); };
  window.__pendentes = () => ({ timers: t.size, raf: r.size });
})();`;

let pcdp, ws;
try {
  pcdp = await escolherPorta(47826);
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
  const esperar = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(40); } return false; };

  // entrada
  const tecla = async (key, code, vk, extra = {}) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...extra });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: extra.modifiers || 0 });
  };
  const enter = () => tecla('Enter', 'Enter', 13, { text: '\r' });
  const esc = () => tecla('Escape', 'Escape', 27);
  const baixo = () => tecla('ArrowDown', 'ArrowDown', 40);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra });
  const mover = (x, y) => mouse('mouseMoved', x, y);
  const clicar = async (x, y, { n = 1, botao = 'left' } = {}) => {
    await mover(x, y);
    const bs = botao === 'left' ? 1 : 2;
    for (let i = 1; i <= n; i++) {
      await mouse('mousePressed', x, y, { button: botao, buttons: bs, clickCount: i });
      await mouse('mouseReleased', x, y, { button: botao, buttons: 0, clickCount: i });
    }
  };
  const arrastar = async (x0, y0, x1, y1, passos = 8) => {
    await mover(x0, y0);
    await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= passos; i++) await mouse('mouseMoved', x0 + ((x1 - x0) * i) / passos, y0 + ((y1 - y0) * i) / passos, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', x1, y1, { button: 'left', buttons: 0, clickCount: 1 });
  };
  const roda = (x, y, dx, dy, modifiers = 0) => mouse('mouseWheel', x, y, { deltaX: dx, deltaY: dy, modifiers });

  const lib = `
    window.T = (id) => document.querySelector('.esc-cv-ladrilho[data-id="' + id + '"]');
    window.ladrilhos = () => [...document.querySelectorAll('.esc-cv-ladrilho')];
    window.centro = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    window.vistaR = () => document.querySelector('.esc-cv-vista').getBoundingClientRect();
    window.btn = (t, raiz = document) => [...raiz.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent).trim() === t);
    window.cham = (tipo) => __chamadas.filter((c) => c.tipo === tipo);
    window.posts = () => __chamadas.filter((c) => c.tipo === 'fetch');
    window.menu = () => document.querySelector('.esc-cv-menu');
    window.acoes = () => menu() ? [...menu().querySelectorAll('.menu-item')].map((b) => b.dataset.acao) : null;
    window.focoAcao = () => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.acao : null;
    window.card = () => document.querySelector('.esc-cv-card');
    window.cardVis = () => !card().hidden;
    window.sobrepoe = () => { const p = ladrilhos().map((e) => ({ id: e.dataset.id, x: +e.dataset.x, y: +e.dataset.y })); const r = [];
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (Math.abs(p[i].x - p[j].x) < 240 && Math.abs(p[i].y - p[j].y) < 200) r.push(p[i].id + '~' + p[j].id); return r; };
    window.colideCom = (x, y, sem) => ladrilhos().some((e) => e.dataset.id !== sem && Math.abs(x - +e.dataset.x) < 260 && Math.abs(y - +e.dataset.y) < 220);
    window.colisoes = () => { const p = ladrilhos().map((e) => ({ id: e.dataset.id, x: +e.dataset.x, y: +e.dataset.y })); const r = [];
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (Math.abs(p[i].x - p[j].x) < 260 && Math.abs(p[i].y - p[j].y) < 220) r.push(p[i].id + '~' + p[j].id); return r; };
    window.posDe = () => Object.fromEntries(ladrilhos().map((e) => [e.dataset.id, e.dataset.x + ',' + e.dataset.y]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    window.nasGrade = () => ladrilhos().every((e) => +e.dataset.x % 20 === 0 && +e.dataset.y % 20 === 0);
    window.pronto = (n) => ladrilhos().length === n && !!EscritoriosCanvas.camera() && document.querySelector('.esc-cv').dataset.mini !== 'carregando';
    window.vazioPt = () => { for (const [x, y] of [[30, 400], [30, 300], [40, 700], [1250, 400]]) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.esc-cv-ladrilho, .esc-cv-barra, .esc-cv-card, .esc-cv-vazio')) return { x, y }; } return null; };
    true`;

  // fresco: monta uma só vez (sem desmontar/zerar) e NÃO limpa __chamadas, para ver os POST de posição da primeira carga
  const abrir = async (query, n, fresco = false) => {
    if (fresco) {
      await cdp('Page.navigate', { url: URL_PAG + (query || '?') + '&adiar=1' });
      await esperar(`document.readyState === 'complete' && !!window.EscritoriosCanvas && typeof window.__remontar === 'function'`, 8000);
      await av(lib);
      await av(`localStorage.clear(); __remontar(); true`);
      await esperar(`pronto(${n})`, 6000);
      return;
    }
    await cdp('Page.navigate', { url: URL_PAG + (query || '') });
    await esperar(`document.readyState === 'complete' && !!window.EscritoriosCanvas && !!document.querySelector('.esc-cv')`, 8000);
    await av(lib);
    // zera o armazenamento sem o desmontar regravar a câmera, e monta de novo
    await av(`EscritoriosCanvas.desmontar(); localStorage.clear(); __remontar(); true`);
    await esperar(`pronto(${n})`, 6000);
    await av(`__chamadas.length = 0; true`);
  };
  const estavel = async () => {
    let a = '';
    for (let i = 0; i < 30; i++) { const c = JSON.stringify(await av('EscritoriosCanvas.camera()')); if (c === a) return; a = c; await dormir(110); }
  };

  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: ESPIAO });
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  let r;

  // ── 1. Montagem: N+1 ladrilhos, pontos de status, pílula ──
  await abrir('', 4);
  r = await av(`({ ids: ladrilhos().map((e) => e.dataset.id).sort(), qtd: document.querySelector('.esc-cv').dataset.qtd, mini: document.querySelector('.esc-cv').dataset.mini,
    sess: T('sessoes').classList.contains('esc-cv-sessoes'), nomes: ladrilhos().map((e) => e.querySelector('.esc-cv-nome').textContent).sort(),
    sobrepoe: sobrepoe(), grade: nasGrade(), raizes: document.querySelectorAll('.esc-cv').length,
    btns: [...document.querySelectorAll('.esc-cv-barra button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()) })`);
  conferir(JSON.stringify(r.ids) === JSON.stringify(['esc-docs', 'esc-suporte', 'esc-vendas', 'sessoes']) && r.qtd === '3' && r.sess, 'monta com N+1 ladrilhos (3 escritórios + Sessões)', r);
  conferir(r.nomes.includes('Sessões') && r.nomes.includes('Vendas e propostas') && r.nomes.includes('Suporte') && r.nomes.includes('Documentação'), 'cada ladrilho mostra o nome', r.nomes);
  conferir(r.mini === 'simples', 'a miniatura do mapa é desenhada (data-mini=simples)', r.mini);
  conferir(r.sobrepoe.length === 0 && r.grade, 'posições iniciais encaixadas em 20 px e sem sobrepor', r);
  conferir(r.raizes === 1 && JSON.stringify(r.btns) === JSON.stringify(['Novo escritório', 'Ajustar a vista a todos os ladrilhos', 'Afastar', 'Aproximar']), 'uma só raiz; a barra tem Novo escritório, Ajustar, Afastar e Aproximar', r);
  r = await av(`(() => {
    const est = (id) => [...T(id).querySelectorAll('.esc-cv-ponto')].map((p) => p.dataset.estado);
    const cor = (e) => getComputedStyle(document.querySelector('.esc-cv-ponto[data-estado="' + e + '"]')).backgroundColor;
    const cores = ['trabalhando', 'aguardando', 'ocioso', 'dormindo', 'erro'].map(cor);
    const pil = (id) => { const p = T(id).querySelector('.esc-cv-pilula'); return { t: p.textContent, s: p.dataset.status, c: getComputedStyle(p).color }; };
    return { vendas: est('esc-vendas'), suporte: est('esc-suporte'), docs: est('esc-docs'), sessoes: T('sessoes').querySelectorAll('.esc-cv-ponto').length,
      conv: T('esc-vendas').querySelector('.esc-cv-conv')?.textContent, convSup: !!T('esc-suporte').querySelector('.esc-cv-conv'),
      titulo: T('esc-vendas').querySelector('.esc-cv-ponto').title, cores, unicas: new Set(cores).size,
      vendasP: pil('esc-vendas'), suporteP: pil('esc-suporte'), docsP: pil('esc-docs'),
      aria: T('esc-suporte').getAttribute('aria-label'), stT: T('esc-suporte').dataset.status };
  })()`);
  conferir(JSON.stringify(r.vendas) === JSON.stringify(['trabalhando', 'trabalhando', 'aguardando', 'ocioso']) && JSON.stringify(r.suporte) === JSON.stringify(['ocioso', 'dormindo', 'erro']) && r.docs.length === 2 && r.sessoes === 0,
    'um ponto por agente com data-estado do estado (Sessões não tem pontos)', r);
  conferir(r.unicas === 5 && r.cores.every((c) => c && c !== 'rgba(0, 0, 0, 0)'), 'cada estado (trabalhando/aguardando/ocioso/dormindo/erro) tem uma cor própria', r.cores);
  conferir(r.conv === '+1' && !r.convSup && /Orquestrador · líder · Trabalhando/.test(r.titulo), 'convidados aparecem como "+1"; o ponto tem título com nome, papel e estado', r);
  conferir(r.vendasP.t === 'Rodando' && r.vendasP.s === 'rodando' && r.suporteP.t === 'Pausada' && r.suporteP.s === 'pausada' && r.docsP.t === 'Ociosa' && r.stT === 'pausada', 'pílula de status por escritório (Rodando, Pausada, Ociosa)', r);
  conferir(r.vendasP.c !== r.suporteP.c && r.suporteP.c !== r.docsP.c, 'pílulas de status com cores diferentes', [r.vendasP.c, r.suporteP.c, r.docsP.c]);
  conferir(/Pausada \(orçamento da execução\)/.test(r.aria) && /Enter para entrar/.test(r.aria), 'rótulo acessível do ladrilho pausado traz o motivo e "Enter para entrar"', r.aria);

  // ── 2. Card de resumo: hover ──
  let c = await av(`centro(T('esc-vendas'))`);
  await mover(c.x, c.y);
  await esperar(`cardVis()`);
  r = await av(`({ vis: cardVis(), role: card().getAttribute('role'), txt: card().textContent })`);
  conferir(r.vis && r.role === 'tooltip' && /Vendas e propostas/.test(r.txt) && /Qualifica leads/.test(r.txt), 'hover no ladrilho abre o card com nome e função', r);
  conferir(/2 de 4 ativos/.test(r.txt) && /1 convidado/.test(r.txt) && /US\$ 0,03 de US\$ 0,50/.test(r.txt) && /US\$ 0,18 de US\$ 2,00/.test(r.txt) && /6,4%/.test(r.txt) && /Rodando/.test(r.txt),
    'card: agentes ativos/total e convidados, gasto da execução e do dia com limite, % do plano e status', r.txt);
  c = await av(`centro(T('esc-suporte'))`);
  await mover(c.x, c.y);
  await esperar(`/Suporte/.test(card().textContent)`);
  r = await av(`card().textContent`);
  conferir(/Pausada · orçamento da execução/.test(r) && /US\$ 0,50 de US\$ 0,50/.test(r) && /18%/.test(r) && /0 de 3 ativos/.test(r), 'card do escritório pausado mostra o motivo, gasto no limite e 18% do plano', r);
  c = await av(`centro(T('esc-docs'))`);
  await mover(c.x, c.y);
  await esperar(`/Documentação/.test(card().textContent)`);
  r = await av(`({ txt: card().textContent, fn: !!card().querySelector('.esc-cv-card-fn') })`);
  conferir(!r.fn && /0 de 2 ativos/.test(r.txt) && /US\$ 0,00 de US\$ 0,30/.test(r.txt) && /0%/.test(r.txt), 'sem função, o card não tem parágrafo de função; gasto zero formatado', r);
  c = await av(`centro(T('sessoes'))`);
  await mover(c.x, c.y);
  await esperar(`/Office de sempre/.test(card().textContent)`);
  conferir(await av(`cardVis() && /Sessões/.test(card().textContent)`), 'hover em Sessões abre um card explicativo', await av(`card().textContent`));
  let vz = await av(`vazioPt()`);
  await mover(vz.x, vz.y);
  await esperar(`!cardVis()`);
  conferir(await av(`!cardVis()`), 'o card some quando o ponteiro sai do ladrilho', null);

  // ── 3. Card de resumo: foco por Tab ──
  await clicar(vz.x, vz.y);
  await tecla('Tab', 'Tab', 9);
  r = await av(`({ id: document.activeElement.dataset && document.activeElement.dataset.id, vis: cardVis(), txt: card().textContent })`);
  conferir(r.id === 'sessoes' && r.vis && /Sessões/.test(r.txt), 'Tab leva ao único tab stop dos ladrilhos (Sessões) e abre seu card', r);
  await av(`T('esc-vendas').focus(); true`);
  r = await av(`({ id: document.activeElement.dataset.id, vis: cardVis(), txt: card().textContent })`);
  conferir(r.id === 'esc-vendas' && r.vis && /Vendas e propostas/.test(r.txt) && /2 de 4 ativos/.test(r.txt) && /US\$ 0,03 de US\$ 0,50/.test(r.txt) && /6,4%/.test(r.txt) && /Qualifica leads/.test(r.txt),
    'foco por Tab em um escritório abre o card com função, agentes ativos, gasto/limite e % do plano', r);
  // teclado no ladrilho focado
  await tecla('ArrowRight', 'ArrowRight', 39);
  conferir(await av(`document.activeElement.dataset.id`) === 'esc-suporte', 'seta para a direita move o foco ao ladrilho vizinho', await av(`document.activeElement.dataset.id`));
  r = await av(`/Suporte/.test(card().textContent)`);
  conferir(r, 'o card acompanha o ladrilho focado', await av(`card().textContent`));
  await tecla('ArrowLeft', 'ArrowLeft', 37);
  await enter();
  r = await av(`cham('onEntrar')`);
  conferir(r.length === 1 && r[0].arg === 'esc-vendas', 'Enter no ladrilho focado chama onEntrar(id)', r);
  await tecla('F2', 'F2', 113);
  r = await av(`({ inp: !!document.querySelector('.esc-cv-nome-in'), foco: document.activeElement.className, val: document.querySelector('.esc-cv-nome-in')?.value })`);
  conferir(r.inp && r.foco === 'esc-cv-nome-in' && r.val === 'Vendas e propostas', 'F2 no ladrilho abre a edição do nome com foco no campo', r);
  await esc();
  r = await av(`({ inp: !!document.querySelector('.esc-cv-nome-in'), foco: document.activeElement.dataset.id, posts: posts().length })`);
  conferir(!r.inp && r.foco === 'esc-vendas' && r.posts === 0, 'Esc cancela a edição e devolve o foco ao ladrilho', r);
  await clicar(vz.x, vz.y);
  conferir(await av(`!cardVis()`), 'clicar no fundo esconde o card', null);

  // ── 4. Arrastar ──
  await av(`__chamadas.length = 0; true`);
  const z4 = (await av(`EscritoriosCanvas.camera()`)).zoom;
  c = await av(`centro(T('esc-docs'))`);
  await mover(c.x, c.y);
  await mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseMoved', c.x + 100 * z4, c.y + 3 * z4, { button: 'left', buttons: 1 });
  await mouse('mouseMoved', c.x + 507 * z4, c.y + 13 * z4, { button: 'left', buttons: 1 });
  r = await av(`({ cls: T('esc-docs').classList.contains('esc-cv-arrastando'), alvo: (() => { const a = document.querySelector('.esc-cv-alvo'); return { hid: a.hidden, x: parseFloat(a.style.left), y: parseFloat(a.style.top) }; })() })`);
  conferir(r.cls && !r.alvo.hid && r.alvo.x === 700 && r.alvo.y === 440, 'durante o arrasto o ladrilho ganha a classe e o alvo mostra o destino encaixado (700,440)', r);
  await mouse('mouseReleased', c.x + 507 * z4, c.y + 13 * z4, { button: 'left', buttons: 0, clickCount: 1 });
  await esperar(`posts().length === 1`);
  r = await av(`({ x: +T('esc-docs').dataset.x, y: +T('esc-docs').dataset.y, p: posts(), alvoH: document.querySelector('.esc-cv-alvo').hidden, cls: T('esc-docs').classList.contains('esc-cv-arrastando'),
    banco: __banco.find((b) => b.id === 'esc-docs').canvas, sobrepoe: sobrepoe(), entrar: cham('onEntrar').length })`);
  conferir(r.x === 700 && r.y === 440 && r.alvoH && !r.cls, 'ao soltar, o ladrilho encaixa na grade de 20 px (700,440) e o alvo some', r);
  conferir(r.p.length === 1 && r.p[0].metodo === 'POST' && r.p[0].url === '/escritorios/esc-docs' && JSON.stringify(r.p[0].corpo) === '{"canvas":{"x":700,"y":440}}' && r.p[0].cabecalho === '1',
    'arrastar grava POST /escritorios/:id com {canvas:{x,y}} encaixado e o cabeçalho x-gerenciador', r.p);
  conferir(r.banco.x === 700 && r.banco.y === 440 && r.sobrepoe.length === 0 && r.entrar === 0, 'o banco recebe a posição; nada sobrepõe; arrastar não chama onEntrar', r);
  // soltar em cima de outro: empurra ao espaço livre mais próximo
  await av(`__chamadas.length = 0; true`);
  c = await av(`centro(T('esc-docs'))`);
  const sup = await av(`({ x: +T('esc-suporte').dataset.x, y: +T('esc-suporte').dataset.y })`);
  await arrastar(c.x, c.y, c.x + (430 - 700) * z4, c.y + (170 - 440) * z4);
  await esperar(`posts().length === 1`);
  r = await av(`({ x: +T('esc-docs').dataset.x, y: +T('esc-docs').dataset.y, p: posts(), sobrepoe: sobrepoe(), grade: nasGrade(), sup: { x: +T('esc-suporte').dataset.x, y: +T('esc-suporte').dataset.y } })`);
  conferir(r.sobrepoe.length === 0 && r.grade && r.sup.x === sup.x && r.sup.y === sup.y, 'soltar sobre outro ladrilho nunca sobrepõe: vai ao espaço livre mais próximo, encaixado', r);
  conferir(r.p.length === 1 && r.p[0].corpo.canvas.x === r.x && r.p[0].corpo.canvas.y === r.y, 'o POST leva a posição final (já sem sobreposição)', { p: r.p, x: r.x, y: r.y });
  // arrasto curto (< 4 px) não move nem grava
  await av(`__chamadas.length = 0; true`);
  c = await av(`centro(T('esc-vendas'))`);
  await arrastar(c.x, c.y, c.x + 2, c.y + 2, 2);
  await dormir(150);
  r = await av(`({ p: posts().length })`);
  conferir(r.p === 0, 'um clique com tremor de 2 px não grava posição', r);
  // Esc durante o arrasto cancela
  const antes = await av(`({ x: +T('esc-vendas').dataset.x, y: +T('esc-vendas').dataset.y })`);
  c = await av(`centro(T('esc-vendas'))`);
  await mover(c.x, c.y);
  await mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseMoved', c.x + 60, c.y + 50, { button: 'left', buttons: 1 });
  await mouse('mouseMoved', c.x + 120, c.y + 100, { button: 'left', buttons: 1 });
  await esc();
  await mouse('mouseReleased', c.x + 120, c.y + 100, { button: 'left', buttons: 0, clickCount: 1 });
  await dormir(150);
  r = await av(`({ x: +T('esc-vendas').dataset.x, y: +T('esc-vendas').dataset.y, p: posts().length, cls: T('esc-vendas').classList.contains('esc-cv-arrastando') })`);
  conferir(r.x === antes.x && r.y === antes.y && r.p === 0 && !r.cls, 'Esc durante o arrasto cancela: o ladrilho volta e nada é gravado', r);

  // ── 5. Arrastar com falha do servidor ──
  await abrir('?falha=1', 4);
  c = await av(`centro(T('esc-docs'))`);
  const z5 = (await av(`EscritoriosCanvas.camera()`)).zoom;
  await arrastar(c.x, c.y, c.x + 507 * z5, c.y + 13 * z5);
  await esperar(`!document.querySelector('.esc-cv-aviso').hidden`);
  r = await av(`({ aviso: document.querySelector('.esc-cv-aviso').textContent, x: +T('esc-docs').dataset.x, y: +T('esc-docs').dataset.y, banco: __banco.find((b) => b.id === 'esc-docs').canvas })`);
  conferir(/Não foi possível salvar a posição: Falha simulada\./.test(r.aviso) && r.x === 200 && r.y === 420 && r.banco.x === 200, 'POST com 500: o ladrilho volta à posição anterior e o aviso explica o erro', r);

  // ── 6. Renomear inline ──
  await abrir('', 4);
  c = await av(`centro(T('esc-suporte').querySelector('.esc-cv-nome'))`);
  await clicar(c.x, c.y, { n: 2 });
  await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
  r = await av(`({ val: document.querySelector('.esc-cv-nome-in').value, foco: document.activeElement.className, nomeOculto: T('esc-suporte').querySelector('.esc-cv-nome').hidden, entrar: cham('onEntrar').length })`);
  conferir(r.val === 'Suporte' && r.foco === 'esc-cv-nome-in' && r.nomeOculto && r.entrar === 0, 'duplo clique no nome abre o campo de renomear com o texto selecionado e sem entrar', r);
  await cdp('Input.insertText', { text: 'Atendimento' });
  await enter();
  await esperar(`posts().length === 1`);
  r = await av(`({ p: posts(), nome: T('esc-suporte').querySelector('.esc-cv-nome').textContent, inp: !!document.querySelector('.esc-cv-nome-in'), foco: document.activeElement.dataset.id, banco: __banco.find((b) => b.id === 'esc-suporte').nome })`);
  conferir(r.p.length === 1 && r.p[0].url === '/escritorios/esc-suporte' && JSON.stringify(r.p[0].corpo) === '{"nome":"Atendimento"}' && r.p[0].cabecalho === '1', 'Enter grava POST /escritorios/:id com {nome}', r.p);
  conferir(r.nome === 'Atendimento' && !r.inp && r.foco === 'esc-suporte' && r.banco === 'Atendimento', 'o nome novo aparece no ladrilho, o campo some e o foco volta ao ladrilho', r);
  c = await av(`centro(T('esc-suporte').querySelector('.esc-cv-nome'))`);
  await clicar(c.x, c.y, { n: 2 });
  await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
  await cdp('Input.insertText', { text: 'Descartado' });
  await esc();
  r = await av(`({ p: posts().length, nome: T('esc-suporte').querySelector('.esc-cv-nome').textContent, inp: !!document.querySelector('.esc-cv-nome-in') })`);
  conferir(r.p === 1 && r.nome === 'Atendimento' && !r.inp, 'Esc cancela a renomeação: nome intacto e nenhum POST novo', r);
  await clicar(c.x, c.y, { n: 2 });
  await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
  await tecla('Backspace', 'Backspace', 8);
  await enter();
  r = await av(`({ inp: !!document.querySelector('.esc-cv-nome-in'), inv: document.querySelector('.esc-cv-nome-in')?.getAttribute('aria-invalid'), aviso: document.querySelector('.esc-cv-aviso').hidden ? '' : document.querySelector('.esc-cv-aviso').textContent, p: posts().length })`);
  conferir(r.inp && r.inv === 'true' && /1 a 60 caracteres/.test(r.aviso) && r.p === 1, 'nome vazio é recusado: o campo continua, marcado como inválido, com aviso e sem POST', r);
  await esc();
  r = await av(`({ nome: T('esc-suporte').querySelector('.esc-cv-nome').textContent, p: posts().length })`);
  conferir(r.nome === 'Atendimento' && r.p === 1, 'depois de recusar o vazio, Esc mantém o nome anterior', r);
  // pelo blur: texto válido grava
  await clicar(c.x, c.y, { n: 2 });
  await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
  await cdp('Input.insertText', { text: 'Pós-venda' });
  await clicar(vz.x, vz.y);
  await esperar(`posts().length === 2`);
  r = await av(`({ p: posts()[1], nome: T('esc-suporte').querySelector('.esc-cv-nome').textContent })`);
  conferir(r.p && JSON.stringify(r.p.corpo) === '{"nome":"Pós-venda"}' && r.nome === 'Pós-venda', 'sair do campo (blur) com texto válido também grava o nome', r);

  // ── 7. Duplo clique e Sessões ──
  await abrir('', 4);
  c = await av(`centro(T('esc-vendas'))`);
  await clicar(c.x, c.y, { n: 2 });
  r = await av(`({ e: cham('onEntrar'), nomeIn: !!document.querySelector('.esc-cv-nome-in') })`);
  conferir(r.e.length === 1 && r.e[0].arg === 'esc-vendas' && !r.nomeIn, 'duplo clique no ladrilho chama onEntrar(id)', r);
  c = await av(`centro(T('sessoes'))`);
  await clicar(c.x, c.y, { n: 2 });
  r = await av(`cham('onEntrar').map((x) => x.arg)`);
  conferir(JSON.stringify(r) === '["esc-vendas","sessoes"]', 'duplo clique em Sessões chama onEntrar("sessoes")', r);
  c = await av(`centro(T('sessoes').querySelector('.esc-cv-nome'))`);
  await clicar(c.x, c.y, { n: 2 });
  r = await av(`({ e: cham('onEntrar').map((x) => x.arg), inp: !!document.querySelector('.esc-cv-nome-in') })`);
  conferir(r.e.length === 3 && r.e[2] === 'sessoes' && !r.inp, 'duplo clique no nome de Sessões entra (não renomeia)', r);

  // ── 8. Menu de contexto ──
  await av(`__chamadas.length = 0; true`);
  c = await av(`centro(T('esc-vendas').querySelector('.esc-cv-mais'))`);
  await clicar(c.x, c.y);
  await esperar(`!!menu()`);
  r = await av(`({ acoes: acoes(), foco: focoAcao(), role: menu().getAttribute('role'), pai: menu().parentElement.nodeName, tit: menu().querySelector('.menu-tit').textContent,
    rots: [...menu().querySelectorAll('.mi-rot')].map((e) => e.textContent), perigo: menu().querySelector('[data-acao=excluir]').classList.contains('perigo'), exp: T('esc-vendas').querySelector('.esc-cv-mais').getAttribute('aria-haspopup'), entrar: cham('onEntrar').length })`);
  conferir(JSON.stringify(r.acoes) === '["entrar","renomear","editar","duplicar","excluir"]' && r.role === 'menu' && r.pai === 'BODY' && r.tit === 'Vendas e propostas' && r.perigo && r.exp === 'menu' && r.entrar === 0,
    'o botão ⋯ abre o menu no body com Entrar, Renomear, Editar, Duplicar e Excluir (perigo)', r);
  conferir(r.foco === 'entrar' && JSON.stringify(r.rots) === '["Entrar","Renomear","Editar","Duplicar","Excluir"]', 'o primeiro item recebe o foco; rótulos em português', r);
  await baixo(); const f1 = await av(`focoAcao()`);
  await tecla('End', 'End', 35); const f2 = await av(`focoAcao()`);
  await baixo(); const f3 = await av(`focoAcao()`);
  await tecla('Home', 'Home', 36); const f4 = await av(`focoAcao()`);
  await tecla('ArrowUp', 'ArrowUp', 38); const f5 = await av(`focoAcao()`);
  conferir([f1, f2, f3, f4, f5].join() === 'renomear,excluir,entrar,entrar,excluir', 'teclado no menu: setas circulam, Home/End vão às pontas', [f1, f2, f3, f4, f5]);
  await esc();
  r = await av(`({ menu: !!menu(), foco: document.activeElement.dataset.id })`);
  conferir(!r.menu && r.foco === 'esc-vendas', 'Esc fecha o menu e devolve o foco ao ladrilho', r);
  await clicar(c.x, c.y);
  await esperar(`!!menu()`);
  await tecla('Tab', 'Tab', 9);
  r = await av(`({ menu: !!menu(), foco: document.activeElement.dataset.id })`);
  conferir(!r.menu && r.foco === 'esc-vendas', 'Tab dentro do menu também fecha e devolve o foco', r);
  await clicar(c.x, c.y);
  await esperar(`!!menu()`);
  await clicar(vz.x, vz.y);
  conferir(await av(`!menu()`), 'clicar fora fecha o menu', null);
  // callbacks pelo mouse: Duplicar / Editar / Excluir / Entrar
  for (const [acao, cb] of [['duplicar', 'onDuplicar'], ['editar', 'onEditar'], ['excluir', 'onExcluir'], ['entrar', 'onEntrar']]) {
    await clicar(c.x, c.y);
    await esperar(`!!menu()`);
    const it = await av(`centro(menu().querySelector('[data-acao=${acao}]'))`);
    await clicar(it.x, it.y);
    r = await av(`({ chamou: cham('${cb}').map((x) => x.arg), menu: !!menu() })`);
    conferir(JSON.stringify(r.chamou) === '["esc-vendas"]' && !r.menu, `menu: clicar em ${acao} chama ${cb}("esc-vendas") e fecha o menu`, r);
  }
  // pelo teclado: Enter no item focado
  await av(`__chamadas.length = 0; true`);
  await clicar(c.x, c.y);
  await esperar(`!!menu()`);
  await baixo(); await baixo(); await baixo(); await baixo();
  await enter();
  r = await av(`({ ex: cham('onExcluir').map((x) => x.arg), menu: !!menu() })`);
  conferir(JSON.stringify(r.ex) === '["esc-vendas"]' && !r.menu, 'menu pelo teclado: 4 setas + Enter = Excluir', r);
  await clicar(c.x, c.y);
  await esperar(`!!menu()`);
  await baixo(); await enter();
  await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
  r = await av(`({ inp: !!document.querySelector('.esc-cv-nome-in'), menu: !!menu(), foco: document.activeElement.className })`);
  conferir(r.inp && !r.menu && r.foco === 'esc-cv-nome-in', 'menu: Renomear abre a edição inline', r);
  await esc();
  // clique direito
  c = await av(`centro(T('esc-suporte'))`);
  await clicar(c.x, c.y, { botao: 'right' });
  await esperar(`!!menu()`, 1500);
  r = await av(`({ acoes: acoes(), tit: menu() && menu().querySelector('.menu-tit').textContent, sel: T('esc-suporte').classList.contains('esc-cv-sel'), cardOculto: !cardVis() })`);
  conferir(JSON.stringify(r.acoes) === '["entrar","renomear","editar","duplicar","excluir"]' && r.tit === 'Suporte' && r.sel && r.cardOculto, 'clique direito no ladrilho abre o mesmo menu, seleciona o ladrilho e esconde o card', r);
  await esc();
  // tecla de menu de contexto no ladrilho focado
  await av(`T('esc-docs').focus(); true`);
  await tecla('ContextMenu', 'ContextMenu', 93);
  r = await av(`({ acoes: acoes(), tit: menu() && menu().querySelector('.menu-tit').textContent })`);
  conferir(r.tit === 'Documentação' && r.acoes?.length === 5, 'a tecla de menu de contexto abre o menu do ladrilho focado', r);
  await esc();
  // Sessões: só "Entrar"
  c = await av(`centro(T('sessoes').querySelector('.esc-cv-mais'))`);
  await clicar(c.x, c.y);
  await esperar(`!!menu()`);
  r = await av(`({ acoes: acoes(), rots: [...menu().querySelectorAll('.mi-rot')].map((e) => e.textContent) })`);
  conferir(JSON.stringify(r.acoes) === '["entrar"]' && !r.rots.includes('Renomear') && !r.rots.includes('Excluir'), 'Sessões: o menu só tem Entrar (sem Renomear nem Excluir)', r);
  await av(`__chamadas.length = 0; true`);
  await enter();
  r = await av(`cham('onEntrar').map((x) => x.arg)`);
  conferir(JSON.stringify(r) === '["sessoes"]', 'Sessões: Entrar chama onEntrar("sessoes")', r);
  c = await av(`centro(T('sessoes'))`);
  await clicar(c.x, c.y, { botao: 'right' });
  await esperar(`!!menu()`, 1500);
  conferir(JSON.stringify(await av(`acoes()`)) === '["entrar"]', 'Sessões: o clique direito abre o menu só com Entrar', await av(`acoes()`));
  await esc();
  await av(`T('sessoes').focus(); true`);
  await tecla('F2', 'F2', 113);
  conferir(await av(`!document.querySelector('.esc-cv-nome-in')`), 'F2 em Sessões não abre renomear', null);

  // ── 9. Criar ──
  await abrir('', 4);
  const bn = await av(`centro(btn('Novo escritório', document.querySelector('.esc-cv-barra')))`);
  await clicar(bn.x, bn.y);
  r = await av(`(() => { const cam = EscritoriosCanvas.camera(), v = vistaR(); const mx = v.width / 2 / cam.zoom + cam.x - 120, my = v.height / 2 / cam.zoom + cam.y - 100;
    return { c: cham('onCriar'), ex: Math.round(mx / 20) * 20, ey: Math.round(my / 20) * 20 }; })()`);
  const vagaOk = async (a) => await av(`!colideCom(${a.x}, ${a.y}) && !(${a.x} === 0 && ${a.y} === 0) && ${a.x} % 20 === 0 && ${a.y} % 20 === 0`);
  conferir(r.c.length === 1 && await vagaOk(r.c[0].arg) && Math.hypot(r.c[0].arg.x - r.ex, r.c[0].arg.y - r.ey) < 600, 'botão "Novo escritório" chama onCriar({x,y}) na vaga livre mais perto do centro da vista (grade de 20, sem colidir, nunca {0,0})', r);
  vz = await av(`vazioPt()`);
  await av(`__chamadas.length = 0; true`);
  await clicar(vz.x, vz.y, { n: 2 });
  r = await av(`(() => { const cam = EscritoriosCanvas.camera(), v = vistaR(); const mx = (${vz.x} - v.left) / cam.zoom + cam.x, my = (${vz.y} - v.top) / cam.zoom + cam.y;
    return { c: cham('onCriar'), e: cham('onEntrar').length, ex: Math.round(mx / 20) * 20, ey: Math.round(my / 20) * 20 }; })()`);
  conferir(r.c.length === 1 && r.e === 0 && await vagaOk(r.c[0].arg) && Math.hypot(r.c[0].arg.x - r.ex, r.c[0].arg.y - r.ey) < 600, 'duplo clique no vazio chama onCriar({x,y}) encaixado, sem colidir e perto do ponto', r);
  // ponto vazio livre: a vaga é exatamente o ponto encaixado; ponto sobre a Sessões salva em (400,400), mundo (0,0): nunca {0,0}
  await av(`EscritoriosCanvas.desmontar(); localStorage.setItem('orbit.escritorios.canvas.sessoes', JSON.stringify({ x: 400, y: 400 })); localStorage.setItem('orbit.escritorios.canvas.cam', JSON.stringify({ x: -300, y: -200, zoom: 1 })); __remontar(); true`);
  await esperar(`pronto(4)`);
  await estavel();
  await av(`__chamadas.length = 0; true`);
  const v9 = await av(`(() => { const v = vistaR(); return { x: v.left + 300, y: v.top + 200 }; })()`);
  conferir(await av(`(() => { const e = document.elementFromPoint(${v9.x}, ${v9.y}); return !!e && !e.closest('.esc-cv-ladrilho, .esc-cv-barra, .esc-cv-card'); })()`), 'Sessões em (400,400) e câmera deslocada: o mundo (0,0) está num ponto vazio da tela', v9);
  await clicar(v9.x, v9.y, { n: 2 });
  r = await av(`({ c: cham('onCriar'), cam: EscritoriosCanvas.camera(), sess: T('sessoes').dataset.x + ',' + T('sessoes').dataset.y })`);
  conferir(r.sess === '400,400' && r.c.length === 1 && !(r.c[0].arg.x === 0 && r.c[0].arg.y === 0) && await vagaOk(r.c[0].arg), 'duplo clique no mundo (0,0): onCriar nunca recebe {0,0} (vaga livre mais perto)', r);

  // ── 10. Zoom, pan, câmera salva, Ajustar ──
  const cam0 = await av(`EscritoriosCanvas.camera()`);
  const zr = () => av(`({ z: EscritoriosCanvas.camera().zoom, rot: document.querySelector('.esc-cv-zoom').textContent, mais: btn('Aproximar').disabled, menos: btn('Afastar').disabled })`);
  const bm = await av(`centro(btn('Aproximar'))`), bl = await av(`centro(btn('Afastar'))`);
  await clicar(bm.x, bm.y); await estavel();
  r = await zr();
  conferir(perto(r.z, Math.min(2, cam0.zoom * 1.25), 0.01) && r.rot === Math.round(r.z * 100) + '%', 'Aproximar amplia 25% e o rótulo mostra a porcentagem', { cam0, r });
  await clicar(bl.x, bl.y); await clicar(bl.x, bl.y); await estavel();
  r = await zr();
  conferir(r.z < cam0.zoom, 'Afastar reduz o zoom', { cam0, r });
  for (let i = 0; i < 14; i++) { await clicar(bm.x, bm.y); await dormir(30); }
  await estavel(); r = await zr();
  conferir(r.z === 2 && r.mais && !r.menos && r.rot === '200%', 'Aproximar vai até 200% e o botão desabilita', r);
  for (let i = 0; i < 20; i++) { await clicar(bl.x, bl.y); await dormir(30); }
  await estavel(); r = await zr();
  conferir(r.z === 0.25 && r.menos && !r.mais && r.rot === '25%', 'Afastar vai até 25% e o botão desabilita', r);
  await clicar((await av(`centro(btn('Ajustar a vista a todos os ladrilhos'))`)).x, (await av(`centro(btn('Ajustar a vista a todos os ladrilhos'))`)).y);
  await estavel();
  r = await av(`(() => { const v = vistaR(); return { z: EscritoriosCanvas.camera().zoom, dentro: ladrilhos().every((e) => { const b = e.getBoundingClientRect(); return b.left >= v.left - 1 && b.right <= v.right + 1 && b.top >= v.top - 1 && b.bottom <= v.bottom + 1; }) }; })()`);
  conferir(r.z > 0.25 && r.z <= 1 && r.dentro, '"Ajustar" enquadra todos os ladrilhos na vista (zoom ≤ 100%)', r);
  // ctrl + roda: zoom ancorado no ponteiro
  const pz = { x: 640, y: 420 };
  const m0 = await av(`(() => { const c = EscritoriosCanvas.camera(), v = vistaR(); return { wx: (${pz.x} - v.left) / c.zoom + c.x, wy: (${pz.y} - v.top) / c.zoom + c.y, z: c.zoom }; })()`);
  await roda(pz.x, pz.y, 0, -100, 2);
  const m1 = await av(`(() => { const c = EscritoriosCanvas.camera(), v = vistaR(); return { wx: (${pz.x} - v.left) / c.zoom + c.x, wy: (${pz.y} - v.top) / c.zoom + c.y, z: c.zoom }; })()`);
  conferir(m1.z > m0.z && perto(m1.wx, m0.wx, 0.5) && perto(m1.wy, m0.wy, 0.5), 'ctrl + roda para cima amplia mantendo o ponto sob o ponteiro parado', { m0, m1 });
  await roda(pz.x, pz.y, 0, 100, 2);
  conferir((await av(`EscritoriosCanvas.camera().zoom`)) < m1.z, 'ctrl + roda para baixo afasta', null);
  for (let i = 0; i < 40; i++) await roda(pz.x, pz.y, 0, 100, 2);
  const zmin = await av(`EscritoriosCanvas.camera().zoom`);
  for (let i = 0; i < 60; i++) await roda(pz.x, pz.y, 0, -100, 2);
  const zmax = await av(`EscritoriosCanvas.camera().zoom`);
  conferir(zmin === 0.25 && zmax === 2, 'ctrl + roda respeita os limites 25%–200%', { zmin, zmax });
  // pan por roda (sem ctrl)
  await av(`btn('Ajustar a vista a todos os ladrilhos').click(); true`); await estavel();
  const p0 = await av(`EscritoriosCanvas.camera()`);
  await roda(pz.x, pz.y, 40, 100);
  const p1 = await av(`EscritoriosCanvas.camera()`);
  conferir(perto(p1.x, p0.x + 40 / p0.zoom, 0.01) && perto(p1.y, p0.y + 100 / p0.zoom, 0.01) && p1.zoom === p0.zoom, 'roda sem ctrl desloca a vista (sem mudar o zoom)', { p0, p1 });
  // pan por arrasto do fundo
  vz = await av(`vazioPt()`);
  await arrastar(vz.x, vz.y, vz.x + 100, vz.y + 50, 5);
  const p2 = await av(`EscritoriosCanvas.camera()`);
  conferir(perto(p2.x, p1.x - 100 / p1.zoom, 0.05) && perto(p2.y, p1.y - 50 / p1.zoom, 0.05) && p2.zoom === p1.zoom, 'arrastar o fundo desloca a vista com o mesmo movimento do ponteiro', { p1, p2 });
  r = await av(`({ posts: posts().length, criar: cham('onCriar').length })`);
  conferir(r.posts === 0, 'mover o fundo não grava posição de ladrilho', r);
  // câmera salva e restaurada
  await dormir(500);
  const salvo = await av(`JSON.parse(localStorage.getItem('orbit.escritorios.canvas.cam'))`);
  conferir(salvo && perto(salvo.x, p2.x, 1e-6) && perto(salvo.y, p2.y, 1e-6) && perto(salvo.zoom, p2.zoom, 1e-6), 'a câmera é salva no localStorage (orbit.escritorios.canvas.cam)', { salvo, p2 });
  await av(`__remontar(); true`);
  await esperar(`pronto(4)`);
  const rest = await av(`EscritoriosCanvas.camera()`);
  conferir(perto(rest.x, p2.x, 1e-6) && perto(rest.y, p2.y, 1e-6) && perto(rest.zoom, p2.zoom, 1e-6), 'ao remontar a câmera salva é restaurada (sem reajustar)', { rest, p2 });
  conferir(await av(`document.querySelectorAll('.esc-cv').length === 1`), 'remontar não duplica a interface', null);

  // ── 11. atualizar(ev) ──
  await abrir('', 4);
  const posDocs = await av(`({ x: T('esc-docs').dataset.x, y: T('esc-docs').dataset.y })`);
  await av(`__emitir({ id: 'esc-docs', resumo: { id: 'esc-docs', nome: 'Documentação', funcao: '', membros: 1, status: 'rodando', ativos: 1, convidados: 0,
    agentes: [{ id: 'orquestrador', nome: 'Orquestrador', papel: 'líder', estado: 'trabalhando' }, { id: 'escritor', nome: 'Noa', papel: 'escrita', estado: 'erro' }],
    custo: { execucaoUsd: 0.1, diaUsd: 0.1, limiteExecucaoUsd: 0.3, limiteDiaUsd: 1, planoPct: 3 } } }); true`);
  r = await av(`({ st: T('esc-docs').dataset.status, pil: T('esc-docs').querySelector('.esc-cv-pilula').textContent, ps: T('esc-docs').querySelector('.esc-cv-pilula').dataset.status,
    pontos: [...T('esc-docs').querySelectorAll('.esc-cv-ponto')].map((p) => p.dataset.estado), x: T('esc-docs').dataset.x, y: T('esc-docs').dataset.y, n: ladrilhos().length })`);
  conferir(r.st === 'rodando' && r.pil === 'Rodando' && r.ps === 'rodando' && JSON.stringify(r.pontos) === '["trabalhando","erro"]' && r.x === posDocs.x && r.y === posDocs.y && r.n === 4,
    'atualizar(ev) muda status, pílula e pontos do ladrilho, mantém a posição e não duplica', r);
  c = await av(`centro(T('esc-docs'))`);
  await mover(c.x, c.y);
  await esperar(`/Documentação/.test(card().textContent)`);
  await av(`__emitir({ id: 'esc-docs', resumo: { id: 'esc-docs', nome: 'Docs novas', membros: 1, status: 'pausada', motivoPausa: 'manual', ativos: 0, convidados: 0, agentes: [], custo: { planoPct: 50 } } }); true`);
  r = await av(`({ nome: T('esc-docs').querySelector('.esc-cv-nome').textContent, card: card().textContent, vis: cardVis() })`);
  conferir(r.nome === 'Docs novas' && r.vis && /Docs novas/.test(r.card) && /Pausada · manual/.test(r.card) && /50%/.test(r.card), 'com o card aberto, atualizar(ev) atualiza o nome e o card em tempo real', r);
  // Codex: custo.estimado põe "≈" nos valores em US$ do card (com title); o ponto do agente Codex diz "Codex" no title
  await av(`__emitir({ id: 'esc-docs', resumo: { id: 'esc-docs', nome: 'Docs novas', membros: 2, status: 'rodando', ativos: 1, convidados: 0,
    agentes: [{ id: 'orquestrador', nome: 'Orquestrador', papel: 'líder', estado: 'trabalhando', provedor: 'claude' }, { id: 'pesq', nome: 'Pesquisador', papel: 'pesquisa', estado: 'ocioso', provedor: 'codex' }],
    custo: { execucaoUsd: 0.25, diaUsd: 0.4, limiteExecucaoUsd: 0.3, limiteDiaUsd: 1, planoPct: 3, estimado: true } } }); true`);
  r = await av(`({ txt: card().textContent, tits: [...card().querySelectorAll('dd')].map((d) => d.title), pontos: [...T('esc-docs').querySelectorAll('.esc-cv-ponto')].map((p) => p.title) })`);
  conferir(/≈ US\$ 0,25 de US\$ 0,30/.test(r.txt) && /≈ US\$ 0,40 de US\$ 1,00/.test(r.txt) && !/≈ US\$ 0,30|≈ US\$ 1,00/.test(r.txt.replace(/≈ US\$ 0,(25|40) de US\$ (0,30|1,00)/g, '')) && r.tits.filter((t) => /estimativa do Codex pelos tokens/i.test(t)).length === 2,
    'custo.estimado: o card mostra "≈" nos valores gastos (execução e dia, não nos limites) e o title explica a estimativa do Codex', r);
  conferir(r.pontos.length === 2 && /· Codex$/.test(r.pontos[1]) && !/Codex/.test(r.pontos[0]), 'o title do ponto do agente Codex diz "Codex"; o do Claude não', r.pontos);
  await av(`__emitir({ id: 'esc-docs', resumo: { id: 'esc-docs', nome: 'Docs novas', membros: 1, status: 'rodando', ativos: 1, convidados: 0,
    agentes: [{ id: 'orquestrador', nome: 'Orquestrador', papel: 'líder', estado: 'trabalhando' }], custo: { execucaoUsd: 0.25, diaUsd: 0.4, limiteExecucaoUsd: 0.3, limiteDiaUsd: 1, planoPct: 3 } } }); true`);
  r = await av(`({ txt: card().textContent, tits: [...card().querySelectorAll('dd')].map((d) => d.title).filter(Boolean), ponto: T('esc-docs').querySelector('.esc-cv-ponto').title })`);
  conferir(/US\$ 0,25 de US\$ 0,30/.test(r.txt) && !/≈/.test(r.txt) && r.tits.length === 0 && !/Codex/.test(r.ponto), 'sem estimado: o card não tem "≈" nem title de estimativa', r);
  await av(`__emitir({ id: 'esc-novo', resumo: { id: 'esc-novo', nome: 'Novo de SSE', membros: 0, status: 'ociosa', ativos: 0, convidados: 0, canvas: { x: 900, y: 120 }, agentes: [], custo: {} } }); true`);
  r = await av(`({ n: ladrilhos().length, x: T('esc-novo')?.dataset.x, y: T('esc-novo')?.dataset.y, qtd: document.querySelector('.esc-cv').dataset.qtd, sobrepoe: sobrepoe() })`);
  conferir(r.n === 5 && r.x === '900' && r.y === '120' && r.qtd === '4' && r.sobrepoe.length === 0, 'atualizar(ev) com id novo cria o ladrilho na posição enviada', r);
  await av(`__emitir({ id: 'esc-suporte', resumo: null }); true`);
  r = await av(`({ n: ladrilhos().length, tem: !!T('esc-suporte'), qtd: document.querySelector('.esc-cv').dataset.qtd, cardVis: cardVis() })`);
  conferir(r.n === 4 && !r.tem && r.qtd === '3', 'atualizar({id, resumo:null}) remove o ladrilho', r);
  await av(`__emitir({ id: 'esc-docs', resumo: null }); true`);
  r = await av(`({ tem: !!T('esc-docs'), cardVis: cardVis() })`);
  conferir(!r.tem && !r.cardVis, 'remover o ladrilho com o card aberto esconde o card', r);
  await av(`__emitir(null); __emitir({}); __emitir({ id: 5 }); __emitir({ id: 'x', resumo: 3 }); true`);
  conferir(await av(`ladrilhos().length === 3 && !T('x')`), 'eventos inválidos são ignorados sem erro', null);

  // ── 12. Lista vazia, erro de carga ──
  await abrir('?vazio=1', 1);
  r = await av(`({ vis: !document.querySelector('.esc-cv-vazio').hidden, tit: document.querySelector('.esc-cv-vazio-tit').textContent, tentar: !document.querySelector('.esc-cv-vazio button:last-child').hidden,
    qtd: document.querySelector('.esc-cv').dataset.qtd, ids: ladrilhos().map((e) => e.dataset.id), btn: !!btn('Novo escritório', document.querySelector('.esc-cv-vazio')) })`);
  conferir(r.vis && /Nenhum escritório/.test(r.tit) && !r.tentar && r.qtd === '0' && JSON.stringify(r.ids) === '["sessoes"]' && r.btn, 'lista vazia: mensagem "Nenhum escritório ainda", só Sessões e o botão Novo escritório', r);
  c = await av(`centro(btn('Novo escritório', document.querySelector('.esc-cv-vazio')))`);
  await clicar(c.x, c.y);
  r = await av(`cham('onCriar')`);
  conferir(r.length === 1 && r[0].arg.x % 20 === 0 && r[0].arg.y % 20 === 0, 'o botão da mensagem vazia chama onCriar({x,y}) encaixado', r);
  await av(`__emitir({ id: 'esc-a', resumo: { id: 'esc-a', nome: 'Primeiro', membros: 0, status: 'ociosa', ativos: 0, convidados: 0, agentes: [], custo: {} } }); true`);
  r = await av(`({ oculto: document.querySelector('.esc-cv-vazio').hidden, n: ladrilhos().length })`);
  conferir(r.oculto && r.n === 2, 'ao chegar o primeiro escritório a mensagem some', r);
  await abrir('', 4);
  await av(`window.__f0 = window.fetch; window.fetch = async (u, i) => (i && i.method) ? __f0(u, i) : new Response('{}', { status: 500 }); __remontar(); true`);
  await esperar(`!document.querySelector('.esc-cv-vazio').hidden`);
  r = await av(`({ tit: document.querySelector('.esc-cv-vazio-tit').textContent, tentar: !document.querySelector('.esc-cv-vazio button:last-child').hidden })`);
  conferir(/Não foi possível carregar/.test(r.tit) && r.tentar, 'falha ao carregar: mensagem de erro e botão "Tentar de novo"', r);
  await av(`window.fetch = window.__f0; true`);
  c = await av(`centro(btn('Tentar de novo'))`);
  await clicar(c.x, c.y);
  await esperar(`ladrilhos().length === 4`);
  conferir(await av(`document.querySelector('.esc-cv-vazio').hidden && ladrilhos().length === 4`), '"Tentar de novo" recarrega a lista e a mensagem some', null);

  // ── 13. Miniatura que falha / lenta ──
  await abrir('?semmini=1', 4);
  r = await av(`({ mini: document.querySelector('.esc-cv').dataset.mini, n: ladrilhos().length, pix: (() => { const g = T('esc-vendas').querySelector('canvas').getContext('2d'); return g.getImageData(100, 70, 1, 1).data[3]; })(),
    miniChamadas: cham('miniatura').length, bg: getComputedStyle(T('esc-vendas').querySelector('canvas')).backgroundColor })`);
  conferir(r.mini === 'liso' && r.n === 4 && r.pix === 0 && r.bg !== 'rgba(0, 0, 0, 0)', 'miniatura que falha: ladrilhos montam com fundo liso (data-mini=liso), sem desenho', r);
  await abrir('?lento=1', 4);
  await av(`__remontar(); true`);
  await esperar(`ladrilhos().length === 4`);
  conferir(await av(`document.querySelector('.esc-cv').dataset.mini === 'carregando'`), 'enquanto a miniatura demora, data-mini=carregando e os ladrilhos já aparecem', await av(`document.querySelector('.esc-cv').dataset.mini`));
  await esperar(`document.querySelector('.esc-cv').dataset.mini === 'simples'`, 3000);
  r = await av(`({ mini: document.querySelector('.esc-cv').dataset.mini, pix: T('esc-docs').querySelector('canvas').getContext('2d').getImageData(100, 70, 1, 1).data[3] })`);
  conferir(r.mini === 'simples' && r.pix === 255, 'a miniatura que chega depois é desenhada em todos os ladrilhos', r);

  // ── 14. Desmontar: sem listeners nem timers, nada é chamado depois ──
  await abrir('', 4);
  r = await av(`({ ouv: __ouvintes().length, janela: __ouvintes().filter((x) => x.startsWith('window') || x.startsWith('document')).length })`);
  conferir(r.ouv > 10 && r.janela >= 2, 'sanidade do espião: com o canvas montado há listeners (na vista, na barra e na janela)', r);
  // câmera pendente de salvar + animação em curso
  await av(`document.querySelector('.esc-cv-vista').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, clientX: 600, clientY: 400 })); true`);
  const antesTm = await av(`__pendentes()`);
  await av(`btn('Ajustar a vista a todos os ladrilhos').click(); true`);
  const camAntes = await av(`EscritoriosCanvas.camera()`);
  await av(`EscritoriosCanvas.desmontar(); true`);
  const depTm = await av(`__pendentes()`);
  const gravada = await av(`JSON.parse(localStorage.getItem('orbit.escritorios.canvas.cam'))`);
  conferir(antesTm.timers >= 1 && depTm.timers === 0 && depTm.raf === 0, 'desmontar limpa o timer de salvar a câmera e a animação (rAF) pendentes', { antesTm, depTm });
  conferir(gravada && perto(gravada.x, camAntes.x, 1e-6) && perto(gravada.zoom, camAntes.zoom, 1e-6), 'desmontar grava a câmera pendente antes de sair', { gravada, camAntes });
  // desmonta com menu aberto e aviso ativo
  await av(`__remontar(); true`);
  await esperar(`pronto(4)`);
  c = await av(`centro(T('esc-suporte').querySelector('.esc-cv-nome'))`);
  await clicar(c.x, c.y, { n: 2 });
  await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
  await tecla('Backspace', 'Backspace', 8); await enter(); await esc();
  c = await av(`centro(T('esc-vendas').querySelector('.esc-cv-mais'))`);
  await clicar(c.x, c.y);
  await esperar(`!!menu()`);
  const pre = await av(`({ menu: !!menu(), aviso: !document.querySelector('.esc-cv-aviso').hidden, pend: __pendentes(), ouv: __ouvintes().length, corpo: document.body.children.length })`);
  conferir(pre.menu && pre.aviso && pre.pend.timers >= 1, 'pré-condição: menu aberto, aviso visível e timer do aviso pendente', pre);
  const nChamadas = await av(`__chamadas.length`);
  await av(`EscritoriosCanvas.desmontar(); true`);
  r = await av(`({ raiz: !!document.querySelector('.esc-cv'), menu: !!menu(), flut: document.querySelectorAll('.menu-flut').length, filhos: document.getElementById('raiz').children.length,
    ouv: __ouvintes(), pend: __pendentes(), camera: EscritoriosCanvas.camera(), mundo: !!document.querySelector('.esc-cv-mundo, .esc-cv-ladrilho, .esc-cv-card, .esc-cv-aviso') })`);
  conferir(!r.raiz && !r.menu && r.flut === 0 && r.filhos === 0 && !r.mundo && r.camera === null, 'desmontar remove a interface, o menu flutuante e zera camera()', r);
  conferir(r.ouv.length === 0, 'desmontar não deixa listeners (window, document, nós) vivos', r.ouv);
  conferir(r.pend.timers === 0 && r.pend.raf === 0, 'desmontar não deixa timers nem rAF pendentes (inclui o timer do aviso)', r.pend);
  // eventos depois de desmontar não chamam nada nem criam nada
  const camSalva = await av(`localStorage.getItem('orbit.escritorios.canvas.cam')`);
  await av(`for (const t of ['pointerup', 'pointercancel', 'wheel', 'resize', 'blur', 'keydown', 'pointerdown', 'dblclick', 'contextmenu']) { window.dispatchEvent(new Event(t)); document.dispatchEvent(new Event(t, { bubbles: true })); }
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse' })); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    __emitir({ id: 'esc-vendas', resumo: null }); __emitir({ id: 'esc-z', resumo: { id: 'esc-z', nome: 'Z' } }); EscritoriosCanvas.recarregar(); EscritoriosCanvas.desmontar(); true`);
  await mover(300, 300); await clicar(300, 300, { n: 2 }); await roda(300, 300, 0, 100, 2); await tecla('Escape', 'Escape', 27);
  await dormir(500);
  r = await av(`({ cham: __chamadas.length, raiz: !!document.querySelector('.esc-cv'), pend: __pendentes(), cam: localStorage.getItem('orbit.escritorios.canvas.cam'), filhos: document.getElementById('raiz').children.length })`);
  conferir(r.cham === nChamadas && !r.raiz && r.filhos === 0 && r.pend.timers === 0 && r.pend.raf === 0 && r.cam === camSalva, 'depois de desmontar, eventos, cliques e atualizar() não chamam callbacks, fetch nem timers e não recriam nada', { r, nChamadas });
  await av(`__remontar(); true`);
  await esperar(`pronto(4)`);
  conferir(await av(`document.querySelectorAll('.esc-cv').length === 1 && ladrilhos().length === 4`), 'é possível montar de novo depois de desmontar', null);

  // ── 16. Posição estável: sem posição vai à vaga calculada e é GRAVADA uma vez; nunca reembaralha ──
  await abrir('?n=6', 7, true);
  await esperar(`posts().length === 6`, 5000);
  await dormir(400);
  r = await av(`({ p: posts(), pos: posDe(), col: colisoes(), grade: nasGrade(), banco: __banco.map((b) => b.id + ':' + b.canvas.x + ',' + b.canvas.y).sort() })`);
  const origem6 = Object.entries(r.pos).filter(([id, p]) => id !== 'sessoes' && p === '0,0');
  conferir(r.p.length === 6 && new Set(r.p.map((x) => x.url)).size === 6 && r.p.every((x) => x.metodo === 'POST' && Object.keys(x.corpo).join() === 'canvas' && x.cabecalho === '1'), 'escritórios sem posição: 1 POST {canvas} por escritório, uma só vez (6 posts, 6 ids)', r.p.map((x) => x.url));
  conferir(r.col.length === 0 && r.grade && origem6.length === 0 && r.p.every((x) => r.pos[x.url.split('/').pop()] === x.corpo.canvas.x + ',' + x.corpo.canvas.y) && r.banco.every((b, i) => b === r.p.map((x) => x.url.split('/').pop() + ':' + x.corpo.canvas.x + ',' + x.corpo.canvas.y).sort()[i]),
    'sem posição: cada um vai a uma vaga livre da grade (nunca {0,0}, sem colidir) e o POST leva exatamente a posição mostrada', r);
  const ord6 = Object.keys(r.pos).filter((k) => k !== 'sessoes').sort().map((k) => { const [x, y] = r.pos[k].split(',').map(Number); return Math.hypot((x * 200) / 260, y); });
  conferir(ord6.every((d, i) => i === 0 || d >= ord6[i - 1] - 1e-6), 'sem posição e sem criado: a ordem de chegada (id) decide a vaga — em espiral a partir do centro', ord6);
  const pos6 = r.pos;
  await av(`__chamadas.length = 0; __banco.reverse(); EscritoriosCanvas.recarregar(); true`);
  await dormir(300);
  r = await av(`({ pos: posDe(), p: posts().length })`);
  conferir(JSON.stringify(r.pos) === JSON.stringify(pos6) && r.p === 0, 'recarregar com a lista em outra ordem não muda nenhuma posição e não repete POST', r);
  await av(`__remontar(); true`);
  await esperar(`pronto(7)`);
  await dormir(300);
  r = await av(`({ pos: posDe(), p: posts().length })`);
  conferir(JSON.stringify(r.pos) === JSON.stringify(pos6) && r.p === 0, 'remontar (outra ordem, posições já gravadas) mantém tudo no lugar e sem POST', r);

  // duplicado: a cópia (mesmo canvas, chega depois) vai à vaga livre mais próxima do original; o original não sai do lugar
  await av(`__chamadas.length = 0;
    const orig = __banco.find((b) => b.id === 'esc-003');
    const dup = JSON.parse(JSON.stringify(orig)); dup.id = 'esc-dup'; dup.nome = 'Cópia de 003'; dup.criado = new Date().toISOString();
    __banco.push(dup); __emitir({ id: 'esc-dup', resumo: JSON.parse(JSON.stringify(dup)) }); true`);
  await esperar(`posts().length === 1`);
  await dormir(200);
  r = await av(`(() => { const o = T('esc-003'), d = T('esc-dup'); return { o: o.dataset.x + ',' + o.dataset.y, d: d.dataset.x + ',' + d.dataset.y, dx: Math.abs(o.dataset.x - d.dataset.x), dy: Math.abs(o.dataset.y - d.dataset.y), col: colisoes(), p: posts(), pos: posDe() }; })()`);
  conferir(r.o === pos6['esc-003'] && r.d !== r.o && r.col.length === 0 && r.dx <= 520 && r.dy <= 440, 'duplicar: a cópia vai a uma vaga livre perto do original e o original não sai do lugar', r);
  conferir(r.p.length === 1 && r.p[0].url === '/escritorios/esc-dup' && r.p[0].corpo.canvas.x + ',' + r.p[0].corpo.canvas.y === r.d, 'a vaga da cópia é gravada (1 POST com a posição mostrada)', r.p);
  await av(`const b = __banco.find((x) => x.id === 'esc-dup'); __emitir({ id: 'esc-dup', resumo: { ...JSON.parse(JSON.stringify(b)), canvas: { ...__banco.find((x) => x.id === 'esc-003').canvas } } }); __emitir({ id: 'esc-003', resumo: JSON.parse(JSON.stringify(__banco.find((x) => x.id === 'esc-003'))) }); true`);
  await dormir(300);
  r = await av(`({ pos: posDe(), p: posts().length })`);
  conferir(r.p === 1 && r.pos['esc-003'] === pos6['esc-003'] && r.pos['esc-dup'] !== r.pos['esc-003'], 'SSE antigo da cópia (canvas igual ao do original) não a joga de volta nem repete o POST', r);

  // desempate por criado quando o resumo trouxer: o mais antigo fica, o novo cede, mesmo com o id "maior"
  await abrir('?n=3&criado=1', 4);
  await esperar(`posts().length === 3`);
  await av(`__banco.find((b) => b.id === 'esc-001').canvas = { x: 2000, y: 2000 }; __banco.find((b) => b.id === 'esc-003').canvas = { x: 2000, y: 2000 };
    __banco.find((b) => b.id === 'esc-003').criado = '2020-01-01T00:00:00.000Z'; __chamadas.length = 0; __remontar(); true`);
  await esperar(`pronto(4)`);
  await dormir(300);
  r = await av(`({ pos: posDe(), p: posts() })`);
  conferir(r.pos['esc-003'] === '2000,2000' && r.pos['esc-001'] !== '2000,2000' && r.p.length === 1 && r.p[0].url === '/escritorios/esc-001', 'canvas igual: o de criado mais antigo fica e o outro é gravado na vaga livre (criado vence o id)', r);

  // ── 17. Corridas: arrastes seguidos e renomear com SSE no meio ──
  await abrir('?atraso=500', 4);
  const z17 = (await av(`EscritoriosCanvas.camera()`)).zoom;
  c = await av(`centro(T('esc-docs'))`);
  await arrastar(c.x, c.y, c.x + 507 * z17, c.y + 13 * z17);
  c = await av(`centro(T('esc-docs'))`);
  await arrastar(c.x, c.y, c.x + 0, c.y + 300 * z17);
  const fim17 = await av(`T('esc-docs').dataset.x + ',' + T('esc-docs').dataset.y`);
  await av(`__emitir({ id: 'esc-docs', resumo: { ...JSON.parse(JSON.stringify(__banco.find((b) => b.id === 'esc-docs'))), canvas: { x: 200, y: 420 }, status: 'rodando' } }); true`);
  r = await av(`({ pos: T('esc-docs').dataset.x + ',' + T('esc-docs').dataset.y, st: T('esc-docs').dataset.status })`);
  conferir(r.pos === fim17 && r.st === 'rodando', 'SSE com o POST ainda pendente não desfaz o arraste (a posição arrastada vale; o resto do resumo entra)', { r, fim17 });
  await esperar(`posts().length === 2`);
  await dormir(1300);
  r = await av(`({ pos: T('esc-docs').dataset.x + ',' + T('esc-docs').dataset.y, banco: __banco.find((b) => b.id === 'esc-docs').canvas, p: posts().map((x) => x.corpo.canvas) })`);
  conferir(r.pos === fim17 && r.banco.x + ',' + r.banco.y === fim17 && r.p.length === 2 && r.p[1].x + ',' + r.p[1].y === fim17, 'dois arrastes seguidos do mesmo ladrilho: vale o último, mesmo com os dois POSTs em voo', r);
  // 1º arraste ok, 2º falha: volta à posição do 1º (a última confirmada), não à original
  await av(`__falhaPost = false; __chamadas.length = 0; true`);
  c = await av(`centro(T('esc-vendas'))`);
  await arrastar(c.x, c.y, c.x + 0, c.y + 380 * z17);
  const q1 = await av(`T('esc-vendas').dataset.x + ',' + T('esc-vendas').dataset.y`);
  await av(`__falhaPost = true; true`);
  c = await av(`centro(T('esc-vendas'))`);
  await arrastar(c.x, c.y, c.x + 700 * z17, c.y + 0);
  const q2 = await av(`T('esc-vendas').dataset.x + ',' + T('esc-vendas').dataset.y`);
  await esperar(`!document.querySelector('.esc-cv-aviso').hidden`, 4000);
  await dormir(300);
  r = await av(`({ pos: T('esc-vendas').dataset.x + ',' + T('esc-vendas').dataset.y, banco: __banco.find((b) => b.id === 'esc-vendas').canvas, aviso: document.querySelector('.esc-cv-aviso').textContent })`);
  conferir(q1 !== q2 && r.pos === q1 && r.banco.x + ',' + r.banco.y === q1 && /Não foi possível salvar a posição/.test(r.aviso), '1º arraste salva e o 2º falha: o ladrilho volta ao 1º destino (última posição confirmada)', { r, q1, q2 });

  await abrir('?atraso=500', 4);
  const renomear17 = async (nome) => {
    const cc = await av(`centro(T('esc-suporte').querySelector('.esc-cv-nome'))`);
    await clicar(cc.x, cc.y, { n: 2 });
    await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
    await cdp('Input.insertText', { text: nome });
    await enter();
  };
  await renomear17('Primeiro');
  await renomear17('Segundo');
  await av(`__emitir({ id: 'esc-suporte', resumo: { ...JSON.parse(JSON.stringify(__banco.find((b) => b.id === 'esc-suporte'))), nome: 'Suporte', ativos: 1 } }); true`);
  r = await av(`T('esc-suporte').querySelector('.esc-cv-nome').textContent`);
  conferir(r === 'Segundo', 'SSE com nome antigo durante o renomear pendente não desfaz o nome novo', r);
  await esperar(`posts().length === 2`);
  await dormir(1300);
  r = await av(`({ nome: T('esc-suporte').querySelector('.esc-cv-nome').textContent, banco: __banco.find((b) => b.id === 'esc-suporte').nome, p: posts().map((x) => x.corpo.nome) })`);
  conferir(r.nome === 'Segundo' && r.banco === 'Segundo' && JSON.stringify(r.p) === '["Primeiro","Segundo"]', 'dois renomeios seguidos: vale o último (2 POSTs, nome final igual no ladrilho e no banco)', r);
  await av(`__falhaPost = true; __chamadas.length = 0; true`);
  await renomear17('Terceiro');
  await esperar(`!document.querySelector('.esc-cv-aviso').hidden`, 4000);
  r = await av(`({ nome: T('esc-suporte').querySelector('.esc-cv-nome').textContent, aviso: document.querySelector('.esc-cv-aviso').textContent })`);
  conferir(r.nome === 'Segundo' && /Não foi possível renomear/.test(r.aviso), 'renomear com falha do servidor volta ao nome anterior e avisa', r);

  // ── 18. Card: "≈" por linha (execução e dia independentes) ──
  await abrir('', 4);
  c = await av(`centro(T('esc-docs'))`);
  await mover(c.x, c.y);
  await esperar(`/Documentação/.test(card().textContent)`);
  const cust = (extra) => `__emitir({ id: 'esc-docs', resumo: { id: 'esc-docs', nome: 'Documentação', membros: 1, status: 'rodando', ativos: 1, convidados: 0, agentes: [],
    custo: { execucaoUsd: 0.25, diaUsd: 0.4, limiteExecucaoUsd: 0.3, limiteDiaUsd: 1, planoPct: 3, ${extra} } } }); true`;
  const linhas18 = () => av(`Object.fromEntries([...card().querySelectorAll('dt')].map((d) => [d.textContent, { t: d.nextElementSibling.textContent, tit: d.nextElementSibling.title }]))`);
  await av(cust('estimadoExecucao: true, estimadoDia: false'));
  r = await linhas18();
  conferir(/^≈ US\$ 0,25 de US\$ 0,30/.test(r['Execução'].t) && /estimativa do Codex/i.test(r['Execução'].tit) && !/≈/.test(r['Dia'].t) && r['Dia'].tit === '', 'estimadoExecucao:true / estimadoDia:false: só a linha Execução tem "≈" e title', r);
  await av(cust('estimadoExecucao: false, estimadoDia: true'));
  r = await linhas18();
  conferir(!/≈/.test(r['Execução'].t) && r['Execução'].tit === '' && /^≈ US\$ 0,40 de US\$ 1,00/.test(r['Dia'].t) && /estimativa do Codex/i.test(r['Dia'].tit), 'estimadoExecucao:false / estimadoDia:true: só a linha Dia tem "≈"', r);
  await av(cust('estimado: true'));
  r = await linhas18();
  conferir(/≈/.test(r['Execução'].t) && /≈/.test(r['Dia'].t), 'reserva: só custo.estimado:true marca as duas linhas', r);
  await av(cust('estimado: true, estimadoExecucao: false'));
  r = await linhas18();
  conferir(!/≈/.test(r['Execução'].t) && /≈/.test(r['Dia'].t), 'a flag por linha tem prioridade sobre custo.estimado', r);
  await av(cust("estimado: true, semPreco: ['gpt-x']"));
  r = await linhas18();
  conferir(/gpt-x/.test(r['Execução'].tit) && /gpt-x/.test(r['Dia'].tit), 'semPreco aparece no title das linhas de custo', r);

  // ── 19. 100 escritórios: montagem, SSE incremental e posições gravadas uma vez ──
  await cdp('Page.navigate', { url: URL_PAG + '?n=100&adiar=1' });
  await esperar(`document.readyState === 'complete' && typeof window.__remontar === 'function'`, 8000);
  await av(lib);
  await av(`localStorage.clear(); true`);
  const t19 = await av(`(async () => { const t0 = performance.now(); __remontar(); while (ladrilhos().length < 101) await new Promise((r) => setTimeout(r, 5)); return Math.round(performance.now() - t0); })()`);
  console.log('  [100 escritórios] montagem até 101 ladrilhos: ' + t19 + ' ms');
  conferir(t19 < 4000, '100 escritórios: montagem em menos de 4 s (folgado)', t19);
  await dormir(600);
  r = await av(`({ p: posts().length, ids: new Set(posts().map((x) => x.url)).size, col: colisoes().length, grade: nasGrade(), pos: posDe() })`);
  conferir(r.p === 100 && r.ids === 100, '100 escritórios sem posição: 100 POSTs {canvas}, um por escritório, nenhum repetido', r);
  conferir(r.col === 0 && r.grade && Object.entries(r.pos).filter(([id, p]) => id !== 'sessoes' && p === '0,0').length === 0, '100 escritórios: nenhum colide, todos na grade e nenhum em {0,0}', r.col);
  const pos100 = r.pos;
  // SSE: igual ao que já está (nada muda no DOM) e diferente em um (só o ladrilho dele muda)
  r = await av(`(async () => {
    const mut = []; const mo = new MutationObserver((l) => mut.push(...l)); mo.observe(document.querySelector('.esc-cv-mundo'), { subtree: true, childList: true, attributes: true, characterData: true });
    const copia = (id) => JSON.parse(JSON.stringify(__banco.find((b) => b.id === id)));
    __emitir({ id: 'esc-050', resumo: copia('esc-050') }); await new Promise((r) => setTimeout(r, 30));
    const iguais = mut.splice(0).length;
    const novo = copia('esc-050'); novo.status = 'pausada'; novo.motivoPausa = 'manual';
    const t0 = performance.now(); __emitir({ id: 'esc-050', resumo: novo }); const dt = performance.now() - t0; await new Promise((r) => setTimeout(r, 30));
    const alvos = mut.splice(0).map((m) => m.target.nodeType === 1 ? m.target : m.target.parentElement);
    mo.disconnect();
    return { iguais, dt, fora: alvos.filter((e) => !e.closest('.esc-cv-ladrilho[data-id="esc-050"]')).length, dentro: alvos.length, st: T('esc-050').dataset.status };
  })()`);
  console.log('  [100 escritórios] um SSE: ' + r.dt.toFixed(1) + ' ms');
  conferir(r.iguais === 0, 'SSE com resumo idêntico: nenhuma mutação no DOM do mundo (nada repintado)', r);
  conferir(r.st === 'pausada' && r.dentro > 0 && r.fora === 0 && r.dt < 100, 'SSE que muda 1 escritório: só o ladrilho dele é tocado, em menos de 100 ms', r);
  r = await av(`(() => { const t0 = performance.now(); for (let i = 1; i <= 100; i++) { const id = 'esc-' + String(i).padStart(3, '0'); const n = JSON.parse(JSON.stringify(__banco.find((b) => b.id === id))); n.ativos = i % 3; __emitir({ id, resumo: n }); }
    return { total: Math.round(performance.now() - t0), pos: posDe() }; })()`);
  console.log('  [100 escritórios] 100 SSE seguidos: ' + r.total + ' ms');
  conferir(r.total < 2500 && JSON.stringify(r.pos) === JSON.stringify(pos100), '100 SSE seguidos (um por escritório) em menos de 2,5 s e sem mexer em nenhuma posição', r.total);
  await av(`__chamadas.length = 0; __banco.reverse(); EscritoriosCanvas.recarregar(); true`);
  await dormir(400);
  r = await av(`({ p: posts().length, pos: posDe() })`);
  conferir(r.p === 0 && JSON.stringify(r.pos) === JSON.stringify(pos100), '100 escritórios: recarregar a lista não grava nada nem muda posição', r.p);

  // ── 20. Alertas do servidor: faixa no topo, marca no ladrilho, aviso() e focar() ──
  await abrir('?tempoAlerta=2000', 4);
  const copiaBanco = (id, alt = {}) => av(`(() => { const n = JSON.parse(JSON.stringify(__banco.find((b) => b.id === ${JSON.stringify(id)}))); Object.assign(n, ${JSON.stringify(alt)}); return n; })()`);
  const emitir = (ev) => av(`__emitir(${JSON.stringify(ev)}); true`);
  const faixa = () => av(`(() => { const a = document.querySelector('.esc-cv-alerta'); if (!a) return null; const r = a.getBoundingClientRect(), rr = document.querySelector('.esc-cv').getBoundingClientRect();
    return { vis: !a.hidden, role: a.getAttribute('role'), live: a.getAttribute('aria-live'), tipo: a.dataset.tipo, txt: a.querySelector('.esc-cv-alerta-txt').textContent, dis: a.querySelector('.esc-cv-alerta-txt').disabled,
      topo: Math.round(r.top - rr.top), centro: Math.round(r.left + r.width / 2 - (rr.left + rr.width / 2)), larg: Math.round(r.width), fechar: !!btn('Fechar aviso', a) }; })()`);
  const marca = async (id) => {
    // a sombra tem transição (--dur-1): força o estilo e espera as animações do ladrilho acabarem antes de ler o valor final
    await av(`(() => { const t = T(${JSON.stringify(id)}); getComputedStyle(t).boxShadow; return true; })()`);
    await esperar(`T(${JSON.stringify(id)}).getAnimations().length === 0`, 1500);
    return marcaLer(id);
  };
  const marcaLer = (id) => av(`(() => { const t = T(${JSON.stringify(id)}), s = t.querySelector('.esc-cv-selo'); return { alerta: t.dataset.alerta || null, selo: s && !s.hidden ? s.textContent : null, sombra: getComputedStyle(t).boxShadow, seloBg: s ? getComputedStyle(s).backgroundColor : null, aria: t.getAttribute('aria-label') }; })()`);
  const corToken = (tk) => av(`(() => { const p = document.createElement('i'); p.style.color = 'var(${tk})'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
  const agu = await corToken('--agu'), erroC = await corToken('--erro');
  r = await faixa();
  conferir(r && !r.vis, 'faixa de alerta começa escondida', r);
  await emitir({ id: 'esc-vendas', resumo: await copiaBanco('esc-vendas'), alerta: { tipo: 'aviso', texto: 'Execução a 80% do orçamento' } });
  r = await faixa();
  conferir(r.vis && r.role === 'status' && r.live === 'polite' && r.tipo === 'aviso' && r.txt === 'Execução a 80% do orçamento' && !r.dis && r.fechar, 'ev.alerta aviso: faixa visível, role=status/aria-live=polite, texto clicável e botão "Fechar aviso"', r);
  conferir(r.topo >= 56 && r.topo <= 72 && Math.abs(r.centro) <= 2 && r.larg <= 640, 'a faixa fica no topo do canvas (abaixo da barra), centrada e com no máximo 640 px', r);
  r = await marca('esc-vendas');
  conferir(r.alerta === 'aviso' && r.selo === 'Aviso' && r.seloBg === agu && r.sombra.includes(agu) && /Aviso: Execução a 80%/.test(r.aria), 'ladrilho marcado como aviso: data-alerta, selo "Aviso" e anel na cor âmbar (--agu), texto no rótulo acessível', { r, agu });
  conferir((await marca('esc-docs')).alerta === null && (await marca('sessoes')).alerta === null, 'os outros ladrilhos não são marcados', null);
  // clicar no texto da faixa foca o ladrilho
  c = await av(`centro(document.querySelector('.esc-cv-alerta-txt'))`);
  await clicar(c.x, c.y);
  r = await av(`({ foco: document.activeElement.dataset && document.activeElement.dataset.id, sel: T('esc-vendas').classList.contains('esc-cv-sel'), card: cardVis() && /Vendas e propostas/.test(card().textContent), cam: EscritoriosCanvas.camera() })`);
  conferir(r.foco === 'esc-vendas' && r.sel && r.card, 'clicar na faixa foca e seleciona o ladrilho e mostra o card dele', r);
  // o aviso fecha sozinho (tempoAlertaMs=2000); o ladrilho segue marcado até o status mudar
  conferir(await esperar(`document.querySelector('.esc-cv-alerta').hidden`, 6000), 'o aviso fecha sozinho depois de tempoAlertaMs', await faixa());
  r = await marca('esc-vendas');
  conferir(r.alerta === 'aviso' && r.selo === 'Aviso', 'com a faixa fechada o ladrilho continua marcado (aviso)', r);
  await emitir({ id: 'esc-vendas', resumo: await copiaBanco('esc-vendas', { ativos: 1 }) });
  conferir((await marca('esc-vendas')).alerta === 'aviso', 'SSE sem mudança de status não limpa a marca', await marca('esc-vendas'));
  await emitir({ id: 'esc-vendas', resumo: await copiaBanco('esc-vendas', { status: 'concluida' }) });
  r = await marca('esc-vendas');
  conferir(r.alerta === null && r.selo === null && !/Aviso:/.test(r.aria), 'a marca sai quando o status do escritório muda', r);
  // pausa: vermelho, fica até fechar
  await emitir({ id: 'esc-docs', resumo: await copiaBanco('esc-docs', { status: 'pausada', motivoPausa: 'manual' }), alerta: { tipo: 'pausa', texto: 'Documentação pausada: orçamento do dia' } });
  r = await faixa();
  conferir(r.vis && r.role === 'alert' && r.live === 'assertive' && r.tipo === 'pausa', 'ev.alerta pausa: faixa com role=alert e aria-live=assertive', r);
  r = await marca('esc-docs');
  conferir(r.alerta === 'pausa' && r.selo === 'Pausa' && r.seloBg === erroC && r.sombra.includes(erroC), 'ladrilho marcado como pausa: selo "Pausa" e anel vermelho (--erro)', { r, erroC });
  await dormir(2600);
  conferir((await faixa()).vis, 'a faixa de pausa NÃO fecha sozinha (passou mais que tempoAlertaMs)', await faixa());
  await emitir({ id: 'esc-docs', resumo: await copiaBanco('esc-docs', { status: 'pausada', motivoPausa: 'manual', ativos: 0, convidados: 0 }) });
  conferir((await faixa()).vis && (await marca('esc-docs')).alerta === 'pausa', 'SSE que mantém a pausa não fecha a faixa nem a marca', null);
  c = await av(`centro(btn('Fechar aviso'))`);
  await clicar(c.x, c.y);
  conferir(!(await faixa()).vis && (await marca('esc-docs')).alerta === 'pausa', '"Fechar aviso" esconde a faixa; a marca da pausa segue até o status mudar', await faixa());
  await emitir({ id: 'esc-docs', alerta: { tipo: 'pausa', texto: 'Pausada de novo' } });
  conferir((await faixa()).vis && (await faixa()).txt === 'Pausada de novo', 'alerta sem resumo na mesma mensagem também aparece (tratado antes do check de resumo)', await faixa());
  await emitir({ id: 'esc-docs', resumo: await copiaBanco('esc-docs', { status: 'rodando' }) });
  r = await marca('esc-docs');
  conferir(!(await faixa()).vis && r.alerta === null, 'a faixa de pausa fecha e a marca sai quando o escritório deixa de estar pausado', { f: await faixa(), r });
  // API
  await av(`EscritoriosCanvas.aviso('Falha ao falar com o servidor', 'pausa'); true`);
  r = await faixa();
  conferir(r.vis && r.tipo === 'pausa' && r.role === 'alert' && r.dis && r.txt === 'Falha ao falar com o servidor', 'EscritoriosCanvas.aviso(texto, "pausa") mostra a faixa (sem ladrilho: texto não clicável)', r);
  await av(`EscritoriosCanvas.aviso('Só um aviso'); true`);
  r = await faixa();
  conferir(r.vis && r.tipo === 'aviso' && r.role === 'status' && r.txt === 'Só um aviso', 'EscritoriosCanvas.aviso(texto) usa o tipo "aviso" e substitui a faixa anterior', r);
  conferir(await esperar(`document.querySelector('.esc-cv-alerta').hidden`, 3000), 'aviso() de tipo aviso também fecha sozinho', await faixa());
  r = await av(`({ ok: EscritoriosCanvas.focar('esc-suporte'), foco: document.activeElement.dataset.id, sel: T('esc-suporte').classList.contains('esc-cv-sel'), card: cardVis() && /Suporte/.test(card().textContent), no: EscritoriosCanvas.focar('nao-existe') })`);
  conferir(r.ok === true && r.foco === 'esc-suporte' && r.sel && r.card && r.no === false, 'EscritoriosCanvas.focar(id) seleciona, foca e mostra o card; id inexistente devolve false', r);
  r = await av(`({ f: typeof EscritoriosCanvas.focar, a: typeof EscritoriosCanvas.aviso })`);
  conferir(r.f === 'function' && r.a === 'function', 'focar e aviso estão exportados', r);
  // desmontar com aviso pendente: sem timer
  await av(`EscritoriosCanvas.aviso('pendente'); true`);
  const pt = await av(`__pendentes().timers`);
  await av(`EscritoriosCanvas.desmontar(); EscritoriosCanvas.aviso('depois'); EscritoriosCanvas.focar('esc-vendas'); true`);
  r = await av(`({ pend: __pendentes(), raiz: !!document.querySelector('.esc-cv') })`);
  conferir(pt >= 1 && r.pend.timers === 0 && !r.raiz, 'desmontar limpa o timer da faixa; aviso()/focar() depois de desmontar não fazem nada', { pt, r });

  // ── 21. Toque (PointerEvents pointerType=touch disparados de dentro da página; o Input.dispatchTouchEvent do Edge headless leva 0,4–1 s por evento e vira "segurar") ──
  // O módulo escuta pointerdown/move/up (não touch*); o relógio é o da página (setTimeout/performance.now), então o tempo é o real.
  const instalarToque = () => {
    const dedos = new Map();
    let ultimoToque = null;
    const alvoDe = (x, y) => document.elementFromPoint(x, y) || document.body;
    const evento = (el, tipo, id, x, y) => {
      const alvo = el && el.isConnected ? el : window;
      alvo.dispatchEvent(new PointerEvent(tipo, { pointerType: 'touch', pointerId: 100 + id, isPrimary: id === 1, clientX: x, clientY: y, button: tipo === 'pointermove' ? -1 : 0, buttons: tipo === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    };
    window.__tq = (tipo, pts) => {
      if (tipo === 'touchStart') {
        for (const [x, y, id = 1] of pts) {
          if (dedos.has(id)) continue;
          const el = alvoDe(x, y);
          dedos.set(id, { el, x0: x, y0: y, x, y, mov: 0, solos: dedos.size === 0 });
          evento(el, 'pointerdown', id, x, y);
        }
      } else if (tipo === 'touchMove') {
        for (const [x, y, id = 1] of pts) {
          const d = dedos.get(id);
          if (!d) continue;
          d.x = x; d.y = y; d.mov = Math.max(d.mov, Math.hypot(x - d.x0, y - d.y0));
          evento(d.el, 'pointermove', id, x, y);
        }
      } else if (tipo === 'touchEnd') {
        const todos = [...dedos.entries()], unico = todos.length === 1 && todos[0][1].solos;
        for (const [id, d] of todos) { dedos.delete(id); evento(d.el, 'pointerup', id, d.x, d.y); }
        if (unico && todos[0][1].mov <= 10) { // o navegador gera click (e dblclick no segundo toque rápido) depois de um toque parado
          const d = todos[0][1], agora = performance.now();
          if (d.el.isConnected) d.el.dispatchEvent(new MouseEvent('click', { clientX: d.x, clientY: d.y, bubbles: true, cancelable: true }));
          if (ultimoToque && agora - ultimoToque.t < 350 && ultimoToque.el === d.el && d.el.isConnected) d.el.dispatchEvent(new MouseEvent('dblclick', { clientX: d.x, clientY: d.y, bubbles: true, cancelable: true }));
          ultimoToque = { t: agora, el: d.el };
        }
      }
      return true;
    };
    return true;
  };
  const tq = (type, pts) => av(`__tq(${JSON.stringify(type)}, ${JSON.stringify(pts)})`);
  const tocarEm = async (x, y, seg = 0) => { await tq('touchStart', [[x, y]]); if (seg) await dormir(seg); await tq('touchEnd', []); };
  const posT = (id) => av(`({ x: +T(${JSON.stringify(id)}).dataset.x, y: +T(${JSON.stringify(id)}).dataset.y })`);
  await abrir('', 4);
  await av(`(${instalarToque.toString()})()`);
  const camIni = await av(`EscritoriosCanvas.camera()`);
  const pV = await posT('esc-vendas');
  c = await av(`centro(T('esc-vendas'))`);
  // toque simples
  await tocarEm(c.x, c.y);
  await dormir(80);
  r = await av(`({ sel: T('esc-vendas').classList.contains('esc-cv-sel'), vis: cardVis(), role: card().getAttribute('role'), pe: getComputedStyle(card()).pointerEvents, entrar: !!btn('Entrar', card()), entrou: cham('onEntrar').length, menu: !!menu() })`);
  conferir(r.sel && r.vis && r.role === 'group' && r.pe === 'auto' && r.entrar && r.entrou === 0 && !r.menu, 'toque simples seleciona o ladrilho e mostra o card (role=group) com botão "Entrar", sem entrar nem abrir menu', r);
  await dormir(500);
  conferir(await av(`cardVis()`), 'o card do toque continua aberto depois de levantar o dedo', null);
  const bc = await av(`centro(btn('Entrar', card()))`);
  await tocarEm(bc.x, bc.y);
  await dormir(100);
  r = await av(`cham('onEntrar')`);
  conferir(r.length === 1 && r[0].arg === 'esc-vendas', 'tocar em "Entrar" do card chama onEntrar(id)', r);
  // toque no fundo fecha o card e limpa a seleção
  await av(`__chamadas.length = 0; true`);
  await tocarEm(c.x, c.y); await dormir(500);
  const vzT = await av(`vazioPt()`);
  await tocarEm(vzT.x, vzT.y); await dormir(100);
  r = await av(`({ vis: cardVis(), sel: !!document.querySelector('.esc-cv-sel') })`);
  conferir(!r.vis && !r.sel, 'toque no fundo esconde o card e tira a seleção', r);
  // duplo toque
  await av(`__chamadas.length = 0; true`);
  await tocarEm(c.x, c.y); await tocarEm(c.x, c.y);
  await dormir(600);
  r = await av(`cham('onEntrar')`);
  conferir(r.length === 1 && r[0].arg === 'esc-vendas', 'duplo toque (2 toques em menos de 350 ms no mesmo ladrilho) chama onEntrar uma só vez (dblclick sintético não repete)', r);
  await av(`__chamadas.length = 0; true`);
  const c2 = await av(`centro(T('esc-suporte'))`);
  await tocarEm(c.x, c.y); await tocarEm(c2.x, c2.y); await dormir(600);
  conferir((await av(`cham('onEntrar')`)).length === 0, 'dois toques seguidos em ladrilhos diferentes não entram', null);
  await tocarEm(c.x, c.y); await dormir(480); await tocarEm(c.x, c.y); await dormir(600);
  conferir((await av(`cham('onEntrar')`)).length === 0, 'dois toques com mais de 350 ms entre eles não contam como duplo', await av(`cham('onEntrar')`));
  await tocarEm(vzT.x, vzT.y); await dormir(500);
  // mover antes do tempo = pan da vista (o ladrilho não vai junto)
  await av(`__chamadas.length = 0; true`);
  await tq('touchStart', [[c.x, c.y]]); await dormir(120);
  for (let i = 1; i <= 6; i++) { await tq('touchMove', [[c.x + i * 12, c.y + i * 5]]); await dormir(15); }
  await dormir(500); // passou do tempo de segurar, mas o dedo já virou pan
  for (let i = 1; i <= 3; i++) { await tq('touchMove', [[c.x + 72 + i * 20, c.y + 30]]); await dormir(15); }
  await tq('touchEnd', []);
  await dormir(150);
  r = await av(`({ cam: EscritoriosCanvas.camera(), arr: !!document.querySelector('.esc-cv-arrastando, .esc-cv-armado'), posts: posts().length })`);
  const pV2 = await posT('esc-vendas');
  conferir(pV2.x === pV.x && pV2.y === pV.y && r.posts === 0 && !r.arr, 'mover mais de 8 px antes de ~400 ms: o ladrilho não arrasta nem grava posição', { pV, pV2, r });
  conferir(r.cam.x < camIni.x - 20 && r.cam.y < camIni.y, 'mover antes do tempo desloca a vista (pan) acompanhando o dedo', { camIni, cam: r.cam });
  // segurar ~400 ms e arrastar = move o ladrilho (com pequeno tremor antes)
  const cam2 = await av(`EscritoriosCanvas.camera()`);
  c = await av(`centro(T('esc-vendas'))`);
  await tq('touchStart', [[c.x, c.y]]);
  await tq('touchMove', [[c.x + 4, c.y + 3]]);
  await dormir(520);
  r = await av(`({ armado: T('esc-vendas').classList.contains('esc-cv-armado') })`);
  conferir(r.armado, 'segurar ~400 ms arma o ladrilho (esc-cv-armado), mesmo com tremor de até 8 px', r);
  for (let i = 1; i <= 8; i++) { await tq('touchMove', [[c.x + 4 + i * 20, c.y + 3 + i * 12]]); await dormir(12); }
  r = await av(`({ arr: T('esc-vendas').classList.contains('esc-cv-arrastando'), alvo: !document.querySelector('.esc-cv-alvo').hidden })`);
  conferir(r.arr && r.alvo, 'depois de armado, o dedo arrasta o ladrilho (com o destino na grade)', r);
  await tq('touchEnd', []);
  await dormir(300);
  const pV3 = await posT('esc-vendas');
  const camF = await av(`EscritoriosCanvas.camera()`);
  const ps = await av(`posts()`);
  conferir((pV3.x !== pV.x || pV3.y !== pV.y) && pV3.x % 20 === 0 && pV3.y % 20 === 0 && perto(camF.x, cam2.x, 1e-6) && perto(camF.y, cam2.y, 1e-6), 'soltar grava a posição na grade e a vista não se mexeu', { pV, pV3, cam2, camF });
  conferir(ps.length === 1 && ps[0].corpo.canvas && ps[0].corpo.canvas.x === pV3.x && ps[0].corpo.canvas.y === pV3.y && (await av(`cham('onEntrar')`)).length === 0, 'o arraste por toque faz um POST {canvas} e não entra', ps);
  conferir((await av(`sobrepoe().length`)) === 0 && !(await av(`menu()`)), 'arraste por toque não sobrepõe ladrilhos nem abre menu', null);
  // segurar e soltar sem mexer abre o menu
  c = await av(`centro(T('esc-suporte'))`);
  await tocarEm(c.x, c.y, 560);
  await dormir(100);
  r = await av(`({ ac: acoes(), sel: T('esc-suporte').classList.contains('esc-cv-sel'), pos: posts().length })`);
  conferir(r.ac && r.ac.includes('entrar') && r.ac.includes('renomear') && r.sel && r.pos === 1, 'segurar e soltar sem mexer abre o menu do ladrilho', r);
  await esc();
  conferir(!(await av(`menu()`)), 'Esc fecha o menu aberto por toque', null);
  // o contextmenu do navegador no toque é ignorado
  r = await av(`(() => { const ev = new PointerEvent('contextmenu', { pointerType: 'touch', bubbles: true, cancelable: true, clientX: 300, clientY: 300 }); T('esc-suporte').dispatchEvent(ev); return { menu: !!menu(), pd: ev.defaultPrevented }; })()`);
  conferir(!r.menu && r.pd, 'contextmenu de toque não abre menu (e o menu do navegador é bloqueado)', r);
  // duplo toque no vazio cria; toque simples no vazio não
  await av(`__chamadas.length = 0; true`);
  await tocarEm(vzT.x, vzT.y); await dormir(500);
  conferir((await av(`cham('onCriar')`)).length === 0, 'um toque no fundo não cria escritório', null);
  await tocarEm(vzT.x, vzT.y); await tocarEm(vzT.x, vzT.y); await dormir(600);
  r = await av(`cham('onCriar')`);
  conferir(r.length === 1 && r[0].arg && r[0].arg.x % 20 === 0 && r[0].arg.y % 20 === 0 && !(await av(`colideCom(${r[0].arg.x}, ${r[0].arg.y}, null)`)), 'duplo toque no fundo chama onCriar uma vez, numa vaga livre da grade', r);
  // pinça dá zoom
  const camP = await av(`EscritoriosCanvas.camera()`);
  const postsP = (await av(`posts()`)).length;
  const mx = vzT.x + 150, my = vzT.y;
  await tq('touchStart', [[mx - 30, my]]);
  await tq('touchStart', [[mx - 30, my, 1], [mx + 30, my, 2]]);
  for (let i = 1; i <= 8; i++) { await tq('touchMove', [[mx - 30 - i * 10, my, 1], [mx + 30 + i * 10, my, 2]]); await dormir(12); }
  await tq('touchEnd', []);
  await dormir(150);
  r = await av(`({ cam: EscritoriosCanvas.camera(), arr: !!document.querySelector('.esc-cv-arrastando'), posts: posts().length })`);
  conferir(r.cam.zoom > camP.zoom * 1.5 && r.posts === postsP && !r.arr, 'pinça com dois dedos dá zoom (afastar aproxima) sem mover ladrilhos', { camP, r });
  const camQ = r.cam;
  await tq('touchStart', [[mx - 80, my, 1]]);
  await tq('touchStart', [[mx - 80, my, 1], [mx + 80, my, 2]]);
  for (let i = 1; i <= 8; i++) { await tq('touchMove', [[mx - 80 + i * 8, my, 1], [mx + 80 - i * 8, my, 2]]); await dormir(12); }
  await tq('touchEnd', []);
  await dormir(150);
  r = await av(`EscritoriosCanvas.camera()`);
  conferir(r.zoom < camQ.zoom * 0.75, 'pinça aproximando os dedos afasta (zoom menor)', { camQ, r });
  // segundo dedo sobre um ladrilho cancela o segurar
  c = await av(`centro(T('esc-docs'))`);
  await tq('touchStart', [[c.x, c.y, 1]]);
  await tq('touchStart', [[c.x, c.y, 1], [c.x + 40, c.y, 2]]);
  await dormir(550);
  r = await av(`({ armado: !!document.querySelector('.esc-cv-armado'), arr: !!document.querySelector('.esc-cv-arrastando') })`);
  await tq('touchEnd', []);
  conferir(!r.armado && !r.arr, 'um segundo dedo cancela o segurar do ladrilho (vira pinça)', r);
  // desmontar no meio do segurar: nenhum timer sobra
  await dormir(100);
  c = await av(`centro(T('esc-docs'))`);
  await tq('touchStart', [[c.x, c.y]]);
  const pend0 = await av(`__pendentes().timers`);
  await av(`EscritoriosCanvas.desmontar(); true`);
  r = await av(`__pendentes()`);
  await tq('touchEnd', []);
  conferir(pend0 >= 1 && r.timers === 0 && r.raf === 0, 'desmontar durante o segurar limpa o timer do toque', { pend0, r });

  // ── 22. Teclado e acessibilidade: barra antes da vista, um só tab stop (tabindex itinerante), foco devolvido ao ladrilho ──
  await abrir('', 4);
  r = await av(`(() => {
    const raiz = document.querySelector('.esc-cv'), f = [...raiz.children].map((e) => e.className.split(' ')[0]);
    const tabs = ladrilhos().filter((e) => e.getAttribute('tabindex') === '0').map((e) => e.dataset.id);
    const mais = [...document.querySelectorAll('.esc-cv-mais')];
    return { f, barraAntes: !!(document.querySelector('.esc-cv-barra').compareDocumentPosition(T('sessoes')) & Node.DOCUMENT_POSITION_FOLLOWING), tabs,
      maisTab: mais.map((b) => b.getAttribute('tabindex')), maisN: mais.length, outros: ladrilhos().filter((e) => e.getAttribute('tabindex') !== '0').every((e) => e.getAttribute('tabindex') === '-1') };
  })()`);
  conferir(r.f[0] === 'esc-cv-barra' && r.f[1] === 'esc-cv-vista' && r.barraAntes, 'a barra vem antes da vista (e dos ladrilhos) no DOM', r);
  conferir(JSON.stringify(r.tabs) === '["sessoes"]' && r.outros && r.maisN === 4 && r.maisTab.every((t) => t === '-1'), 'um só tab stop entre os ladrilhos (Sessões por padrão) e os "⋯" ficam fora da ordem de Tab', r);
  await av(`window.btn('Novo escritório').focus(); true`);
  const trilha = [];
  for (let i = 0; i < 8; i++) {
    await tecla('Tab', 'Tab', 9);
    const a = await av(`({ tile: document.activeElement.classList.contains('esc-cv-ladrilho') ? document.activeElement.dataset.id : null, barra: !!document.activeElement.closest('.esc-cv-barra'), mais: document.activeElement.classList.contains('esc-cv-mais') })`);
    trilha.push(a);
    if (a.tile) break;
  }
  const ult = trilha[trilha.length - 1];
  conferir(ult.tile === 'sessoes' && trilha.slice(0, -1).every((a) => a.barra) && trilha.length >= 2, 'Tab: primeiro a barra (Ajustar, zoom), depois um único ladrilho', trilha);
  await tecla('Tab', 'Tab', 9);
  r = await av(`({ tile: document.activeElement.classList.contains('esc-cv-ladrilho'), mais: document.activeElement.classList.contains('esc-cv-mais'), dentro: !!document.activeElement.closest('.esc-cv-vista') })`);
  conferir(!r.tile && !r.mais && !r.dentro, 'o próximo Tab sai do conjunto de ladrilhos (nem outro ladrilho nem "⋯")', r);
  await tecla('Tab', 'Tab', 9, { modifiers: 8 });
  conferir(await av(`document.activeElement.dataset.id`) === 'sessoes', 'Shift+Tab volta ao ladrilho atual', await av(`document.activeElement.dataset.id`));
  // setas movem entre ladrilhos pela posição na tela e o tab stop acompanha
  await av(`T('sessoes').focus(); true`);
  await tecla('ArrowRight', 'ArrowRight', 39);
  r = await av(`({ foco: document.activeElement.dataset.id, tabs: ladrilhos().filter((e) => e.getAttribute('tabindex') === '0').map((e) => e.dataset.id) })`);
  conferir(r.foco === 'esc-suporte' && JSON.stringify(r.tabs) === '["esc-suporte"]', 'seta move o foco ao vizinho e o tab stop acompanha (continua um só)', r);
  await av(`window.btn('Aproximar').focus(); true`);
  await tecla('Tab', 'Tab', 9);
  conferir(await av(`document.activeElement.dataset.id`) === 'esc-suporte', 'depois de navegar, o Tab volta ao último ladrilho focado (não a Sessões)', await av(`document.activeElement.dataset.id`));
  // semântica e rótulos
  r = await av(`({ role: T('esc-vendas').getAttribute('role'), rd: T('esc-vendas').getAttribute('aria-roledescription'), rdS: T('sessoes').getAttribute('aria-roledescription'),
    rot: T('esc-vendas').getAttribute('aria-label'), rotS: T('sessoes').getAttribute('aria-label'), mais: T('esc-vendas').querySelector('.esc-cv-mais').getAttribute('aria-label') })`);
  conferir(r.role === 'button' && r.rd === 'escritório' && r.rdS === 'atalho' && /tecla de menu para mais ações/.test(r.rot) && /tecla de menu para mais ações/.test(r.rotS) && r.mais === 'Mais ações de Vendas e propostas', 'ladrilho role=button com aria-roledescription e rótulo que cita a tecla de menu; "⋯" com rótulo próprio', r);
  r = await av(`({ id: card().id, vis: cardVis(), desc: T('esc-suporte').getAttribute('aria-describedby'), outros: ladrilhos().filter((e) => e.dataset.id !== 'esc-suporte').every((e) => !e.hasAttribute('aria-describedby')) })`);
  conferir(r.vis && r.id && r.desc === r.id && r.outros, 'enquanto o card é do ladrilho focado, ele o descreve (aria-describedby) e mais nenhum', r);
  vz = await av(`vazioPt()`);
  await clicar(vz.x, vz.y);
  conferir(await av(`!cardVis() && !T('esc-suporte').hasAttribute('aria-describedby')`), 'sem card visível, o ladrilho não aponta para ele', await av(`T('esc-suporte').getAttribute('aria-describedby')`));
  // tecla de menu: Alt+Seta para baixo, Shift+F10 e ContextMenu abrem o menu; Esc devolve o foco
  for (const [nome, k, cod, vk, mods] of [['Alt+Seta para baixo', 'ArrowDown', 'ArrowDown', 40, 1], ['Shift+F10', 'F10', 'F10', 121, 8], ['tecla de menu', 'ContextMenu', 'ContextMenu', 93, 0]]) {
    await av(`T('esc-docs').focus(); true`);
    await tecla(k, cod, vk, { modifiers: mods });
    r = await av(`({ menu: !!menu(), tit: menu() && menu().querySelector('.menu-tit').textContent, foco: focoAcao() })`);
    conferir(r.menu && r.tit === 'Documentação' && r.foco === 'entrar', `${nome} no ladrilho focado abre o menu com o foco no primeiro item`, r);
    await esc();
    r = await av(`({ menu: !!menu(), foco: document.activeElement.dataset.id })`);
    conferir(!r.menu && r.foco === 'esc-docs', `Esc depois de ${nome} devolve o foco ao ladrilho`, r);
  }
  // P2-7: a ação do menu roda com o foco já no ladrilho (quem abre gaveta/diálogo guarda o elemento focado para devolver depois)
  await av(`__chamadas.length = 0; true`);
  vz = await av(`vazioPt()`);
  for (const [acao, cb] of [['editar', 'onEditar'], ['duplicar', 'onDuplicar'], ['excluir', 'onExcluir'], ['entrar', 'onEntrar']]) {
    c = await av(`centro(T('esc-vendas').querySelector('.esc-cv-mais'))`);
    await clicar(c.x, c.y);
    await esperar(`!!menu()`);
    const it = await av(`centro(menu().querySelector('[data-acao=${acao}]'))`);
    await clicar(it.x, it.y);
    r = await av(`({ cham: cham('${cb}').map((x) => ({ arg: x.arg, foco: x.foco })), menu: !!menu(), card: cardVis() })`);
    conferir(r.cham.length === 1 && r.cham[0].arg === 'esc-vendas' && r.cham[0].foco === 'esc-vendas' && !r.menu && !r.card, `menu pelo mouse: ${cb} roda com o foco no ladrilho (não em null) e sem card aberto`, r);
  }
  await av(`__chamadas.length = 0; T('esc-vendas').focus(); true`);
  await tecla('ContextMenu', 'ContextMenu', 93);
  await baixo(); await baixo(); await enter();
  r = await av(`cham('onEditar').map((x) => ({ arg: x.arg, foco: x.foco }))`);
  conferir(r.length === 1 && r[0].arg === 'esc-vendas' && r[0].foco === 'esc-vendas', 'menu pelo teclado: Editar roda com o foco no ladrilho', r);
  await av(`T('esc-vendas').focus(); true`);
  await tecla('ContextMenu', 'ContextMenu', 93);
  await baixo(); await enter();
  await esperar(`!!document.querySelector('.esc-cv-nome-in')`);
  conferir(await av(`document.activeElement.className`) === 'esc-cv-nome-in', 'Renomear continua levando o foco ao campo de edição', await av(`document.activeElement.className`));
  await esc();
  conferir(await av(`document.activeElement.dataset.id`) === 'esc-vendas', 'Esc na edição devolve o foco ao ladrilho', await av(`document.activeElement.dataset.id`));

  // ── 23. Miniatura nítida: pede largura×altura × devicePixelRatio (teto 3), exibe no tamanho lógico; pixelated ao ampliar ──
  const dpr = async (fator, larg = 1280) => { await cdp('Emulation.setDeviceMetricsOverride', { width: larg, height: 800, deviceScaleFactor: fator, mobile: false }); };
  const remontar = async () => { await av(`__chamadas.length = 0; __remontar(); true`); await esperar(`pronto(4)`, 6000); };
  const miniInfo = () => av(`({ pedidas: cham('miniatura').map((x) => x.arg.largura + 'x' + x.arg.altura), cv: (() => { const e = T('esc-vendas').querySelector('canvas'); return { w: e.width, h: e.height, cssW: e.offsetWidth, cssH: e.offsetHeight, a: e.getContext('2d').getImageData(Math.floor(e.width / 2), Math.floor(e.height / 2), 1, 1).data[3] }; })(), dpr: devicePixelRatio })`);
  await remontar();
  r = await miniInfo();
  conferir(JSON.stringify(r.pedidas) === '["240x150"]' && r.cv.w === 240 && r.cv.h === 150 && r.cv.cssW === 240 && r.cv.a === 255, 'dpr 1: miniatura pedida em 240x150 e canvas 240x150', r);
  await dpr(2); await remontar();
  r = await miniInfo();
  conferir(r.dpr === 2 && JSON.stringify(r.pedidas) === '["480x300"]' && r.cv.w === 480 && r.cv.h === 300 && r.cv.cssW === 240 && r.cv.cssH === 150 && r.cv.a === 255,
    'dpr 2: miniatura pedida em 480x300, canvas 480x300 exibido em 240x150 CSS px, desenhado', r);
  await dpr(4); await remontar();
  r = await miniInfo();
  conferir(r.dpr === 4 && JSON.stringify(r.pedidas) === '["720x450"]' && r.cv.w === 720 && r.cv.cssW === 240, 'dpr 4: o teto é 3 (pedida 720x450, canvas 720x450 em 240 CSS px)', r);
  // dpr que muda com o canvas montado (zoom do navegador / outra tela): pede de novo e redesenha
  await dpr(1); await remontar();
  await av(`__chamadas.length = 0; true`);
  await dpr(2, 1290);
  await esperar(`cham('miniatura').length >= 1`, 3000);
  await esperar(`T('esc-vendas').querySelector('canvas').width === 480`, 3000);
  r = await miniInfo();
  conferir(JSON.stringify(r.pedidas) === '["480x300"]' && r.cv.w === 480 && r.cv.cssW === 240 && r.cv.a === 255, 'mudança de devicePixelRatio com o canvas montado: nova miniatura 480x300 e ladrilhos redesenhados', r);
  await dpr(1); await remontar();
  // ampliado: pixels nítidos
  r = await av(`({ amp: document.querySelector('.esc-cv').dataset.amp || null, zoom: EscritoriosCanvas.camera().zoom, ir: getComputedStyle(T('esc-vendas').querySelector('canvas')).imageRendering })`);
  conferir(r.zoom <= 1 && r.amp === null && r.ir !== 'pixelated', 'zoom até 100%: miniatura suavizada (sem data-amp)', r);
  for (let i = 0; i < 8 && (await av(`EscritoriosCanvas.camera().zoom`)) <= 1; i++) { await av(`window.btn('Aproximar').click(); true`); await dormir(120); await estavel(); }
  r = await av(`({ amp: document.querySelector('.esc-cv').dataset.amp || null, zoom: EscritoriosCanvas.camera().zoom, ir: getComputedStyle(T('esc-vendas').querySelector('canvas')).imageRendering })`);
  conferir(r.zoom > 1 && r.amp === '1' && r.ir === 'pixelated', 'zoom acima de 100%: data-amp=1 e image-rendering: pixelated na miniatura', r);
  for (let i = 0; i < 12 && (await av(`EscritoriosCanvas.camera().zoom`)) > 1; i++) { await av(`window.btn('Afastar').click(); true`); await dormir(120); await estavel(); }
  r = await av(`({ amp: document.querySelector('.esc-cv').dataset.amp || null, zoom: EscritoriosCanvas.camera().zoom })`);
  conferir(r.zoom <= 1 && r.amp === null, 'voltando a 100% ou menos, a miniatura volta a ser suavizada', r);

  // ── 15. Console limpo ──
  conferir(consoleErros.length === 0, 'sem erros nem avisos no console', consoleErros.slice(0, 5));
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
} finally {
  try { ws?.close(); } catch {}
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  await new Promise((r) => srv.close(r));
  try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch {}
}
console.log(`${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('FALHA:', f);
process.exit(res.falhas.length ? 1 : 0);
