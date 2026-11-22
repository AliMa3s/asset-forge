import fs from "node:fs";
import path from "node:path";
import { FAKE, OUTPUT_DIR, loadSettings, resolveApiKey } from "./config.js";
import { detectBlender, runHarness } from "./blender.js";
import { CancelledError, LlmError, callModel, parseJson } from "./llm.js";
import { addLesson, lessonsForPrompt } from "./lessons.js";
import {
  CRITIC_SCHEMA, CRITIC_SYSTEM, DIRECTOR_SCHEMA, DIRECTOR_SYSTEM, REFLECT_SCHEMA,
  briefText, modellerSystem, reflectPrompt,
} from "./prompts.js";

const MAX_ERRORS = 5; // failed Blender runs tolerated per asset before giving up
const VIEW_LABELS = {
  "view_front_right.png": "front-right three-quarter view",
  "view_back_left.png": "back-left three-quarter view",
  "view_side.png": "side view",
  "view_top.png": "top view",
};

const jobs = new Map();
const controllers = new Map();

function slug(text, max = 40) {
  return (
    (text || "asset")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "asset"
  );
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jobDir(job) {
  return path.join(OUTPUT_DIR, job.id);
}

function persist(job) {
  try {
    fs.mkdirSync(jobDir(job), { recursive: true });
    fs.writeFileSync(path.join(jobDir(job), "job.json"), JSON.stringify(job, null, 1));
  } catch {
    /* the job keeps running in memory even if the disk write fails */
  }
}

function log(job, asset, text) {
  const entry = { at: new Date().toISOString(), text };
  (asset ? asset.log : job.log).push(entry);
  persist(job);
}

function addUsage(job, reply, context) {
  job.usage.input += reply.usage.input;
  job.usage.output += reply.usage.output;
  job.usage.cacheRead += reply.usage.cacheRead;
  job.usage.cacheWrite += reply.usage.cacheWrite;
  job.usage.calls += 1;
  if (reply.cost === null || reply.cost === undefined) job.costKnown = false;
  else job.cost += reply.cost;
  // Spending cap: once the estimated cost passes it, stop the job and keep what is finished.
  if (job.budget > 0 && job.costKnown && job.cost >= job.budget && !context.signal.aborted) {
    context.overBudget = true;
    context.abort();
  }
}

/** Load finished jobs from disk at startup. Jobs that were running when the app closed are marked as stopped. */
export function loadJobs() {
  let names = [];
  try {
    names = fs.readdirSync(OUTPUT_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, name, "job.json"), "utf8"));
      if (!["done", "failed", "cancelled"].includes(job.status)) {
        job.status = "cancelled";
        job.error = "The app was closed while this job was running.";
        for (const asset of job.assets) {
          if (!["done", "failed"].includes(asset.status)) asset.status = asset.best ? "done" : "failed";
        }
      }
      jobs.set(job.id, job);
    } catch {
      /* not a job folder */
    }
  }
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function cancelJob(id) {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function deleteJob(id) {
  const job = jobs.get(id);
  if (!job || controllers.has(id)) return false;
  const dir = path.resolve(jobDir(job));
  if (dir.startsWith(path.resolve(OUTPUT_DIR) + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
  jobs.delete(id);
  return true;
}

function newAsset(index, brief) {
  return {
    id: `${String(index + 1).padStart(2, "0")}-${slug(brief.name, 30)}`,
    name: brief.name,
    brief,
    status: "queued",
    iterations: [],
    best: null,
    files: {},
    lessons: [],
    error: null,
    log: [],
  };
}

/**
 * Start a job. `refine` continues from an existing asset: { brief, script, request, fromScore }.
 */
export async function createJob({ prompt, count = 1, style = "Stylised", refine = null }) {
  const settings = loadSettings();
  const { key } = resolveApiKey();
  const blender = await detectBlender();
  if (!key && !FAKE) throw new LlmError("Add your Anthropic API key in Settings first.");
  if (!blender.found) throw new LlmError("Blender was not found. Set its location in Settings.");

  const job = {
    id: `${stamp()}-${slug(refine ? refine.brief.name : prompt, 32)}`,
    prompt: refine ? `Refine "${refine.brief.name}": ${refine.request}` : prompt,
    style,
    count: refine ? 1 : count,
    status: "planning",
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    model: settings.model,
    criticModel: settings.criticModel || settings.model,
    blenderVersion: blender.version,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
    cost: 0,
    costKnown: true,
    budget: settings.jobBudget,
    notice: null,
    assets: [],
    log: [],
  };
  jobs.set(job.id, job);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  persist(job);

  const context = {
    apiKey: key,
    settings: { ...settings },
    blenderPath: blender.path,
    signal: controller.signal,
    abort: () => controller.abort(),
    fatal: null,
    overBudget: false,
    system: modellerSystem(blender.version, lessonsForPrompt()),
    refine,
  };
  runJob(job, context).finally(() => controllers.delete(job.id));
  return job;
}

async function runJob(job, context) {
  try {
    if (context.refine) {
      job.assets = [newAsset(0, context.refine.brief)];
    } else {
      log(job, null, "The director is planning the assets.");
      const reply = await callModel({
        role: "director",
        apiKey: context.apiKey,
        model: job.model,
        system: DIRECTOR_SYSTEM,
        messages: [{ role: "user", content: `Request: ${job.prompt}\nNumber of assets: ${job.count}\nStyle: ${job.style}` }],
        maxTokens: 16000,
        schema: DIRECTOR_SCHEMA,
        effort: context.settings.effort,
        signal: context.signal,
      });
      addUsage(job, reply, context);
      const plan = parseJson(reply.text);
      const briefs = (plan?.assets || []).filter((a) => a && a.name && a.description).slice(0, job.count);
      if (!briefs.length) throw new LlmError("The director did not return a usable plan. Try rephrasing the request.");
      job.assets = briefs.map((brief, index) => newAsset(index, brief));
      log(job, null, `Planned ${briefs.length} asset${briefs.length === 1 ? "" : "s"}: ${briefs.map((b) => b.name).join(", ")}.`);
    }
    job.status = "running";
    persist(job);

    // A small worker pool: each worker takes the next queued asset.
    let next = 0;
    const worker = async () => {
      while (next < job.assets.length && !context.signal.aborted) {
        const asset = job.assets[next++];
        try {
          await runAsset(job, asset, context);
        } catch (error) {
          // A key, credit or connection problem will hit every asset, so stop the whole job.
          if (error instanceof LlmError && !context.signal.aborted) {
            context.fatal = error;
            context.abort();
          }
          if (context.signal.aborted) throw new CancelledError("cancelled");
          asset.status = "failed";
          asset.error = error.message || String(error);
          log(job, asset, `Failed: ${asset.error}`);
        }
      }
    };
    const workers = Array.from({ length: Math.min(context.settings.parallel, job.assets.length) }, worker);
    const stopped = (await Promise.allSettled(workers)).find((r) => r.status === "rejected");
    if (stopped) throw stopped.reason;

    const done = job.assets.filter((a) => a.status === "done").length;
    job.status = done ? "done" : "failed";
    if (!done) job.error = job.assets.find((a) => a.error)?.error || "No asset could be built.";
  } catch (error) {
    if (context.fatal) {
      job.status = "failed";
      job.error = context.fatal.message;
    } else if (error instanceof CancelledError || context.signal.aborted) {
      job.status = "cancelled";
      job.error = "Cancelled.";
    } else {
      job.status = "failed";
      job.error = error.message || String(error);
    }
    for (const asset of job.assets) {
      if (!["done", "failed"].includes(asset.status)) {
        if (asset.best) finalize(job, asset);
        else asset.status = "failed";
      }
    }
  }
  if (context.overBudget && !context.fatal) {
    // Stopped by the spending cap: keep every asset that already has a reviewed version.
    const done = job.assets.filter((a) => a.status === "done").length;
    job.notice = `Stopped at the spending cap of $${job.budget.toFixed(2)} (spent about $${job.cost.toFixed(2)}). ${done ? "Assets that already had a reviewed version were kept." : "No asset was finished yet."} You can change the cap in Settings.`;
    job.status = done ? "done" : "failed";
    job.error = done ? null : job.notice;
    for (const asset of job.assets) {
      if (asset.status === "failed" && !asset.error) asset.error = "Stopped by the spending cap before a version was finished.";
    }
  }
  job.finishedAt = new Date().toISOString();
  log(job, null, job.notice || (job.status === "done" ? "Job finished." : `Job ${job.status}: ${job.error}`));
}

function extractCode(text) {
  const blocks = [...(text || "").matchAll(/```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return null;
  return blocks.sort((a, b) => b.length - a.length)[0];
}

function imageBlocks(dir, renders) {
  const blocks = [];
  for (const file of renders) {
    blocks.push({ type: "text", text: `${VIEW_LABELS[file] || file}:` });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: fs.readFileSync(path.join(dir, file)).toString("base64") },
    });
  }
  return blocks;
}

function statsText(result) {
  const s = result.stats;
  const lines = [
    `Measured size (m): width ${s.size[0]}, depth ${s.size[1]}, height ${s.size[2]}. Lowest point z=${s.bounds_min[2]}.`,
    `${s.objects} objects, ${s.faces} faces, ${s.vertices} vertices. Materials: ${s.materials.join(", ") || "none"}.`,
  ];
  if (result.warnings.length) lines.push(`Harness warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}`);
  return lines.join("\n");
}

async function runAsset(job, asset, context) {
  const { settings, signal } = context;
  const assetDir = path.join(jobDir(job), asset.id);
  fs.mkdirSync(assetDir, { recursive: true });

  const extra = context.refine
    ? `This asset already exists and scored ${context.refine.fromScore}/10. Here is its current script:\n\`\`\`python\n${context.refine.script}\n\`\`\`\nThe user asks for these changes:\n${context.refine.request}\n\nKeep everything that is not affected by the request.`
    : "";
  const messages = [{ role: "user", content: briefText(asset.brief, job.style, extra) }];
  let reviewed = 0;
  let errors = 0;
  let previousIssues = [];

  while (reviewed < settings.maxIterations && errors < MAX_ERRORS) {
    if (signal.aborted) throw new CancelledError("cancelled");
    asset.status = "modelling";
    log(job, asset, asset.iterations.length ? "The modeller is revising the script." : "The modeller is writing the first script.");
    const reply = await callModel({
      role: "modeller",
      apiKey: context.apiKey,
      model: job.model,
      system: context.system,
      messages,
      maxTokens: 32000,
      effort: settings.effort,
      signal,
    });
    addUsage(job, reply, context);
    messages.push({ role: "assistant", content: reply.content });

    const code = reply.stopReason === "max_tokens" ? null : extractCode(reply.text);
    if (!code) {
      errors += 1;
      messages.push({
        role: "user",
        content:
          reply.stopReason === "max_tokens"
            ? "Your reply was cut off before the script ended. Write a more compact script (helper functions, loops) and reply again with the complete script in one ```python block."
            : "Your reply contained no ```python block. Reply with the complete script in a single ```python fenced block.",
      });
      log(job, asset, "The reply had no usable script; asking again.");
      continue;
    }

    const n = asset.iterations.length + 1;
    const iterDir = path.join(assetDir, `iter-${n}`);
    fs.mkdirSync(iterDir, { recursive: true });
    const codePath = path.join(iterDir, "script.py");
    fs.writeFileSync(codePath, code);

    asset.status = "rendering";
    log(job, asset, `Attempt ${n}: running the script in Blender.`);
    const result = await runHarness({
      blenderPath: context.blenderPath,
      codePath,
      outDir: iterDir,
      renderSize: settings.renderSize,
      exportFbx: settings.exportFbx,
      timeoutSec: settings.blenderTimeout,
      signal,
    });
    if (result.cancelled) throw new CancelledError("cancelled");
    if (result.harnessFailure) throw new Error(result.error);

    const base = `/files/${job.id}/${asset.id}/iter-${n}`;
    const iteration = {
      n,
      ok: Boolean(result.ok),
      plan: reply.text.split("```")[0].trim().slice(0, 700),
      error: result.ok ? null : result.error,
      stats: result.stats || null,
      warnings: result.warnings || [],
      renders: (result.renders || []).map((file) => `${base}/${file}`),
      files: result.files || {},
      script: `${base}/script.py`,
      score: null,
      summary: null,
      strengths: [],
      issues: [],
    };
    asset.iterations.push(iteration);

    if (!result.ok) {
      errors += 1;
      log(job, asset, `Attempt ${n} failed in Blender: ${result.error}`);
      messages.push({
        role: "user",
        content: `The script failed in Blender ${job.blenderVersion}.\n\nError: ${result.error}\n${result.traceback ? `\nTraceback (last lines):\n${result.traceback}\n` : ""}${result.stdout ? `\nOutput:\n${result.stdout}\n` : ""}\nFix the cause and reply with the complete corrected script.`,
      });
      continue;
    }

    asset.status = "reviewing";
    log(job, asset, `Attempt ${n} rendered. The critic is reviewing it.`);
    const criticReply = await callModel({
      role: "critic",
      apiKey: context.apiKey,
      model: job.criticModel,
      system: CRITIC_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${briefText(asset.brief, job.style, context.refine ? `The user also asked for: ${context.refine.request}` : "").replace("Build this asset.", "The brief:")}\n\n${statsText(result)}${previousIssues.length ? `\n\nIssues from the previous round:\n${previousIssues.map((i) => `- ${i}`).join("\n")}` : ""}\n\nThe renders:` },
            ...imageBlocks(iterDir, result.renders),
          ],
        },
      ],
      maxTokens: 8000,
      schema: CRITIC_SCHEMA,
      effort: settings.effort,
      signal,
    });
    addUsage(job, criticReply, context);
    const review = parseJson(criticReply.text) || {};
    iteration.score = Math.max(1, Math.min(10, Math.round(Number(review.score) || 5)));
    iteration.summary = String(review.summary || "").slice(0, 800);
    iteration.strengths = (review.strengths || []).map(String).slice(0, 6);
    iteration.issues = (review.issues || []).map(String).slice(0, 6);
    previousIssues = iteration.issues;
    reviewed += 1;

    const best = asset.iterations.find((i) => i.n === asset.best);
    if (!best || iteration.score > best.score) asset.best = n;
    log(job, asset, `Attempt ${n} scored ${iteration.score}/10. ${iteration.summary}`);

    if (iteration.score >= settings.acceptScore || reviewed >= settings.maxIterations) break;
    const bestNow = asset.iterations.find((i) => i.n === asset.best);
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `Review of attempt ${n}: ${iteration.score}/10${bestNow.n !== n ? ` (the best so far is attempt ${bestNow.n} with ${bestNow.score}/10, so this round made it worse)` : ""}.\n\n${iteration.summary}\n\nIssues to fix:\n${iteration.issues.map((i) => `- ${i}`).join("\n") || "- (none listed; raise the overall polish)"}\n\nWhat works and should stay:\n${iteration.strengths.map((s) => `- ${s}`).join("\n") || "- (not stated)"}\n\n${statsText(result)}\n\nThe renders of your current script:` },
        ...imageBlocks(iterDir, result.renders),
        { type: "text", text: "Reply with the complete improved script." },
      ],
    });
  }

  if (!asset.best) {
    asset.status = "failed";
    asset.error = asset.iterations.findLast((i) => i.error)?.error || "No script ran successfully.";
    log(job, asset, `Gave up after ${asset.iterations.length} attempts.`);
  } else {
    finalize(job, asset);
  }

  if (settings.learn && asset.iterations.length > 1) {
    await reflect(job, asset, context, messages).catch((error) => {
      if (error instanceof CancelledError) throw error;
      log(job, asset, `Could not write lessons: ${error.message}`);
    });
  }
  persist(job);
}

/** Copy the best attempt's files next to the asset under its own name. */
function finalize(job, asset) {
  const best = asset.iterations.find((i) => i.n === asset.best);
  const assetDir = path.join(jobDir(job), asset.id);
  const fileBase = slug(asset.name, 40);
  asset.files = {};
  for (const [kind, file] of Object.entries(best.files)) {
    const target = `${fileBase}${path.extname(file)}`;
    try {
      fs.copyFileSync(path.join(assetDir, `iter-${best.n}`, file), path.join(assetDir, target));
      asset.files[kind] = `/files/${job.id}/${asset.id}/${target}`;
    } catch {
      /* skip a file that could not be copied */
    }
  }
  asset.status = "done";
  log(job, asset, `Done. Best attempt: ${best.n} (${best.score}/10).`);
}

/** Self-improvement: ask the modeller what it learned and keep it for later runs. */
async function reflect(job, asset, context, messages) {
  const bestScore = asset.iterations.find((i) => i.n === asset.best)?.score ?? "none";
  // The conversation must end on an assistant turn before the question is added.
  const history = messages[messages.length - 1].role === "assistant" ? messages : messages.slice(0, -1);
  const reply = await callModel({
    role: "reflect",
    apiKey: context.apiKey,
    model: job.model,
    system: context.system,
    messages: [...history, { role: "user", content: reflectPrompt(bestScore) }],
    maxTokens: 4000,
    schema: REFLECT_SCHEMA,
    effort: context.settings.effort,
    signal: context.signal,
  });
  addUsage(job, reply, context);
  for (const item of (parseJson(reply.text)?.lessons || []).slice(0, 3)) {
    const lesson = addLesson(String(item.text || ""), item.category, "learned");
    if (lesson) {
      asset.lessons.push(lesson.text);
      log(job, asset, `Learned: ${lesson.text}`);
    }
  }
}

/** Start a new one-asset job that changes an existing asset as the user asks. */
export async function refineAsset(jobId, assetId, request) {
  const job = jobs.get(jobId);
  const asset = job?.assets.find((a) => a.id === assetId);
  if (!asset || !asset.best) throw new LlmError("That asset has no finished version to refine.");
  const best = asset.iterations.find((i) => i.n === asset.best);
  const script = fs.readFileSync(path.join(jobDir(job), asset.id, `iter-${best.n}`, "script.py"), "utf8");
  return createJob({ style: job.style, refine: { brief: asset.brief, script, request, fromScore: best.score } });
}

export function assetFolder(jobId, assetId) {
  const job = jobs.get(jobId);
  const asset = job?.assets.find((a) => a.id === assetId);
  if (!job) return null;
  return asset ? path.join(jobDir(job), asset.id) : jobDir(job);
}
