// Teste da lateral de projetos/arquivos (assets/arquivos.js + .css, rodada 8) contra testes/arquivos-demo.html
// (fetch e SSE falsos, disco fictício em memória). Servidor estático próprio numa porta livre de 47822–47826 (só GET,
// só arquivos do projeto), Edge headless mudo, perfil na pasta de saída e fechado com fecharEdge no fim.
// node testes/arquivos-ui.test.mjs <pasta-de-saida>   (capturas 01 e 02 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-arquivos-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const PERFIL = path.join(SAIDA, 'edge');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

// Servidor estático mínimo (só leitura, só dentro do projeto).
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47824);
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
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon|\/temas\/icones$/.test(d.params.entry.url || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + '\n' + expr.slice(0, 200));
    return r.result?.result?.value;
  };
  const esperar = async (expr, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(40); } return false; };
  const VK = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13, Escape: 27, Delete: 46, F2: 113, Backspace: 8, Tab: 9, c: 67, x: 88, v: 86, a: 65 };
  const tecla = async (key, mods = {}) => {
    const m = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
    const letra = key.length === 1;
    const p = { key: letra && mods.shift ? key.toUpperCase() : key, code: letra ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: VK[key] || 0, modifiers: m };
    if (mods.comandos) p.commands = mods.comandos; // Mac: atalhos de edição (Cmd+A) só valem com o comando do sistema
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(60);
  };
  const digitar = async (t) => { await cdp('Input.insertText', { text: t }); await dormir(40); };
  const foto = async (nome, clip) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const tela = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

  // Ajudas dentro da página.
  const AJ = `(() => {
    if (window.__aj) return;
    const SEP = '\\u001f';
    window.__aj = {
      proj: (n) => [...document.querySelectorAll('#projetos .proj-item')].find((b) => b.dataset.proj === n),
      linha: (p, c) => [...document.querySelectorAll('#projetos .arq-no[data-k]')].find((r) => r.dataset.k === p + SEP + c),
      nomes: (p) => [...document.querySelectorAll('#projetos .arq-proj')].find((w) => w.dataset.proj === p)?.querySelectorAll('.arq-arvore .arq-no[data-k]') ?
        [...[...document.querySelectorAll('#projetos .arq-proj')].find((w) => w.dataset.proj === p).querySelectorAll('.arq-arvore .arq-no[data-k]')].map((r) => r.dataset.k.split(SEP)[1]) : [],
      clicar: (el, o = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: !!o.ctrl, shiftKey: !!o.shift })),
      menu: (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 })); },
      itensMenu: () => [...document.querySelectorAll('.arq-menu > *')].map((x) => x.classList.contains('arq-menu-sep') ? '—' : x.querySelector('.arq-mi-rot').textContent + (x.getAttribute('aria-disabled') ? '(off)' : '')),
      escolher: (rot) => { const b = [...document.querySelectorAll('.arq-menu .arq-mi')].find((x) => x.querySelector('.arq-mi-rot').textContent === rot); b.click(); return !!b; },
      ativo: () => { const a = document.activeElement; return a ? (a.dataset.k ? a.dataset.k.split(SEP)[1] : a.dataset.proj ? 'proj:' + a.dataset.proj : a.className || a.tagName) : null; },
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
  await abrir();
  await av(`localStorage.clear()`);
  await abrir();

  // ── 1. Lista de projetos na lateral ──
  await esperar(`document.querySelectorAll('#projetos .arq-proj').length >= 4`);
  let r = await av(`(() => ({ lista: Arquivos.projetos().map((p) => p.nome + ':' + p.existe), linhas: [...document.querySelectorAll('#projetos .proj-item')].map((b) => b.dataset.proj),
    lapis: document.querySelectorAll('#projetos .pj-editar').length, setas: document.querySelectorAll('#projetos .proj-item .arq-seta').length,
    n: __aj.proj('Gerenciador').querySelector('.n').textContent, alerta: !__aj.proj('loja-api').querySelector('.alerta-p').hidden, alertaG: !__aj.proj('Gerenciador').querySelector('.alerta-p').hidden,
    tag: !!__aj.proj('Gerenciador').querySelector('.av .pj-tag'), add: !document.getElementById('proj-add').hidden && !!document.querySelector('#proj-add svg'), pn: document.getElementById('proj-n').textContent }))()`);
  conferir(r.lista.join() === 'antigo:false,Gerenciador:true,loja-api:true,site-exemplo:true', 'projetos() em ordem alfabética com existe', r.lista);
  conferir(r.linhas.join() === 'antigo,Gerenciador,loja-api,site-exemplo', 'só os projetos do GET /projetos, em ordem alfabética ("Sem projeto" das contagens fica fora)', r.linhas);
  conferir(r.lapis === 0 && r.setas === 4, 'sem lápis; seta só nos projetos registrados', r);
  conferir(r.n === '3' && r.alerta && !r.alertaG, 'contagem de sessões e ponto âmbar', r);
  conferir(r.tag && r.add && r.pn === '4', 'ícone pelo gancho pintarIcone; botão + com ícone', r);
  await av(`__aj.clicar(__aj.proj('Gerenciador').querySelector('.nome'))`);
  r = await av(`({ p: __aj.proj('Gerenciador').getAttribute('aria-pressed'), f: document.getElementById('demo-filtro').textContent, pag: demo.log.includes('pagina-clique-projetos') })`);
  conferir(r.p === 'true' && /Gerenciador/.test(r.f) && !r.pag, 'clique no nome filtra (e não chega ao listener antigo de #projetos)', r);
  await av(`__aj.clicar(__aj.proj('Gerenciador').querySelector('.nome'))`);
  conferir((await av(`__aj.proj('Gerenciador').getAttribute('aria-pressed')`)) === 'false', 'clique de novo tira o filtro');

  // ── 2. Árvore ──
  await av(`__aj.clicar(__aj.proj('Gerenciador').querySelector('.arq-seta'))`);
  await esperar(`__aj.nomes('Gerenciador').length > 5`);
  r = await av(`(() => ({ nomes: __aj.nomes('Gerenciador'), exp: __aj.proj('Gerenciador').getAttribute('aria-expanded'), filtro: __aj.proj('Gerenciador').getAttribute('aria-pressed'),
    tipos: Object.fromEntries(['servidor.mjs', 'README.md', 'package.json', 'index.html', 'estilo.css', 'script.py', 'tipos.ts', '.gitignore', 'package-lock.json', 'dados.zip', 'manual.pdf', 'log.txt'].map((n) => [n, __aj.linha('Gerenciador', n)?.querySelector('.arq-ico').dataset.t])),
    altura: __aj.linha('Gerenciador', 'assets').getBoundingClientRect().height, fonte: getComputedStyle(__aj.linha('Gerenciador', 'assets')).fontSize,
    recuo: __aj.linha('Gerenciador', 'assets').querySelector('.arq-seta').getBoundingClientRect().left - __aj.proj('Gerenciador').querySelector('.arq-seta').getBoundingClientRect().left }))()`);
  conferir(r.exp === 'true' && r.filtro === 'false', 'seta abre a árvore sem filtrar', r);
  conferir(r.nomes.slice(0, 4).join() === 'assets,brain,node_modules,testes' && !r.nomes.includes('.git') && r.nomes.includes('.gitignore'), 'pastas primeiro, .git escondido', r.nomes);
  conferir(JSON.stringify(r.tipos) === JSON.stringify({ 'servidor.mjs': 'js', 'README.md': 'md', 'package.json': 'json', 'index.html': 'html', 'estilo.css': 'css', 'script.py': 'py', 'tipos.ts': 'ts', '.gitignore': 'config', 'package-lock.json': 'lock', 'dados.zip': 'zip', 'manual.pdf': 'pdf', 'log.txt': 'txt' }), 'ícone por tipo', r.tipos);
  conferir(r.altura >= 22 && r.altura <= 24 && /^(12\.5|13)px$/.test(r.fonte) && Math.abs(r.recuo - 12) < 0.6, 'linha 22–24 px, fonte 12,5–13 px, recuo de 12 px', r);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'assets'))`);
  await esperar(`!!__aj.linha('Gerenciador', 'assets/logo.png')`);
  r = await av(`({ ls: JSON.parse(localStorage.getItem('orbit.arquivos.abertos') || '[]').map((k) => k.replace('\\u001f', '|')), guia: getComputedStyle(__aj.linha('Gerenciador', 'assets/logo.png').parentElement, '::before').width, svg: __aj.linha('Gerenciador', 'assets/icone.svg').querySelector('.arq-ico').dataset.t, img: __aj.linha('Gerenciador', 'assets/logo.png').querySelector('.arq-ico').dataset.t })`);
  conferir(r.ls.includes('Gerenciador|') && r.ls.includes('Gerenciador|assets') && r.guia === '1px', 'pasta abre sob demanda, guia de 1 px, abertos no localStorage', r);
  conferir(r.svg === 'svg' && r.img === 'imagem', 'ícones de svg e imagem', r);
  await abrir();
  await esperar(`!!__aj.linha('Gerenciador', 'assets/logo.png')`);
  conferir(await av(`!!__aj.linha('Gerenciador', 'assets/arquivos.js')`), 'o que estava aberto volta depois de recarregar');

  // ── 3. Teclado ──
  await av(`__aj.proj('Gerenciador').focus()`);
  await tecla('ArrowDown');
  conferir((await av(`__aj.ativo()`)) === 'assets' && (await av(`__aj.linha('Gerenciador','assets').getAttribute('aria-selected')`)) === 'true', '↓ do projeto vai para a 1ª linha e seleciona');
  await tecla('ArrowRight');
  conferir((await av(`__aj.ativo()`)) === 'assets/arquivos.css', '→ numa pasta aberta entra no 1º filho', await av(`__aj.ativo()`));
  await tecla('ArrowLeft');
  conferir((await av(`__aj.ativo()`)) === 'assets', '← num arquivo sobe para a pasta');
  await tecla('ArrowLeft');
  conferir((await av(`__aj.linha('Gerenciador','assets').getAttribute('aria-expanded')`)) === 'false' && !(await av(`!!__aj.linha('Gerenciador','assets/logo.png')`)) && (await av(`__aj.ativo()`)) === 'assets', '← numa pasta aberta fecha (foco fica nela)');
  await tecla('ArrowRight');
  await esperar(`!!__aj.linha('Gerenciador', 'assets/logo.png')`);
  conferir((await av(`__aj.linha('Gerenciador','assets').getAttribute('aria-expanded')`)) === 'true', '→ abre a pasta');
  await tecla('End');
  const ultimo = await av(`__aj.ativo()`);
  await tecla('Home');
  conferir(ultimo === 'site-exemplo' || ultimo === 'proj:site-exemplo', 'End vai para a última linha', ultimo);
  conferir((await av(`__aj.ativo()`)) === 'proj:antigo', 'Home vai para a primeira linha', await av(`__aj.ativo()`));
  await av(`__aj.linha('Gerenciador','log.txt').focus()`);
  await tecla('Enter');
  await esperar(`!document.getElementById('arquivo').hidden && document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'log.txt'`);
  conferir(await av(`document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'log.txt'`), 'Enter num arquivo abre a prévia');
  await av(`demo.log.length = 0`);
  await av(`__aj.linha('Gerenciador','log.txt').focus()`);
  for (const k of ['ArrowDown', 'ArrowUp']) await tecla(k);
  await tecla('Delete');
  r = await av(`({ dlg: document.querySelector('.arq-camada h2')?.textContent, pag: demo.log.filter((x) => typeof x === 'string' && x.startsWith('pagina')), foco: document.activeElement?.textContent })`);
  conferir(r.dlg === 'Mover para a Lixeira?' && r.pag.length === 0, 'Delete na árvore pede confirmação e não chega aos atalhos da página', r);
  conferir(r.foco === 'Cancelar', 'o foco começa em Cancelar', r);
  await tecla('Escape');
  r = await av(`({ dlg: !!document.querySelector('.arq-camada'), lix: demo.lixeira.length, existe: !!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\log.txt'), vista: !document.getElementById('arquivo').hidden })`);
  conferir(!r.dlg && r.lix === 0 && r.existe && r.vista, 'Esc cancela: nada sai e a vista não fecha', r);

  // ── 4. Menus dos 3 tipos ──
  await av(`__aj.menu(__aj.proj('Gerenciador'))`);
  r = await av(`({ itens: __aj.itensMenu(), foco: document.activeElement?.querySelector?.('.arq-mi-rot')?.textContent, teclas: [...document.querySelectorAll('.arq-mi-tecla')].map((x) => x.textContent) })`);
  conferir(r.itens.join('|') === 'Editar projeto|—|Novo arquivo|Nova pasta|—|Localizar na pasta|—|Colar(off)|—|Copiar caminho|Copiar caminho relativo|—|Abrir na pasta|Revelar no Explorador|Remover projeto da lista', 'menu do projeto', r.itens);
  conferir(r.foco === 'Editar projeto' && r.teclas.length === 0, 'menu foca o 1º item; sem dica de tecla nos itens', r);
  await tecla('ArrowDown'); await tecla('ArrowDown');
  conferir((await av(`document.activeElement?.querySelector('.arq-mi-rot')?.textContent`)) === 'Nova pasta', 'setas navegam no menu');
  await tecla('Escape');
  r = await av(`({ menu: !!document.querySelector('.arq-menu'), foco: __aj.ativo() })`);
  conferir(!r.menu && r.foco === 'proj:Gerenciador', 'Esc fecha o menu e devolve o foco', r);
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Editar projeto')`);
  conferir(await av(`demo.log.some((x) => Array.isArray(x) && x[0] === 'editar' && x[1] === 'Gerenciador' && x[2] === true)`), 'Editar projeto chama o gancho com a linha como âncora');
  await av(`__aj.menu(__aj.linha('Gerenciador', 'assets'))`);
  r = await av(`__aj.itensMenu()`);
  conferir(r.join('|') === 'Novo arquivo|Nova pasta|—|Localizar na pasta|—|Recortar|Copiar|Colar(off)|—|Copiar caminho|Copiar caminho relativo|—|Abrir na pasta|Renomear|Excluir', 'menu da pasta', r);
  await tecla('Escape');
  await av(`__aj.menu(__aj.linha('Gerenciador', 'README.md'))`);
  r = await av(`__aj.itensMenu()`);
  conferir(r.join('|') === 'Abrir|—|Recortar|Copiar|—|Copiar caminho|Copiar caminho relativo|—|Revelar no Explorador|Renomear|Excluir', 'menu do arquivo', r);
  await av(`__aj.escolher('Copiar caminho relativo')`);
  await dormir(80);
  conferir((await av(`demo.area`)) === 'README.md', 'Copiar caminho relativo', await av(`demo.area`));
  await av(`__aj.menu(__aj.linha('Gerenciador', 'assets/arquivos.js'))`); await av(`__aj.escolher('Copiar caminho relativo')`); await dormir(80);
  conferir((await av(`demo.area`)) === 'assets\\arquivos.js', 'caminho relativo com \\', await av(`demo.area`));
  await av(`__aj.linha('Gerenciador', 'assets/arquivos.js').focus()`);
  await tecla('c', { shift: true, alt: true });
  conferir((await av(`demo.area`)) === 'D:\\Dev\\Projetos\\Gerenciador\\assets\\arquivos.js', 'Shift+Alt+C copia o caminho absoluto', await av(`demo.area`));
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Revelar no Explorador')`); await dormir(80);
  conferir((await av(`demo.revelados.join()`)) === 'Gerenciador:', 'Revelar no Explorador (projeto)');
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Abrir na pasta')`); await dormir(80);
  await av(`__aj.menu(__aj.linha('Gerenciador', 'assets'))`); await av(`__aj.escolher('Abrir na pasta')`); await dormir(80);
  conferir((await av(`demo.abertas.join()`)) === 'Gerenciador:,Gerenciador:assets', 'Abrir na pasta (projeto e pasta)', await av(`demo.abertas`));

  // ── 5. Copiar / recortar / colar ──
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'brain'))`);
  await esperar(`!!__aj.linha('Gerenciador', 'brain/notas.md')`);
  await av(`__aj.linha('Gerenciador', 'README.md').focus()`);
  await tecla('c', { ctrl: true });
  await av(`__aj.linha('Gerenciador', 'brain').focus()`);
  await tecla('v', { ctrl: true });
  await esperar(`!!__aj.linha('Gerenciador', 'brain/README.md')`);
  r = await av(`({ novo: !!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\brain\\\\README.md'), orig: !!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\README.md'), sel: __aj.linha('Gerenciador', 'brain/README.md')?.getAttribute('aria-selected') })`);
  conferir(r.novo && r.orig && r.sel === 'true', 'Ctrl+C / Ctrl+V copia para a pasta e seleciona o colado', r);
  await av(`__aj.linha('Gerenciador', 'README.md').focus()`);
  await tecla('v', { ctrl: true });
  await esperar(`!!__aj.linha('Gerenciador', 'README copy.md')`);
  conferir(await av(`!!__aj.linha('Gerenciador', 'README copy.md')`), 'colar no mesmo lugar cria "nome copy.ext"');
  await av(`__aj.linha('Gerenciador', 'log.txt').focus()`);
  await tecla('x', { ctrl: true });
  conferir(await av(`__aj.linha('Gerenciador', 'log.txt').classList.contains('arq-recortado')`), 'recortado fica esmaecido');
  await tecla('Escape');
  conferir(!(await av(`__aj.linha('Gerenciador', 'log.txt').classList.contains('arq-recortado')`)), 'Esc desfaz o recorte');
  await tecla('x', { ctrl: true });
  await av(`__aj.linha('Gerenciador', 'brain').focus()`);
  await tecla('v', { ctrl: true });
  await esperar(`!!__aj.linha('Gerenciador', 'brain/log.txt') && !__aj.linha('Gerenciador', 'log.txt')`);
  r = await av(`({ dest: !!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\brain\\\\log.txt'), orig: !!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\log.txt'), faded: document.querySelectorAll('.arq-recortado').length })`);
  conferir(r.dest && !r.orig && r.faded === 0, 'Ctrl+X / Ctrl+V move', r);
  // Entre projetos: copiar de Gerenciador para loja-api.
  await av(`__aj.linha('Gerenciador', 'tipos.ts').focus()`);
  await tecla('c', { ctrl: true });
  await av(`__aj.menu(__aj.proj('loja-api'))`);
  r = await av(`__aj.itensMenu().includes('Colar')`);
  conferir(r, 'Colar habilita com algo copiado');
  await av(`__aj.escolher('Colar')`);
  await esperar(`!!__aj.linha('loja-api', 'tipos.ts')`);
  conferir(await av(`!!demo.no('D:\\\\Projetos\\\\loja-api\\\\tipos.ts') && __aj.proj('loja-api').getAttribute('aria-expanded') === 'true'`), 'colar entre projetos (abre o destino)');

  // ── 6. Renomear inline ──
  await av(`__aj.linha('Gerenciador', 'script.py').focus()`);
  await tecla('F2');
  r = await av(`(() => { const i = document.querySelector('#projetos .arq-input'); return i ? { v: i.value, s: i.selectionStart, e: i.selectionEnd, foco: document.activeElement === i } : null; })()`);
  conferir(r && r.v === 'script.py' && r.s === 0 && r.e === 6 && r.foco, 'F2 abre o campo com o nome sem a extensão selecionado', r);
  await av(`demo.log.length = 0`);
  await digitar('CON');
  await tecla('Enter');
  await esperar(`!document.querySelector('#projetos .arq-erro-campo')?.hidden`);
  r = await av(`({ erro: document.querySelector('#projetos .arq-erro-campo')?.textContent, foco: document.activeElement?.className, pag: demo.log.length })`);
  conferir(/inválido/.test(r.erro || '') && r.foco === 'arq-input' && r.pag === 0, 'erro do servidor aparece colado no campo, que segue aberto', r);
  // Selecionar tudo no campo: Ctrl+A no Windows; no Mac é Cmd+A (lá o Ctrl+A só vai ao começo da linha).
  await tecla('a', process.platform === 'darwin' ? { meta: true, comandos: ['selectAll'] } : { ctrl: true });
  await digitar('rotina.py');
  await tecla('Enter');
  await esperar(`!!__aj.linha('Gerenciador', 'rotina.py') && !document.querySelector('#projetos .arq-input')`);
  r = await av(`({ novo: !!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\rotina.py'), velho: !!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\script.py'), foco: __aj.ativo() })`);
  conferir(r.novo && !r.velho && r.foco === 'rotina.py', 'Enter renomeia e o foco fica no item', r);
  await av(`__aj.linha('Gerenciador', 'rotina.py').focus()`);
  await tecla('F2');
  await digitar('outra.py');
  await tecla('Escape');
  r = await av(`({ campo: !!document.querySelector('#projetos .arq-input'), nome: !!__aj.linha('Gerenciador', 'rotina.py'), vista: !document.getElementById('arquivo').hidden })`);
  conferir(!r.campo && r.nome && r.vista, 'Esc cancela o renomear (sem fechar a vista)', r);
  // Novo arquivo / nova pasta pelo menu.
  await av(`__aj.menu(__aj.linha('Gerenciador', 'brain'))`); await av(`__aj.escolher('Novo arquivo')`);
  await esperar(`document.activeElement?.className === 'arq-input'`);
  await digitar('ideias.md');
  await tecla('Enter');
  await esperar(`!!__aj.linha('Gerenciador', 'brain/ideias.md') && document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'ideias.md'`);
  conferir(await av(`!!demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\brain\\\\ideias.md') && document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'ideias.md'`), 'Novo arquivo cria na pasta e abre a prévia');
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Nova pasta')`);
  await esperar(`document.activeElement?.className === 'arq-input'`);
  r = await av(`(() => { const row = document.activeElement.closest('.arq-no'); return { prim: row.previousElementSibling === null, d: row.style.getPropertyValue('--d') }; })()`);
  await digitar('docs');
  await tecla('Enter');
  await esperar(`!!__aj.linha('Gerenciador', 'docs')`);
  conferir(r.prim && await av(`demo.no('D:\\\\Dev\\\\Projetos\\\\Gerenciador\\\\docs')?.tipo === 'pasta'`), 'Nova pasta: campo no topo da raiz, cria a pasta', r);
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Novo arquivo')`);
  await esperar(`document.activeElement?.className === 'arq-input'`);
  await digitar('package.json');
  await tecla('Enter');
  await esperar(`!document.querySelector('#projetos .arq-erro-campo')?.hidden`);
  conferir(/Já existe/.test(await av(`document.querySelector('#projetos .arq-erro-campo').textContent`)), 'nome que já existe → erro 409 no campo');
  await tecla('Escape');

  // ── 7. Excluir ──
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'manual.pdf'))`);
  await av(`__aj.linha('Gerenciador', 'manual.pdf').focus()`);
  await tecla('Delete');
  r = await av(`({ t: document.querySelector('.arq-camada h2')?.textContent, sub: document.querySelector('.arq-camada .arq-modal-tit p')?.textContent, b: document.querySelector('.arq-b-confirmar')?.textContent, foco: document.activeElement?.textContent })`);
  conferir(r.t === 'Mover para a Lixeira?' && r.sub === 'manual.pdf' && r.b === 'Mover para a Lixeira' && r.foco === 'Cancelar', 'diálogo de excluir: título, nome, botão, foco em Cancelar', r);
  await av(`document.querySelector('.arq-b-confirmar').click()`);
  await esperar(`!__aj.linha('Gerenciador', 'manual.pdf')`);
  r = await av(`({ lix: demo.lixeira.slice(), dlg: !!document.querySelector('.arq-camada') })`);
  conferir(r.lix.join() === 'Gerenciador/manual.pdf' && !r.dlg, 'confirmar manda para a Lixeira (falsa) e some da árvore', r);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'estilo.css'))`);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'tipos.ts'), { ctrl: true })`);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'dados.zip'), { ctrl: true })`);
  r = await av(`(() => { const ls = [...document.querySelectorAll('#projetos .proj-item, #projetos .arq-no, #projetos .arq-aviso')];
    const s = (el) => !!el && el.getAttribute('aria-selected') === 'true';
    const erradas = ls.filter((el, i) => el.classList.contains('arq-no') && (el.classList.contains('arq-sel-cima') !== (s(el) && s(ls[i - 1])) || el.classList.contains('arq-sel-baixo') !== (s(el) && s(ls[i + 1])))).map((el) => el.dataset.k);
    const sel = ls.filter(s); return { n: sel.length, erradas, sombra: sel.map((el) => getComputedStyle(el).boxShadow).filter((b) => b !== 'none') }; })()`);
  conferir(r.n === 3 && !r.erradas.length && !r.sombra.length, 'seleção múltipla: sem contorno, vizinhas selecionadas viram bloco contínuo', r);
  await av(`__aj.menu(__aj.linha('Gerenciador', 'tipos.ts'))`); await av(`__aj.escolher('Excluir')`);
  r = await av(`({ sub: document.querySelector('.arq-camada .arq-modal-tit p')?.textContent, itens: [...document.querySelectorAll('.arq-camada .arq-itens li')].map((l) => l.textContent) })`);
  conferir(r.sub === '3 itens' && r.itens.length === 3, 'várias selecionadas (Ctrl+clique) → "3 itens"', r);
  await av(`document.querySelector('.arq-b-confirmar').click()`);
  await esperar(`!__aj.linha('Gerenciador', 'tipos.ts') && !__aj.linha('Gerenciador', 'dados.zip')`);
  conferir((await av(`demo.lixeira.length`)) === 4, 'as 3 foram para a Lixeira', await av(`demo.lixeira`));
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'sem-lixeira.txt'))`);
  await av(`__aj.linha('Gerenciador', 'sem-lixeira.txt').focus()`);
  await tecla('Delete');
  await av(`document.querySelector('.arq-b-confirmar').click()`);
  await esperar(`!document.querySelector('.arq-camada .arq-erro')?.hidden`);
  r = await av(`({ e: document.querySelector('.arq-camada .arq-erro')?.textContent, ainda: !!__aj.linha('Gerenciador', 'sem-lixeira.txt'), lix: demo.lixeira.length })`);
  conferir(/Lixeira/.test(r.e || '') && r.ainda && r.lix === 4, '409 sem-lixeira aparece no diálogo e nada sai', r);
  await tecla('Escape');

  // ── 8. Prévia ──
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'servidor.mjs'))`);
  await esperar(`document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'servidor.mjs' && document.querySelectorAll('#arquivo .arq-l').length > 100`);
  r = await av(`(() => { const v = document.getElementById('arquivo'); return { nome: v.querySelector('.arq-cab-nome').textContent, rel: v.querySelector('.arq-cab-rel').textContent, title: v.querySelector('.arq-cab-cam').title,
    linhas: v.querySelectorAll('.arq-l').length, ln: v.querySelector('.arq-l:nth-child(5) .arq-ln').textContent, mono: getComputedStyle(v.querySelector('.arq-codigo')).fontFamily, conteudoOculto: document.querySelector('.conteudo').hidden,
    meta: v.querySelector('.arq-cab-meta')?.textContent }; })()`);
  conferir(r.nome === 'servidor.mjs' && r.rel === 'servidor.mjs' && r.title === 'D:\\Dev\\Projetos\\Gerenciador\\servidor.mjs' && r.conteudoOculto, 'prévia: cabeçalho com nome, caminho relativo e title absoluto', r);
  conferir(r.linhas === 128 && r.ln === '5' && /Geist Mono/.test(r.mono) && /128 linhas/.test(r.meta), 'corpo em mono com números de linha', r);
  r = await av(`(() => { const c = document.querySelector('#arquivo .arq-codigo'); const antes = c.scrollWidth > c.clientWidth; document.querySelector('#arquivo .arq-b-quebra').click(); const depois = c.scrollWidth > c.clientWidth; return { antes, depois, quebra: c.classList.contains('quebra'), p: document.querySelector('#arquivo .arq-b-quebra').getAttribute('aria-pressed') }; })()`);
  conferir(r.antes && !r.depois && r.quebra && r.p === 'true', 'quebra de linha alternável', r);
  await av(`document.querySelector('#arquivo .arq-b-quebra').click()`);
  await av(`document.querySelector('#arquivo .arq-b-copiar').click()`); await dormir(80);
  conferir((await av(`demo.area`)) === 'D:\\Dev\\Projetos\\Gerenciador\\servidor.mjs', 'botão Copiar caminho da prévia');
  await av(`document.querySelector('#arquivo .arq-b-revelar').click()`); await dormir(80);
  conferir((await av(`demo.revelados.includes('Gerenciador:servidor.mjs')`)), 'botão Revelar no Explorador da prévia');
  await foto('02-previa');
  // Atualiza sozinha pelo SSE.
  await av(`demo.escrever('Gerenciador', 'servidor.mjs', 'linha nova\\nsegunda')`);
  await esperar(`document.querySelectorAll('#arquivo .arq-l').length === 2`, 3000);
  conferir((await av(`document.querySelector('#arquivo .arq-l .arq-lt').textContent`)) === 'linha nova', 'prévia atualiza sozinha quando o arquivo muda (SSE)');
  // Pausada (fora da vista) só marca; ao voltar, recarrega.
  await av(`demo.mostrarVista('geral')`);
  await av(`demo.escrever('Gerenciador', 'servidor.mjs', 'um\\ndois\\ntres')`);
  await dormir(500);
  r = await av(`document.querySelectorAll('#arquivo .arq-l').length`);
  await av(`demo.mostrarVista('arquivo')`);
  await esperar(`document.querySelectorAll('#arquivo .arq-l').length === 3`);
  conferir(r === 2 && (await av(`document.querySelectorAll('#arquivo .arq-l').length`)) === 3, 'pausar() segura a atualização; retomar() recarrega', r);
  // Novo arquivo de fora aparece na árvore (pasta aberta).
  await av(`demo.escrever('Gerenciador', 'assets/novo-de-fora.js', 'x')`);
  await esperar(`!!__aj.linha('Gerenciador', 'assets/novo-de-fora.js')`);
  conferir(await av(`!!__aj.linha('Gerenciador', 'assets/novo-de-fora.js')`), 'árvore atualiza sozinha pelo SSE (pasta aberta)');
  // Arquivo aberto que some: nada de GET /arquivos/ler (nem 404 nenhum) — confere pela listagem e mostra o estado.
  const SUMIU = 'Este arquivo foi apagado ou movido';
  const desde = async (n) => av(`demo.reqs.slice(${n})`);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'assets/arquivos.css'))`);
  await esperar(`document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'arquivos.css' && document.querySelectorAll('#arquivo .arq-l').length === 1`);
  let n0 = await av(`demo.reqs.length`);
  await av(`demo.apagar('Gerenciador', 'assets/arquivos.css')`);
  await esperar(`document.querySelector('#arquivo .arq-vazio h3')?.textContent === '${SUMIU}' && !__aj.linha('Gerenciador', 'assets/arquivos.css')`);
  await dormir(200);
  r = await desde(n0);
  conferir((await av(`document.querySelector('#arquivo .arq-vazio h3')?.textContent`)) === SUMIU && !r.some((x) => /\/arquivos\/ler/.test(x[1])) && !r.some((x) => x[2] === 404), 'apagado por fora: estado "apagado ou movido" sem pedir o arquivo e sem 404', r);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'README copy.md'))`);
  await esperar(`document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'README copy.md' && document.querySelectorAll('#arquivo .arq-l').length > 0`);
  await av(`__aj.linha('Gerenciador', 'README copy.md').focus()`);
  await tecla('Delete');
  n0 = await av(`demo.reqs.length`);
  await av(`document.querySelector('.arq-b-confirmar').click()`);
  await esperar(`document.querySelector('#arquivo .arq-vazio h3')?.textContent === '${SUMIU}' && !__aj.linha('Gerenciador', 'README copy.md')`);
  await dormir(500);
  r = await desde(n0);
  conferir(!r.some((x) => x[0] === 'GET' && x[1].includes('README copy.md')) && !r.some((x) => x[2] === 404) && (await av(`document.querySelector('#arquivo .arq-vazio h3')?.textContent`)) === SUMIU, 'excluído pelo Orbit: mesmo estado, nenhuma requisição ao arquivo', r);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'testes'))`);
  await esperar(`!!__aj.linha('Gerenciador', 'testes/edge.mjs')`);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'testes/edge.mjs'))`);
  await esperar(`document.querySelector('#arquivo .arq-cab-nome')?.textContent === 'edge.mjs' && document.querySelectorAll('#arquivo .arq-l').length > 0`);
  n0 = await av(`demo.reqs.length`);
  await av(`demo.apagar('Gerenciador', 'testes')`);
  await esperar(`!__aj.linha('Gerenciador', 'testes') && document.querySelector('#arquivo .arq-vazio h3')?.textContent === '${SUMIU}'`);
  await dormir(300);
  r = await desde(n0);
  conferir(!r.some((x) => x[2] === 404) && !r.some((x) => /\/arquivos\/ler/.test(x[1])) && !(await av(`JSON.parse(localStorage.getItem('orbit.arquivos.abertos')).some((k) => k.endsWith('testes'))`)), 'pasta aberta apagada por fora: some da árvore, prévia dentro dela no estado, sem 404', r);
  // Imagem, svg, binário, grande.
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'assets/logo.png'))`);
  await esperar(`document.querySelector('#arquivo .arq-img')?.complete && document.querySelector('#arquivo .arq-img').naturalWidth > 0`);
  r = await av(`(() => { const i = document.querySelector('#arquivo .arq-img'); return { src: i.src.slice(0, 5), w: i.naturalWidth, leg: document.querySelector('#arquivo .arq-img-leg').textContent }; })()`);
  conferir(r.src === 'blob:' && r.w === 1 && /1 × 1 px/.test(r.leg), 'imagem centralizada com dimensões', r);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'assets/icone.svg'))`);
  await esperar(`document.querySelector('#arquivo .arq-img')?.naturalWidth === 64`);
  conferir(await av(`document.querySelector('#arquivo .arq-img')?.naturalWidth === 64`), 'svg como imagem');
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'assets/Geist-Variable.woff2'))`);
  await esperar(`document.querySelector('#arquivo .arq-vazio h3')?.textContent === 'Arquivo binário'`);
  conferir(await av(`document.querySelector('#arquivo .arq-vazio h3')?.textContent === 'Arquivo binário'`), 'binário: estado vazio explicativo');
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'grande.log'))`);
  await esperar(`document.querySelector('#arquivo .arq-vazio h3')?.textContent === 'Grande demais para a prévia'`);
  conferir(await av(`/3 MB/.test(document.querySelector('#arquivo .arq-vazio p')?.textContent || '')`), 'grande: estado vazio com o tamanho');
  await tecla('Escape');
  conferir(await av(`document.getElementById('arquivo').hidden`), 'Esc (fora de menu/diálogo) volta para a Visão geral');

  // ── 9. Localizar na pasta ──
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Localizar na pasta')`);
  await esperar(`document.activeElement?.classList.contains('arq-busca-input')`);
  r = await av(`({ esc: document.querySelector('#arquivo .arq-cab-rel').textContent, vis: !document.getElementById('arquivo').hidden })`);
  conferir(r.vis && r.esc === 'Gerenciador/', 'busca abre na vista com o escopo', r);
  await digitar('function');
  await dormir(120);
  const cedo = await av(`document.querySelectorAll('#arquivo .arq-res-grupo').length`);
  await esperar(`document.querySelectorAll('#arquivo .arq-res-grupo').length > 0`, 2000);
  r = await av(`({ grupos: [...document.querySelectorAll('#arquivo .arq-res-grupo .arq-res-nome')].map((x) => x.textContent), mark: document.querySelector('#arquivo .arq-res-t mark')?.textContent, st: document.querySelector('#arquivo .arq-busca-status').textContent })`);
  conferir(cedo === 0 && r.grupos.length >= 2 && !r.grupos.includes('index.js') && r.mark.toLowerCase() === 'function', 'busca com atraso, agrupada por arquivo, trecho destacado, pula node_modules', { cedo, ...r });
  conferir(/ocorrências? em \d+ arquivos?/.test(r.st), 'resumo de ocorrências', r.st);
  await av(`document.querySelector('#arquivo .arq-op-maiusculas').click()`);
  await dormir(150);
  await av(`document.querySelector('#arquivo .arq-busca-input').select()`);
  await digitar('(');
  await av(`document.querySelector('#arquivo .arq-op-regex').click()`);
  await esperar(`document.querySelector('#arquivo .arq-busca-status').classList.contains('erro')`);
  conferir(/inválida/.test(await av(`document.querySelector('#arquivo .arq-busca-status').textContent`)), 'regex inválida → mensagem de erro');
  await av(`document.querySelector('#arquivo .arq-op-regex').click()`);
  await av(`document.querySelector('#arquivo .arq-op-maiusculas').click()`);
  await av(`__aj.menu(__aj.linha('Gerenciador', 'brain'))`); await av(`__aj.escolher('Localizar na pasta')`);
  await esperar(`document.querySelector('#arquivo .arq-cab-rel')?.textContent === 'Gerenciador/brain/'`);
  await av(`(() => { const i = document.querySelector('#arquivo .arq-busca-input'); i.value = 'function'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await esperar(`document.querySelectorAll('#arquivo .arq-res-grupo').length > 0`, 2000);
  r = await av(`[...document.querySelectorAll('#arquivo .arq-res-grupo .arq-res-nome')].map((x) => x.textContent)`);
  conferir(r.join() === 'notas.md', 'escopo da pasta', r);
  await av(`document.querySelector('#arquivo .arq-res-linha').click()`);
  await esperar(`document.querySelector('#arquivo .arq-l.arq-destaque')`);
  r = await av(`({ nome: document.querySelector('#arquivo .arq-cab-nome').textContent, n: document.querySelector('#arquivo .arq-l.arq-destaque .arq-ln').textContent })`);
  conferir(r.nome === 'notas.md' && r.n === '3', 'clicar no resultado abre a prévia com a linha destacada', r);

  // ── 10. Seletor de pasta ──
  await av(`document.getElementById('proj-add').click()`);
  await esperar(`document.querySelectorAll('.arq-camada .arq-sp-item').length >= 5`);
  r = await av(`({ t: document.querySelector('.arq-camada h2').textContent, itens: [...document.querySelectorAll('.arq-sp-item')].map((x) => x.textContent), grupos: [...document.querySelectorAll('.arq-sp-grupo')].map((x) => x.textContent), foco: document.activeElement?.getAttribute('aria-label') })`);
  conferir(r.t === 'Adicionar projeto' && r.itens.includes('Área de Trabalho') && r.itens.includes('D:') && r.grupos.join() === 'Atalhos,Unidades' && r.foco === 'Caminho da pasta', 'seletor: atalhos e unidades, foco no campo', r);
  await av(`[...document.querySelectorAll('.arq-sp-item')].find((x) => x.textContent === 'D:').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await esperar(`[...document.querySelectorAll('.arq-sp-item')].some((x) => x.textContent === 'Projetos')`);
  r = await av(`({ campo: document.querySelector('.arq-camada .arq-campo').value, itens: [...document.querySelectorAll('.arq-sp-item')].map((x) => x.textContent), chips: document.querySelectorAll('.arq-chip').length })`);
  conferir(r.campo === 'D:\\' && r.itens.join() === 'Dev,Musicas,Projetos' && r.chips === 5, 'duplo clique entra na unidade', r);
  await av(`[...document.querySelectorAll('.arq-sp-item')].find((x) => x.textContent === 'Projetos').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await esperar(`document.querySelector('.arq-camada .arq-campo').value === 'D:\\\\Projetos'`);
  await av(`document.querySelector('.arq-sp-lista').focus()`);
  await tecla('Backspace');
  await esperar(`document.querySelector('.arq-camada .arq-campo').value === 'D:\\\\'`);
  conferir((await av(`document.querySelector('.arq-camada .arq-campo').value`)) === 'D:\\' && !(await av(`demo.log.includes('pagina-delete')`)), 'Backspace sobe (e não chega à página)');
  await av(`(() => { const c = document.querySelector('.arq-camada .arq-campo'); c.focus(); c.value = 'C:\\\\Users\\\\usuario\\\\AppData\\\\Local\\\\Temp\\\\claude-x'; })()`);
  await av(`document.querySelector('.arq-camada .arq-b-confirmar').click()`);
  await esperar(`!document.querySelector('.arq-camada .arq-erro').hidden`);
  conferir(/temporárias/.test(await av(`document.querySelector('.arq-camada .arq-erro').textContent`)), 'pasta temporária → erro 400 no diálogo');
  await av(`(() => { const c = document.querySelector('.arq-camada .arq-campo'); c.value = 'D:\\\\Nao\\\\Existe'; })()`);
  await av(`document.querySelector('.arq-camada .arq-campo').focus()`);
  await tecla('Enter');
  await esperar(`/não existe/.test(document.querySelector('.arq-camada .arq-erro').textContent)`);
  conferir(await av(`/não existe/.test(document.querySelector('.arq-camada .arq-erro').textContent)`), 'caminho que não existe → erro');
  await av(`(() => { const c = document.querySelector('.arq-camada .arq-campo'); c.value = 'D:\\\\Projetos\\\\nova-ideia'; })()`);
  await tecla('Enter');
  await esperar(`document.querySelector('.arq-camada .arq-campo').value === 'D:\\\\Projetos\\\\nova-ideia' && document.querySelector('.arq-sp-vazio')`);
  await av(`document.querySelector('.arq-camada .arq-b-confirmar').click()`);
  await esperar(`!document.querySelector('.arq-camada') && !!__aj.proj('nova-ideia')`);
  r = await av(`({ lista: Arquivos.projetos().map((p) => p.nome), foco: __aj.ativo(), ordem: [...document.querySelectorAll('#projetos .proj-item')].map((b) => b.dataset.proj) })`);
  conferir(r.lista.includes('nova-ideia') && r.foco === 'proj:nova-ideia' && r.ordem.indexOf('nova-ideia') === r.ordem.indexOf('loja-api') + 1, 'Adicionar põe o projeto na lista (ordem alfabética) e foca a linha', r);

  // ── 11. Remover projeto ──
  await av(`__aj.menu(__aj.proj('nova-ideia'))`); await av(`__aj.escolher('Remover projeto da lista')`);
  r = await av(`({ msg: document.querySelector('.arq-camada .arq-modal-msg')?.textContent, foco: document.activeElement?.textContent, b: document.querySelector('.arq-b-confirmar')?.textContent })`);
  conferir(/Nenhum arquivo é apagado/.test(r.msg || '') && r.foco === 'Cancelar' && r.b === 'Remover da lista', 'remover: confirmação deixa claro que nada é apagado', r);
  await av(`document.querySelector('.arq-b-confirmar').click()`);
  await esperar(`!__aj.proj('nova-ideia')`);
  conferir(!(await av(`Arquivos.projetos().some((p) => p.nome === 'nova-ideia')`)) && (await av(`demo.no('D:\\\\Projetos\\\\nova-ideia')?.tipo === 'pasta'`)), 'saiu da lista; a pasta continua');

  // Captura 1: lateral com a árvore e o menu de uma pasta.
  await av(`demo.mostrarVista('geral')`);
  await av(`__aj.clicar(__aj.linha('Gerenciador', 'assets/arquivos.js'))`);
  await av(`demo.mostrarVista('geral')`);
  await av(`__aj.menu(__aj.linha('Gerenciador', 'brain'))`);
  await dormir(250);
  await foto('01-lateral-menu', { x: 0, y: 0, width: 560, height: 860 });
  await tecla('Escape');

  // ── 12. Recolhida e 420 px ──
  await av(`document.body.classList.add('lat-recolhida')`);
  await dormir(100);
  r = await av(`({ arv: [...document.querySelectorAll('.arq-arvore')].some((a) => a.getClientRects().length), seta: [...document.querySelectorAll('#projetos .arq-seta')].some((a) => a.getClientRects().length), linhas: [...document.querySelectorAll('#projetos .proj-item')].filter((b) => b.getClientRects().length).length })`);
  conferir(!r.arv && !r.seta && r.linhas === 4, 'lateral recolhida: sem árvore e sem seta, só os projetos', r);
  await av(`document.body.classList.remove('lat-recolhida')`);
  await tela(420, 860);
  await dormir(200);
  r = await av(`({ sw: document.documentElement.scrollWidth, arv: [...document.querySelectorAll('.arq-arvore')].some((a) => a.getClientRects().length), seta: [...document.querySelectorAll('#projetos .arq-seta')].some((a) => a.getClientRects().length), linhas: [...document.querySelectorAll('#projetos .proj-item')].filter((b) => b.getClientRects().length).length })`);
  conferir(r.sw <= 420 && !r.arv && !r.seta && r.linhas === 4, '420 px: sem árvore/seta, linhas de projeto como hoje, sem rolagem horizontal', r);
  await av(`demo.mostrarVista('arquivo')`);
  await dormir(150);
  r = await av(`({ sw: document.documentElement.scrollWidth, pw: document.querySelector('.principal').scrollWidth, cw: document.querySelector('.principal').clientWidth })`);
  conferir(r.sw <= 420 && r.pw <= r.cw, '420 px: prévia sem rolagem horizontal da página', r);
  await av(`__aj.menu(__aj.proj('Gerenciador'))`); await av(`__aj.escolher('Localizar na pasta')`);
  await dormir(200);
  r = await av(`({ sw: document.documentElement.scrollWidth, pw: document.querySelector('.principal').scrollWidth, cw: document.querySelector('.principal').clientWidth })`);
  conferir(r.sw <= 420 && r.pw <= r.cw, '420 px: busca sem rolagem horizontal', r);
  await av(`document.getElementById('proj-add').hidden = false`);
  await av(`(() => { document.getElementById('proj-add').click(); })()`);
  await dormir(250);
  r = await av(`(() => { const m = document.querySelector('.arq-modal'); return m ? { w: m.getBoundingClientRect().width, sw: document.documentElement.scrollWidth } : null; })()`);
  conferir(r && r.w <= 420 && r.sw <= 420, '420 px: seletor de pasta cabe', r);
  await tecla('Escape');
  await tela(1280, 860);

  // ── 13. Servidor sem a rota ──
  await abrir('?semrota=1');
  await dormir(300);
  r = await av(`({ p: Arquivos.projetos(), linhas: [...document.querySelectorAll('#projetos .proj-item')].map((b) => b.dataset.proj), meus: document.querySelectorAll('#projetos .arq-proj').length })`);
  conferir(r.p === null && r.meus === 0 && r.linhas.length === 3, 'sem GET /projetos (404): projetos() = null e a lista antiga fica', r);

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
