// Asset Forge UI. Plain JavaScript, no build step.

const main = document.getElementById("main");
const state = {
  status: null,
  models: null,
  job: null,
  jobKey: "",
  jobs: [],
  selected: {}, // per job: { asset, attempt, view }
  timer: null,
  draft: { prompt: "", count: 1, style: "Stylised" },
};

const STYLES = ["Low-poly", "Stylised", "Realistic", "Blocky / voxel", "Cartoon"];
const EXAMPLES = [
  "A medieval market stall with a striped canvas roof",
  "A wooden treasure chest with iron bands",
  "A small sci-fi cargo crate with glowing panels",
  "A street lamp, a park bench and a rubbish bin for a city park",
  "A potted cactus in a terracotta pot",
];
const ACTIVE = ["planning", "running", "queued", "modelling", "rendering", "reviewing"];
const STATUS_TEXT = {
  planning: "Planning", running: "Building", queued: "Waiting", modelling: "Writing script",
  rendering: "Running Blender", reviewing: "Reviewing", done: "Done", failed: "Failed", cancelled: "Stopped",
};

/** Build a DOM element. Text is always set as text, never as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked" || key === "disabled" || key === "selected" || key === "open") el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

let toastTimer;
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3800);
}

function statusChip(status) {
  const cls = ACTIVE.includes(status) ? "active" : status;
  return h("span", { class: `status ${cls}` }, STATUS_TEXT[status] || status);
}

function scoreBadge(score) {
  if (score === null || score === undefined) return null;
  const cls = score >= 8 ? "hi" : score >= 6 ? "mid" : "lo";
  return h("span", { class: `score ${cls}`, title: "Critic's score out of 10" }, `${score}/10`);
}

function money(job) {
  if (!job.usage.calls) return "";
  const tokens = job.usage.input + job.usage.output + job.usage.cacheRead + job.usage.cacheWrite;
  const tokenText = tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`;
  return job.costKnown ? `about $${job.cost.toFixed(job.cost < 1 ? 3 : 2)} · ${tokenText}` : tokenText;
}

function when(iso) {
  return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function bestRender(asset) {
  const pick = asset.iterations.find((i) => i.n === asset.best) || [...asset.iterations].reverse().find((i) => i.renders.length);
  return pick?.renders[0] || null;
}

// ---------- shared status ----------

async function refreshStatus() {
  state.status = await api("/status");
  const { settings, blender } = state.status;
  document.getElementById("side-foot").replaceChildren(
    h("div", {}, h("span", { class: `dot ${settings.hasKey ? "" : "off"}` }), settings.hasKey ? "API key set" : "No API key"),
    h("div", {}, h("span", { class: `dot ${blender.found ? "" : "off"}` }), blender.found ? `Blender ${blender.version}` : "Blender not found"),
    h("div", { title: settings.model, style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, settings.model),
  );
}

function setupBanners() {
  const { settings, blender, offlineTest } = state.status;
  const banners = [];
  if (offlineTest) banners.push(h("div", { class: "banner" }, "Offline test mode: no API calls are made and every asset is a test table."));
  if (!settings.hasKey && !offlineTest) {
    banners.push(h("div", { class: "banner" }, h("span", {}, "Add your Anthropic API key to start building."), h("a", { class: "btn", href: "#/settings" }, "Open Settings")));
  }
  if (!blender.found) {
    banners.push(h("div", { class: "banner bad" }, h("span", {}, "Blender was not found on this computer. Install it from blender.org or set its location."), h("a", { class: "btn", href: "#/settings" }, "Open Settings")));
  }
  return banners;
}

// ---------- Create ----------

function viewCreate() {
  const { settings, blender, offlineTest } = state.status;
  const ready = (settings.hasKey || offlineTest) && blender.found;
  const prompt = h("textarea", {
    id: "prompt", rows: 4, placeholder: "Describe one asset or a whole set…", value: state.draft.prompt,
    oninput: (e) => (state.draft.prompt = e.target.value),
  });
  const count = h("input", {
    id: "count", type: "number", min: 1, max: 12, value: state.draft.count,
    oninput: (e) => (state.draft.count = e.target.value),
  });
  const style = h("select", { id: "style", onchange: (e) => (state.draft.style = e.target.value) },
    STYLES.map((s) => h("option", { value: s, selected: s === state.draft.style }, s)));
  const go = h("button", { class: "primary big", disabled: !ready }, "Build");
  go.addEventListener("click", async () => {
    if (!prompt.value.trim()) return toast("Describe what you want to build first.");
    go.disabled = true;
    go.textContent = "Starting…";
    try {
      const { job } = await api("/jobs", "POST", { prompt: prompt.value, count: Number(count.value), style: style.value });
      state.draft.prompt = "";
      location.hash = `#/job/${job.id}`;
    } catch (error) {
      toast(error.message);
      go.disabled = false;
      go.textContent = "Build";
    }
  });

  main.replaceChildren(
    h("h1", {}, "What do you want to build?"),
    h("p", { class: "lead" }, "Describe it in plain words. A director plans the assets, a modeller builds each one in Blender, and a critic reviews the renders and sends it back until it is good."),
    h("div", { class: "stack" },
      ...setupBanners(),
      h("div", { class: "card stack" },
        h("div", {}, h("label", { for: "prompt" }, "Description"), prompt),
        h("div", { class: "chips" }, EXAMPLES.map((text) => h("button", {
          class: "chip", type: "button",
          onclick: () => { prompt.value = text; state.draft.prompt = text; prompt.focus(); },
        }, text))),
        h("div", { class: "fields" },
          h("div", {}, h("label", { for: "count" }, "Number of assets"), count, h("div", { class: "hint" }, "Up to 12. For a set, the director picks items that fit together.")),
          h("div", {}, h("label", { for: "style" }, "Style"), style),
        ),
        h("div", { class: "row" }, go,
          h("span", { class: "muted small" }, `Model: ${settings.model} · up to ${settings.maxIterations} review rounds per asset · ${settings.jobBudget > 0 ? `stops at $${settings.jobBudget.toFixed(2)}` : "no spending cap"}`)),
      ),
      h("p", { class: "muted small" }, "It is strongest at constructed objects: props, furniture, buildings, vehicles and tools. Characters and animals come out as simple stylised shapes."),
    ),
  );
}

// ---------- Library ----------

async function viewLibrary() {
  state.jobs = (await api("/jobs")).jobs;
  const rows = state.jobs.map((job) => {
    const image = job.assets.map(bestRender).find(Boolean);
    const done = job.assets.filter((a) => a.status === "done").length;
    return h("a", { class: "card job-row", href: `#/job/${job.id}` },
      image ? h("img", { class: "thumb", src: image, alt: "" }) : h("div", { class: "thumb" }),
      h("div", {},
        h("div", { class: "job-title" }, job.prompt),
        h("div", { class: "muted small" }, `${when(job.createdAt)} · ${job.style} · ${done}/${job.assets.length || job.count} assets${money(job) ? ` · ${money(job)}` : ""}`),
      ),
      statusChip(job.status),
    );
  });
  main.replaceChildren(
    h("h1", {}, "Library"),
    h("p", { class: "lead" }, "Everything you have built. Files are kept in the output folder inside the app folder."),
    rows.length ? h("div", { class: "job-list" }, rows) : h("div", { class: "card muted" }, "Nothing here yet. ", h("a", { href: "#/create" }, "Build your first asset.")),
  );
  schedule(state.jobs.some((j) => ACTIVE.includes(j.status)) ? 3000 : 0);
}

// ---------- Job ----------

function selection(job) {
  const sel = (state.selected[job.id] ||= { asset: null, attempt: null, view: 0, followLatest: true });
  if (!job.assets.some((a) => a.id === sel.asset)) sel.asset = job.assets[0]?.id || null;
  return sel;
}

async function loadViewer() {
  if (customElements.get("model-viewer")) return true;
  try {
    await import("https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js");
    return Boolean(customElements.get("model-viewer"));
  } catch {
    return false;
  }
}

function assetDetail(job, asset, sel) {
  const attempts = asset.iterations;
  const shown = attempts.find((i) => i.n === sel.attempt) || attempts.find((i) => i.n === asset.best) || attempts[attempts.length - 1];
  const left = h("div", {});
  const viewer = h("div", { class: "viewer" });
  left.append(viewer);

  const showImage = () => {
    if (!shown || !shown.renders.length) {
      viewer.replaceChildren(h("div", { class: "ph" }, shown?.error ? "This attempt failed in Blender." : ACTIVE.includes(asset.status) ? "Working on the first attempt…" : "No preview"));
    } else {
      viewer.replaceChildren(h("img", { src: shown.renders[Math.min(sel.view, shown.renders.length - 1)], alt: `${asset.name} render` }));
    }
  };
  const show3d = async () => {
    viewer.replaceChildren(h("div", { class: "ph" }, "Loading 3D viewer…"));
    if (!(await loadViewer())) {
      sel.view = 0;
      showImage();
      return toast("The 3D viewer could not be loaded (it needs an internet connection).");
    }
    const src = shown.n === asset.best && asset.files.glb ? asset.files.glb : shown.script.replace("script.py", "asset.glb");
    viewer.replaceChildren(h("model-viewer", { src, "camera-controls": true, "auto-rotate": true, "shadow-intensity": "0.8", exposure: "0.9", alt: `${asset.name} 3D model` }));
  };

  if (shown && shown.renders.length) {
    const names = ["Front", "Back", "Side", "Top"];
    const tabs = shown.renders.map((_, index) => h("button", {
      class: `tab ${sel.view === index ? "on" : ""}`, type: "button",
      onclick: () => { sel.view = index; renderJob(); },
    }, names[index] || `View ${index + 1}`));
    if (shown.files.glb) {
      tabs.push(h("button", { class: `tab ${sel.view === "3d" ? "on" : ""}`, type: "button", onclick: () => { sel.view = "3d"; renderJob(); } }, "3D view"));
    }
    left.append(h("div", { class: "tabs" }, tabs));
  }
  if (sel.view === "3d" && shown?.files.glb) show3d();
  else showImage();

  if (attempts.length > 1 || (attempts.length === 1 && attempts[0].error)) {
    left.append(h("h3", { style: "margin-top:16px" }, "Attempts"), h("div", { class: "attempts" }, attempts.map((i) => h("button", {
      class: `attempt ${shown && shown.n === i.n ? "on" : ""}`, type: "button", title: i.error || i.summary || "",
      onclick: () => { sel.attempt = i.n; sel.followLatest = false; if (sel.view === "3d" && !i.files.glb) sel.view = 0; renderJob(); },
    },
      i.renders.length ? h("img", { src: i.renders[0], alt: "" }) : h("div", { class: "ph" }, "error"),
      h("span", {}, i.score ? `#${i.n} · ${i.score}/10${i.n === asset.best ? " ★" : ""}` : `#${i.n} failed`),
    ))));
  }

  const right = h("div", { class: "stack" });
  right.append(h("div", {},
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, asset.name), statusChip(asset.status), scoreBadge(shown?.score)),
    h("p", { class: "muted", style: "margin-top:6px" }, asset.brief.description),
  ));

  if (asset.status === "done") {
    const links = [["glb", "GLB (Unity, Godot, web)"], ["fbx", "FBX"], ["blend", "Blender file"]]
      .filter(([kind]) => asset.files[kind])
      .map(([kind, label]) => h("a", { class: "btn", href: `${asset.files[kind]}?download` }, `Download ${label}`));
    right.append(h("div", { class: "row" }, links,
      h("button", { type: "button", onclick: () => api(`/jobs/${job.id}/open`, "POST", { assetId: asset.id }).catch((e) => toast(e.message)) }, "Open folder")));
  }
  if (asset.error) right.append(h("div", { class: "error-text" }, asset.error));

  if (shown) {
    if (shown.error) {
      right.append(h("div", {}, h("h3", {}, `Attempt ${shown.n}: error`), h("div", { class: "error-text" }, shown.error)));
    } else if (shown.summary) {
      right.append(h("div", {},
        h("h3", {}, `Critic on attempt ${shown.n}`),
        h("p", {}, shown.summary),
        shown.issues.length ? h("div", {}, h("div", { class: "small muted" }, "To fix"), h("ul", { class: "plain" }, shown.issues.map((t) => h("li", {}, t)))) : null,
        shown.strengths.length ? h("div", { style: "margin-top:8px" }, h("div", { class: "small muted" }, "Works well"), h("ul", { class: "plain" }, shown.strengths.map((t) => h("li", {}, t)))) : null,
      ));
    }
    if (shown.stats) {
      const s = shown.stats;
      right.append(h("div", { class: "small muted" },
        `Size ${s.size[0]} × ${s.size[1]} × ${s.size[2]} m · ${s.faces.toLocaleString()} faces · ${s.objects} parts · ${s.materials.length} materials`,
        shown.warnings.length ? h("ul", { class: "plain", style: "margin-top:4px" }, shown.warnings.map((w) => h("li", {}, w))) : null,
        h("div", {}, h("a", { href: shown.script, target: "_blank", rel: "noopener" }, "View the Blender script")),
      ));
    }
  }

  right.append(h("details", {},
    h("summary", {}, "Brief"),
    h("div", { class: "stack", style: "margin-top:10px;gap:10px" },
      h("ul", { class: "plain" }, asset.brief.key_features.map((f) => h("li", {}, f))),
      h("div", { class: "swatches" }, asset.brief.palette.map((c) => h("span", { class: "swatch", title: c.use }, h("i", { style: `background:${/^#[0-9a-f]{3,8}$/i.test(c.hex) ? c.hex : "transparent"}` }), c.name))),
      h("div", { class: "small muted" }, `${asset.brief.width_m} × ${asset.brief.depth_m} × ${asset.brief.height_m} m · about ${asset.brief.poly_budget} triangles · ${asset.brief.style_notes}`),
    )));

  if (asset.lessons.length) {
    right.append(h("div", {}, h("h3", {}, "Learned from this asset"), h("ul", { class: "plain small" }, asset.lessons.map((t) => h("li", {}, t)))));
  }

  if (asset.status === "done") {
    const input = h("textarea", { id: "refine-input", rows: 2, placeholder: "e.g. make the roof red and add a lantern on the left post" });
    const button = h("button", { class: "primary", type: "button" }, "Refine");
    button.addEventListener("click", async () => {
      if (!input.value.trim()) return toast("Say what should change.");
      button.disabled = true;
      try {
        const { job: next } = await api(`/jobs/${job.id}/refine`, "POST", { assetId: asset.id, request: input.value });
        location.hash = `#/job/${next.id}`;
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
    right.append(h("div", {}, h("label", { for: "refine-input" }, "Change something"), input,
      h("div", { class: "row", style: "margin-top:8px" }, button, h("span", { class: "hint" }, "Starts a new job from this version."))));
  }

  if (asset.log.length) {
    right.append(h("details", {}, h("summary", {}, "Activity"),
      h("div", { class: "log", style: "margin-top:8px" }, asset.log.map((l) => `${new Date(l.at).toLocaleTimeString()}  ${l.text}`).join("\n"))));
  }
  return h("div", { class: "card detail" }, left, right);
}

function renderJob() {
  const job = state.job;
  if (!job) return;
  const sel = selection(job);
  const active = ACTIVE.includes(job.status);
  const keep = document.getElementById("refine-input");
  const kept = keep ? { value: keep.value, focused: document.activeElement === keep, start: keep.selectionStart } : null;

  const header = h("div", { class: "stack", style: "gap:8px" },
    h("div", { class: "row" }, h("a", { href: "#/library", class: "small" }, "← Library")),
    h("div", { class: "row" }, h("h1", { class: "grow", style: "margin:0" }, job.prompt), statusChip(job.status)),
    h("div", { class: "muted small" }, [when(job.createdAt), job.style, job.model, `Blender ${job.blenderVersion}`, money(job)].filter(Boolean).join(" · ")),
    h("div", { class: "row" },
      active ? h("button", { class: "danger", type: "button", onclick: async () => { await api(`/jobs/${job.id}/cancel`, "POST"); toast("Stopping…"); } }, "Stop") : null,
      h("button", { type: "button", onclick: () => api(`/jobs/${job.id}/open`, "POST", {}).catch((e) => toast(e.message)) }, "Open folder"),
      !active ? h("button", { class: "danger", type: "button", onclick: async () => {
        if (!confirm("Delete this job and all its files? This cannot be undone.")) return;
        try { await api(`/jobs/${job.id}`, "DELETE"); location.hash = "#/library"; } catch (error) { toast(error.message); }
      } }, "Delete") : null,
    ),
  );

  const blocks = [header];
  if (job.notice && job.status === "done") blocks.push(h("div", { class: "banner" }, job.notice));
  if (job.error && job.status !== "done") blocks.push(h("div", { class: `banner ${job.status === "cancelled" ? "" : "bad"}` }, job.error));
  if (job.status === "planning") blocks.push(h("div", { class: "card muted" }, "The director is planning the assets…"));

  if (job.assets.length > 1) {
    blocks.push(h("div", { class: "asset-grid" }, job.assets.map((asset) => {
      const image = bestRender(asset);
      const best = asset.iterations.find((i) => i.n === asset.best);
      return h("button", {
        class: `card asset-card ${asset.id === sel.asset ? "selected" : ""}`, type: "button",
        onclick: () => { sel.asset = asset.id; sel.attempt = null; sel.view = 0; renderJob(); },
      },
        image ? h("img", { src: image, alt: "" }) : h("div", { class: "ph" }, STATUS_TEXT[asset.status] || asset.status),
        h("div", { class: "asset-meta" }, h("div", { class: "asset-name" }, asset.name), h("div", { class: "row" }, statusChip(asset.status), scoreBadge(best?.score))),
      );
    })));
  }
  const asset = job.assets.find((a) => a.id === sel.asset);
  if (asset) blocks.push(assetDetail(job, asset, sel));

  main.replaceChildren(h("div", { class: "stack" }, blocks));
  if (kept) {
    const input = document.getElementById("refine-input");
    if (input) {
      input.value = kept.value;
      if (kept.focused) { input.focus(); input.setSelectionRange(kept.start, kept.start); }
    }
  }
}

async function viewJob(id, { quiet = false } = {}) {
  let job;
  try {
    job = (await api(`/jobs/${id}`)).job;
  } catch (error) {
    main.replaceChildren(h("div", { class: "card" }, error.message, " ", h("a", { href: "#/library" }, "Back to the library")));
    return;
  }
  const key = JSON.stringify(job);
  const changed = key !== state.jobKey || state.job?.id !== id;
  state.job = job;
  state.jobKey = key;
  // While an asset is being built, keep showing its newest attempt unless the user picked one.
  const sel = selection(job);
  if (sel.followLatest && ACTIVE.includes(job.status)) sel.attempt = null;
  if (changed || !quiet) renderJob();
  schedule(ACTIVE.includes(job.status) ? 1500 : 0);
}

// ---------- Lessons ----------

async function viewLessons() {
  const { lessons } = await api("/lessons");
  const input = h("textarea", { id: "lesson-input", rows: 2, placeholder: "e.g. I prefer chunky proportions and warm colours" });
  const add = h("button", { class: "primary", type: "button" }, "Add");
  add.addEventListener("click", async () => {
    try {
      await api("/lessons", "POST", { text: input.value, category: "preference" });
      viewLessons();
    } catch (error) {
      toast(error.message);
    }
  });
  const sourceText = { starter: "Built in", learned: "Learned from a run", you: "From you" };
  const rows = [...lessons].reverse().map((lesson) => h("div", { class: "lesson" },
    h("input", {
      type: "checkbox", checked: lesson.enabled, "aria-label": "Use this lesson",
      onchange: (e) => api(`/lessons/${lesson.id}`, "POST", { enabled: e.target.checked }).catch((err) => toast(err.message)),
    }),
    h("div", {}, h("div", {}, lesson.text), h("div", { class: "tag", style: "margin-top:4px" }, `${lesson.category} · ${sourceText[lesson.source] || lesson.source}`)),
    h("button", { class: "danger", type: "button", onclick: async () => { await api(`/lessons/${lesson.id}`, "DELETE"); viewLessons(); } }, "Delete"),
  ));
  main.replaceChildren(
    h("h1", {}, "Lessons"),
    h("p", { class: "lead" }, "This is how the app improves itself. After each asset the modeller writes down what would have saved it a round, and those lessons are given to every later run. Untick or delete any you disagree with, or add your own preferences."),
    h("div", { class: "stack" },
      h("div", { class: "card" }, h("label", { for: "lesson-input" }, "Teach it something"), input, h("div", { class: "row", style: "margin-top:8px" }, add)),
      h("div", { class: "card" }, rows.length ? rows : h("span", { class: "muted" }, "No lessons yet.")),
    ),
  );
}

// ---------- Settings ----------

async function viewSettings() {
  await refreshStatus();
  const { settings, blender } = state.status;
  if (!state.models) state.models = await api("/models").catch(() => ({ live: false, models: [] }));
  const models = state.models.models;
  const modelOptions = (current, withSame) => {
    const ids = models.map((m) => m.id);
    const options = [];
    if (withSame) options.push(h("option", { value: "", selected: !current }, "Same as the builder"));
    for (const m of models) options.push(h("option", { value: m.id, selected: m.id === current }, m.name === m.id ? m.id : `${m.name} (${m.id})`));
    if (current && !ids.includes(current)) options.push(h("option", { value: current, selected: true }, current));
    return options;
  };

  const key = h("input", { id: "key", type: "password", autocomplete: "off", placeholder: settings.hasKey ? `Saved (${settings.keyHint}). Paste a new key to replace it.` : "sk-ant-…" });
  const model = h("select", { id: "model" }, modelOptions(settings.model, false));
  const custom = h("input", { id: "custom", type: "text", placeholder: "Optional: any other model ID" });
  const critic = h("select", { id: "critic" }, modelOptions(settings.criticModel, true));
  const effort = h("select", { id: "effort" }, [["auto", "Automatic (model default)"], ["low", "Low (fastest, cheapest)"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Maximum"]]
    .map(([value, label]) => h("option", { value, selected: value === settings.effort }, label)));
  const blenderPath = h("input", { id: "blender", type: "text", value: settings.blenderPath, placeholder: blender.found ? blender.path : "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe" });
  const number = (id, value, min, max) => h("input", { id, type: "number", min, max, value });
  const iterations = number("iterations", settings.maxIterations, 1, 8);
  const accept = number("accept", settings.acceptScore, 5, 10);
  const parallel = number("parallel", settings.parallel, 1, 6);
  const renderSize = number("render", settings.renderSize, 384, 1024);
  const budget = h("input", { id: "budget", type: "number", min: 0, max: 1000, step: 0.5, value: settings.jobBudget });
  const learn = h("input", { id: "learn", type: "checkbox", checked: settings.learn });
  const fbx = h("input", { id: "fbx", type: "checkbox", checked: settings.exportFbx });

  const save = async (extra = {}) => {
    const body = {
      apiKey: key.value,
      model: custom.value.trim() || model.value,
      criticModel: critic.value,
      effort: effort.value,
      blenderPath: blenderPath.value,
      maxIterations: Number(iterations.value),
      acceptScore: Number(accept.value),
      parallel: Number(parallel.value),
      renderSize: Number(renderSize.value),
      jobBudget: Number(budget.value),
      learn: learn.checked,
      exportFbx: fbx.checked,
      ...extra,
    };
    try {
      await api("/settings", "POST", body);
      if (body.apiKey || body.clearApiKey) state.models = null;
      toast("Settings saved.");
      viewSettings();
    } catch (error) {
      toast(error.message);
    }
  };

  const keyState = settings.hasKey
    ? h("div", { class: "banner good" }, settings.keySource === "environment" ? "Using the key from the ANTHROPIC_API_KEY environment variable." : `A key is saved (ends in ${settings.keyHint.slice(1)}).`,
        state.models.live ? h("span", {}, "Checked: it works.") : state.models.error ? h("span", {}, `Check failed: ${state.models.error}`) : null)
    : h("div", { class: "banner" }, "No key yet. Create one at console.anthropic.com under API Keys, then paste it here.");

  main.replaceChildren(
    h("h1", {}, "Settings"),
    h("p", { class: "lead" }, "Set this up once. Your key is stored only on this computer and is sent only to Anthropic."),
    h("div", { class: "stack" },
      h("div", { class: "card stack" },
        h("h2", {}, "Anthropic API key"),
        keyState,
        h("div", {}, h("label", { for: "key" }, "API key"), key, h("div", { class: "hint" }, `Saved in ${settings.settingsFile}, outside the app folder.`)),
        settings.keySource === "saved" ? h("div", {}, h("button", { class: "danger", type: "button", onclick: () => confirm("Remove the saved API key?") && save({ clearApiKey: true, apiKey: "" }) }, "Remove saved key")) : null,
      ),
      h("div", { class: "card stack" },
        h("h2", {}, "Models"),
        h("div", { class: "fields" },
          h("div", {}, h("label", { for: "model" }, "Builder model"), model, h("div", { class: "hint" }, "Plans the assets and writes the Blender scripts. Stronger models give better assets and cost more.")),
          h("div", {}, h("label", { for: "critic" }, "Critic model"), critic, h("div", { class: "hint" }, "Looks at the renders and scores them.")),
          h("div", {}, h("label", { for: "custom" }, "Custom builder model"), custom, h("div", { class: "hint" }, state.models.live ? "The lists above come from your account." : "Use this if your model is not in the list.")),
          h("div", {}, h("label", { for: "effort" }, "Thinking effort"), effort, h("div", { class: "hint" }, "Higher is slower and costs more. Automatic is a good start.")),
        ),
      ),
      h("div", { class: "card stack" },
        h("h2", {}, "Blender"),
        blender.found ? h("div", { class: "banner good" }, `Found Blender ${blender.version} at ${blender.path}`) : h("div", { class: "banner bad" }, "Blender was not found. Install it from blender.org, or paste the full path to blender.exe below."),
        h("div", {}, h("label", { for: "blender" }, "Blender location"), blenderPath, h("div", { class: "hint" }, "Leave empty to find it automatically.")),
      ),
      h("div", { class: "card stack" },
        h("h2", {}, "Quality and cost"),
        h("div", { class: "fields" },
          h("div", {}, h("label", { for: "budget" }, "Spending cap per job (US$)"), budget, h("div", { class: "hint" }, "The job stops once its estimated cost passes this, and keeps what is finished. 0 means no cap. It cannot cap models whose price the app does not know.")),
          h("div", {}, h("label", { for: "iterations" }, "Review rounds per asset"), iterations, h("div", { class: "hint" }, "Maximum build, review, improve rounds. More rounds, better assets, higher cost.")),
          h("div", {}, h("label", { for: "accept" }, "Accept at score"), accept, h("div", { class: "hint" }, "Stop improving once the critic gives at least this score out of 10.")),
          h("div", {}, h("label", { for: "parallel" }, "Assets in parallel"), parallel, h("div", { class: "hint" }, "How many assets are built at the same time.")),
          h("div", {}, h("label", { for: "render" }, "Preview size (pixels)"), renderSize, h("div", { class: "hint" }, "Larger previews show the critic more detail and cost more.")),
        ),
        h("label", { class: "check" }, learn, h("span", {}, "Learn from each run", h("div", { class: "hint" }, "After each asset, keep up to three lessons for later runs. See the Lessons page."))),
        h("label", { class: "check" }, fbx, h("span", {}, "Also export FBX", h("div", { class: "hint" }, "GLB and a Blender file are always saved."))),
      ),
      h("div", { class: "row" }, h("button", { class: "primary big", type: "button", onclick: () => save() }, "Save settings")),
    ),
  );
}

// ---------- routing ----------

function schedule(ms) {
  clearTimeout(state.timer);
  if (ms) state.timer = setTimeout(() => route({ quiet: true }), ms);
}

async function route({ quiet = false } = {}) {
  clearTimeout(state.timer);
  const [, name = "create", id] = location.hash.split("/");
  for (const link of document.querySelectorAll(".nav")) {
    link.classList.toggle("active", link.dataset.route === name || (name === "job" && link.dataset.route === "library"));
  }
  try {
    if (!state.status || !quiet) await refreshStatus();
    if (name === "job" && id) await viewJob(decodeURIComponent(id), { quiet });
    else if (quiet && name !== "library") return;
    else if (name === "library") await viewLibrary();
    else if (name === "lessons") await viewLessons();
    else if (name === "settings") await viewSettings();
    else viewCreate();
    if (!quiet) window.scrollTo(0, 0);
  } catch (error) {
    if (quiet) return schedule(4000);
    main.replaceChildren(h("div", { class: "banner bad" }, `Could not reach the app: ${error.message}. Is the Asset Forge window still open?`));
  }
}

window.addEventListener("hashchange", () => route());
route();
