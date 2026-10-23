// Teste oficial do INÍCIO do app do celular (mobile/inicio.js): os 5 cards em widgets contra o servidor falso
// testes/mobile-mock.mjs, num Edge headless mudo (390×844 e 320×568).
//   node --test testes/mobile-widgets.test.mjs      (ou: node testes/mobile-widgets.test.mjs)
// Confere: "Precisa de você" (só com pendências, até 3 sessões e "+ N sessões"), Sessões (total, status, sessão mais relevante,
// sprite), Contexto (70%+, linhas com link), Uso do plano (42% / 27%, "Lido há…", selo "Estimado"),
// Resumo do dia; SEM card de disco; ao vivo pelo SSE (mudar o estado do mock repinta sem recarregar); puxar
// para atualizar com toque real (Input.dispatchTouchEvent); cards esmaecem com o PC caído e voltam; movimento reduzido sem
// transform; 320 px sem rolagem lateral; 0 erro de console e 0 violação de CSP.
// Portas: o mock usa só 47822–47826 (porta-livre; sem porta livre, espera até ~10 min); o CDP, uma livre em 9800–9949.
// Capturas só com ORBIT_CASCA_FOTOS=<pasta> (no máximo 2).

import { test as testeBase, before, after } from 'node:test';
// cada caso tem teto de tempo: travou, falha com mensagem
const test = (nome, fn) => testeBase(nome, { timeout: 100000 }, fn);
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { subirMock } from './mobile-mock.mjs';
import { portaLivre } from './porta-livre.mjs';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const FOTOS = process.env.ORBIT_CASCA_FOTOS ? path.resolve(process.env.ORBIT_CASCA_FOTOS) : '';

let mock = null, edge = null, ws = null, seq = 0, portaCdp = 0, perfil = '', manter = null;
const pend = new Map();
const consoleErros = [];
const violacoes = [];
const esperados = [];   // erros de rede provocados de propósito (401 sem pareamento, PC caído)
let tolerando = 0;      // > 0: erros de rede são esperados (cair/voltar)

// ───────────────────────────── CDP ─────────────────────────────
async function conectar() {
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) {
    try { alvo = (await (await fetch(`http://127.0.0.1:${portaCdp}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!alvo) await dormir(200);
  }
  if (!alvo) throw new Error('o Edge de teste não abriu a porta de depuração ' + portaCdp);
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      const t = d.params.args.map((a) => a.value ?? a.description).join(' ');
      (t.startsWith('VIOLAÇÃO CSP') ? violacoes : consoleErros).push(t);
    }
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
      const e = d.params.entry;
      if (/Content Security Policy|Refused to/i.test(e.text || '')) violacoes.push(e.text);
      else if (e.source === 'network' && (tolerando > 0 || /\/remoto\/(eu(\?|$)|parear\/confirmar)/.test(e.url || ''))) esperados.push(`${e.text} ${e.url || ''}`);
      else consoleErros.push(`${e.source}: ${e.text} ${e.url || ''}`);
    }
  };
}
// toda chamada CDP tem limite: página travada em laço infinito ou Edge morto falham com mensagem em vez de pendurar o arquivo
const cdp = (method, params = {}, ms = 20000) => new Promise((res, rej) => {
  const id = ++seq;
  const t = setTimeout(() => { pend.delete(id); rej(new Error('CDP sem resposta em ' + ms + ' ms: ' + method + ' ' + JSON.stringify(params).slice(0, 160))); }, ms);
  pend.set(id, (d) => { clearTimeout(t); res(d); });
  try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(t); pend.delete(id); rej(e); }
});
const avaliar = async (expr) => {
  const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
  if (r?.exceptionDetails) throw new Error('avaliar: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' em ' + expr.slice(0, 160));
  return r?.result?.value;
};
async function esperar(expr, ms = 8000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { if (await avaliar(expr)) return true; } catch {}
    await dormir(100);
  }
  return false;
}
// esperar e falhar com o estado da página quando não chega lá
async function exigir(expr, msg, ms) {
  if (await esperar(expr, ms)) return;
  let est = '';
  try { est = await avaliar(`JSON.stringify({ hash: location.hash, modo: document.body.dataset.modo, conexao: OM.estado.conexao, rota: OM.rotas.atual(), cards: [...document.querySelectorAll('.in-card')].map((c) => c.dataset.w + ':' + c.dataset.estado + (c.hidden ? ':oculto' : '')) })`); } catch {}
  assert.fail(msg + ' | ' + expr.slice(0, 160) + ' | estado: ' + est);
}
const foto = async (nome) => {
  if (!FOTOS) return;
  fs.mkdirSync(FOTOS, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(FOTOS, nome + '.png'), Buffer.from(r.result.data, 'base64'));
};
const postMock = (r, corpo = {}) => fetch(mock.base + r, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base }, body: JSON.stringify(corpo) });
const codigoReal = async () => (await (await fetch(mock.base + '/_mock/codigo')).json()).codigo;
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
const irPara = async (hash) => { await avaliar(`location.hash = ${JSON.stringify(hash)}`); };
async function viewport(w, h) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await dormir(250);
}
const base = (nome) => exigir(`OM.rotas.atual().nome === ${JSON.stringify(nome)} && !document.querySelector('.tela.arrastando') && [...document.querySelectorAll('.tela')].filter((t) => !t.hidden).length === 1`, 'a tela do topo devia ser ' + nome, 6000);

// ───────────────────────────── ajudantes do Início ─────────────────────────────
const IN = '.tela[data-tela="inicio"] ';
const card = (w) => `${IN}.in-card[data-w="${w}"]`;
// valor da expressão `fn` (corpo de função com `c` = o card) avaliada na página
const doCard = (w, fn) => avaliar(`(() => { const c = document.querySelector(${JSON.stringify(card(w))}); return c ? (${fn})(c) : null; })()`);
const txtCard = (w, sel) => doCard(w, `(c) => { const e = c.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null; }`);
const txtTodos = (w, sel) => doCard(w, `(c) => [...c.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim())`);
const ids = () => avaliar(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card')})].map((c) => c.dataset.w + ':' + c.dataset.estado + (c.hidden ? ':oculto' : ''))`);
const todosOk = () => `[...document.querySelectorAll(${JSON.stringify(IN + '.in-card')})].filter((c) => !c.hidden).every((c) => c.dataset.estado === 'ok')`;
const mudar = (id, campos) => postMock('/_mock/mudar', { id, ...campos });

// ganchos injetados em toda página: CSP → console.error
const INJETADO = `
  window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));
  window.__ev = [];
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend']) window.addEventListener(t, (e) => { if (window.__ev.length < 400) window.__ev.push(t + ':' + (e.pointerType || '')); }, true);`;

async function abrirPagina(hash = '') {
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  await cdp('Page.navigate', { url: mock.base + '/m' + hash });
  await esperar('document.readyState === "complete"');
  await esperar('!!(window.OM && OM.rotas && OM.folha && OM.gestos && OM.estado)');
  await dormir(200);
}

// toque real no dedo (Input.dispatchTouchEvent): desce de (x, y0) a (x, y1) em 'passos' movimentos
async function arrastarToque(x, y0, y1, passos = 10) {
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= passos; i++) {
    await dormir(16);
    await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y0 + (y1 - y0) * i / passos) }] });
  }
  await dormir(16);
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// dados originais das sessões com pedido, para restaurar depois de mexer no estado ao vivo
const original = {};
async function restaurarPedidos() {
  for (const id of ['s1', 's2', 's3']) {
    await mudar(id, { status: 'aguardando', controle: { permissao: original[id].permissao, pendentes: original[id].pendentes } });
  }
  await exigir(`document.querySelectorAll(${JSON.stringify(card('precisa') + ' .in-esp-l')}).length === 3`, 'os 3 pedidos deviam voltar', 8000);
}

// ───────────────────────────── subida e descida ─────────────────────────────
// o mock só sobe numa porta livre de 47822–47826; sem porta livre (outros testes rodando), espera 30 s e tenta de novo, até ~10 min
async function subirMockComEspera() {
  const fim = Date.now() + 10 * 60e3;
  for (;;) {
    try { return await subirMock({ porta: Number(process.env.GERENCIADOR_PORTA) || 47822 }); } catch (e) {
      if (!/nenhuma porta livre/.test(String(e?.message)) || Date.now() > fim) throw e;
      await dormir(30e3);
    }
  }
}

before(async () => {
  mock = await subirMockComEspera();
  for (const id of ['s1', 's2', 's3']) {
    const c = mock.sessoes.get(id).controle;
    original[id] = { permissao: structuredClone(c.permissao), pendentes: c.pendentes };
  }
  const ini = 9800 + Math.floor(Math.random() * 100);
  for (let p = ini; p < ini + 50 && !portaCdp; p++) if (await portaLivre(p)) portaCdp = p;
  assert.ok(portaCdp, 'nenhuma porta livre para o CDP');
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-inicio-'));
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${portaCdp}`, `--user-data-dir=${perfil}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar();
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await cdp(d + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJETADO });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  await viewport(390, 844);
  // headless deixa a página "hidden": animações/transições ficam pausadas. Forçar visível e em foco, e repetir (o Edge a esconde de novo).
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  manter = setInterval(() => { cdp('Page.bringToFront', {}, 5000).catch(() => {}); }, 1000);
});

after(async () => {
  clearInterval(manter);
  try { ws?.close(); } catch {}
  if (portaCdp) await fecharEdge(portaCdp, perfil);
  try { if (perfil) fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
  try { await mock?.fechar(); } catch {}
});

// ═════════════════════════════ 1. parear e ver os cards ═════════════════════════════
test('parear e chegar no Início: 6 cards na ordem certa, todos com conteúdo, sem card de disco', async () => {
  await abrirPagina();
  await exigir(`document.body.dataset.modo === 'parear'`, 'sem cookie devia estar no modo parear');
  const pedido = await avaliar(`OM.parear.pedir('iPhone do início').then((p) => p.pedido)`);
  assert.ok(pedido, 'OM.parear.pedir devia devolver o pedido');
  assert.equal(await avaliar(`OM.parear.confirmar(${JSON.stringify(pedido)}, ${JSON.stringify(await codigoReal())})`), true);
  await exigir(`document.body.dataset.modo === 'app' && OM.rotas.atual().nome === 'inicio'`, 'depois do código certo devia cair no Início');
  await exigir(`OM.estado.conexao === 'vivo' && OM.estado.sessoes.size === 6`, 'SSE vivo com as 6 sessões do mock');
  await exigir(todosOk(), 'todos os cards visíveis deviam sair do esqueleto e ficar com conteúdo (data-estado=ok)', 10000);

  assert.deepEqual(await ids(), ['precisa:ok', 'sessoes:ok', 'contexto:ok', 'uso:ok', 'resumo:ok'], 'cinco cards, na ordem do contrato');
  assert.equal(await avaliar(`document.querySelectorAll(${JSON.stringify(IN + '.in-lista')}).length`), 1);
  // não há card de disco (nem texto, nem data-w)
  assert.equal(await avaliar(`document.querySelectorAll(${JSON.stringify(IN + '.in-card[data-w*="disco" i]')}).length`), 0, 'sem card de disco');
  assert.ok(!(await avaliar(`/\\bdisco\\b/i.test(document.querySelector(${JSON.stringify(IN + '.in-lista')}).textContent)`)), 'a palavra "disco" não aparece no Início');
  // títulos
  assert.deepEqual(await avaliar(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card .in-tit')})].map((e) => e.textContent.trim())`),
    ['Precisa de você', 'Sessões', 'Contexto', 'Uso do plano', 'Resumo do dia']);
  await foto('inicio-390');
});

test('Início 390×844: Precisa de você, Sessões, Contexto, Uso e Resumo do dia', async () => {
  await viewport(390, 844);
  await irPara('#inicio');
  await base('inicio');

  // Precisa de você: 3 pedidos, 3 sessões (mais antiga primeiro), card leva às Aprovações
  assert.equal(await doCard('precisa', `(c) => c.hidden`), false);
  assert.equal(await doCard('precisa', `(c) => c.tagName + '|' + c.getAttribute('href')`), 'A|#aprovacoes');
  assert.equal(await txtCard('precisa', '.tile-num'), '3');
  assert.equal(await txtCard('precisa', '.in-un'), 'pedidos esperando');
  assert.deepEqual(await doCard('precisa', `(c) => [...c.querySelectorAll('.in-esp-l')].map((e) => e.dataset.k)`), ['s1', 's2', 's3'], 'mais antigo primeiro');
  assert.deepEqual(await txtTodos('precisa', '.in-esp-l .in-nome'), ['Corrigir os testes do pareamento', 'Escolher o banco de dados', 'Nova tela de checkout']);
  assert.match((await txtTodos('precisa', '.in-esp-l .in-meta'))[0], /^Orbit · há 1\d min$/);
  assert.match((await txtTodos('precisa', '.in-esp-l .in-meta'))[1], /^Cliente Exemplo · há [4-6] min$/);
  assert.equal(await doCard('precisa', `(c) => c.querySelector('.in-mais').hidden`), true, 'sem "+ N sessões" com 3 sessões');

  // Sessões
  assert.equal(await txtCard('sessoes', '.in-topo b'), '6');
  assert.equal(await txtCard('sessoes', '.in-topo .in-un'), 'sessões');
  assert.deepEqual(await doCard('sessoes', `(c) => [...c.querySelectorAll('.in-st')].map((e) => e.dataset.s + '=' + e.querySelector('.in-st-n').textContent.trim())`),
    ['aguardando=3', 'trabalhando=1', 'concluida=1', 'nova=1']);
  assert.equal(await txtCard('sessoes', '.in-leg'), 'Nova tela de checkout', 'a sessão mais relevante: aguardando e mais recente');
  assert.equal(await doCard('sessoes', `(c) => c.getAttribute('href')`), '#sessoes');
  const sprite = await doCard('sessoes', `(c) => { const i = c.querySelector('img.in-sprite'); return { src: i.getAttribute('src') || '', w: i.getBoundingClientRect().width }; }`);
  assert.ok(sprite.w > 20, 'o sprite aparece: ' + JSON.stringify(sprite));

  // Contexto: s1, s4 e s5 têm contexto medido; ordenado do mais cheio para o mais vazio
  const ctx = await doCard('contexto', `(c) => [...c.querySelectorAll('a.in-linha')].map((a) => ({ k: a.dataset.k, href: a.getAttribute('href'), nome: a.querySelector('.in-nome').textContent.trim(), val: a.querySelector('.in-val').textContent.trim(), meta: a.querySelector('.in-meta').textContent.trim() }))`);
  assert.deepEqual(ctx.map((x) => x.k), ['s1', 's4', 's5'], 'linhas do Contexto: ' + JSON.stringify(ctx));
  const pcts = ctx.map((x) => parseInt(x.val, 10));
  assert.ok(pcts[0] >= pcts[1] && pcts[1] >= pcts[2], 'ordem decrescente de uso: ' + pcts);
  const s4 = ctx.find((x) => x.k === 's4');
  assert.equal(s4.val, '40%');
  assert.equal(s4.nome, 'Refatorar o diário', 'o apelido vence o título');
  assert.equal(s4.href, '#s=s4');
  assert.match(s4.meta, /400\s?k.* de .*1\s?M|400\s?k de 1\.?0*\s?M|tokens/i, 'linha de tokens: ' + s4.meta);
  const sub = await txtCard('contexto', '.in-sub');
  const altos = ctx.filter((x) => parseInt(x.val, 10) >= 70).length;
  assert.equal(sub, altos ? `${altos} ${altos === 1 ? 'sessão com 70% ou mais' : 'sessões com 70% ou mais'}` : 'Todas com folga, abaixo de 70%.');
  assert.equal(await doCard('contexto', `(c) => c.tagName`), 'SECTION', 'o card de Contexto não é um link; as linhas são');

  // Uso do plano: 42% e 27%, lido há ~2 min, sem selo (leitura recente)
  assert.equal(await doCard('uso', `(c) => c.getAttribute('href')`), '#mais/uso');
  assert.deepEqual(await txtTodos('uso', '.in-item .in-val'), ['42%', '27%']);
  assert.equal((await txtTodos('uso', '.in-item .in-nome')).length, 2);
  assert.match((await txtTodos('uso', '.in-item .in-meta'))[0], /renova/i);
  assert.match(await txtCard('uso', '.in-lido'), /^Lido há \d+ min/);
  assert.equal(await doCard('uso', `(c) => c.querySelector('.in-selo').hidden`), true, 'sem selo "Estimado" com leitura recente');


  // Resumo do dia
  assert.equal(await txtCard('resumo', '.in-topo b'), '14');
  assert.equal(await txtCard('resumo', '.in-topo .in-un'), 'turnos hoje');
  assert.equal(await txtCard('resumo', '.in-sub'), 'em 6 sessões');
  assert.deepEqual(await txtTodos('resumo', '.in-stat-r'), ['Trabalhando', 'Aguardando', 'Esperas']);
  assert.deepEqual(await txtTodos('resumo', '.in-stat-v'), ['47 min', '9 min', '6']);

  // nenhum esqueleto sobrando, cartões dentro da tela, sem rolagem lateral
  assert.equal(await avaliar(`document.querySelectorAll(${JSON.stringify(IN + '.in-esq:not([hidden])')}).length`), 0);
  assert.ok(await avaliar(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card')})].every((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5; })`), 'cartões dentro da largura');
  assert.ok(await semRolagemLateral(), 'rolagem lateral em 390 px');
});

test('os cards levam às telas certas ao tocar (Precisa → Aprovações, Contexto → sessão, Uso → Mais/uso, Sessões → Sessões)', async () => {
  const destinos = [['precisa', 'aprovacoes'], ['sessoes', 'sessoes'], ['uso', 'mais']];
  for (const [w, aba] of destinos) {
    await irPara('#inicio'); await base('inicio');
    await avaliar(`document.querySelector(${JSON.stringify(card(w))}).click()`);
    await exigir(`OM.rotas.atual().aba === ${JSON.stringify(aba)} && OM.rotas.atual().nome !== 'inicio'`, `tocar em ${w} devia sair do Início para ${aba}`, 6000);
    if (w === 'uso') assert.equal(await avaliar('location.hash'), '#mais/uso');
  }
  await irPara('#inicio'); await base('inicio');
  await avaliar(`document.querySelector(${JSON.stringify(card('contexto') + ' a.in-linha[data-k="s4"]')}).click()`);
  await exigir(`OM.rotas.atual().nome === 'conversa' && OM.rotas.atual().params.id === 's4'`, 'a linha do Contexto abre a sessão s4', 6000);
  await irPara('#inicio'); await base('inicio');
});

// ═════════════════════════════ 2. 320×568 ═════════════════════════════
test('Início 320×568: mesmos cards, sem rolagem lateral, nada cortado', async () => {
  await viewport(320, 568);
  try {
    await irPara('#inicio');
    await base('inicio');
    assert.deepEqual(await ids(), ['precisa:ok', 'sessoes:ok', 'contexto:ok', 'uso:ok', 'resumo:ok']);
    assert.ok(await semRolagemLateral(), 'rolagem lateral no Início em 320 px');
    assert.ok(await avaliar(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card')})].every((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5; })`), 'cartão passando da largura de 320 px');
    // nenhum texto estoura o próprio cartão
    const estoura = await avaliar(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card *')})].filter((e) => { const c = e.closest('.in-card').getBoundingClientRect(); const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > c.right + 1 || r.left < c.left - 1); }).slice(0, 5).map((e) => e.className + ':' + e.textContent.slice(0, 30))`);
    assert.deepEqual(estoura, [], 'elementos fora do cartão em 320 px');
    // tudo se alcança rolando: o último cartão fica visível no fim da rolagem
    const alcanca = await avaliar(`(() => { const corpo = document.querySelector(${JSON.stringify(IN + '.tela-corpo')}); corpo.scrollTop = corpo.scrollHeight; const u = document.querySelector(${JSON.stringify(card('resumo'))}).getBoundingClientRect(); return u.bottom <= innerHeight + 0.5 && u.top < innerHeight; })()`);
    assert.ok(alcanca, 'o Resumo do dia devia caber na tela no fim da rolagem');
    await avaliar(`document.querySelector(${JSON.stringify(IN + '.tela-corpo')}).scrollTop = 0`);
    await foto('inicio-320');
    // alvos de toque dos cartões que são links: >= 44 px de altura
    assert.ok(await avaliar(`[...document.querySelectorAll(${JSON.stringify(IN + 'a.in-card, ' + IN + 'a.in-linha')})].every((a) => a.getBoundingClientRect().height >= 44)`), 'links com menos de 44 px de altura');
  } finally { await viewport(390, 844); }
});

// ═════════════════════════════ 3. ao vivo pelo SSE ═════════════════════════════
test('ao vivo: mudar o estado do mock repinta o Início sem recarregar (pedidos, status, contexto, uso)', async () => {
  await irPara('#inicio'); await base('inicio');
  await avaliar(`window.__marca = 'mesma-pagina'; window.__cardPrecisa = document.querySelector(${JSON.stringify(card('precisa'))}); true`);
  const recargas0 = await avaliar(`performance.getEntriesByType('navigation').length`);
  try {
    // 1. um pedido resolvido: 3 → 2 pedidos, a linha de s1 some
    assert.equal((await mudar('s1', { status: 'trabalhando', controle: { permissao: null, pendentes: null } })).status, 200);
    await exigir(`document.querySelector(${JSON.stringify(card('precisa') + ' .tile-num')}).textContent.trim() === '2'`, 'Precisa de você devia cair para 2 pedidos');
    assert.deepEqual(await doCard('precisa', `(c) => [...c.querySelectorAll('.in-esp-l')].map((e) => e.dataset.k)`), ['s2', 's3']);
    await exigir(`[...document.querySelectorAll(${JSON.stringify(card('sessoes') + ' .in-st')})].map((e) => e.dataset.s + '=' + e.querySelector('.in-st-n').textContent.trim()).join() === 'aguardando=2,trabalhando=2,concluida=1,nova=1'`, 'Sessões: 2 aguardando, 2 trabalhando');
    // 2. Contexto ao vivo: s4 sobe para 85%
    await mudar('s4', { contexto: { tokens: 850000, modelo: 'claude-sonnet-5-5', janela: 1000000, pct: 85 } });
    await exigir(`document.querySelector(${JSON.stringify(card('contexto') + ' a.in-linha[data-k="s4"] .in-val')}).textContent.trim() === '85%'`, 'Contexto devia mostrar 85% para s4');
    assert.equal((await txtTodos('contexto', 'a.in-linha'))[0].startsWith('Refatorar o diário'), true, 's4 passa a ser a primeira linha');
    assert.match(await txtCard('contexto', '.in-sub'), /^\d+ sess(ão|ões) com 70% ou mais$/);
    assert.equal(await doCard('contexto', `(c) => c.querySelector('.in-sub').classList.contains('alerta')`), true, 'subtítulo em tom de alerta');
    // 3. Uso ao vivo: evento "uso" do SSE
    const agora = Date.now();
    await postMock('/_mock/uso', { cincoHoras: { pct: 88, renova: agora + 3600e3 }, semanal: { pct: 61, renova: agora + 2 * 86400e3 }, atualizado: agora });
    await exigir(`[...document.querySelectorAll(${JSON.stringify(card('uso') + ' .in-item .in-val')})].map((e) => e.textContent.trim()).join() === '88%,61%'`, 'Uso devia mostrar 88% e 61%');
    assert.match(await txtCard('uso', '.in-lido'), /^Lido agora$/);
    // 4. leitura velha (> 30 min): selo "Estimado"
    await postMock('/_mock/uso', { cincoHoras: { pct: 88, renova: agora + 3600e3 }, semanal: { pct: 61, renova: agora + 2 * 86400e3 }, atualizado: agora - 45 * 60e3 });
    await exigir(`!document.querySelector(${JSON.stringify(card('uso') + ' .in-selo')}).hidden`, 'leitura velha devia mostrar o selo');
    assert.equal(await txtCard('uso', '.in-selo'), 'Estimado');
    // 5. mais pedidos que cabem: "+ N sessões" e só 3 linhas
    await restaurarPedidos();
    await mudar('s5', { status: 'aguardando', revisadaEm: null, controle: { permissao: original.s1.permissao, pendentes: 1 } });
    await mudar('s4', { status: 'aguardando', controle: { permissao: original.s2.permissao, pendentes: 1 } });
    await exigir(`document.querySelector(${JSON.stringify(card('precisa') + ' .tile-num')}).textContent.trim() === '5'`, '5 pedidos');
    assert.equal(await doCard('precisa', `(c) => c.querySelectorAll('.in-esp-l').length`), 3, 'no máximo 3 linhas');
    await exigir(`document.querySelector(${JSON.stringify(card('precisa') + ' .in-mais')}).textContent.trim() === '+ 2 sessões' && !document.querySelector(${JSON.stringify(card('precisa') + ' .in-mais')}).hidden`, '"+ 2 sessões" depois das 3 linhas');
    // 6. tudo resolvido: o card de Precisa de você some
    for (const id of ['s1', 's2', 's3', 's4', 's5']) await mudar(id, { status: 'trabalhando', controle: { permissao: null, pendentes: null } });
    await exigir(`document.querySelector(${JSON.stringify(card('precisa'))}).hidden === true`, 'sem pendências o card Precisa de você devia sumir', 8000);
    assert.equal(await doCard('precisa', `(c) => c.hidden`), true);
  } finally {
    // volta tudo ao estado do mock
    await mudar('s4', { status: 'trabalhando', contexto: { tokens: 400000, modelo: 'claude-sonnet-5-5', janela: 1000000, pct: 40 }, controle: { permissao: null, pendentes: null } });
    await mudar('s5', { status: 'concluida', revisadaEm: Date.now() - 2 * 3600e3, controle: { permissao: null, pendentes: null } });
    await restaurarPedidos();
    const agora = Date.now();
    await postMock('/_mock/uso', { cincoHoras: { pct: 42, renova: agora + 2.5 * 3600e3 }, semanal: { pct: 27, renova: agora + 3 * 86400e3 }, atualizado: agora - 2 * 60e3 });
  }
  await exigir(`document.querySelector(${JSON.stringify(card('precisa') + ' .tile-num')}).textContent.trim() === '3' && [...document.querySelectorAll(${JSON.stringify(card('uso') + ' .in-item .in-val')})].map((e) => e.textContent.trim()).join() === '42%,27%'`, 'o Início voltou aos dados originais', 8000);
  assert.equal(await avaliar('window.__marca'), 'mesma-pagina', 'a página não foi recarregada');
  assert.equal(await avaliar(`window.__cardPrecisa === document.querySelector(${JSON.stringify(card('precisa'))})`), true, 'o card foi repintado no lugar, não recriado');
  assert.equal(await avaliar(`performance.getEntriesByType('navigation').length`), recargas0);
});

// ═════════════════════════════ 4. puxar para atualizar ═════════════════════════════
test('puxar para atualizar (toque real): arrasto curto não faz nada; longo relê o estado', async () => {
  await viewport(390, 844);
  await irPara('#inicio'); await base('inicio');
  const corpo = IN + '.tela-corpo';
  await avaliar(`document.querySelector(${JSON.stringify(corpo)}).scrollTop = 0; true`);
  assert.ok(await avaliar(`document.querySelector(${JSON.stringify(corpo)}).classList.contains('puxavel')`), 'o corpo do Início é puxável');
  // muda o que só chega relendo: resumo do dia (o mock não o difunde pelo SSE)
  mock.estado.resumoDia.turnos = 21;
  const r = await avaliar(`(() => { const b = document.querySelector(${JSON.stringify(corpo)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(Math.max(b.top, (document.querySelector(${JSON.stringify(IN + '.tela-cab')}) || { getBoundingClientRect: () => ({ bottom: 0 }) }).getBoundingClientRect().bottom) + 14) }; })()`);
  try {
    // curto (40 px): não atualiza
    await arrastarToque(r.x, r.y, r.y + 40, 5);
    await dormir(700);
    assert.equal(await txtCard('resumo', '.in-topo b'), '14', 'puxar pouco não atualiza');
    // longo (200 px): atualiza
    const alvoInfo = await avaliar(`(() => { const e = document.elementFromPoint(${r.x}, ${r.y}); const ta = []; for (let n = e; n && n !== document.documentElement; n = n.parentElement) { const t = getComputedStyle(n).touchAction; if (t !== 'auto') ta.push(n.className.toString().slice(0, 30) + '=' + t); } return e.tagName + '.' + e.className + ' | ' + ta.join(' > '); })()`);
    await avaliar('window.__ev.length = 0; true');
    await arrastarToque(r.x, r.y, r.y + 200, 12);
    await dormir(300);
    const resumoEv = await avaliar(`Object.entries(window.__ev.reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {})).join(' ')`);
    await exigir(`document.querySelector(${JSON.stringify(card('resumo') + ' .in-topo b')}).textContent.trim() === '21'`, 'puxar devia reler o estado (turnos 14 → 21); eventos do dedo: ' + resumoEv + ' | alvo: ' + alvoInfo, 8000);
    await exigir(`!document.querySelector('.puxar-ind.girando')`, 'o indicador volta ao fim', 6000);
    await dormir(450);
    assert.equal(await avaliar(`document.querySelector(${JSON.stringify(corpo)}).style.transform`), '', 'a lista volta ao lugar');
    assert.deepEqual(await ids(), ['precisa:ok', 'sessoes:ok', 'contexto:ok', 'uso:ok', 'resumo:ok']);
  } finally {
    mock.estado.resumoDia.turnos = 14;
  }
  // para cima não faz nada
  await arrastarToque(r.x, r.y + 200, r.y, 8);
  await dormir(400);
  assert.equal(await txtCard('resumo', '.in-topo b'), '21', 'puxar para cima não atualiza (segue 21 do mock antigo)');
});

// ═════════════════════════════ 5. PC cai e volta ═════════════════════════════
test('PC cai: os cards esmaecem (.velho, opacidade .55) e voltam sozinhos quando o PC reconecta', async () => {
  await viewport(390, 844);
  await irPara('#inicio'); await base('inicio');
  await exigir(todosOk(), 'cards prontos', 8000);
  const opac = () => avaliar(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card')})].filter((c) => !c.hidden).map((c) => Math.round(parseFloat(getComputedStyle(c).opacity) * 100) / 100)`);
  assert.ok((await opac()).every((o) => o === 1), 'vivo: opacidade 1');
  assert.equal(await avaliar(`document.querySelector(${JSON.stringify(IN + '.in-lista')}).classList.contains('velho')`), false);
  tolerando++;
  try {
    assert.equal((await postMock('/_mock/cair')).status, 200);
    await exigir(`OM.estado.conexao === 'pc'`, 'devia chegar em "PC desconectado"', 14000);
    await exigir(`document.querySelector(${JSON.stringify(IN + '.in-lista')}).classList.contains('velho')`, 'a lista devia ganhar a classe velho', 4000);
    await exigir(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card')})].filter((c) => !c.hidden).every((c) => Math.abs(parseFloat(getComputedStyle(c).opacity) - 0.55) < 0.02)`, 'os cards devem ir a ~0,55 de opacidade', 4000);
    // o conteúdo continua lá (esmaecido, não apagado)
    assert.deepEqual(await ids(), ['precisa:ok', 'sessoes:ok', 'contexto:ok', 'uso:ok', 'resumo:ok']);
    assert.ok((await txtCard('resumo', '.in-topo b')).length > 0, 'o resumo segue na tela');
    await foto('inicio-pc-caiu');
    assert.equal((await postMock('/_mock/voltar')).status, 200);
    await exigir(`OM.estado.conexao === 'vivo' && !document.querySelector(${JSON.stringify(IN + '.in-lista')}).classList.contains('velho')`, 'depois do /_mock/voltar devia reconectar e tirar o esmaecido', 25000);
    await exigir(`[...document.querySelectorAll(${JSON.stringify(IN + '.in-card')})].filter((c) => !c.hidden).every((c) => parseFloat(getComputedStyle(c).opacity) > 0.98)`, 'os cards voltam à opacidade 1', 4000);
    await exigir(todosOk(), 'cards com conteúdo depois de reconectar', 8000);
    assert.equal(await avaliar('OM.estado.sessoes.size'), 6);
  } finally {
    await postMock('/_mock/voltar');
    tolerando--;
  }
});

// ═════════════════════════════ 6. movimento reduzido ═════════════════════════════
test('movimento reduzido: o Início carrega, atualiza ao vivo e puxa sem transform nem barras correndo', async () => {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    await viewport(390, 844);
    await abrirPagina('#inicio');
    await exigir(`document.body.dataset.modo === 'app' && OM.rotas.atual().nome === 'inicio' && OM.estado.sessoes.size === 6`, 'reabrir já pareado cai no Início', 10000);
    await exigir(todosOk(), 'cards com conteúdo em movimento reduzido', 10000);
    assert.equal(await avaliar(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
    // as barras não correm e a entrada vira só fade (a regra de @keyframes vencedora não tem transform)
    assert.equal(await avaliar(`getComputedStyle(document.querySelector(${JSON.stringify(IN + '.in-trilho i')})).transitionDuration`), '0s', 'barra sem transição');
    assert.equal(await avaliar(`(() => { const ks = []; for (const f of document.styleSheets) { let rs; try { rs = f.cssRules; } catch { continue; } const olha = (lista) => { for (const r of lista) { if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'in-entra') ks.push(r.cssText); else if (r.type === CSSRule.MEDIA_RULE && matchMedia(r.conditionText).matches) olha(r.cssRules); } }; olha(rs); } return ks.length ? /transform/.test(ks[ks.length - 1]) : null; })()`), false, 'a entrada em movimento reduzido não usa transform');
    // ao vivo
    await mudar('s1', { status: 'trabalhando', controle: { permissao: null, pendentes: null } });
    await exigir(`document.querySelector(${JSON.stringify(card('precisa') + ' .tile-num')}).textContent.trim() === '2'`, 'repinta ao vivo com movimento reduzido');
    await restaurarPedidos();
    await exigir(`document.querySelector(${JSON.stringify(card('precisa') + ' .tile-num')}).textContent.trim() === '3'`, 'volta a 3 pedidos');
    // puxar: sem translate no corpo durante o arrasto
    const corpo = IN + '.tela-corpo';
    mock.estado.resumoDia.turnos = 30;
    try {
      const r = await avaliar(`(() => { const b = document.querySelector(${JSON.stringify(corpo)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(Math.max(b.top, (document.querySelector(${JSON.stringify(IN + '.tela-cab')}) || { getBoundingClientRect: () => ({ bottom: 0 }) }).getBoundingClientRect().bottom) + 14) }; })()`);
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
      let transform = '';
      for (let i = 1; i <= 10; i++) {
        await dormir(16);
        await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x, y: r.y + i * 20 }] });
        transform += await avaliar(`document.querySelector(${JSON.stringify(corpo)}).style.transform`);
      }
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(transform, '', 'com movimento reduzido a lista não se desloca ao puxar');
      await exigir(`document.querySelector(${JSON.stringify(card('resumo') + ' .in-topo b')}).textContent.trim() === '30'`, 'puxar ainda atualiza com movimento reduzido', 8000);
    } finally { mock.estado.resumoDia.turnos = 14; }
  } finally {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  }
});

// ═════════════════════════════ 7. limpeza ═════════════════════════════
test('0 erro de console e 0 violação de CSP em todo o fluxo do Início', async () => {
  assert.deepEqual(violacoes, [], 'violações de CSP');
  assert.deepEqual(consoleErros, [], 'erros de console');
  // os erros de rede esperados vêm só dos 503 do PC caído e do 401 antes de parear
  assert.ok(esperados.every((e) => /\/(remoto\/eu|estado|sincronia|fluxo|uso|remoto\/parear)|503|401/.test(e)), 'erros de rede inesperados: ' + esperados.join(' | '));
});
