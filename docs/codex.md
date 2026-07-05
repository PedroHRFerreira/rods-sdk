# Usando rods-sdk Com Codex

O Rods SDK permite rodar o Context Engine como servidor MCP local para o Codex buscar memória indexada do projeto antes de abrir arquivos. O RTK é o adaptador padrão para compactar saída de comandos, mas sua instalação continua externa e opcional. A execução permanece CLI-first por Codex, MCP, skills e adaptadores locais; o rods-sdk não chama APIs de provedores de IA diretamente.

## Fluxo

```text
Chat do Codex
  -> ferramenta MCP context_engine
  -> ~/.context-engine/db/context.db
  -> chunks ranqueados
  -> resposta ou edição de código pelo Codex
```

O Codex não envia o repositório inteiro para o modelo. Ele chama ferramentas como `search` e `read`, depois inclui apenas os chunks selecionados no turno ativo.

## Instalação Local

Clone e compile o projeto na sua máquina:

```bash
git clone https://github.com/PedroHRFerreira/rods-sdk.git
cd rods-sdk
npm install
npm run build
```

Registre e indexe um projeto:

```bash
./bin/context project add meu-projeto /caminho/absoluto/do/projeto
./bin/context ingest /caminho/absoluto/do/projeto
./bin/context stats
```

Pesquise no índice:

```bash
./bin/context search "erro no checkout"
./bin/context read <chunkId>
```

## Conectar O Codex

Adicione isto ao `~/.codex/config.toml`:

```toml
[mcp_servers.context_engine]
command = "node"
args = ["/caminho/absoluto/para/rods-sdk/dist/mcp/server.js"]
cwd = "/caminho/absoluto/para/rods-sdk"
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true

[mcp_servers.context_engine.tools.search]
approval_mode = "approve"

[mcp_servers.context_engine.tools.read]
approval_mode = "approve"

[mcp_servers.context_engine.tools.stats]
approval_mode = "approve"
```

Ou adicione pela CLI do Codex:

```bash
codex mcp add context_engine -- node /caminho/absoluto/para/rods-sdk/dist/mcp/server.js
```

Reinicie o Codex depois de alterar a configuração MCP. No TUI do Codex, rode `/mcp` para confirmar que o servidor está ativo.

## Usar Em Um Projeto Consumidor

Dentro do projeto que deve carregar a governança do rods-sdk:

```bash
pnpm exec rods init
pnpm exec rods adapter sync --target codex
```

Isso cria `.ai/` como fonte versionada da verdade e sincroniza `.ai/skills/*/SKILL.md` para `.agents/skills/` quando o diretório for gravável.

Se `.agents/skills` estiver somente leitura, use um destino gravável:

```bash
pnpm exec rods adapter sync --target codex --codex-skills-dir .codex/skills
```

Depois disso, confirme que a skill foi criada:

```bash
ls .codex/skills/context-search-first/SKILL.md
```

## Como Usar No Chat

Peça normalmente, mas mencione Context Engine quando quiser forçar esse caminho:

```text
Use context_engine para buscar no projeto indexado antes de responder.
```

Prompts úteis:

```text
Use context_engine.search para achar contexto sobre erros no checkout.
Use context_engine.ingest neste projeto e depois busque por upload banner.
Leia somente os chunks necessários com context_engine.read.
```

## Ferramentas Disponíveis

- `search`: encontra chunks relevantes por texto.
- `read`: lê um chunk por id.
- `ingest`: indexa um arquivo ou diretório.
- `stats`: mostra estatísticas compactas do banco.
- `projects`: lista projetos registrados.
- `project_add`: registra a raiz de um projeto.

## Arquivos De Governança

Para um projeto que deve carregar governança do rods-sdk, rode:

```bash
rods init /caminho/absoluto/do/projeto
rods adapter sync /caminho/absoluto/do/projeto --target codex
```

O `rods init` cria:

```text
AGENTS.md
.ai/config.json
.ai/constitution.md
.ai/skills/context-search-first/SKILL.md
.ai/adapters/rtk.md
```

O RTK vem habilitado por padrão em `.ai/config.json`; instale o RTK separadamente com `rtk init -g --codex` quando quiser interceptação/compactação de saída de comandos. Ferramentas externas opcionais como `claude-mem` e `caveman` são habilitadas com `rods adapter enable <name>` e verificadas com `rods adapter doctor`.
