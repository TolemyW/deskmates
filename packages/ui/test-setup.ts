// jsdom has no Web Animations implementation. Real geometry/animation behavior is
// checked in check:tab-layout; this shim only lets React Aria mount its indicator.
if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
// React Aria escapes generated IDs inside selectors. Match the browser for the
// punctuation in those IDs; this is test infrastructure, never application code.
if (typeof window !== "undefined" && !globalThis.CSS?.escape) {
  globalThis.CSS = {
    ...globalThis.CSS,
    escape: (value: string) =>
      value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0)?.toString(16)} `),
  };
}
