import type { ProgramInputField } from './types';

export const PROGRAM_MAX_INPUT_BYTES = 32 * 1024;
export const PROGRAM_MAX_OUTPUT_BYTES = 256 * 1024;
const forbiddenParts = new Set(['__proto__', 'prototype', 'constructor']);
const referencePattern =
  /^(\$json|json|input|nodes|steps)(?:\.[A-Za-z0-9_-]+)*$/;

export type ValueContext = {
  input: Record<string, unknown>;
  current: unknown;
  outputs: Map<string, unknown>;
};

function pathParts(value: string): string[] {
  if (!referencePattern.test(value))
    throw new Error(`不支持的变量引用：${value}`);
  const parts = value.split('.');
  if (parts.some((part) => forbiddenParts.has(part)))
    throw new Error('变量引用不能访问原型。');
  return parts;
}

function lookup(value: unknown, parts: string[], reference: string): unknown {
  let cursor = value;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) {
      throw new Error(`变量 ${reference} 在当前执行路径中没有值。`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function readReference(reference: string, context: ValueContext): unknown {
  const [root, ...parts] = pathParts(reference);
  if (root === 'input') return lookup(context.input, parts, reference);
  if (root === '$json' || root === 'json')
    return lookup(context.current, parts, reference);
  const nodeId = parts.shift();
  if (!nodeId || !context.outputs.has(nodeId))
    throw new Error(`变量 ${reference} 的节点尚未执行。`);
  if (root === 'steps' && parts[0] === 'output') parts.shift();
  return lookup(context.outputs.get(nodeId), parts, reference);
}

export function validateValueTemplate(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error('字段映射嵌套不能超过 12 层。');
  if (typeof value === 'string') {
    if (value.length > 16_000)
      throw new Error('单个配置文本最多 16000 个字符。');
    if (value.startsWith('$json')) pathParts(value);
    const refs = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)];
    for (const match of refs) pathParts(match[1].trim());
    if (value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, '').includes('{{')) {
      throw new Error(
        '变量模板格式无效；只支持 {{input.field}}、{{$json.field}} 和 {{nodes.id.field}}。',
      );
    }
  } else if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('字段映射数组最多 100 项。');
    value.forEach((item) => validateValueTemplate(item, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenParts.has(key))
        throw new Error('字段映射不能写入原型属性。');
      validateValueTemplate(child, depth + 1);
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('字段映射数字必须有限。');
  }
}

export function resolveValue(value: unknown, context: ValueContext): unknown {
  validateValueTemplate(value);
  if (typeof value === 'string') {
    if (value.startsWith('$json')) return readReference(value, context);
    const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (exact) return readReference(exact[1].trim(), context);
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, reference: string) => {
      const resolved = readReference(reference.trim(), context);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value))
    return value.map((item) => resolveValue(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolveValue(child, context),
      ]),
    );
  }
  return value;
}

export function parseMapping(value: unknown): Record<string, unknown> {
  const mapping = typeof value === 'string' ? JSON.parse(value) : value;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('Transform 的 mapping 必须是 JSON 对象，不能是代码。');
  }
  validateValueTemplate(mapping);
  return mapping as Record<string, unknown>;
}

export function normalizeProgramArtifact(value: unknown): {
  name: string;
  mimeType: 'text/plain' | 'text/markdown';
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Output 产物必须是对象。');
  const artifact = value as Record<string, unknown>;
  if (
    Object.keys(artifact).some((key) => !['name', 'mimeType'].includes(key)) ||
    !['text/plain', 'text/markdown'].includes(String(artifact.mimeType)) ||
    typeof artifact.name !== 'string' ||
    !/^[A-Za-z0-9_\-\u4e00-\u9fff][A-Za-z0-9_.\-\u4e00-\u9fff]{0,119}$/.test(
      artifact.name,
    ) ||
    artifact.name.includes('..')
  )
    throw new Error(
      'Output 产物需要安全文件名和 text/plain 或 text/markdown 类型。',
    );
  return {
    name: artifact.name,
    mimeType: artifact.mimeType as 'text/plain' | 'text/markdown',
  };
}

type Operator =
  | '==='
  | '!=='
  | '=='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'contains'
  | 'exists';
type Predicate = { left: unknown; operator: Operator; right?: unknown };
const operators = new Set<Operator>([
  '===',
  '!==',
  '==',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  'contains',
  'exists',
]);

function operand(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('$json') || trimmed.startsWith('{{')) {
    validateValueTemplate(trimmed);
    return trimmed;
  }
  if (/^'(?:[^'\\]|\\['\\])*'$/.test(trimmed))
    return trimmed.slice(1, -1).replace(/\\(['\\])/g, '$1');
  const parsed: unknown = JSON.parse(trimmed);
  if (
    parsed !== null &&
    !['string', 'number', 'boolean'].includes(typeof parsed)
  )
    throw new Error('条件只支持标量值。');
  return parsed;
}

export function parsePredicate(config: Record<string, unknown>): Predicate {
  if (config.operator !== undefined) {
    if (
      typeof config.operator !== 'string' ||
      !operators.has(config.operator as Operator)
    )
      throw new Error('Condition 的比较操作不受支持。');
    if (
      !Object.hasOwn(config, 'left') ||
      (config.operator !== 'exists' && !Object.hasOwn(config, 'right'))
    )
      throw new Error('Condition 需要明确的比较字段和值。');
    if (
      (config.left !== null && typeof config.left === 'object') ||
      (config.right !== null && typeof config.right === 'object')
    )
      throw new Error('Condition 只支持标量值或字段引用。');
    validateValueTemplate(config.left);
    validateValueTemplate(config.right);
    return {
      left: config.left,
      operator: config.operator as Operator,
      right: config.right,
    };
  }
  if (typeof config.expression !== 'string')
    throw new Error('Condition 需要比较条件。');
  const comparison = config.expression.match(
    /^\s*(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+?)\s*$/,
  );
  if (!comparison)
    throw new Error(
      'Condition 只支持字段与标量的单次比较，不能执行 JavaScript。',
    );
  return {
    left: operand(comparison[1]),
    operator: comparison[2] as Operator,
    right: operand(comparison[3]),
  };
}

export function evaluatePredicate(
  config: Record<string, unknown>,
  context: ValueContext,
): boolean {
  const predicate = parsePredicate(config);
  if (predicate.operator === 'exists') {
    try {
      const value = resolveValue(predicate.left, context);
      return value !== null && value !== undefined;
    } catch {
      return false;
    }
  }
  const left = resolveValue(predicate.left, context);
  const right = resolveValue(predicate.right, context);
  switch (predicate.operator) {
    case '===':
    case '==':
      return left === right;
    case '!==':
    case '!=':
      return left !== right;
    case 'contains':
      return (
        typeof left === 'string' &&
        typeof right === 'string' &&
        left.includes(right)
      );
    default:
      if (typeof left !== 'number' || typeof right !== 'number')
        throw new Error('大小比较需要两个数字。');
      if (predicate.operator === '>') return left > right;
      if (predicate.operator === '<') return left < right;
      if (predicate.operator === '>=') return left >= right;
      return left <= right;
  }
}

export function normalizeInputFields(value: unknown): ProgramInputField[] {
  if (value === undefined)
    return [
      { name: 'message', label: '输入内容', type: 'text', required: true },
    ];
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw new Error('Trigger 需要 1–32 个输入字段。');
  const names = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object')
      throw new Error('输入字段格式无效。');
    const field = item as ProgramInputField;
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.name) ||
      forbiddenParts.has(field.name) ||
      names.has(field.name)
    )
      throw new Error('输入字段名称必须唯一且只包含字母、数字、下划线。');
    names.add(field.name);
    if (!['text', 'number', 'boolean'].includes(field.type))
      throw new Error('输入字段只支持 text、number、boolean。');
    if (typeof field.label !== 'string' || field.label.length > 120)
      throw new Error('输入字段需要最多 120 字的名称。');
    if (field.required !== undefined && typeof field.required !== 'boolean')
      throw new Error('输入字段 required 必须是布尔值。');
    if (
      Object.hasOwn(field, 'default') &&
      ((field.type === 'text' && typeof field.default !== 'string') ||
        (field.type === 'number' &&
          (typeof field.default !== 'number' ||
            !Number.isFinite(field.default))) ||
        (field.type === 'boolean' && typeof field.default !== 'boolean'))
    )
      throw new Error('输入字段默认值的类型无效。');
    for (const bound of [field.min, field.max])
      if (
        bound !== undefined &&
        (typeof bound !== 'number' || !Number.isFinite(bound))
      )
        throw new Error('输入字段范围必须是有限数字。');
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    )
      throw new Error('输入字段范围无效。');
    const normalized: ProgramInputField = {
      name: field.name,
      label: field.label,
      type: field.type,
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {}),
    };
    if (field.default !== undefined)
      validateInputFields([normalized], { [field.name]: field.default });
    return normalized;
  });
}

export function validateInputFields(
  fields: ProgramInputField[],
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('程序输入必须是对象。');
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    PROGRAM_MAX_INPUT_BYTES
  )
    throw new Error('程序输入最多 32KB。');
  const input = value as Record<string, unknown>;
  const known = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(input))
    if (!known.has(key)) throw new Error(`未知输入字段：${key}`);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const content = Object.hasOwn(input, field.name)
      ? input[field.name]
      : field.default;
    if (content === undefined || content === '') {
      if (field.required) throw new Error(`请填写 ${field.label}。`);
      continue;
    }
    if (
      (field.type === 'text' && typeof content !== 'string') ||
      (field.type === 'number' &&
        (typeof content !== 'number' || !Number.isFinite(content))) ||
      (field.type === 'boolean' && typeof content !== 'boolean')
    )
      throw new Error(`${field.label} 的类型应为 ${field.type}。`);
    const extent =
      typeof content === 'string'
        ? content.length
        : typeof content === 'number'
          ? content
          : undefined;
    if (
      typeof content === 'string' &&
      (content.length > 16_000 || (field.required && !content.trim()))
    )
      throw new Error(`${field.label} 必须是非空且最多 16000 字的文本。`);
    if (
      extent !== undefined &&
      ((field.min !== undefined && extent < field.min) ||
        (field.max !== undefined && extent > field.max))
    )
      throw new Error(`${field.label} 超出允许范围。`);
    result[field.name] = content;
  }
  return result;
}
