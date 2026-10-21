// Teste dos grupos da lateral (17/10): Principal, Ferramentas, Conhecimento, Projetos e Sistema; sem a busca de
// sessões e sem o fio da logo; recolher grava e volta no F5; arrastar item (no grupo e entre grupos) e grupo, com
// fantasma e deslize; Esc cancela; Alt+↑/↓ pelo teclado; o clique que fecha o arraste não abre nada.
// Servidor de teste numa porta livre (47822–47826) + Edge headless mudo; nunca toca a 47821.
// node testes/lateral-ui.test.mjs <pasta-de-saida>   (~15 s; capturas 01–04 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-lateral-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes');
for (const d of [DADOS, PERFIL, SESS, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

let srv, pcdp;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

  const EDGE = caminhoNavegador();
  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${path.join(SAIDA, 'edge')}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const foto = async (nome) => {
    const c = await av(`(() => { const r = document.getElementById('lateral').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, innerHeight) }; })()`);
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const tecla = (key, code, mod = 0) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: { ArrowUp: 38, ArrowDown: 40, Escape: 27 }[key], modifiers: mod })
    .then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mod }));
  const ordem = () => av(`[...document.querySelectorAll('#lat-grupos > .lat-grupo')].map((g) => g.dataset.grupo + ':' + [...g.querySelectorAll('.nav-item[data-lat]:not([hidden])')].map((b) => b.dataset.lat).join('|')).join(' ')`);
  const ponto = (sel) => av(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
  // Arrasta de `de` até `ate` (pontos), em passos curtos, olhando no meio do caminho.
  async function arrastar(a, b, meio) {
    await mouse('mousePressed', a.x, a.y);
    const passos = 12;
    for (let i = 1; i <= passos; i++) { await mouse('mouseMoved', a.x, Math.round(a.y + ((b.y - a.y) * i) / passos)); await dormir(16); }
    await dormir(240);
    const visto = meio ? await meio() : null;
    await mouse('mouseReleased', a.x, b.y);
    await dormir(320);
    return visto;
  }
  const PADRAO = 'principal:geral|historico|office ferramentas:terminal|navegador|repos conhecimento:ideias|skills projetos: sistema:config';

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2000);
  await av(`localStorage.removeItem('gi.lat.ordem'); localStorage.removeItem('gi.lat.recolhidos'); localStorage.setItem('gi.lateral', 'false'); true`);
  await cdp('Page.reload'); await dormir(2000);

  // 1) Estrutura: grupos por função, sem a busca e sem o fio da logo; logo 10% maior.
  conferir((await ordem()).replace('|instalar', '') === PADRAO, 'grupos e itens na ordem de fábrica', await ordem());
  conferir(await av(`[...document.querySelectorAll('.lat-tit')].map((t) => t.textContent).join()`) === 'Principal,Ferramentas,Conhecimento,Projetos,Sistema', 'títulos dos grupos');
  conferir(await av(`!document.getElementById('busca') && !document.querySelector('.lateral .busca') && !document.querySelector('.fio-logo')`), 'sem "Buscar sessões" e sem a linha abaixo da logo');
  const logo = await av(`Math.round(document.querySelector('.lateral .logo-img').getBoundingClientRect().width * 10) / 10`);
  conferir(Math.abs(logo - 72) < .6, 'logo da lateral com 72 px (20/10)', logo);
  const al = await av(`(() => { const d = (el) => Math.round(el.closest('.nav-item, .lat-cab').getBoundingClientRect().right - el.getBoundingClientRect().right);
    document.querySelector('[data-ideias-n]').textContent = '7'; return { ideias: d(document.querySelector('[data-ideias-n]')), fs: getComputedStyle(document.querySelector('[data-ideias-n]')).fontSize }; })()`);
  conferir(al.ideias === 12 && al.fs === '11.5px', 'contador de Ideias discreto e alinhado à direita', al);
  await foto('01-padrao');

  // 2) Recolher Ferramentas: some do Tab, a seta gira, grava e volta no F5.
  const pf = await ponto('.lat-grupo[data-grupo="ferramentas"] .lat-alt');
  await mouse('mousePressed', pf.x, pf.y); await mouse('mouseReleased', pf.x, pf.y); await dormir(400);
  const rc = await av(`(() => { const g = document.querySelector('.lat-grupo[data-grupo="ferramentas"]'); return { rec: g.classList.contains('recolhido'), exp: g.querySelector('.lat-alt').getAttribute('aria-expanded'), alt: Math.round(g.querySelector('.lat-corpo').getBoundingClientRect().height), vis: getComputedStyle(g.querySelector('.lat-dentro')).visibility, gravado: localStorage.getItem('gi.lat.recolhidos') }; })()`);
  conferir(rc.rec && rc.exp === 'false' && rc.alt === 0 && rc.vis === 'hidden' && rc.gravado === '{"ferramentas":true}', 'clicar no título recolhe o grupo e grava', rc);
  await foto('02-recolhido');
  await cdp('Page.reload'); await dormir(2000);
  conferir(await av(`document.querySelector('.lat-grupo[data-grupo="ferramentas"]').classList.contains('recolhido')`), 'o grupo recolhido volta assim no F5');
  const pf2 = await ponto('.lat-grupo[data-grupo="ferramentas"] .lat-alt');
  await mouse('mousePressed', pf2.x, pf2.y); await mouse('mouseReleased', pf2.x, pf2.y); await dormir(400);
  conferir(await av(`!document.querySelector('.lat-grupo[data-grupo="ferramentas"]').classList.contains('recolhido') && localStorage.getItem('gi.lat.recolhidos') === '{}'`), 'clicar de novo abre');

  // 3) Arrastar "Visão de Office" para cima de "Visão geral": fantasma e lugar marcado; não abre o Office.
  const meio = await arrastar(await ponto('.nav-item[data-lat="office"]'), await ponto('.nav-item[data-lat="geral"]'), () => av(`({
    fantasma: document.querySelector('.lat-fantasma')?.textContent, arrastando: document.getElementById('lat-grupos').classList.contains('arrastando'),
    lugar: !!document.querySelector('.nav-item.lat-arrastado[data-lat="office"]') })`));
  conferir(meio && /Visão de Office/.test(meio.fantasma || '') && meio.arrastando && meio.lugar, 'no meio do arraste: fantasma com o item e o lugar marcado', meio);
  conferir((await ordem()).startsWith('principal:office|geral|historico'), 'soltar reordena dentro do grupo', await ordem());
  conferir(await av(`!document.querySelector('.lat-fantasma') && !document.querySelector('.lat-arrastado')`), 'fantasma e marca somem ao soltar');
  conferir(await av(`document.querySelector('.nav-item[data-vista="geral"]').getAttribute('aria-current') === 'page'`), 'o clique que fecha o arraste não abre o Office');

  // 4) Item entre grupos: Skills para Principal (entre Office e Visão geral).
  await arrastar(await ponto('.nav-item[data-lat="skills"]'), await ponto('.nav-item[data-lat="geral"]'));
  conferir((await ordem()).includes('principal:office|skills|geral') && (await ordem()).includes('conhecimento:ideias '), 'item muda de grupo', await ordem());
  // 5) Grupo: Sistema para o topo.
  await arrastar(await ponto('.lat-grupo[data-grupo="sistema"] .lat-alt'), await ponto('.lat-grupo[data-grupo="principal"] .lat-alt'));
  conferir((await ordem()).startsWith('sistema:'), 'grupo arrastado para o topo', await ordem());
  conferir(await av(`!document.querySelector('.lat-grupo[data-grupo="sistema"]').classList.contains('recolhido')`), 'arrastar o título não recolhe o grupo');
  await foto('03-reordenado');
  // 6) Esc cancela no meio do arraste.
  const antes = await ordem();
  const a = await ponto('.nav-item[data-lat="repos"]'), b = await ponto('.nav-item[data-lat="terminal"]');
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', a.x, Math.round(a.y + ((b.y - a.y) * i) / 8)); await dormir(16); }
  await tecla('Escape', 'Escape'); await dormir(100);
  await mouse('mouseReleased', a.x, b.y); await dormir(300);
  conferir(await ordem() === antes && !(await av(`!!document.querySelector('.lat-fantasma')`)), 'Esc cancela o arraste', await ordem());
  // 7) A ordem volta no F5.
  await cdp('Page.reload'); await dormir(2000);
  conferir(await ordem() === antes, 'a ordem volta no F5', await ordem());
  // 8) Teclado: Alt+↓ no item e Alt+↑ no título.
  await av(`document.querySelector('.nav-item[data-lat="terminal"]').focus(); true`);
  await tecla('ArrowDown', 'ArrowDown', 1); await dormir(250);
  conferir((await ordem()).includes('ferramentas:navegador|terminal|repos'), 'Alt+↓ desce o item', await ordem());
  conferir(await av(`document.activeElement === document.querySelector('.nav-item[data-lat="terminal"]')`), 'o foco segue no item movido');
  await av(`document.querySelector('.lat-grupo[data-grupo="projetos"] .lat-alt').focus(); true`);
  await tecla('ArrowUp', 'ArrowUp', 1); await dormir(250);
  const og = await av(`[...document.querySelectorAll('#lat-grupos > .lat-grupo')].map((g) => g.dataset.grupo).join()`);
  conferir(og === 'sistema,principal,ferramentas,projetos,conhecimento', 'Alt+↑ sobe o grupo', og);
  await foto('04-teclado');

  // 9) Barra recolhida (só ícones): todos os itens à vista, mesmo com grupo recolhido; faixa estreita mostra os projetos.
  await av(`document.querySelector('.lat-grupo[data-grupo="principal"] .lat-alt').click(); document.getElementById('recolher').click(); true`); await dormir(400);
  conferir(await av(`getComputedStyle(document.querySelector('.lat-grupo[data-grupo="principal"] .lat-dentro')).visibility === 'visible' && document.querySelector('.nav-item[data-lat="geral"]').getBoundingClientRect().height > 30`), 'barra só com ícones: grupo recolhido aparece aberto');
  await av(`document.getElementById('recolher').click(); true`); await dormir(300);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false }); await dormir(400);
  conferir(await av(`getComputedStyle(document.getElementById('projetos')).display !== 'none' && getComputedStyle(document.querySelector('.lat-grupo')).display === 'contents'`), 'faixa estreita: os invólucros saem do caminho');

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge'));
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
