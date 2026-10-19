import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deniedResponse, requireActor } from "@/lib/auth";
import { setFeatureFlagEmergencyDisabled } from "@/lib/feature-flags";
import { checkPermission } from "@/lib/permissions";
import { securityAuditLedger } from "@/lib/security/audit-ledger";

const CONFIG_AUDIT_STREAM = "admin-config:global";

const EmergencyDisableRequestSchema = z
  .object({
    flag: z.enum(["stableBugReportPagination", "securityReportExport"]),
    disabled: z.boolean(),
    confirm: z.literal(true),
  })
  .strict();

export async function POST(request: NextRequest) {
  const identity = await requireActor(request);
  if (!identity.ok) return identity.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = EmergencyDisableRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed.", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const decision = checkPermission("manage_security", {
    role: identity.actor.role,
    actorId: identity.actor.id,
    resourceScope: "global",
    context: { confirmed: parsed.data.confirm },
  });
  if (!decision.allowed) {
    securityAuditLedger.append({
      streamId: CONFIG_AUDIT_STREAM,
      category: "privileged",
      eventType: "admin.config.change.denied",
      actorId: identity.actor.id,
      payload: { setting: `featureFlag.${parsed.data.flag}`, requestedValue: parsed.data.disabled },
    });
    return deniedResponse(decision);
  }

  const setting = `featureFlag.${parsed.data.flag}`;
  securityAuditLedger.append({
    streamId: CONFIG_AUDIT_STREAM,
    category: "privileged",
    eventType: "admin.config.change.attempted",
    actorId: identity.actor.id,
    payload: { setting, requestedValue: parsed.data.disabled },
  });
  try {
    setFeatureFlagEmergencyDisabled(parsed.data.flag, parsed.data.disabled);
  } catch {
    securityAuditLedger.append({
      streamId: CONFIG_AUDIT_STREAM,
      category: "privileged",
      eventType: "admin.config.change.failed",
      actorId: identity.actor.id,
      payload: { setting, requestedValue: parsed.data.disabled, reason: "mutation_failed" },
    });
    return NextResponse.json({ error: "Configuration change failed; retry is safe." }, { status: 500 });
  }
  securityAuditLedger.append({
    streamId: CONFIG_AUDIT_STREAM,
    category: "privileged",
    eventType: "admin.config.change.succeeded",
    actorId: identity.actor.id,
    payload: { setting, requestedValue: parsed.data.disabled },
  });
  return NextResponse.json({
    success: true,
    flag: parsed.data.flag,
    disabled: parsed.data.disabled,
    scope: "process",
  });
}
