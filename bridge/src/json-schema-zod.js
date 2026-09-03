import { z } from 'zod'

// JSON Schema -> Zod, for the subset the engine's tool parameters actually use.
//
// The MCP SDK builds a tool's advertised inputSchema by converting a Zod shape,
// so a tool whose schema arrives as JSON Schema -- which is how every DSH plugin
// declares its parameters -- has to be converted before it can be registered.
//
// The conversion is deliberately lossy in ONE direction only: anything it does
// not understand becomes a permissive `z.unknown()` rather than a guess. A
// wrong-but-specific schema would make the connector reject calls the tool would
// have accepted; a permissive one only means the model sees less guidance, and
// the engine validates its own arguments anyway.

const PRIMITIVES = {
  string: () => z.string(),
  number: () => z.number(),
  integer: () => z.number().int(),
  boolean: () => z.boolean(),
  null: () => z.null(),
}

/** Both spellings: the standard `required: [...]`, and per-property `required: true`. */
function requiredNames(node) {
  const names = new Set(Array.isArray(node?.required) ? node.required.map(String) : [])
  for (const [key, value] of Object.entries(node?.properties ?? {})) {
    if (value !== null && typeof value === 'object' && value.required === true) names.add(key)
  }
  return names
}

function describe(schema, node) {
  const description = typeof node?.description === 'string' && node.description !== '' ? node.description : null
  return description === null ? schema : schema.describe(description.slice(0, 1024))
}

/**
 * @param node one JSON Schema node.
 * @param depth guards against a self-referential schema; past the limit the
 *   node becomes permissive instead of recursing forever.
 */
export function jsonSchemaToZod(node, depth = 0) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return z.unknown()
  if (depth > 8) return z.unknown()

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const literals = node.enum.map(value => z.literal(value))
    return describe(literals.length === 1 ? literals[0] : z.union(literals), node)
  }
  if (Object.hasOwn(node, 'const')) return describe(z.literal(node.const), node)

  const branches = node.anyOf ?? node.oneOf
  if (Array.isArray(branches) && branches.length > 0) {
    const options = branches.map(branch => jsonSchemaToZod(branch, depth + 1))
    return describe(options.length === 1 ? options[0] : z.union(options), node)
  }

  // A type union like ['string','null'] is the common nullable spelling.
  if (Array.isArray(node.type)) {
    const options = node.type.map(entry => jsonSchemaToZod({ ...node, type: entry }, depth + 1))
    return describe(options.length === 1 ? options[0] : z.union(options), node)
  }

  if (node.type === 'array') {
    const items = node.items === undefined ? z.unknown() : jsonSchemaToZod(node.items, depth + 1)
    let array = z.array(items)
    if (Number.isInteger(node.minItems)) array = array.min(node.minItems)
    if (Number.isInteger(node.maxItems)) array = array.max(node.maxItems)
    return describe(array, node)
  }

  if (node.type === 'object' || node.properties !== undefined) {
    const shape = jsonSchemaToZodShape(node, depth + 1)
    // additionalProperties defaults to permissive: a tool that accepts extra
    // keys must not have them stripped on the way through.
    const object = node.additionalProperties === false ? z.object(shape).strict() : z.object(shape).loose()
    return describe(object, node)
  }

  const primitive = PRIMITIVES[node.type]
  if (primitive === undefined) return describe(z.unknown(), node)
  let schema = primitive()
  if (node.type === 'string') {
    if (Number.isInteger(node.minLength)) schema = schema.min(node.minLength)
    if (Number.isInteger(node.maxLength)) schema = schema.max(node.maxLength)
  }
  if (node.type === 'number' || node.type === 'integer') {
    if (typeof node.minimum === 'number') schema = schema.min(node.minimum)
    if (typeof node.maximum === 'number') schema = schema.max(node.maximum)
  }
  return describe(schema, node)
}

/**
 * The ZodRawShape the MCP SDK's registerTool wants: one entry per property,
 * optional unless the schema says otherwise.
 */
export function jsonSchemaToZodShape(node, depth = 0) {
  const properties = node?.properties
  if (properties === null || typeof properties !== 'object') return {}
  const required = requiredNames(node)
  const shape = {}
  for (const [key, value] of Object.entries(properties)) {
    const field = jsonSchemaToZod(value, depth)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return shape
}
