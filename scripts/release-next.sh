#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/release-next.sh [patch|minor|major|version] [commit message]

Examples:
  scripts/release-next.sh
  scripts/release-next.sh patch "Fix BVT crash NumberFormatException"
  scripts/release-next.sh patch-beta.1 "Bumping with beta suffix"
  scripts/release-next.sh v0.1.1-rc.1 "Explicitly setting release tag"
  BRANCH=main REMOTE=origin scripts/release-next.sh minor "Prepare next release"

Environment:
  BRANCH   Branch to push. Defaults to current branch, or main if detached.
  REMOTE   Git remote to push. Defaults to origin.
  PREFIX   Tag prefix. Defaults to v.

This script stages all repo changes, commits them if needed, creates the next
semantic version tag, pushes the branch, then pushes the tag to trigger the
GitHub Actions release workflow.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BUMP="${1:-patch}"

# Check if BUMP is a direct version string (e.g. 1.2.3 or v1.2.3, optionally with suffix)
if [[ "$BUMP" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+.*$ ]]; then
  BUMP_TYPE="custom"
  NEXT_VERSION="${BUMP#v}"
  NEXT_TAG="${PREFIX:-v}${NEXT_VERSION}"
else
  # Parse bump type and optional suffix (e.g., patch-beta.1)
  if [[ "$BUMP" =~ ^(patch|minor|major)(.*)$ ]]; then
    BUMP_TYPE="${BASH_REMATCH[1]}"
    SUFFIX="${BASH_REMATCH[2]}"
  else
    echo "ERROR: bump must be patch, minor, major (with optional suffix like patch-beta.1), or a custom semver version (like v0.1.1-beta.1)" >&2
    usage >&2
    exit 1
  fi
fi

DEFAULT_MESSAGE="Release next version"
COMMIT_MESSAGE="${2:-$DEFAULT_MESSAGE}"
REMOTE="${REMOTE:-origin}"
PREFIX="${PREFIX:-v}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $REPO_ROOT is not a git repository" >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current || true)"
BRANCH="${BRANCH:-${CURRENT_BRANCH:-main}}"

echo "[release] Repo   : $REPO_ROOT"
echo "[release] Remote : $REMOTE"
echo "[release] Branch : $BRANCH"
echo "[release] Bump   : $BUMP"

git fetch "$REMOTE" --tags

# Get the latest tag matching v* (to support suffixes)
LATEST_TAG="$(git tag --list "${PREFIX}[0-9]*" --sort=-v:refname | head -n 1 || true)"
if [[ -z "$LATEST_TAG" ]]; then
  LATEST_TAG="${PREFIX}0.0.0"
fi

if [[ "$BUMP_TYPE" != "custom" ]]; then
  VERSION="${LATEST_TAG#"$PREFIX"}"
  # Strip any suffix from the latest version to parse the base major.minor.patch
  BASE_VERSION="${VERSION%%-*}"
  BASE_VERSION="${BASE_VERSION%%+*}"
  IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"

  case "$BUMP_TYPE" in
    major)
      MAJOR=$((MAJOR + 1))
      MINOR=0
      PATCH=0
      ;;
    minor)
      MINOR=$((MINOR + 1))
      PATCH=0
      ;;
    patch)
      PATCH=$((PATCH + 1))
      ;;
  esac
  NEXT_VERSION="${MAJOR}.${MINOR}.${PATCH}${SUFFIX}"
  NEXT_TAG="${PREFIX}${NEXT_VERSION}"
fi

if git rev-parse -q --verify "refs/tags/$NEXT_TAG" >/dev/null; then
  echo "ERROR: tag already exists: $NEXT_TAG" >&2
  exit 1
fi

echo "[release] Latest tag: $LATEST_TAG"
echo "[release] Next tag  : $NEXT_TAG"

# Update version in package.json and tauri.conf.json
echo "[release] Updating package.json and tauri.conf.json to $NEXT_VERSION..."

npm --no-git-tag-version version "$NEXT_VERSION" || true

if [ -f "src-tauri/tauri.conf.json" ]; then
  # Update version and set targets to msi, deb, rpm
  jq --arg v "$NEXT_VERSION" '.version = $v | .bundle.targets = ["msi", "deb", "rpm"]' src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp
  mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json
fi

# Update version in Cargo.toml
if [ -f "src-tauri/Cargo.toml" ]; then
  echo "[release] Updating src-tauri/Cargo.toml to $NEXT_VERSION..."
  sed -i 's/^version = ".*"/version = "'"$NEXT_VERSION"'"/' src-tauri/Cargo.toml
fi

# Ensure .github workflow args are consistent
if [ -f ".github/workflows/release.yml" ]; then
  sed -i 's/--bundles deb,rpm,appimage/--bundles deb,rpm/g' .github/workflows/release.yml
  sed -i 's/--bundles nsis,msi/--bundles msi/g' .github/workflows/release.yml
fi

git add -A

if git diff --cached --quiet; then
  echo "[release] No staged changes; tagging current HEAD."
else
  git commit -m "$COMMIT_MESSAGE"
fi

git tag "$NEXT_TAG"

echo "[release] Pushing branch..."
git push "$REMOTE" "$BRANCH"

echo "[release] Pushing tag to trigger GitHub Actions release build..."
git push "$REMOTE" "$NEXT_TAG"

echo "[release] Done: $NEXT_TAG"
