#!/bin/sh
# Install the complete Minecraft Java runtime into the baked WebPC Alpine disk.
# Run only inside the target x86_64 Alpine root filesystem during the disk build.
set -eu

ALPINE_VERSION="$(cut -d. -f1,2 /etc/alpine-release)"
if [ "$ALPINE_VERSION" != "3.21" ]; then
  echo "Expected Alpine 3.21, found $ALPINE_VERSION" >&2
  exit 10
fi

# Ensure the matching community repository is enabled; Prism Launcher and
# OpenJDK 21 are published there for Alpine 3.21 x86_64.
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
set -eu
export DISPLAY=:0
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export QT_QPA_PLATFORM=xcb
export QT_X11_NO_MITSHM=1
mkdir -p /var/log /tmp/.X11-unix
if [ ! -e /dev/dri/card0 ]; then
  modprobe bochs_drm >/dev/null 2>&1 || true
fi
if ! pidof Xorg >/dev/null 2>&1; then
  Xorg :0 -config /etc/X11/xorg.conf.d/20-webpc.conf -noreset -nolisten tcp -keeptty -logfile /var/log/webpc-xorg.log vt1 &
  xpid=$!
  n=0
  while [ "$n" -lt 20 ] && [ ! -S /tmp/.X11-unix/X0 ]; do
    kill -0 "$xpid" 2>/dev/null || break
    sleep 1
    n=$((n + 1))
  done
fi
if [ ! -S /tmp/.X11-unix/X0 ]; then
  echo "Xorg did not create display :0" >&2
  tail -n 80 /var/log/webpc-xorg.log 2>/dev/null || true
  exit 20
fi
exec prismlauncher "$@"
WEBPC_MC_EOF
chmod 755 /usr/local/bin/webpc-minecraft-display

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
  apk info -e openjdk21-jre prismlauncher xorg-server xf86-input-libinput mesa-dri-gallium mesa-gl mesa-egl
} > /etc/webpc-minecraft-prereqs

echo "PASS: Java 21, Prism Launcher, Xorg, Mesa, fonts and audio runtime are installed in the guest disk."
