# Privacy Policy

**Last updated: September 26, 2026**

This Privacy Policy describes how **Rods SDK** (“Rods SDK”, “we”, “our”, or “the project”) handles information when you install, access, or use the Rods SDK software, CLI tools, integrations, skills, or related services.

## 1. About Rods SDK

Rods SDK is an open-source developer tool designed to help developers organize and orchestrate AI-assisted development workflows.

The project provides features related to context management, agent orchestration, token optimization, Model Context Protocol (MCP) integrations, and interoperability with supported AI development tools and providers.

## 2. Information Processed by Rods SDK

Rods SDK may process information necessary to perform the actions requested by the user, including:

- Project files and source code;
- Configuration files;
- Prompts and instructions;
- AI agent context;
- Information stored within the project's `.ai/` directory;
- Metadata related to tasks, sessions, agents, or development workflows;
- Information explicitly provided by the user to an AI provider or integration.

The exact information processed depends on the features, integrations, and configuration selected by the user.

## 3. Local Data

Rods SDK is primarily a developer tool executed within the user's development environment.

Project context, configuration, prompts, memory, and related information may be stored locally as part of the project, including within the `.ai/` directory. The Context Engine stores its local configuration and SQLite database under `~/.context-engine/` by default; `CONTEXT_ENGINE_HOME` can change that location.

Users are responsible for determining what information they make available to Rods SDK and connected AI tools.

## 4. Third-Party Services

Rods SDK may integrate with or invoke third-party software and AI services, including tools such as OpenAI Codex, Claude Code, Gemini, MCP-compatible services, and other supported providers. Its optional Jev decision router can send task text and project metadata to the Vercel AI Gateway when enabled and configured by the user.

When a user chooses to use a third-party integration, information required to execute the requested operation may be processed by that provider.

The handling of information by third-party providers is governed by their respective privacy policies and terms. Rods SDK does not control the privacy practices of those providers.

## 5. Credentials and Authentication

Some integrations may require API keys, authentication credentials, CLI authentication, tokens, or other authorization mechanisms.

Users are responsible for securely managing their credentials.

Rods SDK should not be used to intentionally expose passwords, private keys, access tokens, or other secrets to AI agents or third-party services unless required and understood by the user.

## 6. Telemetry and Analytics

Unless explicitly documented for a particular feature or service, Rods SDK does not require users to provide personal information simply to install the open-source package.

Future hosted services or optional features may introduce analytics, diagnostics, or other data processing. If this occurs, this Privacy Policy will be updated accordingly.

## 7. Data Sharing

Rods SDK does not sell users' personal information.

Information may be transmitted to third-party services only when necessary to execute functionality selected or configured by the user, such as interactions with AI providers or external MCP services.

## 8. Data Security

Reasonable technical measures are used when designing Rods SDK to reduce unnecessary exposure of project information.

However, no software or method of electronic processing can guarantee absolute security.

Users should review their configuration and avoid exposing sensitive information to AI providers or integrations unless appropriate.

## 9. Open-Source Software

Rods SDK is distributed as open-source software.

Users may inspect the project's source code to understand how the software processes project information and interacts with external services.

## 10. Children's Privacy

Rods SDK is a developer tool and is not specifically directed toward children.

We do not knowingly design the service to collect personal information from children.

## 11. Changes to This Policy

This Privacy Policy may be updated as Rods SDK evolves.

Material changes will be reflected by updating the “Last updated” date at the beginning of this document.

## 12. Contact

Questions regarding this Privacy Policy can be submitted through the [official Rods SDK repository](https://github.com/PedroHRFerreira/rods-sdk/issues) or the contact channels provided by the project maintainer.

- **Project:** Rods SDK
- **Maintainer:** Pedro Henrique Ferreira
- **npm package:** [@pedrohrferreira/rods-sdk](https://www.npmjs.com/package/@pedrohrferreira/rods-sdk)
