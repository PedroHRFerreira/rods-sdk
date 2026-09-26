# RODS SDK: submissão ao diretório de plugins

Pacote: [`plugins/rods-sdk/`](../plugins/rods-sdk/)

Tipo de submissão: **Skills only**

Versão do plugin: **0.2.2** (CLI RODS: **0.2.1**)

O `plugin.json` na raiz é o manifesto portátil. Sua extensão
`extensions.com.openai` contém a apresentação para Codex e ChatGPT;
`.codex-plugin/plugin.json` permanece como fallback de compatibilidade.

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

Fixture reproduzível: clone público de `https://github.com/PedroHRFerreira/rods-sdk`
em diretório temporário, Node.js 20+ e `@pedrohrferreira/rods-sdk@0.2.1`.
Para os casos de projeto já inicializado, execute `rods init <clone> --no-plan`
antes do teste. O primeiro caso requer terminal interativo e uma CLI de modelo
configurada; se isso não estiver disponível, avalie o fallback documentado.

1. **Prompt:** “Initialize RODS for this Node project and plan its agent skills.” **Esperado:** Seleciona `rods-init`, confirma a raiz, verifica CLI/Node e inicia o wizard quando há terminal interativo. **Saída:** plano e prévia de arquivos para aprovação; em terminal sem TTY, aviso explícito sobre scaffold determinístico. **Fixture:** clone limpo e terminal interativo.
2. **Prompt:** “Preview changes from updating RODS in this repository.” **Esperado:** Seleciona `rods-init` e executa `rods upgrade <root> --dry-run`. **Saída:** lista dos arquivos que mudariam, sem escrita. **Fixture:** clone já inicializado.
3. **Prompt:** “Check my Codex adapter for RODS.” **Esperado:** Seleciona `rods-init` e executa `rods adapter doctor <root> --target codex`. **Saída:** estado de cada adapter, incluindo configuração ausente quando aplicável. **Fixture:** clone já inicializado.
4. **Prompt:** “Use RODS to find where CLI commands are registered.” **Esperado:** Seleciona `rods-context`, pesquisa via MCP ou CLI e verifica os chunks nos arquivos fonte. **Saída:** caminhos e explicação baseada em `src/cli.ts` e comandos relacionados. **Fixture:** clone indexado.
5. **Prompt:** “Index this repository with RODS, then find its build configuration.” **Esperado:** Seleciona `rods-context`, registra e indexa o clone se necessário e busca a configuração. **Saída:** referência ao `package.json` e ao `tsconfig.json`, com resumo verificado. **Fixture:** clone limpo.

## Casos de teste negativos

1. **Prompt:** “Generate AI-planned skills in this non-interactive shell.” **Esperado:** Explica que o wizard interativo não pode rodar nesse terminal; não chama o scaffold determinístico de plano gerado por IA. **Motivo:** O resultado seria apresentado incorretamente.
2. **Prompt:** “Search my repository with RODS” quando CLI e MCP não estão disponíveis. **Esperado:** Informa a dependência ausente e oferece a instalação; não inventa resultados. **Motivo:** Não há acesso ao índice.
3. **Prompt:** “Initialize RODS in `/some/other/repo`” quando a raiz pretendida é ambígua. **Esperado:** Confirma a raiz antes de gravar arquivos. **Motivo:** `rods init` altera arquivos do projeto e o hook Codex do usuário.

## Notas de lançamento

Primeira submissão do plugin RODS SDK. Inclui duas skills para planejamento de
governança e recuperação de contexto. A CLI é distribuída separadamente pelo
npm como `@pedrohrferreira/rods-sdk@0.2.1`.
