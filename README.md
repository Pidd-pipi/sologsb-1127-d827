# sologsb-1127 城市无障碍设施核验地图（gbaccessmap）

面向无障碍督导员与轮椅使用者代表，把坡道、盲道、无障碍电梯的点位、核验数据与通行路线集中到一张图上。

## 一键启动（Docker）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：<http://localhost:21827>

停止服务（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 分层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 + @ant-design/icons |
| 构建 | Vite 6（`tsc -b && vite build`，构建含类型检查） |
| 状态管理 | Zustand 5（业务数据 store + UI 偏好 persist 到 localStorage） |
| 路由 | React Router 6（BrowserRouter，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`，留空时自动降级为本地 SVG 网格视图） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbaccessmap-db`）+ localStorage（表单草稿、UI 偏好） |
| 托管 | nginx:alpine（多阶段构建） |

## 核心功能

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 核验总览：按行政区与设施类型汇总点位数、合格率、待整改数，点击统计块下钻清单 | AccessPoint / Inspection / RectifyPlan |
| `/points/new` | 点位登记：地图打点或手填经纬度，可同时录入首次核验实测值 | AccessPoint / Inspection |
| `/points/:id` | 点位详情：地图定位与属性、核验历史、就地新增核验、手工更正、整改跟踪（含失效旧条目） | 四个模型 |
| `/import` | 离线核验包合并：JSON 坏记录逐条隔离、检查点断点恢复、同日晚采集覆盖、手工更正保护 | ImportCheckpoint / Inspection |
| `/routes` | 通行路线编制：选点自动串联路段，逐段填障碍数/台阶数/路缘高差，输出全线判定；核验变化后路段失效重算 | RouteSegment / AccessPoint |
| `/map` | 设施地图：按设施类型着色渲染点位，点选弹出核验摘要 | AccessPoint / Inspection |
| `/rectify` | 整改清单：按状态与期限分组、逾期置顶，登记复检结果；失效旧条目分组展示原因 | RectifyPlan / AccessPoint |

## 数据模型（`src/types/` 独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| AccessPoint | `src/types/point.ts` | 点位编号、名称、设施类型、经纬度、行政区、所在道路或建筑、建成年代、养护单位 |
| Inspection | `src/types/inspection.ts` | 核验日期、采集时间、来源、坡度 %、净宽 cm、扶手、盲道连续性、占用情况、结论、问题描述、`superseded` 覆盖标记、`manualFields` 手工更正保护字段 |
| RouteSegment | `src/types/route.ts` | 路线名称、起点/终点点位、长度、障碍数、台阶数、路缘高差、是否可轮椅通行、`invalid/invalidReason` 失效标记与原因 |
| RectifyPlan | `src/types/rectify.ts` | 点位 id、整改要求、责任单位、整改期限、复检日期、状态、`source(auto/manual)`、`invalid/invalidReason` 失效标记、来源核验 id |
| ImportCheckpoint | `src/types/offline.ts` | 批次号、文件名、已处理序号、成功/坏记录明细、状态、源包原文（断点恢复用） |

## 数据存储

- **IndexedDB（Dexie，库名 `gbaccessmap-db`）**：业务数据。含版本号与升级迁移：
  - `v1` 建 `points` / `inspections` 表；
  - `v2` 增加 `routes` 表与 `pointId` 相关索引；
  - `v3` 增加 `rectifies` 表，并为历史「不合格」核验补建整改条目；
  - `v4` 核验表补采集时间 / 来源 / 覆盖标记 / 手工更正保护字段，整改与路段表补失效标记与原因，新增 `importCheckpoints` 检查点表（历史整改条目视为人工登记，避免升级后被误失效）。

### 离线核验包合并（`/import`）

督导员离线核验后交回 JSON 包（外层 `{ batchId?, records: [...] }`，记录以点位编号 `code` 关联设施），合并规则：

- **坏记录隔离**：点位编号写错、值越界（坡度 0~100%、净宽 0~500cm）、日期/枚举非法等逐条校验，坏记录只入「坏记录明细」，不挡住同包其他记录；
- **检查点恢复**：每条记录独立事务，业务写入与检查点原子提交；中断或失败后在检查点表保留进度，可「从断点继续」，同 `clientId` 幂等，整包重导自动跳过已入库记录；
- **同日晚采集覆盖**：同一设施同一天多份核验，`collectedAt` 晚的覆盖旧结果；旧记录以 `superseded` 标记保留备查，总览/地图的最新结论只取未覆盖记录；
- **手工更正不回退**：点位详情可手工更正核验字段，被更正字段记入 `manualFields`；之后离线包覆盖该记录时这些字段沿用旧值，结论按合并后实测值复判；
- **联动失效重算**：最新核验变化时，该点位未关闭的**自动**整改条目标记失效并按新结论重建（人工登记条目不碰、已整改历史条目不失效），关联点位的通行路段全部标记失效并写入原因；旧条目/旧路段均保留，界面分区展示原因，可「重新实测」生成有效新判定。
- **localStorage**：点位登记表单草稿（`gbaccessmap-draft:point-new`）与 UI 偏好（`gbaccessmap-ui`）。
- 首次打开时自动写入一批示例数据，便于直接体验。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器存储即可重置数据。

## 高德地图 key

`VITE_AMAP_KEY` 留空（默认）时：`useAmapLoader()` 检测到 key 为空会**立即**返回降级标记，**不会**请求 `webapi.amap.com`；页面渲染可点选、可查看详情的本地 SVG 网格视图（`MapPanel`）。配置了 key 时脚本加载失败或超时同样自动降级，因此构建与运行都不依赖该 key。

## 目录结构

```
sologsb-1127/
├── docker-compose.yml          # 顶层 name: gbaccessmap，无 version: 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── README.md
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files + gzip
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig*.json
    ├── public/favicon.svg
    └── src/
        ├── types/{point,inspection,route,rectify,offline}.ts
        ├── db/index.ts                     # Dexie 封装 + 版本迁移 + 示例数据
        ├── services/{inspectionSync,offlineImport}.ts  # 联动失效重算 / 离线包合并与检查点
        ├── utils/{routeCheck,offlineMerge,geo,format}.ts
        ├── stores/{pointStore,routeStore,uiStore}.ts
        ├── components/common/{MapPanel,StatusBadge,FacilityIcon,MeasureInput,EmptyState}.tsx
        ├── hooks/{useAmapLoader,useInspectionFilter,useLocalDraft}.ts
        ├── pages/{Overview,PointNew,PointDetail,OfflineImport,Routes,MapView,Rectify}.tsx
        ├── layouts/AppLayout.tsx
        ├── router/index.tsx
        └── scripts/verify-offline.ts       # 离线合并/覆盖/保护/联动断言（npm run verify）
```

## 判定阈值（`src/utils/routeCheck.ts`）

- 坡度：≤ 5% 合格，> 5% 限期整改，> 8% 不合格；
- 净宽：≥ 120cm 合格，< 120cm 限期整改，< 90cm 不合格；
- 路缘高差：≤ 3cm 可轮椅通行，> 6cm 判定不可通行；存在台阶需绕行或增设坡道。
