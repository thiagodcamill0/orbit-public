// App novo do celular (/m: mobile/index.html + mobile/*.js) contra o servidor.mjs de VERDADE (porta remota, pareamento, cookie, só nativas, conversa e permissões reais).
//   node testes/mobile-real.test.mjs [pasta-de-capturas]
// Sobe um servidor próprio com dados temporários: a porta local (a "47821" de teste), a porta remota (config.remoto.porta) e um
// proxy de teste saem de 47822–47826, conferidas livres (nunca a 47821). Tailscale e claude são falsos (ORBIT_TAILSCALE_FALSO,
// testes/claude-falso.mjs): nada chama a CLI nem a API de verdade.
// HTTPS: o Edge abre http://orbit-teste.localhost:<porta-do-proxy>/m. O proxy faz o papel do `tailscale serve`: reescreve Host
// para o host configurado e Origin para https://<host>. *.localhost conta como origem segura, então o cookie `__Host-orbit`
// (Secure) é aceito de verdade pelo navegador. O que fica sem testar é o TLS em si (certificado, https:// real).
// Confere: pareamento (código errado, expirado, bloqueado, certo), cookie, lista só com nativas, Nova instância (projeto, modelo, 403 de
// comando fora da lista), permissão, pergunta e plano reais, mensagem ("/help" 403), abrir por #s=<id>, sessão não nativa, Uso,
// Este aparelho e Sair; sem erro de console (fora os 403 provocados) nem violação de CSP.

import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta, portaLivre, desligarSeMeu, FAIXA } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { matarArvore } from '../plataforma.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SAIDA = arg ? path.resolve(arg) : fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mobile-real-saida-'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47824);
const livres = [];
for (const p of FAIXA) if (p !== PORTA && (await portaLivre(p))) livres.push(p);
if (livres.length < 2) throw new Error('faltam 2 portas livres em 47822–47826 (remota e proxy)');
const [PORTA_R, PORTA_P] = livres;

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mobile-real-'));
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
const PROJ = path.join(DADOS, 'cwd', 'proj');
for (const d of [SESSOES, PROJETOS, PROJ]) fs.mkdirSync(d, { recursive: true });
const HOST = 'orbit-teste.localhost';
const DONO = 'usuario@exemplo.com';
const URL_M = `http://${HOST}:${PORTA_P}/m`;
const PEDIDO_MS = 6000;
const BLOQUEIO_MS = 1500;
const TS = path.join(DADOS, 'tailscale-falso.json');
fs.writeFileSync(TS, JSON.stringify({ status: { BackendState: 'Running', Self: { DNSName: HOST + '.', UserID: 7 }, User: { 7: { LoginName: DONO } } }, serve: {} }));
fs.writeFileSync(path.join(DADOS, 'config.json'), JSON.stringify({ remoto: { porta: PORTA_R } }));
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: 'proj', pasta: PROJ, desde: new Date().toISOString() }], ocultos: [] }));
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_TICK_MS: '250', GERENCIADOR_PID_MS: '300', GERENCIADOR_SESSOES_DIR: SESSOES,
  ORBIT_PROJETOS_DIR: PROJETOS, ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'), ORBIT_MODELOS: '0', ORBIT_MS_REGISTRO: '200', ORBIT_MS_VIGIA: '100', ORBIT_MS_INICIO: '4000',
  ORBIT_TAILSCALE_FALSO: TS, ORBIT_REMOTO_PEDIDO_MS: String(PEDIDO_MS), ORBIT_REMOTO_BLOQUEIO_MS: String(BLOQUEIO_MS), CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDECODE;

const rede = [];
const checks = [];
const conferir = (nome, ok, detalhe) => { checks.push({ nome, ok: !!ok, detalhe: ok ? undefined : { detalhe, rede: rede.slice(-3) } }); };
const consoleErros = [];
const violacoes = [];
const esperados = [];

// ───────── servidor, proxy ─────────
function pedirLocal(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const h = { 'x-gerenciador': '1' };
    if (dados !== undefined) Object.assign(h, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: h, timeout: 20000, agent: false }, (res) => {
      const p = [];
      res.on('data', (c) => p.push(c));
      res.on('end', () => { const texto = Buffer.concat(p).toString('utf8'); let json; try { json = JSON.parse(texto); } catch {} resolve({ status: res.statusCode, json, texto }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
let proc = null;
async function subirServidor() {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  for (let i = 0; i < 100; i++) {
    if ((await pedirLocal('GET', '/saude').catch(() => ({}))).json?.pid === proc.pid) return;
    await dormir(100);
  }
  throw new Error('o servidor de teste não subiu');
}
// Faz o papel do `tailscale serve`: o servidor só aceita Host = host configurado e Origin = https://<host>.
const conexoesProxy = new Set();
const proxy = http.createServer((req, res) => {
  const headers = { ...req.headers, host: HOST, 'tailscale-user-login': DONO }; // o serve manda o login do dono
  if (headers.origin) headers.origin = `https://${HOST}`;
  delete headers.referer;
  const up = http.request({ host: '127.0.0.1', port: PORTA_R, path: req.url, method: req.method, headers, agent: false }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
    r.on('close', () => res.end());
  });
  up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
  res.on('close', () => up.destroy());
  req.pipe(up);
});
proxy.on('connection', (s) => { conexoesProxy.add(s); s.on('close', () => conexoesProxy.delete(s)); });

// ───────── Edge + CDP ─────────
const porta = 9800 + Math.floor(Math.random() * 150);
const perfil = path.join(SAIDA, 'edge-' + porta);
let edge = null, ws, seq = 0, manter = null;
const pend = new Map();
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
    if (d.method === 'Network.requestWillBeSent' && d.params.request.method === 'POST' && /\/(permissao|mensagem|sair)$|\/instancias$/.test(d.params.request.url)) rede.push({ id: d.params.requestId, rota: new URL(d.params.request.url).pathname.replace(/[0-9a-f-]{36}/, ':id'), corpo: (d.params.request.postData || '').slice(0, 300) });
    if (d.method === 'Network.responseReceived') { const q = rede.find((x) => x.id === d.params.requestId); if (q) q.status = d.params.response.status; }
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
      const e = d.params.entry;
      // Erros de rede esperados: 401 sem pareamento, código errado/expirado/bloqueado, a sessão do VS Code que o celular não pode abrir
      // e o 503 de /modelos (o servidor de teste roda com ORBIT_MODELOS=0, então nunca lê os modelos; no uso real é transitório).
      // 403 provocados de propósito (comando fora da lista): só POST /instancias e POST /sessao/<id>/mensagem, e só com status 403 no texto.
      if (e.source === 'network' && /\b403\b/.test(e.text || '') && /^https?:\/\/[^/]+\/(instancias|sessao\/[^/]+\/mensagem)$/.test(e.url || '')) esperados.push(e.url);
      else if (e.source === 'network' && (/\/remoto\/(eu|parear\/)|\/sessao\/vscode-1/.test(e.url || '') || (/\/modelos$/.test(e.url || '') && /503/.test(e.text || '')))) esperados.push(e.url);
      else if (/Content Security Policy|Refused to/i.test(e.text || '')) violacoes.push(e.text);
      else consoleErros.push(`${e.source}: ${e.text} ${e.url || ''}`);
    }
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
  while (Date.now() < fim) { try { if (await avaliar(expr)) return true; } catch {} await dormir(120); }
  return false;
}
const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
const Q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const visivel = (sel) => `(() => { const e = ${Q(sel)}; return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
const clicar = (sel) => avaliar(`(() => { const e = ${Q(sel)}; if (!e) return false; e.click(); return true; })()`);
const texto = (sel) => avaliar(`(${Q(sel)} || {}).textContent || ''`);
const contar = (sel) => avaliar(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const clicarTexto = (sel, t) => avaliar(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(t)})); if (!e) return false; e.click(); return true; })()`);
const clicarExato = (sel, t) => avaliar(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(t)}); if (!e) return false; e.click(); return true; })()`);
const digitar = (sel, t) => avaliar(`(() => { const e = ${Q(sel)}; const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(t)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
const INJETADO = `window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));`;
const codigoDoPc = async () => (await pedirLocal('GET', '/remoto/estado')).json.pedido?.codigo;
const estadoRemoto = async () => (await pedirLocal('GET', '/remoto/estado')).json;

const SES = '.tela[data-tela="sessoes"]';
const irPara = (hash) => avaliar(`(location.hash = ${JSON.stringify(hash)}, true)`);
const submeter = (p) => avaliar(`(${Q(`.par-passo[data-p="${p}"] button[type=submit]`)}.click(), true)`);
async function pausaVolta() { // a volta da instância terminou (a barra "Trabalhando…" some)
  return esperar(`${Q('.cv-pensando')}.hidden`, 25000);
}
async function enviar(msg) {
  await digitar('.cp-texto', msg);
  await esperar(`!${Q('.cp-enviar')}.disabled`);
  await clicar('.cp-enviar');
}

try {
  await subirServidor();
  const r = await pedirLocal('POST', '/remoto/config', { ativo: true, criarInstancias: true });
  conferir('ligar o acesso remoto no servidor real', r.status === 200 && r.json.ativo === true && r.json.host === HOST, r.texto);
  await new Promise((ok, falha) => { proxy.once('error', falha); proxy.listen(PORTA_P, '127.0.0.1', ok); });

  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`, `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar();
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await cdp(d + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJETADO });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }); // headless: a aba precisa parecer em foco, senão as animações do app não andam
  await cdp('Page.bringToFront');
  manter = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1000);
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  const abrir = async (hash = '') => { await cdp('Page.navigate', { url: 'about:blank' }); await dormir(100); await cdp('Page.navigate', { url: URL_M + hash }); await esperar('document.readyState === "complete"'); await dormir(300); };

  // ═════════ pareamento ═════════
  await abrir();
  conferir('GET /m do servidor real mostra o pareamento (401 em /remoto/eu)', await esperar(`document.body.dataset.modo === 'parear' && !!${Q('#par-nome')}`), await texto('body'));
  await digitar('#par-nome', 'iPhone do teste');
  await submeter(1);
  conferir('Parear → pede o código (POST /remoto/parear/pedir real)', await esperar(`${Q('.par')}.dataset.passo === '2' && /^Expira em \\d:\\d\\d$/.test(${Q('#par-tempo')}.textContent)`), (await texto('#par-erro-1')) + ' | ' + (await texto('#par-tempo')));
  const certo = await codigoDoPc();
  conferir('o código aparece só no PC (GET /remoto/estado local)', /^\d{6}$/.test(certo || ''));
  const errado = certo === '123456' ? '654321' : '123456';
  await digitar('#par-codigo', errado);
  conferir('código errado → "Código errado" (400 codigo_errado)', await esperar(`!${Q('#par-erro-2')}.hidden && /errado/i.test(${Q('#par-erro-2')}.textContent)`), await texto('#par-erro-2'));
  await dormir(PEDIDO_MS + 500);
  conferir('o prazo vence na tela ("expirou", campo desabilitado); o servidor derrubou o pedido', await esperar(`/expirou/i.test(${Q('#par-tempo')}.textContent) && ${Q('#par-codigo')}.disabled`) && (await codigoDoPc()) === undefined, await texto('#par-tempo'));
  await clicarExato('.par-passo[data-p="2"] button', 'Pedir de novo');
  conferir('"Pedir de novo" abre outro pedido no servidor real', await esperar(`${Q('.par')}.dataset.passo === '2' && /^Expira em/.test(${Q('#par-tempo')}.textContent) && !${Q('#par-codigo')}.disabled`) && /^\d{6}$/.test((await codigoDoPc()) || ''), await texto('#par-tempo'));
  const errado2 = (await codigoDoPc()) === '123456' ? '654321' : '123456';
  for (let i = 0; i < 6; i++) {
    await digitar('#par-codigo', errado2);
    await esperar(`${Q('.par')}.getAttribute('aria-busy') !== 'true'`, 4000);
    await dormir(250);
    if ((await avaliar(`${Q('.par')}.dataset.passo`)) === '1') break;
  }
  conferir('5 códigos errados → bloqueado (429 bloqueado), volta ao nome', await esperar(`${Q('.par')}.dataset.passo === '1' && !${Q('#par-erro-1')}.hidden && /10 minutos/.test(${Q('#par-erro-1')}.textContent)`), await texto('#par-erro-1'));
  await dormir(BLOQUEIO_MS + 300);
  await submeter(1);
  conferir('depois do prazo do bloqueio pede de novo', await esperar(`${Q('.par')}.dataset.passo === '2'`), await texto('#par-erro-1'));
  await digitar('#par-codigo', await codigoDoPc());
  conferir('código certo → entra (cookie criado pelo servidor real)', await esperar(`document.body.dataset.modo === 'app' && OM.estado.conexao === 'vivo'`, 15000), await texto('body'));
  const ck = (await cdp('Network.getCookies', { urls: [URL_M] })).result.cookies.find((c) => c.name === '__Host-orbit');
  conferir('cookie __Host-orbit: HttpOnly, Secure, SameSite=Strict, Path=/ (aceito pelo navegador)', ck && ck.httpOnly && ck.secure && ck.sameSite === 'Strict' && ck.path === '/' && !ck.domain.startsWith('.'), JSON.stringify(ck));
  conferir('o servidor registrou o aparelho com o nome digitado', (await estadoRemoto()).aparelhos.map((a) => a.nome).join() === 'iPhone do teste');
  conferir('depois de parear cai no início', await esperar(`OM.rotas.atual().nome === 'inicio'`), await avaliar('location.hash'));
  await irPara('#sessoes');
  await esperar(`OM.rotas.atual().nome === 'sessoes'`);
  await foto('1-lista-vazia');

  // ═════════ só nativas ═════════
  await pedirLocal('POST', '/evento', { session_id: 'vscode-1', hook_event_name: 'UserPromptSubmit', cwd: PROJ, prompt: 'sessão do VS Code', ts: Date.now() });
  await dormir(1200);
  conferir('(controle) a sessão do VS Code existe no PC, na porta local', ((await pedirLocal('GET', '/estado')).json?.sessoes || []).some((s) => s.id === 'vscode-1'));
  conferir('sessão do VS Code não aparece no celular', (await contar(`${SES} li.sx-linha`)) === 0 && (await esperar(`!${Q(SES + ' .sx-msg')}.hidden && /Nenhuma sessão/.test(${Q(SES + ' .sx-msg')}.textContent)`)), await texto(SES));
  conferir('"Nova instância" disponível (criarInstancias do servidor)', await avaliar(`!${Q(SES + ' .sx-nova')}.hidden`));

  // ═════════ nova instância ═════════
  await clicar(`${SES} .sx-nova`);
  conferir('Nova instância lista o projeto cadastrado (GET /remoto/projetos real)', await esperar(`OM.rotas.atual().nome === 'nova' && !${Q('.nv-form')}.hidden && document.querySelectorAll('select[aria-label=Projeto] option').length === 1 && ${Q('button.nv-criar')} && !${Q('button.nv-criar')}.disabled`), await texto('.nv'));
  conferir('o modelo vem de GET /modelos (ou o padrão, se o servidor ainda não leu)', (await contar('select[aria-label=Modelo] option')) >= 1);
  // comando com barra fora da lista: o servidor real recusa com 403 comando_nao_permitido, e a tela explica
  const direto = await avaliar(`fetch('/instancias', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ pasta: ${JSON.stringify(PROJ)}, cwd: ${JSON.stringify(PROJ)}, texto: '/rm-tudo agora' }) }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }))`);
  conferir('POST /instancias com "/rm-tudo": servidor real responde 403 comando_nao_permitido', direto.status === 403 && direto.corpo?.erro === 'comando_nao_permitido', JSON.stringify(direto));
  await digitar('.nv-slot .cp-texto', '/rm-tudo agora');
  await clicar('button.nv-criar');
  conferir('na tela: comando com barra fora da lista é recusado e a tela continua em Nova', await esperar(`!!${Q('.nv-erro:not([hidden])')} && /comando com barra/.test(${Q('.nv-erro:not([hidden])')}.textContent)`, 8000) && (await avaliar(`OM.rotas.atual().nome`)) === 'nova' && (await contar(`${SES} li.sx-linha`)) === 0, await texto('.nv-erro:not([hidden])'));
  conferir('(controle) o servidor não criou nenhuma instância com o comando recusado', !((await pedirLocal('GET', '/estado')).json?.sessoes || []).some((s) => s.id !== 'vscode-1'));
  await digitar('.nv-slot .cp-texto', 'PERMISSAO');
  await clicar('button.nv-criar');
  conferir('criar instância pelo celular → abre a sessão nova (POST /instancias real)', await esperar(`/^#s=/.test(location.hash) && !!document.querySelector('.cv[data-fase="ok"]') && !!document.querySelector('.cp-texto')`, 20000), (await avaliar('location.hash')) + ' ' + (await texto('.nv-erro:not([hidden])')));
  const id = decodeURIComponent((await avaliar('location.hash')).slice(3).split('/')[0]);

  // ═════════ permissão real ═════════
  conferir('permissão real do Write chega ao cartão', await esperar(`!!document.querySelector('.cv-cartoes .ct-cartao') && /Write/.test(document.querySelector('.cv-cartoes .ct-cartao').textContent)`, 25000), await texto('.cv-cartoes'));
  await foto('3-permissao-real');
  conferir('sessão real: sem rolagem lateral', await semRolagemLateral());
  await clicarExato('.ct-cartao .btn', 'Permitir');
  conferir('Permitir é aceito pelo servidor (cartão some, sem erro)', await esperar(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 10000) && (await contar('.ct-erro:not([hidden])')) === 0, await texto('.cv-cartoes'));
  conferir('a conversa real mostra a mensagem do usuário', await esperar(`[...document.querySelectorAll('.cv-usu .cv-bolha')].some((e) => e.textContent.includes('PERMISSAO'))`, 15000), await texto('.cv-lista'));
  conferir('a volta termina (barra de trabalho some)', await pausaVolta(), await avaliar(`${Q('.cv-pensando')}.hidden`));

  // ═════════ pergunta real ═════════
  await enviar('PERGUNTA');
  conferir('pergunta real (AskUserQuestion) com as duas perguntas e opções', await esperar(`!!document.querySelector('.ct-cartao[data-tipo="pergunta"]') && document.querySelectorAll('.ct-cartao .ct-q').length === 2 && document.querySelectorAll('.ct-cartao .ct-op-in').length >= 4`, 25000), await texto('.cv-cartoes'));
  await foto('3-pergunta-real');
  const nq = await contar('.ct-cartao .ct-q');
  for (let q = 0; q < nq; q++) await avaliar(`document.querySelectorAll('.ct-cartao .ct-q')[${q}].querySelector('.ct-op-in').click()`);
  await clicarExato('.ct-cartao .btn', 'Responder');
  conferir('Responder é aceito (cartão some, sem erro) e o agente recebe as respostas', await esperar(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 10000) && (await contar('.ct-erro:not([hidden])')) === 0 && await esperar(`/Obrigado pelas respostas/.test(document.querySelector('.cv-lista').textContent)`, 20000), await texto('.cv-cartoes'));
  await pausaVolta();

  // ═════════ plano real ═════════
  await enviar('PLANO');
  conferir('plano real (ExitPlanMode) com texto e botões', await esperar(`!!document.querySelector('.ct-cartao[data-tipo="plano"]') && !!document.querySelector('.ct-cartao .ct-plano') && [...document.querySelectorAll('.ct-cartao .btn')].some((b) => b.textContent.trim() === 'Aprovar')`, 25000), await texto('.cv-cartoes'));
  await foto('3-plano-real');
  await clicarExato('.ct-cartao .btn', 'Aprovar');
  conferir('Aprovar é aceito (cartão some, sem erro) e o agente segue', await esperar(`document.querySelectorAll('.cv-cartoes .ct-cartao').length === 0`, 10000) && (await contar('.ct-erro:not([hidden])')) === 0 && await esperar(`/Plano aprovado/.test(document.querySelector('.cv-lista').textContent)`, 20000), await texto('.cv-cartoes'));
  await pausaVolta();

  // ═════════ mensagem ═════════
  await enviar('olá do celular');
  conferir('mensagem é entregue e aparece uma vez só', await esperar(`[...document.querySelectorAll('.cv-usu .cv-bolha')].filter((e) => e.textContent === 'olá do celular').length === 1 && !document.querySelector('.cv-local')`, 15000), await texto('.cv-lista'));
  conferir('a resposta do agente chega ao vivo pela conversa/fluxo real', await esperar(`[...document.querySelectorAll('.cv-assist')].some((e) => e.textContent.includes('Resposta: olá do celular'))`, 20000));
  await pausaVolta();
  conferir('conversa: Enviar com alvo de toque >= 44 px e sem rolagem lateral', await semRolagemLateral() && (await avaliar(`${Q('.cp-enviar')}.getBoundingClientRect().height >= 43.5`)));
  await foto('3-conversa-real');
  // comando com barra no composer: o servidor real recusa e o app explica
  const cmd = await avaliar(`fetch('/sessao/' + encodeURIComponent(${JSON.stringify(id)}) + '/mensagem', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ texto: '/help' }) }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }))`);
  conferir('POST /sessao/<id>/mensagem com "/help": servidor real responde 403 comando_nao_permitido', cmd.status === 403 && cmd.corpo?.erro === 'comando_nao_permitido', JSON.stringify(cmd));
  await digitar('.cp-texto', '/help');
  await esperar(`!${Q('.cp-enviar')}.disabled`);
  await clicar('.cp-enviar');
  conferir('no composer: "/help" vira bolha em erro com a explicação, e o texto volta ao campo', await esperar(`!!document.querySelector('.cv-local[data-estado="erro"]') && /Esse comando não pode ser usado pelo celular/.test(document.querySelector('.cv-local .cv-local-st').textContent)`, 8000) && (await avaliar(`${Q('.cp-texto')}.value`)) === '/help', await texto('.cv-lista'));
  conferir('(controle) o servidor real não entregou o "/help" à instância', !(await avaliar(`document.querySelector('.cv-lista').textContent.includes('Resposta: /help')`)));

  // ═════════ lista só com a nativa, direto por #s ═════════
  await avaliar(`sessionStorage.clear()`); // sem rascunho do "/help" na volta
  await irPara('#sessoes');
  conferir('lista: só a instância do Orbit (1 linha), nada do VS Code', await esperar(`OM.rotas.atual().nome === 'sessoes' && document.querySelectorAll(${JSON.stringify(SES + ' li.sx-linha')}).length === 1 && !/VS Code/.test(${Q(SES)}.textContent)`), await texto(SES));
  await foto('2-lista-real');
  await abrir('#s=' + encodeURIComponent(id));
  conferir('abre direto por #s=<id> (já pareado, cookie volta no reload)', await esperar(`!!document.querySelector('.cv[data-fase="ok"]') && document.querySelectorAll('.cv-lista > *').length >= 2`, 15000), await texto('.cv'));
  await abrir('#s=vscode-1');
  conferir('sessão que não é nativa (vscode-1) → "não existe mais"', await esperar(`document.querySelector('.cv') && document.querySelector('.cv').dataset.fase === '404' && /não existe mais/.test(document.querySelector('.cv').textContent)`, 10000), await texto('.cv'));

  // ═════════ uso ═════════
  // o POST /uso recebe o formato da status line do Claude (rate_limits), não o do GET
  await pedirLocal('POST', '/uso', { rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.round(Date.now() / 1000) + 3 * 3600 }, seven_day: { used_percentage: 40, resets_at: Math.round(Date.now() / 1000) + 2 * 86400 } } });
  await abrir('#mais/uso');
  conferir('Uso do plano real (12% e 40%)', await esperar(`OM.rotas.atual().nome === 'uso' && [...document.querySelectorAll('.uso-cartao .uso-val')].map((e) => e.textContent).join() === '12%,40%'`, 10000), await texto('.uso-real'));
  await foto('4-uso-real');

  // ═════════ este aparelho e sair ═════════
  await abrir('#mais/aparelho');
  conferir('Este aparelho: nome pareado, conexão e "aberto no navegador"', await esperar(`OM.rotas.atual().nome === 'aparelho' && ${Q('#mais-ap-nome')}.textContent === 'iPhone do teste' && ${Q('#mais-ap-conexao')}.textContent === 'Conectado' && /navegador/.test(${Q('#mais-ap-inst')}.textContent)`, 10000), await texto('.tela[data-tela="aparelho"]'));
  conferir('service worker e manifesto do servidor real', await esperar(`navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))`, 8000));
  const man = (await cdp('Page.getAppManifest')).result || {};
  conferir('manifesto /manifest-m.webmanifest servido sem erros', man.url?.endsWith('/manifest-m.webmanifest') && !(man.errors || []).length, JSON.stringify(man.errors || man.url));
  await avaliar(`(localStorage.setItem('x', '1'), sessionStorage.setItem('x', '1'), true)`);
  await clicar('#mais-ap-sair');
  conferir('Sair pede confirmação (folha)', await esperar(`!!${Q('.folha')} && /Sair deste aparelho\\?/.test(${Q('.folha')}.textContent)`), await texto('body'));
  await clicarExato('.folha .btn', 'Sair');
  conferir('Sair → pareamento', await esperar(`document.body.dataset.modo === 'parear'`, 10000), await texto('body'));
  conferir('Sair → o servidor esquece o aparelho', (await estadoRemoto()).aparelhos.length === 0, JSON.stringify((await estadoRemoto()).aparelhos));
  conferir('Sair → localStorage e sessionStorage vazios', await avaliar('localStorage.length === 0 && sessionStorage.length === 0'), await avaliar('JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)])'));
  conferir('Sair → o cookie __Host-orbit foi apagado', !(await cdp('Network.getCookies', { urls: [URL_M] })).result.cookies.some((c) => c.name === '__Host-orbit'));
} catch (e) {
  conferir('exceção no teste', false, e?.stack || String(e));
} finally {
  clearInterval(manter);
  try { ws?.close(); } catch {}
  if (edge) await fecharEdge(porta, perfil);
  for (const s of conexoesProxy) s.destroy();
  await new Promise((r) => proxy.close(r));
  if (proc) {
    const saiu = new Promise((r) => proc.once('exit', r));
    await desligarSeMeu(PORTA, proc.pid);
    await Promise.race([saiu, dormir(4000)]);
    if (proc.exitCode == null) { try { proc.kill(); } catch {} }
  }
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch {}
  if (m?.pid) {
    try { process.kill(m.pid, 0); if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else await matarArvore(m.pid); } catch {}
  }
  await dormir(300);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
  if (!arg) { try { fs.rmSync(SAIDA, { recursive: true, force: true }); } catch {} }
}

conferir('zero erros de console', consoleErros.length === 0, consoleErros.slice(0, 8));
conferir('zero violações de CSP', violacoes.length === 0, violacoes.slice(0, 8));
const falhas = checks.filter((c) => !c.ok);
for (const c of checks) console.log((c.ok ? 'ok   ' : 'FALHA') + ' ' + c.nome + (c.ok ? '' : '\n        ' + JSON.stringify(c.detalhe)));
console.log(`\n${checks.length - falhas.length}/${checks.length} conferências ok` + (esperados.length ? ` (${esperados.length} erros de rede provocados de propósito no pareamento, ignorados)` : '') + (arg ? `; capturas em ${SAIDA}` : ''));
process.exit(falhas.length ? 1 : 0);
