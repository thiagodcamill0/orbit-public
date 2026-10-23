// Teste de UI do Whiteboard — etapa 5 (times): quadro de time, subagentes ao vivo, arrastar/apagar/desfazer, setas e detalhes.
// Roda a demo (testes/whiteboard-demo.html, fonte falsa com t1 líder, t2 membro, subagentes a1/a2/a3) num Edge headless via CDP.
// Uso: node testes/whiteboard-times-ui.test.mjs   (CAPTURA=arquivo.png grava uma captura do quadro; VERBOSO=1 lista os ok)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-tm-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 600))); };
const perto = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const dentro = (c, q, tol = 0.5) => c.x >= q.x - tol && c.y >= q.y - tol && c.x + c.w <= q.x + q.w + tol && c.y + c.h <= q.y + q.h + tol;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47826);
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
  const desfazer = async () => { await av(`document.querySelector('.wb-palco').focus()`); await tecla('z', 'KeyZ', 90, '', 2); await dormir(150); };
  const apagar = async () => { await av(`document.querySelector('.wb-palco').focus()`); await tecla('Delete', 'Delete', 46); await dormir(120); };
  const mouse = (type, x, y, button = 'none', buttons = 0, clickCount) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: clickCount ?? (type === 'mouseMoved' ? 0 : 1) });
  const clicar = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'left', 1); await mouse('mouseReleased', x, y, 'left', 0); await dormir(150); };
  const duplo = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 'left', 1, 1); await mouse('mouseReleased', x, y, 'left', 0, 1);
    await mouse('mousePressed', x, y, 'left', 1, 2); await mouse('mouseReleased', x, y, 'left', 0, 2);
    await dormir(200);
  };
  const arrastar2 = async (x0, y0, x1, y1) => { await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1); for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, 'left', 1); await mouse('mouseReleased', x1, y1, 'left', 0); await dormir(180); };
  const CAM = { x: -60, y: -40, zoom: 0.8 };
  const resetCam = async () => { await av(`Whiteboard.nucleo.definirCamera(${JSON.stringify(CAM)}, { animar: false })`); await dormir(60); };
  const abrir = async (q = '') => {
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(250);
  };
  let of;
  // mundo → tela (com a câmera atual)
  const T = async (x, y) => { const t = await av(`Whiteboard.nucleo.mundoParaTela(${x}, ${y})`); return [of.l + t.sx, of.t + t.sy]; };
  const quadros = () => av(`Whiteboard.times.quadros()`);
  const quadro = async () => (await quadros())[0] || null;
  const subs = () => av(`Whiteboard.times.subagentes()`);
  const sub = async (aid) => (await subs()).find((s) => s.subagente === aid) || null;
  const membro = (q, chave) => q && q.membros.find((m) => m.chave === chave);
  const cab = (qid) => av(`(() => { const no = document.querySelector('.wb-no[data-id="${qid}"]'); return no ? { nome: no.querySelector('.wb-tm-nome')?.textContent, n: no.querySelector('.wb-tm-n')?.textContent } : null; })()`);
  const pop = () => av(`(() => { const p = document.querySelector('.wb-tm-pop'); return p ? { txt: p.textContent, id: Whiteboard.times.detalhesAbertos() } : null; })()`);
  // ponto livre no miolo do quadro: à esquerda do líder (fora de qualquer card, longe da borda)
  const livre = (q) => { const l = membro(q, 's:t1'); const p = [q.x + 40, l.y + l.h / 2]; return q.membros.some((m) => p[0] > m.x - 14 && p[0] < m.x + m.w + 14 && p[1] > m.y - 14 && p[1] < m.y + m.h + 14) ? null : p; };
  const elems = () => av(`Whiteboard.nucleo.elementos().length`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await resetCam();
  of = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  await av(`window.rotulos = []; Whiteboard.nucleo.on('confirmar', (d) => rotulos.push(d && d.rotulo))`);
  conferir((await av(`!!(Whiteboard.times && Whiteboard.times.soltar && Whiteboard.times.quadros)`)), 'Whiteboard.times publicado');

  // ── 1. Drop real do líder (CDP Input.dispatchDragEvent) cria quadro + cards + linhas ──
  const dados = (id) => ({ items: [{ mimeType: 'application/x-orbit-sessao', data: id }, { mimeType: 'text/plain', data: id }], dragOperationsMask: 1 });
  const soltarCdp = async (id, x, y) => {
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dados(id) });
    await cdp('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dados(id) });
    await dormir(60);
    await cdp('Input.dispatchDragEvent', { type: 'drop', x, y, data: dados(id) });
    await dormir(150);
  };
  await soltarCdp('t1', ...(await T(500, 380)));
  let q = await quadro();
  conferir(q && q.raiz === 't1' && q.membros.length === 5, 'soltar o líder cria o quadro com 5 membros (2 sessões + 3 subagentes)', q);
  const chaves = q ? q.membros.map((m) => m.chave).sort().join(',') : '';
  conferir(chaves === 'a:a1,a:a2,a:a3,s:t1,s:t2', 'membros certos (t1, t2, a1, a2, a3)', chaves);
  conferir(q && q.membros.every((m) => dentro(m, q)), 'todos os cards dentro do quadro', q);
  const lid = membro(q, 's:t1');
  conferir(lid && q.membros.every((m) => m === lid || m.y > lid.y + lid.h - 1), 'líder em cima, membros e subagentes abaixo', q && q.membros);
  let ls = await av(`Whiteboard.times.linhas('t1')`);
  // Subagente liga na sessão dona quando o card dela está no quadro; o resto liga no líder.
  const donoEsperado = await av(`(() => { const els = Whiteboard.nucleo.elementos(); const ag = new Map(els.filter((e) => e.tipo === 'agente').map((e) => [e.sessao.id, e.id])); const m = {}; for (const e of els) if (e.tipo === 'subagente') m[e.id] = ag.get(e.subagente.sessao) || null; return m; })()`);
  conferir(ls.length === 4 && ls.every((l) => l.de === (donoEsperado[l.para] || lid.id)) && ls.some((l) => l.de !== lid.id), '4 linhas: líder a cada membro, subagente de membro a partir do membro', { ls, donoEsperado });
  let c = await cab(q.id);
  conferir(c && c.nome === 'Lançar a versão 2' && c.n === '4 ativos' && q.ativos === 4, 'cabeçalho com nome do time e "4 ativos"', { c, ativos: q.ativos });
  let r = await av(`({ sel: Whiteboard.nucleo.selecao(), rot: rotulos.slice(), ouv: Whiteboard.times.ouvindo() })`);
  conferir(r.sel.length === 1 && r.sel[0] === q.id && r.rot.filter((x) => x === 'adicionar time').length === 1 && r.ouv, 'quadro selecionado, 1 confirmar("adicionar time") e ouvindo a fonte', r);
  const z = await av(`(() => { const e = Whiteboard.nucleo.elementos(); const q = e.find((x) => x.tipo === 'time'); return { q: q.z, min: Math.min(...e.filter((x) => x !== q).map((x) => x.z)) }; })()`);
  conferir(z.q < z.min, 'quadro desenhado atrás dos cards', z);
  const sa1 = await sub('a1'), sa2 = await sub('a2');
  conferir(sa1 && sa1.w === 220 && sa1.h === 84 && sa1.time === 't1' && sa1.sessao === 't1' && sa1.resumo.descricao === 'Mapear os módulos do app' && !sa1.esmaecido, 'card de subagente com tamanho, dona e resumo', sa1);
  conferir(sa2 && sa2.esmaecido && sa2.status === 'concluido', 'subagente concluído nasce esmaecido', sa2);
  conferir((await av(`[...document.querySelectorAll('.wb-sa .wb-sa-desc')].map((x) => x.textContent).includes('Rodar a suíte de testes')`)), 'card mostra a descrição do subagente');

  // ── 2. Desfazer depois do drop remove o time inteiro em 1 passo ──
  await desfazer();
  r = await av(`({ qs: Whiteboard.times.quadros().length, ss: Whiteboard.times.subagentes().length, ag: Whiteboard.agentes.cards().length, n: Whiteboard.nucleo.elementos().length })`);
  conferir(r.qs === 0 && r.ss === 0 && r.ag === 0 && r.n === 0, 'Ctrl+Z depois do drop remove quadro, cards e subagentes', r);
  await dormir(150);
  conferir((await elems()) === 0, 'o time não volta sozinho depois do desfazer');
  await soltarCdp('t1', ...(await T(500, 380)));
  q = await quadro();
  conferir(q && q.membros.length === 5, 'soltar de novo recria o time');

  // ── 3. Drop de membro com o time já no quadro: foca o existente ──
  await av(`Whiteboard.nucleo.definirCamera({ x: 2500, y: 1800, zoom: 1 }, { animar: false }); Whiteboard.nucleo.selecionar([])`);
  await dormir(60);
  await soltarCdp('t2', of.l + 300, of.t + 300);
  await dormir(60);
  const dest = await av(`(() => { const c = Whiteboard.agentes.cards().find((x) => x.sessao === 't2'); const no = c && document.querySelector('.wb-no[data-id="' + c.id + '"]'); return !!no && no.classList.contains('wb-ag-destaque'); })()`);
  await dormir(500);
  r = await av(`(() => { const q = Whiteboard.times.quadros(); const cam = Whiteboard.nucleo.camera(), t = Whiteboard.nucleo.tamanho(), b = q[0];
    return { n: q.length, m: b.membros.length, el: Whiteboard.nucleo.elementos().length, cx: (b.x + b.w / 2 - cam.x) * cam.zoom, cy: (b.y + b.h / 2 - cam.y) * cam.zoom, w: t.w, h: t.h, sel: Whiteboard.nucleo.selecao(), id: b.id }; })()`);
  conferir(r.n === 1 && r.m === 5 && r.el === 6, 'soltar um membro não duplica o time', r);
  conferir(perto(r.cx, r.w / 2, 3) && perto(r.cy, r.h / 2, 3) && r.sel.length === 1 && r.sel[0] === r.id, 'câmera centraliza o quadro existente e o seleciona', r);
  conferir(dest, 'o card do membro solto recebe destaque');
  await resetCam();

  // ── 4. Ao vivo: subagente novo entra sozinho; concluído esmaece; contador acompanha ──
  q = await quadro();
  await av(`window.__rot0 = rotulos.length; window.__pode0 = Whiteboard.nucleo.podeDesfazer()`);
  await av(`demoSessoes.criarSub('t1', { id: 'a4', tipo: 'Explore', descricao: 'Ler o contrato da fonte', status: 'trabalhando', statusTexto: 'Trabalhando', atividade: 'Lendo README.md' })`);
  await esperar(`Whiteboard.times.subagentes().some((s) => s.subagente === 'a4')`, 2000);
  await dormir(80);
  let q2 = await quadro();
  const a4 = await sub('a4');
  ls = await av(`Whiteboard.times.linhas('t1')`);
  conferir(a4 && a4.time === 't1' && membro(q2, 'a:a4') && dentro(membro(q2, 'a:a4'), q2), 'subagente novo entra sozinho no quadro', { a4, q2 });
  conferir(q2.h > q.h || q2.w > q.w, 'o quadro cresce para conter o novo card', { antes: [q.w, q.h], depois: [q2.w, q2.h] });
  conferir(ls.length === 5 && ls.some((l) => l.para === a4.id), 'linha nova até o subagente', ls);
  conferir((await av(`!!document.querySelector('.wb-no[data-id="${a4 && a4.id}"].wb-tm-entra, .wb-no[data-id="${a4 && a4.id}"] .wb-tm-entra')`)) || ls.some((l) => l.para === a4.id && l.animando), 'entrada animada (card ou linha)');
  c = await cab(q2.id);
  conferir(c.n === '5 ativos', 'contador vai para "5 ativos"', c);
  r = await av(`({ rot: rotulos.length - __rot0 })`);
  conferir(r.rot === 0, 'entrada ao vivo não cria confirmar', r);
  await av(`demoSessoes.concluirSub('a1')`);
  await esperar(`(Whiteboard.times.subagentes().find((s) => s.subagente === 'a1') || {}).esmaecido`, 2000);
  await dormir(300);
  const sa1b = await sub('a1');
  c = await cab(q2.id);
  conferir(sa1b.esmaecido && sa1b.status === 'concluido' && +(await av(`getComputedStyle(document.querySelector('.wb-no[data-id="${sa1b.id}"] .wb-sa-c')).opacity`)) < 0.9, 'subagente concluído fica esmaecido', sa1b);
  conferir(c.n === '4 ativos', 'contador volta para "4 ativos"', c);
  await av(`demoSessoes.addMembro('t3', 't1', { nome: 'Revisar a documentação' })`);
  await esperar(`Whiteboard.times.quadros()[0].membros.some((m) => m.chave === 's:t3')`, 2000);
  q2 = await quadro();
  c = await cab(q2.id);
  conferir(membro(q2, 's:t3') && dentro(membro(q2, 's:t3'), q2) && c.n === '5 ativos', 'membro novo (sessão dependente) entra e conta', { c, m: q2.membros.length });
  const salvou = await esperar(`demo.reqs.some((x) => x[1] === '/whiteboard/salvar' && x[2].elementos.some((e) => e.subagente && e.subagente.id === 'a4'))`, 7000);
  conferir(salvou, 'entrada ao vivo é gravada');

  // ── 5. Card apagado pelo usuário não volta com o próximo evento ──
  const sa2b = await sub('a2');
  await av(`Whiteboard.nucleo.selecionar(['${sa2b.id}'])`);
  await apagar();
  q2 = await quadro();
  conferir(!(await sub('a2')) && q2.removidos.includes('a:a2'), 'apagar um subagente registra em removidos', q2.removidos);
  await av(`demoSessoes.mudarSub('a3', { atividade: 'Escrevendo o rascunho' })`);
  await dormir(200);
  await av(`Whiteboard.times.sincronizar()`);
  await dormir(80);
  conferir(!(await sub('a2')), 'o card apagado não volta com o próximo evento');

  // ── 6. Arrastar o quadro pelo cabeçalho e pela borda move todos os membros ──
  await resetCam();
  await av(`Whiteboard.nucleo.selecionar([])`);
  q = await quadro();
  const zoom = CAM.zoom;
  await arrastar2(...(await T(q.x + 120, q.y + 20)), ...(await T(q.x + 120 + 100, q.y + 20 + 60)));
  q2 = await quadro();
  let dx = q2.x - q.x, dy = q2.y - q.y;
  conferir(perto(dx, 100, 2) && perto(dy, 60, 2), 'arrastar pelo cabeçalho move o quadro', { dx, dy });
  conferir(q.membros.every((m) => { const n = q2.membros.find((x) => x.id === m.id); return n && perto(n.x - m.x, dx, 1) && perto(n.y - m.y, dy, 1); }), 'todos os membros andam junto', q2.membros);
  r = await av(`Whiteboard.nucleo.selecao()`);
  conferir(r.length === 1 && r[0] === q2.id, 'depois de arrastar, só o quadro fica selecionado', r);
  q = q2;
  await arrastar2(...(await T(q.x + 3, q.y + q.h * 0.3)), ...(await T(q.x + 3 - 80, q.y + q.h * 0.3 + 40)));
  q2 = await quadro();
  dx = q2.x - q.x; dy = q2.y - q.y;
  conferir(perto(dx, -80, 2) && perto(dy, 40, 2) && q.membros.every((m) => { const n = q2.membros.find((x) => x.id === m.id); return n && perto(n.x - m.x, dx, 1) && perto(n.y - m.y, dy, 1); }), 'arrastar pela borda também move o time', { dx, dy });
  await resetCam();
  await av(`Whiteboard.nucleo.selecionar([])`);
  const pl = livre(await quadro());
  conferir(!!pl, 'há um ponto livre no miolo do quadro (controle)');
  r = await av(`(() => { const q = Whiteboard.times.quadros()[0]; return { v: Whiteboard.setas.alvoEm(${pl[0]}, ${pl[1]}), id: q.id, miolo: (Whiteboard.nucleo.elementoEm(${pl[0]}, ${pl[1]}) || {}).id || null }; })()`);
  conferir(r.v === r.id, 'setas.alvoEm reconhece o quadro no miolo', r);
  conferir(r.miolo !== r.id, 'o miolo do quadro não pega o clique', r);

  // ── 7. Mover um card dentro do quadro: só o card anda; o quadro se ajusta para contê-lo ──
  q = await quadro();
  const m3 = membro(q, 'a:a3');
  await arrastar2(...(await T(m3.x + 60, m3.y + 40)), ...(await T(m3.x + 60 + 30, m3.y + 40 + 20)));
  q2 = await quadro();
  let n3 = membro(q2, 'a:a3');
  conferir(perto(n3.x - m3.x, 30, 2) && perto(n3.y - m3.y, 20, 2) && q.membros.filter((m) => m.id !== m3.id).every((m) => { const n = q2.membros.find((x) => x.id === m.id); return n && perto(n.x, m.x, 0.5) && perto(n.y, m.y, 0.5); }), 'mover um card só move aquele card', { n3, m3 });
  await arrastar2(...(await T(n3.x + 60, n3.y + 40)), ...(await T(n3.x + 60 + 400, n3.y + 40)));
  q2 = await quadro();
  n3 = membro(q2, 'a:a3');
  conferir(n3 && dentro(n3, q2) && q2.w > q.w + 300 && perto(q2.x, q.x, 1), 'card levado para fora continua no time e o quadro se expande', { n3, q2: [q2.x, q2.w], q: [q.x, q.w] });
  await desfazer();
  q2 = await quadro();
  conferir(perto(q2.w, q.w, 1) && perto(membro(q2, 'a:a3').x, m3.x + 30, 2), 'Ctrl+Z devolve o card e o quadro encolhe', { w: [q.w, q2.w] });

  // ── 8. Setas presas a uma nota, a um card e ao quadro ──
  q = await quadro();
  await av(`Whiteboard.nucleo.definirCamera({ x: ${q.x - 400}, y: ${q.y - 60}, zoom: 0.7 }, { animar: false })`);
  await dormir(60);
  const nota = await av(`(() => { const n = Whiteboard.nucleo.adicionar({ tipo: 'nota', x: ${q.x - 320}, y: ${q.y + 60}, w: 180, h: 120, texto: 'Nota' }); Whiteboard.nucleo.confirmar('nota'); return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }; })()`);
  const alvoCard = membro(q, 'a:a4');
  await av(`Whiteboard.nucleo.selecionar([])`);
  await tecla('a', 'KeyA', 65, 'a');
  await arrastar2(...(await T(nota.x + nota.w / 2, nota.y + nota.h / 2)), ...(await T(alvoCard.x + alvoCard.w / 2, alvoCard.y + alvoCard.h / 2)));
  await tecla('a', 'KeyA', 65, 'a');
  const pl2 = livre(q);
  await arrastar2(...(await T(q.x - 200, q.y + q.h + 120)), ...(await T(pl2[0], pl2[1])));
  await av(`Whiteboard.nucleo.definirFerramenta('selecionar')`);
  const setas = () => av(`Whiteboard.nucleo.elementos().filter((e) => e.tipo === 'seta').map((s) => ({ id: s.id, ini: s.ligacoes && s.ligacoes.inicio && s.ligacoes.inicio.id, fim: s.ligacoes && s.ligacoes.fim && s.ligacoes.fim.id, geo: JSON.stringify([s.x, s.y, s.w, s.h, s.pontos]) }))`);
  let ss = await setas();
  const s1 = ss.find((s) => s.ini === nota.id), s2 = ss.find((s) => s.ini !== nota.id);
  conferir(s1 && s1.fim === alvoCard.id, 'seta presa a uma nota e a um card de subagente', ss);
  conferir(s2 && s2.fim === q.id, 'seta presa ao quadro do time', ss);
  await av(`Whiteboard.nucleo.selecionar([])`);
  await arrastar2(...(await T(q.x + 120, q.y + 20)), ...(await T(q.x + 120 + 50, q.y + 20 + 30)));
  const ss2 = await setas();
  const t1b = ss2.find((s) => s.id === s1?.id), t2b = ss2.find((s) => s.id === s2?.id);
  conferir(t1b && t2b && t1b.ini === nota.id && t1b.fim === alvoCard.id && t2b.fim === q.id && t1b.geo !== s1.geo && t2b.geo !== s2.geo, 'arrastar o quadro: as setas seguem presas e acompanham', { t1b, t2b });
  if (process.env.CAPTURA) {
    await av(`Whiteboard.nucleo.selecionar([])`); await dormir(400);
    const cq = await quadro(); const [x0, y0] = await T(cq.x - 340, cq.y - 20); const [x1, y1] = await T(cq.x + cq.w + 20, cq.y + cq.h + 20);
    const cap = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, x0), y: Math.max(0, y0), width: x1 - Math.max(0, x0), height: y1 - Math.max(0, y0), scale: 0.7 } });
    fs.writeFileSync(process.env.CAPTURA, Buffer.from(cap.result.data, 'base64'));
  }

  // ── 9. Clique num subagente abre detalhes; duplo clique abre a sessão dona ──
  await resetCam();
  await av(`Whiteboard.nucleo.selecionar([]); demoSessoes.abertos.length = 0`);
  const sa3 = await sub('a3');
  await clicar(...(await T(sa3.x + 60, sa3.y + 40)));
  let p = await pop();
  conferir(p && p.id === sa3.id && /Planejar o texto das notas/.test(p.txt) && /Abrir conversa/.test(p.txt), 'clique no subagente abre os detalhes', p);
  await tecla('Escape', 'Escape', 27);
  conferir(!(await pop()), 'Esc fecha os detalhes');
  await duplo(...(await T(sa3.x + 60, sa3.y + 40)));
  r = await av(`demoSessoes.abertos.slice()`);
  conferir(r.includes('t2') && !r.includes('a3'), 'duplo clique chama abrir da sessão dona (t2)', r);
  await av(`Whiteboard.times.fecharDetalhes(); Whiteboard.nucleo.selecionar([])`);

  // ── 10. Apagar o quadro apaga o time; desfazer traz tudo de volta em 1 passo ──
  q = await quadro();
  const antesN = await elems();
  const nMembros = q.membros.length;
  await clicar(...(await T(q.x + 120, q.y + 20)));
  r = await av(`Whiteboard.nucleo.selecao()`);
  conferir(r.length === 1 && r[0] === q.id, 'clique no cabeçalho seleciona o quadro', r);
  await apagar();
  r = await av(`({ qs: Whiteboard.times.quadros().length, ss: Whiteboard.times.subagentes().length, ag: Whiteboard.agentes.cards().filter((c) => c.sessao === 't1' || c.sessao === 't2' || c.sessao === 't3').length, n: Whiteboard.nucleo.elementos().length })`);
  conferir(r.qs === 0 && r.ss === 0 && r.ag === 0 && r.n === antesN - 1 - nMembros, 'apagar o quadro apaga o time inteiro (nota e setas ficam)', { r, antesN, nMembros });
  await av(`demoSessoes.mudarSub('a3', { atividade: 'Outra coisa' })`);
  await dormir(200);
  conferir((await quadros()).length === 0, 'o time apagado não volta com o próximo evento');
  await desfazer();
  q2 = await quadro();
  conferir(q2 && q2.id === q.id && q2.membros.length === nMembros && (await elems()) === antesN, 'Ctrl+Z traz quadro e membros de volta em 1 passo', { m: q2 && q2.membros.length, nMembros });
  ss = await setas();
  conferir(ss.some((s) => s.fim === q.id) && ss.some((s) => s.fim === alvoCard.id), 'setas voltam presas', ss);

  // ── 11. Recarregar mantém quadro, cards e resumos ──
  await av(`Whiteboard.salvarAgora()`);
  await dormir(150);
  await abrir('?semfonte=1');
  q2 = await quadro();
  const esperarCab = async () => { const t0 = Date.now(); const ok = await esperar(`!!document.querySelector('.wb-no[data-id="${q2 && q2.id}"] .wb-tm-nome')?.textContent`, 3000); return ok ? Date.now() - t0 : -1; };
  let tCab = await esperarCab();
  const subsSem = await subs();
  conferir(q2 && q2.id === q.id && q2.membros.length === nMembros && q2.removidos.includes('a:a2'), 'recarregado (sem fonte): quadro com os mesmos membros e removidos', q2 && { m: q2.membros.length, rem: q2.removidos });
  conferir(subsSem.length >= 3 && subsSem.every((s) => s.resumo && s.resumo.descricao) && subsSem.find((s) => s.subagente === 'a4')?.resumo.descricao === 'Ler o contrato da fonte', 'subagentes guardam o resumo', subsSem.map((s) => s.resumo));
  c = await cab(q2.id);
  conferir(c && c.nome === 'Lançar a versão 2', 'cabeçalho com o nome guardado', { c, tCab });
  if (process.env.VERBOSO) console.log('  cabeçalho sem fonte em ' + tCab + ' ms');
  await abrir('');
  q2 = await quadro();
  tCab = await esperarCab();
  if (process.env.VERBOSO) console.log('  cabeçalho com fonte em ' + tCab + ' ms');
  c = await cab(q2.id);
  await dormir(150);
  conferir(q2 && q2.membros.length === nMembros && (await av(`Whiteboard.times.ouvindo()`)) && c.n === '4 ativos' && !(await sub('a2')), 'recarregado com fonte (fonte da demo volta ao inicial: 4 ativos): time vivo, sem o card apagado', { c, m: q2 && q2.membros.length });

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard times UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
