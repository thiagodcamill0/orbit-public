// Teste do card "Espaço em disco" (disco.mjs + index.html): módulo isolado, servidor de teste numa porta livre
// (47822–47826) e Edge headless mudo. A pasta do Claude medida é uma falsa, na pasta de saída; o histórico vai
// para <saída>/dados/disco.json. Nunca toca a 47821.
// node testes/disco.test.mjs <pasta-de-saida>   (~40 s; capturas na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarDisco, podar, tamanhoPasta, RETER_FINO, RETER_TUDO } from '../disco.mjs';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-disco-teste'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const GIB = 1024 ** 3, MIN = 60e3, HORA = 3600e3, DIA = 864e5;

// ── 1. Módulo ──
{
  const agora = Date.now();
  const amostras = [];
  for (let t = agora - 40 * DIA; t <= agora; t += 10 * MIN) amostras.push([t, 1, 2, 0]);
  const p = podar(amostras, agora);
  conferir(p.every((a) => a[0] >= agora - RETER_TUDO), 'podar: nada mais velho que 31 dias');
  conferir(p.filter((a) => a[0] >= agora - RETER_FINO).length === amostras.filter((a) => a[0] >= agora - RETER_FINO).length, 'podar: últimas 48 h inteiras');
  const velhas = p.filter((a) => a[0] < agora - RETER_FINO);
  conferir(new Set(velhas.map((a) => Math.floor(a[0] / HORA))).size === velhas.length, 'podar: uma por hora antes de 48 h');
  conferir(p.length > 900 && p.length < 1020, 'podar: ≈ 1 000 amostras', p.length);
}
{
  const raiz = path.join(SAIDA, 'pasta-medida');
  fs.rmSync(raiz, { recursive: true, force: true });
  fs.mkdirSync(path.join(raiz, 'sub', 'fundo'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'a.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(raiz, 'sub', 'b.bin'), Buffer.alloc(2000));
  fs.writeFileSync(path.join(raiz, 'sub', 'fundo', 'c.bin'), Buffer.alloc(500));
  const fora = path.join(SAIDA, 'fora-da-pasta');
  fs.mkdirSync(fora, { recursive: true });
  fs.writeFileSync(path.join(fora, 'grande.bin'), Buffer.alloc(100000));
  let junc = false;
  try { fs.symlinkSync(fora, path.join(raiz, 'juncao'), 'junction'); junc = true; } catch {}
  conferir(await tamanhoPasta(raiz) === 3500, 'tamanhoPasta: soma os arquivos' + (junc ? ' e não segue a junção' : ' (sem junção nesta máquina)'), await tamanhoPasta(raiz));
  conferir(await tamanhoPasta(path.join(SAIDA, 'nao-existe')) === 0, 'tamanhoPasta: pasta ausente = 0');
}
{
  const dir = path.join(SAIDA, 'modulo');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, 'disco.json');
  let relogio = Date.now() - 40 * DIA;
  const difundidos = [];
  const d = criarDisco({
    arquivo, agora: () => relogio, intervaloMs: 10 * MIN,
    statfs: async () => ({ bsize: 4096, blocks: 60e6, bfree: 20e6, bavail: 20e6 }),
    tamanho: async () => 123456, difundir: (tipo, x) => difundidos.push([tipo, x]),
  });
  const [a1, a2] = await Promise.all([d.medir(), d.medir()]);
  conferir(a1 === a2 && d.publico().amostras.length === 1, 'medir: duas chamadas juntas fazem uma medida só');
  conferir(difundidos.length === 1 && difundidos[0][0] === 'disco' && difundidos[0][1].amostra[3] === 123456, 'medir: difunde o SSE "disco"');
  conferir(a1[2] === 4096 * 60e6 && a1[1] === 4096 * 40e6, 'medir: usado = total - livre', a1);
  let maior = 0;
  for (let k = 0; k < 40 * 144; k++) {
    relogio += 10 * MIN;
    await d.medir();
    if (k % 500 === 0) maior = Math.max(maior, fs.statSync(arquivo).size);
  }
  maior = Math.max(maior, fs.statSync(arquivo).size);
  conferir(maior < 70e3, 'arquivo de tamanho fixo (40 dias de medidas)', maior);
  conferir(JSON.stringify(fs.readdirSync(dir)) === '["disco.json"]', 'só o disco.json fica na pasta (sem .tmp, sem cópias)', fs.readdirSync(dir));
  fs.writeFileSync(arquivo, '{ quebrado');
  const d2 = criarDisco({ arquivo, agora: () => relogio, statfs: async () => ({ bsize: 1, blocks: 10, bfree: 5 }), tamanho: async () => 0 });
  d2.carregar();
  conferir(d2.publico().amostras.length === 0, 'arquivo ilegível: recomeça vazio');
  await d2.medir();
  conferir(JSON.stringify(fs.readdirSync(dir)) === '["disco.json"]', 'arquivo ilegível: sobrescrito, sem cópia de reserva', fs.readdirSync(dir));
}

{
  // Raiz medida por sistema (16/10): raizDisco() do plataforma.mjs. Windows: a unidade do sistema; Mac (simulado): /.
  const { raizDisco } = await import('../plataforma.mjs');
  const pedidas = [];
  const statfs = async (p) => { pedidas.push(p); return { bsize: 1, blocks: 10, bfree: 5 }; };
  const arq = path.join(SAIDA, 'modulo-raiz', 'disco.json');
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const dW = criarDisco({ arquivo: arq, statfs, tamanho: async () => 0 });
  await dW.medir();
  conferir(pedidas[0] === raizDisco() && (process.platform !== 'win32' || /^[A-Z]:\\$/i.test(pedidas[0])), 'sem unidade: mede a raizDisco() desta máquina', pedidas);
  const dM = criarDisco({ arquivo: arq, unidade: raizDisco({ so: 'darwin' }), statfs, tamanho: async () => 0 });
  await dM.medir();
  conferir(pedidas[1] === '/' && dM.publico().unidade === '/', 'Mac (simulado): mede / e a rota diz unidade "/"', { pedidas, unidade: dM.publico().unidade });
  conferir(dW.publico().unidade === raizDisco().replace(/\\$/, ''), 'Windows: a rota diz a unidade sem a barra (C:)', dW.publico().unidade);
  // Pasta temporária do Claude Code: %TEMP%\claude no Windows; /tmp/claude-<uid> no Mac (o $TMPDIR não é usado).
  const { pastaClaudePadrao } = await import('../disco.mjs');
  if (process.platform === 'win32') conferir(pastaClaudePadrao() === path.join(os.tmpdir(), 'claude'), 'Windows: pasta do Claude = %TEMP%\\claude', pastaClaudePadrao());
  conferir(/^\/tmp\/claude-\d*$/.test(pastaClaudePadrao('darwin')), 'Mac: pasta do Claude = /tmp/claude-<uid>', pastaClaudePadrao('darwin'));
  conferir(dW.publico().pasta === pastaClaudePadrao(), 'sem pastaClaude: mede a pasta do Claude deste sistema', dW.publico().pasta);
  fs.rmSync(path.dirname(arq), { recursive: true, force: true });
}

// ── 2. Servidor + página ──
const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes'), FALSA = path.join(SAIDA, 'claude-falso');
for (const x of [DADOS, PERFIL, SESS, FALSA, path.join(SAIDA, 'edge')]) fs.rmSync(x, { recursive: true, force: true });
for (const x of [DADOS, PERFIL, SESS, FALSA]) fs.mkdirSync(x, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
fs.writeFileSync(path.join(FALSA, 'scratch.bin'), Buffer.alloc(5 * 1024 * 1024));
// Histórico de 30 dias que conta a história de 15/10: o C: sobe devagar; a pasta do Claude dispara com os perfis
// do Edge nos últimos 2 dias e volta a quase nada há 1 h. O total é o C: real (no Mac, o /), para a medida ao
// vivo encaixar.
const real = await fs.promises.statfs(process.platform === 'win32' ? 'C:\\' : '/');
const TOTAL = real.bsize * real.blocks, USADO = TOTAL - real.bsize * real.bfree;
{
  const agora = Date.now(), am = [];
  for (let t = agora - 30 * DIA; t < agora - 20 * MIN; t += t < agora - 48 * HORA ? HORA : 10 * MIN) {
    if (t > agora - 9 * DIA && t < agora - 8.6 * DIA) continue; // servidor desligado: a linha quebra
    const dias = (agora - t) / DIA;
    const pico = dias < 2 && dias > 1 / 24 ? Math.min(85, (2 - dias) * 50) * GIB : 0;
    const claude = (dias >= 2 ? 1.2 + Math.sin(dias) * 0.3 : dias > 1 / 24 ? 1.2 : 0.004) * GIB + pico;
    am.push([Math.round(t), Math.round(USADO - 6 * GIB - (dias / 30) * 4 * GIB + pico), TOTAL, Math.round(claude)]);
  }
  fs.writeFileSync(path.join(DADOS, 'disco.json'), JSON.stringify({ v: 1, amostras: am }));
}

let srv, pcdp, ws;
async function subir(ms) {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL, GERENCIADOR_DISCO_PASTA: FALSA, GERENCIADOR_DISCO_MS: String(ms) },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) return; } catch {} await dormir(150); }
  throw new Error('servidor de teste não subiu');
}
async function derrubar() {
  if (!srv) return;
  await desligarSeMeu(PORTA, srv.pid);
  try { srv.kill(); } catch {}
  for (let i = 0; i < 30; i++) { try { await fetch(BASE + '/saude'); } catch { break; } await dormir(150); }
  srv = null;
}
try {
  await subir(5000);
  let r = await (await fetch(BASE + '/disco')).json();
  conferir(Array.isArray(r.amostras) && r.amostras.length > 500 && r.intervalo === 5000, 'GET /disco devolve o histórico', { n: r.amostras?.length, intervalo: r.intervalo });
  const p405 = await fetch(BASE + '/disco', { method: 'POST', headers: { 'x-gerenciador': '1' } });
  conferir(p405.status === 404 || p405.status === 405, 'POST /disco não existe', p405.status);

  const EDGE = (await import('./edge.mjs')).caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${path.join(SAIDA, 'edge')}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  const pend = new Map();
  let seq = 0;
  const erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') erros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'warning') erros.push('aviso: ' + d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') erros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const tam = async (w, hgt) => { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: false }); await dormir(500); };
  // Captura só do card (com folga), para ver o detalhe.
  const fotoCard = async (nome) => {
    const c = await av(`(() => { const el = document.querySelector('.graf-disco'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left - 12, y: r.top - 12, w: r.width + 24, h: r.height + 24 }; })()`);
    await dormir(150);
    const r2 = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 2 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64'));
  };
  const fotoTela = async (nome) => { const r2 = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64')); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await tam(1440, 1000);
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2500);
  // A medida ao vivo (5 s no teste, pasta falsa de 5 MB) chega pelo SSE.
  // SSE: escuta o /fluxo por 12 s (o servidor de teste mede a cada 5 s); a página mostra a pasta falsa (5 MB).
  {
    const ctl = new AbortController();
    let bruto = '';
    const leitura = fetch(BASE + '/fluxo', { signal: ctl.signal }).then(async (resp) => { const dec = new TextDecoder(); for await (const c of resp.body) bruto += dec.decode(c); }).catch(() => {});
    await dormir(12000);
    ctl.abort();
    await leitura;
    const m = /event: disco\ndata: (.*)\n/.exec(bruto);
    const ev = m ? JSON.parse(m[1]) : null;
    conferir(ev && ev.amostra[3] === 5 * 1024 * 1024, 'SSE "disco" com a medida nova (pasta falsa, 5 MB)', ev);
  }
  conferir(await av(`document.querySelectorAll('#gd-leg .gl-n')[1]?.textContent`) === '5 MB', 'legenda mostra a medida ao vivo', await av(`document.querySelectorAll('#gd-leg .gl-n')[1]?.textContent`));
  conferir(await av(`document.querySelector('#gd-n').textContent.endsWith('GB')`), 'número grande em GB', await av(`document.querySelector('#gd-n').textContent`));
  conferir(await av(`document.querySelectorAll('#gd-svg .gd-linha').length === 2`), 'duas linhas no gráfico');
  conferir(await av(`document.querySelectorAll('#gd-leg .gl-item').length === 2`), 'legenda com as duas linhas');
  conferir(await av(`document.querySelector('.graf-disco').parentElement.classList.contains('geral-grade') && OrbitGrade.layout().some((i) => i.k === 'disco')`), 'card é um widget da grade da Visão geral'); // 21/10: grade (widgets.js)
  await fotoTela('01-home-1440');
  await fotoCard('02-card-24h');
  for (const p of ['7d', '30d']) {
    await av(`document.querySelector('#gd-periodo [data-p="${p}"]').click()`);
    await dormir(300);
    conferir(await av(`document.querySelector('#gd-periodo [data-p="${p}"]').getAttribute('aria-checked') === 'true' && JSON.parse(localStorage.getItem('gi.discoPeriodo')) === '${p}'`), 'período ' + p + ' marcado e lembrado');
    await fotoCard('03-card-' + p);
  }
  // 30d tem o vão de 9 dias atrás: a linha do C: quebra (dois "M").
  conferir(await av(`(document.querySelector('#gd-svg .gd-linha').getAttribute('d').match(/M/g) || []).length >= 2`), 'linha quebra onde não houve medida');
  // Dica: mouse no meio do gráfico.
  await av(`document.querySelector('.graf-disco').scrollIntoView({ block: 'center' })`);
  await dormir(200);
  const meio = await av(`(() => { const r = document.querySelector('#gd-svg').getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: meio.x, y: meio.y });
  await dormir(200);
  conferir(await av(`!document.querySelector('#gd-dica').hidden && document.querySelectorAll('#gd-dica .gd-dica-l').length === 2`), 'dica com as duas linhas no hover', await av(`[document.querySelector('#gd-dica').hidden, document.querySelector('#gd-dica').childElementCount, JSON.stringify(document.querySelector('#gd-svg').getBoundingClientRect())]`));
  await fotoCard('04-dica');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await dormir(150);
  conferir(await av(`document.querySelector('#gd-dica').hidden`), 'dica some ao sair');
  // Vão de 9 dias atrás: linha tracejada, sem retângulo nem texto no gráfico; a etiqueta só na dica, no hover.
  conferir(await av(`!document.querySelector('#gd-svg text.gd-vao-rot, #gd-svg .gd-vao-pilula') && getComputedStyle(document.querySelector('#gd-svg .gd-ponte')).strokeDasharray !== 'none' && getComputedStyle(document.querySelector('#gd-svg .gd-vao')).stroke === 'none'`), 'vão: ponte tracejada, faixa sem borda, sem etiqueta fixa');
  const noVao = await av(`(() => { const v = document.querySelector('#gd-svg .gd-vao'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (noVao) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: noVao.x, y: noVao.y });
    await dormir(200);
  }
  conferir(noVao && await av(`!document.querySelector('#gd-dica').hidden && /^sem medida · \\d+ h/.test(document.querySelector('#gd-dica .gd-dica-l').textContent) && document.querySelector('#gd-svg .gd-mira').getAttribute('visibility') === 'hidden'`), 'vão: dica "sem medida · N h" no hover, sem a mira', [noVao, await av(`document.querySelector('#gd-dica').textContent`)]);
  await fotoCard('04b-dica-vao');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await dormir(150);
  // Aviso: pouco espaço livre e pasta do Claude crescendo. Outro histórico, servidor sem medida ao vivo.
  await tam(1440, 1000);
  await derrubar();
  {
    const t = Date.now(), am = [];
    for (let k = 144; k >= 1; k--) am.push([t - k * 10 * MIN, TOTAL - (20 - (144 - k) / 12) * GIB, TOTAL, (k <= 5 ? 1 + (6 - k) * 0.7 : 1) * GIB]);
    fs.writeFileSync(path.join(DADOS, 'disco.json'), JSON.stringify({ v: 1, amostras: am.map((a) => a.map(Math.round)) }));
  }
  await subir(600000);
  await av(`localStorage.setItem('gi.discoPeriodo', '"24h"')`);
  await cdp('Page.reload', {});
  await dormir(2500);
  conferir(await av(`document.querySelector('#gd-sub').classList.contains('aviso') && /livres/.test(document.querySelector('#gd-sub').textContent) && /Claude/.test(document.querySelector('#gd-sub').title)`), 'aviso de pouco espaço, com o do Claude no title', await av(`document.querySelector('#gd-sub').textContent + ' | ' + document.querySelector('#gd-sub').title`));
  conferir(await av(`document.querySelectorAll('#gd-leg .gl-p.aviso').length === 1`), 'variação do Claude em laranja na legenda');
  await fotoCard('05-aviso');
  await derrubar();
  await subir(600000);
  await cdp('Page.reload', {});
  await dormir(2500);
  // Larguras: 616–1080 (dois por linha) e 420 (empilhado), sem rolagem horizontal.
  for (const w of [1200, 900, 420]) {
    await tam(w, 1000);
    await av(`document.querySelector('.graf-disco').scrollIntoView({ block: 'center' })`);
    await dormir(400);
    conferir(await av(`document.documentElement.scrollWidth <= innerWidth`), w + ' px: sem rolagem horizontal', await av('[document.documentElement.scrollWidth, innerWidth]'));
    conferir(await av(`(() => { const c = document.querySelector('.graf-disco').getBoundingClientRect(), g = document.querySelector('.geral-grade').getBoundingClientRect(); return c.left >= g.left - 1 && c.right <= g.right + 1 && [...document.querySelectorAll('.geral-grade > .graf')].every((o) => { if (o.classList.contains('graf-disco')) return true; const r = o.getBoundingClientRect(); return r.right <= c.left + 1 || r.left >= c.right - 1 || r.bottom <= c.top + 1 || r.top >= c.bottom - 1; }); })()`), w + ' px: dentro da grade, sem sobrepor outro widget'); // 21/10: grade (widgets.js)
    await fotoCard('06-card-' + w); // o headless só gera quadro na captura: o ResizeObserver dispara nela
    conferir(await av(`(() => { const s = document.querySelector('#gd-svg'); return Math.abs(s.viewBox.baseVal.width - s.getBoundingClientRect().width) < 2; })()`), w + ' px: gráfico redesenhado na largura certa', await av(`[document.querySelector('#gd-svg').getAttribute('viewBox'), document.querySelector('#gd-svg').getBoundingClientRect().width]`));
    await fotoTela('07-tela-' + w);
  }
  conferir(erros.length === 0, 'console sem erros', erros);
} catch (e) {
  res.falhas.push('erro: ' + (e?.stack || e));
} finally {
  try { ws?.close(); } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge'));
  await derrubar();
  const sobra = fs.existsSync(DADOS) ? fs.readdirSync(DADOS).filter((x) => x.startsWith('disco')) : [];
  conferir(JSON.stringify(sobra) === '["disco.json"]', 'servidor de teste: só o disco.json', sobra);
}
for (const x of res.ok) console.log('ok   ', x);
for (const x of res.falhas) console.log('FALHA', x);
console.log(`\n${res.ok.length} ok / ${res.falhas.length} falhas`);
process.exit(res.falhas.length ? 1 : 0);
