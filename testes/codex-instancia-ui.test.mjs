// Codex, etapa 2 (front): criar instância Codex, conversar, parar e "Continuar no Orbit" numa sessão só monitorada.
// Mock (testes/mock-servidor.mjs, MOCK_CODEX=1, ROTEIRO=0) numa porta livre de 47822–47826 + Edge headless mudo; nunca toca a 47821.
//   node testes/codex-instancia-ui.test.mjs <pasta-de-saida>   (~40 s; uma captura; sem argumento, tudo é apagado no fim)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PEDIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
const SAIDA = PEDIDA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-inst-'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47826); // o mock recusa a 47822
if (PORTA === 47822) throw new Error('só a 47822 está livre e o mock a recusa: espere os outros testes');
const BASE = `http://127.0.0.1:${PORTA}`;
const PERFIL = path.join(SAIDA, 'edge-codex-inst');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const COD = ['c0de0001-0000-4000-8000-000000000001', 'c0de0002-0000-4000-8000-000000000002'];
const CLAUDE = '3f2a9c1e-7b44-4d0a-9e15-2c8d6a0b1f01';
const PASTA_NOVA = 'D:\\Projetos\\codex-demo';

let mock, pcdp, ws;
try {
  mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0', MOCK_CODEX: '1' }, stdio: 'ignore' });
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

  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__req = []; const f = window.fetch; window.fetch = function (u, o) { try { const s = String(u); if (/\\/sessao\\/|\\/codex\\//.test(s) || /\\/instancias/.test(s)) window.__req.push(((o && o.method) || 'GET') + ' ' + s + ((o && o.body && typeof o.body === 'string') ? ' ' + o.body : '')); } catch {} return f.apply(this, arguments); }; window.__es = []; const E = window.EventSource; window.EventSource = function (u, o) { window.__es.push(String(u)); return new E(u, o); }; window.EventSource.prototype = E.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSED']) window.EventSource[k] = E[k];` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`document.querySelectorAll('#lista .linha:not(.filho)').length >= 8 && !!document.getElementById('btn-nova')`, 15000); await dormir(600);

  // ── (a) sem a chave: popover como sempre ──
  await av(`document.getElementById('btn-nova').click()`);
  conferir(await esperar(`!!document.querySelector('#ni-pop:not([hidden]) #ni-pasta')`, 8000), 'sem a chave: popover Nova instância abre');
  conferir(await av(`!document.getElementById('ni-rot-prov') && !document.querySelector('.ni-prov') && !document.querySelector('.ni-codex-nota') && !document.getElementById('ni-pop').hasAttribute('data-prov')`), 'sem a chave: sem seletor de agente, sem nota, sem data-prov');
  conferir(await av(`getComputedStyle(document.getElementById('ni-modelo')).display !== 'none' && getComputedStyle(document.querySelector('#ni-pop .ni-anexos')).display !== 'none'`), 'sem a chave: modelo e imagens visíveis');
  await av(`document.querySelector('#ni-pop .ni-x').click()`);
  await esperar(`document.getElementById('ni-pop').hidden`, 2000);

  // ── liga a chave (como a seção das Configurações faz) ──
  await av(`fetch('/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ codex: { ativo: true, exe: '' } }) }).then((r) => r.status)`);
  await esperar(`(() => { try { return window.OrbitFonteSessoes && true; } catch { return false; } })()`);
  await dormir(500);

  // ── (b) com a chave: seletor, escolha do Codex, criação ──
  await av(`document.getElementById('btn-nova').click()`);
  conferir(await esperar(`!!document.querySelector('#ni-pop:not([hidden]) #ni-rot-prov') && document.querySelectorAll('#ni-pop .ni-prov button[data-v]').length === 2`, 8000), 'com a chave: seletor Claude | Codex no popover');
  conferir(await av(`document.querySelector('.ni-prov [data-v="claude"]').getAttribute('aria-checked') === 'true'`), 'com a chave: Claude vem marcado');
  await av(`fetch('/_mock/codex-modelos', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ falha: true }) }).then((r) => r.status)`);
  await av(`document.querySelector('.ni-prov [data-v="codex"]').click()`);
  const vis = await av(`(() => { const d = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).display : 'ausente'; }; const nota = document.querySelector('.ni-codex-nota'); return { prov: document.getElementById('ni-pop').dataset.prov, par: d('#ni-pop .ni-par'), perm: d('#ni-rot-perm'), sk: d('#ni-rot-sk'), ax: d('#ni-pop .ni-anexos'), nota: nota && !nota.hidden ? nota.textContent : null, sub: document.querySelector('.ni-cab-txt small').textContent }; })()`);
  conferir(vis.prov === 'codex' && vis.par !== 'none' && vis.par !== 'ausente' && vis.perm === 'none' && vis.sk === 'none' && vis.ax === 'none', 'Codex escolhido: modelo/esforço continuam; permissão, skills e imagens somem', vis);
  conferir(/pede aprovação/.test(vis.nota || '') && vis.sub === 'Codex no Orbit', 'Codex escolhido: nota de permissão e subtítulo "Codex no Orbit"', vis);

  // ── seletores de modelo e esforço do Codex (GET /codex/modelos) ──
  const sel = (id) => `(() => { const s = document.getElementById('${id}'); return { opcoes: [...s.options].map((o) => o.value), rotulos: [...s.options].map((o) => o.textContent), valor: s.value, off: s.disabled }; })()`;
  const falha = (v) => av(`fetch('/_mock/codex-modelos', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ falha: ${v} }) }).then((r) => r.status)`);
  const aviso = await esperar(`(() => { const n = [...document.querySelectorAll('#ni-pop .ni-nota')].find((x) => !x.hidden && /Codex ainda não informou/.test(x.textContent)); return n ? n.textContent : null; })()`, 6000);
  conferir(!!aviso && /padrão do Codex/.test(aviso), 'Codex com 503: aviso discreto "ainda não informou os modelos"', aviso);
  const m503 = await av(sel('ni-modelo')), e503 = await av(sel('ni-esforco'));
  conferir(m503.opcoes.length === 1 && m503.opcoes[0] === '' && m503.off && e503.off, 'Codex com 503: só "padrão" (modelo e esforço desabilitados)', { m503, e503 });
  await falha(false);
  await av(`[...document.querySelectorAll('#ni-pop .ni-nota button.link')].find((b) => /Tentar de novo/.test(b.textContent)).click()`);
  conferir(await esperar(`document.getElementById('ni-modelo').options.length === 3`, 6000), 'Codex: "Tentar de novo" carrega /codex/modelos (padrão + 2 modelos)');
  const mc = await av(sel('ni-modelo')), ec = await av(sel('ni-esforco'));
  conferir(mc.opcoes.join() === ',gpt-5.5,gpt-5.4' && !mc.off && mc.valor === '' && /GPT-5\.5 · padrão/.test(mc.rotulos[1]), 'Codex: modelos da lista, "Padrão do Codex" selecionado', mc);
  conferir(ec.opcoes.join() === ',low,medium,high,xhigh' && !ec.off, 'Codex sem modelo escolhido: esforços do modelo padrão', ec);
  conferir(await av(`![...document.querySelectorAll('#ni-pop .ni-nota')].some((x) => !x.hidden && /ainda não informou/.test(x.textContent))`), 'Codex com a lista: o aviso some');
  await av(`(() => { const s = document.getElementById('ni-modelo'); s.value = 'gpt-5.4'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const e54 = await av(sel('ni-esforco'));
  conferir(e54.opcoes.join() === ',low,medium,high', 'Codex: trocar o modelo troca os esforços (gpt-5.4 sem xhigh)', e54);
  await av(`(() => { const s = document.getElementById('ni-esforco'); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await av(`document.querySelector('.ni-prov [data-v="claude"]').click()`);
  const mcl = await av(sel('ni-modelo'));
  conferir(!mcl.opcoes.some((v) => /^gpt/.test(v)) && mcl.opcoes.length > 1 && await av(`getComputedStyle(document.getElementById('ni-rot-perm')).display !== 'none'`), 'voltar ao Claude: seletores do Claude (sem modelos gpt) e permissão de volta', mcl);
  await av(`document.querySelector('.ni-prov [data-v="codex"]').click()`);
  const mvolta = await av(sel('ni-modelo')), evolta = await av(sel('ni-esforco'));
  conferir(mvolta.valor === 'gpt-5.4' && evolta.valor === 'high', 'Codex de novo: a escolha (gpt-5.4, alto) foi guardada', { mvolta, evolta });
  await av(`(() => { const m = document.getElementById('ni-modelo'); m.value = ''; m.dispatchEvent(new Event('change', { bubbles: true })); const e = document.getElementById('ni-esforco'); e.value = ''; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await av(`(() => { const s = document.getElementById('ni-pasta'); s.value = '\\u0000outra'; s.dispatchEvent(new Event('change', { bubbles: true }));
    const o = document.getElementById('ni-outra'); o.value = ${JSON.stringify(PASTA_NOVA)}; o.dispatchEvent(new Event('input', { bubbles: true }));
    const t = document.getElementById('ni-texto'); t.value = 'Liste os arquivos do projeto'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.ni-criar').click()`);
  conferir(await esperar(`document.getElementById('ni-pop').hidden`, 8000), 'criar: o popover fecha');
  const req1 = await av(`window.__req`);
  const pCria = req1.find((r) => r.startsWith('POST /codex/instancias'));
  conferir(!!pCria && pCria.includes('codex-demo') && !/permissao|modelo|imagens|skills/.test(pCria), 'criar: POST /codex/instancias só com pasta/texto (sem permissão, modelo, imagens, skills)', req1);
  conferir(!req1.some((r) => r.startsWith('POST /instancias')), 'criar: nada foi para o POST /instancias do Claude', req1);
  const idNovo = await esperar(`(window.OrbitFonteSessoes.lista().find((r) => r.provedor === 'codex' && !${JSON.stringify(COD)}.includes(r.id)) || {}).id`, 8000);
  conferir(!!idNovo, 'criar: a sessão Codex nova entra na lista', idNovo);
  conferir(!!(await esperar(`document.querySelector('.cv-itens')?.textContent.includes('Liste os arquivos do projeto')`, 10000)), 'conversa: abre a instância criada com a 1ª mensagem');
  const ao = await esperar(`document.querySelector('.cv-b-parar') && !document.querySelector('.cv-b-parar').hidden`, 8000);
  conferir(!!ao, 'durante o turno: botão Parar visível');
  conferir(!!(await esperar(`document.querySelector('.cv-itens')?.textContent.includes('Leio o arquivo citado')`, 8000)), 'texto ao vivo: itens do fluxo /codex/sessao/:id/conversa/fluxo chegam');
  conferir(await av(`window.__es.some((u) => u.startsWith('/codex/sessao/${idNovo}/conversa/fluxo'))`), 'texto ao vivo: o SSE é o do Codex');
  const final = await esperar(`document.querySelector('.cv-itens')?.textContent.includes('Recebido: “Liste os arquivos')`, 12000);
  conferir(!!final, 'texto ao vivo: a resposta do Codex aparece');
  await esperar(`!document.querySelector('.cv-b-parar') || document.querySelector('.cv-b-parar').hidden`, 8000);

  // enviar outra mensagem e parar
  await av(`(() => { const t = document.querySelector('.cv-texto'); t.value = 'Agora rode os testes'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await esperar(`document.querySelector('.cv-enviar').getAttribute('aria-disabled') === 'false'`, 3000);
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.cv-enviar').click()`);
  conferir(!!(await esperar(`document.querySelector('.cv-itens')?.textContent.includes('Agora rode os testes')`, 8000)), 'enviar: a mensagem aparece na conversa do Codex');
  await esperar(`document.querySelector('.cv-b-parar') && !document.querySelector('.cv-b-parar').hidden`, 8000);
  // captura pequena: instância Codex trabalhando
  const cr = await av(`(() => { const b = document.querySelector('.cv').getBoundingClientRect(); return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.width, 900), h: Math.min(b.height, 520) }; })()`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: cr.x, y: cr.y, width: cr.w, height: cr.h, scale: 1 } });
  fs.writeFileSync(path.join(SAIDA, 'codex-instancia.png'), Buffer.from(shot.result.data, 'base64'));
  await av(`document.querySelector('.cv-b-parar').click()`);
  conferir(!!(await esperar(`window.__req.some((r) => r.startsWith('POST /codex/sessao/${idNovo}/parar'))`, 4000)), 'parar: POST /codex/sessao/:id/parar');
  conferir(!!(await esperar(`OrbitFonteSessoes.obter('${idNovo}').status === 'interrompida' || document.querySelector('.cv-itens')?.textContent.toLowerCase().includes('interromp')`, 8000)), 'parar: a volta termina interrompida');
  const req2 = await av(`window.__req`);
  conferir(req2.some((r) => r.startsWith(`POST /codex/sessao/${idNovo}/mensagem`)) && !req2.some((r) => r.includes(`POST /sessao/${idNovo}`)), 'enviar/parar: tudo por /codex/sessao/, nada em /sessao/<id> do Claude', req2);
  conferir(await av(`(() => { const c = document.querySelector('.cv'); return !!c && !!document.querySelector('.cv-b-assumir')?.hidden && !document.querySelector('.cv-b-compactar')?.hidden && !!document.querySelector('.cv-b-limpar')?.hidden; })()`), 'conversa Codex orbit: sem Assumir e Limpar; Compactar visivel (etapa 4)');
  conferir(await av(`!document.querySelector('.cv .ax-botao') || document.querySelector('.cv .ax-botao').hidden || getComputedStyle(document.querySelector('.cv .ax-botao')).display === 'none' || document.querySelector('.cv .ax-botao').disabled`), 'conversa Codex: sem anexo de imagens');

  // ── (c) sessão só monitorada: "Continuar no Orbit" ──
  await av(`window.__req.length = 0`);
  await av(`window.OrbitFonteSessoes.abrir('${COD[1]}')`);
  await esperar(`document.querySelector('.cv-itens')?.textContent.includes('Resposta do Codex 2')`, 8000);
  const ret = await esperar(`(() => { const b = document.querySelector('.cv-b-retomar'); return b && !b.hidden ? b.textContent.trim() : null; })()`, 5000);
  conferir(/Continuar no Orbit/.test(ret || ''), 'monitorada: o botão diz "Continuar no Orbit"', ret);
  conferir(await av(`document.querySelector('.cv-enviar').getAttribute('aria-disabled') === 'true' && !!document.querySelector('.cv-b-assumir').hidden`), 'monitorada: envio desabilitado, sem Assumir');
  await av(`document.querySelector('.cv-b-retomar').click()`);
  conferir(!!(await esperar(`window.__req.some((r) => r.startsWith('POST /codex/sessao/${COD[1]}/retomar'))`, 4000)), 'monitorada: clicar faz POST /codex/sessao/:id/retomar');
  conferir(!!(await esperar(`OrbitFonteSessoes.obter('${COD[1]}') && document.querySelector('.cv-texto').placeholder.includes('Mensagem para o Codex')`, 8000)), 'monitorada: depois de assumida, o composer pede "Mensagem para o Codex…"');
  await av(`(() => { const t = document.querySelector('.cv-texto'); t.value = 'Continue daqui'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  conferir(!!(await esperar(`document.querySelector('.cv-enviar').getAttribute('aria-disabled') === 'false'`, 4000)), 'monitorada assumida: envio habilitado');
  conferir(await av(`document.querySelector('.cv-b-retomar').hidden`), 'monitorada assumida: o "Continuar no Orbit" some');

  // ── (d) sessão do Claude: composer de sempre ──
  await av(`window.__req.length = 0`);
  await av(`window.OrbitFonteSessoes.abrir('${CLAUDE}')`);
  await esperar(`document.querySelector('.cv-itens') && document.querySelector('.cv-b-compactar')`, 8000);
  await dormir(500);
  const cl = await av(`(() => { const q = (s) => document.querySelector(s); return { retomar: q('.cv-b-retomar')?.hidden, compactar: q('.cv-b-compactar')?.hidden, limpar: q('.cv-b-limpar')?.hidden, ax: !!q('.cv .ax-botao') && !q('.cv .ax-botao').hidden, selo: document.querySelectorAll('.cv .cdx-selo').length, ph: q('.cv-texto').placeholder }; })()`);
  conferir(cl.retomar === true && cl.compactar === false && cl.limpar === false && cl.ax && cl.selo === 0, 'Claude: Retomar escondido, Compactar/Limpar e imagens como sempre, sem selo', cl);
  conferir(!/Codex/.test(cl.ph), 'Claude: placeholder sem Codex', cl.ph);
  const req3 = await av(`window.__req`);
  conferir(!req3.some((r) => r.includes('/codex/')), 'Claude: nenhuma chamada /codex/', req3);

  // ── (e) criar o Codex com modelo e esforço escolhidos ──
  await av(`window.__req.length = 0`);
  await av(`document.getElementById('btn-nova').click()`);
  await esperar(`!!document.querySelector('#ni-pop:not([hidden]) #ni-rot-prov')`, 8000);
  await av(`document.querySelector('.ni-prov [data-v="codex"]').click()`);
  conferir(await esperar(`document.getElementById('ni-modelo').options.length === 3 && document.getElementById('ni-modelo').value === ''`, 6000), 'novo popover: o Codex começa no padrão (lista já carregada)');
  await av(`(() => { const s = document.getElementById('ni-pasta'); s.value = '\\u0000outra'; s.dispatchEvent(new Event('change', { bubbles: true }));
    const o = document.getElementById('ni-outra'); o.value = ${JSON.stringify(PASTA_NOVA + '2')}; o.dispatchEvent(new Event('input', { bubbles: true }));
    const m = document.getElementById('ni-modelo'); m.value = 'gpt-5.4'; m.dispatchEvent(new Event('change', { bubbles: true }));
    const e = document.getElementById('ni-esforco'); e.value = 'high'; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await av(`document.querySelector('.ni-criar').click()`);
  conferir(await esperar(`document.getElementById('ni-pop').hidden`, 8000), 'criar com escolha: o popover fecha');
  const req5 = await av(`window.__req`);
  const p5 = req5.find((r) => r.startsWith('POST /codex/instancias')) || '';
  conferir(/"modelo":"gpt-5\.4"/.test(p5) && /"esforco":"high"/.test(p5) && !/permissao/.test(p5), 'criar com escolha: POST /codex/instancias leva modelo e esforço', req5);
  const criadas = await (await fetch(BASE + '/_mock/codex-criadas')).json();
  conferir(criadas[0] && criadas[0].modelo === 'gpt-5.4' && criadas[0].esforco === 'high', 'o servidor recebeu modelo=gpt-5.4 e esforco=high', criadas);
  conferir(criadas[1] && criadas[1].modelo === null && criadas[1].esforco === null, 'a criação sem escolha não mandou modelo nem esforço', criadas);

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
