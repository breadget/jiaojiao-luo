/** No secrets or environment expressions: the clone mounts the credentialRef. */
export const RUNTIME_SOURCE = 'n8n-execution-data-v1';
export const RUNTIME_EVENTS_URL = 'http://127.0.0.1:3000/api/n8n/events';

export function bindingParameters(input: {
  workflowId: string;
  version: number;
  triggerName: string;
}) {
  return {
    method: 'POST',
    url: RUNTIME_EVENTS_URL,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={{ JSON.stringify({ source: ' +
      JSON.stringify(RUNTIME_SOURCE) +
      ', sourceSeq: 0, eventType: "execution.bound", workflowId: ' +
      JSON.stringify(input.workflowId) +
      ', graphVersion: ' +
      input.version +
      ', requestId: $json.requestId, sessionId: $json.sessionId, executionId: String($execution.id),' +
      ' triggerNodeId: ' +
      JSON.stringify(input.triggerName) +
      ' }) }}',
    options: {
      timeout: 10000,
      redirect: { redirect: { followRedirects: false } },
      response: {
        response: {
          fullResponse: true,
          neverError: true,
          responseFormat: 'json',
        },
      },
    },
  };
}

export function bindingGuardCode(inputName: string): string {
  return [
    'const response = $input.first().json;',
    'if (response.statusCode !== 200 || response.body?.ok !== true || response.body?.bound !== true) {',
    '  throw new Error("BINDING_FAILED: execution.bound was not acknowledged");',
    '}',
    'return [{ json: $(' + JSON.stringify(inputName) + ').first().json }];',
  ].join('\n');
}
