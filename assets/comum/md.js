// Orbit — markdown seguro em DOM, comum ao PC e ao celular. Script clássico, sem dependências: define só window.OrbitMd.
//   OrbitMd.render(texto) → DocumentFragment      (nunca innerHTML: todo texto entra por createTextNode/textContent)
// Blocos: parágrafos (quebra de linha vira <br>), títulos (div.md-h.md-h1..6), listas ul/ol com aninhamento por recuo,
// ``` código ``` (div.md-codigo > cabeçalho com linguagem + button.md-copiar, e pre > code), citações (blockquote),
// tabelas (div.md-tabela com rolagem lateral > table), linha horizontal. Inline: `código`, **negrito**, *itálico*,
// links [t](url) e URLs soltas só http(s):// e mailto: (target=_blank, rel="noopener noreferrer"); qualquer outro
// esquema (javascript:, data:...) vira texto com a URL ao lado (span.md-link + span.md-url, como no PC).
(function () {
  'use strict';
  const el = (tag, attrs, ...filhos) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, String(attrs[k]));
    for (const f of filhos) if (f != null) e.append(f);
    return e;
  };
  const SEGURO = /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i;

  // 1 `código`  2-3 [texto](url)  4 **negrito**  5 __negrito__  6 *itálico*  7 _itálico_  8 URL solta  9 \escape
  const FONTE_INLINE = /`([^`\n]+)`|\[((?:[^\[\]\n]|\[[^\]\n]*\])+)\]\(\s*([^)\s]+)(?:\s+"[^"\n]*")?\s*\)|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|_(?=[^\s_])([^_\n]*?[^\s_])_|(https?:\/\/[^\s<>]+)|\\([\\`*_{}\[\]()#+\-.!|>~])/g;
  const PALAVRA = /\w/;

  function inline(texto, prof) {
    const nos = [];
    const t = String(texto);
    const guardar = (s) => { if (s) nos.push(document.createTextNode(s)); };
    if (prof > 4) { guardar(t); return nos; }
    let pos = 0;
    const RE = new RegExp(FONTE_INLINE.source, 'g'); // uma por chamada: a recursão (negrito dentro de link...) não pode mexer no lastIndex do laço de fora
    let m;
    while ((m = RE.exec(t))) {
      const ini = m.index;
      let fim = ini + m[0].length;
      // Sublinhado só abre/fecha itálico entre não-palavras (snake_case e nomes_de_arquivo ficam como texto).
      if (m[7] != null && ((ini > 0 && PALAVRA.test(t[ini - 1])) || (fim < t.length && PALAVRA.test(t[fim])))) { RE.lastIndex = ini + 1; continue; }
      if (m[5] != null && ((ini > 0 && PALAVRA.test(t[ini - 1])) || (fim < t.length && PALAVRA.test(t[fim])))) { RE.lastIndex = ini + 1; continue; }
      let url = m[8];
      if (url) { // a pontuação final não faz parte da URL
        const cortada = url.replace(/[.,;:!?'")\]]+$/, '');
        fim -= url.length - cortada.length;
        url = cortada;
        RE.lastIndex = fim;
        if (!/^https?:\/\/\S+$/i.test(url)) { RE.lastIndex = ini + 1; continue; }
      }
      guardar(t.slice(pos, ini));
      pos = fim;
      if (m[1] != null) nos.push(el('code', null, m[1]));
      else if (m[2] != null) {
        const filhos = inline(m[2], prof + 1);
        if (SEGURO.test(m[3])) nos.push(el('a', { href: m[3], target: '_blank', rel: 'noopener noreferrer' }, ...filhos));
        else nos.push(el('span', { class: 'md-link' }, ...filhos), document.createTextNode(' '), el('span', { class: 'md-url' }, '(' + m[3] + ')'));
      } else if (m[4] != null || m[5] != null) nos.push(el('strong', null, ...inline(m[4] != null ? m[4] : m[5], prof + 1)));
      else if (m[6] != null || m[7] != null) nos.push(el('em', null, ...inline(m[6] != null ? m[6] : m[7], prof + 1)));
      else if (url) nos.push(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      else if (m[9] != null) nos.push(document.createTextNode(m[9]));
    }
    guardar(t.slice(pos));
    return nos;
  }

  // Botão "Copiar" do bloco de código: Clipboard API; sem ela (ou negada), seleciona o texto e tenta o comando "copy".
  function botaoCopiar(codigoEl, texto) {
    const b = el('button', { type: 'button', class: 'md-copiar', 'aria-label': 'Copiar o código' }, 'Copiar');
    let timer = 0;
    const aviso = (t) => { b.textContent = t; clearTimeout(timer); timer = setTimeout(() => { b.textContent = 'Copiar'; }, 1600); };
    const selecionar = () => {
      try {
        const r = document.createRange();
        r.selectNodeContents(codigoEl);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return true;
      } catch { return false; }
    };
    const plano = () => {
      selecionar();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      aviso(ok ? 'Copiado' : 'Selecionado');
    };
    b.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(() => aviso('Copiado'), plano);
      else plano();
    });
    return b;
  }
  function blocoCodigo(texto, lang) {
    const code = el('code', lang ? { class: 'language-' + lang.replace(/[^\w+#.-]/g, '') } : null, texto);
    return el('div', { class: 'md-codigo' },
      el('div', { class: 'md-codigo-cab' }, el('span', { class: 'md-lang' }, lang || ''), botaoCopiar(code, texto)),
      el('pre', null, code));
  }

  const LINHA_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const CERCA = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
  const TITULO = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const CITA = /^\s{0,3}>\s?(.*)$/;
  const SEP_TAB = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  const celulas = (l) => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const out = [];
    let cur = '';
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; } else if (s[k] === '|') { out.push(cur.trim()); cur = ''; } else cur += s[k];
    }
    out.push(cur.trim());
    return out;
  };
  const ehLinhaTabela = (l) => l.includes('|');
  const iniciaBloco = (l) => CERCA.test(l) || TITULO.test(l) || HR.test(l) || CITA.test(l) || LINHA_ITEM.test(l);

  function blocos(linhas, prof) {
    const frag = document.createDocumentFragment();
    let par = [];
    const fecharPar = () => {
      if (!par.length) return;
      const p = el('p');
      par.forEach((l, i) => { if (i) p.append(el('br')); p.append(...inline(l, 0)); });
      frag.append(p);
      par = [];
    };
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i];
      let m;
      if ((m = CERCA.exec(l))) { // bloco de código (sem fechamento: vai até o fim)
        fecharPar();
        const marca = m[1];
        const corpo = [];
        for (i++; i < linhas.length && !(new RegExp('^\\s*' + marca[0] + '{' + marca.length + ',}\\s*$').test(linhas[i])); i++) corpo.push(linhas[i]);
        frag.append(blocoCodigo(corpo.join('\n'), m[2]));
        continue;
      }
      if ((m = TITULO.exec(l))) {
        fecharPar();
        const n = m[1].length;
        frag.append(el('div', { class: 'md-h md-h' + n, role: 'heading', 'aria-level': n }, ...inline(m[2], 0)));
        continue;
      }
      if (HR.test(l)) { fecharPar(); frag.append(el('hr')); continue; }
      if (CITA.test(l)) {
        fecharPar();
        const cit = [];
        for (; i < linhas.length && CITA.test(linhas[i]); i++) cit.push(CITA.exec(linhas[i])[1]);
        i--;
        frag.append(prof < 4 ? el('blockquote', null, blocos(cit, prof + 1)) : el('blockquote', null, cit.join('\n')));
        continue;
      }
      if (ehLinhaTabela(l) && i + 1 < linhas.length && SEP_TAB.test(linhas[i + 1]) && linhas[i + 1].includes('-') && celulas(l).length === celulas(linhas[i + 1]).length) {
        fecharPar();
        const cab = celulas(l);
        const alinha = celulas(linhas[i + 1]).map((c) => (/^:-*:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
        const tbody = el('tbody');
        for (i += 2; i < linhas.length && linhas[i].trim() && ehLinhaTabela(linhas[i]); i++) {
          const cs = celulas(linhas[i]);
          tbody.append(el('tr', null, ...cab.map((_, k) => { const td = el('td', null, ...inline(cs[k] || '', 0)); if (alinha[k]) td.style.textAlign = alinha[k]; return td; })));
        }
        i--;
        const thead = el('thead', null, el('tr', null, ...cab.map((c, k) => { const th = el('th', { scope: 'col' }, ...inline(c, 0)); if (alinha[k]) th.style.textAlign = alinha[k]; return th; })));
        const caixa = el('div', { class: 'md-tabela' }, el('table', null, thead, tbody));
        caixa.style.overflowX = 'auto';
        caixa.style.maxWidth = '100%';
        frag.append(caixa);
        continue;
      }
      if (LINHA_ITEM.test(l)) { // lista (com aninhamento por recuo); linhas em branco entre itens não quebram a lista
        fecharPar();
        const pilha = []; // { recuo, tipo, el }
        for (; i < linhas.length; i++) {
          let li = LINHA_ITEM.exec(linhas[i]);
          if (!li && !linhas[i].trim()) {
            let j = i + 1;
            while (j < linhas.length && !linhas[j].trim()) j++;
            if (j < linhas.length && LINHA_ITEM.test(linhas[j])) { i = j - 1; continue; }
            break;
          }
          if (!li) {
            // continuação recuada do item anterior
            if (/^\s+\S/.test(linhas[i]) && pilha.length) { const ult = pilha[pilha.length - 1].el.lastElementChild; if (ult) { ult.append(el('br'), ...inline(linhas[i].trim(), 0)); continue; } }
            break;
          }
          const recuo = li[1].replace(/\t/g, '    ').length;
          const tipo = /\d/.test(li[2]) ? 'ol' : 'ul';
          while (pilha.length && recuo < pilha[pilha.length - 1].recuo) pilha.pop();
          let topo = pilha[pilha.length - 1];
          if (topo && recuo === topo.recuo && topo.tipo !== tipo) { pilha.pop(); topo = pilha[pilha.length - 1]; }
          if (!topo || recuo > topo.recuo || topo.tipo !== tipo) {
            const lista = el(tipo);
            if (tipo === 'ol' && /^\d+/.test(li[2]) && parseInt(li[2], 10) !== 1) lista.setAttribute('start', String(parseInt(li[2], 10)));
            const pai = topo && topo.el.lastElementChild;
            if (pai && recuo > topo.recuo) pai.append(lista); else frag.append(lista);
            pilha.push({ recuo, tipo, el: lista });
            topo = pilha[pilha.length - 1];
          }
          topo.el.append(el('li', null, ...inline(li[3], 0)));
        }
        i--;
        continue;
      }
      if (!l.trim()) { fecharPar(); continue; }
      par.push(l);
      // Um bloco novo logo na linha seguinte encerra o parágrafo (o laço o trata na próxima volta).
      if (i + 1 < linhas.length && iniciaBloco(linhas[i + 1])) fecharPar();
    }
    fecharPar();
    return frag;
  }

  function render(texto) {
    return blocos(String(texto == null ? '' : texto).replace(/\r\n?/g, '\n').split('\n'), 0);
  }
  window.OrbitMd = { render };
})();
