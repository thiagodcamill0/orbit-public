# Fundo do Office

`fundo.png`: 1920 × 1120; `fundo@2x.png`: 3840 × 2240. Pixel art desenhada por código, sem serviços de geração externos. A versão padrão está em `Office.CONFIG.fundo`.

O bitmap contém apenas o ambiente. As 16 telas, os fios das salas, os rótulos e os robôs continuam dinâmicos. O SVG completo aparece enquanto o PNG carrega e permanece disponível se o carregamento falhar. As 9 peças de decoração bloqueiam a grade pelo CONFIG.

Para regenerar, na raiz do projeto (Python com Pillow e Node no PATH):

```
python testes/gerar-fundo-office.py
```

O gerador lê o CONFIG atual, desenha em grade de 2 px, aplica os retângulos exatos dos vidros e produz os dois PNGs e `conferencia-layout.png` com o guia a 50%. Não usa aleatoriedade.

Para conferir no Edge:

```
node testes/office.test.mjs
```

A suíte verifica movimento, rótulos, estados, capturas em 1440/1024, tela cheia, camadas do fundo e falha deliberada do carregamento. O erro de rede induzido pelo teste de fallback é filtrado; demais erros continuam falhando a suíte.
