#!/bin/zsh
set -euo pipefail

host_name="com.recentcycle.keyboard"
install_dir="${HOME}/Library/Application Support/Recent Cycle/native-host"
manifest="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${host_name}.json"

if [[ -f "$manifest" ]]; then
  rm -f "$manifest"
fi
if [[ -f "${install_dir}/${host_name}" ]]; then
  rm -f "${install_dir}/${host_name}"
fi
print "Removed ${host_name} manifest and executable."
print "If desired, revoke Recent Cycle's Accessibility permission in System Settings > Privacy & Security > Accessibility."
