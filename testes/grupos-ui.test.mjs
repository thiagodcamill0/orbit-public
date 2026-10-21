// Teste dos grupos de status da lista (16/10): os 7 grupos sempre à vista (vazios discretos, contagem 0,
// recolhidos), arrastar o cabeçalho muda o grupo de lugar (fantasma + encaixe + deslize), Esc cancela, a ordem
// volta no F5, Alt+↑/↓ no chevron move pelo teclado e "⋯ › Voltar à ordem padrão dos grupos" desfaz.
// Servidor de teste numa porta livre (47822–47826) + Edge headless mudo; nunca toca a 47821.
// node testes/grupos-ui.test.mjs <pasta-de-saida>   (~20 s; capturas 01–04 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-grupos-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47823);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes'), FALSO = path.join(SAIDA, 'projeto-falso');
for (const d of [DADOS, PERFIL, SESS, FALSO, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS, FALSO]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const PADRAO = 'precisa,trabalhando,novas,concluidas,revisadas,encerradas';

let srv, pcdp;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const hook = (corpo) => fetch(BASE + '/evento', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cwd: FALSO, ...corpo }) });
  // Uma sessão nova e uma trabalhando: os outros grupos ficam vazios.
  conferir((await hook({ session_id: 'grupos-nova', hook_event_name: 'SessionStart', source: 'startup' })).ok, 'sessão nova entrou');
  await hook({ session_id: 'grupos-trab', hook_event_name: 'SessionStart', source: 'startup' });
  conferir((await hook({ session_id: 'grupos-trab', hook_event_name: 'UserPromptSubmit', prompt: 'Refatorar o módulo de grupos' })).ok, 'sessão trabalhando entrou');

  const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
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
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const foto = async (nome, tela) => {
    if (tela) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); return; }
    const c = await av(`(() => { const r = document.getElementById('lista').getBoundingClientRect(); return { x: r.left - 12, y: Math.max(0, r.top - 12), w: r.width + 24, h: Math.min(r.height + 24, innerHeight - Math.max(0, r.top - 12)) }; })()`);
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const ordem = () => av(`[...document.querySelectorAll('#lista > section.secao')].map((s) => s.dataset.grupo).join()`);
  const cab = (k) => av(`(() => { const s = document.querySelector('#lista > section[data-grupo="${k}"]'); s.scrollIntoView({ block: 'center' }); const r = s.querySelector('.sec-cab h2').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
  // Arrasta o cabeçalho de `k` até o cabeçalho de `ate` (passos curtos, como a mão), parando no meio para olhar.
  async function arrastar(k, ate, meio) {
    const a = await cab(k);
    const b = await av(`(() => { const r = document.querySelector('#lista > section[data-grupo="${ate}"] .sec-cab').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
    await mouse('mousePressed', a.x, a.y);
    const passos = 14;
    for (let i = 1; i <= passos; i++) { await mouse('mouseMoved', a.x, Math.round(a.y + ((b.y - a.y) * i) / passos)); await dormir(16); }
    await dormir(260);
    const visto = meio ? await meio() : null;
    await mouse('mouseReleased', a.x, b.y);
    await dormir(420);
    return visto;
  }

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2200);
  await av(`localStorage.removeItem('gi.ordemGrupos'); localStorage.setItem('gi.agrupar', 'false'); true`);
  await cdp('Page.reload'); await dormir(2200);

  // 1) Os seis grupos de status sempre à vista.
  let o = await ordem();
  conferir(o === PADRAO, 'todos os grupos de status aparecem, na ordem padrão', o);
  const vazios = await av(`[...document.querySelectorAll('#lista > section.secao')].map((s) => ({ k: s.dataset.grupo, vazia: s.classList.contains('vazia'), fechada: s.classList.contains('fechada'), n: s.querySelector('.sec-cab h2 .chip').textContent, chevron: !!s.querySelector('.sec-alt'), linhas: s.querySelectorAll('.linha').length, alt: Math.round(s.getBoundingClientRect().height) }))`);
  const vz = vazios.filter((x) => x.vazia);
  conferir(vz.map((x) => x.k).join() === 'precisa,concluidas,revisadas,encerradas', 'os vazios são os sem sessão', vazios);
  conferir(vz.every((x) => x.n === '0' && x.fechada && !x.chevron && !x.linhas), 'vazio: contagem 0, recolhido, sem chevron', vz);
  conferir(vz.every((x) => x.alt <= 30), 'vazio ocupa só uma linha discreta', vz.map((x) => x.alt));
  conferir(vazios.filter((x) => !x.vazia).every((x) => x.linhas >= 1 && !x.fechada), 'grupos com sessão seguem abertos', vazios);
  conferir(!(await av(`!!document.querySelector('#lista > .nada')`)), 'sem o aviso "Nada precisa de você" duplicando o grupo vazio');
  conferir(await av(`document.getElementById('btn-mais-lista').hidden`), 'sem ordem própria, o "⋯" não oferece voltar à padrão');
  // Clicar num vazio não abre nada.
  let p = await cab('precisa');
  await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y); await dormir(300);
  conferir(await av(`document.querySelector('#lista > section[data-grupo="precisa"]').classList.contains('fechada')`), 'clicar no vazio não o abre');
  await foto('01-padrao');

  // 2) Arrastar "Encerradas" para o topo: fantasma, encaixe e os outros deslizando no meio do caminho.
  const meio = await arrastar('encerradas', 'precisa', () => av(`(() => ({
    fantasma: !!document.querySelector('.grp-fantasma'),
    texto: document.querySelector('.grp-fantasma h2 span')?.textContent,
    encaixe: document.querySelector('#lista .grp-ins.on') ? Math.round(document.querySelector('#lista .grp-ins').getBoundingClientRect().top - document.getElementById('lista').getBoundingClientRect().top) : null,
    origem: getComputedStyle(document.querySelector('#lista > section[data-grupo="encerradas"]')).opacity,
    deslocados: [...document.querySelectorAll('#lista > section.secao')].filter((s) => /translateY\\(\\d/.test(s.style.transform)).map((s) => s.dataset.grupo),
    cursor: document.body.classList.contains('arrastando-grupo'),
  }))()`).then(async (v) => { await foto('02-arrastando', true); return v; }));
  conferir(meio && meio.fantasma && meio.texto === 'Encerradas', 'o fantasma mostra o cabeçalho arrastado', meio);
  conferir(meio && meio.encaixe !== null && meio.encaixe < 20, 'o encaixe marca o topo da lista', meio);
  conferir(meio && meio.origem === '0', 'o grupo arrastado sai do lugar (só o fantasma aparece)', meio);
  conferir(meio && meio.deslocados.length === 5, 'os outros grupos descem para abrir o espaço', meio);
  conferir(meio && meio.cursor, 'cursor de agarrar durante o arraste', meio);
  o = await ordem();
  conferir(o === 'encerradas,precisa,trabalhando,novas,concluidas,revisadas', 'soltar põe o grupo no lugar', o);
  const limpo = await av(`({ f: document.querySelectorAll('.grp-fantasma, .grp-ins').length, t: [...document.querySelectorAll('#lista > section.secao')].filter((s) => s.style.transform).length, enc: document.querySelector('#lista > section[data-grupo="encerradas"]').classList.contains('fechada') })`);
  conferir(limpo.f === 0 && limpo.t === 0, 'nada do arraste fica para trás', limpo);
  conferir(await av(`localStorage.getItem('gi.ordemGrupos')`) === JSON.stringify(o.split(',')), 'a ordem fica gravada');
  await foto('03-movido');

  // 3) Arrastar um grupo aberto não o recolhe (o clique do fim do arraste é engolido).
  await arrastar('trabalhando', 'encerradas');
  o = await ordem();
  conferir(o.startsWith('trabalhando,encerradas'), 'grupo aberto também se arrasta', o);
  conferir(!(await av(`document.querySelector('#lista > section[data-grupo="trabalhando"]').classList.contains('fechada')`)), 'soltar não abre nem fecha o grupo');
  // Clique simples continua recolhendo/abrindo.
  p = await cab('trabalhando');
  await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y); await dormir(400);
  conferir(await av(`document.querySelector('#lista > section[data-grupo="trabalhando"]').classList.contains('fechada')`), 'clique no cabeçalho ainda recolhe');
  p = await cab('trabalhando');
  await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y); await dormir(400);

  // 4) Esc no meio cancela: nada muda e o clique ao soltar não recolhe.
  const antesEsc = await ordem();
  const a = await cab('novas');
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', a.x, a.y - i * 20); await dormir(16); }
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', a.x, a.y - 160); await dormir(400);
  conferir(await ordem() === antesEsc, 'Esc cancela o arraste', await ordem());
  conferir(!(await av(`document.querySelector('#lista > section[data-grupo="novas"]').classList.contains('fechada')`)), 'cancelar não recolhe o grupo');

  // 5) F5: a ordem volta igual.
  const gravada = await ordem();
  await cdp('Page.reload'); await dormir(2200);
  conferir(await ordem() === gravada, 'a ordem escolhida volta depois do F5', await ordem());

  // 6) Teclado: Alt+↓ no chevron de "Trabalhando" desce uma posição.
  await av(`document.querySelector('#lista > section[data-grupo="trabalhando"] .sec-alt').focus(); true`);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 1 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 1 });
  await dormir(400);
  o = await ordem();
  conferir(o.split(',').indexOf('trabalhando') === gravada.split(',').indexOf('trabalhando') + 1, 'Alt+↓ desce o grupo', o);
  conferir(await av(`document.activeElement === document.querySelector('#lista > section[data-grupo="trabalhando"] .sec-alt')`), 'o foco segue no grupo movido');

  // 7) "⋯ › Voltar à ordem padrão dos grupos".
  conferir(!(await av(`document.getElementById('btn-mais-lista').hidden`)), 'com ordem própria, o "⋯" aparece');
  await av(`document.getElementById('btn-mais-lista').click(); true`); await dormir(200);
  const item = await av(`[...document.querySelectorAll('.menu-flut .menu-item')].map((b) => b.textContent)`);
  conferir(item && item.some((t) => t.includes('Voltar à ordem padrão dos grupos')), 'o menu oferece voltar à ordem padrão', item);
  await av(`[...document.querySelectorAll('.menu-flut .menu-item')].find((b) => b.textContent.includes('ordem padrão')).click(); true`);
  await dormir(450);
  conferir(await ordem() === PADRAO, 'voltar à padrão restaura a ordem', await ordem());
  conferir(await av(`localStorage.getItem('gi.ordemGrupos')`) === 'null', 'a ordem gravada volta a ser a padrão');
  conferir(await av(`document.getElementById('btn-mais-lista').hidden`), 'na ordem padrão o item some');
  await foto('04-padrao-de-novo');

  // 8) Filtro: só os grupos com sessão (como antes); agrupar por projeto não muda. (A busca de sessões saiu da lateral em 17/10.)
  await av(`document.getElementById('btn-agrupar').click(); true`); await dormir(400);
  const proj = await av(`[...document.querySelectorAll('#lista > section.secao')].map((s) => s.dataset.grupo)`);
  conferir(proj.length === 1 && proj[0].startsWith('p:') && !(await av(`!!document.querySelector('#lista > section.movel')`)), 'agrupar por projeto segue igual (sem grupos fixos nem arraste)', proj);
  await av(`document.getElementById('btn-agrupar').click(); true`); await dormir(300);

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
