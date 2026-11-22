// Offline stand-in for the model, used when ASSETFORGE_FAKE=1. It lets the
// whole pipeline (Blender runs, error recovery, review loop, lessons) be tested
// without an API key and without spending credits.

const TABLE = (bevel) => `import bpy, bmesh

def material(name, color, roughness=0.7):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*color, 1.0)
    shader.inputs['Roughness'].default_value = roughness
    return mat

def box(name, size, location, mat, parent):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.parent = parent
    mesh.materials.append(mat)
    bpy.context.scene.collection.objects.link(obj)
    ${bevel ? "mod = obj.modifiers.new('Bevel', 'BEVEL'); mod.width = 0.008; mod.segments = 2" : "pass"}
    return obj

root = bpy.data.objects.new('Test Table', None)
bpy.context.scene.collection.objects.link(root)
wood = material('Oak', (0.36, 0.22, 0.11))
dark = material('Dark Oak', (0.2, 0.12, 0.06))
box('Top', (1.2, 0.7, 0.05), (0, 0, 0.725), wood, root)
for i, (x, y) in enumerate([(-0.52, -0.27), (0.52, -0.27), (-0.52, 0.27), (0.52, 0.27)]):
    box('Leg %d' % i, (0.06, 0.06, 0.705), (x, y, 0.3525), dark, root)
${bevel ? "box('Apron Front', (1.0, 0.03, 0.08), (0, -0.27, 0.66), dark, root)\nbox('Apron Back', (1.0, 0.03, 0.08), (0, 0.27, 0.66), dark, root)" : ""}
`;

const BROKEN = `import bpy
mesh = bpy.data.meshes.new('Top')
mesh.use_auto_smooth = True
`;

let modellerCalls = 0;
let criticCalls = 0;

const usage = { input: 1500, output: 900, cacheRead: 0, cacheWrite: 0 };

function reply(text, model) {
  // A made-up cost per call, so the spending cap can be tested offline.
  return { text, content: [{ type: "text", text }], stopReason: "end_turn", model, usage, cost: 0.5 };
}

export async function fakeCall({ role, model, messages }) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (role === "director") {
    const first = messages[0].content;
    const count = Number(/Number of assets: (\d+)/.exec(typeof first === "string" ? first : "")?.[1] || 1);
    const assets = Array.from({ length: count }, (_, i) => ({
      name: count > 1 ? `Test Table ${i + 1}` : "Test Table",
      description: "A plain oak table with four square legs. Offline test asset.",
      width_m: 1.2, depth_m: 0.7, height_m: 0.75,
      key_features: ["flat rectangular top", "four square legs", "apron under the top"],
      palette: [
        { name: "Oak", hex: "#8a5a2b", use: "top" },
        { name: "Dark Oak", hex: "#553318", use: "legs" },
      ],
      style_notes: "Simple and clean.",
      poly_budget: 800,
    }));
    return reply(JSON.stringify({ assets }), model);
  }
  if (role === "modeller") {
    modellerCalls += 1;
    const turn = messages.filter((m) => m.role === "assistant").length;
    if (turn === 0 && modellerCalls === 1) return reply("Plan: a quick first try.\n```python\n" + BROKEN + "```", model);
    const improved = turn >= 2;
    return reply(`Plan: a table from boxes${improved ? ", now with bevels and an apron" : ""}.\n\`\`\`python\n${TABLE(improved)}\`\`\``, model);
  }
  if (role === "critic") {
    criticCalls += 1;
    const good = criticCalls % 2 === 0;
    return reply(
      JSON.stringify(
        good
          ? { score: 9, summary: "Reads clearly as a table; apron and bevels are in.", strengths: ["Good proportions"], issues: [] }
          : { score: 6, summary: "Recognisable but plain.", strengths: ["Correct size"], issues: ["Edges are perfectly sharp; add a small bevel.", "No apron under the top; add one between the legs."] },
      ),
      model,
    );
  }
  if (role === "reflect") {
    return reply(JSON.stringify({ lessons: [{ category: "craft", text: "Offline test lesson: add an apron and bevels to tables on the first attempt." }] }), model);
  }
  return reply("{}", model);
}
