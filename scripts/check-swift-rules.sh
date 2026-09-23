#!/bin/bash
# Compiles the app's rules files together with the fixture runner and runs
# them against shared/fixtures/rules.json. No Xcode target involved: the
# rules are plain Foundation code, so swiftc alone can build and check them.
set -e
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
swiftc -O \
  ios-app/GoGame/Models/BoardTypes.swift \
  ios-app/GoGame/Models/Scoring.swift \
  ios-app/GoGame/Models/Rules.swift \
  ios-app/GoGame/Models/ClockRules.swift \
  ios-app/GoGame/Models/GameFlow.swift \
  ios-app/Tests/main.swift \
  -o "$OUT/rule-fixtures"
"$OUT/rule-fixtures" shared/fixtures/rules.json
