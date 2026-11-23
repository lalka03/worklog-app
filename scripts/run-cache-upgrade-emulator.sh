#!/usr/bin/env bash
set -euo pipefail
PKG=com.worklog.app.yandex.upgradeqa
wait_for_text() {
  local target="$1" dump
  for ((i=1;i<=24;i++)); do
    adb shell uiautomator dump /sdcard/worklog-window.xml >/dev/null 2>&1 || true
    dump="$(adb shell cat /sdcard/worklog-window.xml 2>/dev/null || true)"
    if [[ "$dump" == *"$target"* ]]; then
      echo "UPGRADE_ANDROID_$target"
      return 0
    fi
    if [[ "$dump" == *"LAB_FAIL_"* ]]; then
      echo "$dump" | grep -o 'LAB_FAIL_[A-Za-z0-9_]*' | sort -u
      return 1
    fi
    sleep 3
  done
  echo "MISSING_ANDROID_SCREEN_STATUS_$target"
  adb logcat -d -t 250 | tail -n 250 || true
  return 1
}
adb install /tmp/worklog-upgrade-v1.apk
adb shell am start -n "$PKG/.MainActivity"
wait_for_text V1_READY
# This must be an in-place upgrade: never uninstall, pm clear, or delete data.
adb install -r /tmp/worklog-upgrade-v2.apk
adb shell am force-stop "$PKG"
adb shell am start -n "$PKG/.MainActivity"
wait_for_text V2_PASS
echo 'UPGRADE_ANDROID_IN_PLACE_OK: old WebView cache, offline draft, corrupt isolation and native Keystore synthetic token retained'
