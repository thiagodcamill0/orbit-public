// Grade da Visão geral e modo de edição dos widgets (19/10; grade de 21/10: assets/widgets.js + widgets.css). Sobe o
// mock (ROTEIRO=0) numa porta livre de 47822–47826 e abre o index.html real no Edge headless (mudo). Ponteiro de
// verdade (CDP Input):
//  - fábrica: 12 colunas na largura toda (lista + lateral), 8/4/1 nas telas menores, sem sobreposição e sem vazar;
//  - clique curto num filtro da rosca continua filtrando; segurar entra no modo de edição sem acionar o filtro;
//  - sobre outro widget entra antes dele, na largura da vaga; num espaço livre, na largura livre; vaga e colunas aparecem;
//  - canto: redimensiona com encaixe, mínimo (sem cortar) e máximo; o grafo e o Uso de contexto usam a altura; a lista só a largura;
//  - gi.widgets.grade sobrevive ao F5; a ordem antiga (gi.widgets) vira layout; "Padrão" volta e apaga a chave;
//  - Esc no arrasto ou no redimensionar só cancela; Esc, clique fora e "Concluir" saem; a lista não entra no modo;
//  - movimento reduzido: sem tremor nem animação; rolagem automática; zero erros no console.
// Capturas em <pasta-de-saida>. Uso: node testes/widgets-ui.test.mjs [pasta-de-saida]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-widgets-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (cond) { ok++; console.log('ok   ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
};

const PORTA = await escolherPorta(47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge');
fs.rmSync(perfil, { recursive: true, force: true });
const pcdp = 9450 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${perfil}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pend = new Map(); const erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') erros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') erros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // Página escondida (o headless às vezes a trata assim) estrangula timers e para o rAF: o segurar e a rolagem
  // automática dependem deles.
  const naFrente = async () => { await cdp('Page.bringToFront'); await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }); };
  await naFrente();
  const tela = async (w, hgt = 4400) => { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: false }); await dormir(450); };
  const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
  const abrir = async () => {
    await av('window.__velha = 1; true').catch(() => {});
    await cdp('Page.navigate', { url: BASE + '/' });
    await naFrente();
    for (let i = 0; i < 100; i++) { await dormir(100); if (await av(`!window.__velha && document.querySelectorAll('#lista .linha[data-id]').length > 0`).catch(() => false)) break; }
    // A abertura (logo por cima da página) sai sozinha; até lá, ela é que recebe o ponteiro.
    for (let i = 0; i < 60; i++) { if (await av(`(() => { const a = document.getElementById('abertura'); return !a || !a.isConnected || a.classList.contains('sai') || getComputedStyle(a).display === 'none'; })()`).catch(() => false)) break; await dormir(100); }
    await dormir(500);
  };
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra });
  const mover = async (x0, y0, x1, y1, passos = 12) => { for (let i = 1; i <= passos; i++) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / passos, y: y0 + ((y1 - y0) * i) / passos, button: 'left', buttons: 1, pointerType: 'mouse' }); await dormir(16); } };
  const centro = (sel) => av(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 40)) }; })()`);
  const editando = () => av(`document.getElementById('vista-geral').classList.contains('wd-editando')`);
  const barraAberta = () => av(`(() => { const b = document.querySelector('.wd-barra'); return !!b && !b.classList.contains('fechada') && !b.inert; })()`);
  const filtroAtivo = () => av(`(document.querySelector('#ge-leg .gl-item[aria-pressed="true"]') || {}).dataset?.g || ''`);
  const esc = async () => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  // Layout aplicado ({ item: {x, y, w, h, a} }), colunas e a chave gravada.
  const lay = () => av(`Object.fromEntries(OrbitGrade.layout().map((i) => [i.k, i]))`);
  const pos = (L) => Object.keys(L).sort().map((k) => `${k}:${L[k].x},${L[k].w}`).join(' ');
  const colunas = () => av(`OrbitGrade.colunas()`);
  const chave = () => av(`localStorage.getItem('gi.widgets.grade')`);
  const caixa = (sel) => av(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
  // Itens que se sobrepõem na tela (sem animação em curso) e itens com algo vazando para fora do cartão.
  const sobrepostos = () => av(`(() => {
    const els = [...document.querySelectorAll('.geral-grade > [data-widget], .geral-grade > [data-wd]')].filter((e) => e.getClientRects().length);
    const R = els.map((e) => [e.dataset.widget || e.dataset.wd, e.getBoundingClientRect()]), out = [];
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      const [a, p] = R[i], [b, q] = R[j];
      if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) out.push(a + '×' + b);
    }
    return out;
  })()`);
  const vazando = () => av(`(() => {
    const out = [], alcas = [...document.querySelectorAll('.wd-alca')];
    for (const x of alcas) x.style.display = 'none'; // a alça da lista fica no vão, de propósito
    queueMicrotask(() => { for (const x of alcas) x.style.display = ''; });
    for (const c of document.querySelectorAll('.geral-grade > .graf[data-widget], .geral-grade > .col-lista')) {
      if (!c.getClientRects().length) continue;
      const r = c.getBoundingClientRect(), nome = c.dataset.widget || c.dataset.wd;
      if (c.scrollWidth > c.clientWidth + 1) out.push(nome + ': scrollWidth ' + c.scrollWidth + '>' + c.clientWidth);
      for (const el of c.querySelectorAll('*')) {
        if (!el.getClientRects().length || el.closest('svg') && el.tagName !== 'svg' || el.classList.contains('wd-alca')) continue;
        // Dentro de quem corta com reticências, o filho pode passar (o texto inteiro fica no title).
        const pai = el.parentElement; if (pai && pai !== c && getComputedStyle(pai).overflow === 'hidden' && el !== pai) { const p = pai.getBoundingClientRect(); if (p.right <= r.right + 1 && p.left >= r.left - 1 && p.bottom <= r.bottom + 1) continue; }
        const q = el.getBoundingClientRect();
        if (!q.width || !q.height) continue;
        if (q.left < r.left - 1 || q.right > r.right + 1 || q.bottom > r.bottom + 1) out.push(nome + ': ' + el.tagName.toLowerCase() + '.' + String(el.getAttribute('class') || el.id) + ' ' + Math.round(q.left - r.left) + '/' + Math.round(r.right - q.right) + '/' + Math.round(r.bottom - q.bottom));
      }
    }
    return out.slice(0, 12);
  })()`);
  const segurarEntrar = async (sel) => { const c = await centro(sel); await mouse('mousePressed', c.x, c.y); await dormir(650); await mouse('mouseReleased', c.x, c.y); await dormir(250); };
  const arrastar = async (de, para, passos = 14) => {
    await mouse('mousePressed', de.x, de.y); await mover(de.x, de.y, para.x, para.y, passos); await dormir(120);
    await mouse('mouseReleased', para.x, para.y); await dormir(550);
  };
  const alca = async (sel) => { const r = await caixa(sel + ' > .wd-alca'); return { x: Math.round(r.l + r.w / 2), y: Math.round(r.t + r.h / 2) }; };

  // ───── 1. Disposição de fábrica: grade de 12 colunas na largura toda ─────
  await tela(1500);
  await abrir();
  await av(`localStorage.removeItem('gi.widgets.grade'); localStorage.removeItem('gi.widgets'); true`);
  await abrir();
  const FAB = await lay();
  conferir((await colunas()) === 12, '1500px: 12 colunas', await colunas());
  conferir(FAB.lista.x === 0 && FAB.lista.w === 9 && ['estado', 'ctx', 'sinc', 'disco', 'cena'].every((k) => FAB[k].x === 9 && FAB[k].w === 3) && FAB.uso.w === 9 && FAB.grafo.w === 9, 'fábrica: lista + lateral de 3 colunas; Uso do plano e Grafo embaixo da lista', pos(FAB));
  const g = await av(`(() => { const g = document.querySelector('.geral-grade').getBoundingClientRect(), l = document.querySelector('.col-lista').getBoundingClientRect(), e = document.querySelector('.graf-estado').getBoundingClientRect(); return { esq: Math.round(l.left - g.left), dir: Math.round(g.right - e.right), topo: Math.abs(l.top - e.top) < 1, larg: Math.round(e.width) }; })()`);
  conferir(g.esq === 0 && g.dir === 0 && g.topo && Math.abs(g.larg - 296) < 12, 'a grade ocupa a largura toda; lateral ≈ 300 px, no topo da lista', g);
  conferir(await av(`document.getElementById('cena').classList.contains('em-pe')`), 'a Cena do dia em pé na lateral (versão vertical)');
  const LARGURAS = [[1500, 12], [1000, 8], [700, 4], [560, 4], [420, 1]];
  for (const [w, n] of LARGURAS) {
    await tela(w); await dormir(300);
    const cs = await colunas();
    conferir(cs === n, `${w}px: ${n} coluna(s)`, cs);
    conferir(!(await sobrepostos()).length, `fábrica ${w}px: nada se sobrepõe`, await sobrepostos());
    conferir(!(await vazando()).length, `fábrica ${w}px: nada vaza`, await vazando());
  }
  const um = await lay();
  conferir(Object.values(um).every((i) => i.x === 0 && i.w === 1), '420px: tudo numa coluna', pos(um));
  await tela(1500);

  // ───── 2. Clique curto filtra; segurar entra no modo de edição sem filtrar ─────
  const item = '#ge-leg .gl-item[data-g]';
  let c = await centro(item);
  await mouse('mousePressed', c.x, c.y); await dormir(60); await mouse('mouseReleased', c.x, c.y);
  await dormir(200);
  const filtro1 = await filtroAtivo();
  conferir(!!filtro1 && !(await editando()), 'clique curto num estado da rosca filtra a lista', filtro1);
  await mouse('mousePressed', c.x, c.y); await dormir(60); await mouse('mouseReleased', c.x, c.y);
  await dormir(200);
  conferir(!(await filtroAtivo()), 'segundo clique tira o filtro');
  await mouse('mousePressed', c.x, c.y); await dormir(250);
  conferir(await av(`document.querySelector('.graf-estado').classList.contains('wd-segurando')`), 'segurando: o cartão afunda');
  await dormir(450);
  conferir(await editando(), 'segurar ~0,5 s entra no modo de edição');
  await mouse('mouseReleased', c.x, c.y);
  await dormir(250);
  conferir(!(await filtroAtivo()), 'o soltar do clique longo não acionou o filtro', await filtroAtivo());
  conferir(await barraAberta(), 'barra "Concluir" aberta');
  conferir(await av(`document.querySelector('.wd-padrao').disabled`), '"Padrão" desligado na disposição de fábrica');
  const trem = await av(`[...document.querySelectorAll('.graf[data-widget]')].map((x) => getComputedStyle(x).animationName)`);
  conferir(trem.length === 7 && trem.every((n) => n === 'wd-tremor'), 'os 7 widgets tremem', trem);
  conferir(await av(`getComputedStyle(document.querySelector('.col-lista')).animationName === 'none' && document.querySelector('.col-lista').classList.contains('wd-fora')`), 'a lista de sessões não treme (fica apagada, de fora)');
  conferir(await av(`[...document.querySelectorAll('.geral-grade > * > .wd-alca')].filter((a) => a.getClientRects().length).length`) === 8, 'alça de redimensionar em cada item (e na lista)');
  await foto('1-edicao-1500');
  await esc(); await dormir(300);
  conferir(!(await editando()) && !(await barraAberta()), 'Esc sai do modo de edição');

  // ───── 3. Sobre outro widget: entra antes dele, na largura daquela vaga ─────
  c = await centro('.graf-estado .gf-topo');
  let u = await caixa('.graf-uso');
  await mouse('mousePressed', c.x, c.y); await dormir(650);
  await mover(c.x, c.y, u.l + 200, u.t + 30, 16); await dormir(150);
  const vg = await av(`(() => { const v = document.querySelector('.wd-vaga'); return { on: !v.hidden && document.querySelector('.geral-grade').classList.contains('wd-movendo'), guias: getComputedStyle(document.querySelector('.geral-grade'), '::before').opacity }; })()`);
  conferir(vg.on && vg.guias === '1', 'arrastando: a vaga e as colunas aparecem', vg);
  const larg = await caixa('.graf-estado');
  conferir(larg.w > 800, 'o widget já assume a largura da vaga (9 colunas) enquanto arrasta', larg.w);
  await foto('2-arrastando');
  await mouse('mouseReleased', u.l + 200, u.t + 30); await dormir(80);
  conferir(await av(`document.querySelector('.graf-uso').getAnimations().length > 0`), 'os outros abrem espaço com animação (FLIP)');
  await dormir(550);
  let L = await lay();
  conferir(L.estado.x === 0 && L.estado.w === 9 && L.estado.y === FAB.uso.y && L.uso.y >= L.estado.y + L.estado.h, 'Sessões agora entrou antes do Uso do plano, na largura dele', pos(L));
  conferir(L.ctx.y === 0 && L.ctx.x === 9, 'a lateral subiu para o lugar vago', pos(L));
  const gEst = await av(`(() => { const r = document.querySelector('.graf-estado .ge-rosca').getBoundingClientRect(), l = document.getElementById('ge-leg').getBoundingClientRect(); return l.left > r.right; })()`);
  conferir(gEst, 'Sessões agora largo: rosca à esquerda, legenda à direita');
  conferir(JSON.parse(await chave())?.['12']?.estado?.join() === [0, L.estado.y, 9, 0].join(), 'layout gravado em gi.widgets.grade', await chave());
  conferir(await editando(), 'continua no modo de edição');
  conferir(!(await av(`document.querySelector('.wd-padrao').disabled`)), '"Padrão" ligado fora da disposição de fábrica');
  conferir(!(await sobrepostos()).length && !(await vazando()).length, 'sem sobreposição e nada vaza', [await sobrepostos(), await vazando()]);

  // ───── 4. Num espaço livre: ocupa a largura livre daquela linha ─────
  const cn = await caixa('.graf-cena'), li = await caixa('.col-lista');
  c = await centro('.graf-uso .gf-topo');
  const livre = { x: Math.round(cn.l + cn.w / 2), y: Math.round(Math.min(cn.b + 140, li.b - 60)) };
  await arrastar(c, livre, 18);
  L = await lay();
  conferir(L.uso.x === 9 && L.uso.w === 3 && L.uso.y >= L.cena.y + L.cena.h, 'Uso do plano no vão da lateral: 3 colunas, embaixo da cena', pos(L));
  conferir(await av(`getComputedStyle(document.querySelector('.graf-uso .gf-topo')).flexDirection === 'column'`), 'Uso do plano estreito: versão de coluna');
  conferir(!(await sobrepostos()).length && !(await vazando()).length, 'sem sobreposição e nada vaza', [await sobrepostos(), await vazando()]);
  await foto('3-movidos');

  // ───── 5. Redimensionar pelo canto: encaixe na grade, mínimo e máximo ─────
  const gr0 = await caixa('.graf-grafo'), area0 = await caixa('.gg-area');
  let a = await alca('.graf-grafo');
  await arrastar(a, { x: a.x - 312, y: a.y + 200 }, 12);
  L = await lay();
  const gr1 = await caixa('.graf-grafo'), area1 = await caixa('.gg-area');
  conferir(L.grafo.w === 6, 'mais estreito: 6 colunas (encaixe)', L.grafo);
  conferir(Math.abs(gr1.h - gr0.h - 200) <= 8 && area1.h > area0.h + 150, 'mais alto: a área do grafo cresce junto', { h0: gr0.h, h1: gr1.h, a0: area0.h, a1: area1.h });
  conferir(!(await sobrepostos()).length, 'redimensionado: sem sobreposição', await sobrepostos());
  a = await alca('.graf-grafo');
  await arrastar(a, { x: a.x - 2000, y: a.y - 2000 }, 12);
  L = await lay();
  const mn = await av(`document.querySelector('.graf-grafo').getBoundingClientRect().width >= 260`);
  conferir(L.grafo.w === 3 && mn && L.grafo.a === 0, 'no mínimo: 3 colunas (≥ 260 px) e a altura do conteúdo', L.grafo);
  conferir(!(await vazando()).length, 'no mínimo, nada é cortado', await vazando());
  a = await alca('.graf-grafo');
  await arrastar(a, { x: a.x, y: a.y + 3000 }, 10);
  conferir(Math.abs((await caixa('.graf-grafo')).h - 1100) <= 8, 'no máximo: 1100 px de altura', (await caixa('.graf-grafo')).h);
  // Uso de contexto mais alto: mais sessões na sobra.
  const n0 = await av(`document.querySelectorAll('#gc-barras .gc-linha').length`);
  a = await alca('.graf-ctx');
  await arrastar(a, { x: a.x, y: a.y + 260 }, 10);
  await dormir(200);
  const n1 = await av(`document.querySelectorAll('#gc-barras .gc-linha').length`);
  conferir(n0 === 5 && n1 > 5, 'Uso de contexto mais alto: mais sessões na lista', { n0, n1 });
  conferir(!(await vazando()).length, 'linhas a mais sem vazar', await vazando());
  // A lista: só a largura.
  const l0 = await lay();
  a = await alca('.col-lista');
  await arrastar(a, { x: a.x - 210, y: a.y + 300 }, 10);
  L = await lay();
  conferir(L.lista.w === 7 && L.lista.a === 0, 'a lista: 2 colunas a menos, sem altura escolhida', [l0.lista, L.lista]);
  conferir(!(await sobrepostos()).length && !(await vazando()).length, 'lista mais estreita: sem sobreposição e nada vaza', [await sobrepostos(), await vazando()]);
  await foto('4-redimensionado');

  // ───── 6. Esc no meio do arrasto (ou do redimensionar) só cancela ─────
  const antes = pos(await lay());
  c = await centro('.graf-sinc .gf-topo');
  await mouse('mousePressed', c.x, c.y); await mover(c.x, c.y, c.x - 600, c.y + 400, 10); await dormir(100);
  await esc();
  await mouse('mouseReleased', c.x - 600, c.y + 400); await dormir(500);
  conferir(pos(await lay()) === antes && (await editando()), 'Esc no arrasto cancela só o arrasto', pos(await lay()));
  conferir(await av(`!document.querySelector('.graf-sinc').style.translate && document.querySelector('.wd-vaga').hidden`), 'o cartão voltou e a vaga sumiu');
  a = await alca('.graf-disco');
  await mouse('mousePressed', a.x, a.y); await mover(a.x, a.y, a.x + 300, a.y + 300, 6); await dormir(100);
  await esc();
  await mouse('mouseReleased', a.x + 300, a.y + 300); await dormir(500);
  conferir(pos(await lay()) === antes && (await editando()), 'Esc no redimensionar cancela só ele', pos(await lay()));

  // ───── 7. F5 mantém o layout; clique fora sai ─────
  const salvo = await lay();
  await abrir();
  L = await lay();
  conferir(pos(L) === pos(salvo) && L.grafo.a === salvo.grafo.a && L.ctx.a === salvo.ctx.a, 'F5 mantém posições e tamanhos', pos(L));
  await segurarEntrar('.graf-ctx');
  conferir(await editando(), 'segurar de novo entra');
  const fora = await av(`(() => { const r = document.querySelector('.cab-pagina').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 8) }; })()`);
  await mouse('mousePressed', fora.x, fora.y); await mouse('mouseReleased', fora.x, fora.y); await dormir(300);
  conferir(!(await editando()), 'clique fora sai');

  // ───── 8. Telas menores: menos colunas, sem perder o layout largo ─────
  for (const [w, n] of LARGURAS.slice(1)) {
    await tela(w); await dormir(300);
    conferir((await colunas()) === n && !(await sobrepostos()).length && !(await vazando()).length, `editado, ${w}px: ${n} coluna(s), sem sobreposição e nada vaza`, [await colunas(), await sobrepostos(), await vazando()]);
    if (w === 700) await foto('5-editado-700');
  }
  await tela(1500); await dormir(300);
  conferir(pos(await lay()) === pos(salvo), 'de volta a 1500px: o layout largo como estava');

  // ───── 9. "Padrão" volta à fábrica; "Concluir" sai ─────
  await segurarEntrar('.graf-ctx');
  let b = await centro('.wd-padrao');
  await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); await dormir(550);
  conferir(pos(await lay()) === pos(FAB) && (await chave()) === null, '"Padrão" restaura e apaga a chave', pos(await lay()));
  conferir(await editando(), '"Padrão" não sai do modo de edição');
  b = await centro('.wd-concluir');
  await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); await dormir(300);
  conferir(!(await editando()) && !(await barraAberta()), '"Concluir" sai');

  // ───── 10. A lista não entra no modo de edição ─────
  c = await centro('#lista .linha[data-id]');
  await mouse('mousePressed', c.x, c.y); await dormir(650); await mouse('mouseReleased', c.x, c.y); await dormir(200);
  conferir(!(await editando()), 'segurar uma sessão da lista não entra no modo de edição');
  for (let i = 0; i < 6 && !(await av("document.getElementById('peek').hidden")); i++) { await esc(); await dormir(300); }
  conferir(await av("document.getElementById('peek').hidden"), 'detalhe da sessão fechado de novo');

  // ───── 11. A ordem antiga (gi.widgets, vagas fixas) vira o layout de 12 colunas ─────
  await av(`localStorage.setItem('gi.widgets', JSON.stringify(['disco', 'ctx', 'sinc', 'uso', 'estado'])); true`);
  await abrir();
  L = await lay();
  conferir(L.disco.x === 9 && L.disco.y === 0 && L.estado.x === 9 && L.estado.y > L.sinc.y, 'ordem antiga: Espaço em disco no topo da lateral, Sessões agora na vaga dele', pos(L));
  conferir((await av(`localStorage.getItem('gi.widgets')`)) === null && !!JSON.parse(await chave())?.['12'], 'gi.widgets sai; vira gi.widgets.grade');
  await av(`localStorage.setItem('gi.widgets.grade', '"lixo"'); true`);
  await abrir();
  conferir(pos(await lay()) === pos(FAB), 'gi.widgets.grade inválido: disposição de fábrica');
  await av(`localStorage.removeItem('gi.widgets.grade'); true`);
  await abrir();

  // ───── 12. Movimento reduzido ─────
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await segurarEntrar('.graf-ctx');
  conferir(await editando(), 'reduzido: segurar entra');
  conferir(await av(`[...document.querySelectorAll('.graf[data-widget]')].every((x) => getComputedStyle(x).animationName === 'none')`), 'reduzido: sem tremor');
  await foto('6-reduzido');
  c = await centro('.graf-sinc .gf-topo');
  u = await caixa('.graf-ctx');
  await mouse('mousePressed', c.x, c.y); await mover(c.x, c.y, u.l + 40, u.t + 20, 10); await mouse('mouseReleased', u.l + 40, u.t + 20); await dormir(60);
  L = await lay();
  conferir(L.sinc.y < L.ctx.y && (await av(`[...document.querySelectorAll('.geral-grade > *')].every((e) => !e.getAnimations().some((a) => a.id === 'wd-flip'))`)), 'reduzido: move sem animação', pos(L));
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  b = await centro('.wd-padrao');
  await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); await dormir(400);

  // ───── 13. Rolagem automática perto da borda ─────
  await tela(1500, 760);
  c = await centro('.graf-estado .gf-topo');
  const topo = () => av(`(() => { for (let p = document.querySelector('.graf-estado').parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p.scrollTop; } return document.scrollingElement.scrollTop; })()`);
  const topo0 = await topo();
  await mouse('mousePressed', c.x, c.y); await dormir(650); await mover(c.x, c.y, c.x, 740, 10); await dormir(700);
  const topo1 = await topo();
  await esc();
  await mouse('mouseReleased', c.x, 740); await dormir(300);
  conferir(topo1 > topo0 + 50, 'arrastando perto da borda de baixo, a Home rola sozinha', { topo0, topo1 });
  conferir(pos(await lay()) === pos(FAB), 'arrasto cancelado não muda o layout');
  await esc();

  conferir(!erros.length, 'zero erros no console', erros);
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e);
} finally {
  await fecharEdge(pcdp, perfil).catch(() => {});
  mock.kill();
}
console.log(`\n${ok} ok, ${falhas} falha(s). Capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
