// Interface /m contra o servidor.mjs de VERDADE (porta remota, pareamento, cookie, só nativas, conversa e permissões reais).
//   node testes/mobile-real.test.mjs [pasta-de-capturas]
// Sobe um servidor próprio com dados temporários: a porta local (a "47821" de teste), a porta remota (config.remoto.porta) e um
// proxy de teste saem de 47822–47826, conferidas livres (nunca a 47821). Tailscale e claude são falsos (ORBIT_TAILSCALE_FALSO,
// testes/claude-falso.mjs): nada chama a CLI nem a API de verdade.
// HTTPS: o Edge abre http://orbit-teste.localhost:<porta-do-proxy>/m. O proxy faz o papel do `tailscale serve`: reescreve Host
// para o host configurado e Origin para https://<host>. *.localhost conta como origem segura, então o cookie `__Host-orbit`
// (Secure) é aceito de verdade pelo navegador. O que fica sem testar é o TLS em si (certificado, https:// real).
// Confere: pareamento (código errado, expirado, bloqueado, certo), cookie, lista só com nativas, nova instância pela interface,
// permissão, pergunta e plano reais, mensagem, uso, sair; sem erro de console nem violação de CSP.

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

const checks = [];
const conferir = (nome, ok, detalhe) => { checks.push({ nome, ok: !!ok, detalhe: ok ? undefined : detalhe }); };
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
let edge = null, ws, seq = 0;
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
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
      const e = d.params.entry;
      // Erros de rede esperados: 401 sem pareamento, código errado/expirado/bloqueado, a sessão do VS Code que o celular não pode abrir
      // e o 503 de /modelos (o servidor de teste roda com ORBIT_MODELOS=0, então nunca lê os modelos; no uso real é transitório).
      if (e.source === 'network' && (/\/remoto\/(eu|parear\/)|\/sessao\/vscode-1/.test(e.url || '') || (/\/modelos$/.test(e.url || '') && /503/.test(e.text || '')))) esperados.push(e.url);
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

async function pausaVolta() { // a volta da instância terminou (barra "Trabalhando…" some)
  return esperar(`${Q('#cv-estado')}.hidden`, 20000);
}
async function enviar(msg) {
  await digitar('#cv-texto', msg);
  await esperar(`!${Q('#cv-enviar')}.disabled`);
  await clicar('#cv-enviar');
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
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  const abrir = async (hash = '') => { await cdp('Page.navigate', { url: 'about:blank' }); await dormir(100); await cdp('Page.navigate', { url: URL_M + hash }); await esperar('document.readyState === "complete"'); await dormir(300); };

  // ═════════ pareamento ═════════
  await abrir();
  conferir('GET /m do servidor real mostra o pareamento (401 em /remoto/eu)', await esperar(visivel('#v-parear')), await texto('#app'));
  await digitar('#par-nome', 'iPhone do teste');
  await clicar('#par-pedir');
  conferir('Parear → pede o código (POST /remoto/parear/pedir real)', await esperar(visivel('#par-f2')) && /Expira em \d:\d\d/.test(await texto('#par-expira')), await texto('#par-erro'));
  const certo = await codigoDoPc();
  conferir('o código aparece só no PC (GET /remoto/estado local)', /^\d{6}$/.test(certo || ''));
  const errado = certo === '123456' ? '654321' : '123456';
  await digitar('#par-codigo', errado);
  conferir('código errado → "Código errado" (400 codigo_errado)', await esperar(`/errado/i.test(${Q('#par-erro')}.textContent)`), await texto('#par-erro'));
  await dormir(PEDIDO_MS + 500);
  conferir('o prazo vence na tela ("expirou", Confirmar desabilitado); o servidor derrubou o pedido', await esperar(`/expirou/i.test(${Q('#par-expira')}.textContent) && ${Q('#par-confirmar')}.disabled`) && (await codigoDoPc()) === undefined, await texto('#par-expira'));
  await clicar('#par-outro');
  await clicar('#par-pedir');
  await esperar(visivel('#par-f2'));
  const errado2 = (await codigoDoPc()) === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) { await digitar('#par-codigo', errado2); await dormir(500); if (await avaliar(`!${Q('#par-f1')}.hidden`)) break; }
  conferir('5 códigos errados → bloqueado (429 bloqueado)', await esperar(`/10 minutos/.test(${Q('#par-erro')}.textContent) && !${Q('#par-f1')}.hidden`), await texto('#par-erro'));
  await dormir(BLOQUEIO_MS + 300);
  await clicar('#par-pedir');
  conferir('depois do prazo do bloqueio pede de novo', await esperar(visivel('#par-f2')), await texto('#par-erro'));
  await digitar('#par-codigo', await codigoDoPc());
  conferir('código certo → entra (cookie criado pelo servidor real)', await esperar(visivel('#v-principal')), await texto('#app'));
  const ck = (await cdp('Network.getCookies', { urls: [URL_M] })).result.cookies.find((c) => c.name === '__Host-orbit');
  conferir('cookie __Host-orbit: HttpOnly, Secure, SameSite=Strict, Path=/ (aceito pelo navegador)', ck && ck.httpOnly && ck.secure && ck.sameSite === 'Strict' && ck.path === '/' && !ck.domain.startsWith('.'), JSON.stringify(ck));
  conferir('o servidor registrou o aparelho com o nome digitado', (await estadoRemoto()).aparelhos.map((a) => a.nome).join() === 'iPhone do teste');
  await foto('1-lista-vazia');

  // ═════════ só nativas ═════════
  await pedirLocal('POST', '/evento', { session_id: 'vscode-1', hook_event_name: 'UserPromptSubmit', cwd: PROJ, prompt: 'sessão do VS Code', ts: Date.now() });
  await dormir(1200);
  conferir('(controle) a sessão do VS Code existe no PC, na porta local', ((await pedirLocal('GET', '/estado')).json?.sessoes || []).some((s) => s.id === 'vscode-1'));
  conferir('sessão do VS Code não aparece no celular', (await contar('.card')) === 0 && (await avaliar(visivel('.vazio'))), await texto('#lista-sessoes'));
  conferir('"Nova instância" disponível (criarInstancias do servidor)', await avaliar(visivel('#btn-nova')));
  await clicar('#btn-nova');
  conferir('Nova instância lista o projeto cadastrado (GET /remoto/projetos real)', await esperar(visivel('#v-nova') + ` && document.querySelectorAll('#nova-projeto option').length === 1 && !${Q('#nova-criar')}.disabled`), await texto('#v-nova'));
  conferir('o modelo vem de GET /modelos (ou o padrão, se o servidor ainda não leu)', (await contar('#nova-modelo option')) >= 1);
  await digitar('#nova-texto', 'PERMISSAO');
  await clicar('#nova-criar');
  conferir('criar instância pelo celular → abre a sessão nova (POST /instancias real)', await esperar(visivel('#v-sessao') + ` && /^#s=/.test(location.hash)`, 15000), await texto('#v-nova'));
  const id = decodeURIComponent(await avaliar('location.hash.slice(3)'));

  // ═════════ permissão real ═════════
  conferir('permissão real do Write chega ao cartão', await esperar(visivel('#cv-perm') + ` && /Write/.test(${Q('#cv-perm .perm-chip')}.textContent)`, 20000), await texto('#cv-perm'));
  await foto('3-permissao-real');
  conferir('sessão real: sem rolagem lateral', await semRolagemLateral());
  await clicarExato('#cv-perm button', 'Permitir');
  conferir('Permitir é aceito pelo servidor (cartão some, sem erro)', await esperar(`${Q('#cv-perm')}.hidden`) && !(await avaliar(visivel('.perm-erro'))), await texto('#cv-perm'));
  conferir('a conversa real mostra a mensagem do usuário', await esperar(`document.querySelector('#cv-itens').textContent.includes('PERMISSAO')`, 15000), await texto('#cv-itens'));
  conferir('a volta termina (barra de trabalho some)', await pausaVolta(), await texto('#cv-estado'));

  // ═════════ pergunta real ═════════
  await enviar('PERGUNTA');
  conferir('pergunta real (AskUserQuestion) com opções', await esperar(visivel('#cv-perm') + ` && document.querySelectorAll('#cv-perm .op').length >= 3`, 20000), await texto('#cv-perm'));
  await foto('3-pergunta-real');
  const n = await contar('#cv-perm .q');
  for (let q = 0; q < n; q++) await avaliar(`document.querySelectorAll('#cv-perm .q')[${q}].querySelector('.op').click()`);
  await clicarExato('#cv-perm button', 'Responder');
  conferir('Responder é aceito (cartão some, sem erro)', await esperar(`${Q('#cv-perm')}.hidden`) && !(await avaliar(visivel('.perm-erro'))), await texto('#cv-perm'));
  await pausaVolta();

  // ═════════ plano real ═════════
  await enviar('PLANO');
  conferir('plano real (ExitPlanMode) com texto e botões', await esperar(visivel('#cv-perm') + ` && /Aprovar/.test(${Q('#cv-perm')}.textContent) && !!document.querySelector('#cv-perm .perm-plano')`, 20000), await texto('#cv-perm'));
  await foto('3-plano-real');
  await clicarExato('#cv-perm button', 'Aprovar');
  conferir('Aprovar é aceito (cartão some, sem erro)', await esperar(`${Q('#cv-perm')}.hidden`) && !(await avaliar(visivel('.perm-erro'))), await texto('#cv-perm'));
  await pausaVolta();

  // ═════════ mensagem, modelo ═════════
  await enviar('olá do celular');
  conferir('mensagem é entregue e aparece uma vez só', await esperar(`[...document.querySelectorAll('#cv-itens .it-usuario')].filter((e) => e.textContent.includes('olá do celular')).length === 1`, 15000), await texto('#cv-itens'));
  conferir('a resposta do agente chega ao vivo pela conversa/fluxo real', await esperar(`document.querySelectorAll('#cv-itens .it-assist').length >= 1`, 20000));
  await pausaVolta();
  conferir('conversa: alvos de toque >= 44 px e sem rolagem lateral', await semRolagemLateral() && (await avaliar(`[...document.querySelectorAll('#v-sessao button, #v-sessao textarea')].filter((e) => e.getClientRects().length).every((e) => e.getBoundingClientRect().height >= 43.5)`)));
  await foto('3-conversa-real');

  // ═════════ lista só com a nativa, direto por #s ═════════
  await clicar('#s-voltar');
  conferir('lista: só a instância do Orbit (1 cartão), nada do VS Code', await esperar(visivel('#v-principal') + ` && document.querySelectorAll('.card').length === 1 && !/VS Code/.test(document.body.textContent)`), await texto('#lista-sessoes'));
  await foto('2-lista-real');
  await abrir('#s=' + encodeURIComponent(id));
  conferir('abre direto por #s=<id> (já pareado, cookie volta no reload)', await esperar(visivel('#v-sessao') + ` && document.querySelectorAll('#cv-itens > *').length >= 2`, 12000), await texto('#app'));
  conferir('sessão que não é nativa (vscode-1) → indisponível', await (async () => { await abrir('#s=vscode-1'); return esperar(`/não está mais disponível/.test(${Q('#cv-vazio')}.textContent)`); })(), await texto('#cv-vazio'));

  // ═════════ uso ═════════
  // o POST /uso recebe o formato da status line do Claude (rate_limits), não o do GET
  await pedirLocal('POST', '/uso', { rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.round(Date.now() / 1000) + 3 * 3600 }, seven_day: { used_percentage: 40, resets_at: Math.round(Date.now() / 1000) + 2 * 86400 } } });
  await abrir('#uso');
  conferir('Uso do plano real (12% e 40%)', await esperar(visivel('#p-uso') + ` && [...document.querySelectorAll('.uso-val')].map((e) => e.textContent).join() === '12%,40%'`, 8000), await texto('#uso-barras'));
  await foto('4-uso-real');

  // ═════════ este aparelho e sair ═════════
  await abrir('#aparelho');
  conferir('Este aparelho: nome pareado e instruções (fora da Tela de Início)', await esperar(visivel('#p-aparelho') + ` && ${Q('#ap-nome')}.textContent === 'iPhone do teste' && !${Q('#ap-instalar')}.hidden`), await texto('#p-aparelho'));
  conferir('service worker e manifesto do servidor real', await esperar(`navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))`, 8000));
  const man = (await cdp('Page.getAppManifest')).result || {};
  conferir('manifesto /manifest-m.webmanifest servido sem erros', man.url?.endsWith('/manifest-m.webmanifest') && !(man.errors || []).length, JSON.stringify(man.errors || man.url));
  await clicar('#ap-sair');
  await clicar('#ap-sair-sim');
  conferir('Sair → pareamento e o servidor esquece o aparelho', await esperar(visivel('#v-parear')) && (await esperar(`true`)) && (await estadoRemoto()).aparelhos.length === 0, JSON.stringify((await estadoRemoto()).aparelhos));
} catch (e) {
  conferir('exceção no teste', false, e?.stack || String(e));
} finally {
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
