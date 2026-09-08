---
name: deploy
description: Build, commit, and push go-game-monorepo to the Pi (origin), which auto-deploys via pm2 on push. Use when the user asks to deploy, ship, or push changes live.
---

# Deploy to the Pi

This repo's `origin` remote is a bare git repo on the Raspberry Pi
(`pi@192.168.0.67:/home/pi/projects/go-server.git`), not GitHub (that's the
`github` remote, a separate mirror — pushing there does not deploy
anything). The Pi's repo has a post-receive hook that installs/restarts the
`go-server` pm2 process straight from what's pushed — there's no build step
on the Pi itself, so **built output must be committed**, not just source.

## Steps

1. **Build**: `npm run build` from the repo root (builds `shared` → `server`
   → `client` in order, per the root `package.json` script). This
   regenerates the tracked `client/dist/` and `server/dist/` output that the
   Pi actually serves/runs — always rebuild before deploying, even for a
   server-only or client-only change, since either can shift the built
   output's content hashes.

2. **Stage changes with `git add`, but never stage a `.gitignore` change
   that adds a `vision-service` ignore line.** That specific exclusion is a
   local-only preference (vision-service isn't meant to be tracked or
   untracked repo-wide via a shared commit) — it should stay as an uncommitted
   working-tree change, not get pushed. If `.gitignore` has other legitimate
   changes mixed in with it, split them: write the working tree to the
   commit-worthy version (everything except the `vision-service` line),
   `git add .gitignore`, then restore the working tree file to its full
   version (with `vision-service` back in) so it stays as a local uncommitted
   diff. Verify with `git diff --cached .gitignore` before committing.

   Stage everything else pending as usual, including `client/dist/` and
   `server/dist/` (they're tracked, not gitignored, precisely so a push
   deploys the built output).

3. **Commit** with a short message describing what actually changed, prefixed
   by the appropriate conventional-commit type (`feat:` for a new feature,
   `fix:` for a bug fix, etc. — ask if it's ambiguous). End the message with:
   ```
   Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
   ```

4. **Push**: `git push origin` (pushes the current branch; the Pi's
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

5. **Confirm**: optionally sanity-check with a `curl` against a known
   endpoint on `https://igo5.online` relevant to what changed, to verify the
   restarted process is actually serving the new code (not just that pm2
   restarted).

## Notes

- Only push when the user has asked for this specific deploy — a push here
  immediately restarts the live production server other people may be using
  mid-game.
- `git push origin` with no branch argument pushes whatever the current
  branch's configured upstream is; this repo's default has been to work
  directly on `main`.
