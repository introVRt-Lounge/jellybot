#!/usr/bin/env bash
# Create a semver GitHub release when conventional feat/fix commits landed since the last tag.
# Writes created=true|false and tag=vX.Y.Z to GITHUB_OUTPUT when set.
set -euo pipefail

repo="${GITHUB_REPOSITORY:?}"
head_sha="${HEAD_SHA:-$(git rev-parse HEAD)}"
github_output="${GITHUB_OUTPUT:-/dev/null}"

write_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT}"
  fi
}

write_output created false
write_output tag ""

latest_tag="$(gh release list --repo "${repo}" --limit 1 --json tagName --jq '.[0].tagName // empty')"
if [ -z "${latest_tag}" ]; then
  latest_tag="v0.0.0"
fi

if git rev-parse "${latest_tag}" >/dev/null 2>&1; then
  commit_range="${latest_tag}..HEAD"
else
  commit_range="HEAD"
fi

mapfile -t commits < <(git log ${commit_range} --pretty=format:'%s')

has_feat=false
has_fix=false
for msg in "${commits[@]:-}"; do
  if [[ "${msg}" =~ ^feat(\(.+\))?!?: ]]; then
    has_feat=true
  fi
  if [[ "${msg}" =~ ^fix(\(.+\))?!?: ]]; then
    has_fix=true
  fi
done

if [ "${has_feat}" = false ] && [ "${has_fix}" = false ]; then
  echo "No releasable conventional commits since ${latest_tag}."
  exit 0
fi

version="${latest_tag#v}"
major="${version%%.*}"
rest="${version#*.}"
minor="${rest%%.*}"
patch="${rest#*.}"
patch="${patch%%-*}"

if [ "${has_feat}" = true ]; then
  minor=$((minor + 1))
  patch=0
else
  patch=$((patch + 1))
fi

new_tag="v${major}.${minor}.${patch}"

if gh release view "${new_tag}" --repo "${repo}" >/dev/null 2>&1; then
  echo "Release ${new_tag} already exists."
  write_output tag "${new_tag}"
  exit 0
fi

notes="$(git log ${commit_range} --pretty=format:'- %s (%h)' | head -50)"
gh release create "${new_tag}" \
  --repo "${repo}" \
  --target "${head_sha}" \
  --title "${new_tag}" \
  --notes "${notes}"

echo "Created release ${new_tag} at ${head_sha}"
write_output created true
write_output tag "${new_tag}"
