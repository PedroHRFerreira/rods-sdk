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
npm test           ✓ 91/91
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
| 4A | E2E Security Infrastructure | Próximo |
| 4B | Verified Local E2E | Bloqueado por contrato externo do Codex |

O gate centralizado nega a execução antes de iniciar o harness. Com o estado
atual, a razão é `HARNESS_NOT_READY`; harness não será iniciado, arquivos não
serão alterados e `cloudCalls` permanecerá zero. Quando a rota do harness for
verificada, a política padrão ainda exigirá uma `NetworkIsolationProof` de que
loopback está liberado e rede externa bloqueada.

O PR 4A pode integrar fixture real, worktree, validação, patch, relatório e o
gate de segurança. O PR 4B só será liberado quando uma capacidade oficial
permitir que `CodexHarness.verifyLocalRoute()` produza prova de provider,
endpoint, modelo e rota sem cloud.
