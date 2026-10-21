// Rodada 9: várias instâncias da Conversa (window.Conversa.criar) ao mesmo tempo, cada uma num painel de aba
// (cv-em-aba), mais a principal (montar) no detalhe. Usa testes/conversa-abas-demo.html com um `api` falso.
// Sobe o mock (ROTEIRO=0) numa porta livre de 47822–47826 e um servidor estático noutra porta livre, que serve a
// demo e assets/ e encaminha o resto (/estado, /modelos, /sessao/:id/conversa*…) ao mock. Edge headless via CDP.
// Uso: node testes/conversa-abas.test.mjs   (capturas em %TEMP%\orbit-conversa-abas)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(PASTA, '..');
const SAIDA = path.join(os.tmpdir(), 'orbit-conversa-abas');
const PERFIL = path.join(SAIDA, 'edge-' + Date.now());
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SAIDA, { recursive: true });

let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => { if (cond) { ok++; console.log('ok  ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); } };

const PORTA_MOCK = await escolherPorta(47826);
const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA_MOCK), ROTEIRO: '0' }, stdio: 'ignore' });
let estatico = null;
let pcdp = 0;
try {
  let vivo = false;
  for (let i = 0; i < 60 && !vivo; i++) { try { vivo = (await fetch(`http://127.0.0.1:${PORTA_MOCK}/saude`)).ok; } catch {} if (!vivo) await dormir(150); }
  if (!vivo) throw new Error('o mock não subiu na porta ' + PORTA_MOCK);

  // Estático + encaminhamento (o SSE passa direto pelo pipe).
  const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  const PORTA = await escolherPorta(47825);
  estatico = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const local = u.pathname === '/testes/conversa-abas-demo.html' ? path.join(PASTA, 'conversa-abas-demo.html')
      : u.pathname.startsWith('/assets/') ? path.join(PROJ, 'assets', path.normalize(decodeURIComponent(u.pathname.slice(8))).replace(/^(\.\.[\\/])+/, '')) : null;
    if (local) {
      fs.readFile(local, (e, d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': TIPOS[path.extname(local)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(d);
      });
      return;
    }
    const p = http.request({ host: '127.0.0.1', port: PORTA_MOCK, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(p);
  });
  await new Promise((r, x) => { estatico.once('error', x); estatico.listen(PORTA, '127.0.0.1', r); });
  const BASE = `http://127.0.0.1:${PORTA}`;

  // Duas sessões do Orbit sem volta em andamento (o menu "/" e os seletores valem nelas).
  const sess = (await (await fetch(BASE + '/estado')).json()).sessoes;
  const livres = sess.filter((s) => s.controle?.modo === 'orbit' && !s.controle.ocupada && !s.controle.permissao);
  conferir(livres.length >= 2, 'o mock tem duas sessões livres do Orbit', livres.map((s) => s.id));
  const [A, B] = livres.map((s) => s.id);

  pcdp = 9500 + Math.floor(Math.random() * 400);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pend = new Map(); const erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') erros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') erros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') erros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 200));
    return r?.result?.value;
  };
  const esperar = async (expr, ms = 6000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await av(expr); if (v) return v; await dormir(120); } return v; };
  const digitar = async (s) => { await cdp('Input.insertText', { text: s }); await dormir(200); };
  const clicar = async (sel) => {
    const c = await av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!c) throw new Error('sem elemento: ' + sel);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await dormir(220);
  };
  const tamanho = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  // Seletor da instância k (0, 1…) na demo e da principal.
  const I = (k) => `.grupo:nth-child(${k + 1}) .cv-em-aba`;
  const P = '#pk-conversa';

  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Log.enable');
  await tamanho(1440, 900);
  await cdp('Page.navigate', { url: `${BASE}/testes/conversa-abas-demo.html?ids=${encodeURIComponent(A)},${encodeURIComponent(B)}` });
  const carregou = await esperar(`!!(window.demo && window.demo.pronto && demo.insts.every((x) => x.inst._debug().itens > 0 && x.inst._debug().es) && Conversa._debug().es)`, 10000);
  conferir(carregou, 'duas instâncias em abas e a principal carregaram, cada uma com o seu fluxo');

  // ── independência: sessões, ids, texto ──
  let v = await av(`(() => { const d = demo.insts.map((x) => x.inst._debug()); return { ids: d.map((x) => x.id), suf: d.map((x) => x.sufixo), fluxos: demo.fluxosAbertos().length, p: Conversa._debug().sufixo,
    txt: demo.insts.map((x) => x.el.querySelector('.cv-itens').textContent.slice(0, 200)) }; })()`);
  conferir(v.ids[0] === A && v.ids[1] === B, 'cada instância mostra a sua sessão', v.ids);
  conferir(v.suf[0] && v.suf[1] && v.suf[0] !== v.suf[1] && v.p === '', 'sufixos distintos; a principal sem sufixo', [v.suf, v.p]);
  conferir(v.txt[0] !== v.txt[1] && v.txt[0].length > 0, 'o texto da conversa é o de cada sessão (sem mistura)');
  conferir(v.fluxos === 3, 'três EventSource abertos (duas abas + principal)', v.fluxos);
  const idsUnicos = `(() => { const c = new Map(); for (const e of document.querySelectorAll('[id]')) c.set(e.id, (c.get(e.id) || 0) + 1); return [...c].filter(([, n]) => n > 1).map(([k]) => k); })()`;
  conferir((await av(idsUnicos)).length === 0, 'nenhum id repetido na página', await av(idsUnicos));
  v = await av(`(() => { const p = document.querySelector('${P}'); return { pop: !!p.querySelector('#cv-pop'), cmds: !!p.querySelector('#cv-cmds'), motivo: !!p.querySelector('#cv-motivo'), tar: !!p.querySelector('#cv-tarefas-lista'),
    a2: !!document.querySelector('${I(0)} #cv-pop-2') && !!document.querySelector('${I(0)} #cv-cmds-2') && !!document.querySelector('${I(0)} #cv-motivo-2') && !!document.querySelector('${I(0)} #cv-tarefas-lista-2'),
    a3: !!document.querySelector('${I(1)} #cv-pop-3'),
    ctrl: [...document.querySelectorAll('[aria-controls], [aria-labelledby], [aria-describedby]')].filter((e) => e.closest('.cv')).flatMap((e) => ['aria-controls', 'aria-labelledby', 'aria-describedby'].map((a) => e.getAttribute(a)).filter(Boolean).flatMap((x) => x.split(' ')).map((id) => ({ id, ok: !!document.getElementById(id) && document.getElementById(id).closest('.cv') === e.closest('.cv') })))
      .filter((x) => !x.ok && !/^cv-(perm-t|esf-t)/.test(x.id)).map((x) => x.id) }; })()`);
  conferir(v.pop && v.cmds && v.motivo && v.tar, 'principal: ids de sempre (cv-pop, cv-cmds, cv-motivo, cv-tarefas-lista)', v);
  conferir(v.a2 && v.a3, 'abas: ids com sufixo (cv-pop-2, cv-cmds-2, cv-motivo-2, cv-tarefas-lista-2; cv-pop-3)', v);
  conferir(v.ctrl.length === 0, 'aria-controls/labelledby/describedby apontam para a própria instância', v.ctrl);

  // ── layout na aba ──
  v = await av(`(() => { const el = document.querySelector('${I(0)}'), r = el.getBoundingClientRect(), pn = el.parentElement.getBoundingClientRect(), c = el.querySelector('.cv-compor').getBoundingClientRect(), l = el.querySelector('.cv-lista');
    const alto = document.createElement('div'); alto.style.height = '3000px'; el.querySelector('.cv-itens').append(alto);
    const rola = l.scrollHeight > l.clientHeight, h2 = Math.round(el.getBoundingClientRect().height); alto.remove();
    return { rola, h2, h: Math.round(r.height), ph: Math.round(pn.height), fundo: Math.round(pn.bottom - c.bottom), ov: getComputedStyle(l).overflowY }; })()`);
  conferir(Math.abs(v.h - v.ph) <= 1 && v.h2 === v.h && v.fundo <= 1 && v.rola && v.ov === 'auto', 'na aba: altura toda, compositor no pé e a lista rolando (conteúdo alto não estica a aba)', v);

  // ── rascunho por instância ──
  await clicar(`${I(0)} .cv-texto`); await digitar('rascunho da aba A');
  await clicar(`${I(1)} .cv-texto`); await digitar('rascunho da aba B');
  v = await av(`demo.insts.map((x) => x.el.querySelector('.cv-texto').value).concat(document.querySelector('${P} .cv-texto').value)`);
  conferir(v[0] === 'rascunho da aba A' && v[1] === 'rascunho da aba B' && v[2] === '', 'rascunhos separados (A, B e a principal vazia)', v);

  // ── menu "/" só na instância em que se digita ──
  await av(`(() => { const t = document.querySelector('${I(1)} .cv-texto'); t.focus(); t.select(); document.execCommand('delete'); })()`);
  await digitar('/');
  await esperar(`!document.querySelector('${I(1)} .cv-cmds').hidden`, 3000);
  v = await av(`(() => { const t = document.querySelector('${I(1)} .cv-texto'), ad = t.getAttribute('aria-activedescendant'), o = ad && document.getElementById(ad);
    return { b: !document.querySelector('${I(1)} .cv-cmds').hidden, a: document.querySelector('${I(0)} .cv-cmds').hidden, p: document.querySelector('${P} .cv-cmds').hidden, ad, dentro: !!o && !!o.closest('${I(1)}'), n: document.querySelectorAll('${I(1)} .cv-cmd').length,
      ids: [...document.querySelectorAll('${I(1)} .cv-cmd')].slice(0, 2).map((x) => x.id), ctrl: t.getAttribute('aria-controls') }; })()`);
  conferir(v.b && v.a && v.p && v.n > 0, 'menu "/" abre só na aba B', v);
  conferir(v.dentro && /^cv-cmd-3-\d+$/.test(v.ad) && v.ctrl === 'cv-cmds-3', 'aria-activedescendant e aria-controls apontam para o menu da aba B (cv-cmd-3-…)', v);
  conferir((await av(idsUnicos)).length === 0, 'ids únicos com o menu aberto');
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(200);
  await av(`(() => { const t = document.querySelector('${I(1)} .cv-texto'); t.focus(); t.select(); document.execCommand('delete'); document.execCommand('insertText', false, 'rascunho da aba B'); t.blur(); })()`);
  conferir(await av(`document.querySelector('${I(0)} .cv-texto').value === 'rascunho da aba A'`), 'digitar na B não mexe no rascunho da A');

  // ── popover dos seletores: só a instância dele, posicionado dentro da aba, fecha com clique fora ──
  const selA = `${I(0)} .cv-sel-modo`;
  const temSel = await av(`(() => { const b = document.querySelector('${selA}'); return !!b && !b.closest('[hidden]') && !b.disabled; })()`);
  conferir(temSel, 'aba A tem o seletor de modo');
  if (temSel) {
    await clicar(selA);
    v = await av(`(() => { const el = document.querySelector('${I(0)}'), p = el.querySelector('.cv-pop'), r = p.getBoundingClientRect(), e = el.getBoundingClientRect(), c = document.querySelector('${selA}').getBoundingClientRect();
      return { aberto: !p.hidden, outro: document.querySelector('${I(1)} .cv-pop').hidden && document.querySelector('${P} .cv-pop').hidden, dentro: r.left >= e.left - 1 && r.right <= e.right + 1 && r.top >= e.top - 1 && r.bottom <= c.top + 1,
        r: [r.left, r.top, r.right, r.bottom].map(Math.round), e: [e.left, e.top, e.right, e.bottom].map(Math.round), exp: document.querySelector('${selA}').getAttribute('aria-expanded'), ctrl: document.querySelector('${selA}').getAttribute('aria-controls') }; })()`);
    conferir(v.aberto && v.outro, 'popover do modo abre só na aba A', v);
    conferir(v.dentro, 'popover dentro da aba A, logo acima do seletor', v);
    conferir(v.exp === 'true' && v.ctrl === 'cv-pop-2', 'gatilho com aria-expanded e aria-controls da própria instância', v);
    await foto('popover-aba', I(0));
    await clicar(`${I(1)} .cv-lista`);
    conferir(await av(`document.querySelector('${I(0)} .cv-pop').hidden`), 'clique em outra aba fecha o popover da A');
  }

  // ── balão (api.balao) ancorado no cartão da própria instância ──
  await clicar(`${I(1)} .cv-b-compactar`);
  v = await av(`(() => { const b = demo.balao, el = document.querySelector('${I(1)}'); if (!b || !b.isConnected) return null; const r = b.getBoundingClientRect(), e = el.getBoundingClientRect(), c = el.querySelector('.cv-campo').getBoundingClientRect();
    return { dentro: r.left >= e.left - 1 && r.left < e.right && r.bottom <= c.top + 1, exp: el.querySelector('.cv-b-compactar').getAttribute('aria-expanded') }; })()`);
  conferir(v && v.dentro && v.exp === 'true', 'balão do Compactar ancorado no cartão da aba B', v);
  await av(`(() => { const b = demo.balao; if (b) b.querySelector('.contorno').click(); })()`);
  await dormir(150);

  // ── parar + abrir: rascunho e anexos ficam ──
  await av(`(() => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([png], 'ponto.png', { type: 'image/png' }));
    const t = document.querySelector('${I(0)} .cv-texto'); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await esperar(`demo.insts[0].inst._debug().anexos === 1`, 3000);
  const antes = await av(`({ d: demo.insts[0].inst._debug(), f: demo.fluxosAbertos().length })`);
  await av(`demo.insts[0].inst.parar()`);
  await dormir(300);
  const parado = await av(`({ d: demo.insts[0].inst._debug(), f: demo.fluxosAbertos().length })`);
  conferir(antes.d.anexos === 1 && !parado.d.es && parado.f === antes.f - 1, 'parar fecha o fluxo da aba A (só o dela)', { antes, parado });
  await dormir(1200); // nada reabre sozinho enquanto parada
  conferir(!(await av(`demo.insts[0].inst._debug().es`)), 'parada continua sem fluxo');
  await av(`demo.insts[0].inst.abrir(${JSON.stringify(A)})`);
  const reaberto = await esperar(`(() => { const d = demo.insts[0].inst._debug(); return d.es ? d : null; })()`, 6000);
  conferir(reaberto && reaberto.rascunho === 'rascunho da aba A' && reaberto.anexos === 1 && reaberto.itens >= antes.d.itens, 'abrir de novo reabre o fluxo com rascunho e anexo', reaberto);
  conferir(await av(`demo.fluxosAbertos().length`) === 3, 'de volta a três fluxos');

  // ── destruir a aba B: ouvintes, fluxo, el ──
  const d0 = await av(`({ api: demo.ouvintesApi(), glob: demo.ouvintesGlobais(), f: demo.fluxosAbertos().length, oB: demo.insts[1].inst._debug().ouvintes })`);
  await av(`demo.insts[1].inst.destruir()`);
  await dormir(300);
  const d1 = await av(`({ api: demo.ouvintesApi(), glob: demo.ouvintesGlobais(), f: demo.fluxosAbertos().length, filhos: demo.insts[1].el.childElementCount, cv: demo.insts[1].el.classList.contains('cv'), dbg: demo.insts[1].inst._debug() })`);
  conferir(d0.api - d1.api === 3, 'destruir cancela as 3 assinaturas api.on', [d0.api, d1.api]);
  conferir(d0.glob - d1.glob === 3, 'destruir tira os 3 ouvintes de document/window', [d0.glob, d1.glob]);
  conferir(d0.oB === 6 && d1.dbg.ouvintes === 0 && !d1.dbg.montada, '_debug: 6 ligados antes, 0 depois', [d0.oB, d1.dbg]);
  conferir(d0.f - d1.f === 1 && !d1.dbg.es, 'destruir fecha o EventSource da B', [d0.f, d1.f]);
  conferir(d1.filhos === 0 && !d1.cv, 'el da B vazio', d1);
  await av(`demo.insts[1].inst.abrir(${JSON.stringify(B)})`);
  await dormir(500);
  conferir((await av(`demo.fluxosAbertos().length`)) === 2 && (await av(`demo.insts[1].el.childElementCount`)) === 0, 'abrir depois de destruir não faz nada');
  conferir(await av(`(() => { const t = document.querySelector('${I(0)} .cv-texto'); return t.value === 'rascunho da aba A' && demo.insts[0].inst._debug().es; })()`), 'a aba A segue viva depois de destruir a B');

  // ── principal intacta ──
  v = await av(`(() => { const d = Conversa._debug(); return { d, sel: document.querySelector('${P}').classList.contains('cv'), em: document.querySelector('${P}').classList.contains('cv-em-aba') }; })()`);
  conferir(v.d.id === A && v.d.es && v.d.itens > 0 && v.sel && !v.em, 'principal (montar) segue com a sua sessão e o seu fluxo', v);
  await clicar(`${P} .cv-texto`); await digitar('/');
  v = await esperar(`(() => { const t = document.querySelector('${P} .cv-texto'), ad = t.getAttribute('aria-activedescendant'); return !document.querySelector('${P} .cv-cmds').hidden && ad ? ad : ''; })()`, 3000);
  conferir(/^cv-cmd-\d+$/.test(v || '') && (await av(`document.querySelector('${I(0)} .cv-cmds').hidden`)), 'menu "/" da principal com os ids de sempre (cv-cmd-N)', v);
  await av(`(() => { const t = document.querySelector('${P} .cv-texto'); t.focus(); t.select(); document.execCommand('delete'); t.blur(); })()`);
  const pmont = await av(`({ glob: demo.ouvintesGlobais(), api: demo.ouvintesApi() })`);
  await av(`demo.insts[0].inst.destruir()`);
  conferir(await av(`Conversa._debug().es && demo.fluxosAbertos().length === 1`), 'destruir as abas não mexe na principal', pmont);

  // ── capturas: uma instância só, 1440 e 420 ──
  async function foto(nome, sel) {
    const c = sel ? await av(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) : null;
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(c ? { clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } } : {}) });
    if (nome.startsWith('conversa-aba-')) fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  }
  for (const [w, h] of [[1440, 900], [420, 860]]) {
    await tamanho(w, h);
    await cdp('Page.navigate', { url: `${BASE}/testes/conversa-abas-demo.html?principal=0&ids=${encodeURIComponent(A)}` });
    await esperar(`!!(window.demo && demo.pronto && demo.insts[0].inst._debug().es)`, 10000);
    await dormir(600);
    v = await av(`(() => { const el = document.querySelector('${I(0)}'), c = el.querySelector('.cv-campo').getBoundingClientRect(), it = el.querySelector('.cv-itens').getBoundingClientRect(), e = el.getBoundingClientRect();
      return { doc: document.documentElement.scrollWidth <= innerWidth, el: el.scrollWidth <= el.clientWidth, barra: [...el.querySelectorAll('.cv-barra, .cv-acoes')].every((b) => b.scrollWidth <= b.clientWidth + 1),
        campo: Math.round(c.width), itens: Math.round(it.width), centro: Math.abs((c.left + c.right) / 2 - (e.left + e.right) / 2) < 4, e: Math.round(e.width) }; })()`);
    if (w === 1440) conferir(v.campo <= 860 && v.campo >= 800 && v.itens <= 860 && v.centro, '1440: coluna centrada de até 860 px', v);
    else conferir(v.doc && v.el && v.barra && v.campo >= 360, '420: sem rolagem horizontal e barras cabendo', v);
    await foto('conversa-aba-' + w);
  }

  conferir(!erros.length, 'sem erros no console', erros);
  await fecharEdge(pcdp, PERFIL);
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e);
  if (pcdp) await fecharEdge(pcdp, PERFIL).catch(() => {});
} finally {
  mock.kill();
  if (estatico) await new Promise((r) => { estatico.closeAllConnections?.(); estatico.close(r); });
  try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch {}
}
console.log(`\n${ok} ok / ${falhas} falhas · capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
