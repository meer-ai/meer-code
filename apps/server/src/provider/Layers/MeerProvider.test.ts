import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { MeerSettings } from "@meer-ai/contracts";
import { checkMeerProviderStatus } from "./MeerProvider.ts";

const decodeMeerSettings = Schema.decodeSync(MeerSettings);
const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.effect("passes the resolved environment to the Meer CLI health check", () =>
  Effect.gen(function* () {
    const commands: Array<{
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const cmd = command as unknown as {
          args: ReadonlyArray<string>;
          options?: {
            readonly env?: NodeJS.ProcessEnv;
          };
        };
        commands.push({ args: cmd.args, env: cmd.options?.env });
        return Effect.succeed(mockHandle({ stdout: "meer 1.2.3\n", stderr: "", code: 0 }));
      }),
    );

    const env = {
      PATH: "C:\\Users\\saif\\AppData\\Roaming\\npm",
      MEER_CODE_TEST_SENTINEL: "probe-env",
    };
    const snapshot = yield* checkMeerProviderStatus(
      decodeMeerSettings({ enabled: true }),
      env,
    ).pipe(Effect.provide(spawnerLayer));

    assert.equal(snapshot.status, "ready");
    assert.deepEqual(
      commands.map((command) => command.args),
      [["--version"]],
    );
    assert.equal(commands[0]?.env?.MEER_CODE_TEST_SENTINEL, "probe-env");
    assert.equal(commands[0]?.env?.PATH, env.PATH);
  }),
);
