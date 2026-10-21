// Teste de fumaça do gerenciador — cabe em ~2 min de execução.
// node testes/fumaca.mjs [pasta-de-saida]
// 1) suíte do backend; 2) página no mock (47823) em 3 larguras, console, rolagem
// horizontal, atalhos, notificações e som com a página fora de foco. Só usa o servidor que ele mesmo sobe.
// Imprime um resumo JSON no fim; as capturas ficam na pasta de saída.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'gerenciador-fumaca'));
fs.mkdirSync(SAIDA, { recursive: true });
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const resumo = { backend: null, larguras: {}, atalhos: null, avisos: null, erros: [] };

// 1) Backend (numa porta livre conferida: nunca no servidor de teste de outro agente)
{
  const p = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
  const r = spawnSync(process.execPath, [path.join(PASTA, 'testes', 'backend.test.mjs')], {
    cwd: PASTA, encoding: 'utf8', timeout: 90e3,
    env: { ...process.env, GERENCIADOR_PORTA: String(p), GERENCIADOR_DADOS: path.join(SAIDA, 'dados-backend') },
  });
  const linha = (k) => Number((r.stdout.match(new RegExp(`ℹ ${k} (\\d+)`)) || [])[1]);
  resumo.backend = { pass: linha('pass'), fail: linha('fail'), saida: r.status };
  if (resumo.backend.fail) resumo.erros.push('backend: ' + (r.stdout.match(/not ok.*$/gm) || []).join(' | '));
}

// 2) Página no mock (porta livre conferida; no fim, só o próprio filho é encerrado)
const MOCKP = await escolherPorta(Number(process.env.FUMACA_PORTA) || 47824);
const mock = spawn(process.execPath, [path.join(PASTA, 'testes', 'mock-servidor.mjs')], {
  cwd: PASTA, stdio: 'ignore', env: { ...process.env, MOCK_PORTA: MOCKP, ROTEIRO_MS: '1500' },
});
const porta = 9800 + Math.floor(Math.random() * 150);
const perfil = path.join(SAIDA, 'edge-' + porta);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`,
  // --mute-audio: o AudioContext roda e os sons são contados, mas nada sai na caixa do usuário.
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0;
const pend = new Map();
const consoleErros = [];
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
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
}
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const tecla = async (key) => {
  const codigos = { Escape: 27, Enter: 13, ' ': 32, ArrowDown: 40, ArrowUp: 38 };
  const base = { key, code: key === ' ' ? 'Space' : key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: codigos[key] || key.toUpperCase().charCodeAt(0) };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : undefined });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await dormir(150);
};
const foto = async (nome) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const arq = path.join(SAIDA, nome + '.png');
  fs.writeFileSync(arq, Buffer.from(r.result.data, 'base64'));
  return arq;
};

// Stubs: registra notificações e sons; finge que a página está fora de foco.
const STUBS = `
  window.__notifs = []; window.__sons = 0; window.__aberturas = []; window.__permitirSom = true;
  class N { constructor(t, o) { window.__notifs.push({ t, b: o && o.body }); } close() {} }
  N.permission = 'granted'; N.requestPermission = async () => 'granted';
  window.Notification = N;
  const AC = window.AudioContext;
  if (AC) { const o = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__sons++; return o.call(this); }; }
  Document.prototype.hasFocus = () => false;
  window.open = (u) => { window.__aberturas.push(String(u)); return null; };
  // vscode:// costuma sair por <a>.click() ou location.assign — registra em vez de navegar.
  HTMLAnchorElement.prototype.click = function () { window.__aberturas.push(this.href); };
  document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="vscode:"]'); if (a) { e.preventDefault(); window.__aberturas.push(a.href); } }, true);
  try { const ass = Location.prototype.assign; Location.prototype.assign = function (u) { if (String(u).startsWith('vscode:')) window.__aberturas.push(String(u)); else ass.call(this, u); }; } catch {}
`;

try {
  await conectar();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: STUBS });

  for (const [w, h] of [[1440, 900], [1024, 700], [420, 800]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${MOCKP}/` });
    await dormir(2500);
    const medida = await avaliar(`({ sw: document.documentElement.scrollWidth, iw: innerWidth, titulo: document.title, linhas: document.body.innerText.split('\\n').length })`);
    resumo.larguras[w] = { ...medida, rolagemHorizontal: medida.sw > medida.iw, captura: await foto(`lista-${w}`) };
    await tecla('j'); await tecla(' '); await dormir(800);
    resumo.larguras[w].capturaDetalhe = await foto(`detalhe-${w}`);
    await tecla('Escape');
  }

  // Atalhos (1440): navegação, ajuda, histórico, configurações, abrir no VS Code.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${MOCKP}/` });
  await dormir(2000);
  const antes = consoleErros.length;
  for (const k of ['j', 'j', 'k', ' ', 'Escape', '?']) await tecla(k);
  const ajuda = await foto('ajuda');
  await tecla('Escape');
  await tecla('a'); const historico = await foto('historico'); await tecla('Escape');
  await tecla(','); const config = await foto('config'); await tecla('Escape');
  // Etapa 5: Enter e `o` abrem a Conversa do Orbit; nenhum vscode:// sem pedido explícito.
  const conversaAberta = "!document.getElementById('pk-conversa').hidden && !!window.Conversa && !!document.querySelector('#pk-conversa .cv-lista')";
  await avaliar('window.__aberturas = []; true');
  await tecla('j'); await tecla('Enter'); await dormir(1500);
  const enterAbreConversa = !!(await avaliar(conversaAberta));
  await avaliar('document.activeElement && document.activeElement.blur(); true');
  await tecla('Escape'); await dormir(500);
  await tecla('o'); await dormir(1500);
  const oAbreConversa = !!(await avaliar(conversaAberta));
  const vscodeSemPedido = ((await avaliar('window.__aberturas')) || []).filter((u) => String(u).startsWith('vscode:'));
  if (!enterAbreConversa || !oAbreConversa) resumo.erros.push('atalhos: ' + (!enterAbreConversa ? 'Enter' : '') + (!enterAbreConversa && !oAbreConversa ? ' e ' : '') + (!oAbreConversa ? 'o' : '') + ' não abriu a Conversa');
  if (vscodeSemPedido.length) resumo.erros.push('atalhos: vscode:// sem pedido explícito: ' + vscodeSemPedido.join(' '));
  await avaliar('document.activeElement && document.activeElement.blur(); true');
  await tecla('Escape');
  resumo.atalhos = {
    errosDuranteAtalhos: consoleErros.length - antes,
    enterAbreConversa, oAbreConversa, vscodeSemPedido,
    capturas: { ajuda, historico, config },
  };

  // Avisos: o roteiro do mock emite alertas a cada 1,5 s; a página está "fora de foco".
  await dormir(20000);
  resumo.avisos = { notificacoes: await avaliar('window.__notifs'), sons: await avaliar('window.__sons'), captura: await foto('apos-avisos') };
} catch (e) {
  resumo.erros.push('fumaça: ' + (e?.stack || e));
} finally {
  resumo.consoleErros = consoleErros;
  mock.kill(); // nada de /desligar pela porta: ela pode ter mudado de dono
  // Fecha o navegador inteiro: o msedge.exe que abrimos repassa para outro processo, e nem
  // kill() nem taskkill no pid dele alcançam a árvore (em 15/10 os órfãos encheram o C:).
  try { ws?.close(); } catch {}
  // Reserva: qualquer navegador que ainda use este perfil; depois o perfil sai (as capturas ficam).
  await fecharEdge(porta, perfil);
  console.log(JSON.stringify(resumo, null, 2));
  process.exit(0);
}
