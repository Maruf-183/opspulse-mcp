import { describe, expect, it } from "vitest";
import { actionsFromOpenApi, assertPublicUrl, createOpenApiConnector } from "./openapi";

const spec = {
  openapi: "3.0.3",
  info: { title: "Shop", version: "1" },
  components: { schemas: { NewProduct: { type: "object", required: ["name"], properties: { name: { type: "string" }, price: { type: "number" } } } } },
  paths: {
    "/products": {
      get: { operationId: "listProducts", summary: "List products", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }] },
      post: {
        operationId: "createProduct",
        summary: "Create a product",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewProduct" } } } },
      },
    },
    "/products/{productId}": {
      parameters: [{ name: "productId", in: "path", required: true, schema: { type: "string" } }],
      delete: { operationId: "deleteProduct", summary: "Delete a product" },
    },
  },
};

describe("OpenAPI connector", () => {
  const actions = actionsFromOpenApi(spec);
  const byName = Object.fromEntries(actions.map((a) => [a.name, a]));

  it("turns operations into actions with safe default rules", () => {
    expect(Object.keys(byName)).toEqual(["list_products", "create_product", "delete_product"]);
    expect(byName.list_products).toMatchObject({ tier: "auto", title: "List products" });
    expect(byName.create_product).toMatchObject({ tier: "ask" });
    expect(byName.delete_product).toMatchObject({ tier: "never", http: { method: "DELETE", path: "/products/{productId}" } });
  });

  it("resolves $ref request bodies and path parameters into the input schema", () => {
    expect(byName.create_product!.input).toMatchObject({
      required: ["body"],
      properties: { body: { type: "object", required: ["name"] } },
    });
    expect(byName.delete_product!.input).toMatchObject({ required: ["productId"] });
  });

  it("calls the API with the owner's credentials, path, query and body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = createOpenApiConnector({ baseUrl: "https://api.shop.example/v1" }, actions, { Authorization: "Bearer k" }, fake);

    await connector.execute(byName.list_products!, { limit: 5 }, { requestId: "1" });
    await connector.execute(byName.create_product!, { body: { name: "Panjabi", price: 2450 } }, { requestId: "2" });
    expect(calls[0]!.url).toBe("https://api.shop.example/v1/products?limit=5");
    expect(calls[1]!.init).toMatchObject({ method: "POST", body: '{"name":"Panjabi","price":2450}' });
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("refuses internal addresses (SSRF) and non-OpenAPI-3 documents", () => {
    for (const bad of ["http://api.example.com", "https://localhost/x", "https://169.254.169.254/latest", "https://10.0.0.5/api", "https://[::1]/"]) {
      expect(() => assertPublicUrl(bad)).toThrow();
    }
    expect(() => assertPublicUrl("https://api.example.com/v1")).not.toThrow();
    expect(() => actionsFromOpenApi({ swagger: "2.0" })).toThrow(/OpenAPI 3/);
  });
});
