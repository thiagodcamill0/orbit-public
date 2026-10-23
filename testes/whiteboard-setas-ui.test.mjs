// Teste das setas do Whiteboard (assets/whiteboard-setas.js) contra testes/whiteboard-demo.html (fetch falso em memória).
// Servidor estático próprio (só GET, só arquivos do projeto) numa porta livre de 47822–47826, Edge headless mudo,
// perfil numa pasta temporária apagada no fim, Edge fechado com fecharEdge.
// node testes/whiteboard-setas-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-setas-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const SHIFT = 8, ALT = 1;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
  const VK = { Escape: 27, Enter: 13, Delete: 46 };
  const tecla = async (key, mods = 0) => {
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    const vk = VK[key] || key.toUpperCase().charCodeAt(0);
    const p = { key, code, windowsVirtualKeyCode: vk, modifiers: mods };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await dormir(70);
  };
  const mouse = (type, x, y, button = 'none', buttons = 0, modifiers = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 });
  let OX = 0, OY = 0; // origem do palco na página: mundo (câmera 0,0, zoom 1) → cliente
  const arrastar = async (x0, y0, x1, y1, mods = 0, passos = 6) => {
    await mouse('mouseMoved', OX + x0, OY + y0, 'none', 0, mods); await mouse('mousePressed', OX + x0, OY + y0, 'left', 1, mods);
    for (let i = 1; i <= passos; i++) { await mouse('mouseMoved', OX + x0 + (x1 - x0) * i / passos, OY + y0 + (y1 - y0) * i / passos, 'left', 1, mods); await dormir(12); }
    await mouse('mouseReleased', OX + x1, OY + y1, 'left', 0, mods); await dormir(90);
  };
  const clicar = async (x, y) => {
    await mouse('mouseMoved', OX + x, OY + y); await mouse('mousePressed', OX + x, OY + y, 'left', 1);
    await mouse('mouseReleased', OX + x, OY + y, 'left', 0); await dormir(70);
  };
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(200);
  };
  const els = () => av(`Whiteboard.nucleo.elementos().map((e) => JSON.parse(JSON.stringify(e)))`);
  const ult = async () => { const l = await els(); return l[l.length - 1]; };
  const ferr = () => av(`Whiteboard.nucleo.ferramenta()`);
  const sel = () => av(`Whiteboard.nucleo.selecao()`);
  const limpar = () => av(`Whiteboard.nucleo.remover(Whiteboard.nucleo.elementos().map((e) => e.id))`);
  const caixaIgual = (e, x, y, w, h) => perto(e.x, x) && perto(e.y, y) && perto(e.w, w) && perto(e.h, h);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const ret = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  OX = ret.l; OY = ret.t;
  conferir(ret.w > 900 && ret.h > 650, 'palco ocupa a vista', ret);

  await av(`window.__conf = []; Whiteboard.nucleo.on('confirmar', (d) => window.__conf.push(d.rotulo))`);
  const conf = () => av(`window.__conf.splice(0)`);
  const add = (o) => av(`Whiteboard.nucleo.adicionar(Object.assign({ cor: '#fff', traco: { largura: 2, estilo: 'solido' } }, ${JSON.stringify(o)})).id`);
  const el = (id) => av(`(() => { const e = Whiteboard.nucleo.elemento(${JSON.stringify(id)}); return e && JSON.parse(JSON.stringify(e)); })()`);
  const pm = (e) => e.pontos.map(([dx, dy]) => [e.x + dx, e.y + dy]);
  const ini = (e) => pm(e)[0], fim = (e) => pm(e)[e.pontos.length - 1];
  const pt = (p, x, y, tol = 1.2) => !!p && perto(p[0], x, tol) && perto(p[1], y, tol);
  const usarSeta = async () => { await av(`Whiteboard.nucleo.definirFerramenta('seta')`); await dormir(30); };

  // ── 1. Registro, atalho, API ──
  let r = await av(`[...document.querySelectorAll('.wb-barra .wb-ferr')].map((b) => b.dataset.ferramenta)`);
  conferir(r.includes('seta') && r.indexOf('linha') < r.indexOf('seta') && r.indexOf('seta') < r.indexOf('livre'), 'barra mostra a seta entre linha e mão livre', r);
  await av(`document.querySelector('.wb-palco').focus()`);
  await tecla('a');
  conferir((await ferr()) === 'seta', 'tecla A ativa a seta', await ferr());
  await tecla('v');
  conferir(await av(`!!((Whiteboard.setas || window.WhiteboardSetas) && typeof (Whiteboard.setas || window.WhiteboardSetas).reconciliar === 'function')`), 'API reconciliar exposta');
  await conf();

  // ── 2. Seta solta (arrastar) ──
  await usarSeta();
  await arrastar(100, 100, 300, 100);
  let s = await ult();
  const sSolta = s.id;
  conferir(s.tipo === 'seta' && s.pontos.length === 2 && pt(ini(s), 100, 100) && pt(fim(s), 300, 100), 'arrastar cria seta reta solta', s);
  conferir(s.ligacoes && s.ligacoes.inicio === null && s.ligacoes.fim === null && s.pontas && s.pontas.fim === 'seta' && s.pontas.inicio === 'nenhuma', 'seta solta: ligações nulas, ponta no fim', s);
  conferir((await ferr()) === 'selecionar' && JSON.stringify(await sel()) === JSON.stringify([s.id]), 'depois de criar volta a selecionar com a seta selecionada');
  r = await conf();
  conferir(r.length === 1 && r[0] === 'criar seta', 'criar termina em um confirmar', r);
  conferir((await av(`(Whiteboard.nucleo.elementoEm(200, 101) || {}).id`)) === s.id && (await av(`Whiteboard.nucleo.elementoEm(200, 130)`)) === null, 'testarClique pelo traço');

  // ── 3. Shift = 15° ──
  await usarSeta();
  await arrastar(100, 300, 300, 340, SHIFT);
  s = await ult();
  const ang = Math.atan2(fim(s)[1] - ini(s)[1], fim(s)[0] - ini(s)[0]) * 180 / Math.PI;
  r = await conf();
  conferir(r.length === 1 && r[0] === 'criar seta' && s.id !== sSolta, 'Shift: seta criada com um confirmar', [r, await ferr(), (await els()).length]);
  conferir(perto(ang, 15, 0.3) && perto(Math.hypot(fim(s)[0] - 100, fim(s)[1] - 300), Math.hypot(200, 40), 1), 'Shift trava o ângulo em 15°', ang);

  // ── 4. Presa nos dois lados (retângulos) ──
  const A = await add({ tipo: 'retangulo', x: 100, y: 400, w: 100, h: 80 });
  const B = await add({ tipo: 'retangulo', x: 400, y: 400, w: 100, h: 80 });
  await usarSeta();
  await arrastar(150, 440, 450, 440);
  s = await ult();
  const sAB = s.id;
  conferir(s.ligacoes.inicio?.id === A && s.ligacoes.fim?.id === B, 'seta presa nos dois lados', s.ligacoes);
  conferir(perto(s.ligacoes.inicio.foco[0], 0.5, 0.02) && perto(s.ligacoes.inicio.foco[1], 0.5, 0.02), 'foco relativo à caixa do alvo', s.ligacoes.inicio);
  conferir(pt(ini(s), 205, 440) && pt(fim(s), 395, 440), 'pontas na borda dos retângulos com folga', [ini(s), fim(s)]);
  let a = await el(A), b = await el(B);
  conferir(JSON.stringify(a.ligacoes) === JSON.stringify([sAB]) && JSON.stringify(b.ligacoes) === JSON.stringify([sAB]), 'alvos guardam o id da seta', [a.ligacoes, b.ligacoes]);
  r = await conf();
  conferir(r.length === 1 && r[0] === 'criar seta', 'seta presa: um confirmar só', r);

  // ── 5. Borda de elipse e losango ──
  const E = await add({ tipo: 'elipse', x: 600, y: 100, w: 200, h: 100 });
  const D = await add({ tipo: 'losango', x: 900, y: 300, w: 160, h: 120 });
  await usarSeta();
  await arrastar(600, 300, 700, 150);
  s = await ult();
  const vElip = (p, ex = 700) => Math.hypot((p[0] - ex) / 100, (p[1] - 150) / 50);
  conferir(s.ligacoes.fim?.id === E && s.ligacoes.inicio === null && vElip(fim(s)) > 1.0 && vElip(fim(s)) < 1.15, 'ponta na borda da elipse', [fim(s), vElip(fim(s))]);
  const sE = s.id;
  await usarSeta();
  await arrastar(980, 600, 980, 360);
  s = await ult();
  conferir(s.ligacoes.fim?.id === D && pt(fim(s), 980, 425), 'ponta na borda do losango (vértice de baixo + folga)', fim(s));
  await conf();

  // ── 6. Mover o alvo arrasta a ponta ──
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);
  await arrastar(500, 440, 500, 540);
  b = await el(B);
  conferir(perto(b.y, 500, 0.5), 'alvo B foi arrastado', b);
  s = await el(sAB);
  conferir(s.ligacoes.fim?.id === B && s.ligacoes.inicio?.id === A, 'continua presa depois de mover o alvo', s.ligacoes);
  conferir(pt(fim(s), 395.26, 521.75, 1.5) && pt(ini(s), 204.74, 458.25, 1.5), 'pontas acompanham o alvo movido', [ini(s), fim(s)]);
  r = await conf();
  conferir(r.length === 1 && r[0] === 'mover', 'mover o alvo: só o confirmar do núcleo', r);
  r = await av(`(() => { const N = Whiteboard.nucleo; N.atualizar(${JSON.stringify(B)}, { x: 400, y: 400 }); const e = N.elemento(${JSON.stringify(sAB)}); return e.pontos.map(([dx, dy]) => [e.x + dx, e.y + dy]); })()`);
  conferir(pt(r[0], 205, 440) && pt(r[1], 395, 440), 'atualizar o alvo recalcula a seta na hora (evento mudanca)', r);
  r = await conf();
  conferir(r.length === 0, 'recalcular não gera confirmar', r);

  // ── 7. Apagar o alvo solta; mover a seta sozinha solta ──
  await clicar(500, 440);
  conferir(JSON.stringify(await sel()) === JSON.stringify([B]), 'clicar seleciona o alvo B', await sel());
  await tecla('Delete');
  s = await el(sAB);
  conferir(s && s.ligacoes.fim === null && s.ligacoes.inicio?.id === A && pt(fim(s), 395, 440), 'apagar o alvo solta a ponta (fica no último ponto)', s && [s.ligacoes, fim(s)]);
  await dormir(80);
  await arrastar(300, 440, 300, 480);
  s = await el(sAB); a = await el(A);
  conferir(s.ligacoes.inicio === null && pt(ini(s), 205, 480) && a.ligacoes === null, 'arrastar a seta sozinha solta a ponta e limpa a lista do alvo', [s.ligacoes, ini(s), a.ligacoes]);
  await conf();

  // ── 8. Editar a ponta: prender e soltar ──
  await usarSeta();
  await arrastar(100, 650, 250, 650);
  s = await ult();
  const sEd = s.id;
  await conf();
  await arrastar(250, 650, 150, 440);
  s = await el(sEd);
  conferir(s.ligacoes.fim?.id === A && pt(fim(s), 139.3, 484.9, 1.5) && pt(ini(s), 100, 650), 'arrastar a ponta sobre um elemento prende (borda)', [s.ligacoes, fim(s)]);
  a = await el(A);
  conferir(Array.isArray(a.ligacoes) && a.ligacoes.includes(sEd), 'alvo recebe a seta editada', a.ligacoes);
  r = await conf();
  conferir(r.length === 1 && r[0] === 'prender seta', 'prender a ponta termina em confirmar', r);
  const f8 = fim(s);
  await arrastar(f8[0], f8[1], 300, 700);
  s = await el(sEd); a = await el(A);
  conferir(s.ligacoes.fim === null && pt(fim(s), 300, 700) && !(a.ligacoes || []).includes(sEd), 'arrastar a ponta para o vazio solta', [s.ligacoes, fim(s), a.ligacoes]);
  r = await conf();
  conferir(r.length === 1 && r[0] === 'mover ponta', 'soltar a ponta termina em confirmar', r);

  // ── 9. Vários pontos (clicar-clicar), fim preso na elipse ──
  await usarSeta();
  await clicar(600, 600); await clicar(700, 650); await clicar(700, 150); await clicar(700, 150);
  s = await ult();
  const sPo = s.id;
  conferir(s.tipo === 'seta' && s.pontos.length === 3 && s.ligacoes.fim?.id === E && pt(fim(s), 700, 205) && (await ferr()) === 'selecionar', 'clicar-clicar cria seta com vários pontos, presa na elipse', [s.pontos.length, s.ligacoes, fim(s)]);
  await av(`Whiteboard.nucleo.atualizar(${JSON.stringify(E)}, { x: 650 })`);
  s = await el(sPo);
  const s2 = await el(sE);
  conferir(vElip(fim(s), 750) > 1 && vElip(fim(s), 750) < 1.15 && vElip(fim(s2), 750) > 1 && vElip(fim(s2), 750) < 1.15 && pt(ini(s), 600, 600), 'mover a elipse leva as duas setas presas', [fim(s), fim(s2)]);
  await conf();

  // ── 10. reconciliar (cópia) ──
  r = await av(`(() => {
    const N = Whiteboard.nucleo, api = Whiteboard.setas || window.WhiteboardSetas;
    const a = N.elemento(${JSON.stringify(A)});
    const r2 = N.adicionar({ tipo: 'retangulo', x: 100, y: 900, w: 100, h: 80, cor: '#fff', ligacoes: ['${sEd}'] });
    const c = N.adicionar({ tipo: 'seta', x: 100, y: 700, w: 0, h: 0, cor: '#fff', pontos: [[0, 0], [0, 200]], ligacoes: { inicio: { id: a.id, foco: [0.5, 0.5] }, fim: { id: r2.id, foco: [0.5, 0.5] } }, pontas: { inicio: 'nenhuma', fim: 'seta' } });
    const lixo = N.adicionar({ tipo: 'retangulo', x: 1200, y: 900, w: 50, h: 50, cor: '#fff', ligacoes: ['naoexiste'] });
    api.reconciliar([r2.id, c.id]);
    return { c: JSON.parse(JSON.stringify(c.ligacoes)), r2: r2.ligacoes, a: a.ligacoes, lixo: lixo.ligacoes, cid: c.id };
  })()`);
  conferir(r.c.inicio === null && r.c.fim?.id && JSON.stringify(r.r2) === JSON.stringify([r.cid]) && !(r.a || []).includes(r.cid) && r.lixo === null, 'reconciliar: solta alvo fora da cópia, mantém o de dentro e acerta as listas', r);
  await conf();

  // ── 11. Salvar leva ligações coerentes; recarregar mantém ──
  await av(`Whiteboard.nucleo.confirmar('teste')`);
  await av(`Whiteboard.salvarAgora()`);
  await esperar(`demo.reqs.some((x) => x[1] === '/whiteboard/salvar')`, 3000);
  r = await av(`(() => {
    const s = demo.reqs.filter((x) => x[1] === '/whiteboard/salvar').pop(), L = s[2].elementos, por = new Map(L.map((e) => [e.id, e]));
    const erros = [];
    for (const e of L) {
      if (Object.keys(e).some((k) => k[0] === '_')) erros.push('campo _ em ' + e.id);
      if (e.tipo === 'seta') for (const k of ['inicio', 'fim']) { const l = e.ligacoes && e.ligacoes[k]; if (l && !(por.get(l.id) && (por.get(l.id).ligacoes || []).includes(e.id))) erros.push(e.id + ' ' + k); }
      else if (Array.isArray(e.ligacoes)) for (const sid of e.ligacoes) { const t = por.get(sid); if (!t || !['inicio', 'fim'].some((k) => t.ligacoes[k] && t.ligacoes[k].id === e.id)) erros.push(e.id + ' lista ' + sid); }
    }
    return { erros, setas: L.filter((e) => e.tipo === 'seta').length, presas: L.filter((e) => e.tipo === 'seta' && e.ligacoes && (e.ligacoes.inicio || e.ligacoes.fim)).length };
  })()`);
  conferir(r.erros.length === 0 && r.setas === 8 && r.presas >= 3, 'salvar leva ligações coerentes nos dois sentidos', r);
  const antes = await el(sPo);
  await abrir('?vazio=1');
  s = await el(sPo);
  conferir(s && s.ligacoes.fim?.id === E && pt(fim(s), fim(antes)[0], fim(antes)[1], 0.05), 'recarregar mantém a seta presa no lugar', s && s.ligacoes);


  // ── 12. Com histórico e edição (desfazer, duplicar, colar, apagar) ──
  const CTRL = 2;
  await limpar(); await dormir(80);
  await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`);
  const A2 = await add({ tipo: 'retangulo', x: 100, y: 400, w: 100, h: 80 });
  const B2 = await add({ tipo: 'retangulo', x: 400, y: 400, w: 100, h: 80 });
  await av(`Whiteboard.nucleo.confirmar('retângulos')`);
  await usarSeta();
  await arrastar(150, 440, 450, 440);
  const S2 = (await ult()).id;
  await av(`Whiteboard.nucleo.confirmar('base'); document.querySelector('.wb-palco').focus()`);
  // Todas as ligações se confirmam nos dois sentidos e só apontam para elementos existentes.
  const coerente = () => av(`(() => {
    const L = Whiteboard.nucleo.elementos(), por = new Map(L.map((e) => [e.id, e])), prob = [];
    for (const e of L) {
      if (e.tipo === 'seta') for (const lado of ['inicio', 'fim']) {
        const l = e.ligacoes && e.ligacoes[lado];
        if (!l) continue;
        const t = por.get(l.id);
        if (!t) prob.push(e.id + '.' + lado + ' -> inexistente ' + l.id);
        else if (!Array.isArray(t.ligacoes) || !t.ligacoes.includes(e.id)) prob.push(e.id + '.' + lado + ' -> ' + l.id + ' não lista a seta');
      } else if (Array.isArray(e.ligacoes)) for (const sid of e.ligacoes) {
        const s = por.get(sid);
        if (!s || s.tipo !== 'seta') prob.push(e.id + ' lista seta inexistente ' + sid);
        else if (!(s.ligacoes && ((s.ligacoes.inicio && s.ligacoes.inicio.id === e.id) || (s.ligacoes.fim && s.ligacoes.fim.id === e.id)))) prob.push(e.id + ' lista ' + sid + ' que não o liga');
      }
    }
    return prob;
  })()`);
  conferir((await coerente()).length === 0, 'base: ligações coerentes', await coerente());
  // desfazer / refazer com a seta presa
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);
  await arrastar(500, 440, 500, 540);
  s = await el(S2);
  conferir(pt(fim(s), 395.26, 521.75, 1.5), 'mover o alvo leva a ponta', fim(s));
  await tecla('z', CTRL);
  s = await el(S2); b = await el(B2);
  conferir(perto(b.y, 400, 0.5) && pt(fim(s), 395, 440, 1.5) && pt(ini(s), 205, 440, 1.5) && s.ligacoes.fim?.id === B2, 'desfazer: o alvo volta e a ponta acompanha, ainda presa', [b.y, fim(s), s.ligacoes]);
  await tecla('z', CTRL | SHIFT);
  s = await el(S2); b = await el(B2);
  conferir(perto(b.y, 500, 0.5) && pt(fim(s), 395.26, 521.75, 1.5) && s.ligacoes.fim?.id === B2, 'refazer: a ponta vai de novo com o alvo', [b.y, fim(s), s.ligacoes]);
  await tecla('z', CTRL);
  conferir((await coerente()).length === 0, 'ligações coerentes depois de desfazer/refazer', await coerente());
  // desfazer a criação da seta limpa a lista dos alvos
  await tecla('z', CTRL);
  r = await av(`(() => { const N = Whiteboard.nucleo; return { s: !!N.elemento(${JSON.stringify(S2)}), a: N.elemento(${JSON.stringify(A2)}).ligacoes, b: N.elemento(${JSON.stringify(B2)}).ligacoes }; })()`);
  conferir(r.s === false && !(r.a || []).length && !(r.b || []).length && (await coerente()).length === 0, 'desfazer a criação da seta deixa os alvos sem referência', r);
  await tecla('z', CTRL | SHIFT);
  conferir(!!(await el(S2)) && (await coerente()).length === 0, 'refazer a criação devolve a seta coerente', await coerente());
  s = await el(S2);
  conferir(s.ligacoes.inicio?.id === A2 && s.ligacoes.fim?.id === B2, 'seta refeita continua presa aos dois alvos', s.ligacoes);
  // duplicar alvos + seta (Ctrl+D): cópia coerente, seta copiada presa nas cópias
  await av(`Whiteboard.nucleo.selecionar([${JSON.stringify(A2)}, ${JSON.stringify(B2)}, ${JSON.stringify(S2)}])`);
  await av(`document.querySelector('.wb-palco').focus()`);
  await tecla('d', CTRL);
  let L = await els();
  const cop = L.filter((e) => ![A2, B2, S2].includes(e.id));
  const sCop = cop.find((e) => e.tipo === 'seta'), ids = cop.map((e) => e.id);
  conferir(L.length === 6 && cop.length === 3 && !!sCop, 'duplicar alvos+seta cria 3 elementos', L.length);
  conferir(!!sCop && sCop.ligacoes.inicio && sCop.ligacoes.fim && ids.includes(sCop.ligacoes.inicio.id) && ids.includes(sCop.ligacoes.fim.id), 'a seta copiada liga as cópias (não os originais)', sCop && sCop.ligacoes);
  conferir((await coerente()).length === 0, 'duplicar: ligações coerentes', await coerente());
  s = await el(S2);
  conferir(s.ligacoes.inicio?.id === A2 && s.ligacoes.fim?.id === B2, 'duplicar não mexe na seta original', s.ligacoes);
  // duplicar só um alvo + a seta: a ponta sem cópia fica solta ou presa de forma coerente
  await av(`Whiteboard.nucleo.selecionar([${JSON.stringify(A2)}, ${JSON.stringify(S2)}])`);
  await tecla('d', CTRL);
  L = await els();
  const s3 = L.filter((e) => e.tipo === 'seta' && e.id !== S2 && !(sCop && e.id === sCop.id))[0];
  conferir(L.length === 8 && !!s3 && (await coerente()).length === 0, 'duplicar um alvo e a seta: coerente', { n: L.length, p: await coerente() });
  // copiar e colar
  await limpar(); await dormir(60);
  const A3 = await add({ tipo: 'retangulo', x: 100, y: 400, w: 100, h: 80 });
  const B3 = await add({ tipo: 'retangulo', x: 400, y: 400, w: 100, h: 80 });
  await av(`Whiteboard.nucleo.confirmar('retângulos')`);
  await usarSeta();
  await arrastar(150, 440, 450, 440);
  const S3 = (await ult()).id;
  await av(`Whiteboard.nucleo.selecionar([${JSON.stringify(A3)}, ${JSON.stringify(B3)}, ${JSON.stringify(S3)}]); document.querySelector('.wb-palco').focus()`);
  await tecla('c', CTRL); await tecla('v', CTRL); await dormir(120);
  L = await els();
  const colSeta = L.filter((e) => e.tipo === 'seta' && e.id !== S3)[0];
  conferir(L.length === 6 && !!colSeta && (await coerente()).length === 0, 'colar alvos+seta: coerente', { n: L.length, p: await coerente() });
  const cids = L.filter((e) => ![A3, B3, S3].includes(e.id)).map((e) => e.id);
  conferir(!!colSeta && colSeta.ligacoes.inicio && colSeta.ligacoes.fim && cids.includes(colSeta.ligacoes.inicio.id) && cids.includes(colSeta.ligacoes.fim.id), 'colar: a seta colada liga as cópias', colSeta && colSeta.ligacoes);
  // colar só a seta (alvos não copiados): sem ligação sem registro
  await av(`Whiteboard.nucleo.selecionar([${JSON.stringify(S3)}]); document.querySelector('.wb-palco').focus()`);
  await tecla('c', CTRL); await tecla('v', CTRL); await dormir(120);
  L = await els();
  conferir(L.length === 7 && (await coerente()).length === 0, 'colar só a seta: ligações coerentes (soltas ou registradas)', { n: L.length, p: await coerente() });
  // apagar o alvo pela edição
  await av(`Whiteboard.nucleo.selecionar([${JSON.stringify(B3)}]); document.querySelector('.wb-palco').focus()`);
  await av(`window.__conf = []; Whiteboard.nucleo.on('confirmar', (d) => window.__conf.push(d.rotulo))`);
  await av(`Whiteboard.acoes.apagar()`);
  s = await el(S3);
  conferir(!(await el(B3)) && s.ligacoes.fim === null && s.ligacoes.inicio?.id === A3 && (await coerente()).length === 0, 'apagar o alvo (ação de edição) solta a ponta e deixa tudo coerente', s.ligacoes);
  r = await conf();
  conferir(r.length === 1 && r[0] === 'excluir', 'apagar o alvo: um confirmar só', r);
  await tecla('z', CTRL);
  s = await el(S3);
  conferir(!!(await el(B3)) && s.ligacoes.fim?.id === B3 && (await coerente()).length === 0, 'desfazer o apagar religa a ponta ao alvo', s && s.ligacoes);

  // ── Seta travada: a ponta não é arrastável ──
  await limpar(); await usarSeta(); await arrastar(100, 600, 300, 600);
  const sT = (await ult()).id, fimAntes = fim(await el(sT));
  await av(`(() => { const n = Whiteboard.nucleo; n.definirFerramenta('selecionar'); n.elemento('${sT}').travado = true; n.selecionar(['${sT}']); n.redesenhar(); })()`);
  await arrastar(fimAntes[0], fimAntes[1], 300, 700);
  const sT2 = await el(sT);
  conferir(pt(fim(sT2), fimAntes[0], fimAntes[1], 0.5) && !(sT2.ligacoes && sT2.ligacoes.fim), 'seta travada: arrastar a ponta não move nem prende', [fim(sT2), fimAntes]);

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard setas UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
