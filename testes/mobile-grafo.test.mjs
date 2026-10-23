// Teste da tela GRAFO do app do celular (#mais/grafo, onda 5): mobile/grafo.js e grafo.css contra o servidor falso
// testes/mobile-mock.mjs, num Edge headless mudo (390×844 e 320×568).
//   node --test testes/mobile-grafo.test.mjs
// Confere: entrar pelo Mais; o canvas desenha (nós > 0, pixels não vazios, nós dentro do palco) em 390 e 320; a física dorme;
// busca; toque num nó (destaca vizinhos e abre a nota na folha, sem frontmatter; navegar pela lista de ligações; anexo);
// arrastar e pinça por Input.dispatchTouchEvent; "Encaixar"; a faixa da borda esquerda é do "voltar" (não mexe no grafo) e
// o gesto da borda volta; movimento reduzido (layout de uma vez, parado); projeto sem brain (404 sem_brain), brain vazio,
// aviso de truncado, erro 500 (Fetch.fulfillRequest) com "Tentar de novo" e 500 na atualização com grafo na tela;
// 0 erro de console e 0 violação de CSP; sem rolagem lateral.
// Não testado aqui: áreas seguras reais do iPhone (o Edge headless não tem), Safari/iOS e o grafo de um brain grande de verdade.
// Portas: o mock usa só 47822–47826 (escolherPorta); o CDP, uma livre na faixa 9800–9949. Capturas só com ORBIT_GRAFO_FOTOS=<pasta>.

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
const FOTOS = process.env.ORBIT_GRAFO_FOTOS ? path.resolve(process.env.ORBIT_GRAFO_FOTOS) : '';

let mock = null, edge = null, ws = null, seq = 0, portaCdp = 0, perfil = '', manter = null;
const pend = new Map();
const consoleErros = [];
const violacoes = [];
const esperados = [];   // erros de rede provocados de propósito (404 sem_brain, 500 forçado)
let tolerando = 0;      // > 0: erros de rede são esperados
let forcar500 = false;  // Fetch.requestPaused em */remoto/grafo*: responde 500 enquanto true
let segurarNota = false; // true: pedidos de /remoto/grafo/nota ficam parados em Fetch.requestPaused (guardados em seguradas) até soltar
const seguradas = [];
let respostaFalsa = null; // (url: URL) => objeto JSON | null: responde no lugar do mock (200)

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
    if (d.method === 'Fetch.requestPaused') {
      const id = d.params.requestId;
      const url = new URL(d.params.request.url);
      const falsa = respostaFalsa ? respostaFalsa(url) : null;
      if (falsa) {
        cdp('Fetch.fulfillRequest', { requestId: id, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
          body: Buffer.from(JSON.stringify(falsa)).toString('base64') }).catch(() => {});
        return;
      }
      if (segurarNota && url.pathname === '/remoto/grafo/nota') { seguradas.push(id); return; }
      const f = forcar500
        ? cdp('Fetch.fulfillRequest', { requestId: id, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
          body: Buffer.from(JSON.stringify({ erro: 'falha forçada pelo teste' })).toString('base64') })
        : cdp('Fetch.continueRequest', { requestId: id });
      f.catch(() => {});
      return;
    }
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
  try { est = await avaliar(`JSON.stringify({ hash: location.hash, modo: document.body.dataset.modo, conexao: OM.estado.conexao, rota: OM.rotas.atual().nome, grafo: OM.grafo.estado(), folhas: OM.folha.abertas() })`); } catch {}
  assert.fail(msg + ' | ' + expr.slice(0, 140) + ' | estado: ' + est);
}
const foto = async (nome) => {
  if (!FOTOS) return;
  fs.mkdirSync(FOTOS, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(FOTOS, nome + '.png'), Buffer.from(r.result.data, 'base64'));
};
const Q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const TELA = '.tela[data-tela="grafo"]';
const rota = () => avaliar('OM.rotas.atual()');
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
const base = (nome) => exigir(`OM.rotas.atual().nome === ${JSON.stringify(nome)} && !document.querySelector('.tela.arrastando') && [...document.querySelectorAll('.tela')].filter((t) => !t.hidden).length === 1`, 'a tela do topo devia ser ' + nome, 6000);

// ───────────────────────────── toque de verdade (Input.dispatchTouchEvent) ─────────────────────────────
const toque = (tipo, pontos = []) => cdp('Input.dispatchTouchEvent', { type: tipo, touchPoints: pontos.map(([x, y, id]) => ({ x, y, id: id ?? 1 })) });
async function tocar(x, y) { await toque('touchStart', [[x, y]]); await dormir(40); await toque('touchEnd'); await dormir(80); }
async function arrastar(x0, y0, x1, y1, { passos = 8, espera = 16 } = {}) {
  await toque('touchStart', [[x0, y0]]);
  for (let i = 1; i <= passos; i++) { await dormir(espera); await toque('touchMove', [[x0 + (x1 - x0) * i / passos, y0 + (y1 - y0) * i / passos]]); }
  await dormir(espera);
  await toque('touchEnd');
  await dormir(80);
}
async function pinca(cx, cy, d0, d1, passos = 8) {
  await toque('touchStart', [[cx - d0 / 2, cy, 1], [cx + d0 / 2, cy, 2]]);
  for (let i = 1; i <= passos; i++) {
    const d = d0 + (d1 - d0) * i / passos;
    await dormir(16);
    await toque('touchMove', [[cx - d / 2, cy, 1], [cx + d / 2, cy, 2]]);
  }
  await dormir(16);
  await toque('touchEnd');
  await dormir(80);
}

// ───────────────────────────── leitura da tela ─────────────────────────────
const G = () => avaliar('OM.grafo.estado()');
const pos = (id) => avaliar(`OM.grafo.posicao(${JSON.stringify(id)})`);
const palco = () => avaliar(`(() => { const r = ${Q(TELA + ' .gf-palco')}.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const pixels = () => avaliar(`(() => { const c = ${Q(TELA + ' .gf-canvas')}; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()`);
const dormindo = (ms) => exigir(`(() => { const g = OM.grafo.estado(); return g && g.carga === 'ok' && g.medido && g.dormindo && g.alphaFisica < 0.001; })()`, 'a física devia dormir', ms || 12000);
const pronto = async () => {
  await exigir(`(() => { const g = OM.grafo.estado(); return g && g.carga === 'ok' && g.nos === 12 && g.links === 13; })()`, 'o grafo do mock devia carregar (12 nós, 13 ligações)', 10000);
  await dormindo();
};
const textoTela = () => avaliar(`${Q(TELA)}.textContent`);
const projetoSelecionar = (pasta) => avaliar(`(() => { const s = ${Q(TELA + ' .gf-sel')}; s.value = ${JSON.stringify(pasta)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const ORBIT = 'D:\\Projetos\\Orbit', LOJA = 'D:\\Projetos\\Loja';

// Todos os nós dentro do palco (e longe da faixa da borda esquerda, que é do "voltar").
async function conferirNosVisiveis(w) {
  const p = await palco();
  const g = await G();
  assert.ok(p.w >= w - 1 && p.h >= 240, `palco ${JSON.stringify(p)} em ${w}px`);
  for (const id of await avaliar('OM.grafo.ids()')) {
    const q = await pos(id);
    assert.ok(q && q.x - q.r >= p.x && q.x + q.r <= p.x + p.w && q.y - q.r >= p.y && q.y + q.r <= p.y + p.h, `nó ${id} fora do palco em ${w}px: ${JSON.stringify(q)} ${JSON.stringify(p)} escala ${g.escala}`);
    assert.ok(q.x > 24, `nó ${id} dentro da faixa da borda esquerda (${q.x})`);
  }
}

// ───────────────────────────── ganchos injetados em toda página ─────────────────────────────
const INJETADO = `window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));`;

async function abrirPagina(hash = '') {
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  await cdp('Page.navigate', { url: mock.base + '/m' + hash });
  await esperar('document.readyState === "complete"');
  await esperar('!!(window.OM && OM.rotas && OM.folha && OM.gestos && OM.estado && OM.grafo)');
  await dormir(200);
}

// ───────────────────────────── subida e descida ─────────────────────────────
before(async () => {
  mock = await subirMock({ porta: Number(process.env.GERENCIADOR_PORTA) || 47822 });
  const ini = 9800 + Math.floor(Math.random() * 100);
  for (let p = ini; p < ini + 50 && !portaCdp; p++) if (await portaLivre(p)) portaCdp = p;
  assert.ok(portaCdp, 'nenhuma porta livre para o CDP');
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grafo-'));
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${portaCdp}`, `--user-data-dir=${perfil}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar();
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await cdp(d + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJETADO });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  await viewport(390, 844);
  // headless deixa a página "hidden": animações/rAF ficam pausados. Forçar visível e em foco, e repetir (o Edge a esconde de novo).
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

// ═════════════════════════════ 1. parear e entrar pelo Mais ═════════════════════════════
test('parear e entrar no Grafo pela linha "Grafo do brain" da aba Mais', async () => {
  await abrirPagina();
  await exigir(`document.body.dataset.modo === 'parear'`, 'sem cookie devia estar no modo parear');
  const pedido = await avaliar(`OM.parear.pedir('iPhone do grafo').then((p) => p.pedido)`);
  assert.equal(await avaliar(`OM.parear.confirmar(${JSON.stringify(pedido)}, ${JSON.stringify(await codigoReal())})`), true);
  await exigir(`document.body.dataset.modo === 'app' && OM.rotas.atual().nome === 'inicio'`, 'devia entrar no app');
  assert.equal(await avaliar('OM.grafo.estado()'), null, 'sem a tela aberta, o gancho devolve null');
  await irPara('#mais');
  await base('mais');
  await exigir(`!!${Q('.mais-linha[data-destino="#mais/grafo"]')}`, 'a aba Mais devia ter a linha "Grafo do brain"');
  assert.match(await avaliar(`${Q('.mais-linha[data-destino="#mais/grafo"]')}.textContent`), /Grafo do brain/);
  await avaliar(`${Q('.mais-linha[data-destino="#mais/grafo"]')}.click()`);
  await base('grafo');
  const r = await rota();
  assert.deepEqual(r.cadeia, ['mais', 'grafo']);
  assert.equal(r.hash, '#mais/grafo');
  await pronto();
  const g = await G();
  assert.equal(g.projeto, ORBIT);
  assert.equal(g.projetos, 2);
  assert.equal(g.truncado, false);
  assert.equal(await avaliar(`${Q(TELA + ' .gf-sel')}.options.length`), 2);
  assert.equal(await avaliar(`localStorage.getItem('orbit.m.grafoProjeto')`), null, 'só grava depois que a pessoa escolhe');
  assert.ok(await avaliar(`${Q(TELA + ' .gf-estado')}.hidden`), 'sem painel de estado quando carregado');
  assert.match(await avaliar(`${Q(TELA + ' .gf-resumo')}.textContent`), /12 notas · 13 ligações/);
  await foto('1-grafo-390');
});

// ═════════════════════════════ 2. desenho em 390×844 e 320×568 ═════════════════════════════
test('o canvas desenha o grafo em 390×844 e em 320×568, dentro do palco, sem rolagem lateral', async () => {
  for (const [w, h] of [[390, 844], [320, 568], [390, 844]]) {
    await viewport(w, h);
    await exigir(`(() => { const g = OM.grafo.estado(); return g.medido && g.dormindo && Math.abs(g.L - ${w}) <= 1; })()`, `o grafo devia remedir para ${w}px`, 8000);
    const g = await G();
    assert.equal(g.nos, 12);
    assert.equal(g.links, 13);
    assert.equal(g.dpr, 2);
    assert.ok(g.seguir, 'sem gesto, a câmera segue o encaixe');
    assert.ok(g.quadros > 0, 'desenhou ao menos um quadro');
    assert.ok(await pixels() > 2000, `pixels desenhados em ${w}px: ${await pixels()}`);
    assert.ok(await semRolagemLateral(), `rolagem lateral em ${w}px`);
    await conferirNosVisiveis(w);
    // alvos de toque >= 44 px e campos com 16 px (iOS não dá zoom)
    assert.ok(await avaliar(`[...document.querySelectorAll(${JSON.stringify(TELA + ' .gf-bt, ' + TELA + ' .gf-sel, ' + TELA + ' .gf-busca')})].every((e) => e.getBoundingClientRect().height >= 43.5)`), 'alvos >= 44 px');
    assert.ok(await avaliar(`[...document.querySelectorAll(${JSON.stringify(TELA + ' .gf-sel, ' + TELA + ' .gf-busca')})].every((e) => parseFloat(getComputedStyle(e).fontSize) >= 16)`), 'campos com 16 px');
    assert.ok(await avaliar(`(() => { const t = ${Q(TELA)}.getBoundingClientRect(), p = ${Q(TELA + ' .gf-palco')}.getBoundingClientRect(); return p.left >= -0.5 && p.right <= t.right + 0.5 && p.bottom <= innerHeight + 0.5; })()`), 'palco dentro da tela');
    if (w === 320) await foto('2-grafo-320');
  }
  // as cores do desenho vêm dos tokens: a cor de um nó do canvas bate com o token mais próximo (sem cor fixa no JS/CSS)
  const duro = await avaliar(`fetch('/m/grafo.css').then((r) => r.text()).then((t) => /#[0-9a-fA-F]{3,8}\\b|rgba?\\(/.test(t))`);
  assert.equal(duro, false, 'grafo.css não pode ter cor própria (só var(--token))');
  const duroJs = await avaliar(`fetch('/m/grafo.js').then((r) => r.text()).then((t) => /['"\`]#[0-9a-fA-F]{3,8}['"\`]/.test(t.replace(/sonda\\.fillStyle = '#(000|fff)'/g, '')))`);
  assert.equal(duroJs, false, 'grafo.js não pode ter hex próprio');
});

// ═════════════════════════════ 3. busca ═════════════════════════════
test('busca por nome destaca os achados e centra o primeiro com Enter', async () => {
  await dormindo();
  const campo = TELA + ' .gf-busca';
  await avaliar(`(() => { const c = ${Q(campo)}; c.value = 'celular'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await exigir(`OM.grafo.estado().casam === 4`, '"celular" devia casar 4 notas (Celular, Mock do celular, 2 decisões)', 3000);
  assert.match(await avaliar(`${Q(TELA + ' .gf-contagem')}.textContent`), /4 notas/);
  await avaliar(`(() => { const c = ${Q(campo)}; c.value = 'zzzz'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await exigir(`OM.grafo.estado().casam === 0 && ${Q(TELA + ' .gf-contagem')}.textContent === 'Nada'`, 'busca sem achado devia dizer "Nada"', 3000);
  await avaliar(`(() => { const c = ${Q(campo)}; c.value = 'índice'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await exigir(`OM.grafo.estado().casam === 1`, '"índice" (com acento) devia casar 1 nota', 3000);
  await avaliar(`${Q(campo)}.focus()`);
  await tecla('Enter', 13);
  await exigir(`OM.grafo.estado().selecionado === '00 Índice.md' && OM.grafo.estado().folha`, 'Enter devia selecionar e abrir a nota achada', 4000);
  await avaliar(`OM.folha.fecharTodas()`);
  await exigir(`OM.folha.abertas() === 0 && !OM.grafo.estado().folha`, 'a folha devia fechar');
  await avaliar(`(() => { const c = ${Q(campo)}; c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await exigir(`OM.grafo.estado().casam === null`, 'busca vazia limpa o filtro', 3000);
  // limpar a seleção para os próximos casos
  await tocar(...(await vazio()));
  await exigir(`OM.grafo.estado().selecionado === null`, 'toque no vazio devia limpar a seleção', 3000);
  await dormindo();
});

// Esc fecha a folha; espera a saída acabar (o fundo dela intercepta toques até lá)
async function fecharComEsc(msg) {
  await tecla('Escape', 27);
  await exigir(`OM.folha.abertas() === 0 && !OM.grafo.estado().folha && !document.querySelector('.folha-fundo, .folha')`, msg || 'Esc devia fechar a folha', 4000);
}

// ponto do palco longe de qualquer nó (e fora da faixa da borda)
async function vazio() {
  const p = await palco();
  const nos = [];
  for (const id of await avaliar('OM.grafo.ids()')) nos.push(await pos(id));
  let melhor = null, dm = -1;
  for (let x = p.x + 40; x < p.x + p.w - 20; x += 24) for (let y = p.y + 20; y < p.y + p.h - 20; y += 24) {
    const d = Math.min(...nos.map((n) => Math.hypot(n.x - x, n.y - y) - n.r));
    if (d > dm) { dm = d; melhor = [x, y]; }
  }
  assert.ok(dm > 30, 'devia haver um ponto vazio no palco (' + dm + ')');
  return melhor;
}

// ═════════════════════════════ 4. toque num nó: vizinhos e nota na folha ═════════════════════════════
test('tocar num nó destaca os vizinhos e abre a nota (sem frontmatter) na folha; a lista de ligações navega; anexo; vazio desmarca', async () => {
  mock.estado.notas['01 Contexto/Orbit.md'] = '---\ntitulo: SEGREDO-DO-FRONTMATTER\ntags: [projeto]\n---\n# Orbit\n\nTexto do corpo da nota **Orbit**.\n';
  const q = await pos('00 Índice.md');
  await tocar(q.x, q.y);
  await exigir(`OM.grafo.estado().selecionado === '00 Índice.md' && OM.grafo.estado().folha`, 'o toque devia selecionar o Índice e abrir a folha', 4000);
  let g = await G();
  assert.deepEqual([...g.vizinhos].sort(), ['01 Contexto/Celular.md', '01 Contexto/Orbit.md', '02 Decisões/2026-10-21 Orbit no celular premium.md', '04 Ideias/Modo escuro.md']);
  assert.equal(g.notaAberta, '00 Índice.md');
  assert.equal(await avaliar('OM.folha.abertas()'), 1);
  await exigir(`/Nota de exemplo do mock/.test(document.querySelector('.folha').textContent)`, 'a folha devia mostrar o texto da nota', 5000);
  assert.equal(await avaliar(`document.querySelector('.folha-tit').textContent`), '00 Índice');
  assert.equal(await avaliar(`document.querySelectorAll('.folha .gf-lig').length`), 1, 'o Índice só aponta para outras (não é citado): 1 grupo');
  assert.equal(await avaliar(`document.querySelector('.folha .gf-lig-tit').textContent`), 'Aponta para');
  assert.equal(await avaliar(`document.querySelectorAll('.folha .gf-lig-item').length`), 4);
  await foto('3-nota');
  // navegar pela lista: Orbit (tem frontmatter no mock)
  await avaliar(`[...document.querySelectorAll('.folha .gf-lig-item')].find((b) => /^Orbit/.test(b.textContent)).click()`);
  await exigir(`OM.grafo.estado().notaAberta === '01 Contexto/Orbit.md' && /Texto do corpo da nota/.test(document.querySelector('.folha').textContent)`, 'navegar pela lista devia trocar a nota na mesma folha', 5000);
  const t = await avaliar(`document.querySelector('.folha').textContent`);
  assert.ok(!/SEGREDO-DO-FRONTMATTER|tags: \[projeto\]/.test(t), 'o frontmatter não pode aparecer na folha: ' + t.slice(0, 200));
  assert.equal(await avaliar('OM.folha.abertas()'), 1, 'continua uma folha só');
  assert.equal(await avaliar(`document.querySelector('.folha-tit').textContent`), 'Orbit');
  assert.equal((await G()).selecionado, '01 Contexto/Orbit.md');
  // o Orbit é citado pelo Índice e aponta para um anexo (item sem texto, não clicável)
  assert.match(await avaliar(`document.querySelector('.folha').textContent`), /Citada por/);
  assert.equal(await avaliar(`[...document.querySelectorAll('.folha .gf-lig-item')].filter((e) => e.tagName === 'DIV').length`), 1, 'o anexo não é botão');
  // fechar pelo Esc
  await fecharComEsc('Esc devia fechar a folha');
  // a navegação pela lista centrou a câmera no nó: Encaixar para ver tudo de novo
  await avaliar(`${Q(TELA + ' .gf-bt[aria-label="Encaixar"]')}.click()`);
  await exigir(`OM.grafo.estado().seguir`, 'Encaixar');
  // anexo: folha sem texto
  await dormindo();
  const a = await pos('anexos/mapa.png');
  await tocar(a.x, a.y);
  await exigir(`OM.grafo.estado().selecionado === 'anexos/mapa.png' && /Anexo do brain/.test((document.querySelector('.folha') || {}).textContent || '')`, 'anexo devia abrir a folha com o aviso', 4000);
  await fecharComEsc('folha do anexo fecha');
  // nota que não existe
  const f = await pos('Nota que falta');
  await tocar(f.x, f.y);
  await exigir(`/ainda não existe/.test((document.querySelector('.folha') || {}).textContent || '')`, 'nota inexistente devia avisar', 4000);
  await fecharComEsc('folha da nota inexistente fecha');
  // nota que o servidor recusa (404): mensagem, sem travar
  delete mock.estado.notas['04 Ideias/Atalhos.md'];
  const q2 = await pos('04 Ideias/Atalhos.md');
  tolerando++;
  try {
    await tocar(q2.x, q2.y);
    await exigir(`/não está mais no brain/.test((document.querySelector('.folha') || {}).textContent || '')`, 'nota apagada devia dizer que não está mais no brain', 5000);
  } finally { tolerando--; }
  await fecharComEsc('folha fecha');
  // toque no vazio desmarca
  await tocar(...(await vazio()));
  await exigir(`OM.grafo.estado().selecionado === null`, 'toque no vazio devia limpar a seleção', 3000);
  await dormindo();
});

// ═════════════════════════════ 5. arrastar, pinça e Encaixar ═════════════════════════════
test('arrastar move o grafo, a pinça dá zoom e "Encaixar" volta ao enquadramento', async () => {
  await dormindo();
  const p = await palco();
  const antes = await pos('00 Índice.md');
  const g0 = await G();
  const x0 = p.x + 60, y0 = p.y + p.h - 70;
  await arrastar(x0, y0, x0 + 70, y0 - 50);
  const depois = await pos('00 Índice.md');
  assert.ok(Math.abs((depois.x - antes.x) - 70) < 12 && Math.abs((depois.y - antes.y) + 50) < 12, `o arrasto devia mover o nó ~(70,-50): ${JSON.stringify(antes)} → ${JSON.stringify(depois)}`);
  const g1 = await G();
  assert.equal(g1.seguir, false, 'depois de um gesto, a câmera deixa de seguir o encaixe');
  assert.equal(g1.selecionado, null, 'arrastar não seleciona');
  assert.equal(g1.folha, false, 'arrastar não abre folha');
  assert.ok(Math.abs(g1.escala - g0.escala) < 1e-6, 'arrastar não muda o zoom');
  // pinça aberta: zoom in em torno do centro
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  await pinca(cx, cy, 50, 160);
  const g2 = await G();
  assert.ok(g2.escala > g1.escala * 2, `a pinça aberta devia aumentar o zoom: ${g1.escala} → ${g2.escala}`);
  assert.ok(g2.escala <= 8.0001);
  await foto('4-zoom');
  // pinça fechada: zoom out
  await pinca(cx, cy, 200, 50);
  const g3 = await G();
  assert.ok(g3.escala < g2.escala / 2, `a pinça fechada devia diminuir o zoom: ${g2.escala} → ${g3.escala}`);
  assert.ok(g3.escala >= 1 / 64 - 1e-9);
  // Encaixar
  await avaliar(`${Q(TELA + ' .gf-bt[aria-label="Encaixar"]')}.click()`);
  await exigir(`(() => { const g = OM.grafo.estado(); return g.seguir && g.dormindo && Math.abs(g.escala - ${g0.escala}) < 0.02; })()`, '"Encaixar" devia voltar ao enquadramento inicial', 6000);
  await conferirNosVisiveis(390);
  const fim = await pos('00 Índice.md');
  assert.ok(Math.abs(fim.x - antes.x) < 6 && Math.abs(fim.y - antes.y) < 6, `Encaixar devia devolver o nó ao lugar: ${JSON.stringify(antes)} → ${JSON.stringify(fim)}`);
  assert.ok(await pixels() > 2000);
});

// ═════════════════════════════ 6. a borda esquerda é do "voltar" ═════════════════════════════
test('a faixa de 24 px da borda não inicia gesto no canvas; o gesto da borda volta para o Mais', async () => {
  await dormindo();
  const p = await palco();
  const antes = await pos('00 Índice.md');
  // curto e lento a partir de x=6: o "voltar" cancela e o grafo não se mexe
  await arrastar(6, p.y + p.h / 2, 40, p.y + p.h / 2 + 4, { passos: 5, espera: 50 });
  await dormir(500);
  assert.equal((await rota()).nome, 'grafo', 'gesto curto devia cancelar o voltar');
  const depois = await pos('00 Índice.md');
  assert.ok(Math.abs(depois.x - antes.x) < 1 && Math.abs(depois.y - antes.y) < 1, `começar na borda não pode arrastar o grafo: ${JSON.stringify(antes)} → ${JSON.stringify(depois)}`);
  assert.equal((await G()).seguir, true);
  assert.equal(await avaliar(`${Q(TELA)}.style.transform`), '', 'sem transform sobrando');
  // gesto longo: volta
  await arrastar(4, p.y + p.h / 2, 280, p.y + p.h / 2 + 10, { passos: 10, espera: 16 });
  await base('mais');
  assert.equal(await avaliar('location.hash'), '#mais');
  await exigir(`OM.grafo.estado() === null`, 'ao voltar a tela do grafo é desmontada (a física para)', 3000);
  // voltar de novo ao grafo: remonta do zero e desenha
  await avaliar(`${Q('.mais-linha[data-destino="#mais/grafo"]')}.click()`);
  await base('grafo');
  await pronto();
  assert.ok(await pixels() > 2000);
  // botão voltar do cabeçalho
  await avaliar(`${Q(TELA + ' .cab-voltar')}.click()`);
  await base('mais');
});

// ═════════════════════════════ 7. movimento reduzido ═════════════════════════════
test('movimento reduzido: o layout sai de uma vez, o grafo fica parado e desenhado', async () => {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    assert.equal(await avaliar(`matchMedia('(prefers-reduced-motion: reduce)').matches && OM.reduzido()`), true);
    await avaliar(`${Q('.mais-linha[data-destino="#mais/grafo"]')}.click()`);
    await base('grafo');
    await pronto();
    const g = await G();
    assert.equal(g.reduzido, true);
    assert.ok(g.alphaFisica < 0.001, 'a física já terminou');
    assert.ok(g.quadros <= 5, `sem animação: poucos quadros até dormir (${g.quadros})`);
    assert.ok(await pixels() > 2000, 'desenhado e parado');
    await conferirNosVisiveis(390);
    // zoom sem suavização: a pinça dá a escala direto e Encaixar também
    await avaliar(`${Q(TELA + ' .gf-bt[aria-label="Encaixar"]')}.click()`);
    await dormir(150);
    assert.equal((await G()).seguir, true);
    await foto('5-reduzido');
    await avaliar(`${Q(TELA + ' .cab-voltar')}.click()`);
    await base('mais');
  } finally { await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); }
  assert.equal(await avaliar(`OM.reduzido()`), false);
});

// ═════════════════════════════ 8. projeto sem brain, lembrar a escolha, vazio, truncado ═════════════════════════════
test('projeto sem brain (404 sem_brain) mostra o aviso; a escolha é lembrada; voltar ao Orbit recarrega', async () => {
  tolerando++;
  try {
    await avaliar(`${Q('.mais-linha[data-destino="#mais/grafo"]')}.click()`);
    await base('grafo');
    await pronto();
    assert.equal(await projetoSelecionar(LOJA), LOJA);
    await exigir(`OM.grafo.estado().carga === 'sem-brain'`, 'a Loja não tem brain no mock', 6000);
    const g = await G();
    assert.equal(g.nos, 0);
    assert.equal(g.projeto, LOJA);
    assert.equal(await avaliar(`localStorage.getItem('orbit.m.grafoProjeto')`), LOJA, 'lembra o projeto');
    assert.equal(await avaliar(`${Q(TELA + ' .gf-estado')}.hidden`), false);
    assert.equal(await avaliar(`${Q(TELA + ' .gf-estado-tit')}.textContent`), 'Sem brain');
    assert.match(await textoTela(), /Vincule no PC/);
    assert.equal(await pixels(), 0, 'o canvas fica limpo');
    assert.equal(await avaliar(`${Q(TELA + ' .gf-busca')}.disabled`), true);
    assert.ok(await semRolagemLateral());
    await foto('6-sem-brain');
    // sair e entrar: abre direto no projeto lembrado
    await avaliar(`${Q(TELA + ' .cab-voltar')}.click()`);
    await base('mais');
    await avaliar(`${Q('.mais-linha[data-destino="#mais/grafo"]')}.click()`);
    await base('grafo');
    await exigir(`OM.grafo.estado().carga === 'sem-brain' && OM.grafo.estado().projeto === ${JSON.stringify(LOJA)}`, 'devia reabrir no projeto lembrado', 6000);
    // volta ao Orbit
    await projetoSelecionar(ORBIT);
    await pronto();
    assert.equal(await avaliar(`localStorage.getItem('orbit.m.grafoProjeto')`), ORBIT);
    assert.ok(await pixels() > 2000);
  } finally { tolerando--; }
});

test('brain vazio, aviso de truncado e "Atualizar" recarregam o grafo', async () => {
  const original = mock.estado.grafo;
  try {
    // atualizar com o grafo na tela: continua mostrando e conta a nova ligação
    mock.estado.grafo = { ...original, links: [...original.links, { origem: '04 Ideias/Atalhos.md', destino: '00 Índice.md' }], truncado: true };
    await avaliar(`${Q(TELA + ' .gf-bt[aria-label="Atualizar"]')}.click()`);
    await exigir(`OM.grafo.estado().links === 14 && OM.grafo.estado().truncado === true`, '"Atualizar" devia trazer a ligação nova', 6000);
    await dormindo();
    assert.equal(await avaliar(`${Q(TELA + ' .gf-nota-aviso')}.hidden`), false, 'aviso de truncado visível');
    assert.match(await avaliar(`${Q(TELA + ' .gf-nota-aviso')}.textContent`), /só parte das notas/);
    assert.ok(await pixels() > 2000);
    // brain vazio
    mock.estado.grafo = { pasta: 'Brain de exemplo', nos: [], links: [], truncado: false };
    await avaliar(`${Q(TELA + ' .gf-bt[aria-label="Atualizar"]')}.click()`);
    await exigir(`OM.grafo.estado().carga === 'vazio'`, 'brain sem notas devia mostrar o estado vazio', 6000);
    assert.equal(await avaliar(`${Q(TELA + ' .gf-estado-tit')}.textContent`), 'Brain vazio');
    assert.equal(await pixels(), 0);
  } finally {
    mock.estado.grafo = original;
  }
  await avaliar(`${Q(TELA + ' .gf-bt[aria-label="Atualizar"]')}.click()`).catch(() => {});
  // com o botão desabilitado no estado vazio, recarrega pela troca de projeto
  await exigir(`!!OM.grafo.estado()`, 'tela aberta');
  await projetoSelecionar(LOJA);
  tolerando++;
  try { await exigir(`OM.grafo.estado().carga === 'sem-brain'`, 'Loja sem brain', 6000); } finally { tolerando--; }
  await projetoSelecionar(ORBIT);
  await pronto();
  assert.equal(await avaliar(`${Q(TELA + ' .gf-nota-aviso')}.hidden`), true, 'sem truncado, sem aviso');
});

// ═════════════════════════════ 9. erro 500 ═════════════════════════════
test('erro 500 no servidor: mostra o erro com "Tentar de novo"; atualizar com grafo na tela só avisa', async () => {
  tolerando++;
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*remoto/grafo*', requestStage: 'Request' }] });
  try {
    // 500 na atualização com o grafo na tela: toast, o grafo fica
    forcar500 = true;
    await avaliar(`${Q(TELA + ' .gf-bt[aria-label="Atualizar"]')}.click()`);
    await exigir(`/Não deu para atualizar/.test((document.getElementById('toast') || document.body).textContent)`, 'atualizar com 500 devia avisar por toast', 5000);
    let g = await G();
    assert.equal(g.carga, 'ok');
    assert.equal(g.nos, 12, 'o grafo anterior continua na tela');
    // 500 sem grafo na tela (troca de projeto zera): estado de erro
    await projetoSelecionar(LOJA);
    await exigir(`OM.grafo.estado().carga === 'erro'`, 'sem grafo e com 500 devia mostrar o erro', 6000);
    assert.equal(await avaliar(`${Q(TELA + ' .gf-estado-tit')}.textContent`), 'Não deu para carregar');
    assert.match(await textoTela(), /falha forçada pelo teste/);
    assert.equal(await pixels(), 0);
    assert.ok(await semRolagemLateral());
    await foto('7-erro');
    // "Tentar de novo" com o servidor de volta (e o projeto Loja continua sem brain)
    forcar500 = false;
    await avaliar(`${Q(TELA + ' .gf-estado .btn')}.click()`);
    await exigir(`OM.grafo.estado().carga === 'sem-brain'`, '"Tentar de novo" devia recarregar', 6000);
    await projetoSelecionar(ORBIT);
    await pronto();
    // nota com 500: mensagem e "Tentar de novo" na própria folha
    forcar500 = true;
    mock.estado.notas['04 Ideias/Atalhos.md'] = '# Atalhos\n\nVoltou.\n';
    const q = await pos('04 Ideias/Atalhos.md');
    await tocar(q.x, q.y);
    await exigir(`!!document.querySelector('.folha .gf-tentar')`, 'nota com 500 devia oferecer "Tentar de novo"', 6000);
    forcar500 = false;
    await avaliar(`document.querySelector('.folha .gf-tentar').click()`);
    await exigir(`/Voltou/.test(document.querySelector('.folha').textContent)`, 'a nota devia abrir depois de tentar de novo', 6000);
    await fecharComEsc('folha fecha');
  } finally {
    forcar500 = false;
    await cdp('Fetch.disable');
    tolerando--;
  }
});

test('troca de projeto com a nota ainda chegando: a resposta atrasada não vai para o cache do outro projeto nem monta a folha', async () => {
  const ATRASADA = 'TEXTO-ATRASADO-DO-ORBIT', DA_LOJA = 'TEXTO-DA-LOJA';
  const ATALHOS = '05 Registro/2026-10-21.md'; // nota que nenhum caso anterior abriu (senão viria do cache)
  mock.estado.notas[ATALHOS] = '# Atalhos\n\n' + ATRASADA + '\n';
  // a Loja ganha um grafo de 2 nós (a nota fica no índice 0 e no Orbit era o 9: ligacoes(9) leria nos[9] undefined)
  const grafoLoja = { pasta: 'Loja', truncado: false,
    nos: [{ id: ATALHOS, nome: 'Atalhos', tipo: 'nota', tags: [] }, { id: 'Outra.md', nome: 'Outra', tipo: 'nota', tags: [] }],
    links: [{ origem: ATALHOS, destino: 'Outra.md' }] };
  respostaFalsa = (u) => {
    if (u.searchParams.get('projeto') !== LOJA) return null;
    if (u.pathname === '/remoto/grafo') return grafoLoja;
    if (u.pathname === '/remoto/grafo/nota' && u.searchParams.get('id') === ATALHOS) return { id: ATALHOS, texto: '# Atalhos\n\n' + DA_LOJA + '\n' };
    return null;
  };
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*remoto/grafo*', requestStage: 'Request' }] });
  try {
    const errosAntes = consoleErros.length;
    // 1) abre a nota do Orbit e segura a resposta
    segurarNota = true;
    const q = await pos(ATALHOS);
    await tocar(q.x, q.y);
    await exigir(`OM.grafo.estado().notaAberta === ${JSON.stringify(ATALHOS)}`, 'a folha devia abrir no Atalhos do Orbit', 4000);
    for (let i = 0; i < 50 && !seguradas.length; i++) await dormir(100);
    assert.equal(seguradas.length, 1, 'o pedido da nota devia estar parado');
    // 2) troca para a Loja: o grafo dela chega primeiro (fecha a folha, limpa o cache)
    await projetoSelecionar(LOJA);
    await exigir(`(() => { const g = OM.grafo.estado(); return g.carga === 'ok' && g.nos === 2 && g.projeto === ${JSON.stringify(LOJA)}; })()`, 'o grafo da Loja devia carregar', 6000);
    await dormindo();
    assert.equal(await avaliar('OM.folha.abertas()'), 0, 'a folha do Orbit fechou na troca');
    // 3) a nota do Orbit chega só agora
    segurarNota = false;
    await cdp('Fetch.continueRequest', { requestId: seguradas.shift() });
    await dormir(700);
    assert.equal(await avaliar('OM.folha.abertas()'), 0, 'a resposta atrasada não pode abrir nem montar a folha');
    assert.equal(consoleErros.length, errosAntes, 'a resposta atrasada não pode gerar exceção (ligacoes(9) em 2 nós): ' + consoleErros.slice(errosAntes).join(' | '));
    // 4) na Loja, o mesmo id mostra o texto da Loja (o cache não pode ter recebido o texto do Orbit)
    const l = await pos(ATALHOS);
    await tocar(l.x, l.y);
    await exigir(`OM.grafo.estado().notaAberta === ${JSON.stringify(ATALHOS)} && /${DA_LOJA}/.test((document.querySelector('.folha') || {}).textContent || '')`, 'a Loja devia mostrar o texto dela', 6000);
    const t = await avaliar(`document.querySelector('.folha').textContent`);
    assert.ok(!t.includes(ATRASADA), 'o texto do Orbit não pode aparecer na Loja: ' + t.slice(0, 200));
    await fecharComEsc('folha fecha');
    // volta ao Orbit
    respostaFalsa = null;
    await projetoSelecionar(ORBIT);
    await pronto();
  } finally {
    segurarNota = false;
    respostaFalsa = null;
    while (seguradas.length) await cdp('Fetch.continueRequest', { requestId: seguradas.shift() }).catch(() => {});
    await cdp('Fetch.disable');
  }
});

// ═════════════════════════════ 10. higiene geral ═════════════════════════════
test('0 erro de console e 0 violação de CSP; sem rolagem lateral em 320 px', async () => {
  assert.ok(await semRolagemLateral());
  await viewport(320, 568);
  await dormir(300);
  assert.ok(await semRolagemLateral());
  await viewport(390, 844);
  assert.deepEqual(violacoes, [], 'violações de CSP');
  assert.deepEqual(consoleErros, [], 'erros de console');
  assert.ok(esperados.every((e) => /404|500|ERR_|Failed to load/i.test(e)), 'erros esperados inesperados: ' + esperados.join(' ; '));
});
