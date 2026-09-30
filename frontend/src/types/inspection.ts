/** 核验结论 */
export type InspectionConclusion = '合格' | '限期整改' | '不合格';

export const CONCLUSIONS: InspectionConclusion[] = ['合格', '限期整改', '不合格'];

/** 被占用情况 */
export type OccupiedLevel = '无' | '临时占用' | '长期占用';

export const OCCUPIED_LEVELS: OccupiedLevel[] = ['无', '临时占用', '长期占用'];

/** 核验记录来源：手工录入 / 离线核验包导入 / 示例种子数据 */
export type InspectionSource = 'manual' | 'offline' | 'seed';

/** 核验记录 */
export interface Inspection {
  id: string;
  pointId: string;
  /** 核验日期 YYYY-MM-DD */
  date: string;
  /** 采集时间 ISO 时间戳：同一设施同一天多份核验时，晚采集覆盖早采集 */
  collectedAt: string;
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
  /** 记录来源 */
  source: InspectionSource;
  /** 是否被同点位同日更晚采集覆盖（旧记录保留，仅标记） */
  superseded: boolean;
  /** 是否被手工更正过：离线导入不得回退手工更正内容 */
  manualEdited: boolean;
  createdAt: string;
}

export type InspectionDraft = Omit<Inspection, 'id' | 'createdAt' | 'collectedAt' | 'source' | 'superseded' | 'manualEdited'> & {
  collectedAt?: string;
  source?: InspectionSource;
};
