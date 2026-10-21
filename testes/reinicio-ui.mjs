// Reinício pelas Configurações, na página de verdade: servidor de teste (47822–47826) + Edge headless mudo.
// Rodar:  node testes/reinicio-ui.mjs [pasta-das-capturas]
// Confere: confirmação na linha (Cancelar volta), andamento até "Online de novo", outro pid no /saude, o /fluxo
// reconectado sem recarregar a página (um evento do servidor novo aparece na lista) e a mensagem de falha
// com o motivo (409 simulado no fetch da página). Fecha o Edge, desliga só o servidor do teste e apaga os dados.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.join(os.tmpdir(), 'gerenciador-testes', `reinicio-ui-${Date.now()}`);
const DADOS = path.join(BASE, 'dados');
const PERFIL = path.join(BASE, 'edge');
const SAIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
for (const d of [DADOS, path.join(DADOS, 'sessoes'), path.join(DADOS, 'projetos'), PERFIL]) fs.mkdirSync(d, { recursive: true });
if (SAIDA) fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTA = await escolherPorta(47824);
const URL_BASE = `http://127.0.0.1:${PORTA}`;
const saude = async () => { try { return await (await fetch(URL_BASE + '/saude')).json(); } catch { return null; } };

const env = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'),
  FALSO_LOG: path.join(DADOS, 'falso.log'),
};
delete env.GERENCIADOR_REINICIOS;

let pcdp = 0;
let ok = 0, falhas = 0;
const conferir = (cond, rotulo) => { if (cond) ok++; else falhas++; console.log(`${cond ? 'ok   ' : 'FALHA'} ${rotulo}`); };

try {
  const srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], { env, stdio: 'ignore' });
  let s0 = null;
  for (let i = 0; i < 60 && !(s0 && s0.pid === srv.pid); i++) { await dormir(150); s0 = await saude(); }
  if (!s0 || s0.pid !== srv.pid) throw new Error('o servidor do teste não subiu');

  const EDGE = (await import('./edge.mjs')).caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pend = new Map();
  const erros = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Runtime.exceptionThrown') erros.push(j.params.exceptionDetails?.exception?.description || 'exceção');
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const foto = async (nome) => {
    if (!SAIDA) return;
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: URL_BASE + '/' });
  // Conectada: a sessão de um evento aparece na lista.
  const verNaLista = async (texto) => {
    for (let i = 0; i < 40; i++) { if (await av(`document.body.innerText.includes(${JSON.stringify(texto)})`)) return true; await dormir(200); }
    return false;
  };
  const evento = (id, prompt) => fetch(URL_BASE + '/evento', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt, cwd: DADOS }) });
  await dormir(1000);
  await evento('antes-do-reinicio', 'Sessão vista antes do reinício');
  conferir(await verNaLista('Sessão vista antes do reinício'), 'página conectada ao /fluxo (evento ao vivo)');
  await av(`location.hash = 'marca-sem-recarregar'; window.__semRecarregar = 1`);

  await av(`document.getElementById('nav-config').click()`);
  await dormir(500);
  await av(`(() => { const c = document.querySelector('#camada-config .modal-corpo'); c.scrollTop = c.scrollHeight; })()`);
  await dormir(200);
  const txtEstado = () => av(`document.getElementById('cfg-rein-estado').textContent`);
  const txtBotao = () => av(`document.getElementById('cfg-rein').textContent`);
  conferir((await txtBotao()) === 'Reiniciar' && /seguem rodando/.test(await txtEstado()), 'linha "Reiniciar o servidor" no fim das Configurações');
  await foto('1-parado');

  // Confirmação simples na própria linha; Cancelar volta.
  await av(`document.getElementById('cfg-rein').click()`);
  conferir((await txtBotao()) === 'Reiniciar agora' && /Reiniciar agora\?/.test(await txtEstado()) && (await av(`!document.getElementById('cfg-rein-nao').hidden`)), 'confirmação pedida');
  await foto('2-confirmar');
  await av(`document.getElementById('cfg-rein-nao').click()`);
  conferir((await txtBotao()) === 'Reiniciar' && (await saude())?.pid === srv.pid, 'Cancelar não reinicia');

  // Reinício de verdade.
  await av(`document.getElementById('cfg-rein').click()`);
  await av(`document.getElementById('cfg-rein').click()`);
  const vistos = new Set();
  let fotoAndamento = false;
  for (let i = 0; i < 200; i++) {
    const t = await txtEstado();
    vistos.add(t);
    if (!fotoAndamento && /esperando o servidor voltar/.test(t)) { await foto('3-reiniciando'); fotoAndamento = true; }
    if (/Online de novo/.test(t) && !(await av(`document.getElementById('cfg-rein').disabled`))) break;
    await dormir(100);
  }
  console.log('      andamento visto:', [...vistos].join(' → '));
  conferir([...vistos].some((t) => /Reiniciando/.test(t)), 'andamento "Reiniciando" mostrado');
  conferir([...vistos].some((t) => /Online de novo às \d{2}:\d{2}:\d{2} \(\d+,\d s\)/.test(t)), '"Online de novo" com o horário');
  const s1 = await saude();
  conferir(s1 && s1.pid && s1.pid !== srv.pid, `servidor novo no ar (pid ${s1?.pid}, antes ${srv.pid})`);
  await dormir(800);
  conferir((await av(`window.__semRecarregar === 1 && location.hash === '#marca-sem-recarregar'`)) === true, 'a página não recarregou');
  conferir(await av(`document.getElementById('aviso-conexao').hidden`), 'sem o aviso "Sem conexão com o servidor"');
  // Um evento chega pelo servidor novo e aparece na lista, sem F5.
  await evento('depois-do-reinicio', 'Sessão vista depois do reinício');
  conferir(await verNaLista('Sessão vista depois do reinício'), '/fluxo reconectado: evento do servidor novo aparece ao vivo');
  await foto('4-online');
  const cofre = fs.readFileSync(path.join(DADOS, 'notas', 'Reinícios do servidor.md'), 'utf8');
  conferir(/· pelo usuário \(Configurações\) · online de novo às/.test(cofre), 'linha no cofre (do teste)');
  conferir(/desligando POST \/reiniciar \(usuário · Configurações · Mozilla/.test(fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8')), 'log identifica "usuário" e o navegador');

  // Falha: um 409 com motivo (simulado no fetch da página) vira mensagem clara.
  await av(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u) === '/reiniciar' ? Promise.resolve(new Response(JSON.stringify({ erro: '1 instância do Orbit roda fora do motor e seria encerrada. Feche ela antes de reiniciar.' }), { status: 409, headers: { 'content-type': 'application/json' } })) : f(u, o); })()`);
  await av(`document.getElementById('cfg-rein').click()`);
  await av(`document.getElementById('cfg-rein').click()`);
  await dormir(400);
  const tf = await txtEstado();
  conferir(/^Não reiniciou: 1 instância do Orbit roda fora do motor/.test(tf) && (await txtBotao()) === 'Tentar de novo' && (await av(`document.getElementById('cfg-rein-estado').classList.contains('ruim')`)), 'falha com o motivo: ' + tf);
  await foto('5-falhou');
  conferir((await saude())?.pid === s1.pid, 'na falha, o servidor seguiu o mesmo');
  conferir(erros.length === 0, 'sem exceção na página' + (erros.length ? ': ' + erros.join(' | ') : ''));

  const fim = await saude();
  if (fim?.pid) await desligarSeMeu(PORTA, fim.pid); // o servidor que o reinício deste teste subiu
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e.message);
} finally {
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  await dormir(500);
  const m = (() => { try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch { return null; } })();
  if (m?.pid) try { process.kill(m.pid); } catch {}
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
