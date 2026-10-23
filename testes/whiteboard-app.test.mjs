// Fumaça do Whiteboard no app real (index.html + servidor.mjs de verdade, dados numa pasta temporária).
// Porta livre de 47822–47826, Edge headless mudo, tudo apagado/fechado no fim; nunca toca a 47821.
// node testes/whiteboard-app.test.mjs [captura.png]   (~15 s; a captura da vista é opcional)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wb-app-'));
const DADOS = path.join(TMP, 'dados'), PERFIL = path.join(TMP, 'perfil'), SESS = path.join(TMP, 'sessoes'), EDGE_PERFIL = path.join(TMP, 'edge');
for (const d of [DADOS, PERFIL, SESS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config vazia de teste (nunca a do usuário)
const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

let srv, pcdp, ws;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

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
    if (d.method === 'Runtime.exceptionThrown') { const x = d.params.exceptionDetails; consoleErros.push('exceção: ' + (x.exception?.description || x.text) + ` @ ${x.url || '?'}:${x.lineNumber}:${x.columnNumber}`); }
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const esperar = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(60); } return false; };
  const recarregar = async () => { await cdp('Page.reload'); await dormir(1200); await esperar(`document.readyState === 'complete'`, 6000); };
  const visivel = () => av(`!document.getElementById('whiteboard').hidden && !!document.querySelector('#whiteboard canvas.wb-canvas')`);

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`!!document.querySelector('[data-lat="whiteboard"]')`, 8000);
  await dormir(800);
  await av(`sessionStorage.clear(); localStorage.removeItem('orbit.whiteboard.ultimo'); true`);

  // 1) Item na lateral e abertura da vista
  conferir(await av(`!!document.querySelector('#lat-grupos [data-lat="whiteboard"][data-vista="whiteboard"]') && document.querySelector('[data-lat="whiteboard"]').textContent.includes('Whiteboard')`), 'item Whiteboard aparece na lateral');
  await av(`document.querySelector('[data-lat="whiteboard"]').click()`);
  conferir(await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id`, 6000), 'clicar abre a vista e cria o primeiro quadro pelo servidor');
  conferir(await visivel(), 'vista visível com o canvas');
  const idQ = await av(`Whiteboard.quadro().id`);
  conferir(await av(`document.getElementById('geral') ? document.getElementById('geral').hidden !== false || getComputedStyle(document.querySelector('.conteudo')).display === 'none' : true`), 'conteúdo da visão geral escondido');

  // 2) Desenha um retângulo e usa zoom
  await av(`Whiteboard.nucleo.adicionar({ tipo: 'retangulo', x: 120, y: 100, w: 240, h: 140, cor: '#4f8cff', preenchimento: 'rgba(79,140,255,.25)' }); Whiteboard.nucleo.confirmar('teste'); true`);
  const z0 = await av(`Whiteboard.nucleo.camera().zoom`);
  await av(`document.querySelector('.wb-zoom [data-zoom="mais"]').click()`);
  await dormir(500);
  const z1 = await av(`Whiteboard.nucleo.camera().zoom`);
  conferir(z1 > z0 && (await av(`document.querySelector('.wb-zoom-pct').textContent`)) === Math.round(z1 * 100) + '%', 'botão de zoom aproxima e o % acompanha', { z0, z1 });

  // 3) Arquivo no disco (salvar espera ~600 ms)
  const arq = path.join(DADOS, 'whiteboard', idQ + '.json');
  let json = null;
  for (let i = 0; i < 40 && !json; i++) { try { const j = JSON.parse(fs.readFileSync(arq, 'utf8')); if ((j.elementos || []).length === 1) json = j; } catch {} if (!json) await dormir(150); }
  conferir(!!json && json.elementos[0].tipo === 'retangulo', 'arquivo do quadro aparece em <dados>/whiteboard/ com o retângulo', { existe: fs.existsSync(arq) });
  conferir(await esperar(`document.querySelector('.wb-status')?.dataset.estado === 'salvo'`, 3000), 'status "salvo"');
  if (process.argv[2]) {
    await dormir(400);
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 200, y: 0, width: 1000, height: 600, scale: 1 } });
    fs.writeFileSync(path.resolve(process.argv[2]), Buffer.from(r.result.data, 'base64'));
  }

  // 4) Recarregar volta ao Whiteboard com o quadro
  await recarregar();
  conferir(await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.nucleo.elementos().length === 1`, 8000), 'recarregar volta com o quadro e o retângulo', await av(`({ wb: !!window.Whiteboard, q: window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id, n: window.Whiteboard && Whiteboard.nucleo.elementos().length, oculto: document.getElementById('whiteboard').hidden, filhos: document.getElementById('whiteboard').children.length, vista: document.querySelector('.nav-item[aria-current], .nav-item.ativo')?.dataset.lat, ss: Object.keys(sessionStorage).map(k => k + '=' + String(sessionStorage.getItem(k)).slice(0, 120)) })`));
  conferir(await visivel() && (await av(`Whiteboard.quadro().id`)) === idQ, 'recarregar volta na vista Whiteboard (restauração da tela)');

  // 5) Sair da vista salva; restauração não deve voltar para o Whiteboard
  await av(`document.querySelector('[data-lat="geral"]').click()`);
  await dormir(500);
  conferir(await av(`(() => { const e = document.getElementById('whiteboard'); return e.hidden || !e.offsetParent || e.getBoundingClientRect().width === 0; })()`), 'sair da vista esconde o Whiteboard');
  await recarregar();
  await dormir(600);
  conferir(await av(`document.getElementById('whiteboard').hidden`), 'depois de sair, recarregar não reabre o Whiteboard');

  // 6) Etapa 4: fonte de sessões para os cards de agente (OrbitFonteSessoes) e arrastar da lista
  const hook = (corpo) => fetch(BASE + '/evento', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cwd: PROJ, ...corpo }) });
  await hook({ session_id: 'wb-s1', hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ session_id: 'wb-s1', hook_event_name: 'UserPromptSubmit', prompt: 'Montar o quadro de agentes' });
  conferir(await esperar(`!!window.OrbitFonteSessoes && OrbitFonteSessoes.obter('wb-s1') !== null`, 8000), 'OrbitFonteSessoes existe e enxerga a sessão do servidor de teste');
  conferir(await av(`['obter','lista','ouvir','abrir'].every((k) => typeof OrbitFonteSessoes[k] === 'function')`), 'OrbitFonteSessoes tem obter, lista, ouvir e abrir');
  const rs = await av(`OrbitFonteSessoes.obter('wb-s1')`);
  const campos = ['id', 'nome', 'projeto', 'status', 'statusTexto', 'sprite', 'contexto', 'atividade', 'detalhe', 'ferramenta', 'desde', 'agentes', 'pai'];
  conferir(rs && campos.every((k) => k in rs) && rs.id === 'wb-s1' && rs.status === 'trabalhando' && rs.statusTexto && /\.(png|gif)(\?.*)?$/.test(rs.sprite) && typeof rs.desde === 'number' && rs.agentes === 0 && rs.pai === null, 'obter devolve o resumo com os campos do contrato', rs);
  conferir(/Montar o quadro/.test(rs?.nome || '') || /Montar o quadro/.test(rs?.atividade || ''), 'nome/atividade vêm do pedido da sessão', rs);
  conferir((await av(`OrbitFonteSessoes.obter('nao-existe')`)) === null, 'obter de sessão inexistente devolve null');
  conferir((await av(`OrbitFonteSessoes.lista().some((x) => x.id === 'wb-s1')`)), 'lista inclui a sessão');
  // ouvir: um ouvinte que lança não impede o outro; desligar para de receber
  await av(`window.__ev = []; window.__off = OrbitFonteSessoes.ouvir(() => { throw new Error('ouvinte ruim'); }); window.__off2 = OrbitFonteSessoes.ouvir((e) => __ev.push(e)); true`);
  await hook({ session_id: 'wb-s1', hook_event_name: 'UserPromptSubmit', prompt: 'Outro pedido' });
  conferir(await esperar(`__ev.some((e) => e.tipo === 'sessao' && e.id === 'wb-s1')`, 5000), 'ouvir recebe o evento ao mudar a sessão (mesmo com outro ouvinte quebrado)', await av(`__ev`));
  await av(`__off2(); __ev.length = 0; true`);
  await hook({ session_id: 'wb-s1', hook_event_name: 'UserPromptSubmit', prompt: 'Terceiro pedido' });
  await dormir(700);
  conferir((await av(`__ev.length`)) === 0, 'ouvir devolve o desligar (depois dele nada chega)');
  await av(`__off(); true`);
  // lista: item da sessão arrastável e dragstart preenche o dataTransfer
  await av(`document.querySelector('[data-lat="geral"]').click()`);
  conferir(await esperar(`!!document.getElementById('l-wb-s1')`, 5000), 'a sessão aparece na lista');
  const arr = await av(`(() => { const el = document.getElementById('l-wb-s1'); const dt = new DataTransfer(); let efeito = ''; const d0 = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'effectAllowed'); Object.defineProperty(dt, 'effectAllowed', { configurable: true, get: () => efeito, set: (v) => { efeito = v; } }); const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(ev); return { draggable: el.draggable, id: dt.getData('application/x-orbit-sessao'), txt: dt.getData('text/plain'), efeito, cancelado: ev.defaultPrevented }; })()`);
  conferir(arr && arr.draggable && arr.id === 'wb-s1' && arr.txt === 'wb-s1' && arr.efeito === 'copy' && !arr.cancelado, 'item da lista é draggable e o dragstart preenche o dataTransfer', arr);
  conferir(await av(`[...document.querySelectorAll('#lista .linha')].every((l) => l.draggable === (!!l.dataset.id && !l.dataset.agente))`), 'só as linhas de sessão são draggable');
  // abrir a partir do Whiteboard abre a conversa
  await av(`document.querySelector('[data-lat="whiteboard"]').click()`);
  conferir(await visivel(), 'voltou ao Whiteboard para testar o abrir');
  const aberta = `(() => { const l = document.getElementById('peek'); const pk = document.getElementById('pk-abas'); return !!l && !l.hidden && l.dataset.id === 'wb-s1' && !!pk && pk.offsetParent !== null && pk.querySelector('button[data-aba="conversa"]').getAttribute('aria-pressed') === 'true'; })()`;
  const estado = () => av(`({ sel: document.getElementById('peek').dataset.id, ph: document.getElementById('peek').hidden, pk: !!document.getElementById('pk-abas')?.offsetParent, wb: document.getElementById('whiteboard').hidden, geral: document.querySelector('.conteudo').hidden })`);
  await av(`OrbitFonteSessoes.abrir('wb-s1')`);
  conferir(await esperar(aberta, 5000), 'abrir seleciona a sessão e abre o detalhe na aba Conversa', await estado());
  await av(`OrbitFonteSessoes.abrir('nao-existe'); true`);
  conferir(await av(aberta), 'abrir de id inexistente não faz nada');
  // sem abas (?abas=0): abrir sai do Whiteboard para a visão geral
  await cdp('Page.navigate', { url: BASE + '/?abas=0' });
  await dormir(1200);
  await esperar(`!!window.OrbitFonteSessoes && OrbitFonteSessoes.obter('wb-s1') !== null`, 8000);
  await av(`document.querySelector('[data-lat="whiteboard"]').click()`);
  conferir(await esperar(`!document.getElementById('whiteboard').hidden && document.querySelector('.conteudo').hidden`, 5000), 'sem abas: Whiteboard aberto', await estado());
  await av(`OrbitFonteSessoes.abrir('wb-s1')`);
  conferir(await esperar(`document.getElementById('whiteboard').hidden && !document.querySelector('.conteudo').hidden`, 5000) && await esperar(aberta, 5000), 'sem abas: abrir sai do Whiteboard e abre a conversa', await estado());

  // 7) Etapa 5: OrbitFonteSessoes.time(id) — mãe com subagentes do Task + sessão dependente (host_session_id vira `pai`)
  const pre5 = (id, tool_name, uid, input, agente) => hook({ session_id: id, hook_event_name: 'PreToolUse', tool_name, tool_use_id: uid, tool_input: input || {}, ...(agente ? { agent_id: agente } : {}) });
  await hook({ session_id: 'wb-m', hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ session_id: 'wb-m', hook_event_name: 'UserPromptSubmit', prompt: 'Liderar o time de teste' });
  await pre5('wb-m', 'Agent', 'wb-tool1', { subagent_type: 'Explore', description: 'Explorar o código do time', prompt: 'Explore' });
  await hook({ session_id: 'wb-m', hook_event_name: 'SubagentStart', agent_id: 'wb-ag1', agent_type: 'Explore' });
  await pre5('wb-m', 'Agent', 'wb-tool2', { subagent_type: 'general-purpose', description: 'Revisar o resultado', prompt: 'Revise' });
  await hook({ session_id: 'wb-m', hook_event_name: 'SubagentStart', agent_id: 'wb-ag2', agent_type: 'general-purpose' });
  await pre5('wb-m', 'Read', 'wb-r1', { file_path: PROJ + '/servidor.mjs' }, 'wb-ag1');
  await hook({ session_id: 'wb-m', hook_event_name: 'SubagentStop', agent_id: 'wb-ag2', agent_type: 'general-purpose' });
  await hook({ session_id: 'wb-d', hook_event_name: 'SessionStart', source: 'startup', host_session_id: 'wb-m' });
  await hook({ session_id: 'wb-d', hook_event_name: 'UserPromptSubmit', prompt: 'Trabalho do membro' });
  conferir(await esperar(`!!OrbitFonteSessoes.obter('wb-d') && OrbitFonteSessoes.obter('wb-d').pai === 'wb-m'`, 8000), 'sessão dependente chega com pai = mãe', await av(`OrbitFonteSessoes.obter('wb-d')`));
  conferir(await esperar(`(() => { const t = OrbitFonteSessoes.time('wb-m'); return !!t && t.subagentes.length === 2 && t.subagentes.some((a) => a.id === 'wb-ag1' && /^Read/.test(a.atividade)) && t.subagentes.some((a) => a.id === 'wb-ag2' && a.status === 'concluido'); })()`, 8000), 'time da mãe enxerga os dois subagentes (um lendo, um concluído)', await av(`OrbitFonteSessoes.time('wb-m')`));
  conferir(await av(`typeof OrbitFonteSessoes.time === 'function'`), 'OrbitFonteSessoes tem time');
  const tm = await av(`OrbitFonteSessoes.time('wb-m')`);
  const td = await av(`OrbitFonteSessoes.time('wb-d')`);
  conferir(tm && ['raiz', 'nome', 'lider', 'membros', 'subagentes', 'ativos', 'total'].every((k) => k in tm) && tm.raiz === 'wb-m' && /Liderar o time/.test(tm.nome) && tm.lider && tm.lider.id === 'wb-m' && tm.lider.status === 'trabalhando', 'time(mãe): raiz, nome, líder e campos do contrato', tm);
  conferir(tm && tm.membros.length === 1 && tm.membros[0].id === 'wb-d' && tm.membros[0].pai === 'wb-m' && 'sprite' in tm.membros[0], 'time(mãe): o membro é o resumo da sessão dependente', tm && tm.membros);
  const sa = tm && tm.subagentes.find((a) => a.id === 'wb-ag1');
  const sb = tm && tm.subagentes.find((a) => a.id === 'wb-ag2');
  const campSub = ['id', 'sessao', 'tipo', 'descricao', 'status', 'statusTexto', 'sprite', 'inicio', 'fim', 'atividade'];
  conferir(sa && campSub.every((k) => k in sa) && sa.sessao === 'wb-m' && sa.tipo === 'Explore' && sa.descricao === 'Explorar o código do time' && sa.status === 'trabalhando' && sa.statusTexto === 'Trabalhando' && /\.(png|gif)(\?.*)?$/.test(sa.sprite) && sa.inicio > 0 && sa.atividade.length > 0 && sa.atividade.length <= 80, 'subagente em curso: campos, sessão dona, sprite e atividade curta', sa);
  conferir(sb && sb.status === 'concluido' && sb.statusTexto === 'Concluído' && sb.fim > 0 && sb.atividade === 'Revisar o resultado' && sb.tipo === 'general-purpose', 'subagente concluído: fim e atividade = descrição', sb);
  conferir(tm && tm.ativos === 3 && tm.total === 4, 'ativos = líder + membro + subagente trabalhando (concluído não conta); total = 4', tm && { ativos: tm.ativos, total: tm.total });
  conferir(td && td.raiz === 'wb-m' && td.lider && td.lider.id === 'wb-m' && td.membros.length === 1 && td.subagentes.length === 2 && td.ativos === tm.ativos && td.nome === tm.nome, 'time(membro) devolve o mesmo time da raiz', td);
  conferir((await av(`OrbitFonteSessoes.time('nao-existe')`)) === null && (await av(`OrbitFonteSessoes.time('')`)) === null, 'time de sessão inexistente devolve null');
  const t1 = await av(`OrbitFonteSessoes.time('wb-s1')`);
  conferir(t1 && t1.raiz === 'wb-s1' && t1.membros.length === 0 && t1.subagentes.length === 0 && t1.total === 1, 'sessão solta: time só com o líder', t1);
  await hook({ session_id: 'wb-m', hook_event_name: 'SubagentStop', agent_id: 'wb-ag1', agent_type: 'Explore' });
  conferir(await esperar(`OrbitFonteSessoes.time('wb-m').ativos === 2`, 6000), 'subagente que termina sai da conta dos ativos', await av(`OrbitFonteSessoes.time('wb-m')`));

  // 8) Ajustes: painel, menu, card web, ligação, exportar, trava (app real)
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`!!document.querySelector('[data-lat="whiteboard"]')`, 8000);
  await dormir(600);
  await av(`document.querySelector('[data-lat="whiteboard"]').click()`);
  await esperar(`window.Whiteboard && Whiteboard.quadro() && Whiteboard.quadro().id && !!document.querySelector('#whiteboard canvas.wb-canvas')`, 8000);
  await cdp('Page.bringToFront'); await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  const tecla = async (key, code, vk, modifiers = 0) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: vk });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk });
  };
  // 8.1 módulos carregados, sem 404
  const mods = ['painel', 'menu', 'exportar', 'web', 'ligacao', 'acoes', 'agentes'];
  conferir(await av(`${JSON.stringify(mods)}.every((k) => !!Whiteboard[k])`), 'Whiteboard.painel/menu/exportar/web/ligacao/acoes existem', await av(`${JSON.stringify(mods)}.filter((k) => !Whiteboard[k])`));
  const arqs = (await av(`[...document.querySelectorAll('script[src],link[rel=stylesheet]')].map((e) => e.getAttribute('src') || e.getAttribute('href')).filter((u) => /whiteboard-/.test(u))`)) || [];
  const codigos = []; for (const u of arqs) { try { codigos.push([u, (await fetch(BASE + '/' + u.replace(/^\//, '').split('?')[0])).status]); } catch { codigos.push([u, 0]); } }
  conferir(arqs.length >= 15 && codigos.every(([, c]) => c === 200), 'todos os scripts/CSS assets/whiteboard-* respondem 200', { n: arqs.length, ruins: codigos.filter(([, c]) => c !== 200) });
  // 8.2 painel
  await hook({ session_id: 'wb-p1', hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ session_id: 'wb-p1', hook_event_name: 'UserPromptSubmit', prompt: 'Sessão do painel' });
  await esperar(`!!OrbitFonteSessoes.obter('wb-p1')`, 8000);
  conferir(await esperar(`!!document.querySelector('.wb-pn-btn')`, 4000), 'botão do painel existe na vista');
  if (await av(`Whiteboard.painel.aberto()`)) await av(`Whiteboard.painel.fechar(); true`);
  await av(`document.querySelector('.wb-pn-btn').click()`);
  conferir(await esperar(`Whiteboard.painel.aberto() && !!document.querySelector('.wb-pn-lin[data-sessao="wb-p1"]')`, 5000), 'painel abre pelo botão e lista a sessão do servidor de teste', await av(`[...document.querySelectorAll('.wb-pn-lin')].map((l) => l.dataset.sessao)`));
  conferir(await av(`(() => { const l = document.querySelector('.wb-pn-lin[data-sessao="wb-p1"]'); const sec = l && l.closest('.wb-pn-proj'); return !!sec && !!sec.querySelector('.wb-pn-proj-cab') && sec.querySelector('.wb-pn-proj-cab').textContent.length > 0; })()`), 'sessões agrupadas por projeto (seção com cabeçalho)');
  await av(`document.querySelector('.wb-pn-lin[data-sessao="wb-p1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
  conferir(await esperar(`Whiteboard.agentes.cards().some((c) => c.sessao === 'wb-p1')`, 5000), 'duplo clique na sessão cria o card de agente', await av(`Whiteboard.agentes.cards().map((c) => c.sessao)`));
  conferir(await esperar(`document.querySelector('.wb-pn-lin[data-sessao="wb-p1"]')?.dataset.noquadro === '1'`, 4000), 'a sessão aparece marcada no painel');
  await av(`Whiteboard.painel.fechar(); true`);
  // 8.3 menu de botão direito
  const retaC = await av(`(() => { const r = document.querySelector('#whiteboard canvas.wb-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const direito = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  };
  const itensMenu = () => av(`[...document.querySelectorAll('.wb-menu [role=menuitem]')].map((b) => b.textContent.trim()).filter(Boolean)`);
  await av(`Whiteboard.nucleo.selecionar([]); Whiteboard.nucleo.definirCamera({ x: 0, y: 0, zoom: 1 }); true`);
  await dormir(300);
  const vazio = await av(`(() => { const els = Whiteboard.nucleo.elementos(); for (let sy = 560; sy > 100; sy -= 40) for (let sx = 900; sx > 300; sx -= 60) { if (!els.some((e) => sx >= e.x - 10 && sx <= e.x + e.w + 10 && sy >= e.y - 10 && sy <= e.y + e.h + 10)) return { sx, sy }; } return null; })()`);
  await direito(retaC.x + vazio.sx, retaC.y + vazio.sy);
  if (!await esperar(`Whiteboard.menu.aberto()`, 1500)) await direito(retaC.x + vazio.sx, retaC.y + vazio.sy); // 1 repetição: Edge ocupado pode perder o 1º clique
  conferir(await esperar(`Whiteboard.menu.aberto()`, 3000), 'botão direito no vazio abre o menu', vazio);
  const mVazio = await itensMenu();
  conferir(mVazio.some((x) => /Selecionar tudo/.test(x)) && mVazio.some((x) => /navegador/i.test(x)) && mVazio.some((x) => /agente/i.test(x)) && !mVazio.some((x) => /^Travar/.test(x)), 'menu do vazio: selecionar tudo, adicionar navegador e agente, sem Travar', mVazio);
  await tecla('Escape', 'Escape', 27);
  conferir(await esperar(`!Whiteboard.menu.aberto()`, 2000), 'Esc fecha o menu');
  const idRet = await av(`Whiteboard.nucleo.adicionar({ tipo: 'retangulo', x: 700, y: 420, w: 160, h: 90, cor: '#4f8cff', preenchimento: 'rgba(79,140,255,.25)' }).id`);
  await av(`Whiteboard.nucleo.confirmar('ret menu'); true`);
  await direito(retaC.x + 780, retaC.y + 465);
  conferir(await esperar(`Whiteboard.menu.aberto()`, 3000), 'botão direito num card abre o menu');
  const mCard = await itensMenu();
  conferir(mCard.some((x) => /^Travar/.test(x)) && mCard.some((x) => /Copiar/.test(x)) && mCard.some((x) => /Duplicar/.test(x)) && mCard.some((x) => /Excluir|Apagar/.test(x)), 'menu do card: Travar, Copiar, Duplicar, Excluir', mCard);
  conferir(await av(`Whiteboard.nucleo.selecao().includes(${JSON.stringify(idRet)})`), 'botão direito selecionou o card');
  await av(`Whiteboard.menu.fechar(); true`);

  // 8.4 card web + site estático local (porta livre da faixa)
  const { portaLivre, FAIXA } = await import('./porta-livre.mjs');
  let pEst = 0; for (const p of FAIXA) { if (p !== PORTA && await portaLivre(p)) { pEst = p; break; } }
  conferir(pEst > 0, 'achou porta livre da faixa para o site estático de teste');
  const http = await import('node:http');
  const site = http.createServer((rq, rs) => {
    if (rq.url.startsWith('/deny')) { rs.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); rs.end('<h1>negado</h1>'); }
    else { rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); rs.end('<!doctype html><title>Site de teste</title><h1 id="oi">oi</h1>'); }
  });
  if (pEst) await new Promise((ok) => site.listen(pEst, '127.0.0.1', ok));
  try {
    const nWeb0 = await av(`Whiteboard.nucleo.elementos().filter((e) => e.tipo === 'web').length`);
    const rProp = await av(`Whiteboard.web.adicionar(${JSON.stringify(BASE + '/')}, 400, 300)`);
    conferir(rProp === null && (await av(`Whiteboard.nucleo.elementos().filter((e) => e.tipo === 'web').length`)) === nWeb0, 'card web: o próprio Orbit de teste é recusado');
    conferir(await esperar(`/não abre dentro de si mesmo/.test(document.querySelector('.wb-aviso')?.textContent || '')`, 3000), 'recusa mostra o aviso "O Orbit não abre dentro de si mesmo."', await av(`document.querySelector('.wb-aviso')?.textContent`));
    const chk = await (await fetch(BASE + '/navegador/checar', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${pEst}/ok` }) })).json().catch(() => null);
    conferir(!!chk && chk.ok !== false, 'POST /navegador/checar real responde para o site local', chk);
    await av(`window.__webOk = Whiteboard.web.adicionar('http://127.0.0.1:${pEst}/ok', 300, 250); true`);
    conferir(await esperar(`(() => { const f = document.querySelector('.wb-web iframe'); return !!f && (f.src || '').includes(':${pEst}/ok'); })()`, 8000), 'card web carrega o iframe do site local', await av(`document.querySelector('.wb-web')?.outerHTML.slice(0, 400)`));
    const sb = await av(`document.querySelector('.wb-web iframe')?.getAttribute('sandbox') || ''`);
    conferir(/allow-scripts/.test(sb) && !/allow-top-navigation/.test(sb), 'iframe tem o sandbox do Orbit', sb);
    await av(`window.__webNeg = Whiteboard.web.adicionar('http://127.0.0.1:${pEst}/deny', 900, 250); true`);
    conferir(await esperar(`[...document.querySelectorAll('.wb-web-aviso')].some((a) => !a.hidden && /Este site não abre dentro do Orbit/.test(a.textContent))`, 8000), 'site com X-Frame-Options: DENY mostra "Este site não abre dentro do Orbit"', await av(`[...document.querySelectorAll('.wb-web-aviso')].map((a) => a.hidden + ':' + a.textContent.slice(0, 80))`));

    // 8.5 ligação web ↔ agente (sessão de teste não assumida: erro esperado, sem exceção)
    await av(`window.__posts = []; const f0 = window.fetch; window.fetch = function (u) { const p = f0.apply(this, arguments); if (/\\/sessao\\/.*\\/mensagem/.test(String(u))) return p.then((r) => { __posts.push({ u: String(u), s: r.status }); return r; }); return p; }; true`);
    const lig = await av(`Whiteboard.ligacao.ligar(__webOk, 'wb-p1')`);
    conferir(lig === 'ligado', 'ligar card web ao card da sessão devolve "ligado"', lig);
    conferir(await esperar(`__posts.length >= 1`, 6000), 'ligar faz o POST real /sessao/<id>/mensagem', await av(`__posts`));
    const post = await av(`__posts[0]`);
    conferir(post && /\/sessao\/wb-p1\/mensagem$/.test(post.u) && post.s >= 400 && post.s < 500, 'sessão de teste sem assumir devolve erro 4xx (409 esperado)', post);
    conferir(await esperar(`/não recebe mensagens do Orbit|Não deu para avisar/.test(document.querySelector('.wb-lig-toast')?.textContent || '')`, 4000), 'toast de aviso da ligação aparece', await av(`document.querySelector('.wb-lig-toast')?.textContent`));
    conferir(await av(`(Whiteboard.nucleo.elemento(__webOk).web.agentes || []).some((l) => l.id === 'wb-p1')`), 'a ligação fica gravada no card web');
  } finally { await new Promise((ok) => site.close(ok)); }

  // 8.6 exportar
  await av(`Whiteboard.nucleo.selecionar([]); document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`);
  await tecla('E', 'KeyE', 69, 10);
  conferir(await esperar(`Whiteboard.exportar.aberto() && !!document.querySelector('.wb-ex[role=dialog]')`, 4000), 'Ctrl+Shift+E abre o diálogo de exportar');
  await tecla('Escape', 'Escape', 27);
  conferir(await esperar(`!Whiteboard.exportar.aberto()`, 3000), 'Esc fecha o diálogo de exportar');
  const png = await av(`Whiteboard.exportar.png().then((b) => ({ tipo: b.type, n: b.size }))`);
  conferir(png && png.tipo === 'image/png' && png.n > 0, 'exportar.png() devolve image/png com tamanho > 0', png);
  const svgOk = await av(`Whiteboard.exportar.svg().then((s) => { const d = new DOMParser().parseFromString(s, 'image/svg+xml'); return { raiz: d.documentElement.localName, erro: !!d.querySelector('parsererror'), n: d.querySelectorAll('rect,ellipse,path,text').length }; })`);
  conferir(svgOk && svgOk.raiz === 'svg' && !svgOk.erro && svgOk.n > 0, 'exportar.svg() parseia como SVG com formas', svgOk);

  // 8.7 trava + persistência
  await av(`Whiteboard.nucleo.selecionar([${JSON.stringify(idRet)}]); true`);
  await dormir(150);
  await tecla('L', 'KeyL', 76, 10);
  if (!await esperar(`Whiteboard.nucleo.travado(Whiteboard.nucleo.elemento(${JSON.stringify(idRet)}))`, 1500)) await tecla('L', 'KeyL', 76, 10);
  conferir(await esperar(`Whiteboard.nucleo.travado(Whiteboard.nucleo.elemento(${JSON.stringify(idRet)}))`, 3000), 'Ctrl+Shift+L trava o card selecionado', await av(`({ bloq: document.querySelector('.wb-dialogo, .wb-painel')?.className, foco: document.activeElement?.tagName + '.' + document.activeElement?.className, sel: Whiteboard.nucleo.selecao(), ativo: Whiteboard.estado().ativo })`));
  const idQ2 = await av(`Whiteboard.quadro().id`);
  const arq2 = path.join(DADOS, 'whiteboard', idQ2 + '.json');
  let salvoTrav = false;
  for (let i = 0; i < 40 && !salvoTrav; i++) { try { const j = JSON.parse(fs.readFileSync(arq2, 'utf8')); salvoTrav = (j.elementos || []).some((e) => e.id === idRet && e.travado === true); } catch {} if (!salvoTrav) await dormir(150); }
  conferir(salvoTrav, 'travado é gravado em <dados>/whiteboard do servidor de teste');
  await recarregar();
  conferir(await esperar(`window.Whiteboard && Whiteboard.quadro() && !!Whiteboard.nucleo.elemento(${JSON.stringify(idRet)})`, 10000) && await av(`Whiteboard.nucleo.travado(Whiteboard.nucleo.elemento(${JSON.stringify(idRet)}))`), 'recarregar mantém o card travado');

  const semArquivo = (f) => !fs.existsSync(path.join(PROJ, 'assets', f)); // 404 esperado enquanto o módulo não existe
  conferir(consoleErros.filter((x) => !/ouvinte ruim/.test(x)).filter((x) => !(/404/.test(x) && ['whiteboard-agentes.js', 'whiteboard-times.js', 'whiteboard-times.css'].some(semArquivo))).length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, EDGE_PERFIL);
  await dormir(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
