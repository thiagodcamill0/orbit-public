// Rodada 9 (abas e painéis), na página de verdade: servidor de teste (47822–47826) com o claude-falso + Edge headless.
// Rodar:  node testes/abas-integracao.test.mjs [pasta-das-capturas]
// Confere: a Visão geral nasce como aba; a lateral abre Histórico, Office e Repositórios em abas (o cabeçalho segue
// a vista); a árvore abre arquivo em prévia (itálico), troca a prévia e fixa no duplo clique; duplo clique e Enter na
// lista abrem a conversa no painel de detalhe, nunca numa aba; dividir à direita deixa arquivo e Visão geral lado a lado;
// F5 restaura abas e painéis e leva uma aba de conversa antiga para o painel; ?abas=0 volta à página de antes; 420 px
// sem rolagem horizontal; 0 erros de console. Fecha o Edge, desliga o servidor e apaga os dados.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.join(os.tmpdir(), 'gerenciador-testes', `abas-int-${Date.now()}`);
const DADOS = path.join(BASE, 'dados');
const PERFIL = path.join(BASE, 'edge');
const PASTA = path.join(BASE, 'projeto-abas');
const SAIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
for (const d of [DADOS, path.join(DADOS, 'sessoes'), path.join(DADOS, 'projetos'), PERFIL, path.join(PASTA, 'src')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PASTA, 'LEIAME.md'), '# Projeto de teste\n\nUma linha.\n');
fs.writeFileSync(path.join(PASTA, 'src', 'app.js'), Array.from({ length: 80 }, (_, i) => `const linha${i + 1} = ${i + 1};`).join('\n') + '\n');
fs.writeFileSync(path.join(PASTA, 'src', 'estilo.css'), 'body { margin: 0; }\n');
if (SAIDA) fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTA = await escolherPorta(47825);
const URL_BASE = `http://127.0.0.1:${PORTA}`;
const saude = async () => { try { return await (await fetch(URL_BASE + '/saude')).json(); } catch { return null; } };
const post = (rota, corpo) => fetch(URL_BASE + rota, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo) });

const env = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_MODELOS_INICIO: '300',
  ORBIT_PASTAS_TEMP: path.join(BASE, 'nenhuma-temp'), // a pasta do projeto (em %TEMP%) pode entrar na lista
  FALSO_LOG: path.join(DADOS, 'falso.log'),
};
delete env.GERENCIADOR_REINICIOS;
delete env.CLAUDECODE;

let pcdp = 0, srv = null, ok = 0, falhas = 0;
const conferir = (cond, rotulo, extra) => { if (cond) ok++; else falhas++; console.log(`${cond ? 'ok   ' : 'FALHA'} ${rotulo}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : ''}`); };

try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], { env, stdio: 'ignore' });
  let s0 = null;
  for (let i = 0; i < 60 && !(s0 && s0.pid === srv.pid); i++) { await dormir(150); s0 = await saude(); }
  if (!s0 || s0.pid !== srv.pid) throw new Error('o servidor do teste não subiu');
  for (let i = 0; i < 40; i++) { const r = await fetch(URL_BASE + '/modelos'); if (r.ok) break; await dormir(250); }
  const rp = await post('/projetos/adicionar', { pasta: PASTA });
  conferir(rp.status === 201 || rp.status === 200, 'projeto de teste na lista', rp.status);
  const ids = [];
  for (const nomeI of ['Conversa A', 'Conversa B']) {
    const r = await post('/instancias', { pasta: PASTA, nome: nomeI, texto: 'Olá de ' + nomeI });
    const j = await r.json().catch(() => ({}));
    ids.push(j.sessao);
  }
  conferir(ids.every(Boolean), 'duas instâncias do Orbit criadas', ids);
  for (let i = 0; i < 60; i++) {
    const ss = (await (await fetch(URL_BASE + '/estado')).json()).sessoes.filter((x) => ids.includes(x.id));
    if (ss.length === 2 && ss.every((s) => s.controle && !s.controle.ocupada && s.controle.processo !== 'iniciando')) break;
    await dormir(250);
  }

  const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9450 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pend = new Map();
  const erros = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Runtime.exceptionThrown') erros.push(j.params.exceptionDetails?.exception?.description || 'exceção');
    if (j.method === 'Runtime.consoleAPICalled' && (j.params.type === 'error' || j.params.type === 'warning')) erros.push(j.params.type + ': ' + j.params.args.map((x) => x.value ?? x.description).join(' '));
    if (j.method === 'Log.entryAdded' && j.params.entry.level === 'error' && !/\/modelos/.test(j.params.entry.url || '')) erros.push('log: ' + j.params.entry.text + ' ' + (j.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  const ate = async (expr, ms = 6000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = await av(expr); if (v) return v; await dormir(120); } return null; };
  const centro = (sel) => av(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clicar = async (sel, n = 1) => {
    const c = await centro(sel);
    if (!c) throw new Error('sem alvo para clicar: ' + sel);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    for (let i = 1; i <= n; i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: i });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: i });
    }
    await dormir(150);
  };
  // Linha da lista: clica perto do começo (no meio há botões, como "Abrir a conversa").
  const clicarLinha = async (id, n = 1) => {
    const c = await av(`(() => { const e = document.querySelector('#lista [data-id="${id}"]'); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + 40, y: r.y + Math.min(18, r.height / 2) }; })()`);
    if (!c) throw new Error('sem a linha ' + id);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    for (let i = 1; i <= n; i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: i });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: i });
    }
    await dormir(200);
  };
  const tecla = async (key, code, vk, mod = 0) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers: mod });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: mod });
    await dormir(150);
  };
  const foto = async (nome) => {
    if (!SAIDA) return;
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const abas = () => av(`window.Abas.abas().map((a) => ({ id: a.id, chave: a.chave, previa: !!a.previa, vis: window.Abas.visivel(a.id) }))`);
  const nGrupos = () => av(`document.querySelectorAll('#abas-raiz .abas-grupo').length`);
  const aba = (chave) => `document.querySelector('#abas-raiz .aba[data-chave=${JSON.stringify(JSON.stringify(chave)).slice(1, -1)}]')`;

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: URL_BASE + '/' });
  await ate(`document.readyState === 'complete' && !!window.Abas`);
  await dormir(900);

  // ───── Partida ─────
  conferir(await av(`document.getElementById('rolar').classList.contains('com-abas')`), 'a área principal está no modo abas');
  let l = await abas();
  conferir(l.length === 1 && l[0].chave === 'vista:geral' && l[0].vis, 'a Visão geral nasce como a única aba', l);
  conferir(await ate(`document.querySelectorAll('#lista [data-id]').length >= 2`), 'a lista de sessões aparece dentro da aba');
  conferir(await av(`document.querySelector('.nav-item[data-vista="geral"]').getAttribute('aria-current') === 'page'`), 'a lateral acende a Visão geral');

  // ───── Telas pela lateral ─────
  await clicar(`document.querySelector('.nav-item[data-vista="historico"]')`);
  l = await abas();
  conferir(l.length === 2 && l.find((a) => a.chave === 'vista:historico')?.vis, 'Histórico abre numa aba nova', l);
  conferir(await av(`!!document.querySelector('.cont-hist #h1') && document.getElementById('h1').textContent === 'Histórico de avisos'`), 'o cabeçalho foi para o Histórico');
  conferir(await av(`document.querySelector('.nav-item[data-vista="historico"]').getAttribute('aria-current') === 'page'`), 'a lateral acende o Histórico');
  await clicar(`document.querySelector('.nav-item[data-vista="office"]')`);
  conferir(await ate(`!!document.querySelector('.aba-painel:not([hidden]) #office') && document.getElementById('office').childElementCount > 0`, 8000), 'Visão de Office abre numa aba e monta',
    await av(`({ abas: window.Abas.abas().map((a) => a.chave + (window.Abas.visivel(a.id) ? '*' : '')), pai: document.getElementById('office').parentElement?.className, filhos: document.getElementById('office').childElementCount, hid: document.getElementById('office').hidden })`));
  await clicar(`document.querySelector('.nav-item[data-vista="geral"]')`);
  l = await abas();
  conferir(l.length === 3 && l.find((a) => a.chave === 'vista:geral').vis, 'voltar à Visão geral ativa a aba que já existe (sem duplicar)', l);
  conferir(await av(`!!document.querySelector('#rolar .conteudo:not(.cont-hist) > .cab-pagina #h1') && document.getElementById('h1').textContent === 'Visão geral'`), 'o cabeçalho volta para a Visão geral');

  // ───── Arquivos pela árvore ─────
  const projRow = `[...document.querySelectorAll('#projetos .proj-item')].find((b) => /projeto-abas/.test(b.textContent))`;
  await ate(`!!${projRow}`, 6000);
  await clicar(`${projRow}.querySelector('.arq-seta')`);
  const noArq = (nome) => `[...document.querySelectorAll('#projetos .arq-no')].find((r) => r.querySelector('.arq-nome')?.textContent === ${JSON.stringify(nome)})`;
  await ate(`!!${noArq('LEIAME.md')}`, 6000);
  await clicar(noArq('LEIAME.md'));
  conferir(await ate(`!!${aba('arquivo:projeto-abas|LEIAME.md')} && ${aba('arquivo:projeto-abas|LEIAME.md')}.classList.contains('previa')`), 'clique simples abre o arquivo em prévia');
  conferir(await av(`getComputedStyle(${aba('arquivo:projeto-abas|LEIAME.md')}.querySelector('.aba-tit')).fontStyle === 'italic'`), 'a prévia tem o título em itálico');
  conferir(await ate(`!!document.querySelector('.aba-painel:not([hidden]) .arq-em-aba .arq-codigo')`), 'o conteúdo do arquivo aparece na aba');
  await clicar(`${noArq('src')}`);
  await ate(`!!${noArq('app.js')}`, 6000);
  await clicar(noArq('app.js'));
  conferir(await ate(`!!${aba('arquivo:projeto-abas|src/app.js')} && !${aba('arquivo:projeto-abas|LEIAME.md')}`), 'outro clique simples substitui a prévia');
  await clicar(noArq('app.js'), 2);
  conferir(await ate(`!${aba('arquivo:projeto-abas|src/app.js')}.classList.contains('previa')`), 'duplo clique fixa a aba');
  conferir(await av(`${aba('arquivo:projeto-abas|src/app.js')}.querySelector('.aba-ic') && ${aba('arquivo:projeto-abas|src/app.js')}.querySelector('.aba-ic').childElementCount > 0`), 'a aba do arquivo tem ícone');
  conferir(await av(`!!document.querySelector('#projetos .arq-no.arq-ativo, #projetos .arq-no[aria-current]')`), 'a árvore marca o arquivo da aba em foco');

  // ───── Conversa no painel de detalhe (nunca numa aba) ─────
  const [A, B] = ids;
  const semAbaConversa = `!window.Abas.abas().some((a) => a.tipo === 'conversa' || /^conversa:/.test(a.chave))`;
  const painelCom = (id) => `!document.getElementById('peek').hidden && document.getElementById('peek').classList.contains('em-conversa') && !document.getElementById('pk-conversa').hidden && !!document.querySelector('#pk-conversa .cv-texto') && document.querySelector('#lista [data-id="${id}"]')?.matches('[aria-selected="true"], .sel')`;
  await clicar(`document.querySelector('.nav-item[data-vista="geral"]')`);
  const nAntes = (await abas()).length;
  await clicarLinha(A, 2);
  conferir(await ate(painelCom(A), 8000), 'duplo clique na sessão abre a conversa no painel de detalhe, com o compositor',
    await av(`({ abas: window.Abas.abas().map((a) => a.chave), peek: document.getElementById('peek').className, linha: document.querySelector('#lista [data-id="${A}"]')?.outerHTML.slice(0, 200) })`));
  conferir(await ate(`[...document.querySelectorAll('#pk-conversa .cv-bolha')].some((b) => /Olá de Conversa A/.test(b.textContent))`, 8000), 'o painel mostra a 1ª mensagem da sessão');
  conferir(await av(semAbaConversa) && (await abas()).length === nAntes, 'a conversa não cria aba', await abas());
  await tecla('Escape', 'Escape', 27);
  await ate(`document.getElementById('peek').hidden || !!document.getElementById('peek').dataset.saindo`);
  await av(`document.getElementById('lista').focus()`);
  await tecla('Enter', 'Enter', 13);
  conferir(await ate(painelCom(A), 8000) && await av(semAbaConversa), 'Enter na sessão leva ao painel de conversa, sem aba');
  await clicarLinha(B, 2);
  conferir(await ate(`${painelCom(B)} && [...document.querySelectorAll('#pk-conversa .cv-bolha')].some((b) => /Olá de Conversa B/.test(b.textContent))`, 8000), 'outra sessão troca a conversa do mesmo painel');
  conferir(await av(semAbaConversa) && (await abas()).length === nAntes, 'continua sem aba de conversa', await abas());

  // ───── Painéis lado a lado (arquivo e Visão geral) ─────
  await av(`window.Abas.dividir(window.Abas.porChave('arquivo:projeto-abas|src/app.js').id, 'direita')`);
  await dormir(400);
  conferir(await nGrupos() === 2, 'dividir à direita cria o 2º painel', await nGrupos());
  await clicar(`document.querySelector('.nav-item[data-vista="geral"]')`);
  conferir(await ate(`window.Abas.visivel(window.Abas.porChave('vista:geral').id) && window.Abas.abas().filter((a) => a.chave === 'arquivo:projeto-abas|src/app.js').some((a) => window.Abas.visivel(a.id))`), 'Visão geral de um lado e o arquivo do outro, os dois à vista', await abas());
  const idsRep = await av(`(() => { const v = [...document.querySelectorAll('[id]')].map((e) => e.id); return v.filter((x, i) => v.indexOf(x) !== i); })()`);
  conferir(idsRep.length === 0, 'nenhum id repetido na página', idsRep);
  await foto('1-paineis');

  // ───── Fechar ─────
  await clicar(`${aba('vista:office')}.querySelector('.aba-x')`);
  conferir(await ate(`!${aba('vista:office')}`), 'o × fecha a aba do Office');
  const antes = (await abas()).length;
  const c = await centro(aba('vista:historico'));
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'middle', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'middle', clickCount: 1 });
  conferir(await ate(`window.Abas.abas().length === ${antes - 1} && !${aba('vista:historico')}`), 'o clique do meio fecha a aba do Histórico');
  conferir(await av(`document.getElementById('vista-historico').isConnected`), 'o Histórico fechado continua na página (reserva) para reabrir');

  // ───── F5 (com uma aba de conversa salva por uma versão antiga) ─────
  await tecla('Escape', 'Escape', 27);
  const antesF5 = { abas: (await abas()).map((a) => a.chave).sort(), grupos: await nGrupos() };
  // Gravado depois do último salvar do abas.js: a conversa B aparece como a aba ativa do painel em foco.
  await av(`(() => { const j = JSON.parse(localStorage.getItem('gi.abas')); const g = j.grupos[j.foco] || j.grupos[0]; g.abas.push({ tipo: 'conversa', chave: 'conversa:${B}', dados: { id: '${B}', nome: 'Conversa B' }, previa: false }); g.ativa = g.abas.length - 1; localStorage.setItem('gi.abas', JSON.stringify(j)); })()`);
  await cdp('Page.reload', {});
  await ate(`document.readyState === 'complete' && !!window.Abas && document.getElementById('rolar').classList.contains('com-abas')`, 8000);
  await dormir(900);
  const depoisF5 = { abas: (await abas()).map((a) => a.chave).sort(), grupos: await nGrupos() };
  conferir(JSON.stringify(antesF5) === JSON.stringify(depoisF5), 'F5 restaura as abas e os painéis, sem a aba de conversa', { antesF5, depoisF5 });
  conferir(await ate(`${painelCom(B)} && [...document.querySelectorAll('#pk-conversa .cv-bolha')].some((b) => /Olá de Conversa B/.test(b.textContent))`, 8000), 'a conversa que estava em aba foi para o painel de detalhe',
    await av(`({ peek: document.getElementById('peek').className, hid: document.getElementById('peek').hidden, pkcv: document.getElementById('pk-conversa').hidden, tx: !!document.querySelector('#pk-conversa .cv-texto'), sel: document.querySelector('#lista [aria-selected="true"]')?.dataset.id, B: '${B}', bol: [...document.querySelectorAll('#pk-conversa .cv-bolha')].map((b) => b.textContent.slice(0, 40)) })`));
  conferir(await av(`!/"conversa"/.test(localStorage.getItem('gi.abas'))`), 'a aba de conversa saiu do estado salvo', await av(`localStorage.getItem('gi.abas')`));
  await clicar(`document.querySelector('.nav-item[data-vista="geral"]')`);
  conferir(await ate(`document.querySelectorAll('#lista [data-id]').length >= 2`), 'a lista continua viva depois do F5', await abas());
  // A lista continua com os atalhos quando o foco está na Visão geral.
  await clicarLinha(A);
  await tecla('j', 'KeyJ', 74);
  conferir(await av(`!!document.querySelector('#lista [aria-selected="true"], #lista .sel, #lista [data-id].ativa')`), 'atalho j continua movendo a seleção na Visão geral');

  // ───── 420 px ─────
  await tecla('Escape', 'Escape', 27); // fecha o detalhe, se o clique na linha o abriu
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: false });
  await dormir(500);
  conferir(await av(`(() => { const r = document.getElementById('abas-raiz').getBoundingClientRect(); return r.height > 200 && r.bottom <= innerHeight + 1; })()`), '420 px: a área das abas cabe na altura da janela', await av(`JSON.stringify(document.getElementById('abas-raiz').getBoundingClientRect())`));
  conferir(await av(`document.documentElement.scrollWidth <= innerWidth + 1`), '420 px sem rolagem horizontal da página', await av(`[document.documentElement.scrollWidth, innerWidth]`));
  await foto('2-420');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // ───── ?abas=0 ─────
  await cdp('Page.navigate', { url: URL_BASE + '/?abas=0' });
  await ate(`document.readyState === 'complete'`);
  await dormir(700);
  conferir(await av(`!document.getElementById('rolar').classList.contains('com-abas') && document.getElementById('abas-raiz').hidden && getComputedStyle(document.getElementById('abas-raiz')).display === 'none'`), '?abas=0: a página de antes, sem a barra de abas');
  conferir(await ate(`document.querySelectorAll('#lista [data-id]').length >= 2 && !document.querySelector('#rolar > .conteudo').hidden`), '?abas=0: a Visão geral de sempre');

  conferir(erros.length === 0, 'sem exceção, aviso ou erro no console' + (erros.length ? ': ' + erros.slice(0, 6).join(' | ') : ''));
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e.message);
} finally {
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  const s = await saude();
  if (s?.pid) await desligarSeMeu(PORTA, s.pid);
  await dormir(500);
  const m = (() => { try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch { return null; } })();
  if (m?.pid) try { process.kill(m.pid); } catch {}
  await dormir(300);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
