#!/bin/sh
# Refresh the Homebrew formula for a published version: pulls the
# published tarball from the npm registry, computes its sha256, and
# rewrites the formula's url + sha256 in place. Run after `npm publish`,
# then copy the formula into the tap repo as Formula/sofar.rb.
#
#   ./update-formula.sh 0.12.0
#
# Mirrors update-cask.sh in sofar-cloud/packaging/homebrew, which does
# the same job for the desktop app's cask.
set -eu

VERSION="${1:?usage: update-formula.sh <version>}"
FORMULA="$(dirname "$0")/sofar.rb"
URL="https://registry.npmjs.org/sofar.sh/-/sofar.sh-${VERSION}.tgz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetching $URL"
curl -fsSL "$URL" -o "$TMP/sofar.tgz"
SHA="$(shasum -a 256 "$TMP/sofar.tgz" | awk '{print $1}')"

# Only the two release-varying fields; everything else is hand-owned.
# Homebrew scans the version out of the url, so there is no separate
# version line to bump (a redundant one fails `brew audit --strict`).
sed -i '' \
  -e "s|^  url \".*\"|  url \"${URL}\"|" \
  -e "s|^  sha256 \".*\"|  sha256 \"${SHA}\"|" \
  "$FORMULA"

echo "formula updated -> version ${VERSION}, sha256 ${SHA}"
echo "verify with: brew audit --strict --formula <tap>/sofar"
