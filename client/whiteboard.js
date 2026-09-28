// Host side of lavish-axi's Excalidraw whiteboard frame. The frame (bundled by
// lavish, served from /whiteboard-assets/) converts the mermaid source to a scene,
// lets the user draw, autosaves through us, and on "Queue feedback" hands back a
// PNG plus a list of edits; we turn that into a queued note on the diagram.
//
// Messages (frame → host, all with `type: "lavish-whiteboard:<name>"`):
//   ready           the frame booted; answer with `init`
//   save            autosave: {sourceHash, textMetricsVersion, scene, baseline, flushId?}
//   queueFeedback   {note, summaryLines, stats, pngDataUrl, scene, sourceHash, imageFallback}
//   teardownReady / teardownFailed   answer to our `prepareTeardown` when closing
// Host → frame: init, saveResult, queueResult, prepareTeardown, sourceChanged.

export function createWhiteboardHost({ overlay, frame, titleEl, errorEl, closeBtn, api, onQueued, onClosed }) {
  let current = null; // { diagramId, source, sourceHash, channelId, ready }
  let closing = null;

  const theme = () => (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  function post(message) {
    if (!current || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ ...message, channelId: current.channelId, diagramIndex: 0 }, "*");
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  }

  function open({ diagramId, source, sourceHash }) {
    if (current) finishClose();
    current = {
      diagramId,
      source,
      sourceHash,
      channelId: `pb-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
      ready: false,
    };
    titleEl.textContent = `Whiteboard · ${diagramId}`;
    showError("");
    overlay.hidden = false;
    document.body.classList.add("wb-open");
    frame.src = `/whiteboard-frame?diagramIndex=0&diagramId=${encodeURIComponent(diagramId)}&t=${Date.now()}`;
  }

  async function handleReady() {
    if (!current || current.ready) return;
    const me = current;
    let saved = null;
    try {
      const r = await api("GET", `/whiteboard/${encodeURIComponent(me.diagramId)}`);
      saved = r.whiteboard || null;
      if (typeof r.source === "string") {
        me.source = r.source;
      }
    } catch (err) {
      showError(`Could not load the saved whiteboard: ${err.message}`);
    }
    if (current !== me) return;
    me.ready = true;
    post({
      type: "lavish-whiteboard:init",
      mode: "overlay",
      diagramIndex: 0,
      diagramId: me.diagramId,
      source: me.source,
      sourceHash: me.sourceHash,
      saved,
      theme: theme(),
    });
  }

  async function handleSave(msg) {
    if (!current) return;
    const me = current;
    let ok = true;
    let error = "";
    try {
      await api("PUT", `/whiteboard/${encodeURIComponent(me.diagramId)}`, {
        sourceHash: msg.sourceHash,
        textMetricsVersion: msg.textMetricsVersion,
        scene: msg.scene,
        baseline: msg.baseline,
      });
    } catch (err) {
      ok = false;
      error = err.message;
    }
    if (current === me && msg.flushId) post({ type: "lavish-whiteboard:saveResult", flushId: msg.flushId, ok, error });
  }

  async function handleQueue(msg) {
    if (!current) return;
    const me = current;
    try {
      const r = await api("POST", `/whiteboard/${encodeURIComponent(me.diagramId)}/feedback`, {
        note: msg.note,
        summaryLines: msg.summaryLines,
        stats: msg.stats,
        pngDataUrl: msg.pngDataUrl,
        scene: msg.scene,
        sourceHash: msg.sourceHash,
        imageFallback: msg.imageFallback,
      });
      if (current !== me) return;
      post({ type: "lavish-whiteboard:queueResult", ok: true });
      onQueued && onQueued(r.note, me.diagramId);
      setTimeout(() => {
        if (current === me) close();
      }, 900);
    } catch (err) {
      if (current === me) post({ type: "lavish-whiteboard:queueResult", ok: false, error: err.message });
    }
  }

  function finishClose() {
    const was = current;
    current = null;
    closing = null;
    overlay.hidden = true;
    document.body.classList.remove("wb-open");
    frame.src = "about:blank";
    showError("");
    if (was && onClosed) onClosed(was.diagramId);
  }

  // Ask the frame to flush its autosave first; give up after 1.5 s.
  function close() {
    if (!current || closing) return;
    if (!current.ready) return finishClose();
    const flushId = `close-${Date.now()}`;
    closing = { flushId, timer: setTimeout(finishClose, 1500) };
    post({ type: "lavish-whiteboard:prepareTeardown", flushId });
  }

  window.addEventListener("message", (event) => {
    if (!current || event.source !== frame.contentWindow) return;
    const msg = event.data || {};
    const type = String(msg.type || "");
    if (!type.startsWith("lavish-whiteboard:")) return;
    if (type === "lavish-whiteboard:ready") return void handleReady();
    if (msg.channelId !== current.channelId) return;
    switch (type) {
      case "lavish-whiteboard:save":
        return void handleSave(msg);
      case "lavish-whiteboard:queueFeedback":
        return void handleQueue(msg);
      case "lavish-whiteboard:close":
        return close();
      case "lavish-whiteboard:teardownReady":
      case "lavish-whiteboard:teardownFailed":
        if (closing && msg.flushId === closing.flushId) {
          clearTimeout(closing.timer);
          finishClose();
        }
        return;
      default:
        return;
    }
  });

  closeBtn.addEventListener("click", () => close());
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  // The plan changed underneath an open whiteboard: tell the frame (it shows a banner).
  function sourceChanged(diagramId, source, sourceHash) {
    if (!current || current.diagramId !== diagramId || !current.ready) return;
    current.source = source;
    current.sourceHash = sourceHash;
    post({ type: "lavish-whiteboard:sourceChanged", source, sourceHash });
  }

  return { open, close, sourceChanged, isOpen: () => Boolean(current) };
}
