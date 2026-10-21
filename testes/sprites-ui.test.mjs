// Sprites de status dos avatares (17/10): cada estado com o seu sprite (assets/sprites), variante de trabalho
// estável no ciclo, busca retida alguns segundos (sem piscar a cada Grep), troca com fade cruzado e o mesmo sprite
// na lista, nos subagentes, no detalhe e na faixa "Precisa de você".
// Fase 1: servidor real numa porta de teste, dirigido por hooks (POST /evento) e pela status line (POST /uso).
// Fase 2: mock congelado (ROTEIRO=0) para Interrompida e os degraus de contexto com os dados fixos dele.
// Portas só em 47822–47826 (livres) + Edge headless mudo; nunca toca a 47821.
// node testes/sprites-ui.test.mjs <pasta-de-saida>   (~40 s; capturas na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-sprites-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes'), FALSO = path.join(SAIDA, 'projeto-falso');
for (const d of [DADOS, PERFIL, SESS, FALSO, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS, FALSO]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const subir = (args, env) => spawn(process.execPath, args, { cwd: PROJ, stdio: 'ignore', env: { ...process.env, ...env } });

let srv, mock, pcdp;
try {
  for (const n of ['work', 'think', 'cook', 'wizark', 'search', 'music', 'needu', 'done', 'sleep']) conferir(fs.existsSync(path.join(PROJ, 'assets', 'sprites', 'sprite-' + n + '.gif')), 'existe assets/sprites/sprite-' + n + '.gif');
  for (const n of ['done', 'work']) conferir(fs.existsSync(path.join(PROJ, 'assets', 'sprites', 'sprite-' + n + '-parado.png')), 'existe assets/sprites/sprite-' + n + '-parado.png');

  const PORTA = await escolherPorta(47825);
  const BASE = `http://127.0.0.1:${PORTA}`;
  srv = subir([path.join(PROJ, 'servidor.mjs')], { GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const post = (rota, corpo) => fetch(BASE + rota, { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  const hook = (corpo) => post('/evento', { cwd: FALSO, ...corpo });
  const iniciar = async (id, pedido) => { await hook({ session_id: id, hook_event_name: 'SessionStart', source: 'startup' }); if (pedido) await hook({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: pedido }); };
  const pre = (id, tool_name, uid, extra = {}) => hook({ session_id: id, hook_event_name: 'PreToolUse', tool_name, tool_use_id: uid, tool_input: extra.input || {}, ...(extra.agente ? { agent_id: extra.agente } : {}) });
  const posT = (id, tool_name, uid, agente) => hook({ session_id: id, hook_event_name: 'PostToolUse', tool_name, tool_use_id: uid, tool_input: {}, tool_response: {}, ...(agente ? { agent_id: agente } : {}) });

  await iniciar('spr-real', 'Procurar o bug do login');
  await iniciar('spr-ctx', 'Refatorar o servidor');
  await iniciar('spr-mae', 'Delegar a exploração');
  await iniciar('spr-precisa', 'Rodar os testes');
  await iniciar('spr-erro', 'Gerar o relatório');
  await iniciar('spr-rev', 'Escrever o resumo');
  await hook({ session_id: 'spr-rev', hook_event_name: 'Stop', last_assistant_message: 'Pronto.' });
  await iniciar('spr-nova');
  for (let i = 0; i < 10; i++) await iniciar('spr-v' + i, 'Tarefa ' + i);

  const EDGE = caminhoNavegador();
  pcdp = 9600 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${path.join(SAIDA, 'edge')}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1500,1500', 'about:blank'], { stdio: 'ignore' });
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
    if (d.method === 'Network.responseReceived' && /\/assets\/sprites\//.test(d.params.response.url) && d.params.response.status >= 400) consoleErros.push('sprite ' + d.params.response.status + ': ' + d.params.response.url);
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 200));
    return r?.result?.value;
  };
  const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
  const abrir = async (url) => {
    await av(`window.__velha = 1; true`).catch(() => {});
    await cdp('Page.navigate', { url });
    for (let i = 0; i < 100; i++) { await dormir(100); if (await av(`!window.__velha && document.querySelectorAll('#lista .linha[data-id]').length > 0`).catch(() => false)) break; }
    await dormir(500);
  };
  // Sprite (data-gif) do avatar da linha-mãe, de uma linha de subagente e do detalhe.
  const spr = (id) => av(`document.querySelector('#lista .linha:not(.filho)[data-id="${id}"] .av-robo img:not(.av-sai)')?.dataset.gif || null`);
  const sprAg = (agId) => av(`document.querySelector('#lista .linha.filho[data-agente="${agId}"] .av-robo img:not(.av-sai)')?.dataset.gif || null`);
  const sprPk = () => av(`document.querySelector('#pk-av img:not(.av-sai)')?.dataset.gif || null`);

  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
  await abrir(BASE + '/');

  // 1) Busca pelos hooks: Grep em curso → search; terminou → a busca fica ~2,5 s e volta à MESMA variante.
  const variante = await spr('spr-real');
  conferir(/^sprites\/sprite-(work|think)$/.test(variante || ''), 'trabalhando: work ou think', variante);
  await pre('spr-real', 'Grep', 'g1', { input: { pattern: 'login' } });
  await dormir(400);
  conferir(await spr('spr-real') === 'sprites/sprite-search', 'Grep em curso: sprite-search', await spr('spr-real'));
  await posT('spr-real', 'Grep', 'g1');
  await dormir(400);
  conferir(await spr('spr-real') === 'sprites/sprite-search', 'logo depois do Grep a busca continua (sem piscar)', await spr('spr-real'));
  await dormir(2600);
  conferir(await spr('spr-real') === variante, 'vencida a retenção, volta à mesma variante', [await spr('spr-real'), variante]);
  for (const f of ['Edit', 'Bash', 'Read', 'Write']) { await pre('spr-real', f, 'x-' + f); await dormir(120); await posT('spr-real', f, 'x-' + f); await dormir(120); }
  conferir(await spr('spr-real') === variante, 'várias ferramentas no mesmo turno não trocam a variante', await spr('spr-real'));
  await pre('spr-real', 'WebSearch', 'w1', { input: { query: 'gif' } });
  await dormir(300);
  conferir(await spr('spr-real') === 'sprites/sprite-search', 'WebSearch: sprite-search', await spr('spr-real'));
  await posT('spr-real', 'WebSearch', 'w1');

  // 2) Variantes entre sessões: com 10 sessões trabalhando, as duas aparecem.
  const vs = await av(`[...Array(10).keys()].map((i) => document.querySelector('#lista .linha:not(.filho)[data-id="spr-v' + i + '"] .av-robo img')?.dataset.gif)`);
  conferir(vs.every((g) => /sprite-(work|think)$/.test(g || '')) && new Set(vs).size === 2, 'entre sessões, work e think aparecem', vs);

  // 3) Contexto pela status line: >100 mil → wizark; a partir de 150 mil → cook; abaixo → trabalho.
  const ctx = (tokens) => post('/uso', { session_id: 'spr-ctx', context_window: { context_window_size: 1000000, total_input_tokens: tokens } });
  await ctx(90000); await dormir(400);
  conferir(/sprite-(work|think)$/.test(await spr('spr-ctx') || ''), '90 mil tokens: work ou think', await spr('spr-ctx'));
  await ctx(120000); await dormir(400);
  conferir(await spr('spr-ctx') === 'sprites/sprite-wizark', '120 mil tokens: wizark', await spr('spr-ctx'));
  await ctx(150000); await dormir(400);
  conferir(await spr('spr-ctx') === 'sprites/sprite-cook', '150 mil tokens: cook', await spr('spr-ctx'));

  // 4) Esperando: a principal delegou (Agent em curso) e o subagente trabalha → music; subagente no Grep → search.
  await pre('spr-mae', 'Agent', 'ag-tool', { input: { subagent_type: 'Explore', description: 'Explorar o código', prompt: 'Explore' } });
  await hook({ session_id: 'spr-mae', hook_event_name: 'SubagentStart', agent_id: 'ag-x', agent_type: 'Explore' });
  await pre('spr-mae', 'Edit', 'ag-e1', { agente: 'ag-x' });
  await dormir(500);
  conferir(await spr('spr-mae') === 'sprites/sprite-music', 'principal esperando o subagente: sprite-music', await spr('spr-mae'));
  const varAg = await sprAg('ag-x');
  conferir(/sprite-(work|think)$/.test(varAg || ''), 'subagente trabalhando: work ou think', varAg);
  await posT('spr-mae', 'Edit', 'ag-e1', 'ag-x');
  await pre('spr-mae', 'Grep', 'ag-g1', { agente: 'ag-x' });
  await dormir(400);
  conferir(await sprAg('ag-x') === 'sprites/sprite-search', 'subagente no Grep: sprite-search', await sprAg('ag-x'));
  conferir(await spr('spr-mae') === 'sprites/sprite-music', 'a principal segue esperando', await spr('spr-mae'));
  // Detalhe: avatar grande e item do subagente iguais aos da lista; o item é o mesmo nó entre redesenhos.
  await av(`document.querySelector('#lista .linha:not(.filho)[data-id="spr-mae"]').click(); true`);
  await dormir(800);
  conferir(await sprPk() === 'sprites/sprite-music', 'detalhe da principal: sprite-music', await sprPk());
  const item = await av(`(() => { const a = document.querySelector('#pk-agentes .ag-item .av-robo'); window.__avItem = a; return a?.querySelector('img:not(.av-sai)')?.dataset.gif; })()`);
  conferir(item === 'sprites/sprite-search', 'item do subagente no detalhe: sprite-search', item);
  await posT('spr-mae', 'Grep', 'ag-g1', 'ag-x');
  await pre('spr-mae', 'Read', 'ag-r1', { agente: 'ag-x' });
  await dormir(3200);
  const item2 = await av(`(() => { const a = document.querySelector('#pk-agentes .ag-item .av-robo'); return { mesmo: a === window.__avItem, gif: a?.querySelector('img:not(.av-sai)')?.dataset.gif }; })()`);
  conferir(item2.mesmo && item2.gif === varAg, 'no detalhe, o subagente volta à mesma variante no mesmo nó', [item2, varAg]);
  conferir(await sprAg('ag-x') === varAg, 'na lista, o subagente volta à mesma variante', await sprAg('ag-x'));
  await foto('01-esperando-detalhe');
  await av(`document.getElementById('pk-fechar').click(); true`);
  await dormir(300);
  // A principal termina o turno com o subagente ainda rodando (segundo plano) → continua esperando.
  await posT('spr-mae', 'Agent', 'ag-tool');
  await hook({ session_id: 'spr-mae', hook_event_name: 'Stop', last_assistant_message: 'Deixei o agente rodando.' });
  await dormir(500);
  const fundo = await av(`(() => { const l = document.querySelector('#lista .linha:not(.filho)[data-id="spr-mae"]'); return { gif: l?.querySelector('.av-robo img:not(.av-sai)')?.dataset.gif, s: l?.dataset.s }; })()`);
  conferir(fundo.s === 'concluida' && fundo.gif === 'sprites/sprite-music', 'turno concluído com subagente rodando: sprite-music', fundo);
  await posT('spr-mae', 'Read', 'ag-r1', 'ag-x');
  await hook({ session_id: 'spr-mae', hook_event_name: 'SubagentStop', agent_id: 'ag-x', agent_type: 'Explore' });
  await dormir(600);
  const depois = { ag: await sprAg('ag-x'), mae: await spr('spr-mae') };
  conferir(depois.ag === 'sprites/sprite-done' && depois.mae === 'sprites/sprite-done', 'subagente terminou: os dois com sprite-done', depois);

  // 5) Precisa de você e Erro: sprite-needu; selo âmbar "!" e vermelho.
  await hook({ session_id: 'spr-precisa', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  await hook({ session_id: 'spr-erro', hook_event_name: 'StopFailure', error: 'rate_limit' });
  await dormir(500);
  conferir(await spr('spr-precisa') === 'sprites/sprite-needu', 'precisa de você: sprite-needu', await spr('spr-precisa'));
  conferir(await spr('spr-erro') === 'sprites/sprite-needu', 'erro: sprite-needu', await spr('spr-erro'));
  const selos = await av(`(() => { const q = (id) => document.querySelector('#lista .linha:not(.filho)[data-id="' + id + '"] .av-selo'); return { txt: q('spr-precisa')?.textContent, ambar: getComputedStyle(q('spr-precisa')).backgroundColor, erro: getComputedStyle(q('spr-erro')).backgroundColor }; })()`);
  conferir(selos.txt === '!' && /239, 68, 68/.test(selos.erro) && !/239, 68, 68/.test(selos.ambar), 'selo "!" âmbar e vermelho no erro', selos);
  const faixa = await av(`[...document.querySelectorAll('#faixa-acao .fa-card .av-robo img:not(.av-sai)')].map((e) => e.dataset.gif)`);
  conferir(faixa.length >= 1 && faixa.every((g) => g === 'sprites/sprite-needu'), 'cards da faixa "Precisa de você": sprite-needu', faixa);

  // 6) Concluída → done; marcar como revisada → done parado (com fade cruzado na troca).
  conferir(await spr('spr-rev') === 'sprites/sprite-done', 'concluída: sprite-done', await spr('spr-rev'));
  // Linha do tempo da troca (a linha recolhe e reabre em Revisadas): amostra a cada quadro por 1,8 s.
  const linhaTempo = await av(`new Promise((ok) => {
    const out = []; const t0 = performance.now();
    document.querySelector('#lista .linha[data-id="spr-rev"] .rev-chk').click();
    const amostra = () => {
      const a = document.querySelector('#lista .linha:not(.filho)[data-id="spr-rev"] .av-robo');
      const v = a && a.querySelector('img.av-sai'); const n = a && a.querySelector('img:not(.av-sai)');
      out.push({ t: Math.round(performance.now() - t0), clone: v ? { src: v.getAttribute('src'), anim: getComputedStyle(v).animationName, sobre: getComputedStyle(v).gridArea === getComputedStyle(n).gridArea } : null,
        novo: n && n.dataset.gif, entra: !!n && n.classList.contains('av-entra'), conectado: !!(a && a.isConnected), sobras: document.querySelectorAll('#lista .av-robo img.av-sai').length });
      if (performance.now() - t0 < 1800) requestAnimationFrame(amostra); else ok(out);
    };
    amostra();
  })`);
  const comClone = linhaTempo.filter((x) => x.clone);
  conferir(comClone.length > 0 && comClone.every((x) => /sprite-done\.gif/.test(x.clone.src) && x.clone.sobre) && linhaTempo.some((x) => x.clone && x.clone.anim === 'av-sai' && x.entra), 'troca suave: o velho some por cima enquanto o novo entra', linhaTempo.filter((x, i) => i % 6 === 0));
  const ultimo = comClone.length ? comClone[comClone.length - 1].t : -1;
  conferir(ultimo >= 0 && ultimo < 1000 && linhaTempo[linhaTempo.length - 1].sobras === 0, 'o sprite velho sai do DOM em menos de 1 s', { ultimo, fim: linhaTempo[linhaTempo.length - 1] });
  conferir(await spr('spr-rev') === 'sprites/sprite-done-parado', 'revisada: sprite-done parado', await spr('spr-rev'));

  // 7) Nova e encerrada: sprite-sleep (o grupo Encerradas começa recolhido).
  conferir(await spr('spr-nova') === 'sprites/sprite-sleep', 'nova: sprite-sleep', await spr('spr-nova'));
  await hook({ session_id: 'spr-nova', hook_event_name: 'SessionEnd', reason: 'exit' });
  await dormir(500);
  const enc = await av(`(() => { const l = document.querySelector('#lista .linha[data-id="spr-nova"]'); return l && l.offsetParent ? l.querySelector('.av-robo img:not(.av-sai)')?.dataset.gif : 'recolhida'; })()`);
  conferir(enc === 'sprites/sprite-sleep' || enc === 'recolhida', 'encerrada: sprite-sleep (ou no grupo recolhido)', enc);

  // 8) Movimento reduzido: troca seca, sem clone.
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pre('spr-real', 'Glob', 'gl-r');
  await dormir(150);
  conferir(await av(`document.querySelectorAll('#lista .av-robo img.av-sai').length`) === 0 && await spr('spr-real') === 'sprites/sprite-search', 'movimento reduzido: troca sem fade', await spr('spr-real'));
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  await av(`scrollTo(0, 0); true`);
  await foto('02-lista-real');

  // Fase 2: mock congelado — interrompida e os degraus de contexto dos dados fixos.
  const PM = await escolherPorta(47826);
  mock = subir([path.join(PROJ, 'testes', 'mock-servidor.mjs')], { MOCK_PORTA: String(PM), ROTEIRO: '0' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PM}/saude`)).ok) break; } catch {} await dormir(150); }
  await abrir(`http://127.0.0.1:${PM}/`);
  const mk = await av(`(async () => { const d = await (await fetch('/estado')).json(); return d.sessoes.map((s) => ({ id: s.id.slice(0, 8), st: s.status, f: s.ferramenta && s.ferramenta.nome, tk: s.contexto && s.contexto.tokens, ags: (s.agentes || []).filter((a) => a.status === 'trabalhando').length, gif: document.querySelector('#lista .linha[data-id="' + s.id + '"] .av-robo img:not(.av-sai)')?.dataset.gif || null })); })()`);
  const esperar = (s) => {
    if (s.st === 'trabalhando') return s.ags && (s.f === 'Agent' || s.f === 'Task') ? /music/ : /^(Grep|Glob|WebSearch|WebFetch)$/.test(s.f || '') ? /search/ : s.tk >= 150000 ? /cook/ : s.tk > 100000 ? /wizark/ : /sprite-(work|think)$/;
    return { aguardando: /needu/, erro: /needu/, concluida: /sprite-done/, interrompida: /work-parado/, nova: /sleep/, encerrada: /sleep/ }[s.st];
  };
  const errados = mk.filter((s) => s.gif && !esperar(s).test(s.gif));
  conferir(mk.filter((s) => s.gif).length >= 12 && !errados.length, 'mock: cada sessão visível com o sprite do seu estado', errados.length ? errados : mk);
  conferir(mk.some((s) => s.st === 'interrompida' && /work-parado/.test(s.gif || '')), 'mock: interrompida com sprite-work parado', mk.filter((s) => s.st === 'interrompida'));
  conferir(mk.some((s) => /wizark/.test(s.gif || '')) && mk.some((s) => /cook/.test(s.gif || '')), 'mock: wizark e cook nos degraus de contexto', mk.filter((s) => s.st === 'trabalhando'));
  await dormir(1500); // a tela de abertura sai depois da lista desenhada
  await foto('03-lista-mock');

  conferir(consoleErros.length === 0, 'console e rede sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv && srv.kill(); } catch {}
  try { mock && mock.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge'));
  for (const d of [DADOS, PERFIL, SESS, FALSO]) fs.rmSync(d, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
