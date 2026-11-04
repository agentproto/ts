/**
 * The ACP form elicitation @agentclientprotocol/codex-acp@2.5.0 builds for a
 * codex `request_user_input` call (`buildUserInputRequest`, dist/index.js),
 * for two questions with `isOther: true`, as observed live with codex
 * gpt-5.6-luna under `features.default_mode_request_user_input`. Unlike
 * claude-agent-acp, `title` carries the question and `description` the header
 * chip; the "Other" box is an extra `oneOf` choice plus a `<id>_note` string
 * property tagged `_meta.codex.role: "user_note"`.
 */
export const CODEX_ASK_TWO = {
  mode: "form",
  sessionId: "S",
  toolCallId: "item_1",
  message: "Codex needs your input to continue.",
  requestedSchema: {
    type: "object",
    required: ["couleur", "cibles"],
    properties: {
      couleur: {
        type: "string",
        title: "Quelle couleur ?",
        description: "Couleur",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "Bleu", title: "Bleu", description: "Choisir Bleu." },
          { const: "Vert", title: "Vert", description: "Choisir Vert." },
          { const: "Orange", title: "Orange", description: "Choisir Orange." },
          { const: "Other", title: "Other", description: "Provide a different answer in the note field." },
        ],
      },
      couleur_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "couleur", role: "user_note", isSecret: false } },
      },
      cibles: {
        type: "string",
        title: "Quelles cibles ?",
        description: "Cibles",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "Web", title: "Web" },
          { const: "iOS", title: "iOS" },
          { const: "Android", title: "Android" },
          { const: "Other", title: "Other", description: "Provide a different answer in the note field." },
        ],
      },
      cibles_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "cibles", role: "user_note", isSecret: false } },
      },
    },
  },
  _meta: { codex: { autoResolutionMs: null } },
}
