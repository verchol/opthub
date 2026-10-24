"""fixture — one synthetic workspace for the use-case tests and the Claude-run evals.

Everything here is SYNTHETIC: no number it produces may be quoted outside evals/.

    build(root)  writes, under root:
      projects/   four Claude Code transcripts: the three golden sessions (examples/golden/synth.py)
                  and one carrying a planted prompt and path (tools/test_onboard.py), which no
                  output that may leave the machine is allowed to contain
      home/       an empty HOME, so nothing reads the real ~/.claude/settings.json
      .env        fake credentials, so nothing reads the real .env
    env(root)    the environment every command runs in: each store relocated into root, real
                 credentials removed, and an egress trap (a proxy on a closed port) so a "free"
                 command that reaches the network fails instead of passing.
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "examples", "golden"))
sys.path.insert(0, os.path.join(REPO, "tools"))
import envfile, synth  # noqa: E402
import test_onboard as to  # noqa: E402

PLANTED, PLANTED_PATH = to.PLANTED, to.PLANTED_PATH
SINCE = "2026-08-25"                                 # covers the planted session (2026-09-01) and the golden ones
FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKE-0123456789abcdef"
FAKE_TOKEN = "sk-ant-oat01-FAKETOKEN-0123456789abcdef"
SECRETS = set(envfile.KNOWN) | {"LANGCHAIN_API_KEY", "HF_TOKEN", "OPENAI_API_KEY", "OP_SERVICE_ACCOUNT_TOKEN"}


def build(root):
    projects = os.path.join(root, "projects")
    ids = synth.write_sessions(projects, os.path.join(REPO, "examples", "golden", "repo"))
    planted = "0b5e7c1d-0000-4000-8000-00000000f1a7"
    to.write_session(projects, planted, to.T0, [to.req(cr=40_000 + 2_000 * i, w5=2_000, out=300) for i in range(12)],
                     subs=[("Explore", [to.req(cr=8_000, w5=500, out=80, model="claude-haiku-4-5")] * 4)])
    ids["planted"] = planted
    os.makedirs(os.path.join(root, "home", ".claude"), exist_ok=True)
    with open(os.path.join(root, ".env"), "w") as fh:
        fh.write(f"ANTHROPIC_API_KEY={FAKE_KEY}\n")
    return ids


def env(root, **extra):
    e = {k: v for k, v in os.environ.items() if k not in SECRETS}
    trap = "http://127.0.0.1:9"                       # discard port: nothing listens, every proxied request fails
    e.update(TZ="UTC", PYTHONDONTWRITEBYTECODE="1", HOME=os.path.join(root, "home"),
             OPTHUB_PROJECTS=os.path.join(root, "projects"), OPT_PROJECTS_DIR=os.path.join(root, "projects"),
             OPTHUB_RERUNS=os.path.join(root, "reruns"), OPTHUB_SCAN=os.path.join(root, "scan"),
             OPTHUB_DYNCONFIG=os.path.join(root, "dynconfig"), OPTHUB_ONBOARD=os.path.join(root, "onboard"),
             OPT_HOME=os.path.join(root, "opthome"), OPTHUB_ENV_FILE=os.path.join(root, ".env"),
             HTTP_PROXY=trap, HTTPS_PROXY=trap, http_proxy=trap, https_proxy=trap, ALL_PROXY=trap,
             NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost", NODE_USE_ENV_PROXY="1")
    e.update(extra)
    return e


if __name__ == "__main__":
    import json
    root = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: fixture.py DIR")
    print(json.dumps(build(root), indent=1))
