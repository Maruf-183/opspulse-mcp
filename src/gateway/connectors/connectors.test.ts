import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpHandler } from "mcp-handler";
import { createStoreServer, createStore } from "../../../examples/demo-store/server";
import { verifyOpsPulse } from "../../../packages/connect-node";
import { sign, verify } from "../signing";
import { actionDefSchema, projectManifestSchema } from "../types";
import { buildPath, createHttpConnector } from "./http";
import { createMcpConnector, defaultTier, toActionName } from "./mcp";

const SECRET = "ops_sk_test_secret_value_123456";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("request signing", () => {
  const parts = { requestId: "r1", method: "POST", path: "/orders/1/refund", body: '{"amount":5}' };
  const at = 1_800_000_000_000;

  it("round-trips and matches the standalone connect kit", () => {
    const header = sign(SECRET, parts, () => at);
    expect(verify(SECRET, header, parts, () => at)).toEqual({ ok: true });
    const kit = verifyOpsPulse({
      secret: SECRET,
      method: "POST",
      path: parts.path,
      rawBody: parts.body,
      headers: { "x-opspulse-signature": header, "x-opspulse-request-id": "r1", "x-opspulse-mode": "execute" },
      now: at,
    });
    expect(kit.ok).toBe(true);
  });

  it("rejects tampering, wrong secrets and stale signatures", () => {
    const header = sign(SECRET, parts, () => at);
    expect(verify(SECRET, header, { ...parts, body: '{"amount":500}' }, () => at)).toMatchObject({ reason: "mismatch" });
    expect(verify(SECRET, header, { ...parts, requestId: "r2" }, () => at)).toMatchObject({ reason: "mismatch" });
    expect(verify("other-secret", header, parts, () => at)).toMatchObject({ reason: "mismatch" });
    expect(verify(SECRET, header, parts, () => at + 6 * 60_000)).toMatchObject({ reason: "stale" });
    expect(verify(SECRET, "garbage", parts, () => at)).toMatchObject({ reason: "malformed" });
  });

  it("fills path placeholders safely", () => {
    expect(buildPath("/orders/{orderId}/refund", { orderId: "a/b", amount: 3 })).toEqual({
      path: "/orders/a%2Fb/refund",
      rest: { amount: 3 },
    });
    expect(() => buildPath("/orders/{orderId}", {})).toThrow(/orderId/);
  });
});

describe("HTTP connector against the demo store", () => {
  const manifest = projectManifestSchema.parse(
    JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../examples/demo-store/opspulse.manifest.json"), "utf8")),
  );
  const store = createStore();
  const server = createStoreServer(SECRET, store);
  let connector: ReturnType<typeof createHttpConnector>;
  const action = (name: string) => manifest.actions.find((a) => a.name === name)!;
  let n = 0;
  const ctx = () => ({ requestId: `req-${++n}`, secret: SECRET });

  beforeAll(async () => {
    connector = createHttpConnector({ baseUrl: await listen(server) }, manifest.actions);
  });
  afterAll(() => server.close());

  it("executes a read", async () => {
    const res = await connector.execute(action("list_orders"), {}, ctx());
    expect((res.result as unknown[]).length).toBe(3);
  });

  it("previews, executes and undoes a product edit", async () => {
    const update = action("update_product_description");
    const input = { productId: "p1", description: "Soft cotton, handmade in Dhaka." };
    const preview = await connector.preview!(update, input, ctx());
    expect(preview.changes[0]).toMatchObject({ before: "Classic cotton panjabi.", after: input.description });

    const done = await connector.execute(update, input, ctx());
    expect(store.products.get("p1")?.description).toBe(input.description);
    await connector.undo!(update, done.undoToken!, ctx());
    expect(store.products.get("p1")?.description).toBe("Classic cotton panjabi.");
  });

  it("never runs the same request id twice", async () => {
    const refund = action("refund_order");
    const same = { requestId: "refund-once", secret: SECRET };
    await connector.execute(refund, { orderId: "1003", amount: 640 }, same);
    const again = await connector.execute(refund, { orderId: "1003", amount: 640 }, same);
    expect(again.result).toMatchObject({ refunded: 640 });
    expect(store.orders.get("1003")?.status).toBe("refunded");
  });

  it("maps project errors and bad secrets to safe messages", async () => {
    await expect(connector.execute(action("refund_order"), { orderId: "9999", amount: 1 }, ctx())).rejects.toThrow(
      "Order not found",
    );
    await expect(
      connector.execute(action("list_orders"), {}, { requestId: "x", secret: "wrong-secret" }),
    ).rejects.toThrow("Invalid signature");
  });
});

describe("MCP connector wrapping an existing MCP server", () => {
  const handler = createMcpHandler((server) => {
    server.registerTool(
      "github.list-issues",
      { title: "List issues", description: "List open issues", inputSchema: z.object({ repo: z.string() }), annotations: { readOnlyHint: true } },
      async ({ repo }) => ({ content: [{ type: "text", text: `3 open issues in ${repo}` }] }),
    );
    server.registerTool(
      "deleteRepo",
      { description: "Delete a repository", inputSchema: z.object({ repo: z.string() }), annotations: { destructiveHint: true } },
      async () => ({ isError: true, content: [{ type: "text", text: "not allowed upstream" }] }),
    );
  }, {});
  // Minimal node → Web Request bridge for the in-process server.
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await handler(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  let url = "";

  beforeAll(async () => {
    url = `${await listen(server)}/mcp`;
  });
  afterAll(() => server.close());

  it("discovers tools with safe default rules and readable names", async () => {
    const actions = await createMcpConnector({ url, headers: {} }).listActions();
    const byName = Object.fromEntries(actions.map((a) => [a.name, a]));
    expect(Object.keys(byName).sort()).toEqual(["delete_repo", "github_list_issues"]);
    expect(byName.github_list_issues).toMatchObject({ tier: "auto", title: "List issues" });
    expect(byName.delete_repo).toMatchObject({ tier: "ask", title: "Delete Repo" });
  });

  it("lets the owner's manifest override wording and rules", async () => {
    const override = actionDefSchema.parse({
      name: "delete_repo",
      title: "Delete a GitHub repository",
      summary: "Delete {repo}",
      tier: "never",
    });
    const [deleteRepo] = (await createMcpConnector({ url, headers: {} }, [override]).listActions()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(deleteRepo).toMatchObject({ name: "delete_repo", tier: "never", title: "Delete a GitHub repository" });
    expect(deleteRepo?.input).toMatchObject({ type: "object" });
  });

  it("calls the upstream tool by its original name and surfaces upstream errors", async () => {
    const connector = createMcpConnector({ url, headers: {} });
    const [deleteRepo, listIssues] = (await connector.listActions()).sort((a, b) => a.name.localeCompare(b.name));
    const res = await connector.execute(listIssues!, { repo: "opspulse" }, { requestId: "m1" });
    expect(JSON.stringify(res.result)).toContain("3 open issues in opspulse");
    await expect(connector.execute(deleteRepo!, { repo: "x" }, { requestId: "m2" })).rejects.toThrow("not allowed upstream");
  });

  it("normalizes names and defaults", () => {
    expect(toActionName("github.create-issue")).toBe("github_create_issue");
    expect(toActionName("2fast")).toBe("t_2fast");
    expect(defaultTier({ name: "x", annotations: { readOnlyHint: true } })).toBe("auto");
    expect(defaultTier({ name: "x" })).toBe("ask");
  });
});
