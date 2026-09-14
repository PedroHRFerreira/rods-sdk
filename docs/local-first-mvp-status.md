# Status — RODS Local-First MVP

## Estado atual

O projeto possui uma **Local-First Foundation** implementada e validada, mas o Local-First MVP ainda não está concluído end-to-end.

A foundation inclui `rods setup`, `rods doctor`, `rods run`, Context Engine com orçamento de contexto, filtros de segredos, runtime e harness separados, worktree isolada, patch sanitizado, validação opt-in, zero-cloud em `--local-only` e testes com doubles.

## Verificação

```text
npm run typecheck  ✓
npm run build      ✓
npm test           ✓ 86/86
```

## Discovery verificado

O discovery de 2026-09-14 foi somente leitura: nenhum modelo foi baixado, serviço iniciado ou configuração global modificada.

- Magnitude `0.0.14` expõe status de serviço, modelos e conexões, mas não um contrato estruturado documentado suficiente para automation segura.
- A integração Magnitude → Codex depende de um comando de lançamento exibido ao usuário, sem esquema/API público para atestar conexão ou endpoint local.
- Codex `0.154.0` lista apenas `lmstudio` e `ollama` em `--local-provider`; Magnitude não é um provider local verificável nessa interface.
- Não há conexão Codex/Magnitude nem modelo local pronto configurados neste ambiente.

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

Falta identificar ou disponibilizar um contrato estruturado e confiável que permita verificar, sem parsing frágil de terminal:

1. runtime Magnitude pronto;
2. modelo local compatível disponível e utilizável pelo runtime;
3. conexão Codex → Magnitude configurada;
4. endpoint usado pelo Codex é local;
5. fallback ou inicialização cloud está desabilitado;
6. execução real funciona sem credenciais cloud no processo do harness.

Até existir uma interface pública e verificável que prove essas propriedades, a classificação correta é **Local-First Foundation**, e não **Completed Local-First MVP**.
