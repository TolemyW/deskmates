/** Measure visible controls themselves, including controls inside nested wrappers. */
export function inspectControlRows() {
  const failures = [];
  for (const root of document.querySelectorAll("[data-control-row]")) {
    const controls = [...root.querySelectorAll("[data-row-control], [data-help-tip]")]
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width && rect.height);
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        const overlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (overlap < Math.min(a.rect.height, b.rect.height) / 2) continue; // wrapped onto another line
        const centerDelta = Math.abs(
          a.rect.top + a.rect.height / 2 - b.rect.top - b.rect.height / 2,
        );
        const labels = [
          a.el.getAttribute("aria-label") || a.el.textContent.trim(),
          b.el.getAttribute("aria-label") || b.el.textContent.trim(),
        ];
        if (centerDelta > 1) failures.push({ rule: "row-center-alignment", labels, centerDelta });
        if (
          !a.el.hasAttribute("data-help-tip") &&
          !b.el.hasAttribute("data-help-tip") &&
          Math.abs(a.rect.height - b.rect.height) > 1
        )
          failures.push({
            rule: "row-equal-height",
            labels,
            heights: [a.rect.height, b.rect.height],
          });
        const left = a.rect.left < b.rect.left ? a.rect : b.rect;
        const right = a.rect.left < b.rect.left ? b.rect : a.rect;
        if (right.left - left.right < Number(root.getAttribute("data-control-gap") || 4) - 1)
          failures.push({ rule: "row-minimum-gap", labels, gap: right.left - left.right });
      }
  }
  return failures;
}
