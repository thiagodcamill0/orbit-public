// Card de sessão na lista (17/10): título numa linha com reticências, sub-linha só com o modelo e os degraus do
// esforço (sem projeto nem logo; texto inteiro no hover quando corta), ações do hover sem cobrir a barra e o % do
// contexto, e a seleção com fundo + marcador lateral (sem o contorno azul).
// Sobe o mock (ROTEIRO=0) numa porta de teste e abre o index.html real no Edge headless em várias larguras.
// Capturas em logs/card-sessao/. Uso: node testes/card-sessao-ui.test.mjs  (SO_FOTOS=1: só as capturas)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(PASTA, '..', 'logs', 'card-sessao', process.env.ROTULO || 'depois');
const PORTA = Number(process.env.PORTA || 47824);
const BASE = `http://127.0.0.1:${PORTA}`;
const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
const SO_FOTOS = process.env.SO_FOTOS === '1';
const LARGURAS = [1920, 1440, 1280, 1100, 960, 760, 480];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SAIDA, { recursive: true });

let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (SO_FOTOS) return;
  if (cond) { ok++; console.log('ok  ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); }
};

const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, '..', 'edge-' + PORTA);
const pcdp = 9760 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
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
  const mover = async (x, y) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await dormir(260); };
  const tecla = async (key, code, vk) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await dormir(250);
  };
  const foto = async (nome, c) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: Math.max(0, c.x - 8), y: Math.max(0, c.y - 8), width: c.w + 16, height: c.h + 16, scale: 2 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const caixaLista = () => av(`(() => { const l = [...document.querySelectorAll('#lista .linha:not(.filho)')].slice(0, 6); if (!l.length) return null; l[0].scrollIntoView({ block: 'start' });
    const a = l[0].getBoundingClientRect(), b = l[l.length - 1].getBoundingClientRect(); return { x: a.x + scrollX, y: a.y + scrollY, w: a.width, h: b.bottom - a.y }; })()`);

  // Medidas de uma linha-mãe: corte do título e da sub-linha, title no hover, logo e botões na linha.
  const medir = (sel) => av(`(() => {
    const l = document.querySelector(${JSON.stringify(sel)}); if (!l) return null;
    const vis = (e) => e && !e.hidden && e.getClientRects().length && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
    const corta = (e) => vis(e) && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1);
    const q = (s) => l.querySelector(s);
    const tit = q('.tit'), mod = q('.sub-l .mod-l'), nome = q('.sub-l .mod-nome'), nivel = q('.sub-l .mod-nivel');
    const fonte = (e) => { const s = getComputedStyle(e); return { tam: parseFloat(s.fontSize), peso: Number(s.fontWeight), cor: s.color }; };
    const botoes = [...l.querySelectorAll('button[data-acao]')].filter(vis).map((b) => b.dataset.acao).filter((a) => a !== 'agentes');
    const ctxOp = q('.c-ctx .ctx-l > span:last-child') ? Number(getComputedStyle(q('.c-ctx .ctx-l > span:last-child')).opacity) : null;
    const antes = getComputedStyle(l, '::before');
    return {
      id: l.dataset.id, largura: l.getBoundingClientRect().width,
      tit: tit && { txt: tit.textContent, corta: corta(tit), title: tit.title, ...fonte(tit), w: tit.clientWidth },
      mod: mod && { txt: mod.textContent, vis: vis(mod), corta: corta(nome), title: mod.title, ...fonte(mod) },
      nivel: nivel && { vis: vis(nivel), n: nivel.children.length, on: nivel.querySelectorAll('i.on').length },
      proj: !!l.querySelector('.sub-l .proj'), orb: !!l.querySelector('.orb-logo'),
      botoes, ctxOp, sel: l.classList.contains('sel'), antesSombra: antes.boxShadow, antesFundo: antes.backgroundColor, bg: getComputedStyle(l).backgroundColor,
      marca: { content: antes.content, w: antes.width, h: antes.height, fundo: antes.backgroundColor },
    };
  })()`);

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/?abas=0' });
  await dormir(2500);
  await av(`document.querySelector('[data-vista="lista"], #nav-lista, [data-nav="lista"]')?.click()`);
  await dormir(500);

  const idOrbit = await av(`(() => { const l = [...document.querySelectorAll('#lista .linha:not(.filho)')].find((x) => x.querySelector('.sub-l .mod-nivel:not([hidden])')); return l ? l.dataset.id : null; })()`);
  conferir(!!idOrbit, 'o mock tem uma sessão com modelo e esforço na lista', idOrbit);
  const selOrbit = `#lista .linha[data-id="${idOrbit}"]`;

  for (const w of LARGURAS) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
    await mover(2, 2);
    await dormir(400);
    const c = await caixaLista();
    if (c) await foto(w + '-repouso', c);
    const m = await medir(selOrbit);
    const todas = await av(`[...document.querySelectorAll('#lista .linha:not(.filho)')].map((l) => l.dataset.id).filter(Boolean)`);
    const ms = [];
    for (const id of todas) ms.push(await medir(`#lista .linha[data-id="${id}"]`));
    if (m) {
      conferir(!m.proj && !m.orb, `${w}px: sem projeto e sem logo na sub-linha`, [m.proj, m.orb]);
      conferir(w <= 480 || (m.nivel.vis && m.nivel.n >= 3 && m.nivel.on >= 1 && !/·/.test(m.mod.txt)), `${w}px: esforço em degraus (sem texto)`, [m.nivel, m.mod.txt]);
      conferir(/esforço/.test(m.mod.title), `${w}px: tooltip do modelo explica o esforço`, m.mod.title);
    }
    // Título: quando corta, o texto inteiro fica no title (hover). Modelo idem.
    const semTitle = ms.filter((x) => x && ((x.tit.corta && !x.tit.title.includes(x.tit.txt)) || (x.mod?.corta && !x.mod.title.includes(x.mod.txt))));
    conferir(!semTitle.length, `${w}px: todo texto cortado tem o texto inteiro no hover`, semTitle.map((x) => x.id));
    // O título nunca pode sumir: pelo menos ~10 caracteres de espaço (≥ 90 px).
    const apertado = ms.filter((x) => x && x.tit.w < 90);
    conferir(!apertado.length, `${w}px: título com espaço legível (≥ 90 px)`, apertado.map((x) => [x.id, x.tit.w]));
    // Título numa linha só (reticências), em qualquer largura.
    const duas = await av(`[...document.querySelectorAll('#lista .linha:not(.filho) .tit')].filter((t) => t.getClientRects().length && t.getBoundingClientRect().height > parseFloat(getComputedStyle(t).lineHeight) * 1.5).length`);
    conferir(duas === 0, `${w}px: títulos numa linha só`, duas);
    if (m) {
      conferir(m.tit.tam >= 14 && m.mod.tam >= 12, `${w}px: tipografia (título ≥ 14, sub ≥ 12)`, [m.tit.tam, m.mod.tam]);
      conferir(m.tit.peso > m.mod.peso, `${w}px: hierarquia de peso título > sub-linha`, [m.tit.peso, m.mod.peso]);
    }

    // Hover: sem ações rápidas na linha (16/10); o % do contexto continua inteiro.
    const comCtx = await av(`(() => { const l = [...document.querySelectorAll('#lista .linha:not(.filho)')].find((x) => x.querySelector('.c-ctx .ctx-l') && getComputedStyle(x.querySelector('.c-ctx')).display !== 'none'); if (!l) return null; const r = l.getBoundingClientRect(); return { id: l.dataset.id, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (comCtx) {
      await mover(comCtx.x, comCtx.y);
      const h = await medir(`#lista .linha[data-id="${comCtx.id}"]`);
      const lc = await caixaLista();
      if (lc) await foto(w + '-hover', lc);
      conferir(!h.botoes.length && (h.ctxOp == null || h.ctxOp > 0.5), `${w}px: hover sem ações rápidas e com o % do contexto à vista`, [h.botoes, h.ctxOp]);
    }
    await mover(2, 2);
  }

  // Varredura (17/10): em nenhuma largura o texto da sessão (título, modelo) invade outra coluna ou sai da linha.
  const invasoes = async () => av(`(() => {
    const vis = (e) => e && e.getClientRects().length && getComputedStyle(e).display !== 'none';
    const cruza = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const out = [];
    for (const l of document.querySelectorAll('#lista .linha:not(.filho)')) {
      const L = l.getBoundingClientRect();
      const outros = [...l.querySelectorAll('.c-status, .c-agora, .c-ctx, .c-tempo, .rev-chk')].filter(vis).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
      for (const e of l.querySelectorAll('.c-sessao .tit, .c-sessao .mod-l')) {
        if (!vis(e)) continue;
        const r = e.getBoundingClientRect();
        if (r.right > L.right + 1 || outros.some((o) => cruza(r, o))) out.push([l.dataset.id, e.className, Math.round(r.left), Math.round(r.right), Math.round(r.width)]);
      }
    }
    return out;
  })()`);
  // Títulos longos de verdade (o pedido inteiro como título), como nas sessões novas.
  // O texto vai direto no DOM: a linha só repinta o título quando a assinatura muda.
  const apelidos = await av(`(() => { const a = {}; for (const t of document.querySelectorAll('#lista .linha:not(.filho) .tit')) { a[t.closest('.linha').dataset.id] = t.textContent; t.textContent = 'quando crio uma instancia estando dentro do projeto, deve aparecer automaticamente na lista de sessões do projeto certo sem precisar recarregar'; } return a; })()`);
  for (const [compacta, peek] of [[false, false], [true, false], [false, true]]) {
    await av(`document.body.classList.toggle('compacta', ${compacta})`);
    if (peek) { await av(`document.querySelector('#lista .linha:not(.filho)').click()`); await dormir(500); }
    const ruins = [];
    for (let w = 360; w <= 1920; w += 20) {
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
      await dormir(120);
      if ([400, 760, 900, 1000, 1200, 1440].includes(w)) { const lc = await caixaLista(); if (lc) await foto('longo-' + (compacta ? 'compacta-' : '') + (peek ? 'detalhe-' : '') + w, lc); }
      const x = await invasoes();
      if (x.length) {
        ruins.push([w, x.slice(0, 2)]);
        if (ruins.length === 1) { const lc = await caixaLista(); if (lc) await foto('invasao-' + (compacta ? 'compacta-' : '') + (peek ? 'detalhe-' : '') + w, lc); }
      }
    }
    conferir(!ruins.length, `${compacta ? 'compacto' : 'normal'}${peek ? ' com o detalhe aberto' : ''}: texto da sessão não invade outra coluna (360 a 1920 px)`, ruins.slice(0, 4));
    if (peek) { await tecla('Escape', 'Escape', 27); }
  }
  await av(`document.body.classList.remove('compacta')`);
  await av(`(() => { const a = ${JSON.stringify(apelidos)}; for (const t of document.querySelectorAll('#lista .linha:not(.filho) .tit')) { const id = t.closest('.linha').dataset.id; if (id in a) t.textContent = a[id]; } })()`);

  // Seleção: fundo + marcador lateral, sem contorno; nem com foco de teclado.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await dormir(400);
  await av(`document.getElementById('lista').focus()`);
  await tecla('ArrowDown', 'ArrowDown', 40);
  await tecla('ArrowDown', 'ArrowDown', 40);
  await mover(2, 2);
  const s = await medir('#lista .linha.sel:not(.filho)');
  conferir(s && s.sel, 'teclado seleciona uma linha', s && s.id);
  if (s) {
    const contorno = /0px 0px 0px 1px/.test(s.antesSombra);
    conferir(!contorno, 'selecionada sem contorno (nem com foco de teclado)', s.antesSombra);
    conferir(s.marca.content !== 'none' && parseFloat(s.marca.w) <= 4, 'selecionada com marcador lateral fino', s.marca);
    const lc = await caixaLista();
    if (lc) await foto('sel-teclado', lc);
  }
  // Hover simples no modelo: a pílula ganha fundo.
  {
    const p = await av(`(() => { const e = document.querySelector('${selOrbit} .sub-l .mod-l'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, bg: getComputedStyle(e).backgroundColor }; })()`);
    await mover(p.x, p.y);
    const bg = await av(`getComputedStyle(document.querySelector('${selOrbit} .sub-l .mod-l')).backgroundColor`);
    conferir(bg !== p.bg, 'hover no modelo pinta o fundo', [p.bg, bg]);
    const lc = await caixaLista(); if (lc) await foto('hover-modelo', lc);
    await mover(2, 2);
  }
  // Modo compacto: título em 1 linha.
  await av(`document.body.classList.add('compacta')`);
  await mover(2, 2); await dormir(300);
  const cp = await medir(selOrbit);
  conferir(cp && cp.tit.title.includes(cp.tit.txt), 'compacto: título com o texto inteiro no hover', cp && cp.tit);
  const linhasTit = await av(`(() => { const t = document.querySelector('${selOrbit} .tit'); return Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)); })()`);
  conferir(linhasTit === 1, 'compacto: título em 1 linha', linhasTit);
  { const lc = await caixaLista(); if (lc) await foto('compacta', lc); }
  await av(`document.body.classList.remove('compacta')`);
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
