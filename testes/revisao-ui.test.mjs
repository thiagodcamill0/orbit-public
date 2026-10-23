// Teste do modelo de revisão (16/10): toda sessão que termina entra em "Concluídas" e fica lá mesmo aberta
// (no detalhe, na Conversa e depois do F5); só "Marcar como revisada" passa para "Revisadas"; o Desfazer volta;
// "⋯ › Marcar todas como revisadas" pede confirmação; terminar de novo volta para Concluídas; a rosca e as
// contagens seguem os grupos novos. 21/10: a revisão mora no servidor (s.revisadaEm + POST /sessao/:id/revisada); o
// 'gi.revisadas' antigo do navegador migra para lá e a chave é apagada.
// Servidor de teste numa porta livre (47822–47826) + Edge headless mudo; nunca toca a 47821.
// node testes/revisao-ui.test.mjs <pasta-de-saida>   (~25 s; capturas 01–04 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-revisao-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes'), FALSO = path.join(SAIDA, 'projeto-falso');
for (const d of [DADOS, PERFIL, SESS, FALSO, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS, FALSO]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
for (const d of ['casa', 'projetos']) fs.mkdirSync(path.join(SAIDA, d), { recursive: true }); // isola ~/.claude: só as sessões do teste
const sessaoSrv = async (id) => ((await (await fetch(BASE + '/estado')).json()).sessoes || []).find((x) => x.id === id);
const postRev = (id, revisada) => fetch(BASE + '/sessao/' + id + '/revisada', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ revisada }) });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

let srv, pcdp;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'teste', CLAUDE_CODE_HOST_SESSION_ID: '', CLAUDECODE: '', GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL, GERENCIADOR_CASA: path.join(SAIDA, 'casa'), ORBIT_PROJETOS_DIR: path.join(SAIDA, 'projetos'), ORBIT_MODELOS: '0' },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const hook = (corpo) => fetch(BASE + '/evento', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cwd: FALSO, ...corpo }) });
  const turno = async (id, pedido) => {
    await hook({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: pedido });
    await dormir(30);
    return hook({ session_id: id, hook_event_name: 'Stop', last_assistant_message: 'Feito: ' + pedido });
  };
  for (const id of ['rev-a', 'rev-b']) await hook({ session_id: id, hook_event_name: 'SessionStart', source: 'startup' });
  conferir((await turno('rev-a', 'Escrever o relatório A')).ok, 'sessão A concluiu');
  conferir((await turno('rev-b', 'Escrever o relatório B')).ok, 'sessão B concluiu');

  // Sessões alheias (processos reais do Claude Code lidos pelo servidor) tirariam as contagens do teste: fora.
  for (const x of (await (await fetch(BASE + '/estado')).json()).sessoes || []) if (!String(x.id).startsWith('rev-')) await fetch(BASE + '/remover', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ id: x.id }) });
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
  const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
  // Grupo da lista onde está a linha da sessão.
  const grupoDe = (id) => av(`document.querySelector('#lista .linha[data-id="${id}"]')?.closest('section.secao')?.dataset.grupo || null`);
  const contagem = (k) => av(`document.querySelector('#lista > section[data-grupo="${k}"] .sec-cab h2 .chip')?.textContent`);
  const faixa = () => av(`(() => { const b = document.getElementById('pk-revisao'); return { vis: !b.hidden && b.offsetHeight > 0, tit: document.getElementById('pk-rv-tit').textContent, btn: document.getElementById('pk-rv-btn').textContent, feita: b.classList.contains('feita') }; })()`);
  const rosca = () => av(`Object.fromEntries([...document.querySelectorAll('#ge-leg .gl-item')].map((b) => [b.dataset.g, Number(b.querySelector('.gl-n').textContent)]))`);

  // F5 de verdade: espera a página nova (sem a marca da antiga) desenhar os grupos.
  const recarregar = async () => {
    await av(`window.__velha = 1; true`);
    await cdp('Page.reload');
    for (let i = 0; i < 100; i++) { await dormir(100); if (await av(`!window.__velha && document.querySelectorAll('#lista > section.secao').length > 0 && !!document.querySelector('#ge-leg .gl-item')`)) break; }
    await dormir(400);
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2200);
  // 0) Migração: o 'gi.revisadas' do navegador (rev-a válida, rev-b velha demais, id que não existe) vai para o servidor e a chave some.
  const agora0 = Date.now();
  await av(`localStorage.setItem('gi.revisadas', JSON.stringify({ 'rev-a': ${agora0 + 5000}, 'rev-b': 1000, 'nao-existe': ${agora0 + 5000} })); localStorage.setItem('gi.agrupar', 'false'); localStorage.setItem('gi.pk-aba', '"resumo"'); true`);
  await recarregar();
  await dormir(500);
  conferir(await av(`localStorage.getItem('gi.revisadas') === null`), "a migração apaga a chave 'gi.revisadas'", await av(`localStorage.getItem('gi.revisadas')`));
  const ma = await sessaoSrv('rev-a'), mb = await sessaoSrv('rev-b');
  conferir(ma && ma.revisadaEm >= agora0, 'a marca válida foi para o servidor (revisadaEm)', ma && ma.revisadaEm);
  conferir(mb && !mb.revisadaEm, 'a marca velha demais não migra', mb && mb.revisadaEm);
  conferir(await grupoDe('rev-a') === 'revisadas' && await grupoDe('rev-b') === 'concluidas', 'a migrada aparece em Revisadas', [await grupoDe('rev-a'), await grupoDe('rev-b')]);
  await postRev('rev-a', false); await dormir(500); // volta ao ponto de partida dos passos seguintes
  conferir(!(await sessaoSrv('rev-a')).revisadaEm, 'POST revisada:false apaga o campo no servidor');
  await av(`localStorage.removeItem('gi.ordemGrupos'); localStorage.removeItem('gi.grupos'); true`);
  await recarregar();

  // 1) As duas concluídas ficam em "Concluídas", com o ponto "a revisar"; Revisadas vazio.
  const ordem = await av(`[...document.querySelectorAll('#lista > section.secao')].map((s) => s.dataset.grupo).join()`);
  conferir(ordem === 'precisa,trabalhando,novas,concluidas,revisadas,encerradas', 'grupos na ordem padrão nova', ordem);
  conferir(await av(`document.querySelector('#lista > section[data-grupo="concluidas"] h2 span')?.textContent`) === 'Concluídas', 'título do grupo é "Concluídas"');
  conferir(await av(`document.querySelector('#lista > section[data-grupo="revisadas"] h2 span')?.textContent`) === 'Revisadas', 'título do grupo é "Revisadas"');
  conferir(await grupoDe('rev-a') === 'concluidas' && await grupoDe('rev-b') === 'concluidas', 'sessões que terminaram entram em Concluídas', [await grupoDe('rev-a'), await grupoDe('rev-b')]);
  conferir(await contagem('concluidas') === '2' && await contagem('revisadas') === '0', 'contagens 2 e 0', [await contagem('concluidas'), await contagem('revisadas')]);
  conferir(await av(`document.querySelector('#lista .linha[data-id="rev-a"]').classList.contains('a-revisar') && !document.querySelector('#lista .linha[data-id="rev-a"] .nv').hidden`), 'linha com o ponto "a revisar"');
  let r = await rosca();
  conferir(r && r.concluidas === 2 && r.revisadas === 0 && !('recentes' in r), 'a rosca mostra Concluídas e Revisadas', r);

  // 2) Abrir não muda nada: detalhe, Conversa, trocar de sessão, fechar, F5.
  await av(`document.querySelector('#lista .linha[data-id="rev-a"]').click(); true`); await dormir(500);
  let fx = await faixa();
  conferir(fx.vis && fx.btn.includes('Marcar como revisada') && !fx.feita, 'o detalhe mostra "Marcar como revisada"', fx);
  await foto('01-detalhe-a-revisar');
  conferir(await grupoDe('rev-a') === 'concluidas', 'aberta, segue em Concluídas');
  await av(`document.querySelector('#pk-abas button[data-aba="conversa"]').click(); true`); await dormir(600);
  fx = await faixa();
  conferir(fx.vis && fx.btn.includes('Marcar como revisada'), 'na Conversa o botão continua à vista', fx);
  await foto('02-conversa-a-revisar');
  await av(`document.querySelector('#lista .linha[data-id="rev-b"]').click(); true`); await dormir(300);
  await av(`document.getElementById('pk-fechar').click(); true`); await dormir(400);
  conferir(await grupoDe('rev-a') === 'concluidas' && await grupoDe('rev-b') === 'concluidas', 'depois de abrir e sair, as duas seguem em Concluídas');
  await recarregar();
  conferir(await grupoDe('rev-a') === 'concluidas' && await grupoDe('rev-b') === 'concluidas', 'depois do F5, seguem em Concluídas');

  // 3) Marcar como revisada (pelo botão da Conversa) → Revisadas; Desfazer → Concluídas.
  await av(`document.querySelector('#lista .linha[data-id="rev-a"]').click(); true`); await dormir(500);
  await av(`document.getElementById('pk-rv-btn').click(); true`); await dormir(700);
  conferir(await grupoDe('rev-a') === 'revisadas', 'marcar passa para Revisadas', await grupoDe('rev-a'));
  conferir(await contagem('concluidas') === '1' && await contagem('revisadas') === '1', 'contagens 1 e 1', [await contagem('concluidas'), await contagem('revisadas')]);
  conferir(await av(`document.querySelector('#lista .linha[data-id="rev-a"] .nv').hidden`), 'revisada perde o ponto');
  fx = await faixa();
  conferir(fx.vis && fx.feita && fx.tit === 'Revisada' && fx.btn.includes('Desfazer'), 'a faixa vira "Revisada" com Desfazer', fx);
  const sa = await sessaoSrv('rev-a');
  conferir(sa && sa.revisadaEm > 0, 'a revisão fica gravada no servidor (revisadaEm)', sa && sa.revisadaEm);
  conferir(await av(`localStorage.getItem('gi.revisadas') === null`), "e nada em 'gi.revisadas' no navegador");
  r = await rosca();
  conferir(r.concluidas === 1 && r.revisadas === 1, 'a rosca acompanha', r);
  await foto('03-revisada');
  await recarregar();
  conferir(await grupoDe('rev-a') === 'revisadas', 'revisada continua em Revisadas depois do F5');
  await av(`document.querySelector('#lista .linha[data-id="rev-a"]').click(); true`); await dormir(500);
  await av(`document.getElementById('pk-rv-btn').click(); true`); await dormir(700);
  conferir(await grupoDe('rev-a') === 'concluidas', 'Desfazer volta para Concluídas', await grupoDe('rev-a'));
  conferir(!(await sessaoSrv('rev-a')).revisadaEm, 'Desfazer apaga o revisadaEm no servidor');
  fx = await faixa();
  conferir(fx.btn.includes('Marcar como revisada') && !fx.feita, 'a faixa volta a "Marcar como revisada"', fx);
  conferir(await av(`(() => { const t = document.getElementById('pk-rv-tit').parentElement; return t.scrollWidth <= t.clientWidth && !document.querySelector('#pk-revisao .rv-ico'); })()`), 'a faixa é uma linha, sem a caixa do ícone e sem corte');

  // 3b) Checkbox na lista: marca e desmarca sem abrir a sessão; só nas concluídas.
  await av(`document.getElementById('pk-fechar').click(); true`); await dormir(400);
  const chk = (id) => av(`(() => { const b = document.querySelector('#lista .linha[data-id="${id}"] .rev-chk'); return b && { vis: !b.hidden && b.offsetWidth > 0, marcada: b.getAttribute('aria-checked'), w: b.offsetWidth }; })()`);
  let c = await chk('rev-a');
  conferir(c && c.vis && c.marcada === 'false' && c.w >= 28, 'concluída mostra a checkbox desmarcada, com área de 28 px', c);
  conferir(await av(`(() => { const r = document.querySelector('#lista .linha[data-id="rev-a"]'); const ctx = r.querySelector('.c-ctx').getBoundingClientRect(), rv = r.querySelector('.c-rev').getBoundingClientRect(), tp = r.querySelector('.c-tempo').getBoundingClientRect(); return ctx.right <= rv.left && rv.right <= tp.left; })()`), 'a coluna fica entre Contexto e Tempo');
  conferir(await av(`[...document.querySelectorAll('#lista .linha[data-id]')].filter((l) => !['concluida', 'interrompida'].includes(l.dataset.s)).every((l) => !l.querySelector('.rev-chk') || l.querySelector('.rev-chk').hidden)`), 'nas que não estão concluídas a coluna fica vazia');
  await av(`document.querySelector('#lista .linha[data-id="rev-a"] .rev-chk').click(); true`); await dormir(700);
  conferir(await grupoDe('rev-a') === 'revisadas' && (await chk('rev-a')).marcada === 'true', 'marcar a checkbox passa para Revisadas', await grupoDe('rev-a'));
  conferir(await av(`document.getElementById('peek').hidden || !!document.getElementById('peek').dataset.saindo`), 'clicar na checkbox não abre a sessão');
  await foto('03b-checkbox');
  await av(`document.querySelector('#lista .linha[data-id="rev-a"] .rev-chk').click(); true`); await dormir(700);
  conferir(await grupoDe('rev-a') === 'concluidas' && (await chk('rev-a')).marcada === 'false', 'desmarcar volta para Concluídas', await grupoDe('rev-a'));
  await av(`document.querySelector('#lista .linha[data-id="rev-a"]').click(); true`); await dormir(500);

  // 4) Filtro pela legenda da rosca.
  await av(`document.querySelector('#ge-leg .gl-item[data-g="concluidas"]').click(); true`); await dormir(400);
  const filtradas = await av(`[...document.querySelectorAll('#lista .linha[data-id]')].map((l) => l.dataset.id).sort().join()`);
  conferir(filtradas === 'rev-a,rev-b', 'filtrar por Concluídas mostra só as a revisar', filtradas);
  await av(`document.querySelector('#ge-leg .gl-item[data-g="concluidas"]').click(); true`); await dormir(300);

  // 5) "⋯ › Marcar todas como revisadas": cancelar não muda; confirmar passa todas.
  await av(`document.getElementById('pk-fechar').click(); true`); await dormir(300);
  await av(`document.getElementById('btn-mais-lista').click(); true`); await dormir(250);
  const itens = await av(`[...document.querySelectorAll('.menu-flut .menu-item')].map((b) => b.textContent)`);
  conferir(itens && itens.some((t) => t.includes('Marcar todas como revisadas (2)')), 'o menu oferece "Marcar todas como revisadas (2)"', itens);
  conferir(itens && !itens.some((t) => /vista/i.test(t)), 'sem o antigo "Marcar como vistas"', itens);
  await av(`[...document.querySelectorAll('.menu-flut .menu-item')].find((b) => b.textContent.includes('revisadas')).click(); true`); await dormir(300);
  const bal = await av(`({ vis: !document.getElementById('balao').hidden, tit: document.getElementById('balao-tit').textContent, sim: document.getElementById('balao-sim').textContent })`);
  conferir(bal.vis && bal.tit.includes('2 sessões') && bal.sim === 'Marcar como revisadas', 'pede confirmação antes', bal);
  await foto('04-confirmar-todas');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(300);
  conferir(await grupoDe('rev-a') === 'concluidas' && await grupoDe('rev-b') === 'concluidas', 'cancelar não marca nada');
  await av(`document.getElementById('btn-mais-lista').click(); true`); await dormir(250);
  await av(`[...document.querySelectorAll('.menu-flut .menu-item')].find((b) => b.textContent.includes('revisadas')).click(); true`); await dormir(300);
  await av(`document.getElementById('balao-sim').click(); true`); await dormir(600);
  conferir(await grupoDe('rev-a') === 'revisadas' && await grupoDe('rev-b') === 'revisadas', 'confirmar passa todas para Revisadas', [await grupoDe('rev-a'), await grupoDe('rev-b')]);
  conferir(await av(`document.getElementById('btn-mais-lista').hidden`), 'sem nada a revisar, o "⋯" some');

  // 6) Trabalhar e terminar de novo: volta para Concluídas.
  await turno('rev-b', 'Revisar o relatório B'); await dormir(600);
  conferir(await grupoDe('rev-b') === 'concluidas', 'terminar de novo volta para Concluídas', await grupoDe('rev-b'));
  conferir(!(await sessaoSrv('rev-b')).revisadaEm, 'terminar de novo: o servidor apaga o revisadaEm', (await sessaoSrv('rev-b')).revisadaEm);
  conferir(await grupoDe('rev-a') === 'revisadas', 'a outra continua revisada');

  // 7) Agrupado por projeto: o card do projeto separa Concluídas e Revisadas em barras de estado.
  await av(`document.getElementById('btn-agrupar').click(); true`); await dormir(500);
  const subs = await av(`[...document.querySelectorAll('#lista .sub-estado')].map((s) => s.dataset.estado + ':' + [...s.querySelectorAll('.linha[data-id]')].map((l) => l.dataset.id).join('+')).join()`);
  conferir(subs === 'concluidas:rev-b,revisadas:rev-a', 'agrupado por projeto, as barras Concluídas e Revisadas separam as sessões', subs);
  await av(`document.getElementById('btn-agrupar').click(); true`); await dormir(300);

  // Ícones comuns (assets/comum/icones.js): na tela, todo svg[data-i] tem traço desenhado (nome existente ou fallback local do 'atualizar'), com currentColor.
  const ic = await av(`(() => { const vs = [...document.querySelectorAll('svg[data-i]')]; const v = vs.find((x) => x.dataset.i === 'check'); return { orbit: typeof OrbitIcones.icone === 'function' && OrbitIcones.nomes.includes('check'), n: vs.length, vazios: [...new Set(vs.filter((x) => !x.children.length).map((x) => x.dataset.i))], traco: v && v.getAttribute('stroke'), larg: v && v.getAttribute('stroke-width'), vb: v && v.getAttribute('viewBox') }; })()`);
  conferir(ic && ic.orbit && ic.n > 10 && ic.vazios.length === 0 && ic.traco === 'currentColor' && ic.larg === '1.5' && ic.vb === '0 0 16 16', 'ícones comuns: nenhum svg vazio na tela, traço 1,5 currentColor', ic);
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
