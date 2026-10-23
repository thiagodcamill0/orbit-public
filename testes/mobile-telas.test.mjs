// Teste das TELAS SECUNDÁRIAS do app novo do celular (bloco 4, onda 4): detalhe da sessão, nova instância, Mais (navegação,
// notificações, este aparelho), uso do plano, ideias, histórico de avisos e parear, contra o servidor falso testes/mobile-mock.mjs,
// num Edge headless mudo (390×844; o principal também a 320×568; movimento reduzido em um passo).
//   node --test testes/mobile-telas.test.mjs
// O Início tem o seu próprio teste (mobile-widgets.test.mjs). Gestos: PointerEvent sintético (touch) na página.
// Portas: o mock usa só 47822–47826 (sem porta livre, espera 30 s e tenta de novo, até ~10 min); o CDP, uma livre em 9800–9949.
// Capturas só com ORBIT_TELAS_FOTOS=<pasta> (no máximo 2, pequenas).

import { test as testeBase, before, after } from 'node:test';
const test = (nome, fn) => testeBase(nome, { timeout: 100000 }, fn);
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { subirMock } from './mobile-mock.mjs';
import { portaLivre } from './porta-livre.mjs';

const LOJA = ['D:', 'Projetos', 'Loja'].join(String.fromCharCode(92));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const FOTOS = process.env.ORBIT_TELAS_FOTOS ? path.resolve(process.env.ORBIT_TELAS_FOTOS) : '';

let mock = null, edge = null, ws = null, seq = 0, portaCdp = 0, perfil = '', manter = null;
const pend = new Map();
const consoleErros = [];
const violacoes = [];
const esperados = [];   // erros de rede provocados de propósito (401 sem pareamento, 403/409 recusados pelo mock, PC caído)
let tolerando = 0;

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
  try { est = await avaliar(`JSON.stringify({ hash: location.hash, modo: document.body.dataset.modo, conexao: OM.estado.conexao, rota: OM.rotas.atual(), folhas: OM.folha.abertas(), toast: (document.getElementById('toast') || {}).textContent })`); } catch {}
  assert.fail(msg + ' | ' + expr.slice(0, 160) + ' | estado: ' + est);
}
const foto = async (nome) => {
  if (!FOTOS) return;
  fs.mkdirSync(FOTOS, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 40 });
  fs.writeFileSync(path.join(FOTOS, nome + '.jpg'), Buffer.from(r.result.data, 'base64'));
};
const Q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const QA = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})]`;
const rota = () => avaliar('OM.rotas.atual()');
const postMock = (r, corpo = {}) => fetch(mock.base + r, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base }, body: JSON.stringify(corpo) });
const codigoReal = async () => (await (await fetch(mock.base + '/_mock/codigo')).json()).codigo;
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
const irPara = async (hash) => { await avaliar(`location.hash = ${JSON.stringify(hash)}`); };
async function viewport(w, h) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await dormir(250);
}
const noTopo = (nome) => exigir(`OM.rotas.atual().nome === ${JSON.stringify(nome)} && [...document.querySelectorAll('.tela')].filter((t) => !t.hidden).length === 1 && !document.querySelector('.tela.arrastando')`, 'a tela do topo devia ser ' + nome, 6000);
// clica num elemento da página (seletor + regex de texto opcional) e falha se não existir
const clicar = (sel, texto) => avaliar(`(() => { const el = ${QA(sel)}.find((e) => ${texto ? `${texto}.test(e.textContent)` : 'true'}); if (!el) throw new Error('não achei ' + ${JSON.stringify(sel)} + ' ' + ${JSON.stringify(String(texto || ''))}); el.click(); return true; })()`);
const textoDe = (sel) => avaliar(`(${Q(sel)} || {}).textContent ?? null`);
// POSTs que o mock recebeu (rota casando com a regex), do mais antigo ao mais novo
const posts = (re) => mock.estado.log.filter((l) => l.metodo === 'POST' && re.test(l.rota));
const limparLog = () => { mock.estado.log.length = 0; };
const toastTexto = () => avaliar(`(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()`);
const folhaBtn = (texto) => clicar('.folha .btn', texto);
const folhaAberta = () => exigir(`!!${Q('.folha')} && OM.folha.abertas() === 1`, 'a folha devia abrir', 4000);
const folhaSumiu = () => exigir(`!${Q('.folha')} && !${Q('.folha-fundo')} && OM.folha.abertas() === 0`, 'a folha devia sumir', 4000);

const INJETADO = `
  window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));
  window.__sim = (() => {
    const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
    let n = 100;
    const pe = (tipo, x, y, id) => new PointerEvent(tipo, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
      bubbles: true, cancelable: true, composed: true, button: tipo === 'pointermove' ? -1 : 0, buttons: tipo === 'pointerup' ? 0 : 1 });
    const alvoDe = (a) => (typeof a === 'string' ? document.querySelector(a) : a);
    async function arrastar(alvo, x0, y0, x1, y1, o = {}) {
      const { passos = 6, espera = 16, soltar = true } = o;
      const el = alvoDe(alvo) || document.elementFromPoint(x0, y0);
      const id = ++n;
      el.dispatchEvent(pe('pointerdown', x0, y0, id));
      for (let i = 1; i <= passos; i++) { await dorme(espera); el.dispatchEvent(pe('pointermove', x0 + (x1 - x0) * i / passos, y0 + (y1 - y0) * i / passos, id)); }
      if (soltar) { await dorme(espera); el.dispatchEvent(pe('pointerup', x1, y1, id)); }
      return id;
    }
    const centro = (a) => { const r = alvoDe(a).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    return { arrastar, centro, dorme };
  })();`;

async function abrirPagina(hash = '') {
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  await cdp('Page.navigate', { url: mock.base + '/m' + hash });
  await esperar('document.readyState === "complete"');
  await esperar('!!(window.OM && OM.rotas && OM.folha && OM.gestos && OM.estado)');
  await dormir(200);
}
// pareia pela API da casca (a tela de parear tem o seu próprio caso) e espera o estado vivo
async function parear(nome = 'iPhone das telas') {
  await abrirPagina();
  await exigir(`document.body.dataset.modo === 'parear'`, 'sem cookie devia estar no modo parear');
  const pedido = await avaliar(`OM.parear.pedir(${JSON.stringify(nome)}).then((p) => p.pedido)`);
  assert.equal(await avaliar(`OM.parear.confirmar(${JSON.stringify(pedido)}, ${JSON.stringify(await codigoReal())})`), true);
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.sessoes.size >= 6`, 'SSE vivo com as 6 sessões do mock', 12000);
}

// ───────────────────────────── subida e descida ─────────────────────────────
before(async () => {
  // sem porta livre em 47822–47826 (outros agentes testando), espera 30 s e tenta de novo, até ~10 min
  for (let t = 0; !mock; t++) {
    try { mock = await subirMock({ porta: Number(process.env.GERENCIADOR_PORTA) || 47822 }); }
    catch (e) { if (!/nenhuma porta livre/.test(String(e.message)) || t >= 20) throw e; await dormir(30000); }
  }
  const ini = 9800 + Math.floor(Math.random() * 100);
  for (let p = ini; p < ini + 50 && !portaCdp; p++) if (await portaLivre(p)) portaCdp = p;
  assert.ok(portaCdp, 'nenhuma porta livre para o CDP');
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-telas-'));
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${portaCdp}`, `--user-data-dir=${perfil}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar();
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await cdp(d + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJETADO });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  await viewport(390, 844);
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

// ═════════════════════════════ 0. parear para valer o resto ═════════════════════════════
test('pareamento inicial pela API da casca chega em #inicio', async () => {
  await parear();
  await exigir(`OM.rotas.atual().nome === 'inicio'`, 'devia cair em #inicio');
});

// ═════════════════════════════ 1. detalhe da sessão ═════════════════════════════
const btnVis = (re) => `${QA('.dt-btn')}.some((b) => !b.hidden && ${re}.test(b.textContent))`;
async function abrirDetalhe(id) {
  if ((await rota()).nome !== 'inicio') { await irPara('#inicio'); await noTopo('inicio'); }
  await irPara('#s=' + id + '/detalhe');
  await noTopo('detalhe');
  await exigir(`${Q('.dt-conteudo')} && !${Q('.dt-conteudo')}.hidden`, 'o conteúdo do detalhe devia aparecer', 4000);
}
const chave = (rotulo) => `${QA('.dt-chave input.chave')}.find((i) => i.getAttribute('aria-label') === ${JSON.stringify(rotulo)})`;
const chaveMarcada = (rotulo) => avaliar(`${chave(rotulo)}.checked`);
const chaveClicar = (rotulo) => avaliar(`(${chave(rotulo)}.click(), true)`);
const ultimoCorpo = (re) => posts(re).at(-1)?.corpo;

for (const [w, h] of [[390, 844], [320, 568]]) {
  test(`detalhe (${w}×${h}): informações, apelido, fixar, silenciar e compactação automática`, async () => {
    await viewport(w, h);
    await avaliar('OM.folha.fecharTodas()');
    limparLog();
    await abrirDetalhe('s4');
    assert.match(await textoDe('.dt-nome'), /Refatorar o diário/);
    const infos = await avaliar(`${QA('.dt-linha')}.map((l) => l.textContent)`);
    assert.ok(infos.some((t) => /Projeto/.test(t) && /Diário/.test(t)), 'linha Projeto: ' + infos);
    assert.ok(infos.some((t) => /Contexto/.test(t) && /40\s*%/.test(t)), 'linha Contexto com 40%: ' + infos);
    assert.equal(await semRolagemLateral(), true, 'sem rolagem lateral');
    assert.equal(await avaliar(`${QA('.dt-ag')}.length`), 2, 'dois agentes');
    assert.equal(await avaliar(`${QA('.dt-ta')}.length`), 2, 'duas tarefas em segundo plano');
    assert.equal(await chaveMarcada('Fixar no topo'), false);
    assert.equal(await chaveMarcada('Silenciar avisos'), false);
    assert.equal(await chaveMarcada('Compactação automática'), true);

    // apelido: abre a folha, edita (espaços sobrando), salva
    assert.match(await textoDe('.dt-apelido'), /Refatorar o diário/);
    await clicar('button.dt-item');
    await folhaAberta();
    assert.match(await textoDe('.folha'), /Apelido da sessão/);
    assert.equal(await avaliar(`${Q('input.dt-campo')}.value`), 'Refatorar o diário');
    await avaliar(`(() => { const c = ${Q('input.dt-campo')}; c.value = '  Diário   novo  '; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await textoDe('.dt-cont'), '  Diário   novo  '.length + '/60');
    await folhaBtn(/^Salvar$/);
    await folhaSumiu();
    await exigir(`${Q('.dt-apelido')}.textContent === 'Diário novo'`, 'o apelido novo devia aparecer (espaços normalizados)');
    await exigir(`true`);
    await dormir(200);
    assert.deepEqual(ultimoCorpo(/^\/sessao\/s4$/), { apelido: 'Diário novo' });
    assert.equal(mock.sessoes.get('s4').apelido, 'Diário novo');

    // fixar, silenciar, compactação automática
    await chaveClicar('Fixar no topo');
    await dormir(300);
    assert.deepEqual(ultimoCorpo(/^\/sessao\/s4$/), { fixada: true });
    assert.equal(mock.sessoes.get('s4').fixada, true);
    assert.equal(await chaveMarcada('Fixar no topo'), true);
    await chaveClicar('Silenciar avisos');
    await dormir(300);
    assert.deepEqual(ultimoCorpo(/^\/sessao\/s4$/), { silenciada: true });
    assert.equal(mock.sessoes.get('s4').silenciada, true);
    await chaveClicar('Compactação automática');
    await dormir(300);
    assert.deepEqual(ultimoCorpo(/\/autocompactar$/), { ativo: false });
    assert.equal(mock.sessoes.get('s4').controle.autoCompactar.ligada, false);
    assert.equal(await chaveMarcada('Compactação automática'), false);
    await chaveClicar('Compactação automática');
    await dormir(300);
    assert.deepEqual(ultimoCorpo(/\/autocompactar$/), { ativo: true });
    assert.equal(await chaveMarcada('Compactação automática'), true);

    // desfaz fixar, silenciar e apelido (o outro viewport repete o caso com o mock limpo)
    await chaveClicar('Fixar no topo'); await chaveClicar('Silenciar avisos');
    await dormir(300);
    assert.equal(mock.sessoes.get('s4').fixada, false);
    assert.equal(mock.sessoes.get('s4').silenciada, false);
    await clicar('button.dt-item');
    await folhaAberta();
    await avaliar(`(() => { const c = ${Q('input.dt-campo')}; c.value = 'Refatorar o diário'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await folhaBtn(/^Salvar$/);
    await folhaSumiu();
    await dormir(300);
    assert.equal(mock.sessoes.get('s4').apelido, 'Refatorar o diário');
    assert.equal(await semRolagemLateral(), true);
    if (w === 320) await foto('detalhe-' + w);
  });
}

test('detalhe: revisada marca e desmarca (só sessão concluída)', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  limparLog();
  // s5 já vem revisada: o botão oferece desmarcar
  await abrirDetalhe('s5');
  const rotuloRev = () => avaliar(`(${Q('.dt-btn:not(.perigo)')} || {}).textContent`);
  await exigir(`/Desmarcar como revisada/.test(${Q('.dt-btn')}.textContent)`, 'em s5 (revisada) devia oferecer desmarcar');
  await clicar('.dt-btn', /Desmarcar como revisada/);
  await exigir(`/Marcar como revisada/.test(${Q('.dt-btn')}.textContent) && !/Desmarcar/.test(${Q('.dt-btn')}.textContent)`, 'depois de desmarcar devia oferecer marcar');
  await dormir(200);
  assert.deepEqual(posts(/\/revisada$/).map((p) => p.corpo), [{ revisada: false }]);
  assert.equal(mock.sessoes.get('s5').revisadaEm, undefined);
  await clicar('.dt-btn', /^\s*Marcar como revisada/);
  await exigir(`/Desmarcar como revisada/.test(${Q('.dt-btn')}.textContent)`, 'depois de marcar devia oferecer desmarcar');
  await dormir(200);
  assert.deepEqual(posts(/\/revisada$/).map((p) => p.corpo).at(-1), { revisada: true });
  assert.ok(mock.sessoes.get('s5').revisadaEm > 0);
  // s4 está trabalhando: não oferece revisada
  await abrirDetalhe('s4');
  assert.equal(await avaliar(`${QA('.dt-btn')}.some((b) => !b.hidden && /revisada/.test(b.textContent))`), false, 'sessão trabalhando não tem revisada');
  void rotuloRev;
});

test('detalhe: encerrar pede confirmação, nunca manda `forcar`; ocupada recusa; depois dá para retomar', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  tolerando++;
  try {
    // s4 está trabalhando e com tarefas: o mock responde 409 ocupada e o app avisa
    limparLog();
    await abrirDetalhe('s4');
    assert.equal(await avaliar(btnVis(/Retomar/)), false, 'viva: sem Retomar');
    await clicar('.btn.perigo.dt-btn', /Encerrar instância/);
    await folhaAberta();
    assert.match(await textoDe('.folha'), /Encerrar a instância\?/);
    // cancelar não manda nada
    await folhaBtn(/^Cancelar$/);
    await folhaSumiu();
    assert.equal(posts(/\/encerrar$/).length, 0, 'cancelar não envia POST');
    await clicar('.btn.perigo.dt-btn', /Encerrar instância/);
    await folhaAberta();
    await folhaBtn(/^Encerrar$/);
    await folhaSumiu();
    await exigir(`/segundo plano|respondendo/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden`, 'o 409 ocupada devia virar aviso');
    let envios = posts(/\/sessao\/s4\/encerrar$/);
    assert.equal(envios.length, 1);
    assert.deepEqual(envios[0].corpo, {}, 'o corpo do encerrar não leva `forcar`');
    assert.equal(await avaliar(`${Q('.btn.perigo.dt-btn')}.disabled`), false, 'o botão volta depois do erro');
    assert.equal(mock.sessoes.get('s4').controle.processo, 'vivo');

    // s5 (concluída, sem tarefas) encerra de verdade e passa a oferecer Retomar
    limparLog();
    await abrirDetalhe('s5');
    await clicar('.btn.perigo.dt-btn', /Encerrar instância/);
    await folhaAberta();
    await folhaBtn(/^Encerrar$/);
    await folhaSumiu();
    await exigir(btnVis(/Retomar/) + ' && !' + btnVis(/Encerrar instância/), 'depois de encerrar devia aparecer Retomar', 6000);
    envios = posts(/\/sessao\/s5\/encerrar$/);
    assert.equal(envios.length, 1);
    assert.deepEqual(envios[0].corpo, {});
    assert.equal(mock.sessoes.get('s5').controle.processo, 'dormindo');

    // retomar
    await clicar('.dt-btn', /Retomar/);
    await exigir(btnVis(/Encerrar instância/), 'depois de retomar devia voltar o Encerrar', 6000);
    assert.deepEqual(posts(/\/sessao\/s5\/retomar$/).map((p) => p.corpo), [{}]);
    assert.equal(mock.sessoes.get('s5').controle.processo, 'vivo');

    // s6 já nasce dormindo: oferece Retomar e não Encerrar
    await abrirDetalhe('s6');
    assert.equal(await avaliar(btnVis(/Retomar/)), true);
    assert.equal(await avaliar(btnVis(/Encerrar instância/)), false);
  } finally { tolerando--; }
});

test('detalhe: sessão que sumiu mostra o aviso e o botão Voltar', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  await irPara('#s=nao-existe/detalhe');
  await noTopo('detalhe');
  await exigir(`!${Q('.dt-vazio')}.hidden && /não está mais no Orbit/.test(${Q('.dt-vazio')}.textContent)`, 'sessão inexistente devia mostrar o aviso');
  assert.equal(await avaliar(`${Q('.dt-conteudo')}.hidden`), true);
  await irPara('#inicio');
  await noTopo('inicio');
});

// ═════════════════════════════ 2. nova instância ═════════════════════════════
const escolher = (sel, valor) => avaliar(`(() => { const s = ${Q(sel)}; s.value = ${JSON.stringify(valor)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const digitar = (sel, texto) => avaliar(`(() => { const c = ${Q(sel)}; c.value = ${JSON.stringify(texto)}; c.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
async function abrirNova() {
  if ((await rota()).nome !== 'inicio') { await irPara('#inicio'); await noTopo('inicio'); }
  await irPara('#nova');
  await noTopo('nova');
}

for (const [w, h] of [[390, 844], [320, 568]]) {
  test(`nova (${w}×${h}): campos, esforço por modelo e POST só com as chaves permitidas`, async () => {
    await viewport(w, h);
    await avaliar('OM.folha.fecharTodas()');
    limparLog();
    mock.sessoes.delete('s7');
    await abrirNova();
    await exigir(`!${Q('.nv-form')}.hidden`, 'o formulário devia aparecer (criar instâncias ligado)', 6000);
    assert.equal(await avaliar(`${Q('.nv-aviso')}.hidden`), true, 'sem aviso quando ligado');
    assert.deepEqual(await avaliar(`${QA('select[aria-label=Projeto] option')}.map((o) => o.textContent)`), ['Orbit', 'Loja Online']);
    assert.deepEqual(await avaliar(`${QA('select[aria-label=Modelo] option')}.map((o) => o.value)`), ['default', 'sonnet', 'haiku']);
    // esforço: Padrão + os do modelo; haiku não tem esforços (a seção some)
    assert.deepEqual(await avaliar(`${QA('.nv-esf button')}.map((b) => b.textContent)`), ['Padrão', 'Baixo', 'Médio', 'Alto']);
    await escolher('select[aria-label=Modelo]', 'haiku');
    assert.equal(await avaliar(`${Q('.nv-esf')}.closest('.nv-sec').hidden`), true, 'haiku sem esforços');
    await escolher('select[aria-label=Modelo]', 'sonnet');
    assert.equal(await avaliar(`${Q('.nv-esf')}.closest('.nv-sec').hidden`), false);
    // modo de permissão: padrão Auto
    assert.equal(await avaliar(`${Q('.nv-modo[aria-checked=true]')}.dataset.v`), 'auto');
    assert.equal(await avaliar(`${QA('.nv-modo')}.map((b) => b.dataset.v).join()`), 'default,acceptEdits,plan,auto', 'sem "sem permissões" no celular');
    assert.equal(await semRolagemLateral(), true, 'sem rolagem lateral');

    await escolher('select[aria-label=Projeto]', LOJA);
    await clicar('.nv-esf button', /^Médio$/);
    assert.equal(await avaliar(`${Q('.nv-esf button[aria-pressed=true]')}.textContent`), 'Médio');
    await clicar('.nv-modo', /Planejar/);
    assert.equal(await avaliar(`${Q('.nv-modo[aria-checked=true]')}.dataset.v`), 'plan');
    await digitar('input[aria-label="Nome da instância"]', '  Minha   nova  ');
    await digitar('.nv .cp-texto, .nv-slot .cp-texto', 'Faça o X');
    if (w === 320) await foto('nova-320');
    await clicar('button.nv-criar');
    await exigir(`location.hash === '#s=s7'`, 'criar devia levar para #s=s7', 6000);
    const envios = posts(/^\/instancias$/);
    assert.equal(envios.length, 1, 'um único POST /instancias');
    assert.deepEqual(envios[0].corpo, { pasta: LOJA, cwd: LOJA, modelo: 'sonnet', esforco: 'medium', permissao: 'plan', nome: 'Minha nova', texto: 'Faça o X' });
    assert.ok(Object.keys(envios[0].corpo).every((k) => ['pasta', 'cwd', 'modelo', 'esforco', 'permissao', 'nome', 'texto', 'imagens'].includes(k)), 'só chaves permitidas');
    await exigir(`/Instância criada/.test(document.getElementById('toast').textContent)`, 'toast de sucesso');
    assert.ok(mock.sessoes.has('s7'));
    // o projeto escolhido é lembrado para a próxima vez
    assert.equal(await avaliar(`localStorage.getItem('orbit-m-nova-pasta')`), LOJA);
  });
}

test('nova: barra no começo fora da lista é recusada na tela; só com texto o POST não leva nome, esforço nem imagens', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  tolerando++;
  try {
    limparLog();
    mock.sessoes.delete('s7');
    await abrirNova();
    await exigir(`!${Q('.nv-form')}.hidden`, 'formulário', 6000);
    await digitar('.nv-slot .cp-texto', '/rm-tudo agora');
    await clicar('button.nv-criar');
    await exigir(`!!${Q('.nv-erro:not([hidden])')} && /comando com barra/.test(${Q('.nv-erro:not([hidden])')}.textContent)`, 'devia mostrar que o comando não é permitido', 6000);
    assert.equal((await rota()).nome, 'nova', 'continua na tela');
    assert.equal(await avaliar(`${Q('button.nv-criar')}.disabled`), false, 'o botão volta');
    assert.equal(mock.sessoes.has('s7'), false);
    await digitar('.nv-slot .cp-texto', 'oi');
    await clicar('button.nv-criar');
    await exigir(`location.hash === '#s=s7'`, 'texto simples cria', 6000);
    const envios = posts(/^\/instancias$/);
    assert.equal(envios.length, 2);
    assert.equal(envios[0].corpo.texto, '/rm-tudo agora');
    assert.deepEqual(Object.keys(envios[1].corpo).sort(), ['cwd', 'modelo', 'pasta', 'permissao', 'texto'], 'sem nome, esforço nem imagens: ' + JSON.stringify(envios[1].corpo));
    assert.equal(envios[1].corpo.permissao, 'auto');
  } finally { tolerando--; }
});

// BUG do app (ver o progresso): o CONTRATO diz que nome e 1ª mensagem são opcionais, mas o composer ignora o clique com o texto vazio
test('nova: criar sem nenhuma mensagem funciona (a 1ª mensagem é opcional)', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  limparLog();
  mock.sessoes.delete('s7');
  await abrirNova();
  await exigir(`!${Q('.nv-form')}.hidden`, 'formulário', 6000);
  await clicar('button.nv-criar');
  await exigir(`location.hash === '#s=s7'`, 'criar sem mensagem devia criar e abrir a sessão (nada aconteceu)', 4000);
  const envios = posts(/^\/instancias$/);
  assert.equal(envios.length, 1);
  assert.deepEqual(Object.keys(envios[0].corpo).sort(), ['cwd', 'modelo', 'pasta', 'permissao']);
});

test('nova: com a criação desligada nas Configurações a tela mostra o aviso e não lista projetos', async () => {
  await viewport(390, 844);
  mock.sessoes.delete('s7');
  mock.estado.criarInstancias = false;
  limparLog();
  const antes = mock.estado.chamadasProjetos || 0;
  try {
    await abrirPagina('#nova');
    await exigir(`OM.estado.eu && OM.rotas.atual().nome === 'nova' && !${Q('.nv-aviso')}.hidden`, 'o aviso de criação desligada devia aparecer', 8000);
    assert.match(await textoDe('.nv-aviso'), /Criar instâncias pelo celular está desligado nas Configurações do Orbit no PC/);
    assert.equal(await avaliar(`${Q('.nv-form')}.hidden`), true, 'formulário escondido');
    assert.equal(await avaliar(`OM.estado.eu.opcoes.criarInstancias`), false);
    assert.equal((mock.estado.chamadasProjetos || 0), antes, 'não pede a lista de projetos quando desligado');
    assert.equal(posts(/^\/instancias$/).length, 0, 'nenhum POST /instancias');
  } finally { mock.estado.criarInstancias = true; }
  // religado: ao reabrir, volta o formulário
  await abrirPagina('#nova');
  await exigir(`!${Q('.nv-form')}.hidden && ${Q('.nv-aviso')}.hidden`, 'religado, o formulário volta', 8000);
  await irPara('#inicio');
  await noTopo('inicio');
});

// ═════════════════════════════ 3. Mais (navegação) ═════════════════════════════
async function abrirMais() {
  if ((await rota()).nome !== 'inicio') { await irPara('#inicio'); await noTopo('inicio'); }
  await irPara('#mais');
  await noTopo('mais');
  await exigir(`${QA('.mais-linha[data-destino]')}.length === 6`, 'as 6 linhas do Mais', 4000);
}
async function abrirSub(sub) {
  if ((await rota()).nome !== 'inicio') { await irPara('#inicio'); await noTopo('inicio'); }
  await irPara('#mais/' + sub);
  await noTopo(sub);
}

test('mais: as linhas navegam para uso, ideias, histórico, notificações e este aparelho; valores ao vivo', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  mock.estado.nomeAparelho = 'iPhone da Ana';
  await abrirPagina('#inicio');
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.eu`, 'app vivo', 10000);
  await abrirMais();
  const rotulos = await avaliar(`${QA('.mais-linha[data-destino] .mais-rot')}.map((e) => e.textContent)`);
  assert.deepEqual(rotulos, ['Uso do plano', 'Ideias', 'Histórico de avisos', 'Grafo do brain', 'Notificações', 'Este aparelho']);
  assert.equal(await semRolagemLateral(), true);
  const valor = (dest) => avaliar(`(${QA('.mais-linha[data-destino]')}.find((l) => l.dataset.destino === ${JSON.stringify(dest)}).querySelector('.mais-valor') || {}).textContent`);
  await exigir(`${QA('.mais-linha[data-destino]')}.find((l) => l.dataset.destino === '#mais/uso').querySelector('.mais-valor').textContent === '42%'`, 'valor do Uso 42%');
  assert.equal(await valor('#mais/aparelho'), 'iPhone da Ana', 'valor do aparelho = nome');
  // sem Não perturbe e no navegador (não instalado), a linha das notificações oferece instalar
  await exigir(`${QA('.mais-linha[data-destino]')}.find((l) => l.dataset.destino === '#mais/notificacoes').querySelector('.mais-valor').textContent === 'Instalar'`, 'Notificações = Instalar no headless');
  for (const [dest, nome] of [['#mais/uso', 'uso'], ['#mais/ideias', 'ideias'], ['#mais/historico', 'historico'], ['#mais/notificacoes', 'notificacoes'], ['#mais/aparelho', 'aparelho']]) {
    await abrirMais();
    await avaliar(`${QA('.mais-linha[data-destino]')}.find((l) => l.dataset.destino === ${JSON.stringify(dest)}).click()`);
    await noTopo(nome);
    assert.equal(await avaliar('location.hash'), dest);
  }
  // Não perturbe ligado no PC: a linha mostra "Não perturbe" ao voltar para a lista
  mock.estado.naoPerturbe = { ativo: true, agendado: false, inicio: '22:00', fim: '07:00' };
  try {
    await abrirMais();
    await exigir(`${QA('.mais-linha[data-destino]')}.find((l) => l.dataset.destino === '#mais/notificacoes').querySelector('.mais-valor').textContent === 'Não perturbe'`, 'valor Não perturbe');
  } finally { mock.estado.naoPerturbe = { ativo: false, agendado: false, inicio: '22:00', fim: '07:00' }; }
  await irPara('#inicio');
  await noTopo('inicio');
});

// ═════════════════════════════ 4. Notificações ═════════════════════════════
const NP_PADRAO = { ativo: false, agendado: false, inicio: '22:00', fim: '07:00' };
const chipPush = () => avaliar(`(${Q('.mais-linha-info .mais-chip')} || {}).textContent`);
const marcado = (sel) => avaliar(`${Q(sel)}.checked`);
const mudarChave = (sel) => avaliar(`${Q(sel)}.click()`);
const mudarHora = (sel, v) => avaliar(`(() => { const c = ${Q(sel)}; c.value = ${JSON.stringify(v)}; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const aguardarPosts = async (re, n) => { const fim = Date.now() + 4000; while (posts(re).length < n && Date.now() < fim) await dormir(50); await dormir(150); };

test('notificações: push no headless precisa instalar (3 passos); avisos e Não perturbe gravam só o que mudou', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  mock.estado.naoPerturbe = { ...NP_PADRAO };
  mock.estado.notificar = { precisa: true, terminou: false };
  limparLog();
  await abrirSub('notificacoes');
  await exigir(`!${Q('.mais-pilha')}.hidden`, 'o corpo das notificações devia aparecer', 6000);
  assert.equal(await semRolagemLateral(), true);
  // push: sem instalar na Tela de Início
  assert.equal(await chipPush(), 'Precisa instalar');
  assert.equal(await avaliar(`${QA('.mais-passos li')}.length`), 3);
  assert.match(await textoDe('.mais-passos'), /Compartilhar[\s\S]*Adicionar à Tela de Início[\s\S]*pelo ícone novo/);
  assert.equal(await avaliar(`${QA('.mais-acoes button')}.length`), 0, 'sem botão de ativar quando não instalado');

  // avisar: reflete o PC e grava só a chave tocada
  assert.equal(await marcado('#mais-n-precisa'), true);
  assert.equal(await marcado('#mais-n-terminou'), false);
  await mudarChave('#mais-n-terminou');
  await aguardarPosts(/^\/remoto\/notificar$/, 1);
  assert.deepEqual(posts(/^\/remoto\/notificar$/).map((p) => p.corpo), [{ terminou: true }]);
  assert.equal(mock.estado.notificar.terminou, true);
  await mudarChave('#mais-n-precisa');
  await aguardarPosts(/^\/remoto\/notificar$/, 2);
  assert.deepEqual(posts(/^\/remoto\/notificar$/).at(-1).corpo, { precisa: false });
  assert.deepEqual(mock.estado.notificar, { precisa: false, terminou: true });

  // Não perturbe: horas travadas até agendar
  assert.equal(await avaliar(`${Q('#mais-np-ini')}.disabled && ${Q('#mais-np-fim')}.disabled`), true, 'horas desabilitadas sem agendamento');
  assert.equal(await avaliar(`${Q('#mais-np-ini')}.value`), '22:00');
  assert.equal(await avaliar(`${Q('#mais-np-fim')}.value`), '07:00');
  await mudarChave('#mais-np');
  await aguardarPosts(/^\/remoto\/nao-perturbe$/, 1);
  assert.deepEqual(posts(/^\/remoto\/nao-perturbe$/).at(-1).corpo, { ativo: true, agendado: false, inicio: '22:00', fim: '07:00' });
  await mudarChave('#mais-np-ag');
  await aguardarPosts(/^\/remoto\/nao-perturbe$/, 2);
  assert.deepEqual(posts(/^\/remoto\/nao-perturbe$/).at(-1).corpo, { ativo: true, agendado: true, inicio: '22:00', fim: '07:00' });
  await exigir(`!${Q('#mais-np-ini')}.disabled && !${Q('#mais-np-fim')}.disabled`, 'horas liberadas com agendamento');
  assert.deepEqual(mock.estado.naoPerturbe, { ativo: true, agendado: true, inicio: '22:00', fim: '07:00' });

  // início = fim é recusado no cliente: aviso, sem POST, o campo volta
  const antes = posts(/^\/remoto\/nao-perturbe$/).length;
  await mudarHora('#mais-np-ini', '07:00');
  await exigir(`!${Q('.mais-erro')}.hidden && ${Q('.mais-erro')}.textContent === 'Início e fim não podem ser iguais.'`, 'aviso de horário igual');
  assert.equal(await avaliar(`${Q('#mais-np-ini')}.value`), '22:00', 'o campo volta ao valor anterior');
  await mudarHora('#mais-np-fim', '22:00');
  await exigir(`${Q('#mais-np-fim')}.value === '07:00'`, 'o fim também volta');
  await dormir(300);
  assert.equal(posts(/^\/remoto\/nao-perturbe$/).length, antes, 'nenhum POST com horário igual');
  // horário válido: manda os 4 campos e limpa o aviso
  await mudarHora('#mais-np-ini', '23:30');
  await aguardarPosts(/^\/remoto\/nao-perturbe$/, antes + 1);
  assert.deepEqual(posts(/^\/remoto\/nao-perturbe$/).at(-1).corpo, { ativo: true, agendado: true, inicio: '23:30', fim: '07:00' });
  assert.equal(await avaliar(`${Q('.mais-erro')}.hidden`), true, 'aviso some com horário válido');
  assert.deepEqual(mock.estado.naoPerturbe, { ativo: true, agendado: true, inicio: '23:30', fim: '07:00' });
  // volta ao padrão no PC
  mock.estado.naoPerturbe = { ...NP_PADRAO };
  mock.estado.notificar = { precisa: true, terminou: false };
});

// O headless não instala o PWA nem tem push de verdade: a leitura do estado (OM.push.situacao, do núcleo) é trocada na página
// por uma que devolve cada situação; o que o teste confere é o que a tela desenha para ela.
test('notificações: os outros estados do push (sem suporte, bloqueadas, desligadas, ligadas)', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  const situacao = async (sit) => {
    await avaliar(`(() => { OM.push.situacao = async () => (${JSON.stringify(sit)}); return true; })()`);
    await irPara('#inicio'); await noTopo('inicio');
    await abrirSub('notificacoes');
    await exigir(`!${Q('.mais-pilha')}.hidden`, 'corpo das notificações', 6000);
    await exigir(`(${Q('.mais-linha-info .mais-chip')} || {}).textContent !== 'Indisponível'`, 'estado lido', 4000);
  };
  try {
    await situacao({ instalado: true, suportado: false, permissao: 'default', ativa: false });
    assert.equal(await chipPush(), 'Sem suporte');
    assert.equal(await avaliar(`${Q('.mais-passos')}.hidden`), true);
    await situacao({ instalado: true, suportado: true, permissao: 'denied', ativa: false });
    assert.equal(await chipPush(), 'Bloqueadas');
    assert.match(await textoDe('.mais-nota'), /bloqueou as notificações do Orbit/);
    assert.equal(await avaliar(`${QA('.mais-acoes button')}.length`), 0);
    await situacao({ instalado: true, suportado: true, permissao: 'default', ativa: false });
    assert.equal(await chipPush(), 'Desligadas');
    assert.deepEqual(await avaliar(`${QA('.mais-acoes button')}.map((b) => b.textContent)`), ['Ativar notificações']);
    await situacao({ instalado: true, suportado: true, permissao: 'granted', ativa: true });
    assert.equal(await chipPush(), 'Ligadas');
    assert.deepEqual(await avaliar(`${QA('.mais-acoes button')}.map((b) => b.textContent)`), ['Enviar teste', 'Desativar']);
    // Desativar pede confirmação; cancelar não chama o push
    await avaliar(`(() => { window.__desativou = 0; OM.push.desativar = async () => { window.__desativou++; }; return true; })()`);
    await clicar('.mais-acoes button', /^Desativar$/);
    await folhaAberta();
    assert.match(await textoDe('.folha'), /Desativar notificações\?/);
    await folhaBtn(/^Cancelar$/);
    await folhaSumiu();
    assert.equal(await avaliar('window.__desativou'), 0, 'cancelar não desativa');
    await clicar('.mais-acoes button', /^Desativar$/);
    await folhaAberta();
    await folhaBtn(/^Desativar$/);
    await folhaSumiu();
    await exigir('window.__desativou === 1', 'confirmar desativa');
  } finally {
    await abrirPagina('#inicio');
    await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo'`, 'app vivo de novo', 10000);
  }
});

// ═════════════════════════════ 5. Este aparelho ═════════════════════════════
test('aparelho: nome, "Pareado em", conexão, Sair com confirmação (cancelar não apaga; sair limpa tudo e volta ao parear)', async () => {
  await viewport(390, 844);
  mock.estado.nomeAparelho = 'iPhone da Ana';
  await abrirPagina('#inicio');
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.eu`, 'app vivo', 10000);
  await avaliar(`caches.open('orbit-casca-m-v1').then(() => true)`);
  await abrirSub('aparelho');
  assert.equal(await textoDe('#mais-ap-nome'), 'iPhone da Ana');
  const esperada = await avaliar(`new Date(Date.now() - 3 * 86400000).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })`);
  const desde = await textoDe('#mais-ap-desde');
  assert.ok(desde.startsWith(esperada + ', '), `"Pareado em" devia ser ${esperada}, hh:mm; veio: ${desde}`);
  assert.match(desde, /\d{2}:\d{2}$/);
  assert.equal(await avaliar(`${Q('#mais-ap-desde')}.closest('.mais-linha').hidden`), false);
  assert.match(await avaliar(`${Q('#mais-ap-desde')}.closest('.mais-linha').textContent`), /^Pareado em/);
  assert.equal(await textoDe('#mais-ap-inst'), 'Não, aberto no navegador');
  assert.equal(await textoDe('#mais-ap-conexao'), 'Conectado');
  await exigir(`${Q('#mais-ap-versao')}.textContent === 'v1'`, 'a versão vem do cache da casca');
  assert.equal(await semRolagemLateral(), true);
  assert.equal(await avaliar(`${Q('#mais-ap-sair')}.getBoundingClientRect().height >= 44`), true, 'botão Sair com 44 px');

  await avaliar(`(localStorage.setItem('x', '1'), sessionStorage.setItem('x', '1'), true)`);
  limparLog();
  // cancelar: nada é apagado e nada vai ao PC
  await avaliar(`${Q('#mais-ap-sair')}.click()`);
  await folhaAberta();
  assert.match(await textoDe('.folha'), /Sair deste aparelho\?/);
  await folhaBtn(/^Cancelar$/);
  await folhaSumiu();
  await dormir(300);
  assert.equal(posts(/^\/remoto\/sair$/).length, 0, 'cancelar não sai');
  assert.equal(await avaliar(`document.body.dataset.modo`), 'app');
  assert.equal(await avaliar(`localStorage.getItem('x') + sessionStorage.getItem('x')`), '11', 'cancelar não apaga nada');
  assert.equal(await avaliar(`caches.keys().then((k) => k.includes('orbit-casca-m-v1'))`), true);

  // sair: POST, modo parear, tudo apagado
  await avaliar(`${Q('#mais-ap-sair')}.click()`);
  await folhaAberta();
  await folhaBtn(/^Sair$/);
  await exigir(`document.body.dataset.modo === 'parear'`, 'sair devia levar ao modo parear', 6000);
  assert.equal(posts(/^\/remoto\/sair$/).length, 1);
  assert.equal(await avaliar('OM.estado.motivoParear'), 'saiu');
  assert.equal(await avaliar('localStorage.length === 0 && sessionStorage.length === 0'), true, 'localStorage e sessionStorage vazios');
  await exigir(`caches.keys().then((k) => !k.includes('orbit-casca-m-v1'))`, 'o cache da casca devia ser apagado', 4000);
  assert.equal(mock.estado.tokens.size, 0, 'o PC esqueceu o aparelho');
  // pareia de novo para as próximas telas
  await parear();
  await exigir(`OM.rotas.atual().nome === 'inicio'`, 'de volta ao início');
});

// ═════════════════════════════ 6. Uso do plano ═════════════════════════════
const usoNormal = () => ({ cincoHoras: { pct: 42, renova: Date.now() + 2.5 * 3600e3 }, semanal: { pct: 27, renova: Date.now() + 3 * 86400e3 }, atualizado: Date.now() - 2 * 60e3 });
const valoresUso = () => avaliar(`${QA('.uso-cartao .uso-val')}.map((e) => e.textContent)`);

test('uso: dois cartões, atualizar agora, bloqueios 409, perto do limite e limite atingido', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  await abrirPagina('#inicio');
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.eu`, 'app vivo', 10000);
  mock.estado.uso = usoNormal();
  mock.estado.usoBloqueio = null;
  await abrirSub('uso');
  await exigir(`${QA('.uso-cartao .uso-val')}.length === 2 && ${Q('.uso-real')} && !${Q('.uso-real')}.hidden`, 'dois cartões de uso', 6000);
  assert.deepEqual(await valoresUso(), ['42%', '27%']);
  assert.deepEqual(await avaliar(`${QA('.uso-cartao .uso-nome span')}.map((e) => e.textContent)`), ['Sessão', 'Semana']);
  assert.deepEqual(await avaliar(`${QA('.uso-trilho')}.map((e) => e.getAttribute('aria-valuenow'))`), ['42', '27']);
  assert.deepEqual(await avaliar(`${QA('.uso-cartao .uso-pista i')}.map((e) => e.style.getPropertyValue('--p'))`), ['0.42', '0.27']);
  assert.match(await textoDe('.uso-ren'), /^renova em /);
  assert.match(await textoDe('.uso-lido'), /^Lido há \d+ min/);
  assert.equal(await avaliar(`${QA('.uso-aviso')}.every((e) => e.hidden)`), true, 'nenhum aviso com tudo normal');
  assert.equal(await semRolagemLateral(), true);

  // atualizar agora: um POST, toast e leitura nova
  limparLog();
  await avaliar(`${Q('.uso-atualizar')}.click()`);
  await exigir(`/Uso atualizado/.test(document.getElementById('toast').textContent)`, 'toast "Uso atualizado"', 5000);
  assert.equal(posts(/^\/uso\/atualizar$/).length, 1);
  await exigir(`/^Lido agora/.test(${Q('.uso-lido')}.textContent)`, 'a leitura nova aparece como "Lido agora"', 4000);
  assert.equal(await avaliar(`${Q('.uso-atualizar')}.disabled`), false, 'botão volta');

  // 409: há instância trabalhando
  tolerando++;
  try {
    await postMock('/_mock/uso-bloqueio', { motivo: 'rodando' });
    await avaliar(`${Q('.uso-atualizar')}.click()`);
    await exigir(`!${Q('.uso-aviso[data-tipo=bloqueio]')}.hidden && /Leitura adiada/.test(${Q('.uso-aviso[data-tipo=bloqueio]')}.textContent)`, 'aviso de leitura adiada', 5000);
    await exigir(`/Leitura adiada: há uma instância trabalhando/.test(document.getElementById('toast').textContent)`, 'toast do bloqueio');
    // 409: já está lendo
    await postMock('/_mock/uso-bloqueio', { motivo: 'lendo' });
    await avaliar(`${Q('.uso-atualizar')}.click()`);
    await exigir(`/Já está lendo o uso do plano/.test(${Q('.uso-aviso[data-tipo=bloqueio]')}.textContent)`, 'aviso de que já está lendo', 5000);
    // o resultado chega pelo fluxo (evento `uso`): o aviso some sozinho
    await postMock('/_mock/uso-bloqueio', { motivo: null });
    await postMock('/_mock/uso', usoNormal());
    await exigir(`${Q('.uso-aviso[data-tipo=bloqueio]')}.hidden`, 'o aviso some quando o uso chega pelo fluxo', 5000);
  } finally { await postMock('/_mock/uso-bloqueio', { motivo: null }); tolerando--; }

  // perto do limite (80%+) e limite atingido (100%)
  await postMock('/_mock/uso', { ...usoNormal(), cincoHoras: { pct: 85, renova: Date.now() + 3600e3 } });
  await exigir(`${QA('.uso-cartao')}[0].classList.contains('perto') && !${QA('.uso-cartao')}[0].classList.contains('limite')`, 'cartão "perto" com 85%', 4000);
  await postMock('/_mock/uso', { ...usoNormal(), cincoHoras: { pct: 100, renova: Date.now() + 3600e3 + 30e3 } });
  await exigir(`!${Q('.uso-aviso[data-tipo=limite]')}.hidden`, 'aviso de limite atingido', 4000);
  assert.match(await textoDe('.uso-aviso[data-tipo=limite]'), /Limite da sessão atingido[\s\S]*Libera em 1 h/);
  assert.equal(await avaliar(`${QA('.uso-cartao')}[0].classList.contains('limite')`), true);
  assert.deepEqual(await valoresUso(), ['100%', '27%']);
  assert.equal(await avaliar(`${Q('.uso-prev')}.hidden`), true, 'sem previsão quando a sessão já bateu o limite');
  await postMock('/_mock/uso', usoNormal());
  await exigir(`${Q('.uso-aviso[data-tipo=limite]')}.hidden`, 'o aviso de limite some quando o uso cai', 4000);

  await irPara('#inicio');
  await noTopo('inicio');
});

// BUG do app (ver o progresso): a tela de uso só repinta com o evento `uso`, `estado` ou o relógio de 30 s; a mudança de conexão
// (evento `conexao`) não repinta, então o aviso "PC desconectado" demora até 30 s depois da faixa global.
test('uso: PC desconectado mostra o aviso junto com a conexão cair e ele some quando o PC volta', async () => {
  await viewport(390, 844);
  mock.estado.uso = usoNormal();
  await abrirSub('uso');
  await exigir(`${QA('.uso-cartao .uso-val')}.length === 2 && ${Q('.uso-real')} && !${Q('.uso-real')}.hidden`, 'dois cartões de uso', 6000);
  let demora = -1, apareceu = false;
  tolerando++;
  try {
    await postMock('/_mock/cair');
    await exigir(`OM.estado.conexao === 'pc'`, 'a conexão devia cair para "pc"', 14000);
    const t0 = Date.now();
    apareceu = await esperar(`!${Q('.uso-aviso[data-tipo=pc]')}.hidden`, 36000);
    demora = Date.now() - t0;
    if (apareceu) {
      assert.match(await textoDe('.uso-aviso[data-tipo=pc]'), /PC desconectado[\s\S]*Mostrando a última leitura recebida/);
      assert.deepEqual(await valoresUso(), ['42%', '27%'], 'a última leitura continua na tela');
    }
    await postMock('/_mock/voltar');
    await exigir(`OM.estado.conexao === 'vivo'`, 'a conexão devia voltar', 30000);
    await exigir(`${Q('.uso-aviso[data-tipo=pc]')}.hidden`, 'o aviso some quando o PC volta', 36000);
  } finally { await postMock('/_mock/voltar'); tolerando--; }
  assert.ok(apareceu && demora <= 3000, `o aviso de PC desconectado devia aparecer em até 3 s depois da conexão cair (apareceu: ${apareceu}, demorou ${demora} ms)`);
  await irPara('#inicio');
  await noTopo('inicio');
});

test('uso (320×568): cartões sem rolagem lateral', async () => {
  await viewport(320, 568);
  try {
    await abrirSub('uso');
    await exigir(`${QA('.uso-cartao .uso-val')}.length === 2`, 'dois cartões', 5000);
    assert.equal(await semRolagemLateral(), true, 'sem rolagem lateral a 320 px');
    assert.equal(await avaliar(`${QA('.uso-cartao')}.every((c) => c.getBoundingClientRect().right <= innerWidth)`), true);
  } finally { await viewport(390, 844); await irPara('#inicio'); await noTopo('inicio'); }
});

// ═════════════════════════════ 7. Ideias ═════════════════════════════
const itensIdeias = () => avaliar(`${QA('.id-item')}.map((e) => ({ id: e.dataset.id, feita: e.classList.contains('feita'), texto: e.querySelector('.id-texto').textContent, data: e.querySelector('.id-data').textContent }))`);
const cabFeitas = () => textoDe('.id-feitas');
const toastDesfazer = () => exigir(`/Ideia apagada/.test(document.getElementById('toast').textContent) && !!document.querySelector('#toast button')`, 'toast "Ideia apagada" com Desfazer', 4000);
const btnFolha = (re) => `${QA('.folha .btn')}.find((b) => ${re}.test(b.textContent))`;
const esperarPosts = async (re, ms) => { const fim = Date.now() + ms; while (!posts(re).length && Date.now() < fim) await dormir(100); };
// o mock só aplica depois de registrar o POST: espera o estado dele em vez de lê-lo na hora
async function esperarIdeia(id, feita) {
  const fim = Date.now() + 4000;
  while (mock.estado.ideias.find((x) => x.id === id)?.feita !== feita && Date.now() < fim) await dormir(50);
  assert.equal(mock.estado.ideias.find((x) => x.id === id)?.feita, feita);
}
async function apagarIdeia(regexTexto) {
  await clicar('.id-item .id-corpo', regexTexto);
  await folhaAberta();
  await folhaBtn(/^Apagar$/);
  await folhaSumiu();
  await toastDesfazer();
}

test('ideias: lista, criar, editar, marcar feita, apagar com Desfazer e apagar de verdade', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  const original = JSON.parse(JSON.stringify(mock.estado.ideias));
  try {
    limparLog();
    await abrirSub('ideias');
    await exigir(`${QA('.id-item')}.length === 2`, 'duas ideias abertas', 6000);
    let it = await itensIdeias();
    assert.deepEqual(it.map((x) => x.id), ['i-a1b2c3', 'i-d4e5f6']);
    assert.match(it[0].texto, /Trocar o som de aviso/);
    assert.match(it[0].data, /^(hoje|ontem) \d\d:\d\d$/);
    assert.match(it[1].texto, /Mostrar o custo do dia[\s\S]*Só o total/);
    assert.equal(await cabFeitas(), 'Feitas · 1');
    assert.equal(await avaliar(`${Q('.id-cartao-feitas')}.hidden`), true, 'feitas começam recolhidas');
    await clicar('.id-feitas');
    await exigir(`!${Q('.id-cartao-feitas')}.hidden && ${QA('.id-item.feita')}.length === 1`, 'feitas abertas');
    assert.equal(await avaliar(`${Q('.id-feitas')}.getAttribute('aria-expanded')`), 'true');
    assert.equal(await semRolagemLateral(), true);

    // criar: o botão fica desligado sem texto; manda o texto aparado
    await avaliar(`${Q('button[aria-label="Nova ideia"]')}.click()`);
    await folhaAberta();
    assert.match(await textoDe('.folha'), /Nova ideia/);
    assert.equal(await avaliar(`${btnFolha(/^Anotar$/)}.disabled`), true, 'Anotar desligado sem texto');
    await digitar('textarea.id-campo', '   ');
    assert.equal(await avaliar(`${btnFolha(/^Anotar$/)}.disabled`), true, 'só espaços não vale');
    await digitar('textarea.id-campo', '  Ideia da noite  ');
    await folhaBtn(/^Anotar$/);
    await folhaSumiu();
    await exigir(`/Ideia anotada/.test(document.getElementById('toast').textContent)`, 'toast de ideia anotada');
    assert.deepEqual(posts(/^\/ideias\/nova$/).map((p) => p.corpo), [{ texto: 'Ideia da noite' }]);
    await exigir(`${QA('.id-cartao:not(.id-cartao-feitas) .id-item')}.length === 3`, 'três ideias abertas');
    it = await itensIdeias();
    assert.equal(it[0].texto, 'Ideia da noite', 'a mais nova no topo');
    assert.match(it[0].data, /^hoje \d\d:\d\d$/);
    const novaId = it[0].id;
    const sel = `.id-item[data-id="${novaId}"]`;

    // editar: Salvar só liga quando o texto muda
    await clicar('.id-item .id-corpo', /Ideia da noite/);
    await folhaAberta();
    assert.match(await textoDe('.folha'), /Editar ideia/);
    assert.equal(await avaliar(`${Q('textarea.id-campo')}.value`), 'Ideia da noite');
    assert.equal(await avaliar(`${btnFolha(/^Salvar$/)}.disabled`), true, 'Salvar desligado sem mudança');
    await digitar('textarea.id-campo', 'Ideia da manhã');
    await folhaBtn(/^Salvar$/);
    await folhaSumiu();
    assert.deepEqual(posts(/^\/ideias\/editar$/).map((p) => p.corpo), [{ id: novaId, texto: 'Ideia da manhã' }]);
    await exigir(`${QA('.id-texto')}.some((e) => e.textContent === 'Ideia da manhã')`, 'texto editado na lista');

    // marcar feita pelo círculo e reabrir
    await avaliar(`${Q(sel + ' .id-check')}.click()`);
    await exigir(`/Marcada como feita/.test(document.getElementById('toast').textContent)`, 'toast "Marcada como feita"');
    assert.deepEqual(posts(/^\/ideias\/feita$/).at(-1).corpo, { id: novaId, feita: true });
    await esperarIdeia(novaId, true);
    await exigir(`${Q('.id-feitas')}.textContent === 'Feitas · 2'`, 'contador de feitas = 2');
    await avaliar(`${Q('.id-cartao-feitas ' + sel + ' .id-check')}.click()`);
    await exigir(`${Q('.id-feitas')}.textContent === 'Feitas · 1'`, 'reaberta: feitas = 1');
    await esperarIdeia(novaId, false);   // a tela reabre na hora; o POST sai um pouco depois
    assert.deepEqual(posts(/^\/ideias\/feita$/).at(-1).corpo, { id: novaId, feita: false });

    // apagar + Desfazer: sai da lista na hora, volta, e o servidor nunca é chamado
    limparLog();
    await apagarIdeia(/Ideia da manhã/);
    await exigir(`!${QA('.id-texto')}.some((e) => e.textContent === 'Ideia da manhã')`, 'a ideia some da lista na hora');
    assert.equal(posts(/^\/ideias\/apagar$/).length, 0, 'ainda não foi ao servidor');
    await clicar('#toast button', /Desfazer/);
    await exigir(`${QA('.id-texto')}.some((e) => e.textContent === 'Ideia da manhã')`, 'Desfazer devolve a ideia');
    await dormir(5800);
    assert.equal(posts(/^\/ideias\/apagar$/).length, 0, 'desfeita: nunca vai ao servidor');
    assert.ok(mock.estado.ideias.some((x) => x.id === novaId));

    // apagar de verdade: só depois do tempo do Desfazer o POST sai
    await apagarIdeia(/Ideia da manhã/);
    await dormir(3000);
    assert.equal(posts(/^\/ideias\/apagar$/).length, 0, 'ainda dentro dos 5 s do Desfazer');
    await esperarPosts(/^\/ideias\/apagar$/, 5000);
    assert.deepEqual(posts(/^\/ideias\/apagar$/).map((p) => p.corpo), [{ id: novaId }]);
    assert.equal(mock.estado.ideias.some((x) => x.id === novaId), false, 'apagada no PC');

    // apagar e sair da tela: confirma na saída
    limparLog();
    await apagarIdeia(/Trocar o som de aviso/);
    await irPara('#mais');
    await noTopo('mais');
    await esperarPosts(/^\/ideias\/apagar$/, 4000);
    assert.deepEqual(posts(/^\/ideias\/apagar$/).map((p) => p.corpo), [{ id: 'i-a1b2c3' }], 'sair da tela confirma o apagar');
  } finally {
    mock.estado.ideias.splice(0, mock.estado.ideias.length, ...original);
    await irPara('#inicio'); await noTopo('inicio');
  }
});

// ═════════════════════════════ 8. Histórico de avisos ═════════════════════════════
test('histórico: agrupado por dia (Hoje, Ontem, data), tipos, aviso mudo e o toque abre a sessão', async () => {
  await viewport(390, 844);
  await avaliar('OM.folha.fecharTodas()');
  const original = JSON.parse(JSON.stringify(mock.estado.historico));
  try {
    const h1 = mock.estado.historico.find((x) => x.id === 'h1');
    const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
    h1.quando = hoje0.getTime() - 3 * 3600e3;                                   // ontem, de qualquer hora do dia
    mock.estado.historico.push({ ...JSON.parse(JSON.stringify(h1)), id: 'h6', quando: Date.now() - 5 * 86400e3 });   // há 5 dias
    mock.estado.historico.push({ id: 'h7', tipo: 'concluida', quando: Date.now() - 20 * 60e3, notificar: true, sessao: { id: 'zz', titulo: 'Sessão que saiu', projeto: 'Diário', status: 'concluida' } });
    await abrirSub('historico');
    await exigir(`${QA('.hi-item')}.length === 7`, 'sete avisos', 6000);
    const grupos = await avaliar(`${QA('.hi-grupo')}.map((g) => ({ dia: g.querySelector('.hi-dia').textContent, ids: g.querySelectorAll('.hi-item').length }))`);
    assert.equal(grupos.length, 3, 'três dias: ' + JSON.stringify(grupos));
    assert.deepEqual(grupos.map((g) => g.ids), [5, 1, 1]);
    assert.equal(grupos[0].dia, 'Hoje');
    assert.equal(grupos[1].dia, 'Ontem');
    assert.match(grupos[2].dia, /^[A-ZÀ-Ú][a-zà-ú-]+, \d{1,2} de [a-zç]+/, 'o terceiro dia vem por extenso');
    // dentro de Hoje, o mais novo primeiro (h4 2 min, h3 5 min, h2 12 min, h7 20 min, h5 40 min)
    const hoje = await avaliar(`${QA('.hi-grupo')}[0].querySelectorAll('.hi-item').length && [...${QA('.hi-grupo')}[0].querySelectorAll('.hi-item')].map((e) => ({ tipo: e.dataset.tipo, tit: e.querySelector('.hi-tit').textContent, tipoTxt: e.querySelector('.hi-tipo').textContent, mudo: !!e.querySelector('.hi-mudo'), hora: e.querySelector('time').textContent, aria: e.getAttribute('aria-label') }))`);
    assert.deepEqual(hoje.map((x) => x.tipo), ['aguardando', 'aguardando', 'aguardando', 'concluida', 'erro']);
    assert.equal(hoje.filter((x) => x.mudo).length, 1, 'só o aviso que não notificou tem o sino mudo');
    assert.equal(hoje[4].mudo, true, 'o erro h5 não avisou');
    assert.equal(hoje[4].tipoTxt, 'Erro');
    assert.match(hoje[4].tit, /^Agente Rodar os testes de unidade/);
    assert.equal(hoje[0].tipoTxt, 'Aguardando você');
    assert.ok(hoje.every((x) => /^\d{2}:\d{2}$/.test(x.hora) && x.aria.includes(x.tipoTxt)), 'hora e rótulo de acessibilidade: ' + JSON.stringify(hoje));
    assert.match(await avaliar(`${QA('.hi-item')}.find((e) => e.dataset.tipo === 'erro').querySelector('.hi-sub').textContent`), /do time de .+/, 'agente mostra o time da sessão');
    assert.match(await avaliar(`${QA('.hi-item')}.find((e) => e.dataset.tipo === 'erro').querySelector('.hi-det').textContent`), /Falha ao rodar os testes/);
    assert.equal(await semRolagemLateral(), true);
    assert.equal(await avaliar(`${QA('.hi-item')}.every((e) => e.getBoundingClientRect().height >= 44)`), true, 'alvos de toque de 44 px');

    // toque abre a sessão
    await avaliar(`${QA('.hi-item')}.find((e) => /Plano pronto para aprovar/.test(e.textContent)).click()`);
    await exigir(`location.hash.startsWith('#s=s3')`, 'o toque devia abrir a sessão s3', 4000);
    assert.equal(await avaliar('location.hash'), '#s=s3');
    await avaliar('history.back()');
    await noTopo('historico');
    await exigir(`${QA('.hi-item')}.length === 7`, 'a lista volta inteira ao voltar da sessão', 6000);
    await dormir(300);
    // sessão que já saiu da lista: toast e continua na tela
    await avaliar(`${QA('.hi-item')}.find((e) => /Sessão que saiu/.test(e.textContent)).click()`);
    await exigir(`/Essa sessão já saiu da lista/.test(document.getElementById('toast').textContent)`, 'toast de sessão que saiu');
    assert.equal((await rota()).nome, 'historico');
  } finally {
    mock.estado.historico.splice(0, mock.estado.historico.length, ...original);
    await irPara('#inicio'); await noTopo('inicio');
  }
});

test('histórico (320×568): sem rolagem lateral', async () => {
  await viewport(320, 568);
  try {
    await abrirSub('historico');
    await exigir(`${QA('.hi-item')}.length === 5`, 'cinco avisos', 6000);
    assert.equal(await semRolagemLateral(), true);
    assert.equal(await avaliar(`${QA('.hi-item')}.every((e) => e.getBoundingClientRect().right <= innerWidth + 0.5)`), true);
  } finally { await viewport(390, 844); await irPara('#inicio'); await noTopo('inicio'); }
});

test('ideias (320×568): sem rolagem lateral, com a folha de nova ideia aberta também', async () => {
  await viewport(320, 568);
  try {
    await abrirSub('ideias');
    await exigir(`${QA('.id-item')}.length >= 2`, 'ideias carregadas', 6000);
    assert.equal(await semRolagemLateral(), true);
    await avaliar(`${Q('button[aria-label="Nova ideia"]')}.click()`);
    await folhaAberta();
    assert.equal(await semRolagemLateral(), true);
    assert.equal(await avaliar(`${Q('.folha')}.getBoundingClientRect().right <= innerWidth`), true);
    await folhaBtn(/^Cancelar$/);
    await folhaSumiu();
  } finally { await avaliar('OM.folha.fecharTodas()'); await viewport(390, 844); await irPara('#inicio'); await noTopo('inicio'); }
});

// ═════════════════════════════ 7. Parear pela interface ═════════════════════════════
// Cada caso começa sem aparelho pareado (o PC esquece o token) e sem pedido nem bloqueio; a página recarrega e cai no modo parear.
async function iniciarParear() {
  mock.estado.tokens.clear(); mock.estado.pedido = null; mock.estado.bloqueadoAte = 0;
  tolerando++;
  try {
    await abrirPagina();
    await exigir(`document.body.dataset.modo === 'parear' && !!${Q('#par-nome')}`, 'sem aparelho pareado a página devia mostrar o parear', 8000);
  } finally { tolerando--; }
  limparLog();
}
const passoParear = () => avaliar(`${Q('.par')}.dataset.passo`);
const erroParear = (n) => avaliar(`(() => { const e = ${Q('#par-erro-' + n)}; return e.hidden ? '' : e.textContent; })()`);
const submeter = (p) => avaliar(`(${Q(`.par-passo[data-p="${p}"] button[type=submit]`)}.click(), true)`);
const avisoParear = () => avaliar(`(() => { const a = ${Q('.par-aviso')}; return !a || a.hidden ? null : { texto: a.textContent, aviso: a.classList.contains('aviso') }; })()`);
const pedirCodigo = async (nome) => {
  if (nome != null) await digitar('#par-nome', nome);
  await submeter(1);
  await exigir(`${Q('.par')}.dataset.passo === '2'`, 'pedir o código devia levar ao passo 2', 6000);
};
// 6 dígitos que não são o código do pedido
const codigoErrado = async () => { const c = await codigoReal(); return c.slice(0, 5) + ((Number(c[5]) + 1) % 10); };
const falhasConfirmar = () => posts(/^\/remoto\/parear\/confirmar$/).length;
async function esperarConfirmar(n) { const fim = Date.now() + 5000; while (falhasConfirmar() < n && Date.now() < fim) await dormir(50); await dormir(250); }

test('parear: nome sugerido, nome aparado, contagem regressiva, código curto, errado e certo (com espaço)', async () => {
  await viewport(390, 844);
  await iniciarParear();
  assert.equal(await passoParear(), '1');
  assert.equal(await avaliar(`${Q('#par-nome')}.value`), 'iPhone', 'o nome sugerido vem do aparelho');
  assert.equal(await avisoParear(), null, 'primeiro pareamento: sem aviso de motivo');
  assert.equal(await avaliar(`!${Q('.par-dica')}.hidden`), true, 'iPhone fora do app instalado mostra a dica de instalar');
  assert.equal(await avaliar(`${Q('#par-codigo')} !== null && ${Q('.par-passo[data-p="1"] button[type=submit]')}.textContent`), 'Pedir código');

  // nome com espaços de sobra: vai aparado e sem espaços duplos
  await digitar('#par-nome', '   Meu    iPhone  ');
  await pedirCodigo();
  assert.equal(posts(/^\/remoto\/parear\/pedir$/).length, 1);
  assert.equal(posts(/^\/remoto\/parear\/pedir$/)[0].corpo.nome, 'Meu iPhone');
  assert.equal(mock.estado.pedido.nome, 'Meu iPhone');

  // contagem: começa em 1:5x e desce
  const t1 = await textoDe('#par-tempo');
  assert.match(t1, /^Expira em (2:00|1:5\d)$/);
  const seg = (t) => { const m = /(\d+):(\d\d)$/.exec(t); return Number(m[1]) * 60 + Number(m[2]); };
  await exigir(`${Q('#par-tempo')}.textContent !== ${JSON.stringify(t1)}`, 'a contagem devia descer', 3000);
  await dormir(1200);
  assert.ok(seg(await textoDe('#par-tempo')) < seg(t1), 'o tempo restante diminui');

  // menos de 6 dígitos + enviar: aviso local, nada vai ao PC
  await digitar('#par-codigo', '123');
  await submeter(2);
  await exigir(`!${Q('#par-erro-2')}.hidden`, 'erro de código curto', 3000);
  assert.equal(await erroParear(2), 'Digite os 6 dígitos do código.');
  assert.equal(falhasConfirmar(), 0);
  await digitar('#par-codigo', '12');   // digitar de novo limpa o erro
  assert.equal(await erroParear(2), '');

  // 6 dígitos errados: confirmam sozinhos; erro, e o campo guarda o valor
  tolerando++;
  try {
    const errado = await codigoErrado();
    await digitar('#par-codigo', errado);
    await esperarConfirmar(1);
    assert.equal(await erroParear(2), 'Código errado. Confira os 6 dígitos que aparecem no PC.');
    assert.equal(await avaliar(`${Q('#par-codigo')}.value`), errado);
    assert.equal(await passoParear(), '2');
    assert.equal(await avaliar(`${Q('#par-codigo')}.getAttribute('aria-invalid')`), 'true');
    assert.equal(posts(/^\/remoto\/parear\/confirmar$/)[0].corpo.codigo, errado);
  } finally { tolerando--; }

  // código certo colado com espaço: "123 456" vira "123456", pareia e entra no app com o nome digitado
  const c = await codigoReal();
  await digitar('#par-codigo', c.slice(0, 3) + ' ' + c.slice(3));
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.sessoes.size >= 6`, 'código certo devia entrar no app', 12000);
  assert.equal(posts(/^\/remoto\/parear\/confirmar$/).at(-1).corpo.codigo, c);
  assert.equal(await avaliar('OM.estado.eu.aparelho.nome'), 'Meu iPhone');
  await exigir(`OM.rotas.atual().nome === 'inicio'`, 'depois de parear cai no início');
  assert.equal(await avaliar(`OM.estado.motivoParear`), '');
});

test('parear: código que expira no relógio da tela e no PC; "Pedir de novo" e volta ao nome', async () => {
  await viewport(390, 844);
  await iniciarParear();
  await pedirCodigo('Tablet');
  assert.match(await textoDe('#par-tempo'), /^Expira em (2:00|1:5\d)$/);
  // o relógio da página anda 121 s: a tela marca expirado sozinha
  await avaliar(`(() => { window.__dn = Date.now; Date.now = () => window.__dn() + 121000; return true; })()`);
  await exigir(`${Q('#par-tempo')}.textContent === 'O código expirou (vale 2 minutos).'`, 'o tempo devia esgotar', 4000);
  assert.equal(await avaliar(`${Q('#par-codigo')}.disabled`), true);
  assert.equal(await avaliar(`${Q('.par-passo[data-p="2"] button[type=submit]')}.hidden`), true, 'Parear some');
  assert.equal(await avaliar(`${QA('.par-passo[data-p="2"] button')}.some((b) => !b.hidden && b.textContent === 'Pedir de novo')`), true);
  // volta o relógio e expira o pedido no PC; "Pedir de novo" abre outro
  await avaliar(`(Date.now = window.__dn, true)`);
  await postMock('/_mock/expirar');
  limparLog();
  await clicar('.par-passo[data-p="2"] button', /^Pedir de novo$/);
  await exigir(`/^Expira em (2:00|1:5\\d)$/.test(${Q('#par-tempo')}.textContent) && !${Q('#par-codigo')}.disabled && ${Q('#par-codigo')}.value === ''`, 'novo pedido: contagem nova e campo livre', 5000);
  assert.equal(posts(/^\/remoto\/parear\/pedir$/).length, 1);
  assert.equal(posts(/^\/remoto\/parear\/pedir$/)[0].corpo.nome, 'Tablet');

  // o PC expirou o pedido (410) e o código certo é digitado: volta ao nome, com o nome mantido e o aviso
  const c = await codigoReal();
  await postMock('/_mock/expirar');
  tolerando++;
  try {
    await digitar('#par-codigo', c);
    await exigir(`${Q('.par')}.dataset.passo === '1'`, '410 devia levar de volta ao passo 1', 5000);
  } finally { tolerando--; }
  assert.equal(await erroParear(1), 'O código expirou (vale 2 minutos). Peça outro.');
  assert.equal(await avaliar(`${Q('#par-nome')}.value`), 'Tablet', 'o nome digitado fica');
  assert.equal(await avaliar('document.body.dataset.modo'), 'parear');
  await digitar('#par-nome', 'Tablet 2');   // digitar limpa o erro
  assert.equal(await erroParear(1), '');
});

test('parear: 5 códigos errados bloqueiam (429); pedir fica recusado até liberar; pedido aberto recusa outro (409)', async () => {
  await viewport(390, 844);
  await iniciarParear();
  await pedirCodigo('Celular');
  tolerando++;
  try {
    const errado = await codigoErrado();
    for (let i = 1; i <= 4; i++) {
      await digitar('#par-codigo', errado);
      await esperarConfirmar(i);
      assert.equal(await erroParear(2), 'Código errado. Confira os 6 dígitos que aparecem no PC.', `erro ${i}`);
      assert.equal(await passoParear(), '2');
    }
    await digitar('#par-codigo', errado);
    await exigir(`${Q('.par')}.dataset.passo === '1'`, 'o 5º erro devia bloquear e voltar ao nome', 5000);
    assert.equal(falhasConfirmar(), 5);
    const bloqueio = 'Muitas tentativas erradas. O pareamento fica bloqueado por 10 minutos.';
    assert.equal(await erroParear(1), bloqueio);
    // pedir de novo também é recusado enquanto durar o bloqueio
    limparLog();
    await submeter(1);
    await exigir(`!${Q('#par-erro-1')}.hidden`, 'erro ao pedir bloqueado', 4000);
    await dormir(300);
    assert.equal(await erroParear(1), bloqueio);
    assert.equal(await passoParear(), '1');
    assert.equal(posts(/^\/remoto\/parear\/pedir$/).length, 1);
    assert.equal(mock.estado.pedido, null);
    // liberado: o pedido passa
    await postMock('/_mock/desbloquear');
    await submeter(1);
    await exigir(`${Q('.par')}.dataset.passo === '2'`, 'liberado o pedido devia passar', 5000);
    assert.equal(await erroParear(1), '');
    // com o pedido aberto, voltar ("Trocar o nome") e pedir outro é recusado
    await clicar('.par-passo[data-p="2"] button', /^Trocar o nome$/);
    await exigir(`${Q('.par')}.dataset.passo === '1'`, 'Trocar o nome volta ao passo 1', 3000);
    await dormir(350);
    await submeter(1);
    await exigir(`!${Q('#par-erro-1')}.hidden`, 'erro ao pedir com pedido aberto', 4000);
    assert.equal(await erroParear(1), 'Já existe um pedido de pareamento aberto. Espere ele expirar ou recuse-o no Orbit do PC.');
    assert.equal(await passoParear(), '1');
  } finally { tolerando--; }
});

test('parear: aviso de motivo (removido no PC / saiu) e volta a parear', async () => {
  await viewport(390, 844);
  mock.estado.pedido = null; mock.estado.bloqueadoAte = 0;
  await parear('iPhone aviso');
  await exigir(`OM.rotas.atual().nome === 'inicio'`, 'início');
  // o PC remove o aparelho com o app vivo
  tolerando++;
  try {
    await avaliar(`fetch('/remoto/sair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)`);
    await exigir(`document.body.dataset.modo === 'parear'`, 'removido no PC devia voltar ao parear', 20000);
    await exigir(`OM.estado.motivoParear === 'revogado'`, 'motivo revogado', 3000);
  } finally { tolerando--; }
  const rev = await avisoParear();
  assert.ok(rev, 'o aviso aparece');
  assert.match(rev.texto, /Este aparelho foi removido no PC\. Para voltar a usar o Orbit aqui, peça um novo código\./);
  assert.equal(rev.aviso, true, 'revogado é aviso em destaque');
  assert.equal(await passoParear(), '1');

  // pareia de novo (o aviso some) e sai pelo próprio aparelho
  mock.estado.pedido = null;
  await parear('iPhone aviso 2');
  assert.equal(await avisoParear(), null, 'depois de parear não sobra aviso');
  await exigir(`OM.estado.eu`, 'eu carregado', 6000);
  await avaliar(`OM.sair().then(() => true)`);
  await exigir(`document.body.dataset.modo === 'parear' && OM.estado.motivoParear === 'saiu'`, 'sair devia voltar ao parear', 6000);
  const saiu = await avisoParear();
  assert.ok(saiu, 'aviso de saída');
  assert.match(saiu.texto, /Você saiu do Orbit neste aparelho\. Pareie de novo quando quiser\./);
  assert.equal(saiu.aviso, false, 'sair é só informação');
  // deixa o app pareado para os próximos casos
  mock.estado.pedido = null;
  await parear();
  await exigir(`OM.rotas.atual().nome === 'inicio'`, 'de volta ao início');
});

test('parear (320×568): os dois passos cabem sem rolagem lateral', async () => {
  await viewport(320, 568);
  try {
    await iniciarParear();
    assert.equal(await semRolagemLateral(), true, 'passo 1');
    assert.equal(await avaliar(`${QA('.par-passo[data-p="1"] .par-campo, .par-passo[data-p="1"] .par-btn')}.every((e) => e.getBoundingClientRect().right <= innerWidth + 0.5 && e.getBoundingClientRect().left >= -0.5)`), true);
    await pedirCodigo();
    await dormir(400);
    assert.equal(await semRolagemLateral(), true, 'passo 2');
    assert.equal(await avaliar(`${QA('.par-passo[data-p="2"] .par-campo, .par-passo[data-p="2"] .par-btn')}.filter((e) => !e.hidden).every((e) => e.getBoundingClientRect().right <= innerWidth + 0.5 && e.getBoundingClientRect().left >= -0.5)`), true);
  } finally {
    await viewport(390, 844);
    mock.estado.pedido = null;
    await parear();
    await exigir(`OM.rotas.atual().nome === 'inicio'`, 'de volta ao início');
  }
});

// ═════════════════════════════ 8. movimento reduzido ═════════════════════════════
// propriedades animadas (Web Animations) durante ~500 ms depois de trocar o hash
const animadas = (hash) => avaliar(`(async () => {
  const ks = new Set();
  const fim = performance.now() + 500;
  location.hash = ${JSON.stringify(hash)};
  while (performance.now() < fim) {
    for (const a of document.getAnimations()) for (const k of (a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [])) for (const p of Object.keys(k)) ks.add(p);
    await new Promise((r) => setTimeout(r, 16));
  }
  return [...ks].filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p));
})()`);

test('movimento reduzido: Mais, Uso, Ideias, detalhe e Nova só com fade (sem transform) e a folha sem transição de transform', async () => {
  await viewport(390, 844);
  await irPara('#inicio'); await noTopo('inicio');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    assert.equal(await avaliar(`matchMedia('(prefers-reduced-motion: reduce)').matches && OM.reduzido()`), true);
    for (const [de, para] of [['#inicio', '#mais'], ['#mais', '#mais/uso'], ['#mais/uso', '#mais'], ['#mais', '#mais/ideias'], ['#mais/ideias', '#inicio'], ['#inicio', '#s=s1/detalhe'], ['#s=s1/detalhe', '#inicio'], ['#inicio', '#nova']]) {
      await irPara(de);
      await dormir(450);
      const ks = await animadas(para);
      assert.ok(!ks.some((k) => /^(transform|translate|scale|rotate)$/.test(k)), `${de} → ${para} sem transform (movimento reduzido): ${ks}`);
      assert.ok(ks.includes('opacity') || ks.length === 0, `${de} → ${para}: só fade ${ks}`);
    }
    await irPara('#inicio'); await noTopo('inicio');
    // a folha de nova ideia só aparece com fade
    await abrirSub('ideias');
    await avaliar(`${Q('button[aria-label="Nova ideia"]')}.click()`);
    await folhaAberta();
    let tr = await avaliar(`(() => { const f = document.querySelector('.folha'), u = document.querySelector('.folha-fundo'); return [getComputedStyle(f).transitionProperty, getComputedStyle(u).transitionProperty]; })()`);
    assert.ok(!/transform|all/.test(tr[0]), 'folha reduzida sem transição de transform: ' + tr[0]);
    assert.ok(!/transform|all/.test(tr[1]), 'fundo reduzido: ' + tr[1]);
    assert.ok(/opacity/.test(tr[0]), 'a folha só aparece com fade: ' + tr[0]);
    await folhaBtn(/^Cancelar$/);
    await folhaSumiu();
  } finally {
    await avaliar('OM.folha.fecharTodas()');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await irPara('#inicio'); await noTopo('inicio');
  }
  assert.equal(await avaliar(`matchMedia('(prefers-reduced-motion: reduce)').matches`), false);
});

// ═════════════════════════════ 9. higiene final (sempre o último) ═════════════════════════════
test('higiene: sem rolagem lateral a 320×568 em todas as telas e nenhum erro de console nem violação de CSP no arquivo todo', async () => {
  await viewport(320, 568);
  try {
    await abrirMais();
    assert.equal(await semRolagemLateral(), true, '#mais');
    for (const sub of ['notificacoes', 'aparelho', 'uso', 'ideias', 'historico']) {
      await abrirSub(sub);
      await dormir(250);
      assert.equal(await semRolagemLateral(), true, '#mais/' + sub);
    }
    await abrirNova();
    await dormir(250);
    assert.equal(await semRolagemLateral(), true, '#nova');
    await abrirDetalhe('s1');
    assert.equal(await semRolagemLateral(), true, 'detalhe');
    await abrirDetalhe('s6');
    assert.equal(await semRolagemLateral(), true, 'detalhe (dormindo)');
  } finally { await viewport(390, 844); await irPara('#inicio'); await noTopo('inicio'); }

  await dormir(400);
  assert.deepEqual(violacoes, [], 'violações de CSP');
  assert.deepEqual(consoleErros, [], 'erros de console');
  // erros de rede provocados de propósito: só 401/403/409/429/503 (ou falha de conexão do PC caído)
  const estranhos = esperados.filter((e) => !/\b(401|403|409|410|429|503)\b|ERR_|Failed to load/.test(e));
  assert.deepEqual(estranhos, [], 'erros de rede inesperados');
});

