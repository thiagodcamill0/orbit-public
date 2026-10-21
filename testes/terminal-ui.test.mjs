// Teste do terminal integrado (assets/terminal.js + .css) contra o terminal.mjs de verdade (PTY real, PowerShell e CMD).
// Servidor HTTP próprio numa porta livre de 47822–47826 (nunca a 47821): serve testes/terminal-demo.html, /assets/* e
// /terminal/* (rota + upgrade do terminal.mjs). Edge headless mudo, perfil na pasta de saída, fechado com fecharEdge.
// Mouse e teclado reais via CDP. A área de transferência é trocada por um espião na página (o teste nunca toca a do
// Windows) e o WebSocket.send é espiado para conferir o que vai para o shell.
// node testes/terminal-ui.test.mjs <pasta-de-saida>   (capturas 01 e 02 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { criarTerminal } from '../terminal.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-terminal-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const PERFIL = path.join(SAIDA, 'edge');
fs.rmSync(PERFIL, { recursive: true, force: true });
for (const p of ['proj', 'outro']) fs.mkdirSync(path.join(SAIDA, p), { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
// Mac/Linux (16/10): o shell padrão é o do usuário (zsh no Mac), o segundo do menu é o bash, e os comandos são os do
// sh. No Windows, tudo como antes: PowerShell, CMD e os comandos do PowerShell.
const WIN = process.platform === 'win32';
const CMD_LONGO = WIN ? `Write-Host 'Local: http://0.0.0.0:5173/'; Start-Sleep 40` : `echo 'Local: http://0.0.0.0:5173/'; sleep 40`;
const CMD_60 = WIN ? 'Start-Sleep 60' : 'sleep 60';
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 300))); };

// ── Servidor de teste (imita o encaixe do servidor.mjs) ──
const PORTA = await escolherPorta(47824);
const terminal = criarTerminal({
  porta: PORTA,
  projetos: () => [{ nome: 'proj', pasta: path.join(SAIDA, 'proj') }, { nome: 'outro', pasta: path.join(SAIDA, 'outro') }],
  log: () => {},
  lerJSONCorpo: async () => ({}),
});
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer(async (req, resp) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORTA}` && host !== `localhost:${PORTA}`) { resp.writeHead(403); resp.end(); return; }
  if (req.method === 'POST' && req.headers['x-gerenciador'] !== '1') { resp.writeHead(403); resp.end(); return; }
  const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
  try { if (await terminal.rota(req, resp, url.pathname, url)) return; } catch (e) { resp.writeHead(500); resp.end(String(e)); return; }
  if (req.method !== 'GET') { resp.writeHead(405); resp.end(); return; }
  const rel = decodeURIComponent(url.pathname);
  const permitido = rel === '/testes/terminal-demo.html' || rel.startsWith('/assets/');
  const alvo = path.resolve(PROJ, '.' + rel);
  if (!permitido || !alvo.startsWith(PROJ + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { resp.writeHead(404); resp.end(); return; }
  resp.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(alvo).pipe(resp);
});
srv.on('upgrade', (req, s, h) => { if (!terminal.upgrade(req, s, h)) s.destroy(); });
await new Promise((r) => srv.listen(PORTA, '127.0.0.1', r));
const URL_DEMO = `http://127.0.0.1:${PORTA}/testes/terminal-demo.html`;

let pcdp, ws;
try {
  const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
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
  const esperar = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(60); } return false; };
  const VK = { Enter: 13, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40, F2: 113, '`': 192, c: 67, v: 86, w: 87, a: 65 };
  const CODE = { '`': 'Backquote', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', F2: 'F2' };
  const tecla = async (key, mods = {}, extra = {}) => {
    const m = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
    const letra = /^[a-z]$/.test(key);
    const p = { key: letra && mods.shift ? key.toUpperCase() : (key === '`' && mods.shift ? '~' : key), code: CODE[key] || (letra ? 'Key' + key.toUpperCase() : key), windowsVirtualKeyCode: VK[key] || 0, modifiers: m };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p, ...(key === 'Enter' ? { text: '\r' } : {}), ...extra });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(70);
  };
  // Digita como um teclado (keydown com texto → keypress → xterm).
  const digitar = async (s) => {
    for (const ch of s) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await dormir(40);
  };
  const comando = async (s) => { await digitar(s); await tecla('Enter'); };
  const BOT = { left: 1, right: 2, middle: 4 };
  const mouse = (type, x, y, o = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: o.button || 'none', buttons: o.buttons ?? 0, clickCount: o.clickCount || 0, modifiers: 0 });
  const clicar = async (p, botao = 'left', vezes = 1) => {
    await mouse('mouseMoved', p.x, p.y);
    for (let i = 1; i <= vezes; i++) {
      await mouse('mousePressed', p.x, p.y, { button: botao, buttons: BOT[botao], clickCount: i });
      await mouse('mouseReleased', p.x, p.y, { button: botao, buttons: 0, clickCount: i });
    }
    await dormir(120);
  };
  const arrastar = async (a, b) => {
    await mouse('mouseMoved', a.x, a.y);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10, { button: 'left', buttons: 1 }); await dormir(16); }
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    await dormir(150);
  };
  const foto = async (nome) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const tela = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

  // Espiões instalados antes de cada carga: o que vai pelo WebSocket e uma área de transferência falsa.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__env = [];
    const s = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { window.__env.push(JSON.parse(d)); } catch {} return s.call(this, d); };
    window.__copiado = null; window.__colar = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (t) => { window.__copiado = String(t); return Promise.resolve(); },
      readText: () => Promise.resolve(window.__colar),
    } });
  })();` });
  const AJ = `(() => {
    if (window.__t) return;
    const painel = () => document.getElementById('term-painel');
    window.__t = {
      est: () => OrbitTerminal.estado(),
      rows: () => { const r = document.querySelector('.term-vista:not([hidden]) .xterm-rows'); return r ? [...r.children].map((x) => x.textContent.replace(/\\u00a0/g, ' ')).join('\\n') : ''; },
      linhas: () => { const r = document.querySelector('.term-vista:not([hidden]) .xterm-rows'); return r ? r.children.length : 0; },
      alt: () => Math.round(painel().getBoundingClientRect().height),
      pt: (e, fx = 0.5, fy = 0.5) => { if (typeof e === 'string') e = document.querySelector(e); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) }; },
      abas: () => [...document.querySelectorAll('.term-aba')].map((a) => a.querySelector('.term-aba-nome').textContent + (a.classList.contains('ativa') ? '!' : '') + (a.classList.contains('ocupado') ? '*' : '') + (a.classList.contains('morto') ? '†' : '')),
      aba: (i) => document.querySelectorAll('.term-aba')[i],
      foco: () => { const a = document.activeElement; return a ? (a.className && typeof a.className === 'string' ? a.className.split(' ')[0] : a.tagName.toLowerCase()) : null; },
      menu: () => [...document.querySelectorAll('.term-menu > *')].map((x) => x.classList.contains('term-menu-sep') ? '—' : x.classList.contains('term-menu-tit') ? '#' + x.textContent : x.querySelector('.term-mi-rot').textContent),
      item: (rot) => [...document.querySelectorAll('.term-menu .term-mi')].find((x) => x.querySelector('.term-mi-rot').textContent === rot) || null,
      env: (f) => window.__env.filter(f || (() => true)),
      // Ponto na tela de um trecho de texto dentro das linhas do xterm (última ocorrência).
      ptTexto: (txt) => {
        const rows = [...document.querySelectorAll('.term-vista:not([hidden]) .xterm-rows > div')];
        for (let k = rows.length - 1; k >= 0; k--) {
          const w = document.createTreeWalker(rows[k], NodeFilter.SHOW_TEXT);
          let n, acc = '', nos = [];
          while ((n = w.nextNode())) { nos.push([n, acc.length]); acc += n.textContent; }
          const i = acc.lastIndexOf(txt);
          if (i < 0) continue;
          const alvo = i + 3;
          for (const [no, ini] of nos) if (alvo >= ini && alvo < ini + no.textContent.length) {
            const r = document.createRange(); r.setStart(no, alvo - ini); r.setEnd(no, alvo - ini + 1);
            const q = r.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
          }
        }
        return null;
      },
    };
  })()`;
  const abrirPagina = async () => {
    await cdp('Page.navigate', { url: URL_DEMO });
    await esperar(`document.readyState === 'complete' && !!window.OrbitTerminal`, 8000);
    await dormir(200);
    await av(AJ);
  };
  const conta = (txt) => `(__t.rows().split(${JSON.stringify(txt)}).length - 1)`;
  // Prompt do zsh/bash: uma linha que termina em %, $, # ou > (o tema do usuário pode mudar o resto).
  const PROMPT = WIN ? `/PS [A-Za-z]:\\\\[^\\n]*>/.test(__t.rows())` : `/[%$#>] *(\\n|$)/.test(__t.rows())`;

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await tela(1280, 800);
  await abrirPagina();

  // ── 1. Carga: conecta para o indicador, sem carregar o xterm, painel fechado ──
  conferir(await esperar(`__t.est().conexao === 'aberto'`, 6000), 'WebSocket conecta na carga da página', await av('__t.est()'));
  conferir(await av(`typeof window.Terminal === 'undefined' && !document.querySelector('script[src*="/terminal/vendor/"]')`), 'xterm não carrega antes de abrir (carga preguiçosa)');
  conferir(await av(`!__t.est().aberto && __t.alt() === 0 && getComputedStyle(document.getElementById('term-painel')).visibility === 'hidden'`), 'painel começa fechado e invisível');
  conferir(await av(`[...document.querySelectorAll('[data-terminal]')].every((b) => b.title === 'Terminal (Ctrl+\`)' && b.getAttribute('aria-pressed') === 'false' && b.querySelector('.term-ind'))`), 'botões da lateral: title, aria-pressed e indicador');

  // ── 2. Abrir pelo ícone, com animação; cria um terminal no shell padrão e foca ──
  const anim = await av(`(async () => {
    const p = document.getElementById('term-painel');
    document.querySelector('.nav-item[data-terminal]').click();
    await new Promise((r) => setTimeout(r, 70));
    const meio = { h: Math.round(p.getBoundingClientRect().height), animando: p.classList.contains('animando'), op: Number(getComputedStyle(p.querySelector('.term-casca')).opacity) };
    await new Promise((r) => setTimeout(r, 420));
    return { meio, fim: Math.round(p.getBoundingClientRect().height), animando: p.classList.contains('animando') };
  })()`);
  conferir(anim.meio.animando && anim.meio.h > 0 && anim.meio.h < anim.fim && anim.meio.op < 1 && !anim.animando && anim.fim === 300, 'abre pelo ícone com animação (altura e opacidade no meio, 300 px no fim)', anim);
  conferir(await esperar(`__t.est().terminais.length === 1 && !!document.querySelector('.term-vista:not([hidden]) .xterm')`, 8000), 'abrir sem terminal cria um no shell padrão', await av('__t.est()'));
  conferir(await esperar(PROMPT, 25000), (WIN ? 'PowerShell' : 'o shell padrão') + ' responde com o prompt', await av('__t.rows().slice(-300)'));
  conferir(await esperar(`__t.foco() === 'xterm-helper-textarea'`, 2000), 'foco no xterm depois de abrir', await av('__t.foco()'));
  conferir(await av(`document.querySelector('.nav-item[data-terminal]').getAttribute('aria-pressed') === 'true'`), 'aria-pressed acompanha o painel');
  const t1 = await av(`__t.est().terminais[0]`);
  conferir(t1 && t1.projeto === 'proj' && /proj$/i.test(t1.cwd || ''), 'novo abre na pasta do projeto atual', t1);
  conferir(await av(`getComputedStyle(document.querySelector('.term-vista .xterm-rows')).fontFamily.includes('Geist Mono')`), 'xterm com a Geist Mono');

  // ── 3. Comando e saída ──
  await comando('echo orbit-ok-123');
  conferir(await esperar(`${conta('orbit-ok-123')} >= 2`, 8000), 'digitar comando mostra a saída', await av('__t.rows().slice(-300)'));

  // ── 4. Vários terminais: + e Ctrl+Shift+` ──
  await clicar(await av(`__t.pt('.term-novo .term-btn:not(.estreito)')`));
  conferir(await esperar(`__t.est().terminais.length === 2 && __t.est().ativo === __t.est().terminais[1].id`, 8000), '+ cria outro terminal e o ativa', await av('__t.abas()'));
  await esperar(PROMPT, 25000);
  await tecla('`', { ctrl: true, shift: true });
  conferir(await esperar(`__t.est().terminais.length === 3`, 8000), 'Ctrl+Shift+` cria um terminal', await av('__t.abas()'));
  await esperar(PROMPT, 25000);
  const nomes = await av(`__t.est().terminais.map((t) => t.nome)`);
  conferir(new Set(nomes).size === 3, 'cada terminal tem nome próprio', nomes);

  // ── 5. Renomear no lugar (duplo clique) ──
  await clicar(await av(`__t.pt(__t.aba(1))`), 'left', 2);
  conferir(await esperar(`!!document.querySelector('.term-aba-ed') && document.activeElement === document.querySelector('.term-aba-ed')`, 2000), 'duplo clique abre o campo de nome na aba');
  await digitar('Servidor');
  await tecla('Enter');
  conferir(await esperar(`__t.est().terminais[1].nome === 'Servidor' && __t.abas()[1].startsWith('Servidor')`, 4000), 'renomear grava no servidor', await av('__t.abas()'));
  await esperar(`__t.foco() === 'xterm-helper-textarea'`, 1500);

  // ── 6. Fechar um terminal livre pelo × ──
  await clicar(await av(`__t.pt(__t.aba(2))`));
  await clicar(await av(`__t.pt(__t.aba(2).querySelector('.term-aba-x'))`));
  conferir(await esperar(`__t.est().terminais.length === 2 && document.querySelectorAll('.term-aba').length === 2`, 6000), '× fecha o terminal livre sem perguntar', await av('__t.abas()'));

  // ── 7. Processo longo com URL local: ocupado, indicador, chip, link ──
  await clicar(await av(`__t.pt(__t.aba(0))`));
  await esperar(`__t.foco() === 'xterm-helper-textarea'`, 1500);
  await comando(CMD_LONGO);
  conferir(await esperar(`__t.est().terminais[0].ocupado && __t.abas()[0].includes('*')`, 8000), 'comando longo marca a aba como rodando', await av('__t.est().terminais[0]'));
  conferir(await av(`[...document.querySelectorAll('[data-terminal]')].every((b) => b.classList.contains('term-rodando')) && document.querySelector('.nav-item .n').textContent === '1'`), 'indicador: ponto verde e número no item da lateral');
  conferir(await esperar(`!document.querySelector('.term-chip').hidden && document.querySelector('.term-chip-txt').textContent === 'localhost:5173'`, 6000), 'chip da URL local (0.0.0.0 vira localhost)', await av(`document.querySelector('.term-chip').outerHTML.slice(0, 200)`));
  await foto('01-terminal');
  await clicar(await av(`__t.pt('.term-chip')`));
  conferir(await av(`window.__urls.length === 1 && window.__urls[0] === 'http://localhost:5173/'`), 'chip abre no navegador interno (abrirUrl)', await av('window.__urls'));
  const pLink = await av(`__t.ptTexto('0.0.0.0:5173')`);
  if (pLink) { await mouse('mouseMoved', pLink.x, pLink.y); await dormir(350); await clicar(pLink); }
  conferir(await esperar(`window.__urls.length === 2 && window.__urls[1] === 'http://localhost:5173/'`, 2000), 'clique no link local do terminal chama abrirUrl', { pLink, urls: await av('window.__urls') });

  // ── 8. Minimizar com Ctrl+` (foco no terminal) sem perder o processo; reabrir pelo ícone ──
  await av(`document.querySelector('.term-vista:not([hidden]) .xterm-helper-textarea').focus()`);
  await tecla('`', { ctrl: true });
  conferir(await esperar(`!__t.est().aberto`, 1000), 'Ctrl+` com o foco no terminal minimiza');
  await dormir(400);
  conferir(await av(`__t.alt() === 0 && getComputedStyle(document.getElementById('term-painel')).visibility === 'hidden'`), 'painel some depois da animação');
  conferir(await av(`__t.est().terminais[0].ocupado && __t.est().terminais.length === 2 && document.querySelector('.nav-item').classList.contains('term-rodando')`), 'minimizado: processo segue rodando e o indicador continua', await av('__t.est()'));
  conferir(await av(`document.activeElement === document.body || !document.getElementById('term-painel').contains(document.activeElement)`), 'foco sai do painel ao minimizar');
  await clicar(await av(`__t.pt('.nav-item[data-terminal]')`));
  conferir(await esperar(`__t.est().aberto && __t.alt() === 300`, 1500), 'reabre pelo ícone', await av('__t.alt()'));
  conferir(await esperar(`__t.foco() === 'xterm-helper-textarea' && __t.est().terminais[0].ocupado`, 1500), 'reaberto com foco no terminal e o processo vivo');
  await tecla('`', { ctrl: true });
  await esperar(`!__t.est().aberto`, 1000);
  await dormir(350);
  await tecla('`', { ctrl: true });
  conferir(await esperar(`__t.est().aberto`, 1000), 'Ctrl+` fora do terminal abre de novo');
  await esperar(`__t.foco() === 'xterm-helper-textarea'`, 1500);

  // ── 9. Ctrl+C sem seleção manda ^C e para o processo ──
  await av(`window.__env.length = 0`);
  await tecla('c', { ctrl: true });
  conferir(await av(`__t.env((m) => m.t === 'entrada' && m.d === '\\u0003').length === 1`), 'Ctrl+C sem seleção manda ^C ao shell', await av('__t.env()'));
  conferir(await esperar(`!__t.est().terminais[0].ocupado && !document.querySelector('.nav-item').classList.contains('term-rodando') && document.querySelector('.nav-item .n').textContent === ''`, 8000), 'processo parado: indicador some (calmo)', await av('__t.est().terminais[0]'));
  conferir(await esperar(`document.querySelector('.term-chip').hidden`, 3000), 'chip some quando o comando acaba');

  // ── 10. Atalhos das abas não roubam teclas de dentro do xterm ──
  await av(`window.__env.length = 0`);
  await tecla('w', { ctrl: true });
  await tecla('Tab', { ctrl: true });
  conferir(await av(`window.__abas.fechou === 0 && window.__abas.ciclou === 0`), 'Ctrl+W e Ctrl+Tab no xterm não chegam às abas', await av('window.__abas'));
  conferir(await av(`__t.env((m) => m.t === 'entrada' && m.d === '\\u0017').length === 1 && __t.env((m) => m.t === 'entrada' && m.d === '\\t').length === 1`), 'Ctrl+W e Ctrl+Tab vão para o shell', await av('__t.env()'));
  await tecla('c', { ctrl: true });
  await esperar(PROMPT, 3000);

  // ── 11. Copiar: seleção + Ctrl+C copia (sem ^C); Ctrl+Shift+C; menu do botão direito ──
  await comando('echo copia-xyz');
  await esperar(`${conta('copia-xyz')} >= 2`, 6000);
  const pCorpo = await av(`__t.pt('.term-vista:not([hidden])', 0.5, 0.5)`);
  await clicar(pCorpo, 'right');
  const menuCorpo = await av('__t.menu()');
  conferir(JSON.stringify(menuCorpo) === JSON.stringify(['Copiar', 'Colar', 'Selecionar tudo', '—', 'Limpar']), 'botão direito abre o menu Copiar/Colar/Selecionar tudo/Limpar', menuCorpo);
  await clicar(await av(`__t.pt(__t.item('Selecionar tudo'))`));
  await av(`window.__env.length = 0`);
  await tecla('c', { ctrl: true });
  conferir(await av(`(window.__copiado || '').includes('copia-xyz') && __t.env((m) => m.t === 'entrada').length === 0`), 'Ctrl+C com seleção copia e não manda ^C', { copiado: (await av('window.__copiado') || '').slice(-80), env: await av('__t.env()') });
  conferir(await av(`!document.querySelector('.term-vista:not([hidden]) .xterm-selection div')`), 'a seleção é limpa depois de copiar');
  await av(`window.__copiado = null`);
  await clicar(pCorpo, 'right');
  await clicar(await av(`__t.pt(__t.item('Selecionar tudo'))`));
  await tecla('c', { ctrl: true, shift: true });
  conferir(await av(`(window.__copiado || '').includes('copia-xyz')`), 'Ctrl+Shift+C copia');

  // ── 12. Colar: Ctrl+V não manda ^V e deixa o navegador colar; evento de colar vira entrada; menu Colar ──
  await av(`window.__env.length = 0`);
  await tecla('v', { ctrl: true });
  conferir(await av(`__t.env((m) => m.t === 'entrada' && m.d === '\\u0016').length === 0`), 'Ctrl+V não vira ^V (o navegador cola)', await av('__t.env()'));
  await av(`(() => { const ta = document.querySelector('.term-vista:not([hidden]) .xterm-helper-textarea'); const dt = new DataTransfer(); dt.setData('text/plain', 'echo colado-789'); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await tecla('Enter');
  conferir(await esperar(`${conta('colado-789')} >= 2`, 6000), 'colar (evento paste do navegador) chega ao shell', await av('__t.env()'));
  await av(`window.__colar = 'echo menu-colou'`);
  await clicar(pCorpo, 'right');
  await clicar(await av(`__t.pt(__t.item('Colar'))`));
  await dormir(150);
  await tecla('Enter');
  conferir(await esperar(`${conta('menu-colou')} >= 2`, 6000), 'Colar do menu do botão direito', await av('__t.rows().slice(-200)'));

  // ── 13. Redimensionar: arrastar a alça, duplo clique maximiza/restaura, setas ──
  const linhasAntes = await av('__t.linhas()');
  await av(`window.__env.length = 0`);
  const pAlca = await av(`__t.pt('.term-alca')`);
  await arrastar(pAlca, { x: pAlca.x, y: pAlca.y - 120 });
  await dormir(200);
  conferir(Math.abs((await av('__t.alt()')) - 420) <= 2, 'arrastar a alça redimensiona', await av('__t.alt()'));
  conferir(await esperar(`__t.linhas() > ${linhasAntes} && __t.env((m) => m.t === 'tamanho').length >= 1`, 2000), 'xterm reajusta e manda o novo tamanho', { antes: linhasAntes, depois: await av('__t.linhas()'), env: await av('__t.env()') });
  await arrastar(await av(`__t.pt('.term-alca')`), { x: pAlca.x, y: 790 });
  conferir((await av('__t.alt()')) === 140, 'altura mínima de 140 px', await av('__t.alt()'));
  await clicar(await av(`__t.pt('.term-alca')`), 'left', 2);
  await dormir(350);
  const maxEsp = await av(`document.getElementById('rolar').clientHeight - 120`);
  conferir((await av('__t.alt()')) === maxEsp && (await av('__t.est().maximizado')), 'duplo clique na alça maximiza (main − 120)', { alt: await av('__t.alt()'), maxEsp });
  await clicar(await av(`__t.pt('.term-alca')`), 'left', 2);
  await dormir(350);
  conferir((await av('__t.alt()')) === 140 && !(await av('__t.est().maximizado')), 'duplo clique de novo restaura', await av('__t.alt()'));
  await av(`document.querySelector('.term-alca').focus()`);
  await tecla('ArrowUp');
  await tecla('ArrowUp', { shift: true });
  await dormir(350);
  conferir((await av('__t.alt()')) === 140 + 16 + 64, 'setas na alça ajustam a altura', await av('__t.alt()'));
  await clicar(await av(`__t.pt('.term-acoes .term-btn[aria-pressed]')`));
  await dormir(350);
  conferir((await av('__t.alt()')) === maxEsp, 'botão Maximizar');
  await clicar(await av(`__t.pt('.term-acoes .term-btn[aria-pressed]')`));
  await dormir(350);
  const altFinal = await av('__t.alt()');
  conferir(altFinal === 220, 'botão Restaurar', altFinal);

  // ── 14. Menu ▾: shells e "Abrir em:"; CMD; saída do shell e reinício com Enter ──
  await clicar(await av(`__t.pt('.term-btn.estreito')`));
  const menuNovo = await av('__t.menu()');
  // O segundo shell do menu: CMD no Windows; no Mac, o último antes do separador (bash, com o zsh como padrão).
  const SH2 = WIN ? { nome: 'Prompt de Comando', id: 'cmd' } : { nome: menuNovo[menuNovo.indexOf('—') - 1], id: menuNovo[menuNovo.indexOf('—') - 1] };
  const PROMPT2 = WIN ? `/[A-Z]:\\\\[^\\n]*>/.test(__t.rows())` : PROMPT;
  conferir((WIN || menuNovo.indexOf('—') >= 2) && menuNovo.includes(SH2.nome) && menuNovo.includes('#Abrir em:') && menuNovo.includes('proj') && menuNovo.includes('outro') && menuNovo.includes('Pasta pessoal'), 'menu ▾ com os shells e "Abrir em:"', menuNovo);
  await clicar(await av(`__t.pt(__t.item(${JSON.stringify(SH2.nome)}))`));
  conferir(await esperar(`__t.est().terminais.length === 3 && __t.est().terminais[2].shell === ${JSON.stringify(SH2.id)}`, 8000), `menu ▾ cria no shell escolhido (${WIN ? 'CMD' : SH2.nome})`, await av('__t.est().terminais'));
  await esperar(PROMPT2, 15000);
  await comando('exit');
  conferir(await esperar(`__t.rows().includes('Processo encerrado (código 0). Enter reinicia.') && __t.abas()[2].includes('†')`, 8000), 'shell que saiu: linha esmaecida e aba encerrada', { rows: (await av('__t.rows()')).slice(-200), abas: await av('__t.abas()') });
  await tecla('Enter');
  conferir(await esperar(`__t.est().terminais[2].vivo && !__t.abas()[2].includes('†')`, 8000), 'Enter reinicia o shell que saiu', await av('__t.est().terminais[2]'));
  await esperar(WIN ? `/[A-Z]:\\\\[^\\n]*>\\s*$/.test(__t.rows().trimEnd() + ' ')` : `/[%$#>]\\s*$/.test(__t.rows().trimEnd() + ' ')`, 8000);

  // ── 15. Reordenar arrastando a aba ──
  const antesOrdem = await av(`__t.est().terminais.map((t) => t.id)`);
  const a0 = await av(`__t.pt(__t.aba(0))`), a2 = await av(`__t.pt(__t.aba(2), 0.9)`);
  await arrastar(a0, { x: a2.x + 20, y: a2.y });
  await dormir(300);
  const depoisOrdem = await av(`__t.est().terminais.map((t) => t.id)`);
  conferir(depoisOrdem[2] === antesOrdem[0] && depoisOrdem.length === 3, 'arrastar a aba reordena', { antesOrdem, depoisOrdem });

  // ── 16. F5: painel, terminais, nomes, ordem e saída voltam ──
  const antesF5 = await av(`({ ids: __t.est().terminais.map((t) => t.id), nomes: __t.est().terminais.map((t) => t.nome), ativo: __t.est().ativo })`);
  await clicar(await av(`__t.pt(__t.aba(${depoisOrdem.indexOf(antesOrdem[0])}))`)); // o primeiro (com a saída do echo)
  const ativoF5 = await av('__t.est().ativo');
  await cdp('Page.reload', { ignoreCache: true });
  await esperar(`document.readyState === 'complete' && !!window.OrbitTerminal`, 8000);
  await av(AJ);
  conferir(await esperar(`__t.est().aberto && __t.alt() === ${altFinal}`, 3000), 'F5: painel volta aberto e na mesma altura', { est: await av('__t.est().aberto'), alt: await av('__t.alt()') });
  conferir(await esperar(`__t.est().terminais.length === 3 && JSON.stringify(__t.est().terminais.map((t) => t.id)) === ${JSON.stringify(JSON.stringify(antesF5.ids))}`, 8000), 'F5: os mesmos terminais, na mesma ordem', await av('__t.est().terminais.map((t) => t.id)'));
  conferir(await av(`JSON.stringify(__t.est().terminais.map((t) => t.nome)) === ${JSON.stringify(JSON.stringify(antesF5.nomes))} && __t.est().ativo === ${JSON.stringify(ativoF5)}`), 'F5: nomes e terminal ativo mantidos', await av('__t.est()'));
  await esperar(`${conta('menu-colou')} >= 2`, 8000);
  await dormir(300);
  conferir(await av(`__t.env((m) => m.t === 'entrada').length === 0`), 'F5: o replay não digita nada no shell (respostas automáticas suprimidas)', await av(`__t.env((m) => m.t === 'entrada')`));
  // O começo já rolou para o histórico: Selecionar tudo + Ctrl+Shift+C traz o buffer inteiro.
  await esperar(`${conta('menu-colou')} >= 2`, 8000);
  await av(`window.__copiado = null`);
  await clicar(await av(`__t.pt('.term-vista:not([hidden])', 0.5, 0.5)`), 'right');
  await clicar(await av(`__t.pt(__t.item('Selecionar tudo'))`));
  await tecla('c', { ctrl: true, shift: true });
  const buf = (await av('window.__copiado')) || '';
  conferir(buf.split('orbit-ok-123').length >= 3 && buf.split('colado-789').length >= 3, 'F5: a saída volta (replay, com o histórico)', buf.slice(-300));
  await av(`document.querySelector('.term-vista:not([hidden]) .xterm-helper-textarea').focus()`);
  await av(`document.querySelector('.term-vista:not([hidden]) .xterm-helper-textarea').focus()`);
  await comando('echo depois-do-f5');
  conferir(await esperar(`${conta('depois-do-f5')} >= 2`, 6000), 'F5: o terminal continua respondendo');

  // ── 17. Fechar um terminal ocupado pede confirmação no painel ──
  const idServ = await av(`__t.est().terminais.find((t) => t.nome === 'Servidor').id`);
  await clicar(await av(`__t.pt([...document.querySelectorAll('.term-aba')].find((a) => a.dataset.id === ${JSON.stringify(idServ)}))`));
  await esperar(`__t.foco() === 'xterm-helper-textarea'`, 1500);
  await comando(CMD_60);
  await esperar(`__t.est().terminais.find((t) => t.id === ${JSON.stringify(idServ)}).ocupado`, 6000);
  const xServ = await av(`__t.pt([...document.querySelectorAll('.term-aba')].find((a) => a.dataset.id === ${JSON.stringify(idServ)}).querySelector('.term-aba-x'))`);
  await clicar(xServ);
  conferir(await esperar(`!!document.querySelector('.term-conf') && document.querySelector('.term-conf-tit').textContent === 'Encerrar “Servidor”?'`, 1500), 'fechar terminal ocupado pede confirmação no painel');
  await clicar(await av(`__t.pt([...document.querySelectorAll('.term-conf .term-bt')].find((b) => b.textContent === 'Cancelar'))`));
  conferir(await av(`!document.querySelector('.term-conf') && __t.est().terminais.length === 3`), 'Cancelar mantém o terminal');
  await clicar(xServ);
  await esperar(`!!document.querySelector('.term-conf')`, 1500);
  await clicar(await av(`__t.pt([...document.querySelectorAll('.term-conf .term-bt')].find((b) => b.textContent === 'Encerrar'))`));
  conferir(await esperar(`__t.est().terminais.length === 2 && !__t.est().terminais.some((t) => t.id === ${JSON.stringify(idServ)})`, 8000), 'Encerrar fecha o terminal ocupado');

  // ── 18. Menu de botão direito na aba ──
  await clicar(await av(`__t.pt(__t.aba(0))`), 'right');
  const menuAba = await av('__t.menu()');
  conferir(JSON.stringify(menuAba) === JSON.stringify(['Renomear', 'Limpar', '—', 'Fechar']), 'menu da aba: Renomear, Limpar, Fechar (Reiniciar só se saiu)', menuAba);
  await tecla('Escape');
  conferir(await av(`!document.querySelector('.term-menu')`), 'Esc fecha o menu');

  // ── 19. 420 px: sem rolagem horizontal, painel na largura toda ──
  await tela(420, 800);
  await dormir(400);
  const estreito = await av(`({ sw: document.documentElement.scrollWidth, pw: Math.round(document.getElementById('term-painel').getBoundingClientRect().width), bw: document.querySelector('.term-barra').scrollWidth, bc: document.querySelector('.term-barra').clientWidth })`);
  conferir(estreito.sw <= 420 && estreito.pw === 420 && estreito.bw <= estreito.bc, '420 px sem rolagem horizontal, painel na largura toda', estreito);
  // As colunas do xterm cabem na vista (o fit acompanhou a largura nova).
  const cabe = await av(`(() => { const v = document.querySelector('.term-vista:not([hidden])'), s = v.querySelector('.xterm-screen'), r = v.querySelector('.xterm-rows > div'); const sp = document.createElement('span'); sp.textContent = 'W'.repeat(10); r.appendChild(sp); const cw = sp.getBoundingClientRect().width / 10; sp.remove(); return { tela: Math.round(s.getBoundingClientRect().right), vista: Math.round(v.getBoundingClientRect().right), cols: Math.round(s.getBoundingClientRect().width / cw), cw }; })()`);
  conferir(cabe.tela <= cabe.vista, 'xterm reajusta as colunas a 420 px', cabe);
  await foto('02-terminal-420');
  await tela(1280, 800);
  await dormir(200);

  // ── 20. Minimizar pelo botão ──
  const pMin = await av(`__t.pt('.term-acoes > .term-btn:last-child')`);
  const noPonto = await av(`(() => { const e = document.elementFromPoint(${pMin.x}, ${pMin.y}); return e ? e.className.baseVal ?? e.className : null; })()`);
  await clicar(pMin);
  conferir(await esperar(`!__t.est().aberto`, 1000), 'botão Minimizar fecha o painel', { pMin, noPonto, est: await av('__t.est().aberto') });
  await dormir(400);

  conferir(consoleErros.length === 0, 'console limpo', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  try { terminal.parar(); } catch {}
  const fechou = new Promise((r) => srv.close(r));
  srv.closeAllConnections?.();
  await Promise.race([fechou, dormir(3000)]);
}

for (const n of res.ok) console.log('  ok  ' + n);
for (const n of res.falhas) console.log('FALHA ' + n);
console.log(`\n${res.ok.length} ok / ${res.falhas.length} falhas`);
process.exit(res.falhas.length ? 1 : 0);
