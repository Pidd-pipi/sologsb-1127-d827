import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import { makeId, toPlain } from '../utils/format';
import { invalidateAndRecalculate } from '../utils/offlineImport';

interface PointState {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  addInspection: (draft: InspectionDraft) => Promise<Inspection>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  getPoint: (id: string) => AccessPoint | undefined;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
}

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  inspections: [],
  rectifies: [],
  loading: false,
  loaded: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [points, inspections, rectifies] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
      ]);
      set({
        points: points.sort((a, b) => a.code.localeCompare(b.code)),
        inspections: inspections.sort((a, b) => (a.date < b.date ? 1 : -1)),
        rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  addPoint: async (draft) => {
    const now = new Date().toISOString();
    const point: AccessPoint = toPlain({
      ...draft,
      id: makeId('pt'),
      createdAt: now,
      updatedAt: now,
    });
    await db.points.put(point);
    set((s) => ({ points: [...s.points, point].sort((a, b) => a.code.localeCompare(b.code)) }));
    return point;
  },

  addInspection: async (draft) => {
    const now = new Date().toISOString();
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      collectedAt: draft.collectedAt || now,
      source: draft.source || 'manual',
      superseded: false,
      manualEdited: false,
      createdAt: now,
    });
    await db.inspections.put(inspection);
    // 同点位同一天的旧记录（非自身）标记为已覆盖
    const sameDay = await db.inspections
      .where('pointId')
      .equals(inspection.pointId)
      .filter((i) => i.date === inspection.date && !i.superseded && i.id !== inspection.id)
      .toArray();
    for (const old of sameDay) {
      await db.inspections.update(old.id, { superseded: true });
    }
    set((s) => ({
      inspections: [inspection, ...s.inspections]
        .map((i) => (sameDay.some((o) => o.id === i.id) ? { ...i, superseded: true } : i))
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    }));
    // 核验记录变更：失效并重算该点位的整改条目与通行路线（含不合格补建整改条目）
    await invalidateAndRecalculate(inspection.pointId);
    // 失效重算后刷新内存中的整改条目
    const rectifies = await db.rectifies.toArray();
    set({ rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)) });
    return inspection;
  },

  addRectify: async (draft) => {
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      invalidated: false,
      invalidReason: '',
      createdAt: new Date().toISOString(),
    });
    await db.rectifies.put(plan);
    set((s) => ({
      rectifies: [...s.rectifies, plan].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    }));
    return plan;
  },

  updateRectify: async (id, patch) => {
    const plain = toPlain(patch);
    await db.rectifies.update(id, plain);
    set((s) => ({
      rectifies: s.rectifies.map((r) => (r.id === id ? { ...r, ...plain } : r)),
    }));
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  inspectionsOf: (pointId) =>
    get()
      .inspections.filter((i) => i.pointId === pointId)
      .sort((a, b) => (a.date < b.date ? 1 : -1)),

  rectifiesOf: (pointId) =>
    get()
      .rectifies.filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
}));
