import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
  type MeerSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@meer-ai/contracts";
import { randomUUID } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectStreamAsString } from "../providerSnapshot.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("meer");
const MEER_DEFAULT_MODEL_SLUG = "default";
const decodeJsonLine = Schema.decodeEffect(Schema.UnknownFromJsonString);

interface MeerJsonEvent {
  readonly type?: unknown;
  readonly timestamp?: unknown;
  readonly delta?: unknown;
  readonly content?: unknown;
  readonly tool?: unknown;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly metadata?: unknown;
  readonly message?: unknown;
  readonly exitCode?: unknown;
}

interface MeerSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  completedAssistantTurns: Set<TurnId>;
}

export interface MeerAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

type MeerAdapterError =
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
  | ProviderAdapterRequestError;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asExitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function toolItemType(tool: string): "command_execution" | "file_change" | "dynamic_tool_call" {
  const normalized = tool.toLowerCase();
  if (
    normalized.includes("shell") ||
    normalized.includes("bash") ||
    normalized.includes("terminal") ||
    normalized.includes("command") ||
    normalized.includes("exec")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("file") ||
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch")
  ) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const makeMeerAdapter = Effect.fn("makeMeerAdapter")(function* (
  meerSettings: MeerSettings,
  options?: MeerAdapterOptions,
): Effect.fn.Return<
  ProviderAdapterShape<MeerAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, MeerSessionContext>();
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("meer");
  const environment = { ...process.env, ...options?.environment };
  const adapterRunId = randomUUID().slice(0, 8);
  let eventSequence = 0;
  let turnSequence = 0;
  let itemSequence = 0;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextTurnId = () => TurnId.make(`meer-turn-${adapterRunId}-${++turnSequence}`);
  const nextEventId = () => EventId.make(`meer-event-${adapterRunId}-${++eventSequence}`);
  const nextItemId = (prefix: string, turnId: TurnId) =>
    RuntimeItemId.make(`meer-${adapterRunId}-${turnId}-${prefix}-${++itemSequence}`);
  const eventBase = (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly itemId?: RuntimeItemId;
    readonly raw?: unknown;
    readonly createdAt?: string;
  }) => ({
    eventId: nextEventId(),
    provider: PROVIDER,
    providerInstanceId: instanceId,
    threadId: input.threadId,
    createdAt:
      input.createdAt ?? asString((input.raw as MeerJsonEvent | undefined)?.timestamp) ?? "",
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "meer.cli.jsonl" as const,
            payload: input.raw,
          },
        }
      : {}),
  });

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) =>
    Effect.sync(() => sessions.get(threadId)).pipe(
      Effect.flatMap((context) =>
        context
          ? Effect.succeed(context)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      ),
    );

  const updateSession = (
    context: MeerSessionContext,
    patch: Partial<ProviderSession>,
  ): Effect.Effect<void> =>
    nowIso.pipe(
      Effect.map((updatedAt) => {
        context.session = { ...context.session, ...patch, updatedAt };
      }),
    );

  const ensureAssistantItem = (
    context: MeerSessionContext,
    turnId: TurnId,
    raw: MeerJsonEvent,
  ): Effect.Effect<RuntimeItemId> =>
    Effect.gen(function* () {
      if (context.activeAssistantItemId) {
        return context.activeAssistantItemId;
      }
      const itemId = RuntimeItemId.make(`meer-${turnId}-assistant`);
      context.activeAssistantItemId = itemId;
      yield* emit({
        type: "item.started",
        ...eventBase({ threadId: context.threadId, turnId, itemId, raw, createdAt: yield* nowIso }),
        payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
      });
      return itemId;
    });

  const completeAssistantItem = (
    context: MeerSessionContext,
    turnId: TurnId,
    raw: MeerJsonEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const itemId = context.activeAssistantItemId;
      if (!itemId) return;
      context.activeAssistantItemId = undefined;
      context.completedAssistantTurns.add(turnId);
      yield* emit({
        type: "item.completed",
        ...eventBase({ threadId: context.threadId, turnId, itemId, raw, createdAt: yield* nowIso }),
        payload: { itemType: "assistant_message", status: "completed", title: "Assistant" },
      });
    });

  const handleJsonEvent = (
    context: MeerSessionContext,
    turnId: TurnId,
    event: MeerJsonEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const createdAt = asString(event.timestamp) ?? (yield* nowIso);
      switch (event.type) {
        case "assistant.started": {
          yield* ensureAssistantItem(context, turnId, event);
          return;
        }
        case "assistant.delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          const itemId = yield* ensureAssistantItem(context, turnId, event);
          yield* emit({
            type: "content.delta",
            ...eventBase({ threadId: context.threadId, turnId, itemId, raw: event, createdAt }),
            payload: { streamKind: "assistant_text", delta },
          });
          return;
        }
        case "assistant.completed": {
          yield* completeAssistantItem(context, turnId, event);
          return;
        }
        case "assistant.message": {
          if (context.completedAssistantTurns.has(turnId)) return;
          const content = asString(event.content);
          if (!content) return;
          const itemId = yield* ensureAssistantItem(context, turnId, event);
          yield* emit({
            type: "content.delta",
            ...eventBase({ threadId: context.threadId, turnId, itemId, raw: event, createdAt }),
            payload: { streamKind: "assistant_text", delta: content },
          });
          yield* completeAssistantItem(context, turnId, event);
          return;
        }
        case "reasoning.message": {
          const content = asString(event.content);
          if (!content) return;
          const itemId = nextItemId("reasoning", turnId);
          yield* emit({
            type: "item.completed",
            ...eventBase({ threadId: context.threadId, turnId, itemId, raw: event, createdAt }),
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Reasoning",
              detail: content,
            },
          });
          return;
        }
        case "tool.started": {
          const tool = asString(event.tool) ?? "tool";
          const itemId = nextItemId("tool", turnId);
          yield* emit({
            type: "item.started",
            ...eventBase({ threadId: context.threadId, turnId, itemId, raw: event, createdAt }),
            payload: {
              itemType: toolItemType(tool),
              status: "inProgress",
              title: tool,
              data: { args: event.args },
            },
          });
          return;
        }
        case "tool.message": {
          const tool = asString(event.tool) ?? "tool";
          const result = typeof event.result === "string" ? event.result.trim() : "";
          const itemId = nextItemId("tool", turnId);
          yield* emit({
            type: "item.completed",
            ...eventBase({ threadId: context.threadId, turnId, itemId, raw: event, createdAt }),
            payload: {
              itemType: toolItemType(tool),
              status:
                typeof event.metadata === "object" &&
                event.metadata !== null &&
                (event.metadata as { isError?: unknown }).isError === true
                  ? "failed"
                  : "completed",
              title: tool,
              ...(result ? { detail: result.slice(0, 2_000) } : {}),
              data: { metadata: event.metadata },
            },
          });
          return;
        }
        case "run.error": {
          yield* emit({
            type: "runtime.error",
            ...eventBase({ threadId: context.threadId, turnId, raw: event, createdAt }),
            payload: {
              class: "provider_error",
              message: asString(event.message) ?? "Meer CLI reported an error.",
            },
          });
          return;
        }
      }
    });

  const runTurnProcess = (
    context: MeerSessionContext,
    input: ProviderSendTurnInput,
    turnId: TurnId,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const prompt = input.input?.trim() ?? "";
      const cwd = context.session.cwd ?? process.cwd();
      const model =
        input.modelSelection?.instanceId === instanceId
          ? input.modelSelection.model
          : context.session.model;
      const args = ["run", "--json", "--yes", "--cwd", cwd];
      if (model && model !== MEER_DEFAULT_MODEL_SLUG) args.push("--model", model);
      args.push(prompt);

      const child = yield* spawner
        .spawn(
          ChildProcess.make(meerSettings.binaryPath, args, {
            cwd,
            env: environment,
            shell: process.platform === "win32",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "meer run",
                detail: "Failed to start Meer CLI.",
                cause,
              }),
          ),
        );

      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      const stdoutFiber = yield* child.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              if (!trimmed.startsWith("{")) {
                continue;
              }
              const parsedExit = yield* Effect.exit(decodeJsonLine(trimmed));
              if (Exit.isFailure(parsedExit)) {
                continue;
              }
              const parsed = parsedExit.value as MeerJsonEvent;
              const code = asExitCode(parsed.exitCode);
              if (parsed.type === "run.completed" && code !== undefined) {
                completed = true;
                yield* completeAssistantItem(context, turnId, parsed);
                yield* updateSession(context, { status: "ready", activeTurnId: undefined });
                context.activeFiber = undefined;
                context.activeTurnId = undefined;
                yield* emit({
                  type: "turn.completed",
                  ...eventBase({
                    threadId: context.threadId,
                    turnId,
                    raw: parsed,
                    createdAt: asString(parsed.timestamp) ?? (yield* nowIso),
                  }),
                  payload: {
                    state: code === 0 ? "completed" : code === 130 ? "interrupted" : "failed",
                    ...(code === 0 ? {} : { errorMessage: `Meer CLI exited with code ${code}.` }),
                  },
                });
                continue;
              }
              yield* handleJsonEvent(context, turnId, parsed);
            }
          }),
        ),
        Effect.forkScoped,
      );
      const stderrFiber = yield* collectStreamAsString(child.stderr).pipe(Effect.forkScoped);
      const exitCodeExit = yield* Effect.exit(child.exitCode);
      const exitCode = Exit.isSuccess(exitCodeExit) ? exitCodeExit.value : 1;
      yield* Fiber.await(stdoutFiber);
      const stderrExit = yield* Fiber.await(stderrFiber);
      const stderr = Exit.isSuccess(stderrExit) ? stderrExit.value : "";

      if (!completed) {
        yield* completeAssistantItem(context, turnId, { type: "run.completed", exitCode });
        yield* updateSession(context, { status: "ready", activeTurnId: undefined });
        context.activeFiber = undefined;
        context.activeTurnId = undefined;
        yield* emit({
          type: "turn.completed",
          ...eventBase({
            threadId: context.threadId,
            turnId,
            raw: { exitCode, stderr },
            createdAt: yield* nowIso,
          }),
          payload: {
            state: exitCode === 0 ? "completed" : "failed",
            ...(exitCode === 0
              ? {}
              : { errorMessage: stderr.trim() || `Meer CLI exited with code ${exitCode}.` }),
          },
        });
      }
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          yield* updateSession(context, {
            status: "error",
            activeTurnId: undefined,
            lastError: errorMessage(error),
          });
          context.activeFiber = undefined;
          context.activeTurnId = undefined;
          yield* emit({
            type: "runtime.error",
            ...eventBase({
              threadId: context.threadId,
              turnId,
              raw: errorMessage(error),
              createdAt: yield* nowIso,
            }),
            payload: {
              class: "transport_error",
              message: `Failed to run Meer CLI: ${errorMessage(error)}`,
            },
          });
        }),
      ),
    );

  const stopProcess = (context: MeerSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fiber = context.activeFiber;
      context.activeFiber = undefined;
      context.activeTurnId = undefined;
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }
      yield* updateSession(context, { status: "ready", activeTurnId: undefined });
    });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], (context) => stopProcess(context), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
  );

  const startSession = (input: ProviderSessionStartInput) =>
    Effect.gen(function* () {
      if (!meerSettings.enabled) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Meer provider is disabled.",
        });
      }

      const scope = yield* Scope.make();
      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };
      const context: MeerSessionContext = {
        threadId: input.threadId,
        scope,
        session,
        turns: [],
        activeFiber: undefined,
        activeTurnId: undefined,
        activeAssistantItemId: undefined,
        completedAssistantTurns: new Set(),
      };
      sessions.set(input.threadId, context);

      yield* emit({
        type: "session.started",
        ...eventBase({ threadId: input.threadId, createdAt }),
        payload: { message: "Meer CLI session started." },
      });
      yield* emit({
        type: "session.state.changed",
        ...eventBase({ threadId: input.threadId, createdAt }),
        payload: { state: "ready", reason: "Meer CLI session ready" },
      });
      yield* emit({
        type: "thread.started",
        ...eventBase({ threadId: input.threadId, createdAt }),
        payload: { providerThreadId: String(input.threadId) },
      });

      return session;
    });

  const sendTurn = (
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, MeerAdapterError> =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (!input.input?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Meer requires a non-empty prompt.",
        });
      }
      if (context.activeFiber) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A Meer turn is already running for this thread.",
        });
      }

      const turnId = nextTurnId();
      const createdAt = yield* nowIso;
      context.activeTurnId = turnId;
      context.turns.push({ id: turnId, items: [] });
      yield* updateSession(context, {
        status: "running",
        activeTurnId: turnId,
        ...(input.modelSelection?.instanceId === instanceId
          ? { model: input.modelSelection.model }
          : {}),
      });
      yield* emit({
        type: "turn.started",
        ...eventBase({ threadId: input.threadId, turnId, createdAt }),
        payload: context.session.model ? { model: context.session.model } : {},
      });

      context.activeFiber = yield* runTurnProcess(context, input, turnId).pipe(
        Effect.provideService(Scope.Scope, context.scope),
        Effect.forkIn(context.scope),
      );
      return { threadId: input.threadId, turnId };
    });

  const stopSession = (threadId: ThreadId): Effect.Effect<void, MeerAdapterError> =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) =>
        stopProcess(context).pipe(
          Effect.andThen(Scope.close(context.scope, Exit.void)),
          Effect.tap(() => Effect.sync(() => sessions.delete(threadId))),
        ),
      ),
    );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopProcess)),
    respondToRequest: (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) => Effect.void,
    respondToUserInput: (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) => Effect.void,
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns }))),
    rollbackThread: (threadId, numTurns) =>
      requireSession(threadId).pipe(
        Effect.map((context) => {
          context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
          return { threadId, turns: context.turns };
        }),
      ),
    stopAll: () =>
      Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }),
    streamEvents: Stream.fromQueue(runtimeEvents),
  };
});
