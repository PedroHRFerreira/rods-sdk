import path from 'node:path';
import { classifyTask, createModelAdvice, loadComplexityPolicy } from '../escalation/index.js';
import type { AdapterTarget } from './adapters.js';

export interface IHookInput {
  hook_event_name?: string;
  prompt?: string;
  cwd?: string;
  model?: string;
}

export interface IHookResponse {
  systemMessage?: string;
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

export async function createHookResponse(target: AdapterTarget, input: IHookInput): Promise<IHookResponse | undefined> {
  if (input.hook_event_name !== 'UserPromptSubmit') return undefined;
  const root = path.resolve(input.cwd ?? process.cwd());
  const result = classifyTask({
    task: input.prompt ?? '',
    root,
    policy: await loadComplexityPolicy(root)
  });
  const advice = createModelAdvice(result);
  const label = result.level === 'simple' ? 'SIMPLES' : result.level === 'medium' ? 'MÉDIO' : 'ALTO';
  const summary = `Rods escalation: ${label} | ${result.estimatedFiles} arquivo(s) | ${result.estimatedLayers} camada(s) | modelo recomendado: ${advice.recommendation}.`;
  const planning = result.planningRequired
    ? ' Antes de editar, use a skill design-brainstorm; faça uma pergunta por vez. Opt-out visível: diga "ignorar planejamento do rods".'
    : '';
  const review = result.needsHumanReview ? ' Confiança baixa: confirme o escopo antes de mudanças amplas.' : '';
  const additionalContext = `${summary}${planning}${review} Nenhuma configuração de modelo foi alterada automaticamente.`;
  return {
    systemMessage: summary,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext }
  };
}
