# Model transport observations

The proxy records `phase_timing` log samples for request lifetime, response headers,
first body byte and response-body consumption, attributed to the attempt captured
when the request starts. Token-count requests are distinguished from messages.
Bodies and headers are never copied into timing data; transport remains streaming.
First body byte is not first generated token, and request duration includes network,
upstream work and downstream consumption. Nested spans must not be added together.
Timing-recorder failures do not fail model requests.

Each new run records `phaseTimingVersion`. Embedding/evaluation hosts can provide
non-secret `strategyEvidence` versions and hashes through Gateway configuration;
these are copied into the run snapshot and do not alter the model prompt themselves.
