# Snapshot delivery experiment

`BROWSER_SNAPSHOT_MODE` defaults to `explicit-v1`. The opt-in `inline-v2` candidate
returns a bounded fresh page snapshot with successful browser actions. The Gateway
records the mode before a run starts and preserves it through approval resume;
changing process configuration cannot switch a parked run's strategy. A matching
sidecar image is required. Model selection, completion instructions and browser
coordination remain separate controls. No production default or adoption decision
is implied by deterministic tests.
