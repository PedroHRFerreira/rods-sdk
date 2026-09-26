# MIT e páginas públicas do plugin RODS

## Escopo aprovado

O mantenedor escolheu a licença MIT e confirmou a publicação de uma nova
versão npm, além da atualização do repositório e do plugin Codex.

## Mudanças

- Adicionar `LICENSE` com copyright de 2026 em nome de Pedro Henrique Ferreira.
- Declarar `MIT` no pacote npm e publicar uma nova versão de patch (`0.2.2`),
  incluindo a licença no tarball.
- Publicar `PRIVACY.md` e `TERMS.md` a partir dos textos fornecidos pelo
  mantenedor, com referências factuais ao armazenamento local e ao Jev
  opcional. Deixar explícito que a licença MIT prevalece para os direitos
  sobre o código.
- Apontar os manifests portátil e de compatibilidade do plugin para as URLs
  públicas dos documentos, usando o nome completo do mantenedor. A versão do
  plugin passa a `0.2.3` para distribuir os metadados atualizados.
- Atualizar a documentação de instalação e submissão.

## Validação e publicação

Validar manifests e skills, verificar a presença de `LICENSE` no tarball,
executar o gate necessário do pacote, confirmar que a versão npm ainda não
existe, publicar com acesso público, enviar o commit ao GitHub e conferir os
metadados públicos. A ordem pode variar para garantir que as URLs legais
estejam públicas no momento da publicação npm.

A submissão ao diretório oficial da OpenAI segue pendente de identidade
verificada, países de disponibilidade e acesso autenticado ao portal. Não
declarar que o plugin está no diretório antes da revisão da OpenAI.
