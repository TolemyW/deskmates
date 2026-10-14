# Stable `DEFAULT_MODEL` change

2026-10-08, **stable `DEFAULT_MODEL` changed** from `glm-5.3` to
`deepseek-v4.1-flash` at 20:48 Asia/Shanghai, owner decision after the
[model comparison](../design/model-compare-results-2026-10-08.md).
`shared/.env` backed up as `.env.bak-20261008T124645Z-before-default-model`;
only that line differs; SHA-256 now
`6a1d020d41e0a7cd42054c936dee531616112ab2c42ddd2a1f7d5695a470af4d`
(was `ecf00c12…`), mode 0600, secrets key unchanged. `CHEAP_MODEL` stays
`glm5.3-flash`. Zero active or parked runs at restart; the unit came back
active and `GET /api/config` reports the new default. All six existing
bots carry their own `deepseek-v4.1-flash` override for `model` and
`cheapModel`, so the default affects only bots created from now on. Live
release still v0.3.0; v0.3.1 and v0.3.2 remain installed and unactivated.
