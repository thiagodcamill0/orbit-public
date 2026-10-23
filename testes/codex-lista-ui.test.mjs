// Codex, etapa 1 (front): selo neutro "Codex" na lista, no card e na conversa; conversa por /codex/sessao/...; menu sem o que é só do Claude.
// Mock (testes/mock-servidor.mjs, MOCK_CODEX=1, ROTEIRO=0) numa porta livre de 47822–47826 + Edge headless mudo; nunca toca a 47821.
//   node testes/codex-lista-ui.test.mjs <pasta-de-saida>   (~20 s; uma captura da lista; sem argumento, tudo é apagado no fim)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PEDIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
const SAIDA = PEDIDA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-lista-'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47826); // o mock recusa a 47822
if (PORTA === 47822) throw new Error("só a 47822 está livre e o mock a recusa: espere os outros testes");
const BASE = `http://127.0.0.1:${PORTA}`;
const PERFIL = path.join(SAIDA, 'edge-codex-lista');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const COD = ['c0de0001-0000-4000-8000-000000000001', 'c0de0002-0000-4000-8000-000000000002'];
const CLAUDE = '3f2a9c1e-7b44-4d0a-9e15-2c8d6a0b1f01';
const SO_CLAUDE = ['Abrir no VS Code', 'Compactar contexto', 'Copiar /compact', 'Limpar conversa', 'Copiar /clear', 'Copiar claude --resume', 'Encerrar instância'];

let mock, pcdp, ws;
try {
  mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0', MOCK_CODEX: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

  const conv = await (await fetch(`${BASE}/codex/sessao/${COD[0]}/conversa`)).json();
  conferir(Array.isArray(conv.itens) && conv.itens.length === 3 && conv.itens[0].tipo === 'usuario', 'mock: GET /codex/sessao/:id/conversa devolve itens no formato do Claude', conv);

  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const esperar = async (expr, ms = 6000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await av(expr); if (v) return v; await dormir(100); } return v; };

  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__gets = []; const f = window.fetch; window.fetch = function (u, o) { try { const s = String(u); if (/\\/sessao\\/|\\/codex\\//.test(s) && !(o && o.method === 'POST')) window.__gets.push(s); } catch {} return f.apply(this, arguments); };` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`document.querySelectorAll('#lista .linha:not(.filho)').length >= 8`, 15000); await dormir(600);

  // ── selo na lista: só nas sessões do Codex ──
  const linhas = await av(`[...document.querySelectorAll('#lista .linha:not(.filho)')].filter((l) => l.dataset.id).map((l) => ({ id: l.dataset.id, selo: [...l.querySelectorAll('.cdx-selo')].map((e) => e.textContent) }))`);
  const doCodex = linhas.filter((l) => COD.includes(l.id));
  const doClaude = linhas.filter((l) => !COD.includes(l.id));
  conferir(doCodex.length === 2 && doCodex.every((l) => l.selo.length === 1 && l.selo[0] === 'Codex'), 'lista: as 2 sessões do Codex têm o selo "Codex" (uma vez cada)', doCodex);
  conferir(doClaude.length >= 6 && doClaude.every((l) => l.selo.length === 0), 'lista: nenhuma sessão do Claude tem selo', doClaude.filter((l) => l.selo.length));
  const estSelo = await av(`(() => { const e = document.querySelector('#lista .cdx-selo'); const l = e.closest('.linha'); const c = getComputedStyle(e); const t = l.querySelector('.tit').getBoundingClientRect(), r = e.getBoundingClientRect(); return { cor: c.color, fonte: parseFloat(c.fontSize), fundo: c.backgroundColor, ao_lado: r.left >= t.right - 1 && Math.abs((r.top + r.height / 2) - (t.top + t.height / 2)) < 12 }; })()`);
  conferir(estSelo.cor === 'rgb(136, 136, 136)' && estSelo.fonte <= 11 && estSelo.fundo === 'rgba(0, 0, 0, 0)', 'selo: texto pequeno, cinza neutro do tema (--t2), sem fundo colorido', estSelo);
  conferir(estSelo.ao_lado, 'selo: ao lado do nome (depois do título, na mesma linha)', estSelo);
  const resumos = await av(`window.OrbitFonteSessoes.lista().map((r) => ({ id: r.id, p: r.provedor, chaves: Object.keys(r).length }))`);
  conferir(resumos.filter((r) => r.p === 'codex').map((r) => r.id).sort().join() === COD.join() && resumos.filter((r) => 'p' in r && r.p !== undefined && r.p !== 'codex').length === 0, 'resumoSessao: provedor só nas do Codex', resumos.filter((r) => r.p));
  const cl = await av(`Object.keys(window.OrbitFonteSessoes.obter('${CLAUDE}')).sort().join()`);
  conferir(!cl.includes('provedor'), 'resumoSessao: a do Claude não ganha a chave provedor', cl);

  // captura pequena só da lista
  const r = await av(`(() => { const b = document.getElementById('lista').getBoundingClientRect(); return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.width, 1100), h: Math.min(b.height, 420) }; })()`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
  fs.writeFileSync(path.join(SAIDA, 'codex-lista.png'), Buffer.from(shot.result.data, 'base64'));

  // ── menu da linha ──
  const menu = async (id) => {
    await av(`(() => { const l = document.querySelector('#lista .linha[data-id="${id}"]'); const b = l.getBoundingClientRect(); l.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 120, clientY: b.y + 20 })); })()`);
    await esperar(`!!document.querySelector('.menu-flut:not([hidden]) .menu-item')`);
    return av(`[...document.querySelectorAll('.menu-flut:not([hidden]) .menu-item .mi-rot')].map((e) => e.textContent)`);
  };
  const fecharMenuEdge = async () => { await av('fecharMenu(false)'); await esperar(`!document.querySelector('.menu-flut:not([hidden])')`, 2000); };
  const mCod = await menu(COD[0]);
  conferir(mCod.length > 0 && SO_CLAUDE.every((x) => !mCod.includes(x)), 'menu Codex: sem VS Code, compactar, limpar, resume do Claude nem encerrar instância', mCod);
  conferir(['Abrir conversa', 'Ver detalhe', 'Renomear', 'Fixar no topo', 'Silenciar avisos', 'Copiar id', 'Apagar instância'].every((x) => mCod.includes(x)), 'menu Codex: mantém os genéricos', mCod);
  conferir(await av(`(() => { const f = [...document.querySelectorAll('.menu-flut:not([hidden]) > *')]; return !f.some((e, i) => e.classList.contains('menu-sep') && (i === f.length - 1 || f[i + 1].classList.contains('menu-sep'))); })()`), 'menu Codex: sem separador sobrando');
  await fecharMenuEdge();
  const mCla = await menu(CLAUDE);
  conferir(['Abrir no VS Code', 'Copiar claude --resume', 'Limpar conversa', 'Copiar /clear', 'Compactar contexto', 'Copiar /compact'].filter((x) => mCla.includes(x)).length >= 4 && mCla.includes('Abrir no VS Code') && mCla.includes('Copiar claude --resume'), 'menu Claude: continua com os itens de sempre', mCla);
  await fecharMenuEdge();

  // ── conversa do Codex ──
  await av(`window.__gets.length = 0`);
  await menu(COD[0]);
  await av(`[...document.querySelectorAll('.menu-flut:not([hidden]) .menu-item')].find((b) => b.textContent.includes('Abrir conversa')).click()`);
  conferir(!!(await esperar(`document.querySelector('.cv-itens')?.textContent.includes('Resposta do Codex')`, 8000)), 'conversa Codex: mostra os itens vindos de /codex/sessao/:id/conversa', await av(`document.querySelector('.cv-itens')?.textContent.slice(0, 120)`));
  const g1 = await av(`window.__gets`);
  conferir(g1.some((u) => u.includes(`/codex/sessao/${COD[0]}/conversa`)), 'conversa Codex: busca /codex/sessao/<id>/conversa', g1);
  conferir(!g1.some((u) => u.startsWith(`/sessao/${COD[0]}/`)), 'conversa Codex: nenhuma busca em /sessao/<id>/... do Claude (o detalhe /sessao/<id> do painel é do servidor, não da conversa)', g1);
  conferir(await av(`document.querySelectorAll('.cv .cdx-selo').length === 1 && document.querySelector('.cv .cdx-selo').textContent === 'Codex'`), 'conversa Codex: selo no cabeçalho da conversa');
  conferir(await av(`document.querySelectorAll('#pk-corpo .cdx-selo').length >= 1 && document.querySelectorAll('#pk-corpo .pk-l1 .cdx-selo').length === 1`), 'card da sessão: selo ao lado do estado');
  const comp = await av(`(() => { const e = document.querySelector('.cv-enviar'); const a = document.querySelector('.cv-b-assumir'); return { env: e.getAttribute('aria-disabled'), assumir: a ? a.hidden : null, motivo: document.querySelector('.cv-motivo')?.textContent || '' }; })()`);
  conferir(comp.env === 'true' && comp.assumir === true && /Codex/.test(comp.motivo), 'composer Codex só monitorado: envio desabilitado, sem "Assumir", com o motivo', comp);

  // ── conversa do Claude: sem selo e pela base de sempre ──
  await av(`window.__gets.length = 0`);
  await av(`window.OrbitFonteSessoes.abrir('${CLAUDE}')`);
  await esperar(`document.querySelector('#pk-peek')?.dataset.id === '${CLAUDE}' || document.getElementById('pk-corpo')`);
  await esperar(`window.__gets.some((u) => u.includes('/sessao/${CLAUDE}/conversa'))`, 8000);
  const g2 = await av(`window.__gets`);
  conferir(g2.some((u) => u.startsWith(`/sessao/${CLAUDE}/conversa`)) && !g2.some((u) => u.includes('/codex/')), 'conversa Claude: continua em /sessao/<id>/conversa, sem /codex/', g2);
  conferir(await av(`document.querySelectorAll('.cv .cdx-selo, #pk-corpo .cdx-selo').length === 0`), 'conversa/card do Claude: sem selo');

  conferir(!consoleErros.some((e) => !/favicon|\/modelos|Failed to load resource.*(404|503)/.test(e)), 'sem erros no console', consoleErros);
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
} finally {
  try { ws?.close(); } catch {}
  try { mock?.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  if (!PEDIDA) fs.rmSync(SAIDA, { recursive: true, force: true });
  console.log(JSON.stringify({ porta: PORTA, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
