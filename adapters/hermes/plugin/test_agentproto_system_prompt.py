"""Unit tests for the agentproto-system-prompt hermes plugin.

Runs with a fake ctx — no hermes install required:

    cd adapters/hermes/plugin && python3 -m unittest test_agentproto_system_prompt
"""

import importlib.util
import os
import tempfile
import unittest
from unittest import mock

PLUGIN_INIT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "agentproto-system-prompt",
    "__init__.py",
)


def _load_plugin():
    spec = importlib.util.spec_from_file_location(
        "agentproto_system_prompt", PLUGIN_INIT
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()


class FakeCtx:
    def __init__(self):
        self.sections = []

    def register_system_prompt_section(
        self, section_id, content, *, position="after_memory", max_chars=None
    ):
        self.sections.append(
            {
                "id": section_id,
                "content": content,
                "position": position,
                "max_chars": max_chars,
            }
        )


class RaisingCtx:
    def register_system_prompt_section(self, *args, **kwargs):
        raise RuntimeError("boom")


class SplitSectionsTests(unittest.TestCase):
    def test_short_text_single_section(self):
        self.assertEqual(plugin.split_sections("hello"), ["hello"])

    def test_splits_on_paragraph_boundary(self):
        para_a = "a" * 3000
        para_b = "b" * 3000
        sections = plugin.split_sections(para_a + "\n\n" + para_b)
        self.assertEqual(sections, [para_a, para_b])

    def test_hard_splits_oversized_paragraph(self):
        big = "x" * 8000
        sections = plugin.split_sections(big)
        self.assertEqual(len(sections), 3)
        self.assertEqual("".join(sections), big)
        for section in sections:
            self.assertLessEqual(len(section), plugin.MAX_SECTION_CHARS)

    def test_paragraph_glued_when_it_fits(self):
        text = ("p" * 100 + "\n\n") * 40  # 40 paragraphs of 100 chars
        sections = plugin.split_sections(text.rstrip("\n"))
        for section in sections:
            self.assertLessEqual(len(section), plugin.MAX_SECTION_CHARS)
        self.assertEqual(
            "\n\n".join(sections), text.rstrip("\n")
        )


class RegisterTests(unittest.TestCase):
    def _env_file(self, text):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".md", delete=False, encoding="utf-8"
        )
        self.addCleanup(os.unlink, handle.name)
        handle.write(text)
        handle.close()
        return handle.name

    def test_no_env_registers_nothing(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            ctx = FakeCtx()
            plugin.register(ctx)
        self.assertEqual(ctx.sections, [])

    def test_missing_file_registers_nothing(self):
        env = {"AGENTPROTO_SYSTEM_PROMPT_FILE": "/nonexistent/agentproto.md"}
        with mock.patch.dict(os.environ, env, clear=True):
            ctx = FakeCtx()
            plugin.register(ctx)  # must not raise
        self.assertEqual(ctx.sections, [])

    def test_empty_file_registers_nothing(self):
        path = self._env_file("   \n\n  ")
        env = {"AGENTPROTO_SYSTEM_PROMPT_FILE": path}
        with mock.patch.dict(os.environ, env, clear=True):
            ctx = FakeCtx()
            plugin.register(ctx)
        self.assertEqual(ctx.sections, [])

    def test_registers_section_after_memory(self):
        path = self._env_file("You are terse.")
        env = {"AGENTPROTO_SYSTEM_PROMPT_FILE": path}
        with mock.patch.dict(os.environ, env, clear=True):
            ctx = FakeCtx()
            plugin.register(ctx)
        self.assertEqual(len(ctx.sections), 1)
        section = ctx.sections[0]
        self.assertEqual(section["id"], "agentproto.system-prompt.00")
        self.assertEqual(section["content"], "You are terse.")
        self.assertEqual(section["position"], "after_memory")
        self.assertEqual(section["max_chars"], 3900)

    def test_split_sections_keep_lexical_id_order(self):
        paragraphs = [("p%02d " % i) + ("z" * 3800) for i in range(12)]
        path = self._env_file("\n\n".join(paragraphs))
        env = {"AGENTPROTO_SYSTEM_PROMPT_FILE": path}
        with mock.patch.dict(os.environ, env, clear=True):
            ctx = FakeCtx()
            plugin.register(ctx)
        ids = [s["id"] for s in ctx.sections]
        self.assertEqual(len(ctx.sections), 12)
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(ids[0], "agentproto.system-prompt.00")
        self.assertEqual(ids[11], "agentproto.system-prompt.11")
        self.assertEqual([s["content"] for s in ctx.sections], paragraphs)

    def test_register_never_raises_when_ctx_raises(self):
        path = self._env_file("text")
        env = {"AGENTPROTO_SYSTEM_PROMPT_FILE": path}
        with mock.patch.dict(os.environ, env, clear=True):
            plugin.register(RaisingCtx())  # must not raise


if __name__ == "__main__":
    unittest.main()
