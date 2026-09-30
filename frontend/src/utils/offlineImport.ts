import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { Inspection, InspectionConclusion, OccupiedLevel } from '../types/inspection';
import { OCCUPIED_LEVELS } from '../types/inspection';
import { judgeInspection, judgeSegment } from './routeCheck';
import { addDays, makeId } from './format';

/** 离线核验包中的单条核验记录（点位编号可能写错、值可能越界） */
export interface OfflineInspectionRecord {
  /** 内部点位 id，与 pointCode 二选一 */
  pointId?: string;
  /** 点位编号（业务编号），与 pointId 二选一 */
  pointCode?: string;
  /** 核验日期 YYYY-MM-DD */
  date: string;
  /** 采集时间 ISO 时间戳，缺省取核验日期 12:00 */
  collectedAt?: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  problem?: string;
  /** 结论可缺省，缺省按实测值重判 */
  conclusion?: InspectionConclusion;
}

/** 离线核验包：支持 { packageId, exportedAt, inspections } 或纯数组 */
export interface OfflinePackage {
  packageId?: string;
  exportedAt?: string;
  inspections: OfflineInspectionRecord[];
}

export interface FailedRecord {
  index: number;
  pointCode: string;
  reason: string;
}

export interface ImportResult {
  packageId: string;
  total: number;
  imported: number;
  failed: number;
  /** 被晚采集覆盖的旧记录数 */
  superseded: number;
  /** 因手工更正而保留的记录数 */
  protectedManual: number;
  failedRecords: FailedRecord[];
  /** 是否从检查点恢复 */
  resumed: boolean;
}

interface Checkpoint {
  packageId: string;
  fileName: string;
  total: number;
  processed: number;
  successCount: number;
  failCount: number;
  superseded: number;
  protectedManual: number;
  failedRecords: FailedRecord[];
  startedAt: string;
  updatedAt: string;
  status: 'in_progress' | 'completed';
}

const CHECKPOINT_KEY = 'gbaccessmap-import-checkpoint';

/** 简单字符串哈希（djb2），用于生成确定性 id 与包 id */
export function hashCode(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function loadCheckpoint(packageId: string): Checkpoint | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const cp = JSON.parse(raw) as Checkpoint;
    if (cp.packageId !== packageId) return null;
    return cp;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(cp));
  } catch {
    // localStorage 写满或不可用时忽略，不影响导入主流程
  }
}

export function clearCheckpoint(): void {
  try {
    localStorage.removeItem(CHECKPOINT_KEY);
  } catch {
    // ignore
  }
}

/** 解析离线包：兼容纯数组与带元数据的对象 */
export function parsePackage(raw: unknown): OfflinePackage {
  if (Array.isArray(raw)) {
    return { inspections: raw as OfflineInspectionRecord[] };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.inspections)) {
      return {
        packageId: obj.packageId as string | undefined,
        exportedAt: obj.exportedAt as string | undefined,
        inspections: obj.inspections as OfflineInspectionRecord[],
      };
    }
  }
  throw new Error('无法识别的离线核验包格式：应为核验记录数组或含 inspections 字段的对象');
}

/** 校验单条记录，返回解析后的点位或错误原因 */
function validateRecord(
  rec: OfflineInspectionRecord,
  pointMap: Map<string, AccessPoint>,
  codeMap: Map<string, AccessPoint>,
): { point?: AccessPoint; error?: string } {
  let point: AccessPoint | undefined;
  if (rec.pointId) point = pointMap.get(rec.pointId);
  if (!point && rec.pointCode) point = codeMap.get(rec.pointCode);
  if (!point) {
    return { error: `点位编号 ${rec.pointCode || rec.pointId || '(空)'} 在点位库中不存在` };
  }

  if (!rec.date || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) {
    return { error: '核验日期格式错误，应为 YYYY-MM-DD' };
  }
  const d = new Date(`${rec.date}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return { error: '核验日期无效' };
  }

  const slope = Number(rec.slope);
  if (Number.isNaN(slope) || slope < 0 || slope > 100) {
    return { error: `坡度值 ${rec.slope} 越界（有效范围 0~100%）` };
  }

  const clearWidth = Number(rec.clearWidth);
  if (Number.isNaN(clearWidth) || clearWidth < 0 || clearWidth > 500) {
    return { error: `净宽值 ${rec.clearWidth} 越界（有效范围 0~500cm）` };
  }

  if (typeof rec.hasHandrail !== 'boolean') {
    return { error: '扶手字段应为布尔值' };
  }
  if (typeof rec.tactileContinuous !== 'boolean') {
    return { error: '盲道连续性字段应为布尔值' };
  }

  if (!OCCUPIED_LEVELS.includes(rec.occupied)) {
    return { error: `被占用情况 ${String(rec.occupied)} 无效，应为 ${OCCUPIED_LEVELS.join('/')}` };
  }

  if (!rec.inspector || !String(rec.inspector).trim()) {
    return { error: '核验人为空' };
  }

  return { point };
}

/** 取某点位当前最新（未被覆盖）核验记录 */
export async function getCurrentInspection(pointId: string): Promise<Inspection | undefined> {
  const all = await db.inspections.where('pointId').equals(pointId).toArray();
  const active = all.filter((i) => !i.superseded);
  if (!active.length) return undefined;
  active.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.collectedAt < b.collectedAt ? 1 : a.collectedAt > b.collectedAt ? -1 : 0;
  });
  return active[0];
}

function pointName(points: Map<string, AccessPoint>, pointId: string): string {
  return points.get(pointId)?.name ?? pointId;
}

/**
 * 合并一条离线核验记录：
 * - 同点位同一天，采集时间晚的覆盖旧结果
 * - 已被手工更正（source=manual 或 manualEdited=true）的记录不回退
 * - 旧记录保留（标记 superseded）
 */
async function mergeInspection(
  rec: OfflineInspectionRecord,
  point: AccessPoint,
): Promise<{ imported: boolean; superseded: boolean; protectedManual: boolean }> {
  const now = new Date().toISOString();
  const collectedAt = rec.collectedAt || `${rec.date}T12:00:00.000Z`;
  const judgement = judgeInspection({
    slope: rec.slope,
    clearWidth: rec.clearWidth,
    hasHandrail: rec.hasHandrail,
    tactileContinuous: rec.tactileContinuous,
    occupied: rec.occupied,
  });
  const conclusion: InspectionConclusion =
    rec.conclusion && ['合格', '限期整改', '不合格'].includes(rec.conclusion)
      ? rec.conclusion
      : judgement.conclusion;

  // 确定性 id：同点位+同日期+同采集时间+同核验人 总是得到同一 id，避免重复导入
  const id = `ins-offline-${hashCode(`${point.id}|${rec.date}|${collectedAt}|${rec.inspector}`)}`;

  const newInspection: Inspection = {
    id,
    pointId: point.id,
    date: rec.date,
    collectedAt,
    inspector: String(rec.inspector).trim(),
    slope: rec.slope,
    clearWidth: rec.clearWidth,
    hasHandrail: rec.hasHandrail,
    tactileContinuous: rec.tactileContinuous,
    occupied: rec.occupied,
    conclusion,
    problem: String(rec.problem || '').trim(),
    source: 'offline',
    superseded: false,
    manualEdited: false,
    createdAt: now,
  };

  // 找同点位同一天的当前记录（排除自身，避免重复导入时把自己标记为覆盖）
  const existing = await db.inspections
    .where('pointId')
    .equals(point.id)
    .filter((i) => i.date === rec.date && !i.superseded && i.id !== id)
    .toArray();

  let superseded = false;
  let protectedManual = false;

  for (const e of existing) {
    if (e.source === 'manual' || e.manualEdited) {
      // 手工更正优先：保留手工记录，新记录标记为历史
      newInspection.superseded = true;
      protectedManual = true;
    } else if (e.collectedAt < collectedAt) {
      // 晚采集覆盖：旧记录标记 superseded
      await db.inspections.update(e.id, { superseded: true });
      superseded = true;
    } else {
      // 新记录更早，标记为历史
      newInspection.superseded = true;
    }
  }

  await db.inspections.put(newInspection);
  return { imported: true, superseded, protectedManual };
}

/**
 * 核验记录变更后，失效并重算该点位的整改条目与通行路线。
 * - 整改条目：未完成的标记 invalidated，按最新核验结论重算（不合格则补建）
 * - 通行路线：途经该点位的路段标记 invalidated，重算可通行判定
 * - 旧记录保留
 */
export async function invalidateAndRecalculate(pointId: string): Promise<void> {
  const now = new Date().toISOString();
  const points = await db.points.toArray();
  const pointMap = new Map(points.map((p) => [p.id, p]));
  const current = await getCurrentInspection(pointId);
  const reasonDate = current?.date || '';

  // 1. 整改条目
  const rectifies = await db.rectifies.where('pointId').equals(pointId).toArray();
  for (const r of rectifies) {
    if (r.status === '已整改') continue; // 已完成的保留历史，不失效
    await db.rectifies.update(r.id, {
      invalidated: true,
      invalidReason: `核验记录已更新（${reasonDate} 采集），整改要求需重新核定`,
    });
  }

  // 重算：最新结论不合格且无有效待整改条目时补建
  if (current?.conclusion === '不合格') {
    const hasActive = rectifies.some((r) => r.status !== '已整改' && !r.invalidated);
    if (!hasActive) {
      await db.rectifies.add({
        id: makeId('rct'),
        pointId,
        requirement: `按 ${current.date} 核验结论整改：${current.problem || '坡度、净宽或占用问题'}`,
        unit: '待指派责任单位',
        deadline: addDays(current.date, 30),
        recheckDate: '',
        status: '待整改',
        invalidated: false,
        invalidReason: '',
        createdAt: now,
      });
    }
  }

  // 2. 通行路线（途经该点位的路段）
  const routes = await db.routes
    .filter((r) => r.fromPointId === pointId || r.toPointId === pointId)
    .toArray();
  for (const seg of routes) {
    const segJudge = judgeSegment(seg);
    let passable = segJudge.passable;
    const endpointReasons: string[] = [];

    const fromInsp = await getCurrentInspection(seg.fromPointId);
    const toInsp = await getCurrentInspection(seg.toPointId);
    if (fromInsp?.conclusion === '不合格') {
      passable = false;
      endpointReasons.push(`起点 ${pointName(pointMap, seg.fromPointId)} 最新核验不合格`);
    }
    if (toInsp?.conclusion === '不合格') {
      passable = false;
      endpointReasons.push(`终点 ${pointName(pointMap, seg.toPointId)} 最新核验不合格`);
    }

    await db.routes.update(seg.id, {
      invalidated: true,
      invalidReason: `途经点位 ${pointName(pointMap, pointId)} 的核验记录已更新，通行判定需重新核验`,
      wheelchairPassable: passable,
    });
  }
}

/**
 * 导入离线核验包（支持检查点恢复）。
 * 坏记录不挡住其他记录；导入失败后从检查点恢复。
 */
export async function importOfflinePackage(
  raw: unknown,
  fileName: string,
  onProgress?: (processed: number, total: number) => void,
): Promise<ImportResult> {
  const pkg = parsePackage(raw);
  const records = pkg.inspections;
  const packageId =
    pkg.packageId || `pkg-${hashCode(`${fileName}|${pkg.exportedAt || ''}|${records.length}`)}`;

  const points = await db.points.toArray();
  const pointMap = new Map(points.map((p) => [p.id, p]));
  const codeMap = new Map(points.map((p) => [p.code, p]));

  const existing = loadCheckpoint(packageId);
  const resumed = Boolean(existing && existing.status === 'in_progress' && existing.total === records.length);
  let cp: Checkpoint = resumed
    ? { ...existing! }
    : {
        packageId,
        fileName,
        total: records.length,
        processed: 0,
        successCount: 0,
        failCount: 0,
        superseded: 0,
        protectedManual: 0,
        failedRecords: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'in_progress',
      };

  for (let i = cp.processed; i < records.length; i += 1) {
    const rec = records[i];
    const validation = validateRecord(rec, pointMap, codeMap);

    if (validation.error || !validation.point) {
      cp.failedRecords.push({
        index: i,
        pointCode: String(rec.pointCode || rec.pointId || '(空)'),
        reason: validation.error || '未知错误',
      });
      cp.failCount += 1;
    } else {
      try {
        await db.transaction('rw', db.inspections, db.rectifies, db.routes, db.points, async () => {
          const mergeResult = await mergeInspection(rec, validation.point!);
          if (mergeResult.imported) cp.successCount += 1;
          if (mergeResult.superseded) cp.superseded += 1;
          if (mergeResult.protectedManual) cp.protectedManual += 1;
          await invalidateAndRecalculate(validation.point!.id);
        });
      } catch (e) {
        // 单条记录处理失败：记录原因，不挡住其他记录
        cp.failedRecords.push({
          index: i,
          pointCode: String(rec.pointCode || rec.pointId || '(空)'),
          reason: `写入失败：${e instanceof Error ? e.message : String(e)}`,
        });
        cp.failCount += 1;
      }
    }

    cp.processed = i + 1;
    cp.updatedAt = new Date().toISOString();
    saveCheckpoint(cp);
    onProgress?.(cp.processed, records.length);
  }

  cp.status = 'completed';
  cp.updatedAt = new Date().toISOString();
  saveCheckpoint(cp);

  return {
    packageId,
    total: records.length,
    imported: cp.successCount,
    failed: cp.failCount,
    superseded: cp.superseded,
    protectedManual: cp.protectedManual,
    failedRecords: cp.failedRecords,
    resumed,
  };
}

/** 生成一份示例离线核验包 JSON（供下载测试） */
export function buildSamplePackage(): OfflinePackage {
  return {
    packageId: 'pkg-sample-001',
    exportedAt: new Date().toISOString(),
    inspections: [
      {
        pointCode: 'WZ-2024-001',
        date: '2025-06-01',
        collectedAt: '2025-06-01T09:30:00.000Z',
        inspector: '督导员 离线包',
        slope: 3.5,
        clearWidth: 145,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        problem: '',
      },
      {
        // 坏记录：点位编号写错
        pointCode: 'WZ-2024-999',
        date: '2025-06-01',
        inspector: '督导员 离线包',
        slope: 3.5,
        clearWidth: 145,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
      },
      {
        // 坏记录：坡度越界
        pointCode: 'WZ-2024-002',
        date: '2025-06-01',
        inspector: '督导员 离线包',
        slope: 150,
        clearWidth: 130,
        hasHandrail: false,
        tactileContinuous: false,
        occupied: '无',
      },
      {
        pointCode: 'WZ-2024-002',
        date: '2025-06-01',
        collectedAt: '2025-06-01T14:00:00.000Z',
        inspector: '督导员 离线包',
        slope: 2.0,
        clearWidth: 132,
        hasHandrail: false,
        tactileContinuous: false,
        occupied: '无',
        problem: '盲道路口断开，需补齐',
      },
    ],
  };
}
