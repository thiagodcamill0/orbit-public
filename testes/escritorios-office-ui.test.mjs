// Escritórios na aba Office do index.html (contrato §10 e Etapa 2): abrirOffice carrega assets/escritorios-painel.css/js e
// escritorios-canvas.css/js; com escritórios a aba abre no CANVAS (faixa e palco escondidos, Office pausado); entrar num
// escritório (ou em "Sessões") mostra o palco; "← Escritórios" volta; o SSE `escritorio` chega ao canvas; sair da aba desmonta.
// Sobe o mock (ROTEIRO=0, só leitura) numa porta de 47822–47826 e, na frente dele, um proxy de teste (outra porta da faixa)
// que responde GET/POST /escritorios (ligado/desligado) e injeta o SSE `escritorio` no /fluxo. Edge headless mudo, perfil
// temporário apagado no fim (fecharEdge). Os métodos do Office são embrulhados (antes do office.js) para registrar as chamadas.
// Confere:
//  - sem a rota (404): a aba Office abre, a faixa fica escondida, o painel e o canvas não montam, o Office funciona, zero erros;
//  - com a rota: canvas visível com N+1 ladrilhos, palco e faixa escondidos, Office pausado, nenhuma chamada a Office.escritorio;
//    Enter num ladrilho entra (palco e faixa, retomar, Office.escritorio(id)); "← Escritórios" volta; duplo clique em Sessões
//    entra com Office.escritorio(null) e a barra "← Escritórios"; criar pela gaveta no canvas não entra; o SSE chega ao canvas,
//    ao painel e ao Office; sair da aba desmonta tudo; voltar lembra onde estava; zero erros.
// node testes/escritorios-office-ui.test.mjs [pasta-de-saida]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'orbit-escritorios-office-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (cond) { ok++; console.log('ok   ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
};

const resumo = (id, nome, status = 'ociosa') => ({ id, nome, funcao: 'Time de teste', membros: 2, status, ativos: 0, convidados: 0, canvas: { x: 0, y: 0 },
  agentes: [{ id: 'orquestrador', nome: 'Líder', papel: 'orquestrador', provedor: 'claude', estado: 'ocioso' }],
  custo: { execucaoUsd: 0, diaUsd: 0, limiteExecucaoUsd: 5, limiteDiaUsd: 20, planoPct: 0 } });
const LISTA = [resumo('alfa', 'Alfa'), resumo('beta', 'Beta')];
const detalhe = (id) => ({ escritorio: { id, nome: id, funcao: 'Time de teste', membros: [], orquestrador: {} }, execucao: null });
let rotaLigada = false;
let atrasoPainel = 0; // atrasa UMA vez o GET /escritorios sem `accept: application/json` (o do painel; a sonda do index manda esse header)
const clientesSse = new Set();

const PORTA_MOCK = await escolherPorta(47823);
const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA_MOCK), ROTEIRO: '0' }, stdio: 'ignore' });
let proxy = null;
const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-escritorios-office-'));
const pcdp = 9450 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORTA_MOCK}/saude`)).ok) break; } catch {} await dormir(150); }
  const PORTA = await escolherPorta(47825);
  const BASE = `http://127.0.0.1:${PORTA}`;
  const json = (res, st, o) => { res.writeHead(st, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  proxy = http.createServer((req, res) => {
    const u = new URL(req.url, BASE);
    if (rotaLigada && req.method === 'GET' && u.pathname === '/escritorios') {
      if (atrasoPainel > 0 && !/application\/json/.test(req.headers.accept || '')) {
        const ms = atrasoPainel; atrasoPainel = 0;
        setTimeout(() => { try { json(res, 200, { escritorios: LISTA }); } catch {} }, ms);
        return;
      }
      return json(res, 200, { escritorios: LISTA });
    }
    const mEx = rotaLigada && req.method === 'POST' && /^\/escritorios\/([^/]+)\/excluir$/.exec(u.pathname);
    if (mEx) { // excluir: tira da lista em memória
      const i = LISTA.findIndex((x) => x.id === decodeURIComponent(mEx[1]));
      if (i < 0) return json(res, 404, { erro: 'Escritório não encontrado.' });
      LISTA.splice(i, 1);
      return json(res, 200, { ok: true });
    }
    if (rotaLigada && req.method === 'POST' && u.pathname === '/escritorios') { // criar pela gaveta
      const partes = [];
      req.on('data', (c) => partes.push(c));
      req.on('end', () => {
        let corpo = {};
        try { corpo = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch {}
        const novo = resumo('novo-' + (LISTA.length + 1), corpo.nome || 'Novo', 'ociosa');
        LISTA.push(novo);
        json(res, 200, { escritorio: { id: novo.id, nome: novo.nome } });
      });
      return;
    }
    const m = rotaLigada && req.method === 'GET' && /^\/escritorios\/([^/]+)$/.exec(u.pathname);
    if (m) return json(res, 200, detalhe(decodeURIComponent(m[1])));
    if (rotaLigada && req.method === 'GET' && u.pathname === '/modelos') return json(res, 200, { modelos: [] });
    const up = http.request({ host: '127.0.0.1', port: PORTA_MOCK, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
    if (u.pathname === '/fluxo') { clientesSse.add(res); res.on('close', () => clientesSse.delete(res)); }
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(PORTA, '127.0.0.1', r));
  const sse = (tipo, dados) => { for (const c of clientesSse) c.write(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`); };

  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${perfil}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pend = new Map(); let erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') erros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') erros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  const esperar = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await av(expr).catch(() => false)) return true; await dormir(100); } return false; };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.bringToFront');
  // registra as chamadas do index ao Office (embrulha os métodos quando o office.js atribui window.Office)
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ch = [];
    (() => { let v; Object.defineProperty(window, 'Office', { configurable: true, enumerable: true, get() { return v; }, set(o) {
      if (o && typeof o === 'object') for (const k of ['pausar', 'retomar', 'escritorio', 'aoEscritorio']) {
        const f = o[k];
        if (typeof f === 'function') o[k] = function (...a) { window.__ch.push([k, k === 'aoEscritorio' ? (a[0] && a[0].id) : (a[0] === undefined ? null : a[0])]); return f.apply(this, a); };
      }
      v = o; } }); })();` });
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };

  const tecla = async (key, code, vk) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : undefined });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  // visível = existe, não está com display:none e tem tamanho
  const vis = (sel) => av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const b = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && b.width > 50 && b.height > 10; })()`);
  const ultimo = () => av(`(window.__ch.filter((c) => c[0] === 'pausar' || c[0] === 'retomar').pop() || [])[0] || null`); // última de pausar/retomar
  const escs = () => av(`window.__ch.filter((c) => c[0] === 'escritorio').map((c) => c[1])`);
  const abrir = async () => {
    await av('try { sessionStorage.clear(); localStorage.clear(); } catch {} true').catch(() => {});
    await av('window.__velha = 1; true').catch(() => {});
    await cdp('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 100; i++) { await dormir(100); if (await av(`!window.__velha && document.querySelectorAll('#lista .linha[data-id]').length > 0`).catch(() => false)) break; }
    for (let i = 0; i < 60; i++) { if (await av(`(() => { const a = document.getElementById('abertura'); return !a || !a.isConnected || a.classList.contains('sai') || getComputedStyle(a).display === 'none'; })()`).catch(() => false)) break; await dormir(100); }
    await dormir(300);
  };
  const irPara = (v) => av(`document.querySelector('.nav-item[data-vista="${v}"]').click(); true`);
  const officeOk = () => av(`(() => { const r = document.querySelector('#office .of-raiz'); if (!r) return false; const b = r.getBoundingClientRect(); return b.width > 300 && b.height > 200 && !!window.Office && r.children.length > 0; })()`);
  const faixa = () => av(`(() => { const f = document.querySelector('#office .office-escritorios'); if (!f) return null; const b = f.getBoundingClientRect(); return { oculta: f.hidden || b.height === 0, barra: !!f.querySelector('.esc-pn-barra'), top: b.top, bottom: b.bottom, h: b.height }; })()`);

  // ───────── 1. Sem a rota (404): o painel não pode quebrar a aba Office ─────────
  rotaLigada = false;
  await abrir();
  await irPara('office');
  conferir(await esperar(`document.getElementById('office') && !document.getElementById('office').hidden && !!document.querySelector('#office .of-raiz')`), '404: a aba Office abre e o palco monta');
  await dormir(1200); // dá tempo da sonda e do script do painel
  conferir(await officeOk(), '404: o Office continua funcionando (palco com tamanho e janela Office)');
  const f404 = await faixa();
  conferir(f404 && f404.oculta && !f404.barra, '404: a faixa fica escondida e o painel não monta', f404);
  conferir(await av(`!document.querySelector('.esc-pn-barra') && !document.querySelector('#office').classList.contains('office-com-esc')`), '404: nenhuma barra de escritórios na página');
  conferir(await av(`!document.querySelector('.esc-cv') && !document.querySelector('#office').classList.contains('office-modo-canvas')`) && await vis('#office .of-raiz'), '404: sem canvas, o palco do Office aparece como sempre');
  conferir(await av(`(window.__ch.filter((c) => c[0] === 'pausar').length === 0)`), '404: o Office não é pausado');
  conferir(await av(`!!document.querySelector('link[href="assets/escritorios-painel.css"]') && typeof window.EscritoriosPainel === 'object'`), '404: o css e o js do painel foram carregados mesmo assim');
  await irPara('geral');
  await dormir(300);
  await irPara('office');
  await dormir(500);
  conferir(await officeOk(), '404: sair e voltar para a aba Office mantém o palco');
  await foto('office-404');
  conferir(!erros.length, '404: zero erros no console', erros);

  // ───────── 2. Com a rota: a aba abre no canvas ─────────
  erros = [];
  rotaLigada = true;
  await abrir();
  await av('window.__ch.length = 0; true');
  await irPara('office');
  conferir(await esperar(`document.querySelectorAll('#office .office-canvas .esc-cv-ladrilho').length === 3`), 'rota ligada: o canvas abre com N+1 ladrilhos (2 escritórios + Sessões)', await av(`[...document.querySelectorAll('.esc-cv-ladrilho')].map((t) => t.dataset.id)`));
  await dormir(500);
  conferir(await av(`JSON.stringify([...document.querySelectorAll('#office .esc-cv-ladrilho')].map((t) => t.dataset.id).sort())`) === JSON.stringify(['alfa', 'beta', 'sessoes']), 'rota ligada: os ladrilhos são alfa, beta e Sessões');
  const cvGeo = await av(`(() => { const o = document.getElementById('office').getBoundingClientRect(), c = document.querySelector('#office .office-canvas').getBoundingClientRect(); return { oh: o.height, ch: c.height, ow: o.width, cw: c.width, top: c.top - o.top, modo: document.getElementById('office').classList.contains('office-modo-canvas') }; })()`);
  conferir(cvGeo.modo && cvGeo.ch > 300 && Math.abs(cvGeo.ch - cvGeo.oh) < 3 && Math.abs(cvGeo.cw - cvGeo.ow) < 3 && Math.abs(cvGeo.top) < 3, 'rota ligada: o canvas ocupa a área da aba', cvGeo);
  conferir(!(await vis('#office .of-raiz')) && !(await vis('#office .office-escritorios')) && !(await vis('#office .office-barra-sessoes')), 'rota ligada: no canvas, palco, faixa e barra de volta ficam escondidos');
  conferir(await vis('#office .office-canvas .esc-cv'), 'rota ligada: o canvas está visível');
  conferir((await ultimo()) === 'pausar', 'rota ligada: o Office fica pausado no canvas', await av('window.__ch'));
  conferir((await escs()).length === 0, 'rota ligada: abrir a aba no canvas não chama Office.escritorio', await escs());
  conferir(await esperar(`document.querySelector('#office .esc-cv').dataset.mini !== 'carregando'`, 6000), 'rota ligada: a miniatura da Vila chega ao canvas', await av(`document.querySelector('#office .esc-cv').dataset.mini`));
  conferir(await av(`document.querySelectorAll('#office .esc-pn-sel option').length === 2`), 'rota ligada: o painel segue montado (faixa escondida) com os 2 escritórios');
  await foto('office-canvas');

  // SSE no canvas: chega ao canvas, ao painel e ao Office
  LISTA.push(resumo('gama', 'Gama', 'rodando'));
  sse('escritorio', { id: 'gama', resumo: resumo('gama', 'Gama', 'rodando') });
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === 4 && !!document.querySelector('.esc-cv-ladrilho[data-id="gama"]')`, 3000), 'SSE escritorio chega ao canvas (ladrilho novo)');
  conferir(await esperar(`document.querySelectorAll('#office .esc-pn-sel option').length === 3`, 3000), 'SSE escritorio chega ao painel (novo escritório na lista)');
  conferir(await esperar(`window.__ch.some((c) => c[0] === 'aoEscritorio' && c[1] === 'gama')`, 3000), 'SSE escritorio chega ao Office.aoEscritorio', await av('window.__ch'));
  sse('escritorio', { id: 'gama', resumo: resumo('gama', 'Gama', 'ociosa') });
  conferir(await esperar(`document.querySelector('.esc-cv-ladrilho[data-id="gama"]').dataset.status === 'ociosa'`, 3000), 'SSE escritorio atualiza o status do ladrilho', await av(`document.querySelector('.esc-cv-ladrilho[data-id="gama"]').dataset.status`));

  // criar pela gaveta no modo canvas não entra no escritório
  await av('window.__ch.length = 0; true');
  await av(`[...document.querySelectorAll('#office .esc-cv-barra button')].find((b) => b.textContent.trim() === 'Novo escritório').click(); true`);
  conferir(await esperar(`!!document.querySelector('.esc-pn-gaveta')`, 3000), 'canvas: "Novo escritório" abre a gaveta do painel');
  await av(`window.gv = () => document.querySelector('.esc-pn-gaveta');
    window.btn = (t) => [...gv().querySelectorAll('button')].find((b) => b.textContent.trim() === t);
    window.rotulo = (t) => { const l = [...gv().querySelectorAll('label')].find((x) => x.textContent.trim() === t); return l && document.getElementById(l.htmlFor); };
    window.def = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    def(rotulo('Nome'), 'Criado no canvas'); def(rotulo('Pasta de trabalho'), ${JSON.stringify(os.tmpdir())}); def(rotulo('Prompt do orquestrador'), 'Você lidera.'); btn('Criar escritório').click(); true`);
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === 5`, 4000), 'canvas: o escritório criado pela gaveta aparece como ladrilho (onMudou recarrega o canvas)', await av(`document.querySelectorAll('#office .esc-cv-ladrilho').length`));
  await dormir(500);
  conferir(await av(`document.getElementById('office').classList.contains('office-modo-canvas')`) && await vis('#office .office-canvas .esc-cv') && !(await vis('#office .of-raiz')), 'criar pela gaveta no canvas NÃO entra no escritório (continua no canvas)');
  conferir((await escs()).length === 0 && (await ultimo()) !== 'retomar', 'criar pela gaveta não chama Office.escritorio nem retoma o Office', await av('window.__ch'));
  conferir(await av(`document.querySelector('#office .esc-pn-sel').selectedOptions[0].textContent === 'Criado no canvas'`), 'o painel selecionou o novo escritório (sem entrar)');

  // entrar num escritório (Enter no ladrilho)
  await av('window.__ch.length = 0; true');
  await av(`document.querySelector('.esc-cv-ladrilho[data-id="alfa"]').focus(); true`);
  await tecla('Enter', 'Enter', 13);
  conferir(await esperar(`!document.querySelector('#office .esc-cv')`, 3000), 'entrar: o canvas some (desmontado)');
  conferir(await esperar(`document.querySelector('#office .of-raiz') && document.querySelector('#office .of-raiz').getBoundingClientRect().width > 300`, 3000), 'entrar: o palco do Office fica visível');
  const dentro = await av(`(() => {
    const o = document.getElementById('office').getBoundingClientRect(), f = document.querySelector('#office .office-escritorios').getBoundingClientRect(), r = document.querySelector('#office .of-raiz').getBoundingClientRect();
    return { faixaTopo: f.top, faixaBaixo: f.bottom, faixaH: f.height, raizTopo: r.top, raizBaixo: r.bottom, officeTopo: o.top, officeBaixo: o.bottom, comClasse: document.getElementById('office').classList.contains('office-com-esc'),
      canvasModo: document.getElementById('office').classList.contains('office-modo-canvas'), voltar: !!document.querySelector('#office .esc-pn-voltar'), sel: document.querySelector('#office .esc-pn-sel').value };
  })()`);
  conferir(dentro.comClasse && !dentro.canvasModo && dentro.faixaH > 10 && Math.abs(dentro.faixaTopo - dentro.officeTopo) < 2, 'entrar: a faixa aparece no topo da aba, com altura', dentro);
  conferir(dentro.raizTopo >= dentro.faixaBaixo - 1 && dentro.raizBaixo <= dentro.officeBaixo + 2, 'entrar: o palco fica abaixo da faixa, sem vazar', dentro);
  conferir(dentro.voltar && dentro.sel === 'alfa', 'entrar: a faixa tem "← Escritórios" e o painel seleciona o escritório', dentro);
  conferir((await ultimo()) === 'retomar', 'entrar: Office.retomar()', await av('window.__ch'));
  conferir(JSON.stringify(await escs()).includes('"alfa"') && (await escs()).at(-1) === 'alfa', 'entrar: Office.escritorio("alfa")', await escs());
  conferir(await officeOk(), 'entrar: o Office funciona (palco com tamanho)');
  await foto('office-dentro');

  // dentro: selecionar no painel acompanha o Office; SSE chega ao Office
  await av('window.__ch.length = 0; true');
  await av(`window.EscritoriosPainel.selecionar('beta'); true`);
  conferir(await esperar(`window.__ch.some((c) => c[0] === 'escritorio' && c[1] === 'beta')`, 3000), 'dentro: selecionar no painel chama Office.escritorio(id)', await escs());
  sse('escritorio', { id: 'beta', resumo: resumo('beta', 'Beta', 'rodando') });
  conferir(await esperar(`window.__ch.some((c) => c[0] === 'aoEscritorio' && c[1] === 'beta')`, 3000), 'dentro: SSE escritorio chega ao Office.aoEscritorio');

  // sair e voltar à aba lembra que estava dentro
  await irPara('geral');
  await dormir(400);
  const fora = await faixa();
  conferir(await av(`!document.querySelector('.esc-pn-barra') && !document.querySelector('.esc-cv')`) && fora && fora.oculta, 'sair da aba Office desmonta o painel e o canvas e esconde a faixa', fora);
  sse('escritorio', { id: 'gama', resumo: resumo('gama', 'Gama', 'ociosa') }); // tudo desmontado: não pode dar erro
  await dormir(300);
  await av('window.__ch.length = 0; true');
  await irPara('office');
  conferir(await esperar(`!!document.querySelector('#office .esc-pn-barra')`, 5000), 'voltar para a aba Office monta o painel de novo');
  conferir(await officeOk() && !(await vis('#office .office-canvas .esc-cv')) && await vis('#office .office-escritorios'), 'voltar à aba lembra: continua dentro do escritório (faixa e palco, sem canvas)');
  conferir((await ultimo()) === 'retomar' && (await escs()).at(-1) === 'beta', 'voltar à aba: Office retomado no mesmo escritório', await av('window.__ch'));

  // "← Escritórios" volta ao canvas
  await av('window.__ch.length = 0; true');
  await av(`document.querySelector('#office .esc-pn-voltar').click(); true`);
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === 5`, 3000), 'voltar: o canvas reaparece com os ladrilhos');
  conferir(!(await vis('#office .of-raiz')) && !(await vis('#office .office-escritorios')), 'voltar: palco e faixa escondem de novo');
  conferir((await ultimo()) === 'pausar', 'voltar: Office.pausar()', await av('window.__ch'));
  await irPara('geral');
  await dormir(300);
  await irPara('office');
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === 5`, 5000) && !(await vis('#office .of-raiz')), 'sair e voltar à aba depois de voltar ao canvas: abre no canvas');

  // entrar em Sessões (duplo clique de verdade na miniatura)
  await dormir(500);
  await av('window.__ch.length = 0; true');
  const p = await av(`(() => { const b = document.querySelector('.esc-cv-ladrilho[data-id="sessoes"] .esc-cv-mini').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const n of [1, 2]) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: n });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: n });
  }
  conferir(await esperar(`!document.querySelector('#office .esc-cv') && document.querySelector('#office .of-raiz').getBoundingClientRect().width > 300`, 3000), 'Sessões: o duplo clique no ladrilho mostra o palco');
  conferir(!(await vis('#office .office-escritorios')) && await vis('#office .office-barra-sessoes'), 'Sessões: a faixa fica escondida e aparece a barra "← Escritórios"');
  conferir((await ultimo()) === 'retomar' && (await escs()).length === 1 && (await escs())[0] === null, 'Sessões: Office.retomar() e Office.escritorio(null)', await av('window.__ch'));
  conferir(await officeOk(), 'Sessões: o Office funciona');
  // criar/selecionar no painel dentro de Sessões não muda o Office
  await av('window.__ch.length = 0; true');
  await av(`window.EscritoriosPainel.selecionar('alfa'); true`);
  await dormir(300);
  conferir((await escs()).length === 0, 'Sessões: mudar a seleção do painel não chama Office.escritorio', await escs());
  await irPara('geral');
  await dormir(300);
  await irPara('office');
  conferir(await esperar(`!!document.querySelector('#office .esc-pn-barra')`, 5000) && await vis('#office .office-barra-sessoes') && !(await vis('#office .office-canvas .esc-cv')), 'sair e voltar à aba lembra que estava em Sessões');
  await av('window.__ch.length = 0; true');
  await av(`document.querySelector('#office .office-barra-sessoes button').click(); true`);
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === 5`, 3000) && !(await vis('#office .of-raiz')) && !(await vis('#office .office-barra-sessoes')), 'Sessões: "← Escritórios" volta ao canvas');
  conferir((await ultimo()) === 'pausar', 'Sessões: voltar chama Office.pausar()', await av('window.__ch'));
  conferir(!erros.length, 'rota ligada: zero erros no console', erros);

  // ───────── 3. Entrar antes de a lista do painel chegar ─────────
  erros = [];
  const lib = `window.gv = () => document.querySelector('.esc-pn-gaveta');
    window.rotulo = (t) => { const l = [...gv().querySelectorAll('label')].find((x) => x.textContent.trim() === t); return l && document.getElementById(l.htmlFor); };
    window.def = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    window.dlgBtn = (t) => [...document.querySelectorAll('.esc-pn-dialogo button')].find((b) => b.textContent.trim() === t);
    window.officeVis = () => { const o = document.getElementById('office'); const b = o.getBoundingClientRect(); return getComputedStyle(o).display !== 'none' && b.width > 50 && b.height > 50; };
    window.dlgDescartar = () => !!document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]');
    true`;
  atrasoPainel = 2500;
  await abrir();
  await av('window.__ch.length = 0; true');
  await irPara('office');
  const nLad = LISTA.length + 1;
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === ${nLad}`, 2000), 'lista atrasada: o canvas (que tem a própria lista) já mostra os ladrilhos', await av(`document.querySelectorAll('#office .esc-cv-ladrilho').length`));
  const antes = await av(`({ opts: [...document.querySelectorAll('#office .esc-pn-sel option')].map((o) => o.value) })`);
  conferir(antes.opts.length === 1 && antes.opts[0] === '', 'lista atrasada: o painel ainda não recebeu a lista (seletor vazio)', antes);
  await av(`document.querySelector('.esc-cv-ladrilho[data-id="beta"]').focus(); true`);
  await tecla('Enter', 'Enter', 13);
  conferir(await esperar(`!document.querySelector('#office .esc-cv')`, 3000), 'lista atrasada: entrar em Beta desmonta o canvas e mostra o palco');
  conferir((await escs()).at(-1) === 'beta', 'lista atrasada: Office.escritorio("beta") na entrada', await escs());
  conferir(await esperar(`document.querySelector('#office .esc-pn-sel').value === 'beta'`, 6000), 'lista atrasada: quando a lista chega, a faixa mostra Beta (e não o primeiro da lista)', await av(`document.querySelector('#office .esc-pn-sel').value`));
  conferir((await escs()).every((x) => x === 'beta') && await officeOk() && await vis('#office .office-escritorios'), 'lista atrasada: o Office não foi trocado para outro escritório e segue dentro de Beta', await escs());
  await av(lib);

  // ───────── 4. Gaveta suja: "← Escritórios" e troca de aba perguntam antes de descartar ─────────
  await av(`window.EscritoriosPainel.abrirGaveta('novo'); true`);
  conferir(await esperar(`!!document.querySelector('.esc-pn-gaveta')`, 3000), 'gaveta suja: a gaveta "Novo escritório" abre dentro de Beta');
  await av(`def(rotulo('Nome'), 'Rascunho'); true`);
  await av('window.__ch.length = 0; true');
  await av(`document.querySelector('#office .esc-pn-voltar').click(); true`);
  conferir(await esperar(`dlgDescartar()`, 3000) && /Descartar alterações\?/.test(await av(`document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]').textContent`)), '"← Escritórios" com a gaveta suja pergunta "Descartar alterações?"');
  await av(`dlgBtn('Manter').click(); true`);
  await dormir(300);
  conferir(await av(`!dlgDescartar() && !!gv() && rotulo('Nome').value === 'Rascunho'`) && !(await vis('#office .esc-cv')) && await vis('#office .office-escritorios'), '"Manter": continua dentro de Beta e a gaveta guarda o texto');
  conferir((await ultimo()) !== 'pausar', '"Manter": o Office não foi pausado', await av('window.__ch'));
  // troca de aba com a gaveta suja (ainda dentro de Beta)
  await irPara('geral');
  conferir(await esperar(`dlgDescartar()`, 3000), 'trocar de aba com a gaveta suja pergunta "Descartar alterações?"');
  await av(`dlgBtn('Manter').click(); true`);
  conferir(await esperar(`window.officeVis() && !!document.querySelector('#office .esc-pn-barra')`, 3000), '"Manter": a aba Office volta (painel montado)');
  conferir(await av(`!dlgDescartar() && !!gv() && rotulo('Nome').value === 'Rascunho'`), '"Manter": a gaveta continua com o texto digitado');
  conferir(await officeOk() && !(await vis('#office .esc-cv')) && await vis('#office .office-escritorios'), '"Manter": segue dentro de Beta, com o palco funcionando');
  await irPara('geral');
  conferir(await esperar(`dlgDescartar()`, 3000), 'trocar de aba de novo pergunta outra vez');
  await av(`dlgBtn('Descartar').click(); true`);
  conferir(await esperar(`!window.officeVis() && !document.querySelector('.esc-pn-barra')`, 3000), '"Descartar": vai para a aba Geral e o painel desmonta');
  conferir(await av(`!document.querySelector('.esc-pn-gaveta') && !dlgDescartar()`), '"Descartar": a gaveta some junto');
  // de volta à aba: ainda dentro de Beta; agora "← Escritórios" + Descartar → canvas
  await irPara('office');
  conferir(await esperar(`!!document.querySelector('#office .esc-pn-barra') && !!document.querySelector('#office .esc-pn-voltar')`, 5000), 'voltar à aba Office: painel montado de novo, dentro de Beta');
  await av(`window.EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!document.querySelector('.esc-pn-gaveta')`, 3000);
  await av(`def(rotulo('Nome'), 'Outro rascunho'); document.querySelector('#office .esc-pn-voltar').click(); true`);
  await esperar(`dlgDescartar()`, 3000);
  await av(`dlgBtn('Descartar').click(); true`);
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === ${nLad}`, 4000) && await av(`!document.querySelector('.esc-pn-gaveta')`), '"← Escritórios" + Descartar: volta ao canvas e a gaveta fecha');
  // no canvas, gaveta suja e troca de aba
  await av(`window.EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!document.querySelector('.esc-pn-gaveta')`, 3000);
  await av(`def(rotulo('Nome'), 'Rascunho do canvas'); true`);
  await irPara('geral');
  conferir(await esperar(`dlgDescartar()`, 3000), 'no canvas: trocar de aba com a gaveta suja também pergunta');
  await av(`dlgBtn('Manter').click(); true`);
  conferir(await esperar(`window.officeVis() && !!document.querySelector('.esc-pn-gaveta')`, 3000) && await vis('#office .office-canvas .esc-cv'), 'no canvas: "Manter" volta à aba Office, no canvas, com a gaveta aberta');
  await av(`gv().querySelector('.esc-pn-x').click(); true`); // × da própria gaveta: fecha sem perguntar
  conferir(await esperar(`!document.querySelector('.esc-pn-gaveta')`, 2000) && await av(`!dlgDescartar()`), 'o × da própria gaveta fecha sem perguntar');
  await irPara('geral');
  conferir(await esperar(`!window.officeVis()`, 3000) && await av(`!dlgDescartar() && !document.querySelector('.esc-pn-barra')`), 'com a gaveta fechada, trocar de aba não pergunta nada');
  conferir(!erros.length, 'gaveta suja e lista atrasada: zero erros no console', erros);

  // ───────── 5. Excluir o escritório em que se está dentro → volta ao canvas ─────────
  erros = [];
  await irPara('office');
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === ${nLad}`, 5000), 'excluir de dentro: a aba abre no canvas (parte do estado limpo)');
  await av(`document.querySelector('.esc-cv-ladrilho[data-id="alfa"]').focus(); true`);
  await tecla('Enter', 'Enter', 13);
  conferir(await esperar(`!document.querySelector('#office .esc-cv') && document.querySelector('#office .esc-pn-sel').value === 'alfa'`, 4000), 'excluir de dentro: entrou em Alfa');
  await av('window.__ch.length = 0; true');
  await av(`window.EscritoriosPainel.excluir('alfa'); true`);
  conferir(await esperar(`!!dlgBtn('Excluir de vez')`, 3000), 'excluir de dentro: o diálogo de exclusão abre');
  await av(`dlgBtn('Excluir de vez').click(); true`);
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === ${nLad - 1}`, 5000) && !LISTA.some((x) => x.id === 'alfa'), 'excluir de dentro: volta ao CANVAS (sem o ladrilho de Alfa)', await av(`document.querySelectorAll('#office .esc-cv-ladrilho').length`));
  await dormir(400);
  conferir(await av(`document.getElementById('office').classList.contains('office-modo-canvas')`) && !(await vis('#office .of-raiz')) && !(await vis('#office .office-escritorios')), 'excluir de dentro: palco e faixa escondidos, modo canvas');
  conferir((await ultimo()) === 'pausar', 'excluir de dentro: Office.pausar()', await av('window.__ch'));
  conferir((await escs()).length === 0, 'excluir de dentro: o Office NÃO foi levado a outro escritório (nenhuma chamada a Office.escritorio)', await escs());
  // pelo SSE (excluído em outra aba/cliente)
  await av(`document.querySelector('.esc-cv-ladrilho[data-id="beta"]').focus(); true`);
  await tecla('Enter', 'Enter', 13);
  conferir(await esperar(`!document.querySelector('#office .esc-cv') && document.querySelector('#office .esc-pn-sel').value === 'beta'`, 4000), 'excluir pelo SSE: entrou em Beta');
  await av('window.__ch.length = 0; true');
  LISTA.splice(LISTA.findIndex((x) => x.id === 'beta'), 1);
  sse('escritorio', { id: 'beta', resumo: null });
  conferir(await esperar(`document.querySelectorAll('#office .esc-cv-ladrilho').length === ${nLad - 2}`, 5000), 'excluir pelo SSE: volta ao CANVAS (sem o ladrilho de Beta)', await av(`document.querySelectorAll('#office .esc-cv-ladrilho').length`));
  await dormir(400);
  conferir(!(await vis('#office .of-raiz')) && !(await vis('#office .office-escritorios')) && (await ultimo()) === 'pausar' && (await escs()).length === 0, 'excluir pelo SSE: palco e faixa escondidos, Office pausado e sem Office.escritorio de outro id', { ch: await av('window.__ch') });
  conferir(!erros.length, 'excluir de dentro: zero erros no console', erros);
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e);
} finally {
  await fecharEdge(pcdp, perfil).catch(() => {});
  try { proxy?.closeAllConnections?.(); proxy?.close(); } catch {}
  mock.kill();
}
console.log(`\n${ok} ok, ${falhas} falha(s). Capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
