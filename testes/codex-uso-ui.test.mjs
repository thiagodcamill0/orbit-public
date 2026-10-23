// Codex, etapa 4 (front): uso do plano do Codex na Home (só com a chave, atualizado pelo SSE usoCodex), troca de modelo/esforço e
// Compactar na conversa de uma instância Codex (rotas /codex/sessao/:id/...), e "Copiar resume" (codex resume x claude --resume).
// Mock (testes/mock-servidor.mjs, MOCK_CODEX=1, ROTEIRO=0) numa porta livre de 47823–47826 + Edge headless mudo; nunca toca a 47821.
//   node testes/codex-uso-ui.test.mjs <pasta-de-saida>   (~30 s; uma captura do cartão de uso; sem argumento, tudo é apagado no fim)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PEDIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
const SAIDA = PEDIDA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-usoui-'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47826); // o mock recusa a 47822
if (PORTA === 47822) throw new Error('só a 47822 está livre e o mock a recusa: espere os outros testes');
const BASE = `http://127.0.0.1:${PORTA}`;
const PERFIL = path.join(SAIDA, 'edge-codex-uso');
fs.rmSync(PERFIL, { recursive: true, force: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };
const COD = 'c0de0001-0000-4000-8000-000000000001';
const CLAUDE = '3f2a9c1e-7b44-4d0a-9e15-2c8d6a0b1f01';

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
  const mockGet = async (rota) => (await fetch(BASE + rota)).json();
  const mockPost = async (rota, corpo) => (await fetch(BASE + rota, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo) })).json();

  await cdp('Page.enable'); await cdp('Runtime.enable');
  // Registra toda chamada /codex/ do front (método + caminho) e troca o clipboard por um que só anota.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__req = []; window.__copiado = []; const f = window.fetch; window.fetch = function (u, o) { try { const s = String(u); if (/\\/codex\\//.test(s)) window.__req.push(((o && o.method) || 'GET') + ' ' + s); } catch {} return f.apply(this, arguments); };
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copiado.push(t); return Promise.resolve(); } }, configurable: true }); } catch {}` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`document.querySelectorAll('#lista .linha:not(.filho)').length >= 8 && !!document.getElementById('gu-barras')`, 15000); await dormir(800);

  // ── (a) sem a chave: nada do Codex no uso ──
  conferir(await av(`!document.querySelector('.cdx-uso') && !window.CodexUso && !document.querySelector('script[src*="codex-uso"]')`), 'sem a chave: nenhum bloco .cdx-uso, nenhum codex-uso.js carregado');
  conferir(await av(`!window.__req.some((r) => /\\/codex\\/(uso|modelos|estado)/.test(r))`), 'sem a chave: nenhum GET /codex/uso, /codex/modelos nem /codex/estado', await av(`window.__req`));
  conferir(await av(`document.querySelectorAll('.graf-uso .gu-linha').length === 2`), 'sem a chave: o uso do Claude tem as suas 2 linhas, como sempre');

  // ── (b) liga a chave: bloco do Codex abaixo do Claude ──
  await av(`fetch('/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ codex: { ativo: true, exe: '' } }) }).then((r) => r.status)`);
  conferir(!!(await esperar(`document.querySelectorAll('.graf-uso .cdx-uso .gu-linha').length === 2`, 8000)), 'com a chave: bloco do Codex com as 2 janelas (sessão 5 h e semana)', await av(`document.querySelector('.graf-uso')?.innerText`));
  const b1 = await av(`(() => { const q = (s) => document.querySelector(s); const l = [...document.querySelectorAll('.cdx-uso .gu-linha')].map((e) => ({ nome: e.querySelector('.gu-nome').textContent, val: e.querySelector('.gu-val').textContent, ren: e.querySelector('.gu-ren').textContent, meter: e.querySelector('.gc-trilho').getAttribute('aria-valuenow') }));
    return { linhas: l, selo: q('.cdx-uso .cdx-selo')?.textContent, plano: q('.cdx-uso-plano')?.textContent, lido: q('.cdx-uso .gu-lido')?.textContent, dentro: !!q('.graf-uso > .cdx-uso'), depois: q('.graf-uso > .gu-pe')?.nextElementSibling === q('.cdx-uso'), claude: document.querySelectorAll('#gu-barras .gu-linha').length, svg: !!q('.cdx-uso .gu-logo'), filhos: [...q('.graf-uso').children].map((e) => e.className) }; })()`);
  conferir(b1.linhas.length === 2 && /^Sessão/.test(b1.linhas[0].nome) && b1.linhas[0].val === '31%' && b1.linhas[0].meter === '31' && /^Semana/.test(b1.linhas[1].nome) && b1.linhas[1].val === '12%', 'bloco: sessão 31% e semana 12% (valor e meter)', b1.linhas);
  conferir(b1.linhas.every((x) => /^renova em /.test(x.ren)), 'bloco: "renova em …" nas duas janelas', b1.linhas);
  conferir(b1.selo === 'Codex' && b1.plano === 'Plus' && b1.svg === false, 'bloco: selo neutro "Codex" e plano "Plus", sem logo/marca própria', b1);
  conferir(b1.dentro && b1.depois && b1.claude === 2 && /Lido há/.test(b1.lido), 'bloco: no cartão do uso, depois do rodapé do Claude, que segue com as suas 2 linhas; "Lido há …"', b1);
  conferir(await av(`window.__req.filter((r) => r === 'GET /codex/uso').length >= 1`), 'com a chave: lê GET /codex/uso');

  // ── (c) SSE usoCodex atualiza o bloco ──
  await mockPost('/_mock/codex-uso', { cincoHoras: { pct: 64, renova: Date.now() + 90 * 60e3 }, semanal: { pct: 88, renova: Date.now() + 2 * 86400e3 }, plano: 'pro' });
  conferir(!!(await esperar(`(() => { const v = [...document.querySelectorAll('.cdx-uso .gu-val')].map((e) => e.textContent); return v[0] === '64%' && v[1] === '88%'; })()`, 5000)), 'SSE usoCodex: o bloco passa a 64% e 88%', await av(`document.querySelector('.cdx-uso').innerText`));
  conferir(await av(`document.querySelector('.cdx-uso-plano').textContent === 'Pro' && /Lido agora/.test(document.querySelector('.cdx-uso .gu-lido').textContent) && document.querySelectorAll('.cdx-uso .gu-linha.perto').length === 1`), 'SSE usoCodex: plano "Pro", "Lido agora" e só a semana (88%) marcada como perto do limite');
  // botão de atualizar: POST /codex/uso/atualizar
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.cdx-uso .gu-atualizar').click()`);
  conferir(!!(await esperar(`window.__req.includes('POST /codex/uso/atualizar')`, 4000)), 'botão atualizar: POST /codex/uso/atualizar');
  conferir(!!(await esperar(`document.querySelector('.cdx-uso .gu-val').textContent === '74%'`, 5000)), 'botão atualizar: o bloco mostra a resposta (74%)', await av(`document.querySelector('.cdx-uso').innerText`));
  // captura pequena do cartão
  const rc = await av(`(() => { document.getElementById('abertura')?.remove(); document.querySelector('.graf-uso').scrollIntoView({ block: 'center' }); const b = document.querySelector('.graf-uso').getBoundingClientRect(); return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.width, 700), h: Math.min(b.height, 520) }; })()`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: rc.x, y: rc.y, width: rc.w, height: rc.h, scale: 1 } });
  fs.writeFileSync(path.join(SAIDA, 'codex-uso.png'), Buffer.from(shot.result.data, 'base64'));

  // ── (d) desliga a chave: o bloco sai e o SSE não o recria ──
  await av(`fetch('/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ codex: { ativo: false, exe: '' } }) }).then((r) => r.status)`);
  conferir(!!(await esperar(`!document.querySelector('.cdx-uso')`, 5000)), 'chave desligada: o bloco sai do DOM');
  await mockPost('/_mock/codex-uso', { cincoHoras: { pct: 5, renova: Date.now() + 3600e3 } });
  await dormir(600);
  conferir(await av(`!document.querySelector('.cdx-uso') && document.querySelectorAll('.graf-uso .gu-linha').length === 2`), 'chave desligada: um usoCodex não recria o bloco; o uso do Claude segue igual');
  await av(`fetch('/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ codex: { ativo: true, exe: '' } }) }).then((r) => r.status)`);
  conferir(!!(await esperar(`document.querySelectorAll('.cdx-uso .gu-linha').length === 2 && document.querySelector('.cdx-uso .gu-val').textContent === '5%'`, 6000)), 'chave religada: o bloco volta e relê o uso (5%)', await av(`document.querySelector('.graf-uso')?.innerText`));

  // ── (e) conversa de uma instância Codex: modelo, esforço e Compactar ──
  const criou = await av(`fetch('/codex/instancias', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify({ pasta: 'D:\\\\Projetos\\\\codex-demo-uso' }) }).then((r) => r.json())`);
  const id = criou && criou.sessao && criou.sessao.id;
  conferir(!!id, 'instância Codex criada pelo mock', criou);
  await av(`window.OrbitFonteSessoes.abrir('${id}')`);
  conferir(!!(await esperar(`(() => { const b = document.querySelector('.cv-sel-modelo'); return !!b && !b.closest('[hidden]') && !b.disabled && /GPT-5\\.5/.test(b.textContent); })()`, 10000)), 'conversa Codex: seletor de modelo/esforço visível com o modelo padrão (GPT-5.5)', await av(`document.querySelector('.cv-sel-modelo')?.outerHTML.slice(0, 300)`));
  conferir(await av(`!!document.querySelector('.cv-sel-modo')?.closest('[hidden]')`), 'conversa Codex: o seletor de modo de permissão do Claude fica escondido');
  await esperar(`document.querySelector('.cv-b-compactar') && !document.querySelector('.cv-b-compactar').hidden && document.querySelector('.cv-b-compactar').getAttribute('aria-disabled') !== 'true'`, 8000);
  conferir(await av(`!!document.querySelector('.cv-b-compactar') && !document.querySelector('.cv-b-compactar').hidden && !!document.querySelector('.cv-b-limpar')?.hidden`), 'conversa Codex (instância do Orbit): Compactar visível, Limpar escondido');

  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.cv-sel-modelo').click()`);
  conferir(!!(await esperar(`!!document.querySelector('.cv-pop:not([hidden]) .cv-pop-i[data-valor="gpt-5.4"]')`, 4000)), 'popover: lista os modelos do Codex (GPT-5.5 e GPT-5.4)', await av(`document.querySelector('.cv-pop')?.innerText`));
  conferir(await av(`!document.querySelector('.cv-pop .cv-pop-mais') && /Vale no próximo turno/.test(document.querySelector('.cv-pop').textContent)`), 'popover: sem "Outras versões" e com a nota "Vale no próximo turno"');
  await av(`document.querySelector('.cv-pop-i[data-valor="gpt-5.4"]').click()`);
  conferir(!!(await esperar(`window.__req.some((r) => r === 'POST /codex/sessao/${id}/modelo')`, 4000)), 'trocar modelo: POST /codex/sessao/:id/modelo');
  conferir(!!(await esperar(`/próximo turno/i.test(document.querySelector('.cv-aj-aviso')?.textContent || '') && /GPT-5\\.4|gpt-5\\.4/.test(document.querySelector('.cv-aj-aviso')?.textContent || '')`, 5000)), 'trocar modelo: mostra o aviso "vale no próximo turno"', await av(`document.querySelector('.cv-aj-aviso')?.textContent`));
  conferir(!!(await esperar(`/GPT-5\\.4/.test(document.querySelector('.cv-sel-modelo').textContent)`, 4000)), 'trocar modelo: o botão passa a mostrar GPT-5.4', await av(`document.querySelector('.cv-sel-modelo').textContent`));
  await esperar(`!!document.querySelector('.cv-pop:not([hidden]) .cv-degrau[data-valor="high"]') || (document.querySelector('.cv-sel-modelo').click(), false)`, 4000);
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.cv-degrau[data-valor="high"]').click()`);
  conferir(!!(await esperar(`window.__req.some((r) => r === 'POST /codex/sessao/${id}/esforco')`, 4000)), 'trocar esforço: POST /codex/sessao/:id/esforco');
  conferir(!!(await esperar(`/Esforço/i.test(document.querySelector('.cv-aj-aviso')?.textContent || '') && /próximo turno/i.test(document.querySelector('.cv-aj-aviso')?.textContent || '')`, 5000)), 'trocar esforço: mostra o aviso "vale no próximo turno"', await av(`document.querySelector('.cv-aj-aviso')?.textContent`));
  const ch = await mockGet('/_mock/codex-chamadas');
  const cm = ch.find((c) => c.rota === 'modelo'), ce = ch.find((c) => c.rota === 'esforco');
  conferir(cm && cm.corpo.modelo === 'gpt-5.4' && ce && ce.corpo.esforco === 'high', 'servidor recebeu modelo=gpt-5.4 e esforço=high pelas rotas do Codex', ch.slice(0, 4));
  await av(`document.querySelector('.cv-pop:not([hidden])') && document.querySelector('.cv-sel-modelo').click()`);
  await dormir(300);

  // Compactar: balão de confirmação (sem campo de foco) e POST /codex/sessao/:id/compactar
  await av(`window.__req.length = 0`);
  await av(`document.querySelector('.cv-b-compactar').click()`);
  conferir(!!(await esperar(`!document.getElementById('balao').hidden`, 4000)), 'Compactar: abre o balão de confirmação');
  conferir(await av(`!document.querySelector('#balao input[type="text"], #balao textarea') || [...document.querySelectorAll('#balao input[type="text"], #balao textarea')].every((e) => e.closest('[hidden]') || getComputedStyle(e).display === 'none')`), 'Compactar do Codex: sem campo de foco (o Codex não aceita foco)');
  await av(`document.getElementById('balao-sim').click()`);
  conferir(!!(await esperar(`window.__req.some((r) => r === 'POST /codex/sessao/${id}/compactar')`, 4000)), 'Compactar: POST /codex/sessao/:id/compactar', await av(`window.__req`));
  conferir(await av(`!window.__req.some((r) => /\\/sessao\\/${id}\\/compactar/.test(r) && !r.includes('/codex/sessao/'))`), 'Compactar: nada foi para /sessao/:id/compactar do Claude');

  // ── (f) Copiar resume: codex resume x claude --resume ──
  await av(`window.__copiado.length = 0`);
  await av(`window.OrbitFonteSessoes.abrir('${COD}')`);
  await esperar(`!!document.getElementById('pk-copiar') && document.getElementById('pk-copiar').getBoundingClientRect().width > 0`, 6000);
  conferir(await av(`document.getElementById('pk-copiar').title === 'Copiar codex resume ${COD}'`), 'card do Codex: o botão "Copiar resume" anuncia codex resume <id>', await av(`document.getElementById('pk-copiar').title`));
  await av(`document.getElementById('pk-copiar').click()`);
  conferir(!!(await esperar(`window.__copiado.length === 1`, 3000)) && (await av(`window.__copiado[0]`)) === `codex resume ${COD}`, 'Copiar resume (Codex): copia "codex resume <id>"', await av(`window.__copiado`));
  await dormir(300);
  await av(`window.__copiado.length = 0`);
  await av(`window.OrbitFonteSessoes.abrir('${CLAUDE}')`);
  await esperar(`document.getElementById('pk-copiar') && document.getElementById('pk-copiar').title === 'Copiar claude --resume ${CLAUDE}'`, 6000);
  conferir(await av(`document.getElementById('pk-copiar').title === 'Copiar claude --resume ${CLAUDE}'`), 'card do Claude: o botão anuncia claude --resume <id>', await av(`document.getElementById('pk-copiar').title`));
  await av(`document.getElementById('pk-copiar').click()`);
  conferir(!!(await esperar(`window.__copiado.length === 1`, 3000)) && (await av(`window.__copiado[0]`)) === `claude --resume ${CLAUDE}`, 'Copiar resume (Claude): copia "claude --resume <id>"', await av(`window.__copiado`));

  conferir(!consoleErros.some((e) => !/favicon|\/modelos|Failed to load resource.*(404|503|409)/.test(e)), 'sem erros no console', consoleErros);
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
