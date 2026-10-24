# add-slugify

A function to build from its docstring: `textkit.slug.slugify`, which raises `NotImplementedError`.
All five visible tests fail. The task asks for an implementation that follows the docstring, without
touching the tests.

The hidden check (`check.py`) passes only if the visible tests are unedited, the whole suite passes, and
seven cases the agent never sees hold. Every hidden case follows from the docstring alone: other
accented letters, digits, a cut with no separator, an exact fit, a separator at the cut, leading and
trailing separators. `solution/` is a reference implementation the free tests use to prove the check
can pass.

    opt claude example add-slugify --repeats 3 --level balanced
