// Execute the actual production Lua scripts rather than reimplementing their
// decisions in JavaScript. Redis commands/TTL are an in-memory test adapter;
// this does not replace an integration test against a real Redis service.
import fengari from 'fengari';
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const nullValue = {};

function push(L, value) {
  if (value === null) return lua.lua_pushlightuserdata(L, nullValue);
  if (value === undefined) return lua.lua_pushnil(L);
  if (typeof value === 'string') return lua.lua_pushstring(L, to_luastring(value));
  if (typeof value === 'number') return lua.lua_pushnumber(L, value);
  if (typeof value === 'boolean') return lua.lua_pushboolean(L, value);
  lua.lua_newtable(L);
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(value)) lua.lua_pushinteger(L, Number(key) + 1);
    else lua.lua_pushstring(L, to_luastring(key));
    push(L, item);
    lua.lua_settable(L, -3);
  }
}

function read(L, index) {
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNIL || type === lua.LUA_TLIGHTUSERDATA) return null;
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index);
  if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
  if (type !== lua.LUA_TTABLE) throw new Error(`Unsupported Lua type ${type}`);
  const absolute = lua.lua_absindex(L, index);
  const object = {};
  lua.lua_pushnil(L);
  while (lua.lua_next(L, absolute)) {
    object[read(L, -2)] = read(L, -1);
    lua.lua_pop(L, 1);
  }
  const keys = Object.keys(object);
  if (keys.length && keys.every((key, i) => String(i + 1) === key)) return keys.map((key) => object[key]);
  return object;
}

function executeLua(script, keys, args, command) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const register = (name, methods) => {
    lua.lua_newtable(L);
    for (const [method, callback] of Object.entries(methods)) {
      lua.lua_pushjsfunction(L, (state) => {
        try {
          const parameters = Array.from({ length: lua.lua_gettop(state) }, (_, i) => read(state, i + 1));
          push(state, callback(...parameters));
          return 1;
        } catch (error) { return lauxlib.luaL_error(state, to_luastring(error.message)); }
      });
      lua.lua_setfield(L, -2, to_luastring(method));
    }
    if (name === 'cjson') {
      push(L, null);
      lua.lua_setfield(L, -2, to_luastring('null'));
    }
    lua.lua_setglobal(L, to_luastring(name));
  };
  register('redis', { call: (...parts) => command(parts) ?? false });
  register('cjson', { encode: JSON.stringify, decode: JSON.parse });
  push(L, keys); lua.lua_setglobal(L, to_luastring('KEYS'));
  push(L, args.map(String)); lua.lua_setglobal(L, to_luastring('ARGV'));
  const status = lauxlib.luaL_dostring(L, to_luastring(script));
  if (status !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  const result = read(L, -1);
  return result === false ? null : result;
}

export function redisLuaMock() {
  const strings = new Map();
  const sets = new Map();
  const sorted = new Map();
  const expiry = new Map();
  const commands = [];
  const range = (key, start, stop, reverse = false) => {
    const list = [...(sorted.get(key) || new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    if (reverse) list.reverse();
    return list.slice(Number(start), Number(stop) < 0 ? list.length + Number(stop) + 1 : Number(stop) + 1);
  };
  function command(parts) {
    commands.push(parts);
    const [name, ...args] = parts;
    for (const [key, time] of expiry) if (time <= Date.now()) { strings.delete(key); expiry.delete(key); }
    const key = String(args[0]);
    switch (String(name).toUpperCase()) {
      case 'SET': {
        if (args.includes('NX') && strings.has(key)) return null;
        strings.set(key, String(args[1]));
        if (!args.includes('KEEPTTL')) expiry.delete(key);
        if (args.includes('EX')) expiry.set(key, Date.now() + Number(args[args.indexOf('EX') + 1]) * 1000);
        return 'OK';
      }
      case 'GET': return strings.get(key) ?? null;
      case 'GETDEL': { const value = strings.get(key) ?? null; strings.delete(key); return value; }
      case 'EXISTS': return strings.has(key) ? 1 : 0;
      case 'INCR': { const count = Number(strings.get(key) || 0) + 1; strings.set(key, String(count)); return count; }
      case 'EXPIRE': expiry.set(key, Date.now() + Number(args[1]) * 1000); return 1;
      case 'PTTL': return strings.has(key) ? (expiry.has(key) ? Math.max(0,expiry.get(key)-Date.now()) : -1) : -2;
      case 'DEL': return args.reduce((n, k) => n + Number(strings.delete(k)) + Number(sorted.delete(k)), 0);
      case 'SADD': {
        const set = sets.get(key) || new Set(); const before = set.size;
        args.slice(1).forEach((value) => set.add(String(value))); sets.set(key, set);
        return set.size - before;
      }
      case 'ZADD': { const values = sorted.get(key) || new Map(); values.set(String(args[2]), Number(args[1])); sorted.set(key, values); return 1; }
      case 'ZRANGE': return range(key, args[1], args[2]);
      case 'ZREVRANGE': return range(key, args[1], args[2], true);
      case 'ZREM': return args.slice(1).reduce((n, id) => n + Number(sorted.get(key)?.delete(id) || false), 0);
      case 'MGET': return args.map((key) => strings.get(key) ?? null);
      case 'EVAL': return executeLua(args[0], args.slice(2, 2 + Number(args[1])), args.slice(2 + Number(args[1])), command);
      default: throw new Error(`Unsupported command ${name}`);
    }
  }
  return {
    strings, sets, sorted, expiry, commands, command,
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      const result = url.endsWith('/multi-exec') ? input.map((parts) => ({ result: command(parts) })) : { result: command(input) };
      return { ok: true, json: async () => result };
    }
  };
}
