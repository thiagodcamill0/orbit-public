// Teste da ligação card de site ↔ card de agente (assets/whiteboard-web.js, bloco "Ligação") contra testes/whiteboard-demo.html.
// POST /sessao/:id/mensagem é rota FALSA da demo (nunca toca sessão real). Servidor estático em porta livre de 47822–47826.
// Hosts *.exemplo apontam para 127.0.0.1 (nenhum acesso à internet). Edge headless mudo, perfil apagado, fecharEdge no fim.
// node testes/whiteboard-ligacao-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-lig-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
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
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--host-resolver-rules=MAP *.exemplo 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
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
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon/.test(d.params.entry.url || '') && !/status of (409|500)/.test(d.params.entry.text || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + '\n' + expr.slice(0, 200));
    return r.result?.result?.value;
  };
  const esperar = async (expr, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(40); } return false; };
  const mouse = (type, x, y, button = 'none', buttons = 0, clickCount) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: clickCount ?? (type === 'mouseMoved' ? 0 : 1) });
  const clicar = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'left', 1); await mouse('mouseReleased', x, y, 'left', 0); await dormir(150); };
  const direito = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'right', 2); await mouse('mouseReleased', x, y, 'right', 0); await dormir(150); };
  const arrastar2 = async (x0, y0, x1, y1) => { await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, 'left', 1); for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, 'left', 1); await mouse('mouseReleased', x1, y1, 'left', 0); await dormir(200); };
  const resetCam = async () => { await av(`Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }, { animar: false })`); await dormir(120); };
  const abrir = async (q = '') => {
    await cdp('Page.bringToFront').catch(() => {}); await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp('Page.navigate', { url: URL_DEMO + q });
    await esperar(`document.readyState === 'complete'`, 5000);
    await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 4000);
    await dormir(250);
  };
  const msgs = () => av(`demo.mensagens.map((m) => ({ id: m.id, corpo: m.corpo, g: m.gerenciador }))`);
  const nMsgs = () => av(`demo.mensagens.length`);
  const linhas = () => av(`[...document.querySelectorAll('.wb-lig-linha')].map((n) => n.dataset.web + '|' + n.dataset.sessao)`);
  const doWeb = (w) => av(`Whiteboard.ligacao.doWeb(${JSON.stringify(w)})`);
  const toast = () => av(`(() => { const t = document.querySelector('.wb-lig-toast'); return t && !t.hidden ? t.textContent : null; })()`);
  const fecharToast = () => av(`(() => { const t = document.querySelector('.wb-lig-toast'); if (t) t.hidden = true; })()`);
  const agCard = (sid) => av(`Whiteboard.agentes.cards().find((c) => c.sessao === ${JSON.stringify(sid)})`);
  const rectNo = (id) => av(`(() => { const n = document.querySelector('.wb-no[data-id="${id}"]'); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const centroAg = async (sid) => { const c = await agCard(sid); const r = await rectNo(c.id); return [r.x + r.w / 2, r.y + r.h / 2]; };
  const alca = async (webId) => {
    await av(`Whiteboard.nucleo.selecionar(['${webId}'])`); await dormir(120);
    const r = await av(`(() => { const a = document.querySelector('.wb-no[data-id="${webId}"] .wb-lig-alca'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, v: getComputedStyle(a).display !== 'none' && getComputedStyle(a).visibility !== 'hidden' }; })()`);
    return r;
  };
  const posMsg = async (n) => { await esperar(`demo.mensagens.length >= ${n}`, 2500); await dormir(350); return nMsgs(); };
  const itemMenu = async (rot) => {
    const c = await av(`(() => { const b = [...document.querySelectorAll('.wb-menu:not(.wb-menu-sub) .wb-menu-item')].find((x) => x.querySelector('.mi-rot').textContent === ${JSON.stringify(rot)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!c) return false; await clicar(c[0], c[1]); return true;
  };
  const rotulosMenu = () => av(`[...document.querySelectorAll('.wb-menu:not(.wb-menu-sub) .wb-menu-item .mi-rot')].map((t) => t.textContent)`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await abrir();
  await av(`localStorage.clear()`);
  await abrir('?vazio=1');
  await resetCam();
  const of = await av(`(() => { const r = document.querySelector('.wb-palco').getBoundingClientRect(); return { l: r.left, t: r.top }; })()`);
  const T = (x, y) => [of.l + x, of.t + y];

  conferir(await av(`!!Whiteboard.ligacao && Object.isFrozen(Whiteboard.ligacao) && ['ligar','desligar','reenviar','escolher','doWeb','doAgente','linhas'].every((k) => typeof Whiteboard.ligacao[k] === 'function')`), 'Whiteboard.ligacao publicado (congelado)');

  // ── cenário: site W à esquerda; agentes s1, s2 (409), s3 (500), s4 (será removida) à direita ──
  const W = await av(`Whiteboard.web.adicionar('http://fora.exemplo/', 250, 300)`);
  await av(`Whiteboard.agentes.adicionar('s1', 820, 120)`);
  await av(`Whiteboard.agentes.adicionar('s2', 820, 330)`);
  await av(`Whiteboard.agentes.adicionar('s3', 820, 540)`);
  await av(`Whiteboard.agentes.adicionar('s4', 560, 650)`);
  await dormir(400);
  conferir(!!W && (await av(`Whiteboard.agentes.cards().length`)) === 4, 'cenário: 1 site e 4 cards de agente', { W });
  conferir((await linhas()).length === 0 && (await doWeb(W)).length === 0, 'sem ligações no início');

  // ── 1. arrastar a alça até o card s1 ──
  const al = await alca(W);
  conferir(al && al.w > 4 && al.v, 'alça visível com o card de site selecionado', al);
  const c1 = await centroAg('s1');
  await arrastar2(al.x, al.y, c1[0], c1[1]);
  let n = await posMsg(1);
  conferir(JSON.stringify(await linhas()) === JSON.stringify([W + '|s1']), 'arrastar a alça até o card de agente cria a linha', await linhas());
  let ms = await msgs();
  conferir(n === 1 && ms[0].id === 's1' && ms[0].g, '1 POST para /sessao/s1/mensagem (com x-gerenciador)', ms);
  conferir(ms[0] && ms[0].corpo.prioridade === 'next' && /Ferramenta fixa/.test(ms[0].corpo.texto) && ms[0].corpo.texto.includes('http://fora.exemplo/'), "corpo com texto do aviso e prioridade 'next'", ms[0] && ms[0].corpo);
  conferir(await esperar(`Whiteboard.ligacao.doWeb('${W}')[0] && Whiteboard.ligacao.doWeb('${W}')[0].avisadoEm > 0`, 2000), 'avisadoEm gravado após o 202', await doWeb(W));
  conferir(await av(`!!document.querySelector('.wb-lig-plug[data-web="${W}"][data-sessao="s1"]')`), 'plug no meio da linha');
  const lg = await av(`Whiteboard.ligacao.linhas()`);
  conferir(lg.length === 1 && /^M[\d.\-]+ [\d.\-]+ C/.test(lg[0].d), 'API linhas() devolve o caminho', lg);
  conferir(await av(`(() => { const p = document.querySelector('.wb-lig-linha'); const b = p.getBBox(); return b.width > 100; })()`), 'linha desenhada com extensão real');
  conferir(await av(`!document.querySelector('.wb-lig-fio')`) && !(await av(`document.querySelector('.wb-palco').classList.contains('wb-lig-arrastando')`)), 'fio provisório e estado de arrasto limpos após soltar');

  // ── 2. duplicada ignorada ──
  conferir(await av(`Whiteboard.ligacao.ligar('${W}', 's1')`) === 'duplicada' && (await doWeb(W)).length === 1, 'ligar de novo ao mesmo agente é ignorado (duplicada)');
  const passosAntes = await av(`Whiteboard.nucleo.podeDesfazer()`);
  const al2 = await alca(W);
  await arrastar2(al2.x, al2.y, ...(await centroAg('s1')));
  conferir((await posMsg(1)) === 1 && (await doWeb(W)).length === 1 && /já está ligado/.test(await toast() || ''), 'arrastar duplicada: sem nova linha, sem POST, com aviso', { t: await toast(), n: await nMsgs() });

  // ── 3. pelo menu: "Ligar a um agente…" ──
  await fecharToast();
  const rw = await rectNo(W);
  await direito(rw.x + 120, rw.y + 20);
  const rot = await rotulosMenu();
  conferir(rot.includes('Ligar a um agente…') && rot.includes('Reenviar aviso a Refatorar o grafo') && rot.includes('Desligar de Refatorar o grafo'), 'menu do card de site: Ligar / Reenviar / Desligar', rot);
  await itemMenu('Ligar a um agente…');
  conferir(await av(`Whiteboard.ligacao.escolhendo()`), 'modo de escolha ativo após o item do menu');
  const cm = await centroAg('s2');
  await clicar(cm[0], cm[1]);
  conferir(!(await av(`Whiteboard.ligacao.escolhendo()`)), 'clicar no agente encerra o modo de escolha');
  n = await posMsg(2);
  ms = await msgs();
  conferir(n === 2 && ms[1].id === 's2' && ms[1].corpo.prioridade === 'next', 'ligar pelo menu: 1 POST (prioridade next)', ms);
  conferir((await doWeb(W)).map((l) => l.sessao).join() === 's1,s2' && (await linhas()).length === 2, 'duas linhas (s1 e s2)', await linhas());

  // ── 4. 409 mostra o aviso e não grava avisadoEm ──
  const d2 = (await doWeb(W)).find((l) => l.sessao === 's2');
  const t409 = await toast();
  conferir(d2 && d2.avisadoEm === null && /não recebe mensagens do Orbit/.test(t409 || ''), '409: aviso na tela e avisadoEm continua nulo', { d2, t409 });
  conferir((await doWeb(W)).find((l) => l.sessao === 's1').avisadoEm > 0, 's1 mantém o avisadoEm');

  // ── 5. falha 500: toast com "Tentar de novo" ──
  const rr = await av(`Whiteboard.ligacao.ligar('${W}', 's3')`);
  n = await posMsg(3);
  const t500 = await toast();
  conferir(rr === 'ligado' && n === 3 && /Não deu para avisar/.test(t500 || '') && /Tentar de novo/.test(t500 || ''), '500: toast com Tentar de novo', { rr, n, t500 });
  await av(`Whiteboard.ligacao.desligar('${W}', 's3')`);
  await dormir(100);

  // ── 6. sessão inexistente não envia ──
  await av(`demoSessoes.remover('s4')`);
  await dormir(200);
  const antes = await nMsgs();
  const r4 = await av(`Whiteboard.ligacao.ligar('${W}', 's4')`);
  await dormir(500);
  conferir(r4 === 'ligado' && (await nMsgs()) === antes && /Sessão encerrada/.test(await toast() || ''), 'sessão inexistente: liga só visualmente, sem POST', { r4, antes, depois: await nMsgs(), t: await toast() });
  conferir((await doWeb(W)).find((l) => l.sessao === 's4').avisadoEm === null, 'sessão inexistente: sem avisadoEm');
  await av(`Whiteboard.ligacao.desligar('${W}', 's4')`);

  // ── 7. subagente e time recusam ──
  await av(`Whiteboard.times.soltar('t1', 300, 760)`);
  await dormir(500);
  const alvosRec = await av(`({ sub: (Whiteboard.nucleo.elementos().find((e) => e.tipo === 'subagente') || {}).id, time: (Whiteboard.nucleo.elementos().find((e) => e.tipo === 'time') || {}).id })`);
  conferir(!!alvosRec.sub && !!alvosRec.time, 'cenário: card de subagente e quadro de time existem', alvosRec);
  let nAntes = await nMsgs(); const linAntes = (await doWeb(W)).length;
  for (const tipo of ['sub', 'time']) {
    await fecharToast();
    const b = await rectNo(alvosRec[tipo]);
    const a3 = await alca(W);
    // alvo: um ponto do subagente / do quadro de time que não caia num card de agente
    const px = tipo === 'sub' ? [b.x + b.w / 2, b.y + b.h / 2] : [b.x + 6, b.y + 6];
    await arrastar2(a3.x, a3.y, ...px);
    await dormir(200);
    const t = await toast();
    conferir(/Só cards de agente/.test(t || '') && (await doWeb(W)).length === linAntes && (await nMsgs()) === nAntes, `${tipo === 'sub' ? 'subagente' : 'time'} recusa a ligação, sem POST`, { t, n: await nMsgs() });
  }

  // ── 8. desfazer / refazer sem POST ──
  const rDesl = await av(`Whiteboard.ligacao.desligar('${W}', 's2')`);   // deixa só s1; passo "Desligar"
  let linDesl = await linhas();
  for (let i = 0; i < 10 && linDesl.some((l) => l.endsWith('|s2')); i++) { await dormir(100); linDesl = await linhas(); } // a linha some no próximo quadro (rAF)
  conferir(!linDesl.some((l) => l.endsWith('|s2')), 'desligar remove a linha', { rDesl, linDesl, dados: await doWeb(W) });
  conferir((await nMsgs()) === nAntes, 'desligar não envia nada');
  await av(`Whiteboard.nucleo.desfazer()`);              // desfaz o Desligar de s2
  await dormir(300);
  conferir((await doWeb(W)).some((l) => l.sessao === 's2') && (await linhas()).some((l) => l.endsWith('|s2')), 'desfazer o desligar traz a linha de volta');
  conferir((await nMsgs()) === nAntes, 'desfazer não envia POST');
  // desfazer/refazer de um "Ligar" de verdade (1 POST do ligar; nenhum do desfazer/refazer)
  await av(`Whiteboard.ligacao.ligar('${W}', 's3')`);
  const nL = await posMsg(nAntes + 1);
  await av(`Whiteboard.nucleo.desfazer()`);
  await dormir(300);
  conferir(!(await doWeb(W)).some((l) => l.sessao === 's3') && !(await linhas()).some((l) => l.endsWith('|s3')), 'desfazer ligar remove a linha');
  conferir((await nMsgs()) === nL && nL === nAntes + 1, 'desfazer ligar não envia POST', { n: await nMsgs(), nL, nAntes });
  await av(`Whiteboard.nucleo.refazer()`);
  await dormir(400);
  conferir((await doWeb(W)).some((l) => l.sessao === 's3') && (await linhas()).some((l) => l.endsWith('|s3')), 'refazer volta a ligação');
  conferir((await nMsgs()) === nL, 'refazer não envia POST', { n: await nMsgs(), nL });
  await av(`Whiteboard.ligacao.desligar('${W}', 's3')`);
  nAntes = await nMsgs();

  // ── 9. reenviar manda de novo ──
  const rn = await av(`Whiteboard.ligacao.reenviar('${W}', 's1')`);
  conferir(rn === 'enviado' && (await nMsgs()) === nAntes + 1 && (await msgs()).at(-1).id === 's1', 'reenviar manda o aviso de novo', { rn, n: await nMsgs() });
  const rect2 = await rectNo(W);
  await direito(rect2.x + 120, rect2.y + 20);
  const rotS = await rotulosMenu();
  conferir(rotS.some((r) => /^Ligações$/.test(r)), 'com 2+ ligações o menu agrupa em "Ligações"', rotS);
  await av(`Whiteboard.menu.fechar && Whiteboard.menu.fechar()`);
  await mouse('mouseMoved', 5, 5); await mouse('mousePressed', 5, 5, 'left', 1); await mouse('mouseReleased', 5, 5, 'left', 0);
  await dormir(150);

  // ── 10. desligar remove sem POST (pelo menu, com 1 ligação) ──
  await av(`Whiteboard.ligacao.desligar('${W}', 's2')`);
  const n10 = await nMsgs();
  const rect3 = await rectNo(W);
  await direito(rect3.x + 120, rect3.y + 20);
  const rotD = await rotulosMenu();
  conferir(rotD.includes('Desligar de Refatorar o grafo'), 'menu com 1 ligação lista "Desligar de ..."', rotD);
  await itemMenu('Desligar de Refatorar o grafo');
  await dormir(250);
  conferir((await doWeb(W)).length === 0 && (await linhas()).length === 0 && (await nMsgs()) === n10, 'desligar pelo menu remove a linha sem POST', { l: await doWeb(W), n: await nMsgs(), n10 });
  // religa s1 (novo aviso) para os próximos blocos
  await av(`Whiteboard.ligacao.ligar('${W}', 's1')`);
  await posMsg(n10 + 1);
  conferir((await nMsgs()) === n10 + 1, 'religar envia um novo aviso');

  // ── 11. mover o card move a linha ──
  const d0 = await av(`Whiteboard.ligacao.linhas()[0].d`);
  await av(`(() => { const e = Whiteboard.nucleo.elemento('${W}'); Whiteboard.nucleo.atualizar('${W}', { x: e.x - 30, y: e.y + 60 }); })()`);
  await dormir(250);
  const d1 = await av(`Whiteboard.ligacao.linhas()[0].d`);
  const dDom = await av(`document.querySelector('.wb-lig-linha').getAttribute('d')`);
  conferir(d0 !== d1 && dDom === d1, 'mover o card de site redesenha a linha', { d0, d1, dDom });
  const ag1 = await agCard('s1');
  await av(`Whiteboard.nucleo.atualizar('${ag1.id}', { x: ${ag1.x} + 40, y: ${ag1.y} + 50 })`);
  await dormir(250);
  conferir(await av(`document.querySelector('.wb-lig-linha').getAttribute('d')`) !== d1, 'mover o card de agente redesenha a linha');
  await av(`Whiteboard.nucleo.atualizar('${ag1.id}', { x: ${ag1.x}, y: ${ag1.y} })`);
  await dormir(200);

  // ── 12. apagar o card de agente esconde a linha; desfazer traz de volta ──
  const n12 = await nMsgs();
  await av(`Whiteboard.nucleo.remover(['${ag1.id}'])`);
  await av(`Whiteboard.nucleo.confirmar('Apagar')`);
  await dormir(300);
  conferir((await linhas()).length === 0 && (await av(`document.querySelectorAll('.wb-lig-plug').length`)) === 0, 'apagar o card de agente esconde linha e plug');
  conferir((await doWeb(W)).some((l) => l.sessao === 's1' && !l.noQuadro), 'a ligação continua nos dados (noQuadro=false)', await doWeb(W));
  await av(`Whiteboard.nucleo.desfazer()`);
  await dormir(350);
  conferir((await linhas()).length === 1 && (await doWeb(W))[0].noQuadro, 'desfazer o apagar traz a linha de volta', { l: await linhas() });
  conferir((await nMsgs()) === n12, 'apagar/desfazer não enviam POST');

  // ── 13. duplicar o card de site não leva a ligação ──
  await av(`Whiteboard.nucleo.selecionar(['${W}'])`);
  await av(`Whiteboard.acoes.duplicar()`);
  await dormir(350);
  const cop = await av(`Whiteboard.nucleo.elementos().filter((e) => e.tipo === 'web').map((e) => ({ id: e.id, ag: (e.web.agentes || []).length }))`);
  conferir(cop.length === 2 && cop.find((e) => e.id === W).ag === 1 && cop.find((e) => e.id !== W).ag === 0, 'duplicar: a cópia nasce sem ligações, o original mantém', cop);
  conferir((await linhas()).length === 1 && (await nMsgs()) === n12, 'duplicar não cria linha nem POST');
  await av(`Whiteboard.nucleo.remover(['${cop.find((e) => e.id !== W).id}'])`);
  await av(`Whiteboard.nucleo.confirmar('Apagar cópia')`);

  // ── 14. exportar SVG contém a linha ──
  await av(`Whiteboard.nucleo.selecionar([])`);
  const svgTxt = await av(`Whiteboard.exportar.svg({ selecao: false, fundo: 'tema' })`);
  const nLig = (svgTxt.match(/data-tipo="ligacao"/g) || []).length;
  conferir(nLig === 1 && /stroke-dasharray/.test(svgTxt), 'exportar SVG contém a linha de ligação', nLig);
  const svgSemAg = await av(`(async () => { Whiteboard.nucleo.selecionar(['${W}']); const s = await Whiteboard.exportar.svg({ selecao: true }); Whiteboard.nucleo.selecionar([]); return s; })()`);
  conferir(!/data-tipo="ligacao"/.test(svgSemAg), 'exportar só o card de site (sem o agente) não leva a linha');

  // ── 15. recarregar mantém ──
  const salv0 = await av(`demo.reqs.filter((r) => r[1] === '/whiteboard/salvar').length`);
  await av(`Whiteboard.ligacao.reenviar('${W}', 's1')`);
  await esperar(`Whiteboard.ligacao.doWeb('${W}')[0].avisadoEm > 0`, 2000);
  await esperar(`demo.reqs.filter((r) => r[1] === '/whiteboard/salvar').length > ${salv0}`, 3000);
  await dormir(300);
  await esperar(`demo.reqs.filter((r) => r[1] === '/whiteboard/salvar').length > 0`, 3000);
  await dormir(1500);
  const n15 = await nMsgs();
  await abrir('');
  await resetCam();
  conferir(await esperar(`Whiteboard.ligacao.linhas().length === 1`, 4000), 'recarregar mantém a ligação e a linha', await av(`Whiteboard.nucleo.elementos().map((e) => e.tipo)`));
  const dR = await doWeb(W);
  conferir(dR.length === 1 && dR[0].sessao === 's1' && dR[0].avisadoEm > 0, 'recarregar mantém sessão e avisadoEm', dR);
  await dormir(600);
  conferir((await nMsgs()) === 0 && n15 > 0, 'recarregar não reenvia aviso (a página zera o registro da demo)', { n: await nMsgs() });
  conferir((await linhas()).length === 1, 'linha desenhada após recarregar');

  // ── 16. card travado não liga ──
  await av(`Whiteboard.nucleo.atualizar('${W}', { travado: true })`);
  await fecharToast();
  const rt = await av(`Whiteboard.ligacao.ligar('${W}', 's2')`);
  const rt2 = await av(`Whiteboard.ligacao.desligar('${W}', 's1')`);
  conferir(rt === 'travado' && rt2 === false && (await doWeb(W)).length === 1 && (await nMsgs()) === 0, 'card de site travado não liga nem desliga', { rt, rt2 });
  const rwt = await rectNo(W);
  await direito(rwt.x + 120, rwt.y + 20);
  const rotT = await rotulosMenu();
  conferir(!rotT.includes('Ligar a um agente…') && !rotT.some((r) => /^Desligar de/.test(r)), 'menu do card travado não oferece ligar/desligar', rotT);
  await mouse('mouseMoved', 5, 5); await mouse('mousePressed', 5, 5, 'left', 1); await mouse('mouseReleased', 5, 5, 'left', 0);
  await av(`Whiteboard.nucleo.atualizar('${W}', { travado: false })`);
  await av(`delete Whiteboard.nucleo.elemento('${W}').travado`);
  const ag2 = await agCard('s2');
  const agT = ag2 && ag2.id;
  if (agT) {
    await av(`Whiteboard.nucleo.atualizar('${agT}', { travado: true })`);
    const ra = await av(`Whiteboard.ligacao.ligar('${W}', 's2')`);
    conferir(ra === 'travado' && (await doWeb(W)).length === 1, 'card de agente travado não recebe ligação', ra);
    await av(`Whiteboard.nucleo.atualizar('${agT}', { travado: false }); delete Whiteboard.nucleo.elemento('${agT}').travado`);
  }

  conferir(consoleErros.length === 0, 'nenhum erro no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção no teste: ' + (e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { if (pcdp) await fecharEdge(pcdp, PERFIL); } catch {}
  srv.close();
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PERFIL, { recursive: true, force: true }); break; } catch { await dormir(300); } }
}
console.log(`\nWhiteboard ligação UI: ${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('  FALHA: ' + f);
if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
process.exit(res.falhas.length ? 1 : 0);
