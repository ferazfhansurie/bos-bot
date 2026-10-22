#!/usr/bin/env bash
# Build one client's Mac installers: signed + notarized arm64 and x64 dmgs that
# carry the client's provision file, so the app restores their hosted bot on
# first launch (electron/enterprise-provision.mjs). Nothing is published.
#
#   bin/enterprise-client-build.sh [--dry-run] <slug> <path-to-provision.json>
#
# Output: $BOS_ENTERPRISE_OUT/<slug>-<version>/BOS-Bot-<version>-<slug>-<arch>.dmg
#         (default $HOME/BOS-enterprise-builds), always outside the repo.
#
# The provision file holds a live one-time token and the archive password:
#   - it is copied into .enterprise-build/<slug>/ (gitignored) only for the
#     build and removed on exit, success or not;
#   - it is never written into the repo history, a log, or the output folder
#     (it travels only inside the signed app's Contents/Resources).
#
# Environment:
#   BOS_MAC_IDENTITY     signing identity (hash or name). Unset: electron-builder
#                        auto-discovers the Developer ID identity, as for releases.
#   BOS_NOTARY_PROFILE   notarytool keychain profile (default bos-notary).
#   BOS_UPDATE_FEED_URL  update feed baked into app-update.yml (default the live
#                        feed); the build itself never publishes to it.
#   BOS_ENTERPRISE_OUT   output root (default $HOME/BOS-enterprise-builds).
#
# --dry-run validates the inputs, writes and loads the generated builder config,
# prints every command it would run, then removes the staged copy. It never
# builds, signs, notarizes, or contacts the network.
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi
if [[ $# -ne 2 ]]; then
  echo "usage: $0 [--dry-run] <slug> <path-to-provision.json>" >&2
  exit 64
fi
SLUG=$1
PROVISION_SRC=$2

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO"

die() { echo "enterprise-build: $*" >&2; exit 1; }
run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if [[ $DRY_RUN -eq 0 ]]; then "$@"; fi
}

[[ "$(uname -s)" == "Darwin" ]] || die "Mac builds need macOS."
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || die "slug must be lowercase letters, digits and dashes."
[[ -f "$PROVISION_SRC" ]] || die "no provision file at $PROVISION_SRC"
command -v node >/dev/null || die "node is not on PATH."

# Same validation the app applies at launch, so a bad file fails here.
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { validateProvision } from "./electron/enterprise-provision.mjs";
  const [file, slug] = process.argv.slice(1);
  const value = validateProvision(JSON.parse(readFileSync(file, "utf8")));
  if (value.slug !== slug) { console.error(`provision slug "${value.slug}" does not match "${slug}"`); process.exit(1); }
  console.log(`provision ok: ${value.slug} (${value.label}) -> ${new URL(value.url).host}`);
' "$PROVISION_SRC" "$SLUG" || die "the provision file is invalid."

VERSION=$(node -p 'require("./package.json").version')
SHA=$(git rev-parse HEAD)
if [[ -n "$(git status --porcelain)" ]]; then
  [[ $DRY_RUN -eq 1 ]] || die "live packaging requires a clean checkout (git status is not empty)."
  echo "note: checkout is not clean; a real build would stop here."
fi

STAGE="$REPO/.enterprise-build/$SLUG"
git check-ignore -q "$STAGE/provision.json" || die ".enterprise-build/ is not gitignored; refusing to stage a secret."
OUT_ROOT=$(node -p 'require("node:path").resolve(process.argv[1])' "${BOS_ENTERPRISE_OUT:-$HOME/BOS-enterprise-builds}")
case "$OUT_ROOT/" in "$REPO"/*) die "output must be outside the repo ($OUT_ROOT).";; esac
OUT="$OUT_ROOT/$SLUG-$VERSION"
BUILD_DIR="$OUT/.build"
NOTARY_PROFILE=${BOS_NOTARY_PROFILE:-bos-notary}
export BOS_UPDATE_FEED_URL=${BOS_UPDATE_FEED_URL:-https://bos.aihlete.com/updates}

cleanup() { rm -rf "$STAGE"; rmdir "$REPO/.enterprise-build" 2>/dev/null || true; }
trap cleanup EXIT
rm -rf "$STAGE"
mkdir -p "$STAGE"
chmod 700 "$STAGE"
install -m 600 "$PROVISION_SRC" "$STAGE/provision.json"

echo "building BOS Bot $VERSION for $SLUG at $SHA"
# The generated config below requires the live config, which needs node_modules.
run pnpm install --frozen-lockfile

# The live config plus: the provision file as a mac extra resource, dmg-only
# targets (no updater zips), slug-named artifacts, and an output folder outside
# the repo. Every relative path still resolves against the repo root (cwd).
cat > "$STAGE/electron-builder.cjs" <<EOF
const live = require($(node -p 'JSON.stringify(process.argv[1])' "$REPO/electron-builder.live.cjs"));
const name = "BOS-Bot-\${version}-$SLUG-\${arch}";
module.exports = {
  ...live,
  artifactName: name + ".\${ext}",
  directories: { ...live.directories, output: $(node -p 'JSON.stringify(process.argv[1])' "$BUILD_DIR") },
  dmg: { ...live.dmg, artifactName: name + ".dmg" },
  mac: {
    ...live.mac,
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    extraResources: [
      ...(live.mac.extraResources ?? []),
      { from: $(node -p 'JSON.stringify(process.argv[1])' "$STAGE/provision.json"), to: "enterprise/provision.json" },
    ],
  },
};
EOF
node -e '
  const config = require(process.argv[1]);
  const extra = config.mac.extraResources.find(entry => entry.to === "enterprise/provision.json");
  if (!extra || !require("node:fs").existsSync(extra.from)) throw new Error("provision resource missing from the generated config");
  if (!config.dmg.artifactName.includes(process.argv[2])) throw new Error("artifact name lacks the slug");
  console.log(`builder config ok: ${config.dmg.artifactName} -> ${config.directories.output}`);
' "$STAGE/electron-builder.cjs" "-$SLUG-" || die "the generated builder config is invalid."

run pnpm package:prepare
run pnpm build:speech
run pnpm build:notch
run pnpm build:cua

IDENTITY_ARGS=()
if [[ -n "${BOS_MAC_IDENTITY:-}" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  IDENTITY_ARGS=(--config.mac.identity="$BOS_MAC_IDENTITY")
fi
run rm -rf "$BUILD_DIR"
run pnpm exec electron-builder --config "$STAGE/electron-builder.cjs" --mac --publish never \
  --config.extraMetadata.bosSourceCommit="$SHA" ${IDENTITY_ARGS[@]+"${IDENTITY_ARGS[@]}"}

DMGS=()
for arch in arm64 x64; do DMGS+=("$BUILD_DIR/BOS-Bot-$VERSION-$SLUG-$arch.dmg"); done

if [[ $DRY_RUN -eq 0 ]]; then
  for dmg in "${DMGS[@]}"; do [[ -f "$dmg" ]] || die "expected $dmg was not built."; done
  for app in "$BUILD_DIR"/mac*/"BOS Bot.app"; do
    codesign --verify --deep --strict "$app" || die "signature check failed: $app"
    [[ -f "$app/Contents/Resources/enterprise/provision.json" ]] || die "provision file missing from $app"
  done
fi

for dmg in "${DMGS[@]}"; do
  if [[ $DRY_RUN -eq 1 ]]; then
    run xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json
  else
    echo "notarizing $(basename "$dmg")"
    result=$(xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json)
    echo "$result"
    grep -q '"status" *: *"Accepted"' <<<"$result" || die "notarization was not accepted for $dmg"
  fi
  run xcrun stapler staple "$dmg"
  run spctl -a -t open --context context:primary-signature -vv "$dmg"
done
run mkdir -p "$OUT"
run mv "${DMGS[@]}" "$OUT/"
run rm -rf "$BUILD_DIR"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "dry run: nothing built. output would be:"
else
  echo "built:"
fi
for arch in arm64 x64; do echo "  $OUT/BOS-Bot-$VERSION-$SLUG-$arch.dmg"; done
echo "$OUT"
