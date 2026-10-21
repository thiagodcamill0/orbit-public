// Teste das vistas de arquivo em abas (assets/arquivos.js, Rodada 9 → window.Arquivos) contra
// testes/arquivos-demo.html?abas=1: dois painéis com Arquivos.criarVista (um criado antes do montar), ganchos abrirAba,
// renomeado e projetoSaiu acrescentados depois no mesmo objeto (como o index.html). Fetch e SSE falsos, disco em memória.
// Servidor estático próprio numa porta livre de 47822–47826 (só GET, só arquivos do projeto), Edge headless mudo, perfil
// na pasta de saída e fechado com fecharEdge no fim.
// node testes/arquivos-abas.test.mjs <pasta-de-saida>   (captura 01-abas na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-arquivos-abas'));
fs.mkdirSync(SAIDA, { recursive: true });
const PERFIL = path.join(SAIDA, 'edge');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

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
const URL_DEMO = `http://127.0.0.1:${PORTA}/testes/arquivos-demo.html`;

let pcdp, ws;
try {
  const EDGE = (await import('./edge.mjs')).caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9760 + Math.floor(Math.random() * 150);
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
  const VK = { Enter: 13, Escape: 27, F2: 113, x: 88, v: 86 };
  const tecla = async (key, mods = {}) => {
    const m = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
    const letra = key.length === 1;
    const p = { key, code: letra ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: VK[key] || 0, modifiers: m };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(60);
  };
  const digitar = async (t) => { await cdp('Input.insertText', { text: t }); await dormir(40); };
  const foto = async (nome) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const tela = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  // Clique de verdade (mouse do CDP) no centro do elemento; cliques = 2 faz o duplo clique (gera click, click, dblclick).
  const mouse = async (expr, cliques = 1) => {
    const c = await av(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`);
    if (!c) throw new Error('mouse: elemento não achado: ' + expr);
    for (let n = 1; n <= cliques; n++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: n });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: n });
    }
    await dormir(80);
  };

  const AJ = `(() => {
    if (window.__aj) return;
    const SEP = '\\u001f';
    window.__aj = {
      SEP,
      proj: (n) => [...document.querySelectorAll('#projetos .proj-item')].find((b) => b.dataset.proj === n),
      linha: (p, c) => [...document.querySelectorAll('#projetos .arq-no[data-k]')].find((r) => r.dataset.k === p + SEP + c),
      menu: (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 })); },
      escolher: (rot) => { const b = [...document.querySelectorAll('.arq-menu .arq-mi')].find((x) => x.querySelector('.arq-mi-rot').textContent === rot); b.click(); return !!b; },
      aba: (i) => document.getElementById('aba-' + (i + 1)),
      nome: (i) => document.querySelector('#aba-' + (i + 1) + ' .arq-cab-nome')?.textContent || null,
      texto: (i) => [...document.querySelectorAll('#aba-' + (i + 1) + ' .arq-lt')].map((x) => x.textContent).join('\\n'),
      ultimo: () => demo.pedidos[demo.pedidos.length - 1] || null,
      lidos: (c) => demo.reqs.filter((r) => r[0] === 'GET' && r[1].startsWith('/arquivos/ler?') && r[1].includes('caminho=' + c)).length,
    };
  })()`;
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await dormir(300);
    await av(AJ);
  };

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await tela(1280, 860);
  await abrir('?abas=1');
  await av(`localStorage.clear()`);
  await abrir('?abas=1');
  await esperar(`document.querySelectorAll('#projetos .arq-proj').length >= 4`);

  // ── 1. Vistas criadas (uma antes do montar) e API nova ──
  let r = await av(`(() => ({ api: ['criarVista', 'icone', 'absoluto', 'marcarAtivo'].every((k) => typeof Arquivos[k] === 'function'),
    v: demo.vistas.map((v) => Object.keys(v).sort().join()), cls: [0, 1].map((i) => __aj.aba(i).className),
    vazio: [0, 1].map((i) => __aj.aba(i).querySelector('.arq-vazio h3')?.textContent), est: demo.vistas[0].estado() }))()`);
  conferir(r.api && r.v.every((k) => k === 'abrirArquivo,abrirBusca,destruir,estado,pausar,retomar'), 'Arquivos.criarVista/icone/absoluto/marcarAtivo; vista com abrirArquivo, abrirBusca, estado, pausar, retomar, destruir', r);
  conferir(r.cls.every((c) => /arq-vista/.test(c) && /arq-em-aba/.test(c)) && r.vazio.every((t) => t === 'Nenhum arquivo aberto') && r.est.modo === null, 'duas vistas na aba (a 1ª criada antes do montar), vazias', r);

  await av(`__aj.proj('Gerenciador').querySelector('.arq-seta').click()`);
  await esperar(`!!__aj.linha('Gerenciador', 'README.md')`);

  // ── 2. Clique simples → abrirAba prévia ──
  await mouse(`__aj.linha('Gerenciador', 'README.md')`);
  await esperar(`__aj.nome(0) === 'README.md' && __aj.texto(0).includes('Painel local')`);
  r = await av(`({ p: demo.pedidos.slice(), fechar: __aj.aba(0).querySelectorAll('.arq-b-fechar').length, migalha: __aj.aba(0).querySelector('.arq-migalha .arq-cab-proj')?.textContent,
    title: __aj.aba(0).querySelector('.arq-cab-cam')?.title, outra: __aj.aba(1).querySelector('.arq-vazio h3')?.textContent, geral: !document.querySelector('.conteudo').hidden || !document.getElementById('arquivo').hidden })`);
  conferir(r.p.length === 1 && JSON.stringify(r.p[0]) === JSON.stringify({ tipo: 'arquivo', proj: 'Gerenciador', caminho: 'README.md', previa: true }), 'clique simples na árvore → abrirAba({ tipo: arquivo, previa: true })', r.p);
  conferir(r.fechar === 0 && r.migalha === 'Gerenciador' && r.title === 'D:\\Dev\\Projetos\\Gerenciador\\README.md' && r.outra === 'Nenhum arquivo aberto' && !r.geral, 'na aba: sem × próprio, migalha com o projeto, só a vista em foco abriu, a vista principal não aparece', r);

  // ── 3. Duplo clique → prévia e depois fixa ──
  await av(`demo.pedidos.length = 0`);
  await mouse(`__aj.linha('Gerenciador', 'log.txt')`, 2);
  await esperar(`__aj.nome(0) === 'log.txt'`);
  r = await av(`demo.pedidos.map((p) => p.caminho + ':' + p.previa)`);
  conferir(r.join() === 'log.txt:true,log.txt:false', 'duplo clique: o 1º clique abre a prévia e o duplo fixa (previa: false), sem pedido repetido', r);
  // Duplo clique numa pasta não pede aba.
  await av(`demo.pedidos.length = 0`);
  await mouse(`__aj.linha('Gerenciador', 'brain')`, 2);
  r = await av(`demo.pedidos.length`);
  conferir(r === 0, 'duplo clique numa pasta não pede aba', r);

  // ── 4. Enter e menu Abrir ──
  await av(`__aj.linha('Gerenciador', 'package.json').focus()`);
  await tecla('Enter');
  await esperar(`__aj.nome(0) === 'package.json'`);
  r = await av(`__aj.ultimo()`);
  conferir(r && r.caminho === 'package.json' && r.previa === true, 'Enter → abrirAba prévia', r);
  await av(`__aj.menu(__aj.linha('Gerenciador', 'index.html'))`); await av(`__aj.escolher('Abrir')`);
  await esperar(`__aj.nome(0) === 'index.html'`);
  r = await av(`__aj.ultimo()`);
  conferir(r && r.caminho === 'index.html' && r.previa === false, 'menu Abrir → abrirAba fixa (previa: false)', r);

  // ── 5. Duas vistas com arquivos diferentes ao mesmo tempo ──
  await av(`demo.focar(1)`);
  await mouse(`__aj.linha('Gerenciador', 'servidor.mjs')`);
  await esperar(`__aj.nome(1) === 'servidor.mjs' && document.querySelectorAll('#aba-2 .arq-l').length > 100`);
  r = await av(`({ a: __aj.nome(0), b: __aj.nome(1), ea: demo.vistas[0].estado(), eb: demo.vistas[1].estado(), ta: __aj.texto(0).includes('<title>Orbit</title>') })`);
  conferir(r.a === 'index.html' && r.b === 'servidor.mjs' && r.ta && r.ea.modo === 'previa' && r.ea.caminho === 'index.html' && r.eb.caminho === 'servidor.mjs' && r.eb.proj === 'Gerenciador', 'duas vistas abertas com arquivos diferentes; estado() de cada uma', r);
  await foto('01-abas');

  // ── 6. SSE "arquivos" e "temas" atualizam as duas ──
  await av(`demo.escrever('Gerenciador', 'index.html', '<p>versão nova da página</p>\\n'); demo.escrever('Gerenciador', 'servidor.mjs', '// servidor novo\\nexport default 1;\\n')`);
  await esperar(`__aj.texto(0).includes('versão nova') && __aj.texto(1).includes('servidor novo')`, 4000);
  r = await av(`({ a: __aj.texto(0), b: __aj.texto(1) })`);
  conferir(r.a.includes('versão nova') && r.b.includes('servidor novo'), 'mudança pelo SSE falso atualiza as duas vistas', r);
  r = await av(`({ a: __aj.lidos('index.html'), b: __aj.lidos('servidor.mjs') })`);
  await av(`demo.emitir('temas', {})`);
  await esperar(`__aj.lidos('index.html') > ${r.a} && __aj.lidos('servidor.mjs') > ${r.b}`, 3000);
  const r2 = await av(`({ a: __aj.lidos('index.html'), b: __aj.lidos('servidor.mjs'), na: __aj.nome(0), nb: __aj.nome(1) })`);
  conferir(r2.a > r.a && r2.b > r.b && r2.na === 'index.html' && r2.nb === 'servidor.mjs', 'SSE "temas" recarrega as prévias das duas vistas', { antes: r, depois: r2 });
  // Vista pausada (aba escondida): marca como suja e só recarrega ao retomar.
  await av(`demo.vistas[1].pausar()`);
  await av(`demo.escrever('Gerenciador', 'servidor.mjs', '// pausado\\n')`);
  await dormir(700);
  r = await av(`__aj.texto(1)`);
  await av(`demo.vistas[1].retomar()`);
  await esperar(`__aj.texto(1).includes('pausado')`, 3000);
  conferir(!r.includes('pausado') && (await av(`__aj.texto(1)`)).includes('pausado'), 'pausar() segura a atualização; retomar() recarrega', r);

  // ── 7. Busca: Localizar na pasta e resultado ──
  await av(`demo.pedidos.length = 0`);
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Localizar na pasta')`);
  await esperar(`!!document.querySelector('#aba-2 .arq-busca-input')`);
  r = await av(`({ p: __aj.ultimo(), x: document.querySelectorAll('#aba-2 .arq-b-fechar').length, e: demo.vistas[1].estado(), rel: document.querySelector('#aba-2 .arq-cab-rel').textContent })`);
  conferir(r.p && JSON.stringify(r.p) === JSON.stringify({ tipo: 'busca', proj: 'Gerenciador', escopo: '' }) && r.x === 0 && r.e.modo === 'busca' && r.e.escopo === '' && r.rel === 'Gerenciador/', '"Localizar na pasta" → abrirAba({ tipo: busca, proj, escopo }); busca na aba sem ×', r);
  await av(`(() => { const i = document.querySelector('#aba-2 .arq-busca-input'); i.value = 'function'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await esperar(`document.querySelectorAll('#aba-2 .arq-res-grupo').length > 0`, 2500);
  await av(`demo.pedidos.length = 0`);
  await av(`[...document.querySelectorAll('#aba-2 .arq-res-grupo')].find((g) => g.querySelector('.arq-res-nome').textContent === 'notas.md').querySelector('.arq-res-linha').click()`);
  await esperar(`__aj.nome(1) === 'notas.md' && !!document.querySelector('#aba-2 .arq-l.arq-destaque')`);
  r = await av(`({ p: demo.pedidos.slice(), n: document.querySelector('#aba-2 .arq-l.arq-destaque .arq-ln')?.textContent, e: demo.vistas[1].estado() })`);
  conferir(r.p.length === 1 && r.p[0].tipo === 'arquivo' && r.p[0].caminho === 'brain/notas.md' && r.p[0].linha === 3 && r.p[0].previa === true && r.n === '3' && r.e.linha === 3, 'resultado de busca → abrirAba prévia com a linha; a vista destaca a linha', r);

  // ── 8. Esc na aba não fecha nada ──
  await av(`__aj.aba(0).querySelector('.arq-codigo').focus()`);
  await tecla('Escape');
  r = await av(`({ n: __aj.nome(0), e: demo.vistas[0].estado().modo, f: demo.fechou.length })`);
  conferir(r.n === 'index.html' && r.e === 'previa' && r.f === 0, 'Esc na vista da aba não fecha a vista', r);

  // ── 9. Arquivo apagado → estado "apagado ou movido" na vista dele ──
  await av(`demo.apagar('Gerenciador', 'index.html')`);
  await esperar(`__aj.aba(0).querySelector('.arq-vazio h3')?.textContent === 'Este arquivo foi apagado ou movido'`, 3000);
  r = await av(`({ a: __aj.aba(0).querySelector('.arq-vazio h3')?.textContent, e: demo.vistas[0].estado(), b: __aj.nome(1) })`);
  conferir(r.a === 'Este arquivo foi apagado ou movido' && r.e.sumiu === true && r.b === 'notas.md', 'apagado por fora: estado "apagado ou movido" na vista dele; a outra segue', r);

  // ── 10. renomeado: F2 em arquivo e em pasta; mover ──
  await av(`demo.focar(0)`);
  await mouse(`__aj.linha('Gerenciador', 'package.json')`);
  await esperar(`__aj.nome(0) === 'package.json'`);
  await av(`__aj.linha('Gerenciador', 'package.json').focus()`);
  await tecla('F2');
  await esperar(`!!document.querySelector('#projetos .arq-input')`);
  await digitar('pacote');
  await tecla('Enter');
  await esperar(`demo.ren.length === 1 && !!__aj.linha('Gerenciador', 'pacote.json')`);
  r = await av(`({ ren: demo.ren.slice(), n: __aj.nome(0), e: demo.vistas[0].estado() })`);
  conferir(JSON.stringify(r.ren[0]) === JSON.stringify({ proj: 'Gerenciador', de: 'package.json', para: 'pacote.json', tipo: 'arquivo' }) && r.n === 'pacote.json' && r.e.caminho === 'pacote.json', 'F2 num arquivo → renomeado({ tipo: arquivo }); a vista acompanha', r);
  // Pasta: a vista 2 tem brain/notas.md aberto.
  await av(`__aj.linha('Gerenciador', 'brain').focus()`);
  await tecla('F2');
  await esperar(`!!document.querySelector('#projetos .arq-input')`);
  await digitar('cerebro');
  await tecla('Enter');
  await esperar(`demo.ren.length === 2 && !!__aj.linha('Gerenciador', 'cerebro')`);
  await esperar(`demo.vistas[1].estado().caminho === 'cerebro/notas.md' && __aj.texto(1).includes('Notas')`, 3000);
  r = await av(`({ ren: demo.ren[1], e: demo.vistas[1].estado(), t: __aj.aba(1).querySelector('.arq-cab-cam').title, h: __aj.aba(1).querySelector('.arq-vazio h3')?.textContent || null })`);
  conferir(JSON.stringify(r.ren) === JSON.stringify({ proj: 'Gerenciador', de: 'brain', para: 'cerebro', tipo: 'pasta' }) && r.e.caminho === 'cerebro/notas.md' && /cerebro\\notas\.md$/.test(r.t) && !r.h, 'F2 numa pasta → renomeado({ tipo: pasta }); a vista do arquivo de dentro acompanha', r);
  // Mover (Ctrl+X / Ctrl+V) dentro do projeto também avisa e a vista acompanha.
  await av(`__aj.linha('Gerenciador', 'cerebro') && __aj.linha('Gerenciador', 'cerebro').getAttribute('aria-expanded') !== 'true' && __aj.linha('Gerenciador', 'cerebro').click()`);
  await esperar(`!!__aj.linha('Gerenciador', 'cerebro/notas.md')`);
  await av(`__aj.linha('Gerenciador', 'cerebro/notas.md').focus()`);
  await tecla('x', { ctrl: true });
  await av(`__aj.proj('Gerenciador').focus()`);
  await tecla('v', { ctrl: true });
  await esperar(`demo.ren.length === 3`, 3000);
  await esperar(`demo.vistas[1].estado().caminho === 'notas.md' && __aj.texto(1).includes('Notas')`, 3000);
  r = await av(`({ ren: demo.ren[2], e: demo.vistas[1].estado(), h: __aj.aba(1).querySelector('.arq-vazio h3')?.textContent || null })`);
  conferir(JSON.stringify(r.ren) === JSON.stringify({ proj: 'Gerenciador', de: 'cerebro/notas.md', para: 'notas.md', tipo: 'arquivo' }) && r.e.caminho === 'notas.md' && !r.h, 'mover (recortar e colar) no mesmo projeto → renomeado; a vista acompanha', r);

  // ── 11. icone, absoluto, marcarAtivo ──
  r = await av(`(() => { const a = Arquivos.icone('app.js'), p = Arquivos.icone('src', 'pasta', 20), d = Arquivos.icone('x');
    return { a: a.className, asvg: !!a.querySelector('svg'), at: a.dataset.t, pw: p.querySelector('svg')?.getAttribute('width'), dw: d.querySelector('svg')?.getAttribute('width'),
      abs: Arquivos.absoluto('Gerenciador', 'assets/arquivos.js'), raiz: Arquivos.absoluto('Gerenciador', '') }; })()`);
  conferir(r.a === 'arq-ico' && r.asvg && r.at === 'js' && r.pw === '20' && r.dw === '16', 'icone(nome, tipo, tam): o mesmo ícone da árvore (classe arq-ico, tipo js, tamanho)', r);
  conferir(r.abs === 'D:\\Dev\\Projetos\\Gerenciador\\assets\\arquivos.js' && r.raiz === 'D:\\Dev\\Projetos\\Gerenciador', 'absoluto(proj, caminho)', r);
  const antes = await av(`({ ab: localStorage.getItem('orbit.arquivos.abertos'), y: document.querySelector('.lateral').scrollTop, lin: !!__aj.linha('Gerenciador', 'assets/arquivos.js') })`);
  await av(`Arquivos.marcarAtivo('Gerenciador', 'assets/arquivos.js')`);
  await dormir(100);
  r = await av(`({ ab: localStorage.getItem('orbit.arquivos.abertos'), y: document.querySelector('.lateral').scrollTop, lin: !!__aj.linha('Gerenciador', 'assets/arquivos.js'), n: document.querySelectorAll('#projetos .arq-ativo').length })`);
  conferir(!antes.lin && !r.lin && r.ab === antes.ab && r.y === antes.y && r.n === 0, 'marcarAtivo num arquivo de pasta fechada: não abre pasta nem rola', { antes, r });
  await av(`__aj.linha('Gerenciador', 'assets').click()`);
  await esperar(`!!__aj.linha('Gerenciador', 'assets/arquivos.js')`);
  r = await av(`({ m: [...document.querySelectorAll('#projetos .arq-ativo')].map((x) => x.dataset.k.split(__aj.SEP)[1]), cur: __aj.linha('Gerenciador', 'assets/arquivos.js').getAttribute('aria-current') })`);
  conferir(r.m.join() === 'assets/arquivos.js' && r.cur === 'true', 'ao abrir a pasta, a linha do arquivo ativo aparece marcada', r);
  await av(`Arquivos.marcarAtivo('Gerenciador', 'pacote.json')`);
  r = await av(`[...document.querySelectorAll('#projetos .arq-ativo')].map((x) => x.dataset.k.split(__aj.SEP)[1])`);
  conferir(r.join() === 'pacote.json', 'marcarAtivo troca a marca (uma só)', r);
  await av(`Arquivos.marcarAtivo(null)`);
  conferir((await av(`document.querySelectorAll('#projetos .arq-ativo, #projetos [aria-current]').length`)) === 0, 'marcarAtivo(null) tira a marca');

  // ── 12. Painel estreito: sem rolagem horizontal ──
  await tela(860, 700);
  await dormir(200);
  r = await av(`[0, 1].map((i) => ({ sw: __aj.aba(i).scrollWidth, cw: __aj.aba(i).clientWidth, cab: __aj.aba(i).querySelector('.arq-cab')?.getBoundingClientRect().height }))`);
  conferir(r.every((x) => x.sw <= x.cw && x.cab <= 40), 'painéis estreitos (~320 px): sem rolagem horizontal, cabeçalho de uma linha', r);
  await tela(1280, 860);

  // ── 13. projetoSaiu ──
  await mouse(`__aj.proj('site-exemplo').querySelector('.arq-seta')`);
  await esperar(`!!__aj.linha('site-exemplo', 'index.html')`);
  await mouse(`__aj.linha('site-exemplo', 'index.html')`);
  await esperar(`__aj.nome(0) === 'index.html' && demo.vistas[0].estado().proj === 'site-exemplo'`);
  await av(`fetch('/projetos/remover', { method: 'POST', headers: { 'x-gerenciador': '1' }, body: JSON.stringify({ nome: 'site-exemplo' }) })`);
  await esperar(`demo.saiu.length > 0`, 3000);
  r = await av(`({ saiu: demo.saiu.slice(), fechou: demo.fechou.slice(), e: demo.vistas[0].estado(), b: demo.vistas[1].estado().caminho })`);
  conferir(r.saiu.join() === 'site-exemplo' && r.fechou.join() === '0' && r.e.modo === null && r.b === 'notas.md', 'projeto saiu da lista → projetoSaiu(nome); a vista dele esvazia e chama op.fechar(); a outra segue', r);

  // ── 14. destruir ──
  const v1 = await av(`demo.vistas[1].estado().caminho`);
  await av(`demo.vistas[1].destruir()`);
  r = await av(`({ filhos: __aj.aba(1).childElementCount, cls: __aj.aba(1).className, e: demo.vistas[1].estado() })`);
  await av(`demo.vistas[1].abrirArquivo('Gerenciador', 'README.md'); demo.escrever('Gerenciador', '${v1}', 'depois de destruir\\n'); demo.emitir('temas', {})`);
  await dormir(700);
  const r3 = await av(`({ filhos: __aj.aba(1).childElementCount, lidos: demo.reqs.filter((x) => x[1].includes('README.md') && x[1].startsWith('/arquivos/ler')).length })`);
  conferir(r.filhos === 0 && r.cls === 'aba-painel' && r.e.modo === null && r3.filhos === 0, 'destruir() esvazia o painel, tira as classes e a vista não responde mais (SSE nem abrirArquivo)', { r, r3 });
  // Vista nova no mesmo painel funciona de novo.
  await av(`demo.vistas[1] = demo.criar(1); demo.vistas[1].abrirArquivo('Gerenciador', 'log.txt', { linha: 2 })`);
  await esperar(`__aj.nome(1) === 'log.txt' && document.querySelector('#aba-2 .arq-l.arq-destaque .arq-ln')?.textContent === '2'`);
  conferir(await av(`__aj.nome(1) === 'log.txt'`), 'nova vista no mesmo painel depois do destruir; abrirArquivo com { linha }');

  conferir(consoleErros.length === 0, 'console sem erros nem avisos', consoleErros);
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  srv.close();
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
