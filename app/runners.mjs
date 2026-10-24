/**
 * runners.mjs — where a bundle's agent actually gets its tokens from.
 *
 * `opt session export --run` and `opt tune` boot a sandbox and run Claude Code
 * in it. What answers Claude Code is a separate question from what the bundle
 * asks, and it is the interesting axis here: the same exported session can be
 * served by Anthropic, or by an open-weights model running entirely inside the
 * sandbox with no API behind it at all.
 *
 * A runner is an ordered list of steps performed before the agent starts, plus
 * the environment the agent inherits. `ANTHROPIC_BASE_URL` is the whole trick:
 * Claude Code speaks the Anthropic wire format, LiteLLM serves that format in
 * front of something else, and Claude Code cannot tell the difference.
 */

const OLLAMA_MODEL = process.env.OPENMODEL_MODEL ?? 'qwen2.5-coder:3b'
const CTX = process.env.OPENMODEL_CTX ?? '32768'

/**
 * Ollama defaults a model's context window to 2048 tokens. Claude Code's system
 * prompt and tool schemas alone are several times that, so the stock model
 * cannot hold a single turn — it has to be rebuilt with a real window first.
 */
const MODELFILE = `FROM ${OLLAMA_MODEL}\nPARAMETER num_ctx ${CTX}\n`

const LITELLM_OLLAMA = `# Claude Code validates model ids and sends its own, so every name routes to
# the one model actually present. LiteLLM serves /v1/messages in the Anthropic
# format, which is what ANTHROPIC_BASE_URL needs to point at.
model_list:
  - model_name: "*"
    litellm_params:
      model: ollama_chat/openmodel-ctx
      api_base: http://127.0.0.1:11434
litellm_settings:
  drop_params: true
general_settings:
  master_key: sk-local
`

const waitFor = (url, tries = 60, sleep = 2) =>
  `for i in $(seq 1 ${tries}); do curl -sf -o /dev/null ${url} && break; sleep ${sleep}; done; ` +
  `CODE=$(curl -s -o /dev/null -w '%{http_code}' ${url}); echo "${url} -> $CODE"; [ "$CODE" = "200" ]`

export const RUNNERS = {
  /** The default: Claude, billed to whatever credential the host has. */
  anthropic: {
    id: 'anthropic',
    label: 'Claude via the Anthropic API',
    template: null,
    needsAnthropicAuth: true,
    modelAlias: null,          // whatever the caller asked for
    files: () => [],
    steps: [],
    env: {},
    teardown: null,
  },

  /**
   * An open-weights model with nothing outside the sandbox: Ollama serves
   * qwen2.5-coder locally, LiteLLM puts an Anthropic-shaped face on it, and
   * Claude Code talks to that. No API key, no credits, no network egress for
   * inference — which also makes it the one runner that still works when the
   * Anthropic credential is dead.
   */
  openmodel: {
    id: 'openmodel',
    label: `${OLLAMA_MODEL} via Ollama + LiteLLM, entirely inside the sandbox`,
    template: process.env.OPENMODEL_TEMPLATE ?? 'openmodel-bench',
    needsAnthropicAuth: false,
    modelAlias: 'sonnet',      // an id Claude Code accepts; LiteLLM routes it anyway
    sandboxMs: 45 * 60 * 1000,
    agentMs: 35 * 60 * 1000,
    files: (WORK) => [
      { path: `${WORK}/Modelfile`, data: MODELFILE },
      { path: `${WORK}/litellm-ollama.yaml`, data: LITELLM_OLLAMA },
    ],
    steps: [
      // The template may already be serving; a second `ollama serve` exits with
      // "address already in use", which is success for our purposes, not failure.
      { kind: 'service', name: 'ollama', cmd: 'ollama serve > /home/user/ollama.log 2>&1 || true' },
      { kind: 'run', name: 'wait for ollama', cmd: waitFor('http://127.0.0.1:11434/api/tags', 40, 1), timeoutMs: 90000 },
      { kind: 'run', name: `rebuild ${OLLAMA_MODEL} at ${CTX} ctx`,
        cmd: `cd /home/user/work && ollama create openmodel-ctx -f Modelfile && ollama list`, timeoutMs: 300000 },
      { kind: 'service', name: 'litellm',
        cmd: 'litellm --config /home/user/work/litellm-ollama.yaml --port 4000 --host 127.0.0.1 > /home/user/litellm.log 2>&1' },
      { kind: 'run', name: 'wait for litellm', cmd: waitFor('http://127.0.0.1:4000/health/liveliness', 90, 2), timeoutMs: 240000 },
    ],
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_API_KEY: 'sk-local', CLAUDE_CODE_OAUTH_TOKEN: '',
           // Claude Code's thinking parameter reaches Ollama through LiteLLM and
           // qwen2.5-coder has no thinking mode; LiteLLM drops the parameter, and
           // this stops it being asked for in the first place.
           MAX_THINKING_TOKENS: '0' },
    // Every tool schema is prompt the model must read before it can act, and a
    // 3B model on CPU pays for all of it on every turn. Four tools is enough to
    // write a file and run its tests.
    agentFlags: ['--tools "Bash Read Write Edit"'],
    slow: true,
    teardown: 'echo "=== litellm tail ==="; tail -25 /home/user/litellm.log; echo "=== ollama tail ==="; tail -10 /home/user/ollama.log',
  },

  /**
   * The same swap, but the open model is served by Bedrock rather than by the
   * sandbox — bigger model, real weights, billed to AWS instead of Anthropic.
   * Needs AWS credentials forwarded from the host.
   */
  'openmodel-bedrock': {
    id: 'openmodel-bedrock',
    label: 'Qwen3-Coder-480B on AWS Bedrock via LiteLLM',
    template: null,
    needsAnthropicAuth: false,
    needsAws: true,
    modelAlias: 'sonnet',
    passEnv: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION'],
    files: (WORK) => [{
      path: `${WORK}/litellm-bedrock.yaml`,
      data: `model_list:
  - model_name: "*"
    litellm_params:
      model: bedrock/qwen.qwen3-coder-480b-a35b-v1:0
      aws_region_name: os.environ/AWS_REGION
litellm_settings:
  drop_params: true
general_settings:
  master_key: sk-local
`,
    }],
    steps: [
      { kind: 'run', name: 'install litellm',
        cmd: 'command -v litellm >/dev/null || pip install --quiet --disable-pip-version-check "litellm[proxy]" boto3', timeoutMs: 420000 },
      { kind: 'service', name: 'litellm',
        cmd: 'litellm --config /home/user/work/litellm-bedrock.yaml --port 4000 --host 127.0.0.1 > /home/user/litellm.log 2>&1' },
      { kind: 'run', name: 'wait for litellm', cmd: waitFor('http://127.0.0.1:4000/health/liveliness', 90, 2), timeoutMs: 240000 },
    ],
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_API_KEY: 'sk-local', CLAUDE_CODE_OAUTH_TOKEN: '' },
    teardown: `echo '=== litellm spend ==='; curl -s -H 'Authorization: Bearer sk-local' --max-time 10 http://127.0.0.1:4000/spend/logs | head -c 1500`,
  },
}

export const listRunners = () => Object.values(RUNNERS)
export const getRunner = (id) => RUNNERS[id ?? 'anthropic'] ?? null

/** Host credentials a runner asks to be forwarded into the sandbox. */
export function runnerHostEnv(runner) {
  const out = {}
  for (const k of runner.passEnv ?? []) if (process.env[k]) out[k] = process.env[k]
  if (runner.needsAws) {
    out.AWS_REGION = out.AWS_REGION || process.env.AWS_REGION || 'us-east-1'
    out.AWS_DEFAULT_REGION = out.AWS_REGION
    if (!out.AWS_ACCESS_KEY_ID || !out.AWS_SECRET_ACCESS_KEY)
      throw new Error('this runner needs AWS credentials; none were found in the environment')
  }
  return out
}
