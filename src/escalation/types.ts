export type ComplexityLevel = 'simple' | 'medium' | 'high';
export type ModelRecommendation = 'economy' | 'balanced' | 'high-capability';

export interface IComplexityBand {
  maxFiles?: number;
  minFiles?: number;
  maxLayers?: number;
  minLayers?: number;
}

export interface IComplexityPolicy {
  simple: IComplexityBand;
  medium: IComplexityBand;
  high: IComplexityBand;
  epicPhrases: string[];
  dependencyRaisesTo: ComplexityLevel;
  layers: string[];
}

export interface IClassificationInput {
  task: string;
  files?: string[];
  root?: string;
  policy?: IComplexityPolicy;
  preExecution?: boolean;
}

export interface IClassificationResult {
  level: ComplexityLevel;
  confidence: number;
  reasons: string[];
  estimatedFiles: number;
  estimatedLayers: number;
  dependencyNew: boolean;
  epic: boolean;
  needsHumanReview: boolean;
  planningRequired: boolean;
}

export interface IModelAdvice {
  recommendation: ModelRecommendation;
  rationale: string;
  changesConfiguration: false;
}
