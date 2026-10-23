// Teste do card de navegador (assets/whiteboard-web.js) contra testes/whiteboard-demo.html (fetch falso de /whiteboard/* e /navegador/*).
// Dois servidores locais em portas livres de 47822–47826: o estático da demo e um "site falso" (outra origem, para o iframe).
// Hosts *.exemplo apontam para 127.0.0.1 (--host-resolver-rules): nenhum acesso à internet. Edge headless mudo, perfil apagado, fecharEdge no fim.
// node testes/whiteboard-web-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-web-'));
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

// Site falso: conta cargas da página e cliques recebidos (onclick do corpo faz GET /clique).
const hits = { pagina: 0, clique: 0 };
const PORTA_SITE = await escolherPorta(47826);
const site = http.createServer((req, r2) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/favicon.ico') { r2.writeHead(204); r2.end(); return; }
  if (p === '/clique') { hits.clique++; r2.writeHead(204); r2.end(); return; }
  hits.pagina++;
  r2.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  r2.end(`<!doctype html><title>Site falso ${p}</title><body style="margin:0;background:#cde;height:100vh" onclick="fetch('/clique')">Site falso ${p}</body>`);
});
await new Promise((r) => site.listen(PORTA_SITE, '127.0.0.1', r));
const S = (p = '/') => `http://localhost:${PORTA_SITE}${p}`;

// Proteções de referência: lidas do navegador.js (fonte única do navegador interno).
const navSrc = fs.readFileSync(path.join(PROJ, 'assets', 'navegador.js'), 'utf8');
const SANDBOX = /const SANDBOX = '([^']+)'/.exec(navSrc)?.[1];
const PERMITIR = /const PERMITIR = '([^']+)'/.exec(navSrc)?.[1];
const RP = /referrerpolicy: '([^']+)'/.exec(navSrc)?.[1];

let pcdp, ws;
try {
  const EDGE = (await import('./edge.mjs')).caminhoNavegador();
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--host-resolver-rules=MAP *.exemplo 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
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
    await dormir(250);
  };
  const arrastar2 = async (x0, y0, x1, y1) => { await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1); for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, 'left', 1); await mouse('mouseReleased', x1, y1, 'left', 0); await dormir(150); };
  const roda = async (x, y, deltaY, modifiers = 0) => { await mouse('mouseMoved', x, y); await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers }); await dormir(150); };
  const resetCam = async () => { await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`); await dormir(120); };
  const abrir = async (q = '') => {
    await cdp('Page.bringToFront').catch(() => {}); await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(250);
  };
  const webs = () => av(`Whiteboard.nucleo.elementos().filter((e) => e.tipo === 'web').map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.w, h: e.h, url: e.web.url, titulo: e.web.titulo }))`);
  const info = (id) => av(`(() => { const no = document.querySelector('.wb-no[data-id="${id}"]'); if (!no) return null; const f = no.querySelector('iframe'); const a = no.querySelector('.wb-web-aviso');
    return { estado: no.dataset.estado, tit: no.querySelector('.wb-web-tit')?.textContent, resHost: no.querySelector('.wb-web-resumo-host')?.textContent, iframe: !!f, src: f && f.getAttribute('src'), sb: f && f.getAttribute('sandbox'), allow: f && f.getAttribute('allow'),
      rp: f && f.getAttribute('referrerpolicy'), pe: f && getComputedStyle(f).pointerEvents, int: no.classList.contains('wb-web-int'), avTxt: a && !a.hidden ? a.textContent : null, avEstado: a && !a.hidden ? a.dataset.estado : null,
      btnFora: !!no.querySelector('.wb-web-a-fora'), btnForcar: !!no.querySelector('.wb-web-a-forcar'), btnDe: !!no.querySelector('.wb-web-a-de'), fav: !!no.querySelector('.wb-web-fav svg'),
      bts: [...no.querySelectorAll('.wb-web-bt')].map((b) => b.title) }; })()`);
  const campo = () => av(`(() => { const c = document.querySelector('.wb-web-campo'); return c ? { val: c.querySelector('input').value, erro: c.hasAttribute('data-erro'), dica: c.querySelector('.wb-web-campo-dica').textContent } : null; })()`);
  const digitar = async (txt) => { await cdp('Input.insertText', { text: txt }); await dormir(60); };
  const aviso = () => av(`(() => { const a = document.querySelector('.wb-aviso'); return a && !a.hidden ? a.textContent : null; })()`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await resetCam();
  const of = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const T = (x, y) => [of.l + x, of.t + y];
  await av(`window.rotulos = []; Whiteboard.nucleo.on('confirmar', (d) => rotulos.push(d && d.rotulo))`);

  conferir(!!SANDBOX && !!PERMITIR && !!RP, 'proteções de referência lidas do navegador.js', { SANDBOX, PERMITIR, RP });
  conferir(await av(`!!(Whiteboard.web && Whiteboard.web.adicionar && Whiteboard.web.pedirEndereco) && Object.isFrozen(Whiteboard.web)`), 'Whiteboard.web publicado (congelado)');
  const ferrs = await av(`[...document.querySelectorAll('.wb-barra .wb-ferr')].map((b) => b.dataset.ferramenta)`);
  conferir(!ferrs.some((f) => /web|site|navegador/.test(f)), 'nenhuma ferramenta nova na barra', ferrs);

  // ── 1. Endereços recusados ──
  const recusas = [];
  for (const u of ['javascript:alert(1)', 'ftp://exemplo.com/a', `http://127.0.0.1:${PORTA}/`, `http://localhost:${PORTA}/x`, 'data:text/html,oi', '']) {
    await av(`document.querySelector('.wb-aviso').hidden = true`);
    const id = await av(`Whiteboard.web.adicionar(${JSON.stringify(u)}, 300, 300)`);
    recusas.push([u, id, await aviso()]);
  }
  conferir(recusas.every(([, id, a]) => id === null && !!a), 'URL inválida (javascript:, ftp:, data:, vazio, o próprio Orbit) é recusada com aviso', recusas);
  conferir((await webs()).length === 0, 'nada foi criado pelas recusas');

  // ── 2. Adicionar: cria, seleciona, salva; iframe com as proteções do navegador interno ──
  const idA = await av(`Whiteboard.web.adicionar(${JSON.stringify(S('/'))}, 400, 300)`);
  let wa = (await webs())[0];
  conferir(idA && wa && wa.id === idA && wa.w === 480 && wa.h === 340 && perto(wa.x + wa.w / 2, 400) && perto(wa.y + wa.h / 2, 300), 'adicionar cria o card 480×340 centrado no ponto', wa);
  let r = await av(`({ sel: Whiteboard.nucleo.selecao(), rot: rotulos.slice(), f: Whiteboard.nucleo.ferramenta() })`);
  conferir(r.sel.length === 1 && r.sel[0] === idA && r.rot.includes('Navegador'), 'card selecionado e confirmar("Navegador")', r);
  conferir(await esperar(`document.querySelector('.wb-web[data-estado="pronto"]')`, 5000), 'iframe carrega e o estado vira pronto');
  let ia = await info(idA);
  conferir(ia && ia.iframe && ia.src === S('/'), 'iframe com o endereço do card', ia);
  conferir(ia && ia.sb === SANDBOX && ia.allow === PERMITIR && ia.rp === RP, 'sandbox, allow e referrerpolicy iguais aos do navegador interno', ia && { sb: ia.sb, allow: ia.allow, rp: ia.rp });
  conferir(ia && !/allow-top-navigation/.test(ia.sb || ''), 'sandbox sem navegação do topo');
  conferir(ia && ia.tit === `localhost:${PORTA_SITE}` && ia.fav && ia.bts.join('|') === 'Interagir com a página|Recarregar|Editar endereço|Abrir no navegador', 'cabeçalho: ícone, título e quatro botões', ia);
  const chk = await av(`demo.navegador.checar`);
  conferir(chk.length === 1 && chk[0] === S('/'), 'POST /navegador/checar antes de carregar (com x-gerenciador)', chk);
  conferir(await esperar(`demo.reqs.some((r) => r[1] === '/whiteboard/salvar' && JSON.stringify(r[2]).includes(${JSON.stringify(S('/'))}))`, 4000), 'POST /whiteboard/salvar leva web.url');
  const h0 = hits.pagina;
  await av(`window.__marca = document.querySelector('.wb-web iframe')`);
  await av(`Whiteboard.nucleo.definirCamera({ x: 30, y: 20, zoom: 1 }, { animar: false })`); await dormir(300);
  await av(`Whiteboard.nucleo.redesenhar()`); await dormir(200);
  conferir(hits.pagina === h0 && await av(`document.querySelector('.wb-web iframe') === window.__marca`), 'mudar a câmera/redesenhar não recarrega o iframe', { h0, agora: hits.pagina });
  await resetCam();

  // ── 3. Película: arrastar move o card; roda dá pan/zoom no quadro; clique não chega ao site ──
  conferir(ia && ia.pe === 'none' && !ia.int, 'por padrão o iframe fica sob a película (pointer-events: none)', ia && { pe: ia.pe });
  await av(`Whiteboard.nucleo.selecionar([])`);
  const c0 = hits.clique;
  await arrastar2(...T(400, 300), ...T(480, 340));
  let wb = (await webs())[0];
  conferir(perto(wb.x, wa.x + 80, 2) && perto(wb.y, wa.y + 40, 2), 'arrastar o corpo do card move o card', { antes: [wa.x, wa.y], depois: [wb.x, wb.y] });
  await clicar(...T(480, 340)); await dormir(200);
  conferir(hits.clique === c0, 'clique fora da interação não chega ao site', { c0, agora: hits.clique });
  const cam0 = await av(`Whiteboard.nucleo.camera()`);
  await roda(...T(480, 340), -100, 2); // Ctrl+roda = zoom
  const cam1 = await av(`Whiteboard.nucleo.camera()`);
  conferir(cam1.zoom > cam0.zoom + 0.05, 'Ctrl+roda sobre o card dá zoom no quadro', { cam0, cam1 });
  await resetCam();
  await roda(...T(480, 340), 120);
  const cam2 = await av(`Whiteboard.nucleo.camera()`);
  conferir(cam2.y > 50, 'roda sobre o card desloca o quadro', cam2);
  await resetCam();

  // ── 4. Interação: duplo clique liga, Esc/clique fora desliga ──
  wb = (await webs())[0];
  const cx = wb.x + wb.w / 2, cy = wb.y + wb.h / 2 + 20; // corpo (abaixo do cabeçalho)
  await duplo(...T(cx, cy));
  let ib = await info(idA);
  conferir(ib && ib.int && ib.pe === 'auto', 'duplo clique no corpo liga a interação (película some)', ib && { int: ib.int, pe: ib.pe });
  conferir(await av(`getComputedStyle(document.querySelector('.wb-web.wb-web-int .wb-web-c')).boxShadow.includes('112, 184, 255')`), 'contorno de destaque no modo interação');
  const c1 = hits.clique;
  await clicar(...T(cx, cy)); await dormir(300);
  conferir(hits.clique === c1 + 1, 'em interação o clique chega ao site', { c1, agora: hits.clique });
  // o clique dentro do iframe tira o foco do documento: devolve o foco ao palco para o Esc
  await av(`document.querySelector('.wb-palco').focus()`);
  await tecla('Escape', 'Escape', 27);
  ib = await info(idA);
  conferir(ib && !ib.int && ib.pe === 'none', 'Esc sai da interação', ib && { int: ib.int, pe: ib.pe });
  conferir((await av(`Whiteboard.nucleo.selecao()`)).includes(idA), 'Esc da interação mantém o card selecionado');
  await duplo(...T(cx, cy));
  conferir((await info(idA)).int, 'duplo clique liga de novo');
  await clicar(...T(1000, 700));
  conferir(!(await info(idA)).int, 'clique fora sai da interação');
  await av(`document.querySelector('.wb-web .wb-web-b-int').click()`); await dormir(100);
  conferir((await info(idA)).int, 'botão Interagir liga');
  await av(`document.querySelector('.wb-web .wb-web-b-int').click()`); await dormir(100);
  conferir(!(await info(idA)).int, 'botão Interagir desliga');

  // ── 5. Recarregar e abrir no navegador ──
  const h1 = hits.pagina;
  await av(`document.querySelector('.wb-web .wb-web-b-rec').click()`);
  await esperar(`document.querySelector('.wb-web[data-estado="pronto"]')`, 4000);
  conferir(hits.pagina === h1 + 1, 'Recarregar busca a página de novo', { h1, agora: hits.pagina });
  await av(`document.querySelector('.wb-web .wb-web-b-fora').click()`); await dormir(150);
  conferir((await av(`demo.navegador.externo`)).includes(S('/')), 'Abrir no navegador faz POST /navegador/externo');

  // ── 6. Fora da vista / zoom pequeno: sem iframe, cartão-resumo ──
  const idF = await av(`Whiteboard.web.adicionar(${JSON.stringify(S('/longe'))}, 5000, 4000)`);
  await dormir(300);
  let iF = await info(idF);
  conferir(iF && !iF.iframe && iF.estado === 'resumo' && iF.resHost === `localhost:${PORTA_SITE}`, 'card fora da vista não tem iframe (cartão-resumo com o host)', iF);
  conferir(!(await av(`demo.navegador.checar`)).includes(S('/longe')), 'fora da vista nem confere o endereço no servidor');
  await av(`Whiteboard.nucleo.definirCamera({ x: 4600, y: 3800, zoom: 1 }, { animar: false })`);
  conferir(await esperar(`document.querySelector('.wb-no[data-id="${idF}"] iframe')`, 4000), 'ao entrar na vista o iframe carrega');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  await dormir(8900);
  iF = await info(idF);
  conferir(iF && !iF.iframe && iF.estado === 'resumo', 'sai da vista e depois de alguns segundos o iframe é descarregado', iF);
  await av(`Whiteboard.nucleo.definirCamera({ x: 5000 - 600 * 10, y: 4000 - 400 * 10, zoom: 0.1 }, { animar: false })`);
  await dormir(500);
  iF = await info(idF);
  conferir(iF && !iF.iframe && iF.estado === 'resumo', 'zoom minúsculo (10%) mantém o cartão-resumo mesmo na vista', iF);
  await resetCam();
  await av(`Whiteboard.nucleo.remover(['${idF}'])`); await av(`Whiteboard.nucleo.confirmar('excluir')`);

  // ── 7. Avisos: bloqueado, fora do ar, erro de rede, rota ausente ──
  const idB = await av(`Whiteboard.web.adicionar('http://bloqueado.exemplo:${PORTA_SITE}/x', 400, 300)`);
  await esperar(`document.querySelector('.wb-no[data-id="${idB}"][data-estado="aviso"]')`, 4000);
  let iB = await info(idB);
  conferir(iB && !iB.iframe && iB.avEstado === 'bloqueado' && iB.avTxt.includes('Este site não abre dentro do Orbit') && iB.avTxt.includes(`bloqueado.exemplo:${PORTA_SITE}`) && iB.avTxt.includes('CSP frame-ancestors'), 'site bloqueado mostra o aviso do navegador interno', iB);
  conferir(iB && iB.btnFora && iB.btnForcar && !iB.btnDe, 'aviso tem "Abrir no navegador" e "Tentar mostrar mesmo assim"', iB);
  await av(`document.querySelector('.wb-no[data-id="${idB}"] .wb-web-a-fora').click()`); await dormir(150);
  conferir((await av(`demo.navegador.externo`)).includes(`http://bloqueado.exemplo:${PORTA_SITE}/x`), 'botão do aviso abre fora');
  await av(`document.querySelector('.wb-no[data-id="${idB}"] .wb-web-a-forcar').click()`);
  conferir(await esperar(`document.querySelector('.wb-no[data-id="${idB}"] iframe')`, 3000), '"Tentar mostrar mesmo assim" carrega o iframe');
  await av(`Whiteboard.nucleo.remover(['${idB}'])`); await av(`Whiteboard.nucleo.confirmar('excluir')`);

  const idR = await av(`Whiteboard.web.adicionar('http://rede.exemplo:${PORTA_SITE}/', 400, 300)`);
  await esperar(`document.querySelector('.wb-no[data-id="${idR}"][data-estado="aviso"]')`, 4000);
  let iR = await info(idR);
  conferir(iR && iR.avEstado === 'erro' && iR.btnDe && !iR.iframe, 'erro de rede na conferência: aviso com "Tentar de novo"', iR);
  await av(`Whiteboard.nucleo.remover(['${idR}'])`); await av(`Whiteboard.nucleo.confirmar('excluir')`);

  const idO = await av(`Whiteboard.web.adicionar('http://fora.exemplo:${PORTA_SITE}/', 400, 300)`);
  await esperar(`document.querySelector('.wb-no[data-id="${idO}"][data-estado="aviso"]')`, 4000);
  let iO = await info(idO);
  conferir(iO && iO.avEstado === 'fora-do-ar' && iO.btnDe && iO.btnFora && !iO.btnForcar && /Nada respondendo em fora\.exemplo/.test(iO.avTxt), 'fora do ar: aviso com Tentar de novo e Abrir no navegador', iO);
  await av(`Whiteboard.nucleo.remover(['${idO}'])`); await av(`Whiteboard.nucleo.confirmar('excluir')`);

  const idN = await av(`Whiteboard.web.adicionar('http://semrota.exemplo:${PORTA_SITE}/', 400, 300)`);
  conferir(await esperar(`document.querySelector('.wb-no[data-id="${idN}"] iframe')`, 4000), 'rota /navegador/checar inexistente (404): carrega direto');
  await av(`Whiteboard.nucleo.remover(['${idN}'])`); await av(`Whiteboard.nucleo.confirmar('excluir')`);

  // ── 8. Editar o endereço (duplo clique no cabeçalho e botão) com desfazer ──
  wb = (await webs())[0];
  await av(`Whiteboard.nucleo.selecionar([])`);
  await duplo(...T(wb.x + 100, wb.y + 17));
  let cp = await campo();
  conferir(cp && cp.val.includes(`localhost:${PORTA_SITE}`), 'duplo clique no cabeçalho abre o campo com o endereço', cp);
  conferir(!(await info(idA)).int, 'duplo clique no cabeçalho não liga a interação');
  await digitar('javascript:alert(1)'); await tecla('Enter', 'Enter', 13, '\r');
  cp = await campo();
  conferir(cp && cp.erro && /http/.test(cp.dica) && (await webs())[0].url === S('/'), 'endereço inválido na edição: mantém o campo com erro e não altera', cp);
  await tecla('a', 'KeyA', 65, undefined, 2);
  await digitar(S('/novo')); await tecla('Enter', 'Enter', 13, '\r');
  conferir(!(await campo()), 'Enter fecha o campo');
  wb = (await webs())[0];
  conferir(wb.url === S('/novo'), 'Enter grava o novo endereço', wb);
  conferir((await av(`rotulos.filter((x) => x === 'Navegador').length`)) >= 2, 'edição confirma o histórico (Navegador)');
  conferir(await esperar(`document.querySelector('.wb-web iframe')?.getAttribute('src') === ${JSON.stringify(S('/novo'))}`, 10000), 'o iframe recarrega no novo endereço');
  await av(`document.querySelector('.wb-palco').focus()`);
  await tecla('z', 'KeyZ', 90, undefined, 2);
  conferir(await esperar(`Whiteboard.nucleo.elementos().find((e) => e.tipo === 'web').web.url === ${JSON.stringify(S('/'))}`, 2000), 'Ctrl+Z volta o endereço antigo');
  conferir(await esperar(`document.querySelector('.wb-web iframe')?.getAttribute('src') === ${JSON.stringify(S('/'))}`, 4000), 'e o iframe volta a carregar o antigo');
  await av(`document.querySelector('.wb-web .wb-web-b-ed').click()`); await dormir(150);
  cp = await campo();
  conferir(!!cp, 'botão de editar abre o campo');
  await tecla('Escape', 'Escape', 27);
  conferir(!(await campo()) && (await webs())[0].url === S('/'), 'Esc cancela a edição sem alterar');

  // ── 9. pedirEndereco ──
  await av(`Whiteboard.web.pedirEndereco(700, 500)`); await dormir(150);
  cp = await campo();
  conferir(cp && cp.val === '' && await av(`document.activeElement === document.querySelector('.wb-web-campo input')`), 'pedirEndereco abre o campo vazio e focado', cp);
  await digitar('ftp://x.com'); await tecla('Enter', 'Enter', 13, '\r');
  cp = await campo();
  conferir(cp && cp.erro && (await webs()).length === 1, 'endereço inválido não cria e mostra o erro', cp);
  await tecla('a', 'KeyA', 65, undefined, 2);
  await digitar(S('/dois')); await tecla('Enter', 'Enter', 13, '\r');
  let lista = await webs();
  const idC = lista.find((e) => e.url === S('/dois'))?.id;
  conferir(lista.length === 2 && idC && !(await campo()), 'Enter cria o card', lista);
  const wc = lista.find((e) => e.id === idC);
  conferir(wc && perto(wc.x + wc.w / 2, 700, 2) && perto(wc.y + wc.h / 2, 500, 2), 'card criado centrado no ponto pedido', wc);
  await av(`Whiteboard.web.pedirEndereco(300, 300)`); await dormir(150);
  await tecla('Escape', 'Escape', 27);
  conferir(!(await campo()) && (await webs()).length === 2, 'Esc cancela sem criar');

  // ── 10. Soltar um link; sessão continua indo para o agente ──
  const dados = (itens) => ({ items: itens, dragOperationsMask: 1 | 2 });
  const soltar = async (itens, x, y) => {
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dados(itens) });
    await cdp('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dados(itens) });
    await dormir(60);
    const realce = await av(`document.querySelector('.wb-palco').classList.contains('wb-web-alvo')`);
    await cdp('Input.dispatchDragEvent', { type: 'drop', x, y, data: dados(itens) });
    await dormir(200);
    return realce;
  };
  const soltarSint = (tipo, valor, x, y) => av(`(() => { const p = document.querySelector('.wb-palco'); const dt = new DataTransfer(); dt.setData(${JSON.stringify(tipo)}, ${JSON.stringify(valor)});
    for (const t of ['dragenter', 'dragover', 'drop']) p.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, dataTransfer: dt })); return true; })()`);
  const antes = (await webs()).length;
  let realce = await soltar([{ mimeType: 'text/uri-list', data: S('/solto') }], ...T(900, 200));
  if ((await webs()).length === antes) { await soltarSint('text/uri-list', S('/solto'), ...T(900, 200)); await dormir(200); realce = null; }
  lista = await webs();
  const ls = lista.find((e) => e.url === S('/solto'));
  conferir(ls && perto(ls.x + ls.w / 2, 900, 2) && perto(ls.y + ls.h / 2, 200, 2), 'soltar um link (text/uri-list) cria o card no ponto', lista);
  conferir(realce !== false && !(await av(`document.querySelector('.wb-palco').classList.contains('wb-web-alvo')`)), 'realce do palco no dragover e some ao soltar', { realce });
  const antes2 = (await webs()).length;
  await soltarSint('text/uri-list', 'javascript:alert(1)', ...T(900, 600)); await dormir(200);
  conferir((await webs()).length === antes2, 'link javascript: solto é recusado');
  const antesAg = await av(`Whiteboard.nucleo.elementos().filter((e) => e.tipo === 'agente').length`);
  await soltarSint('application/x-orbit-sessao', 's2', ...T(900, 600)); await dormir(250);
  conferir((await av(`Whiteboard.nucleo.elementos().filter((e) => e.tipo === 'agente').length`)) === antesAg + 1 && (await webs()).length === antes2, 'soltar sessão continua criando card de agente, não de site');

  // ── 11. Seta prende no card ──
  await av(`Whiteboard.nucleo.selecionar([])`); await resetCam();
  wb = (await webs()).find((e) => e.id === idA);
  await tecla('a', 'KeyA', 65, 'a');
  await arrastar2(...T(100, 700), ...T(wb.x + 40, wb.y + 60));
  r = await av(`(() => { const s = Whiteboard.nucleo.elementos().find((e) => e.tipo === 'seta'); return s ? { fim: s.ligacoes && s.ligacoes.fim && s.ligacoes.fim.id, lig: Whiteboard.nucleo.elemento('${idA}').ligacoes, id: s.id, fimEl: s.ligacoes && s.ligacoes.fim && (e => e && [e.tipo,e.x,e.y,e.w,e.h])(Whiteboard.nucleo.elemento(s.ligacoes.fim.id)), A: (e=>[e.x,e.y,e.w,e.h])(Whiteboard.nucleo.elemento('${idA}')) } : null; })()`);
  conferir(r && r.fim === idA && Array.isArray(r.lig) && r.lig.includes(r.id), 'seta desenhada até o card fica presa nele', r);

  // ── 11b. Card travado: sem edição de endereço nem interação por duplo clique ──
  await av(`Whiteboard.nucleo.selecionar([]); Whiteboard.nucleo.elemento('${idA}').travado = true`); await resetCam();
  wb = (await webs()).find((e) => e.id === idA);
  await duplo(...T(wb.x + 100, wb.y + 17)); await dormir(150);
  conferir(!(await campo()) && !(await info(idA)).int, 'travado: duplo clique no cabeçalho não edita o endereço');
  await duplo(...T(wb.x + 40, wb.y + 200)); await dormir(150);
  conferir(!(await info(idA)).int && !(await campo()), 'travado: duplo clique no corpo não liga a interação');
  await av(`delete Whiteboard.nucleo.elemento('${idA}').travado`);

  // ── 11c. Segurança: URL inválida/própria (vinda de arquivo, colar ou carregar) nunca vira iframe ──
  await av(`Whiteboard.nucleo.selecionar([])`);
  await av(`Whiteboard.nucleo.definirCamera({ x: 5000, y: 5000, zoom: 0.5 }, { animar: false })`); await dormir(150);
  const porta = await av(`location.port`);
  const ruins = ['javascript:alert(1)', 'javascript:/*' + 'x'.repeat(300) + '*/1', 'data:text/html,<b>x</b>', 'file:///c:/x', `http://127.0.0.1:${porta}/`, `http://localhost:${porta}/x`, `http://[::1]:${porta}/`];
  const idsRuins = await av(`(() => ${JSON.stringify(ruins)}.map((u, i) => Whiteboard.nucleo.adicionar({ tipo: 'web', x: 5000 + (i % 3) * 500, y: 5000 + Math.floor(i / 3) * 400, w: 480, h: 340, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, web: { url: u, titulo: '' } }).id))()`);
  await dormir(900);
  const estRuins = await av(`${JSON.stringify(idsRuins)}.map((id) => { const n = document.querySelector('.wb-no[data-id="' + id + '"]'); return n ? { ifr: !!n.querySelector('iframe'), av: (n.querySelector('.wb-web-aviso') || {}).dataset && n.querySelector('.wb-web-aviso').dataset.estado, forcar: !!n.querySelector('.wb-web-a-forcar') } : null; })`);
  conferir(estRuins.every((x) => x && !x.ifr && !x.forcar && (x.av === 'invalido' || x.av === 'orbit')), 'URL inválida/própria (javascript:, data:, file:, Orbit em 127.0.0.1/localhost/[::1]) mostra aviso e nunca vira iframe', estRuins);
  conferir(estRuins.slice(4).every((x) => x && x.av === 'orbit') && estRuins[0].av === 'invalido', 'própria = "orbit"; inválida = "invalido"', estRuins.map((x) => x && x.av));
  await av(`Whiteboard.nucleo.remover(${JSON.stringify(idsRuins)})`);
  // "Tentar mostrar mesmo assim" (erro de checagem): só com endereço válido; trocar por inválido some com o botão e nunca vira iframe
  await av(`window.__fetchOrig = window.fetch; window.fetch = (u, o) => (String(u).includes('/navegador/checar') ? Promise.reject(new Error('x')) : window.__fetchOrig(u, o)); 0`);
  const idFx = await av(`Whiteboard.nucleo.adicionar({ tipo: 'web', x: 5000, y: 5000, w: 480, h: 340, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, web: { url: ${JSON.stringify(S('/forcar'))}, titulo: '' } }).id`);
  conferir(await esperar(`document.querySelector('.wb-no[data-id="${idFx}"] .wb-web-a-forcar')`, 4000), 'erro de checagem oferece "Tentar mostrar mesmo assim"');
  await av(`Whiteboard.nucleo.atualizar('${idFx}', { web: { url: 'javascript:alert(1)', titulo: '' } })`); await dormir(500);
  conferir(await av(`(() => { const n = document.querySelector('.wb-no[data-id="${idFx}"]'); return !n.querySelector('iframe') && !n.querySelector('.wb-web-a-forcar') && n.querySelector('.wb-web-aviso').dataset.estado === 'invalido'; })()`), 'trocar a URL por javascript: no estado de erro: sem botão e sem iframe', await av(`(() => { const n = document.querySelector('.wb-no[data-id="${idFx}"]'); return n && [!!n.querySelector('iframe'), !!n.querySelector('.wb-web-a-forcar'), n.querySelector('.wb-web-aviso').dataset.estado, n.dataset.estado]; })()`));
  await av(`Whiteboard.nucleo.atualizar('${idFx}', { web: { url: ${JSON.stringify(S('/forcar2'))}, titulo: '' } })`);
  await esperar(`document.querySelector('.wb-no[data-id="${idFx}"] .wb-web-a-forcar')`, 4000);
  await av(`window.fetch = window.__fetchOrig; document.querySelector('.wb-no[data-id="${idFx}"] .wb-web-a-forcar').click()`); await dormir(300);
  conferir((await av(`(document.querySelector('.wb-no[data-id="${idFx}"] iframe') || {}).src`)) === S('/forcar2'), 'forçar com endereço válido carrega o iframe com o href validado');
  // sair da vista descarrega os iframes; entrar traz de volta
  await av(`Whiteboard.sair()`); await dormir(300);
  conferir(await av(`document.querySelectorAll('.wb-web iframe').length === 0`), 'Whiteboard.sair descarrega os iframes dos cards web');
  await av(`Whiteboard.entrar()`);
  conferir(await esperar(`document.querySelector('.wb-no[data-id="${idFx}"] iframe')`, 5000), 'ao entrar de novo o iframe volta');
  await av(`Whiteboard.nucleo.remover(['${idFx}'])`);
  await resetCam();

  // ── 12. Recarregar o quadro mantém os cards ──
  const nWebs = (await webs()).length;
  await esperar(`demo.reqs.filter((r) => r[1] === '/whiteboard/salvar').length > 0`, 3000);
  await dormir(1500);
  await abrir('');
  lista = await webs();
  conferir(lista.length === nWebs && lista.some((e) => e.id === idA && e.url === S('/')), 'recarregar o quadro mantém os cards de site', { nWebs, lista });
  conferir(await esperar(`document.querySelector('.wb-no[data-id="${idA}"] iframe')`, 4000), 'e o iframe do card carrega de novo', await av(`(() => { const n = document.querySelector('.wb-no[data-id="${idA}"]'); return { cam: Whiteboard.nucleo.camera(), est: n && n.dataset.estado, cls: n && n.className, nos: document.querySelectorAll(".wb-no").length, vis: document.visibilityState, nels: Whiteboard.nucleo.elementos().length, ids: Whiteboard.nucleo.elementos().map((e) => e.id).slice(0, 6) }; })()`));

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close(); site.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard web UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
