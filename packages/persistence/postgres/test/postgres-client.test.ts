import { describe, expect, it } from "vitest";

import { assertDedicatedDatabaseUrl } from "../src/postgres-client.js";

describe("PostgreSQL target safety", () => {
  it("accepts the explicitly named dedicated database", () => {
    expect(() =>
      assertDedicatedDatabaseUrl(
        "postgresql://placeholder:placeholder@127.0.0.1:5432/skein_chatbot?schema=public",
      ),
    ).not.toThrow();
  });

  it("rejects a different database name before a client is constructed", () => {
    expect(() =>
      assertDedicatedDatabaseUrl(
        "postgresql://placeholder:placeholder@127.0.0.1:5432/postgres",
      ),
    ).toThrow(/explicitly allowed dedicated database/u);
  });

  it("rejects non-PostgreSQL connection strings", () => {
    expect(() =>
      assertDedicatedDatabaseUrl("mysql://placeholder@127.0.0.1/skein_chatbot"),
    ).toThrow(/PostgreSQL protocol/u);
  });
});
