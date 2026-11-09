#!/usr/bin/env bash
# Runs the project's firebase-tools with a Java 21+ runtime, which the emulators require.
# The global JAVA_HOME is left alone: only this process gets a newer Java if needed.
#
# Lookup order: JAVA21_HOME, the java already on PATH, Homebrew openjdk, the JDK bundled
# with Android Studio.
set -euo pipefail

java_major() {
  "$1" -version 2>&1 | awk -F'"' '/version/ { split($2, v, "."); print v[1]; exit }'
}

pick_java_home() {
  local candidates=()
  [ -n "${JAVA21_HOME:-}" ] && candidates+=("$JAVA21_HOME")
  [ -n "${JAVA_HOME:-}" ] && candidates+=("$JAVA_HOME")
  for c in /opt/homebrew/opt/openjdk /usr/local/opt/openjdk \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    candidates+=("$c")
  done
  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c/bin/java" ] && [ "$(java_major "$c/bin/java")" -ge 21 ]; then
      echo "$c"
      return 0
    fi
  done
  if command -v java >/dev/null && [ "$(java_major java)" -ge 21 ]; then
    dirname "$(dirname "$(command -v java)")"
    return 0
  fi
  return 1
}

if ! JH=$(pick_java_home); then
  echo "Java 21 or newer is required for the Firebase emulators. Set JAVA21_HOME." >&2
  exit 1
fi
export JAVA_HOME="$JH"
export PATH="$JAVA_HOME/bin:$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$DIR/node_modules/.bin/firebase" "$@"
