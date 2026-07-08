#!/usr/bin/env node
/**
 * `llm-endpoint` — bin entry. Boots the proxy gateway.
 * Port: LLM_ENDPOINT_PORT | PORT | 18090.
 */
import { start } from './index.js';

start();
