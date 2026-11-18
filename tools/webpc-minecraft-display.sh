#!/bin/sh
# WebPC guest display starter.
#
# Starts Xorg on the QEMU VGA adapter and then Prism Launcher. Every attempt
# leaves evidence in the launcher log, because a server that dies before
# opening its own -logfile used to fail completely silently.
#
# Three faults used to make a running Prism Launcher invisible:
#
#   * The guest kernel does not mount sysfs by itself. Xorg's modesetting driver
#     finds its DRM device by walking /sys, and fbcon is unbound through /sys as
#     well, so without it the server answered "no screens found" and the VGA
#     scanout kept showing the text console. ensure_mounts() mounts what Xorg
#     needs before anything looks for it.
#   * Xorg creates /tmp/.X11-unix/X0 before it initialises a screen, so the
#     socket alone proved nothing: the first variant was reported as started
#     while it was already dying and the fallbacks were never tried. start_xorg()
#     clears the socket before each attempt and requires the server to stay up.
#   * A server that stays up is still not a server the user can see. GLAMOR and
#     the modesetting driver can render into buffers QEMU's emulated CRT never
#     shows, so every variant is kept only after painting the root window and
#     watching the guest framebuffer change.
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
FALLBACK_LABEL=/tmp/webpc-xorg-fallback.label
FALLBACK_CONF=/tmp/webpc-xorg-fallback.conf
DRIVERS=/usr/lib/xorg/modules/drivers
FBDEV=/dev/fb0
PRISM_LOG=/var/log/webpc-prism.log
WM_LOG=/var/log/webpc-wm.log
COMMUNITY_REPO=https://dl-cdn.alpinelinux.org/alpine/v3.22/community
mkdir -p /var/log /tmp/.X11-unix /etc/X11/xorg.conf.d
: > "$LOG"
rm -f "$VARIANT"
PROOF_REQUIRED=1

audit() { echo "$*" >> "$AUDIT"; }

ensure_mounts() {
  # A kernel does not mount sysfs; the guest init only mounted /proc. Every
  # /sys probe came back empty on a live guest, which is why fbcon was never
  # unbound and why Xorg could not see /dev/dri/card0 even though it existed.
  mkdir -p /proc /sys /dev /dev/pts /tmp
  [ -d /proc/self ] || mount -t proc proc /proc 2>/dev/null || true
  [ -d /sys/class ] || mount -t sysfs sysfs /sys 2>/dev/null || true
  [ -e /dev/pts/ptmx ] || mount -t devpts devpts /dev/pts 2>/dev/null || true
  audit "mounts: $(mount 2>/dev/null | grep -E ' on /(proc|sys|dev|dev/pts) ' | tr '\n' ' ')"
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
  audit "dri: $(ls /dev/dri 2>/dev/null | tr '\n' ' ')"
  audit "fb0: $(cat /sys/class/graphics/fb0/virtual_size 2>/dev/null || echo missing)"
  audit "drm drivers: $(for f in /sys/class/drm/card*/device/driver; do [ -L "$f" ] && basename "$(readlink -f "$f")"; done | tr '\n' ' ')"
  audit "drm connectors: $(for f in /sys/class/drm/card*/status; do [ -e "$f" ] && echo "$(basename "$(dirname "$f")")=$(cat "$f" 2>/dev/null)"; done | tr '\n' ' ')"
  audit "dmesg drm: $(dmesg 2>/dev/null | grep -iE 'bochs|drm' | tail -n 4 | tr '\n' '|')"
  audit "xorg binary: $(command -v Xorg || echo missing) drivers: $(ls "$DRIVERS" 2>/dev/null | tr '\n' ' ')"
}

ensure_support() {
  # Xorg needs its driver modules, and the scanout test needs a client that can
  # paint the root window, so install whatever is missing before the loop.
  missing=
  have_driver modesetting || missing="$missing xorg-server"
  have_driver vesa || missing="$missing xf86-video-vesa"
  have_driver fbdev || missing="$missing xf86-video-fbdev"
  command -v xsetroot >/dev/null 2>&1 || missing="$missing xsetroot"
  if [ -n "$missing" ]; then
    audit "installing missing display support:$missing"
    timeout 90 apk add --no-cache $missing >/dev/null 2>&1 || true
  fi
  audit "support: drivers $(for d in modesetting vesa fbdev; do have_driver "$d" && printf '%s ' "$d"; done)xsetroot=$(command -v xsetroot >/dev/null 2>&1 && echo yes || echo no)"
}

ensure_qt_support() {
  # From Qt 6.5 the xcb platform plugin refuses to load without libxcb-cursor,
  # and a Prism Launcher whose platform plugin cannot load aborts before it ever
  # maps a window: the screen keeps the root paint and nothing else records why.
  # Each name is installed on its own so one unavailable package cannot cancel
  # the rest, and everything that is still missing is named in the log.
  qt_missing=
  for pkg in xcb-util-cursor xcb-util-wm xcb-util-keysyms xcb-util-renderutil xcb-util-image xkeyboard-config libxkbcommon-x11 xwininfo; do
    apk info -e "$pkg" >/dev/null 2>&1 && continue
    apk add --no-cache "$pkg" >/dev/null 2>&1 || qt_missing="$qt_missing $pkg"
  done
  audit "qt xcb support:$([ -n "$qt_missing" ] && echo " missing$qt_missing" || echo ' complete')"
}

run_window_manager() {
  # $1 is the window manager binary to start on display :0.
  "$1" >"$WM_LOG" 2>&1 &
  sleep 2
  pidof "$1" >/dev/null 2>&1
}

ensure_window_manager() {
  # Qt 6's xcb platform plugin expects a window manager and this guest ships
  # none. Without one a window Qt hides during its own startup can be mapped
  # again and never painted, which leaves on screen exactly what Prism showed:
  # nothing but the root paint. The same missing manager is also why nothing
  # gives Prism's sign-in wizard keyboard focus, so start the first manager that
  # is present and install one only when none is at all.
  for wm in openbox jwm twm fluxbox matchbox-window-manager; do
    command -v "$wm" >/dev/null 2>&1 || continue
    run_window_manager "$wm" && { audit "window manager: $wm"; return 0; }
    audit "window manager: $wm did not start"
  done
  for wm in openbox jwm twm; do
    timeout 120 apk add --no-cache "$wm" >/dev/null 2>&1 ||
      timeout 120 apk add --no-cache --repository="$COMMUNITY_REPO" "$wm" >/dev/null 2>&1 || continue
    command -v "$wm" >/dev/null 2>&1 || continue
    run_window_manager "$wm" && { audit "window manager: $wm (installed)"; return 0; }
  done
  audit "window manager: none available, Prism runs without one"
  return 1
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

release_console() {
  # The kernel console keeps repainting the same framebuffer X paints, on the
  # virtual terminal the adapter currently shows. Unbind it and bring X's VT to
  # the front; this runs again once a server is kept because binding returns
  # whenever the kernel touches a console it still owns.
  for vtcon in /sys/class/vtconsole/vtcon*; do
    [ -e "$vtcon/bind" ] || continue
    echo 0 > "$vtcon/bind" 2>/dev/null || true
  done
  echo 0 > /sys/class/graphics/fbcon/cursor_blink 2>/dev/null || true
  command -v chvt >/dev/null 2>&1 && chvt 1 >/dev/null 2>&1 || true
}

framebuffer_hash() {
  [ -e "$FBDEV" ] || return 1
  dd if="$FBDEV" bs=64k count=64 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1
}

scanout_probe() {
  # Painting the root window and watching the guest framebuffer is the only way
  # to tell a server the user can see from one that renders into a buffer the
  # emulated CRT never scans out. Returns 0 for proof it paints, 1 for proof it
  # does not, 2 when the guest cannot tell.
  command -v xsetroot >/dev/null 2>&1 || return 2
  before=$(framebuffer_hash)
  [ -n "$before" ] || return 2
  xsetroot -solid '#ff00ff' >/dev/null 2>&1 || return 2
  sleep 1
  after=$(framebuffer_hash)
  [ -n "$after" ] || return 2
  [ "$before" = "$after" ] && return 1
  return 0
}

start_xorg() {
  # $1 is the variant label; the remaining arguments are passed to Xorg.
  # Every variant takes virtual terminal 1 explicitly: Xorg must own a VT to
  # become the DRM master and to keep the kernel console off the scanout.
  label="$1"
  shift
  audit "Trying Xorg variant: $label"
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
      rm -f /tmp/.X11-unix/X0 /tmp/.X0-lock
      return 1
    fi
    if [ -S /tmp/.X11-unix/X0 ]; then
      held=$((held + 1))
      if [ "$held" -ge 3 ] && ! grep -q 'Fatal server error' "$LOG" 2>/dev/null; then
        scanout_probe
        proof=$?
        if [ "$proof" -eq 1 ] && [ "$PROOF_REQUIRED" -eq 1 ]; then
          audit "rejecting $label: alive, but painting the root window never changed $FBDEV"
          kill "$xpid" 2>/dev/null
          wait "$xpid" 2>/dev/null
          rm -f /tmp/.X11-unix/X0 /tmp/.X0-lock
          return 2
        fi
        audit "Xorg started with $label ($([ "$proof" -eq 0 ] && echo "root paint reached $FBDEV" || echo "scanout not verifiable"))"
        echo "$label" > "$VARIANT"
        return 0
      fi
    fi
    sleep 1
    n=$((n + 1))
  done
  kill "$xpid" 2>/dev/null || true
  wait "$xpid" 2>/dev/null || true
  audit "Xorg did not become usable within ${n}s for $label"
  audit "failure [$label]: $(grep -m 3 -E '\(EE\)|No devices|no screens' "$LOG" 2>/dev/null | tr '\n' '|')"
  rm -f /tmp/.X11-unix/X0 /tmp/.X0-lock
  return 1
}

try_variant() {
  # $1 label, then the arguments for Xorg. A variant that stays up but never
  # shows its paint is kept in reserve instead of dropped: /dev/fb0 can lag the
  # buffer X actually scans out, and running with the wrong idea about the
  # framebuffer still beats running with no display at all.
  label="$1"
  shift
  start_xorg "$label" "$@"
  rc=$?
  if [ "$rc" -eq 2 ] && [ ! -s "$FALLBACK_LABEL" ]; then
    cp "$CONFIG" "$FALLBACK_CONF" && echo "$label" > "$FALLBACK_LABEL"
  fi
  return "$rc"
}

start_variants() {
  release_console
  rm -f "$FALLBACK_LABEL" "$FALLBACK_CONF"
  # A server that renders well is useless if its output never reaches the CRT,
  # so the variants that write straight into the framebuffer QEMU scans out are
  # tried before GLAMOR, which only arrives through autodetect as a last resort.
  if [ -e /dev/dri/card0 ] && have_driver modesetting; then
    write_xorg_conf modesetting none '  Option "kmsdev" "/dev/dri/card0"'
    try_variant "modesetting-shadow" -config "$CONFIG" && return 0
  elif [ ! -e /dev/dri/card0 ]; then
    audit "no /dev/dri/card0: no kernel DRM driver, so Xorg has to set the VGA mode through the BIOS (vesa)"
  fi
  if [ -e "$FBDEV" ] && have_driver fbdev; then
    write_xorg_conf fbdev
    try_variant "fbdev" -config "$CONFIG" && return 0
  fi
  if have_driver vesa; then
    write_xorg_conf vesa
    try_variant "vesa" -config "$CONFIG" && return 0
  fi
  try_variant "autodetect" && return 0
  if [ -s "$FALLBACK_LABEL" ]; then
    label=$(cat "$FALLBACK_LABEL")
    audit "no variant proved it reaches the scanout; keeping $label, the first one that stayed up"
    PROOF_REQUIRED=0
    start_xorg "$label" -config "$FALLBACK_CONF" && return 0
  fi
  return 1
}

report_mode() {
  audit "xorg variant: $(cat "$VARIANT" 2>/dev/null || echo none)"
  audit "scanout: fbcon=$(cat /sys/class/vtconsole/vtcon0/bind 2>/dev/null || echo none) vt=$(cat /sys/class/tty/tty0/active 2>/dev/null || echo unknown) fb=$(cat /sys/class/graphics/fb0/virtual_size 2>/dev/null || echo none)"
  audit "xorg mode: $(grep -E 'Setting mode|Virtual screen|Screen [0-9]+' "$LOG" 2>/dev/null | tail -n 2 | tr '\n' '|')"
  audit "x screen: $(DISPLAY=:0 xdpyinfo 2>/dev/null | grep -m 1 dimensions || echo 'xdpyinfo unavailable')"
}

paint_root() {
  if command -v xsetroot >/dev/null 2>&1; then
    xsetroot -solid '#203a5f' 2>/dev/null && audit "painted the X root window"
  fi
}

prism_alive() {
  # A child that has exited but has not been reaped yet still answers kill -0,
  # so the process state has to be read too: otherwise a crashed Prism is
  # reported as a live launcher that merely has no window.
  kill -0 "$prism_pid" 2>/dev/null || return 1
  state=$(awk '{print $3}' "/proc/$prism_pid/stat" 2>/dev/null)
  [ "$state" = "Z" ] && return 1
  return 0
}

prism_window_count() {
  # A mapped window is the only local proof that Prism reached its user
  # interface: the guest framebuffer shows the root paint whether Prism drew
  # nothing or never started. Echoes 2 when the guest has no window list tool.
  command -v xwininfo >/dev/null 2>&1 || { echo 2; return 0; }
  DISPLAY=:0 timeout 8 xwininfo -root -children 2>/dev/null | grep -ciE 'prism|minecraft|java'
}

start_prism() {
  # Prism used to be exec'd, so a launcher that never drew anything left one
  # trace only: the screen stayed on the root paint. Run it in the background,
  # keep its own output in a log, and record whether a window appeared, whether
  # the scanout changed after it started, and what it printed when it did not.
  : > "$PRISM_LOG"
  before=$(framebuffer_hash)
  audit "prism launcher: starting on $DISPLAY"
  prismlauncher "$@" >>"$PRISM_LOG" 2>&1 &
  prism_pid=$!
  n=0
  windows=2
  while [ "$n" -lt 25 ]; do
    if ! prism_alive; then
      windows=none
      audit "prism launcher: exited during startup"
      break
    fi
    windows=$(prism_window_count)
    case "$windows" in
      ''|*[!0-9]*) windows=unknown ;;
      0) ;;
      *) break ;;
    esac
    sleep 1
    n=$((n + 1))
  done
  after=$(framebuffer_hash)
  alive=no
  prism_alive && alive=yes
  audit "prism launcher: pid $prism_pid alive=$alive windows=$windows after ${n}s"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    audit "prism launcher: the scanout changed after it started"
  elif [ -n "$before" ]; then
    audit "prism launcher: the scanout did not change after it started"
  fi
  audit "prism launcher output: $(grep -m 3 -iE 'error|cannot|could not|failed|abort|no qt platform' "$PRISM_LOG" 2>/dev/null | tr '\n' '|')"
  wait "$prism_pid"
}

ensure_mounts
load_drm
ensure_support
ensure_qt_support

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
if [ "$display_ok" -eq 0 ]; then
  release_console
  ensure_window_manager
  paint_root
fi
report_mode

if [ "$display_ok" -ne 0 ]; then
  audit "no display variant produced a server that stays up"
  echo "No Xorg variant stayed up on display :0; the guest text console stays on screen." >&2
  grep -m 12 -E 'Trying Xorg variant|failure \[|rejecting' "$AUDIT" 2>/dev/null | tail -n 12 >&2 || true
  exit 20
fi

start_prism "$@"
