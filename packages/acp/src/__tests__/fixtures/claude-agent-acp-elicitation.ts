/**
 * ACP form elicitations exactly as @agentclientprotocol/claude-agent-acp@0.81.2
 * builds them for an AskUserQuestion tool call: the output of its
 * `askUserQuestionsToCreateRequest` (dist/elicitation.js), captured by running
 * that function. `sessionId` is rewritten per test. Inputs:
 *
 *   single: "Which database should we use?" (header "Database"), options
 *           Postgres ("Relational, battle tested") and SQLite ("Embedded
 *           file", preview "db.sqlite")
 *   multi:  "Which features do you want?" (header "Features", multiSelect),
 *           options Logs, Metrics, Traces
 *   two:    both questions in one call
 *
 * Each question carries its `question_<n>_custom` "Other" companion.
 */

export const ASK_SINGLE = {
  mode: "form",
  sessionId: "S",
  toolCallId: "tc_1",
  message: "Which database should we use?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Database",
        oneOf: [
          {
            const: "Postgres",
            title: "Postgres",
            description: "Relational, battle tested"
          },
          {
            const: "SQLite",
            title: "SQLite",
            description: "Embedded file",
            _meta: {
              "_claude/askUserQuestionOption": {
                preview: "db.sqlite"
              }
            }
          }
        ]
      },
      question_0_custom: {
        type: "string",
        title: "Other",
        description: "Type your own answer, or add a note to the option you chose above (optional).",
        _meta: {
          _askUserQuestionCustomAnswer: {
            questionId: "question_0",
            isCustomAnswer: true
          }
        }
      }
    }
  }
}

export const ASK_MULTI = {
  mode: "form",
  sessionId: "S",
  toolCallId: "tc_2",
  message: "Which features do you want?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: {
        type: "array",
        title: "Features",
        items: {
          anyOf: [
            {
              const: "Logs",
              title: "Logs"
            },
            {
              const: "Metrics",
              title: "Metrics"
            },
            {
              const: "Traces",
              title: "Traces"
            }
          ]
        }
      },
      question_0_custom: {
        type: "string",
        title: "Other",
        description: "Type your own answer to add to your selection above (optional).",
        _meta: {
          _askUserQuestionCustomAnswer: {
            questionId: "question_0",
            isCustomAnswer: true
          }
        }
      }
    }
  }
}

export const ASK_TWO = {
  mode: "form",
  sessionId: "S",
  toolCallId: "tc_3",
  message: "Please answer the following questions.",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Database",
        description: "Which database should we use?",
        oneOf: [
          {
            const: "Postgres",
            title: "Postgres",
            description: "Relational, battle tested"
          },
          {
            const: "SQLite",
            title: "SQLite",
            description: "Embedded file",
            _meta: {
              "_claude/askUserQuestionOption": {
                preview: "db.sqlite"
              }
            }
          }
        ]
      },
      question_0_custom: {
        type: "string",
        title: "Other",
        description: "Type your own answer, or add a note to the option you chose above (optional).",
        _meta: {
          _askUserQuestionCustomAnswer: {
            questionId: "question_0",
            isCustomAnswer: true
          }
        }
      },
      question_1: {
        type: "array",
        title: "Features",
        description: "Which features do you want?",
        items: {
          anyOf: [
            {
              const: "Logs",
              title: "Logs"
            },
            {
              const: "Metrics",
              title: "Metrics"
            },
            {
              const: "Traces",
              title: "Traces"
            }
          ]
        }
      },
      question_1_custom: {
        type: "string",
        title: "Other",
        description: "Type your own answer to add to your selection above (optional).",
        _meta: {
          _askUserQuestionCustomAnswer: {
            questionId: "question_1",
            isCustomAnswer: true
          }
        }
      }
    }
  }
}
