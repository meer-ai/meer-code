import { ProviderDriverKind, type MeerSettings, type ModelCapabilities } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("meer");
const MEER_PRESENTATION = {
  displayName: "Meer",
  showInteractionModeToggle: false,
} as const;
const DEFAULT_MEER_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const MEER_DEFAULT_MODEL_SLUG = "default";
const MEER_BUILT_IN_MODELS = [
  {
    slug: MEER_DEFAULT_MODEL_SLUG,
    name: "Meer default",
    isCustom: false,
    capabilities: DEFAULT_MEER_MODEL_CAPABILITIES,
  },
] as const;

export const makePendingMeerProvider = (
  meerSettings: MeerSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      MEER_BUILT_IN_MODELS,
      PROVIDER,
      meerSettings.customModels,
      DEFAULT_MEER_MODEL_CAPABILITIES,
    );

    if (!meerSettings.enabled) {
      return buildServerProvider({
        presentation: MEER_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Meer is disabled in Meer Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: MEER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Meer provider status has not been checked in this session yet.",
      },
    });
  });

function formatMeerProbeFailure(cause: unknown): {
  readonly installed: boolean;
  readonly message: string;
} {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (isCommandMissingCause({ message })) {
    return {
      installed: false,
      message: "Meer CLI (`meer`) is not installed or not on PATH.",
    };
  }
  return {
    installed: true,
    message: `Failed to execute Meer CLI health check: ${message}`,
  };
}

export const checkMeerProviderStatus = Effect.fn("checkMeerProviderStatus")(function* (
  meerSettings: MeerSettings,
  _environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = providerModelsFromSettings(
    MEER_BUILT_IN_MODELS,
    PROVIDER,
    meerSettings.customModels,
    DEFAULT_MEER_MODEL_CAPABILITIES,
  );

  if (!meerSettings.enabled) {
    return buildServerProvider({
      presentation: MEER_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Meer is disabled in Meer Code settings.",
      },
    });
  }

  const versionExit = yield* Effect.exit(
    spawnAndCollect(
      meerSettings.binaryPath,
      ChildProcess.make(meerSettings.binaryPath, ["--version"]),
    ),
  );
  if (versionExit._tag === "Failure") {
    const failure = formatMeerProbeFailure(Cause.squash(versionExit.cause));
    return buildServerProvider({
      presentation: MEER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: failure.installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  }

  const result = versionExit.value;
  const version = parseGenericCliVersion(result.stdout || result.stderr) ?? null;
  const detail = result.code === 0 ? undefined : result.stderr || result.stdout;
  const missingCommand =
    result.code !== 0 && detail ? formatMeerProbeFailure(new Error(detail)) : undefined;

  return buildServerProvider({
    presentation: MEER_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: missingCommand?.installed ?? true,
      version,
      status: result.code === 0 ? "ready" : "error",
      auth: { status: "unknown", type: "meer" },
      message:
        result.code === 0
          ? "Meer CLI is available. Add custom models in settings if you want them in the picker."
          : missingCommand?.installed === false
            ? missingCommand.message
            : `Meer CLI health check exited with code ${result.code}${detail ? `: ${detail}` : "."}`,
    },
  });
});
