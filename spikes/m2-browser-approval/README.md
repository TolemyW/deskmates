# Parked approval configured-model check

The runner executes only the existing S01 login and S11 parked/resume cases. Browser snapshot
mode is an explicit experiment input: omission keeps `explicit-v1`; `inline-v2` is selected with
`--snapshot-mode inline-v2`. The manifest records the selected mode, source revision, image and
test hash. Use a fresh output directory because evidence from earlier attempts is retained.

`--image` takes a Docker image ID, never a tag.

```sh
node spikes/m2-browser-approval/run-model.mjs \
  --env /path/to/.env \
  --image "$(docker image inspect --format '{{.Id}}' deskmates/workspace:<tag>)" \
  --snapshot-mode inline-v2 \
  --output spikes/m2-browser-approval/work-inline-<date>
```
