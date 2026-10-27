import { isFunctionLike, isRecord } from "./utils/guards.ts";

/** Capture an optional service through a real Cordis child scope. */
const optionalService = (ctx: unknown, name: string) => {
  let current: unknown;
  let subscription: unknown;
  if (isRecord(ctx) && isFunctionLike(ctx.inject)) {
    subscription = Reflect.apply(ctx.inject, ctx, [
      [name],
      (scope: unknown) => {
        if (!isRecord(scope) || !isFunctionLike(scope.get)) return;
        const service: unknown = Reflect.apply(scope.get, scope, [name]);
        current = service;
        if (isFunctionLike(scope.effect)) {
          Reflect.apply(scope.effect, scope, [
            () => () => {
              if (current === service) current = undefined;
            },
            "plane adapter: optional attachment service",
          ]);
        }
      },
    ]);
  }
  return {
    get: (): unknown => current,
    dispose: (): void => {
      current = undefined;
      if (isRecord(subscription) && isFunctionLike(subscription.dispose)) {
        Reflect.apply(subscription.dispose, subscription, []);
      }
    },
  };
};

/** Match the host adapter's durable-image hooks without requiring images for text calls. */
export const attachmentResolvers = (ctx: unknown) => {
  const attachments = optionalService(ctx, "attachments");
  const filesystem = optionalService(ctx, "fs");
  return {
    resolveAttachments: attachments.get,
    resolveImageAccess: (store: unknown, ref: unknown): unknown => {
      const fs = filesystem.get();
      if (
        !isRecord(store) ||
        !isFunctionLike(store.imageHostPath) ||
        !isRecord(fs) ||
        !isFunctionLike(fs.processPathFromHostPath)
      )
        return undefined;
      const hostPath: unknown = Reflect.apply(store.imageHostPath, store, [
        ref,
      ]);
      if (typeof hostPath !== "string") return undefined;
      const readonlyPath: unknown = Reflect.apply(
        fs.processPathFromHostPath,
        fs,
        [hostPath]
      );
      return typeof readonlyPath === "string" ? { readonlyPath } : undefined;
    },
    dispose: (): void => {
      attachments.dispose();
      filesystem.dispose();
    },
  };
};
