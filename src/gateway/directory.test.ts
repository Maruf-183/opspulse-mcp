import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
const { matchProject } = await import("./directory");

const p = (slug: string, name: string, description = "") => ({ id: slug, slug, name, description, actions: [] });
const dir = [
  p("addiits", "Addiits Technology website", "Company website: leads and blog posts"),
  p("demo-store", "Demo Store", "A small online shop"),
  p("tickets", "Incident tickets (demo)"),
];

describe("matchProject", () => {
  it("finds a project by slug, exact name, or the user's own words", () => {
    expect(matchProject(dir, "addiits")).toMatchObject({ found: true, project: { slug: "addiits" } });
    expect(matchProject(dir, "Demo Store")).toMatchObject({ found: true, project: { slug: "demo-store" } });
    expect(matchProject(dir, "the Addiits site")).toMatchObject({ found: true, project: { slug: "addiits" } });
    expect(matchProject(dir, "my online shop")).toMatchObject({ found: true, project: { slug: "demo-store" } });
  });

  it("reports ambiguity or no match instead of guessing", () => {
    expect(matchProject(dir, "demo")).toMatchObject({ found: false });
    const none = matchProject(dir, "payroll");
    expect(none).toMatchObject({ found: false });
    if (!none.found) expect(none.projects).toHaveLength(3);
  });
});
