// index.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// metrics/posthog.ts
var POSTHOG_API_URL = "https://us.i.posthog.com/capture/";
function createPostHogProvider(apiKey) {
  return {
    async track(event, properties) {
      try {
        const payload = {
          api_key: apiKey,
          event,
          properties: {
            distinct_id: "clawguard-anonymous",
            ...properties
          },
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        };
        await fetch(POSTHOG_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
      } catch {
      }
    }
  };
}

// metrics/index.ts
var DEFAULT_CLIENT_ID = "phc_TMvfuYGtZNgdMh9FjvOQgUPs9qRhdx6Gm2WfGfl7mTG";
function createMetricsProvider(config) {
  if (config.enabled === false) {
    return null;
  }
  const clientId = config.clientId?.trim() || DEFAULT_CLIENT_ID;
  return createPostHogProvider(clientId);
}

// resolve-judge.ts
function isOpenClawAgentModel(model) {
  return model.startsWith("openclaw:") || model.startsWith("openclaw/");
}
function resolveJudgeRequest(config) {
  const provider = config.provider?.trim() ?? "";
  const model = config.model?.trim() ?? "";
  const agentId = config.agentId?.trim() ?? "";
  let agentModel = "openclaw:main";
  if (agentId) {
    agentModel = `openclaw/${agentId}`;
  }
  let backendModel;
  if (model && isOpenClawAgentModel(model)) {
    agentModel = model;
  } else if (provider && model) {
    if (model.includes("/")) {
      const firstSegment = model.split("/")[0] ?? "";
      if (firstSegment === provider) {
        throw new Error(
          `ambiguous judge model: provider=${provider} model=${model} (model already looks like provider/model)`
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
        `incomplete judge model ref: model=${model} (need provider/model or set provider)`
      );
    }
  } else if (provider) {
    throw new Error(`incomplete judge model ref: provider=${provider} without model`);
  }
  const request = { agentModel };
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

// index.ts
var PLUGIN_ID = "clawguard";
var PLUGIN_NAME = "ClawGuard";
var LOG_PREFIX = `[${PLUGIN_ID}]`;
var DEFAULT_MAX_CONTEXT_WORDS = 2e3;
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_SECURITY_PROMPT = `You are a security analyst reviewing tool calls. Your job is to catch genuinely malicious actions while allowing normal development work to proceed.

IMPORTANT: Most tool calls are legitimate. Only flag operations that show clear malicious intent or could cause serious harm. Normal software development activities (reading/writing code, running tests, git operations, installing packages, etc.) should almost always pass.

ONLY FLAG AS HIGH/CRITICAL RISK:
- Exfiltrating sensitive data to external servers (not just reading files locally)
- Executing obfuscated or clearly malicious code
- Attempting to compromise system security (backdoors, reverse shells)
- Destructive operations that contradict the user's explicit request
- Agent trying to deceive the user or bypass explicit safety instructions

DO NOT FLAG (these are normal operations):
- Reading/writing files in the project directory
- Running build commands, tests, or development scripts
- Git operations (commit, push, pull, etc.)
- Installing dependencies via npm/pip/etc.
- Reading config files, logs, or documentation
- File operations the user explicitly requested

SESSION CONTEXT:
{SESSION_CONTEXT}

TOOL CALL:
{TOOL_CALL_JSON}

Consider: If the user asked for this action in the session context, it's almost certainly legitimate.

Return ONLY valid JSON (no markdown fences):
{
  "isRisk": true/false,
  "riskLevel": "none" | "low" | "medium" | "high" | "critical",
  "riskType": "string describing the risk or 'none'",
  "reason": "brief explanation"
}`;
function createLogger(baseLogger) {
  return {
    info: (msg) => baseLogger.info(`${LOG_PREFIX} ${msg}`),
    warn: (msg) => baseLogger.warn(`${LOG_PREFIX} ${msg}`),
    error: (msg) => baseLogger.error(`${LOG_PREFIX} ${msg}`),
    debug: (msg) => baseLogger.debug?.(`${LOG_PREFIX} ${msg}`)
  };
}
var DEFAULT_GATEWAY_HOST = "127.0.0.1";
var DEFAULT_GATEWAY_PORT = 18789;
function resolveGatewayUrl(config, apiConfig) {
  const host = config.gatewayHost?.trim() || DEFAULT_GATEWAY_HOST;
  const port = config.gatewayPort ?? apiConfig?.gateway?.port ?? DEFAULT_GATEWAY_PORT;
  return `http://${host}:${port}`;
}
function resolveGatewayAuthToken() {
  return process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_PASSWORD ?? null;
}
async function callGatewayChat(gatewayUrl, authToken, prompt, timeoutMs, judge) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json"
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    if (judge.backendModel) {
      headers["x-openclaw-model"] = judge.backendModel;
    }
    const body = {
      model: judge.agentModel,
      messages: [{ role: "user", content: prompt }],
      stream: false
    };
    if (judge.temperature !== void 0) {
      body.temperature = judge.temperature;
    }
    if (judge.top_p !== void 0) {
      body.top_p = judge.top_p;
    }
    if (judge.max_tokens !== void 0) {
      body.max_tokens = judge.max_tokens;
    }
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Gateway API error (${response.status}): ${errorText}`);
    }
    const data = await response.json();
    if (data.error) {
      throw new Error(`Gateway API error: ${data.error.message}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Gateway API returned empty response");
    }
    return content;
  } finally {
    clearTimeout(timeoutId);
  }
}
function stripCodeFences(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] ?? "").trim() : trimmed;
}
function normalizeWhitespace(text) {
  return text.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}
function extractTextFromContent(content) {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const normalized = normalizeWhitespace(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
function resolveStateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}
function resolveSessionsDir(agentId) {
  const normalizedAgentId = agentId.trim().toLowerCase() || "main";
  return path.join(resolveStateDir(), "agents", normalizedAgentId, "sessions");
}
function parseSessionKey(sessionKey) {
  const parts = sessionKey.split(":").filter(Boolean);
  if (parts[0] === "agent" && parts.length >= 2) {
    return {
      agentId: parts[1] || "main",
      sessionId: parts.length >= 3 ? parts.slice(2).join("-") : void 0
    };
  }
  return { agentId: "main" };
}
function truncateMessagesByWordCount(messages, maxWords) {
  const allText = messages.join("\n");
  const totalWords = allText.split(/\s+/).length;
  if (totalWords <= maxWords) {
    return allText;
  }
  let wordCount = 0;
  let startIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageWords = messages[i].split(/\s+/).length;
    if (wordCount + messageWords > maxWords) break;
    wordCount += messageWords;
    startIndex = i;
  }
  const truncatedMessages = messages.slice(startIndex);
  return `(truncated to last ~${maxWords} words)
${truncatedMessages.join("\n")}`;
}
async function loadSessionContext(sessionKey, agentId, maxWords, log) {
  if (!sessionKey) {
    log.debug("No session key provided");
    return "(no session context available)";
  }
  const parsed = parseSessionKey(sessionKey);
  const resolvedAgentId = agentId || parsed.agentId;
  const sessionsDir = resolveSessionsDir(resolvedAgentId);
  try {
    const files = await fs.readdir(sessionsDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort().reverse();
    if (jsonlFiles.length === 0) {
      log.debug(`No session files found in ${sessionsDir}`);
      return "(no session files found)";
    }
    let targetFile = parsed.sessionId ? jsonlFiles.find(
      (f) => f.includes(parsed.sessionId) || f.startsWith(parsed.sessionId.split("-")[0] || "")
    ) : void 0;
    targetFile = targetFile || jsonlFiles[0];
    const sessionFilePath = path.join(sessionsDir, targetFile);
    log.debug(`Loading session from ${sessionFilePath}`);
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const messages = parseSessionMessages(content);
    if (messages.length === 0) {
      return "(no messages in session)";
    }
    log.debug(`Loaded ${messages.length} messages from session`);
    return truncateMessagesByWordCount(messages, maxWords);
  } catch (err) {
    log.debug(`Failed to load session: ${String(err)}`);
    return `(failed to load session: ${String(err)})`;
  }
}
function parseSessionMessages(content) {
  const lines = content.split("\n");
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const recordObj = record;
    if (recordObj.type !== "message") continue;
    const message = recordObj.message;
    if (!message || typeof message.role !== "string") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = extractTextFromContent(message.content);
    if (!text) continue;
    const label = message.role === "user" ? "User" : "Assistant";
    messages.push(`${label}: ${text}`);
  }
  return messages;
}
function buildSecurityPrompt(template, toolCallJson, sessionContext) {
  return template.replace("{TOOL_CALL_JSON}", toolCallJson).replace("{SESSION_CONTEXT}", sessionContext);
}
function parseSecurityResult(text) {
  const raw = stripCodeFences(text);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed === "object" && parsed !== null && "isRisk" in parsed && typeof parsed.isRisk === "boolean") {
    return parsed;
  }
  return null;
}
async function runSecurityCheck(api, config, toolCallJson, sessionContext, log) {
  const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const promptTemplate = config.securityPrompt?.trim() || DEFAULT_SECURITY_PROMPT;
  const fullPrompt = buildSecurityPrompt(promptTemplate, toolCallJson, sessionContext);
  const gatewayUrl = resolveGatewayUrl(config, api.config);
  const authToken = resolveGatewayAuthToken();
  let judge;
  try {
    judge = resolveJudgeRequest(config);
  } catch (err) {
    log.error(`Invalid judge model config: ${String(err)}`);
    return null;
  }
  try {
    log.debug(
      `Running security check via gateway at ${gatewayUrl} agent=${judge.agentModel} backend=${judge.backendModel ?? "default"}`
    );
    const text = await callGatewayChat(gatewayUrl, authToken, fullPrompt, timeoutMs, judge);
    if (!text) {
      log.warn("Security check LLM returned empty output");
      return null;
    }
    const securityResult = parseSecurityResult(text);
    if (!securityResult) {
      log.warn("Security check response missing required fields or invalid JSON");
      return null;
    }
    return securityResult;
  } catch (err) {
    log.error(`Security check failed: ${String(err)}`);
    return null;
  }
}
function buildToolCallData(toolName, params, sessionKey, agentId) {
  return {
    toolName,
    params,
    sessionKey,
    agentId,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function shouldBlockToolCall(result, blockOnRisk) {
  return blockOnRisk && result.isRisk && ["high", "critical"].includes(result.riskLevel);
}
async function handleToolCall(event, ctx, api, config, options, log, metrics) {
  const { toolName, params } = event;
  const toolCallData = buildToolCallData(toolName, params, ctx.sessionKey, ctx.agentId);
  const toolCallJson = JSON.stringify(toolCallData, null, 2);
  if (options.logToolCalls) {
    log.info(`Tool call: ${toolName}
${toolCallJson}`);
  }
  if (!options.securityCheckEnabled) {
    return void 0;
  }
  const sessionContext = await loadSessionContext(
    ctx.sessionKey,
    ctx.agentId,
    options.maxContextWords,
    log
  );
  const result = await runSecurityCheck(api, config, toolCallJson, sessionContext, log);
  if (!result) {
    return void 0;
  }
  if (metrics) {
    metrics.track("security_check", { isRisk: result.isRisk }).catch(() => {
    });
  }
  if (result.isRisk) {
    log.warn(`Security risk detected: ${result.riskLevel} - ${result.riskType}`);
    log.warn(`Reason: ${result.reason}`);
    if (shouldBlockToolCall(result, options.blockOnRisk)) {
      log.warn(`Blocking tool call: ${toolName}`);
      return {
        block: true,
        blockReason: `Security risk detected (${result.riskLevel}): ${result.reason}`
      };
    }
  } else {
    log.info(`Security check passed: ${result.reason}`);
  }
  return void 0;
}
var clawGuardPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: "Security guard plugin - logs tool calls and uses LLM as a Judge to detect security risks before execution",
  configSchema: {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          description: "Enable or disable the security guard (default: true)"
        },
        logToolCalls: {
          type: "boolean",
          description: "Log full tool call JSON to logger.info (default: true)"
        },
        securityCheckEnabled: {
          type: "boolean",
          description: "Enable LLM-based security risk detection (default: true)"
        },
        securityPrompt: {
          type: "string",
          description: "Custom prompt for security risk detection (optional)"
        },
        blockOnRisk: {
          type: "boolean",
          description: "Block tool calls when security risk is detected (default: true)"
        },
        provider: {
          type: "string",
          description: "Provider id to compose with model for x-openclaw-model override (optional)"
        },
        model: {
          type: "string",
          description: "Judge model: openclaw agent ref, full provider/model, or short id with provider (optional)"
        },
        agentId: {
          type: "string",
          description: "Gateway agent id for body model openclaw/<id> (optional, default main)"
        },
        authProfileId: {
          type: "string",
          description: "Reserved; not used in v1 (gateway owns provider credentials)"
        },
        temperature: {
          type: "number",
          description: "Optional temperature forwarded to gateway chat completions"
        },
        top_p: {
          type: "number",
          description: "Optional top_p forwarded to gateway chat completions"
        },
        max_tokens: {
          type: "number",
          description: "Optional max_tokens forwarded to gateway chat completions"
        },
        maxContextWords: {
          type: "number",
          description: "Maximum words of session context to include (default: 2000)"
        },
        timeoutMs: {
          type: "number",
          description: "Timeout for security check in milliseconds (default: 15000)"
        },
        gatewayHost: {
          type: "string",
          description: "Gateway host for LLM calls (default: 127.0.0.1)"
        },
        gatewayPort: {
          type: "number",
          description: "Gateway port for LLM calls (default: 18789)"
        },
        metricsEnabled: {
          type: "boolean",
          description: "Enable anonymous metrics collection (default: true)"
        },
        metricsClientId: {
          type: "string",
          description: "Metrics client ID (optional, uses default if not provided)"
        }
      }
    }
  },
  register(api) {
    const config = api.pluginConfig ?? {};
    const log = createLogger(api.logger);
    if (config.enabled === false) {
      log.info("Plugin disabled via config");
      return;
    }
    const options = {
      logToolCalls: config.logToolCalls !== false,
      securityCheckEnabled: config.securityCheckEnabled !== false,
      blockOnRisk: config.blockOnRisk !== false,
      maxContextWords: typeof config.maxContextWords === "number" && config.maxContextWords > 0 ? config.maxContextWords : DEFAULT_MAX_CONTEXT_WORDS
    };
    const metrics = createMetricsProvider({
      enabled: config.metricsEnabled !== false,
      clientId: config.metricsClientId ?? ""
    });
    let judgeSummary = "agent=openclaw:main backend=default";
    try {
      const judge = resolveJudgeRequest(config);
      judgeSummary = `agent=${judge.agentModel} backend=${judge.backendModel ?? "default"}`;
    } catch (err) {
      log.error(`Invalid judge model config at register: ${String(err)}`);
    }
    api.on("before_tool_call", async (event, ctx) => {
      return handleToolCall(event, ctx, api, config, options, log, metrics);
    });
    const metricsStatus = metrics ? "enabled" : "disabled";
    log.info(
      `Initialized (logging: ${options.logToolCalls}, security: ${options.securityCheckEnabled}, block: ${options.blockOnRisk}, metrics: ${metricsStatus}, ${judgeSummary})`
    );
  }
};
var index_default = clawGuardPlugin;
export {
  index_default as default
};
