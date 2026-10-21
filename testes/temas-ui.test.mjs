// Teste de ponta a ponta dos temas do VS Code na prévia: servidor de teste numa porta livre
// (47822–47826) + Edge headless mudo. Usa as extensões reais do VS Code (só leitura) com um settings.json FALSO
// dentro de <saída>, para trocar o tema durante o teste sem tocar no VS Code do usuário.
// node testes/temas-ui.test.mjs <pasta-de-saida>   (~30 s; capturas na pasta de saída)
// Precisa do Min Dark (miguelsolorio.min-theme) e do Symbol Icons (miguelsolorio.symbols) instalados.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-temas-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes');
const SETTINGS = path.join(SAIDA, 'vscode-user', 'settings.json');
const DEMO = path.join(SAIDA, 'demo');
for (const d of [DADOS, PERFIL, SESS, DEMO, path.join(SAIDA, 'edge'), path.dirname(SETTINGS)]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS, path.dirname(SETTINGS)]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
const escrever = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
escrever(path.join(DEMO, 'app.ts'), '// comentário do app\nexport const total: number = 42;\nexport function ola(nome: string) {\n  return `Olá, ${nome}!`;\n}\n');
escrever(path.join(DEMO, 'index.html'), '<!doctype html>\n<p class="x">oi</p>\n<script>const a = 1;</script>\n');
escrever(path.join(DEMO, 'package.json'), '{ "name": "demo", "version": "1.0.0" }\n');
escrever(path.join(DEMO, 'README.md'), '# Demo\n\nTexto com [link](https://x.y).\n');
escrever(path.join(DEMO, 'notas.txt'), 'só texto\n');
escrever(path.join(DEMO, 'src', 'pagina.astro'), '---\nconst t = "x";\n---\n<h1>{t}</h1>\n');
const settings = (cor, ico) => escrever(SETTINGS, JSON.stringify({ 'workbench.colorTheme': cor, 'workbench.iconTheme': ico }, null, 2));
settings('Tema Que Não Existe', 'icones-que-nao-existem');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 500))); };

let srv;
async function subir() {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL,
      ORBIT_PASTAS_TEMP: path.join(SAIDA, 'tmp-falso'), GERENCIADOR_VSCODE_SETTINGS: SETTINGS,
      GERENCIADOR_VSCODE_EXT: path.join(os.homedir(), '.vscode', 'extensions') },
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/saude')).ok) return; } catch {} await dormir(150); }
  throw new Error('servidor de teste não subiu');
}
const get = async (p) => { const r = await fetch(BASE + p, { cache: 'no-store' }); return { status: r.status, corpo: await r.json().catch(() => null) }; };
const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, corpo: await r.json().catch(() => null) }; };
async function ate(fn, ms = 6000) { const fim = Date.now() + ms; while (Date.now() < fim) { const v = await fn(); if (v) return v; await dormir(100); } return null; }

let pcdp;
try {
  await subir();
  let r = await post('/projetos/adicionar', { pasta: DEMO });
  conferir((r.status === 200 || r.status === 201) && r.corpo.projeto.nome === 'demo', 'projeto demo adicionado', r);
  r = await get('/temas');
  conferir(r.status === 200 && !r.corpo.cor.ok && !r.corpo.icones.ok, 'temas inexistentes: tudo desligado', r.corpo);
  r = await get('/arquivos/realce?projeto=demo&caminho=app.ts');
  conferir(r.status === 200 && r.corpo.realce === null, 'sem tema: /arquivos/realce devolve null', r.corpo);
  r = await get('/arquivos/realce?projeto=demo&caminho=..%2F..%2Fsegredo.txt');
  conferir(r.status >= 400, 'realce confinado ao projeto', r);

  const EDGE = (await import('./edge.mjs')).caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
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
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await ate(() => av(`!!(window.Arquivos && Arquivos.projetos() && document.querySelector('#projetos .proj-item[data-proj="demo"]'))`), 10000);

  const SEP = '\u001f';
  const linha = (c) => `[...document.querySelectorAll('#projetos .arq-no[data-k]')].find((r) => r.dataset.k === 'demo${SEP}${c}')`;
  // Abre a árvore do projeto e o app.ts.
  await av(`document.querySelector('#projetos .proj-item[data-proj="demo"] .arq-seta').click()`);
  await ate(() => av(`!!${linha('app.ts')}`));
  const icones = () => av(`(() => { const sep = '\\u001f'; const o = {}; for (const r of document.querySelectorAll('#projetos .arq-no[data-k]')) { const ic = r.querySelector('.arq-ico'); const img = ic && ic.querySelector('img'); o[r.dataset.k.split(sep)[1]] = img ? img.getAttribute('src').replace(/\\?.*/, '') : (ic && ic.querySelector('svg') ? 'svg-orbit' : '?'); } return o; })()`);
  let ic = await icones();
  conferir(Object.values(ic).length >= 5 && Object.values(ic).every((v) => v === 'svg-orbit'), 'sem tema de ícones: SVGs do Orbit na árvore', ic);
  await av(`${linha('app.ts')}.click()`);
  await ate(() => av(`!!document.querySelector('.arq-vista:not([hidden]) .arq-codigo')`));
  await dormir(600);
  const codigo = () => av(`(() => { const c = document.querySelector('.arq-vista:not([hidden]) .arq-codigo'); if (!c) return null; const spans = [...c.querySelectorAll('.arq-lt span')];
    const cor = (txt) => { const s = spans.find((x) => x.textContent.includes(txt)); return s ? getComputedStyle(s).color : null; };
    return { realce: c.classList.contains('arq-realce'), tema: c.dataset.tema || null, spans: spans.length, fundo: getComputedStyle(c).backgroundColor, cor: getComputedStyle(c).color,
      comentario: cor('// comentário'), chave: cor('export'), numero: cor('42'), texto: [...c.querySelectorAll('.arq-lt')].map((l) => l.textContent).join('\\n'),
      cab: (() => { const i = document.querySelector('.arq-vista:not([hidden]) .arq-cab > .arq-ico'); const img = i && i.querySelector('img'); return img ? img.getAttribute('src').replace(/\\?.*/, '') : (i && i.querySelector('svg') ? 'svg-orbit' : '?'); })() }; })()`);
  let c = await codigo();
  conferir(c && !c.realce && c.spans === 0 && c.cab === 'svg-orbit', 'sem tema de cores: texto puro e ícone do Orbit no cabeçalho', c);
  conferir(c && c.fundo === 'rgb(20, 20, 20)' && c.cor === 'rgb(212, 212, 212)', 'sem tema: visual atual do Orbit (fundo #141414, texto #d4d4d4)', c);
  await foto('01-sem-tema');

  // Troca no VS Code (settings.json falso) → a página atualiza sozinha pelo SSE.
  settings('Min Dark', 'symbols');
  c = await ate(async () => { const x = await codigo(); return x && x.realce && x.spans > 0 ? x : null; }, 10000);
  conferir(!!c, 'trocar para Min Dark no settings.json pinta a prévia aberta sem recarregar', c);
  const est = (await get('/temas')).corpo;
  conferir(est.cor.ok && est.cor.nome === 'Min Dark' && est.icones.ok && est.icones.nome === 'symbols', 'servidor leu Min Dark e Symbol Icons das extensões instaladas', est);
  if (c) {
    conferir(c.tema === 'Min Dark', 'prévia marcada com o tema', c.tema);
    conferir(c.fundo === 'rgb(20, 20, 20)', 'fundo da área de código continua o do Orbit', c.fundo);
    conferir(c.cor === 'rgb(179, 146, 240)', 'texto padrão na cor do Min Dark (#b392f0)', c.cor);
    conferir(c.chave === 'rgb(249, 117, 131)', 'palavra-chave na cor do Min Dark (#f97583)', c.chave);
    conferir(c.numero === 'rgb(248, 248, 248)', 'número na cor do Min Dark (#f8f8f8)', c.numero);
    const aj = est.cor.ajustes.find((a) => a.de === '#6b737c');
    const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
    conferir(aj && c.comentario === rgb(aj.para), 'comentário com a cor ajustada para contraste', { c: c.comentario, aj });
    conferir(c.texto.startsWith('// comentário do app\nexport const total: number = 42;'), 'texto igual ao arquivo', c.texto.slice(0, 80));
  }
  ic = await ate(async () => { const x = await icones(); return Object.values(x).every((v) => v.startsWith('/temas/icone/')) ? x : null; }, 6000);
  conferir(!!ic, 'árvore com os ícones do Symbol Icons', await icones());
  const mapa = (await get('/temas/icones')).corpo;
  const esperado = (id) => mapa.defs[id] && mapa.defs[id].u;
  if (ic) {
    conferir(ic['app.ts'] === esperado(mapa.fileExtensions.ts), 'app.ts com o ícone de .ts', ic['app.ts']);
    conferir(ic['package.json'] === esperado(mapa.fileNames['package.json']), 'package.json com o ícone por nome', ic['package.json']);
    conferir(ic['src'] === esperado(mapa.folderNames.src || mapa.folder), 'pasta src com o ícone de pasta do tema', ic['src']);
    conferir(ic['notas.txt'] && ic['notas.txt'] !== 'svg-orbit', 'txt com ícone do tema', ic['notas.txt']);
  }
  c = await codigo();
  conferir(c.cab === esperado(mapa.fileExtensions.ts), 'cabeçalho do arquivo aberto com o mesmo ícone', c.cab);
  const imgsOk = await av(`Promise.all([...document.querySelectorAll('.arq-ico-img')].map((i) => i.complete ? i.naturalWidth > 0 : new Promise((ok) => { i.onload = () => ok(true); i.onerror = () => ok(false); })))`);
  conferir(imgsOk.length && imgsOk.every(Boolean), 'todos os ícones carregaram', imgsOk);
  await foto('02-min-dark-symbols');

  // Outras linguagens.
  for (const [arq, txt] of [['index.html', 'const'], ['README.md', '# Demo'], ['src/pagina.astro', 'const']]) {
    if (arq.startsWith('src/')) { await av(`${linha('src')}.click()`); await ate(() => av(`!!${linha(arq)}`)); }
    await av(`${linha(arq)}.click()`);
    const x = await ate(async () => { const y = await av(`(() => { const c = document.querySelector('.arq-vista:not([hidden]) .arq-codigo'); const n = document.querySelector('.arq-vista:not([hidden]) .arq-cab-nome'); return c && n && n.textContent === ${JSON.stringify(path.basename(arq))} && c.classList.contains('arq-realce') ? [...c.querySelectorAll('.arq-lt span')].filter((s) => s.style.color).length : 0; })()`); return y || null; }, 6000);
    conferir(x > 0, `${arq} realçado`, x);
  }
  await foto('03-astro');
  await av(`${linha('notas.txt')}.click()`);
  await dormir(800);
  c = await codigo();
  conferir(c && !c.realce && c.cor === 'rgb(212, 212, 212)', 'txt sem gramática: texto puro do Orbit', c);

  // Volta: tema some → visual do Orbit, ao vivo.
  await av(`${linha('app.ts')}.click()`);
  await ate(async () => { const x = await codigo(); return x && x.realce; });
  settings('Min Dark', null);
  ic = await ate(async () => { const x = await icones(); return Object.values(x).every((v) => v === 'svg-orbit') ? x : null; }, 6000);
  conferir(!!ic, 'iconTheme null: árvore volta para os SVGs do Orbit', await icones());
  c = await codigo();
  conferir(c.realce, 'cores continuam com o Min Dark');
  settings('Tema Que Não Existe', 'symbols');
  c = await ate(async () => { const x = await codigo(); return x && !x.realce ? x : null; }, 6000);
  conferir(c && c.cor === 'rgb(212, 212, 212)' && c.spans === 0, 'tema de cores sumiu: prévia volta ao texto do Orbit', c);
  conferir(!!(await ate(async () => Object.values(await icones()).every((v) => v.startsWith('/temas/icone/')))), 'ícones continuam com o Symbol Icons');

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge'));
  for (const d of [DADOS, PERFIL, SESS, DEMO, path.dirname(SETTINGS)]) fs.rmSync(d, { recursive: true, force: true });
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
