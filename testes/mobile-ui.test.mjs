// Teste da interface do celular (Orbit no celular) contra o servidor falso testes/mobile-mock.mjs.
// Sobe o mock numa porta livre de 47822–47826 (nunca a 47821) e um Edge headless mudo com viewport de iPhone (390×844).
//   node testes/mobile-ui.test.mjs [pasta-de-saida]     sem a pasta, as capturas vão para uma pasta temporária apagada no fim
// Confere: pareamento (erros: código errado, expirado, bloqueado), lista com "Precisa de você" ao vivo, abrir sessão,
// permitir, responder pergunta, aprovar plano, mandar mensagem (texto e foto), carregar anteriores, parar, modelo/esforço,
// abrir direto por #s=<id>, uso do plano, este aparelho (instalar, ativar/testar/desativar push, push recebido pelo service worker),
// nova instância, sair; alvos de toque >= 44 px, sem rolagem lateral, sem erro de console e sem violação de CSP.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { subirMock } from './mobile-mock.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SAIDA = arg ? path.resolve(arg) : fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mobile-ui-'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const conferir = (nome, ok, detalhe) => { checks.push({ nome, ok: !!ok, detalhe: ok ? undefined : detalhe }); };
const consoleErros = [];
const violacoes = [];
const esperados = []; // erros de rede provocados de propósito (401 sem pareamento, código errado...)

let mock = null;
let ws, seq = 0;
const pend = new Map();
const eventos = [];
const registros = new Map();
const porta = 9800 + Math.floor(Math.random() * 150);
const perfil = path.join(SAIDA, 'edge-' + porta);
let edge = null;

async function conectar() {
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) {
    try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!alvo) await dormir(200);
  }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
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
      // Erros de rede provocados de propósito: 401 sem pareamento, código errado/expirado/bloqueado, sessão que não existe.
      if (e.source === 'network' && /\/remoto\/(eu|parear\/)|\/sessao\/nao-existe/.test(e.url || '')) esperados.push(e.url);
      else if (/Content Security Policy|Refused to/i.test(e.text || '')) violacoes.push(e.text);
      else consoleErros.push(`${e.source}: ${e.text} ${e.url || ''}`);
    }
    if (d.method === 'ServiceWorker.workerRegistrationUpdated') for (const r of d.params.registrations) registros.set(r.scopeURL, r.registrationId);
    eventos.push(d.method);
  };
}
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => {
  const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
  if (r?.exceptionDetails) throw new Error('avaliar: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' em ' + expr.slice(0, 120));
  return r?.result?.value;
};
async function esperar(expr, ms = 10000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { if (await avaliar(expr)) return true; } catch {}
    await dormir(120);
  }
  return false;
}
const foto = async (nome) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
};
const Q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const visivel = (sel) => `(() => { const e = ${Q(sel)}; return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
const clicar = (sel) => avaliar(`(() => { const e = ${Q(sel)}; if (!e) return false; e.click(); return true; })()`);
const texto = (sel) => avaliar(`(${Q(sel)} || {}).textContent || ''`);
const digitar = (sel, t) => avaliar(`(() => { const e = ${Q(sel)}; const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(t)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const contar = (sel) => avaliar(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const clicarTexto = (sel, t) => avaliar(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(t)})); if (!e) return false; e.click(); return true; })()`);
const registro = async () => (await fetch(mock.base + '/_mock/log')).json();
const ultimo = async (rota) => (await registro()).filter((x) => x.rota === rota).at(-1);
const nRegistro = async (rota) => (await registro()).filter((x) => x.rota === rota).length;
const postMock = (rota, corpo = {}) => fetch(mock.base + rota, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base }, body: JSON.stringify(corpo) });
const codigoReal = async () => (await (await fetch(mock.base + '/_mock/codigo')).json()).codigo;
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
const irPara = async (hash) => { await avaliar(`location.hash = ${JSON.stringify(hash)}`); await dormir(150); };

// Alvos de toque dentro de um container visível: menores que 44 px viram erro.
async function alvosPequenos(raiz) {
  return avaliar(`(() => {
    const r = ${Q(raiz)};
    if (!r) return ['sem ' + ${JSON.stringify(raiz)}];
    const ruins = [];
    for (const e of r.querySelectorAll('button, a[href], select, input:not([type=hidden]):not([type=file]), textarea, summary, label.op')) {
      if (e.tagName === 'INPUT' && e.closest('label.op')) continue; // o alvo de toque é a linha inteira (label.op)
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(e).visibility === 'hidden') continue;
      if (b.height < 43.5 || b.width < 43.5) ruins.push((e.id || e.className || e.tagName) + ' ' + Math.round(b.width) + '×' + Math.round(b.height) + ' "' + e.textContent.trim().slice(0, 20) + '"');
    }
    return ruins;
  })()`);
}

// ─── ganchos injetados em toda página: CSP, "instalado" e Web Push simulado (o headless não assina de verdade) ───
const INJETADO = `
  window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));
  const marca = (k) => { try { return sessionStorage.getItem(k) === '1'; } catch { return false; } }; // about:blank nega o acesso
  if (marca('__standalone')) Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
  if (marca('__pushfalso')) {
    let permissao = 'default', assinatura = null;
    Object.defineProperty(Notification, 'permission', { get: () => permissao, configurable: true });
    Notification.requestPermission = async () => { permissao = 'granted'; window.__pedidoPermissao = (window.__pedidoPermissao || 0) + 1; return 'granted'; };
    PushManager.prototype.getSubscription = async () => assinatura;
    PushManager.prototype.subscribe = async function (o) {
      window.__subOpcoes = { userVisibleOnly: o.userVisibleOnly, bytesChave: o.applicationServerKey ? o.applicationServerKey.byteLength : 0 };
      const s = { endpoint: 'https://push.exemplo.test/abc', expirationTime: null, keys: { p256dh: 'BPk', auth: 'au' }, unsubscribe: async () => { assinatura = null; return true; } };
      s.toJSON = () => ({ endpoint: s.endpoint, expirationTime: null, keys: s.keys });
      assinatura = s;
      return s;
    };
  }`;

// Carrega a página de verdade (passando por about:blank, senão só mudar o #hash não recarrega).
async function abrirPagina(hash = '') {
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  await cdp('Page.navigate', { url: mock.base + '/m' + hash });
  await esperar('document.readyState === "complete"');
  await dormir(300);
}

try {
  mock = await subirMock({ porta: Number(process.env.GERENCIADOR_PORTA) || 47822 });
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar();
  for (const d of ['Page', 'Runtime', 'Log', 'DOM', 'ServiceWorker']) await cdp(d + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJETADO });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });

  // ═════════ 1. Parear ═════════
  await abrirPagina();
  conferir('abre em /m e mostra o pareamento (GET /remoto/eu deu 401)', await esperar(visivel('#v-parear')), await texto('#app'));
  conferir('nome padrão do aparelho é "iPhone"', (await avaliar(`${Q('#par-nome')}.value`)) === 'iPhone');
  conferir('manifesto, apple-touch-icon e viewport-fit=cover no HTML', await avaliar(`!!${Q('link[rel=manifest][href="/manifest-m.webmanifest"]')} && !!${Q('link[rel=apple-touch-icon]')} && /viewport-fit=cover/.test(${Q('meta[name=viewport]')}.content) && ${Q('meta[name=apple-mobile-web-app-capable]')}.content === 'yes'`));
  conferir('alvos de toque do pareamento >= 44 px', (await alvosPequenos('#v-parear')).length === 0, await alvosPequenos('#v-parear'));
  await foto('1-parear');
  await digitar('#par-nome', 'iPhone de teste');
  await clicar('#par-pedir');
  conferir('Parear → pede o código de 6 dígitos', await esperar(visivel('#par-f2')));
  conferir('campo do código: numérico e one-time-code', await avaliar(`${Q('#par-codigo')}.inputMode === 'numeric' && ${Q('#par-codigo')}.autocomplete === 'one-time-code' && ${Q('#par-codigo')}.maxLength === 6`));
  conferir('mostra a expiração (Expira em m:ss)', /Expira em \d:\d\d/.test(await texto('#par-expira')), await texto('#par-expira'));
  conferir('pedido enviou o nome do aparelho', (await ultimo('/remoto/parear/pedir'))?.corpo?.nome === 'iPhone de teste');
  await foto('1-codigo');
  const certo1 = await codigoReal();
  await digitar('#par-codigo', certo1 === '111111' ? '222222' : '111111');
  conferir('código errado → mensagem de erro', await esperar(`/errado/i.test(${Q('#par-erro')}.textContent) && !${Q('#par-erro')}.hidden`), await texto('#par-erro'));
  conferir('após o erro o campo limpa e segue no passo do código', (await avaliar(`${Q('#par-codigo')}.value`)) === '' && (await avaliar(visivel('#par-f2'))));
  await postMock('/_mock/expirar');
  await digitar('#par-codigo', certo1);
  conferir('código expirado → mensagem e volta ao passo do nome', await esperar(`/expirou/i.test(${Q('#par-erro')}.textContent) && !${Q('#par-f1')}.hidden`), await texto('#par-erro'));
  await clicar('#par-pedir');
  conferir('novo pedido depois de expirar', await esperar(visivel('#par-f2')));
  const certo2 = await codigoReal();
  conferir('novo código gerado pelo PC', !!certo2);
  await digitar('#par-codigo', certo2);

  // ═════════ 2. Sessões ═════════
  conferir('código certo → entra na lista de sessões', await esperar(visivel('#v-principal') + ' && ' + `document.querySelectorAll('.card').length >= 6`), await texto('#app'));
  conferir('confirmar enviou {pedido, codigo}', (await ultimo('/remoto/parear/confirmar'))?.corpo?.codigo === certo2);
  conferir('"Precisa de você" é o primeiro grupo, com 3 cartões', await avaliar(`(() => { const g = [...document.querySelectorAll('.grupo:not([hidden])')]; return g[0].dataset.g === 'precisa' && /Precisa de você/.test(g[0].textContent) && g[0].querySelectorAll('.card').length === 3 && g[1].dataset.g === 'trabalhando' && g[2].dataset.g === 'paradas'; })()`));
  conferir('o que espera há mais tempo vem primeiro', await avaliar(`document.querySelector('.grupo[data-g=precisa] .card .card-nome').textContent.includes('testes do pareamento')`));
  conferir('cartão mostra projeto, status, detalhe e tempo', await avaliar(`(() => { const c = document.querySelector('.grupo[data-g=precisa] .card'); return /Orbit/.test(c.textContent) && /Aguardando você/.test(c.textContent) && /Pede permissão: Bash/.test(c.textContent) && /\\d+ min/.test(c.textContent); })()`));
  conferir('pergunta e plano aparecem como tal', await avaliar(`/Fez uma pergunta/.test(document.body.textContent) && /Plano para aprovar/.test(document.body.textContent)`));
  conferir('Paradas traz a concluída e a nova', await avaliar(`document.querySelectorAll('.grupo[data-g=paradas] .card').length === 2`));
  conferir('título da aba e selo "3" em Sessões', (await avaliar('document.title')) === '(3) Orbit' && (await texto('#aba-sessoes .conta')) === '3');
  conferir('botão "Nova instância" visível (criarInstancias)', await avaliar(visivel('#btn-nova')));
  conferir('lista: alvos de toque >= 44 px', (await alvosPequenos('#v-principal')).length === 0, await alvosPequenos('#v-principal'));
  conferir('lista: sem rolagem lateral em 390 px', await semRolagemLateral());
  conferir('cartão no visual do PC: avatar com sprite carregado, selo de status, pílula da base e fundo --sup', await esperar(`(() => { const c = document.querySelector('.grupo[data-g=precisa] .card'); const i = c.querySelector('.av-robo img.spr'); return !!i && /^\\/assets\\/sprites\\/sprite-[\\w-]+\\.(gif|png)$/.test(i.getAttribute('src')) && i.complete && i.naturalWidth > 0 && !!c.querySelector('.av-selo') && !!c.querySelector('.pilula[data-s=aguardando] svg') && getComputedStyle(c).backgroundColor === 'rgb(29, 29, 29)'; })()`), await avaliar(`document.querySelector('.card').outerHTML.slice(0, 500)`));
  // Faixa preta (iPhone, PWA): a barra inferior vai até o fim da tela e o fundo dela cobre a área segura de baixo.
  conferir('safe-area: viewport-fit=cover, tela e barra inferior coladas ao fundo do viewport', await avaliar(`(() => { const n = document.querySelector('.abas').getBoundingClientRect(); const a = document.getElementById('app').getBoundingClientRect(); return /viewport-fit=cover/.test(document.querySelector('meta[name=viewport]').content) && Math.abs(n.bottom - innerHeight) <= 1 && Math.abs(a.bottom - innerHeight) <= 1 && getComputedStyle(document.querySelector('.abas')).backgroundColor === 'rgb(17, 17, 17)'; })()`), await avaliar(`JSON.stringify([document.querySelector('.abas').getBoundingClientRect().bottom, innerHeight])`));
  conferir('safe-area: .abas tem padding-bottom com env(safe-area-inset-bottom) e #app não fixa altura', await avaliar(`fetch('/m/mobile.css').then((r) => r.text()).then((t) => /\\.abas \\{[^}]*padding:[^;}]*calc\\(var\\(--sb\\) \\+ 6px\\)/.test(t) && /--sb: env\\(safe-area-inset-bottom/.test(t) && /#app \\{ position: fixed; inset: 0;[^}]*\\}/.test(t) && !/(^|\\n)#app \\{[^}]*height:/.test(t))`));
  await foto('2-sessoes');
  // Filtro por projeto na aba Sessões
  const chipsTxt = `[...document.querySelectorAll('#lista-sessoes .filtro-proj')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join('|')`;
  const cartoes = `document.querySelectorAll('#lista-sessoes .card').length`;
  const gruposVis = `[...document.querySelectorAll('.grupo:not([hidden])')].map((g) => g.dataset.g).join(',')`;
  conferir('filtro: chips Todos + um por projeto, com as contagens do mock', (await avaliar(chipsTxt)) === 'Todos6|Cliente Exemplo1|Diário1|Loja Online2|Orbit2', await avaliar(chipsTxt));
  conferir('filtro: "Todos" é o padrão (marcado) e os chips usam .chip com alvo >= 44 px', await avaliar(`(() => { const c = [...document.querySelectorAll('#lista-sessoes .filtro-proj')]; return c[0].getAttribute('aria-pressed') === 'true' && c.every((x) => x.classList.contains('chip') && x.getBoundingClientRect().height >= 44); })()`));
  await avaliar(`[...document.querySelectorAll('#lista-sessoes .filtro-proj')].find((c) => /^Orbit/.test(c.textContent)).click()`);
  conferir('filtro: Orbit mostra só os 2 cartões do projeto, mantendo os grupos (vazios somem)', (await avaliar(cartoes)) === 2 && (await avaliar(gruposVis)) === 'precisa,paradas' && await avaliar(`[...document.querySelectorAll('#lista-sessoes .card-proj')].every((e) => e.textContent === 'Orbit')`), await avaliar(gruposVis));
  conferir('filtro: selo da aba e título seguem contando todas as sessões', (await avaliar('document.title')) === '(3) Orbit' && (await texto('#aba-sessoes .conta')) === '3');
  conferir('filtro: sem rolagem lateral com o filtro ligado', await semRolagemLateral());
  await avaliar(`[...document.querySelectorAll('#lista-sessoes .filtro-proj')].find((c) => /^Loja/.test(c.textContent)).click()`);
  await abrirPagina();
  conferir('filtro: a escolha persiste após recarregar', await esperar(`${cartoes} === 2 && [...document.querySelectorAll('#lista-sessoes .card-proj')].every((e) => e.textContent === 'Loja Online')`), await avaliar(cartoes));
  await clicar('#btn-nova');
  conferir('filtro: "Nova instância" abre já com o projeto escolhido', await esperar(visivel('#v-nova') + ` && ${Q('#nova-projeto')}.value === 'D:\\\\Projetos\\\\Loja'`), await avaliar(`${Q('#nova-projeto')}.value`));
  await abrirPagina();
  await avaliar(`[...document.querySelectorAll('#lista-sessoes .filtro-proj')].find((c) => c.dataset.k === 'todos').click()`);
  conferir('filtro: "Todos" volta tudo e limpa a escolha', (await avaliar(cartoes)) === 6 && (await avaliar('localStorage.getItem("orbit.sessoes.projeto")')) === null);
  await avaliar(`localStorage.setItem('orbit.sessoes.projeto', 'd:/projetos/sumiu')`);
  await abrirPagina();
  conferir('filtro: projeto que sumiu volta para "Todos"', await esperar(`${cartoes} === 6 && document.querySelector('#lista-sessoes .filtro-proj').getAttribute('aria-pressed') === 'true'`));
  await postMock('/_mock/mudar', { id: 's4', status: 'aguardando', controle: { permissao: { id: 'perm-4', tipo: 'ferramenta', ferramenta: 'Edit', resumo: 'Diario.tsx' }, pendentes: 1 } });
  conferir('ao vivo: sessão que passa a aguardar entra em "Precisa de você"', await esperar(`document.querySelectorAll('.grupo[data-g=precisa] .card').length === 4 && document.title === '(4) Orbit'`), await contar('.grupo[data-g=precisa] .card'));
  await postMock('/_mock/mudar', { id: 's4', status: 'trabalhando', controle: { permissao: null, pendentes: null } });
  conferir('ao vivo: volta a "Trabalhando"', await esperar(`document.querySelectorAll('.grupo[data-g=precisa] .card').length === 3 && document.querySelectorAll('.grupo[data-g=trabalhando] .card').length === 1`));

  // ═════════ 3. Sessão: permissão ═════════
  await clicar('.card[href="#s=s1"]');
  conferir('abrir sessão: tela da sessão com #s=s1', await esperar(visivel('#v-sessao')) && (await avaliar('location.hash')) === '#s=s1');
  conferir('cabeçalho: projeto e nome', (await texto('#s-proj')) === 'Orbit' && /testes do pareamento/.test(await texto('#s-nome')), await texto('#s-nome'));
  conferir('conversa carregada (usuário, texto formatado, código, ferramentas)', await esperar(`document.querySelectorAll('#cv-itens > *').length === 4 && !!document.querySelector('#cv-itens .it-usuario') && !!document.querySelector('#cv-itens .md li') && !!document.querySelector('#cv-itens .md pre code') && document.querySelectorAll('#cv-itens .it-ferr').length === 2`), await contar('#cv-itens > *'));
  conferir('cartão de permissão: ferramenta e comando', await esperar(visivel('#cv-perm')) && /Bash/.test(await texto('#cv-perm .perm-chip')) && /npm test/.test(await texto('#cv-perm .perm-resumo')), await texto('#cv-perm'));
  conferir('Permitir e Negar com alvo de toque >= 44 px', (await alvosPequenos('#cv-perm')).length === 0, await alvosPequenos('#cv-perm'));
  conferir('sessão: alvos de toque do restante >= 44 px', (await alvosPequenos('#v-sessao')).length === 0, await alvosPequenos('#v-sessao'));
  conferir('sessão: sem rolagem lateral', await semRolagemLateral());
  await foto('3-sessao-permissao');
  await clicarTexto('#cv-perm button', 'Permitir');
  conferir('Permitir → POST /permissao {id, decisao:"permitir"}', await esperar(`${Q('#cv-perm')}.hidden`) && JSON.stringify((await ultimo('/sessao/s1/permissao'))?.corpo) === JSON.stringify({ id: 'perm-1', decisao: 'permitir' }), JSON.stringify(await ultimo('/sessao/s1/permissao')));
  conferir('após permitir o cartão some e o status vira Trabalhando', await esperar(`${Q('#cv-perm')}.hidden && /Trabalhando/.test(${Q('#s-pill')}.textContent)`));
  conferir('barra "Trabalhando…" com Parar quando ocupada', await avaliar(visivel('#cv-estado')) && await avaliar(visivel('#cv-parar')));
  await clicar('#s-voltar');
  conferir('Voltar → lista (2 ainda precisam de você)', await esperar(visivel('#v-principal') + ` && document.querySelectorAll('.grupo[data-g=precisa] .card').length === 2`));

  // ═════════ pergunta ═════════
  await clicar('.card[href="#s=s2"]');
  conferir('pergunta: opções do AskUserQuestion', await esperar(visivel('#cv-perm') + ` && document.querySelectorAll('#cv-perm .op').length === 3`) && /Qual banco usar\?/.test(await texto('#cv-perm')), await texto('#cv-perm'));
  conferir('pergunta: alvos de toque >= 44 px', (await alvosPequenos('#cv-perm')).length === 0, await alvosPequenos('#cv-perm'));
  await foto('3-sessao-pergunta');
  await clicarTexto('#cv-perm button', 'Responder');
  conferir('Responder sem escolher → pede a escolha e não envia', /Escolha uma resposta/.test(await texto('.perm-erro')) && (await nRegistro('/sessao/s2/permissao')) === 0);
  await clicarTexto('#cv-perm .op', 'Postgres');
  await clicarTexto('#cv-perm button', 'Responder');
  conferir('Responder → {id, decisao:"permitir", respostas:{pergunta: rótulo}}', await esperar(`${Q('#cv-perm')}.hidden`) && JSON.stringify((await ultimo('/sessao/s2/permissao'))?.corpo) === JSON.stringify({ id: 'perm-2', decisao: 'permitir', respostas: { 'Qual banco usar?': 'Postgres' } }), JSON.stringify(await ultimo('/sessao/s2/permissao')));
  await clicar('#s-voltar');

  // ═════════ plano ═════════
  await esperar(visivel('#v-principal'));
  await clicar('.card[href="#s=s3"]');
  conferir('plano: texto do plano formatado e botões', await esperar(visivel('#cv-perm') + ` && !!document.querySelector('#cv-perm .perm-plano li') && !!document.querySelector('#cv-perm .perm-plano strong')`) && /Aprovar e aceitar edições/.test(await texto('#cv-perm')) && /Continuar planejando/.test(await texto('#cv-perm')));
  await foto('3-sessao-plano');
  await clicarTexto('#cv-perm button', 'Aprovar e aceitar edições');
  conferir('Aprovar e aceitar edições → {decisao:"permitir", sugestao:0}', await esperar(`${Q('#cv-perm')}.hidden`) && JSON.stringify((await ultimo('/sessao/s3/permissao'))?.corpo) === JSON.stringify({ id: 'perm-3', decisao: 'permitir', sugestao: 0 }), JSON.stringify(await ultimo('/sessao/s3/permissao')));
  await clicar('#s-voltar');

  // ═════════ mensagem, anteriores, foto, parar, modelo ═════════
  await esperar(visivel('#v-principal'));
  await clicar('.card[href="#s=s4"]');
  conferir('conversa mostra as mais recentes (40 de 70)', await esperar(`document.querySelectorAll('#cv-itens > *').length === 40`) && await avaliar(visivel('#cv-mais')), await contar('#cv-itens > *'));
  await avaliar(`document.getElementById('cv-rolagem').scrollTop = 0`);
  await clicar('#cv-mais');
  conferir('"Carregar anteriores" traz o resto e some o botão', await esperar(`document.querySelectorAll('#cv-itens > *').length === 70 && ${Q('#cv-mais')}.hidden`), await contar('#cv-itens > *'));
  conferir('o mais antigo fica no topo (ordem preservada)', await avaliar(`document.querySelector('#cv-itens > *').textContent.includes('Pergunta número 1')`));
  await avaliar(`document.getElementById('cv-rolagem').scrollTop = 1e6`);
  conferir('Enviar começa desabilitado (campo vazio)', await avaliar(`${Q('#cv-enviar')}.disabled`));
  // composer colado ao fundo: o fundo dele cobre a área segura (padding-bottom com env), sem faixa vazia embaixo
  conferir('conversa: composer encosta no fundo do viewport e #app vai até o fim', await avaliar(`(() => { const c = ${Q('#cv-comp')}.getBoundingClientRect(), a = ${Q('#app')}.getBoundingClientRect(), s = ${Q('#v-sessao')}.getBoundingClientRect(); return Math.abs(c.bottom - innerHeight) <= 1 && Math.abs(a.bottom - innerHeight) <= 1 && Math.abs(s.bottom - innerHeight) <= 1 && !document.documentElement.classList.contains('tec'); })()`), await avaliar(`JSON.stringify([${Q('#cv-comp')}.getBoundingClientRect().bottom, innerHeight, document.documentElement.className])`));
  conferir('conversa: .cv-comp tem padding-bottom com env(safe-area-inset-bottom)', await avaliar(`fetch('/m/mobile.css').then((r) => r.text()).then((t) => /\\.cv-comp \\{[^}]*padding:[^;}]*calc\\(var\\(--sb\\) \\+ 8px\\)/.test(t) && /--sb: env\\(safe-area-inset-bottom/.test(t) && /html\\.tec \\{ --sb: 0px; \\}/.test(t))`));
  // teclado simulado: janela visual menor (500 px) e deslocada (offsetTop 120, como o iOS faz ao rolar para o campo)
  const vvSim = (h, top) => avaliar(`(() => { const v = visualViewport; if (${h} === null) { delete v.height; delete v.offsetTop; } else { Object.defineProperty(v, 'height', { configurable: true, get: () => ${h} }); Object.defineProperty(v, 'offsetTop', { configurable: true, get: () => ${top} }); } v.dispatchEvent(new Event('resize')); return true; })()`);
  await vvSim(500, 120);
  await dormir(100);
  conferir('teclado sem campo focado não liga html.tec (não fica preso)', await avaliar(`!document.documentElement.classList.contains('tec') && Math.abs(${Q('#app')}.getBoundingClientRect().bottom - innerHeight) <= 1`));
  await avaliar(`${Q('#cv-texto')}.focus()`);
  await vvSim(500, 120);
  const tecOk = `(() => { const c = ${Q('#cv-comp')}.getBoundingClientRect(), a = ${Q('#app')}.getBoundingClientRect(); return document.documentElement.classList.contains('tec') && Math.abs(a.top - 120) <= 1 && Math.abs(a.height - 500) <= 1 && c.top >= 120 && Math.abs(c.bottom - 620) <= 1 && getComputedStyle(${Q('#cv-comp')}).paddingBottom === '8px' && getComputedStyle(document.documentElement).getPropertyValue('--sb').trim() === '0px'; })()`;
  const tecInfo = `JSON.stringify({ cls: document.documentElement.className, app: ${Q('#app')}.getBoundingClientRect(), comp: ${Q('#cv-comp')}.getBoundingClientRect(), pb: getComputedStyle(${Q('#cv-comp')}).paddingBottom })`;
  conferir('teclado aberto: composer fica dentro da janela visual, logo acima do teclado, sem área segura', await esperar(tecOk, 2000), await avaliar(tecInfo));
  await dormir(700); // rechecagens atrasadas do focusin não podem desfazer
  conferir('teclado aberto: continua acima do teclado depois das rechecagens', await avaliar(tecOk), await avaliar(tecInfo));
  await avaliar(`${Q('#cv-texto')}.blur()`);
  await vvSim(null);
  conferir('teclado fechado: volta a inset 0, composer no fundo, documento no topo', await esperar(`!document.documentElement.classList.contains('tec') && Math.abs(${Q('#cv-comp')}.getBoundingClientRect().bottom - innerHeight) <= 1 && scrollY === 0`, 2000), await avaliar(tecInfo));
  await digitar('#cv-texto', 'olá do celular');
  conferir('digitar habilita o envio', await avaliar(`!${Q('#cv-enviar')}.disabled`));
  // composer em cartão: raio grande, margem lateral, campo sem borda, alvos >= 44 px
  conferir('composer: cartão único arredondado com margem lateral e campo sem borda', await avaliar(`(() => { const c = ${Q('#cv-cartao')}, cs = getComputedStyle(c), r = c.getBoundingClientRect(), t = getComputedStyle(${Q('#cv-texto')}); return c.contains(${Q('#cv-texto')}) && c.contains(${Q('#cv-enviar')}) && c.contains(${Q('#cv-foto')}) && parseFloat(cs.borderTopLeftRadius) >= 22 && r.left >= 10 && innerWidth - r.right >= 10 && t.borderTopWidth === '0px'; })()`), await avaliar(`JSON.stringify(${Q('#cv-cartao')}.getBoundingClientRect())`));
  conferir('composer: "+", medidor e enviar com alvo >= 44 px', (await alvosPequenos('#cv-cartao')).length === 0, await alvosPequenos('#cv-cartao'));
  conferir('composer: "+" tem a função de anexo (abre o seletor de foto)', await avaliar(`(() => { const i = ${Q('#cv-arq')}; let abriu = false; const o = i.click; i.click = () => { abriu = true; }; ${Q('#cv-foto')}.click(); i.click = o; return abriu && ${Q('#cv-foto')}.getAttribute('aria-label') === 'Anexar foto' && !!${Q('#cv-foto')}.querySelector('svg'); })()`));
  conferir('medidor de contexto: com dado mostra o percentual (40%) e o anel proporcional', await avaliar(`(() => { const m = ${Q('#cv-medidor')}, p = m.querySelector('.pr'); const [a, b] = p.getAttribute('stroke-dasharray').split(' ').map(Number); return !m.hidden && m.dataset.pct === '40' && /40%/.test(m.getAttribute('aria-label')) && Math.abs(a / b - 0.4) < 0.01; })()`), await avaliar(`${Q('#cv-medidor')}.outerHTML`));
  await clicar('#cv-medidor');
  conferir('medidor: toque mostra o percentual e os tokens', await esperar(`/40%.*400 mil tokens/.test(document.querySelector('.toast')?.textContent || '')`, 2000), await avaliar(`document.querySelector('.toast')?.textContent`));
  await postMock('/_mock/mudar', { id: 's4', contexto: null });
  conferir('medidor: sem dado de contexto fica oculto', await esperar(`${Q('#cv-medidor')}.hidden`, 3000));
  await postMock('/_mock/mudar', { id: 's4', contexto: { tokens: 800000, modelo: 'claude-sonnet-5-5', janela: 1000000, pct: 80 } });
  conferir('medidor: volta com o dado novo (80%)', await esperar(`!${Q('#cv-medidor')}.hidden && ${Q('#cv-medidor')}.dataset.pct === '80'`, 3000));
  // campo cresce até o limite e depois rola
  const altura = (n) => avaliar(`(() => { const t = ${Q('#cv-texto')}; t.value = ${JSON.stringify('')} + Array(${n}).fill('linha').join('\\n'); t.dispatchEvent(new Event('input', { bubbles: true })); return t.getBoundingClientRect().height; })()`);
  const h1 = await altura(1), h3 = await altura(3), h20 = await altura(20), h40 = await altura(40);
  conferir('campo cresce com o texto até o limite e depois rola', h3 > h1 && h20 > h3 && h20 === h40 && h40 <= 150 && await avaliar(`${Q('#cv-texto')}.scrollHeight > ${Q('#cv-texto')}.clientHeight`), JSON.stringify([h1, h3, h20, h40]));
  await avaliar(`(() => { const t = ${Q('#cv-texto')}; t.value = 'olá do celular'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await clicar('#cv-enviar');
  conferir('mensagem → POST /mensagem {texto}', await (async () => { for (let i = 0; i < 30; i++) { if ((await ultimo('/sessao/s4/mensagem'))?.corpo?.texto === 'olá do celular') return true; await dormir(100); } return false; })(), JSON.stringify(await ultimo('/sessao/s4/mensagem')));
  conferir('resposta do agente chega ao vivo (parcial e final)', await esperar(`document.querySelector('#cv-itens').textContent.includes('Feito. Recebi: olá do celular')`, 6000));
  conferir('a mensagem aparece uma vez só (sem duplicar a otimista)', (await avaliar(`[...document.querySelectorAll('#cv-itens .it-usuario')].filter((e) => e.textContent.includes('olá do celular')).length`)) === 1);
  conferir('campo de mensagem limpo depois de enviar', (await avaliar(`${Q('#cv-texto')}.value`)) === '');
  await foto('3-sessao-mensagem');
  // foto: anexa um PNG real pelo input de arquivo
  const doc = (await cdp('DOM.getDocument', { depth: 0 })).result.root.nodeId;
  const no = (await cdp('DOM.querySelector', { nodeId: doc, selector: '#cv-arq' })).result.nodeId;
  await cdp('DOM.setFileInputFiles', { nodeId: no, files: [path.join(PASTA, 'assets', 'pwa', 'icone-192.png')] });
  conferir('foto anexada aparece em miniatura', await esperar(`!!document.querySelector('#cv-faixa .cv-miniatura img') && !${Q('#cv-enviar')}.disabled`));
  await clicar('#cv-enviar');
  const msgFoto = await (async () => { for (let i = 0; i < 40; i++) { const u = await ultimo('/sessao/s4/mensagem'); if (u?.corpo?.imagens) return u; await dormir(100); } return null; })();
  conferir('envio com foto: imagens[{tipo:"image/jpeg", dados:base64}]', msgFoto && msgFoto.corpo.imagens.length === 1 && msgFoto.corpo.imagens[0].tipo === 'image/jpeg' && msgFoto.corpo.imagens[0].dados.length > 200 && /^[A-Za-z0-9+/]+=*$/.test(msgFoto.corpo.imagens[0].dados) && msgFoto.corpo.texto === '', JSON.stringify(msgFoto).slice(0, 200));
  conferir('a foto sai da faixa depois de enviar', await esperar(`${Q('#cv-faixa')}.hidden`));
  conferir('a resposta parcial vira o item final (sem ficar "escrevendo" para sempre)', await esperar(`document.querySelector('#cv-itens').textContent.includes('Recebi: (foto)') && !document.querySelector('#cv-itens [data-parcial="1"]')`, 6000), await texto('#cv-itens > :last-child'));
  // parar
  await esperar(`${Q('#cv-estado')}.hidden`, 4000);
  await postMock('/_mock/mudar', { id: 's4', status: 'trabalhando', controle: { ocupada: true } });
  conferir('ocupada → barra com botão Parar', await esperar(visivel('#cv-estado')));
  await clicar('#cv-parar');
  conferir('Parar → POST /parar', await (async () => { for (let i = 0; i < 30; i++) { if (await ultimo('/sessao/s4/parar')) return true; await dormir(100); } return false; })());
  // modelo e esforço
  await clicar('#cv-aj > summary');
  conferir('Modelo e esforço: seletores com o valor atual', await esperar(visivel('#cv-modelo')) && (await avaliar(`${Q('#cv-modelo')}.value`)) === 'default' && (await avaliar(`${Q('#cv-esforco')}.value`)) === 'high');
  conferir('seletores de modelo/esforço com alvo >= 44 px', (await alvosPequenos('#cv-aj')).length === 0, await alvosPequenos('#cv-aj'));
  await avaliar(`(() => { const s = ${Q('#cv-modelo')}; s.value = 'sonnet'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  conferir('trocar modelo → POST /modelo {modelo}', await (async () => { for (let i = 0; i < 30; i++) { if ((await ultimo('/sessao/s4/modelo'))?.corpo?.modelo === 'sonnet') return true; await dormir(100); } return false; })());
  await esperar(`!${Q('#cv-esforco')}.disabled`);
  await avaliar(`(() => { const s = ${Q('#cv-esforco')}; s.value = 'medium'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  conferir('trocar esforço → POST /esforco {esforco}', await (async () => { for (let i = 0; i < 30; i++) { if ((await ultimo('/sessao/s4/esforco'))?.corpo?.esforco === 'medium') return true; await dormir(100); } return false; })());
  await foto('3-sessao-ajustes');

  // ═════════ abrir direto por #s=<id> (clique da notificação) ═════════
  await abrirPagina('#s=s2');
  conferir('abre direto na sessão por #s=s2 (já pareado)', await esperar(visivel('#v-sessao') + ` && /banco de dados/.test(${Q('#s-nome')}.textContent)`), await texto('#app'));
  conferir('direto: conversa carregada', await esperar(`document.querySelectorAll('#cv-itens > *').length === 2`));
  await abrirPagina('#s=nao-existe');
  conferir('sessão inexistente → aviso (sem quebrar)', await esperar(`/não está mais disponível/.test(${Q('#cv-vazio')}.textContent)`), await texto('#cv-vazio'));

  // ═════════ 4. Uso do plano ═════════
  await abrirPagina('#uso');
  conferir('aba Uso mostra as duas janelas com os percentuais', await esperar(visivel('#p-uso') + ` && document.querySelectorAll('.uso-cartao').length === 2`) && (await avaliar(`[...document.querySelectorAll('.uso-val')].map((e) => e.textContent).join()`)) === '42%,27%');
  conferir('barras usam a escala de cores do PC (degradê verde → cor do percentual, OrbitBase)', await avaliar(`(() => { const b = document.querySelectorAll('.trilho i'); return /uso-verde/.test(b[0].style.background) && !/uso-amarelo|uso-vermelho/.test(b[0].style.background); })()`), await avaliar(`[...document.querySelectorAll('.trilho i')].map((e) => e.style.background).join(' | ')`));
  conferir('barras com a largura do percentual e meter acessível', await avaliar(`(() => { const t = document.querySelectorAll('.trilho'); return t[0].firstChild.style.width === '42%' && t[1].firstChild.style.width === '27%' && t[0].getAttribute('aria-valuenow') === '42'; })()`));
  conferir('mostra quando renova (renova em … · …)', await avaliar(`/renova em 2 h/.test(document.querySelectorAll('.uso-ren')[0].textContent) && /renova em 2 d/.test(document.querySelectorAll('.uso-ren')[1].textContent)`), await texto('#uso-barras'));
  conferir('mostra a idade da leitura', /Última leitura há \d+ min/.test(await texto('#uso-sub')), await texto('#uso-sub'));
  conferir('uso: alvos >= 44 px e sem rolagem lateral', (await alvosPequenos('#v-principal')).length === 0 && await semRolagemLateral(), await alvosPequenos('#v-principal'));
  await foto('4-uso');
  await postMock('/_mock/uso', { cincoHoras: { pct: 91, renova: Date.now() + 3600e3 }, semanal: { pct: 65, renova: Date.now() + 86400e3 }, atualizado: Date.now() });
  conferir('uso atualiza ao vivo (evento uso do /fluxo) e fica vermelho perto do limite', await esperar(`(() => { const t = document.querySelectorAll('.trilho'); return t.length === 2 && t[0].firstChild.style.width === '91%' && /uso-vermelho/.test(t[0].firstChild.style.background) && /uso-roxo/.test(t[0].firstChild.style.background) && !/uso-roxo/.test(t[1].firstChild.style.background) && /uso-amarelo/.test(t[1].firstChild.style.background); })()`), await avaliar(`[...document.querySelectorAll('.trilho i')].map((e) => e.style.background).join(' | ')`));

  // ═════════ 5. Este aparelho ═════════
  await irPara('#aparelho');
  conferir('Este aparelho: nome do aparelho pareado', await esperar(visivel('#p-aparelho') + ` && ${Q('#ap-nome')}.textContent === 'iPhone de teste'`), await texto('#ap-nome'));
  conferir('fora da Tela de Início: explica Compartilhar → Adicionar à Tela de Início e que o push só funciona assim', await esperar(visivel('#ap-instalar')) && /Compartilhar/.test(await texto('#ap-instalar')) && /Adicionar à Tela de Início/.test(await texto('#ap-instalar')) && /só funcionam com o Orbit instalado/.test(await texto('#ap-instalar')) && /só chegam com o Orbit instalado/.test(await texto('#ap-notif-txt')), await texto('#p-aparelho'));
  conferir('"Nova instância" só aparece na aba Sessões', !(await avaliar(visivel('#btn-nova'))));
  conferir('fora da Tela de Início: não oferece ativar', !(await avaliar(visivel('#ap-ativar'))));
  conferir('aparelho: alvos de toque >= 44 px', (await alvosPequenos('#p-aparelho')).length === 0, await alvosPequenos('#p-aparelho'));
  await foto('5-aparelho-instalar');
  await avaliar(`sessionStorage.setItem('__standalone', '1'); sessionStorage.setItem('__pushfalso', '1'); true`);
  await abrirPagina('#aparelho');
  conferir('instalado: some a explicação e aparece "Ativar notificações"', await esperar(visivel('#p-aparelho') + ` && ${Q('#ap-instalar')}.hidden && !${Q('#ap-ativar')}.hidden`));
  await foto('5-aparelho-ativar');
  await clicar('#ap-ativar');
  conferir('Ativar: pede permissão num toque, assina com userVisibleOnly e a chave VAPID (65 bytes)', await esperar(`!${Q('#ap-testar')}.hidden`) && (await avaliar('window.__pedidoPermissao')) === 1 && (await avaliar('JSON.stringify(window.__subOpcoes)')) === JSON.stringify({ userVisibleOnly: true, bytesChave: 65 }), await avaliar('JSON.stringify(window.__subOpcoes)'));
  const assinatura = (await ultimo('/remoto/push/assinar'))?.corpo;
  conferir('POST /remoto/push/assinar {assinatura:{endpoint,keys}}', assinatura?.assinatura?.endpoint === 'https://push.exemplo.test/abc' && !!assinatura.assinatura.keys, JSON.stringify(assinatura));
  conferir('estado "Ativadas neste aparelho"', /Ativadas/.test(await texto('#ap-notif-estado-txt')));
  await clicar('#ap-testar');
  conferir('Testar → POST /remoto/push/teste', await (async () => { for (let i = 0; i < 30; i++) { if (await ultimo('/remoto/push/teste')) return true; await dormir(100); } return false; })());
  // O service worker recebe o push (entregue pelo DevTools) e mostra a notificação com título, tag e url.
  await cdp('Browser.grantPermissions', { origin: mock.base, permissions: ['notifications'] });
  const regId = registros.get(mock.base + '/');
  if (regId) {
    await cdp('ServiceWorker.deliverPushMessage', { origin: mock.base, registrationId: regId, data: JSON.stringify({ titulo: 'Orbit · Orbit · precisa de você', corpo: '', url: '/m#s=s1', tag: 's-s1' }) });
    await dormir(500);
    const nots = await avaliar(`navigator.serviceWorker.getRegistration().then((r) => r.getNotifications()).then((l) => l.map((n) => ({ titulo: n.title, tag: n.tag, url: n.data && n.data.url, corpo: n.body })))`);
    conferir('service worker: push mostra "Orbit · … · precisa de você" com tag s-<id> e url /m#s=<id>', nots?.length === 1 && nots[0].titulo === 'Orbit · Orbit · precisa de você' && nots[0].tag === 's-s1' && nots[0].url === '/m#s=s1', JSON.stringify(nots));
  } else {
    conferir('service worker: push entregue', false, 'registro do service worker não encontrado: ' + JSON.stringify([...registros]));
  }
  await clicar('#ap-desativar');
  conferir('Desativar → POST /remoto/push/cancelar e volta o botão Ativar', await esperar(`!${Q('#ap-ativar')}.hidden && ${Q('#ap-testar')}.hidden`) && !!(await ultimo('/remoto/push/cancelar')) && mock.estado.push === null);

  // ═════════ nova instância ═════════
  await irPara('#sessoes');
  await clicar('#btn-nova');
  conferir('Nova instância: lista os projetos do /remoto/projetos', await esperar(visivel('#v-nova') + ` && document.querySelectorAll('#nova-projeto option').length === 2 && document.querySelectorAll('#nova-modelo option').length === 3 && !${Q('#nova-criar')}.disabled`));
  conferir('Nova instância: alvos de toque >= 44 px', (await alvosPequenos('#v-nova')).length === 0, await alvosPequenos('#v-nova'));
  await foto('2-nova-instancia');
  await avaliar(`(() => { ${Q('#nova-projeto')}.selectedIndex = 1; const m = ${Q('#nova-modelo')}; m.value = 'sonnet'; m.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await digitar('#nova-texto', 'Monte o checkout');
  await clicar('#nova-criar');
  const inst = await (async () => { for (let i = 0; i < 30; i++) { const u = await ultimo('/instancias'); if (u) return u; await dormir(100); } return null; })();
  conferir('POST /instancias com pasta/cwd do projeto, modelo, permissão e texto', inst?.corpo?.pasta === 'D:\\Projetos\\Loja' && inst.corpo.cwd === inst.corpo.pasta && inst.corpo.modelo === 'sonnet' && inst.corpo.permissao === 'default' && inst.corpo.texto === 'Monte o checkout', JSON.stringify(inst));
  conferir('depois de criar, abre a sessão nova', await esperar(visivel('#v-sessao') + ` && ${Q('#s-proj')}.textContent === 'Loja Online' && location.hash === '#s=s7'`), await texto('#app'));

  // ═════════ largura mínima e sair ═════════
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await dormir(300);
  conferir('sessão sem rolagem lateral em 320 px', await semRolagemLateral());
  await irPara('#sessoes');
  await dormir(200);
  conferir('lista sem rolagem lateral em 320 px', await semRolagemLateral());
  await foto('2-sessoes-320');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await irPara('#aparelho');
  await clicar('#ap-sair');
  conferir('Sair pede confirmação', await esperar(visivel('#ap-sair-conf')) && !(await ultimo('/remoto/sair')));
  await clicar('#ap-sair-sim');
  conferir('Sair → POST /remoto/sair e volta ao pareamento', await esperar(visivel('#v-parear')) && !!(await ultimo('/remoto/sair')));
  conferir('após sair o servidor não guarda mais o aparelho (token revogado)', mock.estado.tokens.size === 0);
  // bloqueio: 5 códigos errados
  await clicar('#par-pedir');
  await esperar(visivel('#par-f2'));
  const real3 = await codigoReal();
  const errado = real3 === '123456' ? '654321' : '123456';
  const antesDosErros = await nRegistro('/remoto/parear/confirmar');
  for (let i = 1; i <= 5; i++) {
    await digitar('#par-codigo', errado);
    for (let k = 0; k < 40 && (await nRegistro('/remoto/parear/confirmar')) < antesDosErros + i; k++) await dormir(100);
    await dormir(250);
  }
  conferir('5 códigos errados → "bloqueado por 10 minutos"', await esperar(`/10 minutos/.test(${Q('#par-erro')}.textContent) && !${Q('#par-f1')}.hidden`), await texto('#par-erro'));
  await foto('1-bloqueado');
  await postMock('/_mock/desbloquear');

  // ═════════ service worker e manifesto ═════════
  const sw = await avaliar(`navigator.serviceWorker.getRegistration().then((r) => ({ ativo: !!(r && r.active), escopo: r && r.scope }))`);
  conferir('service worker do PWA ativo (escopo /)', sw?.ativo && sw.escopo === mock.base + '/', JSON.stringify(sw));
  const man = (await cdp('Page.getAppManifest')).result || {};
  const mj = (() => { try { return JSON.parse(man.data || '{}'); } catch { return {}; } })();
  conferir('manifesto /manifest-m.webmanifest sem erros (standalone, start_url /m)', man.url?.endsWith('/manifest-m.webmanifest') && !(man.errors || []).length && mj.display === 'standalone' && mj.start_url === '/m', JSON.stringify(man.errors));
  const icones = [];
  for (const i of mj.icons || []) icones.push((await fetch(new URL(i.src, mock.base))).status);
  conferir('ícones do manifesto respondem 200', icones.length >= 7 && icones.every((s) => s === 200), JSON.stringify(icones));
} catch (e) {
  conferir('exceção no teste', false, e?.stack || String(e));
} finally {
  try { ws?.close(); } catch {}
  if (edge) await fecharEdge(porta, perfil);
  try { await mock?.fechar(); } catch {}
  if (!arg) { try { fs.rmSync(SAIDA, { recursive: true, force: true }); } catch {} }
}

conferir('zero erros de console', consoleErros.length === 0, consoleErros.slice(0, 8));
conferir('zero violações de CSP', violacoes.length === 0, violacoes.slice(0, 8));
const falhas = checks.filter((c) => !c.ok);
for (const c of checks) console.log((c.ok ? 'ok   ' : 'FALHA') + ' ' + c.nome + (c.ok ? '' : '\n        ' + JSON.stringify(c.detalhe)));
console.log(`\n${checks.length - falhas.length}/${checks.length} conferências ok` + (esperados.length ? ` (${esperados.length} erros de rede provocados de propósito no pareamento, ignorados)` : '') + (arg ? `; capturas em ${SAIDA}` : ''));
process.exit(falhas.length ? 1 : 0);
