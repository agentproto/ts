/**
 * Base kind registrations for AIP-27 v1.
 *
 * Importing this module registers all eleven base kinds with the runtime
 * registry. Importing the package root also imports this module so kinds
 * are available eagerly. Apps that want to control registration order
 * (e.g. test isolation) can import individual kinds and register manually.
 */

import { registerRefKind } from "../registry.js"
import { localKind, type LocalRef } from "./local.js"
import { urlKind, type UrlRef } from "./url.js"
import { gitKind, type GitRef } from "./git.js"
import { githubKind, type GithubRef } from "./github.js"
import { ipfsKind, type IpfsRef } from "./ipfs.js"
import { emailKind, type EmailRef } from "./email.js"
import { operatorKind, type OperatorRef } from "./operator.js"
import { userKind, type UserRef } from "./user.js"
import { personaKind, type PersonaRef } from "./persona.js"
import { ethTxKind, type EthTxRef } from "./eth-tx.js"
import { otsKind, type OtsRef } from "./ots.js"

declare module "../types.js" {
  interface RefKindRegistry {
    local: LocalRef
    url: UrlRef
    git: GitRef
    github: GithubRef
    ipfs: IpfsRef
    email: EmailRef
    operator: OperatorRef
    user: UserRef
    persona: PersonaRef
    eth_tx: EthTxRef
    ots: OtsRef
  }
}

registerRefKind(localKind)
registerRefKind(urlKind)
registerRefKind(gitKind)
registerRefKind(githubKind)
registerRefKind(ipfsKind)
registerRefKind(emailKind)
registerRefKind(operatorKind)
registerRefKind(userKind)
registerRefKind(personaKind)
registerRefKind(ethTxKind)
registerRefKind(otsKind)

export {
  localKind,
  urlKind,
  gitKind,
  githubKind,
  ipfsKind,
  emailKind,
  operatorKind,
  userKind,
  personaKind,
  ethTxKind,
  otsKind,
}

export type {
  LocalRef,
  UrlRef,
  GitRef,
  GithubRef,
  IpfsRef,
  EmailRef,
  OperatorRef,
  UserRef,
  PersonaRef,
  EthTxRef,
  OtsRef,
}
