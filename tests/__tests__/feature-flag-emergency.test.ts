/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/feature-flags/emergency-disable/route";
import {
  ACTOR_TOKEN_SECRET_ENV,
  issueActorToken,
} from "@/lib/auth/actor";
import {
  isFeatureEnabled,
  setFeatureFlagEmergencyDisabled,
} from "@/lib/feature-flags";

const SECRET = "a".repeat(48);

async function requestWithRole(
  role: "viewer" | "maintainer" | "admin",
  body: unknown,
): Promise<NextRequest> {
  const token = await issueActorToken({ id: `${role}-operator`, role });
  return new NextRequest("https://example.test/api/feature-flags/emergency-disable", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("feature flag emergency disable endpoint", () => {
  const originalSecret = process.env[ACTOR_TOKEN_SECRET_ENV];

  beforeEach(() => {
    process.env[ACTOR_TOKEN_SECRET_ENV] = SECRET;
    setFeatureFlagEmergencyDisabled("securityReportExport", false);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[ACTOR_TOKEN_SECRET_ENV];
    else process.env[ACTOR_TOKEN_SECRET_ENV] = originalSecret;
    setFeatureFlagEmergencyDisabled("securityReportExport", false);
  });

  it("rejects unauthenticated calls", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/feature-flags/emergency-disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flag: "securityReportExport",
          disabled: true,
          confirm: true,
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it.each(["viewer", "maintainer"] as const)(
    "denies the %s role",
    async (role) => {
      const response = await POST(
        await requestWithRole(role, {
          flag: "securityReportExport",
          disabled: true,
          confirm: true,
        }),
      );
      expect(response.status).toBe(403);
    },
  );

  it("allows a confirmed admin to disable and restore a flag", async () => {
    const disableResponse = await POST(
      await requestWithRole("admin", {
        flag: "securityReportExport",
        disabled: true,
        confirm: true,
      }),
    );
    expect(disableResponse.status).toBe(200);
    expect(isFeatureEnabled("securityReportExport", {
      TRELLIS_FEATURE_SECURITY_REPORT_EXPORT: "true",
    })).toBe(false);

    const restoreResponse = await POST(
      await requestWithRole("admin", {
        flag: "securityReportExport",
        disabled: false,
        confirm: true,
      }),
    );
    expect(restoreResponse.status).toBe(200);
    expect(isFeatureEnabled("securityReportExport", {
      TRELLIS_FEATURE_SECURITY_REPORT_EXPORT: "true",
    })).toBe(true);
  });

  it("rejects invalid or unconfirmed requests without changing the flag", async () => {
    const response = await POST(
      await requestWithRole("admin", {
        flag: "securityReportExport",
        disabled: true,
        confirm: false,
      }),
    );
    expect(response.status).toBe(422);
    expect(isFeatureEnabled("securityReportExport", {
      TRELLIS_FEATURE_SECURITY_REPORT_EXPORT: "true",
    })).toBe(true);
  });
});
