// Teste da seção "Permissões dos agentes" das Configurações (regras.mjs + assets/regras.js): servidor de teste
// numa porta livre (47822–47826), Edge headless mudo, um projeto falso numa pasta temporária (entra pela
// sessão do hook). Nunca toca a 47821 nem o .claude do Orbit (conferido no fim).
// node testes/regras-ui.test.mjs <pasta-de-saida>   (~20 s; capturas 01–03 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-regras-teste'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes'), FALSO = path.join(SAIDA, 'projeto-falso');
for (const d of [DADOS, PERFIL, SESS, FALSO, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS, path.join(FALSO, '.claude')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
fs.writeFileSync(path.join(FALSO, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test *)'] } }, null, 2));
const LOCAL = path.join(FALSO, '.claude', 'settings.local.json');
const DO_ORBIT = ['settings.json', 'settings.local.json'].map((n) => path.join(PROJ, '.claude', n));
const orbitAntes = DO_ORBIT.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const local = () => (fs.existsSync(LOCAL) ? JSON.parse(fs.readFileSync(LOCAL, 'utf8')) : null);

let srv, pcdp;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const ev = await fetch(BASE + '/evento', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'teste-regras-1', hook_event_name: 'SessionStart', cwd: FALSO, source: 'startup' }) });
  conferir(ev.ok, 'sessão falsa entrou pelo hook', ev.status);
  const sem = await fetch(BASE + '/regras/remover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pasta: FALSO, arquivo: 'projeto', tipo: 'allow', regra: 'Bash(npm test *)' }) });
  conferir(sem.status === 403, 'POST sem x-gerenciador → 403', sem.status);

  const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9800 + Math.floor(Math.random() * 150);
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
  // Captura só da seção (rolada para o meio da modal).
  const foto = async (nome) => {
    const c = await av(`(() => { const el = document.getElementById('cfg-regras').closest('section'); el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { x: r.left - 8, y: Math.max(0, r.top - 8), w: r.width + 16, h: Math.min(r.height + 16, innerHeight - Math.max(0, r.top - 8)) }; })()`);
    await dormir(150);
    const r2 = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64'));
  };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2200);

  await av(`document.getElementById('nav-config').click()`);
  await dormir(1200);
  const falsoJS = JSON.stringify(FALSO);
  const proj = `[...document.querySelectorAll('#cfg-regras .rg-proj')].find((p) => p.querySelector('.rg-pasta')?.title === ${falsoJS})`;
  let p = await av(`(() => { const p = ${proj}; return p ? { regras: [...p.querySelectorAll('.rg-regra code')].map((c) => c.textContent), botao: p.querySelector('.rg-cab .btn')?.textContent, arq: p.querySelector('.rg-arq-rot')?.textContent } : null; })()`);
  conferir(p && p.regras.length === 1 && p.regras[0] === 'Bash(npm test *)', 'lista a regra do settings.json do projeto', p);
  conferir(p && p.arq === 'Compartilhado no repositório', 'diz de qual arquivo é a regra', p);
  conferir(p && p.botao === undefined, 'não oferece mais pacote de regras', p);
  await foto('01-lista');

  // Uma regra criada pelo "Permitir sempre" (por fora, como o claude grava) aparece ao vivo depois do SSE/abrir.
  fs.writeFileSync(LOCAL, JSON.stringify({ permissions: { allow: ['Bash(cargo build *)'], deny: ['Bash(git diff *--output*)'] } }, null, 2));
  await av(`window.Regras.atualizar()`);
  await dormir(500);
  p = await av(`(() => { const p = ${proj}; return { regras: [...p.querySelectorAll('.rg-regra')].map((li) => li.textContent), arqs: [...p.querySelectorAll('.rg-arq-rot')].map((x) => x.textContent) }; })()`);
  conferir(p.regras.length === 3 && p.arqs.join() === 'Só nesta máquina,Compartilhado no repositório', 'lista as regras dos dois arquivos', p);
  conferir(p.regras.some((t) => t.startsWith('Negar') && t.includes('git diff *--output*')), 'a negação aparece marcada como Negar', p);
  await foto('02-duas');

  // Remover uma regra.
  await av(`[...${proj}.querySelectorAll('.rg-regra')].find((li) => li.querySelector('code').textContent === 'Bash(cargo build *)').querySelector('.rg-x').click()`);
  await dormir(800);
  conferir(local().permissions.allow.length === 0 && local().permissions.deny.length === 1, 'remover tira só a regra do arquivo', local());
  p = await av(`(() => { const p = ${proj}; return { tem: [...p.querySelectorAll('.rg-regra code')].some((c) => c.textContent === 'Bash(cargo build *)'), foco: document.activeElement?.className }; })()`);
  conferir(!p.tem, 'a regra some da tela', p);
  conferir(/rg-x|btn/.test(p.foco || ''), 'o foco fica na seção depois de remover', p);
  await foto('03-removida');

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge'));
  const orbitDepois = DO_ORBIT.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null));
  conferir(JSON.stringify(orbitDepois) === JSON.stringify(orbitAntes), 'o .claude do Orbit não foi tocado');
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
