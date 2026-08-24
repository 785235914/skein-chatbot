import { randomUUID } from "node:crypto";

import type { IdGenerator } from "../ports/id-generator.js";

export class CryptoIdGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}
