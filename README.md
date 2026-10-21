# Orbit

Painel local para acompanhar e controlar as suas sessões do Claude Code: lista das instâncias, conversa, permissões,
uso do plano, terminal, arquivos, repositórios, música e, se você quiser, acesso pelo celular. Tudo roda no seu
computador, em `http://127.0.0.1:47821`. Nenhum dado sai da sua máquina, a não ser pelos serviços que você mesmo
conectar (Claude, GitHub, Tailscale).

**Só Windows** (10 ou 11).

## Antes de instalar
- **Git para Windows** (https://git-scm.com/download/win), para baixar e atualizar o Orbit.
- **Node.js** (https://nodejs.org, a versão LTS). O Orbit foi testado com o Node.js 24.
- **Claude Code** instalado, pela extensão do VS Code ou pela linha de comando, e uma conta do Claude. O Orbit usa o
  Claude Code que já está no seu computador; ele não baixa o Claude Code.
- Acesso ao repositório (privado): peça o convite a quem te passou o Orbit.

## Instalar
Num terminal (PowerShell ou Git Bash), na pasta onde você guarda os seus projetos:

```
git clone https://github.com/<dono>/orbit-public.git "Orbit Public"
cd "Orbit Public"
npm ci
```

Troque `<dono>` pelo endereço que veio no convite. O `npm ci` instala as versões exatas das dependências.

Depois, dê dois cliques em `iniciar.cmd`. O servidor sobe e o Orbit abre no navegador.

## Primeira vez
Na primeira abertura, uma tela única pede:
- o seu nome e a pasta onde ficam os seus projetos;
- o login do Claude e, se quiser, o do GitHub;
- as permissões, **todas desmarcadas de saída**. Marque só o que quiser:
  - **hooks de monitoramento (recomendado):** sem eles, as sessões que você abre no terminal ou no VS Code não
    aparecem no Orbit; só aparecem as que você abrir pelo próprio Orbit. Eles entram no seu
    `~/.claude/settings.json`;
  - **abrir sozinho:** uma sessão do Claude Code liga o servidor do Orbit quando ele está fechado;
  - **aviso aos subagentes** e a **skill liderar-time**, para quem trabalha com times de subagentes;
- o celular, opcional e desligado de saída (cada um usa o próprio Tailscale).

Para refazer: Configurações → Servidor → "Assistente da primeira vez" → Refazer.

## Uso do dia a dia
- **Abrir:** `iniciar.cmd` (se o servidor já estiver no ar, só abre a página).
- **Desligar:** `parar.cmd`.
- **Reiniciar:** Configurações → Servidor → Reiniciar.
- **Ligar junto com o Windows (opcional):** `node logon.mjs instalar` (para tirar: `node logon.mjs remover`).

## Atualizar
O Orbit nunca se atualiza sozinho. Quando houver versão nova:

```
cd "Orbit Public"
git pull
npm ci
```

Depois, reinicie o servidor (Configurações → Servidor → Reiniciar, ou `parar.cmd` e `iniciar.cmd`).

## Onde ficam os seus dados
- **Na pasta do Orbit**, fora do git: configuração (`config.json`), estado, histórico, `logs/`, `notas/`,
  `progresso/` (arquivos de progresso dos subagentes) e `bin/` (a cópia do Claude Code que o Orbit usa). O
  `git pull` não mexe neles.
- **Em `%LOCALAPPDATA%\Orbit Public`:** o token do GitHub e as chaves de acesso das conexões MCP, cifrados pelo
  Windows (DPAPI).
- **No seu `~/.claude`:** só o que você marcou na primeira vez (hooks, status line, skill).

## Desinstalar
1. `node instalar.mjs --remover`: tira os hooks, a status line e a skill do Orbit do seu `~/.claude` (as suas
   configurações e skills ficam).
2. `node logon.mjs remover`, se você ligou o Orbit junto com o Windows.
3. `parar.cmd` e apague a pasta do Orbit e `%LOCALAPPDATA%\Orbit Public`.

## Problemas comuns
- **As sessões do terminal ou do VS Code não aparecem:** os hooks de monitoramento estão desligados. Ligue pelo
  assistente (Refazer) e abra uma sessão nova do Claude Code.
- **A página não abre:** confira se a porta 47821 está livre e rode `iniciar.cmd` de novo. O registro do servidor
  fica em `logs/servidor.log`.
- **O terminal integrado não abre:** rode `npm ci` de novo na pasta do Orbit.

---
Quem mantém esta cópia: as mudanças em relação ao Orbit original estão em `RECEITA.md`, e o envio ao repositório é
feito com `node ferramentas/enviar.mjs` (veja o comentário no começo do arquivo).
