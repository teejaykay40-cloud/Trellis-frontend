import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireActor, deniedResponse } from '@/lib/auth';
import { fingerprintCapabilityRequest, issueCapabilityToken } from '@/lib/auth/capability';
import { checkPermission } from '@/lib/permissions';

const CapabilityRequestSchema = z.object({
  action: z.literal('run_retention_cleanup'),
  dryRun: z.literal(false),
  dataClasses: z
    .array(z.enum(['audit', 'telemetry', 'exports', 'support', 'simulations']))
    .optional(),
}).strict();

export async function POST(request: NextRequest) {
  const identity = await requireActor(request);
  if (!identity.ok) return identity.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = CapabilityRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed.', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const decision = checkPermission(parsed.data.action, {
    role: identity.actor.role,
    actorId: identity.actor.id,
    resourceScope: 'global',
    context: { confirmed: true },
  });
  if (!decision.allowed) return deniedResponse(decision);

  const requestHash = await fingerprintCapabilityRequest(parsed.data.action, {
    dryRun: parsed.data.dryRun,
    dataClasses: parsed.data.dataClasses ?? null,
  });
  const capability = await issueCapabilityToken({
    actorId: identity.actor.id,
    action: parsed.data.action,
    requestHash,
  });

  return NextResponse.json(capability, {
    status: 201,
    headers: { 'Cache-Control': 'no-store' },
  });
}
