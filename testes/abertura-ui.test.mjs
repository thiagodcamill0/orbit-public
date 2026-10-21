// Tela de abertura (ao abrir e no F5, 20/10): as 7 peças da logo vetorial entram com mola e encaixam em ~1,7 s;
// num carregamento lento a logo montada pulsa até o primeiro "inicio"; sai em 300 ms cruzando com a interface.
// Com movimento reduzido: só o fade da logo pronta, sem peças nem pulsação.
// node testes/abertura-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, falhas = 0;
const conferir = (cond, nome) => { if (cond) ok++; else falhas++; console.log((cond ? 'ok   ' : 'FALHA ') + nome); };

const MOCKP = await escolherPorta(Number(process.env.FUMACA_PORTA) || 47825);
const mock = spawn(process.execPath, [path.join(PASTA, 'testes', 'mock-servidor.mjs')], {
  cwd: PASTA, stdio: 'ignore', env: { ...process.env, MOCK_PORTA: MOCKP },
});
const porta = 9800 + Math.floor(Math.random() * 150);
const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-abertura-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`,
  '--no-first-run', '--disable-gpu', '--mute-audio', 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0;
const pend = new Map();
const erros = [];
try {
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
    if (d.method === 'Runtime.exceptionThrown') erros.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const avaliar = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  await cdp('Runtime.enable');
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${MOCKP}/saude`); break; } catch { await dormir(100); } }

  // Registra desde o começo do documento (a carga local é rápida demais para sondar): quando a camada entra, quando
  // começa a sair e sai; se a .casca tem transição de opacidade na saída (cross-fade); se a logo pulsou.
  // ?lenta=ms segura o orbitPronto por esse tempo, para simular um carregamento demorado.
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__ab = { entrou: null, sai: null, saiu: null, cruza: null, pulsou: false, pulsoAnim: null, cheio: null, pecas: null, svg: false, animadas: null, encaixadas: null };
    const lenta = Number(new URLSearchParams(location.search).get('lenta')) || 0;
    if (lenta) {
      let fn;
      Object.defineProperty(window, 'orbitPronto', { configurable: true,
        get: () => fn && (() => setTimeout(fn, lenta)), set: (f) => { fn = f; } });
    }
    new MutationObserver(() => {
      const ab = window.__ab, e = document.getElementById('abertura');
      if (e && ab.entrou == null && e.querySelector('.ab-cheio')) { ab.entrou = performance.now(); ab.svg = !!e.querySelector('svg.ab-logo') && !e.querySelector('img'); }
      if (e && e.classList.contains('pulsa') && !ab.pulsou) {
        ab.pulsou = true;
        const img = e.querySelector('.ab-logo');
        requestAnimationFrame(() => { ab.pulsoAnim = getComputedStyle(img).animationName; });
      }
      if (e && e.classList.contains('sai') && ab.sai == null) {
        ab.sai = performance.now();
        ab.cheio = Number(getComputedStyle(e.querySelector('.ab-cheio')).opacity);
        const t = getComputedStyle(e.querySelector('.ab-pecas'));
        ab.pecas = t.display === 'none' ? 0 : Number(t.opacity);
        const ps = [...e.querySelectorAll('.ab-p')];
        ab.animadas = ps.filter((p) => p.getAnimations().length).length;
        ab.encaixadas = ps.filter((p) => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(p).transform)).length;
        const c = document.querySelector('.casca');
        ab.cruza = c ? getComputedStyle(c).transitionProperty.includes('opacity') : false;
      }
      if (!e && ab.entrou != null && ab.saiu == null) ab.saiu = performance.now();
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });` });
  const URL0 = `http://127.0.0.1:${MOCKP}/`;
  const carga = async (nome, ir, minimo = 1730) => {
    // O Page.reload responde antes de a página nova entrar: sem isto, a 1ª leitura podia pegar o __ab da carga
    // anterior (já com "saiu") e conferir a página nova no meio da abertura (visto no Mac, 16/10).
    await avaliar('window.__ab = null');
    await ir();
    let ab = null;
    for (let i = 0; i < 200; i++) { ab = await avaliar('window.__ab'); if (ab && ab.saiu != null) break; await dormir(50); }
    const r = (v) => (v == null ? v : Math.round(v));
    conferir(ab && ab.entrou != null, `${nome}: a abertura aparece`);
    conferir(ab && ab.svg, `${nome}: a logo é o SVG (sem img)`);
    conferir(ab && ab.sai != null && ab.sai - ab.entrou >= minimo, `${nome}: a logo fica pelo menos ${minimo + 10} ms montando (começa a sair em ${r(ab && ab.sai)} ms)`);
    conferir(ab && ab.cheio > .99 && ab.pecas < .01, `${nome}: ao sair, a logo inteira está no lugar das peças (cheio ${ab && ab.cheio}, peças ${ab && ab.pecas})`);
    conferir(ab && ab.saiu != null && ab.saiu - ab.sai < 600, `${nome}: a saída leva ~300 ms (sai de vez em ${r(ab && ab.saiu)} ms)`);
    conferir(ab && ab.cruza, `${nome}: a interface surge junto (transição de opacidade na .casca)`);
    await dormir(400);
    conferir(await avaliar(`(() => { const c = document.querySelector('.casca'); const s = getComputedStyle(c);
      return s.display !== 'none' && s.opacity === '1' && !document.documentElement.classList.contains('abrindo'); })()`), `${nome}: a interface fica à mostra`);
    return ab;
  };
  await carga('abrir', () => cdp('Page.navigate', { url: URL0 })); // navegador frio: pode passar do mínimo
  const rapida = await carga('F5', () => cdp('Page.reload'));
  conferir(rapida && !rapida.pulsou && rapida.sai < 1950, `F5: carregamento rápido não pulsa nem espera além do mínimo (${rapida && Math.round(rapida.sai)} ms)`);
  conferir(rapida && rapida.animadas === 7, `F5: as 7 peças entram animadas (${rapida && rapida.animadas})`);
  conferir(rapida && rapida.encaixadas === 7, `F5: as 7 peças terminam encaixadas, sem deslocamento (${rapida && rapida.encaixadas})`);
  const lenta = await carga('lenta', () => cdp('Page.navigate', { url: URL0 + '?lenta=2600' }));
  conferir(lenta && lenta.pulsou && lenta.pulsoAnim === 'ab-pulso', `lenta: a logo montada pulsa (${lenta && lenta.pulsoAnim})`);
  conferir(lenta && lenta.sai >= 2500, 'lenta: a logo fica até o app carregar');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduz = await carga('reduzido', () => cdp('Page.navigate', { url: URL0 + '?lenta=2600' }), 590);
  conferir(reduz && reduz.pulsou && reduz.pulsoAnim === 'ab-fade', `reduzido: só o fade, sem pulsação (${reduz && reduz.pulsoAnim})`);
  conferir(reduz && reduz.pecas === 0 && reduz.animadas === 0, `reduzido: sem peças animadas (${reduz && reduz.animadas})`);
  conferir(erros.length === 0, 'sem exceções na página' + (erros.length ? ': ' + erros.join(' | ') : ''));
} finally {
  try { ws && ws.close(); } catch {}
  // No Mac o kill() no pid não alcança os filhos do navegador (gpu, rede, renderizador): fecharEdge fecha a árvore.
  if (process.platform === 'win32') edge.kill(); else await fecharEdge(porta, perfil);
  mock.kill();
  await dormir(300);
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
}
console.log(`\n${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
