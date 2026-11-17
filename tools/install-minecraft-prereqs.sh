#!/bin/sh
# Install the complete Minecraft Java runtime into the baked WebPC Alpine disk.
# Run only inside the target x86_64 Alpine root filesystem during the disk build.
# This script is executed by the reproducible 8 GiB disk-image workflow.
# Image build revision: OPFS-safe legacy migration and QEMU device compatibility.
set -eu

ALPINE_VERSION="$(cut -d. -f1,2 /etc/alpine-release)"
if [ "$ALPINE_VERSION" != "3.21" ]; then
  echo "Expected Alpine 3.21, found $ALPINE_VERSION" >&2
  exit 10
fi

# Ensure the matching Alpine 3.21 community repository is enabled; OpenJDK 21
# is published there for x86_64.
if ! grep -Eq '^[[:space:]]*https?://[^[:space:]]+/community/?([[:space:]]*)$' /etc/apk/repositories; then
  awk '
    { print }
    $1 ~ /^https?:/ && $1 ~ /\/main\/?$/ {
      community = $1
      sub(/\/main\/?$/, "/community", community)
      print community
    }
  ' /etc/apk/repositories | awk '!seen[$0]++' > /tmp/webpc-apk-repositories
  if ! grep -q '/community' /tmp/webpc-apk-repositories; then
    echo "Could not enable the Alpine community repository." >&2
    exit 11
  fi
  cp /tmp/webpc-apk-repositories /etc/apk/repositories
  rm -f /tmp/webpc-apk-repositories
fi

echo "=== Updating Alpine 3.21 package indexes ==="
apk update

echo "=== Installing Minecraft Java 21, Prism, Xorg and Mesa ==="
apk add --no-cache \
  openjdk21-jre \
  xorg-server \
  xf86-video-vesa \
  xf86-video-fbdev \
  xf86-input-libinput \
  xinit \
  xauth \
  mesa-dri-gallium \
  mesa-gl \
  mesa-egl \
  mesa-gbm \
  libx11 \
  libxrandr \
  libxcursor \
  libxi \
  libxinerama \
  libxxf86vm \
  libxrender \
  libxfixes \
  libxext \
  libxcb \
  libxkbcommon \
  libdrm \
  libpciaccess \
  fontconfig \
  font-dejavu \
  alsa-lib

# Prism is not published for Alpine 3.21 x86_64. Try the signed v3.22
# community package as a single, ABI-checked package while keeping the guest
# base OS and all shared libraries on the stable v3.21 repositories.
echo "=== Installing the signed Prism Launcher package ==="
apk add --no-cache \
  --repository=https://dl-cdn.alpinelinux.org/alpine/v3.22/community \
  prismlauncher

echo "=== Configuring Java defaults ==="
mkdir -p /etc/profile.d
cat > /etc/profile.d/webpc-java.sh <<'WEBPC_JAVA_EOF'
JAVA_BIN="$(command -v java)"
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$JAVA_BIN")")")"
export PATH="$JAVA_HOME/bin:$PATH"
WEBPC_JAVA_EOF
chmod 644 /etc/profile.d/webpc-java.sh

echo "=== Preparing Xorg and Mesa software-rendering launcher ==="
mkdir -p /etc/X11/xorg.conf.d /usr/local/bin /var/log /tmp/.X11-unix
cat > /etc/X11/xorg.conf.d/20-webpc.conf <<'WEBPC_XORG_EOF'
Section "Device"
  Identifier "WebPC VGA"
  Driver "modesetting"
  Option "AccelMethod" "none"
EndSection
Section "Screen"
  Identifier "WebPC Screen"
  Device "WebPC VGA"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "1024x768" "800x600"
  EndSubSection
EndSection
WEBPC_XORG_EOF

cat > /usr/local/bin/webpc-minecraft-display <<'WEBPC_MC_EOF'
#!/bin/sh
# WebPC guest display starter.
#
# Starts Xorg on the QEMU VGA adapter and then Prism Launcher. Every attempt
# leaves evidence: Xorg's own stdout/stderr and its exit status are copied into
# the launcher log, because a server that dies before opening its -logfile used
# to fail completely silently.
#
# The scanout QEMU shows is whatever the guest currently has programmed into the
# VGA adapter. While the guest console stays in VGA text mode that scanout is a
# text screen, and Xorg paints into a framebuffer nobody displays. The kernel
# driver for the QEMU stdvga adapter is the in-tree DRM module "bochs"; there is
# no module called "bochs_drm", and loading the wrong name leaves the guest with
# no DRM at all. Loading "bochs" makes fbcon take the adapter into graphics mode,
# and because fbcon then keeps repainting that adapter with text, the launcher
# also unbinds it and hands virtual terminal 1 to Xorg so X owns the scanout.
set -u
export DISPLAY=:0
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export QT_QPA_PLATFORM=xcb
export QT_X11_NO_MITSHM=1

LOG=/var/log/webpc-xorg.log
AUDIT=/var/log/webpc-minecraft-launcher.log
CONFIG=/etc/X11/xorg.conf.d/20-webpc.conf
mkdir -p /var/log /tmp/.X11-unix /etc/X11/xorg.conf.d
: > "$LOG"

audit() { echo "$*" >> "$AUDIT"; }

load_drm() {
  for module in bochs bochs_drm virtio_gpu; do
    if modprobe "$module" >/dev/null 2>&1; then
      audit "loaded kernel module: $module"
    fi
  done
  n=0
  while [ "$n" -lt 8 ] && [ ! -e /dev/dri/card0 ]; do
    sleep 1
    n=$((n + 1))
  done
  audit "--- WebPC guest display probe ---"
  audit "kernel: $(uname -r)"
  audit "module dirs: $(ls /lib/modules 2>/dev/null | tr '\n' ' ')"
  audit "bochs module: $(modinfo -n bochs 2>&1 | tail -n 1)"
  audit "dri: $(ls /dev/dri 2>/dev/null | tr '\n' ' ')"
  audit "fb: $(for f in /dev/fb*; do [ -e "$f" ] && echo "$f:$(cat "/sys/class/graphics/$(basename "$f")/name" 2>/dev/null)"; done | tr '\n' ' ')"
  audit "drm drivers: $(for f in /sys/class/drm/card*/device/driver; do [ -L "$f" ] && basename "$(readlink -f "$f")"; done | tr '\n' ' ')"
  audit "dmesg drm: $(dmesg 2>/dev/null | grep -iE 'bochs|drm' | tail -n 6 | tr '\n' '|')"
  audit "vt: $(ls /dev/tty0 /dev/tty1 2>&1 | tr '\n' ' ')"
  audit "xorg binary: $(command -v Xorg || echo missing)"
}

write_xorg_conf() {
  driver=$1
  accel=${2:-}
  {
    echo 'Section "Device"'
    echo '  Identifier "WebPC VGA"'
    echo "  Driver \"$driver\""
    if [ -n "$accel" ]; then echo "  Option \"AccelMethod\" \"$accel\""; fi
    echo 'EndSection'
    echo 'Section "Screen"'
    echo '  Identifier "WebPC Screen"'
    echo '  Device "WebPC VGA"'
    echo '  DefaultDepth 24'
    echo '  SubSection "Display"'
    echo '    Depth 24'
    echo '  EndSubSection'
    echo 'EndSection'
  } > "$CONFIG"
}

start_xorg() {
  # $1 is the variant label; the remaining arguments are passed to Xorg.
  # Every variant takes virtual terminal 1 explicitly: Xorg must own a VT to
  # become the DRM master and to stop the kernel console from drawing over it.
  label="$1"
  shift
  audit "Trying Xorg variant: $label"
  : > "$LOG"
  Xorg :0 vt1 "$@" -noreset -nolisten tcp >>"$LOG" 2>&1 &
  xpid=$!
  n=0
  while [ "$n" -lt 20 ]; do
    if [ -S /tmp/.X11-unix/X0 ] && kill -0 "$xpid" 2>/dev/null; then
      audit "Xorg started with $label"
      return 0
    fi
    if ! kill -0 "$xpid" 2>/dev/null; then
      wait "$xpid"
      status=$?
      audit "Xorg exited with status $status during $label"
      tail -n 12 "$LOG" >> "$AUDIT" 2>/dev/null || true
      dmesg 2>/dev/null | tail -n 6 >> "$AUDIT" || true
      return 1
    fi
    sleep 1
    n=$((n + 1))
  done
  kill "$xpid" 2>/dev/null || true
  wait "$xpid" 2>/dev/null || true
  audit "Xorg did not create display :0 within 20 s for $label"
  tail -n 12 "$LOG" >> "$AUDIT" 2>/dev/null || true
  return 1
}

ensure_driver() {
  # The VESA driver is the only way to program the QEMU stdvga scanout into
  # graphics mode without kernel DRM, so it has to be installed before Xorg is
  # tried if the disk predates it.
  if [ ! -e /dev/dri/card0 ] && [ ! -f /usr/lib/xorg/modules/drivers/vesa_drv.so ]; then
    apk add --no-cache xf86-video-vesa >/dev/null 2>&1 || true
    audit "installed xf86-video-vesa: $(ls /usr/lib/xorg/modules/drivers/vesa_drv.so 2>&1)"
  fi
}

claim_console() {
  # The kernel framebuffer console owns the active virtual terminal and keeps
  # repainting it with text. While it stays bound, Xorg can start and paint its
  # own framebuffer without ever reaching the scanout QEMU shows, which is what
  # made a running Prism Launcher invisible. Unbinding fbcon hands the adapter
  # to Xorg; the serial console still carries every kernel message.
  audit "--- handing the VGA adapter to Xorg ---"
  for vtcon in /sys/class/vtconsole/vtcon*; do
    [ -e "$vtcon/bind" ] || continue
    vtname=$(cat "$vtcon/name" 2>/dev/null)
    before=$(cat "$vtcon/bind" 2>/dev/null)
    echo 0 > "$vtcon/bind" 2>/dev/null || true
    after=$(cat "$vtcon/bind" 2>/dev/null)
    audit "vtconsole $(basename "$vtcon") (${vtname:-unknown}): $before -> $after"
  done
  echo 0 > /sys/class/graphics/fbcon/cursor_blink 2>/dev/null || true
  audit "fbcon cursor blink: $(cat /sys/class/graphics/fbcon/cursor_blink 2>/dev/null || echo unavailable)"
}

start_variants() {
  # A stale socket from an earlier attempt must not make a dead server look
  # healthy, so every variant starts from a clean socket path.
  rm -f /tmp/.X11-unix/X0
  claim_console
  # Order matters. A server that merely starts is not a working display: fbdev
  # on the text-mode framebuffer starts happily and paints into a buffer QEMU
  # never scans out, and that used to win before the VESA driver was tried.
  if [ -e /dev/dri/card0 ]; then
    write_xorg_conf modesetting
    start_xorg "modesetting" -config "$CONFIG" && return 0
    write_xorg_conf modesetting none
    start_xorg "modesetting-noaccel" -config "$CONFIG" && return 0
  else
    audit "no /dev/dri/card0: no kernel DRM driver, so Xorg has to set the VGA mode through the BIOS (vesa)"
  fi
  write_xorg_conf vesa
  start_xorg "vesa" -config "$CONFIG" && return 0
  write_xorg_conf modesetting
  start_xorg "modesetting-retry" -config "$CONFIG" && return 0
  write_xorg_conf fbdev
  start_xorg "fbdev" -config "$CONFIG" && return 0
  start_xorg "autodetect" && return 0
  return 1
}

report_mode() {
  audit "xorg mode: $(grep -E 'Setting mode|VBESetVBEMode|Virtual screen|Screen [0-9]+' "$LOG" 2>/dev/null | tail -n 4 | tr '\n' '|')"
  audit "dri now: $(ls /dev/dri 2>/dev/null | tr '\n' ' ')"
  audit "fb now: $(for f in /sys/class/graphics/fb*; do [ -e "$f/name" ] && echo "$(basename "$f"):$(cat "$f/name" 2>/dev/null):$(cat "$f/virtual_size" 2>/dev/null)"; done | tr '\n' ' ')"
  audit "vtconsole now: $(for f in /sys/class/vtconsole/vtcon*/bind; do [ -e "$f" ] && echo "$(basename "$(dirname "$f")")=$(cat "$f" 2>/dev/null)"; done | tr '\n' ' ')"
  audit "x screen: $(DISPLAY=:0 xdpyinfo 2>/dev/null | grep -m 1 dimensions || echo 'xdpyinfo unavailable')"
}

paint_root() {
  if ! command -v xsetroot >/dev/null 2>&1; then
    apk add --no-cache xsetroot >/dev/null 2>&1 || true
  fi
  if command -v xsetroot >/dev/null 2>&1; then
    xsetroot -solid '#203a5f' 2>/dev/null && audit "painted the X root window"
  fi
}

load_drm
ensure_driver

# A previous Xorg may be running on a framebuffer that never reached the
# scanout. Reusing it would keep the wrong driver, so Launch starts the display
# variants over from scratch instead of trusting the server already there.
if pidof Xorg >/dev/null 2>&1; then
  audit "stopping the previous Xorg so every display variant is retried"
  kill $(pidof Xorg) 2>/dev/null || true
  n=0
  while [ "$n" -lt 5 ] && pidof Xorg >/dev/null 2>&1; do
    sleep 1
    n=$((n + 1))
  done
  if pidof Xorg >/dev/null 2>&1; then
    kill -9 $(pidof Xorg) 2>/dev/null || true
    sleep 1
  fi
  rm -f /tmp/.X11-unix/X0
fi

start_variants || true
report_mode

if [ ! -S /tmp/.X11-unix/X0 ]; then
  audit "Xorg did not create display :0"
  echo "Xorg did not create display :0" >&2
  tail -n 80 "$LOG" 2>/dev/null || true
  exit 20
fi

if [ ! -e /dev/dri/card0 ]; then
  audit "WARNING: no DRM device; the VGA scanout may still be the text console"
fi

# A solid root window proves whether X itself owns the scanout, before Prism's
# own window is involved in the question.
paint_root

exec prismlauncher "$@"
WEBPC_MC_EOF
chmod 755 /usr/local/bin/webpc-minecraft-display

echo "=== Installing one-time migration for the previous persistent OPFS disk ==="
mkdir -p /etc/local.d /var/lib/webpc /mnt/webpc-legacy
cat > /etc/local.d/webpc-migrate-legacy.start <<'WEBPC_MIGRATE_EOF'
#!/bin/sh
set +e
marker=/var/lib/webpc/legacy-migration-v1.done
if [ -f "$marker" ]; then
  echo "WEBPC_LEGACY_DISK_MIGRATION_DONE"
  exit 0
fi
if [ ! -b /dev/vdb ]; then
  exit 0
fi
mkdir -p /mnt/webpc-legacy /var/lib/webpc
if ! mount -t ext4 -o ro,noload /dev/vdb /mnt/webpc-legacy 2>/dev/null; then
  echo "WEBPC_LEGACY_DISK_MIGRATION_FAILED: previous disk could not be mounted read-only"
  exit 0
fi
copy_tree() {
  source_path="$1"
  target_path="$2"
  if [ -d "$source_path" ]; then
    mkdir -p "$target_path"
    cp -a -n "$source_path"/. "$target_path"/ 2>/dev/null || true
  fi
}
# Preserve user data and manually installed applications without overwriting
# the new Java/Xorg/Mesa system packages or the new system configuration.
copy_tree /mnt/webpc-legacy/root /root
copy_tree /mnt/webpc-legacy/home /home
copy_tree /mnt/webpc-legacy/opt /opt
copy_tree /mnt/webpc-legacy/usr/local /usr/local
copy_tree /mnt/webpc-legacy/srv /srv
copy_tree /mnt/webpc-legacy/var/games /var/games
if [ -f /mnt/webpc-legacy/lib/apk/db/installed ]; then
  sed -n 's/^P://p' /mnt/webpc-legacy/lib/apk/db/installed > /var/lib/webpc/legacy-apk-packages.txt
fi
sync
umount /mnt/webpc-legacy 2>/dev/null || true
touch "$marker"
echo "WEBPC_LEGACY_DISK_MIGRATION_DONE"
exit 0
WEBPC_MIGRATE_EOF
chmod 755 /etc/local.d/webpc-migrate-legacy.start
if [ -x /etc/init.d/local ]; then
  rc-update add local default
else
  echo "OpenRC local service is missing; cannot enable legacy-disk migration." >&2
  exit 24
fi

echo "=== Verifying the installed runtime ==="
apk info -e openjdk21-jre
apk info -e prismlauncher
apk info -e xorg-server
apk info -e xf86-input-libinput
apk info -e mesa-dri-gallium
apk info -e mesa-gl
apk info -e mesa-egl
java -version 2>&1 | tee /tmp/webpc-java-version.txt
grep -Eq 'version "21|openjdk version "21' /tmp/webpc-java-version.txt
command -v prismlauncher
test -x "$(command -v prismlauncher)"
command -v Xorg
command -v xinit
test -x /usr/local/bin/webpc-minecraft-display
test -s /etc/X11/xorg.conf.d/20-webpc.conf
test -s /etc/profile.d/webpc-java.sh
test -x /etc/local.d/webpc-migrate-legacy.start
rc-update show default 2>/dev/null | grep -q local
JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
export LD_LIBRARY_PATH="$JAVA_HOME/lib/server:$JAVA_HOME/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
JAVA_AWT="$(find /usr/lib/jvm -name libawt_xawt.so -type f -print -quit 2>/dev/null)"
if [ -z "$JAVA_AWT" ]; then echo "Java AWT native library is missing." >&2; exit 23; fi
ldd "$JAVA_AWT" 2>&1 | tee /tmp/webpc-java-awt-ldd.txt
if grep -q 'not found' /tmp/webpc-java-awt-ldd.txt; then
  echo "Java AWT has unresolved shared-library dependencies." >&2
  exit 21
fi
ldd "$(command -v prismlauncher)" 2>&1 | tee /tmp/webpc-prism-ldd.txt
if grep -q 'not found' /tmp/webpc-prism-ldd.txt; then
  echo "Prism Launcher has unresolved shared-library dependencies." >&2
  exit 22
fi

{
  echo "WebPC Minecraft prerequisites"
  echo "Alpine: $ALPINE_VERSION"
  java -version 2>&1
  apk info -e openjdk21-jre prismlauncher xorg-server xf86-input-libinput xf86-video-vesa xf86-video-fbdev mesa-dri-gallium mesa-gl mesa-egl
} > /etc/webpc-minecraft-prereqs

echo "PASS: Java 21, Prism Launcher, Xorg, Mesa, fonts and audio runtime are installed in the guest disk."
