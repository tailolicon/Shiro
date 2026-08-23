const SECRET_PATTERNS = Object.freeze([
  { re: /sk-[A-Za-z0-9_-]{12,}/g, keep: 3 },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, keep: 3 },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, keep: 4 },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, keep: 3 },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keep: 4 },
  { re: /\bhf_[A-Za-z0-9]{30,}\b/g, keep: 3 },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, keep: 6 },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/g, keep: 4 },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, keep: 3 },
  {
    re: /-----BEGIN(?:[A-Z0-9 ]*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END(?:[A-Z0-9 ]*)PRIVATE KEY(?: BLOCK)?-----/g,
    mask: '***PRIVATE KEY BLOCK***',
  },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, keep: 7 },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, mask: '***JWT***' },
  { re: /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, mask: '$1***@' },
  {
    re: /(['"]?)\b(api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)\1(\s*[=:]\s*['"]?)([^'"\s,;{}[\]().]{8,64})/gi,
    mask: '$1$2$1$3***',
  },
])

const SECRET_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SIGNING)/i
const BINARY_FIELDS = new Set(['data', 'image', 'image_url', 'audio', 'audio_url'])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function environmentRules(env) {
  const rules = []
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_NAME.test(name) || typeof value !== 'string' || value.length < 8) continue
    rules.push({ re: new RegExp(escapeRegExp(value), 'g'), mask: '***' })
  }
  return rules
}

function applyRules(text, rules) {
  let output = text
  for (const rule of rules) {
    if (rule.keep === undefined) {
      output = output.replace(rule.re, rule.mask ?? '***')
    } else {
      output = output.replace(rule.re, match => `${match.slice(0, rule.keep)}***`)
    }
  }
  return output
}

export function createSecretRedactor(env = process.env) {
  const rules = [...SECRET_PATTERNS, ...environmentRules(env)]
  const visit = (value, depth = 0, preserveBinary = false) => {
    if (depth > 12 || value === null || value === undefined) return value
    if (typeof value === 'string') return preserveBinary ? value : applyRules(value, rules)
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1))
    if (typeof value !== 'object') return value
    const binaryBlock = value.type === 'image' || value.type === 'image_url' || value.type === 'audio'
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      visit(item, depth + 1, binaryBlock && BINARY_FIELDS.has(key)),
    ]))
  }
  return visit
}

export const redactSecrets = createSecretRedactor()
