# Especificação — imagem de fundo da Visão de Office

desenhada à mão ou montada em peças. A fonte da verdade é o `CONFIG` de
`assets/office.js`. Se a arte e o `CONFIG` discordarem, a arte está errada.

Arquivos de apoio, gerados direto do `CONFIG`:

- `assets/office/guia-layout.svg` e `assets/office/guia-layout.png` (1920×1120): o guia de
  layout. Serve de referência para a geração e de máscara para conferir o resultado.
- Legenda do guia:
  - cinza claro: piso por onde os robôs andam;
  - verde: portas e entrada;
  - branco: mesa;
  - vermelho: tela do monitor (o "quadrado de alerta");
  - tracejado vermelho: zona do brilho da tela;
  - laranja: cadeira (onde o robô fica);
  - azul: móvel que já existe;
  - roxo: célula nova de decoração;
  - amarelo tracejado: faixa do rótulo da sala.

---

## 1. O que a imagem é e o que ela não é

A imagem é **só o ambiente parado**: piso, paredes, portas, mesas, cadeiras e móveis. O
código continua desenhando por cima tudo o que muda ou tem sentido:

| Fica no código (não pode estar na imagem) | Por quê |
|---|---|
| Tela de cada monitor: apagada, ativa (índigo), espera (âmbar) e erro (vermelho, com triângulo) | É o "quadrado de alerta"; muda com o estado do agente |
| Nome e rótulo de cada sala ("FRONTEND trabalho") e "ENTRADA" | Texto nítido em qualquer tamanho; a imagem **não tem nenhum texto** |
| Fio colorido no topo de cada sala | Cor da função; já é desenhado pelo código |
| Robôs, crachás, balões e anel de seleção | Dinâmicos |

O resto do SVG atual (salas, móveis, mesas, cadeiras, trilha do corredor) sai quando a
imagem entrar.

## 2. Formato e dimensões

- **Proporção da imagem: 48 × 28 células, ou 12:7.** É a mesma proporção do palco de
  hoje, que não muda. A imagem cobre o palco inteiro, sem corte e sem faixa.
- **Original: 1920 × 1120 px (40 px por célula).** Opcional: @2x com 3840 × 2240 para
  telas retina. Todas as medidas em px desta especificação valem para o original.
- PNG, sRGB, sem transparência, sem moldura e sem sombra externa.
- **A borda da imagem é `#111111` liso**, a cor de fundo da aba. Assim o palco se funde
  com a página e não aparece um retângulo.
- **Tela do monitor:** 30 × 21 px (0,74 × 0,52 célula), como hoje. A tela da sala Mestre
  tem o mesmo tamanho, só que são duas.

### Se a arte vier em peças (uma por sala + o corredor)

Cada peça é colada no original exatamente neste retângulo (x, y, largura × altura, em
px). A peça inclui meia célula de "lado de fora" em volta da parede.

| Peça | Retângulo no original | Proporção | Linha central da parede |
|---|---|---|---|
| Frontend | 0, 0, 600 × 480 | 5:4 | 20, 20, 560 × 440 |
| Mestre | 640, 0, 640 × 480 | 4:3 | 660, 20, 600 × 440 |
| Backend | 1320, 0, 600 × 480 | 5:4 | 1340, 20, 560 × 440 |
| Tester | 0, 600, 560 × 520 | 14:13 | 20, 620, 520 × 480 |
| Descanso | 600, 600, 720 × 520 | 18:13 | 620, 620, 680 × 480 |
| Pesquisador | 1360, 600, 560 × 520 | 14:13 | 1380, 620, 520 × 480 |
| Corredor | 0, 460, 1920 × 160 | 12:1 | (piso andável de 480 a 600; as faixas de 20 px em cima e embaixo ficam sob as paredes das salas) |

As colunas entre as salas ficam fora de qualquer peça e são `#111111` liso:

- na fileira de cima, x 600–640 e 1280–1320, do y 0 ao 480;
- na fileira de baixo, x 560–600 e 1320–1360, do y 600 ao 1120.

## 3. Regras de ocupação (o caminho dos robôs)

O mapa abaixo é a grade de hoje com as células novas de decoração (`+`). Coluna = x,
linha = y. Uma célula mede 40 × 40 px no original.

```
    0         1         2         3         4
    012345678901234567890123456789012345678901234567
 0  ############### ################ ###############
 1  #........LLLLP# #........LLLLL+# #..........K+K#
 2  #+............# #.............+# #+.........K+K#
 3  #+............# #.............+# #+...........K#
 4  #.............# #..............# #.............#
 5  #.MMM....MMM..# #.....MMM......# #.MMM....MMM..#
 6  #..c......c...# #......c.......# #..c......c...#
 7  #.............# #..............# #.............#
 8  #.....MMM.....# #.MMM......MMM.# #....MMM......#
 9  #......c......# #..c........c..# #.....c.......#
10  #P...........+# #P............P# #P...........+#
11  ######DD####### #######DD####### ######DD#######
12  ................................................
13  >...............................................
14  ................................................
15  ######DD###### #######DD####DD### ######DD######
16  #...........P# #...............P# #............#
17  #+...........# #................# #+..........E#
18  #+..........+# #..,,,,,,..u..u..# #+..........E#
19  #.MMM...MMM.+# #F.,SSSS,........# #.MMM...MMM.E#
20  #..c.....c..+# #F.,,,,,,........# #..c.....c..E#
21  #............# #F.,,mm,,........# #...........E#
22  #............# #..,,,,,,..GGGG..# #............#
23  #....MMM.....# #..,SSSS,..GGGG..# #...MMM......#
24  #.....c......# #..,,,,,,........# #....c.......#
25  #............# #................# #...........+#
26  #P.......BBBB# #P..............P# #P.....EEEE.+#
27  ############## ################## ##############
```

Legenda: `.` piso andável · `,` tapete (andável) · `c` cadeira/estação · `M` mesa ·
`D` porta · `>` entrada · `#` parede · espaço = lado de fora · `L` lousa · `P` planta ·
`K` rack · `E` estante · `B` bancada · `S` sofá · `m` mesinha · `F` café ·
`G` pingue-pongue · `u` pufe · `+` decoração nova.

Conferido com o script do guia: com as células `+` bloqueadas, todas as células andáveis
continuam ligadas à entrada (0 isoladas).

**Regra 1. Piso andável (`.`, `,`, `c`, `D`, `>`) só leva coisa plana.** Pode: piso,
rejunte, tapete, poça de luz suave e marca no chão. Não pode: planta, caixa, cadeira
solta, lixeira, luminária de pé, cabo atravessando, sofá ou banco. O robô passa por cima
dessas células, e um objeto ali parece atravessado.

**Regra 2. Objeto com volume só pode ficar:**
- (a) na célula de parede (`#`), desde que preso à parede e sem invadir o piso: luminária
  de parede, quadro, prateleira rasa, tomada ou rodapé;
- (b) nas células de móvel listadas na seção 6;
- (c) nas células `+` da seção 6.1.

Nada fora disso.

**Regra 3. O lado de fora fica vazio.** As colunas entre salas e as bordas são `#111111`
liso, sem planta e sem muro texturizado.

**Regra 4. Margem do robô.** O robô ocupa cerca de 1,5 célula de altura acima do pé, e o
pé fica a 0,82 da célula. Objeto alto (planta, estante) logo acima de uma célula andável
pode ser coberto pelo robô. Isso é aceitável, mas não pode haver objeto **mais claro que
o robô** atrás de uma estação, para ele não sumir.

## 4. Corredor, entrada e portas

**Corredor:** linhas 12, 13 e 14, de ponta a ponta (x 0–1920, y 480–600).
- É inteiro andável, então **não leva nenhum objeto**: sem sofá, sem planta e sem grade no
  meio.
- Pode ter: piso diferente do das salas, um pouco mais escuro (`#141414`); uma trilha
  pontilhada sutil no centro (y 540); e luminárias **na parede** das salas, nas linhas 11
  e 15, viradas para o corredor.

**Entrada:** ponta esquerda do corredor, na célula (0,13), em px (0, 520).
- O corredor fica **aberto** na borda esquerda, como uma saída para fora da planta.
- Pode ter soleira ou capacho plano.
- A ponta direita (x 1920) é parede fechada.
- O texto "ENTRADA" é do código e fica em (44, 492); a zona de 160 × 24 px ali fica lisa.

**Portas:** vão de 2 células (80 px) na parede, exatamente nestes retângulos.
- A porta é um **vão aberto**: sem folha atravessada e sem degrau alto.
- Leva batente dos dois lados (marco fino na cor da parede, um pouco mais claro).
- Pode ter soleira plana na cor do corredor.
- A parede termina no batente, sem invadir o vão.

| Sala | Células da porta | Vão em px (x, y, l × a) | Para onde dá |
|---|---|---|---|
| Frontend | (6–7, 11) | 240, 440, 80 × 40 | Corredor, de frente para a porta do Tester |
| Mestre | (23–24, 11) | 920, 440, 80 × 40 | Corredor, no eixo da mesa da Mestre |
| Backend | (39–40, 11) | 1560, 440, 80 × 40 | Corredor, no eixo da mesa de baixo |
| Tester | (6–7, 15) | 240, 600, 80 × 40 | Corredor, de frente para a porta do Frontend |
| Descanso, porta 1 | (22–23, 15) | 880, 600, 80 × 40 | Corredor, perto da Mestre |
| Descanso, porta 2 | (28–29, 15) | 1120, 600, 80 × 40 | Corredor, do lado do pingue-pongue |
| Pesquisador | (40–41, 15) | 1600, 600, 80 × 40 | Corredor, perto do Backend |

Estas são as únicas passagens que o A* usa: um robô só troca de sala saindo pela porta,
passando pelo corredor e entrando por outra porta. Por isso:

- **Não desenhar passagem nenhuma além destas.** Nada de porta entre salas vizinhas,
  porta na parede externa ou arco decorativo. Uma passagem desenhada que o robô não usa
  parece um bug.
- **As células logo dentro de cada porta continuam livres.** São a linha 10 nas salas de
  cima e a linha 16 nas de baixo. O caminho segue reto da porta até as mesas.
- As portas ficam no centro da parede de cada sala, viradas para o corredor. É o ponto
  mais curto entre a porta e as estações. O Frontend e o Tester ficam frente a frente; a
  Mestre fica a uma célula da Descanso e o Backend a uma do Pesquisador. Essa
  desigualdade é aceita e não precisa ser corrigida na arte.

## 5. Mesas, cadeiras e quadrados de alerta (posição fixa)

São 15 estações. As mesas medem 3 × 1 célula, e o robô fica na célula logo abaixo do
centro da mesa. **Nenhuma posição muda.**

| Estação | Mesa (x, y, l × a) | Centro da cadeira | Tela do monitor (vidro) | Zona do brilho |
|---|---|---|---|---|
| Frontend (3,6) | 83, 204, 114 × 32 | 140, 257 | 166, 205, 30 × 21 | 160, 197, 42 × 34 |
| Frontend (10,6) | 363, 204, 114 × 32 | 420, 257 | 446, 205, 30 × 21 | 440, 197, 42 × 34 |
| Frontend (7,9) | 243, 324, 114 × 32 | 300, 377 | 326, 325, 30 × 21 | 320, 317, 42 × 34 |
| Mestre (23,6), destaque | 883, 204, 114 × 32 | 940, 257 | 884, 205 **e** 966, 205 (30 × 21 cada) | 878, 197 e 960, 197 (42 × 34) |
| Mestre aux. (19,9) | 723, 324, 114 × 32 | 780, 377 | 806, 325, 30 × 21 | 800, 317, 42 × 34 |
| Mestre aux. (28,9) | 1083, 324, 114 × 32 | 1140, 377 | 1166, 325, 30 × 21 | 1160, 317, 42 × 34 |
| Backend (36,6) | 1403, 204, 114 × 32 | 1460, 257 | 1486, 205, 30 × 21 | 1480, 197, 42 × 34 |
| Backend (43,6) | 1683, 204, 114 × 32 | 1740, 257 | 1766, 205, 30 × 21 | 1760, 197, 42 × 34 |
| Backend (39,9) | 1523, 324, 114 × 32 | 1580, 377 | 1606, 325, 30 × 21 | 1600, 317, 42 × 34 |
| Tester (3,20) | 83, 764, 114 × 32 | 140, 817 | 166, 765, 30 × 21 | 160, 757, 42 × 34 |
| Tester (9,20) | 323, 764, 114 × 32 | 380, 817 | 406, 765, 30 × 21 | 400, 757, 42 × 34 |
| Tester (6,24) | 203, 924, 114 × 32 | 260, 977 | 286, 925, 30 × 21 | 280, 917, 42 × 34 |
| Pesquisador (37,20) | 1443, 764, 114 × 32 | 1500, 817 | 1526, 765, 30 × 21 | 1520, 757, 42 × 34 |
| Pesquisador (43,20) | 1683, 764, 114 × 32 | 1740, 817 | 1766, 765, 30 × 21 | 1760, 757, 42 × 34 |
| Pesquisador (39,24) | 1523, 924, 114 × 32 | 1580, 977 | 1606, 925, 30 × 21 | 1600, 917, 42 × 34 |

**Regras das estações**

- **Mesa:** tampo com a área da tabela, tolerância de ±2 px, cantos levemente arredondados
  e vista de cima. Cor `#1d1d1d` com borda `#343434`. A mesa da Mestre tem borda índigo
  sutil, `rgba(99,102,241,.45)`.
- **Monitor:**
  - moldura (bezel) de 2–3 px em volta do retângulo "vidro";
  - **a área do vidro é lisa e escura, `#0c0c0c`, sem reflexo, sem conteúdo e sem cor**.
    O código pinta por cima o estado (índigo, âmbar ou vermelho). Qualquer coisa
    desenhada ali compete com o alerta;
  - o monitor fica na **ponta direita** da mesa; na Mestre, há um em cada ponta.
- **Zona do brilho:** o retângulo tracejado em volta do vidro. Nada claro ou colorido
  dentro dele, para o brilho de espera ou erro ser lido sem ruído. Também nenhuma
  luminária, LED ou planta.
- **Teclado:** pode ser desenhado centrado na cadeira, 23 px abaixo do topo da célula da
  mesa, com 29 × 5 px, em `#2a2a2a` (ex.: Frontend (3,6) em 126, 223). Fica sob o robô.
- **Cadeira:** redonda, vista de cima, com raio de 12 px no centro da tabela, escura
  (`#1a1a1a` com borda `#2c2c2c`). O robô senta por cima.
- **Sem outros monitores.** Nenhuma tela extra, acesa ou apagada, sobre as mesas ou nas
  paredes perto delas. Tela de parede decorativa (gráfico ou código na lousa) só fica na
  célula de lousa e **sempre apagada ou em cinza**, nunca com cor de status.

## 6. Móveis (posição e tamanho fixos)

Cada móvel ocupa exatamente o retângulo das suas células. O desenho pode ter respiro
interno de 4 px, mas não pode transbordar para a célula vizinha.

| Sala | Móvel | Células (x, y, l × a) | px no original |
|---|---|---|---|
| Frontend | lousa | 9, 1, 4 × 1 | 360, 40, 160 × 40 |
| Frontend | planta | 13, 1 | 520, 40, 40 × 40 |
| Frontend | planta | 1, 10 | 40, 400, 40 × 40 |
| Mestre | lousa | 25, 1, 5 × 1 | 1000, 40, 200 × 40 |
| Mestre | planta | 17, 10 | 680, 400, 40 × 40 |
| Mestre | planta | 30, 10 | 1200, 400, 40 × 40 |
| Backend | rack | 44, 1, 1 × 2 | 1760, 40, 40 × 80 |
| Backend | rack | 46, 1, 1 × 3 | 1840, 40, 40 × 120 |
| Backend | planta | 34, 10 | 1360, 400, 40 × 40 |
| Tester | bancada de aparelhos | 9, 26, 4 × 1 | 360, 1040, 160 × 40 |
| Tester | planta | 1, 26 | 40, 1040, 40 × 40 |
| Tester | planta | 12, 16 | 480, 640, 40 × 40 |
| Descanso | tapete (**plano, andável**) | 18, 18, 6 × 7 | 720, 720, 240 × 280 |
| Descanso | sofá, encosto em cima | 19, 19, 4 × 1 | 760, 760, 160 × 40 |
| Descanso | mesinha de centro | 20, 21, 2 × 1 | 800, 840, 80 × 40 |
| Descanso | sofá, encosto embaixo | 19, 23, 4 × 1 | 760, 920, 160 × 40 |
| Descanso | café (máquina + xícaras) | 16, 19, 1 × 3 | 640, 760, 40 × 120 |
| Descanso | mesa de pingue-pongue | 26, 22, 4 × 2 | 1040, 880, 160 × 80 |
| Descanso | pufe | 26, 18 | 1040, 720, 40 × 40 |
| Descanso | pufe | 29, 18 | 1160, 720, 40 × 40 |
| Descanso | planta | 16, 26 | 640, 1040, 40 × 40 |
| Descanso | planta | 31, 26 | 1240, 1040, 40 × 40 |
| Descanso | planta | 31, 16 | 1240, 640, 40 × 40 |
| Pesquisador | estante | 46, 17, 1 × 5 | 1840, 680, 40 × 200 |
| Pesquisador | estante | 41, 26, 4 × 1 | 1640, 1040, 160 × 40 |
| Pesquisador | planta | 35, 26 | 1400, 1040, 40 × 40 |

O tapete da Descanso é o único objeto sobre piso andável. Por isso ele é plano, sem
franja alta e sem borda em relevo.

### 6.1 Células novas de decoração (`+`)

Escolhidas longe das portas, das estações e dos pontos de encontro (até 2 células ao lado
de cada estação). Entram no `CONFIG` como móveis que bloqueiam, junto com a imagem. O
conteúdo é livre dentro do tema da sala (seção 8), sempre encostado na parede.

| Sala | Células | px no original | Sugestão |
|---|---|---|---|
| Frontend | 1, 2, 1 × 2 | 40, 80, 40 × 80 | estante baixa com livros e componentes |
| Frontend | 13, 10 | 520, 400, 40 × 40 | planta ou lixeira |
| Mestre | 30, 1 | 1200, 40, 40 × 40 | planta |
| Mestre | 30, 2, 1 × 2 | 1200, 80, 40 × 80 | arquivo ou armário de pastas |
| Backend | 34, 2, 1 × 2 | 1360, 80, 40 × 80 | gabinete ou nobreak |
| Backend | 45, 1, 1 × 2 | 1800, 40, 40 × 80 | fecha o vão entre os racks (rack ou patch panel) |
| Backend | 46, 10 | 1840, 400, 40 × 40 | terminal ou planta |
| Tester | 1, 17, 1 × 2 | 40, 680, 40 × 80 | armário de dispositivos |
| Tester | 12, 18, 1 × 3 | 480, 720, 40 × 120 | quadro de checklist na parede + bancada estreita |
| Pesquisador | 35, 17, 1 × 2 | 1400, 680, 40 × 80 | arquivo ou globo |
| Pesquisador | 46, 25, 1 × 2 | 1840, 1000, 40 × 80 | estante baixa |

## 7. Zonas reservadas para o que o código desenha por cima

- **Faixa do rótulo:** em cada sala, as células x de `sala.x+1` a `sala.x+6`, com y de
  `sala.y+0,6` a `sala.y+1,4`. Em px, 240 × 32 a partir de (`sala.x*40+40`,
  `sala.y*40+24`).
  - Ali fica só piso ou parede lisa, sem objeto e sem luz forte.
  - Nas salas de cima, isso cai na linha 1 (de x 1 a 6, de 17 a 22 e de 34 a 39).
  - Nas de baixo, cai na linha 16.
- **Fio da sala:** uma linha de 92 px na parede de cima, a partir de `sala.x*40+52`. A
  parede fica lisa nesse trecho.
- **"ENTRADA":** a zona de 160 × 24 px em (44, 492).

## 8. Direção visual

### 8.1 Linguagem

- **Câmera:** vista de cima, ortogonal e sem perspectiva. Não é isométrica nem 3/4. A
  parede aparece como faixa grossa vista de cima, e os objetos mostram só o tampo, com no
  máximo 4 px de face frontal.
- **Pixel art limpa**, no mesmo traço do robô (`robot-idle.gif`, cinza, contorno escuro e
  sombreado em 2–3 tons).
  - Grão de 2 px no original: cada "pixel" da arte vale 2 × 2 px, ou 20 pixels de arte
    por célula.
  - Sem anti-aliasing borrado, sem gradiente suave grande, sem textura fotográfica e sem
    ruído.
- **Escala:** uma célula equivale a 50 cm. Mesa de 1,5 m, cadeira de 30 cm, planta em vaso
  de 40 cm. O robô aparece com 40–60 px; nada de móvel fora dessa escala.
- **Ar de app, não de jogo.** É a identidade Orbit: escuro, calmo, denso sem ficar
  apertado. O escritório é um objeto do painel, não um cenário. Menos é mais: cada sala
  tem 2 ou 3 elementos de personalidade, e o resto é piso limpo.

### 8.2 Paleta

Os neutros são quentes e escuros, nunca azulados. Valores de base, com variação de ±6
na luminosidade para textura:

| Uso | Cor |
|---|---|
| Lado de fora / borda da imagem | `#111111` (exato) |
| Piso do corredor | `#141414` |
| Piso das salas | `#161616`, rejunte `#1b1b1b` em grade de 1 célula |
| Piso da Descanso | `#151515` |
| Parede (tampo visto de cima) | `#262626` a `#2e2e2e`, aresta interna `#343434` |
| Móveis | `#1a1a1a` a `#232323`, contorno `#343434` a `#3a3a3a` |
| Destaques de metal ou plástico | no máximo `#4a4a4a` |
| Plantas | folha `#1c3b2a` / `#2c6345`, miolo `#2f6b47`, vaso `#171717` |
| Sofás da Descanso | índigo `rgba(99,102,241,.10–.22)` sobre o piso |
| Pufes | verde-água `rgba(45,212,191,.10–.40)` |
| Pingue-pongue | `#11231a`, linhas `#2a5a3e`, rede `#9ca3af` |

**Cor de função**, como acento, só em detalhe pequeno (luminária, lombada, almofada,
cabo), no máximo 3% da área da sala:

| Sala | Cor |
|---|---|
| Frontend | `#38bdf8` |
| Mestre | `#818cf8` |
| Backend | `#c084fc` |
| Tester | `#f472b6` |
| Pesquisador | `#2dd4bf` |
| Descanso | neutra (`#737373`) |

**Cores proibidas em área visível:** as cores de estado e o acento. Elas são do código
e, se aparecerem na arte, um enfeite se confunde com um alerta.

- `#0090ff` / `#70b8ff`: trabalhando.
- `#f59e0b` / `#fbbf24`: aguardando.
- `#ef4444` / `#f87171`: erro.
- `#22c55e`: ok.
- `#6366f1` saturado: seleção.

Na prática:

- **Nenhuma luminária âmbar ou laranja.** As luzes são brancas quentes e fracas (`#d6d3cd`
  a 20–35%) ou da cor da sala.
- Sem LED vermelho.
- Os LEDs dos racks são cinza-claro ou da cor da sala, nunca verde vivo.

### 8.3 Luz e contraste

- Luz ambiente uniforme e baixa. Sem vinheta, sem feixe e sem sombra projetada longa.
- Sombra de contato de 2 px sob os móveis, a `rgba(0,0,0,.35)`.
- Pontos de luz (luminárias de parede) são pequenos: menos de 2% da área. A poça de luz
  no piso fica a no máximo +4 de luminosidade sobre o piso.
- **Nenhum ponto de luz a menos de 1 célula de uma estação.**
- O piso nunca passa de `#1e1e1e`. O robô é cinza-claro e precisa de contraste de 4:1 ou
  mais contra o piso; os crachás e balões (`#111`/`#181818`) também precisam se destacar.

### 8.4 O que manter e o que corrigir da referência `agentes-office.png`

**Manter:**
- o tom geral;
- o traço pixel art;
- as lousas com gráfico e código em cinza;
- as estantes e os racks;
- a Descanso com sofás índigo, mesinha, pufes verde-água e pingue-pongue;
- as plantas nos cantos.

**Corrigir:**
- sofás, plantas e a grade no meio do corredor (Regra 1);
- luminárias âmbar (cor de "aguardando");
- texto dentro da imagem;
- mesas e portas fora das posições da grade (seções 4 e 5);
- objetos no piso andável perto das paredes laterais (armários dentro da sala, no
  Frontend e no Backend);
- telas de parede coloridas.

## 9. Personalidade de cada sala

Cada sala leva só o que está nas seções 5, 6 e 6.1. O tema muda a decoração dos móveis,
nunca a posição.

- **Frontend:**
  - lousa com wireframe em cinza;
  - estante (1,2) com livros e uma paleta de cores pequena;
  - acento azul-céu nas luminárias de parede.
- **Mestre:**
  - lousa larga com um quadro de tarefas (colunas em cinza);
  - armário de pastas em (30,2);
  - acento índigo;
  - a mesa central se destaca só pela borda índigo e pelos dois monitores; nada de tapete
    ou trono.
- **Backend:**
  - parede de racks na direita (44–46, linhas 1–3), formando um bloco contínuo;
  - gabinete em (34,2);
  - acento lilás nos LEDs dos racks.
- **Tester:**
  - bancada com 4 aparelhos (celular, tablet e dois notebooks fechados);
  - quadro de checklist com marcações em cinza;
  - acento rosa.
- **Descanso:**
  - tapete, dois sofás frente a frente com a mesinha entre eles;
  - café na parede esquerda;
  - pingue-pongue e os dois pufes;
  - quatro plantas;
  - sem mesas de trabalho;
  - é a sala com mais respiro: o piso livre à direita é onde os robôs param para
    descansar.
- **Pesquisador:**
  - estante alta na direita e estante baixa embaixo, com lombadas na cor da sala
    (verde-água apagado);
  - globo ou arquivo em (35,17);
  - acento verde-água.
- **Corredor:**
  - piso contínuo, mais escuro que as salas, com a trilha pontilhada no centro;
  - luminárias de parede viradas para ele, brancas quentes, espaçadas a cada ~8 células e
    fora das portas;
  - a entrada aberta à esquerda.

## 10. Como gerar

1. **Referências:**
   - `assets/office/guia-layout.png` (layout, obrigatória);
   - `agentes-office.png` (só estilo; o layout dela está errado).
2. **Por peça:** uma geração por sala, na proporção da tabela da seção 2.
   - Modelos e proporções disponíveis:
     - Frontend e Backend em 5:4 e Mestre em 4:3: exatas.
     - Tester e Pesquisador: gerar em 1:1 e cortar.
     - Descanso: gerar em 4:3 e cortar.
     - Corredor: gerar em 8:1 e cortar a altura.
   - Gerar a 2k e reduzir para o tamanho exato com filtro nearest-neighbor, para preservar
     o pixel.
3. **Prompt-base:**
   > Vista de cima ortogonal, pixel art limpa, escritório escuro e minimalista, piso cinza
   > quase preto com rejunte sutil, paredes como faixas grossas vistas de cima, sem texto,
   > sem pessoas, sem robôs, sem perspectiva. Siga o guia de layout exatamente: mesas
   > brancas do guia viram mesas escuras no mesmo lugar, os retângulos vermelhos viram
   > telas de monitor apagadas e lisas, os círculos laranja viram cadeiras redondas
   > escuras, os blocos azuis e roxos viram os móveis indicados, o verde vira vão de
   > porta aberto, e todo o cinza claro do guia vira piso vazio.
4. **Negativo:**
   > texto, letras, números, logotipo, pessoas, personagens, perspectiva isométrica, luz
   > laranja, luz âmbar, LED vermelho, telas acesas coloridas, objetos no corredor, sombra
   > longa, vinheta, desfoque, ruído.
5. **Montagem:**
   - colo as peças no original de 1920 × 1120 sobre `#111111`;
   - confiro com o guia por cima a 50%;
   - corrijo à mão o que passou de 2 px.

## 11. Critérios de aceite

A imagem só entra quando passa em todos:

1. **Dimensões:** 1920 × 1120 (ou 3840 × 2240), 12:7, borda `#111111` exata nos 4 lados.
2. **Sobreposição com o guia**, a 50%:
   - toda mesa, tela, cadeira, porta e móvel fica dentro de ±2 px do retângulo do guia;
   - nenhum objeto com volume fica sobre célula cinza-clara do guia.
3. **Telas:** os 16 retângulos de vidro estão lisos, escuros (`#0c0c0c` ±4) e sem
   conteúdo. As 16 zonas de brilho não têm nada claro nem colorido.
4. **Passagens:** existem só as 7 portas da tabela e a entrada. Nenhuma outra abertura
   desenhada.
5. **Cores:** nenhuma área maior que 4 × 4 px nas cores de estado proibidas (seção 8.2).
   O piso fica sempre em `#1e1e1e` ou abaixo.
6. **Texto:** nenhum. As faixas do rótulo e a zona "ENTRADA" ficam lisas.
7. **No app:**
   - `node testes/office.test.mjs` passa (0 robôs em célula bloqueada, 0 saltos, 0
     erros de console), já com as células `+` no `CONFIG`;
   - nas capturas em 1440 e 1024 e em tela cheia, os robôs sentam nas cadeiras da arte e
     o brilho de espera e de erro aparece sobre o monitor da arte.

## 12. O que muda no código quando a imagem chegar

- `CONFIG.fundo = '/assets/office/fundo.png'`, aplicado ao `.of-palco` com
  `background-size: 100% 100%` e `image-rendering: pixelated`.
- `desenharPlanta()` passa a desenhar só as telas (`of-tela`) e o fio das salas quando
  há fundo. Salas, móveis, mesas, cadeiras e a trilha deixam de ser desenhados, mas
  continuam no `CONFIG`, porque são eles que definem a grade do A*.
- As células da seção 6.1 entram em `moveis` de cada sala como `{ tipo: 'deco', ... }`,
  só para bloquear, sem desenho.
- Sem a imagem, ou se ela falhar ao carregar, o SVG atual volta inteiro. Esse é o modo
  de reserva.
