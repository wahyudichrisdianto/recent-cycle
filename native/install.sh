#!/bin/zsh
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ '^[a-p]{32}$' ]]; then
  print -u2 "usage: $0 <32-character Chrome extension id>"
  exit 2
fi

extension_id="$1"
script_dir="${0:A:h}"
host_name="com.recentcycle.keyboard"
install_dir="${HOME}/Library/Application Support/Recent Cycle/native-host"
manifest_dir="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
executable="${install_dir}/${host_name}"
manifest="${manifest_dir}/${host_name}.json"

command -v swiftc >/dev/null || { print -u2 "swiftc is required (install Xcode Command Line Tools)"; exit 1; }
mkdir -p "$install_dir" "$manifest_dir"
swiftc -O "${script_dir}/RecentCycleHost/main.swift" \
  -o "$executable" \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics

sed -e "s|__HOST_EXECUTABLE__|${executable}|g" \
    -e "s|__EXTENSION_ID__|${extension_id}|g" \
    "${script_dir}/com.recentcycle.keyboard.json.in" > "$manifest"

chmod 755 "$executable"
print "Installed ${host_name}."
print "Reload Recent Cycle in chrome://extensions, then allow Accessibility access when macOS asks."
print "Host manifest: ${manifest}"
