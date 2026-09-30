import { useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { EditOutlined, PlusOutlined, SaveOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import MapPanel from '../components/common/MapPanel';
import MeasureInput from '../components/common/MeasureInput';
import StatusBadge from '../components/common/StatusBadge';
import FacilityIcon from '../components/common/FacilityIcon';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import {
  OCCUPIED_LEVELS,
  type Inspection,
  type InspectionCorrection,
  type OccupiedLevel,
} from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import { judgeInspection } from '../utils/routeCheck';
import { addDays, isOverdue, todayStr } from '../utils/format';

interface InlineInspection {
  date: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  problem: string;
}

export default function PointDetail() {
  const { id = '' } = useParams();
  const { message } = App.useApp();
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const loaded = usePointStore((s) => s.loaded);
  const addInspection = usePointStore((s) => s.addInspection);
  const addRectify = usePointStore((s) => s.addRectify);
  const correctInspection = usePointStore((s) => s.correctInspection);

  const point = useMemo(() => points.find((p) => p.id === id), [points, id]);
  const history = useMemo(
    () =>
      inspections
        .filter((i) => i.pointId === id)
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    [inspections, id],
  );
  const plans = useMemo(
    () =>
      rectifies
        .filter((r) => r.pointId === id && !r.invalid)
        .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    [rectifies, id],
  );
  const invalidPlans = useMemo(
    () =>
      rectifies
        .filter((r) => r.pointId === id && r.invalid)
        .sort((a, b) =>
          (a.invalidReason?.at ?? '') < (b.invalidReason?.at ?? '') ? 1 : -1,
        ),
    [rectifies, id],
  );

  const [form, setForm] = useState<InlineInspection>(() => ({
    date: todayStr(),
    inspector: '督导员 李维',
    slope: 2.5,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  }));
  const [saving, setSaving] = useState(false);

  /** 手工更正弹窗 */
  const [correcting, setCorrecting] = useState<Inspection | null>(null);
  const [correction, setCorrection] = useState<InspectionCorrection>({});
  const [correctingSaving, setCorrectingSaving] = useState(false);

  const openCorrection = (row: Inspection) => {
    setCorrecting(row);
    setCorrection({
      slope: row.slope,
      clearWidth: row.clearWidth,
      hasHandrail: row.hasHandrail,
      tactileContinuous: row.tactileContinuous,
      occupied: row.occupied,
      problem: row.problem,
    });
  };

  const handleCorrection = async () => {
    if (!correcting) return;
    setCorrectingSaving(true);
    try {
      await correctInspection(correcting.id, correction);
      message.success('已按更正内容重判结论并联动重算整改与路线（更正字段不再被离线包回退）');
      setCorrecting(null);
    } catch (e) {
      message.error(`手工更正失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCorrectingSaving(false);
    }
  };

  const judgement = useMemo(
    () =>
      judgeInspection({
        slope: form.slope,
        clearWidth: form.clearWidth,
        hasHandrail: form.hasHandrail,
        tactileContinuous: form.tactileContinuous,
        occupied: form.occupied,
      }),
    [form],
  );

  if (!loaded) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary">正在读取本地点位数据…</Typography.Text>
        </div>
      </div>
    );
  }

  if (!point) {
    return (
      <EmptyState
        title={`未找到点位 ${id}`}
        description="该点位可能已被删除，请返回总览重新选择"
        extra={
          <Link to="/">
            <Button type="primary">返回核验总览</Button>
          </Link>
        }
      />
    );
  }

  const handleSaveInspection = async () => {
    setSaving(true);
    try {
      await addInspection({
        pointId: point.id,
        date: form.date || todayStr(),
        inspector: form.inspector.trim() || '未署名督导员',
        slope: form.slope,
        clearWidth: form.clearWidth,
        hasHandrail: form.hasHandrail,
        tactileContinuous: form.tactileContinuous,
        occupied: form.occupied,
        conclusion: judgement.conclusion,
        problem: form.problem.trim(),
      });
      message.success(`已新增核验记录（${judgement.conclusion}）`);
      setForm((cur) => ({ ...cur, problem: '', date: todayStr() }));
    } catch (e) {
      message.error(`核验记录保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateRectify = async () => {
    try {
      await addRectify({
        pointId: point.id,
        requirement: judgement.conclusion === '合格' ? '保持现状，纳入下一轮复核' : judgement.reasons.join('；'),
        unit: point.maintainUnit,
        deadline: addDays(todayStr(), 30),
        recheckDate: '',
        status: '待整改',
      });
      message.success('已生成整改条目');
    } catch (e) {
      message.error(`整改条目创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const inspectionColumns: ColumnsType<Inspection> = [
    { title: '核验日期', dataIndex: 'date', width: 110, sorter: (a, b) => (a.date < b.date ? -1 : 1) },
    {
      title: '采集时间',
      dataIndex: 'collectedAt',
      width: 150,
      render: (v: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{v ? v.replace('T', ' ').slice(0, 16) : '—'}</span>
          <Space size={4} wrap>
            {row.source === 'offline' ? <Tag color="geekblue">离线包</Tag> : <Tag>现场录入</Tag>}
            {row.manualFields.length ? <Tag color="purple">已手工更正</Tag> : null}
          </Space>
        </Space>
      ),
    },
    { title: '核验人', dataIndex: 'inspector', width: 120 },
    { title: '坡度', dataIndex: 'slope', width: 70, render: (v: number) => `${v}%` },
    { title: '净宽', dataIndex: 'clearWidth', width: 80, render: (v: number) => `${v} cm` },
    { title: '扶手', dataIndex: 'hasHandrail', width: 60, render: (v: boolean) => (v ? '有' : '无') },
    {
      title: '盲道',
      dataIndex: 'tactileContinuous',
      width: 70,
      render: (v: boolean) => (v ? '连续' : '断续'),
    },
    { title: '占用情况', dataIndex: 'occupied', width: 90 },
    {
      title: '结论',
      dataIndex: 'conclusion',
      width: 110,
      render: (v: string, row) =>
        row.superseded ? (
          <Tooltip title={`已被采集时间更晚的核验（${row.supersededById}）覆盖，记录保留备查`}>
            <Space direction="vertical" size={0}>
              <StatusBadge value={v} kind="conclusion" />
              <Tag color="default" style={{ marginInlineEnd: 0 }}>
                已覆盖
              </Tag>
            </Space>
          </Tooltip>
        ) : (
          <StatusBadge value={v} kind="conclusion" />
        ),
    },
    {
      title: '问题描述',
      dataIndex: 'problem',
      ellipsis: true,
      render: (v: string) => v || <Typography.Text type="secondary">无</Typography.Text>,
    },
    {
      title: '操作',
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          icon={<EditOutlined />}
          onClick={() => openCorrection(row)}
          data-testid={`correct-${row.id}`}
        >
          更正
        </Button>
      ),
    },
  ];

  const rectifyColumns: ColumnsType<RectifyPlan> = [
    { title: '整改要求', dataIndex: 'requirement', ellipsis: true },
    {
      title: '来源',
      dataIndex: 'source',
      width: 90,
      render: (v: string) => (v === 'auto' ? <Tag color="geekblue">核验联动</Tag> : <Tag>人工登记</Tag>),
    },
    { title: '责任单位', dataIndex: 'unit', width: 150 },
    {
      title: '整改期限',
      dataIndex: 'deadline',
      width: 130,
      render: (d: string, row) =>
        isOverdue(d, row.status) ? (
          <Space size={4}>
            {d}
            <Tag color="error">逾期</Tag>
          </Space>
        ) : (
          d
        ),
    },
    {
      title: '复检日期',
      dataIndex: 'recheckDate',
      width: 120,
      render: (v: string) => v || <Typography.Text type="secondary">未复检</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => <StatusBadge value={v} kind="rectify" />,
    },
  ];

  const latest = history.find((i) => !i.superseded);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <Space size={10} align="center">
            <FacilityIcon type={point.facilityType} size={26} />
            <h1 className="gb-page-title" data-testid="point-name">
              {point.name}
            </h1>
            <StatusBadge value={latest?.conclusion ?? '未核验'} kind="conclusion" bordered />
          </Space>
          <Typography.Text type="secondary">
            {point.code} · {point.district} · {point.location || '未填写所在道路或建筑'}
          </Typography.Text>
        </div>
        <Space>
          <Link to="/map">
            <Button>在地图中查看</Button>
          </Link>
          <Link to="/points/new">
            <Button type="primary" icon={<PlusOutlined />}>
              登记新点位
            </Button>
          </Link>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <MapPanel points={[point]} selectedId={point.id} height={380} title="点位定位与周边" />
        </Col>
        <Col xs={24} lg={10}>
          <Card title="点位属性" size="small">
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="点位编号">{point.code}</Descriptions.Item>
              <Descriptions.Item label="设施类型">
                <FacilityIcon type={point.facilityType} withLabel />
              </Descriptions.Item>
              <Descriptions.Item label="行政区">{point.district}</Descriptions.Item>
              <Descriptions.Item label="所在道路或建筑">{point.location || '—'}</Descriptions.Item>
              <Descriptions.Item label="建成年代">{point.builtYear} 年</Descriptions.Item>
              <Descriptions.Item label="养护单位">{point.maintainUnit}</Descriptions.Item>
              <Descriptions.Item label="经纬度">
                {point.lng.toFixed(6)}, {point.lat.toFixed(6)}
              </Descriptions.Item>
              <Descriptions.Item label="核验次数">{history.length} 次</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <Card
            title="核验历史"
            size="small"
            extra={
              <Typography.Text type="secondary" className="gb-muted">
                共 {history.length} 条
              </Typography.Text>
            }
          >
            {history.length ? (
              <Table<Inspection>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 5, hideOnSinglePage: true }}
                dataSource={history}
                columns={inspectionColumns}
              />
            ) : (
              <EmptyState title="暂无核验记录" description="在右侧录入实测值即可生成第一条记录" compact />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="就地新增核验" size="small">
            <Form layout="vertical">
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <MeasureInput
                    label="坡度"
                    value={form.slope}
                    onChange={(v) => setForm((c) => ({ ...c, slope: v }))}
                    unit="%"
                    pass={5}
                    fail={8}
                    direction="max"
                    min={0}
                    max={100}
                    hint="纵坡不应大于 5%，超过 8% 判定不合格"
                  />
                </Col>
                <Col xs={24} md={12}>
                  <MeasureInput
                    label="净宽"
                    value={form.clearWidth}
                    onChange={(v) => setForm((c) => ({ ...c, clearWidth: v }))}
                    unit="cm"
                    pass={120}
                    fail={90}
                    direction="min"
                    min={0}
                    max={500}
                    step={1}
                    hint="净宽不应小于 120cm，小于 90cm 判定不合格"
                  />
                </Col>
                <Col xs={12} md={8}>
                  <Form.Item label="扶手">
                    <Switch
                      checked={form.hasHandrail}
                      onChange={(v) => setForm((c) => ({ ...c, hasHandrail: v }))}
                      checkedChildren="有"
                      unCheckedChildren="无"
                      data-testid="detail-switch-handrail"
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={8}>
                  <Form.Item label="盲道连续">
                    <Switch
                      checked={form.tactileContinuous}
                      onChange={(v) => setForm((c) => ({ ...c, tactileContinuous: v }))}
                      checkedChildren="连续"
                      unCheckedChildren="断续"
                      data-testid="detail-switch-tactile"
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item label="被占用情况">
                    <Select
                      value={form.occupied}
                      onChange={(v) => setForm((c) => ({ ...c, occupied: v }))}
                      options={OCCUPIED_LEVELS.map((o) => ({ value: o, label: o }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="核验人">
                    <Input
                      id="detail-inspector"
                      value={form.inspector}
                      onChange={(e) => setForm((c) => ({ ...c, inspector: e.target.value }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="结论建议">
                    <Space data-testid="detail-suggested-conclusion">
                      <StatusBadge value={judgement.conclusion} kind="conclusion" bordered />
                      <Typography.Text type="secondary" className="gb-muted">
                        {judgement.reasons[0]}
                      </Typography.Text>
                    </Space>
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="问题描述">
                    <Input.TextArea
                      id="detail-problem"
                      rows={2}
                      value={form.problem}
                      onChange={(e) => setForm((c) => ({ ...c, problem: e.target.value }))}
                      placeholder="记录实测中发现的问题"
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={handleSaveInspection}
                  data-testid="save-inspection"
                >
                  保存核验
                </Button>
                <Button icon={<ReloadOutlined />} onClick={handleCreateRectify} data-testid="gen-rectify">
                  生成整改条目
                </Button>
              </Space>
            </Form>
          </Card>
        </Col>
      </Row>

      <Card title="整改跟踪" size="small" style={{ marginTop: 16 }}>
        <Divider style={{ margin: '0 0 12px' }} />
        {plans.length ? (
          <Table<RectifyPlan> rowKey="id" size="small" pagination={false} dataSource={plans} columns={rectifyColumns} />
        ) : (
          <EmptyState
            title="暂无有效整改条目"
            description="核验结论为不合格时会自动生成整改条目；被新核验失效的旧条目见下方"
            extra={
              <Button onClick={handleCreateRectify} data-testid="empty-gen-rectify">
                手动生成整改条目
              </Button>
            }
            compact
          />
        )}
      </Card>

      {invalidPlans.length ? (
        <Card
          size="small"
          style={{ marginTop: 16 }}
          title={
            <Space size={8}>
              <span>已失效整改条目（旧记录保留）</span>
              <Tag color="default">{invalidPlans.length}</Tag>
            </Space>
          }
        >
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {invalidPlans.map((r) => (
              <Alert
                key={r.id}
                type="warning"
                showIcon
                data-testid="invalid-rectify"
                message={
                  <Space size={8} wrap>
                    <StatusBadge value={r.status} kind="rectify" />
                    <Typography.Text delete type="secondary">
                      {r.requirement}
                    </Typography.Text>
                  </Space>
                }
                description={r.invalidReason?.reason}
              />
            ))}
          </Space>
        </Card>
      ) : null}

      <Modal
        title={correcting ? `手工更正核验 · ${correcting.date}` : '手工更正核验'}
        open={Boolean(correcting)}
        onCancel={() => setCorrecting(null)}
        onOk={handleCorrection}
        confirmLoading={correctingSaving}
        okText="保存更正并重算"
        destroyOnClose
        width={640}
      >
        {correcting ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="更正后的字段会被标记为手工更正：之后同点位同日的离线核验包不再回退这些字段；结论按更正后实测值重判，并联动失效重算整改条目与通行路线。"
            />
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item label="坡度 %" style={{ marginBottom: 8 }}>
                  <InputNumber
                    min={0}
                    max={100}
                    step={0.1}
                    style={{ width: '100%' }}
                    value={correction.slope}
                    onChange={(v) => setCorrection((c) => ({ ...c, slope: Number(v ?? 0) }))}
                    data-testid="correct-slope"
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="净宽 cm" style={{ marginBottom: 8 }}>
                  <InputNumber
                    min={0}
                    max={500}
                    style={{ width: '100%' }}
                    value={correction.clearWidth}
                    onChange={(v) => setCorrection((c) => ({ ...c, clearWidth: Number(v ?? 0) }))}
                    data-testid="correct-width"
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="扶手" style={{ marginBottom: 8 }}>
                  <Switch
                    checked={correction.hasHandrail}
                    onChange={(v) => setCorrection((c) => ({ ...c, hasHandrail: v }))}
                    checkedChildren="有"
                    unCheckedChildren="无"
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="盲道连续" style={{ marginBottom: 8 }}>
                  <Switch
                    checked={correction.tactileContinuous}
                    onChange={(v) => setCorrection((c) => ({ ...c, tactileContinuous: v }))}
                    checkedChildren="连续"
                    unCheckedChildren="断续"
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="被占用情况" style={{ marginBottom: 8 }}>
                  <Select
                    style={{ width: '100%' }}
                    value={correction.occupied}
                    onChange={(v) => setCorrection((c) => ({ ...c, occupied: v }))}
                    options={OCCUPIED_LEVELS.map((o) => ({ value: o, label: o }))}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="问题描述" style={{ marginBottom: 0 }}>
              <Input.TextArea
                rows={2}
                value={correction.problem}
                onChange={(e) => setCorrection((c) => ({ ...c, problem: e.target.value }))}
                data-testid="correct-problem"
              />
            </Form.Item>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
