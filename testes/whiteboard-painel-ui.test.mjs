// Teste do painel de sessões (assets/whiteboard-painel.js) contra testes/whiteboard-demo.html (fonte falsa window.OrbitFonteSessoes
// + window.demoSessoes para mudar/remover sessões). Servidor estático próprio (só GET) numa porta livre de 47822–47826,
// Edge headless mudo, perfil temporário apagado, fecharEdge no fim. CAPTURA=caminho.png grava uma captura pequena (opcional).
// node testes/whiteboard-painel-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-pn-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
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
  const tecla = async (key, code, vk = 0, text, modifiers = 0) => {
    const p = { key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(80);
  };
  const mouse = (type, x, y, button = 'none', buttons = 0, clickCount) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: clickCount ?? (type === 'mouseMoved' ? 0 : 1) });
  const clicar = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'left', 1); await mouse('mouseReleased', x, y, 'left', 0); await dormir(150); };
  const duplo = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 'left', 1, 1); await mouse('mouseReleased', x, y, 'left', 0, 1);
    await mouse('mousePressed', x, y, 'left', 1, 2); await mouse('mouseReleased', x, y, 'left', 0, 2);
    await dormir(200);
  };
  const arrastar2 = async (x0, y0, x1, y1) => { await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1); for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, 'left', 1); await mouse('mouseReleased', x1, y1, 'left', 0); await dormir(150); };
  const resetCam = async () => { await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`); await dormir(60); };
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(250);
  };

  const cards = () => av(`Whiteboard.agentes.cards()`);
  const centro = (sel) => av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const linhas = () => av(`[...document.querySelectorAll('.wb-pn-lin')].map((l) => l.dataset.sessao)`);
  const marcadas = () => av(`[...document.querySelectorAll('.wb-pn-lin[data-noquadro="1"]')].map((l) => l.dataset.sessao)`);
  const dadosDT = (id) => ({ items: [{ mimeType: 'application/x-orbit-sessao', data: id }, { mimeType: 'text/plain', data: id }], dragOperationsMask: 1 });
  const buscar = (v) => av(`(() => { const i = document.querySelector('.wb-pn-busca'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);

  // ── 1. API, botão e abrir/fechar ──
  conferir(await av(`!!(Whiteboard.painel && ['abrir', 'fechar', 'alternar', 'aberto'].every((k) => typeof Whiteboard.painel[k] === 'function') && Object.isFrozen(Whiteboard.painel))`), 'Whiteboard.painel publicado (congelado)');
  conferir(await av(`!!document.querySelector('.wb-vista > .wb-pn-btn') && !!document.querySelector('.wb-vista > .wb-pn')`), 'botão e painel dentro de .wb-vista');
  let est = await av(`({ a: Whiteboard.painel.aberto(), exp: document.querySelector('.wb-pn-btn').getAttribute('aria-expanded'), vis: getComputedStyle(document.querySelector('.wb-pn')).visibility, lbl: document.querySelector('.wb-pn-btn').getAttribute('aria-label') })`);
  conferir(est.a === false && est.exp === 'false' && est.vis === 'hidden' && !!est.lbl, 'começa fechado (aria-expanded=false, oculto, com rótulo)', est);
  await clicar(...(await centro('.wb-pn-btn')));
  await dormir(350);
  est = await av(`(() => { const r = document.querySelector('.wb-pn').getBoundingClientRect(), v = document.querySelector('.wb-vista').getBoundingClientRect(); return { a: Whiteboard.painel.aberto(), exp: document.querySelector('.wb-pn-btn').getAttribute('aria-expanded'), vis: getComputedStyle(document.querySelector('.wb-pn')).visibility, w: Math.round(r.width), dir: Math.round(v.right - r.right), dp: document.querySelector('.wb-vista').dataset.painel, ls: localStorage.getItem('orbit.whiteboard.painel'), foco: document.activeElement.className }; })()`);
  conferir(est.a && est.exp === 'true' && est.vis === 'visible' && est.w === 280 && est.dir === 12 && est.dp === 'aberto' && est.ls === '1', 'clicar no botão abre (280 px na borda direita, grava no localStorage)', est);
  conferir(/wb-pn-busca/.test(est.foco), 'foco vai para a busca ao abrir', est.foco);

  // ── 2. Agrupamento ──
  const grupos = await av(`[...document.querySelectorAll('.wb-pn-proj')].map((p) => [p.dataset.projeto, [...p.querySelectorAll('.wb-pn-corpo > li')].map((l) => l.classList.contains('wb-pn-grupo-tit') ? '#' + l.dataset.grupo : l.dataset.sessao).join(',')])`);
  conferir(JSON.stringify(grupos) === JSON.stringify([['Bazar', '#precisa,s2'], ['Orbit', '#precisa,t2,#trabalhando,s1,t1,#recentes,s3'], ['Pessoal', '#recentes,s4']]), 'agrupa por projeto e, dentro, por status (precisa, trabalhando, recentes)', grupos);
  const l1 = await av(`(() => { const l = document.querySelector('.wb-pn-lin[data-sessao="s1"]'); return { nome: l.querySelector('.wb-pn-nome').textContent, st: l.querySelector('.wb-pn-st').textContent, spr: l.querySelector('img').getAttribute('src'), dr: l.draggable, noq: l.dataset.noquadro || null }; })()`);
  conferir(l1.nome === 'Refatorar o grafo' && l1.st === 'Trabalhando' && /sprite-work\.gif$/.test(l1.spr) && l1.dr === true && l1.noq === null, 'linha com sprite, nome, status curto e draggable', l1);
  await clicar(...(await centro('.wb-pn-proj[data-projeto="Orbit"] .wb-pn-proj-cab')));
  const rec = await av(`({ exp: document.querySelector('.wb-pn-proj[data-projeto="Orbit"] .wb-pn-proj-cab').getAttribute('aria-expanded'), oc: document.querySelector('.wb-pn-proj[data-projeto="Orbit"] .wb-pn-corpo').hidden, outro: document.querySelector('.wb-pn-proj[data-projeto="Pessoal"] .wb-pn-corpo').hidden })`);
  conferir(rec.exp === 'false' && rec.oc === true && rec.outro === false, 'grupo de projeto recolhe', rec);
  await clicar(...(await centro('.wb-pn-proj[data-projeto="Orbit"] .wb-pn-proj-cab')));
  conferir(await av(`!document.querySelector('.wb-pn-proj[data-projeto="Orbit"] .wb-pn-corpo').hidden`), 'e expande de novo');

  // ── 3. Busca ──
  await clicar(...(await centro('.wb-pn-busca')));
  await buscar('REVISAR');
  conferir(JSON.stringify(await linhas()) === '["s2"]', 'busca por nome sem maiúsculas', await linhas());
  await buscar('pessoal');
  conferir(JSON.stringify(await linhas()) === '["s4"]', 'busca por projeto', await linhas());
  await buscar('concluída');
  const porStatus = await linhas();
  await buscar('concluida');
  conferir(JSON.stringify(porStatus) === '["s3"]' && JSON.stringify(await linhas()) === '["s3"]', 'busca por status, com e sem acento', { porStatus });
  await buscar('zzzz');
  conferir((await linhas()).length === 0 && (await av(`!document.querySelector('.wb-pn-vazio').hidden`)), 'sem resultado mostra aviso');
  conferir((await av(`document.querySelector('.wb-pn-vazio').textContent`)) === 'Nenhuma sessão encontrada', 'aviso da busca sem resultado diz "Nenhuma sessão encontrada"');
  await av(`document.querySelector('.wb-pn-busca').focus()`);
  await tecla('Escape', 'Escape', 27);
  est = await av(`({ v: document.querySelector('.wb-pn-busca').value, n: document.querySelectorAll('.wb-pn-lin').length, a: Whiteboard.painel.aberto() })`);
  conferir(est.v === '' && est.n === 6 && est.a === true, 'Esc limpa a busca (painel segue aberto)', est);

  // ── 4. Arrastar para o palco ──
  const o = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const soltarCdp = async (id, x, y) => {
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dadosDT(id) });
    await cdp('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dadosDT(id) });
    await cdp('Input.dispatchDragEvent', { type: 'drop', x, y, data: dadosDT(id) });
    await dormir(200);
  };
  const dt = await av(`(() => { const l = document.querySelector('.wb-pn-lin[data-sessao="s1"]'); const d = new DataTransfer(); let ef = null; l.addEventListener('dragstart', () => { ef = d.effectAllowed; }, { once: true });
    l.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: d }));
    const r = { tipo: d.getData('application/x-orbit-sessao'), txt: d.getData('text/plain'), ef: ef }; l.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return r; })()`);
  conferir(dt.tipo === 's1' && dt.txt === 's1' && (dt.ef === 'copy' || dt.ef === 'none'), 'dragstart grava TIPO_DT e text/plain com o id (DataTransfer sintético ignora effectAllowed)', dt);
  await soltarCdp('s1', o.l + 400, o.t + 300);
  let cs = await cards();
  if (!cs.length) {
    await av(`(() => { const p = document.querySelector('.wb-palco'); const d = new DataTransfer(); d.setData('application/x-orbit-sessao', 's1'); d.setData('text/plain', 's1');
      for (const t of ['dragenter', 'dragover', 'drop']) p.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: ${o.l + 400}, clientY: ${o.t + 300}, dataTransfer: d })); })()`);
    await dormir(200); cs = await cards();
  }
  conferir(cs.length === 1 && cs[0].sessao === 's1', 'soltar a sessão do painel no palco cria o card', cs);
  conferir(JSON.stringify(await marcadas()) === '["s1"]', 'sessão no quadro aparece marcada', await marcadas());
  const m1 = await av(`(() => { const l = document.querySelector('.wb-pn-lin[data-sessao="s1"]'); return { selo: !l.querySelector('.wb-pn-selo').hidden, lbl: l.getAttribute('aria-label'), bg: getComputedStyle(l).backgroundColor, bg2: getComputedStyle(document.querySelector('.wb-pn-lin[data-sessao="s3"]')).backgroundColor }; })()`);
  conferir(m1.selo && /no quadro/.test(m1.lbl) && m1.bg !== m1.bg2, 'marcada tem selo, rótulo e fundo diferente', m1);

  // ── 5. Duplo clique / Enter ──
  await av(`Whiteboard.nucleo.definirCamera({ x: 100, y: 50, zoom: 1 }, { animar: false })`);
  const tam = await av(`Whiteboard.nucleo.tamanho()`);
  await duplo(...(await centro('.wb-pn-lin[data-sessao="s2"]')));
  cs = await cards();
  const c2 = cs.find((c) => c.sessao === 's2');
  conferir(c2 && perto(c2.x + c2.w / 2, 100 + tam.w / 2, 3) && perto(c2.y + c2.h / 2, 50 + tam.h / 2, 3), 'duplo clique adiciona o card no centro da vista', { c2, tam });
  await av(`document.querySelector('.wb-pn-lin[data-sessao="s4"]').focus()`);
  await tecla('Enter', 'Enter', 13, '\r');
  conferir((await cards()).some((c) => c.sessao === 's4'), 'Enter na linha adiciona o card');
  await duplo(...(await centro('.wb-pn-lin[data-sessao="s3"]')));
  cs = await cards();
  const sobrep = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const tres = ['s2', 's4', 's3'].map((id) => cs.find((c) => c.sessao === id));
  conferir(tres.every(Boolean) && !sobrep(tres[0], tres[1]) && !sobrep(tres[0], tres[2]) && !sobrep(tres[1], tres[2]), 'cards adicionados em seguida ficam em pontos livres (sem sobreposição)', tres);
  await dormir(150);
  est = await av(`({ foco: document.activeElement.className, a: Whiteboard.painel.aberto() })`);
  await tecla('Escape', 'Escape', 27);
  conferir(est.a && (await av(`Whiteboard.painel.aberto()`)) === false, 'Esc fecha o painel depois do duplo clique', est);
  await av(`Whiteboard.painel.abrir()`);
  await dormir(250);
  await av(`document.querySelector('.wb-pn-lin[data-sessao="t1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await dormir(250);
  est = await av(`({ q: Whiteboard.times.quadros().map((q) => q.raiz), ms: [...document.querySelectorAll('.wb-pn-lin[data-noquadro="1"]')].map((l) => l.dataset.sessao) })`);
  conferir(est.q.includes('t1') && est.ms.includes('t1'), 'sessão de time vira quadro de time e fica marcada', est);

  // ── 6. Clique na marcada foca ──
  await av(`Whiteboard.nucleo.definirCamera({ x: 5000, y: 5000, zoom: 1 }, { animar: false }); Whiteboard.nucleo.selecionar([])`);
  await clicar(...(await centro('.wb-pn-lin[data-sessao="s1"]')));
  await dormir(700);
  est = await av(`(() => { const c = Whiteboard.agentes.cards().find((x) => x.sessao === 's1'), cam = Whiteboard.nucleo.camera(); return { sel: Whiteboard.nucleo.selecao(), id: c.id, dentro: c.x + c.w / 2 > cam.x && c.x + c.w / 2 < cam.x + 1200 && c.y + c.h / 2 > cam.y && c.y < cam.y + 800 }; })()`);
  conferir(est.sel.length === 1 && est.sel[0] === est.id && est.dentro, 'clicar na marcada leva a câmera ao card e seleciona', est);

  // ── 7. Marca some ao apagar ──
  const id4 = (await cards()).find((c) => c.sessao === 's4').id;
  await av(`Whiteboard.nucleo.remover(['${id4}'])`);
  await dormir(150);
  conferir(!(await marcadas()).includes('s4') && (await marcadas()).includes('s1'), 'marca some ao apagar o card', await marcadas());

  // ── 8. Ao vivo pela fonte ──
  await av(`demoSessoes.mudar('s3', { status: 'aguardando', statusTexto: 'Aguardando você' })`);
  await dormir(120);
  conferir((await av(`[...document.querySelectorAll('.wb-pn-proj[data-projeto="Orbit"] .wb-pn-grupo-tit')].map((t) => t.dataset.grupo).join(',')`)) === 'precisa,trabalhando', 'mudança na fonte reagrupa ao vivo (s3 vai para precisa)');
  await av(`demoSessoes.repor('s9', { nome: 'Nova sessão', projeto: 'Orbit', status: 'trabalhando', statusTexto: 'Trabalhando', sprite: '../assets/sprites/sprite-work.gif' })`);
  await dormir(120);
  conferir((await linhas()).includes('s9'), 'sessão nova aparece ao vivo');

  // ── 9. Estilo não fica coberto ──
  await av(`Whiteboard.nucleo.definirFerramenta('retangulo')`);
  await dormir(450);
  const sobrepoe = await av(`(() => { const e = document.querySelector('.wb-est'); if (!e) return null; const a = e.getBoundingClientRect(), b = document.querySelector('.wb-pn').getBoundingClientRect(); return { cobre: !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom), vis: getComputedStyle(e).visibility, estDir: Math.round(a.right), pnEsq: Math.round(b.left) }; })()`);
  conferir(sobrepoe && sobrepoe.cobre === false && sobrepoe.vis === 'visible', 'painel de estilo fica à esquerda do painel (não coberto)', sobrepoe);

  // ── 10. Atalho, fechar, memória ──
  await av(`document.querySelector('.wb-palco').focus()`);
  await tecla('A', 'KeyA', 65, 'A', 8);
  conferir((await av(`Whiteboard.painel.aberto()`)) === false && (await av(`localStorage.getItem('orbit.whiteboard.painel')`)) === '0', 'Shift+A fecha e grava 0');
  await dormir(350);
  est = await av(`({ vis: getComputedStyle(document.querySelector('.wb-pn')).visibility, dp: document.querySelector('.wb-vista').dataset.painel || null, ouv: demoSessoes.ouvintes(), estDir: Math.round(document.querySelector('.wb-vista').getBoundingClientRect().right - document.querySelector('.wb-est').getBoundingClientRect().right) })`);
  conferir(est.vis === 'hidden' && est.dp === null && est.estDir === 12, 'fechado: painel oculto e estilo volta ao canto', est);
  const ouvFechado = est.ouv;
  await tecla('A', 'KeyA', 65, 'A', 8);
  conferir((await av(`Whiteboard.painel.aberto()`)) === true && (await av(`demoSessoes.ouvintes()`)) === ouvFechado + 1, 'Shift+A abre de novo e religa a escuta');
  await av(`Whiteboard.painel.fechar()`);
  await abrir('?vazio=1');
  conferir((await av(`Whiteboard.painel.aberto()`)) === false, 'fechado é lembrado após recarregar');
  await av(`Whiteboard.painel.abrir()`);
  await abrir('?vazio=1');
  est = await av(`({ a: Whiteboard.painel.aberto(), vis: getComputedStyle(document.querySelector('.wb-pn')).visibility, n: document.querySelectorAll('.wb-pn-lin').length })`);
  conferir(est.a && est.vis === 'visible' && est.n >= 6, 'aberto é lembrado após recarregar (e já lista as sessões)', est);
  await av(`document.querySelector('.wb-pn-busca').focus()`);
  await tecla('Escape', 'Escape', 27);
  est = await av(`({ a: Whiteboard.painel.aberto(), foco: document.activeElement.className })`);
  conferir(!est.a && /wb-pn-btn/.test(est.foco), 'Esc com busca vazia fecha o painel e devolve o foco ao botão', est);

  // ── 11. Sem fonte ──
  await abrir('?vazio=1&semfonte=1');
  est = await av(`({ dis: document.querySelector('.wb-pn-btn').disabled, a: Whiteboard.painel.aberto() })`);
  conferir(est.dis === true && est.a === false, 'sem fonte: botão desativado', est);
  await av(`Whiteboard.painel.abrir()`);
  await dormir(300);
  est = await av(`({ txt: document.querySelector('.wb-pn-vazio').textContent, vis: !document.querySelector('.wb-pn-vazio').hidden, n: document.querySelectorAll('.wb-pn-lin').length, dis: document.querySelector('.wb-pn-btn').disabled })`);
  conferir(est.txt === 'Sessões indisponíveis' && est.vis && est.n === 0 && est.dis === false, 'sem fonte: painel mostra "Sessões indisponíveis" (botão volta a fechar)', est);
  await av(`localStorage.clear()`);

  if (process.env.CAPTURA) {
    await abrir('?vazio=1'); await av(`Whiteboard.painel.abrir(); Whiteboard.agentes.adicionar('s1', 300, 300); Whiteboard.nucleo.definirFerramenta('retangulo')`); await dormir(500);
    const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(process.env.CAPTURA, Buffer.from(r.result.data, 'base64'));
    await av(`localStorage.clear()`);
  }
  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard painel UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
