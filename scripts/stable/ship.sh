#!/usr/bin/env bash
# Ship a tagged release from this checkout to the stable host (docs/runbooks/stable-release.md).
#
#   scripts/stable/ship.sh vX.Y.Z [--run]
#
# Checks that the tag is annotated and published, fetches the GitHub release's
# release-manifest.json (written by .github/workflows/release.yml) and checks that it names the
# tag's commit, then streams `git archive <tag>` into releases/<tag>/ on the host.
#
# The host builds the app and egress images itself, offline. The only image it cannot build is
# the workspace base (browser, SDK, tools), and it cannot pull it either: Testbox reaches GHCR
# only through an unreliable proxy. When the host lacks the manifest's base, this workstation
# pulls it from GHCR by digest (needs `docker login ghcr.io` here, e.g.
# `gh auth token | docker login ghcr.io -u <user> --password-stdin` with the read:packages scope),
# checks its image ID, and streams it over ssh with `docker save | docker load`. A host image with
# the same source-derived content tag is also reusable when CI metadata changed its image ID. The
# base changes rarely, so most releases skip this.
#
# With --run it goes on to install, verify (T2) and activate on the host. verify picks the T2
# scope from the tag (smoke for a patch tag, full for vX.Y.0); T2_SCOPE=full|smoke overrides it.
# LOCAL_BASE and npm_config_registry (e.g. https://registry.npmmirror.com) are passed to install.
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${STABLE_HOST:-testbox}"
REMOTE_ROOT="${STABLE_ROOT:-Data/deskmates-stable}" # relative to the remote home
V="${1:-}"
RUN="${2:-}"

die() { printf 'error %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }

[[ "$V" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: $0 vX.Y.Z [--run]"
[ -z "${T2_SCOPE:-}" ] || [ "$T2_SCOPE" = full ] || [ "$T2_SCOPE" = smoke ] ||
  die "T2_SCOPE must be full or smoke, got '$T2_SCOPE'"
[ "$(git cat-file -t "$V" 2>/dev/null)" = "tag" ] || die "$V is not an annotated tag here"
COMMIT="$(git rev-parse "$V^{commit}")"
# GitHub over ssh is unreliable from this office network; retry, then ask the REST API over HTTPS.
remote_tag() {
  local i out
  for i in 1 2 3; do
    out="$(git ls-remote --tags origin "refs/tags/$V" 2>/dev/null | cut -f1)" && [ -n "$out" ] &&
      { echo "$out"; return 0; }
    out="$(gh api "repos/{owner}/{repo}/git/ref/tags/$V" --jq .object.sha 2>/dev/null)" && [ -n "$out" ] &&
      { echo "$out"; return 0; }
    sleep $((i * 10))
  done
  return 1
}
REMOTE_TAG="$(remote_tag)" || die "could not read $V from GitHub (network?)"
[ "$REMOTE_TAG" = "$(git rev-parse "$V")" ] || die "$V is not pushed to origin (or differs there)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "fetching release-manifest.json for $V"
for i in 1 2 3 4 5; do
  gh release download "$V" -p release-manifest.json -D "$TMP" --clobber && break
  [ "$i" = 5 ] && die "no release-manifest.json on the $V release; did the release workflow finish?"
  sleep 5
done
node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const [v, commit] = process.argv.slice(2);
  if (m.schema !== 2) throw new Error(`manifest schema ${m.schema}; this script reads schema 2`);
  if (m.version !== v) throw new Error(`manifest version ${m.version} != ${v}`);
  if (m.revision !== commit) throw new Error(`manifest revision ${m.revision} != ${commit}`);
  const b = m.base ?? {};
  if (!/@sha256:[0-9a-f]{64}$/.test(b.ref ?? "")) throw new Error("base not pinned by digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(b.imageId ?? "")) throw new Error("base has no image ID");
' "$TMP/release-manifest.json" "$V" "$COMMIT"
mget() { node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$TMP/release-manifest.json" "$1"; }
BASE_REF="$(mget m.base.ref)"
BASE_ID="$(mget m.base.imageId)"
BASE_TAG="$(mget m.base.contentTag)"

git archive --format=tar "$V" >"$TMP/source.tar"
SHA="$(shasum -a 256 "$TMP/source.tar" | cut -d' ' -f1)"
DEST="$REMOTE_ROOT/releases/$V"
if ssh "$HOST" "test -f '$DEST/.release/source.sha256'"; then
  [ "$(ssh "$HOST" "cat '$DEST/.release/source.sha256'")" = "$SHA" ] ||
    die "$HOST:$DEST exists with different source; refusing to overwrite a release"
  say "$V already on $HOST with identical source"
else
  say "copying $V ($COMMIT) to $HOST:$DEST"
  ssh "$HOST" "test ! -e '$DEST'" || die "$HOST:$DEST exists without a source receipt; inspect it by hand"
  ssh "$HOST" "mkdir -p '$DEST/.release' && tar -x -C '$DEST'" <"$TMP/source.tar"
  scp -q "$TMP/release-manifest.json" "$HOST:$DEST/release-manifest.json"
  ssh "$HOST" "echo $SHA > '$DEST/.release/source.sha256' && echo $COMMIT > '$DEST/.release/revision'"
fi

if ssh "$HOST" "docker image inspect '$BASE_ID' >/dev/null 2>&1"; then
  say "base $BASE_TAG already on $HOST"
elif REMOTE_BASE_ID="$(ssh "$HOST" "docker image inspect --format '{{.Id}}' '$BASE_TAG'" 2>/dev/null)" &&
  [[ "$REMOTE_BASE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  # The tag is a hash of every workspace-base build input. Build metadata can still give two
  # builds of those inputs different config/image IDs, so prefer the already cached equivalent
  # image and let stable.sh record the actual ID in the release receipt.
  say "base $BASE_TAG already on $HOST as $REMOTE_BASE_ID (same content tag; release workflow ID $BASE_ID)"
elif [ "${LOCAL_BASE:-}" = "1" ]; then
  say "LOCAL_BASE=1: not transferring the base; stable.sh install builds $BASE_TAG on $HOST"
else
  say "base $BASE_TAG is not on $HOST; pulling it here from GHCR"
  for i in 1 2 3 4 5; do
    docker pull --platform linux/amd64 "$BASE_REF" && break
    [ "$i" = 5 ] && die "could not pull $BASE_REF (docker login ghcr.io here?)"
    sleep $((i * 5))
  done
  LOCAL_ID="$(docker image inspect --format '{{.Id}}' "$BASE_REF")"
  [ "$LOCAL_ID" = "$BASE_ID" ] || die "pulled base has ID $LOCAL_ID, manifest says $BASE_ID"
  say "streaming the base to $HOST (docker save | docker load, ~3.4 GB)"
  docker save "$BASE_REF" | ssh "$HOST" "docker load" >/dev/null
  ssh "$HOST" "docker image inspect '$BASE_ID' >/dev/null && docker tag '$BASE_ID' '$BASE_TAG'" ||
    die "the base did not arrive on $HOST as $BASE_ID"
  say "base $BASE_TAG loaded on $HOST"
fi

STABLE="$DEST/scripts/stable/stable.sh"
if [ "$RUN" = "--run" ]; then
  # ssh does not carry the environment: name what install needs. Testbox reaches npm only
  # through a mirror, so npm_config_registry goes along when it is set here.
  REGISTRY=""
  [ -z "${npm_config_registry:-}" ] || REGISTRY="npm_config_registry=$(printf '%q' "$npm_config_registry") "
  ssh "$HOST" "LOCAL_BASE=${LOCAL_BASE:-} ${REGISTRY}bash '$STABLE' install $V && T2_SCOPE=${T2_SCOPE:-} bash '$STABLE' verify $V && bash '$STABLE' activate $V"
else
  echo "next, on $HOST:"
  echo "  bash ~/$STABLE install $V && bash ~/$STABLE verify $V && bash ~/$STABLE activate $V"
fi
