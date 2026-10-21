// Modo de edição dos widgets da Visão geral (19/10, assets/widgets.js + widgets.css). Sobe o mock (ROTEIRO=0) numa
// porta livre de 47822–47826 e abre o index.html real no Edge headless (mudo). Ponteiro de verdade (CDP Input):
//  - clique curto num filtro da rosca continua filtrando; segurar entra no modo de edição sem acionar o filtro;
//  - arrastar um widget sobre outro troca os dois, grava gi.widgets e sobrevive ao F5;
//  - cada widget em cada vaga (rotações), em 5 larguras: a vaga mantém a largura de fábrica e nada vaza do cartão;
//  - Esc, clique fora e "Concluir" saem; "Padrão" volta à disposição de fábrica e apaga a chave;
//  - Esc no meio do arrasto só cancela o arrasto; a lista de sessões não entra no modo de edição;
//  - movimento reduzido: sem tremor; zero erros no console.
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
  const ordem = () => av(`[...document.querySelectorAll('.col-lado > .graf[data-widget], .col-pe > .graf[data-widget]')].map((c) => c.dataset.widget).join()`);
  const editando = () => av(`document.getElementById('vista-geral').classList.contains('wd-editando')`);
  const barraAberta = () => av(`(() => { const b = document.querySelector('.wd-barra'); return !!b && !b.classList.contains('fechada') && !b.inert; })()`);
  const PADRAO = 'estado,ctx,sinc,uso,disco';
  const filtroAtivo = () => av(`(document.querySelector('#ge-leg .gl-item[aria-pressed="true"]') || {}).dataset?.g || ''`);
  // Larguras de cada vaga (ordem: lateral 1–3, pé 1–2) e cartões com algo vazando para fora deles.
  const vagas = () => av(`[...document.querySelectorAll('.col-lado > .graf[data-widget], .col-pe > .graf[data-widget]')].map((c) => Math.round(c.getBoundingClientRect().width))`);
  const vazando = () => av(`(() => {
    const out = [];
    for (const c of document.querySelectorAll('.graf[data-widget]')) {
      if (!c.getClientRects().length) continue;
      const r = c.getBoundingClientRect();
      if (c.scrollWidth > c.clientWidth + 1) out.push(c.dataset.widget + ': scrollWidth ' + c.scrollWidth + '>' + c.clientWidth);
      for (const el of c.querySelectorAll('*')) {
        if (!el.getClientRects().length || el.closest('svg') && el.tagName !== 'svg') continue;
        // Dentro de quem corta com reticências, o filho pode passar (o texto inteiro fica no title).
        const pai = el.parentElement; if (pai && pai !== c && getComputedStyle(pai).overflow === 'hidden' && pai.closest('.graf[data-widget]') === c && el !== pai) { const p = pai.getBoundingClientRect(); if (p.right <= r.right + 1 && p.left >= r.left - 1) continue; }
        const q = el.getBoundingClientRect();
        if (!q.width || !q.height) continue;
        if (q.left < r.left - 1 || q.right > r.right + 1 || q.bottom > r.bottom + 1) out.push(c.dataset.widget + ': ' + el.tagName.toLowerCase() + '.' + String(el.getAttribute('class') || el.id) + ' ' + Math.round(q.left - r.left) + '/' + Math.round(r.right - q.right) + '/' + Math.round(r.bottom - q.bottom));
      }
    }
    return out.slice(0, 12);
  })()`);
  const gravarOrdem = (o) => av(`localStorage.setItem('gi.widgets', ${JSON.stringify(JSON.stringify(o))}); true`);

  // ───── 1. Disposição de fábrica intacta ─────
  await tela(1500);
  await abrir();
  await av(`localStorage.removeItem('gi.widgets'); true`);
  await abrir();
  conferir((await ordem()) === PADRAO, 'ordem de fábrica', await ordem());
  const LARGURAS = [1500, 1000, 700, 560, 420];
  const fabrica = {};
  for (const w of LARGURAS) { await tela(w); fabrica[w] = await vagas(); conferir(!(await vazando()).length, `fábrica ${w}px: nada vaza`, await vazando()); }
  await tela(1500);
  const lay = await av(`(() => { const l = document.querySelector('.col-lado').getBoundingClientRect(), p = document.querySelector('.col-pe').getBoundingClientRect(); return { ladoDir: l.left > p.right, gu: getComputedStyle(document.getElementById('gu-barras')).display, gs: getComputedStyle(document.querySelector('#sincronia-card .gs-repos')).display }; })()`);
  conferir(lay.ladoDir && lay.gu === 'grid' && lay.gs !== 'grid', '1500px: lateral à direita, Uso do plano em 2 colunas, Sincronização em 1', lay);
  await tela(1000);
  const lay2 = await av(`(() => { const c = document.querySelectorAll('.col-lado > .graf'); const a = c[0].getBoundingClientRect(), b = c[1].getBoundingClientRect(), s = c[2].getBoundingClientRect(); return { par: Math.abs(a.top - b.top) < 1 && b.left > a.right, larga: s.width > a.width * 1.8, gs: getComputedStyle(document.querySelector('#sincronia-card .gs-repos')).display, gu: getComputedStyle(document.getElementById('gu-barras')).display }; })()`);
  conferir(lay2.par && lay2.larga && lay2.gs === 'grid' && lay2.gu === 'grid', '1000px: dois lado a lado e a 3ª vaga na linha toda (2 colunas)', lay2);
  await tela(1500);

  // ───── 2. Clique curto filtra; segurar entra no modo de edição sem filtrar ─────
  const item = '#ge-leg .gl-item[data-g]';
  let c = await centro(item);
  await mouse('mousePressed', c.x, c.y); await dormir(60); await mouse('mouseReleased', c.x, c.y);
  await dormir(200);
  const filtro1 = await filtroAtivo();
  conferir(!!filtro1 && !(await editando()), 'clique curto num estado da rosca filtra a lista', filtro1);
  await mouse('mousePressed', c.x, c.y); await dormir(60); await mouse('mouseReleased', c.x, c.y); // desliga o filtro
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
  conferir(trem.every((n) => n === 'wd-tremor'), 'os 5 widgets tremem', trem);
  conferir(await av(`getComputedStyle(document.getElementById('lista').closest('.col-lista')).animationName === 'none' && document.querySelector('.col-lista').classList.contains('wd-fora')`), 'a lista de sessões não treme (fica apagada, de fora)');
  await foto('1-edicao-1500');

  // ───── 3. Esc sai ─────
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(300);
  conferir(!(await editando()) && !(await barraAberta()), 'Esc sai do modo de edição');

  // ───── 4. Segurar e já arrastar: Sessões agora sobre o Espaço em disco ─────
  c = await centro('.graf-estado .gf-topo');
  const d = await centro('.graf-disco');
  await mouse('mousePressed', c.x, c.y); await dormir(650);
  await mover(c.x, c.y, d.x, d.y, 16);
  await dormir(120);
  conferir(await av(`document.querySelector('.graf-disco').classList.contains('wd-alvo')`), 'arrastando: o Espaço em disco vira o alvo');
  await foto('2-arrastando');
  await mouse('mouseReleased', d.x, d.y);
  await dormir(80);
  const flip = await av(`document.querySelector('.graf-estado').getAnimations().length`);
  conferir(flip > 0, 'troca animada (FLIP)', flip);
  await dormir(500);
  conferir((await ordem()) === 'disco,ctx,sinc,uso,estado', 'os dois trocaram de lugar', await ordem());
  conferir(await av(`localStorage.getItem('gi.widgets')`) === JSON.stringify(['disco', 'ctx', 'sinc', 'uso', 'estado']), 'ordem gravada em gi.widgets');
  conferir(await editando(), 'continua no modo de edição depois da troca');
  conferir(!(await av(`document.querySelector('.wd-padrao').disabled`)), '"Padrão" ligado fora da disposição de fábrica');
  const gEst = await av(`(() => { const e = document.querySelector('.graf-estado'); const r = e.querySelector('.ge-rosca').getBoundingClientRect(), l = document.getElementById('ge-leg').getBoundingClientRect(); return { lado: l.left > r.right }; })()`);
  conferir(gEst.lado, 'Sessões agora na vaga larga: rosca à esquerda, legenda à direita', gEst);
  await foto('3-trocado');

  // ───── 5. Arrastar sem alvo volta; Esc no arrasto só cancela ─────
  c = await centro('.graf-ctx');
  await mouse('mousePressed', c.x, c.y); await mover(c.x, c.y, c.x - 40, c.y + 30, 6);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', c.x - 40, c.y + 30);
  await dormir(400);
  conferir((await ordem()) === 'disco,ctx,sinc,uso,estado' && (await editando()), 'Esc no arrasto cancela só o arrasto', await ordem());
  conferir(await av(`!document.querySelector('.graf-ctx').style.translate`), 'o cartão voltou para a vaga');

  // ───── 6. F5 mantém a ordem; clique fora sai ─────
  await abrir();
  conferir((await ordem()) === 'disco,ctx,sinc,uso,estado', 'F5 mantém as posições', await ordem());
  c = await centro('.graf-ctx');
  await mouse('mousePressed', c.x, c.y); await dormir(650); await mouse('mouseReleased', c.x, c.y); await dormir(200);
  conferir(await editando(), 'segurar de novo entra');
  const fora = await av(`(() => { const r = document.querySelector('.cab-pagina').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 8) }; })()`);
  await mouse('mousePressed', fora.x, fora.y); await mouse('mouseReleased', fora.x, fora.y); await dormir(300);
  conferir(!(await editando()), 'clique fora sai');

  // ───── 7. "Padrão" volta à disposição de fábrica; "Concluir" sai ─────
  await mouse('mousePressed', c.x, c.y); await dormir(650); await mouse('mouseReleased', c.x, c.y); await dormir(300);
  let b = await centro('.wd-padrao');
  await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); await dormir(500);
  conferir((await ordem()) === PADRAO && (await av(`localStorage.getItem('gi.widgets')`)) === null, '"Padrão" restaura e apaga a chave', await ordem());
  conferir(await editando(), '"Padrão" não sai do modo de edição');
  b = await centro('.wd-concluir');
  await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); await dormir(300);
  conferir(!(await editando()) && !(await barraAberta()), '"Concluir" sai');

  // ───── 8. A lista não entra no modo de edição ─────
  c = await centro('#lista .linha[data-id]');
  await mouse('mousePressed', c.x, c.y); await dormir(650); await mouse('mouseReleased', c.x, c.y); await dormir(200);
  conferir(!(await editando()), 'segurar uma sessão da lista não entra no modo de edição');
  for (let i = 0; i < 6 && !(await av("document.getElementById('peek').hidden")); i++) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await dormir(300);
  }
  conferir(await av("document.getElementById('peek').hidden"), 'detalhe da sessão fechado de novo');

  // ───── 9. Cada widget em cada vaga, em cada largura ─────
  const base = PADRAO.split(',');
  for (let k = 1; k < base.length; k++) {
    const o = [...base.slice(k), ...base.slice(0, k)];
    await gravarOrdem(o);
    await tela(1500);
    await abrir();
    conferir((await ordem()) === o.join(), `rotação ${k}: ordem aplicada no carregamento`, { tem: await ordem(), quer: o.join(), ls: await av(`localStorage.getItem('gi.widgets')`) });
    for (const w of LARGURAS) {
      await tela(w);
      const v = await vagas();
      conferir(v.every((x, i) => Math.abs(x - fabrica[w][i]) <= 1), `rotação ${k}, ${w}px: cada vaga mantém a largura`, { v, f: fabrica[w] });
      const vz = await vazando();
      conferir(!vz.length, `rotação ${k}, ${w}px: nada vaza`, vz);
      if (k === 3 && (w === 1500 || w === 420)) await foto(`4-rotacao${k}-${w}`);
    }
  }
  await tela(1500);
  await av(`localStorage.setItem('gi.widgets', '"lixo"'); true`);
  await abrir();
  conferir((await ordem()) === PADRAO, 'gi.widgets inválido: disposição de fábrica');

  // ───── 10. Movimento reduzido ─────
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  c = await centro('.graf-ctx');
  await mouse('mousePressed', c.x, c.y); await dormir(650); await mouse('mouseReleased', c.x, c.y); await dormir(200);
  conferir(await editando(), 'reduzido: segurar entra');
  conferir(await av(`[...document.querySelectorAll('.graf[data-widget]')].every((x) => getComputedStyle(x).animationName === 'none')`), 'reduzido: sem tremor');
  await foto('5-reduzido');
  const s0 = await centro('.graf-sinc'), u0 = await centro('.graf-uso');
  await mouse('mousePressed', s0.x, s0.y); await mover(s0.x, s0.y, u0.x, u0.y, 10); await mouse('mouseReleased', u0.x, u0.y); await dormir(60);
  conferir((await ordem()) === 'estado,ctx,uso,sinc,disco' && (await av(`document.querySelector('.graf-sinc').getAnimations().length`)) === 0, 'reduzido: troca sem animação', await ordem());
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  b = await centro('.wd-padrao');
  await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); await dormir(400);

  // ───── 11. Rolagem automática perto da borda ─────
  await tela(1500, 760);
  c = await centro('.graf-estado .gf-topo');
  // Quem rola é o <main> ou, com abas, o painel da aba.
  const topo = () => av(`(() => { for (let p = document.querySelector('.graf-estado').parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p.scrollTop; } return document.scrollingElement.scrollTop; })()`);
  const topo0 = await topo();
  await mouse('mousePressed', c.x, c.y); await dormir(650); await mover(c.x, c.y, c.x, 740, 10); await dormir(700);
  const topo1 = await topo();
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', c.x, 740); await dormir(300);
  conferir(topo1 > topo0 + 50, 'arrastando perto da borda de baixo, a Home rola sozinha', { topo0, topo1 });
  conferir((await ordem()) === PADRAO, 'arrasto cancelado não muda a ordem');

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
