#!/bin/sh
# Safely expand a standalone ext4 filesystem image to 4 GiB.
# This does NOT rebuild Emscripten load-rootfs.data/.js or make the browser
# runtime sparse-storage capable. It is a preparation step for a release build.
set -eu
usage() { echo "Usage: $0 SOURCE.img OUTPUT.img" >&2; exit 2; }
[ "$#" -eq 2 ] || usage
src=$1
out=$2
target_bytes=4294967296
[ -f "$src" ] || { echo "Source image not found: $src" >&2; exit 1; }
[ ! -e "$out" ] || { echo "Refusing to overwrite existing output: $out" >&2; exit 1; }
command -v blkid >/dev/null 2>&1 || { echo "Missing blkid (util-linux)." >&2; exit 1; }
command -v e2fsck >/dev/null 2>&1 || { echo "Missing e2fsck (e2fsprogs)." >&2; exit 1; }
command -v resize2fs >/dev/null 2>&1 || { echo "Missing resize2fs (e2fsprogs)." >&2; exit 1; }
command -v truncate >/dev/null 2>&1 || { echo "Missing truncate (coreutils)." >&2; exit 1; }
fs_type=$(blkid -p -s TYPE -o value "$src" 2>/dev/null || true)
[ "$fs_type" = "ext4" ] || {
  echo "Refusing to resize: expected a standalone ext4 image, detected '${fs_type:-unknown}'." >&2
  echo "Partitioned images and other filesystems require a separate, layout-aware procedure." >&2
  exit 1
}
src_bytes=$(wc -c < "$src" | tr -d ' ')
[ "$src_bytes" -lt "$target_bytes" ] || {
  echo "Source is already 4 GiB or larger; refusing to shrink/replace it." >&2
  exit 1
}
umask 077
cp --reflink=auto --sparse=always -- "$src" "$out"
cleanup() { rm -f -- "$out"; }
trap cleanup HUP INT TERM
truncate -s "$target_bytes" "$out"
e2fsck -f -p "$out" || rc=$?
rc=${rc:-0}
[ "$rc" -le 1 ] || { echo "e2fsck failed (status $rc); output removed." >&2; exit 1; }
resize2fs "$out"
rc=0
e2fsck -f -p "$out" || rc=$?
rc=${rc:-0}
[ "$rc" -le 1 ] || { echo "Post-resize e2fsck failed (status $rc); output removed." >&2; exit 1; }
trap - HUP INT TERM
echo "Created 4 GiB sparse ext4 image: $out"
echo "IMPORTANT: this is not yet a deployable WebPC release asset."
echo "Rebuild the Emscripten preload package and verify browser storage behavior before deployment."
