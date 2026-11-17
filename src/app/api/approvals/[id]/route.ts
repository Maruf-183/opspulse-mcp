import { NextRequest, NextResponse } from "next/server";
import { executeApprovedDeletion } from "@/services/ticket.service";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const approvalId = Number(id);

  if (Number.isNaN(approvalId)) {
    return NextResponse.json({ error: "Invalid approval ID" }, { status: 400 });
  }

  const sandboxId = req.cookies.get("opspulse_sandbox")?.value || "demo-sandbox";
  const body = await req.json().catch(() => ({}));
  const approve = Boolean(body.approve);

  const result = await executeApprovedDeletion(sandboxId, approvalId, approve);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json(result);
}
