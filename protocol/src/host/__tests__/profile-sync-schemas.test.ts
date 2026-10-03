import { describe, expect, it } from "vitest";
import {
  PROFILE_SYNC_MAX_BATCHES,
  PROFILE_SYNC_MAX_RULES,
  profileSyncBatchSchema,
  profileSyncItemSchema,
  profileSyncListSchema,
  profileSyncPreviewSchema,
  profileSyncRuleSchema,
  type ProfileSyncBatch,
  type ProfileSyncItem,
  type ProfileSyncRule,
} from "../profile-sync-schemas";

const SOURCE_HOST = "source-host";
const DEST_HOST = "dest-host";
const SOURCE_PROFILE = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";
const REVISION = "a".repeat(64);

function uuid(n: number): string {
  return `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function item(): ProfileSyncItem {
  return {
    providerId: "claude",
    sourceProfileId: SOURCE_PROFILE,
    name: "Work",
    destinationHostId: DEST_HOST,
    operationId: OPERATION_ID,
    preview: {
      source: {
        sourceHostId: SOURCE_HOST,
        sourceProfileId: SOURCE_PROFILE,
        providerId: "claude",
      },
      previewRevision: REVISION,
      destinations: [
        {
          destinationHostId: DEST_HOST,
          feasibility: {
            automatic: {
              status: "available",
              admissionRevision: "b".repeat(64),
            },
            manual: {
              status: "unavailable",
              reason: "manual-login-unavailable",
            },
          },
          disposition: "automatic",
          reason: null,
          existingProfileId: null,
          destinationProviderEnabled: true,
        },
      ],
    },
    outcome: {
      attempt: {
        sourceHostId: SOURCE_HOST,
        sourceProfileId: SOURCE_PROFILE,
        providerId: "claude",
        operationId: OPERATION_ID,
        attemptId: ATTEMPT_ID,
        destinationHostId: DEST_HOST,
      },
      revision: 1,
      state: "preparing",
      reason: null,
      targetProfileId: null,
      targetEnabled: null,
      targetAuthStatus: null,
      replacementAttemptId: null,
      desiredEnabled: true,
      destinationProviderEnabled: true,
      readiness: {
        preparation: "incomplete",
        verification: "not-checked",
        verificationRevision: null,
        acceptedVerificationRevision: null,
        identity: "not-checked",
        identityRevision: null,
        acceptedIdentityRevision: null,
        writer: "none",
        writerGeneration: 0,
        quarantined: false,
      },
    },
    state: "copying",
    sourceSettings: { name: "Work", color: "#ef4444", enabled: true },
    sourceIdentityStamp: "c".repeat(64),
    identityChanged: false,
    destinationSettings: null,
    baseline: null,
  };
}

function withAttempt(
  overrides: Partial<NonNullable<ProfileSyncItem["outcome"]>["attempt"]>,
): ProfileSyncItem {
  const base = item();
  if (base.outcome === null) throw new Error("fixture has an outcome");
  return {
    ...base,
    outcome: {
      ...base.outcome,
      attempt: { ...base.outcome.attempt, ...overrides },
    },
  };
}

function batch(
  sourceHostId: string,
  items: ProfileSyncItem[],
): ProfileSyncBatch {
  return {
    batchId: uuid(1),
    sourceHostId,
    createdAt: 1,
    automatic: false,
    items,
  };
}

function rule(n: number): ProfileSyncRule {
  return {
    ruleId: uuid(n),
    sourceHostId: SOURCE_HOST,
    destinationHostId: `dest-${String(n)}`,
    scope: { kind: "all" },
    paused: false,
    revision: 1,
    lastCheckedAt: null,
    batchId: null,
    status: "waiting",
  };
}

describe("profile sync item consistency", () => {
  it("accepts an item whose preview and outcome describe the same transfer", () => {
    expect(profileSyncItemSchema.safeParse(item()).success).toBe(true);
  });

  it.each([
    ["provider", { providerId: "codex" as const }],
    [
      "source profile",
      { sourceProfileId: "00000000-0000-4000-8000-0000000000aa" },
    ],
    ["destination host", { destinationHostId: "another-dest" }],
    ["operation", { operationId: "00000000-0000-4000-8000-0000000000bb" }],
  ])("rejects a nested outcome with a different %s", (_label, override) => {
    expect(profileSyncItemSchema.safeParse(withAttempt(override)).success).toBe(
      false,
    );
  });
});

describe("profile sync source consistency", () => {
  it("accepts a batch whose items belong to its source host", () => {
    expect(
      profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, [item()])).success,
    ).toBe(true);
  });

  it("rejects a batch naming a different source host than its items", () => {
    expect(
      profileSyncBatchSchema.safeParse(batch("other-host", [item()])).success,
    ).toBe(false);
  });

  it("accepts a preview whose selection source matches its items and rejects one that does not", () => {
    const selection = (sourceHostId: string) => ({
      sourceHostId,
      scope: { kind: "all" as const },
      destinationHostIds: [DEST_HOST],
    });
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: selection(SOURCE_HOST),
        revision: REVISION,
        items: [item()],
      }).success,
    ).toBe(true);
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: selection("other-host"),
        revision: REVISION,
        items: [item()],
      }).success,
    ).toBe(false);
  });
});

describe("profile sync list bounds", () => {
  const batches = (count: number): ProfileSyncBatch[] =>
    Array.from({ length: count }, (_unused, index) => ({
      ...batch(SOURCE_HOST, []),
      batchId: uuid(index + 1),
    }));
  const rules = (count: number): ProfileSyncRule[] =>
    Array.from({ length: count }, (_unused, index) => rule(index + 1));

  it("pins the history limits the host document already enforces", () => {
    expect(PROFILE_SYNC_MAX_BATCHES).toBe(100);
    expect(PROFILE_SYNC_MAX_RULES).toBe(64);
  });

  it("accepts exactly the maximum number of batches and rules", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: batches(PROFILE_SYNC_MAX_BATCHES),
        rules: rules(PROFILE_SYNC_MAX_RULES),
      }).success,
    ).toBe(true);
  });

  it("rejects one batch or one rule over the maximum", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: batches(PROFILE_SYNC_MAX_BATCHES + 1),
        rules: [],
      }).success,
    ).toBe(false);
    expect(
      profileSyncListSchema.safeParse({
        batches: [],
        rules: rules(PROFILE_SYNC_MAX_RULES + 1),
      }).success,
    ).toBe(false);
  });
});

describe("profile sync operation uniqueness and self-targeted rules", () => {
  const ALT_OPERATION = "00000000-0000-4000-8000-0000000000cc";

  function distinctItem(): ProfileSyncItem {
    const base = withAttempt({ operationId: ALT_OPERATION });
    return { ...base, operationId: ALT_OPERATION };
  }

  it("accepts a batch and a preview whose items carry distinct operation ids", () => {
    expect(
      profileSyncBatchSchema.safeParse(
        batch(SOURCE_HOST, [item(), distinctItem()]),
      ).success,
    ).toBe(true);
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: {
          sourceHostId: SOURCE_HOST,
          scope: { kind: "all" },
          destinationHostIds: [DEST_HOST],
        },
        revision: REVISION,
        items: [item(), distinctItem()],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate operation ids inside a batch and inside a preview", () => {
    expect(
      profileSyncBatchSchema.safeParse(batch(SOURCE_HOST, [item(), item()]))
        .success,
    ).toBe(false);
    expect(
      profileSyncPreviewSchema.safeParse({
        selection: {
          sourceHostId: SOURCE_HOST,
          scope: { kind: "all" },
          destinationHostIds: [DEST_HOST],
        },
        revision: REVISION,
        items: [item(), item()],
      }).success,
    ).toBe(false);
  });

  it("rejects a rule that targets its own source, alone and inside a list", () => {
    const selfTargeted: ProfileSyncRule = {
      ...rule(1),
      destinationHostId: SOURCE_HOST,
    };
    expect(profileSyncRuleSchema.safeParse(rule(1)).success).toBe(true);
    expect(profileSyncRuleSchema.safeParse(selfTargeted).success).toBe(false);
    expect(
      profileSyncListSchema.safeParse({ batches: [], rules: [selfTargeted] })
        .success,
    ).toBe(false);
  });
});

describe("profile sync list identity and conflict contract", () => {
  const twin = (): ProfileSyncBatch => batch(SOURCE_HOST, []);

  it("rejects two batches sharing a batchId and two rules sharing a ruleId", () => {
    expect(
      profileSyncListSchema.safeParse({ batches: [twin(), twin()], rules: [] })
        .success,
    ).toBe(false);
    expect(
      profileSyncListSchema.safeParse({
        batches: [],
        rules: [rule(1), { ...rule(2), ruleId: rule(1).ruleId }],
      }).success,
    ).toBe(false);
  });

  it("accepts distinct batch and rule ids", () => {
    expect(
      profileSyncListSchema.safeParse({
        batches: [twin(), { ...twin(), batchId: uuid(2) }],
        rules: [rule(1), rule(2)],
      }).success,
    ).toBe(true);
  });

  it("requires destination settings on a conflict item", () => {
    const conflict = { ...item(), state: "conflict" as const };
    expect(
      profileSyncItemSchema.safeParse({
        ...conflict,
        destinationSettings: null,
      }).success,
    ).toBe(false);
    expect(
      profileSyncItemSchema.safeParse({
        ...conflict,
        destinationSettings: { name: "Other", color: "#10b981", enabled: true },
      }).success,
    ).toBe(true);
  });
});
