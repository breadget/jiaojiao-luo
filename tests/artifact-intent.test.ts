import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isArtifactGenerationRequest } from '@/lib/artifact-intent';

describe('文件生成意图路由', () => {
  it('识别中英文的可下载产物请求', () => {
    for (const message of [
      '生成一个pdf，在里面写helloworld',
      '帮我制作一份 PPT',
      '把结果导出成 Excel 表格',
      '创建一个可下载的报告',
      'Generate a PDF with Hello World in it',
    ]) {
      assert.equal(isArtifactGenerationRequest(message), true, message);
    }
  });

  it('不误伤普通问答和否定指令', () => {
    for (const message of [
      'PDF 是什么？',
      '帮我总结这段文字',
      '不要生成 PDF，只说明方法',
      'Do not generate a PDF; explain the steps only',
    ]) {
      assert.equal(isArtifactGenerationRequest(message), false, message);
    }
  });
});
