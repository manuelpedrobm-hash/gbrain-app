#!/bin/zsh
# Compila Cerebro.app en ~/Applications (ventana propia del panel). Uso: zsh panel/app-mac/build.sh
set -eu
HERE="${0:A:h}"
APP="$HOME/Applications/Cerebro.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
/usr/bin/swiftc -O -o "$APP/Contents/MacOS/Cerebro" "$HERE/Cerebro.swift" -framework Cocoa -framework WebKit
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Cerebro</string>
  <key>CFBundleDisplayName</key><string>Cerebro</string>
  <key>CFBundleIdentifier</key><string>com.__USER__.cerebro</string>
  <key>CFBundleExecutable</key><string>Cerebro</string>
  <key>CFBundleIconFile</key><string>Cerebro</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict></plist>
EOF
# Icono: el mismo del panel (verde con nodos), dibujado a 1024 px.
if [ ! -f "$APP/Contents/Resources/Cerebro.icns" ]; then
  T=$(mktemp -d)
  cat > "$T/i.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="1024" height="1024"><rect x="1" y="1" width="30" height="30" rx="7" fill="#2f6f5e"/><circle cx="11" cy="13" r="3" fill="#fff"/><circle cx="21" cy="11" r="2.4" fill="#fff"/><circle cx="19" cy="21" r="3.2" fill="#fff"/><path d="M11 13 21 11M11 13l8 8M21 11l-2 10" stroke="#fff" stroke-width="1.6"/></svg>
EOF
  /usr/bin/qlmanage -t -s 1024 -o "$T" "$T/i.svg" >/dev/null 2>&1 || true
  if [ -f "$T/i.svg.png" ]; then
    mkdir "$T/C.iconset"
    for s in 16 32 128 256 512; do
      /usr/bin/sips -z $s $s "$T/i.svg.png" --out "$T/C.iconset/icon_${s}x${s}.png" >/dev/null
      /usr/bin/sips -z $((s*2)) $((s*2)) "$T/i.svg.png" --out "$T/C.iconset/icon_${s}x${s}@2x.png" >/dev/null
    done
    /usr/bin/iconutil -c icns "$T/C.iconset" -o "$APP/Contents/Resources/Cerebro.icns" || true
  fi
  rm -rf "$T"
fi
/usr/bin/codesign --force --sign - "$APP" >/dev/null 2>&1 || true
print "Listo: $APP"
