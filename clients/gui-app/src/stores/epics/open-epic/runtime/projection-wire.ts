import type { EpicRuntimeProjection } from "./epic-runtime-projection";
import { spliceIdSlice } from "./epic-projector";
import {
  chatProjectionsEq,
  terminalAgentProjectionsEq,
} from "../projection-helpers";

const KEYED_SLICES = [
  "artifacts",
  "deletedArtifacts",
  "docChats",
  "chats",
  "chatRecords",
  "docTuiAgents",
  "tuiAgents",
  "tuiAgentRecords",
  "agentRoles",
  "tree",
  "commentThreads",
  "artifactRooms",
] as const satisfies readonly (keyof EpicRuntimeProjection)[];

type SliceKey = (typeof KEYED_SLICES)[number];
export interface TableDelta {
  readonly upserts: Readonly<Record<string, unknown>>;
  readonly removed: readonly string[];
}
export interface SliceDelta {
  readonly key: SliceKey;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly tables: Readonly<Record<string, TableDelta>>;
}
export type EpicProjectionPatch = Partial<EpicRuntimeProjection> & {
  readonly sliceDeltas?: readonly SliceDelta[];
  readonly sliceAliases?: readonly (readonly string[])[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffTable(
  before: Readonly<Record<string, unknown>>,
  value: Readonly<Record<string, unknown>>,
): TableDelta | null {
  const upserts: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const id of Object.keys(value)) {
    if (value[id] !== before[id] || !Object.hasOwn(before, id)) {
      upserts[id] = value[id];
    }
  }
  for (const id of Object.keys(before)) {
    if (!Object.hasOwn(value, id)) removed.push(id);
  }
  return Object.keys(upserts).length > 0 || removed.length > 0
    ? { upserts, removed }
    : null;
}

type MutableProjectionPatch = {
  -readonly [Key in keyof EpicRuntimeProjection]?: EpicRuntimeProjection[Key];
};

function stabilizeRecordSlices(
  next: MutableProjectionPatch,
  previous: Partial<EpicRuntimeProjection>,
): void {
  // Raw record tables rebuild rows on publication; the composed populations
  // already have this identity discipline from the projector.
  if (next.chatRecords !== undefined && previous.chatRecords !== undefined) {
    next.chatRecords = spliceIdSlice(
      next.chatRecords,
      previous.chatRecords,
      chatProjectionsEq,
    );
  }
  if (
    next.tuiAgentRecords !== undefined &&
    previous.tuiAgentRecords !== undefined
  ) {
    next.tuiAgentRecords = spliceIdSlice(
      next.tuiAgentRecords,
      previous.tuiAgentRecords,
      terminalAgentProjectionsEq,
    );
  }
}

/** Per worker lifetime; references are compared before structured clone erases them. */
export function createProjectionEncoder(): (
  patch: Partial<EpicRuntimeProjection>,
) => EpicProjectionPatch {
  const previous: Partial<EpicRuntimeProjection> = {};
  return (patch) => {
    const next: Partial<EpicRuntimeProjection> = { ...patch };
    stabilizeRecordSlices(next, previous);
    const sliceDeltas: SliceDelta[] = [];
    const aliases = new Map<object, string[]>();
    for (const key of Object.keys(patch)) {
      const value: unknown = Reflect.get(patch, key);
      if (typeof value !== "object" || value === null) continue;
      const group = aliases.get(value);
      if (group === undefined) aliases.set(value, [key]);
      else group.push(key);
    }
    for (const key of KEYED_SLICES) {
      const incoming = next[key];
      if (incoming === undefined) continue;
      const held = previous[key];
      Reflect.set(previous, key, incoming);
      if (held === undefined) continue;
      const fields: Record<string, unknown> = {};
      const tables: Record<string, TableDelta> = {};
      for (const field of Object.keys(incoming)) {
        const value: unknown = Reflect.get(incoming, field);
        const before: unknown = Reflect.get(held, field);
        if (value === before) continue;
        if (!isRecord(value) || !isRecord(before)) {
          fields[field] = value;
          continue;
        }
        const delta = diffTable(before, value);
        if (delta !== null) tables[field] = delta;
      }
      sliceDeltas.push({ key, fields, tables });
      delete next[key];
    }
    return {
      ...next,
      sliceDeltas,
      sliceAliases: [...aliases.values()].filter((group) => group.length > 1),
    };
  };
}
