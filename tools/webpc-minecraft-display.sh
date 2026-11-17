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
# no DRM at all. Loading "bochs" makes fbcon take the adapter into graphics mode
# before Xorg ever starts.
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
  label="$1"
  shift
  audit "Trying Xorg variant: $label"
  : > "$LOG"
  Xorg :0 "$@" -noreset -nolisten tcp >>"$LOG" 2>&1 &
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

start_variants() {
  # A stale socket from an earlier attempt must not make a dead server look
  # healthy, so every variant starts from a clean socket path.
  rm -f /tmp/.X11-unix/X0
  write_xorg_conf modesetting
  start_xorg "modesetting" -config "$CONFIG" && return 0
  write_xorg_conf modesetting none
  start_xorg "modesetting-noaccel" -config "$CONFIG" && return 0
  write_xorg_conf modesetting
  start_xorg "modesetting-vt" -config "$CONFIG" vt1 && return 0
  write_xorg_conf fbdev
  start_xorg "fbdev" -config "$CONFIG" && return 0
  write_xorg_conf vesa
  start_xorg "vesa" -config "$CONFIG" && return 0
  start_xorg "autodetect" && return 0
  return 1
}

load_drm

if ! pidof Xorg >/dev/null 2>&1; then
  start_variants || true
fi

if [ ! -S /tmp/.X11-unix/X0 ]; then
  audit "Xorg did not create display :0"
  echo "Xorg did not create display :0" >&2
  tail -n 80 "$LOG" 2>/dev/null || true
  exit 20
fi

if [ ! -e /dev/dri/card0 ]; then
  audit "WARNING: no DRM device; the VGA scanout may still be the text console"
fi

exec prismlauncher "$@"
