import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type {
  Inspection,
  InspectionCorrection,
  ManualField,
} from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import { makeId, addDays, toPlain } from '../utils/format';
import { judgeInspection } from '../utils/routeCheck';

/** 变更来源说明，写入失效原因 */
export type ChangeCause = 'offline-merge' | 'manual-entry' | 'manual-correction';

const CAUSE_TEXT: Record<ChangeCause, string> = {
  'offline-merge': '离线核验包合并',
  'manual-entry': '现场核验录入',
  'manual-correction': '核验记录手工更正',
};

export interface CascadeResult {
  /** 失效的自动整改条目 id */
  invalidatedRectifyIds: string[];
  /** 重算后新建的整改条目（无则 null） */
  createdRectify: RectifyPlan | null;
  /** 失效的路段 id */
  invalidatedRouteIds: string[];
  /** 该点位当前生效的最新核验是否发生变化 */
  latestChanged: boolean;
}

/** 当前生效的最新核验：先按核验日期、再按采集时间，取最晚的一条（已覆盖记录不参与） */
export function latestActiveOf(list: Inspection[]): Inspection | undefined {
  return list
    .filter((i) => !i.superseded)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const ta = Date.parse(a.collectedAt);
      const tb = Date.parse(b.collectedAt);
      if (ta !== tb) return ta < tb ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    })[0];
}

function shortTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

function rectifyReason(cause: ChangeCause, before: Inspection | undefined, after: Inspection): string {
  return `${CAUSE_TEXT[cause]}：${after.date} 核验结论由「${before?.conclusion ?? '未核验'}」变为「${after.conclusion}」，原整改条目失效并已按最新结论重算`;
}

function routeReason(cause: ChangeCause, point: AccessPoint | undefined, insp: Inspection): string {
  const where = point ? `${point.code} ${point.name}` : insp.pointId;
  return `${CAUSE_TEXT[cause]}：关联点位 ${where} 的核验记录发生变化（${insp.date} 结论「${insp.conclusion}」），原路段判定失效，需按最新核验重算`;
}

/** 结论不是合格时，按最新核验重建一条自动整改条目 */
function buildAutoRectify(latest: Inspection): RectifyPlan {
  const judged = judgeInspection({
    slope: latest.slope,
    clearWidth: latest.clearWidth,
    hasHandrail: latest.hasHandrail,
    tactileContinuous: latest.tactileContinuous,
    occupied: latest.occupied,
  });
  const detail = latest.problem || judged.reasons.join('；') || '坡度、净宽或占用问题';
  return {
    id: makeId('rct'),
    pointId: latest.pointId,
    requirement: `按 ${latest.date} 核验结论整改：${detail}`,
    unit: '待指派责任单位',
    deadline: addDays(latest.date, 30),
    recheckDate: '',
    status: '待整改',
    source: 'auto',
    invalid: false,
    invalidReason: null,
    fromInspectionId: latest.id,
    createdAt: new Date().toISOString(),
  };
}

/** 最新生效核验的判定相关字段是否发生实质变化（决定整改/路线是否需要失效重算） */
function latestMaterialChanged(before: Inspection | undefined, after: Inspection | undefined): boolean {
  if (!after) return false;
  if (!before) return true;
  if (before.id !== after.id) return true;
  return (
    before.conclusion !== after.conclusion ||
    before.slope !== after.slope ||
    before.clearWidth !== after.clearWidth ||
    before.hasHandrail !== after.hasHandrail ||
    before.tactileContinuous !== after.tactileContinuous ||
    before.occupied !== after.occupied
  );
}

/**
 * 核验变化后的联动重算（须在已包含 inspection 写入的 rw 事务内调用）：
 * - 最新生效核验变化时，未关闭的自动整改条目失效并按新结论重建；手工条目不动；
 * - 关联点位的通行路段全部失效并记录原因，旧记录保留。
 */
export async function cascadeInspectionChange(
  tables: {
    inspections: typeof db.inspections;
    rectifies: typeof db.rectifies;
    routes: typeof db.routes;
  },
  point: AccessPoint | undefined,
  before: Inspection | undefined,
  after: Inspection | undefined,
  cause: ChangeCause,
): Promise<CascadeResult> {
  const latestChanged = latestMaterialChanged(before, after);
  const result: CascadeResult = {
    invalidatedRectifyIds: [],
    createdRectify: null,
    invalidatedRouteIds: [],
    latestChanged,
  };
  if (!after || !latestChanged) return result;

  const nowIso = new Date().toISOString();

  // 整改条目：仅联动自动条目；已关闭（已整改）条目作为历史保留，不失效
  {
    const plans = await tables.rectifies.where('pointId').equals(after.pointId).toArray();
    for (const plan of plans) {
      if (plan.source !== 'auto' || plan.invalid || plan.status === '已整改') continue;
      plan.invalid = true;
      plan.invalidReason = {
        at: nowIso,
        inspectionId: after.id,
        reason: rectifyReason(cause, before, after),
      };
      await tables.rectifies.put(toPlain(plan));
      result.invalidatedRectifyIds.push(plan.id);
    }
    const hasOpenAuto = plans.some(
      (p) =>
        p.source === 'auto' &&
        !p.invalid &&
        p.status !== '已整改' &&
        !result.invalidatedRectifyIds.includes(p.id),
    );
    if (after.conclusion !== '合格' && !hasOpenAuto) {
      const plan = buildAutoRectify(after);
      await tables.rectifies.put(plan);
      result.createdRectify = plan;
    }
  }

  // 通行路线：关联点位的路段失效重算
  const [fromSegs, toSegs] = await Promise.all([
    tables.routes.where('fromPointId').equals(after.pointId).toArray(),
    tables.routes.where('toPointId').equals(after.pointId).toArray(),
  ]);
  const segIds = new Set([...fromSegs, ...toSegs].filter((s) => !s.invalid).map((s) => s.id));
  for (const seg of [...fromSegs, ...toSegs]) {
    if (!segIds.has(seg.id) || seg.invalid) continue;
    seg.invalid = true;
    seg.invalidReason = {
      at: nowIso,
      inspectionId: after.id,
      reason: routeReason(cause, point, after),
    };
    await tables.routes.put(toPlain(seg));
    result.invalidatedRouteIds.push(seg.id);
    segIds.delete(seg.id);
  }

  return result;
}

/**
 * 落库一条新核验并执行联动：
 * - 同点位同日、采集时间更早的未覆盖旧核验标记为被新记录覆盖（旧记录保留）；
 * - 最新生效核验变化时，自动整改条目失效重算（手工条目不碰），关联路段失效并记录原因。
 */
export async function insertInspectionWithCascade(
  inspection: Inspection,
  point: AccessPoint | undefined,
  cause: ChangeCause,
): Promise<CascadeResult> {
  return db.transaction('rw', db.points, db.inspections, db.rectifies, db.routes, async () => {
    const pointRows = await db.inspections.where('pointId').equals(inspection.pointId).toArray();
    const before = latestActiveOf(pointRows);
    const supersedeIds = pointRows
      .filter(
        (old) =>
          !old.superseded &&
          old.pointId === inspection.pointId &&
          old.date === inspection.date &&
          Date.parse(inspection.collectedAt) > Date.parse(old.collectedAt),
      )
      .map((old) => old.id);
    await db.inspections.put(toPlain(inspection));
    for (const sid of supersedeIds) {
      await db.inspections.update(sid, { superseded: true, supersededById: inspection.id });
    }
    const after = latestActiveOf(
      await db.inspections.where('pointId').equals(inspection.pointId).toArray(),
    );
    return cascadeInspectionChange(
      { inspections: db.inspections, rectifies: db.rectifies, routes: db.routes },
      point,
      before,
      after,
      cause,
    );
  });
}

/**
 * 手工更正核验记录：更正字段加入保护名单（离线包不再回退），结论按更正后实测值重判，
 * 随后按「核验记录变化」执行整改/路线联动。
 */
export async function correctInspectionWithCascade(
  id: string,
  patch: InspectionCorrection,
  point: AccessPoint | undefined,
): Promise<{ inspection: Inspection; cascade: CascadeResult }> {
  return db.transaction('rw', db.points, db.inspections, db.rectifies, db.routes, async () => {
    const old = await db.inspections.get(id);
    if (!old) throw new Error('核验记录不存在或已被删除');
    const before = latestActiveOf(
      await db.inspections.where('pointId').equals(old.pointId).toArray(),
    );
    const manualFields = new Set<ManualField>(old.manualFields);
    for (const key of Object.keys(patch) as ManualField[]) {
      if (patch[key] !== undefined) manualFields.add(key);
    }
    const merged: Inspection = toPlain({ ...old, ...patch });
    merged.manualFields = [...manualFields];
    merged.manualAt = new Date().toISOString();
    const judged = judgeInspection({
      slope: merged.slope,
      clearWidth: merged.clearWidth,
      hasHandrail: merged.hasHandrail,
      tactileContinuous: merged.tactileContinuous,
      occupied: merged.occupied,
    });
    merged.conclusion = judged.conclusion;
    await db.inspections.put(merged);
    const after = latestActiveOf(
      await db.inspections.where('pointId').equals(old.pointId).toArray(),
    );
    const cascade = await cascadeInspectionChange(
      { inspections: db.inspections, rectifies: db.rectifies, routes: db.routes },
      point,
      before,
      after,
      'manual-correction',
    );
    return { inspection: merged, cascade };
  });
}

export { shortTime };
