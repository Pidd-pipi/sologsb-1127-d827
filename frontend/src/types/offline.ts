import type { InspectionConclusion, OccupiedLevel } from './inspection';

/** 督导员离线采集后交回的单条核验（点位用编号 code 关联） */
export interface OfflineInspectionRecord {
  /** 点位编号，如 WZ-2024-001；写错时整条记为坏记录，不影响包内其他记录 */
  code: string;
  /** 核验日期 YYYY-MM-DD */
  date: string;
  inspector?: string;
  /** 坡度 %，合理范围 0 ~ 100 */
  slope?: number;
  /** 净宽 cm，合理范围 0 ~ 500 */
  clearWidth?: number;
  hasHandrail?: boolean;
  tactileContinuous?: boolean;
  occupied?: OccupiedLevel;
  /** 结论可留空，留空时按实测值自动判定；填写时需为合法枚举 */
  conclusion?: InspectionConclusion;
  problem?: string;
  /** 采集时间 ISO；缺省时退化为核验日期当天 23:59:59 */
  collectedAt?: string;
  /** 设备端稳定 id（或 clientId），用于断点续传去重；均缺省时由内容生成 */
  id?: string;
  /** 同 id */
  clientId?: string;
}

/** 离线核验包 */
export interface OfflineInspectionPackage {
  /** 包批次号，同一批包重复导入时走检查点跳过 */
  batchId?: string;
  exportedAt?: string;
  inspector?: string;
  records: unknown[];
}

/** 单条坏记录的错误明细（坏记录隔离，不阻塞同包其他记录） */
export interface RejectedRecord {
  /** 包内序号（从 0 开始） */
  index: number;
  /** 尽量保留的点位编号，便于督导员核对 */
  code: string;
  reasons: string[];
  raw: unknown;
}

/** 单条记录导入结果 */
export interface ImportedRecord {
  index: number;
  code: string;
  pointId: string;
  inspectionId: string;
  clientId: string;
  /** 新增 / 重试跳过 / 同日覆盖旧记录 */
  action: 'inserted' | 'skipped-duplicate' | 'superseded';
  /** 被覆盖的旧核验 id（action=superseded 时） */
  supersededId?: string;
  /** 因手工更正被保留、未回退的字段 */
  protectedFields: string[];
}

/** 检查点：每条记录处理完即落盘，导入中断后从下一条继续 */
export interface ImportCheckpoint {
  /** 主键：批次号（缺省按包内容哈希生成） */
  batchId: string;
  fileName: string;
  total: number;
  /** 已成功提交到的记录序号（从 0 开始） */
  lastIndex: number;
  succeeded: number;
  rejected: RejectedRecord[];
  imported: ImportedRecord[];
  status: 'running' | 'done';
  startedAt: string;
  updatedAt: string;
  finishedAt: string;
  /** 源包原文（结构错误的坏记录以原文保留），用于检查点恢复 */
  rawPackage: unknown;
}
