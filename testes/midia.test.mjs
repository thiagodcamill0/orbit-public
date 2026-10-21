// Teste da música tocando (midia.mjs, midia.ps1, assets/midia.js): servidor de teste numa porta livre de 47822–47826,
// fonte de mídia falsa (ORBIT_MIDIA_FALSO), Edge headless mudo. No fim, o midia.ps1 de verdade, só lendo (nenhum
// comando vai para os players do usuário). Nunca toca a 47821 nem a pasta %LOCALAPPDATA%\Orbit do usuário.
// node testes/midia.test.mjs <pasta-de-saida>   (~1 min; capturas na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-midia-teste'));
fs.mkdirSync(SAIDA, { recursive: true });
const DADOS = path.join(SAIDA, 'dados'), COFRE = path.join(SAIDA, 'cofre'), SESS = path.join(SAIDA, 'sessoes'), EDGE_DIR = path.join(SAIDA, 'edge');
for (const d of [DADOS, COFRE, SESS, EDGE_DIR]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, COFRE, SESS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
// O acesso antigo da Web API do Spotify, para conferir que some.
fs.writeFileSync(path.join(COFRE, 'spotify.token'), 'AQAAANCMnd8BFdERjHoAwE');
fs.writeFileSync(path.join(COFRE, 'spotify.json'), JSON.stringify({ clientId: '0123456789abcdef0123456789abcdef', ativo: true, conta: { id: 'x', nome: 'X' } }));
const FALSO = path.join(SAIDA, 'midia-falsa.json');
const COMANDOS = FALSO + '.comandos';
fs.rmSync(COMANDOS, { force: true });
const CAPA1 = path.join(PROJ, 'assets', 'robot-done-app.png');
const CAPA2 = path.join(PROJ, 'assets', 'logo.png');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 300))); };
const fonte = (o) => fs.writeFileSync(FALSO, JSON.stringify(o));
const sessao = (n, o = {}) => ({ app: 'Spotify.exe', estado: 'tocando', titulo: `Música número ${n} com um nome bem comprido para cortar`, artista: 'Artista ' + n, album: 'Álbum ' + n, play: true, prox: true, ant: true, capaArquivo: n % 2 ? CAPA1 : CAPA2, ...o });
const comandos = () => (fs.existsSync(COMANDOS) ? fs.readFileSync(COMANDOS, 'utf8').trim().split('\n').filter(Boolean) : []);
fonte({ nenhum: true });

const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
let srv;
async function subir() {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: COFRE, ORBIT_MIDIA_FALSO: FALSO },
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/saude')).ok) return; } catch {} await dormir(150); }
  throw new Error('servidor de teste não subiu');
}
async function descer() {
  if (!srv) return;
  const s = srv; srv = null;
  const fim = new Promise((ok) => s.once('exit', ok));
  s.kill(); await Promise.race([fim, dormir(3000)]);
}
const get = async (p) => { const r = await fetch(BASE + p, { cache: 'no-store' }); const t = r.headers.get('content-type') || ''; return { status: r.status, tipo: t, corpo: t.includes('json') ? await r.json() : await r.arrayBuffer() }; };
const post = async (p, b, cab = true) => { const r = await fetch(BASE + p, { method: 'POST', headers: cab ? { 'x-gerenciador': '1', 'content-type': 'application/json' } : { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, corpo: await r.json().catch(() => null) }; };
async function esperarA(cond, ms = 6000, passo = 100) {
  const ate = Date.now() + ms;
  while (Date.now() < ate) { if (await cond()) return true; await dormir(passo); }
  return false;
}
const midiaAgora = async () => (await get('/midia')).corpo.midia;

let pcdp;
try {
  await subir();
  // ── o acesso antigo do Spotify foi apagado ──
  conferir(!fs.existsSync(path.join(COFRE, 'spotify.token')) && !fs.existsSync(path.join(COFRE, 'spotify.json')), 'apaga spotify.token e spotify.json');
  for (const p of ['/spotify', '/spotify/retorno']) conferir((await get(p)).status === 404, `rota antiga ${p} → 404`);

  // ── API sem nada tocando ──
  let r = await get('/midia');
  conferir(r.status === 200 && r.corpo.ativo === true && r.corpo.suportado === true && r.corpo.midia === null, 'GET /midia sem nada', r.corpo);
  r = await post('/midia/comando', { acao: 'alternar' }, false);
  conferir(r.status === 403, 'POST sem x-gerenciador → 403', r);
  r = await post('/midia/comando', { acao: 'apagar' });
  conferir(r.status === 400, 'ação desconhecida → 400', r);
  r = await post('/midia/comando', { acao: 'alternar' });
  conferir(r.status === 409, 'sem player e sem última música → 409', r);

  // ── navegador: "Nada tocando" ──
  const EDGE = (await import('./edge.mjs')).caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${EDGE_DIR}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => { ws.onopen = ok; });
  let seq = 0; const pend = new Map(); const erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') erros.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const foto = async (nome, clip) => { const r2 = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 2 } } : {}) }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64')); };
  const caixa = async (sel) => av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const mover = async (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const clicar = async (sel) => {
    // Os controles só ganham espaço com o hover: passa o mouse no cartão antes de medir o botão.
    const pal = await caixa('#midia-widget .sp-palco');
    await mover(pal.x + pal.w / 2, pal.y + 14);
    await dormir(350);
    const c = await caixa(sel);
    const x = c.x + c.w / 2, y = c.y + c.h / 2;
    await mover(x, y);
    await dormir(200);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const opac = (sel) => av(`Number(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity)`);
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2500);
  conferir(await esperarA(() => av(`document.getElementById('midia-widget').classList.contains('on')`)), 'widget fixo, mesmo sem nada');
  conferir(await av(`document.querySelector('#midia-widget .sp-titulo')?.textContent`) === 'Nada tocando', '"Nada tocando" sem nenhuma música ainda');
  conferir(await av(`document.querySelector('#midia-widget .sp-ctl').hidden`) === true, '"Nada tocando" sem controles');
  const lat = await caixa('#lateral'), pB = await caixa('#btn-perfil'), rB = await caixa('#recolher');
  const wB = await caixa('#midia-widget');
  conferir(wB.h > 40 && wB.y + wB.h <= pB.y + 1 && wB.y >= rB.y + rB.h - 1, 'widget entre a seta de recolher e o perfil', { wB, pB, rB });
  await foto('01-nada', { x: lat.x, y: Math.max(0, pB.y - 140), width: lat.w, height: 220 });

  // ── tocando ──
  fonte(sessao(1));
  conferir(await esperarA(async () => (await av(`document.querySelector('#midia-widget .sp-txt-c:not(.saindo) .sp-titulo')?.textContent || ''`)).startsWith('Música número 1')), 'mostra a música tocando');
  let m = await midiaAgora();
  conferir(m && m.estado === 'tocando' && m.spotify === true && m.app === 'Spotify' && m.lembranca === false && /^\/midia\/capa\?v=[0-9a-f]{16}$/.test(m.capa || ''), 'GET /midia tocando', m);
  r = await get(m.capa);
  conferir(r.status === 200 && r.tipo === 'image/png' && r.corpo.byteLength === fs.statSync(CAPA1).size, 'GET /midia/capa');
  conferir((await get('/midia/capa?v=0000000000000000')).status === 404, 'capa de outra música → 404');
  await dormir(500);
  conferir((await av(`document.querySelector('#midia-widget .sp-capa img')?.naturalWidth`)) > 0, 'capa carregada no widget');
  conferir(await opac('#midia-widget .sp-ctl') === 0, 'controles escondidos sem hover');
  await foto('02-tocando', { x: lat.x, y: Math.max(0, pB.y - 140), width: lat.w, height: 220 });

  // Hover: controles aparecem por cima das barrinhas
  const pal = await caixa('#midia-widget .sp-palco');
  await mover(pal.x + pal.w / 2, pal.y + pal.h / 2);
  await dormir(350);
  conferir(await opac('#midia-widget .sp-ctl') === 1, 'hover: controles aparecem');
  const sobrepoe = await av(`(() => { const bts = [...document.querySelectorAll('#midia-widget .sp-bt')].map((b) => b.getBoundingClientRect()); const txt = [...document.querySelectorAll('#midia-widget .sp-txt-c:not(.saindo) .sp-titulo, #midia-widget .sp-txt-c:not(.saindo) .sp-artista')].map((e) => e.getBoundingClientRect()); return bts.some((b) => txt.some((t) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top)); })()`);
  conferir(sobrepoe === false, 'hover: os botões não cobrem o nome da música nem o do artista');
  const palH = (await caixa('#midia-widget .sp-palco')).h;
  conferir(palH > 70 && palH < 82, 'hover: o cartão abre uma linha para os controles', palH);
  conferir(await av(`document.elementFromPoint(...(() => { const r = document.querySelector('#midia-widget .sp-txt-c:not(.saindo) .sp-titulo').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()).classList.contains('sp-titulo')`), 'hover: o título continua por cima (nada na frente)');
  conferir(await av(`document.querySelector('#midia-widget .sp-bt.principal').getAttribute('aria-label')`) === 'Pausar', 'tocando: botão Pausar');
  await foto('03-hover', { x: lat.x, y: Math.max(0, pB.y - 140), width: lat.w, height: 220 });

  // Clique em pausar: muda na hora e manda o comando com o app da sessão
  await clicar('#midia-widget .sp-bt.principal');
  conferir(await esperarA(async () => comandos().includes('alternar\tSpotify.exe'), 3000), 'pausar → comando alternar para Spotify.exe', comandos());
  conferir(await av(`!!document.querySelector('#midia-widget .sp-faixa.pausado')`), 'pausar muda o widget na hora');
  fonte(sessao(1, { estado: 'pausado' }));
  await dormir(600);
  conferir(await av(`document.querySelector('#midia-widget .sp-bt.principal').getAttribute('aria-label')`) === 'Tocar' && await av(`document.querySelectorAll('#midia-widget .sp-txt-c').length`) === 1, 'pausado confirmado: botão Tocar, sem troca de camada');
  await clicar('#midia-widget .sp-bt:not(.principal):last-child');
  conferir(await esperarA(async () => comandos().includes('proxima\tSpotify.exe'), 3000), 'próxima → comando', comandos());
  await clicar('#midia-widget .sp-bt:first-child');
  conferir(await esperarA(async () => comandos().includes('anterior\tSpotify.exe'), 3000), 'anterior → comando', comandos());

  // ── só o que está tocando ──
  fonte(sessao(10));
  conferir(await esperarA(async () => (await av(`document.querySelector('#midia-widget .sp-txt-c:not(.saindo) .sp-titulo')?.textContent || ''`)).startsWith('Música número 10'), 2500), 'Spotify tocando a 10');
  await av(`(() => { window.__titulos = []; const anotar = () => { const t = document.querySelector('#midia-widget .sp-txt-c:not(.saindo) .sp-titulo')?.textContent || ''; if (t && window.__titulos[window.__titulos.length - 1] !== t) window.__titulos.push(t); }; new MutationObserver(anotar).observe(document.getElementById('midia-widget'), { subtree: true, childList: true, characterData: true }); })()`);
  // Uma aba pausada (outra música) nunca entra: fica a da tela, pausada
  let t0 = Date.now();
  fonte(sessao(90, { app: 'Brave', estado: 'pausado', titulo: 'Vídeo de outra aba' }));
  conferir(await esperarA(async () => (await midiaAgora())?.estado === 'pausado', 2000, 50), 'outra aba pausada: a da tela fica, pausada');
  m = await midiaAgora();
  conferir(m.titulo.startsWith('Música número 10') && m.app === 'Spotify' && !m.lembranca, 'outra aba pausada não entra', m);
  conferir(!(await av('window.__titulos')).some((t) => /outra aba/.test(t)), 'a outra aba nunca aparece no widget', await av('window.__titulos'));
  // Pausar a mesma música: na hora, sem trocar
  fonte(sessao(10));
  await esperarA(async () => (await midiaAgora())?.estado === 'tocando', 2000, 50);
  t0 = Date.now();
  fonte(sessao(10, { estado: 'pausado' }));
  conferir(await esperarA(async () => (await midiaAgora())?.estado === 'pausado', 2000, 50) && Date.now() - t0 < 1000, 'pausar: na hora, mesma música', Date.now() - t0);
  // Outra fonte tocando: troca na hora (sem os 3 s), com a transição suave
  t0 = Date.now();
  fonte(sessao(91, { app: 'Brave', titulo: 'Vídeo tocando em outra aba' }));
  const cruzou = await esperarA(async () => (await av(`[...document.querySelectorAll('#midia-widget .sp-txt-c')].map((f) => f.classList.contains('saindo') ? 's' : /outra aba/.test(f.textContent) ? 'n' : 'x').sort().join('')`)) === 'ns', 3000, 20);
  const ms = Date.now() - t0;
  conferir(cruzou && ms < 1500, 'outra fonte tocando: troca na hora, com a transição suave', { cruzou, ms });
  await dormir(700);
  // Próxima pelo widget com a música pausada: a nova entra mesmo pausada
  fonte(sessao(11, { estado: 'pausado' }));
  await dormir(600);
  fonte(sessao(11));
  await esperarA(async () => (await midiaAgora())?.titulo.startsWith('Música número 11'), 2000, 50);
  fonte(sessao(11, { estado: 'pausado' }));
  await esperarA(async () => (await midiaAgora())?.estado === 'pausado', 2000, 50);
  r = await post('/midia/comando', { acao: 'proxima' });
  fonte(sessao(12, { estado: 'pausado' }));
  conferir(await esperarA(async () => (await midiaAgora())?.titulo.startsWith('Música número 12'), 2000, 50), 'próxima com pausado: a nova entra pausada');
  fonte(sessao(1, { estado: 'pausado' }));
  await dormir(700);
  fonte(sessao(1));
  await esperarA(async () => (await midiaAgora())?.titulo.startsWith('Música número 1 '), 3000);
  fonte(sessao(1, { estado: 'pausado' }));
  await dormir(700);

  // Player sem "anterior": botão apagado
  fonte(sessao(2, { app: 'Brave', ant: false }));
  conferir(await esperarA(async () => (await av(`document.querySelector('#midia-widget .sp-txt-c:not(.saindo) .sp-titulo')?.textContent || ''`)).startsWith('Música número 2')), 'outro player (Brave)');
  conferir(await av(`document.querySelector('#midia-widget .sp-bt:first-child').disabled`) === true, 'sem anterior: botão desativado');
  m = await midiaAgora();
  conferir(m.app === 'Brave' && m.spotify === false, 'app do navegador', m);

  // Troca suave
  await dormir(700); // a troca anterior (1 → 2) termina antes
  // Durante a troca o cartão não se mexe: mede a cada quadro o widget, o cartão, a capa e a caixa do texto.
  await av(`(() => { const q = (x) => document.querySelector(x).getBoundingClientRect(); window.__caixas = []; const t0 = performance.now(); const passo = () => { const w = q('#midia-widget'), p = q('#midia-widget .sp-palco'), c = q('#midia-widget .sp-capa'), x = q('#midia-widget .sp-txt'); window.__caixas.push([w.top, w.height, p.top, p.height, c.left, c.top, c.width, x.left, x.top, x.width, x.height, document.querySelectorAll('#midia-widget .sp-faixa').length]); if (performance.now() - t0 < 1400) requestAnimationFrame(passo); }; requestAnimationFrame(passo); })()`);
  fonte(sessao(3));
  conferir(await esperarA(async () => (await av(`[...document.querySelectorAll('#midia-widget .sp-txt-c')].map((f) => f.classList.contains('saindo') ? 's' : f.textContent.includes('número 3') ? '3' : 'x').sort().join('')`)) === '3s', 3000, 20), 'troca suave: a nova entra enquanto a antiga sai');
  await esperarA(async () => (await av(`document.querySelectorAll('#midia-widget .sp-txt-c').length`)) === 1, 2000, 50);
  await dormir(800);
  const caixas = await av('window.__caixas') || [];
  const variou = caixas.length ? caixas[0].map((_, i) => Math.max(...caixas.map((c) => c[i])) - Math.min(...caixas.map((c) => c[i]))) : null;
  conferir(caixas.length > 10 && variou.slice(0, 11).every((d) => d < 0.5) && caixas.every((c) => c[11] === 1), 'troca: o widget não muda de altura nem de posição (só a capa e o texto trocam)', { quadros: caixas.length, variou });
  conferir(await av(`document.querySelectorAll('#midia-widget .sp-txt-c').length`) === 1, 'depois da troca, só a música nova', await av(`[...document.querySelectorAll('#midia-widget .sp-txt-c')].map((f) => f.className + ': ' + f.textContent.slice(0, 18))`));

  // Lateral recolhida: só a capa; no hover, só o play/pause
  await mover(5, 5);
  await av(`document.getElementById('recolher').click()`);
  await dormir(700);
  const capaR = await caixa('#midia-widget .sp-capa');
  conferir(await av(`getComputedStyle(document.querySelector('#midia-widget .sp-txt')).display`) === 'none' && capaR.w === 32, 'recolhida: só a capa', capaR);
  await mover(capaR.x + 16, capaR.y + 16);
  await dormir(350);
  conferir(await opac('#midia-widget .sp-ctl') === 1 && await av(`getComputedStyle(document.querySelector('#midia-widget .sp-bt:first-child')).display`) === 'none', 'recolhida + hover: só o play/pause');
  const latR = await caixa('#lateral');
  await foto('04-recolhida-hover', { x: latR.x, y: Math.max(0, pB.y - 120), width: latR.w, height: 190 });
  await mover(5, 5);
  await av(`document.getElementById('recolher').click()`);
  await dormir(500);

  // ── player fechado: fica a última música, pausada; o play abre o Spotify e toca ──
  fonte({ nenhum: true });
  conferir(await esperarA(async () => (await midiaAgora())?.lembranca === true), 'sem player: última música como lembrança');
  m = await midiaAgora();
  conferir(m.titulo.startsWith('Música número 3') && m.estado === 'pausado' && m.controles.play === true && !m.controles.prox && !m.controles.ant, 'lembrança pausada, só com play', m);
  await dormir(500);
  conferir(await av(`!!document.querySelector('#midia-widget .sp-faixa.pausado')`) && await av(`document.querySelector('#midia-widget .sp-bt.principal').getAttribute('aria-label')`) === 'Abrir o Spotify e tocar', 'widget: lembrança com "Abrir o Spotify e tocar"');
  await foto('05-lembranca', { x: lat.x, y: Math.max(0, pB.y - 140), width: lat.w, height: 220 });
  await clicar('#midia-widget .sp-bt.principal');
  conferir(await esperarA(async () => comandos().some((c) => c.startsWith('abrir-spotify')), 3000), 'play da lembrança → abrir-spotify', comandos());
  fonte(sessao(3, { estado: 'pausado' }));
  conferir(await esperarA(async () => comandos().includes('tocar\tSpotify.exe'), 4000), 'Spotify apareceu pausado → tocar', comandos());
  // Lembrança de outro player: sem play
  fonte(sessao(4, { app: 'Brave' }));
  await esperarA(async () => (await midiaAgora())?.titulo.startsWith('Música número 4'));
  fonte({ nenhum: true });
  conferir(await esperarA(async () => { const x = await midiaAgora(); return x?.lembranca === true && x.controles.play === false; }), 'lembrança do navegador: sem play');
  fonte(sessao(5));
  await esperarA(async () => (await midiaAgora())?.titulo.startsWith('Música número 5'));

  // ── Configurações: só a chave ──
  await av(`document.getElementById('nav-config').click()`);
  await dormir(600);
  await av(`document.getElementById('cfg-midia').scrollIntoView({ block: 'center' })`);
  await dormir(300);
  conferir(await av(`document.querySelectorAll('#cfg-midia .cfg-linha').length`) === 1 && await av(`!!document.getElementById('cfg-midia-ativo')`), 'Configurações: só a chave');
  conferir(!(await av(`/Client ID|Conectar|Desconectar/.test(document.querySelector('.modal-corpo').textContent)`)), 'Configurações: sem o fluxo de conta do Spotify');
  const cB = await caixa('#cfg-midia');
  await foto('06-config', { x: cB.x - 16, y: cB.y - 40, width: cB.w + 32, height: cB.h + 52 });
  await av(`document.getElementById('cfg-midia-ativo').click()`);
  conferir(await esperarA(async () => (await get('/midia')).corpo.ativo === false, 3000), 'chave desliga no servidor');
  conferir(await esperarA(async () => !(await av(`document.getElementById('midia-widget').classList.contains('on')`)) && (await caixa('#midia-widget')).h < 1, 2000, 50), 'desligado: widget some sem espaço vazio', await av(`(() => { const w = document.getElementById('midia-widget'); const c = getComputedStyle(w); return { cls: w.className, rows: c.gridTemplateRows, h: w.getBoundingClientRect().height }; })()`));
  r = await post('/midia/comando', { acao: 'alternar' });
  conferir(r.status === 409, 'desligado: comando → 409', r);
  await av(`document.getElementById('cfg-midia-ativo').click()`);
  conferir(await esperarA(() => av(`document.getElementById('midia-widget').classList.contains('on')`)), 'religado: widget volta');
  conferir(erros.length === 0, 'sem erro de JavaScript na página', erros);
  ws.close();

  // ── reinício: a última música continua (com capa) ──
  fonte({ nenhum: true });
  await esperarA(async () => (await midiaAgora())?.lembranca === true);
  await descer();
  await subir();
  m = await midiaAgora();
  conferir(m && m.lembranca && m.titulo.startsWith('Música número 5') && m.capa, 'depois do reinício, a última música fica', m);
  conferir(await esperarA(async () => comandos().filter((c) => c === 'fixar	Spotify.exe').length >= 1, 4000), 'a fonte começa sabendo o app da tela (fixar)', comandos().slice(-3));
  r = await get(m.capa);
  conferir(r.status === 200 && r.corpo.byteLength === fs.statSync(CAPA1).size, 'capa da última música guardada');
  const json = fs.readFileSync(path.join(DADOS, 'midia.json'), 'utf8');
  conferir(/"ativo": true/.test(json), 'midia.json com a chave');
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
} finally {
  if (pcdp) await fecharEdge(pcdp, EDGE_DIR);
  await descer();
}

// ── o midia.ps1 de verdade, só lendo (só no Windows: no Mac não há fonte de mídia) ──
if (process.platform === 'win32') try {
  const script = fs.readFileSync(path.join(PROJ, 'midia.ps1'), 'utf8');
  const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const p = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  let erro = '';
  p.stderr.on('data', (c) => { erro += c; });
  const linha = await new Promise((ok) => {
    let buf = '';
    const t = setTimeout(() => ok(null), 10000);
    p.stdout.on('data', (c) => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); ok(buf.slice(0, i).trim()); } });
  });
  const j = linha ? JSON.parse(Buffer.from(linha, 'base64').toString('utf8')) : null;
  conferir(j && !j.erro && (j.nenhum === true || (typeof j.app === 'string' && typeof j.titulo === 'string')), 'midia.ps1 real: primeira leitura', j && { ...j, capa: j.capa ? j.capa.length + ' b64' : '' });
  conferir(!erro.trim(), 'midia.ps1 real: nada no stderr', erro.slice(0, 200));
  const saiu = new Promise((ok) => p.once('exit', () => ok(true)));
  p.stdin.end();
  conferir(await Promise.race([saiu, dormir(4000).then(() => false)]), 'midia.ps1 real: fecha a entrada → sai');
  try { p.kill(); } catch {}
} catch (e) {
  res.falhas.push('midia.ps1: ' + (e?.stack || e));
}

// ── Mac simulado (no Mac de verdade, o sistema da máquina, sem `so`): sem fonte, "indisponível neste
// sistema", sem erro e sem processo ──
try {
  const MAC = path.join(SAIDA, 'mac'), MAC_DADOS = path.join(MAC, 'dados'), MAC_LOCAL = path.join(MAC, 'local');
  fs.rmSync(MAC, { recursive: true, force: true });
  for (const d of [MAC_DADOS, MAC_LOCAL]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(MAC_LOCAL, 'spotify.json'), JSON.stringify({ ativo: true }));
  fs.writeFileSync(path.join(MAC_DADOS, 'midia.json'), JSON.stringify({ ativo: true, ultima: { id: 'abc', app: 'Spotify', titulo: 'Música do PC', artista: 'X', album: 'Y', capa: '' } }));
  const antes = process.env.ORBIT_PERFIL_DIR;
  process.env.ORBIT_PERFIL_DIR = MAC_LOCAL;
  const { criarMidia } = await import('../midia.mjs');
  const processos = () => process.getActiveResourcesInfo().filter((r) => r === 'ProcessWrap').length;
  const p0 = processos();
  const difundidos = [];
  const logs = [];
  const m = criarMidia({ ...(process.platform === 'darwin' ? {} : { so: 'darwin' }), dados: MAC_DADOS, lerJSONCorpo: async (req) => req.corpo, difundir: (ev, d) => difundidos.push([ev, d]), log: (...a) => logs.push(a.join(' ')) });
  if (antes === undefined) delete process.env.ORBIT_PERFIL_DIR; else process.env.ORBIT_PERFIL_DIR = antes;
  const chamar = async (method, rota, corpo) => {
    const r = { headersSent: false, status: 0, corpo: null };
    r.writeHead = (c) => { r.status = c; r.headersSent = true; };
    r.end = (t) => { r.corpo = typeof t === 'string' ? JSON.parse(t) : t; };
    try { await m.rota({ method, corpo }, r, rota, new URL('http://x' + rota)); } catch (e) { return { status: e.status || 500, corpo: { erro: e.message } }; }
    return r;
  };
  let r = await chamar('GET', '/midia');
  conferir(r.status === 200 && r.corpo.suportado === false && r.corpo.ativo === true, 'Mac: GET /midia → suportado:false, sem erro', r.corpo);
  r = await chamar('POST', '/midia/comando', { acao: 'alternar' });
  conferir(r.status === 501 && /indisponível neste sistema/.test(r.corpo.erro), 'Mac: comando → 501 "indisponível neste sistema"', r);
  r = await chamar('POST', '/midia/ativo', { ativo: false });
  conferir(r.status === 200 && r.corpo.ativo === false && r.corpo.suportado === false, 'Mac: a chave ainda grava', r.corpo);
  await dormir(3500); // passa um ciclo do conferir (3 s)
  conferir(processos() <= p0,'Mac: nenhum processo aberto (nem PowerShell nem osascript)', { antes: p0, depois: processos() });
  conferir(!fs.existsSync(path.join(MAC_LOCAL, 'spotify.json')), 'Mac: limpeza do acesso antigo na pasta local');
  conferir(!logs.some((l) => /falhou|não abriu/.test(l)), 'Mac: nada de erro no log', logs);
  m.parar();
  fs.rmSync(MAC, { recursive: true, force: true });
} catch (e) {
  res.falhas.push('Mac simulado: ' + (e?.stack || e));
}

console.log(`midia: ${res.ok.length} ok, ${res.falhas.length} falhas (porta ${PORTA}; capturas em ${SAIDA})`);
for (const f of res.falhas) console.log('  FALHA ' + f);
process.exit(res.falhas.length ? 1 : 0);
