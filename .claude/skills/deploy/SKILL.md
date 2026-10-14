---
name: deploy
description: Build, commit, and push go-game-monorepo to the Pi (origin), which auto-deploys via pm2 on push. Use when the user asks to deploy, ship, or push changes live.
---

# Deploy to the Pi

This repo's `origin` remote is a bare git repo on the Raspberry Pi
(`pi@192.168.0.67:/home/pi/projects/go-server.git`), not GitHub (that's the
`github` remote, a separate (default) mirror — pushing there does not deploy
anything). The Pi's repo has a post-receive hook that installs/restarts the
`go-server` pm2 process after building the new code, so a simple `git push test` from this repo is all that's needed to deploy changes to the live server. The hook's output streams
back inline in the push command's own output, so you can watch for it to confirm the deploy completed successfully.

## Steps

1. **Commit**: see the `commit` skill for how to commit changes to the local test repo.

2. **Push**: `git push test` (pushes the current branch; the Pi's
   post-receive hook does the rest). The hook's output streams back inline
   in the push command's own output — watch for it, this typically takes a
   few seconds to under a minute:
   - `npm` install/audit output
   - `[PM2] Applying action restartProcessId on app [go-server]`
   - a pm2 status table showing `go-server` as `online` with a bumped
     restart count (`↺`)
   - `Deployed to /home/pi/projects/go-server`

   If that table doesn't appear, the deploy did not complete — check the
   push command's output for an error rather than assuming success.

3. **Confirm**: optionally sanity-check with a `curl` against a known
   endpoint on `https://igo5.online` relevant to what changed, to verify the
   restarted process is actually serving the new code (not just that pm2
   restarted).

## Notes

- Only push when the user has asked for this specific deploy — a push here
  immediately restarts the live production server other people may be using
  mid-game.
- `git push test` with no branch argument pushes whatever the current
  branch's configured upstream is; this repo's default has been to work
  directly on `main`.
