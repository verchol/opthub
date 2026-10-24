#!/usr/bin/env python3
"""envfile — every secret opthub can use, from one file, with or without 1Password.

Copy `.env.example` to `.env` at the repo root and fill in what you need. Each value
is either a literal or an `op://vault/item/field` reference; references are resolved
with the 1Password CLI (`op read`) when it is installed, and refused with a clear
message when it is not — so a user without 1Password just writes literals.

    python3 tools/envfile.py check                         # what is set, masked; what it enables
    python3 tools/envfile.py run -- python3 src/run.py     # run any command with .env loaded

Tools that spend money (tools/rerun.py) call load() themselves. A variable already
set in the shell wins over the file, so a one-off `export` still overrides.
`.env` is gitignored; this file never prints a value, only its first four characters.
"""
import os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT = os.environ.get("OPTHUB_ENV_FILE") or os.path.join(ROOT, ".env")

# name -> (what it enables, required for that feature)
KNOWN = {
    "CLAUDE_CODE_OAUTH_TOKEN": "rerun.py run/judge in the Docker sandbox; e2b arms (subscription billing)",
    "ANTHROPIC_API_KEY": "API-billed runs only (e2b AUTH_MODE=api-key); leave empty on a Claude plan",
    "JEV_API_KEY": "Jev arms of J2 email-triage and J3 session-triage; hub Triage",
    "JEV_ENDPOINT": "optional Jev endpoint override",
    "JEV_MODEL": "optional Jev model override",
    "E2B_API_KEY": "E2B microVM arms (sandbox/e2b)",
    "E2B_TEMPLATE": "E2B template name (sandbox/e2b/harness)",
    "AWS_ACCESS_KEY_ID": "Bedrock upstream (Kong template, ULT routing)",
    "AWS_SECRET_ACCESS_KEY": "Bedrock upstream",
    "AWS_REGION": "Bedrock region",
    "LANGSMITH_API_KEY": "optional tracing of sandbox runs",
    "HUB_PASSWORD": "basic-auth password of the deployed read-only hub",
    "OLLAMA_HOST": "local open-weights model for J2 / shadow judge (not a secret)",
}


def parse(path):
    """KEY=value lines; `export` prefix, quotes and trailing comments allowed."""
    out = {}
    for n, line in enumerate(open(path), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        if "=" not in line:
            sys.stderr.write(f"{path}:{n}: not KEY=value, ignored (a value split across lines?)\n")
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if v[:1] in "\"'" and v[-1:] == v[:1]:
            v = v[1:-1]
        elif " #" in v:
            v = v.split(" #", 1)[0].rstrip()
        out[k.strip()] = v
    return out


def resolve(name, value):
    if not value.startswith("op://"):
        return value
    if not shutil.which("op"):
        sys.exit(f"{name} is a 1Password reference but the `op` CLI is not installed —\n"
                 f"put the literal value in .env instead")
    r = subprocess.run(["op", "read", value], capture_output=True, text=True,
                       timeout=float(os.environ.get("OP_TIMEOUT_MS", "15000")) / 1000)
    if r.returncode:
        sys.exit(f"{name}: `op read` failed — {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def load(path=DEFAULT):
    """Put .env into os.environ without overriding the shell. Empty values are skipped."""
    if not os.path.exists(path):
        return []
    loaded = []
    for k, v in parse(path).items():
        if v and k not in os.environ:
            os.environ[k] = resolve(k, v)
            loaded.append(k)
    return loaded


def mask(v):
    return f"{v[:4]}… ({len(v)} chars)" if len(v) > 8 else "set"


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("check", "run"):
        sys.exit(__doc__.strip().split("\n\n")[2])
    if args[0] == "run":
        cmd = args[2:] if args[1:2] == ["--"] else args[1:]
        if not cmd:
            sys.exit("usage: envfile.py run -- <command> [args]")
        load()
        os.execvp(cmd[0], cmd)
    shell = {k for k in KNOWN if k in os.environ}
    loaded = set(load())
    print(f"file : {DEFAULT}" + ("" if os.path.exists(DEFAULT) else "   (missing — cp .env.example .env)"))
    print(f"op   : {'installed' if shutil.which('op') else 'not installed — op:// references will fail'}\n")
    for k, what in KNOWN.items():
        v = os.environ.get(k, "")
        src = "shell" if k in shell else (".env" if k in loaded else "")
        state = f"{mask(v):<22} {src:<5}" if v else f"{'-':<22} {'':<5}"
        print(f"  {k:<24} {state}  {what}")
    if os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        print("\nwarning: both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set. Claude Code prefers the\n"
              "API key, which moves runs onto API billing. rerun.py never passes it into the sandbox.")


if __name__ == "__main__":
    main()
