# rods-sdk

Framework de governança para agentes de código, com recuperação via Context Engine e economia de tokens usando RTK por padrão.

O Rods SDK entrega uma camada operacional pequena e auditável para agentes:

- Context Engine: busca indexada do projeto em chunks com SQLite FTS5.
- RTK por padrão: compactação de saída de comandos, testes, logs e diffs.
- Skills e arquivos de governança: regras versionadas em `.ai/` que podem ser sincronizadas com agentes suportados.
- Adaptadores opcionais: memória entre sessões e modo de resposta curta sem virar dependência obrigatória.
- Execução CLI-first: flows de agentes são disparados explicitamente pelo terminal e usam as CLIs locais, sem chamar APIs de provedores de IA diretamente. O MCP expõe somente o Context Engine, não o comando `flow run`.

## Status — RODS Local-First MVP

### Estado atual

O projeto possui uma **Local-First Foundation** implementada e validada. O
**Local-First MVP E2E não está concluído**: a rota real `Codex → Magnitude →
modelo local` permanece intencionalmente desabilitada até que possa ser
atestada por um contrato público e estruturado.

A foundation já fornece `rods setup`, `rods doctor` e `rods run`; seleção de
contexto com orçamento; filtros de segredos e symlinks; worktree isolada;
sanitização de artifacts; subprocessos controlados; validação opt-in; erros
estruturados; e roteamento `--local-only` fail-closed com `cloudCalls = 0`.

Na validação de 2026-09-14, `npm run typecheck`, `npm run build` e a suíte de
86 testes passaram. O pacote 0.1.17 também foi empacotado e instalado em um
diretório limpo, com seus binários funcionando. Isso não é evidência de uma
execução real por Magnitude e Codex.

As dependências transitivas de produção foram atualizadas e a verificação
`npm audit --omit=dev` retorna zero vulnerabilidades. A atualização corrigiu a
cadeia de `fast-uri`, `ip-address`, `hono`, `@hono/node-server` e `qs` usada
por `@modelcontextprotocol/sdk`.

### O que funciona e o que não funciona

| Fluxo                                           | Estado                                           | Evidência e limite                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context Engine, governança, Q&A, adapters e CLI | Disponível                                       | Cobertos pela suíte e pelo smoke test de instalação.                                                                                                           |
| `rods flow run` com Codex, Claude ou Gemini     | Implementado, mas precisa de ambiente do usuário | A integração foi exercitada com CLIs falsas nos testes. O usuário deve configurar CLIs autenticadas, modelos e permissões antes de uma primeira execução real. |
| `rods run --local-only`                         | Bloqueado de propósito                           | O runtime Magnitude e a ligação Codex → runtime local não possuem contrato verificável integrado.                                                              |
| Fallback cloud em Local-First                   | Não existe                                       | `--cloud` e `--hybrid` retornam `FEATURE_NOT_AVAILABLE`.                                                                                                       |

O discovery atual não usa parsing frágil de texto humano, flags JSON não
documentadas, schemas internos ou códigos de saída presumidos. Se Magnitude
estiver instalado sem uma sonda estruturada oficial, o resultado correto é
`RUNTIME_CONTRACT_UNSUPPORTED`; sem uma atestação da conexão do harness, é
`HARNESS_NOT_READY`.

### Arquitetura e decisão de segurança

```text
RODS
 ├── Context Engine
 ├── Security + sanitização
 ├── Classifier + Local Router
 └── Worktree isolada
             ↓
      Codex Harness
             ↓
      Magnitude Runtime
             ↓
        Modelo local
```

Magnitude é apenas o runtime de inferência; não é tratado como editor de
arquivos. O harness é quem pode alterar somente a worktree controlada. Quando
a rota local não pode ser provada, o RODS não inicia o harness e não tenta
substituí-lo por cloud:

```text
localOnly = true
        ↓
cloud provider resolved = NO
cloud provider initialized = NO
cloud calls = 0
```

O MVP E2E só será concluído quando uma fixture real executar `rods run
--local-only` e comprovar runtime, modelo, conexão do harness, alteração na
worktree, validação e patch — tudo sem chamadas cloud e sem tocar o workspace
primário.

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

## Uso disponível hoje

O fluxo abaixo prepara um projeto consumidor para o orquestrador CLI-first.
Ele não habilita o Local-First E2E.

1. Inicialize a governança na raiz de um repositório Git:

```bash
rods init /caminho/para/meu-projeto
```

2. Indexe o projeto para que agentes possam recuperar contexto compacto antes
   de abrir arquivos:

```bash
context project add meu-projeto /caminho/para/meu-projeto
context ingest /caminho/para/meu-projeto
context search "onde fica a autenticação?" --limit 8
```

3. Configure em `.ai/config.json` as CLIs que a equipe realmente possui e os
   modelos aceitos para cada tier. O template vem com nomes de modelos vazios e
   `escalation.mode: "advisory"`; portanto, um projeto recém-inicializado não
   executa agentes até receber configuração explícita. Para executar flows,
   habilite os targets escolhidos, preencha `simple`, `medium` e `high`, e defina
   `escalation.mode` como `"execute"`. Verifique as integrações:

```bash
rods adapter doctor /caminho/para/meu-projeto
```

4. Escolha um modo com um agente ou com desenvolvedor e revisor distintos e
   inicie o flow:

```bash
rods flow run "implemente a exportação CSV de faturas" \
  --root /caminho/para/meu-projeto \
  --mode codex+claude
```

O RODS classifica a tarefa, cria uma branch e worktree temporárias, chama o
desenvolvedor, roda o gate de testes configurado e pede uma revisão estruturada.
Ele repete as correções até `workflow.maxIterations`. Se a revisão aprovar, o
patch só é promovido para o branch original se ele ainda estiver no mesmo HEAD;
caso contrário, o patch é preservado para aplicação manual. Se não houver
aprovação, o comando mantém a worktree e informa o caminho do patch.

### Potência, limites e gastos

O RODS não chama APIs de modelos diretamente (`execution.apiEnabled` é
`false`), mas suas CLIs autenticadas podem consumir assinatura, créditos ou
tarifação do provedor. O SDK não conhece a tabela de preços da sua conta, não
calcula moeda e não possui um teto financeiro por execução.

Em cada iteração há uma chamada de desenvolvimento. Se o gate de testes passar,
há também uma chamada de revisão. Assim, o máximo de chamadas é
`2 × workflow.maxIterations`: o padrão de três iterações permite até seis
chamadas. Se o teste falhar, a revisão daquela iteração é pulada. Tokens só são
registrados quando a CLI devolve métricas JSON oficiais; ausência de métrica é
registrada como `unavailable`, não estimada.

Para estimar custo quando o provedor cobra por token:

```text
custo = Σ(inputTokens / 1.000.000 × preço_input_do_modelo)
      + Σ(outputTokens / 1.000.000 × preço_output_do_modelo)
```

O modo de maior cobertura é um par de agentes, por exemplo `codex+claude`,
com modelos configurados para os três tiers, `workflow.testCommand`,
`reviewContext: true` e até três iterações. Ele também é o modo de maior custo
potencial. Para um primeiro uso real, comece com uma iteração, confira os
tokens reportados e aumente o limite conscientemente. O contexto de revisão é
opt-in e limitado a cinco snippets; o diff enviado à revisão tem teto de
50 mil caracteres.

### Preparar Local-First

Esta trilha configura defaults sem instalar softwares externos:

```bash
rods setup /caminho/para/meu-projeto
rods doctor /caminho/para/meu-projeto --json
```

`doctor` verifica Git, Context Engine, runtime Magnitude, modelos locais,
Codex e permissões de validação. Hoje ele retorna código de saída `1` enquanto
não houver uma sonda estruturada e oficial que comprove o runtime Magnitude, o
modelo local, a conexão Codex → Magnitude e o isolamento Git. Nesse estado,
`rods run "tarefa" --local-only` falha de forma segura; `--cloud` e `--hybrid`
são sempre recusados. Isso é uma proteção, não um fallback.

## Principais Atualizações

Esta versão inclui cache Q&A com validade explícita, escalação real de modelos, métricas de uso e orquestração CLI-first entre Codex, Claude e Gemini, além das melhorias de governança já existentes.

| Área                    | O que mudou                                                                                                                            | Impacto no framework                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Instalação via git      | `prepare` roda `npm run build` automaticamente.                                                                                        | Consumidores que instalam via GitHub recebem `dist/` sem passo manual, exceto quando pnpm bloqueia lifecycle scripts.                      |
| Inicialização           | `rods init` agora gera governança, sincroniza Codex, escreve/mescla `~/.codex/RTK.md` e roda doctor.                                   | O setup inicial fica concentrado em um comando e deixa de depender de `rtk init -g --codex` manual.                                        |
| Targets de agente       | Codex e Claude possuem integração de governança; Codex, Claude e Gemini podem executar flows.                                          | Gemini entra como CLI de execução sem ser tratado como harness de skills/hooks.                                                            |
| Upgrade                 | `rods upgrade` atualiza templates seletivamente, preserva arquivos customizados e tem `--dry-run`.                                     | Projetos consumidores conseguem receber melhorias do SDK sem perder ajustes locais.                                                        |
| Skills                  | Foram adicionadas skills de `review`, `architecture` e `quality`.                                                                      | Agentes passam a ter regras versionadas para revisão, arquitetura e validação.                                                             |
| Context Engine          | `ingest` e `search` aceitam `--scope`, com `general` como padrão e `review` para revisão.                                              | Contextos de revisão ficam isolados do índice geral sem criar outro projeto.                                                               |
| Cache Q&A               | `rods qa` armazena, consulta, lista, reclassifica, invalida e limpa respostas reutilizáveis com hash exato e FTS5 lexical.             | Perguntas repetidas podem reaproveitar respostas sem nova ingestão ou chamada automática de agente.                                        |
| Validade do cache       | Cada entrada usa policy explícita `conceptual`, `files` ou `repository`; dependências por arquivo são verificadas por SHA-256.         | Commits irrelevantes não invalidam respostas conceituais ou respostas ligadas apenas a arquivos específicos.                               |
| Limpeza e métricas      | `qa prune --stale` remove entradas obsoletas com dry-run e filtro de idade; `qa stats` exclui stale dos totais principais.             | O usuário controla o acúmulo de versões inválidas e a economia reportada permanece conservadora.                                           |
| Escalação executável    | O tier `simple`, `medium` ou `high` seleciona modelos configurados nas CLIs locais quando `escalation.mode` é `execute`.               | A classificação deixa de ser apenas advisory no fluxo automatizado, sem chamadas diretas às APIs dos provedores.                           |
| Fluxo multiagente       | `rods flow run` executa desenvolvimento e revisão com Codex, Claude ou Gemini em worktree isolada, loop limitado e review estruturado. | Um resultado aprovado só promove o patch quando branch e HEAD originais permanecem inalterados; nos demais casos, o patch é preservado.    |
| Validação de execução   | Configurações dos dois papéis são verificadas antes da criação do worktree e novamente antes de cada chamada.                          | Erros identificam agente, fase e campo inválido; `RODS_DEBUG=1` habilita stack trace completo.                                             |
| Acurácia da revisão     | Gate de testes, coerência por severidade, diff transparente, memória lexical de findings e contexto opt-in reforçam o review.          | Falhas determinísticas evitam chamadas desnecessárias, enquanto contexto e padrões recorrentes melhoram a decisão dentro de limites fixos. |
| Uso de tokens           | Adapters extraem tokens somente das saídas JSON oficiais disponíveis e registram `unavailable` quando ausentes.                        | Relatórios não inventam consumo e permitem enxergar custo por etapa e por agente.                                                          |
| Migração SQLite         | Bancos antigos recebem backfill de `scope=general` e entradas Q&A legadas são classificadas como `repository`.                         | Bases já indexadas preservam dados e comportamento após o upgrade.                                                                         |
| Fluxo de cards externos | Casos de eval documentam quando perguntar antes de buscar contexto.                                                                    | Evita inferir requisitos de links externos sem confirmação.                                                                                |

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
rods qa store --question <text> --answer <text|-> --policy conceptual|files|repository [--files <paths>] [--summary <text>] [--tokens <count>]
rods qa search <question> [--threshold 0.75] [--json]
rods qa list [--project <name>] [--stale] [--json]
rods qa invalidate <id>
rods qa reclassify <id> --policy conceptual|files|repository [--files <paths>]
rods qa prune --stale [--project <name>] [--older-than <days>] [--dry-run] [--json]
rods qa stats [--project <name>] [--json]
rods flow run <task> [--mode <agent|developer+reviewer>] [--root <path>] [--json]
rods flow findings --file <path> [--project <name>] [--json]
rods hook run --target codex|claude
rods setup [path] [--json]
rods doctor [path] [--json]
rods run <task> --local-only [--root <path>] [--dry-run] [--explain] [--power eco|balanced|performance|max|auto] [--json]
```

Os agentes válidos para `flow run` são `codex`, `claude` e `gemini`. Um modo solo usa o mesmo agente para desenvolver e revisar. Pares devem usar agentes distintos e respeitam a ordem `developer+reviewer`:

```text
codex  claude  gemini
codex+claude  codex+gemini
claude+codex  claude+gemini
gemini+codex  gemini+claude
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
- O chunking usa heurísticas simples de estrutura e linhas vazias; ele não é um parser por linguagem.
- O schema reserva campos de metadados de embedding para busca híbrida futura, sem implementar embeddings no MVP.

Ao atualizar para a versão com chunking sensível à estrutura, a próxima execução de `rods ingest` reindexará o projeto inteiro uma única vez. As execuções seguintes voltarão a pular arquivos sem alterações normalmente.

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

`.ai/` é a fonte versionada da verdade. `rods adapter sync --target codex` mantém as skills em `.ai/skills` e sincroniza apenas os hooks do target. Se houver necessidade de uma projeção física para outro diretório, use `--codex-skills-dir <path>`. `rods adapter sync --target claude` gera a projeção `CLAUDE.md`. Gemini não é um target de `adapter sync`: sua integração atual é somente como CLI de execução do flow.

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

`rods escalation classify <task>` continua classificando a tarefa e recomendando uma classe de modelo. Em `escalation.mode: "advisory"` nada é executado, preservando o comportamento das configurações antigas. Em `"execute"`, `rods flow run` usa o tier para selecionar o modelo configurado e chama exclusivamente as CLIs locais.

Configure nomes de modelo explicitamente; o SDK não embute aliases que podem mudar entre versões:

```json
{
  "escalation": {
    "enabled": true,
    "mode": "execute",
    "policyPath": ".ai/policies/complexity.md",
    "specsDir": "docs/rods/specs"
  },
  "targets": {
    "codex": {
      "enabled": true,
      "execution": {
        "binary": "codex",
        "models": {
          "simple": "modelo-a",
          "medium": "modelo-b",
          "high": "modelo-c"
        },
        "args": [],
        "timeoutMs": 900000
      }
    },
    "claude": {
      "enabled": true,
      "execution": {
        "binary": "claude",
        "models": {
          "simple": "modelo-a",
          "medium": "modelo-b",
          "high": "modelo-c"
        },
        "args": [],
        "timeoutMs": 900000
      }
    },
    "gemini": {
      "enabled": true,
      "execution": {
        "binary": "gemini",
        "models": {
          "simple": "modelo-a",
          "medium": "modelo-b",
          "high": "modelo-c"
        },
        "args": [],
        "timeoutMs": 900000
      }
    }
  },
  "workflow": {
    "mode": "codex+gemini",
    "maxIterations": 3,
    "failOnSeverity": "high",
    "testCommand": { "command": "npm", "args": ["test"], "timeoutMs": 600000 },
    "reviewContext": false
  }
}
```

Quando executado via lifecycle hook, `rods hook run --target codex|claude` injeta a recomendação em `additionalContext` no evento `UserPromptSubmit`, junto com avisos de planejamento/revisão quando aplicáveis. O agente ou a pessoa operando a sessão ainda precisa ler essa sugestão e decidir manualmente se muda de modelo ou altera o plano de execução.

Para estimar o escopo, passe os arquivos explicitamente sempre que quiser um resultado sensível ao recorte da tarefa:

```bash
rods escalation classify "corrigir typo no README" --files README.md
```

Se `--files` for omitido, o classificador usa `git diff --name-only` no repositório atual como fallback. Isso é útil para classificar a mudança em andamento, mas pode surpreender em repositórios com alterações não commitadas: dois textos de tarefa diferentes podem produzir o mesmo resultado quando o diff local é o mesmo.

## Cache Q&A

O cache é lexical, não semântico. Perguntas são normalizadas e consultadas primeiro por hash exato; depois, o FTS5 retorna até três candidatos e um overlap determinístico decide o reuso. O threshold padrão é conservador (`0.75`) e pode ser alterado em `qa search`.

```bash
rods qa store --question "o que é este projeto?" --answer - --policy conceptual --tokens 420 < resposta.md
rods qa store --question "como funciona o parser?" --answer - --policy files --files src/parser.ts < resposta.md
rods qa store --question "qual é o estado atual?" --answer - --policy repository < resposta.md
rods qa search "como configuro o projeto?"
rods qa list --stale
rods qa stats
```

`--policy` é obrigatório na CLI: `conceptual` não depende do Git, `files` depende somente dos arquivos declarados e `repository` usa o fingerprint global de commit, diff e arquivos não rastreados. `files` exige uma lista não vazia de arquivos existentes dentro do projeto. Chamadas programáticas que omitirem a política usam `repository` por segurança.

Entradas stale são auditáveis e não são retornadas como hit quando existe candidato fresco. Reclassifique uma entrada explicitamente ou limpe stale em lote:

```bash
rods qa reclassify 12 --policy files --files src/parser.ts
rods qa prune --stale --older-than 30 --dry-run
rods qa prune --stale --older-than 30
```

`prune` nunca remove somente por idade: `--stale` é obrigatório. A remoção libera páginas para reuso pelo SQLite, mas não reduz necessariamente o arquivo sem `VACUUM`. Em `qa stats`, `hits` e `tokensSaved` incluem apenas entradas atualmente frescas; hits e tokens stale aparecem separadamente como excluídos, e números de tokens só usam contagens conhecidas.

## Fluxo Multiagente

`rods flow run` cria uma branch e worktree em `/tmp`, executa desenvolvimento e revisão em subprocessos e limita o loop por `workflow.maxIterations`. Antes de criar o worktree, o SDK valida `binary`, modelo do tier, `args` e `timeoutMs` para developer e reviewer. A mesma validação é repetida antes das chamadas, inclusive se o tier mudar após a implementação.

Cada adapter aplica o modo de permissão apropriado ao papel: Codex usa sandbox `workspace-write`/`read-only`, Claude usa `acceptEdits`/`plan` e Gemini usa `auto_edit`/`plan`. O revisor precisa produzir JSON estruturado com `approved`, `summary` e `findings`. No Gemini, o schema é solicitado pelo prompt porque a CLI não oferece enforcement equivalente ao `--output-schema` do Codex ou `--json-schema` do Claude; por isso, uma resposta fora do formato encerra o flow com erro explícito.

Antes da chamada ao revisor, o flow executa `workflow.testCommand` sem shell, quando configurado. Falha, timeout ou binário ausente geram um finding `high` e evitam a chamada de LLM naquela iteração. Depois da resposta, `failOnSeverity` reconcilia `approved` com os próprios findings do modelo; por padrão, qualquer finding `high` bloqueia a aprovação.

O diff de revisão mantém orçamento máximo de 50 mil caracteres sem cortar patches no meio. Arquivos omitidos são declarados no prompt e continuam disponíveis no worktree somente leitura. Findings históricos do mesmo arquivo são agrupados por overlap lexical mínimo de `0.50`; até três padrões recorrentes entram no prompt, e `rods flow findings --file <path>` permite consultá-los manualmente. A retenção/prune desse histórico permanece dívida explícita; o flow reporta quantos findings e comparações foram consultados.

`workflow.reviewContext` é opt-in. Quando habilitado, o revisor recebe no máximo cinco snippets compactos do Context Engine, sempre filtrados pelo projeto atual e sem leitura de chunks completos. Ausência de índice é fail-open e fica registrada nos metadados da etapa.

O workspace original não recebe alterações durante o desenvolvimento e a
revisão. Ao final de um flow aprovado, o RODS promove automaticamente o patch
somente se o branch e o HEAD originais permanecerem inalterados; se essa guarda
falhar, o patch é preservado em `/tmp` e não é aplicado. Flows não aprovados
também preservam worktree e patch para inspeção ou aplicação manual. Uso de
tokens é extraído apenas quando a saída JSON oficial da CLI o fornece; etapas
sem dados aparecem como `unavailable`.

Configurações v2 com `modelAdviceOnly` são interpretadas como `advisory`. Rode `rods upgrade --dry-run` antes de atualizar o template; arquivos `.ai/config.json` customizados são preservados e devem receber os novos campos manualmente.

### Diagnóstico de execução

Por padrão, o CLI mostra uma mensagem curta. Erros de configuração informam o agente, a fase (`develop`, `patch` ou `review`) e o campo inválido, por exemplo:

```text
Invalid execution configuration for gemini during review: binary must be a non-empty string
```

Para obter o stack trace completo durante uma investigação:

```bash
RODS_DEBUG=1 rods flow run "minha tarefa" --mode codex+gemini
```

Identificadores de modelo são repassados sem alteração para cada CLI. Portanto, um modelo inexistente ou incompatível é reportado pela própria CLI e identifica o agente que falhou.

## Adaptadores Opcionais

Adaptadores documentam e validam ferramentas opcionais. Eles não são dependências embutidas, e o rods-sdk não reimplementa o comportamento dessas ferramentas.

- `rtk`: compactação padrão de saída de comandos.
- `claude-mem`: memória persistente entre sessões.
- `caveman`: saída curta, ativada somente por opção.

Use `rods adapter enable <name>` para registrar a intenção em `.ai/config.json` e gerar `.ai/adapters/<name>.md`. Use `rods adapter doctor` para verificar instalação, configuração detectada, hooks, sinais MCP e possíveis conflitos.
