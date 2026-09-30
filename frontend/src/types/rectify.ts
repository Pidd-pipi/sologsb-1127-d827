/** 整改状态 */
export type RectifyStatus = '待整改' | '已整改' | '复发';

export const RECTIFY_STATUSES: RectifyStatus[] = ['待整改', '已整改', '复发'];

/** 整改条目来源：核验联动自动生成 / 人工登记（手工条目不随核验自动失效） */
export type RectifySource = 'auto' | 'manual';

/** 失效原因（条目保留，仅标记失效；原因在界面展示） */
export interface Invalidation {
  /** 失效时间 ISO */
  at: string;
  /** 触发失效的核验记录 id */
  inspectionId: string;
  /** 人类可读原因 */
  reason: string;
}

/** 整改跟踪条目 */
export interface RectifyPlan {
  id: string;
  pointId: string;
  /** 整改要求 */
  requirement: string;
  /** 责任单位 */
  unit: string;
  /** 整改期限 YYYY-MM-DD */
  deadline: string;
  /** 复检日期 YYYY-MM-DD，未复检为空字符串 */
  recheckDate: string;
  status: RectifyStatus;
  /** auto：由核验结论联动生成，核验记录变化时失效重算；manual：人工登记，不自动失效 */
  source: RectifySource;
  /** 联动条目是否已因核验记录变化而失效（旧条目保留备查） */
  invalid: boolean;
  /** 失效原因 */
  invalidReason: Invalidation | null;
  /** 由哪条核验记录联动生成 */
  fromInspectionId: string;
  createdAt: string;
}

export type RectifyPlanDraft = Omit<
  RectifyPlan,
  'id' | 'createdAt' | 'source' | 'invalid' | 'invalidReason' | 'fromInspectionId'
>;

/** 按状态与期限分组后的清单结构 */
export interface RectifyGroup {
  key: string;
  title: string;
  items: RectifyPlan[];
}
