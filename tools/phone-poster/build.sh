#!/usr/bin/env bash
# Build socheli-poster.apk with the Android SDK command-line tools only —
# no Gradle, no dependency downloads (dodges the geo-blocked Google Maven).
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:?set ANDROID_HOME to your Android SDK path}"
BT="$SDK/build-tools/35.0.0"
ANDROID_JAR="$SDK/platforms/android-35/android.jar"
MIN_SDK=26
TARGET_SDK=34

AAPT2="$BT/aapt2"; D8="$BT/d8"; ZIPALIGN="$BT/zipalign"; APKSIGNER="$BT/apksigner"
for t in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER"; do [ -x "$t" ] || { echo "missing tool: $t"; exit 1; }; done
[ -f "$ANDROID_JAR" ] || { echo "missing android.jar: $ANDROID_JAR"; exit 1; }

rm -rf build && mkdir -p build/gen build/classes build/dex build/res

echo "1/6 aapt2 compile resources"
"$AAPT2" compile --dir res -o build/res.zip

echo "2/6 aapt2 link (manifest + resources → base.apk, gen R.java)"
"$AAPT2" link -o build/base.apk \
  -I "$ANDROID_JAR" \
  --manifest AndroidManifest.xml \
  --java build/gen \
  --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
  --auto-add-overlay \
  build/res.zip

echo "3/6 javac (compile sources against android.jar)"
find src build/gen -name '*.java' > build/sources.txt
javac --release 8 -classpath "$ANDROID_JAR" -d build/classes @build/sources.txt

echo "4/6 d8 (classes → dex)"
find build/classes -name '*.class' > build/classes.txt
"$D8" --release --min-api "$MIN_SDK" --lib "$ANDROID_JAR" --output build/dex @build/classes.txt

echo "5/6 package dex into apk + zipalign"
cp build/base.apk build/app-unsigned.apk
( cd build/dex && zip -q ../app-unsigned.apk classes.dex )
"$ZIPALIGN" -f -p 4 build/app-unsigned.apk build/app-aligned.apk

echo "6/6 sign (debug keystore)"
KS=debug.keystore   # persists across builds (build/ is wiped) so the signature stays stable
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Socheli Poster Debug,O=Socheli,C=US" >/dev/null 2>&1
fi
"$APKSIGNER" sign --ks "$KS" --ks-pass pass:android --ks-key-alias androiddebugkey \
  --out socheli-poster.apk build/app-aligned.apk
"$APKSIGNER" verify --print-certs socheli-poster.apk >/dev/null && echo "✓ signature OK"

echo ""
echo "✅ built: $(pwd)/socheli-poster.apk  ($(du -h socheli-poster.apk | cut -f1))"
echo "   install: $SDK/platform-tools/adb install -r socheli-poster.apk"
