// Confirmações em balão (16/10): Limpar, Compactar e Encerrar abrem um balão logo acima do cartão do prompt, no
// lugar do modal central. Esc e clique fora cancelam, Enter confirma, clicar de novo no botão só fecha.
// Sobe o mock (ROTEIRO=0) numa porta de teste, abre o index.html real no Edge headless e usa mouse e teclado
// de verdade (CDP Input). Capturas em logs/balao/. Uso: node testes/balao-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(PASTA, '..', 'logs', 'balao');
const PORTA = Number(process.env.PORTA || 47823);
const BASE = `http://127.0.0.1:${PORTA}`;
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
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
  const ocioso = sess.find((s) => s.controle?.modo === 'orbit' && !s.controle.ocupada && !s.controle.permissao && !s.controle.interrompida)
    || sess.find((s) => s.controle?.modo === 'orbit' && !s.controle.ocupada && !s.controle.permissao);
  const ocupado = sess.find((s) => s.controle?.modo === 'orbit' && s.controle.ocupada && !s.controle.permissao && s.controle.processo !== 'iniciando');
  conferir(ocioso && ocupado, 'o mock tem sessões ociosa e ocupada', [ocioso?.id, ocupado?.id]);

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
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await dormir(200);
  };
  const esc = () => tecla('Escape', 'Escape', 27);
  const enter = () => tecla('Enter', 'Enter', 13, { text: '\r' });
  const tab = () => tecla('Tab', 'Tab', 9);
  const clicarEm = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await dormir(260);
  };
  const caixa = (sel) => av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`);
  const clicar = async (sel) => { const c = await caixa(sel); if (!c) throw new Error('sem ' + sel); await clicarEm(c.x + c.w / 2, c.y + c.h / 2); };
  const abrir = async (id) => {
    const r = await av(`(() => { const l = document.querySelector('#lista .linha[data-id=${JSON.stringify(id)}]'); if (!l) return 'sem linha'; l.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'ok'; })()`);
    if (r !== 'ok') throw new Error(r + ' (' + id + ')');
    await dormir(1100);
    await av(`(() => { const b = document.querySelector('#pk-abas button[data-aba="conversa"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
    await dormir(400);
  };
  const balao = () => av(`(() => { const b = document.getElementById('balao'); const r = b.getBoundingClientRect(); const a = document.activeElement;
    return { aberto: !b.hidden, tit: document.getElementById('balao-tit').textContent, txt: document.getElementById('balao-txt').textContent,
      sim: document.getElementById('balao-sim').textContent, perigo: document.getElementById('balao-sim').classList.contains('perigo'),
      campo: !document.getElementById('balao-campo').hidden, foco: a && (a.id || a.className), x: r.x, y: r.y, w: r.width, h: r.height, lado: b.dataset.lado,
      modal: !!document.querySelector('.camada:not([hidden])') }; })()`);
  const posts = () => av(`window.__posts.splice(0)`);
  const foto = async (nome, c) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, c.x - 24), y: Math.max(0, c.y - 24), width: c.w + 48, height: c.h + 48, scale: 2 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/?abas=0' }); // rodada 9: a Conversa no detalhe (sem as abas)
  await dormir(2500);
  // Registra os POST da página (sem mudar o que eles fazem).
  await av(`(() => { window.__posts = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === 'POST') window.__posts.push([String(u), o.body || '']); return f(u, o); }; })()`);

  // ── Limpar: abre ancorado embaixo do botão, sem modal ──
  await abrir(ocioso.id);
  const bLimpar = await caixa('#pk-conversa .cv-b-limpar');
  conferir(!!bLimpar, 'Conversa aberta com o botão Limpar', bLimpar);
  await clicar('#pk-conversa .cv-b-limpar');
  let v = await balao();
  conferir(v.aberto && !v.modal, 'Limpar: abre o balão, sem o modal central', v);
  conferir(v.tit === 'Limpar a conversa?' && /contexto atual/.test(v.txt) && /histórico continua salvo/.test(v.txt), 'texto curto: perde o contexto, histórico salvo', v);
  const cartao = await caixa('#pk-conversa .cv-campo');
  const acima = (v) => v.lado === 'cima' && Math.round(cartao.y - (v.y + v.h)) === 8 && Math.abs(v.x - cartao.x) <= 1;
  conferir(acima(v), 'logo acima do cartão do prompt (gap de 8 px), alinhado pela esquerda', { v, cartao });
  conferir(v.perigo && v.sim === 'Limpar conversa' && !v.campo, 'ação destrutiva marcada (perigo), sem campo', v);
  conferir(v.foco === 'balao-sim', 'o foco vai para a ação', v.foco);
  const cor = await av(`(() => { const s = getComputedStyle(document.getElementById('balao-sim')); return { fundo: s.backgroundColor, cor: s.color }; })()`);
  conferir(!/rgba?\(2[0-9]{2}, [0-9]{1,2}, [0-9]{1,2}/.test(cor.fundo) && /rgb\(255, 149, 146\)/.test(cor.cor), 'perigo sem fundo vermelho: o texto é que é vermelho', cor);
  await foto('1-limpar', { x: cartao.x, y: v.y, w: cartao.w, h: cartao.y + cartao.h - v.y }); // o balão com o prompt embaixo
  await esc();
  v = await balao();
  const focoVolta = await av(`document.activeElement && document.activeElement.classList.contains('cv-b-limpar')`);
  conferir(!v.aberto && focoVolta, 'Esc fecha e devolve o foco ao Limpar', { v, focoVolta });
  conferir(!(await posts()).length, 'Esc: nada foi pedido ao servidor');

  // Clique fora
  await clicar('#pk-conversa .cv-b-limpar');
  const lista = await caixa('#pk-conversa .cv-lista');
  await clicarEm(lista.x + lista.w / 2, lista.y + 30); // o balão fica embaixo, acima do prompt
  v = await balao();
  conferir(!v.aberto && !(await posts()).length, 'clique fora fecha sem limpar', v);

  // Clicar de novo no botão só fecha
  await clicar('#pk-conversa .cv-b-limpar');
  await clicar('#pk-conversa .cv-b-limpar');
  v = await balao();
  conferir(!v.aberto, 'clicar de novo no Limpar fecha (não reabre)', v);

  // Tab circula dentro do balão; Enter no Cancelar cancela
  await clicar('#pk-conversa .cv-b-limpar');
  await tab();
  v = await balao();
  conferir(v.aberto && v.foco === 'balao-nao', 'Tab: do botão de ação volta ao Cancelar (foco preso no balão)', v.foco);
  const anel = await av(`getComputedStyle(document.getElementById('balao-nao')).boxShadow`);
  conferir(/rgba\(255, 255, 255, 0\.3\)/.test(anel) && !/112, 184, 255/.test(anel), 'foco de teclado discreto (anel fino, sem o azul forte)', anel);
  await foto('2-limpar-foco-cancelar', v);
  await enter();
  v = await balao();
  conferir(!v.aberto && !(await posts()).length, 'Enter no Cancelar cancela', v);

  // ── Compactar: balão com o campo de foco ──
  await clicar('#pk-conversa .cv-b-compactar');
  v = await balao();
  const bComp = await caixa('#pk-conversa .cv-b-compactar');
  conferir(v.aberto && v.tit === 'Compactar o contexto?' && v.campo && v.foco.includes('balao-campo'), 'Compactar: balão com o campo de foco já focado', v);
  conferir(!v.perigo && v.sim === 'Compactar' && acima(v), 'Compactar: ação no botão sólido, acima do prompt', { v, bComp });
  conferir(await av(`document.querySelector('#pk-conversa .cv-b-compactar').getAttribute('aria-expanded')`) === 'true', 'Compactar: aria-expanded enquanto aberto');
  conferir(await av(`document.querySelector('#pk-conversa .cv-foco').hidden`), 'o painel antigo embutido não aparece');
  await cdp('Input.insertText', { text: 'só os testes' });
  await dormir(150);
  await foto('3-compactar', await balao());
  await enter();
  await dormir(400);
  let p = await posts();
  v = await balao();
  conferir(!v.aberto && p.length === 1 && /\/compactar$/.test(p[0][0]) && JSON.parse(p[0][1]).foco === 'só os testes', 'Enter confirma e compacta com o foco', p);

  // ── Encerrar (instância ocupada): pede confirmação no balão ──
  await abrir(ocupado.id);
  await dormir(300);
  const bEnc = await caixa('#pk-conversa .cv-b-encerrar');
  conferir(!!bEnc, 'ocupada: botão Encerrar visível', bEnc);
  if (bEnc) {
    await clicar('#pk-conversa .cv-b-encerrar');
    v = await balao();
    conferir(v.aberto && v.tit === 'Encerrar a instância?' && v.perigo && v.sim === 'Interromper e encerrar', 'Encerrar: balão com a ação destrutiva', v);
    const c2 = await caixa('#pk-conversa .cv-campo');
    conferir(v.lado === 'cima' && Math.round(c2.y - (v.y + v.h)) === 8 && Math.abs(v.x - c2.x) <= 1, 'Encerrar: também acima do prompt', { v, c2 });
    await foto('4-encerrar', v);
    await clicar('#balao-nao');
    v = await balao();
    conferir(!v.aberto && !(await posts()).length, 'Cancelar fecha sem encerrar', v);
    await clicar('#pk-conversa .cv-b-encerrar');
    await enter();
    await dormir(400);
    p = await posts();
    conferir(p.length === 1 && /\/encerrar$/.test(p[0][0]) && JSON.parse(p[0][1]).forcar === true, 'Enter confirma e encerra (forçar, como antes)', p);
  }

  // ── Limpar: Enter confirma (por último: a sessão ganha um id novo) ──
  await abrir(ocioso.id);
  await clicar('#pk-conversa .cv-b-limpar');
  await enter();
  await dormir(400);
  p = await posts();
  conferir(p.length === 1 && /\/limpar$/.test(p[0][0]) && JSON.parse(p[0][1]).confirmar === true, 'Limpar: Enter confirma e pede /limpar com confirmar:true', p);

  conferir(!erros.length, 'sem erros no console', erros);
  await fecharEdge(pcdp, perfil);
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e);
  await fecharEdge(pcdp, perfil).catch(() => {});
} finally {
  mock.kill();
}
console.log(`\n${ok} ok / ${falhas} falhas · capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
