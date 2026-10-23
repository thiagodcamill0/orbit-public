// Servidor FALSO da porta remota (Orbit no celular), só para testar a interface mobile sem o servidor real.
// Serve a pasta mobile/ pela MESMA lista do servidor real (ARQUIVOS_MOBILE de remoto.mjs; arquivo que não existe → 404) e os
// arquivos de PWA do disco, e responde às rotas do contrato (contrato "Celular premium (21/10)") com dados de exemplo e o
// cabeçalho CSP do contrato. As respostas seguem o formato do servidor real (remoto.mjs, servidor.mjs, controle.mjs, ideias.mjs);
// o que muda de estado sai também pelo SSE /fluxo (evento `sessao`).
// Não é o servidor real: o cookie aqui se chama `orbit-mock` (o real é `__Host-orbit`, que exige HTTPS) e não há Tailscale.
//   node testes/mobile-mock.mjs [porta]     sobe numa porta livre de 47822–47826 (nunca a 47821) e imprime a URL
//   import { subirMock } from './mobile-mock.mjs'     usado por mobile-ui.test.mjs
// Rotas de teste (só aqui): GET /_mock/log, GET /_mock/codigo, POST /_mock/{expirar,desbloquear,mudar,uso,uso-bloqueio,limpar-log},
// POST /_mock/cair (fecha os SSE e responde 503 a tudo, menos /_mock/*) e POST /_mock/voltar (desfaz). Todo POST do mock exige
// Origin igual à base e corpo application/json (mande `{}`).
// Também: POST /_mock/reiniciar devolve sessões, conversas, log e chaves de teste ao começo e difunde `inicio` no SSE (o token de
// pareamento fica). Chaves de teste em `estado` (o teste roda no mesmo processo e pode mexê-las direto):
//   estado.criarInstancias = false      → /remoto/eu diz opcoes.criarInstancias=false e /remoto/projetos responde 403
//   estado.msg = { atraso, falhar, semEco }  → na próxima(s) mensagem(ns): atrasa `atraso` ms antes de responder/empurrar o item,
//                                        responde o status `falhar` (ex. 500) sem efeito, ou não empurra o item do usuário (semEco)
//   estado.forcarPermissao = 404 | 409  → o PRÓXIMO POST /sessao/:id/permissao responde esse status sem mexer em nada (e a chave se apaga)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { ARQUIVOS_MOBILE, comandoDoTexto } from '../remoto.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Cabeçalhos do contrato para a porta remota.
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const CABECALHOS = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

const TIPOS = { '.png': 'image/png', '.woff2': 'font/woff2', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
// Fora da lista do app (ARQUIVOS_MOBILE): o service worker e a tela offline.
const ARQ_PWA = {
  '/sw.js': ['pwa/sw.js', 'text/javascript; charset=utf-8'],
  '/offline.html': ['pwa/offline.html', 'text/html; charset=utf-8'],
};
// De assets/: a mesma lista do remoto.mjs (RE_ASSET).
const RE_ASSET = /^\/assets\/(?:comum\/base\.(?:css|js)|comum\/widgets\.js|comum\/(?:componentes\.css|icones\.js|sprites\.js|md\.js|cartoes\.js)|sprites\/sprite-[\w-]+\.(?:gif|png)|pwa\/(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*|[\w@-][\w.@-]*\.woff2)$/;
// Comandos com barra aceitos (o real: /compact, /clear e as skills/comandos do projeto ou do usuário).
const COMANDOS_OK = new Set(['compact', 'clear', 'minha-skill']);
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function dadosIniciais() {
  const agora = Date.now();
  const min = 60e3;
  const ctl = (extra = {}) => ({ modo: 'orbit', podeAssumir: false, motivo: 'Já está no Orbit', ocupada: true, processo: 'vivo', modelo: 'default', esforco: 'high', modoPermissao: 'default', ...extra });
  const sessoes = [
    { id: 's1', status: 'aguardando', projeto: 'Orbit', cwd: 'D:\\Projetos\\Orbit', titulo: 'Corrigir os testes do pareamento', contexto: { tokens: 150000, modelo: 'claude-opus-4-5' }, desde: agora - 12 * min, atividade: agora - 12 * min,
      controle: ctl({ permissao: { id: 'perm-1', tipo: 'ferramenta', ferramenta: 'Bash', resumo: 'npm test -- --grep pareamento', entrada: { command: 'npm test -- --grep pareamento' }, sugestoes: [{ indice: 0, rotulo: 'Sempre permitir npm test' }] }, pendentes: 1 }) },
    { id: 's2', status: 'aguardando', projeto: 'Cliente Exemplo', cwd: 'D:\\Projetos\\Cliente Exemplo', titulo: 'Escolher o banco de dados', desde: agora - 5 * min, atividade: agora - 5 * min,
      controle: ctl({ permissao: { id: 'perm-2', tipo: 'pergunta', ferramenta: 'AskUserQuestion', resumo: 'Qual banco usar?', perguntas: [{ pergunta: 'Qual banco usar?', cabecalho: 'Banco', multipla: false, opcoes: [{ rotulo: 'SQLite', descricao: 'Arquivo local, sem servidor' }, { rotulo: 'Postgres', descricao: 'Servidor dedicado' }] }] }, pendentes: 1 }) },
    { id: 's3', status: 'aguardando', projeto: 'Loja Online', cwd: 'D:\\Projetos\\Loja', titulo: 'Nova tela de checkout', desde: agora - 2 * min, atividade: agora - 2 * min,
      controle: ctl({ modoPermissao: 'plan', permissao: { id: 'perm-3', tipo: 'plano', ferramenta: 'ExitPlanMode', resumo: 'Plano', plano: '## Plano\n\n- Criar a tela de **checkout**\n- Ligar ao `POST /pedidos`\n- Rodar os testes', sugestoes: [{ indice: 0, rotulo: 'Sim, e aceitar edições', modo: 'acceptEdits' }] }, pendentes: 1 }) },
    { id: 's4', status: 'trabalhando', projeto: 'Diário', cwd: 'D:\\Projetos\\Diario', apelido: 'Refatorar o diário', titulo: 'Refatorar', contexto: { tokens: 400000, modelo: 'claude-sonnet-5-5', janela: 1000000, pct: 40 }, subagentes: 1,
      agentes: [
        { id: 'ag1', tipo: 'Explore', descricao: 'Mapear as telas do diário', status: 'trabalhando', inicio: agora - 3 * min, fim: null, ferramenta: { nome: 'Grep', alvo: 'Diario', desde: agora - 20e3 }, ferramentas: 12, atividade: agora - 20e3 },
        { id: 'ag2', tipo: 'general-purpose', descricao: 'Rodar os testes de unidade', status: 'concluido', inicio: agora - 7 * min, fim: agora - 4 * min, ferramenta: null, ferramentas: 5, atividade: agora - 4 * min },
      ],
      ferramenta: { nome: 'Edit', alvo: 'Diario.tsx', desde: agora - 30e3 }, detalhe: 'Editando Diario.tsx', desde: agora - 8 * min, atividade: agora - 30e3,
      controle: ctl({ tarefas: [{ id: 'bg1', tipo: 'local_bash', descricao: 'npm run dev (servidor local)' }, { id: 'bg2', tipo: 'local_agent', descricao: 'Revisar acessibilidade das telas' }], autoCompactar: { ligada: true, limite: 80, ultima: { quando: agora - 40 * min, antes: 620000, depois: 90000 } } }) },
    { id: 's5', status: 'concluida', projeto: 'Orbit', cwd: 'D:\\Projetos\\Orbit', titulo: 'Revisar o README', contexto: { tokens: 30000, modelo: 'claude-sonnet-4-5' }, desde: agora - 3 * 3600e3, atividade: agora - 3 * 3600e3, revisadaEm: agora - 2 * 3600e3, controle: ctl({ ocupada: false, autoCompactar: { ligada: false, limite: 80, propria: false } }) },
    { id: 's6', status: 'nova', projeto: 'Loja Online', cwd: 'D:\\Projetos\\Loja', titulo: '', primeira: '', desde: agora - 20 * min, atividade: agora - 20 * min, controle: ctl({ ocupada: false, processo: 'dormindo' }) },
  ];
  const par = (n, quem) => ({ id: quem + n, ts: agora - (100 - n) * 1000, tipo: quem === 'u' ? 'usuario' : 'assistente', texto: quem === 'u' ? 'Pergunta número ' + n : 'Resposta número ' + n + ' com `código` e **negrito**.' });
  const longa = [];
  for (let n = 1; n <= 35; n++) { longa.push(par(n, 'u')); longa.push(par(n, 'a')); }
  const conversas = {
    s1: [
      { id: 'u1', ts: agora - 13 * min, tipo: 'usuario', texto: 'Rode os testes do pareamento e corrija o que falhar' },
      { id: 'a1', ts: agora - 12.5 * min, tipo: 'assistente', texto: 'Vou rodar a suíte primeiro.\n\n- `npm test`\n- Ver as falhas\n\n```js\nconsole.log("oi");\n```' },
      { id: 't1', ts: agora - 12.4 * min, tipo: 'ferramenta', nome: 'Read', resumo: 'servidor.mjs', resultado: { texto: 'linha 1\nlinha 2' } },
      { id: 't2', ts: agora - 12.2 * min, tipo: 'ferramenta', nome: 'Bash', resumo: 'npm test -- --grep pareamento' },
    ],
    s2: [{ id: 'u1', ts: agora - 6 * min, tipo: 'usuario', texto: 'Monte o cadastro' }, { id: 'a1', ts: agora - 5.5 * min, tipo: 'assistente', texto: 'Preciso saber qual banco você prefere.' }],
    s3: [{ id: 'u1', ts: agora - 3 * min, tipo: 'usuario', texto: 'Planeje o checkout' }, { id: 'a1', ts: agora - 2.5 * min, tipo: 'assistente', texto: 'Plano pronto para aprovar.' }],
    s4: longa,
    s5: [{ id: 'u1', ts: agora - 3.1 * 3600e3, tipo: 'usuario', texto: 'Revise o README' }, { id: 'a1', ts: agora - 3 * 3600e3, tipo: 'assistente', texto: 'README revisado.' }],
    s6: [],
  };
  const data = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`; };
  const ideias = [
    { id: 'i-a1b2c3', texto: 'Trocar o som de aviso por um mais discreto', data: data(agora - 2 * 3600e3), feita: false },
    { id: 'i-d4e5f6', texto: 'Mostrar o custo do dia na tela inicial\nSó o total, sem detalhar por sessão', data: data(agora - 26 * 3600e3), feita: false },
    { id: 'i-0a9b8c', texto: 'Atalho para colar o último erro na conversa', data: data(agora - 3 * 86400e3), feita: true },
  ];
  // Histórico de avisos como o historicoNativo() do servidor: sem cwd (só o nome do projeto) e sem ultimaResposta.
  const so = (s, extra = {}) => ({ id: s.id, titulo: s.titulo, apelido: s.apelido || '', nome: '', pai: '', projeto: s.projeto, status: s.status, detalhe: '', tarefa: '', ...extra });
  const [s1, s2, s3, s4, s5] = sessoes;
  const historico = [
    { id: 'h1', tipo: 'concluida', quando: agora - 3 * 3600e3, notificar: true, sessao: so(s5, { tarefa: 'Revise o README' }) },
    { id: 'h2', tipo: 'aguardando', quando: agora - 12 * min, notificar: true, sessao: so(s1, { detalhe: 'Bash: npm test -- --grep pareamento', tarefa: 'Rode os testes do pareamento e corrija o que falhar' }) },
    { id: 'h3', tipo: 'aguardando', quando: agora - 5 * min, notificar: true, sessao: so(s2, { detalhe: 'Qual banco usar?' }) },
    { id: 'h4', tipo: 'aguardando', quando: agora - 2 * min, notificar: true, sessao: so(s3, { detalhe: 'Plano pronto para aprovar' }) },
    { id: 'h5', tipo: 'erro', quando: agora - 40 * min, notificar: false, agente: { id: 'ag2', tipo: 'general-purpose', descricao: 'Rodar os testes de unidade' }, sessao: so(s4, { status: 'erro', detalhe: 'Falha ao rodar os testes' }) },
  ];
  // Grafo do brain (o formato de grafo.mjs, com a pasta só pelo nome): ~12 nós, ligações, um anexo e uma nota que não existe.
  const nota = (id, tags = []) => ({ id, nome: id.slice(id.lastIndexOf('/') + 1).replace(/\.md$/i, ''), tipo: 'nota', tags });
  const nos = [
    nota('00 Índice.md', ['indice']), nota('01 Contexto/Orbit.md', ['projeto']), nota('01 Contexto/Celular.md', ['projeto']),
    nota('02 Decisões/2026-10-20 Orbit no celular.md', ['decisao']), nota('02 Decisões/2026-10-21 Orbit no celular premium.md', ['decisao']),
    nota('03 Tarefas/Mock do celular.md', ['tarefa']), nota('03 Tarefas/Rotas novas.md', ['tarefa']), nota('04 Ideias/Modo escuro.md'),
    nota('04 Ideias/Atalhos.md'), nota('05 Registro/2026-10-21.md', ['diario']),
    { id: 'anexos/mapa.png', nome: 'mapa.png', tipo: 'anexo', tags: [] }, { id: 'Nota que falta', nome: 'Nota que falta', tipo: 'inexistente', tags: [] },
  ];
  const lg = (origem, destino) => ({ origem, destino });
  const links = [
    lg('00 Índice.md', '01 Contexto/Orbit.md'), lg('00 Índice.md', '01 Contexto/Celular.md'), lg('00 Índice.md', '02 Decisões/2026-10-21 Orbit no celular premium.md'),
    lg('01 Contexto/Celular.md', '02 Decisões/2026-10-20 Orbit no celular.md'), lg('02 Decisões/2026-10-21 Orbit no celular premium.md', '02 Decisões/2026-10-20 Orbit no celular.md'),
    lg('02 Decisões/2026-10-21 Orbit no celular premium.md', '03 Tarefas/Mock do celular.md'), lg('02 Decisões/2026-10-21 Orbit no celular premium.md', '03 Tarefas/Rotas novas.md'),
    lg('03 Tarefas/Mock do celular.md', '03 Tarefas/Rotas novas.md'), lg('04 Ideias/Modo escuro.md', '04 Ideias/Atalhos.md'), lg('00 Índice.md', '04 Ideias/Modo escuro.md'),
    lg('05 Registro/2026-10-21.md', '03 Tarefas/Mock do celular.md'), lg('01 Contexto/Orbit.md', 'anexos/mapa.png'), lg('05 Registro/2026-10-21.md', 'Nota que falta'),
  ];
  const textos = Object.fromEntries(nos.filter((n) => n.tipo === 'nota').map((n) => [n.id, `# ${n.nome}\n\nNota de exemplo do mock.\n\n- Ligações: ${links.filter((l) => l.origem === n.id).map((l) => '[[' + l.destino.replace(/\.md$/i, '') + ']]').join(', ') || 'nenhuma'}\n`]));
  return {
    sessoes,
    conversas,
    uso: { cincoHoras: { pct: 42, renova: agora + 2.5 * 3600e3 }, semanal: { pct: 27, renova: agora + 3 * 86400e3 }, atualizado: agora - 2 * min },
    ideias, historico,
    resumoDia: { data: data(agora).slice(0, 10), turnos: 14, msTrabalhando: 47 * min, msAguardando: 9 * min, esperas: 6, sessoes: 6 },
    grafo: { pasta: 'Brain de exemplo', nos, links, truncado: false },
    notas: textos,
  };
}

export async function subirMock({ porta: pedida } = {}) {
  const porta = await escolherPorta(Number(pedida) || 47822);
  const base = `http://127.0.0.1:${porta}`;
  const d = dadosIniciais();
  const sessoes = new Map(d.sessoes.map((s) => [s.id, s]));
  const conversas = new Map(Object.entries(d.conversas));
  const estado = {
    uso: d.uso, tokens: new Set(), pedido: null, bloqueadoAte: 0, seqPedido: 0, log: [], push: null,
    ideias: d.ideias, historico: d.historico, resumoDia: d.resumoDia, grafo: d.grafo, notas: d.notas, seqIdeia: 0, seqAcao: 0,
    naoPerturbe: { ativo: false, agendado: false, inicio: '22:00', fim: '07:00' }, notificar: { precisa: true, terminou: false },
    caido: false, usoBloqueio: null, // /_mock/cair e /_mock/uso-bloqueio ('rodando' | 'lendo' | null)
    projetos: [{ pasta: 'D:\\Projetos\\Orbit', nome: 'Orbit' }, { pasta: 'D:\\Projetos\\Loja', nome: 'Loja Online' }],
    modelos: [
      { valor: 'default', modelo: 'claude-opus-x', nome: 'Default (recommended)', descricao: 'Opus', esforcos: ['low', 'medium', 'high'] },
      { valor: 'sonnet', modelo: 'claude-sonnet-5-5', nome: 'Sonnet', descricao: 'Rápido', esforcos: ['low', 'medium', 'high'] },
      { valor: 'haiku', modelo: 'claude-haiku-x', nome: 'Haiku', descricao: 'Leve', esforcos: [] },
    ],
    vapid: crypto.createECDH('prime256v1'),
  };
  estado.vapid.generateKeys();
  const vapidPublica = estado.vapid.getPublicKey().toString('base64url');
  const fluxo = new Set();
  const fluxoConversa = new Map(); // id → Set(res)

  const enviar = (res, evento, dados) => res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  const difundir = (evento, dados) => { for (const r of fluxo) enviar(r, evento, dados); };
  const difundirSessao = (s) => difundir('sessao', s);
  const difundirItens = (id, itens) => { for (const r of fluxoConversa.get(id) || []) enviar(r, 'itens', { itens }); };
  const difundirParcial = (id, p) => { for (const r of fluxoConversa.get(id) || []) enviar(r, 'parcial', p); };

  function responder(res, status, corpo, tipo, extra = {}) {
    const json = tipo === undefined && typeof corpo !== 'string' && !Buffer.isBuffer(corpo);
    const dados = json ? JSON.stringify(corpo) : corpo;
    res.writeHead(status, { ...CABECALHOS, 'content-type': json ? 'application/json; charset=utf-8' : tipo, 'cache-control': 'no-store', ...extra });
    res.end(dados);
  }
  async function lerCorpo(req) {
    const partes = [];
    for await (const c of req) partes.push(c);
    const bruto = Buffer.concat(partes).toString('utf8');
    try { return bruto ? JSON.parse(bruto) : {}; } catch { return null; }
  }
  const cookieToken = (req) => /(?:^|;\s*)orbit-mock=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';

  // Ação assíncrona (o `acao` das respostas 202 de controle.mjs).
  const novaAcao = (sessao, tipo) => ({ id: 'acao-' + ++estado.seqAcao, tipo, sessao, estado: 'em_andamento', via: 'orbit', inicio: Date.now() });
  const erro = (res, status, msg, codigo) => responder(res, status, codigo ? { erro: msg, codigo } : { erro: msg });
  const autoInfo = (s) => s.controle.autoCompactar || { ligada: true, limite: 80 };
  // Corpo das rotas novas, validado como no remoto.mjs (validarCorpoNovo). Devolve o código do erro (400) ou ''.
  const soChaves = (b, ks) => Object.keys(b).every((k) => ks.includes(k));
  function validarNovo(rota, b) {
    if (rota === '/ideias/nova' || rota === '/ideias/editar' || rota === '/ideias/feita' || rota === '/ideias/apagar') {
      const temTexto = rota === '/ideias/nova' || rota === '/ideias/editar';
      const temId = rota !== '/ideias/nova';
      if (!soChaves(b, [...(temTexto ? ['texto'] : []), ...(temId ? ['id'] : []), ...(rota === '/ideias/feita' ? ['feita'] : [])])) return 'campo_nao_permitido';
      if (temTexto && (typeof b.texto !== 'string' || !b.texto.trim() || b.texto.length > 20000)) return 'texto_invalido';
      if (temId && (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.id))) return 'id_invalido';
      if (rota === '/ideias/feita' && typeof b.feita !== 'boolean') return 'feita_invalido';
    } else if (rota === '/remoto/nao-perturbe') {
      if (!soChaves(b, ['ativo', 'agendado', 'inicio', 'fim'])) return 'campo_nao_permitido';
      if (typeof b.ativo !== 'boolean') return 'ativo_invalido';
      if (typeof b.agendado !== 'boolean') return 'agendado_invalido';
      if (typeof b.inicio !== 'string' || !HORA.test(b.inicio)) return 'inicio_invalido';
      if (typeof b.fim !== 'string' || !HORA.test(b.fim)) return 'fim_invalido';
    } else if (rota === '/remoto/notificar') {
      if (!soChaves(b, ['precisa', 'terminou'])) return 'campo_nao_permitido';
      if (b.precisa === undefined && b.terminou === undefined) return 'nada_para_mudar';
      for (const k of ['precisa', 'terminou']) if (k in b && typeof b[k] !== 'boolean') return `${k}_invalido`;
    }
    return '';
  }
  // Corpo das ações novas da sessão (remoto.mjs, validarAcaoSessao).
  function validarSessao(acao, b) {
    if (acao === '') {
      for (const k of Object.keys(b)) if (!['apelido', 'fixada', 'silenciada'].includes(k)) return 'campo_nao_permitido';
      if ('apelido' in b && (typeof b.apelido !== 'string' || b.apelido.length > 60)) return 'apelido_invalido';
      for (const k of ['fixada', 'silenciada']) if (k in b && typeof b[k] !== 'boolean') return `${k}_invalido`;
    } else if (acao === 'compactar') {
      if (b.foco !== undefined && b.foco !== null && (typeof b.foco !== 'string' || b.foco.length > 2000)) return 'foco_invalido';
    } else if (acao === 'limpar') {
      if (b.confirmar !== true) return 'confirmar_obrigatorio';
    } else if (acao === 'autocompactar') {
      if (typeof b.ativo !== 'boolean') return 'ativo_invalido';
    } else if (acao === 'revisada') {
      if (typeof b.revisada !== 'boolean') return 'revisada_invalido';
    }
    return '';
  }

  // Fala do agente depois de uma mensagem: uma resposta parcial e o item final.
  function responderAgente(id, texto) {
    const s = sessoes.get(id);
    const aid = 'a-' + Date.now();
    delete s.revisadaEm; // terminou (ou mudou) de novo: deixa de estar revisada, como no servidor
    s.status = 'trabalhando';
    s.controle.ocupada = true;
    difundirSessao(s);
    setTimeout(() => difundirParcial(id, { id: aid, texto: 'Entendi' }), 150);
    setTimeout(() => difundirParcial(id, { id: aid, texto: 'Entendi: ' + texto.slice(0, 40) }), 300);
    setTimeout(() => {
      const it = { id: aid, ts: Date.now(), tipo: 'assistente', texto: 'Feito. Recebi: **' + texto.slice(0, 60) + '**' };
      conversas.get(id).push(it);
      difundirItens(id, [it]);
      s.status = 'concluida';
      s.controle.ocupada = false;
      s.atividade = Date.now();
      difundirSessao(s);
    }, 500);
  }

  async function tratar(req, res) {
    const url = new URL(req.url, base);
    const rota = url.pathname;
    const metodo = req.method;

    // PC "desconectado" (/_mock/cair): tudo responde 503, menos as rotas de controle do próprio mock.
    if (estado.caido && !rota.startsWith('/_mock/')) { req.resume(); return responder(res, 503, { erro: 'indisponivel' }, undefined, { 'retry-after': '1' }); }

    // ── público (sem cookie) ──
    if (metodo === 'GET') {
      if (rota === '/') return responder(res, 302, '', 'text/plain', { location: '/m' });
      // Os arquivos do app saem da mesma lista do servidor real; o que ainda não existe em disco dá 404.
      if (Object.hasOwn(ARQUIVOS_MOBILE, rota)) {
        try { return responder(res, 200, fs.readFileSync(path.join(PASTA, 'mobile', ARQUIVOS_MOBILE[rota][0]), 'utf8'), ARQUIVOS_MOBILE[rota][1]); } catch { return responder(res, 404, { erro: 'não encontrado' }); }
      }
      if (Object.hasOwn(ARQ_PWA, rota)) {
        let t = fs.readFileSync(path.join(PASTA, ARQ_PWA[rota][0]), 'utf8');
        if (rota === '/offline.html') t = t.replaceAll('__PASTA__', 'mock').replaceAll('__PORTA__', String(porta));
        return responder(res, 200, t, ARQ_PWA[rota][1]);
      }
      if (rota.startsWith('/assets/')) {
        const tipo = TIPOS[path.extname(rota).toLowerCase()];
        if (!tipo || !RE_ASSET.test(rota)) return responder(res, 404, { erro: 'não encontrado' });
        try { return responder(res, 200, fs.readFileSync(path.join(PASTA, rota.slice(1))), tipo); } catch { return responder(res, 404, { erro: 'não encontrado' }); }
      }
      if (rota === '/_mock/log') return responder(res, 200, estado.log);
      if (rota === '/_mock/codigo') return responder(res, 200, { codigo: estado.pedido?.codigo || null, pedido: estado.pedido?.id || null });
    }
    // O Origin e o corpo JSON valem para toda ação não-GET (contrato).
    let corpo = null;
    if (metodo !== 'GET') {
      if (req.headers.origin !== base) return responder(res, 403, { erro: 'origem não permitida' });
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return responder(res, 403, { erro: 'corpo precisa ser application/json' });
      corpo = await lerCorpo(req);
      if (corpo === null) return responder(res, 400, { erro: 'JSON inválido' });
    }
    if (rota.startsWith('/_mock/') && metodo === 'POST') {
      if (rota === '/_mock/expirar') { if (estado.pedido) estado.pedido.expira = Date.now() - 1; return responder(res, 200, { ok: true }); }
      if (rota === '/_mock/desbloquear') { estado.bloqueadoAte = 0; return responder(res, 200, { ok: true }); }
      if (rota === '/_mock/uso') { estado.uso = corpo; difundir('uso', corpo); return responder(res, 200, { ok: true }); }
      if (rota === '/_mock/limpar-log') { estado.log.length = 0; return responder(res, 200, { ok: true }); }
      if (rota === '/_mock/cair') { // fecha os SSE e passa a responder 503 até /_mock/voltar
        estado.caido = true;
        for (const r of fluxo) { try { r.end(); } catch {} }
        fluxo.clear();
        for (const l of fluxoConversa.values()) { for (const r of l) { try { r.end(); } catch {} } l.clear(); }
        return responder(res, 200, { ok: true, caido: true });
      }
      if (rota === '/_mock/voltar') { estado.caido = false; return responder(res, 200, { ok: true, caido: false }); }
      if (rota === '/_mock/uso-bloqueio') { // { motivo: 'rodando' | 'lendo' | null }: o próximo /uso/atualizar responde 409, como o servidor
        estado.usoBloqueio = corpo.motivo === 'rodando' || corpo.motivo === 'lendo' ? corpo.motivo : null;
        return responder(res, 200, { ok: true, motivo: estado.usoBloqueio });
      }
      if (rota === '/_mock/reiniciar') { // volta ao começo, no lugar (os Maps seguem os mesmos), e manda `inicio` ao fluxo
        const n = dadosIniciais();
        sessoes.clear(); for (const s of n.sessoes) sessoes.set(s.id, s);
        conversas.clear(); for (const [k, v] of Object.entries(n.conversas)) conversas.set(k, v);
        estado.log.length = 0;
        estado.caido = false;
        for (const k of ['criarInstancias', 'msg', 'forcarPermissao']) delete estado[k];
        difundir('inicio', { sessoes: [...sessoes.values()], resumoDia: estado.resumoDia, uso: estado.uso });
        return responder(res, 200, { ok: true });
      }
      if (rota === '/_mock/mudar') { // { id, ...campos, controle? }: troca a sessão e avisa o fluxo
        const s = sessoes.get(corpo.id);
        if (!s) return responder(res, 404, { erro: 'sem sessão' });
        const { controle, ...resto } = corpo;
        Object.assign(s, resto);
        for (const [k, v] of Object.entries(controle || {})) { if (v === null) delete s.controle[k]; else s.controle[k] = v; }
        difundirSessao(s);
        return responder(res, 200, { ok: true });
      }
      return responder(res, 404, { erro: 'não encontrado' });
    }

    if (rota === '/remoto/parear/pedir' && metodo === 'POST') {
      estado.log.push({ metodo, rota, corpo });
      if (Date.now() < estado.bloqueadoAte) return responder(res, 429, { erro: 'bloqueado' });
      if (estado.pedido && estado.pedido.expira > Date.now()) return responder(res, 409, { erro: 'pedido_pendente' });
      const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      estado.pedido = { id: 'ped-' + ++estado.seqPedido, nome: String(corpo.nome || ''), codigo, expira: Date.now() + 120e3, erros: 0 };
      return responder(res, 200, { pedido: estado.pedido.id, expiraEm: estado.pedido.expira });
    }
    if (rota === '/remoto/parear/confirmar' && metodo === 'POST') {
      estado.log.push({ metodo, rota, corpo });
      if (Date.now() < estado.bloqueadoAte) return responder(res, 429, { erro: 'bloqueado' });
      const p = estado.pedido;
      if (!p || p.id !== corpo.pedido) return responder(res, 400, { erro: 'codigo_errado' });
      if (p.expira < Date.now()) { estado.pedido = null; return responder(res, 410, { erro: 'expirado' }); }
      if (String(corpo.codigo) !== p.codigo) {
        if (++p.erros >= 5) { estado.pedido = null; estado.bloqueadoAte = Date.now() + 600e3; return responder(res, 429, { erro: 'bloqueado' }); }
        return responder(res, 400, { erro: 'codigo_errado' });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      estado.tokens.add(token);
      estado.nomeAparelho = p.nome;
      estado.pedido = null;
      return responder(res, 200, { ok: true, aparelho: { id: 'ap-1', nome: p.nome } }, undefined, { 'set-cookie': `orbit-mock=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000` });
    }

    // ── com cookie ──
    if (!estado.tokens.has(cookieToken(req))) return responder(res, 401, { erro: 'nao_pareado' });
    if (metodo !== 'GET') estado.log.push({ metodo, rota, corpo });

    if (rota === '/remoto/eu') return responder(res, 200, { aparelho: { id: 'ap-1', nome: estado.nomeAparelho || 'iPhone', criadoEm: Date.now() - 3 * 86400000 }, opcoes: { criarInstancias: estado.criarInstancias !== false }, vapidPublica });
    if (rota === '/remoto/sair' && metodo === 'POST') { estado.tokens.delete(cookieToken(req)); for (const r of fluxo) r.end(); fluxo.clear(); return responder(res, 200, { ok: true }, undefined, { 'set-cookie': 'orbit-mock=; Max-Age=0; Path=/' }); }
    if (rota === '/remoto/push/assinar' && metodo === 'POST') { estado.push = corpo.assinatura || null; return responder(res, 200, { ok: true }); }
    if (rota === '/remoto/push/cancelar' && metodo === 'POST') { estado.push = null; return responder(res, 200, { ok: true }); }
    if (rota === '/remoto/push/teste' && metodo === 'POST') return responder(res, 200, { ok: true });
    if (rota === '/remoto/projetos' && metodo === 'GET') { estado.chamadasProjetos = (estado.chamadasProjetos || 0) + 1; if (estado.criarInstancias === false) return responder(res, 403, { erro: 'criar_instancias_desligado' }); } if (rota === '/remoto/projetos' && metodo === 'GET') return responder(res, 200, estado.projetos);
    if (rota === '/estado' && metodo === 'GET') return responder(res, 200, { sessoes: [...sessoes.values()], resumoDia: estado.resumoDia, uso: estado.uso });
    if (rota === '/remoto/historico' && metodo === 'GET') return responder(res, 200, estado.historico);
    if (rota === '/remoto/notificacoes' && metodo === 'GET') return responder(res, 200, { naoPerturbe: { ...estado.naoPerturbe }, notificar: { ...estado.notificar } });
    if (rota === '/remoto/nao-perturbe' && metodo === 'POST') {
      const e = validarNovo(rota, corpo);
      if (e) return responder(res, 400, { erro: e });
      estado.naoPerturbe = { ativo: corpo.ativo, agendado: corpo.agendado, inicio: corpo.inicio, fim: corpo.fim };
      return responder(res, 200, { ok: true, naoPerturbe: { ...estado.naoPerturbe } });
    }
    if (rota === '/remoto/notificar' && metodo === 'POST') {
      const e = validarNovo(rota, corpo);
      if (e) return responder(res, 400, { erro: e });
      for (const k of ['precisa', 'terminou']) if (k in corpo) estado.notificar[k] = corpo[k];
      return responder(res, 200, { ok: true, notificar: { ...estado.notificar } });
    }
    // Grafo só de leitura: o projeto tem de estar cadastrado; o da Loja Online não tem brain.
    if ((rota === '/remoto/grafo' || rota === '/remoto/grafo/nota') && metodo === 'GET') {
      const projeto = url.searchParams.get('projeto');
      if (!projeto || !estado.projetos.some((p) => p.pasta === projeto)) return responder(res, 403, { erro: 'pasta_nao_permitida' });
      if (projeto !== estado.projetos[0].pasta) return responder(res, 404, { erro: 'sem_brain' });
      if (rota === '/remoto/grafo') return responder(res, 200, estado.grafo);
      const id = url.searchParams.get('id');
      if (typeof id !== 'string' || !id || id.length > 500 || /[\x00-\x1f]/.test(id) || path.isAbsolute(id) || /^[A-Za-z]:/.test(id)
        || id.split(/[\\/]+/).some((p) => p === '..' || p.startsWith('.')) || !/\.md$/i.test(id)) return responder(res, 403, { erro: 'fora_do_brain' });
      if (!Object.hasOwn(estado.notas, id)) return responder(res, 404, { erro: 'nota_nao_encontrada' });
      return responder(res, 200, { id, texto: estado.notas[id] });
    }
    // Ideias (ideias.mjs): a mais nova no topo.
    if (rota === '/ideias' && metodo === 'GET') return responder(res, 200, { ideias: estado.ideias, nota: 'Ideias.md' });
    if (metodo === 'POST' && ['/ideias/nova', '/ideias/editar', '/ideias/feita', '/ideias/apagar'].includes(rota)) {
      const e = validarNovo(rota, corpo);
      if (e) return responder(res, 400, { erro: e });
      let id = null;
      if (rota === '/ideias/nova') {
        const p = (n) => String(n).padStart(2, '0'); const x = new Date();
        const nova = { id: 'i-n' + ++estado.seqIdeia + 'x' + Date.now().toString(36).slice(-4), texto: corpo.texto.trim(), data: `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`, feita: false };
        estado.ideias.unshift(nova);
        id = nova.id;
      } else {
        const it = estado.ideias.find((x) => x.id === corpo.id);
        if (!it) return responder(res, 404, { erro: 'Essa ideia não está mais na nota (talvez tenha sido mudada no cofre). A lista foi recarregada.' });
        id = it.id;
        if (rota === '/ideias/editar') it.texto = corpo.texto.trim();
        else if (rota === '/ideias/feita') it.feita = corpo.feita;
        else { estado.ideias.splice(estado.ideias.indexOf(it), 1); id = null; }
      }
      return responder(res, 200, { ok: true, id, ideias: estado.ideias });
    }
    if (rota === '/uso/atualizar' && metodo === 'POST') {
      if (estado.usoBloqueio === 'lendo') return responder(res, 409, { erro: 'Já estou lendo o uso do plano.', motivo: 'lendo' });
      if (estado.usoBloqueio === 'rodando') return responder(res, 409, { erro: 'Há uma instância trabalhando agora; a leitura sob demanda fica para quando tudo parar.', motivo: 'rodando' });
      estado.uso = { ...estado.uso, atualizado: Date.now() };
      difundir('uso', estado.uso);
      return responder(res, 200, { ok: true, uso: estado.uso, custo: { hoje: 12.4, semana: 61.9 } });
    }
    if (rota === '/sincronia' && metodo === 'GET') return responder(res, 200, estado.sinc);
    if (rota === '/uso' && metodo === 'GET') return responder(res, 200, estado.uso);
    if (rota === '/modelos' && metodo === 'GET') return responder(res, 200, { modelos: estado.modelos, atualizado: Date.now() });
    if (rota === '/fluxo' && metodo === 'GET') {
      res.writeHead(200, { ...CABECALHOS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n');
      enviar(res, 'inicio', { sessoes: [...sessoes.values()], resumoDia: estado.resumoDia, uso: estado.uso });
      fluxo.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15e3);
      req.on('close', () => { fluxo.delete(res); clearInterval(ping); });
      return;
    }
    if (rota === '/instancias' && metodo === 'POST') {
      if (!estado.projetos.some((p) => p.pasta === corpo.pasta)) return responder(res, 400, { erro: 'pasta não é um projeto cadastrado' });
      const cmd = comandoDoTexto(corpo.texto);
      if (cmd !== null && !COMANDOS_OK.has(cmd)) return responder(res, 403, { erro: 'comando_nao_permitido' });
      const id = 's7';
      const s = { id, status: 'nova', projeto: estado.projetos.find((p) => p.pasta === corpo.pasta).nome, cwd: corpo.pasta, titulo: String(corpo.texto || '').slice(0, 40), desde: Date.now(), atividade: Date.now(),
        controle: { modo: 'orbit', ocupada: false, processo: 'vivo', modelo: corpo.modelo || 'default', esforco: corpo.esforco || 'high', modoPermissao: corpo.permissao || 'default' } };
      sessoes.set(id, s);
      conversas.set(id, []);
      difundirSessao(s);
      return responder(res, 202, { acao: { id: 'acao-1', tipo: 'criar', sessao: id, estado: 'em_andamento' } });
    }

    const m = /^\/sessao\/([^/]+)(?:\/(.+))?$/.exec(rota);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const acao = m[2] || '';
      const s = sessoes.get(id);
      if (!s) return responder(res, 404, { erro: 'sessão não encontrada' });
      const itens = conversas.get(id) || [];
      if (acao === '' && metodo === 'GET') return responder(res, 200, { sessao: s, eventos: [] });
      if (acao === 'conversa' && metodo === 'GET') {
        const limite = Math.max(1, Number(url.searchParams.get('limite')) || 40);
        const antes = url.searchParams.has('antes') ? Number(url.searchParams.get('antes')) : itens.length;
        const ini = Math.max(0, antes - limite);
        return responder(res, 200, { itens: itens.slice(ini, antes), cursorAntigo: ini > 0 ? ini : null, cursorNovo: itens.length });
      }
      if (acao === 'conversa/fluxo' && metodo === 'GET') {
        res.writeHead(200, { ...CABECALHOS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 1000\n\n');
        if (!fluxoConversa.has(id)) fluxoConversa.set(id, new Set());
        fluxoConversa.get(id).add(res);
        req.on('close', () => fluxoConversa.get(id)?.delete(res));
        return;
      }
      if (acao === 'imagem' && metodo === 'GET') return responder(res, 200, fs.readFileSync(path.join(PASTA, 'assets', 'pwa', 'icone-96.png')), 'image/png');
      if (acao === 'acoes' && metodo === 'GET') return responder(res, 200, []);
      if (acao === 'comandos' && metodo === 'GET') return responder(res, 200, { comandos: [{ nome: 'compact', descricao: 'Compactar a conversa', args: '[foco]' }, { nome: 'clear', descricao: 'Limpar a conversa', args: '' }, { nome: 'minha-skill', descricao: 'Skill falsa do projeto', args: '' }] });
      if (metodo === 'POST') {
        // Validação do corpo das ações novas, antes de qualquer efeito (remoto.mjs); o remoto nunca força o encerrar.
        const e400 = validarSessao(acao, corpo);
        if (e400) return responder(res, 400, { erro: e400 });
        if (acao === '') { // apelido, fixada, silenciada
          if ('fixada' in corpo) s.fixada = corpo.fixada;
          if ('silenciada' in corpo) s.silenciada = corpo.silenciada;
          if ('apelido' in corpo) s.apelido = corpo.apelido.replace(/\s+/g, ' ').trim().slice(0, 60);
          difundirSessao(s);
          return responder(res, 200, { ok: true, sessao: s });
        }
        if (acao === 'revisada') { // grava revisadaEm (>= desde) ou apaga
          if (corpo.revisada) s.revisadaEm = Math.max(Date.now(), s.desde); else delete s.revisadaEm;
          difundirSessao(s);
          return responder(res, 200, { ok: true, sessao: s });
        }
        if (acao === 'compactar' || acao === 'limpar') {
          const dormia = s.controle.processo === 'dormindo';
          if (!dormia && s.controle.ocupada) return erro(res, 409, 'A sessão está trabalhando; espere a volta terminar.', 'ocupada');
          const a = novaAcao(id, acao);
          s.controle.processo = 'vivo';
          s.controle.ocupada = true;
          difundirSessao(s);
          setTimeout(() => {
            if (acao === 'compactar') {
              const pre = Number(s.contexto?.tokens) || 120000;
              const pos = Math.round(pre / 6);
              const it = { id: 'c-' + Date.now(), ts: Date.now(), tipo: 'compactacao', pre, pos };
              itens.push(it);
              difundirItens(id, [it]);
              s.contexto = { ...(s.contexto || { modelo: 'claude-sonnet-5-5' }), tokens: pos };
            } else {
              itens.length = 0;
              s.contexto = { ...(s.contexto || { modelo: 'claude-sonnet-5-5' }), tokens: 0 };
            }
            s.controle.ocupada = false;
            s.atividade = Date.now();
            a.estado = 'sucesso';
            a.fim = Date.now();
            difundirSessao(s);
          }, 400);
          return responder(res, 202, { acao: a });
        }
        if (acao === 'encerrar') {
          if (s.controle.processo === 'dormindo') return erro(res, 409, 'A instância já está dormindo.', 'dormindo');
          if (s.controle.ocupada || s.controle.pendentes || (s.controle.tarefas || []).length) {
            const motivos = [s.controle.ocupada || s.controle.pendentes ? 'respondendo' : '', (s.controle.tarefas || []).length ? 'com tarefas em segundo plano' : ''].filter(Boolean);
            return erro(res, 409, `A instância está ${motivos.join(' e ')}. Confirme para interromper e encerrar.`, 'ocupada');
          }
          const a = novaAcao(id, 'encerrar');
          setTimeout(() => { s.controle.processo = 'dormindo'; s.controle.ocupada = false; a.estado = 'sucesso'; a.fim = Date.now(); difundirSessao(s); }, 200);
          return responder(res, 202, { acao: a });
        }
        if (acao === 'retomar') {
          if (s.controle.processo !== 'dormindo') return erro(res, 409, 'A instância já está viva.', 'viva');
          const a = novaAcao(id, 'retomar');
          setTimeout(() => { s.controle.processo = 'vivo'; a.estado = 'sucesso'; a.fim = Date.now(); difundirSessao(s); }, 200);
          return responder(res, 202, { acao: a });
        }
        if (acao === 'autocompactar') {
          s.controle.autoCompactar = { ...autoInfo(s), ligada: corpo.ativo, propria: corpo.ativo };
          difundirSessao(s);
          return responder(res, 200, { autoCompactar: s.controle.autoCompactar });
        }
        if (acao === 'mensagem') {
          const cmd = comandoDoTexto(corpo.texto); // barra no começo: só passa a lista permitida
          if (cmd !== null && !COMANDOS_OK.has(cmd)) return responder(res, 403, { erro: 'comando_nao_permitido' });
          const texto = String(corpo.texto || '');
          const imagens = Array.isArray(corpo.imagens) ? corpo.imagens : [];
          if (!texto.trim() && !imagens.length) return responder(res, 400, { erro: 'texto deve ter de 1 a 20000 caracteres' });
          const cfg = estado.msg || {};
          if (cfg.atraso) await new Promise((ok) => setTimeout(ok, Number(cfg.atraso)));
          if (cfg.falhar) return erro(res, Number(cfg.falhar), 'falha forçada pelo teste');
          const it = { id: 'u-' + Date.now(), ts: Date.now(), tipo: 'usuario', texto, imagens: imagens.map((_, i) => ({ o: 1, i })) };
          itens.push(it);
          if (!cfg.semEco) difundirItens(id, [it]);
          responderAgente(id, texto || '(foto)');
          return responder(res, 202, { acao: { id: 'acao-m', tipo: 'mensagem', sessao: id, estado: 'em_andamento' } });
        }
        if (acao === 'permissao') {
          if (estado.forcarPermissao) { const st = Number(estado.forcarPermissao); delete estado.forcarPermissao; return erro(res, st, st === 409 ? 'já respondido' : 'pedido de permissão não encontrado'); }
          const p = s.controle.permissao;
          if (!p || p.id !== corpo.id) return responder(res, 404, { erro: 'pedido de permissão não encontrado' });
          if (corpo.decisao !== 'permitir' && corpo.decisao !== 'negar') return responder(res, 400, { erro: "decisao deve ser 'permitir' ou 'negar'" });
          delete s.controle.permissao;
          delete s.controle.pendentes;
          s.status = 'trabalhando';
          s.atividade = Date.now();
          difundirSessao(s);
          return responder(res, 200, { ok: true });
        }
        if (acao === 'parar') { s.controle.ocupada = false; s.status = 'interrompida'; difundirSessao(s); return responder(res, 202, { acao: { id: 'acao-p', tipo: 'parar', estado: 'em_andamento' } }); }
        if (acao === 'modelo') { s.controle.modelo = corpo.modelo; difundirSessao(s); return responder(res, 200, { modelo: corpo.modelo, esforco: s.controle.esforco }); }
        if (acao === 'esforco') { s.controle.esforco = corpo.esforco; difundirSessao(s); return responder(res, 200, { modelo: s.controle.modelo, esforco: corpo.esforco }); }
        if (acao === 'modo') {
          if (corpo.modo === 'bypassPermissions') return responder(res, 403, { erro: 'bloqueado_no_celular' });
          s.controle.modoPermissao = corpo.modo; difundirSessao(s); return responder(res, 200, { modo: corpo.modo });
        }
      }
    }
    return responder(res, 403, { erro: 'bloqueado_no_celular' });
  }

  const servidor = http.createServer((req, res) => {
    tratar(req, res).catch((e) => { try { responder(res, 500, { erro: String(e?.message || e) }); } catch {} });
  });
  await new Promise((ok, falha) => { servidor.once('error', falha); servidor.listen(porta, '127.0.0.1', ok); });
  return {
    porta, base, estado, sessoes, vapidPublica,
    // Fecha só este servidor e as conexões SSE dele.
    async fechar() {
      for (const r of fluxo) r.end();
      for (const s of fluxoConversa.values()) for (const r of s) r.end();
      servidor.closeAllConnections?.();
      await new Promise((ok) => servidor.close(ok));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await subirMock({ porta: process.argv[2] });
  console.log(`mock da porta remota em ${m.base}/m (Ctrl+C encerra)`);
  process.on('SIGINT', async () => { await m.fechar(); process.exit(0); });
}
