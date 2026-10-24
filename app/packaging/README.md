# Packaging the CLI

`opt` installed through Homebrew, with its state out of the Cellar.

## Build and install locally

```sh
./packaging/make-dist.sh                 # tarball + sha256, formula updated
brew install verchol/opthub/opthub       # from the local tap
```

The local tap lives at
`$(brew --repository)/Library/Taps/verchol/homebrew-opthub` and points at a
`file://` tarball, so `brew install` works on this machine and nowhere else.

## Publish it so others can install

```sh
./packaging/publish-tap.sh --yes
```

Creates a **public** GitHub repo `homebrew-opthub`, uploads the tarball as a
release asset, and commits a formula pointing at that URL. After that:

```sh
brew tap verchol/opthub && brew install opthub
```

Read `publish-tap.sh`'s header before running it — it publishes the harness
source.

## Where state goes

The formula installs a wrapper that sets `OPT_HOME=~/.opthub` (override it in
the environment). `lib/state.mjs` resolves it:

| run as | results, exports, tuning go to |
|---|---|
| a clone (`node opt.mjs …`) | the clone itself, as always |
| `brew install`ed | `~/.opthub/` |

Assets the harness only reads — `tasks/`, `flows/`, `config/`, `lib/` — stay
with the code either way.

## What is excluded from the tarball

`.env`, `results/`, `exports/`, `replays/`, `tuning/`, `local-sessions/`,
`node_modules/`, `deploy/`, `packaging/`. `make-dist.sh` also greps the stage
for credential-shaped strings and refuses to build if it finds one — the
exclusion list is not the only guard, because a missing entry in it would be a
silent leak.

## Known wrinkle

`opt` is shadowed on this machine by `~/.local/bin/opt`, a symlink to the clone
from before packaging existed. Both work; they are different copies. To make the
Homebrew one win, remove the symlink (`rm ~/.local/bin/opt`) or put
`/opt/homebrew/bin` earlier in `PATH`.
