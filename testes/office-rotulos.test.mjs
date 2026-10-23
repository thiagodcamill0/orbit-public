// Office: rótulos e balões da vila em pixel art (placas de madeira, ícones de estado, balão no hover/clique,
// fila de pedidos de permissão no canto e a tecla L).
// node testes/office-rotulos.test.mjs [pasta-de-saida]
// Servidor estático mínimo (porta por escolherPorta, padrão 47825) + página com API falsa de sessões (__alterar) e
// responderPermissao gravada em __resp. Edge headless + CDP. Confere:
//  1) placas: uma por lugar, só o nome; junto à porta, sem tocar em nenhuma casa; a função aparece no hover;
//  2) ícones: trabalhando …, concluído ✓, erro ✕, aguardando você ! (pulsando); sem etiqueta de nome embaixo;
//  3) nada (placa, ícone, balão) cobre fachada ou porta, e nenhum rótulo cobre outro, quadro a quadro;
//  4) balão: só no hover ou clique, com o nome dentro, largura limitada e texto cortado; dois abertos não se cobrem;
//  5) pedidos: "!" no agente e o detalhe na fila do canto, fora do mapa quando a margem cabe, com Permitir e Negar
//     (chamam a API com o id do pedido) e somem quando a sessão deixa de aguardar;
//  6) tecla L: some e volta tudo (a fila fica), e a escolha fica salva;
//  7) DPR 1,25: escala inteira de pixels do aparelho e posições em pixel inteiro (sem borrão); zero erros de console.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (SAIDA) fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const conferir = (ok, msg) => { console.log((ok ? 'ok   ' : 'FALHA ') + msg); if (!ok) falhas.push(msg); };
const consoleErros = [];

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Office · rótulos</title>
<link rel="icon" href="data:,">
<style>html,body{height:100%;margin:0;background:#0a0a0a}#office{width:100vw;height:100vh}</style></head><body><section id="office"></section>
<script>
(function () {
  const T0 = Date.now(), ouv = {}, mapa = new Map(), copia = (o) => JSON.parse(JSON.stringify(o));
  const sess = (o) => Object.assign({ id: '', status: 'trabalhando', desde: T0, titulo: '', apelido: '', projeto: 'Orbit', cwd: 'D:\\\\x', tarefa: '', primeira: '',
    detalhe: '', ferramenta: null, agentes: [], subagentes: 0, pai: null, vivo: true, atividade: T0, nome: '', controle: null }, o);
  mapa.set('m1', sess({ id: 'm1', nome: 'm-lider', titulo: 'Lider do time', status: 'trabalhando', ferramenta: { nome: 'Read', alvo: 'D:/x/plano.md' } }));
  const dep = (id, primeira, status) => mapa.set(id, sess({ id, pai: 'm1', nome: 'm-' + id, titulo: '', primeira, status: status || 'concluido' }));
  dep('d1', 'Rode a fumaca e verifique os testes');
  dep('d2', 'Pesquise referencias do pathfinding');
  dep('d3', 'Ajuste a rota do servidor', 'trabalhando');
  dep('d4', 'Ajuste o layout da pagina');
  const emitir = (s) => (ouv.sessao || []).forEach((f) => f(copia(s)));
  window.__alterar = (id, campos) => { const s = mapa.get(id); for (const k in campos) { if (campos[k] === null) delete s[k]; else s[k] = campos[k]; } s.atividade = Date.now(); emitir(s); };
  window.__resp = [];
  window.GerenciadorAPI = {
    sessoes: () => [...mapa.values()].map(copia), sessao: (id) => (mapa.has(id) ? copia(mapa.get(id)) : null),
    eventos: async (id) => ({ sessao: mapa.get(id) || null, eventos: [] }), uso: () => null, config: () => ({}),
    on: (t, fn) => { (ouv[t] = ouv[t] || []).push(fn); return () => {}; }, selecionada: () => null, abrirSessao: () => {},
    responderPermissao: async (id, corpo) => { window.__resp.push([id, corpo]); return {}; },
  };
  window.__robo = (nome) => Office._debug().robos.find((r) => r.nome === nome) || null;
  // Caixa de um agente na tela: o robô, ou o ícone de quem está dentro da casa.
  window.__alvo = (nome) => {
    const d = Office._debug(), i = d.robos.findIndex((r) => r.nome === nome);
    if (i < 0) return null;
    const r = d.robos[i], el = r.dentro ? document.querySelectorAll('.of-icone')[i] : document.querySelectorAll('.of-ator')[i];
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height * (r.dentro ? 0.5 : 0.55) };
  };
  // Amostra quadro a quadro: rótulo × casa (fachada) e rótulo × rótulo.
  window.__amostrar = (ms) => new Promise((ok) => {
    const res = { quadros: 0, sobreCasa: [], entreSi: [], tipos: {} };
    const inter = (p, q) => Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
    const fim = performance.now() + ms;
    const f = () => {
      const d = Office._debug();
      res.quadros++;
      for (const r of d.rotulos) {
        res.tipos[r.tipo] = (res.tipos[r.tipo] || 0) + 1;
        for (const c of d.casasPx) if (inter(r, c) > 1 && res.sobreCasa.length < 6) res.sobreCasa.push(r.tipo + ' ' + (r.id || '') + ' × ' + c.id);
      }
      for (let i = 0; i < d.rotulos.length; i++) for (let j = i + 1; j < d.rotulos.length; j++)
        if (inter(d.rotulos[i], d.rotulos[j]) > 1 && res.entreSi.length < 6) res.entreSi.push(d.rotulos[i].tipo + ' ' + (d.rotulos[i].id || '') + ' × ' + d.rotulos[j].tipo + ' ' + (d.rotulos[j].id || ''));
      if (performance.now() < fim) requestAnimationFrame(f); else ok(res);
    };
    f();
  });
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/assets/office.css'; document.head.appendChild(css);
  const js = document.createElement('script'); js.src = '/assets/office.js';
  js.onload = () => {
    window.Office.CONFIG.velocidade = 20; window.Office.CONFIG.conversaMs = 900; window.Office.CONFIG.respostaMs = 200;
    const m = () => window.Office.montar(document.getElementById('office'), window.GerenciadorAPI);
    css.sheet ? m() : css.addEventListener('load', m);
  };
  document.head.appendChild(js);
})();
</script></body></html>`;

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__office-rotulos.html') { res.writeHead(200, { 'content-type': TIPOS['.html'] }); res.end(PAGINA); return; }
  const arq = path.normalize(path.join(PASTA, decodeURIComponent(u.pathname)));
  if (!arq.startsWith(PASTA) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(arq).pipe(res);
});

let edge = null, dbg = 0, perfil = '', ws, seq = 0, PORTA = 0;
const pend = new Map();
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
async function esperar(expr, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await avaliar(`!!(${expr})`).catch(() => false)) return true; await dormir(50); }
  return false;
}
const alt = (id, campos) => avaliar(`__alterar(${JSON.stringify(id)}, ${JSON.stringify(campos)})`);
const robo = (nome) => avaliar(`__robo(${JSON.stringify(nome)})`);
const mover = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
async function clicar(x, y) {
  await mover(x, y);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function tecla(k) {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: 'Key' + k.toUpperCase(), text: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
}
async function foto(nome) {
  if (!SAIDA) return;
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
}
async function abrir(w = 1440, h = 900, dpr = 1) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORTA}/__office-rotulos.html` });
  await esperar('window.Office && document.querySelectorAll(".of-ator").length >= 5', 20000);
  await esperar("Office._debug().mapa === 'vila'", 8000);
  await dormir(600);
}
// Escala e alinhamento de todo canvas de pixel art visível: CSS = arte × u (u × dpr inteiro; tolerância de 1/64 px, a
// unidade de layout do Chromium) e canto em pixel inteiro.
const NITIDEZ = `(() => {
  const d = Office._debug(), u = d.pixel.u, dpr = devicePixelRatio, ruins = [];
  for (const c of document.querySelectorAll('.of-raiz canvas.of-px')) {
    if (!c.getClientRects().length) continue;
    const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
    const bad = Math.abs(r.width - c.width * u) > 1 / 64 + 1e-6 || Math.abs(r.left * dpr - Math.round(r.left * dpr)) > 0.02 || Math.abs(r.top * dpr - Math.round(r.top * dpr)) > 0.02 || cs.imageRendering !== 'pixelated';
    if (bad && ruins.length < 5) ruins.push({ cls: c.parentElement.className, w: r.width, arte: c.width, left: r.left * dpr, top: r.top * dpr, ir: cs.imageRendering });
  }
  return { k: u * dpr, u, dpr, n: document.querySelectorAll('.of-raiz canvas.of-px').length, ruins };
})()`;

try {
  PORTA = await escolherPorta(Number(process.env.OFFICE_PORTA) || 47825); // faixa 47822–47826, nunca a 47821
  await new Promise((r, j) => servidor.listen(PORTA, '127.0.0.1', r).on('error', j));
  dbg = 9750 + Math.floor(Math.random() * 150);
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-office-rotulos-'));
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
  globalThis.__frente = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1500);

  // ── 1) placas ──
  await abrir();
  await avaliar("localStorage.removeItem('orbit-office-rotulos')");
  await abrir();
  const pl = await avaliar(`(() => { const d = Office._debug();
    return { placas: [...document.querySelectorAll('.of-placa')].map((p) => ({ area: p.dataset.area || 'entrada', sr: p.querySelector('.of-sr').textContent,
      n: getComputedStyle(p.querySelector('.of-px-n')).display, h: p.querySelector('.of-px-h') ? getComputedStyle(p.querySelector('.of-px-h')).display : 'nenhuma' })),
      caixas: d.rotulos.filter((r) => r.tipo === 'placa'), casas: d.casasPx, cel: d.celula,
      pilulas: document.querySelectorAll('.of-area-rot b, .of-area-rot small, .of-cracha').length }; })()`);
  conferir(pl.placas.length === 9 && pl.pilulas === 0, `placas: 9 placas de madeira (7 casas, fogueira e entrada), sem as pílulas antigas (${pl.placas.length}, ${pl.pilulas})`);
  conferir(pl.placas.filter((p) => p.area !== 'entrada').every((p) => p.n === 'block' && p.h === 'none'), 'placas: só o nome do lugar; a 2ª linha (função) fica escondida');
  const inter = (p, q) => Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
  const pc = pl.caixas.filter((c) => pl.casas.some((h) => inter(c, h) > 1));
  conferir(pc.length === 0, 'placas: nenhuma toca em fachada ou porta ' + JSON.stringify(pc));
  const longe = pl.casas.filter((h) => { const c = pl.caixas.find((q) => q.id === Object.entries({ mestre: 'guild', pesquisador: 'tower', backend: 'forge', frontend: 'tavern', tester: 'hut', serraria: 'sawmill', estufa: 'greenhouse' }).find(([, v]) => v === h.id)[0]);
    return !c || c.y < h.y + h.h - 1 || c.y > h.y + h.h + pl.cel || Math.min(Math.abs(c.x - h.porta), Math.abs(c.x + c.w - h.porta)) > 6 * pl.cel; });
  conferir(longe.length === 0, 'placas: cada uma logo abaixo da base da casa, junto à porta ' + JSON.stringify(longe.map((h) => h.id)));
  // hover numa placa: aparece a função
  const forja = await avaliar(`(() => { const p = document.querySelector('.of-placa[data-area="backend"]').getBoundingClientRect(); return { x: p.left + p.width / 2, y: p.top + p.height / 2 }; })()`);
  await mover(forja.x, forja.y); await dormir(150);
  const fh = await avaliar(`(() => { const p = document.querySelector('.of-placa[data-area="backend"]'); return { h: getComputedStyle(p.querySelector('.of-px-h')).display, sr: p.querySelector('.of-sr').textContent }; })()`);
  conferir(fh.h === 'block' && fh.sr === 'Forja · Backend', 'placas: no hover, a placa da Forja mostra a função (Backend) ' + JSON.stringify(fh));
  await mover(5, 5);
  await foto('rotulos-1440');

  // ── 2) ícones por estado ──
  await alt('d4', { status: 'erro', detalhe: 'Falhou: layout quebrado' });
  await alt('d2', { status: 'aguardando', controle: { permissao: { id: 'p1', ferramenta: 'Bash', resumo: 'node servidor.mjs', tipo: 'ferramenta' } } });
  conferir(await esperar("__robo('Frontend').icone === 'erro' && __robo('Pesquisador').icone === 'espera' && __robo('Mestre').icone === 'trab' && __robo('Backend').icone === 'trab' && __robo('Tester').icone === 'ok'", 15000),
    'ícones: erro ✕ (Frontend), aguardando ! (Pesquisador), trabalhando … (Mestre e Backend), concluído ✓ (Tester): ' + JSON.stringify((await avaliar('Office._debug().robos')).map((r) => [r.nome, r.icone])));
  const pulsa = await avaliar(`(() => { const d = Office._debug(), i = d.robos.findIndex((r) => r.nome === 'Pesquisador'); const c = document.querySelectorAll('.of-icone')[i].querySelector('canvas'); return getComputedStyle(c).animationName; })()`);
  conferir(pulsa === 'of-px-pulsa', 'ícones: o "!" pulsa (' + pulsa + ')');
  conferir(await avaliar("document.querySelectorAll('.of-balao.of-vis').length === 0"), 'balão: fechado por padrão (só o ícone)');

  // ── 3) nada cobre casa; rótulos não se cobrem (andando, entrando e com balões) ──
  const am1 = await avaliar('__amostrar(2500)');
  conferir(am1.quadros > 20 && am1.sobreCasa.length === 0, `sem rótulo sobre fachada/porta (${am1.quadros} quadros): ` + JSON.stringify(am1.sobreCasa));
  conferir(am1.entreSi.length === 0, 'rótulos sem sobreposição entre si: ' + JSON.stringify(am1.entreSi));

  // ── 5) fila de pedidos ──
  conferir(await esperar("Office._debug().avisos.some((x) => x.nome === 'Pesquisador' && x.detalhe === 'Bash · node servidor.mjs' && x.acao === 'decidir')"), 'pedidos: o detalhe "Bash · node servidor.mjs" vai para a fila do canto: ' + JSON.stringify(await avaliar('Office._debug().avisos')));
  const av = await avaliar(`(() => { const a = document.querySelector('.of-aviso'), r = a.getBoundingClientRect(), p = document.querySelector('.of-palco').getBoundingClientRect(), d = Office._debug();
    const bts = [...a.querySelectorAll('.of-aviso-bt')].map((b) => { const q = b.getBoundingClientRect(); return { acao: b.dataset.acao, x: q.left + q.width / 2, y: q.top + q.height / 2, rot: b.getAttribute('aria-label') }; });
    const casas = d.casasPx.map((c) => ({ x: c.x + p.left, y: c.y + p.top, w: c.w, h: c.h }));
    return { bts, r: { x: r.left, y: r.top, w: r.width, h: r.height }, sobreCasa: casas.some((c) => Math.min(r.right, c.x + c.w) > Math.max(r.left, c.x) && Math.min(r.bottom, c.y + c.h) > Math.max(r.top, c.y)), sr: a.querySelector('.of-sr').textContent }; })()`);
  conferir(av.bts.map((b) => b.acao).join() === 'negar,permitir' || av.bts.map((b) => b.acao).sort().join() === 'negar,permitir', 'pedidos: botões Permitir e Negar ' + JSON.stringify(av.bts.map((b) => b.rot)));
  conferir(!av.sobreCasa, 'pedidos: a fila não cobre nenhuma casa');
  const bP = av.bts.find((b) => b.acao === 'permitir');
  await clicar(bP.x, bP.y);
  conferir(await esperar("__resp.length === 1 && __resp[0][0] === 'd2' && __resp[0][1].id === 'p1' && __resp[0][1].decisao === 'permitir'", 3000), 'pedidos: Permitir chama a API com o id do pedido ' + JSON.stringify(await avaliar('__resp')));
  conferir(await esperar("document.querySelector('.of-aviso[aria-busy=\"true\"]')", 2000), 'pedidos: o aviso fica "Enviando…" até a sessão responder');
  await alt('d2', { status: 'trabalhando', controle: null, ferramenta: { nome: 'WebSearch', alvo: 'pathfinding' } });
  conferir(await esperar("!document.querySelector('.of-aviso') && __robo('Pesquisador').icone !== 'espera'", 5000), 'pedidos: o aviso e o "!" somem quando a sessão deixa de aguardar');
  await alt('d2', { status: 'aguardando', controle: { permissao: { id: 'p2', ferramenta: 'Edit', resumo: 'index.html', tipo: 'ferramenta' } } });
  await esperar("document.querySelector('.of-aviso-bt[data-acao=\"negar\"]')", 5000);
  const bN = await avaliar(`(() => { const q = document.querySelector('.of-aviso-bt[data-acao="negar"]').getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
  await clicar(bN.x, bN.y);
  conferir(await esperar("__resp.length === 2 && __resp[1][1].id === 'p2' && __resp[1][1].decisao === 'negar'", 3000), 'pedidos: Negar chama a API com decisao "negar"');
  await foto('rotulos-pedido');
  await alt('d2', { status: 'trabalhando', controle: null });

  // ── 4) balão no hover e no clique ──
  await alt('d3', { status: 'trabalhando', ferramenta: { nome: 'Edit', alvo: 'D:/x/um/caminho/bem/comprido/de/arquivo/que/nao/cabe/no/balao/servidor-com-nome-longo.mjs' } });
  await esperar("__robo('Backend') && !__robo('Backend').andando", 8000);
  const ab = await avaliar("__alvo('Backend')");
  await mover(ab.x, ab.y);
  conferir(await esperar("(() => { const b = [...document.querySelectorAll('.of-balao.of-vis')]; return b.length === 1 && /^Backend\\./.test(b[0].querySelector('.of-sr').textContent); })()", 3000), 'balão: abre no hover, com o nome dentro');
  const bl = await avaliar(`(() => { const b = document.querySelector('.of-balao.of-vis'), c = b.querySelector('canvas'), d = Office._debug(); return { arte: c.width, sr: b.querySelector('.of-sr').textContent, caixa: d.rotulos.find((r) => r.tipo === 'balao') }; })()`);
  conferir(bl.arte <= 132 + 10 + 3 && /servidor-com-nome-longo/.test(bl.sr), `balão: largura limitada (${bl.arte} px de arte) e o texto longo cortado no desenho (inteiro só no texto escondido)`);
  await foto('rotulos-hover');
  await mover(5, 5);
  conferir(await esperar("document.querySelectorAll('.of-balao.of-vis').length === 0", 2000), 'balão: fecha quando o mouse sai');
  // clique fixa um; o hover em outro abre o segundo; os dois não se cobrem nem cobrem casa
  const am = await avaliar("__alvo('Mestre')");
  await clicar(am.x, am.y);
  const at = await avaliar("__alvo('Tester')");
  await mover(at.x, at.y);
  conferir(await esperar("document.querySelectorAll('.of-balao.of-vis').length === 2", 3000), 'balão: clique (Mestre) + hover (Tester) = dois balões');
  const am2 = await avaliar('__amostrar(600)');
  conferir(am2.sobreCasa.length === 0 && am2.entreSi.length === 0 && (am2.tipos.balao || 0) > 0, 'balão: os dois abertos não se cobrem nem cobrem casa ' + JSON.stringify(am2));
  await foto('rotulos-dois-baloes');
  await mover(5, 5);
  await tecla('Escape');

  // ── 6) tecla L ──
  await tecla('l');
  const sem = await avaliar(`(() => ({ cls: document.querySelector('.of-raiz').classList.contains('of-sem-rotulos'), rot: getComputedStyle(document.querySelector('.of-rotulos')).display,
    areas: getComputedStyle(document.querySelector('.of-areas')).display, salvo: localStorage.getItem('orbit-office-rotulos') }))()`);
  conferir(sem.cls && sem.rot === 'none' && sem.areas === 'none' && sem.salvo === '0', 'tecla L: some placas, ícones e balões, e salva a escolha ' + JSON.stringify(sem));
  await alt('d2', { status: 'aguardando', controle: { permissao: { id: 'p3', ferramenta: 'Bash', resumo: 'npm test', tipo: 'ferramenta' } } });
  conferir(await esperar("document.querySelector('.of-aviso') && getComputedStyle(document.querySelector('.of-avisos')).display !== 'none'", 5000), 'tecla L: a fila de pedidos continua visível');
  await abrir();
  conferir(await avaliar("document.querySelector('.of-raiz').classList.contains('of-sem-rotulos')"), 'tecla L: ao reabrir, os rótulos continuam ocultos');
  await tecla('L');
  conferir(await esperar("!document.querySelector('.of-raiz').classList.contains('of-sem-rotulos') && getComputedStyle(document.querySelector('.of-areas')).display !== 'none' && localStorage.getItem('orbit-office-rotulos') === '1'", 2000), 'tecla L: de novo, tudo volta');

  // ── 5b) margem larga: a fila fica fora do mapa ──
  await abrir(1920, 900, 1);
  await alt('d2', { status: 'aguardando', controle: { permissao: { id: 'p4', ferramenta: 'Bash', resumo: 'npm test', tipo: 'ferramenta' } } });
  await esperar("document.querySelector('.of-aviso')", 5000);
  const fora = await avaliar(`(() => { const a = document.querySelector('.of-avisos').getBoundingClientRect(), p = document.querySelector('.of-palco').getBoundingClientRect(); return { fora: a.left >= p.right, a: a.left, p: p.right }; })()`);
  conferir(fora.fora, 'pedidos: com margem, a fila fica fora do mapa ' + JSON.stringify(fora));
  await foto('rotulos-1920');

  // ── 7) nitidez: DPR 1 e 1,25 ──
  await abrir(1440, 900, 1);
  const n1 = await avaliar(NITIDEZ);
  conferir(n1.n > 10 && n1.ruins.length === 0 && n1.k === 1, 'nitidez (DPR 1): escala inteira e pixel inteiro ' + JSON.stringify(n1));
  await abrir(1440, 900, 1.25);
  const ab2 = await avaliar("__alvo('Backend')");
  await mover(ab2.x, ab2.y); await dormir(300);
  const n2 = await avaliar(NITIDEZ);
  conferir(n2.ruins.length === 0 && n2.k === 2, 'nitidez (DPR 1,25): 2 px do aparelho por px de arte, sem borrão ' + JSON.stringify(n2));
  await foto('rotulos-dpr125');
  await mover(5, 5);

  conferir(consoleErros.length === 0, 'sem erros de console' + (consoleErros.length ? ': ' + consoleErros.slice(0, 3).join(' | ') : ''));
} catch (e) {
  falhas.push('exceção: ' + (e.stack || e));
  console.log('FALHA exceção: ' + (e.stack || e));
} finally {
  clearInterval(globalThis.__frente);
  try { ws?.close(); } catch {}
  if (dbg) await fecharEdge(dbg, perfil);
  try { edge?.kill(); } catch {}
  servidor.close();
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
}
console.log(`\n${falhas.length ? 'FALHOU' : 'ok'}: ${falhas.length} falha(s).`);
process.exit(falhas.length ? 1 : 0);
