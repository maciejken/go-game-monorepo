# GoGame iOS client

Native SwiftUI client for the same server the web client (`../client`) uses — currently just login/register and your game list. No board view, moves, or push notifications yet (see the plan for the full roadmap).

## Requirements

- Xcode 16+ (uses the modern file-system-synchronized project format).
- iOS 17+ (Simulator or device).

## Setup

1. Open `GoGame.xcodeproj` in Xcode.
2. `Config.swift` points at the server (`https://igo5.online` by default). Edit it if you're pointing at a different server.
3. Build & run (`⌘R`) — pick any iPhone Simulator, or your own device (device runs need a signing team set under the target's Signing & Capabilities, since Simulator builds don't require one).

## Why HTTPS is required, not optional

The server's session cookie is marked `Secure` (`server/src/auth.ts`). `URLSession` silently refuses to store a `Secure` cookie unless the connection is real TLS — unlike a browser, it does **not** make an exception for `localhost`. That means testing against a plain-HTTP address (including `http://localhost:3000`) will look like login "doesn't stick": register/login succeed, but the very next request comes back logged out. Point `Config.swift` at an `https://` address to avoid this.

## Command-line build/verify (no Xcode UI needed)

```sh
xcodebuild build -project GoGame.xcodeproj -scheme GoGame -destination 'platform=iOS Simulator,name=iPhone 17'
```

To actually see it running:

```sh
xcrun simctl boot "iPhone 17"
xcrun simctl install booted <path-to-built-.app-from-DerivedData>
xcrun simctl launch booted com.maciejkedra.gogame
xcrun simctl io booted screenshot out.png
```
