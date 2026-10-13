/**
 * Resolve ClawGuard judge routing for OpenClaw Gateway chat completions.
 *
 * Body `model` selects the agent surface (`openclaw:main` / `openclaw/<id>`).
 * Optional `x-openclaw-model` backend override uses a provider/model ref.
 */

export type JudgeConfig = {
  provider?: string;
  model?: string;
  agentId?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
};

export type JudgeRequest = {
  agentModel: string;
  backendModel?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
};

export function isOpenClawAgentModel(model: string): boolean {
  return model.startsWith("openclaw:") || model.startsWith("openclaw/");
}

/**
 * Fail closed on incomplete/ambiguous judge model config.
 *
 * @param config Plugin judge-related fields
 * @returns Gateway body model + optional backend override header value
 */
export function resolveJudgeRequest(config: JudgeConfig): JudgeRequest {
  const provider = config.provider?.trim() ?? "";
  const model = config.model?.trim() ?? "";
  const agentId = config.agentId?.trim() ?? "";

  let agentModel = "openclaw:main";
  if (agentId) {
    agentModel = `openclaw/${agentId}`;
  }

  let backendModel: string | undefined;

  if (model && isOpenClawAgentModel(model)) {
    agentModel = model;
  } else if (provider && model) {
    if (model.includes("/")) {
      const firstSegment = model.split("/")[0] ?? "";
      if (firstSegment === provider) {
        throw new Error(
          `ambiguous judge model: provider=${provider} model=${model} (model already looks like provider/model)`,
        );
      }
      backendModel = `${provider}/${model}`;
    } else {
      backendModel = `${provider}/${model}`;
    }
  } else if (model) {
    if (model.includes("/")) {
      backendModel = model;
    } else {
      throw new Error(
        `incomplete judge model ref: model=${model} (need provider/model or set provider)`,
      );
    }
  } else if (provider) {
    throw new Error(`incomplete judge model ref: provider=${provider} without model`);
  }

  const request: JudgeRequest = { agentModel };
  if (backendModel) {
    request.backendModel = backendModel;
  }
  if (typeof config.temperature === "number") {
    request.temperature = config.temperature;
  }
  if (typeof config.top_p === "number") {
    request.top_p = config.top_p;
  }
  if (typeof config.max_tokens === "number") {
    request.max_tokens = config.max_tokens;
  }
  return request;
}
