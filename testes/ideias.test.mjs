// Teste do bloco de ideias (ideias.mjs, assets/ideias.js): servidor de teste numa porta livre (47822–47826),
// Edge headless mudo. A nota vai para <saída>/dados/notas/Ideias.md: nunca toca a 47821.
// node testes/ideias.test.mjs <pasta-de-saida>   (~45 s; capturas 01–07 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-ideias-teste'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes');
for (const d of [DADOS, PERFIL, SESS, path.join(SAIDA, 'edge')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
const NOTA = path.join(DADOS, 'notas', 'Ideias.md');
const COFRE = path.join(PROJ, 'notas', 'Ideias.md'); // a nota de verdade (pasta de dados = pasta do app)
const cofreAntes = fs.existsSync(COFRE) ? fs.readFileSync(COFRE, 'utf8') : null;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const nota = () => (fs.existsSync(NOTA) ? fs.readFileSync(NOTA, 'utf8') : '');

let srv;
async function subir() {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) return; } catch {} await dormir(150); }
  throw new Error('servidor de teste não subiu');
}
const get = async (p) => { const r = await fetch(BASE + p, { cache: 'no-store' }); return { status: r.status, corpo: await r.json().catch(() => null) }; };
const post = async (p, b, cab = true) => { const r = await fetch(BASE + p, { method: 'POST', headers: cab ? { 'x-gerenciador': '1', 'content-type': 'application/json' } : { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, corpo: await r.json().catch(() => null) }; };

let pcdp;
try {
  await subir();
  // ── API ──
  let r = await get('/ideias');
  conferir(r.status === 200 && Array.isArray(r.corpo.ideias) && r.corpo.ideias.length === 0, 'GET /ideias vazio', r);
  conferir(!fs.existsSync(NOTA), 'ler não cria a nota');
  r = await post('/ideias/nova', { texto: 'x' }, false);
  conferir(r.status === 403, 'POST sem x-gerenciador → 403', r);
  r = await post('/ideias/nova', { texto: '   ' });
  conferir(r.status === 400, 'ideia vazia → 400', r);

  // SSE: a mudança chega pelo /fluxo
  const ctl = new AbortController();
  const eventos = [];
  fetch(BASE + '/fluxo', { signal: ctl.signal }).then(async (resp) => {
    const dec = new TextDecoder();
    for await (const c of resp.body) eventos.push(dec.decode(c));
  }).catch(() => {});
  await dormir(300);

  r = await post('/ideias/nova', { texto: '  primeira ideia com quebra  ' });
  conferir(r.status === 200 && r.corpo.ideias.length === 1 && r.corpo.ideias[0].texto === 'primeira ideia com quebra' && /^i-[0-9a-f]{8}$/.test(r.corpo.id), 'nova: espaço das pontas limpo, id próprio', r);
  const id1 = r.corpo.id;
  conferir(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.corpo.ideias[0].data), 'nova tem data e hora', r.corpo.ideias[0]);
  let t = nota();
  conferir(t.startsWith('---\ntipo: ideias') && t.includes('# Ideias') && new RegExp(`^- \\[ \\] \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · primeira ideia com quebra \\^${id1}$`, 'm').test(t), 'nota criada com cabeçalho e a linha no formato', t);
  await dormir(300);
  conferir(eventos.join('').includes('event: ideias') && eventos.join('').includes('primeira ideia com quebra'), 'SSE "ideias" difundido');
  ctl.abort();

  r = await post('/ideias/nova', { texto: 'segunda' });
  const id2 = r.corpo.id;
  conferir(r.corpo.ideias.map((x) => x.texto).join('|') === 'segunda|primeira ideia com quebra', 'a mais nova vai para o topo', r.corpo.ideias);

  // O gestor escreve à mão no cofre: uma ideia sem id e um parágrafo solto.
  fs.writeFileSync(NOTA, nota() + '- [ ] escrita à mão pelo gestor\n\nNota do gestor: revisar na sexta.\n');
  r = await get('/ideias');
  const mao = r.corpo.ideias.find((x) => x.texto === 'escrita à mão pelo gestor');
  conferir(r.corpo.ideias.length === 3 && mao && mao.id.startsWith('h-') && mao.data === '', 'linha escrita à mão aparece (id por conteúdo, sem data)', r.corpo);
  const mao2 = (await get('/ideias')).corpo.ideias.find((x) => x.texto === 'escrita à mão pelo gestor');
  conferir(mao2?.id === mao?.id, 'id por conteúdo é estável entre leituras');
  r = await post('/ideias/editar', { id: mao.id, texto: 'escrita à mão, editada no Orbit' });
  conferir(r.status === 200 && /^i-/.test(r.corpo.id) && r.corpo.ideias.some((x) => x.id === r.corpo.id && x.texto === 'escrita à mão, editada no Orbit'), 'editar linha à mão: ganha id próprio', r);
  t = nota();
  conferir(t.includes('Nota do gestor: revisar na sexta.'), 'texto livre do gestor preservado', t);

  r = await post('/ideias/feita', { id: id1, feita: true });
  conferir(r.status === 200 && r.corpo.ideias.find((x) => x.id === id1)?.feita === true && /^- \[x\] .*primeira ideia/m.test(nota()), 'marcar como feita → [x]', r);
  r = await post('/ideias/feita', { id: id1, feita: false });
  conferir(r.corpo.ideias.find((x) => x.id === id1)?.feita === false, 'desmarcar');
  r = await post('/ideias/editar', { id: id1, texto: '' });
  conferir(r.status === 400, 'editar para vazio → 400 (apagar é outra ação)', r);
  r = await post('/ideias/apagar', { id: id2 });
  conferir(r.status === 200 && !r.corpo.ideias.some((x) => x.id === id2) && !nota().includes('segunda'), 'apagar tira a linha', r);
  r = await post('/ideias/apagar', { id: 'i-naoexiste' });
  conferir(r.status === 404 && /não está mais na nota/.test(r.corpo?.erro), 'id que sumiu → 404 com mensagem', r);
  // Concorrência: várias ao mesmo tempo não se perdem
  await Promise.all(['c1', 'c2', 'c3', 'c4'].map((x) => post('/ideias/nova', { texto: x })));
  r = await get('/ideias');
  conferir(['c1', 'c2', 'c3', 'c4'].every((x) => r.corpo.ideias.some((i) => i.texto === x)), 'quatro gravações simultâneas: nenhuma perdida', r.corpo.ideias.map((x) => x.texto));
  for (const i of r.corpo.ideias.filter((x) => /^c\d$/.test(x.texto))) await post('/ideias/apagar', { id: i.id });
  // Várias linhas: a 1ª no item, as outras recuadas embaixo, o id no fim da última
  r = await post('/ideias/nova', { texto: 'linha **um**\nlinha dois\n\n\n\n- a\n- b ^i-falso' });
  const idM = r.corpo.id;
  conferir(r.corpo.ideias[0].texto === 'linha **um**\nlinha dois\n\n- a\n- b i-falso', 'várias linhas: vazias a mais colapsam, "^i-" do texto não vira id', r.corpo.ideias[0]);
  conferir(new RegExp(`· linha \\*\\*um\\*\\*\\n\\tlinha dois\\n\\n\\t- a\\n\\t- b i-falso \\^${idM}\\n`).test(nota()), 'várias linhas na nota: recuadas com tab, id no fim da última', nota());
  r = await post('/ideias/nova', { texto: '- começa\n- por lista' });
  const idL = r.corpo.id;
  conferir(new RegExp(`^- \\[ \\] \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} ·\\n\\t- começa\\n\\t- por lista \\^${idL}$`, 'm').test(nota()) && r.corpo.ideias[0].texto === '- começa\n- por lista', 'começa por lista: 1ª linha só com a data', nota());
  r = await post('/ideias/feita', { id: idM, feita: true });
  conferir(/^- \[x\] .*linha \*\*um\*\*\n\tlinha dois/m.test(nota()) && r.corpo.ideias.find((x) => x.id === idM).texto.startsWith('linha **um**\nlinha dois'), 'feita mantém as linhas', nota());
  r = await post('/ideias/editar', { id: idM, texto: 'agora uma linha' });
  conferir(!nota().includes('linha dois') && nota().includes(`· agora uma linha ^${idM}`), 'editar troca o bloco inteiro', nota());
  fs.writeFileSync(NOTA, nota() + '- [ ] à mão com sub\n  - sub um\n  - sub dois\nFim solto.\n');
  r = await get('/ideias');
  const sub = r.corpo.ideias.find((x) => x.texto.startsWith('à mão com sub'));
  conferir(sub && sub.texto === 'à mão com sub\n- sub um\n- sub dois' && nota().includes('Fim solto.'), 'à mão: linhas recuadas entram na ideia, o resto não', sub);
  for (const id of [idM, idL, sub && sub.id]) if (id) await post('/ideias/apagar', { id });
  conferir(!nota().includes('sub um') && !nota().includes('por lista') && nota().includes('Fim solto.'), 'apagar tira o bloco inteiro', nota());
  // Reinício: continua tudo lá
  srv.kill(); await dormir(600); await subir();
  r = await get('/ideias');
  conferir(r.corpo.ideias.length === 2, 'depois de reiniciar, as ideias continuam', r.corpo);

  // ── Página ──
  const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${path.join(SAIDA, 'edge')}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon|\/modelos$/.test(d.params.entry.url || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const foto = async (nome) => { const r2 = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64')); };
  const tam = async (w, hgt) => { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: false }); await dormir(400); };
  let mouse = null; // no Edge headless um mouseMoved às vezes leva 5 s: só move quando a posição muda
  const clicar = async (sel) => {
    const c = await av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!c) throw new Error('sem ' + sel);
    if (!mouse || mouse.x !== c.x || mouse.y !== c.y) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    mouse = c;
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await dormir(250);
  };
  const tecla = async (key, code, vk, texto) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(texto ? { text: texto } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await dormir(200);
  };
  const digitar = async (s) => { await cdp('Input.insertText', { text: s }); await dormir(100); };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await tam(1440, 900);
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2200);

  const lat = await av(`(() => { const b = document.getElementById('nav-ideias'); return { tem: !!b && !b.hidden, cont: b.querySelector('[data-ideias-n]').textContent, oculto: document.getElementById('ideias').hidden, abas: !!window.Abas && !!window.Ideias }; })()`);
  conferir(lat.tem && lat.cont === '2' && lat.oculto && lat.abas, 'item Ideias na lateral com contador; nada aberto', lat);
  await foto('01-lateral');

  // ── Abre numa aba própria (não sobre a conversa) ──
  await tecla('i', 'KeyI', 73, 'i');
  await dormir(300);
  const S_ABA = '.aba-painel.aba-ideias .ideias-vista.em-aba';
  let p = await av(`(() => { const a = window.Abas.porChave('ideias'); const v = document.querySelector(${JSON.stringify(S_ABA)}); return { aba: !!a && window.Abas.visivel(a.id), tit: a && document.querySelector('.abas-barra [aria-selected=true]')?.textContent, v: !!v, painel: document.getElementById('ideias').hidden, foco: document.activeElement === v, alinha: v && getComputedStyle(v.querySelector('.id-novo')).textAlign, itens: [...(v?.querySelectorAll('.id-item .id-txt') || [])].map((x) => x.textContent), atual: document.getElementById('nav-ideias').getAttribute('aria-current'), vazou: v?.querySelector('.id-novo').textContent }; })()`);
  conferir(p.aba && /Ideias/.test(p.tit || '') && p.v && p.painel, 'tecla i abre a aba Ideias (o painel lateral fica fechado)', p);
  conferir(p.foco && p.vazou === '' && p.atual === 'page', 'foco na vista (o campo só no clique), "i" não vaza, item da lateral aceso', p);
  conferir(['left', 'start'].includes(p.alinha), 'campo vazio alinhado à esquerda (cursor junto do texto)', p.alinha);
  const pc = await av(`(() => { const l = document.querySelector('${S_ABA} .id-lista'); const c = getComputedStyle(l); const i = l.querySelectorAll('.id-item'); return { raio: c.borderTopLeftRadius, fundo: c.backgroundColor, sombra: c.boxShadow !== 'none', fio: i[1] && getComputedStyle(i[1]).borderTopWidth, fio0: i[0] && getComputedStyle(i[0]).borderTopWidth }; })()`);
  conferir(pc.raio === '14px' && pc.fundo !== 'rgba(0, 0, 0, 0)' && pc.sombra && pc.fio === '1px' && pc.fio0 === '0px', 'notas num cartão, com fio entre elas', pc);
  conferir(p.itens.length === 2, 'mostra as ideias da nota', p.itens);
  await foto('02-aba');
  // Clicar de novo no item não fecha nem duplica
  await clicar('#nav-ideias');
  p = await av(`window.Abas.abas().filter((a) => a.tipo === 'ideias').length`);
  // Clique no campo: o foco vem e o cursor fica à esquerda
  await clicar(`${S_ABA} .id-novo`);
  const p2 = await av(`(() => ({ foco: document.activeElement === document.querySelector('${S_ABA} .id-novo') }))()`);
  conferir(p2.foco, 'clicar no campo dá o foco', p2);
  conferir(p === 1, 'aba única: clicar de novo só ativa', p);

  // ── Anotar com mais de uma linha ──
  await av(`document.querySelector('${S_ABA} .id-novo').focus()`);
  await digitar('ideia anotada pela página');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
  await dormir(150);
  await digitar('segunda linha da ideia');
  await tecla('Enter', 'Enter', 13, '\r');
  await dormir(600);
  p = await av(`[...document.querySelectorAll('${S_ABA} .id-item .id-txt')].map((x) => x.innerText)`);
  conferir(/^ideia anotada pela página\nsegunda linha da ideia$/.test(p[0] || '') && /· ideia anotada pela página\n\tsegunda linha da ideia \^i-/.test(nota()), 'Shift+Enter quebra a linha, Enter anota com as duas linhas na nota', { p, nota: nota() });
  conferir((await av(`document.querySelector('${S_ABA} .id-novo').textContent`)) === '', 'campo limpa depois de anotar');

  // ── Formatação: barra ao selecionar ──
  // Seleciona a palavra `alvo` dentro da 1ª ideia (foca o editor antes, como um clique).
  const selecionar = async (palavra, n = 0) => av(`(() => {
    const ed = document.querySelectorAll('${S_ABA} .id-item .id-txt')[${n}];
    ed.focus();
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let t; while ((t = w.nextNode())) { const i = t.data.indexOf(${JSON.stringify(palavra)}); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + ${palavra.length}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
    return false; })()`);
  const barra = () => av(`(() => { const b = document.querySelector('.idb:not(.idb-sub)'); const r = b.getBoundingClientRect(); return { vis: !b.hidden && r.width > 0, y: Math.round(r.top) }; })()`);
  conferir((await barra()).vis === false, 'sem seleção, sem barra');
  await selecionar('anotada');
  await dormir(200);
  p = await barra();
  conferir(p.vis, 'selecionar um trecho mostra a barra de formatação', p);
  await foto('03-barra');
  await clicar('.idb [data-acao="bold"]');
  await dormir(1100);
  conferir(/· ideia \*\*anotada\*\* pela página\n/.test(nota()), 'Negrito pela barra grava **…** na nota', nota());
  p = await av(`document.activeElement?.classList.contains('id-txt')`);
  conferir(p === true, 'clicar na barra não tira o foco do editor', p);

  await selecionar('pela');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, modifiers: 2 });
  await selecionar('página');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, modifiers: 2 });
  await dormir(1100);
  conferir(/\*\*anotada\*\* \*pela\* <u>página<\/u>\n/.test(nota()), 'Ctrl+I → *…* e Ctrl+U → <u>…</u> na nota', nota());

  await selecionar('segunda');
  await clicar('.idb [data-acao="destaque"]');
  await selecionar('linha');
  await clicar('.idb [data-acao="cores"]');
  p = await av(`document.querySelectorAll('.idb-sub:not([hidden]) .idb-amostra').length`);
  conferir(p === 8, 'Cor abre a paleta (Padrão + 7)', p);
  await foto('04-cores');
  await clicar('.idb-sub [title="Vermelho"]');
  await selecionar('ideia', 0);
  await av(`(() => { const ed = document.querySelectorAll('${S_ABA} .id-item .id-txt')[0]; const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let t, ult; while ((t = w.nextNode())) if (t.data.includes('ideia')) ult = t; const i = ult.data.lastIndexOf('ideia'); const r = document.createRange(); r.setStart(ult, i); r.setEnd(ult, i + 5); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  await clicar('.idb [data-acao="tamanhos"]');
  await clicar('.idb-sub [data-v="5"]');
  await dormir(1100);
  t = nota();
  conferir(/\t==segunda== <span style="color:#e5484d">linha<\/span> da <span style="font-size:1\.25em">ideia<\/span> \^i-/.test(t), 'marca-texto ==…==, cor e tamanho em <span style> na nota', t);
  p = await av(`(() => { const ed = document.querySelectorAll('${S_ABA} .id-item .id-txt')[0]; const sz = [...ed.querySelectorAll('span')].find((x) => x.style.fontSize); return { font: ed.querySelectorAll('font').length, tam: sz && getComputedStyle(sz).fontSize }; })()`);
  conferir(p.font === 0 && p.tam === '17.5px', 'sem <font> no editor; Grande = 1,25em do texto', p);

  // Lista numa ideia: seleciona a 2ª linha e liga a lista
  await selecionar('segunda');
  await clicar('.idb [data-acao="insertUnorderedList"]');
  await dormir(1100);
  conferir(/· ideia \*\*anotada\*\* \*pela\* <u>página<\/u>\n\t- ==segunda== /.test(nota()), 'Lista pela barra → "- " recuado na nota', nota());

  // Esc sai do editor sem fechar a aba; o texto volta desenhado no formato da nota
  await tecla('Escape', 'Escape', 27);
  await dormir(300);
  p = await av(`(() => { const ed = document.querySelectorAll('${S_ABA} .id-item .id-txt')[0]; return { aba: window.Abas.visivel(window.Abas.porChave('ideias').id), foco: document.activeElement?.className, html: [...ed.querySelectorAll('strong,em,u,mark,ul li,span[style]')].map((x) => x.tagName.toLowerCase()).join(',') }; })()`);
  conferir(p.aba && /id-item/.test(p.foco || '') && p.html === 'strong,em,u,li,mark,span,span', 'Esc sai do editor, aba continua; formatação redesenhada', p);
  conferir(!(await barra()).vis, 'sem seleção, a barra some');
  await foto('05-formatada');

  // F5: a aba volta e a formatação vem da nota
  await cdp('Page.reload');
  await dormir(2400);
  p = await av(`(() => { const ed = document.querySelector('${S_ABA} .id-item .id-txt'); return { aba: !!window.Abas.porChave('ideias'), tags: ed ? [...ed.querySelectorAll('strong,em,u,mark,li,span[style]')].map((x) => x.tagName.toLowerCase()).join(',') : null, txt: ed && ed.innerText }; })()`);
  conferir(p.aba && p.tags === 'strong,em,u,li,mark,span,span' && /^ideia anotada pela página\nsegunda linha da ideia$/.test(p.txt), 'F5: a aba volta e a formatação vem da nota', p);

  // Conversor Markdown: ida e volta (o que a página escreve volta igual)
  p = await av(`(() => { const M = window.Ideias._md; const ida = (s) => M.deBlocos(M.paraBlocos(s)); const casos = [
    'texto simples', '**negrito** e *itálico* e ***os dois***', '==destaque== com <u>sub</u>', '<span style="color:#e5484d">vermelho **forte**</span>',
    '<span style="color:#3e8ef7; font-size:1.25em">azul grande</span>', 'linha 1\\nlinha 2', 'antes\\n- a\\n- b\\n\\ndepois', '1. um\\n2. dois',
    'custa \\\\$5 \\\\* 2 \\\\=\\\\= 10', '\\\\- não é lista', '[[Backlog]] e #tag', '**negrito *com itálico* dentro**' ];
    return casos.map((c) => [c, ida(c)]).filter(([a, b]) => a !== b); })()`);
  conferir(p.length === 0, 'conversor: ida e volta sem perda', p);
  p = await av(`(() => { const M = window.Ideias._md; return M.linhaMd([{ t: 'a ', b: true, i: false, u: false, h: false, c: null, s: null }, { t: 'b', b: false, i: false, u: false, h: false, c: null, s: null }]); })()`);
  conferir(p === '**a** b', 'espaço da ponta fica fora da marca (o Obsidian reconhece o fechamento)', p);

  // ── Editar a qualquer momento: grava sozinho ──
  await av(`(() => { const ed = document.querySelector('${S_ABA} .id-item .id-txt'); ed.focus(); const s = getSelection(); const r = document.createRange(); r.selectNodeContents(ed.firstElementChild); r.collapse(false); s.removeAllRanges(); s.addRange(r); })()`);
  await digitar(', revista');
  await dormir(1300);
  conferir(/<u>página(?:<\/u>, revista|, revista<\/u>)\n/.test(nota()), 'edição grava sozinha na pausa (sem botão)', nota());
  // Só focar e sair não regrava a nota
  const antesFoco = nota();
  await av(`document.querySelectorAll('${S_ABA} .id-item .id-txt')[1].focus()`);
  await av(`document.activeElement.blur()`);
  await dormir(500);
  conferir(nota() === antesFoco, 'focar e sair sem mudar não regrava a nota');

  // Feita
  await clicar(`${S_ABA} .id-item .id-check`);
  await dormir(500);
  p = await av(`(() => ({ sep: document.querySelector('${S_ABA} .id-sep')?.textContent, feitas: document.querySelectorAll('${S_ABA} .id-item[data-feita]').length, cont: document.querySelector('#nav-ideias [data-ideias-n]').textContent }))()`);
  conferir(p.sep === 'Feitas' && p.feitas === 1 && /^- \[x\] .*\*\*anotada\*\*/m.test(nota()) && p.cont === '2', 'marcar como feita: vai para "Feitas", [x] na nota, contador só das abertas', p);

  // Apagar: dois cliques
  const antes = await av(`document.querySelectorAll('${S_ABA} .id-item').length`);
  await av(`document.querySelector('${S_ABA} .id-item .id-apagar').focus()`);
  await clicar(`${S_ABA} .id-item .id-apagar`);
  p = await av(`(() => ({ n: document.querySelectorAll('${S_ABA} .id-item').length, conf: !!document.querySelector('${S_ABA} .id-apagar.confirmar') }))()`);
  conferir(p.n === antes && p.conf, 'primeiro clique na lixeira só pede confirmação', p);
  await clicar(`${S_ABA} .id-apagar.confirmar`);
  await dormir(500);
  await dormir(500);
  p = await av(`document.querySelectorAll('${S_ABA} .id-item').length`);
  conferir(p === antes - 1, 'segundo clique apaga', { antes, p });

  // Pé: onde salva
  p = await av(`document.querySelector('${S_ABA} .id-pe').textContent`);
  conferir(/Salvo · Ideias\.md/.test(p), 'pé mostra que está salvo', p);

  // Mudança por fora (outra aba / gestor via API) chega pelo SSE, já formatada
  await post('/ideias/nova', { texto: 'vinda **de fora**' });
  await dormir(800);
  p = await av(`(() => { const ed = [...document.querySelectorAll('${S_ABA} .id-item .id-txt')].find((x) => x.textContent === 'vinda de fora'); return ed ? ed.querySelector('strong')?.textContent : null; })()`);
  conferir(p === 'de fora', 'mudança de fora chega pelo /fluxo, já formatada', p);

  // Ctrl+W fecha a aba; i abre de novo
  await av(`document.querySelector('${S_ABA} .id-novo').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 1 }); // Alt+W
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 1 });
  await dormir(300);
  p = await av(`(() => ({ aba: !!window.Abas.porChave('ideias'), atual: document.getElementById('nav-ideias').getAttribute('aria-current'), painel: document.getElementById('ideias').hidden }))()`);
  conferir(!p.aba && p.atual === null && p.painel, 'Alt+W fecha a aba (o item apaga, o painel não abre)', p);
  await clicar('#nav-ideias');
  p = await av(`!!document.querySelector(${JSON.stringify(S_ABA)}) && document.querySelectorAll('${S_ABA} .id-item').length`);
  conferir(p >= 2, 'clique no item abre a aba de novo com as ideias', p);

  // 420 px: botão na faixa estreita, sem rolagem horizontal
  await tam(420, 860);
  await av(`window.Abas.fechar(window.Abas.porChave('ideias').id)`);
  await clicar('#btn-ideias-e');
  p = await av(`(() => ({ aba: !!document.querySelector(${JSON.stringify(S_ABA)}), rolagem: document.documentElement.scrollWidth > innerWidth, dentro: document.querySelector(${JSON.stringify(S_ABA)}).scrollWidth <= document.querySelector('.aba-painel.aba-ideias').clientWidth }))()`);
  conferir(p.aba && !p.rolagem && p.dentro, '420 px: abre pela faixa estreita, sem rolagem horizontal', p);
  await foto('06-420');
  await tam(1440, 900);

  // Sem as abas (?abas=0): o painel lateral de antes, com o mesmo editor
  await cdp('Page.navigate', { url: BASE + '/?abas=0' });
  await dormir(2200);
  await tecla('i', 'KeyI', 73, 'i');
  p = await av(`(() => { const r = document.getElementById('ideias'); return { aberto: !r.hidden, foco: r.contains(document.activeElement) && document.activeElement !== r.querySelector('.id-novo'), n: r.querySelectorAll('.id-item').length, exp: document.getElementById('nav-ideias').getAttribute('aria-expanded') }; })()`);
  conferir(p.aberto && p.foco && p.n >= 2 && p.exp === 'true', 'sem as abas: tecla i abre o painel lateral', p);
  await foto('07-painel');
  await tecla('Escape', 'Escape', 27);
  p = await av(`(() => ({ aberto: !document.getElementById('ideias').hidden, foco: document.activeElement?.id }))()`);
  conferir(!p.aberto && p.foco === 'nav-ideias', 'Esc fecha o painel e devolve o foco', p);

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge')); // o perfil sai; as capturas ficam
  const cofreDepois = fs.existsSync(COFRE) ? fs.readFileSync(COFRE, 'utf8') : null;
  conferir(cofreDepois === cofreAntes, 'a nota de verdade (pasta do app) não foi tocada');
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
