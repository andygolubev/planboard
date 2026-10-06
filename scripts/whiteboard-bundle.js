import { normalizeImportedElements } from "../client/whiteboard-routing.js";

// lavish-axi ships only a prebuilt frame, with no public conversion hook. Patch
// its conversion result before scene restoration and baseline capture. Never
// patch Excalidraw's renderer: arrows drawn by the user should keep their style.
// The dependency is pinned; fail loudly if an upgrade changes this integration.
export function patchWhiteboardBundle(bundle) {
  const result = "return{elements:i,files:t||{},imageFallback:Wj(i)}";
  if (bundle.split(result).length !== 2) {
    throw new Error("Unsupported lavish-axi whiteboard bundle: update the Planboard arrow-routing integration before upgrading.");
  }
  return bundle.replace(result, () => `return{elements:(${normalizeImportedElements.toString()})(i),files:t||{},imageFallback:Wj(i)}`);
}
