import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type {
  BranchNameGenerationInput,
  CommitMessageGenerationInput,
  PrContentGenerationInput,
  TextGenerationShape,
  ThreadTitleGenerationInput,
} from "./TextGeneration.ts";

function unsupported(operation: string, providerName: string): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail: `${providerName} does not support background text generation yet.`,
  });
}

export function makeUnsupportedTextGeneration(providerName: string): TextGenerationShape {
  return {
    generateCommitMessage: (_input: CommitMessageGenerationInput) =>
      Effect.fail(unsupported("generateCommitMessage", providerName)),
    generatePrContent: (_input: PrContentGenerationInput) =>
      Effect.fail(unsupported("generatePrContent", providerName)),
    generateBranchName: (_input: BranchNameGenerationInput) =>
      Effect.fail(unsupported("generateBranchName", providerName)),
    generateThreadTitle: (_input: ThreadTitleGenerationInput) =>
      Effect.fail(unsupported("generateThreadTitle", providerName)),
  };
}
