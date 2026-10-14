#!/usr/bin/env bash
# Release the tip of main to the stable host in one command (docs/runbooks/stable-release.md):
# tag it as the next patch, wait for the release workflow, then ship.sh --run (install, T2 verify,
# activate).
#
#   scripts/stable/release-main.sh [--version vX.Y.Z] [--commit <sha>] [--no-ship] [--dry-run]
#
# A merge to main runs no ci (to save Actions minutes), so there is nothing to wait for before
# tagging. The release workflow only packages: it builds the base and publishes. T0/T1 and T2 run
# on the target host in `stable.sh verify`, before activation (owner decision 2026-10-13). A tag
# whose workflow fails gets no GitHub release, and the next attempt takes the next patch number.
#
# A commit that already has a release tag on origin is not tagged again: the script resumes with
# that tag, so a run that stopped while waiting or shipping can simply be repeated. A release tag
# that exists only locally (its push failed) is pushed, then resumed.
#
# LOCAL_BASE, npm_config_registry, T2_SCOPE, STABLE_HOST and STABLE_ROOT pass through to ship.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION=""
COMMIT=""
SHIP=1
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --no-ship) SHIP=0; shift ;;
    --dry-run) DRY=1; shift ;;
    *) printf 'usage: %s [--version vX.Y.Z] [--commit <sha>] [--no-ship] [--dry-run]\n' "$0" >&2; exit 2 ;;
  esac
done

die() { printf 'error %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
START=$SECONDS
PHASES=()
phase() { PHASES+=("$(printf '%-10s %4ss' "$1" "$(($SECONDS - $2))")"); }
timings() { [ ${#PHASES[@]} -eq 0 ] || { say "timings"; printf '    %s\n' "${PHASES[@]}" "total      $((SECONDS - START))s"; }; }
trap timings EXIT

# GitHub is unreliable from this office network: retry every network call a few times.
retry() {
  local i
  for i in 1 2 3 4 5; do "$@" && return 0; [ "$i" = 5 ] && return 1; sleep $((i * 3)); done
}

t=$SECONDS
retry git fetch -q origin main --tags || die "could not fetch origin"
COMMIT="$(git rev-parse --verify "${COMMIT:-origin/main}^{commit}")"
git merge-base --is-ancestor "$COMMIT" origin/main || die "$COMMIT is not on origin/main"

# Only a tag on origin counts as released: a local tag whose push failed has no workflow run.
# `ls-remote` lists an annotated tag twice, the second time peeled to its commit (`<tag>^{}`).
REMOTE_REFS="$(retry git ls-remote --tags origin)" || die "could not list tags on origin"
REMOTE_TAGS="$(sed -n 's#.*refs/tags/\(v[0-9.]*\)$#\1#p' <<<"$REMOTE_REFS")"
ON_COMMIT="$(awk -v c="$COMMIT" '$1 == c { sub(/\^\{\}$/, "", $2); print $2 }' <<<"$REMOTE_REFS" |
  sed -n 's#^refs/tags/\(v[0-9.]*\)$#\1#p')"
# shellcheck disable=SC2086 # one argument per tag
EXISTING_TAG="$(node scripts/stable/release-plan.mjs latest $ON_COMMIT || true)"
if [ -z "$EXISTING_TAG" ]; then
  # shellcheck disable=SC2046 # one argument per tag
  LOCAL_TAG="$(node scripts/stable/release-plan.mjs latest $(git tag --points-at "$COMMIT") || true)"
  if [ -n "$LOCAL_TAG" ]; then
    printf '%s\n' $REMOTE_TAGS | grep -qx "$LOCAL_TAG" &&
      die "local tag $LOCAL_TAG is on $COMMIT but origin's $LOCAL_TAG is another commit; delete the local tag"
    [ -z "$VERSION" ] || [ "$VERSION" = "$LOCAL_TAG" ] ||
      die "$COMMIT is already tagged $LOCAL_TAG locally, not $VERSION"
    if [ "$DRY" = 1 ]; then
      say "dry run: $LOCAL_TAG exists only locally; it would be pushed"
      trap - EXIT
      exit 0
    fi
    say "$LOCAL_TAG exists only locally; pushing it"
    retry git push -q origin "refs/tags/$LOCAL_TAG" || die "could not push $LOCAL_TAG"
    EXISTING_TAG="$LOCAL_TAG"
  fi
fi
if [ -n "$EXISTING_TAG" ]; then
  [ -z "$VERSION" ] || [ "$VERSION" = "$EXISTING_TAG" ] ||
    die "$COMMIT is already released as $EXISTING_TAG, not $VERSION"
  VERSION="$EXISTING_TAG"
  say "$COMMIT is already tagged $VERSION; resuming"
else
  # shellcheck disable=SC2086 # one argument per tag
  NEXT="$(node scripts/stable/release-plan.mjs next-version $REMOTE_TAGS)"
  VERSION="${VERSION:-$NEXT}"
  [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad version $VERSION"
  printf '%s\n' $REMOTE_TAGS | grep -qx "$VERSION" && die "$VERSION already exists on origin"
  # The notes cover what landed since the nearest released ancestor, which is not the highest tag
  # when that one sits on another line (a hotfix branch, say).
  PREV=""
  for tag in $(node scripts/stable/release-plan.mjs sorted $REMOTE_TAGS); do
    git merge-base --is-ancestor "$tag" "$COMMIT" 2>/dev/null && { PREV="$tag"; break; }
  done
  [ -n "$PREV" ] || die "no release tag is an ancestor of $COMMIT; tag the first release by hand"
  NOTES="$(git log --first-parent --format='%P%x1f%s%x1f%b%x1e' "$PREV..$COMMIT" |
    node scripts/stable/release-plan.mjs notes "$VERSION")"
  say "tagging $COMMIT as $VERSION (previous $PREV)"
  printf '%s\n' "$NOTES" | sed 's/^/    /'
  if [ "$DRY" = 1 ]; then
    say "dry run: nothing tagged"
    trap - EXIT
    exit 0
  fi
  git tag -a "$VERSION" "$COMMIT" -m "$NOTES"
  retry git push -q origin "refs/tags/$VERSION" || die "could not push $VERSION"
fi
phase tag "$t"

[ "$DRY" = 1 ] && { say "dry run: $VERSION is already tagged; not waiting or shipping"; exit 0; }

t=$SECONDS
say "waiting for the release workflow of $VERSION"
# The longest a successful run can take, from the job timeouts in release.yml: base (60), then
# publish (10): 70 minutes, plus queueing.
# release-workflow.test.mjs keeps this at least 15 minutes above that sum.
WAIT_MINUTES="${RELEASE_WAIT_MINUTES:-120}"
POLLS=$((WAIT_MINUTES * 6)) # every 10 s
ERR="$(mktemp)"
FAILURES=0
RUN=""
for i in $(seq 1 "$POLLS"); do
  if out="$(gh run list --workflow release.yml --branch "$VERSION" --limit 1 \
    --json databaseId,status,conclusion -q '.[0] | "\(.databaseId) \(.status) \(.conclusion)"' 2>"$ERR")"; then
    FAILURES=0
    read -r RUN status conclusion <<<"$out" || true
    if [ "${status:-}" = completed ]; then
      [ "$conclusion" = success ] || die "release workflow run $RUN for $VERSION ended $conclusion"
      break
    fi
  else
    # A network blip passes; an auth or lookup failure does not, so stop rather than wait it out.
    FAILURES=$((FAILURES + 1))
    printf 'gh run list failed: %s\n' "$(cat "$ERR")" >&2
    grep -qiE 'auth|HTTP 40[134]|not found|could not find|could not resolve to' "$ERR" &&
      die "gh cannot see the release workflow; fix that, then rerun scripts/stable/release-main.sh --commit $COMMIT"
    [ "$FAILURES" -lt 6 ] || die "gh run list failed $FAILURES times in a row; rerun scripts/stable/release-main.sh --commit $COMMIT to resume"
  fi
  [ "$i" = "$POLLS" ] && die "the release workflow for $VERSION has not finished after $WAIT_MINUTES minutes; it may still be running (gh run list --workflow release.yml --branch $VERSION). When it passes, rerun scripts/stable/release-main.sh --commit $COMMIT to resume with $VERSION"
  sleep 10
done
rm -f "$ERR"
say "release workflow run $RUN passed"
phase release "$t"

if [ "$SHIP" = 0 ]; then
  say "--no-ship: next, scripts/stable/ship.sh $VERSION --run"
  exit 0
fi
t=$SECONDS
bash scripts/stable/ship.sh "$VERSION" --run
phase ship+run "$t"
say "$VERSION is live"
