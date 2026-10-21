// Teste de interface do assistente da primeira vez (assets/assistente.js + assistente.mjs).
// Rodar:  node testes/assistente-ui.test.mjs [pasta de saída]
// Sobe o servidor real numa porta de teste (47822–47826, conferida livre) com dados, pasta pessoal, settings do
// Claude e skills temporários (nunca o ~/.claude de quem roda) e o Edge headless (--mute-audio; no fim,
// fecharEdge). Desliga só o que subiu e apaga os temporários. O GitHub e o login do Claude não são exercitados
// aqui (usam as rotas de sempre do menu de perfil).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(PASTA, '..');
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || os.tmpdir(), 'orbit-assistente-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (cond) { ok++; console.log('ok   ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
};

const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-assistente-ui-'));
const DADOS = path.join(TMP, 'dados');
const CASA = path.join(TMP, 'casa');
const SETTINGS = path.join(TMP, 'claude', 'settings.json');
const SKILLS = path.join(TMP, 'claude', 'skills');
const PROJETOS = path.join(TMP, 'projetos da Bia');
for (const p of [DADOS, CASA, path.join(DADOS, 'sessoes'), path.join(TMP, 'local')]) fs.mkdirSync(p, { recursive: true });
const env = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  GERENCIADOR_SETTINGS: SETTINGS,
  GERENCIADOR_SKILLS: SKILLS,
  GERENCIADOR_CLAUDE_HOME: CASA,
  ORBIT_ASSISTENTE: '1',
  USERPROFILE: CASA,
  HOME: CASA,
  LOCALAPPDATA: path.join(TMP, 'local'),
  APPDATA: path.join(TMP, 'local'),
};
delete env.CLAUDE_CODE_HOST_SESSION_ID;
delete env.CLAUDE_PROJECT_DIR;

const servidor = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge');
fs.rmSync(perfil, { recursive: true, force: true });
const pcdp = 9600 + Math.floor(Math.random() * 150);
const barra = (p) => p.replace(/\\/g, '/').toLowerCase();
function settings() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}
  const todos = Object.values(c.hooks || {}).flat().flatMap((g) => g.hooks || []);
  const doHook = todos.filter((h) => (h.args || []).some((x) => barra(x).endsWith('/hook.mjs')));
  return { n: doHook.length, subir: doHook.filter((h) => h.args.includes('--subir')).length, aviso: todos.filter((h) => (h.args || []).some((x) => barra(x).endsWith('/aviso-subagente.mjs'))).length };
}

try {
  let pronto = false;
  for (let i = 0; i < 100 && !pronto; i++) { try { pronto = (await (await fetch(BASE + '/saude')).json()).pid === servidor.pid; } catch {} if (!pronto) await dormir(100); }
  if (!pronto) throw new Error('servidor de teste não subiu');
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${perfil}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pend = new Map(); const erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') erros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') erros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  const espera = async (expr, ms = 5000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await av(expr).catch(() => null); if (v) return v; await dormir(100); } return v; };
  const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  const visivel = `(() => { const c = document.getElementById('camada-assistente'); return !!c && !c.hidden; })()`;
  const semAbertura = `(() => { const a = document.getElementById('abertura'); return !a || !a.isConnected || a.classList.contains('sai') || getComputedStyle(a).display === 'none'; })()`;

  // 1. Primeira vez: abre sozinho, com nada marcado.
  conferir(await espera(visivel, 15000), 'abre sozinho na primeira vez');
  conferir(await espera(semAbertura, 8000), 'a abertura sai e deixa o assistente à vista');
  await dormir(500);
  const est = await (await fetch(BASE + '/assistente')).json();
  const ini = await av(`(() => ({
    nomePh: document.getElementById('as-nome').placeholder, nome: document.getElementById('as-nome').value,
    pasta: document.getElementById('as-pasta').value,
    marcados: ['as-hooks','as-subir','as-aviso','as-liderar','as-celular'].filter((i) => document.getElementById(i).checked),
    subDesl: document.getElementById('as-subir').disabled && document.getElementById('as-aviso').disabled,
    titulo: document.getElementById('as-titulo').textContent }))()`);
  conferir(ini.nomePh === est.nomeSistema && ini.nome === '', 'nome vazio, com o da conta do sistema de sugestão', ini);
  conferir(barra(ini.pasta) === barra(path.dirname(RAIZ)), 'pasta de projetos: a de cima da do Orbit', ini);
  conferir(ini.marcados.length === 0, 'nenhuma permissão marcada de saída', ini);
  conferir(ini.subDesl, 'abrir sozinho e aviso só valem com os hooks', ini);
  const selo = await av(`(() => { const op = document.getElementById('as-hooks').closest('.as-opcao'); const s = op.querySelector('.as-selo'); const a = document.getElementById('as-hooks-alerta'); return { selo: s && s.textContent, seloVe: !!s && s.getBoundingClientRect().width > 0, alerta: a && a.textContent, alertaVe: !!a && !a.hidden && a.getBoundingClientRect().height > 0, outros: document.querySelectorAll('#camada-assistente .as-selo').length }; })()`);
  conferir(selo.selo === 'Recomendado' && selo.seloVe && selo.outros === 1, 'hooks com o selo "Recomendado" (só eles)', selo);
  conferir(selo.alertaVe && /não aparecem no Orbit/.test(selo.alerta || ''), 'hooks desmarcados: aviso de que as sessões não aparecem', selo);
  conferir(await espera(`(() => { const t = document.querySelector('#camada-assistente .as-status')?.textContent || ''; return t && t !== 'Conferindo…' ? t : ''; })()`, 20000), 'status da conta do Claude aparece');
  const cl = await (await fetch(BASE + '/conta/claude')).json();
  if (cl.logado === null) conferir(await av(`document.getElementById('as-claude-entrar').hidden`), 'sem o Claude Code: sem botão "Entrar"');
  const cab = await av(`(() => { const m = document.querySelector('.as-modal').getBoundingClientRect(); const c = document.querySelector('.as-modal .modal-corpo'); return { w: m.width, h: m.height, rola: c.scrollHeight > c.clientHeight, rodape: document.querySelector('.as-rodape').getBoundingClientRect().bottom <= innerHeight }; })()`);
  conferir(cab.w > 500 && cab.rodape, 'cabe na tela (rodapé visível; o corpo rola)', cab);
  await foto('1-primeira-vez');

  // 2. Marca hooks + aviso + skill, nome e pasta; conclui.
  await av(`(() => {
    const n = document.getElementById('as-nome'); n.value = 'Bia'; n.dispatchEvent(new Event('input', { bubbles: true }));
    const p = document.getElementById('as-pasta'); p.value = ${JSON.stringify(PROJETOS)};
    document.getElementById('as-hooks').click(); })()`);
  conferir(await av(`!document.getElementById('as-aviso').disabled && !document.getElementById('as-subir').disabled`), 'marcar os hooks libera as sub-opções');
  conferir(await av(`document.getElementById('as-hooks-alerta').hidden`), 'marcar os hooks esconde o aviso');
  await av(`document.getElementById('as-aviso').click(), document.getElementById('as-liderar').click(), true`);
  await av(`document.getElementById('as-concluir').click(), true`);
  const res = await espera(`(() => { const r = document.querySelector('.as-resultado'); return r && !r.hidden ? r.textContent : ''; })()`, 40000);
  conferir(/Pronto\. Tudo aplicado\./.test(res || ''), 'concluir aplica tudo', res);
  conferir(await av(`!document.getElementById('as-fechar').hidden && document.getElementById('as-concluir').hidden`), 'depois de concluir, só "Fechar"');
  const s1 = settings();
  conferir(s1.n === 12 && s1.aviso === 1 && s1.subir === 0, 'settings de teste: hooks e aviso, sem abrir sozinho', s1);
  conferir(fs.existsSync(path.join(SKILLS, 'liderar-time', 'SKILL.md')), 'skill instalada na pasta de teste');
  conferir(fs.existsSync(PROJETOS), 'pasta de projetos criada');
  conferir(await espera(`document.querySelector('.perfil-nome')?.textContent === 'Bia'`, 5000), 'o perfil da lateral mostra o nome novo', await av(`document.querySelector('.perfil-nome')?.textContent`));
  await foto('2-concluido');
  await av(`document.getElementById('as-fechar').click(), true`);
  conferir(await espera(`document.getElementById('camada-assistente').hidden`), 'Fechar esconde');

  // 3. Recarregar: não abre de novo. Refazer pelas Configurações abre com o que está valendo.
  await cdp('Page.reload');
  await dormir(2500);
  conferir(await av(`!document.getElementById('camada-assistente') || document.getElementById('camada-assistente').hidden`), 'feito: não abre mais sozinho');
  await av(`document.getElementById('cfg-assistente').click(), true`);
  conferir(await espera(visivel), '"Refazer" nas Configurações abre');
  const de = await espera(`(() => { const n = document.getElementById('as-nome').value; return n ? { nome: n, hooks: document.getElementById('as-hooks').checked, aviso: document.getElementById('as-aviso').checked, subir: document.getElementById('as-subir').checked, liderar: document.getElementById('as-liderar').checked } : null; })()`);
  conferir(de && de.nome === 'Bia' && de.hooks && de.aviso && !de.subir && de.liderar, 'reabre com as escolhas atuais', de);

  // 4. Desmarca tudo e conclui: tira os hooks e a skill.
  await av(`['as-hooks','as-liderar'].forEach((i) => document.getElementById(i).click()), true`);
  await av(`document.getElementById('as-concluir').click(), true`);
  const res2 = await espera(`(() => { const r = document.querySelector('.as-resultado'); return r && !r.hidden && /Pronto/.test(r.textContent) ? r.textContent : ''; })()`, 40000);
  conferir(!!res2, 'concluir sem nada marcado', res2);
  const s2 = settings();
  conferir(s2.n === 0 && s2.aviso === 0 && !fs.existsSync(path.join(SKILLS, 'liderar-time')), 'tira hooks, aviso e skill do Orbit', s2);

  // 5. Tela estreita: o modal não vaza.
  await av(`document.getElementById('as-fechar').click(), true`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 760, deviceScaleFactor: 1, mobile: false });
  await av(`window.OrbitAssistente.abrir(), true`);
  await espera(visivel);
  await dormir(300);
  const est2 = await av(`(() => { const m = document.querySelector('.as-modal').getBoundingClientRect(); return { esq: m.left, dir: m.right, larg: innerWidth, rodape: document.querySelector('.as-rodape').getBoundingClientRect().bottom <= innerHeight }; })()`);
  conferir(est2.esq >= 0 && est2.dir <= est2.larg && est2.rodape, 'em 420 px o modal cabe', est2);
  await foto('3-estreita');
  await av(`document.getElementById('as-pular').click(), true`);
  conferir(await espera(`document.getElementById('camada-assistente').hidden`), '"Pular por agora" fecha');

  conferir(erros.length === 0, 'sem erros no console', erros);
  ws.close();
} catch (e) {
  falhas++;
  console.log('FALHA', 'execução', e?.stack || e);
} finally {
  await fecharEdge(pcdp, perfil);
  const saiu = new Promise((r) => servidor.once('exit', r));
  await desligarSeMeu(PORTA, servidor.pid);
  await Promise.race([saiu, dormir(3000)]);
  if (servidor.exitCode == null) { try { servidor.kill(); } catch {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
console.log(`\n${ok} ok, ${falhas} falha(s). Capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
