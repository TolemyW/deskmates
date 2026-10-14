// The operator UI's stylesheets, in cascade order. The order of these imports is the order of
// the rules in the bundle:
//   1. `app.css`: layer order, Tailwind, @deskmates/ui, tokens, base and the components every
//      screen shares (with `design-refresh.css` and `resources.css`);
//   2. the app shell's and each feature's own stylesheets (`feature-styles.ts`);
//   3. `typography.css`, last, so the compact type scale still wins over feature styles.
// See packages/web/README.md, "Source layout".

import "../app.css";
import "./feature-styles.js";
import "../typography.css";
