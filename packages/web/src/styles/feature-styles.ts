// Every stylesheet the app shell (`src/app/*.css`) and the features
// (`src/features/<name>/*.css`) own, discovered by path: a new feature adds its own file and
// nothing here. Vite sorts glob matches by path, so the bundle order is stable: shell first, then
// features alphabetically. Vite hoists these imports above any other import in this module, which
// is why `app.css` is imported by `index.ts`, before this module.

import.meta.glob("../app/*.css", { eager: true });
import.meta.glob("../features/*/*.css", { eager: true });
