// Teste da CONVERSA e do COMPOSER do app do celular (mobile/conversa.js, mobile/composer.js, assets/comum/cartoes.js)
// contra o servidor falso testes/mobile-mock.mjs, num Edge headless mudo (390×844; o principal também em 320×568).
//   node testes/mobile-conversa.test.mjs        (ou: node --test testes/mobile-conversa.test.mjs)
// Confere: mensagens com markdown, ferramentas e imagens; cartões de permissão, pergunta e plano (corpo recebido pelo
// mock); cartão já respondido (404); Compactar com foco opcional; Limpar com confirmação; "Novas mensagens"; bolha
// otimista (enviando, enviado, falhou, com foto); atualização ao vivo pelo SSE; composer: texto, ctrl+Enter, foto
// (DOM.setFileInputFiles com um PNG gerado aqui), menu "/" só com os comandos permitidos, chips de modelo/esforço/modo,
// Parar, bloqueio sem conexão; movimento reduzido; 0 erro de console e 0 violação de CSP.
// O mock roda neste processo: o teste mexe em mock.sessoes / mock.estado direto (e usa /_mock/mudar para difundir).
// Falha de envio e atraso: o teste embrulha window.fetch NA PÁGINA (o mock não é alterado).
// Portas: o mock usa só 47822–47826 (porta-livre); o CDP, uma livre na faixa 9800–9949.

import { test as testeBase, before, after } from 'node:test';
const test = (nome, fn) => testeBase(nome, { timeout: 100000 }, fn);
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { subirMock } from './mobile-mock.mjs';
import { portaLivre } from './porta-livre.mjs';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

let mock = null, edge = null, ws = null, seq = 0, portaCdp = 0, perfil = '', manter = null, pastaTmp = '', orig = new Map();
const pend = new Map();
const consoleErros = [];
const violacoes = [];
const esperados = [];   // erros de rede provocados de propósito (404/403 do mock, PC caído, 401 sem pareamento)
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
      else if (e.source === 'network' && /ERR_FAILED/.test(e.text || '') && /\.(css|js|webmanifest)(\?|$)/.test(e.url || '')) esperados.push(`abortado pela navegação: ${e.text} ${e.url || ''}`);
      else if (e.source === 'network' && (tolerando > 0 || /\/remoto\/(eu(\?|$)|parear\/confirmar)/.test(e.url || ''))) esperados.push(`${e.text} ${e.url || ''}`);
      else consoleErros.push(`${e.source}: ${e.text} ${e.url || ''}`);
    }
  };
}
const cdp = (method, params = {}, ms = 20000) => new Promise((res, rej) => {
  const id = ++seq;
  const t = setTimeout(() => { pend.delete(id); rej(new Error('CDP sem resposta em ' + ms + ' ms: ' + method + ' ' + J(params).slice(0, 160))); }, ms);
  pend.set(id, (d) => { clearTimeout(t); res(d); });
  try { ws.send(J({ id, method, params })); } catch (e) { clearTimeout(t); pend.delete(id); rej(e); }
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
  try { est = await avaliar(`JSON.stringify({ hash: location.hash, conexao: OM.estado.conexao, rota: OM.rotas.atual().nome, toast: (document.getElementById('toast') || {}).textContent, folhas: OM.folha.abertas(), fase: (document.querySelector('.cv') || {}).dataset && document.querySelector('.cv').dataset.fase })`); } catch {}
  assert.fail(msg + ' | ' + expr.slice(0, 160) + ' | estado: ' + est);
}
const Q = (sel) => `document.querySelector(${J(sel)})`;
const postMock = (r, corpo = {}) => fetch(mock.base + r, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base }, body: J(corpo) });
const codigoReal = async () => (await (await fetch(mock.base + '/_mock/codigo')).json()).codigo;
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
async function viewport(w, h) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await dormir(250);
}
const reduzir = (ligado) => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: ligado ? 'reduce' : 'no-preference' }] });

const INJETADO = `window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));`;

async function abrirPagina(hash = '') {
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  await cdp('Page.navigate', { url: mock.base + '/m' + hash });
  await esperar('document.readyState === "complete"');
  await esperar('!!(window.OM && OM.rotas && OM.folha && OM.estado && OM.composer)');
  await dormir(200);
}

// ───────────────────────────── ajudantes do mock e da página ─────────────────────────────
const posts = (re) => mock.estado.log.filter((e) => e.metodo === 'POST' && re.test(e.rota));
const ultimoPost = (re) => posts(re).at(-1);
const limparLog = () => { mock.estado.log.length = 0; };
// volta uma sessão do mock ao que era no começo e difunde (o cartão de permissão volta, etc.)
async function restaurar(id) {
  const s = mock.sessoes.get(id);
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, structuredClone(orig.get(id)));
  await postMock('/_mock/mudar', { id });
}
// o cookie de pareamento, para o teste falar com o mock como se fosse o celular
const tokenMock = () => [...mock.estado.tokens][0];
const mock2 = (rota, corpo) => fetch(mock.base + rota, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base, cookie: 'orbit-mock=' + tokenMock(), 'x-gerenciador': '1' }, body: J(corpo) });

async function abrirConversa(id) {
  await abrirPagina('#s=' + id);
  // carga da página às vezes falha uma vez com outros testes rodando ao mesmo tempo: tenta de novo uma vez
  if (!(await esperar(`!!document.querySelector('.cv[data-fase="ok"]') && !!document.querySelector('.cp-texto')`, 6000).catch(() => false))) await abrirPagina('#s=' + id);
  await exigir(`!!document.querySelector('.cv[data-fase="ok"]') && !!document.querySelector('.cp-texto')`, 'a conversa ' + id + ' devia carregar com o composer', 10000);
  await dormir(150);
}
// clica no 1º elemento do seletor cujo texto (aparado) é igual a `texto` (ou qualquer um, se não vier texto)
const clicar = async (sel, texto) => {
  const ok = await avaliar(`(() => { const el = [...document.querySelectorAll(${J(sel)})].find((e) => ${texto === undefined ? 'true' : `e.textContent.trim() === ${J(texto)}`}); if (!el) return false; el.click(); return true; })()`);
  assert.ok(ok, 'não achei para clicar: ' + sel + (texto === undefined ? '' : ' "' + texto + '"'));
};
const textoDe = (sel) => avaliar(`[...document.querySelectorAll(${J(sel)})].map((e) => e.textContent.trim())`);
const toastTexto = () => avaliar(`(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()`);
const esperarToast = (re, msg) => exigir(`(() => { const t = document.getElementById('toast'); return !!t && !t.hidden && ${re.toString()}.test(t.textContent); })()`, msg || 'toast ' + re, 5000);
const CORPO = '.tela[data-tela="conversa"] .tela-corpo';
const alturaFim = () => avaliar(`(() => { const c = ${Q(CORPO)}; return Math.round(c.scrollHeight - c.scrollTop - c.clientHeight); })()`);
const nomesCartao = () => avaliar(`[...document.querySelectorAll('.cv-cartoes .ct-cartao')].map((e) => e.dataset.tipo)`);
// página: atraso / falha / "fingir" (não chega ao mock) em POST .../mensagem
const envio = (cfg) => avaliar(`(() => {
  window.__envio = Object.assign({ atraso: 0, falhar: 0, fingir: false, msg: 'Falha de propósito no envio' }, ${J(cfg)});
  if (!window.__fetchOrig) {
    window.__fetchOrig = window.fetch;
    window.fetch = async (u, i) => {
      if (/\\/mensagem$/.test(String(u)) && i && i.method === 'POST') {
        const e = window.__envio;
        if (e.atraso) await new Promise((r) => setTimeout(r, e.atraso));
        if (e.falhar) return new Response(JSON.stringify({ erro: e.msg }), { status: e.falhar, headers: { 'content-type': 'application/json' } });
        if (e.fingir) return new Response(JSON.stringify({ acao: { id: 'x' } }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      return window.__fetchOrig(u, i);
    };
  }
  return true;
})()`);
// escrever no composer como o teclado: foca e insere texto pelo CDP
async function digitar(texto) {
  await avaliar(`(() => { const t = ${Q('.cp-texto')}; t.focus(); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await cdp('Input.insertText', { text: texto });
  await dormir(80);
}
const enviarComCtrlEnter = async () => {
  const p = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
};
const enviarBotao = () => avaliar(`${Q('.cp-enviar')}.click()`);
const textoCampo = () => avaliar(`${Q('.cp-texto')}.value`);

// PNG pequeno gerado aqui (gradiente 64×48)
function crc(buf) { return zlib.crc32(buf) >>> 0; }
function fazerPng(w, h) {
  const bloco = (tipo, dados) => {
    const t = Buffer.from(tipo, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, dados])));
    return Buffer.concat([len, t, dados, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linhas = [];
  for (let y = 0; y < h; y++) {
    const l = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) { l[1 + x * 3] = (x * 255 / w) | 0; l[2 + x * 3] = (y * 255 / h) | 0; l[3 + x * 3] = 160; }
    linhas.push(l);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco('IHDR', ihdr), bloco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), bloco('IEND', Buffer.alloc(0))]);
}
let arquivoPng = '';
async function anexarFotos(arquivos) {
  const raiz = (await cdp('DOM.getDocument', { depth: 0 })).result.root.nodeId;
  const no = (await cdp('DOM.querySelector', { nodeId: raiz, selector: 'input.cp-arquivo' })).result.nodeId;
  assert.ok(no, 'input de arquivo do composer não existe');
  await cdp('DOM.setFileInputFiles', { nodeId: no, files: arquivos });
}

// ───────────────────────────── subida e descida ─────────────────────────────
before(async () => {
  mock = await subirMock({ porta: Number(process.env.GERENCIADOR_PORTA) || 47822 });
  for (const [k, v] of mock.sessoes) orig.set(k, structuredClone(v));
  pastaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-conversa-img-'));
  arquivoPng = path.join(pastaTmp, 'foto-teste.png');
  fs.writeFileSync(arquivoPng, fazerPng(64, 48));
  const ini = 9800 + Math.floor(Math.random() * 100);
  for (let p = ini; p < ini + 50 && !portaCdp; p++) if (await portaLivre(p)) portaCdp = p;
  assert.ok(portaCdp, 'nenhuma porta livre para o CDP');
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-conversa-'));
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
  try { if (perfil) fs.rmSync(perfil, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  try { if (pastaTmp) fs.rmSync(pastaTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  try { await mock?.fechar(); } catch {}
});

// ═════════════════════════════ 0. parear ═════════════════════════════
test('parear o aparelho de teste', async () => {
  await abrirPagina();
  await esperar(`document.body.dataset.modo === 'parear'`);
  const pedido = await avaliar(`OM.parear.pedir('iPhone da conversa').then((p) => p.pedido)`);
  assert.ok(pedido);
  assert.equal(await avaliar(`OM.parear.confirmar(${J(pedido)}, ${J(await codigoReal())})`), true);
  await exigir(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo' && OM.estado.sessoes.size === 6`, 'devia entrar no app com as 6 sessões');
});

// ═════════════════════════════ 1. a conversa: mensagens ═════════════════════════════
async function conferirMensagens(w) {
  await viewport(w, w === 320 ? 568 : 844);
  await abrirConversa('s1');
  assert.equal(await avaliar(`${Q('.cv-cab-nome')}.textContent`), 'Corrigir os testes do pareamento');
  assert.match(await avaliar(`${Q('.cv-cab-st')}.textContent`), /\S/, 'rótulo do status ao vivo');
  assert.equal(await avaliar(`${Q('.cv-ponto')}.dataset.st`), 'aguardando');
  assert.match(await avaliar(`${Q('.cv-cab-proj')}.textContent`), /Orbit/);
  assert.equal(await avaliar(`${Q('.cv-mais')}.getAttribute('aria-label')`), 'Mais ações');
  // usuário, assistente (markdown), 2 ferramentas
  assert.deepEqual(await textoDe('.cv-usu .cv-bolha'), ['Rode os testes do pareamento e corrija o que falhar']);
  assert.equal(await avaliar(`document.querySelectorAll('.cv-assist .md ul li').length`), 2, 'lista markdown com 2 itens');
  assert.equal(await avaliar(`${Q('.cv-assist .md pre')} !== null && ${Q('.cv-assist .md pre')}.textContent.includes('console.log("oi")')`), true, 'bloco de código markdown');
  assert.equal(await avaliar(`${Q('.cv-assist .md li code')}.textContent`), 'npm test');
  assert.deepEqual(await textoDe('.cv-ferr .cv-ferr-nome'), ['Read', 'Bash']);
  assert.equal(await avaliar(`${Q('.cv-ferr')}.open`), false, 'ferramenta recolhida');
  await avaliar(`${Q('.cv-ferr summary')}.click()`);
  assert.equal(await avaliar(`${Q('.cv-ferr')}.open`), true);
  assert.match(await avaliar(`${Q('.cv-ferr .cv-ferr-res')}.textContent`), /linha 1/);
  // cartão de permissão no fim, composer no rodapé dentro da tela
  assert.deepEqual(await nomesCartao(), ['ferramenta']);
  assert.ok(await avaliar(`(() => { const r = ${Q('.cp-texto')}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 && r.height > 20; })()`), 'campo do composer dentro da tela');
  assert.ok(await avaliar(`(() => { const r = ${Q('.ct-cartao')}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5; })()`), 'cartão dentro da tela');
  assert.ok(await semRolagemLateral(), `rolagem lateral na conversa em ${w}px`);
  assert.ok(await avaliar(`(() => { const c = ${Q(CORPO)}; return c.scrollWidth <= c.clientWidth + 1; })()`), 'corpo sem rolagem lateral');
}
test('conversa 390×844: cabeçalho, markdown, ferramentas e cartão no fim', () => conferirMensagens(390));
test('conversa 320×568: o mesmo, sem estourar a tela', () => conferirMensagens(320));

test('paginação: s4 (70 itens) abre com 40 e "Mensagens anteriores" traz o resto', async () => {
  await viewport(390, 844);
  await abrirConversa('s4');
  assert.equal(await avaliar(`document.querySelectorAll('.cv-lista .cv-item').length`), 40);
  assert.equal(await avaliar(`${Q('.cv-antigos')}.hidden`), false);
  assert.match(await avaliar(`${Q('.cv-antigos')}.textContent`), /Mensagens anteriores/);
  assert.ok(await alturaFim() < 50, 'abre rolada até o fim');
  assert.equal(await avaliar(`${Q('.cv-pensando')}.hidden`), false, '"Trabalhando…" com a sessão trabalhando');
  await avaliar(`${Q('.cv-antigos')}.click()`);
  await exigir(`document.querySelectorAll('.cv-lista .cv-item').length === 70`, 'devia trazer os 30 restantes');
  assert.equal(await avaliar(`${Q('.cv-antigos')}.hidden`), true);
});

// ═════════════════════════════ 2. cartões ═════════════════════════════
test('cartão de ferramenta: Permitir manda {id, decisao:permitir} (movimento reduzido: o cartão some na hora)', async () => {
  await reduzir(true);
  try {
    await abrirConversa('s1');
    assert.equal(await avaliar('OM.reduzido()'), true);
    limparLog();
    assert.match(await avaliar(`${Q('.ct-resumo')}.textContent`), /npm test/);
    assert.deepEqual(await textoDe('.ct-cartao .ct-sug'), ['Sempre permitir npm test']);
    await clicar('.ct-cartao .btn', 'Permitir');
    await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'o cartão devia sair depois de responder', 3000);
    assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-1', decisao: 'permitir' });
    assert.equal(ultimoPost(/permissao$/)?.rota, '/sessao/s1/permissao');
    await esperarToast(/Permitido/);
    await exigir(`${Q('.cv-pensando')}.hidden === false`, 'a sessão passou a trabalhando');
  } finally { await reduzir(false); await restaurar('s1'); }
});
test('cartão de ferramenta: sugestão, Negar e Negar com motivo', async () => {
  await abrirConversa('s1');
  limparLog();
  await clicar('.ct-cartao .ct-sug');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'sugestão respondida');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-1', decisao: 'permitir', sugestao: 0 });
  await restaurar('s1');
  await abrirConversa('s1');
  limparLog();
  await clicar('.ct-cartao .btn', 'Negar');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'negar respondido');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-1', decisao: 'negar' });
  await restaurar('s1');
  await abrirConversa('s1');
  limparLog();
  assert.equal(await avaliar(`${Q('.ct-campo')}.hidden`), true);
  await clicar('.ct-cartao .ct-link');
  assert.equal(await avaliar(`${Q('.ct-campo')}.hidden`), false);
  await avaliar(`${Q('.ct-txt')}.focus()`);
  await cdp('Input.insertText', { text: 'use o banco de teste' });
  await clicar('.ct-cartao .btn', 'Negar com o motivo');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'negar com motivo respondido');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-1', decisao: 'negar', mensagem: 'use o banco de teste' });
  await restaurar('s1');
});
test('cartão de pergunta: Responder só liga com uma escolha; corpo com respostas; Não responder; resposta livre', async () => {
  await abrirConversa('s2');
  assert.deepEqual(await nomesCartao(), ['pergunta']);
  assert.match(await avaliar(`${Q('.ct-q-txt')}.textContent`), /Qual banco usar\?/);
  assert.deepEqual(await textoDe('.ct-op .ct-op-rot'), ['SQLite', 'Postgres', 'Outra resposta']);
  assert.equal(await avaliar(`[...document.querySelectorAll('.ct-cartao .btn')].find((b) => b.textContent.trim() === 'Responder').getAttribute('aria-disabled')`), 'true');
  limparLog();
  await clicar('.ct-cartao .btn', 'Responder');   // sem escolha: não envia, mostra o motivo
  assert.equal(posts(/permissao$/).length, 0, 'sem escolha não envia');
  assert.match(await avaliar(`${Q('.ct-erro')}.textContent`), /Escolha uma resposta/);
  await avaliar(`${Q('.ct-op-in[value="0"]')}.click()`);
  assert.equal(await avaliar(`[...document.querySelectorAll('.ct-cartao .btn')].find((b) => b.textContent.trim() === 'Responder').getAttribute('aria-disabled')`), 'false');
  await clicar('.ct-cartao .btn', 'Responder');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'pergunta respondida');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-2', decisao: 'permitir', respostas: { 'Qual banco usar?': 'SQLite' } });
  await restaurar('s2');
  // resposta livre ("Outra resposta")
  await abrirConversa('s2');
  limparLog();
  await avaliar(`${Q('.ct-op-outra .ct-op-in')}.click()`);
  await exigir(`${Q('.ct-livre')}.hidden === false`, 'campo livre devia abrir');
  await avaliar(`${Q('.ct-livre')}.focus()`);
  await cdp('Input.insertText', { text: 'DuckDB' });
  await clicar('.ct-cartao .btn', 'Responder');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'resposta livre enviada');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-2', decisao: 'permitir', respostas: { 'Qual banco usar?': 'DuckDB' } });
  await restaurar('s2');
  // Não responder
  await abrirConversa('s2');
  limparLog();
  await clicar('.ct-cartao .btn', 'Não responder');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'não responder enviado');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-2', decisao: 'negar' });
  await restaurar('s2');
});
test('cartão de plano: Aprovar, Aprovar e aceitar edições e Continuar planejando', async () => {
  await abrirConversa('s3');
  assert.deepEqual(await nomesCartao(), ['plano']);
  assert.match(await avaliar(`${Q('.ct-plano')}.innerHTML`), /<strong>checkout<\/strong>/, 'plano em markdown');
  assert.equal(await avaliar(`document.querySelectorAll('.ct-plano li').length`), 3);
  limparLog();
  await clicar('.ct-cartao .btn', 'Aprovar');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'plano aprovado');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-3', decisao: 'permitir' });
  await restaurar('s3');
  await abrirConversa('s3');
  limparLog();
  await clicar('.ct-cartao .btn', 'Aprovar e aceitar edições');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'plano aprovado com edições');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-3', decisao: 'permitir', sugestao: 0 });
  await restaurar('s3');
  await abrirConversa('s3');
  limparLog();
  await clicar('.ct-cartao .btn', 'Continuar planejando');
  assert.equal(await avaliar(`${Q('.ct-campo')}.hidden`), false);
  await avaliar(`${Q('.ct-txt')}.focus()`);
  await cdp('Input.insertText', { text: 'inclua o passo de pagamento' });
  await clicar('.ct-cartao .btn', 'Enviar e continuar planejando');
  await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'continuar planejando enviado');
  assert.deepEqual(ultimoPost(/permissao$/)?.corpo, { id: 'perm-3', decisao: 'negar', mensagem: 'inclua o passo de pagamento' });
  await restaurar('s3');
});
test('cartão já respondido em outro lugar (404): toast "Esse pedido já foi respondido." e o cartão sai', async () => {
  await abrirConversa('s1');
  tolerando++;
  try {
    // muda o id no mock SEM difundir: a página ainda tem o cartão com o id antigo, e o mock responde 404
    mock.sessoes.get('s1').controle.permissao.id = 'perm-outro';
    await clicar('.ct-cartao .btn', 'Permitir');
    await esperarToast(/Esse pedido já foi respondido\./);
    await exigir(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 'o cartão devia sair', 3000);
  } finally { tolerando--; await restaurar('s1'); }
});

// ═════════════════════════════ 3. Compactar e Limpar ═════════════════════════════
async function abrirMenuMais() {
  await avaliar(`${Q('.cv-mais')}.click()`);
  await exigir(`OM.folha.abertas() === 1 && document.querySelectorAll('.cv-menu-item').length === 3`, 'menu Mais ações com 3 itens');
}
test('menu "⋯": Compactar, Limpar (perigo) e Detalhes', async () => {
  await abrirConversa('s5');
  await abrirMenuMais();
  assert.deepEqual(await avaliar(`[...document.querySelectorAll('.cv-menu-item .cv-menu-rot')].map((e) => e.textContent)`), ['Compactar', 'Limpar', 'Detalhes']);
  assert.equal(await avaliar(`document.querySelectorAll('.cv-menu-item.perigo').length`), 1);
  assert.equal(await avaliar(`${Q('.cv-menu-item.perigo .cv-menu-rot')}.textContent`), 'Limpar');
  await avaliar('OM.folha.fecharTodas()');
  await exigir(`OM.folha.abertas() === 0`, 'a folha devia fechar');
});
test('Compactar com foco manda {foco}; sem foco manda {}; o divisor "Contexto compactado" aparece ao vivo', async () => {
  await abrirConversa('s5');
  limparLog();
  await abrirMenuMais();
  await clicar('.cv-menu-item', 'CompactarResume o contexto para liberar espaço');
  await exigir(`!!document.querySelector('textarea.cv-foco')`, 'folha de foco devia abrir');
  assert.match(await avaliar(`${Q('.cv-foco-conta')}.textContent`), /^0\/2000$/);
  await avaliar(`${Q('textarea.cv-foco')}.focus()`);
  await cdp('Input.insertText', { text: 'manter as decisões do banco' });
  assert.match(await avaliar(`${Q('.cv-foco-conta')}.textContent`), /^27\/2000$/);
  await avaliar(`${Q('.cv-foco-bt')}.click()`);
  await exigir(`OM.folha.abertas() === 0`, 'a folha fecha depois de compactar');
  assert.deepEqual(ultimoPost(/compactar$/)?.corpo, { foco: 'manter as decisões do banco' });
  await esperarToast(/Compactando a conversa/);
  await exigir(`!!document.querySelector('.cv-div') && /Contexto compactado · 30k → 5k/.test(${Q('.cv-div')}.textContent)`, 'divisor de compactação ao vivo', 5000);
  // sem foco (espera a sessão soltar: o mock marca ocupada por 400 ms)
  await exigir(`OM.sessao('s5').controle.ocupada === false`, 'sessão solta depois de compactar', 4000);
  await abrirMenuMais();
  await clicar('.cv-menu-item', 'CompactarResume o contexto para liberar espaço');
  await exigir(`!!document.querySelector('textarea.cv-foco')`, 'folha de foco (2ª vez)');
  await avaliar(`${Q('.cv-foco-bt')}.click()`);
  await exigir(`OM.folha.abertas() === 0`, 'a folha fecha (2ª vez)');
  assert.deepEqual(ultimoPost(/compactar$/)?.corpo, {});
  await exigir(`document.querySelectorAll('.cv-div').length === 2`, 'segundo divisor', 5000);
  await exigir(`OM.sessao('s5').controle.ocupada === false`, 'sessão solta', 4000);
});
test('/compact foco digitado no composer chama /compactar com {foco}', async () => {
  await abrirConversa('s5');
  limparLog();
  await digitar('/compact só o essencial');
  await enviarBotao();
  await dormir(300);
  assert.deepEqual(ultimoPost(/compactar$/)?.corpo, { foco: 'só o essencial' });
  assert.equal(posts(/mensagem$/).length, 0, '/compact não vai como mensagem');
  await exigir(`OM.sessao('s5').controle.ocupada === false`, 'sessão solta', 4000);
});

// ═════════════════════════════ 4. rolagem, "Novas mensagens", SSE ═════════════════════════════
test('"Novas mensagens": item novo longe do fim mostra o aviso; tocar leva ao fim (movimento reduzido)', async () => {
  await reduzir(true);
  try {
    await abrirConversa('s4');
    assert.equal(await avaliar(`${Q('.cv-novas')}.hidden`), true);
    await avaliar(`${Q(CORPO)}.scrollTop = 0`);
    await exigir(`${Q(CORPO)}.scrollHeight - ${Q(CORPO)}.scrollTop - ${Q(CORPO)}.clientHeight > 200`, 'devia estar longe do fim');
    await dormir(400);
    assert.equal(await avaliar(`${Q('.cv-novas')}.hidden`), true, 'rolar para cima não mostra o aviso');
    await mock2('/sessao/s4/mensagem', { texto: 'mensagem enquanto lia' });
    await exigir(`document.body.textContent.includes('mensagem enquanto lia')`, 'o item devia chegar ao vivo', 4000);
    assert.equal(await avaliar(`${Q('.cv-novas')}.hidden`), false, 'aviso "Novas mensagens"');
    assert.match(await avaliar(`${Q('.cv-novas')}.textContent`), /Novas mensagens/);
    assert.ok(await alturaFim() > 100, 'não rolou sozinho para o fim');
    await avaliar(`${Q('.cv-novas')}.click()`);
    await exigir(`${Q('.cv-novas')}.hidden === true`, 'o aviso some ao tocar');
    await exigir(`Math.round(${Q(CORPO)}.scrollHeight - ${Q(CORPO)}.scrollTop - ${Q(CORPO)}.clientHeight) < 50`, 'tocar leva ao fim', 2000);
    await exigir(`OM.sessao('s4').status === 'concluida'`, 'resposta do agente terminou', 4000);
  } finally { await reduzir(false); await restaurar('s4'); }
});
test('ao vivo pelo SSE: item do usuário, parcial "Entendi…" e resposta final com markdown; grudado no fim', async () => {
  await abrirConversa('s4');
  await avaliar(`window.__viuParcial = ''; new MutationObserver(() => { const p = document.querySelector('.cv-parcial'); if (p) window.__viuParcial = p.textContent; }).observe(document.body, { subtree: true, childList: true, characterData: true }); true`);
  const antes = await avaliar(`document.querySelectorAll('.cv-lista .cv-item').length`);
  await mock2('/sessao/s4/mensagem', { texto: 'chegou pelo fluxo' });
  await exigir(`[...document.querySelectorAll('.cv-usu .cv-bolha')].some((e) => e.textContent === 'chegou pelo fluxo')`, 'item do usuário ao vivo', 4000);
  await exigir(`/Entendi/.test(window.__viuParcial)`, 'resposta parcial devia aparecer', 4000);
  await exigir(`[...document.querySelectorAll('.cv-assist strong')].some((e) => e.textContent === 'chegou pelo fluxo')`, 'resposta final com **negrito**', 4000);
  await exigir(`!document.querySelector('.cv-parcial')`, 'o parcial vira o item final (sem parcial sobrando)', 3000);
  assert.equal(await avaliar(`document.querySelectorAll('.cv-lista .cv-item').length`), antes + 2, 'um item do usuário e uma resposta (sem duplicar)');
  assert.ok(await alturaFim() < 50, 'segue grudada no fim');
  assert.equal(await avaliar(`${Q('.cv-novas')}.hidden`), true);
  await exigir(`OM.sessao('s4').status === 'concluida' && ${Q('.cv-ponto')}.dataset.st === 'concluida'`, 'cabeçalho acompanha o status ao vivo', 4000);
  assert.equal(await avaliar(`${Q('.cv-pensando')}.hidden`), true);
  await restaurar('s4');
});

// ═════════════════════════════ 5. composer: texto e bolha otimista ═════════════════════════════
test('composer: botão Enviar liga com texto; envia {texto}; bolha "Enviando…" e some quando o eco chega', async () => {
  await abrirConversa('s5');
  limparLog();
  assert.equal(await avaliar(`${Q('.cp-enviar')}.disabled`), true, 'vazio: enviar desligado');
  await envio({ atraso: 900 });
  await digitar('olá pelo celular');
  assert.equal(await avaliar(`${Q('.cp-enviar')}.disabled`), false);
  assert.equal(await avaliar(`sessionStorage.getItem('om-rascunho:s5')`), 'olá pelo celular', 'rascunho guardado');
  await enviarBotao();
  await exigir(`!!document.querySelector('.cv-local[data-estado="enviando"]')`, 'bolha otimista "Enviando…"', 1500);
  assert.equal(await avaliar(`${Q('.cv-local .cv-bolha')}.textContent`), 'olá pelo celular');
  assert.equal(await avaliar(`${Q('.cv-local .cv-local-st')}.textContent`), 'Enviando…');
  assert.equal(await textoCampo(), '', 'campo limpo ao enviar');
  assert.equal(await avaliar(`sessionStorage.getItem('om-rascunho:s5')`), null, 'rascunho apagado');
  await exigir(`!document.querySelector('.cv-local')`, 'a bolha local some quando o item real chega', 5000);
  assert.deepEqual(ultimoPost(/mensagem$/)?.corpo, { texto: 'olá pelo celular' });
  await exigir(`[...document.querySelectorAll('.cv-usu .cv-bolha')].filter((e) => e.textContent === 'olá pelo celular').length === 1`, 'uma só bolha do usuário');
  await exigir(`[...document.querySelectorAll('.cv-assist strong')].some((e) => e.textContent === 'olá pelo celular')`, 'resposta do agente', 4000);
});
test('composer: Ctrl+Enter envia; estado "Enviado" quando o eco não chega', async () => {
  await abrirConversa('s5');
  await envio({ fingir: true });
  await digitar('segunda mensagem');
  await enviarComCtrlEnter();
  await exigir(`!!document.querySelector('.cv-local[data-estado="enviado"]')`, 'bolha "Enviado"', 3000);
  assert.equal(await avaliar(`${Q('.cv-local .cv-local-st')}.textContent`), 'Enviado');
  assert.equal(await avaliar(`document.querySelectorAll('.cv-local .cv-local-bt').length`), 0);
  assert.equal(await textoCampo(), '');
});
test('bolha otimista que falha: erro, texto volta ao campo, aviso e "Descartar"', async () => {
  await abrirConversa('s5');
  limparLog();
  await envio({ falhar: 500, msg: 'O servidor quebrou de propósito' });
  await digitar('vai falhar');
  await enviarBotao();
  await exigir(`!!document.querySelector('.cv-local[data-estado="erro"]')`, 'bolha em erro', 3000);
  assert.equal(await avaliar(`${Q('.cv-local .cv-local-st')}.textContent`), 'O servidor quebrou de propósito');
  assert.deepEqual(await textoDe('.cv-local .cv-local-bt'), ['Descartar']);
  assert.equal(await textoCampo(), 'vai falhar', 'o texto volta ao campo para tentar de novo');
  assert.equal(await avaliar(`${Q('.cp-aviso')}.hidden`), false);
  assert.match(await avaliar(`${Q('.cp-aviso')}.textContent`), /quebrou de propósito/);
  assert.match(await toastTexto(), /\S/);
  assert.equal(posts(/mensagem$/).length, 0, 'não chegou ao mock');
  assert.equal(await avaliar(`${Q('.cp-enviar')}.disabled`), false, 'dá para enviar de novo');
  await clicar('.cv-local .cv-local-bt', 'Descartar');
  assert.equal(await avaliar(`document.querySelectorAll('.cv-local').length`), 0, 'Descartar tira a bolha');
  // tentar de novo pelo campo, agora sem falha
  await envio({ falhar: 0 });
  await enviarBotao();
  await exigir(`!document.querySelector('.cv-local')`, 'a bolha local some com o eco', 6000);
  assert.ok(posts(/mensagem$/).length >= 1, 'o reenvio chegou ao mock');
  assert.deepEqual(ultimoPost(/mensagem$/)?.corpo, { texto: 'vai falhar' });
});
test('comando fora da lista (/help): o mock barra com 403 e o app explica', async () => {
  await abrirConversa('s5');
  tolerando++;
  try {
    await digitar('/help');
    await enviarBotao();
    await exigir(`!!document.querySelector('.cv-local[data-estado="erro"]')`, 'bolha em erro para /help', 3000);
    assert.match(await avaliar(`${Q('.cv-local .cv-local-st')}.textContent`), /Esse comando não pode ser usado pelo celular/);
    assert.match(await toastTexto(), /Esse comando não pode ser usado pelo celular/);
    assert.equal(await textoCampo(), '/help');
  } finally { tolerando--; }
});

// ═════════════════════════════ 6. composer: fotos ═════════════════════════════
test('composer: foto anexada (miniatura, remover) e enviada como JPEG {texto, imagens}', async () => {
  await abrirConversa('s6');
  limparLog();
  assert.equal(await avaliar(`${Q('.cp-fotos')}.hidden`), true);
  await anexarFotos([arquivoPng, arquivoPng]);
  await exigir(`document.querySelectorAll('.cp-mini img').length === 2`, 'duas miniaturas', 6000);
  assert.equal(await avaliar(`${Q('.cp-fotos')}.hidden`), false);
  assert.equal(await avaliar(`${Q('.cp-enviar')}.disabled`), false, 'só foto já deixa enviar');
  await avaliar(`${Q('.cp-tirar')}.click()`);
  assert.equal(await avaliar(`document.querySelectorAll('.cp-mini img').length`), 1, 'remover uma foto');
  await digitar('olha essa foto');
  await enviarBotao();
  await exigir(`[...document.querySelectorAll('.cv-usu .cv-galeria img')].length >= 1`, 'a foto aparece na conversa (item real)', 6000);
  const corpo = ultimoPost(/mensagem$/)?.corpo;
  assert.equal(corpo.texto, 'olha essa foto');
  assert.equal(corpo.imagens.length, 1);
  assert.equal(corpo.imagens[0].tipo, 'image/jpeg');
  assert.ok(corpo.imagens[0].dados.startsWith('/9j/'), 'dados em base64 de um JPEG');
  assert.deepEqual(Object.keys(corpo.imagens[0]).sort(), ['dados', 'tipo']);
  assert.equal(await avaliar(`${Q('.cp-fotos')}.hidden`), true, 'faixa de fotos esvazia ao enviar');
  // a imagem do item real carrega do mock
  await exigir(`(() => { const i = ${Q('.cv-usu .cv-galeria img')}; return i && i.complete && i.naturalWidth > 0 && /\\/sessao\\/s6\\/imagem\\?o=1&i=0$/.test(i.getAttribute('src')); })()`, 'imagem do item real carregada', 5000);
  assert.equal(await avaliar(`document.querySelectorAll('.cv-local').length`), 0, 'a bolha local saiu');
});
test('BUG-1: bolha otimista "Enviando…" com foto mostra a foto (mobile/conversa.js galeria)', async () => {
  await abrirConversa('s5');
  await envio({ atraso: 1200 });
  await anexarFotos([arquivoPng]);
  await exigir(`document.querySelectorAll('.cp-mini img').length === 1`, 'miniatura', 6000);
  await digitar('com foto otimista');
  await enviarBotao();
  await exigir(`!!document.querySelector('.cv-local[data-estado="enviando"]')`, 'bolha enviando', 1500);
  const n = await avaliar(`document.querySelectorAll('.cv-local .cv-galeria img').length`);
  const src = await avaliar(`(${Q('.cv-local .cv-galeria img')} || {}).src || ''`);
  assert.equal(n, 1, 'a bolha otimista devia mostrar a foto enviada (o composer manda dataURL em composer:enviado)');
  assert.match(src, /^data:image\/jpeg;base64,/);
  await exigir(`!document.querySelector('.cv-local')`, 'bolha local some com o eco', 5000);
});
test('BUG-1: bolha com foto que falha mostra a foto e o erro; a foto volta para o composer', async () => {
  await abrirConversa('s5');
  await envio({ falhar: 500, msg: 'Falha de propósito com foto' });
  await anexarFotos([arquivoPng]);
  await exigir(`document.querySelectorAll('.cp-mini img').length === 1`, 'miniatura', 6000);
  await digitar('foto que falha');
  await enviarBotao();
  await exigir(`!!document.querySelector('.cv-local[data-estado="erro"]')`, 'bolha em erro', 3000);
  assert.equal(await avaliar(`document.querySelectorAll('.cp-mini img').length`), 1, 'a foto volta ao composer');
  assert.equal(await textoCampo(), 'foto que falha');
  assert.equal(await avaliar(`document.querySelectorAll('.cv-local .cv-galeria img').length`), 1, 'a bolha em erro devia mostrar a foto');
  await clicar('.cv-local .cv-local-bt', 'Descartar');
  assert.equal(await avaliar(`document.querySelectorAll('.cv-local').length`), 0);
});

// ═════════════════════════════ 7. composer: menu "/" ═════════════════════════════
test('menu "/": só /compact, /clear e as skills permitidas; filtra; escolher preenche; Esc fecha', async () => {
  await abrirConversa('s5');
  assert.equal(await avaliar(`${Q('.cp-menu')}.hidden`), true);
  await digitar('/');
  await exigir(`document.querySelectorAll('.cp-menu .cp-cmd').length === 3`, 'menu com os 3 comandos', 4000);
  assert.deepEqual(await textoDe('.cp-menu .cp-cmd-nome'), ['/compact [foco]', '/clear', '/minha-skill']);
  const todos = (await textoDe('.cp-menu .cp-cmd')).join(' ');
  for (const proibido of ['/help', '/model', '/config', '/init', '/resume', '/review']) assert.ok(!todos.includes(proibido), 'embutido no menu: ' + proibido);
  assert.equal(await avaliar(`${Q('.cp-cmd.cp-ativo .cp-cmd-nome')}.textContent.startsWith('/compact')`), true);
  // filtra
  await digitar('/c');
  await exigir(`document.querySelectorAll('.cp-menu .cp-cmd').length === 2`, 'filtro /c');
  assert.deepEqual((await textoDe('.cp-menu .cp-cmd-nome')).map((t) => t.split(' ')[0]), ['/compact', '/clear']);
  await digitar('/zzz');
  await exigir(`!!document.querySelector('.cp-menu-vazio')`, 'menu vazio');
  assert.match(await avaliar(`${Q('.cp-menu-vazio')}.textContent`), /Nenhum comando permitido/);
  await digitar('/mi');
  await exigir(`document.querySelectorAll('.cp-menu .cp-cmd').length === 1`, 'filtro /mi');
  // escolher
  await clicar('.cp-menu .cp-cmd');
  assert.equal(await textoCampo(), '/minha-skill ');
  assert.equal(await avaliar(`${Q('.cp-menu')}.hidden`), true, 'escolher fecha o menu');
  // Esc fecha
  await digitar('/');
  await exigir(`${Q('.cp-menu')}.hidden === false`, 'menu abre');
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await exigir(`${Q('.cp-menu')}.hidden === true`, 'Esc fecha o menu');
  // texto que não é só "/algo" não abre o menu
  await digitar('oi /compact');
  assert.equal(await avaliar(`${Q('.cp-menu')}.hidden`), true);
  // skill permitida segue como mensagem
  limparLog();
  await digitar('/minha-skill abc');
  await enviarBotao();
  await dormir(500);
  assert.deepEqual(ultimoPost(/mensagem$/)?.corpo, { texto: '/minha-skill abc' });
});
test('/clear digitado pede confirmação e só então chama /limpar (Cancelar não faz nada)', async () => {
  await abrirConversa('s6');
  limparLog();
  await digitar('/clear');
  await enviarBotao();
  await exigir(`OM.folha.abertas() === 1 && /Limpar a conversa\\?/.test(document.body.textContent)`, 'confirmação aberta');
  await dormir(500);
  await clicar('.folha-acoes .btn', 'Cancelar');
  await exigir(`OM.folha.abertas() === 0`, 'folha fechou', 8000);
  await dormir(200);
  assert.equal(posts(/limpar$/).length, 0, 'cancelar não limpa');
  assert.equal(await textoCampo(), '/clear', 'o texto fica no campo');
  await enviarBotao();
  await exigir(`OM.folha.abertas() === 1`, 'confirmação de novo');
  await dormir(500);
  await clicar('.folha-acoes .btn', 'Limpar');
  await exigir(`OM.folha.abertas() === 0`, 'folha fechou', 8000);
  await dormir(300);
  assert.deepEqual(ultimoPost(/limpar$/)?.corpo, { confirmar: true });
  assert.equal(posts(/mensagem$/).length, 0);
  await exigir(`OM.sessao('s6').controle.ocupada === false`, 'sessão solta', 4000);
});

// ═════════════════════════════ 8. chips de modelo, esforço e modo ═════════════════════════════
test('chips: modelo, esforço e modo abrem a folha e mandam o corpo certo', async () => {
  await abrirConversa('s1');   // s1 tem cartão, mas o composer está livre; o s5 já foi usado demais
  await restaurar('s5');
  await abrirConversa('s5');
  assert.equal(await avaliar(`${Q('.cp-chips')}.hidden`), false);
  assert.equal(await avaliar(`${Q('.cp-chip[data-tipo=modelo]')}.disabled`), false);
  assert.match(await avaliar(`${Q('.cp-chip[data-tipo=esforco] .cp-chip-rot')}.textContent`), /Alto/);
  assert.match(await avaliar(`${Q('.cp-chip[data-tipo=modo] .cp-chip-rot')}.textContent`), /Padrão/);
  limparLog();
  // modelo
  await avaliar(`${Q('.cp-chip[data-tipo=modelo]')}.click()`);
  await exigir(`OM.folha.abertas() === 1 && document.querySelectorAll('.cp-op').length === 3`, 'folha de modelo com 3 opções', 5000);
  const nomes = await textoDe('.cp-op .cp-op-nome');
  assert.match(nomes[0], /^Padrão/);
  assert.deepEqual(nomes.slice(1), ['Sonnet', 'Haiku']);
  assert.equal(await avaliar(`${Q('.cp-op.cp-atual .cp-op-nome')}.textContent.startsWith('Padrão')`), true, 'o atual vem marcado');
  await clicar('.cp-op', 'SonnetRápido');
  await exigir(`OM.folha.abertas() === 0`, 'folha fecha ao escolher');
  await dormir(250);
  assert.deepEqual(ultimoPost(/\/modelo$/)?.corpo, { modelo: 'sonnet' });
  await exigir(`/Sonnet/.test(${Q('.cp-chip[data-tipo=modelo] .cp-chip-rot')}.textContent)`, 'o chip mostra o modelo novo');
  // esforço
  await avaliar(`${Q('.cp-chip[data-tipo=esforco]')}.click()`);
  await exigir(`OM.folha.abertas() === 1 && document.querySelectorAll('.cp-op').length === 3`, 'folha de esforço com 3 níveis', 5000);
  assert.deepEqual(await textoDe('.cp-op .cp-op-nome'), ['Baixo', 'Médio', 'Alto']);
  await clicar('.cp-op', 'Baixo');
  await exigir(`OM.folha.abertas() === 0`, 'folha fecha');
  await dormir(250);
  assert.deepEqual(ultimoPost(/\/esforco$/)?.corpo, { esforco: 'low' });
  await exigir(`/Baixo/.test(${Q('.cp-chip[data-tipo=esforco] .cp-chip-rot')}.textContent)`, 'o chip mostra o esforço novo');
  // modo
  await avaliar(`${Q('.cp-chip[data-tipo=modo]')}.click()`);
  await exigir(`OM.folha.abertas() === 1 && document.querySelectorAll('.cp-op').length === 4`, 'folha de modo com 4 opções (sem "Sem permissões")', 5000);
  assert.deepEqual(await textoDe('.cp-op .cp-op-nome'), ['Padrão', 'Aceitar edições', 'Planejar', 'Auto']);
  await clicar('.cp-op', 'PlanejarSó planeja: não edita nem roda nada até você aprovar o plano');
  await exigir(`OM.folha.abertas() === 0`, 'folha fecha');
  await dormir(250);
  assert.deepEqual(ultimoPost(/\/modo$/)?.corpo, { modo: 'plan' });
  await exigir(`/Planejar/.test(${Q('.cp-chip[data-tipo=modo] .cp-chip-rot')}.textContent)`, 'o chip mostra o modo novo');
  assert.equal(await avaliar(`${Q('.cp-chip[data-tipo=modo]')}.dataset.modo`), 'plan');
  // Haiku não tem esforço: o chip some
  await avaliar(`${Q('.cp-chip[data-tipo=modelo]')}.click()`);
  await exigir(`OM.folha.abertas() === 1`, 'folha de modelo');
  await clicar('.cp-op', 'HaikuLeve');
  await dormir(250);
  assert.deepEqual(ultimoPost(/\/modelo$/)?.corpo, { modelo: 'haiku' });
  await exigir(`${Q('.cp-chip[data-tipo=esforco]')}.hidden === true`, 'Haiku sem nível de esforço: chip escondido', 4000);
  await restaurar('s5');
});
test('chips somem e o campo bloqueia quando a sessão não tem processo do Orbit', async () => {
  await abrirConversa('s5');
  await postMock('/_mock/mudar', { id: 's5', controle: { modo: 'nenhum', processo: null } });
  await exigir(`${Q('.cp-chips')}.hidden === true && ${Q('.cp-texto')}.disabled === true`, 'chips escondidos e campo desligado', 4000);
  assert.match(await avaliar(`${Q('.cp-aviso')}.textContent`), /Sem processo vivo/);
  assert.equal(await avaliar(`${Q('.cp-enviar')}.disabled`), true);
  assert.equal(await avaliar(`${Q('.cp-foto')}.getAttribute('aria-disabled')`), 'true');
  await restaurar('s5');
  await exigir(`${Q('.cp-chips')}.hidden === false && ${Q('.cp-texto')}.disabled === false`, 'volta ao normal', 4000);
});

// ═════════════════════════════ 9. botão Parar ═════════════════════════════
test('Parar: aparece com a sessão ocupada; Enviar entra na fila; POST /parar {}', async () => {
  await abrirConversa('s4');
  assert.equal(await avaliar(`${Q('.cp-parar')}.hidden`), false);
  assert.equal(await avaliar(`${Q('.cp-parar')}.textContent.trim()`), 'Parar');
  assert.equal(await avaliar(`${Q('.cp-enviar')}.hidden`), true, 'sem texto, só o Parar');
  await digitar('na fila');
  assert.equal(await avaliar(`${Q('.cp-enviar')}.hidden`), false);
  assert.equal(await avaliar(`${Q('.cp-enviar')}.getAttribute('aria-label')`), 'Enviar (entra na fila)');
  await digitar('');
  limparLog();
  await avaliar(`${Q('.cp-parar')}.click()`);
  await exigir(`${Q('.cp-parar')}.hidden === true`, 'Parar some depois que a sessão solta', 4000);
  assert.deepEqual(ultimoPost(/parar$/)?.corpo, {});
  assert.equal(ultimoPost(/parar$/)?.rota, '/sessao/s4/parar');
  await exigir(`${Q('.cv-ponto')}.dataset.st === 'interrompida'`, 'status ao vivo no cabeçalho', 4000);
  await restaurar('s4');
});
test('Parar não aparece em sessão parada (s5)', async () => {
  await abrirConversa('s5');
  assert.equal(await avaliar(`${Q('.cp-parar')}.hidden`), true);
});

// ═════════════════════════════ 10. sem conexão ═════════════════════════════
test('PC caiu: o composer desliga com aviso e a conversa volta sozinha', async () => {
  await abrirConversa('s5');
  tolerando++;
  try {
    assert.equal((await postMock('/_mock/cair')).status, 200);
    await exigir(`OM.estado.conexao !== 'vivo' && ${Q('.cp-texto')}.disabled === true`, 'composer desligado sem conexão', 12000);
    assert.equal(await avaliar(`${Q('.cp-aviso')}.hidden`), false);
    assert.match(await avaliar(`${Q('.cp-aviso')}.textContent`), /\S/);
    assert.equal(await avaliar(`${Q('.cp-enviar')}.disabled`), true);
    assert.equal((await postMock('/_mock/voltar')).status, 200);
    await exigir(`OM.estado.conexao === 'vivo' && ${Q('.cp-texto')}.disabled === false`, 'composer volta com a conexão', 25000);
    await exigir(`${Q('.cp-aviso')}.hidden === true`, 'sem aviso depois de voltar', 3000);
  } finally { await postMock('/_mock/voltar'); tolerando--; }
});

// ═════════════════════════════ 11. Limpar (por último: apaga a conversa do s5 no mock) ═════════════════════════════
test('Limpar: pede confirmação; Cancelar não faz nada; confirmar manda {confirmar:true} e a lista esvazia', async () => {
  await restaurar('s5');
  await abrirConversa('s5');
  const antes = await avaliar(`document.querySelectorAll('.cv-lista .cv-item').length`);
  assert.ok(antes >= 2, 'a conversa tem itens antes de limpar: ' + antes);
  limparLog();
  await abrirMenuMais();
  await clicar('.cv-menu-item.perigo');
  await exigir(`OM.folha.abertas() === 1 && /Limpar a conversa\\?/.test(document.body.textContent)`, 'confirmação aberta');
  assert.equal(await avaliar(`${Q('.folha-acoes .btn.perigo')}.textContent`), 'Limpar');
  await clicar('.folha-acoes .btn', 'Cancelar');
  await exigir(`OM.folha.abertas() === 0`, 'folha fechou');
  await dormir(200);
  assert.equal(posts(/limpar$/).length, 0, 'cancelar não limpa');
  assert.equal(await avaliar(`document.querySelectorAll('.cv-lista .cv-item').length`), antes);
  await abrirMenuMais();
  await clicar('.cv-menu-item.perigo');
  await exigir(`OM.folha.abertas() === 1`, 'confirmação de novo');
  await clicar('.folha-acoes .btn', 'Limpar');
  await exigir(`OM.folha.abertas() === 0`, 'folha fechou');
  await esperarToast(/Limpando a conversa/);
  assert.deepEqual(ultimoPost(/limpar$/)?.corpo, { confirmar: true });
  await exigir(`document.querySelectorAll('.cv-lista .cv-item').length === 0`, 'a lista esvazia quando a sessão solta', 8000);
});

// ═════════════════════════════ 12. higiene ═════════════════════════════
test('0 erro de console, 0 violação de CSP; só erros de rede provocados', async () => {
  assert.deepEqual(violacoes, [], 'violações de CSP');
  assert.deepEqual(consoleErros, [], 'erros de console');
  assert.ok(esperados.every((e) => /401|403|404|409|503|ERR_|Failed to load/i.test(e)), 'erros esperados inesperados: ' + esperados.join(' ; '));
});
