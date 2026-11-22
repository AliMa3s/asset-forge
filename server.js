import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { OUTPUT_DIR, PUBLIC_DIR, publicSettings, resolveApiKey, saveSettings } from "./src/config.js";
import { detectBlender } from "./src/blender.js";
import { FAKE, LlmError, listModels } from "./src/llm.js";
import { addLesson, listLessons, removeLesson, setLessonEnabled } from "./src/lessons.js";
import {
  assetFolder, cancelJob, createJob, deleteJob, getJob, listJobs, loadJobs, refineAsset,
} from "./src/pipeline.js";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const PORT = Number(portArg?.slice(7)) || Number(process.env.PORT) || 4780;
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".fbx": "application/octet-stream",
  ".blend": "application/octet-stream",
  ".py": "text/plain; charset=utf-8",
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveFile(res, root, relative, download) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, { error: "Not found" });
  }
  const headers = {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  };
  if (download) headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"`;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function openFolder(dir) {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [dir], { detached: true, stdio: "ignore" }).unref();
}

async function status() {
  const blender = await detectBlender();
  return { settings: publicSettings(), blender, offlineTest: FAKE };
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
  const method = req.method;
  const body = method === "GET" ? {} : await readBody(req);

  if (parts[0] === "status" && method === "GET") return send(res, 200, await status());

  if (parts[0] === "settings" && method === "POST") {
    saveSettings(body);
    if (body.blenderPath !== undefined) await detectBlender({ refresh: true });
    return send(res, 200, await status());
  }

  if (parts[0] === "models" && method === "GET") return send(res, 200, await listModels(resolveApiKey().key));

  if (parts[0] === "blender" && parts[1] === "detect" && method === "POST") {
    return send(res, 200, await detectBlender({ refresh: true }));
  }

  if (parts[0] === "jobs") {
    if (parts.length === 1 && method === "GET") return send(res, 200, { jobs: listJobs() });
    if (parts.length === 1 && method === "POST") {
      const prompt = String(body.prompt || "").trim();
      if (prompt.length < 3) return send(res, 400, { error: "Describe what you want to build." });
      const count = Math.min(12, Math.max(1, Math.round(Number(body.count) || 1)));
      const style = String(body.style || "Stylised").slice(0, 80);
      return send(res, 200, { job: await createJob({ prompt: prompt.slice(0, 4000), count, style }) });
    }
    const job = getJob(parts[1]);
    if (!job) return send(res, 404, { error: "Job not found" });
    if (parts.length === 2 && method === "GET") return send(res, 200, { job });
    if (parts.length === 2 && method === "DELETE") {
      return deleteJob(job.id) ? send(res, 200, { ok: true }) : send(res, 400, { error: "Stop the job before deleting it." });
    }
    if (parts[2] === "cancel" && method === "POST") return send(res, 200, { ok: cancelJob(job.id) });
    if (parts[2] === "open" && method === "POST") {
      const dir = assetFolder(job.id, body.assetId);
      if (dir && fs.existsSync(dir)) openFolder(dir);
      return send(res, 200, { ok: Boolean(dir) });
    }
    if (parts[2] === "refine" && method === "POST") {
      const request = String(body.request || "").trim();
      if (request.length < 3) return send(res, 400, { error: "Say what should change." });
      return send(res, 200, { job: await refineAsset(job.id, String(body.assetId), request.slice(0, 2000)) });
    }
  }

  if (parts[0] === "lessons") {
    if (parts.length === 1 && method === "GET") return send(res, 200, { lessons: listLessons() });
    if (parts.length === 1 && method === "POST") {
      const lesson = addLesson(String(body.text || ""), body.category || "preference", "you");
      return lesson ? send(res, 200, { lesson }) : send(res, 400, { error: "That lesson is empty or already exists." });
    }
    if (parts.length === 2 && method === "DELETE") return send(res, 200, { ok: removeLesson(parts[1]) });
    if (parts.length === 2 && method === "POST") return send(res, 200, { ok: setLessonEnabled(parts[1], body.enabled) });
  }

  return send(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this computer may talk to the app: it holds an API key and runs scripts.
    const host = (req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: "Forbidden" });
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && !(req.headers["content-type"] || "").startsWith("application/json")) {
        return send(res, 415, { error: "JSON only" });
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(res, 403, { error: "Forbidden" });
      return await api(req, res, url);
    }
    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
    if (url.pathname.startsWith("/files/")) {
      return serveFile(res, OUTPUT_DIR, decodeURIComponent(url.pathname.slice(7)), url.searchParams.has("download"));
    }
    const page = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    return serveFile(res, PUBLIC_DIR, page, false);
  } catch (error) {
    send(res, error instanceof LlmError ? 400 : 500, { error: error.message || "Something went wrong." });
  }
});

loadJobs();
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Asset Forge may already be running: open http://localhost:${PORT}`
      : error.message,
  );
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`Asset Forge is running at ${address}${FAKE ? " (offline test mode)" : ""}`);
  console.log("Keep this window open while you use it. Close it to stop.");
  if (!process.argv.includes("--no-open")) {
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", address]] : process.platform === "darwin" ? ["open", [address]] : ["xdg-open", [address]];
    try {
      spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* the address is printed above */
    }
  }
});
