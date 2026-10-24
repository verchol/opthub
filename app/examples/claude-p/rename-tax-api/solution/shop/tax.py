"""Sales tax by region."""
import warnings

RATES = {"CA": 0.0725, "NY": 0.04, "TX": 0.0625, "OR": 0.0}


def compute_tax(amount, region):
    """Tax on `amount` in `region`, rounded to cents. Unknown regions pay no tax."""
    return round(amount * RATES.get(region, 0.0) + 1e-9, 2)


def calc_tax(amount, region):
    """Deprecated: use compute_tax."""
    warnings.warn("calc_tax is deprecated; use compute_tax", DeprecationWarning, stacklevel=2)
    return compute_tax(amount, region)
