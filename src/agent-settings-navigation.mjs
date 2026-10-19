/** Only known configuration failures should offer a settings shortcut. */
const fields = new Map([
  ['API 授权失败，请在设置中检查 API Key。', 'key'],
  ['请填写 API Key。', 'key'],
  ['API Key 无法读取，请在设置中重新填写。', 'key'],
  ['API Key 格式无效。', 'key'],
  ['修改 API 地址时，请重新填写对应的 API Key。', 'key'],
  ['API 地址需要使用 HTTPS；本机服务可以使用 HTTP。', 'baseURL'],
  ['API 请求失败，请检查服务地址或稍后重试。', 'baseURL'],
  ['请填写 API 地址和模型名称。', 'model'],
  ['模型列表格式不兼容，请手动填写模型名称。', 'model'],
]);

/** @returns {import('./types').AgentSettingsTarget | null} */
export function problemSettingsTarget(message) {
  const field = fields.get(message);
  return field ? { provider: 'api', field: /** @type {'baseURL'|'key'|'model'} */ (field) } : null;
}

/** A background recovery or another provider becoming ready is not a completion action. */
export function settingsReturnReady(intent, provider, connection, apiSaved, busy) {
  return (
    !!intent &&
    !busy &&
    intent === provider &&
    (connection.provider || 'chatgpt') === provider &&
    connection.phase === 'ready' &&
    (provider !== 'api' || apiSaved)
  );
}
