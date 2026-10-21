// Menu de botão direito da instância na Home (17/10): abre no cursor com as ações da sessão, seleciona a linha sem
// abrir o detalhe, aceita teclado (setas, atalho do item, Esc, Shift+F10) e não sai da tela, nem a 420 px.
// Sobe o mock (ROTEIRO=0) numa porta de teste livre e abre o index.html real no Edge headless, com mouse e teclado
// de verdade (CDP Input). Capturas em logs/menu-instancia/ (FOTOS=1 para gravar). Uso: node testes/menu-instancia-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(PASTA, '..', 'logs', 'menu-instancia');
const FOTOS = process.env.FOTOS === '1';
const PORTA = await escolherPorta(Number(process.env.PORTA || 47823));
const BASE = `http://127.0.0.1:${PORTA}`;
const EDGE = caminhoNavegador();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SAIDA, { recursive: true });

let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => { if (cond) { ok++; console.log('ok  ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge');
const pcdp = 9760 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const sess = (await (await fetch(BASE + '/estado')).json()).sessoes;
  const orbit = sess.find((s) => s.controle?.modo === 'orbit' && !s.controle.permissao && s.controle.processo === 'vivo' && !s.pai);
  conferir(!!orbit, 'o mock tem uma instância do Orbit acordada', orbit?.id);

  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${perfil}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
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
  const tecla = async (key, code, vk, extra = {}) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, ...extra });
    if (extra.text) await cdp('Input.dispatchKeyEvent', { type: 'char', key, text: extra.text });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: extra.modifiers || 0 });
    await dormir(220);
  };
  const mouse = async (x, y, button = 'left') => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    await dormir(280);
  };
  const caixa = (sel) => av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`);
  const SEL = `#lista .linha[data-id=${JSON.stringify(orbit.id)}]`;
  const menu = () => av(`(() => { const m = document.querySelector('.menu-flut'); if (!m || m.hidden) return { aberto: false };
    const r = m.getBoundingClientRect(); const a = document.activeElement;
    return { aberto: true, x: r.x, y: r.y, w: r.width, h: r.height, rotulo: m.getAttribute('aria-label'),
      tit: (m.querySelector('.menu-tit') || {}).textContent || '',
      itens: [...m.querySelectorAll('.menu-item')].map((b) => b.querySelector('.mi-rot').textContent),
      perigo: [...m.querySelectorAll('.menu-item.perigo')].map((b) => b.querySelector('.mi-rot').textContent),
      seps: m.querySelectorAll('.menu-sep').length, foco: a && a.classList.contains('menu-item') ? a.querySelector('.mi-rot').textContent : (a && (a.id || a.className)) }; })()`);
  const estado = () => av(`(() => { const l = document.querySelector(${JSON.stringify(SEL)}); return { sel: l && l.getAttribute('aria-selected'), peek: !document.getElementById('peek').hidden, foco: document.activeElement && document.activeElement.id, rolH: document.documentElement.scrollWidth > innerWidth }; })()`);
  const posts = () => av(`window.__posts.splice(0)`);
  const foto = async (nome, c) => {
    if (!FOTOS) return;
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, c.x - 30), y: Math.max(0, c.y - 30), width: c.w + 60, height: c.h + 60, scale: 2 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/?abas=0' });
  await dormir(2500);
  await av(`(() => { window.__posts = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === 'POST') window.__posts.push([String(u), o.body || '']); return f(u, o); }; })()`);
  await av(`document.querySelector(${JSON.stringify(SEL)}).scrollIntoView({ block: 'center' })`);
  await dormir(300);

  // ── Botão direito: abre no cursor, com o nome no topo e as ações; seleciona a linha sem abrir o detalhe ──
  let l = await caixa(SEL);
  conferir(!!l, 'a linha da instância está na Home', SEL);
  let px = l.x + 160, py = l.y + l.h / 2;
  await mouse(px, py, 'right');
  let m = await menu();
  conferir(m.aberto, 'botão direito abre o menu', m);
  conferir(Math.abs(m.x - px) <= 1 && Math.abs(m.y - py) <= 1, 'o menu abre no ponto do clique', [m.x, m.y, px, py]);
  for (const r of ['Abrir conversa', 'Ver detalhe', 'Abrir no VS Code', 'Renomear', 'Fixar no topo', 'Silenciar avisos', 'Compactar contexto', 'Limpar conversa', 'Encerrar instância', 'Copiar claude --resume', 'Copiar id', 'Apagar instância'])
    conferir(m.itens.includes(r), 'item: ' + r, m.itens);
  conferir(m.perigo.length === 1 && m.perigo[0] === 'Apagar instância', 'só "Apagar instância" é de perigo', m.perigo);
  conferir(m.seps >= 3 && m.tit.length > 0, 'grupos com separadores e o nome da sessão no topo', [m.seps, m.tit]);
  conferir(m.foco === 'Abrir conversa', 'o foco vai para o primeiro item', m.foco);
  let e = await estado();
  conferir(e.sel === 'true' && !e.peek, 'a linha fica selecionada e o detalhe não abre', e);
  await foto('menu', { x: m.x, y: m.y, w: m.w, h: m.h });

  // ── Teclado dentro do menu: setas, Esc devolve o foco à lista ──
  await tecla('ArrowDown', 'ArrowDown', 40);
  m = await menu();
  conferir(m.foco === 'Ver detalhe', 'seta para baixo vai ao próximo item', m.foco);
  await tecla('ArrowUp', 'ArrowUp', 38); await tecla('ArrowUp', 'ArrowUp', 38);
  m = await menu();
  conferir(m.foco === 'Apagar instância', 'seta para cima no primeiro dá a volta', m.foco);
  await tecla('Escape', 'Escape', 27);
  m = await menu(); e = await estado();
  conferir(!m.aberto && e.foco === 'lista' && !e.peek, 'Esc fecha o menu, devolve o foco à lista e não fecha nada mais', [m, e]);

  // ── A letra do atalho aciona o item: p fixa (POST /sessao/<id> {fixada:true}) ──
  await posts();
  await mouse(px, py, 'right');
  await tecla('p', 'KeyP', 80, { text: 'p' });
  let p = await posts();
  m = await menu();
  conferir(!m.aberto && p.length === 1 && p[0][0].endsWith('/sessao/' + encodeURIComponent(orbit.id)) && JSON.parse(p[0][1]).fixada === true, 'p no menu fixa a sessão (um POST só) e fecha', p);
  await dormir(300);
  l = await caixa(SEL); px = l.x + 160; py = l.y + l.h / 2;
  await mouse(px, py, 'right');
  m = await menu();
  conferir(m.itens.includes('Desafixar'), 'fixada: o item vira "Desafixar"', m.itens);
  await tecla('Escape', 'Escape', 27);

  // ── Limpar conversa: o balão de confirmação fica na linha, não no meio da tela ──
  await mouse(px, py, 'right');
  const bLimpar = await av(`(() => { const b = [...document.querySelectorAll('.menu-flut .menu-item')].find((x) => x.textContent.includes('Limpar conversa')); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouse(bLimpar.x, bLimpar.y);
  await dormir(500);
  const bal = await av(`(() => { const b = document.getElementById('balao'); const r = b.getBoundingClientRect(); return { aberto: !b.hidden, tit: document.getElementById('balao-tit').textContent, y: r.y, b: r.bottom, x: r.x }; })()`);
  l = await caixa(SEL);
  conferir(bal.aberto && /Limpar/.test(bal.tit), 'Limpar conversa pede confirmação no balão', bal);
  conferir(Math.abs(bal.y - (l.b + 6)) <= 2 || Math.abs(bal.b - (l.y - 6)) <= 2, 'o balão fica colado na linha selecionada', [bal, l]);
  if (bal.aberto) await foto('balao-na-linha', { x: Math.min(bal.x, l.x), y: Math.min(bal.y, l.y), w: 700, h: Math.abs(bal.b - l.y) + 10 });
  await tecla('Escape', 'Escape', 27);
  p = await posts();
  conferir(!p.some((x) => /\/limpar$/.test(x[0])), 'Esc no balão cancela: nada é limpo', p);

  // ── Pelo teclado: Shift+F10 na lista abre sob a linha selecionada ──
  await av(`document.getElementById('lista').focus()`);
  await tecla('F10', 'F10', 121, { modifiers: 8 });
  m = await menu(); l = await caixa(SEL);
  conferir(m.aberto && m.y >= l.y && m.y <= l.b + 6, 'Shift+F10 abre o menu sob a linha selecionada', [m.aberto, m.y, l]);
  await tecla('Escape', 'Escape', 27);

  // ── Na borda da tela o menu não sai da janela ──
  await mouse(1430, 890, 'right'); // canto: talvez fora de linha; usa a última linha visível
  const ult = await av(`(() => { const ls = [...document.querySelectorAll('#lista .linha[data-id]:not([data-id=""])')].filter((x) => { const r = x.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }); const r = ls[ls.length - 1].getBoundingClientRect(); return { x: Math.min(innerWidth - 4, r.right - 4), y: Math.min(innerHeight - 4, r.bottom - 4) }; })()`);
  await mouse(ult.x, ult.y, 'right');
  m = await menu();
  conferir(m.aberto && m.x >= 0 && m.y >= 0 && m.x + m.w <= 1440 && m.y + m.h <= 1100, 'no canto, o menu fica dentro da janela', m);
  await tecla('Escape', 'Escape', 27);

  // ── Remover da lista: tira a linha com desfazer ──
  await av(`document.querySelector(${JSON.stringify(SEL)}).scrollIntoView({ block: 'center' })`);
  await dormir(300);
  l = await caixa(SEL);
  await mouse(l.x + 160, l.y + l.h / 2, 'right');
  const bRem = await av(`(() => { const b = [...document.querySelectorAll('.menu-flut .menu-item')].find((x) => x.textContent.includes('Apagar instância')); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouse(bRem.x, bRem.y);
  await dormir(400);
  const rem = await av(`(() => { const l = document.querySelector(${JSON.stringify(SEL)}); return { linha: !!(l && l.getClientRects().length), toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast-txt').textContent }; })()`);
  conferir(!rem.linha && /removida/.test(rem.toast), 'Remover tira a linha e oferece desfazer', rem);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await dormir(400);

  // ── 420 px: sem rolagem horizontal, menu dentro da tela ──
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await dormir(600);
  await av(`document.querySelector(${JSON.stringify(SEL)}) && document.querySelector(${JSON.stringify(SEL)}).scrollIntoView({ block: 'center' })`);
  await dormir(300);
  l = await caixa(SEL);
  if (l) {
    await mouse(l.x + l.w - 20, l.y + l.h / 2, 'right');
    m = await menu(); e = await estado();
    conferir(m.aberto && m.x >= 0 && m.x + m.w <= 420 && m.y + m.h <= 800 && !e.rolH, 'a 420 px o menu cabe e não há rolagem horizontal', [m, e.rolH]);
    if (m.aberto) await foto('menu-420', { x: m.x, y: m.y, w: m.w, h: m.h });
    await tecla('Escape', 'Escape', 27);
  } else conferir(false, 'linha visível a 420 px');

  conferir(!erros.length, 'sem erros no console', erros);
  await fecharEdge(pcdp, perfil);
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e);
  await fecharEdge(pcdp, perfil).catch(() => {});
} finally {
  mock.kill();
}
console.log(`\n${ok} ok / ${falhas} falhas${FOTOS ? ' · capturas em ' + SAIDA : ''}`);
process.exit(falhas ? 1 : 0);
