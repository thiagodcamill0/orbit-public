// Teste da aba Skills (skills.mjs + assets/skills.js), da seção "Skills usadas" do detalhe e das skills na Nova
// instância: servidor de teste numa porta livre (47822–47826), Edge headless mudo, projeto e "pasta pessoal"
// falsos, claude-falso como sonda e como instância. Nunca toca a 47821, o .claude do Orbit nem o ~/.claude real
// (conferido no fim).
// node testes/skills-ui.test.mjs <pasta-de-saida>   (~40 s; capturas 01–06 na pasta de saída)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { matarArvore } from '../plataforma.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || os.tmpdir(), 'orbit-skills-teste'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const WIN = process.platform === 'win32';
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes'), FALSO = path.join(SAIDA, 'meu-app'), CASA = path.join(SAIDA, 'casa');
const PROJETOS = path.join(DADOS, 'projetos');
for (const d of [DADOS, PERFIL, SESS, FALSO, CASA, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS, PROJETOS, path.join(FALSO, '.claude')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
function skill(dir, nome, desc) {
  fs.mkdirSync(path.join(dir, nome), { recursive: true });
  fs.writeFileSync(path.join(dir, nome, 'SKILL.md'), `---\nname: ${nome}\ndescription: ${desc}\n---\n\n# ${nome}\n\nPassos.\n`);
}
const SK = path.join(FALSO, '.claude', 'skills');
const PESS = path.join(CASA, '.claude', 'skills');
skill(SK, 'alfa', 'Revisa pull requests do app');
skill(SK, 'beta', 'Gera o changelog da versão');
skill(SK, 'dup', 'Versão do projeto');
skill(PESS, 'dup', 'Versão pessoal');
skill(PESS, 'minha', 'Uma skill pessoal');
fs.writeFileSync(path.join(FALSO, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2));
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: 'meu-app', pasta: FALSO, desde: 1 }], ocultos: [] }));
const LOG_INIT = path.join(SAIDA, 'init.log');
fs.rmSync(LOG_INIT, { force: true });
// Transcript de uma sessão que usou skills (a do hook).
const TRANS = path.join(SAIDA, 'sessao.jsonl');
const L = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(TRANS, [
  L({ type: 'user', timestamp: '2026-10-17T10:00:00Z', message: { role: 'user', content: 'revise' } }),
  L({ type: 'assistant', timestamp: '2026-10-17T10:00:05Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'alfa' } }] } }),
  L({ type: 'user', timestamp: '2026-10-17T10:01:00Z', message: { role: 'user', content: '<command-name>/beta</command-name>' } }),
  L({ type: 'user', timestamp: '2026-10-17T10:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: x' }] } }),
  L({ type: 'assistant', timestamp: '2026-10-17T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'alfa' } }] } }),
].join(''));

const DO_ORBIT = ['settings.json', 'settings.local.json'].map((n) => path.join(PROJ, '.claude', n));
const ler = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const orbitAntes = DO_ORBIT.map(ler);
const realSkills = path.join(os.homedir(), '.claude', 'skills');
const listaReal = () => { try { return fs.readdirSync(realSkills).sort().join(','); } catch { return ''; } };
const realAntes = listaReal();
const realSettingsAntes = ler(path.join(os.homedir(), '.claude', 'settings.json'));

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const settings = () => JSON.parse(fs.readFileSync(path.join(FALSO, '.claude', 'settings.json'), 'utf8'));

let srv, pcdp;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: {
      ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL,
      GERENCIADOR_CASA: CASA, ORBIT_PROJETOS_DIR: PROJETOS, ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'),
      ORBIT_LIXEIRA_FALSA: path.join(SAIDA, 'lixeira'), FALSO_LOG_INIT: LOG_INIT, FALSO_LOG: path.join(SAIDA, "falso.log"), FALSO_SKILLS_PESSOAIS: PESS, FALSO_SKILLS_PLUGIN: 'prod:start',
      ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
    },
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const ev = await fetch(BASE + '/evento', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'teste-skills-1', hook_event_name: 'SessionStart', cwd: FALSO, source: 'startup', transcript_path: TRANS }) });
  conferir(ev.ok, 'sessão falsa entrou pelo hook', ev.status);

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
    // 4xx esperados: 428 (confirmação global) e o /modelos.
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon|\/modelos$|\/skills\/salvar/.test(d.params.entry.url || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
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
  const esperar = async (expr, ms = 6000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await av(expr); if (v) return v; await dormir(120); } return v; };
  // Campo controlado: valor + evento input (como digitar).
  const digitar = (sel, v) => av(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const clicar = (sel) => av(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const clicarTexto = (sel, t) => av(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().includes(${JSON.stringify(t)})); if (!el) return false; el.click(); return true; })()`);
  const linhas = () => av(`[...document.querySelectorAll('.sk-item')].map((i) => ({ id: i.dataset.id, txt: i.textContent, on: i.querySelector('.sk-chave').checked, dis: i.querySelector('.sk-chave').disabled }))`);

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2500);

  // ── abrir a aba pela lateral e escolher o projeto ──
  conferir(await av(`!!document.getElementById('nav-skills') && !!document.getElementById('btn-skills-e')`), 'item Skills na lateral (e na faixa estreita)');
  await clicar('#nav-skills');
  conferir(await esperar(`!!document.querySelector('.sk .sk-lista')`), 'a aba Skills abre');
  conferir(await av(`document.getElementById('nav-skills').getAttribute('aria-current') === 'page'`), 'o item da lateral fica aceso com a aba em foco');
  await esperar(`[...document.querySelectorAll('.sk-proj select option')].some((o) => o.value === ${JSON.stringify(FALSO)})`);
  await av(`(() => { const s = document.querySelector('.sk-proj select'); s.value = ${JSON.stringify(FALSO)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await esperar(`document.querySelectorAll('.sk-item').length >= 6`);
  let l = await linhas();
  conferir(l && l.map((x) => x.id).join() === 'projeto:alfa,projeto:beta,projeto:dup,pessoal:dup,pessoal:minha,plugin:prod:start', 'lista projeto, pessoais e plugin, em grupos', l && l.map((x) => x.id));
  const grupos = await av(`[...document.querySelectorAll('.sk-grupo-tit')].map((g) => g.firstChild.textContent)`);
  conferir(JSON.stringify(grupos) === JSON.stringify(['Projeto', 'Pessoais · globais', 'Plugins']), 'títulos dos grupos', grupos);
  conferir(l.find((x) => x.id === 'projeto:dup').txt.includes('escondida pela pessoal'), 'a do projeto com nome repetido aparece como escondida');
  conferir(l.find((x) => x.id === 'plugin:prod:start').dis, 'a de plugin não muda pelo projeto (interruptor travado)');
  conferir(await av(`document.querySelector('.sk-info').textContent.includes('.claude/settings.json')`), 'diz onde o ativo/inativo fica gravado');
  await foto('01-lista');

  // ── desativar pelo interruptor ──
  await av(`document.querySelector('.sk-item[data-id="projeto:alfa"] .sk-chave').click()`);
  await esperar(`!document.querySelector('.sk-item[data-id="projeto:alfa"] .sk-chave').checked && document.querySelector('.sk-item[data-id="projeto:alfa"]').classList.contains('off')`);
  conferir(JSON.stringify(settings()) === JSON.stringify({ permissions: { allow: ['Read'] }, skillOverrides: { alfa: 'off' } }), 'desativar grava o skillOverrides no settings.json do projeto (o resto fica)', settings());
  await av(`document.querySelector('.sk-item[data-id="projeto:alfa"] .sk-chave').click()`);
  await esperar(`!document.querySelector('.sk-item[data-id="projeto:alfa"]').classList.contains('off')`);
  for (let i = 0; i < 30 && settings().skillOverrides; i++) await dormir(100);
  conferir(JSON.stringify(settings()) === JSON.stringify({ permissions: { allow: ['Read'] } }), 'reativar tira a entrada', settings());

  // ── criar no projeto (padrão) ──
  await clicar('.sk-nova');
  await esperar(`!!document.querySelector('.sk-ed select')`);
  conferir(await av(`document.querySelector('.sk-ed select').value`) === 'projeto', 'Nova skill começa no projeto');
  // ── seletor: abre a lista do Orbit (não a nativa), marca a atual, escolhe e fecha com Esc ──
  const abrirSel = (sel) => av(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)
    .then(async (p) => { for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }); });
  await abrirSel('.sk-ed select');
  const lista = await esperar(`(() => { const l = document.querySelector('.sk-lista-sel'); return l && [...l.querySelectorAll('[role="option"]')].map((o) => (o.classList.contains('on') ? '*' : '') + o.textContent.split(' ·')[0]).join(); })()`);
  conferir(lista === '*Projeto,Pessoal' && await av(`document.querySelector('.sk-ed select').getAttribute('aria-expanded') === 'true'`), 'o seletor abre a lista do Orbit, com a opção atual marcada', lista);
  await foto('02-seletor', '.sk-lista-sel');
  await clicarTexto('.sk-lista-sel [role="option"]', 'Pessoal');
  conferir(await av(`document.querySelector('.sk-ed select').value === 'pessoal' && !document.querySelector('.sk-lista-sel')`), 'escolher na lista muda o seletor e fecha a lista');
  await abrirSel('.sk-ed select');
  await esperar(`!!document.querySelector('.sk-lista-sel')`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  conferir(await esperar(`!document.querySelector('.sk-lista-sel') && document.activeElement === document.querySelector('.sk-ed select')`), 'Esc fecha a lista e devolve o foco ao seletor');
  await digitar('.sk-ed select', 'projeto');
  await digitar('.sk-ed input.sk-campo', 'deploy-app');
  await digitar('.sk-ed .sk-desc-ed', 'Faz o deploy do app: build, testes e publicação');
  await digitar('.sk-ed .sk-corpo-ed', '# Passos\n\n1. npm test\n2. npm run build\n');
  await foto('02-nova', '.sk-ed');
  await clicarTexto('.sk-pe .btn', 'Criar skill');
  const criada = path.join(SK, 'deploy-app', 'SKILL.md');
  await esperar(`document.querySelector('.sk-ed h2')?.textContent === 'deploy-app'`);
  conferir(fs.existsSync(criada) && /^---\nname: deploy-app\ndescription: "Faz o deploy do app: build, testes e publicação"\n---\n\n# Passos/.test(fs.readFileSync(criada, 'utf8')), 'cria .claude/skills/deploy-app/SKILL.md no projeto', ler(criada));
  conferir(await av(`!!document.querySelector('.sk-item[data-id="projeto:deploy-app"].sel')`), 'a nova entra na lista, selecionada');

  // ── pessoal: pede confirmação explícita antes ──
  await clicar('.sk-nova');
  await esperar(`!!document.querySelector('.sk-ed select')`);
  await digitar('.sk-ed select', 'pessoal');
  await digitar('.sk-ed input.sk-campo', 'global-teste');
  await digitar('.sk-ed .sk-desc-ed', 'Uma skill global');
  await clicarTexto('.sk-pe .btn', 'Criar skill');
  const m1 = await esperar(`document.querySelector('.sk-modal')?.textContent`);
  conferir(m1 && /todos os projetos/.test(m1) && /global/.test(m1), 'modal de confirmação global antes de gravar na pasta pessoal', m1);
  await foto('03-confirmar-global', '.sk-modal');
  await clicarTexto('.sk-modal .btn', 'Cancelar');
  await dormir(400);
  conferir(!fs.existsSync(path.join(PESS, 'global-teste')), 'cancelar não grava nada na pasta pessoal');
  await clicarTexto('.sk-pe .btn', 'Criar skill');
  await esperar(`!!document.querySelector('.sk-modal')`);
  await clicarTexto('.sk-modal .btn', 'Confirmar mudança global');
  await esperar(`document.querySelector('.sk-ed h2')?.textContent === 'global-teste'`);
  conferir(fs.existsSync(path.join(PESS, 'global-teste', 'SKILL.md')), 'confirmado, grava na pasta pessoal (a falsa)');

  // ── editar uma existente e um arquivo de apoio ──
  await clicar('.sk-item[data-id="projeto:beta"]');
  await esperar(`document.querySelector('.sk-ed h2')?.textContent === 'beta' && !!document.querySelector('.sk-ed .sk-desc-ed')`);
  conferir(await av(`document.querySelector('.sk-estado select')?.value`) === 'on', 'o editor mostra o estado no projeto');
  await digitar('.sk-ed .sk-desc-ed', 'Gera o changelog da versão a partir dos commits');
  conferir(await av(`document.querySelector('.sk-msg').textContent`) === 'Alterações não salvas', 'avisa alteração não salva');
  await av(`document.querySelector('.sk').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`);
  await esperar(`document.querySelector('.sk-msg')?.textContent === ''`);
  conferir(/description: Gera o changelog da versão a partir dos commits/.test(ler(path.join(SK, 'beta', 'SKILL.md'))), 'Ctrl+S salva a descrição no SKILL.md');
  await clicar('.sk-arq-novo');
  await esperar(`!!document.querySelector('.sk-modal input')`);
  await digitar('.sk-modal input', 'modelos/changelog.md');
  await clicarTexto('.sk-modal .btn', 'Criar');
  await esperar(`!!document.querySelector('.sk-arq-ed')`);
  await digitar('.sk-arq-ed', '## Versão X\n');
  await clicarTexto('.sk-arq-topo .btn', 'Salvar arquivo');
  await esperar(`document.querySelector('.sk-arq-topo .sk-msg')?.textContent === ''`);
  conferir(ler(path.join(SK, 'beta', 'modelos', 'changelog.md')) === '## Versão X\n', 'cria e salva o arquivo de apoio');
  await foto('04-editor', '.sk-ed');

  // ── duplicar e excluir ──
  await clicarTexto('.sk-ed-acoes .btn', 'Duplicar');
  await esperar(`!!document.querySelector('.sk-modal input')`);
  conferir(await av(`document.querySelector('.sk-modal input').value`) === 'beta-copia' && await av(`document.querySelector('.sk-modal select').value`) === 'projeto', 'duplicar sugere nome-copia no projeto');
  await clicarTexto('.sk-modal .btn', 'Duplicar');
  await esperar(`document.querySelector('.sk-ed h2')?.textContent === 'beta-copia'`);
  conferir(ler(path.join(SK, 'beta-copia', 'modelos', 'changelog.md')) === '## Versão X\n', 'a cópia leva os arquivos de apoio');
  await clicar('.sk-excluir');
  await esperar(`!!document.querySelector('.sk-modal')`);
  conferir(/Lixeira/.test(await av(`document.querySelector('.sk-modal').textContent`)), 'excluir avisa que vai para a Lixeira');
  await clicarTexto('.sk-modal .btn', 'Excluir');
  await esperar(`!document.querySelector('.sk-item[data-id="projeto:beta-copia"]')`);
  conferir(!fs.existsSync(path.join(SK, 'beta-copia')) && fs.readdirSync(path.join(SAIDA, 'lixeira')).some((n) => n.endsWith('beta-copia')), 'excluída para a Lixeira (de teste)');
  await foto('05-aba');

  // ── detalhe da sessão: skills usadas ──
  await clicar('[data-vista="geral"]');
  await esperar(`!!document.querySelector('#lista [data-id="teste-skills-1"]')`);
  await clicar('#lista [data-id="teste-skills-1"]');
  const sec = await esperar(`(() => { const s = document.getElementById('pk-sec-skills'); return s && !s.hidden ? s.textContent : null; })()`, 8000);
  conferir(sec && /alfa/.test(sec) && /×2/.test(sec) && /beta/.test(sec), 'detalhe mostra as skills usadas (alfa ×2, beta por /)', sec);
  await dormir(600); await foto('06-detalhe');

  // ── Nova instância: as ativas do projeto marcadas; desmarcar uma manda a allowlist ──
  await av(`document.getElementById('pk-fechar')?.click()`);
  await dormir(300);
  await clicar('#btn-nova');
  await esperar(`!!document.getElementById('ni-pop') && !document.getElementById('ni-pop').hidden`, 8000);
  await av(`(() => { const s = document.getElementById('ni-pasta'); s.value = ${JSON.stringify(FALSO)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const resumo = await esperar(`(() => { const t = document.getElementById('ni-sk-resumo')?.textContent || ''; return /Todas as ativas/.test(t) ? t : null; })()`, 8000);
  // ativas: alfa, beta, deploy-app (projeto), dup e minha e global-teste (pessoais), prod:start (plugin); a dup do projeto fica de fora
  conferir(resumo === 'Todas as ativas do projeto (7)', 'resumo das skills na Nova instância', resumo || await av(`document.getElementById('ni-sk-resumo')?.textContent`));
  await clicar('.ni-sk-btn');
  await esperar(`!document.getElementById('ni-sk-lista').hidden`);
  await av(`(() => { const c = document.querySelector('#ni-sk-lista input[data-chave="beta"]'); c.click(); })()`);
  conferir(await av(`document.getElementById('ni-sk-resumo').textContent`) === '6 de 7 ativas', 'desmarcar atualiza o resumo');
  await foto('07-nova-instancia', '#ni-pop');
  await clicar('.ni-criar');
  // A 1ª linha com allowlist (as sondas e a instância sem escolha mandam skills: null). A 1ª instância espera o motor subir.
  const ini = await (async () => { for (let i = 0; i < 200; i++) { const t = ler(LOG_INIT); const a = t ? t.trim().split('\n').map((x) => JSON.parse(x)).find((x) => Array.isArray(x.skills)) : null; if (a) return a; await dormir(150); } return null; })();
  conferir(ini && JSON.stringify([...ini.skills].sort()) === JSON.stringify(['alfa', 'deploy-app', 'dup', 'global-teste', 'minha', 'prod:start']), 'a instância nasce com a allowlist sem a beta', ini ? ini.skills : { erro: await av(`document.querySelector('#ni-pop .ni-erro')?.textContent`), dbg: await av(`JSON.stringify(window.Instancias._debug())`), aberto: await av(`!document.getElementById('ni-pop').hidden`), inst: await (await fetch(BASE + '/instancias')).text(), falso: (ler(path.join(SAIDA, 'falso.log')) || '').split('\n').filter((x) => !x.includes('no-session-persistence')).join('\n').slice(0, 1500) });

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
  conferir(JSON.stringify(DO_ORBIT.map(ler)) === JSON.stringify(orbitAntes), 'o .claude do Orbit não foi tocado');
  conferir(listaReal() === realAntes, 'o ~/.claude/skills real não foi tocado');
  conferir(ler(path.join(os.homedir(), '.claude', 'settings.json')) === realSettingsAntes, 'o ~/.claude/settings.json real não foi tocado');
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
