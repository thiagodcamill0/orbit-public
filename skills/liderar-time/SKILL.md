---
name: liderar-time
description: Use sempre que for delegar trabalho a subagentes ou montar um time de agentes. Define como dividir tarefas, escolher o modelo de cada uma, limitar o contexto, registrar progresso em arquivo e receber resultados curtos, para economizar contexto sem perder qualidade.
---

<!-- Instalada pelo Orbit (node instalar.mjs --liderar-time). O instalador troca {{PROGRESSO}} pela pasta de
     progresso do Orbit desta máquina; --sem-liderar-time ou --remover a tiram. -->

# Quando usar
Sempre que for criar subagentes ou distribuir tarefas para um time.

# 1. Uma entrega por subagente
- Cada subagente tem uma entrega só: um objetivo claro, os arquivos envolvidos e um critério de "pronto" verificável (ex.: "teste X passa", "função Y retorna Z").
- Interface, testes de interface e integração com o servidor são entregas diferentes. Duas tarefas (A e B) nunca vão para o mesmo subagente.
- Se a entrega exige ler arquivos grandes ou muitas etapas, divida antes de delegar.

# 2. Escolher o modelo e o esforço
- Modelo econômico (Haiku) com esforço baixo: buscas, leitura de arquivos, levantamentos, resumos, listagens.
- Modelo intermediário (Sonnet) com esforço médio: implementação comum, ajustes de interface, testes, correções simples.
- Modelo mais forte (Opus) com esforço alto: arquitetura, decisões difíceis, bugs complexos, revisão final de mudanças críticas.
- Na dúvida entre dois, comece pelo mais econômico e só suba se o resultado não atender ao critério de "pronto".

# 3. Teto de contexto
- Teto de 140 mil tokens de contexto por subagente (o limite da compactação automática nas Configurações do Orbit; se ele mudar, vale o novo).
- Nunca reaproveite com SendMessage um subagente acima da metade do teto (70 mil): crie um novo a partir do arquivo de progresso.
- Se o subagente devolver "PRECISA_SUBSTITUIR: <arquivo>", ou o Orbit avisar que ele passou do limite, encerre-o e crie um novo que leia só esse arquivo.
- Em arquivos grandes, Grep e leitura por trechos; nada de reler o que já foi lido.
- Capturas de tela: poucas, pequenas (só a área ou o viewport necessários) e lidas uma vez cada. Para comparar antes e depois, descreva a diferença em texto em vez de reabrir a imagem.

# 4. Arquivo de progresso
- Os arquivos de progresso ficam na pasta do Orbit, nunca no projeto: `{{PROGRESSO}}/<nome da pasta do projeto>/<nome-da-tarefa>.md` (ex.: para o projeto em `C:\Projetos\loja`, `{{PROGRESSO}}/loja/tela-de-login.md`). Indique o caminho completo a cada subagente.
- Cada subagente cria e mantém o seu com: objetivo, critério de pronto, o que já foi feito, o que falta e decisões tomadas.
- Atualizar ao fim de cada etapa, não só no fim, em poucas linhas, substituindo o conteúdo em vez de acumular histórico. Assim o subagente pode ser substituído a qualquer momento.
- O substituto lê apenas esse arquivo, sem reler a conversa ou o código já analisado.
- Ao concluir a tarefa, o arquivo é apagado. O que for decisão importante vai para a documentação do projeto, em uma linha. (O Orbit apaga sozinho os esquecidos há mais de 7 dias.)

# 5. Resultado curto
- O subagente devolve ao líder no máximo 5 linhas: o que fez, se o critério de pronto foi atingido e qualquer pendência.
- Detalhes, listas longas e trechos de código ficam em arquivo, nunca no retorno ao líder.

# Regras
- O contexto do líder é o mais caro: nunca peça ao subagente para "relatar tudo".
- Inclua nas instruções de cada subagente as regras que valem para ele: teto de contexto, capturas de tela, progresso a cada etapa (com o caminho completo do arquivo) e retorno curto.
