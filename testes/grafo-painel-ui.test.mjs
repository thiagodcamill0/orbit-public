// Teste do painel de opções do grafo (assets/grafo-painel.js) contra testes/grafo-painel-demo.html.
// Cada controle dispara aoMudar com a chave certa e o valor novo; a busca espera 250 ms; "Saltos" só existe no modo local.
// Servidor estático próprio (só GET) numa porta livre de 47822–47826, Edge headless mudo, perfil temporário apagado no fim.
// node testes/grafo-painel-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grafo-painel-'));
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
const URL_DEMO = `http://127.0.0.1:${PORTA}/testes/grafo-painel-demo.html`;

let pcdp, ws;
try {
  pcdp = 9600 + Math.floor(Math.random() * 150);
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
  const esperar = async (expr, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(30); } return false; };
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete' && !!window.demo && !!window.demo.painel && !!document.querySelector('.gp-painel')`, 8000);
  };
  // utilitários dentro da página
  const lib = `
    window.lin = (rot) => [...document.querySelectorAll('.gp-lin')].find((l) => l.querySelector('.gp-rot')?.textContent.trim() === rot);
    window.chaveEl = (rot) => lin(rot).querySelector('button.gp-chave');
    window.slider = (rot) => lin(rot).querySelector('input[type=range]');
    window.ultimo = () => demo.eventos[demo.eventos.length - 1];
    window.abrirSecao = (t) => { const b = [...document.querySelectorAll('.gp-sec')].find((x) => x.textContent.trim() === t); if (b.getAttribute('aria-expanded') !== 'true') b.click(); };
    true`;

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(lib);

  // ── 1. Estrutura ──
  let r = await av(`({ secs: [...document.querySelectorAll('.gp-sec')].map((b) => b.textContent.trim()), busca: !!document.querySelector('input[type=search]'),
    chaves: [...document.querySelectorAll('button.gp-chave')].map((b) => b.getAttribute('aria-checked')), eventos: demo.eventos.length })`);
  conferir(JSON.stringify(r.secs) === JSON.stringify(['Filtros', 'Grupos', 'Exibição', 'Forças']), 'seções Filtros, Grupos, Exibição e Forças (sem Grafo local no modo global)', r.secs);
  conferir(r.eventos === 0 && r.busca, 'montar o painel não dispara aoMudar', r);
  conferir(!(await av(`!!lin('Saltos')`)) && !(await av(`document.body.textContent.includes('Grafo local')`)), 'Saltos só existe no modo local (ausente no global)');
  await av(`abrirSecao('Grupos'); abrirSecao('Exibição'); abrirSecao('Forças'); true`);

  // ── 2. Interruptores ──
  const chaves = [['Tags', 'tags', true], ['Anexos', 'anexos', true], ['Só existentes', 'soExistentes', true], ['Órfãos', 'orfaos', false], ['Setas', 'setas', true]];
  for (const [rot, k, novo] of chaves) {
    await av(`chaveEl(${JSON.stringify(rot)}).click(); true`);
    r = await av(`({ u: ultimo(), pressionado: chaveEl(${JSON.stringify(rot)}).getAttribute('aria-checked') })`);
    conferir(r.u && r.u[0] === k && r.u[1][k] === novo && r.pressionado === String(novo), `interruptor "${rot}" dispara aoMudar('${k}') com ${novo}`, r);
  }
  const n0 = await av(`demo.eventos.length`);
  await av(`chaveEl('Tags').click(); true`);
  r = await av(`ultimo()`);
  conferir(r[0] === 'tags' && r[1].tags === false && (await av(`demo.eventos.length`)) === n0 + 1, 'clicar de novo desliga e dispara uma única vez', r);
  // clicar no rótulo também alterna
  await av(`lin('Setas').querySelector('.gp-rot').click(); true`);
  r = await av(`ultimo()`);
  conferir(r[0] === 'setas' && r[1].setas === false, 'clicar no rótulo alterna o interruptor', r);

  // ── 3. Deslizantes ──
  const desl = [['Fade do texto', 'fadeTexto', -3, 3, 0.1, -1.5], ['Tamanho do nó', 'tamanhoNo', 0.1, 5, 0.01, 2.5], ['Espessura do link', 'espessuraLink', 0.1, 5, 0.01, 3.25],
    ['Força do centro', 'centro', 0, 1, 0.01, 0.75], ['Força de repulsão', 'repulsao', 0, 20, 0.1, 14.5], ['Força dos links', 'link', 0, 1, 0.01, 0.4], ['Distância dos links', 'distancia', 30, 500, 1, 321]];
  for (const [rot, k, min, max, passo, valor] of desl) {
    r = await av(`(() => { const s = slider(${JSON.stringify(rot)}); s.value = ${valor}; s.dispatchEvent(new Event('input', { bubbles: true })); return { min: +s.min, max: +s.max, step: +s.step, u: ultimo(), val: lin(${JSON.stringify(rot)}).querySelector('output').textContent }; })()`);
    conferir(r.min === min && r.max === max && r.step === passo, `deslizante "${rot}" tem faixa ${min}–${max} passo ${passo}`, r);
    conferir(r.u && r.u[0] === k && Math.abs(r.u[1][k] - valor) < 1e-9 && r.val.length > 0, `deslizante "${rot}" dispara aoMudar('${k}') com ${valor} e atualiza o valor mostrado`, r);
  }
  r = await av(`(() => { const s = slider('Distância dos links'); s.value = 999; return +s.value; })()`);
  conferir(r === 500, 'o deslizante respeita o máximo da faixa', r);

  // ── 4. Grupos ──
  await av(`document.querySelector('.gp-novo-grupo').click(); true`);
  r = await av(`({ u: ultimo(), n: document.querySelectorAll('.gp-grupo').length })`);
  conferir(r.u[0] === 'grupos' && r.u[1].grupos.length === 1 && /^#[0-9a-f]{6}$/i.test(r.u[1].grupos[0].cor) && r.n === 1, 'Novo grupo adiciona um grupo com cor e dispara aoMudar(\'grupos\')', r);
  await av(`(() => { const q = document.querySelector('.gp-grupo input[type=text]'); q.value = 'tag:#ideia'; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  r = await av(`ultimo()`);
  conferir(r[0] === 'grupos' && r[1].grupos[0].consulta === 'tag:#ideia', 'editar a consulta do grupo dispara aoMudar(\'grupos\')', r);
  await av(`(() => { const c = document.querySelector('.gp-grupo input[type=color]'); c.value = '#ff0000'; c.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  r = await av(`ultimo()`);
  conferir(r[0] === 'grupos' && r[1].grupos[0].cor === '#ff0000', 'trocar a cor do grupo dispara aoMudar(\'grupos\')', r);
  await av(`document.querySelector('.gp-rem').click(); true`);
  r = await av(`({ u: ultimo(), n: document.querySelectorAll('.gp-grupo').length })`);
  conferir(r.u[0] === 'grupos' && r.u[1].grupos.length === 0 && r.n === 0, 'remover o grupo dispara aoMudar(\'grupos\') com a lista vazia', r);

  // ── 5. Timelapse e restaurar ──
  await av(`document.querySelector('.gp-timelapse').click(); true`);
  conferir((await av(`demo.timelapse`)) === 1, 'botão Timelapse chama aoTimelapse');
  const nAntes = await av(`demo.eventos.length`);
  await av(`document.querySelector('.gp-restaurar').click(); true`);
  conferir((await av(`demo.restaurou`)) === 1 && (await av(`demo.eventos.length`)) === nAntes, 'botão Restaurar chama aoRestaurar (sem aoMudar)');

  // ── 6. definir() não dispara aoMudar e atualiza os controles ──
  await av(`demo.eventos.length = 0; demo.painel.definir(Object.assign({}, demo.PADRAO, { tags: true, repulsao: 4, busca: 'abc', grupos: [{ consulta: 'x', cor: '#00ff00' }] })); true`);
  await dormir(400);
  r = await av(`({ n: demo.eventos.length, tags: chaveEl('Tags').getAttribute('aria-checked'), rep: slider('Força de repulsão').value, busca: document.querySelector('input[type=search]').value, grupos: document.querySelectorAll('.gp-grupo').length })`);
  conferir(r.n === 0 && r.tags === 'true' && r.rep === '4' && r.busca === 'abc' && r.grupos === 1, 'definir() atualiza os controles sem disparar aoMudar', r);
  await av(`demo.painel.definir(demo.PADRAO); true`);

  // ── 7. Busca espera 250 ms ──
  await av(`demo.eventos.length = 0; window.t0 = performance.now(); const b = document.querySelector('input[type=search]'); b.value = 'abc'; b.dispatchEvent(new Event('input', { bubbles: true })); true`);
  await dormir(120);
  conferir((await av(`demo.eventos.length`)) === 0, 'a busca não dispara antes da espera (120 ms)');
  conferir(await esperar(`demo.eventos.length === 1`, 2000), 'a busca dispara depois da espera');
  r = await av(`({ chave: demo.eventos[0][0], busca: demo.eventos[0][1].busca, atraso: demo.eventos[0][2] - t0 })`);
  conferir(r.chave === 'busca' && r.busca === 'abc' && r.atraso >= 240 && r.atraso < 700, 'aoMudar(\'busca\') chega com o texto, ~250 ms depois', r);
  // digitar em sequência junta tudo numa só chamada, 250 ms depois da última tecla
  await av(`demo.eventos.length = 0; (async () => { const b = document.querySelector('input[type=search]'); for (const v of ['abcd', 'abcde', 'abcdef']) { b.value = v; b.dispatchEvent(new Event('input', { bubbles: true })); window.t1 = performance.now(); await new Promise((r) => setTimeout(r, 100)); } })(); true`);
  await dormir(150);
  conferir((await av(`demo.eventos.length`)) === 0, 'digitando em sequência nada dispara enquanto as teclas continuam');
  conferir(await esperar(`demo.eventos.length === 1`, 2000), 'depois da pausa dispara uma única vez');
  await dormir(400);
  r = await av(`({ n: demo.eventos.length, busca: demo.eventos[0][1].busca, atraso: demo.eventos[0][2] - t1 })`);
  conferir(r.n === 1 && r.busca === 'abcdef' && r.atraso >= 240, 'só o último texto é enviado, 250 ms depois da última tecla', r);
  // Enter envia na hora
  await av(`demo.eventos.length = 0; (() => { const b = document.querySelector('input[type=search]'); b.focus(); b.value = 'zzz'; b.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); true`);
  r = await av(`({ n: demo.eventos.length, busca: demo.eventos[0] && demo.eventos[0][1].busca })`);
  conferir(r.n === 1 && r.busca === 'zzz', 'Enter envia a busca imediatamente', r);
  await dormir(400);
  conferir((await av(`demo.eventos.length`)) === 1, 'e a espera pendente é cancelada (sem segundo envio)');

  // ── 8. Recolher/abrir e Esc ──
  await av(`document.querySelector('.gp-fechar').click(); true`);
  r = await av(`({ rec: document.querySelector('.gp').classList.contains('gp-recolhido'), exp: document.querySelector('.gp-eng').getAttribute('aria-expanded') })`);
  conferir(r.rec && r.exp === 'false', 'botão fechar recolhe o painel', r);
  await av(`document.querySelector('.gp-eng').click(); true`);
  conferir(!(await av(`document.querySelector('.gp').classList.contains('gp-recolhido')`)), 'botão de engrenagem reabre o painel');
  await av(`document.querySelector('input[type=search]').focus(); true`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(100);
  conferir(await av(`document.querySelector('.gp').classList.contains('gp-recolhido')`), 'Esc dentro do painel recolhe');

  // ── 9. Modo local: Saltos e os três interruptores ──
  await abrir('?local=1');
  await av(lib);
  conferir(await av(`!!lin('Saltos') && document.body.textContent.includes('Grafo local')`), 'no modo local aparece a seção Grafo local com Saltos');
  r = await av(`(() => { const s = slider('Saltos'); s.value = 3; s.dispatchEvent(new Event('input', { bubbles: true })); return { min: +s.min, max: +s.max, step: +s.step, u: ultimo() }; })()`);
  conferir(r.min === 1 && r.max === 5 && r.step === 1 && r.u[0] === 'local' && r.u[1].local.profundidade === 3, 'Saltos (1–5) dispara aoMudar(\'local\') com a profundidade', r);
  for (const [rot, k] of [['Links de entrada', 'entrada'], ['Links de saída', 'saida'], ['Links entre vizinhos', 'vizinhos']]) {
    r = await av(`(() => { chaveEl(${JSON.stringify(rot)}).click(); return ultimo(); })()`);
    conferir(r[0] === 'local' && r[1].local[k] === false, `"${rot}" dispara aoMudar('local') com ${k} desligado`, r);
  }
  r = await av(`ultimo()[1].local`);
  conferir(r.profundidade === 3 && r.entrada === false && r.saida === false && r.vizinhos === false, 'as opções locais acumulam entre as mudanças', r);

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nGrafo painel UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
