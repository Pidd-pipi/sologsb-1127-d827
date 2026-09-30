import { useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DownloadOutlined,
  FileTextOutlined,
  UploadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import {
  buildSamplePackage,
  clearCheckpoint,
  importOfflinePackage,
  type FailedRecord,
  type ImportResult,
} from '../utils/offlineImport';

const { Dragger } = Upload;

export default function ImportOffline() {
  const { message } = App.useApp();
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<File | null>(null);

  const handleFile = (file: File) => {
    fileRef.current = file;
    setFileName(file.name);
    setResult(null);
    return false; // 阻止自动上传
  };

  const handleImport = async () => {
    if (!fileRef.current) {
      message.warning('请先选择离线核验包 JSON 文件');
      return;
    }
    setImporting(true);
    setProgress(0);
    setResult(null);
    try {
      const text = await fileRef.current.text();
      const raw = JSON.parse(text);
      const res = await importOfflinePackage(raw, fileRef.current.name, (done, total) => {
        setProgress(total ? Math.round((done / total) * 100) : 0);
      });
      setResult(res);
      if (res.failed === 0) {
        message.success(`导入完成：${res.imported} 条核验记录已入库`);
      } else {
        message.warning(`导入完成：${res.imported} 条成功，${res.failed} 条失败（不影响其他记录）`);
      }
    } catch (e) {
      message.error(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleDownloadSample = () => {
    const blob = new Blob([JSON.stringify(buildSamplePackage(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'offline-inspection-sample.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearCheckpoint = () => {
    clearCheckpoint();
    message.success('检查点已清除，下次导入将从头开始');
  };

  const failedColumns: ColumnsType<FailedRecord> = [
    { title: '序号', dataIndex: 'index', width: 80, render: (v: number) => v + 1 },
    { title: '点位编号', dataIndex: 'pointCode', width: 180 },
    {
      title: '失败原因',
      dataIndex: 'reason',
      render: (v: string) => <Typography.Text type="danger">{v}</Typography.Text>,
    },
  ];

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    maxCount: 1,
    beforeUpload: handleFile,
    onRemove: () => {
      fileRef.current = null;
      setFileName('');
    },
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">离线核验包导入</h1>
          <Typography.Text type="secondary">
            督导员离线核验后交回 JSON 包，逐记录校验合并：坏记录不挡住其他记录，导入失败后从检查点恢复。
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleDownloadSample}>
            下载示例包
          </Button>
          <Button icon={<WarningOutlined />} onClick={handleClearCheckpoint}>
            清除检查点
          </Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="选择核验包" size="small">
            <Dragger {...uploadProps} disabled={importing}>
              <p className="ant-upload-drag-icon">
                <UploadOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽 JSON 文件到此区域</p>
              <p className="ant-upload-hint">
                支持单条数组合法或带 inspections 字段的对象包；点位编号写错、值越界的记录会被标记但不影响其他记录。
              </p>
            </Dragger>
            {fileName ? (
              <Alert
                style={{ marginTop: 12 }}
                type="info"
                showIcon
                icon={<FileTextOutlined />}
                message={fileName}
                description="已选择文件，点击下方按钮开始导入"
              />
            ) : null}
            <Space style={{ marginTop: 16 }}>
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                loading={importing}
                onClick={handleImport}
                disabled={!fileName}
                data-testid="start-import"
              >
                开始导入
              </Button>
              {importing ? <Progress type="circle" percent={progress} size={48} /> : null}
            </Space>
          </Card>

          {result ? (
            <Card title="导入结果" size="small" style={{ marginTop: 16 }}>
              {result.resumed ? (
                <Alert
                  style={{ marginBottom: 12 }}
                  type="warning"
                  showIcon
                  message="已从检查点恢复"
                  description="检测到上次未完成的导入，已跳过已处理记录继续导入。"
                />
              ) : null}
              <Row gutter={16}>
                <Col span={8}>
                  <Statistic title="总记录数" value={result.total} suffix="条" />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="成功导入"
                    value={result.imported}
                    suffix="条"
                    valueStyle={{ color: '#389e0d' }}
                  />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="失败记录"
                    value={result.failed}
                    suffix="条"
                    valueStyle={{ color: result.failed ? '#cf1322' : undefined }}
                  />
                </Col>
              </Row>
              <Descriptions size="small" column={2} style={{ marginTop: 16 }}>
                <Descriptions.Item label="被覆盖旧记录">
                  <Tag color="orange">{result.superseded} 条</Tag>
                  <Typography.Text type="secondary" className="gb-muted">
                    同点位同日晚采集覆盖
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="手工更正保护">
                  <Tag color="blue">{result.protectedManual} 条</Tag>
                  <Typography.Text type="secondary" className="gb-muted">
                    手工更正未被回退
                  </Typography.Text>
                </Descriptions.Item>
              </Descriptions>
            </Card>
          ) : null}
        </Col>

        <Col xs={24} lg={10}>
          <Card title="失败记录明细" size="small">
            {result && result.failedRecords.length ? (
              <Table<FailedRecord>
                rowKey="index"
                size="small"
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                dataSource={result.failedRecords}
                columns={failedColumns}
              />
            ) : (
              <Typography.Text type="secondary">
                {result ? '全部记录导入成功，无失败记录。' : '导入后在此展示失败记录及原因。'}
              </Typography.Text>
            )}
          </Card>

          <Card title="合并与失效规则" size="small" style={{ marginTop: 16 }}>
            <Space direction="vertical" size={8}>
              <Typography.Text type="secondary">
                1. 逐记录校验：点位编号不存在、坡度/净宽越界等坏记录单独标记，不挡住其他记录。
              </Typography.Text>
              <Typography.Text type="secondary">
                2. 检查点恢复：导入中途失败后，下次导入同一包从已处理位置继续，不重复入库。
              </Typography.Text>
              <Typography.Text type="secondary">
                3. 同点位同一天多份核验：采集时间晚的覆盖旧结果；已手工更正的内容不回退。
              </Typography.Text>
              <Typography.Text type="secondary">
                4. 核验记录变更后，整改条目与通行路线自动失效重算并显示原因，旧记录保留。
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
