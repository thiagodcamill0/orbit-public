// Imagens anexadas (16/10), na página de verdade: servidor de teste (47822–47826) com o claude-falso + Edge headless.
// Rodar:  node testes/anexos-ui.test.mjs [pasta-das-capturas]
// Confere, na Nova instância: anexar pelo botão, por Ctrl+V e soltando o arquivo; miniaturas; remover; ampliar
// (Esc fecha só o visor); criar com a 1ª mensagem levando as imagens. Na Conversa: colar, a bolha otimista, o eco
// com as imagens lidas do transcript (GET /imagem), ampliar com ← →, e as URLs blob: soltas depois do envio.
// No fim, o transcript do claude-falso tem os blocos image. Fecha o Edge, desliga o servidor e apaga os dados.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.join(os.tmpdir(), 'gerenciador-testes', `anexos-ui-${Date.now()}`);
const DADOS = path.join(BASE, 'dados');
const PERFIL = path.join(BASE, 'edge');
const PASTA_NOVA = path.join(BASE, 'projeto-imagens');
const SAIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
for (const d of [DADOS, path.join(DADOS, 'sessoes'), path.join(DADOS, 'projetos'), PERFIL, PASTA_NOVA]) fs.mkdirSync(d, { recursive: true });
if (SAIDA) fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTA = await escolherPorta(47825);
const URL_BASE = `http://127.0.0.1:${PORTA}`;
const saude = async () => { try { return await (await fetch(URL_BASE + '/saude')).json(); } catch { return null; } };

const env = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_MODELOS_INICIO: '300',
  FALSO_LOG: path.join(DADOS, 'falso.log'),
};
delete env.GERENCIADOR_REINICIOS;
delete env.CLAUDECODE;

let pcdp = 0;
let srv = null;
let ok = 0, falhas = 0;
const conferir = (cond, rotulo, extra) => { if (cond) ok++; else falhas++; console.log(`${cond ? 'ok   ' : 'FALHA'} ${rotulo}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`); };

// Na página: um PNG (azul em cima, amarelo embaixo) como File, e os três jeitos de anexar.
const JS_ARQUIVO = `async (nome, w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#3b6fe6'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#f4cf2a'; g.fillRect(0, h / 2, w, h / 2);
  g.fillStyle = '#111'; g.font = 'bold ' + Math.round(h / 6) + 'px sans-serif'; g.fillText(nome, 8, h / 2 - 8);
  const b = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([b], nome + '.png', { type: 'image/png' });
}`;
const colar = (sel, nome, w = 320, h = 200) => `(async () => {
  const f = await (${JS_ARQUIVO})(${JSON.stringify(nome)}, ${w}, ${h});
  const dt = new DataTransfer(); dt.items.add(f);
  document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
})()`;
const soltar = (sel, nome) => `(async () => {
  const f = await (${JS_ARQUIVO})(${JSON.stringify(nome)}, 640, 360);
  const dt = new DataTransfer(); dt.items.add(f);
  const alvo = document.querySelector(${JSON.stringify(sel)});
  alvo.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  const sobre = alvo.closest('.ax-arrastando') !== null || alvo.querySelector('.ax-solte') && getComputedStyle(alvo.querySelector('.ax-solte')).display !== 'none';
  alvo.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return sobre;
})()`;
const pelaEntrada = (sel, nome) => `(async () => {
  const f = await (${JS_ARQUIVO})(${JSON.stringify(nome)}, 2600, 1400);
  const dt = new DataTransfer(); dt.items.add(f);
  const i = document.querySelector(${JSON.stringify(sel)} + ' input[type=file]');
  i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], { env, stdio: 'ignore' });
  let s0 = null;
  for (let i = 0; i < 60 && !(s0 && s0.pid === srv.pid); i++) { await dormir(150); s0 = await saude(); }
  if (!s0 || s0.pid !== srv.pid) throw new Error('o servidor do teste não subiu');
  for (let i = 0; i < 40; i++) { const r = await fetch(URL_BASE + '/modelos'); if (r.ok) break; await dormir(250); }

  const EDGE = caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9450 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo = null;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pend = new Map();
  const erros = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Runtime.exceptionThrown') erros.push(j.params.exceptionDetails?.exception?.description || 'exceção');
    if (j.method === 'Runtime.consoleAPICalled' && j.params.type === 'error') erros.push(j.params.args.map((x) => x.value ?? x.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  const ate = async (expr, ms = 6000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = await av(expr); if (v) return v; await dormir(120); } return null; };
  const foto = async (nome, sel) => {
    if (!SAIDA) return;
    const c = sel ? await av(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`) : null;
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(c ? { clip: { ...c, scale: 2 } } : {}) });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const tecla = async (key, code, vk) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await dormir(200);
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: URL_BASE + '/?abas=0' }); // rodada 9: a Conversa no detalhe (sem as abas)
  await ate(`!!document.getElementById('btn-nova') && document.readyState === 'complete'`);
  await dormir(800);

  // ───── Nova instância ─────
  await av(`document.getElementById('btn-nova').click()`);
  conferir(await ate(`!!window.Anexos && !!document.querySelector('#ni-pop:not([hidden]) .ni-anexos .ax-botao')`), 'popover aberto com o botão Imagens');
  await av(`(() => { const s = document.getElementById('ni-pasta'); s.value = '\\u0000outra'; s.dispatchEvent(new Event('change', { bubbles: true }));
    const o = document.getElementById('ni-outra'); o.value = ${JSON.stringify(PASTA_NOVA)}; o.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await av(colar('#ni-texto', 'colada'));
  const sobre = await av(soltar('#ni-pop', 'solta'));
  conferir(sobre, 'arrastando sobre o popover: o aviso "Solte para anexar" aparece');
  await av(pelaEntrada('#ni-pop .ni-anexos', 'grande'));
  conferir(await ate(`document.querySelectorAll('#ni-pop .ax-mini:not(.ax-preparando) img').length === 3`), '3 miniaturas prontas (colar, soltar, botão)');
  conferir(await av(`!document.querySelector('#ni-pop .ax-solte') || getComputedStyle(document.querySelector('#ni-pop .ax-solte')).display === 'none'`), 'o aviso de soltar some depois do drop');
  await foto('1-nova-instancia', '#ni-pop');
  // A grande (2600 px) foi reduzida para 2000 px no lado maior.
  const lados = await av(`Promise.all([...document.querySelectorAll('#ni-pop .ax-mini img')].map((i) => i.decode().then(() => Math.max(i.naturalWidth, i.naturalHeight))))`);
  conferir(Array.isArray(lados) && lados[2] === 2000 && lados[0] === 320, 'a imagem de 2600 px vai com 2000 px; as pequenas, como estão', lados);
  // Remover a do meio.
  await av(`document.querySelectorAll('#ni-pop .ax-mini')[1].querySelector('.ax-tirar').click()`);
  conferir(await ate(`document.querySelectorAll('#ni-pop .ax-mini').length === 2`), 'remover tira a miniatura');
  // Ampliar e fechar com Esc: o popover continua aberto.
  await av(`document.querySelector('#ni-pop .ax-mini .ax-vista').click()`);
  conferir(await ate(`!!document.querySelector('.ax-visor .ax-foto') && document.querySelector('.ax-visor .ax-conta').textContent === '1 de 2'`), 'ampliar abre o visor (1 de 2)');
  await dormir(300); // a entrada do visor anima
  await foto('2-visor');
  await tecla('ArrowRight', 'ArrowRight', 39);
  conferir(await av(`document.querySelector('.ax-visor .ax-conta').textContent`) === '2 de 2', '→ passa para a próxima');
  await tecla('Escape', 'Escape', 27);
  conferir(await ate(`!document.querySelector('.ax-visor') && !document.getElementById('ni-pop').hidden`), 'Esc fecha só o visor; o popover fica');

  await av(`(() => { const t = document.getElementById('ni-texto'); t.value = 'Veja estas telas'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.ni-criar').click(); return true; })()`);
  conferir(await ate(`document.getElementById('ni-pop').hidden`, 8000), 'criou e fechou o popover');
  conferir(await av(`document.querySelectorAll('#ni-pop .ax-mini').length === 0`), 'o rascunho de imagens esvaziou depois de criar');

  // ───── Conversa ─────
  const cv = '#pk-conversa';
  const galeriaServidor = (n) => `[...document.querySelectorAll('${cv} .cv-usuario:not(.cv-local) .ax-galeria')].filter((g) => [...g.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0 && i.getAttribute('src').startsWith('/sessao/'))).length >= ${n}`;
  conferir(await ate(`!!document.querySelector('${cv}:not([hidden]) .cv-texto')`, 8000), 'a Conversa da instância nova abriu');
  conferir(await ate(galeriaServidor(1), 10000), 'a 1ª mensagem aparece com as 2 imagens lidas do transcript');
  conferir(await av(`(() => { const u = [...document.querySelectorAll('${cv} .cv-usuario')].find((x) => x.querySelector('.ax-galeria')); return u && u.querySelectorAll('.ax-galeria img').length === 2 && u.querySelector('.cv-bolha').textContent === 'Veja estas telas'; })()`), 'galeria com 2 imagens e o texto na bolha');
  // Esperar a volta terminar (o envio fica liberado).
  for (let i = 0; i < 60; i++) {
    const s = (await (await fetch(URL_BASE + '/estado')).json()).sessoes.find((x) => x.origem === 'orbit');
    if (s?.controle && !s.controle.ocupada && s.controle.processo !== 'iniciando' && !/inician/i.test(s.controle.motivo || '')) break;
    await dormir(200);
  }

  await av(colar(`${cv} .cv-texto`, 'print'));
  conferir(await ate(`document.querySelectorAll('${cv} .cv-campo .ax-mini:not(.ax-preparando) img').length === 1`), 'Ctrl+V na conversa: miniatura acima do texto');
  conferir(await av(`document.querySelector('${cv} .cv-enviar').getAttribute('aria-disabled') === 'false'`), 'só com a imagem, o Enviar fica liberado');
  await foto('3-compositor', `${cv} .cv-compor`);
  const blobs = await av(`[...document.querySelectorAll('${cv} .cv-campo .ax-mini img')].map((i) => i.src)`);
  await av(`(() => { const t = document.querySelector('${cv} .cv-texto'); t.focus(); t.value = 'e este print?'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await tecla('Enter', 'Enter', 13);
  conferir(await av(`document.querySelectorAll('${cv} .cv-campo .ax-mini').length === 0 && document.querySelector('${cv} .cv-texto').value === ''`), 'enviar esvazia o campo e as miniaturas');
  conferir(await ate(galeriaServidor(2), 10000), 'o eco chega com a imagem do transcript e substitui a bolha otimista');
  conferir(await av(`document.querySelectorAll('${cv} .cv-local').length === 0`), 'nenhuma bolha otimista sobrando');
  // A URL blob: da miniatura foi solta (cópia temporária na memória).
  const solta = await av(`fetch(${JSON.stringify(blobs[0] || '')}).then(() => false, () => true)`);
  conferir(solta, 'a URL blob: da miniatura enviada foi revogada');
  await foto('4-conversa', cv);
  // Ampliar no histórico: Esc fecha só o visor, o painel fica.
  await av(`[...document.querySelectorAll('${cv} .ax-galeria .ax-vista')].pop().click()`);
  conferir(await ate(`!!document.querySelector('.ax-visor .ax-foto') && document.querySelector('.ax-visor .ax-foto').naturalWidth > 0`), 'imagem do histórico ampliada');
  await tecla('Escape', 'Escape', 27);
  conferir(await ate(`!document.querySelector('.ax-visor') && !document.querySelector('${cv}').hidden`), 'Esc fecha o visor e a Conversa continua aberta');

  // O transcript do claude-falso tem os blocos image (o que o claude de verdade recebeu no stdin).
  const projs = path.join(DADOS, 'projetos');
  const linhas = fs.readdirSync(projs).flatMap((d) => fs.readdirSync(path.join(projs, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(projs, d, f)))
    .flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n')).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'image'));
  conferir(linhas.length === 2 && linhas[0].message.content.filter((b) => b.type === 'image').length === 2 && linhas[1].message.content.at(-1).text === 'e este print?', 'stdin do claude: 2 imagens + texto, depois 1 imagem + texto', linhas.map((e) => e.message.content.map((b) => b.type)));
  conferir(erros.length === 0, 'sem exceção nem erro no console' + (erros.length ? ': ' + erros.join(' | ') : ''));
} catch (e) {
  falhas++;
  console.log('FALHA', e.stack || e.message);
} finally {
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  const s = await saude();
  if (s?.pid) await desligarSeMeu(PORTA, s.pid);
  await dormir(500);
  const m = (() => { try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch { return null; } })();
  if (m?.pid) try { process.kill(m.pid); } catch {}
  await dormir(300);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
