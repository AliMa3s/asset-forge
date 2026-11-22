import Anthropic from "@anthropic-ai/sdk";
import { FAKE } from "./config.js";
import { fakeCall } from "./fake.js";

export { FAKE };

// Shown in the model picker when the live list cannot be fetched.
export const KNOWN_MODELS = [
  { id: "claude-fable-5-2", name: "Claude Fable 5.2 (most capable)" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5 (recommended)" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (cheaper)" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5 (cheapest)" },
];

// US dollars per million tokens [input, output]. Used only for the cost estimate in the UI.
const PRICES = {
  "claude-fable-5-2": [8, 40],
  "claude-mythos-5-2": [8, 40],
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
};

// Models that can decline a request through a safety classifier and support
// the server-side fallback, which re-runs a declined request on another model.
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class LlmError extends Error {}
export class CancelledError extends Error {}
/** The model declined one request. Affects that asset only, not the whole job. */
export class RefusalError extends Error {}

const clients = new Map();
function clientFor(apiKey) {
  if (!clients.has(apiKey)) clients.set(apiKey, new Anthropic({ apiKey, maxRetries: 3 }));
  return clients.get(apiKey);
}

/** Dollar estimate for one response's usage, or null when the model's price is unknown. */
export function estimateCost(model, usage) {
  const price = PRICES[model];
  if (!price) return null;
  const [input, output] = price;
  return (
    (usage.input * input + usage.output * output + usage.cacheRead * input * 0.1 + usage.cacheWrite * input * 1.25) /
    1_000_000
  );
}

function friendly(error, model) {
  if (error instanceof Anthropic.APIUserAbortError) return new CancelledError("cancelled");
  if (error instanceof Anthropic.AuthenticationError)
    return new LlmError("The API key was rejected. Check it in Settings.");
  if (error instanceof Anthropic.PermissionDeniedError)
    return new LlmError(`This API key is not allowed to use ${model}. Pick another model in Settings.`);
  if (error instanceof Anthropic.NotFoundError)
    return new LlmError(`The model "${model}" was not found. Pick another model in Settings.`);
  if (error instanceof Anthropic.RateLimitError)
    return new LlmError("The API rate limit was reached. Lower 'assets in parallel' in Settings or try again in a minute.");
  if (error instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(error.message)) return new LlmError("Your API credit balance is too low.");
    return new LlmError(`The API rejected the request: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError)
    return new LlmError("Could not reach the Anthropic API. Check your internet connection.");
  if (error instanceof Anthropic.APIError) return new LlmError(`API error ${error.status ?? ""}: ${error.message}`);
  return error;
}

// Some options are not accepted by every model or account (structured output,
// effort, fallbacks). When a request is rejected as invalid we retry with fewer
// options and remember the level that worked for that model.
const optionLevel = new Map();

function buildParams(level, { model, system, messages, maxTokens, schema, effort }) {
  const params = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
  };
  if (level <= 1) {
    // Cache the conversation so far. Each review round re-sends every earlier
    // script, review and render; cached, those cost about a tenth to re-read.
    params.cache_control = { type: "ephemeral" };
    const outputConfig = {};
    if (effort && effort !== "auto") outputConfig.effort = effort;
    if (schema) outputConfig.format = { type: "json_schema", schema };
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  }
  const beta = level === 0;
  if (beta) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = "default";
  }
  return { params, beta };
}

/**
 * One model call. Returns the text, the raw content blocks (to append to a
 * conversation unchanged), and the token usage.
 */
export async function callModel(request) {
  if (FAKE) return fakeCall(request);
  const { apiKey, model, signal } = request;
  if (!apiKey) throw new LlmError("No API key is set. Add one in Settings.");
  const client = clientFor(apiKey);

  const firstLevel = Math.max(optionLevel.get(model) ?? 0, FALLBACK_MODELS.test(model) ? 0 : 1);
  for (let level = firstLevel; level <= 2; level++) {
    const { params, beta } = buildParams(level, request);
    try {
      const stream = beta
        ? client.beta.messages.stream(params, { signal })
        : client.messages.stream(params, { signal });
      const message = await stream.finalMessage();
      optionLevel.set(model, level);
      if (message.stop_reason === "refusal") {
        throw new RefusalError(`The model declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}`);
      }
      const usage = {
        input: message.usage.input_tokens ?? 0,
        output: message.usage.output_tokens ?? 0,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      };
      return {
        text: message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
        content: message.content,
        stopReason: message.stop_reason,
        model: message.model || model,
        usage,
        cost: estimateCost(message.model || model, usage) ?? estimateCost(model, usage),
      };
    } catch (error) {
      if (error instanceof LlmError || error instanceof RefusalError) throw error;
      // An invalid-request error may be an option this model does not accept:
      // try again with fewer options before giving up.
      const invalid = error instanceof Anthropic.BadRequestError && !/credit balance/i.test(error.message);
      if (!invalid || level === 2) throw friendly(error, model);
    }
  }
  throw new LlmError("The request could not be sent.");
}

/** Parse JSON from a model reply, tolerating code fences and surrounding prose. */
export function parseJson(text) {
  const trimmed = (text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Models this key can use, newest first. Falls back to the built-in list. */
export async function listModels(apiKey) {
  if (FAKE || !apiKey) return { live: false, models: KNOWN_MODELS };
  try {
    const models = [];
    for await (const model of clientFor(apiKey).models.list()) {
      models.push({ id: model.id, name: model.display_name || model.id });
      if (models.length >= 60) break;
    }
    return { live: true, models: models.length ? models : KNOWN_MODELS };
  } catch (error) {
    return { live: false, models: KNOWN_MODELS, error: friendly(error, "").message };
  }
}
