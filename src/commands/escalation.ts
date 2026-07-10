import path from 'node:path';
import type { Command } from 'commander';
import { classifyTask, createModelAdvice, filesFromArgument, loadComplexityPolicy } from '../escalation/index.js';

export function registerEscalationCommand(program: Command): void {
  const escalation = program.command('escalation').description('Classify task complexity and recommend a model class');
  escalation
    .command('classify')
    .argument('<task>', 'task description')
    .option('--files <files>', 'comma-separated paths touched by the task; defaults to git diff --name-only when omitted')
    .option('--root <path>', 'project root', '.')
    .option('--json', 'emit JSON')
    .action(async (task: string, options: { files?: string; root: string; json?: boolean }) => {
      const root = path.resolve(options.root);
      const policy = await loadComplexityPolicy(root);
      const result = classifyTask({ task, files: filesFromArgument(options.files), root, policy });
      const advice = createModelAdvice(result);
      const output = { ...result, modelAdvice: advice };
      if (options.json) console.log(JSON.stringify(output));
      else {
        console.log(`level=${result.level} confidence=${result.confidence.toFixed(2)} files=${result.estimatedFiles} layers=${result.estimatedLayers}`);
        console.log(`planningRequired=${result.planningRequired} needsHumanReview=${result.needsHumanReview}`);
        console.log(`model=${advice.recommendation} changesConfiguration=${advice.changesConfiguration}`);
        for (const reason of result.reasons) console.log(`reason=${reason}`);
      }
    });
}
