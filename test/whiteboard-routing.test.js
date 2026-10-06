import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { migrateSavedElements, normalizeImportedElements } from "../client/whiteboard-routing.js";
import { patchWhiteboardBundle } from "../scripts/whiteboard-bundle.js";

// A short vertical exit followed by a long horizontal run caused Excalidraw's
// smoothing to loop backwards across the source node in dense flowcharts.
const arrow = {
  id: "catalog_database", type: "arrow", x: 4200, y: 1000, width: 2800, height: 160,
  points: [[0, 0], [35, 25], [35, 62], [35, 99], [-2750, 160]],
  roundness: { type: 2 }, roughness: 1, strokeStyle: "dashed", strokeColor: "#123456",
  startBinding: { elementId: "catalog", focus: 0, gap: 1 },
  endBinding: { elementId: "database", focus: 0, gap: 4 },
  endArrowhead: "arrow", customData: { label: "keep" },
};
const node = { id: "catalog", type: "rectangle", x: 4000, y: 950, width: 260, height: 78 };
const elements = [arrow, node];
const savedScene = () => ({
  source_hash: "same-source", text_metrics_version: 1,
  scene: { elements: structuredClone(elements), appState: { zoom: { value: 0.5 } }, files: {} },
  baseline: { elements: structuredClone(elements) },
});

test("imported arrows follow their original route without smoothing or jitter", () => {
  const [routed, unchanged] = normalizeImportedElements(elements);
  assert.equal(unchanged, node);
  assert.equal(routed.roundness, null);
  assert.equal(routed.roughness, 0);
  assert.deepEqual(routed, { ...arrow, roundness: null, roughness: 0, customData: { label: "keep", planboardRoutingVersion: 1 } });
  assert.deepEqual(arrow.roundness, { type: 2 }, "input is not mutated");
  assert.deepEqual(normalizeImportedElements([routed]), [routed], "normalization is idempotent");
});

test("saved imports migrate together with their baseline and retain scene state", () => {
  const saved = savedScene();
  saved.scene.elements[0].version = 20;
  const result = migrateSavedElements(saved);
  assert.equal(result.scene.elements[0].roundness, null);
  assert.equal(result.scene.elements[0].version, 20);
  assert.equal(result.baseline.elements[0].roundness, null);
  assert.equal(result.scene.appState, saved.scene.appState);
  assert.equal(result.scene.files, saved.scene.files);
  assert.equal(result.source_hash, saved.source_hash);
  assert.deepEqual(saved.scene.elements[0].roundness, { type: 2 });
  assert.equal(migrateSavedElements(result), result);
});

test("saved arrow edits and annotations survive migration", () => {
  for (const edit of [
    { x: 4250 }, { points: [[0, 0], [100, 50]] }, { roundness: null }, { roughness: 2 },
    { strokeColor: "red" }, { isDeleted: true }, { endBinding: null }, { endArrowhead: "diamond" },
  ]) {
    const saved = savedScene();
    Object.assign(saved.scene.elements[0], edit);
    const annotation = { ...arrow, id: "my-arrow" };
    saved.scene.elements.push(annotation);
    const result = migrateSavedElements(saved);
    assert.deepEqual(result.scene.elements, saved.scene.elements);
    assert.equal(result.baseline.elements[0].customData.planboardRoutingVersion, 1);
    assert.equal(migrateSavedElements(result), result);
  }
});

test("new user curve choices and scenes without a baseline are left alone", () => {
  const saved = migrateSavedElements(savedScene());
  saved.scene.elements[0].roundness = { type: 2 };
  assert.equal(migrateSavedElements(saved), saved);
  assert.equal(migrateSavedElements(null), null);
  const noBaseline = { scene: { elements } };
  assert.equal(migrateSavedElements(noBaseline), noBaseline);
});

test("connectors sit behind opaque labeled nodes, with groups behind both", () => {
  const group = { id: "services", type: "rectangle", index: "a0", groupIds: ["subgraph_group_services"], backgroundColor: "transparent", boundElements: [{ type: "text", id: "group-label" }] };
  const box = { ...node, index: "a1", backgroundColor: "transparent", boundElements: [{ type: "text", id: "label" }] };
  const connection = { ...arrow, index: "a2" };
  const label = { id: "label", type: "text", index: "a3", text: "Catalog", containerId: box.id };
  const input = [group, box, connection, label];
  const output = normalizeImportedElements(input);
  assert.deepEqual(output.map(e => e.id), [group.id, arrow.id, node.id, label.id]);
  assert.deepEqual(output.map(e => e.index), ["a0", "a1", "a2", "a3"]);
  assert.equal(output[0].backgroundColor, "transparent");
  assert.equal(output[2].backgroundColor, "#eeeeee");
  assert.equal(output[2].fillStyle, "solid");
  assert.equal(output[2].roughness, 0);
  assert.equal(output[3], label);
  assert.deepEqual(normalizeImportedElements(output), output);
  assert.equal(normalizeImportedElements([{ ...box, backgroundColor: "#ff0000" }])[0].backgroundColor, "#ff0000");

  const annotation = { id: "my-note", type: "text", text: "Change this" };
  const saved = { baseline: { elements: input }, scene: { elements: [...input, annotation] } };
  const migrated = migrateSavedElements(saved);
  assert.deepEqual(migrated.scene.elements, [...output, annotation]);
  assert.deepEqual(migrated.baseline.elements, output);
  assert.equal(migrateSavedElements(migrated), migrated);

  const layered = { ...saved, scene: { elements: [group, connection, box, label, annotation] } };
  assert.deepEqual(migrateSavedElements(layered).scene.elements.map(e => e.id), layered.scene.elements.map(e => e.id), "keep deliberate layer changes");
  const interleaved = { ...saved, scene: { elements: [group, box, annotation, connection, label] } };
  assert.deepEqual(migrateSavedElements(interleaved).scene.elements.map(e => e.id), interleaved.scene.elements.map(e => e.id), "keep annotations inserted between original elements");
});

test("the bundled conversion hook runs before baseline capture and rejects drift", () => {
  const source = "function convert(i,t){return{elements:i,files:t||{},imageFallback:Wj(i)}}";
  const context = { elements, Wj: () => false };
  vm.runInNewContext(`${patchWhiteboardBundle(source)}; result = convert(elements);`, context);
  assert.equal(context.result.elements[0].roundness, null);
  assert.equal(context.result.elements[0].roughness, 0);
  assert.equal(context.result.elements[0].startBinding, arrow.startBinding);
  assert.throws(() => patchWhiteboardBundle("upgraded bundle"), /Unsupported lavish-axi/);
  assert.throws(() => patchWhiteboardBundle(source + source), /Unsupported lavish-axi/);
  const bundle = fs.readFileSync(new URL("../node_modules/lavish-axi/dist/whiteboard/whiteboard.js", import.meta.url), "utf8");
  assert.ok(patchWhiteboardBundle(bundle).includes("planboardRoutingVersion"));
});
