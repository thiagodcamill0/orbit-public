// Navegador interno (16/10), na página de verdade: servidor de teste (47822–47826) + Edge headless + sites falsos.
// Rodar:  node testes/navegador-ui.test.mjs [pasta-das-capturas]
// Confere: a lateral tem "Navegador" e não tem "Atalhos"; a aba nova mostra a página inicial com o campo em foco;
// endereço digitado abre num iframe isolado (sandbox sem navegação do topo); site com X-Frame-Options/frame-ancestors
// mostra a mensagem com "Abrir no navegador" (que chega ao servidor); Voltar/Avançar/Recarregar; servidor local fora
// do ar mostra a mensagem e abre sozinho quando sobe; o endereço do próprio Orbit é recusado; prévia do projeto pelo
// menu de botão direito (sugestão da porta em uso pelo projeto, detectada de verdade) e "Abrir prévia" com o nome do
// projeto no título; F5 restaura as abas; o beforeunload pede confirmação com aba de navegador; 420 px sem rolagem
// horizontal; 0 erros de console. Fecha o Edge, desliga o servidor e os sites e apaga os dados.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// No Mac o $TMPDIR (/var/folders/…) é link para /private/var/…: o projeto entra pelo caminho real, e o servidor
// de desenvolvimento precisa citar o mesmo caminho na linha de comando. No Windows, o de sempre.
const TMP = process.platform === 'win32' ? os.tmpdir() : fs.realpathSync.native(os.tmpdir());
const BASE = path.join(TMP, 'gerenciador-testes', `navegador-ui-${Date.now()}`);
const DADOS = path.join(BASE, 'dados');
const PERFIL = path.join(BASE, 'edge');
const PASTA = path.join(BASE, 'loja-web');
const SAIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
for (const d of [DADOS, path.join(DADOS, 'sessoes'), path.join(DADOS, 'projetos'), PERFIL, PASTA]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PASTA, 'index.html'), '<h1>loja</h1>\n');
if (SAIDA) fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTA = await escolherPorta(47823);
const URL_BASE = `http://127.0.0.1:${PORTA}`;
const saude = async () => { try { return await (await fetch(URL_BASE + '/saude')).json(); } catch { return null; } };
const post = (rota, corpo) => fetch(URL_BASE + rota, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo) });
const livre = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
async function portaAbaixoDe49152() {
  for (let i = 0; i < 50; i++) { const p = 41000 + Math.floor(Math.random() * 6000); if (await livre(p)) return p; }
  throw new Error('sem porta livre para o servidor do projeto');
}

// Sites falsos (no próprio processo do teste).
const sites = [];
function site(rotas, porta = 0) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const f = rotas[req.url] || rotas['*'];
      if (!f) { res.writeHead(404); return res.end(); }
      f(req, res);
    });
    sites.push(s);
    s.listen(porta, '127.0.0.1', () => resolve(s.address().port));
  });
}
const pagina = (titulo, cab = {}) => (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cab }); res.end(`<!doctype html><title>${titulo}</title><body style="background:#fff;font:16px sans-serif"><h1 id="t">${titulo}</h1><a href="/b">ir</a></body>`); };

const env = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_MODELOS_INICIO: '300',
  ORBIT_PASTAS_TEMP: path.join(BASE, 'nenhuma-temp'),
  FALSO_LOG: path.join(DADOS, 'falso.log'),
};
delete env.GERENCIADOR_REINICIOS;
delete env.CLAUDECODE;

let pcdp = 0, srv = null, dev = null, ok = 0, falhas = 0;
const conferir = (cond, rotulo, extra) => { if (cond) ok++; else falhas++; console.log(`${cond ? 'ok   ' : 'FALHA'} ${rotulo}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : ''}`); };

try {
  const pOk = await site({ '/': pagina('Página A'), '/b': pagina('Página B') });
  const pBloq = await site({ '/': pagina('Negada', { 'x-frame-options': 'DENY' }), '/csp': pagina('Negada CSP', { 'content-security-policy': "frame-ancestors 'none'" }) });
  const pTarde = await portaAbaixoDe49152(); // ninguém escuta ainda
  // "Servidor de desenvolvimento" do projeto: processo próprio com a pasta do projeto na linha de comando.
  const pDev = await portaAbaixoDe49152();
  dev = spawn(process.execPath, ['-e', 'require("http").createServer((q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end("<h1>loja dev</h1>"); }).listen(+process.argv[1], "127.0.0.1")', String(pDev), PASTA], { stdio: 'ignore' });

  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], { env, stdio: 'ignore' });
  let s0 = null;
  for (let i = 0; i < 60 && !(s0 && s0.pid === srv.pid); i++) { await dormir(150); s0 = await saude(); }
  if (!s0 || s0.pid !== srv.pid) throw new Error('o servidor do teste não subiu');
  const rp = await post('/projetos/adicionar', { pasta: PASTA });
  conferir(rp.status === 201 || rp.status === 200, 'projeto de teste na lista', rp.status);

  const EDGE = (await import('./edge.mjs')).caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pend = new Map();
  const erros = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Page.javascriptDialogOpening') { erros.push('diálogo inesperado: ' + j.params.type); ws.send(JSON.stringify({ id: 99999, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); }
    if (j.method === 'Runtime.exceptionThrown') erros.push(j.params.exceptionDetails?.exception?.description || 'exceção');
    if (j.method === 'Runtime.consoleAPICalled' && (j.params.type === 'error' || j.params.type === 'warning')) erros.push(j.params.type + ': ' + j.params.args.map((x) => x.value ?? x.description).join(' '));
    // O iframe negado gera um erro de log do próprio navegador (esperado quando forçamos); o /modelos é de antes.
    if (j.method === 'Log.entryAdded' && j.params.entry.level === 'error' && !/\/modelos|X-Frame-Options|frame-ancestors|ERR_CONNECTION_REFUSED/.test((j.params.entry.url || '') + j.params.entry.text)) erros.push('log: ' + j.params.entry.text + ' ' + (j.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  const ate = async (expr, ms = 6000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = await av(expr); if (v) return v; await dormir(120); } return null; };
  const centro = (sel) => av(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clicar = async (sel, botao = 'left') => {
    const c = await centro(sel);
    if (!c) throw new Error('sem alvo para clicar: ' + sel);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: botao, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: botao, clickCount: 1 });
    await dormir(180);
  };
  const digitar = async (texto) => { await cdp('Input.insertText', { text: texto }); await dormir(60); };
  const tecla = async (key, code, vk, mod = 0) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers: mod });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: mod });
    await dormir(150);
  };
  const enter = () => tecla('Enter', 'Enter', 13);
  const foto = async (nome) => {
    if (!SAIDA) return;
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const P = `document.querySelector('.aba-painel:not([hidden]) .nav-raiz')`; // a aba web à vista
  const webs = () => av(`window.Abas.abas().filter((a) => a.tipo === 'web').map((a) => ({ id: a.id, url: a.dados && a.dados.url, vis: window.Abas.visivel(a.id), tit: document.querySelector('#abas-raiz .aba[data-id="' + a.id + '"] .aba-tit, #abas-raiz [id="' + a.id + '"] .aba-tit')?.textContent || '' }))`);
  const titAtiva = () => av(`(() => { const a = window.Abas.ativa(); const el = a && [...document.querySelectorAll('#abas-raiz .aba')].find((x) => x.classList.contains('ativa') && x.closest('.abas-grupo').classList.contains('foco')); return el ? el.querySelector('.aba-tit').textContent : ''; })()`);
  const irPara = async (url) => {
    await clicar(`${P}.querySelector('.nav-campo')`);
    await av(`${P}.querySelector('.nav-campo').select()`);
    await digitar(url);
    await enter();
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: URL_BASE + '/' });
  await ate(`document.readyState === 'complete' && !!window.Abas && !!window.Navegador`);
  await dormir(900);

  // ───── Lateral ─────
  conferir(await av(`!!document.getElementById('nav-navegador') && !document.getElementById('nav-ajuda') && !document.getElementById('btn-ajuda-e')`), 'a lateral tem "Navegador" e não tem "Atalhos"');
  conferir(await av(`![...document.querySelectorAll('.lateral .nav-item')].some((b) => /Atalhos/.test(b.textContent))`), 'nenhum item da lateral chamado Atalhos');
  conferir(await av(`typeof window.Orbit?.abrirNavegador === 'function' && typeof window.Orbit?.pedirConfirmacaoAoFechar === 'function' && window.Orbit.ehLocal('http://localhost:3000') && !window.Orbit.ehLocal('https://github.com')`), 'window.Orbit expõe abrirNavegador, pedirConfirmacaoAoFechar e ehLocal');
  await av(`window.Orbit.confirmarEmTeste = true`);
  conferir(await av(`(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return !e.defaultPrevented; })()`), 'sem aba de navegador nem sessão trabalhando, fechar não pergunta');

  // ───── Aba nova ─────
  await clicar(`document.getElementById('nav-navegador')`);
  conferir(await ate(`!!${P} && !${P}.querySelector('.nav-inicio').hidden`), 'Navegador abre uma aba nova com a página inicial');
  conferir(await ate(`document.activeElement === ${P}.querySelector('.nav-campo')`), 'o campo de endereço fica em foco');
  conferir(await titAtiva() === 'Nova aba', 'o título é "Nova aba"', await titAtiva());
  conferir(await ate(`/loja-web/.test(${P}.querySelector('.nav-inicio').textContent) && /Rodando agora/.test(${P}.querySelector('.nav-inicio').textContent)`, 15000), 'a página inicial mostra o servidor do projeto em "Rodando agora" (porta detectada)', await av(`${P}.querySelector('.nav-inicio').textContent`));
  await foto('1-nova-aba');

  // ───── Endereço digitado ─────
  await irPara(`127.0.0.1:${pOk}`);
  conferir(await ate(`(() => { const q = ${P}.querySelector('.nav-quadro'); return !q.hidden && getComputedStyle(q).visibility === 'visible' && q.src === 'http://127.0.0.1:${pOk}/'; })()`), 'o endereço abre no iframe');
  conferir(await av(`(() => { const s = ${P}.querySelector('.nav-quadro').getAttribute('sandbox'); return /allow-scripts/.test(s) && !/allow-top-navigation/.test(s); })()`), 'iframe isolado: scripts sim, navegação do topo não');
  conferir(await ate(`!${P}.querySelector('.nav-prog').classList.contains('on')`, 6000), 'a barra de progresso some depois do load');
  conferir(await titAtiva() === `127.0.0.1:${pOk}`, 'o título da aba é o host', await titAtiva());
  conferir(await av(`${P}.querySelector('.nav-campo').value === '127.0.0.1:${pOk}'`), 'a barra mostra o endereço sem http://', await av(`${P}.querySelector('.nav-campo').value`));
  await foto('2-pagina');

  // ───── Bloqueado ─────
  await irPara(`http://127.0.0.1:${pBloq}/`);
  conferir(await ate(`${P}.querySelector('.nav-aviso')?.dataset.estado === 'bloqueado' && !${P}.querySelector('.nav-aviso').hidden`), 'X-Frame-Options: mensagem de bloqueio em vez de tela em branco');
  conferir(await av(`/não abre dentro do Orbit/.test(${P}.querySelector('.nav-aviso h2').textContent) && !!${P}.querySelector('.nav-aviso .nav-primario')`), 'a mensagem tem o botão "Abrir no navegador"');
  await foto('3-bloqueado');
  await clicar(`${P}.querySelector('.nav-aviso .nav-primario')`);
  await dormir(300);
  const abertos = (await (await fetch(URL_BASE + '/navegador/abertos')).json()).abertos;
  conferir(abertos.includes(`http://127.0.0.1:${pBloq}/`), '"Abrir no navegador" chega ao servidor (no teste, só registra)', abertos);
  await irPara(`http://127.0.0.1:${pBloq}/csp`);
  conferir(await ate(`${P}.querySelector('.nav-aviso')?.dataset.estado === 'bloqueado' && /frame-ancestors/.test(${P}.querySelector('.nav-aviso').textContent)`), 'frame-ancestors também mostra a mensagem');

  // ───── Voltar, Avançar, Recarregar ─────
  const btn = (rot) => `${P}.querySelector('.nav-btn[aria-label="${rot}"]')`;
  await clicar(btn('Voltar'));
  await clicar(btn('Voltar'));
  conferir(await ate(`${P}.querySelector('.nav-quadro').src === 'http://127.0.0.1:${pOk}/' && ${P}.querySelector('.nav-aviso').hidden`), 'Voltar duas vezes volta à primeira página');
  conferir(await av(`${btn('Voltar')}.disabled && !${btn('Avançar')}.disabled`), 'no começo: Voltar desligado, Avançar ligado');
  await clicar(btn('Avançar'));
  conferir(await ate(`${P}.querySelector('.nav-aviso')?.dataset.estado === 'bloqueado'`), 'Avançar vai de novo à página bloqueada');
  await clicar(btn('Voltar'));
  await ate(`!${P}.querySelector('.nav-quadro').hidden`);
  await ate(`!${P}.querySelector('.nav-prog').classList.contains('on')`, 6000);
  await av(`window.__cargas = 0; document.querySelector('.aba-painel:not([hidden]) .nav-quadro').addEventListener('load', () => window.__cargas++)`);
  await clicar(btn('Recarregar'));
  conferir(await ate(`window.__cargas >= 1`, 6000), 'Recarregar carrega a página de novo');

  // ───── Fora do ar, e sobe depois ─────
  await irPara(`localhost:${pTarde}`);
  conferir(await ate(`${P}.querySelector('.nav-aviso')?.dataset.estado === 'fora-do-ar'`), 'porta local sem ninguém: "Nada respondendo"', await av(`${P}.querySelector('.nav-aviso')?.textContent`));
  await foto('4-fora-do-ar');
  await site({ '*': pagina('Subiu') }, pTarde);
  conferir(await ate(`!${P}.querySelector('.nav-quadro').hidden && ${P}.querySelector('.nav-aviso').hidden`, 9000), 'quando o servidor sobe, a aba abre sozinha');

  // ───── O próprio Orbit ─────
  await irPara(`127.0.0.1:${PORTA}`);
  conferir(await ate(`${P}.querySelector('.nav-aviso')?.dataset.estado === 'orbit'`), 'o endereço do próprio Orbit é recusado');
  // Sem a conferência do servidor (falha de rede), a página também recusa: o iframe nunca recebe o Orbit (P2-4).
  await av(`(() => { window.__fetchOrig = window.fetch; window.fetch = (u, o) => String(u).includes('/navegador/checar') ? Promise.reject(new TypeError('rede')) : window.__fetchOrig(u, o); return true; })()`);
  await irPara(`localhost:${PORTA}/`);
  conferir(await ate(`${P}.querySelector('.nav-aviso')?.dataset.estado === 'orbit' && !${P}.querySelector('.nav-aviso').hidden`), 'sem a conferência do servidor, a página recusa o Orbit sozinha');
  conferir(await av(`(() => { const s = ${P}.querySelector('.nav-quadro').getAttribute('src') || ''; return !s.includes(':${PORTA}'); })()`), 'o iframe nunca recebe o endereço do Orbit', await av(`${P}.querySelector('.nav-quadro').getAttribute('src')`));
  await av(`(window.fetch = window.__fetchOrig, true)`);
  await irPara('javascript:alert(1)');
  conferir(await ate(`${P}.querySelector('.nav-aviso')?.dataset.estado === 'invalido'`), 'javascript: é recusado como endereço inválido');

  // ───── Prévia do projeto ─────
  const projRow = `[...document.querySelectorAll('#projetos .proj-item')].find((b) => /loja-web/.test(b.textContent))`;
  await ate(`!!${projRow}`, 6000);
  await clicar(projRow, 'right');
  const item = (rot) => `[...document.querySelectorAll('.arq-menu .arq-mi')].find((b) => b.textContent === ${JSON.stringify(rot)})`;
  conferir(await ate(`!!${item('Definir a prévia…')} && !${item('Abrir prévia')}`), 'menu do projeto sem prévia: "Definir a prévia…"');
  await clicar(item('Definir a prévia…'));
  conferir(await ate(`!document.getElementById('balao').hidden && document.getElementById('balao-campo').value === 'localhost:${pDev}'`, 15000), 'o campo já vem com a porta em uso pelo projeto', await av(`[document.getElementById('balao-campo').value, document.getElementById('balao-txt').textContent]`));
  await foto('5-previa');
  await clicar(`document.getElementById('balao-sim')`);
  conferir(await ate(`(async () => (await (await fetch('/navegador/previas')).json()).previas.some((p) => p.url === 'http://localhost:${pDev}/'))()`), 'a prévia fica salva no servidor');
  await clicar(projRow, 'right');
  conferir(await ate(`!!${item('Abrir prévia')} && !!${item('Endereço da prévia…')}`), 'com prévia: "Abrir prévia" e "Endereço da prévia…"');
  await clicar(item('Abrir prévia'));
  conferir(await ate(`${P} && ${P}.querySelector('.nav-quadro').src === 'http://localhost:${pDev}/'`), '"Abrir prévia" abre o servidor do projeto numa aba');
  conferir(await titAtiva() === 'loja-web', 'o título da aba é o nome do projeto', await titAtiva());
  const n1 = (await webs()).length;
  await av(`window.Orbit.abrirNavegador('http://localhost:${pDev}/')`);
  conferir((await webs()).length === n1, 'abrirNavegador com um endereço já aberto só ativa a aba');
  await av(`window.Orbit.abrirNavegador('127.0.0.1:${pOk}/b', { lado: true })`);
  conferir(await ate(`document.querySelectorAll('#abas-raiz .abas-grupo').length === 2`), 'abrirNavegador com lado:true abre no painel ao lado');
  await foto('6-lado');

  // ───── Confirmação ao fechar e F5 ─────
  conferir(await av(`(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`), 'com aba de navegador aberta, fechar a janela pede confirmação');
  await av(`window.Orbit.confirmarEmTeste = false`); // senão a pergunta do beforeunload trava o F5 do teste
  const antes = (await webs()).map((x) => x.url).sort();
  await cdp('Page.reload', {});
  await dormir(400);
  await ate(`document.readyState === 'complete' && !!window.Abas && !!window.Navegador`);
  await dormir(900);
  const depois = (await webs()).map((x) => x.url).sort();
  conferir(JSON.stringify(antes) === JSON.stringify(depois) && depois.length === antes.length, 'F5 restaura as abas do navegador com o endereço', { antes, depois });
  conferir(await ate(`(() => { const p = document.querySelector('.aba-painel:not([hidden]) .nav-raiz'); return !!p && !p.querySelector('.nav-quadro').hidden; })()`), 'a aba à vista recarrega a página depois do F5');

  // ───── 420 px ─────
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: false });
  await dormir(500);
  conferir(await av(`document.documentElement.scrollWidth <= innerWidth + 1`), '420 px sem rolagem horizontal da página', await av(`[document.documentElement.scrollWidth, innerWidth]`));
  conferir(await av(`(() => { const p = [...document.querySelectorAll('.aba-painel:not([hidden]) .nav-raiz')].find((x) => x.getClientRects().length && x.getBoundingClientRect().width > 0); if (!p) return false; const c = p.querySelector('.nav-endereco').getBoundingClientRect(); const b = p.querySelector('.nav-barra').getBoundingClientRect(); return c.width > 120 && c.right <= b.right + 1; })()`), '420 px: a barra de endereço cabe');
  await foto('7-420');

  conferir(erros.length === 0, 'sem exceção, aviso ou erro no console' + (erros.length ? ': ' + erros.slice(0, 6).join(' | ') : ''));
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e.message);
} finally {
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  const s = await saude();
  if (s?.pid) await desligarSeMeu(PORTA, s.pid);
  if (dev) try { dev.kill(); } catch {}
  for (const x of sites) try { x.close(); x.closeAllConnections?.(); } catch {}
  await dormir(500);
  const m = (() => { try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch { return null; } })();
  if (m?.pid) try { process.kill(m.pid); } catch {}
  await dormir(300);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
