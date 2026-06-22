import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@meer-ai/contracts";

import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  getProviderUpdateSidebarPillView,
  getSingleProviderUpdateProgressToastView,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateCandidate,
  providerUpdateNotificationKey,
  type ProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";

const checkedAt = "2026-04-23T10:00:00.000Z";
const sessionStartedAt = "2026-04-23T09:59:00.000Z";
const laterCheckedAt = "2026-04-23T10:01:00.000Z";

const driver = (value: string) => ProviderDriverKind.make(value);
const instanceId = (value: string) => ProviderInstanceId.make(value);

function provider(input: {
  readonly driver: ReturnType<typeof ProviderDriverKind.make>;
  readonly instanceId?: ReturnType<typeof ProviderInstanceId.make>;
  readonly enabled?: boolean;
  readonly version?: string | null;
  readonly latestVersion?: string | null;
  readonly canUpdate?: boolean;
  readonly updateCommand?: string | null;
  readonly updateState?: ServerProvider["updateState"];
  readonly advisoryStatus?: NonNullable<ServerProvider["versionAdvisory"]>["status"];
}): ServerProvider {
  const result: ServerProvider = {
    instanceId: input.instanceId ?? instanceId(String(input.driver)),
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: input.version ?? "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: input.advisoryStatus ?? "behind_latest",
      currentVersion: input.version ?? "1.0.0",
      latestVersion: "latestVersion" in input ? input.latestVersion : "1.1.0",
      updateCommand: "updateCommand" in input ? input.updateCommand : "npm install -g provider",
      canUpdate: input.canUpdate ?? true,
      checkedAt,
      message: "Update available.",
    },
  };

  if (input.updateState) {
    return { ...result, updateState: input.updateState };
  }

  return result;
}

function updateCandidate(input: Parameters<typeof provider>[0]): ProviderUpdateCandidate {
  return provider(input) as ProviderUpdateCandidate;
}

describe("provider update launch notification logic", () => {
  it("detects enabled providers with a latest-version advisory", () => {
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex") }))).toBe(true);
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex"), enabled: false }))).toBe(
      false,
    );
    expect(
      isProviderUpdateCandidate(
        provider({ driver: driver("codex"), advisoryStatus: "current", latestVersion: null }),
      ),
    ).toBe(false);
    expect(
      isProviderUpdateCandidate(provider({ driver: driver("codex"), latestVersion: null })),
    ).toBe(false);
  });

  it("deduplicates multi-instance provider candidates by driver", () => {
    expect(
      collectProviderUpdateCandidates([
        provider({
          driver: driver("codex"),
          instanceId: instanceId("codex_personal"),
          latestVersion: "1.1.0",
        }),
        provider({
          driver: driver("codex"),
          instanceId: instanceId("codex"),
          latestVersion: "1.1.0",
        }),
        provider({ driver: driver("cursor"), latestVersion: "0.3.0" }),
      ]),
    ).toHaveLength(2);
  });

  it("disables one-click updates when provider instances disagree on the update command", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
    });

    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          latestVersion: "2.1.123",
          canUpdate: true,
          updateCommand: "bun add -g @anthropic-ai/claude-code@latest",
        }),
      ]),
    ).toBe(false);
  });

  it("keeps one-click updates enabled when sibling instances are already current", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
      updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
    });

    expect(
      hasOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
  });

  it("keeps the inline update action available while a provider update is already running", () => {
    const candidate = updateCandidate({
      driver: driver("codex"),
      updateState: {
        status: "running",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Updating provider.",
        output: null,
      },
    });

    expect(hasOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(true);
    expect(canOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(false);
  });

  it("builds a notification key from provider latest versions", () => {
    const codex = updateCandidate({
      driver: driver("codex"),
      version: "1.0.0",
      latestVersion: "1.1.0",
    });
    const cursor = updateCandidate({
      driver: driver("cursor"),
      version: "0.2.0",
      latestVersion: "0.3.0",
    });

    expect(providerUpdateNotificationKey([codex, cursor])).toBe("codex:1.1.0|cursor:0.3.0");
    expect(providerUpdateNotificationKey([])).toBeNull();
  });

  it("keeps the same notification key while the published update version is unchanged", () => {
    const first = updateCandidate({
      driver: driver("codex"),
      version: "1.0.0",
      latestVersion: "1.2.0",
    });
    const second = updateCandidate({
      driver: driver("codex"),
      version: "1.1.0",
      latestVersion: "1.2.0",
    });
    const nextPublishedVersion = updateCandidate({
      driver: driver("codex"),
      version: "1.1.0",
      latestVersion: "1.3.0",
    });

    expect(providerUpdateNotificationKey([first])).toBe(providerUpdateNotificationKey([second]));
    expect(providerUpdateNotificationKey([nextPublishedVersion])).not.toBe(
      providerUpdateNotificationKey([first]),
    );
  });

  it("tracks updated provider snapshots by instance instead of collapsing to a sibling driver", () => {
    const targetInstanceId = instanceId("codex_personal");
    const siblingInstanceId = instanceId("codex");
    const updatedPersonal = provider({
      driver: driver("codex"),
      instanceId: targetInstanceId,
      version: "1.1.0",
      latestVersion: "1.1.0",
      advisoryStatus: "current",
      updateState: {
        status: "succeeded",
        startedAt: checkedAt,
        finishedAt: checkedAt,
        message: "Provider updated.",
        output: null,
      },
    });
    const currentDefaultSibling = provider({
      driver: driver("codex"),
      instanceId: siblingInstanceId,
      version: "1.1.0",
      latestVersion: "1.1.0",
      advisoryStatus: "current",
      updateState: undefined,
    });

    expect(
      collectUpdatedProviderSnapshots({
        results: [
          {
            status: "fulfilled",
            value: {
              providers: [updatedPersonal, currentDefaultSibling],
            },
          },
        ],
        providerInstanceIds: new Set([targetInstanceId]),
      }),
    ).toEqual([updatedPersonal]);
  });

  it("describes a single one-click update", () => {
    const view = getProviderUpdateInitialToastView({
      updateProviders: [updateCandidate({ driver: driver("meer"), latestVersion: "1.1.0" })],
      oneClickProviders: [updateCandidate({ driver: driver("meer"), latestVersion: "1.1.0" })],
    });

    expect(view).toMatchObject({
      phase: "initial",
      type: "warning",
      title: "Update Available: Meer v1.1.0",
      description: "Install the update now or review provider settings.",
    });
  });

  it("describes settings-only updates without one-click support", () => {
    const view = getProviderUpdateInitialToastView({
      updateProviders: [updateCandidate({ driver: driver("meer"), canUpdate: false })],
      oneClickProviders: [],
    });

    expect(view.description).toBe("Meer can be updated from provider settings.");
  });

  it("uses server update state for running progress", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("codex"),
          updateState: {
            status: "running",
            startedAt: checkedAt,
            finishedAt: null,
            message: "Updating provider.",
            output: null,
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "running",
      type: "loading",
      title: "Updating provider",
    });
  });

  it("uses server failure state for failed progress", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("codex"),
          updateState: {
            status: "failed",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "command failed",
            output: "stderr",
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "failed",
      type: "error",
      title: "Provider update failed",
      description: "command failed",
    });
  });

  it("resolves a single-provider completion view from the returned provider snapshot", () => {
    const view = getSingleProviderUpdateProgressToastView(
      provider({
        driver: driver("meer"),
        updateState: {
          status: "failed",
          startedAt: checkedAt,
          finishedAt: checkedAt,
          message: "command failed",
          output: "stderr",
        },
      }),
    );

    expect(view).toMatchObject({
      phase: "failed",
      type: "error",
      title: "Meer v1.1.0 update failed",
      description: "command failed",
    });
  });

  it("keeps unchanged providers actionable from settings", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("meer"),
          updateState: {
            status: "unchanged",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "still old",
            output: null,
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "unchanged",
      type: "warning",
      title: "Provider still needs an update",
      description: "Meer still appears outdated. Check provider settings for details.",
    });
  });

  it("marks progress succeeded once every attempted provider is no longer outdated", () => {
    const view = getProviderUpdateProgressToastView({
      providers: [
        provider({
          driver: driver("codex"),
          version: "1.1.0",
          latestVersion: "1.1.0",
          advisoryStatus: "current",
          updateState: {
            status: "succeeded",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "Provider updated.",
            output: null,
          },
        }),
      ],
      providerCount: 1,
    });

    expect(view).toMatchObject({
      phase: "succeeded",
      type: "success",
      title: "Provider updated",
      description: "New sessions will use the updated provider.",
      dismissAfterVisibleMs: 3_000,
    });
  });

  it("uses the updated version in the single-provider success toast title", () => {
    const view = getSingleProviderUpdateProgressToastView(
      provider({
        driver: driver("meer"),
        version: "1.1.0",
        latestVersion: "1.1.0",
        advisoryStatus: "current",
        updateState: {
          status: "succeeded",
          startedAt: checkedAt,
          finishedAt: checkedAt,
          message: "Provider updated.",
          output: null,
        },
      }),
    );

    expect(view).toMatchObject({
      phase: "succeeded",
      type: "success",
      title: "Meer updated: v1.1.0",
      description: "New sessions will use the updated provider.",
    });
  });

  it("falls back to a rejected RPC message for transport-level failures", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "rejected", reason: new Error("WebSocket closed") },
    ];

    expect(firstRejectedProviderUpdateMessage(results)).toBe("WebSocket closed");
    expect(getProviderUpdateRejectedToastView(2, "WebSocket closed")).toMatchObject({
      phase: "failed",
      title: "Provider updates failed",
      description: "WebSocket closed",
    });
  });

  it("collects only attempted provider snapshots from update responses", () => {
    const codex = provider({ driver: driver("codex") });
    const cursor = provider({ driver: driver("cursor") });
    const results: PromiseSettledResult<{ readonly providers: ReadonlyArray<ServerProvider> }>[] = [
      { status: "fulfilled", value: { providers: [codex, cursor] } },
    ];

    expect(
      collectUpdatedProviderSnapshots({
        results,
        providerInstanceIds: new Set([cursor.instanceId]),
      }),
    ).toEqual([cursor]);
  });

  it("summarizes a queued provider update for the sidebar pill", () => {
    const view = getProviderUpdateSidebarPillView([
      provider({
        driver: driver("meer"),
        updateState: {
          status: "queued",
          startedAt: null,
          finishedAt: null,
          message: "Waiting for the provider update to start.",
          output: null,
        },
      }),
    ]);

    expect(view).toMatchObject({
      key: "loading:meer:queued",
      tone: "loading",
      title: "Updating Meer",
      description: "Meer update in progress.",
    });
  });

  it("uses the provider name for single active sidebar pill updates", () => {
    const view = getProviderUpdateSidebarPillView([
      provider({
        driver: driver("meer"),
        updateState: {
          status: "running",
          startedAt: checkedAt,
          finishedAt: null,
          message: "Updating provider.",
          output: null,
        },
      }),
    ]);

    expect(view).toMatchObject({
      key: "loading:meer:running",
      tone: "loading",
      title: "Updating Meer",
      description: "Meer update in progress.",
    });
  });

  it("uses the provider name for single failed sidebar pill updates", () => {
    const view = getProviderUpdateSidebarPillView(
      [
        provider({
          driver: driver("meer"),
          updateState: {
            status: "failed",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "Update command exited with code 1.",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "failed:meer:2026-04-23T10:00:00.000Z:Update command exited with code 1.",
      tone: "error",
      title: "Meer v1.1.0 update failed",
      description: "Update command exited with code 1.",
      dismissible: true,
    });
  });

  it("shows a short-lived success sidebar pill after a single provider update succeeds", () => {
    const view = getProviderUpdateSidebarPillView(
      [
        provider({
          driver: driver("meer"),
          version: "1.1.0",
          latestVersion: "1.1.0",
          advisoryStatus: "current",
          updateState: {
            status: "succeeded",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "Provider updated.",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "succeeded:meer:2026-04-23T10:00:00.000Z:Provider updated.",
      tone: "success",
      title: "Meer updated: v1.1.0",
      description: "New sessions will use the updated provider.",
      dismissAfterVisibleMs: 3_000,
    });
  });

  it("keeps unchanged sidebar pill states dismissible", () => {
    const view = getProviderUpdateSidebarPillView(
      [
        provider({
          driver: driver("meer"),
          updateState: {
            status: "unchanged",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "still old",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "unchanged:meer:2026-04-23T10:00:00.000Z:still old",
      tone: "warning",
      title: "Meer still needs an update",
      dismissible: true,
    });
  });

  it("does not show sidebar terminal states from before the current app session", () => {
    expect(
      getProviderUpdateSidebarPillView(
        [
          provider({
            driver: driver("codex"),
            updateState: {
              status: "failed",
              startedAt: checkedAt,
              finishedAt: checkedAt,
              message: "command failed",
              output: "stderr",
            },
          }),
        ],
        { visibleAfterIso: "2026-04-23T10:00:01.000Z" },
      ),
    ).toBeNull();
  });

  it("hides the success sidebar pill once its key is dismissed", () => {
    const providers = [
      provider({
        driver: driver("meer"),
        version: "1.2.0",
        latestVersion: "1.2.0",
        advisoryStatus: "current",
        updateState: {
          status: "succeeded",
          startedAt: laterCheckedAt,
          finishedAt: laterCheckedAt,
          message: "Provider updated.",
          output: null,
        },
      }),
    ] satisfies ReadonlyArray<ServerProvider>;

    const successView = getProviderUpdateSidebarPillView(providers, {
      visibleAfterIso: sessionStartedAt,
    });
    expect(successView).toMatchObject({
      key: "succeeded:meer:2026-04-23T10:01:00.000Z:Provider updated.",
      tone: "success",
      title: "Meer updated: v1.2.0",
    });

    const dismissedView = getProviderUpdateSidebarPillView(providers, {
      visibleAfterIso: sessionStartedAt,
      dismissedKeys: new Set(["succeeded:meer:2026-04-23T10:01:00.000Z:Provider updated."]),
    });
    expect(dismissedView).toBeNull();
  });

  it("does not show a sidebar pill for passive update availability", () => {
    expect(
      getProviderUpdateSidebarPillView([
        provider({ driver: driver("codex"), canUpdate: true }),
        provider({ driver: driver("cursor"), canUpdate: false }),
      ]),
    ).toBeNull();
  });
});
