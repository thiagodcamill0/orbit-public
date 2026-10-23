// Codex, etapa 5 (front): "Novo membro Codex" no menu da linha de uma sessão do Claude -> popover Nova instância já com Codex,
// a pasta da sessão e `pai`; envio com pai/avisarLider; o membro aparece aninhado sob a mãe; sem a chave, nada disso existe.
// Mock (testes/mock-servidor.mjs, MOCK_CODEX=1, ROTEIRO=0) numa porta livre de 47822–47826 + Edge headless mudo; nunca toca a 47821.
//   node testes/codex-membro-ui.test.mjs <pasta-de-saida>   (~30 s; uma captura; sem argumento, tudo é apagado no fim)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PEDIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
const SAIDA = PEDIDA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-membro-'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47826); // o mock recusa a 47822
if (PORTA === 47822) throw new Error('só a 47822 está livre e o mock a recusa: espere os outros testes');
const BASE = `http://127.0.0.1:${PORTA}`;
const PERFIL = path.join(SAIDA, 'edge-codex-membro');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const COD = ['c0de0001-0000-4000-8000-000000000001', 'c0de0002-0000-4000-8000-000000000002'];
const CLAUDE = '3f2a9c1e-7b44-4d0a-9e15-2c8d6a0b1f01';
const ITEM = 'Novo membro Codex';

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
  const mouse = async (x, y, button = 'left') => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    await dormir(300);
  };
  // Botão direito na linha da sessão -> rótulos dos itens do menu; null se o menu não abriu.
  const menuDe = async (id) => {
    await av(`document.getElementById('l-${id}').scrollIntoView({ block: 'center' })`);
    await dormir(150);
    const p = await av(`(() => { const r = document.getElementById('l-${id}').getBoundingClientRect(); return { x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 }; })()`);
    await mouse(p.x, p.y, 'right');
    if (!(await esperar(`!!document.querySelector('.menu-flut:not([hidden])')`, 2500))) { await mouse(p.x, p.y, 'right'); await esperar(`!!document.querySelector('.menu-flut:not([hidden])')`, 2500); } // a 1ª vez da página às vezes perde o clique
    return av(`(() => { const m = document.querySelector('.menu-flut'); return m && !m.hidden ? [...m.querySelectorAll('.menu-item .mi-rot')].map((x) => x.textContent) : null; })()`);
  };
  const fecharMenu = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await esperar(`!document.querySelector('.menu-flut') || document.querySelector('.menu-flut').hidden`, 2000);
  };
  const cliqueItem = async (rot) => {
    const p = await av(`(() => { const b = [...document.querySelectorAll('.menu-flut .menu-item')].find((x) => x.textContent.includes(${JSON.stringify(rot)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (p) await mouse(p.x, p.y);
    return !!p;
  };
  const chave = (ativo) => av(`fetch('/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ codex: { ativo: ${ativo}, exe: '' } }) }).then((r) => r.status)`);

  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__req = []; const f = window.fetch; window.fetch = function (u, o) { try { const s = String(u); if (/\\/codex\\//.test(s) || /\\/instancias/.test(s)) window.__req.push(((o && o.method) || 'GET') + ' ' + s + ((o && o.body && typeof o.body === 'string') ? ' ' + o.body : '')); } catch {} return f.apply(this, arguments); };` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`document.querySelectorAll('#lista .linha:not(.filho)').length >= 8 && !!document.getElementById('btn-nova') && !!document.getElementById('l-${CLAUDE}')`, 15000); await dormir(600);
  const mae = ((await (await fetch(BASE + '/estado')).json()).sessoes || []).find((x) => x.id === CLAUDE) || {};
  const cwd = mae.cwd || '';
  const nomeMae = await av(`document.getElementById('l-${CLAUDE}').querySelector('.tit')?.textContent.trim() || ''`);
  conferir(!!cwd && !!nomeMae, 'a sessão do Claude do mock tem cwd e nome', { cwd, nomeMae });

  // ── (a) sem a chave: o item não existe ──
  const m0 = await menuDe(CLAUDE);
  conferir(!!m0 && m0.includes('Renomear') && !m0.includes(ITEM), 'sem a chave: menu da sessão do Claude não tem "Novo membro Codex"', m0);
  await fecharMenu();

  // ── (b) com a chave ──
  await chave(true);
  await dormir(900);
  const m1 = await menuDe(CLAUDE);
  conferir(!!m1 && m1.includes(ITEM), 'com a chave: sessão do Claude tem "Novo membro Codex"', m1);
  await fecharMenu();
  const m2 = await menuDe(COD[0]);
  conferir(!!m2 && m2.includes('Renomear') && !m2.includes(ITEM), 'com a chave: sessão Codex não tem o item (Codex nunca é líder)', m2);
  await fecharMenu();

  // ── (c) abrir o popover pelo item ──
  const m3 = await menuDe(CLAUDE);
  conferir(!!m3 && await cliqueItem(ITEM), 'clicar no item do menu');
  conferir(!!(await esperar(`!!document.querySelector('#ni-pop:not([hidden]) .ni-membro')`, 8000)), 'popover Nova instância abre com a linha de membro');
  const pop = await av(`(() => { const e = document.getElementById('ni-pop'); const q = (s) => e.querySelector(s); const vis = (s) => { const x = q(s); return !!x && getComputedStyle(x).display !== 'none' && !x.hidden; };
    return { prov: e.dataset.prov, de: q('.ni-membro-de').textContent, pasta: q('#ni-pasta').value, avisar: q('#ni-avisar').checked, rotAvisar: q('.ni-membro-avisar').textContent.trim(),
      seletor: vis('#ni-rot-prov'), seletor2: vis('.ni-prov'), perm: vis('#ni-rot-perm'), sub: q('.ni-cab-txt small').textContent }; })()`);
  conferir(pop.prov === 'codex' && pop.sub === 'Codex no Orbit', 'popover: Codex já escolhido', pop);
  conferir(/^Membro de:/.test(pop.de) && pop.de.includes(nomeMae), 'popover: linha discreta "Membro de: <nome da sessão>"', { pop, nomeMae });
  conferir(pop.pasta === cwd, 'popover: pasta = cwd da sessão', { pasta: pop.pasta, cwd });
  conferir(pop.rotAvisar === 'Avisar o líder ao concluir' && pop.avisar === false, 'popover: opção "Avisar o líder ao concluir" desmarcada por padrão', pop);
  conferir(!pop.seletor && !pop.seletor2 && !pop.perm, 'popover: sem seletor Claude|Codex nem permissão', pop);

  // ── (d) envio com pai e avisarLider ──
  await av(`(() => { document.getElementById('ni-avisar').click(); const t = document.getElementById('ni-texto'); t.value = 'Revise o módulo de login'; t.dispatchEvent(new Event('input', { bubbles: true })); const n = document.getElementById('ni-nome'); n.value = 'Revisora'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  conferir(await av(`document.getElementById('ni-avisar').checked`), 'marcar "Avisar o líder"');
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.ni-criar').click()`);
  conferir(await esperar(`document.getElementById('ni-pop').hidden`, 8000), 'criar: o popover fecha');
  const req = await av(`window.__req`);
  const post = req.find((r) => r.startsWith('POST /codex/instancias')) || '';
  conferir(post.includes(`"pai":"${CLAUDE}"`) && post.includes('"avisarLider":true') && post.includes('Revise o módulo de login') && !post.includes('permissao'), 'envio: POST /codex/instancias leva pai e avisarLider=true', req);
  conferir(!req.some((r) => r.startsWith('POST /instancias')), 'envio: nada foi para o POST /instancias do Claude', req);
  const criadas = await (await fetch(BASE + '/_mock/codex-criadas')).json();
  conferir(criadas[0] && criadas[0].pai === CLAUDE && criadas[0].avisarLider === true && criadas[0].pasta === cwd, 'o servidor recebeu pai, avisarLider e a pasta da sessão', criadas[0]);

  // ── (e) membro aninhado sob a mãe ──
  const idNovo = await esperar(`(window.OrbitFonteSessoes.lista().find((r) => r.provedor === 'codex' && r.pai === '${CLAUDE}') || {}).id`, 8000);
  conferir(!!idNovo, 'a sessão Codex nova chega com pai = a sessão do Claude', idNovo);
  const aninhado = await esperar(`(() => { const l = document.getElementById('l-${idNovo}'); if (!l || !l.classList.contains('filho')) return null; let p = l.previousElementSibling; while (p && p.classList.contains('filho')) p = p.previousElementSibling; return p && p.dataset.id === '${CLAUDE}' ? true : null; })()`, 8000);
  conferir(!!aninhado, 'lista: o membro Codex aparece como filho logo abaixo da mãe', aninhado);
  const seloHtml = await av(`(() => { const l = document.getElementById('l-${idNovo}'); return l.querySelector('.cdx-selo') ? 'ok' : l.outerHTML.slice(0, 900); })()`);
  conferir(seloHtml === 'ok', 'lista: o membro leva o selo Codex', seloHtml);
  await dormir(500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SAIDA, 'codex-membro.png'), Buffer.from(shot.result.data, 'base64'));

  // ── (f) segundo membro sem aviso; depois o popover normal volta ao Claude ──
  const m4 = await menuDe(CLAUDE);
  conferir(!!m4 && await cliqueItem(ITEM), 'segundo membro: clicar no item');
  await esperar(`!!document.querySelector('#ni-pop:not([hidden]) .ni-membro')`, 8000);
  conferir(await av(`document.getElementById('ni-avisar').checked === false`), 'segundo membro: o aviso volta desmarcado');
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.ni-criar').click()`);
  conferir(await esperar(`document.getElementById('ni-pop').hidden`, 8000), 'segundo membro: criar fecha o popover');
  const req2 = await av(`window.__req`);
  const post2 = req2.find((r) => r.startsWith('POST /codex/instancias')) || '';
  conferir(post2.includes(`"pai":"${CLAUDE}"`) && post2.includes('"avisarLider":false'), 'segundo membro: pai e avisarLider=false', req2);
  await av(`document.getElementById('btn-nova').click()`);
  await esperar(`!!document.querySelector('#ni-pop:not([hidden]) #ni-pasta')`, 8000);
  const normal = await av(`(() => { const e = document.getElementById('ni-pop'); const x = document.getElementById('ni-rot-prov'); return { membro: !!e.querySelector('.ni-membro'), prov: e.dataset.prov || '', seletor: !!x && getComputedStyle(x).display !== 'none', claude: e.querySelector('.ni-prov [data-v="claude"]')?.getAttribute('aria-checked') }; })()`);
  conferir(!normal.membro && normal.prov === '' && normal.seletor && normal.claude === 'true', 'popover normal depois do membro: sem linha de membro, seletor de volta e Claude escolhido', normal);
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.ni-criar').click()`);
  await esperar(`document.getElementById('ni-pop').hidden`, 8000);
  const req3 = await av(`window.__req`);
  conferir(req3.some((r) => r.startsWith('POST /instancias')) && !req3.some((r) => r.includes('"pai"')), 'popover normal: POST /instancias do Claude, sem pai', req3);

  // ── (g) chave desligada de novo: nada sobra ──
  await chave(false);
  await dormir(900);
  const m5 = await menuDe(CLAUDE);
  conferir(!!m5 && !m5.includes(ITEM), 'chave desligada: o item some do menu', m5);
  await fecharMenu();
  await av(`document.getElementById('btn-nova').click()`);
  await esperar(`!!document.querySelector('#ni-pop:not([hidden]) #ni-pasta')`, 8000);
  conferir(await av(`!document.querySelector('#ni-pop .ni-membro') && !document.getElementById('ni-rot-prov') && !document.getElementById('ni-avisar')`), 'chave desligada: nada de membro nem seletor no popover');

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
