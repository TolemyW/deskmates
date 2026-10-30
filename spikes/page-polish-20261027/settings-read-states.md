# Settings read recovery visual fixture

Copy `settings-read-states.html` into `packages/web/page-audit.html` while Vite is
running. Open `/page-audit.html?area=bot` and choose Settings for the bot app error,
or `/page-audit.html?area=costs` for independent alert/rule errors. Each targeted
GET fails once and Retry uses the ordinary demo data. Every non-GET is refused.
Remove the served copy afterward. This uses the real App and mock Gateway only.

Verified at 390x844 and desktop: bot app section remains visible on failure and
Retry restores selection with unchanged Save disabled; cost alerts and rules
recover independently. Error messages do not masquerade as empty success.
Screenshots: `/private/tmp/bot-apps-error-mobile-20261028.png`,
`/private/tmp/cost-alert-error-mobile-20261028.png`,
`/private/tmp/cost-rules-error-mobile-20261028.png`.
