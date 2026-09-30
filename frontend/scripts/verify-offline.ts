import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import type { AccessPoint } from '../src/types/point';
import type { OfflineInspectionPackage } from '../src/types/offline';
import { mergeOfflinePackage, resumeFromCheckpoint, listCheckpoints } from '../src/services/offlineImport';
import { correctInspectionWithCascade } from '../src/services/inspectionSync';

let pass = 0;
const ok = (name: string) => {
  pass += 1;
  console.log(`  ✓ ${name}`);
};

async function resetDb() {
  await db.table('points').clear();
  await db.table('inspections').clear();
  await db.table('rectifies').clear();
  await db.table('routes').clear();
  await db.table('importCheckpoints').clear();
}

async function seedPoint(id: string, code: string): Promise<AccessPoint> {
  const now = new Date().toISOString();
  const point: AccessPoint = {
    id,
    code,
    name: `点位${code}`,
    facilityType: '缘石坡道',
    lng: 116.4,
    lat: 39.9,
    district: '东城区',
    location: '测试路',
    builtYear: 2020,
    maintainUnit: '市政道路养护一所',
    createdAt: now,
    updatedAt: now,
  };
  await db.points.put(point);
  return point;
}

async function main() {
  // ---------- 场景 1：坏记录隔离 + 检查点恢复 ----------
  await resetDb();
  await seedPoint('p1', 'WZ-2024-001');
  {
    const pkg: OfflineInspectionPackage = {
      batchId: 'b1',
      records: [
        { code: 'WZ-2024-001', date: '2026-09-01', slope: 3, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: '2026-09-01T09:00:00Z', clientId: 'c1' },
        { code: 'WZ-NOPE-999', date: '2026-09-01', slope: 3, clearWidth: 150, clientId: 'c2' },
        { code: 'WZ-2024-001', date: '2026-09-02', slope: 700, clearWidth: 150, clientId: 'c3' },
        { code: 'WZ-2024-001', date: 'bad-date', slope: 3, clientId: 'c4' },
        'raw-string-record',
      ],
    };
    const { checkpoint } = await mergeOfflinePackage(pkg, 'b1.json');
    assert.equal(checkpoint.imported.length, 1, '只有 1 条好记录');
    assert.equal(checkpoint.rejected.length, 4, '4 条坏记录被隔离');
    assert.equal(checkpoint.rejected[0].reasons.join(), '点位编号 WZ-NOPE-999 不存在');
    assert.match(checkpoint.rejected[1].reasons[0], /越界/);
    const inspCount = await db.inspections.count();
    assert.equal(inspCount, 1, '坏记录未入库');
    assert.equal(checkpoint.status, 'done');
    ok('坏记录（坏编号/值越界/坏日期/非对象）逐条隔离，不挡其他记录');

    // 整包重导：幂等跳过
    const again = await mergeOfflinePackage(pkg, 'b1.json');
    assert.equal(again.checkpoint.imported.filter((i) => i.action === 'skipped-duplicate').length, 1);
    assert.equal(await db.inspections.count(), 1, '重导不产生重复核验');
    ok('同批次重复导入幂等跳过');
  }

  // ---------- 场景 2：检查点恢复 ----------
  await resetDb();
  await seedPoint('p1', 'WZ-2024-001');
  {
    const pkg: OfflineInspectionPackage = {
      batchId: 'b2',
      records: Array.from({ length: 6 }, (_, i) => ({
        code: 'WZ-2024-001',
        date: '2026-08-01',
        slope: 2,
        clearWidth: 140,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        collectedAt: `2026-08-01T0${i}:00:00Z`,
        clientId: `r${i}`,
      })),
    };
    // 模拟导入到第 3 条后中断（手工写一个 running 检查点，前 3 条尚未入库）
    const cp = {
      batchId: 'b2',
      fileName: 'b2.json',
      total: 6,
      lastIndex: 2,
      succeeded: 0,
      rejected: [],
      imported: [],
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: '',
      rawPackage: pkg,
    };
    await db.importCheckpoints.put(cp);
    const resumed = await resumeFromCheckpoint(cp);
    assert.equal(resumed.checkpoint.status, 'done');
    assert.equal(resumed.resumed, true, '识别为断点续传');
    assert.equal(await db.inspections.count(), 3, '从断点只补入剩余 3 条');
    const cps = await listCheckpoints();
    assert.equal(cps[0].lastIndex, 5);
    ok('导入中断后从检查点恢复，只处理未完成记录');
  }

  // ---------- 场景 3：同日晚采集覆盖 + 手工更正不回退 ----------
  await resetDb();
  const p3 = await seedPoint('p3', 'WZ-2024-003');
  {
    // 3a. 早晨一条合格
    const morning: OfflineInspectionPackage = {
      batchId: 'b3a',
      records: [
        { code: 'WZ-2024-003', date: '2026-09-10', slope: 3, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: '2026-09-10T01:00:00Z', clientId: 'm1' },
      ],
    };
    await mergeOfflinePackage(morning, 'm.json');
    const morningRow = (await db.inspections.toArray())[0];
    assert.equal(morningRow.conclusion, '合格');

    // 3b. 手工更正早晨记录的 problem + slope（模拟现场纠错）
    const { inspection: corrected } = await correctInspectionWithCascade(
      morningRow.id,
      { problem: '手工补充：扶手轻微松动', slope: 4.2 },
      p3,
    );
    assert.deepEqual(corrected.manualFields.sort(), ['problem', 'slope']);
    assert.equal(corrected.slope, 4.2);

    // 3c. 下午晚到一份「不合格」包，slope=9.5（与手工字段冲突）
    const evening: OfflineInspectionPackage = {
      batchId: 'b3b',
      records: [
        { code: 'WZ-2024-003', date: '2026-09-10', slope: 9.5, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', problem: '离线：严重问题', collectedAt: '2026-09-10T10:00:00Z', clientId: 'e1' },
      ],
    };
    const { checkpoint } = await mergeOfflinePackage(evening, 'e.json');
    const imp = checkpoint.imported[0];
    assert.equal(imp.action, 'superseded', '晚到记录覆盖旧结果');
    assert.deepEqual(imp.protectedFields.sort(), ['problem', 'slope'], '两个手工字段受保护');

    const rows = await db.inspections.toArray();
    const old = rows.find((r) => r.id === morningRow.id)!;
    const latest = rows.find((r) => r.id === imp.inspectionId)!;
    assert.equal(old.superseded, true, '旧记录标记覆盖但保留');
    assert.equal(old.supersededById, latest.id);
    assert.equal(latest.slope, 4.2, '手工坡度未被 9.5 回退');
    assert.equal(latest.problem, '手工补充：扶手轻微松动', '手工问题描述未回退');
    assert.equal(latest.clearWidth, 80, '非保护字段按离线包更新');
    assert.equal(latest.occupied, '长期占用');
    // 结论按合并后实测值复算：坡度 4.2（保护）但净宽 80 < 90 仍不合格
    assert.equal(latest.conclusion, '不合格');
    assert.deepEqual(latest.manualFields.sort(), ['problem', 'slope'], '保护标记延续');
    ok('同日采集时间晚者覆盖旧结果，手工更正字段不回退，结论按合并值复判，旧记录保留');
  }

  // ---------- 场景 4：联动失效整改条目（自动失效重建/手工不动/已整改保留） ----------
  await resetDb();
  const p4 = await seedPoint('p4', 'WZ-2024-004');
  {
    // 初始：一条不合格 -> 自动整改
    const bad: OfflineInspectionPackage = {
      batchId: 'b4a',
      records: [
        { code: 'WZ-2024-004', date: '2026-09-01', slope: 9.5, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', collectedAt: '2026-09-01T02:00:00Z', clientId: 'bad1' },
      ],
    };
    await mergeOfflinePackage(bad, 'bad.json');
    const autoPlans = await db.rectifies.toArray();
    assert.equal(autoPlans.length, 1);
    assert.equal(autoPlans[0].source, 'auto');
    assert.equal(autoPlans[0].status, '待整改');
    const autoId = autoPlans[0].id;

    // 再来一条合格的晚核验（不同日期）-> 旧自动条目失效，不新建
    const good: OfflineInspectionPackage = {
      batchId: 'b4b',
      records: [
        { code: 'WZ-2024-004', date: '2026-09-20', slope: 2, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: '2026-09-20T02:00:00Z', clientId: 'good1' },
      ],
    };
    await mergeOfflinePackage(good, 'good.json');
    const plansAfter = await db.rectifies.toArray();
    const oldAuto = plansAfter.find((r) => r.id === autoId)!;
    assert.equal(oldAuto.invalid, true, '旧自动整改条目失效');
    assert.match(oldAuto.invalidReason!.reason, /离线核验包合并/);
    assert.equal(plansAfter.filter((r) => !r.invalid).length, 0, '合格后不新建整改条目');
    ok('核验变为合格：自动整改条目失效并记录原因，合格不重建');

    // 再次不合格 -> 新建一条自动整改，旧失效条目仍保留
    const bad2: OfflineInspectionPackage = {
      batchId: 'b4c',
      records: [
        { code: 'WZ-2024-004', date: '2026-09-25', slope: 9, clearWidth: 85, hasHandrail: false, tactileContinuous: false, occupied: '无', collectedAt: '2026-09-25T02:00:00Z', clientId: 'bad2' },
      ],
    };
    await mergeOfflinePackage(bad2, 'bad2.json');
    const plansFinal = await db.rectifies.toArray();
    assert.equal(plansFinal.length, 2, '旧失效条目保留 + 新建 1 条');
    assert.equal(plansFinal.filter((r) => !r.invalid && r.source === 'auto').length, 1);
    ok('核验再次不合格：按最新结论重建整改条目，旧记录保留');
  }

  // 手工登记整改条目 + 已整改自动条目不被失效
  await resetDb();
  const p5 = await seedPoint('p5', 'WZ-2024-005');
  {
    const bad: OfflineInspectionPackage = {
      batchId: 'b5a',
      records: [
        { code: 'WZ-2024-005', date: '2026-09-01', slope: 9.5, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', collectedAt: '2026-09-01T02:00:00Z', clientId: 'bad5' },
      ],
    };
    await mergeOfflinePackage(bad, 'bad.json');
    const autoId = (await db.rectifies.toArray())[0].id;
    // 模拟人工把自动条目复检为已整改
    await db.rectifies.update(autoId, { status: '已整改', recheckDate: '2026-09-10' });
    // 再变合格
    await mergeOfflinePackage(
      {
        batchId: 'b5b',
        records: [
          { code: 'WZ-2024-005', date: '2026-09-20', slope: 2, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: '2026-09-20T02:00:00Z', clientId: 'good5' },
        ],
      },
      'good.json',
    );
    const plan = (await db.rectifies.toArray())[0];
    assert.equal(plan.status, '已整改');
    assert.equal(plan.invalid, false, '已整改的历史条目不失效');
    ok('已整改条目作为历史保留，不被联动失效');
  }

  // ---------- 场景 5：关联路段失效重算 ----------
  await resetDb();
  const pa = await seedPoint('pa', 'WZ-2024-A');
  const pb = await seedPoint('pb', 'WZ-2024-B');
  {
    const now = new Date().toISOString();
    await db.routes.bulkPut([
      { id: 's1', routeName: 'R', fromPointId: 'pa', toPointId: 'pb', length: 100, obstacleCount: 0, stepCount: 0, curbHeight: 2, wheelchairPassable: true, order: 1, invalid: false, invalidReason: null, createdAt: now },
      { id: 's2', routeName: 'R', fromPointId: 'pb', toPointId: 'pa', length: 100, obstacleCount: 0, stepCount: 0, curbHeight: 2, wheelchairPassable: true, order: 2, invalid: false, invalidReason: null, createdAt: now },
    ]);
    await mergeOfflinePackage(
      {
        batchId: 'br',
        records: [
          { code: 'WZ-2024-A', date: '2026-09-01', slope: 9.5, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', collectedAt: '2026-09-01T03:00:00Z', clientId: 'rbad' },
        ],
      },
      'r.json',
    );
    const segs = await db.routes.toArray();
    assert.equal(segs.every((s) => s.invalid), true, '两段关联路段均失效');
    assert.match(segs[0].invalidReason!.reason, /通行路段|关联点位/);
    assert.equal(segs[0].wheelchairPassable, true, '旧判定值保留在旧记录上');
    ok('核验变化时关联点位的通行路段失效并记录原因，旧记录保留');
  }

  // ---------- 场景 6：乱序早到记录不覆盖、不触发联动 ----------
  await resetDb();
  const p6 = await seedPoint('p6', 'WZ-2024-006');
  {
    const first: OfflineInspectionPackage = {
      batchId: 'b6a',
      records: [
        { code: 'WZ-2024-006', date: '2026-09-10', slope: 9.5, clearWidth: 80, hasHandrail: false, tactileContinuous: false, occupied: '长期占用', collectedAt: '2026-09-10T10:00:00Z', clientId: 'late1' },
      ],
    };
    await mergeOfflinePackage(first, 'f.json');
    const rectBefore = await db.rectifies.toArray();
    assert.equal(rectBefore.length, 1);

    // 同日但采集时间更早的记录后到：不应覆盖最新，也不应再联动
    const older: OfflineInspectionPackage = {
      batchId: 'b6b',
      records: [
        { code: 'WZ-2024-006', date: '2026-09-10', slope: 2, clearWidth: 150, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: '2026-09-10T06:00:00Z', clientId: 'early1' },
      ],
    };
    const { checkpoint } = await mergeOfflinePackage(older, 'o.json');
    assert.equal(checkpoint.imported[0].action, 'inserted', '仍是新记录入库');
    const rows = await db.inspections.toArray();
    const latest = rows.find((r) => r.clientId === 'late1')!;
    const early = rows.find((r) => r.clientId === 'early1')!;
    assert.equal(early.superseded, false, '更早记录不被标记覆盖');
    assert.equal(latest.superseded, false, '最新记录不受影响');
    const rectAfter = await db.rectifies.toArray();
    assert.equal(rectAfter.length, 1, '未新增/失效整改条目（最新结论未变）');
    assert.equal(rectAfter[0].invalid, false);
    ok('同日采集时间更早的乱序记录不覆盖最新结果、不触发失效联动');
  }

  console.log(`\n全部 ${pass} 项逻辑断言通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
