// Servidor FALSO da porta remota (Orbit no celular), só para testar a interface mobile sem o servidor real.
// Serve a pasta mobile/ (index.html, mobile.css/js, manifesto) e os arquivos de PWA do disco e responde às rotas do contrato
// com dados de exemplo, com o cabeçalho CSP do contrato.
// Não é o servidor real: o cookie aqui se chama `orbit-mock` (o real é `__Host-orbit`, que exige HTTPS) e não há Tailscale.
//   node testes/mobile-mock.mjs [porta]     sobe numa porta livre de 47822–47826 (nunca a 47821) e imprime a URL
//   import { subirMock } from './mobile-mock.mjs'     usado por mobile-ui.test.mjs
// Rotas de teste (só aqui): GET /_mock/log, GET /_mock/codigo, POST /_mock/{expirar,desbloquear,mudar,limpar-log}.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Cabeçalhos do contrato para a porta remota.
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const CABECALHOS = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

const TIPOS = { '.png': 'image/png', '.woff2': 'font/woff2', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const ARQ = {
  '/m': ['mobile/index.html', 'text/html; charset=utf-8'],
  '/m/mobile.css': ['mobile/mobile.css', 'text/css; charset=utf-8'],
  '/m/mobile.js': ['mobile/mobile.js', 'text/javascript; charset=utf-8'],
  '/m/widgets.js': ['mobile/widgets.js', 'text/javascript; charset=utf-8'],
  '/m/widgets.css': ['mobile/widgets.css', 'text/css; charset=utf-8'],
  '/manifest-m.webmanifest': ['mobile/manifest-m.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['pwa/sw.js', 'text/javascript; charset=utf-8'],
  '/offline.html': ['pwa/offline.html', 'text/html; charset=utf-8'],
};

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
    { id: 's4', status: 'trabalhando', projeto: 'Diário', cwd: 'D:\\Projetos\\Diario', apelido: 'Refatorar o diário', titulo: 'Refatorar', contexto: { tokens: 400000, modelo: 'claude-sonnet-5-5', janela: 1000000, pct: 40 }, agentes: [{ id: 'ag1', status: 'trabalhando' }, { id: 'ag2', status: 'concluido' }], detalhe: 'Editando Diario.tsx', desde: agora - 8 * min, atividade: agora - 30e3, controle: ctl() },
    { id: 's5', status: 'concluida', projeto: 'Orbit', cwd: 'D:\\Projetos\\Orbit', titulo: 'Revisar o README', contexto: { tokens: 30000, modelo: 'claude-sonnet-4-5' }, desde: agora - 3 * 3600e3, atividade: agora - 3 * 3600e3, controle: ctl({ ocupada: false }) },
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
  return {
    sessoes,
    conversas,
    uso: { cincoHoras: { pct: 42, renova: agora + 2.5 * 3600e3 }, semanal: { pct: 27, renova: agora + 3 * 86400e3 }, atualizado: agora - 2 * min },
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

  // Fala do agente depois de uma mensagem: uma resposta parcial e o item final.
  function responderAgente(id, texto) {
    const s = sessoes.get(id);
    const aid = 'a-' + Date.now();
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

    // ── público (sem cookie) ──
    if (metodo === 'GET') {
      if (rota === '/') return responder(res, 302, '', 'text/plain', { location: '/m' });
      if (ARQ[rota]) {
        let t = fs.readFileSync(path.join(PASTA, ARQ[rota][0]), 'utf8');
        if (rota === '/offline.html') t = t.replaceAll('__PASTA__', 'mock').replaceAll('__PORTA__', String(porta));
        return responder(res, 200, t, ARQ[rota][1]);
      }
      if (rota.startsWith('/assets/')) {
        const nome = rota.slice(8);
        const tipo = TIPOS[path.extname(nome).toLowerCase()];
        if (!tipo || !/^(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*$/.test(nome)) return responder(res, 404, { erro: 'não encontrado' });
        try { return responder(res, 200, fs.readFileSync(path.join(PASTA, 'assets', nome)), tipo); } catch { return responder(res, 404, { erro: 'não encontrado' }); }
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

    if (rota === '/remoto/eu') return responder(res, 200, { aparelho: { id: 'ap-1', nome: estado.nomeAparelho || 'iPhone' }, opcoes: { criarInstancias: estado.criarInstancias !== false }, vapidPublica });
    if (rota === '/remoto/sair' && metodo === 'POST') { estado.tokens.delete(cookieToken(req)); for (const r of fluxo) r.end(); fluxo.clear(); return responder(res, 200, { ok: true }, undefined, { 'set-cookie': 'orbit-mock=; Max-Age=0; Path=/' }); }
    if (rota === '/remoto/push/assinar' && metodo === 'POST') { estado.push = corpo.assinatura || null; return responder(res, 200, { ok: true }); }
    if (rota === '/remoto/push/cancelar' && metodo === 'POST') { estado.push = null; return responder(res, 200, { ok: true }); }
    if (rota === '/remoto/push/teste' && metodo === 'POST') return responder(res, 200, { ok: true });
    if (rota === '/remoto/projetos' && metodo === 'GET') { estado.chamadasProjetos = (estado.chamadasProjetos || 0) + 1; if (estado.criarInstancias === false) return responder(res, 403, { erro: 'criar_instancias_desligado' }); } if (rota === '/remoto/projetos' && metodo === 'GET') return responder(res, 200, estado.projetos);
    if (rota === '/estado' && metodo === 'GET') return responder(res, 200, { sessoes: [...sessoes.values()], uso: estado.uso });
    if (rota === '/uso' && metodo === 'GET') return responder(res, 200, estado.uso);
    if (rota === '/modelos' && metodo === 'GET') return responder(res, 200, estado.modelos);
    if (rota === '/fluxo' && metodo === 'GET') {
      res.writeHead(200, { ...CABECALHOS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n');
      enviar(res, 'inicio', { sessoes: [...sessoes.values()], uso: estado.uso });
      fluxo.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15e3);
      req.on('close', () => { fluxo.delete(res); clearInterval(ping); });
      return;
    }
    if (rota === '/instancias' && metodo === 'POST') {
      if (!estado.projetos.some((p) => p.pasta === corpo.pasta)) return responder(res, 400, { erro: 'pasta não é um projeto cadastrado' });
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
      if (acao === 'comandos' && metodo === 'GET') return responder(res, 200, { comandos: [] });
      if (metodo === 'POST') {
        if (acao === 'mensagem') {
          const texto = String(corpo.texto || '');
          const imagens = Array.isArray(corpo.imagens) ? corpo.imagens : [];
          if (!texto.trim() && !imagens.length) return responder(res, 400, { erro: 'texto deve ter de 1 a 20000 caracteres' });
          const it = { id: 'u-' + Date.now(), ts: Date.now(), tipo: 'usuario', texto, imagens: imagens.map((_, i) => ({ o: 1, i })) };
          itens.push(it);
          difundirItens(id, [it]);
          responderAgente(id, texto || '(foto)');
          return responder(res, 202, { acao: { id: 'acao-m', tipo: 'mensagem', sessao: id, estado: 'em_andamento' } });
        }
        if (acao === 'permissao') {
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
