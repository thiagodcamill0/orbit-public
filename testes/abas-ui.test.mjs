// Teste das abas e painéis (assets/abas.js + .css, rodada 9) contra testes/abas-demo.html (3 tipos falsos:
// vista única, arquivo, conversa com selo). Mouse e teclado reais via CDP (Input.dispatchMouseEvent/KeyEvent).
// Servidor estático próprio numa porta livre de 47822–47826 (só GET, só arquivos do projeto), Edge headless mudo,
// perfil na pasta de saída e fechado com fecharEdge no fim.
// node testes/abas-ui.test.mjs <pasta-de-saida>   (capturas 01 e 02 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-abas-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const PERFIL = path.join(SAIDA, 'edge');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Servidor estático mínimo (só leitura, só dentro do projeto).
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47825);
const srv = http.createServer((req, res2) => {
  if (req.method !== 'GET') { res2.writeHead(405); res2.end(); return; }
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const alvo = path.resolve(PROJ, '.' + rel);
  if (!alvo.startsWith(PROJ + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { res2.writeHead(404); res2.end(); return; }
  res2.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(alvo).pipe(res2);
});
await new Promise((r) => srv.listen(PORTA, '127.0.0.1', r));
const URL_DEMO = `http://127.0.0.1:${PORTA}/testes/abas-demo.html`;

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
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
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
  const VK = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13, Escape: 27, Delete: 46, Tab: 9, PageDown: 34, PageUp: 33, F10: 121, '\\': 220, w: 87, '1': 49, '2': 50 };
  const CODE = { '\\': 'Backslash', '1': 'Digit1', '2': 'Digit2' };
  const tecla = async (key, mods = {}) => {
    const m = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
    const letra = /^[a-z]$/.test(key);
    const p = { key: letra && mods.shift ? key.toUpperCase() : key, code: CODE[key] || (letra ? 'Key' + key.toUpperCase() : key), windowsVirtualKeyCode: VK[key] || 0, modifiers: m };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(70);
  };
  const BOT = { left: 1, right: 2, middle: 4 };
  const mouse = (type, x, y, o = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: o.button || 'none', buttons: o.buttons ?? 0, clickCount: o.clickCount || 0, modifiers: 0, ...(o.deltaY !== undefined ? { deltaX: 0, deltaY: o.deltaY } : {}) });
  const clicar = async (p, botao = 'left', vezes = 1) => {
    await mouse('mouseMoved', p.x, p.y);
    for (let i = 1; i <= vezes; i++) {
      await mouse('mousePressed', p.x, p.y, { button: botao, buttons: BOT[botao], clickCount: i });
      await mouse('mouseReleased', p.x, p.y, { button: botao, buttons: 0, clickCount: i });
    }
    await dormir(90);
  };
  // Arraste com passos; `meio(…)` roda com o botão ainda pressionado (para conferir indicador/zonas e Esc).
  const arrastar = async (a, b, meio) => {
    await mouse('mouseMoved', a.x, a.y);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    const N = 10;
    for (let i = 1; i <= N; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / N, a.y + (b.y - a.y) * i / N, { button: 'left', buttons: 1 }); await dormir(15); }
    let r;
    if (meio) r = await meio();
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    await dormir(120);
    return r;
  };
  const foto = async (nome) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const tela = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

  // Ajudas dentro da página.
  const AJ = `(() => {
    if (window.__t) return;
    const nome = (c) => c.split(/[:|/]/).pop();
    window.__t = {
      aba: (c) => [...document.querySelectorAll('.aba')].find((e) => nome(e.dataset.chave) === c) || null,
      lay: () => Abas.grupos().map((g) => g.abas.map((a) => nome(a.chave) + (a.previa ? '*' : '') + (a.id === g.ativa ? '!' : '')).join(' ')),
      pt: (e, fx = 0.5, fy = 0.5) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) }; },
      grupo: (i) => document.querySelectorAll('.abas-grupo')[i],
      larg: () => [...document.querySelectorAll('.abas-grupo')].map((g) => Math.round(g.getBoundingClientRect().width)),
      menu: () => [...document.querySelectorAll('.abas-menu > *')].map((x) => x.classList.contains('abas-menu-sep') ? '—' : x.querySelector('.abas-mi-rot').textContent + (x.getAttribute('aria-disabled') ? '(off)' : '')),
      item: (rot) => [...document.querySelectorAll('.abas-menu .abas-mi')].find((x) => x.querySelector('.abas-mi-rot').textContent === rot) || null,
      foco: () => { const a = document.activeElement; return a ? (a.classList.contains('aba') ? 'aba:' + nome(a.dataset.chave) : a.tagName.toLowerCase() + (a.className ? '.' + a.className.split(' ')[0] : '')) : null; },
    };
  })()`;
  const abrirPagina = async () => {
    await cdp('Page.navigate', { url: URL_DEMO });
    await esperar(`document.readyState === 'complete' && !!window.Abas`, 5000);
    await dormir(250);
    await av(AJ);
  };
  const lay = () => av(`__t.lay()`);
  const pt = (expr, fx, fy) => av(`__t.pt(${expr}${fx !== undefined ? ', ' + fx + ', ' + (fy ?? 0.5) : ''})`);
  const D = (k) => av(`JSON.parse(JSON.stringify(__demo.${k}))`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await tela(1280, 800);
  await abrirPagina();
  await av(`localStorage.clear()`);
  await abrirPagina();

  // ── 1. Estado vazio ──
  let r = await av(`({ txt: document.querySelector('.abas-vazio')?.textContent, barra: getComputedStyle(document.querySelector('.abas-barra')).display, n: Abas.abas().length })`);
  conferir(r.txt === 'Nenhuma aba aberta' && r.barra === 'none' && r.n === 0, 'vazio: "Nenhuma aba aberta" e sem barra', r);

  // ── 2. Abrir/ativar uma vista (clique real na lateral) ──
  await clicar(await pt(`document.querySelector('[data-vista="geral"]')`));
  r = await av(`(() => { const p = document.querySelector('.aba-painel:not([hidden])'); const cs = getComputedStyle(p);
    return { lay: __t.lay(), criar: __demo.criar.vista, focos: __demo.focos, ct: cs.containerType, cn: cs.containerName, bg: cs.backgroundImage.includes('radial-gradient'), ph: p.clientHeight, dv: p.querySelector('.dv').getBoundingClientRect().height,
      barra: document.querySelector('.abas-barra').getBoundingClientRect().height, role: p.getAttribute('role'), vazio: !!document.querySelector('.abas-vazio') }; })()`);
  conferir(igual(r.lay, ['geral!']) && r.criar === 1 && !r.vazio && r.focos.includes('vista:geral'), 'abrir vista: aba ativa, criar 1×, estado vazio sai', r);
  conferir(r.ct === 'inline-size' && r.cn === 'principal' && r.bg && r.role === 'tabpanel', 'painel: tabpanel com container principal e fundo pontilhado', r);
  conferir(r.ph > 600 && Math.abs(r.dv - r.ph) < 1 && r.barra === 35, 'painel com altura definida (height:100% funciona) e barra de 35 px', r);
  await clicar(await pt(`document.querySelector('[data-vista="geral"]')`));
  conferir(igual(await lay(), ['geral!']) && (await D('criar')).vista === 1, 'vista única: abrir de novo só ativa');

  // ── 3. Prévia: substituída no mesmo lugar e fixada por duplo clique ──
  await clicar(await pt(`document.querySelector('[data-arq="src/app.js"]')`));
  r = await av(`({ lay: __t.lay(), it: getComputedStyle(__t.aba('app.js').querySelector('.aba-tit')).fontStyle })`);
  conferir(igual(r.lay, ['geral app.js*!']) && r.it === 'italic', 'clique no arquivo abre prévia em itálico', r);
  await clicar(await pt(`document.querySelector('[data-arq="src/estilo.css"]')`));
  r = await av(`({ lay: __t.lay(), c: __demo.criar.arquivo, d: __demo.destruir })`);
  conferir(igual(r.lay, ['geral estilo.css*!']) && r.c === 2 && r.d === 1, 'outra prévia substitui a primeira (destrói a antiga)', r);
  await clicar(await pt(`__t.aba('estilo.css')`), 'left', 2);
  r = await av(`({ lay: __t.lay(), it: getComputedStyle(__t.aba('estilo.css').querySelector('.aba-tit')).fontStyle })`);
  conferir(igual(r.lay, ['geral estilo.css!']) && r.it === 'normal', 'duplo clique na aba fixa a prévia', r);
  await clicar(await pt(`document.querySelector('[data-arq="LEIAME.md"]')`), 'left', 2);
  conferir(igual(await lay(), ['geral estilo.css LEIAME.md!']), 'duplo clique na lateral (abrir previa:false) abre fixa', await lay());
  await av(`__demo.arq('dados/config.json', true)`);
  await av(`__demo.arq('dados/config.json', false)`);
  conferir(igual(await lay(), ['geral estilo.css LEIAME.md config.json!']), 'abrir com previa:false fixa a prévia existente', await lay());

  // ── 4. Conversa: focar() do provedor ──
  await clicar(await pt(`document.querySelector('[data-conv="s1"]')`));
  r = await av(`({ lay: __t.lay(), foco: __t.foco() })`);
  conferir(r.lay[0].endsWith('s1!') && r.foco === 'textarea', 'abrir conversa leva o foco ao conteúdo (focar)', r);

  // ── 5. Esconder/mostrar com rolagem guardada ──
  await clicar(await pt(`__t.aba('estilo.css')`));
  await av(`(() => { const p = document.getElementById(__t.aba('estilo.css').getAttribute('aria-controls')); p.scrollTop = 400; })()`);
  const e0 = await D('esconder'), m0 = await D('mostrar');
  await clicar(await pt(`__t.aba('geral')`));
  r = await av(`({ esc: __demo.esconder, hid: document.getElementById(__t.aba('estilo.css').getAttribute('aria-controls')).hidden, sel: __t.aba('estilo.css').getAttribute('aria-selected') })`);
  conferir(r.esc === e0 + 1 && r.hid && r.sel === 'false', 'trocar de aba chama esconder() e esconde o painel', r);
  await clicar(await pt(`__t.aba('estilo.css')`));
  await dormir(60);
  r = await av(`({ mos: __demo.mostrar, st: document.getElementById(__t.aba('estilo.css').getAttribute('aria-controls')).scrollTop })`);
  conferir(r.mos === m0 + 2 && Math.abs(r.st - 400) < 2, 'voltar chama mostrar() e restaura a rolagem (geral e estilo.css: 2 mostrar)', r);

  // ── 6. × e clique do meio ──
  await mouse('mouseMoved', ...Object.values(await pt(`__t.aba('LEIAME.md')`)));
  await dormir(80);
  r = await av(`({ vis: getComputedStyle(__t.aba('LEIAME.md').querySelector('.aba-x')).visibility, out: getComputedStyle(__t.aba('geral').querySelector('.aba-x')).visibility, at: getComputedStyle(__t.aba('estilo.css').querySelector('.aba-x')).visibility })`);
  conferir(r.vis === 'visible' && r.out === 'hidden' && r.at === 'visible', '× visível na ativa e no hover, escondido nas outras', r);
  let d0 = await D('destruir');
  await clicar(await pt(`__t.aba('LEIAME.md').querySelector('.aba-x')`));
  conferir(!(await lay())[0].includes('LEIAME') && (await D('destruir')) === d0 + 1, '× fecha a aba e destrói a instância', await lay());
  await clicar(await pt(`__t.aba('geral')`), 'middle');
  r = await av(`({ lay: __t.lay(), prev: __demo.meioPrevenido })`);
  conferir(!r.lay[0].includes('geral') && igual(r.prev, [true]), 'clique do meio fecha (mousedown do meio com preventDefault)', r);

  // ── 7. Ctrl+W / Alt+W (inclusive com foco num campo de texto) ──
  conferir(igual(await lay(), ['estilo.css! config.json s1']), 'estado antes dos atalhos', await lay());
  await clicar(await pt(`__t.aba('s1')`));
  r = await av(`__t.foco()`);
  await tecla('w', { ctrl: true });
  conferir(r === 'textarea' && igual(await lay(), ['estilo.css! config.json']), 'Ctrl+W com foco no textarea fecha a aba ativa (volta à usada antes)', { foco: r, lay: await lay() });
  await tecla('w', { alt: true });
  conferir(igual(await lay(), ['config.json!']), 'Alt+W fecha a aba ativa', await lay());

  // ── 8. Ctrl+Tab / Ctrl+Shift+Tab / Alt+PageDown/PageUp (com volta) ──
  await av(`__demo.arq('src/app.js', false); __demo.arq('LEIAME.md', false); __demo.vista('historico')`);
  conferir(igual(await lay(), ['config.json app.js LEIAME.md historico!']), 'abrir insere à direita da ativa', await lay());
  await tecla('Tab', { ctrl: true });
  const a1 = await lay();
  await tecla('Tab', { ctrl: true, shift: true });
  const a2 = await lay();
  await tecla('PageUp', { alt: true });
  const a3 = await lay();
  await tecla('PageDown', { alt: true });
  const a4 = await lay();
  conferir(igual(a1, ['config.json! app.js LEIAME.md historico']) && igual(a2, ['config.json app.js LEIAME.md historico!']) && igual(a3, ['config.json app.js LEIAME.md! historico']) && igual(a4, a2),
    'Ctrl+Tab/Ctrl+Shift+Tab e Alt+PageDown/PageUp alternam com volta', { a1, a2, a3, a4 });

  // ── 9. Menu de botão direito ──
  await clicar(await pt(`__t.aba('app.js')`), 'right');
  r = await av(`({ itens: __t.menu(), foco: document.activeElement.classList.contains('abas-mi'), role: document.querySelector('.abas-menu').getAttribute('role') })`);
  conferir(igual(r.itens, ['Fechar', 'Fechar outras', 'Fechar à direita', 'Fechar todas', '—', 'Copiar caminho', '—', 'Dividir à direita', 'Dividir à esquerda', 'Dividir para baixo']) && r.foco && r.role === 'menu',
    'menu da aba: itens na ordem, foco no 1º', r);
  await clicar(await pt(`__t.item('Fechar à direita')`));
  conferir(igual(await lay(), ['config.json app.js!']) && !(await av(`!!document.querySelector('.abas-menu')`)), 'menu: Fechar à direita', await lay());
  await av(`window.__copiado = []; navigator.clipboard.writeText = (t) => { __copiado.push(t); return Promise.resolve(); }`);
  await clicar(await pt(`__t.aba('app.js')`), 'right');
  await clicar(await pt(`__t.item('Copiar caminho')`));
  await dormir(80);
  r = await av(`({ c: __copiado, t: __demo.toasts.slice(-1)[0] })`);
  conferir(igual(r.c, ['D:\\Projetos\\Gerenciador\\src\\app.js']) && r.t === 'Caminho copiado', 'menu: Copiar caminho (writeText + toast)', r);
  await clicar(await pt(`__t.aba('config.json')`), 'right');
  await tecla('ArrowDown'); await tecla('Enter');
  conferir(igual(await lay(), ['config.json!']), 'menu pelo teclado: ↓ + Enter em Fechar outras', await lay());
  await av(`__demo.arq('src/app.js', true)`);
  await clicar(await pt(`__t.aba('app.js')`), 'right');
  r = await av(`__t.menu()`);
  await tecla('Escape');
  const fEsc = await av(`({ m: !!document.querySelector('.abas-menu'), f: __t.foco() })`);
  conferir(r.includes('Fixar aba') && !fEsc.m && fEsc.f === 'aba:app.js', 'menu da prévia tem Fixar aba; Esc fecha e devolve o foco à aba', { r, fEsc });
  await clicar(await pt(`__t.aba('app.js')`), 'right');
  await clicar(await pt(`__t.item('Fechar')`));
  conferir(igual(await lay(), ['config.json!']), 'menu: Fechar', await lay());
  await av(`__demo.arq('src/app.js', false); __demo.arq('LEIAME.md', false)`);
  d0 = await D('destruir');
  await clicar(await pt(`__t.aba('app.js')`), 'right');
  await clicar(await pt(`__t.item('Fechar todas')`));
  r = await av(`({ n: Abas.abas().length, d: __demo.destruir, vazio: !!document.querySelector('.abas-vazio') })`);
  conferir(r.n === 0 && r.d === d0 + 3 && r.vazio, 'menu: Fechar todas (3 destruídas, volta o vazio)', r);

  // ── 10. Reordenar arrastando na barra; Esc cancela ──
  await av(`__demo.arq('src/app.js', false); __demo.arq('src/estilo.css', false); __demo.arq('LEIAME.md', false)`);
  const c0 = (await D('criar')).arquivo;
  r = await arrastar(await pt(`__t.aba('app.js')`), await pt(`__t.aba('LEIAME.md')`, 0.8, 0.5), () => av(`({ ins: !!document.querySelector('.abas-ins.on'), fant: !!document.querySelector('.abas-fantasma') })`));
  r = { ...r, lay: await lay(), fant2: await av(`!!document.querySelector('.abas-fantasma')`), c: (await D('criar')).arquivo };
  conferir(igual(r.lay, ['estilo.css LEIAME.md app.js!']) && r.ins && r.fant && !r.fant2 && r.c === c0, 'arrastar na barra reordena (indicador de inserção, sem recriar)', r);
  r = await arrastar(await pt(`__t.aba('estilo.css')`), await pt(`__t.aba('app.js')`, 0.8, 0.5), async () => { await tecla('Escape'); return av(`!!document.querySelector('.abas-fantasma, .abas-ins.on')`); });
  conferir(r === false && igual(await lay(), ['estilo.css! LEIAME.md app.js']), 'Esc cancela o arraste', { r, lay: await lay() });
  // abaixo do limiar de 4 px não arrasta
  await arrastar(await pt(`__t.aba('LEIAME.md')`), { ...(await pt(`__t.aba('LEIAME.md')`)), x: (await pt(`__t.aba('LEIAME.md')`)).x + 3 });
  conferir(igual(await lay(), ['estilo.css LEIAME.md! app.js']), 'movimento < 4 px é clique (ativa, não move)', await lay());

  // ── 11. Arrastar para a borda direita cria painel; para o centro de outro grupo move ──
  const d1 = await D('destruir');
  r = await arrastar(await pt(`__t.aba('LEIAME.md')`), await pt(`__t.grupo(0).querySelector('.abas-corpo')`, 0.92, 0.5), () => av(`!!document.querySelector('.abas-zona.on.direita')`));
  r = { zona: r, lay: await lay(), c: (await D('criar')).arquivo, d: await D('destruir'), foco: await av(`Abas.grupos().map((g) => g.foco)`) };
  conferir(igual(r.lay, ['estilo.css! app.js', 'LEIAME.md!']) && r.zona && r.c === c0 && r.d === d1 && igual(r.foco, [false, true]), 'arrastar para a borda direita divide (move a instância, sem recriar)', r);
  r = await arrastar(await pt(`__t.aba('app.js')`), await pt(`__t.grupo(1).querySelector('.abas-corpo')`, 0.5, 0.5), () => av(`!!document.querySelector('.abas-zona.on.centro')`));
  conferir(r && igual(await lay(), ['estilo.css!', 'LEIAME.md app.js!']), 'arrastar para o centro de outro grupo move para ele', await lay());
  await arrastar(await pt(`__t.aba('estilo.css')`), await pt(`__t.grupo(1).querySelector('.abas-lista')`, 0.95, 0.5));
  r = await av(`({ lay: __t.lay(), g: Abas.grupos().length, t: Abas.grupos()[0].tamanho, sep: document.querySelectorAll('.abas-div').length })`);
  conferir(igual(r.lay, ['LEIAME.md app.js estilo.css!']) && r.g === 1 && Math.abs(r.t - 1) < 1e-9 && r.sep === 0, 'arrastar a última aba de um grupo para a barra de outro: grupo vazio fecha', r);
  r = await arrastar(await pt(`__t.aba('app.js')`), await pt(`__t.grupo(0).querySelector('.abas-corpo')`, 0.05, 0.5));
  conferir(igual(await lay(), ['app.js!', 'LEIAME.md estilo.css!']), 'arrastar para a borda esquerda divide à esquerda', await lay());

  // ── 12. Divisória ──
  let w0 = await av(`__t.larg()`);
  const sep = await pt(`document.querySelector('.abas-div')`);
  await arrastar(sep, { x: sep.x + 200, y: sep.y });
  let w1 = await av(`__t.larg()`);
  await arrastar({ x: sep.x + 200, y: sep.y }, { x: 1270, y: sep.y });
  let w2 = await av(`__t.larg()`);
  conferir(Math.abs(w1[0] - w0[0] - 200) <= 2 && w2[1] >= 239 && w2[1] <= 242, 'divisória: arrastar redimensiona, mínimo 240 px', { w0, w1, w2 });
  await clicar(await pt(`document.querySelector('.abas-div')`), 'left', 2);
  w1 = await av(`__t.larg()`);
  conferir(Math.abs(w1[0] - w1[1]) <= 2, 'divisória: duplo clique iguala', w1);
  await av(`document.querySelector('.abas-div').focus()`);
  await tecla('ArrowRight');
  r = await av(`({ t: Abas.grupos().map((g) => +g.tamanho.toFixed(3)), role: document.querySelector('.abas-div').getAttribute('role'), v: document.querySelector('.abas-div').getAttribute('aria-valuenow') })`);
  conferir(igual(r.t, [0.55, 0.45]) && r.role === 'separator' && r.v === '55', 'divisória: seta → ajusta 5% (role=separator)', r);

  // ── 13. Ctrl+\ divide; Ctrl+1/2 focam; vista única move em vez de copiar ──
  await clicar(await pt(`__t.aba('app.js')`));
  const c1 = (await D('criar')).arquivo;
  await tecla('\\', { ctrl: true });
  r = await av(`({ lay: __t.lay(), c: __demo.criar.arquivo, f: Abas.grupos().map((g) => g.foco) })`);
  conferir(igual(r.lay, ['app.js!', 'app.js!', 'LEIAME.md estilo.css!']) && r.c === c1 + 1 && igual(r.f, [false, true, false]), 'Ctrl+\\ divide à direita (arquivo: cópia nova)', r);
  await tecla('1', { ctrl: true });
  const f1 = await av(`Abas.grupos().map((g) => g.foco)`);
  await tecla('2', { ctrl: true });
  const f2 = await av(`Abas.grupos().map((g) => g.foco)`);
  conferir(igual(f1, [true, false, false]) && igual(f2, [false, true, false]), 'Ctrl+1/Ctrl+2 focam o grupo', { f1, f2 });
  await av(`Abas.fechar(Abas.grupos()[1].abas[0].id)`);
  await av(`Abas.ativar(Abas.grupos()[0].abas[0].id); __demo.vista('geral')`);
  await av(`Abas.dividir(Abas.porChave('vista:geral').id, 'direita')`);
  r = await av(`({ lay: __t.lay(), n: Abas.abas().filter((a) => a.chave === 'vista:geral').length, cv: __demo.criar.vista })`);
  conferir(igual(r.lay, ['app.js!', 'geral!', 'LEIAME.md estilo.css!']) && r.n === 1, 'dividir uma vista única move (uma por chave no layout)', r);
  await av(`__demo.vista('geral')`);
  conferir(igual(await lay(), ['app.js!', 'geral!', 'LEIAME.md estilo.css!']), 'abrir vista única já aberta em outro grupo só ativa lá', await lay());

  // ── 14. Selo ──
  await av(`__demo.conv('s2', { grupo: Abas.grupos()[0].id }); __demo.conv('s3', { grupo: Abas.grupos()[0].id }); Abas.ativar(Abas.porChave('arquivo:Gerenciador|src/app.js').id)`);
  await av(`Abas.marcar(Abas.porChave('conversa:s2').id, 'novo'); Abas.marcar(Abas.porChave('conversa:s3').id, 'atencao')`);
  await mouse('mouseMoved', 640, 500); await dormir(60);
  r = await av(`(() => { const s = (c) => { const a = __t.aba(c); return { d: getComputedStyle(a.querySelector('.aba-selo')).display, cor: getComputedStyle(a.querySelector('.aba-selo')).backgroundColor, x: getComputedStyle(a.querySelector('.aba-x')).visibility, w: a.querySelector('.aba-selo').getBoundingClientRect().width }; };
    return { s2: s('s2'), s3: s('s3'), lbl: __t.aba('s2').getAttribute('aria-label') }; })()`);
  conferir(r.s2.d === 'block' && r.s2.cor === 'rgb(99, 102, 241)' && r.s2.x === 'hidden' && r.s2.w === 8 && r.s3.cor === 'rgb(245, 165, 36)', 'selo: ponto de 8 px no acento (novo) e âmbar (atenção) no lugar do ×', r);
  await mouse('mouseMoved', ...Object.values(await pt(`__t.aba('s2')`))); await dormir(80);
  r = await av(`({ d: getComputedStyle(__t.aba('s2').querySelector('.aba-selo')).display, x: getComputedStyle(__t.aba('s2').querySelector('.aba-x')).visibility })`);
  conferir(r.d === 'none' && r.x === 'visible', 'selo: no hover volta o ×', r);
  await mouse('mouseMoved', 640, 500);
  await foto('01-abas-1280');

  // ── 15. Teclado na barra (a11y) ──
  r = await av(`(() => { const tabs = [...document.querySelectorAll('[role=tab]')]; const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    return { tl: document.querySelectorAll('[role=tablist]').length, ctl: tabs.every((t) => document.getElementById(t.getAttribute('aria-controls'))?.getAttribute('role') === 'tabpanel'),
      sel: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, dup: ids.length - new Set(ids).size, pref: [...document.querySelectorAll('.abas-raiz [id]')].every((e) => e.id.startsWith('aba-')) }; })()`);
  conferir(r.tl === 3 && r.ctl && r.sel === 3 && r.dup === 0 && r.pref, 'a11y: tablist/tab/tabpanel, aria-controls válidos, ids únicos com prefixo aba-', r);
  await av(`__t.aba('app.js').focus()`);
  await tecla('ArrowRight');
  const k1 = await av(`__t.foco()`);
  await tecla('ArrowRight');
  const k2 = await av(`__t.foco()`);
  await tecla('Enter');
  const k3 = await lay();
  conferir(k1 === 'aba:s2' && k2 === 'aba:s3' && k3[0] === 'app.js s2 s3!', 'a11y: setas movem o foco entre abas, Enter ativa', { k1, k2, k3 });
  await av(`__t.aba('s2').focus()`);
  await tecla('Delete');
  r = { lay: await lay(), f: await av(`__t.foco()`) };
  conferir(r.lay[0] === 'app.js s3!' && r.f === 'aba:s3', 'a11y: Delete fecha a aba com foco', r);
  await av(`__t.aba('s3').focus()`);
  await tecla('F10', { shift: true });
  r = await av(`({ m: __t.menu().length, f: document.activeElement.classList.contains('abas-mi') })`);
  await tecla('Escape');
  conferir(r.m > 5 && r.f && !(await av(`!!document.querySelector('.abas-menu')`)), 'a11y: Shift+F10 abre o menu da aba', r);

  // ── 16. Atalhos desligados com modal (bloqueado) ──
  await av(`__demo.modal = true`);
  const antes = await lay();
  await tecla('w', { alt: true });
  await tecla('PageDown', { alt: true });
  const depois = await lay();
  await av(`__demo.modal = false`);
  conferir(igual(antes, depois), 'bloqueado(): atalhos não agem', { antes, depois });

  // ── 17. Rolagem horizontal da barra com muitas abas ──
  for (const c of ['a1.js', 'a2.js', 'a3.js', 'a4.js', 'a5.js', 'a6.js', 'a7.js', 'a8.js']) await av(`__demo.arq('x/${c}', false, { grupo: Abas.grupos()[2].id, focar: false })`);
  r = await av(`(() => { const l = __t.grupo(2).querySelector('.abas-lista'); const at = __t.grupo(2).querySelector('.aba.ativa').getBoundingClientRect(); const rl = l.getBoundingClientRect();
    return { sw: l.scrollWidth, cw: l.clientWidth, vis: at.left >= rl.left - 1 && at.right <= rl.right + 1, sl: l.scrollLeft }; })()`);
  const pl = await pt(`__t.grupo(2).querySelector('.abas-lista')`);
  await mouse('mouseWheel', pl.x, pl.y, { deltaY: -200 }); await dormir(150);
  const sl2 = await av(`__t.grupo(2).querySelector('.abas-lista').scrollLeft`);
  conferir(r.sw > r.cw && r.vis && sl2 < r.sl, 'excesso de abas: barra rola na horizontal, ativa à vista, roda rola de lado', { ...r, sl2 });

  // ── 18. Persistência e criação preguiçosa ──
  const est0 = await av(`Abas.estado()`);
  const lay0 = await lay();
  await abrirPagina();
  r = await av(`({ lay: __t.lay(), criar: __demo.criar, foco: Abas.grupos().map((g) => g.foco), est: Abas.estado() })`);
  conferir(igual(r.lay, lay0) && igual(r.est.grupos.map((g) => g.abas), est0.grupos.map((g) => g.abas)) && r.est.foco === est0.foco, 'F5: grupos, abas, ativas, prévias e foco restaurados', { lay0, lay: r.lay });
  conferir(r.criar.arquivo + r.criar.vista + r.criar.conversa === 3, 'F5: só a ativa de cada grupo é criada (preguiçosa)', r.criar);
  await clicar(await pt(`__t.aba('app.js')`));
  conferir((await D('criar')).arquivo === r.criar.arquivo + 1, 'aba restaurada é criada ao ser ativada a 1ª vez', await D('criar'));
  await av(`(() => { const e = JSON.parse(localStorage.getItem('gi.abas')); e.grupos[0].abas.push({ tipo: 'xyz', chave: 'xyz:1', dados: null, previa: false }); localStorage.setItem('gi.abas', JSON.stringify(e)); })()`);
  await abrirPagina();
  r = await av(`({ n: Abas.abas().filter((a) => a.tipo === 'xyz').length, g: Abas.grupos().length })`);
  conferir(r.n === 0 && r.g === 3, 'F5: aba de tipo desconhecido sai', r);

  // ── 19. Fechar o último de um grupo pelo ×: grupo fecha, tamanho vai ao vizinho ──
  await av(`Abas.fecharTodas(Abas.grupos()[2].id)`);
  r = await av(`({ g: Abas.grupos().length, soma: Abas.grupos().reduce((t, g) => t + g.tamanho, 0) })`);
  await clicar(await pt(`__t.grupo(1).querySelector('.aba.ativa .aba-x')`));
  const r2 = await av(`({ lay: __t.lay(), g: Abas.grupos().length, t: Abas.grupos()[0].tamanho })`);
  conferir(r.g === 2 && Math.abs(r.soma - 1) < 1e-9 && r2.g === 1 && Math.abs(r2.t - 1) < 1e-9, 'grupo que fica vazio fecha e o tamanho vai para o vizinho', { r, r2 });

  // ── 20. 420 px ──
  await av(`__demo.arq('src/estilo.css', false); __demo.arq('LEIAME.md', false); Abas.dividir(Abas.ativa().id, 'direita')`);
  await tela(420, 760);
  await dormir(200);
  r = await av(`({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, g: Abas.grupos().length, rw: document.querySelector('.abas-raiz').scrollWidth, rc: document.querySelector('.abas-raiz').clientWidth })`);
  conferir(r.sw <= 420 && r.bw <= 420 && r.g === 2 && r.rw <= r.rc, '420 px com 2 painéis: sem rolagem horizontal da página', r);
  await clicar(await pt(`__t.grupo(0).querySelector('.aba.ativa')`), 'right');
  r = await av(`(() => { const m = document.querySelector('.abas-menu').getBoundingClientRect(); return { l: m.left, r: m.right, sw: document.documentElement.scrollWidth }; })()`);
  conferir(r.l >= 0 && r.r <= 420 && r.sw <= 420, '420 px: menu cabe na tela', r);
  await foto('02-abas-420-menu');
  await tecla('Escape');
  await tela(1280, 800);

  // ── 21. Grade: dividir para baixo/cima e combinar com as divisões laterais ──
  await av(`Abas.fecharTodas(); __demo.arq('g/um.js', false); __demo.arq('g/dois.js', false); __demo.arq('g/tres.js', false)`);
  await dormir(150);
  const caixas = () => av(`[...document.querySelectorAll('.abas-grupo')].map((g) => { const r = g.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })`);
  const arvore = () => av(`JSON.stringify(Abas.estado().arvore)`);
  const cG = (await D('criar')).arquivo;
  r = await arrastar(await pt(`__t.aba('dois.js')`), await pt(`__t.grupo(0).querySelector('.abas-corpo')`, 0.5, 0.93), () => av(`!!document.querySelector('.abas-zona.on.baixo')`));
  let cx = await caixas();
  conferir(r && igual(await lay(), ['um.js tres.js!', 'dois.js!']) && cx.length === 2 && cx[0][0] === cx[1][0] && cx[0][2] === cx[1][2] && cx[1][1] >= cx[0][1] + cx[0][3] && (await D('criar')).arquivo === cG,
    'arrastar para a borda de baixo cria painel embaixo (zona "baixo", sem recriar a instância)', { r, cx, lay: await lay() });
  r = await av(`(() => { const d = document.querySelector('.abas-div'); const cs = getComputedStyle(d); return { deitada: d.classList.contains('deitada'), o: d.getAttribute('aria-orientation'), cur: cs.cursor, h: d.getBoundingClientRect().height }; })()`);
  conferir(r.deitada && r.o === 'horizontal' && r.cur === 'row-resize' && r.h === 1, 'divisória deitada: 1 px, row-resize, aria-orientation horizontal', r);
  r = await arrastar(await pt(`__t.aba('tres.js')`), await pt(`__t.grupo(1).querySelector('.abas-corpo')`, 0.93, 0.5), () => av(`!!document.querySelector('.abas-zona.on.direita')`));
  cx = await caixas();
  conferir(r && igual(await lay(), ['um.js!', 'dois.js!', 'tres.js!']) && await arvore() === '{"d":"coluna","t":1,"f":[{"g":0},{"d":"linha","t":0.5,"f":[{"g":1},{"g":2}]}]}'
    && cx[1][1] === cx[2][1] && cx[2][0] > cx[1][0] && cx[0][2] === cx[1][2] + cx[2][2] + 1, 'grade: painel de baixo dividido ao lado (árvore coluna › linha)', { cx, arv: await arvore() });
  // Arrastar a divisória deitada redimensiona as alturas; respeita a altura mínima.
  const sepH = await pt(`document.querySelector('.abas-div.deitada')`, 0.25, 0.5);
  const h0 = await caixas();
  await arrastar(sepH, { x: sepH.x, y: sepH.y + 100 });
  const h1 = await caixas();
  await arrastar({ x: sepH.x, y: sepH.y + 100 }, { x: sepH.x, y: 790 });
  const h2 = await caixas();
  conferir(Math.abs(h1[0][3] - h0[0][3] - 100) <= 2 && h1[1][3] === h1[2][3] && h2[1][3] >= 138 && h2[1][3] <= 142, 'divisória deitada: arrastar muda a altura, mínimo 140 px', { h0, h1, h2 });
  await clicar(await pt(`document.querySelector('.abas-div.deitada')`, 0.25, 0.5), 'left', 2);
  cx = await caixas();
  conferir(Math.abs(cx[0][3] - cx[1][3]) <= 2, 'divisória deitada: duplo clique iguala', cx);
  await mouse('mouseMoved', 640, 200); await dormir(400);
  const pD = await pt(`document.querySelector('.abas-div.deitada')`, 0.25, 0.5);
  await mouse('mouseMoved', pD.x, pD.y); await dormir(450);
  r = await av(`+getComputedStyle(document.querySelector('.abas-div.deitada'), '::before').opacity`);
  await mouse('mouseMoved', 640, 200); await dormir(400);
  const rFora = await av(`+getComputedStyle(document.querySelector('.abas-div.deitada'), '::before').opacity`);
  conferir(r > 0.3 && r < 0.7 && rFora === 0, 'divisória deitada: traço discreto só no hover', { r, rFora });
  await av(`document.querySelector('.abas-div.deitada').focus()`);
  await tecla('ArrowDown');
  r = await av(`({ t: [+Abas.grupos()[0].tamanho.toFixed(3), +Abas.estado().arvore.f[1].t.toFixed(3)], v: document.querySelector('.abas-div.deitada').getAttribute('aria-valuenow') })`);
  conferir(igual(r.t, [0.55, 0.45]) && r.v === '55', 'divisória deitada: seta ↓ ajusta 5%', r);
  // Menu da aba: Dividir para baixo.
  await clicar(await pt(`__t.aba('um.js')`), 'right');
  await clicar(await pt(`__t.item('Dividir para baixo')`));
  r = { lay: await lay(), arv: await arvore(), f: await av(`Abas.grupos().map((g) => g.foco)`) };
  conferir(igual(r.lay, ['um.js!', 'um.js!', 'dois.js!', 'tres.js!']) && /^\{"d":"coluna","t":1,"f":\[\{"g":0\},\{"g":1\},\{"d":"linha"/.test(r.arv) && igual(r.f, [false, true, false, false]),
    'menu: Dividir para baixo cria painel embaixo com a cópia, focado', r);
  // F5: a grade volta igual.
  const cx0 = await caixas(), arv0 = await arvore();
  await abrirPagina();
  conferir(await arvore() === arv0 && igual(await caixas(), cx0), 'F5: grade (linhas, colunas e tamanhos) restaurada', { arv0, arv: await arvore(), cx0, cx: await caixas() });
  // Fechar painéis desfaz a grade sem sobras.
  await av(`Abas.fecharTodas(Abas.grupos()[1].id)`);
  await av(`Abas.fecharTodas(Abas.grupos()[2].id)`);
  r = { arv: await arvore(), cx: await caixas(), seps: await av(`[...document.querySelectorAll('.abas-div')].map((d) => d.classList.contains('deitada'))`) };
  conferir(r.arv === '{"d":"coluna","t":1,"f":[{"g":0},{"g":1}]}' && igual(r.seps, [true]) && r.cx[0][2] === r.cx[1][2], 'fechar painéis: ramo com um filho some, divisórias somem junto', r);
  r = await arrastar(await pt(`__t.aba('dois.js')`), await pt(`__t.grupo(0).querySelector('.abas-corpo')`, 0.5, 0.06), () => av(`!!document.querySelector('.abas-zona.on.cima')`));
  conferir(r && igual(await lay(), ['dois.js!', 'um.js!']) && (await caixas())[0][1] < (await caixas())[1][1], 'arrastar para a borda de cima cria painel em cima', { r, lay: await lay() });
  await av(`Abas.fecharTodas()`);

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  srv.close();
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
