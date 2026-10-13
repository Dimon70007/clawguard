import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveJudgeRequest } from "./resolve-judge.ts";

describe("resolveJudgeRequest", () => {
  it("defaults to openclaw:main with no override", () => {
    assert.deepEqual(resolveJudgeRequest({}), { agentModel: "openclaw:main" });
  });

  it("uses agentId for body model", () => {
    assert.deepEqual(resolveJudgeRequest({ agentId: "main" }), {
      agentModel: "openclaw/main",
    });
  });

  it("treats openclaw agent refs as body model only", () => {
    assert.deepEqual(resolveJudgeRequest({ model: "openclaw:security-guardian" }), {
      agentModel: "openclaw:security-guardian",
    });
    assert.deepEqual(resolveJudgeRequest({ model: "openclaw/main" }), {
      agentModel: "openclaw/main",
    });
  });

  it("accepts full provider/model backend ref", () => {
    assert.deepEqual(
      resolveJudgeRequest({
        model: "openrouter/nvidia/nemotron-3.5-content-safety:free",
        temperature: 0.01,
        top_p: 0.95,
        max_tokens: 500,
      }),
      {
        agentModel: "openclaw:main",
        backendModel: "openrouter/nvidia/nemotron-3.5-content-safety:free",
        temperature: 0.01,
        top_p: 0.95,
        max_tokens: 500,
      },
    );
  });

  it("composes provider + model", () => {
    assert.deepEqual(
      resolveJudgeRequest({
        provider: "openrouter",
        model: "nvidia/nemotron-3.5-content-safety:free",
      }),
      {
        agentModel: "openclaw:main",
        backendModel: "openrouter/nvidia/nemotron-3.5-content-safety:free",
      },
    );
    assert.deepEqual(
      resolveJudgeRequest({ provider: "openrouter", model: "gpt-oss" }),
      {
        agentModel: "openclaw:main",
        backendModel: "openrouter/gpt-oss",
      },
    );
  });

  it("fails closed on incomplete or ambiguous refs", () => {
    assert.throws(() => resolveJudgeRequest({ provider: "openrouter" }), /without model/);
    assert.throws(
      () => resolveJudgeRequest({ model: "gpt-oss" }),
      /incomplete judge model ref/,
    );
    assert.throws(
      () =>
        resolveJudgeRequest({
          provider: "openrouter",
          model: "openrouter/nvidia/nemotron-3.5-content-safety:free",
        }),
      /ambiguous/,
    );
  });
});
