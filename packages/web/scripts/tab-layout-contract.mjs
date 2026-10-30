/** Serializable browser-side assertions. Scroll strips may overflow internally; controls may not. */
export function inspectTabLayout(root) {
  const failures = [];
  const controls = [...root.querySelectorAll('.gb-tab-item, .gb-choice-item, [role="tab"]')];
  const boxes = [];
  for (const el of controls) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    boxes.push({ el, box });
    const indicator = el.querySelector('[data-slot="tabs-indicator"]');
    if (el.getAttribute("aria-selected") === "true" && indicator) {
      const fill = indicator.getBoundingClientRect();
      if (Math.abs(fill.left - box.left) > 1 || Math.abs(fill.right - box.right) > 1) {
        failures.push({ rule: "selection-background-width", label: el.textContent.trim() });
      }
    }
    const css = getComputedStyle(el);
    const bounds = {
      left: box.left + Number.parseFloat(css.paddingLeft),
      right: box.right - Number.parseFloat(css.paddingRight),
      top: box.top,
      bottom: box.bottom,
    };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        if (
          rect.left < bounds.left - 1 ||
          rect.right > bounds.right + 1 ||
          rect.top < bounds.top - 1 ||
          rect.bottom > bounds.bottom + 1
        ) {
          failures.push({
            rule: "text-inside-padding",
            label: el.textContent.trim(),
            bounds,
            text: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          });
        }
      }
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].box;
      const b = boxes[j].box;
      if (
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
      ) {
        failures.push({
          rule: "overlapping-controls",
          labels: [boxes[i].el.textContent.trim(), boxes[j].el.textContent.trim()],
        });
      }
    }
  }
  if (root.classList.contains("files-toolbar-primary")) {
    const width = root.getBoundingClientRect().width;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const children = [...root.children]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width && r.height);
    const rows = [];
    for (const rect of children) {
      const center = rect.top + rect.height / 2;
      if (!rows.some((y) => Math.abs(y - center) <= 4)) rows.push(center);
    }
    const maxRows = width > 30 * rem ? 1 : width < 24 * rem ? 3 : 2;
    if (rows.length > maxRows)
      failures.push({ rule: "toolbar-row-budget", rows: rows.length, maxRows });
    if (root.scrollWidth > root.clientWidth + 1) failures.push({ rule: "toolbar-overflow" });
    const compact = root.querySelector(".files-kind-compact").getBoundingClientRect().width > 0;
    if (compact !== width <= 66 * rem) failures.push({ rule: "toolbar-collapse-order" });
  }
  const parent = root.parentElement;
  if (parent && root.getBoundingClientRect().width > parent.clientWidth + 1) {
    failures.push({ rule: "strip-outside-container" });
  }
  if (!controls.length) failures.push({ rule: "missing-controls" });
  return failures;
}
