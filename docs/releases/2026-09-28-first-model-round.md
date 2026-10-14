# First model round on the trial workspace

2026-09-28, first model round on the trial workspace (`cloud-research`,
`*`, six bots in one thread): all five experts and the chief answered in
about 7 minutes. International sites failed (known), a slow failing
navigation reported a false "Browser control changed" (open), and 3 of 8
answers were published as raw summary JSON (fixed in v0.2.6).
`WORKSPACE_MAX_CONCURRENT_RUNS` was raised from 2 to 5 in `shared/.env`.
