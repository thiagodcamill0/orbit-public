// Office por eventos reais (escritórios E1, parte 2a): sessões reais → movimento, sem sorteio.
// node testes/office-eventos.test.mjs
// Servidor estático mínimo (porta por escolherPorta) + página gerada (/__office-eventos.html) com API falsa de
// sessões controlável (__alterar, __agente, __gravar). Edge headless + CDP. Cobre, uma linha por cenário:
//  descanso fixo · ferramenta comum → estação · WebSearch/WebFetch/MCP de busca → ponto de pesquisa (retido) ·
//  aguardando → fila (FIFO, 4º fica na estação) com "Aguardando você" · pedido externo → fila + "!" + aviso no canto + balão
//  destacado · ferramenta depois da aprovação externa → balcão (retido) · delegação (membro vai ao líder e volta) ·
//  entrega (vai ao líder e ao descanso) · convidado (porta → líder → estação; ao terminar/sumir: líder → porta) ·
//  compactando · erro · ociosa · dormindo · grade (fila/pesquisa/balcão) · determinismo (duas rodadas = mesmas posições).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
let rotulo = '';
const conferir = (ok, msg) => { console.log((ok ? 'ok   ' : 'FALHA ') + rotulo + msg); if (!ok) falhas.push(rotulo + msg); };
const consoleErros = [];

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Office · eventos</title>
<link rel="icon" href="data:,">
<style>html,body{height:100%;margin:0;background:#0a0a0a}#office{width:100vw;height:100vh}</style></head><body><section id="office"></section>
<script>
(function () {
  const T0 = Date.now(), ouv = {}, mapa = new Map(), copia = (o) => JSON.parse(JSON.stringify(o));
  const sess = (o) => Object.assign({ id: '', status: 'trabalhando', desde: T0, titulo: '', apelido: '', projeto: 'Orbit', cwd: 'D:\\\\x', tarefa: '', primeira: '',
    detalhe: '', ferramenta: null, agentes: [], subagentes: 0, pai: null, vivo: true, atividade: T0, nome: '', controle: null }, o);
  mapa.set('m1', sess({ id: 'm1', nome: 'm-lider', titulo: 'Lider do time', status: 'trabalhando' }));
  const dep = (id, primeira) => mapa.set(id, sess({ id, pai: 'm1', nome: 'm-' + id, titulo: '', primeira, status: 'concluido' }));
  dep('d1', 'Rode a fumaca e verifique os testes');
  dep('d2', 'Pesquise referencias do pathfinding');
  dep('d3', 'Ajuste a rota do servidor');
  dep('d4', 'Ajuste o layout da pagina');
  const emitir = (s) => (ouv.sessao || []).forEach((f) => f(copia(s)));
  window.__alterar = (id, campos) => { const s = mapa.get(id); for (const k in campos) { if (campos[k] === null) delete s[k]; else s[k] = campos[k]; } s.atividade = Date.now(); emitir(s); };
  // Convidados (agentes do líder): add | set | del
  window.__agente = (op, id, campos) => {
    const m = mapa.get('m1');
    if (op === 'add') m.agentes.push(Object.assign({ id, tipo: 'general-purpose', descricao: 'Revisao geral do projeto', status: 'trabalhando', inicio: Date.now(), fim: null, ferramenta: null, ferramentas: 0, atividade: Date.now() }, campos));
    else if (op === 'set') Object.assign(m.agentes.find((x) => x.id === id), campos);
    else m.agentes = m.agentes.filter((x) => x.id !== id);
    m.atividade = Date.now(); emitir(m);
  };
  window.GerenciadorAPI = {
    sessoes: () => [...mapa.values()].map(copia), sessao: (id) => (mapa.has(id) ? copia(mapa.get(id)) : null),
    eventos: async (id) => ({ sessao: mapa.get(id) || null, eventos: [] }), uso: () => null, config: () => ({}),
    on: (t, fn) => { (ouv[t] = ouv[t] || []).push(fn); return () => {}; }, selecionada: () => null,
  };
  // Gravador de uma sequência de células (um robô por nome), um registro a cada mudança.
  window.__gravar = (nome) => {
    window.__log = []; let ult = '';
    const f = () => {
      const r = Office._debug().robos.find((x) => x.nome === nome);
      const s = r ? r.celula.join(',') + '|' + r.ordens + '|' + (r.saindo ? 1 : 0) : 'ausente';
      if (s !== ult) { window.__log.push(s); ult = s; }
      if (window.__rec) requestAnimationFrame(f);
    };
    window.__rec = true; f();
  };
  window.__parar = () => { window.__rec = false; return window.__log; };
  window.__robo = (nome) => Office._debug().robos.find((r) => r.nome === nome) || null;
  window.__quieto = () => { const d = Office._debug(); return d.robos.every((r) => !r.andando && !r.ordens) && d.interacoes.length === 0; };
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/assets/office.css'; document.head.appendChild(css);
  const js = document.createElement('script'); js.src = '/assets/office.js';
  js.onload = () => {
    window.Office.CONFIG.velocidade = 40; window.Office.CONFIG.conversaMs = 700; window.Office.CONFIG.respostaMs = 200;
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
  if (u.pathname === '/__office-eventos.html') { res.writeHead(200, { 'content-type': TIPOS['.html'] }); res.end(PAGINA); return; }
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
// Espera a expressão (no navegador) ficar verdadeira; devolve se ficou.
async function esperar(expr, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await avaliar(`!!(${expr})`).catch(() => false)) return true; await dormir(60); }
 
  return false;
}
const quieto = async (ms = 20000) => {
  const fim = Date.now() + ms;
  let n = 0;
  while (Date.now() < fim) { n = (await avaliar('__quieto()')) ? n + 1 : 0; if (n >= 3) return true; await dormir(80); }
  return false;
};
const alt = (id, campos) => avaliar(`__alterar(${JSON.stringify(id)}, ${JSON.stringify(campos)})`);
const robo = (nome) => avaliar(`__robo(${JSON.stringify(nome)})`);
const na = (r, c) => !!r && !!c && r.celula[0] === c[0] && r.celula[1] === c[1] && !r.andando;
const hist = () => avaliar('Office._debug().historico');

async function abrir() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORTA}/__office-eventos.html` });
  await esperar('window.Office && document.querySelectorAll(".of-ator").length >= 5', 20000);
  await quieto();
}

// Uma rodada completa; devolve o rastro das posições assentadas (para comparar rodadas).
async function rodada(n) {
  rotulo = `[r${n}] `;
  const rastro = [];
  const foto = async (cenario) => {
    const d = await avaliar('Office._debug().robos.map((r) => r.nome + "@" + r.celula.join(",")).sort().join(" ")');
    rastro.push(cenario + ': ' + d);
  };
  await abrir();
  const D0 = await avaliar('Office._debug()');
  const cfg = D0.config;
  const grade = D0.caminhavel;
  const ok = (c) => grade[c.y][c.x] === '1';

  // ── grade ──
  conferir(cfg.fila.every(ok) && cfg.pesquisa.every(ok) && ok(cfg.balcao.spot), 'grade: fila, pontos de pesquisa e spot do balcão são caminháveis');
  let balcaoBloq = true;
  for (let x = cfg.balcao.x; x < cfg.balcao.x + cfg.balcao.w; x++) if (grade[cfg.balcao.y][x] !== '0') balcaoBloq = false;
  conferir(balcaoBloq, 'grade: as células do balcão são bloqueadas');
  // Mapa da vila: a estrada principal (linhas 33–36 em volta de y34/y35) passa por todas as colunas, de borda a borda.
  conferir([...Array(D0.colunas).keys()].every((x) => [33, 34, 35, 36].some((y) => grade[y][x] === '1')), 'grade: estrada principal livre de borda a borda');
  conferir(cfg.passagem && ok(cfg.passagem), 'grade: ponto de passagem do líder é caminhável');

  // ── descanso fixo ──
  const nomes = ['Tester', 'Pesquisador', 'Backend', 'Frontend'];
  const lug = {};
  for (const nm of nomes) { const r = await robo(nm); lug[nm] = r; }
  conferir(nomes.every((nm) => lug[nm] && lug[nm].lugar && na(lug[nm], lug[nm].lugar)), 'descanso: ociosos parados no lugar fixo da sala');
  conferir(new Set(nomes.map((nm) => lug[nm].lugar.join(','))).size === 4, 'descanso: um lugar para cada ocioso');
  await dormir(2500);
  const lug2 = {};
  for (const nm of nomes) lug2[nm] = await robo(nm);
  conferir(nomes.every((nm) => na(lug2[nm], lug[nm].celula)), 'descanso: nada se mexe sozinho (mesma célula 2,5 s depois)');
  await foto('descanso');

  // ── ferramenta comum → estação + delegação (o membro vai ao líder e volta) ──
  const h0 = (await hist()).length;
  await avaliar("__gravar('Frontend')");
  await alt('d4', { status: 'trabalhando', ferramenta: { nome: 'Edit', alvo: 'D:/x/index.html' } });
  conferir(await esperar("__robo('Frontend') && __robo('Frontend').tela === 'ativa' && !__robo('Frontend').andando"), 'ferramenta comum: Frontend na estação com a tela ativa');
  conferir(await quieto(), 'ferramenta comum: a delegação termina');
  const logF = await avaliar('__parar()');
  const fe = await robo('Frontend');
  const estacaoMestre = (await avaliar("__robo('Mestre')")).estacao;
  conferir(na(fe, fe.estacao) && fe.pt === '' && fe.fila === -1, 'ferramenta comum: termina na estação, sem ponto temporário nem fila');
  const hh = await hist();
  conferir(hh.length === h0 + 1 && hh.at(-1).tipo === 'delegar' && hh.at(-1).v === 'Frontend' && hh.at(-1).h === 'Mestre' && hh.at(-1).conversou && hh.at(-1).ok,
    'delegação: o membro (Frontend) vai ao líder, conversa e volta (v=membro, h=Mestre)');
  const perto = logF.some((s) => { const [x, y] = s.split('|')[0].split(',').map(Number); return Math.abs(x - estacaoMestre[0]) <= 3 && Math.abs(y - estacaoMestre[1]) <= 3; });
  conferir(perto, 'delegação: o membro chegou perto da estação do líder');
  await foto('ferramenta');

  // ── pesquisa: WebSearch → ponto de pesquisa, retido depois que acaba ──
  await alt('d2', { status: 'trabalhando', ferramenta: { nome: 'WebSearch', alvo: 'pathfinding' } });
  conferir(await esperar("(() => { const r = __robo('Pesquisador'); const c = Office._debug().config.pesquisa[0]; return r && r.pt === 'pesq' && !r.andando && r.celula[0] === c.x && r.celula[1] === c.y; })()"), 'pesquisa: WebSearch leva ao 1º ponto de pesquisa');
  const t0 = Date.now();
  await alt('d2', { ferramenta: null });
  await dormir(1000);
  let pe = await robo('Pesquisador');
  conferir(pe.pt === 'pesq' && na(pe, [cfg.pesquisa[0].x, cfg.pesquisa[0].y]), 'pesquisa: 1 s depois de acabar a busca ainda está no ponto (retido)');
  conferir(await esperar("__robo('Pesquisador').pt === ''", 8000), 'pesquisa: solta o ponto depois da retenção');
  const ret = Date.now() - t0;
  conferir(ret >= 2000 && ret <= 6500, `pesquisa: retida por ~2,5 s (${ret} ms)`);
  conferir(await esperar("(() => { const r = __robo('Pesquisador'); return r.tela === 'ativa' && !r.andando && r.celula[0] === r.estacao[0] && r.celula[1] === r.estacao[1]; })()"), 'pesquisa: volta para a estação');
  await alt('d2', { ferramenta: { nome: 'WebFetch', alvo: 'https://x.dev' } });
  conferir(await esperar("__robo('Pesquisador').pt === 'pesq'"), 'pesquisa: WebFetch também leva ao ponto');
  await alt('d2', { ferramenta: { nome: 'mcp__brave__brave_web_search', alvo: 'q' } });
  await dormir(500);
  conferir((await robo('Pesquisador')).pt === 'pesq', 'pesquisa: MCP de busca continua no ponto');
  await alt('d2', { ferramenta: { nome: 'Read', alvo: 'a.js' } });
  conferir(await esperar("__robo('Pesquisador').pt === ''", 8000) && await esperar("(() => { const r = __robo('Pesquisador'); return !r.andando && r.celula[0] === r.estacao[0] && r.celula[1] === r.estacao[1]; })()"), 'pesquisa: ferramenta comum volta à estação');
  await alt('d3', { status: 'trabalhando', ferramenta: { nome: 'mcp__github__create_issue', alvo: 'x' } });
  await quieto();
  await dormir(1200);
  const be = await robo('Backend');
  conferir(be.pt === '' && na(be, be.estacao), 'pesquisa: MCP que não é de busca fica na estação');
  await foto('pesquisa');

  // ── aguardando → fila (FIFO), balão "Aguardando você"; o 4º fica na estação ──
  await alt('d3', { status: 'aguardando', detalhe: 'Permissão: Bash · ls', ferramenta: null });
  conferir(await esperar("(() => { const r = __robo('Backend'); const c = Office._debug().config.fila[0]; return r && r.fila === 0 && !r.andando && r.celula[0] === c.x && r.celula[1] === c.y && r.balao; })()"), 'fila: aguardando vai à 1ª vaga da fila');
  const bb = await robo('Backend');
  conferir(bb.balao.k === 'espera' && bb.balao.tit === 'Aguardando você' && /Permissão/.test(bb.balao.txt), `fila: balão "Aguardando você" (${JSON.stringify(bb.balao)})`);
  conferir(bb.tela === 'espera', 'fila: tela da estação em espera');
  await alt('d1', { status: 'trabalhando', controle: { permissao: { id: 'p1', ferramenta: 'Bash', resumo: 'Permissão: Bash · npm test' } } });
  conferir(await esperar("(() => { const r = __robo('Tester'); return r && r.fila === 1 && !r.andando; })()"), 'fila: permissão com status "trabalhando" também vale (2ª vaga)');
  await alt('d2', { status: 'trabalhando', ferramenta: null, controle: { pendentes: 2 } });
  conferir(await esperar("(() => { const r = __robo('Pesquisador'); return r && r.fila === 2 && !r.andando; })()"), 'fila: pendentes > 0 também vale (3ª vaga)');
  await alt('d4', { status: 'aguardando', detalhe: 'Pergunta: qual porta?' });
  await dormir(1200);
  const f4 = await robo('Frontend');
  conferir(f4.fila === -1 && na(f4, f4.estacao), 'fila: cheia, o 4º continua na estação');
  await avaliar("Promise.resolve()");
  await alt('d3', { status: 'trabalhando', detalhe: '' });
  conferir(await esperar("(() => { const r = __robo('Frontend'); return r.fila === 0 && !r.andando; })()"), 'fila: ao abrir vaga, o que esperava na estação entra');
  const sem = await avaliar("Office._debug().robos.filter((r) => r.fila >= 0).map((r) => r.nome + ':' + r.fila).sort().join(',')");
  conferir(sem === 'Frontend:0,Pesquisador:2,Tester:1', `fila: vagas ocupadas sem repetição (${sem})`);
  await quieto(); // o rastro compara posições assentadas (quem sai de uma casa espera surgir na porta)
  await foto('fila');
  // libera todos (a entrega do Tester acontece: não é checada aqui)
  await alt('d1', { status: 'concluido', controle: null });
  await alt('d2', { controle: null });
  await alt('d4', { status: 'trabalhando', detalhe: '' });
  await quieto();

  // ── pedido externo → fila + "!" pulsando (sem cadeado) + aviso na fila do canto + balão destacado; depois, balcão ──
  await alt('d4', { status: 'aguardando', detalhe: '', controle: { permissao: { id: 'p2', ferramenta: 'Bash', resumo: 'Ação externa: git push', externa: true } }, ferramenta: { nome: 'Bash', alvo: 'git push' } });
  conferir(await esperar("(() => { const r = __robo('Frontend'); return r && r.fila >= 0 && !r.andando && r.externa && r.balao && r.balao.k === 'externa'; })()"), 'externa: vai à fila com balão destacado (k "externa")');
  const fx = await robo('Frontend');
  conferir(fx.balao.tit === 'Aguardando você', 'externa: balão com o selo "Aguardando você"');
  conferir(fx.icone === 'espera' && (await avaliar("document.querySelectorAll('.of-ator .of-prov-cadeado, .of-ator [class*=cadeado]').length")) === 0, 'externa: só o "!" sobre o agente (sem cadeado no robô)');
  conferir(await esperar("Office._debug().avisos.some((x) => x.nome === 'Frontend' && /git push/.test(x.detalhe))"), 'externa: o detalhe vai para a fila de pedidos do canto: ' + JSON.stringify((await avaliar('Office._debug().avisos'))));
  await alt('d4', { status: 'trabalhando', controle: null });
  conferir(await esperar("(() => { const r = __robo('Frontend'); const s = Office._debug().config.balcao.spot; return r && r.pt === 'balcao' && !r.andando && r.celula[0] === s.x && r.celula[1] === s.y; })()"), 'balcão: ferramenta logo depois da aprovação externa vai ao balcão de envio');
  conferir((await robo('Frontend')).icone !== 'espera' && (await avaliar("!Office._debug().avisos.some((x) => x.nome === 'Frontend')")), 'balcão: o "!" e o aviso somem depois da aprovação');
  const tb = Date.now();
  await alt('d4', { ferramenta: null });
  await dormir(500);
  conferir((await robo('Frontend')).pt === 'balcao', 'balcão: retido logo depois que a ação termina');
  conferir(await esperar("__robo('Frontend').pt === ''", 6000), 'balcão: solta o ponto');
  const rb = Date.now() - tb;
  conferir(rb >= 900 && rb <= 5000, `balcão: retido por ~1,2 s (${rb} ms)`);
  conferir(await esperar("(() => { const r = __robo('Frontend'); return !r.andando && r.celula[0] === r.estacao[0] && r.celula[1] === r.estacao[1]; })()"), 'balcão: volta à estação');
  // sem aprovação externa antes, Bash comum fica na estação
  await alt('d3', { ferramenta: { nome: 'Bash', alvo: 'git push' } });
  await dormir(1500);
  const b2 = await robo('Backend');
  conferir(b2.pt === '' && na(b2, b2.estacao), 'balcão: ferramenta sem aprovação externa não vai ao balcão');
  await alt('d3', { ferramenta: null });
  await foto('externa');

  // ── delegação explícita (Tester concluído → trabalhando) ──
  const h1 = (await hist()).length;
  await avaliar("__gravar('Tester')");
  await alt('d1', { status: 'trabalhando', ferramenta: { nome: 'Read', alvo: 'a.js' } });
  conferir(await esperar("(() => { const r = __robo('Tester'); return r.tela === 'ativa' && !r.andando; })()"), 'delegação: Tester chega à estação');
  await quieto();
  const logT = await avaliar('__parar()');
  const hT = (await hist()).slice(h1);
  conferir(hT.length === 1 && hT[0].tipo === 'delegar' && hT[0].v === 'Tester' && hT[0].h === 'Mestre' && hT[0].conversou, 'delegação: uma troca "delegar", membro → líder');
  conferir(logT.some((s) => { const [x, y] = s.split('|')[0].split(',').map(Number); return Math.abs(x - estacaoMestre[0]) <= 3 && Math.abs(y - estacaoMestre[1]) <= 3; }), 'delegação: o Tester foi até o líder');
  // aguardando → trabalhando não delega
  const h2 = (await hist()).length;
  await alt('d3', { status: 'aguardando', detalhe: 'Pergunta' });
  await esperar("__robo('Backend').fila >= 0");
  await alt('d3', { status: 'trabalhando', detalhe: '' });
  await quieto();
  conferir((await hist()).length === h2, 'delegação: voltar de "aguardando" não delega de novo');
  await foto('delegacao');

  // ── entrega: concluir → vai ao líder e depois ao descanso ──
  await avaliar("__gravar('Tester')");
  await alt('d1', { status: 'concluido', ferramenta: null });
  conferir(await esperar("(() => { const r = __robo('Tester'); return r.lugar && !r.andando && r.celula[0] === r.lugar[0] && r.celula[1] === r.lugar[1]; })()"), 'entrega: depois da entrega, o Tester vai ao lugar fixo do descanso');
  await quieto();
  const logE = await avaliar('__parar()');
  const hE = await hist();
  conferir(hE.at(-1).tipo === 'entregar' && hE.at(-1).v === 'Tester' && hE.at(-1).h === 'Mestre' && hE.at(-1).conversou, 'entrega: troca "entregar" com o líder');
  conferir(logE.some((s) => { const [x, y] = s.split('|')[0].split(',').map(Number); return Math.abs(x - estacaoMestre[0]) <= 3 && Math.abs(y - estacaoMestre[1]) <= 3; }), 'entrega: passou pelo líder');
  const teL = await robo('Tester');
  conferir(na(teL, lug.Tester.lugar), 'ociosa: volta exatamente ao mesmo lugar de descanso do início');
  await foto('entrega');

  // ── compactando: estação, tela em espera, "Organizando memória"; sem delegar/entregar ──
  const h3 = (await hist()).length;
  await alt('d1', { controle: { autoCompactar: { compactando: true } } });
  conferir(await esperar("(() => { const r = __robo('Tester'); return r.compacta && !r.andando && r.celula[0] === r.estacao[0] && r.celula[1] === r.estacao[1] && r.balao; })()"), 'compactando: o Tester vai à estação');
  const tc = await robo('Tester');
  conferir(tc.tela === 'espera', `compactando: tela em espera (${tc.tela})`);
  conferir(tc.balao.k === 'compacta' && tc.balao.txt === 'Organizando memória', `compactando: balão "Organizando memória" (${JSON.stringify(tc.balao)})`);
  await alt('d1', { controle: null });
  conferir(await esperar("(() => { const r = __robo('Tester'); return !r.compacta && r.lugar && !r.andando && r.celula[0] === r.lugar[0] && r.celula[1] === r.lugar[1]; })()"), 'compactando: acabou, volta ao descanso');
  conferir((await hist()).length === h3, 'compactando: não gera delegação nem entrega');
  await foto('compactando');

  // ── erro: fica na estação com a tela vermelha ──
  await alt('d3', { status: 'erro', detalhe: 'EADDRINUSE: porta ocupada' });
  conferir(await esperar("(() => { const r = __robo('Backend'); return r.tela === 'erro' && !r.andando && r.celula[0] === r.estacao[0] && r.celula[1] === r.estacao[1] && r.balao && r.balao.k === 'erro'; })()"), 'erro: estação com a tela vermelha e o balão de erro');
  await alt('d3', { status: 'trabalhando', detalhe: '' });
  await quieto();
  await foto('erro');

  // ── dormindo: zZ no descanso ──
  await alt('d2', { status: 'concluido', ferramenta: null, controle: { modo: 'orbit', processo: 'dormindo' } });
  conferir(await esperar("(() => { const r = __robo('Pesquisador'); return r.dormindo && r.lugar && !r.andando && r.celula[0] === r.lugar[0] && r.celula[1] === r.lugar[1]; })()"), 'dormindo: Pesquisador parado no descanso');
  await dormir(300);
  conferir((await avaliar("document.querySelectorAll('.of-dorme:not([hidden])').length")) === 1, 'dormindo: o zZ aparece (um robô)');
  await alt('d2', { controle: null });
  await quieto();
  await foto('dormindo');

  // ── convidado: entra pela porta, passa pelo líder, vai a uma estação livre; ao terminar, líder → porta ──
  const pass = cfg.passagem, chavePass = pass.x + ',' + pass.y;
  await avaliar("__gravar('Auxiliar')");
  await avaliar("__agente('add', 'a1', {})");
  conferir(await esperar("(() => { const r = __robo('Auxiliar'); return r && !r.andando && r.tela === 'ativa'; })()", 20000), 'convidado: chegou a uma estação e trabalha');
  let lg = (await avaliar('__parar()')).filter((s, i) => !(i === 0 && s === 'ausente'));
  const aux = await robo('Auxiliar');
  const porta = await avaliar("Office.CONFIG.entrada.x + ',' + Office.CONFIG.entrada.y");
  conferir(lg[0] === porta + '|1|0', `convidado: nasce na porta (${lg[0]})`);
  conferir(lg.includes(chavePass + '|1|0'), `convidado: passou pelo ponto do líder ${chavePass} antes de ir à estação`);
  conferir(lg.indexOf(chavePass + '|1|0') < lg.findIndex((s) => s.startsWith(aux.estacao.join(',') + '|0|0')), 'convidado: a passagem veio antes da estação');
  conferir(aux.origem === 'subagente' && !(aux.estacao[0] === estacaoMestre[0] && aux.estacao[1] === estacaoMestre[1]), 'convidado: estação livre que não é a do líder');
  await avaliar("__gravar('Auxiliar')");
  await avaliar("__agente('set', 'a1', { status: 'concluido', fim: Date.now() })");
  conferir(await esperar("!__robo('Auxiliar')", 20000), 'convidado: ao terminar, sai pela porta');
  lg = await avaliar('__parar()');
  conferir(lg.includes(chavePass + '|1|1'), 'convidado: ao terminar, passou pelo líder antes da porta');
  conferir(lg.at(-1) === 'ausente', 'convidado: some depois da porta');
  await dormir(1200);
  conferir(!(await robo('Auxiliar')), 'convidado: continua na lista como concluído e não é recriado');
  await avaliar("__agente('add', 'a2', { status: 'concluido', fim: Date.now() })");
  await dormir(1200);
  conferir(!(await robo('Auxiliar')), 'convidado: que chega já concluído nunca é criado');
  await avaliar("__agente('del', 'a2')");
  await avaliar("__agente('add', 'a3', {})");
  conferir(await esperar("(() => { const r = __robo('Auxiliar'); return r && !r.andando && r.tela === 'ativa'; })()", 20000), 'convidado: outro convidado chega à estação');
  await avaliar("__gravar('Auxiliar')");
  await avaliar("__agente('del', 'a3')");
  conferir(await esperar("!__robo('Auxiliar')", 20000), 'convidado: some da lista e sai pela porta');
  lg = await avaliar('__parar()');
  conferir(lg.includes(chavePass + '|1|1') && lg.at(-1) === 'ausente', 'convidado: sumiu da lista → passa pelo líder e sai');
  await quieto();
  await foto('convidado');
  return rastro;
}

try {
  PORTA = await escolherPorta(Number(process.env.OFFICE_PORTA) || 47826);
  await new Promise((r, j) => servidor.listen(PORTA, '127.0.0.1', r).on('error', j));
  dbg = 9800 + Math.floor(Math.random() * 150);
  perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-office-eventos-'));
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
  // O Edge headless marca a página como oculta depois de ~15 s (o rAF para): trazê-la para a frente mantém 60 fps.
  globalThis.__frente = setInterval(() => { cdp('Page.bringToFront').catch(() => {}); }, 1500);

  const r1 = await rodada(1);
  const r2 = await rodada(2);
  rotulo = '';
  conferir(JSON.stringify(r1) === JSON.stringify(r2), 'determinismo: duas rodadas iguais dão as mesmas posições' + (JSON.stringify(r1) === JSON.stringify(r2) ? '' : '\n' + r1.join('\n') + '\n---\n' + r2.join('\n')));
  const fonte = fs.readFileSync(path.join(PASTA, 'assets', 'office.js'), 'utf8');
  conferir(!/Math\.random/.test(fonte), 'determinismo: office.js não usa Math.random');
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
