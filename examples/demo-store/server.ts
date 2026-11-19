/**
 * Demo Store — a tiny, unrelated project used to prove OpsPulse works with
 * any HTTP API. Plain `node:http`, in-memory data, no framework.
 *
 * Run:  OPSPULSE_SECRET=ops_sk_... npx tsx examples/demo-store/server.ts
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { verifyOpsPulse, type VerifiedRequest } from "../../packages/connect-node";

type Order = { id: string; customer: string; total: number; status: "paid" | "refunded" };
type Product = { id: string; name: string; description: string };

export function createStore() {
  const orders = new Map<string, Order>([
    ["1001", { id: "1001", customer: "Rahim Uddin", total: 2450, status: "paid" }],
    ["1002", { id: "1002", customer: "Nusrat Jahan", total: 12800, status: "paid" }],
    ["1003", { id: "1003", customer: "Tanvir Ahmed", total: 640, status: "paid" }],
  ]);
  const products = new Map<string, Product>([
    ["p1", { id: "p1", name: "Cotton Panjabi", description: "Classic cotton panjabi." }],
    ["p2", { id: "p2", name: "Jamdani Saree", description: "Handwoven jamdani." }],
  ]);
  const customers = new Map([["c1", { id: "c1", name: "Rahim Uddin" }]]);
  return { orders, products, customers };
}

const taka = (n: number) => `৳${n.toLocaleString("en-US")}`;

export function createStoreServer(secret: string, store = createStore()): Server {
  /** Results by request id: the same OpsPulse request never runs twice. */
  const seen = new Map<string, { status: number; body: unknown }>();
  /** Undo tokens we issued. */
  const undo = new Map<string, () => void>();

  type Handler = (req: VerifiedRequest, params: Record<string, string>) => { status: number; body: unknown };

  const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
    {
      method: "GET",
      pattern: /^\/orders$/,
      handler: () => ({ status: 200, body: { result: [...store.orders.values()] } }),
    },
    {
      method: "PATCH",
      pattern: /^\/products\/(?<productId>[\w-]+)$/,
      handler: (req, { productId }) => {
        const product = store.products.get(productId!);
        if (!product) return { status: 404, body: { error: "Product not found" } };
        const description = String(req.body.description ?? "");
        if (req.mode === "preview") {
          return { status: 200, body: { changes: [{ label: `${product.name} description`, before: product.description, after: description }], warnings: [] } };
        }
        const previous = product.description;
        product.description = description;
        const token = randomUUID();
        undo.set(token, () => {
          product.description = previous;
        });
        return { status: 200, body: { result: product, undoToken: token } };
      },
    },
    {
      method: "POST",
      pattern: /^\/orders\/(?<orderId>[\w-]+)\/refund$/,
      handler: (req, { orderId }) => {
        const order = store.orders.get(orderId!);
        if (!order) return { status: 404, body: { error: "Order not found" } };
        if (order.status === "refunded") return { status: 409, body: { error: "Order already refunded" } };
        const amount = Number(req.body.amount ?? order.total);
        if (!(amount > 0 && amount <= order.total)) return { status: 400, body: { error: "Invalid refund amount" } };
        if (req.mode === "preview") {
          return {
            status: 200,
            body: {
              changes: [
                { label: `Order #${order.id} (${order.customer})`, before: "Paid", after: "Refunded" },
                { label: "Money returned", before: null, after: taka(amount) },
              ],
              warnings: [`${taka(amount)} will be sent back to ${order.customer}. Refunds can't be reversed.`],
            },
          };
        }
        order.status = "refunded";
        return { status: 200, body: { result: { orderId: order.id, refunded: amount } } };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/customers\/(?<customerId>[\w-]+)$/,
      handler: (_req, { customerId }) => {
        store.customers.delete(customerId!);
        return { status: 200, body: { result: { deleted: customerId } } };
      },
    },
    {
      method: "POST",
      pattern: /^\/opspulse\/undo$/,
      handler: (req) => {
        const run = undo.get(String(req.body.undoToken));
        if (!run) return { status: 410, body: { error: "This can no longer be undone" } };
        undo.delete(String(req.body.undoToken));
        run();
        return { status: 200, body: {} };
      },
    },
  ];

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://store.local");

    const verified = verifyOpsPulse({ secret, method: req.method ?? "GET", path: url.pathname + url.search, rawBody, headers: req.headers });
    if (!verified.ok) return send(res, verified.status, { error: verified.error });

    // Query parameters count as input for GET/DELETE.
    for (const [key, value] of url.searchParams) verified.body[key] ??= value;

    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) return send(res, 404, { error: "Not found" });

    // Previews are side-effect free, so only executions are de-duplicated.
    const key = `${verified.mode}:${verified.requestId}`;
    if (verified.mode !== "preview" && seen.has(key)) {
      const cached = seen.get(key)!;
      return send(res, cached.status, cached.body);
    }
    const params = url.pathname.match(route.pattern)?.groups ?? {};
    const outcome = route.handler(verified, params);
    if (verified.mode !== "preview") seen.set(key, outcome);
    send(res, outcome.status, outcome.body);
  });
}

// Run directly: `npx tsx examples/demo-store/server.ts`
if (process.argv[1]?.endsWith("server.ts")) {
  const secret = process.env.OPSPULSE_SECRET;
  if (!secret) {
    console.error("Set OPSPULSE_SECRET to the secret OpsPulse showed when you added this project.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4010);
  createStoreServer(secret).listen(port, () => console.log(`Demo Store listening on http://localhost:${port}`));
}
