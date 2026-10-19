import {
  getFeatureFlags,
  isFeatureEnabled,
  setFeatureFlagEmergencyDisabled,
  setFeatureFlagOverride,
  startFeatureFlagPolling,
  subscribeToFeatureFlagChanges,
  updateRemoteFeatureFlags,
} from "@/lib/feature-flags";

describe("feature flags", () => {
  afterEach(() => {
    updateRemoteFeatureFlags({});
    setFeatureFlagEmergencyDisabled("stableBugReportPagination", false);
    setFeatureFlagEmergencyDisabled("securityReportExport", false);
    setFeatureFlagOverride("stableBugReportPagination", null);
    setFeatureFlagOverride("securityReportExport", null);
  });

  it("uses safe defaults when configuration is missing", () => {
    expect(getFeatureFlags({})).toEqual({
      stableBugReportPagination: true,
      securityReportExport: false,
    });
  });

  it("accepts explicit enabled and disabled values", () => {
    expect(
      isFeatureEnabled("stableBugReportPagination", {
        TRELLIS_FEATURE_STABLE_BUG_REPORT_PAGINATION: "false",
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled("securityReportExport", {
        TRELLIS_FEATURE_SECURITY_REPORT_EXPORT: "true",
      }),
    ).toBe(true);
  });

  it("assigns a stable cohort close to the configured percentage", () => {
    updateRemoteFeatureFlags({
      securityReportExport: { enabled: true, rolloutPercentage: 10 },
    });

    const users = Array.from({ length: 10_000 }, (_, index) => `user-${index}`);
    const includedUsers = users.filter((userId) =>
      isFeatureEnabled("securityReportExport", {}, userId),
    );
    const repeatedAssignments = users.filter((userId) =>
      isFeatureEnabled("securityReportExport", {}, userId),
    );

    expect(includedUsers.length).toBeGreaterThanOrEqual(900);
    expect(includedUsers.length).toBeLessThanOrEqual(1_100);
    expect(repeatedAssignments).toEqual(includedUsers);
    expect(isFeatureEnabled("securityReportExport", {}, "")).toBe(false);
  });

  it("lets maintainers override a flag in local storage", () => {
    setFeatureFlagOverride("securityReportExport", true);
    expect(isFeatureEnabled("securityReportExport", {})).toBe(true);

    setFeatureFlagOverride("securityReportExport", false);
    expect(isFeatureEnabled("securityReportExport", {})).toBe(false);
  });

  it("keeps emergency disablement above local overrides and normal configuration", () => {
    updateRemoteFeatureFlags({
      securityReportExport: { enabled: true, emergencyDisabled: true },
    });
    setFeatureFlagOverride("securityReportExport", true);
    expect(isFeatureEnabled("securityReportExport", {})).toBe(false);

    updateRemoteFeatureFlags({
      securityReportExport: { enabled: true },
    });
    setFeatureFlagEmergencyDisabled("securityReportExport", true);
    expect(isFeatureEnabled("securityReportExport", {})).toBe(false);
    setFeatureFlagEmergencyDisabled("securityReportExport", false);
    expect(isFeatureEnabled("securityReportExport", {})).toBe(true);
  });

  it("honors the environment emergency-disable guard before local overrides", () => {
    setFeatureFlagOverride("securityReportExport", true);
    expect(
      isFeatureEnabled("securityReportExport", {
        TRELLIS_FEATURE_SECURITY_REPORT_EXPORT: "true",
        TRELLIS_FEATURE_SECURITY_REPORT_EXPORT_EMERGENCY_DISABLED: "true",
      }),
    ).toBe(false);
  });

  it("applies polled remote changes without restarting evaluation", async () => {
    let pollCount = 0;
    const fetcher = jest.fn(async () => {
      pollCount += 1;
      return {
        ok: true,
        json: async () => ({
          flags: { securityReportExport: { enabled: pollCount > 1 } },
        }),
      } as Response;
    });
    const listener = jest.fn();
    const unsubscribe = subscribeToFeatureFlagChanges(listener);
    jest.useFakeTimers();
    const stopPolling = startFeatureFlagPolling({
      url: "https://flags.example.test/config",
      intervalMs: 5,
      fetcher,
    });

    try {
      await jest.advanceTimersByTimeAsync(10);
      expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(isFeatureEnabled("securityReportExport", {})).toBe(true);
      expect(listener).toHaveBeenCalled();
    } finally {
      stopPolling();
      unsubscribe();
      jest.useRealTimers();
    }
  });

  it("retains the last value on poll failure and retries with backoff", async () => {
    updateRemoteFeatureFlags({
      securityReportExport: { enabled: false },
    });
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          flags: { securityReportExport: { enabled: true } },
        }),
      } as Response);
    const onError = jest.fn();
    jest.useFakeTimers();
    const stopPolling = startFeatureFlagPolling({
      url: "https://flags.example.test/config",
      intervalMs: 5,
      maxRetryIntervalMs: 20,
      fetcher,
      onError,
    });

    try {
      await jest.advanceTimersByTimeAsync(4);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(isFeatureEnabled("securityReportExport", {})).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(9);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(isFeatureEnabled("securityReportExport", {})).toBe(true);
    } finally {
      stopPolling();
      jest.useRealTimers();
    }
  });
});
