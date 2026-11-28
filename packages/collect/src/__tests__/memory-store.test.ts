import { memoryStore } from "../index"
import { storeContract } from "./store-contract"

storeContract("memoryStore", async () => ({ store: memoryStore(), cleanup: async () => {} }))
