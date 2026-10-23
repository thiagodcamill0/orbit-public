// Orbit — GIFs dos mascotes/cenas e troca de sprite, comuns ao PC e ao celular. Script clássico, sem dependências:
// define só window.OrbitSprites (portado do index.html: srcGif, quadro parado, definirGif, trocarSprite; sem globais dele).
//   const S = OrbitSprites.criar({ base: 'assets/', versoes: { 'sprites/sprite-work': 2 }, estaticos: { cyber: 'assets/cyber.png' } });
//   img.dataset.gif = 'sprites/sprite-work'; S.definir(img, 'sprites/sprite-work');   // GIF, ou o quadro parado (PNG) se a aba está oculta
//   S.trocarSprite(img, 'sprites/sprite-music');                                      // fade cruzado de 0,34 s
//   S.ligar();                                                                        // reaplica quando a aba some/volta ou o movimento reduzido muda
// `OrbitSprites.srcGif/definir/trocarSprite/...` são a instância padrão (base 'assets/', sem versões nem estáticos).
// O fade usa a Web Animations API (sem CSS); com movimento reduzido ou aba oculta troca direto, sem fade.
(function () {
  'use strict';
  const EXT = /\.(gif|png|webp|jpe?g|svg|avif)(\?|#|$)/i;
  const ABS = /^(https?:|blob:|data:|\/)/i;

  function criar(opcoes) {
    const o = Object.assign({ base: 'assets/', versoes: {}, estaticos: {}, reduzido: null, duracao: 340 }, opcoes || {});
    const parado = Object.create(null); // nome → URL (blob) do quadro parado
    const reduzido = () => (typeof o.reduzido === 'function' ? !!o.reduzido() : !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches));
    const pausados = () => document.hidden || reduzido();
    // Nome sem extensão = GIF em base + nome + '.gif' (+ ?v=); com extensão ou URL absoluta = usado como veio.
    const urlBruta = (nome) => (ABS.test(nome) || EXT.test(nome) ? nome : o.base + nome + '.gif' + (o.versoes[nome] ? '?v=' + o.versoes[nome] : ''));
    const ehGif = (nome) => /\.gif(\?|#|$)/i.test(urlBruta(nome));

    function srcGif(nome) {
      if (o.estaticos[nome]) return o.estaticos[nome];
      if (!ehGif(nome)) return urlBruta(nome);
      return pausados() && parado[nome] ? parado[nome] : urlBruta(nome);
    }

    // Gera o quadro parado (canvas → PNG) de um GIF, uma vez; devolve uma promessa que termina quando ele existe (ou falha).
    const promessas = new Map();
    function prepararQuadro(nome) {
      if (o.estaticos[nome] || !ehGif(nome)) return Promise.resolve(null);
      if (parado[nome]) return Promise.resolve(parado[nome]);
      if (promessas.has(nome)) return promessas.get(nome);
      const p = new Promise((resolve) => {
        const im = new Image();
        im.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = im.naturalWidth;
            c.height = im.naturalHeight;
            c.getContext('2d').drawImage(im, 0, 0);
            // toBlob codifica fora da thread principal: as cenas chegam a 1736 px de largura.
            c.toBlob((b) => {
              if (b) { parado[nome] = URL.createObjectURL(b); atualizar(); }
              resolve(parado[nome] || null);
            }, 'image/png');
          } catch { promessas.delete(nome); resolve(null); }
        };
        im.onerror = () => { promessas.delete(nome); resolve(null); }; // tenta de novo no próximo pedido
        im.src = urlBruta(nome);
      });
      promessas.set(nome, p);
      return p;
    }

    function definir(img, nome) {
      if (img.dataset.gif !== nome) img.dataset.gif = nome;
      if (pausados()) prepararQuadro(nome);
      const s = srcGif(nome);
      if (img.getAttribute('src') !== s) img.src = s;
    }

    // Reaplica a todos os img[data-gif] da raiz (ao ocultar/mostrar a aba, mudar o movimento reduzido ou ficar pronto um quadro).
    function atualizar(raiz) {
      const pausa = pausados();
      for (const img of (raiz || document).querySelectorAll('img[data-gif]')) {
        const nome = img.dataset.gif;
        definir(img, nome);
        img.classList.toggle('sem-quadro', pausa && ehGif(nome) && !parado[nome] && !o.estaticos[nome]);
      }
    }

    function ligar(raiz) {
      const aoMudar = () => atualizar(raiz);
      document.addEventListener('visibilitychange', aoMudar);
      const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (mq && mq.addEventListener) mq.addEventListener('change', aoMudar);
      return () => {
        document.removeEventListener('visibilitychange', aoMudar);
        if (mq && mq.removeEventListener) mq.removeEventListener('change', aoMudar);
      };
    }

    // Troca suave: o sprite velho (um clone) fica por cima e some enquanto o novo aparece, só depois de decodificado.
    // Devolve uma promessa que termina quando a troca acabou. O contêiner deve sobrepor os filhos (grid 1/1 como o .av-robo);
    // fora de um grid, o clone vai em position:absolute sobre a imagem.
    function trocarSprite(img, nome) {
      const antes = img._spr;
      img._spr = nome;
      if (!antes || antes === nome || reduzido() || document.hidden || !img.isConnected || !img.animate) {
        definir(img, nome);
        return Promise.resolve();
      }
      const velho = img.cloneNode();
      velho.removeAttribute('data-gif');
      velho.removeAttribute('id');
      velho.classList.add('av-sai');
      velho.style.pointerEvents = 'none';
      velho.setAttribute('aria-hidden', 'true');
      if (!/grid/.test(getComputedStyle(img.parentNode).display)) {
        Object.assign(velho.style, { position: 'absolute', left: img.offsetLeft + 'px', top: img.offsetTop + 'px', width: img.offsetWidth + 'px', height: img.offsetHeight + 'px' });
      } else velho.style.gridArea = '1 / 1';
      img.after(velho);
      definir(img, nome);
      const tirar = () => velho.remove();
      const limite = setTimeout(tirar, 1500); // imagem que não carrega não prende o velho na tela
      const cfg = { duration: o.duracao, easing: 'cubic-bezier(.4, 0, .2, 1)' };
      return (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => {
        clearTimeout(limite);
        if (!velho.isConnected || img._spr !== nome) { tirar(); return; }
        img.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1)' }], cfg);
        return velho.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }], Object.assign({ fill: 'forwards' }, cfg)).finished
          .catch(() => {}).then(tirar);
      });
    }

    return { srcGif, preparar: prepararQuadro, definir, atualizar, ligar, trocarSprite, quadroParado: (nome) => parado[nome] || null };
  }

  const padrao = criar();
  window.OrbitSprites = Object.assign({ criar, padrao }, padrao);
})();
