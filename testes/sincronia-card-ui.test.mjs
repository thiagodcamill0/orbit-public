// Card "Sincronização" da Visão geral: abaixo do Uso de contexto, na coluna da direita. Sobe o mock (ROTEIRO=0)
// numa porta de teste, abre o index.html real no Edge headless e troca o fetch da página para /repos/* por respostas
// falsas (nunca fala com o GitHub nem com a pasta de um projeto real). Confere a posição e o layout do card em
// 1920/1440/900/480 px, o "Sem projeto" sem filtro, e com um projeto filtrado: a identidade (repositório, Privado e
// a conta do /perfil, também falso), o último commit, os números por linha, a lista de arquivos, o estado "Em dia"
// e os botões Sincronizar e Enviar.
// Capturas em logs/sincronia-card/. Uso: node testes/sincronia-card-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(PASTA, '..', 'logs', 'sincronia-card');
const PORTA = Number(process.env.PORTA || 47825);
const BASE = `http://127.0.0.1:${PORTA}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SAIDA, { recursive: true });

let ok = 0, falhas = 0;
const conferir = (cond, nome, extra) => {
  if (cond) { ok++; console.log('ok  ', nome); } else { falhas++; console.log('FALHA', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); }
};

const mock = spawn(process.execPath, [path.join(PASTA, 'mock-servidor.mjs')], { env: { ...process.env, MOCK_PORTA: String(PORTA), ROTEIRO: '0' }, stdio: 'ignore' });
const perfil = path.join(SAIDA, 'edge-' + PORTA);
const pcdp = 9760 + Math.floor(Math.random() * 150);
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) break; } catch {} await dormir(150); }
  spawn(caminhoNavegador(), ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${perfil}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pend = new Map(); const erros = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') erros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') erros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => {
    const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('avaliação: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  em: ' + expr.slice(0, 160));
    return r?.result?.value;
  };
  const largura = async (w) => { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 1100, deviceScaleFactor: 1, mobile: false }); await dormir(500); };
  const foto = async (nome) => {
    // A página rola dentro do <main>: traz o card (e o Uso de contexto acima dele) para a vista e recorta ali.
    const c = await av(`(() => { const el = document.getElementById('sincronia-card'); el.scrollIntoView({ block: 'end' }); const r = el.getBoundingClientRect(), t = Math.max(0, Math.min(r.top, document.querySelector('.graf-ctx').getBoundingClientRect().top)); return { x: r.x, y: t, w: r.width, h: r.bottom - t }; })()`);
    await dormir(150);
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, c.x - 8), y: Math.max(0, c.y - 8), width: c.w + 16, height: c.h + 16, scale: 2 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const esperar = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await av(expr)) return true; await dormir(100); } return false; };
  // Filtro de projeto pela lateral: clicar no projeto liga; clicar no ativo de novo tira.
  const clicarProjeto = async (nome) => {
    const achou = await av(`(() => { const b = [...document.querySelectorAll('#projetos .proj-item')].find((x) => x.dataset.proj === ${JSON.stringify(nome)}); if (b) b.click(); return !!b; })()`);
    if (!achou) throw new Error('projeto ' + nome + ' não está na lateral');
    await dormir(200);
  };

  // /perfil e /repos/* falsos dentro da página. O projeto "app exemplo" tem 2 commits para enviar e 3 arquivos sem
  // commit; "em dia" é o mesmo projeto sem nada a fazer (trocado por window.__f.emDia antes de filtrar de novo).
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const orig = window.fetch;
    const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const status = (o) => Object.assign({ branch: 'main', destacado: null, upstream: 'origin/main', adiante: 0, atras: 0, semCommits: false, alteracoes: 0, arquivos: [], truncado: false, operacao: null, buscadoEm: Date.now() - 6 * 60e3, lidoEm: Date.now(), ultimo: { hash: 'a1b2c3d4e5f6', msg: 'Tela de login nova', quando: H(3) } }, o);
    const projeto = (o) => ({ chave: 'd:\\\\dev\\\\projetos\\\\exemplo\\\\app exemplo', nome: 'app exemplo', pasta: 'D:\\\\Dev\\\\Projetos\\\\Exemplo\\\\app exemplo', existe: true, origem: 'sessao', bloqueado: null, git: true,
      repo: { completo: 'usuario/exemplo', dono: 'usuario', nome: 'exemplo', url: 'https://github.com/usuario/exemplo' }, remoto: { url: 'https://github.com/usuario/exemplo.git', github: true }, status: status(o) });
    const PEND = { adiante: 2, alteracoes: 3, arquivos: [{ caminho: 'src/login.tsx', tipo: 'modificado' }, { caminho: 'index.html', tipo: 'modificado' }, { caminho: 'testes/novo.mjs', tipo: 'novo' }] };
    window.__f = { pedidos: [], emDia: false };
    const PERFIL = { nome: 'Usuário', seguro: true, github: { login: 'usuario', nome: 'Usuário Teste', url: 'https://github.com/usuario', avatar: null, expirado: false } };
    const resp = (s, c) => new Response(JSON.stringify(c), { status: s, headers: { 'content-type': 'application/json' } });
    window.fetch = (u, op = {}) => {
      const rota = new URL(String(u), location.href).pathname;
      if (rota === '/perfil') return Promise.resolve(resp(200, PERFIL));
      if (!rota.startsWith('/repos/')) return orig(u, op);
      window.__f.pedidos.push({ rota, metodo: op.method || 'GET', corpo: op.body ? JSON.parse(op.body) : null });
      if (rota === '/repos/projetos') return Promise.resolve(resp(200, { projetos: [projeto(window.__f.emDia ? {} : PEND)], pastaClones: '', github: { conectado: true, login: 'usuario', expirado: false } }));
      if (rota === '/repos/github') return Promise.resolve(resp(200, { login: 'usuario', lidoEm: Date.now(), repos: [{ completo: 'usuario/exemplo', dono: 'usuario', nome: 'exemplo', visibilidade: 'privado' }] }));
      return Promise.resolve(resp(404, { erro: 'não encontrado' }));
    };
  })()` });
  await largura(1440);
  await cdp('Page.navigate', { url: BASE + '/?abas=0' });
  await esperar(`!!window.Sincronia && !!document.querySelector('#sincronia-card .gc-vazio')`, 8000);

  // Sem projeto no filtro: o card aparece com o convite para filtrar, sem erro.
  const vazio = await av(`(() => { const c = document.getElementById('sincronia-card'); return { vis: !!c.getClientRects().length, estado: c.querySelector('[data-gs="estado"]').textContent, txt: c.querySelector('.gc-vazio').textContent, linhas: c.querySelectorAll('.gs-repo').length, botoes: ['sinc', 'enviar'].map((k) => !c.querySelector('[data-gs="' + k + '"]').hidden) }; })()`);
  conferir(vazio.vis && vazio.estado === 'Sem projeto' && /Escolha um projeto no filtro/.test(vazio.txt) && !vazio.linhas && !vazio.botoes.some(Boolean), 'sem projeto: card visível com "Sem projeto" e o convite, sem botões', vazio);

  // Posição: abaixo do Uso de contexto, mesma largura, vão de 16 px.
  for (const w of [1920, 1440]) { // lado a lado (área principal > 1080 px); 1280 já empilha
    await largura(w);
    const p = await av(`(() => { const a = document.querySelector('.graf-ctx').getBoundingClientRect(), b = document.getElementById('sincronia-card').getBoundingClientRect(); return { vao: Math.round(b.top - a.bottom), l: [a.left, b.left], w: [a.width, b.width] }; })()`);
    conferir(p.vao >= 16 && p.vao < 24 && p.l[0] === p.l[1] && p.w[0] === p.w[1], `${w}px: card logo abaixo do Uso de contexto (16 px, mesma coluna)`, p);
    const cv = await av(`(() => { const g = document.querySelector('.geral-grade'); if (!g.classList.contains('cena-vertical')) return null; const a = document.getElementById('sincronia-card').getBoundingClientRect(), b = document.getElementById('cena-v').getBoundingClientRect(); return Math.round(b.top - a.bottom); })()`);
    conferir(cv === null || cv === 16, `${w}px: cena em pé, se houver, começa 16 px abaixo do card`, cv);
    await foto(w + '-sem-projeto');
  }
  await largura(900);
  // Grade da Visão geral (widgets.js): em 900 px são 4 colunas: Sessões e Contexto lado a lado (metade cada) e a
  // Sincronização embaixo deles, na metade da grade.
  const meio = await av(`(() => { const a = document.querySelector('.graf-estado').getBoundingClientRect(), b = document.querySelector('.graf-ctx').getBoundingClientRect(), c = document.getElementById('sincronia-card').getBoundingClientRect();
    return { mesmaLinha: Math.abs(a.top - b.top) < 1 && b.left > a.right, abaixo: c.top >= Math.min(a.bottom, b.bottom), metade: Math.abs(c.width - a.width) < 1 }; })()`);
  conferir(meio.mesmaLinha && meio.abaixo && meio.metade, '900px: Sessões e Contexto na mesma linha; Sincronização embaixo, na metade da grade', meio);
  await foto('900-sem-projeto');
  await largura(480);
  const est = await av(`(() => { const b = document.getElementById('sincronia-card').getBoundingClientRect(); return { w: Math.round(b.width), rolagem: document.documentElement.scrollWidth > innerWidth }; })()`);
  conferir(est.w > 300 && !est.rolagem, '480px: empilhado, sem rolagem horizontal', est);
  await foto('480-sem-projeto');
  await largura(1440);

  // Com o projeto filtrado: números, identidade, último commit, botões.
  await clicarProjeto('app exemplo');
  await esperar(`document.querySelectorAll('#sincronia-card .gs-repo').length === 1`);
  const nums = await av(`[...document.querySelectorAll('#sincronia-card .gs-repo')].map((r) => ({ id: r.dataset.repo, nums: [...r.querySelectorAll('.gs-chip')].map((d) => d.textContent), envio: r.querySelector('.gs-envio')?.textContent || '' }))`);
  conferir(nums.length === 1 && nums[0].id === 'projeto' && JSON.stringify(nums[0].nums) === JSON.stringify(['3 alterações', '2 commits']) && !nums[0].envio, 'alterações e commits da linha, só os que não são zero (e sem "enviado há")', nums);
  const topo = await av(`(() => { const c = document.getElementById('sincronia-card'), b = (k) => c.querySelector('[data-gs="' + k + '"]'); return { estado: b('estado').textContent, tom: b('estado').dataset.tom, numGrande: !!c.querySelector('.gf-num'),
    enviar: !b('enviar').hidden && !b('enviar').disabled && b('enviar').classList.contains('solido'), sinc: !b('sinc').hidden && !b('sinc').disabled ? b('sinc').textContent : '' }; })()`);
  conferir(topo.estado === 'Para enviar' && !topo.numGrande, 'topo: o estado numa palavra, sem número grande que repita as linhas', topo);
  conferir(topo.sinc === 'Sincronizar' && topo.enviar, 'pé: Sincronizar e Enviar (sólido, há o que enviar)', topo);
  // Identidade: repositório (o dono é a conta, então só o nome), Privado e a conta conectada.
  const id = await av(`(() => { const c = document.querySelector('#sincronia-card [data-gs="id"]'); return { gh: !!c.querySelector('.gs-gh svg'), repo: c.querySelector('.gs-id-repo b')?.textContent, dono: c.querySelector('.gs-dono')?.textContent || '', vis: /Privado/.test(c.querySelector('.gs-id-repo')?.textContent || '') ? 'Privado' : '', login: c.querySelector('.gs-login')?.textContent, av: !!c.querySelector('.gs-av'), link: c.querySelector('.gs-abrir')?.href }; })()`);
  conferir(id.gh && id.repo === 'exemplo' && !id.dono && id.vis === 'Privado' && id.login === 'usuario' && id.av && id.link === 'https://github.com/usuario/exemplo', 'identidade: logo do GitHub, exemplo, Privado, conta e link', id);
  const cm = await av(`[...document.querySelectorAll('#sincronia-card .gs-repo')].map((r) => ({ branch: r.querySelector('.gs-branch')?.textContent, msg: r.querySelector('.gs-commit-msg')?.textContent, hash: r.querySelector('.gs-hash')?.textContent, quando: r.querySelector('.gs-commit-quando')?.textContent }))`);
  conferir(cm[0].branch === 'main' && cm[0].msg === 'Tela de login nova' && cm[0].hash === 'a1b2c3d' && cm[0].quando === 'há 3 h', 'linha: branch e último commit (mensagem, hash, quando)', cm);
  await foto('1440-pendente');

  // A linha com alterações abre a lista de arquivos ali mesmo.
  const lista = async () => av(`(() => { const r = document.querySelector('#sincronia-card .gs-repo'), b = r.querySelector('.gs-alvo'); return { botao: b.tagName, exp: b.getAttribute('aria-expanded'), arqs: [...r.querySelectorAll('.gs-arqs li')].map((l) => l.textContent) }; })()`);
  const l0 = await lista();
  await av(`document.querySelector('#sincronia-card .gs-repo .gs-alvo').click(), true`);
  await dormir(200);
  const l1 = await lista();
  conferir(l0.botao === 'BUTTON' && l0.exp === 'false' && !l0.arqs.length && l1.exp === 'true' && l1.arqs.length === 3 && l1.arqs[0].includes('src/login.tsx'), 'clique na linha abre os 3 arquivos', { l0, l1 });
  await foto('1440-aberto');
  await av(`document.querySelector('#sincronia-card .gs-repo .gs-alvo').click(), true`);
  await dormir(200);
  conferir((await lista()).exp === 'false', 'segundo clique fecha a lista', null);

  // Em dia: nada a enviar, o Enviar some e fica só o Sincronizar.
  await av(`window.__f.emDia = true, true`);
  await clicarProjeto('app exemplo'); // tira o filtro
  await esperar(`!!document.querySelector('#sincronia-card .gc-vazio')`);
  await clicarProjeto('app exemplo');
  await esperar(`document.querySelectorAll('#sincronia-card .gs-repo').length === 1`);
  const dia = await av(`(() => { const c = document.getElementById('sincronia-card'), e = c.querySelector('[data-gs="enviar"]'), s = c.querySelector('[data-gs="sinc"]'); return { estado: c.querySelector('[data-gs="estado"]').textContent, tom: c.querySelector('[data-gs="estado"]').dataset.tom, enviar: !e.hidden, sinc: !s.hidden && !s.disabled, emDia: c.querySelectorAll('.gs-chip.ok').length }; })()`);
  conferir(dia.estado === 'Em dia' && dia.tom === 'ok' && dia.emDia === 1, 'em dia: "Em dia" no topo e "Igual ao GitHub" na linha', dia);
  conferir(dia.sinc && !dia.enviar, 'em dia: só o Sincronizar (o Enviar some)', dia);
  await foto('1440-em-dia');

  conferir(!erros.length, '0 erros de console', erros);
  ws.close();
} catch (e) {
  falhas++;
  console.log('FALHA', e?.stack || e);
} finally {
  await fecharEdge(pcdp, perfil).catch(() => {});
  try { mock.kill(); } catch {}
}
console.log(`\n${ok} ok, ${falhas} falhas · capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
