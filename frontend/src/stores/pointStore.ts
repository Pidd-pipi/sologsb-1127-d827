import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionCorrection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import { makeId, toPlain } from '../utils/format';
import { correctInspectionWithCascade, insertInspectionWithCascade } from '../services/inspectionSync';

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
  correctInspection: (id: string, patch: InspectionCorrection) => Promise<Inspection>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  /** 联动写库后重新拉取核验与整改（失效、重算、覆盖结果回流） */
  refreshAfterCascade: () => Promise<void>;
  getPoint: (id: string) => AccessPoint | undefined;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
}

function sortInspections(list: Inspection[]): Inspection[] {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.collectedAt < b.collectedAt ? 1 : -1;
  });
}

function sortRectifies(list: RectifyPlan[]): RectifyPlan[] {
  return [...list].sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
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
        inspections: sortInspections(inspections),
        rectifies: sortRectifies(rectifies),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 联动写库后从本地库刷新核验与整改，保证失效/重算结果回流界面 */
  refreshAfterCascade: async () => {
    const [inspections, rectifies] = await Promise.all([
      db.inspections.toArray(),
      db.rectifies.toArray(),
    ]);
    set({ inspections: sortInspections(inspections), rectifies: sortRectifies(rectifies) });
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
    const point = await db.points.get(draft.pointId);
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      // 现场录入：采集时间取当前时刻；同日离线记录按此时刻决定覆盖关系
      collectedAt: now,
      source: 'manual',
      superseded: false,
      supersededById: '',
      manualFields: [],
      manualAt: '',
      clientId: `manual-${makeId('c')}`,
      createdAt: now,
    });
    await insertInspectionWithCascade(inspection, point, 'manual-entry');
    await get().refreshAfterCascade();
    return inspection;
  },

  correctInspection: async (id, patch) => {
    const current = get().inspections.find((i) => i.id === id);
    const point = current ? await db.points.get(current.pointId) : undefined;
    const { inspection } = await correctInspectionWithCascade(id, patch, point);
    await get().refreshAfterCascade();
    return inspection;
  },

  addRectify: async (draft) => {
    // 界面手工登记的整改条目不随核验自动失效
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      source: 'manual',
      invalid: false,
      invalidReason: null,
      fromInspectionId: '',
      createdAt: new Date().toISOString(),
    });
    await db.rectifies.put(plan);
    set((s) => ({ rectifies: sortRectifies([...s.rectifies, plan]) }));
    return plan;
  },

  updateRectify: async (id, patch) => {
    const plain = toPlain(patch);
    await db.rectifies.update(id, plain);
    set((s) => ({
      rectifies: sortRectifies(s.rectifies.map((r) => (r.id === id ? { ...r, ...plain } : r))),
    }));
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  inspectionsOf: (pointId) =>
    sortInspections(get().inspections.filter((i) => i.pointId === pointId)),

  rectifiesOf: (pointId) =>
    sortRectifies(get().rectifies.filter((r) => r.pointId === pointId)),
}));
