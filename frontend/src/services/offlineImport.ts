import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type {
  ImportCheckpoint,
  ImportedRecord,
  OfflineInspectionPackage,
  RejectedRecord,
} from '../types/offline';
import type { Inspection } from '../types/inspection';
import { makeId, toPlain } from '../utils/format';
import {
  collectedLater,
  findSameDayTargets,
  mergeProtectedFields,
  resolveBatchId,
  resolveClientId,
  resolveConclusion,
  validateRecord,
} from '../utils/offlineMerge';
import { cascadeInspectionChange, latestActiveOf } from './inspectionSync';
import { judgeInspection } from '../utils/routeCheck';

export interface ImportOutcome {
  checkpoint: ImportCheckpoint;
  resumed: boolean;
}

/** 读取某批次的检查点（用于导入失败后恢复） */
export async function getCheckpoint(batchId: string): Promise<ImportCheckpoint | undefined> {
  return db.importCheckpoints.get(batchId);
}

/** 列出检查点（管理页展示与恢复入口） */
export async function listCheckpoints(): Promise<ImportCheckpoint[]> {
  const rows = await db.importCheckpoints.toArray();
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 导入失败/中断后，从检查点恢复续传 */
export async function resumeFromCheckpoint(
  checkpoint: ImportCheckpoint,
  onProgress?: (cp: ImportCheckpoint) => void,
): Promise<ImportOutcome> {
  const pkg = checkpoint.rawPackage as OfflineInspectionPackage;
  if (!pkg || !Array.isArray(pkg.records)) {
    throw new Error('检查点中未保存源包内容，无法恢复，请重新选择文件导入');
  }
  return mergeOfflinePackage(pkg, checkpoint.fileName, onProgress);
}

/** 删除检查点（仅删断点记录，不回滚已入库核验） */
export async function deleteCheckpoint(batchId: string): Promise<void> {
  await db.importCheckpoints.delete(batchId);
}

function recordsOf(cp: ImportCheckpoint): unknown[] {
  const pkg = cp.rawPackage as OfflineInspectionPackage | null;
  return Array.isArray(pkg?.records) ? (pkg as OfflineInspectionPackage).records : [];
}

/**
 * 合并离线核验包：
 * - 坏记录（点位编号写错 / 值越界等）逐条隔离，不挡住其他记录；
 * - 每条记录处理完即更新检查点，中断或失败后可用同一批次检查点从断点继续；
 * - 同一设施同一天多份核验，采集时间晚的覆盖旧结果；
 * - 已手工更正的字段沿用旧值，不回退；
 * - 核验变化联动失效整改条目与通行路段（旧记录保留）。
 */
export async function mergeOfflinePackage(
  pkg: OfflineInspectionPackage,
  fileName: string,
  onProgress?: (cp: ImportCheckpoint) => void,
): Promise<ImportOutcome> {
  const batchId = resolveBatchId(pkg);
  const total = pkg.records.length;
  const existing = await db.importCheckpoints.get(batchId);
  const nowIso = () => new Date().toISOString();

  let cp: ImportCheckpoint =
    existing && Array.isArray((existing.rawPackage as OfflineInspectionPackage)?.records)
      ? existing
      : {
          batchId,
          fileName,
          total,
          lastIndex: -1,
          succeeded: 0,
          rejected: [],
          imported: [],
          status: 'running',
          startedAt: nowIso(),
          updatedAt: nowIso(),
          finishedAt: '',
          rawPackage: toPlain(pkg),
        };
  const wasDone = existing?.status === 'done';
  const resumed =
    existing?.status === 'running' && existing.lastIndex >= 0 && existing.lastIndex < total - 1;
  cp.fileName = fileName || cp.fileName;
  cp.status = 'running';

  const pointByCode = new Map<string, AccessPoint>();
  (await db.points.toArray()).forEach((p) => pointByCode.set(p.code, p));

  // 已完成批次再次导入：从第 0 条重放，全部走 clientId 幂等跳过，不产生重复数据；
  // 中断批次：从 lastIndex + 1 继续，之前的结果沿用检查点。
  const startIndex = wasDone ? 0 : cp.lastIndex + 1;
  if (wasDone) {
    cp.rejected = [];
    cp.imported = [];
    cp.succeeded = 0;
    cp.finishedAt = '';
    cp.lastIndex = -1;
  }

  const rawRecords = recordsOf(cp);
  for (let index = startIndex; index < total; index += 1) {
    const raw = rawRecords[index];
    // 每条记录一个事务：坏记录不影响其他记录，业务写入与检查点逐条原子提交
    // eslint-disable-next-line no-await-in-loop
    await db.transaction(
      'rw',
      db.points,
      db.inspections,
      db.rectifies,
      db.routes,
      db.importCheckpoints,
      async () => {
        const verdict = validateRecord(raw, pointByCode);
        if (!verdict.ok) {
          cp.rejected = [
            ...cp.rejected,
            {
              index,
              code: verdict.code,
              reasons: verdict.reasons,
              raw: toPlain(raw),
            } satisfies RejectedRecord,
          ];
        } else {
          const { record, pointId } = verdict;
          const point = pointByCode.get(pointId);
          const clientId = resolveClientId(record);

          // 幂等：同一 clientId 已导入（含历史续传）则跳过
          const existed = await db.inspections.where('clientId').equals(clientId).first();
          if (existed) {
            cp.imported = [
              ...cp.imported,
              {
                index,
                code: record.code,
                pointId,
                inspectionId: existed.id,
                clientId,
                action: 'skipped-duplicate',
                protectedFields: [],
              } satisfies ImportedRecord,
            ];
          } else {
            const sameDay = findSameDayTargets(
              await db.inspections.where('pointId').equals(pointId).toArray(),
              pointId,
              record.date,
            );

            const now = nowIso();
            const basePatch = {
              slope: record.slope ?? 0,
              clearWidth: record.clearWidth ?? 0,
              hasHandrail: record.hasHandrail ?? false,
              tactileContinuous: record.tactileContinuous ?? false,
              occupied: record.occupied ?? '无',
              problem: record.problem ?? '',
            };

            // 同日多份核验：只被采集时间严格更晚的记录覆盖；旧记录保留
            const targets = sameDay.filter((old) =>
              collectedLater({ collectedAt: record.collectedAt as string }, old),
            );

            // 被覆盖旧记录若含手工更正，保护字段按最新一条带保护的旧记录沿用，不回退
            let protectedFields: ImportedRecord['protectedFields'] = [];
            let mergedPatch = basePatch;
            const protectedSource = targets
              .filter((t) => t.manualFields.length > 0)
              .sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1))[0];
            if (protectedSource) {
              const m = mergeProtectedFields(protectedSource, basePatch);
              mergedPatch = m.merged;
              protectedFields = m.protectedFields;
            }

            const inspection: Inspection = toPlain({
              id: makeId('ins'),
              pointId,
              date: record.date,
              inspector: record.inspector || pkg.inspector || '离线导入（未署名）',
              ...mergedPatch,
              conclusion: resolveConclusion(record),
              collectedAt: record.collectedAt as string,
              source: 'offline' as const,
              superseded: false,
              supersededById: '',
              manualFields: protectedSource ? protectedSource.manualFields : [],
              manualAt: protectedSource ? protectedSource.manualAt : '',
              clientId,
              createdAt: now,
            });
            // 保护字段可能改变实测判定，落库结论以合并后的值复算为准
            if (!record.conclusion) {
              inspection.conclusion = judgeInspection({
                slope: inspection.slope,
                clearWidth: inspection.clearWidth,
                hasHandrail: inspection.hasHandrail,
                tactileContinuous: inspection.tactileContinuous,
                occupied: inspection.occupied,
              }).conclusion;
            }

            const before = latestActiveOf(
              await db.inspections.where('pointId').equals(pointId).toArray(),
            );
            await db.inspections.put(inspection);
            for (const target of targets) {
              await db.inspections.update(target.id, {
                superseded: true,
                supersededById: inspection.id,
              });
            }
            const after = latestActiveOf(
              await db.inspections.where('pointId').equals(pointId).toArray(),
            );
            await cascadeInspectionChange(
              { inspections: db.inspections, rectifies: db.rectifies, routes: db.routes },
              point,
              before,
              after,
              'offline-merge',
            );

            cp.imported = [
              ...cp.imported,
              {
                index,
                code: record.code,
                pointId,
                inspectionId: inspection.id,
                clientId,
                action: targets.length ? 'superseded' : 'inserted',
                supersededId: targets[0]?.id,
                protectedFields,
              } satisfies ImportedRecord,
            ];
          }
        }

        // 检查点随本条记录原子落盘，中断后从下一条继续
        cp.lastIndex = index;
        cp.succeeded = cp.imported.length;
        cp.updatedAt = nowIso();
        await db.importCheckpoints.put(toPlain(cp));
      },
    );
    onProgress?.(cp);
  }

  cp.status = 'done';
  cp.finishedAt = nowIso();
  cp.updatedAt = nowIso();
  await db.importCheckpoints.put(toPlain(cp));
  onProgress?.(cp);
  return { checkpoint: cp, resumed };
}
