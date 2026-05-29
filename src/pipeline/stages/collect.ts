import type { PipelineContext, PipelineStage, StageResult } from "../runner";

export async function execute(_ctx: PipelineContext): Promise<StageResult> {
  return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
}

export const stage: PipelineStage = {
  name: "collect",
  execute,
};
