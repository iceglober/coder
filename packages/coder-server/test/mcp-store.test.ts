import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearServerAuth, readServerAuth, writeServerAuth } from "../src/mcp/store.ts";

describe("mcp token store", () => {
  let dir: string;
  const saved = process.env.CODER_AUTH_FILE;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "coder-auth-"));
    process.env.CODER_AUTH_FILE = join(dir, "auth.json"); // redirect off the real ~/.coder
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CODER_AUTH_FILE;
    else process.env.CODER_AUTH_FILE = saved;
    await rm(dir, { recursive: true, force: true });
  });

  test("read-merge-write preserves other fields, and other servers", async () => {
    expect(await readServerAuth("linear")).toEqual({});

    // biome-ignore lint/suspicious/noExplicitAny: opaque SDK shapes for the test.
    await writeServerAuth("linear", { clientInformation: { client_id: "abc" } as any });
    // biome-ignore lint/suspicious/noExplicitAny: opaque SDK shapes.
    await writeServerAuth("linear", { tokens: { access_token: "tok" } as any }); // merge, not clobber
    await writeServerAuth("other", { codeVerifier: "v" });

    const linear = await readServerAuth("linear");
    expect(linear.clientInformation).toMatchObject({ client_id: "abc" }); // survived the second write
    expect(linear.tokens).toMatchObject({ access_token: "tok" });
    expect((await readServerAuth("other")).codeVerifier).toBe("v"); // other server untouched
  });

  test("auth file is written 0600", async () => {
    await writeServerAuth("linear", { codeVerifier: "v" });
    const mode = (await stat(process.env.CODER_AUTH_FILE as string)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("clearServerAuth forgets one server only", async () => {
    await writeServerAuth("linear", { codeVerifier: "v" });
    await writeServerAuth("other", { codeVerifier: "w" });
    await clearServerAuth("linear");
    expect(await readServerAuth("linear")).toEqual({});
    expect((await readServerAuth("other")).codeVerifier).toBe("w");
  });
});
