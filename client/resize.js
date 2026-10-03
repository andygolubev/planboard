export function setupPanelResize(layout, { load, save, onResize }) {
  const stored = load("panelWidths", {});
  const preferred = {
    left: Number.isFinite(stored?.left) ? stored.left : null,
    right: Number.isFinite(stored?.right) ? stored.right : null,
  };
  const handles = [...layout.querySelectorAll("[data-resize-panel]")];
  let widths;
  const min = { left: 140, right: 260 };
  const opposite = side => side === "left" ? "right" : "left";
  const budget = () => Math.max(400, layout.clientWidth - 300 - 12);
  const maximum = side => Math.min(side === "left" ? 480 : 720, budget() - widths[opposite(side)]);

  function apply() {
    const compact = layout.clientWidth <= 1100;
    widths = { left: Math.max(min.left, Math.min(480, preferred.left ?? (compact ? 170 : 210))), right: Math.max(min.right, Math.min(720, preferred.right ?? (compact ? 310 : 360))) };
    let excess = widths.left + widths.right - budget();
    if (excess > 0) {
      const reduction = Math.min(excess, widths.left - min.left);
      widths.left -= reduction;
      excess -= reduction;
      widths.right = Math.max(min.right, widths.right - excess);
    }
    layout.style.setProperty("--contents-width", `${widths.left}px`);
    layout.style.setProperty("--discussion-width", `${widths.right}px`);
    for (const handle of handles) {
      const side = handle.dataset.resizePanel;
      handle.setAttribute("aria-valuemin", min[side]);
      handle.setAttribute("aria-valuemax", maximum(side));
      handle.setAttribute("aria-valuenow", Math.round(widths[side]));
      handle.setAttribute("aria-valuetext", `${Math.round(widths[side])} pixels`);
    }
    onResize();
  }
  function change(side, value) {
    preferred[side] = Math.max(min[side], Math.min(maximum(side), value));
    apply();
  }
  for (const handle of handles) {
    const side = handle.dataset.resizePanel;
    let drag = null;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { x: event.clientX, width: widths[side], previous: preferred[side] };
      handle.setPointerCapture(event.pointerId);
      handle.focus();
      layout.classList.add("resizing-panels");
    });
    handle.addEventListener("pointermove", event => {
      if (!drag) return;
      change(side, drag.width + (event.clientX - drag.x) * (side === "left" ? 1 : -1));
    });
    const end = event => {
      if (!drag) return;
      if (event.type === "pointercancel") { preferred[side] = drag.previous; apply(); }
      drag = null;
      layout.classList.remove("resizing-panels");
      save("panelWidths", preferred);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    handle.addEventListener("keydown", event => {
      const step = event.shiftKey ? 40 : 10;
      let value;
      if (event.key === "ArrowLeft") value = widths[side] + (side === "left" ? -step : step);
      else if (event.key === "ArrowRight") value = widths[side] + (side === "left" ? step : -step);
      else if (event.key === "Home") value = min[side];
      else if (event.key === "End") value = maximum(side);
      else return;
      event.preventDefault();
      event.stopPropagation();
      change(side, value);
      save("panelWidths", preferred);
    });
    handle.addEventListener("dblclick", () => {
      preferred[side] = null;
      apply();
      save("panelWidths", preferred);
    });
  }
  window.addEventListener("resize", apply);
  apply();
}
