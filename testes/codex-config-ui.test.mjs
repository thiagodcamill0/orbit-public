// Teste da seção Configurações → Codex (assets/codex-config.js; contrato da Etapa 0 no contrato, seção Codex).
// Mock (testes/mock-servidor.mjs, ROTEIRO=0) numa porta livre de 47822–47826 + Edge headless mudo; nunca toca a 47821.
//   node testes/codex-config-ui.test.mjs <pasta-de-saida>   (~15 s; uma captura da seção; sem argumento, tudo é apagado no fim)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PEDIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
const SAIDA = PEDIDA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-cfg-'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const PERFIL = path.join(SAIDA, 'edge-codex-cfg');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const AUTO = 'C:\\Users\\teste\\AppData\\Local\\OpenAI\\Codex\\bin\\abc123\\codex.exe';
const MANUAL = 'D:\\Ferramentas\\Codex\\codex.exe';

let mock, pcdp, ws;
try {
  mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

  // Chave desligada: o servidor responde 404 em /codex/estado e a config não tem o campo.
  conferir((await fetch(BASE + '/codex/estado')).status === 404, 'mock: GET /codex/estado é 404 com a chave desligada');
  conferir(!('codex' in (await (await fetch(BASE + '/config')).json())), 'mock: GET /config sem o campo codex enquanto ninguém liga');

  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const esperar = async (expr, ms = 6000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await av(expr); if (v) return v; await dormir(100); } return v; };
  const tecla = (key, code, vk) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : undefined })
    .then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }));

  // Registra os POST /config e os GET /codex/* feitos pela página.
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__log = []; const f = window.fetch; window.fetch = function (u, o) { try { const s = String(u); if (/\\/codex\\//.test(s) || (o && o.method === 'POST' && /\\/config$/.test(s))) window.__log.push({ u: s, m: (o && o.method) || 'GET', b: o && o.body ? String(o.body) : '' }); } catch {} return f.apply(this, arguments); };` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`!!document.getElementById('nav-config')`, 15000); await dormir(800);

  const posts = () => av(`window.__log.filter((x) => x.m === 'POST').map((x) => JSON.parse(x.b))`);
  const gets = () => av(`window.__log.filter((x) => x.m === 'GET').map((x) => x.u)`);
  const S = `#cfg-codex-caixa`;
  const visivel = (sel) => av(`(() => { const e = document.querySelector('${sel}'); return !!e && !e.hidden && e.getClientRects().length > 0; })()`);
  const estadoTxt = () => av(`document.querySelector('#cfg-codex-estado')?.textContent || ''`);

  // ── antes de abrir as Configurações: nada do Codex no DOM além da casca da seção (que fica dentro das Configurações) ──
  conferir(await av(`!window.CodexConfig && !document.getElementById('cfg-codex')`), 'antes de abrir as Configurações: módulo do Codex não carregado e sem a chave no DOM');

  await av(`document.getElementById('nav-config').click()`);
  conferir(await esperar(`!!document.getElementById('cfg-codex') && !!document.getElementById('cfg-codex-exe')`), 'ao abrir as Configurações a seção Codex aparece');
  conferir(await av(`document.getElementById('t-cfg-codex')?.textContent === 'Codex'`), 'título da seção: Codex');
  conferir(await av(`document.querySelector('label[for="cfg-codex"]')?.textContent.startsWith('Ligar o Codex')`), 'rótulo "Ligar o Codex"');
  conferir(await av(`document.getElementById('cfg-codex').classList.contains('chave') && document.getElementById('cfg-codex').type === 'checkbox'`), 'a chave cfg-codex tem a classe chave');
  conferir(await av(`document.getElementById('cfg-codex').checked === false`), 'a chave começa desligada');

  // ── desligada: campo e status ocultos; nada novo fora da seção; nenhuma chamada ao Codex ──
  conferir(!(await visivel('#cfg-codex-exe')) && !(await visivel('#cfg-codex-estado')), 'desligada: campo e status ocultos');
  conferir(await av(`[...document.querySelectorAll('[id*="codex"], [class*="cdx"], [href*="codex"], [src*="codex"]')].every((e) => e.closest('section[aria-labelledby="t-cfg-codex"]') || e.tagName === 'LINK' || e.tagName === 'SCRIPT')`), 'desligada: nenhum elemento do Codex fora da seção (além do script/CSS dela)');
  conferir(await av(`!document.querySelector('[data-provedor], .selo-codex, [class*="codex"]:not(#cfg-codex-caixa *)')`), 'desligada: sem selo/elemento do Codex nas listas');
  conferir((await gets()).length === 0, 'desligada: nenhum GET /codex/*', await gets());
  conferir((await posts()).length === 0, 'abrir as Configurações não grava nada', await posts());

  // ── ligar ──
  await av(`document.getElementById('cfg-codex').click()`);
  conferir(await esperar(`document.getElementById('cfg-codex').checked`), 'a chave liga');
  conferir(await esperar(`(() => { const e = document.getElementById('cfg-codex-exe-linha'); return !!e && !e.hidden; })()`), 'ligada: campo do caminho aparece');
  const p1 = await esperar(`window.__log.some((x) => x.m === 'POST' && JSON.parse(x.b).codex)`) && (await posts()).find((x) => x.codex);
  conferir(p1 && p1.codex.ativo === true && p1.codex.exe === '', 'ligar: POST /config com codex.ativo:true e exe vazio', p1);
  conferir(!!(await esperar(`document.querySelector('#cfg-codex-estado')?.textContent.includes('codex.exe')`)), 'ligada: status mostra o exe detectado', await estadoTxt());
  conferir((await estadoTxt()).includes(AUTO) && /autom/.test(await estadoTxt()), 'status: exe e origem automática', await estadoTxt());
  conferir(await visivel('#cfg-codex-estado') && await visivel('#cfg-codex-exe'), 'ligada: campo e status visíveis');
  conferir((await gets()).some((u) => u.endsWith('/codex/estado')), 'ligada: GET /codex/estado feito');
  conferir((await (await fetch(BASE + '/config')).json()).codex?.ativo === true, 'mock guardou codex.ativo:true');
  conferir((await (await fetch(BASE + '/codex/estado')).json()).exe.exe === AUTO, 'mock: /codex/estado responde com a chave ligada');

  // ── caminho manual salvo com Enter ──
  await av(`document.getElementById('cfg-codex-exe').focus()`);
  await cdp('Input.insertText', { text: '  ' + MANUAL + '  ' });
  await tecla('Enter', 'Enter', 13);
  const p2 = await esperar(`window.__log.some((x) => x.m === 'POST' && JSON.parse(x.b).codex?.exe)`) && (await posts()).find((x) => x.codex?.exe);
  conferir(p2 && p2.codex.exe === MANUAL && p2.codex.ativo === true, 'caminho manual: POST /config com o caminho sem espaços', p2);
  conferir(!!(await esperar(`document.querySelector('#cfg-codex-estado')?.textContent.includes('manual')`)), 'status: origem manual', await estadoTxt());
  conferir((await estadoTxt()).includes(MANUAL), 'status: mostra o caminho manual', await estadoTxt());
  conferir((await (await fetch(BASE + '/config')).json()).codex?.exe === MANUAL, 'mock guardou o caminho manual');
  const nPosts = (await posts()).length;
  await av(`document.getElementById('cfg-codex-exe').blur()`);
  await dormir(300);
  conferir((await posts()).length === nPosts, 'sair do campo sem mudar o valor não grava de novo');

  // ── caminho que não existe: motivo + sugestão do automático ──
  await av(`(() => { const c = document.getElementById('cfg-codex-exe'); c.focus(); c.select(); })()`);
  await cdp('Input.insertText', { text: 'D:\\inexistente\\codex.exe' });
  await av(`document.getElementById('cfg-codex-exe').blur()`); // sair do campo também salva
  conferir(!!(await esperar(`/não encontrado/.test(document.querySelector('#cfg-codex-estado')?.textContent || '')`)), 'caminho inexistente: status mostra o motivo', await estadoTxt());
  conferir((await estadoTxt()).includes(AUTO), 'caminho inexistente: sugere o automático', await estadoTxt());
  conferir(await visivel('#cfg-codex-auto'), 'caminho inexistente: botão "Usar o automático"');
  conferir(await av(`document.querySelector('#cfg-codex-estado').classList.contains('ruim')`), 'caminho inexistente: status em tom de erro');
  await av(`document.getElementById('cfg-codex-auto').click()`);
  conferir(!!(await esperar(`/autom/.test(document.querySelector('#cfg-codex-estado')?.textContent || '') && document.getElementById('cfg-codex-exe').value === ''`)), 'Usar o automático: campo limpo e status automático', await estadoTxt());

  // captura pequena só da seção (ligada, com o caminho manual de volta)
  await av(`(() => { const c = document.getElementById('cfg-codex-exe'); c.focus(); })()`);
  await cdp('Input.insertText', { text: MANUAL });
  await tecla('Enter', 'Enter', 13);
  await esperar(`document.querySelector('#cfg-codex-estado')?.textContent.includes('manual')`);
  await av(`document.getElementById('cfg-codex-exe').blur(); document.querySelector('section[aria-labelledby="t-cfg-codex"]').scrollIntoView({ block: 'center' })`);
  await dormir(300);
  const r = await av(`(() => { const b = document.querySelector('section[aria-labelledby="t-cfg-codex"]').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
  fs.writeFileSync(path.join(SAIDA, 'codex-config.png'), Buffer.from(shot.result.data, 'base64'));

  // ── desligar: campo e status somem; o caminho continua guardado ──
  await av(`document.getElementById('cfg-codex').click()`);
  conferir(await esperar(`document.getElementById('cfg-codex-exe-linha').hidden && document.getElementById('cfg-codex-estado-linha').hidden`), 'desligar: campo e status ocultos');
  const p3 = (await posts()).filter((x) => x.codex).pop();
  conferir(p3 && p3.codex.ativo === false, 'desligar: POST /config com codex.ativo:false', p3);
  conferir((await fetch(BASE + '/codex/estado')).status === 404, 'mock: /codex/estado volta a 404 com a chave desligada');
  const nGets = (await gets()).length;
  await dormir(400);
  conferir((await gets()).length === nGets, 'desligada: nenhuma chamada nova ao Codex');

  // ── reabrir com a chave ligada pelo servidor: lê o estado de novo ──
  await av(`document.getElementById('cfg-codex').click()`);
  conferir(!!(await esperar(`document.querySelector('#cfg-codex-estado')?.textContent.includes('manual')`)), 'religar: status volta com o caminho manual guardado', await estadoTxt());

  conferir(!consoleErros.some((e) => !/favicon|\/modelos|Failed to load resource.*(404|503)/.test(e)), 'sem erros no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
} finally {
  try { ws?.close(); } catch {}
  try { mock?.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  if (!PEDIDA) fs.rmSync(SAIDA, { recursive: true, force: true });
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
