"""LangChain baseline — the same four questions to a chat model.

LangChain is used for exactly one thing here: swapping provider without changing the
prompt, so Claude and a local Ollama model are comparable. Jev is not a chat model and
does not go through it; it has its own adapter. Keeping the seam honest matters more
than routing everything through one abstraction.
"""

import json
import os
import time
from .base import Classifier, Verdict

PROMPT = """You are classifying one email for a mailbox owner.
Answer each question with exactly one option id from its list.

{questions}

EMAIL
{email}
{context}
Return only JSON: {{"lane": "...", "relation": "...", "action": "...", "topic": "..."}}"""

# API list prices, USD per 1M tokens. Update from the pricing page, do not guess.
PRICES = {
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    "claude-sonnet-5": (2.0, 10.0),
}


class LangChainClassifier(Classifier):
    def __init__(self, taxonomy, with_context, model="claude-haiku-4-5-20251001", provider="anthropic"):
        self.taxonomy = taxonomy
        self.uses_context = with_context
        self.model = model
        self.provider = provider
        self.name = f"{model.split('-')[1] if provider == 'anthropic' else model}-{'C1' if with_context else 'C0'}"
        self._llm = None

    def _lazy(self):
        if self._llm is not None:
            return self._llm
        if self.provider == "anthropic":
            from langchain_anthropic import ChatAnthropic
            self._llm = ChatAnthropic(model=self.model, temperature=0, max_tokens=200)
        else:
            from langchain_ollama import ChatOllama
            self._llm = ChatOllama(model=self.model, temperature=0,
                                   base_url=os.environ.get("OLLAMA_HOST", "http://localhost:11434"))
        return self._llm

    def _questions_block(self):
        out = []
        for axis, spec in self.taxonomy["axes"].items():
            opts = "\n".join(f"  - {k}: {v}" for k, v in spec["options"].items())
            out.append(f"{axis}: {spec['question']}\n{opts}")
        return "\n\n".join(out)

    def classify(self, r, f):
        ctx = ""
        if self.uses_context and f:
            ctx = ("\nSENDER CONTEXT (from this mailbox's own metadata, not the message text)\n"
                   + json.dumps(f, indent=2) + "\n")
        msg = PROMPT.format(questions=self._questions_block(), email=json.dumps(r, indent=2), context=ctx)
        t0 = time.perf_counter()
        try:
            resp = self._lazy().invoke(msg)
        except Exception:
            return Verdict(labels={}, outcome="unavailable", latency_ms=int((time.perf_counter() - t0) * 1000))
        dt = int((time.perf_counter() - t0) * 1000)

        text = resp.content if isinstance(resp.content, str) else str(resp.content)
        try:
            parsed = json.loads(text[text.index("{"):text.rindex("}") + 1])
        except Exception:
            return Verdict(labels={}, outcome="invalid", latency_ms=dt)

        labels = {}
        for axis, spec in self.taxonomy["axes"].items():
            v = parsed.get(axis)
            if v not in spec["options"]:
                return Verdict(labels={}, outcome="invalid", latency_ms=dt)
            labels[axis] = v

        cost = 0.0
        usage = getattr(resp, "usage_metadata", None) or {}
        if self.model in PRICES and usage:
            pin, pout = PRICES[self.model]
            cost = usage.get("input_tokens", 0) / 1e6 * pin + usage.get("output_tokens", 0) / 1e6 * pout
        return Verdict(labels=labels, latency_ms=dt, cost_usd=cost)
