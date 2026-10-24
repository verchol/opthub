"""URL slugs for page titles."""
import re
import unicodedata


def slugify(title, max_length=None):
    """Reference solution: see the project's docstring for the spec."""
    chars = []
    for ch in unicodedata.normalize("NFD", title):      # an accented letter -> its letter + combining marks
        if unicodedata.combining(ch):
            continue
        chars.append(ch.lower() if ch.isascii() and ch.isalnum() else "-")
    slug = re.sub(r"-+", "-", "".join(chars)).strip("-")
    if not slug:
        return "untitled"
    if max_length is not None and len(slug) > max_length:
        cut = slug.rfind("-", 0, max_length + 1)
        slug = slug[:cut] if cut > 0 else slug[:max_length]
    return slug
