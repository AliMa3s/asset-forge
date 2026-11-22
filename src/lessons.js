import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

// The self-improvement memory. Lessons are short rules distilled from past
// errors, critiques and user feedback; they are added to the modeller's
// instructions on every later run.

const FILE = path.join(DATA_DIR, "lessons.json");
const MAX_IN_PROMPT = 30;

const SEED = [
  ["technical", "mesh.use_auto_smooth and mesh.auto_smooth_angle no longer exist. For smooth shading set polygon.use_smooth = True on the faces that should be smooth, and keep hard edges crisp with a Bevel or Edge Split modifier."],
  ["technical", "Find the shader node by type, not by name: next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'). Node names differ between versions and languages."],
  ["technical", "Principled BSDF input names: use 'Specular IOR Level', 'Emission Color', 'Emission Strength', 'Transmission Weight', 'Subsurface Weight', 'Coat Weight'. The old names 'Specular', 'Emission', 'Transmission', 'Subsurface' and 'Clearcoat' raise KeyError."],
  ["technical", "Build geometry with bmesh and bpy.data (meshes.new, objects.new, collection.objects.link) at its final size. bpy.ops operators depend on the active object and mode and are the most common cause of errors in background mode."],
  ["craft", "Non-uniform object scale distorts Bevel modifiers. Give parts their size in the mesh data (bmesh.ops.scale / vertex coordinates) and leave object scale at 1."],
];

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    cache = SEED.map(([category, text]) => make(text, category, "starter"));
    persist();
  }
  return cache;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

function make(text, category, source) {
  return {
    id: crypto.randomBytes(5).toString("hex"),
    text: text.trim().replace(/\s+/g, " ").slice(0, 400),
    category: category === "craft" || category === "preference" ? category : "technical",
    source,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

export function listLessons() {
  return load();
}

export function addLesson(text, category, source) {
  const clean = (text || "").trim();
  if (clean.length < 8) return null;
  const lessons = load();
  const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (lessons.some((l) => l.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key)) return null;
  const lesson = make(clean, category, source);
  lessons.push(lesson);
  persist();
  return lesson;
}

export function removeLesson(id) {
  const lessons = load();
  const index = lessons.findIndex((l) => l.id === id);
  if (index < 0) return false;
  lessons.splice(index, 1);
  persist();
  return true;
}

export function setLessonEnabled(id, enabled) {
  const lesson = load().find((l) => l.id === id);
  if (!lesson) return false;
  lesson.enabled = Boolean(enabled);
  persist();
  return true;
}

/** The lessons block for the modeller's instructions. User preferences come first; newest lessons win when there are too many. */
export function lessonsForPrompt() {
  const active = load().filter((l) => l.enabled);
  const preferences = active.filter((l) => l.category === "preference");
  const others = active.filter((l) => l.category !== "preference");
  const chosen = [...preferences, ...others.slice(-Math.max(0, MAX_IN_PROMPT - preferences.length))].slice(0, MAX_IN_PROMPT);
  if (!chosen.length) return "(none yet)";
  return chosen.map((l) => `- [${l.category}] ${l.text}`).join("\n");
}
