// Mermaid's converter supplies a routed polyline. Excalidraw's curve smoothing
// can overshoot those waypoints by hundreds of pixels on long connections,
// sending the arrow through nearby nodes. Keep the route and its bindings intact.
// This function is also embedded in the prebuilt frame by scripts/whiteboard-bundle.js;
// keep it self-contained (no references to module-level variables).
export function normalizeImportedElements(elements) {
  const isGroup = element => element.groupIds?.includes(`subgraph_group_${element.id}`);
  const isNode = element => ["rectangle", "ellipse", "diamond"].includes(element.type)
    && element.boundElements?.some(bound => bound.type === "text") && !isGroup(element);
  const layer = element => isGroup(element) ? 0 : element.type === "arrow" ? 1 : 2;
  const prepared = elements.map(element => {
    let style;
    if (element.type === "arrow") style = { roundness: null, roughness: 0 };
    else if (isNode(element)) style = {
      roughness: 0,
      // The converter drops Mermaid's default fill. Opaque nodes keep long
      // connections behind the box, where they cannot obscure its label.
      ...(!element.backgroundColor || element.backgroundColor === "transparent"
        ? { backgroundColor: "#eeeeee", fillStyle: "solid" } : {}),
    };
    else return element;
    return { ...element, ...style, customData: { ...element.customData, planboardRoutingVersion: 1 } };
  }).sort((a, b) => layer(a) - layer(b));
  // Excalidraw uses fractional indices for stacking. Keep these consistent with
  // the new array order: group backgrounds, connectors, then nodes and labels.
  return prepared.map((element, i) => element.index === elements[i].index ? element : { ...element, index: elements[i].index });
}

function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

function sameElement(a, b) {
  // Excalidraw can update bookkeeping when restoring a scene. Everything else,
  // including geometry, bindings, deletion and user styling, counts as an edit.
  const bookkeeping = new Set(["version", "versionNonce", "updated", "index", "seed"]);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .every(key => bookkeeping.has(key) || sameValue(a[key], b[key]));
}

// Upgrade only untouched imported elements in old scenes. Baselines mark the
// one-time migration, so a user's later choices of curves and fills stay their own.
export function migrateSavedElements(saved) {
  if (!Array.isArray(saved?.baseline?.elements) || !Array.isArray(saved?.scene?.elements)) return saved;
  const baseline = saved.baseline.elements;
  const originals = new Map(baseline.map(element => [element.id, element]));
  const prepared = normalizeImportedElements(baseline);
  const corrected = new Map(prepared
    .filter(element => element.customData?.planboardRoutingVersion && !originals.get(element.id).customData?.planboardRoutingVersion)
    .map(element => [element.id, element]));
  if (!corrected.size) return saved;
  let elements = saved.scene.elements.map(element => {
    const original = originals.get(element.id);
    const correction = corrected.get(element.id);
    if (!correction || !sameElement(element, original)) return element;
    const style = Object.fromEntries(["roundness", "roughness", "backgroundColor", "fillStyle", "customData"]
      .filter(key => Object.hasOwn(correction, key)).map(key => [key, correction[key]]));
    return { ...element, ...style };
  });
  // Reorder only when the imported elements are still in their original order.
  // Added annotations at the end stay on top. Preserve deliberate layer changes
  // or drawings interleaved with the original diagram.
  if (baseline.every((element, i) => elements[i]?.id === element.id)) {
    const byId = new Map(elements.map(element => [element.id, element]));
    elements = [...prepared.map((element, i) => {
      const current = byId.get(element.id);
      return current.index === elements[i].index ? current : { ...current, index: elements[i].index };
    }), ...elements.slice(baseline.length)];
  }
  return {
    ...saved,
    baseline: { ...saved.baseline, elements: prepared },
    scene: {
      ...saved.scene,
      elements,
    },
  };
}
