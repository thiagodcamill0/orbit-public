// Teste dos cards de agentes (assets/whiteboard-agentes.js) contra testes/whiteboard-demo.html (fonte falsa window.OrbitFonteSessoes
// + window.demoSessoes para mudar/remover sessões). Servidor estático próprio (só GET) numa porta livre de 47822–47826,
// Edge headless mudo, perfil temporário apagado, fecharEdge no fim. CAPTURA=caminho.png grava uma captura pequena (opcional).
// node testes/whiteboard-agentes-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-ag-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47825);
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
  const card = (sid) => av(`(() => { const c = Whiteboard.agentes.cards().find((x) => x.sessao === '${sid}'); if (!c) return null;
    const no = document.querySelector('.wb-no[data-id="' + c.id + '"]'); const q = (s) => no && no.querySelector(s);
    const img = q('.wb-ag-img:last-of-type');
    return { ...c, no: !!no, nome: q('.wb-ag-nome')?.textContent, proj: q('.wb-ag-proj')?.textContent, st: q('.wb-ag-st-t')?.textContent, pct: q('.wb-ag-ctx')?.hidden ? null : q('.wb-ag-pct')?.textContent,
      faixa: q('.wb-ag-ctx')?.className, ativ: q('.wb-ag-ativ')?.textContent, img: img && img.getAttribute('src'), fim: no && no.classList.contains('wb-ag-fim'), vivoAttr: no && no.dataset.vivo,
      destaque: no && no.classList.contains('wb-ag-destaque'), op: no && getComputedStyle(no.querySelector('.wb-ag-c')).opacity }; })()`);
  const pop = () => av(`(() => { const p = document.querySelector('.wb-ag-pop'); return p ? { txt: p.textContent, id: Whiteboard.agentes.detalhesAbertos() } : null; })()`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await resetCam();
  const of = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  const T = (x, y) => [of.l + x, of.t + y]; // mundo (zoom 1, câmera 0) → tela
  await av(`window.rotulos = []; Whiteboard.nucleo.on('confirmar', (d) => rotulos.push(d && d.rotulo))`);

  conferir((await av(`!!(Whiteboard.agentes && Whiteboard.agentes.adicionar && Whiteboard.agentes.cards)`)), 'Whiteboard.agentes publicado');
  const ferrs = await av(`[...document.querySelectorAll('.wb-barra .wb-ferr')].map((b) => b.dataset.ferramenta)`);
  conferir(!ferrs.some((f) => /agente/.test(f)), 'nenhuma ferramenta nova na barra', ferrs);

  // ── 1. Soltar uma sessão no palco (CDP Input.dispatchDragEvent; reserva: evento sintético) ──
  const dados = (id) => ({ items: [{ mimeType: 'application/x-orbit-sessao', data: id }, { mimeType: 'text/plain', data: id }], dragOperationsMask: 1 });
  const soltarCdp = async (id, x, y, conferirRealce) => {
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dados(id) });
    await cdp('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dados(id) });
    await dormir(60);
    const realce = conferirRealce ? await av(`document.querySelector('.wb-palco').classList.contains('wb-ag-alvo')`) : null;
    await cdp('Input.dispatchDragEvent', { type: 'drop', x, y, data: dados(id) });
    await dormir(150);
    return realce;
  };
  const soltarSintetico = (id, x, y) => av(`(() => { const p = document.querySelector('.wb-palco'); const dt = new DataTransfer(); dt.setData('application/x-orbit-sessao', '${id}'); dt.setData('text/plain', '${id}');
    for (const t of ['dragenter', 'dragover', 'drop']) p.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, dataTransfer: dt })); return true; })()`);
  let realce = await soltarCdp('s1', ...T(400, 300), true);
  let via = 'cdp';
  if (!(await cards()).length) { via = 'sintético'; await soltarSintetico('s1', ...T(400, 300)); await dormir(150); realce = null; }
  let c1 = await card('s1');
  conferir(c1 && perto(c1.x + c1.w / 2, 400, 2) && perto(c1.y + c1.h / 2, 300, 2) && c1.w === 260, `soltar (${via}) cria o card centrado no ponto`, c1);
  conferir(realce !== false && !(await av(`document.querySelector('.wb-palco').classList.contains('wb-ag-alvo')`)), 'realce do palco no dragover e some ao soltar', { realce });
  conferir(c1 && c1.nome === 'Refatorar o grafo' && c1.proj === 'Orbit' && c1.st === 'Trabalhando' && c1.status === 'trabalhando' && c1.pct === '42%' && /sprite-work\.gif$/.test(c1.img || ''), 'card com nome, projeto, status, contexto e sprite certos', c1);
  conferir(c1 && c1.resumo.nome === 'Refatorar o grafo' && c1.resumo.projeto === 'Orbit' && c1.resumo.status === 'trabalhando', 'sessao.resumo guardado', c1 && c1.resumo);
  let r = await av(`({ sel: Whiteboard.nucleo.selecao(), rot: rotulos.slice(), f: Whiteboard.nucleo.ferramenta() })`);
  conferir(c1 && r.sel.length === 1 && r.sel[0] === c1.id && r.rot.includes('adicionar agente'), 'card selecionado e confirmar("adicionar agente")', r);
  conferir((await av(`Whiteboard.agentes.ouvindo() && demoSessoes.ouvintes() === 1`)), 'ouve a fonte enquanto há card (um ouvinte só)');

  // ── 2. Ao vivo ──
  await av(`Whiteboard.agentes.adicionar('s2', 800, 300)`);
  await dormir(100);
  await av(`window.__no1 = document.querySelector('.wb-no[data-id="${c1.id}"]'); window.__no2 = document.querySelector('.wb-no[data-id="' + Whiteboard.agentes.cards()[1].id + '"]'); window.__n2 = 0;
    new MutationObserver((ms) => { window.__n2 += ms.length; }).observe(__no2, { subtree: true, childList: true, characterData: true, attributes: true })`);
  const passos0 = await av(`(() => { let p = 0; const d = Whiteboard.nucleo.on('historico', (x) => { p = x.passos; }); return Whiteboard.nucleo.podeDesfazer(); })()`);
  await av(`window.__h = []; Whiteboard.nucleo.on('historico', (x) => __h.push(x.passos)); window.__rot0 = rotulos.length`);
  await av(`demoSessoes.mudar('s1', { status: 'aguardando', statusTexto: 'Aguardando você', sprite: '../assets/sprites/sprite-needu.gif', contexto: { tokens: 180000, limite: 200000, pct: 0.9 }, atividade: 'Pergunta: qual caminho seguir?', nome: 'Grafo novo' })`);
  await dormir(120);
  c1 = await card('s1');
  conferir(c1.status === 'aguardando' && c1.st === 'Aguardando você' && c1.pct === '90%' && /alto/.test(c1.faixa) && c1.ativ === 'Pergunta: qual caminho seguir?' && c1.nome === 'Grafo novo', 'evento da fonte atualiza status, contexto, atividade e nome', c1);
  await dormir(300);
  c1 = await card('s1');
  conferir(/sprite-needu\.gif$/.test(c1.img || '') && (await av(`document.querySelectorAll('.wb-no[data-id="${c1.id}"] .wb-ag-img').length`)) === 1, 'sprite troca (com fade) e a antiga sai', c1.img);
  r = await av(`({ mesmo: document.querySelector('.wb-no[data-id="${c1.id}"]') === __no1, n2: __n2 })`);
  conferir(r.mesmo && r.n2 === 0, 'atualiza só o card daquela sessão (sem recriar nem mexer no outro)', r);
  r = await av(`({ resumo: Whiteboard.agentes.cards()[0].resumo, h: __h.slice(), rot: rotulos.length - __rot0, pode: Whiteboard.nucleo.podeDesfazer() })`);
  conferir(r.resumo.nome === 'Grafo novo' && r.resumo.status === 'aguardando' && r.h.length === 0 && r.rot === 0, 'resumo atualizado em silêncio (sem passo de histórico nem confirmar)', r);
  const salvou = await esperar(`demo.reqs.some((x) => x[1] === '/whiteboard/salvar' && x[2].elementos.some((e) => e.sessao && e.sessao.resumo && e.sessao.resumo.nome === 'Grafo novo'))`, 7000);
  conferir(salvou, 'o resumo novo é gravado (marcado pela câmera)');
  conferir(passos0 === true, 'havia histórico antes (controle)');

  // ── 3. Sessão removida → encerrado esmaecido com o resumo ──
  await av(`demoSessoes.remover('s2')`);
  await dormir(120);
  let c2 = await card('s2');
  conferir(c2 && c2.fim && c2.vivoAttr === '0' && c2.nome === 'Revisar contrato' && c2.proj === 'Bazar' && c2.st === 'Encerrada' && /sprite-sleep\.gif$/.test(c2.img || '') && +c2.op < 0.8 && c2.pct === null, 'sessão removida: card encerrado, esmaecido, com resumo e sprite dormindo', c2);
  conferir((await cards()).length === 2, 'o card encerrado continua no quadro');

  // ── 4. Não duplica: foca o existente ──
  await resetCam();
  const antes = (await cards()).length;
  await soltarCdp('s1', ...T(900, 650));
  if (via === 'sintético') await soltarSintetico('s1', ...T(900, 650));
  await dormir(80);
  const dest = (await card('s1')).destaque;
  await dormir(450);
  r = await av(`(() => { const c = Whiteboard.agentes.cards()[0], cam = Whiteboard.nucleo.camera(), t = Whiteboard.nucleo.tamanho(); return { n: Whiteboard.agentes.cards().length, cx: (c.x + c.w / 2 - cam.x) * cam.zoom, cy: (c.y + c.h / 2 - cam.y) * cam.zoom, w: t.w, h: t.h, sel: Whiteboard.nucleo.selecao(), id: c.id }; })()`);
  conferir(r.n === antes && perto(r.cx, r.w / 2, 3) && perto(r.cy, r.h / 2, 3) && r.sel[0] === r.id, 'soltar a mesma sessão não duplica: câmera vai até o card e o seleciona', r);
  conferir(dest, 'o card existente recebe destaque');

  // ── 5. Clique = detalhes; Esc fecha; clique fora fecha; duplo clique abre ──
  await resetCam();
  await av(`Whiteboard.nucleo.selecionar([])`);
  c1 = await card('s1');
  await clicar(...T(c1.x + 60, c1.y + 60));
  let p = await pop();
  conferir(p && p.id === c1.id && /Status/.test(p.txt) && /Aguardando você/.test(p.txt) && /Subagentes2/.test(p.txt) && /180 mil \/ 200 mil/.test(p.txt) && /Abrir conversa/.test(p.txt) && /há 5 min/.test(p.txt), 'clique abre o popover de detalhes', p);
  await tecla('Escape', 'Escape', 27);
  conferir(!(await pop()), 'Esc fecha os detalhes');
  await clicar(...T(c1.x + 60, c1.y + 60));
  conferir(!!(await pop()), 'clique de novo reabre');
  await clicar(...T(600, 700));
  conferir(!(await pop()), 'clique fora fecha');
  await clicar(...T(c1.x + 60, c1.y + 60));
  await av(`document.querySelector('.wb-ag-pop-abrir').click()`);
  r = await av(`({ ab: demoSessoes.abertos.slice(), pop: !!document.querySelector('.wb-ag-pop') })`);
  conferir(r.ab.includes('s1') && !r.pop, 'botão "Abrir conversa" chama fonte.abrir e fecha', r);
  await av(`demoSessoes.abertos.length = 0`);
  await clicar(...T(c1.x + 60, c1.y + 60));
  await av(`Whiteboard.nucleo.definirCamera({ x: 5, y: 0, zoom: 1 }, { animar: false })`);
  conferir(!(await pop()), 'mover a câmera fecha os detalhes');
  await resetCam();
  await duplo(...T(c1.x + 60, c1.y + 60));
  conferir((await av(`demoSessoes.abertos.slice()`)).includes('s1'), 'duplo clique chama fonte.abrir(id)');

  // ── 6. Arrastar move; seta presa ao card ──
  await av(`Whiteboard.nucleo.selecionar([])`);
  await arrastar2(...T(c1.x + 60, c1.y + 60), ...T(c1.x + 160, c1.y + 60));
  const c1m = await card('s1');
  conferir(perto(c1m.x, c1.x + 100, 2) && perto(c1m.y, c1.y, 2), 'arrastar o card move como as outras formas', { antes: c1.x, depois: c1m.x });
  c1 = c1m;
  conferir((await av(`Whiteboard.setas.alvoEm(${c1.x + c1.w / 2}, ${c1.y + c1.h / 2})`)) === c1.id, 'setas.alvoEm reconhece o card');
  await tecla('a', 'KeyA', 65, 'a');
  await arrastar2(...T(150, 650), ...T(c1.x + c1.w / 2, c1.y + c1.h / 2));
  r = await av(`(() => { const s = Whiteboard.nucleo.elementos().find((e) => e.tipo === 'seta'); return s ? { fim: s.ligacoes && s.ligacoes.fim && s.ligacoes.fim.id, lig: Whiteboard.nucleo.elemento('${c1.id}').ligacoes, id: s.id } : null; })()`);
  conferir(r && r.fim === c1.id && Array.isArray(r.lig) && r.lig.includes(r.id), 'seta desenhada até o card fica presa nele', r);
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);
  if (process.env.CAPTURA) {
    await av(`Whiteboard.nucleo.selecionar([])`); await dormir(200);
    const cap = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: of.l + 100, y: of.t + 150, width: 900, height: 550, scale: 0.6 } });
    fs.writeFileSync(process.env.CAPTURA, Buffer.from(cap.result.data, 'base64'));
  }

  // ── 7. Desfazer remove o card ──
  await av(`Whiteboard.agentes.adicionar('s3', 400, 600)`);
  await dormir(80);
  conferir(!!(await card('s3')), 's3 adicionado');
  await av(`document.querySelector('.wb-palco').focus()`);
  await tecla('z', 'KeyZ', 90, '', 2);
  await dormir(120);
  conferir(!(await card('s3')) && !(await av(`document.querySelector('.wb-no[data-tipo="agente"][data-id] .wb-ag-nome') && [...document.querySelectorAll('.wb-ag-nome')].some((n) => n.textContent === 'Testes do servidor')`)), 'Ctrl+Z remove o card adicionado', await cards());

  // ── 8. Recarregar mantém card e resumo ──
  await av(`Whiteboard.salvarAgora()`);
  await abrir('?semfonte=1');
  r = await av(`({ fonte: !!window.OrbitFonteSessoes, cs: Whiteboard.agentes.cards() })`);
  c1 = await card('s1'); c2 = await card('s2');
  conferir(!r.fonte && r.cs.length === 2, 'recarregado (sem fonte): os dois cards continuam', r);
  conferir(c1 && c1.resumo.nome === 'Grafo novo' && c1.nome === 'Grafo novo' && c1.fim && /sprite-sleep\.gif$/.test(c1.img || ''), 'sem fonte: card encerrado com o resumo guardado (nome atualizado ao vivo)', c1);
  await abrir('');
  c1 = await card('s1');
  conferir(c1 && c1.vivoAttr === '1' && c1.nome === 'Refatorar o grafo' && /sprite-work\.gif$/.test(c1.img || ''), 'recarregado com fonte: o card volta a ficar vivo', c1);
  conferir((await av(`Whiteboard.agentes.ouvindo()`)), 'volta a ouvir a fonte depois de recarregar');

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard agentes UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
