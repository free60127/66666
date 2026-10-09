/** Redis applies small journal appends atomically; the original JSON is kept verbatim.
 * Keeping the base as a string also avoids Lua cjson turning empty JSON arrays into objects.
 */
import { materializeDocument } from '../src/syncDelta.js';

export const DELTA_READ_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({kind='full', raw=''}) end
local doc = cjson.decode(raw)
local since = tonumber(ARGV[1])
if since == (doc.version or 0) then
  return cjson.encode({kind='changes', version=doc.version or 0, updatedAt=doc.updatedAt or 0})
end
if doc.deltaFormat == 1 and since >= doc.baseVersion and since < doc.version then
  local frames = {}
  for _, frame in ipairs(doc.frames) do
    if frame.version > since then table.insert(frames, frame) end
  end
  return cjson.encode({kind='changes', version=doc.version, updatedAt=doc.updatedAt, frames=frames})
end
return cjson.encode({kind='full', raw=raw})
`;

export const DELTA_WRITE_LUA = `
local raw = redis.call('GET', KEYS[1])
local doc = raw and cjson.decode(raw) or {version=0}
local base = tonumber(ARGV[1])
if doc.deleted then return cjson.encode({ok=false, deleted=true}) end
if (doc.version or 0) ~= base then return cjson.encode({ok=false, version=doc.version or 0}) end
if doc.deltaFormat ~= 1 then
  doc = {deltaFormat=1, baseRaw=raw or ARGV[5], baseVersion=base, version=base, frames={}}
end
if #doc.frames >= 64 or string.len(cjson.encode(doc.frames)) > 131072 then
  return cjson.encode({ok=false, compact=true, version=base})
end
doc.version = base + 1
doc.updatedAt = tonumber(ARGV[3])
doc.device = ARGV[4]
table.insert(doc.frames, {version=doc.version, opsRaw=ARGV[2]})
redis.call('SET', KEYS[1], cjson.encode(doc))
return cjson.encode({ok=true, compact=(#doc.frames >= 32 or string.len(cjson.encode(doc.frames)) > 65536)})
`;

export function changesFromDocument(doc, since) {
  const version = doc?.version || 0;
  if (since === version) return { kind: 'changes', version, updatedAt: doc?.updatedAt || 0, frames: [] };
  if (doc?.deltaFormat === 1 && since >= doc.baseVersion && since < version) {
    return { kind: 'changes', version, updatedAt: doc.updatedAt, frames: doc.frames.filter((f) => f.version > since) };
  }
  return { kind: 'full', doc: materializeDocument(doc) };
}

export async function readRedisChanges(call, key, since) {
  const result = JSON.parse(await call(['EVAL', DELTA_READ_LUA, '1', key, String(since)]));
  return result.kind === 'full' ? { kind: 'full', doc: materializeDocument(result.raw ? JSON.parse(result.raw) : null) }
    : { ...result, frames: result.frames || [] };
}

export async function writeRedisChanges(call, key, baseVersion, ops, meta, emptyDoc) {
  return JSON.parse(await call(['EVAL', DELTA_WRITE_LUA, '1', key, String(baseVersion), JSON.stringify(ops),
    String(meta.updatedAt), meta.device, JSON.stringify(emptyDoc)]));
}
