import { runProcessorContractSuite, makeReferenceProcessorSession } from "../testing/index.js"

await runProcessorContractSuite({ name: "reference cascade engine", makeSession: makeReferenceProcessorSession })
