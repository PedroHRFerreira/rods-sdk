# Status — RODS Local-First MVP

## Estado atual

O projeto possui uma **Local-First Foundation** implementada e validada, mas o Local-First MVP ainda não está concluído end-to-end.

O PR 1 de compute está concluído: `rods doctor --compute` coleta o perfil básico
da máquina e verifica Ollama exclusivamente por API HTTP loopback documentada.
LM Studio é descoberto e diagnosticado, mas permanece não verificável porque o
LM Link pode rotear `localhost` para um modelo em outro dispositivo. Magnitude
permanece experimental e inelegível para `--local-only`.

O PR 2 formalizou a fronteira do Codex Harness. A versão atual do CLI anuncia
`--oss --local-provider ollama|lmstudio`, mas não disponibiliza uma API/JSON de
atestado da rota efetiva. Por isso `harnessRoute.routeVerified` permanece
`false`, e fallback/credenciais cloud ficam `unknown`; o resultado seguro é
`HARNESS_NOT_READY`.

O PR 3 centralizou `LocalityProof`, `HarnessRouteProof`,
`NetworkIsolationProof` e `LocalOnlyPolicy` no `LocalOnlyGate`. A política
padrão exige isolamento de rede; esta versão ainda não tem uma prova de
isolamento no nível do SO, portanto esse requisito também falha de forma
estruturada quando a rota do harness estiver pronta.

A foundation inclui `rods setup`, `rods doctor`, `rods run`, Context Engine com orçamento de contexto, filtros de segredos, runtime e harness separados, worktree isolada, patch sanitizado, validação opt-in, zero-cloud em `--local-only` e testes com doubles.

## Verificação

```text
npm run typecheck  ✓
npm run build      ✓
npm test           ✓ 92/92
```

## Discovery verificado

O discovery de 2026-09-14 foi somente leitura: nenhum modelo foi baixado, serviço iniciado ou configuração global modificada.

- Ollama pode ser candidato local quando sua API loopback documentada responde e lista ao menos um modelo; essa prova ainda não verifica o Codex.
- LM Studio é diagnosticado pela API nativa, mas não é candidato `--local-only`: LM Link pode responder em `localhost` com inferência remota.
- Magnitude `0.0.14` expõe status de serviço, modelos e conexões, mas não um contrato estruturado documentado suficiente para automation segura.
- A integração Magnitude → Codex depende de um comando de lançamento exibido ao usuário, sem esquema/API público para atestar conexão ou endpoint local.
- A ligação Codex → runtime local ainda não foi verificada neste ambiente.

## Decisão de segurança

O caminho real permanece **fail-closed**. `rods run --local-only` não inicia o harness quando não consegue provar a rota exclusivamente local; retorna erros estruturados como `RUNTIME_CONTRACT_UNSUPPORTED`, `LOCAL_RUNTIME_NOT_READY` ou `HARNESS_NOT_READY`.

```text
localOnly = true
        ↓
cloud provider resolved = NO
cloud provider initialized = NO
cloud calls = 0
```

## O que bloqueia o MVP E2E

O bloqueador externo para o E2E verificado é um contrato estruturado e confiável
do Codex que permita verificar, sem parsing frágil de terminal:

1. runtime local verificado e modelo utilizável;
2. modelo local compatível disponível e utilizável pelo runtime;
3. provider Codex configurado e efetivamente selecionado;
4. endpoint usado pelo Codex é local;
5. modelo usado pelo Codex corresponde ao runtime verificado;
6. fallback ou inicialização cloud está desabilitado;
7. execução real funciona sem credenciais cloud no processo do harness.

Até existir uma interface pública e verificável que prove essas propriedades, a classificação correta é **Local-First Foundation**, e não **Completed Local-First MVP**.

## Roadmap oficial

| PR | Escopo | Estado |
| --- | --- | --- |
| 1 | Local Compute Foundation | Concluído |
| 2 | Harness Route Proof | Concluído — rota Codex não verificável nesta versão |
| 3 | Local-Only Security Gate | Concluído |
| 4A | E2E Security Infrastructure | Concluído |
| 4B.1 | Effective Route Contract | Concluído — contratos e gate composto |
| 4B.2 | Linux Network Confinement | Concluído — `bwrap` + gateway loopback privado |
| 4B.3 | OpenCode Confinement Evaluation | Bloqueado no ambiente atual — confinamento Linux indisponível e Ollama ausente |
| 4B.4 | Verified Local E2E | Dependente de 4B.3 |

O gate centralizado nega a execução antes de iniciar o harness. Com o estado
atual, a razão é `HARNESS_NOT_READY`; harness não será iniciado, arquivos não
serão alterados e `cloudCalls` permanecerá zero. Quando a rota do harness for
verificada, a política padrão ainda exigirá uma `NetworkIsolationProof` de que
loopback está liberado e rede externa bloqueada.

O PR 4A agora possui fixture E2E com repositório Git e worktree reais. O caminho
permitido produz patch e relatório sanitizados após uma validação real; o caminho
negado confirma `HARNESS_NOT_READY`, sem executar harness, alterar arquivos ou
criar worktree adicional. O PR 4B só será liberado quando uma capacidade oficial
permitir que `CodexHarness.verifyLocalRoute()` produza prova de provider,
endpoint, modelo e rota sem cloud.

## PR 4B — Codex Official Contract Discovery

O discovery comparou somente interfaces oficiais, sem atualizar o Codex e sem
interpretar output humano ou configuração interna. O CLI instalado `0.154.0`
gera schemas JSON oficiais para o app-server. Eles expõem `model_provider` e
`model` em `config/read`, `modelProvider` na thread e `requiresOpenaiAuth` em
`account/read`; o próprio schema esclarece que o modelo de thread não é
telemetria por turno. Não há campo público para endpoint/base URL resolvido,
modelo efetivamente atendido pelo runtime ou comportamento de fallback cloud.

| Capacidade | 0.154.0 instalado | Latest stable 0.154.0 | Preview 0.155.0-alpha.5 |
| --- | --- | --- | --- |
| Provider local anunciado | ✓ | ✓ | Não instalado; não atestado por docs |
| Provider ativo estruturado | Parcial: estado de thread | Parcial | Não demonstrado |
| Endpoint resolvido | ✗ | ✗ | Não demonstrado |
| Modelo efetivo por execução | ✗ | ✗ | Não demonstrado |
| Sem autenticação OpenAI | Parcial: `requiresOpenaiAuth` | Parcial | Não demonstrado |
| Sem fallback cloud | ✗ | ✗ | Não demonstrado |
| Contrato suficiente | ✗ | ✗ | ✗ por ausência de evidência pública |

O `HarnessRouteProof` agora registra
`CODEX_HARNESS_CONTRACT_INSUFFICIENT` e o `LocalOnlyGate` continua devolvendo
`HARNESS_NOT_READY`. Não há workaround implementado. A prévia permanece apenas
como candidata a ser reavaliada quando publicar um contrato estável e completo.

## Próximo passo — Alternative Harness Evaluation

O RODS passa a tratar o harness como uma fronteira substituível. O
`CodexHarness` permanece suportado para coding e providers locais, mas sua
capacidade `verifiedLocalRoute` é atualmente falsa; ele não é elegível para
`--local-only`. Nenhum comportamento do `LocalOnlyGate` muda por esse motivo.

| Harness | Coding | Provider local | Rota local verificável | Estado |
| --- | --- | --- | --- | --- |
| Codex | ✓ | ✓ | ✗ | `CODEX_HARNESS_CONTRACT_INSUFFICIENT` |
| Alternativo | A avaliar | A avaliar | A avaliar | Não selecionado |

Um candidato só poderá produzir um `HarnessRouteProof` elegível se um contrato
público e estruturado atestar provider ativo, endpoint resolvido, modelo
efetivamente usado, correspondência com o runtime verificado, requisito de
autenticação e ausência de fallback cloud. Até lá, a resposta correta do gate
é negar a execução, sem workaround ou inferência por configuração aparente.

## PR 4B.1 — Effective Route Contract

O RODS agora formaliza duas estratégias independentes para uma rota efetiva:
`harness-attestation` e `network-confinement`. A primeira exige atestação
estruturada da rota pelo harness. A segunda exige, simultaneamente,
configuração explícita com allowlist, runtime e modelo `same-machine`
verificados, e confinamento de rede imposto pelo SO.

`HarnessConfigurationProof` nunca autoriza uma execução sozinho. Para o
caminho de confinamento, a prova requer loopback liberado apenas para o
endpoint do runtime, rede externa bloqueada e
`externalConnectionsSucceeded = 0`. O `LocalOnlyGate` ganhou uma entrada
tipada para essa prova composta e continua negando qualquer estado incompleto.

O próximo PR implementará apenas `LinuxNetworkConfinement`. Até que ele exista
e o experimento real OpenCode + Ollama o aprove, OpenCode permanece inelegível
para `--local-only`.

## PR 4B.2 — Linux Network Confinement

`LinuxNetworkConfinement` usa um namespace de rede do `bwrap` e inicia o
harness com ambiente limpo, sem interfaces externas e com loopback privado. Um
gateway Unix privado, criado pelo RODS, é a única saída do namespace: ele é
fixado ao host e porta do runtime loopback verificado. O harness não recebe
credenciais herdadas nem acesso aos diretórios `/run`, `/var`, `HOME` ou `/tmp`
do host fora da worktree controlada.

O probe executa o mecanismo antes de declarar suporte. Em plataformas ou
sandboxes nas quais o kernel recusa o namespace, o resultado é
`NETWORK_ISOLATION_UNAVAILABLE`. A execução também recusa allowlists com mais
de um endpoint ou qualquer endpoint fora de loopback. A disponibilidade real
para OpenCode + Ollama segue pendente do experimento PR 4B.3.

## PR 4B.3 — OpenCode Confinement Evaluation

O experimento real não iniciou neste ambiente: embora `bwrap` esteja instalado,
o probe do kernel recusou criar o namespace de rede e retornou
`NETWORK_ISOLATION_UNAVAILABLE`. Ollama também não está instalado, portanto não
há runtime nem modelo local para verificar (`LOCAL_RUNTIME_NOT_READY`).

Nenhum processo OpenCode foi iniciado, nenhuma inferência foi tentada, nenhuma
worktree foi criada e conexões externas bem-sucedidas permanecem zero. O PR
4B.4 continua bloqueado até uma máquina Linux com suporte efetivo ao namespace
e um Ollama com modelo local estejam disponíveis para o teste real.
