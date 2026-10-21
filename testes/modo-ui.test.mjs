// Modo de permissão Auto (16/10): o seletor da Conversa (com a descrição de cada modo na lista), o "Nova
// instância" (começa no padrão das Configurações) e o "Modo de permissão padrão" das Configurações.
// Sobe o mock (ROTEIRO=0) numa porta de teste e abre o index.html real no Edge headless; as capturas ficam
// em logs/modo/. Uso: node testes/modo-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(PASTA, '..', 'logs', 'modo');
const PORTA = Number(process.env.PORTA || 47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SAIDA, { recursive: true });

let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => { if (cond) { ok++; console.log('ok  ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge');
const pcdp = 9750 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  const sess = (await (await fetch(BASE + '/estado')).json()).sessoes;
  const ocioso = sess.find((s) => s.controle?.modo === 'orbit' && !s.controle.ocupada && !s.controle.permissao);
  conferir(!!ocioso, 'o mock tem uma instância ociosa do Orbit', ocioso?.id);

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
  const caixa = (sel) => av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const foto = async (nome, clip) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 } } : {}) });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const clicar = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await dormir(350);
  };
  const tecla = async (key, code, vk) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await dormir(250);
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/?abas=0' }); // rodada 9: a Conversa no detalhe (sem as abas)
  await dormir(2500);

  // ── Conversa: o seletor de modo (botão + menu flutuante) ──
  await av(`(() => { const l = document.querySelector('#lista .linha[data-id=${JSON.stringify(ocioso.id)}]'); l.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await dormir(1200);
  await av(`(() => { const b = document.querySelector('#pk-abas button[data-aba="conversa"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
  await dormir(600);
  // Fechado, o texto do modo tem o mesmo estilo do texto do modelo.
  let v = await av(`(() => { const e = (x) => { const c = getComputedStyle(x); return [c.color, c.fontWeight, c.fontSize, c.fontFamily].join(' | '); };
    const R = document.getElementById('pk-conversa'); return { modo: e(R.querySelector('.cv-sel-modo .cv-sel-rot')), modelo: e(R.querySelector('.cv-sel-modelo .cv-sel-rot')) }; })()`);
  conferir(v.modo === v.modelo, 'Conversa: fechado, o modo tem a mesma cor e fonte do modelo', v);
  const sel = await caixa('#pk-conversa .cv-sel-modo');
  await foto('1-conversa-fechado', { x: sel.x - 8, y: sel.y - 8, w: 260, h: sel.h + 16 });
  const largFechado = sel.w;
  await clicar(sel.x + sel.w / 2, sel.y + sel.h / 2);
  v = await av(`(() => { const p = document.querySelector('#pk-conversa .cv-pop'); const its = [...p.querySelectorAll('.cv-pop-i[data-tipo="modo"]')];
    const o = its.find((x) => x.dataset.valor === 'auto'); const d = o && o.querySelector('.cv-pop-desc').getBoundingClientRect();
    return { aberto: !p.hidden && p.dataset.qual === 'modo', valores: its.map((o) => o.dataset.valor), labels: its.map((o) => o.querySelector('.cv-pop-rot')?.textContent),
      descs: its.map((o) => o.querySelector('.cv-pop-desc')?.textContent || ''), descVisivel: !!d && d.height > 0 && d.width > 0 }; })()`);
  conferir(v.aberto, 'Conversa: clicar no modo abre o menu flutuante', v);
  conferir(JSON.stringify(v.valores) === JSON.stringify(['default', 'acceptEdits', 'plan', 'auto']), 'Conversa: Auto entra no fim, o resto na mesma ordem', v.valores);
  conferir(JSON.stringify(v.labels) === JSON.stringify(['Padrão', 'Aceitar edições', 'Planejar', 'Auto']), 'Conversa: rótulos', v.labels);
  conferir(v.descs.every((d) => d.length > 10 && d.length <= 70) && v.descVisivel, 'Conversa: cada modo tem uma descrição curta, visível na lista', v.descs);
  const lista = await caixa('#pk-conversa .cv-pop');
  await foto('2-conversa-aberto', { x: lista.x - 12, y: lista.y - 12, w: lista.w + 24, h: lista.h + 24 });
  // Escolhe Auto na lista: o botão mostra só o nome e o modo vai ao servidor.
  const autoR = await av(`(() => { const r = document.querySelector('#pk-conversa .cv-pop-i[data-valor="auto"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await clicar(autoR.x, autoR.y);
  await dormir(800);
  const sel2 = await caixa('#pk-conversa .cv-sel-modo');
  v = await av(`(() => { const b = document.querySelector('#pk-conversa .cv-sel-modo'); return { modo: b.dataset.modo, texto: b.innerText.trim(), fechado: document.querySelector('#pk-conversa .cv-pop').hidden }; })()`);
  conferir(v.texto === 'Auto' && v.fechado, 'Conversa: escolher fecha o menu e o botão mostra só o nome do modo', v);
  const srv = (await (await fetch(BASE + '/estado')).json()).sessoes.find((s) => s.id === ocioso.id);
  conferir(v.modo === 'auto', 'Conversa: escolher Auto troca o modo', v);
  conferir(srv?.controle?.modoPermissao === 'auto', 'Conversa: o servidor ficou em auto', srv?.controle?.modoPermissao);
  conferir(sel2.h === sel.h && sel2.w < 140, 'Conversa: fechado, o seletor segue do mesmo tamanho (só o nome)', { antes: [largFechado, sel.h], depois: [sel2.w, sel2.h] });
  await foto('3-conversa-auto', { x: sel2.x - 8, y: sel2.y - 8, w: 260, h: sel2.h + 16 });

  // ── Configurações: modo padrão ──
  v = await av(`(() => { const s = document.getElementById('cfg-modo'); return s ? { valor: s.value, ops: [...s.options].map((o) => o.value) } : null; })()`);
  conferir(v && v.valor === 'auto', 'Configurações: o padrão vem como Auto', v);
  conferir(v && JSON.stringify(v.ops.slice().sort()) === JSON.stringify(['acceptEdits', 'auto', 'default', 'plan']), 'Configurações: os quatro modos', v?.ops);

  // ── Nova instância: começa no padrão ──
  const abrirNova = async () => {
    await av(`document.getElementById('btn-nova').click()`);
    await dormir(900);
    return av(`(() => { const g = document.querySelector('.ni-seg'); if (!g) return null; const bs = [...g.querySelectorAll('button[data-v]')];
      return { vs: bs.map((b) => b.dataset.v), marcado: bs.find((b) => b.getAttribute('aria-checked') === 'true')?.dataset.v, dica: document.getElementById('ni-perm-dica').textContent,
        cortado: bs.some((b) => b.scrollWidth > b.clientWidth + 1) }; })()`);
  };
  v = await abrirNova();
  conferir(v && JSON.stringify(v.vs) === JSON.stringify(['default', 'acceptEdits', 'plan', 'auto']), 'Nova instância: os quatro modos, Auto no fim', v?.vs);
  conferir(v && v.marcado === 'auto' && /verificador/.test(v.dica), 'Nova instância: começa em Auto, com a descrição', v);
  conferir(v && !v.cortado, 'Nova instância: nenhum rótulo cortado', v);
  const seg = await caixa('.ni-seg');
  if (seg) await foto('4-nova-instancia', { x: seg.x - 10, y: seg.y - 34, w: seg.w + 20, h: seg.h + 64 });
  await tecla('Escape', 'Escape', 27);

  // Muda o padrão nas Configurações (como o change do seletor) → o popover passa a começar nele.
  await av(`(() => { const s = document.getElementById('cfg-modo'); s.value = 'plan'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await dormir(900);
  const cfg = await (await fetch(BASE + '/config')).json();
  conferir(cfg.instancias?.modoPadrao === 'plan' && cfg.instancias?.dormirApos === 30, 'Configurações: o padrão vai ao servidor sem mexer no dormirApos', cfg.instancias);
  v = await abrirNova();
  conferir(v && v.marcado === 'plan', 'Nova instância: segue o novo padrão', v?.marcado);
  await tecla('Escape', 'Escape', 27);
  await av(`(() => { const s = document.getElementById('cfg-modo'); s.value = 'auto'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await dormir(600);

  conferir(erros.filter((e) => !/\/modelos|503/.test(e)).length === 0, 'sem erros no console', erros);
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e.message);
} finally {
  await fecharEdge(pcdp, perfil);
  mock.kill();
}
console.log(`\n${ok} ok, ${falhas} falha(s). Capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
