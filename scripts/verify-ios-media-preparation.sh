#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
check_dir=$(mktemp -d)
trap 'rm -rf "$check_dir"' EXIT
xcrun swiftc -O -emit-library -emit-module -module-name CompanionCore \
  ios/Sources/CompanionCore/MessageAttachments.swift \
  -o "$check_dir/libCompanionCore.dylib" -emit-module-path "$check_dir/CompanionCore.swiftmodule"
xcrun swiftc -O -parse-as-library -I "$check_dir" -L "$check_dir" -lCompanionCore \
  -Xlinker -rpath -Xlinker "$check_dir" \
  ios/App/PhotoAttachment.swift ios/App/VideoAttachment.swift \
  scripts/ios-tests/MediaPreparationChecks.swift -o "$check_dir/check"
"$check_dir/check"
