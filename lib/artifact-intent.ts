/**
 * 识别「请直接生成可下载文件」的意图。
 *
 * 这里只做保守路由：同时出现生成动作和文件类型才命中，
 * 避免把「PDF 是什么」之类普通问答送进执行器。
 */
const CREATE_ACTION =
  /(?:生成|创建|制作|导出|输出|写入|写成|保存(?:成|为)?|整理成|转换?(?:成|为)|转成|转为|打包成|给我做|帮我做|generate|create|make|export|render|convert|build|save\s+as)/i;

const ARTIFACT_TYPE =
  /(?:\b(?:pdf|docx?|word|pptx?|powerpoint|xlsx?|excel|csv|json|txt|png|jpe?g)\b|(?:可下载的?)?(?:文件|文档|表格|电子表格|工作簿|幻灯片|演示文稿|报告|图表|图片))/i;

const NEGATED_CREATE =
  /(?:(?:不要|不必|无需|不用|别)\s*(?:帮我|给我|再)?\s*(?:生成|创建|制作|导出|输出|保存|转换|转成)|\b(?:do\s+not|don't|dont|no\s+need\s+to)\s+(?:generate|create|make|export|render|convert|build))/i;

export function isArtifactGenerationRequest(message: string): boolean {
  const normalized = message.trim();
  if (!normalized || NEGATED_CREATE.test(normalized)) return false;
  return CREATE_ACTION.test(normalized) && ARTIFACT_TYPE.test(normalized);
}
