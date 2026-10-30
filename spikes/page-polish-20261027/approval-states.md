# Approval visual states

Copy `approval-states.html` to `packages/web/page-audit.html` while running Vite,
then open `/page-audit.html?error=1`. Remove the temporary copy after inspection.
This mounts the real App and styles over the demo Gateway, adds a synthetic
three-request group, and fails the first bounded bot lookup. Retry resolves it.
All non-GET requests are refused by this fixture. Group counts are visual fixture
data, not a claim about Gateway grouping behavior; API behavior is covered by the
approval integration tests. No production service is used.
