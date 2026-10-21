// Aba "Visão geral" do celular (mobile/widgets.js + widgets.css + assets/comum/widgets.js) contra o servidor falso testes/mobile-mock.mjs.
// Porta livre de 47822–47826 (nunca a 47821) e Edge headless mudo com viewport de iPhone (390×844).
//   node testes/mobile-widgets.test.mjs [pasta-de-saida]
// Confere: a aba é a primeira da barra e Sessões segue como padrão; os 4 widgets (sessões, contexto, uso do plano)
// renderizam com os dados do mock; NÃO há widget de espaço em disco; a janela do modelo em assets/comum/widgets.js bate com a do
// janela.mjs; sem rolagem lateral, sem erro de console, sem violação de CSP.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';
import { subirMock } from './mobile-mock.mjs';
import { janelaDoModelo } from '../janela.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SAIDA = arg ? path.resolve(arg) : fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mobile-widgets-'));
fs.mkdirSync(SAIDA, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const conferir = (nome, ok, detalhe) => { checks.push({ nome, ok: !!ok, detalhe: ok ? undefined : detalhe }); };
const consoleErros = [];
const violacoes = [];
let mock = null, ws, seq = 0, edge = null;
const pend = new Map();
const porta = 9800 + Math.floor(Math.random() * 150);
const perfil = path.join(SAIDA, 'edge-' + porta);

async function conectar() {
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) {
    try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!alvo) await dormir(200);
  }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      const t = d.params.args.map((a) => a.value ?? a.description).join(' ');
      (t.startsWith('VIOLAÇÃO CSP') ? violacoes : consoleErros).push(t);
    }
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
      const e = d.params.entry;
      if (e.source === 'network' && /\/remoto\/(eu|parear\/)/.test(e.url || '')) return; // 401 antes de parear: esperado
      if (/Content Security Policy|Refused to/i.test(e.text || '')) violacoes.push(e.text);
      else consoleErros.push(`${e.source}: ${e.text} ${e.url || ''}`);
    }
  };
}
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const avaliar = async (expr) => {
  const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
  if (r?.exceptionDetails) throw new Error('avaliar: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' em ' + expr.slice(0, 120));
  return r?.result?.value;
};
async function esperar(expr, ms = 10000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { try { if (await avaliar(expr)) return true; } catch {} await dormir(120); }
  return false;
}
const Q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const visivel = (sel) => `(() => { const e = ${Q(sel)}; return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
const texto = (sel) => avaliar(`(${Q(sel)} || {}).textContent || ''`);
const digitar = (sel, t) => avaliar(`(() => { const e = ${Q(sel)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(t)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clicar = (sel) => avaliar(`(() => { const e = ${Q(sel)}; if (!e) return false; e.click(); return true; })()`);
const semRolagemLateral = () => avaliar('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
const foto = async (nome) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64')); };
const postMock = (rota, corpo = {}) => fetch(mock.base + rota, { method: 'POST', headers: { 'content-type': 'application/json', origin: mock.base }, body: JSON.stringify(corpo) });

try {
  // ═════════ lógica comum (sem navegador): a janela do modelo é a do janela.mjs ═════════
  const ctx = { window: {}, Date, Math, Object, Number, String, JSON, Array, isFinite };
  vm.runInNewContext(fs.readFileSync(path.join(PASTA, 'assets/comum/widgets.js'), 'utf8'), ctx);
  const W = ctx.window.OrbitWidgets;
  const modelos = ['claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-haiku-4-6', 'claude-fable-1', 'claude-opus-4-1[1m]', 'gpt-x', '', 'claude-sonnet-4-5'];
  conferir('comum: janelaDoModelo igual à do janela.mjs', modelos.every((m) => W.janelaDoModelo(m) === janelaDoModelo(m)), modelos.map((m) => [m, W.janelaDoModelo(m), janelaDoModelo(m)]));
  conferir('comum: fmtK, fmtPct e durRen', W.fmtK(150000) === '150k' && W.fmtK(1e6) === '1M' && W.fmtPct(0.263) === '26,3%' && W.fmtPct(1) === '100%' && W.durRen(133 * 60e3) === '2 h 13 min', [W.fmtK(150000), W.fmtPct(0.263), W.durRen(133 * 60e3)]);
  conferir('comum: rosca com uma só fatia não tem fenda', (() => { const r = W.fatiasRosca({ precisa: 0, trabalhando: 4, novas: 0, concluidas: 0, revisadas: 0, encerradas: 0 }); return !r.varias && Math.abs(r.fatias.find((f) => f.g === 'trabalhando').vis - W.ROSCA_C) < 1e-9; })());

  mock = await subirMock({ porta: await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822) });
  edge = spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await conectar();
  for (const d of ['Page', 'Runtime', 'Log']) await cdp(d + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.addEventListener('securitypolicyviolation', (e) => console.error('VIOLAÇÃO CSP ' + e.violatedDirective + ' ' + e.blockedURI));` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });

  // pareia pela tela
  await cdp('Page.navigate', { url: mock.base + '/m' });
  await esperar(visivel('#v-parear'));
  await clicar('#par-pedir');
  await esperar(visivel('#par-f2'));
  const cod = (await (await fetch(mock.base + '/_mock/codigo')).json()).codigo;
  await digitar('#par-codigo', cod);
  conferir('pareou e abriu o app', await esperar(visivel('#v-principal')));

  conferir('Sessões continua como aba padrão', await esperar(`${Q('#aba-sessoes')}.getAttribute('aria-current') === 'page' && ${visivel('#p-sessoes')} && !${visivel('#p-visao')}`));
  conferir('"Visão geral" é a primeira aba da barra (4 abas)', await avaliar(`document.querySelector('.abas .aba').id === 'aba-visao' && document.querySelectorAll('.abas .aba').length === 4`));
  conferir('a aba tem ícone SVG e rótulo', await avaliar(`!!${Q('#aba-visao svg')} && /Visão geral/.test(${Q('#aba-visao')}.textContent)`));

  await clicar('#aba-visao');
  conferir('tocar na aba abre #visao com título "Visão geral"', await esperar(`location.hash === '#visao' && ${visivel('#p-visao')} && ${Q('#topo-tit')}.textContent === 'Visão geral' && ${Q('#aba-visao')}.getAttribute('aria-current') === 'page' && !${visivel('#p-sessoes')}`));
  conferir('os 4 widgets aparecem (projetos, sessões, contexto, uso)', await esperar(`document.querySelectorAll('#p-visao .wg').length === 4 && ['projetos','sessoes','contexto','uso'].every((k) => { const e = document.getElementById('wg-' + k); return !!e && e.getClientRects().length > 0; })`));

  // sessões
  conferir('sessões: rosca com o total do mock (6) e 5 linhas de legenda', await esperar(`${Q('#wg-sessoes .wg-rosca-centro b')}.textContent === '6' && document.querySelectorAll('#wg-sessoes .wg-leg li').length === 5`), await texto('#wg-sessoes'));
  conferir('sessões: precisa 3, trabalhando 1, novas 1, concluídas 1, encerradas 0', await avaliar(`['precisa:3','trabalhando:1','novas:1','concluidas:1','encerradas:0'].every((x) => { const [g, n] = x.split(':'); return document.querySelector('#wg-sessoes .wg-leg li[data-g=' + g + '] b').textContent === n; })`));
  conferir('sessões: 4 fatias desenhadas e "1 subagente ativo"', await avaliar(`document.querySelectorAll('#wg-sessoes .wg-rosca-seg').length === 4 && /1 subagente ativo/.test(${Q('#wg-sessoes .wg-sub')}.textContent)`), await texto('#wg-sessoes'));
  // contexto
  conferir('contexto: a mais cheia 75%, 3 linhas, "150k de 200k tokens"', await avaliar(`${Q('#wg-contexto .wg-grande')}.textContent === '75%' && document.querySelectorAll('#wg-contexto .wg-item').length === 3 && /150k de 200k tokens/.test(${Q('#wg-contexto .wg-item')}.textContent)`), await texto('#wg-contexto'));
  conferir('contexto: janela exata de 1M (400k de 1M) e "1 sessão com 70% ou mais"', await avaliar(`/400k de 1M tokens/.test(${Q('#wg-contexto')}.textContent) && /1 sessão com 70% ou mais/.test(${Q('#wg-contexto')}.textContent)`), await texto('#wg-contexto'));
  // uso
  conferir('uso do plano: 42% e 27% com renovação', await avaliar(`/42%/.test(${Q('#wg-uso')}.textContent) && /27%/.test(${Q('#wg-uso')}.textContent) && /renova em 2 h/.test(${Q('#wg-uso')}.textContent) && /renova em [23] d/.test(${Q('#wg-uso')}.textContent)`), await texto('#wg-uso'));
  conferir('uso do plano: leitura recente, sem selo "Estimado"', await avaliar(`${Q('#wg-uso-selo')}.hidden === true && /Lido há 2 min/.test(${Q('#wg-uso')}.textContent)`), await texto('#wg-uso'));
  // sem disco
  conferir('NÃO há widget de espaço em disco', await avaliar(`!/disco|armazenamento|\\bGB\\b/i.test(${Q('#p-visao')}.textContent) && !document.querySelector('#p-visao [id*=disco], #p-visao [class*=disco]')`), await texto('#p-visao'));
  conferir('sem rolagem lateral em 390 px', await semRolagemLateral());
  conferir('os cartões cabem na largura de 390 px', await avaliar(`[...document.querySelectorAll('#p-visao .wg')].every((e) => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 0.5; })`));
  // projetos
  conferir('projetos: card lista os 2 projetos do mock com contagem de sessões ativas', await esperar(`document.querySelectorAll('#wg-projetos .wg-proj').length === 2 && /Orbit.*2 sessões ativas/.test(${Q('#wg-projetos .wg-proj[data-pasta*="Orbit"]')}.textContent)`), await texto('#wg-projetos'));
  conferir('projetos: alvos de toque com pelo menos 44 px', await avaliar(`[...document.querySelectorAll('#wg-projetos .wg-proj')].every((e) => e.getBoundingClientRect().height >= 44)`));
  await foto('visao');
  await clicar('#wg-projetos .wg-proj[data-pasta*="Loja"]');
  conferir('projetos: tocar abre a nova instância com o projeto pré-selecionado', await esperar(`${visivel('#v-nova')} && ${Q('#nova-projeto')}.value.endsWith('Loja')`), await avaliar(`${Q('#nova-projeto')}.value`));
  await clicar('#nova-fechar');

  // dados novos aparecem ao voltar à aba
  await postMock('/_mock/mudar', { id: 's5', status: 'trabalhando' });
  await postMock('/_mock/uso', { cincoHoras: { pct: 91, renova: Date.now() + 40 * 60e3 }, semanal: { pct: 27, renova: Date.now() + 3 * 86400e3 }, atualizado: Date.now() });
  await clicar('#aba-sessoes');
  conferir('trocar para Sessões esconde a Visão geral', await esperar(`!${visivel('#p-visao')} && ${visivel('#p-sessoes')}`));
  await clicar('#aba-visao');
  conferir('voltar à aba relê os dados: trabalhando 2 e uso 91% "perto do limite"', await esperar(`${Q('#wg-sessoes .wg-leg li[data-g=trabalhando] b')}.textContent === '2' && /91%/.test(${Q('#wg-uso')}.textContent) && /perto do limite/.test(${Q('#wg-uso')}.textContent)`, 8000), await texto('#wg-uso'));
  await clicar('#aba-uso');
  conferir('as outras abas seguem funcionando (Uso)', await esperar(`location.hash === '#uso' && ${visivel('#p-uso')} && !${visivel('#p-visao')}`));

  // abrir direto pelo hash
  await cdp('Page.navigate', { url: 'about:blank' });
  await dormir(100);
  await cdp('Page.navigate', { url: mock.base + '/m#visao' });
  conferir('abrir direto por /m#visao mostra os 4 widgets', await esperar(`${visivel('#p-visao')} && document.querySelectorAll('#p-visao .wg').length === 4 && !document.getElementById('wg-sinc')`));

  // criar instâncias desligado: mensagem e nenhuma chamada à rota
  mock.estado.criarInstancias = false;
  mock.estado.chamadasProjetos = 0;
  await clicar('#aba-sessoes');
  await clicar('#aba-visao');
  conferir('criarInstancias desligado: card manda ligar "Criar instâncias" no PC, sem lista', await esperar(`/Criar instâncias/.test(${Q('#wg-projetos')}.textContent) && /Configurações do Orbit no PC/.test(${Q('#wg-projetos')}.textContent) && !${Q('#wg-projetos .wg-proj')}`), await texto('#wg-projetos'));
  conferir('criarInstancias desligado: não chamou /remoto/projetos', mock.estado.chamadasProjetos === 0, mock.estado.chamadasProjetos);
  await foto('visao-off');
  mock.estado.criarInstancias = true;

} catch (e) {
  conferir('exceção no teste', false, e?.stack || String(e));
} finally {
  try { ws?.close(); } catch {}
  if (edge) await fecharEdge(porta, perfil);
  try { await mock?.fechar(); } catch {}
  if (!arg) { try { fs.rmSync(SAIDA, { recursive: true, force: true }); } catch {} }
}

conferir('zero erros de console', consoleErros.length === 0, consoleErros.slice(0, 8));
conferir('zero violações de CSP', violacoes.length === 0, violacoes.slice(0, 8));
const falhas = checks.filter((c) => !c.ok);
for (const c of checks) console.log((c.ok ? 'ok   ' : 'FALHA') + ' ' + c.nome + (c.ok ? '' : '\n        ' + JSON.stringify(c.detalhe)));
console.log(`\n${checks.length - falhas.length}/${checks.length} conferências ok`);
process.exit(falhas.length ? 1 : 0);
