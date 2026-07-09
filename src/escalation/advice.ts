import type { IClassificationResult, IModelAdvice } from './types.js';

export function createModelAdvice(result: IClassificationResult): IModelAdvice {
  if (result.level === 'simple') {
    return { recommendation: 'economy', rationale: 'escopo pequeno e sem integração externa', changesConfiguration: false };
  }
  if (result.level === 'medium') {
    return { recommendation: 'balanced', rationale: 'há múltiplos sinais, mas o escopo ainda é controlável', changesConfiguration: false };
  }
  return { recommendation: 'high-capability', rationale: 'escopo Alto/Epic exige planejamento e validação mais profunda', changesConfiguration: false };
}
