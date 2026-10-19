const { prefixAliases } = require("./branding-compat.json");

// Resolve aliases on every access, so late env changes and isolated tests work.
// A new spelling always wins, even when its value is the empty string.
function compatEnvironment(environment) {
  if (!environment) return environment;
  return new Proxy(environment, {
    deleteProperty(target, key) {
      let ok = Reflect.deleteProperty(target, key);
      if (typeof key === "string") {
        for (const [current, legacy] of prefixAliases) {
          const prefix = key.startsWith(current) ? current : key.startsWith(legacy) ? legacy : null;
          if (!prefix) continue;
          const suffix = key.slice(prefix.length);
          for (const prefix of new Set(prefixAliases.flat())) ok = Reflect.deleteProperty(target, prefix + suffix) && ok;
        }
      }
      return ok;
    },
    // Only real keys. Copying the environment ({ ...compatEnv }) used to
    // materialise BOS_X beside every OMB_X, so a child spawned with
    // { ...compatEnv, OMB_X: next } saw the parent's value under the new
    // spelling and the override lost. The child resolves aliases itself.
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      const existing = Reflect.getOwnPropertyDescriptor(target, key);
      if (existing) return existing;
      if (typeof key === "string" && prefixAliases.some(([prefix]) => key.startsWith(prefix))) {
        return { configurable: true, enumerable: true, writable: true, value: this.get(target, key) };
      }
      return undefined;
    },
    set(target, key, value) { target[key] = value; return true; },
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      for (const [canonical, legacyPrefix] of prefixAliases) {
        const prefix = key.startsWith(canonical) ? canonical : key.startsWith(legacyPrefix) ? legacyPrefix : null;
        if (!prefix) continue;
        const suffix = key.slice(prefix.length);
        const preferred = ["BOSBOT_" + suffix, "BOS_" + suffix];
        const legacy = prefixAliases.map(([, prefix]) => prefix + suffix);
        for (const candidate of [...preferred, ...legacy]) {
          const value = Reflect.get(target, candidate);
          if (value !== undefined) return value;
        }
      }
      return Reflect.get(target, key);
    },
  });
}
function expandEnvNames(names) {
  const result = new Set(names);
  for (const name of names) {
    for (const [current, legacy] of prefixAliases) {
      const prefix = name.startsWith(current) ? current : name.startsWith(legacy) ? legacy : null;
      if (!prefix) continue;
      const suffix = name.slice(prefix.length);
      for (const candidate of new Set(prefixAliases.flat())) result.add(candidate + suffix);
    }
  }
  return Array.from(result);
}
function isBrandEnvName(name) {
  return prefixAliases.some(([current, legacy]) => name.startsWith(current) || name.startsWith(legacy));
}
module.exports = { compatEnvironment, expandEnvNames, isBrandEnvName, compatEnv: compatEnvironment(process.env) };
