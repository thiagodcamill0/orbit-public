// Nome do projeto editável (20/10, "Personalizar projeto" no index.html). Sobe o mock (ROTEIRO=0) numa porta livre
// de 47822–47826 e abre o index.html real no Edge headless (mudo):
//  - o campo "Nome" fica no topo do popover, com o nome da pasta como placeholder e a dica "a pasta continua …";
//  - digitar grava config.projetos[pasta].rotulo (a chave continua o nome da pasta) e o nome novo aparece no
//    cabeçalho do popover, na lateral (com a letra inicial nova), no chip do filtro e no card do grupo por projeto;
//  - apagar o nome volta ao nome da pasta; "Restaurar padrão" também tira o nome;
//  - zero erros no console.
// Capturas em <pasta-de-saida>. Uso: node testes/projeto-nome-ui.test.mjs [pasta-de-saida]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-projeto-nome-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (cond) { ok++; console.log('ok   ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
};

const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge');
fs.rmSync(perfil, { recursive: true, force: true });
const pcdp = 9600 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
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
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
  await cdp('Page.navigate', { url: BASE + '/' });
  await espera(`document.querySelectorAll('#projetos .proj-item[data-proj]').length > 0`, 15000);
  await espera(`(() => { const a = document.getElementById('abertura'); return !a || !a.isConnected || a.classList.contains('sai') || getComputedStyle(a).display === 'none'; })()`, 6000);
  await dormir(400);

  const P = await av(`document.querySelector('#projetos .proj-item[data-proj]').dataset.proj`);
  const PJ = JSON.stringify(P);
  const sel = JSON.stringify('#projetos .proj-item[data-proj="' + P + '"]');
  const cfg = () => av(`(async () => (await (await fetch('/config')).json()).projetos[${PJ}] || null)()`);
  await av(`document.querySelector(${sel}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), true`);
  await espera(`!document.getElementById('pj-pop')?.hidden`);

  const ui = await av(`(() => { const c = document.querySelector('#pj-pop .pj-nome-campo'), rots = [...document.querySelectorAll('#pj-pop .pj-rot')];
    return { existe: !!c, primeiro: rots[0]?.firstChild?.textContent, dica: rots[0]?.querySelector('span')?.textContent, placeholder: c?.placeholder, valor: c?.value }; })()`);
  conferir(ui.existe && ui.primeiro === 'Nome' && ui.placeholder === P && ui.valor === P && ui.dica === 'a pasta continua ' + P, 'campo "Nome" no topo, com o nome da pasta', ui);

  // Digitar grava o rótulo (com espera de 400 ms) e troca o nome em todo lugar; a chave e o data-proj ficam
  await av(`(() => { const c = document.querySelector('#pj-pop .pj-nome-campo'); c.focus(); c.value = '  Zeta   renomeado '; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await espera(`(async () => ((await (await fetch('/config')).json()).projetos[${PJ}] || {}).rotulo === 'Zeta renomeado')()`, 3000);
  const c1 = await cfg();
  conferir(c1 && c1.rotulo === 'Zeta renomeado', 'grava config.projetos[pasta].rotulo', c1);
  const tela = await av(`(() => { const b = document.querySelector(${sel});
    return { lat: b?.querySelector('.nome')?.textContent, letra: b?.querySelector('.pj-letra')?.textContent, tit: document.querySelector('#pj-pop .pj-nome').textContent }; })()`);
  conferir(tela.lat === 'Zeta renomeado' && tela.tit === 'Zeta renomeado', 'nome novo na lateral e no cabeçalho do popover', tela);
  conferir(!tela.letra || tela.letra === 'Z', 'letra inicial segue o nome novo', tela);
  await foto('1-popover');

  // Enter fecha; filtrar pelo projeto mostra o nome novo no chip; agrupado, no card do projeto
  await av(`document.querySelector('#pj-pop .pj-nome-campo').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })), true`);
  conferir(await espera(`document.getElementById('pj-pop').hidden`), 'Enter no nome fecha o popover');
  await av(`document.querySelector(${sel}).click(), true`);
  const chip = await espera(`(() => { const b = document.querySelector('#filtro-proj .fp-nome'); return b && !document.getElementById('filtro-proj').hidden ? b.textContent : (document.querySelector('#lista .grupo-rot, #lista [class*="rot"]') ? 'agrupado' : ''); })()`, 3000);
  const grupo = await av(`[...document.querySelectorAll('#lista *')].some((e) => e.children.length === 0 && e.textContent === 'Zeta renomeado')`);
  conferir(chip === 'Zeta renomeado' || grupo, 'nome novo no chip do filtro ou no cabeçalho do grupo', { chip, grupo });
  await foto('2-filtro');
  await av(`document.querySelector(${sel}).click(), true`);

  // Apagar volta ao nome da pasta
  await av(`document.querySelector(${sel}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), true`);
  await espera(`!document.getElementById('pj-pop')?.hidden`);
  await av(`(() => { const c = document.querySelector('#pj-pop .pj-nome-campo'); c.focus(); c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await espera(`(async () => !((await (await fetch('/config')).json()).projetos[${PJ}] || {}).rotulo)()`, 3000);
  const volta = await av(`document.querySelector(${sel} + ' .nome').textContent`);
  conferir(volta === P, 'nome vazio volta ao nome da pasta', volta);

  // "Restaurar padrão" tira o nome também
  await av(`(() => { const c = document.querySelector('#pj-pop .pj-nome-campo'); c.value = 'Outro nome'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await espera(`(async () => ((await (await fetch('/config')).json()).projetos[${PJ}] || {}).rotulo === 'Outro nome')()`, 3000);
  const rest = await av(`(() => { const r = document.querySelector('#pj-pop .pj-pe .link'); return r.hidden ? 'oculto' : (r.click(), 'ok'); })()`);
  await dormir(300);
  const depois = await av(`document.querySelector(${sel} + ' .nome').textContent`);
  conferir(rest === 'ok' && depois === P, '"Restaurar padrão" aparece com só o nome e volta ao nome da pasta', { rest, depois });

  conferir(erros.length === 0, 'zero erros no console', erros);
  ws.close();
} catch (e) {
  falhas++;
  console.log('FALHA', 'execução', e.stack || e);
} finally {
  await fecharEdge(pcdp, perfil);
  mock.kill();
}
console.log(`\n${ok} ok, ${falhas} falha(s). Capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
