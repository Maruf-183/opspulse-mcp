/**
 * Lets people refer to projects in their own words ("the Addiits site",
 * "demo store") instead of exact identifiers.
 */
import type { Principal } from "@/lib/authz/policy";
import { listProjects, toolCatalogue, type ToolEntry } from "./service";

export type DirectoryProject = {
  id: string;
  slug: string;
  name: string;
  description: string;
  actions: ToolEntry[];
};

export async function projectDirectory(principal: Principal): Promise<DirectoryProject[]> {
  const [projects, tools] = await Promise.all([listProjects(principal), toolCatalogue(principal)]);
  if (!projects.ok) return [];
  return projects.data.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    actions: tools.filter((t) => t.projectId === p.id),
  }));
}

const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9ঀ-৿]+/)
    .filter((w) => w.length > 1 && !["the", "my", "our", "project", "site", "website", "app"].includes(w));

export type ProjectMatch =
  | { found: true; project: DirectoryProject }
  | { found: false; message: string; projects: Array<{ project: string; name: string }> };

/** Exact slug/name first, then the best word overlap; ambiguity is reported, never guessed. */
export function matchProject(directory: DirectoryProject[], query: string): ProjectMatch {
  const q = query.trim().toLowerCase();
  const list = directory.map((p) => ({ project: p.slug, name: p.name }));
  const exact = directory.find((p) => p.slug === q || p.name.toLowerCase() === q);
  if (exact) return { found: true, project: exact };

  const wanted = words(query);
  const scored = directory
    .map((p) => {
      const have = new Set(words(`${p.slug} ${p.name} ${p.description}`));
      return { p, score: wanted.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w))).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0]!.score > scored[1]!.score)) {
    return { found: true, project: scored[0]!.p };
  }
  return {
    found: false,
    message: scored.length > 1 ? `"${query}" matches more than one project; ask the user which one.` : `No project matches "${query}".`,
    projects: list,
  };
}
