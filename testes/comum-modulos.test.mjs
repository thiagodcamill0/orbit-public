// Teste dos módulos comuns do celular/PC: assets/comum/{icones,sprites,md,cartoes}.js.
//   node testes/comum-modulos.test.mjs
// Sobe um servidor estático mínimo (porta livre de 47822–47826, nunca a 47821) com uma página de teste (CSP sem script inline)
// que carrega os 4 módulos, e um Edge headless mudo (perfil novo no %TEMP%, fechado por fecharEdge no fim).
// Confere: todos os ícones do index.html existem em OrbitIcones.nomes; markdown renderiza cada recurso e NÃO executa
// <img onerror>/<script>/javascript: vindos do texto; os 3 cartões (s1 Bash, s2 pergunta, s3 plano, como em
// testes/mobile-mock.mjs) montam e o clique gera o corpo esperado em api.responder; sprites trocam para o quadro parado
// com movimento reduzido emulado e fazem o fade cruzado sem ele; zero erro de console e de CSP.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta, portaLivre } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const conferir = (nome, ok, detalhe) => { checks.push({ nome, ok: !!ok, detalhe: ok ? undefined : detalhe }); };
const igual = (nome, obtido, esperado) => conferir(nome, JSON.stringify(obtido) === JSON.stringify(esperado), 'obtido ' + JSON.stringify(obtido) + ', esperado ' + JSON.stringify(esperado));

// ───── dados de exemplo (os de testes/mobile-mock.mjs: s1 Bash, s2 pergunta, s3 plano) ─────
const S1 = { id: 'perm-1', tipo: 'ferramenta', ferramenta: 'Bash', resumo: 'npm test -- --grep pareamento', entrada: { command: 'npm test -- --grep pareamento' }, sugestoes: [{ indice: 0, rotulo: 'Sempre permitir npm test' }] };
const S2 = { id: 'perm-2', tipo: 'pergunta', ferramenta: 'AskUserQuestion', resumo: 'Qual banco usar?', perguntas: [{ pergunta: 'Qual banco usar?', cabecalho: 'Banco', multipla: false, opcoes: [{ rotulo: 'SQLite', descricao: 'Arquivo local, sem servidor' }, { rotulo: 'Postgres', descricao: 'Servidor dedicado' }] }] };
const S3 = { id: 'perm-3', tipo: 'plano', ferramenta: 'ExitPlanMode', resumo: 'Plano', plano: '## Plano\n\n- Criar a tela de **checkout**\n- Ligar ao `POST /pedidos`\n- Rodar os testes', sugestoes: [{ indice: 0, rotulo: 'Sim, e aceitar edições', modo: 'acceptEdits' }] };

// ───── ícones usados pelo index.html (desde a onda 2 ele usa o OrbitIcones; aqui, os nomes literais de icone('…')) ─────
function iconesDoIndex() {
  const src = fs.readFileSync(path.join(PASTA, 'index.html'), 'utf8');
  return [...new Set([...src.matchAll(/icone\('([a-z0-9-]+)'/g)].map((m) => m[1]))];
}

// ───── servidor estático mínimo ─────
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>comum</title></head><body><div id="raiz"></div>
<script src="/assets/comum/icones.js"></script><script src="/assets/comum/sprites.js"></script><script src="/assets/comum/md.js"></script><script src="/assets/comum/cartoes.js"></script></body></html>`;
const MODULOS = new Set(['icones', 'sprites', 'md', 'cartoes']);
function subirServidor(porta) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/assets\/comum\/(\w+)\.js$/.exec(u.pathname);
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'" });
      res.end(PAGINA);
    } else if (m && MODULOS.has(m[1])) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(PASTA, 'assets', 'comum', m[1] + '.js')));
    } else if (/^\/(anim|anim2)\.gif$/.test(u.pathname)) {
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      res.end(GIF);
    } else { res.writeHead(u.pathname === '/favicon.ico' ? 204 : 404); res.end(); }
  });
  return new Promise((ok, falha) => { srv.once('error', falha); srv.listen(porta, '127.0.0.1', () => ok(srv)); });
}

// ───── CDP ─────
let ws, seq = 0;
const pend = new Map();
const consoleErros = [];
const cdp = (method, params = {}) => new Promise((r, rej) => {
  const id = ++seq;
  const t = setTimeout(() => { pend.delete(id); rej(new Error('CDP sem resposta em 20 s: ' + method + ' ' + String(params.expression || '').slice(0, 80))); }, 20000);
  pend.set(id, (d) => { clearTimeout(t); r(d); });
  ws.send(JSON.stringify({ id, method, params }));
});
async function conectar(portaCdp) {
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) {
    try { alvo = (await (await fetch(`http://127.0.0.1:${portaCdp}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!alvo) await dormir(200);
  }
  if (!alvo) throw new Error('Edge não abriu');
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) consoleErros.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && ['error', 'warning'].includes(d.params.entry.level)) consoleErros.push(`${d.params.entry.source}: ${d.params.entry.text} ${d.params.entry.url || ''}`);
  };
}
const avaliar = async (expr) => {
  const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
  if (r?.exceptionDetails) throw new Error('avaliar: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r?.result?.value;
};
const rodar = (fn, ...args) => avaliar(`(${fn.toString()})(...${JSON.stringify(args)})`);

// ───── código que roda na página ─────
function paginaIcones() {
  const O = window.OrbitIcones;
  const v = O.icone('check', 20);
  const sem = O.icone('nao-existe');
  return {
    chaves: Object.keys(O).sort(), nomes: O.nomes, ns: v.namespaceURI, tag: v.tagName.toLowerCase(), tam: v.getAttribute('width'), traco: v.getAttribute('stroke-width'),
    cor: v.getAttribute('stroke'), caminhos: v.querySelectorAll('path').length, filhosDesconhecido: sem.childNodes.length, padrao: O.icone('busca').getAttribute('width'),
    todosDesenham: O.nomes.filter((n) => !O.icone(n).firstChild),
  };
}

function paginaMd() {
  window.__pwn = undefined;
  const texto = [
    '# Título um', '', 'Parágrafo com **negrito**, *itálico*, _outro_, `código` e [site](https://exemplo.com/a?b=1) e [mail](mailto:a@b.com) e [mau](javascript:window.__pwn=3) e https://orbit.dev/x.',
    'segunda linha do parágrafo e snake_case_nome intacto', '', '- um', '  - dois aninhado', '- três', '', '1. a', '2. b', '', '> citação **forte**', '',
    '```js', 'const x = 1;', '<b>não é html</b>', '```', '', '| A | B |', '|---|:-:|', '| 1 | **2** |', '| 3 | 4 |', '',
    '<img src=x onerror="window.__pwn=1"> <script>window.__pwn=2</script>', '[img](data:text/html,<script>window.__pwn=4</script>)', '---', 'fim',
  ].join('\n');
  const frag = window.OrbitMd.render(texto);
  const raiz = document.getElementById('raiz');
  const caixa = document.createElement('div');
  caixa.id = 'md-teste';
  caixa.append(frag);
  raiz.append(caixa);
  const q = (s) => [...caixa.querySelectorAll(s)];
  const links = q('a').map((a) => ({ href: a.getAttribute('href'), alvo: a.target, rel: a.rel, t: a.textContent }));
  const tabela = caixa.querySelector('.md-tabela');
  return {
    ehFragmento: frag instanceof DocumentFragment, titulo: q('.md-h').map((e) => e.textContent), strong: q('strong').map((e) => e.textContent), em: q('em').map((e) => e.textContent),
    codeInline: q('p code').map((e) => e.textContent), links, perigosos: q('a').filter((a) => /^\s*(javascript|data|vbscript):/i.test(a.getAttribute('href'))).length,
    spanLink: q('.md-link').map((e) => e.textContent), spanUrl: q('.md-url').map((e) => e.textContent),
    ul: q('ul').length, liAninhado: q('ul ul > li').map((e) => e.textContent), ol: q('ol > li').length, cit: q('blockquote strong').length,
    bloco: q('.md-codigo pre code').map((e) => e.textContent), copiar: q('.md-codigo button.md-copiar').length, lang: q('.md-lang').map((e) => e.textContent),
    tabelaDentro: !!(tabela && tabela.querySelector('table')), overflow: tabela && tabela.style.overflowX, th: q('th').map((e) => e.textContent), td: q('td').length, tdStrong: q('td strong').length, alinhaTh: q('th')[1] && q('th')[1].style.textAlign,
    img: q('img').length, script: q('script').length, hr: q('hr').length, pwn: window.__pwn === undefined ? null : window.__pwn,
    textoLiteral: caixa.textContent.includes('<img src=x onerror=') && caixa.textContent.includes('<script>window.__pwn=2</script>'),
    underscore: caixa.textContent.includes('snake_case_nome'), brs: q('p br').length,
    htmlNoCodigo: q('.md-codigo code')[0].textContent.includes('<b>não é html</b>') && !q('.md-codigo b').length,
    vazio: window.OrbitMd.render('').childNodes.length + window.OrbitMd.render(null).childNodes.length,
  };
}

async function paginaCopiar() {
  const bloco = document.querySelector('#md-teste .md-codigo');
  const btn = bloco.querySelector('.md-copiar');
  const copiados = [];
  const antes = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { copiados.push(t); return Promise.resolve(); } } });
  btn.click();
  await new Promise((r) => setTimeout(r, 60));
  const viaApi = { copiados, rotulo: btn.textContent };
  // sem Clipboard API: seleciona o código
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  btn.click();
  await new Promise((r) => setTimeout(r, 60));
  const viaSelecao = { rotulo: btn.textContent, selecionado: getSelection().toString().includes('const x = 1;') };
  if (antes) Object.defineProperty(Navigator.prototype, 'clipboard', antes);
  delete navigator.clipboard;
  return { viaApi, viaSelecao };
}

async function paginaCartoes(S1, S2, S3) {
  const C = window.OrbitCartoes;
  const raiz = document.getElementById('raiz');
  const toasts = [];
  const respostas = [];
  let modo = 'ok';
  const api = {
    responder: (corpo) => { respostas.push(JSON.parse(JSON.stringify(corpo))); if (modo === 'erro') return Promise.reject(Object.assign(new Error('falhou'), { status: 500 })); if (modo === '409') return Promise.reject(Object.assign(new Error('ja'), { status: 409 })); return Promise.resolve({ ok: true }); },
    icone: window.OrbitIcones.icone, md: window.OrbitMd.render, toast: (t) => toasts.push(t), confirmar: () => Promise.resolve(true),
  };
  const espera = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const digitar = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  const botao = (cart, t) => [...cart.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
  const out = { tipos: [C.tipoPermissao(S1), C.tipoPermissao(S2), C.tipoPermissao(S3), C.tipoPermissao({ ferramenta: 'AskUserQuestion', perguntas: [] }), C.tipoPermissao({ ferramenta: 'ExitPlanMode' }), C.tipoPermissao({ ferramenta: 'Bash' })] };
  const montar = (p, opc) => { const el = C.cartao(p, api, opc); raiz.append(el); return el; };
  const ultimo = () => respostas[respostas.length - 1];
  const botoesFora = (el) => [...el.querySelectorAll('button')].filter((b) => !/(^|\s)(btn|link)(\s|$)/.test(b.className)).length;

  // ── s1: ferramenta
  let c = montar(S1, { fila: 2 });
  out.s1 = { tipo: c.dataset.tipo, titulo: c.querySelector('.ct-titulo').textContent, chip: c.querySelector('.ct-chip').textContent, resumo: c.querySelector('.ct-resumo').textContent, entrada: c.querySelector('.ct-det pre').textContent.includes('npm test'), fila: c.querySelector('.ct-fila').textContent, sugs: c.querySelectorAll('.ct-sug').length, botoesFora: botoesFora(c), icone: !!c.querySelector('.ct-ico svg') };
  c.atualizarFila(1); out.s1.fila1 = c.querySelector('.ct-fila').textContent;
  let evento = null; c.addEventListener('ct-respondido', (e) => { evento = e.detail; });
  const bPermitir = botao(c, 'Permitir'); bPermitir.click(); await espera();
  out.s1.permitir = ultimo(); out.s1.toastPermitir = toasts[toasts.length - 1]; out.s1.evento = evento; out.s1.bloqueado = bPermitir.disabled; out.s1.estado = c.dataset.estado;
  c.remove();
  c = montar(S1); botao(c, 'Sempre permitir npm test').click(); await espera(); out.s1.sugestao = ultimo(); c.remove();
  c = montar(S1); botao(c, 'Negar').click(); await espera(); out.s1.negar = ultimo(); c.remove();
  c = montar(S1);
  const link = c.querySelector('.ct-link'); link.click();
  const campo = c.querySelector('.ct-campo input'); out.s1.campoVisivel = !c.querySelector('.ct-campo').hidden; out.s1.rotuloNegar = botao(c, 'Negar com o motivo') ? 'Negar com o motivo' : null;
  digitar(campo, '  perigoso demais  '); botao(c, 'Negar com o motivo').click(); await espera(); out.s1.motivo = ultimo(); c.remove();
  // erro de rede: reabilita e mostra o erro; 409: avisa e termina
  modo = 'erro'; c = montar(S1); botao(c, 'Permitir').click(); await espera();
  out.s1.erro = { texto: c.querySelector('.ct-erro').textContent, visivel: !c.querySelector('.ct-erro').hidden, reabilitado: !botao(c, 'Permitir').disabled, rotulo: botao(c, 'Permitir').textContent, estado: c.dataset.estado || null }; c.remove();
  modo = '409'; c = montar(S1); botao(c, 'Permitir').click(); await espera();
  out.s1.conflito = { toast: toasts[toasts.length - 1], estado: c.dataset.estado }; c.remove(); modo = 'ok';

  // ── s2: pergunta
  c = montar(S2);
  const resp = botao(c, 'Responder');
  out.s2 = { tipo: c.dataset.tipo, titulo: c.querySelector('.ct-titulo').textContent, tag: c.querySelector('.ct-q-tag').textContent, radios: c.querySelectorAll('input[type=radio]').length, outra: !!c.querySelector('.ct-op-outra'), desc: c.querySelector('.ct-op-desc').textContent, desabilitado: resp.getAttribute('aria-disabled'), botoesFora: botoesFora(c) };
  const antesN = respostas.length; resp.click(); await espera();
  out.s2.semResposta = { enviou: respostas.length !== antesN, erro: c.querySelector('.ct-erro').textContent, visivel: !c.querySelector('.ct-erro').hidden };
  c.querySelector('input[value="0"]').click();
  out.s2.habilitado = resp.getAttribute('aria-disabled');
  resp.click(); await espera(); out.s2.sqlite = ultimo(); c.remove();
  c = montar(S2); c.querySelector('input[value="outra"]').click();
  const livre = c.querySelector('.ct-livre'); out.s2.livreVisivel = !livre.hidden; botao(c, 'Responder').click(); await espera();
  out.s2.outraVazia = c.querySelector('.ct-erro').textContent;
  digitar(livre, ' Mongo '); botao(c, 'Responder').click(); await espera(); out.s2.mongo = ultimo(); c.remove();
  c = montar(S2); botao(c, 'Não responder').click(); await espera(); out.s2.recusa = ultimo(); c.remove();
  const MULTI = { id: 'perm-m', ferramenta: 'AskUserQuestion', perguntas: [{ pergunta: 'Quais?', multipla: true, opcoes: [{ rotulo: 'A' }, { rotulo: 'B' }, { rotulo: 'C' }] }, { pergunta: 'Cor?', opcoes: [{ rotulo: 'Azul' }] }] };
  c = montar(MULTI);
  out.s2.multiTitulo = c.querySelector('.ct-titulo').textContent; out.s2.multiCaixas = c.querySelectorAll('input[type=checkbox]').length;
  const qs = c.querySelectorAll('.ct-q');
  qs[0].querySelector('input[value="2"]').click(); qs[0].querySelector('input[value="0"]').click(); qs[0].querySelector('input[value="outra"]').click();
  digitar(qs[0].querySelector('.ct-livre'), 'D');
  botao(c, 'Responder').click(); await espera(); out.s2.multiFalta = c.querySelector('.ct-erro').textContent;
  qs[1].querySelector('input[value="0"]').click(); botao(c, 'Responder').click(); await espera(); out.s2.multi = ultimo(); c.remove();

  // ── s3: plano
  c = montar(S3);
  out.s3 = { tipo: c.dataset.tipo, titulo: c.querySelector('.ct-titulo').textContent, md: !!c.querySelector('.ct-plano .md-h') && c.querySelectorAll('.ct-plano strong').length === 1 && c.querySelectorAll('.ct-plano li code').length === 1, botoes: [...c.querySelectorAll('.ct-botoes button')].map((b) => b.textContent.trim()), botoesFora: botoesFora(c) };
  botao(c, 'Aprovar').click(); await espera(); out.s3.aprovar = ultimo(); c.remove();
  c = montar(S3); botao(c, 'Aprovar e aceitar edições').click(); await espera(); out.s3.aceitar = ultimo(); c.remove();
  c = montar(S3);
  const cont = botao(c, 'Continuar planejando'); cont.click();
  const area = c.querySelector('.ct-campo textarea'); out.s3.areaVisivel = !c.querySelector('.ct-campo').hidden; out.s3.rotuloContinuar = cont.textContent;
  digitar(area, 'Use Postgres'); cont.click(); await espera(); out.s3.continuar = ultimo(); c.remove();
  c = montar(S3); botao(c, 'Continuar planejando').click(); botao(c, 'Enviar e continuar planejando').click(); await espera(); out.s3.continuarVazio = ultimo(); c.remove();
  c = montar({ id: 'perm-x', tipo: 'plano', entrada: { plan: 'Só `entrada.plan`' } }); out.s3.deEntrada = c.querySelector('.ct-plano code') && c.querySelector('.ct-plano code').textContent; c.remove();
  c = montar({ id: 'perm-y', tipo: 'plano' }); out.s3.semTexto = c.querySelector('.ct-plano em') && c.querySelector('.ct-plano em').textContent; c.remove();
  c = montar({ id: 'perm-z', tipo: 'plano', plano: 'x', sugestoes: [{ indice: 3, rotulo: 'Sim, sempre rodar testes' }] }); botao(c, 'Sim, sempre rodar testes').click(); await espera(); out.s3.outraSugestao = ultimo(); c.remove();
  out.sobras = raiz.querySelectorAll('.ct-cartao').length;
  out.total = respostas.length;
  return out;
}

async function paginaSprites(fase) {
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = fase === 'novo' ? (window.__S = window.OrbitSprites.criar({ base: '/', versoes: { anim: 2 }, estaticos: { fixo: '/fixo.png' } })) : window.__S;
  const r = { padrao: Object.keys(window.OrbitSprites).sort() };
  if (fase === 'novo') {
    r.reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
    r.antes = S.srcGif('anim');
    r.estatico = S.srcGif('fixo'); r.png = S.srcGif('x/y.png'); r.url = S.srcGif('/abs/a.gif');
    const q = await S.preparar('anim');
    r.quadro = typeof q === 'string' ? q.slice(0, 5) : q;
    r.depois = S.srcGif('anim').slice(0, 5);
    r.quadroPng = await new Promise((ok) => { const im = new Image(); im.onload = () => ok(im.naturalWidth > 0 ? 'carrega' : 'vazio'); im.onerror = () => ok('erro'); im.src = S.quadroParado('anim'); });
    const img = document.createElement('img');
    document.getElementById('raiz').append(img);
    S.definir(img, 'anim');
    r.imgSrc = img.src.slice(0, 5); r.dataGif = img.dataset.gif;
    // troca com movimento reduzido: direto, sem clone
    await S.trocarSprite(img, 'anim'); const p = S.trocarSprite(img, 'anim2');
    r.filhosReduzido = img.parentNode.querySelectorAll('img').length; await p;
    r.srcTrocado = img.getAttribute('src');
    r.dataTrocado = img.dataset.gif;
    img.remove();
  } else {
    r.reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
    r.srcGif = S.srcGif('anim');
    const grade = document.createElement('span');
    grade.style.display = 'grid';
    const img = document.createElement('img');
    img.width = 35; img.height = 35;
    grade.append(img);
    document.getElementById('raiz').append(grade);
    await S.trocarSprite(img, 'anim');
    const t0 = performance.now();
    const p = S.trocarSprite(img, 'anim2');
    await dormir(5);
    const velho = grade.querySelector('img.av-sai');
    r.clone = !!velho; r.filhos = grade.querySelectorAll('img').length; r.velhoSrc = velho && velho.getAttribute('src'); r.novoSrc = img.getAttribute('src');
    r.animando = img.getAnimations().length;
    await p;
    r.ms = Math.round(performance.now() - t0);
    r.sobrou = grade.querySelectorAll('img').length;
    // troca repetida rápida: nada fica pendurado
    const a = S.trocarSprite(img, 'anim'); const b = S.trocarSprite(img, 'anim2'); await Promise.all([a, b]); await dormir(20);
    r.semLixo = grade.querySelectorAll('img').length;
    grade.remove();
  }
  return r;
}

// ───── execução ─────
let servidor = null, edge = null, perfil = null, portaCdp = 0;
try {
  const porta = await escolherPorta(47822);
  if (porta === 47821) throw new Error('nunca a 47821');
  servidor = await subirServidor(porta);
  do { portaCdp = 9850 + Math.floor(Math.random() * 130); } while (!(await portaLivre(portaCdp)));
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-comum-'));
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${portaCdp}`, `--user-data-dir=${perfil}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar(portaCdp);
  for (const d of ['Page', 'Runtime', 'Log']) await cdp(d + '.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${porta}/` });
  for (let i = 0; i < 50; i++) { if (await avaliar('!!(window.OrbitIcones && window.OrbitSprites && window.OrbitMd && window.OrbitCartoes)').catch(() => false)) break; await dormir(100); }
  conferir('os 4 módulos carregam e definem só a sua janela', await avaliar('!!(window.OrbitIcones && window.OrbitSprites && window.OrbitMd && window.OrbitCartoes)'));

  // ícones
  const doIndex = iconesDoIndex();
  const ic = await rodar(paginaIcones);
  conferir('index.html usa ícones (>= 20 nomes literais)', doIndex.length >= 20, doIndex.length);
  igual('todos os ícones usados no index.html existem em OrbitIcones.nomes', doIndex.filter((n) => !ic.nomes.includes(n)), []);
  conferir('o celular ganhou os ícones que só ele tinha', ['enviar', 'foto', 'uso', 'aparelho', 'visao'].every((n) => ic.nomes.includes(n)), ic.nomes.join());
  igual('API de ícones', ic.chaves, ['icone', 'nomes']);
  igual('SVG do ícone: namespace, tamanho, traço 1,5, currentColor, caminho', [ic.ns, ic.tag, ic.tam, ic.traco, ic.cor, ic.caminhos], ['http://www.w3.org/2000/svg', 'svg', '20', '1.5', 'currentColor', 1]);
  igual('nome desconhecido: svg vazio; tamanho padrão 16', [ic.filhosDesconhecido, ic.padrao], [0, '16']);
  igual('todo ícone desenha algo', ic.todosDesenham, []);

  // markdown
  const md = await rodar(paginaMd);
  conferir('md: devolve DocumentFragment', md.ehFragmento);
  igual('md: título', md.titulo, ['Título um']);
  igual('md: negrito (inclui o da citação e da tabela)', md.strong, ['negrito', 'forte', '2']);
  igual('md: itálico (* e _) e snake_case intacto', [md.em, md.underscore], [['itálico', 'outro'], true]);
  igual('md: código inline', md.codeInline, ['código']);
  igual('md: links só http(s) e mailto, com target e rel', md.links.map((l) => [l.href, l.alvo, l.rel]), [
    ['https://exemplo.com/a?b=1', '_blank', 'noopener noreferrer'], ['mailto:a@b.com', '_blank', 'noopener noreferrer'], ['https://orbit.dev/x', '_blank', 'noopener noreferrer']]);
  igual('md: javascript:/data: viram texto, nunca link', [md.perigosos, md.spanLink, md.spanUrl.length], [0, ['mau', 'img'], 2]);
  igual('md: listas, aninhada e ordenada', [md.ul, md.liAninhado, md.ol], [2, ['dois aninhado'], 2]);
  igual('md: citação com inline', md.cit, 1);
  igual('md: bloco de código (sem html) com linguagem e botão Copiar', [md.bloco, md.copiar, md.lang, md.htmlNoCodigo], [['const x = 1;\n<b>não é html</b>'], 1, ['js'], true]);
  igual('md: tabela em contêiner com rolagem lateral', [md.tabelaDentro, md.overflow, md.th, md.td, md.tdStrong, md.alinhaTh], [true, 'auto', ['A', 'B'], 4, 1, 'center']);
  igual('md: quebra de linha e régua', [md.brs >= 1, md.hr], [true, 1]);
  igual('md: <img onerror>, <script> e javascript: não viram nós nem executam', [md.img, md.script, md.pwn, md.textoLiteral], [0, 0, null, true]);
  igual('md: texto vazio/nulo', md.vazio, 0);
  await dormir(150);
  igual('md: nada executou depois de um tempo', await avaliar('window.__pwn === undefined'), true);
  const cp = await rodar(paginaCopiar);
  igual('md: Copiar usa navigator.clipboard', [cp.viaApi.copiados, cp.viaApi.rotulo], [['const x = 1;\n<b>não é html</b>'], 'Copiado']);
  conferir('md: sem clipboard, seleciona o código', cp.viaSelecao.selecionado && ['Copiado', 'Selecionado'].includes(cp.viaSelecao.rotulo), JSON.stringify(cp.viaSelecao));

  // cartões
  const ct = await rodar(paginaCartoes, S1, S2, S3);
  igual('cartões: tipoPermissao', ct.tipos, ['ferramenta', 'pergunta', 'plano', 'pergunta', 'plano', 'ferramenta']);
  igual('s1: ferramenta monta', [ct.s1.tipo, ct.s1.titulo, ct.s1.chip, ct.s1.resumo, ct.s1.entrada, ct.s1.sugs, ct.s1.botoesFora, ct.s1.icone], ['ferramenta', 'Permissão pedida', 'Bash', 'npm test -- --grep pareamento', true, 1, 0, true]);
  igual('s1: fila', [ct.s1.fila, ct.s1.fila1], ['mais 2 pedidos na fila', 'mais 1 pedido na fila']);
  igual('s1: Permitir → corpo, toast, evento e cartão travado', [ct.s1.permitir, ct.s1.toastPermitir, ct.s1.evento && ct.s1.evento.ok, ct.s1.bloqueado, ct.s1.estado], [{ id: 'perm-1', decisao: 'permitir' }, 'Permitido.', true, true, 'respondido']);
  igual('s1: sugestão → corpo', ct.s1.sugestao, { id: 'perm-1', decisao: 'permitir', sugestao: 0 });
  igual('s1: Negar → corpo', ct.s1.negar, { id: 'perm-1', decisao: 'negar' });
  igual('s1: Negar com motivo → corpo (motivo aparado)', [ct.s1.campoVisivel, ct.s1.rotuloNegar, ct.s1.motivo], [true, 'Negar com o motivo', { id: 'perm-1', decisao: 'negar', mensagem: 'perigoso demais' }]);
  igual('s1: erro de rede mostra o erro e reabilita', ct.s1.erro, { texto: 'Não deu para responder: falhou', visivel: true, reabilitado: true, rotulo: 'Permitir', estado: null });
  igual('s1: 409 avisa que já foi respondido e termina', ct.s1.conflito, { toast: 'Esse pedido já foi respondido.', estado: 'respondido' });
  igual('s2: pergunta monta', [ct.s2.tipo, ct.s2.titulo, ct.s2.tag, ct.s2.radios, ct.s2.outra, ct.s2.desc, ct.s2.botoesFora], ['pergunta', 'Pergunta do agente', 'Banco', 3, true, 'Arquivo local, sem servidor', 0]);
  igual('s2: validação (Responder desabilitado até escolher)', [ct.s2.desabilitado, ct.s2.semResposta, ct.s2.habilitado], ['true', { enviou: false, erro: 'Escolha uma resposta primeiro.', visivel: true }, 'false']);
  igual('s2: SQLite → corpo', ct.s2.sqlite, { id: 'perm-2', decisao: 'permitir', respostas: { 'Qual banco usar?': 'SQLite' } });
  igual('s2: Outra resposta (vazia não envia; texto livre aparado)', [ct.s2.livreVisivel, ct.s2.outraVazia, ct.s2.mongo], [true, 'Escolha uma resposta primeiro.', { id: 'perm-2', decisao: 'permitir', respostas: { 'Qual banco usar?': 'Mongo' } }]);
  igual('s2: Não responder → corpo', ct.s2.recusa, { id: 'perm-2', decisao: 'negar' });
  igual('s2: várias perguntas, múltipla com caixas e faltas', [ct.s2.multiTitulo, ct.s2.multiCaixas, ct.s2.multiFalta, ct.s2.multi], ['O agente tem 2 perguntas', 4, 'Falta responder 1 pergunta.', { id: 'perm-m', decisao: 'permitir', respostas: { 'Quais?': 'A, C, D', 'Cor?': 'Azul' } }]);
  igual('s3: plano monta com markdown e botões', [ct.s3.tipo, ct.s3.titulo, ct.s3.md, ct.s3.botoes, ct.s3.botoesFora], ['plano', 'Plano para aprovar', true, ['Continuar planejando', 'Aprovar e aceitar edições', 'Aprovar'], 0]);
  igual('s3: Aprovar → corpo', ct.s3.aprovar, { id: 'perm-3', decisao: 'permitir' });
  igual('s3: Aprovar e aceitar edições → corpo com sugestão', ct.s3.aceitar, { id: 'perm-3', decisao: 'permitir', sugestao: 0 });
  igual('s3: Continuar planejando abre o comentário e envia', [ct.s3.areaVisivel, ct.s3.rotuloContinuar, ct.s3.continuar], [true, 'Enviar e continuar planejando', { id: 'perm-3', decisao: 'negar', mensagem: 'Use Postgres' }]);
  igual('s3: Continuar planejando sem comentário', ct.s3.continuarVazio, { id: 'perm-3', decisao: 'negar' });
  igual('s3: plano vindo de entrada.plan e sem texto', [ct.s3.deEntrada, ct.s3.semTexto], ['entrada.plan', 'O agente não mandou o texto do plano.']);
  igual('s3: outra sugestão vira botão com seu índice', ct.s3.outraSugestao, { id: 'perm-z', decisao: 'permitir', sugestao: 3 });
  igual('cartões: nenhum sobra na página', ct.sobras, 0);

  // sprites: movimento reduzido emulado → quadro parado, troca direta
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const sp = await rodar(paginaSprites, 'novo');
  igual('sprites: API', sp.padrao, ['atualizar', 'criar', 'definir', 'ligar', 'padrao', 'preparar', 'quadroParado', 'srcGif', 'trocarSprite']);
  conferir('sprites: movimento reduzido emulado', sp.reduzido === true, sp.reduzido);
  igual('sprites: srcGif antes do quadro (versão), estático, PNG e URL absoluta', [sp.antes, sp.estatico, sp.png, sp.url], ['/anim.gif?v=2', '/fixo.png', 'x/y.png', '/abs/a.gif']);
  igual('sprites: quadro parado é uma imagem em blob: usado no lugar do GIF', [sp.quadro, sp.depois, sp.quadroPng, sp.imgSrc, sp.dataGif], ['blob:', 'blob:', 'carrega', 'blob:', 'anim']);
  igual('sprites: troca com movimento reduzido é direta (sem clone) e vai ao GIF/quadro do novo', [sp.filhosReduzido, /anim2\.gif/.test(sp.srcTrocado), sp.dataTrocado], [1, true, 'anim2']);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const sp2 = await rodar(paginaSprites, 'fade');
  igual('sprites: sem movimento reduzido o GIF volta a ser a fonte', [sp2.reduzido, sp2.srcGif], [false, '/anim.gif?v=2']);
  igual('sprites: fade cruzado (clone .av-sai sobre o novo, ~0,34 s, some no fim)', [sp2.clone, sp2.filhos, /anim/.test(sp2.velhoSrc), sp2.animando >= 1, sp2.ms >= 300, sp2.sobrou, sp2.semLixo], [true, 2, true, true, true, 1, 1]);

  conferir('zero erro/aviso de console, exceção ou violação de CSP', consoleErros.length === 0, consoleErros.join(' | '));
} catch (e) {
  conferir('execução sem exceção', false, e && e.stack || String(e));
} finally {
  try { ws?.close(); } catch {}
  if (edge) await fecharEdge(portaCdp, perfil);
  try { servidor?.close(); } catch {}
}

const falhas = checks.filter((c) => !c.ok);
for (const c of checks) console.log((c.ok ? 'ok   ' : 'FALHA') + ' ' + c.nome + (c.ok ? '' : '\n       ' + c.detalhe));
console.log(`\n${checks.length - falhas.length}/${checks.length} verificações passaram`);
process.exit(falhas.length ? 1 : 0);
