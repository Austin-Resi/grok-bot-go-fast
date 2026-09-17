function (action) {
  const e = window.__jevFast?.nodes.get(action.node);
  if (
    !e?.isConnected ||
    e.matches(":disabled") ||
    e.closest("[aria-disabled='true'],[inert]") ||
    !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  ) {
    return null;
  }
  if (action.kind === "fill" && (e.readOnly || e.getAttribute("aria-readonly") === "true")) return null;
  // Same per-line-box probe as snapshot.js: a wrapped inline link's union center
  // is not on the link. Click the first point that actually resolves to it.
  const probe = () => {
    let onScreen = false;
    for (const r of e.getClientRects()) {
      if (r.width <= 0 || r.height <= 0) continue;
      const y = r.y + r.height / 2;
      if (y < 0 || y >= innerHeight) continue;
      for (const f of [0.5, 0.25, 0.75]) {
        const x = r.x + r.width * f;
        if (x < 0 || x >= innerWidth) continue;
        onScreen = true;
        const top = document.elementFromPoint(x, y);
        if (top && e.contains(top)) return { x, y };
      }
    }
    return onScreen ? null : undefined;
  };
  let point = probe();
  // undefined = no line box on screen (offscreen candidate or page moved):
  // bring it to the middle of the viewport, clear of sticky headers, and re-probe.
  if (point === undefined) {
    e.scrollIntoView({ block: "center", inline: "nearest" });
    point = probe();
    if (point === undefined) return null;
  }
  if (!point) return null;
  if (action.kind === "select") {
    if (e.tagName !== "SELECT" || ![...e.options].some((o) => o.value === action.value && !o.disabled && !o.closest("optgroup[disabled]"))) {
      return null;
    }
    e.value = action.value;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { x: point.x, y: point.y, scrolled: scrollY };
}
