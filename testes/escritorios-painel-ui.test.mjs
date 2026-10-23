// Teste do painel de escritórios (assets/escritorios-painel.js) contra testes/escritorios-painel.html.
// Servidor de teste próprio (porta livre de 47822–47826): serve /assets e /testes, as rotas REAIS de escritorios.mjs
// com um controle falso (como testes/escritorios.test.mjs) e um /modelos falso. Edge headless mudo, perfil temporário
// apagado no fim. Cobre: criar, editar membros (adicionar/reordenar/remover), salvar, erro 400, duplicar, excluir
// (com confirmação e 409), acionar (202 e 429), pausar/liberar, gasto, SSE (atualizar) e Esc;
// e a API do canvas (abrirGaveta(modo,id,{canvas}), duplicar(id), excluir(id), onVoltar, onMudou) com a faixa escondida.
// node testes/escritorios-painel-ui.test.mjs        (CAPTURA=<arquivo.png> tira 1 captura da gaveta aberta)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { criarEscritorios } from '../escritorios.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-escritorios-painel-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-escritorios-painel-dados-'));
const PASTA_TRABALHO = path.join(TMP, 'projeto');
fs.mkdirSync(PASTA_TRABALHO, { recursive: true });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

// ───────── servidor de teste ─────────
const MODELOS = [
  { valor: 'default', modelo: 'claude-sonnet-x', nome: 'Padrão (Sonnet)', descricao: '', esforcos: ['low', 'medium', 'high'] },
  { valor: 'opus', modelo: 'claude-opus-x', nome: 'Opus', descricao: '', esforcos: ['low', 'medium', 'high', 'max'] },
  { valor: 'haiku', modelo: 'claude-haiku-x', nome: 'Haiku', descricao: '', esforcos: [] },
];
// Codex falso: `codexLigado` liga/desliga (rota 404 e codexAtivo) e a lista imita GET /codex/modelos.
let codexLigado = true;
const MODELOS_CODEX = [
  { valor: 'gpt-5-codex', modelo: 'gpt-5-codex', nome: 'GPT-5 Codex', descricao: '', esforcos: ['low', 'medium', 'high'], esforcoPadrao: 'medium', padrao: true },
  { valor: 'gpt-5-mini', modelo: 'gpt-5-mini', nome: 'GPT-5 Mini', descricao: '', esforcos: [], esforcoPadrao: '', padrao: false },
];
async function lerJSONCorpo(req, limite) {
  let tam = 0; const partes = [];
  for await (const c of req) { tam += c.length; if (tam > limite) { const e = new Error('corpo grande demais'); e.status = 413; throw e; } partes.push(c); }
  const bruto = Buffer.concat(partes).toString('utf8');
  try { return bruto.trim() ? JSON.parse(bruto) : {}; } catch { const e = new Error('JSON inválido'); e.status = 400; throw e; }
}
const ctl = {
  n: 0, teto: 99, sessoes: new Map(), ouvintes: [],
  async criarInstancia(b) {
    if (ctl.sessoes.size >= ctl.teto) { const e = new Error('Teto de instâncias de escritório atingido.'); e.status = 429; throw e; }
    const id = `sess-${++ctl.n}`; ctl.sessoes.set(id, { b, viva: true }); return { sessao: id, acao: {} };
  },
  enviarMensagem(id) { return !!ctl.sessoes.get(id)?.viva; },
  interromper() { return true; },
  encerrar(id) { const s = ctl.sessoes.get(id); if (s) s.viva = false; return true; },
  avisarLider(id) { return !!ctl.sessoes.get(id)?.viva; },
  ouvirResultado(fn) { ctl.ouvintes.push(fn); return () => { ctl.ouvintes = ctl.ouvintes.filter((x) => x !== fn); }; },
  estado(id) { return ctl.sessoes.has(id) ? { ocupada: false } : null; },
  resultado(id, r = {}) { for (const f of ctl.ouvintes) f(id, { custoUsd: 0, texto: '', erro: false, ...r }); },
};
const eventos = [];
let plano = 10;
const esc = criarEscritorios({
  pasta: path.join(TMP, 'escritorios'), raizOrbit: PROJ, porta: 47822, lerJSONCorpo, log: () => {},
  publicar: (tipo, d) => { if (tipo === 'escritorio') eventos.push(d); },
  alertar: () => {},
  sessao: () => null,
  usoPlano: () => ({ cincoHoras: { pct: plano } }),
  validarModelo: (m, e) => {
    const x = MODELOS.find((k) => k.valor === m);
    if (!x) return `Modelo desconhecido: ${m}.`;
    if (e && !x.esforcos.includes(e)) return `${x.nome} não aceita o esforço "${e}".`;
    return true;
  },
  codexAtivo: () => codexLigado,
  validarModeloCodex: (m, e) => {
    if (!m) return true;
    const x = MODELOS_CODEX.find((k) => k.valor === m);
    if (!x) return `Modelo desconhecido: ${m}. Use: ${MODELOS_CODEX.map((k) => k.valor).join(', ')}.`;
    if (e && !x.esforcos.includes(e)) return `${x.nome} não aceita o esforço "${e}".`;
    return true;
  },
  controle: ctl, atrasoFim: 0,
});

// Atrasos de teste: GET /escritorios/<id> por id (corrida entre aberturas da gaveta) e GET /modelos (desmontar no meio do pedido).
const atrasoGet = new Map();
let atrasoModelos = 0;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORTA = await escolherPorta(47825);
const srv = http.createServer(async (req, r2) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/modelos') {
      if (atrasoModelos) await dormir(atrasoModelos);
      r2.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      r2.end(JSON.stringify({ modelos: MODELOS, atualizado: Date.now() })); return;
    }
    if (req.method === 'GET' && url.pathname === '/codex/modelos') {
      if (!codexLigado) { r2.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); r2.end(JSON.stringify({ erro: 'Codex desligado.' })); return; }
      r2.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      r2.end(JSON.stringify({ modelos: MODELOS_CODEX, atualizado: Date.now() })); return;
    }
    if (url.pathname.startsWith('/escritorios')) {
      const mId = req.method === 'GET' && /^\/escritorios\/([^/]+)$/.exec(url.pathname);
      if (mId && atrasoGet.get(decodeURIComponent(mId[1]))) await dormir(atrasoGet.get(decodeURIComponent(mId[1])));
      if (await esc.tratar(req, r2, url)) return;
      r2.writeHead(404); r2.end(); return;
    }
    if (req.method !== 'GET') { r2.writeHead(405); r2.end(); return; }
    const alvo = path.resolve(PROJ, '.' + decodeURIComponent(url.pathname));
    if (!alvo.startsWith(PROJ + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { r2.writeHead(404); r2.end(); return; }
    r2.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(alvo).pipe(r2);
  } catch (e) { if (!r2.headersSent) r2.writeHead(500); r2.end(String(e?.message || e)); }
});
await new Promise((r) => srv.listen(PORTA, '127.0.0.1', r));
const URL_PAG = `http://127.0.0.1:${PORTA}/testes/escritorios-painel.html`;
const api = async (caminho) => (await fetch(`http://127.0.0.1:${PORTA}${caminho}`)).json();

let pcdp, ws;
try {
  pcdp = await escolherPorta(47826);
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) consoleErros.push(d.params.type + ': ' + d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon/.test(d.params.entry.url || '') && !/status of 4(00|03|04|09|29)/.test(d.params.entry.text)) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('avaliar: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + '\n' + expr.slice(0, 200));
    return r.result?.result?.value;
  };
  const esperar = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await av(expr)) return true; await dormir(40); } return false; };
  const tecla = async (key, code, vk) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };

  const lib = `
    window.gv = () => document.querySelector('.esc-pn-gaveta');
    window.btn = (t, raiz = document) => [...raiz.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent).trim() === t);
    window.rotulo = (t, raiz) => { raiz = raiz || gv(); const l = [...raiz.querySelectorAll('label')].find((x) => x.textContent.trim() === t); return l && document.getElementById(l.htmlFor); };
    window.def = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    window.cartoes = () => [...gv().querySelectorAll('.esc-pn-membro')];
    window.titulos = () => cartoes().map((c) => c.querySelector('.esc-pn-membro-tit').textContent + '/' + c.querySelector('.esc-pn-membro-id').textContent);
    window.opcoes = (s) => [...s.options].map((o) => o.textContent);
    window.barra = () => document.querySelector('.esc-pn-barra');
    window.selB = () => barra().querySelector('select');
    window.estado = () => ({ opts: opcoes(selB()), sel: selB().selectedOptions[0]?.textContent, status: barra().querySelector('.esc-pn-status').textContent,
      gasto: barra().querySelector('.esc-pn-gasto').textContent, nivel: barra().querySelector('.esc-pn-gasto').dataset.nivel, aviso: barra().querySelector('.esc-pn-aviso').hidden ? '' : barra().querySelector('.esc-pn-aviso-tx').textContent });
    true`;

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: URL_PAG });
  await esperar(`document.readyState === 'complete' && !!document.querySelector('.esc-pn-barra') && !!window.EscritoriosPainel`, 8000);
  await av(lib);
  let r;

  // ── 1. Estado vazio (nenhum escritório pré-definido) ──
  await esperar(`demo.selecionados.length > 0`);
  r = await av(`({ ...estado(), cfgOff: btn('Configurar').disabled, acionarOff: btn('Acionar').disabled, tarefaOff: barra().querySelector('input[type=text]').disabled,
    novo: !!btn('Novo escritório'), sels: demo.selecionados, pausaOculto: btn('Pausar').hidden, rotSel: !!barra().querySelector('label[for="' + selB().id + '"]') })`);
  conferir(r.opts.length === 1 && r.opts[0] === 'Nenhum escritório' && r.cfgOff && r.acionarOff && r.tarefaOff && r.novo && r.pausaOculto, 'sem escritórios: seletor vazio, Configurar/Acionar desabilitados, Pausar oculto', r);
  conferir(JSON.stringify(r.sels) === '[null]' && /Crie um escritório/.test(r.gasto) && r.rotSel, 'página recebe onSelecionar(null); o seletor tem rótulo', r);

  // ── 2. Gaveta "Novo escritório" ──
  await av(`btn('Novo escritório').click(); true`);
  await esperar(`!!gv()`);
  r = await av(`({ titulo: gv().querySelector('h2').textContent, foco: document.activeElement === rotulo('Nome'), dialogo: gv().getAttribute('role'),
    orqMod: opcoes(rotulo('Modelo', gv().querySelectorAll('fieldset')[1])), esfOff: rotulo('Esforço', gv().querySelectorAll('fieldset')[1]).disabled,
    padroes: [rotulo('Limite de convidados').value, rotulo('Por execução').value, rotulo('Por dia').value, rotulo('Aviso em % do orçamento').value],
    pastaPh: rotulo('Pasta de trabalho').placeholder, semDup: !btn('Duplicar') && !btn('Excluir'), criar: !!btn('Criar escritório'), membros: cartoes().length,
    semRotulo: [...gv().querySelectorAll('input,select,textarea')].filter((e) => !(e.getAttribute('aria-label') || (e.labels && e.labels.length))).length })`);
  conferir(r.titulo === 'Novo escritório' && r.foco && r.dialogo === 'dialog' && r.semDup && r.criar && r.membros === 0, 'gaveta nova: título, foco no nome, sem Duplicar/Excluir, sem membros', r);
  conferir(JSON.stringify(r.orqMod) === JSON.stringify(['Padrão da conta', 'Padrão (Sonnet)', 'Opus', 'Haiku']) && r.esfOff, 'modelos vêm de /modelos; esforço desabilitado sem modelo', r.orqMod);
  conferir(JSON.stringify(r.padroes) === JSON.stringify(['2', '2', '10', '80']) && /\\|\//.test(r.pastaPh), 'padrões: convidados 2, US$ 2 por execução, US$ 10 por dia, aviso 80%; campo de pasta com exemplo de caminho', r);
  conferir(r.semRotulo === 0, 'todo campo da gaveta tem rótulo', r.semRotulo);

  // ── 3. Erro 400 em texto claro ──
  await av(`btn('Criar escritório').click(); true`);
  await esperar(`!gv().querySelector('.esc-pn-erro').hidden`);
  r = await av(`({ erro: gv().querySelector('.esc-pn-erro').textContent, aberta: !!gv(), alerta: gv().querySelector('.esc-pn-erro').getAttribute('role'), salvar: btn('Criar escritório').disabled })`);
  conferir(/nome é obrigatório/i.test(r.erro) && r.aberta && r.alerta === 'alert' && !r.salvar, '400 do servidor aparece na gaveta ("O nome é obrigatório"), que continua aberta', r);
  await av(`def(rotulo('Nome'), 'Marketing'); def(rotulo('Função'), 'Cuida das campanhas'); def(rotulo('Pasta de trabalho'), 'Z:\\\\nao\\\\existe\\\\mesmo'); true`);
  await av(`btn('Criar escritório').click(); true`);
  await esperar(`/não existe/.test(gv().querySelector('.esc-pn-erro').textContent)`);
  r = await av(`gv().querySelector('.esc-pn-erro').textContent`);
  conferir(/não existe/.test(r), '400 de pasta inexistente aparece em texto claro', r);

  // ── 4. Orquestrador, membros: adicionar, reordenar, remover ──
  await av(`def(rotulo('Pasta de trabalho'), ${JSON.stringify(PASTA_TRABALHO)}); def(rotulo('Prompt do orquestrador'), 'Você lidera o marketing.'); true`);
  const orqF = `gv().querySelectorAll('fieldset')[1]`;
  await av(`def(rotulo('Modelo', ${orqF}), 'opus'); true`);
  r = await av(`({ esf: opcoes(rotulo('Esforço', ${orqF})), off: rotulo('Esforço', ${orqF}).disabled })`);
  conferir(JSON.stringify(r.esf) === JSON.stringify(['Padrão', 'low', 'medium', 'high', 'max']) && !r.off, 'escolher o modelo libera os esforços dele', r);
  await av(`def(rotulo('Esforço', ${orqF}), 'high'); def(rotulo('Nome do orquestrador'), 'Chefe'); true`);

  for (const [pap, pr] of [['Redator', 'Escreva textos.'], ['Revisor de Texto', 'Revise textos.'], ['Descartável', 'x']]) {
    await av(`btn('Adicionar membro').click(); true`);
    await av(`(() => { const c = cartoes().at(-1); def(rotulo('Rótulo', c), ${JSON.stringify(pap)}); def(rotulo('Prompt', c), ${JSON.stringify(pr)}); return true; })()`);
  }
  r = await av(`({ tit: titulos(), foco: document.activeElement === rotulo('Rótulo', cartoes().at(-1)), contador: gv().querySelector('.esc-pn-contador').textContent, vazio: gv().querySelector('.esc-pn-membros-vazio').hidden })`);
  conferir(JSON.stringify(r.tit) === JSON.stringify(['Redator/redator', 'Revisor de Texto/revisor-de-texto', 'Descartável/descartavel']) && r.foco && r.contador === '3 de 8' && r.vazio, 'membros novos: id sai do rótulo (sem acento), foco no rótulo, contador 3 de 8', r);
  // modelo do membro: Haiku (sem esforço)
  await av(`(() => { const c = cartoes()[1]; def(rotulo('Modelo', c), 'haiku'); return true; })()`);
  r = await av(`(() => { const c = cartoes()[1]; return { off: rotulo('Esforço', c).disabled, lbl: rotulo('Modelo', c).getAttribute('aria-label') }; })()`);
  conferir(r.off === true && /membro/.test(r.lbl), 'modelo sem esforço (Haiku) desabilita o esforço', r);
  // reordenar: Revisor sobe
  await av(`btn('Subir Revisor de Texto').click(); true`);
  r = await av(`({ tit: titulos(), foco: document.activeElement.getAttribute('aria-label'), primeiroSobeOff: cartoes()[0].querySelector('.esc-pn-mini').disabled })`);
  conferir(r.tit[0].startsWith('Revisor') && r.tit[1].startsWith('Redator') && r.primeiroSobeOff && /Revisor/.test(r.foco), 'reordenar: "Subir" move o membro e mantém o foco no botão', r);
  await av(`btn('Descer Revisor de Texto').click(); btn('Subir Revisor de Texto').click(); true`);
  r = await av(`titulos()`);
  conferir(r[0].startsWith('Revisor') && r[1].startsWith('Redator'), 'reordenar: descer e subir de novo volta à mesma ordem', r);
  // remover o 3º
  await av(`btn('Remover Descartável').click(); true`);
  r = await av(`({ tit: titulos(), contador: gv().querySelector('.esc-pn-contador').textContent })`);
  conferir(r.tit.length === 2 && r.contador === '2 de 8', 'remover membro', r);
  // limite de 8
  for (let i = 0; i < 6; i++) await av(`btn('Adicionar membro').click(); true`);
  r = await av(`({ n: cartoes().length, off: btn('Adicionar membro').disabled })`);
  conferir(r.n === 8 && r.off, 'no máximo 8 membros: "Adicionar membro" se desabilita', r);
  for (let i = 0; i < 6; i++) await av(`btn('Remover Novo membro').click(); true`);
  r = await av(`cartoes().length`);
  conferir(r === 2, 'removidos os 6 extras (rótulo "Novo membro")', r);

  // ── 5. Padrões de ação externa inválido → 400, depois válido → cria ──
  // (os extras viraram texto literal na revisão: o inválido agora é o texto longo demais, > 200)
  await av(`def(rotulo('Padrões extras'), 'terraform\\\\s+apply\\n' + 'x'.repeat(201) + '\\n\\n  deploy-prod  '); true`);
  await av(`btn('Criar escritório').click(); true`);
  await esperar(`/caracteres/.test(gv()?.querySelector('.esc-pn-erro')?.textContent || '')`);
  r = await av(`gv().querySelector('.esc-pn-erro').textContent`);
  conferir(/texto de ação externa tem de 1 a 200 caracteres/.test(r), '400 de padrão inválido aparece em texto claro', r);
  await av(`def(rotulo('Padrões extras'), 'terraform\\\\s+apply\\n\\n  deploy-prod  '); def(rotulo('Limite de convidados'), '3'); true`);
  await av(`btn('Criar escritório').click(); true`);
  await esperar(`!gv()`);
  await esperar(`estado().opts.includes('Marketing')`);
  r = await av(`({ ...estado(), sels: demo.selecionados, foco: document.activeElement.textContent })`);
  const lista1 = (await api('/escritorios')).escritorios;
  const idMkt = lista1[0]?.id;
  conferir(!r.sel || r.sel === 'Marketing', 'criar: gaveta fecha e o novo escritório fica selecionado', r);
  conferir(r.sels.at(-1) === idMkt && r.status === 'Ociosa' && /US\$ 0,00 de 2,00 \(execução\) · US\$ 0,00 de 10,00 \(dia\) · ≈ 0% do plano/.test(r.gasto), 'onSelecionar recebe o id novo; status Ociosa; gasto "US$ 0,00 de 2,00 (execução) · US$ 0,00 de 10,00 (dia) · ≈ 0% do plano"', r);
  const salvo = (await api(`/escritorios/${idMkt}`)).escritorio;
  conferir(salvo.nome === 'Marketing' && salvo.funcao === 'Cuida das campanhas' && salvo.pasta === PASTA_TRABALHO && salvo.orquestrador.nome === 'Chefe' && salvo.orquestrador.modelo === 'opus' && salvo.orquestrador.esforco === 'high'
    && salvo.convidados.limite === 3 && salvo.orcamento.porExecucaoUsd === 2 && salvo.orcamento.porDiaUsd === 10 && salvo.orcamento.avisoPct === 80
    && JSON.stringify(salvo.externas.extras) === JSON.stringify(['terraform\\s+apply', 'deploy-prod']), 'servidor guardou nome, função, pasta, orquestrador, convidados, orçamento e padrões extras', salvo);
  conferir(JSON.stringify(salvo.membros.map((m) => [m.id, m.papel, m.modelo, m.provedor])) === JSON.stringify([['revisor-de-texto', 'Revisor de Texto', 'haiku', 'claude'], ['redator', 'Redator', '', 'claude']]), 'servidor guardou os membros na ordem da gaveta', salvo.membros);

  // ── 6. Editar: campos preenchidos, 400 de aviso, salvar, remover membro ──
  await av(`btn('Configurar').click(); true`);
  await esperar(`!!gv()`);
  r = await av(`({ titulo: gv().querySelector('h2').textContent, nome: rotulo('Nome').value, pasta: rotulo('Pasta de trabalho').value, tit: titulos(), extras: rotulo('Padrões extras').value,
    orqModelo: rotulo('Modelo', gv().querySelectorAll('fieldset')[1]).value, orqEsf: rotulo('Esforço', gv().querySelectorAll('fieldset')[1]).value, lim: rotulo('Limite de convidados').value,
    abertos: [...gv().querySelectorAll('.esc-pn-membro-cab')].map((b) => b.getAttribute('aria-expanded')), dup: !!btn('Duplicar'), exc: !!btn('Excluir') })`);
  conferir(r.titulo === 'Configurar: Marketing' && r.nome === 'Marketing' && r.pasta === PASTA_TRABALHO && r.extras === 'terraform\\s+apply\ndeploy-prod' && r.orqModelo === 'opus' && r.orqEsf === 'high' && r.lim === '3' && r.dup && r.exc, 'editar: a gaveta vem preenchida e tem Duplicar/Excluir', r);
  conferir(r.tit.length === 2 && r.tit[0] === 'Revisor de Texto/revisor-de-texto' && r.abertos.every((a) => a === 'false'), 'editar: membros na ordem salva, recolhidos', r);
  await av(`gv().querySelector('.esc-pn-membro-cab').click(); true`);
  r = await av(`({ exp: gv().querySelector('.esc-pn-membro-cab').getAttribute('aria-expanded'), vis: !gv().querySelector('.esc-pn-membro-corpo').hidden, mod: rotulo('Modelo', cartoes()[0]).value, prompt: rotulo('Prompt', cartoes()[0]).value, idv: rotulo('Id do papel', cartoes()[0]).value })`);
  conferir(r.exp === 'true' && r.vis && r.mod === 'haiku' && r.prompt === 'Revise textos.' && r.idv === 'revisor-de-texto', 'clicar no membro o expande com os valores salvos', r);
  // captura da gaveta com o membro aberto (opcional)
  if (process.env.CAPTURA) {
    await av(`gv().querySelector('.esc-pn-gaveta-corpo').scrollTop = 330; true`);
    await dormir(400);
    const sh = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 1100 - 480, y: 0, width: 480, height: 760, scale: 0.8 } });
    fs.writeFileSync(process.env.CAPTURA, Buffer.from(sh.result.data, 'base64'));
  }
  await av(`def(rotulo('Aviso em % do orçamento'), '99'); btn('Salvar').click(); true`);
  await esperar(`!gv().querySelector('.esc-pn-erro').hidden`);
  r = await av(`gv().querySelector('.esc-pn-erro').textContent`);
  conferir(/50% a 95%/.test(r), 'editar: 400 do aviso fora da faixa aparece na gaveta', r);
  await av(`def(rotulo('Nome'), 'Marketing Pro'); def(rotulo('Aviso em % do orçamento'), '60'); def(rotulo('Por execução'), '2'); def(rotulo('Por dia'), '4.5'); btn('Remover Revisor de Texto').click(); true`);
  r = await av(`titulos()`);
  conferir(JSON.stringify(r) === JSON.stringify(['Redator/redator']), 'editar: remover o 1º membro mantém o outro', r);
  await av(`btn('Salvar').click(); true`);
  await esperar(`!gv()`);
  await esperar(`estado().sel === 'Marketing Pro'`);
  const salvo2 = (await api(`/escritorios/${idMkt}`)).escritorio;
  conferir(salvo2.nome === 'Marketing Pro' && salvo2.orcamento.avisoPct === 60 && salvo2.orcamento.porDiaUsd === 4.5 && salvo2.membros.length === 1 && salvo2.membros[0].id === 'redator' && salvo2.orquestrador.modelo === 'opus', 'salvar edição persiste nome, orçamento e membros', salvo2);
  r = await av(`estado()`);
  conferir(r.sel === 'Marketing Pro' && /de 4,50 \(dia\)/.test(r.gasto), 'a barra reflete o nome novo e o limite do dia (US$ 4,50)', r);

  // ── 7. Duplicar ──
  await av(`btn('Configurar').click(); true`);
  await esperar(`!!gv()`);
  await av(`btn('Duplicar').click(); true`);
  await esperar(`!gv() && estado().opts.length === 2`);
  r = await av(`estado()`);
  const lista2 = (await api('/escritorios')).escritorios;
  const idCopia = lista2.find((x) => x.id !== idMkt)?.id;
  conferir(r.opts.length === 2 && r.opts.includes('Marketing Pro (cópia)') && r.sel === 'Marketing Pro (cópia)' && idCopia && (await av(`demo.selecionados.at(-1)`)) === idCopia, 'duplicar: a cópia aparece e fica selecionada', r);

  // ── 8. Acionar: 429 (teto) e 202 ──
  ctl.teto = 0;
  await av(`(() => { const t = barra().querySelector('input[type=text]'); def(t, 'Faça a campanha de outubro'); return btn('Acionar').disabled; })()`);
  await av(`btn('Acionar').click(); true`);
  await esperar(`estado().aviso !== ''`);
  r = await av(`({ ...estado(), tarefa: barra().querySelector('input[type=text]').value, alerta: barra().querySelector('.esc-pn-aviso').getAttribute('role') })`);
  conferir(/Teto de instâncias/.test(r.aviso) && r.status === 'Ociosa' && r.tarefa === 'Faça a campanha de outubro' && r.alerta === 'alert', 'acionar com teto cheio: 429 aparece em texto claro; status segue Ociosa e a tarefa fica no campo', r);
  ctl.teto = 99;
  await av(`btn('Acionar').click(); true`);
  await esperar(`estado().status.startsWith('Rodando')`);
  r = await av(`({ ...estado(), tarefa: barra().querySelector('input[type=text]').value, acionarOff: btn('Acionar').disabled, pausa: btn('Pausar') && !btn('Pausar').hidden })`);
  conferir(r.status.startsWith('Rodando') && r.tarefa === '' && r.acionarOff && r.pausa && /Execução iniciada/.test(r.aviso), 'acionar (202): status Rodando, campo limpo, Acionar desabilitado, Pausar disponível', r);
  const det = await api(`/escritorios/${idCopia}`);
  conferir(det.execucao.status === 'rodando' && det.execucao.tarefa === 'Faça a campanha de outubro' && det.execucao.origem === 'manual', 'servidor registrou a execução manual com a tarefa', det.execucao);

  // ── 9. Pausar / Liberar ──
  await av(`btn('Pausar').click(); true`);
  await esperar(`/\(manual\)/.test(estado().status)`);
  r = await av(`({ ...estado(), liberar: !!btn('Liberar') && !btn('Liberar').hidden })`);
  conferir(/^Pausada \(manual\)/.test(r.status) && r.liberar, 'Pausar: status "Pausada (manual)" e botão vira Liberar', r);
  await av(`btn('Liberar').click(); true`);
  await esperar(`estado().status.startsWith('Rodando')`);
  r = await av(`({ ...estado(), pausar: !!btn('Pausar') && !btn('Pausar').hidden })`);
  conferir(r.status.startsWith('Rodando') && r.pausar, 'Liberar: volta a Rodando e o botão vira Pausar', r);

  // ── 10. Excluir rodando → 409 ──
  await av(`btn('Configurar').click(); true`);
  await esperar(`!!gv()`);
  await av(`btn('Excluir').click(); true`);
  r = await av(`({ conf: !gv().querySelector('.esc-pn-confirma').hidden, tx: gv().querySelector('.esc-pn-confirma-tx').textContent, foco: document.activeElement.textContent, btns: [...gv().querySelectorAll('.esc-pn-confirma button')].map((b) => b.textContent) })`);
  conferir(r.conf && /Excluir "Marketing Pro \(cópia\)"\?/.test(r.tx) && r.foco === 'Manter' && r.btns.join() === 'Manter,Excluir de vez', 'excluir pede confirmação (foco em "Manter")', r);
  await av(`btn('Excluir de vez').click(); true`);
  await esperar(`!gv().querySelector('.esc-pn-erro').hidden`);
  r = await av(`({ erro: gv().querySelector('.esc-pn-erro').textContent, aberta: !!gv(), opts: estado().opts.length })`);
  conferir(/pause antes de excluir/.test(r.erro) && r.aberta && r.opts === 2, 'excluir rodando: 409 em texto claro e nada some', r);

  // ── 11. Esc fecha a gaveta e devolve o foco ──
  await tecla('Escape', 'Escape', 27);
  await esperar(`!gv()`);
  r = await av(`({ aberta: !!gv(), foco: document.activeElement.textContent })`);
  conferir(!r.aberta && r.foco === 'Configurar', 'Esc fecha a gaveta e o foco volta para "Configurar"', r);

  // ── 12. Gasto, aviso e orçamento: eventos SSE repassados a atualizar() ──
  const sessaoOrq = (await api(`/escritorios/${idCopia}`)).execucao.orquestrador;
  plano = 15;
  ctl.resultado(sessaoOrq, { custoUsd: 1.7 }); // 1,70 de 2,00 = 85% (aviso em 60%)
  await esc.aguardar();
  const ultimo = () => eventos.filter((e) => e.id === idCopia).at(-1);
  await av(`EscritoriosPainel.atualizar(${JSON.stringify(ultimo())}); true`);
  await esperar(`/US\\$ 1,70/.test(estado().gasto)`);
  r = await av(`estado()`);
  conferir(/US\$ 1,70 de 2,00 \(execução\) · US\$ 1,70 de 4,50 \(dia\) · ≈ \d+% do plano/.test(r.gasto) && r.nivel === '1', 'SSE: gasto "US$ 1,70 de 2,00 (execução) · US$ 1,70 de 4,50 (dia)" e nível de aviso', r);
  conferir(/≈ [1-9]\d*% do plano/.test(r.gasto), 'gasto mostra a % estimada do plano (> 0)', r.gasto);
  ctl.resultado(sessaoOrq, { custoUsd: 2.0 }); // 100% da execução → pausa por orçamento
  await esc.aguardar();
  await av(`EscritoriosPainel.atualizar(${JSON.stringify(ultimo())}); true`);
  await esperar(`/orçamento da execução/.test(estado().status)`);
  r = await av(`({ ...estado(), liberar: !!btn('Liberar') && !btn('Liberar').hidden })`);
  conferir(/^Pausada \(orçamento da execução\)/.test(r.status) && r.nivel === '2' && r.liberar, 'SSE: orçamento esgotado vira "Pausada (orçamento da execução)", nível crítico e botão Liberar', r);
  // 429 de "liberar" não existe; o 409 do dia aparece como texto: libera a execução pelo botão
  await av(`btn('Liberar').click(); true`);
  await esperar(`estado().status.startsWith('Rodando') || estado().aviso !== ''`);
  r = await av(`estado()`);
  conferir(r.status.startsWith('Rodando') || r.aviso !== '', 'Liberar após orçamento: responde (Rodando ou o motivo em texto)', r);

  // ── 12b. Alerta de orçamento no evento: faixa âmbar/vermelha + Notification (só com permissão já concedida) ──
  await av(`window.__notifs = []; window.Notification = class { constructor(t, o) { this.titulo = t; this.opts = o; window.__notifs.push(this); } close() {} }; Notification.permission = 'granted'; true`);
  const resMkt = (await api('/escritorios')).escritorios.find((x) => x.id === idMkt);
  const faixa = () => `(() => { const a = barra().querySelector('.esc-pn-aviso'); return { visivel: !a.hidden, tipo: a.dataset.tipo, texto: a.querySelector('.esc-pn-aviso-tx').textContent, cor: getComputedStyle(a).borderTopColor }; })()`;
  await av(`EscritoriosPainel.atualizar(${JSON.stringify({ id: idMkt, resumo: resMkt, alerta: { tipo: 'aviso', texto: 'Orçamento do escritório em 85%.' } })}); true`);
  r = await av(`({ f: ${faixa()}, n: __notifs.length, corpo: __notifs[0]?.opts?.body })`);
  conferir(r.f.visivel && r.f.tipo === 'aviso' && /85%/.test(r.f.texto) && r.n === 1 && /85%/.test(r.corpo), 'alerta "aviso": faixa visível (tipo aviso) com o texto e uma Notification', r);
  const corAviso = r.f.cor;
  await av(`EscritoriosPainel.atualizar(${JSON.stringify({ id: idMkt, resumo: resMkt, alerta: { tipo: 'pausa', texto: 'Escritório pausado (orçamento).' } })}); true`);
  r = await av(`({ f: ${faixa()}, n: __notifs.length })`);
  conferir(r.f.visivel && r.f.tipo === 'pausa' && /pausado/.test(r.f.texto) && r.n === 2 && r.f.cor !== corAviso, 'alerta "pausa": faixa vermelha (cor diferente da âmbar), permanece e gera outra Notification', r);
  await av(`EscritoriosPainel.selecionar(${JSON.stringify(idCopia)}); true`);
  await esperar(`demo.selecionados.at(-1) === ${JSON.stringify(idCopia)}`);
  await av(`window.focus = () => { window.__foco = true; }; __notifs.at(-1).onclick(); true`);
  await esperar(`demo.selecionados.at(-1) === ${JSON.stringify(idMkt)}`);
  r = await av(`({ sel: demo.selecionados.at(-1), foco: !!window.__foco })`);
  conferir(r.sel === idMkt && r.foco, 'clique na Notification foca a janela e seleciona o escritório do alerta', r);
  await av(`Notification.permission = 'default'; __notifs.length = 0; EscritoriosPainel.atualizar(${JSON.stringify({ id: idMkt, resumo: resMkt, alerta: { tipo: 'aviso', texto: 'Sem permissão.' } })}); true`);
  r = await av(`({ f: ${faixa()}, n: __notifs.length, pedido: typeof Notification.requestPermission })`);
  conferir(r.f.tipo === 'aviso' && r.f.texto === 'Sem permissão.' && r.n === 0, 'sem permissão concedida: só a faixa, nenhuma Notification (e não pede permissão)', r);
  await av(`EscritoriosPainel.selecionar(${JSON.stringify(idCopia)}); true`);
  await esperar(`demo.selecionados.at(-1) === ${JSON.stringify(idCopia)}`);

  // ── 13. SSE de exclusão remove o escritório e seleciona o outro ──
  await av(`EscritoriosPainel.atualizar({ id: ${JSON.stringify(idCopia)}, resumo: null }); true`);
  await esperar(`estado().opts.length === 1`);
  r = await av(`({ ...estado(), sel: demo.selecionados.at(-1) })`);
  conferir(r.opts.length === 1 && r.opts[0] === 'Marketing Pro' && r.sel === idMkt, 'SSE resumo:null remove da lista e a página recebe o outro id', r);

  // ── 14. Excluir de verdade (ocioso) ──
  await av(`btn('Configurar').click(); true`);
  await esperar(`!!gv()`);
  await av(`btn('Excluir').click(); btn('Manter').click(); true`);
  r = await av(`({ conf: gv().querySelector('.esc-pn-confirma').hidden, botoes: !gv().querySelector('.esc-pn-rodape-btns').hidden })`);
  conferir(r.conf && r.botoes, 'excluir: "Manter" desfaz a confirmação', r);
  await av(`btn('Excluir').click(); btn('Excluir de vez').click(); true`);
  await esperar(`!gv()`);
  await esperar(`estado().opts[0] === 'Nenhum escritório'`);
  const lista3 = (await api('/escritorios')).escritorios.filter((x) => x.id === idMkt);
  r = await av(`({ ...estado(), sels: demo.selecionados.at(-1) })`);
  conferir(r.opts[0] === 'Nenhum escritório' && lista3.length === 0 && r.sels === null, 'excluir (confirmado): some do servidor e da barra; a página recebe null', { r, lista3 });

  // ── 14b. API ampliada (canvas): abrirGaveta(modo, id, opcoes), duplicar(id), excluir(id), onVoltar e onMudou — tudo com a faixa escondida ──
  const post = async (caminho, corpo) => { const rr = await fetch(`http://127.0.0.1:${PORTA}${caminho}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo || {}) }); return { status: rr.status, j: await rr.json().catch(() => ({})) }; };
  const base = (nome) => ({ nome, funcao: 'Teste da API', pasta: PASTA_TRABALHO, orquestrador: { nome: 'Chefe', prompt: 'Você lidera.' }, membros: [] });
  await post(`/escritorios/${idCopia}/pausar`); // a cópia do bloco 7 ainda existe no servidor (o 13 só a tirou da barra)
  await post(`/escritorios/${idCopia}/excluir`);
  r = await av(`!btn('← Escritórios')`);
  conferir(r === true, 'sem onVoltar, a faixa não tem o botão "← Escritórios"', r);
  await av(`EscritoriosPainel.desmontar(); window.mud = []; window.vol = 0; window.__r = undefined; demo.selecionados.length = 0;
    EscritoriosPainel.montar(document.getElementById('raiz'), { base: '', onSelecionar: (id) => demo.selecionados.push(id), onVoltar: () => { vol++; }, onMudou: (e) => mud.push(e) }); true`);
  await esperar(`!!barra() && demo.selecionados.length > 0`);
  const idAlfa = (await post('/escritorios', base('Alfa'))).j.escritorio?.id;
  const idBeta = (await post('/escritorios', base('Beta'))).j.escritorio?.id;
  await av(`EscritoriosPainel.atualizar(); true`);
  await esperar(`estado().opts.length === 2`);
  await av(`document.getElementById('raiz').style.display = 'none'; true`);
  r = await av(`({ larg: barra().getBoundingClientRect().width, voltar: !!btn('← Escritórios'), primeiro: barra().querySelector('.esc-pn-linha').firstElementChild.textContent, sel: demo.selecionados.at(-1) })`);
  conferir(r.larg === 0 && r.voltar && r.primeiro === '← Escritórios' && r.sel === idAlfa, 'com onVoltar o botão "← Escritórios" abre a faixa; a faixa fica escondida e Alfa é o selecionado', r);
  await av(`btn('← Escritórios').click(); true`);
  r = await av(`vol`);
  conferir(r === 1, 'clicar em "← Escritórios" chama onVoltar', r);

  // abrirGaveta('editar', id) com OUTRO escritório selecionado
  r = await av(`EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idBeta)})`);
  r = { ...(await av(`({ titulo: gv()?.querySelector('h2').textContent, nome: rotulo('Nome')?.value, sel: demo.selecionados.at(-1), dup: !!btn('Duplicar') })`)), abriu: r };
  conferir(r.abriu === true && r.titulo === 'Configurar: Beta' && r.nome === 'Beta' && r.sel === idAlfa && r.dup, 'abrirGaveta("editar", id) edita esse escritório sem trocar o selecionado (faixa escondida)', r);
  await av(`def(rotulo('Nome'), 'Beta 2'); btn('Salvar').click(); true`);
  await esperar(`!gv() && mud.length === 1`);
  const salvoB = (await api(`/escritorios/${idBeta}`)).escritorio;
  r = await av(`({ mud, sel: demo.selecionados.at(-1) })`);
  conferir(salvoB.nome === 'Beta 2' && JSON.stringify(r.mud) === JSON.stringify([{ tipo: 'salvo', id: idBeta }]) && r.sel === idAlfa, 'salvar a edição grava no id certo, chama onMudou {salvo} e o selecionado continua sendo Alfa', { salvoB: salvoB.nome, ...r });
  r = await av(`EscritoriosPainel.abrirGaveta('editar', 'nao-existe')`);
  conferir(r === false && (await av(`!gv()`)), 'abrirGaveta("editar") com id inexistente não abre e devolve false', r);

  // abrirGaveta('novo', undefined, {canvas}) grava a posição
  r = await av(`EscritoriosPainel.abrirGaveta('novo', undefined, { canvas: { x: 240, y: 160 } })`);
  await av(`def(rotulo('Nome'), 'No canvas'); def(rotulo('Função'), 'Criado pelo canvas'); def(rotulo('Pasta de trabalho'), ${JSON.stringify(PASTA_TRABALHO)}); def(rotulo('Prompt do orquestrador'), 'Você lidera.'); btn('Criar escritório').click(); true`);
  await esperar(`!gv() && mud.length === 2`);
  const idCanvas = (await api('/escritorios')).escritorios.find((x) => x.nome === 'No canvas')?.id;
  const salvoC = idCanvas ? (await api(`/escritorios/${idCanvas}`)).escritorio : null;
  r = await av(`mud.at(-1)`);
  conferir(salvoC && salvoC.canvas && salvoC.canvas.x === 240 && salvoC.canvas.y === 160 && r.tipo === 'criado' && r.id === idCanvas, 'abrirGaveta("novo", _, {canvas}) envia canvas no POST e chama onMudou {criado}', { canvas: salvoC?.canvas, r });
  r = await av(`EscritoriosPainel.abrirGaveta('novo')`);
  await av(`def(rotulo('Nome'), 'Sem posição'); def(rotulo('Pasta de trabalho'), ${JSON.stringify(PASTA_TRABALHO)}); def(rotulo('Prompt do orquestrador'), 'x'); btn('Criar escritório').click(); true`);
  await esperar(`!gv() && mud.length === 3`);
  const semPos = (await api('/escritorios')).escritorios.find((x) => x.nome === 'Sem posição');
  const semPosDet = (await api(`/escritorios/${semPos.id}`)).escritorio;
  conferir(!semPosDet.canvas || (semPosDet.canvas.x === 0 && semPosDet.canvas.y === 0), 'abrirGaveta("novo") sem canvas não envia posição (fica na padrão)', semPosDet.canvas);

  // duplicar(id) pela API
  const nAntes = (await api('/escritorios')).escritorios.length;
  const dup = await av(`EscritoriosPainel.duplicar(${JSON.stringify(idAlfa)}).then((x) => ({ id: x.id, nome: x.nome }))`);
  r = await av(`({ mud: mud.at(-1), sel: demo.selecionados.at(-1), opts: estado().opts })`);
  const nDepois = (await api('/escritorios')).escritorios.length;
  conferir(dup.nome === 'Alfa (cópia)' && nDepois === nAntes + 1 && r.mud.tipo === 'duplicado' && r.mud.id === dup.id && r.sel !== dup.id && r.opts.includes('Alfa (cópia)'),
    'duplicar(id) devolve o resumo da cópia, cria no servidor, chama onMudou {duplicado, id da cópia} e não troca o selecionado', { dup, nAntes, nDepois, ...r });
  r = await av(`EscritoriosPainel.duplicar('nao-existe').then(() => 'resolveu', (e) => e.status)`);
  conferir(r === 404, 'duplicar de id inexistente rejeita com o status do servidor (404)', r);

  // excluir(id) pela API: diálogo, Manter, Esc, Excluir de vez
  const dlg = () => `(() => { const d = document.querySelector('.esc-pn-dialogo'); return d ? { tx: d.querySelector('.esc-pn-dialogo-tx').textContent, btns: [...d.querySelectorAll('button')].map((b) => b.textContent), foco: document.activeElement.textContent, erro: d.querySelector('.esc-pn-erro').hidden ? '' : d.querySelector('.esc-pn-erro').textContent, papel: d.firstElementChild.getAttribute('role') } : null; })()`;
  const excluirApi = (id) => av(`window.__r = undefined; EscritoriosPainel.excluir(${JSON.stringify(id)}).then((v) => { window.__r = v; }); true`);
  const nMud = (await av(`mud.length`));
  await excluirApi(dup.id);
  await esperar(`!!document.querySelector('.esc-pn-dialogo')`);
  r = await av(dlg());
  conferir(r && r.papel === 'alertdialog' && r.foco === 'Manter' && r.btns.join() === 'Manter,Excluir de vez' && r.tx === 'Excluir "Alfa (cópia)"? O cadastro e o gasto do dia somem; as notas na pasta de trabalho ficam. Não dá para desfazer.', 'excluir(id) abre o diálogo próprio com o mesmo texto e os botões Manter / Excluir de vez (foco em Manter)', r);
  await av(`btn('Manter').click(); true`);
  await esperar(`window.__r !== undefined`);
  r = await av(`({ r: window.__r, aberto: !!document.querySelector('.esc-pn-dialogo'), mud: mud.length })`);
  conferir(r.r === false && !r.aberto && r.mud === nMud && (await api('/escritorios')).escritorios.some((x) => x.id === dup.id), '"Manter" resolve false, fecha o diálogo e nada é excluído', r);
  await excluirApi(dup.id);
  await esperar(`!!document.querySelector('.esc-pn-dialogo')`);
  await tecla('Escape', 'Escape', 27);
  await esperar(`window.__r !== undefined`);
  r = await av(`({ r: window.__r, aberto: !!document.querySelector('.esc-pn-dialogo') })`);
  conferir(r.r === false && !r.aberto, 'Esc no diálogo resolve false', r);
  // gaveta da cópia aberta + diálogo: Esc fecha só o diálogo; confirmar fecha a gaveta
  await av(`EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(dup.id)})`);
  await excluirApi(dup.id);
  await esperar(`!!document.querySelector('.esc-pn-dialogo')`);
  await tecla('Escape', 'Escape', 27);
  await esperar(`window.__r !== undefined`);
  r = await av(`({ gaveta: !!gv(), dialogo: !!document.querySelector('.esc-pn-dialogo') })`);
  conferir(r.gaveta && !r.dialogo, 'Esc com a gaveta aberta fecha só o diálogo de exclusão', r);
  await excluirApi(dup.id);
  await esperar(`!!document.querySelector('.esc-pn-dialogo')`);
  await av(`btn('Excluir de vez').click(); true`);
  await esperar(`window.__r !== undefined`);
  r = await av(`({ r: window.__r, gaveta: !!gv(), dialogo: !!document.querySelector('.esc-pn-dialogo'), mud: mud.at(-1), opts: estado().opts })`);
  conferir(r.r === true && !r.gaveta && !r.dialogo && r.mud.tipo === 'excluido' && r.mud.id === dup.id && !r.opts.includes('Alfa (cópia)') && !(await api('/escritorios')).escritorios.some((x) => x.id === dup.id),
    '"Excluir de vez" resolve true, apaga no servidor, fecha a gaveta daquele id e chama onMudou {excluido}', r);
  // 409: escritório rodando → o erro aparece no diálogo
  const ac = await post(`/escritorios/${idBeta}/acionar`, { tarefa: 'Rodar', origem: 'manual' });
  await excluirApi(idBeta);
  await esperar(`!!document.querySelector('.esc-pn-dialogo')`);
  await av(`btn('Excluir de vez').click(); true`);
  await esperar(`!document.querySelector('.esc-pn-dialogo .esc-pn-erro').hidden`);
  r = await av(dlg());
  conferir(ac.status === 202 && r && /pause antes de excluir/.test(r.erro) && r.foco === 'Manter', 'excluir(id) de um escritório rodando mostra o 409 do servidor no diálogo, que continua aberto', { ac: ac.status, r });
  await av(`btn('Manter').click(); true`);
  await esperar(`window.__r !== undefined`);
  r = await av(`({ r: window.__r, mud: mud.map((e) => e.tipo) })`);
  conferir(r.r === false && (await api('/escritorios')).escritorios.some((x) => x.id === idBeta), 'depois do 409, "Manter" resolve false e o escritório segue lá', r);
  r = await av(`mud.map((e) => e.tipo).sort().join()`);
  conferir(r === 'criado,criado,duplicado,excluido,salvo', 'onMudou recebeu exatamente criado, salvo, duplicado e excluido (nada nas ações que falharam ou foram canceladas)', r);
  await av(`document.getElementById('raiz').style.display = ''; true`);

  // ── 14c. Membro do Codex: seletor IA, listas, desligado, salvar, "≈" ──
  const orqC = `gv().querySelectorAll('fieldset')[1]`;
  const cartaoIA = `(c) => ({ ia: opcoes(rotulo('IA', c)), val: rotulo('IA', c).value, off: [...rotulo('IA', c).options].map((o) => o.disabled), mods: opcoes(rotulo('Modelo', c)), esfs: opcoes(rotulo('Esforço', c)),
    selo: c.querySelector('.esc-pn-selo')?.textContent || '', aviso: (() => { const a = c.querySelector('.esc-pn-aviso-ia'); return a && !a.hidden ? a.textContent : ''; })() })`;
  await av(`EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idAlfa)})`);
  await esperar(`!!gv()`);
  await av(`btn('Adicionar membro').click(); true`);
  await esperar(`!rotulo('IA', cartoes().at(-1)).options[1].disabled`);
  await av(`(() => { const c = cartoes().at(-1); def(rotulo('Rótulo', c), 'Pesquisador'); def(rotulo('Prompt', c), 'Pesquise.'); return true; })()`);
  r = await av(`({ ...(${cartaoIA})(cartoes().at(-1)), semIaOrq: !rotulo('IA', ${orqC}), orqMods: opcoes(rotulo('Modelo', ${orqC})) })`);
  conferir(JSON.stringify(r.ia) === '["Claude","Codex"]' && r.val === 'claude' && r.off[1] === false && r.selo === '' && r.aviso === '' && JSON.stringify(r.mods) === JSON.stringify(['Padrão da conta', 'Padrão (Sonnet)', 'Opus', 'Haiku']),
    'cartão do membro: seletor IA Claude | Codex (padrão Claude, Codex habilitado), lista do Claude, sem selo', r);
  conferir(r.semIaOrq === true && JSON.stringify(r.orqMods) === JSON.stringify(['Padrão da conta', 'Padrão (Sonnet)', 'Opus', 'Haiku']), 'o orquestrador não tem a opção IA (sempre Claude)', r);
  await av(`(() => { const c = cartoes().at(-1); def(rotulo('Modelo', c), 'opus'); def(rotulo('IA', c), 'codex'); return true; })()`);
  r = await av(`(${cartaoIA})(cartoes().at(-1))`);
  conferir(r.val === 'codex' && JSON.stringify(r.mods) === JSON.stringify(['Padrão do Codex', 'GPT-5 Codex', 'GPT-5 Mini']) && JSON.stringify(r.esfs) === JSON.stringify(['Padrão']) && r.selo === 'Codex',
    'IA = Codex troca para a lista do Codex (modelo volta ao padrão), mostra o selo "Codex" no título', r);
  await av(`(() => { const c = cartoes().at(-1); def(rotulo('Modelo', c), 'gpt-5-codex'); return true; })()`);
  r = await av(`(${cartaoIA})(cartoes().at(-1))`);
  conferir(JSON.stringify(r.esfs) === JSON.stringify(['Padrão', 'low', 'medium', 'high']), 'modelo do Codex libera os esforços dele', r);
  await av(`(() => { const c = cartoes().at(-1); def(rotulo('IA', c), 'claude'); return true; })()`);
  r = await av(`(${cartaoIA})(cartoes().at(-1))`);
  conferir(r.val === 'claude' && r.selo === '' && r.mods.includes('Opus') && !r.mods.includes('GPT-5 Codex'), 'voltar para Claude traz a lista do Claude de volta e some o selo', r);
  // erro do servidor ao salvar: o Codex é desligado com a gaveta aberta
  await av(`(() => { const c = cartoes().at(-1); def(rotulo('IA', c), 'codex'); def(rotulo('Modelo', c), 'gpt-5-codex'); def(rotulo('Esforço', c), 'high'); return true; })()`);
  codexLigado = false;
  await av(`btn('Salvar').click(); true`);
  await esperar(`!gv().querySelector('.esc-pn-erro').hidden`);
  r = await av(`({ erro: gv().querySelector('.esc-pn-erro').textContent, aberta: !!gv() })`);
  conferir(/O Codex está desligado nas Configurações/.test(r.erro) && r.aberta, 'salvar membro Codex com o Codex desligado: o 400 do servidor aparece na gaveta, que continua aberta', r);
  codexLigado = true;
  await av(`btn('Salvar').click(); true`);
  await esperar(`!gv()`);
  const salvoA = (await api(`/escritorios/${idAlfa}`)).escritorio;
  const mp = salvoA.membros.find((x) => x.id === 'pesquisador');
  conferir(mp && mp.provedor === 'codex' && mp.modelo === 'gpt-5-codex' && mp.esforco === 'high', 'salvar membro Codex grava provedor "codex" com modelo e esforço', mp);
  // reabrir: o membro salvo volta como Codex, com selo
  await av(`EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idAlfa)})`);
  await esperar(`!!gv() && cartoes().length === 1 && cartoes()[0].querySelector('.esc-pn-membro-tit')`);
  await esperar(`opcoes(rotulo('Modelo', cartoes()[0])).includes('GPT-5 Codex')`);
  r = await av(`({ ...(${cartaoIA})(cartoes()[0]), mod: rotulo('Modelo', cartoes()[0]).value, esf: rotulo('Esforço', cartoes()[0]).value, ordem: titulos() })`);
  conferir(r.val === 'codex' && r.selo === 'Codex' && r.mod === 'gpt-5-codex' && r.esf === 'high', 'membro Codex salvo reabre com IA Codex, modelo, esforço e selo', r);
  await av(`gv().querySelector('.esc-pn-x').click(); true`);
  await esperar(`!gv()`);
  // Codex desligado (404 em /codex/modelos): opção desabilitada com a explicação; membro Codex salvo continua visível e avisado
  codexLigado = false;
  await av(`EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idAlfa)})`);
  await esperar(`!!gv()`);
  await av(`btn('Adicionar membro').click(); true`);
  await esperar(`/desligado/.test(cartoes().at(-1).querySelector('.esc-pn-aviso-ia').textContent) && !cartoes().at(-1).querySelector('.esc-pn-aviso-ia').hidden`);
  r = await av(`({ novo: (${cartaoIA})(cartoes().at(-1)), salvo: (${cartaoIA})(cartoes()[0]) })`);
  conferir(r.novo.off[1] === true && r.novo.val === 'claude' && /O Codex está desligado nas Configurações: ligue-o para usar membros do Codex\./.test(r.novo.aviso),
    'Codex desligado: a opção Codex fica desabilitada no membro novo, com a explicação do contrato', r.novo);
  conferir(r.salvo.val === 'codex' && r.salvo.selo === 'Codex' && /desligado/.test(r.salvo.aviso) && r.salvo.mods.includes('gpt-5-codex'), 'Codex desligado: o membro Codex já salvo continua visível (selo, modelo salvo) com o aviso', r.salvo);
  await av(`gv().querySelector('.esc-pn-x').click(); true`);
  await esperar(`!gv()`);
  codexLigado = true;
  // gasto estimado: "≈" nos valores em US$ e title explicando
  const resAlfa = (await api('/escritorios')).escritorios.find((x) => x.id === idAlfa);
  const comCusto = (estimado) => ({ id: idAlfa, resumo: { ...resAlfa, custo: { ...resAlfa.custo, execucaoUsd: 1.2, diaUsd: 1.5, limiteExecucaoUsd: 2, limiteDiaUsd: 10, planoPct: 12, ...(estimado ? { estimado: true } : {}) } } });
  await av(`EscritoriosPainel.selecionar(${JSON.stringify(idAlfa)}); true`);
  await esperar(`selB().value === ${JSON.stringify(idAlfa)}`);
  await av(`EscritoriosPainel.atualizar(${JSON.stringify(comCusto(true))}); true`);
  await esperar(`/1,20/.test(estado().gasto)`);
  r = await av(`({ g: estado().gasto, t: barra().querySelector('.esc-pn-gasto').title, sel: selB().value, idAlfa: ${JSON.stringify(idAlfa)} })`);
  conferir(/^≈ US\$ 1,20 de 2,00 \(execução\) · ≈ US\$ 1,50 de 10,00 \(dia\)/.test(r.g) && /estimativa do Codex pelos tokens/i.test(r.t), 'custo.estimado: a faixa mostra "≈ US$" nos valores e o title explica a estimativa do Codex', r);
  await av(`EscritoriosPainel.atualizar(${JSON.stringify(comCusto(false))}); true`);
  await esperar(`!/≈ US/.test(estado().gasto)`);
  r = await av(`({ g: estado().gasto, t: barra().querySelector('.esc-pn-gasto').title })`);
  conferir(/^US\$ 1,20 de 2,00 \(execução\) · US\$ 1,50 de 10,00 \(dia\)/.test(r.g) && r.t === '', 'sem estimado: sem "≈" nos valores e sem title', r);

  // "≈" por linha: estimadoExecucao/estimadoDia (booleanos) mandam sobre `estimado`
  const comLinhas = (ex) => { const o = comCusto(false); o.resumo.custo = { ...o.resumo.custo, ...ex }; return o; };
  await av(`EscritoriosPainel.atualizar(${JSON.stringify(comLinhas({ estimado: true, estimadoExecucao: false, estimadoDia: true }))}); true`);
  await esperar(`/≈ US/.test(estado().gasto)`);
  r = await av(`({ g: estado().gasto, t: barra().querySelector('.esc-pn-gasto').title })`);
  conferir(/^US\$ 1,20 de 2,00 \(execução\) · ≈ US\$ 1,50 de 10,00 \(dia\)/.test(r.g) && /estimativa do Codex/i.test(r.t), '"≈" por linha: só o dia estimado → só a linha do dia leva "≈" (mesmo com estimado:true) e o title explica', r);
  await av(`EscritoriosPainel.atualizar(${JSON.stringify(comLinhas({ estimadoExecucao: true, estimadoDia: false }))}); true`);
  await esperar(`/^≈ US/.test(estado().gasto)`);
  r = await av(`estado().gasto`);
  conferir(/^≈ US\$ 1,20 de 2,00 \(execução\) · US\$ 1,50 de 10,00 \(dia\)/.test(r), '"≈" por linha: só a execução estimada → só a linha da execução leva "≈"', r);
  await av(`EscritoriosPainel.atualizar(${JSON.stringify(comLinhas({ estimadoExecucao: false, estimadoDia: false, estimado: true }))}); true`);
  await esperar(`!/≈ US/.test(estado().gasto)`);
  r = await av(`({ g: estado().gasto, t: barra().querySelector('.esc-pn-gasto').title })`);
  conferir(/^US\$ 1,20 de 2,00 \(execução\) · US\$ 1,50 de 10,00 \(dia\)/.test(r.g) && r.t === '', '"≈" por linha: os dois booleanos false vencem `estimado:true` (sem "≈" e sem title)', r);

  // ── 14d. Aviso flutuante (toast) quando a faixa está escondida ──
  const toast = `({ caixa: (() => { const c = document.querySelector('.esc-pn-toast-caixa'); return { visivel: !!c && !c.hidden && c.getClientRects().length > 0, tx: c ? c.querySelector('.esc-pn-toast-tx').textContent : '', tipo: c ? c.dataset.tipo : '' }; })(),
    faixaOculta: barra().getClientRects().length === 0, avisoFaixa: barra().querySelector('.esc-pn-aviso').hidden, regiao: document.querySelector('.esc-pn-toast')?.getAttribute('aria-live'), papel: document.querySelector('.esc-pn-toast')?.getAttribute('role') })`;
  await av(`document.getElementById('raiz').style.display = 'none'; true`);
  await av(`EscritoriosPainel.duplicar('inexistente').catch(() => {}); true`);
  await esperar(`!!document.querySelector('.esc-pn-toast-caixa') && !document.querySelector('.esc-pn-toast-caixa').hidden`);
  r = await av(toast);
  conferir(r.caixa.visivel && r.caixa.tx.length > 8 && r.caixa.tipo === 'erro' && r.faixaOculta && r.avisoFaixa === true && r.regiao === 'polite' && r.papel === 'status',
    'faixa escondida: o erro aparece num aviso flutuante visível (região aria-live polite), e o aviso da faixa continua oculto', r);
  await av(`btn('Dispensar aviso').click(); true`);
  r = await av(toast);
  conferir(!r.caixa.visivel && r.caixa.tx === '', 'o × do aviso flutuante o dispensa', r);
  await av(`document.getElementById('raiz').style.display = ''; true`);
  await av(`EscritoriosPainel.duplicar('inexistente').catch(() => {}); true`);
  await esperar(`!barra().querySelector('.esc-pn-aviso').hidden`);
  r = await av(`({ ...${toast}, aviso: estado().aviso })`);
  conferir(!r.caixa.visivel && r.avisoFaixa === false && r.aviso !== '', 'faixa visível: o erro fica na própria faixa e o aviso flutuante não aparece', r);
  await av(`barra().querySelector('.esc-pn-aviso button')?.click(); true`);

  // ── 14e. Descartar alterações da gaveta ──
  const dlgD = `(() => { const d = document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]'); return d ? { tx: d.textContent, foco: document.activeElement?.textContent, botoes: [...d.querySelectorAll('button')].map((b) => b.textContent) } : null; })()`;
  await av(`window.__p = EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!gv()`);
  r = await av(`({ suja: EscritoriosPainel.gavetaSuja(), titulo: gv().querySelector('h2').textContent })`);
  conferir(r.suja === false && r.titulo === 'Novo escritório', 'gaveta recém-aberta não está suja (gavetaSuja() false)', r);
  await av(`window.__p = EscritoriosPainel.abrirGaveta('novo'); true`);
  await dormir(150);
  r = await av(`({ dlg: ${dlgD}, gaveta: !!gv() })`);
  conferir(r.dlg === null && r.gaveta, 'abrir outra gaveta sobre uma gaveta LIMPA não pergunta nada', r);
  await av(`def(rotulo('Nome'), 'Rascunho'); true`);
  r = await av(`EscritoriosPainel.gavetaSuja()`);
  conferir(r === true, 'digitar no formulário deixa a gaveta suja (gavetaSuja() true)', r);
  await av(`window.__p = EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]')`);
  r = await av(dlgD);
  conferir(r && /Descartar alterações\?/.test(r.tx) && JSON.stringify(r.botoes) === '["Manter","Descartar"]' && r.foco === 'Manter', 'gaveta suja + abrir outra: diálogo "Descartar alterações?" com Manter/Descartar e foco em Manter', r);
  await av(`btn('Manter').click(); true`);
  r = await av(`window.__p.then((v) => ({ v, nome: gv() && rotulo('Nome').value, dlg: !!document.querySelector('.esc-pn-dialogo') }))`);
  conferir(r.v === false && r.nome === 'Rascunho' && !r.dlg, '"Manter": a abertura resolve false e a gaveta mantém o texto digitado', r);
  await av(`window.__p = EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]')`);
  await tecla('Escape', 'Escape', 27);
  r = await av(`window.__p.then((v) => ({ v, nome: gv() && rotulo('Nome').value, dlg: !!document.querySelector('.esc-pn-dialogo'), gaveta: !!gv() }))`);
  conferir(r.v === false && r.nome === 'Rascunho' && !r.dlg && r.gaveta, 'Esc no diálogo de descarte equivale a Manter (fecha só o diálogo)', r);
  await av(`window.__p = EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]')`);
  await av(`btn('Descartar').click(); true`);
  r = await av(`window.__p.then((v) => ({ v, nome: gv() && rotulo('Nome').value, suja: EscritoriosPainel.gavetaSuja(), dlg: !!document.querySelector('.esc-pn-dialogo'), gavetas: document.querySelectorAll('.esc-pn-gaveta').length }))`);
  conferir(r.v === true && r.nome === '' && r.suja === false && !r.dlg && r.gavetas === 1, '"Descartar": abre a nova gaveta vazia (uma só, sem sujeira)', r);
  await av(`def(rotulo('Nome'), 'Outro'); window.__p = EscritoriosPainel.descartarGaveta(); true`);
  await esperar(`!!document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]')`);
  await av(`btn('Descartar').click(); true`);
  r = await av(`window.__p.then((v) => ({ v, gaveta: !!gv() }))`);
  conferir(r.v === true && !r.gaveta, 'descartarGaveta() suja + Descartar: resolve true e fecha a gaveta', r);
  r = await av(`EscritoriosPainel.descartarGaveta().then((v) => v)`);
  conferir(r === true, 'descartarGaveta() sem gaveta resolve true', r);
  // o × da própria gaveta continua fechando sem perguntar
  await av(`EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!gv()`);
  await av(`def(rotulo('Nome'), 'Qualquer'); gv().querySelector('.esc-pn-x').click(); true`);
  await esperar(`!gv()`);
  r = await av(`({ gaveta: !!gv(), dlg: !!document.querySelector('.esc-pn-dialogo') })`);
  conferir(!r.gaveta && !r.dlg, 'o × da própria gaveta fecha sem perguntar (ação explícita)', r);

  // ── 14f. A abertura mais recente da gaveta vence (GET lento do editar não sobrescreve) ──
  atrasoGet.set(idBeta, 900);
  await av(`window.__p1 = EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idBeta)}); true`);
  await dormir(120);
  await av(`window.__p2 = EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idAlfa)}); true`);
  await esperar(`!!gv() && rotulo('Nome').value === 'Alfa'`);
  r = await av(`Promise.all([window.__p1, window.__p2]).then(([a, b]) => ({ a, b, nome: gv() && rotulo('Nome').value, gavetas: document.querySelectorAll('.esc-pn-gaveta').length }))`);
  conferir(r.a === false && r.b === true && r.nome === 'Alfa' && r.gavetas === 1, 'abrir Beta (GET lento) e logo Alfa: a gaveta final é a de Alfa; o pedido antigo resolve false e não sobrescreve nada', r);
  atrasoGet.delete(idBeta);
  await av(`gv().querySelector('.esc-pn-x').click(); true`);
  await esperar(`!gv()`);
  // 'editar' lento e depois 'novo': o novo vence
  atrasoGet.set(idBeta, 700);
  await av(`window.__p1 = EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idBeta)}); true`);
  await dormir(100);
  await av(`window.__p2 = EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!gv()`);
  r = await av(`Promise.all([window.__p1, window.__p2]).then(([a, b]) => ({ a, b, titulo: gv() && gv().querySelector('h2').textContent, gavetas: document.querySelectorAll('.esc-pn-gaveta').length }))`);
  await dormir(100);
  const r2 = await av(`({ titulo: gv() && gv().querySelector('h2').textContent, gavetas: document.querySelectorAll('.esc-pn-gaveta').length })`);
  conferir(r.a === false && r.b === true && r.titulo === 'Novo escritório' && r2.titulo === 'Novo escritório' && r2.gavetas === 1, 'editar lento seguido de novo: fica o "Novo escritório" (o GET atrasado não reabre a gaveta antiga)', { r, r2 });
  atrasoGet.delete(idBeta);
  await av(`gv().querySelector('.esc-pn-x').click(); true`);
  await esperar(`!gv()`);

  // ── 14g. Desmontar no meio de um pedido: nada estoura, nada fica no DOM ──
  const consoleAntes = consoleErros.length;
  atrasoGet.set(idAlfa, 500); atrasoModelos = 500;
  await av(`EscritoriosPainel.desmontar(); document.getElementById('raiz').replaceChildren(); true`);
  await av(`EscritoriosPainel.montar(document.getElementById('raiz'), { base: '', onSelecionar: (id) => demo.selecionados.push(id) }); true`);
  await av(`window.__p = EscritoriosPainel.abrirGaveta('editar', ${JSON.stringify(idAlfa)}); true`);
  await dormir(80);
  await av(`EscritoriosPainel.desmontar(); true`);
  r = await av(`window.__p.then((v) => ({ v, barra: !!barra(), gaveta: !!gv(), toast: !!document.querySelector('.esc-pn-toast'), dlg: !!document.querySelector('.esc-pn-dialogo') }))`);
  await dormir(900); // os pedidos atrasados (GET do editar, /modelos, lista) terminam depois do desmontar
  const r3 = await av(`({ barra: !!barra(), gaveta: !!gv(), toast: !!document.querySelector('.esc-pn-toast'), dlg: !!document.querySelector('.esc-pn-dialogo') })`);
  conferir(r.v === false && !r.barra && !r.gaveta && !r.toast && !r3.barra && !r3.gaveta && !r3.toast && !r3.dlg, 'desmontar no meio do GET do editar e do /modelos: a abertura resolve false e nada reaparece no DOM', { r, r3 });
  conferir(consoleErros.length === consoleAntes, 'desmontar no meio dos pedidos não gera exceção nem erro no console', consoleErros.slice(consoleAntes));
  // desmontar com o diálogo de descarte aberto
  atrasoGet.delete(idAlfa); atrasoModelos = 0;
  await av(`document.getElementById('raiz').replaceChildren(); EscritoriosPainel.montar(document.getElementById('raiz'), { base: '', onSelecionar: (id) => demo.selecionados.push(id) }); true`);
  await esperar(`!!barra() && selB().options.length > 0 && selB().value !== ''`);
  await av(`EscritoriosPainel.abrirGaveta('novo'); true`);
  await esperar(`!!gv()`);
  await av(`def(rotulo('Nome'), 'Xis'); window.__p = EscritoriosPainel.descartarGaveta(); true`);
  await esperar(`!!document.querySelector('.esc-pn-dialogo[data-pergunta="descartar"]')`);
  await av(`EscritoriosPainel.desmontar(); true`);
  r = await av(`window.__p.then((v) => ({ v, dlg: !!document.querySelector('.esc-pn-dialogo'), gaveta: !!gv() }))`);
  conferir(r.v === false && !r.dlg && !r.gaveta, 'desmontar com a pergunta de descarte aberta: o diálogo some e a promessa resolve false', r);
  // remonta para as seções seguintes
  await av(`document.getElementById('raiz').replaceChildren(); EscritoriosPainel.montar(document.getElementById('raiz'), { base: '', onSelecionar: (id) => demo.selecionados.push(id) }); true`);
  await esperar(`!!barra() && selB().options.length > 0`);

  // ── 15. Sem erros no console ──
  conferir(consoleErros.length === 0, 'sem erros nem avisos no console (fora os 400/409/429 provocados de propósito)', consoleErros.slice(0, 5));

  // ── 16. desmontar limpa tudo ──
  await av(`EscritoriosPainel.desmontar(); true`);
  r = await av(`({ barra: !!barra(), gaveta: !!gv() })`);
  conferir(!r.barra && !r.gaveta, 'desmontar remove a barra e a gaveta', r);
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
} finally {
  try { ws?.close(); } catch {}
  if (pcdp) await fecharEdge(pcdp, PERFIL);
  try { esc.parar(); } catch {}
  await new Promise((r) => srv.close(r));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch {}
}
console.log(`${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('FALHA:', f);
process.exit(res.falhas.length ? 1 : 0);
