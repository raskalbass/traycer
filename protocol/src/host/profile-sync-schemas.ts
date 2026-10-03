import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { providerProfileAccentColorSchema } from "./provider-schemas";
import {
  profileCopyAttemptSchema,
  profileCopyHostIdSchema,
  profileCopyIdSchema,
  profileCopyOutcomeSchema,
  profileCopyPreviewResponseSchema,
  profileCopyProviderSchema,
  profileCopySourceProfileIdSchema,
} from "./profile-copy-schemas";

export const profileSyncSettingsSchema = lazySchema(() =>
  z.strictObject({
    name: z.string().min(1).max(128),
    color: providerProfileAccentColorSchema,
    enabled: z.boolean(),
  }),
);
export type ProfileSyncSettings = z.infer<typeof profileSyncSettingsSchema>;
export const profileSyncScopeSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({
      kind: z.literal("selected"),
      providers: z
        .array(profileCopyProviderSchema)
        .min(1)
        .max(4)
        .refine((v) => new Set(v).size === v.length),
    }),
  ]),
);
export type ProfileSyncScope = z.infer<typeof profileSyncScopeSchema>;
export const profileSyncSelectionSchema = lazySchema(() =>
  z
    .strictObject({
      sourceHostId: profileCopyHostIdSchema,
      scope: profileSyncScopeSchema,
      destinationHostIds: z
        .array(profileCopyHostIdSchema)
        .min(1)
        .max(16)
        .refine((v) => new Set(v).size === v.length),
    })
    .refine((v) => !v.destinationHostIds.includes(v.sourceHostId)),
);
export type ProfileSyncSelection = z.infer<typeof profileSyncSelectionSchema>;
export const profileSyncSourceRequestSchema = lazySchema(() =>
  z.strictObject({ sourceHostId: profileCopyHostIdSchema }),
);
export const profileSyncItemSchema = lazySchema(() =>
  z.strictObject({
    providerId: profileCopyProviderSchema,
    sourceProfileId: profileCopySourceProfileIdSchema,
    name: z.string().max(128),
    destinationHostId: profileCopyHostIdSchema,
    operationId: profileCopyIdSchema,
    preview: profileCopyPreviewResponseSchema.nullable(),
    outcome: profileCopyOutcomeSchema.nullable(),
    state: z.enum([
      "ready",
      "queued",
      "copying",
      "synced",
      "already-present",
      "needs-action",
      "conflict",
      "paused",
      "unavailable",
      "update-required",
      "unconfirmed",
      "source-removed",
    ]),
    sourceSettings: profileSyncSettingsSchema,
    sourceIdentityStamp: z.string().regex(/^[a-f0-9]{64}$/),
    identityChanged: z.boolean(),
    destinationSettings: profileSyncSettingsSchema.nullable(),
    baseline: profileSyncSettingsSchema.nullable(),
  }),
);
export type ProfileSyncItem = z.infer<typeof profileSyncItemSchema>;
export const profileSyncPreviewSchema = lazySchema(() =>
  z.strictObject({
    selection: profileSyncSelectionSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    items: z.array(profileSyncItemSchema).max(512),
  }),
);
export type ProfileSyncPreview = z.infer<typeof profileSyncPreviewSchema>;
export const profileSyncStartSchema = lazySchema(() =>
  z.strictObject({
    selection: profileSyncSelectionSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    batchId: profileCopyIdSchema,
  }),
);
export const profileSyncBatchSchema = lazySchema(() =>
  z.strictObject({
    batchId: profileCopyIdSchema,
    sourceHostId: profileCopyHostIdSchema,
    createdAt: z.number(),
    automatic: z.boolean(),
    items: z.array(profileSyncItemSchema).max(512),
  }),
);
export type ProfileSyncBatch = z.infer<typeof profileSyncBatchSchema>;
export const profileSyncRuleSchema = lazySchema(() =>
  z.strictObject({
    ruleId: profileCopyIdSchema,
    sourceHostId: profileCopyHostIdSchema,
    destinationHostId: profileCopyHostIdSchema,
    scope: profileSyncScopeSchema,
    paused: z.boolean(),
    revision: z.number().int().nonnegative(),
    lastCheckedAt: z.number().nullable(),
    batchId: profileCopyIdSchema.nullable(),
    status: z.enum(["waiting", "active", "needs-action", "paused"]),
  }),
);
export type ProfileSyncRule = z.infer<typeof profileSyncRuleSchema>;
export const profileSyncListSchema = lazySchema(() =>
  z.strictObject({
    batches: z.array(profileSyncBatchSchema),
    rules: z.array(profileSyncRuleSchema),
  }),
);
export type ProfileSyncList = z.infer<typeof profileSyncListSchema>;
export const profileSyncSaveRuleSchema = lazySchema(() =>
  z
    .strictObject({
      ruleId: profileCopyIdSchema,
      sourceHostId: profileCopyHostIdSchema,
      destinationHostId: profileCopyHostIdSchema,
      scope: profileSyncScopeSchema,
      paused: z.boolean(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .refine((v) => v.sourceHostId !== v.destinationHostId),
);
export type ProfileSyncSaveRule = z.infer<typeof profileSyncSaveRuleSchema>;
export const profileSyncStopRuleSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileCopyHostIdSchema,
    ruleId: profileCopyIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
);
export const profileSyncResolveSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileCopyHostIdSchema,
    batchId: profileCopyIdSchema,
    operationId: profileCopyIdSchema,
    action: z.enum(["keep-destination", "use-source", "check"]),
    expectedDestination: profileSyncSettingsSchema.nullable(),
  }),
);
export type ProfileSyncResolve = z.infer<typeof profileSyncResolveSchema>;
export const profileSyncApplySchema = lazySchema(() =>
  z.strictObject({
    attempt: profileCopyAttemptSchema,
    desired: profileSyncSettingsSchema,
    expected: profileSyncSettingsSchema.nullable(),
    inspectOnly: z.boolean(),
  }),
);
export type ProfileSyncApply = z.infer<typeof profileSyncApplySchema>;
export const profileSyncApplyResultSchema = lazySchema(() =>
  z.strictObject({
    state: z.enum(["synced", "conflict", "unlinked", "removed", "pending"]),
    current: profileSyncSettingsSchema.nullable(),
  }),
);
export type ProfileSyncApplyResult = z.infer<
  typeof profileSyncApplyResultSchema
>;
