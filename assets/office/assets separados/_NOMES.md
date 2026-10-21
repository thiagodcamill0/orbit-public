# Nomes dos assets do Office

Salve cada PNG nesta pasta como `<sala>-<peça>.png`. Quando a mesma peça se repete na sala, ela leva um número:
`-1`, `-2`... contados **de cima para baixo e, na mesma linha, da esquerda para a direita**. Veja `_mapa-dos-nomes.png`.

Maiúsculas, acentos, espaços e `_` são ignorados, e o sufixo `@2x` também (`Frontend_Planta 2@2x.png` vale `frontend-planta-2`).
Peça que junta vários elementos (ex.: sofás + mesinha + tapete): ela ocupa a união dos retângulos deles,
e cada um mantém a própria colisão. Arquivos que começam com `_` são ignorados. A margem transparente em volta do desenho é cortada sozinha.

Tamanho: 40 px por célula a 1x. Desenhe de preferência a **2x (80 px por célula)**. A peça é ajustada ao retângulo
do elemento; com proporção diferente, ela entra centralizada, sem distorcer. Use PNG com transparência: por baixo de cada peça fica o piso.
Posição, tamanho e colisão não mudam, porque vêm do CONFIG.

**Telas das estações:** o brilho do monitor é desenhado por cima, em posição fixa, no canto superior direito da mesa
(a 2x: x 172–232, y 10–52 dentro da peça de 240×160). A estação da Mestre tem uma segunda tela no canto esquerdo (x 8–68).
Desenhe o monitor nesse lugar.

**Salas (`<sala>-sala`):** só as paredes, de borda a borda da imagem, com o miolo em magenta puro (#FF00FF) ou
transparente; o carpete (`<sala>-piso`) entra onde a parede não está. A parede pode ter até 1 célula de espessura (80 px a 2x),
que é a área que já bloqueia os robôs. As portas são vãos abertos (veja as células na tabela da sala e `_mapa-dos-nomes.png`).
Mantenha liso o canto superior esquerdo da parede de cima (a 2x: x 104–288).
Miolo de cor sólida (ex.: preto) também serve: ele é removido a partir do centro. Fundo sólido nas bordas é removido sozinho.

**Corredor com textura:** em `_apelidos.json`, o item `{"elemento": "corredor", "textura": "#RRGGBB"}` na lista de um
arquivo repete esse PNG no corredor e nos vãos das portas, tingido nessa cor média (hoje: `carpete-1.png` em cinza `#2e2e2e`).

## Corredor

| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |
|---|---|---|---|---|
| `corredor.png` | corredor que liga as portas | 48×3 | 3840×240 | não |

## frontend

| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |
|---|---|---|---|---|
| `frontend-sala.png` | sala inteira (paredes, piso, portas) | 15×12 | 1200×960 | sim |
| `frontend-piso.png` | textura do chão (repetida, escurecida; não bloqueia) | 15×12 | 1200×960 | não |
| `frontend-porta.png` | soleira da porta (altura da parede, centralizada no vão; não bloqueia) | 2×1 | 160×80 | não |
| `frontend-lousa.png` | lousa | 4×1 | 320×80 | sim |
| `frontend-planta-1.png` | planta | 1×1 | 80×80 | sim |
| `frontend-planta-2.png` | planta | 1×1 | 80×80 | sim |
| `frontend-planta-3.png` | planta | 1×1 | 80×80 | sim |
| `frontend-estante.png` | estante | 1×2 | 80×160 | sim |
| `frontend-estacao-1.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `frontend-estacao-2.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `frontend-estacao-3.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |

## mestre

| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |
|---|---|---|---|---|
| `mestre-sala.png` | sala inteira (paredes, piso, portas) | 16×12 | 1280×960 | sim |
| `mestre-piso.png` | textura do chão (repetida, escurecida; não bloqueia) | 16×12 | 1280×960 | não |
| `mestre-porta.png` | soleira da porta (altura da parede, centralizada no vão; não bloqueia) | 2×1 | 160×80 | não |
| `mestre-lousa.png` | lousa | 6×2 | 480×160 | sim |
| `mestre-planta-1.png` | planta | 1×1 | 80×80 | sim |
| `mestre-planta-2.png` | planta | 1×1 | 80×80 | sim |
| `mestre-planta-3.png` | planta | 1×1 | 80×80 | sim |
| `mestre-arquivo.png` | arquivo | 1×2 | 80×160 | sim |
| `mestre-estacao-1.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `mestre-estacao-2.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `mestre-estacao-3.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |

## backend

| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |
|---|---|---|---|---|
| `backend-sala.png` | sala inteira (paredes, piso, portas) | 15×12 | 1200×960 | sim |
| `backend-piso.png` | textura do chão (repetida, escurecida; não bloqueia) | 15×12 | 1200×960 | não |
| `backend-porta.png` | soleira da porta (altura da parede, centralizada no vão; não bloqueia) | 2×1 | 160×80 | não |
| `backend-rack-1.png` | rack de servidor | 1×2 | 80×160 | sim |
| `backend-rack-2.png` | rack de servidor | 1×2 | 80×160 | sim |
| `backend-rack-3.png` | rack de servidor | 1×3 | 80×240 | sim |
| `backend-planta-1.png` | planta | 1×1 | 80×80 | sim |
| `backend-planta-2.png` | planta | 1×1 | 80×80 | sim |
| `backend-arquivo.png` | arquivo | 1×2 | 80×160 | sim |
| `backend-estacao-1.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `backend-estacao-2.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `backend-estacao-3.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |

## tester

| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |
|---|---|---|---|---|
| `tester-sala.png` | sala inteira (paredes, piso, portas) | 14×13 | 1120×1040 | sim |
| `tester-piso.png` | textura do chão (repetida, escurecida; não bloqueia) | 14×13 | 1120×1040 | não |
| `tester-porta.png` | soleira da porta (altura da parede, centralizada no vão; não bloqueia) | 2×1 | 160×80 | não |
| `tester-bancada.png` | bancada | 6×2 | 480×160 | sim |
| `tester-planta-1.png` | planta | 1×1 | 80×80 | sim |
| `tester-planta-2.png` | planta | 1×1 | 80×80 | sim |
| `tester-arquivo.png` | arquivo | 1×2 | 80×160 | sim |
| `tester-estacao-1.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `tester-estacao-2.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `tester-estacao-3.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |

## descanso

| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |
|---|---|---|---|---|
| `descanso-sala.png` | sala inteira (paredes, piso, portas) | 18×13 | 1440×1040 | sim |
| `descanso-piso.png` | textura do chão (repetida, escurecida; não bloqueia) | 18×13 | 1440×1040 | não |
| `descanso-porta-1.png` | soleira da porta (altura da parede, centralizada no vão; não bloqueia) | 2×1 | 160×80 | não |
| `descanso-porta-2.png` | soleira da porta (altura da parede, centralizada no vão; não bloqueia) | 2×1 | 160×80 | não |
| `descanso-tapete.png` | tapete (não bloqueia) | 6×7 | 480×560 | não |
| `descanso-sofa-1.png` | sofá | 4×2 | 320×160 | sim |
| `descanso-sofa-2.png` | sofá | 4×2 | 320×160 | sim |
| `descanso-mesinha.png` | mesinha | 2×1 | 160×80 | sim |
| `descanso-cafe.png` | máquina de café | 1×3 | 80×240 | sim |
| `descanso-pingpong.png` | mesa de pingue-pongue | 4×2 | 320×160 | sim |
| `descanso-puff-1.png` | puff | 1×1 | 80×80 | sim |
| `descanso-puff-2.png` | puff | 1×1 | 80×80 | sim |
| `descanso-planta-1.png` | planta | 1×1 | 80×80 | sim |
| `descanso-planta-2.png` | planta | 1×1 | 80×80 | sim |
| `descanso-planta-3.png` | planta | 1×1 | 80×80 | sim |

## pesquisador

| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |
|---|---|---|---|---|
| `pesquisador-sala.png` | sala inteira (paredes, piso, portas) | 14×13 | 1120×1040 | sim |
| `pesquisador-piso.png` | textura do chão (repetida, escurecida; não bloqueia) | 14×13 | 1120×1040 | não |
| `pesquisador-porta.png` | soleira da porta (altura da parede, centralizada no vão; não bloqueia) | 2×1 | 160×80 | não |
| `pesquisador-estante-1.png` | estante | 1×5 | 80×400 | sim |
| `pesquisador-estante-2.png` | estante | 4×1 | 320×80 | sim |
| `pesquisador-planta.png` | planta | 1×1 | 80×80 | sim |
| `pesquisador-globo.png` | globo | 1×2 | 80×160 | sim |
| `pesquisador-estacao-1.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `pesquisador-estacao-2.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
| `pesquisador-estacao-3.png` | estação (mesa 3×1 + cadeira na célula de baixo) | 3×2 | 240×160 | sim |
