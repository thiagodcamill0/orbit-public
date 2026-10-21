// Foto da galeria como ícone do projeto (19/10, "Personalizar projeto" no index.html). Sobe o mock (ROTEIRO=0) numa
// porta livre de 47822–47826 e abre o index.html real no Edge headless (mudo):
//  - o botão "Foto" fica ao lado do campo de emoji; escolher uma imagem (retangular) abre "Ajustar foto" (20/10):
//    nada é gravado até "Usar foto"; Esc e "Cancelar" saem; régua, roda e "Afastar" mudam o zoom; arrastar move
//    a foto presa às bordas; "Usar foto" grava 'img:' + data URL de 128 px com exatamente o que estava no quadro,
//    e a foto aparece no popover e na lateral;
//  - a tag de cor continua por cima da foto; escolher um ícone da grade troca a foto; arquivo que não é imagem avisa;
//  - zero erros no console.
// Capturas em <pasta-de-saida>. Uso: node testes/projeto-foto-ui.test.mjs [pasta-de-saida]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-projeto-foto-ui'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (cond) { ok++; console.log('ok   ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
};

const PORTA = await escolherPorta(47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge');
fs.rmSync(perfil, { recursive: true, force: true });
const pcdp = 9600 + Math.floor(Math.random() * 150);
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
  const espera = async (expr, ms = 5000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await av(expr).catch(() => null); if (v) return v; await dormir(100); } return v; };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('DOM.enable');
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
  await cdp('Page.navigate', { url: BASE + '/' });
  await espera(`document.querySelectorAll('#projetos .proj-item[data-proj]').length > 0`, 15000);
  await espera(`(() => { const a = document.getElementById('abertura'); return !a || !a.isConnected || a.classList.contains('sai') || getComputedStyle(a).display === 'none'; })()`, 6000);
  await dormir(400);

  const P = await av(`document.querySelector('#projetos .proj-item[data-proj]').dataset.proj`);
  const sel = JSON.stringify('#projetos .proj-item[data-proj="' + P + '"]');
  await av(`document.querySelector(${sel}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), true`);
  await espera(`!document.getElementById('pj-pop')?.hidden`);
  const ui = await av(`(() => { const b = document.querySelector('#pj-pop .pj-foto-bt'), c = document.querySelector('#pj-pop .pj-linha .pj-campo'), a = document.querySelector('#pj-pop input[type=file]');
    const rb = b.getBoundingClientRect(), rc = c.getBoundingClientRect(), pop = document.getElementById('pj-pop').getBoundingClientRect();
    return { txt: b.textContent, aceita: a.accept, mesmaLinha: Math.abs(rb.top - rc.top) < 1, dentro: rb.right <= pop.right - 10, placeholderCabe: c.scrollWidth <= c.clientWidth }; })()`);
  conferir(ui.txt === 'Foto' && ui.aceita === 'image/*' && ui.mesmaLinha && ui.dentro && ui.placeholderCabe, 'botão "Foto" ao lado do campo, dentro do popover, aceita imagens', ui);

  // Imagem retangular (300×180), metade vermelha e metade azul, gravada num arquivo temporário deste teste
  const b64 = await av(`(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 180; const x = c.getContext('2d');
    x.fillStyle = '#e11d48'; x.fillRect(0, 0, 150, 180); x.fillStyle = '#2563eb'; x.fillRect(150, 0, 150, 180); return c.toDataURL('image/png').split(',')[1]; })()`);
  const arqImg = path.join(SAIDA, 'foto.png');
  fs.writeFileSync(arqImg, Buffer.from(b64, 'base64'));
  const escolher = async (arq) => {
    const doc = await cdp('DOM.getDocument', { depth: 0 });
    const no = await cdp('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#pj-pop input[type=file]' });
    await cdp('DOM.setFileInputFiles', { nodeId: no.result.nodeId, files: [arq] });
  };
  const icAtual = async () => av(`(async () => ((await (await fetch('/config')).json()).projetos[${JSON.stringify(P)}] || {}).icone || '')()`);
  const cortando = () => av(`document.getElementById('pj-pop').classList.contains('cortando')`);

  // Ajustar foto: abre o quadro, ainda não grava; Esc e "Cancelar" saem sem gravar e sem fechar o popover
  await escolher(arqImg);
  await espera(`document.getElementById('pj-pop').classList.contains('cortando') && document.querySelector('.pj-corte-img')?.complete`);
  const q0 = await av(`(() => { const q = document.querySelector('.pj-quadro'), i = document.querySelector('.pj-corte-img'), rq = q.getBoundingClientRect(), ri = i.getBoundingClientRect(), pop = document.getElementById('pj-pop').getBoundingClientRect();
    const vis = (s) => !!document.querySelector(s)?.getClientRects().length;
    return { lado: Math.round(rq.width), altura: Math.round(ri.height), centrada: Math.abs((ri.left + ri.right) / 2 - (rq.left + rq.right) / 2) < 1, grade: vis('#pj-pop .pj-grade'), cores: vis('#pj-pop .pj-cores'),
      foco: document.activeElement === q, zoom: document.querySelector('.pj-zoom').value, dentro: pop.bottom <= innerHeight && pop.top >= 0 }; })()`);
  conferir(q0.lado === 216 && q0.altura === 216 && q0.centrada && !q0.grade && !q0.cores && q0.foco && q0.zoom === '1' && q0.dentro,
    'o quadro "Ajustar foto" substitui grade e cores, foto cobrindo e centrada, foco no quadro', q0);
  conferir((await icAtual()) === '', 'nada gravado antes de "Usar foto"');
  await foto('0-ajustar-foto');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(150);
  conferir(!(await cortando()) && (await av(`!document.getElementById('pj-pop').hidden`)) && (await icAtual()) === '', 'Esc sai do ajuste sem gravar e sem fechar o popover');
  await escolher(arqImg);
  await espera(`document.getElementById('pj-pop').classList.contains('cortando')`);
  await av(`[...document.querySelectorAll('.pj-corte .link')].find((b) => b.textContent === 'Cancelar').click(), true`);
  conferir(!(await cortando()) && (await icAtual()) === '', '"Cancelar" sai do ajuste sem gravar');

  // Aproximar 2× pela régua e arrastar a foto toda para a esquerda: o recorte fica só no azul (lado direito)
  await escolher(arqImg);
  await espera(`document.getElementById('pj-pop').classList.contains('cortando') && document.querySelector('.pj-corte-img')?.complete`);
  await av(`(() => { const z = document.querySelector('.pj-zoom'); z.value = '2'; z.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const zoomLarg = await av(`Math.round(document.querySelector('.pj-corte-img').getBoundingClientRect().height)`);
  conferir(zoomLarg === 432, 'régua em 2× dobra a foto no quadro', zoomLarg);
  const c = await av(`(() => { const r = document.querySelector('.pj-quadro').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x - i * 60, y: c.y, button: 'left', buttons: 1 }); await dormir(16); }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x - 600, y: c.y, button: 'left', buttons: 0, clickCount: 1 });
  const arr = await av(`(() => { const q = document.querySelector('.pj-quadro').getBoundingClientRect(), i = document.querySelector('.pj-corte-img').getBoundingClientRect(); return { dir: Math.round(i.right - q.right), topo: Math.round(i.top - q.top) }; })()`);
  conferir(arr.dir === 0 && arr.topo <= 0, 'arrastar move a foto, presa à borda (nunca descobre o quadro)', arr);
  // Roda do mouse aproxima mais; Afastar volta; a foto continua cobrindo
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -200 });
  await dormir(100);
  const roda = await av(`Number(document.querySelector('.pj-zoom').value)`);
  conferir(roda > 2, 'roda do mouse aproxima', roda);
  await av(`document.querySelector('.pj-zoom-linha .btn-icone[aria-label="Afastar"]').click(), true`);
  conferir(Math.abs((await av(`Number(document.querySelector('.pj-zoom').value)`)) - roda / 1.25) < .02, '"Afastar" diminui o zoom');
  await av(`(() => { const z = document.querySelector('.pj-zoom'); z.value = '2'; z.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await foto('0b-ajustada');
  await av(`document.querySelector('.pj-usar').click(), true`);
  const salvo = await espera(`(async () => { const ic = ((await (await fetch('/config')).json()).projetos[${JSON.stringify(P)}] || {}).icone || ''; return ic.startsWith('img:') ? ic : null; })()`);
  conferir(/^img:data:image\/(webp|jpeg);base64,/.test(salvo || '') && salvo.length < 60000, 'foto gravada como img: + data URL pequena', (salvo || '').slice(0, 60) + ' … ' + (salvo || '').length);
  const servidor = await (await fetch(BASE + '/config')).json();
  conferir(servidor.projetos?.[P]?.icone === salvo, 'o POST /config levou a foto ao servidor');
  const dim = await av(`new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = ${JSON.stringify((salvo || '').slice(4))}; })`);
  conferir(dim[0] === 128 && dim[1] === 128, 'recortada em quadrado de 128 px', dim);
  const cores = await av(`new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.drawImage(i, 0, 0);
    r([4, 64, 124].map((px) => [...x.getImageData(px, 64, 1, 1).data].slice(0, 3))); }; i.src = ${JSON.stringify((salvo || '').slice(4))}; })`);
  conferir(cores.every(([r, , b]) => b > 180 && r < 80), 'o recorte é o que estava no quadro (2×, encostado à direita: só azul)', cores);
  conferir(!(await cortando()) && (await av(`document.activeElement === document.querySelector('#pj-pop .pj-foto-bt')`)), 'depois de "Usar foto", volta ao popover com o foco no botão "Foto"');
  const pint = await av(`(() => { const q = (s) => { const i = document.querySelector(s); if (!i) return null; const r = i.getBoundingClientRect(), p = i.parentElement; return { w: Math.round(r.width), cobre: Math.abs(r.width - p.clientWidth) < 1.5 && Math.abs(r.height - p.clientHeight) < 1.5, ok: i.complete && i.naturalWidth > 0 }; }; // dentro da borda
    return { pop: q('#pj-pop .pj-prev .pj-foto'), lat: q(${JSON.stringify('#projetos .proj-item[data-proj="' + P + '"] .av .pj-foto')}), pressionado: document.querySelector('#pj-pop .pj-foto-bt').getAttribute('aria-pressed'),
      grade: document.querySelectorAll('#pj-pop .pj-op[aria-pressed="true"]').length }; })()`);
  conferir(pint.pop?.cobre && pint.pop.ok && pint.lat?.cobre && pint.lat.ok, 'a foto cobre o ícone no popover e na lateral', pint);
  conferir(pint.pressionado === 'true' && pint.grade === 0, 'botão "Foto" marcado e nenhum ícone da grade', pint);
  await foto('1-popover-com-foto');

  // Tag de cor por cima da foto
  await av(`document.querySelector('#pj-pop .pj-cor[data-cor="#22c55e"]').click(), true`);
  const tag = await av(`(() => { const t = document.querySelector('#pj-pop .pj-prev .pj-tag'), f = document.querySelector('#pj-pop .pj-prev .pj-foto'); if (!t || !f) return null;
    const r = t.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === t || !!f; })()`);
  conferir(tag && (await av(`!!document.querySelector('#pj-pop .pj-prev .pj-foto') && !!document.querySelector('#pj-pop .pj-prev .pj-tag')`)), 'tag de cor junto da foto');
  // Agrupar por projeto: o cabeçalho da Home também pinta a foto, se estiver na tela
  await foto('2-foto-e-tag');

  // Arquivo que não é imagem: aviso, ícone não muda
  const arqTxt = path.join(SAIDA, 'nao-imagem.png');
  fs.writeFileSync(arqTxt, 'isto não é uma imagem');
  await escolher(arqTxt);
  const aviso = await espera(`[...document.querySelectorAll('.toast, #toast, [role=status]')].map((t) => t.textContent).join(' ').includes('usar essa foto')`, 4000);
  const aindaFoto = await av(`(async () => String((await (await fetch('/config')).json()).projetos[${JSON.stringify(P)}].icone).startsWith('img:'))()`);
  conferir(aviso && aindaFoto, 'arquivo inválido avisa e mantém a foto', { aviso, aindaFoto });

  // Ícone da grade troca a foto
  await av(`document.querySelector('#pj-pop .pj-op[data-ico="foguete"]').click(), true`);
  const troca = await av(`(async () => ({ ic: (await (await fetch('/config')).json()).projetos[${JSON.stringify(P)}].icone, foto: !!document.querySelector('#pj-pop .pj-prev .pj-foto'), bt: document.querySelector('#pj-pop .pj-foto-bt').getAttribute('aria-pressed') }))()`);
  conferir(troca.ic === 'foguete' && !troca.foto && troca.bt === 'false', 'escolher um ícone da grade troca a foto', troca);
  await av(`document.querySelector('#pj-pop .pj-pe .link').click(), true`);

  conferir(erros.length === 0, 'zero erros no console', erros);
  ws.close();
} catch (e) {
  falhas++;
  console.log('FALHA', 'execução', e.stack || e);
} finally {
  await fecharEdge(pcdp, perfil);
  mock.kill();
  for (const f of ['foto.png', 'nao-imagem.png']) fs.rmSync(path.join(SAIDA, f), { force: true });
}
console.log(`\n${ok} ok, ${falhas} falha(s). Capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
