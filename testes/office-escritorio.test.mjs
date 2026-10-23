// Office em modo escritório (escritórios E1, parte 2b): Office.escritorio(id|null), Office.aoEscritorio(ev), pausa,
// fetch inicial tolerante a falha e marcadores (provisório em CSS x imagem do escritório).
// node testes/office-escritorio.test.mjs
// Servidor estático mínimo (porta por escolherPorta) + página gerada com API falsa de sessões e um fetch falso de
// /escritorios/:id (modos: rodando, pausada, 404, rejeita, lanca, invalido). A imagem de teste é servida pelo servidor
// de teste em /__img/ (nunca em assets/office/escritorios/). Edge headless + CDP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const conferir = (ok, msg) => { console.log((ok ? 'ok   ' : 'FALHA ') + msg); if (!ok) falhas.push(msg); };
const consoleErros = [];
// PNG 1x1 transparente (a "imagem de teste", servida só pelo servidor deste teste).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Office · escritório</title>
<link rel="icon" href="data:,">
<style>html,body{height:100%;margin:0;background:#0a0a0a}#office{width:100vw;height:100vh}</style></head><body><section id="office"></section>
<script>
(function () {
  const T0 = Date.now(), ouv = {}, mapa = new Map(), copia = (o) => JSON.parse(JSON.stringify(o));
  const sess = (o) => Object.assign({ id: '', status: 'concluido', desde: T0, titulo: '', apelido: '', projeto: 'Orbit', cwd: 'D:\\\\x', tarefa: '', primeira: '',
    detalhe: '', ferramenta: null, agentes: [], subagentes: 0, pai: null, vivo: true, atividade: T0, nome: '', controle: null }, o);
  const esc = (id, execucao, papel, papelNome) => ({ modo: 'orbit', escritorio: { id, execucao, papel, papelNome } });
  const add = (o) => mapa.set(o.id, sess(o));
  add({ id: 'm1', nome: 'orq-e1', titulo: 'Orquestrador e1', status: 'trabalhando', controle: esc('e1', 'x1', 'orquestrador', 'Orquestrador') });
  add({ id: 'd1', nome: 'dev-e1', controle: esc('e1', 'x1', 'dev', 'Dev Frontend') });
  add({ id: 'd2', nome: 'qa-e1', controle: esc('e1', 'x1', 'qa', 'Tester QA') });
  add({ id: 'd5', nome: 'velho-e1', controle: esc('e1', 'x0', 'dev', 'Backend Antigo') });      // execução antiga: não aparece
  add({ id: 'm2', nome: 'orq-e2', titulo: 'Orquestrador e2', status: 'trabalhando', controle: esc('e2', 'y1', 'orquestrador', 'Chefe E2') });
  add({ id: 'd6', nome: 'pesq-e2', controle: esc('e2', 'y1', 'pesq', 'Pesquisa E2') });
  const emitir = (s) => (ouv.sessao || []).forEach((f) => f(copia(s)));
  window.__alterar = (id, campos) => { const s = mapa.get(id); for (const k in campos) { if (campos[k] === null) delete s[k]; else s[k] = campos[k]; } s.atividade = Date.now(); emitir(s); };
  window.__agente = (op, id, campos) => {
    const m = mapa.get('m1');
    if (op === 'add') m.agentes.push(Object.assign({ id, tipo: 'general-purpose', descricao: 'Revisao geral do projeto', status: 'trabalhando', inicio: Date.now(), fim: null, ferramenta: null, ferramentas: 0, atividade: Date.now() }, campos));
    else m.agentes = m.agentes.filter((x) => x.id !== id);
    m.atividade = Date.now(); emitir(m);
  };
  window.GerenciadorAPI = {
    sessoes: () => [...mapa.values()].map(copia), sessao: (id) => (mapa.has(id) ? copia(mapa.get(id)) : null),
    eventos: async (id) => ({ sessao: mapa.get(id) || null, eventos: [] }), uso: () => null, config: () => ({}),
    on: (t, fn) => { (ouv[t] = ouv[t] || []).push(fn); return () => {}; }, selecionada: () => null,
  };
  // fetch falso só para /escritorios/:id; o resto vai para o fetch de verdade.
  const fetchOrig = window.fetch.bind(window);
  window.__fetchModo = 'rodando'; window.__fetchChamadas = [];
  window.fetch = (u, o) => {
    u = String(u);
    if (u.indexOf('/escritorios/') !== 0) return fetchOrig(u, o);
    window.__fetchChamadas.push(u);
    const m = window.__fetchModo;
    if (m === 'lanca') throw new Error('fetch lançou');
    if (m === 'rejeita') return Promise.reject(new TypeError('Failed to fetch'));
    if (m === '404') return Promise.resolve(new Response('{}', { status: 404 }));
    if (m === 'invalido') return Promise.resolve(new Response('<html>', { status: 200 }));
    const execucao = { execucao: 'x1', status: m === 'pausada' ? 'pausada' : 'rodando' };
    if (m === 'pausada') execucao.motivoPausa = 'orcamento-dia';
    return Promise.resolve(new Response(JSON.stringify({ escritorio: { id: u.split('/')[2], nome: 'Escritório Teste' }, execucao }), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  window.__robos = () => Office._debug().robos.filter((r) => !r.saindo).map((r) => r.nome).sort();
  window.__todosNoDescanso = () => { const d = Office._debug().robos.filter((r) => !r.saindo); return d.length > 0 && d.every((r) => r.lugar && r.celula[0] === r.lugar[0] && r.celula[1] === r.lugar[1] && !r.andando); };
  window.__quieto = () => { const d = Office._debug(); return d.robos.every((r) => !r.andando && !r.ordens) && d.interacoes.length === 0; };
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/assets/office.css'; document.head.appendChild(css);
  const js = document.createElement('script'); js.src = '/assets/office.js';
  js.onload = () => {
    window.Office.CONFIG.velocidade = 40; window.Office.CONFIG.conversaMs = 700; window.Office.CONFIG.respostaMs = 200;
    const m = () => window.Office.montar(document.getElementById('office'), window.GerenciadorAPI);
    css.sheet ? m() : css.addEventListener('load', m);
  };
  document.head.appendChild(js);
})();
</script></body></html>`;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__office-escritorio.html') { res.writeHead(200, { 'content-type': TIPOS['.html'] }); res.end(PAGINA); return; }
  // Imagens de teste (nunca em assets/office/escritorios/): ok.png e ok@2x.png existem; o resto dá 404.
  if (u.pathname === '/__img/ok.png' || u.pathname === '/__img/ok@2x.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
  const arq = path.normalize(path.join(PASTA, decodeURIComponent(u.pathname)));
  if (!arq.startsWith(PASTA) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(arq).pipe(res);
});

let edge = null, dbg = 0, perfil = '', ws, seq = 0, PORTA = 0;
const pend = new Map();
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
async function esperar(expr, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await avaliar(`!!(${expr})`).catch(() => false)) return true; await dormir(60); }
  return false;
}
const quieto = async (ms = 20000) => {
  const fim = Date.now() + ms;
  let n = 0;
  while (Date.now() < fim) { n = (await avaliar('__quieto()')) ? n + 1 : 0; if (n >= 3) return true; await dormir(80); }
  return false;
};
const alt = (id, campos) => avaliar(`__alterar(${JSON.stringify(id)}, ${JSON.stringify(campos)})`);
const dbgOffice = () => avaliar('Office._debug()');
const nomes = () => avaliar('__robos()');
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const modoFetch = (m) => avaliar(`window.__fetchModo = ${JSON.stringify(m)}`);

try {
  PORTA = await escolherPorta(Number(process.env.OFFICE_PORTA) || 47826);
  await new Promise((r, j) => servidor.listen(PORTA, '127.0.0.1', r).on('error', j));
  dbg = 9800 + Math.floor(Math.random() * 150);
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-office-escritorio-'));
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${perfil}`, '--no-first-run',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 80 && !alvo; i++) {
    try { alvo = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!alvo) await dormir(200);
  }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  // O 404 das imagens de marcador que ainda não existem é esperado (o marcador provisório fica no lugar).
  const esperado = (t) => /__img\/(nao-existe|ok-falta)|assets\/office\/escritorios\//.test(t || '');
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert')) {
      const t = d.params.args.map((a) => a.value ?? a.description).join(' ');
      if (!esperado(t)) consoleErros.push('console: ' + t);
    }
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !esperado(d.params.entry.url) && !esperado(d.params.entry.text)) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  // O Edge headless marca a página como oculta depois de ~15 s (o rAF para): trazê-la para a frente mantém 60 fps.
  globalThis.__frente = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1500);

  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORTA}/__office-escritorio.html` });
  await esperar('window.Office && Office._debug && Office._debug().robos.length >= 1', 20000);
  await quieto();

  // As imagens do escritório: só 'ok.png' existe; 'placa-pausado' e 'icone-cadeado' apontam para ela, o resto para o que não existe.
  await avaliar(`(() => { const A = Office.CONFIG.escritorioAssets;
    for (const k of Object.keys(A)) A[k] = { src: '/__img/nao-existe-' + k + '.png', src2x: '/__img/nao-existe-' + k + '@2x.png' };
    return Object.keys(A).length; })()`);

  // ── fora do modo escritório: a fila e o balcão não aparecem ──
  let d = await dbgOffice();
  conferir(d.escritorio.id === null && d.marcadores && d.marcadores.camada === false && d.marcadores.fila === 0, 'sem escritório: camada de marcadores oculta (fila e balcão só no modo escritório)');
  conferir(await avaliar("!!document.querySelector('.of-marcadores') && document.querySelector('.of-marcadores').hidden === true"), 'sem escritório: .of-marcadores existe e está oculta');

  // ── escritorio(id): time da execução atual, com o papelNome no crachá ──
  await modoFetch('rodando');
  await avaliar("Office.escritorio('e1')");
  conferir(await esperar("window.__fetchChamadas.length >= 1"), 'escritorio(id): busca /escritorios/<id> ao entrar');
  conferir((await avaliar('window.__fetchChamadas[0]')) === '/escritorios/e1', 'escritorio(id): rota certa (/escritorios/e1)');
  const alvoNomes = ['Dev Frontend', 'Orquestrador', 'Tester QA'];
  conferir(await esperar(`__robos().join('|') === ${JSON.stringify(alvoNomes.join('|'))}`), 'escritorio(id): o time é o da execução atual do e1, com papelNome nos crachás: ' + JSON.stringify(await nomes()));
  d = await dbgOffice();
  conferir(d.modo === 'real' && d.escritorio.id === 'e1' && d.escritorio.status === 'rodando', 'escritorio(id): modo real, escritório e1, status rodando');
  conferir(d.robos.find((r) => r.nome === 'Orquestrador')?.funcao === 'mestre', 'escritorio(id): o orquestrador é o líder (função mestre)');
  conferir(d.robos.find((r) => r.nome === 'Dev Frontend')?.funcao === 'frontend' && d.robos.find((r) => r.nome === 'Tester QA')?.funcao === 'tester', 'escritorio(id): função do membro vem do papelNome');
  conferir(!(await nomes()).some((n) => /Antigo|E2/.test(n)), 'escritorio(id): nada de execução antiga nem de outro escritório');
  conferir(d.marcadores.camada === true && d.marcadores.fila === 3 && d.marcadores.balcao === true && d.marcadores.placa === false, 'modo escritório: fila (3 vagas) e balcão aparecem; placa de pausa não');
  conferir(await avaliar("document.querySelectorAll('.of-marcadores .of-prov-fila-espera').length === 3 && !!document.querySelector('.of-marcadores .of-prov-balcao-envio') && getComputedStyle(document.querySelector('.of-marcadores')).display !== 'none'"), 'modo escritório: marcadores provisórios of-prov-fila-espera (x3) e of-prov-balcao-envio visíveis');
  await quieto();

  // convidados (agentes do orquestrador)
  await avaliar("__agente('add', 'cv1', { descricao: 'Pesquisa de referencias', tipo: 'general-purpose' })");
  conferir(await esperar("Office._debug().robos.some((r) => r.origem === 'subagente' && !r.saindo)"), 'escritorio(id): os agentes[] do orquestrador entram como convidados');
  await alt('d1', { status: 'trabalhando', ferramenta: { nome: 'Edit', alvo: 'D:/x/index.html' } });
  conferir(await esperar("(() => { const r = Office._debug().robos.find((x) => x.nome === 'Dev Frontend'); return r && r.estacao && r.celula[0] === r.estacao[0] && r.celula[1] === r.estacao[1] && !r.andando; })()"), 'trabalhando: Dev Frontend vai à estação');
  await quieto();

  // ── pausa e volta pelo aoEscritorio ──
  await avaliar("Office.aoEscritorio({ id: 'e9', resumo: { status: 'pausada' } })");
  await dormir(300);
  conferir((await dbgOffice()).escritorio.pausada === false, 'aoEscritorio: evento de outro escritório é ignorado');
  await avaliar("Office.aoEscritorio({ id: 'e1', resumo: { status: 'pausada' } })");
  conferir(await esperar('__todosNoDescanso()'), 'pausada: todos ao descanso (inclusive quem trabalhava)');
  d = await dbgOffice();
  conferir(d.escritorio.pausada === true && d.marcadores.placa === true, 'pausada: a placa de pausa aparece na porta');
  conferir(await avaliar("(() => { const p = document.querySelector('.of-marcadores .of-prov-placa-pausado'); return !!p && !p.hidden && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width > 4; })()"), 'pausada: o marcador provisório da placa está visível no DOM');
  await avaliar("Office.aoEscritorio({ id: 'e1', resumo: { status: 'rodando' } })");
  conferir(await esperar("(() => { const r = Office._debug().robos.find((x) => x.nome === 'Dev Frontend'); return r && r.estacao && r.celula[0] === r.estacao[0] && r.celula[1] === r.estacao[1] && !r.andando; })()"), 'volta: ao sair de pausada, quem trabalha volta à estação');
  d = await dbgOffice();
  conferir(d.escritorio.pausada === false && d.marcadores.placa === false, 'volta: a placa some');
  await avaliar("Office.aoEscritorio({ id: 'e1', resumo: null })");
  conferir((await dbgOffice()).escritorio.pausada === false, 'aoEscritorio: resumo null não quebra (sem pausa)');

  // ── fetch inicial: pausada vinda do servidor ──
  await avaliar('Office.escritorio(null)');
  await avaliar("__agente('del', 'cv1')");
  await modoFetch('pausada');
  await avaliar("Office.escritorio('e1')");
  conferir(await esperar("Office._debug().escritorio.pausada === true"), 'fetch inicial: execucao.status pausada → pausada');
  d = await dbgOffice();
  conferir(d.escritorio.motivoPausa === 'orcamento-dia' && d.escritorio.nome === 'Escritório Teste', 'fetch inicial: guarda motivoPausa e nome do escritório');
  conferir(await esperar('__todosNoDescanso()'), 'fetch inicial pausada: todos ao descanso');
  conferir((await dbgOffice()).marcadores.placa === true, 'fetch inicial pausada: placa na porta');

  // ── fetch falhando: sem erro, sem placa ──
  for (const m of ['404', 'rejeita', 'lanca', 'invalido']) {
    await avaliar('Office.escritorio(null)');
    await modoFetch(m);
    await avaliar('window.__fetchChamadas.length = 0');
    await avaliar("Office.escritorio('e1')");
    conferir(await esperar('window.__fetchChamadas.length >= 1'), `fetch ${m}: foi tentado`);
    await dormir(500);
    d = await dbgOffice();
    conferir(d.escritorio.id === 'e1' && d.escritorio.pausada === false && d.marcadores.placa === false, `fetch ${m}: tolerado, sem placa`);
    conferir(await esperar(`__robos().join('|') === ${JSON.stringify(alvoNomes.join('|'))}`), `fetch ${m}: o time continua aparecendo`);
  }

  // ── escritório sem execução: vazio, sem cair no demo ──
  await avaliar('Office.escritorio(null)');
  await modoFetch('rodando');
  await avaliar("Office.escritorio('e-vazio')");
  conferir(await esperar("Office._debug().modo === 'real' && __robos().length === 0"), 'escritório sem execução: vazio, no modo real (não cai no demo)');
  await dormir(1500);
  d = await dbgOffice();
  conferir(d.modo === 'real' && d.robos.filter((r) => !r.saindo).length === 0 && d.marcadores.camada === true, 'escritório sem execução: continua vazio e com a fila/balcão do modo escritório');
  // o orquestrador do e2 mostra o time do e2 (e só dele)
  await avaliar("Office.escritorio('e2')");
  conferir(await esperar("__robos().join('|') === 'Chefe E2|Pesquisa E2'"), 'outro escritório (e2): só o time dele: ' + JSON.stringify(await nomes()));
  // o membro ocioso fica no descanso fixo
  conferir(await esperar("(() => { const r = Office._debug().robos.find((x) => x.nome === 'Pesquisa E2'); return r && r.lugar && r.celula[0] === r.lugar[0] && r.celula[1] === r.lugar[1] && !r.andando; })()"), 'o ocioso do e2 fica parado no descanso');

  // ── escritorio(null): volta ao comportamento atual ──
  await avaliar('Office.escritorio(null)');
  conferir(await esperar("Office._debug().escritorio.id === null && Office._debug().marcadores.camada === false"), 'escritorio(null): sai do modo escritório (camada oculta)');
  conferir(await esperar("Office._debug().modo === 'demo'"), 'escritorio(null): sem time com agentes, volta à demonstração');
  conferir(!(await nomes()).some((n) => /Chefe|Pesquisa E2|Dev Frontend/.test(n)), 'escritorio(null): os crachás do escritório saem');
  await avaliar("__agente('add', 'cv2', { descricao: 'Revisao' })");
  conferir(await esperar("Office._debug().modo === 'real' && __robos().includes('Mestre')"), 'escritorio(null): com time normal volta a ser a lógica de sempre (crachá Mestre): ' + JSON.stringify(await nomes()));
  await avaliar("__agente('del', 'cv2')");

  // ── imagens: ausente → marcador provisório; presente → <img> ──
  await avaliar(`(() => { const A = Office.CONFIG.escritorioAssets;
    A['placa-pausado'] = { src: '/__img/ok.png', src2x: '/__img/ok@2x.png' };
    A['icone-cadeado'] = { src: '/__img/ok.png', src2x: '/__img/ok-falta@2x.png' };
    return 1; })()`);
  await modoFetch('pausada');
  await avaliar("Office.escritorio('e1')");
  conferir(await esperar("Office._debug().marcadores.imagens['placa-pausado'] === 'ok' && Office._debug().marcadores.imagens['fila-espera'] === 'falhou'"), 'imagens: sonda marca ok (presente) e falhou (ausente): ' + JSON.stringify((await dbgOffice()).marcadores.imagens));
  conferir(await esperar(`(() => { const p = document.querySelector('.of-marcadores .of-marc-placa-pausado'); return !!p && p.classList.contains('of-img-placa-pausado') && !p.classList.contains('of-prov-placa-pausado') && !!p.querySelector('img.of-marc-img'); })()`), 'imagem presente: a placa vira <img> (of-img-placa-pausado), sem o marcador provisório');
  conferir(await esperar(`(() => { const i = document.querySelector('.of-marcadores .of-marc-placa-pausado img'); return i && /ok@2x\\.png 2x/.test(i.getAttribute('srcset') || '') && i.complete && /ok(@2x)?\.png$/.test(i.currentSrc); })()`), 'imagem presente: usa o @2x no srcset e a imagem carregou (1x1 a 2x tem naturalWidth 0)');
  conferir(await avaliar("document.querySelectorAll('.of-marcadores .of-prov-fila-espera').length === 3 && document.querySelectorAll('.of-marcadores .of-marc-fila-espera img').length === 0"), 'imagem ausente: a fila fica com o marcador provisório (sem <img>)');
  conferir(await avaliar("!!document.querySelector('.of-marcadores .of-prov-balcao-envio') && !document.querySelector('.of-marcadores .of-marc-balcao-envio img')"), 'imagem ausente: o balcão fica com o marcador provisório');
  // cadeado: sem @2x, só o 1x (ícone avulso; no mapa, o pedido externo mostra só o "!" sobre o agente)
  await alt('d2', { status: 'aguardando', controle: { modo: 'orbit', escritorio: { id: 'e1', execucao: 'x1', papel: 'qa', papelNome: 'Tester QA' }, permissao: { externa: true, resumo: 'Publicar' } } });
  conferir(await esperar(`(() => { const e = Office.icone('cadeado'); return !!e && e.classList.contains('of-img-icone-cadeado') && !!e.querySelector('img') && !e.querySelector('img').getAttribute('srcset'); })()`), 'cadeado: imagem presente sem @2x → <img> só com 1x (ícone avulso)');
  conferir(await esperar("Office._debug().robos.some((r) => r.icone === 'espera') && !document.querySelector('.of-ator [class*=cadeado]')"), 'pedido externo: "!" sobre o agente, sem cadeado no robô');
  // ícone de moeda avulso (sem imagem → provisório)
  conferir(await avaliar("(() => { const e = Office.icone('moeda'); return !!e && e.classList.contains('of-prov-icone-moeda') && !e.querySelector('img'); })()"), 'moeda: ícone avulso disponível, provisório quando não há imagem');
  await alt('d2', { status: 'concluido', controle: { modo: 'orbit', escritorio: { id: 'e1', execucao: 'x1', papel: 'qa', papelNome: 'Tester QA' } } });
  await avaliar('Office.escritorio(null)');

  conferir(consoleErros.length === 0, 'sem erros de console' + (consoleErros.length ? ': ' + consoleErros.slice(0, 3).join(' | ') : ''));
} catch (e) {
  falhas.push('exceção: ' + (e.stack || e));
  console.log('FALHA exceção: ' + (e.stack || e));
} finally {
  clearInterval(globalThis.__frente);
  try { ws?.close(); } catch {}
  if (dbg) await fecharEdge(dbg, perfil);
  try { edge?.kill(); } catch {}
  servidor.close();
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
}
console.log(`\n${falhas.length ? 'FALHOU' : 'ok'}: ${falhas.length} falha(s).`);
process.exit(falhas.length ? 1 : 0);
