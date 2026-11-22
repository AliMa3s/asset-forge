import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HARNESS_PATH, loadSettings } from "./config.js";

function versionKey(name) {
  return (name.match(/\d+/g) || []).map((n) => n.padStart(4, "0")).join(".");
}

function candidates() {
  const found = [];
  if (process.platform === "win32") {
    const roots = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Blender Foundation"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Blender Foundation"),
    ];
    for (const root of roots) {
      let names = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        continue;
      }
      names.sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
      for (const name of names) found.push(path.join(root, name, "blender.exe"));
    }
    found.push("C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe");
    found.push("C:\\Program Files\\Steam\\steamapps\\common\\Blender\\blender.exe");
  } else if (process.platform === "darwin") {
    found.push("/Applications/Blender.app/Contents/MacOS/Blender");
  } else {
    found.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender");
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) found.push(path.join(dir, process.platform === "win32" ? "blender.exe" : "blender"));
  }
  return found;
}

export function readVersion(blenderPath) {
  return new Promise((resolve) => {
    execFile(blenderPath, ["--version"], { timeout: 30000, windowsHide: true }, (error, stdout) => {
      const match = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(stdout || "");
      resolve(error && !match ? null : match ? match[1] : null);
    });
  });
}

let detected = null;

/** Find Blender: the path from settings if it works, else common install locations. */
export async function detectBlender({ refresh = false } = {}) {
  const configured = loadSettings().blenderPath;
  if (detected && !refresh && detected.configured === configured) return detected;
  const list = configured ? [configured, ...candidates()] : candidates();
  for (const candidate of list) {
    if (!fs.existsSync(candidate)) continue;
    const version = await readVersion(candidate);
    if (version) {
      detected = { found: true, path: candidate, version, configured };
      return detected;
    }
  }
  detected = { found: false, path: "", version: "", configured };
  return detected;
}

/** Run one generated script through the Blender harness and return its result. */
export function runHarness({ blenderPath, codePath, outDir, renderSize, exportFbx, timeoutSec, signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, error: "cancelled", cancelled: true });
    const specPath = path.join(outDir, "spec.json");
    const resultPath = path.join(outDir, "result.json");
    fs.rmSync(resultPath, { force: true });
    fs.writeFileSync(
      specPath,
      JSON.stringify({ code_path: codePath, out_dir: outDir, render_size: renderSize, export_fbx: exportFbx }),
    );
    const child = spawn(
      blenderPath,
      ["--background", "--factory-startup", "--python", HARNESS_PATH, "--", specPath],
      { windowsHide: true },
    );
    let tail = "";
    const keep = (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    let reason = "";
    const timer = setTimeout(() => {
      reason = `Blender did not finish within ${timeoutSec} seconds. The script is probably stuck in a loop or creates far too much geometry.`;
      child.kill();
    }, timeoutSec * 1000);
    const onAbort = () => {
      reason = "cancelled";
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fallbackError) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (reason) return resolve({ ok: false, error: reason, cancelled: reason === "cancelled" });
      try {
        resolve(JSON.parse(fs.readFileSync(resultPath, "utf8")));
      } catch {
        resolve({ ok: false, error: `${fallbackError}\n${tail.slice(-1500)}`, harnessFailure: true });
      }
    };
    child.on("error", (error) => finish(`Could not start Blender: ${error.message}`));
    child.on("close", (code) => finish(`Blender exited (code ${code}) without writing a result.`));
  });
}
