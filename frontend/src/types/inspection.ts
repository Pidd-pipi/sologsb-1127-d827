/** 核验结论 */
export type InspectionConclusion = '合格' | '限期整改' | '不合格';

export const CONCLUSIONS: InspectionConclusion[] = ['合格', '限期整改', '不合格'];

/** 被占用情况 */
export type OccupiedLevel = '无' | '临时占用' | '长期占用';

export const OCCUPIED_LEVELS: OccupiedLevel[] = ['无', '临时占用', '长期占用'];

/** 核验记录来源：离线包导入 / 现场或后台手工录入 */
export type InspectionSource = 'offline' | 'manual';

/** 可手工更正、且更正后不被离线包回退的字段 */
export const MANUAL_FIELDS = [
  'slope',
  'clearWidth',
  'hasHandrail',
  'tactileContinuous',
  'occupied',
  'problem',
] as const;

export type ManualField = (typeof MANUAL_FIELDS)[number];

/** 核验记录 */
export interface Inspection {
  id: string;
  pointId: string;
  /** 核验日期 YYYY-MM-DD */
  date: string;
  inspector: string;
  /** 坡度 % */
  slope: number;
  /** 净宽 cm */
  clearWidth: number;
  /** 扶手有无 */
  hasHandrail: boolean;
  /** 盲道连续性 */
  tactileContinuous: boolean;
  /** 被占用情况 */
  occupied: OccupiedLevel;
  conclusion: InspectionConclusion;
  problem: string;
  /** 采集时间 ISO 字符串：同一设施同一天多份核验时，采集时间晚的覆盖旧结果 */
  collectedAt: string;
  /** 来源：离线核验包导入 / 手工录入 */
  source: InspectionSource;
  /** 是否已被同点位同日采集时间更晚的核验覆盖（旧记录保留备查） */
  superseded: boolean;
  /** 被哪条核验记录覆盖 */
  supersededById: string;
  /** 已手工更正的字段名，离线合并时这些字段不回退 */
  manualFields: ManualField[];
  /** 最近一次手工更正时间 */
  manualAt: string;
  /** 离线记录的稳定去重键（由设备端内容生成，导入可安全重试） */
  clientId: string;
  createdAt: string;
}

/** 手工录入核验时需要填写的部分（库管字段由 store 补全） */
export type InspectionDraft = Omit<
  Inspection,
  | 'id'
  | 'createdAt'
  | 'collectedAt'
  | 'source'
  | 'superseded'
  | 'supersededById'
  | 'manualFields'
  | 'manualAt'
  | 'clientId'
>;

/** 手工更正提交的字段 */
export type InspectionCorrection = Partial<Pick<Inspection, ManualField>>;
