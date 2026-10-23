import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXECUTOR_LIMITS,
  PYTHON_EXECUTOR_PROTOCOL,
  ToolRequestError,
  inputMimeType,
  normalizedRequestHash,
  validateInputBytes,
  validateRunPythonRequest,
} from '@/services/python-executor/protocol';

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocol: PYTHON_EXECUTOR_PROTOCOL,
    task_id: 'task_123',
    idempotency_key: 'task_123:attempt:1',
    attempt: 1,
    code: 'print(1)',
    input_files: [],
    timeout_seconds: 30,
    ...overrides,
  };
}

function errorCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (cause) {
    assert.ok(cause instanceof ToolRequestError);
    return cause.code;
  }
}

describe('run_python v1 request validation', () => {
  it('normalizes a valid request and defaults the timeout', () => {
    const parsed = validateRunPythonRequest({
      ...request(),
      timeout_seconds: undefined,
    });
    assert.equal(parsed.timeout_seconds, EXECUTOR_LIMITS.timeoutSeconds);
    assert.equal(parsed.protocol, PYTHON_EXECUTOR_PROTOCOL);
    assert.equal(parsed.profile, 'short');
  });

  it('applies profile-specific timeout ceilings', () => {
    const long = validateRunPythonRequest(
      request({ profile: 'long', timeout_seconds: 600 }),
    );
    assert.equal(long.profile, 'long');
    assert.equal(long.timeout_seconds, 600);
    assert.equal(
      errorCode(() =>
        validateRunPythonRequest(
          request({ profile: 'short', timeout_seconds: 31 }),
        ),
      ),
      'INVALID_REQUEST',
    );
    assert.equal(
      errorCode(() =>
        validateRunPythonRequest(
          request({ profile: 'long', timeout_seconds: 601 }),
        ),
      ),
      'INVALID_REQUEST',
    );
  });

  it('rejects unknown fields and path-shaped mount names', () => {
    assert.equal(
      errorCode(() => validateRunPythonRequest(request({ shell: 'id' }))),
      'INVALID_REQUEST',
    );
    assert.equal(
      errorCode(() =>
        validateRunPythonRequest(
          request({
            input_files: [
              {
                file_id: `file_${'a'.repeat(32)}`,
                mount_name: '../data.csv',
              },
            ],
          }),
        ),
      ),
      'INVALID_REQUEST',
    );
  });

  it('accepts office, spreadsheet, PDF and image inputs but rejects unknown types', () => {
    const accepted = validateRunPythonRequest(
      request({
        input_files: [
          { file_id: `file_${'a'.repeat(32)}`, mount_name: 'book.xlsx' },
          { file_id: `file_${'b'.repeat(32)}`, mount_name: 'chart.png' },
          { file_id: `file_${'c'.repeat(32)}`, mount_name: 'brief.pdf' },
          { file_id: `file_${'d'.repeat(32)}`, mount_name: 'deck.pptx' },
          { file_id: `file_${'e'.repeat(32)}`, mount_name: 'letter.doc' },
        ],
      }),
    );
    assert.equal(accepted.input_files.length, 5);
    assert.equal(
      errorCode(() =>
        validateRunPythonRequest(
          request({
            input_files: [
              { file_id: `file_${'c'.repeat(32)}`, mount_name: 'payload.exe' },
            ],
          }),
        ),
      ),
      'INVALID_REQUEST',
    );
  });

  it('validates uploaded bytes by type: UTF-8 for text, magic for binary', () => {
    const encoder = new TextEncoder();
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
    const xlsx = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const ole = Uint8Array.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00,
    ]);
    const rtf = encoder.encode('{\\rtf1 test}');

    assert.equal(
      validateInputBytes('data.csv', encoder.encode('a\n1\n')),
      null,
    );
    assert.equal(validateInputBytes('book.xlsx', xlsx), null);
    assert.equal(validateInputBytes('chart.png', png), null);
    assert.equal(validateInputBytes('photo.jpeg', jpeg), null);
    assert.equal(validateInputBytes('report.pdf', pdf), null);
    assert.equal(validateInputBytes('notes.rtf', rtf), null);
    assert.equal(validateInputBytes('deck.pptx', xlsx), null);
    assert.equal(validateInputBytes('legacy.doc', ole), null);
    assert.equal(validateInputBytes('legacy.ppt', ole), null);
    assert.equal(validateInputBytes('legacy.xls', ole), null);
    assert.match(validateInputBytes('chart.png', jpeg) ?? '', /PNG signature/);
    assert.match(validateInputBytes('book.xlsx', png) ?? '', /zip container/);
    assert.match(validateInputBytes('photo.jpg', png) ?? '', /JPEG signature/);
    assert.match(validateInputBytes('report.pdf', png) ?? '', /PDF signature/);
    assert.match(validateInputBytes('legacy.doc', xlsx) ?? '', /OLE compound/);
    assert.match(
      validateInputBytes('data.csv', Uint8Array.from([0xff, 0xfe, 0x00])) ?? '',
      /UTF-8/,
    );
    assert.equal(
      inputMimeType('book.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('rejects duplicate mount names case-insensitively', () => {
    assert.equal(
      errorCode(() =>
        validateRunPythonRequest(
          request({
            input_files: [
              {
                file_id: `file_${'a'.repeat(32)}`,
                mount_name: 'Data.csv',
              },
              {
                file_id: `file_${'b'.repeat(32)}`,
                mount_name: 'data.csv',
              },
            ],
          }),
        ),
      ),
      'INVALID_REQUEST',
    );
  });

  it('rejects oversized code and attempts outside 1..3', () => {
    assert.equal(
      errorCode(() =>
        validateRunPythonRequest(
          request({ code: 'x'.repeat(EXECUTOR_LIMITS.codeBytes + 1) }),
        ),
      ),
      'INVALID_REQUEST',
    );
    assert.equal(
      errorCode(() => validateRunPythonRequest(request({ attempt: 4 }))),
      'INVALID_REQUEST',
    );
  });

  it('produces the same request hash regardless of input file order', () => {
    const left = validateRunPythonRequest(
      request({
        input_files: [
          { file_id: `file_${'a'.repeat(32)}`, mount_name: 'a.csv' },
          { file_id: `file_${'b'.repeat(32)}`, mount_name: 'b.json' },
        ],
      }),
    );
    const right = validateRunPythonRequest(
      request({ input_files: [...left.input_files].reverse() }),
    );
    assert.equal(normalizedRequestHash(left), normalizedRequestHash(right));
  });
});
