// Teste do painel de estilo do Whiteboard (assets/whiteboard-estilo.js) contra testes/whiteboard-demo.html.
// Servidor estático próprio numa porta livre de 47822–47826, Edge headless mudo, perfil temporário apagado no fim,
// Edge fechado com fecharEdge.   node testes/whiteboard-estilo-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-est-'));
const CAPTURA = path.join(os.tmpdir(), 'orbit-wb-est-painel.png');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

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
  pcdp = 9750 + Math.floor(Math.random() * 100);
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
  const mouse = (type, x, y, button = 'none', buttons = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers: 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const arrastar = async (x0, y0, x1, y1) => {
    await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, 'left', 1); await dormir(15); }
    await mouse('mouseReleased', x1, y1, 'left', 0); await dormir(80);
  };
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(250);
  };
  const get = (id) => av(`JSON.parse(JSON.stringify(Whiteboard.nucleo.elemento(${JSON.stringify(id)})))`);
  const visivel = () => av(`(() => { const p = document.querySelector('.wb-est'); return !!p && !p.hasAttribute('data-fora'); })()`);
  const esperarVisivel = async (v) => esperar(`(() => { const p = document.querySelector('.wb-est'); return !!p && (!p.hasAttribute('data-fora')) === ${v}; })()`, 2000);
  // clica num controle do painel por aria-label
  const clicar = async (rot) => {
    const ok = await av(`(() => { const b = [...document.querySelectorAll('.wb-est button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(rot)} && !x.hidden && !x.closest('[hidden]')); if (!b) return false; b.click(); return true; })()`);
    await dormir(70);
    return ok;
  };
  const pressionado = (rot) => av(`(() => { const b = [...document.querySelectorAll('.wb-est button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(rot)}); return b ? b.getAttribute('aria-pressed') : null; })()`);
  const secVisivel = (n) => av(`(() => { const s = document.querySelector('.wb-est .wb-est-sec:nth-child(${n})'); return !!s && !s.hidden; })()`);
  const rotulos = () => av(`__rot`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir('?vazio=1');
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const pal = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const L = pal.l, T = pal.t;
  await av(`window.__rot = []; Whiteboard.nucleo.on('confirmar', (d) => __rot.push(d.rotulo));`);

  const base = (o) => ({ tipo: 'retangulo', x: 400, y: 200, w: 120, h: 80, angulo: 0, cor: '#7aa2ff', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, ...o });
  const cena = async (lista, sel) => {
    await av(`(() => { const n = Whiteboard.nucleo; n.remover(n.elementos().map((e) => e.id)); for (const e of ${JSON.stringify(lista)}) n.adicionar(e); n.selecionar(${JSON.stringify(sel)}); n.redesenhar(); window.__rot = []; })()`);
    await dormir(120);
  };

  // ── Aparece / some ──
  conferir(await av(`!!document.querySelector('.wb-vista .wb-est')`), 'o painel é montado dentro da vista');
  await cena([base({ id: 'a' }), base({ id: 'b', x: 600, cor: '#ff9592' })], []);
  conferir(await esperarVisivel(false), 'sem seleção e com a ferramenta Selecionar o painel fica oculto');
  await av(`Whiteboard.nucleo.selecionar(['a'])`);
  conferir(await esperarVisivel(true), 'com seleção o painel aparece');
  await av(`Whiteboard.nucleo.selecionar([])`);
  conferir(await esperarVisivel(false), 'ao limpar a seleção o painel some');
  await av(`Whiteboard.nucleo.definirFerramenta('retangulo')`);
  conferir(await esperarVisivel(true), 'ferramenta de desenho ativa mostra o painel');
  await av(`Whiteboard.nucleo.definirFerramenta('mao')`);
  conferir(await esperarVisivel(false), 'ferramenta Mão esconde o painel');
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);

  // ── Seleção única: reflete e aplica ──
  await cena([base({ id: 'a' }), base({ id: 'b', x: 600, cor: '#ff9592' })], ['a']);
  await esperarVisivel(true);
  conferir(await secVisivel(1) && await secVisivel(2) && !(await secVisivel(3)), 'retângulo: seções de cor e preenchimento visíveis, fundo da nota oculto');
  conferir((await pressionado('Espessura média')) === 'true', 'reflete a espessura média da seleção');
  conferir((await pressionado('Traço sólido')) === 'true', 'reflete o traço sólido');
  conferir((await pressionado('Sem preenchimento')) === 'true', 'reflete "sem preenchimento"');

  conferir(await clicar('Cor do traço: Verde'), 'clica na cor verde');
  let a = await get('a');
  conferir(a.cor === '#3dd68c', 'cor aplicada à seleção', a.cor);
  conferir((await rotulos()).includes('Estilo'), 'cor termina em confirmar("Estilo")', await rotulos());
  conferir((await pressionado('Cor do traço: Verde')) === 'true', 'cor verde marcada como pressionada');
  conferir((await get('b')).cor === '#ff9592', 'outro elemento não foi alterado');

  await clicar('Espessura grossa'); a = await get('a');
  conferir(a.traco.largura === 4 && a.traco.estilo === 'solido', 'espessura grossa (4) sem mexer no estilo', a.traco);
  await clicar('Traço tracejado'); a = await get('a');
  conferir(a.traco.estilo === 'tracejado' && a.traco.largura === 4, 'estilo tracejado sem mexer na espessura', a.traco);
  await clicar('Traço pontilhado'); a = await get('a');
  conferir(a.traco.estilo === 'pontilhado', 'estilo pontilhado', a.traco);
  await clicar('Preenchimento: Azul'); a = await get('a');
  conferir(typeof a.preenchimento === 'string' && /^rgba\(112, 184, 255/.test(a.preenchimento), 'preenchimento suave aplicado', a.preenchimento);
  await clicar('Sem preenchimento'); a = await get('a');
  conferir(a.preenchimento === null, 'preenchimento removido', a.preenchimento);

  // opacidade pelo controle deslizante (teclado: seta esquerda reduz 5)
  await av(`(() => { const r = document.querySelector('.wb-est input[type=range]'); r.focus(); r.value = '40'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await dormir(80);
  a = await get('a');
  conferir(Math.abs(a.opacidade - 0.4) < 1e-6, 'opacidade 40% pelo controle deslizante', a.opacidade);
  conferir((await rotulos()).filter((r) => r === 'Estilo').length >= 6, 'cada mudança confirma "Estilo"', await rotulos());

  // ── Valor misto ──
  await cena([base({ id: 'a', cor: '#3dd68c' }), base({ id: 'b', x: 600, cor: '#ff9592', traco: { largura: 4, estilo: 'solido' } })], ['a', 'b']);
  await dormir(100);
  conferir((await pressionado('Cor do traço: Verde')) === 'false' && (await pressionado('Cor do traço: Vermelho')) === 'false', 'cor mista: nenhuma amostra marcada');
  conferir(await av(`!document.querySelector('.wb-est-sec .wb-est-misto').hidden`), 'cor mista mostra o aviso "misto"');
  conferir((await pressionado('Traço sólido')) === 'true', 'traço igual nos dois continua marcado');
  conferir((await pressionado('Espessura média')) === 'false' && (await pressionado('Espessura grossa')) === 'false', 'espessura mista: nenhuma marcada');
  await clicar('Cor do traço: Azul');
  conferir((await get('a')).cor === '#70b8ff' && (await get('b')).cor === '#70b8ff', 'aplicar com 2 selecionados altera os dois');
  conferir((await pressionado('Cor do traço: Azul')) === 'true', 'depois de aplicar o valor deixa de ser misto');
  const cr = await av(`[...document.querySelectorAll('.wb-est button')].filter((x) => x.getAttribute('aria-label').startsWith('Cor do traço')).length`);
  conferir(cr === 8, 'paleta com 8 cores', cr);

  // cor fora da paleta aparece como amostra extra
  await cena([base({ id: 'a', cor: '#123456' })], ['a']);
  conferir(await av(`(() => { const b = document.querySelector('.wb-est button[aria-label^="Cor atual"]'); return !!b && !b.hidden && b.getAttribute('aria-pressed') === 'true'; })()`), 'cor fora da paleta aparece como "cor atual"');

  // ── Sem seleção: estilo das próximas formas ──
  await cena([], []);
  await av(`Whiteboard.nucleo.definirFerramenta('retangulo')`);
  await esperarVisivel(true);
  await clicar('Cor do traço: Laranja');
  await clicar('Espessura fina');
  await clicar('Traço tracejado');
  await clicar('Preenchimento: Verde');
  const est = await av(`Whiteboard.nucleo.estiloAtual()`);
  conferir(est.cor === '#ff9a1f' && est.traco.largura === 1 && est.traco.estilo === 'tracejado' && /^rgba\(61, 214, 140/.test(est.preenchimento), 'sem seleção: muda o estilo atual', est);
  conferir((await rotulos()).length === 0, 'sem seleção não chama confirmar', await rotulos());
  conferir((await pressionado('Espessura fina')) === 'true', 'sem seleção o painel reflete o estilo atual');
  await av(`(() => { const r = document.querySelector('.wb-est input[type=range]'); r.value = '60'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  conferir(Math.abs((await av(`Whiteboard.nucleo.estiloAtual().opacidade`)) - 0.6) < 1e-6, 'sem seleção: opacidade vai ao estilo atual');
  await arrastar(L + 400, T + 300, L + 520, T + 380);
  const novos = await av(`JSON.parse(JSON.stringify(Whiteboard.nucleo.elementos()))`);
  const nv = novos[0];
  conferir(novos.length === 1 && nv && nv.cor === '#ff9a1f' && nv.traco.largura === 1 && nv.traco.estilo === 'tracejado' && Math.abs(nv.opacidade - 0.6) < 1e-6, 'a próxima forma desenhada usa o estilo escolhido', novos);

  // ── Texto e nota ──
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);
  await cena([
    { tipo: 'texto', id: 't', x: 100, y: 100, w: 120, h: 30, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, texto: { valor: 'Olá', tamanho: 20, alinhar: 'esquerda' } },
    { tipo: 'nota', id: 'n', x: 300, y: 100, w: 200, h: 200, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: '#463a1e', opacidade: 1, texto: { valor: 'Nota', tamanho: 16, alinhar: 'esquerda' } },
  ], ['t']);
  await dormir(100);
  conferir(await av(`!document.querySelector('.wb-est button[aria-label^="Tamanho"]').closest('.wb-est-sec').hidden`), 'texto: seção de tamanho/alinhamento visível');
  conferir(await av(`document.querySelector('.wb-est button[aria-label^="Espessura"]').closest('.wb-est-sec').hidden`), 'texto: espessura oculta');
  conferir((await pressionado('Tamanho M')) === 'true' && (await pressionado('Alinhar texto: esquerda')) === 'true', 'texto: reflete tamanho M e alinhamento à esquerda');
  await clicar('Tamanho XG'); await clicar('Alinhar texto: centro');
  let t = await get('t');
  conferir(t.texto.tamanho === 48 && t.texto.alinhar === 'centro' && t.texto.valor === 'Olá', 'tamanho XG e alinhamento centro no texto (valor preservado)', t.texto);

  await av(`Whiteboard.nucleo.selecionar(['n'])`);
  await dormir(100);
  conferir(await av(`!document.querySelector('.wb-est button[aria-label^="Fundo da nota"]').closest('.wb-est-sec').hidden`), 'nota: seção de fundo visível');
  await clicar('Fundo da nota: Azul');
  const n = await get('n');
  conferir(/^#[0-9a-f]{6}$/.test(n.preenchimento) && n.preenchimento !== '#463a1e', 'fundo da nota aplicado', n.preenchimento);
  await clicar('Tamanho P');
  conferir((await get('n')).texto.tamanho === 14, 'tamanho P na nota');

  // ── Botões de ações (stub: Whiteboard é congelado; troca-se o objeto global por uma cópia com acoes falsas e restaura-se depois) ──
  await av(`window.__ac = []; window.__WB0 = window.__WB0 || window.Whiteboard; window.Whiteboard = Object.assign({}, window.Whiteboard, { acoes: { agrupar: () => __ac.push('agrupar'), desagrupar: () => __ac.push('desagrupar'), duplicar: () => __ac.push('duplicar'), apagar: () => __ac.push('apagar'),
    alinhar: (l) => __ac.push('alinhar:' + l), distribuir: (e) => __ac.push('distribuir:' + e), camada: (c) => __ac.push('camada:' + c) } });`);
  await cena([base({ id: 'a' }), base({ id: 'b', x: 600 }), base({ id: 'c', x: 800, grupo: 'g1' })], ['a', 'b', 'c']);
  await dormir(100);
  for (const r of ['Trazer para frente', 'Subir uma camada', 'Descer uma camada', 'Enviar para trás', 'Alinhar à esquerda', 'Centralizar na vertical', 'Distribuir na horizontal', 'Agrupar', 'Desagrupar', 'Duplicar', 'Apagar']) await clicar(r);
  const ac = await av(`__ac`);
  conferir(JSON.stringify(ac) === JSON.stringify(['camada:frente', 'camada:subir', 'camada:descer', 'camada:trás', 'alinhar:esquerda', 'alinhar:centroV', 'distribuir:h', 'agrupar', 'desagrupar', 'duplicar', 'apagar']), 'os botões chamam Whiteboard.acoes na ordem certa', ac);
  // ação inexistente: o botão some
  await av(`delete Whiteboard.acoes.duplicar; delete Whiteboard.acoes.distribuir; Whiteboard.nucleo.selecionar(['a','b'])`);
  await dormir(120);
  conferir(await av(`(() => { const f = (r) => { const b = document.querySelector('.wb-est button[aria-label="' + r + '"]'); return !b || b.hidden || !!b.closest('[hidden]'); }; return f('Duplicar') && f('Distribuir na horizontal') && !f('Apagar'); })()`), 'botão some quando a ação não existe (e os outros ficam)');
  // alinhar só com 2+
  await av(`Whiteboard.nucleo.selecionar(['a'])`);
  await dormir(100);
  conferir(await av(`(() => { const b = document.querySelector('.wb-est button[aria-label="Alinhar à esquerda"]'); return !b || b.hidden || !!b.closest('[hidden]'); })()`), 'alinhar/distribuir só aparecem com 2 ou mais selecionados');
  await av(`window.Whiteboard = window.__WB0`);

  // ── Acessibilidade ──
  conferir(await av(`[...document.querySelectorAll('.wb-est button')].every((b) => b.getAttribute('aria-label') && b.type === 'button')`), 'todos os botões têm aria-label');
  conferir(await av(`[...document.querySelectorAll('.wb-est .wb-est-cor, .wb-est .wb-est-seg button')].every((b) => b.hasAttribute('aria-pressed'))`), 'amostras e segmentos têm aria-pressed');
  await cena([base({ id: 'a' })], ['a']);
  await dormir(100);
  await av(`document.querySelector('.wb-est button:not([hidden])').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await dormir(60);
  conferir(await av(`!!document.activeElement.closest('.wb-est') && document.activeElement !== document.querySelector('.wb-est button')`), 'Tab move o foco entre os controles do painel');
  await av(`document.querySelector('.wb-est button[aria-label="Cor do traço: Roxo"]').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await dormir(100);
  conferir((await get('a')).cor === '#baa7ff', 'Enter numa amostra com foco aplica a cor', (await get('a')).cor);
  conferir(await av(`getComputedStyle(document.querySelector('.wb-est')).borderRadius === '14px'`), 'painel com raio 14');

  // ── Captura única do painel ──
  await cena([base({ id: 'a', cor: '#70b8ff', preenchimento: 'rgba(112, 184, 255, 0.22)' }), base({ id: 'b', x: 600 })], ['a', 'b']);
  await av(`window.Whiteboard = Object.assign({}, window.__WB0, { acoes: { agrupar(){}, desagrupar(){}, duplicar(){}, apagar(){}, alinhar(){}, distribuir(){}, camada(){} } }); Whiteboard.nucleo.selecionar(['a','b'])`);
  await dormir(500);
  const r = await av(`(() => { const b = document.querySelector('.wb-est').getBoundingClientRect(); return { x: b.left - 6, y: b.top - 6, width: b.width + 12, height: b.height + 12 }; })()`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  if (shot.result?.data) fs.writeFileSync(CAPTURA, Buffer.from(shot.result.data, 'base64'));
  await av(`window.Whiteboard = window.__WB0`);

  conferir(consoleErros.length === 0, 'console sem erros nem avisos', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws?.close(); } catch {}
  try { await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  await dormir(300);
  try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch {}
}

console.log(`\nwhiteboard-estilo-ui: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (fs.existsSync(CAPTURA)) console.log('captura: ' + CAPTURA);
process.exit(res.falhas.length ? 1 : 0);
