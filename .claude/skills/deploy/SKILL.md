---
name: deploy
description: Commit and push go-game-monorepo to the test server (Pi) or production (Mikrus), which build and restart via pm2 on push. Use when the user asks to deploy, ship, or push changes live.
---

# Deploy

Two of this repo's remotes are bare git repos that deploy on push, and
neither of them is GitHub:

| remote | host | serves | what it is |
| --- | --- | --- | --- |
| `test` | `pi@192.168.0.67:/home/pi/projects/go-server.git` | `test.igo5.online` | the Raspberry Pi, the test server |
| `prod` | `ssh://igo5@srv41.mikr.us:10120/home/igo5/projects/go-server.git` | `igo5.online` | Mikrus, production |
| `github` | `https://github.com/maciejken/go-game-monorepo.git` | — | a mirror; pushing there deploys nothing |

There is no `origin` remote. `main` tracks `github`, so `git push` on its
own goes to the mirror and deploys nothing.

Both deploying remotes have a post-receive hook that installs dependencies,
**builds the new code on the server**, and restarts the `go-server` pm2
process — there is nothing to build locally first. The hook's output streams
back inline in the push command's own output, so you can watch for it to
confirm the deploy completed successfully.

## Steps

1. **Commit**: see the `commit` skill for how to commit changes to the local
   repo.

2. **Push**: `git push test` for the Pi, or `git push prod` for production.
   `push.default` is `simple` and the branch name matches on both sides, so
   this pushes the current branch (normally `main`) to the same branch on
   that remote; the hook does the rest. Its output streams back inline and
   typically takes a few seconds to under a minute:
   - `npm` install/audit output
   - `[PM2] Applying action restartProcessId on app [go-server]`
   - a pm2 status table showing `go-server` as `online` with a bumped
     restart count (`↺`)
   - `Deployed to /home/pi/projects/go-server`

   If that table doesn't appear, the deploy did not complete — check the
   push command's output for an error rather than assuming success.

3. **Confirm**: sanity-check with a `curl` against the host that was
   actually deployed — `https://test.igo5.online` for `test`,
   `https://igo5.online` for `prod` — on an endpoint relevant to what
   changed, to verify the restarted process is serving the new code and not
   just that pm2 restarted. Curling the other host proves nothing: it is a
   different server that this push never touched.

   A route that doesn't exist yet on a server answers `200`, not `404`:
   unknown paths fall through to the SPA's `index.html`. So `401` or `403`
   from a new authenticated endpoint means it is deployed; `200` with HTML
   means it is not.

## Notes

- **Ask every time, for each remote.** Only push when the user has asked for
  this specific deploy. Both pushes restart a server somebody may be using
  mid-game, and `prod` is the one real people are playing on — treat it as
  the riskier of the two and say what will happen before doing it.
- Environment variables live in the pm2 config on each server, not in this
  repo. `pm2 restart` does **not** re-read that file; changing a variable
  needs `pm2 startOrRestart <config> --update-env` (and `pm2 save`) on the
  server itself, which is a separate ask from a deploy.
- A push deploys the server and the web client. The iOS app ships through
  Xcode and TestFlight, so nothing here updates it.
