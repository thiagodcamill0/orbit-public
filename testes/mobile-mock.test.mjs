// Teste do servidor falso do celular (testes/mobile-mock.mjs): só HTTP, sem navegador.
// Confere as rotas do "Celular premium" (contrato), os arquivos do app pela lista do remoto.mjs, o SSE e /_mock/cair|voltar.
//   node testes/mobile-mock.test.mjs
// Sobe o mock numa porta livre de 47822–47826 (nunca a 47821) e desliga só o que subiu.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subirMock } from './mobile-mock.mjs';
import { ARQUIVOS_MOBILE } from '../remoto.mjs';

const checks = [];
const conferir = (nome, ok, detalhe) => { checks.push({ nome, ok: !!ok }); console.log((ok ? 'ok    ' : 'FALHA ') + nome + (ok ? '' : '  → ' + JSON.stringify(detalhe))); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await subirMock();
const base = mock.base;
let cookie = '';
const req = async (metodo, rota, corpo, extra = {}) => {
  const h = { cookie, ...extra };
  if (metodo !== 'GET') { h.origin = base; h['content-type'] = 'application/json'; }
  const r = await fetch(base + rota, { method: metodo, headers: h, body: metodo === 'GET' ? undefined : JSON.stringify(corpo ?? {}), redirect: 'manual' });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  return { status: r.status, json, txt, tipo: r.headers.get('content-type') || '', cookie: r.headers.get('set-cookie') || '' };
};
const GET = (rota) => req('GET', rota);
const POST = (rota, corpo) => req('POST', rota, corpo);

// Lê o SSE /fluxo e guarda os eventos recebidos.
async function abrirFluxo() {
  const ac = new AbortController();
  const r = await fetch(base + '/fluxo', { headers: { cookie }, signal: ac.signal });
  const ev = [];
  let fechou = false;
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloco = buf.slice(0, i); buf = buf.slice(i + 2);
          const nome = /^event: (.+)$/m.exec(bloco)?.[1];
          const dados = /^data: (.+)$/m.exec(bloco)?.[1];
          if (nome) ev.push({ nome, dados: JSON.parse(dados) });
        }
      }
    } catch {}
    fechou = true;
  })();
  return { ev, status: r.status, fechou: () => fechou, parar: () => ac.abort() };
}

try {
  // ── arquivos do app: a mesma lista do servidor real ──
  const m = await GET('/m');
  conferir('/m serve o index.html', m.status === 200 && /text\/html/.test(m.tipo), m.status);
  const rotasLista = Object.keys(ARQUIVOS_MOBILE);
  conferir('a lista de arquivos vem do remoto.mjs', rotasLista.includes('/m') && rotasLista.includes('/m/nucleo.js') && rotasLista.includes('/manifest-m.webmanifest'), rotasLista);
  const nuc = await GET('/m/nucleo.js');
  conferir('/m/nucleo.js: 200 se o arquivo existe, 404 se ainda não', nuc.status === 200 || nuc.status === 404, nuc.status);
  const pasta = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const faltam = [];
  const errados = [];
  for (const [rota, [arq]] of Object.entries(ARQUIVOS_MOBILE)) {
    const existe = fs.existsSync(path.join(pasta, 'mobile', arq));
    if (!existe) faltam.push(rota);
    const st = (await GET(rota)).status;
    if (st !== (existe ? 200 : 404)) errados.push({ rota, st, existe });
  }
  conferir('todo arquivo da lista: 200 se existe em mobile/, 404 se não (faltam agora: ' + (faltam.join(' ') || 'nenhum') + ')', !errados.length, errados);
  conferir('arquivo fora da lista (/m/qualquer.js) não é servido (sem cookie, 401)', (await GET('/m/qualquer.js')).status === 401);
  const sw = await GET('/sw.js');
  conferir('/sw.js e /offline.html continuam servidos', sw.status === 200 && (await GET('/offline.html')).status === 200);
  conferir('/assets/comum/base.css e componentes.css', (await GET('/assets/comum/base.css')).status === 200 && [200, 404].includes((await GET('/assets/comum/componentes.css')).status));
  conferir('/assets fora da lista dá 404', (await GET('/assets/index.html')).status === 404 && (await GET('/assets/servidor.mjs')).status === 404 && (await GET('/assets/comum/outro.js')).status === 404);

  // ── pareamento e cookie ──
  conferir('sem cookie: 401', (await GET('/estado')).status === 401);
  const ped = await POST('/remoto/parear/pedir', { nome: 'Teste' });
  const cod = (await GET('/_mock/codigo')).json;
  const conf = await POST('/remoto/parear/confirmar', { pedido: ped.json?.pedido, codigo: cod.codigo });
  cookie = /orbit-mock=[^;]+/.exec(conf.cookie)?.[0] || '';
  conferir('pareou e recebeu o cookie', conf.status === 200 && cookie, conf);

  // ── estado: resumoDia, sessões novas ──
  const est = (await GET('/estado')).json;
  conferir('/estado traz resumoDia só com contagens', est.resumoDia && ['data', 'turnos', 'msTrabalhando', 'msAguardando', 'esperas', 'sessoes'].every((k) => k in est.resumoDia), est.resumoDia);
  const por = Object.fromEntries(est.sessoes.map((s) => [s.id, s]));
  conferir('s1–s6 continuam lá', ['s1', 's2', 's3', 's4', 's5', 's6'].every((i) => por[i]), Object.keys(por));
  conferir('s5 (concluída) tem revisadaEm >= desde', por.s5.status === 'concluida' && por.s5.revisadaEm >= por.s5.desde, por.s5);
  conferir('s4 (trabalhando) tem agentes com descrição e tarefas', por.s4.agentes.length >= 2 && por.s4.agentes[0].descricao && por.s4.controle.tarefas.length >= 1, por.s4);

  // ── SSE: mudanças saem pelo evento `sessao` ──
  const fluxo = await abrirFluxo();
  await dormir(150);
  conferir('SSE /fluxo: evento inicio com resumoDia', fluxo.ev[0]?.nome === 'inicio' && fluxo.ev[0].dados.resumoDia, fluxo.ev[0]);
  const ultima = (id) => [...fluxo.ev].reverse().find((e) => e.nome === 'sessao' && e.dados.id === id)?.dados;

  // ── POST /sessao/:id (apelido, fixada, silenciada) ──
  let r = await POST('/sessao/s5', { apelido: '  Meu   README ', fixada: true, silenciada: true });
  conferir('POST /sessao/:id: apelido, fixada, silenciada', r.status === 200 && r.json.ok && r.json.sessao.apelido === 'Meu README' && r.json.sessao.fixada === true && r.json.sessao.silenciada === true, r.json);
  await dormir(100);
  conferir('  ... e sai pelo SSE (sessao)', ultima('s5')?.apelido === 'Meu README' && ultima('s5').fixada === true, ultima('s5'));
  r = await POST('/sessao/s5', { titulo: 'x' });
  conferir('POST /sessao/:id: outra chave → 400 campo_nao_permitido', r.status === 400 && r.json.erro === 'campo_nao_permitido', r);
  r = await POST('/sessao/s5', { fixada: 'sim' });
  conferir('POST /sessao/:id: fixada não booleano → 400', r.status === 400 && r.json.erro === 'fixada_invalido', r);
  r = await POST('/sessao/s5', { apelido: 'x'.repeat(61) });
  conferir('POST /sessao/:id: apelido > 60 → 400', r.status === 400 && r.json.erro === 'apelido_invalido', r);
  conferir('POST /sessao/zz → 404', (await POST('/sessao/zz', { fixada: true })).status === 404);

  // ── revisada ──
  r = await POST('/sessao/s5/revisada', { revisada: false });
  await dormir(100);
  conferir('revisada:false apaga revisadaEm (e vai pelo SSE)', r.status === 200 && r.json.ok && !('revisadaEm' in r.json.sessao) && ultima('s5') && !('revisadaEm' in ultima('s5')), r.json);
  r = await POST('/sessao/s5/revisada', { revisada: true });
  conferir('revisada:true grava revisadaEm >= desde', r.status === 200 && r.json.sessao.revisadaEm >= r.json.sessao.desde, r.json);
  conferir('revisada com corpo ruim → 400', (await POST('/sessao/s5/revisada', { revisada: 1 })).status === 400);

  // ── comandos com barra ──
  r = await POST('/sessao/s5/mensagem', { texto: '/compact' });
  conferir('mensagem /compact → 202', r.status === 202, r);
  r = await POST('/sessao/s5/mensagem', { texto: '   /minha-skill arg' });
  conferir('mensagem /minha-skill (com espaços antes) → 202', r.status === 202, r);
  r = await POST('/sessao/s5/mensagem', { texto: '/clear' });
  conferir('mensagem /clear → 202', r.status === 202, r);
  r = await POST('/sessao/s5/mensagem', { texto: '/config' });
  conferir('mensagem /config → 403 comando_nao_permitido', r.status === 403 && r.json.erro === 'comando_nao_permitido', r);
  r = await POST('/sessao/s5/mensagem', { texto: '/COMPACT' });
  conferir('mensagem /COMPACT (grafia errada) → 403', r.status === 403, r);
  r = await POST('/sessao/s5/mensagem', { texto: 'oi /config' });
  conferir('mensagem com barra no meio → 202', r.status === 202, r);
  r = await POST('/instancias', { pasta: 'D:\\Projetos\\Orbit', texto: '/login' });
  conferir('POST /instancias com /login → 403 comando_nao_permitido', r.status === 403 && r.json.erro === 'comando_nao_permitido', r);
  await dormir(700); // a resposta do agente às mensagens acima termina

  // ── compactar, limpar, encerrar, retomar, autocompactar ──
  r = await POST('/sessao/s4/compactar', {});
  conferir('compactar numa sessão ocupada → 409 ocupada', r.status === 409 && r.json.codigo === 'ocupada', r);
  r = await POST('/sessao/s5/compactar', { foco: 'x'.repeat(2001) });
  conferir('compactar foco > 2000 → 400', r.status === 400 && r.json.erro === 'foco_invalido', r);
  r = await POST('/sessao/s5/compactar', { foco: 'só o essencial' });
  conferir('compactar → 202 com acao {tipo, sessao, estado}', r.status === 202 && r.json.acao.tipo === 'compactar' && r.json.acao.sessao === 's5' && r.json.acao.estado === 'em_andamento', r);
  await dormir(700);
  const conv5 = (await GET('/sessao/s5/conversa')).json;
  conferir('  ... depois a conversa ganha o item compactacao', conv5.itens.some((i) => i.tipo === 'compactacao' && i.pre > i.pos), conv5.itens.map((i) => i.tipo));
  r = await POST('/sessao/s5/limpar', {});
  conferir('limpar sem confirmar → 400 confirmar_obrigatorio', r.status === 400 && r.json.erro === 'confirmar_obrigatorio', r);
  r = await POST('/sessao/s5/limpar', { confirmar: true });
  conferir('limpar com confirmar → 202', r.status === 202 && r.json.acao.tipo === 'limpar', r);
  await dormir(700);
  conferir('  ... e esvazia a conversa', (await GET('/sessao/s5/conversa')).json.itens.length === 0);
  r = await POST('/sessao/s4/encerrar', { forcar: true });
  conferir('encerrar sessão ocupada → 409 ocupada (o remoto nunca força)', r.status === 409 && r.json.codigo === 'ocupada', r);
  r = await POST('/sessao/s5/encerrar', {});
  conferir('encerrar → 202', r.status === 202 && r.json.acao.tipo === 'encerrar', r);
  await dormir(500);
  conferir('  ... a sessão dorme (SSE sessao)', ultima('s5')?.controle.processo === 'dormindo', ultima('s5')?.controle);
  conferir('encerrar de novo → 409 dormindo', (await POST('/sessao/s5/encerrar', {})).json?.codigo === 'dormindo');
  r = await POST('/sessao/s5/retomar', {});
  conferir('retomar → 202', r.status === 202 && r.json.acao.tipo === 'retomar', r);
  await dormir(500);
  conferir('  ... a sessão volta a viver (SSE sessao)', ultima('s5')?.controle.processo === 'vivo', ultima('s5')?.controle);
  conferir('retomar viva → 409 viva', (await POST('/sessao/s5/retomar', {})).json?.codigo === 'viva');
  r = await POST('/sessao/s5/autocompactar', { ativo: true });
  conferir('autocompactar {ativo:true} → 200 {autoCompactar}', r.status === 200 && r.json.autoCompactar.ligada === true && r.json.autoCompactar.propria === true, r);
  await dormir(100);
  conferir('  ... e sai pelo SSE', ultima('s5')?.controle.autoCompactar?.propria === true);
  conferir('autocompactar sem booleano → 400', (await POST('/sessao/s5/autocompactar', { ativo: 'sim' })).status === 400);

  // ── ideias ──
  r = await GET('/ideias');
  conferir('GET /ideias: 3 ideias {id, texto, data, feita}', r.status === 200 && r.json.ideias.length === 3 && r.json.ideias.every((i) => i.id && i.texto && i.data && typeof i.feita === 'boolean'), r.json);
  r = await POST('/ideias/nova', { texto: 'Ideia de teste' });
  const nova = r.json?.id;
  conferir('ideias/nova: no topo da lista', r.status === 200 && r.json.ok && nova && r.json.ideias.length === 4 && r.json.ideias[0].id === nova, r.json);
  conferir('ideias/nova vazia → 400 texto_invalido', (await POST('/ideias/nova', { texto: '   ' })).json?.erro === 'texto_invalido');
  conferir('ideias/nova com chave extra → 400 campo_nao_permitido', (await POST('/ideias/nova', { texto: 'a', feita: true })).json?.erro === 'campo_nao_permitido');
  r = await POST('/ideias/editar', { id: nova, texto: 'Ideia editada' });
  conferir('ideias/editar', r.status === 200 && r.json.ideias.find((i) => i.id === nova).texto === 'Ideia editada', r.json);
  r = await POST('/ideias/feita', { id: nova, feita: true });
  conferir('ideias/feita', r.status === 200 && r.json.ideias.find((i) => i.id === nova).feita === true, r.json);
  conferir('ideias/feita sem booleano → 400', (await POST('/ideias/feita', { id: nova, feita: 'sim' })).json?.erro === 'feita_invalido');
  conferir('ideias/editar de id que não existe → 404', (await POST('/ideias/editar', { id: 'i-nao-existe', texto: 'x' })).status === 404);
  conferir('ideias/apagar com id inválido → 400 id_invalido', (await POST('/ideias/apagar', { id: '../x' })).json?.erro === 'id_invalido');
  r = await POST('/ideias/apagar', { id: nova });
  conferir('ideias/apagar', r.status === 200 && r.json.ideias.length === 3 && !r.json.ideias.some((i) => i.id === nova), r.json);

  // ── histórico, uso, notificações ──
  r = await GET('/remoto/historico');
  conferir('GET /remoto/historico: 5 avisos, sem cwd nem ultimaResposta', r.status === 200 && r.json.length === 5 && r.json.every((a) => a.id && a.tipo && a.quando && !('cwd' in a.sessao) && !('ultimaResposta' in a.sessao) && a.sessao.projeto), r.json);
  r = await POST('/uso/atualizar', {});
  await dormir(100);
  conferir('POST /uso/atualizar → 200 {ok, uso} e difunde uso', r.status === 200 && r.json.ok && r.json.uso.cincoHoras && fluxo.ev.some((e) => e.nome === 'uso'), r);
  await POST('/_mock/uso-bloqueio', { motivo: 'rodando' });
  conferir('uso/atualizar bloqueado → 409 motivo rodando', (await POST('/uso/atualizar', {})).json?.motivo === 'rodando');
  await POST('/_mock/uso-bloqueio', { motivo: null });
  r = await GET('/remoto/notificacoes');
  conferir('GET /remoto/notificacoes', r.status === 200 && r.json.naoPerturbe.inicio === '22:00' && typeof r.json.notificar.precisa === 'boolean' && typeof r.json.notificar.terminou === 'boolean', r.json);
  r = await POST('/remoto/nao-perturbe', { ativo: true, agendado: true, inicio: '23:30', fim: '06:45' });
  conferir('POST /remoto/nao-perturbe', r.status === 200 && r.json.ok && r.json.naoPerturbe.ativo === true && r.json.naoPerturbe.fim === '06:45', r.json);
  conferir('  ... e fica salvo', (await GET('/remoto/notificacoes')).json.naoPerturbe.inicio === '23:30');
  conferir('nao-perturbe com hora ruim → 400 inicio_invalido', (await POST('/remoto/nao-perturbe', { ativo: true, agendado: true, inicio: '25:00', fim: '06:45' })).json?.erro === 'inicio_invalido');
  conferir('nao-perturbe com campo faltando → 400', (await POST('/remoto/nao-perturbe', { ativo: true })).status === 400);
  r = await POST('/remoto/notificar', { terminou: true });
  conferir('POST /remoto/notificar {terminou}', r.status === 200 && r.json.notificar.terminou === true && r.json.notificar.precisa === true, r.json);
  conferir('notificar vazio → 400 nada_para_mudar', (await POST('/remoto/notificar', {})).json?.erro === 'nada_para_mudar');
  conferir('notificar com chave extra → 400', (await POST('/remoto/notificar', { precisa: true, x: 1 })).status === 400);

  // ── grafo ──
  const proj = encodeURIComponent('D:\\Projetos\\Orbit');
  r = await GET('/remoto/grafo?projeto=' + proj);
  conferir('GET /remoto/grafo: ~12 nós e ligações, pasta só pelo nome', r.status === 200 && r.json.nos.length === 12 && r.json.links.length >= 10 && !/[\\/]/.test(r.json.pasta) && r.json.truncado === false, { n: r.json?.nos?.length, pasta: r.json?.pasta });
  const ids = new Set(r.json.nos.map((n) => n.id));
  conferir('  ... toda ligação aponta para nós existentes', r.json.links.every((l) => ids.has(l.origem) && ids.has(l.destino)));
  conferir('  ... com notas, um anexo e uma nota inexistente', ['nota', 'anexo', 'inexistente'].every((t) => r.json.nos.some((n) => n.tipo === t)));
  conferir('grafo de pasta fora do cadastro → 403', (await GET('/remoto/grafo?projeto=' + encodeURIComponent('C:\\Windows'))).status === 403);
  conferir('grafo sem projeto → 403', (await GET('/remoto/grafo')).status === 403);
  conferir('grafo de projeto sem brain → 404 sem_brain', (await GET('/remoto/grafo?projeto=' + encodeURIComponent('D:\\Projetos\\Loja'))).json?.erro === 'sem_brain');
  const idNota = r.json.nos.find((n) => n.tipo === 'nota').id;
  r = await GET('/remoto/grafo/nota?projeto=' + proj + '&id=' + encodeURIComponent(idNota));
  conferir('GET /remoto/grafo/nota → {id, texto}', r.status === 200 && r.json.id === idNota && r.json.texto.includes('#'), r);
  conferir('nota com .. → 403 fora_do_brain', (await GET('/remoto/grafo/nota?projeto=' + proj + '&id=' + encodeURIComponent('../x.md'))).json?.erro === 'fora_do_brain');
  conferir('nota que não é .md → 403', (await GET('/remoto/grafo/nota?projeto=' + proj + '&id=' + encodeURIComponent('anexos/mapa.png'))).status === 403);
  conferir('nota inexistente → 404', (await GET('/remoto/grafo/nota?projeto=' + proj + '&id=' + encodeURIComponent('nada.md'))).status === 404);

  // ── /_mock/cair e /_mock/voltar ──
  const antes = fluxo.ev.length;
  r = await POST('/_mock/cair', {});
  await dormir(200);
  conferir('/_mock/cair → 200 e fecha os SSE', r.status === 200 && fluxo.fechou(), r);
  conferir('  ... tudo responde 503 (inclusive /m e /estado)', (await GET('/estado')).status === 503 && (await GET('/m')).status === 503 && (await POST('/uso/atualizar', {})).status === 503);
  conferir('  ... mas o /_mock/log segue respondendo', (await GET('/_mock/log')).status === 200);
  conferir('  ... e nada chegou no SSE depois de cair', fluxo.ev.length === antes);
  r = await POST('/_mock/voltar', {});
  conferir('/_mock/voltar → 200 e volta a responder', r.status === 200 && (await GET('/estado')).status === 200 && (await GET('/m')).status === 200);
  const fluxo2 = await abrirFluxo();
  await dormir(150);
  conferir('  ... e o SSE reconecta com evento inicio', fluxo2.status === 200 && fluxo2.ev[0]?.nome === 'inicio');
  fluxo2.parar();
  fluxo.parar();
} catch (e) {
  conferir('o teste não deu erro inesperado', false, String(e?.stack || e));
} finally {
  await mock.fechar();
}

const ruins = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - ruins.length}/${checks.length} conferências ok`);
process.exit(ruins.length ? 1 : 0);
