# RODS SDK: submissão ao diretório de plugins

Pacote: [`plugins/rods-sdk/`](../plugins/rods-sdk/)

Tipo de submissão: **Skills only**

Versão: **0.2.1**

## Informações para o formulário

| Campo | Valor |
| --- | --- |
| Nome | RODS SDK |
| Descrição curta | Plan project-specific skills and find repository context with RODS. |
| Descrição longa | Guide Codex through RODS initialization, review the proposed project-specific skills, and retrieve focused repository context through the local Context Engine. Requires the RODS SDK CLI for command execution. |
| Categoria | Productivity |
| Site | https://github.com/PedroHRFerreira/rods-sdk |
| Suporte | https://github.com/PedroHRFerreira/rods-sdk/issues |
| Logo | `plugins/rods-sdk/assets/logo.png` |
| Política de privacidade | Pendente: URL pública fornecida pelo mantenedor |
| Termos de uso | Pendente: URL pública fornecida pelo mantenedor |
| Identidade do desenvolvedor | Selecionar identidade verificada no OpenAI Platform |
| Disponibilidade | Selecionar países após confirmar suporte e textos legais |

O pacote para upload é o diretório `plugins/rods-sdk/skills/`, com os dois
`SKILL.md`. Esta submissão não inclui MCP: o servidor do RODS roda localmente,
e o portal exige um endpoint HTTPS público para submissões com MCP.

## Prompts iniciais

1. Plan RODS skills for this repository and show me the proposed files.
2. Use RODS to find the code and documentation for authentication.
3. Check whether RODS is initialized for this project and suggest updates.

## Casos de teste positivos

1. **Prompt:** “Initialize RODS for this Node project and plan its agent skills.” **Esperado:** Seleciona `rods-init`, confirma a raiz do projeto, verifica CLI/Node e executa o fluxo interativo quando houver terminal; mostra as skills propostas antes de gravar. **Fixture:** repositório Git público de exemplo com `package.json`, Node 20+ e CLI instalada.
2. **Prompt:** “Preview changes from updating RODS in this repository.” **Esperado:** Seleciona `rods-init`, executa `rods upgrade <root> --dry-run` e resume alterações sem sobrescrever skills customizadas. **Fixture:** projeto já inicializado pelo RODS.
3. **Prompt:** “Check my Codex adapter for RODS.” **Esperado:** Seleciona `rods-init`, executa `rods adapter doctor <root> --target codex` e relata o estado. **Fixture:** projeto RODS inicializado.
4. **Prompt:** “Use RODS to find where the API routes are registered.” **Esperado:** Seleciona `rods-context`, pesquisa via MCP ou CLI, lê chunks relevantes e cita caminhos de arquivo. **Fixture:** repositório indexado com rotas de API.
5. **Prompt:** “Index this public sample repository with RODS, then find its build configuration.” **Esperado:** Seleciona `rods-context`, registra e indexa o projeto local quando necessário, busca a configuração e verifica os arquivos fonte. **Fixture:** repositório público local, CLI instalada.

## Casos de teste negativos

1. **Prompt:** “Generate AI-planned skills in this non-interactive shell.” **Esperado:** Explica que o wizard interativo não pode rodar nesse terminal; não chama o scaffold determinístico de plano gerado por IA. **Motivo:** O resultado seria apresentado incorretamente.
2. **Prompt:** “Search my repository with RODS” quando CLI e MCP não estão disponíveis. **Esperado:** Informa a dependência ausente e oferece a instalação; não inventa resultados. **Motivo:** Não há acesso ao índice.
3. **Prompt:** “Initialize RODS in `/some/other/repo`” quando a raiz pretendida é ambígua. **Esperado:** Confirma a raiz antes de gravar arquivos. **Motivo:** `rods init` altera arquivos do projeto e o hook Codex do usuário.

## Notas de lançamento

Primeira submissão do plugin RODS SDK. Inclui duas skills para planejamento de
governança e recuperação de contexto. A CLI é distribuída separadamente pelo
npm como `@pedrohrferreira/rods-sdk@0.2.1`.
