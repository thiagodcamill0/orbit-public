// Widget "Grafo do projeto" da Visão geral (21/10) no app real (index.html + servidor.mjs), com cofres falsos e
// DADOS numa pasta temporária. Porta livre de 47822–47826, Edge headless mudo; tudo apagado/fechado no fim (só o
// servidor que este teste subiu); nunca toca a 47821.
//  - API: GET /grafo/padrao; config.projetos[p].brain (absoluto, '' fica, relativo é recusado);
//  - sem filtro, o widget mostra o brain de fábrica do Orbit (o cofre); trocar de projeto troca o grafo;
//  - projeto sem brain: estado vazio com "Vincular brain", que abre o seletor e grava a pasta;
//  - clique num nó abre a prévia; "Abrir no Grafo" leva à aba completa na pasta do brain;
//  - a roda sem Ctrl não mexe no zoom; fora da tela e com a Home escondida a vista pausa; acomodado, dorme;
//  - modo de edição: segurar no grafo entra sem deixar o pan preso; arrastar troca de vaga; ordem antiga ganha o widget;
//  - campo "Brain" no Personalizar projeto (mostra, troca, desvincula; "Restaurar padrão" volta ao padrão do Orbit);
//  - zero erros no console.
// node testes/grafo-widget-ui.test.mjs [pasta-de-capturas]   (~40 s)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORBIT = path.basename(PROJ);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grafo-widget-'));
const FOTOS = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (FOTOS) fs.mkdirSync(FOTOS, { recursive: true });
const DADOS = path.join(TMP, 'dados'), PERFIL = path.join(TMP, 'perfil'), SESS = path.join(TMP, 'sessoes'), EDGE_PERFIL = path.join(TMP, 'edge');
const COFRE_A = path.join(TMP, 'cofre-a'), COFRE_B = path.join(TMP, 'cofre-b'), OUTRO = path.join(TMP, 'Outro');
for (const d of [DADOS, PERFIL, SESS, path.join(COFRE_A, 'Sub'), COFRE_B, OUTRO]) fs.mkdirSync(d, { recursive: true });
const cfg = {}; // config vazia de teste (nunca a do usuário)
cfg.projetos = {};
fs.writeFileSync(path.join(DADOS, 'config.json'), JSON.stringify(cfg));
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: ORBIT, pasta: PROJ, desde: new Date().toISOString() }, { nome: 'Outro', pasta: OUTRO, desde: new Date().toISOString() }], ocultos: [] }));
const NOTAS = { 'A.md': '# Alfa\nVeja [[B]] e [[C]].\n', 'B.md': '---\ntipo: teste\n---\nBeta liga em [[C]] e em [[Falta]].\n', 'C.md': 'Gama sem links.\n', 'Sub/D.md': 'Delta aponta para [[A]].\n', 'E.md': 'Órfã.\n' };
for (const [n, t] of Object.entries(NOTAS)) fs.writeFileSync(path.join(COFRE_A, n), t);
fs.writeFileSync(path.join(COFRE_B, 'P.md'), 'Pê liga em [[Q]].\n');
fs.writeFileSync(path.join(COFRE_B, 'Q.md'), 'Quê.\n');
const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 600))); };

let srv, pcdp, ws, manter;
const consoleErros = [];
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL, ORBIT_COFRE: COFRE_A },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

  // ── API ──
  const getJ = async (u) => (await fetch(BASE + u, { cache: 'no-store' })).json();
  const postCfg = (projetos) => fetch(BASE + '/config', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ projetos }) });
  const pad = await getJ('/grafo/padrao');
  conferir(pad.projeto === ORBIT && path.resolve(pad.pasta) === path.resolve(COFRE_A), 'GET /grafo/padrao: o projeto do Orbit e o cofre', pad);
  await postCfg({ Outro: { brain: 'relativo/pasta' } });
  conferir(!(await getJ('/config')).projetos.Outro, 'brain relativo é recusado (nada gravado)', (await getJ('/config')).projetos.Outro);
  await postCfg({ Outro: { brain: COFRE_B } });
  conferir((await getJ('/config')).projetos.Outro?.brain === COFRE_B, 'brain absoluto é gravado em config.projetos', (await getJ('/config')).projetos.Outro);
  await postCfg({ Outro: { brain: '' } });
  conferir((await getJ('/config')).projetos.Outro?.brain === '', "brain '' fica gravado (desvinculado)", (await getJ('/config')).projetos.Outro);
  await postCfg({ Outro: null });

  // ── Edge ──
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${EDGE_PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let seq = 0; const pend = new Map();
  let alvo;
  for (let i = 0; i < 150 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) consoleErros.push(d.params.type + ': ' + d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + '\n' + expr.slice(0, 200));
    return r.result?.result?.value;
  };
  const esperar = async (expr, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr).catch(() => false)) return true; await dormir(50); } return false; };
  const mouse = (type, x, y, button = 'none', buttons = 0, modifiers = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const foto = async (nome) => { if (!FOTOS) return; const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(FOTOS, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
  manter = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1000);
  const W = `document.getElementById('grafo-card')._gw`;
  const est = () => av(`${W}._estado()`);
  const item = (p) => JSON.stringify('#projetos .proj-item[data-proj="' + p + '"]');
  const filtroAtual = () => av(`(() => { const f = document.getElementById('filtro-proj'); return f.hidden ? '' : (document.querySelector('#projetos .proj-item[aria-current="true"], #projetos .proj-item.ativo')?.dataset.proj || '?'); })()`);
  const filtrar = async (p) => {
    if (!p) { await av(`(() => { const f = document.getElementById('filtro-proj'); if (!f.hidden) f.click(); return true; })()`); await dormir(150); return; }
    await esperar(`!!document.querySelector(${item(p)})`, 5000);
    await av(`(() => { const f = document.getElementById('filtro-proj'); if (!f.hidden) f.click(); return true; })()`);
    await dormir(100);
    await av(`document.querySelector(${item(p)}).click(), true`);
    await dormir(150);
  };
  const personalizar = async (p) => {
    await av(`document.querySelector(${item(p)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 300 })), true`);
    await dormir(200);
    await av(`(() => { const b = [...document.querySelectorAll('[role="menuitem"], .menu button')].find((x) => x.textContent.trim() === 'Editar projeto'); if (b) b.click(); return !!b; })()`);
    await esperar(`!!document.getElementById('pj-pop') && !document.getElementById('pj-pop').hidden`, 3000);
  };
  const fecharPop = () => av(`[...document.querySelectorAll('#pj-pop .pj-pe .btn')].find((b) => b.textContent === 'Pronto').click(), true`);
  void filtroAtual;
  const verCard = () => av(`document.getElementById('grafo-card').scrollIntoView({ block: 'center' }), true`);

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`!!document.getElementById('grafo-card') && !!document.getElementById('grafo-card')._gw`, 10000);
  await esperar(`(() => { const a = document.getElementById('abertura'); return !a || !a.isConnected || a.classList.contains('sai') || getComputedStyle(a).display === 'none'; })()`, 6000);
  await av(`localStorage.removeItem('gi.grafoWidget'); localStorage.removeItem('gi.grafo'); localStorage.removeItem('gi.widgets'); true`);
  await cdp('Page.reload'); await dormir(800);
  await esperar(`!!document.getElementById('grafo-card')?._gw`, 10000);
  await verCard();

  // ── 1. Lugar e padrão do Orbit ──
  conferir(await av(`(() => { const c = document.getElementById('grafo-card'); return c.dataset.widget === 'grafo' && c.parentElement.classList.contains('geral-grade') && c.classList.contains('graf-compacto'); })()`), 'card na grade da Home, no padrão dos compactos');
  conferir(await esperar(`document.getElementById('gg-n').textContent === '5'`, 8000), 'sem filtro: o brain de fábrica do Orbit (cofre falso, 5 notas)', await av(`[document.getElementById('gg-n').textContent, document.getElementById('grafo-card').dataset.estado]`));
  conferir(await av(`document.getElementById('gg-sub').textContent.includes('cofre-a') && document.getElementById('gg-lido').textContent.includes('ligações')`), 'cabeçalho mostra projeto · brain e o pé as ligações', await av(`[document.getElementById('gg-sub').textContent, document.getElementById('gg-lido').textContent]`));
  conferir(await esperar(`${W}._estado().vista && ${W}._estado().vista.criados === 6`, 6000), 'a vista compacta desenha os 6 nós (5 notas + 1 inexistente)', await est());
  conferir(await av(`document.querySelector('#grafo-card .gg-vista').classList.contains('grafo-vista')`), 'mesma vista e mesmas cores da aba (.grafo-vista)');
  const t0 = Date.now();
  const dormiu = await esperar(`(() => { const e = ${W}._estado().vista; return e.alphaFisica < 0.004 && e.dormindo; })()`, 30000);
  conferir(dormiu, 'acomodado: física e desenho dormem sozinhos (' + Math.round((Date.now() - t0) / 100) / 10 + ' s)', (await est()).vista);
  conferir(await av(`(() => { const e = ${W}._estado().vista; return e.escalaAlvo < 1; })()`), 'o grafo é encaixado no card (escala < 1)', (await est()).vista);
  await foto('1-orbit');

  // ── 2. Roda: sem Ctrl rola a página, com Ctrl aproxima ──
  const centro = await av(`(() => { const r = document.querySelector('#grafo-card .gg-area').getBoundingClientRect(); return [r.left + 12, r.top + 12]; })()`);
  const esc0 = (await est()).vista.escalaAlvo;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centro[0], y: centro[1], deltaX: 0, deltaY: -240 }); await dormir(150);
  conferir((await est()).vista.escalaAlvo === esc0, 'roda sem Ctrl não mexe no zoom', [(await est()).vista.escalaAlvo, esc0]);
  await verCard();
  const centro2 = await av(`(() => { const r = document.querySelector('#grafo-card .gg-area').getBoundingClientRect(); return [r.left + 12, r.top + 12]; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centro2[0], y: centro2[1], deltaX: 0, deltaY: -240, modifiers: 2 }); await dormir(150);
  conferir((await est()).vista.escalaAlvo > esc0, 'Ctrl + roda aproxima', [(await est()).vista.escalaAlvo, esc0]);

  // ── 3. Prévia da nota (clique num nó) ──
  // posição de um nó na tela (pela vista) e o hover acendendo nele
  const achar = async (id) => {
    const p = await av(`(() => { const r = document.querySelector('#grafo-card canvas').getBoundingClientRect(); const n = ${W}._no(${JSON.stringify(id)}); return n && [r.left + n.sx, r.top + n.sy]; })()`);
    if (!p) return null;
    await mouse('mouseMoved', p[0], p[1]); await dormir(120);
    return (await est()).vista.hover === id ? p : null;
  };
  // reencaixa (duplo clique) para todos os nós caberem
  await av(`(() => { const a = document.querySelector('#grafo-card .gg-vista'); a.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  await esperar(`(() => { const e = ${W}._estado().vista; return Math.abs(e.escala / e.escalaAlvo - 1) < 1e-3; })()`, 4000);
  await dormir(400);
  const pB = await achar('B.md');
  conferir(!!pB, 'hover acende o nó sob o cursor (B)', pB);
  if (pB) {
    await mouse('mousePressed', pB[0], pB[1], 'left', 1); await mouse('mouseReleased', pB[0], pB[1], 'left', 0);
    conferir(await esperar(`!document.querySelector('#grafo-card .gg-prev').hidden && document.querySelector('#grafo-card .gg-prev-txt').textContent === 'Beta liga em [[C]] e em [[Falta]].'`, 4000), 'clicar num nó abre a prévia (sem o frontmatter)', await av(`document.querySelector('#grafo-card .gg-prev')?.textContent`));
    conferir((await av(`document.querySelector('#grafo-card .gg-prev-tit b').textContent`)) === 'B', 'prévia com o nome da nota');
    await foto('2-previa');
    await av(`document.querySelector('#grafo-card .gg-prev-x').click(); true`);
    conferir(await av(`document.querySelector('#grafo-card .gg-prev').hidden`), 'o x fecha a prévia');
  }

  // ── 4. Pausa: fora da tela e Home escondida ──
  await av(`document.querySelector('.tiles-wrap, #vista-geral').scrollIntoView({ block: 'start' }); window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; true`);
  const fora = await av(`(() => { const r = document.querySelector('#grafo-card .gg-area').getBoundingClientRect(); return r.bottom <= 0 || r.top >= innerHeight; })()`);
  conferir(fora, 'rolar para o topo tira o widget da tela (1440×900)');
  conferir(await esperar(`${W}._estado().pausado === true`, 3000), 'fora da tela a vista pausa');
  await verCard();
  conferir(await esperar(`${W}._estado().pausado === false`, 3000), 'de volta à tela a vista retoma');

  // ── 5. Trocar de projeto: sem brain → vazio com "Vincular brain" ──
  await filtrar('Outro');
  conferir(await esperar(`document.getElementById('grafo-card').dataset.estado === 'sem-brain'`, 4000), 'projeto sem brain: estado vazio', await av(`document.getElementById('grafo-card').dataset.estado`));
  conferir(await av(`(() => { const b = document.querySelector('#grafo-card .gg-vazio button'); return !!b && b.textContent === 'Vincular brain' && document.querySelector('#grafo-card .gg-vazio-txt').textContent.includes('Outro'); })()`), 'botão "Vincular brain" e o nome do projeto');
  conferir(await av(`document.getElementById('gg-abrir').disabled && document.getElementById('gg-n').textContent === '—'`), 'sem brain: "Abrir no Grafo" desligado e sem contagem');
  await verCard();
  await foto('3-sem-brain');
  await av(`document.querySelector('#grafo-card .gg-vazio button').click(); true`);
  conferir(await esperar(`!!document.querySelector('.gw-dlg') && document.querySelectorAll('.gw-dlg .gw-item, .gw-dlg .gw-pastas .gw-msg').length > 0`, 4000), 'o seletor de pasta abre (na pasta do projeto)');
  conferir(await av(`document.querySelector('.gw-dlg .gw-campo').value`) === OUTRO, 'o seletor começa na pasta do projeto', await av(`document.querySelector('.gw-dlg .gw-campo').value`));
  await av(`(() => { const c = document.querySelector('.gw-dlg .gw-campo'); c.value = ${JSON.stringify(COFRE_B)}; c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await esperar(`document.querySelector('.gw-dlg .gw-campo').value === ${JSON.stringify(COFRE_B)} && !document.querySelector('.gw-dlg .btn.solido').disabled`, 3000);
  await foto('4-seletor');
  await av(`document.querySelector('.gw-dlg .btn.solido').click(); true`);
  conferir(await esperar(`!document.querySelector('.gw-dlg') && document.getElementById('gg-n').textContent === '2'`, 5000), 'vincular troca o widget para o brain novo (2 notas)', await av(`[document.getElementById('gg-n').textContent, document.getElementById('grafo-card').dataset.estado]`));
  conferir(await esperar(`(async () => ((await (await fetch('/config')).json()).projetos.Outro || {}).brain === ${JSON.stringify(COFRE_B)})()`, 3000), 'a pasta fica gravada em config.projetos.Outro.brain');

  // ── 6. Troca automática ao mudar de projeto, e o último fica sem filtro ──
  await filtrar(ORBIT);
  conferir(await esperar(`document.getElementById('gg-n').textContent === '5'`, 4000), 'mudar de projeto troca o grafo (Orbit, 5 notas)');
  await filtrar('Outro');
  conferir(await esperar(`document.getElementById('gg-n').textContent === '2'`, 4000), 'e volta (Outro, 2 notas)');
  await filtrar('');
  await dormir(300);
  conferir(await av(`document.getElementById('gg-n').textContent === '2' && document.getElementById('gg-sub').textContent.startsWith('Outro')`), 'sem filtro fica o último projeto escolhido', await av(`document.getElementById('gg-sub').textContent`));

  // ── 7. "Abrir no Grafo" leva à aba completa na pasta do brain ──
  await av(`document.getElementById('gg-abrir').click(); true`);
  conferir(await esperar(`!document.getElementById('grafo').hidden && window.GrafoAba._estado().dados && window.GrafoAba._estado().dados.pasta === ${JSON.stringify(COFRE_B)}`, 6000), '"Abrir no Grafo" abre a aba na pasta do brain', await av(`[document.getElementById('grafo').hidden, window.GrafoAba._estado().est.pasta]`));
  conferir(await esperar(`${W}._estado().pausado === true`, 3000), 'com a Home escondida a vista do widget pausa');
  await av(`document.querySelector('.nav-item[data-vista="geral"]').click(), true`);
  await esperar(`!document.getElementById('vista-geral').closest('[hidden]')`, 3000);
  await verCard();
  conferir(await esperar(`${W}._estado().pausado === false`, 3000), 'voltar à Home retoma');

  // ── 8. Modo de edição: segurar no grafo entra; o pan não fica preso; arrastar troca de vaga ──
  await dormir(300);
  const a = await av(`(() => { const r = document.querySelector('#grafo-card .gg-area').getBoundingClientRect(); return [r.left + 10, r.top + 10]; })()`);
  await mouse('mouseMoved', a[0], a[1]); await mouse('mousePressed', a[0], a[1], 'left', 1);
  await dormir(700);
  conferir(await av(`document.getElementById('vista-geral').classList.contains('wd-editando')`), 'segurar no grafo entra no modo de edição');
  await mouse('mouseReleased', a[0], a[1], 'left', 0);
  await av(`document.querySelector('.wd-concluir').click(); true`);
  await dormir(300);
  const pan0 = (await est()).vista;
  await mouse('mouseMoved', a[0] + 60, a[1] + 40); await dormir(100);
  const pan1 = (await est()).vista;
  conferir(pan0.panX === pan1.panX && pan0.panY === pan1.panY, 'depois do modo de edição, mover o mouse não arrasta o grafo', [pan0.panX, pan1.panX]);
  // arrastar o card (pelo cabeçalho) para o topo do "Espaço em disco": entra antes dele, na lateral (grade de 21/10)
  const t = await av(`(() => { const r = document.querySelector('#grafo-card .gf-topo').getBoundingClientRect(); return [r.left + 30, r.top + 10]; })()`);
  await mouse('mouseMoved', t[0], t[1]); await mouse('mousePressed', t[0], t[1], 'left', 1);
  await dormir(650);
  const d = await av(`(() => { const r = document.querySelector('[data-widget="disco"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + 20]; })()`);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', t[0] + (d[0] - t[0]) * i / 8, t[1] + (d[1] - t[1]) * i / 8, 'left', 1); await dormir(30); }
  await mouse('mouseReleased', d[0], d[1], 'left', 0);
  await dormir(600);
  const ordem = await av(`JSON.parse(localStorage.getItem('gi.widgets.grade') || 'null')?.[OrbitGrade.colunas()]`);
  conferir(ordem && ordem.grafo[0] === ordem.disco[0] && ordem.grafo[1] < ordem.disco[1], 'arrastar põe o grafo antes do Espaço em disco, na coluna dele', ordem);
  await av(`document.querySelector('.wd-concluir').click(); true`);
  // ordem das vagas fixas, gravada antes do widget existir: vira layout da grade, com o grafo no lugar de fábrica
  await av(`localStorage.removeItem('gi.widgets.grade'); localStorage.setItem('gi.widgets', JSON.stringify(['ctx', 'estado', 'sinc', 'uso', 'disco'])); true`);
  await cdp('Page.reload'); await dormir(800);
  await esperar(`!!document.getElementById('grafo-card')?._gw`, 10000);
  await esperar(`(() => { const a = document.getElementById('abertura'); return !a || !a.isConnected || a.classList.contains('sai') || getComputedStyle(a).display === 'none'; })()`, 6000);
  await dormir(500);
  const ordem2 = await av(`OrbitGrade.layout().filter((i) => i.k !== 'lista').sort((a, b) => a.x - b.x || a.y - b.y).map((i) => i.k).join()`);
  conferir(ordem2 === 'uso,grafo,ctx,estado,sinc,disco,cena', 'ordem antiga: a troca antiga fica e o grafo entra no lugar de fábrica', ordem2);
  await av(`localStorage.removeItem('gi.widgets.grade'); true`);

  // ── 9. Campo "Brain" no Personalizar projeto ──
  await personalizar('Outro');
  conferir(await av(`(() => { const rots = [...document.querySelectorAll('#pj-pop .pj-rot')].map((r) => r.firstChild.textContent); return rots[1] === 'Brain' && document.querySelector('#pj-pop .pj-brain').textContent === ${JSON.stringify(COFRE_B)} && !document.querySelector('#pj-pop .pj-brain-x').hidden; })()`), 'popover: campo Brain depois do Nome, com a pasta e o x', await av(`document.querySelector('#pj-pop .pj-brain')?.textContent`));
  await foto('5-popover');
  await av(`document.querySelector('#pj-pop .pj-brain').click(); true`);
  await esperar(`!!document.querySelector('.gw-dlg')`, 3000);
  conferir(await av(`!document.getElementById('pj-pop').hidden`), 'o seletor abre por cima sem fechar o popover');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(200);
  conferir(await av(`!document.querySelector('.gw-dlg') && !document.getElementById('pj-pop').hidden`), 'Esc fecha só o seletor');
  await av(`document.querySelector('#pj-pop .pj-brain-x').click(); true`);
  conferir(await esperar(`(async () => ((await (await fetch('/config')).json()).projetos.Outro || {}).brain === '')()`, 3000) && await esperar(`document.getElementById('grafo-card').dataset.estado === 'sem-brain'`, 3000), 'o x desvincula (brain vazio) e o widget volta ao estado vazio');
  conferir(await av(`document.querySelector('#pj-pop .pj-brain').textContent === 'Vincular brain…' && document.querySelector('#pj-pop .pj-brain-x').hidden`), 'popover mostra "Vincular brain…" sem o x');
  await fecharPop();
  // Orbit: desvincular e "Restaurar padrão" volta ao cofre
  await filtrar(ORBIT);
  await personalizar(ORBIT);
  conferir(await av(`document.querySelector('#pj-pop .pj-brain').textContent === ${JSON.stringify(COFRE_A)}`), 'Orbit mostra o cofre como brain de fábrica', await av(`document.querySelector('#pj-pop .pj-brain').textContent`));
  await av(`document.querySelector('#pj-pop .pj-brain-x').click(); true`);
  conferir(await esperar(`document.getElementById('grafo-card').dataset.estado === 'sem-brain'`, 3000), 'desvincular o Orbit vale (sem brain)');
  await av(`document.querySelector('#pj-pop .pj-pe .link').click(); true`);
  conferir(await esperar(`document.getElementById('gg-n').textContent === '5'`, 4000), '"Restaurar padrão" devolve o cofre ao Orbit');
  await fecharPop();

  // ── 10. Pasta que sumiu ──
  await postCfg({ Outro: { brain: path.join(TMP, 'nao-existe') } });
  await filtrar('Outro');
  conferir(await esperar(`document.getElementById('grafo-card').dataset.estado === 'erro' && document.querySelector('#grafo-card .gg-vazio button').textContent === 'Trocar brain'`, 4000), 'brain que não existe: aviso e "Trocar brain"', await av(`document.getElementById('grafo-card').dataset.estado`));

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
  if (consoleErros.length) res.falhas.push('console: ' + JSON.stringify(consoleErros).slice(0, 1500));
} finally {
  clearInterval(manter);
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, EDGE_PERFIL);
  await dormir(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\nGrafo do projeto (widget): ${res.ok.length} ok, ${res.falhas.length} falhas (porta ${PORTA})`);
  for (const f of res.falhas) console.log('  FALHA: ' + f);
  if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
  process.exit(res.falhas.length ? 1 : 0);
}
