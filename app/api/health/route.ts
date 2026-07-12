// Setup health — surfaces lib/setup-health.ts assertions (currently: the
// listing-photo bucket must be public). Requires a signed-in user: the
// output describes project configuration, not public status.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { runSetupChecks } from "@/lib/setup-health";

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const checks = await runSetupChecks();
  return NextResponse.json(
    { ok: checks.every((c) => c.ok), checks },
    { status: checks.every((c) => c.ok) ? 200 : 503 }
  );
}
