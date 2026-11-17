import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "./index";
import { tickets, auditLogs } from "./schema";

async function seed() {
  console.log("🌱 Seeding demo data...");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.insert(tickets).values([
    {
      sandboxId: "demo-sandbox",
      title: "Production API latency spike on /checkout",
      description: "Response time exceeded 2.5s in ap-southeast-1 region.",
      priority: "HIGH",
      status: "OPEN",
      expiresAt,
    },
    {
      sandboxId: "demo-sandbox",
      title: "SSL certificate renewal alert",
      description: "Staging wildcard cert expires in 14 days.",
      priority: "MEDIUM",
      status: "IN_PROGRESS",
      expiresAt,
    },
  ]);

  await db.insert(auditLogs).values({
    sandboxId: "demo-sandbox",
    action: "system.seed",
    inputPayload: JSON.stringify({ source: "seed-script" }),
    outputPayload: JSON.stringify({ inserted: 2 }),
    latencyMs: 12,
    isError: 0,
  });

  console.log("✅ Seed completed successfully!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
