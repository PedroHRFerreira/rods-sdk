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
npm install -g @pedrohrferreira/rods-sdk
```

Para usar sem instalação global:

```bash
npx @pedrohrferreira/rods-sdk rods --help
npx @pedrohrferreira/rods-sdk context --help
```

Para desenvolvimento local neste repositório:

```bash
npm install
npm run build
```

Instalações via git executam `prepare` para gerar `dist/` automaticamente. Em projetos com pnpm, se lifecycle scripts de dependências estiverem bloqueados, rode `pnpm approve-builds` ou adicione `@pedrohrferreira/rods-sdk` em `pnpm.onlyBuiltDependencies`.

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

## Principais Atualizações

Esta versão adiciona automação de governança, atualização seletiva de templates e isolamento de contexto de revisão.

| Área | O que mudou | Impacto no framework |
|---|---|---|
| Instalação via git | `prepare` roda `npm run build` automaticamente. | Consumidores que instalam via GitHub recebem `dist/` sem passo manual, exceto quando pnpm bloqueia lifecycle scripts. |
| Inicialização | `rods init` agora gera governança, sincroniza Codex, escreve/mescla `~/.codex/RTK.md` e roda doctor. | O setup inicial fica concentrado em um comando e deixa de depender de `rtk init -g --codex` manual. |
| Targets de agente | Codex e Claude são definidos em um registry de targets. | Novos harnesses podem ser adicionados com menos condicionais e menos duplicação. |
| Upgrade | `rods upgrade` atualiza templates seletivamente, preserva arquivos customizados e tem `--dry-run`. | Projetos consumidores conseguem receber melhorias do SDK sem perder ajustes locais. |
| Skills | Foram adicionadas skills de `review`, `architecture` e `quality`. | Agentes passam a ter regras versionadas para revisão, arquitetura e validação. |
| Context Engine | `ingest` e `search` aceitam `--scope`, com `general` como padrão e `review` para revisão. | Contextos de revisão ficam isolados do índice geral sem criar outro projeto. |
| Migração SQLite | Bancos antigos recebem backfill de `scope=general`. | Bases já indexadas continuam funcionando após o upgrade. |
| Fluxo de cards externos | Casos de eval documentam quando perguntar antes de buscar contexto. | Evita inferir requisitos de links externos sem confirmação. |

## Atualizar Projetos Consumidores

Use primeiro o dry-run para ver o que será alterado:

```bash
rods upgrade /caminho/absoluto/do/projeto --dry-run
```

Aplicar atualização seletiva preservando arquivos customizados:

```bash
rods upgrade /caminho/absoluto/do/projeto
```

Forçar atualização dos arquivos gerados pelo SDK:

```bash
rods upgrade /caminho/absoluto/do/projeto --force
```

Se o projeto usa pnpm e o `dist/` não foi gerado durante a instalação via git:

```bash
pnpm approve-builds
```

Ou configure no `package.json` raiz do consumidor:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["@pedrohrferreira/rods-sdk"]
  }
}
```

Depois do upgrade, rode uma validação rápida:

```bash
rods adapter doctor /caminho/absoluto/do/projeto
context search "termo de validação" --limit 8
```

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

Para contexto dedicado de revisão:

```bash
context ingest /caminho/absoluto/do/projeto --scope review
context search "critério de revisão" --scope review --limit 8
```

4. Para gerar governança em um projeto consumidor:

```bash
rods init /caminho/absoluto/do/projeto
rods adapter sync /caminho/absoluto/do/projeto --target codex
rods adapter sync /caminho/absoluto/do/projeto --target claude
```

Por padrão, as skills ficam apenas em `.ai/skills`. Se você precisar projetar uma cópia para um diretório específico consumido pelo Codex, passe o destino explicitamente:

```bash
rods adapter sync /caminho/absoluto/do/projeto --target codex --codex-skills-dir .codex/skills
```

## Comandos

```bash
context ingest <path> [--scope general|review] [--type file|log|markdown|diff|error|stacktrace|json|sql|http]
context search <query> [--scope general|review] [--limit 8]
context read <chunkId>
context stats
context project add <name> <root>
context project list
context project remove <name>
context ingest <path> [--type <type>] [--scope <scope>] [--project-root <path>]
rods init [path] [--force]
rods upgrade [path] [--force] [--dry-run]
rods adapter list
rods adapter enable <rtk|claude-mem|caveman> [path] [--force]
rods adapter sync [path] --target codex|claude [--codex-skills-dir <path>] [--force]
rods adapter doctor [path] [--target codex|claude]
rods escalation classify <task> [--files <files>] [--root <path>] [--json]
rods hook run --target codex|claude
```

## Integração Com Codex

O Rods SDK expõe o servidor MCP do Context Engine para o Codex:

```bash
npm run build
context-mcp
```

Veja [docs/codex.md](docs/codex.md) para configurar o `~/.codex/config.toml` e usar o MCP no Codex.

Veja [docs/evals.md](docs/evals.md) para os casos de eval da regra de card/link com dependência externa.

## Armazenamento

Por padrão, os arquivos ficam em:

```text
~/.context-engine/
  config/config.json
  db/context.db
```

Defina `CONTEXT_ENGINE_HOME` para isolar o armazenamento em testes ou experimentos locais. Quando ele for relativo, o rods-sdk resolve o caminho a partir da raiz detectada do projeto ou da raiz passada em `--project-root`.

## Economia De Tokens

- Arquivos são armazenados em chunks por linha, não como registros gigantes.
- `search` retorna metadados compactos, ranqueados, com snippets.
- `read` exige um `chunkId` explícito.
- Hashes de arquivo são cacheados para pular reindexação do que não mudou.
- O schema reserva campos de metadados de embedding para busca híbrida futura, sem implementar embeddings no MVP.

## Governança

`rods init` cria arquivos de governança no projeto, sincroniza a projeção Codex e escreve/mescla o hook RTK em `~/.codex/RTK.md`:

```text
AGENTS.md
.ai/config.json
.ai/constitution.md
.ai/skills/context-search-first/SKILL.md
.ai/skills/review/SKILL.md
.ai/skills/architecture/SKILL.md
.ai/skills/quality/SKILL.md
.ai/adapters/rtk.md
```

`.ai/` é a fonte versionada da verdade. `rods adapter sync --target codex` mantém as skills em `.ai/skills` e sincroniza apenas os hooks do target. Se houver necessidade de uma projeção física para outro diretório, use `--codex-skills-dir <path>`. `rods adapter sync --target claude` gera a projeção `CLAUDE.md`.

RTK vem habilitado por padrão em `.ai/config.json`. O hook Codex gerado pelo rods-sdk documenta o fluxo RTK/Context Engine sem exigir um passo manual de `rtk init -g --codex`.

`rods upgrade --dry-run` mostra quais arquivos seriam atualizados. O upgrade real preserva arquivos customizados e reporta quando existe versão upstream mais nova para eles.

A execução é CLI-first por padrão:

```json
{
  "execution": {
    "mode": "cli",
    "apiEnabled": false
  }
}
```

## Escalonamento De Modelo

`rods escalation classify <task>` classifica a complexidade da tarefa e recomenda uma classe de modelo: `economy`, `balanced` ou `high-capability`. Essa recomendação é orientação textual de governança. O rods-sdk não troca o modelo ativo, não chama APIs de provedores de IA, não edita configuração do Codex/Claude e não faz roteamento automático entre modelos. O campo `changesConfiguration` existe para deixar esse contrato explícito e atualmente é sempre `false`.

Quando executado via lifecycle hook, `rods hook run --target codex|claude` injeta a recomendação em `additionalContext` no evento `UserPromptSubmit`, junto com avisos de planejamento/revisão quando aplicáveis. O agente ou a pessoa operando a sessão ainda precisa ler essa sugestão e decidir manualmente se muda de modelo ou altera o plano de execução.

Para estimar o escopo, passe os arquivos explicitamente sempre que quiser um resultado sensível ao recorte da tarefa:

```bash
rods escalation classify "corrigir typo no README" --files README.md
```

Se `--files` for omitido, o classificador usa `git diff --name-only` no repositório atual como fallback. Isso é útil para classificar a mudança em andamento, mas pode surpreender em repositórios com alterações não commitadas: dois textos de tarefa diferentes podem produzir o mesmo resultado quando o diff local é o mesmo.

## Adaptadores Opcionais

Adaptadores documentam e validam ferramentas opcionais. Eles não são dependências embutidas, e o rods-sdk não reimplementa o comportamento dessas ferramentas.

- `rtk`: compactação padrão de saída de comandos.
- `claude-mem`: memória persistente entre sessões.
- `caveman`: saída curta, ativada somente por opção.

Use `rods adapter enable <name>` para registrar a intenção em `.ai/config.json` e gerar `.ai/adapters/<name>.md`. Use `rods adapter doctor` para verificar instalação, configuração detectada, hooks, sinais MCP e possíveis conflitos.
