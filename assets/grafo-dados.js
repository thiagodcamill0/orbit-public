// Filtro local do Grafo: subgrafo ao redor de uma nota (BFS). Global: globalThis.GrafoDados.
(function () {
  'use strict';
  function local(dados, id, opc) {
    const o = Object.assign({ profundidade: 1, entrada: true, saida: true, vizinhos: true }, opc || {});
    const nos = (dados && dados.nos) || [];
    const links = (dados && dados.links) || [];
    if (!nos.some((n) => n.id === id)) return { nos: [], links: [] };
    const saidas = new Map(), entradas = new Map();
    for (const l of links) {
      (saidas.get(l.origem) || saidas.set(l.origem, []).get(l.origem)).push(l.destino);
      (entradas.get(l.destino) || entradas.set(l.destino, []).get(l.destino)).push(l.origem);
    }
    const dist = new Map([[id, 0]]);
    let fronteira = [id];
    for (let d = 1; d <= o.profundidade && fronteira.length; d++) {
      const prox = [];
      for (const n of fronteira) {
        const vs = [].concat(o.saida ? saidas.get(n) || [] : [], o.entrada ? entradas.get(n) || [] : []);
        for (const v of vs) if (!dist.has(v)) { dist.set(v, d); prox.push(v); }
      }
      fronteira = prox;
    }
    const resNos = nos.filter((n) => dist.has(n.id));
    const resLinks = links.filter((l) => dist.has(l.origem) && dist.has(l.destino) &&
      (o.vizinhos || l.origem === id || l.destino === id));
    return { nos: resNos, links: resLinks };
  }
  function padroes() {
    return {
      busca: '', tags: false, anexos: false, soExistentes: false, orfaos: true, grupos: [], corPorPasta: true,
      setas: false, fadeTexto: 0, tamanhoNo: 1, espessuraLink: 1,
      centro: 0.518713, repulsao: 10, link: 1, distancia: 250,
      local: { profundidade: 1, entrada: true, saida: true, vizinhos: true },
    };
  }

  // Minúsculas e sem acentos.
  function norm(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

  // Consulta -> lista de grupos OR, cada um com termos {neg, tipo, valor} (E entre eles).
  function analisar(consulta) {
    const grupos = [[]];
    const re = /(-?)(?:(path|file|tag):)?(?:"([^"]*)"|(\S+))/gi;
    let m;
    const s = String(consulta || '');
    while ((m = re.exec(s))) {
      if (m[3] === undefined && m[4] === 'OR' && !m[1] && !m[2]) { grupos.push([]); continue; }
      const valor = norm(m[3] !== undefined ? m[3] : m[4]);
      if (!valor) continue;
      grupos[grupos.length - 1].push({ neg: m[1] === '-', tipo: m[2] ? m[2].toLowerCase() : '', valor: valor });
    }
    return grupos.filter((g) => g.length);
  }

  function casaTermo(no, t) {
    const id = norm(no.id), nome = norm(no.nome);
    let r;
    if (t.tipo === 'path') r = id.includes(t.valor);
    else if (t.tipo === 'file') r = nome.includes(t.valor);
    else if (t.tipo === 'tag') {
      const v = t.valor.replace(/^#/, '');
      const lista = (no.tags || []).map((x) => norm(x).replace(/^#/, ''));
      if (no.tipo === 'tag') lista.push(norm(no.id).replace(/^#/, ''));
      r = lista.some((x) => x === v || x.startsWith(v + '/'));
    } else r = nome.includes(t.valor) || id.includes(t.valor);
    return t.neg ? !r : r;
  }

  function casa(no, consulta) {
    const gs = analisar(consulta);
    if (!gs.length) return true;
    return gs.some((g) => g.every((t) => casaTermo(no, t)));
  }

  // ── Grupos automáticos por pasta de primeiro nível ──
  // Slots de cor (--grafo-g1..g6 em grafo.css): 1 cinza-claro, 2 verde, 3 laranja, 4 amarelo, 5 rosa, 6 violeta.
  const CONHECIDOS = [
    { chave: 'decisoes', slot: 1, re: /^decis/ }, { chave: 'tarefas', slot: 2, re: /^tarefa/ },
    { chave: 'referencias', slot: 3, re: /^referenc/ }, { chave: 'padroes', slot: 4, re: /^padr(ao|oes)$/ },
    { chave: 'diario', slot: 5, re: /^diari/ }, { chave: 'gestor', slot: 6, re: /^(projeto|gestor)$/ },
  ];
  const VAR = (nome) => 'var(--grafo-' + nome + ')';

  // Classifica uma nota: { chave, rotulo, slot } ou null (tag/anexo/inexistente mantêm a cor de tipo).
  function pastaDe(no) {
    if (no.tipo && no.tipo !== 'nota') return null;
    const partes = String(no.id).split('/');
    if (partes.length < 2) return { chave: 'gestor', rotulo: 'Gestor e projeto', slot: 6 };
    const pasta = partes[0];
    if (pasta.charAt(0) === '_') return { chave: 'bastidores', rotulo: 'Bastidores', slot: -1 };
    const rotulo = pasta.replace(/^[\d\s._-]+/, '').trim() || pasta;
    const palavras = norm(rotulo).split(/[^a-z0-9]+/).filter(Boolean);
    for (const c of CONHECIDOS) {
      if (palavras.some((p) => c.re.test(p))) return { chave: c.chave, rotulo: c.chave === 'gestor' ? 'Gestor e projeto' : rotulo, slot: c.slot };
    }
    return { chave: 'p:' + norm(rotulo), rotulo: rotulo, slot: 0 };
  }

  // Mapa id -> { chave, rotulo, cor } para as notas de `nos` (cor = 'var(--grafo-...)').
  function gruposPorPasta(nos) {
    const grupos = new Map(), porNo = new Map();
    for (const n of nos) {
      const g = pastaDe(n);
      if (!g) continue;
      const e = grupos.get(g.chave) || grupos.set(g.chave, Object.assign({ n: 0 }, g)).get(g.chave);
      e.n++;
      porNo.set(n.id, e);
    }
    const usados = new Set([...grupos.values()].map((g) => g.slot));
    const livres = [1, 2, 3, 4, 5, 6].filter((s) => !usados.has(s));
    const novos = [...grupos.values()].filter((g) => g.slot === 0).sort((a, b) => b.n - a.n || (a.rotulo < b.rotulo ? -1 : 1));
    for (const g of novos) g.slot = livres.length ? livres.shift() : -2;
    const outras = { chave: 'outras', rotulo: 'Outras', cor: VAR('g-outras') };
    for (const g of grupos.values()) g.cor = g.slot > 0 ? VAR('g' + g.slot) : VAR('g-bastidores');
    for (const [id, g] of porNo) if (g.slot === -2) porNo.set(id, outras);
    return porNo;
  }

  function filtrar(dados, opcoes) {
    const o = Object.assign(padroes(), opcoes || {});
    let nos = ((dados && dados.nos) || []).map((n) => Object.assign({}, n));
    let links = ((dados && dados.links) || []).map((l) => Object.assign({}, l));
    const manter = (fn) => {
      nos = nos.filter(fn);
      const ids = new Set(nos.map((n) => n.id));
      links = links.filter((l) => ids.has(l.origem) && ids.has(l.destino));
    };
    if (String(o.busca || '').trim()) manter((n) => casa(n, o.busca));
    if (!o.anexos) manter((n) => n.tipo !== 'anexo');
    if (o.soExistentes) manter((n) => n.tipo !== 'inexistente');
    if (o.tags) {
      const ids = new Set(nos.map((n) => n.id));
      const novos = new Map();
      for (const n of nos.slice()) {
        for (const t of n.tags || []) {
          const nome = '#' + String(t).replace(/^#/, '');
          if (!novos.has(nome)) novos.set(nome, ids.has(nome) ? null : { id: nome, nome: nome, tipo: 'tag', tags: [] });
          links.push({ origem: n.id, destino: nome });
        }
      }
      for (const t of novos.values()) if (t) nos.push(t);
    }
    if (!o.orfaos) {
      const com = new Set();
      for (const l of links) { com.add(l.origem); com.add(l.destino); }
      nos = nos.filter((n) => com.has(n.id));
    }
    const auto = o.corPorPasta ? gruposPorPasta((dados && dados.nos) || []) : null;
    for (const n of nos) {
      const ga = auto && auto.get(n.id);
      if (ga) { n.cor = ga.cor; n.grupo = ga.chave; n.grupoRotulo = ga.rotulo; }
      for (const g of o.grupos || []) {
        if (g && g.consulta && casa(n, g.consulta)) { n.cor = g.cor; delete n.grupo; delete n.grupoRotulo; break; }
      }
    }
    return { nos: nos, links: links };
  }

  globalThis.GrafoDados = { local: local, padroes: padroes, casa: casa, filtrar: filtrar };
})();
