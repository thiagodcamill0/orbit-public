// Teste da seção Configurações → Conexões MCP (mcp.mjs + assets/mcp.js): servidor de teste numa porta livre
// (47822–47826), Edge headless mudo, projeto e "pasta pessoal" falsos (com o .claude.json), claude-falso como sonda.
// Nunca toca a 47821, o ~/.claude.json real nem um .mcp.json do Orbit (conferido no fim).
// node testes/mcp-ui.test.mjs <pasta-de-saida>   (~30 s; capturas 01–05 na pasta de saída)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { matarArvore } from '../plataforma.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || os.tmpdir(), 'orbit-mcp-ui-teste'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const WIN = process.platform === 'win32';
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes'), FALSO = path.join(SAIDA, 'meu-app'), CASA = path.join(SAIDA, 'casa');
const PROJETOS = path.join(DADOS, 'projetos');
for (const d of [DADOS, PERFIL, SESS, FALSO, CASA, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS, PROJETOS, FALSO, CASA]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: 'meu-app', pasta: FALSO, desde: 1 }], ocultos: [] }));
const MCP_JSON = path.join(FALSO, '.mcp.json');
fs.writeFileSync(MCP_JSON, JSON.stringify({ mcpServers: { clonado: { command: 'npx', args: ['-y', 'pacote-do-repo'], env: { API_KEY: 'literal-no-repo-123' } } } }, null, 2));
const CJ = path.join(CASA, '.claude.json');
fs.writeFileSync(CJ, JSON.stringify({ projects: { [FALSO.replace(/\\/g, '/')]: { mcpServers: { meu: { type: 'stdio', command: 'node', args: ['meu.js'] } } } }, mcpServers: { pessoal1: { type: 'http', url: 'https://pessoal.exemplo/mcp' } } }, null, 2));

// O ~/.claude.json real: só as partes de MCP (o resto muda sozinho com as sessões abertas).
const realCj = path.join(os.homedir(), '.claude.json');
const mcpReal = () => { try { const j = JSON.parse(fs.readFileSync(realCj, 'utf8')); return JSON.stringify([j.mcpServers || null, Object.entries(j.projects || {}).map(([k, v]) => [k, v.mcpServers || null, v.disabledMcpServers || null])]); } catch { return 'sem'; } };
const realAntes = mcpReal();
const orbitMcpAntes = fs.existsSync(path.join(PROJ, '.mcp.json'));

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const lerJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

let srv, pcdp;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: {
      ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL,
      GERENCIADOR_CASA: CASA, ORBIT_PROJETOS_DIR: PROJETOS, ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'),
      FALSO_MCP_PLUGIN: 'plugin:falso:x',
      ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
    },
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

  const EDGE = caminhoNavegador();
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${path.join(SAIDA, 'edge')}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon|\/modelos$/.test(d.params.entry.url || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const foto = async (nome, sel) => {
    let clip;
    if (sel) {
      const c = await av(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), w: Math.min(r.width + 16, innerWidth), h: Math.min(r.height + 16, innerHeight) }; })()`);
      if (c) clip = { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 };
    }
    await dormir(150);
    const r2 = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64'));
  };
  const esperar = async (expr, ms = 8000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await av(expr); if (v) return v; await dormir(120); } return v; };
  const digitar = (sel, v) => av(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const clicar = (sel) => av(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const linha = (nome) => `[...document.querySelectorAll('.mcp-srv')].find((li) => li.querySelector('.mcp-nome')?.textContent === ${JSON.stringify(nome)})`;
  const txtLinha = (nome) => av(`(${linha(nome)})?.textContent || ''`);
  const rolarAte = (sel) => av(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el?.scrollIntoView({ block: 'center' }); return !!el; })()`);
  const balaoAberto = () => esperar(`!document.getElementById('balao').hidden`, 4000);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2500);

  // ── abrir as Configurações: a seção carrega, escolhe o projeto e verifica sozinha ──
  await clicar('#nav-config');
  conferir(await esperar(`!!document.querySelector('#cfg-mcp .mcp-cab')`), 'a seção Conexões MCP aparece nas Configurações');
  await esperar(`[...document.querySelectorAll('#cfg-mcp .mcp-sel option')].some((o) => o.value === ${JSON.stringify(FALSO)})`);
  await av(`(() => { const s = document.querySelector('#cfg-mcp .mcp-cab .mcp-sel'); s.value = ${JSON.stringify(FALSO)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await esperar(`document.querySelectorAll('.mcp-srv').length >= 3`);
  const verificado = await esperar(`(${linha('pessoal1')})?.textContent.includes('Conectado') && !!(${linha('plugin:falso:x')})`, 12000);
  conferir(verificado, 'verifica ao abrir: o pessoal conecta e o plugin entra na lista', await txtLinha('pessoal1'));
  let t = await txtLinha('clonado');
  conferir(/Local/.test(t) && /Projeto/.test(t) && /Aguardando sua aprovação/.test(t), 'clonado: local, projeto, aguardando aprovação', t);
  conferir(t.includes('npx -y pacote-do-repo') && t.includes('API_KEY'), 'o pendente mostra o comando completo e as variáveis', t);
  conferir(!t.includes('literal-no-repo-123'), 'o valor da chave em texto puro não aparece na página');
  conferir(/Chave em texto puro no projeto: API_KEY/.test(t), 'avisa a chave em texto puro', t);
  conferir(await av(`document.querySelector('.mcp-pend')?.textContent.includes('1 servidor do .mcp.json espera')`), 'aviso dos pendentes no topo');
  const tMeu = await txtLinha('meu');
  conferir(/Pessoal · este projeto/.test(tMeu) && /Conectado/.test(tMeu), 'o local do ~/.claude.json aparece como pessoal deste projeto', tMeu);
  conferir(/Pessoal · todos/.test(await txtLinha('pessoal1')) && /Remoto/.test(await txtLinha('pessoal1')), 'o user aparece como pessoal de todos, remoto');
  conferir(await av(`(${linha('plugin:falso:x')}).querySelector('.mcp-tg').disabled && !(${linha('plugin:falso:x')}).querySelector('.mcp-x')`), 'plugin só leitura (interruptor travado, sem remover)');
  await rolarAte('#cfg-mcp');
  await foto('01-lista', '#cfg-mcp');

  // ── aprovar o clonado ──
  await av(`(${linha('clonado')}).querySelector('[data-k^="aprovar"]').click()`);
  conferir(await esperar(`!document.querySelector('.mcp-pend') && /Conectado|Falhou/.test((${linha('clonado')})?.textContent || '')`, 12000), 'aprovar tira do pendente e a verificação seguinte conecta', await txtLinha('clonado'));
  const est = lerJ(path.join(DADOS, 'mcp-orbit.json'));
  conferir(Object.values(est.aprovados).some((a) => a.clonado), 'a aprovação fica no mcp-orbit.json do Orbit (fora do projeto)');

  // ── proteger: a chave vai para o cofre ──
  if (WIN) {
    await av(`(${linha('clonado')}).querySelector('[data-k^="proteger"]').click()`);
    conferir(await balaoAberto(), 'proteger pergunta antes (balão)');
    await clicar('#balao-sim');
    conferir(await esperar(`!/texto puro/.test((${linha('clonado')})?.textContent || '') && /API_KEY no cofre/.test((${linha('clonado')})?.textContent || '')`, 8000), 'depois de proteger: "API_KEY no cofre"', await txtLinha('clonado'));
    const env = lerJ(MCP_JSON).mcpServers.clonado.env;
    conferir(/^\$\{ORBIT_MCP_CLONADO_API_KEY_[0-9A-F]{4}\}$/.test(env.API_KEY) && !fs.readFileSync(MCP_JSON, 'utf8').includes('literal-no-repo-123'), 'o .mcp.json fica só com ${ORBIT_MCP_…}', env);
  }

  // ── adicionar um remoto com chave, no projeto ──
  await clicar('[data-k="adicionar"]');
  conferir(await esperar(`!!document.querySelector('.mcp-form')`), 'o formulário abre');
  await digitar('[data-k="f-nome"]', 'busca');
  await clicar('[data-k="f-tipo-remoto"]');
  await esperar(`!!document.querySelector('[data-k="f-url"]')`);
  await digitar('[data-k="f-url"]', 'https://mcp.busca.exemplo/mcp');
  await clicar('[data-k="f-mais"]');
  await digitar('[data-k="f-ck0"]', 'Authorization');
  await digitar('[data-k="f-cv0"]', 'Bearer chave-da-ui-777');
  conferir(await av(`document.querySelector('[data-k="f-cv0"]').type === 'password'`), 'o valor da chave é campo de senha');
  conferir(await av(`document.querySelector('[data-k="f-onde"]').value === 'projeto'`), 'salvar em: projeto por padrão');
  await rolarAte('.mcp-form');
  await foto('02-formulario', '.mcp-form');
  if (WIN) {
    await clicar('[data-k="f-ok"]');
    conferir(await esperar(`!document.querySelector('.mcp-form') && !!(${linha('busca')})`, 8000), 'adicionar fecha o formulário e o servidor entra na lista', await av(`document.querySelector('.mcp-form .mcp-erro')?.textContent`));
    const cfg = lerJ(MCP_JSON).mcpServers.busca;
    conferir(cfg && cfg.type === 'http' && /^\$\{ORBIT_MCP_BUSCA_AUTHORIZATION_[0-9A-F]{4}\}$/.test(cfg.headers.Authorization), 'no .mcp.json: http e o cabeçalho com ${ORBIT_MCP_…}', cfg);
    conferir(!fs.readFileSync(MCP_JSON, 'utf8').includes('chave-da-ui-777'), 'o valor não vai para o projeto');
    conferir(/Authorization no cofre/.test(await txtLinha('busca')), 'a linha mostra "Authorization no cofre"', await txtLinha('busca'));
  } else {
    await clicar('[data-k="f-cancelar"]');
  }

  // ── desativar um pessoal: pergunta; cancelar não muda nada; confirmar grava só neste projeto ──
  const cjAntes = fs.readFileSync(CJ, 'utf8');
  await av(`(${linha('pessoal1')}).querySelector('.mcp-tg').click()`);
  conferir(await balaoAberto(), 'desativar um pessoal pergunta antes');
  conferir(await av(`/configuração pessoal/.test(document.getElementById('balao-tit').textContent) && /todos os projetos/.test(document.getElementById('balao-txt').textContent)`), 'o balão diz que é pessoal e vale para todos');
  await foto('03-confirmar-pessoal');
  // Esc de verdade (o foco está no balão): fecha só o balão; as Configurações seguem abertas.
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await esperar(`document.getElementById('balao').hidden`, 3000);
  await dormir(300);
  conferir(await av(`!document.getElementById('camada-config').hidden`), 'Esc no balão não fecha as Configurações');
  if (await av(`document.getElementById('camada-config').hidden`)) { await clicar('#nav-config'); await esperar(`!!(${linha('pessoal1')})`); }
  conferir(fs.readFileSync(CJ, 'utf8') === cjAntes && await av(`(${linha('pessoal1')}).querySelector('.mcp-tg').checked`), 'cancelar não muda o ~/.claude.json nem o interruptor');
  await av(`(${linha('pessoal1')}).querySelector('.mcp-tg').click()`);
  await balaoAberto();
  await clicar('#balao-sim');
  conferir(await esperar(`/Desativado neste projeto/.test((${linha('pessoal1')})?.textContent || '')`), 'confirmado: aparece desativado neste projeto');
  const cj = lerJ(CJ);
  conferir(JSON.stringify(cj.projects[FALSO.replace(/\\/g, '/')].disabledMcpServers) === '["pessoal1"]' && cj.mcpServers.pessoal1, 'grava o disabledMcpServers só do projeto; o servidor pessoal continua', cj.projects);

  // ── desativar um do projeto: sem pergunta, no .claude/settings.json ──
  await av(`(${linha('clonado')}).querySelector('.mcp-tg').click()`);
  conferir(await esperar(`/Desativado neste projeto/.test((${linha('clonado')})?.textContent || '')`), 'desativar um do projeto não pergunta');
  conferir(JSON.stringify(lerJ(path.join(FALSO, '.claude', 'settings.json'))) === '{"disabledMcpjsonServers":["clonado"]}', 'grava no .claude/settings.json do projeto');

  // ── remover ──
  const alvoRm = WIN ? 'busca' : 'clonado';
  await av(`(${linha(alvoRm)}).querySelector('.mcp-x').click()`);
  conferir(await balaoAberto(), 'remover pergunta antes');
  await clicar('#balao-sim');
  conferir(await esperar(`!(${linha(alvoRm)})`), 'removido some da lista');
  conferir(!(alvoRm in lerJ(MCP_JSON).mcpServers), 'e sai do .mcp.json');

  // ── estreito (420): sem rolagem horizontal ──
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await dormir(400);
  conferir(await av(`!document.getElementById('camada-config').hidden`), 'as Configurações seguem abertas para medir o estreito');
  await clicar('[data-k="adicionar"]');
  await esperar(`!!document.querySelector('.mcp-form')`);
  const larg = await av(`(() => { const c = document.querySelector('#camada-config .modal-corpo'); return { sw: c.scrollWidth, cw: c.clientWidth }; })()`);
  conferir(larg && larg.cw > 300 && larg.sw <= larg.cw + 1, 'em 420 px, sem rolagem horizontal', larg);
  const forms = await av(`(() => { const f = document.querySelector('.mcp-form'); const r = f.getBoundingClientRect(); return [...f.querySelectorAll('input, select, button')].every((e) => { const q = e.getBoundingClientRect(); return q.right <= r.right + 1 && q.left >= r.left - 1; }); })()`);
  conferir(forms, 'em 420 px, os campos do formulário cabem na caixa');
  await rolarAte('#cfg-mcp');
  await foto('04-estreito');
  await clicar('[data-k="f-cancelar"]');

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { await fetch(BASE + '/desligar', { method: 'POST', headers: { 'x-gerenciador': '1' } }); } catch {}
  await dormir(500);
  try { srv.kill(); } catch {}
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8'));
    if (m?.pid) { if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else await matarArvore(m.pid); }
  } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge'));
  conferir(mcpReal() === realAntes, 'os MCP do ~/.claude.json real não foram tocados');
  conferir(fs.existsSync(path.join(PROJ, '.mcp.json')) === orbitMcpAntes, 'o .mcp.json do Orbit não foi tocado');
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
