import type { Invalidation } from './rectify';

/** 通行路线段 */
export interface RouteSegment {
  id: string;
  /** 路线名称，同一条路线的多段共用一个名称 */
  routeName: string;
  fromPointId: string;
  toPointId: string;
  /** 长度 m */
  length: number;
  /** 沿途障碍数 */
  obstacleCount: number;
  /** 台阶数 */
  stepCount: number;
  /** 路缘高差 cm */
  curbHeight: number;
  /** 是否可轮椅通行（由逐段核验判定） */
  wheelchairPassable: boolean;
  /** 在整条路线中的顺序，从 1 开始 */
  order: number;
  /** 核验记录变化导致判定失效：旧路段保留，需重算 */
  invalid: boolean;
  /** 失效原因（关联点位的最新核验变化） */
  invalidReason: Invalidation | null;
  createdAt: string;
}

export type RouteSegmentDraft = Omit<
  RouteSegment,
  'id' | 'createdAt' | 'wheelchairPassable' | 'invalid' | 'invalidReason'
>;

/** 全线判定结果 */
export interface RouteVerdict {
  routeName: string;
  passable: boolean;
  totalLength: number;
  totalObstacles: number;
  totalSteps: number;
  maxCurbHeight: number;
  reasons: string[];
  /** 全线是否含失效路段（核验记录变化后需重算） */
  hasInvalid: boolean;
  /** 失效原因汇总 */
  invalidReasons: string[];
}
