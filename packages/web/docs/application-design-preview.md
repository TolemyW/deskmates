# Application design preview

The operator shell, chat, contacts, tasks and management surfaces share the native
HeroUI theme through `@deskmates/ui`. `design-refresh.css` owns application layout;
reusable interaction remains in the UI package. Chat scroll and composer regions
occupy separate space and retain mention, draft, approval and deep-link behavior.

Run `npm run dev -w @deskmates/web -- --host 127.0.0.1 --port 5198`, then open
`http://127.0.0.1:5198/demo.html#/threads/thr_000s` for the seeded local preview.
This uses the actual App with the existing in-browser mock Gateway. Its records,
including the three sample tasks, reset on reload and never start real bots.

Application typography is centralized in the `--app-text-*` rem tokens in
`app.css` and the scoped control adapters in `typography.css`. The owner requested
a smaller, consistent hierarchy on 2026-10-10: 13px supporting text, 15px body and
controls, 18px section headings, 22px page titles and 24px metrics at the default
root size. Do not add per-screen literal text sizes. Avatar/emoji glyph sizes are
independent of text hierarchy. The component studio keeps native defaults.
