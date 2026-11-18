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
#   * A frozen pointer is a missing udev database, not a missing mouse: X's
#     libinput driver only accepts a device that udevd has tagged as an input
#     device, and this guest boots a bare init that never starts udevd.
#   * Progress used to live only in a serial log. The canvas is the channel the
#     user reports from, so the launcher now draws what it is doing as an X
#     window and leaves a report on screen when Prism never opens.
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
START_AT=$(date +%s)
STATUS_FILE=/tmp/webpc-status.txt
REPORT_FILE=/tmp/webpc-prism-report.txt
APK_LOG=/tmp/webpc-apk.log
STATUS_PID=
PRISM_WINDOW_WAIT=${PRISM_WINDOW_WAIT:-300}
# xmessage and openbox are only published in the community repository.
GRAPHICS_PACKAGES="eudev xf86-input-libinput xf86-input-evdev xcb-util-cursor xcb-util-wm xcb-util-keysyms xcb-util-renderutil xcb-util-image xkeyboard-config libxkbcommon-x11 xwininfo xmessage openbox"

audit() { echo "$*" >> "$AUDIT"; }
elapsed() { echo "$(( $(date +%s) - START_AT ))s"; }
announce() {
  # Before Xorg owns the screen the guest framebuffer console IS the canvas,
  # and this launcher's own output goes to a file nobody can read from a
  # tablet. Writing to the virtual terminal is the only progress report the
  # user can see during the minutes a package install takes.
  audit "$*"
  for out in /dev/tty1 /dev/console; do
    { [ -c "$out" ] && [ -w "$out" ]; } || continue
    printf '\r\nWebPC: %s\r\n' "$*" > "$out" 2>/dev/null && return 0
  done
  return 0
}
console_report() {
  # A failure has to survive a dead X server. release_console() unbinds the
  # framebuffer console to keep the kernel from repainting over X, so binding
  # it again is what turns the blank canvas back into readable text.
  for vtcon in /sys/class/vtconsole/vtcon*; do
    [ -e "$vtcon/bind" ] || continue
    echo 1 > "$vtcon/bind" 2>/dev/null || true
  done
  command -v chvt >/dev/null 2>&1 && chvt 1 >/dev/null 2>&1 || true
  for out in /dev/tty1 /dev/console; do
    { [ -c "$out" ] && [ -w "$out" ]; } || continue
    { echo; echo "=== WebPC guest display ==="; cat "$1"; } > "$out" 2>/dev/null && return 0
  done
  return 0
}

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
    announce "installing Xorg display support:$missing"
    timeout 90 apk add --no-cache $missing >/dev/null 2>&1 || true
  fi
  audit "support: drivers $(for d in modesetting vesa fbdev; do have_driver "$d" && printf '%s ' "$d"; done)xsetroot=$(command -v xsetroot >/dev/null 2>&1 && echo yes || echo no)"
}

ensure_graphics_packages() {
  # From Qt 6.5 the xcb platform plugin refuses to load without libxcb-cursor, a
  # Qt 6 window needs a window manager, input needs udev, and the canvas needs a
  # client that can draw text. All of that is one APK transaction backed by ONE
  # index download per attempt: the old per-package loop re-fetched the index for
  # every name, so a single slow download turned into twenty silent minutes. The
  # retry stays in the transaction path for the same reason.
  missing=$(missing_graphics_packages)
  if [ -n "$missing" ]; then
    announce "installing guest graphics support:$missing at $(elapsed); this is the slow part"
    attempt=1
    while [ "$attempt" -le 2 ]; do
      timeout 180 apk update >"$APK_LOG" 2>&1 || true
      if timeout 480 apk add --repository="$COMMUNITY_REPO" $missing >>"$APK_LOG" 2>&1; then
        audit "graphics support: installed on attempt $attempt at $(elapsed)"
        announce "graphics support installed at $(elapsed)"
        break
      fi
      audit "graphics support: attempt $attempt failed ($(tail -n 2 "$APK_LOG" 2>/dev/null | tr '\n' '|')), retrying"
      attempt=$((attempt + 1))
      sleep 2
    done
  fi
  GRAPHICS_MISSING=$(missing_graphics_packages)
  if [ -n "$GRAPHICS_MISSING" ]; then
    announce "graphics support still missing$GRAPHICS_MISSING at $(elapsed)"
  else
    audit "graphics support at $(elapsed): all present"
  fi
}

missing_graphics_packages() {
  still=
  for pkg in $GRAPHICS_PACKAGES; do
    apk info -e "$pkg" >/dev/null 2>&1 || still="$still $pkg"
  done
  echo "$still"
}
ensure_input() {
  # X's libinput driver accepts a device only once the udev database has tagged
  # it as an input device. This guest boots a bare init, so udevd never ran: the
  # kernel had QEMU's USB tablet and X ignored it, which is exactly the pointer
  # that cannot be moved at all. `setup-xorg-base` does this on a normal Alpine
  # install; the same work has to happen here before Xorg looks for a pointer.
  for module in uhci_hcd usbhid psmouse; do
    modprobe "$module" >/dev/null 2>&1 && audit "loaded input module: $module"
  done
  announce "starting the udev daemon so Xorg accepts the mouse and keyboard"
  mkdir -p /run/udev
  if command -v udevd >/dev/null 2>&1; then
    udev_pid=$(pidof udevd 2>/dev/null || true)
    if [ -z "$udev_pid" ]; then
      udevd --daemon >/dev/null 2>&1 || udevd -d >/dev/null 2>&1 ||
        /lib/udev/udevd -d >/dev/null 2>&1 || true
      sleep 1
    fi
    if command -v udevadm >/dev/null 2>&1; then
      udevadm trigger --action=change >/dev/null 2>&1 || true
      udevadm settle --timeout=10 >/dev/null 2>&1 || true
    fi
  fi
  if pidof udevd >/dev/null 2>&1; then
    udev_state="running $(pidof udevd)"
  else
    udev_state="not running"
  fi
  audit "udev at $(elapsed): $udev_state"
  audit "input devices: $(grep -E '^(N|H):' /proc/bus/input/devices 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
  write_input_conf
}

write_input_conf() {
  # libinput only accepts a device that the udev database has tagged ID_INPUT.
  # Starting udevd is the normal path; this is the fallback for the guest that
  # boots without it: evdev reads /dev/input/eventN directly, so X gets a
  # pointer even when nothing tags the device. Without this the root cursor sits
  # at the centre of the screen and never moves, because X has no pointer at all.
  conf=/etc/X11/xorg.conf.d/30-webpc-input.conf
  INPUT_NODES=0
  if ! have_driver evdev; then
    timeout 120 apk add --no-cache xf86-input-evdev >/dev/null 2>&1 || true
  fi
  if ! have_driver evdev; then
    rm -f "$conf"
    audit "input config: no evdev driver and no udev tag, so X has no pointer driver"
    return 0
  fi
  tagged=
  if command -v udevadm >/dev/null 2>&1; then
    for dev in /sys/class/input/event*; do
      [ -e "$dev" ] || continue
      if udevadm info --query=property --path="$dev" 2>/dev/null | grep -q '^ID_INPUT=1'; then
        tagged=1
        break
      fi
    done
  fi
  if [ -n "$tagged" ]; then
    rm -f "$conf"
    audit "input config: udev tags the input devices, libinput keeps them"
    return 0
  fi
  [ -r /proc/bus/input/devices ] || return 0
  : > "$conf"
  n=0
  current=
  while IFS= read -r line; do
    case "$line" in
      'N: Name='*) current=$(printf '%s' "$line" | sed 's/^N: Name="//; s/"$//') ;;
      'H: Handlers='*)
        handlers=$(printf '%s' "$line" | sed 's/^H: Handlers=//')
        node=
        for h in $handlers; do
          case "$h" in event*) node="/dev/input/$h" ;; esac
        done
        [ -n "$node" ] || continue
        [ -e "$node" ] || continue
        n=$((n + 1))
        {
          echo 'Section "InputDevice"'
          echo "  Identifier \"WebPC input $n\""
                    echo '  Driver "evdev"'
          # AutoServerLayout is what makes X actually use the device: with no
          # ServerLayout section X only picks the core pointer implicitly, and
          # then only for a "mouse" driver. This option adds each section to the
          # implied layout, so a static device works without a layout at all.
          echo '  Option "AutoServerLayout" "true"'

          echo "  Option \"Device\" \"$node\""
          echo "  Option \"Name\" \"$current\""
          case "$handlers" in
            *kbd*) echo '  Option "XkbRules" "evdev"' ;;
          esac
          echo 'EndSection'
        } >> "$conf"
        ;;
    esac
  done < /proc/bus/input/devices
  INPUT_NODES=$n
  if [ "$n" -gt 0 ]; then
    audit "input config: $n event devices handed to evdev because udev does not tag them"
  else
    audit "input config: no /dev/input/event* nodes exist at all, so no pointer can be attached"
    rm -f "$conf"
  fi
}

ensure_swap() {
  # Every guest page lives in the browser tab, so a guest that fills its RAM
  # takes the whole page down with it: that is what a reload during Prism's
  # startup was. Guest swap parks the least recently used pages on the guest's
  # own disk, which keeps Xorg and Prism alive on a tight RAM budget instead of
  # the kernel or the browser killing them. It is only created when the root
  # filesystem really has room for it.
  grep -q '^/swapfile ' /proc/swaps 2>/dev/null && { audit "swap: /swapfile already active"; return 0; }
  want=${WEBPC_SWAP_MB:-512}
  if [ ! -f /swapfile ]; then
    free_kb=$(df -k / 2>/dev/null | awk 'NR==2 {print $4}')
    case "${free_kb:-}" in ''|*[!0-9]*) free_kb=0 ;; esac
    if [ "$free_kb" -lt 700000 ]; then
      audit "swap: skipped, only ${free_kb} kB free on /"
      return 1
    fi
    announce "creating ${want} MiB of guest swap so Prism does not exhaust RAM"
    if ! dd if=/dev/zero of=/swapfile bs=1M count="$want" 2>/dev/null; then
      rm -f /swapfile
      audit "swap: could not write /swapfile"
      return 1
    fi
  fi
  chmod 600 /swapfile 2>/dev/null || true
  mkswap /swapfile >/dev/null 2>&1 || { audit "swap: mkswap unavailable, no swap"; rm -f /swapfile; return 1; }
  if swapon /swapfile >/dev/null 2>&1; then
    audit "swap: ${want} MiB active at $(elapsed)"
    return 0
  fi
  audit "swap: swapon failed, the kernel has no swap support"
  return 1
}

report_memory() {
  # Memory is the limit this guest keeps hitting from inside the browser, so
  # every report carries its own numbers instead of a guess about them.
  audit "memory at $(elapsed): $(free -m 2>/dev/null | sed -n '2p' | tr -s ' ')"
  audit "swap at $(elapsed): $(free -m 2>/dev/null | sed -n '3p' | tr -s ' ')"
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
  # is present. Nothing is downloaded here: ensure_graphics_packages() already
  # fetched openbox in the shared transaction, and probing for a manager used to
  # cost two more index downloads and up to four minutes of root paint.
  for wm in openbox jwm twm fluxbox matchbox-window-manager; do
    command -v "$wm" >/dev/null 2>&1 || continue
    run_window_manager "$wm" && { audit "window manager: $wm at $(elapsed)"; return 0; }
    audit "window manager: $wm did not start"
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
  while [ "$n" -lt 45 ]; do
    if ! kill -0 "$xpid" 2>/dev/null; then
      wait "$xpid"
      status=$?
      audit "Xorg exited with status $status during $label"
      cp "$LOG" "/var/log/webpc-xorg-$label.log" 2>/dev/null || true
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
          cp "$LOG" "/var/log/webpc-xorg-$label.log" 2>/dev/null || true
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
  cp "$LOG" "/var/log/webpc-xorg-$label.log" 2>/dev/null || true
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
  # The root colour is a state code the user can read off the canvas when no
  # window can be drawn: blue means the stack is ready, orange means graphics
  # packages never installed, purple means the guest has no input device at all.
  # That is the difference between another blind round trip and one word back.
  color='#203a5f'
  reason='graphics and input ready'
  if [ -n "${GRAPHICS_MISSING:-}" ]; then
    color='#b35c00'
    reason="graphics support missing$GRAPHICS_MISSING"
  elif [ "${INPUT_NODES:-0}" -eq 0 ]; then
    color='#6b1f6b'
    reason='no input event device was found in the guest'
  fi
  if command -v xsetroot >/dev/null 2>&1; then
    xsetroot -solid "$color" 2>/dev/null && audit "painted the X root window $color: $reason"
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
  # The launcher's own status window is named "webpcstatus" with the title
  # "WebPC guest display" so it can never be mistaken for Prism's window here.
  command -v xwininfo >/dev/null 2>&1 || { echo 2; return 0; }
  DISPLAY=:0 timeout 8 xwininfo -root -tree 2>/dev/null | grep -ciE 'prism|minecraft|java'
}

status_window() {
  # $1 window title, $2 body text. The canvas is the only channel this user can
  # reliably report from, so progress and failures are drawn on it instead of
  # being written to a serial log nobody can see while X owns the framebuffer.
  # The title deliberately avoids the word Prism: prism_window_count() greps
  # window names, and a status window must never count as Prism's own.
  command -v xmessage >/dev/null 2>&1 || return 1
  close_status_window
  printf '%s\n' "$2" > "$STATUS_FILE" || return 1
  xmessage -name webpcstatus -title "$1" -file "$STATUS_FILE" -geometry 96x22+10+10 >/dev/null 2>&1 &
  STATUS_PID=$!
  sleep 1
  kill -0 "$STATUS_PID" 2>/dev/null
}

close_status_window() {
  [ -n "${STATUS_PID:-}" ] || return 0
  kill "$STATUS_PID" 2>/dev/null || true
  STATUS_PID=
}

report_on_console() {
  # A failed graphics install is exactly the case where no X client exists to
  # draw a report: xmessage is one of the packages that may be missing. X then
  # owns the scanout, so the canvas shows one flat root colour and nothing about
  # why Prism is absent. Stop the server, hand the framebuffer console back and
  # print the reasons: the canvas then carries the diagnosis as readable text.
  if pidof Xorg >/dev/null 2>&1; then
    audit "prism launcher: stopping Xorg so the report can use the console"
    kill $(pidof Xorg) 2>/dev/null || true
    v=0
    while [ "$v" -lt 5 ] && pidof Xorg >/dev/null 2>&1; do
      sleep 1
      v=$((v + 1))
    done
    pidof Xorg >/dev/null 2>&1 && kill -9 $(pidof Xorg) 2>/dev/null || true
    sleep 1
  fi
  console_report "$REPORT_FILE"
  audit "prism launcher: reasons printed on the guest console because no X client could show them"
}

show_report() {
  # What the serial log knows, on the canvas: a tablet cannot paste a
  # transcript, and a screenshot of the guest screen is the report that works.
  {
    echo "Prism Launcher is not showing a window."
    echo "waited ${n}s  windows=$windows  alive=$alive"
    echo ""
    echo "--- launcher ---"
    grep -E 'graphics support|udev at|input config|input devices|window manager|painted the X root|memory at|swap at|prism launcher' "$AUDIT" 2>/dev/null | tail -n 10
    echo "--- prism output ---"
    tail -n 8 "$PRISM_LOG" 2>/dev/null || echo '(empty)'
    echo "--- Xorg input ---"
    grep -iE 'input device|pointer|tablet|mouse|evdev' "$LOG" 2>/dev/null | tail -n 6 || echo '(no Xorg input lines)'
    echo "--- X windows ---"
    DISPLAY=:0 timeout 8 xwininfo -root -tree 2>/dev/null | head -n 5 || echo '(xwininfo unavailable)'
  } > "$REPORT_FILE"
  cat "$REPORT_FILE" >> "$AUDIT"
  status_window "WebPC guest display" "$(cat "$REPORT_FILE")" || report_on_console
}

start_prism() {
  # Prism used to be exec'd, so a launcher that never drew anything left one
  # trace only: the screen stayed on the root paint. Run it in the background,
  # keep its own output in a log, say on the canvas what is happening, and
  # record whether a window appeared and what it printed when it did not.
  #
  # The wait is generous because the whole machine is software-emulated: Xorg
  # takes minutes and a Qt 6 application started under single-threaded TCG can
  # take several more. A 25 second window probe reported a healthy start as a
  # failure, and the user only ever saw the root paint either way. The window
  # list is polled every 5 s rather than every second, so this loop does not
  # compete with Prism for the single emulated CPU it is starting on.
  : > "$PRISM_LOG"
  for stale in $(pidof xmessage 2>/dev/null); do kill "$stale" 2>/dev/null || true; done
  audit "prism launcher: starting on $DISPLAY at $(elapsed)"
  report_memory
  status_window "WebPC guest display" "Prism Launcher is starting.

This window is drawn by the guest's own X server. Seeing it means the
display, its window manager and this canvas all work, and that only
Prism's own window would be missing.

Prism can take minutes to open under software CPU emulation. This
message updates every 30 seconds."
  prismlauncher "$@" >>"$PRISM_LOG" 2>&1 &
  prism_pid=$!
  n=0
  windows=2
  while [ "$n" -lt "$PRISM_WINDOW_WAIT" ]; do
    if ! prism_alive; then
      windows=none
      audit "prism launcher: exited after ${n}s at $(elapsed)"
      break
    fi
    windows=$(prism_window_count)
    case "$windows" in
      ''|*[!0-9]*) windows=unknown ;;
      2) windows=unknown; break ;;
      0)
        if [ "$n" -gt 0 ] && [ $((n % 30)) -eq 0 ]; then
          status_window "WebPC guest display" "Prism Launcher is still starting (${n} s).

Seeing this window means the guest display and its window manager work:
Xorg paints, the manager maps windows, and the canvas shows them. Prism
itself has not opened its window yet."
        fi
        ;;
      *) break ;;
    esac
    sleep 5
    n=$((n + 5))
  done
  alive=no
  prism_alive && alive=yes
  audit "prism launcher: pid $prism_pid alive=$alive windows=$windows after ${n}s at $(elapsed)"
  audit "prism launcher output: $(grep -m 3 -iE 'error|cannot|could not|failed|abort|no qt platform' "$PRISM_LOG" 2>/dev/null | tr '\n' '|')"
  case "$windows" in
    none|0) show_report ;;
    unknown) audit "prism launcher: no window list tool, so a mapped window cannot be confirmed" ;;
    *) close_status_window; audit "prism launcher: window mapped after ${n}s at $(elapsed)" ;;
  esac
  wait "$prism_pid"
}

ensure_mounts
load_drm
ensure_support
ensure_graphics_packages
# udev has to be up before Xorg starts: X only accepts the devices the udev
# database already tags, and Xorg starts further down in this script.
ensure_input
# Swap has to exist before Xorg and Prism allocate: they are what pushes the
# guest over its RAM, and the whole browser tab goes with it when that happens.
ensure_swap
report_memory

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
  # Nobody can read a log file from the tablet and, with Xorg dead, the canvas
  # stays black. So the reasons are printed on the guest console, where a
  # screenshot of the canvas is the report that actually reaches the user.
  {
    echo "Xorg could not start on this guest's VGA adapter."
    echo "variants tried: $(grep -h 'Trying Xorg variant' "$AUDIT" 2>/dev/null | sed 's/.*Trying Xorg variant: //' | tr '\n' ' ')"
    echo ""
    echo "--- guest ---"
    grep -E 'kernel:|dri:|fb0:|drm drivers:|drm connectors:|xorg binary:|mounts:|support:|graphics support' "$AUDIT" 2>/dev/null | tail -n 8
    echo "--- Xorg errors ---"
    for f in /var/log/webpc-xorg-*.log "$LOG"; do
      [ -s "$f" ] || continue
      printf '%s: %s\n' "$(basename "$f")" "$(grep -hE '\(EE\)|No devices|no screens|Fatal server' "$f" 2>/dev/null | head -n 3 | tr '\n' '|')"
    done
  } > "$REPORT_FILE"
  cat "$REPORT_FILE" >> "$AUDIT"
  console_report "$REPORT_FILE"
  audit "no display variant produced a server that stays up; reasons printed on the guest console"
  echo "No Xorg variant stayed up on display :0; the reasons are printed on the guest console." >&2
  exit 20
fi

start_prism "$@"
