// Teste oficial da CASCA do app do celular (onda 2, "Celular premium"): mobile/index.html, nucleo.js, rotas.js, folha.js,
// gestos.js, app.css, folha.css contra o servidor falso testes/mobile-mock.mjs, num Edge headless mudo (390×844 e 320×640).
//   node --test testes/mobile-casca.test.mjs
// Confere: pareamento até #inicio; 4 abas (barra e hashes) e badge de Aprovações; #s=<id> empurra e voltar desempilha (botão,
// history.back, gesto da borda); hash inválido → #inicio; #mais/<sub>; folha (paradas, arrasto, Esc, fundo, voltar do navegador)
// e OM.confirmar; puxar para atualizar e deslizar item; faixas de conexão (PC caiu/voltou, sem internet); aparelho revogado →
// parear; movimento reduzido sem transform; 0 erro de console, 0 violação de CSP, sem rolagem lateral em 320 px.
// Gestos por PointerEvent sintético (touch) disparado na página: determinístico e passa pelos mesmos ouvintes dos reais.
// Portas: o mock usa só 47822–47826 (porta-livre); o CDP, uma livre na faixa 9800–9949. Capturas só com ORBIT_CASCA_FOTOS=<pasta>.

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
const esperados = [];   // erros de rede provocados de propósito (401 sem pareamento, PC caído, sem internet...)
let tolerando = 0;      // > 0: erros de rede são esperados (cair/voltar, offline, revogar)

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
  try { est = await avaliar(`JSON.stringify({ hash: location.hash, modo: document.body.dataset.modo, conexao: OM.estado.conexao, rota: OM.rotas.atual(), faixa: document.getElementById('faixa').textContent, folhas: OM.folha.abertas() })`); } catch {}
  assert.fail(msg + ' | ' + expr.slice(0, 140) + ' | estado: ' + est);
}
const foto = async (nome) => {
  if (!FOTOS) return;
  fs.mkdirSync(FOTOS, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(FOTOS, nome + '.png'), Buffer.from(r.result.data, 'base64'));
};
const Q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const rota = () => avaliar('OM.rotas.atual()');
const postMock = (r, corpo = {}) => fetch(mock.base + r, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base }, body: JSON.stringify(corpo) });
const codigoReal = async () => (await (await fetch(mock.base + '/_mock/codigo')).json()).codigo;
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
const irPara = async (hash) => { await avaliar(`location.hash = ${JSON.stringify(hash)}`); };
const tecla = async (key, vk) => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk });
};
async function viewport(w, h) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await dormir(250);
}
const noTopo = (nome) => esperar(`OM.rotas.atual().nome === ${JSON.stringify(nome)}`, 6000);
const base = (nome) => exigir(`OM.rotas.atual().nome === ${JSON.stringify(nome)} && !document.querySelector('.tela.arrastando') && [...document.querySelectorAll('.tela')].filter((t) => !t.hidden).length === 1`, 'a tela do topo devia ser ' + nome, 6000);

// ───────────────────────────── ganchos injetados em toda página ─────────────────────────────
// CSP → console.error; e o simulador de gestos (PointerEvent touch sintético, dispatch no alvo; os ouvintes ficam na janela).
const INJETADO = `
  window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));
  window.__sim = (() => {
    const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
    let n = 100;
    const pe = (tipo, x, y, id) => new PointerEvent(tipo, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
      bubbles: true, cancelable: true, composed: true, button: tipo === 'pointermove' ? -1 : 0, buttons: tipo === 'pointerup' ? 0 : 1 });
    const alvoDe = (a) => (typeof a === 'string' ? document.querySelector(a) : a);
    // arrasta de (x0,y0) a (x1,y1) em 'passos' movimentos separados por 'espera' ms; 'soltar' false deixa o dedo apoiado
    async function arrastar(alvo, x0, y0, x1, y1, o = {}) {
      const { passos = 6, espera = 16, soltar = true } = o;
      const el = alvoDe(alvo) || document.elementFromPoint(x0, y0);
      const id = ++n;
      el.dispatchEvent(pe('pointerdown', x0, y0, id));
      for (let i = 1; i <= passos; i++) {
        await dorme(espera);
        el.dispatchEvent(pe('pointermove', x0 + (x1 - x0) * i / passos, y0 + (y1 - y0) * i / passos, id));
      }
      if (soltar) { await dorme(espera); el.dispatchEvent(pe('pointerup', x1, y1, id)); }
      return id;
    }
    function toque(alvo, x, y) {
      const el = alvoDe(alvo) || document.elementFromPoint(x, y);
      const id = ++n;
      el.dispatchEvent(pe('pointerdown', x, y, id));
      el.dispatchEvent(pe('pointerup', x, y, id));
    }
    const centro = (a) => { const r = alvoDe(a).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    return { arrastar, toque, centro, dorme };
  })();`;

async function abrirPagina(hash = '') {
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  await cdp('Page.navigate', { url: mock.base + '/m' + hash });
  await esperar('document.readyState === "complete"');
  await esperar('!!(window.OM && OM.rotas && OM.folha && OM.gestos && OM.estado)');
  await dormir(200);
}

// ───────────────────────────── subida e descida ─────────────────────────────
before(async () => {
  mock = await subirMock({ porta: Number(process.env.GERENCIADOR_PORTA) || 47822 });
  const ini = 9800 + Math.floor(Math.random() * 100);
  for (let p = ini; p < ini + 50 && !portaCdp; p++) if (await portaLivre(p)) portaCdp = p;
  assert.ok(portaCdp, 'nenhuma porta livre para o CDP');
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-casca-'));
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

// ═════════════════════════════ 1. parear e chegar em #inicio ═════════════════════════════
test('parear: sem cookie abre a tela de parear; código errado falha; o certo leva a #inicio', async () => {
  await abrirPagina();
  await exigir(`document.body.dataset.modo === 'parear'`, 'sem cookie devia estar no modo parear');
  assert.equal((await rota()).nome, 'parear');
  assert.equal(await avaliar(`document.body.dataset.conexao`), 'revogado');
  assert.equal(await avaliar(`OM.estado.motivoParear`), 'novo');
  const pedido = await avaliar(`OM.parear.pedir('iPhone da casca').then((p) => p.pedido)`);
  assert.ok(pedido, 'OM.parear.pedir devia devolver o pedido');
  const certo = await codigoReal();
  assert.match(certo, /^\d{6}$/);
  const errado = certo === '123456' ? '654321' : '123456';
  const falhou = await avaliar(`OM.parear.confirmar(${JSON.stringify(pedido)}, ${JSON.stringify(errado)}).then(() => 'passou', (e) => 'falhou:' + e.status + ':' + (OM.parear.textoErro(e, true) || ''))`);
  assert.match(falhou, /^falhou:(400|401|403)/, 'código errado devia lançar: ' + falhou);
  assert.equal(await avaliar(`document.body.dataset.modo`), 'parear');
  assert.equal(await avaliar(`OM.parear.confirmar(${JSON.stringify(pedido)}, ${JSON.stringify(certo)})`), true);
  await exigir(`document.body.dataset.modo === 'app'`, 'depois do código certo devia entrar no modo app');
  await exigir(`OM.rotas.atual().nome === 'inicio' && OM.rotas.atual().hash === '#inicio'`, 'devia cair em #inicio');
  await exigir(`OM.estado.conexao === 'vivo' && OM.estado.sessoes.size === 6`, 'SSE vivo com as 6 sessões do mock');
  assert.equal(await avaliar(`OM.estado.eu.aparelho.nome`), 'iPhone da casca');
  assert.ok(await avaliar(`!document.getElementById('faixa') || document.getElementById('faixa').hidden`), 'sem faixa quando vivo');
  await foto('1-inicio');
});

// ═════════════════════════════ tela por viewport ═════════════════════════════
// Cada função roda em 390×844 e em 320×640 (a mesma sessão de página, trocando só o viewport).
const VIEWPORTS = [[390, 844], [320, 640]];

async function conferirAbas(w) {
  await irPara('#mais');   // tocar na aba atual só rola ao topo; começar noutra aba para o hash mudar de fato
  await base('mais');
  const abas = [['inicio', 'Início'], ['sessoes', 'Sessões'], ['aprovacoes', 'Aprovações'], ['mais', 'Mais']];
  // pela barra
  for (const [aba, titulo] of abas) {
    await avaliar(`${Q(`.barra-aba[data-aba="${aba}"]`)}.click()`);
    await base(aba);
    assert.equal(await avaliar('location.hash'), '#' + aba, 'a barra devia mudar o hash para #' + aba);
    assert.equal(await avaliar(`[...document.querySelectorAll('.barra-aba[aria-current=page]')].map((a) => a.dataset.aba).join()`), aba);
    assert.equal(await avaliar(`(${Q(`.tela[data-tela="${aba}"] .tit-grande`)} || {}).textContent`), titulo, 'título grande de ' + aba);
    assert.ok(await avaliar(`${Q('#barra')}.getBoundingClientRect().height > 40 && !document.body.classList.contains('sem-barra')`), 'barra visível');
    assert.ok(await semRolagemLateral(), `rolagem lateral na aba ${aba} em ${w}px`);
  }
  // pelos hashes (e os alvos de toque da barra)
  for (const [aba] of [...abas].reverse()) {
    await irPara('#' + aba);
    await base(aba);
    assert.equal(await avaliar(`${Q('.barra-aba[aria-current=page]')}.dataset.aba`), aba);
  }
  assert.ok(await avaliar(`[...document.querySelectorAll('.barra-aba')].every((a) => { const b = a.getBoundingClientRect(); return b.width >= 43.5 && b.height >= 43.5 && b.left >= 0 && b.right <= innerWidth + 0.5; })`), 'abas da barra: >= 44 px e dentro da tela');
}

async function conferirPilha(w) {
  await irPara('#sessoes');
  await base('sessoes');
  // #s=<id> empurra: [sessoes, conversa]
  await irPara('#s=s4');
  await base('conversa');
  let r = await rota();
  assert.deepEqual(r.cadeia, ['sessoes', 'conversa']);
  assert.equal(r.params.id, 's4');
  assert.equal(r.aba, 'sessoes');
  assert.equal(await avaliar(`${Q('.barra-aba[aria-current=page]')}.dataset.aba`), 'sessoes', 'a aba da raiz segue marcada');
  assert.ok(await avaliar(`${Q('.tela[data-tela="conversa"] .cab-voltar')} !== null`), 'conversa tem botão voltar');
  assert.ok(await semRolagemLateral(), `rolagem lateral na conversa em ${w}px`);
  // voltar: botão
  await avaliar(`${Q('.tela[data-tela="conversa"] .cab-voltar')}.click()`);
  await base('sessoes');
  assert.equal(await avaliar('location.hash'), '#sessoes');
  assert.equal(await avaliar('OM.rotas.podeVoltar()'), false);
  // voltar: history.back()
  await irPara('#s=s5');
  await base('conversa');
  await avaliar('history.back()');
  await base('sessoes');
  assert.equal(await avaliar('location.hash'), '#sessoes');
  // voltar: gesto da borda, confirmado (arrasto longo a partir de x=4)
  await irPara('#s=s4');
  await base('conversa');
  await avaliar(`__sim.arrastar(null, 4, 420, ${Math.round(w * 0.7)}, 430, { passos: 8, espera: 16 })`);
  await base('sessoes');
  assert.equal(await avaliar('location.hash'), '#sessoes', 'gesto da borda devia desempilhar');
  // gesto curto e lento: cancela (fica na conversa)
  await irPara('#s=s4');
  await base('conversa');
  await avaliar(`__sim.arrastar(null, 4, 420, 50, 424, { passos: 5, espera: 50 })`);
  await dormir(500);
  r = await rota();
  assert.equal(r.nome, 'conversa', 'gesto curto devia cancelar e ficar na conversa');
  assert.equal(await avaliar(`document.querySelectorAll('.tela:not([hidden])').length`), 1, 'só a conversa visível depois de cancelar');
  assert.equal(await avaliar(`${Q('.tela[data-tela="conversa"]')}.style.transform`), '', 'sem transform sobrando');
  assert.ok(await avaliar(`!document.body.classList.contains('borda-ativa')`));
  // um desvio vertical a partir da borda não volta
  await avaliar(`__sim.arrastar(null, 4, 300, 20, 600, { passos: 6, espera: 16 })`);
  await dormir(300);
  assert.equal((await rota()).nome, 'conversa');
  await avaliar('history.back()');
  await base('sessoes');
}

async function conferirRotasEspeciais() {
  // hash inválido → #inicio
  for (const ruim of ['#lixo', '#s=', '#mais/mais', '#mais/', '#s=a/B', '#parear']) {
    await irPara('#sessoes');
    await base('sessoes');
    await irPara(ruim);
    await exigir(`OM.rotas.atual().nome === 'inicio' && location.hash === '#inicio'`, `hash inválido ${ruim} devia virar #inicio`, 4000);
  }
  // #mais/<sub>: [mais, sub]; sub sem tela real mostra o esqueleto "Em construção"
  await irPara('#mais/nao-existe');
  await base('nao-existe');
  const r = await rota();
  assert.deepEqual(r.cadeia, ['mais', 'nao-existe']);
  assert.equal(r.params.sub, 'nao-existe');
  assert.equal(r.aba, 'mais');
  assert.equal(await avaliar(`${Q('.barra-aba[aria-current=page]')}.dataset.aba`), 'mais');
  assert.match(await avaliar(`${Q('.tela[data-tela="nao-existe"]')}.textContent`), /Em construção/);
  await avaliar(`${Q('.tela[data-tela="nao-existe"] .cab-voltar')}.click()`);
  await base('mais');
  // #s=<id>/<sub>: [aba, conversa, sub]
  await irPara('#s=s2');
  await base('conversa');
  await irPara('#s=s2/detalhe');
  await base('detalhe');
  assert.deepEqual((await rota()).cadeia.slice(1), ['conversa', 'detalhe']);
  await avaliar('history.back()');
  await base('conversa');
  await avaliar('history.back()');
  await esperar(`OM.rotas.atual().nome !== 'conversa'`, 4000);
  // tela registrada vira rota #<nome> acima da aba atual
  await avaliar(`OM.telas.registrar('casca-demo', { titulo: 'Demo', montar(c) { c.append(OM.h('p', { text: 'demo montada' })); } })`);
  await irPara('#sessoes');
  await base('sessoes');
  await irPara('#casca-demo');
  await base('casca-demo');
  assert.deepEqual((await rota()).cadeia, ['sessoes', 'casca-demo']);
  assert.equal(await avaliar(`${Q('.tela[data-tela="casca-demo"] .cab-tit')}.textContent`), 'Demo');
  await avaliar('history.back()');
  await base('sessoes');
}

// ───────────────── folha ─────────────────
const abrirFolha = async (extra = '') => {
  await avaliar(`window.__motivo = null; window.__f = OM.folha.abrir({ titulo: 'Folha de teste', paradas: ['meia', 'inteira'],
    conteudo: (corpo) => { for (let i = 0; i < 40; i++) corpo.append(OM.h('p', { text: 'linha ' + i })); },
    aoFechar: (m) => { window.__motivo = m; } ${extra} }); true`);
  await exigir(`!!document.querySelector('.folha') && document.querySelector('.folha-fundo.visivel')`, 'a folha devia aparecer');
  await dormir(450);
};
const folhaSumiu = (ms) => exigir(`!document.querySelector('.folha') && !document.querySelector('.folha-fundo') && OM.folha.abertas() === 0`, 'a folha devia sumir', ms || 4000);
const topoFolha = () => avaliar(`document.querySelector('.folha').getBoundingClientRect().top`);

async function conferirFolha(w, h) {
  await irPara('#sessoes');
  await base('sessoes');
  const hashAntes = await avaliar('location.hash');

  // paradas: abre em meia (~50%), vai a inteira e volta
  await abrirFolha();
  assert.equal(await avaliar('OM.folha.abertas()'), 1);
  assert.equal(await avaliar('__f.parada()'), 'meia');
  assert.ok(Math.abs((await topoFolha()) - h / 2) <= 4, `meia: topo ${await topoFolha()} devia ser ~${h / 2}`);
  assert.ok((await avaliar(`document.querySelector('.folha').getBoundingClientRect().bottom`)) >= h, 'a folha cola no fundo (sem vão abaixo)');
  assert.equal(await avaliar(`document.querySelector('.folha').getAttribute('role')`), 'dialog');
  assert.equal(await avaliar(`document.getElementById('app').inert`), true, '#app inerte com folha aberta');
  assert.equal(await avaliar(`document.querySelector('.folha h2').textContent`), 'Folha de teste');
  await avaliar(`__f.irPara('inteira')`);
  await dormir(450);
  assert.equal(await avaliar('__f.parada()'), 'inteira');
  const topoInt = await topoFolha();
  assert.ok(topoInt < h * 0.3 && topoInt >= 0, `inteira: topo ${topoInt}`);
  await avaliar(`__f.irPara('meia')`);
  await dormir(450);
  assert.ok(Math.abs((await topoFolha()) - h / 2) <= 4);
  assert.ok(await semRolagemLateral(), `rolagem lateral com a folha aberta em ${w}px`);
  await foto(`folha-${w}`);

  // arrasto para cima → inteira; para baixo → meia; arrasto lento e curto volta à parada; para baixo de novo → fecha
  const [ax, ay] = await avaliar(`__sim.centro('.folha-alca')`);
  await avaliar(`__sim.arrastar('.folha-alca', ${ax}, ${ay}, ${ax}, ${ay - 300}, { passos: 6, espera: 16 })`);
  await dormir(500);
  assert.equal(await avaliar('__f.parada()'), 'inteira', 'arrasto rápido para cima → inteira');
  const [bx, by] = await avaliar(`__sim.centro('.folha-alca')`);
  await avaliar(`__sim.arrastar('.folha-alca', ${bx}, ${by}, ${bx}, ${by + 300}, { passos: 6, espera: 16 })`);
  await dormir(500);
  assert.equal(await avaliar('__f.parada()'), 'meia', 'arrasto rápido para baixo → meia');
  assert.equal(await avaliar('OM.folha.abertas()'), 1);
  const [cx, cy] = await avaliar(`__sim.centro('.folha-alca')`);
  await avaliar(`__sim.arrastar('.folha-alca', ${cx}, ${cy}, ${cx}, ${cy + 30}, { passos: 3, espera: 70 })`);
  await dormir(500);
  assert.equal(await avaliar('__f.parada()'), 'meia', 'arrasto curto e lento volta à parada');
  assert.ok(Math.abs((await topoFolha()) - h / 2) <= 4);
  assert.equal(await avaliar('OM.folha.abertas()'), 1);
  const [dx, dy] = await avaliar(`__sim.centro('.folha-alca')`);
  await avaliar(`__sim.arrastar('.folha-alca', ${dx}, ${dy}, ${dx}, ${dy + Math.round(h * 0.55)}, { passos: 6, espera: 16 })`);
  await folhaSumiu();
  assert.equal(await avaliar('window.__motivo'), 'arrasto');
  assert.equal(await avaliar(`document.getElementById('app').inert`), false, '#app volta a ser interativo');
  assert.equal(await avaliar('location.hash'), hashAntes, 'arrastar para fechar não troca de tela');

  // Esc
  await abrirFolha();
  await tecla('Escape', 27);
  await folhaSumiu();
  assert.equal(await avaliar('window.__motivo'), 'esc');
  // toque no fundo
  await abrirFolha();
  await avaliar(`${Q('.folha-fundo')}.click()`);
  await folhaSumiu();
  assert.equal(await avaliar('window.__motivo'), 'fundo');
  // botão fechar
  await abrirFolha();
  await avaliar(`${Q('.folha-x')}.click()`);
  await folhaSumiu();
  assert.equal(await avaliar('window.__motivo'), 'botao');
  // voltar do navegador: fecha a folha e NÃO troca de tela
  await abrirFolha();
  assert.equal(await avaliar(`history.state && !!history.state.omFolha`), true, 'a folha empurra uma entrada de histórico');
  await avaliar('history.back()');
  await folhaSumiu();
  assert.equal(await avaliar('window.__motivo'), 'voltar');
  assert.equal(await avaliar('location.hash'), hashAntes, 'voltar do navegador só fecha a folha');
  assert.equal((await rota()).nome, 'sessoes');
  // mudar o hash por baixo fecha a folha (motivo rota)
  await abrirFolha();
  await irPara('#aprovacoes');
  await folhaSumiu();
  assert.ok(['rota', 'voltar'].includes(await avaliar('window.__motivo')), 'mudar o hash por baixo fecha a folha');   // o Edge dispara popstate no hash antes do hashchange: o motivo vem como 'voltar'
  await base('aprovacoes');
  // duas folhas: o voltar fecha a de cima primeiro
  await abrirFolha();
  await avaliar(`window.__f2 = OM.folha.abrir({ titulo: 'Segunda', paradas: ['auto'], conteudo: 'texto' }); true`);
  await dormir(450);
  assert.equal(await avaliar('OM.folha.abertas()'), 2);
  await avaliar('history.back()');
  await exigir('OM.folha.abertas() === 1', 'o voltar fecha só a folha de cima');
  assert.equal(await avaliar(`document.querySelector('.folha:not([inert]) h2, .folha h2').textContent`), 'Folha de teste');
  await avaliar('OM.folha.fecharTodas()');
  await folhaSumiu();
  assert.equal((await rota()).nome, 'aprovacoes');

  // OM.confirmar resolve true/false
  const clicarBtn = (t) => avaliar(`(() => { const b = [...document.querySelectorAll('.folha button')].find((x) => x.textContent.trim() === ${JSON.stringify(t)}); if (!b) return false; b.click(); return true; })()`);
  await avaliar(`window.__c = null; OM.confirmar({ titulo: 'Apagar?', texto: 'Não dá para desfazer.', sim: 'Apagar', nao: 'Manter', perigo: true }).then((v) => { window.__c = v; }); true`);
  await exigir(`!!document.querySelector('.folha') && [...document.querySelectorAll('.folha button')].some((b) => b.textContent.trim() === 'Apagar')`, 'confirmar devia abrir a folha');
  assert.match(await avaliar(`document.querySelector('.folha').textContent`), /Não dá para desfazer/);
  assert.ok(await avaliar(`document.querySelector('.folha button.perigo') !== null`), 'botão perigo');
  await dormir(350);
  assert.ok(await clicarBtn('Apagar'));
  await exigir('window.__c === true', 'sim → true');
  await folhaSumiu();
  await avaliar(`window.__c = null; OM.confirmar('Continuar?').then((v) => { window.__c = v; }); true`);
  await exigir(`[...document.querySelectorAll('.folha button')].some((b) => b.textContent.trim() === 'Cancelar')`, 'texto simples também');
  await dormir(350);
  assert.ok(await clicarBtn('Cancelar'));
  await exigir('window.__c === false', 'não → false');
  await folhaSumiu();
  await avaliar(`window.__c = null; OM.confirmar('Esc?').then((v) => { window.__c = v; }); true`);
  await exigir(`!!document.querySelector('.folha')`, 'abre');
  await dormir(350);
  await tecla('Escape', 27);
  await exigir('window.__c === false', 'Esc → false');
  await folhaSumiu();
  await avaliar(`window.__c = null; OM.confirmar('Fundo?').then((v) => { window.__c = v; }); true`);
  await exigir(`!!document.querySelector('.folha')`, 'abre');
  await dormir(350);
  await avaliar(`${Q('.folha-fundo')}.click()`);
  await exigir('window.__c === false', 'fundo → false');
  await folhaSumiu();
  assert.equal(await avaliar('history.state && history.state.omFolha || null'), null, 'nenhuma entrada de folha sobrando');
}

// ───────────────── gestos: puxar e deslizar ─────────────────
async function conferirGestos(w) {
  await irPara('#sessoes');
  await base('sessoes');
  const corpo = `.tela[data-tela="sessoes"] .tela-corpo`;
  await avaliar(`${Q(corpo)}.scrollTop = 0; window.__deslAntes = document.querySelectorAll('.desl').length; true`);
  await avaliar(`window.__puxou = 0; window.__offPuxar = OM.gestos.puxar(${Q(corpo)}, async () => { window.__puxou++; await __sim.dorme(60); }); true`);
  assert.ok(await avaliar(`${Q(corpo)}.classList.contains('puxavel')`));
  const x = Math.round(w / 2);
  // curto: não chama
  await avaliar(`__sim.arrastar(${JSON.stringify(corpo)}, ${x}, 200, ${x}, 240, { passos: 4, espera: 16 })`);
  await dormir(500);
  assert.equal(await avaliar('window.__puxou'), 0, 'puxar curto não atualiza');
  // longo: chama fn uma vez e recolhe
  await avaliar(`__sim.arrastar(${JSON.stringify(corpo)}, ${x}, 200, ${x}, 380, { passos: 8, espera: 16 })`);
  await exigir('window.__puxou === 1', 'puxar longo devia chamar a fn');
  await exigir(`!document.querySelector('.puxar-ind.girando')`, 'o indicador volta ao fim da fn');
  await dormir(450);
  assert.equal(await avaliar(`${Q(corpo)}.style.transform`), '', 'a lista volta ao lugar');
  // puxar para cima não chama
  await avaliar(`__sim.arrastar(${JSON.stringify(corpo)}, ${x}, 400, ${x}, 200, { passos: 6, espera: 16 })`);
  await dormir(300);
  assert.equal(await avaliar('window.__puxou'), 1);
  await avaliar('__offPuxar(); true');
  assert.equal(await avaliar(`${Q(corpo)}.classList.contains('puxavel')`), false);

  // deslizar: dois itens, só um aberto por vez
  await avaliar(`(() => {
    const cont = document.querySelector('.tela[data-tela="sessoes"] .tela-cont');
    window.__acoes = [];
    window.__itens = [0, 1].map((i) => {
      const it = OM.h('div', { class: 'item-teste', tabindex: '0', text: 'Item ' + i, estilo: { height: '64px', background: '#222', padding: '12px' } });
      cont.append(it);
      const d = OM.gestos.deslizar(it, {
        direita: [{ rotulo: 'Apagar', tipo: 'perigo', icone: 'x', acao: () => __acoes.push('apagar' + i) }],
        esquerda: [{ rotulo: 'Fixar', tipo: 'acento', acao: () => __acoes.push('fixar' + i) }],
      });
      return d;
    });
    return true;
  })()`);
  const cx = (i) => avaliar(`(() => { const r = __itens[${i}].el.querySelector('.desl-frente').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const aberto = () => avaliar(`[...document.querySelectorAll('.desl.aberto')].map((e) => e.textContent.trim().slice(0, 14) + '|' + e.dataset.lado)`);
  await avaliar(`document.querySelector('.item-teste').scrollIntoView({ block: 'center' })`);
  let [px, py] = await cx(0);
  // deslizar para a esquerda revela as ações da direita ("Apagar")
  await avaliar(`__sim.arrastar('.item-teste', ${px}, ${py}, ${px - 110}, ${py}, { passos: 6, espera: 16 })`);
  await dormir(450);
  assert.deepEqual((await aberto()).map((s) => s.split('|')[1]), ['dir'], 'item 0 aberto à direita');
  const info = await avaliar(`(() => { const b = __itens[0].el.querySelector('.desl-acoes.desl-dir button'); const r = b.getBoundingClientRect(); return JSON.stringify({ inert: !!b.closest('[inert]'), w: r.width, right: r.right, iw: innerWidth, tr: __itens[0].el.querySelector('.desl-frente').style.transform }); })()`);
  const inf = JSON.parse(info);
  assert.ok(!inf.inert && inf.w > 40 && inf.right <= inf.iw + 1 && /translateX\(-7\d/.test(inf.tr), 'ação Apagar visível e item deslocado: ' + info);
  // abrir o segundo fecha o primeiro
  [px, py] = await cx(1);
  await avaliar(`__sim.arrastar(__itens[1].el.querySelector('.desl-frente'), ${px}, ${py}, ${px + 110}, ${py}, { passos: 6, espera: 16 })`);
  await dormir(450);
  assert.deepEqual((await aberto()).map((s) => s.split('|')[1]), ['esq'], 'só o item 1 aberto, e à esquerda');
  assert.equal(await avaliar(`__itens[0].el.querySelector('.desl-frente').style.transform`), '', 'o item 0 fechou');
  assert.ok(await avaliar(`__itens[0].el.querySelector('.desl-acoes.desl-dir').inert === true`), 'ações do item fechado ficam inertes');
  // a ação chama o callback e fecha
  await avaliar(`__itens[1].el.querySelector('.desl-acoes.desl-esq button').click()`);
  assert.deepEqual(await avaliar('__acoes'), ['fixar1']);
  await dormir(400);
  assert.deepEqual(await aberto(), []);
  // abrir por código e toque fora fecha
  await avaliar(`__itens[0].abrir('direita'); true`);
  await dormir(350);
  assert.equal((await aberto()).length, 1);
  await avaliar(`__sim.toque(null, ${Math.round(w / 2)}, 30)`);
  await dormir(450);
  assert.deepEqual(await aberto(), [], 'toque fora fecha');
  // deslizar vertical não abre (deixa rolar)
  [px, py] = await cx(0);
  await avaliar(`__sim.arrastar('.item-teste', ${px}, ${py}, ${px + 6}, ${py - 60}, { passos: 6, espera: 16 })`);
  await dormir(300);
  assert.deepEqual(await aberto(), []);
  // limpar
  await avaliar(`__itens.forEach((d) => { d.off(); }); document.querySelectorAll('.item-teste').forEach((e) => e.remove()); true`);
  assert.equal(await avaliar(`document.querySelectorAll('.desl').length`), await avaliar('window.__deslAntes'), 'os itens do teste saíram; só ficam os deslizáveis reais da tela');
}

// ───────────────── faixa sem internet ─────────────────
async function offlineOnline(w) {
  await irPara('#inicio');
  await base('inicio');
  tolerando++;
  try {
    await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await exigir(`!document.getElementById('faixa').hidden && /Sem internet/.test(document.getElementById('faixa').textContent) && OM.estado.conexao === 'offline'`, 'offline devia mostrar a faixa "Sem internet"', 6000);
    assert.equal(await avaliar(`document.body.dataset.conexao`), 'offline');
    await dormir(450);   // a faixa entra com fade/translate
    const fx = await avaliar(`(() => { const r = document.getElementById('faixa').getBoundingClientRect(); return JSON.stringify({ l: r.left, r: r.right, t: r.top, h: r.height, iw: innerWidth, vis: document.visibilityState, anim: document.getAnimations().map((x) => x.playState + ':' + Math.round(x.currentTime)).join(), cls: document.getElementById('faixa').className, tr: getComputedStyle(document.getElementById('faixa')).transform }); })()`);
    const q = JSON.parse(fx);
    assert.ok(q.l >= 0 && q.r <= q.iw + 0.5 && q.t >= 0 && q.h > 20, `faixa dentro da tela em ${w}px: ` + fx);
    assert.ok(await semRolagemLateral(), `rolagem lateral com a faixa em ${w}px`);
    await foto(`offline-${w}`);
  } finally {
    await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    // mesmo se uma conferência acima falhou, espera a religação para não contaminar os testes seguintes
    await esperar(`document.getElementById('faixa').hidden && OM.estado.conexao === 'vivo'`, 25000);
  }
  try {
    await exigir(`document.getElementById('faixa').hidden && OM.estado.conexao === 'vivo'`, 'de volta online a faixa devia sumir sozinha e o fluxo voltar', 25000);
  } finally { tolerando--; }
}

for (const [w, h] of VIEWPORTS) {
  test(`${w}×${h}: as 4 abas pela barra e pelos hashes`, async () => { await viewport(w, h); await conferirAbas(w); });
  test(`${w}×${h}: #s=<id> empurra; voltar (botão, history.back, gesto da borda) desempilha`, async () => { await conferirPilha(w); });
  test(`${w}×${h}: hash inválido, #mais/<sub>, #s=<id>/<sub> e tela registrada`, async () => { await conferirRotasEspeciais(); });
  test(`${w}×${h}: folha (paradas, arrasto, Esc, fundo, voltar) e OM.confirmar`, async () => { await conferirFolha(w, h); });
  test(`${w}×${h}: gestos puxar e deslizar`, async () => { await conferirGestos(w); });
  test(`${w}×${h}: sem internet (navigator.onLine falso) mostra a faixa e some ao voltar`, async () => { await offlineOnline(w); });
}

// ═════════════════════════════ 2. badge ═════════════════════════════
test('badge de Aprovações segue as permissões pendentes do mock', async () => {
  await viewport(390, 844);
  await irPara('#inicio');
  await base('inicio');
  const badge = () => avaliar(`(() => { const b = document.querySelector('.barra-aba[data-aba="aprovacoes"] .barra-badge'); return [b.hidden, b.textContent, b.parentElement.getAttribute('aria-label')]; })()`);
  assert.equal(await avaliar('OM.estado.pendentes'), 3);
  assert.deepEqual(await badge(), [false, '3', 'Aprovações, 3 pendentes']);
  await postMock('/_mock/mudar', { id: 's1', controle: { permissao: null } });
  await exigir(`document.querySelector('.barra-badge').textContent === '2'`, 'badge devia cair para 2');
  assert.deepEqual(await badge(), [false, '2', 'Aprovações, 2 pendentes']);
  await postMock('/_mock/mudar', { id: 's2', controle: { permissao: null } });
  await postMock('/_mock/mudar', { id: 's3', controle: { permissao: null } });
  await exigir(`document.querySelector('.barra-badge').hidden`, 'sem pendentes o badge some');
  assert.deepEqual(await badge(), [true, '0', 'Aprovações']);
  assert.equal(await avaliar('OM.estado.pendentes'), 0);
});

// ═════════════════════════════ 3. faixas de conexão ═════════════════════════════
test('PC desconectado: /_mock/cair mostra a faixa; /_mock/voltar a faz sumir sozinha', async () => {
  await viewport(390, 844);
  await irPara('#inicio');
  await base('inicio');
  tolerando++;
  try {
    assert.equal((await postMock('/_mock/cair')).status, 200);
    await exigir(`!document.getElementById('faixa').hidden && /PC desconectado|Reconectando/.test(document.getElementById('faixa').textContent)`, 'a faixa devia aparecer quando o PC cai', 10000);
    await exigir(`OM.estado.conexao === 'pc' && /PC desconectado/.test(document.getElementById('faixa').textContent)`, 'devia chegar em "PC desconectado"', 12000);
    assert.equal(await avaliar('document.body.dataset.conexao'), 'pc');
    assert.ok(await avaliar(`[...document.querySelectorAll('#faixa button')].some((b) => /Tentar agora/.test(b.textContent))`), 'botão Tentar agora');
    assert.ok(await avaliar(`/Tentando/.test(document.querySelector('#faixa .faixa-sub').textContent)`), 'contagem regressiva');
    assert.equal(await avaliar(`document.getElementById('faixa').getAttribute('role')`), 'status');
    await foto('pc-desconectado');
    // a faixa continua clicável com a folha aberta (fora do #app inerte)
    assert.equal(await avaliar(`document.getElementById('faixa').closest('#app')`), null);
    assert.equal((await postMock('/_mock/voltar')).status, 200);
    // recuo de 1–15 s: espera com limite
    await exigir(`document.getElementById('faixa').hidden && OM.estado.conexao === 'vivo'`, 'a faixa devia sumir sozinha depois do /_mock/voltar', 25000);
    await exigir('OM.estado.sessoes.size === 6', 'estado recarregado');
    // "Tentar agora" não espera o recuo
    await postMock('/_mock/cair');
    await exigir(`OM.estado.conexao === 'pc'`, 'cai de novo', 12000);
    await postMock('/_mock/voltar');
    await avaliar(`[...document.querySelectorAll('#faixa button')].find((b) => /Tentar agora/.test(b.textContent)).click()`);
    await exigir(`document.getElementById('faixa').hidden && OM.estado.conexao === 'vivo'`, 'Tentar agora devia religar logo', 6000);
  } finally {
    await postMock('/_mock/voltar');
    tolerando--;
  }
});

// ═════════════════════════════ 4. movimento reduzido ═════════════════════════════
test('prefers-reduced-motion: reduce → transições e folha sem transform', async () => {
  await viewport(390, 844);
  const chaves = (hash) => avaliar(`(async () => {
    const ks = new Set();
    const fim = performance.now() + 500;
    location.hash = ${JSON.stringify(hash)};
    while (performance.now() < fim) {
      for (const a of document.getAnimations()) for (const k of (a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [])) for (const p of Object.keys(k)) ks.add(p);
      await new Promise((r) => setTimeout(r, 16));
    }
    return [...ks].filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p));
  })()`);
  // controle: sem preferência, empurrar uma conversa anima transform
  await irPara('#sessoes');
  await base('sessoes');
  const normal = await chaves('#s=s4');
  assert.ok(normal.includes('transform'), 'controle: sem movimento reduzido a transição usa transform: ' + normal);
  await irPara('#sessoes');
  await base('sessoes');

  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    assert.equal(await avaliar(`matchMedia('(prefers-reduced-motion: reduce)').matches && OM.reduzido()`), true);
    for (const [de, para] of [['#sessoes', '#s=s4'], ['#s=s4', '#sessoes'], ['#sessoes', '#aprovacoes'], ['#aprovacoes', '#mais']]) {
      await irPara(de);
      await dormir(450);
      const ks = await chaves(para);
      assert.ok(!ks.some((k) => /^(transform|translate|scale|rotate)$/.test(k)), `${de} → ${para} sem transform (movimento reduzido): ${ks}`);
      assert.ok(ks.includes('opacity') || ks.length === 0, `${de} → ${para}: só fade ${ks}`);
    }
    await irPara('#sessoes');
    await base('sessoes');
    // gesto da borda em movimento reduzido: sem translate durante o arrasto
    await irPara('#s=s4');
    await base('conversa');
    const idDedo = await avaliar(`__sim.arrastar(null, 4, 420, 150, 424, { passos: 4, espera: 30, soltar: false })`);
    assert.ok(await avaliar(`document.body.classList.contains('borda-ativa')`), 'o gesto da borda está em curso');
    assert.ok(await avaliar(`!/translate/.test(${Q('.tela[data-tela="conversa"]')}.style.transform || '')`), 'borda sem translate quando reduzido');
    await avaliar(`window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: ${idDedo}, pointerType: 'touch' })); true`);
    await dormir(400);
    assert.equal((await rota()).nome, 'conversa', 'cancelar o gesto não volta');
    await avaliar('history.back()');
    await esperar(`OM.rotas.atual().nome !== 'conversa'`, 4000);
    await dormir(300);
    // folha: transição só de opacity
    await irPara('#sessoes');
    await base('sessoes');
    await abrirFolha();
    const tr = await avaliar(`(() => { const f = document.querySelector('.folha'), u = document.querySelector('.folha-fundo'); return [getComputedStyle(f).transitionProperty, getComputedStyle(u).transitionProperty]; })()`);
    assert.ok(!/transform|all/.test(tr[0]), 'folha reduzida sem transição de transform: ' + tr[0]);
    assert.ok(!/transform|all/.test(tr[1]), 'fundo reduzido: ' + tr[1]);
    assert.ok(/opacity/.test(tr[0]), 'a folha só aparece com fade: ' + tr[0]);
    await avaliar('OM.folha.fecharTodas()');
    await folhaSumiu();
    // :active dos botões toque/barra sem escala
    assert.equal(await avaliar(`(() => { const css = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }); return css.some((r) => r.type === 4 && /reduced-motion/.test(r.conditionText || r.media.mediaText) && /transform: none/.test(r.cssText)); })()`), true, 'regras reduzidas com transform:none existem e valem');
    await foto('reduzido');
  } finally {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  }
  assert.equal(await avaliar(`matchMedia('(prefers-reduced-motion: reduce)').matches`), false);
});

// ═════════════════════════════ 5. aparelho revogado ═════════════════════════════
test('aparelho revogado (o mock responde 401) → volta para a tela de parear; dá para parear de novo', async () => {
  await viewport(390, 844);
  await irPara('#inicio');
  await base('inicio');
  tolerando++;
  try {
    // /remoto/sair apaga o token no mock: o SSE cai, a sondagem de /remoto/eu leva 401 e a casca entra no modo parear
    const st = await avaliar(`fetch('/remoto/sair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)`);
    assert.equal(st, 200);
    await exigir(`document.body.dataset.modo === 'parear'`, 'revogado devia ir para o modo parear', 15000);
    await exigir(`OM.rotas.atual().nome === 'parear'`, 'rota parear');
    assert.equal(await avaliar('OM.estado.conexao'), 'revogado');
    assert.equal(await avaliar('OM.estado.motivoParear'), 'revogado');
    assert.equal(await avaliar('OM.estado.sessoes.size'), 0, 'o estado é limpo');
    assert.ok(await avaliar(`document.getElementById('faixa').hidden`), 'sem faixa de conexão na tela de parear');
    assert.equal(await avaliar(`(async () => { try { await OM.api('GET', '/estado'); return 0; } catch (e) { return e.status; } })()`), 401);
    // pareia de novo
    const pedido = await avaliar(`OM.parear.pedir('iPhone da casca').then((p) => p.pedido)`);
    assert.equal(await avaliar(`OM.parear.confirmar(${JSON.stringify(pedido)}, ${JSON.stringify(await codigoReal())})`), true);
    await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.sessoes.size === 6`, 'depois de parear de novo volta ao app', 12000);
    assert.equal((await rota()).nome, 'inicio');
  } finally { tolerando--; }
});

// ═════════════════════════════ 6. higiene geral ═════════════════════════════
test('0 erro de console e 0 violação de CSP; sem rolagem lateral', async () => {
  assert.ok(await semRolagemLateral());
  await viewport(320, 640);
  for (const hash of ['#inicio', '#sessoes', '#aprovacoes', '#mais', '#s=s4']) {
    await irPara(hash);
    await dormir(400);
    assert.ok(await semRolagemLateral(), `rolagem lateral em ${hash} a 320 px`);
  }
  await viewport(390, 844);
  assert.deepEqual(violacoes, [], 'violações de CSP');
  assert.deepEqual(consoleErros, [], 'erros de console');
  // o que foi tolerado só pode ser de rede (401 sem cookie, PC caído, sem internet)
  assert.ok(esperados.every((e) => /401|503|ERR_|Failed to load/i.test(e)), 'erros esperados inesperados: ' + esperados.join(' ; '));
});
