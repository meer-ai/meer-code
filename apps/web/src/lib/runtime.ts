import * as ManagedRuntime from "effect/ManagedRuntime";

import { remoteHttpClientLayer } from "@meer-ai/client-runtime";

export const remoteHttpRuntime = ManagedRuntime.make(remoteHttpClientLayer(globalThis.fetch));
