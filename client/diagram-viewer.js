// A read-only snapshot: viewing and sharing never opens or changes a whiteboard.
function snapshot(svg) {
  const box = svg.viewBox.baseVal;
  if (!box.width || !box.height) throw new Error("This diagram has no image to show yet.");
  const copy = svg.cloneNode(true);
  // Mermaid includes its own SVG styles. Resolve inherited typography too, so HTML
  // labels keep the same appearance when the SVG is opened outside the board.
  const originals = [svg, ...svg.querySelectorAll("*")];
  const copies = [copy, ...copy.querySelectorAll("*")];
  originals.forEach((node, i) => {
    const style = getComputedStyle(node);
    for (const prop of ["font-family", "font-size", "font-weight", "font-style", "line-height", "color", "white-space"]) {
      copies[i].style.setProperty(prop, style.getPropertyValue(prop));
    }
    copies[i].classList.remove("selected", "hover", "has-notes");
  });
  const padding = 24;
  const width = Math.ceil(box.width + padding * 2);
  const height = Math.ceil(box.height + padding * 2);
  const background = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("viewBox", `${box.x - padding} ${box.y - padding} ${width} ${height}`);
  copy.setAttribute("width", width);
  copy.setAttribute("height", height);
  copy.style.maxWidth = "none";
  copy.style.width = `${width}px`;
  copy.style.height = `${height}px`;
  const fill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  fill.setAttribute("x", box.x - padding);
  fill.setAttribute("y", box.y - padding);
  fill.setAttribute("width", width);
  fill.setAttribute("height", height);
  fill.setAttribute("fill", background);
  copy.insertBefore(fill, copy.firstChild);
  const source = new XMLSerializer().serializeToString(copy);
  return { width, height, source, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}` };
}

async function pngBlob(snapshot) {
  const image = new Image();
  image.src = snapshot.url;
  await image.decode();
  // Crisp at normal sizes without exhausting the browser on a very large plan.
  const scale = Math.min(2, 8192 / snapshot.width, 8192 / snapshot.height, Math.sqrt(16_000_000 / (snapshot.width * snapshot.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(snapshot.width * scale));
  canvas.height = Math.max(1, Math.round(snapshot.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is unavailable in this browser. Try Download SVG.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not create the image. Try Download SVG.")), "image/png");
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function createDiagramViewer() {
  const dialog = document.createElement("dialog");
  dialog.className = "diagram-viewer";
  dialog.setAttribute("aria-labelledby", "diagramViewerTitle");
  dialog.innerHTML = `
    <header class="diagram-viewer-header">
      <div class="diagram-viewer-heading"><span>Diagram</span><h2 id="diagramViewerTitle"></h2></div>
      <button type="button" class="viewer-close" aria-label="Close diagram viewer" title="Close (Esc)">×</button>
    </header>
    <div class="diagram-viewer-toolbar">
      <div class="viewer-zoom" role="group" aria-label="Diagram zoom">
        <button type="button" data-action="out" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <output aria-label="Zoom level"></output>
        <button type="button" data-action="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button type="button" data-action="fit" title="Fit the full diagram (0)">Fit</button>
        <button type="button" data-action="actual" title="Original size (1)">100%</button>
      </div>
      <div class="viewer-share" role="group" aria-label="Share diagram">
        <button type="button" data-action="copy">Copy image</button>
        <button type="button" data-action="png">Download PNG</button>
        <button type="button" data-action="svg" title="Download a scalable vector image">Download SVG</button>
      </div>
    </div>
    <div class="diagram-viewport" tabindex="0" role="region" aria-label="Diagram image; drag or scroll to move, plus and minus to zoom">
      <div class="diagram-stage"><img draggable="false"></div>
    </div>
    <footer class="diagram-viewer-footer"><span>Drag to move · + / − to zoom · 0 to fit</span><span class="viewer-status" role="status" aria-live="polite"></span></footer>`;
  document.body.appendChild(dialog);
  const viewport = dialog.querySelector(".diagram-viewport");
  const stage = dialog.querySelector(".diagram-stage");
  const image = stage.querySelector("img");
  const status = dialog.querySelector(".viewer-status");
  const zoomLabel = dialog.querySelector("output");
  const button = action => dialog.querySelector(`[data-action="${action}"]`);
  image.addEventListener("error", () => { status.textContent = "Could not display this diagram. Try Download SVG."; });
  let current = null;
  let scale = 1;
  let fitting = true;
  let drag = null;
  let trigger = null;

  function fitScale() {
    return Math.max(0.01, Math.min(1, (viewport.clientWidth - 48) / current.width, (viewport.clientHeight - 48) / current.height));
  }
  function layout(next, center = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }) {
    const previousWidth = Math.max(viewport.clientWidth, current.width * scale + 48);
    const previousHeight = Math.max(viewport.clientHeight, current.height * scale + 48);
    const x = (viewport.scrollLeft + center.x - (previousWidth - current.width * scale) / 2) / scale;
    const y = (viewport.scrollTop + center.y - (previousHeight - current.height * scale) / 2) / scale;
    scale = Math.max(Math.min(0.1, fitScale()), Math.min(4, next));
    const width = Math.max(viewport.clientWidth, current.width * scale + 48);
    const height = Math.max(viewport.clientHeight, current.height * scale + 48);
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    image.style.width = `${current.width * scale}px`;
    image.style.height = `${current.height * scale}px`;
    viewport.scrollLeft = x * scale + (width - current.width * scale) / 2 - center.x;
    viewport.scrollTop = y * scale + (height - current.height * scale) / 2 - center.y;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    button("out").disabled = scale <= Math.min(0.1, fitScale());
    button("in").disabled = scale >= 4;
  }
  function fit() {
    fitting = true;
    layout(fitScale());
    viewport.scrollTop = viewport.scrollLeft = 0;
  }
  function zoom(next, center) {
    fitting = false;
    layout(next, center);
  }
  function close() { dialog.close(); }
  dialog.querySelector(".viewer-close").addEventListener("click", close);
  dialog.addEventListener("click", event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }
  });
  dialog.addEventListener("close", () => {
    current = null;
    image.removeAttribute("src");
    document.body.classList.remove("diagram-viewer-open");
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    drag = null;
    viewport.classList.remove("dragging");
  });
  dialog.addEventListener("keydown", event => {
    // Keep board shortcuts from acting underneath the modal. Native dialog handles
    // Escape and traps Tab; arrows retain normal scrolling inside the viewport.
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (["+", "=", "-", "0", "1"].includes(event.key)) event.preventDefault();
    if (event.key === "+" || event.key === "=") zoom(scale * 1.25);
    if (event.key === "-") zoom(scale / 1.25);
    if (event.key === "0") fit();
    if (event.key === "1") zoom(1);
  });
  button("out").addEventListener("click", () => zoom(scale / 1.25));
  button("in").addEventListener("click", () => zoom(scale * 1.25));
  button("fit").addEventListener("click", fit);
  button("actual").addEventListener("click", () => zoom(1));
  viewport.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoom(scale * Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    viewport.focus({ preventScroll: true });
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("dragging");
    event.preventDefault();
  });
  viewport.addEventListener("pointermove", event => {
    if (!drag) return;
    viewport.scrollLeft = drag.left + drag.x - event.clientX;
    viewport.scrollTop = drag.top + drag.y - event.clientY;
  });
  viewport.addEventListener("lostpointercapture", () => {
    drag = null;
    viewport.classList.remove("dragging");
  });
  new ResizeObserver(() => {
    if (dialog.open && current) fitting ? fit() : layout(scale);
  }).observe(viewport);

  async function share(kind) {
    const item = current;
    const restoreFocus = document.activeElement === button(kind);
    status.textContent = kind === "copy" ? "Copying…" : "Preparing download…";
    const controls = dialog.querySelectorAll(".viewer-share button");
    controls.forEach(b => b.disabled = true);
    try {
      if (kind === "svg") download(new Blob([item.source], { type: "image/svg+xml" }), `${item.filename}.svg`);
      else {
        const png = pngBlob(item);
        // A denied clipboard request can settle before image conversion finishes.
        // Keep a later conversion failure handled in that case too.
        png.catch(() => {});
        if (kind === "copy") {
          // Pass a promise immediately to preserve Safari's user-gesture permission.
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        } else download(await png, `${item.filename}.png`);
      }
      if (current === item) status.textContent = kind === "copy" ? "Image copied" : "Downloaded";
    } catch (error) {
      if (current === item) status.textContent = kind === "copy" ? "Could not copy here. Use Download PNG or SVG." : `Could not export PNG. Try Download SVG. ${error.message}`;
    } finally {
      if (current === item) {
        controls.forEach(b => b.disabled = b.dataset.action === "copy" && !canCopy());
        if (restoreFocus && (document.activeElement === document.body || document.activeElement === dialog)) button(kind).focus();
      }
    }
  }
  const canCopy = () => Boolean(navigator.clipboard?.write && window.ClipboardItem);
  for (const kind of ["copy", "png", "svg"]) button(kind).addEventListener("click", () => share(kind));

  return {
    open({ svg, diagramId, before = false }) {
      const item = snapshot(svg);
      item.filename = `${diagramId.replace(/[^\p{L}\p{N}._-]+/gu, "-") || "diagram"}${before ? "-before" : ""}`;
      current = item;
      trigger = document.activeElement;
      dialog.querySelector("h2").textContent = `${diagramId}${before ? " · Previous version" : ""}`;
      image.alt = `Diagram: ${diagramId}${before ? " (previous version)" : ""}`;
      image.src = item.url;
      status.textContent = "";
      for (const b of dialog.querySelectorAll(".viewer-share button")) b.disabled = false;
      button("copy").disabled = !canCopy();
      button("copy").title = canCopy() ? "Copy the full diagram as a PNG image" : "Clipboard images need HTTPS or localhost. Download the image instead.";
      dialog.showModal();
      document.body.classList.add("diagram-viewer-open");
      fit();
      viewport.focus({ preventScroll: true });
    },
  };
}
