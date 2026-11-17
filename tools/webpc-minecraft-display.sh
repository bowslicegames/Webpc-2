#!/bin/sh
# WebPC guest display starter.
#
# Starts Xorg on the QEMU VGA adapter and then Prism Launcher. Every attempt
# leaves evidence: Xorg's own stdout/stderr, its exit status, and the reason a
# variant was rejected are copied into the launcher log, because a server that
# dies before opening its own -logfile used to fail completely silently.
#
# Three separate faults used to make a running Prism Launcher invisible, and
# each one is handled here:
#
#   * The guest kernel does not mount sysfs by itself. Xorg's modesetting driver
#     finds its DRM device by walking /sys, and fbcon is unbound through /sys as
#     well, so without it the server answered "no screens found" and the VGA
#     scanout kept showing the text console. ensure_mounts() mounts what Xorg
#     needs before anything looks for it.
#   * Xorg creates /tmp/.X11-unix/X0 before it initialises a screen, so the
#     socket alone proved nothing. The first variant was reported as started
#     while it was already dying, so the vesa and fbdev fallbacks were never
#     tried. start_xorg() now requires the server to stay alive and clears the
#     socket and lock file before every attempt.
#   * The kernel driver for the QEMU stdvga adapter is the in-tree DRM module
#     "bochs"; there is no module called "bochs_drm", and loading the wrong name
#     leaves the guest with no DRM at all.
set -u
export DISPLAY=:0
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export QT_QPA_PLATFORM=xcb
export QT_X11_NO_MITSHM=1

LOG=/var/log/webpc-xorg.log
AUDIT=/var/log/webpc-minecraft-launcher.log
CONFIG=/etc/X11/xorg.conf.d/20-webpc.conf
VARIANT=/var/log/webpc-xorg-variant
DRIVERS=/usr/lib/xorg/modules/drivers
mkdir -p /var/log /tmp/.X11-unix /etc/X11/xorg.conf.d
: > "$LOG"
rm -f "$VARIANT"

audit() { echo "$*" >> "$AUDIT"; }

ensure_mounts() {
  # A kernel does not mount sysfs; the guest init only mounted /proc. Every
  # /sys probe in this script therefore came back empty on a live guest, which
  # is why fbcon was never unbound and why Xorg could not see /dev/dri/card0
  # even though it existed. Mount the pseudo filesystems Xorg depends on
  # instead of trusting the guest to have done it.
  mkdir -p /proc /sys /dev /dev/pts /tmp
  [ -d /proc/self ] || mount -t proc proc /proc 2>/dev/null || true
  [ -d /sys/class ] || mount -t sysfs sysfs /sys 2>/dev/null || true
  [ -e /dev/pts/ptmx ] || mount -t devpts devpts /dev/pts 2>/dev/null || true
  audit "mounts: $(mount 2>/dev/null | grep -E ' on /(proc|sys|dev|dev/pts) ' | tr '\n' ' ')"
  audit "sysfs classes: $(ls /sys/class 2>/dev/null | tr '\n' ' ')"
}

have_driver() { [ -f "$DRIVERS/$1_drv.so" ]; }

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
  audit "drm connectors: $(for f in /sys/class/drm/card*/status; do [ -e "$f" ] && echo "$(basename "$(dirname "$f")")=$(cat "$f" 2>/dev/null)"; done | tr '\n' ' ')"
  audit "dmesg drm: $(dmesg 2>/dev/null | grep -iE 'bochs|drm' | tail -n 6 | tr '\n' '|')"
  audit "vt: $(ls /dev/tty0 /dev/tty1 2>&1 | tr '\n' ' ')"
  audit "xorg binary: $(command -v Xorg || echo missing)"
  audit "xorg drivers: $(ls "$DRIVERS" 2>/dev/null | tr '\n' ' ')"
}

write_xorg_conf() {
  # $1 driver, $2 optional AccelMethod, $3 optional extra Option line.
  driver=$1
  accel=${2:-}
  extra=${3:-}
  {
    echo 'Section "Device"'
    echo '  Identifier "WebPC VGA"'
    echo "  Driver \"$driver\""
    if [ -n "$accel" ]; then echo "  Option \"AccelMethod\" \"$accel\""; fi
    if [ -n "$extra" ]; then echo "$extra"; fi
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

probe_display() {
  # Only an actual client proves the server reached a usable screen state. When
  # no client is installed yet the caller falls back to "still alive and no
  # fatal error", which is enough to catch a server that dies during setup.
  if command -v xsetroot >/dev/null 2>&1; then
    DISPLAY=:0 xsetroot -solid '#203a5f' >/dev/null 2>&1 && return 0
    return 1
  fi
  return 0
}

start_xorg() {
  # $1 is the variant label; the remaining arguments are passed to Xorg.
  # Every variant takes virtual terminal 1 explicitly: Xorg must own a VT to
  # become the DRM master and to stop the kernel console from drawing over it.
  label="$1"
  shift
  audit "Trying Xorg variant: $label"
  # A dead attempt leaves both of these behind, and a leftover socket would make
  # the next variant look started the instant it is launched.
  rm -f /tmp/.X11-unix/X0 /tmp/.X0-lock
  : > "$LOG"
  Xorg :0 vt1 "$@" -noreset -nolisten tcp >>"$LOG" 2>&1 &
  xpid=$!
  n=0
  held=0
  while [ "$n" -lt 20 ]; do
    if ! kill -0 "$xpid" 2>/dev/null; then
      wait "$xpid"
      status=$?
      audit "Xorg exited with status $status during $label"
      audit "failure [$label]: $(grep -m 3 -E '\(EE\)|No devices|no screens' "$LOG" 2>/dev/null | tr '\n' '|')"
      tail -n 12 "$LOG" >> "$AUDIT" 2>/dev/null || true
      dmesg 2>/dev/null | tail -n 6 >> "$AUDIT" || true
      rm -f /tmp/.X11-unix/X0 /tmp/.X0-lock
      return 1
    fi
    if [ -S /tmp/.X11-unix/X0 ]; then
      held=$((held + 1))
      if [ "$held" -ge 3 ] && ! grep -q 'Fatal server error' "$LOG" 2>/dev/null; then
        if probe_display; then
          audit "Xorg started with $label"
          echo "$label" > "$VARIANT"
          return 0
        fi
      fi
    fi
    sleep 1
    n=$((n + 1))
  done
  kill "$xpid" 2>/dev/null || true
  wait "$xpid" 2>/dev/null || true
  audit "Xorg did not become usable within ${n}s for $label"
  audit "failure [$label]: $(grep -m 3 -E '\(EE\)|No devices|no screens' "$LOG" 2>/dev/null | tr '\n' '|')"
  tail -n 12 "$LOG" >> "$AUDIT" 2>/dev/null || true
  rm -f /tmp/.X11-unix/X0 /tmp/.X0-lock
  return 1
}

ensure_driver() {
  # A variant cannot be tried without its module on disk, and the vesa and fbdev
  # drivers are the only ones that can program the QEMU stdvga scanout when the
  # DRM path is unavailable, so install whichever is missing before the loop.
  missing=
  have_driver modesetting || missing="$missing xorg-server"
  have_driver vesa || missing="$missing xf86-video-vesa"
  have_driver fbdev || missing="$missing xf86-video-fbdev"
  if [ -n "$missing" ]; then
    audit "installing missing Xorg drivers:$missing"
    timeout 60 apk add --no-cache $missing >/dev/null 2>&1 || true
  fi
  audit "drivers present: $(for d in modesetting vesa fbdev; do have_driver "$d" && printf '%s ' "$d"; done)"
}

claim_console() {
  # The kernel framebuffer console owns the active virtual terminal and keeps
  # repainting it with text. While it stays bound, Xorg can start and paint its
  # own framebuffer without ever reaching the scanout QEMU shows. Unbinding
  # fbcon hands the adapter to Xorg; the serial console still carries every
  # kernel message.
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
  claim_console
  # Order matters. A server that merely starts is not a working display: fbdev
  # on a text-mode framebuffer starts happily and paints into a buffer QEMU
  # never scans out. The DRM path is preferred, then vesa, which programs the
  # scanout through the VGA BIOS without needing DRM at all.
  if [ -e /dev/dri/card0 ] && have_driver modesetting; then
    write_xorg_conf modesetting "" '  Option "kmsdev" "/dev/dri/card0"'
    start_xorg "modesetting-kmsdev" -config "$CONFIG" && return 0
    write_xorg_conf modesetting
    start_xorg "modesetting" -config "$CONFIG" && return 0
    write_xorg_conf modesetting none
    start_xorg "modesetting-noaccel" -config "$CONFIG" && return 0
  elif [ ! -e /dev/dri/card0 ]; then
    audit "no /dev/dri/card0: no kernel DRM driver, so Xorg has to set the VGA mode through the BIOS (vesa)"
  fi
  if have_driver vesa; then
    write_xorg_conf vesa
    start_xorg "vesa" -config "$CONFIG" && return 0
  fi
  if have_driver fbdev; then
    write_xorg_conf fbdev
    start_xorg "fbdev" -config "$CONFIG" && return 0
  fi
  start_xorg "autodetect" && return 0
  return 1
}

hold_scanout() {
  # X owns the CRTC now, but the kernel console can still be bound to the same
  # framebuffer and repaint its old text over X's output, and the virtual
  # terminal showing on the adapter has to be X's as well. Re-assert both after
  # the server is up, then record who owns the scanout.
  for vtcon in /sys/class/vtconsole/vtcon*; do
    [ -e "$vtcon/bind" ] || continue
    echo 0 > "$vtcon/bind" 2>/dev/null || true
  done
  if command -v chvt >/dev/null 2>&1; then
    chvt 1 >/dev/null 2>&1 || true
  fi
  audit "scanout owner: fbcon=$(cat /sys/class/vtconsole/vtcon0/bind 2>/dev/null || echo none) vt=$(cat /sys/class/tty/tty0/active 2>/dev/null || echo unknown)"
}

report_mode() {
  audit "xorg variant: $(cat "$VARIANT" 2>/dev/null || echo none)"
  audit "fbcon bind: $(cat /sys/class/vtconsole/vtcon0/bind 2>/dev/null || echo none)"
  audit "active vt: $(cat /sys/class/tty/tty0/active 2>/dev/null || echo unknown)"
  audit "xorg mode: $(grep -E 'Setting mode|VBESetVBEMode|Virtual screen|Screen [0-9]+' "$LOG" 2>/dev/null | tail -n 4 | tr '\n' '|')"
  audit "dri now: $(ls /dev/dri 2>/dev/null | tr '\n' ' ')"
  audit "fb now: $(for f in /sys/class/graphics/fb*; do [ -e "$f/name" ] && echo "$(basename "$f"):$(cat "$f/name" 2>/dev/null):$(cat "$f/virtual_size" 2>/dev/null)"; done | tr '\n' ' ')"
  audit "vtconsole now: $(for f in /sys/class/vtconsole/vtcon*/bind; do [ -e "$f" ] && echo "$(basename "$(dirname "$f")")=$(cat "$f" 2>/dev/null)"; done | tr '\n' ' ')"
  audit "x screen: $(DISPLAY=:0 xdpyinfo 2>/dev/null | grep -m 1 dimensions || echo 'xdpyinfo unavailable')"
}

paint_root() {
  if ! command -v xsetroot >/dev/null 2>&1; then
    timeout 45 apk add --no-cache xsetroot >/dev/null 2>&1 || true
  fi
  if command -v xsetroot >/dev/null 2>&1; then
    xsetroot -solid '#203a5f' 2>/dev/null && audit "painted the X root window"
  fi
}

ensure_mounts
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
  rm -f /tmp/.X11-unix/X0 /tmp/.X0-lock
fi

display_ok=1
start_variants && display_ok=0
if [ "$display_ok" -eq 0 ]; then hold_scanout; fi
report_mode

if [ "$display_ok" -ne 0 ]; then
  audit "no display variant produced a usable server on :0"
  echo "Xorg could not drive the VGA adapter on display :0; the guest text console stays on screen." >&2
  grep -m 10 -E '\(EE\)|No devices|no screens|failure' "$AUDIT" 2>/dev/null | tail -n 10 >&2 || true
  exit 20
fi

if [ ! -e /dev/dri/card0 ]; then
  audit "WARNING: no DRM device; the VGA scanout may still be the text console"
fi

# A solid root window proves whether X itself owns the scanout, before Prism's
# own window is involved in the question.
paint_root

exec prismlauncher "$@"
