#!/usr/bin/env bash
#
# Build a clean, ready-to-install release bundle for Recent Cycle.
#
# Output (into ./release):
#   recent-cycle-<version>.zip   -> upload this to a GitHub Release
#   install.sh                   -> convenience copy for self-hosting
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)"
[[ -n "$version" ]] || { echo "could not read version from manifest.json" >&2; exit 1; }

out_dir="$root/release"
stage="$out_dir/recent-cycle-$version"
ext="$stage/recent-cycle"

rm -rf "$out_dir"
mkdir -p "$ext"

cp manifest.json "$ext/"
cp background.js cycle-overlay.js gesture-state.js mru.js "$ext/"
cp popup.html popup.css popup.js "$ext/"
cp companion.html companion.css companion.js "$ext/"

mkdir -p "$ext/assets/icons"
cp assets/icons/*.png "$ext/assets/icons/"
cp assets/favicon.ico "$ext/assets/"

cp -R native "$ext/native"
chmod +x "$ext/native/install.sh" "$ext/native/uninstall.sh"

cp LICENSE README.md "$ext/"

(
  cd "$stage"
  zip -q -r "$out_dir/recent-cycle-$version.zip" recent-cycle
)

cp install.sh "$out_dir/install.sh"
chmod +x "$out_dir/install.sh"

echo "Built:"
echo "  $out_dir/recent-cycle-$version.zip"
echo "  $out_dir/install.sh"
echo
echo "Next (GitHub):"
echo "  1. git tag v${version} && git push origin v${version}"
echo "  2. Create a release for v${version} and upload:"
echo "       recent-cycle-${version}.zip"
echo "  3. Install one-liner will be:"
echo "       curl -fsSL https://raw.githubusercontent.com/wahyudichrisdianto/recent-cycle/main/install.sh | bash"