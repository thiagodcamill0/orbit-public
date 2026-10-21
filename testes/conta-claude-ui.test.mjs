// Conta do Claude no menu de perfil (19/10): conta-claude.mjs (rotas /conta/claude), controle.mjs (pausar e
// retomar as instâncias pela conta) e assets/perfil.js, na página de verdade. Servidor de teste (47822–47826) com o
// claude-falso, que imita `claude auth status|login|logout` num arquivo (FALSO_AUTH), e uma casa falsa
// (GERENCIADOR_CLAUDE_HOME). O claude de verdade e o login do usuário nunca são tocados.
// Rodar:  node testes/conta-claude-ui.test.mjs [pasta-das-capturas]
// Confere: status com e-mail e plano ("Max 5x" dos arquivos da mesma conta); POST sem cabeçalho → 403; o aviso
// lista a instância do Orbit trabalhando; "Pausar e sair" interrompe, faz dormir (motivo conta) e sai; o login
// pelo Orbit volta a conta e acorda a pausada; sair sem pausar mantém a instância viva; cancelar e falha do login;
// falha do logout → 502 e segue logado; login por fora (arquivo muda) é notado sem o Orbit pedir. Página: seção
// Claude com e-mail, plano e a nota do computador inteiro; confirmação com os três botões; Esc fecha só a
// confirmação; trocar de conta pausa, abre o login e diz com que conta entrou; 0 erros de console.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.join(os.tmpdir(), 'gerenciador-testes', `conta-claude-${Date.now()}`);
const DADOS = path.join(BASE, 'dados');
const CASA = path.join(BASE, 'casa');
const PERFIL = path.join(BASE, 'edge');
const PASTA = path.join(BASE, 'projeto-conta');
const AUTH = path.join(BASE, 'auth.json');
const LOG_AUTH = path.join(BASE, 'auth.log');
const SAIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
for (const d of [path.join(BASE, 'perfil'), DADOS, path.join(DADOS, 'sessoes'), path.join(DADOS, 'projetos'), path.join(CASA, '.claude'), PERFIL, PASTA]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PASTA, 'LEIAME.md'), '# Projeto de teste\n');
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
if (SAIDA) fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL = 'usuario@exemplo.com';
const logar = (email = EMAIL, extra = {}) => fs.writeFileSync(AUTH, JSON.stringify({ loggedIn: true, email, subscriptionType: 'max', orgName: 'Org de Teste', ...extra }));
// A casa falsa: o ~/.claude.json da mesma conta, com o nível "max_5x" (o plano com multiplicador vem daqui).
fs.writeFileSync(path.join(CASA, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: EMAIL, organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' } }));
logar();

const PORTA = await escolherPorta(47826);
const URL_BASE = `http://127.0.0.1:${PORTA}`;
const saude = async () => { try { return await (await fetch(URL_BASE + '/saude')).json(); } catch { return null; } };
const post = async (rota, corpo, cab = true) => {
  const r = await fetch(URL_BASE + rota, { method: 'POST', headers: cab ? { 'content-type': 'application/json', 'x-gerenciador': '1' } : { 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });
  return { status: r.status, corpo: await r.json().catch(() => null) };
};
const get = async (rota) => { const r = await fetch(URL_BASE + rota, { cache: 'no-store' }); return { status: r.status, corpo: await r.json().catch(() => null) }; };
const conta = async (agora = true) => (await get('/conta/claude' + (agora ? '?agora' : ''))).corpo;
const ate = async (f, ms = 15000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await f(); if (v) return v; await dormir(200); } return v; };

const env = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  GERENCIADOR_CLAUDE_HOME: CASA,
  ORBIT_PERFIL_DIR: path.join(BASE, 'perfil'), // nunca o perfil e o token do GitHub de verdade
  ORBIT_GITHUB_API: 'http://127.0.0.1:9', // e nunca o GitHub de verdade
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_MODELOS_INICIO: '300',
  ORBIT_PASTAS_TEMP: path.join(BASE, 'nenhuma-temp'),
  FALSO_AUTH: AUTH,
  FALSO_LOG_AUTH: LOG_AUTH,
  FALSO_AUTH_LOGIN_MS: '1200',
  FALSO_DEMORA_MS: '60000',
};
delete env.GERENCIADOR_REINICIOS;
delete env.CLAUDECODE;
delete env.FALSO_AUTH_MODO;

let pcdp = 0, srv = null, ok = 0, falhas = 0;
const conferir = (cond, rotulo, extra) => { if (cond) ok++; else falhas++; console.log(`${cond ? 'ok   ' : 'FALHA'} ${rotulo}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 600) : ''}`); };
const instancias = async () => (await get('/instancias')).corpo;
const estadoDe = async (id) => (await get('/estado')).corpo.sessoes.find((s) => s.id === id);

try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], { env, stdio: 'ignore' });
  let s0 = null;
  for (let i = 0; i < 60 && !(s0 && s0.pid === srv.pid); i++) { await dormir(150); s0 = await saude(); }
  if (!s0 || s0.pid !== srv.pid) throw new Error('o servidor do teste não subiu');
  for (let i = 0; i < 40; i++) { const r = await fetch(URL_BASE + '/modelos'); if (r.ok) break; await dormir(250); }
  await post('/projetos/adicionar', { pasta: PASTA });

  // ───── API: status ─────
  let c = await conta();
  conferir(c.logado === true && c.email === EMAIL && c.plano === 'Max 5x' && c.org === 'Org de Teste' && c.metodo === 'claude.ai', 'status: e-mail, plano "Max 5x" (arquivos da mesma conta) e organização', c);
  conferir(!JSON.stringify(c).includes('org-falso'), 'status sem o orgId');
  let r = await post('/conta/claude/sair', {}, false);
  conferir(r.status === 403, 'POST sem x-gerenciador → 403', r);
  conferir(fs.readFileSync(AUTH, 'utf8').includes('"loggedIn":true'), 'o POST recusado não saiu da conta');
  r = await post('/conta/claude/entrar', {});
  conferir(r.status === 409 && /Trocar de conta/.test(r.corpo?.erro), 'entrar já logado → 409', r);

  // ───── instância do Orbit trabalhando ─────
  const ri = await post('/instancias', { pasta: PASTA, nome: 'Instância da conta', texto: 'DEMORA trabalho longo' });
  const id = ri.corpo?.sessao;
  conferir(ri.status === 202 && !!id, 'instância do Orbit criada', ri);
  await ate(async () => (await estadoDe(id))?.controle?.ocupada === true);
  c = await conta();
  conferir(c.emAndamento?.orbit?.length === 1 && c.emAndamento.orbit[0].ocupada === true && c.emAndamento.orbit[0].nome === 'Instância da conta', 'aviso: a instância do Orbit trabalhando, pelo nome', c.emAndamento);

  // ───── pausar e sair ─────
  const t0 = Date.now();
  r = await post('/conta/claude/sair', { pausar: true });
  conferir(r.status === 200 && r.corpo.logado === false && r.corpo.pausa?.pausadas === 1 && r.corpo.pausa.falharam === 0, 'pausar e sair → 200, 1 pausada, deslogado', r);
  conferir(Date.now() - t0 < 25000, 'pausar e sair em menos de 25 s', Date.now() - t0);
  let e = await estadoDe(id);
  let inst = await instancias();
  conferir(inst.vivas === 0 && inst.dormindo === 1 && e?.controle?.modo === 'orbit', 'a instância dormiu e continua no Orbit', { inst, controle: e?.controle });
  conferir(r.corpo.pausadas === 1, 'GET conta: 1 pausada pela conta', r.corpo.pausadas);
  const regs = await ate(() => { try { const t = fs.readFileSync(path.join(DADOS, 'instancias.json'), 'utf8'); return /"motivo":\s*"conta"/.test(t) ? t : null; } catch { return null; } }, 5000);
  conferir(!!regs && regs.includes(id), 'registro: dormiu com motivo "conta"');
  const log1 = fs.readFileSync(LOG_AUTH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  conferir(log1.some((l) => l.argv.join(' ') === 'auth logout'), 'rodou `claude auth logout`');

  // ───── entrar pelo Orbit: a pausada volta ─────
  r = await post('/conta/claude/entrar', {});
  conferir(r.status === 202 && r.corpo.entrando && r.corpo.logado === false, 'entrar → 202, entrando', r);
  c = await ate(async () => { const x = await conta(false); return x.entrando?.url ? x : null; }, 5000);
  conferir(/^https:\/\/claude\.ai\/oauth\/authorize/.test(c?.entrando?.url || ''), 'a URL do login para "Abrir de novo"', c?.entrando);
  c = await ate(async () => { const x = await conta(false); return x.logado && !x.entrando ? x : null; });
  conferir(c?.logado === true && c.email === 'nova@exemplo.com' && c.plano === 'Pro' && c.retomadas === 1, 'login concluído: outra conta, plano Pro (sem os arquivos), 1 retomada', c);
  inst = await ate(async () => { const x = await instancias(); return x.vivas === 1 ? x : null; });
  conferir(inst?.vivas === 1 && inst.dormindo === 0, 'a pausada acordou depois do login', inst);
  c = await conta();
  conferir(c.pausadas === 0 && c.falha === null, 'nenhuma pausada sobrando, sem falha', c);

  // ───── sair sem pausar: a instância segue viva ─────
  r = await post('/conta/claude/sair', { pausar: false });
  inst = await instancias();
  conferir(r.status === 200 && r.corpo.logado === false && r.corpo.pausa.pausadas === 0 && inst.vivas === 1, 'sair sem pausar → deslogado, instância viva', { r, inst });

  // ───── cancelar e falha do login ─────
  fs.writeFileSync(AUTH, JSON.stringify({ loggedIn: false, modo: 'login_espera' }));
  r = await post('/conta/claude/entrar', {});
  conferir(r.status === 202 && r.corpo.entrando, 'login que espera o navegador → entrando', r);
  r = await post('/conta/claude/sair', { pausar: true });
  conferir(r.status === 409, 'sair com login em andamento → 409', r);
  r = await post('/conta/claude/entrar/cancelar', {});
  c = await ate(async () => { const x = await conta(false); return !x.entrando ? x : null; }, 6000);
  conferir(c && !c.entrando && c.logado === false && !c.falha, 'cancelar → sem login em andamento e sem falha', c);
  fs.writeFileSync(AUTH, JSON.stringify({ loggedIn: false, modo: 'login_falha' }));
  await post('/conta/claude/entrar', {});
  c = await ate(async () => { const x = await conta(false); return !x.entrando && x.falha ? x : null; });
  conferir(/não foi concluído/.test(c?.falha || ''), 'login que falha → mensagem de não concluído', c);

  // ───── logout que falha ─────
  logar(EMAIL, { modo: 'logout_falha' });
  await conta();
  r = await post('/conta/claude/sair', { pausar: false });
  c = await conta();
  conferir(r.status === 502 && /não saiu/.test(r.corpo?.erro) && c.logado === true, 'logout que falha → 502 e segue logado', { r, c });

  // ───── login e logout por fora (terminal ou VS Code): o vigia nota ─────
  logar();
  await conta();
  fs.writeFileSync(AUTH, JSON.stringify({ loggedIn: false }));
  const agora = new Date();
  fs.utimesSync(path.join(CASA, '.claude.json'), agora, new Date(agora.getTime() + 2000));
  c = await ate(async () => { const x = await conta(false); return x.logado === false ? x : null; }, 12000);
  conferir(c?.logado === false, 'logout por fora: o Orbit nota pelo arquivo, sem ?agora', c);
  logar();
  fs.utimesSync(path.join(CASA, '.claude.json'), agora, new Date(agora.getTime() + 4000));
  c = await ate(async () => { const x = await conta(false); return x.logado === true ? x : null; }, 12000);
  conferir(c?.logado === true && c.email === EMAIL, 'login por fora: notado também', c);

  // ───── página ─────
  const EDGE = caminhoNavegador();
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok2) => (ws.onopen = ok2));
  let seq = 0;
  const pend = new Map();
  const erros = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Runtime.exceptionThrown') erros.push(j.params.exceptionDetails?.exception?.description || 'exceção');
    if (j.method === 'Runtime.consoleAPICalled' && (j.params.type === 'error' || j.params.type === 'warning')) erros.push(j.params.type + ': ' + j.params.args.map((x) => x.value ?? x.description).join(' '));
    if (j.method === 'Log.entryAdded' && j.params.entry.level === 'error' && !/\/modelos|\/perfil\/github/.test(j.params.entry.url || '')) erros.push('log: ' + j.params.entry.text + ' ' + (j.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok2) => { const i = ++seq; pend.set(i, ok2); ws.send(JSON.stringify({ id: i, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const espera = async (expr, ms = 10000) => ate(() => av(expr), ms);
  const foto = async (nome) => {
    if (!SAIDA) return;
    const b = await av(`(() => { const r = document.getElementById('perfil-pop').getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }; })()`);
    const r2 = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...b, scale: 2 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64'));
  };
  const clicar = async (expr) => {
    const p = await av(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!p) throw new Error('sem o elemento: ' + expr);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await dormir(300);
  };
  const botao = (txt) => `[...document.querySelectorAll('#perfil-pop button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(txt)})`;
  const tecla = async (key, code, vk) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await dormir(250); };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: URL_BASE + '/' });
  await espera(`document.readyState === 'complete' && !!document.getElementById('btn-perfil')`);
  await dormir(1500);
  // A instância volta a trabalhar, para o aviso.
  await post(`/sessao/${encodeURIComponent(id)}/mensagem`, { texto: 'DEMORA de novo' });
  await ate(async () => (await estadoDe(id))?.controle?.ocupada === true);

  await clicar(`document.getElementById('btn-perfil')`);
  const sec = await espera(`(() => { const p = document.getElementById('perfil-pop'); const card = p.querySelector('.pf-cl'); if (!card || card.hidden) return null;
    const rots = [...p.querySelectorAll('.pf-rot')].map((x) => x.textContent);
    return { rots, email: card.querySelector('b').textContent, sub: card.querySelector('small').textContent, vinc: card.querySelector('.pf-vinc').textContent,
      nota: p.querySelector('.pf-cl-nota').textContent, trocar: !p.querySelector('.pf-cl ~ button.pf-item:not([hidden])') ? false : [...p.querySelectorAll('button.pf-item')].filter((b) => !b.hidden).map((b) => b.textContent.trim()) }; })()`);
  conferir(sec && sec.rots[0] === 'Claude' && sec.rots[1] === 'GitHub', 'seção Claude acima da do GitHub', sec);
  conferir(sec?.email === EMAIL && /Plano Max 5x/.test(sec.sub) && /Org de Teste/.test(sec.sub) && sec.vinc.includes('Logada'), 'cartão: e-mail, plano, organização e "Logada"', sec);
  conferir(/usuário do computador inteiro/.test(sec?.nota || '') && /terminal, VS Code e instâncias do Orbit/.test(sec.nota), 'nota: o login vale para o computador inteiro (terminal, VS Code e Orbit)', sec?.nota);
  conferir(Array.isArray(sec?.trocar) && sec.trocar.includes('Trocar de conta') && sec.trocar.includes('Sair da conta'), 'itens Trocar de conta e Sair da conta', sec?.trocar);
  await foto('01-conta-logada');

  await clicar(botao('Sair da conta'));
  const conf = await espera(`(() => { const c = document.querySelector('#perfil-pop .pf-conf'); if (!c || c.hidden || !c.querySelector('li')) return null;
    return { tit: c.querySelector('.pf-conf-tit').textContent, itens: [...c.querySelectorAll('li')].map((l) => l.textContent), botoes: [...c.querySelectorAll('.btn')].map((b) => b.textContent.trim()), foco: document.activeElement.textContent.trim(),
      trocarVisivel: [...document.querySelectorAll('#perfil-pop button.pf-item')].some((b) => !b.hidden && b.textContent.includes('Trocar')) }; })()`);
  conferir(conf?.tit === 'Sair da conta do Claude?', 'confirmação de sair aberta', conf);
  conferir(conf?.itens?.some((t) => /No Orbit: 1 instância aberta, 1 trabalhando \(Instância da conta\)/.test(t) && /voltam sozinhas/.test(t)), 'confirmação: a instância do Orbit trabalhando e o que a pausa faz', conf?.itens);
  conferir(conf?.itens?.some((t) => /conectores MCP/.test(t)), 'confirmação: aviso dos conectores MCP', conf?.itens);
  conferir(JSON.stringify(conf?.botoes) === JSON.stringify(['Pausar as instâncias do Orbit e sair', 'Sair sem pausar', 'Cancelar']) && conf.foco === 'Pausar as instâncias do Orbit e sair', 'três botões; o foco no de pausar', conf);
  conferir(conf?.trocarVisivel === false, 'com a confirmação aberta, só o item dela fica', conf);
  await foto('02-confirmar-sair');
  await tecla('Escape', 'Escape', 27);
  const depoisEsc = await av(`({ pop: !document.getElementById('perfil-pop').hidden, conf: !document.querySelector('#perfil-pop .pf-conf').hidden, foco: document.activeElement.textContent.trim() })`);
  conferir(depoisEsc.pop && !depoisEsc.conf && depoisEsc.foco === 'Sair da conta', 'Esc fecha só a confirmação e devolve o foco', depoisEsc);
  conferir(fs.readFileSync(AUTH, 'utf8').includes('"loggedIn":true'), 'nada saiu da conta até aqui');

  // Trocar de conta, pausando: sai, pausa, abre o login e diz com que conta entrou.
  await clicar(botao('Trocar de conta'));
  const tconf = await espera(`(() => { const c = document.querySelector('#perfil-pop .pf-conf'); return c && !c.hidden && c.querySelector('.btn') ? { tit: c.querySelector('.pf-conf-tit').textContent, botoes: [...c.querySelectorAll('.btn')].map((b) => b.textContent.trim()) } : null; })()`);
  conferir(tconf?.tit === 'Trocar de conta do Claude?' && tconf.botoes[0] === 'Pausar as instâncias do Orbit e trocar' && tconf.botoes[1] === 'Trocar sem pausar', 'confirmação de trocar', tconf);
  await clicar(botao('Pausar as instâncias do Orbit e trocar'));
  const ent = await espera(`(() => { const e = document.querySelector('#perfil-pop .pf-cl-ent'); return e && !e.hidden ? { txt: e.textContent, url: e.querySelector('a').href, msg: document.querySelector('#perfil-pop .pf-ok').textContent } : null; })()`, 25000);
  conferir(/Termine o login no navegador/.test(ent?.txt || '') && /pausada: volta depois do novo login/.test(ent?.msg || ''), 'trocar: pausou, saiu e está esperando o navegador', ent);
  await foto('03-entrando');
  const fim = await espera(`(() => { const p = document.getElementById('perfil-pop'); const m = p.querySelector('.pf-ok'); const card = p.querySelector('.pf-cl'); return !card.hidden && m && !m.hidden && /Entrou como/.test(m.textContent) ? { msg: m.textContent, email: card.querySelector('b').textContent, sub: card.querySelector('small').textContent } : null; })()`, 20000);
  conferir(fim?.email === 'nova@exemplo.com' && /Entrou como nova@exemplo\.com\. 1 instância do Orbit voltou a funcionar\./.test(fim.msg) && /Plano Pro/.test(fim.sub), 'depois do login: a conta nova e a instância de volta', fim);
  inst = await ate(async () => { const x = await instancias(); return x.vivas === 1 ? x : null; });
  conferir(inst?.vivas === 1, 'a instância acordou de verdade', inst);
  await foto('04-entrou');

  // Deslogado: "Entrar no Claude".
  await post('/conta/claude/sair', { pausar: false });
  await espera(`(() => { const b = [...document.querySelectorAll('#perfil-pop button.pf-item')].find((x) => !x.hidden && x.textContent.includes('Entrar no Claude')); return !!b; })()`, 10000);
  const sem = await av(`(() => { const p = document.getElementById('perfil-pop'); return { card: !p.querySelector('.pf-cl').hidden, aviso: [...p.querySelectorAll('.pf-aviso')].filter((a) => !a.hidden).map((a) => a.textContent) }; })()`);
  conferir(!sem.card && sem.aviso.some((t) => /Nenhuma conta do Claude logada/.test(t)), 'deslogado: aviso e "Entrar no Claude"', sem);
  await foto('05-deslogado');
  // Largura estreita (barra do topo): o menu cabe.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await dormir(500);
  await clicar(`document.getElementById('btn-perfil')`);
  if (await av(`document.getElementById('perfil-pop').hidden`)) await clicar(`document.getElementById('btn-perfil')`);
  const estreito = await av(`(() => { const r = document.getElementById('perfil-pop').getBoundingClientRect(); return { x: r.x, w: r.width, dir: r.right, vw: innerWidth, rolagem: document.documentElement.scrollWidth > innerWidth }; })()`);
  conferir(estreito.x >= 0 && estreito.dir <= estreito.vw && !estreito.rolagem, '420 px: o menu cabe na tela', estreito);

  conferir(erros.length === 0, 'sem exceção, aviso ou erro no console' + (erros.length ? ': ' + erros.slice(0, 6).join(' | ') : ''));
  const log2 = fs.readFileSync(LOG_AUTH, 'utf8');
  conferir(!/"auth","login".*"--claudeai"|--console/.test(log2), 'o login usa o padrão (assinatura do Claude)');
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e.message);
} finally {
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  const s = await saude();
  if (s?.pid) await desligarSeMeu(PORTA, s.pid);
  await dormir(500);
  const m = (() => { try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch { return null; } })();
  if (m?.pid) try { process.kill(m.pid); } catch {}
  await dormir(300);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
