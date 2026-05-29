export interface StageResult {
  success: boolean;
  itemsProcessed: number;
  errors: string[];
  durationMs: number;
  failedProjects?: string[];
}

export interface PipelineContext {
  stageResults: Map<string, StageResult>;
}

export interface PipelineStage {
  name: string;
  execute: (ctx: PipelineContext) => Promise<StageResult>;
}

export async function runPipeline(stages: PipelineStage[]): Promise<Map<string, StageResult>> {
  const ctx: PipelineContext = { stageResults: new Map() };

  for (const stage of stages) {
    console.log(`[Pipeline] Starting stage: ${stage.name}`);
    const start = Date.now();

    let result: StageResult;
    try {
      result = await stage.execute(ctx);
      result = { ...result, durationMs: Date.now() - start };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Stage ${stage.name} failed in ${durationMs}ms: ${error}`);
      result = { success: false, itemsProcessed: 0, errors: [error], durationMs };
    }

    ctx.stageResults.set(stage.name, result);
    console.log(
      `[Pipeline] Stage ${stage.name} completed in ${result.durationMs}ms (${result.itemsProcessed} items)`
    );
  }

  return ctx.stageResults;
}
