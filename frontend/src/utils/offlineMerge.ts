import type {
  OfflineInspectionPackage,
  OfflineInspectionRecord,
  RejectedRecord,
} from '../types/offline';
import {
  CONCLUSIONS,
  MANUAL_FIELDS,
  OCCUPIED_LEVELS,
  type Inspection,
  type InspectionConclusion,
  type ManualField,
  type OccupiedLevel,
} from '../types/inspection';
import type { AccessPoint } from '../types/point';
import { judgeInspection } from './routeCheck';

/** 实测值合理范围，越界记为坏记录 */
export const SLOPE_RANGE: [number, number] = [0, 100];
export const CLEAR_WIDTH_RANGE: [number, number] = [0, 500];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 稳定字符串哈希（FNV-1a 32 位），用于生成批次号 / clientId */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00`));
}

/** 采集时间解析：ISO 字符串或毫秒时间戳；缺省时退化为核验日期 23:59:59 */
export function resolveCollectedAt(raw: unknown, date: string): string | null {
  if (raw === undefined || raw === null || raw === '') {
    const t = Date.parse(`${date}T23:59:59`);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? new Date(raw).toISOString() : null;
  }
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** 解析离线包外层结构；外层坏掉时整包无法恢复，由调用方提示 */
export function parsePackage(raw: string): OfflineInspectionPackage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(data) || !Array.isArray(data.records)) {
    throw new Error('包结构错误：缺少 records 数组');
  }
  return data as unknown as OfflineInspectionPackage;
}

/** 包批次号：优先取 batchId，否则按包内容稳定哈希 */
export function resolveBatchId(pkg: OfflineInspectionPackage): string {
  if (typeof pkg.batchId === 'string' && pkg.batchId.trim()) return pkg.batchId.trim();
  return `batch-${stableHash(JSON.stringify(pkg.records))}`;
}

/** 设备端去重键：优先 id / clientId，否则按记录内容生成 */
export function resolveClientId(rec: OfflineInspectionRecord): string {
  const explicit = rec.clientId ?? rec.id;
  if (explicit !== undefined && String(explicit).trim()) return String(explicit).trim();
  return `off-${stableHash(
    JSON.stringify([
      rec.code,
      rec.date,
      rec.collectedAt ?? '',
      rec.inspector ?? '',
      rec.slope,
      rec.clearWidth,
      rec.hasHandrail,
      rec.tactileContinuous,
      rec.occupied,
      rec.problem ?? '',
    ]),
  )}`;
}

/**
 * 校验单条记录。通过返回归一化记录；不通过返回错误原因。
 * 点位编号写错（在已知点位中找不到）与值越界都在这里拦截，坏记录只影响自身。
 */
export function validateRecord(
  raw: unknown,
  pointByCode: Map<string, AccessPoint>,
):
  | { ok: true; record: OfflineInspectionRecord; pointId: string }
  | { ok: false; reasons: string[]; code: string } {
  const reasons: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, reasons: ['不是有效的 JSON 对象'], code: '' };
  }
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  if (!code) reasons.push('缺少点位编号 code');
  const pointId = code ? pointByCode.get(code)?.id ?? '' : '';
  if (code && !pointId) reasons.push(`点位编号 ${code} 不存在`);

  const date = raw.date;
  if (!isValidDate(date)) reasons.push('核验日期 date 格式应为 YYYY-MM-DD');

  const slope = raw.slope;
  if (slope !== undefined && !isFiniteNumber(slope)) {
    reasons.push('坡度 slope 必须是数字');
  } else if (isFiniteNumber(slope) && (slope < SLOPE_RANGE[0] || slope > SLOPE_RANGE[1])) {
    reasons.push(`坡度 ${slope}% 越界（允许 ${SLOPE_RANGE[0]}~${SLOPE_RANGE[1]}%）`);
  }

  const clearWidth = raw.clearWidth;
  if (clearWidth !== undefined && !isFiniteNumber(clearWidth)) {
    reasons.push('净宽 clearWidth 必须是数字');
  } else if (
    isFiniteNumber(clearWidth) &&
    (clearWidth < CLEAR_WIDTH_RANGE[0] || clearWidth > CLEAR_WIDTH_RANGE[1])
  ) {
    reasons.push(`净宽 ${clearWidth}cm 越界（允许 ${CLEAR_WIDTH_RANGE[0]}~${CLEAR_WIDTH_RANGE[1]}cm）`);
  }

  if (raw.hasHandrail !== undefined && !isBool(raw.hasHandrail)) reasons.push('扶手 hasHandrail 必须是布尔值');
  if (raw.tactileContinuous !== undefined && !isBool(raw.tactileContinuous))
    reasons.push('盲道连续性 tactileContinuous 必须是布尔值');

  let occupied: OccupiedLevel = '无';
  if (raw.occupied === undefined || raw.occupied === '') {
    occupied = '无';
  } else if (typeof raw.occupied === 'string' && (OCCUPIED_LEVELS as readonly string[]).includes(raw.occupied)) {
    occupied = raw.occupied as OccupiedLevel;
  } else {
    reasons.push(`占用情况 occupied 非法（应为 ${OCCUPIED_LEVELS.join('/')}）`);
  }

  let conclusion: InspectionConclusion | undefined;
  if (raw.conclusion !== undefined && raw.conclusion !== '') {
    if (typeof raw.conclusion === 'string' && (CONCLUSIONS as string[]).includes(raw.conclusion)) {
      conclusion = raw.conclusion as InspectionConclusion;
    } else {
      reasons.push(`结论 conclusion 非法（应为 ${CONCLUSIONS.join('/')}）`);
    }
  }

  if (raw.inspector !== undefined && typeof raw.inspector !== 'string') reasons.push('核验人 inspector 必须是字符串');
  if (raw.problem !== undefined && typeof raw.problem !== 'string') reasons.push('问题描述 problem 必须是字符串');

  const collectedIssue =
    isValidDate(date) && resolveCollectedAt(raw.collectedAt, date) === null
      ? '采集时间 collectedAt 无法解析'
      : '';
  if (collectedIssue) reasons.push(collectedIssue);

  if (reasons.length) return { ok: false, reasons, code };

  const safeDate = date as string;
  const record: OfflineInspectionRecord = {
    code,
    date: safeDate,
    inspector: typeof raw.inspector === 'string' && raw.inspector.trim() ? raw.inspector.trim() : '',
    slope: isFiniteNumber(slope) ? slope : 0,
    clearWidth: isFiniteNumber(clearWidth) ? clearWidth : 0,
    hasHandrail: isBool(raw.hasHandrail) ? raw.hasHandrail : false,
    tactileContinuous: isBool(raw.tactileContinuous) ? raw.tactileContinuous : false,
    occupied,
    conclusion,
    problem: typeof raw.problem === 'string' ? raw.problem : '',
    collectedAt: resolveCollectedAt(raw.collectedAt, safeDate) as string,
    clientId:
      typeof raw.clientId === 'string'
        ? raw.clientId
        : typeof raw.id === 'string'
          ? raw.id
          : undefined,
  };
  return { ok: true, record, pointId };
}

/** 结论：包内显式结论优先，否则按实测值判定 */
export function resolveConclusion(rec: OfflineInspectionRecord): InspectionConclusion {
  if (rec.conclusion) return rec.conclusion;
  return judgeInspection({
    slope: rec.slope ?? 0,
    clearWidth: rec.clearWidth ?? 0,
    hasHandrail: rec.hasHandrail ?? false,
    tactileContinuous: rec.tactileContinuous ?? false,
    occupied: rec.occupied ?? '无',
  }).conclusion;
}

/** 两条同日核验比较采集时间，a 晚于 b 返回 true */
export function collectedLater(a: Pick<Inspection, 'collectedAt'>, b: Pick<Inspection, 'collectedAt'>): boolean {
  const ta = Date.parse(a.collectedAt);
  const tb = Date.parse(b.collectedAt);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}

/** 找出同点位同日、未被覆盖的旧核验（它们会被采集时间更晚的新核验覆盖） */
export function findSameDayTargets(
  list: Inspection[],
  pointId: string,
  date: string,
): Inspection[] {
  return list.filter((i) => i.pointId === pointId && i.date === date && !i.superseded);
}

/** 离线新值与旧记录合并：已手工更正的字段沿用旧值，不回退 */
export function mergeProtectedFields(
  old: Inspection,
  patch: Pick<
    Inspection,
    'slope' | 'clearWidth' | 'hasHandrail' | 'tactileContinuous' | 'occupied' | 'problem'
  >,
): {
  merged: typeof patch;
  protectedFields: ManualField[];
} {
  const merged = { ...patch };
  const protectedFields: ManualField[] = [];
  for (const f of MANUAL_FIELDS) {
    if (old.manualFields.includes(f)) {
      // 手工更正字段保留：新包不回退
      merged[f] = old[f] as never;
      protectedFields.push(f);
    }
  }
  return { merged, protectedFields };
}

/** 把坏记录列表格式化为可展示文本 */
export function formatRejected(rejected: RejectedRecord[]): string {
  return rejected
    .map((r) => `#${r.index + 1}${r.code ? `（${r.code}）` : ''}：${r.reasons.join('；')}`)
    .join('\n');
}
