// Codex, etapa 3 (front): pedidos de aprovação e perguntas do Codex nos mesmos cartões do Claude.
// Mock (testes/mock-servidor.mjs, MOCK_CODEX=1, ROTEIRO=0) numa porta livre de 47822–47826 + Edge headless mudo; nunca toca a 47821.
//   node testes/codex-permissoes-ui.test.mjs <pasta-de-saida>   (~30 s; uma captura; sem argumento, tudo é apagado no fim)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PEDIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
const SAIDA = PEDIDA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-perm-'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47826); // o mock recusa a 47822
if (PORTA === 47822) throw new Error('só a 47822 está livre e o mock a recusa: espere os outros testes');
const BASE = `http://127.0.0.1:${PORTA}`;
const PERFIL = path.join(SAIDA, 'edge-codex-perm');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const CMD = 'c0de0003-0000-4000-8000-000000000003';
const PER = 'c0de0004-0000-4000-8000-000000000004';
const CLAUDE = '3f2a9c1e-7b44-4d0a-9e15-2c8d6a0b1f01';
const corpoDe = (r) => { try { return JSON.parse(String(r).slice(String(r).indexOf('{'))); } catch { return null; } };

let mock, pcdp, ws;
try {
  mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0', MOCK_CODEX: '1', MOCK_CODEX_PERM: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

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
  // Botão do cartão pelo texto exato do rótulo.
  const clicar = (texto) => av(`(() => { const b = [...document.querySelectorAll('.cv-perm button')].find((x) => x.textContent.trim() === ${JSON.stringify(texto)}); if (!b) return false; b.click(); return true; })()`);
  const cartao = () => av(`(() => { const p = document.querySelector('.cv-perm'); if (!p || p.hidden) return null; return { tipo: p.dataset.tipo, texto: p.textContent, chip: p.querySelector('.cv-ferr-nome')?.textContent || '', sugs: [...p.querySelectorAll('.cv-perm-sug')].map((b) => b.textContent.trim()), botoes: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()) }; })()`);
  const idAtual = (i) => av(`fetch('/estado').then((r) => r.json()).then((d) => (d.sessoes.find((s) => s.id === '${i}').controle.permissao || {}).id)`);
  const reqs = () => av(`window.__req`);
  const achar = async (prefixo, ms = 4000) => { let r; const fim = Date.now() + ms; while (Date.now() < fim) { r = (await reqs()).find((x) => x.startsWith(prefixo)); if (r) return r; await dormir(100); } return null; };

  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__req = []; const f = window.fetch; window.fetch = function (u, o) { try { const s = String(u); if (/\\/sessao\\/|\\/codex\\//.test(s)) window.__req.push(((o && o.method) || 'GET') + ' ' + s + ((o && o.body && typeof o.body === 'string') ? ' ' + o.body : '')); } catch {} return f.apply(this, arguments); };` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`document.querySelectorAll('#lista .linha:not(.filho)').length >= 8 && !!document.getElementById('btn-nova')`, 15000);
  await av(`fetch('/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ codex: { ativo: true, exe: '' } }) }).then((r) => r.status)`);
  await esperar(`['${CMD}', '${PER}'].every((i) => document.querySelector('#lista .linha[data-id="' + i + '"]'))`, 10000);
  await dormir(500);

  // ── (a) lista: sessão Codex aguardando fica em "Precisa de você", como a do Claude ──
  // A faixa "Precisa de você" e o grupo da lista usam só o status: Codex aguardando entra como o Claude.
  const faixa = await av(`(() => { try { const l = OrbitFonteSessoes.lista().filter((s) => s.status === 'aguardando' || s.status === 'erro'); return { ids: l.map((s) => s.id), txt: document.querySelector('#faixa-acao .fa-cab')?.textContent || '', oculta: document.getElementById('faixa-acao').hidden }; } catch (e) { return { erro: String(e) }; } })()`);
  if (faixa.erro) throw new Error(faixa.erro);
  conferir(!faixa.oculta && faixa.ids.includes(CMD) && faixa.ids.includes(PER) && faixa.ids.includes(CLAUDE) && faixa.txt.includes(faixa.ids.length + ' sessões esperando'), 'faixa: Codex aguardando conta em "Precisa de você" como o Claude (mesma contagem da faixa)', faixa);
  conferir(await av(`!!document.querySelector('#lista .linha[data-id="${CMD}"] .cdx-selo')`), 'lista: a linha do Codex tem o selo Codex');

  // ── (b) comando: sugestão "nesta sessão" só porque veio em `sugestoes`; Permitir; Negar com motivo ──
  await av(`window.OrbitFonteSessoes.abrir('${CMD}')`);
  conferir(!!(await esperar(`(() => { const p = document.querySelector('.cv-perm'); return p && !p.hidden && p.textContent.includes('npm test'); })()`, 8000)), 'comando: o cartão de permissão abre com o comando');
  const c1 = await cartao();
  conferir(c1?.tipo === 'ferramenta' && c1.chip === 'CommandExecution' && /Permissão pedida/.test(c1.texto), 'comando: cartão de ferramenta, chip CommandExecution', c1);
  conferir(c1?.botoes.includes('Permitir') && c1.botoes.includes('Negar') && c1.botoes.includes('Negar com motivo…'), 'comando: botões Permitir, Negar e Negar com motivo', c1?.botoes);
  conferir(JSON.stringify(c1?.sugs) === JSON.stringify(['Permitir nesta sessão']), 'comando: a opção "nesta sessão" aparece porque veio em sugestoes', c1?.sugs);
  conferir(!/acesso total|full access|danger|never|nunca perguntar/i.test(c1?.texto || ''), 'comando: nenhuma opção de acesso total');
  conferir(/mais 2 pedidos na fila/.test(c1?.texto || ''), 'comando: mostra a fila (mais 2 pedidos)', c1?.texto);
  const id1 = await idAtual(CMD);
  // captura pequena do cartão do Codex
  const cr = await av(`(() => { const b = document.querySelector('.cv-perm').getBoundingClientRect(); return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.width, 900), h: Math.min(b.height, 420) }; })()`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: cr.x, y: cr.y, width: cr.w, height: cr.h, scale: 1 } });
  fs.writeFileSync(path.join(SAIDA, 'codex-permissao.png'), Buffer.from(shot.result.data, 'base64'));

  await av(`window.__req.length = 0`);
  await clicar('Permitir nesta sessão');
  const r1 = await achar(`POST /codex/sessao/${CMD}/permissao`);
  conferir(!!r1 && JSON.stringify(corpoDe(r1)) === JSON.stringify({ id: id1, decisao: 'permitir', sugestao: 0 }), 'comando: "nesta sessão" chama /codex/sessao/:id/permissao com {id, decisao:permitir, sugestao:0}', r1);
  // 2º pedido da fila: sem sugestão; Permitir simples
  conferir(!!(await esperar(`(() => { const p = document.querySelector('.cv-perm'); return p && !p.hidden && p.textContent.includes('node --check servidor.mjs'); })()`, 8000)), 'fila: o 2º pedido aparece depois de responder o 1º');
  const c2 = await cartao();
  conferir(c2?.sugs.length === 0, 'fila: sem "nesta sessão" quando o servidor não manda sugestões', c2?.sugs);
  const id2 = await idAtual(CMD);
  await av(`window.__req.length = 0`);
  await clicar('Permitir');
  const r2 = await achar(`POST /codex/sessao/${CMD}/permissao`);
  conferir(!!r2 && JSON.stringify(corpoDe(r2)) === JSON.stringify({ id: id2, decisao: 'permitir' }), 'comando: Permitir manda {id, decisao:permitir} à rota do Codex', r2);
  // 3º pedido: Negar com motivo
  conferir(!!(await esperar(`(() => { const p = document.querySelector('.cv-perm'); return p && !p.hidden && p.textContent.includes('git status'); })()`, 8000)), 'fila: o 3º pedido aparece');
  const id3 = await idAtual(CMD);
  await av(`document.querySelector('.cv-perm .cv-perm-link').click()`);
  await av(`(() => { const t = document.querySelector('.cv-perm .cv-perm-txt'); t.value = 'Não rode agora'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await av(`window.__req.length = 0`);
  await clicar('Negar com o motivo');
  const r3 = await achar(`POST /codex/sessao/${CMD}/permissao`);
  conferir(!!r3 && JSON.stringify(corpoDe(r3)) === JSON.stringify({ id: id3, decisao: 'negar', mensagem: 'Não rode agora' }), 'comando: Negar com motivo manda {id, decisao:negar, mensagem}', r3);
  conferir(!!(await esperar(`document.querySelector('.cv-perm').hidden`, 6000)), 'comando: o cartão some depois da última resposta');
  const mock1 = await (await fetch(BASE + '/_mock/respostas')).json();
  conferir(mock1.filter((x) => x.sessao === CMD && x.via === 'codex').length === 3, 'comando: o servidor recebeu as 3 respostas pela rota do Codex', mock1.map((x) => [x.sessao, x.via, x.decisao]));

  // ── (c) pergunta com opções: respostas ──
  await av(`window.OrbitFonteSessoes.abrir('${PER}')`);
  conferir(!!(await esperar(`(() => { const p = document.querySelector('.cv-perm'); return p && !p.hidden && p.dataset.tipo === 'pergunta'; })()`, 8000)), 'pergunta: cartão de pergunta abre');
  const cp = await cartao();
  conferir(/Qual cor\?/.test(cp?.texto || '') && /azul/.test(cp.texto) && /verde/.test(cp.texto) && cp.botoes.includes('Responder'), 'pergunta: texto, opções azul/verde e botão Responder', cp);
  const idp = await idAtual(PER);
  await av(`window.__req.length = 0`);
  await clicar('Responder'); // sem escolher: não envia
  await dormir(300);
  conferir(!(await reqs()).some((x) => x.includes('/permissao')), 'pergunta: Responder sem escolher não envia nada');
  await av(`[...document.querySelectorAll('.cv-perm .cv-op')].find((l) => l.textContent.includes('verde')).click()`);
  await esperar(`document.querySelector('.cv-perm .btn.p.cv-primario').getAttribute('aria-disabled') === 'false'`, 3000);
  await clicar('Responder');
  const rp = await achar(`POST /codex/sessao/${PER}/permissao`);
  conferir(!!rp && JSON.stringify(corpoDe(rp)) === JSON.stringify({ id: idp, decisao: 'permitir', respostas: { 'Qual cor?': 'verde' } }), 'pergunta: manda {id, decisao:permitir, respostas:{"Qual cor?":"verde"}} à rota do Codex', rp);
  conferir(!!(await esperar(`document.querySelector('.cv-perm').hidden`, 6000)), 'pergunta: o cartão some depois de responder');

  // ── (d) Claude segue na rota do Claude ──
  await av(`window.OrbitFonteSessoes.abrir('${CLAUDE}')`);
  conferir(!!(await esperar(`(() => { const p = document.querySelector('.cv-perm'); return p && !p.hidden && p.dataset.tipo === 'ferramenta' && p.textContent.includes('npm run test'); })()`, 8000)), 'Claude: o cartão de permissão abre');
  await av(`window.__req.length = 0`);
  await clicar('Permitir');
  const rc = await achar(`POST /sessao/${CLAUDE}/permissao`);
  conferir(!!rc && JSON.stringify(corpoDe(rc)) === JSON.stringify({ id: 'perm-1', decisao: 'permitir' }), 'Claude: Permitir chama /sessao/:id/permissao com o corpo de sempre', rc);
  conferir(!(await reqs()).some((x) => x.includes('/codex/')), 'Claude: nenhuma chamada /codex/');

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
