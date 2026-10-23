// Etapa 5 (Codex): marca neutra provisória "Codex" nos robôs da Visão de Office.
// node testes/codex-office.test.mjs [pasta-de-saida]
// Sem servidor do Orbit: um servidor estático mínimo (porta por escolherPorta) serve a pasta do projeto e uma
// página gerada aqui (/__codex-office.html) com uma API falsa de sessões. Edge headless + CDP. Confere:
//  1) time misto (mestre Claude + subagente Claude + dependente Codex): só o robô e o crachá do Codex têm data-prov;
//  2) time com mestre Codex e subagente da mãe: mestre e subagente herdam, o dependente Claude não;
//  3) time só de Claude: nenhum data-prov em lugar nenhum (robôs, crachás, TV, cartão sem "Codex");
//  4) o cartão e a linha da TV mostram a marca só no Codex; a marca some/aparece quando o provedor muda.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'orbit-codex-office'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const conferir = (ok, msg) => { console.log((ok ? 'ok   ' : 'FALHA ') + msg); if (!ok) falhas.push(msg); };
const consoleErros = [];

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Office · Codex</title>
<link rel="icon" href="data:,">
<style>html,body{height:100%;margin:0;background:#0a0a0a}#office{width:100vw;height:100vh}</style></head><body><section id="office"></section>
<script>
(function () {
  const T0 = Date.now(), cen = new URLSearchParams(location.search).get('c') || 'claude';
  const ouv = {}, mapa = new Map(), copia = (o) => JSON.parse(JSON.stringify(o));
  const sess = (o) => Object.assign({ id: '', status: 'trabalhando', desde: T0, titulo: '', apelido: '', projeto: 'Orbit', cwd: 'D:\\\\x', tarefa: '', primeira: '',
    detalhe: '', ferramenta: null, agentes: [], subagentes: 0, pai: null, vivo: true, atividade: T0, nome: '' }, o);
  const ag = (id, desc) => ({ id, tipo: 'general-purpose', descricao: desc, status: 'trabalhando', inicio: T0, fim: null, ferramenta: null, ferramentas: 0, atividade: T0 });
  const cod = cen === 'misto' || cen === 'codexmae';
  if (cen === 'misto') {
    mapa.set('m1', sess({ id: 'm1', nome: 'mestre-claude', titulo: 'Mestre Claude', agentes: [ag('a1', 'Frontend: ajustar o layout da tela')] }));
    mapa.set('d1', sess({ id: 'd1', pai: 'm1', provedor: 'codex', nome: 'membro-x', titulo: 'Membro X', primeira: 'Rode a fumaca e verifique os testes' }));
  } else if (cen === 'codexmae') {
    mapa.set('m1', sess({ id: 'm1', provedor: 'codex', nome: 'mae-x', titulo: 'Mae X', agentes: [ag('a1', 'Backend: rota do servidor')] }));
    mapa.set('d1', sess({ id: 'd1', pai: 'm1', nome: 'dep-claude', titulo: 'Dep Claude', primeira: 'Rode a fumaca e verifique os testes' }));
  } else {
    mapa.set('m1', sess({ id: 'm1', nome: 'mestre-claude', titulo: 'Mestre Claude', agentes: [ag('a1', 'Frontend: ajustar o layout da tela')] }));
    mapa.set('d1', sess({ id: 'd1', pai: 'm1', nome: 'dep-claude', titulo: 'Dep Claude', primeira: 'Rode a fumaca e verifique os testes' }));
  }
  window.__alterar = (id, campos) => { const s = mapa.get(id); for (const k in campos) { if (campos[k] === null) delete s[k]; else s[k] = campos[k]; } s.atividade = Date.now(); (ouv.sessao || []).forEach((f) => f(copia(s))); };
  window.GerenciadorAPI = {
    sessoes: () => [...mapa.values()].map(copia), sessao: (id) => (mapa.has(id) ? copia(mapa.get(id)) : null),
    eventos: async (id) => ({ sessao: mapa.get(id) || null, eventos: [] }), uso: () => null, config: () => ({}),
    on: (t, fn) => { (ouv[t] = ouv[t] || []).push(fn); return () => {}; }, selecionada: () => null,
  };
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/assets/office.css'; document.head.appendChild(css);
  const js = document.createElement('script'); js.src = '/assets/office.js';
  js.onload = () => { const m = () => window.Office.montar(document.getElementById('office'), window.GerenciadorAPI); css.sheet ? m() : css.addEventListener('load', m); };
  document.head.appendChild(js);
})();
</script></body></html>`;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__codex-office.html') { res.writeHead(200, { 'content-type': TIPOS['.html'] }); res.end(PAGINA); return; }
  const arq = path.normalize(path.join(PASTA, decodeURIComponent(u.pathname)));
  if (!arq.startsWith(PASTA) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(arq).pipe(res);
});

let edge = null, dbg = 0, perfil = '', ws, seq = 0;
const pend = new Map();
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};

// Lê o que importa do DOM: por robô (nome no balão em pixel art, que substituiu o crachá) → data-prov do botão e do balão.
const LER = `(() => {
  const bs = [...document.querySelectorAll('.of-ator')], cs = [...document.querySelectorAll('.of-balao')];
  return {
    nBotoes: bs.length, nCrachas: cs.length,
    botoesProv: bs.filter((b) => b.hasAttribute('data-prov')).length,
    crachas: cs.map((c) => { const t = c.querySelector('.of-sr').textContent.split('. ')[0]; return { nome: t.replace(/ · Codex$/, ''), prov: c.getAttribute('data-prov'), marca: / · Codex$/.test(t) ? 'Codex' : 'none' }; }),
    botoes: bs.map((b) => ({ rotulo: b.getAttribute('aria-label'), prov: b.getAttribute('data-prov') })),
    qualquer: document.querySelectorAll('#office [data-prov]').length,
  };
})()`;

async function abrir(cen) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORTA}/__codex-office.html?c=${cen}` });
  for (let i = 0; i < 60; i++) { if (await avaliar('!!(window.Office && document.querySelectorAll(".of-ator").length >= 3)').catch(() => false)) break; await dormir(150); }
  await dormir(1200);
}
const porNome = (lido, nome) => lido.crachas.find((c) => c.nome === nome);
// Abre o cartão do robô (clique no botão por índice) e devolve o texto dele.
const cartaoDe = (i) => avaliar(`(() => { document.querySelectorAll('.of-ator')[${i}].click(); const c = document.querySelector('.of-cartao'); return c.textContent; })()`);
// Abre a TV e devolve as linhas (nome, data-prov, marca).
const linhasTV = () => avaliar(`(async () => {
  if (!document.querySelector('.of-tv-pop:not([hidden])')) document.querySelector('.of-tv').click();
  await new Promise((r) => setTimeout(r, 700));
  return [...document.querySelectorAll('.of-tp-ag')].map((l) => ({ nome: l.querySelector('.of-tp-nome').textContent, prov: l.getAttribute('data-prov'),
    marca: getComputedStyle(l.querySelector('.of-tp-nome'), '::after').content }));
})()`);

let PORTA = 0;
try {
  PORTA = await escolherPorta(Number(process.env.OFFICE_PORTA) || 47826);
  await new Promise((r, j) => servidor.listen(PORTA, '127.0.0.1', r).on('error', j));
  dbg = 9800 + Math.floor(Math.random() * 150);
  perfil = path.join(SAIDA, 'edge-codex-office-' + dbg);
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${perfil}`, '--no-first-run',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 80 && !alvo; i++) {
    try { alvo = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!alvo) await dormir(200);
  }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert')) consoleErros.push('console: ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');

  // ── 1) time misto: mestre Claude + subagente Claude + dependente Codex ──
  await abrir('misto');
  let L = await avaliar(LER);
  conferir(L.nBotoes === 3 && L.nCrachas === 3, `misto: 3 robôs e 3 crachás (viu ${L.nBotoes}/${L.nCrachas})`);
  const tester = porNome(L, 'Tester');
  conferir(tester?.prov === 'codex', 'misto: crachá do dependente Codex tem data-prov="codex"');
  conferir(L.botoes.filter((b) => b.prov === 'codex').length === 1 && /Tester/.test(L.botoes.find((b) => b.prov === 'codex')?.rotulo || ''), 'misto: botão do robô do Codex tem data-prov="codex" (e só ele)');
  conferir(L.crachas.filter((c) => c.prov).length === 1 && L.botoesProv === 1, 'misto: Mestre e Frontend (Claude) sem data-prov');
  conferir(/Codex/i.test(tester?.marca || ''), `misto: marca "Codex" aparece no crachá (::after = ${tester?.marca})`);
  conferir(L.crachas.filter((c) => c.nome !== 'Tester').every((c) => c.marca === 'none' || c.marca === 'normal' || c.marca === ''), 'misto: crachás do Claude sem marca');
  // Clip pequeno do robô do Codex.
  const clip = await avaliar(`(() => { const r = document.querySelector('.of-ator[data-prov]').getBoundingClientRect(); return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 60), width: r.width + 40, height: r.height + 80, scale: 3 }; })()`);
  const foto = await cdp('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(path.join(SAIDA, 'codex-office-cracha.png'), Buffer.from(foto.result.data, 'base64'));
  // Cartão: o do Codex mostra a marca, os do Claude não.
  const iCodex = L.botoes.findIndex((b) => b.prov === 'codex'), iClaude = L.botoes.findIndex((b) => !b.prov);
  const cCodex = await cartaoDe(iCodex);
  conferir(/Codex/.test(cCodex), 'misto: cartão do robô Codex mostra "Codex"');
  const cClaude = await cartaoDe(iClaude);
  conferir(!/Codex/.test(cClaude), 'misto: cartão do robô Claude não menciona Codex');
  // TV: linha do Codex com data-prov, a do Claude sem.
  const tv = await linhasTV();
  conferir(tv.length === 2 && tv.filter((l) => l.prov === 'codex').length === 1 && tv.find((l) => l.prov === 'codex')?.nome === 'Tester', `misto: TV marca só a linha do Codex (${JSON.stringify(tv.map((l) => [l.nome, l.prov]))})`);
  conferir(/Codex/i.test(tv.find((l) => l.prov)?.marca || ''), 'misto: linha da TV exibe a marca');
  await avaliar(`document.querySelector('.of-tv').click()`);
  // Atualização ao vivo: o Claude mestre vira Codex e o dependente deixa de ser.
  await avaliar(`__alterar('d1', { provedor: null }); __alterar('m1', { provedor: 'codex' })`);
  await dormir(1500);
  L = await avaliar(LER);
  conferir(porNome(L, 'Mestre')?.prov === 'codex' && !porNome(L, 'Tester')?.prov && L.botoesProv === 2 && porNome(L, 'Frontend')?.prov === 'codex',
    `ao vivo: provedor mudou na sessão → atributos acompanham (${JSON.stringify(L.crachas.map((c) => [c.nome, c.prov]))})`);

  // ── 2) mestre Codex com subagente da mãe; dependente Claude ──
  await abrir('codexmae');
  L = await avaliar(LER);
  conferir(L.nBotoes === 3, `mãe Codex: 3 robôs (viu ${L.nBotoes})`);
  conferir(porNome(L, 'Mestre')?.prov === 'codex' && porNome(L, 'Backend')?.prov === 'codex', 'mãe Codex: mestre e subagente herdam data-prov="codex" no crachá');
  conferir(!porNome(L, 'Tester')?.prov, 'mãe Codex: dependente Claude sem data-prov');
  conferir(L.botoes.filter((b) => b.prov === 'codex').length === 2, 'mãe Codex: dois botões de robô com data-prov');

  // ── 3) só Claude: DOM do Office idêntico (nenhum atributo novo) ──
  await abrir('claude');
  L = await avaliar(LER);
  conferir(L.nBotoes === 3 && L.qualquer === 0, `só Claude: nenhum data-prov no Office (achou ${L.qualquer})`);
  const tv2 = await linhasTV();
  conferir(tv2.length === 2 && tv2.every((l) => l.prov === null), 'só Claude: TV sem data-prov');
  const cc = await cartaoDe(0);
  conferir(!/Codex/.test(cc), 'só Claude: cartão sem "Codex"');
  L = await avaliar(LER);
  conferir(L.qualquer === 0 || (await avaliar(`document.querySelectorAll('#office [data-prov]').length`)) === 0, 'só Claude: continua sem data-prov depois de abrir cartão e TV');

  conferir(consoleErros.length === 0, 'sem erros de console' + (consoleErros.length ? ': ' + consoleErros.slice(0, 3).join(' | ') : ''));
} catch (e) {
  falhas.push('exceção: ' + (e.stack || e));
  console.log('FALHA exceção: ' + (e.stack || e));
} finally {
  try { ws?.close(); } catch {}
  if (dbg) await fecharEdge(dbg, perfil);
  try { edge?.kill(); } catch {}
  servidor.close();
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
}
console.log(`\n${falhas.length ? 'FALHOU' : 'ok'}: ${falhas.length} falha(s). Saída: ${SAIDA}`);
process.exit(falhas.length ? 1 : 0);
