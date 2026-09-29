from dataclasses import dataclass, field


@dataclass
class Verdict:
    """One classifier's answer for one email."""
    labels: dict[str, str]                      # axis -> chosen option
    confidence: dict[str, float] = field(default_factory=dict)
    probabilities: dict[str, dict] = field(default_factory=dict)
    outcome: str = "ok"                         # ok|invalid|http-error|timeout|unavailable
    latency_ms: int = 0
    cost_usd: float = 0.0
    request_id: str | None = None


class Classifier:
    name = "base"
    uses_context = False

    def classify(self, redacted: dict, features: dict | None) -> Verdict:
        raise NotImplementedError
