import { NextResponse } from "next/server";

/** Minimal server-rendered pages (consent, approvals): no client JavaScript, any device. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(title: string, body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · OpsPulse</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#0f172a;--muted:#5b6475;--line:#e3e6ec;--accent:#2563eb;--ok:#0f7a4a;--no:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#131722;--ink:#e8ebf2;--muted:#9aa3b5;--line:#252b38;--accent:#5b8cff;--ok:#3ccf8e;--no:#ff7a6b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;color:var(--muted);font-size:14px;margin-bottom:20px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
ul{list-style:none;padding:0;margin:0 0 20px;border-top:1px solid var(--line)}li{padding:12px 0;border-bottom:1px solid var(--line);display:flex;gap:10px}
.y{color:var(--ok);font-weight:700}.n{color:var(--no);font-weight:700}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.who{font-size:14px;color:var(--muted);margin-top:16px;text-align:center}
</style></head><body><main class="card"><div class="brand"><span class="dot"></span>OpsPulse</div>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } },
  );
}
