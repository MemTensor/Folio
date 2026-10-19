const path = require('node:path');
const { readJSON, writeJSON } = require('./state.cjs');
const fail = (message) => Object.assign(Error(message), { code: 'AGENT_CONFIG' });
function apiURL(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    )
      throw Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw fail('API 地址需要使用 HTTPS；本机服务可以使用 HTTP。');
  }
}
class AgentSettings {
  constructor(dataDir, { encrypt, decrypt } = {}) {
    this.file = path.join(dataDir, 'agent', 'provider.json');
    this.encrypt = encrypt;
    this.decrypt = decrypt;
  }
  async data() {
    return (await readJSON(this.file, {})) || {};
  }
  async status() {
    const saved = await this.data();
    return {
      provider: saved.provider === 'api' ? 'api' : 'chatgpt',
      baseURL: saved.api?.baseURL || 'https://api.openai.com/v1',
      model: saved.api?.model || '',
      hintModel: saved.api?.hintModel || '',
      imageInput: saved.api?.imageInput === true,
      hasKey: !!saved.api?.credential,
      configured: !!saved.api?.model,
    };
  }
  async configure(input) {
    if (!input || !['chatgpt', 'api'].includes(input.provider)) throw fail('Agent 接入设置无效。');
    if (input.imageInput !== undefined && typeof input.imageInput !== 'boolean')
      throw fail('Agent 接入设置无效。');
    const saved = await this.data();
    let api = saved.api || {};
    if (input.provider === 'api') {
      if (
        typeof input.baseURL !== 'string' ||
        input.baseURL.length > 2048 ||
        typeof input.model !== 'string' ||
        !input.model.trim() ||
        input.model.length > 200 ||
        /[\r\n\0]/.test(input.model)
      )
        throw fail('请填写 API 地址和模型名称。');
      const baseURL = apiURL(input.baseURL.trim());
      const hintModel = input.hintModel === undefined ? api.hintModel || '' : input.hintModel;
      if (typeof hintModel !== 'string' || hintModel.length > 200 || /[\r\n\0]/.test(hintModel))
        throw fail('建议模型名称无效。');
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname);
      const key = input.apiKey;
      if (
        key !== undefined &&
        (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n\0]/.test(key))
      )
        throw fail('API Key 格式无效。');
      if (api.baseURL && baseURL !== api.baseURL && !key && !local)
        throw fail('修改 API 地址时，请重新填写对应的 API Key。');
      let credential = api.baseURL && baseURL !== api.baseURL && !key ? undefined : api.credential;
      if (key) {
        if (!this.encrypt) throw fail('系统安全存储不可用，暂时无法保存 API Key。');
        credential = await this.encrypt(key.trim());
      }
      if (!credential && !local) throw fail('请填写 API Key。');
      api = {
        baseURL,
        model: input.model.trim(),
        hintModel: hintModel.trim(),
        imageInput:
          input.imageInput === undefined ? api.imageInput === true : input.imageInput === true,
        ...(credential ? { credential } : {}),
      };
    }
    await writeJSON(this.file, { provider: input.provider, api });
    return this.status();
  }
  async credentials() {
    const saved = await this.data();
    if (saved.provider !== 'api' || !saved.api?.model) throw fail('请先在 Agent 设置中配置 API。');
    let apiKey = null;
    if (saved.api.credential) {
      if (!this.decrypt) throw fail('系统安全存储不可用，暂时无法读取 API Key。');
      try {
        apiKey = await this.decrypt(saved.api.credential);
      } catch {
        throw fail('API Key 无法读取，请在设置中重新填写。');
      }
    }
    return {
      baseURL: apiURL(saved.api.baseURL),
      model: saved.api.model,
      imageInput: saved.api.imageInput === true,
      apiKey,
    };
  }
}
module.exports = { AgentSettings, apiURL };
