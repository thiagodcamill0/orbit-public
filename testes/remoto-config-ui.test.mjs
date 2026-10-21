// Teste da seção Configurações → Acesso pelo celular e do aviso do pedido de pareamento (assets/remoto-config.js +
// remoto.mjs). Servidor de teste em porta livre de 47822–47826 (a porta remota também sai da faixa; nunca a 47821),
// Edge headless mudo, Tailscale falso (ORBIT_TAILSCALE_FALSO: nada chama a CLI de verdade), dados em pasta temporária.
//   node testes/remoto-config-ui.test.mjs [pasta-de-capturas]   (~40 s; sem argumento, tudo é apagado no fim)
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherPorta, portaLivre, FAIXA } from './porta-livre.mjs';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { matarArvore } from '../plataforma.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';
const PEDIDA = process.argv[2] ? path.resolve(process.argv[2]) : '';
const SAIDA = PEDIDA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-remoto-cfg-'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA = await escolherPorta(47825);
let PORTA_R = 0;
for (const p of FAIXA) if (p !== PORTA && (await portaLivre(p))) { PORTA_R = p; break; }
if (!PORTA_R) throw new Error('sem 2ª porta livre em 47822–47826 para a porta remota');
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = path.join(SAIDA, 'dados'), SESS = path.join(SAIDA, 'sessoes'), PROJETOS = path.join(DADOS, 'projetos'), EDGE_PERFIL = path.join(SAIDA, 'edge');
for (const d of [DADOS, SESS, EDGE_PERFIL]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, SESS, PROJETOS]) fs.mkdirSync(d, { recursive: true });
const HOST = 'orbit-teste.exemplo.ts.net';
const DONO = 'usuario@exemplo.com';
const TS = path.join(DADOS, 'tailscale-falso.json');
const STATUS = { BackendState: 'Running', Self: { DNSName: HOST + '.', UserID: 7 }, User: { 7: { LoginName: DONO } } };
const escreverTs = (extra = {}, serve = {}) => fs.writeFileSync(TS, JSON.stringify({ status: STATUS, serve, ...extra }));
escreverTs();
fs.writeFileSync(path.join(DADOS, 'config.json'), JSON.stringify({ remoto: { porta: PORTA_R } }));
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [], ocultos: [] }));
const PEDIDO_MS = 6000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

function pedirEm(porta, metodo, rota, { headers = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    if (dados !== undefined) h['content-length'] = Buffer.byteLength(dados);
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo, headers: h, timeout: 20000, agent: false }, (r) => {
      const partes = [];
      r.on('data', (c) => partes.push(c));
      r.on('end', () => { const texto = Buffer.concat(partes).toString('utf8'); let json; try { json = JSON.parse(texto); } catch {} resolve({ status: r.statusCode, json, texto }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const local = (metodo, rota, corpo) => pedirEm(PORTA, metodo, rota, { headers: { 'x-gerenciador': '1', ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) }, corpo });
// O "iPhone": a porta remota, como o Safari atrás do tailscale serve.
const celular = (rota, corpo) => pedirEm(PORTA_R, 'POST', rota, { headers: { host: HOST, origin: 'https://' + HOST, 'content-type': 'application/json', 'tailscale-user-login': DONO }, corpo });
const estadoPc = async () => (await local('GET', '/remoto/estado')).json;
async function esperarServidor(cond, ms = 8000) { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await cond(); if (v) return v; await dormir(100); } return v; }
async function parear(nome) {
  const p = await celular('/remoto/parear/pedir', { nome });
  const codigo = (await estadoPc()).pedido?.codigo;
  const c = await celular('/remoto/parear/confirmar', { pedido: p.json?.pedido, codigo });
  return { pedir: p, confirmar: c };
}

let srv, pcdp, ws;
try {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    env: {
      ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PROJETOS_DIR: PROJETOS,
      GERENCIADOR_TICK_MS: '250', GERENCIADOR_PID_MS: '300', ORBIT_MODELOS: '0', ORBIT_MS_REGISTRO: '200', ORBIT_MS_VIGIA: '100', ORBIT_MS_INICIO: '4000',
      ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'), ORBIT_TAILSCALE_FALSO: TS, ORBIT_REMOTO_PEDIDO_MS: String(PEDIDO_MS),
      CLAUDE_CODE_ENTRYPOINT: 'teste',
      ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
    },
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }

  pcdp = 9750 + Math.floor(Math.random() * 150);
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${EDGE_PERFIL}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
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
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon|\/modelos$|\/remoto\/tailscale\/serve$/.test(d.params.entry.url || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const esperar = async (expr, ms = 8000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await av(expr); if (v) return v; await dormir(100); } return v; };
  const clicar = (sel) => av(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
  const foto = async (nome) => {
    await dormir(200);
    const r2 = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64'));
  };
  const S = '#cfg-remoto';
  const txtSecao = () => av(`document.querySelector('${S}')?.textContent || ''`);
  const pedidoVisivel = `(() => { const c = document.getElementById('rm-pedido'); return !!c && !c.hidden; })()`;
  const pedidoEscondido = `(() => { const c = document.getElementById('rm-pedido'); return !!c && c.hidden; })()`;

  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/' });
  await esperar(`!!window.RemotoConfig && !!document.getElementById('rm-pedido')`, 15000);

  // ── a seção aparece, desligada, com o Tailscale e o endereço ──
  await clicar('#nav-config');
  conferir(await esperar(`!!document.querySelector('${S} [data-k="ativo"]')`), 'a seção Acesso pelo celular aparece nas Configurações');
  conferir(await av(`document.getElementById('t-cfg-remoto')?.textContent === 'Acesso pelo celular'`), 'o título da seção');
  conferir(await av(`document.querySelector('${S} [data-k="ativo"]').checked === false`), 'começa desligado');
  conferir(await av(`['criar', 'n-precisa', 'n-terminou'].every((k) => document.querySelector('${S} [data-k="' + k + '"]').disabled)`), 'desligado, as opções ficam travadas');
  conferir(await esperar(`document.querySelector('${S} [data-k="ts-estado"]')?.textContent.includes(${JSON.stringify(DONO)})`), 'mostra o Tailscale conectado com o dono', await txtSecao());
  conferir(await av(`document.querySelector('${S} [data-k="ts-estado"]').textContent.includes(${JSON.stringify(HOST)})`), 'mostra o host do Tailscale');
  conferir(await esperar(`document.querySelector('${S} [data-k="endereco"]')?.textContent === ${JSON.stringify('https://' + HOST)}`), 'mostra o endereço https://<host>', await av(`document.querySelector('${S} [data-k="endereco"]')?.textContent`));
  conferir(await av(`!!document.querySelector('${S} [data-k="copiar"]')`), 'tem o botão de copiar o endereço');
  conferir(await av(`document.querySelector('${S} [data-k="ts-serve"]').disabled`), 'Ativar no Tailscale fica travado com o acesso desligado');
  conferir(await av(`document.querySelector('${S} [data-k="criar"]').checked === false`), 'criar instâncias vem desligado');
  conferir(await av(`document.querySelector('${S} [data-k="n-precisa"]').checked && document.querySelector('${S} [data-k="n-terminou"]').checked`), 'avisos "precisa de você" e "terminou" vêm ligados');
  conferir(await av(`/Nenhum aparelho pareado/.test(document.querySelector('${S}').textContent)`), 'sem aparelhos');
  conferir(await av(`document.querySelectorAll('${S} .rm-passos li').length >= 6 && /Adicionar à Tela de Início/.test(document.querySelector('${S} .rm-passos').textContent)`), 'traz o passo a passo');
  conferir(await portaLivre(PORTA_R), 'com o acesso desligado a porta remota está fechada');

  // ── ligar ──
  await clicar(`${S} [data-k="ativo"]`);
  conferir(await esperarServidor(async () => (await estadoPc()).ativo === true), 'ligar: o servidor passa a ativo');
  conferir(await esperar(`document.querySelector('${S} [data-k="ativo"]').checked && !document.querySelector('${S} [data-k="criar"]').disabled`), 'ligar: o interruptor fica ligado e as opções destravam');
  conferir(!(await portaLivre(PORTA_R)), 'ligar: a porta remota abre');

  // ── tailscale serve: o erro da 1ª vez aparece; depois liga e desliga ──
  escreverTs({ erroServe: 'Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=abc' });
  conferir(await esperar(`!document.querySelector('${S} [data-k="ts-serve"]').disabled && document.querySelector('${S} [data-k="ts-serve"]').textContent === 'Ativar no Tailscale'`), 'com o acesso ligado, "Ativar no Tailscale" destrava');
  await clicar(`${S} [data-k="ts-serve"]`);
  conferir(await esperar(`/Serve is not enabled on your tailnet/.test(document.querySelector('${S} [data-k="ts-erro"]')?.textContent || '')`), 'mostra o erro devolvido pelo Tailscale', await txtSecao());
  await av(`document.querySelector('${S}').scrollIntoView({ block: 'center' })`);
  await esperar(`!document.getElementById('abertura') || document.getElementById('abertura').classList.contains('sai')`, 5000);
  await dormir(500);
  await foto('01-erro-serve');
  escreverTs();
  await clicar(`${S} [data-k="ts-serve"]`);
  conferir(await esperar(`document.querySelector('${S} [data-k="ts-serve"]')?.textContent === 'Desativar' && !document.querySelector('${S} [data-k="ts-erro"]')`), 'ativou: o botão vira Desativar e o erro some', await txtSecao());
  conferir(await av(`/Publicado na sua tailnet/.test(document.querySelector('${S}').textContent)`), 'mostra o serve ligado');
  conferir(fs.readFileSync(TS + '.log', 'utf8').includes(JSON.stringify(['serve', '--bg', '--https=443', `http://127.0.0.1:${PORTA_R}`])), 'o comando certo foi para o Tailscale (falso)');
  await clicar(`${S} [data-k="ts-serve"]`);
  conferir(await esperar(`document.querySelector('${S} [data-k="ts-serve"]')?.textContent === 'Ativar no Tailscale'`), 'desativar volta para "Ativar no Tailscale"');
  // Tailscale ausente: link de download
  escreverTs({ ausente: true });
  await local('POST', '/remoto/tailscale/serve', { ligar: false });
  conferir(await esperar(`document.querySelector('${S} [data-k="ts-baixar"]')?.href === 'https://tailscale.com/download'`), 'sem Tailscale: link para baixar', await txtSecao());
  conferir(await av(`!document.querySelector('${S} [data-k="ts-serve"]')`), 'sem Tailscale: sem botão de ativar');
  escreverTs();
  await local('POST', '/remoto/tailscale/serve', { ligar: false });
  conferir(await esperar(`!!document.querySelector('${S} [data-k="ts-serve"]')`), 'o Tailscale volta e o botão reaparece');

  // ── opções ──
  await clicar(`${S} [data-k="criar"]`);
  conferir(await esperarServidor(async () => (await estadoPc()).opcoes.criarInstancias === true), 'criar instâncias liga no servidor');
  await esperar(`!document.querySelector('${S} [data-k="n-precisa"]').disabled`);
  await clicar(`${S} [data-k="n-precisa"]`);
  conferir(await esperarServidor(async () => { const o = (await estadoPc()).opcoes; return o.notificar.precisa === false && o.notificar.terminou === true; }), 'desligar "precisa de você" não mexe no "terminou"', (await estadoPc()).opcoes);
  await esperar(`!document.querySelector('${S} [data-k="n-precisa"]').checked`);
  await clicar(`${S} [data-k="n-precisa"]`);
  await esperarServidor(async () => (await estadoPc()).opcoes.notificar.precisa === true);
  await esperar(`!document.querySelector('${S} [data-k="criar"]').disabled`);
  await clicar(`${S} [data-k="criar"]`);
  conferir(await esperarServidor(async () => { const o = (await estadoPc()).opcoes; return o.criarInstancias === false && o.notificar.precisa === true; }), 'as opções voltam ao padrão');

  // ── pedido de pareamento: aviso em destaque, recusar ──
  const p1 = await celular('/remoto/parear/pedir', { nome: 'iPhone de teste' });
  const cod1 = (await estadoPc()).pedido?.codigo;
  conferir(p1.status === 200 && /^\d{6}$/.test(cod1 || ''), 'o iPhone (falso) pede o pareamento', p1.texto);
  conferir(await esperar(pedidoVisivel), 'o aviso do pedido aparece sozinho (SSE), mesmo com as Configurações abertas');
  conferir(await av(`document.getElementById('rm-ped-tit').textContent === 'iPhone de teste quer acessar o Orbit'`), 'o aviso diz quem quer acessar', await av(`document.getElementById('rm-ped-tit').textContent`));
  conferir(await av(`document.getElementById('rm-ped-cod').textContent === ${JSON.stringify(cod1)}`), 'o código de 6 dígitos é o do servidor');
  conferir(await av(`parseFloat(getComputedStyle(document.getElementById('rm-ped-cod')).fontSize) >= 34`), 'o código aparece grande');
  conferir(await av(`/^Vale por 0:0[0-6]$/.test(document.getElementById('rm-ped-resta').textContent)`), 'tem a contagem regressiva', await av(`document.getElementById('rm-ped-resta').textContent`));
  const r1 = await av(`document.getElementById('rm-ped-resta').textContent`);
  await dormir(1500);
  const r2 = await av(`document.getElementById('rm-ped-resta').textContent`);
  conferir(r2 !== r1, 'a contagem regressiva anda', [r1, r2, await av('document.hidden'), await av(pedidoVisivel)]);
  conferir(await av(`document.activeElement?.id === 'rm-ped-recusar'`), 'o foco vai para Recusar', await av(`document.activeElement?.outerHTML?.slice(0, 120)`));
  conferir(await av(`parseInt(getComputedStyle(document.getElementById('rm-pedido')).zIndex) > 50`), 'o aviso fica acima das Configurações e do toast');
  await foto('02-pedido');
  await clicar('#rm-ped-recusar');
  conferir(await esperar(pedidoEscondido), 'Recusar fecha o aviso');
  conferir(await esperarServidor(async () => (await estadoPc()).pedido === null), 'Recusar derruba o pedido no servidor');
  const conf = await celular('/remoto/parear/confirmar', { pedido: p1.json.pedido, codigo: cod1 });
  conferir(conf.status === 410, 'depois de recusado, nem o código certo pareia (410)', conf.status);

  // ── confirmar fecha o aviso e o aparelho entra na lista ──
  const par = await (async () => {
    const p = await celular('/remoto/parear/pedir', { nome: 'iPhone teste' });
    await esperar(pedidoVisivel);
    const codigo = (await estadoPc()).pedido.codigo;
    const c = await celular('/remoto/parear/confirmar', { pedido: p.json.pedido, codigo });
    return c;
  })();
  conferir(par.status === 200, 'o iPhone confirma com o código', par.texto);
  conferir(await esperar(pedidoEscondido), 'confirmar fecha o aviso');
  conferir(await esperar(`document.querySelectorAll('${S} .rm-ap').length === 1`), 'o aparelho entra na lista');
  const linha = await av(`document.querySelector('${S} .rm-ap')?.textContent || ''`);
  conferir(/iPhone teste/.test(linha) && /Pareado em \d{2}\/\d{2}\/\d{4}/.test(linha) && /último acesso/.test(linha) && /push: não/.test(linha), 'a linha mostra nome, pareado em, último acesso e push', linha);
  await av(`document.querySelector('${S}').scrollIntoView({ block: 'center' })`);
  await foto('03-aparelho');

  // ── expirar fecha o aviso ──
  await celular('/remoto/parear/pedir', { nome: 'Vai expirar' });
  conferir(await esperar(pedidoVisivel), 'novo pedido: o aviso volta');
  conferir(await esperar(pedidoEscondido, PEDIDO_MS + 4000), 'expirado, o aviso some sozinho');
  conferir(await esperarServidor(async () => (await estadoPc()).pedido === null), 'expirado no servidor também');

  // ── abrir a página com um pedido já pendente ──
  await celular('/remoto/parear/pedir', { nome: 'Pendente na abertura' });
  await cdp('Page.navigate', { url: BASE + '/' });
  conferir(await esperar(pedidoVisivel, 15000), 'ao abrir a página com um pedido pendente, o aviso já aparece (estado inicial)');
  conferir(await av(`document.getElementById('rm-ped-tit').textContent === 'Pendente na abertura quer acessar o Orbit' && /^\\d{6}$/.test(document.getElementById('rm-ped-cod').textContent)`), 'o aviso inicial traz nome e código');
  await clicar('#rm-ped-recusar');
  conferir(await esperar(pedidoEscondido), 'recusar o pedido inicial');

  // ── revogar um aparelho ──
  if (await av(`document.getElementById('camada-config').hidden`)) await clicar('#nav-config');
  conferir(await esperar(`document.querySelectorAll('${S} .rm-ap').length === 1`, 8000), 'depois de recarregar, o aparelho segue na lista');
  const idAp = (await estadoPc()).aparelhos[0].id;
  await clicar(`${S} [data-k="rev-${idAp}"]`);
  conferir(await esperar(`document.querySelectorAll('${S} .rm-ap').length === 0 && /Nenhum aparelho pareado/.test(document.querySelector('${S}').textContent)`), 'Revogar tira o aparelho da lista');
  conferir((await estadoPc()).aparelhos.length === 0, 'e do servidor');

  // ── revogar todos (com confirmação) ──
  await parear('Aparelho A');
  await parear('Aparelho B');
  conferir(await esperar(`document.querySelectorAll('${S} .rm-ap').length === 2`), 'dois aparelhos na lista');
  await clicar(`${S} [data-k="rev-todos"]`);
  conferir(await esperar(`!document.getElementById('balao').hidden && /Revogar todos/.test(document.getElementById('balao-tit').textContent)`, 4000), 'Revogar todos pergunta antes (balão)');
  await clicar('#balao-nao');
  await dormir(300);
  conferir((await estadoPc()).aparelhos.length === 2, 'cancelar a pergunta não revoga nada');
  await clicar(`${S} [data-k="rev-todos"]`);
  await esperar(`!document.getElementById('balao').hidden`, 4000);
  await clicar('#balao-sim');
  conferir(await esperar(`document.querySelectorAll('${S} .rm-ap').length === 0`), 'confirmado: a lista esvazia');
  conferir((await estadoPc()).aparelhos.length === 0, 'e o servidor também');

  // ── desligar ──
  await clicar(`${S} [data-k="ativo"]`);
  conferir(await esperarServidor(async () => (await estadoPc()).ativo === false), 'desligar: o servidor passa a inativo');
  conferir(await esperarServidor(() => portaLivre(PORTA_R)), 'desligar: a porta remota fecha');
  conferir(await esperar(`!document.querySelector('${S} [data-k="ativo"]').checked && document.querySelector('${S} [data-k="criar"]').disabled`), 'desligar: interruptor e opções voltam ao estado desligado');

  // ── estreito (420): sem rolagem horizontal, com o aviso do pedido ──
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await local('POST', '/remoto/config', { ativo: true });
  await dormir(500);
  await celular('/remoto/parear/pedir', { nome: 'iPhone com um nome bem comprido para testar o corte' });
  await esperar(pedidoVisivel);
  const larg = await av(`(() => { const m = document.querySelector('#rm-pedido .modal'); const r = m.getBoundingClientRect(); const c = document.getElementById('rm-ped-cod').getBoundingClientRect(); return { esq: r.left, dir: r.right, w: innerWidth, codDir: c.right, sw: m.scrollWidth, cw: m.clientWidth }; })()`);
  conferir(larg && larg.esq >= 0 && larg.dir <= larg.w + 1 && larg.codDir <= larg.dir && larg.sw <= larg.cw + 1, 'em 420 px o aviso do pedido cabe na tela', larg);
  await foto('04-pedido-estreito');
  await clicar('#rm-ped-recusar');
  await esperar(pedidoEscondido);
  if (await av(`document.getElementById('camada-config').hidden`)) await clicar('#nav-config');
  await esperar(`!document.getElementById('camada-config').hidden`, 2000);
  await dormir(300);
  const cfgLarg = await av(`(() => { const c = document.querySelector('#camada-config .modal-corpo'); return c ? { sw: c.scrollWidth, cw: c.clientWidth } : null; })()`);
  conferir(cfgLarg && cfgLarg.sw <= cfgLarg.cw + 1, 'em 420 px, as Configurações sem rolagem horizontal', cfgLarg);

  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { await fetch(BASE + '/desligar', { method: 'POST', headers: { 'x-gerenciador': '1' } }); } catch {}
  await dormir(500);
  try { srv.kill(); } catch {}
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8'));
    if (m?.pid) { if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else await matarArvore(m.pid); }
  } catch {}
  if (pcdp) await fecharEdge(pcdp, EDGE_PERFIL);
  if (!PEDIDA) { await dormir(300); try { fs.rmSync(SAIDA, { recursive: true, force: true }); } catch {} }
  console.log(JSON.stringify({ porta: PORTA, portaRemota: PORTA_R, ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
