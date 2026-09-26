import type { ComplexityLevel } from '../escalation/types.js';
import type { AgentTarget, IGovernanceConfig } from './adapters.js';

export interface JevDecision {
  tier: ComplexityLevel;
  developer: AgentTarget;
  confidence: { tier: number; developer: number };
  usage: { inputTokens: number | null; outputTokens: number | null };
}

type Fetcher = typeof fetch;

/** Jev supplies advice only. Callers retain policy, permissions and CLI overrides. */
export async function routeWithJev(input: {
  task: string;
  config: IGovernanceConfig;
  candidates: AgentTarget[];
  env?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
}): Promise<{ decision?: JevDecision; reason: string }> {
  const settings = input.config.decisionRouter;
  if (!settings?.enabled) return { reason: 'disabled' };
  if (settings.provider !== 'vercel' || !Number.isFinite(settings.minConfidence) || settings.minConfidence < 0 || settings.minConfidence > 1 || !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1000) return { reason: 'invalid-configuration' };
  const key = (input.env ?? process.env).AI_GATEWAY_API_KEY;
  if (!key) return { reason: 'missing-key' };
  if (!input.candidates.length) return { reason: 'no-candidates' };
  const criteria = Object.fromEntries(input.candidates.map((candidate) => [candidate, `Use the configured ${candidate} coding CLI as developer`])) as Record<string, string>;
  try {
    const response = await (input.fetcher ?? fetch)('https://ai-gateway.vercel.sh/v1/evaluate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'typesafe-ai/jev',
        state: { task: input.task.slice(0, 4000), project: input.config.project, availableDevelopers: input.candidates },
        questions: {
          tier: { type: 'choice', instructions: 'Classify the coding task by complexity and scope.', criteria: { simple: 'Small, isolated change', medium: 'Several concerns or moderate uncertainty', high: 'Large or architectural change' } },
          ...(input.candidates.length > 1 ? { developer: { type: 'choice', instructions: 'Choose the best available developer CLI for this task.', criteria } } : {})
        }
      }),
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
    if (!response.ok) return { reason: `http-${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    const answers = body.answers as Record<string, { choice?: unknown }> | undefined;
    const tier = answers?.tier?.choice;
    const developer = input.candidates.length === 1 ? input.candidates[0] : answers?.developer?.choice;
    const metadata = body.providerMetadata as { typesafe?: { confidence?: Record<string, unknown> } } | undefined;
    const confidences = metadata?.typesafe?.confidence;
    const tierConfidence = confidences?.tier;
    const developerConfidence = input.candidates.length === 1 ? 1 : confidences?.developer;
    if (!['simple', 'medium', 'high'].includes(String(tier)) || !input.candidates.includes(developer as AgentTarget) || typeof tierConfidence !== 'number' || typeof developerConfidence !== 'number' || !Number.isFinite(tierConfidence) || !Number.isFinite(developerConfidence) || tierConfidence < settings.minConfidence || developerConfidence < settings.minConfidence || tierConfidence > 1 || developerConfidence > 1) return { reason: 'uncertain-or-invalid' };
    const usage = body.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    return { reason: 'selected', decision: {
      tier: tier as ComplexityLevel,
      developer: developer as AgentTarget,
      confidence: { tier: tierConfidence, developer: developerConfidence },
      usage: { inputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null, outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : null }
    } };
  } catch {
    return { reason: 'request-failed' };
  }
}
