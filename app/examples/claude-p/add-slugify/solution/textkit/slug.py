"""URL slugs for page titles."""
import re
import unicodedata


def slugify(title, max_length=None):
    """Reference solution: see the project's docstring for the spec."""
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")
    if not slug:
        return "untitled"
    if max_length is not None and len(slug) > max_length:
        cut = slug.rfind("-", 0, max_length + 1)
        slug = slug[:cut] if cut > 0 else slug[:max_length]
    return slug
