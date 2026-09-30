import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import type { ImportCheckpoint, RejectedRecord } from '../types/offline';
import type { OfflineInspectionPackage } from '../types/offline';
import {
  deleteCheckpoint,
  listCheckpoints,
  mergeOfflinePackage,
  resumeFromCheckpoint,
} from '../services/offlineImport';
import { parsePackage } from '../utils/offlineMerge';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';

interface ParseError {
  fileName: string;
  message: string;
}

/** 示例包：含正常、坏编号、值越界、同日晚到覆盖等场景 */
function buildSamplePackage(): OfflineInspectionPackage {
  const today = new Date();
  const iso = (h: number, m = 0) => {
    const d = new Date(today);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const date = today.toISOString().slice(0, 10);
  return {
    batchId: `sample-${date}`,
    exportedAt: iso(8),
    inspector: '督导员 李维',
    records: [
      {
        code: 'WZ-2024-001',
        date,
        slope: 2.8,
        clearWidth: 142,
        hasHandrail: true,
        tactileContinuous: true,
        occupied: '无',
        collectedAt: iso(9, 12),
        clientId: `sample-1-${date}`,
      },
      { code: 'WZ-2024-999', date, slope: 2, clearWidth: 130, collectedAt: iso(9, 20) },
      { code: 'WZ-2024-003', date, slope: 1.2, clearWidth: 160, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: iso(9, 30) },
      { code: 'WZ-2024-004', date, slope: 4.1, clearWidth: 126, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: iso(10, 5) },
      { code: 'WZ-2024-004', date, slope: 6.8, clearWidth: 96, hasHandrail: true, tactileContinuous: false, occupied: '临时占用', problem: '午后复测：净宽被压缩', collectedAt: iso(15, 40), clientId: `sample-5-${date}` },
      { code: 'WZ-2024-005', date, slope: 1.4, clearWidth: 620, hasHandrail: true, tactileContinuous: true, occupied: '无', collectedAt: iso(10, 50) },
      '这不是一条核验记录',
    ],
  };
}

export default function OfflineImport() {
  const fileRef = useRef<HTMLInputElement>(null);
  const refreshPoints = usePointStore((s) => s.refreshAfterCascade);
  const reloadRoutes = useRouteStore((s) => s.reloadRoutes);

  const [fileName, setFileName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<ImportCheckpoint | null>(null);
  const [parseError, setParseError] = useState<ParseError | null>(null);
  const [fatal, setFatal] = useState('');
  const [checkpoints, setCheckpoints] = useState<ImportCheckpoint[]>([]);

  const refreshCheckpoints = () =>
    listCheckpoints()
      .then(setCheckpoints)
      .catch(() => undefined);

  useEffect(() => {
    void refreshCheckpoints();
  }, []);

  const afterFinish = async (cp: ImportCheckpoint) => {
    setDone(cp);
    await Promise.all([refreshPoints(), reloadRoutes(), refreshCheckpoints()]);
  };

  const pickFile = (file: File) => {
    setFileName(file.name);
    setDone(null);
    setParseError(null);
    setFatal('');
    const reader = new FileReader();
    reader.onload = () => setFileContent(String(reader.result ?? ''));
    reader.onerror = () => setParseError({ fileName: file.name, message: '文件读取失败' });
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!fileContent) return;
    setFatal('');
    setParseError(null);
    let pkg: OfflineInspectionPackage;
    try {
      pkg = parsePackage(fileContent);
    } catch (e) {
      setParseError({ fileName, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    setRunning(true);
    setProgress(0);
    try {
      const { checkpoint } = await mergeOfflinePackage(pkg, fileName, (cp) =>
        setProgress(cp.total ? Math.round(((cp.lastIndex + 1) / cp.total) * 100) : 100),
      );
      await afterFinish(checkpoint);
    } catch (e) {
      // 整包级失败（如浏览器中断）：检查点已落盘，可从下方断点恢复
      setFatal(
        `导入中断：${e instanceof Error ? e.message : String(e)}。已处理记录的检查点已保留，可从下方断点继续。`,
      );
      await refreshCheckpoints();
    } finally {
      setRunning(false);
    }
  };

  const handleResume = async (cp: ImportCheckpoint) => {
    setFatal('');
    setRunning(true);
    setProgress(cp.total ? Math.round(((cp.lastIndex + 1) / cp.total) * 100) : 0);
    try {
      const { checkpoint } = await resumeFromCheckpoint(cp, (next) =>
        setProgress(next.total ? Math.round(((next.lastIndex + 1) / next.total) * 100) : 100),
      );
      await afterFinish(checkpoint);
    } catch (e) {
      setFatal(`断点恢复失败：${e instanceof Error ? e.message : String(e)}`);
      await refreshCheckpoints();
    } finally {
      setRunning(false);
    }
  };

  const handleDeleteCp = (cp: ImportCheckpoint) => {
    Modal.confirm({
      title: '删除检查点？',
      content: `仅删除批次 ${cp.batchId} 的断点记录，已入库的核验不会回滚。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await deleteCheckpoint(cp.batchId);
        await refreshCheckpoints();
      },
    });
  };

  const downloadSample = () => {
    const blob = new Blob([JSON.stringify(buildSamplePackage(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'offline-inspections.sample.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const total = done?.total ?? 0;
  const inserted = useMemo(
    () => done?.imported.filter((i) => i.action === 'inserted').length ?? 0,
    [done],
  );
  const superseded = useMemo(
    () => done?.imported.filter((i) => i.action === 'superseded').length ?? 0,
    [done],
  );
  const duplicated = useMemo(
    () => done?.imported.filter((i) => i.action === 'skipped-duplicate').length ?? 0,
    [done],
  );

  const rejectedColumns: ColumnsType<RejectedRecord> = [
    { title: '#', dataIndex: 'index', width: 60, render: (v: number) => v + 1 },
    { title: '点位编号', dataIndex: 'code', width: 160, render: (v: string) => v || <Tag>缺失</Tag> },
    {
      title: '错误原因（该条已隔离，未影响其他记录）',
      dataIndex: 'reasons',
      render: (v: string[]) => (
        <Space direction="vertical" size={2}>
          {v.map((r) => (
            <Tag key={r} color="error">
              {r}
            </Tag>
          ))}
        </Space>
      ),
    },
  ];

  const cpColumns: ColumnsType<ImportCheckpoint> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) =>
        v === 'done' ? <Tag color="success">已完成</Tag> : <Tag color="processing">中断</Tag>,
    },
    { title: '文件', dataIndex: 'fileName', width: 220, ellipsis: true },
    { title: '批次号', dataIndex: 'batchId', width: 180, ellipsis: true },
    {
      title: '进度',
      width: 160,
      render: (_, row) => (
        <Progress percent={row.total ? Math.round(((row.lastIndex + 1) / row.total) * 100) : 0} size="small" />
      ),
    },
    {
      title: '成功 / 坏记录',
      width: 120,
      render: (_, row) => (
        <Space size={4}>
          <Tag color="green">{row.succeeded}</Tag>
          <Tag color={row.rejected.length ? 'red' : 'default'}>{row.rejected.length}</Tag>
        </Space>
      ),
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: (v: string) => v.replace('T', ' ').slice(0, 19) },
    {
      title: '操作',
      width: 180,
      render: (_, row) => (
        <Space>
          {row.status === 'running' ? (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<PlayCircleOutlined />}
              loading={running}
              onClick={() => handleResume(row)}
              data-testid={`resume-${row.batchId}`}
            >
              从断点继续
            </Button>
          ) : (
            <Button size="small" onClick={() => setDone(row)} data-testid={`view-${row.batchId}`}>
              查看结果
            </Button>
          )}
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteCp(row)} />
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">离线核验包合并</h1>
          <Typography.Text type="secondary">
            选择督导员交回的 JSON 核验包：坏记录（点位编号写错、值越界）自动隔离不挡其他记录；同设施同日多份核验按采集时间晚者覆盖，手工更正内容不回退；导入中断可从检查点恢复。
          </Typography.Text>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="选择核验包" size="small">
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                data-testid="offline-file-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickFile(f);
                  e.target.value = '';
                }}
              />
              <Space wrap>
                <Button
                  icon={<CloudUploadOutlined />}
                  onClick={() => fileRef.current?.click()}
                  data-testid="pick-offline-file"
                >
                  选择 JSON 文件
                </Button>
                <Button onClick={downloadSample} icon={<FileTextOutlined />} data-testid="download-sample">
                  下载示例包
                </Button>
              </Space>
              {fileName ? (
                <Typography.Text>
                  <FileTextOutlined /> {fileName}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">尚未选择文件</Typography.Text>
              )}
              {parseError ? (
                <Alert
                  type="error"
                  showIcon
                  message="核验包无法解析（整包未导入）"
                  description={parseError.message}
                />
              ) : null}
              {running ? (
                <Progress percent={progress} status="active" data-testid="import-progress" />
              ) : null}
              <Button
                type="primary"
                disabled={!fileContent || running}
                loading={running}
                onClick={handleImport}
                data-testid="start-import"
              >
                开始合并
              </Button>
              <Typography.Text type="secondary" className="gb-muted">
                每条记录独立提交检查点；再次导入同一批次会自动跳过已处理记录。
              </Typography.Text>
            </Space>
          </Card>

          {fatal ? (
            <Alert style={{ marginTop: 16 }} type="warning" showIcon message={fatal} />
          ) : null}
        </Col>

        <Col xs={24} lg={12}>
          <Card title="本次合并结果" size="small" data-testid="import-result">
            {done ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Row gutter={12}>
                  <Col span={6}>
                    <Statistic title="记录总数" value={total} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="新增" value={inserted} valueStyle={{ color: '#389e0d' }} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="覆盖旧结果" value={superseded} valueStyle={{ color: '#d46b08' }} />
                  </Col>
                  <Col span={6}>
                    <Statistic title="重复跳过" value={duplicated} />
                  </Col>
                </Row>
                {done.imported.some((i) => i.protectedFields.length) ? (
                  <Alert
                    type="info"
                    showIcon
                    message="部分字段已手工更正，离线包未回退这些内容"
                    description={
                      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                        {done.imported
                          .filter((i) => i.protectedFields.length)
                          .map((i) => (
                            <li key={i.inspectionId}>
                              {i.code}：{i.protectedFields.join('、')}
                            </li>
                          ))}
                      </ul>
                    }
                  />
                ) : null}
                {done.rejected.length ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={`${done.rejected.length} 条坏记录已隔离，其余记录正常入库`}
                  />
                ) : (
                  <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="全部记录通过校验" />
                )}
                <Typography.Text type="secondary" className="gb-muted">
                  核验记录变化后，相关整改条目与通行路线已失效重算，原因可在整改清单与通行路线页查看。
                </Typography.Text>
              </Space>
            ) : (
              <Empty description="合并完成后在此展示结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>

      {done && done.rejected.length ? (
        <Card title="坏记录明细（已隔离、未入库）" size="small" style={{ marginTop: 16 }}>
          <Table<RejectedRecord>
            rowKey={(r) => `${r.index}`}
            size="small"
            pagination={false}
            dataSource={done.rejected}
            columns={rejectedColumns}
          />
        </Card>
      ) : null}

      <Card title="导入检查点（失败后从断点恢复）" size="small" style={{ marginTop: 16 }}>
        {checkpoints.length ? (
          <Table<ImportCheckpoint>
            rowKey="batchId"
            size="small"
            pagination={{ pageSize: 6, hideOnSinglePage: true }}
            dataSource={checkpoints}
            columns={cpColumns}
          />
        ) : (
          <Empty description="暂无检查点记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </div>
  );
}
