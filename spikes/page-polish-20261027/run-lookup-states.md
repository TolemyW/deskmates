# Run detail lookup visual states

Copy `run-lookup-states.html` to `packages/web/page-audit.html` while Vite runs.
Open `/page-audit.html`; the real App renders a failed demo run and a one-shot
thread lookup failure. Retry run details resolves that read without changing the
run status. All non-GET requests are refused. Remove the temporary served copy
after inspection. This is a local visual fixture, not production data.
