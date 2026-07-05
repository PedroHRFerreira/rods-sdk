# rods-sdk

Framework de governança para agentes de código, com recuperação via Context Engine e economia de tokens usando RTK por padrão.

O Rods SDK entrega uma camada operacional pequena e auditável para agentes:

- Context Engine: busca indexada do projeto em chunks com SQLite FTS5.
- RTK por padrão: compactação de saída de comandos, testes, logs e diffs.
- Skills e arquivos de governança: regras versionadas em `.ai/` que podem ser sincronizadas com agentes suportados.
- Adaptadores opcionais: memória entre sessões e modo de resposta curta sem virar dependência obrigatória.
- Execução CLI-first: o framework roda pelo harness local, MCP, skills e adaptadores, sem chamar APIs de provedores de IA diretamente.

## Instalação

```bash
npm install
npm run build
```

Durante o desenvolvimento:

```bash
npm run dev -- search "termo de busca"
```

Depois do build, o pacote expõe:

```bash
rods --help
context --help
```

`context` continua existindo como alias de compatibilidade para a mesma CLI.

## Como Rodar O Framework

1. Registre o projeto que será indexado:

```bash
context project add meu-projeto /caminho/absoluto/do/projeto
```

2. Indexe o projeto:

```bash
context ingest /caminho/absoluto/do/projeto
```

3. Consulte o índice antes de abrir arquivos manualmente:

```bash
context search "termo de busca" --limit 8
context read <chunkId>
context stats
```

4. Para gerar governança em um projeto consumidor:

```bash
rods init /caminho/absoluto/do/projeto
rods adapter sync /caminho/absoluto/do/projeto --target codex
```

Se `.agents/skills` estiver somente leitura no ambiente, sincronize para um diretório gravável:

```bash
rods adapter sync /caminho/absoluto/do/projeto --target codex --codex-skills-dir .codex/skills
```

## Comandos

```bash
context ingest <path> [--type file|log|markdown|diff|error|stacktrace|json|sql|http]
context search <query> [--limit 8]
context read <chunkId>
context stats
context project add <name> <root>
context project list
context project remove <name>
rods init [path] [--force]
rods adapter list
rods adapter enable <rtk|claude-mem|caveman> [path] [--force]
rods adapter sync [path] --target codex [--codex-skills-dir <path>] [--force]
rods adapter doctor [path] [--target codex]
```

## Integração Com Codex

O Rods SDK expõe o servidor MCP do Context Engine para o Codex:

```bash
npm run build
context-mcp
```

Veja [docs/codex.md](docs/codex.md) para configurar o `~/.codex/config.toml` e usar o MCP no Codex.

## Armazenamento

Por padrão, os arquivos ficam em:

```text
~/.context-engine/
  config/config.json
  db/context.db
```

Defina `CONTEXT_ENGINE_HOME` para isolar o armazenamento em testes ou experimentos locais.

## Economia De Tokens

- Arquivos são armazenados em chunks por linha, não como registros gigantes.
- `search` retorna metadados compactos, ranqueados, com snippets.
- `read` exige um `chunkId` explícito.
- Hashes de arquivo são cacheados para pular reindexação do que não mudou.
- O schema reserva campos de metadados de embedding para busca híbrida futura, sem implementar embeddings no MVP.

## Governança

`rods init` cria arquivos de governança no projeto sem instalar ferramentas externas:

```text
AGENTS.md
.ai/config.json
.ai/constitution.md
.ai/skills/context-search-first/SKILL.md
.ai/adapters/rtk.md
```

`.ai/` é a fonte versionada da verdade. `rods adapter sync --target codex` copia `.ai/skills/*/SKILL.md` para `.agents/skills/`, permitindo consumo local pelo Codex quando esse diretório for gravável.

RTK vem habilitado por padrão em `.ai/config.json`. Rode `rtk init -g --codex` separadamente quando quiser que o RTK instale sua própria integração com o Codex.

A execução é CLI-first por padrão:

```json
{
  "execution": {
    "mode": "cli",
    "apiEnabled": false
  }
}
```

## Adaptadores Opcionais

Adaptadores documentam e validam ferramentas opcionais. Eles não são dependências embutidas, e o rods-sdk não reimplementa o comportamento dessas ferramentas.

- `rtk`: compactação padrão de saída de comandos.
- `claude-mem`: memória persistente entre sessões.
- `caveman`: saída curta, ativada somente por opção.

Use `rods adapter enable <name>` para registrar a intenção em `.ai/config.json` e gerar `.ai/adapters/<name>.md`. Use `rods adapter doctor` para verificar instalação, configuração detectada, hooks, sinais MCP e possíveis conflitos.
