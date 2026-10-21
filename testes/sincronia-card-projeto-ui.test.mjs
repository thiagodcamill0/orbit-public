// Card "Sincronização" da Visão geral: mostra o repositório do projeto filtrado. Sobe o mock (ROTEIRO=0) numa porta
// de teste livre, abre o index.html real no Edge headless e troca o fetch da página para /repos/* por respostas
// falsas (nunca fala com o GitHub nem com a pasta de um projeto real). Confere: sem filtro, o card fica à vista com
// "Sem projeto"; com "app exemplo", o repositório dele (Privado, branch, último commit, números); Enviar com o
// balão do servidor e o push confirmado; Sincronizar (buscar + receber); outro projeto com git em dia; tirar o filtro
// volta ao "Sem projeto".
// Subpastas com repositório próprio (18/10: o projeto Exemplo tem um clone por branch em app/, brain/ e main/ e um .git
// vazio na pasta de cima): uma linha por subpasta e o Enviar manda as que têm commits, num balão só.
// Capturas em logs/sincronia-card-projeto/. Uso: node testes/sincronia-card-projeto-ui.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caminhoNavegador, fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(PASTA, '..', 'logs', 'sincronia-card-projeto');
const PORTA = await escolherPorta(Number(process.env.PORTA) || 47824);
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
  const foto = async (nome) => {
    const c = await av(`(() => { const el = document.getElementById('sincronia-card'); el.scrollIntoView({ block: 'end' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    await dormir(150);
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, c.x - 8), y: Math.max(0, c.y - 8), width: c.w + 16, height: c.h + 16, scale: 2 } });
    fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  // Filtro de projeto pela lateral, como o usuário faz: clicar no projeto liga; clicar no ativo de novo tira.
  let filtroAtual = '';
  const filtrar = async (n) => {
    const alvoP = n || filtroAtual;
    if (!alvoP || alvoP === filtroAtual && n) return;
    const achou = await av(`(() => { const b = [...document.querySelectorAll('#projetos .proj-item')].find((x) => x.dataset.proj === ${JSON.stringify(alvoP)}); if (b) b.click(); return !!b; })()`);
    if (!achou) throw new Error('projeto ' + alvoP + ' não está na lateral');
    filtroAtual = n;
    await dormir(200);
  };
  const esperar = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await av(expr)) return true; await dormir(100); } return false; };
  const lerCard = () => av(`(() => { const c = document.getElementById('sincronia-card'), q = (s) => c.querySelector(s);
    return { estado: q('[data-gs="estado"]').textContent, repo: q('.gs-id-repo')?.textContent || '', linhas: [...c.querySelectorAll('.gs-repo')].map((r) => ({ id: r.dataset.repo, nome: r.querySelector('.gs-nome')?.textContent, branch: r.querySelector('.gs-branch')?.textContent || '', commit: r.querySelector('.gs-commit-msg')?.textContent || '', hash: r.querySelector('.gs-hash')?.textContent || '', envio: r.querySelector('.gs-envio')?.textContent || '', chips: [...r.querySelectorAll('.gs-chip')].map((x) => x.textContent), aviso: r.querySelector('.gs-aviso')?.textContent || '' })),
      emDia: q('.gs-emdia') ? q('.gs-emdia-rot').textContent + ' ' + [...c.querySelectorAll('.gs-emdia-item')].map((x) => x.textContent).join(',') : '',
      vazio: q('.gc-vazio')?.textContent || '', sinc: { vis: !q('[data-gs="sinc"]').hidden, des: q('[data-gs="sinc"]').disabled, txt: q('[data-gs="sinc"]').textContent, tom: q('[data-gs="sinc"]').dataset.tom || '' },
      enviar: { vis: !q('[data-gs="enviar"]').hidden, des: q('[data-gs="enviar"]').disabled, txt: q('[data-gs="enviar"]').textContent, solido: q('[data-gs="enviar"]').classList.contains('solido'), tom: q('[data-gs="enviar"]').dataset.tom || '' },
      msg: q('[data-gs="msg"]').textContent, lido: q('[data-gs="lido"]').textContent }; })()`);

  // /repos/* falsos dentro da página. O app exemplo começa com 2 commits para enviar e 1 arquivo
  // sem commit; o push pede confirmação (409) e zera os commits; o buscar traz 3 commits e o pull os recebe.
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const orig = window.fetch;
    const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const status = (o) => Object.assign({ branch: 'main', destacado: null, upstream: 'origin/main', adiante: 0, atras: 0, semCommits: false, alteracoes: 0, arquivos: [], truncado: false, operacao: null, buscadoEm: Date.now() - 20 * 60e3, lidoEm: Date.now(), ultimo: { hash: 'a1b2c3d4e5f6', msg: 'Tela de login nova', quando: H(5) } }, o);
    const app = { chave: 'd:\\\\dev\\\\projetos\\\\exemplo\\\\app exemplo', nome: 'app exemplo', pasta: 'D:\\\\Dev\\\\Projetos\\\\Exemplo\\\\app exemplo', existe: true, origem: 'sessao', bloqueado: null, git: true,
      repo: { completo: 'usuario/exemplo', dono: 'usuario', nome: 'exemplo', url: 'https://github.com/usuario/exemplo' }, remoto: { url: 'https://github.com/usuario/exemplo.git', github: true },
      status: status({ adiante: 2, alteracoes: 1, arquivos: [{ caminho: 'src/login.tsx', tipo: 'modificado', preparado: false }] }) };
    const orbit = { chave: 'd:\\\\dev\\\\projetos\\\\gerenciador', nome: 'Gerenciador', pasta: 'D:\\\\Dev\\\\Projetos\\\\Gerenciador', existe: true, origem: 'sessao', bloqueado: null, git: true,
      repo: { completo: 'usuario/painel', dono: 'usuario', nome: 'painel', url: 'https://github.com/usuario/painel' }, remoto: { url: 'https://github.com/usuario/painel.git', github: true }, status: status({}) };
    const site = { chave: 'd:\\\\dev\\\\projetos\\\\exemplo\\\\site', nome: 'site', pasta: 'D:\\\\Dev\\\\Projetos\\\\Exemplo\\\\site', existe: true, origem: 'sessao', bloqueado: null, git: false, repo: null, remoto: null, status: null };
    // api-exemplo: .git vazio (vínculo pela metade) e um clone por branch nas subpastas.
    const RAIZ = 'D:\\\\Dev\\\\Projetos\\\\Exemplo\\\\api-exemplo';
    const repoCf = { completo: 'usuario/exemplo', dono: 'usuario', nome: 'exemplo', url: 'https://github.com/usuario/exemplo' };
    const remCf = { url: 'https://github.com/usuario/exemplo.git', github: true };
    const filho = (n, o) => ({ chave: (RAIZ + '\\\\' + n).toLowerCase(), nome: n, pasta: RAIZ + '\\\\' + n, existe: true, origem: 'subpasta', bloqueado: null, git: true, repo: repoCf, remoto: remCf, subrepos: [], mae: RAIZ,
      status: status(Object.assign({ branch: n, upstream: 'origin/' + n, ultimo: { hash: n + '0011223344', msg: 'Último de ' + n, quando: H(1) } }, o)) });
    const api = { chave: RAIZ.toLowerCase(), nome: 'api-exemplo', pasta: RAIZ, existe: true, origem: 'sessao', bloqueado: null, git: true, repo: repoCf, remoto: remCf,
      subrepos: ['app', 'brain', 'main'].map((n) => RAIZ + '\\\\' + n), status: status({ semCommits: true, upstream: null, ultimo: null, alteracoes: 4 }) };
    const filhos = [filho('app', { adiante: 1 }), filho('brain', {}), filho('main', { adiante: 3, alteracoes: 2, arquivos: [{ caminho: 'vercel.json', tipo: 'modificado' }, { caminho: 'novo.md', tipo: 'nao-rastreado' }] })];
    const todos = [app, api, ...filhos];
    const porPasta = (c) => todos.find((p) => p.pasta === (c && c.pasta)) || app;
    window.__f = { pedidos: [], app, filhos, geradas: {} };
    const PERFIL = { nome: 'Usuário', seguro: true, github: { login: 'usuario', nome: 'Usuário Teste', avatar: null, expirado: false } };
    const resp = (s, c) => new Response(JSON.stringify(c), { status: s, headers: { 'content-type': 'application/json' } });
    const copia = (x) => JSON.parse(JSON.stringify(x));
    window.fetch = (u, op = {}) => {
      const rota = new URL(String(u), location.href).pathname;
      if (rota === '/perfil') return Promise.resolve(resp(200, PERFIL));
      if (!rota.startsWith('/repos/')) return orig(u, op);
      const corpo = op.body ? JSON.parse(op.body) : null;
      window.__f.pedidos.push({ rota, metodo: op.method || 'GET', corpo });
      if (rota === '/repos/projetos') return Promise.resolve(resp(200, { projetos: copia([orbit, app, site, api, ...filhos]), pastaClones: '', github: { conectado: true, login: 'usuario', expirado: false } }));
      if (rota === '/repos/github') return Promise.resolve(resp(200, { login: 'usuario', lidoEm: Date.now(), repos: [{ completo: 'usuario/exemplo', dono: 'usuario', nome: 'exemplo', visibilidade: 'privado' }, { completo: 'usuario/painel', dono: 'usuario', nome: 'painel', visibilidade: 'privado' }] }));
      if (rota === '/repos/push') {
        const alvo = porPasta(corpo), n = alvo.status.adiante;
        if (corpo.confirmar && window.__f.rejeitar) { window.__f.rejeitar = false; alvo.status.atras = 1; return Promise.resolve(resp(409, { codigo: 'rejeitado', erro: 'O GitHub tem commits que você ainda não tem. Receba antes de enviar.', projeto: copia(alvo) })); }
        if (!corpo.confirmar) return Promise.resolve(resp(409, { codigo: 'confirmar', titulo: 'Enviar para o GitHub?', mensagem: n + (n === 1 ? ' commit vai' : ' commits vão') + ' para origin/' + alvo.status.branch + ' no GitHub.', itens: alvo === app ? ['a1b2c3d Tela de login nova', '9f8e7d6 Ajuste no cadastro'] : ['abc1234 Commit de ' + alvo.nome], botao: 'Enviar' }));
        alvo.status.adiante = 0;
        return Promise.resolve(resp(200, { ok: true, projeto: copia(alvo), enviados: n }));
      }
      if (rota === '/repos/buscar') { app.status.atras = 3; app.status.buscadoEm = Date.now(); return Promise.resolve(resp(200, { ok: true, projeto: copia(app), buscou: true })); }
      if (rota === '/repos/pull' && corpo.mesclar) {
        // Juntar: __f.conflito faz o merge dar conflito (desfeito; com manterConflito, fica aberto).
        const alvo = porPasta(corpo), f = window.__f;
        if (f.conflito && !corpo.manterConflito) return Promise.resolve(resp(409, { codigo: 'conflito', erro: 'A mesclagem daria conflito nestes arquivos, então o Orbit desfez tudo. Nada mudou.', arquivos: ['a.txt'], projeto: copia(alvo) }));
        if (f.conflito) {
          f.conflito = false;
          Object.assign(alvo.status, { operacao: 'merge', alteracoes: 1, arquivos: [{ caminho: 'a.txt', tipo: 'conflito', preparado: false }] });
          return Promise.resolve(resp(409, { codigo: 'resolver', erro: 'A junção ficou aberta com conflito em 1 arquivo.', arquivos: ['a.txt'], projeto: copia(alvo) }));
        }
        const n = alvo.status.atras; alvo.status.atras = 0; alvo.status.adiante += 1;
        return Promise.resolve(resp(200, { ok: true, projeto: copia(alvo), recebidos: n }));
      }
      if (rota === '/repos/pull') {
        const alvo = porPasta(corpo);
        if (!corpo.confirmar && alvo.status.alteracoes) return Promise.resolve(resp(409, { codigo: 'confirmar', titulo: 'Receber com alterações locais?', mensagem: 'Você tem 1 alteração não commitada.', botao: 'Receber' }));
        const n = alvo.status.atras; alvo.status.atras = 0; alvo.status.ultimo = { hash: 'ffee00112233', msg: 'Commit do Mac', quando: H(0.2) };
        return Promise.resolve(resp(200, { ok: true, projeto: copia(alvo), recebidos: n }));
      }
      if (rota === '/repos/previa') {
        const alvo = porPasta(corpo), f = window.__f;
        const geradas = (f.geradas && f.geradas[alvo.nome]) || [];
        return Promise.resolve(resp(200, { ok: true, branch: alvo.status.branch, upstream: alvo.status.upstream, adiante: alvo.status.adiante, atras: alvo.status.atras, semCommits: false, operacao: null,
          arquivos: alvo.status.alteracoes, conflitos: 0, lista: alvo.status.arquivos.map((a) => a.caminho + ' (' + a.tipo + ')'), sugestao: 'Atualiza vercel', sensiveis: [], credenciais: [], grandes: [], enormes: [], geradas }));
      }
      if (rota === '/repos/ignorar') {
        const alvo = porPasta(corpo);
        if (!corpo.confirmar) return Promise.resolve(resp(409, { codigo: 'confirmar', titulo: 'Ignorar no git?', mensagem: 'x', itens: corpo.padroes, botao: 'Ignorar' }));
        window.__f.geradas[alvo.nome] = [];
        alvo.status.arquivos = alvo.status.arquivos.filter((a) => a.caminho !== '.DS_Store').concat([{ caminho: '.gitignore', tipo: 'nao-rastreado' }]);
        alvo.status.alteracoes = alvo.status.arquivos.length;
        return Promise.resolve(resp(200, { ok: true, projeto: copia(alvo), ignorados: corpo.padroes }));
      }
      if (rota === '/repos/commit') {
        const alvo = porPasta(corpo);
        Object.assign(alvo.status, { alteracoes: 0, arquivos: [], adiante: alvo.status.adiante + 1, ultimo: { hash: 'abc1234def56', msg: corpo.mensagem, quando: H(0) } });
        return Promise.resolve(resp(200, { ok: true, projeto: copia(alvo), commit: { sha: 'abc1234', titulo: corpo.mensagem } }));
      }
      if (rota === '/repos/concluir') {
        const alvo = porPasta(corpo);
        if (window.__f.marcas) { window.__f.marcas = false; return Promise.resolve(resp(409, { codigo: 'marcas', erro: 'Ainda há trechos com <<<<<<< em a.txt. Escolha o que fica, apague as marcas, salve e conclua de novo. Nada mudou.', arquivos: ['a.txt'] })); }
        Object.assign(alvo.status, { operacao: null, alteracoes: 0, arquivos: [], adiante: alvo.status.adiante + 1, atras: 0 });
        return Promise.resolve(resp(200, { ok: true, projeto: copia(alvo), commit: { sha: 'm3rg3aa' }, resolvidos: 1 }));
      }
      if (rota === '/repos/branches') {
        const alvo = porPasta({ pasta: new URL(String(u), location.href).searchParams.get('pasta') });
        return Promise.resolve(resp(200, { atual: alvo.status.branch, locais: [{ nome: alvo.status.branch, upstream: 'origin/' + alvo.status.branch, adiante: 0, atras: 0 }], remotos: ['app', 'brain', 'main'].filter((n) => n !== alvo.status.branch).map((nome) => ({ nome })) }));
      }
      if (rota === '/repos/branch') {
        const alvo = porPasta(corpo);
        Object.assign(alvo.status, { branch: corpo.nome, upstream: corpo.criar ? null : 'origin/' + corpo.nome });
        return Promise.resolve(resp(200, { ok: true, projeto: copia(alvo) }));
      }
      return Promise.resolve(resp(404, { erro: 'não encontrado' }));
    };
  })()` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: BASE + '/?abas=0' });
  await esperar(`!!window.Sincronia && !!document.querySelector('#sincronia-card .gc-vazio')`, 8000);

  // Sem filtro: o card fica à vista com "Sem projeto" e o convite para filtrar; sem botões.
  let c = await lerCard();
  const visivel = await av(`!!document.getElementById('sincronia-card').getClientRects().length`);
  conferir(visivel && c.estado === 'Sem projeto' && /Escolha um projeto no filtro/.test(c.vazio) && !c.linhas.length && !c.sinc.vis && !c.enviar.vis, 'sem filtro: card visível, "Sem projeto" e sem botões', { visivel, c });
  conferir(!(await av(`window.__f.pedidos.some((p) => p.rota.startsWith('/repos/') && p.rota !== '/repos/projetos')`)), 'sem filtro: nenhum pedido de ação em /repos/*');

  // Filtro "app exemplo": o repositório dele.
  await filtrar('app exemplo');
  await esperar(`/exemplo/.test(document.querySelector('#sincronia-card .gs-id-repo')?.textContent || '') && /Privado/.test(document.querySelector('#sincronia-card .gs-id-repo').textContent)`);
  c = await lerCard();
  const l = c.linhas[0] || {};
  conferir(c.linhas.length === 1 && /exemplo/.test(c.repo) && !/painel/.test(c.repo) && /Privado/.test(c.repo), 'filtro app exemplo: identidade exemplo com Privado', c);
  conferir(l.id === 'projeto' && l.nome === 'Código' && l.branch === 'main' && l.commit === 'Tela de login nova' && l.hash === 'a1b2c3d' && !l.envio, 'linha: Código, main, último commit e hash, sem "enviado há"', l);
  conferir(JSON.stringify(l.chips) === JSON.stringify(['1 alteração', '2 commits']), 'números: 1 alteração e 2 commits', l.chips);
  conferir(c.estado === 'Para enviar' && c.enviar.vis && !c.enviar.des && c.enviar.solido && c.sinc.vis && !c.sinc.des && /Buscado/.test(c.lido), 'estado "Para enviar", Enviar sólido, Sincronizar e "Buscado há…"', c);
  const linkGh = await av(`document.querySelector('#sincronia-card .gs-abrir')?.href || ''`);
  conferir(linkGh === 'https://github.com/usuario/exemplo', 'link do GitHub aponta para o exemplo', linkGh);
  await foto('1-exemplo-para-enviar');

  // Enviar: o balão do servidor, depois o push confirmado.
  await av(`document.querySelector('#sincronia-card [data-gs="enviar"]').click(), true`);
  await esperar(`!document.getElementById('balao').hidden`);
  const bal = await av(`({ tit: document.getElementById('balao-tit').textContent, txt: document.getElementById('balao-txt').textContent, sim: document.getElementById('balao-sim').textContent })`);
  conferir(bal.tit === 'Enviar para o GitHub?' && /2 commits/.test(bal.txt) && /Tela de login nova/.test(bal.txt) && bal.sim === 'Enviar', 'Enviar: balão com os commits do servidor', bal);
  await foto('2-balao-enviar');
  await av(`document.getElementById('balao-sim').click(), true`);
  await esperar(`document.querySelector('#sincronia-card [data-gs="enviar"]').textContent === 'Enviado'`);
  const push = await av(`window.__f.pedidos.filter((p) => p.rota === '/repos/push').map((p) => ({ pasta: p.corpo.pasta, confirmar: !!p.corpo.confirmar }))`);
  conferir(push.length === 2 && !push[0].confirmar && push[1].confirmar && push.every((p) => /app exemplo$/.test(p.pasta)), 'push: pedido e confirmação na pasta do app exemplo', push);
  c = await lerCard();
  conferir(c.enviar.txt === 'Enviado' && c.enviar.tom === 'ok' && /Enviado: 2 commits/.test(c.msg) && JSON.stringify(c.linhas[0].chips) === JSON.stringify(['1 alteração']), 'depois do envio: "Enviado", mensagem e só a alteração sem commit', c);
  await foto('3-enviado');

  // Sincronizar: busca (3 novidades) e recebe, com a confirmação das alterações locais.
  await esperar(`document.querySelector('#sincronia-card [data-gs="enviar"]').hidden`, 5000);
  c = await lerCard();
  conferir(!c.enviar.vis && c.sinc.vis, 'nada para enviar nem novidades: o Enviar some e fica só o Sincronizar', c.enviar);
  await av(`document.querySelector('#sincronia-card [data-gs="sinc"]').click(), true`);
  await esperar(`!document.getElementById('balao').hidden`);
  const bal2 = await av(`document.getElementById('balao-tit').textContent`);
  conferir(bal2 === 'Receber com alterações locais?', 'Sincronizar: o pull pede confirmação por causa da alteração local', bal2);
  await av(`document.getElementById('balao-sim').click(), true`);
  await esperar(`document.querySelector('#sincronia-card [data-gs="sinc"]').textContent === 'Sincronizado'`);
  c = await lerCard();
  const rotas = await av(`window.__f.pedidos.filter((p) => p.metodo === 'POST').map((p) => p.rota + (p.corpo.confirmar ? '!' : ''))`);
  conferir(JSON.stringify(rotas) === JSON.stringify(['/repos/push', '/repos/push!', '/repos/buscar', '/repos/pull', '/repos/pull!']), 'Sincronizar: buscar, pull pedido e confirmado', rotas);
  conferir(/Recebido do GitHub: 3 commits/.test(c.msg) && c.linhas[0].commit === 'Commit do Mac' && c.sinc.tom === 'ok', 'depois de receber: mensagem e o último commit novo', c);
  await foto('4-sincronizado');

  // Puxar (no lugar do Enviar, só com novidades vistas): o /repos/pull, com a confirmação das alterações locais.
  await esperar(`document.querySelector('#sincronia-card [data-gs="enviar"]').hidden`, 5000);
  await av(`window.__f.app.status.atras = 4, true`);
  await filtrar(''); await filtrar('app exemplo');
  await esperar(`(() => { const b = document.querySelector('#sincronia-card [data-gs="enviar"]'); return !b.hidden && b.textContent === 'Puxar'; })()`, 5000);
  await av(`document.querySelector('#sincronia-card [data-gs="enviar"]').click(), true`);
  await esperar(`!document.getElementById('balao').hidden`);
  await av(`document.getElementById('balao-sim').click(), true`);
  await esperar(`document.querySelector('#sincronia-card [data-gs="enviar"]').textContent === 'Atualizado'`);
  c = await lerCard();
  const pulls = await av(`window.__f.pedidos.filter((p) => p.rota === '/repos/pull').length`);
  conferir(pulls === 4 && c.enviar.tom === 'ok' && /Recebido do GitHub: 4 commits/.test(c.msg), 'Puxar: pull pedido e confirmado, "Atualizado" e a mensagem', { pulls, c });
  await foto('4b-puxado');

  // Subpastas com repositório próprio: uma linha por clone (app, brain, main), sem a linha do .git vazio de cima.
  // As iguais ao GitHub (20/10) saem da lista e viram um botão na linha "Iguais ao GitHub".
  await filtrar('api-exemplo');
  await esperar(`document.querySelectorAll('#sincronia-card .gs-repo').length === 2`);
  c = await lerCard();
  conferir(JSON.stringify(c.linhas.map((x) => x.nome + '/' + x.branch)) === JSON.stringify(['app/app', 'main/main']) && c.emDia === 'Iguais ao GitHub: brain' && /exemplo/.test(c.repo) && /Privado/.test(c.repo), 'subpastas: uma linha por clone com o que fazer, e a em dia (brain) só na linha de baixo', c);
  conferir(!c.linhas.some((x) => /Ainda não há commits/.test(x.aviso)) && c.linhas.every((x) => x.id.startsWith('projeto-')), 'subpastas: o .git vazio da pasta de cima não aparece', c.linhas);
  conferir(JSON.stringify(c.linhas.map((x) => x.chips)) === JSON.stringify([['1 commit'], ['2 alterações', '3 commits']]) && c.linhas[0].commit === 'Último de app', 'subpastas: números e último commit de cada uma', c.linhas);
  conferir(c.estado === 'Para enviar' && c.enviar.txt === 'Enviar' && c.enviar.solido && !c.enviar.des, 'subpastas: "Para enviar" e Enviar sólido', c);
  await foto('6-subpastas');
  const antes = await av(`window.__f.pedidos.length`);
  await av(`document.querySelector('#sincronia-card [data-gs="enviar"]').click(), true`);
  await esperar(`!document.getElementById('balao').hidden`);
  const bal3 = await av(`({ tit: document.getElementById('balao-tit').textContent, txt: document.getElementById('balao-txt').textContent })`);
  conferir(bal3.tit === 'Enviar para o GitHub?' && /app: 1 commit vai para origin\/app/.test(bal3.txt) && /main: 3 commits vão para origin\/main/.test(bal3.txt) && !/brain:/.test(bal3.txt), 'subpastas: um balão só com app e main (brain está em dia)', bal3);
  await foto('7-balao-subpastas');
  await av(`document.getElementById('balao-sim').click(), true`);
  await esperar(`document.querySelector('#sincronia-card [data-gs="enviar"]').textContent === 'Enviado'`);
  const push2 = await av(`window.__f.pedidos.slice(${antes}).filter((p) => p.rota === '/repos/push').map((p) => p.corpo.pasta.split('\\\\').pop() + (p.corpo.confirmar ? '!' : ''))`);
  conferir(JSON.stringify(push2) === JSON.stringify(['app', 'main', 'app!', 'main!']), 'subpastas: push pedido e confirmado em app e main', push2);
  c = await lerCard();
  conferir(/Enviado: app \(1 commit\), main \(3 commits\)\./.test(c.msg) && JSON.stringify(c.linhas.map((x) => x.chips)) === JSON.stringify([['2 alterações']]) && c.emDia === 'Iguais ao GitHub: app,brain', 'subpastas: mensagem por clone; só main (alterações sem commit) fica na lista', c);
  await foto('8-subpastas-enviado');

  // ── ações de cada linha (18/10): Salvar e enviar com .DS_Store ignorado, mensagem editada e envio recusado → junta ──
  const botoesLinha = () => av(`[...document.querySelectorAll('#sincronia-card .gs-repo')].map((r) => r.querySelector('.gs-nome').textContent + ':' + [...r.querySelectorAll('.gs-linha-acoes button')].map((b) => b.textContent).join('|'))`);
  await esperar(`!document.querySelector('#sincronia-card .gs-linha-acoes button[disabled]')`);
  let bl = await botoesLinha();
  conferir(JSON.stringify(bl) === JSON.stringify(['main:Salvar e enviar|Ignorar|Branch']), 'cada linha com os botões do estado dela', bl);
  await foto('9-acoes-linha');
  await av(`(window.__f.geradas.main = [{ padrao: '.DS_Store', motivo: 'arquivo que o sistema cria sozinho', arquivos: 1 }], window.__f.rejeitar = true, true)`);
  const n0 = await av(`window.__f.pedidos.length`);
  const clicarLinha = (nome, acao) => av(`(() => { const r = [...document.querySelectorAll('#sincronia-card .gs-repo')].find((x) => x.querySelector('.gs-nome').textContent === ${JSON.stringify(nome)}); r.querySelector('.gs-linha-acoes [data-acao="${acao}"]').click(); return true; })()`);
  await clicarLinha('main', 'salvar');
  await esperar(`!document.getElementById('balao').hidden && document.getElementById('balao-tit').textContent === 'Deixar fora do git?'`);
  const b1 = await av(`document.getElementById('balao-txt').textContent`);
  conferir(/\.DS_Store — 1 arquivo, arquivo que o sistema cria sozinho/.test(b1), 'Salvar: oferece deixar o .DS_Store fora do git', b1);
  await av(`document.getElementById('balao-sim').click(), true`);
  await esperar(`!document.getElementById('balao').hidden && document.getElementById('balao-tit').textContent === 'Salvar e enviar main?'`);
  const b2 = await av(`({ txt: document.getElementById('balao-txt').textContent, campo: document.getElementById('balao-campo').value, vis: !document.getElementById('balao-campo').hidden, sim: document.getElementById('balao-sim').textContent })`);
  conferir(b2.vis && b2.campo === 'Atualiza vercel' && /3 arquivos vão num commit no branch main e vão para origin\/main/.test(b2.txt) && /vercel\.json/.test(b2.txt) && b2.sim === 'Salvar e enviar', 'Salvar: balão com a mensagem sugerida, o destino e os arquivos', b2);
  await foto('10-balao-mensagem');
  await av(`(document.getElementById('balao-campo').value = 'Deploy: vercel.json novo', document.getElementById('balao-sim').click(), true)`);
  await esperar(`/salvo e enviado/.test(document.querySelector('#sincronia-card [data-gs="msg"]').textContent)`);
  const rot2 = await av(`window.__f.pedidos.slice(${n0}).filter((p) => p.metodo === 'POST').map((p) => p.rota + (p.corpo.confirmar ? '!' : '') + (p.corpo.mesclar ? '+mesclar' : '') + (p.corpo.mensagem ? '=' + p.corpo.mensagem : ''))`);
  conferir(JSON.stringify(rot2) === JSON.stringify(['/repos/previa', '/repos/ignorar!', '/repos/previa', '/repos/commit!=Deploy: vercel.json novo', '/repos/push!', '/repos/pull!+mesclar', '/repos/push!']), 'Salvar: prévia, ignorar, commit com a mensagem, envio recusado, junta e envia', rot2);
  c = await lerCard();
  conferir(/main: salvo e enviado para origin\/main \(commit abc1234\)\./.test(c.msg) && !c.linhas.length && c.emDia === 'Tudo igual ao GitHub: app,brain,main', 'depois de salvar: mensagem e main some da lista (tudo igual ao GitHub)', c);
  await foto('11-salvo-enviado');

  // ── conflito: Juntar e enviar → abrir para resolver → Concluir (recusa com marcas, depois conclui e envia) ──
  await av(`(Object.assign(window.__f.filhos[0].status, { adiante: 1, atras: 2 }), window.__f.conflito = true, window.__f.marcas = true, true)`);
  await av(`window.Sincronia.projetoMudou && (document.querySelector('#sincronia-card [data-gs="sinc"]').disabled = false), true`);
  await esperar(`[...document.querySelectorAll('#sincronia-card .gs-linha-acoes button')].some((b) => b.textContent === 'Juntar e enviar')`, 35000);
  await clicarLinha('app', 'juntar');
  await esperar(`!document.getElementById('balao').hidden && document.getElementById('balao-tit').textContent === 'Juntar com o GitHub e enviar?'`);
  await av(`document.getElementById('balao-sim').click(), true`);
  await esperar(`!document.getElementById('balao').hidden && document.getElementById('balao-tit').textContent === 'Resolver o conflito no editor?'`);
  const b3 = await av(`document.getElementById('balao-txt').textContent`);
  conferir(/mesmas linhas de a\.txt/.test(b3) && /nada se perdeu/.test(b3), 'conflito: explica e oferece abrir para resolver', b3);
  await av(`document.getElementById('balao-sim').click(), true`);
  await esperar(`/Junção aberta com conflito em a\.txt/.test(document.querySelector('#sincronia-card .gs-repo .gs-aviso')?.textContent || '')`);
  bl = await botoesLinha();
  c = await lerCard();
  conferir(bl[0] === 'app:Concluir e enviar|Cancelar junção' && c.estado === 'Conflito' && /junção aberta/.test(c.msg), 'junção aberta: aviso, estado Conflito e os botões Concluir e Cancelar', { bl, c });
  await foto('12-juncao-aberta');
  await clicarLinha('app', 'concluir');
  await esperar(`/Ainda há trechos/.test(document.querySelector('#sincronia-card [data-gs="msg"]').textContent)`);
  conferir(true, 'Concluir com marcas: mostra o que falta');
  await clicarLinha('app', 'concluir');
  await esperar(`/app: salvo e enviado/.test(document.querySelector('#sincronia-card [data-gs="msg"]').textContent)`);
  bl = await botoesLinha();
  c = await lerCard();
  conferir(!bl.length && /app/.test(c.emDia), 'Concluir: junção fechada e enviada; app volta para a linha das em dia', { bl, c });

  // ── menu Branch: lista e cria um branch novo ──
  await av(`document.querySelector('#sincronia-card .gs-emdia-item[data-repo$="_brain"]').click(), true`);
  await esperar(`!!document.querySelector('.gs-menu .gs-menu-item')`);
  const menuTxt = await av(`[...document.querySelectorAll('.gs-menu .gs-menu-item, .gs-menu .gs-menu-sec')].map((x) => x.textContent)`);
  conferir(JSON.stringify(menuTxt) === JSON.stringify(['brain', 'Só no GitHub', 'appbaixar', 'mainbaixar', 'Novo branch…']), 'menu Branch: o atual, os do GitHub e Novo branch', menuTxt);
  await foto('13-menu-branch');
  await av(`document.querySelector('.gs-menu .gs-menu-novo').click(), true`);
  await esperar(`!document.getElementById('balao').hidden && document.getElementById('balao-tit').textContent === 'Novo branch em brain'`);
  conferir(!(await av(`!!document.querySelector('.gs-menu')`)), 'o menu fecha ao escolher');
  await av(`(document.getElementById('balao-campo').value = 'notas novas', document.getElementById('balao-sim').click(), true)`);
  await esperar(`[...document.querySelectorAll('#sincronia-card .gs-branch')].some((b) => b.textContent === 'notas-novas')`);
  const br = await av(`window.__f.pedidos.filter((p) => p.rota === '/repos/branch').map((p) => p.corpo)`);
  c = await lerCard();
  conferir(br.length === 1 && br[0].nome === 'notas-novas' && br[0].criar === true && /branch notas-novas criado/.test(c.msg) && c.linhas.length === 1 && /o Enviar cria e liga o branch/.test(c.linhas[0].aviso), 'Novo branch: cria (espaços viram -), troca e a linha avisa que o Enviar o cria no GitHub', { br, c });
  bl = await botoesLinha();
  conferir(bl[0] === 'brain:Criar branch no GitHub|Branch', 'branch novo: a linha oferece criar no GitHub', bl);

  // Projeto sem git (site): mensagem, sem botões.
  await filtrar('site');
  await esperar(`/ainda não tem git/.test(document.querySelector('#sincronia-card .gc-vazio')?.textContent || '')`);
  c = await lerCard();
  conferir(c.estado === 'Sem git' && !c.sinc.vis && !c.enviar.vis && /site ainda não tem git/.test(c.vazio), 'projeto sem git: "Sem git", sem botões', c);
  await foto('5-sem-git');

  // Um projeto com git já em dia (Gerenciador): uma linha só, igual ao GitHub, e o repositório dele na identidade.
  await filtrar('Gerenciador');
  await esperar(`/painel/.test(document.querySelector('#sincronia-card .gs-id-repo')?.textContent || '')`);
  c = await lerCard();
  conferir(/painel/.test(c.repo) && c.linhas.length === 1 && c.estado === 'Em dia' && !c.enviar.vis, 'projeto em dia: painel, uma linha e "Em dia"', { c, lat: await av(`[...document.querySelectorAll('#projetos .proj-item')].map((b) => b.dataset.proj + (b.getAttribute('aria-pressed') || b.className))`) });

  // Tirar o filtro volta ao "Sem projeto".
  await filtrar('app exemplo');
  await esperar(`/exemplo/.test(document.querySelector('#sincronia-card .gs-id-repo')?.textContent || '')`);
  await filtrar('');
  await esperar(`!!document.querySelector('#sincronia-card .gc-vazio')`);
  c = await lerCard();
  conferir(c.estado === 'Sem projeto' && !c.linhas.length && /Escolha um projeto/.test(c.vazio), 'sem o filtro: volta ao "Sem projeto"', c);

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
