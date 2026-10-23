// Teste da exportação PNG/SVG (assets/whiteboard-exportar.js) contra testes/whiteboard-demo.html (fonte falsa de sessões).
// Servidor estático próprio (só GET) numa porta livre de 47822–47826, Edge headless mudo, perfil temporário apagado, fecharEdge no fim.
// node testes/whiteboard-exportar-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-ex-'));
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
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(250);
  };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);

  const E = 'Whiteboard.exportar';
  conferir(await av(`!!(${E} && ${E}.png && ${E}.svg && ${E}.abrir && ${E}.medir)`), 'Whiteboard.exportar publicado');

  // ── quadro vazio ──
  const vz = await av(`${E}.medir({})`);
  conferir(vz && vz.vazio === true, 'quadro vazio: medir().vazio', vz);

  // ── conteúdo ──
  const base = { cor: '#00ff00', traco: { largura: 2, estilo: 'solido' }, angulo: 0, opacidade: 1 };
  const add = (o) => av(`Whiteboard.nucleo.adicionar(${JSON.stringify({ ...base, ...o })}).id`);
  const idR = await add({ tipo: 'retangulo', x: 100, y: 100, w: 200, h: 100, preenchimento: '#ff0000' });
  await add({ tipo: 'elipse', x: 400, y: 100, w: 140, h: 90, preenchimento: '#0000ff' });
  await add({ tipo: 'losango', x: 620, y: 100, w: 120, h: 100, preenchimento: '#ffff00' });
  await add({ tipo: 'linha', x: 100, y: 300, w: 160, h: 60, pontos: [[0, 0], [160, 60]], preenchimento: null });
  await add({ tipo: 'texto', x: 320, y: 300, w: 220, h: 30, preenchimento: null, texto: { valor: 'Olá exportar', tamanho: 20, alinhar: 'esquerda' } });
  await add({ tipo: 'nota', x: 600, y: 280, w: 180, h: 140, preenchimento: null, texto: { valor: 'Nota de teste com texto', tamanho: 16, alinhar: 'esquerda' } });
  const idTr = await add({ tipo: 'retangulo', x: 850, y: 100, w: 100, h: 80, preenchimento: '#ff00ff' });
  await av(`Whiteboard.nucleo.atualizar('${idTr}', { travado: true })`);
  const idAg = await av(`Whiteboard.agentes.adicionar('s1', 100, 480)`);
  const idTm = await av(`Whiteboard.times.adicionar('t1', 450, 480)`);
  let idWeb = null;
  if (await av(`!!(Whiteboard.web && Whiteboard.web.adicionar)`)) idWeb = await av(`Whiteboard.web.adicionar('https://exemplo.test/', 1150, 150)`);
  else res.ok.push('(pulado) Whiteboard.web.adicionar ainda não existe');
  await av(`Whiteboard.nucleo.selecionar([]); Whiteboard.nucleo.redesenhar()`);
  await dormir(600);

  // ── helpers de imagem (na página) ──
  await av(`window.__pix = async (op) => { const b = await ${E}.png(op); const bm = await createImageBitmap(b); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bm, 0, 0); window.__img = x.getImageData(0, 0, c.width, c.height);
    return { tipo: b.type, w: bm.width, h: bm.height }; };
    window.__px = (x, y) => { const i = (Math.round(y) * window.__img.width + Math.round(x)) * 4; const d = window.__img.data; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    window.__diff = (x0, y0, x1, y1, ref) => { let n = 0, t = 0; for (let y = Math.max(0, Math.round(y0)); y < Math.min(window.__img.height, Math.round(y1)); y += 2) for (let x = Math.max(0, Math.round(x0)); x < Math.min(window.__img.width, Math.round(x1)); x += 2) { t++; const p = window.__px(x, y); if (Math.abs(p[0] - ref[0]) + Math.abs(p[1] - ref[1]) + Math.abs(p[2] - ref[2]) > 24 || p[3] < 250) n++; } return { n, t }; };
    true`);
  const perto = (a, b, t = 2) => Math.abs(a - b) <= t;
  const igualCor = (p, q, t = 3) => !!(p && q && perto(p[0], q[0], t) && perto(p[1], q[1], t) && perto(p[2], q[2], t));

  // ── PNG tudo, fundo do tema, 1x ──
  const m1 = await av(`${E}.medir({ selecao: false, escala: 1 })`);
  const info = await av(`__pix({ selecao: false, escala: 1, fundo: 'tema' })`);
  conferir(info.tipo === 'image/png', 'png(): Blob image/png', info);
  conferir(info.w === Math.round(m1.w) && info.h === Math.round(m1.h) && info.w > 800, 'png(): decodifica com o tamanho de medir()', { info, m1 });
  const fundo = await av(`(() => { const v = document.querySelector('.wb-vista'); const c = document.createElement('canvas').getContext('2d'); c.fillStyle = getComputedStyle(v).backgroundColor; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data]; })()`);
  const canto = await av(`__px(2, 2)`);
  conferir(igualCor(canto, fundo) && canto[3] === 255, 'png tema: canto = cor do fundo da vista', { canto, fundo });
  const pixMundo = (x, y, m = m1) => av(`__px((${x} - ${m.vx}) * ${m.escala}, (${y} - ${m.vy}) * ${m.escala})`);
  const p1 = await pixMundo(200, 150); conferir(igualCor(p1, [255, 0, 0]), 'png: meio do retângulo é vermelho', p1);
  const p2 = await pixMundo(470, 145); conferir(igualCor(p2, [0, 0, 255]), 'png: meio da elipse é azul', p2);
  const p3 = await pixMundo(680, 150); conferir(igualCor(p3, [255, 255, 0]), 'png: meio do losango é amarelo', p3);
  const p4 = await pixMundo(900, 140); conferir(igualCor(p4, [255, 0, 255]), 'png: elemento travado exporta normal', p4);
  const el = (id) => av(`(() => { const e = Whiteboard.nucleo.elementos().find((x) => x.id === '${id}'); return { x: e.x, y: e.y, w: e.w, h: e.h }; })()`);
  const regiao = async (id, m = m1) => { const e = await el(id); return av(`__diff((${e.x} - ${m.vx}) * ${m.escala}, (${e.y} - ${m.vy}) * ${m.escala}, (${e.x + e.w} - ${m.vx}) * ${m.escala}, (${e.y + e.h} - ${m.vy}) * ${m.escala}, ${JSON.stringify(fundo)})`); };
  const rAg = await regiao(idAg), rTm = await regiao(idTm);
  conferir(rAg.n > rAg.t * 0.3, 'png: card de agente tem pixels além do fundo', rAg);
  conferir(rTm.n > rTm.t * 0.1, 'png: card de time tem pixels além do fundo', rTm);
  if (idWeb) { const rW = await regiao(idWeb); conferir(rW.n > rW.t * 0.3, 'png: card web tem pixels além do fundo', rW); }

  // ── escala 2x e transparente ──
  const m2 = await av(`${E}.medir({ selecao: false, escala: 2 })`);
  const i2 = await av(`__pix({ selecao: false, escala: 2, fundo: 'transparente' })`);
  conferir(i2.w === Math.round(m2.w) && perto(i2.w, 2 * info.w, 4) && !m2.reduzida, 'png 2x: o dobro do tamanho', { i2, info });
  const c2 = await av(`__px(2, 2)`);
  conferir(c2[3] === 0, 'png transparente: canto com alfa 0', c2);
  const q2 = await pixMundo(200, 150, m2);
  conferir(igualCor(q2, [255, 0, 0]) && q2[3] === 255, 'png transparente: retângulo continua opaco', q2);

  // ── só seleção ──
  await av(`Whiteboard.nucleo.selecionar(['${idR}'])`);
  const mS = await av(`${E}.medir({ selecao: true, escala: 1 })`);
  const iS = await av(`__pix({ selecao: true, escala: 1, fundo: 'tema' })`);
  conferir(mS.soSelecao === true && perto(iS.w, 264, 6) && perto(iS.h, 164, 6), 'png só seleção: recorta no elemento + margem', { mS, iS });
  const pc = await av(`__px(${iS.w / 2}, ${iS.h / 2})`);
  conferir(igualCor(pc, [255, 0, 0]), 'png só seleção: centro vermelho', pc);
  const mSsel = await av(`${E}.medir({})`);
  conferir(mSsel.soSelecao === true, 'sem op, com seleção: exporta a seleção', mSsel);
  await av(`Whiteboard.nucleo.selecionar([])`);

  // ── SVG ──
  const svgTxt = await av(`${E}.svg({ selecao: false, fundo: 'tema' })`);
  const analise = await av(`(() => { const d = new DOMParser().parseFromString(${JSON.stringify(svgTxt)}, 'image/svg+xml'); const s = d.documentElement;
    return { erro: !!d.querySelector('parsererror'), raiz: s.localName, vb: s.getAttribute('viewBox'), n: ['rect', 'ellipse', 'polygon', 'path', 'text'].map((t) => d.querySelectorAll(t).length),
      textos: [...d.querySelectorAll('text')].map((t) => t.textContent).join('|') }; })()`);
  const mv = await av(`${E}.medir({ selecao: false })`);
  conferir(!analise.erro && analise.raiz === 'svg', 'svg(): parseia sem erro', analise);
  const ctl = await av(`(async () => { const n = Whiteboard.nucleo; const e = n.adicionar({ tipo: 'texto', x: 10, y: 10, w: 100, h: 30, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, texto: { valor: 'a\\fb\\u000bc\\u0001d', tamanho: 20, alinhar: 'esquerda' } });
    const s = await ${E}.svg({ selecao: false, fundo: 'tema' }); n.remover([e.id]);
    return { erro: !!new DOMParser().parseFromString(s, 'image/svg+xml').querySelector('parsererror'), ctl: /[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]/.test(s) }; })()`);
  conferir(!ctl.erro && !ctl.ctl, 'svg: caracteres de controle do texto não quebram o XML', ctl);
  const vbp = (analise.vb || '').split(/\s+/).map(Number);
  conferir(vbp.length === 4 && perto(vbp[0], mv.vx, 0.5) && perto(vbp[1], mv.vy, 0.5) && perto(vbp[2], mv.vw, 0.5) && perto(vbp[3], mv.vh, 0.5), 'svg: viewBox = caixa + margem', { vb: analise.vb, mv });
  conferir(analise.n.every((n) => n > 0), 'svg: tem rect, ellipse, polygon, path e text', analise.n);
  conferir(/Refatorar o grafo/.test(analise.textos), 'svg: nome do card de agente', analise.textos);
  conferir(/Olá exportar/.test(analise.textos) && /Nota de teste/.test(analise.textos), 'svg: texto e nota', analise.textos);
  conferir(/Lançar a versão 2/.test(analise.textos), 'svg: nome da sessão do time', analise.textos);
  if (idWeb) conferir(/exemplo\.test/.test(analise.textos), 'svg: card web mostra o host', analise.textos);
  const svgT = await av(`${E}.svg({ selecao: false, fundo: 'transparente' })`);
  conferir(svgT.length < svgTxt.length, 'svg transparente: menor que o com fundo');
  const svgSel = await av(`(async () => { Whiteboard.nucleo.selecionar(['${idR}']); const s = await ${E}.svg({ selecao: true }); Whiteboard.nucleo.selecionar([]); return s; })()`);
  conferir(!/Refatorar o grafo/.test(svgSel) && /<svg/.test(svgSel) && svgSel.length < svgTxt.length / 3, 'svg só seleção: sem os outros elementos', svgSel.length);

  // ── diálogo: botão, atalho, controles, baixar ──
  await av(`window.__baixados = []; document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[download]'); if (a) { window.__baixados.push({ nome: a.download, href: a.href.slice(0, 20) }); e.preventDefault(); } }, true); true`);
  const btn = await av(`(() => { const b = document.querySelector('.wb-topo .wb-ex-btn'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  conferir(!!btn, 'botão de exportar no cabeçalho flutuante', btn);
  if (btn) {
    await clicar(btn.x, btn.y);
    conferir(await av(`${E}.aberto() && !!document.querySelector('.wb-ex[role=dialog]')`), 'o botão abre o diálogo');
    conferir(await esperar(`(() => { const c = document.querySelector('.wb-ex-mini'); return c && c.width > 10 && c.height > 10; })()`, 3000), 'prévia desenhada no diálogo');
    await tecla('Escape', 'Escape', 27);
    await dormir(400);
    conferir(await av(`!${E}.aberto() && !document.querySelector('.wb-ex')`), 'Esc fecha o diálogo');
  }
  await av(`document.querySelector('.wb-palco').focus()`);
  await tecla('E', 'KeyE', 69, '', 10);
  conferir(await av(`${E}.aberto()`), 'Ctrl+Shift+E abre o diálogo');
  await av(`document.querySelector('.wb-ex-seg[data-campo="formato"] .wb-ex-op[data-v="svg"]').click()`);
  await dormir(300);
  conferir(await av(`document.querySelector('.wb-ex-seg[data-campo="formato"] [aria-checked="true"]').dataset.v === 'svg' && document.querySelector('[data-linha="escala"]').hidden`), 'formato SVG: esconde a escala');
  await av(`document.querySelector('.wb-ex-seg[data-campo="formato"] .wb-ex-op[data-v="png"]').click()`);
  await dormir(300);
  await av(`document.querySelector('.wb-ex-baixar').click()`);
  await esperar(`window.__baixados.length > 0`, 4000);
  const bx = await av(`window.__baixados`);
  conferir(bx.length === 1 && /\.png$/.test(bx[0].nome) && /^blob:/.test(bx[0].href), 'Baixar dispara o download do PNG', bx);
  await dormir(400);
  conferir(await av(`!${E}.aberto()`), 'Baixar fecha o diálogo');
  await av(`${E}.abrir({ formato: 'svg' })`);
  await av(`document.querySelector('.wb-ex-baixar').click()`);
  await esperar(`window.__baixados.length > 1`, 4000);
  const bx2 = await av(`window.__baixados`);
  conferir(bx2.length === 2 && /\.svg$/.test(bx2[1].nome), 'Baixar dispara o download do SVG', bx2);
  await dormir(400);

  // ── Teclas do núcleo não agem atrás do diálogo ──
  await av(`(() => { const n = Whiteboard.nucleo; const e = n.adicionar({ tipo: 'retangulo', x: 700, y: 400, w: 60, h: 60, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1 }); window.__idDlg = e.id; n.selecionar([e.id]); })()`);
  await av(`${E}.abrir({ formato: 'png' })`); await dormir(200);
  await av(`(document.querySelector('.wb-ex-baixar') || document.querySelector('.wb-veu button')).focus()`);
  await tecla('ArrowRight', 'ArrowRight', 39); await tecla('Delete', 'Delete', 46);
  conferir(await av(`(() => { const e = Whiteboard.nucleo.elemento(window.__idDlg); return !!e && e.x === 700; })()`), 'Delete/setas com o diálogo de exportar em foco não apagam nem movem a seleção');
  await av(`${E}.fechar()`);

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard exportar UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
