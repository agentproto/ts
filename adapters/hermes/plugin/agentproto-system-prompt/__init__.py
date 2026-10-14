"""agentproto system-prompt plugin for hermes.

agentproto spawns one `hermes acp` process per session, so a per-session
env var reaches this plugin's process. `register(ctx)` reads the path in
`AGENTPROTO_SYSTEM_PROMPT_FILE` and registers the file's text as one or
more cache-safe system-prompt sections at position "after_memory". If the
env var is unset, or the file is missing/empty, nothing is registered.
`register` never raises.
"""

import os
import sys

# Hermes' per-section cap is 4000 chars; stay under it with headroom so a
# boundary-splitting off-by-one can never trip hermes' own skip.
MAX_SECTION_CHARS = 3900
SECTION_ID_PREFIX = "agentproto.system-prompt."


def _log(message):
    try:
        sys.stderr.write("[agentproto-system-prompt] %s\n" % message)
    except Exception:
        pass


def split_sections(text, max_chars=MAX_SECTION_CHARS):
    """Split text into chunks of at most max_chars characters.

    Prefers paragraph (blank-line) boundaries; a paragraph longer than
    max_chars is hard-split. Order is preserved — callers derive ids that
    sort lexically in the same order.
    """
    sections = []
    current = ""
    for paragraph in text.split("\n\n"):
        candidate = paragraph if not current else current + "\n\n" + paragraph
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            sections.append(current)
            current = ""
        if len(paragraph) <= max_chars:
            current = paragraph
        else:
            for start in range(0, len(paragraph), max_chars):
                sections.append(paragraph[start : start + max_chars])
    if current:
        sections.append(current)
    return sections


def register(ctx):
    try:
        path = os.environ.get("AGENTPROTO_SYSTEM_PROMPT_FILE")
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except OSError as err:
            _log("could not read %s: %s" % (path, err))
            return
        if not text.strip():
            return
        for index, content in enumerate(split_sections(text)):
            ctx.register_system_prompt_section(
                SECTION_ID_PREFIX + ("%02d" % index),
                content,
                position="after_memory",
                max_chars=MAX_SECTION_CHARS,
            )
    except Exception as err:
        _log("skipped: %s" % err)
