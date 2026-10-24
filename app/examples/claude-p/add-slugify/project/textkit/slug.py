"""URL slugs for page titles."""


def slugify(title, max_length=None):
    """The URL slug for a page title.

    - Accented letters become their plain ASCII letter ("Café" -> "cafe"); any other
      character that is not an ASCII letter or digit is a separator.
    - Letters are lower-cased. Each run of separators becomes a single "-", and the
      slug never starts or ends with "-".
    - max_length, when given, caps the slug's length. A slug that is too long is cut
      at the last "-" that keeps it within max_length; if there is no such "-", it is
      cut at max_length exactly.
    - A title with no letters or digits has the slug "untitled".
    """
    raise NotImplementedError
