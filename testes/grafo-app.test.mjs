// Aba Grafo no app real (index.html + servidor.mjs de verdade), com cofres falsos e DADOS numa pasta temporária.
// Porta livre de 47822–47826, Edge headless mudo; tudo apagado/fechado no fim (só o servidor que este teste subiu); nunca toca a 47821.
// node testes/grafo-app.test.mjs   (~40 s)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grafo-app-'));
const DADOS = path.join(TMP, 'dados'), PERFIL = path.join(TMP, 'perfil'), SESS = path.join(TMP, 'sessoes'), EDGE_PERFIL = path.join(TMP, 'edge');
const COFRE_A = path.join(TMP, 'cofre-a'), COFRE_B = path.join(TMP, 'cofre-b');
for (const d of [DADOS, PERFIL, SESS, path.join(COFRE_A, 'Sub'), COFRE_B]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config vazia de teste (nunca a do usuário)
// Cofre A: A→B, A→C, B→C, B→Falta (inexistente), Sub/D→A, E órfã.  Cofre B: P→Q.
const NOTAS = { 'A.md': '# Alfa\nVeja [[B]] e [[C]].\n', 'B.md': 'Beta liga em [[C]] e em [[Falta]].\n', 'C.md': 'Gama sem links.\n', 'Sub/D.md': 'Delta aponta para [[A]].\n', 'E.md': 'Órfã.\n' };
for (const [n, t] of Object.entries(NOTAS)) fs.writeFileSync(path.join(COFRE_A, n), t);
fs.writeFileSync(path.join(COFRE_B, 'P.md'), 'Pê liga em [[Q]].\n');
fs.writeFileSync(path.join(COFRE_B, 'Q.md'), 'Quê.\n');
fs.writeFileSync(path.join(TMP, 'segredo.txt'), 'fora do cofre');
const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

let srv, pcdp, ws;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL, ORBIT_COFRE: COFRE_A },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

  // ── API direta ──
  const j = async (u) => { const r = await fetch(BASE + u); let b = null; try { b = await r.json(); } catch {} return { st: r.status, b }; };
  let g = await j('/grafo/dados?pasta=' + encodeURIComponent(COFRE_A));
  const ids = (g.b?.nos || []).map((n) => n.id).sort();
  conferir(g.st === 200 && JSON.stringify(ids) === JSON.stringify(['A.md', 'B.md', 'C.md', 'E.md', 'Falta', 'Sub/D.md']), 'GET /grafo/dados lista as notas do cofre falso e o link inexistente', ids);
  const par = (g.b?.links || []).map((l) => l.origem + '>' + l.destino).sort();
  conferir(JSON.stringify(par) === JSON.stringify(['A.md>B.md', 'A.md>C.md', 'B.md>C.md', 'B.md>Falta', 'Sub/D.md>A.md']), 'GET /grafo/dados traz os links resolvidos', par);
  g = await j('/grafo/dados');
  conferir(g.st === 200 && g.b?.nos?.length === 6, 'sem pasta usa o cofre (ORBIT_COFRE)', g.st);
  g = await j('/grafo/dados?pasta=' + encodeURIComponent(path.join(TMP, 'nao-existe')));
  conferir(g.st === 404, 'pasta inexistente devolve 404', g.st);
  g = await j('/grafo/nota?pasta=' + encodeURIComponent(COFRE_A) + '&id=' + encodeURIComponent('Sub/D.md'));
  conferir(g.st === 200 && g.b?.texto === NOTAS['Sub/D.md'], 'GET /grafo/nota devolve o texto da nota', g.b);
  g = await j('/grafo/nota?pasta=' + encodeURIComponent(COFRE_A) + '&id=' + encodeURIComponent('../segredo.txt'));
  conferir(g.st === 403, 'GET /grafo/nota fora da pasta devolve 403', g.st);
  g = await j('/grafo/nota?pasta=' + encodeURIComponent(COFRE_A) + '&id=' + encodeURIComponent(path.join(TMP, 'segredo.txt')));
  conferir(g.st === 403, 'GET /grafo/nota com caminho absoluto fora da pasta devolve 403', g.st);
  g = await j('/grafo/nota?pasta=' + encodeURIComponent(COFRE_A) + '&id=' + encodeURIComponent('Nada.md'));
  conferir(g.st === 404, 'GET /grafo/nota de nota que não existe devolve 404', g.st);

  // ── Edge ──
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${EDGE_PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
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
  const esperar = async (expr, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(50); } return false; };
  const mouse = (type, x, y, button = 'none', buttons = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const manter = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1000);
  const gi = () => av(`JSON.parse(localStorage.getItem('gi.grafo') || '{}')`);
  const V = `GrafoAba._estado().vista`;
  const pronto = (n) => esperar(`window.GrafoAba && ${V} && (${V}._estado().n === ${n}) && ${V}._estado().criados === ${n}`, 8000);
  const recarregar = async () => { await cdp('Page.reload'); await dormir(1000); await esperar(`document.readyState === 'complete'`, 8000); };
  const abaVisivel = () => av(`!document.getElementById('grafo').hidden && !!document.querySelector('#grafo canvas')`);
  const rolar = async (delta) => { const c = await av(`(() => { const r = document.querySelector('#grafo .gv-area').getBoundingClientRect(); return [r.left + r.width / 2 - 100, r.top + r.height / 2]; })()`); await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c[0], y: c[1], deltaX: 0, deltaY: delta }); await dormir(60); };
  // clique no fundo/nó, em coordenadas de tela, a partir de posições da vista
  const noTela = (id) => av(`(() => { const r = document.querySelector('#grafo canvas').getBoundingClientRect(); const n = ${V}._no(${JSON.stringify(id)}); return n && [r.left + n.sx, r.top + n.sy]; })()`);
  const trocarPasta = async (caminho) => {
    await av(`document.querySelector('#grafo .gv-barra .gb-pasta-btn').click(); true`);
    await esperar(`!!document.querySelector('.gv-dlg')`, 3000);
    if (caminho === '') await av(`[...document.querySelectorAll('.gv-dlg .gv-btn')].find((b) => b.textContent === 'Cofre padrão').click(); true`);
    else {
      await esperar(`document.querySelectorAll('.gv-dlg .gv-pastas button').length > 0`, 4000);
      await av(`(() => { const c = document.querySelector('.gv-dlg .gv-campo'); c.value = ${JSON.stringify(caminho)}; c.dispatchEvent(new Event('input')); [...document.querySelectorAll('.gv-dlg .gv-btn')].find((b) => b.textContent === 'Usar esta pasta').click(); return true; })()`);
    }
    await esperar(`!document.querySelector('.gv-dlg')`, 3000);
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`!!document.querySelector('[data-lat="grafo"]')`, 8000);
  await dormir(800);
  await av(`sessionStorage.clear(); localStorage.removeItem('gi.grafo'); true`);

  // ── 1. Aba na lateral, grupo Conhecimento ──
  conferir(await av(`(() => { const b = document.querySelector('[data-lat="grafo"]'); const g = b && b.closest('section.lat-grupo'); return !!g && g.dataset.grupo === 'conhecimento' && b.textContent.includes('Grafo') && !!b.querySelector('svg'); })()`), 'aba Grafo está no grupo Conhecimento da lateral');
  await av(`document.querySelector('[data-lat="grafo"]').click(); true`);
  conferir(await pronto(6), 'clicar abre a aba e carrega o cofre falso (6 itens)', await av(`window.GrafoAba ? ${V}._estado() : null`));
  conferir(await abaVisivel(), 'seção Grafo visível com o canvas');
  conferir(await av(`document.querySelector('#grafo .gv-pasta').textContent.includes('cofre-a') && document.querySelector('#grafo .gv-aviso').textContent.includes('5 notas')`), 'barra mostra a pasta do cofre e a contagem');
  conferir(await av(`document.querySelector('#grafo .gv-seg button[aria-pressed="true"]').textContent === 'Global'`), 'abre no modo Global');

  // ── 2. Prévia ao clicar ──
  conferir(await esperar(`${V}._estado().alphaFisica < 0.001`, 8000), 'física assenta no app');
  const pos = await noTela('B.md');
  await mouse('mouseMoved', pos[0], pos[1]); await mouse('mousePressed', pos[0], pos[1], 'left', 1); await mouse('mouseReleased', pos[0], pos[1], 'left', 0);
  conferir(await esperar(`!document.querySelector('#grafo .gv-prev').hidden && document.querySelector('#grafo .gv-prev pre').textContent === ${JSON.stringify(NOTAS['B.md'])}`, 4000), 'clicar num nó abre a prévia com o texto da nota', await av(`document.querySelector('#grafo .gv-prev').textContent`));
  conferir((await av(`document.querySelector('#grafo .gv-prev header b').textContent`)) === 'B', 'prévia mostra o nome da nota');
  await av(`[...document.querySelectorAll('#grafo .gv-prev .gv-btn')].find((b) => b.textContent === 'Fechar').click(); true`);
  conferir(await av(`document.querySelector('#grafo .gv-prev').hidden`), 'botão Fechar esconde a prévia');
  await dormir(600); // o fechamento da prévia redimensiona a vista
  await esperar(`${V}._estado().alphaFisica < 0.001`, 4000);
  // nó inexistente não abre prévia
  const posF = await noTela('Falta');
  await mouse('mouseMoved', posF[0], posF[1]); await mouse('mousePressed', posF[0], posF[1], 'left', 1); await mouse('mouseReleased', posF[0], posF[1], 'left', 0);
  await dormir(300);
  conferir(await av(`document.querySelector('#grafo .gv-prev').hidden && document.querySelector('#grafo .gv-aviso').textContent.includes('não existe')`), 'clicar num link inexistente avisa e não abre prévia');

  // ── 3. Opções por pasta persistem ──
  await av(`document.querySelector('#grafo .gp-eng').click(); true`);
  await av(`[...document.querySelectorAll('#grafo .gp-sec')].find((b) => b.textContent.trim() === 'Exibição').click(); true`);
  await av(`[...document.querySelectorAll('#grafo .gp-lin')].find((l) => l.querySelector('.gp-rot')?.textContent === 'Setas').querySelector('button').click(); true`);
  await av(`(() => { const l = [...document.querySelectorAll('#grafo .gp-lin')].find((l) => l.querySelector('.gp-rot')?.textContent === 'Tamanho do nó'); const s = l.querySelector('input'); s.value = 2; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  conferir(await av(`${V}.opcoes().setas === true && ${V}.opcoes().tamanhoNo === 2`), 'o painel altera as opções da vista');
  await dormir(400);
  let st = await gi();
  conferir(st.opcoes && st.opcoes[COFRE_A]?.setas === true && st.opcoes[COFRE_A]?.tamanhoNo === 2, 'opções gravadas em gi.grafo por pasta (~100 ms)', st.opcoes);

  // ── 4. Escala salva por pasta (2 s, ao sair da aba, ao trocar de pasta) e restaurada ──
  await rolar(-120); await rolar(-120);
  const z1 = await av(`${V}.escala()`);
  conferir(z1 > 1.5 || z1 < 0.9 || z1 !== 1, 'a roda muda a escala da vista', z1);
  conferir(await esperar(`(JSON.parse(localStorage.getItem('gi.grafo')).escalas || {})[${JSON.stringify(COFRE_A)}] !== undefined && Math.abs(JSON.parse(localStorage.getItem('gi.grafo')).escalas[${JSON.stringify(COFRE_A)}] - ${V}.escala()) < 1e-6`, 4500), 'a escala é gravada sozinha em gi.grafo.escalas (a cada 2 s)', await gi());
  await rolar(-120);
  const z2 = await av(`${V}.escala()`);
  await av(`document.querySelector('[data-lat="geral"]').click(); true`); // sair da aba grava na hora
  await esperar(`document.getElementById('grafo').hidden || document.getElementById('grafo').getBoundingClientRect().width === 0`, 3000);
  await esperar(`Math.abs((JSON.parse(localStorage.getItem('gi.grafo')).escalas || {})[${JSON.stringify(COFRE_A)}] - ${z2}) < 1e-6`, 1500);
  st = await gi();
  conferir(perto(st.escalas?.[COFRE_A], z2, 1e-6) && z2 !== z1, 'sair da aba grava a escala imediatamente', { z1, z2, escalas: st.escalas });
  await av(`document.querySelector('[data-lat="grafo"]').click(); true`);
  await esperar(`${V}._estado().n === 6`, 5000);
  // recarregar: a escala volta
  await recarregar();
  conferir(await pronto(6), 'recarregar volta com o grafo carregado', await av(`window.GrafoAba ? ${V}._estado() : null`));
  conferir(await abaVisivel(), 'recarregar volta na aba Grafo (restauração da tela)');
  const zr = await av(`${V}.escala()`);
  conferir(perto(zr, z2, z2 * 0.01), 'recarregar restaura a escala salva', { salvo: z2, depois: zr });
  conferir(await av(`${V}.opcoes().setas === true && ${V}.opcoes().tamanhoNo === 2`), 'recarregar restaura as opções da pasta (setas, tamanho do nó)', await av(`${V}.opcoes()`));
  conferir(await av(`document.querySelector('#grafo .gp-chave[aria-checked="true"]') !== null && [...document.querySelectorAll('#grafo .gp-lin')].find((l) => l.querySelector('.gp-rot')?.textContent === 'Setas').querySelector('button').getAttribute('aria-checked') === 'true'`), 'o painel reflete as opções salvas');

  // ── 5. Trocar de pasta salva a escala da anterior e usa opções/escala próprias ──
  await rolar(-120);
  const z3 = await av(`${V}.escala()`);
  await trocarPasta(COFRE_B);
  conferir(await pronto(2), 'escolher outra pasta pelo seletor carrega o outro cofre (2 itens)', await av(`${V}._estado()`));
  st = await gi();
  conferir(st.pasta === COFRE_B && perto(st.escalas?.[COFRE_A], z3, 1e-6), 'trocar de pasta grava a escala da pasta anterior e a pasta nova', { pasta: st.pasta, escalas: st.escalas, z3 });
  conferir(await av(`${V}.opcoes().setas === false`), 'a outra pasta começa com as opções padrão');
  conferir(perto(await av(`${V}.escala()`), 1, 1e-6), 'a outra pasta começa na escala 1', await av(`${V}.escala()`));
  await trocarPasta('');
  conferir(await pronto(6), 'Cofre padrão volta ao cofre original', await av(`${V}._estado()`));
  conferir(await av(`${V}.opcoes().setas === true`) && perto(await av(`${V}.escala()`), z3, z3 * 0.01), 'voltar à pasta restaura opções e escala dela', { z3, escala: await av(`${V}.escala()`) });

  // ── 6. Modo local ──
  await av(`[...document.querySelectorAll('#grafo .gv-seg button')].find((b) => b.textContent === 'Local').click(); true`);
  conferir(await av(`!document.querySelector('#grafo .gv-nota input').disabled && !!document.querySelector('#grafo .gv-seg button[aria-pressed="true"]') && document.querySelector('#grafo .gv-seg button[aria-pressed="true"]').textContent === 'Local'`), 'botão Local ativa o modo local e o campo da nota');
  conferir(await av(`${V}._estado().n === 0 && document.querySelector('#grafo .gv-aviso').textContent.includes('Escolha uma nota')`), 'sem nota escolhida o grafo local fica vazio com aviso');
  await av(`document.querySelector('#grafo .gv-nota input').focus(); true`);
  conferir(await esperar(`document.querySelectorAll('#grafo .gv-lista button').length === 5`, 3000), 'o campo lista as 5 notas da pasta', await av(`document.querySelectorAll('#grafo .gv-lista button').length`));
  await av(`(() => { const c = document.querySelector('#grafo .gv-nota input'); c.value = 'alfa'; c.dispatchEvent(new Event('input')); return true; })()`);
  await av(`(() => { const c = document.querySelector('#grafo .gv-nota input'); c.value = 'A'; c.dispatchEvent(new Event('input')); return true; })()`);
  await esperar(`[...document.querySelectorAll('#grafo .gv-lista button')].some((b) => b.textContent === 'A')`, 2000);
  await av(`[...document.querySelectorAll('#grafo .gv-lista button')].find((b) => b.textContent === 'A').click(); true`);
  // vizinhança de A a 1 salto: A, B, C (saída) e Sub/D (entrada)
  conferir(await esperar(`${V}._estado().n === 4`, 4000), 'grafo local da nota A (1 salto) tem A, B, C e D', await av(`${V}._estado()`));
  conferir(await av(`!!(window.GrafoAba._estado().est.modo === 'local') && window.GrafoAba._estado().est.nota === 'A.md'`), 'o estado guarda o modo local e a nota');
  conferir(await av(`[...document.querySelectorAll('#grafo .gp-sec')].some((b) => b.textContent.trim() === 'Grafo local') && !!([...document.querySelectorAll('#grafo .gp-lin')].find((l) => l.querySelector('.gp-rot')?.textContent === 'Saltos'))`), 'no modo local o painel mostra Saltos (só no local)');
  await av(`(() => { const l = [...document.querySelectorAll('#grafo .gp-lin')].find((l) => l.querySelector('.gp-rot')?.textContent === 'Saltos'); const s = l.querySelector('input'); s.value = 2; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  conferir(await esperar(`${V}._estado().n === 5`, 4000), '2 saltos acrescentam o link inexistente (5 nós)', await av(`${V}._estado()`));
  await dormir(300);
  await av(`(() => { const l = [...document.querySelectorAll('#grafo .gp-lin')].find((l) => l.querySelector('.gp-rot')?.textContent === 'Links de entrada'); l.querySelector('button').click(); return true; })()`);
  conferir(await esperar(`${V}._estado().n === 4`, 4000), 'desligar links de entrada tira a nota D', await av(`${V}._estado()`));
  await dormir(400);
  await recarregar();
  conferir(await pronto(4), 'recarregar volta no modo local com a mesma nota e opções', await av(`window.GrafoAba ? ({ ...${V}._estado(), modo: GrafoAba._estado().est.modo }) : null`));
  conferir(await av(`${V}.opcoes().local.profundidade === 2 && ${V}.opcoes().local.entrada === false && ${V}.opcoes().setas === true`), 'as opções do local persistem após recarregar', await av(`${V}.opcoes()`));
  await av(`[...document.querySelectorAll('#grafo .gv-seg button')].find((b) => b.textContent === 'Global').click(); true`);
  conferir(await pronto(6) && await av(`![...document.querySelectorAll('#grafo .gp-lin')].some((l) => l.querySelector('.gp-rot')?.textContent === 'Saltos')`), 'voltar ao Global mostra tudo e esconde Saltos');

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  clearInterval(manter);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, EDGE_PERFIL);
  await dormir(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\nGrafo app: ${res.ok.length} ok, ${res.falhas.length} falhas (porta ${PORTA})`);
  for (const f of res.falhas) console.log('  FALHA: ' + f);
  if (process.env.VERBOSO) for (const o of res.ok) console.log('  ok: ' + o);
  process.exit(res.falhas.length ? 1 : 0);
}
