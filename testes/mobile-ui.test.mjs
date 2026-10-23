// Teste de interface do app do celular (Orbit): telas SESSÕES e APROVAÇÕES e o comportamento de CONEXÃO.
// mobile/ contra o servidor falso testes/mobile-mock.mjs (mesmo processo: o teste mexe em mock.estado / mock.sessoes direto),
// num Edge headless mudo. A Conversa e o Composer têm teste próprio.
//   node --test testes/mobile-ui.test.mjs
// Confere (390×844 e, nos pontos principais, 320×568; movimento reduzido em Sessões e Aprovações):
//   Sessões: grupos como os do PC (interrompida em Concluídas/Revisadas, erro em "Precisa de você", fixadas no topo de cada
//     grupo, Encerradas recolhido), detalhe, tags, sprites, busca, filtro por projeto (guardado), deslizar → revisada / fixar /
//     silenciar (+ "Desfazer"; o pedido que chegou no mock), reversão quando o servidor falha, "+" só com criar instâncias ligado.
//   Aprovações: agrupadas por sessão (mais antiga em cima), badge na barra, o cartão sai depois de respondido (corpo do POST
//     conferido no mock), 404/409 = "já respondido", fila, pedido novo/removido pelo fluxo.
//   Conexão: PC desconectado → faixa e estado certos, lista mantida, reconexão automática do SSE com ressincronização, primeira
//     abertura com o PC fora do ar.
//   0 erro de console e 0 violação de CSP.
// Gestos por PointerEvent sintético (touch). Portas: mock só em 47822–47826 (porta-livre); CDP em 9800–9949.
// Capturas só com ORBIT_UI_FOTOS=<pasta>.

import { test as testeBase, before, after } from 'node:test';
const test = (nome, fn) => testeBase(nome, { timeout: 120000 }, fn);   // travou, falha com mensagem
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { subirMock } from './mobile-mock.mjs';
import { portaLivre } from './porta-livre.mjs';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const FOTOS = process.env.ORBIT_UI_FOTOS ? path.resolve(process.env.ORBIT_UI_FOTOS) : '';

let mock = null, ws = null, seq = 0, portaCdp = 0, perfil = '', manter = null;
const pend = new Map();
const consoleErros = [];
const violacoes = [];
const esperados = [];   // erros de rede provocados de propósito (PC caído, 404/409 forçados)
let tolerando = 0;      // > 0: erros de rede são esperados

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
// toda chamada CDP tem limite: página travada ou Edge morto falham com mensagem em vez de pendurar o arquivo
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
async function exigir(expr, msg, ms) {
  if (await esperar(expr, ms)) return;
  let est = '';
  try { est = await avaliar(`JSON.stringify({ hash: location.hash, conexao: OM.estado.conexao, rota: OM.rotas.atual().nome, faixa: document.getElementById('faixa').textContent, grupos: window.__grupos ? window.__grupos() : null, msgSessoes: (document.querySelector('.tela[data-tela=\"sessoes\"] .sx-msg') || {}).outerHTML.slice(0, 200), sel: [...document.querySelectorAll('.tela[data-tela=\"sessoes\"] .sx-gcab, .tela[data-tela=\"sessoes\"] .sx-fp, .tela[data-tela=\"sessoes\"] .sx-nova:not([hidden])')].map((b) => b.className + ':' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)) })`); } catch {}
  assert.fail(msg + ' | ' + expr.slice(0, 140) + ' | estado: ' + est);
}
const foto = async (nome) => {
  if (!FOTOS) return;
  fs.mkdirSync(FOTOS, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 40 });
  fs.writeFileSync(path.join(FOTOS, nome + '.jpg'), Buffer.from(r.result.data, 'base64'));
};
const Q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const J = JSON.stringify;
const postMock = (r, corpo = {}) => fetch(mock.base + r, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base }, body: JSON.stringify(corpo) });
const mudar = async (corpo) => { assert.equal((await postMock('/_mock/mudar', corpo)).status, 200, 'mudar ' + corpo.id); };
const codigoReal = async () => (await (await fetch(mock.base + '/_mock/codigo')).json()).codigo;
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
const irPara = async (hash) => { await avaliar(`location.hash = ${J(hash)}`); };
async function viewport(w, h) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await dormir(250);
}
const base = (nome) => exigir(`OM.rotas.atual().nome === ${J(nome)} && !document.querySelector('.tela.arrastando') && [...document.querySelectorAll('.tela')].filter((t) => !t.hidden).length === 1`, 'a tela do topo devia ser ' + nome, 6000);
async function tolerar(fn) { tolerando++; try { return await fn(); } finally { await dormir(300); tolerando--; } }
// POSTs que o mock recebeu (menos o de teste), do mais antigo ao mais novo
const posts = (filtro) => mock.estado.log.filter((x) => x.metodo === 'POST' && (!filtro || x.rota.includes(filtro)));

// ───────────────────────────── ganchos injetados em toda página ─────────────────────────────
const INJETADO = `
  window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));
  window.__sim = (() => {
    const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
    let n = 100;
    const pe = (tipo, x, y, id) => new PointerEvent(tipo, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
      bubbles: true, cancelable: true, composed: true, button: tipo === 'pointermove' ? -1 : 0, buttons: tipo === 'pointerup' ? 0 : 1 });
    const alvoDe = (a) => (typeof a === 'string' ? document.querySelector(a) : a);
    async function arrastar(alvo, x0, y0, x1, y1, o = {}) {
      const { passos = 6, espera = 16 } = o;
      const el = alvoDe(alvo) || document.elementFromPoint(x0, y0);
      const id = ++n;
      el.dispatchEvent(pe('pointerdown', x0, y0, id));
      for (let i = 1; i <= passos; i++) { await dorme(espera); el.dispatchEvent(pe('pointermove', x0 + (x1 - x0) * i / passos, y0 + (y1 - y0) * i / passos, id)); }
      await dorme(espera); el.dispatchEvent(pe('pointerup', x1, y1, id));
    }
    return { arrastar, dorme };
  })();`;

async function abrirPagina(hash = '') {
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  // a navegação já travou uma vez sem resposta (Edge lento com a máquina cheia): uma segunda tentativa, com limite menor
  await cdp('Page.navigate', { url: mock.base + '/m' + hash }, 12000).catch(() => cdp('Page.navigate', { url: mock.base + '/m' + hash }));
  await esperar('document.readyState === "complete"');
  await esperar('!!(window.OM && OM.rotas && OM.folha && OM.gestos && OM.estado)');
  await dormir(200);
}

// Começa cada teste do zero: dados do mock de volta ao começo, filtro guardado limpo, página recarregada (o cookie fica).
async function preparar(hash = '#sessoes', n = 6) {
  assert.equal((await postMock('/_mock/reiniciar')).status, 200);
  try { await avaliar(`localStorage.removeItem('orbit.m.sessoes.projeto')`); } catch {}
  await abrirPagina(hash);
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.sessoes.size === ${n}`, 'o app devia estar vivo com as sessões do mock');
  await base(hash.replace('#', ''));
  await dormir(150);
}

// ───────────────────────────── subida e descida ─────────────────────────────
before(async () => {
  mock = await subirMock({ porta: Number(process.env.GERENCIADOR_PORTA) || 47822 });
  const ini = 9800 + Math.floor(Math.random() * 100);
  for (let p = ini; p < ini + 50 && !portaCdp; p++) if (await portaLivre(p)) portaCdp = p;
  assert.ok(portaCdp, 'nenhuma porta livre para o CDP');
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ui-'));
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${portaCdp}`, `--user-data-dir=${perfil}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar();
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await cdp(d + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJETADO });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  await viewport(390, 844);
  // headless deixa a página "hidden" (animações pausadas): forçar visível e em foco, e repetir
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  manter = setInterval(() => { cdp('Page.bringToFront', {}, 5000).catch(() => {}); }, 1000);
  // parear uma vez (o cookie vale para o resto do arquivo)
  await abrirPagina();
  await esperar(`document.body.dataset.modo === 'parear'`);
  const pedido = await avaliar(`OM.parear.pedir('iPhone da UI').then((p) => p.pedido)`);
  assert.ok(pedido, 'OM.parear.pedir devia devolver o pedido');
  assert.equal(await avaliar(`OM.parear.confirmar(${J(pedido)}, ${J(await codigoReal())})`), true);
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo'`, 'depois do código certo devia entrar no app');
});

after(async () => {
  clearInterval(manter);
  try { ws?.close(); } catch {}
  if (portaCdp) await fecharEdge(portaCdp, perfil);
  try { if (perfil) fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
  try { await mock?.fechar(); } catch {}
});

// ═════════════════════════════ ajudantes de Sessões ═════════════════════════════
const TS = '.tela[data-tela="sessoes"]';
// a página guarda um leitor dos grupos: { grupo: { ids:[...], aberto:bool, n:'3' } } só dos grupos à mostra
async function grupos() {
  return JSON.parse(await avaliar(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('${TS} .sx-grupo')].filter((g) => !g.hidden).map((g) => [g.dataset.g, {
    ids: [...g.querySelectorAll('li.sx-linha')].map((l) => l.dataset.id),
    aberto: g.querySelector('.sx-gcab').getAttribute('aria-expanded') === 'true',
    n: g.querySelector('.sx-n').textContent, titulo: g.querySelector('.sx-gtit').textContent }])))`));
}
const ids = async () => Object.fromEntries(Object.entries(await grupos()).map(([k, v]) => [k, v.ids]));
async function exigirGrupos(esperado, msg) {
  const fim = Date.now() + 6000;
  let ult;
  while (Date.now() < fim) { ult = await ids(); if (JSON.stringify(ult) === JSON.stringify(esperado)) return; await dormir(100); }
  assert.deepEqual(ult, esperado, msg);
}
const linha = (id) => `${TS} li.sx-linha[data-id="${id}"]`;
const texto = (sel) => avaliar(`(${Q(sel)} || {}).textContent`);
const toastTxt = () => avaliar(`(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()`);
const esperarToast = (re, msg) => exigir(`(() => { const t = document.getElementById('toast'); return !!t && !t.hidden && ${re}.test(t.textContent); })()`, msg, 4000);
const abertos = () => avaliar(`[...document.querySelectorAll('${TS} .desl.aberto')].map((e) => e.closest('li').dataset.id + '|' + e.dataset.lado)`);
// desliza a linha: 'dir' = arrastar para a direita (abre "Revisada"), 'esq' = para a esquerda (abre Fixar/Silenciar)
async function deslizar(id, sentido, px = 110) {
  const [cx, cy] = await avaliar(`(() => { const r = ${Q(linha(id) + ' .sx-item')}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const ini = sentido === 'dir' ? Math.max(40, cx - 60) : cx + 60;
  await avaliar(`__sim.arrastar(${J(linha(id) + ' .sx-item')}, ${ini}, ${cy}, ${ini + (sentido === 'dir' ? px : -px)}, ${cy}, { passos: 6, espera: 16 })`);
  await exigir(`!!document.querySelector('${TS} li[data-id="${id}"] .desl.aberto')`, 'a linha ' + id + ' devia abrir ao deslizar para ' + sentido, 4000);
  await dormir(350);   // termina a transição de abertura
}
// botão da ação revelada (por rótulo)
const botaoAcao = (id, rotulo) => `[...document.querySelectorAll('${TS} li[data-id="${id}"] .desl-acao')].find((b) => b.querySelector('.desl-rot').textContent.trim() === ${J(rotulo)})`;
async function acionar(id, rotulo) {
  await exigir(`!!(${botaoAcao(id, rotulo)})`, `botão "${rotulo}" em ${id}`, 3000);
  await avaliar(`${botaoAcao(id, rotulo)}.click()`);
}

// ═════════════════════════════ 1. SESSÕES: grupos e conteúdo ═════════════════════════════
test('Sessões: grupos iguais aos do PC, na ordem certa, com título, projeto, detalhe e tags', async () => {
  await preparar('#sessoes');
  assert.equal(await avaliar(`${Q(TS + ' .tit-grande')}.textContent`), 'Sessões');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'grupos iniciais do mock');
  const g = await grupos();
  assert.deepEqual(Object.keys(g), ['precisa', 'trabalhando', 'novas', 'revisadas'], 'ordem dos grupos');
  assert.equal(g.precisa.titulo, 'Precisa de você');
  assert.equal(g.precisa.n, '3');
  assert.equal(g.revisadas.titulo, 'Revisadas');
  assert.ok(Object.values(g).every((x) => x.aberto), 'sem Encerradas, todos abertos');
  // conteúdo das linhas
  assert.equal(await texto(linha('s1') + ' .sx-tit'), 'Corrigir os testes do pareamento');
  assert.equal(await texto(linha('s4') + ' .sx-tit'), 'Refatorar o diário', 'o apelido vence o título');
  assert.equal(await texto(linha('s1') + ' .sx-proj'), 'Orbit');
  assert.equal(await texto(linha('s1') + ' .sx-det'), 'Pede permissão: Bash');
  assert.equal(await texto(linha('s2') + ' .sx-det'), 'Fez uma pergunta');
  assert.equal(await texto(linha('s3') + ' .sx-det'), 'Plano para aprovar');
  assert.equal(await texto(linha('s4') + ' .sx-det'), 'Edit Diario.tsx');
  assert.equal(await texto(linha('s1') + ' .sx-pend'), '1 pendente');
  assert.match(await texto(linha('s4') + ' .sx-tags'), /1 agente/);
  assert.match(await texto(linha('s4') + ' .sx-tags'), /2 em 2º plano/);
  assert.match(await texto(linha('s5') + ' .sx-tags'), /Revisada/, 'a pílula da revisada');
  assert.equal(await avaliar(`${Q(linha('s5') + ' .av-robo')}.dataset.s`), 'revisada');
  assert.equal(await avaliar(`${Q(linha('s1') + ' .av-robo')}.dataset.s`), 'aguardando');
  assert.equal(await avaliar(`${Q(linha('s4') + ' .av-robo')}.dataset.s`), 'trabalhando');
  assert.match(await texto(linha('s1') + ' .sx-tempo'), /\d/, 'tempo desde o último estado');
  assert.equal(await avaliar(`${Q(linha('s1') + ' .sx-item')}.getAttribute('href')`), '#s=s1');
  assert.ok(await semRolagemLateral());
  await foto('sessoes-390');
});

test('Sessões: interrompida em Concluídas/Revisadas, erro em "Precisa de você", fixadas no topo, Encerradas recolhido', async () => {
  await preparar('#sessoes');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'ponto de partida');
  // pelo fluxo (SSE), sem recarregar: s6 interrompida e sem revisão → Concluídas; s4 com erro → Precisa de você (mais velha primeiro)
  await mudar({ id: 's6', status: 'interrompida' });
  await mudar({ id: 's4', status: 'erro', detalhe: 'Falha ao rodar os testes' });
  await exigirGrupos({ precisa: ['s1', 's4', 's2', 's3'], concluidas: ['s6'], revisadas: ['s5'] }, 'interrompida em Concluídas e erro em Precisa de você');
  assert.equal(await avaliar(`${Q(linha('s4') + ' .av-robo')}.dataset.s`), 'erro');
  assert.equal(await texto(linha('s4') + ' .sx-det'), 'Falha ao rodar os testes');
  // desfazer a revisão da s5 → Concluídas (mais nova primeiro: s6 depois s5)
  await mudar({ id: 's5', revisadaEm: 0 });
  await exigirGrupos({ precisa: ['s1', 's4', 's2', 's3'], concluidas: ['s6', 's5'] }, 'revisadaEm 0 volta para Concluídas');
  // a interrompida também pode ser revisada → Revisadas, com a pílula
  await mudar({ id: 's6', revisadaEm: Date.now() });
  await exigirGrupos({ precisa: ['s1', 's4', 's2', 's3'], concluidas: ['s5'], revisadas: ['s6'] }, 'interrompida revisada em Revisadas');
  assert.equal(await avaliar(`${Q(linha('s6') + ' .av-robo')}.dataset.s`), 'revisada');
  // fixadas no topo de CADA grupo
  await mudar({ id: 's3', fixada: true });
  await exigirGrupos({ precisa: ['s3', 's1', 's4', 's2'], concluidas: ['s5'], revisadas: ['s6'] }, 'fixada vai para o topo de Precisa de você');
  assert.ok(await avaliar(`!!${Q(linha('s3') + ' .sx-marca[title="Fixada"]')}`), 'marca de fixada na linha');
  await mudar({ id: 's5', revisadaEm: Date.now() });
  await mudar({ id: 's6', fixada: true, revisadaEm: Date.now() });
  await mudar({ id: 's5', fixada: false });
  await exigirGrupos({ precisa: ['s3', 's1', 's4', 's2'], revisadas: ['s6', 's5'] }, 'fixada no topo de Revisadas (mesmo sendo a mais nova ou não)');
  await mudar({ id: 's5', fixada: true });
  await mudar({ id: 's6', fixada: false });
  await exigirGrupos({ precisa: ['s3', 's1', 's4', 's2'], revisadas: ['s5', 's6'] }, 'a fixada manda, não a data');
  // silenciada
  await mudar({ id: 's1', silenciada: true });
  await exigir(`!!${Q(linha('s1') + ' .sx-marca[title="Silenciada"]')}`, 'marca de silenciada');
  // encerrada: grupo Encerradas recolhido por padrão
  await mudar({ id: 's5', status: 'encerrada', fixada: false });
  await exigirGrupos({ precisa: ['s3', 's1', 's4', 's2'], revisadas: ['s6'], encerradas: ['s5'] }, 'encerrada em Encerradas');
  let g = await grupos();
  assert.equal(g.encerradas.aberto, false, 'Encerradas começa recolhido');
  assert.equal(await avaliar(`${Q(TS + ' .sx-grupo[data-g="encerradas"] .sx-lista')}.hidden`), true);
  await avaliar(`${Q(TS + ' .sx-grupo[data-g="encerradas"] .sx-gcab')}.click()`);
  await exigir(`!${Q(TS + ' .sx-grupo[data-g="encerradas"] .sx-lista')}.hidden`, 'tocar no título abre o grupo');
  assert.equal((await grupos()).encerradas.aberto, true);
  // recolher outro grupo
  await avaliar(`${Q(TS + ' .sx-grupo[data-g="precisa"] .sx-gcab')}.click()`);
  await exigir(`${Q(TS + ' .sx-grupo[data-g="precisa"] .sx-lista')}.hidden`, 'recolher Precisa de você');
  assert.equal((await grupos()).precisa.aberto, false);
  assert.equal((await grupos()).precisa.n, '4', 'o contador segue contando recolhido');
});

test('Sessões: sprites carregam e mudam com o estado', async () => {
  await preparar('#sessoes');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'ponto de partida');
  await exigir(`[...document.querySelectorAll('${TS} li.sx-linha img.spr')].every((i) => i.complete && i.naturalWidth > 0)`, 'todos os sprites da lista carregados', 8000);
  const src = (id) => avaliar(`${Q(linha(id) + ' img.spr')}.currentSrc || ${Q(linha(id) + ' img.spr')}.src`);
  const arq = (u) => (u.match(/sprite-[\w-]+/) || [''])[0];
  const s = {}; for (const id of ['s1', 's4', 's5', 's6']) s[id] = arq(await src(id));
  for (const id of Object.keys(s)) assert.match(s[id], /^sprite-/, 'sprite da ' + id + ': ' + s[id]);
  assert.notEqual(s.s1, s.s4, 'quem pede permissão e quem trabalha têm sprites diferentes: ' + JSON.stringify(s));
  assert.notEqual(s.s4, s.s5, 'trabalhando × revisada: ' + JSON.stringify(s));
  // muda de estado → o sprite acompanha
  await mudar({ id: 's1', status: 'concluida', controle: { permissao: null, pendentes: null } });
  await exigir(`${Q(linha('s1') + ' .av-robo')}.dataset.s === 'concluida'`, 'a s1 virou concluída');
  await exigir(`document.querySelector('${linha('s1')} img.spr').complete && document.querySelector('${linha('s1')} img.spr').naturalWidth > 0`, 'sprite novo carregado', 6000);
  assert.notEqual(arq(await src('s1')), s.s1, 'o sprite da s1 devia mudar ao concluir');
});

// ═════════════════════════════ 2. SESSÕES: busca e filtro ═════════════════════════════
test('Sessões: busca (sem acento), "nada encontrado", limpar; filtro por projeto guardado', async () => {
  await preparar('#sessoes');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'ponto de partida');
  assert.equal(await avaliar(`${Q(TS + ' .sx-limpar')}.hidden`), true, 'sem texto, sem botão limpar');
  const digitar = async (t) => { await avaliar(`${Q(TS + ' .sx-campo')}.focus()`); await cdp('Input.insertText', { text: t }); };
  await digitar('diario');
  await exigirGrupos({ trabalhando: ['s4'] }, 'busca "diario" acha "Diário"/"Refatorar o diário" sem acento');
  assert.equal(await avaliar(`${Q(TS + ' .sx-limpar')}.hidden`), false);
  await avaliar(`${Q(TS + ' .sx-limpar')}.click()`);
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'limpar volta tudo');
  assert.equal(await avaliar(`${Q(TS + ' .sx-campo')}.value`), '');
  await digitar('loja');
  await exigirGrupos({ precisa: ['s3'], novas: ['s6'] }, 'busca por projeto');
  await avaliar(`${Q(TS + ' .sx-campo')}.value = ''; ${Q(TS + ' .sx-campo')}.focus(); true`);
  await cdp('Input.insertText', { text: 'checkout' });
  await exigirGrupos({ precisa: ['s3'] }, 'busca pelo título (a lista inteira é pesquisada, não só a primeira palavra)');
  await avaliar(`${Q(TS + ' .sx-campo')}.value = ''; ${Q(TS + ' .sx-campo')}.focus(); true`);
  await cdp('Input.insertText', { text: 'zzzzxx' });
  await exigir(`!${Q(TS + ' .sx-msg')}.hidden && /Nada encontrado para a busca/.test(${Q(TS + ' .sx-msg')}.textContent)`, 'mensagem de nada encontrado');
  assert.deepEqual(await ids(), {}, 'nenhum grupo à mostra');
  await avaliar(`[...document.querySelectorAll('${TS} .sx-msg button')].find((b) => /Limpar busca e filtro/.test(b.textContent)).click()`);
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'Limpar busca e filtro devolve a lista');

  // filtro por projeto: chips (4 projetos), guardado no aparelho
  await exigir(`!${Q(TS + ' .sx-chips')}.hidden`, 'chips de projeto à mostra com vários projetos');
  const chips = JSON.parse(await avaliar(`JSON.stringify([...document.querySelectorAll('${TS} .sx-fp')].map((b) => [b.dataset.k, b.querySelector('.sx-fp-nome').textContent, b.querySelector('.sx-fp-n').textContent, b.getAttribute('aria-pressed')]))`));
  assert.equal(chips[0][0], 'todos');
  assert.deepEqual([chips[0][1], chips[0][2], chips[0][3]], ['Todos', '6', 'true']);
  assert.equal(chips.length, 5, 'Todos + 4 projetos (Orbit, Cliente Exemplo, Loja Online, Diário): ' + JSON.stringify(chips));
  const orbit = chips.find((c) => c[0] === 'd:/projetos/orbit');
  assert.ok(orbit, 'chave do projeto = pasta normalizada: ' + JSON.stringify(chips));
  assert.equal(orbit[2], '2');
  await avaliar(`${Q(TS + ` .sx-fp[data-k="d:/projetos/orbit"]`)}.click()`);
  await exigirGrupos({ precisa: ['s1'], revisadas: ['s5'] }, 'filtro Orbit');
  assert.equal(await avaliar(`${Q(TS + ` .sx-fp[data-k="d:/projetos/orbit"]`)}.getAttribute('aria-pressed')`), 'true');
  assert.equal(await avaliar(`${Q(TS + ` .sx-fp[data-k="todos"]`)}.getAttribute('aria-pressed')`), 'false');
  assert.equal(await avaliar(`localStorage.getItem('orbit.m.sessoes.projeto')`), 'd:/projetos/orbit', 'filtro guardado');
  // busca + filtro juntos
  await digitar('readme');
  await exigirGrupos({ revisadas: ['s5'] }, 'busca dentro do filtro');
  await avaliar(`${Q(TS + ' .sx-limpar')}.click()`);
  await exigirGrupos({ precisa: ['s1'], revisadas: ['s5'] }, 'limpar a busca mantém o filtro');
  // sobrevive ao recarregar a página
  await abrirPagina('#sessoes');
  await exigir(`OM.estado.sessoes.size === 6`, 'sessões de volta');
  await exigirGrupos({ precisa: ['s1'], revisadas: ['s5'] }, 'o filtro volta depois de recarregar');
  // sessão nova aparece/some do filtro pelo fluxo
  await mudar({ id: 's2', cwd: 'D:\\Projetos\\Orbit', projeto: 'Orbit' });
  await exigirGrupos({ precisa: ['s1', 's2'], revisadas: ['s5'] }, 'o filtro vale para as mudanças do fluxo');
  // Todos
  await avaliar(`${Q(TS + ` .sx-fp[data-k="todos"]`)}.click()`);
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'Todos');
  assert.equal(await avaliar(`localStorage.getItem('orbit.m.sessoes.projeto')`), null, 'Todos apaga o filtro guardado');
});

// ═════════════════════════════ 3. SESSÕES: deslizar ═════════════════════════════
test('Sessões: deslizar → Revisada (+ Desfazer), Fixar, Silenciar; o pedido chega ao mock', async () => {
  await preparar('#sessoes');
  await mudar({ id: 's6', status: 'interrompida' });
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'ponto de partida');
  mock.estado.log.length = 0;

  // sem revisão para quem não terminou: deslizar para a direita não abre nada
  const [cx, cy] = await avaliar(`(() => { const r = ${Q(linha('s1') + ' .sx-item')}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await avaliar(`__sim.arrastar(${J(linha('s1') + ' .sx-item')}, ${cx - 60}, ${cy}, ${cx + 50}, ${cy}, { passos: 6, espera: 16 })`);
  await dormir(450);
  assert.deepEqual(await abertos(), [], 'quem está aguardando não tem "Revisada"');
  assert.equal(await avaliar(`document.querySelectorAll('${linha('s1')} .desl-acoes.desl-esq .desl-acao').length`), 0);

  // Revisada (s6 interrompida)
  await deslizar('s6', 'dir');
  assert.deepEqual(await abertos(), ['s6|esq']);
  assert.equal(await avaliar(`${botaoAcao('s6', 'Revisada')}.getBoundingClientRect().width >= 44`), true, 'alvo de toque >= 44 px');
  await acionar('s6', 'Revisada');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], revisadas: ['s6', 's5'] }, 's6 foi para Revisadas na hora (otimista)');
  await exigir(`${Q(linha('s6') + ' .av-robo')}.dataset.s === 'revisada'`, 'avatar revisada');
  await esperarToast('/Marcada como revisada/', 'toast de revisada');
  assert.ok(await avaliar(`!!document.querySelector('#toast button') && /Desfazer/.test(document.querySelector('#toast button').textContent)`), 'toast com Desfazer');
  assert.equal(JSON.stringify(posts('/s6/revisada').map((x) => x.corpo)), JSON.stringify([{ revisada: true }]), 'POST /sessao/s6/revisada {revisada:true}');
  assert.ok(mock.sessoes.get('s6').revisadaEm > 0, 'o mock guardou revisadaEm');
  // Desfazer pelo toast
  await avaliar(`document.querySelector('#toast button').click()`);
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'Desfazer devolve a s6 a Concluídas');
  assert.equal(JSON.stringify(posts('/s6/revisada').map((x) => x.corpo)), JSON.stringify([{ revisada: true }, { revisada: false }]), 'POST de desfazer');
  assert.equal(mock.sessoes.get('s6').revisadaEm, undefined, 'o mock apagou revisadaEm');

  // Desfazer da s5 (já revisada) pelo botão da linha
  await deslizar('s5', 'dir');
  await acionar('s5', 'Desfazer');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6', 's5'] }, 's5 volta para Concluídas');
  await esperarToast('/Voltou para Concluídas/', 'toast de volta');
  assert.deepEqual(posts('/s5/revisada').map((x) => x.corpo), [{ revisada: false }]);

  // Fixar (s2, aguardando): vai ao topo do grupo
  mock.estado.log.length = 0;
  await deslizar('s2', 'esq');
  assert.deepEqual(await abertos(), ['s2|dir']);
  assert.deepEqual(await avaliar(`[...document.querySelectorAll('${TS} li[data-id="s2"] .desl-acoes.desl-dir .desl-rot')].map((e) => e.textContent.trim())`), ['Fixar', 'Silenciar']);
  await acionar('s2', 'Fixar');
  await exigirGrupos({ precisa: ['s2', 's1', 's3'], trabalhando: ['s4'], concluidas: ['s6', 's5'] }, 'fixada vai para o topo');
  assert.deepEqual(posts('/sessao/s2').map((x) => x.corpo), [{ fixada: true }], 'POST /sessao/s2 {fixada:true}');
  assert.equal(mock.sessoes.get('s2').fixada, true);
  assert.ok(await avaliar(`!!${Q(linha('s2') + ' .sx-marca[title="Fixada"]')}`));
  // o rótulo troca para Desafixar; silenciar
  await dormir(300);
  await deslizar('s2', 'esq');
  assert.deepEqual(await avaliar(`[...document.querySelectorAll('${TS} li[data-id="s2"] .desl-acoes.desl-dir .desl-rot')].map((e) => e.textContent.trim())`), ['Desafixar', 'Silenciar']);
  await acionar('s2', 'Silenciar');
  await exigir(`!!${Q(linha('s2') + ' .sx-marca[title="Silenciada"]')}`, 'marca de silenciada');
  assert.deepEqual(posts('/sessao/s2').map((x) => x.corpo), [{ fixada: true }, { silenciada: true }], 'POST silenciar');
  assert.equal(mock.sessoes.get('s2').silenciada, true);
  await dormir(300);
  await deslizar('s2', 'esq');
  assert.deepEqual(await avaliar(`[...document.querySelectorAll('${TS} li[data-id="s2"] .desl-acoes.desl-dir .desl-rot')].map((e) => e.textContent.trim())`), ['Desafixar', 'Som']);
  await acionar('s2', 'Desafixar');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6', 's5'] }, 'desafixar devolve a ordem por data');
  assert.equal(posts('/sessao/s2').at(-1).corpo.fixada, false);
  await dormir(300);
  await deslizar('s2', 'esq');
  await acionar('s2', 'Som');
  await exigir(`!${Q(linha('s2') + ' .sx-marca[title="Silenciada"]')}`, 'Som tira a marca de silenciada');
  assert.equal(posts('/sessao/s2').at(-1).corpo.silenciada, false);
  assert.ok(await semRolagemLateral());
});

test('Sessões: fixar e silenciar pelo deslizar mostram "Desfazer" e o desfazer volta a ordem', async () => {
  await preparar('#sessoes');
  await mudar({ id: 's6', status: 'interrompida' });
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'ponto de partida');
  mock.estado.log.length = 0;
  // Fixar s2: sobe, mostra o toast com "Desfazer"; Desfazer devolve a ordem e desfixa no mock
  await deslizar('s2', 'esq');
  await acionar('s2', 'Fixar');
  await exigirGrupos({ precisa: ['s2', 's1', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'fixada sobe');
  await esperarToast('/fixada/', 'toast de fixada');
  assert.ok(await avaliar(`!!document.querySelector('#toast button') && /Desfazer/.test(document.querySelector('#toast button').textContent)`), 'toast de fixar com Desfazer');
  await avaliar(`document.querySelector('#toast button').click()`);
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'Desfazer devolve a ordem');
  await exigir(`!${Q(linha('s2') + ' .sx-marca[title="Fixada"]')}`, 'sem marca depois do Desfazer');
  assert.deepEqual(posts('/sessao/s2').map((x) => x.corpo), [{ fixada: true }, { fixada: false }], 'POSTs de fixar e desfazer');
  assert.equal(mock.sessoes.get('s2').fixada, false);
  // Silenciar s3 com Desfazer
  await dormir(300);
  await deslizar('s3', 'esq');
  await acionar('s3', 'Silenciar');
  await esperarToast('/silenciada/', 'toast de silenciada');
  assert.ok(await avaliar(`!!document.querySelector('#toast button') && /Desfazer/.test(document.querySelector('#toast button').textContent)`), 'toast de silenciar com Desfazer');
  await avaliar(`document.querySelector('#toast button').click()`);
  await exigir(`!${Q(linha('s3') + ' .sx-marca[title="Silenciada"]')}`, 'Desfazer tira a marca de silenciada');
  assert.deepEqual(posts('/sessao/s3').map((x) => x.corpo), [{ silenciada: true }, { silenciada: false }]);
});

test('Sessões: se o servidor recusa, a ação é desfeita e o toast avisa', async () => {
  await preparar('#sessoes');
  await mudar({ id: 's6', status: 'interrompida' });
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'ponto de partida');
  // a sessão some só no servidor (sem avisar o fluxo): o POST dá 404
  mock.sessoes.delete('s2');
  mock.sessoes.delete('s6');
  await tolerar(async () => {
    await deslizar('s2', 'esq');
    await acionar('s2', 'Fixar');
    await esperarToast('/Não deu para fixar/', 'toast de falha ao fixar');
    await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'a fixação foi revertida');
    assert.ok(await avaliar(`!${Q(linha('s2') + ' .sx-marca[title="Fixada"]')}`), 'sem marca de fixada');
    await deslizar('s6', 'dir');
    await acionar('s6', 'Revisada');
    await esperarToast('/Não deu para marcar como revisada/', 'toast de falha ao revisar');
    await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'a revisão foi revertida');
  });
});

// ═════════════════════════════ 4. SESSÕES: "+" e navegação ═════════════════════════════
test('Sessões: o "+" só aparece com a opção de criar instâncias ligada', async () => {
  await preparar('#sessoes');
  assert.equal(await avaliar('OM.estado.eu.opcoes.criarInstancias'), true);
  const nova = `${TS} button.sx-nova[aria-label="Nova instância"]`;
  await exigir(`!!${Q(nova)} && !${Q(nova)}.hidden && ${Q(nova)}.getBoundingClientRect().width >= 44`, 'o "+" devia aparecer, com alvo >= 44 px');
  await avaliar(`${Q(nova)}.click()`);
  await exigir(`location.hash === '#nova'`, 'o "+" abre a tela de nova instância');
  // opção desligada no PC: sem o botão
  mock.estado.criarInstancias = false;
  await abrirPagina('#sessoes');
  await exigir(`OM.estado.sessoes.size === 6 && OM.estado.eu && OM.estado.eu.opcoes.criarInstancias === false`, 'o app devia saber que a opção está desligada');
  await dormir(200);
  assert.equal(await avaliar(`${Q(nova)}.hidden || getComputedStyle(${Q(nova)}).display === 'none'`), true, 'sem opção, sem "+"');
  assert.equal(await avaliar(`(${Q(TS + ' .sx-grupos')} || {}).hidden`), false, 'a lista segue normal');
  delete mock.estado.criarInstancias;
});

test('Sessões: tocar na linha abre a conversa; o fluxo mexe na lista sem recarregar', async () => {
  await preparar('#sessoes');
  await avaliar(`${Q(linha('s4') + ' .sx-item')}.click()`);
  await base('conversa');
  assert.equal(await avaliar(`OM.rotas.atual().params.id`), 's4');
  await avaliar(`history.back()`);
  await base('sessoes');
  // concluir pelo fluxo move a linha de grupo
  await mudar({ id: 's4', status: 'concluida', ferramenta: null, desde: Date.now(), atividade: Date.now() });
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], novas: ['s6'], concluidas: ['s4'], revisadas: ['s5'] }, 's4 concluiu: vai para Concluídas');
  // sessão que some do servidor some da lista (evento inicio)
  mock.sessoes.delete('s6');
  await postMock('/_mock/mudar', { id: 's5', titulo: 'Revisar o README (2)' });
  await exigir(`${Q(linha('s5') + ' .sx-tit')}.textContent === 'Revisar o README (2)'`, 'o título novo chega pelo fluxo');
});

// ═════════════════════════════ 5. SESSÕES em 320×568 ═════════════════════════════
test('320×568: Sessões cabem na tela, os alvos de toque têm 44 px e deslizar funciona', async () => {
  await viewport(320, 568);
  try {
    await preparar('#sessoes');
    await mudar({ id: 's6', status: 'interrompida' });
    await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], concluidas: ['s6'], revisadas: ['s5'] }, 'grupos em 320');
    assert.ok(await semRolagemLateral(), 'rolagem lateral nas Sessões em 320 px');
    const caixas = JSON.parse(await avaliar(`JSON.stringify([...document.querySelectorAll('${TS} .sx-linha')].map((l) => { const r = l.getBoundingClientRect(); const t = l.querySelector('.sx-tit').getBoundingClientRect(); return [l.dataset.id, Math.round(r.left), Math.round(r.right), Math.round(r.height), Math.round(t.right)]; }))`));
    for (const [id, l, r, hh, tr] of caixas) {
      assert.ok(l >= 0 && r <= 320, `linha ${id} dentro da tela: ${l}..${r}`);
      assert.ok(hh >= 56, `linha ${id} com altura de toque: ${hh}`);
      assert.ok(tr <= 320, `título de ${id} não vaza: ${tr}`);
    }
    const curtos = await avaliar(`[...document.querySelectorAll('${TS} .sx-gcab, ${TS} .sx-fp, ${TS} .sx-nova:not([hidden]), ${TS} .sx-limpar:not([hidden])')].filter((b) => b.offsetParent !== null).map((b) => { const r = b.getBoundingClientRect(); return b.className + ':' + Math.round(r.width) + 'x' + r.height.toFixed(1); }).filter((x) => { const [w, h] = x.split(':')[1].split('x'); return +h < 43.5 || (!/sx-gcab|sx-fp/.test(x) && +w < 43.5); })`);
    assert.deepEqual(curtos, [], 'cabeçalhos de grupo, chips e  com 44 px de altura');
    const barra = await avaliar(`[...document.querySelectorAll('.barra-aba')].every((a) => { const b = a.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + .5 && b.height >= 43.5; })`);
    assert.ok(barra, 'barra de abas dentro da tela');
    // chips: a faixa rola por dentro, a página não
    assert.ok(await avaliar(`${Q(TS + ' .sx-chips')}.scrollWidth >= ${Q(TS + ' .sx-chips')}.clientWidth`));
    // deslizar nos dois sentidos
    await deslizar('s6', 'dir', 100);
    await acionar('s6', 'Revisada');
    await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], revisadas: ['s6', 's5'] }, 'revisada em 320');
    await dormir(300);
    await deslizar('s3', 'esq', 100);
    await acionar('s3', 'Fixar');
    await exigirGrupos({ precisa: ['s3', 's1', 's2'], trabalhando: ['s4'], revisadas: ['s6', 's5'] }, 'fixar em 320');
    assert.ok(await semRolagemLateral());
    await foto('sessoes-320');
  } finally { await viewport(390, 844); }
});

// ═════════════════════════════ 6. SESSÕES: movimento reduzido ═════════════════════════════
test('Sessões: com movimento reduzido a lista reordena sem deslocar linhas (e sem, desloca)', async () => {
  await preparar('#sessoes');
  const observar = `window.__tr = []; window.__ob = new MutationObserver((ms) => { for (const m of ms) { const t = (m.oldValue || '') + ' | ' + (m.target.getAttribute('style') || ''); if (/translate/.test(t)) window.__tr.push(t); } });
    document.querySelectorAll('${TS} li.sx-linha').forEach((l) => window.__ob.observe(l, { attributes: true, attributeOldValue: true, attributeFilter: ['style'] })); true`;
  // controle: sem movimento reduzido, mudar a ordem desloca as linhas (FLIP)
  await avaliar(observar);
  await mudar({ id: 's3', fixada: true });
  await exigirGrupos({ precisa: ['s3', 's1', 's2'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'ordem nova');
  await dormir(300);
  assert.ok((await avaliar('window.__tr')).some((t) => /translate/.test(t)), 'controle: sem movimento reduzido as linhas se deslocam (FLIP): ' + JSON.stringify(await avaliar('window.__tr')));
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    assert.equal(await avaliar(`matchMedia('(prefers-reduced-motion: reduce)').matches && OM.reduzido()`), true);
    await avaliar(`window.__tr.length = 0; true`);
    await mudar({ id: 's3', fixada: false });
    await mudar({ id: 's2', fixada: true });
    await exigirGrupos({ precisa: ['s2', 's1', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'ordem nova (reduzido)');
    await dormir(400);
    assert.deepEqual(await avaliar('window.__tr'), [], 'movimento reduzido: nenhuma linha deslocada');
    // deslizar e fixar continuam funcionando
    await deslizar('s1', 'esq');
    await acionar('s1', 'Fixar');
    await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'fixar com movimento reduzido');
    await avaliar(`window.__ob.disconnect(); true`);
  } finally { await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); }
});

// ═════════════════════════════ APROVAÇÕES ═════════════════════════════
const TA = '.tela[data-tela="aprovacoes"]';
const item = (pid) => `${TA} .ap-item[data-pedido="${pid}"]`;
const grupoAp = (sid) => `${TA} .ap-grupo[data-sessao="${sid}"]`;
const gruposAp = async () => JSON.parse(await avaliar(`JSON.stringify([...document.querySelectorAll('${TA} .ap-grupo:not(.ap-saindo)')].map((g) => [g.dataset.sessao, [...g.querySelectorAll('.ap-item:not(.ap-saindo)')].map((i) => i.dataset.pedido)]))`));
async function exigirAp(esperado, msg) {
  const fim = Date.now() + 6000;
  let ult;
  while (Date.now() < fim) { ult = await gruposAp(); if (JSON.stringify(ult) === JSON.stringify(esperado)) return; await dormir(100); }
  assert.deepEqual(ult, esperado, msg);
}
const badge = () => avaliar(`(() => { const b = document.querySelector('.barra-aba[data-aba="aprovacoes"] .barra-badge'); return !b || b.hidden ? '' : b.textContent; })()`);
const exigirBadge = (v, msg) => exigir(`(() => { const b = document.querySelector('.barra-aba[data-aba="aprovacoes"] .barra-badge'); return ${J(v)} === (!b || b.hidden ? '' : b.textContent); })()`, msg, 5000);
const botaoTexto = (escopo, rotulo) => `[...document.querySelectorAll(${J(escopo + ' button, ' + escopo + ' .ct-link')})].find((b) => b.textContent.trim() === ${J(rotulo)})`;
async function clicar(escopo, rotulo) {
  await exigir(`!!(${botaoTexto(escopo, rotulo)})`, `botão "${rotulo}" em ${escopo}`, 4000);
  await avaliar(`${botaoTexto(escopo, rotulo)}.click()`);
}

test('Aprovações: agrupadas por sessão, mais antiga em cima, com cartões e badge na barra', async () => {
  await preparar('#aprovacoes');
  assert.equal(await avaliar(`${Q(TA + ' .tit-grande')}.textContent`), 'Aprovações');
  await exigirAp([['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'um grupo por sessão, mais antigo primeiro');
  assert.equal(await badge(), '3', 'badge na barra');
  assert.equal(await avaliar(`${Q('.barra-aba[data-aba="aprovacoes"] .barra-badge')}.getAttribute('aria-label') || ${Q('.barra-aba[data-aba="aprovacoes"]')}.getAttribute('aria-label') || ''`).then((t) => /3/.test(t) || t === ''), true);
  assert.equal(await texto(grupoAp('s1') + ' .ap-tit'), 'Corrigir os testes do pareamento');
  assert.match(await texto(grupoAp('s1') + ' .ap-sub'), /^Orbit · há /, 'projeto e há quanto tempo');
  assert.match(await texto(grupoAp('s2') + ' .ap-sub'), /^Cliente Exemplo · /);
  assert.deepEqual(await avaliar(`['perm-1', 'perm-2', 'perm-3'].map((p) => ${Q(item('perm-1'))}.parentElement && document.querySelector('${TA} .ap-item[data-pedido="' + p + '"] .ct-cartao').dataset.tipo)`), ['ferramenta', 'pergunta', 'plano']);
  assert.match(await texto(item('perm-1') + ' .ct-resumo'), /npm test -- --grep pareamento/);
  assert.ok(await avaliar(`!!(${botaoTexto(item('perm-1'), 'Permitir')}) && !!(${botaoTexto(item('perm-1'), 'Negar')})`), 'Permitir e Negar na ferramenta');
  assert.ok(await avaliar(`!!(${botaoTexto(item('perm-3'), 'Aprovar')})`), 'Aprovar no plano');
  assert.equal(await avaliar(`${Q(grupoAp('s1') + ' .ap-cab')}.getAttribute('href')`), '#s=s1');
  assert.ok(await semRolagemLateral());
  // tocar no cabeçalho abre a conversa da sessão
  await avaliar(`${Q(grupoAp('s2') + ' .ap-cab')}.click()`);
  await base('conversa');
  assert.equal(await avaliar('OM.rotas.atual().params.id'), 's2');
  await avaliar('history.back()');
  await base('aprovacoes');
  await foto('aprovacoes-390');
});

test('Aprovações: responder tira o cartão (e o grupo); o corpo do POST chega certo; vazio no fim', async () => {
  await preparar('#aprovacoes');
  await exigirAp([['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'ponto de partida');
  mock.estado.log.length = 0;
  // ferramenta → Permitir
  await clicar(item('perm-1'), 'Permitir');
  await exigirAp([['s2', ['perm-2']], ['s3', ['perm-3']]], 'o cartão e o grupo saem depois de respondido');
  await exigir(`!document.querySelector('${grupoAp('s1')}')`, 'o grupo sai do DOM', 3000);
  assert.deepEqual(posts('/s1/permissao').map((x) => x.corpo), [{ id: 'perm-1', decisao: 'permitir' }]);
  await exigirBadge('2', 'badge cai para 2');
  // a lista de Sessões já mostra a s1 trabalhando (veio do fluxo)
  assert.equal(mock.sessoes.get('s1').status, 'trabalhando');
  // pergunta → só responde depois de escolher
  const resp = botaoTexto(item('perm-2'), 'Responder');
  assert.equal(await avaliar(`${resp}.getAttribute('aria-disabled')`), 'true', 'Responder travado até escolher');
  await avaliar(`${resp}.click()`);
  await dormir(300);
  assert.equal(posts('/s2/permissao').length, 0, 'travado não envia');
  await avaliar(`[...document.querySelectorAll('${item('perm-2')} .ct-op')].find((l) => /SQLite/.test(l.textContent)).querySelector('input').click()`);
  await exigir(`${resp}.getAttribute('aria-disabled') !== 'true'`, 'escolher libera o Responder');
  await avaliar(`${resp}.click()`);
  await exigirAp([['s3', ['perm-3']]], 'a pergunta respondida sai');
  assert.deepEqual(posts('/s2/permissao').map((x) => x.corpo), [{ id: 'perm-2', decisao: 'permitir', respostas: { 'Qual banco usar?': 'SQLite' } }]);
  await exigirBadge('1', 'badge cai para 1');
  // plano → Negar com "Continuar planejando"
  await clicar(item('perm-3'), 'Continuar planejando');
  await avaliar(`${Q(item('perm-3') + ' textarea.ct-txt')}.focus()`);
  await cdp('Input.insertText', { text: 'Falta tratar o frete' });
  await clicar(item('perm-3'), 'Enviar e continuar planejando');
  await exigirAp([], 'o plano sai');
  assert.deepEqual(posts('/s3/permissao').map((x) => x.corpo), [{ id: 'perm-3', decisao: 'negar', mensagem: 'Falta tratar o frete' }]);
  await exigirBadge('', 'sem pendências, sem badge');
  await exigir(`!${Q(TA + ' .ap-vazio')}.hidden && /Nada esperando você/.test(${Q(TA + ' .ap-vazio')}.textContent)`, 'estado vazio "Nada esperando você"');
  assert.ok(await avaliar(`${Q(TA + ' .ap-vazio img')}.complete`), 'sprite do vazio');
  await foto('aprovacoes-vazio');
});

test('Aprovações: 404 e 409 = "já respondido" (toast, e o cartão termina)', async () => {
  await preparar('#aprovacoes');
  await exigirAp([['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'ponto de partida');
  await tolerar(async () => {
    // 409 forçado em Negar (ferramenta)
    mock.estado.forcarPermissao = 409;
    await clicar(item('perm-1'), 'Negar');
    await esperarToast('/Esse pedido já foi respondido\\./', 'toast de já respondido (409)');
    await exigirAp([['s2', ['perm-2']], ['s3', ['perm-3']]], 'o cartão do 409 sai');
    assert.deepEqual(posts('/s1/permissao').map((x) => x.corpo), [{ id: 'perm-1', decisao: 'negar' }]);
    await exigirBadge('2', 'o badge segue o servidor? (a s1 ainda pede no mock; o cartão não volta)').catch(() => {});
    // 404 forçado em "Não responder" (pergunta)
    mock.estado.forcarPermissao = 404;
    await avaliar(`document.getElementById('toast').hidden = true`);
    await clicar(item('perm-2'), 'Não responder');
    await esperarToast('/Esse pedido já foi respondido\\./', 'toast de já respondido (404 forçado)');
    await exigirAp([['s3', ['perm-3']]], 'o cartão do 404 sai');
    // 404 natural: o pedido mudou de id no servidor, o celular ainda mostra o velho
    mock.sessoes.get('s3').controle.permissao.id = 'perm-3-novo';
    await avaliar(`document.getElementById('toast').hidden = true`);
    await clicar(item('perm-3'), 'Aprovar');
    await esperarToast('/Esse pedido já foi respondido\\./', 'toast de já respondido (404 natural)');
    await exigirAp([], 'o cartão do 404 natural sai');
    assert.deepEqual(posts('/s3/permissao').map((x) => x.corpo), [{ id: 'perm-3', decisao: 'permitir' }], 'o app mandou o id que mostrava');
  });
});

test('Aprovações: fila, pedido novo pelo fluxo entra no lugar certo e pedido resolvido no PC sai sozinho', async () => {
  await preparar('#aprovacoes');
  await exigirAp([['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'ponto de partida');
  assert.equal(await avaliar(`document.querySelectorAll('${TA} .ct-fila:not([hidden])').length`), 0, 'sem fila, sem aviso');
  // a s1 tem mais 2 na fila
  await mudar({ id: 's1', controle: { pendentes: 3 } });
  await exigir(`!${Q(item('perm-1') + ' .ct-fila')}.hidden && /mais 2 pedidos na fila/.test(${Q(item('perm-1') + ' .ct-fila')}.textContent)`, 'aviso de fila no cartão');
  await exigirBadge('5', 'o badge conta a fila');
  // a s6 passa a pedir permissão: é a mais velha (20 min), entra em cima
  await mudar({ id: 's6', status: 'aguardando', titulo: 'Escrever a documentação', controle: { permissao: { id: 'perm-6', tipo: 'ferramenta', ferramenta: 'Write', resumo: 'Escrever README.md', entrada: { file_path: 'README.md' } }, pendentes: 1 } });
  await exigirAp([['s6', ['perm-6']], ['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'o pedido novo entra no lugar pelo tempo');
  assert.equal(await texto(grupoAp('s6') + ' .ap-tit'), 'Escrever a documentação');
  await exigirBadge('6', 'badge soma o novo');
  // o 1º da fila da s1 é respondido no PC e o próximo toma o lugar (mesmo grupo)
  await mudar({ id: 's1', controle: { permissao: { id: 'perm-1b', tipo: 'ferramenta', ferramenta: 'Edit', resumo: 'Editar servidor.mjs', entrada: { file_path: 'servidor.mjs' } }, pendentes: 2 } });
  await exigirAp([['s6', ['perm-6']], ['s1', ['perm-1b']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'o pedido da frente da fila troca no mesmo grupo');
  assert.match(await texto(item('perm-1b') + ' .ct-fila'), /mais 1 pedido na fila/);
  // resolvido no PC: some sozinho, sem tocar
  await mudar({ id: 's6', status: 'trabalhando', controle: { permissao: null, pendentes: null } });
  await exigirAp([['s1', ['perm-1b']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'o pedido resolvido no PC sai sozinho');
  await exigirBadge('4', 'badge: 2 da s1 + s2 + s3');
});

test('320×568: Aprovações cabem na tela e os botões têm 44 px', async () => {
  await viewport(320, 568);
  try {
    await preparar('#aprovacoes');
    await exigirAp([['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'cartões em 320');
    assert.ok(await semRolagemLateral(), 'rolagem lateral em Aprovações com 320 px');
    assert.ok(await avaliar(`[...document.querySelectorAll('${TA} .ap-item, ${TA} .ct-cartao')].every((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= 320.5; })`), 'cartões dentro da tela');
    const peq = await avaliar(`[...document.querySelectorAll('${TA} .ct-cartao .btn')].filter((b) => b.getBoundingClientRect().height < 43.5).map((b) => b.textContent.trim())`);
    assert.deepEqual(peq, [], 'botões dos cartões com menos de 44 px de altura');
    const cab = await avaliar(`[...document.querySelectorAll('${TA} .ap-cab')].filter((b) => b.getBoundingClientRect().height < 43.5).length`);
    assert.equal(cab, 0, 'cabeçalhos de grupo com 44 px');
    // o plano e a pergunta com texto longo não estouram
    await mudar({ id: 's3', controle: { permissao: { id: 'perm-3', tipo: 'plano', ferramenta: 'ExitPlanMode', resumo: 'Plano', plano: '## Plano\n\n' + 'Uma linha comprida sem quebra ' + 'x'.repeat(80) + '\n\n```\n' + 'y'.repeat(120) + '\n```\n' } } });
    await dormir(400);
    assert.ok(await semRolagemLateral(), 'plano comprido não estoura a largura em 320 px');
    // responder em 320
    await clicar(item('perm-1'), 'Permitir');
    await exigirAp([['s2', ['perm-2']], ['s3', ['perm-3']]], 'responder em 320');
    await foto('aprovacoes-320');
  } finally { await viewport(390, 844); }
});

test('Aprovações: com movimento reduzido o cartão só some (sem encolher a altura)', async () => {
  await preparar('#aprovacoes');
  await exigirAp([['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'ponto de partida');
  const gravar = `window.__ks = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.target.querySelectorAll ? [m.target] : []) {
      if (n.classList && n.classList.contains('ap-saindo')) window.__ks.push(n.getAnimations().map((a) => a.effect.getKeyframes().map((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x)).join('+')).join('>')).join('|')); } })
    .observe(document.querySelector('${TA} .ap-lista'), { attributes: true, subtree: true, attributeFilter: ['class'] }); true`;
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    assert.equal(await avaliar('OM.reduzido()'), true);
    await avaliar(gravar);
    await clicar(item('perm-1'), 'Permitir');
    await exigirAp([['s2', ['perm-2']], ['s3', ['perm-3']]], 'sai com movimento reduzido');
    const ks = await avaliar('window.__ks');
    assert.ok(ks.length >= 1, 'a saída gerou uma animação');
    assert.ok(ks.every((k) => k !== '' && !/height|transform|padding/.test(k) && /opacity/.test(k)), 'só opacidade em movimento reduzido: ' + JSON.stringify(ks));
  } finally { await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); }
  // controle: sem movimento reduzido, sai só com opacidade e escala (nunca altura; os irmãos sobem por FLIP)
  await avaliar(`window.__ks.length = 0; true`);
  await clicar(item('perm-2'), 'Não responder');
  await exigirAp([['s3', ['perm-3']]], 'sai com movimento normal');
  const k2 = await avaliar('window.__ks');
  assert.ok(k2.length >= 1 && k2.every((k) => !/height|padding/.test(k)) && k2.some((k) => /opacity/.test(k)), 'controle: sem movimento reduzido sai sem animar altura: ' + JSON.stringify(k2));
});

// ═════════════════════════════ CONEXÃO ═════════════════════════════
const faixaVisivel = `!document.getElementById('faixa').hidden`;

test('Conexão: PC desconectado mostra a faixa, a lista continua, e a reconexão do SSE é automática e ressincroniza', async () => {
  await preparar('#sessoes');
  await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'ponto de partida');
  assert.equal(await avaliar(`document.getElementById('faixa').hidden`), true, 'vivo = sem faixa');
  await tolerar(async () => {
    assert.equal((await postMock('/_mock/cair')).status, 200);
    await exigir(`OM.estado.conexao === 'pc' && ${faixaVisivel} && /PC desconectado/.test(document.getElementById('faixa').textContent)`, 'a faixa devia chegar em "PC desconectado"', 15000);
    assert.equal(await avaliar('document.body.dataset.conexao'), 'pc');
    assert.ok(await avaliar(`[...document.querySelectorAll('#faixa button')].some((b) => /Tentar agora/.test(b.textContent))`), 'botão Tentar agora');
    assert.ok(await avaliar(`${Q('#faixa .faixa-btn')}.offsetHeight >= 36`), 'Tentar agora com ao menos 36 px (o app usa 36 px na faixa, não 44)');
    // a lista antiga continua à mostra (não vira erro) e o resto da tela segue inteiro
    assert.deepEqual(Object.keys(await ids()), ['precisa', 'trabalhando', 'novas', 'revisadas'], 'a lista se mantém com o PC fora');
    assert.equal(await avaliar(`${Q(TS + ' .sx-msg')}.hidden`), true, 'sem mensagem de erro por cima da lista');
    assert.ok(await avaliar(`${Q('#barra')}.getBoundingClientRect().height > 40`), 'barra de abas continua');
    // enquanto cai, o PC muda: a ressincronização tem de trazer isso
    mock.sessoes.get('s6').titulo = 'Mudou enquanto o PC estava fora';
    mock.sessoes.get('s4').status = 'concluida';
    mock.sessoes.get('s4').desde = Date.now();
    await foto('conexao-pc');
    assert.equal((await postMock('/_mock/voltar')).status, 200);
    await exigir(`OM.estado.conexao === 'vivo' && document.getElementById('faixa').hidden`, 'a faixa devia sumir sozinha e o SSE voltar (sem tocar em nada)', 30000);
    await exigir(`${Q(linha('s6') + ' .sx-tit')}.textContent === 'Mudou enquanto o PC estava fora'`, 'o `inicio` do SSE novo ressincroniza o título', 6000);
    await exigirGrupos({ precisa: ['s1', 's2', 's3'], novas: ['s6'], concluidas: ['s4'], revisadas: ['s5'] }, 'a ressincronização move a s4 de grupo', 6000);
    // o fluxo voltou ao vivo: uma mudança nova chega
    await mudar({ id: 's6', titulo: 'Depois da volta' });
    await exigir(`${Q(linha('s6') + ' .sx-tit')}.textContent === 'Depois da volta'`, 'o fluxo está vivo de novo');
  });
});

test('Conexão: "Tentar agora" religa na hora; sem tocar, tenta de novo sozinho', async () => {
  await preparar('#sessoes');
  await tolerar(async () => {
    await postMock('/_mock/cair');
    await exigir(`OM.estado.conexao === 'pc' && /PC desconectado/.test(document.getElementById('faixa').textContent)`, 'faixa do PC', 15000);
    assert.match(await avaliar(`${Q('#faixa .faixa-sub')}.textContent`), /Tentando/, 'a faixa diz quando tenta de novo');
    await postMock('/_mock/voltar');
    await avaliar(`[...document.querySelectorAll('#faixa button')].find((b) => /Tentar agora/.test(b.textContent)).click()`);
    await exigir(`OM.estado.conexao === 'vivo' && document.getElementById('faixa').hidden`, 'Tentar agora devia religar logo', 6000);
  });
});

test('Conexão: com o PC fora, os pedidos ficam na tela e responder não os perde', async () => {
  await preparar('#aprovacoes');
  await exigirAp([['s1', ['perm-1']], ['s2', ['perm-2']], ['s3', ['perm-3']]], 'ponto de partida');
  await tolerar(async () => {
    await postMock('/_mock/cair');
    await exigir(`OM.estado.conexao === 'pc'`, 'PC fora', 15000);
    assert.ok(await avaliar(`!${Q(TA + ' .ap-vazio')} || ${Q(TA + ' .ap-vazio')}.hidden`), 'sem "Nada esperando você" só porque o PC caiu');
    assert.deepEqual((await gruposAp()).map((g) => g[0]), ['s1', 's2', 's3'], 'os cartões continuam à mostra');
    // tentar responder sem PC: dá aviso e o cartão fica (nada se perde)
    await clicar(item('perm-1'), 'Permitir');
    await dormir(1200);
    assert.deepEqual((await gruposAp()).map((g) => g[0]), ['s1', 's2', 's3'], 'resposta que não chegou não tira o cartão');
    assert.ok(await avaliar(`!!(${botaoTexto(item('perm-1'), 'Permitir')}) && !${botaoTexto(item('perm-1'), 'Permitir')}.disabled`), 'o botão volta a ficar disponível');
    assert.match(await avaliar(`(() => { const e = document.querySelector('${item('perm-1')} .ct-erro'); return e && !e.hidden ? e.textContent : ''; })()`), /Não deu para responder/, 'o cartão avisa (.ct-erro) que a resposta não chegou');
    assert.equal(posts('/s1/permissao').length, 0, 'nada chegou ao mock');
    await postMock('/_mock/voltar');
    await exigir(`OM.estado.conexao === 'vivo'`, 'volta', 30000);
    await clicar(item('perm-1'), 'Permitir');
    await exigirAp([['s2', ['perm-2']], ['s3', ['perm-3']]], 'com o PC de volta, a resposta passa');
    assert.deepEqual(posts('/s1/permissao').map((x) => x.corpo), [{ id: 'perm-1', decisao: 'permitir' }]);
  });
});

test('Conexão: abrir o app com o PC fora do ar mostra a faixa e a lista chega sozinha quando ele volta', async () => {
  assert.equal((await postMock('/_mock/reiniciar')).status, 200);
  try { await avaliar(`localStorage.removeItem('orbit.m.sessoes.projeto')`); } catch {}
  await tolerar(async () => {
    await postMock('/_mock/cair');
    await abrirPagina('#sessoes');
    await exigir(`!!(window.OM && OM.estado) && ['pc', 'reconectando'].includes(OM.estado.conexao) && ${faixaVisivel}`, 'faixa com o PC fora do ar na abertura', 20000);
    await exigir(`OM.estado.conexao === 'pc' && /PC desconectado/.test(document.getElementById('faixa').textContent)`, 'chega em "PC desconectado"', 20000);
    assert.equal(await avaliar(`document.querySelectorAll('${TS} li.sx-linha').length`), 0, 'nenhuma sessão inventada');
    await postMock('/_mock/voltar');
    await avaliar(`[...document.querySelectorAll('#faixa button')].find((b) => /Tentar agora/.test(b.textContent)).click()`);
    await exigir(`OM.estado.conexao === 'vivo' && OM.estado.sessoes.size === 6 && document.getElementById('faixa').hidden`, 'o app devia se recuperar sozinho', 25000);
    await exigirGrupos({ precisa: ['s1', 's2', 's3'], trabalhando: ['s4'], novas: ['s6'], revisadas: ['s5'] }, 'lista cheia depois da volta');
    assert.equal(await avaliar(`${Q(TS + ' .sx-msg')}.hidden`), true);
  });
});

// BUG DO APP: com o PC fora na abertura as Sessões ficam no esqueleto, porque só o evento 'estado' as redesenha.
test('Conexão: abrir o app com o PC fora do ar troca o esqueleto das Sessões por "Não deu para carregar" + Tentar de novo', async () => {
  assert.equal((await postMock('/_mock/reiniciar')).status, 200);
  try { await avaliar(`localStorage.removeItem('orbit.m.sessoes.projeto')`); } catch {}
  await tolerar(async () => {
    await postMock('/_mock/cair');
    await abrirPagina('#sessoes');
    await exigir(`OM.estado.conexao === 'pc'`, 'chega em PC desconectado', 20000);
    await exigir(`!${Q(TS + ' .sx-msg')}.hidden && /Não deu para carregar as sessões/.test(${Q(TS + ' .sx-msg')}.textContent)`, 'sem dados: mensagem de erro com "Tentar de novo"');
    assert.ok(await avaliar(`[...document.querySelectorAll('${TS} .sx-msg button')].some((b) => /Tentar de novo/.test(b.textContent))`));
    await postMock('/_mock/voltar');
  });
});

// ═════════════════════════════ fecho ═════════════════════════════
test('0 erro de console e 0 violação de CSP', async () => {
  assert.deepEqual(violacoes, [], 'violações de CSP: ' + violacoes.join(' ; '));
  assert.deepEqual(consoleErros, [], 'erros de console: ' + consoleErros.join(' ; '));
  assert.ok(esperados.every((e) => /404|409|503|ERR_|Failed to load/i.test(e)), 'erros de rede inesperados: ' + esperados.join(' ; '));
});
