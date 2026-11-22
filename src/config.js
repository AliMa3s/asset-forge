import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Offline test mode (`node server.js --fake`): a scripted stand-in replaces the
// model, and everything is written to .test/ so real settings, lessons and
// output are never touched.
export const FAKE = process.argv.includes("--fake") || process.env.ASSETFORGE_FAKE === "1";
const BASE = FAKE ? path.join(ROOT, ".test") : ROOT;

export const OUTPUT_DIR = path.join(BASE, "output");
export const DATA_DIR = path.join(BASE, "data");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const HARNESS_PATH = path.join(ROOT, "blender", "harness.py");

// Settings (including the API key) live outside the project folder so the key
// is never synced, zipped or committed together with the project.
const SETTINGS_DIR = FAKE
  ? path.join(BASE, "settings")
  : process.env.ASSETFORGE_HOME ||
    path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "AssetForge");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

export const EFFORTS = ["auto", "low", "medium", "high", "xhigh", "max"];

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  criticModel: "",
  effort: "auto",
  blenderPath: "",
  maxIterations: 4,
  acceptScore: 8,
  parallel: 2,
  renderSize: 640,
  blenderTimeout: 240,
  jobBudget: 5, // US dollars per job; 0 switches the cap off
  learn: true,
  exportFbx: true,
};

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    saved = {};
  }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

function clampInt(value, lo, hi, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current };
  if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (patch.clearApiKey) next.apiKey = "";
  if (typeof patch.model === "string" && patch.model.trim()) next.model = patch.model.trim();
  if (typeof patch.criticModel === "string") next.criticModel = patch.criticModel.trim();
  if (EFFORTS.includes(patch.effort)) next.effort = patch.effort;
  if (typeof patch.blenderPath === "string") next.blenderPath = patch.blenderPath.trim().replace(/^"|"$/g, "");
  if (patch.maxIterations !== undefined) next.maxIterations = clampInt(patch.maxIterations, 1, 8, current.maxIterations);
  if (patch.acceptScore !== undefined) next.acceptScore = clampInt(patch.acceptScore, 5, 10, current.acceptScore);
  if (patch.parallel !== undefined) next.parallel = clampInt(patch.parallel, 1, 6, current.parallel);
  if (patch.renderSize !== undefined) next.renderSize = clampInt(patch.renderSize, 384, 1024, current.renderSize);
  if (patch.blenderTimeout !== undefined) next.blenderTimeout = clampInt(patch.blenderTimeout, 60, 900, current.blenderTimeout);
  if (patch.jobBudget !== undefined) {
    const budget = Number(patch.jobBudget);
    if (Number.isFinite(budget)) next.jobBudget = Math.min(1000, Math.max(0, Math.round(budget * 100) / 100));
  }
  if (typeof patch.learn === "boolean") next.learn = patch.learn;
  if (typeof patch.exportFbx === "boolean") next.exportFbx = patch.exportFbx;
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

/** The key to use: the saved one, else the ANTHROPIC_API_KEY environment variable. */
export function resolveApiKey() {
  const saved = loadSettings().apiKey;
  if (saved) return { key: saved, source: "saved" };
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: "environment" };
  return { key: "", source: "none" };
}

/** Settings as shown in the UI. The key itself never leaves the server. */
export function publicSettings() {
  const { apiKey, ...rest } = loadSettings();
  const { key, source } = resolveApiKey();
  return {
    ...rest,
    hasKey: Boolean(key),
    keySource: source,
    keyHint: key ? `…${key.slice(-4)}` : "",
    settingsFile: SETTINGS_FILE,
  };
}
