// Teste do Orbit instalável (PWA). Servidor próprio numa porta livre de 47822–47826 (preferida
// GERENCIADOR_PORTA ou 47825; nunca a 47821), com dados numa pasta temporária, e Edge headless mudo.
//   node testes/pwa.test.mjs [pasta-de-saida]            teste completo
//   node testes/pwa.test.mjs [pasta-de-saida] --medir    só mede a lateral e o cabeçalho (comparar
//                                                         o visual antes e depois de uma mudança)
// Confere: manifesto sem erros e instalável, ícones 200, service worker controlando a página,
// opção "Instalar Orbit" (com um beforeinstallprompt simulado), selo no ícone (setAppBadge com a
// contagem de "Precisa de você") e a tela "Orbit offline" com o servidor derrubado, que volta
// sozinha quando ele sobe. Imprime um resumo JSON; as capturas ficam na pasta de saída.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const SO_MEDIR = args.includes('--medir');
const SAIDA = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), 'orbit-pwa'));
fs.mkdirSync(SAIDA, { recursive: true });
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = fs.mkdtempSync(path.join(SAIDA, 'dados-'));
const SESSOES = fs.mkdtempSync(path.join(SAIDA, 'sessoes-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const resumo = { manifesto: null, instalavel: null, icones: null, sw: null, instalar: null, selo: null, offline: null, consoleErros: [], erros: [] };
const falhar = (msg) => resumo.erros.push(msg);

// ---------- servidor de teste ----------
// Só derruba o processo que ele mesmo subiu (o filho), nunca o servidor de outro teste.
let srv = null;
async function subir() {
  srv = spawn(process.execPath, [path.join(PASTA, 'servidor.mjs')], {
    cwd: PASTA, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESSOES },
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/saude')).ok) return; } catch {}
    await dormir(200);
  }
  throw new Error('o servidor de teste não subiu');
}
async function derrubar() {
  if (!srv) return;
  const p = srv; srv = null;
  p.kill();
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/saude'); } catch { return; }
    await dormir(100);
  }
}
const evento = (ev) => fetch(BASE + '/evento', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(ev) });

// ---------- Edge headless + CDP ----------
const porta = 9800 + Math.floor(Math.random() * 150);
const perfil = path.join(SAIDA, 'edge-' + porta);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
let ws, seq = 0;
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
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') resumo.consoleErros.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') resumo.consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
}
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const foto = async (nome) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const arq = path.join(SAIDA, nome + '.png');
  fs.writeFileSync(arq, Buffer.from(r.result.data, 'base64'));
  return arq;
};
const largura = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
async function abrir() {
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2500);
}
async function esperar(expr, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { if (await avaliar(expr)) return true; } catch {}
    await dormir(250);
  }
  return false;
}

// O selo e a instalação são registrados em vez de irem ao sistema; o som fica mudo.
const STUBS = `
  window.__selos = [];
  navigator.setAppBadge = (n) => { window.__selos.push(n == null ? 'ponto' : n); return Promise.resolve(); };
  navigator.clearAppBadge = () => { window.__selos.push(0); return Promise.resolve(); };
`;

// Caixas da lateral e do cabeçalho (o que a mudança não pode deslocar).
const MEDIDA = `(() => {
  const sel = '.lateral .marca, .lateral .busca, .lateral .rot-sec, .lateral .nav-item, .lateral .so-estreito > *, .lateral #projetos, .lateral .recolher, .cab-pagina, .cab-acoes > *';
  return [...document.querySelectorAll(sel)].map((e) => {
    const r = e.getBoundingClientRect();
    return [e.id || e.className || e.tagName, e.textContent.trim().slice(0, 24), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  }).filter((x) => x[4] || x[5]);
})()`;

try {
  await subir();
  await conectar();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: STUBS });

  if (SO_MEDIR) {
    const medidas = {};
    for (const [w, h] of [[1440, 900], [1024, 700]]) {
      await largura(w, h);
      await abrir();
      medidas[w] = await avaliar(MEDIDA);
      await foto('medida-' + w);
    }
    fs.writeFileSync(path.join(SAIDA, 'medidas.json'), JSON.stringify(medidas, null, 1));
    console.log('medidas em', path.join(SAIDA, 'medidas.json'));
  } else {
    await largura(1440, 900);
    await abrir();

    // Manifesto e instalabilidade, pelos olhos do navegador.
    const man = (await cdp('Page.getAppManifest')).result || {};
    const parsed = (() => { try { return JSON.parse(man.data || '{}'); } catch { return {}; } })();
    resumo.manifesto = { url: man.url, erros: man.errors || [], nome: parsed.name, display: parsed.display, theme: parsed.theme_color, icones: (parsed.icons || []).length };
    if (!man.url || (man.errors || []).length) falhar('manifesto com erro: ' + JSON.stringify(man.errors || 'sem manifesto'));
    const inst = (await cdp('Page.getInstallabilityErrors')).result;
    resumo.instalavel = inst ? (inst.installabilityErrors || []).map((e) => e.errorId) : 'sem resposta';
    if (Array.isArray(resumo.instalavel) && resumo.instalavel.length) falhar('não instalável: ' + resumo.instalavel.join(', '));

    // Ícones: todos respondem 200 com PNG do tamanho declarado no nome.
    const icones = [];
    for (const i of parsed.icons || []) {
      const r = await fetch(new URL(i.src, BASE));
      icones.push([i.src, r.status, r.headers.get('content-type')]);
      if (r.status !== 200) falhar('ícone ' + i.src + ' ' + r.status);
    }
    resumo.icones = icones.length + ' ok de ' + (parsed.icons || []).length;

    // Service worker: registrado e controlando a página depois de um recarregamento.
    await esperar(`navigator.serviceWorker.ready.then(() => true)`);
    await abrir();
    resumo.sw = await avaliar(`navigator.serviceWorker.getRegistration().then((r) => ({ escopo: r && r.scope, ativo: !!(r && r.active), controla: !!navigator.serviceWorker.controller }))`);
    if (!resumo.sw || !resumo.sw.controla) falhar('service worker não controla a página');

    // "Instalar Orbit": aparece com o convite (beforeinstallprompt); o clique chama prompt() e some.
    // O Edge headless costuma mandar o convite de verdade logo no carregamento (sinal de que o
    // Orbit é instalável); por isso "antes" só é registrado, sem exigir que esteja escondido.
    const visivel = (id) => `(() => { const e = document.getElementById('${id}'); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    const antes = await avaliar(visivel('nav-instalar'));
    await avaliar(`(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); window.__prompts = 0; e.prompt = async () => { window.__prompts++; }; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); dispatchEvent(e); return true; })()`);
    await dormir(200);
    const com = await avaliar(visivel('nav-instalar'));
    await foto('instalar-1440');
    await largura(1024, 700); await dormir(300);
    const estreito = await avaliar(visivel('instalar-e'));
    await foto('instalar-1024');
    await largura(1440, 900); await dormir(300);
    await avaliar(`document.getElementById('nav-instalar').click()`);
    await dormir(300);
    const depois = await avaliar(visivel('nav-instalar'));
    const prompts = await avaliar('window.__prompts');
    resumo.instalar = { conviteReal: antes, comEvento: com, estreito, depoisDoClique: depois, prompts };
    if (!com || !estreito || depois || prompts !== 1) falhar('opção Instalar Orbit: ' + JSON.stringify(resumo.instalar));

    // Selo: uma sessão pede aprovação (1) e depois conclui (0).
    await avaliar('window.__selos.length = 0');
    const sid = 'pwa-teste-1';
    await evento({ session_id: sid, hook_event_name: 'SessionStart', cwd: 'C:\\pwa\\Projeto', source: 'startup' });
    await evento({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: 'C:\\pwa\\Projeto', prompt: 'teste do selo' });
    await evento({ session_id: sid, hook_event_name: 'PermissionRequest', cwd: 'C:\\pwa\\Projeto', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const viu1 = await esperar(`window.__selos.at(-1) === 1`, 8000);
    const titulo1 = await avaliar('document.title');
    await evento({ session_id: sid, hook_event_name: 'Stop', cwd: 'C:\\pwa\\Projeto' });
    const viu0 = await esperar(`window.__selos.at(-1) === 0`, 8000);
    resumo.selo = { chamadas: await avaliar('window.__selos.slice()'), tituloComUma: titulo1 };
    if (!viu1 || !viu0) falhar('selo: ' + JSON.stringify(resumo.selo));

    // Offline: derruba o servidor e recarrega. Tem de aparecer a tela do Orbit, não o erro.
    await derrubar();
    await cdp('Page.reload');
    await dormir(1500);
    const off = await avaliar(`({ titulo: document.title, h1: document.querySelector('h1') && document.querySelector('h1').textContent, pasta: (document.getElementById('pasta') || {}).textContent, fonte: document.fonts.check('16px Geist') })`);
    const capOff = await foto('offline-1440');
    await largura(420, 800); await dormir(300);
    const capOffEstreito = await foto('offline-420');
    const rolagem = await avaliar('document.documentElement.scrollWidth > innerWidth');
    await largura(1440, 900);
    // Volta sozinha quando o servidor sobe.
    await subir();
    const voltou = await esperar(`document.title.indexOf('Orbit') >= 0 && !!document.getElementById('casca')`, 12000);
    resumo.offline = { ...off, rolagemHorizontal420: rolagem, voltouSozinha: voltou, capturas: [capOff, capOffEstreito] };
    if (off?.h1 !== 'Orbit offline') falhar('tela offline não apareceu: ' + JSON.stringify(off));
    if (!voltou) falhar('a página não voltou sozinha depois que o servidor subiu');
    if (rolagem) falhar('tela offline com rolagem horizontal em 420');
  }
} catch (e) {
  falhar('exceção no teste: ' + (e?.stack || e));
} finally {
  try { ws?.close(); } catch {}
  // Fecha o navegador inteiro. O msedge.exe que abrimos repassa para outro processo, então nem
  // kill() nem taskkill no pid dele alcançam a árvore (os filhos seguravam o perfil e o disco).
  // Reserva: qualquer navegador que ainda use este perfil (no Windows, o PowerShell de sempre; ver edge.mjs).
  await fecharEdge(porta, perfil);
  await derrubar();
  for (const d of [DADOS, SESSOES]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

if (resumo.consoleErros.length) falhar('erros de console: ' + resumo.consoleErros.length);
if (!SO_MEDIR) {
  resumo.ok = resumo.erros.length === 0;
  console.log(JSON.stringify(resumo, null, 2));
}
process.exit(resumo.erros.length ? 1 : 0);
