# Receita do Orbit Public

Esta cópia nasceu do Orbit original (repositório privado do autor) no commit **`1462faa`** (21/10/2026) e foi
sincronizada de novo em **23/10/2026** com a árvore de trabalho do original (commit `ff64943` mais o trabalho sem commit
daquele dia; alteração 13). Os dois projetos não compartilham código. Para trazer uma melhoria do original, aplique a
mudança aqui à mão (ou refaça a mesclagem em 3 vias da alteração 13) e confira a lista abaixo.

## Fora da cópia
- `CONTRATO.md`, `DIRECAO-VISUAL.md`, `DIRECAO-VISUAL-r2.md`, `MAC.md`.
- `assets/cayde.png` (personagem de jogo, direitos de terceiros) e a cena dele no `index.html`.
- Mac: `iniciar.command`, `parar.command`, `testes/ROTEIRO-MAC.md`, `testes/resultado-mac.md`,
  `testes/arquivos-mac-ui.test.mjs`, `testes/mac-instancias.test.mjs`. Os trechos `darwin` dos módulos comuns ficam.
- Brain (cofre do Obsidian do autor): `cerebro.mjs`, o hook SessionStart do `.claude/settings.json`,
  `testes/cerebro.test.mjs`, `testes/brain-ab.mjs`, `testes/brain-uso.mjs`.
- Sincronia do próprio Orbit: `sincronia.mjs`, `testes/sincronia.test.mjs`, `testes/sincronia-ui.test.mjs`,
  `testes/remoto-sincronia.test.mjs`, `testes/sincronia-demo.html` e o card "Sincronização" do celular.
- Assets sem uso (~38,5 MB): `assets icons robos/`, `assets/new/`, robôs e cenas sem referência e 6 peças de
  `assets/office/assets separados/`.

## Alterações
1. **Nome próprio** (para nunca usar os dados de outro Orbit na mesma conta):
   - `plataforma.mjs`: `NOME_LOCAL = 'Orbit Public'`; a pasta local vira `%LOCALAPPDATA%\Orbit Public`;
   - `logon.mjs` e `iniciar.cmd`: tarefa `Orbit Public - Claude Code`, rótulo `com.orbitpublic.servidor`
     (e os testes `logon` e `reinicio`).
2. **Sem sincronia do próprio Orbit:** o `sincronia.mjs` foi removido (código e cofre não se atualizam sozinhos).
   Quem usa atualiza com `git pull`.
3. `index.html`: as mensagens "falta reiniciar a 47821" viram "falta reiniciar o servidor do Orbit".
4. **Notas na pasta de dados:** Ideias e o registro de reinícios ficam em `<dados>/notas/` (`/notas/` no
   .gitignore), em vez do cofre.
5. **Card Sincronização** (`assets/sincronia.js`): só o repositório do projeto escolhido no filtro (`/repos/*`,
   `repos.mjs`); sem filtro, "Sem projeto". Os testes `sincronia-card-ui` e `sincronia-card-projeto-ui` foram
   adaptados.
6. **Testes sem a máquina do autor:** `repos` e `versionar` gravam uma config vazia no temporário e usam git com
   `core.autocrlf=false` e identidade de teste; `github-falso.mjs` ignora o gitconfig global e do sistema;
   `fumaca.mjs` não consulta mais um Orbit já rodando.
7. **Neutralização:** nomes, contas, caminhos e projetos do autor trocados por exemplos (`usuario`,
   `Projeto Exemplo`, `C:\Users\usuario`, `D:\Dev\Projetos`) em comentários e testes; "decisão do autor" vira
   "decisão do usuário", e as referências ao `CONTRATO.md` e ao cofre saem dos comentários (o número da rodada
   fica). Sem mudança de comportamento.
8. **Aviso aos subagentes e skill liderar-time para qualquer projeto:**
   - `aviso-subagente.mjs`: vale em qualquer projeto (sem a trava da pasta do Orbit) e, quando a ferramenta
     Agent/Task devolve "PRECISA_SUBSTITUIR", explica ao líder o que fazer (encerrar e criar outro a partir do
     arquivo de progresso), mesmo sem a skill. A camada 3 do `servidor.mjs` também vale em qualquer projeto.
   - Arquivos de progresso em `<dados>/progresso/<nome da pasta do projeto>/` (`/progresso/` no .gitignore),
     nunca no projeto; relidos depois da compactação automática (`controle.mjs`); os esquecidos há 7 dias saem
     sozinhos (`servidor.mjs`, `limparProgresso`).
   - `.claude/settings.json` do projeto removido: o aviso é opcional e global, `node instalar.mjs
     --aviso-subagente` (ou `--sem-aviso-subagente`); sem opção, fica como estava.
   - Skill pessoal `skills/liderar-time/SKILL.md` (modelo com `{{PROGRESSO}}`), instalada em
     `~/.claude/skills/liderar-time/` só com `node instalar.mjs --liderar-time`; `--sem-liderar-time` e `--remover`
     tiram só a nossa (marca "Instalada pelo Orbit"); uma skill do usuário com o mesmo nome nunca é tocada.
   - Testes: `subagente-limite` (qualquer projeto, aviso ao líder, pasta de progresso), `autocompactar` (progresso
     na pasta de dados), `backend` (opções do `instalar.mjs`, sempre com `GERENCIADOR_SKILLS` de teste).
9. **Assistente da primeira vez (uma tela) e hook sem subir o servidor sem permissão:**
   - `assistente.mjs` (novo; GET `/assistente`, POST `/assistente/concluir|pular|refazer`, só no PC) e
     `assets/assistente.js` + `.css` (novos; carregados no `index.html`): nome, pasta de projetos, login do Claude
     (`/conta/claude/entrar`), GitHub opcional (`/perfil/github`), hooks, "abrir sozinho", aviso aos subagentes e
     skill liderar-time (cada um com explicação e desmarcado de saída) e celular opcional. Abre sozinho até ser
     concluído ou pulado; Configurações → Servidor → "Assistente da primeira vez" → Refazer.
   - `servidor.mjs`: `config.nome` e `config.assistente.feito` no `mesclarConfig`; o perfil (`perfil.mjs`,
     `nomeLocal` exportado) mostra o nome escolhido. `repos.mjs`: `definirPastaClones` (a pasta de projetos vira a
     pasta dos clones; dentro do Orbit, não).
   - `instalar.mjs`: `--abrir-sozinho` / `--sem-abrir-sozinho` (argumento `--subir` no hook), `estadoDaInstalacao` e
     `cuidarDaSkill` exportadas. `hook.mjs`: só sobe o servidor com `--subir` (auditoria P2-7).
   - Servidor de teste (`GERENCIADOR_DADOS`): o assistente conta como feito (`ORBIT_ASSISTENTE=1` mostra) e recusa
     instalar sem `GERENCIADOR_SETTINGS` e `GERENCIADOR_SKILLS`.
   - Testes: `assistente` (novo), `assistente-ui` (novo), `backend` (hook com `--subir`).
   - Os hooks de monitoramento seguem desmarcados de saída, mas com o selo "Recomendado" e, enquanto desmarcados,
     o aviso de que as sessões do terminal e do VS Code não aparecem no Orbit (`#as-hooks-alerta`).
10. **Navegador interno sem o próprio Orbit (auditoria P2-4) e `node-pty` estável (P2-8):**
   - `navegador.mjs`: `ehDoOrbit` (exportada) recusa endereço local (ou 0.0.0.0) na porta do Orbit ou na porta
     remota do celular, e o host do Tailscale (`enderecosOrbit`, passado pelo `servidor.mjs`), no checar, num
     redirecionamento e na prévia do projeto.
   - `assets/navegador.js`: o iframe nunca recebe um endereço local na porta da página, mesmo sem o servidor.
   - `servidor.mjs`: pedido de quadro (`Sec-Fetch-Dest` iframe/frame/embed/object), de qualquer origem, é recusado
     (403); a página sai com `frame-ancestors 'none'` e `X-Frame-Options: DENY`.
   - `package.json`: `@lydell/node-pty` 1.1.0 (era 1.2.0-beta.15). Efeito conhecido da 1.1.0: ao fechar um
     terminal (o Orbit mata a árvore antes), o agente dela escreve "AttachConsole failed" no log e o console é
     liberado depois de 5 s. A beta não tem isso. O `terminal.mjs` (`silenciarListaDoConsole`) faz esse fork do
     agente sair com o stderr num pipe e descarta só essa mensagem; qualquer outra saída dele segue para o stderr.
   - Testes: `navegador` (novo caso), `navegador-ui` (recusa sem o servidor), `origem` (quadro), `terminal`
     (filtro do agente).
11. **Documentação e envio:**
   - `README.md` (novo): instalação só no Windows (`git clone`, `npm ci`, `iniciar.cmd`), pré-requisitos (Git,
     Node.js, Claude Code instalado), primeira vez, atualização com `git pull` + `npm ci`, onde ficam os dados e
     como desinstalar.
   - `ferramentas/enviar.mjs` (novo; só para quem mantém): confere os arquivos que iriam (binário, acima de 10 MB,
     segredos, termos pessoais), a identidade do git e os commits (autor, mensagem, remoto na frente) e só então
     faz o commit e o push (`--enviar`; nunca `--force`). Os termos ficam em `envio-termos.txt`, fora do git;
     `permitir: <texto>` aceita um texto exato só na identidade do git (o e-mail "noreply" do GitHub).
   - Testes: `enviar` (novo; repositório local numa pasta temporária, sem rede).
12. **README com a marca do Orbit e imagens sem metadados:**
   - `README.md` refeito com o mesmo conteúdo: banner claro e escuro (`<picture>`), selos, capturas e GIFs de uma instalação de teste com dados de exemplo (o mock dos testes e um terminal
     numa pasta de demonstração), instalação em passos e seções longas recolhíveis. Imagens em `.github/assets/`
     (PNG com paleta e GIF, sem metadados; ~1,7 MB no total).
   - `ferramentas/enviar.mjs`: imagens (PNG, GIF, JPEG, WEBP) passam pela varredura; qualquer bloco de metadado
     recusa (`metadadosImagem`, `conferirImagem`), e os bytes e o texto dos blocos passam pela busca de segredos e
     termos. Teste `enviar` com imagens montadas byte a byte.
   - `assets/robot-work-original.gif`: tirado o manifesto C2PA (ferramenta e data de criação), sem recodificar
     (os quadros são idênticos).
13. **Sincronização de 23/10 (Grafo, Whiteboard, Codex, Escritórios, celular novo, Office da Vila):**
   - Mesclagem em 3 vias (base `1462faa`, esta cópia, árvore do original): 232 arquivos copiados ou novos, 4 apagados
     (`mobile/mobile.*` e `mobile/widgets.*`, substituídos pelo app novo em `mobile/*.js`), 27 mesclados; 17 conflitos
     resolvidos a favor do original, mantendo as alterações 1 a 12 desta cópia.
   - Novas funções: aba Grafo (`grafo.mjs`, `assets/grafo*`), Whiteboard (`whiteboard.mjs`, `assets/whiteboard*`;
     quadros em `<dados>/whiteboard/`), Codex (`codex*.mjs`, `assets/codex*`; desligado até ligar em Configurações),
     Escritórios (`escritorios.mjs`, `membro.mjs`, `escritorio-*.mjs`, `assets/escritorios-*`), app do celular refeito
     (`mobile/`), Office com o mapa da Vila (`assets/office.js`, `assets/vila/`: Pixel Crawler Free Pack de Anokolisa,
     termos em `assets/vila/Terms.txt`, casas em `assets/vila/casas/`), grade de widgets da Visão geral.
   - Sem brain de fábrica: `servidor.mjs` cria o Grafo sem cofre (`ORBIT_COFRE` opcional) e nenhum projeto ganha brain
     sozinho; cada um vincula a própria pasta de notas no Personalizar projeto. O teste `grafo` só lê um cofre real se
     `ORBIT_COFRE` apontar para um.
   - Sem sincronia do próprio Orbit (alteração 2 mantida): o bloco e a rota do `sincronia.mjs` ficaram fora do
     `servidor.mjs`; no celular, o card Sincronização do Início está desligado (`SINC_ATIVA = false` em
     `mobile/inicio.js`) e o teste `mobile-widgets` confere 5 cards. O card do PC segue o da alteração 5.
   - Neutralização (alteração 7 aplicada ao que chegou): nomes, caminhos, projetos e referências ao contrato e ao cofre
     do autor trocados por exemplos em comentários, prompts dos Escritórios ("aprovação do usuário") e testes
     (`Cliente Exemplo`, `D:/Dev/Projetos/Orbit`, `iPhone do usuário`, `dono@exemplo.com`). `cayde` segue fora.
   - `.gitignore`: além de `.env*`, `*.pem` e `*.key`, agora ficam fora `*.p12`, `*.pfx`, `*.jks`, `*.keystore`,
     `*.tfstate*`, `*.sql`, `*.sqlite*`, `*.db`, `kubeconfig`, `.npmrc`, `.pypirc`, `credentials*`,
     `service-account*.json` e `*-firebase-adminsdk-*.json`.
   - Testes (23/10): rodada completa dos 135 arquivos de `testes/` nas portas 47822–47826 (duas filas em paralelo) e
     segunda passada, um por vez, dos que falharam. Passam 125. Ficam com falha, iguais às do original no mesmo dia:
     `backend` (1 caso: o SSE `inicio` sem `uso`), `card-sessao-ui` (2), `grupos-ui`, `revisao-ui`, `midia` (1, widget da
     lateral), `projeto-foto-ui` (4), `temas-ui` (2) e `perfil` (3 de layout da lateral recolhida). `navegador-ui` e
     `assistente-ui` dependem do tempo da abertura (a tela de abertura ainda cobre a lateral quando o teste clica, se a
     máquina está carregada): passam sozinhos. Ajustes feitos nos testes desta cópia: config vazia em `grafo-app`,
     `grafo-widget-ui`, `whiteboard-app` e `revisao-ui`; `escritorio-externas` pula o caminho sem aspas quando a pasta
     tem espaço; `remoto` e `mobile-widgets` com os nomes de exemplo; `sincronia-card-ui` (o desta cópia) com a grade de
     900 px; `grafo` só lê um cofre real por `ORBIT_COFRE`.
