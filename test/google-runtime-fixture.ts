import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

import type { PiRuntime } from "./support/src.ts";

export const testPi = (): PiRuntime => ({
  getBuiltinModels: (plane) =>
    getBuiltinModels(plane as Parameters<typeof getBuiltinModels>[0]),
  googleGenerativeAIApi,
  version: "test",
});
