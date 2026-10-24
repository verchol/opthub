# Sandbox providers

Where an arm runs. Each provider is one directory with everything it needs: the images or
templates, the scripts that build and start them, and one `index.mjs` the app imports. The app
(`app/`) and the Python tools (`tools/rerun.py`) choose a provider; a provider never imports the app.

| provider | isolation | used by | needs |
|---|---|---|---|
| [`docker/`](docker/README.md) | a container: read-only source, one writable dir, no capabilities, egress only through an allowlisting proxy | `opt claude -p`, `opt claude optimize`, `tools/rerun.py` (default) | Docker; `CLAUDE_CODE_OAUTH_TOKEN` |
| [`e2b/`](e2b/index.mjs) | a microVM per arm, in E2B's cloud | `opt demo run`, `opt replay`, `opt run`, flows, the session optimize loop | the `e2b` package (an optional dependency); `E2B_API_KEY` |

A container shares the host kernel: read Docker as "the agent cannot touch my tree or phone home",
not "the agent cannot escape". For an untrusted agent against untrusted code, use the microVM.

## Layout

```
docker/       sandbox.sh (build | verify | run | shell | down), Dockerfile.agent, Dockerfile.egress,
              allowlist.txt, tinyproxy.conf. Images opthub/agent:0.1 and opthub/egress:0.1.
e2b/          index.mjs: the only module that loads the e2b SDK, lazily
  harness/    the default arm template: Claude Code + Python        (E2B_TEMPLATE)
  kong/       Kong AI Gateway in front of Bedrock                     (E2B_KONG_TEMPLATE)
  openmodel/  Ollama + an open-weights model
test.mjs      the boundary, checked (npm test)
```

Build an E2B template with its own script, after `e2b auth login`: `sandbox/e2b/harness/build.sh`.

## The boundary, checked

`node sandbox/test.mjs` (part of `npm test`) fails when:

- any file other than `e2b/index.mjs` loads the E2B SDK,
- a provider imports from `app/`,
- the Docker provider exists twice (it used to be vendored into `tools/sandbox/`),
- a file or symlink points outside the checkout.
