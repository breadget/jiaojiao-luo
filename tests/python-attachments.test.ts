import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PYTHON_ATTACHMENT_LIMITS,
  attachmentMimeType,
  isSupportedAttachment,
  mountNameFor,
  toAgentInputs,
  validateAttachments,
} from '@/lib/python-attachments';
import { PYTHON_MOUNT_NAME_PATTERN } from '@/lib/server/python-agent';

describe('使用端附件规则', () => {
  it('只接受受控扩展名，并与执行器侧的挂载名规则兼容', () => {
    assert.equal(isSupportedAttachment('sales.csv'), true);
    assert.equal(isSupportedAttachment('台账.XLSX'), true);
    assert.equal(isSupportedAttachment('合同.docx'), true);
    assert.equal(isSupportedAttachment('旧版合同.DOC'), true);
    assert.equal(isSupportedAttachment('方案.pptx'), true);
    assert.equal(isSupportedAttachment('旧版方案.ppt'), true);
    assert.equal(isSupportedAttachment('报告.pdf'), true);
    assert.equal(isSupportedAttachment('开放文档.odt'), true);
    assert.equal(isSupportedAttachment('截图.png'), true);
    assert.equal(isSupportedAttachment('photo.JPEG'), true);
    assert.equal(isSupportedAttachment('payload.exe'), false);
    assert.equal(isSupportedAttachment('archive.zip'), false);

    const mountNames = [
      mountNameFor(0, '销售数据.xlsx'),
      mountNameFor(1, 'a b.png'),
      mountNameFor(2, 'payload.exe'),
      mountNameFor(3, '季度复盘.pptx'),
    ];
    assert.deepEqual(mountNames, [
      'file-1.xlsx',
      'file-2.png',
      'file-3.txt',
      'file-4.pptx',
    ]);
    for (const name of mountNames) {
      assert.match(name, PYTHON_MOUNT_NAME_PATTERN);
    }
  });

  it('按个数、单文件大小和合计大小拒绝', () => {
    assert.equal(validateAttachments([{ name: 'a.csv', size: 10 }]).ok, true);
    assert.equal(validateAttachments([{ name: 'a.exe', size: 10 }]).ok, false);
    assert.equal(validateAttachments([{ name: 'a.csv', size: 0 }]).ok, false);
    assert.equal(
      validateAttachments([
        { name: 'a.csv', size: PYTHON_ATTACHMENT_LIMITS.fileBytes + 1 },
      ]).ok,
      false,
    );
    assert.equal(
      validateAttachments(
        Array.from(
          { length: PYTHON_ATTACHMENT_LIMITS.files + 1 },
          (_, index) => ({
            name: `f${index}.csv`,
            size: 1,
          }),
        ),
      ).ok,
      false,
    );
    assert.equal(
      validateAttachments(
        Array.from({ length: 5 }, (_, index) => ({
          name: `f${index}.csv`,
          size: 11 * 1024 * 1024,
        })),
      ).ok,
      false,
    );
  });

  it('生成给 /api/python/agent 的 inputs，展示名保留原始中文名', () => {
    const inputs = toAgentInputs([
      {
        fileId: `file_${'a'.repeat(32)}`,
        mountName: 'file-1.xlsx',
        name: '销售数据.xlsx',
        size: 2048,
      },
    ]);
    assert.deepEqual(inputs, [
      {
        fileId: `file_${'a'.repeat(32)}`,
        mountName: 'file-1.xlsx',
        displayName: '销售数据.xlsx',
        sizeBytes: 2048,
      },
    ]);
    assert.equal(
      attachmentMimeType('a.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.equal(attachmentMimeType('a.pdf'), 'application/pdf');
    assert.equal(
      attachmentMimeType('a.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});
